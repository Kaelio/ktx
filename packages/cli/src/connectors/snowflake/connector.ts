import { createPrivateKey } from 'node:crypto';
import { getDialectForDriver } from '../../context/connections/dialects.js';
import { resolveStringReference } from '../shared/string-reference.js';
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
  type KtxSchemaSnapshot,
  type KtxSchemaTable,
  type KtxTableListEntry,
  type KtxTableRef,
  type KtxTableSampleInput,
  type KtxTableSampleResult,
} from '../../context/scan/types.js';
import snowflake from 'snowflake-sdk';
import type { Bind, Binds, Connection, ConnectionOptions } from 'snowflake-sdk';
import { assertSafeSnowflakeIdentifier, quoteSnowflakeIdentifier } from './identifiers.js';
import { configureSnowflakeSdkLogger } from './sdk-logger.js';

export interface KtxSnowflakeConnectionConfig {
  driver?: string;
  authMethod?: 'password' | 'rsa';
  account?: string;
  warehouse?: string;
  database?: string;
  schema_name?: string;
  schema_names?: string[];
  username?: string;
  password?: string;
  privateKey?: string;
  passphrase?: string;
  role?: string;
  maxConnections?: number;
  [key: string]: unknown;
}

export interface KtxSnowflakeResolvedConnectionConfig {
  authMethod: 'password' | 'rsa';
  account: string;
  warehouse: string;
  database: string;
  schemas: string[];
  username: string;
  password?: string;
  privateKey?: string;
  passphrase?: string;
  role?: string;
  maxConnections: number;
}

export interface KtxSnowflakeRawColumnMetadata {
  name: string;
  type: string;
  nullable: boolean;
  comment: string | null;
}

export interface KtxSnowflakeRawTableMetadata {
  name: string;
  catalog: string;
  db: string;
  rowCount: number | null;
  comment: string | null;
  columns: KtxSnowflakeRawColumnMetadata[];
}

export interface KtxSnowflakeDriver {
  test(): Promise<{ success: boolean; error?: string }>;
  query(sql: string, params?: unknown): Promise<KtxQueryResult>;
  getSchemaMetadata(schemaName?: string, scopedTableNames?: readonly string[] | null): Promise<KtxSnowflakeRawTableMetadata[]>;
  listSchemas(): Promise<string[]>;
  listTables(schemas?: string[]): Promise<KtxTableListEntry[]>;
  cleanup(): Promise<void>;
}

export interface KtxSnowflakeDriverFactory {
  createDriver(input: {
    resolved: KtxSnowflakeResolvedConnectionConfig;
    sdkOptionsProvider?: KtxSnowflakeSdkOptionsProvider;
  }): KtxSnowflakeDriver;
}

export interface KtxSnowflakeSdkOptionsProvider {
  resolve(input: {
    account: string;
    connection: KtxSnowflakeConnectionConfig;
  }): Promise<{ sdkOptions: Record<string, unknown>; close?: () => Promise<void> } | undefined>;
}

export interface KtxSnowflakeScanConnectorOptions {
  connectionId: string;
  connection: KtxSnowflakeConnectionConfig | undefined;
  /**
   * ktx project directory. When provided, snowflake-sdk's logger is redirected to
   * `<projectDir>/.ktx/logs/snowflake.log` so its JSON output does not bleed into
   * the CLI's TTY. Tests that use a fake driverFactory can leave this undefined.
   */
  projectDir?: string;
  driverFactory?: KtxSnowflakeDriverFactory;
  sdkOptionsProvider?: KtxSnowflakeSdkOptionsProvider;
  env?: NodeJS.ProcessEnv;
  now?: () => Date;
}

export interface KtxSnowflakeReadOnlyQueryInput extends KtxReadOnlyQueryInput {
  params?: Record<string, unknown>;
}

export interface KtxSnowflakeColumnDistinctValuesOptions {
  maxCardinality: number;
  limit: number;
  sampleSize?: number;
}

export interface KtxSnowflakeColumnDistinctValuesResult {
  values: string[] | null;
  cardinality: number;
}

const DATE_TYPES = ['DATE', 'TIMESTAMP', 'TIMESTAMP_LTZ', 'TIMESTAMP_NTZ', 'TIMESTAMP_TZ', 'TIME'];

function stringConfigValue(
  connection: KtxSnowflakeConnectionConfig | undefined,
  key: keyof KtxSnowflakeConnectionConfig,
  env: NodeJS.ProcessEnv,
): string | undefined {
  const value = connection?.[key];
  return typeof value === 'string' && value.trim().length > 0 ? resolveStringReference(value.trim(), env) : undefined;
}

function positiveIntegerConfigValue(input: {
  connection: KtxSnowflakeConnectionConfig;
  key: keyof KtxSnowflakeConnectionConfig;
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

function schemaNames(connection: KtxSnowflakeConnectionConfig, env: NodeJS.ProcessEnv): string[] {
  if (Array.isArray(connection.schema_names) && connection.schema_names.length > 0) {
    return connection.schema_names
      .filter((schema) => schema.trim().length > 0)
      .map((schema) => resolveStringReference(schema, env));
  }
  const single = stringConfigValue(connection, 'schema_name', env);
  return single ? [single] : [];
}

function firstNumber(value: unknown): number | null {
  const numberValue = Number(value);
  return Number.isFinite(numberValue) ? numberValue : null;
}

function isDeniedError(error: unknown): boolean {
  if (error instanceof Error) {
    return /insufficient privileges|does not exist or not authorized/i.test(error.message);
  }
  return false;
}

function normalizeSnowflakeValue(value: unknown, columnType?: string): unknown {
  if (columnType && DATE_TYPES.some((type) => columnType.toUpperCase().includes(type))) {
    if (typeof value === 'number') {
      return new Date(value).toISOString();
    }
    if (value instanceof Date) {
      return value.toISOString();
    }
  }
  if (typeof value === 'string') {
    const trimmed = value.trim();
    if ((trimmed.startsWith('{') && trimmed.endsWith('}')) || (trimmed.startsWith('[') && trimmed.endsWith(']'))) {
      try {
        return JSON.parse(trimmed) as unknown;
      } catch {
        return value;
      }
    }
  }
  return value;
}

function toSnowflakeBind(value: unknown): Bind {
  if (value === null || typeof value === 'string' || typeof value === 'number' || typeof value === 'boolean') {
    return value;
  }
  if (value instanceof Date) {
    return value.toISOString();
  }
  return String(value);
}

function toSnowflakeBinds(params: unknown[] | undefined): Binds | undefined {
  return params?.map((value) => toSnowflakeBind(value));
}

/** @internal */
export function prepareSnowflakeReadOnlyQuery(
  sql: string,
  params?: Record<string, unknown>,
): { sql: string; params?: unknown[] } {
  return { sql, params: params ? Object.values(params) : undefined };
}

export function isKtxSnowflakeConnectionConfig(
  connection: KtxSnowflakeConnectionConfig | undefined,
): connection is KtxSnowflakeConnectionConfig {
  return String(connection?.driver ?? '').toLowerCase() === 'snowflake';
}

/** @internal */
export function snowflakeConnectionConfigFromConfig(input: {
  connectionId: string;
  connection: KtxSnowflakeConnectionConfig | undefined;
  env?: NodeJS.ProcessEnv;
}): KtxSnowflakeResolvedConnectionConfig {
  const inputDriver = input.connection?.driver ?? 'unknown';
  if (!isKtxSnowflakeConnectionConfig(input.connection)) {
    throw new Error(`Native Snowflake connector cannot run driver "${inputDriver}"`);
  }
  const staleMaxSessionsKey = 'max' + 'Sessions';
  if (Object.prototype.hasOwnProperty.call(input.connection, staleMaxSessionsKey)) {
    throw new Error(`connections.${input.connectionId}.maxSessions has been renamed to maxConnections`);
  }
  const env = input.env ?? process.env;
  const authMethod = input.connection?.authMethod ?? 'password';
  const account = stringConfigValue(input.connection, 'account', env);
  const warehouse = stringConfigValue(input.connection, 'warehouse', env);
  const database = stringConfigValue(input.connection, 'database', env);
  const username = stringConfigValue(input.connection, 'username', env);
  if (!account) {
    throw new Error(`Native Snowflake connector requires connections.${input.connectionId}.account`);
  }
  if (!warehouse) {
    throw new Error(`Native Snowflake connector requires connections.${input.connectionId}.warehouse`);
  }
  if (!database) {
    throw new Error(`Native Snowflake connector requires connections.${input.connectionId}.database`);
  }
  if (!username) {
    throw new Error(`Native Snowflake connector requires connections.${input.connectionId}.username`);
  }
  assertSafeSnowflakeIdentifier(warehouse, 'warehouse');
  assertSafeSnowflakeIdentifier(database, 'database');
  const resolvedSchemas = schemaNames(input.connection!, env);
  for (const schema of resolvedSchemas) {
    assertSafeSnowflakeIdentifier(schema, 'schema');
  }
  const resolved: KtxSnowflakeResolvedConnectionConfig = {
    authMethod,
    account,
    warehouse,
    database,
    schemas: resolvedSchemas,
    username,
    maxConnections: positiveIntegerConfigValue({
      connection: input.connection,
      key: 'maxConnections',
      connectionId: input.connectionId,
      defaultValue: 4,
    }),
  };
  const role = stringConfigValue(input.connection, 'role', env);
  if (role) {
    assertSafeSnowflakeIdentifier(role, 'role');
    resolved.role = role;
  }
  if (authMethod === 'rsa') {
    resolved.privateKey = stringConfigValue(input.connection, 'privateKey', env);
    const passphrase = stringConfigValue(input.connection, 'passphrase', env);
    if (passphrase) {
      resolved.passphrase = passphrase;
    }
    if (!resolved.privateKey) {
      throw new Error(`Native Snowflake connector requires connections.${input.connectionId}.privateKey for RSA auth`);
    }
  } else {
    resolved.password = stringConfigValue(input.connection, 'password', env);
    if (!resolved.password) {
      throw new Error(`Native Snowflake connector requires connections.${input.connectionId}.password`);
    }
  }
  return resolved;
}

class DefaultSnowflakeDriverFactory implements KtxSnowflakeDriverFactory {
  createDriver(input: {
    resolved: KtxSnowflakeResolvedConnectionConfig;
    sdkOptionsProvider?: KtxSnowflakeSdkOptionsProvider;
  }): KtxSnowflakeDriver {
    return new SnowflakeSdkDriver(input.resolved, input.sdkOptionsProvider);
  }
}

class SnowflakeSdkDriver implements KtxSnowflakeDriver {
  private closeSdkOptions: Array<() => Promise<void>> = [];
  private pool: ReturnType<typeof snowflake.createPool> | null = null;

  constructor(
    private readonly resolved: KtxSnowflakeResolvedConnectionConfig,
    private readonly sdkOptionsProvider?: KtxSnowflakeSdkOptionsProvider,
  ) {}

  async test(): Promise<{ success: boolean; error?: string }> {
    const timeoutMs = 60_000;
    return Promise.race([
      this.runTest(),
      new Promise<{ success: boolean; error: string }>((resolveTest) =>
        setTimeout(
          () => resolveTest({ success: false, error: `Connection test timed out after ${timeoutMs / 1000}s` }),
          timeoutMs,
        ),
      ),
    ]);
  }

  async query(sql: string, params?: unknown): Promise<KtxQueryResult> {
    const binds = Array.isArray(params) ? toSnowflakeBinds(params) : undefined;
    try {
      const pool = await this.getPool();
      const result = await pool.use(async (connection: snowflake.Connection) =>
        this.executeSnowflakeQuery(connection, sql, binds),
      );
      return { ...result, totalRows: result.rows.length, rowCount: result.rows.length };
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      if (/timeout/i.test(message) && /pool|acquire/i.test(message)) {
        throw new Error(
          "Snowflake session pool exhausted after 60s - consider lowering maxConnections or increasing your account's concurrent-statement limit.",
        );
      }
      throw error;
    }
  }

  async getSchemaMetadata(
    schemaName = this.resolved.schemas[0] ?? 'PUBLIC',
    scopedTableNames: readonly string[] | null = null,
  ): Promise<KtxSnowflakeRawTableMetadata[]> {
    const scopeClause =
      scopedTableNames && scopedTableNames.length > 0
        ? `AND TABLE_NAME IN (${scopedTableNames.map(() => '?').join(', ')})`
        : '';
    const scopeParams = scopedTableNames ?? [];
    const tablesResult = await this.query(
      `
        SELECT TABLE_NAME, TABLE_TYPE, COMMENT, ROW_COUNT
        FROM INFORMATION_SCHEMA.TABLES
        WHERE TABLE_SCHEMA = ? AND TABLE_CATALOG = ? ${scopeClause}
        ORDER BY TABLE_NAME
      `,
      [schemaName, this.resolved.database, ...scopeParams],
    );
    const columnsResult = await this.query(
      `
        SELECT TABLE_NAME, COLUMN_NAME, DATA_TYPE, IS_NULLABLE, COMMENT, ORDINAL_POSITION
        FROM INFORMATION_SCHEMA.COLUMNS
        WHERE TABLE_SCHEMA = ? AND TABLE_CATALOG = ? ${scopeClause}
        ORDER BY TABLE_NAME, ORDINAL_POSITION
      `,
      [schemaName, this.resolved.database, ...scopeParams],
    );
    const columnsByTable = new Map<string, KtxSnowflakeRawColumnMetadata[]>();
    for (const row of columnsResult.rows) {
      const tableName = String(row[0]);
      const columns = columnsByTable.get(tableName) ?? [];
      columns.push({
        name: String(row[1]),
        type: String(row[2]),
        nullable: row[3] === 'YES',
        comment: row[4] ? String(row[4]) : null,
      });
      columnsByTable.set(tableName, columns);
    }
    return tablesResult.rows.map((row) => ({
      name: String(row[0]),
      catalog: this.resolved.database,
      db: schemaName,
      rowCount: firstNumber(row[3]) ?? 0,
      comment: row[2] ? String(row[2]) : null,
      columns: columnsByTable.get(String(row[0])) ?? [],
    }));
  }

  async listSchemas(): Promise<string[]> {
    const result = await this.query(
      `SHOW SCHEMAS IN DATABASE ${quoteSnowflakeIdentifier(this.resolved.database, 'database')}`,
    );
    return result.rows.map((row) => String(row[1])).filter((name) => name !== 'INFORMATION_SCHEMA');
  }

  async listTables(schemas?: string[]): Promise<KtxTableListEntry[]> {
    const filters = schemas && schemas.length > 0 ? schemas.map(() => '?').join(', ') : null;
    const result = await this.query(
      `
    SELECT TABLE_SCHEMA, TABLE_NAME, TABLE_TYPE
    FROM ${quoteSnowflakeIdentifier(this.resolved.database, 'database')}.INFORMATION_SCHEMA.TABLES
    WHERE TABLE_CATALOG = ?
      AND TABLE_SCHEMA <> 'INFORMATION_SCHEMA'
      ${filters ? `AND TABLE_SCHEMA IN (${filters})` : ''}
    ORDER BY TABLE_SCHEMA, TABLE_NAME
    `,
      [this.resolved.database, ...(schemas ?? [])],
    );
    return result.rows.map((row) => ({
      catalog: this.resolved.database,
      schema: String(row[0]),
      name: String(row[1]),
      kind: String(row[2]) === 'VIEW' ? ('view' as const) : ('table' as const),
    }));
  }

  async cleanup(): Promise<void> {
    const pool = this.pool;
    this.pool = null;
    if (pool) {
      // Drain before clear so in-flight Snowflake statements finish before idle
      // sessions are closed.
      await pool.drain();
      await pool.clear();
    }
    const closers = this.closeSdkOptions;
    this.closeSdkOptions = [];
    await Promise.all(closers.map((close) => Promise.resolve(close())));
  }

  private async runTest(): Promise<{ success: boolean; error?: string }> {
    try {
      await this.query('SELECT 1');
      return { success: true };
    } catch (error) {
      return connectorTestFailure(error);
    }
  }

  private async getPool(): Promise<ReturnType<typeof snowflake.createPool>> {
    if (!this.pool) {
      this.pool = snowflake.createPool(await this.resolveConnectionOptions(), {
        min: 0,
        max: this.resolved.maxConnections,
        evictionRunIntervalMillis: 30_000,
        acquireTimeoutMillis: 60_000,
      });
    }
    return this.pool;
  }

  private async resolveConnectionOptions(): Promise<snowflake.ConnectionOptions> {
    const patch = await this.sdkOptionsProvider?.resolve({
      account: this.resolved.account,
      connection: { ...this.resolved, driver: 'snowflake' },
    });
    if (patch?.close) {
      this.closeSdkOptions.push(patch.close);
    }
    const sessionSchema = this.resolved.schemas[0];
    const baseConfig: ConnectionOptions = {
      account: this.resolved.account,
      username: this.resolved.username,
      warehouse: this.resolved.warehouse,
      database: this.resolved.database,
      ...(sessionSchema ? { schema: sessionSchema } : {}),
      role: this.resolved.role,
      clientSessionKeepAlive: true,
      clientSessionKeepAliveHeartbeatFrequency: 900,
      ...patch?.sdkOptions,
    };
    return this.resolved.authMethod === 'rsa'
      ? { ...baseConfig, authenticator: 'SNOWFLAKE_JWT', privateKey: this.decryptPrivateKey() }
      : { ...baseConfig, password: this.resolved.password };
  }

  private async executeSnowflakeQuery(
    connection: Connection,
    sqlText: string,
    binds?: Binds,
  ): Promise<{ headers: string[]; headerTypes?: string[]; rows: unknown[][] }> {
    return new Promise((resolveQuery, rejectQuery) => {
      connection.execute({
        sqlText,
        binds,
        complete: (error, statement, rows) => {
          if (error) {
            rejectQuery(error);
            return;
          }
          const columns = statement.getColumns();
          const headers = columns ? columns.map((column) => column.getName()) : [];
          const headerTypes = columns ? columns.map((column) => column.getType()) : [];
          const normalizedRows = rows
            ? rows.map((row) => headers.map((header, index) => normalizeSnowflakeValue(row[header], headerTypes[index])))
            : [];
          resolveQuery({ headers, headerTypes, rows: normalizedRows });
        },
      });
    });
  }

  private decryptPrivateKey(): string {
    if (!this.resolved.privateKey) {
      throw new Error('Private key is required for RSA authentication');
    }
    const privateKeyObject = createPrivateKey({
      key: this.resolved.privateKey,
      format: 'pem',
      ...(this.resolved.passphrase ? { passphrase: this.resolved.passphrase } : {}),
    });
    return privateKeyObject.export({ format: 'pem', type: 'pkcs8' }) as string;
  }
}

export class KtxSnowflakeScanConnector implements KtxScanConnector {
  readonly id: string;
  readonly driver = 'snowflake' as const;
  readonly capabilities = createKtxConnectorCapabilities({
    tableSampling: true,
    columnSampling: true,
    columnStats: false,
    readOnlySql: true,
    nestedAnalysis: true,
    formalForeignKeys: false,
    estimatedRowCounts: true,
  });

  private readonly resolved: KtxSnowflakeResolvedConnectionConfig;
  private readonly driverFactory: KtxSnowflakeDriverFactory;
  private readonly dialect = getDialectForDriver('snowflake');
  private readonly now: () => Date;
  private driverInstance: KtxSnowflakeDriver | null = null;

  constructor(private readonly options: KtxSnowflakeScanConnectorOptions) {
    this.resolved = snowflakeConnectionConfigFromConfig(options);
    this.driverFactory = options.driverFactory ?? new DefaultSnowflakeDriverFactory();
    this.now = options.now ?? (() => new Date());
    this.id = `snowflake:${options.connectionId}`;
    if (options.projectDir) {
      configureSnowflakeSdkLogger(options.projectDir);
    }
  }

  async testConnection(): Promise<KtxConnectorTestResult> {
    return this.getDriver().test();
  }

  async introspect(input: KtxScanInput, _ctx: KtxScanContext): Promise<KtxSchemaSnapshot> {
    this.assertConnection(input.connectionId);
    const tables: KtxSchemaTable[] = [];
    const snapshotWarnings: KtxScanWarning[] = [];
    for (const schemaName of this.resolved.schemas) {
      const scopedNames = input.tableScope
        ? scopedTableNames(input.tableScope, { catalog: this.resolved.database, db: schemaName })
        : null;
      if (scopedNames && scopedNames.length === 0) continue;
      const rawTables = await this.getDriver().getSchemaMetadata(schemaName, scopedNames);
      const primaryKeysResult = await tryConstraintQuery(
        { schema: schemaName, kind: 'primary_key', isDeniedError },
        () => this.primaryKeys(rawTables.map((table) => table.name), schemaName),
      );
      const primaryKeys = primaryKeysResult.ok
        ? primaryKeysResult.value
        : new Map(rawTables.map((table) => [table.name, new Set<string>()]));
      if (!primaryKeysResult.ok) {
        snapshotWarnings.push(primaryKeysResult.warning);
      }
      tables.push(...rawTables.map((table) => this.toSchemaTable(table, primaryKeys)));
    }
    return {
      connectionId: this.options.connectionId,
      driver: 'snowflake',
      extractedAt: this.now().toISOString(),
      scope: { catalogs: [this.resolved.database], schemas: this.resolved.schemas },
      metadata: {
        account: this.resolved.account,
        warehouse: this.resolved.warehouse,
        database: this.resolved.database,
        schemas: this.resolved.schemas,
        table_count: tables.length,
        total_columns: tables.reduce((sum, table) => sum + table.columns.length, 0),
      },
      tables,
      warnings: snapshotWarnings,
    };
  }

  async sampleTable(input: KtxTableSampleInput, _ctx: KtxScanContext): Promise<KtxTableSampleResult> {
    this.assertConnection(input.connectionId);
    const result = await this.getDriver().query(
      this.dialect.generateSampleQuery(this.qTableName(input.table), input.limit, input.columns),
    );
    return { headers: result.headers, rows: result.rows, totalRows: result.totalRows };
  }

  async sampleColumn(input: KtxColumnSampleInput, _ctx: KtxScanContext): Promise<KtxColumnSampleResult> {
    this.assertConnection(input.connectionId);
    const result = await this.getDriver().query(
      this.dialect.generateColumnSampleQuery(this.qTableName(input.table), input.column, input.limit),
    );
    return {
      values: result.rows.filter((row) => row.length > 0 && row[0] !== null).map((row) => row[0]),
      nullCount: null,
      distinctCount: null,
    };
  }

  async columnStats(_input: KtxColumnStatsInput, _ctx: KtxScanContext): Promise<KtxColumnStatsResult | null> {
    return null;
  }

  async executeReadOnly(input: KtxSnowflakeReadOnlyQueryInput, _ctx: KtxScanContext): Promise<KtxQueryResult> {
    this.assertConnection(input.connectionId);
    const limitedSql = limitSqlForExecution(assertReadOnlySql(input.sql), input.maxRows);
    const prepared = prepareSnowflakeReadOnlyQuery(limitedSql, input.params);
    return this.getDriver().query(prepared.sql, prepared.params);
  }

  async getColumnDistinctValues(
    table: KtxTableRef,
    columnName: string,
    options: KtxSnowflakeColumnDistinctValuesOptions,
  ): Promise<KtxSnowflakeColumnDistinctValuesResult | null> {
    const tableName = this.qTableName(table);
    const quotedColumn = this.dialect.quoteIdentifier(columnName);
    const cardinality = await this.singleNumber(
      this.dialect.generateCardinalitySampleQuery(tableName, quotedColumn, options.sampleSize ?? 10000),
      'CARDINALITY',
    );
    if (cardinality === null) {
      return null;
    }
    if (cardinality === 0) {
      return { values: [], cardinality: 0 };
    }
    if (cardinality > options.maxCardinality) {
      return { values: null, cardinality };
    }
    const valueRows = await this.queryRaw<Record<string, unknown>>(
      this.dialect.generateDistinctValuesQuery(tableName, quotedColumn, options.limit),
    );
    return { values: valueRows.map((row) => String(row.VAL ?? row.val)).filter((value) => value !== 'null'), cardinality };
  }

  async getTableRowCount(tableName: string, schemaName = this.resolved.schemas[0] ?? 'PUBLIC'): Promise<number> {
    const tables = await this.getDriver().getSchemaMetadata(schemaName);
    return tables.find((table) => table.name === tableName)?.rowCount ?? 0;
  }

  qTableName(table: Pick<KtxTableRef, 'name'> & Partial<Pick<KtxTableRef, 'catalog' | 'db'>>): string {
    return this.dialect.formatTableName(table);
  }

  quoteIdentifier(identifier: string): string {
    return this.dialect.quoteIdentifier(identifier);
  }

  listSchemas(): Promise<string[]> {
    return this.getDriver().listSchemas();
  }

  async listTables(schemas?: string[]): Promise<KtxTableListEntry[]> {
    const filters = schemas && schemas.length > 0 ? schemas.map(() => '?').join(', ') : null;
    const result = await this.getDriver().query(
      `
    SELECT TABLE_SCHEMA, TABLE_NAME, TABLE_TYPE
    FROM ${quoteSnowflakeIdentifier(this.resolved.database, 'database')}.INFORMATION_SCHEMA.TABLES
    WHERE TABLE_CATALOG = ?
      AND TABLE_SCHEMA <> 'INFORMATION_SCHEMA'
      ${filters ? `AND TABLE_SCHEMA IN (${filters})` : ''}
    ORDER BY TABLE_SCHEMA, TABLE_NAME
    `,
      [this.resolved.database, ...(schemas ?? [])],
    );
    return result.rows.map((row) => ({
      catalog: this.resolved.database,
      schema: String(row[0]),
      name: String(row[1]),
      kind: String(row[2]) === 'VIEW' ? ('view' as const) : ('table' as const),
    }));
  }

  async cleanup(): Promise<void> {
    if (this.driverInstance) {
      await this.driverInstance.cleanup();
      this.driverInstance = null;
    }
  }

  private getDriver(): KtxSnowflakeDriver {
    if (!this.driverInstance) {
      this.driverInstance = this.driverFactory.createDriver({
        resolved: this.resolved,
        sdkOptionsProvider: this.options.sdkOptionsProvider,
      });
    }
    return this.driverInstance;
  }

  private async primaryKeys(tableNames: string[], schemaName: string): Promise<Map<string, Set<string>>> {
    const grouped = new Map<string, Set<string>>();
    for (const tableName of tableNames) {
      grouped.set(tableName, new Set());
    }
    if (tableNames.length === 0) {
      return grouped;
    }
    const tableNamePlaceholders = tableNames.map(() => '?').join(', ');
    const result = await this.getDriver().query(
      `
          SELECT tc.TABLE_NAME, kcu.COLUMN_NAME
          FROM INFORMATION_SCHEMA.TABLE_CONSTRAINTS tc
          JOIN INFORMATION_SCHEMA.KEY_COLUMN_USAGE kcu
            ON tc.CONSTRAINT_NAME = kcu.CONSTRAINT_NAME
            AND tc.TABLE_SCHEMA = kcu.TABLE_SCHEMA
            AND tc.TABLE_CATALOG = kcu.TABLE_CATALOG
          WHERE tc.CONSTRAINT_TYPE = 'PRIMARY KEY'
            AND tc.TABLE_SCHEMA = ?
            AND tc.TABLE_CATALOG = ?
            AND tc.TABLE_NAME IN (${tableNamePlaceholders})
          ORDER BY tc.TABLE_NAME, kcu.ORDINAL_POSITION
        `,
      [schemaName, this.resolved.database, ...tableNames],
    );
    for (const row of result.rows) {
      const tableName = String(row[0]);
      const columnName = String(row[1]);
      grouped.get(tableName)?.add(columnName);
    }
    return grouped;
  }

  private toSchemaTable(table: KtxSnowflakeRawTableMetadata, primaryKeys: Map<string, Set<string>>): KtxSchemaTable {
    return {
      catalog: table.catalog,
      db: table.db,
      name: table.name,
      kind: 'table',
      comment: table.comment,
      estimatedRows: table.rowCount,
      columns: table.columns.map((column) => this.toSchemaColumn(table.name, column, primaryKeys)),
      foreignKeys: [],
    };
  }

  private toSchemaColumn(
    tableName: string,
    column: KtxSnowflakeRawColumnMetadata,
    primaryKeys: Map<string, Set<string>>,
  ): KtxSchemaColumn {
    return {
      name: column.name,
      nativeType: column.type,
      normalizedType: this.dialect.mapDataType(column.type),
      dimensionType: this.dialect.mapToDimensionType(column.type),
      nullable: column.nullable,
      primaryKey: primaryKeys.get(tableName)?.has(column.name) ?? false,
      comment: column.comment,
    };
  }

  private async queryRaw<T extends Record<string, unknown>>(sql: string, params?: unknown): Promise<T[]> {
    const result = await this.getDriver().query(sql, params);
    return result.rows.map((row) => Object.fromEntries(result.headers.map((header, index) => [header, row[index]])) as T);
  }

  private async singleNumber(sql: string, header: string): Promise<number | null> {
    const rows = await this.queryRaw<Record<string, unknown>>(sql);
    return firstNumber(rows[0]?.[header] ?? rows[0]?.[header.toLowerCase()]);
  }

  private assertConnection(connectionId: string): void {
    if (connectionId !== this.options.connectionId) {
      throw new Error(`Snowflake connector ${this.options.connectionId} cannot scan connection ${connectionId}`);
    }
  }
}
