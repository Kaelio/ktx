import { DBSQLClient } from '@databricks/sql';
import { getSqlDialectForDriver } from '../../context/connections/dialects.js';
import { queryDeadlineExceededError, resolveQueryDeadlineMs } from '../../context/connections/query-deadline.js';
import { assertReadOnlySql, limitSqlForExecution } from '../../context/connections/read-only-sql.js';
import { tryConstraintQuery } from '../../context/scan/constraint-discovery.js';
import { scopedTableNames } from '../../context/scan/table-ref.js';
import {
  connectorTestFailure,
  createKtxConnectorCapabilities,
  type KtxColumnSampleInput,
  type KtxColumnSampleResult,
  type KtxColumnStatsInput,
  type KtxColumnStatsResult,
  type KtxConnectorTestResult,
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
import { resolveStringReference } from '../shared/string-reference.js';

export interface KtxDatabricksConnectionConfig {
  driver?: string;
  authMethod?: 'pat' | 'oauth-m2m';
  server_hostname?: string;
  http_path?: string;
  catalog?: string;
  schema_name?: string;
  schema_names?: string[];
  token?: string;
  client_id?: string;
  client_secret?: string;
  query_timeout_ms?: number;
  [key: string]: unknown;
}

export interface KtxDatabricksResolvedConnectionConfig {
  authMethod: 'pat' | 'oauth-m2m';
  serverHostname: string;
  httpPath: string;
  catalog: string;
  schemas: string[];
  token?: string;
  clientId?: string;
  clientSecret?: string;
  deadlineMs: number;
}

export interface KtxDatabricksRawColumnMetadata {
  name: string;
  type: string;
  nullable: boolean;
  comment: string | null;
}

export interface KtxDatabricksRawTableMetadata {
  name: string;
  catalog: string;
  db: string;
  kind: 'table' | 'view';
  rowCount: number | null;
  comment: string | null;
  columns: KtxDatabricksRawColumnMetadata[];
}

export interface KtxDatabricksDriver {
  test(): Promise<KtxConnectorTestResult>;
  query(sql: string, params?: unknown[]): Promise<KtxQueryResult>;
  getSchemaMetadata(schemaName: string, scopedTableNames?: readonly string[] | null): Promise<KtxDatabricksRawTableMetadata[]>;
  listSchemas(): Promise<string[]>;
  listTables(schemas?: string[]): Promise<KtxTableListEntry[]>;
  cleanup(): Promise<void>;
}

export interface KtxDatabricksDriverFactory {
  createDriver(input: { resolved: KtxDatabricksResolvedConnectionConfig }): KtxDatabricksDriver;
}

export interface KtxDatabricksScanConnectorOptions {
  connectionId: string;
  connection: KtxDatabricksConnectionConfig | undefined;
  driverFactory?: KtxDatabricksDriverFactory;
  env?: NodeJS.ProcessEnv;
  now?: () => Date;
}

export interface KtxDatabricksReadOnlyQueryInput extends KtxReadOnlyQueryInput {
  params?: Record<string, unknown>;
}

export interface KtxDatabricksColumnDistinctValuesOptions {
  maxCardinality: number;
  limit: number;
  sampleSize?: number;
}

export interface KtxDatabricksColumnDistinctValuesResult {
  values: string[] | null;
  cardinality: number;
}

interface DatabricksOperation {
  fetchAll(options?: { maxRows?: number }): Promise<Array<Record<string, unknown>>>;
  getSchema(): Promise<{ columns?: Array<{ columnName?: string }> } | null>;
  cancel(): Promise<unknown>;
  close(): Promise<unknown>;
}

interface DatabricksSession {
  executeStatement(
    sql: string,
    options?: {
      runAsync?: boolean;
      maxRows?: number;
      ordinalParameters?: unknown[];
      statementConf?: Record<string, string>;
    },
  ): Promise<DatabricksOperation>;
  close(): Promise<unknown>;
}

interface DatabricksClient {
  connect(options: Record<string, unknown>): Promise<DatabricksClient>;
  openSession(request?: { initialCatalog?: string; initialSchema?: string; configuration?: Record<string, string> }): Promise<DatabricksSession>;
  close(): Promise<void>;
}

function stringConfigValue(
  connection: KtxDatabricksConnectionConfig | undefined,
  key: keyof KtxDatabricksConnectionConfig,
  env: NodeJS.ProcessEnv,
): string | undefined {
  const value = connection?.[key];
  return typeof value === 'string' && value.trim().length > 0 ? resolveStringReference(value.trim(), env) : undefined;
}

function schemaNames(connection: KtxDatabricksConnectionConfig, env: NodeJS.ProcessEnv): string[] {
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
    return /permission denied|insufficient privileges|not authorized|access denied/i.test(error.message);
  }
  return false;
}

function databricksRowsToQueryResult(rows: Array<Record<string, unknown>>, headers: string[]): KtxQueryResult {
  const resolvedHeaders = headers.length > 0 ? headers : Object.keys(rows[0] ?? {});
  return {
    headers: resolvedHeaders,
    rows: rows.map((row) => resolvedHeaders.map((header) => row[header])),
    totalRows: rows.length,
    rowCount: rows.length,
  };
}

function toDatabricksParams(params: unknown[] | undefined): unknown[] | undefined {
  return params?.map((value) => (value instanceof Date ? value.toISOString() : value));
}

function isTimeoutError(error: unknown): boolean {
  return error instanceof Error && /timeout|timed out|deadline/i.test(error.message);
}

function connectionOptions(resolved: KtxDatabricksResolvedConnectionConfig): Record<string, unknown> {
  const base = {
    host: resolved.serverHostname,
    path: resolved.httpPath,
    preserveBigNumericPrecision: true,
    telemetryEnabled: false,
  };
  if (resolved.authMethod === 'oauth-m2m') {
    return {
      ...base,
      authType: 'databricks-oauth',
      oauthClientId: resolved.clientId,
      oauthClientSecret: resolved.clientSecret,
    };
  }
  return { ...base, authType: 'access-token', token: resolved.token };
}

/** @internal */
export function prepareDatabricksReadOnlyQuery(
  sql: string,
  params?: Record<string, unknown>,
): { sql: string; params?: unknown[] } {
  if (!params || Object.keys(params).length === 0) {
    return { sql, params: undefined };
  }
  const values: unknown[] = [];
  const used = new Set<string>();
  let rewritten = '';
  let quote: "'" | '"' | '`' | null = null;
  let lineComment = false;
  let blockComment = false;
  for (let index = 0; index < sql.length; index += 1) {
    const char = sql[index]!;
    const next = sql[index + 1];
    if (lineComment) {
      rewritten += char;
      if (char === '\n') lineComment = false;
      continue;
    }
    if (blockComment) {
      rewritten += char;
      if (char === '*' && next === '/') {
        rewritten += next;
        index += 1;
        blockComment = false;
      }
      continue;
    }
    if (quote) {
      rewritten += char;
      if (char === quote) {
        if (next === quote) {
          rewritten += next;
          index += 1;
        } else {
          quote = null;
        }
      }
      continue;
    }
    if (char === '-' && next === '-') {
      rewritten += char + next;
      index += 1;
      lineComment = true;
      continue;
    }
    if (char === '/' && next === '*') {
      rewritten += char + next;
      index += 1;
      blockComment = true;
      continue;
    }
    if (char === "'" || char === '"' || char === '`') {
      rewritten += char;
      quote = char;
      continue;
    }
    if (char === ':' && next && /[A-Za-z_]/.test(next) && sql[index - 1] !== ':') {
      let end = index + 2;
      while (end < sql.length && /[A-Za-z0-9_]/.test(sql[end]!)) {
        end += 1;
      }
      const name = sql.slice(index + 1, end);
      if (!Object.prototype.hasOwnProperty.call(params, name)) {
        throw new Error(`Databricks read-only SQL parameter :${name} has no supplied value`);
      }
      values.push(params[name]);
      used.add(name);
      rewritten += '?';
      index = end - 1;
      continue;
    }
    rewritten += char;
  }
  if (values.length === 0) {
    throw new Error('Databricks read-only SQL parameters must use named placeholders like :id');
  }
  const unused = Object.keys(params).filter((name) => !used.has(name));
  if (unused.length > 0) {
    throw new Error(`Databricks read-only SQL received unused parameter(s): ${unused.join(', ')}`);
  }
  return { sql: rewritten, params: values };
}

export function isKtxDatabricksConnectionConfig(
  connection: KtxDatabricksConnectionConfig | undefined,
): connection is KtxDatabricksConnectionConfig {
  return String(connection?.driver ?? '').toLowerCase() === 'databricks';
}

/** @internal */
export function databricksConnectionConfigFromConfig(input: {
  connectionId: string;
  connection: KtxDatabricksConnectionConfig | undefined;
  env?: NodeJS.ProcessEnv;
}): KtxDatabricksResolvedConnectionConfig {
  const inputDriver = input.connection?.driver ?? 'unknown';
  if (!isKtxDatabricksConnectionConfig(input.connection)) {
    throw new Error(`Native Databricks connector cannot run driver "${inputDriver}"`);
  }
  const env = input.env ?? process.env;
  const serverHostname = stringConfigValue(input.connection, 'server_hostname', env);
  const httpPath = stringConfigValue(input.connection, 'http_path', env);
  const catalog = stringConfigValue(input.connection, 'catalog', env);
  if (!serverHostname) {
    throw new Error(`Native Databricks connector requires connections.${input.connectionId}.server_hostname`);
  }
  if (!httpPath) {
    throw new Error(`Native Databricks connector requires connections.${input.connectionId}.http_path`);
  }
  if (!catalog) {
    throw new Error(`Native Databricks connector requires connections.${input.connectionId}.catalog`);
  }
  const authMethod = input.connection.authMethod ?? 'pat';
  const resolved: KtxDatabricksResolvedConnectionConfig = {
    authMethod,
    serverHostname,
    httpPath,
    catalog,
    schemas: schemaNames(input.connection, env),
    deadlineMs: resolveQueryDeadlineMs(input.connection),
  };
  if (authMethod === 'oauth-m2m') {
    resolved.clientId = stringConfigValue(input.connection, 'client_id', env);
    resolved.clientSecret = stringConfigValue(input.connection, 'client_secret', env);
    if (!resolved.clientId) {
      throw new Error(`Native Databricks connector requires connections.${input.connectionId}.client_id for OAuth M2M auth`);
    }
    if (!resolved.clientSecret) {
      throw new Error(`Native Databricks connector requires connections.${input.connectionId}.client_secret for OAuth M2M auth`);
    }
    return resolved;
  }
  resolved.token = stringConfigValue(input.connection, 'token', env);
  if (!resolved.token) {
    throw new Error(`Native Databricks connector requires connections.${input.connectionId}.token for PAT auth`);
  }
  return resolved;
}

class DefaultDatabricksDriverFactory implements KtxDatabricksDriverFactory {
  createDriver(input: { resolved: KtxDatabricksResolvedConnectionConfig }): KtxDatabricksDriver {
    return new DatabricksSqlDriver(input.resolved);
  }
}

class DatabricksSqlDriver implements KtxDatabricksDriver {
  constructor(private readonly resolved: KtxDatabricksResolvedConnectionConfig) {}

  async test(): Promise<KtxConnectorTestResult> {
    try {
      await this.query('SELECT 1');
      return { success: true };
    } catch (error) {
      return connectorTestFailure(error);
    }
  }

  async query(sql: string, params?: unknown[]): Promise<KtxQueryResult> {
    return this.withSession(async (session) => {
      const operationRef: { current: DatabricksOperation | null } = { current: null };
      let timeout: ReturnType<typeof setTimeout> | null = null;
      let deadlineExceeded = false;
      try {
        const query = async () => {
          operationRef.current = await session.executeStatement(sql, {
            runAsync: true,
            maxRows: 10000,
            ordinalParameters: toDatabricksParams(params),
          });
          const schema = await operationRef.current.getSchema();
          const rows = await operationRef.current.fetchAll();
          return databricksRowsToQueryResult(rows, schema?.columns?.map((column) => column.columnName ?? '') ?? []);
        };
        return await Promise.race([
          query(),
          new Promise<KtxQueryResult>((_resolve, reject) => {
            timeout = setTimeout(() => {
              deadlineExceeded = true;
              reject(queryDeadlineExceededError(this.resolved.deadlineMs));
            }, this.resolved.deadlineMs);
          }),
        ]);
      } catch (error) {
        if (isTimeoutError(error)) {
          throw queryDeadlineExceededError(this.resolved.deadlineMs, { cause: error });
        }
        throw error;
      } finally {
        if (timeout) {
          clearTimeout(timeout);
        }
        if (operationRef.current) {
          if (deadlineExceeded) {
            await Promise.resolve(operationRef.current.cancel()).catch(() => undefined);
          }
          await Promise.resolve(operationRef.current.close()).catch(() => undefined);
        }
      }
    });
  }

  async getSchemaMetadata(
    schemaName: string,
    scopedTableNames: readonly string[] | null = null,
  ): Promise<KtxDatabricksRawTableMetadata[]> {
    const scopeClause =
      scopedTableNames && scopedTableNames.length > 0
        ? `AND TABLE_NAME IN (${scopedTableNames.map(() => '?').join(', ')})`
        : '';
    const scopeParams = scopedTableNames ?? [];
    const tablesResult = await this.query(
      `
        SELECT TABLE_NAME, TABLE_TYPE, COMMENT
        FROM ${this.informationSchemaTable('TABLES')}
        WHERE TABLE_SCHEMA = ? AND TABLE_CATALOG = ? ${scopeClause}
        ORDER BY TABLE_NAME
      `,
      [schemaName, this.resolved.catalog, ...scopeParams],
    );
    const columnsResult = await this.query(
      `
        SELECT TABLE_NAME, COLUMN_NAME, FULL_DATA_TYPE, IS_NULLABLE, COMMENT, ORDINAL_POSITION
        FROM ${this.informationSchemaTable('COLUMNS')}
        WHERE TABLE_SCHEMA = ? AND TABLE_CATALOG = ? ${scopeClause}
        ORDER BY TABLE_NAME, ORDINAL_POSITION
      `,
      [schemaName, this.resolved.catalog, ...scopeParams],
    );
    const columnsByTable = new Map<string, KtxDatabricksRawColumnMetadata[]>();
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
      catalog: this.resolved.catalog,
      db: schemaName,
      kind: String(row[1]).toUpperCase().includes('VIEW') ? 'view' : 'table',
      rowCount: null,
      comment: row[2] ? String(row[2]) : null,
      columns: columnsByTable.get(String(row[0])) ?? [],
    }));
  }

  async listSchemas(): Promise<string[]> {
    const result = await this.query(
      `
        SELECT SCHEMA_NAME
        FROM ${this.informationSchemaTable('SCHEMATA')}
        WHERE CATALOG_NAME = ?
          AND SCHEMA_NAME <> 'information_schema'
        ORDER BY SCHEMA_NAME
      `,
      [this.resolved.catalog],
    );
    return result.rows.map((row) => String(row[0]));
  }

  async listTables(schemas?: string[]): Promise<KtxTableListEntry[]> {
    const filters = schemas && schemas.length > 0 ? schemas.map(() => '?').join(', ') : null;
    const result = await this.query(
      `
        SELECT TABLE_SCHEMA, TABLE_NAME, TABLE_TYPE
        FROM ${this.informationSchemaTable('TABLES')}
        WHERE TABLE_CATALOG = ?
          AND TABLE_SCHEMA <> 'information_schema'
          ${filters ? `AND TABLE_SCHEMA IN (${filters})` : ''}
        ORDER BY TABLE_SCHEMA, TABLE_NAME
      `,
      [this.resolved.catalog, ...(schemas ?? [])],
    );
    return result.rows.map((row) => ({
      catalog: this.resolved.catalog,
      schema: String(row[0]),
      name: String(row[1]),
      kind: String(row[2]).toUpperCase().includes('VIEW') ? ('view' as const) : ('table' as const),
    }));
  }

  async cleanup(): Promise<void> {}

  private informationSchemaTable(name: string): string {
    return [this.resolved.catalog, 'INFORMATION_SCHEMA', name].map(this.quoteIdentifier).join('.');
  }

  private quoteIdentifier(identifier: string): string {
    return `\`${identifier.replace(/`/g, '``')}\``;
  }

  private async withSession<T>(fn: (session: DatabricksSession) => Promise<T>): Promise<T> {
    const client = new DBSQLClient() as unknown as DatabricksClient;
    let session: DatabricksSession | null = null;
    try {
      await client.connect(connectionOptions(this.resolved));
      session = await client.openSession({
        initialCatalog: this.resolved.catalog,
        initialSchema: this.resolved.schemas[0],
      });
      return await fn(session);
    } finally {
      if (session) {
        await Promise.resolve(session.close()).catch(() => undefined);
      }
      await client.close();
    }
  }
}

export class KtxDatabricksScanConnector implements KtxScanConnector {
  readonly id: string;
  readonly driver = 'databricks' as const;
  readonly capabilities = createKtxConnectorCapabilities({
    tableSampling: true,
    columnSampling: true,
    columnStats: false,
    readOnlySql: true,
    nestedAnalysis: true,
    formalForeignKeys: false,
    estimatedRowCounts: false,
  });

  private readonly resolved: KtxDatabricksResolvedConnectionConfig;
  private readonly driverFactory: KtxDatabricksDriverFactory;
  private readonly dialect = getSqlDialectForDriver('databricks');
  private readonly now: () => Date;
  private driverInstance: KtxDatabricksDriver | null = null;

  constructor(private readonly options: KtxDatabricksScanConnectorOptions) {
    this.resolved = databricksConnectionConfigFromConfig(options);
    this.driverFactory = options.driverFactory ?? new DefaultDatabricksDriverFactory();
    this.now = options.now ?? (() => new Date());
    this.id = `databricks:${options.connectionId}`;
  }

  async testConnection(): Promise<KtxConnectorTestResult> {
    return this.getDriver().test();
  }

  async introspect(input: KtxScanInput, _ctx: KtxScanContext): Promise<KtxSchemaSnapshot> {
    this.assertConnection(input.connectionId);
    const schemaScope = this.resolved.schemas.length > 0 ? this.resolved.schemas : await this.getDriver().listSchemas();
    const tables: KtxSchemaTable[] = [];
    const snapshotWarnings: KtxScanWarning[] = [];
    for (const schemaName of schemaScope) {
      const scopedNames = input.tableScope
        ? scopedTableNames(input.tableScope, { catalog: this.resolved.catalog, db: schemaName })
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
      driver: 'databricks',
      extractedAt: this.now().toISOString(),
      scope: { catalogs: [this.resolved.catalog], schemas: schemaScope },
      metadata: {
        server_hostname: this.resolved.serverHostname,
        http_path: this.resolved.httpPath,
        catalog: this.resolved.catalog,
        schemas: schemaScope,
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

  async executeReadOnly(input: KtxDatabricksReadOnlyQueryInput, _ctx: KtxScanContext): Promise<KtxQueryResult> {
    this.assertConnection(input.connectionId);
    const limitedSql = limitSqlForExecution(assertReadOnlySql(input.sql), input.maxRows);
    const prepared = prepareDatabricksReadOnlyQuery(limitedSql, input.params);
    return this.getDriver().query(prepared.sql, prepared.params);
  }

  async getColumnDistinctValues(
    table: KtxTableRef,
    columnName: string,
    options: KtxDatabricksColumnDistinctValuesOptions,
  ): Promise<KtxDatabricksColumnDistinctValuesResult | null> {
    const tableName = this.qTableName(table);
    const quotedColumn = this.dialect.quoteIdentifier(columnName);
    const cardinality = await this.singleNumber(
      this.dialect.generateRandomizedCardinalitySampleQuery(tableName, quotedColumn, options.sampleSize ?? 10000),
      'cardinality',
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
    return { values: valueRows.map((row) => String(row.val ?? row.VAL)).filter((value) => value !== 'null'), cardinality };
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

  listTables(schemas?: string[]): Promise<KtxTableListEntry[]> {
    return this.getDriver().listTables(schemas);
  }

  async cleanup(): Promise<void> {
    if (this.driverInstance) {
      await this.driverInstance.cleanup();
      this.driverInstance = null;
    }
  }

  private getDriver(): KtxDatabricksDriver {
    if (!this.driverInstance) {
      this.driverInstance = this.driverFactory.createDriver({ resolved: this.resolved });
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
        FROM ${this.qTableName({ catalog: this.resolved.catalog, db: 'INFORMATION_SCHEMA', name: 'TABLE_CONSTRAINTS' })} tc
        JOIN ${this.qTableName({ catalog: this.resolved.catalog, db: 'INFORMATION_SCHEMA', name: 'KEY_COLUMN_USAGE' })} kcu
          ON tc.CONSTRAINT_NAME = kcu.CONSTRAINT_NAME
          AND tc.TABLE_SCHEMA = kcu.TABLE_SCHEMA
          AND tc.TABLE_CATALOG = kcu.TABLE_CATALOG
        WHERE tc.CONSTRAINT_TYPE = 'PRIMARY KEY'
          AND tc.TABLE_SCHEMA = ?
          AND tc.TABLE_CATALOG = ?
          AND tc.TABLE_NAME IN (${tableNamePlaceholders})
        ORDER BY tc.TABLE_NAME, kcu.ORDINAL_POSITION
      `,
      [schemaName, this.resolved.catalog, ...tableNames],
    );
    for (const row of result.rows) {
      const tableName = String(row[0]);
      const columnName = String(row[1]);
      grouped.get(tableName)?.add(columnName);
    }
    return grouped;
  }

  private toSchemaTable(
    table: KtxDatabricksRawTableMetadata,
    primaryKeys: Map<string, Set<string>>,
  ): KtxSchemaTable {
    return {
      catalog: table.catalog,
      db: table.db,
      name: table.name,
      kind: table.kind,
      comment: table.comment,
      estimatedRows: table.rowCount,
      columns: table.columns.map((column) => this.toSchemaColumn(table.name, column, primaryKeys)),
      foreignKeys: [],
    };
  }

  private toSchemaColumn(
    tableName: string,
    column: KtxDatabricksRawColumnMetadata,
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

  private async queryRaw<T extends Record<string, unknown>>(sql: string, params?: unknown[]): Promise<T[]> {
    const result = await this.getDriver().query(sql, params);
    return result.rows.map((row) => Object.fromEntries(result.headers.map((header, index) => [header, row[index]])) as T);
  }

  private async singleNumber(sql: string, header: string): Promise<number | null> {
    const rows = await this.queryRaw<Record<string, unknown>>(sql);
    return firstNumber(rows[0]?.[header] ?? rows[0]?.[header.toUpperCase()]);
  }

  private assertConnection(connectionId: string): void {
    if (connectionId !== this.options.connectionId) {
      throw new Error(`Databricks connector ${this.options.connectionId} cannot scan connection ${connectionId}`);
    }
  }
}
