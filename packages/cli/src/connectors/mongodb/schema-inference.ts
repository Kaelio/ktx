import type { KtxSchemaColumn } from '../../context/scan/types.js';
import type { KtxDialect } from '../../context/connections/dialects.js';

export type KtxMongoDocument = Record<string, unknown>;

/** Top-level field name MongoDB guarantees on every document; used as the primary key. */
export const MONGO_ID_FIELD = '_id';

const BSON_TYPE_NAMES: Record<string, string> = {
  objectid: 'objectId',
  int32: 'int',
  long: 'long',
  double: 'double',
  decimal128: 'decimal',
  binary: 'binary',
  uuid: 'uuid',
  timestamp: 'timestamp',
  bsonregexp: 'regex',
  bsonsymbol: 'string',
};

/**
 * Canonical BSON type name for a sampled value as the `mongodb` driver hydrates
 * it: BSON wrapper objects expose `_bsontype`; everything else maps from the JS
 * runtime type. Sub-documents and arrays collapse to opaque `object`/`array`.
 * @internal
 */
export function bsonTypeOf(value: unknown): string {
  if (value === null || value === undefined) {
    return 'null';
  }
  if (typeof value === 'string') {
    return 'string';
  }
  if (typeof value === 'boolean') {
    return 'bool';
  }
  if (typeof value === 'number') {
    return Number.isInteger(value) ? 'int' : 'double';
  }
  if (typeof value === 'bigint') {
    return 'long';
  }
  if (value instanceof Date) {
    return 'date';
  }
  if (Array.isArray(value)) {
    return 'array';
  }
  if (typeof value === 'object') {
    const bsontype = (value as { _bsontype?: unknown })._bsontype;
    if (typeof bsontype === 'string') {
      return BSON_TYPE_NAMES[bsontype.toLowerCase()] ?? bsontype;
    }
    return 'object';
  }
  return 'mixed';
}

interface FieldAccumulator {
  types: Set<string>;
  present: number;
  nullSeen: boolean;
}

function resolveNativeType(types: ReadonlySet<string>): string {
  if (types.size === 0) {
    return 'null';
  }
  if (types.size > 1) {
    return 'mixed';
  }
  return [...types][0]!;
}

/**
 * Infer a flat column schema from sampled documents. Each top-level field becomes
 * one column: BSON types are unioned (a field seen with >1 type is `mixed` and
 * treated as a string), nullability is derived from field presence and observed
 * nulls, and sub-documents/arrays remain a single opaque `json` column. `_id` is
 * the non-nullable primary key.
 */
export function inferKtxMongoCollectionColumns(
  documents: readonly KtxMongoDocument[],
  dialect: KtxDialect,
): KtxSchemaColumn[] {
  const total = documents.length;
  const order: string[] = [];
  const fields = new Map<string, FieldAccumulator>();

  for (const document of documents) {
    if (!document || typeof document !== 'object') {
      continue;
    }
    for (const [name, value] of Object.entries(document)) {
      let accumulator = fields.get(name);
      if (!accumulator) {
        accumulator = { types: new Set(), present: 0, nullSeen: false };
        fields.set(name, accumulator);
        order.push(name);
      }
      accumulator.present += 1;
      const bsonType = bsonTypeOf(value);
      if (bsonType === 'null') {
        accumulator.nullSeen = true;
      } else {
        accumulator.types.add(bsonType);
      }
    }
  }

  return order.map((name) => {
    const accumulator = fields.get(name)!;
    const nativeType = resolveNativeType(accumulator.types);
    const isId = name === MONGO_ID_FIELD;
    const nullable = isId
      ? false
      : accumulator.present < total || accumulator.nullSeen || accumulator.types.size === 0;
    return {
      name,
      nativeType,
      normalizedType: dialect.mapDataType(nativeType),
      dimensionType: dialect.mapToDimensionType(nativeType),
      nullable,
      primaryKey: isId,
      comment: null,
    };
  });
}
