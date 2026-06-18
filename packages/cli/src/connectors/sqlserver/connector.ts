import { assertReadOnlySql, stripTrailingSqlNoise } from '../../context/connections/read-only-sql.js';
import { getDialectForDriver } from '../../context/connections/dialects.js';
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
import sql from 'mssql';
import { resolveStringReference } from '../shared/string-reference.js';

export interface KtxSqlServerConnectionConfig {
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
  trustServerCertificate?: boolean;
  maxConnections?: number;
  [key: string]: unknown;
}

export interface KtxSqlServerPoolConfig {
  server: string;
  port: number;
  database: string;
  user: string;
  password?: string;
  options: { encrypt: true; trustServerCertificate: boolean };
  pool: { max: number; min: number; idleTimeoutMillis: number };
}

/** @internal */
export interface KtxSqlServerQueryResult {
  recordset?: Array<Record<string, unknown>> & { columns?: Record<string, { type?: { declaration?: string } }> };
}

interface KtxSqlServerRequest {
  input(name: string, value: unknown): KtxSqlServerRequest;
  query(query: string): Promise<KtxSqlServerQueryResult>;
}

export interface KtxSqlServerPool {
  request(): KtxSqlServerRequest;
  close(): Promise<void>;
}

export interface KtxSqlServerPoolFactory {
  createPool(config: KtxSqlServerPoolConfig): Promise<KtxSqlServerPool>;
}

interface KtxSqlServerResolvedEndpoint {
  host: string;
  port: number;
  close?: () => Promise<void>;
}

export interface KtxSqlServerEndpointResolver {
  resolve(input: {
    host: string;
    port: number;
    connection: KtxSqlServerConnectionConfig;
  }): Promise<KtxSqlServerResolvedEndpoint>;
}

export interface KtxSqlServerScanConnectorOptions {
  connectionId: string;
  connection: KtxSqlServerConnectionConfig | undefined;
  poolFactory?: KtxSqlServerPoolFactory;
  endpointResolver?: KtxSqlServerEndpointResolver;
  env?: NodeJS.ProcessEnv;
  now?: () => Date;
}

export interface KtxSqlServerReadOnlyQueryInput extends KtxReadOnlyQueryInput {
  params?: Record<string, unknown>;
}

export interface KtxSqlServerColumnDistinctValuesOptions {
  maxCardinality: number;
  limit: number;
  sampleSize?: number;
}

export interface KtxSqlServerColumnDistinctValuesResult {
  values: string[] | null;
  cardinality: number;
}

interface KtxSqlServerTableSampleResult extends KtxTableSampleResult {
  headerTypes?: string[];
}

function sqlTypeDeclaration(type: unknown): string {
  if (typeof type === 'function') {
    try {
      return sqlTypeDeclaration(type());
    } catch {
      return 'unknown';
    }
  }
  if (typeof type === 'object' && type !== null && 'declaration' in type) {
    const declaration = (type as { declaration?: unknown }).declaration;
    return typeof declaration === 'string' ? declaration : 'unknown';
  }
  return 'unknown';
}

function sqlRecordset(
  rows: Array<Record<string, unknown>> | undefined,
  columns: Record<string, { type?: unknown }> | undefined,
): NonNullable<KtxSqlServerQueryResult['recordset']> {
  const recordset = [...(rows ?? [])] as NonNullable<KtxSqlServerQueryResult['recordset']>;
  recordset.columns = Object.fromEntries(
    Object.entries(columns ?? {}).map(([name, metadata]) => [
      name,
      { type: { declaration: sqlTypeDeclaration(metadata.type) } },
    ]),
  );
  return recordset;
}

function tableScopeSql(
  scopedNames: readonly string[] | null,
  columnExpression: string,
): { clause: string; params: Record<string, unknown> } {
  if (!scopedNames) return { clause: '', params: {} };
  const params: Record<string, unknown> = {};
  const placeholders = scopedNames.map((name, index) => {
    const key = `table_${index}`;
    params[key] = name;
    return `@${key}`;
  });
  return { clause: `AND ${columnExpression} IN (${placeholders.join(', ')})`, params };
}

/** @internal */
export function prepareSqlServerReadOnlyQuery(
  sql: string,
  params?: Record<string, unknown>,
): { sql: string; params?: Record<string, unknown> } {
  if (!params) {
    return { sql, params: undefined };
  }
  let parameterizedQuery = sql;
  for (const key of Object.keys(params)) {
    parameterizedQuery = parameterizedQuery.replace(new RegExp(`:${key}\\b`, 'g'), `@${key}`);
  }
  return { sql: parameterizedQuery, params };
}

class DefaultSqlServerPoolFactory implements KtxSqlServerPoolFactory {
  async createPool(config: KtxSqlServerPoolConfig): Promise<KtxSqlServerPool> {
    const pool = await new sql.ConnectionPool(config as sql.config).connect();
    return {
      request() {
        const request = pool.request();
        return {
          input(name: string, value: unknown) {
            request.input(name, value);
            return this;
          },
          async query(query: string) {
            const result = await request.query(query);
            return {
              recordset: sqlRecordset(result.recordset as Array<Record<string, unknown>> | undefined, result.recordset?.columns),
            };
          },
        };
      },
      close: () => pool.close(),
    };
  }
}

function stringConfigValue(
  connection: KtxSqlServerConnectionConfig | undefined,
  key: keyof KtxSqlServerConnectionConfig,
  env: NodeJS.ProcessEnv,
): string | undefined {
  const value = connection?.[key];
  return typeof value === 'string' && value.trim().length > 0 ? resolveStringReference(value.trim(), env) : undefined;
}

function parseSqlServerUrl(url: string): Partial<KtxSqlServerConnectionConfig> {
  const parsed = new URL(url);
  return {
    host: parsed.hostname,
    port: parsed.port ? Number(parsed.port) : undefined,
    database: parsed.pathname.replace(/^\/+/, '') || undefined,
    username: parsed.username ? decodeURIComponent(parsed.username) : undefined,
    password: parsed.password ? decodeURIComponent(parsed.password) : undefined,
    trustServerCertificate: parsed.searchParams.get('trustServerCertificate') === 'true',
  };
}

function maybeNumber(value: unknown): number | undefined {
  return typeof value === 'number' && Number.isFinite(value) ? value : undefined;
}

function positiveIntegerConfigValue(input: {
  connection: KtxSqlServerConnectionConfig;
  key: keyof KtxSqlServerConnectionConfig;
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

function schemaNames(connection: KtxSqlServerConnectionConfig, env: NodeJS.ProcessEnv): string[] {
  if (Array.isArray(connection.schemas) && connection.schemas.length > 0) {
    return connection.schemas.filter((schema) => schema.trim().length > 0).map((schema) => resolveStringReference(schema, env));
  }
  return [stringConfigValue(connection, 'schema', env) ?? 'dbo'];
}

function groupByTable<T extends { table_name: string }>(rows: T[]): Map<string, T[]> {
  const grouped = new Map<string, T[]>();
  for (const row of rows) {
    const values = grouped.get(row.table_name) ?? [];
    values.push(row);
    grouped.set(row.table_name, values);
  }
  return grouped;
}

function firstNumber(value: unknown): number | null {
  const numberValue = Number(value);
  return Number.isFinite(numberValue) ? numberValue : null;
}

function isDeniedError(error: unknown): boolean {
  if (!error || typeof error !== 'object') {
    return false;
  }
  const number = (error as { number?: unknown }).number;
  return number === 229 || number === 230 || number === 297;
}

function limitSqlForSqlServerExecution(sqlText: string, maxRows: number | undefined): string {
  const trimmed = stripTrailingSqlNoise(assertReadOnlySql(sqlText));
  if (!maxRows) {
    return trimmed;
  }
  if (!Number.isInteger(maxRows) || maxRows <= 0) {
    throw new Error('maxRows must be a positive integer.');
  }
  return `SELECT TOP ${maxRows} * FROM (${trimmed}) AS ktx_query_result`;
}

export function isKtxSqlServerConnectionConfig(
  connection: KtxSqlServerConnectionConfig | undefined,
): connection is KtxSqlServerConnectionConfig {
  return String(connection?.driver ?? '').toLowerCase() === 'sqlserver';
}

/** @internal */
export function sqlServerConnectionPoolConfigFromConfig(input: {
  connectionId: string;
  connection: KtxSqlServerConnectionConfig | undefined;
  env?: NodeJS.ProcessEnv;
}): KtxSqlServerPoolConfig {
  const inputDriver = input.connection?.driver ?? 'unknown';
  if (!isKtxSqlServerConnectionConfig(input.connection)) {
    throw new Error(`Native SQL Server connector cannot run driver "${inputDriver}"`);
  }

  const env = input.env ?? process.env;
  const referencedUrl = stringConfigValue(input.connection, 'url', env);
  const urlConfig = referencedUrl ? parseSqlServerUrl(referencedUrl) : {};
  const merged: KtxSqlServerConnectionConfig = { ...urlConfig, ...input.connection };
  const server = stringConfigValue(merged, 'host', env);
  const database = stringConfigValue(merged, 'database', env);
  const user = stringConfigValue(merged, 'username', env) ?? stringConfigValue(merged, 'user', env);
  const maxConnections = positiveIntegerConfigValue({
    connection: merged,
    key: 'maxConnections',
    connectionId: input.connectionId,
    defaultValue: 10,
  });

  if (!server) {
    throw new Error(`Native SQL Server connector requires connections.${input.connectionId}.host or url`);
  }
  if (!database) {
    throw new Error(`Native SQL Server connector requires connections.${input.connectionId}.database or url`);
  }
  if (!user) {
    throw new Error(`Native SQL Server connector requires connections.${input.connectionId}.username, user, or url`);
  }

  return {
    server,
    port: maybeNumber(merged.port) ?? 1433,
    database,
    user,
    password: stringConfigValue(merged, 'password', env),
    options: { encrypt: true, trustServerCertificate: merged.trustServerCertificate ?? true },
    pool: { max: maxConnections, min: 0, idleTimeoutMillis: 30000 },
  };
}

export class KtxSqlServerScanConnector implements KtxScanConnector {
  readonly id: string;
  readonly driver = 'sqlserver' as const;
  readonly capabilities = createKtxConnectorCapabilities({
    tableSampling: true,
    columnSampling: true,
    columnStats: false,
    readOnlySql: true,
    nestedAnalysis: false,
    formalForeignKeys: true,
    estimatedRowCounts: true,
  });

  private readonly connectionId: string;
  private readonly connection: KtxSqlServerConnectionConfig;
  private readonly poolConfig: KtxSqlServerPoolConfig;
  private readonly schemas: string[];
  private readonly poolFactory: KtxSqlServerPoolFactory;
  private readonly endpointResolver?: KtxSqlServerEndpointResolver;
  private readonly now: () => Date;
  private readonly dialect = getDialectForDriver('sqlserver');
  private pool: KtxSqlServerPool | null = null;
  private resolvedEndpoint: KtxSqlServerResolvedEndpoint | null = null;

  constructor(options: KtxSqlServerScanConnectorOptions) {
    this.connectionId = options.connectionId;
    this.connection = options.connection ?? {};
    const env = options.env ?? process.env;
    this.poolConfig = sqlServerConnectionPoolConfigFromConfig({
      connectionId: options.connectionId,
      connection: options.connection,
      env,
    });
    this.schemas = schemaNames(this.connection, env);
    this.poolFactory = options.poolFactory ?? new DefaultSqlServerPoolFactory();
    this.endpointResolver = options.endpointResolver;
    this.now = options.now ?? (() => new Date());
    this.id = `sqlserver:${options.connectionId}`;
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
    const tables: KtxSchemaTable[] = [];
    const snapshotWarnings: KtxScanWarning[] = [];
    for (const schemaName of this.schemas) {
      const scopedNames = input.tableScope
        ? scopedTableNames(input.tableScope, { catalog: this.poolConfig.database, db: schemaName })
        : null;
      tables.push(...(await this.introspectSchema(schemaName, scopedNames, snapshotWarnings)));
    }
    return {
      connectionId: this.connectionId,
      driver: 'sqlserver',
      extractedAt: this.now().toISOString(),
      scope: { catalogs: [this.poolConfig.database], schemas: this.schemas },
      metadata: {
        database: this.poolConfig.database,
        schemas: this.schemas,
        host: this.poolConfig.server,
        table_count: tables.length,
        total_columns: tables.reduce((sum, table) => sum + table.columns.length, 0),
      },
      tables,
      warnings: snapshotWarnings,
    };
  }

  async sampleTable(input: KtxTableSampleInput, _ctx: KtxScanContext): Promise<KtxSqlServerTableSampleResult> {
    this.assertConnection(input.connectionId);
    const result = await this.query(this.dialect.generateSampleQuery(this.qTableName(input.table), input.limit, input.columns));
    return { headers: result.headers, headerTypes: result.headerTypes, rows: result.rows, totalRows: result.totalRows };
  }

  async sampleColumn(input: KtxColumnSampleInput, _ctx: KtxScanContext): Promise<KtxColumnSampleResult> {
    this.assertConnection(input.connectionId);
    const result = await this.query(
      this.dialect.generateColumnSampleQuery(this.qTableName(input.table), input.column, input.limit),
    );
    const values = result.rows.filter((row) => row.length > 0 && row[0] !== null).map((row) => row[0]);
    return { values, nullCount: null, distinctCount: null };
  }

  async columnStats(_input: KtxColumnStatsInput, _ctx: KtxScanContext): Promise<KtxColumnStatsResult | null> {
    return null;
  }

  async executeReadOnly(input: KtxSqlServerReadOnlyQueryInput, _ctx: KtxScanContext): Promise<KtxQueryResult> {
    this.assertConnection(input.connectionId);
    const limitedSql = limitSqlForSqlServerExecution(input.sql, input.maxRows);
    const prepared = prepareSqlServerReadOnlyQuery(limitedSql, input.params);
    const result = await this.query(prepared.sql, prepared.params);
    return { ...result, rowCount: result.rows.length };
  }

  async getColumnDistinctValues(
    table: KtxTableRef,
    columnName: string,
    options: KtxSqlServerColumnDistinctValuesOptions,
  ): Promise<KtxSqlServerColumnDistinctValuesResult | null> {
    const tableName = this.qTableName(table);
    const quotedColumn = this.dialect.quoteIdentifier(columnName);
    const cardinalityRows = await this.queryRaw<{ cardinality: unknown }>(
      this.dialect.generateCardinalitySampleQuery(tableName, quotedColumn, options.sampleSize ?? 10000),
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
    const valuesRows = await this.queryRaw<{ val: unknown }>(
      this.dialect.generateDistinctValuesQuery(tableName, quotedColumn, options.limit),
    );
    return { values: valuesRows.filter((row) => row.val !== null).map((row) => String(row.val)), cardinality };
  }

  async getTableRowCount(tableName: string, schemaName = this.schemas[0] ?? 'dbo'): Promise<number> {
    const rows = await this.queryRaw<{ row_count: unknown }>(
      `
      SELECT SUM(p.rows) AS row_count
      FROM sys.tables t
      INNER JOIN sys.partitions p ON t.object_id = p.object_id
      INNER JOIN sys.schemas s ON t.schema_id = s.schema_id
      WHERE s.name = @schemaName
        AND t.name = @tableName
        AND p.index_id IN (0, 1)
      `,
      { schemaName, tableName },
    );
    return firstNumber(rows[0]?.row_count) ?? 0;
  }

  qTableName(table: Pick<KtxTableRef, 'name'> & Partial<Pick<KtxTableRef, 'catalog' | 'db'>>): string {
    return this.dialect.formatTableName(table);
  }

  quoteIdentifier(identifier: string): string {
    return this.dialect.quoteIdentifier(identifier);
  }

  async listSchemas(): Promise<string[]> {
    const rows = await this.queryRaw<{ schema_name: string }>(`
      SELECT s.name AS schema_name
      FROM sys.schemas s
      WHERE s.name NOT IN (
        'INFORMATION_SCHEMA', 'sys', 'guest',
        'db_owner', 'db_accessadmin', 'db_securityadmin', 'db_ddladmin',
        'db_backupoperator', 'db_datareader', 'db_datawriter',
        'db_denydatareader', 'db_denydatawriter'
      )
      ORDER BY s.name
    `);
    return rows.map((row) => row.schema_name);
  }

  async listTables(schemas?: string[]): Promise<KtxTableListEntry[]> {
    const filterSchemas = schemas ?? (await this.listSchemas());
    if (filterSchemas.length === 0) return [];
    const params: Record<string, unknown> = {};
    const placeholders = filterSchemas.map((s, i) => {
      params[`schema${i}`] = s;
      return `@schema${i}`;
    });
    const rows = await this.queryRaw<{ schema_name: string; table_name: string; table_type: string }>(
      `
      SELECT s.name AS schema_name, o.name AS table_name, o.type_desc AS table_type
      FROM sys.objects o
      JOIN sys.schemas s ON o.schema_id = s.schema_id
      WHERE o.type IN ('U', 'V')
        AND s.name IN (${placeholders.join(', ')})
      ORDER BY s.name, o.name
      `,
      params,
    );
    return rows.map((row) => ({
      catalog: this.poolConfig.database,
      schema: row.schema_name,
      name: row.table_name,
      kind: row.table_type === 'VIEW' ? ('view' as const) : ('table' as const),
    }));
  }

  async cleanup(): Promise<void> {
    if (this.pool) {
      await this.pool.close();
      this.pool = null;
    }
    if (this.resolvedEndpoint?.close) {
      await this.resolvedEndpoint.close();
      this.resolvedEndpoint = null;
    }
  }

  private async introspectSchema(
    schemaName: string,
    scopedNames: readonly string[] | null,
    snapshotWarnings: KtxScanWarning[],
  ): Promise<KtxSchemaTable[]> {
    if (scopedNames && scopedNames.length === 0) return [];
    const tableScope = tableScopeSql(scopedNames, 'TABLE_NAME');
    const tables = await this.queryRaw<{ table_name: string; table_type: string }>(
      `
      SELECT TABLE_NAME AS table_name, TABLE_TYPE AS table_type
      FROM INFORMATION_SCHEMA.TABLES
      WHERE TABLE_SCHEMA = @schemaName
        AND TABLE_TYPE IN ('BASE TABLE', 'VIEW')
        ${tableScope.clause}
      ORDER BY TABLE_NAME
      `,
      { schemaName, ...tableScope.params },
    );
    const columns = await this.queryRaw<{
      table_name: string;
      column_name: string;
      data_type: string;
      is_nullable: string;
    }>(
      `
      SELECT TABLE_NAME AS table_name, COLUMN_NAME AS column_name, DATA_TYPE AS data_type, IS_NULLABLE AS is_nullable
      FROM INFORMATION_SCHEMA.COLUMNS
      WHERE TABLE_SCHEMA = @schemaName
        ${tableScope.clause}
      ORDER BY TABLE_NAME, ORDINAL_POSITION
      `,
      { schemaName, ...tableScope.params },
    );
    const tableComments = await this.tableComments(schemaName, scopedNames);
    const columnComments = await this.columnComments(schemaName, scopedNames);
    const primaryKeysResult = await tryConstraintQuery(
      { schema: schemaName, kind: 'primary_key', isDeniedError },
      () => this.primaryKeys(schemaName, scopedNames),
    );
    const foreignKeysResult = await tryConstraintQuery(
      { schema: schemaName, kind: 'foreign_key', isDeniedError },
      () => this.foreignKeys(schemaName, scopedNames),
    );
    const primaryKeys = primaryKeysResult.ok ? primaryKeysResult.value : new Map<string, Set<string>>();
    const foreignKeys = foreignKeysResult.ok ? foreignKeysResult.value : [];
    if (!primaryKeysResult.ok) {
      snapshotWarnings.push(primaryKeysResult.warning);
    }
    if (!foreignKeysResult.ok) {
      snapshotWarnings.push(foreignKeysResult.warning);
    }
    const rowCounts = await this.rowCounts(schemaName, scopedNames);
    const columnsByTable = groupByTable(columns);
    const foreignKeysByTable = groupByTable(foreignKeys);

    return tables.map((table) => ({
      catalog: this.poolConfig.database,
      db: schemaName,
      name: table.table_name,
      kind: table.table_type === 'VIEW' ? 'view' : 'table',
      comment: tableComments.get(table.table_name) ?? null,
      estimatedRows: table.table_type === 'VIEW' ? null : rowCounts.get(table.table_name) ?? 0,
      columns: (columnsByTable.get(table.table_name) ?? []).map((column) =>
        this.toSchemaColumn(column, primaryKeys.get(table.table_name) ?? new Set(), columnComments),
      ),
      foreignKeys: (foreignKeysByTable.get(table.table_name) ?? []).map((row) => this.toSchemaForeignKey(row)),
    }));
  }

  private async tableComments(schemaName: string, scopedNames: readonly string[] | null): Promise<Map<string, string>> {
    const tableScope = tableScopeSql(scopedNames, 'o.name');
    const rows = await this.queryRaw<{ table_name: string; table_comment: string }>(
      `
      SELECT o.name AS table_name, CAST(ep.value AS NVARCHAR(MAX)) AS table_comment
      FROM sys.objects o
      INNER JOIN sys.schemas s ON o.schema_id = s.schema_id
      INNER JOIN sys.extended_properties ep ON ep.major_id = o.object_id
        AND ep.minor_id = 0
        AND ep.name = 'MS_Description'
      WHERE s.name = @schemaName
        AND o.type IN ('U', 'V')
        ${tableScope.clause}
      `,
      { schemaName, ...tableScope.params },
    );
    return new Map(rows.map((row) => [row.table_name, row.table_comment]));
  }

  private async columnComments(schemaName: string, scopedNames: readonly string[] | null): Promise<Map<string, string>> {
    const tableScope = tableScopeSql(scopedNames, 'o.name');
    const rows = await this.queryRaw<{ table_name: string; column_name: string; column_comment: string }>(
      `
      SELECT o.name AS table_name, c.name AS column_name, CAST(ep.value AS NVARCHAR(MAX)) AS column_comment
      FROM sys.columns c
      INNER JOIN sys.objects o ON c.object_id = o.object_id
      INNER JOIN sys.schemas s ON o.schema_id = s.schema_id
      INNER JOIN sys.extended_properties ep ON ep.major_id = c.object_id
        AND ep.minor_id = c.column_id
        AND ep.name = 'MS_Description'
      WHERE s.name = @schemaName
        AND o.type IN ('U', 'V')
        ${tableScope.clause}
      `,
      { schemaName, ...tableScope.params },
    );
    return new Map(rows.map((row) => [`${row.table_name}.${row.column_name}`, row.column_comment]));
  }

  private async primaryKeys(
    schemaName: string,
    scopedNames: readonly string[] | null,
  ): Promise<Map<string, Set<string>>> {
    const tableScope = tableScopeSql(scopedNames, 'tc.TABLE_NAME');
    const rows = await this.queryRaw<{ table_name: string; column_name: string }>(
      `
      SELECT tc.TABLE_NAME AS table_name, kcu.COLUMN_NAME AS column_name
      FROM INFORMATION_SCHEMA.TABLE_CONSTRAINTS tc
      JOIN INFORMATION_SCHEMA.KEY_COLUMN_USAGE kcu
        ON tc.CONSTRAINT_NAME = kcu.CONSTRAINT_NAME
        AND tc.TABLE_SCHEMA = kcu.TABLE_SCHEMA
      WHERE tc.CONSTRAINT_TYPE = 'PRIMARY KEY'
        AND tc.TABLE_SCHEMA = @schemaName
        ${tableScope.clause}
      ORDER BY tc.TABLE_NAME, kcu.ORDINAL_POSITION
      `,
      { schemaName, ...tableScope.params },
    );
    const grouped = new Map<string, Set<string>>();
    for (const row of rows) {
      const columns = grouped.get(row.table_name) ?? new Set<string>();
      columns.add(row.column_name);
      grouped.set(row.table_name, columns);
    }
    return grouped;
  }

  private async foreignKeys(
    schemaName: string,
    scopedNames: readonly string[] | null,
  ): Promise<
    Array<{
      table_name: string;
      column_name: string;
      referenced_table_schema: string;
      referenced_table_name: string;
      referenced_column_name: string;
      constraint_name: string;
    }>
  > {
    const tableScope = tableScopeSql(scopedNames, 'fk.TABLE_NAME');
    return this.queryRaw(
      `
      SELECT
        fk.TABLE_NAME AS table_name,
        fk.COLUMN_NAME AS column_name,
        pk.TABLE_SCHEMA AS referenced_table_schema,
        pk.TABLE_NAME AS referenced_table_name,
        pk.COLUMN_NAME AS referenced_column_name,
        fk.CONSTRAINT_NAME AS constraint_name
      FROM INFORMATION_SCHEMA.REFERENTIAL_CONSTRAINTS rc
      JOIN INFORMATION_SCHEMA.KEY_COLUMN_USAGE fk
        ON fk.CONSTRAINT_CATALOG = rc.CONSTRAINT_CATALOG
        AND fk.CONSTRAINT_SCHEMA = rc.CONSTRAINT_SCHEMA
        AND fk.CONSTRAINT_NAME = rc.CONSTRAINT_NAME
      JOIN INFORMATION_SCHEMA.KEY_COLUMN_USAGE pk
        ON pk.CONSTRAINT_CATALOG = rc.UNIQUE_CONSTRAINT_CATALOG
        AND pk.CONSTRAINT_SCHEMA = rc.UNIQUE_CONSTRAINT_SCHEMA
        AND pk.CONSTRAINT_NAME = rc.UNIQUE_CONSTRAINT_NAME
        AND pk.ORDINAL_POSITION = fk.ORDINAL_POSITION
      WHERE fk.TABLE_SCHEMA = @schemaName
        ${tableScope.clause}
      ORDER BY fk.TABLE_NAME, fk.COLUMN_NAME
      `,
      { schemaName, ...tableScope.params },
    );
  }

  private async rowCounts(schemaName: string, scopedNames: readonly string[] | null): Promise<Map<string, number>> {
    const tableScope = tableScopeSql(scopedNames, 't.name');
    const rows = await this.queryRaw<{ table_name: string; row_count: unknown }>(
      `
      SELECT t.name AS table_name, SUM(p.rows) AS row_count
      FROM sys.tables t
      INNER JOIN sys.partitions p ON t.object_id = p.object_id
      INNER JOIN sys.schemas s ON t.schema_id = s.schema_id
      WHERE s.name = @schemaName
        AND p.index_id IN (0, 1)
        ${tableScope.clause}
      GROUP BY t.name
      `,
      { schemaName, ...tableScope.params },
    );
    return new Map(rows.map((row) => [row.table_name, firstNumber(row.row_count) ?? 0]));
  }

  private toSchemaColumn(
    column: { table_name: string; column_name: string; data_type: string; is_nullable: string },
    primaryKeys: Set<string>,
    comments: Map<string, string>,
  ): KtxSchemaColumn {
    return {
      name: column.column_name,
      nativeType: column.data_type,
      normalizedType: this.dialect.mapDataType(column.data_type),
      dimensionType: this.dialect.mapToDimensionType(column.data_type),
      nullable: column.is_nullable === 'YES',
      primaryKey: primaryKeys.has(column.column_name),
      comment: comments.get(`${column.table_name}.${column.column_name}`) ?? null,
    };
  }

  private toSchemaForeignKey(row: {
    column_name: string;
    referenced_table_schema: string;
    referenced_table_name: string;
    referenced_column_name: string;
    constraint_name: string;
  }): KtxSchemaForeignKey {
    return {
      fromColumn: row.column_name,
      toCatalog: this.poolConfig.database,
      toDb: row.referenced_table_schema,
      toTable: row.referenced_table_name,
      toColumn: row.referenced_column_name,
      constraintName: row.constraint_name || null,
    };
  }

  private async poolForQuery(): Promise<KtxSqlServerPool> {
    if (!this.pool) {
      const config = { ...this.poolConfig };
      if (this.endpointResolver) {
        this.resolvedEndpoint = await this.endpointResolver.resolve({
          host: config.server,
          port: config.port,
          connection: this.connection,
        });
        config.server = this.resolvedEndpoint.host;
        config.port = this.resolvedEndpoint.port;
      }
      this.pool = await this.poolFactory.createPool(config);
    }
    return this.pool;
  }

  private async queryRaw<T extends Record<string, unknown>>(query: string, params?: Record<string, unknown>): Promise<T[]> {
    const pool = await this.poolForQuery();
    const request = pool.request();
    if (params) {
      for (const [key, value] of Object.entries(params)) {
        request.input(key, value);
      }
    }
    const result = await request.query(query);
    return (result.recordset ?? []) as T[];
  }

  private async query(query: string, params?: Record<string, unknown>): Promise<Omit<KtxQueryResult, 'rowCount'>> {
    const pool = await this.poolForQuery();
    const request = pool.request();
    if (params) {
      for (const [key, value] of Object.entries(params)) {
        request.input(key, value);
      }
    }
    const result = await request.query(assertReadOnlySql(query));
    const recordset = result.recordset ?? [];
    const columnMetadata = recordset.columns ?? {};
    const metadataHeaders = Object.keys(columnMetadata);
    const headers = metadataHeaders.length > 0 ? metadataHeaders : Object.keys(recordset[0] ?? {});
    const headerTypes = headers.map((header) => columnMetadata[header]?.type?.declaration ?? 'unknown');
    return {
      headers,
      headerTypes,
      rows: recordset.map((row) => headers.map((header) => row[header])),
      totalRows: recordset.length,
    };
  }

  private assertConnection(connectionId: string): void {
    if (connectionId !== this.connectionId) {
      throw new Error(`ktx SQL Server connector ${this.id} cannot serve connection ${connectionId}`);
    }
  }
}
