import { describe, expect, it } from 'vitest';
import { KtxTrinoDialect } from '../../../src/connectors/trino/dialect.js';

describe('KtxTrinoDialect', () => {
  const dialect = new KtxTrinoDialect();

  it('quotes identifiers and formats catalog.schema.table names (three-part)', () => {
    expect(dialect.quoteIdentifier('order"items')).toBe('"order""items"');
    expect(dialect.formatTableName({ catalog: 'hive', db: 'analytics', name: 'orders' })).toBe(
      '"hive"."analytics"."orders"',
    );
    // Trino is fully qualified; a two-part ref omits only the absent catalog.
    expect(dialect.formatTableName({ db: 'analytics', name: 'orders' })).toBe('"analytics"."orders"');
    expect(dialect.formatTableName({ name: 'orders' })).toBe('"orders"');
  });

  it('parses three-part display refs and rejects two-part ones', () => {
    expect(dialect.parseDisplayRef('hive.analytics.orders')).toEqual({
      catalog: 'hive',
      db: 'analytics',
      name: 'orders',
    });
    expect(dialect.parseDisplayRef('analytics.orders')).toBeNull();
    expect(dialect.columnDisplayTablePartCount()).toBe(3);
  });

  it('maps native Trino types to scan dimensions, unwrapping parameters', () => {
    expect(dialect.mapDataType('decimal(10,2)')).toBe('decimal(10,2)');
    expect(dialect.mapToDimensionType('timestamp(3) with time zone')).toBe('time');
    expect(dialect.mapToDimensionType('date')).toBe('time');
    expect(dialect.mapToDimensionType('bigint')).toBe('number');
    expect(dialect.mapToDimensionType('decimal(38,0)')).toBe('number');
    expect(dialect.mapToDimensionType('double')).toBe('number');
    expect(dialect.mapToDimensionType('boolean')).toBe('boolean');
    expect(dialect.mapToDimensionType('varchar(255)')).toBe('string');
    expect(dialect.mapToDimensionType('json')).toBe('string');
    expect(dialect.mapToDimensionType('array(varchar)')).toBe('string');
  });

  it('generates ANSI sampling and dictionary SQL', () => {
    expect(dialect.generateSampleQuery('"hive"."analytics"."orders"', 5, ['id', 'status'])).toBe(
      'SELECT "id", "status" FROM "hive"."analytics"."orders" LIMIT 5',
    );
    expect(dialect.generateColumnSampleQuery('"hive"."analytics"."orders"', 'status', 10)).toBe(
      'SELECT "status" FROM "hive"."analytics"."orders" WHERE "status" IS NOT NULL LIMIT 10',
    );
    expect(dialect.generateCardinalitySampleQuery('"t"', '"status"', 100)).toContain(
      'SELECT COUNT(DISTINCT val) AS cardinality',
    );
    expect(dialect.generateDistinctValuesQuery('"t"', '"status"', 20)).toContain(
      'SELECT DISTINCT CAST("status" AS VARCHAR) AS val',
    );
  });

  it('produces a BERNOULLI table-sample clause only for in-range fractions', () => {
    expect(dialect.getTableSampleClause(0.1)).toBe('TABLESAMPLE BERNOULLI (10)');
    expect(dialect.getTableSampleClause(0)).toBe('');
    expect(dialect.getTableSampleClause(1)).toBe('');
  });

  it('keeps unsupported statistics explicit', () => {
    expect(dialect.generateColumnStatisticsQuery('analytics', 'orders')).toBeNull();
  });
});
