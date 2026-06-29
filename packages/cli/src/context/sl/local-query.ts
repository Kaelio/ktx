import type { KtxSqlQueryExecutorPort } from '../../context/connections/query-executor.js';
import type { KtxSemanticLayerComputePort } from '../../context/daemon/semantic-layer-compute.js';
import type { KtxMcpProgressCallback } from '../mcp/types.js';
import type { KtxLocalProject } from '../../context/project/project.js';
import { isSqlQueryableDriver } from '../connections/dialects.js';
import { FEDERATED_CONNECTION_ID } from '../connections/federation.js';
import { resolveRequiredConnectionId } from '../connections/resolve-connection.js';
import { sqlAnalysisDialectForDriver } from '../sql-analysis/dialect.js';
import { loadLocalSlSourceRecords } from './local-sl.js';
import { toResolvedWire } from './semantic-layer.service.js';
import { assertSafeConnectionId } from './source-files.js';
import type { SemanticLayerQueryExecutionResult, SemanticLayerQueryInput, SemanticLayerSource } from './types.js';

const COMPILE_ONLY_REASON =
  'Local semantic-layer query compiled SQL but no data-source execution adapter is configured.';

const FEDERATED_SL_QUERY_UNSUPPORTED =
  `Semantic-layer queries are per-connection and cannot target the federated connection '${FEDERATED_CONNECTION_ID}'. ` +
  `Run a cross-database query as read-only SQL instead — ktx sql -c ${FEDERATED_CONNECTION_ID} "SELECT ..." or the sql_execution tool — ` +
  'using catalog-qualified table names (connectionId.schema.table, or connectionId.table for sqlite; ' +
  'double-quote ids that are not bare identifiers, e.g. "books-db".public.books).';

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

// The planner rejects a source set carrying a join whose `to` names a source
// outside that set, which would break every query for this connection. Keep only
// joins resolvable within the connection's own sources; a cross-database join
// (its `to` qualified by a sibling connection id) is just one such unresolvable
// target and runs as raw SQL instead. Membership is the test, not a connection-id
// prefix match, so a same-connection target whose name collides with a sibling
// connection id is preserved.
function withResolvableJoinsOnly(
  source: SemanticLayerSource,
  knownSourceNames: ReadonlySet<string>,
): SemanticLayerSource {
  if (source.joins.length === 0) {
    return source;
  }
  const joins = source.joins.filter((join) => knownSourceNames.has(join.to));
  return joins.length === source.joins.length ? source : { ...source, joins };
}

async function loadComputableSources(
  project: KtxLocalProject,
  connectionId: string,
): Promise<ReturnType<typeof toResolvedWire>[]> {
  const records = (await loadLocalSlSourceRecords(project, { connectionId })).filter(
    (record) => record.source.table || record.source.sql,
  );
  const knownSourceNames = new Set(records.map((record) => record.source.name));
  return records.map((record) => toResolvedWire(withResolvableJoinsOnly(record.source, knownSourceNames)));
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
  if (options.connectionId === FEDERATED_CONNECTION_ID) {
    throw new Error(FEDERATED_SL_QUERY_UNSUPPORTED);
  }
  await options.onProgress?.({ progress: 0, message: 'Compiling query' });
  const connectionId = resolveLocalConnectionId(project, options.connectionId);
  const driver = project.config.connections[connectionId]?.driver;
  if (!isSqlQueryableDriver(driver)) {
    throw new Error(
      `Semantic-layer queries require a SQL warehouse connection; '${connectionId}' uses the non-SQL driver ` +
        `'${driver ?? 'unknown'}'. MongoDB and other context-only sources are searchable and ingestable, not SL-queryable.`,
    );
  }
  const dialect = sqlAnalysisDialectForDriver(driver);
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
        driver: driver ?? 'unknown',
        maxRows,
        rowCount: execution.rowCount,
      },
    },
  };
}
