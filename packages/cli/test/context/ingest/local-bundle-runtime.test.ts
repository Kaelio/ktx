import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { AgentRunnerPort } from '../../../src/context/llm/runtime-port.js';
import { initKtxProject, type KtxLocalProject, loadKtxProject } from '../../../src/context/project/project.js';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { FakeSourceAdapter } from '../../../src/context/ingest/adapters/fake/fake.adapter.js';
import { createLocalBundleIngestRuntime } from '../../../src/context/ingest/local-bundle-runtime.js';

type RuntimeWithConnectionDeps = {
  deps: {
    connections: {
      listEnabledConnections(ids: string[]): Promise<Array<{ id: string; name: string; connectionType: string }>>;
      getConnectionById(connectionId: string): Promise<{ id: string; name: string; connectionType: string } | null>;
      executeQuery(connectionId: string, sql: string): Promise<unknown>;
    };
  };
};

type RuntimeWithSlValidationDeps = {
  deps: {
    slValidator: {
      validateSingleSource(
        deps: unknown,
        connectionId: string,
        sourceName: string,
      ): Promise<{ errors: string[]; warnings: string[] }>;
    };
  };
};

type RuntimeWithSettingsDeps = {
  deps: {
    settings: Record<string, unknown>;
  };
};

function testAgentRunner(): AgentRunnerPort {
  return { runLoop: vi.fn().mockResolvedValue({ stopReason: 'natural' as const }) };
}

describe('createLocalBundleIngestRuntime', () => {
  let tempDir: string;
  let project: KtxLocalProject;

  beforeEach(async () => {
    tempDir = await mkdtemp(join(tmpdir(), 'ktx-local-bundle-runtime-'));
    const projectDir = join(tempDir, 'project');
    await initKtxProject({ projectDir });
    await writeFile(
      join(projectDir, 'ktx.yaml'),
      [
        'connections:',
        '  warehouse:',
        '    driver: postgres',
        'ingest:',
        '  adapters:',
        '    - fake',
        '  embeddings:',
        '    backend: none',
        '',
      ].join('\n'),
      'utf-8',
    );
    project = await loadKtxProject({ projectDir });
  });

  afterEach(async () => {
    await rm(tempDir, { recursive: true, force: true });
  });

  it('requires an agent runner or configured local ingest LLM', () => {
    expect(() =>
      createLocalBundleIngestRuntime({
        project,
        adapters: [new FakeSourceAdapter()],
      }),
    ).toThrow(
      [
        'ktx ingest requires llm.provider.backend: anthropic, vertex, gateway, claude-code, or codex, or an injected agentRunner.',
        'Configure a local Claude Code/Codex session or API-backed LLM, then rerun ingest:',
        `  ktx setup --project-dir ${project.projectDir} --llm-backend claude-code --no-input`,
        `  ktx setup --project-dir ${project.projectDir} --llm-backend codex --no-input`,
        `  ktx setup --project-dir ${project.projectDir} --llm-backend anthropic --anthropic-api-key-env ANTHROPIC_API_KEY --no-input`,
      ].join('\n'),
    );
  });

  it('uses a runtime-backed agent runner when claude-code is configured', () => {
    const runtime = {
      generateText: vi.fn(),
      generateObject: vi.fn(),
      runAgentLoop: vi.fn(async () => ({ stopReason: 'natural' as const })),
      subprocessForkSpec: vi.fn(() => null),
    };
    project.config.llm = {
      provider: { backend: 'claude-code' },
      models: { default: 'sonnet' },
      promptCaching: { enabled: false },
    };
    const createLlmRuntime = vi.fn(() => runtime);

    const created = createLocalBundleIngestRuntime({
      project,
      adapters: [new FakeSourceAdapter()],
      createLlmRuntime,
    });

    expect(created).toBeDefined();
    expect(createLlmRuntime).toHaveBeenCalledWith(
      project.config.llm,
      expect.objectContaining({ projectDir: project.projectDir }),
    );
  });

  it('warns when embeddings are configured but no embedding provider is supplied', () => {
    const logger = { log: vi.fn(), warn: vi.fn(), error: vi.fn() };
    project.config.ingest.embeddings = {
      backend: 'openai',
      model: 'text-embedding-3-small',
      dimensions: 1536,
    };

    createLocalBundleIngestRuntime({
      project,
      adapters: [new FakeSourceAdapter()],
      agentRunner: testAgentRunner(),
      logger: logger as never,
    });

    expect(logger.warn).toHaveBeenCalledWith(
      '[local-bundle-runtime] embeddings backend "openai" is configured but no embedding provider was passed; embedding-dependent stages will run against a no-op embedding port.',
    );
  });

  it('builds runner deps with local SQLite stores and context tools enabled', async () => {
    const agentRunner = testAgentRunner();

    const runtime = createLocalBundleIngestRuntime({
      project,
      adapters: [new FakeSourceAdapter()],
      agentRunner,
      jobIdFactory: () => 'job-1',
    });

    expect(runtime.nextJobId()).toBe('job-1');
    expect(runtime.storage.resolvePullDir('job-1')).toBe(join(project.projectDir, '.ktx/cache/local-ingest/job-1/pull'));
    expect(runtime.storage.resolveUploadDir('job-1')).toBe(
      join(project.projectDir, '.ktx/cache/local-ingest/job-1/upload'),
    );
    expect(runtime.storage.resolveTranscriptDir('job-1')).toBe(
      join(project.projectDir, '.ktx/ingest-transcripts/job-1'),
    );

    await mkdir(runtime.storage.resolveUploadDir('job-1'), { recursive: true });
  });

  it('exposes canonical warehouse connection types to local ingest SL tools', async () => {
    project.config.connections.warehouse = {
      driver: 'postgres',
      url: 'postgresql://readonly@db.example.test/analytics',
    };
    project.config.connections.bq = {
      driver: 'bigquery',
      project_id: 'acme',
      dataset_id: 'warehouse',
    };
    const agentRunner = testAgentRunner();

    const runtime = createLocalBundleIngestRuntime({
      project,
      adapters: [new FakeSourceAdapter()],
      agentRunner,
    });
    const connections = (runtime.runner as unknown as RuntimeWithConnectionDeps).deps.connections;

    await expect(connections.getConnectionById('warehouse')).resolves.toMatchObject({
      id: 'warehouse',
      connectionType: 'POSTGRESQL',
    });
    await expect(connections.listEnabledConnections(['warehouse', 'bq'])).resolves.toEqual([
      { id: 'warehouse', name: 'warehouse', connectionType: 'POSTGRESQL' },
      { id: 'bq', name: 'bq', connectionType: 'BIGQUERY' },
    ]);
  });

  it('validates manifest-backed scan sources during local ingest gates', async () => {
    await project.fileStore.writeFile(
      'semantic-layer/warehouse/_schema/public.yaml',
      [
        'tables:',
        '  payments:',
        '    table: public.payments',
        '    columns:',
        '      - name: payment_id',
        '        type: string',
        '      - name: amount',
        '        type: number',
        '',
      ].join('\n'),
      'ktx',
      'ktx@example.com',
      'Add warehouse manifest',
    );
    const agentRunner = testAgentRunner();

    const runtime = createLocalBundleIngestRuntime({
      project,
      adapters: [new FakeSourceAdapter()],
      agentRunner,
    });
    const deps = (runtime.runner as unknown as RuntimeWithSlValidationDeps).deps;

    await expect(deps.slValidator.validateSingleSource(deps, 'warehouse', 'payments')).resolves.toEqual({
      errors: [],
      warnings: expect.any(Array),
    });
  });

  it('does not mask malformed direct overlays with manifest-backed fallback validation', async () => {
    await project.fileStore.writeFile(
      'semantic-layer/warehouse/_schema/public.yaml',
      [
        'tables:',
        '  payments:',
        '    table: public.payments',
        '    columns:',
        '      - name: payment_id',
        '        type: string',
        '',
      ].join('\n'),
      'ktx',
      'ktx@example.com',
      'Add warehouse manifest',
    );
    await project.fileStore.writeFile(
      'semantic-layer/warehouse/payments.yaml',
      ['name: payments', 'columns:', '  - [', ''].join('\n'),
      'ktx',
      'ktx@example.com',
      'Add malformed overlay',
    );
    const agentRunner = testAgentRunner();

    const runtime = createLocalBundleIngestRuntime({
      project,
      adapters: [new FakeSourceAdapter()],
      agentRunner,
    });
    const deps = (runtime.runner as unknown as RuntimeWithSlValidationDeps).deps;

    await expect(deps.slValidator.validateSingleSource(deps, 'warehouse', 'payments')).resolves.toEqual({
      errors: [expect.stringContaining('invalid YAML')],
      warnings: [],
    });
  });

  it('passes project connection config to local ingest query executors', async () => {
    const agentRunner = testAgentRunner();
    const queryExecutor = {
      execute: vi.fn(async () => ({
        headers: ['answer'],
        rows: [[1]],
        totalRows: 1,
        command: 'SELECT',
        rowCount: 1,
      })),
    };

    const runtime = createLocalBundleIngestRuntime({
      project,
      adapters: [new FakeSourceAdapter()],
      agentRunner,
      queryExecutor,
    });
    const connections = (runtime.runner as unknown as RuntimeWithConnectionDeps).deps.connections;

    await expect(connections.executeQuery('warehouse', 'select 1')).resolves.toMatchObject({
      headers: ['answer'],
    });
    expect(queryExecutor.execute).toHaveBeenCalledWith({
      connectionId: 'warehouse',
      projectDir: project.projectDir,
      connection: project.config.connections.warehouse,
      sql: 'select 1',
    });
  });

  it('defaults local bundle ingest to isolated diffs without a shared-worktree fallback setting', () => {
    const runtime = createLocalBundleIngestRuntime({
      project,
      adapters: [new FakeSourceAdapter()],
      agentRunner: testAgentRunner(),
    });

    const settings = (runtime.runner as unknown as RuntimeWithSettingsDeps).deps.settings;
    const fallbackSettingKey = ['sharedWorktree', 'SourceKeys'].join('');

    expect(settings).not.toHaveProperty(fallbackSettingKey);
    expect(Object.keys(settings).sort()).toEqual([
      'cliVersion',
      'ingestTraceLevel',
      'memoryIngestionModel',
      'probeRowCount',
      'profileIngest',
      'rateLimitGovernor',
      'workUnitFailureMode',
      'workUnitMaxConcurrency',
      'workUnitStepBudget',
    ]);
  });

  it('accepts a debug LLM request file when constructing the default agent runner', async () => {
    await writeFile(
      join(project.projectDir, 'ktx.yaml'),
      [
        'connections:',
        '  warehouse:',
        '    driver: postgres',
        'llm:',
        '  provider:',
        '    backend: gateway',
        '    gateway:',
        '      base_url: https://gateway.example/v1',
        '  models:',
        '    default: anthropic/claude-sonnet-4-6',
        'ingest:',
        '  adapters:',
        '    - fake',
        '  embeddings:',
        '    backend: none',
        '',
      ].join('\n'),
      'utf-8',
    );
    project = await loadKtxProject({ projectDir: project.projectDir });

    const runtime = createLocalBundleIngestRuntime({
      project,
      adapters: [new FakeSourceAdapter()],
      llmDebugRequestFile: join(project.projectDir, '.ktx', 'llm-debug.jsonl'),
    });

    expect(runtime.storage.resolvePullDir('job-1')).toBe(join(project.projectDir, '.ktx/cache/local-ingest/job-1/pull'));
  });
});
