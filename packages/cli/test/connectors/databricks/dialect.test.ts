import { describe, expect, it } from 'vitest';
import { KtxDatabricksDialect } from '../../../src/connectors/databricks/dialect.js';

describe('KtxDatabricksDialect', () => {
  const dialect = new KtxDatabricksDialect();

  it('quotes identifiers and formats Unity Catalog names', () => {
    expect(dialect.quoteIdentifier('order`items')).toBe('`order``items`');
    expect(dialect.formatTableName({ catalog: 'main', db: 'sales', name: 'orders' })).toBe(
      '`main`.`sales`.`orders`',
    );
    expect(dialect.formatDisplayRef({ catalog: 'main', db: 'sales', name: 'orders' })).toBe('main.sales.orders');
    expect(dialect.parseDisplayRef('main.sales.orders')).toEqual({ catalog: 'main', db: 'sales', name: 'orders' });
    expect(dialect.parseDisplayRef('sales.orders')).toBeNull();
  });

  it('maps Databricks native types to scan dimensions', () => {
    expect(dialect.mapDataType('DECIMAL(12,2)')).toBe('DECIMAL(12,2)');
    expect(dialect.mapToDimensionType('TIMESTAMP_NTZ')).toBe('time');
    expect(dialect.mapToDimensionType('BIGINT')).toBe('number');
    expect(dialect.mapToDimensionType('BOOLEAN')).toBe('boolean');
    expect(dialect.mapToDimensionType('STRUCT<id: BIGINT>')).toBe('string');
  });

  it('generates sampling and dictionary SQL', () => {
    expect(dialect.generateSampleQuery('`main`.`sales`.`orders`', 5, ['id', 'status'])).toBe(
      'SELECT `id`, `status` FROM `main`.`sales`.`orders` LIMIT 5',
    );
    expect(dialect.generateColumnSampleQuery('`main`.`sales`.`orders`', 'status', 10)).toBe(
      "SELECT `status` FROM `main`.`sales`.`orders` WHERE `status` IS NOT NULL AND TRIM(CAST(`status` AS STRING)) != '' LIMIT 10",
    );
    expect(dialect.generateCardinalitySampleQuery('`main`.`sales`.`orders`', '`status`', 100)).toContain(
      'SELECT APPROX_COUNT_DISTINCT(val) AS cardinality',
    );
    expect(dialect.generateDistinctValuesQuery('`main`.`sales`.`orders`', '`status`', 20)).toContain(
      'SELECT DISTINCT CAST(`status` AS STRING) AS val',
    );
  });

  it('keeps unsupported statistics explicit', () => {
    expect(dialect.generateColumnStatisticsQuery('sales', 'orders')).toBeNull();
  });
});
