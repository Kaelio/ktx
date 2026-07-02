import type {
  LiveDatabaseIntrospectionOptions,
  LiveDatabaseIntrospectionPort,
} from '../../context/ingest/adapters/live-database/types.js';
import type { KtxProjectConnectionConfig } from '../../context/project/config.js';
import { KtxDuckDbScanConnector, type KtxDuckDbConnectionConfig } from './connector.js';

export interface CreateDuckDbLiveDatabaseIntrospectionOptions {
  projectDir?: string;
  connections: Record<string, KtxProjectConnectionConfig>;
  now?: () => Date;
}

export function createDuckDbLiveDatabaseIntrospection(
  options: CreateDuckDbLiveDatabaseIntrospectionOptions,
): LiveDatabaseIntrospectionPort {
  return {
    async extractSchema(connectionId: string, introspectionOptions?: LiveDatabaseIntrospectionOptions) {
      const connection = options.connections[connectionId] as KtxDuckDbConnectionConfig | undefined;
      const connector = new KtxDuckDbScanConnector({
        connectionId,
        connection,
        projectDir: options.projectDir,
        now: options.now,
      });
      try {
        return await connector.introspect(
          {
            connectionId,
            driver: 'duckdb',
            ...(introspectionOptions?.tableScope ? { tableScope: introspectionOptions.tableScope } : {}),
          },
          { runId: `duckdb-${connectionId}` },
        );
      } finally {
        await connector.cleanup();
      }
    },
  };
}
