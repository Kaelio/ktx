import type { KtxSqlDialect } from '../../context/connections/dialects.js';
import {
  columnDisplayPartCount,
  formatDialectDisplayRef,
  formatDialectTableName,
  limitOffsetClause,
  parseDialectDisplayRef,
} from '../../context/connections/dialect-helpers.js';
import type { KtxSchemaDimensionType, KtxTableRef } from '../../context/scan/types.js';

type DatabricksTableNameRef = Pick<KtxTableRef, 'name'> & Partial<Pick<KtxTableRef, 'catalog' | 'db'>>;

/** @internal */
export class KtxDatabricksDialect implements KtxSqlDialect {
  readonly type = 'databricks' as const;

  private readonly typeMappings: Record<string, KtxSchemaDimensionType> = {
    TIMESTAMP: 'time',
    TIMESTAMP_NTZ: 'time',
    DATE: 'time',
    TINYINT: 'number',
    SMALLINT: 'number',
    INT: 'number',
    INTEGER: 'number',
    BIGINT: 'number',
    FLOAT: 'number',
    DOUBLE: 'number',
    DECIMAL: 'number',
    NUMERIC: 'number',
    STRING: 'string',
    CHAR: 'string',
    VARCHAR: 'string',
    BINARY: 'string',
    BOOLEAN: 'boolean',
    BOOL: 'boolean',
    ARRAY: 'string',
    MAP: 'string',
    STRUCT: 'string',
    VARIANT: 'string',
  };

  quoteIdentifier(identifier: string): string {
    return `\`${identifier.replace(/`/g, '``')}\``;
  }

  formatTableName(table: DatabricksTableNameRef): string {
    return formatDialectTableName(table, this.quoteIdentifier.bind(this), 'three-part');
  }

  formatDisplayRef(table: DatabricksTableNameRef): string {
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
    const normalized = upper.split(/[<(]/)[0]!.trim();
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
    return `SELECT ${columnList} FROM ${tableName} LIMIT ${limit}`;
  }

  generateColumnSampleQuery(tableName: string, columnName: string, limit: number): string {
    const quotedColumn = this.quoteIdentifier(columnName);
    return `SELECT ${quotedColumn} FROM ${tableName} WHERE ${quotedColumn} IS NOT NULL AND TRIM(CAST(${quotedColumn} AS STRING)) != '' LIMIT ${limit}`;
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
    return `TABLESAMPLE (${samplePct * 100} PERCENT)`;
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
    return `LENGTH(CAST(${columnSql} AS STRING))`;
  }

  castToText(columnSql: string): string {
    return `CAST(${columnSql} AS STRING)`;
  }

  getSampleValueAggregation(innerSql: string): string {
    return `(SELECT CONCAT_WS('\\u001F', COLLECT_LIST(CAST(value AS STRING))) FROM (${innerSql}) AS relationship_profile_values)`;
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
