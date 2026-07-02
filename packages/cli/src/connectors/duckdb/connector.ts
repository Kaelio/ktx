import { DuckDBInstance, type DuckDBConnection } from '@duckdb/node-api';
import { existsSync, statSync } from 'node:fs';
import { isAbsolute, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { resolveStringReference } from '../shared/string-reference.js';
import { getSqlDialectForDriver } from '../../context/connections/dialects.js';
import { assertReadOnlySql, limitSqlForExecution } from '../../context/connections/read-only-sql.js';
import { normalizeQueryRows } from '../../context/connections/query-executor.js';
import { toJsonSafeRows } from '../shared/duckdb-json-safe.js';
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
  type KtxSchemaForeignKey,
  type KtxSchemaSnapshot,
  type KtxSchemaTable,
  type KtxTableListEntry,
  type KtxTableRef,
  type KtxTableSampleInput,
  type KtxTableSampleResult,
} from '../../context/scan/types.js';
import { scopedTableNames } from '../../context/scan/table-ref.js';

const MAIN_SCHEMA = 'main';

export interface KtxDuckDbConnectionConfig {
  driver?: string;
  path?: string;
  url?: string;
  [key: string]: unknown;
}

/** @internal */
export interface DuckDbDatabasePathInput {
  connectionId: string;
  projectDir?: string;
  connection: KtxDuckDbConnectionConfig | undefined;
}

export interface KtxDuckDbScanConnectorOptions extends DuckDbDatabasePathInput {
  now?: () => Date;
}

export interface KtxDuckDbColumnDistinctValuesOptions {
  maxCardinality: number;
  limit: number;
  sampleSize?: number;
}

export interface KtxDuckDbColumnDistinctValuesResult {
  values: string[] | null;
  cardinality: number;
}

interface InfoSchemaTableRow {
  table_name: string;
  table_type: string;
}

interface InfoSchemaColumnRow {
  column_name: string;
  data_type: string;
  is_nullable: string;
}

// `path` may be an env:/file: reference; `url` resolves env: only, since file:
// on a url is a native URI form (handled by duckDbPathFromUrl), not a file read.
function stringConfigValue(
  connection: KtxDuckDbConnectionConfig | undefined,
  key: 'path' | 'url',
): string | undefined {
  const value = connection?.[key];
  if (typeof value !== 'string' || value.trim().length === 0) {
    return undefined;
  }
  const trimmed = value.trim();
  if (key === 'url') {
    return trimmed.startsWith('env:') ? (process.env[trimmed.slice('env:'.length)] ?? '') : trimmed;
  }
  return resolveStringReference(trimmed, process.env);
}

function duckDbPathFromUrl(url: string): string {
  if (url.startsWith('file:')) {
    return fileURLToPath(url);
  }
  if (url.startsWith('duckdb:')) {
    const parsed = new URL(url);
    return decodeURIComponent(parsed.pathname);
  }
  return url;
}

export function isKtxDuckDbConnectionConfig(
  connection: KtxDuckDbConnectionConfig | undefined,
): connection is KtxDuckDbConnectionConfig {
  return String(connection?.driver ?? '').toLowerCase() === 'duckdb';
}

/** @internal */
export function duckDbDatabasePathFromConfig(input: DuckDbDatabasePathInput): string {
  const inputDriver = input.connection?.driver ?? 'unknown';
  if (!isKtxDuckDbConnectionConfig(input.connection)) {
    throw new Error(`Native DuckDB connector cannot run driver "${inputDriver}"`);
  }
  const configuredPath =
    stringConfigValue(input.connection, 'path') ?? duckDbPathFromUrl(stringConfigValue(input.connection, 'url') ?? '');
  if (!configuredPath) {
    throw new Error(`Native DuckDB connector requires connections.${input.connectionId}.path or url`);
  }
  return isAbsolute(configuredPath) ? configuredPath : resolve(input.projectDir ?? process.cwd(), configuredPath);
}

export class KtxDuckDbScanConnector implements KtxScanConnector {
  readonly id: string;
  readonly driver = 'duckdb' as const;
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
  private readonly dialect = getSqlDialectForDriver('duckdb');
  private instance: DuckDBInstance | null = null;
  private connection: DuckDBConnection | null = null;

  constructor(options: KtxDuckDbScanConnectorOptions) {
    this.connectionId = options.connectionId;
    this.dbPath = duckDbDatabasePathFromConfig(options);
    this.now = options.now ?? (() => new Date());
    this.id = `duckdb:${options.connectionId}`;
  }

  async testConnection(): Promise<KtxConnectorTestResult> {
    try {
      if (!existsSync(this.dbPath) || !statSync(this.dbPath).isFile()) {
        return { success: false, error: `File not found: ${this.dbPath}` };
      }
      await this.query('SELECT 1');
      return { success: true };
    } catch (error) {
      return connectorTestFailure(error);
    }
  }

  async introspect(input: KtxScanInput, _ctx: KtxScanContext): Promise<KtxSchemaSnapshot> {
    this.assertConnection(input.connectionId);
    const scopedNames = input.tableScope ? scopedTableNames(input.tableScope, { catalog: null, db: null }) : null;
    const tableRows = await this.readTableRows(scopedNames);
    const tables: KtxSchemaTable[] = [];
    for (const row of tableRows) {
      tables.push(await this.readTable(row));
    }
    return {
      connectionId: this.connectionId,
      driver: 'duckdb' as const,
      extractedAt: this.now().toISOString(),
      scope: {},
      metadata: {
        file_path: this.dbPath,
        table_count: tables.length,
        total_columns: tables.reduce((sum, table) => sum + table.columns.length, 0),
      },
      tables,
    };
  }

  async listSchemas(): Promise<string[]> {
    return [MAIN_SCHEMA];
  }

  async listTables(_schemas?: string[]): Promise<KtxTableListEntry[]> {
    const rows = await this.readTableRows(null);
    return rows.map((row) => ({
      catalog: null,
      schema: MAIN_SCHEMA,
      name: row.table_name,
      kind: row.table_type === 'VIEW' ? ('view' as const) : ('table' as const),
    }));
  }

  async sampleTable(input: KtxTableSampleInput, _ctx: KtxScanContext): Promise<KtxTableSampleResult> {
    this.assertConnection(input.connectionId);
    const result = await this.query(
      this.dialect.generateSampleQuery(this.qTableName(input.table), input.limit, input.columns),
    );
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

  async columnStats(_input: KtxColumnStatsInput, _ctx: KtxScanContext): Promise<KtxColumnStatsResult | null> {
    return null;
  }

  async executeReadOnly(input: KtxReadOnlyQueryInput, _ctx: KtxScanContext): Promise<KtxQueryResult> {
    this.assertConnection(input.connectionId);
    const result = await this.query(limitSqlForExecution(input.sql, input.maxRows));
    return { ...result, rowCount: result.rows.length };
  }

  async getColumnDistinctValues(
    table: KtxTableRef,
    columnName: string,
    options: KtxDuckDbColumnDistinctValuesOptions,
  ): Promise<KtxDuckDbColumnDistinctValuesResult | null> {
    const sampleSize = options.sampleSize ?? 10000;
    const tableName = this.qTableName(table);
    const quotedColumn = this.dialect.quoteIdentifier(columnName);
    const cardinalityResult = await this.query(
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
    const valuesResult = await this.query(
      this.dialect.generateDistinctValuesQuery(tableName, quotedColumn, options.limit),
    );
    return {
      values: valuesResult.rows.filter((row) => row.length > 0 && row[0] !== null).map((row) => String(row[0])),
      cardinality,
    };
  }

  async getTableRowCount(tableName: string): Promise<number> {
    const result = await this.query(`SELECT COUNT(*) AS count FROM ${this.dialect.quoteIdentifier(tableName)}`);
    return Number(result.rows[0]?.[0] ?? 0);
  }

  qTableName(table: Pick<KtxTableRef, 'name'>): string {
    return this.dialect.formatTableName(table);
  }

  quoteIdentifier(identifier: string): string {
    return this.dialect.quoteIdentifier(identifier);
  }

  async cleanup(): Promise<void> {
    this.connection?.closeSync();
    this.instance?.closeSync();
    this.connection = null;
    this.instance = null;
  }

  private async db(): Promise<DuckDBConnection> {
    if (!this.connection) {
      // DuckDBInstance.create() creates the file if missing, so this pre-check
      // enforces the never-create rule. Do not remove it.
      if (!existsSync(this.dbPath) || !statSync(this.dbPath).isFile()) {
        throw new Error(`File not found: ${this.dbPath}`);
      }
      this.instance = await DuckDBInstance.create(this.dbPath, { access_mode: 'read_only' });
      this.connection = await this.instance.connect();
    }
    return this.connection;
  }

  private async query(sql: string): Promise<Omit<KtxQueryResult, 'rowCount'>> {
    const connection = await this.db();
    const reader = await connection.runAndReadAll(assertReadOnlySql(sql));
    const rows = toJsonSafeRows(normalizeQueryRows(reader.getRows()));
    return {
      headers: reader.columnNames(),
      rows,
      totalRows: rows.length,
    };
  }

  private async readTableRows(scopedNames: string[] | null): Promise<InfoSchemaTableRow[]> {
    if (scopedNames && scopedNames.length === 0) {
      return [];
    }
    const scopeClause = scopedNames
      ? `AND table_name IN (${scopedNames.map((name) => `'${name.replaceAll("'", "''")}'`).join(', ')})`
      : '';
    const result = await this.query(
      `SELECT table_name, table_type
       FROM information_schema.tables
       WHERE table_schema = '${MAIN_SCHEMA}' ${scopeClause}
       ORDER BY table_name`,
    );
    return result.rows.map((row) => ({ table_name: String(row[0]), table_type: String(row[1]) }));
  }

  private async readTable(table: InfoSchemaTableRow): Promise<KtxSchemaTable> {
    const columnsResult = await this.query(
      `SELECT column_name, data_type, is_nullable
       FROM information_schema.columns
       WHERE table_schema = '${MAIN_SCHEMA}' AND table_name = '${table.table_name.replaceAll("'", "''")}'
       ORDER BY ordinal_position`,
    );
    const columns = columnsResult.rows.map<InfoSchemaColumnRow>((row) => ({
      column_name: String(row[0]),
      data_type: String(row[1]),
      is_nullable: String(row[2]),
    }));
    const primaryKeys = await this.readPrimaryKeyColumns(table.table_name);
    const isView = table.table_type === 'VIEW';
    const estimatedRows = isView ? null : await this.getTableRowCount(table.table_name);
    return {
      catalog: null,
      db: null,
      name: table.table_name,
      kind: isView ? 'view' : 'table',
      comment: null,
      estimatedRows,
      columns: columns.map((column) => ({
        name: column.column_name,
        nativeType: column.data_type,
        normalizedType: this.dialect.mapDataType(column.data_type),
        dimensionType: this.dialect.mapToDimensionType(column.data_type),
        nullable: column.is_nullable === 'YES' && !primaryKeys.has(column.column_name),
        primaryKey: primaryKeys.has(column.column_name),
        comment: null,
      })),
      foreignKeys: await this.readForeignKeys(table.table_name),
    };
  }

  private async readPrimaryKeyColumns(tableName: string): Promise<Set<string>> {
    const result = await this.query(
      `SELECT kcu.column_name
       FROM information_schema.table_constraints tc
       JOIN information_schema.key_column_usage kcu
         ON tc.constraint_name = kcu.constraint_name AND tc.table_schema = kcu.table_schema
       WHERE tc.table_schema = '${MAIN_SCHEMA}'
         AND tc.table_name = '${tableName.replaceAll("'", "''")}'
         AND tc.constraint_type = 'PRIMARY KEY'`,
    );
    return new Set(result.rows.map((row) => String(row[0])));
  }

  private async readForeignKeys(tableName: string): Promise<KtxSchemaForeignKey[]> {
    // information_schema.constraint_column_usage in DuckDB returns the constrained
    // columns (source), not the referenced columns. Use duckdb_constraints() which
    // exposes constraint_column_names and referenced_column_names directly.
    const result = await this.query(
      `SELECT unnest(constraint_column_names) AS from_column,
              referenced_table,
              unnest(referenced_column_names) AS to_column,
              constraint_name
       FROM duckdb_constraints()
       WHERE schema_name = '${MAIN_SCHEMA}'
         AND table_name = '${tableName.replaceAll("'", "''")}'
         AND constraint_type = 'FOREIGN KEY'`,
    );
    return result.rows.map((row) => ({
      fromColumn: String(row[0]),
      toCatalog: null,
      toDb: null,
      toTable: String(row[1]),
      toColumn: String(row[2]),
      constraintName: row[3] === null ? null : String(row[3]),
    }));
  }

  private assertConnection(connectionId: string): void {
    if (connectionId !== this.connectionId) {
      throw new Error(`ktx DuckDB connector ${this.id} cannot serve connection ${connectionId}`);
    }
  }
}
