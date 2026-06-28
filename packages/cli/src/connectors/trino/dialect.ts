import type { KtxDialect } from '../../context/connections/dialects.js';
import {
  columnDisplayPartCount,
  formatDialectDisplayRef,
  formatDialectTableName,
  limitOffsetClause,
  parseDialectDisplayRef,
} from '../../context/connections/dialect-helpers.js';
import type { KtxSchemaDimensionType, KtxTableRef } from '../../context/scan/types.js';

type TrinoTableNameRef = Pick<KtxTableRef, 'name'> & Partial<Pick<KtxTableRef, 'catalog' | 'db'>>;

/**
 * Trino is fully qualified as `catalog.schema.table`, so it uses the
 * `three-part` identifier shape (unlike Snowflake/BigQuery which surface as
 * two-part display refs). Identifiers are ANSI double-quoted; SQL is ANSI
 * standard with `TABLESAMPLE BERNOULLI` for sampling.
 *
 * @internal
 */
export class KtxTrinoDialect implements KtxDialect {
  readonly type = 'trino' as const;

  private readonly typeMappings: Record<string, KtxSchemaDimensionType> = {
    boolean: 'boolean',
    tinyint: 'number',
    smallint: 'number',
    integer: 'number',
    int: 'number',
    bigint: 'number',
    real: 'number',
    double: 'number',
    decimal: 'number',
    varchar: 'string',
    char: 'string',
    varbinary: 'string',
    json: 'string',
    uuid: 'string',
    ipaddress: 'string',
    date: 'time',
    time: 'time',
    timestamp: 'time',
  };

  quoteIdentifier(identifier: string): string {
    return `"${identifier.replace(/"/g, '""')}"`;
  }

  formatTableName(table: TrinoTableNameRef): string {
    return formatDialectTableName(table, this.quoteIdentifier.bind(this), 'three-part');
  }

  formatDisplayRef(table: TrinoTableNameRef): string {
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
    // Strip parameters/array/row wrappers: `decimal(10,2)` -> `decimal`,
    // `array(varchar)` -> `array`, `timestamp(3) with time zone` -> `timestamp`.
    const base = nativeType.toLowerCase().trim().split('(')[0]?.split(' ')[0] ?? '';
    if (this.typeMappings[base]) {
      return this.typeMappings[base];
    }
    if (base.includes('timestamp') || base.includes('date') || base.includes('time')) {
      return 'time';
    }
    if (base.includes('int') || base.includes('decimal') || base === 'double' || base === 'real') {
      return 'number';
    }
    if (base === 'boolean') {
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
    return `SELECT ${quotedColumn} FROM ${tableName} WHERE ${quotedColumn} IS NOT NULL LIMIT ${limit}`;
  }

  getRandomSampleFilter(samplePct: number): string {
    if (samplePct <= 0 || samplePct >= 1) {
      return '';
    }
    return `rand() < ${samplePct}`;
  }

  getTableSampleClause(samplePct: number): string {
    if (samplePct <= 0 || samplePct >= 1) {
      return '';
    }
    return `TABLESAMPLE BERNOULLI (${Math.min(100, Math.max(0, samplePct * 100))})`;
  }

  getLimitOffsetClause(limit: number, offset?: number): string {
    return limitOffsetClause(limit, offset);
  }

  getTopClause(_limit: number): string {
    return '';
  }

  getNullCountExpression(column: string): string {
    return `count_if(${column} IS NULL)`;
  }

  getDistinctCountExpression(column: string): string {
    return `COUNT(DISTINCT ${column})`;
  }

  textLengthExpression(columnSql: string): string {
    return `length(CAST(${columnSql} AS VARCHAR))`;
  }

  castToText(columnSql: string): string {
    return `CAST(${columnSql} AS VARCHAR)`;
  }

  getSampleValueAggregation(innerSql: string): string {
    return `(SELECT array_join(array_agg(CAST(value AS VARCHAR)), '\\x1F') FROM (${innerSql}) AS relationship_profile_values)`;
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
}
