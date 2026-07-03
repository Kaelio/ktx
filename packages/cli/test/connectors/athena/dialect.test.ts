import { describe, expect, it } from 'vitest';
import { KtxAthenaDialect } from '../../../src/connectors/athena/dialect.js';

describe('KtxAthenaDialect', () => {
  const dialect = new KtxAthenaDialect();

  it('quotes identifiers and formats catalog.database.table names', () => {
    expect(dialect.quoteIdentifier('my"col')).toBe('"my""col"');
    expect(dialect.formatTableName({ catalog: 'AwsDataCatalog', db: 'analytics', name: 'orders' })).toBe(
      '"AwsDataCatalog"."analytics"."orders"',
    );
    expect(dialect.formatTableName({ db: 'analytics', name: 'orders' })).toBe('"analytics"."orders"');
    expect(dialect.formatTableName({ name: 'orders' })).toBe('"orders"');
  });

  it('maps native Athena/Glue types to normalized types and dimension types', () => {
    expect(dialect.mapDataType('bigint')).toBe('BIGINT');
    expect(dialect.mapDataType('string')).toBe('VARCHAR');
    expect(dialect.mapDataType('array<string>')).toBe('ARRAY');
    expect(dialect.mapDataType('map<string,bigint>')).toBe('MAP');
    expect(dialect.mapDataType('struct<id:bigint>')).toBe('STRUCT');
    expect(dialect.mapDataType('decimal(18,2)')).toBe('DECIMAL');
    expect(dialect.mapDataType('UNKNOWN_TYPE')).toBe('UNKNOWN_TYPE');

    expect(dialect.mapToDimensionType('timestamp')).toBe('time');
    expect(dialect.mapToDimensionType('date')).toBe('time');
    expect(dialect.mapToDimensionType('bigint')).toBe('number');
    expect(dialect.mapToDimensionType('double')).toBe('number');
    expect(dialect.mapToDimensionType('decimal(10,2)')).toBe('number');
    expect(dialect.mapToDimensionType('boolean')).toBe('boolean');
    expect(dialect.mapToDimensionType('string')).toBe('string');
    expect(dialect.mapToDimensionType('varchar')).toBe('string');
  });

  it('generates correct sample and column-sample SQL', () => {
    expect(dialect.generateSampleQuery('"analytics"."orders"', 10, ['id', 'status'])).toBe(
      'SELECT "id", "status" FROM "analytics"."orders" LIMIT 10',
    );
    expect(dialect.generateSampleQuery('"analytics"."orders"', 5)).toBe(
      'SELECT * FROM "analytics"."orders" LIMIT 5',
    );
    expect(dialect.generateColumnSampleQuery('"analytics"."orders"', 'status', 20)).toBe(
      'SELECT "status" FROM "analytics"."orders" WHERE "status" IS NOT NULL LIMIT 20',
    );
  });

  it('generates Presto-style cardinality and distinct-values SQL', () => {
    expect(dialect.generateCardinalitySampleQuery('"t"', '"col"', 1000)).toContain('approx_distinct');
    expect(dialect.generateRandomizedCardinalitySampleQuery('"t"', '"col"', 500)).toContain('rand()');
    expect(dialect.generateDistinctValuesQuery('"t"', '"col"', 50)).toContain(
      'SELECT DISTINCT CAST("col" AS VARCHAR) AS val',
    );
  });

  it('returns null for column statistics (unsupported)', () => {
    expect(dialect.generateColumnStatisticsQuery('analytics', 'orders')).toBeNull();
  });

  it('produces Trino-correct OFFSET-before-LIMIT ordering', () => {
    expect(dialect.getLimitOffsetClause(10)).toBe('LIMIT 10');
    expect(dialect.getLimitOffsetClause(10, 0)).toBe('LIMIT 10');
    expect(dialect.getLimitOffsetClause(10, 20)).toBe('OFFSET 20 LIMIT 10');
  });

  it('uses unit-separator (U+001F) as the array_join delimiter', () => {
    const sql = dialect.getSampleValueAggregation('SELECT value FROM t');
    const separatorIndex =
      sql.indexOf("array_join(array_agg(CAST(value AS VARCHAR)), '") +
      "array_join(array_agg(CAST(value AS VARCHAR)), '".length;
    expect(sql.charCodeAt(separatorIndex)).toBe(0x1f);
  });
});
