import type { KtxSqlDialect } from '../../context/connections/dialects.js';
import {
  columnDisplayPartCount,
  formatDialectDisplayRef,
  formatDialectTableName,
  parseDialectDisplayRef,
  safeSqlLimit,
} from '../../context/connections/dialect-helpers.js';
import type { KtxSchemaDimensionType, KtxTableRef } from '../../context/scan/types.js';

type SqlServerTableNameRef = Pick<KtxTableRef, 'name'> & Partial<Pick<KtxTableRef, 'catalog' | 'db'>>;

/** @internal */
export class KtxSqlServerDialect implements KtxSqlDialect {
  readonly type = 'sqlserver' as const;

  private readonly typeMappings: Record<string, KtxSchemaDimensionType> = {
    datetime: 'time',
    datetime2: 'time',
    date: 'time',
    time: 'time',
    datetimeoffset: 'time',
    smalldatetime: 'time',
    timestamp: 'time',
    int: 'number',
    bigint: 'number',
    smallint: 'number',
    tinyint: 'number',
    decimal: 'number',
    numeric: 'number',
    float: 'number',
    real: 'number',
    money: 'number',
    smallmoney: 'number',
    varchar: 'string',
    nvarchar: 'string',
    char: 'string',
    nchar: 'string',
    text: 'string',
    ntext: 'string',
    uniqueidentifier: 'string',
    xml: 'string',
    bit: 'boolean',
  };

  quoteIdentifier(identifier: string): string {
    return `[${identifier.replace(/\]/g, ']]')}]`;
  }

  formatTableName(table: SqlServerTableNameRef): string {
    return formatDialectTableName(table, this.quoteIdentifier.bind(this), 'three-part');
  }

  formatDisplayRef(table: SqlServerTableNameRef): string {
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
    const lower = nativeType.toLowerCase().trim();
    const normalized = lower.includes('(') ? lower.split('(')[0]! : lower;
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
      normalized.includes('money')
    ) {
      return 'number';
    }
    if (normalized.includes('bit')) {
      return 'boolean';
    }
    return 'string';
  }

  generateSampleQuery(tableName: string, limit: number, columns?: string[]): string {
    const columnList =
      columns && columns.length > 0 ? columns.map((column) => this.quoteIdentifier(column)).join(', ') : '*';
    return `SELECT TOP ${limit} ${columnList} FROM ${tableName}`;
  }

  generateColumnSampleQuery(tableName: string, columnName: string, limit: number): string {
    const quotedColumn = this.quoteIdentifier(columnName);
    return `SELECT TOP ${limit} ${quotedColumn} FROM ${tableName} WHERE ${quotedColumn} IS NOT NULL AND LTRIM(RTRIM(CAST(${quotedColumn} AS NVARCHAR(MAX)))) != ''`;
  }

  getRandomSampleFilter(samplePct: number): string {
    if (samplePct <= 0 || samplePct >= 1) {
      return '';
    }
    return `ABS(CHECKSUM(NEWID())) % 100 < ${Math.round(samplePct * 100)}`;
  }

  getTableSampleClause(samplePct: number): string {
    if (samplePct <= 0 || samplePct >= 1) {
      return '';
    }
    return `TABLESAMPLE (${samplePct * 100} PERCENT)`;
  }

  getLimitOffsetClause(_limit: number, _offset?: number): string {
    return '';
  }

  getTopClause(limit: number): string {
    return `TOP (${safeSqlLimit(limit)})`;
  }

  getNullCountExpression(column: string): string {
    return `SUM(CASE WHEN ${column} IS NULL THEN 1 ELSE 0 END)`;
  }

  getDistinctCountExpression(column: string): string {
    return `COUNT(DISTINCT ${column})`;
  }

  textLengthExpression(columnSql: string): string {
    return `LEN(CAST(${columnSql} AS NVARCHAR(MAX)))`;
  }

  castToText(columnSql: string): string {
    return `CAST(${columnSql} AS NVARCHAR(MAX))`;
  }

  getSampleValueAggregation(innerSql: string): string {
    return `(SELECT STRING_AGG(CAST(value AS NVARCHAR(MAX)), CHAR(31)) FROM (${innerSql}) AS relationship_profile_values)`;
  }

  generateCardinalitySampleQuery(tableName: string, columnName: string, sampleSize: number): string {
    return `
      WITH sampled AS (
        SELECT TOP ${sampleSize} ${columnName} AS val
        FROM ${tableName}
        WHERE ${columnName} IS NOT NULL
      )
      SELECT COUNT(DISTINCT val) AS cardinality
      FROM sampled
    `;
  }

  generateDistinctValuesQuery(tableName: string, columnName: string, limit: number): string {
    return `
      SELECT TOP ${limit} val
      FROM (
        SELECT DISTINCT CAST(${columnName} AS NVARCHAR(MAX)) AS val
        FROM ${tableName}
        WHERE ${columnName} IS NOT NULL
      ) AS distinct_vals
      ORDER BY val
    `;
  }

  generateColumnStatisticsQuery(_schemaName: string, _tableName: string): string | null {
    return null;
  }

  generateRandomizedCardinalitySampleQuery(tableName: string, columnName: string, sampleSize: number): string {
    return `
      WITH sampled AS (
        SELECT TOP ${sampleSize} ${columnName} AS val
        FROM ${tableName}
        WHERE ${columnName} IS NOT NULL
        ORDER BY NEWID()
      )
      SELECT COUNT(DISTINCT val) AS cardinality
      FROM sampled
    `;
  }
}
