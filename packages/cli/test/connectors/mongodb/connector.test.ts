import { describe, expect, it, vi } from 'vitest';
import {
  isKtxMongoDbConnectionConfig,
  KtxMongoDbScanConnector,
  type KtxMongoClient,
  type KtxMongoClientFactory,
  type KtxMongoDbConnectionConfig,
  type KtxMongoListedCollection,
} from '../../../src/connectors/mongodb/connector.js';
import { createMongoDbLiveDatabaseIntrospection } from '../../../src/connectors/mongodb/live-database-introspection.js';
import { executeProjectReadOnlySql } from '../../../src/context/connections/project-sql-executor.js';
import { tableRefSet } from '../../../src/context/scan/table-ref.js';
import type { KtxLocalProject } from '../../../src/context/project/project.js';
import type { KtxMongoDocument } from '../../../src/connectors/mongodb/schema-inference.js';

function objectId(hex: string): unknown {
  return { _bsontype: 'ObjectId', toString: () => hex };
}

const COLLECTIONS: Record<string, KtxMongoListedCollection[]> = {
  app: [
    { name: 'users' },
    { name: 'orders' },
    { name: 'system.views' },
  ],
};

const DOCUMENTS: Record<string, KtxMongoDocument[]> = {
  users: [
    { _id: objectId('a1'), email: 'a@x.com', age: 31, address: { city: 'NY' } },
    { _id: objectId('a2'), email: 'b@x.com' },
  ],
  orders: [{ _id: objectId('b1'), total: 9.99 }],
};

function fakeClientFactory(): { factory: KtxMongoClientFactory; client: KtxMongoClient } {
  const client: KtxMongoClient = {
    listCollections: vi.fn(async (databaseName: string) => COLLECTIONS[databaseName] ?? []),
    estimatedDocumentCount: vi.fn(async (_databaseName: string, collectionName: string) =>
      collectionName === 'users' ? 2 : 1,
    ),
    find: vi.fn(async (_databaseName: string, collectionName: string) => DOCUMENTS[collectionName] ?? []),
    ping: vi.fn(async () => undefined),
    close: vi.fn(async () => undefined),
  };
  return { factory: { create: vi.fn(() => client) }, client };
}

function connector(connection: KtxMongoDbConnectionConfig, factory: KtxMongoClientFactory): KtxMongoDbScanConnector {
  return new KtxMongoDbScanConnector({ connectionId: 'mongo-prod', connection, clientFactory: factory });
}

const baseConnection: KtxMongoDbConnectionConfig = {
  driver: 'mongodb',
  url: 'mongodb://localhost:27017/app',
  databases: ['app'],
};

describe('isKtxMongoDbConnectionConfig', () => {
  it('matches only the mongodb driver', () => {
    expect(isKtxMongoDbConnectionConfig({ driver: 'mongodb' })).toBe(true);
    expect(isKtxMongoDbConnectionConfig({ driver: 'postgres' })).toBe(false);
    expect(isKtxMongoDbConnectionConfig(undefined)).toBe(false);
  });
});

describe('KtxMongoDbScanConnector capabilities', () => {
  it('advertises a non-SQL, sampling-capable source and exposes no SQL execution', () => {
    const { factory } = fakeClientFactory();
    const c = connector(baseConnection, factory);
    expect(c.driver).toBe('mongodb');
    expect(c.capabilities.readOnlySql).toBe(false);
    expect(c.capabilities.formalForeignKeys).toBe(false);
    expect(c.capabilities.tableSampling).toBe(true);
    expect(c.capabilities.columnSampling).toBe(true);
    expect(c.capabilities.nestedAnalysis).toBe(true);
    expect('executeReadOnly' in c).toBe(false);
  });
});

describe('KtxMongoDbScanConnector construction', () => {
  it('requires a url', () => {
    const { factory } = fakeClientFactory();
    expect(() => connector({ driver: 'mongodb', databases: ['app'] }, factory)).toThrow(/requires connections\.mongo-prod\.url/);
  });

  it('resolves env: url references and derives the database from the url path', () => {
    const { factory, client } = fakeClientFactory();
    const c = new KtxMongoDbScanConnector({
      connectionId: 'mongo-prod',
      connection: { driver: 'mongodb', url: 'env:MONGO_URL' },
      clientFactory: factory,
      env: { MONGO_URL: 'mongodb://localhost:27017/app' },
    });
    return c.introspect({ connectionId: 'mongo-prod', driver: 'mongodb' }, { runId: 't' }).then((snapshot) => {
      expect(snapshot.scope.schemas).toEqual(['app']);
      expect(client.listCollections).toHaveBeenCalledWith('app');
    });
  });

  it('refuses a non-mongodb driver', () => {
    const { factory } = fakeClientFactory();
    expect(() => connector({ driver: 'postgres' } as KtxMongoDbConnectionConfig, factory)).toThrow(/cannot run driver "postgres"/);
  });
});

describe('KtxMongoDbScanConnector.introspect', () => {
  it('maps collections to tables, infers columns, and excludes system collections', async () => {
    const { factory } = fakeClientFactory();
    const snapshot = await connector(baseConnection, factory).introspect(
      { connectionId: 'mongo-prod', driver: 'mongodb' },
      { runId: 't' },
    );

    expect(snapshot.driver).toBe('mongodb');
    expect(snapshot.tables.map((table) => table.name).sort()).toEqual(['orders', 'users']);

    const users = snapshot.tables.find((table) => table.name === 'users')!;
    expect(users.db).toBe('app');
    expect(users.estimatedRows).toBe(2);
    expect(users.foreignKeys).toEqual([]);

    const idColumn = users.columns.find((column) => column.name === '_id')!;
    expect(idColumn.primaryKey).toBe(true);
    expect(idColumn.nullable).toBe(false);

    const email = users.columns.find((column) => column.name === 'email')!;
    expect(email.nullable).toBe(false); // present in every sampled document

    const age = users.columns.find((column) => column.name === 'age')!;
    expect(age.nullable).toBe(true); // missing from the second document

    const address = users.columns.find((column) => column.name === 'address')!;
    expect(address.normalizedType).toBe('json');
  });

  it('honors the enabled_tables allowlist', async () => {
    const { factory } = fakeClientFactory();
    const snapshot = await connector(
      { ...baseConnection, enabled_tables: ['app.users'] },
      factory,
    ).introspect({ connectionId: 'mongo-prod', driver: 'mongodb' }, { runId: 't' });
    expect(snapshot.tables.map((table) => table.name)).toEqual(['users']);
  });

  it('restricts introspection to input.tableScope (the scan layer does not post-filter)', async () => {
    const { factory } = fakeClientFactory();
    const snapshot = await connector(baseConnection, factory).introspect(
      {
        connectionId: 'mongo-prod',
        driver: 'mongodb',
        tableScope: tableRefSet([{ catalog: null, db: 'app', name: 'users' }]),
      },
      { runId: 't' },
    );
    expect(snapshot.tables.map((table) => table.name)).toEqual(['users']);
  });

  it('yields zero tables for a database whose scoped set is empty', async () => {
    const { factory } = fakeClientFactory();
    const snapshot = await connector(baseConnection, factory).introspect(
      {
        connectionId: 'mongo-prod',
        driver: 'mongodb',
        tableScope: tableRefSet([{ catalog: null, db: 'other', name: 'users' }]),
      },
      { runId: 't' },
    );
    expect(snapshot.tables).toEqual([]);
  });

  it('does not count documents on a view (estimatedDocumentCount fails on views)', async () => {
    const collections: KtxMongoListedCollection[] = [
      { name: 'users' },
      { name: 'active_users', type: 'view' },
    ];
    const client: KtxMongoClient = {
      listCollections: vi.fn(async () => collections),
      // Real MongoDB rejects a count command on a view with CommandNotSupportedOnView.
      estimatedDocumentCount: vi.fn(async (_db: string, name: string) => {
        if (name === 'active_users') {
          throw new Error('CommandNotSupportedOnView: count is not supported on a view');
        }
        return 2;
      }),
      find: vi.fn(async (_db: string, name: string) => DOCUMENTS[name] ?? DOCUMENTS.users!),
      ping: vi.fn(async () => undefined),
      close: vi.fn(async () => undefined),
    };
    const snapshot = await connector(baseConnection, { create: vi.fn(() => client) }).introspect(
      { connectionId: 'mongo-prod', driver: 'mongodb' },
      { runId: 't' },
    );
    const view = snapshot.tables.find((table) => table.name === 'active_users')!;
    expect(view.kind).toBe('view');
    expect(view.estimatedRows).toBeNull();
    expect(client.estimatedDocumentCount).not.toHaveBeenCalledWith('app', 'active_users');
  });
});

describe('KtxMongoDbScanConnector sampling', () => {
  it('samples a column, flattening nested values and counting nulls over the window', async () => {
    const { factory } = fakeClientFactory();
    const result = await connector(baseConnection, factory).sampleColumn(
      { connectionId: 'mongo-prod', table: { catalog: null, db: 'app', name: 'users' }, column: 'address', limit: 10 },
      { runId: 't' },
    );
    expect(result.values).toEqual([JSON.stringify({ city: 'NY' })]);
    // address is present in the first sampled document and absent from the second
    expect(result.nullCount).toBe(1);
  });
});

describe('createMongoDbLiveDatabaseIntrospection', () => {
  it('extracts a schema through the live-database port', async () => {
    const { factory } = fakeClientFactory();
    const port = createMongoDbLiveDatabaseIntrospection({
      connections: {
        'mongo-prod': { driver: 'mongodb', url: 'mongodb://localhost:27017/app', databases: ['app'] },
      },
      clientFactory: factory,
    });
    const snapshot = await port.extractSchema('mongo-prod');
    expect(snapshot.driver).toBe('mongodb');
    expect(snapshot.tables.length).toBe(2);
  });
});

describe('ktx sql against a MongoDB connection', () => {
  it('is rejected by the read-only SQL capability gate', async () => {
    const { factory } = fakeClientFactory();
    const project = { config: { connections: {} }, projectDir: '/tmp' } as unknown as KtxLocalProject;
    await expect(
      executeProjectReadOnlySql({
        project,
        input: { connectionId: 'mongo-prod', connection: undefined, sql: 'SELECT 1', maxRows: 1 },
        createConnector: () => connector(baseConnection, factory),
      }),
    ).rejects.toThrow(/does not support read-only SQL execution/);
  });
});
