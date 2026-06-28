import { KtxBigQueryDialect } from '../../connectors/bigquery/dialect.js';
import { KtxClickHouseDialect } from '../../connectors/clickhouse/dialect.js';
import { KtxMysqlDialect } from '../../connectors/mysql/dialect.js';
import { KtxPostgresDialect } from '../../connectors/postgres/dialect.js';
import { KtxSqliteDialect } from '../../connectors/sqlite/dialect.js';
import { KtxSnowflakeDialect } from '../../connectors/snowflake/dialect.js';
import { KtxSqlServerDialect } from '../../connectors/sqlserver/dialect.js';
import { KtxTrinoDialect } from '../../connectors/trino/dialect.js';
import type { KtxConnectionDriver, KtxSchemaDimensionType, KtxTableRef } from '../scan/types.js';
import type { KtxDialectTableRef } from './dialect-helpers.js';

export interface KtxDialect {
  readonly type: KtxConnectionDriver;
  quoteIdentifier(identifier: string): string;
  formatTableName(table: KtxDialectTableRef): string;
  formatDisplayRef(table: KtxDialectTableRef): string;
  parseDisplayRef(display: string): KtxTableRef | null;
  columnDisplayTablePartCount(): 1 | 2 | 3;
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
  mapToDimensionType(nativeType: string): KtxSchemaDimensionType;
  mapDataType(nativeType: string): string;
}

const supportedDrivers: KtxConnectionDriver[] = [
  'bigquery',
  'clickhouse',
  'mysql',
  'postgres',
  'sqlite',
  'snowflake',
  'sqlserver',
  'trino',
];

const dialectFactories: Record<KtxConnectionDriver, () => KtxDialect> = {
  bigquery: () => new KtxBigQueryDialect(),
  clickhouse: () => new KtxClickHouseDialect(),
  mysql: () => new KtxMysqlDialect(),
  postgres: () => new KtxPostgresDialect(),
  sqlite: () => new KtxSqliteDialect(),
  snowflake: () => new KtxSnowflakeDialect(),
  sqlserver: () => new KtxSqlServerDialect(),
  trino: () => new KtxTrinoDialect(),
};

export function getDialectForDriver(driver: string): KtxDialect {
  const normalized = driver.toLowerCase().trim();
  const factory = dialectFactories[normalized as KtxConnectionDriver];
  if (factory) {
    return factory();
  }
  throw new Error(`Unsupported warehouse driver "${driver}". Supported drivers: ${supportedDrivers.join(', ')}`);
}
