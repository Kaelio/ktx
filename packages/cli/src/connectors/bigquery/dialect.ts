import type { KtxSqlDialect } from '../../context/connections/dialects.js';
import {
  columnDisplayPartCount,
  formatDialectDisplayRef,
  formatDialectTableName,
  limitOffsetClause,
  parseDialectDisplayRef,
} from '../../context/connections/dialect-helpers.js';
import type { KtxSchemaDimensionType, KtxTableRef } from '../../context/scan/types.js';

type BigQueryTableNameRef = Pick<KtxTableRef, 'name'> & Partial<Pick<KtxTableRef, 'catalog' | 'db'>>;

/** @internal */
export class KtxBigQueryDialect implements KtxSqlDialect {
  readonly type = 'bigquery' as const;

  private readonly typeMappings: Record<string, KtxSchemaDimensionType> = {
    TIMESTAMP: 'time',
    DATETIME: 'time',
    DATE: 'time',
    TIME: 'time',
    INT64: 'number',
    INTEGER: 'number',
    FLOAT64: 'number',
    FLOAT: 'number',
    NUMERIC: 'number',
    BIGNUMERIC: 'number',
    STRING: 'string',
    BYTES: 'string',
    BOOL: 'boolean',
    BOOLEAN: 'boolean',
  };

  quoteIdentifier(identifier: string): string {
    return `\`${identifier.replace(/`/g, '\\`')}\``;
  }

  formatTableName(table: BigQueryTableNameRef): string {
    return formatDialectTableName(table, this.quoteIdentifier.bind(this), 'three-part');
  }

  formatDisplayRef(table: BigQueryTableNameRef): string {
    return formatDialectDisplayRef(table, 'three-part');
  }

  parseDisplayRef(display: string): KtxTableRef | null {
    return parseDialectDisplayRef(display, 'three-part');
  }

  columnDisplayTablePartCount(): 1 | 2 | 3 {
    return columnDisplayPartCount('three-part');
  }

  mapDataType(nativeType: string): string {
    const fieldType = nativeType.toUpperCase().trim();
    if (fieldType === 'RECORD' || fieldType === 'STRUCT') {
      return 'JSON';
    }
    const typeMapping: Record<string, string> = {
      STRING: 'VARCHAR',
      BYTES: 'VARBINARY',
      INTEGER: 'BIGINT',
      INT64: 'BIGINT',
      FLOAT: 'DOUBLE',
      FLOAT64: 'DOUBLE',
      NUMERIC: 'DECIMAL',
      BIGNUMERIC: 'DECIMAL',
      BOOLEAN: 'BOOLEAN',
      BOOL: 'BOOLEAN',
      TIMESTAMP: 'TIMESTAMP',
      DATE: 'DATE',
      TIME: 'TIME',
      DATETIME: 'DATETIME',
      GEOGRAPHY: 'GEOGRAPHY',
      JSON: 'JSON',
    };
    return typeMapping[fieldType] || fieldType;
  }

  mapToDimensionType(nativeType: string): KtxSchemaDimensionType {
    if (!nativeType) {
      return 'string';
    }
    const normalizedType = nativeType.toUpperCase().trim();
    if (this.typeMappings[normalizedType]) {
      return this.typeMappings[normalizedType];
    }
    if (normalizedType.includes('TIME') || normalizedType.includes('DATE')) {
      return 'time';
    }
    if (normalizedType.includes('INT') || normalizedType.includes('NUM') || normalizedType.includes('FLOAT')) {
      return 'number';
    }
    if (normalizedType.includes('BOOL')) {
      return 'boolean';
    }
    return 'string';
  }

  generateSampleQuery(tableName: string, limit: number, columns?: string[]): string {
    const columnList =
      columns && columns.length > 0 ? columns.map((column) => this.quoteIdentifier(column)).join(', ') : '*';
    return `SELECT ${columnList} FROM ${tableName} ORDER BY RAND() LIMIT ${limit}`;
  }

  generateColumnSampleQuery(tableName: string, columnName: string, limit: number): string {
    const quotedColumn = this.quoteIdentifier(columnName);
    return `SELECT ${quotedColumn} FROM ${tableName} WHERE ${quotedColumn} IS NOT NULL AND TRIM(CAST(${quotedColumn} AS STRING)) != '' ORDER BY RAND() LIMIT ${limit}`;
  }

  getRandomSampleFilter(samplePct: number): string {
    if (samplePct <= 0 || samplePct >= 1) {
      return '';
    }
    return `RAND() < ${samplePct}`;
  }

  getTableSampleClause(samplePct: number): string {
    if (samplePct <= 0 || samplePct >= 1) {
      return '';
    }
    return `TABLESAMPLE SYSTEM (${samplePct * 100} PERCENT)`;
  }

  getLimitOffsetClause(limit: number, offset?: number): string {
    return limitOffsetClause(limit, offset);
  }

  getTopClause(_limit: number): string {
    return '';
  }

  getNullCountExpression(column: string): string {
    return `COUNTIF(${column} IS NULL)`;
  }

  getDistinctCountExpression(column: string): string {
    return `APPROX_COUNT_DISTINCT(${column})`;
  }

  textLengthExpression(columnSql: string): string {
    return `LENGTH(CAST(${columnSql} AS STRING))`;
  }

  castToText(columnSql: string): string {
    return `CAST(${columnSql} AS STRING)`;
  }

  getSampleValueAggregation(innerSql: string): string {
    return `(SELECT STRING_AGG(CAST(value AS STRING), '\\u001F') FROM (${innerSql}) AS relationship_profile_values)`;
  }

  generateCardinalitySampleQuery(tableName: string, columnName: string, sampleSize: number): string {
    return `
      WITH sampled AS (
        SELECT ${columnName} AS val
        FROM ${tableName}
        WHERE ${columnName} IS NOT NULL
        LIMIT ${sampleSize}
      )
      SELECT APPROX_COUNT_DISTINCT(val) AS cardinality
      FROM sampled
    `;
  }

  generateDistinctValuesQuery(tableName: string, columnName: string, limit: number): string {
    return `
      SELECT DISTINCT CAST(${columnName} AS STRING) AS val
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
        ORDER BY RAND()
        LIMIT ${sampleSize}
      )
      SELECT APPROX_COUNT_DISTINCT(val) AS cardinality
      FROM sampled
    `;
  }
}
