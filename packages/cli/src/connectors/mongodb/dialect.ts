import type { KtxDialect } from '../../context/connections/dialects.js';
import {
  columnDisplayPartCount,
  formatDialectDisplayRef,
  parseDialectDisplayRef,
} from '../../context/connections/dialect-helpers.js';
import type { KtxDialectTableRef } from '../../context/connections/dialect-helpers.js';
import type { KtxSchemaDimensionType, KtxTableRef } from '../../context/scan/types.js';

/**
 * Display/type-mapping half of the dialect contract for MongoDB. Collections map
 * to `db.collection` display refs (ansi two-part shape). MongoDB is a non-SQL
 * source, so it implements {@link KtxDialect} only — never {@link KtxSqlDialect}.
 */
export class KtxMongoDbDialect implements KtxDialect {
  readonly type = 'mongodb' as const;

  private readonly typeMappings: Record<string, KtxSchemaDimensionType> = {
    objectid: 'string',
    string: 'string',
    uuid: 'string',
    binary: 'string',
    regex: 'string',
    int: 'number',
    long: 'number',
    double: 'number',
    decimal: 'number',
    bool: 'boolean',
    date: 'time',
    timestamp: 'time',
    object: 'string',
    array: 'string',
    json: 'string',
    null: 'string',
    mixed: 'string',
  };

  formatDisplayRef(table: KtxDialectTableRef): string {
    return formatDialectDisplayRef(table, 'ansi');
  }

  parseDisplayRef(display: string): KtxTableRef | null {
    return parseDialectDisplayRef(display, 'ansi');
  }

  columnDisplayTablePartCount(): 1 | 2 | 3 {
    return columnDisplayPartCount('ansi');
  }

  mapDataType(nativeType: string): string {
    const normalized = nativeType.toLowerCase().trim();
    if (normalized === 'object' || normalized === 'array') {
      return 'json';
    }
    return normalized || 'mixed';
  }

  mapToDimensionType(nativeType: string): KtxSchemaDimensionType {
    if (!nativeType) {
      return 'string';
    }
    return this.typeMappings[nativeType.toLowerCase().trim()] ?? 'string';
  }
}
