import { createAthenaLiveDatabaseIntrospection } from './connectors/athena/live-database-introspection.js';
import { isKtxAthenaConnectionConfig } from './connectors/athena/connector.js';
import { createBigQueryLiveDatabaseIntrospection } from './connectors/bigquery/live-database-introspection.js';
import { isKtxBigQueryConnectionConfig, KtxBigQueryScanConnector, type KtxBigQueryConnectionConfig } from './connectors/bigquery/connector.js';
import { createClickHouseLiveDatabaseIntrospection } from './connectors/clickhouse/live-database-introspection.js';
import { isKtxClickHouseConnectionConfig } from './connectors/clickhouse/connector.js';
import { createMysqlLiveDatabaseIntrospection } from './connectors/mysql/live-database-introspection.js';
import { isKtxMysqlConnectionConfig } from './connectors/mysql/connector.js';
import { createPostgresLiveDatabaseIntrospection } from './connectors/postgres/live-database-introspection.js';
import { isKtxPostgresConnectionConfig, type KtxPostgresConnectionConfig } from './connectors/postgres/connector.js';
import { KtxPostgresHistoricSqlQueryClient } from './connectors/postgres/historic-sql-query-client.js';
import { createSqliteLiveDatabaseIntrospection } from './connectors/sqlite/live-database-introspection.js';
import { isKtxSqliteConnectionConfig } from './connectors/sqlite/connector.js';
import { createDuckDbLiveDatabaseIntrospection } from './connectors/duckdb/live-database-introspection.js';
import { isKtxDuckDbConnectionConfig } from './connectors/duckdb/connector.js';
import { createSqlServerLiveDatabaseIntrospection } from './connectors/sqlserver/live-database-introspection.js';
import { isKtxSqlServerConnectionConfig } from './connectors/sqlserver/connector.js';
import { BigQueryHistoricSqlQueryHistoryReader } from './context/ingest/adapters/historic-sql/bigquery-query-history-reader.js';
import { historicSqlDialectForConnectionDriver } from './context/ingest/adapters/historic-sql/connection-dialect.js';
import { createDaemonLiveDatabaseIntrospection } from './context/ingest/adapters/live-database/daemon-introspection.js';
import { createDefaultLocalIngestAdapters, type DefaultLocalIngestAdaptersOptions } from './context/ingest/local-adapters.js';
import type { HistoricSqlDialect, HistoricSqlReader } from './context/ingest/adapters/historic-sql/types.js';
import type {
  LiveDatabaseIntrospectionOptions,
  LiveDatabaseIntrospectionPort,
} from './context/ingest/adapters/live-database/types.js';
import { LiveDatabaseSourceAdapter } from './context/ingest/adapters/live-database/live-database.adapter.js';
import { PostgresPgssReader } from './context/ingest/adapters/historic-sql/postgres-pgss-reader.js';
import { SnowflakeHistoricSqlQueryHistoryReader } from './context/ingest/adapters/historic-sql/snowflake-query-history-reader.js';
import type { SourceAdapter } from './context/ingest/types.js';
import type { KtxLocalProject } from './context/project/project.js';
import { createHttpSqlAnalysisPort } from './context/sql-analysis/http-sql-analysis-port.js';
import type { SqlAnalysisPort } from './context/sql-analysis/ports.js';
import {
  createManagedDaemonLookerTableIdentifierParser,
  createManagedDaemonSqlAnalysisPort,
  managedDaemonDatabaseIntrospectionOptions,
  type ManagedPythonDaemonHttpOptions,
} from './managed-python-http.js';
import type { KtxOperationalLogger } from './io/logger.js';
import { resolveKtxConfigReference } from './context/core/config-reference.js';

function hasSnowflakeDriver(connection: unknown): boolean {
  return (
    typeof connection === 'object' &&
    connection !== null &&
    String((connection as { driver?: unknown }).driver ?? '').toLowerCase() === 'snowflake'
  );
}

function hasDatabricksDriver(connection: unknown): boolean {
  return (
    typeof connection === 'object' &&
    connection !== null &&
    String((connection as { driver?: unknown }).driver ?? '').toLowerCase() === 'databricks'
  );
}

type SnowflakeConnectorModule = typeof import('./connectors/snowflake/connector.js');

function ktxCliDaemonDatabaseIntrospectionOptions(
  options: KtxCliLocalIngestAdaptersOptions,
): DefaultLocalIngestAdaptersOptions['databaseIntrospection'] {
  if (options.databaseIntrospectionUrl || options.databaseIntrospection?.requestJson || !options.managedDaemon) {
    return options.databaseIntrospection;
  }
  return {
    ...(options.databaseIntrospection ?? {}),
    ...managedDaemonDatabaseIntrospectionOptions(options.managedDaemon),
  };
}

function ktxCliLookerOptions(
  options: KtxCliLocalIngestAdaptersOptions,
): DefaultLocalIngestAdaptersOptions['looker'] {
  const looker = options.looker;
  if (looker?.parser || looker?.daemonBaseUrl || process.env.KTX_DAEMON_URL || !options.managedDaemon) {
    return looker;
  }
  return {
    ...(looker ?? {}),
    parser: createManagedDaemonLookerTableIdentifierParser(options.managedDaemon),
  };
}

export function resolveKtxCliSqlAnalysis(options: KtxCliLocalIngestAdaptersOptions): SqlAnalysisPort {
  if (options.sqlAnalysis) {
    return options.sqlAnalysis;
  }
  if (options.sqlAnalysisUrl) {
    return createHttpSqlAnalysisPort({ baseUrl: options.sqlAnalysisUrl });
  }
  if (process.env.KTX_SQL_ANALYSIS_URL) {
    return createHttpSqlAnalysisPort({ baseUrl: process.env.KTX_SQL_ANALYSIS_URL });
  }
  if (process.env.KTX_DAEMON_URL) {
    return createHttpSqlAnalysisPort({ baseUrl: process.env.KTX_DAEMON_URL });
  }
  if (options.managedDaemon) {
    return createManagedDaemonSqlAnalysisPort(options.managedDaemon);
  }
  return createHttpSqlAnalysisPort({ baseUrl: 'http://127.0.0.1:8765' });
}

function createKtxCliLiveDatabaseIntrospection(
  project: KtxLocalProject,
  options: KtxCliLocalIngestAdaptersOptions = {},
): LiveDatabaseIntrospectionPort {
  const databaseIntrospection = ktxCliDaemonDatabaseIntrospectionOptions(options);
  const daemon = createDaemonLiveDatabaseIntrospection({
    connections: project.config.connections,
    ...databaseIntrospection,
    ...(options.databaseIntrospectionUrl ? { baseUrl: options.databaseIntrospectionUrl } : {}),
  });
  const sqlite = createSqliteLiveDatabaseIntrospection({
    projectDir: project.projectDir,
    connections: project.config.connections,
  });
  const duckdb = createDuckDbLiveDatabaseIntrospection({
    projectDir: project.projectDir,
    connections: project.config.connections,
  });
  const mysql = createMysqlLiveDatabaseIntrospection({
    connections: project.config.connections,
  });
  const postgres = createPostgresLiveDatabaseIntrospection({
    connections: project.config.connections,
  });
  const clickhouse = createClickHouseLiveDatabaseIntrospection({
    connections: project.config.connections,
  });
  const sqlserver = createSqlServerLiveDatabaseIntrospection({
    connections: project.config.connections,
  });
  const bigquery = createBigQueryLiveDatabaseIntrospection({
    connections: project.config.connections,
  });
  const athena = createAthenaLiveDatabaseIntrospection({
    connections: project.config.connections,
  });
  return {
    async extractSchema(connectionId: string, options?: LiveDatabaseIntrospectionOptions) {
      const connection = project.config.connections[connectionId];
      if (String(connection?.driver ?? '').toLowerCase() === 'mongodb') {
        const { createMongoDbLiveDatabaseIntrospection } = await import('./connectors/mongodb/live-database-introspection.js');
        const { isKtxMongoDbConnectionConfig } = await import('./connectors/mongodb/connector.js');
        if (!isKtxMongoDbConnectionConfig(connection)) {
          return daemon.extractSchema(connectionId, options);
        }
        const mongodb = createMongoDbLiveDatabaseIntrospection({
          connections: project.config.connections,
        });
        return mongodb.extractSchema(connectionId, options);
      }
      if (isKtxPostgresConnectionConfig(connection)) {
        return postgres.extractSchema(connectionId, options);
      }
      if (isKtxSqliteConnectionConfig(connection)) {
        return sqlite.extractSchema(connectionId, options);
      }
      if (isKtxDuckDbConnectionConfig(connection)) {
        return duckdb.extractSchema(connectionId, options);
      }
      if (isKtxMysqlConnectionConfig(connection)) {
        return mysql.extractSchema(connectionId, options);
      }
      if (isKtxClickHouseConnectionConfig(connection)) {
        return clickhouse.extractSchema(connectionId, options);
      }
      if (isKtxSqlServerConnectionConfig(connection)) {
        return sqlserver.extractSchema(connectionId, options);
      }
      if (isKtxBigQueryConnectionConfig(connection)) {
        return bigquery.extractSchema(connectionId, options);
      }
      if (isKtxAthenaConnectionConfig(connection)) {
        return athena.extractSchema(connectionId, options);
      }
      if (hasSnowflakeDriver(connection)) {
        const { createSnowflakeLiveDatabaseIntrospection } = await import('./connectors/snowflake/live-database-introspection.js');
        const { isKtxSnowflakeConnectionConfig } = await import('./connectors/snowflake/connector.js');;
        if (!isKtxSnowflakeConnectionConfig(connection)) {
          return daemon.extractSchema(connectionId, options);
        }
        const snowflake = createSnowflakeLiveDatabaseIntrospection({
          connections: project.config.connections,
          projectDir: project.projectDir,
        });
        return snowflake.extractSchema(connectionId, options);
      }
      if (hasDatabricksDriver(connection)) {
        const { createDatabricksLiveDatabaseIntrospection } = await import('./connectors/databricks/live-database-introspection.js');
        const { isKtxDatabricksConnectionConfig } = await import('./connectors/databricks/connector.js');
        if (!isKtxDatabricksConnectionConfig(connection)) {
          return daemon.extractSchema(connectionId, options);
        }
        const databricks = createDatabricksLiveDatabaseIntrospection({
          connections: project.config.connections,
        });
        return databricks.extractSchema(connectionId, options);
      }
      return daemon.extractSchema(connectionId, options);
    },
  };
}

export interface KtxCliLocalIngestAdaptersOptions extends DefaultLocalIngestAdaptersOptions {
  historicSqlConnectionId?: string;
  sqlAnalysis?: SqlAnalysisPort;
  sqlAnalysisUrl?: string;
  managedDaemon?: ManagedPythonDaemonHttpOptions;
  logger?: KtxOperationalLogger;
}

export interface KtxCliHistoricSqlRuntime {
  dialect: HistoricSqlDialect;
  sqlAnalysis: SqlAnalysisPort;
  reader: HistoricSqlReader;
  queryClient: unknown;
}

function createEphemeralPostgresHistoricSqlClient(project: KtxLocalProject, connectionId: string) {
  const connection = project.config.connections[connectionId] as KtxPostgresConnectionConfig | undefined;
  const inputDriver = connection?.driver ?? 'unknown';
  if (!isKtxPostgresConnectionConfig(connection)) {
    throw new Error(`Query history ingest requires a Postgres connection, got ${String(inputDriver)}`);
  }
  return {
    async executeQuery(sql: string, params?: unknown[]) {
      const client = new KtxPostgresHistoricSqlQueryClient({
        connectionId,
        connection,
      });
      try {
        return await client.executeQuery(sql, params);
      } finally {
        await client.cleanup();
      }
    },
  };
}

function createEphemeralBigQueryHistoricSqlClient(project: KtxLocalProject, connectionId: string) {
  const connection = project.config.connections[connectionId] as KtxBigQueryConnectionConfig | undefined;
  const inputDriver = connection?.driver ?? 'unknown';
  if (!isKtxBigQueryConnectionConfig(connection)) {
    throw new Error(`Query history ingest requires a BigQuery connection, got ${String(inputDriver)}`);
  }
  return {
    async executeQuery(query: string) {
      const connector = new KtxBigQueryScanConnector({
        connectionId,
        connection,
      });
      try {
        const result = await connector.executeReadOnly({ connectionId, sql: query }, {} as never);
        return {
          headers: result.headers,
          rows: result.rows,
          totalRows: result.totalRows,
        };
      } finally {
        await connector.cleanup();
      }
    },
  };
}

async function createEphemeralSnowflakeHistoricSqlClient(
  project: KtxLocalProject,
  connectionId: string,
  connectorModule: SnowflakeConnectorModule,
) {
  const connection = project.config.connections[connectionId];
  const inputDriver = connection?.driver ?? 'unknown';
  if (!connectorModule.isKtxSnowflakeConnectionConfig(connection)) {
    throw new Error(`Query history ingest requires a Snowflake connection, got ${String(inputDriver)}`);
  }
  return {
    async executeQuery(query: string) {
      const connector = new connectorModule.KtxSnowflakeScanConnector({
        connectionId,
        connection,
        projectDir: project.projectDir,
      });
      try {
        const result = await connector.executeReadOnly({ connectionId, sql: query }, {} as never);
        return {
          headers: result.headers,
          rows: result.rows,
          totalRows: result.totalRows,
        };
      } finally {
        await connector.cleanup();
      }
    },
  };
}

function bigQueryProjectId(connection: KtxBigQueryConnectionConfig, env: NodeJS.ProcessEnv): string {
  const raw = typeof connection.credentials_json === 'string' ? connection.credentials_json : '';
  const resolved = resolveKtxConfigReference(raw, env);
  if (!resolved) {
    throw new Error('Query history BigQuery connection requires credentials_json');
  }
  const parsed = JSON.parse(resolved) as { project_id?: unknown };
  if (typeof parsed.project_id !== 'string' || parsed.project_id.trim().length === 0) {
    throw new Error('Query history BigQuery connection requires credentials_json.project_id');
  }
  return parsed.project_id;
}

function bigQueryRegion(connection: KtxBigQueryConnectionConfig): string {
  return typeof connection.location === 'string' && connection.location.trim().length > 0
    ? connection.location.trim()
    : 'us';
}

function historicSqlOptionsForLocalRun(
  project: KtxLocalProject,
  options: KtxCliLocalIngestAdaptersOptions,
): KtxCliHistoricSqlRuntime | undefined {
  const connectionId = options.historicSqlConnectionId;
  if (!connectionId) {
    return undefined;
  }
  const connection = project.config.connections[connectionId];
  // historicSqlConnectionId is only set when query history was explicitly
  // requested for this run (e.g. `--query-history`), so resolve the dialect from
  // driver capability rather than the persisted context.queryHistory.enabled
  // flag — otherwise the adapter is missing and findAdapter('historic-sql')
  // throws even though the run asked for it.
  const dialect = historicSqlDialectForConnectionDriver(connection);
  if (!dialect) {
    return undefined;
  }

  const base = {
    sqlAnalysis: resolveKtxCliSqlAnalysis(options),
  };

  if (dialect === 'postgres') {
    return {
      ...base,
      dialect,
      reader: new PostgresPgssReader() satisfies HistoricSqlReader,
      queryClient: createEphemeralPostgresHistoricSqlClient(project, connectionId),
    };
  }

  if (dialect === 'bigquery') {
    const inputDriver = connection?.driver ?? 'unknown';
    if (!isKtxBigQueryConnectionConfig(connection)) {
      throw new Error(`Query history ingest requires a BigQuery connection, got ${String(inputDriver)}`);
    }
    return {
      ...base,
      dialect,
      reader: new BigQueryHistoricSqlQueryHistoryReader({
        projectId: bigQueryProjectId(connection, process.env),
        region: bigQueryRegion(connection),
      }) satisfies HistoricSqlReader,
      queryClient: createEphemeralBigQueryHistoricSqlClient(project, connectionId),
    };
  }

  return {
    ...base,
    dialect,
    reader: new SnowflakeHistoricSqlQueryHistoryReader() satisfies HistoricSqlReader,
    queryClient: {
      async executeQuery(query: string) {
        const connectorModule = await import('./connectors/snowflake/connector.js');
        const client = await createEphemeralSnowflakeHistoricSqlClient(project, connectionId, connectorModule);
        return client.executeQuery(query);
      },
    },
  };
}

export function createKtxCliHistoricSqlRuntime(
  project: KtxLocalProject,
  connectionId: string,
  options: KtxCliLocalIngestAdaptersOptions = {},
): KtxCliHistoricSqlRuntime | undefined {
  return historicSqlOptionsForLocalRun(project, {
    ...options,
    historicSqlConnectionId: connectionId,
  });
}

export function createKtxCliLocalIngestAdapters(
  project: KtxLocalProject,
  options: KtxCliLocalIngestAdaptersOptions = {},
): SourceAdapter[] {
  const historicSql = options.historicSqlConnectionId
    ? createKtxCliHistoricSqlRuntime(project, options.historicSqlConnectionId, options)
    : undefined;
  const base = createDefaultLocalIngestAdapters(project, {
    ...options,
    databaseIntrospection: ktxCliDaemonDatabaseIntrospectionOptions(options),
    looker: ktxCliLookerOptions(options),
    ...(historicSql ? { historicSql } : {}),
  });
  const liveDatabase = new LiveDatabaseSourceAdapter({
    introspection: createKtxCliLiveDatabaseIntrospection(project, options),
  });
  return base.map((adapter) => (adapter.source === 'live-database' ? liveDatabase : adapter));
}
