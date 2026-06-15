import type { KtxSqlQueryExecutorPort } from '../../context/connections/query-executor.js';
import type { KtxSemanticLayerComputePort } from '../../context/daemon/semantic-layer-compute.js';
import type { KtxMcpProgressCallback } from '../mcp/types.js';
import type { KtxLocalProject } from '../../context/project/project.js';
import { resolveRequiredConnectionId } from '../connections/resolve-connection.js';
import { sqlAnalysisDialectForDriver } from '../sql-analysis/dialect.js';
import { loadLocalSlSourceRecords } from './local-sl.js';
import { toResolvedWire } from './semantic-layer.service.js';
import { assertSafeConnectionId } from './source-files.js';
import type { SemanticLayerQueryExecutionResult, SemanticLayerQueryInput } from './types.js';

const COMPILE_ONLY_REASON =
  'Local semantic-layer query compiled SQL but no data-source execution adapter is configured.';

export interface CompileLocalSlQueryOptions {
  connectionId?: string;
  query: SemanticLayerQueryInput;
  compute: KtxSemanticLayerComputePort;
  execute?: boolean;
  maxRows?: number;
  queryExecutor?: KtxSqlQueryExecutorPort;
  onProgress?: KtxMcpProgressCallback;
}

export interface CompileLocalSlQueryResult extends SemanticLayerQueryExecutionResult {
  connectionId: string;
  dialect: string;
}

function resolveLocalConnectionId(project: KtxLocalProject, requested: string | undefined): string {
  return assertSafeConnectionId(resolveRequiredConnectionId(project.config, requested));
}

async function loadComputableSources(
  project: KtxLocalProject,
  connectionId: string,
): Promise<ReturnType<typeof toResolvedWire>[]> {
  return (await loadLocalSlSourceRecords(project, { connectionId: assertSafeConnectionId(connectionId) }))
    .filter((record) => record.source.table || record.source.sql)
    .map((record) => toResolvedWire(record.source));
}

function headersFromColumns(columns: Array<Record<string, unknown>>): string[] {
  return columns
    .map((column) => column.name)
    .filter((name): name is string => typeof name === 'string' && name.length > 0);
}

export async function compileLocalSlQuery(
  project: KtxLocalProject,
  options: CompileLocalSlQueryOptions,
): Promise<CompileLocalSlQueryResult> {
  await options.onProgress?.({ progress: 0, message: 'Compiling query' });
  const connectionId = resolveLocalConnectionId(project, options.connectionId);
  const dialect = sqlAnalysisDialectForDriver(project.config.connections[connectionId]?.driver);
  const sources = await loadComputableSources(project, connectionId);

  await options.onProgress?.({ progress: 0.3, message: 'Generating SQL' });
  const response = await options.compute.query({
    sources,
    dialect,
    query: options.query,
  });

  if (!options.execute) {
    await options.onProgress?.({ progress: 1, message: 'Fetched 0 rows' });
    return {
      connectionId,
      dialect: response.dialect,
      sql: response.sql,
      headers: headersFromColumns(response.columns),
      rows: [],
      totalRows: 0,
      plan: {
        ...response.plan,
        execution: {
          mode: 'compile_only',
          reason: COMPILE_ONLY_REASON,
        },
      },
    };
  }

  if (!options.queryExecutor) {
    throw new Error('Local semantic-layer execution requires a query executor.');
  }

  const maxRows = options.maxRows ?? options.query.limit;
  await options.onProgress?.({ progress: 0.6, message: 'Executing' });
  const execution = await options.queryExecutor.execute({
    connectionId,
    projectDir: project.projectDir,
    connection: project.config.connections[connectionId],
    sql: response.sql,
    maxRows,
  });
  await options.onProgress?.({ progress: 1, message: `Fetched ${execution.totalRows} rows` });

  return {
    connectionId,
    dialect: response.dialect,
    sql: response.sql,
    headers: execution.headers,
    rows: execution.rows,
    totalRows: execution.totalRows,
    plan: {
      ...response.plan,
      execution: {
        mode: 'executed',
        driver: project.config.connections[connectionId]?.driver ?? 'unknown',
        maxRows,
        rowCount: execution.rowCount,
      },
    },
  };
}
