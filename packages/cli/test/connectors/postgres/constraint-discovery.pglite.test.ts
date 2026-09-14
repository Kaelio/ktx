import { PGlite } from '@electric-sql/pglite';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { KtxPostgresScanConnector, type KtxPostgresPoolFactory } from '../../../src/connectors/postgres/connector.js';

function pglitePoolFactory(db: PGlite): KtxPostgresPoolFactory {
  return {
    createPool() {
      return {
        async connect() {
          return {
            async query(sql: string, params?: unknown[]) {
              const result = await db.query<Record<string, unknown>>(sql, params);
              return { rows: result.rows, fields: result.fields };
            },
            release() {},
          };
        },
        async end() {},
      };
    },
  };
}

function connectorFor(db: PGlite): KtxPostgresScanConnector {
  return new KtxPostgresScanConnector({
    connectionId: 'warehouse',
    connection: {
      driver: 'postgres',
      host: 'db.example.test',
      database: 'analytics',
      username: 'reader',
      password: 'test-password', // pragma: allowlist secret
      schema: 'public',
    },
    poolFactory: pglitePoolFactory(db),
  });
}

const EXPECTED_ORDER_FOREIGN_KEYS = [
  {
    fromColumn: 'customer_id',
    toCatalog: null,
    toDb: 'public',
    toTable: 'customers',
    toColumn: 'id',
    constraintName: 'orders_customer_id_fkey',
  },
  {
    fromColumn: 'region_code',
    toCatalog: null,
    toDb: 'public',
    toTable: 'regions',
    toColumn: 'code',
    constraintName: 'orders_region_code_region_country_fkey',
  },
  {
    fromColumn: 'region_country',
    toCatalog: null,
    toDb: 'public',
    toTable: 'regions',
    toColumn: 'country',
    constraintName: 'orders_region_code_region_country_fkey',
  },
];

describe('Postgres constraint discovery against a real catalog', () => {
  let db: PGlite;

  beforeAll(async () => {
    db = await PGlite.create();
    await db.exec(`
      CREATE TABLE customers (id integer PRIMARY KEY);
      CREATE TABLE regions (code text, country text, PRIMARY KEY (code, country));
      CREATE TABLE orders (
        id integer PRIMARY KEY,
        customer_id integer REFERENCES customers (id),
        region_code text,
        region_country text,
        FOREIGN KEY (region_code, region_country) REFERENCES regions (code, country)
      );
      CREATE ROLE ktx_reader;
      GRANT USAGE ON SCHEMA public TO ktx_reader;
      GRANT SELECT, INSERT, UPDATE, DELETE ON ALL TABLES IN SCHEMA public TO ktx_reader;
    `);
  }, 60_000);

  afterAll(async () => {
    await db.close();
  });

  it('reads declared foreign keys as the table owner', async () => {
    await db.exec('RESET ROLE');
    const snapshot = await connectorFor(db).introspect(
      { connectionId: 'warehouse', driver: 'postgres' },
      { runId: 'scan-run-owner' },
    );

    expect(snapshot.warnings).toEqual([]);
    expect(snapshot.tables.find((table) => table.name === 'orders')?.foreignKeys).toEqual(EXPECTED_ORDER_FOREIGN_KEYS);
  });

  it('reads declared foreign keys as a fully-granted role that owns no tables', async () => {
    await db.exec('SET ROLE ktx_reader');
    try {
      const snapshot = await connectorFor(db).introspect(
        { connectionId: 'warehouse', driver: 'postgres' },
        { runId: 'scan-run-non-owner' },
      );

      expect(snapshot.warnings).toEqual([]);
      const orders = snapshot.tables.find((table) => table.name === 'orders');
      expect(orders?.columns.find((column) => column.name === 'id')?.primaryKey).toBe(true);
      expect(orders?.foreignKeys).toEqual(EXPECTED_ORDER_FOREIGN_KEYS);
    } finally {
      await db.exec('RESET ROLE');
    }
  });
});
