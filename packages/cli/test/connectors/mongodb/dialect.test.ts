import { describe, expect, it } from 'vitest';
import { KtxMongoDbDialect } from '../../../src/connectors/mongodb/dialect.js';
import { getDialectForDriver, getSqlDialectForDriver } from '../../../src/context/connections/dialects.js';

const dialect = new KtxMongoDbDialect();

describe('KtxMongoDbDialect', () => {
  it('formats and parses db.collection display refs', () => {
    expect(dialect.formatDisplayRef({ catalog: null, db: 'app', name: 'users' })).toBe('app.users');
    expect(dialect.parseDisplayRef('app.users')).toEqual({ catalog: null, db: 'app', name: 'users' });
    expect(dialect.columnDisplayTablePartCount()).toBe(2);
  });

  it('maps nested types to opaque json and scalars to dimension types', () => {
    expect(dialect.mapDataType('object')).toBe('json');
    expect(dialect.mapDataType('array')).toBe('json');
    expect(dialect.mapDataType('objectId')).toBe('objectid');
    expect(dialect.mapToDimensionType('date')).toBe('time');
    expect(dialect.mapToDimensionType('long')).toBe('number');
    expect(dialect.mapToDimensionType('mixed')).toBe('string');
    expect(dialect.mapToDimensionType('object')).toBe('string');
  });
});

describe('dialect registry', () => {
  it('resolves a core dialect for mongodb', () => {
    expect(getDialectForDriver('mongodb').type).toBe('mongodb');
  });

  it('refuses a SQL dialect for mongodb', () => {
    expect(() => getSqlDialectForDriver('mongodb')).toThrow(/no SQL dialect/);
  });
});
