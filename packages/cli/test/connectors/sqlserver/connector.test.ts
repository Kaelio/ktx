import { describe, expect, it, vi } from 'vitest';
import { KtxQueryError } from '../../../src/errors.js';
import { createSqlServerLiveDatabaseIntrospection } from '../../../src/connectors/sqlserver/live-database-introspection.js';
import { isKtxSqlServerConnectionConfig, KtxSqlServerScanConnector, prepareSqlServerReadOnlyQuery, sqlServerConnectionPoolConfigFromConfig, type KtxSqlServerConnectionConfig, type KtxSqlServerPoolFactory, type KtxSqlServerQueryResult } from '../../../src/connectors/sqlserver/connector.js';
import { tableRefSet } from '../../../src/context/scan/table-ref.js';

function recordset<T extends Record<string, unknown>>(
  rows: T[],
  columnNames: string[],
): T[] & { columns: Record<string, { type: { declaration: string } }> } {
  const withColumns = rows as T[] & { columns: Record<string, { type: { declaration: string } }> };
  withColumns.columns = Object.fromEntries(columnNames.map((name) => [name, { type: { declaration: 'nvarchar' } }]));
  return withColumns;
}

function result<T extends Record<string, unknown>>(rows: T[], columnNames: string[]): KtxSqlServerQueryResult {
  return { recordset: recordset(rows, columnNames) };
}

function fakePoolFactory(options: { primaryKeyError?: Error; foreignKeyError?: Error } = {}): KtxSqlServerPoolFactory {
  const query = vi.fn(async (sql: string): Promise<KtxSqlServerQueryResult> => {
    if (sql.includes('INFORMATION_SCHEMA.TABLES')) {
      return result(
        [
          { schema_name: 'dbo', table_name: 'customers', table_type: 'BASE TABLE' },
          { schema_name: 'dbo', table_name: 'orders', table_type: 'BASE TABLE' },
          { schema_name: 'dbo', table_name: 'order_summary', table_type: 'VIEW' },
        ],
        ['table_name', 'table_type'],
      );
    }
    if (sql.includes("ep.name = 'MS_Description'") && sql.includes('ep.minor_id = 0')) {
      return result([{ table_name: 'customers', table_comment: 'Customer table' }], [
        'table_name',
        'table_comment',
      ]);
    }
    if (sql.includes("ep.name = 'MS_Description'") && sql.includes('ep.minor_id = c.column_id')) {
      return result([{ table_name: 'customers', column_name: 'id', column_comment: 'PK' }], [
        'table_name',
        'column_name',
        'column_comment',
      ]);
    }
    if (sql.includes('INFORMATION_SCHEMA.COLUMNS')) {
      return result(
        [
          { table_name: 'customers', column_name: 'id', data_type: 'int', is_nullable: 'NO' },
          { table_name: 'customers', column_name: 'name', data_type: 'nvarchar', is_nullable: 'NO' },
          { table_name: 'orders', column_name: 'id', data_type: 'int', is_nullable: 'NO' },
          { table_name: 'orders', column_name: 'customer_id', data_type: 'int', is_nullable: 'NO' },
          { table_name: 'orders', column_name: 'status', data_type: 'nvarchar', is_nullable: 'YES' },
          { table_name: 'order_summary', column_name: 'status', data_type: 'nvarchar', is_nullable: 'YES' },
        ],
        ['table_name', 'column_name', 'data_type', 'is_nullable'],
      );
    }
    if (sql.includes("CONSTRAINT_TYPE = 'PRIMARY KEY'")) {
      if (options.primaryKeyError) {
        throw options.primaryKeyError;
      }
      return result(
        [
          { table_name: 'customers', column_name: 'id' },
          { table_name: 'orders', column_name: 'id' },
        ],
        ['table_name', 'column_name'],
      );
    }
    if (sql.includes('REFERENTIAL_CONSTRAINTS')) {
      if (options.foreignKeyError) {
        throw options.foreignKeyError;
      }
      return result(
        [
          {
            table_name: 'orders',
            column_name: 'customer_id',
            referenced_table_schema: 'dbo',
            referenced_table_name: 'customers',
            referenced_column_name: 'id',
            constraint_name: 'orders_customer_id_fk',
          },
        ],
        [
          'table_name',
          'column_name',
          'referenced_table_schema',
          'referenced_table_name',
          'referenced_column_name',
          'constraint_name',
        ],
      );
    }
    if (sql.includes('sys.partitions') && sql.includes('GROUP BY t.name')) {
      return result(
        [
          { table_name: 'customers', row_count: 2 },
          { table_name: 'orders', row_count: 2 },
        ],
        ['table_name', 'row_count'],
      );
    }
    if (sql.includes('SELECT TOP 1 [id], [status] FROM [analytics].[dbo].[orders]')) {
      return result([{ id: 10, status: 'paid' }], ['id', 'status']);
    }
    if (sql.includes('SELECT TOP 1 * FROM (select id, status from dbo.orders) AS ktx_query_result')) {
      return result([{ id: 10, status: 'paid' }], ['id', 'status']);
    }
    if (sql.includes('SELECT TOP 5 [status] FROM [analytics].[dbo].[orders]')) {
      return result([{ status: 'paid' }, { status: 'open' }], ['status']);
    }
    if (sql.includes('COUNT(DISTINCT val)')) {
      return result([{ cardinality: 2 }], ['cardinality']);
    }
    if (sql.includes('SELECT TOP 10 val')) {
      return result([{ val: 'open' }, { val: 'paid' }], ['val']);
    }
    if (sql.includes('SUM(p.rows) AS row_count') && sql.includes('t.name = @tableName')) {
      return result([{ row_count: 2 }], ['row_count']);
    }
    if (sql.includes('FROM sys.objects o')) {
      return result(
        [
          { schema_name: 'dbo', table_name: 'customers', table_type: 'USER_TABLE' },
          { schema_name: 'dbo', table_name: 'order_summary', table_type: 'VIEW' },
          { schema_name: 'dbo', table_name: 'orders', table_type: 'USER_TABLE' },
        ],
        ['schema_name', 'table_name', 'table_type'],
      );
    }
    if (sql.includes('SELECT s.name AS schema_name')) {
      return result([{ schema_name: 'dbo' }, { schema_name: 'sales' }], ['schema_name']);
    }
    if (sql.trim() === 'SELECT 1') {
      return result([{ ok: 1 }], ['ok']);
    }
    throw new Error(`Unexpected SQL: ${sql}`);
  });
  const request: { input(name: string, value: unknown): typeof request; query: typeof query } = {
    input: vi.fn((_key: string, _value: unknown) => request),
    query,
  };
  const close = vi.fn(async () => undefined);
  return {
    createPool: vi.fn(async () => ({
      request: () => request,
      close,
    })),
  };
}

describe('KtxSqlServerScanConnector', () => {
  it('prepares read-only SQL parameters with SQL Server named placeholders', () => {
    expect(
      prepareSqlServerReadOnlyQuery('select * from events where id = :id and name = :name', {
        id: 10,
        name: 'signup',
      }),
    ).toEqual({
      sql: 'select * from events where id = @id and name = @name',
      params: { id: 10, name: 'signup' },
    });
    expect(prepareSqlServerReadOnlyQuery('select 1')).toEqual({ sql: 'select 1', params: undefined });
  });

  it('resolves SQL Server connection configuration safely', () => {
    expect(
      isKtxSqlServerConnectionConfig({
        driver: 'sqlserver',
        host: 'localhost',
        database: 'analytics',
      }),
    ).toBe(true);
    expect(isKtxSqlServerConnectionConfig({ driver: 'mysql', host: 'localhost', database: 'analytics' })).toBe(false);
    expect(
      sqlServerConnectionPoolConfigFromConfig({
        connectionId: 'warehouse',
        connection: {
          driver: 'sqlserver',
          host: 'db.example.test',
          port: 14330,
          database: 'analytics',
          username: 'reader',
          trustServerCertificate: false,
        },
      }),
    ).toMatchObject({
      server: 'db.example.test',
      port: 14330,
      database: 'analytics',
      user: 'reader',
      options: { encrypt: true, trustServerCertificate: false },
    });
  });

  it('defaults and validates SQL Server maxConnections', () => {
    const baseConnection: KtxSqlServerConnectionConfig = {
      driver: 'sqlserver',
      host: 'db.example.test',
      database: 'analytics',
      username: 'reader',
    };

    expect(
      sqlServerConnectionPoolConfigFromConfig({
        connectionId: 'warehouse',
        connection: baseConnection,
      }),
    ).toMatchObject({ pool: { max: 10 } });

    expect(
      sqlServerConnectionPoolConfigFromConfig({
        connectionId: 'warehouse',
        connection: { ...baseConnection, maxConnections: 15 },
      }),
    ).toMatchObject({ pool: { max: 15 } });

    expect(
      sqlServerConnectionPoolConfigFromConfig({
        connectionId: 'warehouse',
        connection: { ...baseConnection, maxConnections: '12' as never },
      }),
    ).toMatchObject({ pool: { max: 12 } });

    for (const maxConnections of [0, -1, 1.5, Number.NaN, 'abc' as never]) {
      expect(() =>
        sqlServerConnectionPoolConfigFromConfig({
          connectionId: 'warehouse',
          connection: { ...baseConnection, maxConnections },
        }),
      ).toThrow('connections.warehouse.maxConnections must be a positive integer');
    }
  });

  it('introspects schema, primary keys, comments, row counts, views, and foreign keys', async () => {
    const connector = new KtxSqlServerScanConnector({
      connectionId: 'warehouse',
      connection: {
        driver: 'sqlserver',
        host: 'db.example.test',
        database: 'analytics',
        username: 'reader',
        schema: 'dbo',
      },
      poolFactory: fakePoolFactory(),
      now: () => new Date('2026-04-29T16:00:00.000Z'),
    });

    const snapshot = await connector.introspect(
      { connectionId: 'warehouse', driver: 'sqlserver' },
      { runId: 'scan-run-1' },
    );

    expect(snapshot).toMatchObject({
      connectionId: 'warehouse',
      driver: 'sqlserver',
      extractedAt: '2026-04-29T16:00:00.000Z',
      scope: { catalogs: ['analytics'], schemas: ['dbo'] },
      metadata: {
        database: 'analytics',
        host: 'db.example.test',
        schemas: ['dbo'],
        table_count: 3,
        total_columns: 6,
      },
    });
    expect(snapshot.tables.map((table) => [table.name, table.kind, table.estimatedRows, table.comment])).toEqual([
      ['customers', 'table', 2, 'Customer table'],
      ['orders', 'table', 2, null],
      ['order_summary', 'view', null, null],
    ]);
    expect(snapshot.tables.find((table) => table.name === 'customers')?.columns[0]).toMatchObject({
      name: 'id',
      nativeType: 'int',
      normalizedType: 'int',
      dimensionType: 'number',
      nullable: false,
      primaryKey: true,
      comment: 'PK',
    });
    expect(snapshot.tables.find((table) => table.name === 'orders')?.foreignKeys).toEqual([
      {
        fromColumn: 'customer_id',
        toCatalog: 'analytics',
        toDb: 'dbo',
        toTable: 'customers',
        toColumn: 'id',
        constraintName: 'orders_customer_id_fk',
      },
    ]);
  });

  it('soft-fails denied SQL Server constraint discovery with scan warnings', async () => {
    const connector = new KtxSqlServerScanConnector({
      connectionId: 'warehouse',
      connection: {
        driver: 'sqlserver',
        host: 'db.example.test',
        database: 'analytics',
        username: 'reader',
        schema: 'dbo',
      },
      poolFactory: fakePoolFactory({
        primaryKeyError: Object.assign(new Error('SELECT permission denied'), { number: 229 }),
        foreignKeyError: Object.assign(new Error('EXECUTE permission denied'), { number: 230 }),
      }),
      now: () => new Date('2026-04-29T16:00:00.000Z'),
    });

    const snapshot = await connector.introspect(
      { connectionId: 'warehouse', driver: 'sqlserver' },
      { runId: 'scan-run-sqlserver-denied-constraints' },
    );

    expect(snapshot.warnings).toEqual([
      {
        code: 'constraint_discovery_unauthorized',
        message: 'Skipped primary-key discovery in dbo (insufficient grants on system catalogs)',
        recoverable: true,
        metadata: { schema: 'dbo', kind: 'primary_key' },
      },
      {
        code: 'constraint_discovery_unauthorized',
        message: 'Skipped foreign-key discovery in dbo (insufficient grants on system catalogs)',
        recoverable: true,
        metadata: { schema: 'dbo', kind: 'foreign_key' },
      },
    ]);
    expect(snapshot.tables.every((table) => table.columns.every((column) => column.primaryKey === false))).toBe(true);
    expect(snapshot.tables.every((table) => table.foreignKeys.length === 0)).toBe(true);
  });

  it('runs samples, distinct values, read-only SQL, row count, schema list, and cleanup', async () => {
    const poolFactory = fakePoolFactory();
    const connector = new KtxSqlServerScanConnector({
      connectionId: 'warehouse',
      connection: {
        driver: 'sqlserver',
        host: 'db.example.test',
        database: 'analytics',
        username: 'reader',
        schema: 'dbo',
      },
      poolFactory,
    });

    await expect(
      connector.sampleTable(
        {
          connectionId: 'warehouse',
          table: { catalog: 'analytics', db: 'dbo', name: 'orders' },
          columns: ['id', 'status'],
          limit: 1,
        },
        { runId: 'scan-run-1' },
      ),
    ).resolves.toEqual({
      headers: ['id', 'status'],
      headerTypes: ['nvarchar', 'nvarchar'],
      rows: [[10, 'paid']],
      totalRows: 1,
    });

    await expect(
      connector.sampleColumn(
        { connectionId: 'warehouse', table: { catalog: 'analytics', db: 'dbo', name: 'orders' }, column: 'status', limit: 5 },
        { runId: 'scan-run-1' },
      ),
    ).resolves.toMatchObject({ values: ['paid', 'open'], nullCount: null, distinctCount: null });

    await expect(
      connector.getColumnDistinctValues(
        { catalog: 'analytics', db: 'dbo', name: 'orders' },
        'status',
        { maxCardinality: 5, limit: 10, sampleSize: 100 },
      ),
    ).resolves.toEqual({ values: ['open', 'paid'], cardinality: 2 });

    await expect(
      connector.executeReadOnly(
        { connectionId: 'warehouse', sql: 'select id, status from dbo.orders', maxRows: 1 },
        { runId: 'scan-run-1' },
      ),
    ).resolves.toMatchObject({ headers: ['id', 'status'], rows: [[10, 'paid']], totalRows: 1, rowCount: 1 });

    await expect(
      connector.executeReadOnly({ connectionId: 'warehouse', sql: 'delete from orders' }, { runId: 'scan-run-1' }),
    ).rejects.toThrow('Only read-only SELECT/WITH queries can be executed locally');

    await expect(connector.getTableRowCount('orders')).resolves.toBe(2);
    await expect(connector.listSchemas()).resolves.toEqual(['dbo', 'sales']);
    await expect(connector.listTables(['dbo'])).resolves.toEqual([
      { catalog: 'analytics', schema: 'dbo', name: 'customers', kind: 'table' },
      { catalog: 'analytics', schema: 'dbo', name: 'order_summary', kind: 'view' },
      { catalog: 'analytics', schema: 'dbo', name: 'orders', kind: 'table' },
    ]);
    await expect(
      connector.columnStats(
        { connectionId: 'warehouse', table: { catalog: 'analytics', db: 'dbo', name: 'orders' }, column: 'status' },
        { runId: 'scan-run-1' },
      ),
    ).resolves.toBeNull();

    await connector.cleanup();
  });

  it('sets requestTimeout to the resolved deadline and maps an ETIMEOUT to KtxQueryError', async () => {
    expect(
      sqlServerConnectionPoolConfigFromConfig({
        connectionId: 'warehouse',
        connection: {
          driver: 'sqlserver',
          host: 'db.example.test',
          database: 'analytics',
          username: 'reader',
          query_timeout_ms: 5_000,
        },
      }),
    ).toMatchObject({ requestTimeout: 5_000 });

    const timeoutError = Object.assign(new Error('Timeout: Request failed to complete in 5000ms'), { code: 'ETIMEOUT' });
    const poolFactory: KtxSqlServerPoolFactory = {
      createPool: vi.fn(async () => {
        const request = {
          input: vi.fn(() => request),
          query: vi.fn(async () => {
            throw timeoutError;
          }),
        };
        return { request: () => request, close: vi.fn(async () => undefined) };
      }),
    };
    const connector = new KtxSqlServerScanConnector({
      connectionId: 'warehouse',
      connection: {
        driver: 'sqlserver',
        host: 'db.example.test',
        database: 'analytics',
        username: 'reader',
        query_timeout_ms: 5_000,
      },
      poolFactory,
    });

    const execution = connector.executeReadOnly(
      { connectionId: 'warehouse', sql: 'select count(*) from dbo.orders' },
      { runId: 'scan-run-1' },
    );
    await expect(execution).rejects.toBeInstanceOf(KtxQueryError);
    await expect(execution).rejects.toThrow('query exceeded 5s');
  });

  it('hoists leading CTEs before applying the SQL Server TOP wrapper', async () => {
    const queries: string[] = [];
    const request = {
      input: vi.fn((_name: string, _value: unknown) => request),
      query: vi.fn(async (sql: string): Promise<KtxSqlServerQueryResult> => {
        queries.push(sql);
        return result([{ value: 1 }], ['value']);
      }),
    };
    const poolFactory: KtxSqlServerPoolFactory = {
      createPool: vi.fn(async () => ({
        request: () => request,
        close: vi.fn(async () => undefined),
      })),
    };
    const connector = new KtxSqlServerScanConnector({
      connectionId: 'warehouse',
      connection: {
        driver: 'sqlserver',
        host: 'db.example.test',
        database: 'analytics',
        username: 'reader',
        schema: 'dbo',
      },
      poolFactory,
    });

    await expect(
      connector.executeReadOnly(
        {
          connectionId: 'warehouse',
          sql: 'WITH child_values AS (SELECT 1 AS value) SELECT value FROM child_values',
          maxRows: 1,
        },
        { runId: 'scan-run-sqlserver-cte-limit' },
      ),
    ).resolves.toMatchObject({ headers: ['value'], rows: [[1]], rowCount: 1 });

    expect(queries).toEqual([
      'WITH child_values AS (SELECT 1 AS value) SELECT TOP 1 * FROM (SELECT value FROM child_values) AS ktx_query_result',
    ]);
    expect(queries[0]).not.toContain('FROM (WITH');
  });

  it('limits introspection to tables in tableScope', async () => {
    const queries: string[] = [];
    const inputs: Array<{ name: string; value: unknown }> = [];
    const request = {
      input: vi.fn((name: string, value: unknown) => {
        inputs.push({ name, value });
        return request;
      }),
      query: vi.fn(async (sql: string): Promise<KtxSqlServerQueryResult> => {
        queries.push(sql);
        if (sql.includes('INFORMATION_SCHEMA.TABLES')) {
          return result([{ table_name: 'orders', table_type: 'BASE TABLE' }], ['table_name', 'table_type']);
        }
        if (sql.includes('INFORMATION_SCHEMA.COLUMNS')) {
          return result(
            [{ table_name: 'orders', column_name: 'id', data_type: 'int', is_nullable: 'NO' }],
            ['table_name', 'column_name', 'data_type', 'is_nullable'],
          );
        }
        return result([], []);
      }),
    };
    const poolFactory: KtxSqlServerPoolFactory = {
      createPool: vi.fn(async () => ({
        request: () => request,
        close: vi.fn(async () => undefined),
      })),
    };
    const connector = new KtxSqlServerScanConnector({
      connectionId: 'warehouse',
      connection: {
        driver: 'sqlserver',
        host: 'db.example.test',
        database: 'analytics',
        username: 'reader',
        schema: 'dbo',
      },
      poolFactory,
    });
    const scope = tableRefSet([{ catalog: 'analytics', db: 'dbo', name: 'orders' }]);
    const snapshot = await connector.introspect(
      { connectionId: 'warehouse', driver: 'sqlserver', tableScope: scope },
      { runId: 'scope-test' },
    );
    expect(snapshot.tables.map((table) => table.name)).toEqual(['orders']);
    expect(queries.find((query) => query.includes('INFORMATION_SCHEMA.TABLES'))).toMatch(/TABLE_NAME IN \(@table_0\)/);
    expect(inputs).toEqual(expect.arrayContaining([{ name: 'table_0', value: 'orders' }]));
  });

  it('adapts native SQL Server snapshots to live-database introspection for local ingest', async () => {
    const introspection = createSqlServerLiveDatabaseIntrospection({
      connections: {
        warehouse: {
          driver: 'sqlserver',
          host: 'db.example.test',
          database: 'analytics',
          username: 'reader',
          schema: 'dbo',
        },
      },
      poolFactory: fakePoolFactory(),
      now: () => new Date('2026-04-29T16:00:00.000Z'),
    });

    const snapshot = await introspection.extractSchema('warehouse');

    expect(snapshot).toMatchObject({
      connectionId: 'warehouse',
      extractedAt: '2026-04-29T16:00:00.000Z',
    });
    expect(snapshot.tables.find((table) => table.name === 'customers')).toMatchObject({
      name: 'customers',
      catalog: 'analytics',
      db: 'dbo',
      columns: [
        {
          name: 'id',
          nativeType: 'int',
          normalizedType: 'int',
          dimensionType: 'number',
          nullable: false,
          primaryKey: true,
          comment: 'PK',
        },
        {
          name: 'name',
          nativeType: 'nvarchar',
          normalizedType: 'nvarchar',
          dimensionType: 'string',
          nullable: false,
          primaryKey: false,
          comment: null,
        },
      ],
      foreignKeys: [],
    });
  });
});
