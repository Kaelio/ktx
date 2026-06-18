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

const PG_OID_TYPE_MAP: Record<number, string> = {
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

export interface KtxPostgresConnectionConfig {
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

export interface KtxPostgresPoolConfig {
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

interface KtxPostgresQueryResult {
  fields?: Array<{ name: string; dataTypeID: number }>;
  rows: Record<string, unknown>[];
}

interface KtxPostgresClient {
  query(sql: string, params?: unknown[]): Promise<KtxPostgresQueryResult>;
  release(): void;
}

interface KtxPostgresPool {
  connect(): Promise<KtxPostgresClient>;
  end(): Promise<void>;
  on?(event: 'error', listener: (error: Error) => void): void;
}

export interface KtxPostgresPoolFactory {
  createPool(config: KtxPostgresPoolConfig): KtxPostgresPool;
}

interface KtxPostgresResolvedEndpoint {
  host: string;
  port: number;
  close?: () => Promise<void>;
}

export interface KtxPostgresEndpointResolver {
  resolve(input: {
    host: string;
    port: number;
    connection: KtxPostgresConnectionConfig;
  }): Promise<KtxPostgresResolvedEndpoint>;
}

export interface KtxPostgresScanConnectorOptions {
  connectionId: string;
  connection: KtxPostgresConnectionConfig | undefined;
  poolFactory?: KtxPostgresPoolFactory;
  endpointResolver?: KtxPostgresEndpointResolver;
  env?: NodeJS.ProcessEnv;
  now?: () => Date;
}

export interface KtxPostgresReadOnlyQueryInput extends KtxReadOnlyQueryInput {
  params?: Record<string, unknown> | unknown[];
}

export interface KtxPostgresColumnDistinctValuesOptions {
  maxCardinality: number;
  limit: number;
  sampleSize?: number;
}

export interface KtxPostgresColumnDistinctValuesResult {
  values: string[] | null;
  cardinality: number;
}

export interface KtxPostgresColumnStatisticsResult {
  cardinalityByColumn: Map<string, number>;
}

export interface KtxPostgresTableSampleResult extends KtxTableSampleResult {
  headerTypes?: string[];
}

type PostgresTableRef = Pick<KtxTableRef, 'name'> & Partial<Pick<KtxTableRef, 'catalog' | 'db'>>;

interface PostgresTableRow {
  table_name: string;
  table_kind: string;
  row_count: unknown;
  table_comment: string | null;
}

interface PostgresColumnRow {
  table_name: string;
  column_name: string;
  data_type: string;
  is_nullable: boolean;
  column_comment: string | null;
}

interface PostgresPrimaryKeyRow {
  table_name: string;
  column_name: string;
}

interface PostgresForeignKeyRow {
  table_name: string;
  column_name: string;
  foreign_table_schema: string | null;
  foreign_table_name: string;
  foreign_column_name: string;
  constraint_name: string | null;
}

interface PostgresSchemaRow {
  schema_name: string;
}

interface PostgresTableListRow {
  schema_name: string;
  table_name: string;
  table_kind: string;
}

interface PostgresCountRow {
  count?: unknown;
  cardinality?: unknown;
}

interface PostgresDistinctValueRow {
  val: unknown;
}

interface PostgresStatsRow {
  column_name: string;
  estimated_cardinality: unknown;
}

class DefaultPostgresPoolFactory implements KtxPostgresPoolFactory {
  createPool(config: KtxPostgresPoolConfig): KtxPostgresPool {
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
export function preparePostgresReadOnlyQuery(
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

function primaryKeyMap(rows: PostgresPrimaryKeyRow[]): Map<string, Set<string>> {
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

function queryRows(result: KtxPostgresQueryResult): unknown[][] {
  const headers = (result.fields ?? []).map((field) => field.name);
  return result.rows.map((row) => headers.map((header) => row[header]));
}

function finiteNumber(value: unknown): number | null {
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : null;
}

function stringConfigValue(
  connection: KtxPostgresConnectionConfig | undefined,
  key: keyof KtxPostgresConnectionConfig,
  env: NodeJS.ProcessEnv,
): string | undefined {
  const value = connection?.[key];
  return typeof value === 'string' && value.trim().length > 0 ? resolveStringReference(value.trim(), env) : undefined;
}


function numberValue(value: unknown): number | undefined {
  return typeof value === 'number' && Number.isFinite(value) ? value : undefined;
}

function positiveIntegerConfigValue(input: {
  connection: KtxPostgresConnectionConfig;
  key: keyof KtxPostgresConnectionConfig;
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

function parsePostgresUrl(url: string): Partial<KtxPostgresConnectionConfig> {
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

function normalizedSslMode(connection: KtxPostgresConnectionConfig): string | undefined {
  const value = connection.sslmode ?? connection.sslMode;
  return typeof value === 'string' && value.trim().length > 0 ? value.trim().toLowerCase() : undefined;
}

function schemasFromConnection(connection: KtxPostgresConnectionConfig): string[] {
  if (Array.isArray(connection.schemas) && connection.schemas.length > 0) {
    return connection.schemas.filter((schema): schema is string => typeof schema === 'string' && schema.length > 0);
  }
  return typeof connection.schema === 'string' && connection.schema.length > 0 ? [connection.schema] : ['public'];
}

function searchPathSchemasFromConnection(connection: KtxPostgresConnectionConfig): string[] {
  const schemas = schemasFromConnection(connection);
  return schemas.includes('public') ? schemas : [...schemas, 'public'];
}

export function isKtxPostgresConnectionConfig(
  connection: KtxPostgresConnectionConfig | undefined,
): connection is KtxPostgresConnectionConfig {
  const driver = String(connection?.driver ?? '').toLowerCase();
  return driver === 'postgres';
}

/** @internal */
export function postgresPoolConfigFromConfig(input: {
  connectionId: string;
  connection: KtxPostgresConnectionConfig | undefined;
  env?: NodeJS.ProcessEnv;
}): KtxPostgresPoolConfig {
  const inputDriver = input.connection?.driver ?? 'unknown';
  if (!isKtxPostgresConnectionConfig(input.connection)) {
    throw new Error(`Native PostgreSQL connector cannot run driver "${inputDriver}"`);
  }

  const env = input.env ?? process.env;
  const referencedUrl = stringConfigValue(input.connection, 'url', env);
  const urlConfig = referencedUrl ? parsePostgresUrl(referencedUrl) : {};
  const merged: KtxPostgresConnectionConfig = { ...urlConfig, ...input.connection };
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
    throw new Error(`Native PostgreSQL connector requires connections.${input.connectionId}.host or url`);
  }
  if (!database && !referencedUrl) {
    throw new Error(`Native PostgreSQL connector requires connections.${input.connectionId}.database or url`);
  }
  if (!user && !referencedUrl) {
    throw new Error(`Native PostgreSQL connector requires connections.${input.connectionId}.username, user, or url`);
  }

  const config: KtxPostgresPoolConfig = {
    max: maxConnections,
    idleTimeoutMillis: 30_000,
    connectionTimeoutMillis: 10_000,
    ...(referencedUrl && sslmode !== 'prefer' && sslmode !== 'disable'
      ? { connectionString: referencedUrl }
      : { host, port: numberValue(merged.port) ?? 5432, database, user, password }),
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

export class KtxPostgresScanConnector implements KtxScanConnector {
  readonly id: string;
  readonly driver = 'postgres' as const;
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
  private readonly connection: KtxPostgresConnectionConfig;
  private readonly poolConfig: KtxPostgresPoolConfig;
  private readonly poolFactory: KtxPostgresPoolFactory;
  private readonly endpointResolver?: KtxPostgresEndpointResolver;
  private readonly now: () => Date;
  private readonly dialect = getDialectForDriver('postgres');
  private pool: KtxPostgresPool | null = null;
  private lastIdlePoolError: Error | null = null;
  private resolvedEndpoint: KtxPostgresResolvedEndpoint | null = null;

  constructor(options: KtxPostgresScanConnectorOptions) {
    this.connectionId = options.connectionId;
    this.connection = options.connection ?? {};
    this.poolConfig = postgresPoolConfigFromConfig({
      connectionId: options.connectionId,
      connection: options.connection,
      env: options.env,
    });
    this.poolFactory = options.poolFactory ?? new DefaultPostgresPoolFactory();
    this.endpointResolver = options.endpointResolver;
    this.now = options.now ?? (() => new Date());
    this.id = `postgres:${options.connectionId}`;
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
      driver: 'postgres',
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

  async sampleTable(input: KtxTableSampleInput, _ctx: KtxScanContext): Promise<KtxPostgresTableSampleResult> {
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

  async executeReadOnly(input: KtxPostgresReadOnlyQueryInput, _ctx: KtxScanContext): Promise<KtxQueryResult> {
    this.assertConnection(input.connectionId);
    const limitedSql = limitSqlForExecution(assertReadOnlySql(input.sql), input.maxRows);
    const prepared = Array.isArray(input.params)
      ? { sql: limitedSql, params: input.params }
      : preparePostgresReadOnlyQuery(limitedSql, input.params);
    const result = await this.query(prepared.sql, prepared.params);
    return { ...result, rowCount: result.rows.length };
  }

  async getColumnDistinctValues(
    table: KtxTableRef,
    columnName: string,
    options: KtxPostgresColumnDistinctValuesOptions,
  ): Promise<KtxPostgresColumnDistinctValuesResult | null> {
    const sampleSize = options.sampleSize ?? 10000;
    const tableName = this.qTableName(table);
    const quotedColumn = this.dialect.quoteIdentifier(columnName);
    const cardinalityRows = await this.queryRaw<PostgresCountRow>(
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
    const valuesRows = await this.queryRaw<PostgresDistinctValueRow>(
      this.dialect.generateDistinctValuesQuery(tableName, quotedColumn, options.limit),
    );
    return {
      values: valuesRows.filter((row) => row.val !== null).map((row) => String(row.val)),
      cardinality,
    };
  }

  async getColumnStatistics(table: KtxTableRef): Promise<KtxPostgresColumnStatisticsResult | null> {
    const schema = table.db ?? schemasFromConnection(this.connection)[0] ?? 'public';
    const sql = this.dialect.generateColumnStatisticsQuery(schema, table.name);
    if (!sql) {
      return null;
    }
    const rows = await this.queryRaw<PostgresStatsRow>(sql);
    const cardinalityByColumn = new Map<string, number>();
    for (const row of rows) {
      const cardinality = finiteNumber(row.estimated_cardinality);
      if (cardinality !== null) {
        cardinalityByColumn.set(row.column_name, cardinality);
      }
    }
    return cardinalityByColumn.size > 0 ? { cardinalityByColumn } : null;
  }

  async getTableRowCount(table: string | PostgresTableRef): Promise<number> {
    const tableRef =
      typeof table === 'string'
        ? { catalog: null, db: schemasFromConnection(this.connection)[0] ?? 'public', name: table }
        : table;
    const rows = await this.queryRaw<PostgresCountRow>(`SELECT COUNT(*) AS count FROM ${this.qTableName(tableRef)}`);
    return finiteNumber(rows[0]?.count) ?? 0;
  }

  qTableName(table: PostgresTableRef): string {
    return this.dialect.formatTableName(table);
  }

  quoteIdentifier(identifier: string): string {
    return this.dialect.quoteIdentifier(identifier);
  }

  async listSchemas(): Promise<string[]> {
    const rows = await this.queryRaw<PostgresSchemaRow>(`
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
    const rows = await this.queryRaw<PostgresTableListRow>(
      `
      SELECT n.nspname AS schema_name, c.relname AS table_name, c.relkind AS table_kind
      FROM pg_catalog.pg_class c
      JOIN pg_catalog.pg_namespace n ON c.relnamespace = n.oid
      WHERE n.nspname = ANY($1)
        AND c.relkind IN ('r', 'v')
      ORDER BY n.nspname, c.relname
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
    const pgCatalogScopeClause = scopedNames ? 'AND c.relname = ANY($2)' : '';
    const tableConstraintScopeClause = scopedNames ? 'AND tc.table_name = ANY($2)' : '';
    const scopeValues = scopedNames ? [scopedNames] : [];
    const tables = await this.queryRaw<PostgresTableRow>(
      `
      SELECT
        c.relname AS table_name,
        c.relkind AS table_kind,
        c.reltuples::bigint AS row_count,
        d.description AS table_comment
      FROM pg_catalog.pg_class c
      JOIN pg_catalog.pg_namespace n ON c.relnamespace = n.oid
      LEFT JOIN pg_catalog.pg_description d
        ON d.objoid = c.oid AND d.objsubid = 0
      WHERE n.nspname = $1
        AND c.relkind IN ('r', 'v')
        ${pgCatalogScopeClause}
      ORDER BY c.relname
      `,
      [schema, ...scopeValues],
    );
    const columns = await this.queryRaw<PostgresColumnRow>(
      `
      SELECT
        c.relname AS table_name,
        a.attname AS column_name,
        format_type(a.atttypid, a.atttypmod) AS data_type,
        NOT a.attnotnull AS is_nullable,
        d.description AS column_comment
      FROM pg_catalog.pg_attribute a
      JOIN pg_catalog.pg_class c ON a.attrelid = c.oid
      JOIN pg_catalog.pg_namespace n ON c.relnamespace = n.oid
      LEFT JOIN pg_catalog.pg_description d
        ON d.objoid = c.oid AND d.objsubid = a.attnum
      WHERE n.nspname = $1
        AND c.relkind IN ('r', 'v')
        AND a.attnum > 0
        AND NOT a.attisdropped
        ${pgCatalogScopeClause}
      ORDER BY c.relname, a.attnum
      `,
      [schema, ...scopeValues],
    );
    const primaryKeysResult = await tryConstraintQuery(
      { schema, kind: 'primary_key', isDeniedError },
      () =>
        this.queryRaw<PostgresPrimaryKeyRow>(
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
        this.queryRaw<PostgresForeignKeyRow>(
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
    table: PostgresTableRow,
    columns: PostgresColumnRow[],
    primaryKeys: Set<string>,
    foreignKeys: PostgresForeignKeyRow[],
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

  private toSchemaColumn(column: PostgresColumnRow, primaryKeys: Set<string>): KtxSchemaColumn {
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

  private toSchemaForeignKey(row: PostgresForeignKeyRow): KtxSchemaForeignKey {
    return {
      fromColumn: row.column_name,
      toCatalog: null,
      toDb: row.foreign_table_schema,
      toTable: row.foreign_table_name,
      toColumn: row.foreign_column_name,
      constraintName: row.constraint_name || null,
    };
  }

  private async getPool(): Promise<KtxPostgresPool> {
    if (!this.pool) {
      let config = { ...this.poolConfig };
      if (this.endpointResolver) {
        const endpoint = await this.endpointResolver.resolve({
          host: config.host ?? this.connection.host ?? 'localhost',
          port: config.port ?? numberValue(this.connection.port) ?? 5432,
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
        headerTypes: (result.fields ?? []).map((field) => PG_OID_TYPE_MAP[field.dataTypeID] ?? `oid:${field.dataTypeID}`),
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
      throw new Error(`PostgreSQL connector ${this.connectionId} cannot run scan for ${connectionId}`);
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
