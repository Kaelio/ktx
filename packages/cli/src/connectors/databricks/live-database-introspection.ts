import type {
  LiveDatabaseIntrospectionOptions,
  LiveDatabaseIntrospectionPort,
} from '../../context/ingest/adapters/live-database/types.js';
import type { KtxProjectConnectionConfig } from '../../context/project/config.js';
import {
  KtxDatabricksScanConnector,
  type KtxDatabricksConnectionConfig,
  type KtxDatabricksDriverFactory,
} from './connector.js';

interface CreateDatabricksLiveDatabaseIntrospectionOptions {
  connections: Record<string, KtxProjectConnectionConfig>;
  driverFactory?: KtxDatabricksDriverFactory;
  now?: () => Date;
}

export function createDatabricksLiveDatabaseIntrospection(
  options: CreateDatabricksLiveDatabaseIntrospectionOptions,
): LiveDatabaseIntrospectionPort {
  return {
    async extractSchema(connectionId: string, introspectionOptions?: LiveDatabaseIntrospectionOptions) {
      const connection = options.connections[connectionId] as KtxDatabricksConnectionConfig | undefined;
      const connector = new KtxDatabricksScanConnector({
        connectionId,
        connection,
        driverFactory: options.driverFactory,
        now: options.now,
      });
      try {
        return await connector.introspect(
          {
            connectionId,
            driver: 'databricks',
            ...(introspectionOptions?.tableScope ? { tableScope: introspectionOptions.tableScope } : {}),
          },
          { runId: `databricks-${connectionId}` },
        );
      } finally {
        await connector.cleanup();
      }
    },
  };
}
