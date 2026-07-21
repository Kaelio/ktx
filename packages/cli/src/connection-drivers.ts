import type { KtxProjectConnectionConfig } from './context/project/config.js';

/** @internal Canonical SQL-warehouse driver ids; the dialect-notes coverage test derives its required coverage from this set. */
export const KTX_DATABASE_DRIVER_IDS = [
  'sqlite',
  'duckdb',
  'postgres',
  'mysql',
  'clickhouse',
  'sqlserver',
  'bigquery',
  'snowflake',
  'databricks',
  'athena',
] as const;

// mongodb is a database driver but has no SQL dialect, so it sits outside the
// dialect-notes coverage set above.
const databaseDriverIds = new Set<string>([...KTX_DATABASE_DRIVER_IDS, 'mongodb']);

export function normalizeConnectionDriver(connection: KtxProjectConnectionConfig): string {
  return String(connection.driver ?? '')
    .trim()
    .toLowerCase();
}

export function isDatabaseDriver(driver: string): boolean {
  return databaseDriverIds.has(driver.trim().toLowerCase());
}
