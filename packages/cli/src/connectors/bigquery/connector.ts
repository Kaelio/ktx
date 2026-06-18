import { BigQuery, type TableField } from '@google-cloud/bigquery';
import { normalizeBigQueryProjectId, normalizeBigQueryRegion } from '../../context/connections/bigquery-identifiers.js';
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
  type KtxSchemaSnapshot,
  type KtxSchemaTable,
  type KtxTableListEntry,
  type KtxTableRef,
  type KtxTableSampleInput,
  type KtxTableSampleResult,
} from '../../context/scan/types.js';
import { resolveStringReference } from '../shared/string-reference.js';

export interface KtxBigQueryConnectionConfig {
  driver?: string;
  dataset_id?: string;
  dataset_ids?: string[];
  credentials_json?: string;
  location?: string;
  max_bytes_billed?: number | string;
  job_timeout_ms?: number;
  [key: string]: unknown;
}

export interface KtxBigQueryResolvedConnectionConfig {
  projectId: string;
  credentials: Record<string, unknown>;
  datasetIds: string[];
  location?: string;
}

export interface KtxBigQueryReadOnlyQueryInput extends KtxReadOnlyQueryInput {
  params?: Record<string, unknown>;
}

export interface KtxBigQueryColumnDistinctValuesOptions {
  maxCardinality: number;
  limit: number;
  sampleSize?: number;
}

export interface KtxBigQueryColumnDistinctValuesResult {
  values: string[] | null;
  cardinality: number;
}

/** @internal */
export interface KtxBigQueryQueryJob {
  getQueryResults(): Promise<
    [Array<Record<string, unknown>>, unknown, { schema?: { fields?: TableField[] } }?, ...unknown[]]
  >;
}

/** @internal */
export interface KtxBigQueryTableRef {
  id?: string;
  metadata?: { type?: string };
  get(): Promise<
    [
      {
        metadata: {
          type?: string;
          numRows?: string | number;
          description?: string;
          schema?: { fields?: TableField[] };
        };
      },
      ...unknown[],
    ]
  >;
}

/** @internal */
export interface KtxBigQueryDataset {
  get(): Promise<unknown>;
  getTables(): Promise<[KtxBigQueryTableRef[], ...unknown[]]>;
}

export interface KtxBigQueryClient {
  getDatasets(input?: { maxResults?: number }): Promise<[Array<{ id?: string }>, ...unknown[]]>;
  dataset(datasetId: string): KtxBigQueryDataset;
  createQueryJob(input: {
    query: string;
    location?: string;
    params?: Record<string, unknown>;
    maximumBytesBilled?: string;
    jobTimeoutMs?: number;
  }): Promise<[KtxBigQueryQueryJob, ...unknown[]]>;
}

export interface KtxBigQueryClientFactory {
  createClient(input: { projectId: string; credentials: Record<string, unknown> }): KtxBigQueryClient;
}

export interface KtxBigQueryScanConnectorOptions {
  connectionId: string;
  connection: KtxBigQueryConnectionConfig | undefined;
  clientFactory?: KtxBigQueryClientFactory;
  env?: NodeJS.ProcessEnv;
  now?: () => Date;
  maxBytesBilled?: number | string;
  queryTimeoutMs?: number;
}

class DefaultBigQueryClientFactory implements KtxBigQueryClientFactory {
  createClient(input: { projectId: string; credentials: Record<string, unknown> }): KtxBigQueryClient {
    const client = new BigQuery(input);
    return {
      getDatasets: (options) => client.getDatasets(options) as Promise<[Array<{ id?: string }>, ...unknown[]]>,
      dataset: (datasetId) => {
        const dataset = client.dataset(datasetId);
        return {
          get: () => dataset.get() as Promise<unknown>,
          getTables: () => dataset.getTables() as Promise<[KtxBigQueryTableRef[], ...unknown[]]>,
        };
      },
      createQueryJob: (options) => client.createQueryJob(options) as Promise<[KtxBigQueryQueryJob, ...unknown[]]>,
    };
  }
}

function stringConfigValue(
  connection: KtxBigQueryConnectionConfig | undefined,
  key: keyof KtxBigQueryConnectionConfig,
  env: NodeJS.ProcessEnv,
): string | undefined {
  const value = connection?.[key];
  return typeof value === 'string' && value.trim().length > 0 ? resolveStringReference(value.trim(), env) : undefined;
}

function datasetIds(connection: KtxBigQueryConnectionConfig, env: NodeJS.ProcessEnv): string[] {
  if (Array.isArray(connection.dataset_ids) && connection.dataset_ids.length > 0) {
    return connection.dataset_ids
      .filter((dataset) => dataset.trim().length > 0)
      .map((dataset) => resolveStringReference(dataset, env));
  }
  const datasetId = stringConfigValue(connection, 'dataset_id', env);
  return datasetId ? [datasetId] : [];
}

function bigQueryMaxBytesBilledFromConnection(
  connection: KtxBigQueryConnectionConfig | undefined,
): number | string | undefined {
  const value = connection?.max_bytes_billed;
  if (typeof value === 'number') {
    return Number.isFinite(value) && value > 0 ? value : undefined;
  }
  if (typeof value === 'string') {
    const trimmed = value.trim();
    return trimmed.length > 0 ? trimmed : undefined;
  }
  return undefined;
}

function bigQueryJobTimeoutMsFromConnection(connection: KtxBigQueryConnectionConfig | undefined): number | undefined {
  const value = connection?.job_timeout_ms;
  if (typeof value !== 'number') {
    return undefined;
  }
  return Number.isInteger(value) && value > 0 ? value : undefined;
}

function tableKind(metadataType: string | undefined): KtxSchemaTable['kind'] {
  const type = String(metadataType ?? '').toUpperCase();
  if (type === 'VIEW' || type === 'MATERIALIZED_VIEW') {
    return 'view';
  }
  if (type === 'EXTERNAL' || type === 'EXTERNAL_TABLE') {
    return 'external';
  }
  return 'table';
}

function firstNumber(value: unknown): number | null {
  const numberValue = Number(value);
  return Number.isFinite(numberValue) ? numberValue : null;
}

function isDeniedError(error: unknown): boolean {
  if (!error || typeof error !== 'object') {
    return false;
  }
  const candidate = error as { code?: unknown; errors?: Array<{ reason?: unknown }> };
  return (
    candidate.code === 403 ||
    candidate.errors?.some((item) => item.reason === 'accessDenied' || item.reason === 'notFound') === true
  );
}

function normalizeValue(value: unknown): unknown {
  if (value === null || value === undefined) {
    return null;
  }
  if (Array.isArray(value)) {
    return value.map((item) => String(item)).join(', ');
  }
  if (typeof value === 'object') {
    if ('toNumber' in value && typeof value.toNumber === 'function' && 'toFixed' in value && typeof value.toFixed === 'function') {
      return value.toNumber();
    }
    if ('value' in value && Object.keys(value).length === 1 && typeof value.value !== 'object') {
      return value.value;
    }
    return JSON.stringify(value);
  }
  return value;
}

/** @internal */
export function prepareBigQueryReadOnlyQuery(
  sql: string,
  params?: Record<string, unknown>,
): { sql: string; params?: Record<string, unknown> } {
  if (!params) {
    return { sql, params: undefined };
  }
  let processedSql = sql;
  const processedParams: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(params)) {
    processedSql = processedSql.replace(new RegExp(`:${key}\\b`, 'g'), `@${key}`);
    processedParams[key] = value;
  }
  return { sql: processedSql, params: Object.keys(processedParams).length > 0 ? processedParams : undefined };
}

export function isKtxBigQueryConnectionConfig(
  connection: KtxBigQueryConnectionConfig | undefined,
): connection is KtxBigQueryConnectionConfig {
  return String(connection?.driver ?? '').toLowerCase() === 'bigquery';
}

/** @internal */
export function bigQueryConnectionConfigFromConfig(input: {
  connectionId: string;
  connection: KtxBigQueryConnectionConfig | undefined;
  env?: NodeJS.ProcessEnv;
}): KtxBigQueryResolvedConnectionConfig {
  const inputDriver = input.connection?.driver ?? 'unknown';
  if (!isKtxBigQueryConnectionConfig(input.connection)) {
    throw new Error(`Native BigQuery connector cannot run driver "${inputDriver}"`);
  }

  const env = input.env ?? process.env;
  const credentialsJson = stringConfigValue(input.connection, 'credentials_json', env);
  if (!credentialsJson) {
    throw new Error(`Native BigQuery connector requires connections.${input.connectionId}.credentials_json`);
  }
  const credentials = JSON.parse(credentialsJson) as Record<string, unknown>;
  const projectId = typeof credentials.project_id === 'string' ? credentials.project_id : undefined;
  if (!projectId) {
    throw new Error(`Native BigQuery connector requires credentials_json.project_id for connections.${input.connectionId}`);
  }
  const resolvedDatasetIds = datasetIds(input.connection, env);
  const location = stringConfigValue(input.connection, 'location', env);
  return { projectId, credentials, datasetIds: resolvedDatasetIds, ...(location ? { location } : {}) };
}

export class KtxBigQueryScanConnector implements KtxScanConnector {
  readonly id: string;
  readonly driver = 'bigquery' as const;
  readonly capabilities = createKtxConnectorCapabilities({
    tableSampling: true,
    columnSampling: true,
    columnStats: false,
    readOnlySql: true,
    nestedAnalysis: true,
    formalForeignKeys: false,
    estimatedRowCounts: true,
  });

  private readonly connectionId: string;
  private readonly resolved: KtxBigQueryResolvedConnectionConfig;
  private readonly clientFactory: KtxBigQueryClientFactory;
  private readonly now: () => Date;
  private readonly maxBytesBilled?: number | string;
  private readonly queryTimeoutMs?: number;
  private readonly dialect = getDialectForDriver('bigquery');
  private client: KtxBigQueryClient | null = null;

  constructor(options: KtxBigQueryScanConnectorOptions) {
    this.connectionId = options.connectionId;
    this.resolved = bigQueryConnectionConfigFromConfig({
      connectionId: options.connectionId,
      connection: options.connection,
      env: options.env,
    });
    this.clientFactory = options.clientFactory ?? new DefaultBigQueryClientFactory();
    this.now = options.now ?? (() => new Date());
    this.maxBytesBilled = options.maxBytesBilled ?? bigQueryMaxBytesBilledFromConnection(options.connection);
    this.queryTimeoutMs = options.queryTimeoutMs ?? bigQueryJobTimeoutMsFromConnection(options.connection);
    this.id = `bigquery:${options.connectionId}`;
  }

  async testConnection(): Promise<KtxConnectorTestResult> {
    try {
      const client = this.getClient();
      await client.getDatasets({ maxResults: 1 });
      for (const datasetId of this.resolved.datasetIds) {
        await client.dataset(datasetId).get();
      }
      return { success: true };
    } catch (error) {
      return connectorTestFailure(error);
    }
  }

  async introspect(input: KtxScanInput, _ctx: KtxScanContext): Promise<KtxSchemaSnapshot> {
    this.assertConnection(input.connectionId);
    const tables: KtxSchemaTable[] = [];
    const datasetIds = this.requireDatasetIdsForScan();
    const snapshotWarnings: KtxScanWarning[] = [];
    for (const datasetId of datasetIds) {
      const scopedNames = input.tableScope
        ? scopedTableNames(input.tableScope, { catalog: this.resolved.projectId, db: datasetId })
        : null;
      tables.push(...(await this.introspectDataset(datasetId, scopedNames, snapshotWarnings)));
    }
    return {
      connectionId: this.connectionId,
      driver: 'bigquery',
      extractedAt: this.now().toISOString(),
      scope: { catalogs: [this.resolved.projectId], datasets: datasetIds },
      metadata: {
        project_id: this.resolved.projectId,
        datasets: datasetIds,
        table_count: tables.length,
        total_columns: tables.reduce((sum, table) => sum + table.columns.length, 0),
      },
      tables,
      warnings: snapshotWarnings,
    };
  }

  async sampleTable(input: KtxTableSampleInput, _ctx: KtxScanContext): Promise<KtxTableSampleResult & { headerTypes?: string[] }> {
    this.assertConnection(input.connectionId);
    const result = await this.query(this.dialect.generateSampleQuery(this.qTableName(input.table), input.limit, input.columns));
    return { headers: result.headers, headerTypes: result.headerTypes, rows: result.rows, totalRows: result.totalRows };
  }

  async sampleColumn(input: KtxColumnSampleInput, _ctx: KtxScanContext): Promise<KtxColumnSampleResult> {
    this.assertConnection(input.connectionId);
    const result = await this.query(
      this.dialect.generateColumnSampleQuery(this.qTableName(input.table), input.column, input.limit),
    );
    return { values: result.rows.filter((row) => row.length > 0 && row[0] !== null).map((row) => row[0]), nullCount: null, distinctCount: null };
  }

  async columnStats(_input: KtxColumnStatsInput, _ctx: KtxScanContext): Promise<KtxColumnStatsResult | null> {
    return null;
  }

  async executeReadOnly(input: KtxBigQueryReadOnlyQueryInput, _ctx: KtxScanContext): Promise<KtxQueryResult> {
    this.assertConnection(input.connectionId);
    const limitedSql = limitSqlForExecution(assertReadOnlySql(input.sql), input.maxRows);
    const prepared = prepareBigQueryReadOnlyQuery(limitedSql, input.params);
    const result = await this.query(prepared.sql, prepared.params);
    return { ...result, rowCount: result.rows.length };
  }

  async getColumnDistinctValues(
    table: KtxTableRef,
    columnName: string,
    options: KtxBigQueryColumnDistinctValuesOptions,
  ): Promise<KtxBigQueryColumnDistinctValuesResult | null> {
    const tableName = this.qTableName(table);
    const quotedColumn = this.dialect.quoteIdentifier(columnName);
    const cardinality = await this.singleNumber(
      this.dialect.generateCardinalitySampleQuery(tableName, quotedColumn, options.sampleSize ?? 10000),
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
    const valueRows = await this.queryRaw<{ val: unknown }>(
      this.dialect.generateDistinctValuesQuery(tableName, quotedColumn, options.limit),
    );
    return { values: valueRows.filter((row) => row.val !== null).map((row) => String(row.val)), cardinality };
  }

  async getTableRowCount(tableName: string, datasetId = this.resolved.datasetIds[0]): Promise<number> {
    if (!datasetId) {
      return 0;
    }
    const tables = await this.introspectDataset(datasetId, null, []);
    return tables.find((table) => table.name === tableName)?.estimatedRows ?? 0;
  }

  qTableName(table: Pick<KtxTableRef, 'name'> & Partial<Pick<KtxTableRef, 'catalog' | 'db'>>): string {
    return this.dialect.formatTableName(table);
  }

  quoteIdentifier(identifier: string): string {
    return this.dialect.quoteIdentifier(identifier);
  }

  async listSchemas(): Promise<string[]> {
    const [datasets] = await this.getClient().getDatasets();
    return datasets.map((dataset) => dataset.id).filter((id): id is string => Boolean(id));
  }

  async listTables(datasetIds?: string[]): Promise<KtxTableListEntry[]> {
    const projectId = normalizeBigQueryProjectId(this.resolved.projectId, 'table discovery');
    const region = normalizeBigQueryRegion(this.resolved.location ?? 'US', 'table discovery');
    const params: Record<string, unknown> = {};
    const filter = datasetIds && datasetIds.length > 0 ? 'AND table_schema IN UNNEST(@dataset_ids)' : '';
    if (datasetIds && datasetIds.length > 0) {
      params.dataset_ids = datasetIds;
    }
    const rows = await this.queryRaw<{ table_schema: string; table_name: string; table_type: string }>(
      `
    SELECT table_schema, table_name, table_type
    FROM \`${projectId}\`.\`region-${region}\`.INFORMATION_SCHEMA.TABLES
    WHERE table_type IN (
      'BASE TABLE', 'VIEW', 'MATERIALIZED VIEW', 'EXTERNAL', 'CLONE', 'SNAPSHOT'
    )
      ${filter}
    ORDER BY table_schema, table_name
    `,
      params,
    );
    return rows.map((row) => ({
      catalog: this.resolved.projectId,
      schema: row.table_schema,
      name: row.table_name,
      kind:
        row.table_type === 'VIEW' || row.table_type === 'MATERIALIZED VIEW'
          ? ('view' as const)
          : ('table' as const),
    }));
  }

  async cleanup(): Promise<void> {
    this.client = null;
  }

  private getClient(): KtxBigQueryClient {
    if (!this.client) {
      this.client = this.clientFactory.createClient({
        projectId: this.resolved.projectId,
        credentials: this.resolved.credentials,
      });
    }
    return this.client;
  }

  private requireDatasetIdsForScan(): string[] {
    if (this.resolved.datasetIds.length === 0) {
      throw new Error(`Native BigQuery scan requires connections.${this.connectionId}.dataset_ids or dataset_id`);
    }
    return this.resolved.datasetIds;
  }

  private async query(sql: string, params?: Record<string, unknown>): Promise<KtxQueryResult> {
    const [job] = await this.getClient().createQueryJob({
      query: sql,
      ...(this.resolved.location ? { location: this.resolved.location } : {}),
      ...(params && Object.keys(params).length > 0 ? { params } : {}),
      ...(this.maxBytesBilled ? { maximumBytesBilled: String(this.maxBytesBilled) } : {}),
      ...(this.queryTimeoutMs ? { jobTimeoutMs: this.queryTimeoutMs } : {}),
    });
    const [rows, , response] = await job.getQueryResults();
    let headers = response?.schema?.fields?.map((field) => field.name || '') ?? [];
    const headerTypes = response?.schema?.fields?.map((field) => String(field.type || 'STRING')) ?? [];
    if (headers.length === 0 && rows.length > 0) {
      headers = Object.keys(rows[0]!);
    }
    return {
      headers,
      headerTypes: headerTypes.length > 0 ? headerTypes : undefined,
      rows: rows.map((row) => headers.map((header) => normalizeValue(row[header]))),
      totalRows: rows.length,
      rowCount: rows.length,
    };
  }

  private async queryRaw<T extends Record<string, unknown>>(sql: string, params?: Record<string, unknown>): Promise<T[]> {
    const result = await this.query(sql, params);
    return result.rows.map((row) => Object.fromEntries(result.headers.map((header, index) => [header, row[index]])) as T);
  }

  private async singleNumber(sql: string, header: string): Promise<number | null> {
    const rows = await this.queryRaw<Record<string, unknown>>(sql);
    return firstNumber(rows[0]?.[header]);
  }

  private async introspectDataset(
    datasetId: string,
    scopedNames: readonly string[] | null,
    snapshotWarnings: KtxScanWarning[],
  ): Promise<KtxSchemaTable[]> {
    if (scopedNames && scopedNames.length === 0) return [];
    const dataset = this.getClient().dataset(datasetId);
    const [tableRefs] = await dataset.getTables();
    const scopeSet = scopedNames ? new Set(scopedNames) : null;
    const filteredTableRefs = scopeSet ? tableRefs.filter((tableRef) => scopeSet.has(tableRef.id ?? '')) : tableRefs;
    const primaryKeysResult = await tryConstraintQuery(
      { schema: datasetId, kind: 'primary_key', isDeniedError },
      () => this.primaryKeys(datasetId),
    );
    const primaryKeys = primaryKeysResult.ok ? primaryKeysResult.value : new Map<string, Set<string>>();
    if (!primaryKeysResult.ok) {
      snapshotWarnings.push(primaryKeysResult.warning);
    }
    const tables: KtxSchemaTable[] = [];
    for (const tableRef of filteredTableRefs) {
      const tableName = tableRef.id || '';
      const [table] = await tableRef.get();
      const fields = table.metadata.schema?.fields ?? [];
      tables.push({
        catalog: this.resolved.projectId,
        db: datasetId,
        name: tableName,
        kind: tableKind(table.metadata.type),
        comment: table.metadata.description || null,
        estimatedRows: firstNumber(table.metadata.numRows) ?? 0,
        columns: fields.map((field) => this.toSchemaColumn(tableName, field, primaryKeys)),
        foreignKeys: [],
      });
    }
    return tables;
  }

  private async primaryKeys(datasetId: string): Promise<Map<string, Set<string>>> {
    const rows = await this.queryRaw<{ table_name: string; column_name: string }>(
      'SELECT tc.table_name, kcu.column_name ' +
        'FROM `' +
        this.resolved.projectId +
        '.' +
        datasetId +
        '.INFORMATION_SCHEMA.TABLE_CONSTRAINTS` tc ' +
        'JOIN `' +
        this.resolved.projectId +
        '.' +
        datasetId +
        '.INFORMATION_SCHEMA.KEY_COLUMN_USAGE` kcu ' +
        'ON tc.constraint_name = kcu.constraint_name ' +
        'AND tc.table_schema = kcu.table_schema ' +
        'AND tc.table_name = kcu.table_name ' +
        "WHERE tc.constraint_type = 'PRIMARY KEY' " +
        "AND tc.table_schema = '" +
        datasetId +
        "' " +
        "AND NOT REGEXP_CONTAINS(kcu.column_name, r'^(stacksync_record_id|sync_primary_key)_') " +
        'ORDER BY tc.table_name, kcu.ordinal_position',
    );
    const grouped = new Map<string, Set<string>>();
    for (const row of rows) {
      const columns = grouped.get(row.table_name) ?? new Set<string>();
      columns.add(row.column_name);
      grouped.set(row.table_name, columns);
    }
    return grouped;
  }

  private toSchemaColumn(tableName: string, field: TableField, primaryKeys: Map<string, Set<string>>): KtxSchemaColumn {
    const nativeType = String(field.type || 'STRING').toUpperCase();
    return {
      name: field.name || '',
      nativeType,
      normalizedType: this.dialect.mapDataType(nativeType),
      dimensionType: this.dialect.mapToDimensionType(nativeType),
      nullable: field.mode !== 'REQUIRED',
      primaryKey: primaryKeys.get(tableName)?.has(field.name || '') ?? false,
      comment: field.description || null,
    };
  }

  private assertConnection(connectionId: string): void {
    if (connectionId !== this.connectionId) {
      throw new Error(`BigQuery connector ${this.connectionId} cannot scan connection ${connectionId}`);
    }
  }
}
