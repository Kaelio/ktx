import { DuckDBInstance } from '@duckdb/node-api';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createDuckDbLiveDatabaseIntrospection } from '../../../src/connectors/duckdb/live-database-introspection.js';
import { tableRefSet } from '../../../src/context/scan/table-ref.js';

let dir: string;
let dbPath: string;

beforeAll(async () => {
  dir = await mkdtemp(join(tmpdir(), 'ktx-duckdb-live-'));
  dbPath = join(dir, 'warehouse.duckdb');
  const instance = await DuckDBInstance.create(dbPath);
  const connection = await instance.connect();
  await connection.run('CREATE TABLE customers (id BIGINT, name VARCHAR)');
  await connection.run('CREATE TABLE orders (id BIGINT)');
  connection.closeSync();
  instance.closeSync();
});

afterAll(async () => {
  await rm(dir, { recursive: true, force: true });
});

function port() {
  return createDuckDbLiveDatabaseIntrospection({
    projectDir: dir,
    connections: { warehouse: { driver: 'duckdb', path: dbPath } },
  });
}

describe('createDuckDbLiveDatabaseIntrospection', () => {
  it('extracts the full schema for a connection', async () => {
    const snapshot = await port().extractSchema('warehouse');
    expect(snapshot.tables.map((t) => t.name).sort()).toEqual(['customers', 'orders']);
  });

  it('restricts extraction to a table scope', async () => {
    const tableScope = tableRefSet([{ catalog: null, db: null, name: 'customers' }]);
    const snapshot = await port().extractSchema('warehouse', { tableScope });
    expect(snapshot.tables.map((t) => t.name)).toEqual(['customers']);
  });
});
