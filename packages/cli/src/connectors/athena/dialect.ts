import type { KtxSqlDialect } from '../../context/connections/dialects.js';
import {
  columnDisplayPartCount,
  formatDialectDisplayRef,
  formatDialectTableName,
  parseDialectDisplayRef,
} from '../../context/connections/dialect-helpers.js';
import type { KtxSchemaDimensionType, KtxTableRef } from '../../context/scan/types.js';

type AthenaTableNameRef = Pick<KtxTableRef, 'name'> & Partial<Pick<KtxTableRef, 'catalog' | 'db'>>;

/** @internal */
export class KtxAthenaDialect implements KtxSqlDialect {
  readonly type = 'athena' as const;

  private readonly dimensionTypeMappings: Record<string, KtxSchemaDimensionType> = {
    timestamp: 'time',
    date: 'time',
    bigint: 'number',
    int: 'number',
    integer: 'number',
    tinyint: 'number',
    smallint: 'number',
    double: 'number',
    float: 'number',
    real: 'number',
    boolean: 'boolean',
  };

  quoteIdentifier(identifier: string): string {
    return `"${identifier.replace(/"/g, '""')}"`;
  }

  formatTableName(table: AthenaTableNameRef): string {
    return formatDialectTableName(table, this.quoteIdentifier.bind(this), 'ansi');
  }

  formatDisplayRef(table: AthenaTableNameRef): string {
    return formatDialectDisplayRef(table, 'ansi');
  }

  parseDisplayRef(display: string): KtxTableRef | null {
    return parseDialectDisplayRef(display, 'ansi');
  }

  columnDisplayTablePartCount(): 1 | 2 | 3 {
    return columnDisplayPartCount('ansi');
  }

  mapDataType(nativeType: string): string {
    const base = nativeType.toLowerCase().trim().split('<')[0]!.split('(')[0]!.trim();
    const typeMap: Record<string, string> = {
      string: 'VARCHAR',
      varchar: 'VARCHAR',
      char: 'CHAR',
      binary: 'VARBINARY',
      bigint: 'BIGINT',
      int: 'INTEGER',
      integer: 'INTEGER',
      tinyint: 'TINYINT',
      smallint: 'SMALLINT',
      double: 'DOUBLE',
      float: 'FLOAT',
      real: 'REAL',
      decimal: 'DECIMAL',
      boolean: 'BOOLEAN',
      timestamp: 'TIMESTAMP',
      date: 'DATE',
      array: 'ARRAY',
      map: 'MAP',
      struct: 'STRUCT',
      uniontype: 'UNION',
    };
    return typeMap[base] ?? nativeType.toUpperCase();
  }

  mapToDimensionType(nativeType: string): KtxSchemaDimensionType {
    const base = nativeType.toLowerCase().trim().split('<')[0]!.split('(')[0]!.trim();
    const mapped = this.dimensionTypeMappings[base];
    if (mapped) return mapped;
    if (base.includes('timestamp') || base.includes('date')) return 'time';
    if (base.includes('int') || base.includes('float') || base.includes('double') || base.includes('decimal') || base.includes('real')) return 'number';
    if (base.includes('bool')) return 'boolean';
    return 'string';
  }

  generateSampleQuery(tableName: string, limit: number, columns?: string[]): string {
    const columnList =
      columns && columns.length > 0 ? columns.map((c) => this.quoteIdentifier(c)).join(', ') : '*';
    return `SELECT ${columnList} FROM ${tableName} LIMIT ${limit}`;
  }

  generateColumnSampleQuery(tableName: string, columnName: string, limit: number): string {
    const quoted = this.quoteIdentifier(columnName);
    return `SELECT ${quoted} FROM ${tableName} WHERE ${quoted} IS NOT NULL LIMIT ${limit}`;
  }

  generateCardinalitySampleQuery(tableName: string, columnName: string, sampleSize: number): string {
    return `
      SELECT approx_distinct(${columnName}) AS cardinality
      FROM (
        SELECT ${columnName}
        FROM ${tableName}
        WHERE ${columnName} IS NOT NULL
        LIMIT ${sampleSize}
      )
    `;
  }

  generateRandomizedCardinalitySampleQuery(tableName: string, columnName: string, sampleSize: number): string {
    return `
      SELECT approx_distinct(${columnName}) AS cardinality
      FROM (
        SELECT ${columnName}
        FROM ${tableName}
        WHERE ${columnName} IS NOT NULL
        ORDER BY rand()
        LIMIT ${sampleSize}
      )
    `;
  }

  generateDistinctValuesQuery(tableName: string, columnName: string, limit: number): string {
    return `
      SELECT DISTINCT CAST(${columnName} AS VARCHAR) AS val
      FROM ${tableName}
      WHERE ${columnName} IS NOT NULL
      ORDER BY val
      LIMIT ${limit}
    `;
  }

  generateColumnStatisticsQuery(_schemaName: string, _tableName: string): string | null {
    return null;
  }

  getNullCountExpression(column: string): string {
    return `COUNT_IF(${column} IS NULL)`;
  }

  getDistinctCountExpression(column: string): string {
    return `approx_distinct(${column})`;
  }

  textLengthExpression(columnSql: string): string {
    return `LENGTH(CAST(${columnSql} AS VARCHAR))`;
  }

  castToText(columnSql: string): string {
    return `CAST(${columnSql} AS VARCHAR)`;
  }

  getSampleValueAggregation(innerSql: string): string {
    return `(SELECT array_join(array_agg(CAST(value AS VARCHAR)), '\u001f') FROM (${innerSql}) AS relationship_profile_values)`;
  }

  getLimitOffsetClause(limit: number, offset?: number): string {
    const safeLimit = Math.max(1, Math.floor(limit));
    const safeOffset = offset !== undefined ? Math.floor(offset) : 0;
    return safeOffset > 0 ? `OFFSET ${safeOffset} LIMIT ${safeLimit}` : `LIMIT ${safeLimit}`;
  }

  getTopClause(_limit: number): string {
    return '';
  }

  getTableSampleClause(_samplePct: number): string {
    return '';
  }

  getRandomSampleFilter(samplePct: number): string {
    if (samplePct <= 0 || samplePct >= 1) return '';
    return `rand() < ${samplePct}`;
  }
}
