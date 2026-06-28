import { getDialectForDriver } from '../../context/connections/dialects.js';
import { assertReadOnlySql, limitSqlForExecution } from '../../context/connections/read-only-sql.js';
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

/**
 * Catalogs Trino always exposes that hold no user data. Excluded from "all
 * catalogs" discovery by default; an explicit `catalogs` allowlist overrides
 * this.
 */
const SYSTEM_CATALOGS = new Set(['system', 'jmx', 'tpch', 'tpcds']);

export interface KtxTrinoConnectionConfig {
  driver?: string;
  /** e.g. `https://trino.example.com:8443` — overrides host/port/ssl when set. */
  url?: string;
  host?: string;
  port?: number;
  ssl?: boolean;
  user?: string;
  username?: string;
  password?: string;
  /** Default catalog for unqualified queries; optional for discovery. */
  catalog?: string;
  /** Default schema for unqualified queries. */
  schema?: string;
  /**
   * Restricts discovery to these catalogs. When omitted, the connector
   * enumerates every catalog from `SHOW CATALOGS` minus {@link SYSTEM_CATALOGS}.
   */
  catalogs?: string[];
  /** Optional allowlist of schemas (applied within every discovered catalog). */
  schemas?: string[];
  [key: string]: unknown;
}

export interface KtxTrinoResolvedClientConfig {
  server: string;
  user: string;
  password?: string;
  catalog?: string;
  schema?: string;
  ssl: boolean;
}

/** Normalized result returned by {@link KtxTrinoClient.query}. */
export interface KtxTrinoQueryResult {
  columns: Array<{ name: string; type: string }>;
  rows: unknown[][];
}

/**
 * Minimal client surface the connector depends on. The default factory drives
 * the `trino-client` async statement iterator; tests inject a fake.
 */
export interface KtxTrinoClient {
  query(sql: string): Promise<KtxTrinoQueryResult>;
  close(): Promise<void>;
}

export interface KtxTrinoClientFactory {
  createClient(config: KtxTrinoResolvedClientConfig): KtxTrinoClient;
}

export interface KtxTrinoScanConnectorOptions {
  connectionId: string;
  connection: KtxTrinoConnectionConfig | undefined;
  clientFactory?: KtxTrinoClientFactory;
  env?: NodeJS.ProcessEnv;
  now?: () => Date;
}

interface TrinoTableRow {
  table_catalog: string;
  table_schema: string;
  table_name: string;
  table_type: string;
}

interface TrinoColumnRow {
  table_catalog: string;
  table_schema: string;
  table_name: string;
  column_name: string;
  data_type: string;
  is_nullable: string;
  comment: string | null;
}

/**
 * Default factory backed by `trino-client`. Imported lazily so the dependency
 * is only required when a Trino connection is actually used.
 */
class DefaultTrinoClientFactory implements KtxTrinoClientFactory {
  createClient(config: KtxTrinoResolvedClientConfig): KtxTrinoClient {
    let trinoPromise: Promise<unknown> | null = null;
    const getTrino = async (): Promise<{ query(sql: string): Promise<AsyncIterable<unknown>> }> => {
      if (!trinoPromise) {
        trinoPromise = (async () => {
          const mod = (await import('trino-client')) as {
            Trino: { create(options: unknown): unknown };
            BasicAuth: new (user: string, password?: string) => unknown;
          };
          // `ConnectionOptions` has no `user` field — the username travels on
          // `BasicAuth` (password is optional, so a no-password connection still
          // sets the Trino user header).
          return mod.Trino.create({
            server: config.server,
            catalog: config.catalog,
            schema: config.schema,
            auth: new mod.BasicAuth(config.user, config.password),
          });
        })();
      }
      return trinoPromise as Promise<{ query(sql: string): Promise<AsyncIterable<unknown>> }>;
    };

    return {
      async query(sql: string): Promise<KtxTrinoQueryResult> {
        const trino = await getTrino();
        const iterator = await trino.query(sql);
        const columns: Array<{ name: string; type: string }> = [];
        const rows: unknown[][] = [];
        for await (const page of iterator as AsyncIterable<{
          columns?: Array<{ name: string; type: string }>;
          data?: unknown[][];
          error?: { message?: string };
        }>) {
          if (page.error) {
            throw new Error(page.error.message ?? 'Trino query failed');
          }
          if (page.columns && columns.length === 0) {
            columns.push(...page.columns.map((column) => ({ name: column.name, type: column.type })));
          }
          if (page.data) {
            rows.push(...page.data);
          }
        }
        return { columns, rows };
      },
      async close(): Promise<void> {
        // trino-client is stateless over HTTP; nothing to tear down.
      },
    };
  }
}

function stringConfigValue(
  connection: KtxTrinoConnectionConfig | undefined,
  key: keyof KtxTrinoConnectionConfig,
  env: NodeJS.ProcessEnv,
): string | undefined {
  const value = connection?.[key];
  return typeof value === 'string' && value.trim().length > 0 ? resolveStringReference(value.trim(), env) : undefined;
}

function maybeNumber(value: unknown): number | undefined {
  return typeof value === 'number' && Number.isFinite(value) ? value : undefined;
}

export function isKtxTrinoConnectionConfig(
  connection: KtxTrinoConnectionConfig | undefined,
): connection is KtxTrinoConnectionConfig {
  return String(connection?.driver ?? '').toLowerCase() === 'trino';
}

/** @internal */
export function trinoClientConfigFromConfig(input: {
  connectionId: string;
  connection: KtxTrinoConnectionConfig | undefined;
  env?: NodeJS.ProcessEnv;
}): KtxTrinoResolvedClientConfig {
  const inputDriver = input.connection?.driver ?? 'unknown';
  if (!isKtxTrinoConnectionConfig(input.connection)) {
    throw new Error(`Trino connector cannot run driver "${inputDriver}"`);
  }

  const env = input.env ?? process.env;
  const referencedUrl = stringConfigValue(input.connection, 'url', env);
  let server = referencedUrl;
  let ssl = input.connection.ssl === true;
  if (!server) {
    const host = stringConfigValue(input.connection, 'host', env);
    if (!host) {
      throw new Error(`Trino connector requires connections.${input.connectionId}.url or host`);
    }
    const port = maybeNumber(input.connection.port) ?? (ssl ? 8443 : 8080);
    server = `${ssl ? 'https' : 'http'}://${host}:${port}`;
  } else {
    ssl = server.startsWith('https://');
  }

  const user = stringConfigValue(input.connection, 'user', env) ?? stringConfigValue(input.connection, 'username', env);
  if (!user) {
    throw new Error(`Trino connector requires connections.${input.connectionId}.user`);
  }

  return {
    server,
    user,
    password: stringConfigValue(input.connection, 'password', env),
    catalog: stringConfigValue(input.connection, 'catalog', env),
    schema: stringConfigValue(input.connection, 'schema', env),
    ssl,
  };
}

function trinoTableKey(catalog: string, schema: string, table: string): string {
  return `${catalog}.${schema}.${table}`;
}

export class KtxTrinoScanConnector implements KtxScanConnector {
  readonly id: string;
  readonly driver = 'trino' as const;
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
  private readonly connection: KtxTrinoConnectionConfig;
  private readonly clientConfig: KtxTrinoResolvedClientConfig;
  private readonly clientFactory: KtxTrinoClientFactory;
  private readonly now: () => Date;
  private readonly dialect = getDialectForDriver('trino');
  private client: KtxTrinoClient | null = null;

  constructor(options: KtxTrinoScanConnectorOptions) {
    this.connectionId = options.connectionId;
    this.connection = options.connection ?? {};
    this.clientConfig = trinoClientConfigFromConfig({
      connectionId: options.connectionId,
      connection: options.connection,
      env: options.env,
    });
    this.clientFactory = options.clientFactory ?? new DefaultTrinoClientFactory();
    this.now = options.now ?? (() => new Date());
    this.id = `trino:${options.connectionId}`;
  }

  async testConnection(): Promise<KtxConnectorTestResult> {
    try {
      await this.query('SELECT 1');
      return { success: true };
    } catch (error) {
      return connectorTestFailure(error);
    }
  }

  /** Resolve which catalogs to introspect: explicit allowlist, else all non-system catalogs. */
  private async resolveCatalogs(): Promise<string[]> {
    const configured = (this.connection.catalogs ?? [])
      .filter((catalog): catalog is string => typeof catalog === 'string' && catalog.trim().length > 0)
      .map((catalog) => catalog.trim());
    if (configured.length > 0) {
      return [...new Set(configured)];
    }
    // `SHOW CATALOGS` is not a SELECT, so it would be rejected by the read-only
    // gate; Trino exposes the same data as a queryable system table.
    const rows = await this.queryRows<{ catalog_name: string }>(
      'SELECT catalog_name FROM system.metadata.catalogs ORDER BY catalog_name',
    );
    return rows
      .map((row) => String(row.catalog_name))
      .filter((catalog) => !SYSTEM_CATALOGS.has(catalog.toLowerCase()));
  }

  async introspect(input: KtxScanInput, _ctx: KtxScanContext): Promise<KtxSchemaSnapshot> {
    this.assertConnection(input.connectionId);
    const catalogs = await this.resolveCatalogs();
    const schemaTables: KtxSchemaTable[] = [];

    for (const catalog of catalogs) {
      const quotedCatalog = this.dialect.quoteIdentifier(catalog);
      const schemaFilter =
        this.connection.schemas && this.connection.schemas.length > 0
          ? ` AND table_schema IN (${this.connection.schemas.map((schema) => this.quoteLiteral(schema)).join(', ')})`
          : " AND table_schema <> 'information_schema'";

      const tables = await this.queryRows<TrinoTableRow>(
        `SELECT table_catalog, table_schema, table_name, table_type
         FROM ${quotedCatalog}.information_schema.tables
         WHERE 1 = 1${schemaFilter}
         ORDER BY table_schema, table_name`,
      );
      if (tables.length === 0) {
        continue;
      }

      const columns = await this.queryRows<TrinoColumnRow>(
        `SELECT table_catalog, table_schema, table_name, column_name, data_type, is_nullable, comment
         FROM ${quotedCatalog}.information_schema.columns
         WHERE 1 = 1${schemaFilter}
         ORDER BY table_schema, table_name, ordinal_position`,
      );
      const columnsByTable = new Map<string, TrinoColumnRow[]>();
      for (const column of columns) {
        const key = trinoTableKey(column.table_catalog, column.table_schema, column.table_name);
        columnsByTable.set(key, [...(columnsByTable.get(key) ?? []), column]);
      }

      // Honor tableScope by post-filtering against the (catalog, schema) namespaces.
      for (const table of tables) {
        if (input.tableScope) {
          const allowed = scopedTableNames(input.tableScope, { catalog, db: table.table_schema });
          if (!allowed.includes(table.table_name)) {
            continue;
          }
        }
        const key = trinoTableKey(table.table_catalog, table.table_schema, table.table_name);
        schemaTables.push(this.toSchemaTable(table, columnsByTable.get(key) ?? []));
      }
    }

    return {
      connectionId: this.connectionId,
      driver: 'trino',
      extractedAt: this.now().toISOString(),
      scope: { catalogs },
      metadata: {
        server: this.clientConfig.server,
        catalogs,
        table_count: schemaTables.length,
        total_columns: schemaTables.reduce((sum, table) => sum + table.columns.length, 0),
      },
      tables: schemaTables,
    };
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
    const limitedSql = limitSqlForExecution(assertReadOnlySql(input.sql), input.maxRows);
    const result = await this.query(limitedSql);
    return { ...result, rowCount: result.rows.length };
  }

  async listSchemas(): Promise<string[]> {
    const catalogs = await this.resolveCatalogs();
    const schemas = new Set<string>();
    for (const catalog of catalogs) {
      const quotedCatalog = this.dialect.quoteIdentifier(catalog);
      const rows = await this.queryRows<{ schema_name: string }>(
        `SELECT schema_name FROM ${quotedCatalog}.information_schema.schemata
         WHERE schema_name <> 'information_schema'
         ORDER BY schema_name`,
      );
      // Schemas are namespaced by catalog to stay unambiguous across catalogs.
      for (const row of rows) {
        schemas.add(`${catalog}.${row.schema_name}`);
      }
    }
    return [...schemas];
  }

  async listTables(schemas?: string[]): Promise<KtxTableListEntry[]> {
    const catalogs = await this.resolveCatalogs();
    const wanted = schemas ? new Set(schemas) : null;
    const entries: KtxTableListEntry[] = [];
    for (const catalog of catalogs) {
      const quotedCatalog = this.dialect.quoteIdentifier(catalog);
      const rows = await this.queryRows<TrinoTableRow>(
        `SELECT table_catalog, table_schema, table_name, table_type
         FROM ${quotedCatalog}.information_schema.tables
         WHERE table_schema <> 'information_schema'
         ORDER BY table_schema, table_name`,
      );
      for (const row of rows) {
        if (wanted && !wanted.has(`${catalog}.${row.table_schema}`) && !wanted.has(row.table_schema)) {
          continue;
        }
        entries.push({
          catalog: row.table_catalog,
          schema: row.table_schema,
          name: row.table_name,
          kind: row.table_type.toUpperCase().includes('VIEW') ? 'view' : 'table',
        });
      }
    }
    return entries;
  }

  async cleanup(): Promise<void> {
    if (this.client) {
      await this.client.close();
      this.client = null;
    }
  }

  qTableName(table: Pick<KtxTableRef, 'name'> & Partial<Pick<KtxTableRef, 'catalog' | 'db'>>): string {
    return this.dialect.formatTableName(table);
  }

  private toSchemaTable(table: TrinoTableRow, columns: TrinoColumnRow[]): KtxSchemaTable {
    const kind = table.table_type.toUpperCase().includes('VIEW') ? 'view' : 'table';
    return {
      catalog: table.table_catalog,
      db: table.table_schema,
      name: table.table_name,
      kind,
      comment: null,
      estimatedRows: null,
      columns: columns.map((column) => this.toSchemaColumn(column)),
      foreignKeys: [],
    };
  }

  private toSchemaColumn(column: TrinoColumnRow): KtxSchemaColumn {
    return {
      name: column.column_name,
      nativeType: column.data_type,
      normalizedType: this.dialect.mapDataType(column.data_type),
      dimensionType: this.dialect.mapToDimensionType(column.data_type),
      nullable: String(column.is_nullable).toUpperCase() !== 'NO',
      primaryKey: false,
      comment: column.comment ?? null,
    };
  }

  private quoteLiteral(value: string): string {
    return `'${value.replace(/'/g, "''")}'`;
  }

  private async clientForQuery(): Promise<KtxTrinoClient> {
    if (!this.client) {
      this.client = this.clientFactory.createClient(this.clientConfig);
    }
    return this.client;
  }

  private async queryRows<T>(sql: string): Promise<T[]> {
    const result = await this.query(sql);
    return result.rows.map((row) => {
      const record: Record<string, unknown> = {};
      result.headers.forEach((header, index) => {
        record[header] = row[index];
      });
      return record as T;
    });
  }

  private async query(sql: string): Promise<Omit<KtxQueryResult, 'rowCount'>> {
    const client = await this.clientForQuery();
    const result = await client.query(assertReadOnlySql(sql));
    return {
      headers: result.columns.map((column) => column.name),
      headerTypes: result.columns.map((column) => column.type),
      rows: result.rows,
      totalRows: result.rows.length,
    };
  }

  private assertConnection(connectionId: string): void {
    if (connectionId !== this.connectionId) {
      throw new Error(`ktx Trino connector ${this.id} cannot serve connection ${connectionId}`);
    }
  }
}
