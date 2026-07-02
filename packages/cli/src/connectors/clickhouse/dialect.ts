import type { KtxSqlDialect } from '../../context/connections/dialects.js';
import {
  columnDisplayPartCount,
  formatDialectDisplayRef,
  formatDialectTableName,
  limitOffsetClause,
  parseDialectDisplayRef,
} from '../../context/connections/dialect-helpers.js';
import type { KtxSchemaDimensionType, KtxTableRef } from '../../context/scan/types.js';

type ClickHouseTableNameRef = Pick<KtxTableRef, 'name'> & Partial<Pick<KtxTableRef, 'catalog' | 'db'>>;

/** @internal */
export class KtxClickHouseDialect implements KtxSqlDialect {
  readonly type = 'clickhouse' as const;

  private readonly typeMappings: Record<string, KtxSchemaDimensionType> = {
    date: 'time',
    date32: 'time',
    datetime: 'time',
    datetime64: 'time',
    uint8: 'number',
    uint16: 'number',
    uint32: 'number',
    uint64: 'number',
    uint128: 'number',
    uint256: 'number',
    int8: 'number',
    int16: 'number',
    int32: 'number',
    int64: 'number',
    int128: 'number',
    int256: 'number',
    float32: 'number',
    float64: 'number',
    decimal: 'number',
    decimal32: 'number',
    decimal64: 'number',
    decimal128: 'number',
    decimal256: 'number',
    string: 'string',
    fixedstring: 'string',
    uuid: 'string',
    ipv4: 'string',
    ipv6: 'string',
    enum8: 'string',
    enum16: 'string',
    bool: 'boolean',
    boolean: 'boolean',
  };

  quoteIdentifier(identifier: string): string {
    return `\`${identifier.replace(/`/g, '``')}\``;
  }

  formatTableName(table: ClickHouseTableNameRef): string {
    return formatDialectTableName(table, this.quoteIdentifier.bind(this), 'ansi');
  }

  formatDisplayRef(table: ClickHouseTableNameRef): string {
    return formatDialectDisplayRef(table, 'ansi');
  }

  parseDisplayRef(display: string): KtxTableRef | null {
    return parseDialectDisplayRef(display, 'ansi');
  }

  columnDisplayTablePartCount(): 1 | 2 | 3 {
    return columnDisplayPartCount('ansi');
  }

  mapDataType(nativeType: string): string {
    return nativeType;
  }

  mapToDimensionType(nativeType: string): KtxSchemaDimensionType {
    if (!nativeType) {
      return 'string';
    }

    let normalizedType = nativeType.toLowerCase().trim();
    normalizedType = this.unwrapClickHouseType(normalizedType, 'nullable');
    normalizedType = this.unwrapClickHouseType(normalizedType, 'lowcardinality');
    normalizedType = this.unwrapClickHouseType(normalizedType, 'nullable');
    if (normalizedType.includes('(')) {
      normalizedType = normalizedType.split('(')[0] ?? normalizedType;
    }

    if (this.typeMappings[normalizedType]) {
      return this.typeMappings[normalizedType];
    }
    if (normalizedType.includes('date') || normalizedType.includes('time')) {
      return 'time';
    }
    if (
      normalizedType.includes('int') ||
      normalizedType.includes('float') ||
      normalizedType.includes('decimal')
    ) {
      return 'number';
    }
    if (normalizedType === 'bool' || normalizedType === 'boolean') {
      return 'boolean';
    }
    return 'string';
  }

  generateSampleQuery(tableName: string, limit: number, columns?: string[]): string {
    const columnList =
      columns && columns.length > 0 ? columns.map((column) => this.quoteIdentifier(column)).join(', ') : '*';
    return `SELECT ${columnList} FROM ${tableName} LIMIT ${limit}`;
  }

  generateColumnSampleQuery(tableName: string, columnName: string, limit: number): string {
    const quotedColumn = this.quoteIdentifier(columnName);
    return `SELECT ${quotedColumn} FROM ${tableName} WHERE ${quotedColumn} IS NOT NULL AND trim(toString(${quotedColumn})) != '' LIMIT ${limit}`;
  }

  getRandomSampleFilter(samplePct: number): string {
    if (samplePct <= 0 || samplePct >= 1) {
      return '';
    }
    return `rand() / 4294967295.0 < ${samplePct}`;
  }

  getTableSampleClause(_samplePct: number): string {
    return '';
  }

  getLimitOffsetClause(limit: number, offset?: number): string {
    return limitOffsetClause(limit, offset);
  }

  getTopClause(_limit: number): string {
    return '';
  }

  getNullCountExpression(column: string): string {
    return `countIf(${column} IS NULL)`;
  }

  getDistinctCountExpression(column: string): string {
    return `COUNT(DISTINCT ${column})`;
  }

  textLengthExpression(columnSql: string): string {
    return `length(toString(${columnSql}))`;
  }

  castToText(columnSql: string): string {
    return `toString(${columnSql})`;
  }

  getSampleValueAggregation(innerSql: string): string {
    return `(SELECT arrayStringConcat(groupArray(toString(value)), '\\x1F') FROM (${innerSql}) AS relationship_profile_values)`;
  }

  generateCardinalitySampleQuery(tableName: string, columnName: string, sampleSize: number): string {
    return `
      SELECT COUNT(DISTINCT val) AS cardinality
      FROM (
        SELECT ${columnName} AS val
        FROM ${tableName}
        WHERE ${columnName} IS NOT NULL
        LIMIT ${sampleSize}
      )
    `;
  }

  generateDistinctValuesQuery(tableName: string, columnName: string, limit: number): string {
    return `
      SELECT DISTINCT toString(${columnName}) AS val
      FROM ${tableName}
      WHERE ${columnName} IS NOT NULL
      ORDER BY val
      LIMIT ${limit}
    `;
  }

  generateColumnStatisticsQuery(_schemaName: string, _tableName: string): string | null {
    return null;
  }

  generateRandomizedCardinalitySampleQuery(tableName: string, columnName: string, sampleSize: number): string {
    return `
      SELECT COUNT(DISTINCT val) AS cardinality
      FROM (
        SELECT ${columnName} AS val
        FROM ${tableName}
        WHERE ${columnName} IS NOT NULL
        ORDER BY rand()
        LIMIT ${sampleSize}
      )
    `;
  }
  private unwrapClickHouseType(value: string, wrapper: string): string {
    const prefix = `${wrapper}(`;
    return value.startsWith(prefix) && value.endsWith(')') ? value.slice(prefix.length, -1) : value;
  }

}
