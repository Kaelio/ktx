import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { initKtxProject } from '../src/context/project/project.js';
import { type KtxProjectConnectionConfig, parseKtxProjectConfig, serializeKtxProjectConfig } from '../src/context/project/config.js';
import { readKtxSetupState } from '../src/context/project/setup-config.js';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { KtxCliIo } from '../src/cli-runtime.js';
import {
  runKtxSetupSourcesStep,
  type KtxSetupSourcesDeps,
  type KtxSetupSourcesPromptAdapter,
  type KtxSetupSourceType,
} from '../src/setup-sources.js';

function makeIo() {
  let stdout = '';
  let stderr = '';
  return {
    io: {
      stdout: {
        isTTY: true,
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

function prompts(values: {
  multiselect?: string[][];
  select?: string[];
  text?: Array<string | undefined>;
  password?: Array<string | undefined>;
}): KtxSetupSourcesPromptAdapter {
  const multiselectValues = [...(values.multiselect ?? [])];
  const selectValues = [...(values.select ?? [])];
  const textValues = [...(values.text ?? [])];
  const passwordValues = [...(values.password ?? [])];
  return {
    multiselect: vi.fn(async () => multiselectValues.shift() ?? []),
    select: vi.fn(async () => selectValues.shift() ?? 'skip'),
    autocomplete: vi.fn(async () => selectValues.shift() ?? 'skip'),
    text: vi.fn(async () => (textValues.length > 0 ? textValues.shift() : '')),
    password: vi.fn(async () => (passwordValues.length > 0 ? passwordValues.shift() : undefined)),
    cancel: vi.fn(),
    log: vi.fn(),
  };
}

function connectionNamePrompt(label: string): string {
  return `Name this ${label} connection\nktx will use this short name in commands and config. You can rename it now.`;
}

function textInputPrompt(message: string): string {
  const normalized = message.replace(/\n+$/, '');
  if (!normalized.includes('\n')) {
    return `${normalized}\n│  Press Escape to go back.\n│`;
  }
  const [title, ...bodyLines] = normalized.split('\n');
  return `${title}\n│\n│  ${bodyLines.join('\n│  ')}\n│  Press Escape to go back.\n│`;
}

describe('setup sources step', () => {
  let tempDir: string;
  let projectDir: string;

  beforeEach(async () => {
    tempDir = await mkdtemp(join(tmpdir(), 'ktx-setup-sources-'));
    projectDir = join(tempDir, 'project');
    await initKtxProject({ projectDir });
  });

  afterEach(async () => {
    vi.unstubAllEnvs();
    await rm(tempDir, { recursive: true, force: true });
  });

  async function readConfig() {
    return parseKtxProjectConfig(await readFile(join(projectDir, 'ktx.yaml'), 'utf-8'));
  }

  async function addPrimarySource() {
    const config = await readConfig();
    await writeFile(
      join(projectDir, 'ktx.yaml'),
      serializeKtxProjectConfig({
        ...config,
        connections: {
          ...config.connections,
          warehouse: { driver: 'postgres', url: 'env:DATABASE_URL' },
        },
        setup: {
          ...config.setup,
          database_connection_ids: ['warehouse'],
        },
      }),
      'utf-8',
    );
  }

  async function addConnection(connectionId: string, connection: KtxProjectConnectionConfig) {
    const config = await readConfig();
    await writeFile(
      join(projectDir, 'ktx.yaml'),
      serializeKtxProjectConfig({
        ...config,
        connections: {
          ...config.connections,
          [connectionId]: connection,
        },
      }),
      'utf-8',
    );
  }

  it('marks optional sources complete when skipped', async () => {
    const io = makeIo();
    await expect(
      runKtxSetupSourcesStep(
        { projectDir, inputMode: 'disabled', runInitialSourceIngest: false, skipSources: true },
        io.io,
      ),
    ).resolves.toEqual({
      status: 'skipped',
      projectDir,
    });

    expect((await readKtxSetupState(projectDir)).completed_steps).toContain('sources');
    expect(io.stdout()).toContain('Context source setup skipped.');
  });

  it('writes a dbt local source connection after validation succeeds', async () => {
    await addPrimarySource();
    const validateDbt = vi.fn(async () => ({ ok: true as const, detail: 'project=analytics schemas=2' }));
    const runInitialIngest = vi.fn(async () => 0);
    const io = makeIo();

    await expect(
      runKtxSetupSourcesStep(
        {
          projectDir,
          inputMode: 'disabled',
          source: 'dbt',
          sourceConnectionId: 'analytics_dbt',
          sourcePath: '/repo/dbt',
          sourceProjectName: 'analytics',
          runInitialSourceIngest: true,
          skipSources: false,
        },
        io.io,
        { validateDbt, runInitialIngest },
      ),
    ).resolves.toEqual({ status: 'ready', projectDir, connectionIds: ['analytics_dbt'] });

    const config = await readConfig();
    expect(config.connections.analytics_dbt).toMatchObject({
      driver: 'dbt',
      source_dir: '/repo/dbt',
      project_name: 'analytics',
    });
    expect((await readKtxSetupState(projectDir)).completed_steps).toContain('sources');
    expect(runInitialIngest).toHaveBeenCalledWith(projectDir, 'analytics_dbt', io.io, { inputMode: 'disabled' });
  });

  it('emits debug telemetry when setup writes a source connection', async () => {
    vi.stubEnv('KTX_TELEMETRY_DEBUG', '1');
    vi.stubEnv('CI', '');
    await addPrimarySource();
    const io = makeIo();

    const result = await runKtxSetupSourcesStep(
      {
        projectDir,
        inputMode: 'disabled',
        source: 'dbt',
        sourceConnectionId: 'analytics_dbt',
        sourcePath: '/repo/dbt',
        sourceProjectName: 'analytics',
        runInitialSourceIngest: false,
        skipSources: false,
      },
      io.io,
      { validateDbt: vi.fn(async () => ({ ok: true as const, detail: 'project=analytics schemas=2' })) },
    );

    expect(result.status).toBe('ready');
    expect(io.stderr()).toContain('"event":"connection_added"');
    expect(io.stderr()).toContain('"driver":"dbt"');
    expect(io.stderr()).toContain('"isDemoConnection":false');
    expect(io.stderr()).not.toContain(projectDir);
  });

  it('writes Metabase config and validates mapping through existing mapping path', async () => {
    await addPrimarySource();
    const validateMetabase = vi.fn(async () => ({ ok: true as const, detail: 'user=admin@example.com' }));
    const runMapping = vi.fn(async (_projectDir: string, _connectionId: string, commandIo: KtxCliIo) => {
      commandIo.stdout.write('Mapping validated — 1 mapping configured\n');
      return 0;
    });
    const io = makeIo();

    await expect(
      runKtxSetupSourcesStep(
        {
          projectDir,
          inputMode: 'disabled',
          source: 'metabase',
          sourceConnectionId: 'prod_metabase',
          sourceUrl: 'https://metabase.example.com',
          sourceApiKeyRef: 'env:METABASE_API_KEY', // pragma: allowlist secret
          sourceWarehouseConnectionId: 'warehouse',
          metabaseDatabaseId: 1,
          runInitialSourceIngest: false,
          skipSources: false,
        },
        io.io,
        { validateMetabase, runMapping },
      ),
    ).resolves.toEqual({ status: 'ready', projectDir, connectionIds: ['prod_metabase'] });

    expect((await readConfig()).connections.prod_metabase).toMatchObject({
      driver: 'metabase',
      api_url: 'https://metabase.example.com',
      api_key_ref: 'env:METABASE_API_KEY', // pragma: allowlist secret
      mappings: {
        databaseMappings: { '1': 'warehouse' },
        syncEnabled: { '1': true },
        syncMode: 'ALL',
      },
    });
    expect(runMapping).toHaveBeenCalledWith(
      projectDir,
      'prod_metabase',
      expect.objectContaining({
        stdout: expect.objectContaining({ write: expect.any(Function) }),
        stderr: expect.objectContaining({ write: expect.any(Function) }),
      }),
    );
    expect(io.stdout()).toContain('│  Mapping validated — 1 mapping configured');
    expect(io.stdout()).not.toMatch(/^Mapping validated — 1 mapping configured$/m);
  });

  it('writes Notion config with the full default knowledge create budget', async () => {
    await addPrimarySource();
    const validateNotion = vi.fn(async () => ({ ok: true as const, detail: 'roots=1' }));

    await expect(
      runKtxSetupSourcesStep(
        {
          projectDir,
          inputMode: 'disabled',
          source: 'notion',
          sourceConnectionId: 'notion-main',
          sourceAuthTokenRef: 'env:NOTION_TOKEN', // pragma: allowlist secret
          notionCrawlMode: 'selected_roots',
          notionRootPageIds: ['page-1'],
          runInitialSourceIngest: false,
          skipSources: false,
        },
        makeIo().io,
        { validateNotion },
      ),
    ).resolves.toEqual({ status: 'ready', projectDir, connectionIds: ['notion-main'] });

    expect((await readConfig()).connections['notion-main']).toMatchObject({
      driver: 'notion',
      auth_token_ref: 'env:NOTION_TOKEN',
      root_page_ids: ['page-1'],
      max_knowledge_creates_per_run: 25,
      max_knowledge_updates_per_run: 20,
    });
    expect((await readConfig()).connections['notion-main']?.last_successful_cursor).toBeUndefined();
  });

  it('writes Google Drive config with a non-recursive default', async () => {
    await addPrimarySource();
    const validateGdrive = vi.fn(async () => ({ ok: true as const, detail: 'docs=2' }));

    await expect(
      runKtxSetupSourcesStep(
        {
          projectDir,
          inputMode: 'disabled',
          source: 'gdrive',
          sourceConnectionId: 'gdrive-main',
          gdriveServiceAccountKeyRef: 'file:/tmp/gdrive-key.json', // pragma: allowlist secret
          gdriveFolderId: 'folder-123',
          runInitialSourceIngest: false,
          skipSources: false,
        },
        makeIo().io,
        { validateGdrive },
      ),
    ).resolves.toEqual({ status: 'ready', projectDir, connectionIds: ['gdrive-main'] });

    expect((await readConfig()).connections['gdrive-main']).toMatchObject({
      driver: 'gdrive',
      service_account_key_ref: 'file:/tmp/gdrive-key.json', // pragma: allowlist secret
      folder_id: 'folder-123',
      recursive: false,
    });
  });

  it('rejects --source-api-key-ref for Notion and points at --source-auth-token-ref', async () => {
    await addPrimarySource();
    const io = makeIo();

    await expect(
      runKtxSetupSourcesStep(
        {
          projectDir,
          inputMode: 'disabled',
          source: 'notion',
          sourceConnectionId: 'notion-main',
          sourceApiKeyRef: 'env:NOTION_TOKEN', // pragma: allowlist secret
          notionCrawlMode: 'selected_roots',
          notionRootPageIds: ['page-1'],
          runInitialSourceIngest: false,
          skipSources: false,
        },
        io.io,
        {},
      ),
    ).resolves.toEqual({ status: 'failed', projectDir });

    expect(io.stderr()).toContain('--source-api-key-ref does not apply to --source notion; use --source-auth-token-ref.');
    expect((await readConfig()).connections['notion-main']).toBeUndefined();
  });

  it('rejects --source-auth-token-ref for Metabase and points at --source-api-key-ref', async () => {
    await addPrimarySource();
    const io = makeIo();

    await expect(
      runKtxSetupSourcesStep(
        {
          projectDir,
          inputMode: 'disabled',
          source: 'metabase',
          sourceConnectionId: 'prod_metabase',
          sourceUrl: 'https://metabase.example.com',
          sourceAuthTokenRef: 'env:METABASE_API_KEY', // pragma: allowlist secret
          sourceWarehouseConnectionId: 'warehouse',
          metabaseDatabaseId: 1,
          runInitialSourceIngest: false,
          skipSources: false,
        },
        io.io,
        {},
      ),
    ).resolves.toEqual({ status: 'failed', projectDir });

    expect(io.stderr()).toContain('--source-auth-token-ref does not apply to --source metabase; use --source-api-key-ref.');
  });

  it('rejects --source-client-secret-ref for dbt and points at --source-auth-token-ref', async () => {
    await addPrimarySource();
    const io = makeIo();

    await expect(
      runKtxSetupSourcesStep(
        {
          projectDir,
          inputMode: 'disabled',
          source: 'dbt',
          sourceConnectionId: 'dbt-main',
          sourceClientSecretRef: 'env:DBT_SECRET', // pragma: allowlist secret
          runInitialSourceIngest: false,
          skipSources: false,
        },
        io.io,
        {},
      ),
    ).resolves.toEqual({ status: 'failed', projectDir });

    expect(io.stderr()).toContain('--source-client-secret-ref does not apply to --source dbt; use --source-auth-token-ref.');
  });

  it('accepts former ingest subcommand names as interactive source connection ids', async () => {
    await addPrimarySource();
    const io = makeIo();
    const validateNotion = vi.fn(async () => ({ ok: true as const, detail: 'workspace=ok' }));

    const result = await runKtxSetupSourcesStep(
      {
        projectDir,
        inputMode: 'auto',
        runInitialSourceIngest: false,
        skipSources: false,
      },
      io.io,
      {
        prompts: prompts({
          multiselect: [['notion']],
          text: ['status', 'env:NOTION_TOKEN'],
          select: ['env', 'all_accessible'],
        }),
        validateNotion,
      },
    );

    expect(result.status).toBe('ready');
    const config = await readConfig();
    expect(config.connections.status).toMatchObject({
      driver: 'notion',
      auth_token_ref: 'env:NOTION_TOKEN',
    });
  });

  it('uses selected Notion roots when root page ids are provided even if crawl mode says all accessible', async () => {
    await addPrimarySource();
    const validateNotion = vi.fn(async () => ({ ok: true as const, detail: 'roots=1' }));

    await expect(
      runKtxSetupSourcesStep(
        {
          projectDir,
          inputMode: 'disabled',
          source: 'notion',
          sourceConnectionId: 'notion-main',
          sourceAuthTokenRef: 'env:NOTION_TOKEN', // pragma: allowlist secret
          notionCrawlMode: 'all_accessible',
          notionRootPageIds: ['page-1'],
          runInitialSourceIngest: false,
          skipSources: false,
        },
        makeIo().io,
        { validateNotion },
      ),
    ).resolves.toEqual({ status: 'ready', projectDir, connectionIds: ['notion-main'] });

    expect((await readConfig()).connections['notion-main']).toMatchObject({
      driver: 'notion',
      root_page_ids: ['page-1'],
      crawl_mode: 'selected_roots',
    });
  });

  it('uses the rich Notion picker for interactive selected root setup', async () => {
    await addPrimarySource();
    const validateNotion = vi.fn(async () => ({ ok: true as const, detail: 'roots=1' }));
    const pickNotionRootPages = vi.fn(async (input: Parameters<NonNullable<KtxSetupSourcesDeps['pickNotionRootPages']>>[0]) => {
      expect(input.connectionId).toBe('notion-main');
      expect(input.connection).toMatchObject({
        driver: 'notion',
        auth_token_ref: 'env:NOTION_TOKEN',
        crawl_mode: 'selected_roots',
        root_page_ids: [],
      });
      return { kind: 'selected' as const, rootPageIds: ['11111111-2222-3333-4444-555555555555'] };
    });
    const testPrompts = prompts({
      multiselect: [['notion']],
      select: ['env', 'selected_roots', 'done'],
      text: ['notion-main'],
    });

    await expect(
      runKtxSetupSourcesStep(
        { projectDir, inputMode: 'auto', runInitialSourceIngest: false, skipSources: false },
        makeIo().io,
        { prompts: testPrompts, validateNotion, pickNotionRootPages },
      ),
    ).resolves.toEqual({ status: 'ready', projectDir, connectionIds: ['notion-main'] });

    expect(pickNotionRootPages).toHaveBeenCalledOnce();
    expect(testPrompts.select).toHaveBeenCalledWith({
      message: 'Which Notion pages should ktx ingest?',
      options: [
        { value: 'all_accessible', label: 'All pages the integration can access' },
        { value: 'selected_roots', label: 'Specific pages and their subpages (choose them in a picker)' },
        { value: 'back', label: 'Back' },
      ],
    });
    expect((await readConfig()).connections['notion-main']).toMatchObject({
      driver: 'notion',
      auth_token_ref: 'env:NOTION_TOKEN',
      crawl_mode: 'selected_roots',
      root_page_ids: ['11111111-2222-3333-4444-555555555555'],
    });
  });

  it('backs out of the Notion picker without writing selected_roots when the picker quits', async () => {
    await addPrimarySource();
    const validateNotion = vi.fn(async () => ({ ok: true as const, detail: 'roots=0' }));
    const pickNotionRootPages = vi.fn(async () => ({ kind: 'back' as const }));
    const testPrompts = prompts({
      multiselect: [['notion']],
      select: ['env', 'selected_roots', 'all_accessible', 'done'],
      text: ['notion-main'],
    });

    await expect(
      runKtxSetupSourcesStep(
        { projectDir, inputMode: 'auto', runInitialSourceIngest: false, skipSources: false },
        makeIo().io,
        { prompts: testPrompts, validateNotion, pickNotionRootPages },
      ),
    ).resolves.toEqual({ status: 'ready', projectDir, connectionIds: ['notion-main'] });

    expect(pickNotionRootPages).toHaveBeenCalledOnce();
    expect((await readConfig()).connections['notion-main']).toMatchObject({
      driver: 'notion',
      crawl_mode: 'all_accessible',
    });
    expect((await readConfig()).connections['notion-main']?.root_page_ids).toBeUndefined();
  });

  it('surfaces Notion picker failures and returns to the page-mode step', async () => {
    await addPrimarySource();
    const validateNotion = vi.fn(async () => ({ ok: true as const, detail: 'roots=0' }));
    const pickNotionRootPages = vi.fn(async () => ({
      kind: 'unavailable' as const,
      message: 'Notion picker requires a TTY',
    }));
    const testPrompts = prompts({
      multiselect: [['notion']],
      select: ['env', 'selected_roots', 'all_accessible', 'done'],
      text: ['notion-main'],
    });
    const io = makeIo();

    await expect(
      runKtxSetupSourcesStep(
        { projectDir, inputMode: 'auto', runInitialSourceIngest: false, skipSources: false },
        io.io,
        { prompts: testPrompts, validateNotion, pickNotionRootPages },
      ),
    ).resolves.toEqual({ status: 'ready', projectDir, connectionIds: ['notion-main'] });

    expect(io.stderr()).toContain('Notion picker requires a TTY');
    expect((await readConfig()).connections['notion-main']).toMatchObject({
      driver: 'notion',
      crawl_mode: 'all_accessible',
    });
  });

  it('defaults interactive Metabase and Looker source setup to the only warehouse connection', async () => {
    await addPrimarySource();
    const cases: Array<{
      source: 'metabase' | 'looker';
      text: string[];
      deps: KtxSetupSourcesDeps;
      expectedConnection: Record<string, unknown>;
    }> = [
      {
        source: 'metabase',
        text: ['metabase-main', 'https://metabase.example.com'],
        deps: {
          discoverMetabaseDatabases: vi.fn(async () => [
            { id: 1, name: 'Analytics', engine: 'postgres', host: 'db.example.com', dbName: 'analytics' },
          ]),
          validateMetabase: vi.fn(async () => ({ ok: true as const, detail: 'mapping validated' })),
          runMapping: vi.fn(async () => 0),
        },
        expectedConnection: {
          driver: 'metabase',
          mappings: { databaseMappings: { '1': 'warehouse' } },
        },
      },
      {
        source: 'looker',
        text: ['looker-main', 'https://looker.example.com', 'client-id', ''],
        deps: {
          validateLooker: vi.fn(async () => ({ ok: true as const, detail: 'mapping refreshed' })),
          runMapping: vi.fn(async () => 0),
        },
        expectedConnection: {
          driver: 'looker',
          mappings: { connectionMappings: { warehouse: 'warehouse' } },
        },
      },
    ];

    for (const testCase of cases) {
      const testPrompts = prompts({
        multiselect: [[testCase.source]],
        select: ['env', 'done'],
        text: testCase.text,
      });

      await expect(
        runKtxSetupSourcesStep(
          { projectDir, inputMode: 'auto', runInitialSourceIngest: false, skipSources: false },
          makeIo().io,
          {
            prompts: testPrompts,
            ...testCase.deps,
          },
        ),
      ).resolves.toEqual({ status: 'ready', projectDir, connectionIds: [`${testCase.source}-main`] });

      expect(
        vi.mocked(testPrompts.text).mock.calls.some(([options]) => options.message.includes('Mapped warehouse')),
      ).toBe(false);
      if (testCase.source === 'metabase') {
        expect(
          vi.mocked(testPrompts.text).mock.calls.some(([options]) => options.message.includes('Metabase database id')),
        ).toBe(false);
      }
      expect((await readConfig()).connections[`${testCase.source}-main`]).toMatchObject(testCase.expectedConnection);
    }
  });

  it('prompts for the mapped warehouse when interactive Metabase and Looker source setup has multiple choices', async () => {
    await addPrimarySource();
    await addConnection('analytics_warehouse', {
      driver: 'snowflake',
      account: 'acme',
      database: 'analytics',
    });

    const cases: Array<{
      source: 'metabase' | 'looker';
      text: string[];
      deps: KtxSetupSourcesDeps;
      expectedConnection: Record<string, unknown>;
    }> = [
      {
        source: 'metabase',
        text: ['metabase-main', 'https://metabase.example.com'],
        deps: {
          discoverMetabaseDatabases: vi.fn(async () => [
            { id: 1, name: 'Finance', engine: 'postgres', host: 'db.example.com', dbName: 'finance' },
            { id: 2, name: 'Analytics', engine: 'postgres', host: 'db.example.com', dbName: 'analytics' },
          ]),
          validateMetabase: vi.fn(async () => ({ ok: true as const, detail: 'mapping validated' })),
          runMapping: vi.fn(async () => 0),
        },
        expectedConnection: {
          driver: 'metabase',
          mappings: { databaseMappings: { '2': 'analytics_warehouse' } },
        },
      },
      {
        source: 'looker',
        text: ['looker-main', 'https://looker.example.com', 'client-id', 'analytics'],
        deps: {
          validateLooker: vi.fn(async () => ({ ok: true as const, detail: 'mapping refreshed' })),
          runMapping: vi.fn(async () => 0),
        },
        expectedConnection: {
          driver: 'looker',
          mappings: { connectionMappings: { analytics: 'analytics_warehouse' } },
        },
      },
    ];

    for (const testCase of cases) {
      const testPrompts = prompts({
        multiselect: [[testCase.source]],
        select: testCase.source === 'metabase' ? ['env', 'analytics_warehouse', '2', 'done'] : ['env', 'analytics_warehouse', 'done'],
        text: testCase.text,
      });

      await expect(
        runKtxSetupSourcesStep(
          { projectDir, inputMode: 'auto', runInitialSourceIngest: false, skipSources: false },
          makeIo().io,
          {
            prompts: testPrompts,
            ...testCase.deps,
          },
        ),
      ).resolves.toEqual({ status: 'ready', projectDir, connectionIds: [`${testCase.source}-main`] });

      expect(testPrompts.select).toHaveBeenCalledWith({
        message: 'Mapped warehouse connection',
        options: [
          { value: 'analytics_warehouse', label: 'analytics_warehouse (SNOWFLAKE)' },
          { value: 'warehouse', label: 'warehouse (POSTGRESQL)' },
          { value: 'back', label: 'Back' },
        ],
      });
      if (testCase.source === 'metabase') {
        expect(testPrompts.autocomplete).toHaveBeenCalledWith({
          message: 'Metabase database',
          placeholder: 'Type to search databases',
          options: [
            { value: '1', label: '1: Finance (postgres)' },
            { value: '2', label: '2: Analytics (postgres)' },
            { value: 'back', label: 'Back' },
          ],
        });
        expect(
          vi.mocked(testPrompts.text).mock.calls.some(([options]) => options.message.includes('Metabase database id')),
        ).toBe(false);
      }
      expect((await readConfig()).connections[`${testCase.source}-main`]).toMatchObject(testCase.expectedConnection);
    }
  });

  it('lets visible Metabase mapping surface refresh and validation failures', async () => {
    await addPrimarySource();
    const runMapping = vi.fn(async (_projectDir: string, _connectionId: string, io: KtxCliIo) => {
      io.stderr.write('1: Metabase database does not match ktx connection database\n');
      return 1;
    });
    const io = makeIo();
    const testPrompts = prompts({
      multiselect: [['metabase']],
      select: ['env'],
      text: ['metabase-main', 'https://metabase.example.com'],
    });

    const result = await runKtxSetupSourcesStep(
      { projectDir, inputMode: 'auto', runInitialSourceIngest: false, skipSources: false },
      io.io,
      {
        prompts: testPrompts,
        discoverMetabaseDatabases: vi.fn(async () => [
          { id: 1, name: 'Analytics', engine: 'postgres', host: 'db.example.com', dbName: 'analytics' },
        ]),
        runMapping,
      },
    );
    expect(result.status).not.toBe('failed');

    expect(runMapping).toHaveBeenCalledWith(
      projectDir,
      'metabase-main',
      expect.objectContaining({
        stdout: expect.objectContaining({ write: expect.any(Function) }),
        stderr: expect.objectContaining({ write: expect.any(Function) }),
      }),
    );
    expect(io.stderr()).toContain('1: Metabase database does not match ktx connection database');
    expect(io.stderr()).not.toContain('Metabase mapping validation failed');
    expect(testPrompts.log).toHaveBeenCalledWith('Validating Metabase mapping...');
    expect(testPrompts.select).toHaveBeenCalledWith(
      expect.objectContaining({
        message: 'Connection setup failed for metabase-main',
        options: expect.arrayContaining([
          { value: 'retry', label: 'Retry connection test' },
          { value: 're-enter', label: 'Re-enter connection details' },
          { value: 'skip', label: 'Skip this connection' },
          { value: 'back', label: 'Back' },
        ]),
      }),
    );
  });

  it('does not mark sources complete when validation fails', async () => {
    await addPrimarySource();
    const io = makeIo();
    await expect(
      runKtxSetupSourcesStep(
        {
          projectDir,
          inputMode: 'disabled',
          source: 'lookml',
          sourceConnectionId: 'looker_repo',
          sourceGitUrl: 'https://github.com/acme/lookml.git',
          runInitialSourceIngest: false,
          skipSources: false,
        },
        io.io,
        { validateLookml: vi.fn(async () => ({ ok: false as const, message: 'No LookML files found' })) },
      ),
    ).resolves.toEqual({ status: 'failed', projectDir });

    expect((await readKtxSetupState(projectDir)).completed_steps).not.toContain('sources');
    expect(io.stderr()).toContain('No LookML files found');
  });

  it('can go back from the interactive source checklist', async () => {
    await addPrimarySource();
    const io = makeIo();
    const testPrompts = prompts({ multiselect: [['back']] });

    await expect(
      runKtxSetupSourcesStep(
        { projectDir, inputMode: 'auto', runInitialSourceIngest: false, skipSources: false },
        io.io,
        {
          prompts: testPrompts,
        },
      ),
    ).resolves.toEqual({ status: 'back', projectDir });

    expect(testPrompts.multiselect).toHaveBeenCalledWith(
      expect.objectContaining({
        message:
          'Which context sources should ktx ingest?\nUp/Down to move, Tab to select or unselect, Enter to confirm, Escape to go back, Ctrl+C to exit.',
      }),
    );
    const options = vi.mocked(testPrompts.multiselect).mock.calls[0]?.[0].options ?? [];
    expect(options).toContainEqual({ value: 'notion', label: 'Notion' });
    expect(options).toContainEqual({ value: 'gdrive', label: 'Google Drive' });
  });

  it('shows already configured context sources in the interactive checklist', async () => {
    await addPrimarySource();
    await addConnection('notion-main', {
      driver: 'notion',
      auth_token_ref: 'env:NOTION_TOKEN',
      crawl_mode: 'all_accessible',
    });
    const io = makeIo();
    const testPrompts = prompts({ multiselect: [['back']] });

    await expect(
      runKtxSetupSourcesStep(
        { projectDir, inputMode: 'auto', runInitialSourceIngest: false, skipSources: false },
        io.io,
        { prompts: testPrompts },
      ),
    ).resolves.toEqual({ status: 'back', projectDir });

    expect(testPrompts.multiselect).toHaveBeenCalledWith(
      expect.objectContaining({
        initialValues: ['notion'],
        options: expect.arrayContaining([{ value: 'notion', label: 'Notion', hint: 'configured: notion-main' }]),
      }),
    );
  });

  it('uses a source-specific editable connection name for new interactive connections', async () => {
    await addPrimarySource();
    const validateDbt = vi.fn(async () => ({ ok: true as const, detail: 'project=analytics schemas=2' }));
    const io = makeIo();
    const testPrompts = prompts({
      multiselect: [['dbt']],
      select: ['path'],
      text: ['dbt-main', '/repo/dbt', '', ''],
    });

    await expect(
      runKtxSetupSourcesStep(
        { projectDir, inputMode: 'auto', runInitialSourceIngest: false, skipSources: false },
        io.io,
        {
          prompts: testPrompts,
          validateDbt,
        },
      ),
    ).resolves.toEqual({ status: 'ready', projectDir, connectionIds: ['dbt-main'] });

    expect(testPrompts.text).toHaveBeenNthCalledWith(1, {
      message: textInputPrompt(connectionNamePrompt('dbt')),
      placeholder: 'dbt-main',
      initialValue: 'dbt-main',
    });
    expect((await readConfig()).connections['dbt-main']).toMatchObject({
      driver: 'dbt',
      source_dir: '/repo/dbt',
    });
  });

  it('skips token prompt for public repos when git connection test succeeds', async () => {
    await addPrimarySource();
    const validateDbt = vi.fn(async () => ({ ok: true as const, detail: 'project=analytics schemas=2' }));
    const testGitRepo = vi.fn(async () => ({ ok: true as const }));
    const io = makeIo();
    const testPrompts = prompts({
      multiselect: [['dbt']],
      select: ['git'],
      text: ['dbt-main', 'https://github.com/acme-org/ktx-dbt-demo', 'main', ''],
    });

    await expect(
      runKtxSetupSourcesStep(
        { projectDir, inputMode: 'auto', runInitialSourceIngest: false, skipSources: false },
        io.io,
        {
          prompts: testPrompts,
          validateDbt,
          testGitRepo,
        },
      ),
    ).resolves.toEqual({ status: 'ready', projectDir, connectionIds: ['dbt-main'] });

    expect(testGitRepo).toHaveBeenCalledWith({ repoUrl: 'https://github.com/acme-org/ktx-dbt-demo' });
    expect(testPrompts.log).toHaveBeenCalledWith('Repository connected.');
    expect(testPrompts.text).toHaveBeenNthCalledWith(4, {
      message: textInputPrompt(
        [
          'Folder containing dbt_project.yml (optional)',
          'Press Enter when dbt_project.yml is at the repo root.',
          'For monorepos, enter a relative path like analytics/dbt.',
        ].join('\n'),
      ),
      placeholder: 'optional',
    });
    expect(testPrompts.text).toHaveBeenCalledTimes(4);
  });

  it('prompts for token when git connection test fails', async () => {
    await addPrimarySource();
    const validateDbt = vi.fn(async () => ({ ok: true as const, detail: 'project=analytics schemas=2' }));
    const testGitRepo = vi.fn(async () => ({ ok: false as const, error: 'authentication required' }));
    const io = makeIo();
    const testPrompts = prompts({
      multiselect: [['dbt']],
      select: ['git', 'env'],
      text: ['dbt-main', 'https://github.com/acme-org/private-repo', 'main', ''],
    });

    await expect(
      runKtxSetupSourcesStep(
        { projectDir, inputMode: 'auto', runInitialSourceIngest: false, skipSources: false },
        io.io,
        {
          prompts: testPrompts,
          validateDbt,
          testGitRepo,
        },
      ),
    ).resolves.toEqual({ status: 'ready', projectDir, connectionIds: ['dbt-main'] });

    expect(testGitRepo).toHaveBeenCalledWith({ repoUrl: 'https://github.com/acme-org/private-repo' });
    expect(testPrompts.select).toHaveBeenCalledWith({
      message: 'This repo requires authentication.',
      options: [
        { value: 'paste', label: 'Paste a token and save it as a local secret file' },
        { value: 'env', label: 'Use GITHUB_TOKEN from the environment' },
        { value: 'skip', label: 'Skip — try without authentication' },
        { value: 'back', label: 'Back' },
      ],
    });
    expect(testPrompts.text).toHaveBeenCalledTimes(4);
  });

  it('re-prompts when a pasted token fails authentication and accepts the second token', async () => {
    await addPrimarySource();
    const validateDbt = vi.fn(async () => ({ ok: true as const, detail: 'project=analytics schemas=2' }));
    const testGitRepo = vi
      .fn<(args: { repoUrl: string; authToken?: string | null }) => Promise<{ ok: true } | { ok: false; error: string }>>()
      .mockResolvedValueOnce({ ok: false, error: 'authentication required' })
      .mockResolvedValueOnce({ ok: false, error: 'Invalid username or token.' })
      .mockResolvedValue({ ok: true });
    const io = makeIo();
    const testPrompts = prompts({
      multiselect: [['dbt']],
      select: ['git', 'paste', 'paste'],
      text: ['dbt-main', 'https://github.com/acme-org/private-repo', 'main', ''],
      password: ['bad-token', 'good-token'],
    });

    await expect(
      runKtxSetupSourcesStep(
        { projectDir, inputMode: 'auto', runInitialSourceIngest: false, skipSources: false },
        io.io,
        {
          prompts: testPrompts,
          validateDbt,
          testGitRepo,
        },
      ),
    ).resolves.toEqual({ status: 'ready', projectDir, connectionIds: ['dbt-main'] });

    expect(testGitRepo).toHaveBeenNthCalledWith(1, { repoUrl: 'https://github.com/acme-org/private-repo' });
    expect(testGitRepo).toHaveBeenNthCalledWith(2, {
      repoUrl: 'https://github.com/acme-org/private-repo',
      authToken: 'bad-token',
    });
    expect(testGitRepo).toHaveBeenNthCalledWith(3, {
      repoUrl: 'https://github.com/acme-org/private-repo',
      authToken: 'good-token',
    });
    expect(testPrompts.password).toHaveBeenCalledTimes(2);
    expect(testPrompts.log).toHaveBeenCalledWith('Authentication failed: Invalid username or token.');
    expect(testPrompts.log).toHaveBeenCalledWith('Saved to .ktx/secrets/dbt-main-auth-token');
    expect((await readConfig()).connections['dbt-main']).toMatchObject({
      driver: 'dbt',
      repo_url: 'https://github.com/acme-org/private-repo',
      auth_token_ref: expect.stringMatching(/^file:.*\.ktx\/secrets\/dbt-main-auth-token$/),
    });
  });

  it('does not exit interactive setup when validation fails for an existing connection', async () => {
    await addPrimarySource();
    await addConnection('dbt-main', {
      driver: 'dbt',
      repo_url: 'https://github.com/acme/private-repo',
      auth_token_ref: 'env:GITHUB_TOKEN',
    });
    const validateDbt = vi.fn(async () => ({
      ok: false as const,
      message: 'Failed to clone https://github.com/acme/private-repo: Authentication failed',
    }));
    const testPrompts = prompts({
      multiselect: [['dbt']],
      select: ['existing:dbt-main'],
    });
    const io = makeIo();

    const result = await runKtxSetupSourcesStep(
      { projectDir, inputMode: 'auto', runInitialSourceIngest: false, skipSources: false },
      io.io,
      { prompts: testPrompts, validateDbt },
    );

    expect(result.status).not.toBe('failed');
    expect(io.stderr()).toContain('Failed to clone https://github.com/acme/private-repo: Authentication failed');
    expect(testPrompts.select).toHaveBeenCalledWith(
      expect.objectContaining({
        message: 'Connection setup failed for dbt-main',
        options: expect.arrayContaining([
          { value: 'retry', label: 'Retry connection test' },
          { value: 're-enter', label: 'Re-enter connection details' },
          { value: 'skip', label: 'Skip this connection' },
          { value: 'back', label: 'Back' },
        ]),
      }),
    );
  });

  it('recovers from an existing context-source validation failure by re-entering details', async () => {
    await addPrimarySource();
    await addConnection('dbt-main', {
      driver: 'dbt',
      source_dir: '/repo/bad-dbt',
      project_name: 'analytics',
    });
    let attempts = 0;
    const validateDbt = vi.fn(async () => {
      attempts += 1;
      return attempts === 1
        ? { ok: false as const, message: 'dbt project not found' }
        : { ok: true as const, detail: 'project=analytics' };
    });
    const testPrompts = prompts({
      multiselect: [['dbt']],
      select: ['existing:dbt-main', 're-enter', 'path', 'done'],
      text: ['/repo/fixed-dbt', ''],
    });
    const io = makeIo();

    const result = await runKtxSetupSourcesStep(
      { projectDir, inputMode: 'auto', runInitialSourceIngest: false, skipSources: false },
      io.io,
      { prompts: testPrompts, validateDbt },
    );

    expect(result.status).toBe('ready');
    expect(validateDbt).toHaveBeenCalledTimes(2);
    expect(vi.mocked(testPrompts.select)).toHaveBeenCalledWith(
      expect.objectContaining({
        message: 'Connection setup failed for dbt-main',
        options: expect.arrayContaining([
          { value: 'retry', label: 'Retry connection test' },
          { value: 're-enter', label: 'Re-enter connection details' },
          { value: 'skip', label: 'Skip this connection' },
          { value: 'back', label: 'Back' },
        ]),
      }),
    );
    expect((await readConfig()).connections['dbt-main']).toMatchObject({
      driver: 'dbt',
      source_dir: '/repo/fixed-dbt',
    });
  });

  it('restores a context-source edit and adapter enablement when recovery goes back', async () => {
    await addPrimarySource();
    await addConnection('dbt-main', {
      driver: 'dbt',
      source_dir: '/repo/existing-dbt',
      project_name: 'analytics',
    });
    const testPrompts = prompts({
      multiselect: [['dbt']],
      select: ['edit:dbt-main', 'path', 'back'],
      text: ['/repo/bad-dbt', ''],
    });
    const io = makeIo();

    const result = await runKtxSetupSourcesStep(
      { projectDir, inputMode: 'auto', runInitialSourceIngest: false, skipSources: false },
      io.io,
      {
        prompts: testPrompts,
        validateDbt: vi.fn(async () => ({ ok: false as const, message: 'dbt project not found' })),
      },
    );

    expect(result.status).toBe('skipped');
    const config = await readConfig();
    expect(config.connections['dbt-main']).toMatchObject({
      driver: 'dbt',
      source_dir: '/repo/existing-dbt',
      project_name: 'analytics',
    });
    expect(config.ingest.adapters).not.toContain('dbt');
  });

  it('lets Metabase mapping failure retry through source recovery', async () => {
    await addPrimarySource();
    let mappingAttempts = 0;
    const runMapping = vi.fn(async () => {
      mappingAttempts += 1;
      return mappingAttempts === 1 ? 1 : 0;
    });
    const testPrompts = prompts({
      multiselect: [['metabase']],
      select: ['env', 'retry', 'done'],
      text: ['metabase-main', 'https://metabase.example.com'],
    });
    const io = makeIo();

    const result = await runKtxSetupSourcesStep(
      { projectDir, inputMode: 'auto', runInitialSourceIngest: false, skipSources: false },
      io.io,
      {
        prompts: testPrompts,
        discoverMetabaseDatabases: vi.fn(async () => [
          { id: 1, name: 'Analytics', engine: 'postgres', host: 'db.example.com', dbName: 'analytics' },
        ]),
        runMapping,
      },
    );

    expect(result.status).toBe('ready');
    expect(runMapping).toHaveBeenCalledTimes(2);
  });

  it('keeps noninteractive source setup fail-fast without rolling back attempted config', async () => {
    await addPrimarySource();
    const io = makeIo();

    const result = await runKtxSetupSourcesStep(
      {
        projectDir,
        inputMode: 'disabled',
        source: 'lookml',
        sourceConnectionId: 'looker-repo',
        sourceGitUrl: 'https://github.com/acme/lookml.git',
        runInitialSourceIngest: false,
        skipSources: false,
      },
      io.io,
      {
        validateLookml: vi.fn(async () => ({ ok: false as const, message: 'No LookML files found' })),
      },
    );

    expect(result.status).toBe('failed');
    expect((await readConfig()).connections['looker-repo']).toMatchObject({
      driver: 'lookml',
      repoUrl: 'https://github.com/acme/lookml.git',
    });
  });

  it('adds a dbt source connection and enables its adapter', async () => {
    await addPrimarySource();
    const validateDbt = vi.fn(async () => ({ ok: true as const, detail: 'project=analytics schemas=2' }));

    await expect(
      runKtxSetupSourcesStep(
        {
          projectDir,
          inputMode: 'disabled',
          source: 'dbt',
          sourceConnectionId: 'dbt-main',
          sourcePath: '/repo/dbt',
          runInitialSourceIngest: false,
          skipSources: false,
        },
        makeIo().io,
        { validateDbt },
      ),
    ).resolves.toEqual({ status: 'ready', projectDir, connectionIds: ['dbt-main'] });

    const configText = await readFile(join(projectDir, 'ktx.yaml'), 'utf-8');
    expect(configText).not.toContain('live-database');
    expect(configText).not.toContain('historic-sql');
    expect((await readConfig()).ingest.adapters).toEqual(['dbt']);
  });

  it('lets interactive setup retry or continue after initial source ingest fails', async () => {
    await addPrimarySource();
    const validateDbt = vi.fn(async () => ({ ok: true as const, detail: 'project=analytics schemas=2' }));
    const runInitialIngest = vi.fn(async () => 1);
    const io = makeIo();
    const testPrompts = prompts({
      multiselect: [['dbt']],
      select: ['path', 'continue', 'done'],
      text: ['dbt-main', '/repo/dbt', '', ''],
    });

    await expect(
      runKtxSetupSourcesStep(
        { projectDir, inputMode: 'auto', runInitialSourceIngest: true, skipSources: false },
        io.io,
        {
          prompts: testPrompts,
          validateDbt,
          runInitialIngest,
        },
      ),
    ).resolves.toEqual({ status: 'ready', projectDir, connectionIds: ['dbt-main'] });

    expect(runInitialIngest).toHaveBeenCalledTimes(1);
    expect((await readConfig()).connections['dbt-main']).toMatchObject({ driver: 'dbt', source_dir: '/repo/dbt' });
    expect(io.stdout()).toContain('Context source saved without a completed context build for dbt-main.');
    expect(io.stdout()).toContain('Run later: ktx ingest dbt-main');
    expect(io.stdout()).not.toContain('ktx ingest run --connection-id');
    expect(io.stdout()).not.toContain('--adapter');
  });

  it('retries initial source ingest from the failure menu', async () => {
    await addPrimarySource();
    const validateDbt = vi.fn(async () => ({ ok: true as const, detail: 'project=analytics schemas=2' }));
    const runInitialIngest = vi.fn(async () => (runInitialIngest.mock.calls.length === 1 ? 1 : 0));
    const testPrompts = prompts({
      multiselect: [['dbt']],
      select: ['path', 'retry'],
      text: ['dbt-main', '/repo/dbt', '', ''],
    });

    await expect(
      runKtxSetupSourcesStep(
        { projectDir, inputMode: 'auto', runInitialSourceIngest: true, skipSources: false },
        makeIo().io,
        {
          prompts: testPrompts,
          validateDbt,
          runInitialIngest,
        },
      ),
    ).resolves.toEqual({ status: 'ready', projectDir, connectionIds: ['dbt-main'] });

    expect(runInitialIngest).toHaveBeenCalledTimes(2);
  });

  it('offers existing context source connections before prompting for new details', async () => {
    await addPrimarySource();
    await addConnection('dbt-main', {
      driver: 'dbt',
      source_dir: '/repo/existing-dbt',
      project_name: 'analytics',
    });
    const validateDbt = vi.fn(async () => ({ ok: true as const, detail: 'project=analytics schemas=2' }));
    const testPrompts = prompts({
      multiselect: [['dbt']],
      select: ['existing:dbt-main'],
      text: [undefined],
    });

    await expect(
      runKtxSetupSourcesStep(
        { projectDir, inputMode: 'auto', runInitialSourceIngest: false, skipSources: false },
        makeIo().io,
        {
          prompts: testPrompts,
          validateDbt,
        },
      ),
    ).resolves.toEqual({ status: 'ready', projectDir, connectionIds: ['dbt-main'] });

    expect(testPrompts.select).toHaveBeenCalledWith({
      message: 'Configure dbt',
      options: [
        { value: 'existing:dbt-main', label: 'Use existing dbt connection: dbt-main' },
        { value: 'edit:dbt-main', label: 'Edit existing dbt connection: dbt-main' },
        { value: 'new', label: 'Add new dbt connection' },
        { value: 'back', label: 'Back' },
      ],
    });
    expect(testPrompts.text).not.toHaveBeenCalled();
    expect(validateDbt).toHaveBeenCalledWith({
      driver: 'dbt',
      source_dir: '/repo/existing-dbt',
      project_name: 'analytics',
    });
    expect((await readConfig()).connections['dbt-main']).toMatchObject({
      driver: 'dbt',
      source_dir: '/repo/existing-dbt',
    });
  });

  it('offers existing connections for every context source type', async () => {
    await addPrimarySource();
    const cases: Array<{
      source: KtxSetupSourceType;
      connectionId: string;
      connection: KtxProjectConnectionConfig;
      deps: KtxSetupSourcesDeps;
      expectedLabel: string;
    }> = [
      {
        source: 'dbt',
        connectionId: 'dbt-main',
        connection: { driver: 'dbt', source_dir: '/repo/dbt', project_name: 'analytics' },
        deps: { validateDbt: vi.fn(async () => ({ ok: true as const, detail: 'project=analytics schemas=2' })) },
        expectedLabel: 'dbt',
      },
      {
        source: 'metricflow',
        connectionId: 'metricflow-main',
        connection: { driver: 'metricflow', metricflow: { repoUrl: 'file:///repo/metricflow' } },
        deps: { validateMetricflow: vi.fn(async () => ({ ok: true as const, detail: 'metrics=1' })) },
        expectedLabel: 'MetricFlow',
      },
      {
        source: 'metabase',
        connectionId: 'metabase-main',
        connection: {
          driver: 'metabase',
          api_url: 'https://metabase.example.com',
          api_key_ref: 'env:METABASE_API_KEY', // pragma: allowlist secret
          mappings: {
            databaseMappings: { '1': 'warehouse' },
            syncEnabled: { '1': true },
            syncMode: 'ALL',
            selections: { collections: [], items: [] },
            defaultTagNames: [],
          },
        },
        deps: {
          validateMetabase: vi.fn(async () => ({ ok: true as const, detail: 'mapping validated' })),
          runMapping: vi.fn(async () => 0),
        },
        expectedLabel: 'Metabase',
      },
      {
        source: 'looker',
        connectionId: 'looker-main',
        connection: {
          driver: 'looker',
          base_url: 'https://looker.example.com',
          client_id: 'client-id',
          client_secret_ref: 'env:LOOKER_CLIENT_SECRET', // pragma: allowlist secret
          mappings: { connectionMappings: { warehouse: 'warehouse' } },
        },
        deps: {
          validateLooker: vi.fn(async () => ({ ok: true as const, detail: 'mapping refreshed' })),
          runMapping: vi.fn(async () => 0),
        },
        expectedLabel: 'Looker',
      },
      {
        source: 'lookml',
        connectionId: 'lookml-main',
        connection: {
          driver: 'lookml',
          repoUrl: 'file:///repo/lookml',
          mappings: { expectedLookerConnectionName: null },
        },
        deps: { validateLookml: vi.fn(async () => ({ ok: true as const, detail: 'lookmlFiles=1' })) },
        expectedLabel: 'LookML',
      },
      {
        source: 'notion',
        connectionId: 'notion-main',
        connection: {
          driver: 'notion',
          auth_token_ref: 'env:NOTION_TOKEN',
          crawl_mode: 'all_accessible',
          root_page_ids: [],
          root_database_ids: [],
          root_data_source_ids: [],
        },
        deps: { validateNotion: vi.fn(async () => ({ ok: true as const, detail: 'roots=0' })) },
        expectedLabel: 'Notion',
      },
      {
        source: 'sigma',
        connectionId: 'sigma-main',
        connection: {
          driver: 'sigma',
          api_url: 'https://api.sigmacomputing.com',
          client_id: 'my-client-id',
          client_secret_ref: 'env:SIGMA_CLIENT_SECRET', // pragma: allowlist secret
        },
        deps: { validateSigma: vi.fn(async () => ({ ok: true as const, detail: 'Sigma API connection verified' })) },
        expectedLabel: 'Sigma Computing',
      },
    ];

    for (const testCase of cases) {
      await addConnection(testCase.connectionId, testCase.connection);
      const testPrompts = prompts({
        multiselect: [[testCase.source]],
        select: [`existing:${testCase.connectionId}`],
        text: [undefined],
      });

      await expect(
        runKtxSetupSourcesStep(
          { projectDir, inputMode: 'auto', runInitialSourceIngest: false, skipSources: false },
          makeIo().io,
          {
            prompts: testPrompts,
            ...testCase.deps,
          },
        ),
      ).resolves.toEqual({ status: 'ready', projectDir, connectionIds: [testCase.connectionId] });

      expect(testPrompts.select).toHaveBeenCalledWith({
        message: `Configure ${testCase.expectedLabel}`,
        options: [
          {
            value: `existing:${testCase.connectionId}`,
            label: `Use existing ${testCase.expectedLabel} connection: ${testCase.connectionId}`,
          },
          {
            value: `edit:${testCase.connectionId}`,
            label: `Edit existing ${testCase.expectedLabel} connection: ${testCase.connectionId}`,
          },
          { value: 'new', label: `Add new ${testCase.expectedLabel} connection` },
          { value: 'back', label: 'Back' },
        ],
      });
      expect(testPrompts.text).not.toHaveBeenCalled();
    }
  });

  it('edits an existing Notion source and reopens the page picker with stored pages selected', async () => {
    await addPrimarySource();
    await addConnection('notion-main', {
      driver: 'notion',
      auth_token_ref: 'env:NOTION_TOKEN',
      crawl_mode: 'selected_roots',
      root_page_ids: ['old-page'],
      root_database_ids: [],
      root_data_source_ids: [],
    });
    const validateNotion = vi.fn(async () => ({ ok: true as const, detail: 'roots=1' }));
    const pickNotionRootPages = vi.fn(async () => ({ kind: 'selected' as const, rootPageIds: ['new-page'] }));
    const testPrompts = prompts({
      multiselect: [['notion']],
      select: ['edit:notion-main', 'keep', 'selected_roots', 'done'],
    });

    await expect(
      runKtxSetupSourcesStep(
        { projectDir, inputMode: 'auto', runInitialSourceIngest: false, skipSources: false },
        makeIo().io,
        {
          prompts: testPrompts,
          validateNotion,
          pickNotionRootPages,
        },
      ),
    ).resolves.toEqual({ status: 'ready', projectDir, connectionIds: ['notion-main'] });

    expect(testPrompts.select).toHaveBeenCalledWith({
      message: 'How should ktx find your Notion integration token?',
      options: [
        { value: 'keep', label: 'Keep existing credential' },
        { value: 'paste', label: 'Paste a key and save it as a local secret file' },
        { value: 'env', label: 'Use NOTION_TOKEN from the environment' },
        { value: 'back', label: 'Back' },
      ],
    });
    expect(pickNotionRootPages).toHaveBeenCalledWith(
      {
        connectionId: 'notion-main',
        connection: expect.objectContaining({
          driver: 'notion',
          auth_token_ref: 'env:NOTION_TOKEN',
          crawl_mode: 'selected_roots',
          root_page_ids: ['old-page'],
        }),
      },
      expect.anything(),
    );
    expect((await readConfig()).connections['notion-main']).toMatchObject({
      driver: 'notion',
      auth_token_ref: 'env:NOTION_TOKEN',
      crawl_mode: 'selected_roots',
      root_page_ids: ['new-page'],
    });
  });

  it('edits an existing Google Drive source with the current key ref, folder id, and recursion flag', async () => {
    await addPrimarySource();
    await addConnection('gdrive-main', {
      driver: 'gdrive',
      service_account_key_ref: 'file:/tmp/old-key.json', // pragma: allowlist secret
      folder_id: 'old-folder',
      recursive: false,
    });
    const testPrompts = prompts({
      multiselect: [['gdrive']],
      select: ['edit:gdrive-main', 'true', 'done'],
      text: ['file:/tmp/new-key.json', 'new-folder'],
    });

    await expect(
      runKtxSetupSourcesStep(
        { projectDir, inputMode: 'auto', runInitialSourceIngest: false, skipSources: false },
        makeIo().io,
        {
          prompts: testPrompts,
          validateGdrive: vi.fn(async () => ({ ok: true as const, detail: 'docs=3' })),
        },
      ),
    ).resolves.toEqual({ status: 'ready', projectDir, connectionIds: ['gdrive-main'] });

    expect((await readConfig()).connections['gdrive-main']).toMatchObject({
      driver: 'gdrive',
      service_account_key_ref: 'file:/tmp/new-key.json', // pragma: allowlist secret
      folder_id: 'new-folder',
      recursive: true,
    });
  });

  it('edits an existing Metabase source with the current URL and credential as defaults', async () => {
    await addPrimarySource();
    await addConnection('metabase-main', {
      driver: 'metabase',
      api_url: 'https://metabase-old.example.com',
      api_key_ref: 'env:METABASE_API_KEY', // pragma: allowlist secret
      mappings: {
        databaseMappings: { '1': 'warehouse' },
        syncEnabled: { '1': true },
        syncMode: 'ALL',
        selections: { collections: [], items: [] },
        defaultTagNames: [],
      },
    });
    const testPrompts = prompts({
      multiselect: [['metabase']],
      select: ['edit:metabase-main', 'keep', 'done'],
      text: ['https://metabase-new.example.com'],
    });
    const discoverMetabaseDatabases = vi.fn(async () => [
      { id: 2, name: 'Analytics', engine: 'postgres', host: 'db.example.com', dbName: 'analytics' },
    ]);

    await expect(
      runKtxSetupSourcesStep(
        { projectDir, inputMode: 'auto', runInitialSourceIngest: false, skipSources: false },
        makeIo().io,
        {
          prompts: testPrompts,
          discoverMetabaseDatabases,
          validateMetabase: vi.fn(async () => ({ ok: true as const, detail: 'mapping validated' })),
          runMapping: vi.fn(async () => 0),
        },
      ),
    ).resolves.toEqual({ status: 'ready', projectDir, connectionIds: ['metabase-main'] });

    expect(testPrompts.text).toHaveBeenCalledWith({
      message: textInputPrompt('Metabase URL'),
      initialValue: 'https://metabase-old.example.com',
    });
    expect(testPrompts.select).toHaveBeenCalledWith({
      message: 'How should ktx find your Metabase API key?',
      options: [
        { value: 'keep', label: 'Keep existing credential' },
        { value: 'paste', label: 'Paste a key and save it as a local secret file' },
        { value: 'env', label: 'Use METABASE_API_KEY from the environment' },
        { value: 'back', label: 'Back' },
      ],
    });
    expect(discoverMetabaseDatabases).toHaveBeenCalledWith({
      sourceUrl: 'https://metabase-new.example.com',
      sourceApiKeyRef: 'env:METABASE_API_KEY', // pragma: allowlist secret
      sourceConnectionId: 'metabase-main',
    });
    expect((await readConfig()).connections['metabase-main']).toMatchObject({
      driver: 'metabase',
      api_url: 'https://metabase-new.example.com',
      api_key_ref: 'env:METABASE_API_KEY', // pragma: allowlist secret
      mappings: {
        databaseMappings: { '2': 'warehouse' },
        syncEnabled: { '2': true },
        syncMode: 'ALL',
      },
    });
  });

  it('rolls back an edited context source when validation fails', async () => {
    await addPrimarySource();
    await addConnection('dbt-main', {
      driver: 'dbt',
      source_dir: '/repo/existing-dbt',
      project_name: 'analytics',
    });
    const validateDbt = vi.fn(async () => ({ ok: false as const, message: 'dbt project not found' }));
    const testPrompts = prompts({
      multiselect: [['dbt']],
      select: ['edit:dbt-main', 'path'],
      text: ['/repo/new-dbt', ''],
    });
    const io = makeIo();

    const result = await runKtxSetupSourcesStep(
      { projectDir, inputMode: 'auto', runInitialSourceIngest: false, skipSources: false },
      io.io,
      {
        prompts: testPrompts,
        validateDbt,
      },
    );
    expect(result.status).not.toBe('failed');

    expect(validateDbt).toHaveBeenCalledWith(expect.objectContaining({
      driver: 'dbt',
      source_dir: '/repo/new-dbt',
    }));
    expect(io.stderr()).toContain('dbt project not found');
    expect(testPrompts.select).toHaveBeenCalledWith(
      expect.objectContaining({
        message: 'Connection setup failed for dbt-main',
        options: expect.arrayContaining([
          { value: 'retry', label: 'Retry connection test' },
          { value: 're-enter', label: 'Re-enter connection details' },
          { value: 'skip', label: 'Skip this connection' },
          { value: 'back', label: 'Back' },
        ]),
      }),
    );
    const config = await readConfig();
    expect(config.connections['dbt-main']).toMatchObject({
      driver: 'dbt',
      source_dir: '/repo/existing-dbt',
      project_name: 'analytics',
    });
    expect(config.ingest.adapters).not.toContain('dbt');
  });

  it('lets git-backed context source edits keep the existing repo credential', async () => {
    await addPrimarySource();
    await addConnection('metricflow-main', {
      driver: 'metricflow',
      metricflow: {
        repoUrl: 'https://github.com/acme/private-metricflow',
        branch: 'main',
        path: 'metrics',
        auth_token_ref: 'env:METRICFLOW_REPO_TOKEN', // pragma: allowlist secret
      },
    });
    const testGitRepo = vi.fn(async () => ({ ok: false as const, error: 'authentication required' }));
    const testPrompts = prompts({
      multiselect: [['metricflow']],
      select: ['edit:metricflow-main', 'git', 'keep', 'done'],
      text: ['https://github.com/acme/private-metricflow', 'main', 'metrics'],
    });

    await expect(
      runKtxSetupSourcesStep(
        { projectDir, inputMode: 'auto', runInitialSourceIngest: false, skipSources: false },
        makeIo().io,
        {
          prompts: testPrompts,
          testGitRepo,
          validateMetricflow: vi.fn(async () => ({ ok: true as const, detail: 'metrics=1' })),
        },
      ),
    ).resolves.toEqual({ status: 'ready', projectDir, connectionIds: ['metricflow-main'] });

    expect(testPrompts.select).toHaveBeenCalledWith({
      message: 'This MetricFlow repo requires authentication.',
      options: [
        { value: 'keep', label: 'Keep existing credential' },
        { value: 'paste', label: 'Paste a token and save it as a local secret file' },
        { value: 'env', label: 'Use GITHUB_TOKEN from the environment' },
        { value: 'skip', label: 'Skip — try without authentication' },
        { value: 'back', label: 'Back' },
      ],
    });
    expect((await readConfig()).connections['metricflow-main']).toMatchObject({
      driver: 'metricflow',
      metricflow: {
        repoUrl: 'https://github.com/acme/private-metricflow',
        branch: 'main',
        path: 'metrics',
        auth_token_ref: 'env:METRICFLOW_REPO_TOKEN',
      },
    });
  });

  it('edits an existing context source from the configured-source follow-up menu', async () => {
    await addPrimarySource();
    await addConnection('dbt-main', {
      driver: 'dbt',
      source_dir: '/repo/existing-dbt',
      project_name: 'analytics',
    });
    const validateDbt = vi.fn(async () => ({ ok: true as const, detail: 'project=analytics schemas=2' }));
    const testPrompts = prompts({
      multiselect: [['dbt']],
      select: ['existing:dbt-main', 'edit', 'dbt-main', 'path', 'done'],
      text: ['/repo/edited-dbt', ''],
    });

    await expect(
      runKtxSetupSourcesStep(
        { projectDir, inputMode: 'auto', runInitialSourceIngest: false, skipSources: false },
        makeIo().io,
        {
          prompts: testPrompts,
          validateDbt,
        },
      ),
    ).resolves.toEqual({ status: 'ready', projectDir, connectionIds: ['dbt-main'] });

    expect(testPrompts.select).toHaveBeenCalledWith({
      message: '1 context source configured (dbt-main). Add another?',
      options: [
        { value: 'done', label: 'Done adding context sources' },
        { value: 'edit', label: 'Edit an existing context source' },
        { value: 'add', label: 'Add another context source' },
      ],
    });
    expect(testPrompts.select).toHaveBeenCalledWith({
      message: 'Context source to edit',
      options: [
        { value: 'dbt-main', label: 'dbt-main (dbt)' },
        { value: 'back', label: 'Back' },
      ],
    });
    expect(testPrompts.text).toHaveBeenCalledWith({
      message: textInputPrompt('dbt local path'),
      initialValue: '/repo/existing-dbt',
    });
    expect(validateDbt).toHaveBeenLastCalledWith(expect.objectContaining({
      driver: 'dbt',
      source_dir: '/repo/edited-dbt',
    }));
    expect((await readConfig()).connections['dbt-main']).toMatchObject({
      driver: 'dbt',
      source_dir: '/repo/edited-dbt',
      project_name: 'analytics',
    });
  });

  it('backs out of editing an existing context source to the source connection menu', async () => {
    await addPrimarySource();
    await addConnection('dbt-main', {
      driver: 'dbt',
      source_dir: '/repo/existing-dbt',
      project_name: 'analytics',
    });
    const validateDbt = vi.fn(async () => ({ ok: true as const, detail: 'project=analytics schemas=2' }));
    const testPrompts = prompts({
      multiselect: [['dbt']],
      select: ['edit:dbt-main', 'back', 'existing:dbt-main'],
    });

    await expect(
      runKtxSetupSourcesStep(
        { projectDir, inputMode: 'auto', runInitialSourceIngest: false, skipSources: false },
        makeIo().io,
        {
          prompts: testPrompts,
          validateDbt,
        },
      ),
    ).resolves.toEqual({ status: 'ready', projectDir, connectionIds: ['dbt-main'] });

    expect(
      vi
        .mocked(testPrompts.select)
        .mock.calls.map(([options]) => options.message)
        .filter((message) => message === 'Configure dbt'),
    ).toHaveLength(2);
    expect(validateDbt).toHaveBeenCalledWith({
      driver: 'dbt',
      source_dir: '/repo/existing-dbt',
      project_name: 'analytics',
    });
    expect((await readConfig()).connections['dbt-main']).toMatchObject({
      driver: 'dbt',
      source_dir: '/repo/existing-dbt',
      project_name: 'analytics',
    });
  });

  it('lets Escape from dbt git URL return to source location selection', async () => {
    await addPrimarySource();
    const validateDbt = vi.fn(async () => ({ ok: true as const, detail: 'project=analytics schemas=2' }));
    const testPrompts = prompts({
      multiselect: [['dbt']],
      select: ['git', 'path'],
      text: ['dbt-main', undefined, '/repo/dbt', '', ''],
    });

    await expect(
      runKtxSetupSourcesStep(
        { projectDir, inputMode: 'auto', runInitialSourceIngest: false, skipSources: false },
        makeIo().io,
        {
          prompts: testPrompts,
          validateDbt,
        },
      ),
    ).resolves.toEqual({ status: 'ready', projectDir, connectionIds: ['dbt-main'] });

    const selectMessages = vi.mocked(testPrompts.select).mock.calls.map(([options]) => options.message);
    expect(selectMessages[0]).toBe('dbt source location');
    expect(selectMessages[1]).toBe('dbt source location');
    expect(selectMessages.at(-1)).toContain('Add another?');
    expect((await readConfig()).connections['dbt-main']).toMatchObject({
      driver: 'dbt',
      source_dir: '/repo/dbt',
    });
  });

  it('lets Escape from source connection name return to context source selection', async () => {
    await addPrimarySource();
    const validateDbt = vi.fn(async () => ({ ok: true as const, detail: 'project=analytics schemas=2' }));
    const testPrompts = prompts({
      multiselect: [['dbt'], ['back']],
      text: [undefined],
    });

    await expect(
      runKtxSetupSourcesStep(
        { projectDir, inputMode: 'auto', runInitialSourceIngest: false, skipSources: false },
        makeIo().io,
        {
          prompts: testPrompts,
          validateDbt,
        },
      ),
    ).resolves.toEqual({ status: 'back', projectDir });

    expect(testPrompts.multiselect).toHaveBeenCalledTimes(2);
    expect(validateDbt).not.toHaveBeenCalled();
  });

  it('backs up one prompt inside every interactive context source connection', async () => {
    await addPrimarySource();
    const cases: Array<{
      source: KtxSetupSourceType;
      select?: string[];
      text: Array<string | undefined>;
      deps: KtxSetupSourcesDeps;
      repeatedSelectMessage?: string;
      repeatedTextMessage?: string;
    }> = [
      {
        source: 'dbt',
        select: ['git', 'path'],
        text: ['dbt-main', undefined, '/repo/dbt', '', ''],
        deps: { validateDbt: vi.fn(async () => ({ ok: true as const, detail: 'project=analytics schemas=2' })) },
        repeatedSelectMessage: 'dbt source location',
      },
      {
        source: 'metricflow',
        select: ['git', 'path'],
        text: ['metricflow-main', undefined, '/repo/metricflow', ''],
        deps: { validateMetricflow: vi.fn(async () => ({ ok: true as const, detail: 'metrics=1' })) },
        repeatedSelectMessage: 'metricflow source location',
      },
      {
        source: 'lookml',
        select: ['git', 'path'],
        text: ['lookml-main', undefined, '/repo/lookml', ''],
        deps: { validateLookml: vi.fn(async () => ({ ok: true as const, detail: 'lookmlFiles=1' })) },
        repeatedSelectMessage: 'lookml source location',
      },
      {
        source: 'metabase',
        select: ['back', 'env'],
        text: [
          'metabase-main',
          'https://old-metabase.example.com',
          'https://metabase.example.com',
          '1',
        ],
        deps: {
          validateMetabase: vi.fn(async () => ({ ok: true as const, detail: 'mapping validated' })),
          runMapping: vi.fn(async () => 0),
        },
        repeatedTextMessage: textInputPrompt('Metabase URL'),
      },
      {
        source: 'looker',
        select: ['env'],
        text: [
          'looker-main',
          'https://old-looker.example.com',
          undefined,
          'https://looker.example.com',
          'client-id',
          '',
        ],
        deps: {
          validateLooker: vi.fn(async () => ({ ok: true as const, detail: 'mapping refreshed' })),
          runMapping: vi.fn(async () => 0),
        },
        repeatedTextMessage: textInputPrompt('Looker base URL'),
      },
      {
        source: 'notion',
        select: ['env', 'back', 'env', 'all_accessible'],
        text: ['notion-main'],
        deps: { validateNotion: vi.fn(async () => ({ ok: true as const, detail: 'roots=0' })) },
        repeatedSelectMessage: 'How should ktx find your Notion integration token?',
      },
    ];

    for (const testCase of cases) {
      const testPrompts = prompts({
        multiselect: [[testCase.source]],
        select: testCase.select,
        text: testCase.text,
      });

      await expect(
        runKtxSetupSourcesStep(
          { projectDir, inputMode: 'auto', runInitialSourceIngest: false, skipSources: false },
          makeIo().io,
          {
            prompts: testPrompts,
            ...testCase.deps,
          },
        ),
      ).resolves.toEqual({ status: 'ready', projectDir, connectionIds: [`${testCase.source}-main`] });

      if (testCase.repeatedSelectMessage) {
        expect(
          vi
            .mocked(testPrompts.select)
            .mock.calls.map(([options]) => options.message)
            .filter((message) => message === testCase.repeatedSelectMessage),
        ).toHaveLength(2);
      }
      if (testCase.repeatedTextMessage) {
        expect(
          vi
            .mocked(testPrompts.text)
            .mock.calls.map(([options]) => options.message)
            .filter((message) => message === testCase.repeatedTextMessage),
        ).toHaveLength(2);
      }
    }
  });

  it('does not offer context sources until a database exists', async () => {
    const io = makeIo();
    const testPrompts = prompts({ multiselect: [['notion']] });

    await expect(
      runKtxSetupSourcesStep(
        { projectDir, inputMode: 'auto', runInitialSourceIngest: false, skipSources: false },
        io.io,
        { prompts: testPrompts },
      ),
    ).resolves.toEqual({ status: 'skipped', projectDir });

    expect(testPrompts.multiselect).not.toHaveBeenCalled();
    expect(io.stdout()).toContain('Connect a database before adding context sources.');
    expect(await readFile(join(projectDir, 'ktx.yaml'), 'utf-8')).not.toContain('completed_steps:');
  });

  it('auto-detects dbt_project.yml at the root of a local path', async () => {
    await addPrimarySource();
    const dbtDir = join(tempDir, 'dbt-repo');
    await mkdir(dbtDir, { recursive: true });
    await writeFile(join(dbtDir, 'dbt_project.yml'), 'name: analytics\n');

    const validateDbt = vi.fn(async () => ({ ok: true as const, detail: 'project=analytics schemas=2' }));
    const io = makeIo();
    const testPrompts = prompts({
      multiselect: [['dbt']],
      select: ['path'],
      text: ['dbt-main', dbtDir],
    });

    await expect(
      runKtxSetupSourcesStep(
        { projectDir, inputMode: 'auto', runInitialSourceIngest: false, skipSources: false },
        io.io,
        { prompts: testPrompts, validateDbt },
      ),
    ).resolves.toEqual({ status: 'ready', projectDir, connectionIds: ['dbt-main'] });

    expect(testPrompts.text).toHaveBeenCalledTimes(2);
    const config = await readConfig();
    expect(config.connections['dbt-main']).toMatchObject({ driver: 'dbt', source_dir: dbtDir });
    expect(config.connections['dbt-main']).not.toHaveProperty('path');
  });

  it('auto-detects dbt_project.yml in a subdirectory of a local path', async () => {
    await addPrimarySource();
    const dbtDir = join(tempDir, 'monorepo');
    await mkdir(join(dbtDir, 'analytics', 'dbt'), { recursive: true });
    await writeFile(join(dbtDir, 'analytics', 'dbt', 'dbt_project.yml'), 'name: analytics\n');

    const validateDbt = vi.fn(async () => ({ ok: true as const, detail: 'project=analytics schemas=2' }));
    const io = makeIo();
    const testPrompts = prompts({
      multiselect: [['dbt']],
      select: ['path'],
      text: ['dbt-main', dbtDir],
    });

    await expect(
      runKtxSetupSourcesStep(
        { projectDir, inputMode: 'auto', runInitialSourceIngest: false, skipSources: false },
        io.io,
        { prompts: testPrompts, validateDbt },
      ),
    ).resolves.toEqual({ status: 'ready', projectDir, connectionIds: ['dbt-main'] });

    expect(testPrompts.text).toHaveBeenCalledTimes(2);
    expect(testPrompts.log).toHaveBeenCalledWith('Found dbt_project.yml in analytics/dbt/');
    const config = await readConfig();
    expect(config.connections['dbt-main']).toMatchObject({
      driver: 'dbt',
      source_dir: dbtDir,
      path: 'analytics/dbt',
    });
  });

  it('shows a picker when multiple dbt projects are found in a local path', async () => {
    await addPrimarySource();
    const dbtDir = join(tempDir, 'multi-dbt');
    await mkdir(join(dbtDir, 'analytics'), { recursive: true });
    await mkdir(join(dbtDir, 'staging'), { recursive: true });
    await writeFile(join(dbtDir, 'analytics', 'dbt_project.yml'), 'name: analytics\n');
    await writeFile(join(dbtDir, 'staging', 'dbt_project.yml'), 'name: staging\n');

    const validateDbt = vi.fn(async () => ({ ok: true as const, detail: 'project=analytics schemas=2' }));
    const io = makeIo();
    const testPrompts = prompts({
      multiselect: [['dbt']],
      select: ['path', 'staging'],
      text: ['dbt-main', dbtDir],
    });

    await expect(
      runKtxSetupSourcesStep(
        { projectDir, inputMode: 'auto', runInitialSourceIngest: false, skipSources: false },
        io.io,
        { prompts: testPrompts, validateDbt },
      ),
    ).resolves.toEqual({ status: 'ready', projectDir, connectionIds: ['dbt-main'] });

    expect(testPrompts.select).toHaveBeenCalledWith(
      expect.objectContaining({
        message: 'Multiple dbt projects found — which one should ktx use?',
      }),
    );
    expect(testPrompts.text).toHaveBeenCalledTimes(2);
    const config = await readConfig();
    expect(config.connections['dbt-main']).toMatchObject({
      driver: 'dbt',
      source_dir: dbtDir,
      path: 'staging',
    });
  });

  it('writes Sigma config in non-interactive mode', async () => {
    await addPrimarySource();
    const validateSigma = vi.fn(async () => ({ ok: true as const, detail: 'Sigma API connection verified' }));

    await expect(
      runKtxSetupSourcesStep(
        {
          projectDir,
          inputMode: 'disabled',
          source: 'sigma',
          sourceConnectionId: 'sigma-prod',
          sourceUrl: 'https://api.sigmacomputing.com',
          sourceClientId: 'my-client-id',
          sourceClientSecretRef: 'env:SIGMA_CLIENT_SECRET', // pragma: allowlist secret
          runInitialSourceIngest: false,
          skipSources: false,
        },
        makeIo().io,
        { validateSigma },
      ),
    ).resolves.toEqual({ status: 'ready', projectDir, connectionIds: ['sigma-prod'] });

    expect((await readConfig()).connections['sigma-prod']).toMatchObject({
      driver: 'sigma',
      api_url: 'https://api.sigmacomputing.com',
      client_id: 'my-client-id',
      client_secret_ref: 'env:SIGMA_CLIENT_SECRET', // pragma: allowlist secret
    });
    expect(validateSigma).toHaveBeenCalledOnce();
  });

  it('defaults Sigma api_url when --source-url is omitted', async () => {
    await addPrimarySource();
    const validateSigma = vi.fn(async () => ({ ok: true as const, detail: 'Sigma API connection verified' }));

    await expect(
      runKtxSetupSourcesStep(
        {
          projectDir,
          inputMode: 'disabled',
          source: 'sigma',
          sourceConnectionId: 'sigma-main',
          sourceClientId: 'my-client-id',
          sourceClientSecretRef: 'env:SIGMA_CLIENT_SECRET', // pragma: allowlist secret
          runInitialSourceIngest: false,
          skipSources: false,
        },
        makeIo().io,
        { validateSigma },
      ),
    ).resolves.toEqual({ status: 'ready', projectDir, connectionIds: ['sigma-main'] });

    expect((await readConfig()).connections['sigma-main']).toMatchObject({
      driver: 'sigma',
      api_url: 'https://api.sigmacomputing.com',
    });
  });

  it('rejects --source-auth-token-ref for Sigma and points at --source-client-secret-ref', async () => {
    await addPrimarySource();
    const io = makeIo();

    await expect(
      runKtxSetupSourcesStep(
        {
          projectDir,
          inputMode: 'disabled',
          source: 'sigma',
          sourceConnectionId: 'sigma-main',
          sourceClientId: 'my-client-id',
          sourceAuthTokenRef: 'env:SIGMA_CLIENT_SECRET', // pragma: allowlist secret
          runInitialSourceIngest: false,
          skipSources: false,
        },
        io.io,
        {},
      ),
    ).resolves.toEqual({ status: 'failed', projectDir });

    expect(io.stderr()).toContain('--source-auth-token-ref does not apply to --source sigma; use --source-client-secret-ref.');
  });

  it('runs interactive Sigma setup with API URL, client ID, and env credential', async () => {
    await addPrimarySource();
    const validateSigma = vi.fn(async () => ({ ok: true as const, detail: 'Sigma API connection verified' }));
    const testPrompts = prompts({
      multiselect: [['sigma']],
      select: ['env', 'done'],
      // connection name, API URL (default accepted), client ID
      text: ['sigma-main', 'https://api.sigmacomputing.com', 'my-client-id'],
    });

    await expect(
      runKtxSetupSourcesStep(
        { projectDir, inputMode: 'auto', runInitialSourceIngest: false, skipSources: false },
        makeIo().io,
        { prompts: testPrompts, validateSigma },
      ),
    ).resolves.toEqual({ status: 'ready', projectDir, connectionIds: ['sigma-main'] });

    expect(testPrompts.text).toHaveBeenCalledWith(
      expect.objectContaining({
        message: textInputPrompt(connectionNamePrompt('Sigma Computing')),
        initialValue: 'sigma-main',
      }),
    );
    expect(testPrompts.text).toHaveBeenCalledWith(
      expect.objectContaining({ message: textInputPrompt('Sigma API URL') }),
    );
    expect(testPrompts.text).toHaveBeenCalledWith(
      expect.objectContaining({ message: textInputPrompt('Sigma client ID') }),
    );
    expect(testPrompts.select).toHaveBeenCalledWith({
      message: 'How should ktx find your Sigma client secret?',
      options: [
        { value: 'paste', label: 'Paste a key and save it as a local secret file' },
        { value: 'env', label: 'Use SIGMA_CLIENT_SECRET from the environment' },
        { value: 'back', label: 'Back' },
      ],
    });
    expect((await readConfig()).connections['sigma-main']).toMatchObject({
      driver: 'sigma',
      api_url: 'https://api.sigmacomputing.com',
      client_id: 'my-client-id',
      client_secret_ref: 'env:SIGMA_CLIENT_SECRET', // pragma: allowlist secret
    });
  });

  it('edits an existing Sigma source with current URL and client ID as defaults', async () => {
    await addPrimarySource();
    await addConnection('sigma-main', {
      driver: 'sigma',
      api_url: 'https://api.sigmacomputing.com',
      client_id: 'old-client-id',
      client_secret_ref: 'env:SIGMA_CLIENT_SECRET', // pragma: allowlist secret
    });
    const testPrompts = prompts({
      multiselect: [['sigma']],
      select: ['edit:sigma-main', 'keep', 'done'],
      // API URL and new client ID
      text: ['https://api.sigmacomputing.com', 'new-client-id'],
    });

    await expect(
      runKtxSetupSourcesStep(
        { projectDir, inputMode: 'auto', runInitialSourceIngest: false, skipSources: false },
        makeIo().io,
        {
          prompts: testPrompts,
          validateSigma: vi.fn(async () => ({ ok: true as const, detail: 'Sigma API connection verified' })),
        },
      ),
    ).resolves.toEqual({ status: 'ready', projectDir, connectionIds: ['sigma-main'] });

    expect(testPrompts.text).toHaveBeenCalledWith(
      expect.objectContaining({
        message: textInputPrompt('Sigma API URL'),
        initialValue: 'https://api.sigmacomputing.com',
      }),
    );
    expect(testPrompts.text).toHaveBeenCalledWith(
      expect.objectContaining({
        message: textInputPrompt('Sigma client ID'),
        initialValue: 'old-client-id',  // pre-filled from existing connection
      }),
    );
    expect(testPrompts.select).toHaveBeenCalledWith(
      expect.objectContaining({
        message: 'How should ktx find your Sigma client secret?',
        options: expect.arrayContaining([{ value: 'keep', label: 'Keep existing credential' }]),
      }),
    );
    expect((await readConfig()).connections['sigma-main']).toMatchObject({
      driver: 'sigma',
      client_id: 'new-client-id',
      client_secret_ref: 'env:SIGMA_CLIENT_SECRET', // pragma: allowlist secret
    });
  });

  it('fails Sigma setup when validation rejects the credentials', async () => {
    await addPrimarySource();
    const io = makeIo();

    const result = await runKtxSetupSourcesStep(
      {
        projectDir,
        inputMode: 'disabled',
        source: 'sigma',
        sourceConnectionId: 'sigma-main',
        sourceClientId: 'bad-client-id',
        sourceClientSecretRef: 'env:SIGMA_CLIENT_SECRET', // pragma: allowlist secret
        runInitialSourceIngest: false,
        skipSources: false,
      },
      io.io,
      { validateSigma: vi.fn(async () => ({ ok: false as const, message: 'Sigma auth failed (401): Unauthorized' })) },
    );

    expect(result.status).toBe('failed');
    expect(io.stderr()).toContain('Sigma auth failed (401): Unauthorized');
  });
});
