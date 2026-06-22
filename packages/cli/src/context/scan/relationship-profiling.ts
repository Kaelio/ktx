import type { KtxSqlDialect } from '../connections/dialects.js';
import type { KtxEnrichedColumn, KtxEnrichedSchema, KtxEnrichedTable } from './enrichment-types.js';
import { mapWithConcurrency } from './relationship-validation.js';
import type {
  KtxConnectionDriver,
  KtxQueryResult,
  KtxReadOnlyQueryInput,
  KtxScanContext,
  KtxTableRef,
} from './types.js';

export interface KtxRelationshipReadOnlyExecutor {
  executeReadOnly(input: KtxReadOnlyQueryInput, ctx: KtxScanContext): Promise<KtxQueryResult>;
}

export interface KtxRelationshipColumnProfile {
  table: KtxTableRef;
  column: string;
  nativeType: string;
  normalizedType: string;
  rowCount: number;
  nullCount: number;
  distinctCount: number;
  uniquenessRatio: number;
  nullRate: number;
  sampleValues: string[];
  minTextLength: number | null;
  maxTextLength: number | null;
}

/** @internal */
export interface KtxRelationshipTableProfile {
  table: KtxTableRef;
  rowCount: number;
}

export interface KtxRelationshipProfileArtifact {
  connectionId: string;
  driver: KtxConnectionDriver;
  sqlAvailable: boolean;
  queryCount: number;
  tables: KtxRelationshipTableProfile[];
  columns: Record<string, KtxRelationshipColumnProfile>;
  warnings: string[];
}

interface KtxRelationshipCachedTableProfile {
  table: KtxRelationshipTableProfile;
  columns: Record<string, KtxRelationshipColumnProfile>;
  warnings: string[];
}

export interface KtxRelationshipProfileCache {
  readonly tableProfiles: Map<string, KtxRelationshipCachedTableProfile>;
}

export interface ProfileKtxRelationshipSchemaInput {
  connectionId: string;
  driver: KtxConnectionDriver;
  dialect: KtxSqlDialect | null;
  schema: KtxEnrichedSchema;
  executor: KtxRelationshipReadOnlyExecutor | null;
  ctx: KtxScanContext;
  sampleValuesPerColumn?: number;
  profileSampleRows?: number;
  profileConcurrency?: number;
  cache?: KtxRelationshipProfileCache;
}

export function createKtxRelationshipProfileCache(): KtxRelationshipProfileCache {
  return { tableProfiles: new Map() };
}

const SAMPLE_VALUE_DELIMITER = '\u001f';

function firstRow(result: KtxQueryResult): unknown[] {
  return result.rows[0] ?? [];
}

function headerIndex(result: KtxQueryResult, header: string): number {
  return result.headers.findIndex((candidate) => candidate.toLowerCase() === header.toLowerCase());
}

function valueAt(result: KtxQueryResult, row: unknown[], header: string): unknown {
  return row[headerIndex(result, header)];
}

function numberFromValue(value: unknown): number {
  if (typeof value === 'number') {
    return value;
  }
  if (typeof value === 'bigint') {
    return Number(value);
  }
  if (typeof value === 'string' && value.trim() !== '') {
    return Number(value);
  }
  return 0;
}

function nullableNumberFromValue(value: unknown): number | null {
  if (value === null || value === undefined) {
    return null;
  }
  if (typeof value === 'number') {
    return value;
  }
  if (typeof value === 'bigint') {
    return Number(value);
  }
  if (typeof value === 'string' && value.trim() !== '') {
    return Number(value);
  }
  return null;
}

function numberAt(result: KtxQueryResult, header: string): number {
  return numberFromValue(valueAt(result, firstRow(result), header));
}

function columnKey(table: KtxEnrichedTable, column: KtxEnrichedColumn): string {
  return `${table.ref.name}.${column.name}`;
}

function tableProfileCacheKey(input: {
  connectionId: string;
  dialect: KtxSqlDialect;
  ctx: KtxScanContext;
  table: KtxTableRef;
  sampleValuesPerColumn: number;
  profileSampleRows: number;
}): string {
  return [
    input.ctx.runId,
    input.connectionId,
    input.dialect.type,
    input.table.catalog ?? '',
    input.table.db ?? '',
    input.table.name,
    String(input.sampleValuesPerColumn),
    String(input.profileSampleRows),
  ].join('\u001e');
}

function sqlStringLiteral(value: string): string {
  return `'${value.replace(/'/g, "''")}'`;
}

function sqlSuffix(fragment: string): string {
  return fragment ? ` ${fragment}` : '';
}

function sampledTableSql(dialect: KtxSqlDialect, tableSql: string, limit: number): string {
  const top = dialect.getTopClause(limit);
  if (top) {
    return `(SELECT ${top} * FROM ${tableSql}) AS relationship_profile_sample`;
  }
  return `(SELECT * FROM ${tableSql}${sqlSuffix(dialect.getLimitOffsetClause(limit))}) AS relationship_profile_sample`;
}

function sampleValuesSql(input: {
  dialect: KtxSqlDialect;
  tableSql: string;
  columnSql: string;
  limit: number;
}): string {
  const top = input.dialect.getTopClause(input.limit);
  return [
    `SELECT${top ? ` ${top}` : ''} ${input.columnSql} AS value`,
    `FROM ${input.tableSql}`,
    `WHERE ${input.columnSql} IS NOT NULL`,
    `GROUP BY ${input.columnSql}`,
    `ORDER BY COUNT(*) DESC, ${input.columnSql} ASC`,
    sqlSuffix(input.dialect.getLimitOffsetClause(input.limit)),
  ].join(' ');
}

function columnProfileSelectSql(input: {
  dialect: KtxSqlDialect;
  tableSql: string;
  profileTableSql: string;
  column: KtxEnrichedColumn;
  sampleValuesPerColumn: number;
}): string {
  const columnSql = input.dialect.quoteIdentifier(input.column.name);
  const textLengthSql = input.dialect.textLengthExpression(columnSql);
  const samplesSql = input.dialect.getSampleValueAggregation(
    sampleValuesSql({
      dialect: input.dialect,
      tableSql: input.profileTableSql,
      columnSql,
      limit: input.sampleValuesPerColumn,
    }),
  );
  return [
    'SELECT',
    `${sqlStringLiteral(input.column.name)} AS column_name,`,
    `(SELECT COUNT(*) FROM ${input.tableSql}) AS table_row_count,`,
    'COUNT(*) AS row_count,',
    `SUM(CASE WHEN ${columnSql} IS NULL THEN 1 ELSE 0 END) AS null_count,`,
    `COUNT(DISTINCT ${columnSql}) AS distinct_count,`,
    `MIN(${textLengthSql}) AS min_text_length,`,
    `MAX(${textLengthSql}) AS max_text_length,`,
    `${samplesSql} AS sample_values`,
    `FROM ${input.profileTableSql}`,
  ].join(' ');
}

function splitSampleValues(value: unknown): string[] {
  if (value === null || value === undefined) {
    return [];
  }
  const text = String(value);
  if (text === '') {
    return [];
  }
  return text.split(SAMPLE_VALUE_DELIMITER).filter((item) => item !== '');
}

async function queryCount(input: {
  connectionId: string;
  dialect: KtxSqlDialect;
  table: KtxTableRef;
  executor: KtxRelationshipReadOnlyExecutor;
  ctx: KtxScanContext;
}): Promise<{ rowCount: number; queryCount: number }> {
  const tableSql = input.dialect.formatTableName(input.table);
  const result = await input.executor.executeReadOnly(
    { connectionId: input.connectionId, sql: `SELECT COUNT(*) AS row_count FROM ${tableSql}`, maxRows: 1 },
    input.ctx,
  );
  return { rowCount: numberAt(result, 'row_count'), queryCount: 1 };
}

async function queryTableProfile(input: {
  connectionId: string;
  dialect: KtxSqlDialect;
  table: KtxEnrichedTable;
  executor: KtxRelationshipReadOnlyExecutor;
  ctx: KtxScanContext;
  sampleValuesPerColumn: number;
  profileSampleRows: number;
}): Promise<{
  table: KtxRelationshipTableProfile;
  columns: Record<string, KtxRelationshipColumnProfile>;
  queryCount: number;
}> {
  if (input.table.columns.length === 0) {
    const rowCount = await queryCount({
      connectionId: input.connectionId,
      dialect: input.dialect,
      table: input.table.ref,
      executor: input.executor,
      ctx: input.ctx,
    });
    return {
      table: { table: input.table.ref, rowCount: rowCount.rowCount },
      columns: {},
      queryCount: rowCount.queryCount,
    };
  }

  const tableSql = input.dialect.formatTableName(input.table.ref);
  const profileTableSql = sampledTableSql(input.dialect, tableSql, input.profileSampleRows);
  const sql = input.table.columns
    .map((column) =>
      columnProfileSelectSql({
        dialect: input.dialect,
        tableSql,
        profileTableSql,
        column,
        sampleValuesPerColumn: input.sampleValuesPerColumn,
      }),
    )
    .join(' UNION ALL ');
  const result = await input.executor.executeReadOnly(
    { connectionId: input.connectionId, sql, maxRows: input.table.columns.length },
    input.ctx,
  );
  const columnsByName = new Map(input.table.columns.map((column) => [column.name, column]));
  const profiles: Record<string, KtxRelationshipColumnProfile> = {};
  let tableRowCount = 0;

  for (const row of result.rows) {
    const columnName = String(valueAt(result, row, 'column_name'));
    const column = columnsByName.get(columnName);
    if (!column) {
      continue;
    }
    const rowCount = numberFromValue(valueAt(result, row, 'row_count'));
    const nullCount = numberFromValue(valueAt(result, row, 'null_count'));
    const distinctCount = numberFromValue(valueAt(result, row, 'distinct_count'));
    tableRowCount = Math.max(tableRowCount, numberFromValue(valueAt(result, row, 'table_row_count')));
    profiles[columnKey(input.table, column)] = {
      table: input.table.ref,
      column: column.name,
      nativeType: column.nativeType,
      normalizedType: column.normalizedType,
      rowCount,
      nullCount,
      distinctCount,
      uniquenessRatio: rowCount === 0 ? 0 : distinctCount / rowCount,
      nullRate: rowCount === 0 ? 0 : nullCount / rowCount,
      sampleValues: splitSampleValues(valueAt(result, row, 'sample_values')),
      minTextLength: nullableNumberFromValue(valueAt(result, row, 'min_text_length')),
      maxTextLength: nullableNumberFromValue(valueAt(result, row, 'max_text_length')),
    };
  }

  return {
    table: { table: input.table.ref, rowCount: tableRowCount },
    columns: profiles,
    queryCount: 1,
  };
}

type TableProfileResult =
  | { tableProfile: Awaited<ReturnType<typeof queryTableProfile>> }
  | { cached: KtxRelationshipCachedTableProfile; queryCount: 0 };

export async function profileKtxRelationshipSchema(
  input: ProfileKtxRelationshipSchemaInput,
): Promise<KtxRelationshipProfileArtifact> {
  if (!input.executor || !input.dialect) {
    return {
      connectionId: input.connectionId,
      driver: input.driver,
      sqlAvailable: false,
      queryCount: 0,
      tables: [],
      columns: {},
      warnings: ['read_only_sql_unavailable'],
    };
  }

  let queryTotal = 0;
  const tables: KtxRelationshipTableProfile[] = [];
  const columns: Record<string, KtxRelationshipColumnProfile> = {};
  const warnings: string[] = [];
  const executor = input.executor;
  const dialect = input.dialect;

  const enabledTables = input.schema.tables.filter((candidate) => candidate.enabled);
  const tableResults = await mapWithConcurrency<KtxEnrichedTable, TableProfileResult>(
    enabledTables,
    input.profileConcurrency ?? 4,
    async (table) => {
      const sampleValuesPerColumn = input.sampleValuesPerColumn ?? 5;
      const profileSampleRows = input.profileSampleRows ?? 10000;
      const cacheKey = tableProfileCacheKey({
        connectionId: input.connectionId,
        dialect,
        ctx: input.ctx,
        table: table.ref,
        sampleValuesPerColumn,
        profileSampleRows,
      });
      const cached = input.cache?.tableProfiles.get(cacheKey);
      if (cached) {
        return { cached, queryCount: 0 };
      }

      try {
        const tableProfile = await queryTableProfile({
          connectionId: input.connectionId,
          dialect,
          table,
          executor,
          ctx: input.ctx,
          sampleValuesPerColumn,
          profileSampleRows,
        });
        input.cache?.tableProfiles.set(cacheKey, {
          table: tableProfile.table,
          columns: tableProfile.columns,
          warnings: [],
        });
        return { tableProfile };
      } catch (error) {
        const failureWarning = `profile_failed:${table.ref.name}:${error instanceof Error ? error.message : String(error)}`;
        const cachedFailure = {
          table: { table: table.ref, rowCount: 0 },
          columns: {},
          warnings: [failureWarning],
        };
        input.cache?.tableProfiles.set(cacheKey, cachedFailure);
        return { cached: cachedFailure, queryCount: 0 };
      }
    },
  );

  for (const result of tableResults) {
    if ('tableProfile' in result) {
      queryTotal += result.tableProfile.queryCount;
      tables.push(result.tableProfile.table);
      Object.assign(columns, result.tableProfile.columns);
      continue;
    }
    tables.push(result.cached.table);
    Object.assign(columns, result.cached.columns);
    for (const warning of result.cached.warnings) {
      warnings.push(warning);
    }
  }

  return {
    connectionId: input.connectionId,
    driver: input.driver,
    sqlAvailable: true,
    queryCount: queryTotal,
    tables,
    columns,
    warnings,
  };
}
