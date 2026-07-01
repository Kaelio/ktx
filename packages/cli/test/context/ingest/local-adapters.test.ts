import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { initKtxProject, type KtxLocalProject, loadKtxProject } from '../../../src/context/project/project.js';
import type { SqlAnalysisPort } from '../../../src/context/sql-analysis/ports.js';
import type { HistoricSqlReader } from '../../../src/context/ingest/adapters/historic-sql/types.js';
import { LocalLookerRuntimeStore } from '../../../src/context/ingest/adapters/looker/local-runtime-store.js';
import { LocalNotionRuntimeStore } from '../../../src/context/ingest/adapters/notion/local-state-store.js';
import { createDefaultLocalIngestAdapters, localPullConfigForAdapter } from '../../../src/context/ingest/local-adapters.js';

describe('local ingest adapters', () => {
  let tempDir: string;
  let project: KtxLocalProject;

  beforeEach(async () => {
    tempDir = await mkdtemp(join(tmpdir(), 'ktx-local-adapters-'));
    const projectDir = join(tempDir, 'project');
    await initKtxProject({ projectDir });
    project = await loadKtxProject({ projectDir });
  });

  afterEach(async () => {
    await rm(tempDir, { recursive: true, force: true });
  });

  function projectWithConnections(connections: KtxLocalProject['config']['connections']): KtxLocalProject {
    return {
      ...project,
      config: {
        ...project.config,
        connections,
      },
    };
  }

  async function seedLiveScanTable(
    projectDir: string,
    connectionId: string,
    table: { catalog: string | null; db: string | null; name: string },
  ): Promise<void> {
    const rawRoot = join(projectDir, 'raw-sources', connectionId, 'live-database', 'sync-1');
    await mkdir(join(rawRoot, 'tables'), { recursive: true });
    await writeFile(
      join(rawRoot, 'connection.json'),
      `${JSON.stringify({ connectionId, driver: 'postgres' }, null, 2)}\n`,
      'utf-8',
    );
    await writeFile(
      join(rawRoot, 'tables', `${table.db ?? 'default'}-${table.name}.json`),
      `${JSON.stringify(
        {
          ...table,
          kind: 'table',
          comment: null,
          estimatedRows: null,
          columns: [],
          foreignKeys: [],
        },
        null,
        2,
      )}\n`,
      'utf-8',
    );
  }

  it('registers Metabase locally as a staged-bundle adapter', () => {
    const adapters = createDefaultLocalIngestAdapters(project);

    expect(adapters.map((adapter) => adapter.source)).toEqual([
      'fake',
      'live-database',
      'lookml',
      'dbt',
      'metabase',
      'sigma',
      'gdrive',
      'looker',
      'metricflow',
      'notion',
    ]);
    expect(adapters.find((adapter) => adapter.source === 'metabase')?.fetch).toBeTypeOf('function');
  });

  it('uses an explicit Looker runtime client seam for local adapter fetch tests', async () => {
    const runtimeClient = {
      cleanup: vi.fn().mockResolvedValue(undefined),
      listDashboards: vi.fn().mockResolvedValue([]),
      listLooks: vi.fn().mockResolvedValue([]),
      listFolders: vi.fn().mockResolvedValue({ folders: [] }),
      listUsers: vi.fn().mockResolvedValue([]),
      listGroups: vi.fn().mockResolvedValue([]),
      listLookmlModels: vi.fn().mockResolvedValue({ models: [] }),
      getDashboard: vi.fn(),
      getLook: vi.fn(),
      getExplore: vi.fn(),
      getSignals: vi.fn().mockResolvedValue({
        dashboardUsage: [],
        lookUsage: [],
        scheduledPlans: [],
        favorites: [],
      }),
    };
    const adapters = createDefaultLocalIngestAdapters(project, { looker: { runtimeClient } });
    const looker = adapters.find((adapter) => adapter.source === 'looker');

    expect(looker).toBeDefined();
    expect(looker?.fetch).toBeTypeOf('function');
  });

  it('returns the explicit Metabase fanout boundary before runner construction', async () => {
    const metabase = createDefaultLocalIngestAdapters(project).find((adapter) => adapter.source === 'metabase');

    await expect(localPullConfigForAdapter(project, metabase!, 'warehouse')).rejects.toThrow(
      'Metabase scheduled pulls fan out by mapping',
    );
  });

  it('registers historic-sql locally when Postgres historic-SQL deps are provided', () => {
    const sqlAnalysis: SqlAnalysisPort = {
      async analyzeForFingerprint(sql) {
        return {
          fingerprint: 'fp',
          normalizedSql: sql,
          tablesTouched: ['public.orders'],
          literalSlots: [],
        };
      },
      async analyzeBatch() {
        return new Map();
      },
      async validateReadOnly() {
        return { ok: true };
      },
    };
    const adapters = createDefaultLocalIngestAdapters(project, {
      historicSql: {
        sqlAnalysis,
        postgresQueryClient: {
          async executeQuery() {
            return { headers: [], rows: [] };
          },
        },
      },
    });

    expect(adapters.map((adapter) => adapter.source)).toContain('historic-sql');
    expect(adapters.find((adapter) => adapter.source === 'historic-sql')?.fetch).toBeTypeOf('function');
    expect(adapters.find((adapter) => adapter.source === 'historic-sql')?.skillNames).toEqual([
      'historic_sql_table_digest',
      'historic_sql_patterns',
    ]);
  });

  it('registers historic-sql with an injected non-Postgres reader and query client', () => {
    const reader: HistoricSqlReader = {
      async probe() {
        return { warnings: [], info: [] };
      },
      async *fetchAggregated() {},
    };
    const queryClient = { executeQuery: async () => ({ headers: [], rows: [], totalRows: 0 }) };

    const adapters = createDefaultLocalIngestAdapters(project, {
      historicSql: {
        sqlAnalysis: {
          async analyzeForFingerprint(sql) {
            return {
              fingerprint: 'fp',
              normalizedSql: sql,
              tablesTouched: [],
              literalSlots: [],
            };
          },
          async analyzeBatch() {
            return new Map();
          },
          async validateReadOnly() {
            return { ok: true };
          },
        },
        reader,
        queryClient,
      },
    });

    const adapter = adapters.find((candidate) => candidate.source === 'historic-sql');
    expect(adapter).toBeDefined();
    expect(adapter?.fetch).toBeTypeOf('function');
  });

  it('builds Postgres historic-sql pull config from a local connection', async () => {
    const historicSql = createDefaultLocalIngestAdapters(project, {
      historicSql: {
        sqlAnalysis: {
          async analyzeForFingerprint(sql) {
            return {
              fingerprint: 'fp',
              normalizedSql: sql,
              tablesTouched: ['public.orders'],
              literalSlots: [],
            };
          },
          async analyzeBatch() {
            return new Map();
          },
          async validateReadOnly() {
            return { ok: true };
          },
        },
        postgresQueryClient: {
          async executeQuery() {
            return { headers: [], rows: [] };
          },
        },
      },
    }).find((adapter) => adapter.source === 'historic-sql');
    const postgresProject = projectWithConnections({
      warehouse: {
        driver: 'postgres',
        url: 'env:WAREHOUSE_DATABASE_URL',
        context: {
          queryHistory: {
            enabled: true,
            minExecutions: 7,
            maxTemplatesPerRun: 123,
            filters: {
              serviceAccounts: { patterns: ['^svc_'], mode: 'exclude' },
              dropTrivialProbes: true,
            },
          },
        },
      },
    });

    await expect(localPullConfigForAdapter(postgresProject, historicSql!, 'warehouse')).resolves.toEqual({
      dialect: 'postgres',
      minExecutions: 7,
      enabledTables: [],
      enabledSchemas: [],
      modeledTableCatalog: [],
      filters: {
        serviceAccounts: { patterns: ['^svc_'], mode: 'exclude' },
        dropTrivialProbes: true,
      },
      redactionPatterns: [],
      scopeFloorWarnings: [],
      staleArchiveAfterDays: 90,
    });
  });

  it('maps connection context.queryHistory to historic-sql pull config', async () => {
    const project = projectWithConnections({
      warehouse: {
        driver: 'postgres',
        context: {
          queryHistory: {
            enabled: true,
            windowDays: 45,
            minExecutions: 7,
            filters: { dropTrivialProbes: true },
          },
        },
      },
    });
    const adapter = { source: 'historic-sql' } as never;

    await expect(localPullConfigForAdapter(project, adapter, 'warehouse')).resolves.toMatchObject({
      dialect: 'postgres',
      minExecutions: 7,
      filters: { dropTrivialProbes: true },
    });
  });

  it('passes computed modeled scope to direct historic-sql adapter pull config', async () => {
    await mkdir(join(project.projectDir, 'semantic-layer/warehouse'), { recursive: true });
    await writeFile(
      join(project.projectDir, 'semantic-layer/warehouse/revenue.yaml'),
      [
        'name: revenue',
        'table: orbit_analytics.mart_revenue',
        'grain: [id]',
        'columns:',
        '  - name: id',
        '    type: string',
        '',
      ].join('\n'),
      'utf-8',
    );
    await seedLiveScanTable(project.projectDir, 'warehouse', {
      catalog: null,
      db: 'orbit_raw',
      name: 'accounts',
    });
    const projectWithQueryHistory = projectWithConnections({
      warehouse: {
        driver: 'postgres',
        schemas: ['orbit_raw'],
        context: {
          queryHistory: {
            enabled: true,
            minExecutions: 7,
            filters: { dropTrivialProbes: true },
          },
        },
      },
    });
    const adapter = { source: 'historic-sql' } as never;

    await expect(localPullConfigForAdapter(projectWithQueryHistory, adapter, 'warehouse')).resolves.toMatchObject({
      dialect: 'postgres',
      minExecutions: 7,
      enabledSchemas: ['orbit_analytics', 'orbit_raw'],
      modeledTableCatalog: [
        { catalog: null, db: 'orbit_analytics', name: 'mart_revenue' },
        { catalog: null, db: 'orbit_raw', name: 'accounts' },
      ],
    });
  });

  it('passes query-history scope fail-open warnings to direct historic-sql pull config', async () => {
    const projectDir = await mkdtemp(join(tmpdir(), 'ktx-local-qh-scope-warning-'));
    const project = await initKtxProject({ projectDir });
    project.config.connections.warehouse = {
      driver: 'postgres',
      schemas: ['orbit_raw'],
      context: { queryHistory: { enabled: true } },
    } as never;
    const adapter = { source: 'historic-sql' } as never;

    await expect(localPullConfigForAdapter(project, adapter, 'warehouse')).resolves.toMatchObject({
      dialect: 'postgres',
      enabledSchemas: ['*'],
      scopeFloorWarnings: ['query_history_scope_floor_disabled:catalog_unavailable'],
    });

    await rm(projectDir, { recursive: true, force: true });
  });

  it('rejects local historic-sql pulls when the connection has not enabled historic SQL', async () => {
    const historicSql = createDefaultLocalIngestAdapters(project, {
      historicSql: {
        sqlAnalysis: {
          async analyzeForFingerprint(sql) {
            return {
              fingerprint: 'fp',
              normalizedSql: sql,
              tablesTouched: [],
              literalSlots: [],
            };
          },
          async analyzeBatch() {
            return new Map();
          },
          async validateReadOnly() {
            return { ok: true };
          },
        },
        postgresQueryClient: {
          async executeQuery() {
            return { headers: [], rows: [] };
          },
        },
      },
    }).find((adapter) => adapter.source === 'historic-sql');
    const postgresProject = projectWithConnections({
      warehouse: {
        driver: 'postgres',
        url: 'env:WAREHOUSE_DATABASE_URL',
      },
    });

    await expect(localPullConfigForAdapter(postgresProject, historicSql!, 'warehouse')).rejects.toThrow(
      'Connection "warehouse" does not have context.queryHistory.enabled: true',
    );
  });

  it('builds Looker pull config from local mapping state', async () => {
    const projectDir = await mkdtemp(join(tmpdir(), 'ktx-local-looker-'));
    const lookerProject = {
      projectDir,
      config: {
        connections: {
          'prod-looker': {
            driver: 'looker',
            base_url: 'https://looker.example.test',
            client_id: 'client',
          },
          'prod-warehouse': {
            driver: 'postgres',
            url: 'postgresql://readonly@db.example.test/analytics',
          },
        },
      },
    } as never;
    const store = new LocalLookerRuntimeStore({ dbPath: join(projectDir, '.ktx/db.sqlite') });
    await store.setCursors('prod-looker', { dashboardsLastSyncedAt: null, looksLastSyncedAt: null });
    await store.upsertConnectionMapping({
      lookerConnectionId: 'prod-looker',
      lookerConnectionName: 'analytics',
      ktxConnectionId: 'prod-warehouse',
      source: 'cli',
    });
    const lookerDeps = {
      looker: {
        client: {
          listLookmlModels: async () => ({
            source: 'looker',
            fetchedAt: '2026-05-05T00:00:00.000Z',
            models: [{ name: 'ecommerce', label: null, explores: [{ name: 'orders', label: null }] }],
          }),
          getExplore: async () => ({
            source: 'looker',
            modelName: 'ecommerce',
            exploreName: 'orders',
            label: null,
            description: null,
            connectionName: 'analytics',
            viewName: null,
            rawSqlTableName: 'public.orders',
            fields: { dimensions: [], measures: [] },
            joins: [],
            targetWarehouseConnectionId: null,
            targetTable: null,
          }),
        },
        parser: {
          parse: async () => ({
            'ecommerce.orders': {
              ok: true,
              catalog: null,
              schema: 'public',
              name: 'orders',
              canonical_table: 'public.orders',
            },
          }),
        },
      },
    };
    const adapter = createDefaultLocalIngestAdapters(lookerProject, lookerDeps).find(
      (candidate) => candidate.source === 'looker',
    );

    await expect(localPullConfigForAdapter(lookerProject, adapter!, 'prod-looker', lookerDeps)).resolves.toMatchObject({
      lookerConnectionId: 'prod-looker',
      connectionMappings: { analytics: 'prod-warehouse' },
      connectionTypes: { analytics: 'POSTGRESQL' },
      parsedTargetTables: {
        'ecommerce.orders': { ok: true, schema: 'public', name: 'orders', canonicalTable: 'public.orders' },
      },
    });
  });

  it('builds Looker pull config from yaml mapping bootstrap when SQLite is empty', async () => {
    const projectDir = await mkdtemp(join(tmpdir(), 'ktx-local-looker-yaml-'));
    const lookerProject = {
      projectDir,
      config: {
        connections: {
          'prod-looker': {
            driver: 'looker',
            base_url: 'https://looker.example.test',
            client_id: 'client',
            mappings: { connectionMappings: { analytics: 'prod-warehouse' } },
          },
          'prod-warehouse': {
            driver: 'postgres',
            url: 'postgresql://readonly@db.example.test/analytics',
          },
        },
      },
    } as never;
    const lookerDeps = {
      looker: {
        client: {
          listLookmlModels: async () => ({
            source: 'looker',
            fetchedAt: '2026-05-05T00:00:00.000Z',
            models: [{ name: 'ecommerce', label: null, explores: [{ name: 'orders', label: null }] }],
          }),
          getExplore: async () => ({
            source: 'looker',
            modelName: 'ecommerce',
            exploreName: 'orders',
            label: null,
            description: null,
            connectionName: 'analytics',
            viewName: null,
            rawSqlTableName: 'public.orders',
            fields: { dimensions: [], measures: [] },
            joins: [],
            targetWarehouseConnectionId: null,
            targetTable: null,
          }),
        },
        parser: {
          parse: async () => ({
            'ecommerce.orders': {
              ok: true,
              catalog: null,
              schema: 'public',
              name: 'orders',
              canonical_table: 'public.orders',
            },
          }),
        },
      },
    };
    const adapter = createDefaultLocalIngestAdapters(lookerProject, lookerDeps).find(
      (candidate) => candidate.source === 'looker',
    );

    await expect(localPullConfigForAdapter(lookerProject, adapter!, 'prod-looker', lookerDeps)).resolves.toMatchObject({
      connectionMappings: { analytics: 'prod-warehouse' },
      connectionTypes: { analytics: 'POSTGRESQL' },
    });
  });

  it('builds LookML pull config from flat ktx.yaml connection fields', async () => {
    const lookmlProject = {
      projectDir: tempDir,
      config: {
        connections: {
          'prod-lookml': {
            driver: 'lookml',
            repoUrl: 'https://github.com/acme/looker.git',
            branch: 'main',
            path: 'models',
            auth_token_ref: 'env:GITHUB_TOKEN',
            mappings: { expectedLookerConnectionName: 'bigquery_prod' },
          },
        },
      },
    } as never;
    const adapter = createDefaultLocalIngestAdapters(lookmlProject).find((candidate) => candidate.source === 'lookml');

    await expect(
      localPullConfigForAdapter(lookmlProject, adapter!, 'prod-lookml', {
        looker: { env: { GITHUB_TOKEN: 'ghp_test_token' } },
      }),
    ).resolves.toEqual({
      repoUrl: 'https://github.com/acme/looker.git',
      branch: 'main',
      path: 'models',
      authToken: 'ghp_test_token',
      expectedLookerConnectionName: 'bigquery_prod',
      parsedTargetTables: {},
    });
  });

  it('rejects local LookML scheduled pulls when repoUrl is missing', async () => {
    const lookmlProject = {
      projectDir: tempDir,
      config: { connections: { 'prod-lookml': { driver: 'lookml' } } },
    } as never;
    const adapter = createDefaultLocalIngestAdapters(lookmlProject).find((candidate) => candidate.source === 'lookml');

    await expect(localPullConfigForAdapter(lookmlProject, adapter!, 'prod-lookml')).rejects.toThrow(
      'lookml integration config missing repoUrl',
    );
  });

  it('reads dbt source_dir from local connection config', async () => {
    const project = projectWithConnections({
      analytics_dbt: {
        driver: 'dbt',
        source_dir: '/repo/dbt',
        profiles_path: '/repo/profiles',
        target: 'prod',
        project_name: 'analytics',
      },
    });
    const adapter = createDefaultLocalIngestAdapters(project).find((candidate) => candidate.source === 'dbt');

    await expect(localPullConfigForAdapter(project, adapter!, 'analytics_dbt')).resolves.toEqual({
      sourceDir: '/repo/dbt',
      profilesPath: '/repo/profiles',
      target: 'prod',
      projectName: 'analytics',
    });
  });

  it('reads dbt git repo config from local connection config', async () => {
    const dbtProject = projectWithConnections({
      analytics_dbt: {
        driver: 'dbt',
        repo_url: 'https://github.com/acme/dbt.git',
        branch: 'main',
        path: 'analytics',
        auth_token_ref: 'env:DBT_REPO_TOKEN',
      },
    });
    const adapter = createDefaultLocalIngestAdapters(dbtProject).find((candidate) => candidate.source === 'dbt');

    await expect(
      localPullConfigForAdapter(dbtProject, adapter!, 'analytics_dbt', {
        looker: { env: { DBT_REPO_TOKEN: 'token-123' } as NodeJS.ProcessEnv },
      }),
    ).resolves.toEqual({
      repoUrl: 'https://github.com/acme/dbt.git',
      branch: 'main',
      path: 'analytics',
      authToken: 'token-123',
    });
  });

  it('exposes configured primary warehouses as dbt target connections', async () => {
    const dbtProject: KtxLocalProject = {
      ...projectWithConnections({
        warehouse: {
          driver: 'postgres',
          url: 'postgresql://example/db',
        },
        analytics_dbt: {
          driver: 'dbt',
          source_dir: '/repo/dbt',
        },
      }),
      config: {
        ...project.config,
        setup: { database_connection_ids: ['warehouse'] },
        connections: {
          warehouse: {
            driver: 'postgres',
            url: 'postgresql://example/db',
          },
          analytics_dbt: {
            driver: 'dbt',
            source_dir: '/repo/dbt',
          },
        },
      },
    };
    const adapter = createDefaultLocalIngestAdapters(dbtProject).find((candidate) => candidate.source === 'dbt');

    await expect(adapter?.listTargetConnectionIds?.('/tmp/staged-dbt')).resolves.toEqual(['warehouse']);
  });

  it('passes primary warehouse connection ids to the local Notion adapter', async () => {
    const adapters = createDefaultLocalIngestAdapters(
      projectWithConnections({
        notion: {
          driver: 'notion',
          auth_token: 'secret',
          crawl_mode: 'selected_roots',
          root_page_ids: ['page-1'],
        },
        warehouse: {
          driver: 'postgres',
          url: 'postgresql://readonly@db.example.test/analytics',
        },
        docs: {
          driver: 'dbt',
          source_dir: './dbt',
        },
      } as never),
    );

    const notion = adapters.find((adapter) => adapter.source === 'notion');

    await expect(notion?.listTargetConnectionIds?.('/tmp/staged-notion')).resolves.toEqual(['warehouse']);
  });

  it('reads Notion cursors from local state instead of ktx.yaml', async () => {
    const cursor = '{"phase":"all_accessible_pages","cursor":"cursor-1"}';
    const notionProject = projectWithConnections({
      notion: {
        driver: 'notion',
        auth_token: 'secret',
        crawl_mode: 'all_accessible',
        last_successful_cursor: '{"phase":"all_accessible_pages","cursor":"stale-yaml"}',
      },
    } as never);
    await new LocalNotionRuntimeStore({ dbPath: join(notionProject.projectDir, '.ktx', 'db.sqlite') }).setCursor(
      'notion',
      cursor,
    );

    const notion = createDefaultLocalIngestAdapters(notionProject).find((adapter) => adapter.source === 'notion');

    await expect(localPullConfigForAdapter(notionProject, notion!, 'notion')).resolves.toMatchObject({
      lastSuccessfulCursor: cursor,
    });
  });

  it('persists Notion next cursors to local state after successful pulls', async () => {
    const cursor = '{"phase":"all_accessible_data_sources","cursor":"cursor-2"}';
    const notionProject = projectWithConnections({
      notion: {
        driver: 'notion',
        auth_token: 'secret',
        crawl_mode: 'all_accessible',
      },
    } as never);
    const stagedDir = await mkdtemp(join(tempDir, 'notion-staged-'));
    await writeFile(
      join(stagedDir, 'manifest.json'),
      JSON.stringify({
        source: 'notion',
        apiVersion: '2026-03-11',
        crawlMode: 'all_accessible',
        rootPageIds: [],
        rootDatabaseIds: [],
        rootDataSourceIds: [],
        fetchedAt: '2026-05-13T10:00:00.000Z',
        pageCount: 1,
        databaseCount: 0,
        dataSourceCount: 0,
        capped: true,
        continuedFromCursor: false,
        partialSnapshot: true,
        maxPagesPerRun: 1,
        maxKnowledgeCreatesPerRun: 25,
        maxKnowledgeUpdatesPerRun: 20,
        nextSuccessfulCursor: cursor,
        skipped: [],
        warnings: [],
      }),
      'utf-8',
    );

    const notion = createDefaultLocalIngestAdapters(notionProject).find((adapter) => adapter.source === 'notion');
    await notion?.onPullSucceeded?.({
      connectionId: 'notion',
      sourceKey: 'notion',
      syncId: 'sync-1',
      trigger: 'scheduled_pull',
      completedAt: new Date('2026-05-13T10:00:00.000Z'),
      stagedDir,
    });

    await expect(
      new LocalNotionRuntimeStore({ dbPath: join(notionProject.projectDir, '.ktx', 'db.sqlite') }).readCursor('notion'),
    ).resolves.toBe(cursor);
  });

  it('passes primary warehouse connection ids to local LookML and MetricFlow adapters', async () => {
    const adapters = createDefaultLocalIngestAdapters(
      projectWithConnections({
        warehouse: {
          driver: 'postgres',
          url: 'postgresql://readonly@db.example.test/analytics',
        },
        lookml_docs: {
          driver: 'lookml',
          lookml: {
            repoUrl: 'https://github.com/acme/lookml.git',
          },
        },
        metrics_repo: {
          driver: 'metricflow',
          metricflow: {
            repoUrl: 'https://github.com/acme/metrics.git',
          },
        },
      } as never),
    );

    const lookml = adapters.find((adapter) => adapter.source === 'lookml');
    const metricflow = adapters.find((adapter) => adapter.source === 'metricflow');

    await expect(lookml?.listTargetConnectionIds?.('/tmp/staged-lookml')).resolves.toEqual(['warehouse']);
    await expect(metricflow?.listTargetConnectionIds?.('/tmp/staged-metricflow')).resolves.toEqual(['warehouse']);
  });

  it('resolves MetricFlow auth_token_ref without writing literal tokens to config', async () => {
    const project = projectWithConnections({
      metricflow_main: {
        driver: 'metricflow',
        metricflow: {
          repoUrl: 'https://github.com/acme/metrics.git',
          branch: 'main',
          path: 'semantic_models',
          auth_token_ref: 'env:METRICFLOW_REPO_TOKEN',
        },
      },
    });
    const adapter = createDefaultLocalIngestAdapters(project).find((candidate) => candidate.source === 'metricflow');

    await expect(
      localPullConfigForAdapter(project, adapter!, 'metricflow_main', {
        looker: { env: { METRICFLOW_REPO_TOKEN: 'token-123' } as NodeJS.ProcessEnv },
      }),
    ).resolves.toEqual({
      repoUrl: 'https://github.com/acme/metrics.git',
      branch: 'main',
      path: 'semantic_models',
      authToken: 'token-123',
      parsedTargetTables: {},
    });
  });
});
