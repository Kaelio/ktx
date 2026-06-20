import { z } from 'zod';
import { assertReadOnlySql, limitSqlForExecution } from '../../../../context/connections/read-only-sql.js';
import type { SlConnectionCatalogPort } from '../../../../context/sl/ports.js';
import { sqlAnalysisDialectForDriver } from '../../../../context/sql-analysis/dialect.js';
import type { SqlAnalysisPort } from '../../../../context/sql-analysis/ports.js';
import { BaseTool, type ToolContext, type ToolOutput } from '../../../../context/tools/base-tool.js';

const sqlExecutionInputSchema = z.object({
  connectionId: z.string().regex(/^[a-zA-Z0-9_][a-zA-Z0-9_-]*$/),
  sql: z.string().min(1),
  rowLimit: z.number().int().positive().max(1000).optional().default(100),
}).strict();

type SqlExecutionInput = z.input<typeof sqlExecutionInputSchema>;

export interface SqlExecutionStructured {
  headers: string[];
  rows: unknown[][];
  rowCount: number;
  truncated: boolean;
  sql: string;
  wrappedSql: string;
  error?: string;
}

function markdownTable(headers: string[], rows: unknown[][], totalRows: number): string {
  if (headers.length === 0) {
    return rows.length === 0 ? 'Query returned no rows.' : JSON.stringify(rows.slice(0, 20));
  }
  const visible = rows.slice(0, 20);
  const lines = [
    `| ${headers.join(' | ')} |`,
    `| ${headers.map(() => '---').join(' | ')} |`,
    ...visible.map((row) => `| ${row.map((value) => String(value ?? '')).join(' | ')} |`),
  ];
  if (totalRows > visible.length) {
    lines.push(`... +${totalRows - visible.length} more rows`);
  }
  return lines.join('\n');
}

export class SqlExecutionTool extends BaseTool<typeof sqlExecutionInputSchema> {
  readonly name = 'sql_execution';

  constructor(
    private readonly connections: SlConnectionCatalogPort,
    private readonly sqlAnalysis?: SqlAnalysisPort,
  ) {
    super();
  }

  get description(): string {
    return 'Run a single read-only SELECT or WITH probe against an allowed warehouse connection and return a capped markdown table or the warehouse error.';
  }

  get inputSchema() {
    return sqlExecutionInputSchema;
  }

  async call(input: SqlExecutionInput, context: ToolContext): Promise<ToolOutput<SqlExecutionStructured>> {
    const allowed = context.session?.allowedConnectionNames;
    if (allowed && !allowed.has(input.connectionId)) {
      return {
        markdown: `Connection "${input.connectionId}" is not available to this ingest stage.`,
        structured: {
          headers: [],
          rows: [],
          rowCount: 0,
          truncated: false,
          sql: input.sql,
          wrappedSql: '',
          error: 'connection_not_allowed',
        },
      };
    }

    if (!this.sqlAnalysis) {
      throw new Error('sql_execution requires parser-backed SQL validation.');
    }

    let sql: string;
    let wrappedSql: string;
    try {
      const connection = await this.connections.getConnectionById(input.connectionId);
      if (!connection) {
        throw new Error(`Connection not found: ${input.connectionId}`);
      }
      const validation = await this.sqlAnalysis.validateReadOnly(
        input.sql,
        sqlAnalysisDialectForDriver(connection.connectionType),
      );
      if (!validation.ok) {
        throw new Error(validation.error ?? 'SQL is not read-only.');
      }
      sql = assertReadOnlySql(input.sql);
      wrappedSql = limitSqlForExecution(sql, input.rowLimit);
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      return {
        markdown: message,
        structured: { headers: [], rows: [], rowCount: 0, truncated: false, sql: input.sql, wrappedSql: '', error: message },
      };
    }

    try {
      const result = await this.connections.executeQuery(input.connectionId, wrappedSql);
      const headers = result.headers ?? [];
      const rows = result.rows ?? [];
      const rowCount = result.totalRows ?? rows.length;
      return {
        markdown: markdownTable(headers, rows, rowCount),
        structured: { headers, rows, rowCount, truncated: rowCount > rows.length, sql, wrappedSql },
      };
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      return {
        markdown: `SQL execution failed: ${message}`,
        structured: { headers: [], rows: [], rowCount: 0, truncated: false, sql, wrappedSql, error: message },
      };
    }
  }
}
