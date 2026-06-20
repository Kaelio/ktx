import type { KtxProjectConnectionConfig } from './context/project/config.js';

const KTX_DATABASE_DRIVER_IDS = new Set([
  'sqlite',
  'duckdb',
  'postgres',
  'mysql',
  'clickhouse',
  'sqlserver',
  'bigquery',
  'snowflake',
]);

export function normalizeConnectionDriver(connection: KtxProjectConnectionConfig): string {
  return String(connection.driver ?? '')
    .trim()
    .toLowerCase();
}

export function isDatabaseDriver(driver: string): boolean {
  return KTX_DATABASE_DRIVER_IDS.has(driver.trim().toLowerCase());
}
