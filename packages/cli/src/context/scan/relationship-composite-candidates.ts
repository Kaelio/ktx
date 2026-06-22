import type { KtxSqlDialect } from '../connections/dialects.js';
import type { KtxEnrichedColumn, KtxEnrichedSchema, KtxEnrichedTable, KtxRelationshipType } from './enrichment-types.js';
import {
  type KtxRelationshipProfileArtifact,
  type KtxRelationshipReadOnlyExecutor,
} from './relationship-profiling.js';
import type { KtxQueryResult, KtxScanContext, KtxTableRef } from './types.js';

type KtxCompositeRelationshipStatus = 'accepted' | 'review' | 'rejected';

interface KtxCompositeRelationshipTupleEndpoint {
  tableId: string;
  columnIds: string[];
  table: KtxTableRef;
  columns: string[];
}

export interface KtxCompositePrimaryKeyCandidate {
  id: string;
  tableId: string;
  table: KtxTableRef;
  columns: string[];
  columnIds: string[];
  score: number;
  status: KtxCompositeRelationshipStatus;
  evidence: {
    rowCount: number;
    distinctCount: number;
    uniquenessRatio: number;
    nullRate: number;
    reasons: string[];
  };
}

interface KtxCompositeRelationshipValidationEvidence {
  targetUniqueness: number;
  sourceCoverage: number;
  violationCount: number;
  violationRatio: number;
  childDistinct: number;
  parentDistinct: number;
  overlap: number;
  reasons: string[];
}

export interface KtxCompositeRelationshipCandidate {
  id: string;
  from: KtxCompositeRelationshipTupleEndpoint;
  to: KtxCompositeRelationshipTupleEndpoint;
  relationshipType: KtxRelationshipType;
  confidence: number;
  status: KtxCompositeRelationshipStatus;
  source: 'composite_profile_match';
  validation: KtxCompositeRelationshipValidationEvidence;
}

export interface DiscoverKtxCompositeRelationshipsInput {
  connectionId: string;
  dialect: KtxSqlDialect;
  schema: KtxEnrichedSchema;
  profiles: KtxRelationshipProfileArtifact;
  executor: KtxRelationshipReadOnlyExecutor | null;
  ctx: KtxScanContext;
  maxCompositeWidth?: number;
  maxColumnsPerTable?: number;
  minPrimaryKeyUniqueness?: number;
  minSourceCoverage?: number;
  maxViolationRatio?: number;
}

export interface DiscoverKtxCompositeRelationshipsResult {
  primaryKeys: KtxCompositePrimaryKeyCandidate[];
  relationships: KtxCompositeRelationshipCandidate[];
  queryCount: number;
  warnings: string[];
}

const KEY_NAME_PARTS = new Set(['id', 'key', 'code', 'number', 'num', 'line', 'warehouse', 'account', 'order']);
const DEFAULT_MAX_COMPOSITE_WIDTH = 3;
const DEFAULT_MAX_COLUMNS_PER_TABLE = 8;
const DEFAULT_MIN_PRIMARY_KEY_UNIQUENESS = 0.98;
const DEFAULT_MIN_SOURCE_COVERAGE = 0.9;
const DEFAULT_MAX_VIOLATION_RATIO = 0.01;

function enabledTables(schema: KtxEnrichedSchema): KtxEnrichedTable[] {
  return schema.tables.filter((table) => table.enabled);
}

function tableRowCount(profiles: KtxRelationshipProfileArtifact, tableName: string): number {
  return profiles.tables.find((item) => item.table.name === tableName)?.rowCount ?? 0;
}

function profileKey(tableName: string, columnName: string): string {
  return `${tableName}.${columnName}`;
}

function profileNullRate(profiles: KtxRelationshipProfileArtifact, tableName: string, columnName: string): number {
  return profiles.columns[profileKey(tableName, columnName)]?.nullRate ?? 1;
}

function normalizedColumnName(name: string): string {
  return name
    .toLowerCase()
    .replace(/[^a-z0-9]+/gu, '_')
    .replace(/^_+|_+$/gu, '');
}

function columnNameScore(column: KtxEnrichedColumn): number {
  const parts = normalizedColumnName(column.name).split('_').filter(Boolean);
  if (parts.some((part) => KEY_NAME_PARTS.has(part))) {
    return 1;
  }
  return 0;
}

function nameParts(name: string): string[] {
  return normalizedColumnName(name).split('_').filter(Boolean);
}

function keyLikeTableNameParts(tableName: string): Set<string> {
  return new Set(nameParts(tableName).filter((part) => KEY_NAME_PARTS.has(part)));
}

function tupleCoversTableNameKeyParts(tableName: string, columns: readonly KtxEnrichedColumn[]): boolean {
  const required = keyLikeTableNameParts(tableName);
  if (required.size === 0) {
    return true;
  }
  const columnParts = new Set(columns.flatMap((column) => nameParts(column.name)));
  return Array.from(required).every((part) => columnParts.has(part));
}

function candidateKeyColumns(input: {
  table: KtxEnrichedTable;
  profiles: KtxRelationshipProfileArtifact;
  maxColumnsPerTable: number;
}): KtxEnrichedColumn[] {
  return input.table.columns
    .map((column, index) => ({ column, index }))
    .filter(({ column }) => {
      if (column.dimensionType === 'time' || column.dimensionType === 'boolean') {
        return false;
      }
      const profile = input.profiles.columns[profileKey(input.table.ref.name, column.name)];
      return Boolean(profile) && profile!.nullRate <= 0.02 && columnNameScore(column) > 0;
    })
    .sort(
      (left, right) =>
        columnNameScore(right.column) - columnNameScore(left.column) || left.index - right.index,
    )
    .slice(0, input.maxColumnsPerTable)
    .map(({ column }) => column);
}

function hasStrongSingleColumnKey(input: {
  table: KtxEnrichedTable;
  profiles: KtxRelationshipProfileArtifact;
  minPrimaryKeyUniqueness: number;
}): boolean {
  return input.table.columns.some((column) => {
    if (column.dimensionType === 'time' || column.dimensionType === 'boolean' || columnNameScore(column) === 0) {
      return false;
    }
    const profile = input.profiles.columns[profileKey(input.table.ref.name, column.name)];
    return Boolean(profile) && profile!.nullRate <= 0.02 && profile!.uniquenessRatio >= input.minPrimaryKeyUniqueness;
  });
}

function combinations<T>(values: readonly T[], width: number): T[][] {
  if (width <= 0) {
    return [[]];
  }
  if (values.length < width) {
    return [];
  }
  const output: T[][] = [];
  values.forEach((value, index) => {
    for (const tail of combinations(values.slice(index + 1), width - 1)) {
      output.push([value, ...tail]);
    }
  });
  return output;
}

function tupleKey(tableName: string, columns: readonly string[]): string {
  return `${tableName}.(${columns.join(',')})`;
}

function relationshipKey(input: {
  fromTable: string;
  fromColumns: readonly string[];
  toTable: string;
  toColumns: readonly string[];
}): string {
  return `${tupleKey(input.fromTable, input.fromColumns)}->${tupleKey(input.toTable, input.toColumns)}`;
}

function tupleEndpoint(table: KtxEnrichedTable, columns: readonly KtxEnrichedColumn[]): KtxCompositeRelationshipTupleEndpoint {
  return {
    tableId: table.id,
    columnIds: columns.map((column) => column.id),
    table: table.ref,
    columns: columns.map((column) => column.name),
  };
}

function row(result: KtxQueryResult): unknown[] {
  return result.rows[0] ?? [];
}

function numberAt(result: KtxQueryResult, header: string): number {
  const index = result.headers.findIndex((candidate) => candidate.toLowerCase() === header.toLowerCase());
  const value = row(result)[index];
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

function sqlSuffix(fragment: string): string {
  return fragment ? ` ${fragment}` : '';
}

function aliasedTupleSelect(dialect: KtxSqlDialect, columns: readonly string[]): string {
  return columns.map((column, index) => `${dialect.quoteIdentifier(column)} AS c${index}`).join(', ');
}

function nonNullPredicate(dialect: KtxSqlDialect, columns: readonly string[]): string {
  return columns.map((column) => `${dialect.quoteIdentifier(column)} IS NOT NULL`).join(' AND ');
}

function tupleEquality(columns: number): string {
  return Array.from({ length: columns }, (_, index) => `child_values.c${index} = parent_values.c${index}`).join(
    ' AND ',
  );
}

function buildTupleDistinctSql(input: {
  dialect: KtxSqlDialect;
  table: KtxTableRef;
  columns: readonly string[];
}): string {
  const tableSql = input.dialect.formatTableName(input.table);
  return [
    'WITH tuple_values AS (',
    `SELECT DISTINCT ${aliasedTupleSelect(input.dialect, input.columns)} FROM ${tableSql}`,
    `WHERE ${nonNullPredicate(input.dialect, input.columns)}`,
    ')',
    'SELECT COUNT(*) AS distinct_count FROM tuple_values',
  ].join(' ');
}

function buildCompositeCoverageSql(input: {
  dialect: KtxSqlDialect;
  childTable: KtxTableRef;
  childColumns: readonly string[];
  parentTable: KtxTableRef;
  parentColumns: readonly string[];
  maxDistinctSourceValues: number;
}): string {
  const childTableSql = input.dialect.formatTableName(input.childTable);
  const parentTableSql = input.dialect.formatTableName(input.parentTable);
  const top = input.dialect.getTopClause(input.maxDistinctSourceValues);
  const limit = sqlSuffix(input.dialect.getLimitOffsetClause(input.maxDistinctSourceValues));
  return [
    'WITH child_values AS (',
    `SELECT DISTINCT${top ? ` ${top}` : ''} ${aliasedTupleSelect(input.dialect, input.childColumns)} FROM ${childTableSql}`,
    `WHERE ${nonNullPredicate(input.dialect, input.childColumns)}${limit}`,
    '), parent_values AS (',
    `SELECT DISTINCT ${aliasedTupleSelect(input.dialect, input.parentColumns)} FROM ${parentTableSql}`,
    `WHERE ${nonNullPredicate(input.dialect, input.parentColumns)}`,
    ')',
    'SELECT',
    '(SELECT COUNT(*) FROM child_values) AS child_distinct,',
    '(SELECT COUNT(*) FROM parent_values) AS parent_distinct,',
    'SUM(CASE WHEN parent_values.c0 IS NOT NULL THEN 1 ELSE 0 END) AS overlap,',
    'SUM(CASE WHEN parent_values.c0 IS NULL THEN 1 ELSE 0 END) AS violation_count',
    'FROM child_values',
    `LEFT JOIN parent_values ON ${tupleEquality(input.childColumns.length)}`,
  ].join(' ');
}

function relationshipStatus(input: {
  targetUniqueness: number;
  sourceCoverage: number;
  violationRatio: number;
  minSourceCoverage: number;
  maxViolationRatio: number;
}): KtxCompositeRelationshipStatus {
  if (
    input.targetUniqueness >= DEFAULT_MIN_PRIMARY_KEY_UNIQUENESS &&
    input.sourceCoverage >= input.minSourceCoverage &&
    input.violationRatio <= input.maxViolationRatio
  ) {
    return 'accepted';
  }
  if (input.sourceCoverage >= 0.55) {
    return 'review';
  }
  return 'rejected';
}

function hasAcceptedSubset(
  accepted: readonly KtxCompositePrimaryKeyCandidate[],
  tableName: string,
  columns: readonly string[],
): boolean {
  const columnSet = new Set(columns);
  return accepted.some(
    (candidate) =>
      candidate.table.name === tableName &&
      candidate.columns.length < columns.length &&
      candidate.columns.every((column) => columnSet.has(column)),
  );
}

async function detectCompositePrimaryKeys(input: {
  connectionId: string;
  dialect: KtxSqlDialect;
  table: KtxEnrichedTable;
  profiles: KtxRelationshipProfileArtifact;
  executor: KtxRelationshipReadOnlyExecutor;
  ctx: KtxScanContext;
  maxCompositeWidth: number;
  maxColumnsPerTable: number;
  minPrimaryKeyUniqueness: number;
}): Promise<{ primaryKeys: KtxCompositePrimaryKeyCandidate[]; queryCount: number }> {
  const rowCount = tableRowCount(input.profiles, input.table.ref.name);
  if (rowCount === 0) {
    return { primaryKeys: [], queryCount: 0 };
  }
  if (
    hasStrongSingleColumnKey({
      table: input.table,
      profiles: input.profiles,
      minPrimaryKeyUniqueness: input.minPrimaryKeyUniqueness,
    })
  ) {
    return { primaryKeys: [], queryCount: 0 };
  }

  const columns = candidateKeyColumns({
    table: input.table,
    profiles: input.profiles,
    maxColumnsPerTable: input.maxColumnsPerTable,
  });
  const primaryKeys: KtxCompositePrimaryKeyCandidate[] = [];
  let queryCount = 0;

  for (let width = 2; width <= input.maxCompositeWidth; width += 1) {
    for (const columnTuple of combinations(columns, width)) {
      const columnNames = columnTuple.map((column) => column.name);
      if (!tupleCoversTableNameKeyParts(input.table.ref.name, columnTuple)) {
        continue;
      }
      if (hasAcceptedSubset(primaryKeys, input.table.ref.name, columnNames)) {
        continue;
      }
      const result = await input.executor.executeReadOnly(
        {
          connectionId: input.connectionId,
          sql: buildTupleDistinctSql({
            dialect: input.dialect,
            table: input.table.ref,
            columns: columnNames,
          }),
          maxRows: 1,
        },
        input.ctx,
      );
      queryCount += 1;
      const distinctCount = numberAt(result, 'distinct_count');
      const uniquenessRatio = rowCount === 0 ? 0 : distinctCount / rowCount;
      if (uniquenessRatio < input.minPrimaryKeyUniqueness) {
        continue;
      }
      const nullRate = Math.max(
        ...columnNames.map((columnName) => profileNullRate(input.profiles, input.table.ref.name, columnName)),
      );
      primaryKeys.push({
        id: tupleKey(input.table.ref.name, columnNames),
        tableId: input.table.id,
        table: input.table.ref,
        columns: columnNames,
        columnIds: columnTuple.map((column) => column.id),
        score: Number(Math.min(0.99, 0.72 + uniquenessRatio * 0.22 + (1 - nullRate) * 0.06).toFixed(3)),
        status: 'accepted',
        evidence: {
          rowCount,
          distinctCount,
          uniquenessRatio,
          nullRate,
          reasons: ['composite_unique_tuple', 'not_null_profile'],
        },
      });
    }
  }

  return {
    primaryKeys: primaryKeys.sort((left, right) =>
      tupleKey(left.table.name, left.columns).localeCompare(tupleKey(right.table.name, right.columns)),
    ),
    queryCount,
  };
}

function columnsByName(table: KtxEnrichedTable): Map<string, KtxEnrichedColumn> {
  return new Map(table.columns.map((column) => [column.name, column]));
}

function compatibleTuple(sourceColumns: readonly KtxEnrichedColumn[], targetColumns: readonly KtxEnrichedColumn[]): boolean {
  if (sourceColumns.length !== targetColumns.length) {
    return false;
  }
  return sourceColumns.every((source, index) => {
    const target = targetColumns[index];
    return Boolean(target) && source.dimensionType === target.dimensionType;
  });
}

async function validateCompositeRelationship(input: {
  connectionId: string;
  dialect: KtxSqlDialect;
  sourceTable: KtxEnrichedTable;
  sourceColumns: readonly KtxEnrichedColumn[];
  targetKey: KtxCompositePrimaryKeyCandidate;
  targetTable: KtxEnrichedTable;
  targetColumns: readonly KtxEnrichedColumn[];
  executor: KtxRelationshipReadOnlyExecutor;
  ctx: KtxScanContext;
  minSourceCoverage: number;
  maxViolationRatio: number;
}): Promise<{ relationship: KtxCompositeRelationshipCandidate; queryCount: number }> {
  const result = await input.executor.executeReadOnly(
    {
      connectionId: input.connectionId,
      sql: buildCompositeCoverageSql({
        dialect: input.dialect,
        childTable: input.sourceTable.ref,
        childColumns: input.sourceColumns.map((column) => column.name),
        parentTable: input.targetTable.ref,
        parentColumns: input.targetColumns.map((column) => column.name),
        maxDistinctSourceValues: 10000,
      }),
      maxRows: 1,
    },
    input.ctx,
  );
  const childDistinct = numberAt(result, 'child_distinct');
  const parentDistinct = numberAt(result, 'parent_distinct');
  const overlap = numberAt(result, 'overlap');
  const violationCount = numberAt(result, 'violation_count');
  const sourceCoverage = childDistinct === 0 ? 0 : overlap / childDistinct;
  const violationRatio = childDistinct === 0 ? 1 : violationCount / childDistinct;
  const targetUniqueness = input.targetKey.evidence.uniquenessRatio;
  const status = relationshipStatus({
    targetUniqueness,
    sourceCoverage,
    violationRatio,
    minSourceCoverage: input.minSourceCoverage,
    maxViolationRatio: input.maxViolationRatio,
  });

  const from = tupleEndpoint(input.sourceTable, input.sourceColumns);
  const to = {
    tableId: input.targetKey.tableId,
    columnIds: input.targetKey.columnIds,
    table: input.targetKey.table,
    columns: input.targetKey.columns,
  };
  const reasons =
    status === 'accepted'
      ? ['composite_validation_passed']
      : [
          'composite_validation_failed',
          sourceCoverage < input.minSourceCoverage ? 'low_source_coverage' : '',
          violationRatio > input.maxViolationRatio ? 'excessive_violations' : '',
        ].filter(Boolean);

  return {
    queryCount: 1,
    relationship: {
      id: relationshipKey({
        fromTable: from.table.name,
        fromColumns: from.columns,
        toTable: to.table.name,
        toColumns: to.columns,
      }),
      from,
      to,
      relationshipType: 'many_to_one',
      confidence: status === 'accepted' ? 0.95 : 0.62,
      status,
      source: 'composite_profile_match',
      validation: {
        targetUniqueness,
        sourceCoverage,
        violationCount,
        violationRatio,
        childDistinct,
        parentDistinct,
        overlap,
        reasons,
      },
    },
  };
}

export async function discoverKtxCompositeRelationships(
  input: DiscoverKtxCompositeRelationshipsInput,
): Promise<DiscoverKtxCompositeRelationshipsResult> {
  if (!input.executor || !input.profiles.sqlAvailable) {
    return {
      primaryKeys: [],
      relationships: [],
      queryCount: 0,
      warnings: ['composite_relationship_validation_unavailable'],
    };
  }

  const settings = {
    maxCompositeWidth: input.maxCompositeWidth ?? DEFAULT_MAX_COMPOSITE_WIDTH,
    maxColumnsPerTable: input.maxColumnsPerTable ?? DEFAULT_MAX_COLUMNS_PER_TABLE,
    minPrimaryKeyUniqueness: input.minPrimaryKeyUniqueness ?? DEFAULT_MIN_PRIMARY_KEY_UNIQUENESS,
    minSourceCoverage: input.minSourceCoverage ?? DEFAULT_MIN_SOURCE_COVERAGE,
    maxViolationRatio: input.maxViolationRatio ?? DEFAULT_MAX_VIOLATION_RATIO,
  };
  const tables = enabledTables(input.schema);
  const tableByName = new Map(tables.map((table) => [table.ref.name, table]));
  const primaryKeys: KtxCompositePrimaryKeyCandidate[] = [];
  let queryCount = 0;

  for (const table of tables) {
    const result = await detectCompositePrimaryKeys({
      connectionId: input.connectionId,
      dialect: input.dialect,
      table,
      profiles: input.profiles,
      executor: input.executor,
      ctx: input.ctx,
      maxCompositeWidth: settings.maxCompositeWidth,
      maxColumnsPerTable: settings.maxColumnsPerTable,
      minPrimaryKeyUniqueness: settings.minPrimaryKeyUniqueness,
    });
    primaryKeys.push(...result.primaryKeys);
    queryCount += result.queryCount;
  }

  const relationships: KtxCompositeRelationshipCandidate[] = [];
  for (const targetKey of primaryKeys) {
    const targetTable = tableByName.get(targetKey.table.name);
    if (!targetTable) {
      continue;
    }
    const targetColumnByName = columnsByName(targetTable);
    const targetColumns = targetKey.columns.flatMap((columnName) => {
      const column = targetColumnByName.get(columnName);
      return column ? [column] : [];
    });
    if (targetColumns.length !== targetKey.columns.length) {
      continue;
    }

    for (const sourceTable of tables) {
      if (sourceTable.id === targetTable.id) {
        continue;
      }
      const sourceColumnByName = columnsByName(sourceTable);
      const sourceColumns = targetKey.columns.flatMap((columnName) => {
        const column = sourceColumnByName.get(columnName);
        return column ? [column] : [];
      });
      if (sourceColumns.length !== targetKey.columns.length || !compatibleTuple(sourceColumns, targetColumns)) {
        continue;
      }

      const result = await validateCompositeRelationship({
        connectionId: input.connectionId,
        dialect: input.dialect,
        sourceTable,
        sourceColumns,
        targetKey,
        targetTable,
        targetColumns,
        executor: input.executor,
        ctx: input.ctx,
        minSourceCoverage: settings.minSourceCoverage,
        maxViolationRatio: settings.maxViolationRatio,
      });
      queryCount += result.queryCount;
      if (result.relationship.status !== 'rejected') {
        relationships.push(result.relationship);
      }
    }
  }

  return {
    primaryKeys: primaryKeys.sort((left, right) => left.id.localeCompare(right.id)),
    relationships: relationships.sort((left, right) => left.id.localeCompare(right.id)),
    queryCount,
    warnings: [],
  };
}
