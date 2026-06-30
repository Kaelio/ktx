import { BigQuery, type TableField } from '@google-cloud/bigquery';
import {
  normalizeBigQueryDatasetId,
  normalizeBigQueryProjectId,
  normalizeBigQueryRegion,
} from '../../context/connections/bigquery-identifiers.js';
import { getSqlDialectForDriver } from '../../context/connections/dialects.js';
import { resolveQueryDeadlineMs, queryDeadlineExceededError } from '../../context/connections/query-deadline.js';
import { assertReadOnlySql, limitSqlForExecution } from '../../context/connections/read-only-sql.js';
import { tryConstraintQuery } from '../../context/scan/constraint-discovery.js';
import { tryIntrospectObject } from '../../context/scan/object-introspection.js';
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
  query_timeout_ms?: number;
  [key: string]: unknown;
}

/**
 * A dataset to introspect, paired with the project that hosts it. `project`
 * defaults to the billing project (`credentials.project_id`) when an entry has
 * no `project.` prefix; a fully-qualified `project.dataset` entry resolves to
 * its own host project. Jobs always bill in `credentials.project_id`.
 */
export interface BigQueryDatasetRef {
  project: string;
  dataset: string;
}

export interface KtxBigQueryResolvedConnectionConfig {
  projectId: string;
  credentials: Record<string, unknown>;
  datasetIds: BigQueryDatasetRef[];
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
  dataset(datasetId: string, projectId: string): KtxBigQueryDataset;
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
}

class DefaultBigQueryClientFactory implements KtxBigQueryClientFactory {
  createClient(input: { projectId: string; credentials: Record<string, unknown> }): KtxBigQueryClient {
    const client = new BigQuery(input);
    return {
      getDatasets: (options) => client.getDatasets(options) as Promise<[Array<{ id?: string }>, ...unknown[]]>,
      dataset: (datasetId, projectId) => {
        const dataset = client.dataset(datasetId, { projectId });
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

/**
 * Parse one `dataset_ids` / `dataset_id` entry into a canonical
 * {@link BigQueryDatasetRef}. A `project.dataset` prefix selects the host
 * project; a bare entry defaults to `defaultProject` (the billing project).
 * More than one dot, or an empty segment, is a config error naming the
 * connection — never a silent mis-introspection at scan time.
 */
function parseBigQueryDatasetEntry(entry: string, defaultProject: string, connectionId: string): BigQueryDatasetRef {
  const context = `connections.${connectionId}.dataset_ids entry "${entry}"`;
  const parts = entry.split('.');
  if (parts.length === 1) {
    return { project: defaultProject, dataset: normalizeBigQueryDatasetId(parts[0]!, context) };
  }
  if (parts.length === 2) {
    const [project, dataset] = parts;
    if (!project || !dataset) {
      throw new Error(`Invalid BigQuery dataset entry for ${context}: empty project or dataset segment`);
    }
    return {
      project: normalizeBigQueryProjectId(project, context),
      dataset: normalizeBigQueryDatasetId(dataset, context),
    };
  }
  throw new Error(
    `Invalid BigQuery dataset entry for ${context}: expected "dataset" or "project.dataset", got more than one "."`,
  );
}

function resolveDatasetRefs(
  connection: KtxBigQueryConnectionConfig,
  env: NodeJS.ProcessEnv,
  defaultProject: string,
  connectionId: string,
): BigQueryDatasetRef[] {
  const rawEntries =
    Array.isArray(connection.dataset_ids) && connection.dataset_ids.length > 0
      ? connection.dataset_ids.map((dataset) => resolveStringReference(dataset, env))
      : [stringConfigValue(connection, 'dataset_id', env)].filter((value): value is string => Boolean(value));
  return rawEntries
    .map((entry) => entry.trim())
    .filter((entry) => entry.length > 0)
    .map((entry) => parseBigQueryDatasetEntry(entry, defaultProject, connectionId));
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

// jobTimeoutMs cancels the job with a "Job timed out" message (or a timeout
// reason in the errors array) once the deadline elapses.
function isBigQueryTimeoutError(error: unknown): boolean {
  if (!error || typeof error !== 'object') {
    return false;
  }
  const topMessage = (error as { message?: unknown }).message;
  if (typeof topMessage === 'string' && /timed out|timeout/i.test(topMessage)) {
    return true;
  }
  const errors = (error as { errors?: unknown }).errors;
  return (
    Array.isArray(errors) &&
    errors.some((entry) => {
      const reason = (entry as { reason?: unknown })?.reason;
      const message = (entry as { message?: unknown })?.message;
      return reason === 'timeout' || (typeof message === 'string' && /timed out|timeout/i.test(message));
    })
  );
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
  const resolvedDatasetIds = resolveDatasetRefs(input.connection, env, projectId, input.connectionId);
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
  private readonly deadlineMs: number;
  private readonly dialect = getSqlDialectForDriver('bigquery');
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
    this.deadlineMs = resolveQueryDeadlineMs(options.connection);
    this.id = `bigquery:${options.connectionId}`;
  }

  async testConnection(): Promise<KtxConnectorTestResult> {
    try {
      const client = this.getClient();
      await client.getDatasets({ maxResults: 1 });
      for (const ref of this.resolved.datasetIds) {
        await client.dataset(ref.dataset, ref.project).get();
      }
      return { success: true };
    } catch (error) {
      return connectorTestFailure(error);
    }
  }

  async introspect(input: KtxScanInput, _ctx: KtxScanContext): Promise<KtxSchemaSnapshot> {
    this.assertConnection(input.connectionId);
    const tables: KtxSchemaTable[] = [];
    const datasetRefs = this.requireDatasetIdsForScan();
    const snapshotWarnings: KtxScanWarning[] = [];
    for (const ref of datasetRefs) {
      const scopedNames = input.tableScope
        ? scopedTableNames(input.tableScope, { catalog: ref.project, db: ref.dataset })
        : null;
      tables.push(...(await this.introspectDataset(ref, scopedNames, snapshotWarnings)));
    }
    const datasetLabels = datasetRefs.map((ref) => this.qualifiedDatasetLabel(ref));
    return {
      connectionId: this.connectionId,
      driver: 'bigquery',
      extractedAt: this.now().toISOString(),
      scope: { catalogs: [...new Set(datasetRefs.map((ref) => ref.project))], datasets: datasetLabels },
      metadata: {
        project_id: this.resolved.projectId,
        datasets: datasetLabels,
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

  async getTableRowCount(
    tableName: string,
    ref: BigQueryDatasetRef | undefined = this.resolved.datasetIds[0],
  ): Promise<number> {
    if (!ref) {
      return 0;
    }
    const tables = await this.introspectDataset(ref, null, []);
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
    const region = normalizeBigQueryRegion(this.resolved.location ?? 'US', 'table discovery');
    if (!datasetIds || datasetIds.length === 0) {
      return this.listTablesInProject(this.resolved.projectId, region);
    }
    const datasetsByProject = new Map<string, string[]>();
    for (const entry of datasetIds) {
      const ref = parseBigQueryDatasetEntry(entry.trim(), this.resolved.projectId, this.connectionId);
      datasetsByProject.set(ref.project, [...(datasetsByProject.get(ref.project) ?? []), ref.dataset]);
    }
    const entries: KtxTableListEntry[] = [];
    for (const [project, datasets] of datasetsByProject) {
      entries.push(...(await this.listTablesInProject(project, region, datasets)));
    }
    return entries;
  }

  private async listTablesInProject(project: string, region: string, datasets?: string[]): Promise<KtxTableListEntry[]> {
    const projectId = normalizeBigQueryProjectId(project, 'table discovery');
    const params: Record<string, unknown> = {};
    const filter = datasets && datasets.length > 0 ? 'AND table_schema IN UNNEST(@dataset_ids)' : '';
    if (datasets && datasets.length > 0) {
      params.dataset_ids = datasets;
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
      catalog: project,
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

  private requireDatasetIdsForScan(): BigQueryDatasetRef[] {
    if (this.resolved.datasetIds.length === 0) {
      throw new Error(`Native BigQuery scan requires connections.${this.connectionId}.dataset_ids or dataset_id`);
    }
    return this.resolved.datasetIds;
  }

  // Bare in the billing project, qualified `project.dataset` otherwise, so the
  // snapshot's scope/metadata stay unambiguous when two projects host the same
  // dataset name. The dotless form is the unchanged single-project label.
  private qualifiedDatasetLabel(ref: BigQueryDatasetRef): string {
    return ref.project === this.resolved.projectId ? ref.dataset : `${ref.project}.${ref.dataset}`;
  }

  private async query(sql: string, params?: Record<string, unknown>): Promise<KtxQueryResult> {
    try {
      const [job] = await this.getClient().createQueryJob({
        query: sql,
        ...(this.resolved.location ? { location: this.resolved.location } : {}),
        ...(params && Object.keys(params).length > 0 ? { params } : {}),
        ...(this.maxBytesBilled ? { maximumBytesBilled: String(this.maxBytesBilled) } : {}),
        jobTimeoutMs: this.deadlineMs,
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
    } catch (error) {
      if (isBigQueryTimeoutError(error)) {
        throw queryDeadlineExceededError(this.deadlineMs, { cause: error });
      }
      throw error;
    }
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
    ref: BigQueryDatasetRef,
    scopedNames: readonly string[] | null,
    snapshotWarnings: KtxScanWarning[],
  ): Promise<KtxSchemaTable[]> {
    if (scopedNames && scopedNames.length === 0) return [];
    const dataset = this.getClient().dataset(ref.dataset, ref.project);
    const [tableRefs] = await dataset.getTables();
    const scopeSet = scopedNames ? new Set(scopedNames) : null;
    const filteredTableRefs = scopeSet ? tableRefs.filter((tableRef) => scopeSet.has(tableRef.id ?? '')) : tableRefs;
    const primaryKeysResult = await tryConstraintQuery(
      { schema: ref.dataset, kind: 'primary_key', isDeniedError },
      () => this.primaryKeys(ref),
    );
    const primaryKeys = primaryKeysResult.ok ? primaryKeysResult.value : new Map<string, Set<string>>();
    if (!primaryKeysResult.ok) {
      snapshotWarnings.push(primaryKeysResult.warning);
    }
    const tables: KtxSchemaTable[] = [];
    for (const tableRef of filteredTableRefs) {
      const tableName = tableRef.id || '';
      const outcome = await tryIntrospectObject<KtxSchemaTable>(
        { object: tableName, catalog: ref.project, db: ref.dataset },
        async () => {
          const [table] = await tableRef.get();
          const fields = table.metadata.schema?.fields ?? [];
          return {
            catalog: ref.project,
            db: ref.dataset,
            name: tableName,
            kind: tableKind(table.metadata.type),
            comment: table.metadata.description || null,
            estimatedRows: firstNumber(table.metadata.numRows) ?? 0,
            columns: fields.map((field) => this.toSchemaColumn(tableName, field, primaryKeys)),
            foreignKeys: [],
          };
        },
      );
      if (outcome.ok) {
        tables.push(outcome.table);
      } else {
        snapshotWarnings.push(outcome.warning);
      }
    }
    return tables;
  }

  private async primaryKeys(ref: BigQueryDatasetRef): Promise<Map<string, Set<string>>> {
    const rows = await this.queryRaw<{ table_name: string; column_name: string }>(
      'SELECT tc.table_name, kcu.column_name ' +
        'FROM `' +
        ref.project +
        '.' +
        ref.dataset +
        '.INFORMATION_SCHEMA.TABLE_CONSTRAINTS` tc ' +
        'JOIN `' +
        ref.project +
        '.' +
        ref.dataset +
        '.INFORMATION_SCHEMA.KEY_COLUMN_USAGE` kcu ' +
        'ON tc.constraint_name = kcu.constraint_name ' +
        'AND tc.table_schema = kcu.table_schema ' +
        'AND tc.table_name = kcu.table_name ' +
        "WHERE tc.constraint_type = 'PRIMARY KEY' " +
        "AND tc.table_schema = '" +
        ref.dataset +
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
