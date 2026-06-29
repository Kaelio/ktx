import Database from 'better-sqlite3';
import { existsSync, readFileSync, statSync } from 'node:fs';
import { homedir } from 'node:os';
import { isAbsolute, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { getSqlDialectForDriver } from '../../context/connections/dialects.js';
import { assertReadOnlySql, limitSqlForExecution } from '../../context/connections/read-only-sql.js';
import { normalizeQueryRows } from '../../context/connections/query-executor.js';
import { connectorTestFailure, createKtxConnectorCapabilities, type KtxConnectorTestResult, type KtxColumnSampleInput, type KtxColumnSampleResult, type KtxColumnStatsInput, type KtxColumnStatsResult, type KtxQueryResult, type KtxReadOnlyQueryInput, type KtxScanConnector, type KtxScanContext, type KtxScanInput, type KtxSchemaForeignKey, type KtxSchemaSnapshot, type KtxSchemaTable, type KtxTableListEntry, type KtxTableRef, type KtxTableSampleInput, type KtxTableSampleResult } from '../../context/scan/types.js';
import { scopedTableNames } from '../../context/scan/table-ref.js';

export interface KtxSqliteConnectionConfig {
  driver?: string;
  path?: string;
  url?: string;
  [key: string]: unknown;
}

/** @internal */
export interface SqliteDatabasePathInput {
  connectionId: string;
  projectDir?: string;
  connection: KtxSqliteConnectionConfig | undefined;
}

export interface KtxSqliteScanConnectorOptions extends SqliteDatabasePathInput {
  now?: () => Date;
}

export interface KtxSqliteReadOnlyQueryInput extends KtxReadOnlyQueryInput {
  params?: Record<string, unknown> | unknown[];
}

export interface KtxSqliteColumnDistinctValuesOptions {
  maxCardinality: number;
  limit: number;
  sampleSize?: number;
}

export interface KtxSqliteColumnDistinctValuesResult {
  values: string[] | null;
  cardinality: number;
}

interface SqliteMasterRow {
  name: string;
  type: 'table' | 'view';
}

interface SqliteTableInfoRow {
  cid: number;
  name: string;
  type: string;
  notnull: number;
  dflt_value: unknown;
  pk: number;
}

interface SqliteForeignKeyRow {
  id: number;
  seq: number;
  table: string;
  from: string;
  to: string;
}

function stringConfigValue(
  connection: KtxSqliteConnectionConfig | undefined,
  key: keyof KtxSqliteConnectionConfig,
): string | undefined {
  const value = connection?.[key];
  return typeof value === 'string' && value.trim().length > 0 ? resolveStringReference(key, value.trim()) : undefined;
}

function resolveStringReference(key: keyof KtxSqliteConnectionConfig, value: string): string {
  if (value.startsWith('env:')) {
    return process.env[value.slice('env:'.length)] ?? '';
  }
  // `file:` on the `url` key is SQLite's native URI form (e.g. `file:///db.sqlite`), not a
  // file-contents reference — skip the read so the URI passes through verbatim.
  if (key !== 'url' && value.startsWith('file:')) {
    const rawPath = value.slice('file:'.length);
    const path = rawPath.startsWith('~') ? resolve(homedir(), rawPath.slice(1)) : rawPath;
    return readFileSync(path, 'utf-8').trim();
  }
  return value;
}

function sqlitePathFromUrl(url: string): string {
  if (url.startsWith('file:')) {
    return fileURLToPath(url);
  }
  if (url.startsWith('sqlite:')) {
    const parsed = new URL(url);
    return decodeURIComponent(parsed.pathname);
  }
  return url;
}

export function isKtxSqliteConnectionConfig(
  connection: KtxSqliteConnectionConfig | undefined,
): connection is KtxSqliteConnectionConfig {
  const driver = String(connection?.driver ?? '').toLowerCase();
  return driver === 'sqlite';
}

/** @internal */
export function sqliteDatabasePathFromConfig(input: SqliteDatabasePathInput): string {
  const inputDriver = input.connection?.driver ?? 'unknown';
  if (!isKtxSqliteConnectionConfig(input.connection)) {
    throw new Error(`Native SQLite connector cannot run driver "${inputDriver}"`);
  }
  const configuredPath = stringConfigValue(input.connection, 'path') ?? sqlitePathFromUrl(stringConfigValue(input.connection, 'url') ?? '');
  if (!configuredPath) {
    throw new Error(`Native SQLite connector requires connections.${input.connectionId}.path or url`);
  }
  return isAbsolute(configuredPath) ? configuredPath : resolve(input.projectDir ?? process.cwd(), configuredPath);
}

export class KtxSqliteScanConnector implements KtxScanConnector {
  readonly id: string;
  readonly driver = 'sqlite' as const;
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
  private readonly dbPath: string;
  private readonly now: () => Date;
  private readonly dialect = getSqlDialectForDriver('sqlite');
  private db: Database.Database | null = null;

  constructor(options: KtxSqliteScanConnectorOptions) {
    this.connectionId = options.connectionId;
    this.dbPath = sqliteDatabasePathFromConfig(options);
    this.now = options.now ?? (() => new Date());
    this.id = `sqlite:${options.connectionId}`;
  }

  async testConnection(): Promise<KtxConnectorTestResult> {
    try {
      if (!existsSync(this.dbPath) || !statSync(this.dbPath).isFile()) {
        return { success: false, error: `File not found: ${this.dbPath}` };
      }
      this.database().prepare('SELECT 1').get();
      return { success: true };
    } catch (error) {
      return connectorTestFailure(error);
    }
  }

  async introspect(input: KtxScanInput, _ctx: KtxScanContext): Promise<KtxSchemaSnapshot> {
    this.assertConnection(input.connectionId);
    const database = this.database();
    const scopedNames = input.tableScope ? scopedTableNames(input.tableScope, { catalog: null, db: null }) : null;
    const scopeClause = scopedNames ? `AND name IN (${scopedNames.map(() => '?').join(', ')})` : '';
    const rawTables =
      scopedNames && scopedNames.length === 0
        ? []
        : (database
            .prepare(
              `SELECT name, type FROM sqlite_master WHERE type IN ('table', 'view') AND name NOT LIKE 'sqlite_%' ${scopeClause} ORDER BY name`,
            )
            .all(...(scopedNames ?? [])) as SqliteMasterRow[]);
    const tables = rawTables.map((table) => this.readTable(database, table));
    const fileStats = existsSync(this.dbPath) ? statSync(this.dbPath) : null;
    return {
      connectionId: this.connectionId,
      driver: 'sqlite',
      extractedAt: this.now().toISOString(),
      scope: {},
      metadata: {
        file_path: this.dbPath,
        file_size: fileStats ? fileStats.size : 0,
        table_count: tables.length,
        total_columns: tables.reduce((sum, table) => sum + table.columns.length, 0),
      },
      tables,
    };
  }

  async listSchemas(): Promise<string[]> {
    return [];
  }

  async listTables(_schemas?: string[]): Promise<KtxTableListEntry[]> {
    const rows = this.database()
      .prepare(
        `
      SELECT name, type
      FROM sqlite_master
      WHERE type IN ('table', 'view')
        AND name NOT LIKE 'sqlite_%'
      ORDER BY name
      `,
      )
      .all() as SqliteMasterRow[];

    return rows.map((row) => ({
      catalog: null,
      schema: '',
      name: row.name,
      kind: row.type === 'view' ? ('view' as const) : ('table' as const),
    }));
  }

  async sampleTable(input: KtxTableSampleInput, _ctx: KtxScanContext): Promise<KtxTableSampleResult> {
    this.assertConnection(input.connectionId);
    const result = this.query(this.dialect.generateSampleQuery(this.qTableName(input.table), input.limit, input.columns));
    return { headers: result.headers, rows: result.rows, totalRows: result.totalRows };
  }

  async sampleColumn(input: KtxColumnSampleInput, _ctx: KtxScanContext): Promise<KtxColumnSampleResult> {
    this.assertConnection(input.connectionId);
    const result = this.query(
      this.dialect.generateColumnSampleQuery(this.qTableName(input.table), input.column, input.limit),
    );
    const values = result.rows.filter((row) => row.length > 0 && row[0] !== null).map((row) => row[0]);
    return { values, nullCount: null, distinctCount: null };
  }

  async columnStats(_input: KtxColumnStatsInput, _ctx: KtxScanContext): Promise<KtxColumnStatsResult | null> {
    return null;
  }

  async executeReadOnly(input: KtxSqliteReadOnlyQueryInput, _ctx: KtxScanContext): Promise<KtxQueryResult> {
    this.assertConnection(input.connectionId);
    const result = this.query(limitSqlForExecution(input.sql, input.maxRows), input.params);
    return { ...result, rowCount: result.rows.length };
  }

  async getColumnDistinctValues(
    table: KtxTableRef,
    columnName: string,
    options: KtxSqliteColumnDistinctValuesOptions,
  ): Promise<KtxSqliteColumnDistinctValuesResult | null> {
    const sampleSize = options.sampleSize ?? 10000;
    const tableName = this.qTableName(table);
    const quotedColumn = this.dialect.quoteIdentifier(columnName);
    const cardinalityResult = this.query(
      this.dialect.generateCardinalitySampleQuery(tableName, quotedColumn, sampleSize),
    );
    if (cardinalityResult.rows.length === 0) {
      return null;
    }
    const cardinality = Number(cardinalityResult.rows[0][0]);
    if (Number.isNaN(cardinality)) {
      return null;
    }
    if (cardinality === 0) {
      return { values: [], cardinality: 0 };
    }
    if (cardinality > options.maxCardinality) {
      return { values: null, cardinality };
    }
    const valuesResult = this.query(this.dialect.generateDistinctValuesQuery(tableName, quotedColumn, options.limit));
    return {
      values: valuesResult.rows.filter((row) => row.length > 0 && row[0] !== null).map((row) => String(row[0])),
      cardinality,
    };
  }

  async getTableRowCount(tableName: string): Promise<number> {
    const result = this.query(`SELECT COUNT(*) AS count FROM ${this.dialect.quoteIdentifier(tableName)}`);
    return Number(result.rows[0]?.[0] ?? 0);
  }

  qTableName(table: Pick<KtxTableRef, 'name'>): string {
    return this.dialect.formatTableName(table);
  }

  quoteIdentifier(identifier: string): string {
    return this.dialect.quoteIdentifier(identifier);
  }

  async cleanup(): Promise<void> {
    if (this.db) {
      this.db.close();
      this.db = null;
    }
  }

  private database(): Database.Database {
    if (!this.db) {
      this.db = new Database(this.dbPath, { readonly: true, fileMustExist: true });
    }
    return this.db;
  }

  private query(sql: string, params?: Record<string, unknown> | unknown[]): Omit<KtxQueryResult, 'rowCount'> {
    const statement = this.database().prepare(assertReadOnlySql(sql));
    const rows = (params ? statement.all(params) : statement.all()) as unknown[];
    return {
      headers: statement.columns().map((column) => column.name),
      rows: normalizeQueryRows(rows),
      totalRows: rows.length,
    };
  }

  private readTable(database: Database.Database, table: SqliteMasterRow): KtxSchemaTable {
    const columns = database
      .prepare(`PRAGMA table_info(${this.dialect.quoteIdentifier(table.name)})`)
      .all() as SqliteTableInfoRow[];
    const foreignKeys = database
      .prepare(`PRAGMA foreign_key_list(${this.dialect.quoteIdentifier(table.name)})`)
      .all() as SqliteForeignKeyRow[];
    const estimatedRows =
      table.type === 'table'
        ? Number(
            (
              database
                .prepare(`SELECT COUNT(*) AS count FROM ${this.dialect.quoteIdentifier(table.name)}`)
                .get() as { count: unknown }
            ).count,
          )
        : null;
    return {
      catalog: null,
      db: null,
      name: table.name,
      kind: table.type,
      comment: null,
      estimatedRows,
      columns: columns.map((column) => ({
        name: column.name,
        nativeType: column.type,
        normalizedType: this.dialect.mapDataType(column.type),
        dimensionType: this.dialect.mapToDimensionType(column.type),
        nullable: column.notnull === 0 && column.pk === 0,
        primaryKey: column.pk > 0,
        comment: null,
      })),
      foreignKeys: this.mapForeignKeys(foreignKeys),
    };
  }

  private mapForeignKeys(rows: SqliteForeignKeyRow[]): KtxSchemaForeignKey[] {
    return rows
      .sort((a, b) => a.id - b.id || a.seq - b.seq)
      .map((row) => ({
        fromColumn: row.from,
        toCatalog: null,
        toDb: null,
        toTable: row.table,
        toColumn: row.to,
        constraintName: null,
      }));
  }

  private assertConnection(connectionId: string): void {
    if (connectionId !== this.connectionId) {
      throw new Error(`ktx SQLite connector ${this.id} cannot serve connection ${connectionId}`);
    }
  }
}
