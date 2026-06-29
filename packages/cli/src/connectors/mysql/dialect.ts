import type { KtxSqlDialect } from '../../context/connections/dialects.js';
import {
  columnDisplayPartCount,
  formatDialectDisplayRef,
  formatDialectTableName,
  limitOffsetClause,
  parseDialectDisplayRef,
} from '../../context/connections/dialect-helpers.js';
import type { KtxSchemaDimensionType, KtxTableRef } from '../../context/scan/types.js';

type MysqlTableNameRef = Pick<KtxTableRef, 'name'> & Partial<Pick<KtxTableRef, 'catalog' | 'db'>>;

/** @internal */
export class KtxMysqlDialect implements KtxSqlDialect {
  readonly type = 'mysql' as const;

  private readonly typeMappings: Record<string, KtxSchemaDimensionType> = {
    datetime: 'time',
    timestamp: 'time',
    date: 'time',
    time: 'time',
    year: 'time',
    tinyint: 'number',
    smallint: 'number',
    mediumint: 'number',
    int: 'number',
    integer: 'number',
    bigint: 'number',
    decimal: 'number',
    numeric: 'number',
    float: 'number',
    double: 'number',
    real: 'number',
    varchar: 'string',
    char: 'string',
    text: 'string',
    tinytext: 'string',
    mediumtext: 'string',
    longtext: 'string',
    enum: 'string',
    set: 'string',
    json: 'string',
    bit: 'boolean',
    bool: 'boolean',
    boolean: 'boolean',
  };

  quoteIdentifier(identifier: string): string {
    return `\`${identifier.replace(/`/g, '``')}\``;
  }

  formatTableName(table: MysqlTableNameRef): string {
    return formatDialectTableName(table, this.quoteIdentifier.bind(this), 'ansi');
  }

  formatDisplayRef(table: MysqlTableNameRef): string {
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
    const lower = nativeType.toLowerCase().trim();
    if (lower.includes('tinyint(1)')) {
      return 'boolean';
    }
    const normalized = lower.includes('(') ? lower.split('(')[0] : lower;
    if (this.typeMappings[normalized]) {
      return this.typeMappings[normalized];
    }
    if (normalized.includes('time') || normalized.includes('date')) {
      return 'time';
    }
    if (
      normalized.includes('int') ||
      normalized.includes('num') ||
      normalized.includes('dec') ||
      normalized.includes('float') ||
      normalized.includes('double')
    ) {
      return 'number';
    }
    if (normalized.includes('bit') || normalized === 'bool' || normalized === 'boolean') {
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
    return `SELECT ${quotedColumn} FROM ${tableName} WHERE ${quotedColumn} IS NOT NULL AND TRIM(CAST(${quotedColumn} AS CHAR)) != '' LIMIT ${limit}`;
  }

  getRandomSampleFilter(samplePct: number): string {
    if (samplePct <= 0 || samplePct >= 1) {
      return '';
    }
    return `RAND() < ${samplePct}`;
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
    return `CHAR_LENGTH(CAST(${columnSql} AS CHAR))`;
  }

  castToText(columnSql: string): string {
    return `CAST(${columnSql} AS CHAR)`;
  }

  getSampleValueAggregation(innerSql: string): string {
    return `(SELECT GROUP_CONCAT(CAST(value AS CHAR) SEPARATOR CHAR(31)) FROM (${innerSql}) AS relationship_profile_values)`;
  }

  generateCardinalitySampleQuery(tableName: string, columnName: string, sampleSize: number): string {
    return `
      SELECT COUNT(DISTINCT val) AS cardinality
      FROM (
        SELECT ${columnName} AS val
        FROM ${tableName}
        WHERE ${columnName} IS NOT NULL
        LIMIT ${sampleSize}
      ) AS sampled
    `;
  }

  generateDistinctValuesQuery(tableName: string, columnName: string, limit: number): string {
    return `
      SELECT DISTINCT CAST(${columnName} AS CHAR) AS val
      FROM ${tableName}
      WHERE ${columnName} IS NOT NULL
      ORDER BY val
      LIMIT ${limit}
    `;
  }

  generateColumnStatisticsQuery(schemaName: string, tableName: string): string | null {
    return `
      SELECT
        COLUMN_NAME AS column_name,
        MAX(CARDINALITY) AS estimated_cardinality
      FROM INFORMATION_SCHEMA.STATISTICS
      WHERE TABLE_SCHEMA = '${schemaName.replace(/'/g, "''")}'
        AND TABLE_NAME = '${tableName.replace(/'/g, "''")}'
        AND CARDINALITY IS NOT NULL
        AND SEQ_IN_INDEX = 1
      GROUP BY COLUMN_NAME
    `;
  }

  generateRandomizedCardinalitySampleQuery(tableName: string, columnName: string, sampleSize: number): string {
    return `
      SELECT COUNT(DISTINCT val) AS cardinality
      FROM (
        SELECT ${columnName} AS val
        FROM ${tableName}
        WHERE ${columnName} IS NOT NULL
        ORDER BY RAND()
        LIMIT ${sampleSize}
      ) AS sampled
    `;
  }
}
