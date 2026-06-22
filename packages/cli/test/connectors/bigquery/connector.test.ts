import { describe, expect, it, vi } from 'vitest';
import { KtxQueryError } from '../../../src/errors.js';
import { bigQueryConnectionConfigFromConfig, isKtxBigQueryConnectionConfig, type KtxBigQueryClient, KtxBigQueryScanConnector, type KtxBigQueryClientFactory, type KtxBigQueryDataset, type KtxBigQueryQueryJob, type KtxBigQueryTableRef, prepareBigQueryReadOnlyQuery } from '../../../src/connectors/bigquery/connector.js';
import { createBigQueryLiveDatabaseIntrospection } from '../../../src/connectors/bigquery/live-database-introspection.js';
import { tableRefSet } from '../../../src/context/scan/table-ref.js';

function fakeClientFactory(options: { primaryKeyError?: Error } = {}): KtxBigQueryClientFactory {
  const queryResults = vi.fn(async (): ReturnType<KtxBigQueryQueryJob['getQueryResults']> => [
    [{ id: 1, status: 'paid' }],
    undefined,
    { schema: { fields: [{ name: 'id', type: 'INT64' }, { name: 'status', type: 'STRING' }] } },
  ]);
  const createQueryJob = vi.fn(async (input: { query: string }): ReturnType<KtxBigQueryClient['createQueryJob']> => {
    if (input.query.includes('INFORMATION_SCHEMA.TABLE_CONSTRAINTS')) {
      if (options.primaryKeyError) {
        throw options.primaryKeyError;
      }
      return [
        {
          getQueryResults: async (): ReturnType<KtxBigQueryQueryJob['getQueryResults']> => [
            [{ table_name: 'orders', column_name: 'id' }],
            undefined,
            { schema: { fields: [{ name: 'table_name', type: 'STRING' }, { name: 'column_name', type: 'STRING' }] } },
          ],
        },
      ];
    }
    if (input.query.includes('APPROX_COUNT_DISTINCT')) {
      return [
        {
          getQueryResults: async (): ReturnType<KtxBigQueryQueryJob['getQueryResults']> => [
            [{ cardinality: 2 }],
            undefined,
            { schema: { fields: [{ name: 'cardinality', type: 'INT64' }] } },
          ],
        },
      ];
    }
    if (input.query.includes('SELECT DISTINCT CAST')) {
      return [
        {
          getQueryResults: async (): ReturnType<KtxBigQueryQueryJob['getQueryResults']> => [
            [{ val: 'open' }, { val: 'paid' }],
            undefined,
            { schema: { fields: [{ name: 'val', type: 'STRING' }] } },
          ],
        },
      ];
    }
    if (input.query.includes('SELECT `status`')) {
      return [
        {
          getQueryResults: async (): ReturnType<KtxBigQueryQueryJob['getQueryResults']> => [
            [{ status: 'paid' }],
            undefined,
            { schema: { fields: [{ name: 'status', type: 'STRING' }] } },
          ],
        },
      ];
    }
    return [{ getQueryResults: queryResults }];
  });
  const getTable = vi.fn(async (): ReturnType<KtxBigQueryTableRef['get']> => [
    {
      metadata: {
        type: 'TABLE',
        numRows: '12',
        description: 'Orders table',
        schema: {
          fields: [
            { name: 'id', type: 'INT64', mode: 'REQUIRED', description: 'Order id' },
            { name: 'status', type: 'STRING', mode: 'NULLABLE' },
            { name: 'payload', type: 'RECORD', mode: 'NULLABLE' },
          ],
        },
      },
    },
  ]);
  const tableRef: KtxBigQueryTableRef = { id: 'orders', get: getTable };
  return {
    createClient: vi.fn(() => ({
      getDatasets: vi.fn(async (): ReturnType<KtxBigQueryClient['getDatasets']> => [[{ id: 'analytics' }, { id: 'staging' }]]),
      dataset: vi.fn(
        (datasetId: string): KtxBigQueryDataset => ({
        get: vi.fn(async () => [{ id: datasetId }]),
        getTables: vi.fn(async (): ReturnType<KtxBigQueryDataset['getTables']> => [[tableRef]]),
      }),
      ),
      createQueryJob,
    })),
  };
}

const connection = {
  driver: 'bigquery',
  dataset_id: 'analytics',
  credentials_json: JSON.stringify({ project_id: 'project-1', client_email: 'reader@example.test' }),
  location: 'US',
} as const;

describe('KtxBigQueryScanConnector', () => {
  it('prepares read-only SQL parameters with BigQuery named placeholders', () => {
    expect(prepareBigQueryReadOnlyQuery('SELECT * FROM orders WHERE id = :id AND id_2 = :id_2', { id: 1, id_2: 2 })).toEqual({
      sql: 'SELECT * FROM orders WHERE id = @id AND id_2 = @id_2',
      params: { id: 1, id_2: 2 },
    });
    expect(prepareBigQueryReadOnlyQuery('SELECT * FROM orders')).toEqual({
      sql: 'SELECT * FROM orders',
      params: undefined,
    });
  });

  it('resolves configuration safely', () => {
    expect(isKtxBigQueryConnectionConfig(connection)).toBe(true);
    expect(isKtxBigQueryConnectionConfig({ driver: 'mysql' })).toBe(false);
    expect(bigQueryConnectionConfigFromConfig({ connectionId: 'warehouse', connection })).toMatchObject({
      projectId: 'project-1',
      datasetIds: [{ project: 'project-1', dataset: 'analytics' }],
      location: 'US',
    });
  });

  it('parses project.dataset entries to host-project pairs and rejects malformed entries', () => {
    expect(
      bigQueryConnectionConfigFromConfig({
        connectionId: 'warehouse',
        connection: {
          driver: 'bigquery',
          dataset_ids: ['bigquery-public-data.austin_311', 'analytics'],
          credentials_json: JSON.stringify({ project_id: 'project-1' }),
        },
      }).datasetIds,
    ).toEqual([
      { project: 'bigquery-public-data', dataset: 'austin_311' },
      { project: 'project-1', dataset: 'analytics' },
    ]);

    for (const badEntry of ['proj.ds.table', 'proj.', '.ds']) {
      expect(() =>
        bigQueryConnectionConfigFromConfig({
          connectionId: 'warehouse',
          connection: {
            driver: 'bigquery',
            dataset_ids: [badEntry],
            credentials_json: JSON.stringify({ project_id: 'project-1' }),
          },
        }),
      ).toThrow(/connections\.warehouse/);
    }
  });

  it('introspects datasets, table metadata, primary keys, and normalized types', async () => {
    const connector = new KtxBigQueryScanConnector({
      connectionId: 'warehouse',
      connection,
      clientFactory: fakeClientFactory(),
      now: () => new Date('2026-04-29T17:00:00.000Z'),
    });

    const snapshot = await connector.introspect(
      { connectionId: 'warehouse', driver: 'bigquery' },
      { runId: 'scan-run-1' },
    );

    expect(snapshot).toMatchObject({
      connectionId: 'warehouse',
      driver: 'bigquery',
      extractedAt: '2026-04-29T17:00:00.000Z',
      scope: { catalogs: ['project-1'], datasets: ['analytics'] },
      metadata: {
        project_id: 'project-1',
        datasets: ['analytics'],
        table_count: 1,
        total_columns: 3,
      },
    });
    expect(snapshot.tables[0]).toMatchObject({
      catalog: 'project-1',
      db: 'analytics',
      name: 'orders',
      kind: 'table',
      comment: 'Orders table',
      estimatedRows: 12,
      foreignKeys: [],
    });
    expect(snapshot.tables[0]?.columns).toEqual([
      {
        name: 'id',
        nativeType: 'INT64',
        normalizedType: 'BIGINT',
        dimensionType: 'number',
        nullable: false,
        primaryKey: true,
        comment: 'Order id',
      },
      {
        name: 'status',
        nativeType: 'STRING',
        normalizedType: 'VARCHAR',
        dimensionType: 'string',
        nullable: true,
        primaryKey: false,
        comment: null,
      },
      {
        name: 'payload',
        nativeType: 'RECORD',
        normalizedType: 'JSON',
        dimensionType: 'string',
        nullable: true,
        primaryKey: false,
        comment: null,
      },
    ]);
  });

  it('introspects a foreign-hosted dataset under its own project while billing stays local', async () => {
    const clientFactory = fakeClientFactory();
    const connector = new KtxBigQueryScanConnector({
      connectionId: 'warehouse',
      connection: {
        driver: 'bigquery',
        dataset_ids: ['bigquery-public-data.austin_311'],
        credentials_json: JSON.stringify({ project_id: 'project-1' }),
        location: 'US',
      },
      clientFactory,
    });

    const snapshot = await connector.introspect({ connectionId: 'warehouse', driver: 'bigquery' }, { runId: 'foreign' });

    const client = vi.mocked(clientFactory.createClient).mock.results[0]?.value as KtxBigQueryClient;
    expect(client.dataset).toHaveBeenCalledWith('austin_311', 'bigquery-public-data');
    expect(clientFactory.createClient).toHaveBeenCalledWith(expect.objectContaining({ projectId: 'project-1' }));
    expect(snapshot.scope).toEqual({
      catalogs: ['bigquery-public-data'],
      datasets: ['bigquery-public-data.austin_311'],
    });
    expect(snapshot.metadata.project_id).toBe('project-1');
    expect(snapshot.tables[0]).toMatchObject({
      catalog: 'bigquery-public-data',
      db: 'austin_311',
      name: 'orders',
    });
  });

  it('introspects datasets across multiple host projects, each under its own project', async () => {
    const clientFactory = fakeClientFactory();
    const connector = new KtxBigQueryScanConnector({
      connectionId: 'warehouse',
      connection: {
        driver: 'bigquery',
        dataset_ids: ['bigquery-public-data.austin_311', 'analytics'],
        credentials_json: JSON.stringify({ project_id: 'project-1' }),
        location: 'US',
      },
      clientFactory,
    });

    const snapshot = await connector.introspect({ connectionId: 'warehouse', driver: 'bigquery' }, { runId: 'multi' });

    const client = vi.mocked(clientFactory.createClient).mock.results[0]?.value as KtxBigQueryClient;
    expect(client.dataset).toHaveBeenCalledWith('austin_311', 'bigquery-public-data');
    expect(client.dataset).toHaveBeenCalledWith('analytics', 'project-1');
    expect(snapshot.scope.catalogs).toEqual(['bigquery-public-data', 'project-1']);
    expect(snapshot.scope.datasets).toEqual(['bigquery-public-data.austin_311', 'analytics']);
    expect(snapshot.tables.map((table) => ({ catalog: table.catalog, db: table.db, name: table.name }))).toEqual([
      { catalog: 'bigquery-public-data', db: 'austin_311', name: 'orders' },
      { catalog: 'project-1', db: 'analytics', name: 'orders' },
    ]);
  });

  it('keeps same-named datasets in different projects distinct', async () => {
    const clientFactory = fakeClientFactory();
    const connector = new KtxBigQueryScanConnector({
      connectionId: 'warehouse',
      connection: {
        driver: 'bigquery',
        dataset_ids: ['proj_a.shared', 'proj_b.shared'],
        credentials_json: JSON.stringify({ project_id: 'project-1' }),
      },
      clientFactory,
    });

    const snapshot = await connector.introspect({ connectionId: 'warehouse', driver: 'bigquery' }, { runId: 'same-name' });

    expect(snapshot.scope.catalogs).toEqual(['proj_a', 'proj_b']);
    expect(snapshot.scope.datasets).toEqual(['proj_a.shared', 'proj_b.shared']);
    expect(snapshot.tables.map((table) => `${table.catalog}.${table.db}.${table.name}`)).toEqual([
      'proj_a.shared.orders',
      'proj_b.shared.orders',
    ]);
  });

  it.each([
    Object.assign(new Error('Access Denied'), { code: 403 }),
    Object.assign(new Error('Not found'), { errors: [{ reason: 'notFound' }] }),
  ])('soft-fails denied BigQuery primary-key discovery with a scan warning', async (primaryKeyError) => {
    const connector = new KtxBigQueryScanConnector({
      connectionId: 'warehouse',
      connection,
      clientFactory: fakeClientFactory({ primaryKeyError }),
      now: () => new Date('2026-04-29T17:00:00.000Z'),
    });

    const snapshot = await connector.introspect(
      { connectionId: 'warehouse', driver: 'bigquery' },
      { runId: 'scan-run-bigquery-denied-pk' },
    );

    expect(snapshot.warnings).toEqual([
      {
        code: 'constraint_discovery_unauthorized',
        message: 'Skipped primary-key discovery in analytics (insufficient grants on system catalogs)',
        recoverable: true,
        metadata: { schema: 'analytics', kind: 'primary_key' },
      },
    ]);
    expect(snapshot.tables[0]?.foreignKeys).toEqual([]);
    expect(snapshot.tables[0]?.columns.every((column) => column.primaryKey === false)).toBe(true);
  });

  it('runs samples, read-only SQL, distinct values, dataset listing, row counts, and cleanup', async () => {
    const connector = new KtxBigQueryScanConnector({
      connectionId: 'warehouse',
      connection,
      clientFactory: fakeClientFactory(),
    });

    await expect(
      connector.sampleTable(
        {
          connectionId: 'warehouse',
          table: { catalog: 'project-1', db: 'analytics', name: 'orders' },
          columns: ['id', 'status'],
          limit: 1,
        },
        { runId: 'scan-run-1' },
      ),
    ).resolves.toEqual({
      headers: ['id', 'status'],
      headerTypes: ['INT64', 'STRING'],
      rows: [[1, 'paid']],
      totalRows: 1,
    });

    await expect(
      connector.sampleColumn(
        {
          connectionId: 'warehouse',
          table: { catalog: 'project-1', db: 'analytics', name: 'orders' },
          column: 'status',
          limit: 5,
        },
        { runId: 'scan-run-1' },
      ),
    ).resolves.toMatchObject({ values: ['paid'], nullCount: null, distinctCount: null });

    await expect(
      connector.executeReadOnly(
        { connectionId: 'warehouse', sql: 'select id, status from `project-1`.`analytics`.`orders`', maxRows: 1 },
        { runId: 'scan-run-1' },
      ),
    ).resolves.toMatchObject({ headers: ['id', 'status'], rows: [[1, 'paid']], totalRows: 1, rowCount: 1 });

    await expect(
      connector.executeReadOnly({ connectionId: 'warehouse', sql: 'delete from orders' }, { runId: 'scan-run-1' }),
    ).rejects.toThrow('Only read-only SELECT/WITH queries can be executed locally');

    await expect(
      connector.getColumnDistinctValues(
        { catalog: 'project-1', db: 'analytics', name: 'orders' },
        'status',
        { maxCardinality: 5, limit: 10, sampleSize: 100 },
      ),
    ).resolves.toEqual({ values: ['open', 'paid'], cardinality: 2 });
    await expect(connector.getTableRowCount('orders')).resolves.toBe(12);
    await expect(connector.listSchemas()).resolves.toEqual(['analytics', 'staging']);
    await expect(
      connector.columnStats(
        { connectionId: 'warehouse', table: { catalog: 'project-1', db: 'analytics', name: 'orders' }, column: 'status' },
        { runId: 'scan-run-1' },
      ),
    ).resolves.toBeNull();
    await connector.cleanup();
  });

  it('limits introspection to tables in tableScope', async () => {
    const ordersGet = vi.fn(async (): ReturnType<KtxBigQueryTableRef['get']> => [
      {
        metadata: {
          type: 'TABLE',
          numRows: '12',
          schema: { fields: [{ name: 'id', type: 'INT64', mode: 'REQUIRED' }] },
        },
      },
    ]);
    const skippedGet = vi.fn(async (): ReturnType<KtxBigQueryTableRef['get']> => [
      { metadata: { type: 'TABLE', numRows: '1', schema: { fields: [] } } },
    ]);
    const clientFactory: KtxBigQueryClientFactory = {
      createClient: vi.fn(() => ({
        getDatasets: vi.fn(async (): ReturnType<KtxBigQueryClient['getDatasets']> => [[{ id: 'analytics' }]]),
        dataset: vi.fn(
          (): KtxBigQueryDataset => ({
            get: vi.fn(async () => [{ id: 'analytics' }]),
            getTables: vi.fn(async (): ReturnType<KtxBigQueryDataset['getTables']> => [
              [
                { id: 'orders', get: ordersGet },
                { id: 'customers', get: skippedGet },
              ],
            ]),
          }),
        ),
        createQueryJob: vi.fn(async (): ReturnType<KtxBigQueryClient['createQueryJob']> => [
          {
            getQueryResults: async (): ReturnType<KtxBigQueryQueryJob['getQueryResults']> => [
              [],
              undefined,
              { schema: { fields: [{ name: 'table_name', type: 'STRING' }, { name: 'column_name', type: 'STRING' }] } },
            ],
          },
        ]),
      })),
    };
    const connector = new KtxBigQueryScanConnector({
      connectionId: 'warehouse',
      connection,
      clientFactory,
    });
    const scope = tableRefSet([{ catalog: 'project-1', db: 'analytics', name: 'orders' }]);
    const snapshot = await connector.introspect(
      { connectionId: 'warehouse', driver: 'bigquery', tableScope: scope },
      { runId: 'scope-test' },
    );
    expect(snapshot.tables.map((table) => table.name)).toEqual(['orders']);
    expect(ordersGet).toHaveBeenCalledTimes(1);
    expect(skippedGet).not.toHaveBeenCalled();
  });

  it('skips a table that fails introspection and ingests its healthy siblings', async () => {
    const ordersGet = vi.fn(async (): ReturnType<KtxBigQueryTableRef['get']> => [
      { metadata: { type: 'TABLE', numRows: '5', schema: { fields: [{ name: 'id', type: 'INT64', mode: 'REQUIRED' }] } } },
    ]);
    const brokenGet = vi.fn(async (): ReturnType<KtxBigQueryTableRef['get']> => {
      throw new Error('Access Denied: Table project-1:analytics.locked');
    });
    const clientFactory: KtxBigQueryClientFactory = {
      createClient: vi.fn(() => ({
        getDatasets: vi.fn(async (): ReturnType<KtxBigQueryClient['getDatasets']> => [[{ id: 'analytics' }]]),
        dataset: vi.fn(
          (): KtxBigQueryDataset => ({
            get: vi.fn(async () => [{ id: 'analytics' }]),
            getTables: vi.fn(async (): ReturnType<KtxBigQueryDataset['getTables']> => [
              [
                { id: 'orders', get: ordersGet },
                { id: 'locked', get: brokenGet },
              ],
            ]),
          }),
        ),
        createQueryJob: vi.fn(async (): ReturnType<KtxBigQueryClient['createQueryJob']> => [
          {
            getQueryResults: async (): ReturnType<KtxBigQueryQueryJob['getQueryResults']> => [
              [],
              undefined,
              { schema: { fields: [{ name: 'table_name', type: 'STRING' }, { name: 'column_name', type: 'STRING' }] } },
            ],
          },
        ]),
      })),
    };
    const connector = new KtxBigQueryScanConnector({ connectionId: 'warehouse', connection, clientFactory });
    const snapshot = await connector.introspect({ connectionId: 'warehouse', driver: 'bigquery' }, { runId: 'skip-test' });

    expect(snapshot.tables.map((table) => table.name)).toEqual(['orders']);
    expect(snapshot.warnings).toHaveLength(1);
    expect(snapshot.warnings?.[0]).toMatchObject({
      code: 'object_introspection_failed',
      table: 'locked',
      metadata: { object: 'project-1.analytics.locked' },
    });
  });

  it('constructs for discovery without dataset scope and lists tables through one region information schema query', async () => {
    const createQueryJob = vi.fn(
      async (
        input: { query: string; params?: Record<string, unknown>; location?: string },
      ): ReturnType<KtxBigQueryClient['createQueryJob']> => [
        {
          getQueryResults: async (): ReturnType<KtxBigQueryQueryJob['getQueryResults']> => [
            [
              { table_schema: 'analytics', table_name: 'orders', table_type: 'BASE TABLE' },
              { table_schema: 'analytics', table_name: 'order_clone', table_type: 'CLONE' },
              { table_schema: 'mart', table_name: 'orders_mv', table_type: 'MATERIALIZED VIEW' },
            ],
            undefined,
            {
              schema: {
                fields: [
                  { name: 'table_schema', type: 'STRING' },
                  { name: 'table_name', type: 'STRING' },
                  { name: 'table_type', type: 'STRING' },
                ],
              },
            },
          ],
        },
      ],
    );
    const clientFactory: KtxBigQueryClientFactory = {
      createClient: vi.fn(() => ({
        getDatasets: vi.fn(async () => [[{ id: 'analytics' }, { id: 'mart' }]] as [{ id: string }[]]),
        dataset: vi.fn((datasetId: string) => ({
          get: vi.fn(async () => [{ id: datasetId }]),
          getTables: vi.fn(async () => [[]] as [never[]]),
        })),
        createQueryJob,
      })),
    };
    const connector = new KtxBigQueryScanConnector({
      connectionId: 'warehouse',
      connection: {
        driver: 'bigquery',
        credentials_json: JSON.stringify({ project_id: 'project-1' }),
        location: 'US',
      },
      clientFactory,
    });

    await expect(connector.listTables(['analytics', 'mart'])).resolves.toEqual([
      { catalog: 'project-1', schema: 'analytics', name: 'orders', kind: 'table' },
      { catalog: 'project-1', schema: 'analytics', name: 'order_clone', kind: 'table' },
      { catalog: 'project-1', schema: 'mart', name: 'orders_mv', kind: 'view' },
    ]);

    expect(createQueryJob).toHaveBeenCalledTimes(1);
    expect(createQueryJob).toHaveBeenCalledWith(
      expect.objectContaining({
        location: 'US',
        params: { dataset_ids: ['analytics', 'mart'] },
      }),
    );
    expect(createQueryJob.mock.calls[0]?.[0].query).toContain('`project-1`.`region-us`.INFORMATION_SCHEMA.TABLES');
    expect(createQueryJob.mock.calls[0]?.[0].query).toContain("'CLONE'");
    expect(createQueryJob.mock.calls[0]?.[0].query).toContain("'SNAPSHOT'");
  });

  it('keeps scan paths requiring dataset scope', async () => {
    const connector = new KtxBigQueryScanConnector({
      connectionId: 'warehouse',
      connection: {
        driver: 'bigquery',
        credentials_json: JSON.stringify({ project_id: 'project-1' }),
        location: 'US',
      },
      clientFactory: fakeClientFactory(),
    });

    await expect(
      connector.introspect(
        { connectionId: 'warehouse', driver: 'bigquery' },
        { runId: 'scan-run-1' },
      ),
    ).rejects.toThrow('Native BigQuery scan requires connections.warehouse.dataset_ids or dataset_id');
  });

  it('applies maximumBytesBilled to read-only queries when configured', async () => {
    const clientFactory = fakeClientFactory();
    const connector = new KtxBigQueryScanConnector({
      connectionId: 'warehouse',
      connection,
      clientFactory,
      maxBytesBilled: 123456789,
    });

    await expect(
      connector.executeReadOnly(
        { connectionId: 'warehouse', sql: 'select id, status from `project-1`.`analytics`.`orders`', maxRows: 1 },
        { runId: 'scan-run-1' },
      ),
    ).resolves.toMatchObject({ rows: [[1, 'paid']], rowCount: 1 });

    const client = vi.mocked(clientFactory.createClient).mock.results[0]?.value as KtxBigQueryClient;
    expect(client.createQueryJob).toHaveBeenLastCalledWith(
      expect.objectContaining({
        maximumBytesBilled: '123456789',
      }),
    );
  });

  it('applies canonical BigQuery YAML scan limits to query jobs', async () => {
    const clientFactory = fakeClientFactory();
    const connector = new KtxBigQueryScanConnector({
      connectionId: 'warehouse',
      connection: { ...connection, max_bytes_billed: '987654321', query_timeout_ms: 30_000 },
      clientFactory,
    });

    await expect(
      connector.executeReadOnly(
        { connectionId: 'warehouse', sql: 'select id, status from `project-1`.`analytics`.`orders`', maxRows: 1 },
        { runId: 'scan-run-1' },
      ),
    ).resolves.toMatchObject({ rows: [[1, 'paid']], rowCount: 1 });

    const client = vi.mocked(clientFactory.createClient).mock.results[0]?.value as KtxBigQueryClient;
    expect(client.createQueryJob).toHaveBeenLastCalledWith(
      expect.objectContaining({
        maximumBytesBilled: '987654321',
        jobTimeoutMs: 30_000,
      }),
    );
  });

  it('adapts native snapshots to live-database introspection snapshots', async () => {
    const introspection = createBigQueryLiveDatabaseIntrospection({
      connections: { warehouse: connection },
      clientFactory: fakeClientFactory(),
      now: () => new Date('2026-04-29T17:00:00.000Z'),
    });

    await expect(introspection.extractSchema('warehouse')).resolves.toMatchObject({
      connectionId: 'warehouse',
      metadata: { project_id: 'project-1' },
      tables: expect.arrayContaining([
        expect.objectContaining({
          catalog: 'project-1',
          db: 'analytics',
          name: 'orders',
          columns: expect.arrayContaining([
            {
              name: 'id',
              nativeType: 'INT64',
              normalizedType: 'BIGINT',
              dimensionType: 'number',
              nullable: false,
              primaryKey: true,
              comment: 'Order id',
            },
          ]),
        }),
      ]),
    });
  });

  it('maps a BigQuery job timeout to KtxQueryError', async () => {
    const timeoutError = new Error('Job execution was cancelled: Job timed out after 5000ms');
    const clientFactory: KtxBigQueryClientFactory = {
      createClient: vi.fn(() => ({
        getDatasets: vi.fn(async (): ReturnType<KtxBigQueryClient['getDatasets']> => [[{ id: 'analytics' }]]),
        dataset: vi.fn(
          (datasetId: string): KtxBigQueryDataset => ({
            get: vi.fn(async () => [{ id: datasetId }]),
            getTables: vi.fn(async (): ReturnType<KtxBigQueryDataset['getTables']> => [[]]),
          }),
        ),
        createQueryJob: vi.fn(async (): ReturnType<KtxBigQueryClient['createQueryJob']> => {
          throw timeoutError;
        }),
      })),
    };
    const connector = new KtxBigQueryScanConnector({
      connectionId: 'warehouse',
      connection: { ...connection, query_timeout_ms: 5_000 },
      clientFactory,
    });

    const execution = connector.executeReadOnly(
      { connectionId: 'warehouse', sql: 'select count(*) from `project-1`.`analytics`.`orders`' },
      { runId: 'scan-run-1' },
    );
    await expect(execution).rejects.toBeInstanceOf(KtxQueryError);
    await expect(execution).rejects.toThrow('query exceeded 5s');
    await expect(execution).rejects.toMatchObject({ cause: timeoutError });
  });
});
