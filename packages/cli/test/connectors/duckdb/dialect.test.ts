import { describe, expect, it } from 'vitest';
import { KtxDuckDbDialect } from '../../../src/connectors/duckdb/dialect.js';

describe('KtxDuckDbDialect', () => {
  const dialect = new KtxDuckDbDialect();

  it('quotes identifiers with double quotes and escapes embedded quotes', () => {
    expect(dialect.quoteIdentifier('order"s')).toBe('"order""s"');
  });

  it('maps integer types to number dimension', () => {
    expect(dialect.mapToDimensionType('BIGINT')).toBe('number');
    expect(dialect.mapToDimensionType('DOUBLE')).toBe('number');
  });

  it('maps timestamp types to time dimension', () => {
    expect(dialect.mapToDimensionType('TIMESTAMP')).toBe('time');
    expect(dialect.mapToDimensionType('DATE')).toBe('time');
  });

  it('maps text types to string dimension', () => {
    expect(dialect.mapToDimensionType('VARCHAR')).toBe('string');
  });

  it('maps boolean types to boolean dimension', () => {
    expect(dialect.mapToDimensionType('BOOLEAN')).toBe('boolean');
    expect(dialect.mapToDimensionType('BOOL')).toBe('boolean');
  });

  it('falls back to string for an empty or unknown native type', () => {
    expect(dialect.mapToDimensionType('')).toBe('string');
    expect(dialect.mapToDimensionType('JSON')).toBe('string');
  });

  // The precedence ladder strips parameters before substring rules fire, so a
  // parameterized DECIMAL still resolves through the numeric branch rather than
  // the string fallback.
  it('strips type parameters before resolving the dimension', () => {
    expect(dialect.mapToDimensionType('DECIMAL(10,2)')).toBe('number');
    expect(dialect.mapToDimensionType('VARCHAR(255)')).toBe('string');
  });

  // Types absent from the exact-match table still resolve via substring rules:
  // TIMESTAMP_NS (time), UINT128/HUGEINT-like (number), and lowercase input.
  it('resolves unlisted types through substring matching, case-insensitively', () => {
    expect(dialect.mapToDimensionType('timestamp_ns')).toBe('time');
    expect(dialect.mapToDimensionType('INT128')).toBe('number');
    expect(dialect.mapToDimensionType('  double  ')).toBe('number');
  });

  it('generates a limited sample query', () => {
    expect(dialect.generateSampleQuery('"t"', 5)).toBe('SELECT * FROM "t" LIMIT 5');
  });

  it('quotes selected columns in a sample query', () => {
    expect(dialect.generateSampleQuery('"t"', 5, ['a', 'b'])).toBe('SELECT "a", "b" FROM "t" LIMIT 5');
  });

  it('builds a non-null, non-blank column sample query', () => {
    expect(dialect.generateColumnSampleQuery('"t"', 'email', 3)).toBe(
      `SELECT "email" FROM "t" WHERE "email" IS NOT NULL AND TRIM(CAST("email" AS VARCHAR)) != '' LIMIT 3`,
    );
  });

  // A degenerate sample percentage (<=0 or >=1) means "no sampling", so both the
  // random filter and the TABLESAMPLE clause must collapse to an empty string.
  it('returns empty sample clauses outside the (0,1) range and real clauses inside it', () => {
    expect(dialect.getRandomSampleFilter(0)).toBe('');
    expect(dialect.getRandomSampleFilter(1)).toBe('');
    expect(dialect.getRandomSampleFilter(0.25)).toBe('RANDOM() < 0.25');
    expect(dialect.getTableSampleClause(0)).toBe('');
    expect(dialect.getTableSampleClause(0.1)).toBe('USING SAMPLE 10 PERCENT (bernoulli)');
  });

  // A type missing from the exact-match table but containing BOOL still resolves
  // through the substring branch rather than the string fallback.
  it('resolves a BOOL-substring type to boolean', () => {
    expect(dialect.mapToDimensionType('MYBOOL')).toBe('boolean');
  });

  it('builds limit/offset, sample-value aggregation, and randomized cardinality clauses', () => {
    expect(dialect.getLimitOffsetClause(10, 5)).toContain('LIMIT 10');
    expect(dialect.getSampleValueAggregation('SELECT 1')).toContain('STRING_AGG');
    expect(dialect.generateRandomizedCardinalitySampleQuery('"t"', 'c', 100)).toContain('USING SAMPLE 100 ROWS');
  });

  it('exposes profiling expressions and a null column-statistics query', () => {
    expect(dialect.getNullCountExpression('c')).toBe('SUM(CASE WHEN c IS NULL THEN 1 ELSE 0 END)');
    expect(dialect.getDistinctCountExpression('c')).toBe('COUNT(DISTINCT c)');
    expect(dialect.textLengthExpression('c')).toBe('LENGTH(CAST(c AS VARCHAR))');
    expect(dialect.castToText('c')).toBe('CAST(c AS VARCHAR)');
    expect(dialect.mapDataType('BIGINT')).toBe('BIGINT');
    expect(dialect.getTopClause(5)).toBe('');
    expect(dialect.generateColumnStatisticsQuery('main', 't')).toBeNull();
  });

  // Guards the single-namespace (db=null) display shape: v1 introspects only
  // `main`, so a display ref must round-trip as a bare table name. An ANSI shape
  // would emit a 1-part name it then refuses to parse, breaking column lookups.
  it('round-trips a single-namespace display ref and reports a 1-part column shape', () => {
    const table = { catalog: null, db: null, name: 'orders' };
    const display = dialect.formatDisplayRef(table);
    expect(display).toBe('orders');
    expect(dialect.parseDisplayRef(display)).toMatchObject({ name: 'orders' });
    expect(dialect.columnDisplayTablePartCount()).toBe(1);
    expect(dialect.formatTableName(table)).toBe('"orders"');
  });
});
