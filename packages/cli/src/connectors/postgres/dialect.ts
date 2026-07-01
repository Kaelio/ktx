import type { KtxSqlDialect } from '../../context/connections/dialects.js';
import {
  columnDisplayPartCount,
  formatDialectDisplayRef,
  formatDialectTableName,
  limitOffsetClause,
  parseDialectDisplayRef,
} from '../../context/connections/dialect-helpers.js';
import type { KtxSchemaDimensionType, KtxTableRef } from '../../context/scan/types.js';

type PostgresTableNameRef = Pick<KtxTableRef, 'name'> & Partial<Pick<KtxTableRef, 'catalog' | 'db'>>;

/** @internal */
export class KtxPostgresDialect implements KtxSqlDialect {
  readonly type = 'postgres' as const;

  private readonly typeMappings: Record<string, KtxSchemaDimensionType> = {
    timestamp: 'time',
    'timestamp without time zone': 'time',
    'timestamp with time zone': 'time',
    timestamptz: 'time',
    datetime: 'time',
    date: 'time',
    time: 'time',
    integer: 'number',
    int: 'number',
    int2: 'number',
    int4: 'number',
    int8: 'number',
    bigint: 'number',
    smallint: 'number',
    decimal: 'number',
    numeric: 'number',
    float: 'number',
    float4: 'number',
    float8: 'number',
    'double precision': 'number',
    real: 'number',
    money: 'number',
    text: 'string',
    varchar: 'string',
    'character varying': 'string',
    char: 'string',
    character: 'string',
    uuid: 'string',
    json: 'string',
    jsonb: 'string',
    boolean: 'boolean',
    bool: 'boolean',
  };

  quoteIdentifier(identifier: string): string {
    return `"${identifier.replace(/"/g, '""')}"`;
  }

  formatTableName(table: PostgresTableNameRef): string {
    return formatDialectTableName(table, this.quoteIdentifier.bind(this), 'ansi');
  }

  formatDisplayRef(table: PostgresTableNameRef): string {
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
    const normalized = lower.includes('(') ? lower.split('(')[0]!.trim() : lower;
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
    if (normalized.includes('bool')) {
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
    return `SELECT ${quotedColumn} FROM ${tableName} WHERE ${quotedColumn} IS NOT NULL AND TRIM(CAST(${quotedColumn} AS TEXT)) != '' LIMIT ${limit}`;
  }

  getRandomSampleFilter(samplePct: number): string {
    if (samplePct <= 0 || samplePct >= 1) {
      return '';
    }
    return `RANDOM() < ${samplePct}`;
  }

  getTableSampleClause(samplePct: number): string {
    if (samplePct <= 0 || samplePct >= 1) {
      return '';
    }
    return `TABLESAMPLE SYSTEM (${samplePct * 100})`;
  }

  getLimitOffsetClause(limit: number, offset?: number): string {
    return limitOffsetClause(limit, offset);
  }

  getTopClause(_limit: number): string {
    return '';
  }

  getNullCountExpression(column: string): string {
    return `COUNT(*) FILTER (WHERE ${column} IS NULL)`;
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
    return `(SELECT STRING_AGG(CAST(value AS TEXT), CHR(31)) FROM (${innerSql}) AS relationship_profile_values)`;
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
      SELECT DISTINCT ${columnName}::text AS val
      FROM ${tableName}
      WHERE ${columnName} IS NOT NULL
      ORDER BY val
      LIMIT ${limit}
    `;
  }

  generateColumnStatisticsQuery(schemaName: string, tableName: string): string | null {
    return `
      SELECT
        s.attname AS column_name,
        CASE
          WHEN s.n_distinct > 0 THEN s.n_distinct::bigint
          WHEN s.n_distinct < 0 THEN (-s.n_distinct * c.reltuples)::bigint
          ELSE NULL
        END AS estimated_cardinality
      FROM pg_stats s
      JOIN pg_class c ON c.relname = s.tablename
      JOIN pg_namespace n ON c.relnamespace = n.oid AND n.nspname = s.schemaname
      WHERE s.schemaname = '${schemaName.replace(/'/g, "''")}'
        AND s.tablename = '${tableName.replace(/'/g, "''")}'
        AND s.n_distinct IS NOT NULL
    `;
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
