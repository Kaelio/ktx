import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { KtxSemanticLayerComputePort } from '../../../src/context/daemon/semantic-layer-compute.js';
import { FEDERATED_CONNECTION_ID } from '../../../src/context/connections/federation.js';
import { initKtxProject, type KtxLocalProject } from '../../../src/context/project/project.js';
import { compileLocalSlQuery } from '../../../src/context/sl/local-query.js';

describe('compileLocalSlQuery', () => {
  let tempDir: string;
  let project: KtxLocalProject;
  let compute: KtxSemanticLayerComputePort;

  beforeEach(async () => {
    tempDir = await mkdtemp(join(tmpdir(), 'ktx-local-query-'));
    project = await initKtxProject({ projectDir: join(tempDir, 'project') });
    project.config.connections.warehouse = { driver: 'postgres' };
    await project.fileStore.writeFile(
      'semantic-layer/warehouse/orders.yaml',
      `name: orders
table: public.orders
grain:
  - id
columns:
  - name: id
    type: number
  - name: status
    type: string
measures:
  - name: order_count
    expr: count(*)
joins: []
`,
      'ktx',
      'ktx@example.com',
      'Add orders source',
    );
    await project.fileStore.writeFile(
      'semantic-layer/warehouse/orders_overlay.yaml',
      `name: orders_overlay
inherits_columns_from: orders
columns:
  - name: paid_at
    type: timestamp
joins: []
measures: []
grain: []
`,
      'ktx',
      'ktx@example.com',
      'Add overlay source',
    );

    compute = {
      query: vi.fn(async (input) => ({
        sql: 'select status, count(*) as order_count from public.orders group by status',
        dialect: input.dialect,
        columns: [{ name: 'orders.status' }, { name: 'orders.order_count' }],
        plan: { measures: input.query.measures, dimensions: input.query.dimensions },
      })),
      validateSources: vi.fn(),
      generateSources: vi.fn(),
    };
  });

  afterEach(async () => {
    await rm(tempDir, { recursive: true, force: true });
  });

  it('injects predefined_measures_only when the connection query_policy is semantic-layer-only', async () => {
    project.config.connections.warehouse = { driver: 'postgres', query_policy: 'semantic-layer-only' };

    await compileLocalSlQuery(project, {
      connectionId: 'warehouse',
      query: { measures: ['orders.order_count'], dimensions: [], limit: 10 },
      compute,
    });

    expect(compute.query).toHaveBeenCalledWith(
      expect.objectContaining({
        query: expect.objectContaining({ predefined_measures_only: true }),
      }),
    );
  });

  it('rejects a federated sl_query, pointing to per-connection SL when a member is restricted', async () => {
    project.config.connections.warehouse = { driver: 'postgres', query_policy: 'semantic-layer-only' };
    project.config.connections.analytics = { driver: 'postgres' };

    let message = '';
    try {
      await compileLocalSlQuery(project, {
        connectionId: FEDERATED_CONNECTION_ID,
        query: { measures: ['orders.order_count'], dimensions: [] },
        compute,
      });
      throw new Error('expected compileLocalSlQuery to reject');
    } catch (e) {
      message = (e as Error).message;
    }

    expect(message).toContain("member connection(s) 'warehouse'");
    expect(message).toContain('query_policy: semantic-layer-only');
    // Must not send the agent down the raw-SQL path that assertRawSqlAllowed rejects.
    expect(message).not.toContain(`ktx sql -c ${FEDERATED_CONNECTION_ID}`);
    expect(message).not.toContain('sql_execution');
    expect(compute.query).not.toHaveBeenCalled();
  });

  it('rejects a federated sl_query, pointing to raw federated SQL when no member is restricted', async () => {
    project.config.connections.analytics = { driver: 'postgres' };

    await expect(
      compileLocalSlQuery(project, {
        connectionId: FEDERATED_CONNECTION_ID,
        query: { measures: ['orders.order_count'], dimensions: [] },
        compute,
      }),
    ).rejects.toThrow(`ktx sql -c ${FEDERATED_CONNECTION_ID}`);
    expect(compute.query).not.toHaveBeenCalled();
  });

  it('refuses a non-SQL (context-only) connection instead of compiling it as Postgres', async () => {
    project.config.connections['mongo-prod'] = { driver: 'mongodb', url: 'mongodb://localhost:27017/app' };
    await expect(
      compileLocalSlQuery(project, {
        connectionId: 'mongo-prod',
        query: { measures: ['orders.order_count'], dimensions: ['orders.status'], limit: 25 },
        compute,
      }),
    ).rejects.toThrow(/non-SQL driver 'mongodb'|require a SQL warehouse connection/);
    expect(compute.query).not.toHaveBeenCalled();
  });

  it('compiles a local semantic-layer query with computable sources only', async () => {
    const result = await compileLocalSlQuery(project, {
      connectionId: 'warehouse',
      query: {
        measures: ['orders.order_count'],
        dimensions: ['orders.status'],
        limit: 25,
      },
      compute,
    });

    expect(compute.query).toHaveBeenCalledWith({
      sources: [
        {
          name: 'orders',
          table: 'public.orders',
          grain: ['id'],
          columns: [
            { name: 'id', type: 'number' },
            { name: 'status', type: 'string' },
          ],
          measures: [{ name: 'order_count', expr: 'count(*)' }],
          joins: [],
        },
      ],
      dialect: 'postgres',
      query: {
        measures: ['orders.order_count'],
        dimensions: ['orders.status'],
        limit: 25,
        predefined_measures_only: false,
      },
    });
    expect(result).toEqual({
      connectionId: 'warehouse',
      dialect: 'postgres',
      sql: 'select status, count(*) as order_count from public.orders group by status',
      headers: ['orders.status', 'orders.order_count'],
      rows: [],
      totalRows: 0,
      plan: {
        measures: ['orders.order_count'],
        dimensions: ['orders.status'],
        execution: {
          mode: 'compile_only',
          reason: 'Local semantic-layer query compiled SQL but no data-source execution adapter is configured.',
        },
      },
    });
  });

  it('compiles a local semantic-layer query from manifest-backed scan sources', async () => {
    await project.fileStore.writeFile(
      'semantic-layer/warehouse/_schema/public.yaml',
      `tables:
  payments:
    table: public.payments
    columns:
      - name: payment_id
        type: number
        pk: true
      - name: amount
        type: number
`,
      'ktx',
      'ktx@example.com',
      'Add manifest shard',
    );

    await compileLocalSlQuery(project, {
      connectionId: 'warehouse',
      query: {
        measures: ['sum(payments.amount)'],
        dimensions: [],
      },
      compute,
    });

    expect(compute.query).toHaveBeenLastCalledWith({
      sources: expect.arrayContaining([
        {
          name: 'payments',
          table: 'public.payments',
          grain: ['payment_id'],
          columns: [
            {
              name: 'payment_id',
              type: 'number',
              role: undefined,
              descriptions: undefined,
              constraints: undefined,
              enum_values: undefined,
              tests: undefined,
            },
            {
              name: 'amount',
              type: 'number',
              role: undefined,
              descriptions: undefined,
              constraints: undefined,
              enum_values: undefined,
              tests: undefined,
            },
          ],
          joins: [],
          measures: [],
        },
      ]),
      dialect: 'postgres',
      query: {
        measures: ['sum(payments.amount)'],
        dimensions: [],
        predefined_measures_only: false,
      },
    });
  });

  it('strips authoring-only fields (usage, inherits_columns_from) before sending sources to the daemon', async () => {
    await project.fileStore.writeFile(
      'semantic-layer/warehouse/_schema/public.yaml',
      `tables:
  invoices:
    table: public.invoices
    columns:
      - name: invoice_id
        type: number
        pk: true
      - name: amount
        type: number
    usage:
      narrative: Activation policy windows table for invoice analytics.
      frequencyTier: mid
      commonFilters:
        - amount
      commonGroupBys: []
      commonJoins: []
      staleSince: null
`,
      'ktx',
      'ktx@example.com',
      'Add manifest shard with usage',
    );

    await compileLocalSlQuery(project, {
      connectionId: 'warehouse',
      query: { measures: ['sum(invoices.amount)'], dimensions: [] },
      compute,
    });

    const lastCall = (compute.query as ReturnType<typeof vi.fn>).mock.calls.at(-1)?.[0];
    const invoices = lastCall?.sources.find((s: Record<string, unknown>) => s.name === 'invoices');
    expect(invoices).toBeDefined();
    expect(invoices).not.toHaveProperty('usage');
    expect(invoices).not.toHaveProperty('inherits_columns_from');
    expect(invoices).not.toHaveProperty('source_type');
  });

  it('resolves the only configured connection when connectionId is omitted', async () => {
    await compileLocalSlQuery(project, {
      query: { measures: ['orders.order_count'], dimensions: [] },
      compute,
    });

    expect(compute.query).toHaveBeenCalledWith(
      expect.objectContaining({
        dialect: 'postgres',
      }),
    );
  });

  it('executes compiled SQL through a local query executor when requested', async () => {
    const queryExecutor = {
      execute: vi.fn(async () => ({
        headers: ['status', 'order_count'],
        rows: [['paid', 2]],
        totalRows: 1,
        command: 'SELECT',
        rowCount: 1,
      })),
    };

    const result = await compileLocalSlQuery(project, {
      connectionId: 'warehouse',
      query: {
        measures: ['orders.order_count'],
        dimensions: ['orders.status'],
        limit: 25,
      },
      compute,
      execute: true,
      maxRows: 10,
      queryExecutor,
    });

    expect(queryExecutor.execute).toHaveBeenCalledWith({
      connectionId: 'warehouse',
      projectDir: project.projectDir,
      connection: { driver: 'postgres' },
      sql: 'select status, count(*) as order_count from public.orders group by status',
      maxRows: 10,
    });
    expect(result.rows).toEqual([['paid', 2]]);
    expect(result.totalRows).toBe(1);
    expect(result.plan.execution).toEqual({
      mode: 'executed',
      driver: 'postgres',
      maxRows: 10,
      rowCount: 1,
    });
  });

  it('emits progress while compiling and executing a local semantic-layer query', async () => {
    const progress: Array<{ progress: number; message: string }> = [];
    const queryExecutor = {
      execute: vi.fn(async () => ({
        headers: ['status', 'order_count'],
        rows: [['paid', 2]],
        totalRows: 1,
        command: 'SELECT',
        rowCount: 1,
      })),
    };

    const result = await compileLocalSlQuery(project, {
      connectionId: 'warehouse',
      query: {
        measures: ['orders.order_count'],
        dimensions: ['orders.status'],
        limit: 25,
      },
      compute,
      execute: true,
      maxRows: 10,
      queryExecutor,
      onProgress: (event) => {
        progress.push({ progress: event.progress, message: event.message });
      },
    });

    expect(result.totalRows).toBe(1);
    expect(progress).toEqual([
      { progress: 0, message: 'Compiling query' },
      { progress: 0.3, message: 'Generating SQL' },
      { progress: 0.6, message: 'Executing' },
      { progress: 1, message: 'Fetched 1 rows' },
    ]);
  });

  it('requires a query executor for executed mode', async () => {
    await expect(
      compileLocalSlQuery(project, {
        connectionId: 'warehouse',
        query: { measures: ['orders.order_count'], dimensions: [] },
        compute,
        execute: true,
      }),
    ).rejects.toThrow('Local semantic-layer execution requires a query executor.');
  });

  it('requires connectionId, listing the configured connections, when several exist', async () => {
    project.config.connections.analytics = { driver: 'bigquery' };

    await expect(
      compileLocalSlQuery(project, {
        query: { measures: ['orders.order_count'], dimensions: [] },
        compute,
      }),
    ).rejects.toThrow('connectionId is required. Configured connections: analytics, warehouse.');
  });

  it('rejects a connectionId that is not configured, listing the configured connections', async () => {
    await expect(
      compileLocalSlQuery(project, {
        connectionId: 'DIG_SMART_REP',
        query: { measures: ['orders.order_count'], dimensions: [] },
        compute,
      }),
    ).rejects.toThrow('Connection "DIG_SMART_REP" is not configured in ktx.yaml. Configured connections: warehouse.');
  });
});
