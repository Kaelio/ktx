import { AthenaClient, StartQueryExecutionCommand, GetQueryExecutionCommand, GetQueryResultsCommand } from '@aws-sdk/client-athena';
import { GlueClient, GetDatabasesCommand, GetTablesCommand } from '@aws-sdk/client-glue';
import { getSqlDialectForDriver } from '../../context/connections/dialects.js';
import { assertReadOnlySql, limitSqlForExecution } from '../../context/connections/read-only-sql.js';
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
  type KtxSchemaColumn,
  type KtxSchemaSnapshot,
  type KtxSchemaTable,
  type KtxTableListEntry,
  type KtxTableRef,
  type KtxTableSampleInput,
  type KtxTableSampleResult,
} from '../../context/scan/types.js';
import { scopedTableNames } from '../../context/scan/table-ref.js';
import { resolveStringReference } from '../shared/string-reference.js';

export interface KtxAthenaConnectionConfig {
  driver?: string;
  region?: string;
  s3_staging_dir?: string;
  workgroup?: string;
  catalog?: string;
  database?: string;
  databases?: string[];
  [key: string]: unknown;
}

export interface KtxAthenaResolvedConnectionConfig {
  region: string;
  s3StagingDir: string;
  workgroup: string;
  catalog: string;
  database: string | undefined;
  databases: string[];
}

interface KtxAthenaQueryExecutionStatus {
  State?: string;
  StateChangeReason?: string;
}

interface KtxAthenaQueryExecution {
  Status?: KtxAthenaQueryExecutionStatus;
}

interface KtxAthenaColumnInfo {
  Name?: string;
  Type?: string;
}

interface KtxAthenaDatum {
  VarCharValue?: string;
}

interface KtxAthenaRow {
  Data?: KtxAthenaDatum[];
}

interface KtxAthenaResultSet {
  Rows?: KtxAthenaRow[];
  ResultSetMetadata?: { ColumnInfo?: KtxAthenaColumnInfo[] };
}

/** @internal */
export interface KtxAthenaClient {
  startQueryExecution(input: {
    QueryString: string;
    ResultConfiguration: { OutputLocation: string };
    WorkGroup: string;
    QueryExecutionContext?: { Database?: string; Catalog?: string };
  }): Promise<{ QueryExecutionId?: string }>;
  getQueryExecution(input: { QueryExecutionId: string }): Promise<{ QueryExecution?: KtxAthenaQueryExecution }>;
  getQueryResults(input: { QueryExecutionId: string; NextToken?: string }): Promise<{
    ResultSet?: KtxAthenaResultSet;
    NextToken?: string;
  }>;
}

interface KtxGlueColumnDef {
  Name?: string;
  Type?: string;
  Comment?: string;
}

interface KtxGlueStorageDescriptor {
  Columns?: KtxGlueColumnDef[];
}

/** @internal */
export interface KtxGlueTable {
  Name?: string;
  TableType?: string;
  StorageDescriptor?: KtxGlueStorageDescriptor;
  PartitionKeys?: KtxGlueColumnDef[];
  Description?: string;
  Parameters?: Record<string, string>;
}

/** @internal */
export interface KtxGlueClient {
  getDatabases(input: { CatalogId?: string; NextToken?: string }): Promise<{
    DatabaseList?: Array<{ Name?: string }>;
    NextToken?: string;
  }>;
  getTables(input: { DatabaseName: string; CatalogId?: string; NextToken?: string }): Promise<{
    TableList?: KtxGlueTable[];
    NextToken?: string;
  }>;
}

export interface KtxAthenaClientFactory {
  createAthenaClient(region: string): KtxAthenaClient;
  createGlueClient(region: string): KtxGlueClient;
}

class DefaultAthenaClientFactory implements KtxAthenaClientFactory {
  createAthenaClient(region: string): KtxAthenaClient {
    const client = new AthenaClient({ region });
    return {
      startQueryExecution: async (input) => {
        const result = await client.send(
          new StartQueryExecutionCommand({
            QueryString: input.QueryString,
            ResultConfiguration: { OutputLocation: input.ResultConfiguration.OutputLocation },
            WorkGroup: input.WorkGroup,
            QueryExecutionContext: input.QueryExecutionContext,
          }),
        );
        return { QueryExecutionId: result.QueryExecutionId };
      },
      getQueryExecution: async (input) => {
        const result = await client.send(new GetQueryExecutionCommand({ QueryExecutionId: input.QueryExecutionId }));
        return {
          QueryExecution: result.QueryExecution
            ? {
                Status: {
                  State: result.QueryExecution.Status?.State,
                  StateChangeReason: result.QueryExecution.Status?.StateChangeReason,
                },
              }
            : undefined,
        };
      },
      getQueryResults: async (input) => {
        const result = await client.send(
          new GetQueryResultsCommand({ QueryExecutionId: input.QueryExecutionId, NextToken: input.NextToken }),
        );
        return {
          ResultSet: result.ResultSet as KtxAthenaResultSet | undefined,
          NextToken: result.NextToken,
        };
      },
    };
  }

  createGlueClient(region: string): KtxGlueClient {
    const client = new GlueClient({ region });
    return {
      getDatabases: async (input) => {
        const result = await client.send(new GetDatabasesCommand({ CatalogId: input.CatalogId, NextToken: input.NextToken }));
        return {
          DatabaseList: result.DatabaseList?.map((db) => ({ Name: db.Name })),
          NextToken: result.NextToken,
        };
      },
      getTables: async (input) => {
        const result = await client.send(
          new GetTablesCommand({ DatabaseName: input.DatabaseName, CatalogId: input.CatalogId, NextToken: input.NextToken }),
        );
        return {
          TableList: result.TableList as KtxGlueTable[] | undefined,
          NextToken: result.NextToken,
        };
      },
    };
  }
}

function stringConfigValue(
  connection: KtxAthenaConnectionConfig | undefined,
  key: keyof KtxAthenaConnectionConfig,
  env: NodeJS.ProcessEnv,
): string | undefined {
  const value = connection?.[key];
  if (typeof value !== 'string' || value.trim().length === 0) return undefined;
  // Resolve before checking emptiness: an unset `env:` reference resolves to '',
  // which must become undefined so `?? default` applies instead of keeping ''.
  const resolved = resolveStringReference(value.trim(), env).trim();
  return resolved.length > 0 ? resolved : undefined;
}

function configuredAthenaDatabases(connection: KtxAthenaConnectionConfig): string[] {
  if (!Array.isArray(connection.databases)) return [];
  const selected = connection.databases
    .filter((database): database is string => typeof database === 'string' && database.trim().length > 0)
    .map((database) => database.trim());
  return [...new Set(selected)];
}

export function isKtxAthenaConnectionConfig(
  connection: unknown,
): connection is KtxAthenaConnectionConfig {
  return (
    typeof connection === 'object' &&
    connection !== null &&
    String((connection as { driver?: unknown }).driver ?? '').toLowerCase() === 'athena'
  );
}

/** @internal */
export function athenaConnectionConfigFromConfig(input: {
  connectionId: string;
  connection: KtxAthenaConnectionConfig | undefined;
  env?: NodeJS.ProcessEnv;
}): KtxAthenaResolvedConnectionConfig {
  const inputDriver = input.connection?.driver ?? 'unknown';
  if (!isKtxAthenaConnectionConfig(input.connection)) {
    throw new Error(`Native Athena connector cannot run driver "${String(inputDriver)}"`);
  }
  const env = input.env ?? process.env;
  const region = stringConfigValue(input.connection, 'region', env);
  if (!region) {
    throw new Error(`Native Athena connector requires connections.${input.connectionId}.region`);
  }
  const s3StagingDir = stringConfigValue(input.connection, 's3_staging_dir', env);
  if (!s3StagingDir) {
    throw new Error(`Native Athena connector requires connections.${input.connectionId}.s3_staging_dir`);
  }
  return {
    region,
    s3StagingDir,
    workgroup: stringConfigValue(input.connection, 'workgroup', env) ?? 'primary',
    catalog: stringConfigValue(input.connection, 'catalog', env) ?? 'AwsDataCatalog',
    database: stringConfigValue(input.connection, 'database', env),
    databases: configuredAthenaDatabases(input.connection),
  };
}

function glueTableKind(tableType: string | undefined): 'table' | 'view' {
  const t = String(tableType ?? '').toUpperCase();
  if (t === 'VIRTUAL_VIEW') return 'view';
  return 'table';
}

const POLL_INTERVAL_MS = 250;
const QUERY_TIMEOUT_MS = 5 * 60 * 1000;

export interface KtxAthenaScanConnectorOptions {
  connectionId: string;
  connection: KtxAthenaConnectionConfig | undefined;
  clientFactory?: KtxAthenaClientFactory;
  env?: NodeJS.ProcessEnv;
  now?: () => Date;
}

export class KtxAthenaScanConnector implements KtxScanConnector {
  readonly id: string;
  readonly driver = 'athena' as const;
  readonly capabilities = createKtxConnectorCapabilities({
    tableSampling: true,
    columnSampling: true,
    columnStats: false,
    readOnlySql: true,
    nestedAnalysis: false,
    formalForeignKeys: false,
    estimatedRowCounts: false,
  });

  private readonly connectionId: string;
  private readonly resolved: KtxAthenaResolvedConnectionConfig;
  private readonly clientFactory: KtxAthenaClientFactory;
  private readonly now: () => Date;
  private readonly dialect = getSqlDialectForDriver('athena');
  private athenaClient: KtxAthenaClient | null = null;
  private glueClient: KtxGlueClient | null = null;

  constructor(options: KtxAthenaScanConnectorOptions) {
    this.connectionId = options.connectionId;
    this.resolved = athenaConnectionConfigFromConfig({
      connectionId: options.connectionId,
      connection: options.connection,
      env: options.env,
    });
    this.clientFactory = options.clientFactory ?? new DefaultAthenaClientFactory();
    this.now = options.now ?? (() => new Date());
    this.id = `athena:${options.connectionId}`;
  }

  async testConnection(): Promise<KtxConnectorTestResult> {
    try {
      await this.listDatabasesPaginated({ maxResults: 1 });
      return { success: true };
    } catch (error) {
      return connectorTestFailure(error);
    }
  }

  async introspect(input: KtxScanInput, _ctx: KtxScanContext): Promise<KtxSchemaSnapshot> {
    this.assertConnection(input.connectionId);
    // Honor the configured `databases` scope (written by `ktx setup`); fall back
    // to every Glue database only when the scope is unset.
    const databases =
      this.resolved.databases.length > 0 ? this.resolved.databases : await this.listDatabasesPaginated({});
    const tables: KtxSchemaTable[] = [];
    for (const database of databases) {
      const scopedNames = input.tableScope
        ? scopedTableNames(input.tableScope, { catalog: this.resolved.catalog, db: database })
        : null;
      tables.push(...(await this.introspectDatabase(database, scopedNames)));
    }
    return {
      connectionId: this.connectionId,
      driver: 'athena',
      extractedAt: this.now().toISOString(),
      scope: { catalogs: [this.resolved.catalog], datasets: databases },
      metadata: {
        catalog: this.resolved.catalog,
        databases,
        table_count: tables.length,
        total_columns: tables.reduce((sum, t) => sum + t.columns.length, 0),
      },
      tables,
      warnings: [],
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
    return {
      values: result.rows.filter((row) => row.length > 0 && row[0] !== null).map((row) => row[0]),
      nullCount: null,
      distinctCount: null,
    };
  }

  async columnStats(_input: KtxColumnStatsInput, _ctx: KtxScanContext): Promise<KtxColumnStatsResult | null> {
    return null;
  }

  async executeReadOnly(input: KtxReadOnlyQueryInput, _ctx: KtxScanContext): Promise<KtxQueryResult> {
    this.assertConnection(input.connectionId);
    const limitedSql = limitSqlForExecution(assertReadOnlySql(input.sql), input.maxRows);
    const result = await this.query(limitedSql);
    return { ...result, rowCount: result.rows.length };
  }

  async listSchemas(): Promise<string[]> {
    return this.listDatabasesPaginated({});
  }

  async listTables(databases?: string[]): Promise<KtxTableListEntry[]> {
    const targetDatabases = databases && databases.length > 0 ? databases : await this.listDatabasesPaginated({});
    const entries: KtxTableListEntry[] = [];
    for (const database of targetDatabases) {
      const glueTables = await this.listGlueTablesPaginated(database);
      for (const t of glueTables) {
        if (!t.Name) continue;
        entries.push({
          catalog: this.resolved.catalog,
          schema: database,
          name: t.Name,
          kind: glueTableKind(t.TableType),
        });
      }
    }
    return entries;
  }

  async cleanup(): Promise<void> {
    this.athenaClient = null;
    this.glueClient = null;
  }

  qTableName(table: Pick<KtxTableRef, 'name'> & Partial<Pick<KtxTableRef, 'catalog' | 'db'>>): string {
    return this.dialect.formatTableName(table);
  }

  private getAthenaClient(): KtxAthenaClient {
    if (!this.athenaClient) {
      this.athenaClient = this.clientFactory.createAthenaClient(this.resolved.region);
    }
    return this.athenaClient;
  }

  private getGlueClient(): KtxGlueClient {
    if (!this.glueClient) {
      this.glueClient = this.clientFactory.createGlueClient(this.resolved.region);
    }
    return this.glueClient;
  }

  private async listDatabasesPaginated(opts: { maxResults?: number }): Promise<string[]> {
    const names: string[] = [];
    let nextToken: string | undefined;
    do {
      const result = await this.getGlueClient().getDatabases({ NextToken: nextToken });
      for (const db of result.DatabaseList ?? []) {
        if (db.Name) names.push(db.Name);
        if (opts.maxResults && names.length >= opts.maxResults) return names;
      }
      nextToken = result.NextToken;
    } while (nextToken);
    return names;
  }

  private async listGlueTablesPaginated(database: string): Promise<KtxGlueTable[]> {
    const tables: KtxGlueTable[] = [];
    let nextToken: string | undefined;
    do {
      const result = await this.getGlueClient().getTables({ DatabaseName: database, NextToken: nextToken });
      tables.push(...(result.TableList ?? []));
      nextToken = result.NextToken;
    } while (nextToken);
    return tables;
  }

  private async introspectDatabase(database: string, scopedNames: readonly string[] | null): Promise<KtxSchemaTable[]> {
    if (scopedNames && scopedNames.length === 0) return [];
    const glueTables = await this.listGlueTablesPaginated(database);
    const scopeSet = scopedNames ? new Set(scopedNames) : null;
    return glueTables
      .filter((t): t is KtxGlueTable & { Name: string } => Boolean(t.Name) && (!scopeSet || scopeSet.has(t.Name!)))
      .map((t) => ({
        catalog: this.resolved.catalog,
        db: database,
        name: t.Name,
        kind: glueTableKind(t.TableType),
        comment: t.Description ?? null,
        estimatedRows: null,
        columns: this.toSchemaColumns(t),
        foreignKeys: [],
      }));
  }

  private toSchemaColumns(table: KtxGlueTable): KtxSchemaColumn[] {
    const columns = [...(table.StorageDescriptor?.Columns ?? []), ...(table.PartitionKeys ?? [])];
    return columns
      .filter((col): col is KtxGlueColumnDef & { Name: string } => Boolean(col.Name))
      .map((col) => {
        const nativeType = String(col.Type ?? 'string').toLowerCase();
        return {
          name: col.Name,
          nativeType,
          normalizedType: this.dialect.mapDataType(nativeType),
          dimensionType: this.dialect.mapToDimensionType(nativeType),
          nullable: true,
          primaryKey: false,
          comment: col.Comment ?? null,
        };
      });
  }

  private async query(sql: string): Promise<KtxQueryResult> {
    const athena = this.getAthenaClient();
    const { QueryExecutionId } = await athena.startQueryExecution({
      QueryString: sql,
      ResultConfiguration: { OutputLocation: this.resolved.s3StagingDir },
      WorkGroup: this.resolved.workgroup,
      ...(this.resolved.database || this.resolved.catalog
        ? {
            QueryExecutionContext: {
              ...(this.resolved.database ? { Database: this.resolved.database } : {}),
              ...(this.resolved.catalog ? { Catalog: this.resolved.catalog } : {}),
            },
          }
        : {}),
    });

    if (!QueryExecutionId) {
      throw new Error('Athena did not return a QueryExecutionId');
    }

    await this.waitForQueryCompletion(athena, QueryExecutionId);

    const rows: unknown[][] = [];
    let headers: string[] = [];
    let headerTypes: string[] = [];
    let nextToken: string | undefined;
    let firstPage = true;

    do {
      const result = await athena.getQueryResults({ QueryExecutionId, NextToken: nextToken });
      const resultSet = result.ResultSet;

      if (firstPage) {
        const columnInfo = resultSet?.ResultSetMetadata?.ColumnInfo ?? [];
        headers = columnInfo.map((col) => col.Name ?? '');
        headerTypes = columnInfo.map((col) => String(col.Type ?? 'varchar').toUpperCase());
        firstPage = false;
      }

      const pageRows = resultSet?.Rows ?? [];
      // Athena includes the header row as the first row of the first page — skip it.
      const dataRows = nextToken === undefined ? pageRows.slice(1) : pageRows;
      for (const row of dataRows) {
        rows.push((row.Data ?? []).map((d) => d.VarCharValue ?? null));
      }

      nextToken = result.NextToken;
    } while (nextToken);

    return {
      headers,
      headerTypes: headerTypes.length > 0 ? headerTypes : undefined,
      rows,
      totalRows: rows.length,
      rowCount: rows.length,
    };
  }

  private async waitForQueryCompletion(athena: KtxAthenaClient, queryExecutionId: string): Promise<void> {
    const terminalStates = new Set(['SUCCEEDED', 'FAILED', 'CANCELLED']);
    const deadline = this.now().getTime() + QUERY_TIMEOUT_MS;
    for (;;) {
      const { QueryExecution } = await athena.getQueryExecution({ QueryExecutionId: queryExecutionId });
      const state = QueryExecution?.Status?.State ?? '';
      if (state === 'SUCCEEDED') return;
      if (terminalStates.has(state)) {
        const reason = QueryExecution?.Status?.StateChangeReason ?? state;
        throw new Error(`Athena query ${state}: ${reason}`);
      }
      if (this.now().getTime() >= deadline) {
        throw new Error(`Athena query ${queryExecutionId} timed out after ${QUERY_TIMEOUT_MS / 1000}s`);
      }
      await new Promise((resolve) => setTimeout(resolve, POLL_INTERVAL_MS));
    }
  }

  private assertConnection(connectionId: string): void {
    if (connectionId !== this.connectionId) {
      throw new Error(`Athena connector ${this.connectionId} cannot scan connection ${connectionId}`);
    }
  }
}
