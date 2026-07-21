import type { KtxConnectionDriver, KtxScanConnector } from '../scan/types.js';

/** @internal */
export type KtxScopeConfigKey = 'dataset_ids' | 'databases' | 'schemas' | 'schema_names';

/** @internal */
export interface KtxDriverConnectorModule {
  isConnectionConfig(connection: unknown): boolean;
  createScanConnector(args: {
    connectionId: string;
    connection: unknown;
    projectDir: string;
  }): KtxScanConnector;
}

export interface KtxDriverRegistration {
  readonly driver: KtxConnectionDriver;
  readonly scopeConfigKey: KtxScopeConfigKey | null;
  readonly hasHistoricSqlReader: boolean;
  load(): Promise<KtxDriverConnectorModule>;
}

function invalidConnectionConfig(driver: KtxConnectionDriver): Error {
  return new Error(`Connection config does not match warehouse driver "${driver}".`);
}

/** @internal */
export const driverRegistrations: Record<KtxConnectionDriver, KtxDriverRegistration> = {
  athena: {
    driver: 'athena',
    scopeConfigKey: 'databases',
    hasHistoricSqlReader: false,
    load: async () => {
      const m = await import('../../connectors/athena/connector.js');
      return {
        isConnectionConfig: (connection) => m.isKtxAthenaConnectionConfig(connection),
        createScanConnector: ({ connectionId, connection }) => {
          if (!m.isKtxAthenaConnectionConfig(connection)) {
            throw invalidConnectionConfig('athena');
          }
          return new m.KtxAthenaScanConnector({ connectionId, connection });
        },
      };
    },
  },
  bigquery: {
    driver: 'bigquery',
    scopeConfigKey: 'dataset_ids',
    hasHistoricSqlReader: true,
    load: async () => {
      const m = await import('../../connectors/bigquery/connector.js');
      return {
        isConnectionConfig: (connection) => {
          const typedConnection = connection as Parameters<typeof m.isKtxBigQueryConnectionConfig>[0];
          return m.isKtxBigQueryConnectionConfig(typedConnection);
        },
        createScanConnector: ({ connectionId, connection }) => {
          const typedConnection = connection as Parameters<typeof m.isKtxBigQueryConnectionConfig>[0];
          if (!m.isKtxBigQueryConnectionConfig(typedConnection)) {
            throw invalidConnectionConfig('bigquery');
          }
          return new m.KtxBigQueryScanConnector({ connectionId, connection: typedConnection });
        },
      };
    },
  },
  clickhouse: {
    driver: 'clickhouse',
    scopeConfigKey: 'databases',
    hasHistoricSqlReader: false,
    load: async () => {
      const m = await import('../../connectors/clickhouse/connector.js');
      return {
        isConnectionConfig: (connection) => {
          const typedConnection = connection as Parameters<typeof m.isKtxClickHouseConnectionConfig>[0];
          return m.isKtxClickHouseConnectionConfig(typedConnection);
        },
        createScanConnector: ({ connectionId, connection }) => {
          const typedConnection = connection as Parameters<typeof m.isKtxClickHouseConnectionConfig>[0];
          if (!m.isKtxClickHouseConnectionConfig(typedConnection)) {
            throw invalidConnectionConfig('clickhouse');
          }
          return new m.KtxClickHouseScanConnector({ connectionId, connection: typedConnection });
        },
      };
    },
  },
  duckdb: {
    driver: 'duckdb',
    scopeConfigKey: null,
    hasHistoricSqlReader: false,
    load: async () => {
      const m = await import('../../connectors/duckdb/connector.js');
      return {
        isConnectionConfig: (connection) => {
          const typedConnection = connection as Parameters<typeof m.isKtxDuckDbConnectionConfig>[0];
          return m.isKtxDuckDbConnectionConfig(typedConnection);
        },
        createScanConnector: ({ connectionId, connection, projectDir }) => {
          const typedConnection = connection as Parameters<typeof m.isKtxDuckDbConnectionConfig>[0];
          if (!m.isKtxDuckDbConnectionConfig(typedConnection)) {
            throw invalidConnectionConfig('duckdb');
          }
          return new m.KtxDuckDbScanConnector({ connectionId, connection: typedConnection, projectDir });
        },
      };
    },
  },
  mongodb: {
    driver: 'mongodb',
    scopeConfigKey: 'databases',
    hasHistoricSqlReader: false,
    load: async () => {
      const m = await import('../../connectors/mongodb/connector.js');
      return {
        isConnectionConfig: (connection) => {
          const typedConnection = connection as Parameters<typeof m.isKtxMongoDbConnectionConfig>[0];
          return m.isKtxMongoDbConnectionConfig(typedConnection);
        },
        createScanConnector: ({ connectionId, connection }) => {
          const typedConnection = connection as Parameters<typeof m.isKtxMongoDbConnectionConfig>[0];
          if (!m.isKtxMongoDbConnectionConfig(typedConnection)) {
            throw invalidConnectionConfig('mongodb');
          }
          return new m.KtxMongoDbScanConnector({ connectionId, connection: typedConnection });
        },
      };
    },
  },
  mysql: {
    driver: 'mysql',
    scopeConfigKey: 'schemas',
    hasHistoricSqlReader: false,
    load: async () => {
      const m = await import('../../connectors/mysql/connector.js');
      return {
        isConnectionConfig: (connection) => {
          const typedConnection = connection as Parameters<typeof m.isKtxMysqlConnectionConfig>[0];
          return m.isKtxMysqlConnectionConfig(typedConnection);
        },
        createScanConnector: ({ connectionId, connection }) => {
          const typedConnection = connection as Parameters<typeof m.isKtxMysqlConnectionConfig>[0];
          if (!m.isKtxMysqlConnectionConfig(typedConnection)) {
            throw invalidConnectionConfig('mysql');
          }
          return new m.KtxMysqlScanConnector({ connectionId, connection: typedConnection });
        },
      };
    },
  },
  postgres: {
    driver: 'postgres',
    scopeConfigKey: 'schemas',
    hasHistoricSqlReader: true,
    load: async () => {
      const m = await import('../../connectors/postgres/connector.js');
      return {
        isConnectionConfig: (connection) => {
          const typedConnection = connection as Parameters<typeof m.isKtxPostgresConnectionConfig>[0];
          return m.isKtxPostgresConnectionConfig(typedConnection);
        },
        createScanConnector: ({ connectionId, connection }) => {
          const typedConnection = connection as Parameters<typeof m.isKtxPostgresConnectionConfig>[0];
          if (!m.isKtxPostgresConnectionConfig(typedConnection)) {
            throw invalidConnectionConfig('postgres');
          }
          return new m.KtxPostgresScanConnector({ connectionId, connection: typedConnection });
        },
      };
    },
  },
  sqlite: {
    driver: 'sqlite',
    scopeConfigKey: null,
    hasHistoricSqlReader: false,
    load: async () => {
      const m = await import('../../connectors/sqlite/connector.js');
      return {
        isConnectionConfig: (connection) => {
          const typedConnection = connection as Parameters<typeof m.isKtxSqliteConnectionConfig>[0];
          return m.isKtxSqliteConnectionConfig(typedConnection);
        },
        createScanConnector: ({ connectionId, connection, projectDir }) => {
          const typedConnection = connection as Parameters<typeof m.isKtxSqliteConnectionConfig>[0];
          if (!m.isKtxSqliteConnectionConfig(typedConnection)) {
            throw invalidConnectionConfig('sqlite');
          }
          return new m.KtxSqliteScanConnector({ connectionId, connection: typedConnection, projectDir });
        },
      };
    },
  },
  snowflake: {
    driver: 'snowflake',
    scopeConfigKey: 'schema_names',
    hasHistoricSqlReader: true,
    load: async () => {
      const m = await import('../../connectors/snowflake/connector.js');
      return {
        isConnectionConfig: (connection) => {
          const typedConnection = connection as Parameters<typeof m.isKtxSnowflakeConnectionConfig>[0];
          return m.isKtxSnowflakeConnectionConfig(typedConnection);
        },
        createScanConnector: ({ connectionId, connection, projectDir }) => {
          const typedConnection = connection as Parameters<typeof m.isKtxSnowflakeConnectionConfig>[0];
          if (!m.isKtxSnowflakeConnectionConfig(typedConnection)) {
            throw invalidConnectionConfig('snowflake');
          }
          return new m.KtxSnowflakeScanConnector({ connectionId, connection: typedConnection, projectDir });
        },
      };
    },
  },
  databricks: {
    driver: 'databricks',
    scopeConfigKey: 'schema_names',
    hasHistoricSqlReader: false,
    load: async () => {
      const m = await import('../../connectors/databricks/connector.js');
      return {
        isConnectionConfig: (connection) => {
          const typedConnection = connection as Parameters<typeof m.isKtxDatabricksConnectionConfig>[0];
          return m.isKtxDatabricksConnectionConfig(typedConnection);
        },
        createScanConnector: ({ connectionId, connection }) => {
          const typedConnection = connection as Parameters<typeof m.isKtxDatabricksConnectionConfig>[0];
          if (!m.isKtxDatabricksConnectionConfig(typedConnection)) {
            throw invalidConnectionConfig('databricks');
          }
          return new m.KtxDatabricksScanConnector({ connectionId, connection: typedConnection });
        },
      };
    },
  },
  sqlserver: {
    driver: 'sqlserver',
    scopeConfigKey: 'schemas',
    hasHistoricSqlReader: false,
    load: async () => {
      const m = await import('../../connectors/sqlserver/connector.js');
      return {
        isConnectionConfig: (connection) => {
          const typedConnection = connection as Parameters<typeof m.isKtxSqlServerConnectionConfig>[0];
          return m.isKtxSqlServerConnectionConfig(typedConnection);
        },
        createScanConnector: ({ connectionId, connection }) => {
          const typedConnection = connection as Parameters<typeof m.isKtxSqlServerConnectionConfig>[0];
          if (!m.isKtxSqlServerConnectionConfig(typedConnection)) {
            throw invalidConnectionConfig('sqlserver');
          }
          return new m.KtxSqlServerScanConnector({ connectionId, connection: typedConnection });
        },
      };
    },
  },
};

const supportedDrivers = Object.keys(driverRegistrations).sort() as KtxConnectionDriver[];

function isRegisteredDriver(driver: string): driver is KtxConnectionDriver {
  return Object.prototype.hasOwnProperty.call(driverRegistrations, driver);
}

export function getDriverRegistration(driver: string): KtxDriverRegistration | undefined {
  const normalized = driver.toLowerCase().trim();
  return isRegisteredDriver(normalized) ? driverRegistrations[normalized] : undefined;
}

export function listSupportedDrivers(): KtxConnectionDriver[] {
  return [...supportedDrivers];
}
