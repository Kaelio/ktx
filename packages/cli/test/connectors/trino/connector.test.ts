import { describe, expect, it, vi } from 'vitest';
import {
  isKtxTrinoConnectionConfig,
  KtxTrinoScanConnector,
  trinoClientConfigFromConfig,
  type KtxTrinoClient,
  type KtxTrinoClientFactory,
  type KtxTrinoConnectionConfig,
  type KtxTrinoQueryResult,
} from '../../../src/connectors/trino/connector.js';
import { tableRefSet } from '../../../src/context/scan/table-ref.js';
import type { KtxScanContext } from '../../../src/context/scan/types.js';

const ctx: KtxScanContext = { runId: 'test-run' };

function column(name: string, type = 'varchar'): { name: string; type: string } {
  return { name, type };
}

/**
 * Fake Trino client that answers each query shape the connector issues by
 * matching on the SQL it generates. Returns the normalized
 * {@link KtxTrinoQueryResult} (columns + rows) the real HTTP client would.
 */
function fakeClientFactory(): KtxTrinoClientFactory {
  const query = vi.fn(async (sql: string): Promise<KtxTrinoQueryResult> => {
    if (sql.trim() === 'SELECT 1') {
      return { columns: [column('_col0', 'integer')], rows: [[1]] };
    }
    if (sql.includes('system.metadata.catalogs')) {
      // `system` and `tpch` are filtered out by SYSTEM_CATALOGS.
      return {
        columns: [column('catalog_name')],
        rows: [['hive'], ['system'], ['tpch']],
      };
    }
    if (sql.includes('information_schema.schemata')) {
      return { columns: [column('schema_name')], rows: [['analytics']] };
    }
    if (sql.includes('information_schema.tables')) {
      return {
        columns: [column('table_catalog'), column('table_schema'), column('table_name'), column('table_type')],
        rows: [
          ['hive', 'analytics', 'orders', 'BASE TABLE'],
          ['hive', 'analytics', 'order_summary', 'VIEW'],
        ],
      };
    }
    if (sql.includes('information_schema.columns')) {
      return {
        columns: [
          column('table_catalog'),
          column('table_schema'),
          column('table_name'),
          column('column_name'),
          column('data_type'),
          column('is_nullable'),
          column('comment'),
        ],
        rows: [
          ['hive', 'analytics', 'orders', 'id', 'bigint', 'NO', 'Primary key'],
          ['hive', 'analytics', 'orders', 'status', 'varchar', 'YES', null],
          ['hive', 'analytics', 'order_summary', 'status', 'varchar', 'YES', null],
        ],
      };
    }
    if (sql.includes('FROM "hive"."analytics"."orders"') && sql.includes('"id"')) {
      return { columns: [column('id', 'bigint'), column('status')], rows: [[1, 'paid']] };
    }
    if (sql.includes('FROM "hive"."analytics"."orders"')) {
      return { columns: [column('status')], rows: [['paid'], ['open']] };
    }
    if (sql.includes('SELECT id, status FROM orders')) {
      return { columns: [column('id', 'bigint'), column('status')], rows: [[1, 'paid']] };
    }
    throw new Error(`Unexpected SQL: ${sql}`);
  });

  const client: KtxTrinoClient = { query, close: vi.fn(async () => undefined) };
  return { createClient: () => client };
}

function connector(connection: Partial<KtxTrinoConnectionConfig> = {}): KtxTrinoScanConnector {
  return new KtxTrinoScanConnector({
    connectionId: 'trino-warehouse',
    connection: { driver: 'trino', host: 'trino.example.com', port: 8080, user: 'analyst', ...connection },
    clientFactory: fakeClientFactory(),
  });
}

describe('isKtxTrinoConnectionConfig', () => {
  it('accepts trino configs case-insensitively and rejects others', () => {
    expect(isKtxTrinoConnectionConfig({ driver: 'trino' })).toBe(true);
    expect(isKtxTrinoConnectionConfig({ driver: 'Trino' })).toBe(true);
    expect(isKtxTrinoConnectionConfig({ driver: 'snowflake' })).toBe(false);
    expect(isKtxTrinoConnectionConfig(undefined)).toBe(false);
  });
});

describe('trinoClientConfigFromConfig', () => {
  it('builds an http server URL from host/port and requires a user', () => {
    const config = trinoClientConfigFromConfig({
      connectionId: 'trino-warehouse',
      connection: { driver: 'trino', host: 'trino.example.com', port: 8080, user: 'analyst' },
    });
    expect(config.server).toBe('http://trino.example.com:8080');
    expect(config.user).toBe('analyst');
    expect(config.ssl).toBe(false);
  });

  it('derives ssl from an https url', () => {
    const config = trinoClientConfigFromConfig({
      connectionId: 'trino-warehouse',
      connection: { driver: 'trino', url: 'https://trino.example.com:8443', user: 'analyst' },
    });
    expect(config.server).toBe('https://trino.example.com:8443');
    expect(config.ssl).toBe(true);
  });

  it('throws when no user is provided', () => {
    expect(() =>
      trinoClientConfigFromConfig({
        connectionId: 'trino-warehouse',
        connection: { driver: 'trino', host: 'trino.example.com' },
      }),
    ).toThrow(/requires connections.trino-warehouse.user/);
  });
});

describe('KtxTrinoScanConnector', () => {
  it('introspects every non-system catalog into catalog-qualified tables', async () => {
    const snapshot = await connector().introspect({ connectionId: 'trino-warehouse', driver: 'trino' }, ctx);

    expect(snapshot.driver).toBe('trino');
    expect(snapshot.scope.catalogs).toEqual(['hive']);
    expect(snapshot.tables).toHaveLength(2);

    const orders = snapshot.tables.find((table) => table.name === 'orders');
    expect(orders).toMatchObject({ catalog: 'hive', db: 'analytics', kind: 'table' });
    expect(orders?.columns.map((c) => c.name)).toEqual(['id', 'status']);
    expect(orders?.columns[0]).toMatchObject({ nativeType: 'bigint', dimensionType: 'number', nullable: false });
    expect(orders?.columns[1]).toMatchObject({ dimensionType: 'string', nullable: true });

    const view = snapshot.tables.find((table) => table.name === 'order_summary');
    expect(view?.kind).toBe('view');
  });

  it('honors an explicit catalogs allowlist without querying system.metadata.catalogs', async () => {
    const snapshot = await connector({ catalogs: ['hive'] }).introspect(
      { connectionId: 'trino-warehouse', driver: 'trino' },
      ctx,
    );
    expect(snapshot.scope.catalogs).toEqual(['hive']);
  });

  it('restricts introspection to tableScope', async () => {
    const tableScope = tableRefSet([{ catalog: 'hive', db: 'analytics', name: 'orders' }]);
    const snapshot = await connector().introspect(
      { connectionId: 'trino-warehouse', driver: 'trino', tableScope },
      ctx,
    );
    expect(snapshot.tables.map((table) => table.name)).toEqual(['orders']);
  });

  it('namespaces schemas and tables by catalog', async () => {
    const conn = connector();
    expect(await conn.listSchemas()).toEqual(['hive.analytics']);
    const tables = await conn.listTables();
    expect(tables).toContainEqual({ catalog: 'hive', schema: 'analytics', name: 'orders', kind: 'table' });
  });

  it('samples tables and columns', async () => {
    const conn = connector();
    const table = await conn.sampleTable(
      { connectionId: 'trino-warehouse', table: { catalog: 'hive', db: 'analytics', name: 'orders' }, columns: ['id', 'status'], limit: 5 },
      ctx,
    );
    expect(table.headers).toEqual(['id', 'status']);
    expect(table.rows).toEqual([[1, 'paid']]);

    const col = await conn.sampleColumn(
      { connectionId: 'trino-warehouse', table: { catalog: 'hive', db: 'analytics', name: 'orders' }, column: 'status', limit: 10 },
      ctx,
    );
    expect(col.values).toEqual(['paid', 'open']);
  });

  it('executes read-only SQL and rejects mutations', async () => {
    const conn = connector();
    const result = await conn.executeReadOnly({ connectionId: 'trino-warehouse', sql: 'SELECT id, status FROM orders' }, ctx);
    expect(result.rowCount).toBe(1);
    await expect(
      conn.executeReadOnly({ connectionId: 'trino-warehouse', sql: 'DELETE FROM orders' }, ctx),
    ).rejects.toThrow();
  });

  it('reports a successful connection test', async () => {
    expect(await connector().testConnection()).toEqual({ success: true });
  });
});
