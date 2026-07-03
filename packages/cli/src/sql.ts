import { executeFederatedQuery } from './connectors/duckdb/federated-executor.js';
import { FEDERATED_CONNECTION_ID } from './context/connections/federation.js';
import { executeProjectRawSql } from './context/connections/project-sql-executor.js';
import type { KtxSqlQueryExecutionResult } from './context/connections/query-executor.js';
import { assertSqlQueryableConnection } from './context/connections/dialects.js';
import { resolveConfiguredConnection } from './context/connections/resolve-connection.js';
import { loadKtxProject, type KtxLocalProject } from './context/project/project.js';
import { sqlAnalysisDialectForDriver } from './context/sql-analysis/dialect.js';
import type { SqlAnalysisDialect, SqlAnalysisPort } from './context/sql-analysis/ports.js';
import type { KtxCliIo } from './cli-runtime.js';
import { type KtxOutputMode, resolveOutputMode } from './io/mode.js';
import { createKtxCliScanConnector } from './local-scan-connectors.js';
import { createManagedDaemonSqlAnalysisPort } from './managed-python-http.js';
import { profileMark } from './startup-profile.js';
import { isDemoConnection } from './telemetry/demo-detect.js';
import { emitTelemetryEvent, reportException } from './telemetry/index.js';
import { collectTelemetryRedactionSecrets } from './telemetry/redaction-secrets.js';
import { scrubErrorClass } from './telemetry/scrubber.js';

profileMark('module:sql');

type KtxSqlOutputMode = KtxOutputMode;

export type KtxSqlArgs = {
  command: 'execute';
  projectDir: string;
  connectionId: string;
  sql: string;
  maxRows: number;
  output?: KtxSqlOutputMode;
  json?: boolean;
  cliVersion: string;
};

export interface KtxSqlDeps {
  loadProject?: typeof loadKtxProject;
  createSqlAnalysis?: () => SqlAnalysisPort;
  createScanConnector?: typeof createKtxCliScanConnector;
  executeFederated?: typeof executeFederatedQuery;
}

interface SqlExecutionOutput {
  connectionId: string;
  headers: string[];
  headerTypes?: string[];
  rows: unknown[][];
  rowCount: number;
}

function queryVerb(sql: string): 'select' | 'explain' | 'show' | 'with' | 'other' {
  const first = sql.trim().split(/\s+/, 1)[0]?.toLowerCase();
  if (first === 'select' || first === 'explain' || first === 'show' || first === 'with') {
    return first;
  }
  return 'other';
}

async function safeReferencedTableCount(
  port: SqlAnalysisPort,
  sql: string,
  dialect: SqlAnalysisDialect,
): Promise<number> {
  try {
    const results = await port.analyzeBatch([{ id: 'cli-sql', sql }], dialect);
    return results.get('cli-sql')?.tablesTouched.length ?? 0;
  } catch {
    return 0;
  }
}

function formatValue(value: unknown): string {
  if (value === null || value === undefined) return '';
  if (typeof value === 'string') return value;
  if (typeof value === 'number' || typeof value === 'boolean' || typeof value === 'bigint') return String(value);
  return JSON.stringify(value);
}

function printJson(output: SqlExecutionOutput, io: KtxCliIo): void {
  io.stdout.write(`${JSON.stringify(output, null, 2)}\n`);
}

function printPlain(output: SqlExecutionOutput, io: KtxCliIo): void {
  io.stdout.write(`${output.headers.join('\t')}\n`);
  for (const row of output.rows) {
    io.stdout.write(`${row.map(formatValue).join('\t')}\n`);
  }
}

function printPretty(output: SqlExecutionOutput, io: KtxCliIo): void {
  const rows = output.rows.map((row) => row.map(formatValue));
  const widths = output.headers.map((header, index) =>
    Math.max(header.length, ...rows.map((row) => row[index]?.length ?? 0)),
  );
  const renderRow = (cells: string[]): string =>
    cells.map((cell, index) => cell.padEnd(widths[index] ?? cell.length)).join('  ').trimEnd();

  if (output.headers.length > 0) {
    io.stdout.write(`${renderRow(output.headers)}\n`);
    io.stdout.write(`${renderRow(widths.map((width) => '-'.repeat(width)))}\n`);
  }
  for (const row of rows) {
    io.stdout.write(`${renderRow(row)}\n`);
  }
  io.stdout.write(`\n${output.rowCount} ${output.rowCount === 1 ? 'row' : 'rows'}\n`);
}

function printSqlResult(output: SqlExecutionOutput, mode: KtxSqlOutputMode, io: KtxCliIo): void {
  if (mode === 'json') {
    printJson(output, io);
    return;
  }
  if (mode === 'plain') {
    printPlain(output, io);
    return;
  }
  printPretty(output, io);
}

function resultOutput(connectionId: string, result: KtxSqlQueryExecutionResult): SqlExecutionOutput {
  return {
    connectionId,
    headers: result.headers,
    ...(result.headerTypes ? { headerTypes: result.headerTypes } : {}),
    rows: result.rows,
    rowCount: result.rowCount ?? result.rows.length,
  };
}

export async function runKtxSql(args: KtxSqlArgs, io: KtxCliIo = process, deps: KtxSqlDeps = {}): Promise<number> {
  const startedAt = performance.now();
  let driver = 'unknown';
  let demoConnection = false;
  let project: KtxLocalProject | undefined;
  try {
    project = await (deps.loadProject ?? loadKtxProject)({ projectDir: args.projectDir });
    const isFederated = args.connectionId === FEDERATED_CONNECTION_ID;
    const connection = isFederated ? undefined : resolveConfiguredConnection(project.config, args.connectionId);
    driver = isFederated ? 'duckdb' : String(connection?.driver ?? 'unknown').toLowerCase();
    demoConnection = isFederated ? false : isDemoConnection(args.connectionId, connection);
    // Fail fast before creating the SQL-analysis daemon port; executeProjectRawSql
    // re-asserts this for every caller.
    if (!isFederated) {
      assertSqlQueryableConnection(args.connectionId, connection?.driver);
    }

    const createSqlAnalysis =
      deps.createSqlAnalysis ??
      (() =>
        createManagedDaemonSqlAnalysisPort({
          cliVersion: args.cliVersion,
          projectDir: args.projectDir,
          installPolicy: 'auto',
          io,
        }));
    const analysisPort = createSqlAnalysis();
    const dialect: SqlAnalysisDialect = isFederated ? 'duckdb' : sqlAnalysisDialectForDriver(connection?.driver);

    const createScanConnector = deps.createScanConnector ?? createKtxCliScanConnector;
    const result = await executeProjectRawSql({
      project,
      connectionId: args.connectionId,
      sql: args.sql,
      maxRows: args.maxRows,
      sqlAnalysis: analysisPort,
      createConnector: (connectionId) => createScanConnector(project!, connectionId),
      executeFederated: deps.executeFederated,
      runId: 'cli-sql',
    });
    const referencedTableCount = await safeReferencedTableCount(analysisPort, args.sql, dialect);
    const mode = resolveOutputMode({ explicit: args.output, json: args.json, io });
    printSqlResult(resultOutput(args.connectionId, result), mode, io);
    await emitTelemetryEvent({
      name: 'sql_completed',
      projectDir: args.projectDir,
      io,
      fields: {
        driver,
        isDemoConnection: demoConnection,
        queryVerb: queryVerb(args.sql),
        referencedTableCount,
        durationMs: Math.max(0, performance.now() - startedAt),
        outcome: 'ok',
      },
    });
    return 0;
  } catch (error) {
    const errorClass = scrubErrorClass(error);
    await emitTelemetryEvent({
      name: 'sql_completed',
      projectDir: args.projectDir,
      io,
      fields: {
        driver,
        isDemoConnection: demoConnection,
        queryVerb: queryVerb(args.sql),
        referencedTableCount: 0,
        durationMs: Math.max(0, performance.now() - startedAt),
        outcome: 'error',
        ...(errorClass ? { errorClass } : {}),
      },
    });
    await reportException({
      error,
      context: { source: 'sql run', handled: true, fatal: false },
      projectDir: args.projectDir,
      io,
      redactionSecrets: await collectTelemetryRedactionSecrets({
        project,
        projectDir: args.projectDir,
        connectionId: args.connectionId,
        includeLlm: false,
        includeEmbeddings: false,
        env: process.env,
      }),
    });
    io.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`);
    return 1;
  }
}
