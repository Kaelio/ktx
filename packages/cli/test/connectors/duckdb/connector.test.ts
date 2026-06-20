import { DuckDBInstance } from '@duckdb/node-api';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import {
  KtxDuckDbScanConnector,
  duckDbDatabasePathFromConfig,
  isKtxDuckDbConnectionConfig,
} from '../../../src/connectors/duckdb/connector.js';

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
    expect(names).toEqual(['customers', 'orders']);
    const orders = snapshot.tables.find((t) => t.name === 'orders');
    expect(orders?.foreignKeys[0]).toMatchObject({ fromColumn: 'customer_id', toTable: 'customers', toColumn: 'id' });
    await c.cleanup();
  });

  it('lists tables', async () => {
    const c = connector();
    const tables = (await c.listTables()).map((t) => t.name).sort();
    expect(tables).toEqual(['customers', 'orders']);
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
});
