import { DuckDBInstance } from '@duckdb/node-api';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import {
  KtxDuckDbScanConnector,
  duckDbDatabasePathFromConfig,
  isKtxDuckDbConnectionConfig,
} from '../../../src/connectors/duckdb/connector.js';
import { tableRefSet } from '../../../src/context/scan/table-ref.js';

let dir: string;
let dbPath: string;

beforeAll(async () => {
  dir = await mkdtemp(join(tmpdir(), 'ktx-duckdb-'));
  dbPath = join(dir, 'warehouse.duckdb');
  const instance = await DuckDBInstance.create(dbPath);
  const connection = await instance.connect();
  await connection.run('CREATE TABLE customers (id BIGINT PRIMARY KEY, name VARCHAR, big BIGINT)');
  await connection.run(
    `INSERT INTO customers VALUES (1, 'Ada', 9223372036854775807), (2, 'Lin', 10)`,
  );
  await connection.run('CREATE TABLE orders (id BIGINT, customer_id BIGINT REFERENCES customers(id))');
  await connection.run('INSERT INTO orders VALUES (1, 1), (2, 2)');
  // Composite primary key + composite foreign key, to exercise the parallel
  // unnest() zip of constraint/referenced column names in readForeignKeys.
  await connection.run('CREATE TABLE regions (country VARCHAR, code VARCHAR, PRIMARY KEY (country, code))');
  await connection.run(
    'CREATE TABLE stores (id BIGINT, country VARCHAR, code VARCHAR, FOREIGN KEY (country, code) REFERENCES regions(country, code))',
  );
  await connection.run('CREATE TABLE empty_table (id BIGINT)');
  connection.closeSync();
  instance.closeSync();
});

afterAll(async () => {
  await rm(dir, { recursive: true, force: true });
});

function connector(connection: Record<string, unknown> = { driver: 'duckdb', path: dbPath }) {
  return new KtxDuckDbScanConnector({ connectionId: 'warehouse', connection, projectDir: dir });
}

describe('isKtxDuckDbConnectionConfig', () => {
  it('accepts duckdb driver, rejects others', () => {
    expect(isKtxDuckDbConnectionConfig({ driver: 'duckdb' })).toBe(true);
    expect(isKtxDuckDbConnectionConfig({ driver: 'sqlite' })).toBe(false);
  });
});

describe('duckDbDatabasePathFromConfig', () => {
  it('resolves a relative path against projectDir', () => {
    const resolved = duckDbDatabasePathFromConfig({
      connectionId: 'warehouse',
      projectDir: dir,
      connection: { driver: 'duckdb', path: 'warehouse.duckdb' },
    });
    expect(resolved).toBe(dbPath);
  });

  it('derives the path from a file: url', () => {
    const resolved = duckDbDatabasePathFromConfig({
      connectionId: 'warehouse',
      connection: { driver: 'duckdb', url: pathToFileURL(dbPath).href },
    });
    expect(resolved).toBe(dbPath);
  });

  it('derives the path from a duckdb: url', () => {
    const resolved = duckDbDatabasePathFromConfig({
      connectionId: 'warehouse',
      connection: { driver: 'duckdb', url: `duckdb://${dbPath}` },
    });
    expect(resolved).toBe(dbPath);
  });

  it('resolves an env: reference in path', () => {
    process.env.KTX_TEST_DUCKDB_PATH = dbPath;
    try {
      const resolved = duckDbDatabasePathFromConfig({
        connectionId: 'warehouse',
        connection: { driver: 'duckdb', path: 'env:KTX_TEST_DUCKDB_PATH' },
      });
      expect(resolved).toBe(dbPath);
    } finally {
      delete process.env.KTX_TEST_DUCKDB_PATH;
    }
  });

  it('rejects a non-duckdb driver', () => {
    expect(() =>
      duckDbDatabasePathFromConfig({
        connectionId: 'warehouse',
        connection: { driver: 'sqlite', path: dbPath },
      }),
    ).toThrow(/cannot run driver "sqlite"/);
  });

  it('requires a path or url', () => {
    expect(() =>
      duckDbDatabasePathFromConfig({
        connectionId: 'warehouse',
        connection: { driver: 'duckdb' },
      }),
    ).toThrow(/requires connections\.warehouse\.path or url/);
  });
});

describe('KtxDuckDbScanConnector', () => {
  it('testConnection succeeds for an existing file', async () => {
    const c = connector();
    expect(await c.testConnection()).toEqual({ success: true });
    await c.cleanup();
  });

  it('testConnection fails (never creating) for a missing file', async () => {
    const c = connector({ driver: 'duckdb', path: join(dir, 'absent.duckdb') });
    const result = await c.testConnection();
    expect(result.success).toBe(false);
    await c.cleanup();
  });

  it('introspects main-schema tables, columns, and foreign keys', async () => {
    const c = connector();
    const snapshot = await c.introspect({ connectionId: 'warehouse', driver: 'duckdb' }, { runId: 't' });
    const names = snapshot.tables.map((t) => t.name).sort();
    expect(names).toEqual(['customers', 'empty_table', 'orders', 'regions', 'stores']);
    const orders = snapshot.tables.find((t) => t.name === 'orders');
    expect(orders?.foreignKeys[0]).toMatchObject({ fromColumn: 'customer_id', toTable: 'customers', toColumn: 'id' });
    await c.cleanup();
  });

  it('maps a composite foreign key column-for-column to the referenced table', async () => {
    const c = connector();
    const snapshot = await c.introspect({ connectionId: 'warehouse', driver: 'duckdb' }, { runId: 't' });
    const stores = snapshot.tables.find((t) => t.name === 'stores');
    const fks = stores?.foreignKeys.map((fk) => ({ fromColumn: fk.fromColumn, toTable: fk.toTable, toColumn: fk.toColumn }));
    expect(fks).toEqual([
      { fromColumn: 'country', toTable: 'regions', toColumn: 'country' },
      { fromColumn: 'code', toTable: 'regions', toColumn: 'code' },
    ]);
    await c.cleanup();
  });

  it('lists tables', async () => {
    const c = connector();
    const tables = (await c.listTables()).map((t) => t.name).sort();
    expect(tables).toEqual(['customers', 'empty_table', 'orders', 'regions', 'stores']);
    await c.cleanup();
  });

  it('samples a table', async () => {
    const c = connector();
    const sample = await c.sampleTable(
      { connectionId: 'warehouse', table: { name: 'customers', catalog: null, db: null }, limit: 1 },
      { runId: 't' },
    );
    expect(sample.rows.length).toBe(1);
    await c.cleanup();
  });

  it('stringifies BIGINT beyond 2^53 in read-only results', async () => {
    const c = connector();
    const result = await c.executeReadOnly(
      { connectionId: 'warehouse', sql: 'SELECT big FROM customers WHERE id = 1', maxRows: 10 },
      { runId: 't' },
    );
    expect(result.rows[0][0]).toBe('9223372036854775807');
    await c.cleanup();
  });

  it('rejects non-read-only SQL', async () => {
    const c = connector();
    await expect(
      c.executeReadOnly({ connectionId: 'warehouse', sql: 'DELETE FROM customers', maxRows: 10 }, { runId: 't' }),
    ).rejects.toThrow();
    await c.cleanup();
  });

  it('returns distinct values under the cardinality cap', async () => {
    const c = connector();
    const distinct = await c.getColumnDistinctValues({ name: 'customers', catalog: null, db: null }, 'name', {
      maxCardinality: 10,
      limit: 10,
    });
    expect(distinct?.values?.sort()).toEqual(['Ada', 'Lin']);
    await c.cleanup();
  });

  it('withholds values but reports the count when cardinality exceeds the cap', async () => {
    const c = connector();
    const distinct = await c.getColumnDistinctValues({ name: 'customers', catalog: null, db: null }, 'name', {
      maxCardinality: 1,
      limit: 10,
    });
    expect(distinct).toEqual({ values: null, cardinality: 2 });
    await c.cleanup();
  });

  it('samples a single column, dropping null rows', async () => {
    const c = connector();
    const sample = await c.sampleColumn(
      { connectionId: 'warehouse', table: { name: 'customers', catalog: null, db: null }, column: 'name', limit: 10 },
      { runId: 't' },
    );
    expect(sample.values.sort()).toEqual(['Ada', 'Lin']);
    expect(sample.nullCount).toBeNull();
    await c.cleanup();
  });

  it('counts table rows', async () => {
    const c = connector();
    expect(await c.getTableRowCount('customers')).toBe(2);
    await c.cleanup();
  });

  it('lists only the main schema and reports no column stats', async () => {
    const c = connector();
    expect(await c.listSchemas()).toEqual(['main']);
    expect(await c.columnStats({ connectionId: 'warehouse', table: { name: 'customers', catalog: null, db: null }, column: 'id' }, { runId: 't' })).toBeNull();
    await c.cleanup();
  });

  it('rejects operations for a mismatched connection id', async () => {
    const c = connector();
    await expect(
      c.executeReadOnly({ connectionId: 'other', sql: 'SELECT 1', maxRows: 1 }, { runId: 't' }),
    ).rejects.toThrow(/cannot serve connection other/);
    await c.cleanup();
  });

  it('exposes the dialect identifier quoting', () => {
    expect(connector().quoteIdentifier('a"b')).toBe('"a""b"');
  });

  // Opening a connection must never create the file: the db() guard throws
  // rather than letting DuckDBInstance.create() materialize a missing path.
  it('refuses to open (never creating) a missing file when a query runs', async () => {
    const c = connector({ driver: 'duckdb', path: join(dir, 'absent.duckdb') });
    await expect(c.listTables()).rejects.toThrow(/File not found/);
    await c.cleanup();
  });

  it('returns no tables for an empty table scope', async () => {
    const c = connector();
    const snapshot = await c.introspect(
      { connectionId: 'warehouse', driver: 'duckdb', tableScope: new Set() },
      { runId: 't' },
    );
    expect(snapshot.tables).toEqual([]);
    await c.cleanup();
  });

  it('restricts introspection to the named tables in a non-empty scope', async () => {
    const c = connector();
    const snapshot = await c.introspect(
      {
        connectionId: 'warehouse',
        driver: 'duckdb',
        tableScope: tableRefSet([{ catalog: null, db: null, name: 'customers' }]),
      },
      { runId: 't' },
    );
    expect(snapshot.tables.map((t) => t.name)).toEqual(['customers']);
    await c.cleanup();
  });

  it('reports zero cardinality and an empty value list for an empty column', async () => {
    const c = connector();
    const distinct = await c.getColumnDistinctValues({ name: 'empty_table', catalog: null, db: null }, 'id', {
      maxCardinality: 10,
      limit: 10,
    });
    expect(distinct).toEqual({ values: [], cardinality: 0 });
    await c.cleanup();
  });
});
