import type { SqlAnalysisDialect } from './ports.js';

// One mapping from ktx connection identity to the sqlglot dialect name used by
// the Python daemon (SQL analysis, read-only validation) and semantic-layer
// compute. Keys cover both vocabularies that name a connection's engine:
// ktx.yaml driver names ("postgres", "sqlserver") and the local connection-type
// spellings exposed by KtxConnectionInfo.connectionType ("POSTGRESQL").
const SQLGLOT_DIALECTS: Record<string, SqlAnalysisDialect> = {
  postgres: 'postgres',
  postgresql: 'postgres',
  bigquery: 'bigquery',
  snowflake: 'snowflake',
  mysql: 'mysql',
  sqlserver: 'tsql',
  sqlite: 'sqlite',
  duckdb: 'duckdb',
  clickhouse: 'clickhouse',
  databricks: 'databricks',
  athena: 'athena',
};

export function sqlAnalysisDialectForDriver(driver: string | undefined): SqlAnalysisDialect {
  return SQLGLOT_DIALECTS[(driver ?? '').toLowerCase()] ?? 'postgres';
}
