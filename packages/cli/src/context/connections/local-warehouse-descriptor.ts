import type { KtxProjectConnectionConfig } from '../project/config.js';
import type { ConnectionType } from './connection-type.js';
import { connectionQueryPolicy } from './query-policy.js';

export interface LocalWarehouseDescriptor {
  id: string;
  connection_type: ConnectionType;
  host?: string | null;
  database?: string | null;
  account?: string | null;
  project_id?: string | null;
  dataset_id?: string | null;
  connection_params: Record<string, unknown>;
}

export interface LocalConnectionInfo {
  id: string;
  name: string;
  connectionType: string;
  members?: string[];
  hint?: string;
  queryPolicy?: 'semantic-layer-only';
}

const DRIVER_TO_CONNECTION_TYPE: Record<string, ConnectionType> = {
  postgres: 'POSTGRESQL',
  sqlite: 'SQLITE',
  duckdb: 'DUCKDB',
  sqlserver: 'SQLSERVER',
  mysql: 'MYSQL',
  clickhouse: 'CLICKHOUSE',
  snowflake: 'SNOWFLAKE',
  databricks: 'DATABRICKS',
  bigquery: 'BIGQUERY',
  athena: 'ATHENA',
};

export function localConnectionToWarehouseDescriptor(
  id: string,
  connection: KtxProjectConnectionConfig | undefined,
): LocalWarehouseDescriptor | null {
  if (!connection) {
    return null;
  }
  const connectionType = DRIVER_TO_CONNECTION_TYPE[String(connection.driver ?? '').toLowerCase()];
  if (!connectionType) {
    return null;
  }

  const info: LocalWarehouseDescriptor = {
    id,
    connection_type: connectionType,
    connection_params: { ...connection },
  };
  const url = typeof connection.url === 'string' ? connection.url : null;
  if (url && !url.startsWith('env:') && !url.startsWith('file:')) {
    try {
      const parsed = new URL(url);
      info.host = parsed.hostname || null;
      if (parsed.pathname.length > 1) {
        const [first, second] = parsed.pathname.slice(1).split('/');
        if (connectionType === 'BIGQUERY') {
          info.project_id = stringField(connection.project_id) ?? parsed.hostname ?? first ?? null;
          info.dataset_id = stringField(connection.dataset_id) ?? second ?? null;
        } else {
          info.database = first ?? null;
        }
      }
    } catch {
      info.host = stringField(connection.host);
    }
  }

  info.host = stringField(connection.host) ?? info.host ?? null;
  info.database = stringField(connection.database) ?? info.database ?? null;
  info.account = stringField(connection.account) ?? null;
  info.project_id = stringField(connection.project_id) ?? info.project_id ?? null;
  info.dataset_id = stringField(connection.dataset_id) ?? info.dataset_id ?? null;
  return info;
}

export function localConnectionTypeForConfig(id: string, connection: KtxProjectConnectionConfig | undefined): string {
  const descriptor = localConnectionToWarehouseDescriptor(id, connection);
  if (descriptor) {
    return descriptor.connection_type;
  }
  const driver = typeof connection?.driver === 'string' ? connection.driver.trim() : '';
  return driver.length > 0 ? driver : 'unknown';
}

export function localConnectionInfoFromConfig(
  id: string,
  connection: KtxProjectConnectionConfig | undefined,
): LocalConnectionInfo | null {
  if (!connection) {
    return null;
  }
  const restricted = connectionQueryPolicy(connection) === 'semantic-layer-only';
  return {
    id,
    name: id,
    connectionType: localConnectionTypeForConfig(id, connection),
    ...(restricted
      ? {
          queryPolicy: 'semantic-layer-only' as const,
          hint: 'Raw SQL is disabled on this connection; query it with sl_query using predefined measures.',
        }
      : {}),
  };
}

function stringField(value: unknown): string | null {
  return typeof value === 'string' && value.trim().length > 0 ? value.trim() : null;
}
