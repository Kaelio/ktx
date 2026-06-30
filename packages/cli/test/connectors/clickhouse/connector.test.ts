import { describe, expect, it, vi } from 'vitest';
import { KtxQueryError } from '../../../src/errors.js';
import { clickHouseClientConfigFromConfig, isKtxClickHouseConnectionConfig, KtxClickHouseScanConnector, prepareClickHouseReadOnlyQuery, type KtxClickHouseClientFactory } from '../../../src/connectors/clickhouse/connector.js';
import { createClickHouseLiveDatabaseIntrospection } from '../../../src/connectors/clickhouse/live-database-introspection.js';
import { tableRefSet } from '../../../src/context/scan/table-ref.js';

function result<T>(payload: T) {
  return {
    async json(): Promise<T> {
      return payload;
    },
  };
}

function fakeClientFactory(): KtxClickHouseClientFactory {
  const query = vi.fn(async (input: { query: string; format: string; query_params?: Record<string, unknown> }) => {
    if (input.query.includes('FROM system.tables')) {
      return result([
        { database: 'analytics', name: 'event_summary', engine: 'View', comment: '' },
        { database: 'analytics', name: 'events', engine: 'MergeTree', comment: 'Event stream' },
      ]);
    }
    if (input.query.includes('FROM system.columns')) {
      return result([
        { table: 'events', name: 'id', type: 'UInt64', comment: 'PK', is_in_primary_key: 1 },
        { table: 'events', name: 'event_name', type: 'LowCardinality(String)', comment: '', is_in_primary_key: 0 },
        { table: 'event_summary', name: 'event_name', type: 'String', comment: '', is_in_primary_key: 0 },
      ]);
    }
    if (input.query.includes('FROM system.parts') && input.query.includes('GROUP BY')) {
      return result([{ table: 'events', row_count: '2' }]);
    }
    if (input.query.includes('SELECT `id`, `event_name` FROM `analytics`.`events` LIMIT 1')) {
      return result({
        meta: [
          { name: 'id', type: 'UInt64' },
          { name: 'event_name', type: 'String' },
        ],
        data: [[10, 'signup']],
        rows: 1,
      });
    }
    if (input.query.includes('SELECT `event_name` FROM `analytics`.`events`')) {
      return result({
        meta: [{ name: 'event_name', type: 'String' }],
        data: [['signup'], ['purchase']],
        rows: 2,
      });
    }
    if (input.query.includes('COUNT(DISTINCT val)')) {
      return result({
        meta: [{ name: 'cardinality', type: 'UInt64' }],
        data: [[2]],
        rows: 1,
      });
    }
    if (input.query.includes('SELECT DISTINCT toString(`event_name`) AS val')) {
      return result({
        meta: [{ name: 'val', type: 'String' }],
        data: [['purchase'], ['signup']],
        rows: 2,
      });
    }
    if (input.query.includes('sum(rows) AS count')) {
      return result({
        meta: [{ name: 'count', type: 'UInt64' }],
        data: [[2]],
        rows: 1,
      });
    }
    if (input.query.includes('FROM system.databases')) {
      return result([{ name: 'analytics' }, { name: 'warehouse' }]);
    }
    if (input.query.trim() === 'SELECT 1') {
      return result({ meta: [{ name: '1', type: 'UInt8' }], data: [[1]], rows: 1 });
    }
    if (input.query.includes('select * from (select id, event_name from analytics.events) as ktx_query_result limit 1')) {
      return result({
        meta: [
          { name: 'id', type: 'UInt64' },
          { name: 'event_name', type: 'String' },
        ],
        data: [[10, 'signup']],
        rows: 1,
      });
    }
    throw new Error(`Unexpected SQL: ${input.query}`);
  });
  const close = vi.fn(async () => undefined);
  return {
    createClient: vi.fn(() => ({ query, close })),
  };
}

function multiDatabaseClickHouseClientFactory(): KtxClickHouseClientFactory {
  const query = vi.fn(async (input: { query: string; format: string; query_params?: Record<string, unknown> }) => {
    if (input.query.includes('FROM system.tables')) {
      expect(input.query_params).toEqual({ databases: ['analytics', 'mart'] });
      return result([
        { database: 'analytics', name: 'events', engine: 'MergeTree', comment: 'Event stream' },
        { database: 'mart', name: 'order_events', engine: 'MergeTree', comment: '' },
      ]);
    }
    if (input.query.includes('FROM system.columns')) {
      expect(input.query_params).toEqual({ databases: ['analytics', 'mart'] });
      return result([
        {
          database: 'analytics',
          table: 'events',
          name: 'id',
          type: 'UInt64',
          comment: '',
          is_in_primary_key: 1,
        },
        {
          database: 'mart',
          table: 'order_events',
          name: 'id',
          type: 'UInt64',
          comment: '',
          is_in_primary_key: 1,
        },
      ]);
    }
    if (input.query.includes('FROM system.parts') && input.query.includes('GROUP BY')) {
      expect(input.query_params).toEqual({ databases: ['analytics', 'mart'] });
      return result([
        { database: 'analytics', table: 'events', row_count: '2' },
        { database: 'mart', table: 'order_events', row_count: '5' },
      ]);
    }
    throw new Error(`Unexpected SQL: ${input.query}`);
  });
  return {
    createClient: vi.fn(() => ({ query, close: vi.fn(async () => undefined) })),
  };
}

describe('KtxClickHouseScanConnector', () => {
  it('prepares read-only SQL parameters with ClickHouse typed placeholders', () => {
    expect(
      prepareClickHouseReadOnlyQuery('select * from events where id = :id and event_name = :name', {
        id: 10,
        name: 'signup',
      }),
    ).toEqual({
      sql: 'select * from events where id = {id:Int64} and event_name = {name:String}',
      params: { id: 10, name: 'signup' },
    });
    expect(
      prepareClickHouseReadOnlyQuery('select * from events where enabled = :enabled and ratio = :ratio and created_at = :created_at', {
        enabled: true,
        ratio: 1.5,
        created_at: new Date('2026-05-25T00:00:00.000Z'),
      }),
    ).toEqual({
      sql: 'select * from events where enabled = {enabled:Bool} and ratio = {ratio:Float64} and created_at = {created_at:DateTime}',
      params: {
        enabled: true,
        ratio: 1.5,
        created_at: new Date('2026-05-25T00:00:00.000Z'),
      },
    });
    expect(prepareClickHouseReadOnlyQuery('select 1')).toEqual({ sql: 'select 1', params: undefined });
  });

  it('resolves ClickHouse connection configuration safely', () => {
    expect(isKtxClickHouseConnectionConfig({ driver: 'clickhouse', host: 'localhost', database: 'analytics' })).toBe(
      true,
    );
    expect(isKtxClickHouseConnectionConfig({ driver: 'mysql', host: 'localhost', database: 'analytics' })).toBe(false);
    expect(
      clickHouseClientConfigFromConfig({
        connectionId: 'warehouse',
        connection: {
          driver: 'clickhouse',
          host: 'ch.example.test',
          port: 9440,
          database: 'analytics',
          username: 'reader',
          password: 'test-pass', // pragma: allowlist secret
          ssl: true,
        },
      }),
    ).toMatchObject({
      host: 'ch.example.test',
      port: 9440,
      database: 'analytics',
      username: 'reader',
      password: 'test-pass', // pragma: allowlist secret
      ssl: true,
    });
  });

  it('introspects schema, primary keys, comments, row counts, and views', async () => {
    const connector = new KtxClickHouseScanConnector({
      connectionId: 'warehouse',
      connection: {
        driver: 'clickhouse',
        host: 'ch.example.test',
        database: 'analytics',
        username: 'reader',
        password: 'test-pass', // pragma: allowlist secret
      },
      clientFactory: fakeClientFactory(),
      now: () => new Date('2026-04-29T14:00:00.000Z'),
    });

    const snapshot = await connector.introspect(
      { connectionId: 'warehouse', driver: 'clickhouse' },
      { runId: 'scan-run-1' },
    );

    expect(snapshot).toMatchObject({
      connectionId: 'warehouse',
      driver: 'clickhouse',
      extractedAt: '2026-04-29T14:00:00.000Z',
      scope: { schemas: ['analytics'] },
      metadata: {
        database: 'analytics',
        host: 'ch.example.test',
        table_count: 2,
        total_columns: 3,
      },
    });
    expect(snapshot.tables.map((table) => [table.name, table.kind, table.estimatedRows, table.comment])).toEqual([
      ['event_summary', 'view', null, null],
      ['events', 'table', 2, 'Event stream'],
    ]);
    expect(snapshot.tables.find((table) => table.name === 'events')?.columns[0]).toMatchObject({
      name: 'id',
      nativeType: 'UInt64',
      normalizedType: 'UInt64',
      dimensionType: 'number',
      nullable: false,
      primaryKey: true,
      comment: 'PK',
    });
    expect(snapshot.tables.find((table) => table.name === 'events')?.foreignKeys).toEqual([]);
  });

  it('introspects every configured ClickHouse database scope while preserving the default database', async () => {
    const connector = new KtxClickHouseScanConnector({
      connectionId: 'warehouse',
      connection: {
        driver: 'clickhouse',
        host: 'ch.example.test',
        database: 'analytics',
        databases: ['analytics', 'mart'],
        username: 'reader',
        password: 'test-pass', // pragma: allowlist secret
      },
      clientFactory: multiDatabaseClickHouseClientFactory(),
      now: () => new Date('2026-05-21T10:00:00.000Z'),
    });

    const snapshot = await connector.introspect(
      { connectionId: 'warehouse', driver: 'clickhouse' },
      { runId: 'scan-run-1' },
    );

    expect(snapshot.scope).toEqual({ schemas: ['analytics', 'mart'] });
    expect(snapshot.metadata).toMatchObject({ database: 'analytics', databases: ['analytics', 'mart'] });
    expect(snapshot.tables.map((table) => `${table.db}.${table.name}`)).toEqual([
      'analytics.events',
      'mart.order_events',
    ]);
  });

  it('limits introspection to tables in tableScope', async () => {
    const queries: Array<{ query: string; query_params?: Record<string, unknown> }> = [];
    const clientFactory: KtxClickHouseClientFactory = {
      createClient: vi.fn(() => ({
        query: vi.fn(async (input: { query: string; format: string; query_params?: Record<string, unknown> }) => {
          queries.push({ query: input.query, query_params: input.query_params });
          if (input.query.includes('FROM system.tables')) {
            return result([{ database: 'analytics', name: 'events', engine: 'MergeTree', comment: '' }]);
          }
          if (input.query.includes('FROM system.columns')) {
            return result([
              {
                database: 'analytics',
                table: 'events',
                name: 'id',
                type: 'UInt64',
                comment: '',
                is_in_primary_key: 1,
              },
            ]);
          }
          if (input.query.includes('FROM system.parts')) {
            return result([{ database: 'analytics', table: 'events', row_count: '2' }]);
          }
          throw new Error(`Unexpected SQL: ${input.query}`);
        }),
        close: vi.fn(async () => undefined),
      })),
    };
    const connector = new KtxClickHouseScanConnector({
      connectionId: 'warehouse',
      connection: {
        driver: 'clickhouse',
        host: 'ch.example.test',
        database: 'analytics',
        username: 'reader',
        password: 'test-pass', // pragma: allowlist secret
      },
      clientFactory,
    });
    const scope = tableRefSet([{ catalog: null, db: 'analytics', name: 'events' }]);
    const snapshot = await connector.introspect(
      { connectionId: 'warehouse', driver: 'clickhouse', tableScope: scope },
      { runId: 'scope-test' },
    );
    expect(snapshot.tables.map((table) => table.name)).toEqual(['events']);
    const tablesQuery = queries.find((query) => query.query.includes('FROM system.tables'));
    expect(tablesQuery?.query).toContain('AND name IN {table_names:Array(String)}');
    expect(tablesQuery?.query_params).toEqual({ databases: ['analytics'], table_names: ['events'] });
  });

  it('runs samples, distinct values, read-only SQL, row count, schema list, and cleanup', async () => {
    const clientFactory = fakeClientFactory();
    const connector = new KtxClickHouseScanConnector({
      connectionId: 'warehouse',
      connection: {
        driver: 'clickhouse',
        host: 'ch.example.test',
        database: 'analytics',
        username: 'reader',
        password: 'test-pass', // pragma: allowlist secret
      },
      clientFactory,
    });

    await expect(
      connector.sampleTable(
        {
          connectionId: 'warehouse',
          table: { catalog: null, db: 'analytics', name: 'events' },
          columns: ['id', 'event_name'],
          limit: 1,
        },
        { runId: 'scan-run-1' },
      ),
    ).resolves.toEqual({ headers: ['id', 'event_name'], rows: [[10, 'signup']], totalRows: 1 });

    await expect(
      connector.sampleColumn(
        { connectionId: 'warehouse', table: { catalog: null, db: 'analytics', name: 'events' }, column: 'event_name', limit: 5 },
        { runId: 'scan-run-1' },
      ),
    ).resolves.toMatchObject({ values: ['signup', 'purchase'], nullCount: null, distinctCount: null });

    await expect(
      connector.getColumnDistinctValues(
        { catalog: null, db: 'analytics', name: 'events' },
        'event_name',
        { maxCardinality: 5, limit: 10, sampleSize: 100 },
      ),
    ).resolves.toEqual({ values: ['purchase', 'signup'], cardinality: 2 });

    await expect(
      connector.executeReadOnly(
        { connectionId: 'warehouse', sql: 'select id, event_name from analytics.events', maxRows: 1 },
        { runId: 'scan-run-1' },
      ),
    ).resolves.toMatchObject({ headers: ['id', 'event_name'], rows: [[10, 'signup']], totalRows: 1, rowCount: 1 });

    await expect(
      connector.executeReadOnly({ connectionId: 'warehouse', sql: 'delete from events' }, { runId: 'scan-run-1' }),
    ).rejects.toThrow('Only read-only SELECT/WITH queries can be executed locally');

    await expect(connector.getTableRowCount('events')).resolves.toBe(2);
    await expect(connector.listSchemas()).resolves.toEqual(['analytics', 'warehouse']);
    await expect(connector.listTables(['analytics'])).resolves.toEqual([
      { catalog: null, schema: 'analytics', name: 'event_summary', kind: 'view' },
      { catalog: null, schema: 'analytics', name: 'events', kind: 'table' },
    ]);
    await expect(
      connector.columnStats(
        { connectionId: 'warehouse', table: { catalog: null, db: 'analytics', name: 'events' }, column: 'event_name' },
        { runId: 'scan-run-1' },
      ),
    ).resolves.toBeNull();

    await connector.cleanup();
  });

  it('applies max_execution_time + an outlasting request_timeout and maps code 159 to KtxQueryError', async () => {
    let capturedConfig: { request_timeout?: number; clickhouse_settings?: Record<string, unknown> } | undefined;
    const timeoutError = Object.assign(new Error('Code: 159. DB::Exception: Timeout exceeded'), { code: 159 });
    const clientFactory: KtxClickHouseClientFactory = {
      createClient: vi.fn((config) => {
        capturedConfig = config as { request_timeout?: number; clickhouse_settings?: Record<string, unknown> };
        return {
          query: vi.fn(async () => {
            throw timeoutError;
          }),
          close: vi.fn(async () => undefined),
        };
      }),
    };
    const connector = new KtxClickHouseScanConnector({
      connectionId: 'warehouse',
      connection: {
        driver: 'clickhouse',
        host: 'ch.example.test',
        database: 'analytics',
        username: 'reader',
        password: 'test-pass', // pragma: allowlist secret
        query_timeout_ms: 5_000,
      },
      clientFactory,
    });

    const execution = connector.executeReadOnly(
      { connectionId: 'warehouse', sql: 'select count(*) from events' },
      { runId: 'scan-run-1' },
    );
    await expect(execution).rejects.toBeInstanceOf(KtxQueryError);
    await expect(execution).rejects.toThrow('query exceeded 5s');
    expect(capturedConfig?.clickhouse_settings?.max_execution_time).toBe(5);
    expect(capturedConfig?.request_timeout).toBe(10_000);
  });

  it('adapts native ClickHouse snapshots to live-database introspection for local ingest', async () => {
    const introspection = createClickHouseLiveDatabaseIntrospection({
      connections: {
        warehouse: {
          driver: 'clickhouse',
          host: 'ch.example.test',
          database: 'analytics',
          username: 'reader',
          password: 'test-pass', // pragma: allowlist secret
        },
      },
      clientFactory: fakeClientFactory(),
      now: () => new Date('2026-04-29T14:00:00.000Z'),
    });

    const snapshot = await introspection.extractSchema('warehouse');

    expect(snapshot).toMatchObject({
      connectionId: 'warehouse',
      extractedAt: '2026-04-29T14:00:00.000Z',
    });
    expect(snapshot.tables.find((table) => table.name === 'events')).toMatchObject({
      name: 'events',
      catalog: null,
      db: 'analytics',
      columns: [
        {
          name: 'id',
          nativeType: 'UInt64',
          normalizedType: 'UInt64',
          dimensionType: 'number',
          nullable: false,
          primaryKey: true,
          comment: 'PK',
        },
        {
          name: 'event_name',
          nativeType: 'LowCardinality(String)',
          normalizedType: 'LowCardinality(String)',
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
