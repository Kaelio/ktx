import { describe, expect, it, vi } from 'vitest';
import type { FieldPacket, RowDataPacket } from 'mysql2/promise';
import { KtxQueryError } from '../../../src/errors.js';
import { createMysqlLiveDatabaseIntrospection } from '../../../src/connectors/mysql/live-database-introspection.js';
import { isKtxMysqlConnectionConfig, KtxMysqlScanConnector, mysqlConnectionPoolConfigFromConfig, prepareMysqlReadOnlyQuery, type KtxMysqlConnectionConfig, type KtxMysqlPoolFactory } from '../../../src/connectors/mysql/connector.js';
import { tableRefSet } from '../../../src/context/scan/table-ref.js';

function mysqlResult(rows: Record<string, unknown>[], fields: Array<{ name: string; type?: number }>): [RowDataPacket[], FieldPacket[]] {
  return [rows as RowDataPacket[], fields as FieldPacket[]];
}

function fakePoolFactory(): KtxMysqlPoolFactory {
  const query = vi.fn(async (sql: string, params?: unknown): Promise<[RowDataPacket[], FieldPacket[]]> => {
    if (sql.includes('INFORMATION_SCHEMA.TABLES')) {
      return mysqlResult(
        [
          { TABLE_SCHEMA: 'analytics', TABLE_NAME: 'customers', TABLE_TYPE: 'BASE TABLE', TABLE_COMMENT: 'Customer table', TABLE_ROWS: 2 },
          { TABLE_SCHEMA: 'analytics', TABLE_NAME: 'orders', TABLE_TYPE: 'BASE TABLE', TABLE_COMMENT: 'InnoDB free: 1 kB; Order table', TABLE_ROWS: 2 },
          { TABLE_SCHEMA: 'analytics', TABLE_NAME: 'order_summary', TABLE_TYPE: 'VIEW', TABLE_COMMENT: '', TABLE_ROWS: null },
        ],
        [{ name: 'TABLE_NAME' }, { name: 'TABLE_TYPE' }, { name: 'TABLE_COMMENT' }, { name: 'TABLE_ROWS' }],
      );
    }
    if (sql.includes('INFORMATION_SCHEMA.COLUMNS')) {
      return mysqlResult(
        [
          { TABLE_NAME: 'customers', COLUMN_NAME: 'id', DATA_TYPE: 'int', IS_NULLABLE: 'NO', COLUMN_COMMENT: 'PK' },
          { TABLE_NAME: 'customers', COLUMN_NAME: 'name', DATA_TYPE: 'varchar', IS_NULLABLE: 'NO', COLUMN_COMMENT: '' },
          { TABLE_NAME: 'orders', COLUMN_NAME: 'id', DATA_TYPE: 'int', IS_NULLABLE: 'NO', COLUMN_COMMENT: '' },
          { TABLE_NAME: 'orders', COLUMN_NAME: 'customer_id', DATA_TYPE: 'int', IS_NULLABLE: 'NO', COLUMN_COMMENT: '' },
          { TABLE_NAME: 'orders', COLUMN_NAME: 'status', DATA_TYPE: 'varchar', IS_NULLABLE: 'YES', COLUMN_COMMENT: '' },
          { TABLE_NAME: 'order_summary', COLUMN_NAME: 'status', DATA_TYPE: 'varchar', IS_NULLABLE: 'YES', COLUMN_COMMENT: '' },
        ],
        [{ name: 'TABLE_NAME' }, { name: 'COLUMN_NAME' }, { name: 'DATA_TYPE' }, { name: 'IS_NULLABLE' }],
      );
    }
    if (sql.includes('INFORMATION_SCHEMA.KEY_COLUMN_USAGE') && sql.includes("CONSTRAINT_NAME = 'PRIMARY'")) {
      return mysqlResult([{ TABLE_NAME: 'customers', COLUMN_NAME: 'id' }, { TABLE_NAME: 'orders', COLUMN_NAME: 'id' }], []);
    }
    if (sql.includes('INFORMATION_SCHEMA.KEY_COLUMN_USAGE') && sql.includes('REFERENCED_TABLE_NAME IS NOT NULL')) {
      return mysqlResult(
        [
          {
            TABLE_NAME: 'orders',
            COLUMN_NAME: 'customer_id',
            REFERENCED_TABLE_NAME: 'customers',
            REFERENCED_COLUMN_NAME: 'id',
            CONSTRAINT_NAME: 'orders_customer_id_fk',
          },
        ],
        [],
      );
    }
    if (sql.includes('SELECT `id`, `status` FROM `analytics`.`orders` LIMIT 1')) {
      return mysqlResult([{ id: 10, status: 'paid' }], [{ name: 'id', type: 3 }, { name: 'status', type: 253 }]);
    }
    if (sql.includes('select * from (select id, status from analytics.orders) as ktx_query_result limit 1')) {
      return mysqlResult([{ id: 10, status: 'paid' }], [{ name: 'id', type: 3 }, { name: 'status', type: 253 }]);
    }
    if (sql.includes('SELECT `status` FROM `analytics`.`orders`')) {
      return mysqlResult([{ status: 'paid' }, { status: 'open' }], [{ name: 'status', type: 253 }]);
    }
    if (sql.includes('COUNT(DISTINCT val)')) {
      return mysqlResult([{ cardinality: 2 }], [{ name: 'cardinality', type: 8 }]);
    }
    if (sql.includes('SELECT DISTINCT CAST(`status` AS CHAR) AS val')) {
      return mysqlResult([{ val: 'open' }, { val: 'paid' }], [{ name: 'val', type: 253 }]);
    }
    if (sql.includes('COUNT(*) AS count')) {
      return mysqlResult([{ count: 2 }], [{ name: 'count', type: 8 }]);
    }
    if (sql.includes('INFORMATION_SCHEMA.SCHEMATA')) {
      return mysqlResult([{ SCHEMA_NAME: 'analytics' }, { SCHEMA_NAME: 'warehouse' }], [{ name: 'SCHEMA_NAME' }]);
    }
    if (sql.trim() === 'SELECT 1') {
      return mysqlResult([{ '1': 1 }], [{ name: '1', type: 8 }]);
    }
    if (sql.includes('INFORMATION_SCHEMA.STATISTICS')) {
      expect(sql).toContain('SEQ_IN_INDEX = 1');
      return mysqlResult(
        [
          { column_name: 'id', estimated_cardinality: 2 },
          { column_name: 'customer_id', estimated_cardinality: 2 },
        ],
        [{ name: 'column_name' }, { name: 'estimated_cardinality' }],
      );
    }
    if (/^\s*SET SESSION max_execution_time/i.test(sql)) {
      return mysqlResult([], []);
    }
    throw new Error(`Unexpected SQL: ${sql} params=${JSON.stringify(params)}`);
  });
  const release = vi.fn();
  const end = vi.fn(async () => undefined);
  return {
    createPool: vi.fn(() => ({
      getConnection: vi.fn(async () => ({ query, release })),
      end,
    })),
  };
}

function multiSchemaMysqlPoolFactory(
  options: { primaryKeyError?: Error; foreignKeyError?: Error } = {},
): KtxMysqlPoolFactory {
  const query = vi.fn(async (sql: string, params?: unknown): Promise<[RowDataPacket[], FieldPacket[]]> => {
    if (sql.includes('INFORMATION_SCHEMA.TABLES')) {
      expect(params).toEqual(['analytics', 'mart']);
      return mysqlResult(
        [
          {
            TABLE_SCHEMA: 'analytics',
            TABLE_NAME: 'customers',
            TABLE_TYPE: 'BASE TABLE',
            TABLE_COMMENT: '',
            TABLE_ROWS: 2,
          },
          {
            TABLE_SCHEMA: 'mart',
            TABLE_NAME: 'orders',
            TABLE_TYPE: 'BASE TABLE',
            TABLE_COMMENT: '',
            TABLE_ROWS: 3,
          },
        ],
        [
          { name: 'TABLE_SCHEMA' },
          { name: 'TABLE_NAME' },
          { name: 'TABLE_TYPE' },
          { name: 'TABLE_COMMENT' },
          { name: 'TABLE_ROWS' },
        ],
      );
    }
    if (sql.includes('INFORMATION_SCHEMA.COLUMNS')) {
      expect(params).toEqual(['analytics', 'mart']);
      return mysqlResult(
        [
          {
            TABLE_SCHEMA: 'analytics',
            TABLE_NAME: 'customers',
            COLUMN_NAME: 'id',
            DATA_TYPE: 'int',
            IS_NULLABLE: 'NO',
            COLUMN_COMMENT: '',
          },
          {
            TABLE_SCHEMA: 'mart',
            TABLE_NAME: 'orders',
            COLUMN_NAME: 'id',
            DATA_TYPE: 'int',
            IS_NULLABLE: 'NO',
            COLUMN_COMMENT: '',
          },
        ],
        [],
      );
    }
    if (sql.includes('INFORMATION_SCHEMA.KEY_COLUMN_USAGE') && sql.includes("CONSTRAINT_NAME = 'PRIMARY'")) {
      if (options.primaryKeyError) {
        throw options.primaryKeyError;
      }
      expect(params).toEqual(['analytics', 'mart']);
      return mysqlResult(
        [
          { TABLE_SCHEMA: 'analytics', TABLE_NAME: 'customers', COLUMN_NAME: 'id' },
          { TABLE_SCHEMA: 'mart', TABLE_NAME: 'orders', COLUMN_NAME: 'id' },
        ],
        [],
      );
    }
    if (sql.includes('INFORMATION_SCHEMA.KEY_COLUMN_USAGE') && sql.includes('REFERENCED_TABLE_NAME IS NOT NULL')) {
      if (options.foreignKeyError) {
        throw options.foreignKeyError;
      }
      expect(params).toEqual(['analytics', 'mart']);
      return mysqlResult([], []);
    }
    if (/^\s*SET SESSION max_execution_time/i.test(sql)) {
      return mysqlResult([], []);
    }
    throw new Error(`Unexpected SQL: ${sql} params=${JSON.stringify(params)}`);
  });
  return {
    createPool: vi.fn(() => ({
      getConnection: vi.fn(async () => ({ query, release: vi.fn() })),
      end: vi.fn(async () => undefined),
    })),
  };
}

describe('KtxMysqlScanConnector', () => {
  it('prepares read-only SQL parameters with MySQL positional placeholders', () => {
    expect(
      prepareMysqlReadOnlyQuery('select * from orders where id = :id and status = :status', {
        status: 'paid',
        id: 10,
      }),
    ).toEqual({
      sql: 'select * from orders where id = ? and status = ?',
      params: [10, 'paid'],
    });
    expect(prepareMysqlReadOnlyQuery('select 1')).toEqual({ sql: 'select 1', params: undefined });
  });

  it('resolves MySQL connection configuration safely', () => {
    expect(isKtxMysqlConnectionConfig({ driver: 'mysql', host: 'localhost', database: 'analytics' })).toBe(true);
    expect(isKtxMysqlConnectionConfig({ driver: 'postgres', host: 'localhost', database: 'analytics' })).toBe(false);
    expect(
      mysqlConnectionPoolConfigFromConfig({
        connectionId: 'warehouse',
        connection: {
          driver: 'mysql',
          host: 'db.example.test',
          port: 3307,
          database: 'analytics',
          username: 'reader',
          password: 'secret', // pragma: allowlist secret
          ssl: true,
        },
      }),
    ).toMatchObject({
      host: 'db.example.test',
      port: 3307,
      database: 'analytics',
      user: 'reader',
      password: 'secret', // pragma: allowlist secret
      ssl: { rejectUnauthorized: false },
    });
  });

  it('defaults and validates MySQL maxConnections', () => {
    const baseConnection: KtxMysqlConnectionConfig = {
      driver: 'mysql',
      host: 'db.example.test',
      database: 'analytics',
      username: 'reader',
      password: 'secret', // pragma: allowlist secret
    };

    expect(
      mysqlConnectionPoolConfigFromConfig({
        connectionId: 'warehouse',
        connection: baseConnection,
      }),
    ).toMatchObject({ connectionLimit: 10 });

    expect(
      mysqlConnectionPoolConfigFromConfig({
        connectionId: 'warehouse',
        connection: { ...baseConnection, maxConnections: 25 },
      }),
    ).toMatchObject({ connectionLimit: 25 });

    expect(
      mysqlConnectionPoolConfigFromConfig({
        connectionId: 'warehouse',
        connection: { ...baseConnection, maxConnections: '12' as never },
      }),
    ).toMatchObject({ connectionLimit: 12 });

    for (const maxConnections of [0, -1, 1.5, Number.NaN, 'abc' as never]) {
      expect(() =>
        mysqlConnectionPoolConfigFromConfig({
          connectionId: 'warehouse',
          connection: { ...baseConnection, maxConnections },
        }),
      ).toThrow('connections.warehouse.maxConnections must be a positive integer');
    }
  });

  it('introspects schema, primary keys, comments, row counts, views, and foreign keys', async () => {
    const connector = new KtxMysqlScanConnector({
      connectionId: 'warehouse',
      connection: {
        driver: 'mysql',
        host: 'db.example.test',
        database: 'analytics',
        username: 'reader',
        password: 'secret', // pragma: allowlist secret
      },
      poolFactory: fakePoolFactory(),
      now: () => new Date('2026-04-29T12:00:00.000Z'),
    });

    const snapshot = await connector.introspect(
      { connectionId: 'warehouse', driver: 'mysql' },
      { runId: 'scan-run-1' },
    );

    expect(snapshot).toMatchObject({
      connectionId: 'warehouse',
      driver: 'mysql',
      extractedAt: '2026-04-29T12:00:00.000Z',
      scope: { schemas: ['analytics'] },
      metadata: {
        database: 'analytics',
        host: 'db.example.test',
        table_count: 3,
        total_columns: 6,
      },
    });
    expect(snapshot.tables.map((table) => [table.name, table.kind, table.estimatedRows, table.comment])).toEqual([
      ['customers', 'table', 2, 'Customer table'],
      ['orders', 'table', 2, 'Order table'],
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
        toCatalog: null,
        toDb: 'analytics',
        toTable: 'customers',
        toColumn: 'id',
        constraintName: 'orders_customer_id_fk',
      },
    ]);
  });

  it('introspects every configured MySQL schema scope', async () => {
    const connector = new KtxMysqlScanConnector({
      connectionId: 'warehouse',
      connection: {
        driver: 'mysql',
        host: 'db.example.test',
        database: 'analytics',
        schemas: ['analytics', 'mart'],
        username: 'reader',
        password: 'secret', // pragma: allowlist secret
      },
      poolFactory: multiSchemaMysqlPoolFactory(),
      now: () => new Date('2026-05-21T10:00:00.000Z'),
    });

    const snapshot = await connector.introspect(
      { connectionId: 'warehouse', driver: 'mysql' },
      { runId: 'scan-run-1' },
    );

    expect(snapshot.scope).toEqual({ schemas: ['analytics', 'mart'] });
    expect(snapshot.metadata).toMatchObject({ database: 'analytics', schemas: ['analytics', 'mart'] });
    expect(snapshot.tables.map((table) => `${table.db}.${table.name}`)).toEqual([
      'analytics.customers',
      'mart.orders',
    ]);
  });

  it('soft-fails denied MySQL constraint discovery with one warning per schema and kind', async () => {
    const connector = new KtxMysqlScanConnector({
      connectionId: 'warehouse',
      connection: {
        driver: 'mysql',
        host: 'db.example.test',
        database: 'analytics',
        schemas: ['analytics', 'mart'],
        username: 'reader',
        password: 'secret', // pragma: allowlist secret
      },
      poolFactory: multiSchemaMysqlPoolFactory({
        primaryKeyError: Object.assign(new Error('select command denied'), {
          code: 'ER_TABLEACCESS_DENIED_ERROR',
          errno: 1142,
        }),
        foreignKeyError: Object.assign(new Error('database access denied'), {
          code: 'ER_DBACCESS_DENIED_ERROR',
          errno: 1044,
        }),
      }),
      now: () => new Date('2026-04-29T12:00:00.000Z'),
    });

    const snapshot = await connector.introspect(
      { connectionId: 'warehouse', driver: 'mysql' },
      { runId: 'scan-run-mysql-denied-constraints' },
    );

    expect(snapshot.warnings).toEqual([
      {
        code: 'constraint_discovery_unauthorized',
        message: 'Skipped primary-key discovery in analytics (insufficient grants on system catalogs)',
        recoverable: true,
        metadata: { schema: 'analytics', kind: 'primary_key' },
      },
      {
        code: 'constraint_discovery_unauthorized',
        message: 'Skipped primary-key discovery in mart (insufficient grants on system catalogs)',
        recoverable: true,
        metadata: { schema: 'mart', kind: 'primary_key' },
      },
      {
        code: 'constraint_discovery_unauthorized',
        message: 'Skipped foreign-key discovery in analytics (insufficient grants on system catalogs)',
        recoverable: true,
        metadata: { schema: 'analytics', kind: 'foreign_key' },
      },
      {
        code: 'constraint_discovery_unauthorized',
        message: 'Skipped foreign-key discovery in mart (insufficient grants on system catalogs)',
        recoverable: true,
        metadata: { schema: 'mart', kind: 'foreign_key' },
      },
    ]);
    expect(snapshot.tables.every((table) => table.columns.every((column) => column.primaryKey === false))).toBe(true);
    expect(snapshot.tables.every((table) => table.foreignKeys.length === 0)).toBe(true);
  });

  it('limits introspection to tables in tableScope', async () => {
    const queries: Array<{ sql: string; params?: unknown }> = [];
    const poolFactory: KtxMysqlPoolFactory = {
      createPool: vi.fn(() => ({
        getConnection: vi.fn(async () => ({
          query: vi.fn(async (sql: string, params?: unknown): Promise<[RowDataPacket[], FieldPacket[]]> => {
            queries.push({ sql, params });
            if (sql.includes('INFORMATION_SCHEMA.TABLES')) {
              return mysqlResult(
                [
                  {
                    TABLE_SCHEMA: 'analytics',
                    TABLE_NAME: 'orders',
                    TABLE_TYPE: 'BASE TABLE',
                    TABLE_COMMENT: '',
                    TABLE_ROWS: 2,
                  },
                ],
                [],
              );
            }
            if (sql.includes('INFORMATION_SCHEMA.COLUMNS')) {
              return mysqlResult(
                [
                  {
                    TABLE_SCHEMA: 'analytics',
                    TABLE_NAME: 'orders',
                    COLUMN_NAME: 'id',
                    DATA_TYPE: 'int',
                    IS_NULLABLE: 'NO',
                    COLUMN_COMMENT: '',
                  },
                ],
                [],
              );
            }
            return mysqlResult([], []);
          }),
          release: vi.fn(),
        })),
        end: vi.fn(async () => undefined),
      })),
    };
    const connector = new KtxMysqlScanConnector({
      connectionId: 'warehouse',
      connection: {
        driver: 'mysql',
        host: 'db.example.test',
        database: 'analytics',
        username: 'reader',
        password: 'secret', // pragma: allowlist secret
      },
      poolFactory,
    });
    const scope = tableRefSet([{ catalog: null, db: 'analytics', name: 'orders' }]);
    const snapshot = await connector.introspect(
      { connectionId: 'warehouse', driver: 'mysql', tableScope: scope },
      { runId: 'scope-test' },
    );
    expect(snapshot.tables.map((table) => table.name)).toEqual(['orders']);
    const tablesQuery = queries.find((query) => query.sql.includes('INFORMATION_SCHEMA.TABLES'));
    expect(tablesQuery?.sql).toMatch(/TABLE_NAME IN \(\?\)/);
    expect(tablesQuery?.params).toEqual(['analytics', 'orders']);
  });

  it('runs samples, distinct values, read-only SQL, row count, schema list, and cleanup', async () => {
    const poolFactory = fakePoolFactory();
    const connector = new KtxMysqlScanConnector({
      connectionId: 'warehouse',
      connection: {
        driver: 'mysql',
        host: 'db.example.test',
        database: 'analytics',
        username: 'reader',
        password: 'secret', // pragma: allowlist secret
      },
      poolFactory,
    });

    await expect(
      connector.sampleTable(
        { connectionId: 'warehouse', table: { catalog: null, db: 'analytics', name: 'orders' }, columns: ['id', 'status'], limit: 1 },
        { runId: 'scan-run-1' },
      ),
    ).resolves.toEqual({ headers: ['id', 'status'], rows: [[10, 'paid']], totalRows: 1 });

    await expect(
      connector.sampleColumn(
        { connectionId: 'warehouse', table: { catalog: null, db: 'analytics', name: 'orders' }, column: 'status', limit: 5 },
        { runId: 'scan-run-1' },
      ),
    ).resolves.toMatchObject({ values: ['paid', 'open'], nullCount: null, distinctCount: null });

    await expect(
      connector.getColumnDistinctValues(
        { catalog: null, db: 'analytics', name: 'orders' },
        'status',
        { maxCardinality: 5, limit: 10, sampleSize: 100 },
      ),
    ).resolves.toEqual({ values: ['open', 'paid'], cardinality: 2 });

    await expect(
      connector.executeReadOnly(
        { connectionId: 'warehouse', sql: 'select id, status from analytics.orders', maxRows: 1 },
        { runId: 'scan-run-1' },
      ),
    ).resolves.toMatchObject({ headers: ['id', 'status'], rows: [[10, 'paid']], totalRows: 1, rowCount: 1 });

    await expect(
      connector.executeReadOnly({ connectionId: 'warehouse', sql: 'delete from orders' }, { runId: 'scan-run-1' }),
    ).rejects.toThrow('Only read-only SELECT/WITH queries can be executed locally');

    await expect(connector.getTableRowCount('orders')).resolves.toBe(2);
    await expect(connector.listSchemas()).resolves.toEqual(['analytics', 'warehouse']);
    await expect(connector.listTables(['analytics'])).resolves.toEqual([
      { catalog: null, schema: 'analytics', name: 'customers', kind: 'table' },
      { catalog: null, schema: 'analytics', name: 'orders', kind: 'table' },
      { catalog: null, schema: 'analytics', name: 'order_summary', kind: 'view' },
    ]);
    await expect(
      connector.columnStats(
        { connectionId: 'warehouse', table: { catalog: null, db: 'analytics', name: 'orders' }, column: 'id' },
        { runId: 'scan-run-1' },
      ),
    ).resolves.toEqual({ min: null, max: null, average: null, nullCount: null, distinctCount: 2 });

    await expect(
      connector.columnStats(
        { connectionId: 'warehouse', table: { catalog: null, db: 'analytics', name: 'orders' }, column: 'status' },
        { runId: 'scan-run-1' },
      ),
    ).resolves.toBeNull();

    await expect(
      connector.getColumnStatistics({ catalog: null, db: 'analytics', name: 'orders' }),
    ).resolves.toMatchObject({
      cardinalityByColumn: new Map([['id', 2], ['customer_id', 2]]),
    });

    await connector.cleanup();
  });

  it('adapts native MySQL snapshots to live-database introspection for local ingest', async () => {
    const introspection = createMysqlLiveDatabaseIntrospection({
      connections: {
        warehouse: {
          driver: 'mysql',
          host: 'db.example.test',
          database: 'analytics',
          username: 'reader',
          password: 'secret', // pragma: allowlist secret
        },
      },
      poolFactory: fakePoolFactory(),
      now: () => new Date('2026-04-29T12:00:00.000Z'),
    });

    const snapshot = await introspection.extractSchema('warehouse');

    expect(snapshot).toMatchObject({
      connectionId: 'warehouse',
      extractedAt: '2026-04-29T12:00:00.000Z',
    });
    expect(snapshot.tables.find((table) => table.name === 'customers')).toMatchObject({
      name: 'customers',
      catalog: null,
      db: 'analytics',
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
          nativeType: 'varchar',
          normalizedType: 'varchar',
          dimensionType: 'string',
          nullable: false,
          primaryKey: false,
          comment: null,
        },
      ],
      foreignKeys: [],
    });
  });

  it('sets session max_execution_time to the resolved deadline and maps errno 3024 to KtxQueryError', async () => {
    const issued: Array<{ sql: string; params?: unknown }> = [];
    const timeoutError = Object.assign(new Error('Query execution was interrupted, maximum statement execution time exceeded'), {
      errno: 3024,
      code: 'ER_QUERY_TIMEOUT',
    });
    const poolFactory: KtxMysqlPoolFactory = {
      createPool: vi.fn(() => ({
        getConnection: vi.fn(async () => ({
          query: vi.fn(async (sql: string, params?: unknown) => {
            issued.push({ sql, params });
            if (/^\s*SET SESSION max_execution_time/i.test(sql)) {
              return [[], []] as [RowDataPacket[], FieldPacket[]];
            }
            throw timeoutError;
          }),
          release: vi.fn(),
        })),
        end: vi.fn(async () => undefined),
      })),
    };
    const connector = new KtxMysqlScanConnector({
      connectionId: 'warehouse',
      connection: {
        driver: 'mysql',
        host: 'db.example.test',
        database: 'analytics',
        username: 'reader',
        password: 'test-password', // pragma: allowlist secret
        query_timeout_ms: 5_000,
      },
      poolFactory,
    });

    const execution = connector.executeReadOnly(
      { connectionId: 'warehouse', sql: 'select count(*) from orders' },
      { runId: 'scan-run-1' },
    );
    await expect(execution).rejects.toBeInstanceOf(KtxQueryError);
    await expect(execution).rejects.toThrow('query exceeded 5s');
    expect(issued[0]).toEqual({ sql: 'SET SESSION max_execution_time = ?', params: [5_000] });
  });
});
