import { describe, expect, it, vi } from 'vitest';
import {
  databricksConnectionConfigFromConfig,
  isKtxDatabricksConnectionConfig,
  KtxDatabricksScanConnector,
  prepareDatabricksReadOnlyQuery,
  type KtxDatabricksDriver,
  type KtxDatabricksDriverFactory,
} from '../../../src/connectors/databricks/connector.js';
import { createDatabricksLiveDatabaseIntrospection } from '../../../src/connectors/databricks/live-database-introspection.js';
import { tableRefSet } from '../../../src/context/scan/table-ref.js';

function fakeDriverFactory(): KtxDatabricksDriverFactory {
  const driver: KtxDatabricksDriver = {
    test: vi.fn(async () => ({ success: true })),
    query: vi.fn(async (sql: string) => {
      if (sql.includes('TABLE_CONSTRAINTS')) {
        return { headers: ['TABLE_NAME', 'COLUMN_NAME'], rows: [['orders', 'id']], totalRows: 1, rowCount: 1 };
      }
      if (sql.includes('SELECT `id`, `status` FROM `main`.`sales`.`orders`')) {
        return { headers: ['id', 'status'], rows: [[1, 'paid']], totalRows: 1, rowCount: 1 };
      }
      if (sql.includes('select * from (select id, status from orders) as ktx_query_result limit 1')) {
        return { headers: ['id', 'status'], rows: [[1, 'paid']], totalRows: 1, rowCount: 1 };
      }
      if (sql.includes('SELECT `status` FROM `main`.`sales`.`orders`')) {
        return { headers: ['status'], rows: [['paid'], ['open']], totalRows: 2, rowCount: 2 };
      }
      if (sql.includes('APPROX_COUNT_DISTINCT(val)')) {
        return { headers: ['cardinality'], rows: [[2]], totalRows: 1, rowCount: 1 };
      }
      if (sql.includes('SELECT DISTINCT CAST(`status` AS STRING) AS val')) {
        return { headers: ['val'], rows: [['open'], ['paid']], totalRows: 2, rowCount: 2 };
      }
      throw new Error(`Unexpected SQL: ${sql}`);
    }),
    getSchemaMetadata: vi.fn(async () => [
      {
        name: 'orders',
        catalog: 'main',
        db: 'sales',
        kind: 'table' as const,
        rowCount: null,
        comment: 'Orders',
        columns: [
          { name: 'id', type: 'BIGINT', nullable: false, comment: 'Primary key' },
          { name: 'status', type: 'STRING', nullable: true, comment: null },
        ],
      },
      {
        name: 'order_summary',
        catalog: 'main',
        db: 'sales',
        kind: 'view' as const,
        rowCount: null,
        comment: null,
        columns: [{ name: 'status', type: 'STRING', nullable: true, comment: null }],
      },
    ]),
    listSchemas: vi.fn(async () => ['sales', 'finance']),
    listTables: vi.fn(async () => [
      { catalog: 'main', schema: 'sales', name: 'orders', kind: 'table' as const },
      { catalog: 'main', schema: 'sales', name: 'order_summary', kind: 'view' as const },
    ]),
    cleanup: vi.fn(async () => undefined),
  };
  return { createDriver: vi.fn(() => driver) };
}

describe('KtxDatabricksScanConnector', () => {
  it('rewrites named read-only SQL parameters to Databricks ordinal arrays', () => {
    expect(
      prepareDatabricksReadOnlyQuery('SELECT * FROM orders WHERE id = :id AND status = :status OR parent_id = :id', {
        status: 'paid',
        id: 1,
      }),
    ).toEqual({
      sql: 'SELECT * FROM orders WHERE id = ? AND status = ? OR parent_id = ?',
      params: [1, 'paid', 1],
    });
    expect(
      prepareDatabricksReadOnlyQuery("SELECT ':id' AS literal -- :status\nFROM orders WHERE id = :id", {
        id: 1,
      }),
    ).toEqual({
      sql: "SELECT ':id' AS literal -- :status\nFROM orders WHERE id = ?",
      params: [1],
    });
    expect(() =>
      prepareDatabricksReadOnlyQuery('SELECT * FROM orders WHERE id = ? AND status = ?', { id: 1, status: 'paid' }),
    ).toThrow('Databricks read-only SQL parameters must use named placeholders like :id');
    expect(() => prepareDatabricksReadOnlyQuery('SELECT * FROM orders WHERE id = :id', { id: 1, status: 'paid' })).toThrow(
      'Databricks read-only SQL received unused parameter(s): status',
    );
    expect(() => prepareDatabricksReadOnlyQuery('SELECT * FROM orders WHERE id = :id', { status: 'paid' })).toThrow(
      'Databricks read-only SQL parameter :id has no supplied value',
    );
    expect(prepareDatabricksReadOnlyQuery('SELECT * FROM orders WHERE id = ? AND status = ?')).toEqual({
      sql: 'SELECT * FROM orders WHERE id = ? AND status = ?',
      params: undefined,
    });
    expect(prepareDatabricksReadOnlyQuery('SELECT * FROM orders')).toEqual({
      sql: 'SELECT * FROM orders',
      params: undefined,
    });
  });

  it('resolves PAT and OAuth M2M connection configuration', () => {
    expect(isKtxDatabricksConnectionConfig({ driver: 'databricks' })).toBe(true);
    expect(isKtxDatabricksConnectionConfig({ driver: 'snowflake' })).toBe(false);
    expect(
      databricksConnectionConfigFromConfig({
        connectionId: 'warehouse',
        connection: {
          driver: 'databricks',
          authMethod: 'pat',
          server_hostname: 'dbc-example.cloud.databricks.com',
          http_path: '/sql/1.0/warehouses/abc',
          catalog: 'main',
          schema_name: 'sales',
          token: 'fixture-token', // pragma: allowlist secret
        },
      }),
    ).toMatchObject({
      authMethod: 'pat',
      serverHostname: 'dbc-example.cloud.databricks.com',
      httpPath: '/sql/1.0/warehouses/abc',
      catalog: 'main',
      schemas: ['sales'],
      token: 'fixture-token', // pragma: allowlist secret
    });
    expect(
      databricksConnectionConfigFromConfig({
        connectionId: 'warehouse',
        connection: {
          driver: 'databricks',
          authMethod: 'oauth-m2m',
          server_hostname: 'dbc-example.cloud.databricks.com',
          http_path: '/sql/1.0/warehouses/abc',
          catalog: 'main',
          client_id: 'client-id',
          client_secret: 'fixture-secret', // pragma: allowlist secret
        },
      }),
    ).toMatchObject({
      authMethod: 'oauth-m2m',
      clientId: 'client-id',
      clientSecret: 'fixture-secret', // pragma: allowlist secret
    });
  });

  it('introspects Unity Catalog schemas, primary keys, comments, and dimensions', async () => {
    const connector = new KtxDatabricksScanConnector({
      connectionId: 'warehouse',
      connection: {
        driver: 'databricks',
        server_hostname: 'dbc-example.cloud.databricks.com',
        http_path: '/sql/1.0/warehouses/abc',
        catalog: 'main',
        schema_name: 'sales',
        token: 'fixture-token', // pragma: allowlist secret
      },
      driverFactory: fakeDriverFactory(),
      now: () => new Date('2026-04-29T18:00:00.000Z'),
    });

    const snapshot = await connector.introspect(
      { connectionId: 'warehouse', driver: 'databricks' },
      { runId: 'scan-run-1' },
    );

    expect(snapshot).toMatchObject({
      connectionId: 'warehouse',
      driver: 'databricks',
      extractedAt: '2026-04-29T18:00:00.000Z',
      scope: { catalogs: ['main'], schemas: ['sales'] },
      metadata: {
        server_hostname: 'dbc-example.cloud.databricks.com',
        http_path: '/sql/1.0/warehouses/abc',
        catalog: 'main',
        schemas: ['sales'],
        table_count: 2,
        total_columns: 3,
      },
    });
    expect(snapshot.tables.find((table) => table.name === 'orders')?.columns).toEqual([
      {
        name: 'id',
        nativeType: 'BIGINT',
        normalizedType: 'BIGINT',
        dimensionType: 'number',
        nullable: false,
        primaryKey: true,
        comment: 'Primary key',
      },
      {
        name: 'status',
        nativeType: 'STRING',
        normalizedType: 'STRING',
        dimensionType: 'string',
        nullable: true,
        primaryKey: false,
        comment: null,
      },
    ]);
  });

  it('limits introspection to tables in tableScope', async () => {
    const getSchemaMetadata = vi.fn(async (_schemaName?: string, scopedNames?: readonly string[] | null) =>
      scopedNames?.includes('orders')
        ? [
            {
              name: 'orders',
              catalog: 'main',
              db: 'sales',
              kind: 'table' as const,
              rowCount: null,
              comment: null,
              columns: [{ name: 'id', type: 'BIGINT', nullable: false, comment: null }],
            },
          ]
        : [],
    );
    const driverFactory: KtxDatabricksDriverFactory = {
      createDriver: vi.fn(() => ({
        test: vi.fn(async () => ({ success: true })),
        query: vi.fn(async () => ({ headers: [], rows: [], totalRows: 0, rowCount: 0 })),
        getSchemaMetadata,
        listSchemas: vi.fn(async () => []),
        listTables: vi.fn(async () => []),
        cleanup: vi.fn(async () => undefined),
      })),
    };
    const connector = new KtxDatabricksScanConnector({
      connectionId: 'warehouse',
      connection: {
        driver: 'databricks',
        server_hostname: 'dbc-example.cloud.databricks.com',
        http_path: '/sql/1.0/warehouses/abc',
        catalog: 'main',
        schema_name: 'sales',
        token: 'fixture-token', // pragma: allowlist secret
      },
      driverFactory,
    });
    const scope = tableRefSet([{ catalog: 'main', db: 'sales', name: 'orders' }]);
    const snapshot = await connector.introspect(
      { connectionId: 'warehouse', driver: 'databricks', tableScope: scope },
      { runId: 'scope-test' },
    );
    expect(snapshot.tables.map((table) => table.name)).toEqual(['orders']);
    expect(getSchemaMetadata).toHaveBeenCalledWith('sales', ['orders']);
  });

  it('supports read-only query, sampling, distinct values, schema listing, and cleanup', async () => {
    const driverFactory = fakeDriverFactory();
    const connector = new KtxDatabricksScanConnector({
      connectionId: 'warehouse',
      connection: {
        driver: 'databricks',
        server_hostname: 'dbc-example.cloud.databricks.com',
        http_path: '/sql/1.0/warehouses/abc',
        catalog: 'main',
        schema_name: 'sales',
        token: 'fixture-token', // pragma: allowlist secret
      },
      driverFactory,
    });

    await expect(
      connector.sampleTable(
        {
          connectionId: 'warehouse',
          table: { catalog: 'main', db: 'sales', name: 'orders' },
          limit: 1,
          columns: ['id', 'status'],
        },
        { runId: 'scan-run-1' },
      ),
    ).resolves.toMatchObject({ headers: ['id', 'status'], rows: [[1, 'paid']], totalRows: 1 });
    await expect(
      connector.executeReadOnly(
        { connectionId: 'warehouse', sql: 'select id, status from orders', maxRows: 1 },
        { runId: 'scan-run-1' },
      ),
    ).resolves.toMatchObject({ headers: ['id', 'status'], rows: [[1, 'paid']], rowCount: 1 });
    await expect(
      connector.sampleColumn(
        {
          connectionId: 'warehouse',
          table: { catalog: 'main', db: 'sales', name: 'orders' },
          column: 'status',
          limit: 2,
        },
        { runId: 'scan-run-1' },
      ),
    ).resolves.toEqual({ values: ['paid', 'open'], nullCount: null, distinctCount: null });
    await expect(
      connector.getColumnDistinctValues({ catalog: 'main', db: 'sales', name: 'orders' }, 'status', {
        maxCardinality: 10,
        limit: 5,
      }),
    ).resolves.toEqual({ values: ['open', 'paid'], cardinality: 2 });
    await expect(connector.listSchemas()).resolves.toEqual(['sales', 'finance']);
    await expect(connector.listTables(['sales'])).resolves.toEqual([
      { catalog: 'main', schema: 'sales', name: 'orders', kind: 'table' },
      { catalog: 'main', schema: 'sales', name: 'order_summary', kind: 'view' },
    ]);
    await connector.cleanup();
    const driver = (driverFactory.createDriver as ReturnType<typeof vi.fn>).mock.results[0]?.value as KtxDatabricksDriver;
    expect(driver.cleanup).toHaveBeenCalledTimes(1);
  });

  it('converts a native snapshot into a live-database introspection snapshot', async () => {
    const introspection = createDatabricksLiveDatabaseIntrospection({
      connections: {
        warehouse: {
          driver: 'databricks',
          server_hostname: 'dbc-example.cloud.databricks.com',
          http_path: '/sql/1.0/warehouses/abc',
          catalog: 'main',
          schema_name: 'sales',
          token: 'fixture-token', // pragma: allowlist secret
        },
      },
      driverFactory: fakeDriverFactory(),
      now: () => new Date('2026-04-29T18:00:00.000Z'),
    });

    await expect(introspection.extractSchema('warehouse')).resolves.toMatchObject({
      connectionId: 'warehouse',
      metadata: { catalog: 'main', schemas: ['sales'] },
      tables: expect.arrayContaining([expect.objectContaining({ catalog: 'main', db: 'sales', name: 'orders' })]),
    });
  });
});
