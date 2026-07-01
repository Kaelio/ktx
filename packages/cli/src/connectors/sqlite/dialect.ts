import type { KtxSqlDialect } from '../../context/connections/dialects.js';
import {
  columnDisplayPartCount,
  formatDialectDisplayRef,
  formatDialectTableName,
  limitOffsetClause,
  parseDialectDisplayRef,
} from '../../context/connections/dialect-helpers.js';
import type { KtxSchemaDimensionType, KtxTableRef } from '../../context/scan/types.js';

type SqliteTableNameRef = Pick<KtxTableRef, 'name'> & Partial<Pick<KtxTableRef, 'catalog' | 'db'>>;

/** @internal */
export class KtxSqliteDialect implements KtxSqlDialect {
  readonly type = 'sqlite' as const;

  private readonly typeMappings: Record<string, KtxSchemaDimensionType> = {
    DATETIME: 'time',
    DATE: 'time',
    TIMESTAMP: 'time',
    TIME: 'time',
    INTEGER: 'number',
    INT: 'number',
    REAL: 'number',
    NUMERIC: 'number',
    FLOAT: 'number',
    DOUBLE: 'number',
    TEXT: 'string',
    VARCHAR: 'string',
    CHAR: 'string',
    BLOB: 'string',
    BOOLEAN: 'boolean',
    BOOL: 'boolean',
  };

  quoteIdentifier(identifier: string): string {
    return `"${identifier.replace(/"/g, '""')}"`;
  }

  formatTableName(table: SqliteTableNameRef): string {
    return formatDialectTableName(table, this.quoteIdentifier.bind(this), 'sqlite');
  }

  formatDisplayRef(table: SqliteTableNameRef): string {
    return formatDialectDisplayRef(table, 'sqlite');
  }

  parseDisplayRef(display: string): KtxTableRef | null {
    return parseDialectDisplayRef(display, 'sqlite');
  }

  columnDisplayTablePartCount(): 1 | 2 | 3 {
    return columnDisplayPartCount('sqlite');
  }

  mapDataType(nativeType: string): string {
    return nativeType;
  }

  mapToDimensionType(nativeType: string): KtxSchemaDimensionType {
    if (!nativeType) {
      return 'string';
    }
    let normalized = nativeType.toUpperCase().trim();
    if (normalized.includes('(')) {
      normalized = normalized.split('(')[0];
    }
    if (this.typeMappings[normalized]) {
      return this.typeMappings[normalized];
    }
    if (normalized.includes('TIME') || normalized.includes('DATE')) {
      return 'time';
    }
    if (
      normalized.includes('INT') ||
      normalized.includes('NUM') ||
      normalized.includes('REAL') ||
      normalized.includes('FLOAT') ||
      normalized.includes('DOUBLE')
    ) {
      return 'number';
    }
    if (normalized.includes('BOOL')) {
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
    const quoted = this.quoteIdentifier(columnName);
    return `SELECT ${quoted} FROM ${tableName} WHERE ${quoted} IS NOT NULL AND TRIM(CAST(${quoted} AS TEXT)) != '' LIMIT ${limit}`;
  }

  getRandomSampleFilter(samplePct: number): string {
    if (samplePct <= 0 || samplePct >= 1) {
      return '';
    }
    return `(RANDOM() % 100) < ${Math.round(samplePct * 100)}`;
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
    return `SUM(CASE WHEN ${column} IS NULL THEN 1 ELSE 0 END)`;
  }

  getDistinctCountExpression(column: string): string {
    return `COUNT(DISTINCT ${column})`;
  }

  textLengthExpression(columnSql: string): string {
    return `LENGTH(CAST(${columnSql} AS TEXT))`;
  }

  castToText(columnSql: string): string {
    return `CAST(${columnSql} AS TEXT)`;
  }

  getSampleValueAggregation(innerSql: string): string {
    return `(SELECT GROUP_CONCAT(CAST(value AS TEXT), char(31)) FROM (${innerSql}) AS relationship_profile_values)`;
  }

  generateCardinalitySampleQuery(tableName: string, columnName: string, sampleSize: number): string {
    return `
      WITH sampled AS (
        SELECT ${columnName} AS val
        FROM ${tableName}
        WHERE ${columnName} IS NOT NULL
        LIMIT ${sampleSize}
      )
      SELECT COUNT(DISTINCT val) AS cardinality
      FROM sampled
    `;
  }

  generateDistinctValuesQuery(tableName: string, columnName: string, limit: number): string {
    return `
      SELECT DISTINCT CAST(${columnName} AS TEXT) AS val
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
      WITH sampled AS (
        SELECT ${columnName} AS val
        FROM ${tableName}
        WHERE ${columnName} IS NOT NULL
        ORDER BY RANDOM()
        LIMIT ${sampleSize}
      )
      SELECT COUNT(DISTINCT val) AS cardinality
      FROM sampled
    `;
  }
}
