import { describe, expect, it } from 'vitest';
import { getDialectForDriver, getSqlDialectForDriver } from '../../../src/context/connections/dialects.js';
import type { KtxConnectionDriver, KtxTableRef } from '../../../src/context/scan/types.js';

interface DialectFixture {
  driver: KtxConnectionDriver;
  table: KtxTableRef;
  quoteInput: string;
  quotedIdentifier: string;
  formattedTable: string;
  display: string;
  invalidDisplay: string;
  columnDisplayTablePartCount: 1 | 2 | 3;
  limitClause: string;
  topClause: string;
  randomFilter: string;
  tableSampleClause: string;
  sampleQuery: string;
  columnSampleContains: string;
  nullCountExpression: string;
  distinctCountExpression: string;
  textLengthExpression: string;
  castToText: string;
  sampleValueAggregation: string;
  cardinalityContains: string;
  randomizedCardinalityContains: string;
  distinctValuesContains: string;
  statisticsContains: string | null;
  dimensionInput: string;
  dimensionType: 'time' | 'string' | 'number' | 'boolean';
  nativeTypeInput: string;
  normalizedType: string;
}

const innerSampleSql = 'SELECT status AS value FROM orders';

const fixtures: DialectFixture[] = [
  {
    driver: 'postgres',
    table: { catalog: null, db: 'public', name: 'orders' },
    quoteInput: 'order"items',
    quotedIdentifier: '"order""items"',
    formattedTable: '"public"."orders"',
    display: 'public.orders',
    invalidDisplay: 'orders',
    columnDisplayTablePartCount: 2,
    limitClause: 'LIMIT 25 OFFSET 5',
    topClause: '',
    randomFilter: 'RANDOM() < 0.25',
    tableSampleClause: 'TABLESAMPLE SYSTEM (25)',
    sampleQuery: 'SELECT "id", "status" FROM "public"."orders" LIMIT 5',
    columnSampleContains: 'TRIM(CAST("status" AS TEXT)) != \'\'',
    nullCountExpression: 'COUNT(*) FILTER (WHERE "status" IS NULL)',
    distinctCountExpression: 'COUNT(DISTINCT "status")',
    textLengthExpression: 'LENGTH(CAST("status" AS TEXT))',
    castToText: 'CAST("status" AS TEXT)',
    sampleValueAggregation:
      '(SELECT STRING_AGG(CAST(value AS TEXT), CHR(31)) FROM (SELECT status AS value FROM orders) AS relationship_profile_values)',
    cardinalityContains: 'SELECT COUNT(DISTINCT val) AS cardinality',
    randomizedCardinalityContains: 'ORDER BY RANDOM()',
    distinctValuesContains: 'SELECT DISTINCT "status"::text AS val',
    statisticsContains: 'FROM pg_stats s',
    dimensionInput: 'timestamp with time zone',
    dimensionType: 'time',
    nativeTypeInput: 'numeric(12,2)',
    normalizedType: 'numeric(12,2)',
  },
  {
    driver: 'mysql',
    table: { catalog: null, db: 'analytics', name: 'orders' },
    quoteInput: 'order`items',
    quotedIdentifier: '`order``items`',
    formattedTable: '`analytics`.`orders`',
    display: 'analytics.orders',
    invalidDisplay: 'orders',
    columnDisplayTablePartCount: 2,
    limitClause: 'LIMIT 25 OFFSET 5',
    topClause: '',
    randomFilter: 'RAND() < 0.25',
    tableSampleClause: '',
    sampleQuery: 'SELECT `id`, `status` FROM `analytics`.`orders` LIMIT 5',
    columnSampleContains: 'TRIM(CAST(`status` AS CHAR)) != \'\'',
    nullCountExpression: 'SUM(CASE WHEN `status` IS NULL THEN 1 ELSE 0 END)',
    distinctCountExpression: 'COUNT(DISTINCT `status`)',
    textLengthExpression: 'CHAR_LENGTH(CAST(`status` AS CHAR))',
    castToText: 'CAST(`status` AS CHAR)',
    sampleValueAggregation:
      '(SELECT GROUP_CONCAT(CAST(value AS CHAR) SEPARATOR CHAR(31)) FROM (SELECT status AS value FROM orders) AS relationship_profile_values)',
    cardinalityContains: 'SELECT COUNT(DISTINCT val) AS cardinality',
    randomizedCardinalityContains: 'ORDER BY RAND()',
    distinctValuesContains: 'SELECT DISTINCT CAST(`status` AS CHAR) AS val',
    statisticsContains: 'INFORMATION_SCHEMA.STATISTICS',
    dimensionInput: 'tinyint(1)',
    dimensionType: 'boolean',
    nativeTypeInput: 'varchar(255)',
    normalizedType: 'varchar(255)',
  },
  {
    driver: 'clickhouse',
    table: { catalog: null, db: 'analytics', name: 'events' },
    quoteInput: 'order`items',
    quotedIdentifier: '`order``items`',
    formattedTable: '`analytics`.`events`',
    display: 'analytics.events',
    invalidDisplay: 'events',
    columnDisplayTablePartCount: 2,
    limitClause: 'LIMIT 25 OFFSET 5',
    topClause: '',
    randomFilter: 'rand() / 4294967295.0 < 0.25',
    tableSampleClause: '',
    sampleQuery: 'SELECT `id`, `status` FROM `analytics`.`events` LIMIT 5',
    columnSampleContains: 'trim(toString(`status`)) != \'\'',
    nullCountExpression: 'countIf(`status` IS NULL)',
    distinctCountExpression: 'COUNT(DISTINCT `status`)',
    textLengthExpression: 'length(toString(`status`))',
    castToText: 'toString(`status`)',
    sampleValueAggregation:
      '(SELECT arrayStringConcat(groupArray(toString(value)), \'\\x1F\') FROM (SELECT status AS value FROM orders) AS relationship_profile_values)',
    cardinalityContains: 'SELECT COUNT(DISTINCT val) AS cardinality',
    randomizedCardinalityContains: 'ORDER BY rand()',
    distinctValuesContains: 'SELECT DISTINCT toString(`status`) AS val',
    statisticsContains: null,
    dimensionInput: 'Nullable(DateTime64(3))',
    dimensionType: 'time',
    nativeTypeInput: 'LowCardinality(String)',
    normalizedType: 'LowCardinality(String)',
  },
  {
    driver: 'sqlite',
    table: { catalog: null, db: null, name: 'orders' },
    quoteInput: 'order"items',
    quotedIdentifier: '"order""items"',
    formattedTable: '"orders"',
    display: 'orders',
    invalidDisplay: 'public.orders',
    columnDisplayTablePartCount: 1,
    limitClause: 'LIMIT 25 OFFSET 5',
    topClause: '',
    randomFilter: '(RANDOM() % 100) < 25',
    tableSampleClause: '',
    sampleQuery: 'SELECT "id", "status" FROM "orders" LIMIT 5',
    columnSampleContains: 'TRIM(CAST("status" AS TEXT)) != \'\'',
    nullCountExpression: 'SUM(CASE WHEN "status" IS NULL THEN 1 ELSE 0 END)',
    distinctCountExpression: 'COUNT(DISTINCT "status")',
    textLengthExpression: 'LENGTH(CAST("status" AS TEXT))',
    castToText: 'CAST("status" AS TEXT)',
    sampleValueAggregation:
      '(SELECT GROUP_CONCAT(CAST(value AS TEXT), char(31)) FROM (SELECT status AS value FROM orders) AS relationship_profile_values)',
    cardinalityContains: 'SELECT COUNT(DISTINCT val) AS cardinality',
    randomizedCardinalityContains: 'ORDER BY RANDOM()',
    distinctValuesContains: 'SELECT DISTINCT CAST("status" AS TEXT) AS val',
    statisticsContains: null,
    dimensionInput: 'INTEGER',
    dimensionType: 'number',
    nativeTypeInput: 'VARCHAR(255)',
    normalizedType: 'VARCHAR(255)',
  },
  {
    driver: 'snowflake',
    table: { catalog: 'ANALYTICS', db: 'PUBLIC', name: 'ORDERS' },
    quoteInput: 'order"items',
    quotedIdentifier: '"order""items"',
    formattedTable: '"ANALYTICS"."PUBLIC"."ORDERS"',
    display: 'ANALYTICS.PUBLIC.ORDERS',
    invalidDisplay: 'PUBLIC.ORDERS',
    columnDisplayTablePartCount: 3,
    limitClause: 'LIMIT 25 OFFSET 5',
    topClause: '',
    randomFilter: 'UNIFORM(0::FLOAT, 1::FLOAT, RANDOM()) < 0.25',
    tableSampleClause: 'SAMPLE (25)',
    sampleQuery: 'SELECT "id", "status" FROM "ANALYTICS"."PUBLIC"."ORDERS" SAMPLE ROW (5 ROWS)',
    columnSampleContains: 'TRIM(CAST("status" AS STRING)) != \'\'',
    nullCountExpression: 'COUNT_IF("status" IS NULL)',
    distinctCountExpression: 'APPROX_COUNT_DISTINCT("status")',
    textLengthExpression: 'LENGTH(CAST("status" AS TEXT))',
    castToText: 'CAST("status" AS VARCHAR)',
    sampleValueAggregation:
      '(SELECT LISTAGG(CAST(value AS VARCHAR), \'\\x1f\') FROM (SELECT status AS value FROM orders) AS relationship_profile_values)',
    cardinalityContains: 'SELECT COUNT(DISTINCT val) AS cardinality',
    randomizedCardinalityContains: 'SAMPLE ROW (100 ROWS)',
    distinctValuesContains: 'SELECT DISTINCT "status"::VARCHAR AS val',
    statisticsContains: null,
    dimensionInput: 'TIMESTAMP_NTZ',
    dimensionType: 'time',
    nativeTypeInput: 'NUMBER(38,0)',
    normalizedType: 'NUMBER(38,0)',
  },
  {
    driver: 'bigquery',
    table: { catalog: 'analytics-project', db: 'warehouse', name: 'orders' },
    quoteInput: 'order`items',
    quotedIdentifier: '`order\\`items`',
    formattedTable: '`analytics-project`.`warehouse`.`orders`',
    display: 'analytics-project.warehouse.orders',
    invalidDisplay: 'warehouse.orders',
    columnDisplayTablePartCount: 3,
    limitClause: 'LIMIT 25 OFFSET 5',
    topClause: '',
    randomFilter: 'RAND() < 0.25',
    tableSampleClause: 'TABLESAMPLE SYSTEM (25 PERCENT)',
    sampleQuery: 'SELECT `id`, `status` FROM `analytics-project`.`warehouse`.`orders` ORDER BY RAND() LIMIT 5',
    columnSampleContains: 'TRIM(CAST(`status` AS STRING)) != \'\'',
    nullCountExpression: 'COUNTIF(`status` IS NULL)',
    distinctCountExpression: 'APPROX_COUNT_DISTINCT(`status`)',
    textLengthExpression: 'LENGTH(CAST(`status` AS STRING))',
    castToText: 'CAST(`status` AS STRING)',
    sampleValueAggregation:
      '(SELECT STRING_AGG(CAST(value AS STRING), \'\\u001F\') FROM (SELECT status AS value FROM orders) AS relationship_profile_values)',
    cardinalityContains: 'SELECT APPROX_COUNT_DISTINCT(val) AS cardinality',
    randomizedCardinalityContains: 'ORDER BY RAND()',
    distinctValuesContains: 'SELECT DISTINCT CAST(`status` AS STRING) AS val',
    statisticsContains: null,
    dimensionInput: 'INT64',
    dimensionType: 'number',
    nativeTypeInput: 'INT64',
    normalizedType: 'BIGINT',
  },
  {
    driver: 'sqlserver',
    table: { catalog: 'warehouse', db: 'dbo', name: 'events' },
    quoteInput: 'odd]name',
    quotedIdentifier: '[odd]]name]',
    formattedTable: '[warehouse].[dbo].[events]',
    display: 'warehouse.dbo.events',
    invalidDisplay: 'dbo.events',
    columnDisplayTablePartCount: 3,
    limitClause: '',
    topClause: 'TOP (25)',
    randomFilter: 'ABS(CHECKSUM(NEWID())) % 100 < 25',
    tableSampleClause: 'TABLESAMPLE (25 PERCENT)',
    sampleQuery: 'SELECT TOP 5 [id], [status] FROM [warehouse].[dbo].[events]',
    columnSampleContains: 'LTRIM(RTRIM(CAST([status] AS NVARCHAR(MAX)))) != \'\'',
    nullCountExpression: 'SUM(CASE WHEN [status] IS NULL THEN 1 ELSE 0 END)',
    distinctCountExpression: 'COUNT(DISTINCT [status])',
    textLengthExpression: 'LEN(CAST([status] AS NVARCHAR(MAX)))',
    castToText: 'CAST([status] AS NVARCHAR(MAX))',
    sampleValueAggregation:
      '(SELECT STRING_AGG(CAST(value AS NVARCHAR(MAX)), CHAR(31)) FROM (SELECT status AS value FROM orders) AS relationship_profile_values)',
    cardinalityContains: 'SELECT COUNT(DISTINCT val) AS cardinality',
    randomizedCardinalityContains: 'ORDER BY NEWID()',
    distinctValuesContains: 'SELECT TOP 20 val',
    statisticsContains: null,
    dimensionInput: 'datetime2',
    dimensionType: 'time',
    nativeTypeInput: 'uniqueidentifier',
    normalizedType: 'uniqueidentifier',
  },
];

describe('getDialectForDriver', () => {
  it.each(fixtures)('returns a full KtxSqlDialect for $driver', (fixture) => {
    const dialect = getSqlDialectForDriver(fixture.driver);
    const column = dialect.quoteIdentifier('status');

    expect(dialect.type).toBe(fixture.driver);
    expect(dialect.quoteIdentifier(fixture.quoteInput)).toBe(fixture.quotedIdentifier);
    expect(dialect.formatTableName(fixture.table)).toBe(fixture.formattedTable);
    expect(dialect.formatDisplayRef(fixture.table)).toBe(fixture.display);
    expect(dialect.parseDisplayRef(fixture.display)).toEqual(fixture.table);
    expect(dialect.parseDisplayRef(fixture.invalidDisplay)).toBeNull();
    expect(dialect.columnDisplayTablePartCount()).toBe(fixture.columnDisplayTablePartCount);
    expect(dialect.getLimitOffsetClause(25, 5)).toBe(fixture.limitClause);
    expect(dialect.getTopClause(25)).toBe(fixture.topClause);
    expect(dialect.getRandomSampleFilter(0.25)).toBe(fixture.randomFilter);
    expect(dialect.getTableSampleClause(0.25)).toBe(fixture.tableSampleClause);
    expect(dialect.generateSampleQuery(fixture.formattedTable, 5, ['id', 'status'])).toBe(fixture.sampleQuery);
    expect(dialect.generateColumnSampleQuery(fixture.formattedTable, 'status', 10)).toContain(
      fixture.columnSampleContains,
    );
    expect(dialect.getNullCountExpression(column)).toBe(fixture.nullCountExpression);
    expect(dialect.getDistinctCountExpression(column)).toBe(fixture.distinctCountExpression);
    expect(dialect.textLengthExpression(column)).toBe(fixture.textLengthExpression);
    expect(dialect.castToText(column)).toBe(fixture.castToText);
    expect(dialect.getSampleValueAggregation(innerSampleSql)).toBe(fixture.sampleValueAggregation);
    expect(dialect.generateCardinalitySampleQuery(fixture.formattedTable, column, 100)).toContain(
      fixture.cardinalityContains,
    );
    expect(dialect.generateRandomizedCardinalitySampleQuery(fixture.formattedTable, column, 100)).toContain(
      fixture.randomizedCardinalityContains,
    );
    expect(dialect.generateDistinctValuesQuery(fixture.formattedTable, column, 20)).toContain(
      fixture.distinctValuesContains,
    );
    const statistics = dialect.generateColumnStatisticsQuery(fixture.table.db ?? '', fixture.table.name);
    if (fixture.statisticsContains) {
      expect(statistics).toContain(fixture.statisticsContains);
    } else {
      expect(statistics).toBeNull();
    }
    expect(dialect.mapToDimensionType(fixture.dimensionInput)).toBe(fixture.dimensionType);
    expect(dialect.mapDataType(fixture.nativeTypeInput)).toBe(fixture.normalizedType);
  });

  it('accepts three-part ANSI display refs while keeping one-part names caller-owned', () => {
    for (const driver of ['postgres', 'mysql', 'clickhouse'] as const) {
      const dialect = getDialectForDriver(driver);
      expect(dialect.parseDisplayRef('warehouse.public.orders')).toEqual({
        catalog: 'warehouse',
        db: 'public',
        name: 'orders',
      });
      expect(dialect.parseDisplayRef('orders')).toBeNull();
    }
  });

  it('throws with a supported-driver list for unknown drivers', () => {
    expect(() => getDialectForDriver('oracle')).toThrow(
      'Unsupported driver "oracle". Supported drivers: bigquery, clickhouse, duckdb, mongodb, mysql, postgres, snowflake, sqlite, sqlserver',
    );
  });

  it('rejects legacy driver aliases', () => {
    expect(() => getDialectForDriver('postgresql')).toThrow('Unsupported driver "postgresql"');
    expect(() => getDialectForDriver('sqlite3')).toThrow('Unsupported driver "sqlite3"');
  });
});
