import type {
  LiveDatabaseIntrospectionOptions,
  LiveDatabaseIntrospectionPort,
} from '../../context/ingest/adapters/live-database/types.js';
import type { KtxProjectConnectionConfig } from '../../context/project/config.js';
import {
  KtxAthenaScanConnector,
  type KtxAthenaClientFactory,
  type KtxAthenaConnectionConfig,
} from './connector.js';

interface CreateAthenaLiveDatabaseIntrospectionOptions {
  connections: Record<string, KtxProjectConnectionConfig>;
  clientFactory?: KtxAthenaClientFactory;
  now?: () => Date;
}

export function createAthenaLiveDatabaseIntrospection(
  options: CreateAthenaLiveDatabaseIntrospectionOptions,
): LiveDatabaseIntrospectionPort {
  return {
    async extractSchema(connectionId: string, introspectionOptions?: LiveDatabaseIntrospectionOptions) {
      const connection = options.connections[connectionId] as KtxAthenaConnectionConfig | undefined;
      const connector = new KtxAthenaScanConnector({
        connectionId,
        connection,
        clientFactory: options.clientFactory,
        now: options.now,
      });
      try {
        return await connector.introspect(
          {
            connectionId,
            driver: 'athena',
            ...(introspectionOptions?.tableScope ? { tableScope: introspectionOptions.tableScope } : {}),
          },
          { runId: `athena-${connectionId}` },
        );
      } finally {
        await connector.cleanup();
      }
    },
  };
}
