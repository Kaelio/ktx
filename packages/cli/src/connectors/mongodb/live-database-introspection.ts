import type {
  LiveDatabaseIntrospectionOptions,
  LiveDatabaseIntrospectionPort,
} from '../../context/ingest/adapters/live-database/types.js';
import type { KtxProjectConnectionConfig } from '../../context/project/config.js';
import {
  KtxMongoDbScanConnector,
  type KtxMongoClientFactory,
  type KtxMongoDbConnectionConfig,
} from './connector.js';

interface CreateMongoDbLiveDatabaseIntrospectionOptions {
  connections: Record<string, KtxProjectConnectionConfig>;
  clientFactory?: KtxMongoClientFactory;
  now?: () => Date;
}

export function createMongoDbLiveDatabaseIntrospection(
  options: CreateMongoDbLiveDatabaseIntrospectionOptions,
): LiveDatabaseIntrospectionPort {
  return {
    async extractSchema(connectionId: string, introspectionOptions?: LiveDatabaseIntrospectionOptions) {
      const connection = options.connections[connectionId] as KtxMongoDbConnectionConfig | undefined;
      const connector = new KtxMongoDbScanConnector({
        connectionId,
        connection,
        clientFactory: options.clientFactory,
        now: options.now,
      });
      try {
        return await connector.introspect(
          {
            connectionId,
            driver: 'mongodb',
            ...(introspectionOptions?.tableScope ? { tableScope: introspectionOptions.tableScope } : {}),
          },
          { runId: `mongodb-${connectionId}` },
        );
      } finally {
        await connector.cleanup();
      }
    },
  };
}
