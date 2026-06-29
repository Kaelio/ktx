import { MongoClient } from 'mongodb';
import { resolveKtxConfigReference } from '../../context/core/config-reference.js';
import {
  connectorTestFailure,
  createKtxConnectorCapabilities,
  type KtxColumnSampleInput,
  type KtxColumnSampleResult,
  type KtxConnectorTestResult,
  type KtxScanConnector,
  type KtxScanContext,
  type KtxScanInput,
  type KtxSchemaSnapshot,
  type KtxSchemaTable,
  type KtxTableListEntry,
  type KtxTableRef,
  type KtxTableSampleInput,
  type KtxTableSampleResult,
} from '../../context/scan/types.js';
import { scopedTableNames } from '../../context/scan/table-ref.js';
import { getDialectForDriver } from '../../context/connections/dialects.js';
import { inferKtxMongoCollectionColumns, type KtxMongoDocument, MONGO_ID_FIELD } from './schema-inference.js';

const DEFAULT_SAMPLE_SIZE = 1000;
const SAMPLE_MAX_TIME_MS = 30_000;

export interface KtxMongoDbConnectionConfig {
  driver?: string;
  url?: string;
  database?: string;
  databases?: string[];
  enabled_tables?: string[];
  sample_size?: number;
  order_by?: string;
  [key: string]: unknown;
}

export interface KtxMongoListedCollection {
  name: string;
  type?: string;
}

interface KtxMongoFindOptions {
  sort: Record<string, 1 | -1>;
  limit: number;
  projection?: Record<string, 1>;
}

/** Driver-agnostic seam over the `mongodb` client so the connector is unit-testable without a server. */
export interface KtxMongoClient {
  listCollections(databaseName: string): Promise<KtxMongoListedCollection[]>;
  estimatedDocumentCount(databaseName: string, collectionName: string): Promise<number>;
  find(databaseName: string, collectionName: string, options: KtxMongoFindOptions): Promise<KtxMongoDocument[]>;
  ping(databaseName: string): Promise<void>;
  close(): Promise<void>;
}

export interface KtxMongoClientFactory {
  create(url: string): KtxMongoClient;
}

export interface KtxMongoDbScanConnectorOptions {
  connectionId: string;
  connection: KtxMongoDbConnectionConfig | undefined;
  clientFactory?: KtxMongoClientFactory;
  env?: NodeJS.ProcessEnv;
  now?: () => Date;
}

class DefaultMongoClient implements KtxMongoClient {
  private readonly client: MongoClient;
  private connected = false;

  constructor(url: string) {
    this.client = new MongoClient(url);
  }

  private async connectedClient(): Promise<MongoClient> {
    if (!this.connected) {
      await this.client.connect();
      this.connected = true;
    }
    return this.client;
  }

  async listCollections(databaseName: string): Promise<KtxMongoListedCollection[]> {
    const client = await this.connectedClient();
    const collections = await client.db(databaseName).listCollections({}, { nameOnly: false }).toArray();
    return collections.map((collection) => ({ name: collection.name, type: collection.type }));
  }

  async estimatedDocumentCount(databaseName: string, collectionName: string): Promise<number> {
    const client = await this.connectedClient();
    return client.db(databaseName).collection(collectionName).estimatedDocumentCount();
  }

  async find(
    databaseName: string,
    collectionName: string,
    options: KtxMongoFindOptions,
  ): Promise<KtxMongoDocument[]> {
    const client = await this.connectedClient();
    return client
      .db(databaseName)
      .collection(collectionName)
      .find({}, { sort: options.sort, limit: options.limit, maxTimeMS: SAMPLE_MAX_TIME_MS, ...(options.projection ? { projection: options.projection } : {}) })
      .toArray() as Promise<KtxMongoDocument[]>;
  }

  async ping(databaseName: string): Promise<void> {
    const client = await this.connectedClient();
    await client.db(databaseName).command({ ping: 1 });
  }

  async close(): Promise<void> {
    if (this.connected) {
      await this.client.close();
      this.connected = false;
    }
  }
}

class DefaultMongoClientFactory implements KtxMongoClientFactory {
  create(url: string): KtxMongoClient {
    return new DefaultMongoClient(url);
  }
}

export function isKtxMongoDbConnectionConfig(
  connection: KtxMongoDbConnectionConfig | undefined,
): connection is KtxMongoDbConnectionConfig {
  return String(connection?.driver ?? '').toLowerCase() === 'mongodb';
}

function databaseFromUrl(url: string): string | undefined {
  try {
    const path = new URL(url).pathname.replace(/^\/+/, '');
    const database = path.split('/')[0];
    return database && database.length > 0 ? decodeURIComponent(database) : undefined;
  } catch {
    return undefined;
  }
}

function configuredDatabases(connection: KtxMongoDbConnectionConfig, fallback: string | undefined): string[] {
  if (Array.isArray(connection.databases)) {
    const selected = connection.databases
      .filter((database): database is string => typeof database === 'string' && database.trim().length > 0)
      .map((database) => database.trim());
    if (selected.length > 0) {
      return [...new Set(selected)];
    }
  }
  const single = typeof connection.database === 'string' && connection.database.trim().length > 0
    ? connection.database.trim()
    : fallback;
  return single ? [single] : [];
}

function positiveInteger(value: unknown, fallback: number): number {
  return typeof value === 'number' && Number.isInteger(value) && value > 0 ? value : fallback;
}

function normalizeSampleValue(value: unknown): unknown {
  if (value === null || value === undefined) {
    return null;
  }
  if (value instanceof Date) {
    return value.toISOString();
  }
  if (typeof value === 'object') {
    const bsontype = (value as { _bsontype?: unknown })._bsontype;
    return typeof bsontype === 'string' ? String(value) : JSON.stringify(value);
  }
  return value;
}

function unionDocumentKeys(documents: readonly KtxMongoDocument[]): string[] {
  const keys: string[] = [];
  const seen = new Set<string>();
  for (const document of documents) {
    for (const key of Object.keys(document)) {
      if (!seen.has(key)) {
        seen.add(key);
        keys.push(key);
      }
    }
  }
  return keys;
}

export class KtxMongoDbScanConnector implements KtxScanConnector {
  readonly id: string;
  readonly driver = 'mongodb' as const;
  readonly capabilities = createKtxConnectorCapabilities({
    tableSampling: true,
    columnSampling: true,
    columnStats: false,
    readOnlySql: false,
    nestedAnalysis: true,
    formalForeignKeys: false,
    estimatedRowCounts: true,
  });

  private readonly connectionId: string;
  private readonly connection: KtxMongoDbConnectionConfig;
  private readonly url: string;
  private readonly databases: string[];
  private readonly sampleSize: number;
  private readonly orderBy: string;
  private readonly enabledTables: ReadonlySet<string> | null;
  private readonly clientFactory: KtxMongoClientFactory;
  private readonly now: () => Date;
  private readonly dialect = getDialectForDriver('mongodb');
  private client: KtxMongoClient | null = null;

  constructor(options: KtxMongoDbScanConnectorOptions) {
    const connection = options.connection ?? {};
    const inputDriver = connection.driver ?? 'unknown';
    if (!isKtxMongoDbConnectionConfig(connection)) {
      throw new Error(`Native MongoDB connector cannot run driver "${inputDriver}"`);
    }
    const env = options.env ?? process.env;
    const url = resolveKtxConfigReference(
      typeof connection.url === 'string' ? connection.url.trim() : undefined,
      env,
    );
    if (!url) {
      throw new Error(`Native MongoDB connector requires connections.${options.connectionId}.url`);
    }
    const databases = configuredDatabases(connection, databaseFromUrl(url));
    if (databases.length === 0) {
      throw new Error(
        `Native MongoDB connector requires connections.${options.connectionId}.databases (or a database in the URL)`,
      );
    }
    const enabledTables = Array.isArray(connection.enabled_tables)
      ? new Set(
          connection.enabled_tables
            .filter((table): table is string => typeof table === 'string' && table.trim().length > 0)
            .map((table) => table.trim()),
        )
      : null;

    this.connectionId = options.connectionId;
    this.connection = connection;
    this.url = url;
    this.databases = databases;
    this.sampleSize = positiveInteger(connection.sample_size, DEFAULT_SAMPLE_SIZE);
    this.orderBy = typeof connection.order_by === 'string' && connection.order_by.trim().length > 0
      ? connection.order_by.trim()
      : MONGO_ID_FIELD;
    this.enabledTables = enabledTables && enabledTables.size > 0 ? enabledTables : null;
    this.clientFactory = options.clientFactory ?? new DefaultMongoClientFactory();
    this.now = options.now ?? (() => new Date());
    this.id = `mongodb:${options.connectionId}`;
  }

  async testConnection(): Promise<KtxConnectorTestResult> {
    try {
      await this.clientForQuery().ping(this.databases[0]!);
      return { success: true };
    } catch (error) {
      return connectorTestFailure(error);
    }
  }

  async introspect(input: KtxScanInput, _ctx: KtxScanContext): Promise<KtxSchemaSnapshot> {
    this.assertConnection(input.connectionId);
    const client = this.clientForQuery();
    const tables: KtxSchemaTable[] = [];

    for (const database of this.databases) {
      const scopedNames = input.tableScope
        ? new Set(scopedTableNames(input.tableScope, { catalog: null, db: database }))
        : null;
      const collections = await client.listCollections(database);
      for (const collection of collections) {
        if (collection.name.startsWith('system.')) {
          continue;
        }
        if (scopedNames && !scopedNames.has(collection.name)) {
          continue;
        }
        if (this.enabledTables && !this.enabledTables.has(`${database}.${collection.name}`)) {
          continue;
        }
        tables.push(await this.introspectCollection(client, database, collection));
      }
    }

    return {
      connectionId: this.connectionId,
      driver: 'mongodb',
      extractedAt: this.now().toISOString(),
      scope: { schemas: this.databases },
      metadata: {
        databases: this.databases,
        sample_size: this.sampleSize,
        order_by: this.orderBy,
        table_count: tables.length,
        total_columns: tables.reduce((sum, table) => sum + table.columns.length, 0),
      },
      tables,
    };
  }

  private async introspectCollection(
    client: KtxMongoClient,
    database: string,
    collection: KtxMongoListedCollection,
  ): Promise<KtxSchemaTable> {
    const isView = collection.type === 'view';
    // estimatedDocumentCount issues a count command, which MongoDB rejects on a
    // view (CommandNotSupportedOnView); only count real collections.
    const estimatedRows = isView ? null : await client.estimatedDocumentCount(database, collection.name);
    const documents = await client.find(database, collection.name, {
      sort: { [this.orderBy]: -1 },
      limit: this.sampleSize,
    });
    return {
      catalog: null,
      db: database,
      name: collection.name,
      kind: isView ? 'view' : 'table',
      comment: null,
      estimatedRows,
      columns: inferKtxMongoCollectionColumns(documents, this.dialect),
      foreignKeys: [],
    };
  }

  async sampleTable(input: KtxTableSampleInput, _ctx: KtxScanContext): Promise<KtxTableSampleResult> {
    this.assertConnection(input.connectionId);
    const { database, collection } = this.resolveTableRef(input.table);
    const documents = await this.clientForQuery().find(database, collection, {
      sort: { [this.orderBy]: -1 },
      limit: input.limit,
    });
    const headers = input.columns && input.columns.length > 0 ? input.columns : unionDocumentKeys(documents);
    const rows = documents.map((document) => headers.map((header) => normalizeSampleValue(document[header])));
    return { headers, rows, totalRows: documents.length };
  }

  async sampleColumn(input: KtxColumnSampleInput, _ctx: KtxScanContext): Promise<KtxColumnSampleResult> {
    this.assertConnection(input.connectionId);
    const { database, collection } = this.resolveTableRef(input.table);
    const documents = await this.clientForQuery().find(database, collection, {
      sort: { [this.orderBy]: -1 },
      limit: input.limit,
      projection: { [input.column]: 1 },
    });
    const values: unknown[] = [];
    let nullCount = 0;
    for (const document of documents) {
      const value = document[input.column];
      if (value === null || value === undefined) {
        nullCount += 1;
        continue;
      }
      values.push(normalizeSampleValue(value));
    }
    return { values, nullCount, distinctCount: null };
  }

  async listSchemas(): Promise<string[]> {
    return [...this.databases];
  }

  async listTables(schemas?: string[]): Promise<KtxTableListEntry[]> {
    const client = this.clientForQuery();
    const databases = schemas && schemas.length > 0 ? schemas : this.databases;
    const entries: KtxTableListEntry[] = [];
    for (const database of databases) {
      const collections = await client.listCollections(database);
      for (const collection of collections) {
        if (collection.name.startsWith('system.')) {
          continue;
        }
        entries.push({
          catalog: null,
          schema: database,
          name: collection.name,
          kind: collection.type === 'view' ? 'view' : 'table',
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

  private resolveTableRef(table: KtxTableRef): { database: string; collection: string } {
    return { database: table.db ?? this.databases[0]!, collection: table.name };
  }

  private clientForQuery(): KtxMongoClient {
    if (!this.client) {
      this.client = this.clientFactory.create(this.url);
    }
    return this.client;
  }

  private assertConnection(connectionId: string): void {
    if (connectionId !== this.connectionId) {
      throw new Error(`ktx MongoDB connector ${this.id} cannot serve connection ${connectionId}`);
    }
  }
}
