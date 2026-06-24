import { executeFederatedQuery } from '../../connectors/duckdb/federated-executor.js';
import type { KtxLocalProject } from '../project/project.js';
import type { KtxScanConnector, KtxScanContext } from '../scan/types.js';
import { deriveFederatedConnection, FEDERATED_CONNECTION_ID } from './federation.js';
import type { KtxSqlQueryExecutionInput, KtxSqlQueryExecutionResult } from './query-executor.js';

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
