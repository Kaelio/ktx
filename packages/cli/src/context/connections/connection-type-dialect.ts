import type { ConnectionType } from './connection-type.js';

const CONNECTION_TYPE_TO_SQLGLOT = {
  POSTGRESQL: 'postgres',
  SQLITE: 'sqlite',
  DUCKDB: 'duckdb',
  SQLSERVER: 'tsql',
  BIGQUERY: 'bigquery',
  SNOWFLAKE: 'snowflake',
  MYSQL: 'mysql',
  CLICKHOUSE: 'clickhouse',
  ATHENA: 'athena',
  METABASE: null,
  LOOKER: null,
  NOTION: null,
} satisfies Record<ConnectionType, string | null>;

export function dialectForConnectionType(connectionType: string): string {
  return CONNECTION_TYPE_TO_SQLGLOT[connectionType.toUpperCase() as ConnectionType] ?? 'postgres';
}

export function warehouseTargetDialect(connectionType: string): string | null {
  return CONNECTION_TYPE_TO_SQLGLOT[connectionType.toUpperCase() as ConnectionType] ?? null;
}
