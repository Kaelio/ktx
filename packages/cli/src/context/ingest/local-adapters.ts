import { join } from 'node:path';
import { gdriveConnectionToPullConfig, parseGdriveConnectionConfig } from '../../context/connections/gdrive-config.js';
import { localConnectionToWarehouseDescriptor } from '../../context/connections/local-warehouse-descriptor.js';
import { notionConnectionToPullConfig, parseNotionConnectionConfig } from '../../context/connections/notion-config.js';
import { resolveKtxConfigReference } from '../core/config-reference.js';
import { ktxLocalStateDbPath } from '../../context/project/local-state-db.js';
import type { KtxLocalProject } from '../../context/project/project.js';
import type { SqlAnalysisPort } from '../../context/sql-analysis/ports.js';
import { DbtSourceAdapter } from './adapters/dbt/dbt.adapter.js';
import { FakeSourceAdapter } from './adapters/fake/fake.adapter.js';
import { GdriveSourceAdapter } from './adapters/gdrive/gdrive.adapter.js';
import { HistoricSqlSourceAdapter } from './adapters/historic-sql/historic-sql.adapter.js';
import { PostgresPgssReader } from './adapters/historic-sql/postgres-pgss-reader.js';
import { resolveQueryHistoryScopeFloor } from './adapters/historic-sql/scope-floor.js';
import {
  HISTORIC_SQL_SOURCE_KEY,
  historicSqlUnifiedPullConfigSchema,
  type HistoricSqlReader,
  type KtxPostgresQueryClient,
} from './adapters/historic-sql/types.js';
import {
  createDaemonLiveDatabaseIntrospection,
  type DaemonLiveDatabaseIntrospectionOptions,
} from './adapters/live-database/daemon-introspection.js';
import { LiveDatabaseSourceAdapter } from './adapters/live-database/live-database.adapter.js';
import { createDaemonLookerTableIdentifierParser } from './adapters/looker/daemon-table-identifier-parser.js';
import type { LookerClientLogger } from './adapters/looker/client.js';
import { DefaultLookerConnectionClientFactory } from './adapters/looker/factory.js';
import { createLocalLookerCredentialResolver } from './adapters/looker/local-looker.adapter.js';
import { LocalLookerRuntimeStore } from './adapters/looker/local-runtime-store.js';
import { LookerSourceAdapter } from './adapters/looker/looker.adapter.js';
import {
  buildLookerPullConfigFromInputs,
  type LookerMappingClient,
  type LookerTableIdentifierParser,
} from './adapters/looker/mapping.js';
import type { LookerRuntimeClient } from './adapters/looker/fetch.js';
import { LookmlSourceAdapter } from './adapters/lookml/lookml.adapter.js';
import { pullConfigFromIntegrationConfig } from './adapters/lookml/pull-config.js';
import { createLocalMetabaseSourceAdapter } from './adapters/metabase/local-metabase.adapter.js';
import type { MetabaseClientLogger } from './adapters/metabase/client.js';
import type { MetabaseFetchLogger } from './adapters/metabase/fetch.js';
import { createLocalSigmaSourceAdapter } from './adapters/sigma/local-sigma.adapter.js';
import type { SigmaFetchLogger } from './adapters/sigma/fetch.js';
import { MetricflowSourceAdapter } from './adapters/metricflow/metricflow.adapter.js';
import { pullConfigFromMetricflowIntegration } from './adapters/metricflow/pull-config.js';
import { LocalNotionRuntimeStore } from './adapters/notion/local-state-store.js';
import { NotionSourceAdapter } from './adapters/notion/notion.adapter.js';
import type { NotionFetchLogger } from './adapters/notion/fetch.js';
import { seedLocalMappingStateFromKtxYaml } from './local-mapping-reconcile.js';
import type { SourceAdapter } from './types.js';

export interface DefaultLocalIngestAdaptersOptions {
  databaseIntrospectionUrl?: string;
  databaseIntrospection?: Omit<DaemonLiveDatabaseIntrospectionOptions, 'connections' | 'baseUrl'>;
  historicSql?: {
    sqlAnalysis: SqlAnalysisPort;
    reader?: HistoricSqlReader;
    queryClient?: unknown;
    postgresQueryClient?: KtxPostgresQueryClient;
    now?: () => Date;
  };
  historicSqlPullConfigOverride?: Record<string, unknown>;
  looker?: {
    daemonBaseUrl?: string;
    client?: Pick<LookerMappingClient, 'listLookmlModels' | 'getExplore'>;
    runtimeClient?: LookerRuntimeClient;
    parser?: LookerTableIdentifierParser;
    env?: NodeJS.ProcessEnv;
  };
  logger?: LocalIngestOperationalLogger;
}

type LocalIngestOperationalLogger = MetabaseClientLogger &
  MetabaseFetchLogger &
  LookerClientLogger &
  NotionFetchLogger &
  SigmaFetchLogger;

export function createDefaultLocalIngestAdapters(
  project: KtxLocalProject,
  options: DefaultLocalIngestAdaptersOptions = {},
): SourceAdapter[] {
  const lookerConnectionFactory = new DefaultLookerConnectionClientFactory(
    createLocalLookerCredentialResolver(project, options.looker?.env),
    {
      ...(options.logger ? { logger: options.logger } : {}),
    },
  );

  const adapters: SourceAdapter[] = [
    new FakeSourceAdapter(),
    new LiveDatabaseSourceAdapter({
      introspection: createDaemonLiveDatabaseIntrospection({
        connections: project.config.connections,
        ...options.databaseIntrospection,
        ...(options.databaseIntrospectionUrl ? { baseUrl: options.databaseIntrospectionUrl } : {}),
      }),
    }),
    new LookmlSourceAdapter({
      homeDir: join(project.projectDir, '.ktx/cache'),
      targetConnectionIds: primaryWarehouseConnectionIds(project),
    }),
    new DbtSourceAdapter({
      homeDir: join(project.projectDir, '.ktx/cache'),
      targetConnectionIds: primaryWarehouseConnectionIds(project),
    }),
    createLocalMetabaseSourceAdapter(project, {
      ...(options.logger ? { logger: options.logger } : {}),
    }),
    createLocalSigmaSourceAdapter(project, {
      ...(options.logger ? { logger: options.logger } : {}),
    }),
    new GdriveSourceAdapter(),
    new LookerSourceAdapter({
      clientFactory: {
        async createClient(config, ctx) {
          if (options.looker?.runtimeClient) {
            return options.looker.runtimeClient;
          }
          return lookerConnectionFactory.createClient(config.lookerConnectionId ?? ctx.connectionId);
        },
      },
    }),
    new MetricflowSourceAdapter({
      homeDir: join(project.projectDir, '.ktx/cache'),
      targetConnectionIds: primaryWarehouseConnectionIds(project),
    }),
    new NotionSourceAdapter({
      targetConnectionIds: primaryWarehouseConnectionIds(project),
      onPullSucceeded: async ({ connectionId, nextSuccessfulCursor }) => {
        await localNotionRuntimeStore(project).setCursor(connectionId, nextSuccessfulCursor);
      },
      ...(options.logger ? { logger: options.logger } : {}),
    }),
  ];

  if (options.historicSql) {
    const queryClient = options.historicSql.queryClient ?? options.historicSql.postgresQueryClient;
    if (!queryClient) {
      throw new Error('Historic SQL local adapter requires queryClient or postgresQueryClient');
    }
    adapters.push(
      new HistoricSqlSourceAdapter({
        sqlAnalysis: options.historicSql.sqlAnalysis,
        reader: options.historicSql.reader ?? new PostgresPgssReader(),
        queryClient,
        now: options.historicSql.now,
      }),
    );
  }

  return adapters;
}

function primaryWarehouseConnectionIds(project: KtxLocalProject): string[] {
  const configuredPrimaryIds = project.config.setup?.database_connection_ids ?? [];
  const configured = configuredPrimaryIds.filter((connectionId) =>
    Boolean(localConnectionToWarehouseDescriptor(connectionId, project.config.connections[connectionId])),
  );
  if (configured.length > 0) {
    return [...new Set(configured)];
  }

  return Object.entries(project.config.connections)
    .filter(([connectionId, connection]) => Boolean(localConnectionToWarehouseDescriptor(connectionId, connection)))
    .map(([connectionId]) => connectionId)
    .sort((left, right) => left.localeCompare(right));
}

function localNotionRuntimeStore(project: KtxLocalProject): LocalNotionRuntimeStore {
  return new LocalNotionRuntimeStore({ dbPath: ktxLocalStateDbPath(project) });
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

const historicSqlDialectByDriver = new Map<string, 'postgres' | 'bigquery' | 'snowflake'>([
  ['postgres', 'postgres'],
  ['bigquery', 'bigquery'],
  ['snowflake', 'snowflake'],
]);

function queryHistoryRecord(connection: unknown): Record<string, unknown> | null {
  if (!isRecord(connection)) return null;
  const context = isRecord(connection.context) ? connection.context : null;
  const queryHistory = isRecord(context?.queryHistory) ? context.queryHistory : null;
  return queryHistory;
}

async function queryHistoryPullConfig(
  project: KtxLocalProject,
  connectionId: string,
  connection: unknown,
): Promise<Record<string, unknown> | null> {
  const queryHistory = queryHistoryRecord(connection);
  if (queryHistory?.enabled !== true || !isRecord(connection)) return null;
  const driver = String(connection.driver ?? '').toLowerCase();
  const dialect = historicSqlDialectByDriver.get(driver);
  if (!dialect) return null;
  const scopeFloor = await resolveQueryHistoryScopeFloor({
    projectDir: project.projectDir,
    connectionId,
    driver,
    connection,
    storedQueryHistory: queryHistory,
  });
  const {
    enabled: _enabled,
    dialect: _dialect,
    enabledTables: _enabledTables,
    enabledSchemas: _enabledSchemas,
    scopeFloorWarnings: _scopeFloorWarnings,
    ...stored
  } = queryHistory;
  return {
    ...stored,
    dialect,
    ...(scopeFloor.enabledTables.length > 0 ? { enabledTables: scopeFloor.enabledTables } : {}),
    ...(scopeFloor.enabledSchemas.length > 0 ? { enabledSchemas: scopeFloor.enabledSchemas } : {}),
    ...(scopeFloor.modeledTableCatalog.length > 0 ? { modeledTableCatalog: scopeFloor.modeledTableCatalog } : {}),
    ...(scopeFloor.warnings.length > 0 ? { scopeFloorWarnings: scopeFloor.warnings } : {}),
  };
}

function stringField(value: unknown): string | null {
  return typeof value === 'string' && value.trim().length > 0 ? value.trim() : null;
}

function localLookmlPullConfigFromConnection(connection: Record<string, unknown> | undefined, env: NodeJS.ProcessEnv) {
  const mappings = isRecord(connection?.mappings) ? connection.mappings : {};
  const authTokenRef = stringField(connection?.auth_token_ref);
  const literalAuthToken = stringField(connection?.auth_token);

  return pullConfigFromIntegrationConfig({
    repoUrl: stringField(connection?.repoUrl) ?? null,
    branch: stringField(connection?.branch),
    path: stringField(connection?.path),
    authToken: literalAuthToken ?? resolveKtxConfigReference(authTokenRef ?? undefined, env) ?? null,
    expectedLookerConnectionName: stringField(mappings.expectedLookerConnectionName),
  });
}

function localDbtPullConfigFromConnection(connection: Record<string, unknown> | undefined, env: NodeJS.ProcessEnv) {
  const sourceDir = stringField(connection?.source_dir);
  const repoUrl = stringField(connection?.repo_url);
  if (sourceDir) {
    return {
      sourceDir,
      ...(stringField(connection?.profiles_path) ? { profilesPath: stringField(connection?.profiles_path) } : {}),
      ...(stringField(connection?.target) ? { target: stringField(connection?.target) } : {}),
      ...(stringField(connection?.project_name) ? { projectName: stringField(connection?.project_name) } : {}),
    };
  }
  if (!repoUrl) {
    return undefined;
  }
  const authToken =
    stringField(connection?.auth_token) ?? resolveKtxConfigReference(stringField(connection?.auth_token_ref) ?? undefined, env);
  return {
    repoUrl,
    ...(stringField(connection?.branch) ? { branch: stringField(connection?.branch) } : {}),
    ...(stringField(connection?.path) ? { path: stringField(connection?.path) } : {}),
    ...(authToken ? { authToken } : {}),
  };
}

export async function localPullConfigForAdapter(
  project: KtxLocalProject,
  adapter: SourceAdapter,
  connectionId: string,
  options: DefaultLocalIngestAdaptersOptions = {},
): Promise<unknown> {
  if (adapter.source === 'metabase') {
    throw new Error(
      'Metabase scheduled pulls fan out by mapping. Call runLocalMetabaseIngest() or use `ktx ingest <metabase-source-id>` from the CLI.',
    );
  }
  if (adapter.source === 'sigma') {
    const sigmaConn = project.config.connections[connectionId];
    const connectionMappings =
      sigmaConn && 'connectionMappings' in sigmaConn && sigmaConn.connectionMappings != null
        ? (sigmaConn.connectionMappings as Record<string, string>)
        : undefined;
    const workbookFilter =
      sigmaConn && 'workbookFilter' in sigmaConn && sigmaConn.workbookFilter != null
        ? (sigmaConn.workbookFilter as { includeArchived?: boolean; includeExplorations?: boolean; updatedSince?: string })
        : undefined;
    const dataModelFilter =
      sigmaConn && 'dataModelFilter' in sigmaConn && sigmaConn.dataModelFilter != null
        ? (sigmaConn.dataModelFilter as { updatedSince?: string })
        : undefined;
    return {
      sigmaConnectionId: connectionId,
      ...(connectionMappings ? { connectionMappings } : {}),
      ...(workbookFilter ? { workbookFilter } : {}),
      ...(dataModelFilter ? { dataModelFilter } : {}),
    };
  }
  const connection = project.config.connections[connectionId];
  if (adapter.source === HISTORIC_SQL_SOURCE_KEY) {
    if (options.historicSqlPullConfigOverride) {
      return historicSqlUnifiedPullConfigSchema.parse(options.historicSqlPullConfigOverride);
    }
    const queryHistory = await queryHistoryPullConfig(project, connectionId, connection);
    if (!queryHistory) {
      throw new Error(`Connection "${connectionId}" does not have context.queryHistory.enabled: true`);
    }
    return historicSqlUnifiedPullConfigSchema.parse(queryHistory);
  }
  if (adapter.source === 'looker') {
    await seedLocalMappingStateFromKtxYaml(project, connectionId);
    const store = new LocalLookerRuntimeStore({ dbPath: join(project.projectDir, '.ktx', 'db.sqlite') });
    const targetConnections = new Map(
      Object.entries(project.config.connections).flatMap(([id, config]) => {
        const descriptor = localConnectionToWarehouseDescriptor(id, config);
        return descriptor ? [[id, descriptor]] : [];
      }),
    );
    const parser =
      options.looker?.parser ??
      createDaemonLookerTableIdentifierParser({
        baseUrl: options.looker?.daemonBaseUrl ?? process.env.KTX_DAEMON_URL ?? 'http://127.0.0.1:8765',
      });
    let cleanupClient: Pick<LookerRuntimeClient, 'cleanup'> | null = null;
    let client: Pick<LookerMappingClient, 'listLookmlModels' | 'getExplore'>;
    if (options.looker?.client) {
      client = options.looker.client;
    } else {
      const runtimeClient = await new DefaultLookerConnectionClientFactory(
        createLocalLookerCredentialResolver(project, options.looker?.env),
      ).createClient(connectionId);
      cleanupClient = runtimeClient;
      client = runtimeClient;
    }
    try {
      return await buildLookerPullConfigFromInputs({
        lookerConnectionId: connectionId,
        cursors: await store.readCursors(connectionId),
        refreshedMappings: await store.readMappings(connectionId),
        targetConnections,
        client,
        parser,
      });
    } finally {
      await cleanupClient?.cleanup?.();
    }
  }
  if (adapter.source === 'lookml') {
    return localLookmlPullConfigFromConnection(connection, options.looker?.env ?? process.env);
  }
  if (adapter.source === 'dbt') {
    return localDbtPullConfigFromConnection(connection, options.looker?.env ?? process.env);
  }
  if (adapter.source === 'notion') {
    const pullConfig = await notionConnectionToPullConfig(parseNotionConnectionConfig(connection));
    return {
      ...pullConfig,
      lastSuccessfulCursor: await localNotionRuntimeStore(project).readCursor(connectionId),
    };
  }
  if (adapter.source === 'gdrive') {
    return await gdriveConnectionToPullConfig(parseGdriveConnectionConfig(connection));
  }
  if (adapter.source === 'metricflow') {
    const metricflow = connection.metricflow;
    const metricflowConfig =
      typeof metricflow === 'object' && metricflow !== null && !Array.isArray(metricflow)
        ? (metricflow as Record<string, unknown>)
        : null;
    const authToken =
      typeof metricflowConfig?.auth_token === 'string'
        ? metricflowConfig.auth_token
        : resolveKtxConfigReference(
            typeof metricflowConfig?.auth_token_ref === 'string' ? metricflowConfig.auth_token_ref : undefined,
            options.looker?.env ?? process.env,
          );
    return pullConfigFromMetricflowIntegration({
      repoUrl: typeof metricflowConfig?.repoUrl === 'string' ? metricflowConfig.repoUrl : null,
      branch: typeof metricflowConfig?.branch === 'string' ? metricflowConfig.branch : null,
      path: typeof metricflowConfig?.path === 'string' ? metricflowConfig.path : null,
      authToken: authToken ?? null,
    });
  }
  return undefined;
}
