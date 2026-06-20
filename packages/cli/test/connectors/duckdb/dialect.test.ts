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

  it('generates a limited sample query', () => {
    expect(dialect.generateSampleQuery('"t"', 5)).toBe('SELECT * FROM "t" LIMIT 5');
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
