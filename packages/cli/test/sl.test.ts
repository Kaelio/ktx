import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { stripVTControlCharacters } from 'node:util';
import Database from 'better-sqlite3';
import { parseKtxProjectConfig, serializeKtxProjectConfig } from '../src/context/project/config.js';
import { initKtxProject } from '../src/context/project/project.js';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { runKtxSl } from '../src/sl.js';

const reportExceptionMock = vi.hoisted(() => vi.fn(async () => {}));

vi.mock('../src/telemetry/exception.js', () => ({
  reportException: reportExceptionMock,
}));

const ORDERS_YAML = [
  'name: orders',
  'table: public.orders',
  'grain:',
  '  - order_id',
  'columns:',
  '  - name: order_id',
  '    type: string',
  '',
].join('\n');

function makeIo(options: { isTTY?: boolean } = {}) {
  let stdout = '';
  let stderr = '';
  return {
    io: {
      stdout: {
        isTTY: options.isTTY,
        write: (chunk: string) => {
          stdout += chunk;
        },
      },
      stderr: {
        write: (chunk: string) => {
          stderr += chunk;
        },
      },
    },
    stdout: () => stdout,
    stderr: () => stderr,
  };
}

async function seedSlSource(input: {
  projectDir: string;
  connectionId?: string;
  sourceName?: string;
  yaml?: string;
}): Promise<void> {
  const project = await initKtxProject({ projectDir: input.projectDir });
  await project.fileStore.writeFile(
    `semantic-layer/${input.connectionId ?? 'warehouse'}/${input.sourceName ?? 'orders'}.yaml`,
    input.yaml ?? ORDERS_YAML,
    'ktx',
    'ktx@example.com',
    'Add semantic-layer source',
  );
}

describe('runKtxSl', () => {
  let tempDir: string;

  beforeEach(async () => {
    tempDir = await mkdtemp(join(tmpdir(), 'ktx-cli-sl-'));
    reportExceptionMock.mockClear();
  });

  afterEach(async () => {
    vi.unstubAllEnvs();
    await rm(tempDir, { recursive: true, force: true });
  });

  it('validates, lists, and searches semantic-layer sources', async () => {
    const projectDir = join(tempDir, 'project');
    await seedSlSource({ projectDir });

    const validateIo = makeIo();
    await expect(
      runKtxSl({ command: 'validate', projectDir, connectionId: 'warehouse', sourceName: 'orders' }, validateIo.io),
    ).resolves.toBe(0);
    expect(validateIo.stdout()).toContain('Valid semantic-layer source: warehouse/orders');

    const listIo = makeIo();
    await expect(
      runKtxSl({ command: 'list', projectDir, connectionId: 'warehouse', cliVersion: '0.0.0-test' }, listIo.io),
    ).resolves.toBe(0);
    expect(listIo.stdout()).toContain('warehouse\torders\tcolumns=1\tmeasures=0\tjoins=0');

    const searchIo = makeIo();
    await expect(
      runKtxSl(
        {
          command: 'search',
          projectDir,
          connectionId: 'warehouse',
          query: 'order',
          json: true,
          cliVersion: '0.0.0-test',
        },
        searchIo.io,
      ),
    ).resolves.toBe(0);
    expect(JSON.parse(searchIo.stdout())).toMatchObject({
      kind: 'list',
      data: {
        items: [
          expect.objectContaining({
            connectionId: 'warehouse',
            name: 'orders',
            score: expect.any(Number),
          }),
        ],
      },
      meta: { command: 'sl search' },
    });
  });

  it('reads a semantic-layer source as raw YAML', async () => {
    const projectDir = join(tempDir, 'read-project');
    await seedSlSource({ projectDir });

    const readIo = makeIo();
    await expect(
      runKtxSl(
        {
          command: 'read',
          projectDir,
          connectionId: 'warehouse',
          sourceName: 'orders',
        },
        readIo.io,
      ),
    ).resolves.toBe(0);

    expect(readIo.stdout()).toBe(ORDERS_YAML);
    expect(readIo.stderr()).toBe('');
  });

  it('reads a unique semantic-layer source without a connection id', async () => {
    const projectDir = join(tempDir, 'read-unique-project');
    const project = await initKtxProject({ projectDir });
    await project.fileStore.writeFile(
      'semantic-layer/warehouse/orders.yaml',
      ORDERS_YAML,
      'ktx',
      'ktx@example.com',
      'Add semantic-layer source',
    );
    await project.fileStore.writeFile(
      'semantic-layer/analytics/tickets.yaml',
      [
        'name: tickets',
        'table: public.tickets',
        'grain:',
        '  - ticket_id',
        'columns:',
        '  - name: ticket_id',
        '    type: string',
        '',
      ].join('\n'),
      'ktx',
      'ktx@example.com',
      'Add semantic-layer source',
    );

    const readIo = makeIo();
    await expect(
      runKtxSl(
        {
          command: 'read',
          projectDir,
          sourceName: 'tickets',
        },
        readIo.io,
      ),
    ).resolves.toBe(0);

    expect(readIo.stdout()).toContain('name: tickets');
    expect(readIo.stderr()).toBe('');
  });

  it('reports ambiguous unscoped reads with sorted connection ids', async () => {
    const projectDir = join(tempDir, 'read-ambiguous-project');
    const project = await initKtxProject({ projectDir });
    await project.fileStore.writeFile(
      'semantic-layer/warehouse/orders.yaml',
      ORDERS_YAML,
      'ktx',
      'ktx@example.com',
      'Add semantic-layer source',
    );
    await project.fileStore.writeFile(
      'semantic-layer/analytics/orders.yaml',
      ORDERS_YAML,
      'ktx',
      'ktx@example.com',
      'Add semantic-layer source',
    );

    const readIo = makeIo();
    await expect(
      runKtxSl(
        {
          command: 'read',
          projectDir,
          sourceName: 'orders',
        },
        readIo.io,
      ),
    ).resolves.toBe(1);

    expect(readIo.stdout()).toBe('');
    expect(readIo.stderr()).toBe(
      "Source 'orders' exists in multiple connections: analytics, warehouse. Re-run with --connection-id <id>.\n",
    );
  });

  it('reports a clear error when an unscoped semantic-layer source is missing', async () => {
    const projectDir = join(tempDir, 'missing-unscoped-read-project');
    await seedSlSource({ projectDir });

    const readIo = makeIo();
    await expect(
      runKtxSl(
        {
          command: 'read',
          projectDir,
          sourceName: 'missing_orders',
        },
        readIo.io,
      ),
    ).resolves.toBe(1);

    expect(readIo.stdout()).toBe('');
    expect(readIo.stderr()).toBe("No semantic-layer source 'missing_orders'\n");
  });

  it('reports a clear error when a semantic-layer source is missing', async () => {
    const projectDir = join(tempDir, 'missing-read-project');
    await seedSlSource({ projectDir });

    const readIo = makeIo();
    await expect(
      runKtxSl(
        {
          command: 'read',
          projectDir,
          connectionId: 'warehouse',
          sourceName: 'missing_orders',
        },
        readIo.io,
      ),
    ).resolves.toBe(1);

    expect(readIo.stdout()).toBe('');
    expect(readIo.stderr()).toBe("No semantic-layer source 'missing_orders' for connection 'warehouse'\n");
  });

  it('validates a unique semantic-layer source without a connection id', async () => {
    const projectDir = join(tempDir, 'validate-unique-project');
    const project = await initKtxProject({ projectDir });
    await project.fileStore.writeFile(
      'semantic-layer/warehouse/orders.yaml',
      ORDERS_YAML,
      'ktx',
      'ktx@example.com',
      'Add semantic-layer source',
    );
    await project.fileStore.writeFile(
      'semantic-layer/analytics/tickets.yaml',
      [
        'name: tickets',
        'table: public.tickets',
        'grain:',
        '  - ticket_id',
        'columns:',
        '  - name: ticket_id',
        '    type: string',
        '',
      ].join('\n'),
      'ktx',
      'ktx@example.com',
      'Add semantic-layer source',
    );

    const validateIo = makeIo();
    await expect(
      runKtxSl(
        {
          command: 'validate',
          projectDir,
          sourceName: 'tickets',
        },
        validateIo.io,
      ),
    ).resolves.toBe(0);

    expect(validateIo.stdout()).toBe('Valid semantic-layer source: analytics/tickets\n');
    expect(validateIo.stderr()).toBe('');
  });

  it('reports ambiguous unscoped validation with sorted connection ids', async () => {
    const projectDir = join(tempDir, 'validate-ambiguous-project');
    const project = await initKtxProject({ projectDir });
    await project.fileStore.writeFile(
      'semantic-layer/warehouse/orders.yaml',
      ORDERS_YAML,
      'ktx',
      'ktx@example.com',
      'Add semantic-layer source',
    );
    await project.fileStore.writeFile(
      'semantic-layer/analytics/orders.yaml',
      ORDERS_YAML,
      'ktx',
      'ktx@example.com',
      'Add semantic-layer source',
    );

    const validateIo = makeIo();
    await expect(
      runKtxSl(
        {
          command: 'validate',
          projectDir,
          sourceName: 'orders',
        },
        validateIo.io,
      ),
    ).resolves.toBe(1);

    expect(validateIo.stdout()).toBe('');
    expect(validateIo.stderr()).toBe(
      "Source 'orders' exists in multiple connections: analytics, warehouse. Re-run with --connection-id <id>.\n",
    );
  });

  it('reports a clear error when an unscoped semantic-layer source validation target is missing', async () => {
    const projectDir = join(tempDir, 'missing-unscoped-validate-project');
    await seedSlSource({ projectDir });

    const validateIo = makeIo();
    await expect(
      runKtxSl(
        {
          command: 'validate',
          projectDir,
          sourceName: 'missing_orders',
        },
        validateIo.io,
      ),
    ).resolves.toBe(1);

    expect(validateIo.stdout()).toBe('');
    expect(validateIo.stderr()).toBe('Semantic-layer source "missing_orders" was not found\n');
    expect(reportExceptionMock).toHaveBeenCalledWith(
      expect.objectContaining({
        context: expect.objectContaining({ source: 'sl validate', handled: true, fatal: false }),
        projectDir,
      }),
    );
  });

  it('keeps scoped validation not-found wording', async () => {
    const projectDir = join(tempDir, 'missing-scoped-validate-project');
    await seedSlSource({ projectDir });

    const validateIo = makeIo();
    await expect(
      runKtxSl(
        {
          command: 'validate',
          projectDir,
          connectionId: 'warehouse',
          sourceName: 'missing_orders',
        },
        validateIo.io,
      ),
    ).resolves.toBe(1);

    expect(validateIo.stdout()).toBe('');
    expect(validateIo.stderr()).toBe('Semantic-layer source "warehouse/missing_orders" was not found\n');
  });

  it('prints semantic-layer search rank badges in pretty output', async () => {
    const projectDir = join(tempDir, 'rank-project');
    await seedSlSource({ projectDir });

    const searchIo = makeIo();
    await expect(
      runKtxSl(
        {
          command: 'search',
          projectDir,
          connectionId: 'warehouse',
          query: 'order',
          output: 'pretty',
          cliVersion: '0.0.0-test',
        },
        searchIo.io,
      ),
    ).resolves.toBe(0);

    const stdout = stripVTControlCharacters(searchIo.stdout());
    expect(stdout).toMatch(/#1\s+orders/);
    expect(stdout).not.toContain('%');
  });

  it('prints semantic-layer list and search as public JSON envelopes', async () => {
    const projectDir = join(tempDir, 'project');
    await seedSlSource({
      projectDir,
      yaml: [
        'name: orders',
        'table: public.orders',
        'descriptions:',
        '  user: Paid order facts',
        'grain: [order_id]',
        'columns:',
        '  - name: order_id',
        '    type: string',
        '',
      ].join('\n'),
    });

    const listIo = makeIo();
    await expect(
      runKtxSl(
        {
          command: 'search',
          projectDir,
          connectionId: 'warehouse',
          query: 'paid',
          json: true,
          cliVersion: '0.0.0-test',
        },
        listIo.io,
      ),
    ).resolves.toBe(0);
    expect(JSON.parse(listIo.stdout())).toMatchObject({
      kind: 'list',
      data: {
        items: [
          expect.objectContaining({
            connectionId: 'warehouse',
            name: 'orders',
            score: expect.any(Number),
            matchReasons: expect.any(Array),
          }),
        ],
      },
      meta: { command: 'sl search' },
    });
  });

  it('fails validation when a table-backed source declares columns absent from a matching warehouse manifest', async () => {
    const projectDir = join(tempDir, 'project');
    const project = await initKtxProject({ projectDir });
    await project.fileStore.writeFile(
      'semantic-layer/postgres-warehouse/_schema/orbit_analytics.yaml',
      `tables:
  int_active_contract_arr:
    table: orbit_analytics.int_active_contract_arr
    columns:
      - { name: contract_id, type: string }
      - { name: contract_arr_cents, type: number }
`,
      'ktx',
      'ktx@example.com',
      'Add warehouse manifest',
    );
    await project.fileStore.writeFile(
      'semantic-layer/dbt-main/int_active_contract_arr.yaml',
      `name: int_active_contract_arr
table: orbit_analytics.int_active_contract_arr
grain: [contract_id]
columns:
  - { name: contract_id, type: string }
  - { name: arr_cents, type: number }
measures:
  - { name: arr, expr: sum(arr_cents) }
joins: []
`,
      'ktx',
      'ktx@example.com',
      'Add invalid dbt source',
    );

    const validateIo = makeIo();
    await expect(
      runKtxSl(
        {
          command: 'validate',
          projectDir,
          connectionId: 'dbt-main',
          sourceName: 'int_active_contract_arr',
        },
        validateIo.io,
      ),
    ).resolves.toBe(1);

    expect(validateIo.stderr()).toContain('arr_cents');
    expect(validateIo.stderr()).toContain('absent from physical table');
  });

  it('runs sl query and prints SQL output', async () => {
    const projectDir = join(tempDir, 'project');
    const project = await initKtxProject({ projectDir });
    project.config.connections.warehouse = { driver: 'postgres' };
    await project.fileStore.writeFile(
      'semantic-layer/warehouse/orders.yaml',
      `name: orders
table: public.orders
grain: [id]
columns:
  - name: id
    type: number
measures:
  - name: order_count
    expr: count(*)
joins: []
`,
      'ktx',
      'ktx@example.com',
      'Add orders source',
    );

    const stdout = { write: vi.fn() };
    const stderr = { write: vi.fn() };
    const loadProject = vi.fn(async () => project);
    const createSemanticLayerCompute = vi.fn(() => ({
      query: vi.fn(async () => ({
        sql: 'select count(*) as order_count from public.orders',
        dialect: 'postgres',
        columns: [{ name: 'orders.order_count' }],
        plan: {},
      })),
      validateSources: vi.fn(),
      generateSources: vi.fn(),
    }));

    await expect(
      runKtxSl(
        {
          command: 'query',
          projectDir: '/tmp/project',
          connectionId: 'warehouse',
          query: { measures: ['orders.order_count'], dimensions: [] },
          format: 'sql',
          execute: false,
          cliVersion: '0.2.0',
          runtimeInstallPolicy: 'auto',
        },
        { stdout, stderr },
        { loadProject, createSemanticLayerCompute },
      ),
    ).resolves.toBe(0);

    expect(stdout.write).toHaveBeenCalledWith('select count(*) as order_count from public.orders\n');
    expect(stderr.write).not.toHaveBeenCalled();
  });

  it('reports sl query exceptions at the query catch boundary', async () => {
    vi.stubEnv('ANTHROPIC_API_KEY', 'sl-anthropic-secret'); // pragma: allowlist secret
    const projectDir = join(tempDir, 'missing-query-input');
    await seedSlSource({ projectDir });
    const config = parseKtxProjectConfig(await readFile(join(projectDir, 'ktx.yaml'), 'utf-8'));
    await writeFile(
      join(projectDir, 'ktx.yaml'),
      serializeKtxProjectConfig({
        ...config,
        llm: {
          ...config.llm,
          provider: {
            backend: 'anthropic',
            anthropic: { api_key: 'env:ANTHROPIC_API_KEY' }, // pragma: allowlist secret
          },
          models: { default: 'claude-sonnet-4-6' },
        },
      }),
      'utf-8',
    );
    const io = makeIo();

    await expect(
      runKtxSl(
        {
          command: 'query',
          projectDir,
          connectionId: 'warehouse',
          format: 'json',
          execute: false,
          cliVersion: '0.2.0',
          runtimeInstallPolicy: 'auto',
        },
        io.io,
      ),
    ).resolves.toBe(1);

    expect(io.stderr()).toContain('sl query requires query input');
    expect(reportExceptionMock).toHaveBeenCalledWith(
      expect.objectContaining({
        context: expect.objectContaining({ source: 'sl query', handled: true, fatal: false }),
        projectDir,
        redactionSecrets: expect.arrayContaining(['sl-anthropic-secret']),
      }),
    );
  });

  it('emits debug telemetry for sl query without project paths', async () => {
    vi.stubEnv('KTX_TELEMETRY_DEBUG', '1');
    vi.stubEnv('CI', '');
    const projectDir = join(tempDir, 'project');
    await seedSlSource({ projectDir });
    const config = parseKtxProjectConfig(await readFile(join(projectDir, 'ktx.yaml'), 'utf-8'));
    await writeFile(
      join(projectDir, 'ktx.yaml'),
      serializeKtxProjectConfig({
        ...config,
        connections: { ...config.connections, warehouse: { driver: 'postgres' } },
      }),
      'utf-8',
    );
    const io = makeIo({ isTTY: true });
    const createSemanticLayerCompute = vi.fn(() => ({
      query: vi.fn(async () => ({
        sql: 'select count(*) as order_count from public.orders',
        dialect: 'postgres',
        columns: [{ name: 'orders.order_count' }],
        plan: {},
      })),
      validateSources: vi.fn(),
      generateSources: vi.fn(),
    }));

    const code = await runKtxSl(
      {
        command: 'query',
        projectDir,
        connectionId: 'warehouse',
        query: { measures: ['orders.order_count'], dimensions: [] },
        format: 'json',
        execute: false,
        cliVersion: '0.2.0',
        runtimeInstallPolicy: 'auto',
      },
      io.io,
      { createSemanticLayerCompute },
    );

    expect(code).toBe(0);
    expect(io.stderr()).toContain('"event":"sl_query_completed"');
    expect(io.stderr()).not.toContain(projectDir);
  });

  it('runs sl query from a JSON query file', async () => {
    const projectDir = join(tempDir, 'project');
    const project = await initKtxProject({ projectDir });
    project.config.connections.warehouse = { driver: 'postgres' };
    await writeFile(join(projectDir, 'ktx.yaml'), serializeKtxProjectConfig(project.config), 'utf-8');
    await project.fileStore.writeFile(
      'semantic-layer/warehouse/orders.yaml',
      `name: orders
table: public.orders
grain: [id]
columns:
  - name: id
    type: number
measures:
  - name: order_count
    expr: count(*)
joins: []
`,
      'ktx',
      'ktx@example.com',
      'Add orders source',
    );
    const queryFile = join(tempDir, 'query.json');
    await writeFile(queryFile, '{"measures":["orders.order_count"],"dimensions":[]}', 'utf-8');

    const stdout = { write: vi.fn() };
    const stderr = { write: vi.fn() };
    const query = vi.fn(async () => ({
        sql: 'select count(*) as order_count from public.orders',
        dialect: 'postgres',
        columns: [{ name: 'orders.order_count' }],
        plan: {},
      }));
    const createSemanticLayerCompute = vi.fn(() => ({
      query,
      validateSources: vi.fn(),
      generateSources: vi.fn(),
    }));

    await expect(
      runKtxSl(
        {
          command: 'query',
          projectDir,
          connectionId: 'warehouse',
          queryFile,
          format: 'json',
          execute: false,
          cliVersion: '0.2.0',
          runtimeInstallPolicy: 'auto',
        },
        { stdout, stderr },
        { createSemanticLayerCompute },
      ),
    ).resolves.toBe(0);

    expect(query).toHaveBeenCalledWith(
      expect.objectContaining({
        query: { measures: ['orders.order_count'], dimensions: [], predefined_measures_only: false },
      }),
    );
    expect(JSON.parse(String(stdout.write.mock.calls[0][0]))).toMatchObject({
      sql: 'select count(*) as order_count from public.orders',
      plan: { execution: { mode: 'compile_only' } },
    });
    expect(stderr.write).not.toHaveBeenCalled();
  });

  it('creates default sl query compute through the managed runtime helper', async () => {
    const projectDir = join(tempDir, 'project');
    const project = await initKtxProject({ projectDir });
    project.config.connections.warehouse = { driver: 'postgres' };
    await writeFile(join(projectDir, 'ktx.yaml'), serializeKtxProjectConfig(project.config), 'utf-8');
    await project.fileStore.writeFile(
      'semantic-layer/warehouse/orders.yaml',
      `name: orders
table: public.orders
grain: [id]
columns:
  - name: id
    type: number
measures:
  - name: order_count
    expr: count(*)
joins: []
`,
      'ktx',
      'ktx@example.com',
      'Add orders source',
    );

    const stdout = { write: vi.fn() };
    const stderr = { write: vi.fn() };
    const compute = {
      query: vi.fn(async () => ({
        sql: 'select count(*) as order_count from public.orders',
        dialect: 'postgres',
        columns: [{ name: 'orders.order_count' }],
        plan: {},
      })),
      validateSources: vi.fn(),
      generateSources: vi.fn(),
    };
    const createManagedSemanticLayerCompute = vi.fn(async () => compute);

    await expect(
      runKtxSl(
        {
          command: 'query',
          projectDir,
          connectionId: 'warehouse',
          query: { measures: ['orders.order_count'], dimensions: [] },
          format: 'sql',
          execute: false,
          cliVersion: '0.2.0',
          runtimeInstallPolicy: 'auto',
        },
        { stdout, stderr },
        { createManagedSemanticLayerCompute },
      ),
    ).resolves.toBe(0);

    expect(createManagedSemanticLayerCompute).toHaveBeenCalledWith({
      cliVersion: '0.2.0',
      installPolicy: 'auto',
      io: { stdout, stderr },
      projectDir,
    });
    expect(stdout.write).toHaveBeenCalledWith('select count(*) as order_count from public.orders\n');
  });

  it('executes sl query through the injected query executor', async () => {
    const projectDir = join(tempDir, 'project');
    const project = await initKtxProject({ projectDir });
    project.config.connections.warehouse = { driver: 'postgres', url: 'postgres://example/db' };
    await project.fileStore.writeFile(
      'semantic-layer/warehouse/orders.yaml',
      `name: orders
table: public.orders
grain: [id]
columns:
  - name: id
    type: number
measures:
  - name: order_count
    expr: count(*)
joins: []
`,
      'ktx',
      'ktx@example.com',
      'Add orders source',
    );

    const stdout = { write: vi.fn() };
    const stderr = { write: vi.fn() };
    const loadProject = vi.fn(async () => project);
    const queryExecutor = {
      execute: vi.fn(async () => ({
        headers: ['orders.order_count'],
        rows: [[4]],
        totalRows: 1,
        command: 'SELECT',
        rowCount: 1,
      })),
    };
    const createSemanticLayerCompute = vi.fn(() => ({
      query: vi.fn(async () => ({
        sql: 'select count(*) as order_count from public.orders',
        dialect: 'postgres',
        columns: [{ name: 'orders.order_count' }],
        plan: {},
      })),
      validateSources: vi.fn(),
      generateSources: vi.fn(),
    }));

    await expect(
      runKtxSl(
        {
          command: 'query',
          projectDir,
          connectionId: 'warehouse',
          query: { measures: ['orders.order_count'], dimensions: [] },
          format: 'json',
          execute: true,
          maxRows: 20,
          cliVersion: '0.2.0',
          runtimeInstallPolicy: 'auto',
        },
        { stdout, stderr },
        {
          loadProject,
          createSemanticLayerCompute,
          createQueryExecutor: () => queryExecutor,
        },
      ),
    ).resolves.toBe(0);

    expect(queryExecutor.execute).toHaveBeenCalledWith(
      expect.objectContaining({
        connectionId: 'warehouse',
        maxRows: 20,
      }),
    );
    expect(JSON.parse(String(stdout.write.mock.calls[0][0]))).toMatchObject({
      rows: [[4]],
      totalRows: 1,
      plan: {
        execution: {
          mode: 'executed',
        },
      },
    });
    expect(stderr.write).not.toHaveBeenCalled();
  });

  it('executes sl query against a local SQLite connection through the default executor', async () => {
    const projectDir = join(tempDir, 'project');
    const project = await initKtxProject({ projectDir });
    const dbPath = join(projectDir, 'warehouse.db');
    const db = new Database(dbPath);
    db.exec(`
      CREATE TABLE orders (
        id INTEGER PRIMARY KEY,
        status TEXT NOT NULL
      );
      INSERT INTO orders (status) VALUES ('paid'), ('paid'), ('open');
    `);
    db.close();

    project.config.connections.warehouse = { driver: 'sqlite', path: 'warehouse.db' };
    await writeFile(
      join(projectDir, 'ktx.yaml'),
      [
        'connections:',
        '  warehouse:',
        '    driver: sqlite',
        '    path: warehouse.db',
        '',
      ].join('\n'),
      'utf-8',
    );
    await project.fileStore.writeFile(
      'semantic-layer/warehouse/orders.yaml',
      `name: orders
table: orders
grain: [id]
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

    const stdout = { write: vi.fn() };
    const stderr = { write: vi.fn() };
    const createSemanticLayerCompute = vi.fn(() => ({
      query: vi.fn(async () => ({
        sql: 'select count(*) as order_count from orders',
        dialect: 'sqlite',
        columns: [{ name: 'orders.order_count' }],
        plan: {},
      })),
      validateSources: vi.fn(),
      generateSources: vi.fn(),
    }));

    const exitCode = await runKtxSl(
      {
        command: 'query',
        projectDir,
        connectionId: 'warehouse',
        query: { measures: ['orders.order_count'], dimensions: [] },
        format: 'json',
        execute: true,
        maxRows: 20,
        cliVersion: '0.2.0',
        runtimeInstallPolicy: 'auto',
      },
      { stdout, stderr },
      { createSemanticLayerCompute },
    );

    expect(stderr.write).not.toHaveBeenCalled();
    expect(exitCode).toBe(0);
    expect(JSON.parse(String(stdout.write.mock.calls[0][0]))).toMatchObject({
      connectionId: 'warehouse',
      dialect: 'sqlite',
      rows: [[3]],
      totalRows: 1,
      plan: {
        execution: {
          mode: 'executed',
          driver: 'sqlite',
          maxRows: 20,
          rowCount: 1,
        },
      },
    });
  });

  it('emits sl list as a JSON envelope when output=json', async () => {
    const projectDir = join(tempDir, 'project');
    await seedSlSource({ projectDir });

    const listIo = makeIo();
    const code = await runKtxSl(
      { command: 'list', projectDir, connectionId: 'warehouse', output: 'json', cliVersion: '0.0.0-test' },
      listIo.io,
    );
    expect(code).toBe(0);
    expect(listIo.stderr()).toBe('');

    const parsed = JSON.parse(listIo.stdout());
    expect(parsed).toMatchObject({
      kind: 'list',
      data: {
        items: expect.any(Array),
      },
      meta: {
        command: 'sl list',
      },
    });
    expect(parsed.data.items).toHaveLength(1);
    expect(parsed.data.items[0]).toMatchObject({
      connectionId: 'warehouse',
      name: 'orders',
      columnCount: 1,
      measureCount: 0,
      joinCount: 0,
    });
  });

  it('search prints embeddings status when results are empty', async () => {
    const stderr: string[] = [];
    const io = {
      stdout: { write: (_chunk: string) => {} },
      stderr: {
        write: (chunk: string) => {
          stderr.push(chunk);
        },
      },
    };
    const projectDir = join(tempDir, 'empty-status');
    const project = await initKtxProject({ projectDir });
    await expect(
      runKtxSl(
        {
          command: 'search',
          projectDir: project.projectDir,
          query: 'nope',
          cliVersion: '0.5.0',
        },
        io,
        {
          loadProject: async () => project,
          resolveEmbeddingProvider: async () => ({
            kind: 'managed-unavailable',
            reason: 'managed embeddings daemon is not running',
          }),
          searchLocalSlSources: async () => [],
        },
      ),
    ).resolves.toBe(0);
    expect(stderr.join('')).toMatch(/embeddings: unavailable/);
    expect(stderr.join('')).toMatch(/managed embeddings daemon is not running/);
  });

  it('passes a managed-daemon-backed embedding service into the search', async () => {
    const projectDir = join(tempDir, 'resolver-project');
    const project = await initKtxProject({ projectDir });
    const search = vi.fn(async () => []);
    const searchIo = makeIo();
    await expect(
      runKtxSl(
        {
          command: 'search',
          projectDir: project.projectDir,
          query: 'income',
          cliVersion: '0.5.0',
          json: true,
        },
        searchIo.io,
        {
          loadProject: async () => project,
          resolveEmbeddingProvider: async () => ({
            kind: 'managed-running',
            provider: { id: 'fake' } as never,
            baseUrl: 'http://127.0.0.1:51234',
          }),
          searchLocalSlSources: search,
        },
      ),
    ).resolves.toBe(0);
    expect(search).toHaveBeenCalledWith(
      project,
      expect.objectContaining({ embeddingService: expect.any(Object) }),
    );
  });

  it('emits sl list with grouping and Clack-style framing when output=pretty', async () => {
    const projectDir = join(tempDir, 'project');
    await seedSlSource({ projectDir });

    const listIo = makeIo();
    const code = await runKtxSl(
      { command: 'list', projectDir, connectionId: 'warehouse', output: 'pretty', cliVersion: '0.0.0-test' },
      listIo.io,
    );
    expect(code).toBe(0);

    const stripAnsi = (s: string) => s.replace(/\[[0-9;]*m/g, '');
    const out = stripAnsi(listIo.stdout());
    expect(out).toContain('sl list');
    expect(out).toContain('warehouse');
    expect(out).toContain('orders');
    expect(out).toContain('1 source');
  });
});
