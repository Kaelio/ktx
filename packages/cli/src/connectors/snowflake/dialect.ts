import type { KtxSqlDialect } from '../../context/connections/dialects.js';
import {
  columnDisplayPartCount,
  formatDialectDisplayRef,
  formatDialectTableName,
  limitOffsetClause,
  parseDialectDisplayRef,
} from '../../context/connections/dialect-helpers.js';
import type { KtxSchemaDimensionType, KtxTableRef } from '../../context/scan/types.js';

type SnowflakeTableNameRef = Pick<KtxTableRef, 'name'> & Partial<Pick<KtxTableRef, 'catalog' | 'db'>>;

/** @internal */
export class KtxSnowflakeDialect implements KtxSqlDialect {
  readonly type = 'snowflake' as const;

  private readonly typeMappings: Record<string, KtxSchemaDimensionType> = {
    TIMESTAMP_NTZ: 'time',
    TIMESTAMP_LTZ: 'time',
    TIMESTAMP_TZ: 'time',
    TIMESTAMP: 'time',
    DATE: 'time',
    TIME: 'time',
    NUMBER: 'number',
    DECIMAL: 'number',
    NUMERIC: 'number',
    INT: 'number',
    INTEGER: 'number',
    BIGINT: 'number',
    SMALLINT: 'number',
    TINYINT: 'number',
    BYTEINT: 'number',
    FLOAT: 'number',
    FLOAT4: 'number',
    FLOAT8: 'number',
    DOUBLE: 'number',
    'DOUBLE PRECISION': 'number',
    REAL: 'number',
    VARCHAR: 'string',
    CHAR: 'string',
    CHARACTER: 'string',
    STRING: 'string',
    TEXT: 'string',
    BINARY: 'string',
    VARBINARY: 'string',
    BOOLEAN: 'boolean',
    VARIANT: 'string',
    OBJECT: 'string',
    ARRAY: 'string',
  };

  quoteIdentifier(identifier: string): string {
    return `"${identifier.replace(/"/g, '""')}"`;
  }

  formatTableName(table: SnowflakeTableNameRef): string {
    return formatDialectTableName(table, this.quoteIdentifier.bind(this), 'three-part');
  }

  formatDisplayRef(table: SnowflakeTableNameRef): string {
    return formatDialectDisplayRef(table, 'three-part');
  }

  parseDisplayRef(display: string): KtxTableRef | null {
    return parseDialectDisplayRef(display, 'three-part');
  }

  columnDisplayTablePartCount(): 1 | 2 | 3 {
    return columnDisplayPartCount('three-part');
  }

  mapDataType(nativeType: string): string {
    return nativeType;
  }

  mapToDimensionType(nativeType: string): KtxSchemaDimensionType {
    if (!nativeType) {
      return 'string';
    }
    const upper = nativeType.toUpperCase().trim();
    const normalized = upper.includes('(') ? upper.split('(')[0]! : upper;
    if (this.typeMappings[normalized]) {
      return this.typeMappings[normalized];
    }
    if (normalized.includes('TIME') || normalized.includes('DATE')) {
      return 'time';
    }
    if (
      normalized.includes('INT') ||
      normalized.includes('NUM') ||
      normalized.includes('DEC') ||
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
    return `SELECT ${columnList} FROM ${tableName} SAMPLE ROW (${limit} ROWS)`;
  }

  generateColumnSampleQuery(tableName: string, columnName: string, limit: number): string {
    const quotedColumn = this.quoteIdentifier(columnName);
    return `SELECT ${quotedColumn} FROM ${tableName} WHERE ${quotedColumn} IS NOT NULL AND TRIM(CAST(${quotedColumn} AS STRING)) != '' LIMIT ${limit}`;
  }

  getRandomSampleFilter(samplePct: number): string {
    if (samplePct <= 0 || samplePct >= 1) {
      return '';
    }
    return `UNIFORM(0::FLOAT, 1::FLOAT, RANDOM()) < ${samplePct}`;
  }

  getTableSampleClause(samplePct: number): string {
    if (samplePct <= 0 || samplePct >= 1) {
      return '';
    }
    return `SAMPLE (${samplePct * 100})`;
  }

  getLimitOffsetClause(limit: number, offset?: number): string {
    return limitOffsetClause(limit, offset);
  }

  getTopClause(_limit: number): string {
    return '';
  }

  getNullCountExpression(column: string): string {
    return `COUNT_IF(${column} IS NULL)`;
  }

  getDistinctCountExpression(column: string): string {
    return `APPROX_COUNT_DISTINCT(${column})`;
  }

  textLengthExpression(columnSql: string): string {
    return `LENGTH(CAST(${columnSql} AS TEXT))`;
  }

  castToText(columnSql: string): string {
    return `CAST(${columnSql} AS VARCHAR)`;
  }

  getSampleValueAggregation(innerSql: string): string {
    return `(SELECT LISTAGG(CAST(value AS VARCHAR), '\\x1f') FROM (${innerSql}) AS relationship_profile_values)`;
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
      SELECT DISTINCT ${columnName}::VARCHAR AS val
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
        FROM ${tableName} SAMPLE ROW (${sampleSize} ROWS)
        WHERE ${columnName} IS NOT NULL
      )
      SELECT COUNT(DISTINCT val) AS cardinality
      FROM sampled
    `;
  }
}
