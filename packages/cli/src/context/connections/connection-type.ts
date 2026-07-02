import { z } from 'zod';

export const connectionTypeSchema = z.enum([
  'POSTGRESQL',
  'SQLITE',
  'DUCKDB',
  'SQLSERVER',
  'BIGQUERY',
  'SNOWFLAKE',
  'CENTRALREACH',
  'EPIC',
  'CERNER',
  'ATHENA',
  'QUICKBOOKS',
  'WORKDAY',
  'REST',
  'S3',
  'SLACK',
  'METABASE',
  'LOOKER',
  'NOTION',
  'MYSQL',
  'CLICKHOUSE',
  'PLAIN',
  'BETTERSTACK',
]);

export type ConnectionType = z.infer<typeof connectionTypeSchema>;
