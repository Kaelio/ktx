import { executeFederatedQuery } from '../../connectors/duckdb/federated-executor.js';
import { KtxExpectedError, KtxQueryError, isNativeProgrammingFault } from '../../errors.js';
import { sqlAnalysisDialectForDriver } from '../sql-analysis/dialect.js';
import type { SqlAnalysisPort } from '../sql-analysis/ports.js';
import { assertSafeConnectionId } from '../sl/source-files.js';
import type { KtxLocalProject } from '../project/project.js';
import type { KtxScanConnector, KtxScanContext } from '../scan/types.js';
import { assertSqlQueryableConnection } from './dialects.js';
import { deriveFederatedConnection, FEDERATED_CONNECTION_ID } from './federation.js';
import { assertRawSqlAllowed } from './query-policy.js';
import type { KtxSqlQueryExecutionInput, KtxSqlQueryExecutionResult } from './query-executor.js';
import { resolveConfiguredConnection } from './resolve-connection.js';

export interface ExecuteProjectReadOnlySqlDeps {
  project: KtxLocalProject;
  input: KtxSqlQueryExecutionInput;
  createConnector: (connectionId: string) => Promise<KtxScanConnector> | KtxScanConnector;
  executeFederated?: typeof executeFederatedQuery;
  runId?: string;
}

/**
 * Single resolve-and-execute path for project read-only SQL. The federated
 * connection is derived from declared state here so every executor entry point
 * routes `_ktx_federated` identically; standard connections go through the
 * scan connector.
 */
export async function executeProjectReadOnlySql(
  deps: ExecuteProjectReadOnlySqlDeps,
): Promise<KtxSqlQueryExecutionResult> {
  const { project, input } = deps;
  if (input.connectionId === FEDERATED_CONNECTION_ID) {
    const descriptor = deriveFederatedConnection(project.config.connections, project.projectDir);
    if (!descriptor) {
      throw new Error('Federated execution requested but fewer than 2 attach-compatible connections exist.');
    }
    const runFederated = deps.executeFederated ?? executeFederatedQuery;
    return runFederated(descriptor.members, input);
  }

  let connector: KtxScanConnector | null = null;
  try {
    connector = await deps.createConnector(input.connectionId);
    if (!connector.capabilities.readOnlySql || !connector.executeReadOnly) {
      throw new Error(
        `Connection "${input.connectionId}" driver "${connector.driver}" does not support read-only SQL execution.`,
      );
    }
    const ctx: KtxScanContext = { runId: deps.runId ?? 'sql-execution' };
    const result = await connector.executeReadOnly(
      { connectionId: input.connectionId, sql: input.sql, maxRows: input.maxRows },
      ctx,
    );
    return {
      headers: result.headers,
      ...(result.headerTypes ? { headerTypes: result.headerTypes } : {}),
      rows: result.rows,
      totalRows: result.totalRows,
      command: 'SELECT',
      rowCount: result.rowCount,
    };
  } finally {
    await connector?.cleanup?.();
  }
}

type RawSqlProgressCallback = (event: { progress: number; message: string }) => void | Promise<void>;

export interface ExecuteProjectRawSqlDeps {
  project: KtxLocalProject;
  connectionId: string;
  sql: string;
  maxRows: number;
  sqlAnalysis: SqlAnalysisPort;
  createConnector: (connectionId: string) => Promise<KtxScanConnector> | KtxScanConnector;
  executeFederated?: typeof executeFederatedQuery;
  runId: string;
  onProgress?: RawSqlProgressCallback;
}

/**
 * Single guarded path for user-authored (raw) SQL — `ktx sql` and the MCP
 * sql_execution tool. Enforces the connection's query_policy and the parser
 * read-only guard before executing; ktx-internal SQL (semantic-layer, ingest)
 * calls executeProjectReadOnlySql directly and is not subject to query_policy.
 */
export async function executeProjectRawSql(deps: ExecuteProjectRawSqlDeps): Promise<KtxSqlQueryExecutionResult> {
  const { project } = deps;
  await deps.onProgress?.({ progress: 0, message: 'Validating SQL' });

  const isFederated = deps.connectionId === FEDERATED_CONNECTION_ID;
  const connectionId = isFederated ? deps.connectionId : assertSafeConnectionId(deps.connectionId);
  const connection = isFederated ? undefined : resolveConfiguredConnection(project.config, connectionId);
  if (!isFederated) {
    assertSqlQueryableConnection(connectionId, connection!.driver);
  }
  assertRawSqlAllowed(project.config, project.projectDir, connectionId);

  const dialect = sqlAnalysisDialectForDriver(isFederated ? 'duckdb' : connection!.driver);
  const validation = await deps.sqlAnalysis.validateReadOnly(deps.sql, dialect);
  if (!validation.ok) {
    // A read-only guard rejecting the caller's SQL is an expected outcome, not a
    // ktx fault: classify it so reportException keeps it out of Error Tracking.
    throw new KtxQueryError(validation.error ?? 'SQL is not read-only.');
  }

  await deps.onProgress?.({ progress: 0.3, message: 'Executing' });
  const result = await executeProjectReadOnlySql({
    project,
    input: {
      connectionId,
      projectDir: project.projectDir,
      connection,
      sql: deps.sql,
      maxRows: deps.maxRows,
    },
    createConnector: deps.createConnector,
    executeFederated: deps.executeFederated,
    runId: deps.runId,
  }).catch((error: unknown) => {
    // A warehouse/driver rejection (e.g. the caller's SQL failed to compile) is a
    // surfaced operational outcome, not a ktx fault: mark it expected while
    // preserving the warehouse's own diagnostics. A native JS error (TypeError,
    // etc.) signals a bug in connector code — let it propagate unchanged so Error
    // Tracking still sees it.
    if (isNativeProgrammingFault(error) || error instanceof KtxExpectedError) {
      throw error;
    }
    throw new KtxQueryError(error instanceof Error ? error.message : String(error), { cause: error });
  });
  await deps.onProgress?.({ progress: 1, message: `Fetched ${result.rowCount ?? result.rows.length} rows` });
  return result;
}
