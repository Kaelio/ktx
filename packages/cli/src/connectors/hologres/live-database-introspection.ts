import type {
  LiveDatabaseIntrospectionOptions,
  LiveDatabaseIntrospectionPort,
} from '../../context/ingest/adapters/live-database/types.js';
import type { KtxProjectConnectionConfig } from '../../context/project/config.js';
import type {
  KtxPostgresConnectionConfig,
  KtxPostgresEndpointResolver,
  KtxPostgresPoolFactory,
} from '../postgres/connector.js';
import { KtxHologresScanConnector } from './connector.js';

interface CreateHologresLiveDatabaseIntrospectionOptions {
  connections: Record<string, KtxProjectConnectionConfig>;
  poolFactory?: KtxPostgresPoolFactory;
  endpointResolver?: KtxPostgresEndpointResolver;
  now?: () => Date;
}

export function createHologresLiveDatabaseIntrospection(
  options: CreateHologresLiveDatabaseIntrospectionOptions,
): LiveDatabaseIntrospectionPort {
  return {
    async extractSchema(connectionId: string, introspectionOptions?: LiveDatabaseIntrospectionOptions) {
      const connection = options.connections[connectionId] as KtxPostgresConnectionConfig | undefined;
      const connector = new KtxHologresScanConnector({
        connectionId,
        connection,
        poolFactory: options.poolFactory,
        endpointResolver: options.endpointResolver,
        now: options.now,
      });
      try {
        return await connector.introspect(
          {
            connectionId,
            driver: 'hologres',
            ...(introspectionOptions?.tableScope ? { tableScope: introspectionOptions.tableScope } : {}),
          },
          { runId: `hologres-${connectionId}` },
        );
      } finally {
        await connector.cleanup();
      }
    },
  };
}
