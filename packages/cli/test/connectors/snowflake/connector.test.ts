import { describe, expect, it, vi } from 'vitest';

const createPool = vi.hoisted(() => vi.fn());

vi.mock('snowflake-sdk', () => ({
  default: { createPool },
  createPool,
}));

import { KtxQueryError } from '../../../src/errors.js';
import { createSnowflakeLiveDatabaseIntrospection } from '../../../src/connectors/snowflake/live-database-introspection.js';
import { isKtxSnowflakeConnectionConfig, KtxSnowflakeScanConnector, prepareSnowflakeReadOnlyQuery, snowflakeConnectionConfigFromConfig, type KtxSnowflakeConnectionConfig, type KtxSnowflakeDriver, type KtxSnowflakeDriverFactory } from '../../../src/connectors/snowflake/connector.js';
import { tableRefSet } from '../../../src/context/scan/table-ref.js';

function fakeDriverFactory(): KtxSnowflakeDriverFactory {
  const driver: KtxSnowflakeDriver = {
    test: vi.fn(async () => ({ success: true })),
    query: vi.fn(async (sql: string) => {
      if (sql.includes('TABLE_CONSTRAINTS')) {
        return { headers: ['TABLE_NAME', 'COLUMN_NAME'], rows: [['ORDERS', 'ID']], totalRows: 1, rowCount: 1 };
      }
      if (sql.includes('SELECT "ID", "STATUS" FROM "ANALYTICS"."PUBLIC"."ORDERS"')) {
        return {
          headers: ['ID', 'STATUS'],
          headerTypes: ['NUMBER', 'VARCHAR'],
          rows: [[1, 'paid']],
          totalRows: 1,
          rowCount: 1,
        };
      }
      if (sql.includes('select * from (select ID, STATUS from ORDERS) as ktx_query_result limit 1')) {
        return { headers: ['ID', 'STATUS'], rows: [[1, 'paid']], totalRows: 1, rowCount: 1 };
      }
      if (sql.includes('SELECT "STATUS" FROM "ANALYTICS"."PUBLIC"."ORDERS"')) {
        return { headers: ['STATUS'], rows: [['paid'], ['open']], totalRows: 2, rowCount: 2 };
      }
      if (sql.includes('COUNT(DISTINCT val)')) {
        return { headers: ['CARDINALITY'], rows: [[2]], totalRows: 1, rowCount: 1 };
      }
      if (sql.includes('SELECT DISTINCT "STATUS"::VARCHAR AS val')) {
        return { headers: ['VAL'], rows: [['open'], ['paid']], totalRows: 2, rowCount: 2 };
      }
      throw new Error(`Unexpected SQL: ${sql}`);
    }),
    getSchemaMetadata: vi.fn(async () => [
      {
        name: 'ORDERS',
        catalog: 'ANALYTICS',
        db: 'PUBLIC',
        rowCount: 12,
        comment: 'Orders',
        columns: [
          { name: 'ID', type: 'NUMBER(38,0)', nullable: false, comment: 'Primary key' },
          { name: 'STATUS', type: 'VARCHAR', nullable: true, comment: null },
        ],
      },
      {
        name: 'ORDER_SUMMARY',
        catalog: 'ANALYTICS',
        db: 'PUBLIC',
        rowCount: 3,
        comment: null,
        columns: [{ name: 'STATUS', type: 'VARCHAR', nullable: true, comment: null }],
      },
    ]),
    listSchemas: vi.fn(async () => ['PUBLIC', 'MART']),
    listTables: vi.fn(async () => [
      { catalog: 'ANALYTICS', schema: 'PUBLIC', name: 'ORDERS', kind: 'table' as const },
      { catalog: 'ANALYTICS', schema: 'PUBLIC', name: 'ORDER_SUMMARY', kind: 'view' as const },
    ]),
    cleanup: vi.fn(async () => undefined),
  };
  return { createDriver: vi.fn(() => driver) };
}

function fakeSnowflakeStatement(headers: string[] = ['ONE']) {
  return {
    getColumns: () => headers.map((header) => ({ getName: () => header, getType: () => 'TEXT' })),
  };
}

function installSnowflakePoolMock() {
  const executedSql: string[] = [];
  const connection = {
    execute: vi.fn(
      (input: {
        sqlText: string;
        complete: (
          error: Error | null,
          statement: ReturnType<typeof fakeSnowflakeStatement>,
          rows: Array<Record<string, unknown>>,
        ) => void;
      }) => {
        executedSql.push(input.sqlText);
        input.complete(null, fakeSnowflakeStatement(), [{ ONE: 1 }]);
      },
    ),
  };
  const pool = {
    use: vi.fn(async (fn: (conn: typeof connection) => Promise<unknown>) => fn(connection)),
    drain: vi.fn(async () => undefined),
    clear: vi.fn(async () => undefined),
  };
  createPool.mockReturnValue(pool);
  return { connection, pool, executedSql };
}

describe('KtxSnowflakeScanConnector', () => {
  it('prepares read-only SQL parameters with Snowflake bind arrays', () => {
    expect(prepareSnowflakeReadOnlyQuery('SELECT * FROM ORDERS WHERE ID = ? AND STATUS = ?', { id: 1, status: 'paid' })).toEqual({
      sql: 'SELECT * FROM ORDERS WHERE ID = ? AND STATUS = ?',
      params: [1, 'paid'],
    });
    expect(prepareSnowflakeReadOnlyQuery('SELECT * FROM ORDERS')).toEqual({
      sql: 'SELECT * FROM ORDERS',
      params: undefined,
    });
  });

  it('resolves Snowflake connection configuration safely', () => {
    expect(
      isKtxSnowflakeConnectionConfig({
        driver: 'snowflake',
        account: 'acct',
        warehouse: 'WH',
        database: 'ANALYTICS',
        username: 'reader',
      }),
    ).toBe(true);
    expect(isKtxSnowflakeConnectionConfig({ driver: 'bigquery' })).toBe(false);
    expect(
      snowflakeConnectionConfigFromConfig({
        connectionId: 'warehouse',
        connection: {
          driver: 'snowflake',
          authMethod: 'password',
          account: 'acct',
          warehouse: 'WH',
          database: 'ANALYTICS',
          schema_name: 'PUBLIC',
          username: 'reader',
          password: 'fixture-pass', // pragma: allowlist secret
        },
      }),
    ).toMatchObject({
      account: 'acct',
      warehouse: 'WH',
      database: 'ANALYTICS',
      schemas: ['PUBLIC'],
      username: 'reader',
      authMethod: 'password',
    });
  });

  it('defaults and validates Snowflake maxConnections', () => {
    const baseConnection: KtxSnowflakeConnectionConfig = {
      driver: 'snowflake',
      authMethod: 'password',
      account: 'acct',
      warehouse: 'WH',
      database: 'ANALYTICS',
      schema_name: 'PUBLIC',
      username: 'reader',
      password: 'fixture-pass', // pragma: allowlist secret
    };

    expect(
      snowflakeConnectionConfigFromConfig({
        connectionId: 'warehouse',
        connection: baseConnection,
      }),
    ).toMatchObject({ maxConnections: 4 });

    expect(
      snowflakeConnectionConfigFromConfig({
        connectionId: 'warehouse',
        connection: { ...baseConnection, maxConnections: 8 },
      }),
    ).toMatchObject({ maxConnections: 8 });

    expect(
      snowflakeConnectionConfigFromConfig({
        connectionId: 'warehouse',
        connection: { ...baseConnection, maxConnections: '12' as never },
      }),
    ).toMatchObject({ maxConnections: 12 });

    for (const maxConnections of [0, -1, 1.5, Number.NaN, 'abc' as never]) {
      expect(() =>
        snowflakeConnectionConfigFromConfig({
          connectionId: 'warehouse',
          connection: { ...baseConnection, maxConnections },
        }),
      ).toThrow('connections.warehouse.maxConnections must be a positive integer');
    }
  });

  it('rejects stale Snowflake pool config key', () => {
    const baseConnection: KtxSnowflakeConnectionConfig = {
      driver: 'snowflake',
      authMethod: 'password',
      account: 'acct',
      warehouse: 'WH',
      database: 'ANALYTICS',
      schema_name: 'PUBLIC',
      username: 'reader',
      password: 'fixture-pass', // pragma: allowlist secret
    };

    expect(() =>
      snowflakeConnectionConfigFromConfig({
        connectionId: 'warehouse',
        connection: { ...baseConnection, maxSessions: 8 },
      }),
    ).toThrow(/renamed to maxConnections/);
  });

  it('uses one lazy Snowflake pool and drains it during cleanup', async () => {
    const { pool, executedSql } = installSnowflakePoolMock();
    const close = vi.fn(async () => undefined);
    const connector = new KtxSnowflakeScanConnector({
      connectionId: 'warehouse',
      connection: {
        driver: 'snowflake',
        authMethod: 'password',
        account: 'acct',
        warehouse: 'WH',
        database: 'ANALYTICS',
        schema_name: 'PUBLIC',
        username: 'reader',
        password: 'fixture-pass', // pragma: allowlist secret
        role: 'ANALYST',
        maxConnections: 3,
      },
      sdkOptionsProvider: {
        resolve: vi.fn(async () => ({ sdkOptions: { application: 'ktx-test' }, close })),
      },
    });

    expect(createPool).not.toHaveBeenCalled();

    await connector.executeReadOnly({ connectionId: 'warehouse', sql: 'select 1', maxRows: 1 }, { runId: 'run-1' });
    await connector.executeReadOnly({ connectionId: 'warehouse', sql: 'select 1', maxRows: 1 }, { runId: 'run-1' });

    expect(createPool).toHaveBeenCalledTimes(1);
    expect(createPool).toHaveBeenCalledWith(
      expect.objectContaining({
        account: 'acct',
        username: 'reader',
        warehouse: 'WH',
        database: 'ANALYTICS',
        schema: 'PUBLIC',
        role: 'ANALYST',
        password: 'fixture-pass', // pragma: allowlist secret
        clientSessionKeepAlive: true,
        clientSessionKeepAliveHeartbeatFrequency: 900,
        application: 'ktx-test',
      }),
      expect.objectContaining({
        min: 0,
        max: 3,
        evictionRunIntervalMillis: 30_000,
        acquireTimeoutMillis: 60_000,
      }),
    );
    expect(pool.use).toHaveBeenCalledTimes(2);
    expect(executedSql.some((sql) => /^USE\s+/i.test(sql.trim()))).toBe(false);

    await connector.cleanup();
    expect(pool.drain).toHaveBeenCalledBefore(pool.clear);
    expect(pool.clear).toHaveBeenCalledTimes(1);
    expect(close).toHaveBeenCalledTimes(1);
  });

  it('sets STATEMENT_TIMEOUT_IN_SECONDS to the resolved deadline and maps a Snowflake timeout to KtxQueryError', async () => {
    createPool.mockReset();
    const executedSql: string[] = [];
    const timeoutError = Object.assign(
      new Error('Statement reached its statement or warehouse timeout of 5 second(s) and was canceled.'),
      { code: 604 },
    );
    const connection = {
      execute: vi.fn(
        (input: {
          sqlText: string;
          complete: (error: Error | null, statement: ReturnType<typeof fakeSnowflakeStatement>, rows: unknown[]) => void;
        }) => {
          executedSql.push(input.sqlText);
          if (/^ALTER SESSION/i.test(input.sqlText)) {
            input.complete(null, fakeSnowflakeStatement(), [{ ONE: 1 }]);
          } else {
            input.complete(timeoutError, fakeSnowflakeStatement(), []);
          }
        },
      ),
    };
    createPool.mockReturnValue({
      use: vi.fn(async (fn: (conn: typeof connection) => Promise<unknown>) => fn(connection)),
      drain: vi.fn(async () => undefined),
      clear: vi.fn(async () => undefined),
    });
    const connector = new KtxSnowflakeScanConnector({
      connectionId: 'warehouse',
      connection: {
        driver: 'snowflake',
        authMethod: 'password',
        account: 'acct',
        warehouse: 'WH',
        database: 'ANALYTICS',
        schema_name: 'PUBLIC',
        username: 'reader',
        password: 'fixture-pass', // pragma: allowlist secret
        query_timeout_ms: 5_000,
      },
    });

    const execution = connector.executeReadOnly(
      { connectionId: 'warehouse', sql: 'select count(*) from orders' },
      { runId: 'run-1' },
    );
    await expect(execution).rejects.toBeInstanceOf(KtxQueryError);
    await expect(execution).rejects.toThrow('query exceeded 5s');
    expect(executedSql[0]).toBe('ALTER SESSION SET STATEMENT_TIMEOUT_IN_SECONDS = 5');
  });

  it('introspects schema, primary keys, comments, row counts, and dimensions', async () => {
    const connector = new KtxSnowflakeScanConnector({
      connectionId: 'warehouse',
      connection: {
        driver: 'snowflake',
        authMethod: 'password',
        account: 'acct',
        warehouse: 'WH',
        database: 'ANALYTICS',
        schema_name: 'PUBLIC',
        username: 'reader',
        password: 'fixture-pass', // pragma: allowlist secret
      },
      driverFactory: fakeDriverFactory(),
      now: () => new Date('2026-04-29T18:00:00.000Z'),
    });

    const snapshot = await connector.introspect(
      { connectionId: 'warehouse', driver: 'snowflake' },
      { runId: 'scan-run-1' },
    );

    expect(snapshot).toMatchObject({
      connectionId: 'warehouse',
      driver: 'snowflake',
      extractedAt: '2026-04-29T18:00:00.000Z',
      scope: { catalogs: ['ANALYTICS'], schemas: ['PUBLIC'] },
      metadata: {
        account: 'acct',
        warehouse: 'WH',
        database: 'ANALYTICS',
        schemas: ['PUBLIC'],
        table_count: 2,
        total_columns: 3,
      },
    });
    expect(snapshot.tables.find((table) => table.name === 'ORDERS')?.columns).toEqual([
      {
        name: 'ID',
        nativeType: 'NUMBER(38,0)',
        normalizedType: 'NUMBER(38,0)',
        dimensionType: 'number',
        nullable: false,
        primaryKey: true,
        comment: 'Primary key',
      },
      {
        name: 'STATUS',
        nativeType: 'VARCHAR',
        normalizedType: 'VARCHAR',
        dimensionType: 'string',
        nullable: true,
        primaryKey: false,
        comment: null,
      },
    ]);
  });

  it('continues introspection when primary-key discovery is not authorized', async () => {
    const driverFactory = fakeDriverFactory();
    const driver = (driverFactory.createDriver as ReturnType<typeof vi.fn>).getMockImplementation() as
      | (() => KtxSnowflakeDriver)
      | undefined;
    if (!driver) throw new Error('driver mock missing');
    const built = driver();
    (built.query as ReturnType<typeof vi.fn>).mockImplementation(async (sql: string) => {
      if (sql.includes('TABLE_CONSTRAINTS')) {
        throw new Error(
          "SQL compilation error: Object 'ANALYTICS.INFORMATION_SCHEMA.KEY_COLUMN_USAGE' does not exist or not authorized.",
        );
      }
      throw new Error(`Unexpected SQL: ${sql}`);
    });
    (driverFactory.createDriver as ReturnType<typeof vi.fn>).mockReturnValue(built);

    const warn = vi.spyOn(console, 'warn').mockImplementation(() => undefined);
    try {
      const connector = new KtxSnowflakeScanConnector({
        connectionId: 'warehouse',
        connection: {
          driver: 'snowflake',
          authMethod: 'password',
          account: 'acct',
          warehouse: 'WH',
          database: 'ANALYTICS',
          schema_name: 'PUBLIC',
          username: 'reader',
          password: 'fixture-pass', // pragma: allowlist secret
        },
        driverFactory,
      });

      const snapshot = await connector.introspect(
        { connectionId: 'warehouse', driver: 'snowflake' },
        { runId: 'scan-run-pk-skip' },
      );

      expect(snapshot.tables.map((table) => table.name).sort()).toEqual(['ORDERS', 'ORDER_SUMMARY']);
      expect(snapshot.tables.every((table) => table.columns.every((column) => column.primaryKey === false))).toBe(true);
      expect(snapshot.warnings).toEqual([
        {
          code: 'constraint_discovery_unauthorized',
          message: 'Skipped primary-key discovery in PUBLIC (insufficient grants on system catalogs)',
          recoverable: true,
          metadata: { schema: 'PUBLIC', kind: 'primary_key' },
        },
      ]);
      expect(warn).not.toHaveBeenCalled();
    } finally {
      warn.mockRestore();
    }
  });

  it('propagates non-denial Snowflake primary-key discovery errors', async () => {
    const driverFactory = fakeDriverFactory();
    const driver = (driverFactory.createDriver as ReturnType<typeof vi.fn>).getMockImplementation() as
      | (() => KtxSnowflakeDriver)
      | undefined;
    if (!driver) throw new Error('driver mock missing');
    const built = driver();
    const networkError = new Error('network unavailable');
    (built.query as ReturnType<typeof vi.fn>).mockImplementation(async (sql: string) => {
      if (sql.includes('TABLE_CONSTRAINTS')) {
        throw networkError;
      }
      throw new Error(`Unexpected SQL: ${sql}`);
    });
    (driverFactory.createDriver as ReturnType<typeof vi.fn>).mockReturnValue(built);

    const connector = new KtxSnowflakeScanConnector({
      connectionId: 'warehouse',
      connection: {
        driver: 'snowflake',
        authMethod: 'password',
        account: 'acct',
        warehouse: 'WH',
        database: 'ANALYTICS',
        schema_name: 'PUBLIC',
        username: 'reader',
        password: 'fixture-pass', // pragma: allowlist secret
      },
      driverFactory,
    });

    await expect(
      connector.introspect({ connectionId: 'warehouse', driver: 'snowflake' }, { runId: 'scan-run-snowflake-network' }),
    ).rejects.toBe(networkError);
  });

  it('limits introspection to tables in tableScope', async () => {
    const queries: Array<{ sql: string; params?: unknown }> = [];
    const getSchemaMetadata = vi.fn(async (_schemaName?: string, scopedNames?: readonly string[] | null) =>
      scopedNames?.includes('ORDERS')
        ? [
            {
              name: 'ORDERS',
              catalog: 'ANALYTICS',
              db: 'MARTS',
              rowCount: 10,
              comment: null,
              columns: [{ name: 'ID', type: 'NUMBER', nullable: false, comment: null }],
            },
          ]
        : [],
    );
    const driverFactory: KtxSnowflakeDriverFactory = {
      createDriver: vi.fn(() => ({
        test: vi.fn(async () => ({ success: true })),
        query: vi.fn(async (sql: string, params?: unknown) => {
          queries.push({ sql, params });
          return { headers: [], rows: [], totalRows: 0, rowCount: 0 };
        }),
        getSchemaMetadata,
        listSchemas: vi.fn(async () => []),
        listTables: vi.fn(async () => []),
        cleanup: vi.fn(async () => undefined),
      })),
    };
    const connector = new KtxSnowflakeScanConnector({
      connectionId: 'warehouse',
      connection: {
        driver: 'snowflake',
        authMethod: 'password',
        account: 'acct',
        warehouse: 'WH',
        database: 'ANALYTICS',
        schema_name: 'MARTS',
        username: 'reader',
        password: 'fixture-pass', // pragma: allowlist secret
      },
      driverFactory,
    });
    const scope = tableRefSet([{ catalog: 'ANALYTICS', db: 'MARTS', name: 'ORDERS' }]);
    const snapshot = await connector.introspect(
      { connectionId: 'warehouse', driver: 'snowflake', tableScope: scope },
      { runId: 'scope-test' },
    );
    expect(snapshot.tables.map((table) => table.name)).toEqual(['ORDERS']);
    expect(getSchemaMetadata).toHaveBeenCalledWith('MARTS', ['ORDERS']);
    const primaryKeysQuery = queries.find((query) => query.sql.includes('TABLE_CONSTRAINTS'));
    expect(primaryKeysQuery?.sql).toMatch(/AND tc\.TABLE_NAME IN \(\?\)/);
    expect(primaryKeysQuery?.params).toEqual(['MARTS', 'ANALYTICS', 'ORDERS']);
  });

  it('supports read-only query, sampling, distinct values, row counts, schema listing, and cleanup', async () => {
    const driverFactory = fakeDriverFactory();
    const connector = new KtxSnowflakeScanConnector({
      connectionId: 'warehouse',
      connection: {
        driver: 'snowflake',
        authMethod: 'password',
        account: 'acct',
        warehouse: 'WH',
        database: 'ANALYTICS',
        schema_name: 'PUBLIC',
        username: 'reader',
        password: 'fixture-pass', // pragma: allowlist secret
      },
      driverFactory,
    });

    await expect(
      connector.sampleTable(
        {
          connectionId: 'warehouse',
          table: { catalog: 'ANALYTICS', db: 'PUBLIC', name: 'ORDERS' },
          limit: 1,
          columns: ['ID', 'STATUS'],
        },
        { runId: 'scan-run-1' },
      ),
    ).resolves.toMatchObject({ headers: ['ID', 'STATUS'], rows: [[1, 'paid']], totalRows: 1 });
    await expect(
      connector.executeReadOnly(
        { connectionId: 'warehouse', sql: 'select ID, STATUS from ORDERS', maxRows: 1 },
        { runId: 'scan-run-1' },
      ),
    ).resolves.toMatchObject({ headers: ['ID', 'STATUS'], rows: [[1, 'paid']], rowCount: 1 });
    await expect(
      connector.sampleColumn(
        {
          connectionId: 'warehouse',
          table: { catalog: 'ANALYTICS', db: 'PUBLIC', name: 'ORDERS' },
          column: 'STATUS',
          limit: 2,
        },
        { runId: 'scan-run-1' },
      ),
    ).resolves.toEqual({ values: ['paid', 'open'], nullCount: null, distinctCount: null });
    await expect(
      connector.getColumnDistinctValues({ catalog: 'ANALYTICS', db: 'PUBLIC', name: 'ORDERS' }, 'STATUS', {
        maxCardinality: 10,
        limit: 5,
      }),
    ).resolves.toEqual({ values: ['open', 'paid'], cardinality: 2 });
    await expect(connector.getTableRowCount('ORDERS')).resolves.toBe(12);
    await expect(connector.listSchemas()).resolves.toEqual(['PUBLIC', 'MART']);
    await connector.cleanup();
    const driver = (driverFactory.createDriver as ReturnType<typeof vi.fn>).mock.results[0]?.value as KtxSnowflakeDriver;
    expect(driver.cleanup).toHaveBeenCalledTimes(1);
  });

  it('lists tables across schemas with one information schema query', async () => {
    const queries: Array<{ sql: string; params?: unknown }> = [];
    const driverFactory: KtxSnowflakeDriverFactory = {
      createDriver: vi.fn(() => ({
        test: vi.fn(async () => ({ success: true })),
        query: vi.fn(async (sql: string, params?: unknown) => {
          queries.push({ sql, params });
          return {
            headers: ['TABLE_SCHEMA', 'TABLE_NAME', 'TABLE_TYPE'],
            rows: [
              ['MART', 'ORDERS', 'BASE TABLE'],
              ['PUBLIC', 'ORDER_SUMMARY', 'VIEW'],
            ],
            totalRows: 2,
            rowCount: 2,
          };
        }),
        getSchemaMetadata: vi.fn(async () => []),
        listSchemas: vi.fn(async () => []),
        listTables: vi.fn(async () => []),
        cleanup: vi.fn(async () => undefined),
      })),
    };
    const connector = new KtxSnowflakeScanConnector({
      connectionId: 'warehouse',
      connection: {
        driver: 'snowflake',
        authMethod: 'password',
        account: 'acct',
        warehouse: 'WH',
        database: 'ANALYTICS',
        schema_name: 'PUBLIC',
        username: 'reader',
        password: 'fixture-pass', // pragma: allowlist secret
      },
      driverFactory,
    });

    await expect(connector.listTables(['MART', 'PUBLIC'])).resolves.toEqual([
      { catalog: 'ANALYTICS', schema: 'MART', name: 'ORDERS', kind: 'table' },
      { catalog: 'ANALYTICS', schema: 'PUBLIC', name: 'ORDER_SUMMARY', kind: 'view' },
    ]);

    expect(queries).toHaveLength(1);
    expect(queries[0]?.sql).toContain('FROM "ANALYTICS".INFORMATION_SCHEMA.TABLES');
    expect(queries[0]?.sql).toContain('AND TABLE_SCHEMA IN (?, ?)');
    expect(queries[0]?.params).toEqual(['ANALYTICS', 'MART', 'PUBLIC']);
  });

  it('rejects unsafe Snowflake identifiers before driver creation', () => {
    expect(
      () =>
        new KtxSnowflakeScanConnector({
          connectionId: 'warehouse',
          connection: {
            driver: 'snowflake',
            authMethod: 'password',
            account: 'acct',
            warehouse: 'WH;DROP',
            database: 'ANALYTICS',
            schema_name: 'PUBLIC',
            username: 'reader',
            password: 'fixture-pass', // pragma: allowlist secret
          },
          driverFactory: fakeDriverFactory(),
        }),
    ).toThrow('Invalid Snowflake warehouse identifier "WH;DROP"');
  });

  it('converts a native snapshot into a live-database introspection snapshot', async () => {
    const introspection = createSnowflakeLiveDatabaseIntrospection({
      connections: {
        warehouse: {
          driver: 'snowflake',
          authMethod: 'password',
          account: 'acct',
          warehouse: 'WH',
          database: 'ANALYTICS',
          schema_name: 'PUBLIC',
          username: 'reader',
          password: 'fixture-pass', // pragma: allowlist secret
        },
      },
      driverFactory: fakeDriverFactory(),
      now: () => new Date('2026-04-29T18:00:00.000Z'),
    });

    await expect(introspection.extractSchema('warehouse')).resolves.toMatchObject({
      connectionId: 'warehouse',
      metadata: { database: 'ANALYTICS', schemas: ['PUBLIC'] },
      tables: expect.arrayContaining([
        expect.objectContaining({ catalog: 'ANALYTICS', db: 'PUBLIC', name: 'ORDERS' }),
      ]),
    });
  });
});
