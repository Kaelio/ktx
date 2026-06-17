import { describe, expect, it, vi } from 'vitest';
import { isKtxRedshiftConnectionConfig, KtxRedshiftScanConnector, redshiftPoolConfigFromConfig, prepareRedshiftReadOnlyQuery, type KtxRedshiftConnectionConfig, type KtxRedshiftPoolFactory } from '../../../src/connectors/redshift/connector.js';
import { tableRefSet } from '../../../src/context/scan/table-ref.js';

interface FakeQueryResult {
  rows: Record<string, unknown>[];
  fields?: Array<{ name: string; dataTypeID: number }>;
}

type FakeQueryResponse = FakeQueryResult | Error;

function fakePoolFactory(results: Map<string, FakeQueryResponse>): KtxRedshiftPoolFactory {
  const query = vi.fn(async (sql: string, params?: unknown[]) => {
    const normalized = sql.replace(/\s+/g, ' ').trim();
    for (const [key, value] of results.entries()) {
      if (normalized.includes(key)) {
        if (value instanceof Error) {
          throw value;
        }
        return value;
      }
    }
    throw new Error(`Unexpected SQL: ${normalized} params=${JSON.stringify(params ?? [])}`);
  });
  return {
    createPool() {
      return {
        async connect() {
          return {
            query,
            release: vi.fn(),
          };
        },
        end: vi.fn(async () => undefined),
      };
    },
  };
}

function metadataResults(): Map<string, FakeQueryResponse> {
  return new Map<string, FakeQueryResponse>([
    [
      'FROM svv_tables t',
      {
        rows: [
          { schema_name: 'public', table_name: 'customers', table_kind: 'r', row_count: '2', table_comment: 'Customers' },
          { schema_name: 'public', table_name: 'orders', table_kind: 'r', row_count: '3', table_comment: null },
          { schema_name: 'public', table_name: 'recent_orders', table_kind: 'v', row_count: '0', table_comment: 'Recent orders' },
        ],
      },
    ],
    [
      'FROM svv_columns',
      {
        rows: [
          { table_name: 'customers', column_name: 'id', data_type: 'integer', is_nullable: false, column_comment: null },
          { table_name: 'customers', column_name: 'name', data_type: 'text', is_nullable: false, column_comment: 'Name' },
          { table_name: 'orders', column_name: 'id', data_type: 'integer', is_nullable: false, column_comment: null },
          { table_name: 'orders', column_name: 'customer_id', data_type: 'integer', is_nullable: false, column_comment: null },
          { table_name: 'orders', column_name: 'status', data_type: 'text', is_nullable: true, column_comment: null },
          { table_name: 'recent_orders', column_name: 'id', data_type: 'integer', is_nullable: true, column_comment: null },
        ],
      },
    ],
    [
      "tc.constraint_type = 'FOREIGN KEY'",
      {
        rows: [
          {
            table_name: 'orders',
            column_name: 'customer_id',
            foreign_table_schema: 'public',
            foreign_table_name: 'customers',
            foreign_column_name: 'id',
            constraint_name: 'orders_customer_id_fkey',
          },
        ],
      },
    ],
    [
      "tc.constraint_type = 'PRIMARY KEY'",
      {
        rows: [
          { table_name: 'customers', column_name: 'id' },
          { table_name: 'orders', column_name: 'id' },
        ],
      },
    ],
    ['SELECT "id" FROM "public"."orders" LIMIT 1', { rows: [{ id: 10 }], fields: [{ name: 'id', dataTypeID: 23 }] }],
    [
      'SELECT "status" FROM "public"."orders" WHERE "status" IS NOT NULL',
      { rows: [{ status: 'paid' }, { status: 'open' }], fields: [{ name: 'status', dataTypeID: 25 }] },
    ],
    ['COUNT(DISTINCT val) AS cardinality', { rows: [{ cardinality: '2' }] }],
    ['SELECT DISTINCT "status"::text AS val', { rows: [{ val: 'open' }, { val: 'paid' }] }],
    ['SELECT COUNT(*) AS count FROM "public"."orders"', { rows: [{ count: '3' }] }],
    ['FROM pg_stats s', { rows: [{ column_name: 'status', estimated_cardinality: '2' }] }],
    ['SELECT 1', { rows: [{ '?column?': 1 }], fields: [{ name: '?column?', dataTypeID: 23 }] }],
    [
      'FROM svv_tables WHERE table_schema = ANY($1) AND table_type IN',
      {
        rows: [
          { schema_name: 'public', table_name: 'customers', table_kind: 'r' },
          { schema_name: 'public', table_name: 'orders', table_kind: 'r' },
          { schema_name: 'public', table_name: 'recent_orders', table_kind: 'v' },
        ],
      },
    ],
    ['SELECT schema_name FROM information_schema.schemata', { rows: [{ schema_name: 'public' }] }],
  ]);
}

describe('KtxRedshiftScanConnector', () => {
  it('prepares read-only SQL parameters with Redshift positional placeholders', () => {
    expect(
      prepareRedshiftReadOnlyQuery('select * from orders where id = :id and status = :status', {
        id: 1,
        status: 'paid',
      }),
    ).toEqual({
      sql: 'select * from orders where id = $1 and status = $2',
      params: [1, 'paid'],
    });
    expect(
      prepareRedshiftReadOnlyQuery('select :Client_Name_10, :Client_Name_1', {
        Client_Name_1: 'short',
        Client_Name_10: 'long',
      }),
    ).toEqual({
      sql: 'select $2, $1',
      params: ['short', 'long'],
    });
    expect(prepareRedshiftReadOnlyQuery('select 1')).toEqual({ sql: 'select 1', params: undefined });
  });

  it('resolves configuration safely', () => {
    expect(isKtxRedshiftConnectionConfig({ driver: 'redshift', url: 'env:DATABASE_URL' })).toBe(true);
    expect(isKtxRedshiftConnectionConfig({ driver: 'redshiftql', host: 'db', database: 'analytics' })).toBe(false);
    expect(isKtxRedshiftConnectionConfig({ driver: 'mysql', host: 'db' })).toBe(false);
    expect(
      redshiftPoolConfigFromConfig({
        connectionId: 'warehouse',
        connection: {
          driver: 'redshift',
          host: 'db.example.test',
          database: 'analytics',
          username: 'reader',
          password: 'test-password', // pragma: allowlist secret
          schemas: ['analytics', 'public'],
          ssl: true,
          rejectUnauthorized: false,
        },
      }),
    ).toMatchObject({
      host: 'db.example.test',
      port: 5439,
      database: 'analytics',
      user: 'reader',
      password: 'test-password', // pragma: allowlist secret
      options: '-c search_path=analytics,public',
      ssl: { rejectUnauthorized: false },
    });
    const libpqPreferConfig = redshiftPoolConfigFromConfig({
      connectionId: 'warehouse',
      connection: {
        driver: 'redshift',
        url: 'env:DEMO_DATABASE_URL',
      },
      env: {
        DEMO_DATABASE_URL: 'redshift://reader@demo.example.test:5439/demo?sslmode=prefer',
      },
    });
    expect(libpqPreferConfig).toMatchObject({
      host: 'demo.example.test',
      port: 5439,
      database: 'demo',
      user: 'reader',
    });
    expect(libpqPreferConfig).not.toHaveProperty('connectionString');
    expect(libpqPreferConfig).not.toHaveProperty('ssl');
    expect(
      redshiftPoolConfigFromConfig({
        connectionId: 'warehouse',
        connection: { driver: 'redshift', host: 'db.example.test', database: 'analytics', username: 'reader' },
      }),
    ).toMatchObject({
      host: 'db.example.test',
      database: 'analytics',
      user: 'reader',
    });
  });

  it('defaults and validates Redshift maxConnections', () => {
    const baseConnection: KtxRedshiftConnectionConfig = {
      driver: 'redshift',
      host: 'db.example.test',
      database: 'analytics',
      username: 'reader',
      password: 'test-password', // pragma: allowlist secret
    };

    expect(
      redshiftPoolConfigFromConfig({
        connectionId: 'warehouse',
        connection: baseConnection,
      }),
    ).toMatchObject({ max: 10 });

    expect(
      redshiftPoolConfigFromConfig({
        connectionId: 'warehouse',
        connection: { ...baseConnection, maxConnections: 50 },
      }),
    ).toMatchObject({ max: 50 });

    expect(
      redshiftPoolConfigFromConfig({
        connectionId: 'warehouse',
        connection: { ...baseConnection, maxConnections: '12' as never },
      }),
    ).toMatchObject({ max: 12 });

    for (const maxConnections of [0, -1, 1.5, Number.NaN, 'abc' as never]) {
      expect(() =>
        redshiftPoolConfigFromConfig({
          connectionId: 'warehouse',
          connection: { ...baseConnection, maxConnections },
        }),
      ).toThrow('connections.warehouse.maxConnections must be a positive integer');
    }
  });

  it('introspects schemas, tables, views, primary keys, comments, row counts, and foreign keys', async () => {
    const connector = new KtxRedshiftScanConnector({
      connectionId: 'warehouse',
      connection: {
        driver: 'redshift',
        host: 'db.example.test',
        database: 'analytics',
        username: 'reader',
        password: 'test-password', // pragma: allowlist secret
        schema: 'public',
      },
      poolFactory: fakePoolFactory(metadataResults()),
      now: () => new Date('2026-04-29T10:00:00.000Z'),
    });

    const snapshot = await connector.introspect(
      { connectionId: 'warehouse', driver: 'redshift' },
      { runId: 'scan-run-1' },
    );

    expect(snapshot).toMatchObject({
      connectionId: 'warehouse',
      driver: 'redshift',
      extractedAt: '2026-04-29T10:00:00.000Z',
      scope: { schemas: ['public'] },
      metadata: {
        database: 'analytics',
        schemas: ['public'],
        host: 'db.example.test',
        table_count: 3,
        total_columns: 6,
      },
    });
    expect(snapshot.tables.map((table) => [table.db, table.name, table.kind, table.estimatedRows])).toEqual([
      ['public', 'customers', 'table', 2],
      ['public', 'orders', 'table', 3],
      ['public', 'recent_orders', 'view', null],
    ]);
    expect(snapshot.tables.find((table) => table.name === 'customers')?.columns[0]).toMatchObject({
      name: 'id',
      nativeType: 'integer',
      normalizedType: 'integer',
      dimensionType: 'number',
      nullable: false,
      primaryKey: true,
    });
    expect(snapshot.tables.find((table) => table.name === 'orders')?.foreignKeys).toEqual([
      {
        fromColumn: 'customer_id',
        toCatalog: null,
        toDb: 'public',
        toTable: 'customers',
        toColumn: 'id',
        constraintName: 'orders_customer_id_fkey',
      },
    ]);
  });

  it('soft-fails denied Redshift constraint discovery with scan warnings', async () => {
    const results = metadataResults();
    results.set(
      "tc.constraint_type = 'PRIMARY KEY'",
      Object.assign(new Error('permission denied for information_schema'), { code: '42501' }),
    );
    results.set(
      "tc.constraint_type = 'FOREIGN KEY'",
      Object.assign(new Error('relation information_schema.key_column_usage does not exist'), { code: '42P01' }),
    );
    const connector = new KtxRedshiftScanConnector({
      connectionId: 'warehouse',
      connection: {
        driver: 'redshift',
        host: 'db.example.test',
        database: 'analytics',
        username: 'reader',
        password: 'test-password', // pragma: allowlist secret
        schema: 'public',
      },
      poolFactory: fakePoolFactory(results),
      now: () => new Date('2026-04-29T10:00:00.000Z'),
    });

    const snapshot = await connector.introspect(
      { connectionId: 'warehouse', driver: 'redshift' },
      { runId: 'scan-run-denied-constraints' },
    );

    expect(snapshot.warnings).toEqual([
      {
        code: 'constraint_discovery_unauthorized',
        message: 'Skipped primary-key discovery in public (insufficient grants on system catalogs)',
        recoverable: true,
        metadata: { schema: 'public', kind: 'primary_key' },
      },
      {
        code: 'constraint_discovery_unauthorized',
        message: 'Skipped foreign-key discovery in public (insufficient grants on system catalogs)',
        recoverable: true,
        metadata: { schema: 'public', kind: 'foreign_key' },
      },
    ]);
    expect(snapshot.tables.every((table) => table.columns.every((column) => column.primaryKey === false))).toBe(true);
    expect(snapshot.tables.every((table) => table.foreignKeys.length === 0)).toBe(true);
  });

  it('propagates non-denial Redshift constraint discovery errors', async () => {
    const results = metadataResults();
    const resetError = Object.assign(new Error('connection reset'), { code: 'ECONNRESET' });
    results.set("tc.constraint_type = 'PRIMARY KEY'", resetError);
    const connector = new KtxRedshiftScanConnector({
      connectionId: 'warehouse',
      connection: {
        driver: 'redshift',
        host: 'db.example.test',
        database: 'analytics',
        username: 'reader',
        password: 'test-password', // pragma: allowlist secret
        schema: 'public',
      },
      poolFactory: fakePoolFactory(results),
    });

    await expect(
      connector.introspect({ connectionId: 'warehouse', driver: 'redshift' }, { runId: 'scan-run-network-error' }),
    ).rejects.toBe(resetError);
  });

  it('runs samples, distinct values, statistics, read-only SQL, and schema listing', async () => {
    const connector = new KtxRedshiftScanConnector({
      connectionId: 'warehouse',
      connection: {
        driver: 'redshift',
        host: 'db.example.test',
        database: 'analytics',
        username: 'reader',
        password: 'test-password', // pragma: allowlist secret
        schema: 'public',
      },
      poolFactory: fakePoolFactory(metadataResults()),
    });

    await expect(
      connector.sampleTable(
        { connectionId: 'warehouse', table: { catalog: null, db: 'public', name: 'orders' }, columns: ['id'], limit: 1 },
        { runId: 'scan-run-1' },
      ),
    ).resolves.toEqual({ headers: ['id'], headerTypes: ['integer'], rows: [[10]], totalRows: 1 });

    await expect(
      connector.sampleColumn(
        { connectionId: 'warehouse', table: { catalog: null, db: 'public', name: 'orders' }, column: 'status', limit: 5 },
        { runId: 'scan-run-1' },
      ),
    ).resolves.toMatchObject({ values: ['paid', 'open'], nullCount: null, distinctCount: null });

    await expect(
      connector.getColumnDistinctValues(
        { catalog: null, db: 'public', name: 'orders' },
        'status',
        { maxCardinality: 5, limit: 10, sampleSize: 100 },
      ),
    ).resolves.toEqual({ values: ['open', 'paid'], cardinality: 2 });

    await expect(connector.getColumnStatistics({ catalog: null, db: 'public', name: 'orders' })).resolves.toEqual({
      cardinalityByColumn: new Map([['status', 2]]),
    });
    await expect(connector.getTableRowCount({ db: 'public', name: 'orders' })).resolves.toBe(3);
    await expect(connector.listSchemas()).resolves.toEqual(['public']);
    await expect(connector.listTables(['public'])).resolves.toEqual([
      { catalog: null, schema: 'public', name: 'customers', kind: 'table' },
      { catalog: null, schema: 'public', name: 'orders', kind: 'table' },
      { catalog: null, schema: 'public', name: 'recent_orders', kind: 'view' },
    ]);
    await expect(connector.testConnection()).resolves.toEqual({ success: true });

    await expect(
      connector.executeReadOnly({ connectionId: 'warehouse', sql: 'delete from orders' }, { runId: 'scan-run-1' }),
    ).rejects.toThrow('Only read-only SELECT/WITH queries can be executed locally');
  });

  it('limits introspection to tables in tableScope', async () => {
    const queries: Array<{ sql: string; params?: unknown[] }> = [];
    const poolFactory: KtxRedshiftPoolFactory = {
      createPool() {
        return {
          async connect() {
            return {
              query: vi.fn(async (sql: string, params?: unknown[]) => {
                queries.push({ sql, params });
                if (sql.includes('FROM svv_tables t')) {
                  return { rows: [{ table_name: 'orders', table_kind: 'r', row_count: '3', table_comment: null }] };
                }
                if (sql.includes('FROM svv_columns')) {
                  return {
                    rows: [
                      {
                        table_name: 'orders',
                        column_name: 'id',
                        data_type: 'integer',
                        is_nullable: false,
                        column_comment: null,
                      },
                    ],
                  };
                }
                return { rows: [] };
              }),
              release: vi.fn(),
            };
          },
          end: vi.fn(async () => undefined),
        };
      },
    };
    const connector = new KtxRedshiftScanConnector({
      connectionId: 'warehouse',
      connection: {
        driver: 'redshift',
        host: 'db.example.test',
        database: 'analytics',
        username: 'reader',
        password: 'test-password', // pragma: allowlist secret
        schema: 'public',
      },
      poolFactory,
    });
    const scope = tableRefSet([{ catalog: null, db: 'public', name: 'orders' }]);
    const snapshot = await connector.introspect(
      { connectionId: 'warehouse', driver: 'redshift', tableScope: scope },
      { runId: 'scope-test' },
    );
    expect(snapshot.tables.map((table) => table.name)).toEqual(['orders']);
    const tablesQuery = queries.find((query) => query.sql.includes('FROM svv_tables t'));
    expect(tablesQuery?.sql).toMatch(/t\.table_name = ANY\(\$2\)/);
    expect(tablesQuery?.params).toEqual(['public', ['orders']]);
  });

  it('attaches an error listener to the pg pool', async () => {
    const on = vi.fn();
    const poolFactory: KtxRedshiftPoolFactory = {
      createPool() {
        return {
          on,
          async connect() {
            return {
              query: vi.fn(async () => ({ rows: [{ '?column?': 1 }], fields: [{ name: '?column?', dataTypeID: 23 }] })),
              release: vi.fn(),
            };
          },
          end: vi.fn(async () => undefined),
        };
      },
    };
    const connector = new KtxRedshiftScanConnector({
      connectionId: 'warehouse',
      connection: {
        driver: 'redshift',
        host: 'db.example.test',
        database: 'analytics',
        username: 'reader',
        password: 'test-password', // pragma: allowlist secret
      },
      poolFactory,
    });

    await expect(connector.testConnection()).resolves.toEqual({ success: true });

    expect(on).toHaveBeenCalledWith('error', expect.any(Function));
  });
});
