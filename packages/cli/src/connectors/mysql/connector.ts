import mysql, { type FieldPacket, type Pool, type RowDataPacket } from 'mysql2/promise';
import { getDialectForDriver } from '../../context/connections/dialects.js';
import { resolveStringReference } from '../shared/string-reference.js';
import { assertReadOnlySql, limitSqlForExecution } from '../../context/connections/read-only-sql.js';
import {
  constraintDiscoveryWarning,
  tryConstraintQuery,
  type ConstraintDiscoveryKind,
} from '../../context/scan/constraint-discovery.js';
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

export interface KtxMysqlConnectionConfig {
  driver?: string;
  host?: string;
  port?: number;
  database?: string;
  schemas?: string[];
  username?: string;
  user?: string;
  password?: string;
  url?: string;
  ssl?: boolean | { rejectUnauthorized?: boolean };
  maxConnections?: number;
  [key: string]: unknown;
}

export interface KtxMysqlPoolConfig {
  host: string;
  port: number;
  database: string;
  user: string;
  password?: string;
  connectionLimit: number;
  waitForConnections: true;
  ssl?: { rejectUnauthorized: boolean };
}

interface KtxMysqlConnection {
  query(sql: string, params?: unknown): Promise<[RowDataPacket[], FieldPacket[]]>;
  release(): void;
}

interface KtxMysqlPool {
  getConnection(): Promise<KtxMysqlConnection>;
  end(): Promise<void>;
}

export interface KtxMysqlPoolFactory {
  createPool(config: KtxMysqlPoolConfig): KtxMysqlPool;
}

interface KtxMysqlResolvedEndpoint {
  host: string;
  port: number;
  close?: () => Promise<void>;
}

export interface KtxMysqlEndpointResolver {
  resolve(input: { host: string; port: number; connection: KtxMysqlConnectionConfig }): Promise<KtxMysqlResolvedEndpoint>;
}

export interface KtxMysqlScanConnectorOptions {
  connectionId: string;
  connection: KtxMysqlConnectionConfig | undefined;
  poolFactory?: KtxMysqlPoolFactory;
  endpointResolver?: KtxMysqlEndpointResolver;
  env?: NodeJS.ProcessEnv;
  now?: () => Date;
}

export interface KtxMysqlReadOnlyQueryInput extends KtxReadOnlyQueryInput {
  params?: Record<string, unknown> | unknown[];
}

export interface KtxMysqlColumnDistinctValuesOptions {
  maxCardinality: number;
  limit: number;
  sampleSize?: number;
}

export interface KtxMysqlColumnDistinctValuesResult {
  values: string[] | null;
  cardinality: number;
}

interface MysqlTableRow extends RowDataPacket {
  TABLE_SCHEMA: string;
  TABLE_NAME: string;
  TABLE_TYPE: string;
  TABLE_COMMENT: string | null;
  TABLE_ROWS: number | null;
}

interface MysqlColumnRow extends RowDataPacket {
  TABLE_SCHEMA: string;
  TABLE_NAME: string;
  COLUMN_NAME: string;
  DATA_TYPE: string;
  IS_NULLABLE: string;
  COLUMN_COMMENT: string | null;
}

interface MysqlPrimaryKeyRow extends RowDataPacket {
  TABLE_SCHEMA: string;
  TABLE_NAME: string;
  COLUMN_NAME: string;
}

interface MysqlForeignKeyRow extends RowDataPacket {
  TABLE_SCHEMA: string;
  TABLE_NAME: string;
  COLUMN_NAME: string;
  REFERENCED_TABLE_NAME: string;
  REFERENCED_COLUMN_NAME: string;
  CONSTRAINT_NAME: string;
}

interface MysqlSchemaRow extends RowDataPacket {
  SCHEMA_NAME: string;
}

interface MysqlTableListRow extends RowDataPacket {
  TABLE_SCHEMA: string;
  TABLE_NAME: string;
  TABLE_TYPE: string;
}

interface MysqlCountRow extends RowDataPacket {
  count?: unknown;
  cardinality?: unknown;
}

interface MysqlDistinctValueRow extends RowDataPacket {
  val: unknown;
}

interface MysqlStatsRow extends RowDataPacket {
  column_name: string;
  estimated_cardinality: number | null;
}

export interface KtxMysqlColumnStatisticsResult {
  cardinalityByColumn: Map<string, number>;
}

class DefaultMysqlPoolFactory implements KtxMysqlPoolFactory {
  createPool(config: KtxMysqlPoolConfig): KtxMysqlPool {
    return mysql.createPool(config) as Pool;
  }
}

function stringConfigValue(
  connection: KtxMysqlConnectionConfig | undefined,
  key: keyof KtxMysqlConnectionConfig,
  env: NodeJS.ProcessEnv,
): string | undefined {
  const value = connection?.[key];
  return typeof value === 'string' && value.trim().length > 0 ? resolveStringReference(value.trim(), env) : undefined;
}

function maybeNumber(value: unknown): number | undefined {
  return typeof value === 'number' && Number.isFinite(value) ? value : undefined;
}

function positiveIntegerConfigValue(input: {
  connection: KtxMysqlConnectionConfig;
  key: keyof KtxMysqlConnectionConfig;
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

function parseMysqlUrl(url: string): Partial<KtxMysqlConnectionConfig> {
  const parsed = new URL(url);
  const sslParam = parsed.searchParams.get('ssl') ?? parsed.searchParams.get('sslmode');
  return {
    host: parsed.hostname,
    port: parsed.port ? Number(parsed.port) : undefined,
    database: parsed.pathname.replace(/^\/+/, '') || undefined,
    username: parsed.username ? decodeURIComponent(parsed.username) : undefined,
    password: parsed.password ? decodeURIComponent(parsed.password) : undefined,
    ssl: sslParam === 'true' || sslParam === 'required',
  };
}

function cleanMySqlTableComment(comment: string | null): string | null {
  if (!comment) {
    return null;
  }
  if (comment.startsWith('InnoDB free:')) {
    const semiIndex = comment.indexOf(';');
    if (semiIndex === -1) {
      return null;
    }
    const userComment = comment.slice(semiIndex + 1).trim();
    return userComment || null;
  }
  return comment;
}

function configuredMysqlSchemas(connection: KtxMysqlConnectionConfig, fallbackDatabase: string): string[] {
  if (Array.isArray(connection.schemas) && connection.schemas.length > 0) {
    const selected = connection.schemas
      .filter((schema): schema is string => typeof schema === 'string' && schema.trim().length > 0)
      .map((schema) => schema.trim());
    if (selected.length > 0) {
      return [...new Set(selected)];
    }
  }
  return [fallbackDatabase];
}

function mysqlTableKey(schema: string, table: string): string {
  return `${schema}.${table}`;
}

function groupByTable<T extends { TABLE_SCHEMA?: string; TABLE_NAME: string }>(
  rows: T[],
  fallbackDatabase: string,
): Map<string, T[]> {
  const grouped = new Map<string, T[]>();
  for (const row of rows) {
    const tableRows = grouped.get(mysqlTableKey(row.TABLE_SCHEMA ?? fallbackDatabase, row.TABLE_NAME)) ?? [];
    tableRows.push(row);
    grouped.set(mysqlTableKey(row.TABLE_SCHEMA ?? fallbackDatabase, row.TABLE_NAME), tableRows);
  }
  return grouped;
}

function primaryKeyMap(rows: MysqlPrimaryKeyRow[], fallbackDatabase: string): Map<string, Set<string>> {
  const grouped = new Map<string, Set<string>>();
  for (const row of rows) {
    const key = mysqlTableKey(row.TABLE_SCHEMA ?? fallbackDatabase, row.TABLE_NAME);
    const columns = grouped.get(key) ?? new Set<string>();
    columns.add(row.COLUMN_NAME);
    grouped.set(key, columns);
  }
  return grouped;
}

function isDeniedError(error: unknown): boolean {
  if (!error || typeof error !== 'object') {
    return false;
  }
  const code = (error as { code?: unknown }).code;
  return (
    code === 'ER_TABLEACCESS_DENIED_ERROR' ||
    code === 'ER_SPECIFIC_ACCESS_DENIED_ERROR' ||
    code === 'ER_DBACCESS_DENIED_ERROR'
  );
}

function pushConstraintWarnings(
  warnings: KtxScanWarning[],
  schemas: readonly string[],
  kind: ConstraintDiscoveryKind,
): void {
  for (const schema of schemas) {
    warnings.push(constraintDiscoveryWarning({ schema, kind }));
  }
}

function queryParams(params: Record<string, unknown> | unknown[] | undefined): unknown[] | undefined {
  if (!params) {
    return undefined;
  }
  return Array.isArray(params) ? params : Object.values(params);
}

/** @internal */
export function prepareMysqlReadOnlyQuery(
  sql: string,
  params?: Record<string, unknown>,
): { sql: string; params?: unknown[] } {
  if (!params) {
    return { sql, params: undefined };
  }
  const values: unknown[] = [];
  const parameterizedQuery = sql.replace(/:([A-Za-z_][A-Za-z0-9_]*)\b/g, (placeholder, key: string) => {
    if (!(key in params)) {
      return placeholder;
    }
    values.push(params[key]);
    return '?';
  });
  return { sql: parameterizedQuery, params: values };
}

export function isKtxMysqlConnectionConfig(
  connection: KtxMysqlConnectionConfig | undefined,
): connection is KtxMysqlConnectionConfig {
  return String(connection?.driver ?? '').toLowerCase() === 'mysql';
}

/** @internal */
export function mysqlConnectionPoolConfigFromConfig(input: {
  connectionId: string;
  connection: KtxMysqlConnectionConfig | undefined;
  env?: NodeJS.ProcessEnv;
}): KtxMysqlPoolConfig {
  const inputDriver = input.connection?.driver ?? 'unknown';
  if (!isKtxMysqlConnectionConfig(input.connection)) {
    throw new Error(`Native MySQL connector cannot run driver "${inputDriver}"`);
  }

  const env = input.env ?? process.env;
  const referencedUrl = stringConfigValue(input.connection, 'url', env);
  const urlConfig = referencedUrl ? parseMysqlUrl(referencedUrl) : {};
  const merged: KtxMysqlConnectionConfig = { ...urlConfig, ...input.connection };
  const host = stringConfigValue(merged, 'host', env);
  const database = stringConfigValue(merged, 'database', env);
  const user = stringConfigValue(merged, 'username', env) ?? stringConfigValue(merged, 'user', env);
  const maxConnections = positiveIntegerConfigValue({
    connection: merged,
    key: 'maxConnections',
    connectionId: input.connectionId,
    defaultValue: 10,
  });

  if (!host) {
    throw new Error(`Native MySQL connector requires connections.${input.connectionId}.host or url`);
  }
  if (!database) {
    throw new Error(`Native MySQL connector requires connections.${input.connectionId}.database or url`);
  }
  if (!user) {
    throw new Error(`Native MySQL connector requires connections.${input.connectionId}.username, user, or url`);
  }

  const ssl = merged.ssl === true ? { rejectUnauthorized: false } : typeof merged.ssl === 'object' ? merged.ssl : undefined;
  return {
    host,
    port: maybeNumber(merged.port) ?? 3306,
    database,
    user,
    password: stringConfigValue(merged, 'password', env),
    connectionLimit: maxConnections,
    waitForConnections: true,
    ...(ssl ? { ssl: { rejectUnauthorized: ssl.rejectUnauthorized ?? false } } : {}),
  };
}

export class KtxMysqlScanConnector implements KtxScanConnector {
  readonly id: string;
  readonly driver = 'mysql' as const;
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
  private readonly connection: KtxMysqlConnectionConfig;
  private readonly poolConfig: KtxMysqlPoolConfig;
  private readonly poolFactory: KtxMysqlPoolFactory;
  private readonly endpointResolver?: KtxMysqlEndpointResolver;
  private readonly now: () => Date;
  private readonly dialect = getDialectForDriver('mysql');
  private pool: KtxMysqlPool | null = null;
  private resolvedEndpoint: KtxMysqlResolvedEndpoint | null = null;

  constructor(options: KtxMysqlScanConnectorOptions) {
    this.connectionId = options.connectionId;
    this.connection = options.connection ?? {};
    this.poolConfig = mysqlConnectionPoolConfigFromConfig({
      connectionId: options.connectionId,
      connection: options.connection,
      env: options.env,
    });
    this.poolFactory = options.poolFactory ?? new DefaultMysqlPoolFactory();
    this.endpointResolver = options.endpointResolver;
    this.now = options.now ?? (() => new Date());
    this.id = `mysql:${options.connectionId}`;
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
    const databases = configuredMysqlSchemas(this.connection, this.poolConfig.database);
    const snapshotWarnings: KtxScanWarning[] = [];
    const placeholders = databases.map(() => '?').join(', ');
    let allScopedTables: string[] | null = null;
    if (input.tableScope) {
      allScopedTables = [];
      for (const database of databases) {
        allScopedTables.push(...scopedTableNames(input.tableScope, { catalog: null, db: database }));
      }
      if (allScopedTables.length === 0) {
        return this.emptySnapshot(databases);
      }
    }
    const tableNameClause = allScopedTables
      ? `AND TABLE_NAME IN (${allScopedTables.map(() => '?').join(', ')})`
      : '';
    const tableNameParams = allScopedTables ?? [];
    const tables = await this.queryRaw<MysqlTableRow>(
      `
      SELECT TABLE_SCHEMA, TABLE_NAME, TABLE_TYPE, TABLE_COMMENT, TABLE_ROWS
      FROM INFORMATION_SCHEMA.TABLES
      WHERE TABLE_SCHEMA IN (${placeholders}) AND TABLE_TYPE IN ('BASE TABLE', 'VIEW') ${tableNameClause}
      ORDER BY TABLE_SCHEMA, TABLE_NAME
      `,
      [...databases, ...tableNameParams],
    );
    const columns = await this.queryRaw<MysqlColumnRow>(
      `
      SELECT TABLE_SCHEMA, TABLE_NAME, COLUMN_NAME, DATA_TYPE, IS_NULLABLE, COLUMN_COMMENT
      FROM INFORMATION_SCHEMA.COLUMNS
      WHERE TABLE_SCHEMA IN (${placeholders}) ${tableNameClause}
      ORDER BY TABLE_SCHEMA, TABLE_NAME, ORDINAL_POSITION
      `,
      [...databases, ...tableNameParams],
    );
    const primaryKeysResult = await tryConstraintQuery(
      { schema: databases[0] ?? this.poolConfig.database, kind: 'primary_key', isDeniedError },
      () =>
        this.queryRaw<MysqlPrimaryKeyRow>(
          `
      SELECT TABLE_SCHEMA, TABLE_NAME, COLUMN_NAME
      FROM INFORMATION_SCHEMA.KEY_COLUMN_USAGE
      WHERE TABLE_SCHEMA IN (${placeholders})
        AND CONSTRAINT_NAME = 'PRIMARY'
        ${tableNameClause}
      ORDER BY TABLE_SCHEMA, TABLE_NAME, ORDINAL_POSITION
      `,
          [...databases, ...tableNameParams],
        ),
    );
    const primaryKeys = primaryKeysResult.ok ? primaryKeysResult.value : [];
    if (!primaryKeysResult.ok) {
      pushConstraintWarnings(snapshotWarnings, databases, 'primary_key');
    }
    const foreignKeysResult = await tryConstraintQuery(
      { schema: databases[0] ?? this.poolConfig.database, kind: 'foreign_key', isDeniedError },
      () =>
        this.queryRaw<MysqlForeignKeyRow>(
          `
      SELECT TABLE_SCHEMA, TABLE_NAME, COLUMN_NAME, REFERENCED_TABLE_NAME, REFERENCED_COLUMN_NAME, CONSTRAINT_NAME
      FROM INFORMATION_SCHEMA.KEY_COLUMN_USAGE
      WHERE TABLE_SCHEMA IN (${placeholders})
        AND REFERENCED_TABLE_NAME IS NOT NULL
        ${tableNameClause}
      ORDER BY TABLE_SCHEMA, TABLE_NAME, COLUMN_NAME
      `,
          [...databases, ...tableNameParams],
        ),
    );
    const foreignKeys = foreignKeysResult.ok ? foreignKeysResult.value : [];
    if (!foreignKeysResult.ok) {
      pushConstraintWarnings(snapshotWarnings, databases, 'foreign_key');
    }

    const columnsByTable = groupByTable(columns, this.poolConfig.database);
    const primaryKeysByTable = primaryKeyMap(primaryKeys, this.poolConfig.database);
    const foreignKeysByTable = groupByTable(foreignKeys, this.poolConfig.database);
    const schemaTables = tables.map((table) =>
      this.toSchemaTable(
        table.TABLE_SCHEMA ?? this.poolConfig.database,
        table,
        columnsByTable.get(mysqlTableKey(table.TABLE_SCHEMA ?? this.poolConfig.database, table.TABLE_NAME)) ?? [],
        primaryKeysByTable,
        foreignKeysByTable,
      ),
    );

    return {
      connectionId: this.connectionId,
      driver: 'mysql',
      extractedAt: this.now().toISOString(),
      scope: { schemas: databases },
      metadata: {
        database: this.poolConfig.database,
        schemas: databases,
        host: this.poolConfig.host,
        table_count: schemaTables.length,
        total_columns: schemaTables.reduce((sum, table) => sum + table.columns.length, 0),
      },
      tables: schemaTables,
      warnings: snapshotWarnings,
    };
  }

  private emptySnapshot(databases: string[]): KtxSchemaSnapshot {
    return {
      connectionId: this.connectionId,
      driver: 'mysql',
      extractedAt: this.now().toISOString(),
      scope: { schemas: databases },
      metadata: {
        database: this.poolConfig.database,
        schemas: databases,
        host: this.poolConfig.host,
        table_count: 0,
        total_columns: 0,
      },
      tables: [],
    };
  }

  async sampleTable(input: KtxTableSampleInput, _ctx: KtxScanContext): Promise<KtxTableSampleResult> {
    this.assertConnection(input.connectionId);
    const result = await this.query(this.dialect.generateSampleQuery(this.qTableName(input.table), input.limit, input.columns));
    return { headers: result.headers, rows: result.rows, totalRows: result.totalRows };
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

  async getColumnStatistics(table: KtxTableRef): Promise<KtxMysqlColumnStatisticsResult | null> {
    const schema = table.db ?? this.poolConfig.database;
    const sql = this.dialect.generateColumnStatisticsQuery(schema, table.name);
    if (!sql) {
      return null;
    }
    const rows = await this.queryRaw<MysqlStatsRow>(sql);
    const cardinalityByColumn = new Map<string, number>();
    for (const row of rows) {
      const cardinality = Number(row.estimated_cardinality);
      if (Number.isFinite(cardinality) && cardinality >= 0) {
        cardinalityByColumn.set(row.column_name, cardinality);
      }
    }
    return cardinalityByColumn.size > 0 ? { cardinalityByColumn } : null;
  }

  async executeReadOnly(input: KtxMysqlReadOnlyQueryInput, _ctx: KtxScanContext): Promise<KtxQueryResult> {
    this.assertConnection(input.connectionId);
    const limitedSql = limitSqlForExecution(assertReadOnlySql(input.sql), input.maxRows);
    const prepared = Array.isArray(input.params)
      ? { sql: limitedSql, params: input.params }
      : prepareMysqlReadOnlyQuery(limitedSql, input.params);
    const result = await this.query(prepared.sql, prepared.params);
    return { ...result, rowCount: result.rows.length };
  }

  async getColumnDistinctValues(
    table: KtxTableRef,
    columnName: string,
    options: KtxMysqlColumnDistinctValuesOptions,
  ): Promise<KtxMysqlColumnDistinctValuesResult | null> {
    const sampleSize = options.sampleSize ?? 10000;
    const tableName = this.qTableName(table);
    const quotedColumn = this.dialect.quoteIdentifier(columnName);
    const cardinalityRows = await this.queryRaw<MysqlCountRow>(
      this.dialect.generateCardinalitySampleQuery(tableName, quotedColumn, sampleSize),
    );
    const cardinality = Number(cardinalityRows[0]?.cardinality);
    if (Number.isNaN(cardinality)) {
      return null;
    }
    if (cardinality === 0) {
      return { values: [], cardinality: 0 };
    }
    if (cardinality > options.maxCardinality) {
      return { values: null, cardinality };
    }
    const valuesRows = await this.queryRaw<MysqlDistinctValueRow>(
      this.dialect.generateDistinctValuesQuery(tableName, quotedColumn, options.limit),
    );
    return {
      values: valuesRows.filter((row) => row.val !== null).map((row) => String(row.val)),
      cardinality,
    };
  }

  async getTableRowCount(tableName: string): Promise<number> {
    const rows = await this.queryRaw<MysqlCountRow>(
      `SELECT COUNT(*) AS count FROM ${this.dialect.quoteIdentifier(tableName)}`,
    );
    return Number(rows[0]?.count ?? 0);
  }

  qTableName(table: Pick<KtxTableRef, 'name'> & Partial<Pick<KtxTableRef, 'catalog' | 'db'>>): string {
    return this.dialect.formatTableName(table);
  }

  quoteIdentifier(identifier: string): string {
    return this.dialect.quoteIdentifier(identifier);
  }

  async listSchemas(): Promise<string[]> {
    const rows = await this.queryRaw<MysqlSchemaRow>(`
      SELECT SCHEMA_NAME
      FROM INFORMATION_SCHEMA.SCHEMATA
      WHERE SCHEMA_NAME NOT IN ('information_schema', 'mysql', 'performance_schema', 'sys')
      ORDER BY SCHEMA_NAME
    `);
    return rows.map((row) => row.SCHEMA_NAME);
  }

  async listTables(schemas?: string[]): Promise<KtxTableListEntry[]> {
    const filterSchemas = schemas ?? (await this.listSchemas());
    if (filterSchemas.length === 0) return [];
    const placeholders = filterSchemas.map(() => '?').join(', ');
    const rows = await this.queryRaw<MysqlTableListRow>(
      `
      SELECT TABLE_SCHEMA, TABLE_NAME, TABLE_TYPE
      FROM INFORMATION_SCHEMA.TABLES
      WHERE TABLE_SCHEMA IN (${placeholders})
        AND TABLE_TYPE IN ('BASE TABLE', 'VIEW')
      ORDER BY TABLE_SCHEMA, TABLE_NAME
      `,
      filterSchemas,
    );
    return rows.map((row) => ({
      catalog: null,
      schema: row.TABLE_SCHEMA,
      name: row.TABLE_NAME,
      kind: row.TABLE_TYPE === 'VIEW' ? ('view' as const) : ('table' as const),
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

  private toSchemaTable(
    database: string,
    table: MysqlTableRow,
    columns: MysqlColumnRow[],
    primaryKeysByTable: Map<string, Set<string>>,
    foreignKeysByTable: Map<string, MysqlForeignKeyRow[]>,
  ): KtxSchemaTable {
    const tableName = table.TABLE_NAME;
    const kind = table.TABLE_TYPE === 'VIEW' ? 'view' : 'table';
    const estimatedRows = kind === 'view' ? null : Number(table.TABLE_ROWS ?? 0);
    return {
      catalog: null,
      db: database,
      name: tableName,
      kind,
      comment: cleanMySqlTableComment(table.TABLE_COMMENT),
      estimatedRows: Number.isFinite(estimatedRows) ? estimatedRows : null,
      columns: columns.map((column) =>
        this.toSchemaColumn(column, primaryKeysByTable.get(mysqlTableKey(database, tableName)) ?? new Set()),
      ),
      foreignKeys: (foreignKeysByTable.get(mysqlTableKey(database, tableName)) ?? []).map((row) =>
        this.toSchemaForeignKey(database, row),
      ),
    };
  }

  private toSchemaColumn(column: MysqlColumnRow, primaryKeys: Set<string>): KtxSchemaColumn {
    return {
      name: column.COLUMN_NAME,
      nativeType: column.DATA_TYPE,
      normalizedType: this.dialect.mapDataType(column.DATA_TYPE),
      dimensionType: this.dialect.mapToDimensionType(column.DATA_TYPE),
      nullable: column.IS_NULLABLE === 'YES',
      primaryKey: primaryKeys.has(column.COLUMN_NAME),
      comment: column.COLUMN_COMMENT || null,
    };
  }

  private toSchemaForeignKey(database: string, row: MysqlForeignKeyRow): KtxSchemaForeignKey {
    return {
      fromColumn: row.COLUMN_NAME,
      toCatalog: null,
      toDb: database,
      toTable: row.REFERENCED_TABLE_NAME,
      toColumn: row.REFERENCED_COLUMN_NAME,
      constraintName: row.CONSTRAINT_NAME || null,
    };
  }

  private async poolForQuery(): Promise<KtxMysqlPool> {
    if (!this.pool) {
      const config = { ...this.poolConfig };
      if (this.endpointResolver) {
        this.resolvedEndpoint = await this.endpointResolver.resolve({
          host: config.host,
          port: config.port,
          connection: this.connection,
        });
        config.host = this.resolvedEndpoint.host;
        config.port = this.resolvedEndpoint.port;
      }
      this.pool = this.poolFactory.createPool(config);
    }
    return this.pool;
  }

  private async queryRaw<T extends RowDataPacket>(sql: string, params?: unknown): Promise<T[]> {
    const pool = await this.poolForQuery();
    const connection = await pool.getConnection();
    try {
      const [rows] = await connection.query(sql, params);
      return rows as T[];
    } finally {
      connection.release();
    }
  }

  private async query(
    sql: string,
    params?: Record<string, unknown> | unknown[],
  ): Promise<Omit<KtxQueryResult, 'rowCount'>> {
    const pool = await this.poolForQuery();
    const connection = await pool.getConnection();
    try {
      const [rows, fields] = await connection.query(assertReadOnlySql(sql), queryParams(params));
      const headers = fields.map((field) => field.name);
      const headerTypes = fields.map((field) => String(field.type ?? 'unknown'));
      return {
        headers,
        headerTypes,
        rows: rows.map((row) => headers.map((header) => row[header])),
        totalRows: rows.length,
      };
    } finally {
      connection.release();
    }
  }

  private assertConnection(connectionId: string): void {
    if (connectionId !== this.connectionId) {
      throw new Error(`ktx MySQL connector ${this.id} cannot serve connection ${connectionId}`);
    }
  }
}
