import type {
  LiveDatabaseIntrospectionOptions,
  LiveDatabaseIntrospectionPort,
} from '../../context/ingest/adapters/live-database/types.js';
import type { KtxProjectConnectionConfig } from '../../context/project/config.js';
import {
  KtxRedshiftScanConnector,
  type KtxRedshiftConnectionConfig,
  type KtxRedshiftEndpointResolver,
  type KtxRedshiftPoolFactory,
} from './connector.js';

interface CreateRedshiftLiveDatabaseIntrospectionOptions {
  connections: Record<string, KtxProjectConnectionConfig>;
  poolFactory?: KtxRedshiftPoolFactory;
  endpointResolver?: KtxRedshiftEndpointResolver;
  now?: () => Date;
}

export function createRedshiftLiveDatabaseIntrospection(
  options: CreateRedshiftLiveDatabaseIntrospectionOptions,
): LiveDatabaseIntrospectionPort {
  return {
    async extractSchema(connectionId: string, introspectionOptions?: LiveDatabaseIntrospectionOptions) {
      const connection = options.connections[connectionId] as KtxRedshiftConnectionConfig | undefined;
      const connector = new KtxRedshiftScanConnector({
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
            driver: 'redshift',
            ...(introspectionOptions?.tableScope ? { tableScope: introspectionOptions.tableScope } : {}),
          },
          { runId: `redshift-${connectionId}` },
        );
      } finally {
        await connector.cleanup();
      }
    },
  };
}
