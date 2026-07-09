import { z } from 'zod';

export const connectionTypeSchema = z.enum([
  'POSTGRESQL',
  'REDSHIFT',
  'SQLITE',
  'DUCKDB',
  'SQLSERVER',
  'BIGQUERY',
  'SNOWFLAKE',
  'ATHENA',
  'METABASE',
  'LOOKER',
  'NOTION',
  'MYSQL',
  'CLICKHOUSE',
]);

export type ConnectionType = z.infer<typeof connectionTypeSchema>;
