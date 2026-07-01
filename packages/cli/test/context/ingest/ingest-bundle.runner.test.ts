import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { addTouchedSlSource } from '../../../src/context/tools/touched-sl-sources.js';
import { IngestBundleRunner } from '../../../src/context/ingest/ingest-bundle.runner.js';
import { createMemoryFlowLiveBuffer } from '../../../src/context/ingest/memory-flow/live-buffer.js';
import type { MemoryFlowReplayInput } from '../../../src/context/ingest/memory-flow/types.js';
import type { IngestBundleRunnerDeps } from '../../../src/context/ingest/ports.js';

class TestJobContext {
  private currentProgress = 0;

  constructor(
    public readonly jobId: string,
    public readonly userId: string | null | undefined,
    public readonly checkCancellation: () => Promise<void>,
    private readonly updateProgressFn: (progress: number, message?: string) => Promise<void>,
    private readonly parent?: TestJobContext,
    private readonly start = 0,
    private readonly span = 1,
  ) {}

  async updateProgress(progress: number, message?: string): Promise<void> {
    const local = Math.max(0, Math.min(1, progress));
    this.currentProgress = local;
    if (this.parent) {
      await this.parent.updateProgress(Math.max(0, Math.min(1, this.start + this.span * local)), message);
      return;
    }
    await this.updateProgressFn(local, message);
  }

  startPhase(fraction: number): TestJobContext {
    return new TestJobContext(
      this.jobId,
      this.userId,
      this.checkCancellation,
      this.updateProgressFn,
      this,
      this.currentProgress,
      Math.max(0, Math.min(1, fraction)),
    );
  }
}

const deferred = <T>() => {
  let resolve!: (v: T) => void;
  const promise = new Promise<T>((r) => {
    resolve = r;
  });
  return { promise, resolve };
};

function bundleReplayInput(): MemoryFlowReplayInput {
  return {
    runId: 'pending',
    connectionId: 'c1',
    adapter: 'fake',
    status: 'running',
    sourceDir: '/tmp/stage/upload-x',
    syncId: 'pending',
    errors: [],
    events: [],
    plannedWorkUnits: [],
    details: { actions: [], provenance: [], transcripts: [] },
  };
}

const makeDeps = () => {
  const runsRepo = {
    create: vi.fn().mockResolvedValue({ id: 'run-1' }),
    findMostRecentCompleted: vi.fn().mockResolvedValue(null),
    markFailed: vi.fn(),
    markCompleted: vi.fn(),
  };
  const provenanceRepo = {
    insertMany: vi.fn(),
    findHashesBySync: vi.fn().mockResolvedValue(new Map()),
    findLatestArtifactsForRawPaths: vi.fn().mockResolvedValue(new Map()),
  };
  const reportsRepo = {
    create: vi.fn().mockResolvedValue({ id: 'report-1' }),
    findByJobId: vi.fn().mockResolvedValue(null),
    markSuperseded: vi.fn().mockResolvedValue(undefined),
  };
  const canonicalPins = {
    listPins: vi.fn().mockResolvedValue([]),
  };
  const adapter = {
    source: 'fake',
    skillNames: [] as string[],
    reconcileSkillNames: undefined as undefined | string[],
    evidenceIndexing: undefined as undefined | 'documents',
    triageSupported: undefined as undefined | boolean,
    detect: vi.fn().mockResolvedValue(true),
    listTargetConnectionIds: undefined as undefined | ((stagedDir: string) => Promise<string[]>),
    finalize: undefined as any,
    chunk: vi.fn().mockResolvedValue({
      workUnits: [{ unitKey: 'u1', rawFiles: ['a.yml'], peerFileIndex: [], dependencyPaths: [] }],
    }),
  };
  const registry = { get: vi.fn().mockReturnValue(adapter) };
  const diffSetService = {
    compute: vi.fn().mockResolvedValue({ added: ['a.yml'], modified: [], deleted: [], unchanged: [] }),
  };
  const contextEvidenceIndex = {
    indexStagedDir: vi.fn().mockResolvedValue({
      documentsIndexed: 1,
      chunksIndexed: 1,
      documentsDeleted: 0,
      embeddingFailures: 0,
      warnings: [],
    }),
    publishSync: vi.fn().mockResolvedValue(undefined),
  };
  const pageTriage = {
    triageRun: vi.fn().mockResolvedValue({
      enabled: true,
      fullRawPaths: new Set(['a.yml']),
      warnings: [],
    }),
  };
  const scopedGit = {
    revParseHead: vi.fn().mockResolvedValue('h'),
    commitFiles: vi.fn().mockResolvedValue({ created: true, commitHash: 'h' }),
    commitStaged: vi.fn().mockResolvedValue({ created: false, commitHash: 'h' }),
    resetHardTo: vi.fn(),
    assertWorktreeClean: vi.fn().mockResolvedValue(undefined),
    writeBinaryNoRenamePatch: vi.fn(async (_base: string, _head: string, patchPath: string) => {
      await writeFile(patchPath, '', 'utf-8');
    }),
    applyPatchFile3WayIndex: vi.fn(),
    diffNameStatus: vi.fn().mockResolvedValue([]),
    changedPaths: vi.fn().mockResolvedValue([]),
  };
  const sessionWorktreeService = {
    create: vi.fn().mockResolvedValue({
      chatId: 'j1',
      workdir: '/tmp/wt',
      branch: 'session/j1',
      baseSha: 'b',
      createdAt: new Date(),
      git: scopedGit,
      config: {},
    }),
    cleanup: vi.fn(),
  };
  const agentRunner = { runLoop: vi.fn().mockResolvedValue({ stopReason: 'natural' }) };
  const gitService = {
    revParseHead: vi.fn().mockResolvedValue('base'),
    listFilesAtHead: vi.fn().mockResolvedValue([]),
    getFileAtCommit: vi.fn(),
    squashMergeIntoMain: vi
      .fn()
      .mockResolvedValue({ ok: true, squashSha: 'sq', touchedPaths: ['raw-sources/c1/fake/s/a.yml'] }),
  };
  const lockingService = {
    withLock: vi.fn().mockImplementation(async (_k: string, fn: () => Promise<unknown>) => fn()),
  };
  const appSettingsService = {
    settings: {
      ai: { slValidation: { probeRowCount: 1 } },
      llm: { memoryIngestionModel: 'test-model' },
    },
  };
  const skillsRegistry = {
    listSkills: vi.fn().mockResolvedValue([]),
    getSkill: vi.fn().mockResolvedValue(null),
    buildSkillsPrompt: vi.fn().mockReturnValue(''),
    stripFrontmatter: vi.fn().mockImplementation((s: string) => s),
  };
  const promptService = {
    loadPrompt: vi.fn().mockResolvedValue('base-framing'),
  };
  const wikiService = {
    forWorktree: vi.fn(),
    listPageKeys: vi.fn().mockResolvedValue([]),
    readPage: vi.fn().mockResolvedValue(null),
    syncFromCommit: vi.fn().mockResolvedValue(undefined),
  };
  wikiService.forWorktree.mockReturnValue(wikiService);
  const knowledgeSlRefs = {
    syncFromWiki: vi.fn().mockResolvedValue({ inserted: 1, deleted: 0 }),
  };
  const knowledgeIndex = {
    listPagesForUser: vi.fn().mockResolvedValue([]),
  };
  const semanticLayerService = {
    forWorktree: vi.fn(),
    listFilesForConnection: vi
      .fn()
      .mockImplementation((connectionId: string) =>
        Promise.resolve(connectionId === 'warehouse-2' ? ['looker__orders.yaml'] : []),
      ),
    loadAllSources: vi
      .fn()
      .mockImplementation((connectionId: string) =>
        Promise.resolve({
          sources: connectionId === 'warehouse-2' ? [{ name: 'looker__orders' }] : [],
          loadErrors: [],
        }),
      ),
  };
  semanticLayerService.forWorktree.mockReturnValue(semanticLayerService);
  const slSearchService = {
    indexSources: vi.fn().mockResolvedValue(undefined),
  };
  const slSourcesRepository = {};
  const slValidator = { validateSingleSource: vi.fn().mockResolvedValue({ errors: [], warnings: [] }) };
  const toolsetFactory = {
    createIngestWuToolset: vi.fn().mockReturnValue({
      toRuntimeTools: vi.fn().mockReturnValue({}),
      getAllTools: vi.fn().mockReturnValue([]),
      getToolNames: vi.fn().mockReturnValue([]),
    }),
  };
  const configService = {
    enqueueCommitMessageJobForExternalCommit: vi.fn().mockResolvedValue(undefined),
  };
  const contentCache = {
    findCompletedResult: vi.fn().mockResolvedValue(null),
    findLatestCompletedResult: vi.fn().mockResolvedValue(null),
    saveCompletedResult: vi.fn().mockResolvedValue(undefined),
    saveFailedResult: vi.fn().mockResolvedValue(undefined),
    deleteResult: vi.fn().mockResolvedValue(undefined),
    listRunResults: vi.fn().mockResolvedValue([]),
  };
  return {
    runsRepo,
    provenanceRepo,
    reportsRepo,
    canonicalPins,
    contentCache,
    adapter,
    registry,
    diffSetService,
    contextEvidenceIndex,
    pageTriage,
    sessionWorktreeService,
    agentRunner,
    gitService,
    lockingService,
    slValidator,
    appSettingsService,
    skillsRegistry,
    promptService,
    wikiService,
    knowledgeSlRefs,
    knowledgeIndex,
    semanticLayerService,
    slSearchService,
    slSourcesRepository,
    toolsetFactory,
    configService,
  };
};

const buildRunner = (deps: ReturnType<typeof makeDeps> = makeDeps(), overrides: Partial<IngestBundleRunnerDeps> = {}) =>
  new IngestBundleRunner({
    runs: deps.runsRepo as any,
    provenance: deps.provenanceRepo as any,
    registry: deps.registry as any,
    diffSetService: deps.diffSetService as any,
    contextEvidenceIndex: deps.contextEvidenceIndex,
    pageTriage: deps.pageTriage as any,
    sessionWorktreeService: deps.sessionWorktreeService as any,
    agentRunner: deps.agentRunner as any,
    gitService: deps.gitService as any,
    lockingService: deps.lockingService as any,
    storage: {
      homeDir: '/tmp/ktx-test',
      systemGitAuthor: { name: 'ktx Test', email: 'system@ktx.local' },
      resolveUploadDir: (uploadId) => `/tmp/ktx-test/ingest-uploads/${uploadId}`,
      resolvePullDir: (jobId) => `/tmp/ktx-test/ingest-pulls/${jobId}`,
      resolveTranscriptDir: (jobId) => `/tmp/ktx-test/run/wu-transcripts/${jobId}`,
      resolveTracePath: (jobId) => `/tmp/ktx-test/ingest-traces/${jobId}/trace.jsonl`,
    },
    settings: {
      probeRowCount: 1,
      memoryIngestionModel: 'test-model',
      cliVersion: '0.0.0-test',
    },
    skillsRegistry: deps.skillsRegistry as any,
    promptService: deps.promptService as any,
    wikiService: deps.wikiService as any,
    knowledgeSlRefs: deps.knowledgeSlRefs as any,
    knowledgeIndex: deps.knowledgeIndex,
    semanticLayerService: deps.semanticLayerService as any,
    slSearchService: deps.slSearchService as any,
    slSourcesRepository: deps.slSourcesRepository as any,
    connections: {
      listEnabledConnections: vi.fn().mockResolvedValue([]),
      getConnectionById: vi.fn().mockResolvedValue({ id: 'c1', name: 'warehouse', connectionType: 'POSTGRES' }),
      executeQuery: vi.fn().mockResolvedValue({ headers: [], rows: [] }),
    },
    reports: deps.reportsRepo as any,
    canonicalPins: deps.canonicalPins,
    contentCache: deps.contentCache,
    slValidator: deps.slValidator as any,
    toolsetFactory: deps.toolsetFactory as any,
    commitMessages: {
      enqueueForExternalCommit: deps.configService.enqueueCommitMessageJobForExternalCommit,
    },
    embedding: {
      maxBatchSize: 10,
      computeEmbedding: async () => [0],
      computeEmbeddingsBulk: async (texts: string[]) => texts.map(() => [0]),
    },
    ...overrides,
  });

describe('IngestBundleRunner — FIFO-per-connection', () => {
  let spy: any;

  beforeEach(() => {
    spy = vi.fn();
  });

  it('serializes two jobs on the same connectionId', async () => {
    const runner = buildRunner();
    (runner as any).runInner = async (job: any) => {
      spy(job.jobId);
      await new Promise((r) => setTimeout(r, 5));
      spy(`done-${job.jobId}`);
      return {
        runId: 'r',
        syncId: 's',
        diffSummary: { added: 0, modified: 0, deleted: 0, unchanged: 0 },
        workUnitCount: 0,
        failedWorkUnits: [],
        artifactsWritten: 0,
        commitSha: null,
      };
    };
    const p1 = runner.run({
      jobId: 'j1',
      connectionId: 'c1',
      sourceKey: 'fake',
      trigger: 'upload',
      bundleRef: { kind: 'upload', uploadId: 'u1' },
    });
    const p2 = runner.run({
      jobId: 'j2',
      connectionId: 'c1',
      sourceKey: 'fake',
      trigger: 'upload',
      bundleRef: { kind: 'upload', uploadId: 'u2' },
    });
    await Promise.all([p1, p2]);
    expect(spy.mock.calls.map((c: unknown[]) => c[0])).toEqual(['j1', 'done-j1', 'j2', 'done-j2']);
  });

  it('runs jobs on different connections in parallel', async () => {
    const runner = buildRunner();
    const d1 = deferred<void>();
    const d2 = deferred<void>();
    (runner as any).runInner = async (job: any) => {
      spy(`start-${job.jobId}`);
      if (job.jobId === 'j1') {
        await d1.promise;
      }
      if (job.jobId === 'j2') {
        await d2.promise;
      }
      return {
        runId: 'r',
        syncId: 's',
        diffSummary: { added: 0, modified: 0, deleted: 0, unchanged: 0 },
        workUnitCount: 0,
        failedWorkUnits: [],
        artifactsWritten: 0,
        commitSha: null,
      };
    };
    const p1 = runner.run({
      jobId: 'j1',
      connectionId: 'c1',
      sourceKey: 'fake',
      trigger: 'upload',
      bundleRef: { kind: 'upload', uploadId: 'u1' },
    });
    const p2 = runner.run({
      jobId: 'j2',
      connectionId: 'c2',
      sourceKey: 'fake',
      trigger: 'upload',
      bundleRef: { kind: 'upload', uploadId: 'u2' },
    });
    await new Promise((r) => setTimeout(r, 10));
    expect(spy.mock.calls.map((c: unknown[]) => c[0]).sort()).toEqual(['start-j1', 'start-j2']);
    d1.resolve();
    d2.resolve();
    await Promise.all([p1, p2]);
  });
});

describe('IngestBundleRunner — Stages 1 → 7', () => {
  it('runs the full pipeline, creates a run row, stages files, chunks, squashes, writes provenance', async () => {
    const deps = makeDeps();
    const runner = buildRunner(deps);
    (runner as any).stageRawFilesStage1 = vi.fn().mockResolvedValue({
      currentHashes: new Map([['a.yml', 'h1']]),
      rawDirInWorktree: 'raw-sources/c1/fake/s',
    });
    (runner as any).resolveStagedDir = vi.fn().mockResolvedValue('/tmp/stage/upload-x');

    const result = await runner.run({
      jobId: 'j1',
      connectionId: 'c1',
      sourceKey: 'fake',
      trigger: 'upload',
      bundleRef: { kind: 'upload', uploadId: 'upload-x' },
    });

    expect(deps.runsRepo.create).toHaveBeenCalledWith(
      expect.objectContaining({ jobId: 'j1', connectionId: 'c1', sourceKey: 'fake', trigger: 'upload' }),
    );
    expect(deps.adapter.detect).toHaveBeenCalled();
    expect(deps.adapter.chunk).toHaveBeenCalled();
    expect(result.workUnitCount).toBe(1);
    expect(deps.diffSetService.compute).toHaveBeenCalled();
    expect(deps.gitService.squashMergeIntoMain).toHaveBeenCalledWith(
      'session/j1',
      expect.any(String),
      expect.any(String),
      expect.stringContaining('ingest(fake): j1'),
    );
    expect(deps.provenanceRepo.insertMany).toHaveBeenCalled();
    expect(result.commitSha).toBe('sq');
    expect(deps.runsRepo.markCompleted).toHaveBeenCalledWith('run-1', expect.any(Object), 'completed');
    // Single touched path → path-scoped diff for the LLM commit-message note.
    expect(deps.configService.enqueueCommitMessageJobForExternalCommit).toHaveBeenCalledWith(
      { commitHash: 'sq' },
      expect.stringContaining('ingest(fake): j1'),
      'raw-sources/c1/fake/s/a.yml',
    );
  });

  it('uses the rate-limit governor for work-unit start slots', async () => {
    const deps = makeDeps();
    const acquireWorkSlot = vi.fn(async () => vi.fn());
    const runner = buildRunner(deps, {
      settings: {
        probeRowCount: 1,
        memoryIngestionModel: 'test-model',
        cliVersion: '0.0.0-test',
        workUnitMaxConcurrency: 2,
        rateLimitGovernor: { acquireWorkSlot, subscribe: vi.fn(() => vi.fn()) } as never,
      },
    });
    deps.adapter.chunk.mockResolvedValue({
      workUnits: [
        { unitKey: 'u1', rawFiles: ['a.yml'], peerFileIndex: [], dependencyPaths: [] },
        { unitKey: 'u2', rawFiles: ['b.yml'], peerFileIndex: [], dependencyPaths: [] },
      ],
    });
    (runner as any).stageRawFilesStage1 = vi.fn().mockResolvedValue({
      currentHashes: new Map([
        ['a.yml', 'h1'],
        ['b.yml', 'h2'],
      ]),
      rawDirInWorktree: 'raw-sources/c1/fake/s',
    });
    (runner as any).resolveStagedDir = vi.fn().mockResolvedValue('/tmp/stage/upload-x');

    await runner.run({
      jobId: 'j1',
      connectionId: 'c1',
      sourceKey: 'fake',
      trigger: 'upload',
      bundleRef: { kind: 'upload', uploadId: 'upload-x' },
    });

    expect(acquireWorkSlot).toHaveBeenCalledTimes(2);
  });

  it('passes the job abort signal into rate-limit work-unit slots', async () => {
    const deps = makeDeps();
    const controller = new AbortController();
    const acquireWorkSlot = vi.fn(async () => vi.fn());
    const runner = buildRunner(deps, {
      settings: {
        probeRowCount: 1,
        memoryIngestionModel: 'test-model',
        cliVersion: '0.0.0-test',
        workUnitMaxConcurrency: 1,
        rateLimitGovernor: { acquireWorkSlot, subscribe: vi.fn(() => vi.fn()) } as never,
      },
    });
    (runner as any).stageRawFilesStage1 = vi.fn().mockResolvedValue({
      currentHashes: new Map([['a.yml', 'h1']]),
      rawDirInWorktree: 'raw-sources/c1/fake/s',
    });
    (runner as any).resolveStagedDir = vi.fn().mockResolvedValue('/tmp/stage/upload-x');

    await runner.run(
      {
        jobId: 'j1',
        connectionId: 'c1',
        sourceKey: 'fake',
        trigger: 'upload',
        bundleRef: { kind: 'upload', uploadId: 'upload-x' },
      },
      { jobId: 'j1', abortSignal: controller.signal, startPhase: () => new TestJobContext('j1', null, async () => undefined, async () => undefined) } as any,
    );

    expect(acquireWorkSlot).toHaveBeenCalledWith(controller.signal);
  });

  it('does not convert aborted work-unit agent loops into failed work units', async () => {
    const deps = makeDeps();
    const controller = new AbortController();
    deps.agentRunner.runLoop.mockImplementation(async () => {
      controller.abort();
      throw new DOMException('Aborted', 'AbortError');
    });
    const runner = buildRunner(deps, {
      settings: {
        probeRowCount: 1,
        memoryIngestionModel: 'test-model',
        cliVersion: '0.0.0-test',
        workUnitMaxConcurrency: 1,
      },
    });
    (runner as any).stageRawFilesStage1 = vi.fn().mockResolvedValue({
      currentHashes: new Map([['a.yml', 'h1']]),
      rawDirInWorktree: 'raw-sources/c1/fake/s',
    });
    (runner as any).resolveStagedDir = vi.fn().mockResolvedValue('/tmp/stage/upload-x');

    await expect(
      runner.run(
        {
          jobId: 'j1',
          connectionId: 'c1',
          sourceKey: 'fake',
          trigger: 'upload',
          bundleRef: { kind: 'upload', uploadId: 'upload-x' },
        },
        { jobId: 'j1', abortSignal: controller.signal, startPhase: () => new TestJobContext('j1', null, async () => undefined, async () => undefined) } as any,
      ),
    ).rejects.toThrow(/Aborted/);

    expect(deps.runsRepo.markFailed).toHaveBeenCalledWith('run-1');
    expect(deps.reportsRepo.create).not.toHaveBeenCalledWith(
      expect.objectContaining({
        body: expect.objectContaining({
          failedWorkUnits: expect.arrayContaining(['u1']),
        }),
      }),
    );
  });

  it('emits trace and memory-flow status for rate-limit waits', async () => {
    const deps = makeDeps();
    let subscriber: ((state: any) => void) | undefined;
    const memoryFlow = createMemoryFlowLiveBuffer(bundleReplayInput());
    const runner = buildRunner(deps, {
      settings: {
        probeRowCount: 1,
        memoryIngestionModel: 'test-model',
        cliVersion: '0.0.0-test',
        rateLimitGovernor: {
          acquireWorkSlot: vi.fn(async () => vi.fn()),
          subscribe: vi.fn((cb: (state: any) => void) => {
            subscriber = cb;
            return vi.fn();
          }),
        } as never,
      },
    });
    (runner as any).runInner = async (_job: any, ctx: any) => {
      subscriber?.({
        kind: 'wait_tick',
        provider: 'claude-subscription',
        rateLimitType: 'five_hour',
        resumeAtMs: 2_000,
        remainingMs: 1_000,
      });
      ctx.memoryFlow.emit({ type: 'report_created', runId: 'run-1' });
      return {
        runId: 'run-1',
        syncId: 'sync-1',
        diffSummary: { added: 0, modified: 0, deleted: 0, unchanged: 0 },
        workUnitCount: 0,
        failedWorkUnits: [],
        artifactsWritten: 0,
        commitSha: null,
      };
    };

    await runner.run(
      {
        jobId: 'j1',
        connectionId: 'c1',
        sourceKey: 'fake',
        trigger: 'upload',
        bundleRef: { kind: 'upload', uploadId: 'upload-x' },
      },
      { memoryFlow } as any,
    );

    expect(memoryFlow.snapshot().events).toContainEqual(
      expect.objectContaining({
        type: 'rate_limit_wait',
        provider: 'claude-subscription',
        rateLimitType: 'five_hour',
        resumeAtMs: 2_000,
        remainingMs: 1_000,
      }),
    );
  });

  it('fails before squash when reconciliation leaves a touched wiki page with dangling refs', async () => {
    const deps = makeDeps();
    let currentToolSession: any = null;
    const scopedWiki = {
      listPageKeys: vi.fn().mockResolvedValue(['page-a']),
      readPage: vi.fn().mockImplementation((_scope: string, _scopeId: string | null, key: string) => {
        if (key === 'page-a') {
          return Promise.resolve({
            pageKey: 'page-a',
            frontmatter: { summary: 'Page A', usage_mode: 'auto', refs: ['missing-page'] },
            content: 'See [[missing-page]].',
          });
        }
        return Promise.resolve(null);
      }),
    };
    deps.wikiService.forWorktree.mockReturnValue(scopedWiki);
    deps.toolsetFactory.createIngestWuToolset.mockImplementation((toolSession: any) => {
      currentToolSession = toolSession;
      return {
        toRuntimeTools: vi.fn().mockReturnValue({}),
        getAllTools: vi.fn().mockReturnValue([]),
        getToolNames: vi.fn().mockReturnValue([]),
      };
    });
    deps.agentRunner.runLoop.mockImplementation(async (params: any) => {
      if (params.telemetryTags.operationName === 'ingest-bundle-wu') {
        currentToolSession.actions.push({ target: 'sl', type: 'updated', key: 'orders', detail: 'Orders source' });
      }
      if (params.telemetryTags.operationName === 'ingest-bundle-reconcile') {
        currentToolSession.actions.push({ target: 'wiki', type: 'created', key: 'page-a', detail: 'Page A' });
      }
      return { stopReason: 'natural' };
    });

    const runner = buildRunner(deps);
    (runner as any).stageRawFilesStage1 = vi.fn().mockResolvedValue({
      currentHashes: new Map([['a.yml', 'h1']]),
      rawDirInWorktree: 'raw-sources/c1/fake/s',
    });
    (runner as any).resolveStagedDir = vi.fn().mockResolvedValue('/tmp/stage/upload-x');

    await expect(
      runner.run({
        jobId: 'j1',
        connectionId: 'c1',
        sourceKey: 'fake',
        trigger: 'upload',
        bundleRef: { kind: 'upload', uploadId: 'upload-x' },
      }),
    ).rejects.toThrow(/wiki references target missing page\(s\): page-a -> missing-page/);

    expect(deps.runsRepo.markFailed).toHaveBeenCalledWith('run-1');
    expect(deps.gitService.squashMergeIntoMain).not.toHaveBeenCalled();
  });

  it('allows reconciliation to save circular wiki refs once both pages exist', async () => {
    const deps = makeDeps();
    let currentToolSession: any = null;
    const scopedWiki = {
      listPageKeys: vi.fn().mockResolvedValue(['page-a', 'page-b']),
      readPage: vi.fn().mockImplementation((_scope: string, _scopeId: string | null, key: string) => {
        if (key === 'page-a') {
          return Promise.resolve({
            pageKey: 'page-a',
            frontmatter: { summary: 'Page A', usage_mode: 'auto', refs: ['page-b'] },
            content: 'See [[page-b]].',
          });
        }
        if (key === 'page-b') {
          return Promise.resolve({
            pageKey: 'page-b',
            frontmatter: { summary: 'Page B', usage_mode: 'auto', refs: ['page-a'] },
            content: 'See [[page-a]].',
          });
        }
        return Promise.resolve(null);
      }),
    };
    deps.wikiService.forWorktree.mockReturnValue(scopedWiki);
    deps.toolsetFactory.createIngestWuToolset.mockImplementation((toolSession: any) => {
      currentToolSession = toolSession;
      return {
        toRuntimeTools: vi.fn().mockReturnValue({}),
        getAllTools: vi.fn().mockReturnValue([]),
        getToolNames: vi.fn().mockReturnValue([]),
      };
    });
    deps.agentRunner.runLoop.mockImplementation(async (params: any) => {
      if (params.telemetryTags.operationName === 'ingest-bundle-wu') {
        currentToolSession.actions.push({ target: 'sl', type: 'updated', key: 'orders', detail: 'Orders source' });
      }
      if (params.telemetryTags.operationName === 'ingest-bundle-reconcile') {
        currentToolSession.actions.push(
          { target: 'wiki', type: 'created', key: 'page-a', detail: 'Page A' },
          { target: 'wiki', type: 'created', key: 'page-b', detail: 'Page B' },
        );
      }
      return { stopReason: 'natural' };
    });

    const runner = buildRunner(deps);
    (runner as any).stageRawFilesStage1 = vi.fn().mockResolvedValue({
      currentHashes: new Map([['a.yml', 'h1']]),
      rawDirInWorktree: 'raw-sources/c1/fake/s',
    });
    (runner as any).resolveStagedDir = vi.fn().mockResolvedValue('/tmp/stage/upload-x');

    const result = await runner.run({
      jobId: 'j1',
      connectionId: 'c1',
      sourceKey: 'fake',
      trigger: 'upload',
      bundleRef: { kind: 'upload', uploadId: 'upload-x' },
    });

    expect(result.failedWorkUnits).toEqual([]);
    expect(deps.gitService.squashMergeIntoMain).toHaveBeenCalled();
    expect(deps.runsRepo.markFailed).not.toHaveBeenCalled();
  });

  it('threads target warehouse connection names into WorkUnit and reconcile tool sessions', async () => {
    const deps = makeDeps();
    const sessions: any[] = [];
    deps.adapter.listTargetConnectionIds = vi.fn().mockResolvedValue(['warehouse']);
    deps.toolsetFactory.createIngestWuToolset.mockImplementation((toolSession: any) => {
      sessions.push(toolSession);
      return {
        toRuntimeTools: vi.fn().mockReturnValue({}),
        getAllTools: vi.fn().mockReturnValue([]),
        getToolNames: vi.fn().mockReturnValue([]),
      };
    });
    deps.agentRunner.runLoop.mockResolvedValue({ stopReason: 'natural' });

    const runner = buildRunner(deps);
    (runner as any).stageRawFilesStage1 = vi.fn().mockResolvedValue({
      currentHashes: new Map([['a.yml', 'h1']]),
      rawDirInWorktree: 'raw-sources/notion/fake/s',
    });
    (runner as any).resolveStagedDir = vi.fn().mockResolvedValue('/tmp/stage/upload-x');

    await runner.run({
      jobId: 'j1',
      connectionId: 'notion',
      sourceKey: 'fake',
      trigger: 'upload',
      bundleRef: { kind: 'upload', uploadId: 'upload-x' },
    });

    expect([...sessions[0].allowedConnectionNames].sort()).toEqual(['notion', 'warehouse']);
  });

  it('reuses document evidence indexing and page triage for document WorkUnits', async () => {
    const deps = makeDeps();
    deps.adapter.source = 'notion';
    deps.adapter.skillNames = ['notion_synthesize'];
    deps.adapter.reconcileSkillNames = [];
    deps.adapter.evidenceIndexing = 'documents';
    deps.adapter.triageSupported = true;
    deps.adapter.chunk.mockResolvedValue({
      workUnits: [
        { unitKey: 'full', rawFiles: ['pages/full/metadata.json'], dependencyPaths: [], peerFileIndex: [] },
        { unitKey: 'skip', rawFiles: ['pages/skip/metadata.json'], dependencyPaths: [], peerFileIndex: [] },
      ],
    });
    deps.diffSetService.compute.mockResolvedValue({
      added: ['pages/full/metadata.json', 'pages/skip/metadata.json'],
      modified: [],
      deleted: [],
      unchanged: [],
    });
    deps.pageTriage.triageRun.mockResolvedValue({
      enabled: true,
      fullRawPaths: new Set(['pages/full/metadata.json']),
      warnings: [],
    });
    const runner = buildRunner(deps);
    (runner as any).stageRawFilesStage1 = vi.fn().mockResolvedValue({
      currentHashes: new Map([
        ['pages/full/metadata.json', 'h-full'],
        ['pages/skip/metadata.json', 'h-skip'],
      ]),
      rawDirInWorktree: 'raw-sources/c1/notion/s',
    });
    (runner as any).resolveStagedDir = vi.fn().mockResolvedValue('/tmp/stage/upload-x');

    const result = await runner.run({
      jobId: 'j1',
      connectionId: 'c1',
      sourceKey: 'notion',
      trigger: 'upload',
      bundleRef: { kind: 'upload', uploadId: 'upload-x' },
    });

    const workUnitCalls = deps.agentRunner.runLoop.mock.calls.filter(
      ([params]) => params.telemetryTags?.operationName === 'ingest-bundle-wu',
    );
    expect(deps.contextEvidenceIndex.indexStagedDir).toHaveBeenCalled();
    expect(deps.pageTriage.triageRun).toHaveBeenCalled();
    expect(workUnitCalls).toHaveLength(1);
    expect(workUnitCalls[0][0].telemetryTags.unitKey).toBe('full');
    expect(result.workUnitCount).toBe(1);
  });

  it('emits memory-flow source and planning events for bundle ingest', async () => {
    const deps = makeDeps();
    deps.adapter.chunk.mockResolvedValue({
      workUnits: [
        {
          unitKey: 'u1',
          rawFiles: ['a.yml'],
          peerFileIndex: ['peer.yml'],
          dependencyPaths: ['manifest.yml'],
        },
      ],
      eviction: { deletedRawPaths: ['old.yml'] },
    });
    const runner = buildRunner(deps);
    (runner as any).stageRawFilesStage1 = vi.fn().mockResolvedValue({
      currentHashes: new Map([['a.yml', 'h1']]),
      rawDirInWorktree: 'raw-sources/c1/fake/s',
    });
    (runner as any).resolveStagedDir = vi.fn().mockResolvedValue('/tmp/stage/upload-x');

    const snapshots: MemoryFlowReplayInput[] = [];
    const memoryFlow = createMemoryFlowLiveBuffer(bundleReplayInput(), {
      onChange: (snapshot) => snapshots.push(snapshot),
    });
    const ctx = new TestJobContext(
      'j1',
      null,
      () => Promise.resolve(),
      () => Promise.resolve(),
    );
    (ctx as any).memoryFlow = memoryFlow;

    await runner.run(
      {
        jobId: 'j1',
        connectionId: 'c1',
        sourceKey: 'fake',
        trigger: 'upload',
        bundleRef: { kind: 'upload', uploadId: 'upload-x' },
      },
      ctx,
    );

    expect(memoryFlow.snapshot()).toMatchObject({
      runId: 'run-1',
      connectionId: 'c1',
      adapter: 'fake',
      sourceDir: '/tmp/stage/upload-x',
    });
    expect(memoryFlow.snapshot().plannedWorkUnits).toEqual([
      {
        unitKey: 'u1',
        rawFiles: ['a.yml'],
        peerFileCount: 1,
        dependencyCount: 1,
      },
    ]);
    expect(memoryFlow.snapshot().events).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ type: 'source_acquired', adapter: 'fake', trigger: 'upload', fileCount: 1 }),
        expect.objectContaining({ type: 'scope_detected', fingerprint: null }),
        expect.objectContaining({ type: 'raw_snapshot_written', rawFileCount: 1 }),
        expect.objectContaining({ type: 'diff_computed', added: 1, modified: 0, deleted: 0, unchanged: 0 }),
        expect.objectContaining({ type: 'chunks_planned', chunkCount: 1, workUnitCount: 1, evictionCount: 1 }),
      ]),
    );
    expect(snapshots.length).toBeGreaterThan(4);
    expect(deps.reportsRepo.create).toHaveBeenCalledWith(
      expect.objectContaining({
        body: expect.objectContaining({
          memoryFlow: expect.objectContaining({
            metadata: expect.objectContaining({
              schemaVersion: 1,
              mode: 'full',
              origin: 'captured',
              timing: 'captured',
            }),
            events: expect.arrayContaining([
              expect.objectContaining({
                type: 'source_acquired',
                emittedAt: expect.stringMatching(/^\d{4}-\d{2}-\d{2}T/),
              }),
            ]),
          }),
        }),
      }),
    );
  });

  it('emits memory-flow WorkUnit step, candidate action, and finish events', async () => {
    const deps = makeDeps();
    let currentToolSession: any = null;
    deps.toolsetFactory.createIngestWuToolset.mockImplementation((toolSession: any) => {
      currentToolSession = toolSession;
      return {
        toRuntimeTools: vi.fn().mockReturnValue({}),
        getAllTools: vi.fn().mockReturnValue([]),
        getToolNames: vi.fn().mockReturnValue([]),
      };
    });
    deps.agentRunner.runLoop.mockImplementation(async (params: any) => {
      if (params.telemetryTags.operationName === 'ingest-bundle-wu') {
        // A real tool call drives the live work_unit_step heartbeat.
        await params.toolSet.record_verification_ledger.execute(
          { summary: 'Captured order context.', verifiedIdentifiers: [], unverifiedIdentifiers: [] },
          { toolCallId: 'ledger-1', messages: [] },
        );
        currentToolSession.actions.push({
          target: 'wiki',
          type: 'created',
          key: 'wiki/orders.md',
          detail: 'captured order context',
        });
      }
      return { stopReason: 'natural' };
    });

    const runner = buildRunner(deps);
    (runner as any).stageRawFilesStage1 = vi.fn().mockResolvedValue({
      currentHashes: new Map([['a.yml', 'h1']]),
      rawDirInWorktree: 'raw-sources/c1/fake/s',
    });
    (runner as any).resolveStagedDir = vi.fn().mockResolvedValue('/tmp/stage/upload-x');

    const memoryFlow = createMemoryFlowLiveBuffer(bundleReplayInput());
    const ctx = new TestJobContext(
      'j1',
      null,
      () => Promise.resolve(),
      () => Promise.resolve(),
    );
    (ctx as any).memoryFlow = memoryFlow;

    await runner.run(
      {
        jobId: 'j1',
        connectionId: 'c1',
        sourceKey: 'fake',
        trigger: 'upload',
        bundleRef: { kind: 'upload', uploadId: 'upload-x' },
      },
      ctx,
    );

    expect(memoryFlow.snapshot().events).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          type: 'work_unit_started',
          unitKey: 'u1',
          skills: ['ingest_triage', 'sl_capture', 'wiki_capture'],
        }),
        expect.objectContaining({ type: 'work_unit_step', unitKey: 'u1', toolCalls: 1 }),
        expect.objectContaining({
          type: 'candidate_action',
          unitKey: 'u1',
          target: 'wiki',
          action: 'created',
          key: 'wiki/orders.md',
        }),
        expect.objectContaining({ type: 'work_unit_finished', unitKey: 'u1', status: 'success' }),
      ]),
    );
  });

  it('emits memory-flow gate, saved, provenance, and report events', async () => {
    const deps = makeDeps();
    let currentToolSession: any = null;
    deps.toolsetFactory.createIngestWuToolset.mockImplementation((toolSession: any) => {
      currentToolSession = toolSession;
      return {
        toRuntimeTools: vi.fn().mockReturnValue({}),
        getAllTools: vi.fn().mockReturnValue([]),
        getToolNames: vi.fn().mockReturnValue([]),
      };
    });
    deps.agentRunner.runLoop.mockImplementation(async (params: any) => {
      if (params.telemetryTags.operationName === 'ingest-bundle-wu') {
        currentToolSession.actions.push({
          target: 'sl',
          type: 'updated',
          key: 'orders',
          detail: 'captured gross revenue',
        });
      }
      if (params.telemetryTags.operationName === 'ingest-bundle-reconcile') {
        await params.toolSet.record_verification_ledger.execute(
          {
            summary: 'Reconciliation emits no warehouse identifiers before fallback recording.',
            verifiedIdentifiers: [],
            unverifiedIdentifiers: [],
          },
          { toolCallId: 'ledger-1', messages: [] },
        );
        await params.toolSet.emit_conflict_resolution.execute(
          {
            kind: 'near_duplicate',
            artifactKey: 'sl:orders',
            detail: 'orders retained as canonical',
            flaggedForHuman: false,
          },
          { toolCallId: 'conflict-1', messages: [] },
        );
        await params.toolSet.emit_unmapped_fallback.execute(
          {
            rawPath: 'a.yml',
            reason: 'parse_error',
            clarification: 'semantic_not_representable',
            fallback: 'flagged',
          },
          { toolCallId: 'fallback-1', messages: [] },
        );
      }
      return { stopReason: 'natural' };
    });

    const runner = buildRunner(deps);
    (runner as any).stageRawFilesStage1 = vi.fn().mockResolvedValue({
      currentHashes: new Map([['a.yml', 'h1']]),
      rawDirInWorktree: 'raw-sources/c1/fake/s',
    });
    (runner as any).resolveStagedDir = vi.fn().mockResolvedValue('/tmp/stage/upload-x');

    const memoryFlow = createMemoryFlowLiveBuffer(bundleReplayInput());
    const ctx = new TestJobContext(
      'j1',
      null,
      () => Promise.resolve(),
      () => Promise.resolve(),
    );
    (ctx as any).memoryFlow = memoryFlow;

    await runner.run(
      {
        jobId: 'j1',
        connectionId: 'c1',
        sourceKey: 'fake',
        trigger: 'upload',
        bundleRef: { kind: 'upload', uploadId: 'upload-x' },
      },
      ctx,
    );

    expect(memoryFlow.snapshot()).toMatchObject({
      reportId: 'report-1',
      reportPath: 'report-1',
    });
    expect(memoryFlow.snapshot().events).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ type: 'reconciliation_finished', conflictCount: 1, fallbackCount: 1 }),
        expect.objectContaining({ type: 'saved', commitSha: 'sq', wikiCount: 0, slCount: 1 }),
        expect.objectContaining({ type: 'provenance_recorded', rowCount: 1 }),
        expect.objectContaining({ type: 'report_created', runId: 'run-1', reportPath: 'report-1' }),
      ]),
    );
  });

  it('finishes successful bundle memory-flow runs as done', async () => {
    const deps = makeDeps();
    const runner = buildRunner(deps);
    (runner as any).stageRawFilesStage1 = vi.fn().mockResolvedValue({
      currentHashes: new Map([['a.yml', 'h1']]),
      rawDirInWorktree: 'raw-sources/c1/fake/s',
    });
    (runner as any).resolveStagedDir = vi.fn().mockResolvedValue('/tmp/stage/upload-x');

    const memoryFlow = createMemoryFlowLiveBuffer(bundleReplayInput());
    const ctx = new TestJobContext(
      'j1',
      null,
      () => Promise.resolve(),
      () => Promise.resolve(),
    );
    (ctx as any).memoryFlow = memoryFlow;

    await runner.run(
      {
        jobId: 'j1',
        connectionId: 'c1',
        sourceKey: 'fake',
        trigger: 'upload',
        bundleRef: { kind: 'upload', uploadId: 'upload-x' },
      },
      ctx,
    );

    expect(memoryFlow.snapshot().status).toBe('done');
  });

  it('finishes bundle memory-flow runs with sanitized errors when the runner fails', async () => {
    const deps = makeDeps();
    const sensitiveMessage = [
      'failed to read postgres://user',
      ':password',
      '@localhost:5432/db?api_key=abc',
      ' token=',
      'secret',
    ].join('');
    deps.adapter.detect.mockRejectedValue(new Error(sensitiveMessage));
    const runner = buildRunner(deps);
    (runner as any).stageRawFilesStage1 = vi.fn().mockResolvedValue({
      currentHashes: new Map([['a.yml', 'h1']]),
      rawDirInWorktree: 'raw-sources/c1/fake/s',
    });
    (runner as any).resolveStagedDir = vi.fn().mockResolvedValue('/tmp/stage/upload-x');

    const memoryFlow = createMemoryFlowLiveBuffer(bundleReplayInput());
    const ctx = new TestJobContext(
      'j1',
      null,
      () => Promise.resolve(),
      () => Promise.resolve(),
    );
    (ctx as any).memoryFlow = memoryFlow;

    await expect(
      runner.run(
        {
          jobId: 'j1',
          connectionId: 'c1',
          sourceKey: 'fake',
          trigger: 'upload',
          bundleRef: { kind: 'upload', uploadId: 'upload-x' },
        },
        ctx,
      ),
    ).rejects.toThrow(/failed to read/);

    expect(memoryFlow.snapshot()).toMatchObject({
      status: 'error',
      errors: ['failed to read postgres://[redacted] token=[redacted]'],
    });
    expect(memoryFlow.snapshot().events).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ type: 'source_acquired', adapter: 'fake', trigger: 'upload', fileCount: 1 }),
      ]),
    );
  });

  it('stores memory-flow provenance and transcript summaries in the ingest report body', async () => {
    const deps = makeDeps();
    deps.toolsetFactory.createIngestWuToolset.mockReturnValue({
      toRuntimeTools: vi.fn().mockReturnValue({
        read_raw_span: {
          description: 'read a raw span',
          inputSchema: {},
          execute: vi.fn().mockResolvedValue('safe excerpt'),
        },
        wiki_write: {
          description: 'write wiki',
          inputSchema: {},
          execute: vi.fn().mockResolvedValue('written'),
        },
      }),
      getAllTools: vi.fn().mockReturnValue([]),
      getToolNames: vi.fn().mockReturnValue([]),
    });
    deps.agentRunner.runLoop.mockImplementation(async (params: any) => {
      if (params.telemetryTags.operationName === 'ingest-bundle-wu') {
        await params.toolSet.read_raw_span.execute(
          { path: 'a.yml', startLine: 1, endLine: 2 },
          { toolCallId: 'read-1', messages: [] },
        );
        await params.toolSet.record_verification_ledger.execute(
          {
            summary: 'Wiki write contains no warehouse identifiers.',
            verifiedIdentifiers: [],
            unverifiedIdentifiers: [],
          },
          { toolCallId: 'ledger-1', messages: [] },
        );
        await params.toolSet.wiki_write.execute(
          { key: 'wiki/a.md', content: 'safe summary' },
          { toolCallId: 'wiki-1', messages: [] },
        );
      }
      return { stopReason: 'natural' };
    });

    const runner = buildRunner(deps);
    (runner as any).stageRawFilesStage1 = vi.fn().mockResolvedValue({
      currentHashes: new Map([['a.yml', 'h1']]),
      rawDirInWorktree: 'raw-sources/c1/fake/s',
    });
    (runner as any).resolveStagedDir = vi.fn().mockResolvedValue('/tmp/stage/upload-x');

    await runner.run({
      jobId: 'j1',
      connectionId: 'c1',
      sourceKey: 'fake',
      trigger: 'upload',
      bundleRef: { kind: 'upload', uploadId: 'upload-x' },
    });

    expect(deps.reportsRepo.create).toHaveBeenCalledWith(
      expect.objectContaining({
        body: expect.objectContaining({
          provenanceRows: [
            expect.objectContaining({
              rawPath: 'a.yml',
              artifactKind: null,
              artifactKey: null,
              actionType: 'skipped',
              targetConnectionId: null,
            }),
          ],
          toolTranscripts: [
            {
              unitKey: 'u1',
              path: '/tmp/ktx-test/run/wu-transcripts/j1/u1.jsonl',
              toolCallCount: 3,
              errorCount: 0,
              toolNames: ['read_raw_span', 'record_verification_ledger', 'wiki_write'],
            },
          ],
        }),
      }),
    );
  });

  it('persists WorkUnit unmapped fallback records in the report body', async () => {
    const deps = makeDeps();
    deps.agentRunner.runLoop.mockImplementation(async (params: any) => {
      if (params.telemetryTags.operationName === 'ingest-bundle-wu') {
        await params.toolSet.record_verification_ledger.execute(
          {
            summary: 'Unmapped fallback records an unsupported conversion metric without verified warehouse identifiers.',
            verifiedIdentifiers: [],
            unverifiedIdentifiers: [],
          },
          { toolCallId: 'ledger-1', messages: [] },
        );
        await params.toolSet.emit_unmapped_fallback.execute(
          {
            rawPath: 'a.yml',
            reason: 'conversion_metric_unsupported',
            fallback: 'flagged',
          },
          { toolCallId: 'fallback-1', messages: [] },
        );
      }
      return { stopReason: 'natural' };
    });

    const runner = buildRunner(deps);
    (runner as any).stageRawFilesStage1 = vi.fn().mockResolvedValue({
      currentHashes: new Map([['a.yml', 'h1']]),
      rawDirInWorktree: 'raw-sources/c1/fake/s',
    });
    (runner as any).resolveStagedDir = vi.fn().mockResolvedValue('/tmp/stage/upload-x');

    await runner.run({
      jobId: 'j1',
      connectionId: 'c1',
      sourceKey: 'fake',
      trigger: 'upload',
      bundleRef: { kind: 'upload', uploadId: 'upload-x' },
    });

    expect(deps.reportsRepo.create).toHaveBeenCalledWith(
      expect.objectContaining({
        body: expect.objectContaining({
          unmappedFallbacks: [
            {
              rawPath: 'a.yml',
              reason: 'conversion_metric_unsupported',
              detail: expect.stringContaining('conversion metric'),
              fallback: 'flagged',
            },
          ],
        }),
      }),
    );
  });

  it('persists reconciliation conflict and eviction records in the report body', async () => {
    const deps = makeDeps();
    deps.diffSetService.compute.mockResolvedValue({
      added: [],
      modified: [],
      deleted: ['views/old_orders.view.lkml'],
      unchanged: [],
    });
    deps.adapter.chunk.mockResolvedValue({
      workUnits: [],
      eviction: { deletedRawPaths: ['views/old_orders.view.lkml'] },
    });
    deps.agentRunner.runLoop.mockImplementation(async (params: any) => {
      if (params.telemetryTags.operationName === 'ingest-bundle-reconcile') {
        await params.toolSet.record_verification_ledger.execute(
          {
            summary: 'Reconciliation records conflict, eviction, and fallback decisions without warehouse identifiers.',
            verifiedIdentifiers: [],
            unverifiedIdentifiers: [],
          },
          { toolCallId: 'ledger-1', messages: [] },
        );
        await params.toolSet.emit_conflict_resolution.execute(
          {
            kind: 'near_duplicate',
            artifactKey: 'sl:orders',
            detail: 'orders and old_orders overlapped; orders is retained as canonical',
            flaggedForHuman: false,
          },
          { toolCallId: 'conflict-1', messages: [] },
        );
        await params.toolSet.emit_eviction_decision.execute(
          {
            rawPath: 'views/old_orders.view.lkml',
            artifactKind: 'sl',
            artifactKey: 'old_orders',
            action: 'removed',
            reason: 'raw source disappeared in this sync',
          },
          { toolCallId: 'eviction-1', messages: [] },
        );
        await params.toolSet.emit_unmapped_fallback.execute(
          {
            rawPath: 'cards/untranslated.json',
            reason: 'parse_error',
            clarification: 'metabase_sql_untranslated',
            fallback: 'flagged',
          },
          { toolCallId: 'fallback-1', messages: [] },
        );
      }
      return { stopReason: 'natural' };
    });

    const runner = buildRunner(deps);
    (runner as any).stageRawFilesStage1 = vi.fn().mockResolvedValue({
      currentHashes: new Map([['cards/untranslated.json', 'h-card']]),
      rawDirInWorktree: 'raw-sources/c1/fake/s',
    });
    (runner as any).resolveStagedDir = vi.fn().mockResolvedValue('/tmp/stage/upload-x');

    await runner.run({
      jobId: 'j1',
      connectionId: 'c1',
      sourceKey: 'fake',
      trigger: 'upload',
      bundleRef: { kind: 'upload', uploadId: 'upload-x' },
    });

    expect(deps.reportsRepo.create).toHaveBeenCalledWith(
      expect.objectContaining({
        body: expect.objectContaining({
          conflictsResolved: [
            {
              kind: 'near_duplicate',
              artifactKey: 'sl:orders',
              detail: 'orders and old_orders overlapped; orders is retained as canonical',
              flaggedForHuman: false,
            },
          ],
          evictionsApplied: [
            {
              rawPath: 'views/old_orders.view.lkml',
              artifactKind: 'sl',
              artifactKey: 'old_orders',
              action: 'removed',
              reason: 'raw source disappeared in this sync',
            },
          ],
          unmappedFallbacks: [
            {
              rawPath: 'cards/untranslated.json',
              reason: 'parse_error',
              detail: expect.stringContaining('metabase_sql_untranslated'),
              fallback: 'flagged',
            },
          ],
        }),
      }),
    );
  });

  it('persists reconciliation artifact resolutions as provenance rows', async () => {
    const deps = makeDeps();
    deps.diffSetService.compute.mockResolvedValue({
      added: [],
      modified: [],
      deleted: ['looks/20.json'],
      unchanged: ['explores/b2b/sales_pipeline.json'],
    });
    deps.adapter.chunk.mockResolvedValue({
      workUnits: [],
      eviction: { deletedRawPaths: ['looks/20.json'] },
    });
    deps.agentRunner.runLoop.mockImplementation(async (params: any) => {
      if (params.telemetryTags.operationName === 'ingest-bundle-reconcile') {
        await params.toolSet.emit_artifact_resolution.execute(
          {
            rawPath: 'explores/b2b/sales_pipeline.json',
            artifactKind: 'sl',
            artifactKey: 'looker__b2b__sales_pipeline',
            actionType: 'subsumed',
            reason: 'File adapter source b2b__sales_pipeline is canonical.',
          },
          { toolCallId: 'resolution-1', messages: [] },
        );
      }
      return { stopReason: 'natural' };
    });

    const runner = buildRunner(deps);
    (runner as any).stageRawFilesStage1 = vi.fn().mockResolvedValue({
      currentHashes: new Map([['explores/b2b/sales_pipeline.json', 'h-explore']]),
      rawDirInWorktree: 'raw-sources/c1/looker/s',
    });
    (runner as any).resolveStagedDir = vi.fn().mockResolvedValue('/tmp/stage/upload-x');

    await runner.run({
      jobId: 'j1',
      connectionId: 'c1',
      sourceKey: 'looker',
      trigger: 'upload',
      bundleRef: { kind: 'upload', uploadId: 'upload-x' },
    });

    expect(deps.provenanceRepo.insertMany).toHaveBeenCalledWith(
      expect.arrayContaining([
        expect.objectContaining({
          rawPath: 'explores/b2b/sales_pipeline.json',
          artifactKind: 'sl',
          artifactKey: 'looker__b2b__sales_pipeline',
          actionType: 'subsumed',
        }),
      ]),
    );
    expect(deps.reportsRepo.create).toHaveBeenCalledWith(
      expect.objectContaining({
        body: expect.objectContaining({
          artifactResolutions: [
            {
              rawPath: 'explores/b2b/sales_pipeline.json',
              artifactKind: 'sl',
              artifactKey: 'looker__b2b__sales_pipeline',
              actionType: 'subsumed',
              reason: 'File adapter source b2b__sales_pipeline is canonical.',
            },
          ],
        }),
      }),
    );
  });

  it('runs manual override reconciliation from the prior report snapshot and marks the prior report superseded', async () => {
    const tempRoot = await mkdtemp(join(tmpdir(), 'ktx-override-'));
    const deps = makeDeps();
    deps.reportsRepo.findByJobId.mockResolvedValue({
      id: 'report-old',
      runId: 'run-old',
      jobId: 'job-old',
      connectionId: 'c1',
      sourceKey: 'fake',
      createdAt: '2026-04-27T10:00:00.000Z',
      body: {
        syncId: '2026-04-27-100000-job-old',
        diffSummary: { added: 1, modified: 0, deleted: 0, unchanged: 0 },
        commitSha: 'old-sha',
        workUnits: [
          {
            unitKey: 'wu-orders',
            rawFiles: ['a.yml'],
            status: 'success',
            actions: [
              {
                target: 'sl',
                type: 'updated',
                key: 'orders',
                detail: 'captured gross_revenue as orders.gross_revenue',
              },
            ],
            touchedSlSources: ['orders'],
          },
        ],
        failedWorkUnits: [],
        reconciliationSkipped: false,
        conflictsResolved: [
          {
            kind: 'definitional_contradiction',
            contestedKey: 'gross_revenue',
            artifactKey: 'orders.gross_revenue',
            detail: 'billing and orders disagree',
            flaggedForHuman: true,
          },
        ],
        evictionsApplied: [],
        unmappedFallbacks: [],
        evictionInputs: [],
        unresolvedCards: [],
        supersededBy: null,
        overrideOf: null,
      },
    });
    deps.gitService.listFilesAtHead.mockResolvedValue(['raw-sources/c1/fake/2026-04-27-100000-job-old/a.yml']);
    deps.gitService.getFileAtCommit.mockResolvedValue('name: orders\n');
    deps.diffSetService.compute.mockResolvedValue({ added: [], modified: [], deleted: [], unchanged: ['a.yml'] });
    deps.agentRunner.runLoop.mockImplementation(async (args: any) => {
      await args.toolSet.emit_conflict_resolution.execute(
        {
          kind: 'definitional_contradiction',
          contestedKey: 'gross_revenue',
          artifactKey: 'orders.gross_revenue',
          detail: 'canonical pin applied',
          flaggedForHuman: false,
        },
        { toolCallId: 'tc-1', messages: [] },
      );
      return { stopReason: 'natural' };
    });

    const runner = new IngestBundleRunner({
      ...(buildRunner(deps) as any).deps,
      storage: {
        homeDir: tempRoot,
        systemGitAuthor: { name: 'ktx Test', email: 'system@ktx.local' },
        resolveUploadDir: (uploadId: string) => join(tempRoot, 'ingest-uploads', uploadId),
        resolvePullDir: (jobId: string) => join(tempRoot, 'ingest-pulls', jobId),
        resolveTranscriptDir: (jobId: string) => join(tempRoot, 'run', 'wu-transcripts', jobId),
      },
    });

    await runner.run({
      jobId: 'job-new',
      connectionId: 'c1',
      sourceKey: 'fake',
      trigger: 'manual_override',
      bundleRef: { kind: 'override', priorJobId: 'job-old' },
    });

    await expect(readFile(join(tempRoot, 'ingest-pulls/job-new/a.yml'), 'utf-8')).resolves.toBe('name: orders\n');
    expect(deps.adapter.chunk).not.toHaveBeenCalled();
    expect(deps.agentRunner.runLoop).toHaveBeenCalled();
    expect(deps.reportsRepo.create).toHaveBeenCalledWith(
      expect.objectContaining({
        jobId: 'job-new',
        body: expect.objectContaining({
          overrideOf: 'job-old',
          supersededBy: null,
          conflictsResolved: [
            expect.objectContaining({
              contestedKey: 'gross_revenue',
              flaggedForHuman: false,
            }),
          ],
        }),
      }),
    );
    expect(deps.reportsRepo.markSuperseded).toHaveBeenCalledWith('job-old', 'job-new');
    await rm(tempRoot, { recursive: true, force: true });
  });

  it('passes connection canonical pins into each WorkUnit system prompt', async () => {
    const deps = makeDeps();
    deps.adapter.chunk.mockResolvedValue({
      workUnits: [
        {
          unitKey: 'wu-orders',
          rawFiles: ['cards/orders.yml'],
          peerFileIndex: [],
          dependencyPaths: [],
        },
      ],
    });
    deps.canonicalPins.listPins.mockResolvedValue([
      {
        contestedKey: 'gross_revenue',
        canonicalArtifactKey: 'finance.gross_revenue',
        pinnedAt: '2026-04-27T12:00:00.000Z',
        pinnedBy: 'user-1',
        reason: 'finance owns revenue definitions',
      },
    ]);
    deps.agentRunner.runLoop.mockResolvedValue({ stopReason: 'natural' });

    const runner = buildRunner(deps);
    (runner as any).stageRawFilesStage1 = vi.fn().mockResolvedValue({
      currentHashes: new Map([['cards/orders.yml', 'h1']]),
      rawDirInWorktree: 'raw-sources/c1/fake/s',
    });
    (runner as any).resolveStagedDir = vi.fn().mockResolvedValue('/tmp/stage/upload-x');

    await runner.run({
      jobId: 'j1',
      connectionId: 'c1',
      sourceKey: 'fake',
      trigger: 'upload',
      bundleRef: { kind: 'upload', uploadId: 'upload-x' },
    });

    const workUnitCall = deps.agentRunner.runLoop.mock.calls.find(
      ([params]: any[]) => params.telemetryTags.operationName === 'ingest-bundle-wu',
    );
    expect(workUnitCall?.[0].systemPrompt).toContain('<canonical_pins>');
    expect(workUnitCall?.[0].systemPrompt).toContain('contestedKey: gross_revenue');
    expect(workUnitCall?.[0].systemPrompt).toContain('canonicalArtifactKey: finance.gross_revenue');
    expect(deps.canonicalPins.listPins).toHaveBeenCalledTimes(1);
    expect(deps.canonicalPins.listPins).toHaveBeenCalledWith(['c1']);
  });

  it('builds WorkUnit SL index and canonical pins across adapter target connections', async () => {
    const deps = makeDeps();
    deps.adapter.listTargetConnectionIds = vi.fn().mockResolvedValue(['warehouse-2']);
    deps.adapter.chunk.mockResolvedValue({
      workUnits: [
        {
          unitKey: 'looker-explore-b2b-orders',
          rawFiles: ['explores/b2b/orders.json'],
          peerFileIndex: [],
          dependencyPaths: [],
        },
      ],
    });
    deps.canonicalPins.listPins.mockResolvedValue([
      {
        contestedKey: 'gross_revenue',
        canonicalArtifactKey: 'finance.gross_revenue',
        pinnedAt: '2026-05-01T12:00:00.000Z',
        pinnedBy: 'user-1',
        reason: 'finance owns revenue definitions',
      },
    ]);

    const runner = buildRunner(deps);
    (runner as any).stageRawFilesStage1 = vi.fn().mockResolvedValue({
      currentHashes: new Map([['explores/b2b/orders.json', 'h1']]),
      rawDirInWorktree: 'raw-sources/looker-run/fake/s',
    });
    (runner as any).resolveStagedDir = vi.fn().mockResolvedValue('/tmp/stage/upload-x');

    await runner.run({
      jobId: 'j1',
      connectionId: 'looker-run',
      sourceKey: 'fake',
      trigger: 'upload',
      bundleRef: { kind: 'upload', uploadId: 'upload-x' },
    });

    const workUnitCall = deps.agentRunner.runLoop.mock.calls.find(
      ([params]: any[]) => params.telemetryTags.operationName === 'ingest-bundle-wu',
    );
    expect(deps.adapter.listTargetConnectionIds).toHaveBeenCalledWith('/tmp/stage/upload-x');
    expect(deps.semanticLayerService.loadAllSources).toHaveBeenCalledWith('looker-run');
    expect(deps.semanticLayerService.loadAllSources).toHaveBeenCalledWith('warehouse-2');
    expect(workUnitCall?.[0].userPrompt).toContain('looker__orders');
    expect(deps.canonicalPins.listPins).toHaveBeenCalledWith(['looker-run', 'warehouse-2']);
  });

  it('syncs wiki refs, reindexes, and records provenance on SL target connections', async () => {
    const deps = makeDeps();
    let currentToolSession: any = null;
    deps.adapter.listTargetConnectionIds = vi.fn().mockResolvedValue(['warehouse-2']);
    deps.wikiService.readPage = vi.fn().mockResolvedValue({
      frontmatter: { sl_refs: ['looker__b2b__sales_pipeline.arr'] },
    });
    deps.semanticLayerService.loadAllSources.mockImplementation((connectionId: string) =>
      Promise.resolve({ sources: [{ name: `${connectionId}_source` }], loadErrors: [] }),
    );
    deps.agentRunner.runLoop.mockImplementation(async (params: any) => {
      if (params.telemetryTags.operationName === 'ingest-bundle-wu') {
        currentToolSession.actions.push(
          {
            target: 'wiki',
            type: 'created',
            key: 'wiki/global/pipeline.md',
            detail: 'Pipeline article',
          },
          {
            target: 'sl',
            type: 'created',
            key: 'looker__b2b__sales_pipeline',
            detail: 'Created warehouse source',
            targetConnectionId: 'warehouse-2',
          },
        );
        addTouchedSlSource(currentToolSession.touchedSlSources, 'warehouse-2', 'looker__b2b__sales_pipeline');
      }
      return { stopReason: 'natural' };
    });
    deps.toolsetFactory.createIngestWuToolset.mockImplementation((toolSession: any) => {
      currentToolSession = toolSession;
      return {
        toRuntimeTools: vi.fn().mockReturnValue({}),
        getAllTools: vi.fn().mockReturnValue([]),
        getToolNames: vi.fn().mockReturnValue([]),
      };
    });

    const runner = buildRunner(deps);
    (runner as any).stageRawFilesStage1 = vi.fn().mockResolvedValue({
      currentHashes: new Map([['a.yml', 'h1']]),
      rawDirInWorktree: 'raw-sources/looker-run/fake/s',
    });
    (runner as any).resolveStagedDir = vi.fn().mockResolvedValue('/tmp/stage/upload-x');

    await runner.run({
      jobId: 'j1',
      connectionId: 'looker-run',
      sourceKey: 'fake',
      trigger: 'upload',
      bundleRef: { kind: 'upload', uploadId: 'upload-x' },
    });

    expect(deps.knowledgeSlRefs.syncFromWiki).toHaveBeenCalledWith({
      wikiPageKey: 'wiki/global/pipeline.md',
      wikiScope: 'GLOBAL',
      wikiScopeId: null,
      refs: [{ connectionId: 'warehouse-2', sourceName: 'looker__b2b__sales_pipeline' }],
    });
    expect(deps.semanticLayerService.loadAllSources).toHaveBeenCalledWith('warehouse-2');
    expect(deps.slSearchService.indexSources).toHaveBeenCalledWith('warehouse-2', [{ name: 'warehouse-2_source' }]);
    expect(deps.provenanceRepo.insertMany).toHaveBeenCalledWith(
      expect.arrayContaining([
        expect.objectContaining({
          connectionId: 'looker-run',
          targetConnectionId: 'warehouse-2',
          artifactKind: 'sl',
          artifactKey: 'looker__b2b__sales_pipeline',
        }),
        expect.objectContaining({
          connectionId: 'looker-run',
          targetConnectionId: null,
          artifactKind: 'wiki',
          artifactKey: 'wiki/global/pipeline.md',
        }),
      ]),
    );
    expect(deps.reportsRepo.create).toHaveBeenCalledWith(
      expect.objectContaining({
        body: expect.objectContaining({
          workUnits: [
            expect.objectContaining({
              touchedSlSources: [{ connectionId: 'warehouse-2', sourceName: 'looker__b2b__sales_pipeline' }],
            }),
          ],
          provenanceRows: expect.arrayContaining([
            expect.objectContaining({
              artifactKind: 'sl',
              artifactKey: 'looker__b2b__sales_pipeline',
              targetConnectionId: 'warehouse-2',
            }),
          ]),
        }),
      }),
    );
  });

  it('runs adapter finalization before squash, records the outcome, and reindexes touched sources', async () => {
    const deps = makeDeps();
    deps.adapter.source = 'metricflow';
    deps.registry.get.mockReturnValue(deps.adapter);
    deps.adapter.chunk.mockResolvedValue({
      workUnits: [],
      parseArtifacts: { semanticModels: [{ name: 'orders' }] },
    });
    deps.adapter.listTargetConnectionIds = vi.fn().mockResolvedValue(['warehouse-2']);
    deps.adapter.finalize = vi.fn().mockResolvedValue({
      result: { sourcesTouched: 1 },
      warnings: ['kept going'],
      errors: [],
      touchedSources: [{ connectionId: 'warehouse-2', sourceName: 'orders' }],
      changedWikiPageKeys: [],
      actions: [
        {
          target: 'sl',
          type: 'updated',
          key: 'orders',
          targetConnectionId: 'warehouse-2',
          detail: 'Finalized orders usage',
          rawPaths: ['semantic_models.yml'],
        },
      ],
    });
    let head = 'pre-finalization';
    // Touched-source derivation diffs composed sources before/after finalization
    // (the filename never carries identity), so the mock must reflect the write:
    // `orders` exists only once the finalization commit lands.
    deps.semanticLayerService.loadAllSources.mockImplementation((connectionId: string) =>
      Promise.resolve({
        sources:
          connectionId === 'warehouse-2' && head === 'post-finalization'
            ? [{ name: `${connectionId}_source` }, { name: 'orders' }]
            : [{ name: `${connectionId}_source` }],
        loadErrors: [],
      }),
    );
    const git = {
      revParseHead: vi.fn(async () => head),
      // Touched-source derivation reads each changed file's `name:`; the worktree
      // is mocked (no files on disk), so serve the source content from history.
      getFileAtCommit: vi.fn(async () => 'name: orders\n'),
      commitFiles: vi.fn().mockImplementation(async (paths: string[]) => {
        if (paths.includes('semantic-layer/warehouse-2/orders.yaml')) {
          head = 'post-finalization';
          return { created: true, commitHash: 'finalization-sha' };
        }
        return { created: true, commitHash: head };
      }),
      commitStaged: vi.fn().mockResolvedValue({ created: false, commitHash: 'post-finalization' }),
      resetHardTo: vi.fn(),
      assertWorktreeClean: vi.fn().mockResolvedValue(undefined),
      writeBinaryNoRenamePatch: vi.fn(async (_base: string, _head: string, patchPath: string) => {
        await writeFile(patchPath, '', 'utf-8');
      }),
      applyPatchFile3WayIndex: vi.fn(),
      diffNameStatus: vi.fn().mockImplementation(async (from: string, to: string) =>
        from === 'pre-finalization' && to === 'post-finalization'
          ? [{ status: 'M', path: 'semantic-layer/warehouse-2/orders.yaml' }]
          : [],
      ),
      changedPaths: vi.fn().mockResolvedValue(['semantic-layer/warehouse-2/orders.yaml']),
    };
    deps.sessionWorktreeService.create.mockResolvedValue({
      chatId: 'j1',
      workdir: '/tmp/wt',
      branch: 'session/j1',
      baseSha: 'b',
      createdAt: new Date(),
      git,
      config: {},
    });
    const runner = buildRunner(deps);
    (runner as any).stageRawFilesStage1 = vi.fn().mockResolvedValue({
      currentHashes: new Map([['semantic_models.yml', 'h1']]),
      rawDirInWorktree: 'raw-sources/c1/metricflow/s',
    });
    (runner as any).resolveStagedDir = vi.fn().mockResolvedValue('/tmp/stage/upload-x');

    await runner.run({
      jobId: 'j1',
      connectionId: 'c1',
      sourceKey: 'metricflow',
      trigger: 'upload',
      bundleRef: { kind: 'upload', uploadId: 'upload-x' },
    });

    expect(deps.adapter.finalize).toHaveBeenCalledWith(
      expect.objectContaining({
        connectionId: 'c1',
        sourceKey: 'metricflow',
        syncId: expect.any(String),
        jobId: 'j1',
        runId: 'run-1',
        workdir: '/tmp/wt',
        parseArtifacts: { semanticModels: [{ name: 'orders' }] },
      }),
    );
    expect(deps.reportsRepo.create).toHaveBeenCalledWith(
      expect.objectContaining({
        body: expect.objectContaining({
          finalization: expect.objectContaining({
            sourceKey: 'metricflow',
            status: 'success',
            commitSha: 'finalization-sha',
            touchedPaths: ['semantic-layer/warehouse-2/orders.yaml'],
            derivedTouchedSources: [{ connectionId: 'warehouse-2', sourceName: 'orders' }],
            declaredTouchedSources: [{ connectionId: 'warehouse-2', sourceName: 'orders' }],
            actions: [expect.objectContaining({ key: 'orders' })],
          }),
        }),
      }),
    );
    expect(deps.semanticLayerService.loadAllSources).toHaveBeenCalledWith('warehouse-2');
    expect(deps.slSearchService.indexSources).toHaveBeenCalledWith('warehouse-2', [
      { name: 'warehouse-2_source' },
      { name: 'orders' },
    ]);
    expect(deps.sessionWorktreeService.cleanup).toHaveBeenCalledWith(expect.any(Object), 'success');
  });

  it('recovers a deleted hash-named SL source by its in-file name, not its filename', async () => {
    const runner = buildRunner();
    // An uppercase warehouse source lives in a hash-derived filename, so parsing
    // the basename yields the phantom `widget_sales-1a2b3c4d`. The real name must
    // come from the file's `name:`, recovered from history once it was deleted.
    const deletedPath = 'semantic-layer/warehouse/widget_sales-1a2b3c4d.yaml';
    const getFileAtCommit = vi.fn(async () => 'name: WIDGET_SALES\ntable: WIDGET_SALES\n');
    const worktree = { workdir: join(tmpdir(), 'ktx-absent-worktree-recover'), git: { getFileAtCommit } };

    const touched = await (runner as any).touchedSlSourcesFromPaths(worktree, [deletedPath], 'pre-change-sha');

    expect(touched).toEqual([{ connectionId: 'warehouse', sourceName: 'WIDGET_SALES' }]);
    expect(getFileAtCommit).toHaveBeenCalledWith(deletedPath, 'pre-change-sha');
  });

  it('falls back to the filename only when a deleted SL file is unrecoverable from history', async () => {
    const runner = buildRunner();
    const deletedPath = 'semantic-layer/warehouse/orders.yaml';
    const getFileAtCommit = vi.fn(async () => {
      throw new Error('path not present at commit');
    });
    const worktree = { workdir: join(tmpdir(), 'ktx-absent-worktree-fallback'), git: { getFileAtCommit } };

    const touched = await (runner as any).touchedSlSourcesFromPaths(worktree, [deletedPath], 'pre-change-sha');

    expect(touched).toEqual([{ connectionId: 'warehouse', sourceName: 'orders' }]);
  });

  it('includes finalization actions in memory-flow saved counts', async () => {
    const deps = makeDeps();
    deps.adapter.source = 'historic-sql';
    deps.registry.get.mockReturnValue(deps.adapter);
    deps.adapter.chunk.mockResolvedValue({
      workUnits: [
        {
          unitKey: 'historic-sql-table-public-orders',
          rawFiles: ['tables/public/orders.json'],
          peerFileIndex: [],
          dependencyPaths: [],
        },
      ],
    });
    deps.adapter.finalize = vi.fn().mockResolvedValue({
      warnings: [],
      errors: [],
      touchedSources: [],
      changedWikiPageKeys: [],
      actions: [
        { target: 'sl', type: 'updated', key: 'orders', detail: 'Merged usage' },
        { target: 'sl', type: 'updated', key: 'customers', detail: 'Merged usage' },
        { target: 'wiki', type: 'created', key: 'historic-sql-orders', detail: 'Projected pattern' },
        { target: 'wiki', type: 'updated', key: 'historic-sql-customers', detail: 'Projected pattern' },
      ],
    });
    const runner = buildRunner(deps);
    (runner as any).stageRawFilesStage1 = vi.fn().mockResolvedValue({
      currentHashes: new Map([['tables/public/orders.json', 'h1']]),
      rawDirInWorktree: 'raw-sources/c1/historic-sql/s',
    });
    (runner as any).resolveStagedDir = vi.fn().mockResolvedValue('/tmp/stage/upload-x');
    const memoryFlow = createMemoryFlowLiveBuffer(bundleReplayInput());

    await runner.run(
      {
        jobId: 'j1',
        connectionId: 'c1',
        sourceKey: 'historic-sql',
        trigger: 'upload',
        bundleRef: { kind: 'upload', uploadId: 'upload-x' },
      },
      {
        jobId: 'j1',
        memoryFlow,
        startPhase: () => new TestJobContext('j1', null, () => Promise.resolve(), () => Promise.resolve()),
      },
    );

    expect(memoryFlow.snapshot().events).toContainEqual(
      expect.objectContaining({
        type: 'saved',
        wikiCount: 2,
        slCount: 2,
      }),
    );
  });

  it('marks finalization infrastructure failure as failed and preserves worktree cleanup state', async () => {
    const deps = makeDeps();
    deps.adapter.source = 'metricflow';
    deps.registry.get.mockReturnValue(deps.adapter);
    deps.adapter.chunk.mockResolvedValue({
      workUnits: [{ unitKey: 'u1', rawFiles: ['semantic_models.yml'], peerFileIndex: [], dependencyPaths: [] }],
      parseArtifacts: { semanticModels: [{ name: 'orders' }] },
    });
    deps.adapter.finalize = vi.fn().mockRejectedValue(new Error('worktree write failed'));
    const runner = buildRunner(deps);
    (runner as any).stageRawFilesStage1 = vi.fn().mockResolvedValue({
      currentHashes: new Map([['semantic_models.yml', 'h1']]),
      rawDirInWorktree: 'raw-sources/c1/metricflow/s',
    });
    (runner as any).resolveStagedDir = vi.fn().mockResolvedValue('/tmp/stage/upload-x');

    await expect(
      runner.run({
        jobId: 'j1',
        connectionId: 'c1',
        sourceKey: 'metricflow',
        trigger: 'upload',
        bundleRef: { kind: 'upload', uploadId: 'upload-x' },
      }),
    ).rejects.toThrow('worktree write failed');

    expect(deps.runsRepo.markFailed).toHaveBeenCalledWith('run-1');
    expect(deps.gitService.squashMergeIntoMain).not.toHaveBeenCalled();
    expect(deps.sessionWorktreeService.cleanup).toHaveBeenCalledWith(expect.any(Object), 'crash');
  });

  it('reports finalization actions excluded from provenance when raw paths are not defensible', async () => {
    const deps = makeDeps();
    deps.adapter.finalize = vi.fn().mockResolvedValue({
      warnings: [],
      errors: [],
      touchedSources: [],
      changedWikiPageKeys: [],
      actions: [
        { target: 'wiki', type: 'updated', key: 'historic-sql-pattern', detail: 'No raw path' },
        { target: 'sl', type: 'updated', key: 'orders', detail: 'Invalid raw path', rawPaths: ['missing.json'] },
      ],
    });
    const runner = buildRunner(deps);
    (runner as any).stageRawFilesStage1 = vi.fn().mockResolvedValue({
      currentHashes: new Map([['current.json', 'h1']]),
      rawDirInWorktree: 'raw-sources/c1/fake/s',
    });
    (runner as any).resolveStagedDir = vi.fn().mockResolvedValue('/tmp/stage/upload-x');

    await runner.run({
      jobId: 'j1',
      connectionId: 'c1',
      sourceKey: 'fake',
      trigger: 'upload',
      bundleRef: { kind: 'upload', uploadId: 'upload-x' },
    });

    expect(deps.reportsRepo.create).toHaveBeenCalledWith(
      expect.objectContaining({
        body: expect.objectContaining({
          finalization: expect.objectContaining({
            provenanceExclusions: [
              expect.objectContaining({ reason: 'missing_raw_paths' }),
              expect.objectContaining({ reason: 'raw_path_not_defensible', invalidRawPaths: ['missing.json'] }),
            ],
          }),
        }),
      }),
    );
    expect(deps.provenanceRepo.insertMany).not.toHaveBeenCalledWith(
      expect.arrayContaining([expect.objectContaining({ rawPath: 'missing.json' })]),
    );
  });

  it('passes explicit override replay metadata and no current work unit outcomes', async () => {
    const deps = makeDeps();
    deps.reportsRepo.findByJobId.mockResolvedValue({
      id: 'prior-report',
      runId: 'prior-run',
      jobId: 'prior-job',
      connectionId: 'c1',
      sourceKey: 'fake',
      createdAt: '2026-05-18T00:00:00.000Z',
      body: {
        status: 'completed',
        syncId: 'prior-sync',
        diffSummary: { added: 0, modified: 0, deleted: 0, unchanged: 0 },
        commitSha: 'prior-sha',
        workUnits: [
          {
            unitKey: 'prior-unit',
            rawFiles: ['prior.json'],
            status: 'success',
            actions: [{ target: 'wiki', type: 'created', key: 'prior', detail: 'prior' }],
            touchedSlSources: [],
          },
        ],
        failedWorkUnits: [],
        reconciliationSkipped: false,
        conflictsResolved: [],
        evictionsApplied: [
          {
            rawPath: 'do-not-replay.json',
            artifactKind: 'wiki',
            artifactKey: 'old',
            action: 'removed',
            reason: 'prior',
          },
        ],
        unmappedFallbacks: [],
        artifactResolutions: [],
        evictionInputs: ['evicted-from-prior-report.json'],
        unresolvedCards: [],
        supersededBy: null,
        overrideOf: null,
        provenanceRows: [],
        toolTranscripts: [],
      },
    });
    deps.adapter.finalize = vi.fn().mockResolvedValue({
      warnings: [],
      errors: [],
      touchedSources: [],
      changedWikiPageKeys: [],
      actions: [],
    });
    deps.gitService.listFilesAtHead.mockResolvedValue(['raw-sources/c1/fake/prior-sync/prior.json']);
    deps.gitService.getFileAtCommit.mockResolvedValue('{"id":1}\n');
    const runner = buildRunner(deps);
    (runner as any).stageRawFilesStage1 = vi.fn().mockResolvedValue({
      currentHashes: new Map([['prior.json', 'h1']]),
      rawDirInWorktree: 'raw-sources/c1/fake/prior-sync',
    });
    (runner as any).resolveStagedDir = vi.fn().mockResolvedValue('/tmp/stage/prior');

    await runner.run({
      jobId: 'override-job',
      connectionId: 'c1',
      sourceKey: 'fake',
      trigger: 'manual_override',
      bundleRef: { kind: 'override', priorJobId: 'prior-job' },
    });

    expect(deps.adapter.finalize).toHaveBeenCalledWith(
      expect.objectContaining({
        workUnitOutcomes: [],
        overrideReplay: {
          priorJobId: 'prior-job',
          priorRunId: 'prior-run',
          priorSyncId: 'prior-sync',
          evictionRawPaths: ['evicted-from-prior-report.json'],
        },
      }),
    );
  });

  it('includes existing global wiki pages in WorkUnit prompts', async () => {
    const deps = makeDeps();
    deps.knowledgeIndex.listPagesForUser.mockResolvedValue([
      {
        page_key: 'revenue-recognition',
        summary: 'Recognize revenue net of refunds after fulfillment.',
        scope: 'GLOBAL',
        scope_id: null,
      },
    ]);

    const runner = buildRunner(deps);
    (runner as any).stageRawFilesStage1 = vi.fn().mockResolvedValue({
      currentHashes: new Map([['cards/orders.yml', 'h1']]),
      rawDirInWorktree: 'raw-sources/c1/fake/s',
    });
    (runner as any).resolveStagedDir = vi.fn().mockResolvedValue('/tmp/stage/upload-x');

    await runner.run({
      jobId: 'j1',
      connectionId: 'c1',
      sourceKey: 'fake',
      trigger: 'upload',
      bundleRef: { kind: 'upload', uploadId: 'upload-x' },
    });

    const workUnitCall = deps.agentRunner.runLoop.mock.calls.find(
      ([params]: any[]) => params.telemetryTags.operationName === 'ingest-bundle-wu',
    );
    expect(workUnitCall?.[0].userPrompt).toContain('## Wiki Pages');
    expect(workUnitCall?.[0].userPrompt).toContain(
      '- revenue-recognition: Recognize revenue net of refunds after fulfillment.',
    );
    expect(deps.knowledgeIndex.listPagesForUser).toHaveBeenCalledWith('system');
  });

  it('includes manifest-backed target sources in WorkUnit prompts', async () => {
    const deps = makeDeps();
    deps.adapter.listTargetConnectionIds = vi.fn().mockResolvedValue(['postgres-warehouse']);
    deps.semanticLayerService.loadAllSources.mockImplementation((connectionId: string) =>
      Promise.resolve({
        sources: connectionId === 'postgres-warehouse' ? [{ name: 'stg_accounts' }] : [],
        loadErrors: [],
      }),
    );

    const runner = buildRunner(deps);
    (runner as any).stageRawFilesStage1 = vi.fn().mockResolvedValue({
      currentHashes: new Map([['models/schema.yml', 'h1']]),
      rawDirInWorktree: 'raw-sources/dbt-main/dbt/s',
    });
    (runner as any).resolveStagedDir = vi.fn().mockResolvedValue('/tmp/stage/upload-x');

    await runner.run({
      jobId: 'j1',
      connectionId: 'dbt-main',
      sourceKey: 'fake',
      trigger: 'upload',
      bundleRef: { kind: 'upload', uploadId: 'upload-x' },
    });

    const workUnitCall = deps.agentRunner.runLoop.mock.calls.find(
      ([params]: any[]) => params.telemetryTags.operationName === 'ingest-bundle-wu',
    );
    expect(workUnitCall?.[0].userPrompt).toContain('## postgres-warehouse');
    expect(workUnitCall?.[0].userPrompt).toContain('stg_accounts');
    expect(deps.canonicalPins.listPins).toHaveBeenCalledWith(['dbt-main', 'postgres-warehouse']);
  });

  it('does not resolve qualified fallback table refs by source name alone', async () => {
    const deps = makeDeps();
    deps.semanticLayerService.loadAllSources.mockResolvedValue({
      sources: [{ name: 'orders', table: 'sales.orders' }],
      loadErrors: [],
    });
    const runner = buildRunner(deps);

    await expect(
      (runner as any).tableRefExistsInSemanticLayer(deps.semanticLayerService, ['warehouse'], 'finance.orders'),
    ).resolves.toBe(false);
    await expect(
      (runner as any).tableRefExistsInSemanticLayer(deps.semanticLayerService, ['warehouse'], 'sales.orders'),
    ).resolves.toBe(true);
  });

  it('passes relevant canonical pins into the reconciliation system prompt', async () => {
    const deps = makeDeps();
    deps.diffSetService.compute.mockResolvedValue({
      added: [],
      modified: [],
      deleted: ['metrics/old.yml'],
      unchanged: [],
    });
    deps.adapter.chunk.mockResolvedValue({
      workUnits: [
        {
          unitKey: 'wu-billing',
          rawFiles: ['metrics/churn_risk_score.yml'],
          peerFileIndex: [],
          dependencyPaths: [],
        },
      ],
      eviction: { deletedRawPaths: ['metrics/old.yml'] },
    });
    deps.canonicalPins.listPins.mockResolvedValue([
      {
        contestedKey: 'churn_risk_score',
        canonicalArtifactKey: 'billing.churn_risk_score',
        pinnedAt: '2026-04-27T12:00:00.000Z',
        pinnedBy: 'user-1',
        reason: 'billing owns the contractual definition',
      },
      {
        contestedKey: 'gross_margin',
        canonicalArtifactKey: 'finance.gross_margin',
        pinnedAt: '2026-04-27T12:01:00.000Z',
        pinnedBy: 'user-2',
        reason: null,
      },
    ]);
    deps.agentRunner.runLoop.mockImplementation(async (params: any) => {
      if (params.telemetryTags.operationName === 'ingest-bundle-wu') {
        return { stopReason: 'natural' };
      }
      return { stopReason: 'natural' };
    });

    const runner = buildRunner(deps);
    (runner as any).stageRawFilesStage1 = vi.fn().mockResolvedValue({
      currentHashes: new Map([
        ['metrics/churn_risk_score.yml', 'h1'],
        ['metrics/old.yml', 'h2'],
      ]),
      rawDirInWorktree: 'raw-sources/c1/fake/s',
    });
    (runner as any).resolveStagedDir = vi.fn().mockResolvedValue('/tmp/stage/upload-x');

    await runner.run({
      jobId: 'j1',
      connectionId: 'c1',
      sourceKey: 'fake',
      trigger: 'upload',
      bundleRef: { kind: 'upload', uploadId: 'upload-x' },
    });

    const reconcileCall = deps.agentRunner.runLoop.mock.calls.find(
      ([params]: any[]) => params.telemetryTags.operationName === 'ingest-bundle-reconcile',
    );
    expect(reconcileCall?.[0].systemPrompt).toContain('<canonical_pins>');
    expect(reconcileCall?.[0].systemPrompt).toContain('contestedKey: churn_risk_score');
    expect(reconcileCall?.[0].systemPrompt).not.toContain('gross_margin');
    expect(deps.canonicalPins.listPins).toHaveBeenCalledWith(['c1']);
  });

  it('emits a monotonically non-decreasing progress sequence reaching 1.0, covering all 7 stages', async () => {
    const deps = makeDeps();
    deps.agentRunner.runLoop.mockImplementation(async () => ({ stopReason: 'natural' }));

    const runner = buildRunner(deps);
    (runner as any).stageRawFilesStage1 = vi.fn().mockResolvedValue({
      currentHashes: new Map([['a.yml', 'h1']]),
      rawDirInWorktree: 'raw-sources/c1/fake/s',
    });
    (runner as any).resolveStagedDir = vi.fn().mockResolvedValue('/tmp/stage/upload-x');

    const observed: Array<{ p: number; m?: string }> = [];
    const ctx = new TestJobContext(
      'j1',
      null,
      () => Promise.resolve(),
      (p, m) => {
        observed.push({ p, m });
        return Promise.resolve();
      },
    );

    await runner.run(
      {
        jobId: 'j1',
        connectionId: 'c1',
        sourceKey: 'fake',
        trigger: 'upload',
        bundleRef: { kind: 'upload', uploadId: 'upload-x' },
      },
      ctx,
    );

    // Monotonic.
    for (let i = 1; i < observed.length; i++) {
      expect(observed[i].p).toBeGreaterThanOrEqual(observed[i - 1].p);
    }
    // Reaches completion.
    expect(observed.at(-1)?.p).toBeCloseTo(1.0, 3);
    // Every stage surfaces a user-facing message.
    const phaseLabels = [
      'Fetching source files',
      'Planning updates',
      'Processing',
      /Reconcil|reconcil/,
      'Saving changes',
      'Recording history',
      'Wrapping up',
    ];
    for (const label of phaseLabels) {
      expect(observed.some((o) => (typeof label === 'string' ? o.m?.includes(label) : label.test(o.m ?? '')))).toBe(
        true,
      );
    }
  });

  it('a Stage 3 failure leaves the shared knowledge table untouched', async () => {
    const deps = makeDeps();
    // Agent runner returns a successful result but the adapter emits a WU whose
    // outcome still produces no actions — the point is that the scoped wiki service
    // must not touch indexRepository during Stage 3, and syncFromCommit is what
    // drives the shared table. If we cancel the run before squash, syncFromCommit
    // must not be called.
    deps.gitService.squashMergeIntoMain.mockRejectedValue(new Error('simulated squash failure'));
    const runner = buildRunner(deps);
    (runner as any).stageRawFilesStage1 = vi.fn().mockResolvedValue({
      currentHashes: new Map([['a.yml', 'h1']]),
      rawDirInWorktree: 'raw-sources/c1/fake/s',
    });
    (runner as any).resolveStagedDir = vi.fn().mockResolvedValue('/tmp/stage/upload-x');

    await expect(
      runner.run({
        jobId: 'j1',
        connectionId: 'c1',
        sourceKey: 'fake',
        trigger: 'upload',
        bundleRef: { kind: 'upload', uploadId: 'upload-x' },
      }),
    ).rejects.toThrow(/simulated squash failure/);
    expect(deps.wikiService.syncFromCommit).not.toHaveBeenCalled();
  });

  it('refuses to squash-merge when the session worktree has an in-progress sequencer op', async () => {
    const deps = makeDeps();
    const assertError = new Error('Worktree has in-progress git operation (sequencer ...); refusing to proceed');
    const sessionGit = {
      revParseHead: vi.fn().mockResolvedValue('h'),
      commitFiles: vi.fn().mockResolvedValue({ created: true, commitHash: 'h' }),
      commitStaged: vi.fn().mockResolvedValue({ created: false, commitHash: 'h' }),
      resetHardTo: vi.fn(),
      assertWorktreeClean: vi.fn().mockRejectedValue(assertError),
      writeBinaryNoRenamePatch: vi.fn(async (_base: string, _head: string, patchPath: string) => {
        await writeFile(patchPath, '', 'utf-8');
      }),
      applyPatchFile3WayIndex: vi.fn(),
      diffNameStatus: vi.fn().mockResolvedValue([]),
    };
    deps.sessionWorktreeService.create.mockResolvedValue({
      chatId: 'j1',
      workdir: '/tmp/wt',
      branch: 'session/j1',
      baseSha: 'b',
      createdAt: new Date(),
      git: sessionGit,
      config: {},
    });
    const runner = buildRunner(deps);
    (runner as any).stageRawFilesStage1 = vi.fn().mockResolvedValue({
      currentHashes: new Map([['a.yml', 'h1']]),
      rawDirInWorktree: 'raw-sources/c1/fake/s',
    });
    (runner as any).resolveStagedDir = vi.fn().mockResolvedValue('/tmp/stage/upload-x');

    await expect(
      runner.run({
        jobId: 'j1',
        connectionId: 'c1',
        sourceKey: 'fake',
        trigger: 'upload',
        bundleRef: { kind: 'upload', uploadId: 'upload-x' },
      }),
    ).rejects.toThrow(/in-progress git operation/);
    expect(deps.runsRepo.markFailed).toHaveBeenCalledWith('run-1');
    expect(deps.gitService.squashMergeIntoMain).not.toHaveBeenCalled();
  });

  it('fails the run and rethrows when the adapter cannot detect the bundle', async () => {
    const deps = makeDeps();
    deps.adapter.detect.mockResolvedValue(false);
    const runner = buildRunner(deps);
    (runner as any).stageRawFilesStage1 = vi.fn().mockResolvedValue({
      currentHashes: new Map([['a.yml', 'h1']]),
      rawDirInWorktree: 'raw-sources/c1/fake/s',
    });
    (runner as any).resolveStagedDir = vi.fn().mockResolvedValue('/tmp/stage/upload-x');

    await expect(
      runner.run({
        jobId: 'j1',
        connectionId: 'c1',
        sourceKey: 'fake',
        trigger: 'upload',
        bundleRef: { kind: 'upload', uploadId: 'upload-x' },
      }),
    ).rejects.toThrow(/did not recognize/);
    expect(deps.runsRepo.markFailed).toHaveBeenCalledWith('run-1');
  });
});
