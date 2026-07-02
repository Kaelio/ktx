import { KtxBigQueryDialect } from '../../connectors/bigquery/dialect.js';
import { KtxClickHouseDialect } from '../../connectors/clickhouse/dialect.js';
import { KtxDuckDbDialect } from '../../connectors/duckdb/dialect.js';
import { KtxMongoDbDialect } from '../../connectors/mongodb/dialect.js';
import { KtxMysqlDialect } from '../../connectors/mysql/dialect.js';
import { KtxPostgresDialect } from '../../connectors/postgres/dialect.js';
import { KtxSqliteDialect } from '../../connectors/sqlite/dialect.js';
import { KtxSnowflakeDialect } from '../../connectors/snowflake/dialect.js';
import { KtxSqlServerDialect } from '../../connectors/sqlserver/dialect.js';
import { KtxExpectedError } from '../../errors.js';
import type { KtxConnectionDriver, KtxSchemaDimensionType, KtxTableRef } from '../scan/types.js';
import type { KtxDialectTableRef } from './dialect-helpers.js';

/**
 * Driver-agnostic dialect surface every connection implements, including
 * non-SQL sources like MongoDB: display/ref formatting and type mapping. The
 * catalog and entity-details paths resolve this for any snapshot driver, so it
 * must stay free of SQL generation.
 */
export interface KtxDialect {
  readonly type: KtxConnectionDriver;
  formatDisplayRef(table: KtxDialectTableRef): string;
  parseDisplayRef(display: string): KtxTableRef | null;
  columnDisplayTablePartCount(): 1 | 2 | 3;
  mapToDimensionType(nativeType: string): KtxSchemaDimensionType;
  mapDataType(nativeType: string): string;
}

/**
 * SQL query generation, implemented only by SQL warehouse drivers. The relationship
 * profiling/validation pipeline is the sole caller and is gated on the
 * `readOnlySql` capability, so these methods are unreachable for a non-SQL source.
 */
export interface KtxSqlDialect extends KtxDialect {
  quoteIdentifier(identifier: string): string;
  formatTableName(table: KtxDialectTableRef): string;
  getLimitOffsetClause(limit: number, offset?: number): string;
  getTopClause(limit: number): string;
  getRandomSampleFilter(samplePct: number): string;
  getTableSampleClause(samplePct: number): string;
  generateSampleQuery(tableName: string, limit: number, columns?: string[]): string;
  generateColumnSampleQuery(tableName: string, columnName: string, limit: number): string;
  getSampleValueAggregation(innerSql: string): string;
  generateCardinalitySampleQuery(tableName: string, columnName: string, sampleSize: number): string;
  generateRandomizedCardinalitySampleQuery(tableName: string, columnName: string, sampleSize: number): string;
  generateDistinctValuesQuery(tableName: string, columnName: string, limit: number): string;
  generateColumnStatisticsQuery(schemaName: string, tableName: string): string | null;
  getNullCountExpression(column: string): string;
  getDistinctCountExpression(column: string): string;
  textLengthExpression(columnSql: string): string;
  castToText(columnSql: string): string;
}

type KtxSqlDriver = Exclude<KtxConnectionDriver, 'mongodb'>;

const sqlDialectFactories: Record<KtxSqlDriver, () => KtxSqlDialect> = {
  bigquery: () => new KtxBigQueryDialect(),
  clickhouse: () => new KtxClickHouseDialect(),
  duckdb: () => new KtxDuckDbDialect(),
  mysql: () => new KtxMysqlDialect(),
  postgres: () => new KtxPostgresDialect(),
  sqlite: () => new KtxSqliteDialect(),
  snowflake: () => new KtxSnowflakeDialect(),
  sqlserver: () => new KtxSqlServerDialect(),
};

const dialectFactories: Record<KtxConnectionDriver, () => KtxDialect> = {
  ...sqlDialectFactories,
  mongodb: () => new KtxMongoDbDialect(),
};

const supportedSqlDrivers = Object.keys(sqlDialectFactories).sort();

export function getDialectForDriver(driver: string): KtxDialect {
  const normalized = driver.toLowerCase().trim();
  const factory = dialectFactories[normalized as KtxConnectionDriver];
  if (factory) {
    return factory();
  }
  throw new Error(
    `Unsupported driver "${driver}". Supported drivers: ${Object.keys(dialectFactories).sort().join(', ')}`,
  );
}

export function getSqlDialectForDriver(driver: string): KtxSqlDialect {
  const normalized = driver.toLowerCase().trim();
  const factory = sqlDialectFactories[normalized as KtxSqlDriver];
  if (factory) {
    return factory();
  }
  throw new Error(`Driver "${driver}" has no SQL dialect. SQL drivers: ${supportedSqlDrivers.join(', ')}`);
}

/**
 * Whether a driver can generate and execute SQL. Single source of truth for the
 * SQL/non-SQL boundary: a driver is SQL-queryable iff it has a SQL dialect, so
 * non-SQL sources (e.g. mongodb) are excluded without a hand-maintained list.
 */
export function isSqlQueryableDriver(driver: string | undefined): boolean {
  const normalized = (driver ?? '').toLowerCase().trim();
  return Object.prototype.hasOwnProperty.call(sqlDialectFactories, normalized);
}

/**
 * Refuse a non-SQL connection (e.g. mongodb) at a read-only-SQL entry point before
 * any dialect selection or parser/daemon work, so it is never validated as Postgres.
 * The federated `duckdb` connection has no driver — callers skip this guard for it.
 */
export function assertSqlQueryableConnection(connectionId: string, driver: string | undefined): void {
  if (!isSqlQueryableDriver(driver)) {
    throw new KtxExpectedError(
      `Connection '${connectionId}' uses the non-SQL driver '${driver ?? 'unknown'}'. ` +
        'Read-only SQL (ktx sql, the sql_execution tool) requires a SQL warehouse connection; ' +
        'MongoDB and other context-only sources are searchable and ingestable, not SQL-queryable.',
    );
  }
}
