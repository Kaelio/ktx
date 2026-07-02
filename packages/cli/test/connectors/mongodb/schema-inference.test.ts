import { describe, expect, it } from 'vitest';
import { KtxMongoDbDialect } from '../../../src/connectors/mongodb/dialect.js';
import {
  bsonTypeOf,
  inferKtxMongoCollectionColumns,
  type KtxMongoDocument,
} from '../../../src/connectors/mongodb/schema-inference.js';

const dialect = new KtxMongoDbDialect();

function objectId(): unknown {
  return { _bsontype: 'ObjectId', toString: () => '64b7f0c2a1b2c3d4e5f60718' }; // pragma: allowlist secret
}

function decimal128(value: string): unknown {
  return { _bsontype: 'Decimal128', toString: () => value };
}

function infer(documents: KtxMongoDocument[]) {
  const columns = inferKtxMongoCollectionColumns(documents, dialect);
  return new Map(columns.map((column) => [column.name, column]));
}

describe('bsonTypeOf', () => {
  it('maps JS and BSON runtime values to canonical type names', () => {
    expect(bsonTypeOf(objectId())).toBe('objectId');
    expect(bsonTypeOf('hi')).toBe('string');
    expect(bsonTypeOf(7)).toBe('int');
    expect(bsonTypeOf(7.5)).toBe('double');
    expect(bsonTypeOf(true)).toBe('bool');
    expect(bsonTypeOf(new Date())).toBe('date');
    expect(bsonTypeOf(decimal128('1.5'))).toBe('decimal');
    expect(bsonTypeOf({ city: 'NY' })).toBe('object');
    expect(bsonTypeOf([1, 2])).toBe('array');
    expect(bsonTypeOf(null)).toBe('null');
  });
});

describe('inferKtxMongoCollectionColumns', () => {
  it('treats _id as the non-nullable primary key', () => {
    const columns = infer([{ _id: objectId(), name: 'a' }]);
    const id = columns.get('_id')!;
    expect(id.primaryKey).toBe(true);
    expect(id.nullable).toBe(false);
    expect(id.dimensionType).toBe('string');
    expect(id.normalizedType).toBe('objectid');
  });

  it('derives nullability from field presence and observed nulls', () => {
    const columns = infer([
      { _id: objectId(), email: 'a@x.com', deleted_at: null },
      { _id: objectId(), email: 'b@x.com' },
    ]);
    // present in every document, never null -> not nullable
    expect(columns.get('email')!.nullable).toBe(false);
    // missing in one document and null in another -> nullable
    expect(columns.get('deleted_at')!.nullable).toBe(true);
  });

  it('maps scalar BSON types to dimension types', () => {
    const columns = infer([
      { _id: objectId(), age: 30, score: 9.5, active: true, created: new Date(), balance: decimal128('10.00') },
    ]);
    expect(columns.get('age')!.dimensionType).toBe('number');
    expect(columns.get('score')!.dimensionType).toBe('number');
    expect(columns.get('active')!.dimensionType).toBe('boolean');
    expect(columns.get('created')!.dimensionType).toBe('time');
    expect(columns.get('balance')!.dimensionType).toBe('number');
  });

  it('marks a field seen with more than one type as mixed and treats it as a string', () => {
    const columns = infer([
      { _id: objectId(), ref: 'abc' },
      { _id: objectId(), ref: 123 },
    ]);
    const ref = columns.get('ref')!;
    expect(ref.nativeType).toBe('mixed');
    expect(ref.normalizedType).toBe('mixed');
    expect(ref.dimensionType).toBe('string');
  });

  it('keeps sub-documents and arrays as a single opaque json column', () => {
    const columns = infer([
      { _id: objectId(), address: { city: 'NY', zip: '10001' }, tags: ['a', 'b'] },
    ]);
    const address = columns.get('address')!;
    expect(address.nativeType).toBe('object');
    expect(address.normalizedType).toBe('json');
    expect(address.dimensionType).toBe('string');

    const tags = columns.get('tags')!;
    expect(tags.nativeType).toBe('array');
    expect(tags.normalizedType).toBe('json');
  });

  it('preserves first-seen field order', () => {
    const columns = inferKtxMongoCollectionColumns(
      [{ _id: objectId(), b: 1, a: 2 }],
      dialect,
    );
    expect(columns.map((column) => column.name)).toEqual(['_id', 'b', 'a']);
  });
});
