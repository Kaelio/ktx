import type { KtxSqlQueryExecutorPort } from '../../context/connections/query-executor.js';
import { KtxExpectedError, KtxQueryError, isNativeProgrammingFault } from '../../errors.js';
import { isDatabaseDriver, normalizeConnectionDriver } from '../../connection-drivers.js';
import { sqlDialectNotes } from '../../context/sql-analysis/dialect-notes.js';
import type { KtxProjectConnectionConfig } from '../../context/project/config.js';
import { executeProjectReadOnlySql } from '../../context/connections/project-sql-executor.js';
import { FEDERATED_CONNECTION_ID, federatedConnectionListing } from '../../context/connections/federation.js';
import { assertSqlQueryableConnection } from '../../context/connections/dialects.js';
import { resolveConfiguredConnection } from '../../context/connections/resolve-connection.js';
import {
  type LocalConnectionInfo,
  localConnectionInfoFromConfig,
} from '../../context/connections/local-warehouse-descriptor.js';
import type { KtxEmbeddingPort } from '../../context/core/embedding.js';
import type { KtxSemanticLayerComputePort } from '../../context/daemon/semantic-layer-compute.js';
import type { KtxLocalProject } from '../../context/project/project.js';
import { createKtxEntityDetailsService } from '../../context/scan/entity-details.js';
import type { LocalScanMcpOptions } from '../../context/scan/local-scan.js';
import { createKtxDiscoverDataService } from '../../context/search/discover.js';
import { sqlAnalysisDialectForDriver } from '../../context/sql-analysis/dialect.js';
import type { SqlAnalysisPort } from '../../context/sql-analysis/ports.js';
import { compileLocalSlQuery } from '../../context/sl/local-query.js';
import { createKtxDictionarySearchService } from '../../context/sl/dictionary-search.js';
import { readLocalSlSource } from '../../context/sl/local-sl.js';
import { assertSafeConnectionId } from '../../context/sl/source-files.js';
import { assertConfiguredConnectionId } from '../../context/connections/configured-connections.js';
import { readLocalKnowledgePage, searchLocalKnowledgePages } from '../wiki/local-knowledge.js';
import type { KtxMcpContextPorts, KtxMcpProgressCallback, KtxSqlExecutionResponse } from './types.js';

interface CreateLocalProjectMcpContextPortsOptions {
  semanticLayerCompute?: KtxSemanticLayerComputePort;
  queryExecutor?: KtxSqlQueryExecutorPort;
  sqlAnalysis?: SqlAnalysisPort;
  localScan?: LocalScanMcpOptions;
  embeddingService: KtxEmbeddingPort | null;
}

async function executeValidatedReadOnlySql(
  project: KtxLocalProject,
  options: CreateLocalProjectMcpContextPortsOptions,
  input: { connectionId: string; sql: string; maxRows: number },
  onProgress?: KtxMcpProgressCallback,
): Promise<KtxSqlExecutionResponse> {
  await onProgress?.({ progress: 0, message: 'Validating SQL' });
  if (!options.sqlAnalysis) {
    throw new Error('sql_execution requires parser-backed SQL validation.');
  }
  const createConnector = options.localScan?.createConnector;
  if (!createConnector) {
    throw new Error('sql_execution requires a local scan connector factory.');
  }

  const isFederated = input.connectionId === FEDERATED_CONNECTION_ID;
  const connectionId = isFederated ? input.connectionId : assertSafeConnectionId(input.connectionId);
  const connection = isFederated ? undefined : resolveConfiguredConnection(project.config, connectionId);
  if (!isFederated) {
    assertSqlQueryableConnection(connectionId, connection!.driver);
  }

  const dialect = sqlAnalysisDialectForDriver(isFederated ? 'duckdb' : connection!.driver);
  const validation = await options.sqlAnalysis.validateReadOnly(input.sql, dialect);
  if (!validation.ok) {
    // A read-only guard rejecting the agent's SQL is an expected outcome, not a
    // ktx fault: classify it so reportException keeps it out of Error Tracking.
    throw new KtxQueryError(validation.error ?? 'SQL is not read-only.');
  }

  await onProgress?.({ progress: 0.3, message: 'Executing' });
  const result = await executeProjectReadOnlySql({
    project,
    input: {
      connectionId,
      projectDir: project.projectDir,
      connection,
      sql: input.sql,
      maxRows: input.maxRows,
    },
    createConnector,
    runId: 'mcp-sql-execution',
  }).catch((error: unknown) => {
    // A warehouse/driver rejection (e.g. the agent's SQL failed to compile) is a
    // surfaced operational outcome, not a ktx fault: mark it expected while
    // preserving the warehouse's own diagnostics. A native JS error (TypeError,
    // etc.) signals a bug in connector code — let it propagate unchanged so Error
    // Tracking still sees it.
    if (isNativeProgrammingFault(error) || error instanceof KtxExpectedError) {
      throw error;
    }
    throw new KtxQueryError(error instanceof Error ? error.message : String(error), { cause: error });
  });
  const response = {
    headers: result.headers,
    ...(result.headerTypes ? { headerTypes: result.headerTypes } : {}),
    rows: result.rows,
    rowCount: result.rowCount ?? result.rows.length,
  };
  await onProgress?.({ progress: 1, message: `Fetched ${response.rowCount} rows` });
  return response;
}

/** @internal Resolves a connection's dialect SQL notes; throws KtxExpectedError for an unknown or non-SQL-warehouse connection. */
export function resolveDialectNotesForConnection(
  connectionId: string,
  connection: KtxProjectConnectionConfig | undefined,
): { connectionId: string; dialect: string; notes: string } {
  if (!connection) {
    throw new KtxExpectedError(`Connection "${connectionId}" is not configured in ktx.yaml`);
  }
  const driver = normalizeConnectionDriver(connection);
  if (!isDatabaseDriver(driver)) {
    throw new KtxExpectedError(
      `Connection "${connectionId}" uses the "${driver}" context source, not a SQL warehouse; sql_dialect_notes applies only to SQL database connections.`,
    );
  }
  const dialect = sqlAnalysisDialectForDriver(driver);
  return { connectionId, dialect, notes: sqlDialectNotes(dialect) };
}

export function createLocalProjectMcpContextPorts(
  project: KtxLocalProject,
  options: CreateLocalProjectMcpContextPortsOptions,
): KtxMcpContextPorts {
  const embeddingService = options.embeddingService;
  const ports: KtxMcpContextPorts = {
    connections: {
      async list() {
        const configured = Object.entries(project.config.connections)
          .map(([id, config]) => localConnectionInfoFromConfig(id, config))
          .filter((connection): connection is LocalConnectionInfo => connection !== null)
          .sort((a, b) => a.id.localeCompare(b.id));
        const federated = federatedConnectionListing(project.config.connections, project.projectDir);
        if (federated) {
          configured.push({
            id: federated.id,
            name: federated.id,
            connectionType: 'DUCKDB',
            members: federated.members,
            hint: federated.hint,
          });
        }
        return configured;
      },
    },
    knowledge: {
      async search(input) {
        const connectionId =
          input.connectionId === undefined
            ? undefined
            : assertConfiguredConnectionId(project.config.connections, input.connectionId);
        const results = await searchLocalKnowledgePages(project, {
          query: input.query,
          userId: input.userId,
          limit: input.limit,
          embeddingService,
          ...(connectionId !== undefined ? { connectionId } : {}),
        });
        return {
          results: results.slice(0, input.limit).map((result) => ({
            key: result.key,
            path: result.path,
            scope: result.scope,
            summary: result.summary,
            score: result.score,
            matchReasons: result.matchReasons,
            lanes: result.lanes,
          })),
          totalFound: results.length,
        };
      },
      async read(input) {
        const page = await readLocalKnowledgePage(project, {
          key: input.key,
          userId: input.userId,
        });
        return page
          ? {
              key: page.key,
              scope: page.scope,
              summary: page.summary,
              content: page.content,
              tags: page.tags,
              refs: page.refs,
              slRefs: page.slRefs,
            }
          : null;
      },
    },
    semanticLayer: {
      async readSource(input) {
        const source = await readLocalSlSource(project, {
          connectionId: input.connectionId,
          sourceName: input.sourceName,
        });
        return source ? { sourceName: source.name, yaml: source.yaml } : null;
      },
      async query(input, executionOptions) {
        if (!options.semanticLayerCompute) {
          throw new Error('sl_query requires a semantic-layer query adapter.');
        }
        return compileLocalSlQuery(project, {
          connectionId: input.connectionId,
          query: input.query,
          compute: options.semanticLayerCompute,
          execute: Boolean(options.queryExecutor),
          maxRows: input.query.limit,
          queryExecutor: options.queryExecutor,
          onProgress: executionOptions?.onProgress,
        });
      },
    },
    entityDetails: {
      async read(input) {
        return createKtxEntityDetailsService(project).read(input);
      },
    },
    dictionarySearch: {
      async search(input) {
        return createKtxDictionarySearchService(project).search(input);
      },
    },
    discover: {
      async search(input) {
        return createKtxDiscoverDataService(project, { userId: 'local', embeddingService }).search(input);
      },
    },
    dialectNotes: {
      async read(input) {
        const connectionId = assertSafeConnectionId(input.connectionId);
        return resolveDialectNotesForConnection(connectionId, project.config.connections[connectionId]);
      },
    },
  };

  if (options.sqlAnalysis && options.localScan?.createConnector) {
    ports.sqlExecution = {
      async execute(input, executionOptions) {
        return executeValidatedReadOnlySql(project, options, input, executionOptions?.onProgress);
      },
    };
  }

  return ports;
}
