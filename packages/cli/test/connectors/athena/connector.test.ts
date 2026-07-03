import { describe, expect, it, vi } from 'vitest';
import {
  athenaConnectionConfigFromConfig,
  isKtxAthenaConnectionConfig,
  KtxAthenaScanConnector,
  type KtxAthenaClientFactory,
  type KtxAthenaClient,
  type KtxGlueClient,
} from '../../../src/connectors/athena/connector.js';
import { createAthenaLiveDatabaseIntrospection } from '../../../src/connectors/athena/live-database-introspection.js';
import { tableRefSet } from '../../../src/context/scan/table-ref.js';

function fakeClientFactory(options: { queryState?: string; queryError?: string } = {}): KtxAthenaClientFactory {
  const state = options.queryState ?? 'SUCCEEDED';
  const queries = new Map<string, string>();
  let execCounter = 0;

  const fakeAthenaClient: KtxAthenaClient = {
    startQueryExecution: vi.fn(async (input) => {
      const id = `exec-${++execCounter}`;
      queries.set(id, input.QueryString);
      return { QueryExecutionId: id };
    }),
    getQueryExecution: vi.fn(async () => ({
      QueryExecution: {
        Status: {
          State: state,
          StateChangeReason: options.queryError,
        },
      },
    })),
    getQueryResults: vi.fn(async (input) => {
      const sql = queries.get(input.QueryExecutionId) ?? '';
      // Column sample query: single-column result for the queried column only.
      if (sql.includes('IS NOT NULL')) {
        return {
          ResultSet: {
            ResultSetMetadata: { ColumnInfo: [{ Name: 'status', Type: 'string' }] },
            Rows: [
              { Data: [{ VarCharValue: 'status' }] }, // header row
              { Data: [{ VarCharValue: 'paid' }] },
            ],
          },
          NextToken: undefined,
        };
      }
      return {
        ResultSet: {
          ResultSetMetadata: {
            ColumnInfo: [
              { Name: 'id', Type: 'bigint' },
              { Name: 'status', Type: 'string' },
            ],
          },
          Rows: [
            // Header row (Athena always includes it on first page)
            { Data: [{ VarCharValue: 'id' }, { VarCharValue: 'status' }] },
            // Data row
            { Data: [{ VarCharValue: '1' }, { VarCharValue: 'paid' }] },
          ],
        },
        NextToken: undefined,
      };
    }),
  };

  const fakeGlueClient: KtxGlueClient = {
    getDatabases: vi.fn(async () => ({
      DatabaseList: [{ Name: 'analytics' }],
      NextToken: undefined,
    })),
    getTables: vi.fn(async () => ({
      TableList: [
        {
          Name: 'orders',
          TableType: 'EXTERNAL_TABLE',
          Description: 'Orders table',
          StorageDescriptor: {
            Columns: [
              { Name: 'id', Type: 'bigint', Comment: 'Order id' },
              { Name: 'status', Type: 'string' },
            ],
          },
          PartitionKeys: [{ Name: 'dt', Type: 'date', Comment: 'Partition date' }],
        },
      ],
      NextToken: undefined,
    })),
  };

  return {
    createAthenaClient: vi.fn(() => fakeAthenaClient),
    createGlueClient: vi.fn(() => fakeGlueClient),
  };
}

const connection = {
  driver: 'athena',
  region: 'us-east-1',
  s3_staging_dir: 's3://my-bucket/athena-results/',
  workgroup: 'analytics',
  catalog: 'AwsDataCatalog',
  database: 'analytics',
} as const;

describe('KtxAthenaScanConnector', () => {
  it('identifies athena connection configs correctly', () => {
    expect(isKtxAthenaConnectionConfig(connection)).toBe(true);
    expect(isKtxAthenaConnectionConfig({ driver: 'bigquery' })).toBe(false);
    expect(isKtxAthenaConnectionConfig(null)).toBe(false);
    expect(isKtxAthenaConnectionConfig(undefined)).toBe(false);
  });

  it('resolves configuration and throws on missing required fields', () => {
    expect(athenaConnectionConfigFromConfig({ connectionId: 'dw', connection })).toMatchObject({
      region: 'us-east-1',
      s3StagingDir: 's3://my-bucket/athena-results/',
      workgroup: 'analytics',
      catalog: 'AwsDataCatalog',
      database: 'analytics',
    });

    expect(() =>
      athenaConnectionConfigFromConfig({ connectionId: 'dw', connection: { driver: 'athena' } }),
    ).toThrow('connections.dw.region');

    expect(() =>
      athenaConnectionConfigFromConfig({
        connectionId: 'dw',
        connection: { driver: 'athena', region: 'us-east-1' },
      }),
    ).toThrow('connections.dw.s3_staging_dir');
  });

  it('applies defaults for optional config fields', () => {
    const resolved = athenaConnectionConfigFromConfig({
      connectionId: 'dw',
      connection: { driver: 'athena', region: 'us-east-1', s3_staging_dir: 's3://bucket/' },
    });
    expect(resolved.workgroup).toBe('primary');
    expect(resolved.catalog).toBe('AwsDataCatalog');
    expect(resolved.database).toBeUndefined();
  });

  it('introspects databases, tables, and columns from Glue', async () => {
    const connector = new KtxAthenaScanConnector({
      connectionId: 'dw',
      connection,
      clientFactory: fakeClientFactory(),
      now: () => new Date('2026-06-21T10:00:00.000Z'),
    });

    const snapshot = await connector.introspect(
      { connectionId: 'dw', driver: 'athena' },
      { runId: 'scan-1' },
    );

    expect(snapshot).toMatchObject({
      connectionId: 'dw',
      driver: 'athena',
      extractedAt: '2026-06-21T10:00:00.000Z',
      scope: { catalogs: ['AwsDataCatalog'], datasets: ['analytics'] },
      metadata: {
        catalog: 'AwsDataCatalog',
        databases: ['analytics'],
        table_count: 1,
        total_columns: 3,
      },
    });

    expect(snapshot.tables[0]).toMatchObject({
      catalog: 'AwsDataCatalog',
      db: 'analytics',
      name: 'orders',
      kind: 'table',
      comment: 'Orders table',
      estimatedRows: null,
      foreignKeys: [],
    });

    expect(snapshot.tables[0]?.columns).toEqual([
      {
        name: 'id',
        nativeType: 'bigint',
        normalizedType: 'BIGINT',
        dimensionType: 'number',
        nullable: true,
        primaryKey: false,
        comment: 'Order id',
      },
      {
        name: 'status',
        nativeType: 'string',
        normalizedType: 'VARCHAR',
        dimensionType: 'string',
        nullable: true,
        primaryKey: false,
        comment: null,
      },
      {
        name: 'dt',
        nativeType: 'date',
        normalizedType: 'DATE',
        dimensionType: 'time',
        nullable: true,
        primaryKey: false,
        comment: 'Partition date',
      },
    ]);
  });

  it('respects tableScope and excludes tables not in scope', async () => {
    const connector = new KtxAthenaScanConnector({
      connectionId: 'dw',
      connection,
      clientFactory: fakeClientFactory(),
      now: () => new Date('2026-06-21T10:00:00.000Z'),
    });

    const scopedSnapshot = await connector.introspect(
      {
        connectionId: 'dw',
        driver: 'athena',
        tableScope: tableRefSet([{ catalog: 'AwsDataCatalog', db: 'analytics', name: 'nonexistent' }]),
      },
      { runId: 'scan-1' },
    );
    expect(scopedSnapshot.tables).toHaveLength(0);

    const matchingSnapshot = await connector.introspect(
      {
        connectionId: 'dw',
        driver: 'athena',
        tableScope: tableRefSet([{ catalog: 'AwsDataCatalog', db: 'analytics', name: 'orders' }]),
      },
      { runId: 'scan-1' },
    );
    expect(matchingSnapshot.tables).toHaveLength(1);
    expect(matchingSnapshot.tables[0]?.name).toBe('orders');
  });

  it('limits introspection to the configured databases scope', async () => {
    const requestedDatabases: string[] = [];
    const getDatabases = vi.fn(async () => ({
      DatabaseList: [{ Name: 'analytics' }, { Name: 'raw' }, { Name: 'staging' }],
      NextToken: undefined,
    }));
    const glueClient: KtxGlueClient = {
      getDatabases,
      getTables: vi.fn(async (input) => {
        requestedDatabases.push(input.DatabaseName);
        return {
          TableList: [
            {
              Name: `${input.DatabaseName}_orders`,
              TableType: 'EXTERNAL_TABLE',
              StorageDescriptor: { Columns: [{ Name: 'id', Type: 'bigint' }] },
            },
          ],
          NextToken: undefined,
        };
      }),
    };
    const clientFactory: KtxAthenaClientFactory = {
      createAthenaClient: vi.fn(() => fakeClientFactory().createAthenaClient('us-east-1')),
      createGlueClient: vi.fn(() => glueClient),
    };

    const connector = new KtxAthenaScanConnector({
      connectionId: 'dw',
      connection: { ...connection, databases: ['analytics', 'raw'] },
      clientFactory,
      now: () => new Date('2026-06-21T10:00:00.000Z'),
    });

    const snapshot = await connector.introspect({ connectionId: 'dw', driver: 'athena' }, { runId: 'scan-1' });

    // Scope is taken from config, so the account-wide database list is never enumerated.
    expect(getDatabases).not.toHaveBeenCalled();
    expect(requestedDatabases).toEqual(['analytics', 'raw']);
    expect(snapshot.scope).toMatchObject({ datasets: ['analytics', 'raw'] });
    expect(snapshot.tables.map((t) => t.db)).toEqual(['analytics', 'raw']);
  });

  it('resolves optional env-referenced config to defaults when the variable is unset', () => {
    const resolved = athenaConnectionConfigFromConfig({
      connectionId: 'dw',
      connection: {
        driver: 'athena',
        region: 'us-east-1',
        s3_staging_dir: 's3://bucket/',
        workgroup: 'env:ATHENA_WORKGROUP_UNSET',
        catalog: 'env:GLUE_CATALOG_UNSET',
      },
      env: {},
    });
    expect(resolved.workgroup).toBe('primary');
    expect(resolved.catalog).toBe('AwsDataCatalog');
  });

  it('samples a table via Athena query execution', async () => {
    const connector = new KtxAthenaScanConnector({
      connectionId: 'dw',
      connection,
      clientFactory: fakeClientFactory(),
    });

    const result = await connector.sampleTable(
      {
        connectionId: 'dw',
        table: { catalog: 'AwsDataCatalog', db: 'analytics', name: 'orders' },
        columns: ['id', 'status'],
        limit: 10,
      },
      { runId: 'scan-1' },
    );

    expect(result).toMatchObject({
      headers: ['id', 'status'],
      rows: [['1', 'paid']],
      totalRows: 1,
    });
  });

  it('samples a column via Athena query execution', async () => {
    const connector = new KtxAthenaScanConnector({
      connectionId: 'dw',
      connection,
      clientFactory: fakeClientFactory(),
    });

    const result = await connector.sampleColumn(
      {
        connectionId: 'dw',
        table: { catalog: 'AwsDataCatalog', db: 'analytics', name: 'orders' },
        column: 'status',
        limit: 10,
      },
      { runId: 'scan-1' },
    );

    expect(result).toMatchObject({
      values: ['paid'],
      nullCount: null,
      distinctCount: null,
    });
  });

  it('executes read-only SQL and rejects write statements', async () => {
    const connector = new KtxAthenaScanConnector({
      connectionId: 'dw',
      connection,
      clientFactory: fakeClientFactory(),
    });

    await expect(
      connector.executeReadOnly(
        { connectionId: 'dw', sql: 'SELECT id, status FROM "analytics"."orders"', maxRows: 100 },
        { runId: 'scan-1' },
      ),
    ).resolves.toMatchObject({
      headers: ['id', 'status'],
      rows: [['1', 'paid']],
      rowCount: 1,
    });

    await expect(
      connector.executeReadOnly({ connectionId: 'dw', sql: 'DELETE FROM orders' }, { runId: 'scan-1' }),
    ).rejects.toThrow('Only read-only SELECT/WITH queries can be executed locally');
  });

  it('lists schemas (databases) from Glue', async () => {
    const connector = new KtxAthenaScanConnector({
      connectionId: 'dw',
      connection,
      clientFactory: fakeClientFactory(),
    });

    await expect(connector.listSchemas()).resolves.toEqual(['analytics']);
  });

  it('lists tables from Glue', async () => {
    const connector = new KtxAthenaScanConnector({
      connectionId: 'dw',
      connection,
      clientFactory: fakeClientFactory(),
    });

    await expect(connector.listTables(['analytics'])).resolves.toEqual([
      {
        catalog: 'AwsDataCatalog',
        schema: 'analytics',
        name: 'orders',
        kind: 'table',
      },
    ]);
  });

  it('returns null for columnStats', async () => {
    const connector = new KtxAthenaScanConnector({
      connectionId: 'dw',
      connection,
      clientFactory: fakeClientFactory(),
    });

    await expect(
      connector.columnStats(
        { connectionId: 'dw', table: { catalog: 'AwsDataCatalog', db: 'analytics', name: 'orders' }, column: 'status' },
        { runId: 'scan-1' },
      ),
    ).resolves.toBeNull();
  });

  it('tests connection successfully', async () => {
    const connector = new KtxAthenaScanConnector({
      connectionId: 'dw',
      connection,
      clientFactory: fakeClientFactory(),
    });

    await expect(connector.testConnection()).resolves.toMatchObject({ success: true });
  });

  it('returns failure result when testConnection throws', async () => {
    const factory = fakeClientFactory();
    const glueClient = factory.createGlueClient('us-east-1');
    vi.mocked(glueClient.getDatabases).mockRejectedValue(new Error('Access denied'));
    const brokenFactory: KtxAthenaClientFactory = {
      createAthenaClient: factory.createAthenaClient,
      createGlueClient: vi.fn(() => glueClient),
    };

    const connector = new KtxAthenaScanConnector({
      connectionId: 'dw',
      connection,
      clientFactory: brokenFactory,
    });

    await expect(connector.testConnection()).resolves.toMatchObject({
      success: false,
      error: 'Access denied',
    });
  });

  it('cleans up without throwing', async () => {
    const connector = new KtxAthenaScanConnector({
      connectionId: 'dw',
      connection,
      clientFactory: fakeClientFactory(),
    });
    await connector.listSchemas();
    await expect(connector.cleanup()).resolves.toBeUndefined();
  });

  it('throws when query execution fails', async () => {
    const connector = new KtxAthenaScanConnector({
      connectionId: 'dw',
      connection,
      clientFactory: fakeClientFactory({ queryState: 'FAILED', queryError: 'Syntax error in SQL' }),
    });

    await expect(
      connector.executeReadOnly({ connectionId: 'dw', sql: 'SELECT 1' }, { runId: 'scan-1' }),
    ).rejects.toThrow('Athena query FAILED: Syntax error in SQL');
  });

  it('throws when query execution times out', async () => {
    let callCount = 0;
    // First now() call sets the deadline; second call simulates time past it.
    const now = () => (++callCount === 1 ? new Date(0) : new Date(5 * 60 * 1000 + 1));

    const connector = new KtxAthenaScanConnector({
      connectionId: 'dw',
      connection,
      clientFactory: fakeClientFactory({ queryState: 'RUNNING' }),
      now,
    });

    await expect(
      connector.executeReadOnly({ connectionId: 'dw', sql: 'SELECT 1' }, { runId: 'scan-1' }),
    ).rejects.toThrow('timed out after 300s');
  });

  it('passes the exact column list to Athena when sampling specific columns', async () => {
    const factory = fakeClientFactory();
    const athenaClient = factory.createAthenaClient('us-east-1');
    const connector = new KtxAthenaScanConnector({
      connectionId: 'dw',
      connection,
      clientFactory: { createAthenaClient: vi.fn(() => athenaClient), createGlueClient: factory.createGlueClient },
    });

    await connector.sampleTable(
      {
        connectionId: 'dw',
        table: { catalog: 'AwsDataCatalog', db: 'analytics', name: 'orders' },
        columns: ['id', 'status'],
        limit: 5,
      },
      { runId: 'scan-1' },
    );

    expect(vi.mocked(athenaClient.startQueryExecution).mock.calls[0]?.[0].QueryString).toBe(
      'SELECT "id", "status" FROM "AwsDataCatalog"."analytics"."orders" LIMIT 5',
    );
  });

  it('paginates Glue databases and tables across multiple pages', async () => {
    const glueClient: KtxGlueClient = {
      getDatabases: vi.fn()
        .mockResolvedValueOnce({ DatabaseList: [{ Name: 'db1' }], NextToken: 'page2' })
        .mockResolvedValueOnce({ DatabaseList: [{ Name: 'db2' }], NextToken: undefined }),
      getTables: vi.fn().mockImplementation(async ({ DatabaseName }: { DatabaseName: string }) => {
        if (DatabaseName === 'db1') {
          return {
            TableList: [
              {
                Name: 'table_a',
                TableType: 'EXTERNAL_TABLE',
                StorageDescriptor: { Columns: [{ Name: 'id', Type: 'bigint' }] },
              },
            ],
            NextToken: undefined,
          };
        }
        return {
          TableList: [
            {
              Name: 'table_b',
              TableType: 'EXTERNAL_TABLE',
              StorageDescriptor: { Columns: [{ Name: 'id', Type: 'bigint' }] },
            },
          ],
          NextToken: undefined,
        };
      }),
    };

    const connector = new KtxAthenaScanConnector({
      connectionId: 'dw',
      connection,
      clientFactory: {
        createAthenaClient: vi.fn(() => fakeClientFactory().createAthenaClient('us-east-1')),
        createGlueClient: vi.fn(() => glueClient),
      },
      now: () => new Date('2026-06-21T10:00:00.000Z'),
    });

    const snapshot = await connector.introspect({ connectionId: 'dw', driver: 'athena' }, { runId: 'scan-1' });

    expect(vi.mocked(glueClient.getDatabases)).toHaveBeenCalledTimes(2);
    expect(snapshot.metadata).toMatchObject({ databases: ['db1', 'db2'], table_count: 2 });
    expect(snapshot.tables.map((t) => t.name)).toEqual(['table_a', 'table_b']);
  });

  it('paginates Athena query results across multiple pages', async () => {
    const factory = fakeClientFactory();
    const athenaClient = factory.createAthenaClient('us-east-1');
    vi.mocked(athenaClient.getQueryResults)
      .mockResolvedValueOnce({
        ResultSet: {
          ResultSetMetadata: {
            ColumnInfo: [
              { Name: 'id', Type: 'bigint' },
              { Name: 'status', Type: 'string' },
            ],
          },
          Rows: [
            // Header row — only present on the first page
            { Data: [{ VarCharValue: 'id' }, { VarCharValue: 'status' }] },
            { Data: [{ VarCharValue: '1' }, { VarCharValue: 'paid' }] },
            { Data: [{ VarCharValue: '2' }, { VarCharValue: 'shipped' }] },
          ],
        },
        NextToken: 'page-2',
      })
      .mockResolvedValueOnce({
        ResultSet: {
          ResultSetMetadata: { ColumnInfo: [] },
          // No header row on subsequent pages
          Rows: [{ Data: [{ VarCharValue: '3' }, { VarCharValue: 'pending' }] }],
        },
        NextToken: undefined,
      });

    const connector = new KtxAthenaScanConnector({
      connectionId: 'dw',
      connection,
      clientFactory: { createAthenaClient: vi.fn(() => athenaClient), createGlueClient: factory.createGlueClient },
    });

    const result = await connector.executeReadOnly(
      { connectionId: 'dw', sql: 'SELECT id, status FROM "analytics"."orders"', maxRows: 100 },
      { runId: 'scan-1' },
    );

    expect(result.headers).toEqual(['id', 'status']);
    expect(result.rows).toEqual([
      ['1', 'paid'],
      ['2', 'shipped'],
      ['3', 'pending'],
    ]);
    expect(result.rowCount).toBe(3);
    expect(vi.mocked(athenaClient.getQueryResults)).toHaveBeenCalledTimes(2);
    expect(vi.mocked(athenaClient.getQueryResults).mock.calls[1]?.[0].NextToken).toBe('page-2');
  });

  it('adapts to the live-database introspection port via factory', async () => {
    const introspection = createAthenaLiveDatabaseIntrospection({
      connections: { dw: connection },
      clientFactory: fakeClientFactory(),
      now: () => new Date('2026-06-21T10:00:00.000Z'),
    });

    await expect(introspection.extractSchema('dw')).resolves.toMatchObject({
      connectionId: 'dw',
      driver: 'athena',
      metadata: { catalog: 'AwsDataCatalog' },
      tables: expect.arrayContaining([
        expect.objectContaining({
          db: 'analytics',
          name: 'orders',
          columns: expect.arrayContaining([
            expect.objectContaining({ name: 'id', dimensionType: 'number' }),
          ]),
        }),
      ]),
    });
  });
});
