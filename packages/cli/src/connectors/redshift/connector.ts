import { resolveStringReference } from '../shared/string-reference.js';
import { getDialectForDriver } from '../../context/connections/dialects.js';
import { assertReadOnlySql, limitSqlForExecution } from '../../context/connections/read-only-sql.js';
import { tryConstraintQuery } from '../../context/scan/constraint-discovery.js';
import { scopedTableNames } from '../../context/scan/table-ref.js';
import {
  connectorTestFailure,
  createKtxConnectorCapabilities,
  type KtxConnectorTestResult,
  type KtxColumnSampleInput,
  type KtxColumnSampleResult,
  type KtxColumnStatsInput,
  type KtxColumnStatsResult,
  type KtxQueryResult,
  type KtxReadOnlyQueryInput,
  type KtxScanConnector,
  type KtxScanContext,
  type KtxScanInput,
  type KtxScanWarning,
  type KtxSchemaColumn,
  type KtxSchemaForeignKey,
  type KtxSchemaSnapshot,
  type KtxSchemaTable,
  type KtxTableListEntry,
  type KtxTableRef,
  type KtxTableSampleInput,
  type KtxTableSampleResult,
} from '../../context/scan/types.js';
import { Pool } from 'pg';

const REDSHIFT_OID_TYPE_MAP: Record<number, string> = {
  16: 'boolean',
  20: 'bigint',
  21: 'smallint',
  23: 'integer',
  25: 'text',
  700: 'real',
  701: 'double precision',
  1043: 'varchar',
  1082: 'date',
  1114: 'timestamp',
  1184: 'timestamptz',
  1700: 'numeric',
  2950: 'uuid',
  3802: 'jsonb',
  114: 'json',
  1009: 'text[]',
  1007: 'integer[]',
  1016: 'bigint[]',
};

export interface KtxRedshiftConnectionConfig {
  driver?: string;
  host?: string;
  port?: number;
  database?: string;
  username?: string;
  user?: string;
  password?: string;
  url?: string;
  schema?: string;
  schemas?: string[];
  ssl?: boolean;
  sslmode?: string;
  sslMode?: string;
  rejectUnauthorized?: boolean;
  maxConnections?: number;
  [key: string]: unknown;
}

export interface KtxRedshiftPoolConfig {
  host?: string;
  port?: number;
  database?: string;
  user?: string;
  password?: string;
  connectionString?: string;
  max: number;
  idleTimeoutMillis: number;
  connectionTimeoutMillis: number;
  options?: string;
  ssl?: { rejectUnauthorized: boolean };
}

interface KtxRedshiftQueryResult {
  fields?: Array<{ name: string; dataTypeID: number }>;
  rows: Record<string, unknown>[];
}

interface KtxRedshiftClient {
  query(sql: string, params?: unknown[]): Promise<KtxRedshiftQueryResult>;
  release(): void;
}

interface KtxRedshiftPool {
  connect(): Promise<KtxRedshiftClient>;
  end(): Promise<void>;
  on?(event: 'error', listener: (error: Error) => void): void;
}

export interface KtxRedshiftPoolFactory {
  createPool(config: KtxRedshiftPoolConfig): KtxRedshiftPool;
}

interface KtxRedshiftResolvedEndpoint {
  host: string;
  port: number;
  close?: () => Promise<void>;
}

export interface KtxRedshiftEndpointResolver {
  resolve(input: {
    host: string;
    port: number;
    connection: KtxRedshiftConnectionConfig;
  }): Promise<KtxRedshiftResolvedEndpoint>;
}

export interface KtxRedshiftScanConnectorOptions {
  connectionId: string;
  connection: KtxRedshiftConnectionConfig | undefined;
  poolFactory?: KtxRedshiftPoolFactory;
  endpointResolver?: KtxRedshiftEndpointResolver;
  env?: NodeJS.ProcessEnv;
  now?: () => Date;
}

export interface KtxRedshiftReadOnlyQueryInput extends KtxReadOnlyQueryInput {
  params?: Record<string, unknown> | unknown[];
}

export interface KtxRedshiftColumnDistinctValuesOptions {
  maxCardinality: number;
  limit: number;
  sampleSize?: number;
}

export interface KtxRedshiftColumnDistinctValuesResult {
  values: string[] | null;
  cardinality: number;
}

export interface KtxRedshiftColumnStatisticsResult {
  cardinalityByColumn: Map<string, number>;
}

export interface KtxRedshiftTableSampleResult extends KtxTableSampleResult {
  headerTypes?: string[];
}

type RedshiftTableRef = Pick<KtxTableRef, 'name'> & Partial<Pick<KtxTableRef, 'catalog' | 'db'>>;

interface RedshiftTableRow {
  table_name: string;
  table_kind: string;
  row_count: unknown;
  table_comment: string | null;
}

interface RedshiftColumnRow {
  table_name: string;
  column_name: string;
  data_type: string;
  is_nullable: boolean;
  column_comment: string | null;
}

interface RedshiftPrimaryKeyRow {
  table_name: string;
  column_name: string;
}

interface RedshiftForeignKeyRow {
  table_name: string;
  column_name: string;
  foreign_table_schema: string | null;
  foreign_table_name: string;
  foreign_column_name: string;
  constraint_name: string | null;
}

interface RedshiftSchemaRow {
  schema_name: string;
}

interface RedshiftTableListRow {
  schema_name: string;
  table_name: string;
  table_kind: string;
}

interface RedshiftCountRow {
  count?: unknown;
  cardinality?: unknown;
}

interface RedshiftDistinctValueRow {
  val: unknown;
}

interface RedshiftStatsRow {
  column_name: string;
  estimated_cardinality: unknown;
}

class DefaultRedshiftPoolFactory implements KtxRedshiftPoolFactory {
  createPool(config: KtxRedshiftPoolConfig): KtxRedshiftPool {
    return new Pool(config);
  }
}

function groupByTable<T extends { table_name: string }>(rows: T[]): Map<string, T[]> {
  const grouped = new Map<string, T[]>();
  for (const row of rows) {
    const tableRows = grouped.get(row.table_name) ?? [];
    tableRows.push(row);
    grouped.set(row.table_name, tableRows);
  }
  return grouped;
}

/** @internal */
export function prepareRedshiftReadOnlyQuery(
  sql: string,
  params?: Record<string, unknown>,
): { sql: string; params?: unknown[] } {
  if (!params) {
    return { sql, params: undefined };
  }
  const paramNames = Object.keys(params);
  const values: unknown[] = new Array(paramNames.length);
  const paramIndexMap = new Map<string, number>();
  paramNames.forEach((name, index) => {
    paramIndexMap.set(name, index + 1);
    values[index] = params[name];
  });
  const sortedKeys = [...paramNames].sort((a, b) => b.length - a.length);
  let parameterizedQuery = sql;
  for (const name of sortedKeys) {
    parameterizedQuery = parameterizedQuery.replace(new RegExp(`:${name}\\b`, 'g'), `$${paramIndexMap.get(name)}`);
  }
  return { sql: parameterizedQuery, params: values };
}

function primaryKeyMap(rows: RedshiftPrimaryKeyRow[]): Map<string, Set<string>> {
  const grouped = new Map<string, Set<string>>();
  for (const row of rows) {
    const columns = grouped.get(row.table_name) ?? new Set<string>();
    columns.add(row.column_name);
    grouped.set(row.table_name, columns);
  }
  return grouped;
}

function isDeniedError(error: unknown): boolean {
  if (!error || typeof error !== 'object') {
    return false;
  }
  const code = (error as { code?: unknown }).code;
  return code === '42501' || code === '42P01';
}

function queryRows(result: KtxRedshiftQueryResult): unknown[][] {
  const headers = (result.fields ?? []).map((field) => field.name);
  return result.rows.map((row) => headers.map((header) => row[header]));
}

function finiteNumber(value: unknown): number | null {
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : null;
}

function stringConfigValue(
  connection: KtxRedshiftConnectionConfig | undefined,
  key: keyof KtxRedshiftConnectionConfig,
  env: NodeJS.ProcessEnv,
): string | undefined {
  const value = connection?.[key];
  return typeof value === 'string' && value.trim().length > 0 ? resolveStringReference(value.trim(), env) : undefined;
}


function numberValue(value: unknown): number | undefined {
  return typeof value === 'number' && Number.isFinite(value) ? value : undefined;
}

function positiveIntegerConfigValue(input: {
  connection: KtxRedshiftConnectionConfig;
  key: keyof KtxRedshiftConnectionConfig;
  connectionId: string;
  defaultValue: number;
}): number {
  const value = input.connection[input.key];
  if (value === undefined) {
    return input.defaultValue;
  }
  const numberValue = Number(value);
  if (!Number.isInteger(numberValue) || numberValue < 1) {
    throw new Error(`connections.${input.connectionId}.${String(input.key)} must be a positive integer`);
  }
  return numberValue;
}

function parseRedshiftUrl(url: string): Partial<KtxRedshiftConnectionConfig> {
  const parsed = new URL(url);
  const sslmode = parsed.searchParams.get('sslmode') ?? undefined;
  return {
    host: parsed.hostname,
    port: parsed.port ? Number(parsed.port) : undefined,
    database: parsed.pathname.replace(/^\/+/, '') || undefined,
    username: parsed.username ? decodeURIComponent(parsed.username) : undefined,
    password: parsed.password ? decodeURIComponent(parsed.password) : undefined,
    ...(sslmode ? { sslmode } : {}),
  };
}

function normalizedSslMode(connection: KtxRedshiftConnectionConfig): string | undefined {
  const value = connection.sslmode ?? connection.sslMode;
  return typeof value === 'string' && value.trim().length > 0 ? value.trim().toLowerCase() : undefined;
}

function schemasFromConnection(connection: KtxRedshiftConnectionConfig): string[] {
  if (Array.isArray(connection.schemas) && connection.schemas.length > 0) {
    return connection.schemas.filter((schema): schema is string => typeof schema === 'string' && schema.length > 0);
  }
  return typeof connection.schema === 'string' && connection.schema.length > 0 ? [connection.schema] : ['public'];
}

function searchPathSchemasFromConnection(connection: KtxRedshiftConnectionConfig): string[] {
  const schemas = schemasFromConnection(connection);
  return schemas.includes('public') ? schemas : [...schemas, 'public'];
}

export function isKtxRedshiftConnectionConfig(
  connection: KtxRedshiftConnectionConfig | undefined,
): connection is KtxRedshiftConnectionConfig {
  const driver = String(connection?.driver ?? '').toLowerCase();
  return driver === 'redshift';
}

/** @internal */
export function redshiftPoolConfigFromConfig(input: {
  connectionId: string;
  connection: KtxRedshiftConnectionConfig | undefined;
  env?: NodeJS.ProcessEnv;
}): KtxRedshiftPoolConfig {
  const inputDriver = input.connection?.driver ?? 'unknown';
  if (!isKtxRedshiftConnectionConfig(input.connection)) {
    throw new Error(`Native Redshift connector cannot run driver "${inputDriver}"`);
  }

  const env = input.env ?? process.env;
  const referencedUrl = stringConfigValue(input.connection, 'url', env);
  const urlConfig = referencedUrl ? parseRedshiftUrl(referencedUrl) : {};
  const merged: KtxRedshiftConnectionConfig = { ...urlConfig, ...input.connection };
  const host = stringConfigValue(merged, 'host', env);
  const database = stringConfigValue(merged, 'database', env);
  const user = stringConfigValue(merged, 'username', env) ?? stringConfigValue(merged, 'user', env);
  const password = stringConfigValue(merged, 'password', env);
  const sslmode = normalizedSslMode(merged);
  const maxConnections = positiveIntegerConfigValue({
    connection: merged,
    key: 'maxConnections',
    connectionId: input.connectionId,
    defaultValue: 10,
  });

  if (!referencedUrl && !host) {
    throw new Error(`Native Redshift connector requires connections.${input.connectionId}.host or url`);
  }
  if (!database && !referencedUrl) {
    throw new Error(`Native Redshift connector requires connections.${input.connectionId}.database or url`);
  }
  if (!user && !referencedUrl) {
    throw new Error(`Native Redshift connector requires connections.${input.connectionId}.username, user, or url`);
  }

  const config: KtxRedshiftPoolConfig = {
    max: maxConnections,
    idleTimeoutMillis: 30_000,
    connectionTimeoutMillis: 10_000,
    ...(referencedUrl && sslmode !== 'prefer' && sslmode !== 'disable'
      ? { connectionString: referencedUrl }
      : { host, port: numberValue(merged.port) ?? 5439, database, user, password }),
  };
  const searchPathSchemas = searchPathSchemasFromConnection(merged);
  if (searchPathSchemas.length > 0) {
    config.options = `-c search_path=${searchPathSchemas.join(',')}`;
  }
  if (merged.ssl && sslmode !== 'prefer' && sslmode !== 'disable') {
    config.ssl = { rejectUnauthorized: merged.rejectUnauthorized ?? true };
  }
  return config;
}

export class KtxRedshiftScanConnector implements KtxScanConnector {
  readonly id: string;
  readonly driver = 'redshift' as const;
  readonly capabilities = createKtxConnectorCapabilities({
    tableSampling: true,
    columnSampling: true,
    columnStats: true,
    readOnlySql: true,
    nestedAnalysis: true,
    formalForeignKeys: true,
    estimatedRowCounts: true,
  });

  private readonly connectionId: string;
  private readonly connection: KtxRedshiftConnectionConfig;
  private readonly poolConfig: KtxRedshiftPoolConfig;
  private readonly poolFactory: KtxRedshiftPoolFactory;
  private readonly endpointResolver?: KtxRedshiftEndpointResolver;
  private readonly now: () => Date;
  private readonly dialect = getDialectForDriver('redshift');
  private pool: KtxRedshiftPool | null = null;
  private lastIdlePoolError: Error | null = null;
  private resolvedEndpoint: KtxRedshiftResolvedEndpoint | null = null;

  constructor(options: KtxRedshiftScanConnectorOptions) {
    this.connectionId = options.connectionId;
    this.connection = options.connection ?? {};
    this.poolConfig = redshiftPoolConfigFromConfig({
      connectionId: options.connectionId,
      connection: options.connection,
      env: options.env,
    });
    this.poolFactory = options.poolFactory ?? new DefaultRedshiftPoolFactory();
    this.endpointResolver = options.endpointResolver;
    this.now = options.now ?? (() => new Date());
    this.id = `redshift:${options.connectionId}`;
  }

  async testConnection(): Promise<KtxConnectorTestResult> {
    try {
      await this.query('SELECT 1');
      return { success: true };
    } catch (error) {
      return connectorTestFailure(error);
    }
  }

  async introspect(input: KtxScanInput, _ctx: KtxScanContext): Promise<KtxSchemaSnapshot> {
    this.assertConnection(input.connectionId);
    const schemas = schemasFromConnection(this.connection);
    const allTables: KtxSchemaTable[] = [];
    const snapshotWarnings: KtxScanWarning[] = [];
    for (const schema of schemas) {
      const scopedNames = input.tableScope ? scopedTableNames(input.tableScope, { catalog: null, db: schema }) : null;
      if (scopedNames && scopedNames.length === 0) continue;
      const tables = await this.loadSchemaTables(schema, scopedNames, snapshotWarnings);
      allTables.push(...tables);
    }
    return {
      connectionId: this.connectionId,
      driver: 'redshift',
      extractedAt: this.now().toISOString(),
      scope: { schemas },
      metadata: {
        database: this.poolConfig.database ?? this.connection.database ?? null,
        schemas,
        host: this.poolConfig.host ?? this.connection.host ?? null,
        table_count: allTables.length,
        total_columns: allTables.reduce((sum, table) => sum + table.columns.length, 0),
      },
      tables: allTables,
      warnings: snapshotWarnings,
    };
  }

  async sampleTable(input: KtxTableSampleInput, _ctx: KtxScanContext): Promise<KtxRedshiftTableSampleResult> {
    this.assertConnection(input.connectionId);
    const result = await this.query(this.dialect.generateSampleQuery(this.qTableName(input.table), input.limit, input.columns));
    return {
      headers: result.headers,
      headerTypes: result.headerTypes,
      rows: result.rows,
      totalRows: result.totalRows,
    };
  }

  async sampleColumn(input: KtxColumnSampleInput, _ctx: KtxScanContext): Promise<KtxColumnSampleResult> {
    this.assertConnection(input.connectionId);
    const result = await this.query(
      this.dialect.generateColumnSampleQuery(this.qTableName(input.table), input.column, input.limit),
    );
    const values = result.rows.filter((row) => row.length > 0 && row[0] !== null).map((row) => row[0]);
    return { values, nullCount: null, distinctCount: null };
  }

  async columnStats(input: KtxColumnStatsInput, _ctx: KtxScanContext): Promise<KtxColumnStatsResult | null> {
    const stats = await this.getColumnStatistics(input.table);
    const value = stats?.cardinalityByColumn.get(input.column);
    return value === undefined
      ? null
      : { min: null, max: null, average: null, nullCount: null, distinctCount: value };
  }

  async executeReadOnly(input: KtxRedshiftReadOnlyQueryInput, _ctx: KtxScanContext): Promise<KtxQueryResult> {
    this.assertConnection(input.connectionId);
    const limitedSql = limitSqlForExecution(assertReadOnlySql(input.sql), input.maxRows);
    const prepared = Array.isArray(input.params)
      ? { sql: limitedSql, params: input.params }
      : prepareRedshiftReadOnlyQuery(limitedSql, input.params);
    const result = await this.query(prepared.sql, prepared.params);
    return { ...result, rowCount: result.rows.length };
  }

  async getColumnDistinctValues(
    table: KtxTableRef,
    columnName: string,
    options: KtxRedshiftColumnDistinctValuesOptions,
  ): Promise<KtxRedshiftColumnDistinctValuesResult | null> {
    const sampleSize = options.sampleSize ?? 10000;
    const tableName = this.qTableName(table);
    const quotedColumn = this.dialect.quoteIdentifier(columnName);
    const cardinalityRows = await this.queryRaw<RedshiftCountRow>(
      this.dialect.generateCardinalitySampleQuery(tableName, quotedColumn, sampleSize),
    );
    const cardinality = finiteNumber(cardinalityRows[0]?.cardinality);
    if (cardinality === null) {
      return null;
    }
    if (cardinality === 0) {
      return { values: [], cardinality: 0 };
    }
    if (cardinality > options.maxCardinality) {
      return { values: null, cardinality };
    }
    const valuesRows = await this.queryRaw<RedshiftDistinctValueRow>(
      this.dialect.generateDistinctValuesQuery(tableName, quotedColumn, options.limit),
    );
    return {
      values: valuesRows.filter((row) => row.val !== null).map((row) => String(row.val)),
      cardinality,
    };
  }

  async getColumnStatistics(table: KtxTableRef): Promise<KtxRedshiftColumnStatisticsResult | null> {
    const schema = table.db ?? schemasFromConnection(this.connection)[0] ?? 'public';
    const sql = this.dialect.generateColumnStatisticsQuery(schema, table.name);
    if (!sql) {
      return null;
    }
    const rows = await this.queryRaw<RedshiftStatsRow>(sql);
    const cardinalityByColumn = new Map<string, number>();
    for (const row of rows) {
      const cardinality = finiteNumber(row.estimated_cardinality);
      if (cardinality !== null) {
        cardinalityByColumn.set(row.column_name, cardinality);
      }
    }
    return cardinalityByColumn.size > 0 ? { cardinalityByColumn } : null;
  }

  async getTableRowCount(table: string | RedshiftTableRef): Promise<number> {
    const tableRef =
      typeof table === 'string'
        ? { catalog: null, db: schemasFromConnection(this.connection)[0] ?? 'public', name: table }
        : table;
    const rows = await this.queryRaw<RedshiftCountRow>(`SELECT COUNT(*) AS count FROM ${this.qTableName(tableRef)}`);
    return finiteNumber(rows[0]?.count) ?? 0;
  }

  qTableName(table: RedshiftTableRef): string {
    return this.dialect.formatTableName(table);
  }

  quoteIdentifier(identifier: string): string {
    return this.dialect.quoteIdentifier(identifier);
  }

  async listSchemas(): Promise<string[]> {
    const rows = await this.queryRaw<RedshiftSchemaRow>(`
      SELECT schema_name
      FROM information_schema.schemata
      WHERE schema_name <> 'information_schema'
        AND schema_name NOT LIKE 'pg_%'
      ORDER BY schema_name
    `);
    return rows.map((row) => row.schema_name);
  }

  async listTables(schemas?: string[]): Promise<KtxTableListEntry[]> {
    const filterSchemas = schemas ?? (await this.listSchemas());
    if (filterSchemas.length === 0) return [];
    const rows = await this.queryRaw<RedshiftTableListRow>(
      `
      SELECT table_schema AS schema_name, table_name AS table_name,
        CASE WHEN table_type = 'VIEW' THEN 'v' ELSE 'r' END AS table_kind
      FROM svv_tables
      WHERE table_schema = ANY($1)
        AND table_type IN ('TABLE', 'VIEW', 'EXTERNAL TABLE')
      ORDER BY table_schema, table_name
      `,
      [filterSchemas],
    );
    return rows.map((row) => ({
      catalog: null,
      schema: row.schema_name,
      name: row.table_name,
      kind: row.table_kind === 'v' ? ('view' as const) : ('table' as const),
    }));
  }

  async cleanup(): Promise<void> {
    if (this.pool) {
      await this.pool.end();
      this.pool = null;
    }
    if (this.resolvedEndpoint?.close) {
      await this.resolvedEndpoint.close();
      this.resolvedEndpoint = null;
    }
  }

  private async loadSchemaTables(
    schema: string,
    scopedNames: readonly string[] | null,
    snapshotWarnings: KtxScanWarning[],
  ): Promise<KtxSchemaTable[]> {
    if (scopedNames && scopedNames.length === 0) return [];
    const svvTableScopeClause = scopedNames ? 'AND t.table_name = ANY($2)' : '';
    const svvColumnScopeClause = scopedNames ? 'AND table_name = ANY($2)' : '';
    const tableConstraintScopeClause = scopedNames ? 'AND tc.table_name = ANY($2)' : '';
    const scopeValues = scopedNames ? [scopedNames] : [];
    const tables = await this.queryRaw<RedshiftTableRow>(
      `
      SELECT
        t.table_name AS table_name,
        CASE WHEN t.table_type = 'VIEW' THEN 'v' ELSE 'r' END AS table_kind,
        ti.tbl_rows AS row_count,
        t.remarks AS table_comment
      FROM svv_tables t
      LEFT JOIN svv_table_info ti
        ON ti.schema = t.table_schema AND ti.\"table\" = t.table_name
      WHERE t.table_schema = $1
        AND t.table_type IN ('TABLE', 'VIEW', 'EXTERNAL TABLE')
        ${svvTableScopeClause}
      ORDER BY t.table_name
      `,
      [schema, ...scopeValues],
    );
    const columns = await this.queryRaw<RedshiftColumnRow>(
      `
      SELECT
        table_name AS table_name,
        column_name AS column_name,
        data_type AS data_type,
        CASE WHEN is_nullable = 'YES' THEN TRUE ELSE FALSE END AS is_nullable,
        remarks AS column_comment
      FROM svv_columns
      WHERE table_schema = $1
        ${svvColumnScopeClause}
      ORDER BY table_name, ordinal_position
      `,
      [schema, ...scopeValues],
    );
    const primaryKeysResult = await tryConstraintQuery(
      { schema, kind: 'primary_key', isDeniedError },
      () =>
        this.queryRaw<RedshiftPrimaryKeyRow>(
          `
      SELECT tc.table_name, kcu.column_name
      FROM information_schema.table_constraints tc
      JOIN information_schema.key_column_usage kcu
        ON tc.constraint_name = kcu.constraint_name
        AND tc.table_schema = kcu.table_schema
      WHERE tc.constraint_type = 'PRIMARY KEY'
        AND tc.table_schema = $1
        ${tableConstraintScopeClause}
      ORDER BY tc.table_name, kcu.ordinal_position
      `,
          [schema, ...scopeValues],
        ),
    );
    const primaryKeys = primaryKeysResult.ok ? primaryKeysResult.value : [];
    if (!primaryKeysResult.ok) {
      snapshotWarnings.push(primaryKeysResult.warning);
    }
    const foreignKeysResult = await tryConstraintQuery(
      { schema, kind: 'foreign_key', isDeniedError },
      () =>
        this.queryRaw<RedshiftForeignKeyRow>(
          `
      SELECT
        tc.table_name,
        kcu.column_name,
        ccu.table_schema AS foreign_table_schema,
        ccu.table_name AS foreign_table_name,
        ccu.column_name AS foreign_column_name,
        tc.constraint_name
      FROM information_schema.table_constraints AS tc
      JOIN information_schema.key_column_usage AS kcu
        ON tc.constraint_name = kcu.constraint_name
        AND tc.table_schema = kcu.table_schema
      JOIN information_schema.constraint_column_usage AS ccu
        ON ccu.constraint_name = tc.constraint_name
        AND ccu.table_schema = tc.table_schema
      WHERE tc.constraint_type = 'FOREIGN KEY'
        AND tc.table_schema = $1
        ${tableConstraintScopeClause}
      ORDER BY tc.table_name, kcu.column_name
      `,
          [schema, ...scopeValues],
        ),
    );
    const foreignKeys = foreignKeysResult.ok ? foreignKeysResult.value : [];
    if (!foreignKeysResult.ok) {
      snapshotWarnings.push(foreignKeysResult.warning);
    }

    const columnsByTable = groupByTable(columns);
    const primaryKeysByTable = primaryKeyMap(primaryKeys);
    const foreignKeysByTable = groupByTable(foreignKeys);
    return tables.map((table) =>
      this.toSchemaTable(
        schema,
        table,
        columnsByTable.get(table.table_name) ?? [],
        primaryKeysByTable.get(table.table_name) ?? new Set<string>(),
        foreignKeysByTable.get(table.table_name) ?? [],
      ),
    );
  }

  private toSchemaTable(
    schema: string,
    table: RedshiftTableRow,
    columns: RedshiftColumnRow[],
    primaryKeys: Set<string>,
    foreignKeys: RedshiftForeignKeyRow[],
  ): KtxSchemaTable {
    const kind = table.table_kind === 'v' ? 'view' : 'table';
    return {
      catalog: null,
      db: schema,
      name: table.table_name,
      kind,
      comment: table.table_comment || null,
      estimatedRows: kind === 'view' ? null : finiteNumber(table.row_count),
      columns: columns.map((column) => this.toSchemaColumn(column, primaryKeys)),
      foreignKeys: foreignKeys.map((foreignKey) => this.toSchemaForeignKey(foreignKey)),
    };
  }

  private toSchemaColumn(column: RedshiftColumnRow, primaryKeys: Set<string>): KtxSchemaColumn {
    return {
      name: column.column_name,
      nativeType: column.data_type,
      normalizedType: this.dialect.mapDataType(column.data_type),
      dimensionType: this.dialect.mapToDimensionType(column.data_type),
      nullable: column.is_nullable,
      primaryKey: primaryKeys.has(column.column_name),
      comment: column.column_comment || null,
    };
  }

  private toSchemaForeignKey(row: RedshiftForeignKeyRow): KtxSchemaForeignKey {
    return {
      fromColumn: row.column_name,
      toCatalog: null,
      toDb: row.foreign_table_schema,
      toTable: row.foreign_table_name,
      toColumn: row.foreign_column_name,
      constraintName: row.constraint_name || null,
    };
  }

  private async getPool(): Promise<KtxRedshiftPool> {
    if (!this.pool) {
      let config = { ...this.poolConfig };
      if (this.endpointResolver) {
        const endpoint = await this.endpointResolver.resolve({
          host: config.host ?? this.connection.host ?? 'localhost',
          port: config.port ?? numberValue(this.connection.port) ?? 5439,
          connection: this.connection,
        });
        this.resolvedEndpoint = endpoint;
        config = { ...config, host: endpoint.host, port: endpoint.port };
      }
      this.pool = this.poolFactory.createPool(config);
      this.pool.on?.('error', (error) => {
        this.lastIdlePoolError = error;
      });
    }
    return this.pool;
  }

  private async queryRaw<T>(sql: string, params?: unknown[]): Promise<T[]> {
    this.throwIdlePoolErrorIfPresent();
    const pool = await this.getPool();
    const client = await pool.connect();
    try {
      const result = await client.query(sql, params);
      return result.rows as T[];
    } finally {
      client.release();
    }
  }

  private async query(sql: string, params?: Record<string, unknown> | unknown[]): Promise<KtxQueryResult> {
    this.throwIdlePoolErrorIfPresent();
    const pool = await this.getPool();
    const client = await pool.connect();
    try {
      const result = await client.query(assertReadOnlySql(sql), Array.isArray(params) ? params : undefined);
      return {
        headers: (result.fields ?? []).map((field) => field.name),
        headerTypes: (result.fields ?? []).map((field) => REDSHIFT_OID_TYPE_MAP[field.dataTypeID] ?? `oid:${field.dataTypeID}`),
        rows: queryRows(result),
        totalRows: result.rows.length,
        rowCount: result.rows.length,
      };
    } finally {
      client.release();
    }
  }

  private assertConnection(connectionId: string): void {
    if (connectionId !== this.connectionId) {
      throw new Error(`Redshift connector ${this.connectionId} cannot run scan for ${connectionId}`);
    }
  }

  private throwIdlePoolErrorIfPresent(): void {
    if (!this.lastIdlePoolError) {
      return;
    }
    const error = this.lastIdlePoolError;
    this.lastIdlePoolError = null;
    throw error;
  }
}
