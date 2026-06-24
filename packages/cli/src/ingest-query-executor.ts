import { executeFederatedQuery } from './connectors/duckdb/federated-executor.js';
import type { KtxSqlQueryExecutionInput, KtxSqlQueryExecutorPort } from './context/connections/query-executor.js';
import { executeProjectReadOnlySql } from './context/connections/project-sql-executor.js';
import type { KtxLocalProject } from './context/project/project.js';
import { createKtxCliScanConnector } from './local-scan-connectors.js';

type CreateConnector = typeof createKtxCliScanConnector;

export interface KtxCliIngestQueryExecutorDeps {
  createConnector?: CreateConnector;
  executeFederated?: typeof executeFederatedQuery;
}

export function createKtxCliIngestQueryExecutor(
  project: KtxLocalProject,
  deps: KtxCliIngestQueryExecutorDeps = {},
): KtxSqlQueryExecutorPort {
  const createConnector = deps.createConnector ?? createKtxCliScanConnector;
  return {
    async execute(input: KtxSqlQueryExecutionInput) {
      return executeProjectReadOnlySql({
        project,
        input,
        createConnector: (connectionId) => createConnector(project, connectionId),
        executeFederated: deps.executeFederated,
        runId: 'ingest-sql-execution',
      });
    },
  };
}
