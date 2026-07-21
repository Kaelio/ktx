import { z } from 'zod';

export const connectionTypeSchema = z.enum([
  'POSTGRESQL',
  'SQLITE',
  'DUCKDB',
  'SQLSERVER',
  'BIGQUERY',
  'SNOWFLAKE',
  'DATABRICKS',
  'ATHENA',
  'METABASE',
  'LOOKER',
  'NOTION',
  'MYSQL',
  'CLICKHOUSE',
]);

export type ConnectionType = z.infer<typeof connectionTypeSchema>;
