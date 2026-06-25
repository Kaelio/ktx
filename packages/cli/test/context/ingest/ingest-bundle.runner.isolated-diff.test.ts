import { mkdir, mkdtemp, readFile, readdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import YAML from 'yaml';
import { describe, expect, it, vi } from 'vitest';
import { GitService } from '../../../src/context/core/git.service.js';
import { SessionWorktreeService } from '../../../src/context/core/session-worktree.service.js';
import { LocalGitFileStore } from '../../../src/context/project/local-git-file-store.js';
import { SqliteContentResultCache } from '../../../src/context/cache/sqlite-content-result-cache.js';
import { slSourceFilePath } from '../../../src/context/sl/source-files.js';
import { addTouchedSlSource } from '../../../src/context/tools/touched-sl-sources.js';
import { IngestBundleRunner } from '../../../src/context/ingest/ingest-bundle.runner.js';
import type { IngestBundleRunnerDeps } from '../../../src/context/ingest/ports.js';

async function makeRealGitRuntime() {
  const homeDir = await mkdtemp(join(tmpdir(), 'ktx-isolated-runner-'));
  const configDir = join(homeDir, 'config');
  const git = new GitService({
    storage: { configDir, homeDir },
    git: {
      userName: 'System User',
      userEmail: 'system@example.com',
      bootstrapMessage: 'init',
      bootstrapAuthor: 'system',
      bootstrapAuthorEmail: 'system@example.com',
    },
  });
  await git.onModuleInit();
  const configService = new LocalGitFileStore({ rootDir: configDir, git });
  const sessionWorktreeService = new SessionWorktreeService({
    coreConfig: {
      storage: { configDir, homeDir },
      git: {
        userName: 'System User',
        userEmail: 'system@example.com',
        bootstrapMessage: 'init',
        bootstrapAuthor: 'system',
        bootstrapAuthorEmail: 'system@example.com',
      },
    },
    gitService: git,
    configService,
  });
  return { homeDir, configDir, git, configService, sessionWorktreeService };
}

function rootOfConfig(configService: unknown, fallback: string): string {
  const rootDir = (configService as { rootDir?: unknown }).rootDir;
  return typeof rootDir === 'string' ? rootDir : fallback;
}

async function loadSourcesFromRoot(root: string, connectionId = 'warehouse') {
  const dir = join(root, 'semantic-layer', connectionId);
  const entries = await readdir(dir).catch(() => []);
  const sources = await Promise.all(
    entries
      .filter((entry) => entry.endsWith('.yaml') || entry.endsWith('.yml'))
      .sort()
      .map(async (entry) => {
        const parsed = YAML.parse(await readFile(join(dir, entry), 'utf-8')) as Record<string, unknown> | null;
        return parsed && typeof parsed.name === 'string'
          ? {
              name: parsed.name,
              grain: Array.isArray(parsed.grain) ? parsed.grain : [],
              columns: Array.isArray(parsed.columns) ? parsed.columns : [],
              joins: Array.isArray(parsed.joins) ? parsed.joins : [],
              measures: Array.isArray(parsed.measures) ? parsed.measures : [],
              segments: Array.isArray(parsed.segments) ? parsed.segments : [],
              table: parsed.table,
            }
          : null;
      }),
  );
  return {
    sources: sources.filter((source): source is NonNullable<typeof source> => source !== null),
    loadErrors: [],
  };
}

// Mirrors the production contract: resolve the standalone/overlay file for a
// source, null when absent. Fixtures keep filename == name, so a direct read
// is a faithful shortcut.
async function readSourceFileFromRoot(root: string, connectionId: string, sourceName: string) {
  const relPath = `semantic-layer/${connectionId}/${sourceName}.yaml`;
  const content = await readFile(join(root, relPath), 'utf-8').catch(() => null);
  return content === null ? null : { content, path: relPath };
}

async function listGlobalWikiPageKeys(root: string): Promise<string[]> {
  const dir = join(root, 'wiki/global');
  const entries = await readdir(dir).catch(() => []);
  return entries
    .filter((entry) => entry.endsWith('.md'))
    .map((entry) => entry.slice(0, -'.md'.length))
    .sort();
}

function frontmatterList(yaml: string, key: string): string[] {
  const pattern = new RegExp(`(?:^|\\n)${key}:\\n((?:  - .+\\n?)*)`);
  return (
    pattern
      .exec(yaml)?.[1]
      ?.split('\n')
      .map((line) => line.trim().replace(/^- /, ''))
      .filter(Boolean) ?? []
  );
}

function legacyFallbackSettingKey(): string {
  return ['sharedWorktree', 'SourceKeys'].join('');
}

function legacySharedTraceEvent(): string {
  return ['shared', 'worktree', 'path', 'enabled'].join('_');
}

function workUnitRunLoopCalls(deps: IngestBundleRunnerDeps) {
  return vi
    .mocked(deps.agentRunner.runLoop)
    .mock.calls.filter(([params]: any[]) => params.telemetryTags?.operationName === 'ingest-bundle-wu');
}

function makeWikiService(root: string) {
  return {
    listPageKeys: vi.fn(async (scope: string) => (scope === 'GLOBAL' ? listGlobalWikiPageKeys(root) : [])),
    readPage: vi.fn(async (_scope: string, _scopeId: string | null, key: string) => {
      const path = join(root, 'wiki/global', `${key}.md`);
      const raw = await readFile(path, 'utf-8').catch(() => null);
      if (!raw) {
        return null;
      }
      const [, yaml = '', content = ''] = /^---\n([\s\S]*?)\n---\n?([\s\S]*)$/.exec(raw) ?? [];
      return {
        pageKey: key,
        frontmatter: {
          summary: key,
          usage_mode: 'auto',
          refs: frontmatterList(yaml, 'refs'),
          sl_refs: frontmatterList(yaml, 'sl_refs'),
        },
        content: content.trim(),
      };
    }),
    writePage: vi.fn(
      async (
        _scope: string,
        _scopeId: string | null,
        key: string,
        frontmatter: { summary?: string; usage_mode?: string; refs?: string[]; sl_refs?: string[] },
        content: string,
      ) => {
        await mkdir(join(root, 'wiki/global'), { recursive: true });
        const refs = (frontmatter.refs ?? []).map((ref) => `  - ${ref}`).join('\n');
        const slRefs = (frontmatter.sl_refs ?? []).map((ref) => `  - ${ref}`).join('\n');
        await writeFile(
          join(root, 'wiki/global', `${key}.md`),
          [
            '---',
            `summary: ${frontmatter.summary ?? key}`,
            `usage_mode: ${frontmatter.usage_mode ?? 'auto'}`,
            'refs:',
            refs,
            'sl_refs:',
            slRefs,
            '---',
            '',
            content,
            '',
          ].join('\n'),
        );
      },
    ),
    syncFromCommit: vi.fn(),
  };
}

function makeDeps(
  runtime: Awaited<ReturnType<typeof makeRealGitRuntime>>,
  sourceKey = 'metabase',
  settings: Partial<IngestBundleRunnerDeps['settings']> = {},
) {
  const adapter: any = {
    source: sourceKey,
    skillNames: [],
    detect: vi.fn().mockResolvedValue(true),
    chunk: vi.fn().mockResolvedValue({
      workUnits: [
        { unitKey: 'card-wiki', rawFiles: ['cards/wiki.json'], peerFileIndex: [], dependencyPaths: [] },
        { unitKey: 'card-source', rawFiles: ['cards/source.json'], peerFileIndex: [], dependencyPaths: [] },
      ],
    }),
  };
  const wikiService = makeWikiService(runtime.configDir);
  const semanticLayerService: any = {
    loadAllSources: vi.fn(async (connectionId: string) => loadSourcesFromRoot(runtime.configDir, connectionId)),
    listFilesForConnection: vi.fn().mockResolvedValue(['mart_account_segments.yaml']),
    readSourceFile: vi.fn((connectionId: string, sourceName: string) =>
      readSourceFileFromRoot(runtime.configDir, connectionId, sourceName),
    ),
  };
  semanticLayerService.forWorktree = vi.fn((workdir: string) => ({
    ...semanticLayerService,
    loadAllSources: vi.fn(async (connectionId: string) => loadSourcesFromRoot(workdir, connectionId)),
    listFilesForConnection: vi.fn().mockResolvedValue(['mart_account_segments.yaml']),
    readSourceFile: vi.fn((connectionId: string, sourceName: string) =>
      readSourceFileFromRoot(workdir, connectionId, sourceName),
    ),
  }));

  const deps: IngestBundleRunnerDeps = {
    runs: { create: vi.fn().mockResolvedValue({ id: 'run-1' }), markCompleted: vi.fn(), markFailed: vi.fn() },
    provenance: {
      insertMany: vi.fn(),
      findLatestHashesForCompletedSyncs: vi.fn().mockResolvedValue(new Map()),
      findLatestArtifactsForRawPaths: vi.fn().mockResolvedValue(new Map()),
    },
    reports: { create: vi.fn().mockResolvedValue({ id: 'report-1' }), findByJobId: vi.fn().mockResolvedValue(null), markSuperseded: vi.fn() },
    canonicalPins: { listPins: vi.fn().mockResolvedValue([]) },
    contentCache: new SqliteContentResultCache({ dbPath: join(runtime.homeDir, 'cache.sqlite') }),
    registry: { get: vi.fn().mockReturnValue(adapter), register: vi.fn(), has: vi.fn(), list: vi.fn() },
    diffSetService: {
      compute: vi.fn().mockResolvedValue({ added: ['cards/wiki.json', 'cards/source.json'], modified: [], deleted: [], unchanged: [] }),
    },
    sessionWorktreeService: runtime.sessionWorktreeService,
    agentRunner: { runLoop: vi.fn() },
    gitService: runtime.git,
    lockingService: { withLock: vi.fn(async (_key, fn) => fn()) },
    storage: {
      homeDir: join(runtime.configDir, '.ktx'),
      systemGitAuthor: { name: 'ktx Test', email: 'system@ktx.local' },
      resolveUploadDir: (id) => join(runtime.homeDir, 'upload', id),
      resolvePullDir: (id) => join(runtime.homeDir, 'pull', id),
      resolveTranscriptDir: (id) => join(runtime.configDir, '.ktx/ingest-transcripts', id),
      resolveTracePath: (id) => join(runtime.configDir, '.ktx/ingest-traces', id, 'trace.jsonl'),
    },
    settings: {
      memoryIngestionModel: 'test',
      cliVersion: '0.0.0-test',
      probeRowCount: 1,
      ingestTraceLevel: 'trace',
      ...settings,
    },
    skillsRegistry: {
      listSkills: vi.fn().mockResolvedValue([]),
      getSkill: vi.fn().mockResolvedValue(null),
      buildSkillsPrompt: vi.fn().mockReturnValue(''),
      stripFrontmatter: vi.fn((body) => body),
    } as never,
    promptService: { loadPrompt: vi.fn().mockResolvedValue('base') } as never,
    wikiService: { ...wikiService, forWorktree: vi.fn((workdir: string) => makeWikiService(workdir)) } as never,
    knowledgeIndex: { listPagesForUser: vi.fn().mockResolvedValue([]) },
    knowledgeSlRefs: { syncFromWiki: vi.fn() },
    semanticLayerService,
    slSearchService: { indexSources: vi.fn() } as never,
    slSourcesRepository: {} as never,
    slValidator: { validateSingleSource: vi.fn().mockResolvedValue({ errors: [], warnings: [] }) },
    connections: { listEnabledConnections: vi.fn().mockResolvedValue([]), getConnectionById: vi.fn() } as never,
    toolsetFactory: { createIngestWuToolset: vi.fn(() => ({ toRuntimeTools: vi.fn(() => ({})) })) },
    commitMessages: { enqueueForExternalCommit: vi.fn() },
    embedding: { maxBatchSize: 64, computeEmbedding: vi.fn(), computeEmbeddingsBulk: vi.fn() },
  };
  return { deps, adapter };
}

async function mockStageRawFiles(
  runner: IngestBundleRunner,
  runtime: Awaited<ReturnType<typeof makeRealGitRuntime>>,
  hashes: [string, string][],
  sourceKey = 'metabase',
) {
  (runner as any).resolveStagedDir = vi.fn().mockResolvedValue(join(runtime.homeDir, 'stage'));
  (runner as any).stageRawFilesStage1 = vi.fn(async ({ worktreeRoot }: any) => {
    const rawDir = join(worktreeRoot, 'raw-sources/warehouse', sourceKey, 's');
    const stagedDir = join(runtime.homeDir, 'stage');
    await mkdir(rawDir, { recursive: true });
    for (const [rawPath, rawHash] of hashes) {
      await mkdir(join(stagedDir, rawPath.split('/').slice(0, -1).join('/')), { recursive: true });
      await mkdir(join(rawDir, rawPath.split('/').slice(0, -1).join('/')), { recursive: true });
      const content = JSON.stringify({ rawHash });
      await writeFile(join(stagedDir, rawPath), content);
      await writeFile(join(rawDir, rawPath), content);
    }
    return { currentHashes: new Map(hashes), rawDirInWorktree: `raw-sources/warehouse/${sourceKey}/s` };
  });
}

describe('IngestBundleRunner isolated diff path', () => {
  it('routes an unlisted direct-writing source through isolated diffs by default', async () => {
    const runtime = await makeRealGitRuntime();
    try {
      const sourceKey = 'custom-direct-source';
      const { deps, adapter } = makeDeps(runtime, sourceKey);
      adapter.chunk.mockResolvedValue({
        workUnits: [
          {
            unitKey: 'custom-wiki',
            rawFiles: ['custom/page.json'],
            peerFileIndex: [],
            dependencyPaths: [],
          },
        ],
      });

      let currentSession: any = null;
      deps.toolsetFactory.createIngestWuToolset = vi.fn((toolSession: any) => {
        currentSession = toolSession;
        return { toRuntimeTools: vi.fn(() => ({})) };
      });
      deps.agentRunner.runLoop = vi.fn(async (params: any) => {
        if (params.telemetryTags.operationName !== 'ingest-bundle-wu') {
          return { stopReason: 'natural' };
        }
        const root = rootOfConfig(currentSession.configService, runtime.configDir);
        await mkdir(join(root, 'wiki/global'), { recursive: true });
        await writeFile(
          join(root, 'wiki/global/custom-isolated.md'),
          '---\nsummary: Custom isolated write\nusage_mode: auto\n---\n\nCustom isolated write.\n',
          'utf-8',
        );
        currentSession.actions.push({
          target: 'wiki',
          type: 'created',
          key: 'custom-isolated',
          detail: 'Custom isolated write',
          rawPaths: ['custom/page.json'],
        });
        await currentSession.gitService.commitFiles(
          ['wiki/global/custom-isolated.md'],
          'custom wiki',
          'ktx Test',
          'system@ktx.local',
        );
        return { stopReason: 'natural' };
      }) as never;

      const runner = new IngestBundleRunner(deps);
      await mockStageRawFiles(runner, runtime, [['custom/page.json', 'h1']], sourceKey);

      await expect(
        runner.run({
          jobId: 'job-custom-default',
          connectionId: 'warehouse',
          sourceKey,
          trigger: 'upload',
          bundleRef: { kind: 'upload', uploadId: 'upload' },
        }),
      ).resolves.toMatchObject({
        jobId: 'job-custom-default',
        failedWorkUnits: [],
        workUnitCount: 1,
      });

      const trace = await readFile(
        join(runtime.configDir, '.ktx/ingest-traces/job-custom-default/trace.jsonl'),
        'utf-8',
      );
      expect(trace).toContain('isolated_diff_enabled');
      expect(trace).toContain('work_unit_child_created');
      expect(trace).not.toContain(legacySharedTraceEvent());

      const reportCreate = vi.mocked(deps.reports.create).mock.calls.at(-1)?.[0];
      const reportBody = reportCreate?.body as { isolatedDiff?: unknown } | undefined;
      expect(reportBody?.isolatedDiff).toMatchObject({
        enabled: true,
        acceptedPatches: 1,
      });
    } finally {
      await rm(runtime.homeDir, { recursive: true, force: true });
    }
  });

  it('does not support shared-worktree fallback settings', async () => {
    const runtime = await makeRealGitRuntime();
    try {
      const sourceKey = 'legacy-source';
      const staleSettings = {
        [legacyFallbackSettingKey()]: ['legacy-source'],
      } as Partial<IngestBundleRunnerDeps['settings']> & Record<string, unknown>;
      const { deps, adapter } = makeDeps(runtime, sourceKey, staleSettings);
      adapter.chunk.mockResolvedValue({
        workUnits: [
          {
            unitKey: 'legacy-wiki',
            rawFiles: ['legacy/page.json'],
            peerFileIndex: [],
            dependencyPaths: [],
          },
        ],
      });

      let currentSession: any = null;
      deps.toolsetFactory.createIngestWuToolset = vi.fn((toolSession: any) => {
        currentSession = toolSession;
        return { toRuntimeTools: vi.fn(() => ({})) };
      });
      deps.agentRunner.runLoop = vi.fn(async (params: any) => {
        if (params.telemetryTags.operationName !== 'ingest-bundle-wu') {
          return { stopReason: 'natural' };
        }
        const root = rootOfConfig(currentSession.configService, runtime.configDir);
        await mkdir(join(root, 'wiki/global'), { recursive: true });
        await writeFile(
          join(root, 'wiki/global/legacy-isolated.md'),
          '---\nsummary: Legacy isolated write\nusage_mode: auto\n---\n\nLegacy isolated write.\n',
          'utf-8',
        );
        currentSession.actions.push({
          target: 'wiki',
          type: 'created',
          key: 'legacy-isolated',
          detail: 'Legacy isolated write',
          rawPaths: ['legacy/page.json'],
        });
        await currentSession.gitService.commitFiles(
          ['wiki/global/legacy-isolated.md'],
          'legacy isolated wiki',
          'ktx Test',
          'system@ktx.local',
        );
        return { stopReason: 'natural' };
      }) as never;

      const runner = new IngestBundleRunner(deps);
      await mockStageRawFiles(runner, runtime, [['legacy/page.json', 'h1']], sourceKey);

      await expect(
        runner.run({
          jobId: 'job-legacy-isolated',
          connectionId: 'warehouse',
          sourceKey,
          trigger: 'upload',
          bundleRef: { kind: 'upload', uploadId: 'upload' },
        }),
      ).resolves.toMatchObject({
        jobId: 'job-legacy-isolated',
        failedWorkUnits: [],
        workUnitCount: 1,
      });

      const trace = await readFile(
        join(runtime.configDir, '.ktx/ingest-traces/job-legacy-isolated/trace.jsonl'),
        'utf-8',
      );
      expect(trace).toContain('isolated_diff_enabled');
      expect(trace).toContain('work_unit_child_created');
      expect(trace).not.toContain(legacySharedTraceEvent());

      const reportCreate = vi.mocked(deps.reports.create).mock.calls.at(-1)?.[0];
      const reportBody = reportCreate?.body as { isolatedDiff?: unknown } | undefined;
      expect(reportBody?.isolatedDiff).toMatchObject({
        enabled: true,
        acceptedPatches: 1,
      });
    } finally {
      await rm(runtime.homeDir, { recursive: true, force: true });
    }
  });

  it('does not integrate failed isolated WorkUnit patches', async () => {
    const runtime = await makeRealGitRuntime();
    try {
      const { deps, adapter } = makeDeps(runtime, 'fake');
      adapter.chunk.mockResolvedValue({
        workUnits: [
          { unitKey: 'wu-good', rawFiles: ['good.raw'], peerFileIndex: [], dependencyPaths: [] },
          { unitKey: 'wu-bad', rawFiles: ['bad.raw'], peerFileIndex: [], dependencyPaths: [] },
        ],
      });
      deps.diffSetService.compute = vi.fn().mockResolvedValue({
        added: ['good.raw', 'bad.raw'],
        modified: [],
        deleted: [],
        unchanged: [],
      });
      deps.slValidator.validateSingleSource = vi.fn(
        async (_validationDeps: unknown, _connectionId: string, sourceName: string) => ({
          errors: sourceName === 'bad' ? [{ message: 'bad source rejected' }] : [],
          warnings: [],
        }),
      ) as never;

      let currentSession: any = null;
      deps.toolsetFactory.createIngestWuToolset = vi.fn((toolSession: any) => {
        currentSession = toolSession;
        return { toRuntimeTools: vi.fn(() => ({})) };
      });
      deps.agentRunner.runLoop = vi.fn(async (params: any) => {
        if (params.telemetryTags.operationName !== 'ingest-bundle-wu') {
          return { stopReason: 'natural' };
        }
        const unitKey = params.telemetryTags.unitKey;
        const root = rootOfConfig(currentSession.configService, runtime.configDir);
        await mkdir(join(root, 'semantic-layer/warehouse'), { recursive: true });
        if (unitKey === 'wu-good') {
          await writeFile(join(root, 'semantic-layer/warehouse/good.yaml'), 'name: good\n', 'utf-8');
          addTouchedSlSource(currentSession.touchedSlSources, 'warehouse', 'good');
          currentSession.actions.push({
            target: 'sl',
            type: 'created',
            key: 'good',
            detail: 'good source',
            targetConnectionId: 'warehouse',
            rawPaths: ['good.raw'],
          });
          await currentSession.gitService.commitFiles(
            ['semantic-layer/warehouse/good.yaml'],
            'test: add good source',
            'ktx Test',
            'system@ktx.local',
          );
        }
        if (unitKey === 'wu-bad') {
          await writeFile(join(root, 'semantic-layer/warehouse/bad.yaml'), 'name: bad\n', 'utf-8');
          addTouchedSlSource(currentSession.touchedSlSources, 'warehouse', 'bad');
          currentSession.actions.push({
            target: 'sl',
            type: 'created',
            key: 'bad',
            detail: 'bad source',
            targetConnectionId: 'warehouse',
            rawPaths: ['bad.raw'],
          });
          await currentSession.gitService.commitFiles(
            ['semantic-layer/warehouse/bad.yaml'],
            'test: add bad source',
            'ktx Test',
            'system@ktx.local',
          );
        }
        return { stopReason: 'natural' };
      }) as never;

      const runner = new IngestBundleRunner(deps);
      await mockStageRawFiles(
        runner,
        runtime,
        [
          ['good.raw', 'good-hash'],
          ['bad.raw', 'bad-hash'],
        ],
        'fake',
      );

      const result = await runner.run({
        jobId: 'job-failed-wu-isolated',
        connectionId: 'warehouse',
        sourceKey: 'fake',
        trigger: 'upload',
        bundleRef: { kind: 'upload', uploadId: 'upload' },
      });

      expect(result.failedWorkUnits).toEqual(['wu-bad']);
      await expect(readFile(join(runtime.configDir, 'semantic-layer/warehouse/good.yaml'), 'utf-8')).resolves.toContain(
        'good',
      );
      await expect(readFile(join(runtime.configDir, 'semantic-layer/warehouse/bad.yaml'), 'utf-8')).rejects.toThrow();

      const reportCreate = vi.mocked(deps.reports.create).mock.calls.at(-1)?.[0];
      const reportBody = reportCreate?.body as {
        isolatedDiff?: { acceptedPatches?: number };
        failedWorkUnits?: string[];
      };
      expect(reportBody.failedWorkUnits).toEqual(['wu-bad']);
      expect(reportBody.isolatedDiff).toMatchObject({ enabled: true, acceptedPatches: 1 });

      const trace = await readFile(
        join(runtime.configDir, '.ktx/ingest-traces/job-failed-wu-isolated/trace.jsonl'),
        'utf-8',
      );
      expect(trace).toContain('work_unit_failed_before_patch');
      expect(trace).toContain('patch_accepted');
      expect(trace).not.toContain(legacySharedTraceEvent());
    } finally {
      await rm(runtime.homeDir, { recursive: true, force: true });
    }
  });

  it('replays completed work units on a second identical run without an agent loop', async () => {
    const runtime = await makeRealGitRuntime();
    try {
      const { deps, adapter } = makeDeps(runtime, 'dbt');
      adapter.chunk.mockResolvedValue({
        workUnits: [
          { unitKey: 'orders', rawFiles: ['models/orders.sql'], peerFileIndex: [], dependencyPaths: [] },
          { unitKey: 'customers', rawFiles: ['models/customers.sql'], peerFileIndex: [], dependencyPaths: [] },
        ],
      });
      let currentSession: any = null;
      deps.toolsetFactory.createIngestWuToolset = vi.fn((toolSession: any) => {
        currentSession = toolSession;
        return { toRuntimeTools: vi.fn(() => ({})) };
      });
      deps.agentRunner.runLoop = vi.fn(async (params: any) => {
        const unitKey = params.telemetryTags.unitKey;
        const root = rootOfConfig(currentSession.configService, runtime.configDir);
        await mkdir(join(root, 'wiki/global'), { recursive: true });
        await writeFile(
          join(root, `wiki/global/${unitKey}.md`),
          `---\nsummary: ${unitKey}\nusage_mode: auto\n---\n\n${unitKey}\n`,
          'utf-8',
        );
        currentSession.actions.push({ target: 'wiki', type: 'created', key: unitKey, detail: unitKey });
        await currentSession.gitService.commitFiles([`wiki/global/${unitKey}.md`], `wu ${unitKey}`, 'ktx Test', 'system@ktx.local');
        return { stopReason: 'natural' };
      }) as never;

      const runner = new IngestBundleRunner(deps);
      await mockStageRawFiles(runner, runtime, [
        ['models/orders.sql', 'orders-hash'],
        ['models/customers.sql', 'customers-hash'],
      ], 'dbt');

      await expect(
        runner.run({ jobId: 'job-resume-1', connectionId: 'warehouse', sourceKey: 'dbt', trigger: 'upload', bundleRef: { kind: 'upload', uploadId: 'upload' } }),
      ).resolves.toMatchObject({ failedWorkUnits: [] });
      expect(workUnitRunLoopCalls(deps)).toHaveLength(2);

      await expect(
        runner.run({ jobId: 'job-resume-2', connectionId: 'warehouse', sourceKey: 'dbt', trigger: 'upload', bundleRef: { kind: 'upload', uploadId: 'upload' } }),
      ).resolves.toMatchObject({ failedWorkUnits: [] });
      expect(workUnitRunLoopCalls(deps)).toHaveLength(2);

      const trace = await readFile(join(runtime.configDir, '.ktx/ingest-traces/job-resume-2/trace.jsonl'), 'utf-8');
      expect(trace).toContain('work_unit_cache_hit');
      expect(trace.match(/work_unit_cache_replayed/g)).toHaveLength(2);
    } finally {
      await rm(runtime.homeDir, { recursive: true, force: true });
    }
  });

  it('recomputes only the changed work unit after an input byte changes', async () => {
    const runtime = await makeRealGitRuntime();
    try {
      const { deps, adapter } = makeDeps(runtime, 'dbt');
      adapter.chunk.mockResolvedValue({
        workUnits: [
          { unitKey: 'orders', rawFiles: ['models/orders.sql'], peerFileIndex: [], dependencyPaths: [] },
          { unitKey: 'customers', rawFiles: ['models/customers.sql'], peerFileIndex: [], dependencyPaths: [] },
        ],
      });
      let currentSession: any = null;
      deps.toolsetFactory.createIngestWuToolset = vi.fn((toolSession: any) => {
        currentSession = toolSession;
        return { toRuntimeTools: vi.fn(() => ({})) };
      });
      deps.agentRunner.runLoop = vi.fn(async (params: any) => {
        const unitKey = params.telemetryTags.unitKey;
        const root = rootOfConfig(currentSession.configService, runtime.configDir);
        await mkdir(join(root, 'wiki/global'), { recursive: true });
        await writeFile(
          join(root, `wiki/global/${unitKey}.md`),
          `---\nsummary: ${unitKey}\nusage_mode: auto\n---\n\n${unitKey}\n`,
          'utf-8',
        );
        currentSession.actions.push({ target: 'wiki', type: 'updated', key: unitKey, detail: unitKey });
        await currentSession.gitService.commitFiles([`wiki/global/${unitKey}.md`], `wu ${unitKey}`, 'ktx Test', 'system@ktx.local');
        return { stopReason: 'natural' };
      }) as never;

      const runner = new IngestBundleRunner(deps);
      await mockStageRawFiles(runner, runtime, [
        ['models/orders.sql', 'orders-hash'],
        ['models/customers.sql', 'customers-hash'],
      ], 'dbt');
      await runner.run({ jobId: 'job-input-1', connectionId: 'warehouse', sourceKey: 'dbt', trigger: 'upload', bundleRef: { kind: 'upload', uploadId: 'upload' } });

      await mockStageRawFiles(runner, runtime, [
        ['models/orders.sql', 'orders-hash-changed'],
        ['models/customers.sql', 'customers-hash'],
      ], 'dbt');
      await runner.run({ jobId: 'job-input-2', connectionId: 'warehouse', sourceKey: 'dbt', trigger: 'upload', bundleRef: { kind: 'upload', uploadId: 'upload' } });

      const wuCalls = workUnitRunLoopCalls(deps);
      expect(wuCalls).toHaveLength(3);
      const secondRunUnitKeys = wuCalls.slice(2).map(([params]: any[]) => params.telemetryTags.unitKey);
      expect(secondRunUnitKeys).toEqual(['orders']);
    } finally {
      await rm(runtime.homeDir, { recursive: true, force: true });
    }
  });

  it('does not cache failed work units and retries them on the next run', async () => {
    const runtime = await makeRealGitRuntime();
    try {
      const { deps, adapter } = makeDeps(runtime, 'dbt');
      adapter.chunk.mockResolvedValue({
        workUnits: [{ unitKey: 'orders', rawFiles: ['models/orders.sql'], peerFileIndex: [], dependencyPaths: [] }],
      });
      let currentSession: any = null;
      let attempt = 0;
      deps.toolsetFactory.createIngestWuToolset = vi.fn((toolSession: any) => {
        currentSession = toolSession;
        return { toRuntimeTools: vi.fn(() => ({})) };
      });
      deps.agentRunner.runLoop = vi.fn(async () => {
        attempt += 1;
        if (attempt === 1) {
          return { stopReason: 'error', error: new Error('provider disconnected') };
        }
        const root = rootOfConfig(currentSession.configService, runtime.configDir);
        await mkdir(join(root, 'wiki/global'), { recursive: true });
        await writeFile(join(root, 'wiki/global/orders.md'), '---\nsummary: orders\nusage_mode: auto\n---\n\norders\n', 'utf-8');
        currentSession.actions.push({ target: 'wiki', type: 'created', key: 'orders', detail: 'orders' });
        await currentSession.gitService.commitFiles(['wiki/global/orders.md'], 'wu orders', 'ktx Test', 'system@ktx.local');
        return { stopReason: 'natural' };
      }) as never;

      const runner = new IngestBundleRunner(deps);
      await mockStageRawFiles(runner, runtime, [['models/orders.sql', 'orders-hash']], 'dbt');

      await expect(
        runner.run({ jobId: 'job-failed-cache-1', connectionId: 'warehouse', sourceKey: 'dbt', trigger: 'upload', bundleRef: { kind: 'upload', uploadId: 'upload' } }),
      ).resolves.toMatchObject({ failedWorkUnits: ['orders'] });
      await expect(
        runner.run({ jobId: 'job-failed-cache-2', connectionId: 'warehouse', sourceKey: 'dbt', trigger: 'upload', bundleRef: { kind: 'upload', uploadId: 'upload' } }),
      ).resolves.toMatchObject({ failedWorkUnits: [] });
      expect(workUnitRunLoopCalls(deps)).toHaveLength(2);
    } finally {
      await rm(runtime.homeDir, { recursive: true, force: true });
    }
  });

  it('prunes a missing sibling join, then self-heals from the cached owner patch without rerunning it', async () => {
    const runtime = await makeRealGitRuntime();
    try {
      const { deps, adapter } = makeDeps(runtime, 'dbt');
      adapter.chunk.mockResolvedValue({
        workUnits: [
          { unitKey: 'orders', rawFiles: ['models/orders.sql'], peerFileIndex: [], dependencyPaths: [] },
          { unitKey: 'customers', rawFiles: ['models/customers.sql'], peerFileIndex: [], dependencyPaths: [] },
        ],
      });

      let currentSession: any = null;
      let customersAttempt = 0;
      deps.toolsetFactory.createIngestWuToolset = vi.fn((toolSession: any) => {
        currentSession = toolSession;
        return { toRuntimeTools: vi.fn(() => ({})) };
      });
      deps.agentRunner.runLoop = vi.fn(async (params: any) => {
        if (params.telemetryTags?.operationName !== 'ingest-bundle-wu') {
          return { stopReason: 'natural' };
        }
        const unitKey = params.telemetryTags.unitKey;
        const root = rootOfConfig(currentSession.configService, runtime.configDir);
        await mkdir(join(root, 'semantic-layer/warehouse'), { recursive: true });
        if (unitKey === 'orders') {
          await writeFile(
            join(root, 'semantic-layer/warehouse/orders.yaml'),
            [
              'name: orders',
              'grain: [order_id]',
              'columns: [{name: order_id, type: string}, {name: customer_id, type: string}]',
              'joins:',
              '  - to: customers',
              '    on: orders.customer_id = customers.customer_id',
              'measures: []',
              '',
            ].join('\n'),
            'utf-8',
          );
          addTouchedSlSource(currentSession.touchedSlSources, 'warehouse', 'orders');
          currentSession.actions.push({
            target: 'sl',
            type: 'created',
            key: 'orders',
            detail: 'orders with customer join',
            targetConnectionId: 'warehouse',
            rawPaths: ['models/orders.sql'],
          });
          await currentSession.gitService.commitFiles(
            ['semantic-layer/warehouse/orders.yaml'],
            'wu orders',
            'ktx Test',
            'system@ktx.local',
          );
          return { stopReason: 'natural' };
        }

        customersAttempt += 1;
        if (customersAttempt === 1) {
          return { stopReason: 'error', error: new Error('provider disconnected') };
        }
        await writeFile(
          join(root, 'semantic-layer/warehouse/customers.yaml'),
          'name: customers\ngrain: [customer_id]\ncolumns: [{name: customer_id, type: string}]\njoins: []\nmeasures: []\n',
          'utf-8',
        );
        addTouchedSlSource(currentSession.touchedSlSources, 'warehouse', 'customers');
        currentSession.actions.push({
          target: 'sl',
          type: 'created',
          key: 'customers',
          detail: 'customers source',
          targetConnectionId: 'warehouse',
          rawPaths: ['models/customers.sql'],
        });
        await currentSession.gitService.commitFiles(
          ['semantic-layer/warehouse/customers.yaml'],
          'wu customers',
          'ktx Test',
          'system@ktx.local',
        );
        return { stopReason: 'natural' };
      }) as never;

      const runner = new IngestBundleRunner(deps);
      await mockStageRawFiles(
        runner,
        runtime,
        [
          ['models/orders.sql', 'orders-hash'],
          ['models/customers.sql', 'customers-hash'],
        ],
        'dbt',
      );

      const first = await runner.run({
        jobId: 'job-join-prune-1',
        connectionId: 'warehouse',
        sourceKey: 'dbt',
        trigger: 'upload',
        bundleRef: { kind: 'upload', uploadId: 'upload' },
      });
      expect(first.commitSha).toBeTruthy();
      expect(first.failedWorkUnits).toEqual(['customers']);
      expect(first.finalGatePrunedReferences).toContainEqual({
        kind: 'join',
        artifact: 'semantic-layer/warehouse/orders',
        removedRef: 'customers',
        absentTarget: 'customers',
      });
      await expect(readFile(join(runtime.configDir, 'semantic-layer/warehouse/orders.yaml'), 'utf-8')).resolves.not.toContain(
        'to: customers',
      );

      const second = await runner.run({
        jobId: 'job-join-prune-2',
        connectionId: 'warehouse',
        sourceKey: 'dbt',
        trigger: 'upload',
        bundleRef: { kind: 'upload', uploadId: 'upload' },
      });
      expect(second.failedWorkUnits).toEqual([]);
      expect(second.finalGatePrunedReferences ?? []).toEqual([]);
      expect(workUnitRunLoopCalls(deps).map(([params]: any[]) => params.telemetryTags.unitKey)).toEqual([
        'orders',
        'customers',
        'customers',
      ]);
      await expect(readFile(join(runtime.configDir, 'semantic-layer/warehouse/orders.yaml'), 'utf-8')).resolves.toContain(
        'to: customers',
      );
      await expect(readFile(join(runtime.configDir, 'semantic-layer/warehouse/customers.yaml'), 'utf-8')).resolves.toContain(
        'name: customers',
      );
      const trace = await readFile(join(runtime.configDir, '.ktx/ingest-traces/job-join-prune-2/trace.jsonl'), 'utf-8');
      expect(trace).toContain('work_unit_cache_hit');
      expect(trace).toContain('work_unit_cache_replayed');
      expect(trace).not.toContain('work_unit_cache_stale_recompute');
    } finally {
      await rm(runtime.homeDir, { recursive: true, force: true });
    }
  });

  it('prunes a failed sibling join without pruning a valid surviving join', async () => {
    const runtime = await makeRealGitRuntime();
    try {
      const { deps, adapter } = makeDeps(runtime, 'dbt');
      adapter.chunk.mockResolvedValue({
        workUnits: [
          { unitKey: 'orders', rawFiles: ['models/orders.sql'], peerFileIndex: [], dependencyPaths: [] },
          { unitKey: 'customers', rawFiles: ['models/customers.sql'], peerFileIndex: [], dependencyPaths: [] },
          { unitKey: 'products', rawFiles: ['models/products.sql'], peerFileIndex: [], dependencyPaths: [] },
        ],
      });

      let currentSession: any = null;
      deps.toolsetFactory.createIngestWuToolset = vi.fn((toolSession: any) => {
        currentSession = toolSession;
        return { toRuntimeTools: vi.fn(() => ({})) };
      });
      deps.agentRunner.runLoop = vi.fn(async (params: any) => {
        if (params.telemetryTags?.operationName !== 'ingest-bundle-wu') {
          return { stopReason: 'natural' };
        }
        const unitKey = params.telemetryTags.unitKey;
        const root = rootOfConfig(currentSession.configService, runtime.configDir);
        await mkdir(join(root, 'semantic-layer/warehouse'), { recursive: true });

        if (unitKey === 'orders') {
          await writeFile(
            join(root, 'semantic-layer/warehouse/orders.yaml'),
            [
              'name: orders',
              'grain: [order_id]',
              'columns: [{name: order_id, type: string}, {name: customer_id, type: string}, {name: product_id, type: string}]',
              'joins:',
              '  - to: customers',
              '    on: orders.customer_id = customers.customer_id',
              '  - to: products',
              '    on: orders.product_id = products.product_id',
              'measures: []',
              '',
            ].join('\n'),
            'utf-8',
          );
          addTouchedSlSource(currentSession.touchedSlSources, 'warehouse', 'orders');
          currentSession.actions.push({
            target: 'sl',
            type: 'created',
            key: 'orders',
            detail: 'orders with customer and product joins',
            targetConnectionId: 'warehouse',
            rawPaths: ['models/orders.sql'],
          });
          await currentSession.gitService.commitFiles(
            ['semantic-layer/warehouse/orders.yaml'],
            'wu orders',
            'ktx Test',
            'system@ktx.local',
          );
          return { stopReason: 'natural' };
        }

        if (unitKey === 'customers') {
          return { stopReason: 'error', error: new Error('provider disconnected') };
        }

        await writeFile(
          join(root, 'semantic-layer/warehouse/products.yaml'),
          'name: products\ngrain: [product_id]\ncolumns: [{name: product_id, type: string}]\njoins: []\nmeasures: []\n',
          'utf-8',
        );
        addTouchedSlSource(currentSession.touchedSlSources, 'warehouse', 'products');
        currentSession.actions.push({
          target: 'sl',
          type: 'created',
          key: 'products',
          detail: 'products source',
          targetConnectionId: 'warehouse',
          rawPaths: ['models/products.sql'],
        });
        await currentSession.gitService.commitFiles(
          ['semantic-layer/warehouse/products.yaml'],
          'wu products',
          'ktx Test',
          'system@ktx.local',
        );
        return { stopReason: 'natural' };
      }) as never;

      const runner = new IngestBundleRunner(deps);
      await mockStageRawFiles(
        runner,
        runtime,
        [
          ['models/orders.sql', 'orders-hash'],
          ['models/customers.sql', 'customers-hash'],
          ['models/products.sql', 'products-hash'],
        ],
        'dbt',
      );

      const result = await runner.run({
        jobId: 'job-join-prune-no-cascade',
        connectionId: 'warehouse',
        sourceKey: 'dbt',
        trigger: 'upload',
        bundleRef: { kind: 'upload', uploadId: 'upload' },
      });

      expect(result.commitSha).toBeTruthy();
      expect(result.failedWorkUnits).toEqual(['customers']);
      expect(result.finalGatePrunedReferences).toContainEqual({
        kind: 'join',
        artifact: 'semantic-layer/warehouse/orders',
        removedRef: 'customers',
        absentTarget: 'customers',
      });
      expect(result.finalGatePrunedReferences).not.toContainEqual({
        kind: 'join',
        artifact: 'semantic-layer/warehouse/orders',
        removedRef: 'products',
        absentTarget: 'products',
      });
      const ordersYaml = await readFile(join(runtime.configDir, 'semantic-layer/warehouse/orders.yaml'), 'utf-8');
      expect(ordersYaml).not.toContain('to: customers');
      expect(ordersYaml).toContain('to: products');
      await expect(readFile(join(runtime.configDir, 'semantic-layer/warehouse/products.yaml'), 'utf-8')).resolves.toContain(
        'name: products',
      );
    } finally {
      await rm(runtime.homeDir, { recursive: true, force: true });
    }
  });

  it('drops an intrinsically invalid uppercase source at the final gate and reports the producing work unit', async () => {
    const runtime = await makeRealGitRuntime();
    try {
      const { deps, adapter } = makeDeps(runtime, 'dbt');
      adapter.chunk.mockResolvedValue({
        workUnits: [{ unitKey: 'signed-up', rawFiles: ['models/signed_up.sql'], peerFileIndex: [], dependencyPaths: [] }],
      });

      const sourceName = 'SIGNED_UP';
      const sourcePath = slSourceFilePath('warehouse', sourceName);
      let currentSession: any = null;
      deps.toolsetFactory.createIngestWuToolset = vi.fn((toolSession: any) => {
        currentSession = toolSession;
        return { toRuntimeTools: vi.fn(() => ({})) };
      });
      let signedUpValidationCount = 0;
      deps.slValidator.validateSingleSource = vi.fn(
        async (_validationDeps: any, _connectionId: string, validatedSourceName: string) => {
          if (validatedSourceName === sourceName) {
            signedUpValidationCount += 1;
            if (signedUpValidationCount > 1) {
              return { errors: ['intrinsic final validation failed'], warnings: [] };
            }
          }
          return { errors: [], warnings: [] };
        },
      ) as never;
      deps.agentRunner.runLoop = vi.fn(async (params: any) => {
        if (params.telemetryTags?.operationName !== 'ingest-bundle-wu') {
          return { stopReason: 'natural' };
        }
        const root = rootOfConfig(currentSession.configService, runtime.configDir);
        await mkdir(join(root, 'semantic-layer/warehouse'), { recursive: true });
        await writeFile(
          join(root, sourcePath),
          'name: SIGNED_UP\ngrain: [USER_ID]\ncolumns: [{name: USER_ID, type: string}]\njoins: []\nmeasures: []\n',
          'utf-8',
        );
        addTouchedSlSource(currentSession.touchedSlSources, 'warehouse', sourceName);
        currentSession.actions.push({
          target: 'sl',
          type: 'created',
          key: sourceName,
          detail: 'uppercase signed up source',
          targetConnectionId: 'warehouse',
          rawPaths: ['models/signed_up.sql'],
        });
        await currentSession.gitService.commitFiles([sourcePath], 'wu signed up', 'ktx Test', 'system@ktx.local');
        return { stopReason: 'natural' };
      }) as never;

      const runner = new IngestBundleRunner(deps);
      await mockStageRawFiles(runner, runtime, [['models/signed_up.sql', 'signed-up-hash']], 'dbt');

      const result = await runner.run({
        jobId: 'job-final-gate-intrinsic-drop',
        connectionId: 'warehouse',
        sourceKey: 'dbt',
        trigger: 'upload',
        bundleRef: { kind: 'upload', uploadId: 'upload' },
      });

      expect(result.commitSha).toBeTruthy();
      expect(result.failedWorkUnits).toEqual(['signed-up']);
      expect(result.finalGateDroppedSources).toContainEqual({
        connectionId: 'warehouse',
        sourceName,
        reason: 'intrinsic final validation failed',
      });
      await expect(readFile(join(runtime.configDir, sourcePath), 'utf-8')).rejects.toMatchObject({ code: 'ENOENT' });
    } finally {
      await rm(runtime.homeDir, { recursive: true, force: true });
    }
  });

  it('recomputes a stale cached patch and reports recomputed metadata', async () => {
    const runtime = await makeRealGitRuntime();
    try {
      const { deps, adapter } = makeDeps(runtime, 'dbt');
      adapter.chunk.mockResolvedValue({
        workUnits: [{ unitKey: 'orders', rawFiles: ['models/orders.sql'], peerFileIndex: [], dependencyPaths: [] }],
      });
      let currentSession: any = null;
      let agentAttempt = 0;
      deps.toolsetFactory.createIngestWuToolset = vi.fn((toolSession: any) => {
        return {
          toRuntimeTools: vi.fn(() => {
            currentSession = toolSession;
            return {};
          }),
        };
      });
      deps.agentRunner.runLoop = vi.fn(async (params: any) => {
        if (params.telemetryTags?.operationName !== 'ingest-bundle-wu') {
          return { stopReason: 'natural' };
        }
        agentAttempt += 1;
        const root = rootOfConfig(currentSession.configService, runtime.configDir);
        await mkdir(join(root, 'wiki/global'), { recursive: true });
        const detail = agentAttempt === 1 ? 'cached first output' : 'fresh recompute output';
        const body = agentAttempt === 1 ? 'orders cached' : 'orders recomputed';
        await writeFile(
          join(root, 'wiki/global/orders.md'),
          `---\nsummary: orders\nusage_mode: auto\n---\n\n${body}\n`,
          'utf-8',
        );
        currentSession.actions.push({
          target: 'wiki',
          type: agentAttempt === 1 ? 'created' : 'updated',
          key: 'orders',
          detail,
        });
        await currentSession.gitService.commitFiles(
          ['wiki/global/orders.md'],
          `wu orders ${agentAttempt}`,
          'ktx Test',
          'system@ktx.local',
        );
        return { stopReason: 'natural' };
      }) as never;

      const runner = new IngestBundleRunner(deps);
      await mockStageRawFiles(runner, runtime, [['models/orders.sql', 'orders-hash']], 'dbt');

      await expect(
        runner.run({
          jobId: 'job-stale-cache-1',
          connectionId: 'warehouse',
          sourceKey: 'dbt',
          trigger: 'upload',
          bundleRef: { kind: 'upload', uploadId: 'upload' },
        }),
      ).resolves.toMatchObject({ failedWorkUnits: [] });
      expect(workUnitRunLoopCalls(deps)).toHaveLength(1);

      await writeFile(
        join(runtime.configDir, 'wiki/global/orders.md'),
        '---\nsummary: orders\nusage_mode: auto\n---\n\noperator drift\n',
        'utf-8',
      );
      await runtime.git.commitFiles(['wiki/global/orders.md'], 'manual drift', 'ktx Test', 'system@ktx.local');

      await expect(
        runner.run({
          jobId: 'job-stale-cache-2',
          connectionId: 'warehouse',
          sourceKey: 'dbt',
          trigger: 'upload',
          bundleRef: { kind: 'upload', uploadId: 'upload' },
        }),
      ).resolves.toMatchObject({ failedWorkUnits: [] });

      expect(workUnitRunLoopCalls(deps)).toHaveLength(2);
      await expect(readFile(join(runtime.configDir, 'wiki/global/orders.md'), 'utf-8')).resolves.toContain(
        'orders recomputed',
      );

      const trace = await readFile(join(runtime.configDir, '.ktx/ingest-traces/job-stale-cache-2/trace.jsonl'), 'utf-8');
      expect(trace).toContain('work_unit_cache_unsafe_drift');
      expect(trace).not.toContain('work_unit_cache_hit');
      expect(trace).not.toContain('work_unit_cache_stale_recompute');

      const reportCreate = vi.mocked(deps.reports.create).mock.calls.at(-1)?.[0] as any;
      expect(reportCreate.body.workUnits).toContainEqual(
        expect.objectContaining({
          unitKey: 'orders',
          actions: [expect.objectContaining({ type: 'updated', detail: 'fresh recompute output' })],
        }),
      );
    } finally {
      await rm(runtime.homeDir, { recursive: true, force: true });
    }
  });

  it.each(['notion', 'lookml', 'looker', 'dbt', 'metricflow'] as const)(
    'routes %s direct writes through isolated child worktrees',
    async (sourceKey) => {
      const runtime = await makeRealGitRuntime();
      try {
        const { deps, adapter } = makeDeps(runtime, sourceKey);
        adapter.chunk.mockResolvedValue({
          workUnits: [
            {
              unitKey: `${sourceKey}-wiki`,
              rawFiles: [`${sourceKey}/page.json`],
              peerFileIndex: [],
              dependencyPaths: [],
            },
          ],
        });

        let currentSession: any = null;
        deps.toolsetFactory.createIngestWuToolset = vi.fn((toolSession: any) => {
          currentSession = toolSession;
          return { toRuntimeTools: vi.fn(() => ({})) };
        });
        deps.agentRunner.runLoop = vi.fn(async (params: any) => {
          if (params.telemetryTags.operationName !== 'ingest-bundle-wu') {
            return { stopReason: 'natural' };
          }

          expect(params.telemetryTags).toMatchObject({
            operationName: 'ingest-bundle-wu',
            source: sourceKey,
            unitKey: `${sourceKey}-wiki`,
          });

          const root = rootOfConfig(currentSession.configService, runtime.configDir);
          await mkdir(join(root, 'wiki/global'), { recursive: true });
          await writeFile(
            join(root, 'wiki/global', `${sourceKey}-isolated.md`),
            `---\nsummary: ${sourceKey} isolated write\nusage_mode: auto\n---\n\nIsolated ${sourceKey} write.\n`,
            'utf-8',
          );
          currentSession.actions.push({
            target: 'wiki',
            type: 'created',
            key: `${sourceKey}-isolated`,
            detail: `${sourceKey} isolated write`,
            rawPaths: [`${sourceKey}/page.json`],
          });
          await currentSession.gitService.commitFiles(
            [`wiki/global/${sourceKey}-isolated.md`],
            `${sourceKey} wiki`,
            'ktx Test',
            'system@ktx.local',
          );
          return { stopReason: 'natural' };
        }) as never;

        const runner = new IngestBundleRunner(deps);
        await mockStageRawFiles(runner, runtime, [[`${sourceKey}/page.json`, 'h1']], sourceKey);

        await expect(
          runner.run({
            jobId: `job-${sourceKey}`,
            connectionId: 'warehouse',
            sourceKey,
            trigger: 'upload',
            bundleRef: { kind: 'upload', uploadId: 'upload' },
          }),
        ).resolves.toMatchObject({
          jobId: `job-${sourceKey}`,
          failedWorkUnits: [],
          workUnitCount: 1,
        });

        const trace = await readFile(
          join(runtime.configDir, '.ktx/ingest-traces', `job-${sourceKey}`, 'trace.jsonl'),
          'utf-8',
        );
        expect(trace).toContain('isolated_diff_enabled');
        expect(trace).toContain('work_unit_child_created');
        expect(trace).toContain('work_unit_patch_collected');
        expect(trace).toContain('patch_apply_started');
        expect(trace).not.toContain(legacySharedTraceEvent());

        const reportCreate = vi.mocked(deps.reports.create).mock.calls.at(-1)?.[0];
        const reportBody = reportCreate?.body as { isolatedDiff?: unknown } | undefined;
        expect(reportBody?.isolatedDiff).toMatchObject({
          enabled: true,
          acceptedPatches: 1,
        });
      } finally {
        await rm(runtime.homeDir, { recursive: true, force: true });
      }
    },
  );

  it('prunes the Metabase stale-measure wiki body regression before squash', async () => {
    const runtime = await makeRealGitRuntime();
    try {
      const { deps, adapter } = makeDeps(runtime);
      adapter.project = vi.fn(async ({ workdir }) => {
        await mkdir(join(workdir, 'semantic-layer/warehouse'), { recursive: true });
        await writeFile(
          join(workdir, 'semantic-layer/warehouse/mart_account_segments.yaml'),
          'name: mart_account_segments\ngrain: [account_id]\ncolumns: [{name: account_id, type: string}]\njoins: []\nmeasures:\n  - name: total_contract_arr_cents\n    expr: sum(contract_arr)\n',
        );
        return {
          warnings: [],
          errors: [],
          touchedSources: [{ connectionId: 'warehouse', sourceName: 'mart_account_segments' }],
          changedWikiPageKeys: [],
        };
      });
      let currentSession: any = null;
      deps.toolsetFactory.createIngestWuToolset = vi.fn((toolSession: any) => {
        currentSession = toolSession;
        return { toRuntimeTools: vi.fn(() => ({})) };
      });
      deps.agentRunner.runLoop = vi.fn(async (params: any) => {
        const root = rootOfConfig(currentSession.configService, runtime.configDir);
        if (params.telemetryTags.unitKey === 'card-wiki') {
          await mkdir(join(root, 'wiki/global'), { recursive: true });
          await writeFile(
            join(root, 'wiki/global/account-segments.md'),
            '---\nsummary: Account segments\nusage_mode: auto\nsl_refs:\n  - mart_account_segments\n---\n\nARR is `mart_account_segments.total_contract_arr_cents`.\n',
          );
          currentSession.actions.push({ target: 'wiki', type: 'created', key: 'account-segments', detail: 'Account segments' });
          await currentSession.gitService.commitFiles(['wiki/global/account-segments.md'], 'wu wiki', 'ktx Test', 'system@ktx.local');
        }
        if (params.telemetryTags.unitKey === 'card-source') {
          await writeFile(
            join(root, 'semantic-layer/warehouse/mart_account_segments.yaml'),
            'name: mart_account_segments\ngrain: [account_id]\ncolumns: [{name: account_id, type: string}]\njoins: []\nmeasures:\n  - name: total_contract_arr\n    expr: sum(contract_arr)\n',
          );
          addTouchedSlSource(currentSession.touchedSlSources, 'warehouse', 'mart_account_segments');
          currentSession.actions.push({
            target: 'sl',
            type: 'updated',
            key: 'mart_account_segments',
            detail: 'Dollar measure',
            targetConnectionId: 'warehouse',
          });
          await currentSession.gitService.commitFiles(['semantic-layer/warehouse/mart_account_segments.yaml'], 'wu source', 'ktx Test', 'system@ktx.local');
        }
        return { stopReason: 'natural' };
      }) as never;

      const runner = new IngestBundleRunner(deps);
      await mockStageRawFiles(runner, runtime, [
        ['cards/wiki.json', 'h1'],
        ['cards/source.json', 'h2'],
      ]);

      const result = await runner.run({
        jobId: 'job-1',
        connectionId: 'warehouse',
        sourceKey: 'metabase',
        trigger: 'upload',
        bundleRef: { kind: 'upload', uploadId: 'upload' },
      });
      expect(result.finalGatePrunedReferences).toContainEqual({
        kind: 'wiki_body_ref',
        artifact: 'wiki/global/account-segments',
        removedRef: 'mart_account_segments.total_contract_arr_cents',
        absentTarget: 'mart_account_segments.total_contract_arr_cents',
      });
      const trace = await readFile(join(runtime.configDir, '.ktx/ingest-traces/job-1/trace.jsonl'), 'utf-8');
      expect(trace).toContain('input_snapshot');
      expect(trace).toContain('isolated_diff_enabled');
      expect(trace).toContain('work_unit_child_created');
      expect(trace).toContain('work_unit_patch_collected');
      expect(trace).toContain('patch_apply_started');
      expect(trace).toContain('final_artifact_gates_finished');
      expect(trace).toContain('final_gate_prune_finished');
      expect(trace).toContain('squash_finished');
      expect(trace).not.toContain('ingest_failed');
    } finally {
      await rm(runtime.homeDir, { recursive: true, force: true });
    }
  });

  it('prunes unchanged wiki body refs made stale by isolated semantic-layer changes', async () => {
    const runtime = await makeRealGitRuntime();
    try {
      await mkdir(join(runtime.configDir, 'semantic-layer/warehouse'), { recursive: true });
      await mkdir(join(runtime.configDir, 'wiki/global'), { recursive: true });
      await writeFile(
        join(runtime.configDir, 'semantic-layer/warehouse/mart_account_segments.yaml'),
        'name: mart_account_segments\ngrain: [account_id]\ncolumns: [{name: account_id, type: string}]\njoins: []\nmeasures:\n  - name: total_contract_arr_cents\n    expr: sum(contract_arr)\n',
      );
      await writeFile(
        join(runtime.configDir, 'wiki/global/account-segments.md'),
        '---\nsummary: Account segments\nusage_mode: auto\n---\n\nExisting ARR uses `mart_account_segments.total_contract_arr_cents`.\n',
      );
      await runtime.git.commitFiles(
        ['semantic-layer/warehouse/mart_account_segments.yaml', 'wiki/global/account-segments.md'],
        'seed existing wiki body ref',
        'ktx Test',
        'system@ktx.local',
      );
      const preRunHead = await runtime.git.revParseHead();

      const { deps, adapter } = makeDeps(runtime);
      adapter.chunk.mockResolvedValue({
        workUnits: [{ unitKey: 'source-only', rawFiles: ['cards/source.json'], peerFileIndex: [], dependencyPaths: [] }],
      });

      let currentSession: any = null;
      deps.toolsetFactory.createIngestWuToolset = vi.fn((toolSession: any) => {
        currentSession = toolSession;
        return { toRuntimeTools: vi.fn(() => ({})) };
      });
      deps.agentRunner.runLoop = vi.fn(async () => {
        const root = rootOfConfig(currentSession.configService, runtime.configDir);
        await writeFile(
          join(root, 'semantic-layer/warehouse/mart_account_segments.yaml'),
          'name: mart_account_segments\ngrain: [account_id]\ncolumns: [{name: account_id, type: string}]\njoins: []\nmeasures:\n  - name: total_contract_arr\n    expr: sum(contract_arr)\n',
        );
        addTouchedSlSource(currentSession.touchedSlSources, 'warehouse', 'mart_account_segments');
        currentSession.actions.push({
          target: 'sl',
          type: 'updated',
          key: 'mart_account_segments',
          detail: 'Rename ARR measure',
          targetConnectionId: 'warehouse',
          rawPaths: ['cards/source.json'],
        });
        await currentSession.gitService.commitFiles(
          ['semantic-layer/warehouse/mart_account_segments.yaml'],
          'wu source rename',
          'ktx Test',
          'system@ktx.local',
        );
        return { stopReason: 'natural' };
      }) as never;

      const runner = new IngestBundleRunner(deps);
      await mockStageRawFiles(runner, runtime, [['cards/source.json', 'h1']]);

      const result = await runner.run({
        jobId: 'job-existing-body-stale',
        connectionId: 'warehouse',
        sourceKey: 'metabase',
        trigger: 'upload',
        bundleRef: { kind: 'upload', uploadId: 'upload' },
      });

      expect(await runtime.git.revParseHead()).not.toBe(preRunHead);
      expect(result.finalGatePrunedReferences).toContainEqual({
        kind: 'wiki_body_ref',
        artifact: 'wiki/global/account-segments',
        removedRef: 'mart_account_segments.total_contract_arr_cents',
        absentTarget: 'mart_account_segments.total_contract_arr_cents',
      });
      await expect(readFile(join(runtime.configDir, 'wiki/global/account-segments.md'), 'utf-8')).resolves.not.toContain(
        'total_contract_arr_cents',
      );
      const events = (await readFile(join(runtime.configDir, '.ktx/ingest-traces/job-existing-body-stale/trace.jsonl'), 'utf-8'))
        .trim()
        .split('\n')
        .map((line) => JSON.parse(line));
      expect(events.map((event) => event.event)).toEqual(
        expect.arrayContaining([
          'final_artifact_gates_started',
          'final_artifact_gates_finished',
          'final_gate_reference_pruned',
          'final_gate_prune_committed',
          'final_gate_prune_finished',
          'squash_finished',
        ]),
      );
      expect(events.map((event) => event.event)).not.toContain('ingest_failed');
    } finally {
      await rm(runtime.homeDir, { recursive: true, force: true });
    }
  });

  it('accepts two isolated work units that edit different wiki pages', async () => {
    const runtime = await makeRealGitRuntime();
    try {
      const { deps, adapter } = makeDeps(runtime);
      adapter.chunk.mockResolvedValue({
        workUnits: [
          { unitKey: 'page-a', rawFiles: ['pages/a.json'], peerFileIndex: [], dependencyPaths: [] },
          { unitKey: 'page-b', rawFiles: ['pages/b.json'], peerFileIndex: [], dependencyPaths: [] },
        ],
      });
      let currentSession: any = null;
      deps.toolsetFactory.createIngestWuToolset = vi.fn((toolSession: any) => {
        currentSession = toolSession;
        return { toRuntimeTools: vi.fn(() => ({})) };
      });
      deps.agentRunner.runLoop = vi.fn(async (params: any) => {
        const unitKey = params.telemetryTags.unitKey;
        const root = rootOfConfig(currentSession.configService, runtime.configDir);
        await mkdir(join(root, 'wiki/global'), { recursive: true });
        await writeFile(join(root, `wiki/global/${unitKey}.md`), `---\nsummary: ${unitKey}\nusage_mode: auto\n---\n\n${unitKey}\n`);
        currentSession.actions.push({ target: 'wiki', type: 'created', key: unitKey, detail: unitKey });
        await currentSession.gitService.commitFiles([`wiki/global/${unitKey}.md`], `wu ${unitKey}`, 'ktx Test', 'system@ktx.local');
        return { stopReason: 'natural' };
      }) as never;
      const runner = new IngestBundleRunner(deps);
      await mockStageRawFiles(runner, runtime, [
        ['pages/a.json', 'h1'],
        ['pages/b.json', 'h2'],
      ]);

      const result = await runner.run({ jobId: 'job-clean', connectionId: 'warehouse', sourceKey: 'metabase', trigger: 'upload', bundleRef: { kind: 'upload', uploadId: 'upload' } });
      expect(result.failedWorkUnits).toEqual([]);
      const trace = await readFile(join(runtime.configDir, '.ktx/ingest-traces/job-clean/trace.jsonl'), 'utf-8');
      expect(trace.match(/patch_accepted/g)).toHaveLength(2);
      expect(trace).toContain('ingest_finished');
    } finally {
      await rm(runtime.homeDir, { recursive: true, force: true });
    }
  });

  it('classifies same-source patch application failure as a textual conflict', async () => {
    const runtime = await makeRealGitRuntime();
    try {
      const { deps, adapter } = makeDeps(runtime);
      adapter.chunk.mockResolvedValue({
        workUnits: [
          { unitKey: 'orders-a', rawFiles: ['orders/a.json'], peerFileIndex: [], dependencyPaths: [] },
          { unitKey: 'orders-b', rawFiles: ['orders/b.json'], peerFileIndex: [], dependencyPaths: [] },
        ],
      });
      let currentSession: any = null;
      deps.toolsetFactory.createIngestWuToolset = vi.fn((toolSession: any) => {
        currentSession = toolSession;
        return { toRuntimeTools: vi.fn(() => ({})) };
      });
      deps.agentRunner.runLoop = vi.fn(async (params: any) => {
        if (params.telemetryTags.operationName === 'ingest-isolated-diff-textual-resolver') {
          return { stopReason: 'natural' };
        }
        const suffix = params.telemetryTags.unitKey === 'orders-a' ? 'a' : 'b';
        const root = rootOfConfig(currentSession.configService, runtime.configDir);
        await mkdir(join(root, 'semantic-layer/warehouse'), { recursive: true });
        await writeFile(
          join(root, 'semantic-layer/warehouse/orders.yaml'),
          `name: orders\ngrain: [id]\ncolumns: [{name: id, type: string}]\njoins: []\nmeasures:\n  - name: order_count_${suffix}\n    expr: count(*)\n`,
        );
        addTouchedSlSource(currentSession.touchedSlSources, 'warehouse', 'orders');
        currentSession.actions.push({ target: 'sl', type: 'updated', key: 'orders', detail: suffix, targetConnectionId: 'warehouse' });
        await currentSession.gitService.commitFiles(['semantic-layer/warehouse/orders.yaml'], `wu ${suffix}`, 'ktx Test', 'system@ktx.local');
        return { stopReason: 'natural' };
      }) as never;
      const runner = new IngestBundleRunner(deps);
      await mockStageRawFiles(runner, runtime, [
        ['orders/a.json', 'h1'],
        ['orders/b.json', 'h2'],
      ]);

      await expect(
        runner.run({ jobId: 'job-text-conflict', connectionId: 'warehouse', sourceKey: 'metabase', trigger: 'upload', bundleRef: { kind: 'upload', uploadId: 'upload' } }),
      ).rejects.toThrow(/isolated diff textual conflict/);
      const trace = await readFile(join(runtime.configDir, '.ktx/ingest-traces/job-text-conflict/trace.jsonl'), 'utf-8');
      expect(trace).toContain('patch_textual_conflict');
      expect(trace).toContain('textual_conflict_resolver_failed');
    } finally {
      await rm(runtime.homeDir, { recursive: true, force: true });
    }
  });

  it('makes deterministic projection visible to child worktrees before WorkUnit synthesis', async () => {
    const runtime = await makeRealGitRuntime();
    try {
      const { deps, adapter } = makeDeps(runtime);
      adapter.chunk.mockResolvedValue({
        workUnits: [{ unitKey: 'wiki-projected', rawFiles: ['projected/wiki.json'], peerFileIndex: [], dependencyPaths: [] }],
      });
      adapter.project = vi.fn(async ({ workdir }) => {
        await mkdir(join(workdir, 'semantic-layer/warehouse'), { recursive: true });
        await writeFile(
          join(workdir, 'semantic-layer/warehouse/mart_account_segments.yaml'),
          'name: mart_account_segments\ngrain: [account_id]\ncolumns: [{name: account_id, type: string}]\njoins: []\nmeasures:\n  - name: total_contract_arr\n    expr: sum(contract_arr)\n',
        );
        return {
          warnings: [],
          errors: [],
          touchedSources: [{ connectionId: 'warehouse', sourceName: 'mart_account_segments' }],
          changedWikiPageKeys: [],
        };
      });
      let currentSession: any = null;
      deps.toolsetFactory.createIngestWuToolset = vi.fn((toolSession: any) => {
        currentSession = toolSession;
        return { toRuntimeTools: vi.fn(() => ({})) };
      });
      deps.agentRunner.runLoop = vi.fn(async () => {
        const root = rootOfConfig(currentSession.configService, runtime.configDir);
        await expect(readFile(join(root, 'semantic-layer/warehouse/mart_account_segments.yaml'), 'utf-8')).resolves.toContain(
          'total_contract_arr',
        );
        await mkdir(join(root, 'wiki/global'), { recursive: true });
        await writeFile(
          join(root, 'wiki/global/projected-orders.md'),
          '---\nsummary: Projected orders\nusage_mode: auto\nsl_refs:\n  - mart_account_segments\n---\n\nARR `mart_account_segments.total_contract_arr`.\n',
        );
        currentSession.actions.push({ target: 'wiki', type: 'created', key: 'projected-orders', detail: 'Projected orders' });
        await currentSession.gitService.commitFiles(['wiki/global/projected-orders.md'], 'wu projected wiki', 'ktx Test', 'system@ktx.local');
        return { stopReason: 'natural' };
      }) as never;
      const runner = new IngestBundleRunner(deps);
      await mockStageRawFiles(runner, runtime, [['projected/wiki.json', 'h1']]);

      const result = await runner.run({ jobId: 'job-projection', connectionId: 'warehouse', sourceKey: 'metabase', trigger: 'upload', bundleRef: { kind: 'upload', uploadId: 'upload' } });
      expect(result.failedWorkUnits).toEqual([]);
      const trace = await readFile(join(runtime.configDir, '.ktx/ingest-traces/job-projection/trace.jsonl'), 'utf-8');
      expect(trace).toContain('deterministic_projection_finished');
      expect(trace).toContain('deterministic_projection_committed');
    } finally {
      await rm(runtime.homeDir, { recursive: true, force: true });
    }
  });

  it('prunes direct missing wiki sl_refs instead of rejecting the work unit', async () => {
    const runtime = await makeRealGitRuntime();
    try {
      const { deps, adapter } = makeDeps(runtime);
      adapter.chunk.mockResolvedValue({
        workUnits: [{ unitKey: 'notion-page', rawFiles: ['pages/notion.json'], peerFileIndex: [], dependencyPaths: [] }],
      });
      let currentSession: any = null;
      deps.toolsetFactory.createIngestWuToolset = vi.fn((toolSession: any) => {
        currentSession = toolSession;
        return { toRuntimeTools: vi.fn(() => ({})) };
      });
      deps.agentRunner.runLoop = vi.fn(async (params: any) => {
        if (params.telemetryTags?.operationName !== 'ingest-bundle-wu') {
          return { stopReason: 'natural' };
        }
        const root = rootOfConfig(currentSession.configService, runtime.configDir);
        await mkdir(join(root, 'wiki/global'), { recursive: true });
        await writeFile(
          join(root, 'wiki/global/notion-page.md'),
          '---\nsummary: Notion page\nusage_mode: auto\nsl_refs:\n  - missing_source\n---\n\nBody\n',
          'utf-8',
        );
        currentSession.actions.push({ target: 'wiki', type: 'created', key: 'notion-page', detail: 'Notion page' });
        await currentSession.gitService.commitFiles(['wiki/global/notion-page.md'], 'wu notion', 'ktx Test', 'system@ktx.local');
        return { stopReason: 'natural' };
      }) as never;
      const runner = new IngestBundleRunner(deps);
      await mockStageRawFiles(runner, runtime, [['pages/notion.json', 'h1']]);

      const result = await runner.run({
        jobId: 'job-invalid-slrefs',
        connectionId: 'warehouse',
        sourceKey: 'metabase',
        trigger: 'upload',
        bundleRef: { kind: 'upload', uploadId: 'upload' },
      });

      expect(result.commitSha).toBeTruthy();
      expect(result.finalGatePrunedReferences).toContainEqual({
        kind: 'wiki_sl_ref',
        artifact: 'wiki/global/notion-page',
        removedRef: 'missing_source',
        absentTarget: 'missing_source',
      });
      await expect(readFile(join(runtime.configDir, 'wiki/global/notion-page.md'), 'utf-8')).resolves.not.toContain(
        'missing_source',
      );
    } finally {
      await rm(runtime.homeDir, { recursive: true, force: true });
    }
  });

  it('runs final artifact gates after reconciliation mutates the integration tree', async () => {
    const runtime = await makeRealGitRuntime();
    try {
      const { deps, adapter } = makeDeps(runtime);
      adapter.chunk.mockResolvedValue({
        workUnits: [{ unitKey: 'card-source', rawFiles: ['cards/source.json'], peerFileIndex: [], dependencyPaths: [] }],
      });
      let currentSession: any = null;
      deps.toolsetFactory.createIngestWuToolset = vi.fn((toolSession: any) => {
        currentSession = toolSession;
        return { toRuntimeTools: vi.fn(() => ({})) };
      });
      deps.agentRunner.runLoop = vi.fn(async (params: any) => {
        const root = rootOfConfig(currentSession.configService, runtime.configDir);
        if (params.telemetryTags.operationName === 'ingest-bundle-wu') {
          await mkdir(join(root, 'semantic-layer/warehouse'), { recursive: true });
          await writeFile(
            join(root, 'semantic-layer/warehouse/mart_account_segments.yaml'),
            'name: mart_account_segments\ngrain: [account_id]\ncolumns: [{name: account_id, type: string}]\njoins: []\nmeasures:\n  - name: total_contract_arr\n    expr: sum(contract_arr)\n',
          );
          addTouchedSlSource(currentSession.touchedSlSources, 'warehouse', 'mart_account_segments');
          currentSession.actions.push({
            target: 'sl',
            type: 'created',
            key: 'mart_account_segments',
            detail: 'Source with renamed ARR measure',
            targetConnectionId: 'warehouse',
            rawPaths: ['cards/source.json'],
          });
          await currentSession.gitService.commitFiles(
            ['semantic-layer/warehouse/mart_account_segments.yaml'],
            'wu source',
            'ktx Test',
            'system@ktx.local',
          );
        } else {
          await mkdir(join(root, 'wiki/global'), { recursive: true });
          await writeFile(
            join(root, 'wiki/global/account-segments.md'),
            '---\nsummary: Account segments\nusage_mode: auto\nsl_refs:\n  - mart_account_segments\n---\n\nReconcile wrote stale ARR `mart_account_segments.total_contract_arr_cents`.\n',
          );
          currentSession.actions.push({
            target: 'wiki',
            type: 'created',
            key: 'account-segments',
            detail: 'Stale reconcile wiki page',
            rawPaths: ['cards/source.json'],
          });
          await currentSession.gitService.commitFiles(['wiki/global/account-segments.md'], 'reconcile wiki', 'ktx Test', 'system@ktx.local');
        }
        return { stopReason: 'natural' };
      }) as never;

      const runner = new IngestBundleRunner(deps);
      await mockStageRawFiles(runner, runtime, [['cards/source.json', 'h1']]);

      const result = await runner.run({
        jobId: 'job-reconcile-stale',
        connectionId: 'warehouse',
        sourceKey: 'metabase',
        trigger: 'upload',
        bundleRef: { kind: 'upload', uploadId: 'upload' },
      });

      const trace = await readFile(join(runtime.configDir, '.ktx/ingest-traces/job-reconcile-stale/trace.jsonl'), 'utf-8');
      expect(trace).toContain('reconciliation_finished');
      expect(trace).toContain('final_artifact_gates_finished');
      expect(trace).toContain('final_gate_prune_finished');
      expect(trace).toContain('squash_finished');
      expect(trace).not.toContain('ingest_failed');
      expect(result.finalGatePrunedReferences).toContainEqual({
        kind: 'wiki_body_ref',
        artifact: 'wiki/global/account-segments',
        removedRef: 'mart_account_segments.total_contract_arr_cents',
        absentTarget: 'mart_account_segments.total_contract_arr_cents',
      });
      await expect(readFile(join(runtime.configDir, 'wiki/global/account-segments.md'), 'utf-8')).resolves.not.toContain(
        'total_contract_arr_cents',
      );
    } finally {
      await rm(runtime.homeDir, { recursive: true, force: true });
    }
  });

  it('stores final gate prune details in the success report and trace', async () => {
    const runtime = await makeRealGitRuntime();
    try {
      const { deps, adapter } = makeDeps(runtime);
      const createdReports: any[] = [];
      deps.reports.create = vi.fn(async (args: any) => {
        createdReports.push(args);
        return { id: `report-${createdReports.length}` };
      });
      adapter.chunk.mockResolvedValue({
        workUnits: [
          { unitKey: 'card-wiki', rawFiles: ['cards/wiki.json'], peerFileIndex: [], dependencyPaths: [] },
          { unitKey: 'card-source', rawFiles: ['cards/source.json'], peerFileIndex: [], dependencyPaths: [] },
        ],
      });
      let currentSession: any = null;
      deps.toolsetFactory.createIngestWuToolset = vi.fn((toolSession: any) => {
        currentSession = toolSession;
        return { toRuntimeTools: vi.fn(() => ({})) };
      });
      deps.agentRunner.runLoop = vi.fn(async (params: any) => {
        const root = rootOfConfig(currentSession.configService, runtime.configDir);
        if (params.telemetryTags.unitKey === 'card-wiki') {
          await mkdir(join(root, 'wiki/global'), { recursive: true });
          await writeFile(
            join(root, 'wiki/global/account-segments.md'),
            '---\nsummary: Account segments\nusage_mode: auto\n---\n\nARR is `mart_account_segments.total_contract_arr_cents`.\n',
          );
          currentSession.actions.push({
            target: 'wiki',
            type: 'created',
            key: 'account-segments',
            detail: 'Account segments',
            rawPaths: ['cards/wiki.json'],
          });
          await currentSession.gitService.commitFiles(['wiki/global/account-segments.md'], 'wu wiki', 'ktx Test', 'system@ktx.local');
        }
        if (params.telemetryTags.unitKey === 'card-source') {
          await mkdir(join(root, 'semantic-layer/warehouse'), { recursive: true });
          await writeFile(
            join(root, 'semantic-layer/warehouse/mart_account_segments.yaml'),
            'name: mart_account_segments\ngrain: [account_id]\ncolumns: [{name: account_id, type: string}]\njoins: []\nmeasures:\n  - name: total_contract_arr\n    expr: sum(contract_arr)\n',
          );
          addTouchedSlSource(currentSession.touchedSlSources, 'warehouse', 'mart_account_segments');
          currentSession.actions.push({
            target: 'sl',
            type: 'created',
            key: 'mart_account_segments',
            detail: 'Dollar measure',
            targetConnectionId: 'warehouse',
            rawPaths: ['cards/source.json'],
          });
          await currentSession.gitService.commitFiles(
            ['semantic-layer/warehouse/mart_account_segments.yaml'],
            'wu source',
            'ktx Test',
            'system@ktx.local',
          );
        }
        return { stopReason: 'natural' };
      }) as never;

      const runner = new IngestBundleRunner(deps);
      await mockStageRawFiles(runner, runtime, [
        ['cards/wiki.json', 'h1'],
        ['cards/source.json', 'h2'],
      ]);

      const result = await runner.run({
        jobId: 'job-trace-failure',
        connectionId: 'warehouse',
        sourceKey: 'metabase',
        trigger: 'upload',
        bundleRef: { kind: 'upload', uploadId: 'upload' },
      });

      expect(result.finalGatePrunedReferences).toContainEqual({
        kind: 'wiki_body_ref',
        artifact: 'wiki/global/account-segments',
        removedRef: 'mart_account_segments.total_contract_arr_cents',
        absentTarget: 'mart_account_segments.total_contract_arr_cents',
      });
      const successReport = createdReports.find((report) => report.body.status === 'completed');
      expect(successReport.body.tracePath).toContain('job-trace-failure/trace.jsonl');
      expect(successReport.body.finalGatePrunedReferences).toContainEqual({
        kind: 'wiki_body_ref',
        artifact: 'wiki/global/account-segments',
        removedRef: 'mart_account_segments.total_contract_arr_cents',
        absentTarget: 'mart_account_segments.total_contract_arr_cents',
      });

      const events = (await readFile(join(runtime.configDir, '.ktx/ingest-traces/job-trace-failure/trace.jsonl'), 'utf-8'))
        .trim()
        .split('\n')
        .map((line) => JSON.parse(line));
      expect(events.map((event) => event.event)).toEqual(
        expect.arrayContaining([
          'ingest_started',
          'input_snapshot',
          'work_units_planned',
          'isolated_diff_enabled',
          'work_unit_child_created',
          'work_unit_patch_collected',
          'patch_apply_started',
          'patch_accepted',
          'reconciliation_finished',
          'final_artifact_gates_finished',
          'final_gate_reference_pruned',
          'final_gate_prune_committed',
          'final_gate_prune_finished',
          'squash_finished',
        ]),
      );
      expect(events.map((event) => event.event)).not.toContain('ingest_failed');
    } finally {
      await rm(runtime.homeDir, { recursive: true, force: true });
    }
  });

  it('rejects invalid provenance raw paths before squash reaches main', async () => {
    const runtime = await makeRealGitRuntime();
    try {
      const { deps, adapter } = makeDeps(runtime);
      const createdReports: any[] = [];
      deps.reports.create = vi.fn(async (args: any) => {
        createdReports.push(args);
        return { id: `report-${createdReports.length}` };
      });
      adapter.chunk.mockResolvedValue({
        workUnits: [
          {
            unitKey: 'card-valid-artifacts',
            rawFiles: ['cards/source.json'],
            peerFileIndex: [],
            dependencyPaths: [],
          },
        ],
      });

      let currentSession: any = null;
      deps.toolsetFactory.createIngestWuToolset = vi.fn((toolSession: any) => {
        currentSession = toolSession;
        return { toRuntimeTools: vi.fn(() => ({})) };
      });
      deps.agentRunner.runLoop = vi.fn(async () => {
        const root = rootOfConfig(currentSession.configService, runtime.configDir);
        await mkdir(join(root, 'semantic-layer/warehouse'), { recursive: true });
        await mkdir(join(root, 'wiki/global'), { recursive: true });
        await writeFile(
          join(root, 'semantic-layer/warehouse/mart_account_segments.yaml'),
          'name: mart_account_segments\ngrain: [account_id]\ncolumns: [{name: account_id, type: string}]\njoins: []\nmeasures:\n  - name: total_contract_arr\n    expr: sum(contract_arr)\n',
        );
        await writeFile(
          join(root, 'wiki/global/account-segments.md'),
          '---\nsummary: Account segments\nusage_mode: auto\nsl_refs:\n  - mart_account_segments\n---\n\nARR is `mart_account_segments.total_contract_arr`.\n',
        );
        addTouchedSlSource(currentSession.touchedSlSources, 'warehouse', 'mart_account_segments');
        currentSession.actions.push({
          target: 'sl',
          type: 'created',
          key: 'mart_account_segments',
          detail: 'Valid source',
          targetConnectionId: 'warehouse',
          rawPaths: ['cards/source.json'],
        });
        currentSession.actions.push({
          target: 'wiki',
          type: 'created',
          key: 'account-segments',
          detail: 'Valid wiki with invalid provenance raw path',
          rawPaths: ['cards/missing.json'],
        });
        await currentSession.gitService.commitFiles(
          ['semantic-layer/warehouse/mart_account_segments.yaml', 'wiki/global/account-segments.md'],
          'valid artifacts with invalid provenance',
          'ktx Test',
          'system@ktx.local',
        );
        return { stopReason: 'natural' };
      }) as never;

      const runner = new IngestBundleRunner(deps);
      await mockStageRawFiles(runner, runtime, [['cards/source.json', 'h1']]);
      const preRunHead = await runtime.git.revParseHead();

      await expect(
        runner.run({
          jobId: 'job-invalid-provenance',
          connectionId: 'warehouse',
          sourceKey: 'metabase',
          trigger: 'upload',
          bundleRef: { kind: 'upload', uploadId: 'upload' },
        }),
      ).rejects.toThrow(/provenance row references raw path outside this snapshot: cards\/missing\.json/);

      expect(await runtime.git.revParseHead()).toBe(preRunHead);
      expect(deps.provenance.insertMany).not.toHaveBeenCalled();

      const failureReport = createdReports.find((report) => report.body.status === 'failed');
      expect(failureReport.body.tracePath).toContain('job-invalid-provenance/trace.jsonl');
      expect(failureReport.body.failure).toMatchObject({
        phase: 'provenance_validation',
        message: expect.stringContaining('cards/missing.json'),
      });
      expect(failureReport.body.failure.details).toMatchObject({
        invalidRawPaths: ['cards/missing.json'],
        currentRawPaths: ['cards/source.json'],
        invalidRows: expect.arrayContaining([
          expect.objectContaining({
            row: expect.objectContaining({
              rawPath: 'cards/missing.json',
              artifactKind: 'wiki',
              artifactKey: 'account-segments',
              actionType: 'wiki_written',
            }),
            origin: expect.objectContaining({
              source: 'work_unit_action',
              unitKey: 'card-valid-artifacts',
              actionIndex: 1,
              unitRawFiles: ['cards/source.json'],
              action: expect.objectContaining({
                target: 'wiki',
                type: 'created',
                key: 'account-segments',
                rawPaths: ['cards/missing.json'],
              }),
            }),
          }),
        ]),
      });
      expect(failureReport.body.provenanceRows).toEqual(
        expect.arrayContaining([
          expect.objectContaining({ rawPath: 'cards/source.json', artifactKind: 'sl', artifactKey: 'mart_account_segments' }),
          expect.objectContaining({ rawPath: 'cards/missing.json', artifactKind: 'wiki', artifactKey: 'account-segments' }),
        ]),
      );
      expect(failureReport.body.workUnits).toEqual(
        expect.arrayContaining([
          expect.objectContaining({
            unitKey: 'card-valid-artifacts',
            rawFiles: ['cards/source.json'],
            actions: expect.arrayContaining([
              expect.objectContaining({
                target: 'wiki',
                key: 'account-segments',
                rawPaths: ['cards/missing.json'],
              }),
            ]),
          }),
        ]),
      );

      const events = (await readFile(join(runtime.configDir, '.ktx/ingest-traces/job-invalid-provenance/trace.jsonl'), 'utf-8'))
        .trim()
        .split('\n')
        .map((line) => JSON.parse(line));
      expect(events.map((event) => event.event)).toEqual(
        expect.arrayContaining([
          'final_artifact_gates_finished',
          'provenance_rows_validation_failed',
          'ingest_failed',
          'failure_report_created',
        ]),
      );
      expect(events.map((event) => event.event)).not.toContain('squash_finished');
      const validationFailure = events.find((event) => event.event === 'provenance_rows_validation_failed');
      expect(validationFailure).toMatchObject({
        phase: 'provenance',
        data: {
          invalidRawPaths: ['cards/missing.json'],
          currentRawPaths: ['cards/source.json'],
          invalidRows: expect.arrayContaining([
            expect.objectContaining({
              row: expect.objectContaining({ rawPath: 'cards/missing.json' }),
              origin: expect.objectContaining({
                source: 'work_unit_action',
                unitKey: 'card-valid-artifacts',
                actionIndex: 1,
              }),
            }),
          ]),
        },
      });
    } finally {
      await rm(runtime.homeDir, { recursive: true, force: true });
    }
  });

  it('rejects slDisallowed patches that touch semantic-layer files', async () => {
    const runtime = await makeRealGitRuntime();
    try {
      const { deps, adapter } = makeDeps(runtime);
      adapter.chunk.mockResolvedValue({
        workUnits: [
          {
            unitKey: 'lookml-mismatch',
            rawFiles: ['views/orders.lkml'],
            peerFileIndex: [],
            dependencyPaths: [],
            slDisallowed: true,
            slDisallowedReason: 'lookml_connection_mismatch',
          },
        ],
      });
      let currentSession: any = null;
      deps.toolsetFactory.createIngestWuToolset = vi.fn((toolSession: any) => {
        currentSession = toolSession;
        return { toRuntimeTools: vi.fn(() => ({})) };
      });
      deps.agentRunner.runLoop = vi.fn(async () => {
        const root = rootOfConfig(currentSession.configService, runtime.configDir);
        await mkdir(join(root, 'semantic-layer/warehouse'), { recursive: true });
        await writeFile(
          join(root, 'semantic-layer/warehouse/orders.yaml'),
          'name: orders\ngrain: [id]\ncolumns: [{name: id, type: string}]\njoins: []\nmeasures: []\n',
        );
        currentSession.actions.push({ target: 'sl', type: 'created', key: 'orders', detail: 'forbidden', targetConnectionId: 'warehouse' });
        await currentSession.gitService.commitFiles(['semantic-layer/warehouse/orders.yaml'], 'forbidden sl', 'ktx Test', 'system@ktx.local');
        return { stopReason: 'natural' };
      }) as never;
      const runner = new IngestBundleRunner(deps);
      await mockStageRawFiles(runner, runtime, [['views/orders.lkml', 'h1']]);

      await expect(
        runner.run({ jobId: 'job-sl-disallowed', connectionId: 'warehouse', sourceKey: 'metabase', trigger: 'upload', bundleRef: { kind: 'upload', uploadId: 'upload' } }),
      ).rejects.toThrow(/isolated diff textual conflict/);
      const trace = await readFile(join(runtime.configDir, '.ktx/ingest-traces/job-sl-disallowed/trace.jsonl'), 'utf-8');
      expect(trace).toContain('patch_policy_rejected');
      expect(trace).toContain('slDisallowed WorkUnit lookml-mismatch touched semantic-layer/warehouse/orders.yaml');
    } finally {
      await rm(runtime.homeDir, { recursive: true, force: true });
    }
  });

  it('prunes final wiki refs broken by another accepted WorkUnit before squash', async () => {
    const runtime = await makeRealGitRuntime();
    try {
      await mkdir(join(runtime.configDir, 'wiki/global'), { recursive: true });
      await writeFile(
        join(runtime.configDir, 'wiki/global/source-page.md'),
        '---\nsummary: Source page\nusage_mode: auto\n---\n\nSource page\n',
      );
      await runtime.git.commitFiles(['wiki/global/source-page.md'], 'seed source page', 'ktx Test', 'system@ktx.local');
      const preRunHead = await runtime.git.revParseHead();
      const { deps, adapter } = makeDeps(runtime);
      adapter.chunk.mockResolvedValue({
        workUnits: [
          { unitKey: 'page-ref', rawFiles: ['pages/ref.json'], peerFileIndex: [], dependencyPaths: [] },
          { unitKey: 'page-delete', rawFiles: ['pages/delete.json'], peerFileIndex: [], dependencyPaths: [] },
        ],
      });
      let currentSession: any = null;
      deps.toolsetFactory.createIngestWuToolset = vi.fn((toolSession: any) => {
        currentSession = toolSession;
        return { toRuntimeTools: vi.fn(() => ({})) };
      });
      deps.agentRunner.runLoop = vi.fn(async (params: any) => {
        const root = rootOfConfig(currentSession.configService, runtime.configDir);
        if (params.telemetryTags.unitKey === 'page-ref') {
          await mkdir(join(root, 'wiki/global'), { recursive: true });
          await writeFile(
            join(root, 'wiki/global/account-segments.md'),
            '---\nsummary: Account segments\nusage_mode: auto\nrefs:\n  - source-page\n---\n\nSee [[source-page]].\n',
          );
          currentSession.actions.push({
            target: 'wiki',
            type: 'created',
            key: 'account-segments',
            detail: 'Page with wiki ref',
            rawPaths: ['pages/ref.json'],
          });
          await currentSession.gitService.commitFiles(
            ['wiki/global/account-segments.md'],
            'wu page ref',
            'ktx Test',
            'system@ktx.local',
          );
        }
        if (params.telemetryTags.unitKey === 'page-delete') {
          await rm(join(root, 'wiki/global/source-page.md'), { force: true });
          currentSession.actions.push({
            target: 'wiki',
            type: 'removed',
            key: 'source-page',
            detail: 'Delete referenced page',
            rawPaths: ['pages/delete.json'],
          });
          await currentSession.gitService.commitFiles(
            ['wiki/global/source-page.md'],
            'wu delete source page',
            'ktx Test',
            'system@ktx.local',
          );
        }
        return { stopReason: 'natural' };
      }) as never;

      const runner = new IngestBundleRunner(deps);
      await mockStageRawFiles(runner, runtime, [
        ['pages/ref.json', 'h1'],
        ['pages/delete.json', 'h2'],
      ]);

      const result = await runner.run({
        jobId: 'job-wiki-ref-conflict',
        connectionId: 'warehouse',
        sourceKey: 'metabase',
        trigger: 'upload',
        bundleRef: { kind: 'upload', uploadId: 'upload' },
      });

      expect(await runtime.git.revParseHead()).not.toBe(preRunHead);
      expect(result.finalGatePrunedReferences).toContainEqual({
        kind: 'wiki_ref',
        artifact: 'wiki/global/account-segments',
        removedRef: 'source-page',
        absentTarget: 'source-page',
      });
      await expect(readFile(join(runtime.configDir, 'wiki/global/account-segments.md'), 'utf-8')).resolves.not.toContain(
        'source-page',
      );
      const trace = await readFile(join(runtime.configDir, '.ktx/ingest-traces/job-wiki-ref-conflict/trace.jsonl'), 'utf-8');
      expect(trace).toContain('final_artifact_gates_finished');
      expect(trace).toContain('final_gate_reference_pruned');
      expect(trace).toContain('squash_finished');
      expect(trace).not.toContain('ingest_failed');
    } finally {
      await rm(runtime.homeDir, { recursive: true, force: true });
    }
  });

  it('prunes unchanged inbound wiki refs broken by an isolated wiki deletion', async () => {
    const runtime = await makeRealGitRuntime();
    try {
      await mkdir(join(runtime.configDir, 'wiki/global'), { recursive: true });
      await writeFile(
        join(runtime.configDir, 'wiki/global/source-page.md'),
        '---\nsummary: Source page\nusage_mode: auto\n---\n\nSource page\n',
      );
      await writeFile(
        join(runtime.configDir, 'wiki/global/account-segments.md'),
        '---\nsummary: Account segments\nusage_mode: auto\nrefs:\n  - source-page\n---\n\nSee [[source-page]].\n',
      );
      await runtime.git.commitFiles(
        ['wiki/global/source-page.md', 'wiki/global/account-segments.md'],
        'seed inbound wiki refs',
        'ktx Test',
        'system@ktx.local',
      );
      const preRunHead = await runtime.git.revParseHead();

      const { deps, adapter } = makeDeps(runtime);
      adapter.chunk.mockResolvedValue({
        workUnits: [{ unitKey: 'delete-target-page', rawFiles: ['pages/delete.json'], peerFileIndex: [], dependencyPaths: [] }],
      });

      let currentSession: any = null;
      deps.toolsetFactory.createIngestWuToolset = vi.fn((toolSession: any) => {
        currentSession = toolSession;
        return { toRuntimeTools: vi.fn(() => ({})) };
      });
      deps.agentRunner.runLoop = vi.fn(async (params: any) => {
        if (params.telemetryTags.unitKey !== 'delete-target-page') {
          return { stopReason: 'natural' };
        }
        const root = rootOfConfig(currentSession.configService, runtime.configDir);
        await rm(join(root, 'wiki/global/source-page.md'), { force: true });
        currentSession.actions.push({
          target: 'wiki',
          type: 'removed',
          key: 'source-page',
          detail: 'Delete referenced page',
          rawPaths: ['pages/delete.json'],
        });
        await currentSession.gitService.commitFiles(
          ['wiki/global/source-page.md'],
          'wu delete target page',
          'ktx Test',
          'system@ktx.local',
        );
        return { stopReason: 'natural' };
      }) as never;

      const runner = new IngestBundleRunner(deps);
      await mockStageRawFiles(runner, runtime, [['pages/delete.json', 'h1']]);

      const result = await runner.run({
        jobId: 'job-existing-wiki-ref-stale',
        connectionId: 'warehouse',
        sourceKey: 'metabase',
        trigger: 'upload',
        bundleRef: { kind: 'upload', uploadId: 'upload' },
      });

      expect(await runtime.git.revParseHead()).not.toBe(preRunHead);
      expect(result.finalGatePrunedReferences).toContainEqual({
        kind: 'wiki_ref',
        artifact: 'wiki/global/account-segments',
        removedRef: 'source-page',
        absentTarget: 'source-page',
      });
      await expect(readFile(join(runtime.configDir, 'wiki/global/account-segments.md'), 'utf-8')).resolves.not.toContain(
        'source-page',
      );
      const events = (await readFile(join(runtime.configDir, '.ktx/ingest-traces/job-existing-wiki-ref-stale/trace.jsonl'), 'utf-8'))
        .trim()
        .split('\n')
        .map((line) => JSON.parse(line));
      expect(events.map((event) => event.event)).toEqual(
        expect.arrayContaining([
          'final_artifact_gates_started',
          'final_artifact_gates_finished',
          'final_gate_reference_pruned',
          'final_gate_prune_committed',
          'final_gate_prune_finished',
          'squash_finished',
        ]),
      );
      expect(events.map((event) => event.event)).not.toContain('ingest_failed');
    } finally {
      await rm(runtime.homeDir, { recursive: true, force: true });
    }
  });

  it('rejects WorkUnit patches that touch unauthorized semantic-layer target connections', async () => {
    const runtime = await makeRealGitRuntime();
    try {
      const { deps, adapter } = makeDeps(runtime);
      adapter.chunk.mockResolvedValue({
        workUnits: [{ unitKey: 'finance-source', rawFiles: ['cards/finance.json'], peerFileIndex: [], dependencyPaths: [] }],
      });
      let currentSession: any = null;
      deps.toolsetFactory.createIngestWuToolset = vi.fn((toolSession: any) => {
        currentSession = toolSession;
        return { toRuntimeTools: vi.fn(() => ({})) };
      });
      deps.agentRunner.runLoop = vi.fn(async () => {
        const root = rootOfConfig(currentSession.configService, runtime.configDir);
        await mkdir(join(root, 'semantic-layer/finance'), { recursive: true });
        await writeFile(
          join(root, 'semantic-layer/finance/orders.yaml'),
          'name: orders\ngrain: [id]\ncolumns: [{name: id, type: string}]\njoins: []\nmeasures: []\n',
        );
        addTouchedSlSource(currentSession.touchedSlSources, 'finance', 'orders');
        currentSession.actions.push({
          target: 'sl',
          type: 'created',
          key: 'orders',
          detail: 'Unauthorized target',
          targetConnectionId: 'finance',
          rawPaths: ['cards/finance.json'],
        });
        await currentSession.gitService.commitFiles(
          ['semantic-layer/finance/orders.yaml'],
          'wu unauthorized target',
          'ktx Test',
          'system@ktx.local',
        );
        return { stopReason: 'natural' };
      }) as never;

      const runner = new IngestBundleRunner(deps);
      await mockStageRawFiles(runner, runtime, [['cards/finance.json', 'h1']]);
      const preRunHead = await runtime.git.revParseHead();

      await expect(
        runner.run({
          jobId: 'job-unauthorized-wu-target',
          connectionId: 'warehouse',
          sourceKey: 'metabase',
          trigger: 'upload',
          bundleRef: { kind: 'upload', uploadId: 'upload' },
        }),
      ).rejects.toThrow(/isolated diff textual conflict.*semantic-layer target connection not allowed/);

      expect(await runtime.git.revParseHead()).toBe(preRunHead);
      const trace = await readFile(join(runtime.configDir, '.ktx/ingest-traces/job-unauthorized-wu-target/trace.jsonl'), 'utf-8');
      expect(trace).toContain('patch_policy_rejected');
      expect(trace).toContain('semantic-layer/finance/orders.yaml');
      expect(trace).toContain('allowedTargetConnectionIds');
      expect(trace).toContain('ingest_failed');
      expect(trace).toContain('failure_report_created');
      expect(trace).not.toContain('squash_finished');

      const failureReport = (deps.reports.create as any).mock.calls
        .map((call: any[]) => call[0])
        .find((report: any) => report.body.status === 'failed');
      expect(failureReport.body.failure).toMatchObject({
        phase: 'integration',
        message: expect.stringContaining('semantic-layer target connection not allowed'),
      });
      expect(failureReport.body.failure.details).toMatchObject({
        unitKey: 'finance-source',
        allowedTargetConnectionIds: ['warehouse'],
        touchedPaths: ['semantic-layer/finance/orders.yaml'],
        reason: expect.stringContaining('semantic-layer/finance/orders.yaml (finance)'),
      });
    } finally {
      await rm(runtime.homeDir, { recursive: true, force: true });
    }
  });

  it('rejects reconciliation mutations that touch unauthorized semantic-layer target connections before squash', async () => {
    const runtime = await makeRealGitRuntime();
    try {
      const { deps, adapter } = makeDeps(runtime);
      adapter.chunk.mockResolvedValue({
        workUnits: [{ unitKey: 'valid-page', rawFiles: ['pages/source.json'], peerFileIndex: [], dependencyPaths: [] }],
      });
      let currentSession: any = null;
      deps.toolsetFactory.createIngestWuToolset = vi.fn((toolSession: any) => {
        currentSession = toolSession;
        return { toRuntimeTools: vi.fn(() => ({})) };
      });
      deps.agentRunner.runLoop = vi.fn(async (params: any) => {
        const root = rootOfConfig(currentSession.configService, runtime.configDir);
        if (params.telemetryTags.operationName === 'ingest-bundle-wu') {
          await mkdir(join(root, 'wiki/global'), { recursive: true });
          await writeFile(join(root, 'wiki/global/valid-page.md'), '---\nsummary: Valid page\nusage_mode: auto\n---\n\nValid\n');
          currentSession.actions.push({
            target: 'wiki',
            type: 'created',
            key: 'valid-page',
            detail: 'Valid page',
            rawPaths: ['pages/source.json'],
          });
          await currentSession.gitService.commitFiles(['wiki/global/valid-page.md'], 'wu valid page', 'ktx Test', 'system@ktx.local');
        } else {
          await mkdir(join(root, 'semantic-layer/finance'), { recursive: true });
          await writeFile(
            join(root, 'semantic-layer/finance/reconcile_orders.yaml'),
            'name: reconcile_orders\ngrain: [id]\ncolumns: [{name: id, type: string}]\njoins: []\nmeasures: []\n',
          );
          addTouchedSlSource(currentSession.touchedSlSources, 'finance', 'reconcile_orders');
          currentSession.actions.push({
            target: 'sl',
            type: 'created',
            key: 'reconcile_orders',
            detail: 'Unauthorized reconcile target',
            targetConnectionId: 'finance',
            rawPaths: ['pages/source.json'],
          });
          await currentSession.gitService.commitFiles(
            ['semantic-layer/finance/reconcile_orders.yaml'],
            'reconcile unauthorized target',
            'ktx Test',
            'system@ktx.local',
          );
        }
        return { stopReason: 'natural' };
      }) as never;

      const runner = new IngestBundleRunner(deps);
      await mockStageRawFiles(runner, runtime, [['pages/source.json', 'h1']]);
      const preRunHead = await runtime.git.revParseHead();

      await expect(
        runner.run({
          jobId: 'job-unauthorized-reconcile-target',
          connectionId: 'warehouse',
          sourceKey: 'metabase',
          trigger: 'upload',
          bundleRef: { kind: 'upload', uploadId: 'upload' },
        }),
      ).rejects.toThrow(/semantic-layer target connection not allowed/);

      expect(await runtime.git.revParseHead()).toBe(preRunHead);
      const trace = await readFile(
        join(runtime.configDir, '.ktx/ingest-traces/job-unauthorized-reconcile-target/trace.jsonl'),
        'utf-8',
      );
      expect(trace).toContain('semantic_layer_target_policy_started');
      expect(trace).toContain('semantic_layer_target_policy_failed');
      expect(trace).toContain('allowedTargetConnectionIds');
      expect(trace).toContain('semantic-layer/finance/reconcile_orders.yaml');
      expect(trace).toContain('ingest_failed');
      expect(trace).toContain('failure_report_created');
      expect(trace).not.toContain('squash_finished');
      const failureReport = (deps.reports.create as any).mock.calls
        .map((call: any[]) => call[0])
        .find((report: any) => report.body.status === 'failed');
      expect(failureReport.body.failure).toMatchObject({
        phase: 'target_policy',
        message: expect.stringContaining('semantic-layer target connection not allowed'),
      });
      expect(failureReport.body.failure.details).toMatchObject({
        allowedTargetConnectionIds: ['warehouse'],
        touchedPaths: expect.arrayContaining(['semantic-layer/finance/reconcile_orders.yaml']),
      });
    } finally {
      await rm(runtime.homeDir, { recursive: true, force: true });
    }
  });

  it('repairs additive same-source textual conflicts before final gates and squash', async () => {
    const runtime = await makeRealGitRuntime();
    try {
      const { deps } = makeDeps(runtime);
      let currentSession: any = null;
      deps.toolsetFactory.createIngestWuToolset = vi.fn((toolSession: any) => {
        currentSession = toolSession;
        return { toRuntimeTools: vi.fn(() => ({})) };
      });
      deps.agentRunner.runLoop = vi.fn(async (params: any) => {
        if (params.telemetryTags.operationName === 'ingest-isolated-diff-textual-resolver') {
          const current = await params.toolSet.read_repair_file.execute({
            path: 'semantic-layer/warehouse/mart_account_segments.yaml',
          });
          expect(current.markdown).toContain('total_contract_arr_cents');
          const patch = await params.toolSet.read_failed_patch.execute({});
          expect(patch.markdown).toContain('account_count');
          await params.toolSet.write_repair_file.execute({
            path: 'semantic-layer/warehouse/mart_account_segments.yaml',
            content:
              'name: mart_account_segments\n' +
              'grain: [account_id]\n' +
              'columns: [{name: account_id, type: string}]\n' +
              'joins: []\n' +
              'measures:\n' +
              '  - name: total_contract_arr_cents\n' +
              '    expr: sum(contract_arr)\n' +
              '  - name: account_count\n' +
              '    expr: count_distinct(account_id)\n',
          });
          return { stopReason: 'natural' };
        }

        const root = rootOfConfig(currentSession.configService, runtime.configDir);
        await mkdir(join(root, 'semantic-layer/warehouse'), { recursive: true });
        if (params.telemetryTags.unitKey === 'card-wiki') {
          await writeFile(
            join(root, 'semantic-layer/warehouse/mart_account_segments.yaml'),
            'name: mart_account_segments\n' +
              'grain: [account_id]\n' +
              'columns: [{name: account_id, type: string}]\n' +
              'joins: []\n' +
              'measures:\n' +
              '  - name: total_contract_arr_cents\n' +
              '    expr: sum(contract_arr)\n',
          );
        } else if (params.telemetryTags.unitKey === 'card-source') {
          await writeFile(
            join(root, 'semantic-layer/warehouse/mart_account_segments.yaml'),
            'name: mart_account_segments\n' +
              'grain: [account_id]\n' +
              'columns: [{name: account_id, type: string}]\n' +
              'joins: []\n' +
              'measures:\n' +
              '  - name: account_count\n' +
              '    expr: count_distinct(account_id)\n',
          );
        }
        addTouchedSlSource(currentSession.touchedSlSources, 'warehouse', 'mart_account_segments');
        currentSession.actions.push({
          target: 'sl',
          type: 'updated',
          key: 'mart_account_segments',
          detail: 'Updated account segments source',
          targetConnectionId: 'warehouse',
        });
        await currentSession.gitService.commitFiles(
          ['semantic-layer/warehouse/mart_account_segments.yaml'],
          `wu ${params.telemetryTags.unitKey}`,
          'ktx Test',
          'system@ktx.local',
        );
        return { stopReason: 'natural' };
      }) as never;

      const runner = new IngestBundleRunner(deps);
      await mockStageRawFiles(runner, runtime, [
        ['cards/wiki.json', 'hash-a'],
        ['cards/source.json', 'hash-b'],
      ]);

      const result = await runner.run({
        jobId: 'job-resolver-e2e',
        connectionId: 'warehouse',
        sourceKey: 'metabase',
        trigger: 'manual_resync',
        bundleRef: { kind: 'upload', uploadId: 'upload-1' },
      });

      expect(result.commitSha).toBeTruthy();
      const source = await readFile(join(runtime.configDir, 'semantic-layer/warehouse/mart_account_segments.yaml'), 'utf-8');
      expect(source).toContain('total_contract_arr_cents');
      expect(source).toContain('account_count');
      expect(deps.agentRunner.runLoop).toHaveBeenCalledWith(
        expect.objectContaining({
          modelRole: 'repair',
          telemetryTags: expect.objectContaining({
            operationName: 'ingest-isolated-diff-textual-resolver',
            unitKey: 'card-source',
          }),
        }),
      );
      const successReport = (deps.reports.create as any).mock.calls.at(-1)?.[0]?.body;
      expect(successReport.isolatedDiff).toMatchObject({
        acceptedPatches: 2,
        textualConflicts: 1,
        semanticConflicts: 0,
        resolverAttempts: 1,
        resolverRepairs: 1,
        resolverFailures: 0,
      });
      const trace = await readFile(join(runtime.configDir, '.ktx/ingest-traces/job-resolver-e2e/trace.jsonl'), 'utf-8');
      expect(trace).toContain('textual_conflict_resolver_repaired');
      expect(trace).toContain('patch_accepted_after_textual_resolution');
    } finally {
      await rm(runtime.homeDir, { recursive: true, force: true });
    }
  });

  it('prunes final wiki body refs before squash', async () => {
    const runtime = await makeRealGitRuntime();
    try {
      await mkdir(join(runtime.configDir, 'semantic-layer/warehouse'), { recursive: true });
      await mkdir(join(runtime.configDir, 'wiki/global'), { recursive: true });
      await writeFile(
        join(runtime.configDir, 'semantic-layer/warehouse/mart_account_segments.yaml'),
        'name: mart_account_segments\ngrain: [account_id]\ncolumns: [{name: account_id, type: string}]\njoins: []\nmeasures:\n  - name: total_contract_arr_cents\n    expr: sum(contract_arr)\n',
      );
      await writeFile(
        join(runtime.configDir, 'wiki/global/account-segments.md'),
        '---\nsummary: Account segments\nusage_mode: auto\n---\n\nExisting ARR uses `mart_account_segments.total_contract_arr_cents`.\n',
      );
      await runtime.git.commitFiles(
        ['semantic-layer/warehouse/mart_account_segments.yaml', 'wiki/global/account-segments.md'],
        'seed stale wiki body ref',
        'ktx Test',
        'system@ktx.local',
      );

      const { deps, adapter } = makeDeps(runtime);
      adapter.chunk.mockResolvedValue({
        workUnits: [{ unitKey: 'source-only', rawFiles: ['cards/source.json'], peerFileIndex: [], dependencyPaths: [] }],
      });

      let currentSession: any = null;
      deps.toolsetFactory.createIngestWuToolset = vi.fn((toolSession: any) => {
        currentSession = toolSession;
        return { toRuntimeTools: vi.fn(() => ({})) };
      });
      deps.agentRunner.runLoop = vi.fn(async (params: any) => {
        if (params.modelRole === 'reconcile') {
          return { stopReason: 'natural' as const };
        }

        const root = rootOfConfig(currentSession.configService, runtime.configDir);
        await writeFile(
          join(root, 'semantic-layer/warehouse/mart_account_segments.yaml'),
          'name: mart_account_segments\ngrain: [account_id]\ncolumns: [{name: account_id, type: string}]\njoins: []\nmeasures:\n  - name: total_contract_arr\n    expr: sum(contract_arr)\n',
        );
        addTouchedSlSource(currentSession.touchedSlSources, 'warehouse', 'mart_account_segments');
        currentSession.actions.push({
          target: 'sl',
          type: 'updated',
          key: 'mart_account_segments',
          detail: 'Rename ARR measure',
          targetConnectionId: 'warehouse',
          rawPaths: ['cards/source.json'],
        });
        await currentSession.gitService.commitFiles(
          ['semantic-layer/warehouse/mart_account_segments.yaml'],
          'wu source rename',
          'ktx Test',
          'system@ktx.local',
        );
        return { stopReason: 'natural' as const };
      }) as never;

      const runner = new IngestBundleRunner(deps);
      await mockStageRawFiles(runner, runtime, [['cards/source.json', 'h1']]);

      const result = await runner.run({
        jobId: 'job-final-gate-prune',
        connectionId: 'warehouse',
        sourceKey: 'metabase',
        trigger: 'upload',
        bundleRef: { kind: 'upload', uploadId: 'upload' },
      });

      expect(result.commitSha).toBeTruthy();
      await expect(readFile(join(runtime.configDir, 'wiki/global/account-segments.md'), 'utf-8')).resolves.not.toContain(
        'total_contract_arr_cents',
      );
      const reportCreate = vi.mocked(deps.reports.create).mock.calls.at(-1)?.[0] as any;
      expect(reportCreate.body.finalGatePrunedReferences).toContainEqual({
        kind: 'wiki_body_ref',
        artifact: 'wiki/global/account-segments',
        removedRef: 'mart_account_segments.total_contract_arr_cents',
        absentTarget: 'mart_account_segments.total_contract_arr_cents',
      });
      const trace = await readFile(
        join(runtime.configDir, '.ktx/ingest-traces/job-final-gate-prune/trace.jsonl'),
        'utf-8',
      );
      expect(trace).toContain('final_gate_reference_pruned');
      expect(trace).toContain('final_gate_prune_finished');
    } finally {
      await rm(runtime.homeDir, { recursive: true, force: true });
    }
  });
  it('runs finalization before wiki sl-ref repair and final gates', async () => {
    const runtime = await makeRealGitRuntime();
    try {
      const { deps, adapter } = makeDeps(runtime);
      adapter.chunk.mockResolvedValue({
        workUnits: [{ unitKey: 'wiki-page', rawFiles: ['cards/source.json'], peerFileIndex: [], dependencyPaths: [] }],
      });
      adapter.finalize = vi.fn(async ({ workdir }) => {
        await mkdir(join(workdir, 'semantic-layer/warehouse'), { recursive: true });
        await mkdir(join(workdir, 'wiki/global'), { recursive: true });
        await writeFile(
          join(workdir, 'semantic-layer/warehouse/mart_account_segments.yaml'),
          'name: mart_account_segments\ngrain: [account_id]\ncolumns: [{name: account_id, type: string}]\njoins: []\nmeasures:\n  - name: total_contract_arr\n    expr: sum(contract_arr)\n',
        );
        await writeFile(
          join(workdir, 'wiki/global/finalized-accounts.md'),
          '---\nsummary: Finalized accounts\nusage_mode: auto\nsl_refs:\n  - mart_account_segments\n  - missing_source\n---\n\nAccounts use `mart_account_segments.total_contract_arr`.\n',
        );
        return {
          warnings: [],
          errors: [],
          touchedSources: [{ connectionId: 'warehouse', sourceName: 'mart_account_segments' }],
          changedWikiPageKeys: ['finalized-accounts'],
          actions: [
            {
              target: 'sl',
              type: 'created',
              key: 'mart_account_segments',
              detail: 'Finalized accounts',
              targetConnectionId: 'warehouse',
              rawPaths: ['cards/source.json'],
            },
            {
              target: 'wiki',
              type: 'created',
              key: 'finalized-accounts',
              detail: 'Finalized wiki',
              rawPaths: ['cards/source.json'],
            },
          ],
        };
      });
      deps.agentRunner.runLoop = vi.fn(async () => ({ stopReason: 'natural' as const })) as never;
      const runner = new IngestBundleRunner(deps);
      await mockStageRawFiles(runner, runtime, [['cards/source.json', 'h1']]);

      await runner.run({
        jobId: 'job-finalization',
        connectionId: 'warehouse',
        sourceKey: 'metabase',
        trigger: 'upload',
        bundleRef: { kind: 'upload', uploadId: 'upload' },
      });

      const trace = await readFile(
        join(runtime.configDir, '.ktx/ingest-traces/job-finalization/trace.jsonl'),
        'utf-8',
      );
      expect(trace.indexOf('finalization_committed')).toBeLessThan(trace.indexOf('wiki_sl_refs_repaired'));
      expect(trace.indexOf('wiki_sl_refs_repaired')).toBeLessThan(trace.indexOf('final_artifact_gates'));
      await expect(readFile(join(runtime.configDir, 'wiki/global/finalized-accounts.md'), 'utf-8')).resolves.toContain(
        'sl_refs:\n  - mart_account_segments',
      );
    } finally {
      await rm(runtime.homeDir, { recursive: true, force: true });
    }
  });

  it('fails when finalization edits a path already changed earlier in the run', async () => {
    const runtime = await makeRealGitRuntime();
    try {
      const { deps, adapter } = makeDeps(runtime);
      adapter.chunk.mockResolvedValue({
        workUnits: [{ unitKey: 'wiki-page', rawFiles: ['cards/source.json'], peerFileIndex: [], dependencyPaths: [] }],
      });
      let currentSession: any = null;
      deps.toolsetFactory.createIngestWuToolset = vi.fn((toolSession: any) => {
        currentSession = toolSession;
        return { toRuntimeTools: vi.fn(() => ({})) };
      });
      deps.agentRunner.runLoop = vi.fn(async () => {
        const root = rootOfConfig(currentSession.configService, runtime.configDir);
        await mkdir(join(root, 'wiki/global'), { recursive: true });
        await writeFile(
          join(root, 'wiki/global/orders.md'),
          '---\nsummary: Orders\nusage_mode: auto\n---\n\nWU body\n',
        );
        currentSession.actions.push({
          target: 'wiki',
          type: 'created',
          key: 'orders',
          detail: 'WU orders',
          rawPaths: ['cards/source.json'],
        });
        await currentSession.gitService.commitFiles(
          ['wiki/global/orders.md'],
          'wu orders',
          'ktx Test',
          'system@ktx.local',
        );
        return { stopReason: 'natural' as const };
      }) as never;
      adapter.finalize = vi.fn(async ({ workdir }) => {
        await writeFile(
          join(workdir, 'wiki/global/orders.md'),
          '---\nsummary: Orders\nusage_mode: auto\n---\n\nFinalized body\n',
        );
        return {
          warnings: [],
          errors: [],
          touchedSources: [],
          changedWikiPageKeys: ['orders'],
          actions: [{ target: 'wiki', type: 'updated', key: 'orders', detail: 'Conflicting finalization' }],
        };
      });
      const runner = new IngestBundleRunner(deps);
      await mockStageRawFiles(runner, runtime, [['cards/source.json', 'h1']]);

      await expect(
        runner.run({
          jobId: 'job-finalization-overlap',
          connectionId: 'warehouse',
          sourceKey: 'metabase',
          trigger: 'upload',
          bundleRef: { kind: 'upload', uploadId: 'upload' },
        }),
      ).rejects.toThrow(/finalization modified path\(s\) already changed earlier in this run: wiki\/global\/orders\.md/);
    } finally {
      await rm(runtime.homeDir, { recursive: true, force: true });
    }
  });

  it('rejects finalization writes to unauthorized semantic-layer targets', async () => {
    const runtime = await makeRealGitRuntime();
    try {
      const { deps, adapter } = makeDeps(runtime);
      adapter.chunk.mockResolvedValue({ workUnits: [] });
      adapter.finalize = vi.fn(async ({ workdir }) => {
        await mkdir(join(workdir, 'semantic-layer/other-warehouse'), { recursive: true });
        await writeFile(
          join(workdir, 'semantic-layer/other-warehouse/orders.yaml'),
          'name: orders\ngrain: [order_id]\ncolumns: [{name: order_id, type: string}]\njoins: []\nmeasures: []\n',
        );
        return {
          warnings: [],
          errors: [],
          touchedSources: [{ connectionId: 'other-warehouse', sourceName: 'orders' }],
          changedWikiPageKeys: [],
          actions: [
            {
              target: 'sl',
              type: 'created',
              key: 'orders',
              targetConnectionId: 'other-warehouse',
              detail: 'Forbidden target',
              rawPaths: ['cards/source.json'],
            },
          ],
        };
      });
      const runner = new IngestBundleRunner(deps);
      await mockStageRawFiles(runner, runtime, [['cards/source.json', 'h1']]);

      await expect(
        runner.run({
          jobId: 'job-finalization-target-policy',
          connectionId: 'warehouse',
          sourceKey: 'metabase',
          trigger: 'upload',
          bundleRef: { kind: 'upload', uploadId: 'upload' },
        }),
      ).rejects.toThrow(/semantic-layer target connection not allowed/);
      const trace = await readFile(
        join(runtime.configDir, '.ktx/ingest-traces/job-finalization-target-policy/trace.jsonl'),
        'utf-8',
      );
      // The policy check runs inside finalization, before touched-source
      // derivation — an out-of-scope write fails the finalization stage
      // instead of reading as committed.
      expect(trace).not.toContain('finalization_committed');
      expect(trace).toContain('semantic_layer_target_policy_failed');
      expect(trace).toContain('ingest_failed');
    } finally {
      await rm(runtime.homeDir, { recursive: true, force: true });
    }
  });
});
