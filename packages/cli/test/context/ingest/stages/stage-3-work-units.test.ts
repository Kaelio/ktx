import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { CaptureSession, MemoryAction } from '../../../../src/context/memory/types.js';
import { addTouchedSlSource, createTouchedSlSources } from '../../../../src/context/tools/touched-sl-sources.js';
import type { WorkUnit } from '../../../../src/context/ingest/types.js';
import { executeWorkUnit, type WorkUnitExecutionDeps } from '../../../../src/context/ingest/stages/stage-3-work-units.js';

const makeWu = (overrides: Partial<WorkUnit> = {}): WorkUnit => ({
  unitKey: 'u1',
  rawFiles: ['a.yml'],
  peerFileIndex: [],
  dependencyPaths: [],
  ...overrides,
});

const makeDeps = (): WorkUnitExecutionDeps => {
  const session: CaptureSession = {
    userId: 'system',
    chatId: 'u1',
    userMessage: '',
    connectionId: 'c1',
    userScopedEnabled: false,
    forceGlobalScope: true,
    touchedSlSources: createTouchedSlSources(),
    preHead: null,
  };
  const sessionActions: MemoryAction[] = [];
  return {
    sessionWorktreeGit: { revParseHead: vi.fn() } as any,
    agentRunner: { runLoop: vi.fn() } as any,
    validateTouchedSources: vi.fn().mockResolvedValue({ validSources: [], invalidSources: [] }),
    resetHardTo: vi.fn(),
    buildSystemPrompt: () => 'sys',
    buildUserPrompt: () => 'usr',
    buildToolSet: () => ({ noop: { description: 'x', inputSchema: {} as any, execute: vi.fn() } as any }),
    captureSession: session,
    sessionActions,
    modelRole: 'candidateExtraction',
    stepBudget: 40,
    sourceKey: 'fake',
    connectionId: 'c1',
    jobId: 'j1',
  };
};

describe('Stage 3 — executeWorkUnit', () => {
  beforeEach(() => vi.clearAllMocks());

  it('clean path — no touched sources, passes through as success with empty actions', async () => {
    const deps = makeDeps();
    deps.sessionWorktreeGit.revParseHead = vi.fn().mockResolvedValueOnce('pre').mockResolvedValueOnce('post');
    deps.agentRunner.runLoop = vi.fn().mockResolvedValue({ stopReason: 'natural' });
    const outcome = await executeWorkUnit(deps, makeWu());
    expect(outcome.status).toBe('success');
    expect(outcome.preSha).toBe('pre');
    expect(outcome.postSha).toBe('post');
    expect(outcome.actions).toEqual([]);
    expect(deps.validateTouchedSources).not.toHaveBeenCalled();
    expect(deps.resetHardTo).not.toHaveBeenCalled();
    expect(deps.agentRunner.runLoop).toHaveBeenCalledWith(expect.objectContaining({ modelRole: 'candidateExtraction' }));
  });

  it('validates touched sources and passes through as success when all are valid', async () => {
    const deps = makeDeps();
    deps.sessionWorktreeGit.revParseHead = vi.fn().mockResolvedValueOnce('pre').mockResolvedValueOnce('post');
    deps.agentRunner.runLoop = vi.fn().mockImplementation(() => {
      deps.sessionActions.push({ target: 'sl', type: 'created', key: 'src_good', detail: '' });
      addTouchedSlSource(deps.captureSession.touchedSlSources, 'c1', 'src_good');
      return Promise.resolve({ stopReason: 'natural' });
    });
    deps.validateTouchedSources = vi.fn().mockResolvedValue({ validSources: ['c1:src_good'], invalidSources: [] });
    const outcome = await executeWorkUnit(deps, makeWu());
    expect(outcome.status).toBe('success');
    expect(outcome.actions.map((a) => a.key)).toEqual(['src_good']);
    expect(outcome.touchedSlSources).toEqual([{ connectionId: 'c1', sourceName: 'src_good' }]);
    expect(deps.resetHardTo).not.toHaveBeenCalled();
  });

  it('any invalid source resets to the pre-WU SHA and marks WU failed', async () => {
    const deps = makeDeps();
    deps.sessionWorktreeGit.revParseHead = vi.fn().mockResolvedValueOnce('pre').mockResolvedValueOnce('post');
    deps.agentRunner.runLoop = vi.fn().mockImplementation(() => {
      deps.sessionActions.push({ target: 'sl', type: 'created', key: 'src_bad', detail: '' });
      deps.sessionActions.push({ target: 'sl', type: 'created', key: 'src_good', detail: '' });
      addTouchedSlSource(deps.captureSession.touchedSlSources, 'c1', 'src_bad');
      addTouchedSlSource(deps.captureSession.touchedSlSources, 'c1', 'src_good');
      return Promise.resolve({ stopReason: 'natural' });
    });
    deps.validateTouchedSources = vi.fn().mockResolvedValue({
      validSources: ['c1:src_good'],
      invalidSources: [{ source: 'c1:src_bad', errors: ['join target "accounts" does not exist'] }],
    });
    const outcome = await executeWorkUnit(deps, makeWu());
    expect(outcome.status).toBe('failed');
    expect(outcome.reason).toMatch(/src_bad \(join target "accounts" does not exist\)/);
    expect(outcome.actions).toEqual([]);
    expect(outcome.touchedSlSources).toEqual([]);
    expect(deps.resetHardTo).toHaveBeenCalledWith('pre');
  });

  it('runner loop error resets to the pre-WU SHA and marks WU failed', async () => {
    const deps = makeDeps();
    deps.sessionWorktreeGit.revParseHead = vi.fn().mockResolvedValueOnce('pre').mockResolvedValueOnce('post');
    deps.agentRunner.runLoop = vi.fn().mockResolvedValue({ stopReason: 'error', error: new Error('LLM down') });
    const outcome = await executeWorkUnit(deps, makeWu());
    expect(outcome.status).toBe('failed');
    expect(outcome.reason).toMatch(/LLM down/);
    expect(deps.resetHardTo).toHaveBeenCalledWith('pre');
  });

  it('tool failures reset to the pre-WU SHA and mark WU failed even when the loop ends naturally', async () => {
    const deps = makeDeps();
    deps.sessionWorktreeGit.revParseHead = vi.fn().mockResolvedValueOnce('pre').mockResolvedValueOnce('post');
    deps.agentRunner.runLoop = vi.fn().mockResolvedValue({ stopReason: 'natural' });
    deps.toolFailureCount = vi.fn().mockReturnValue(2);

    const outcome = await executeWorkUnit(deps, makeWu());

    expect(outcome.status).toBe('failed');
    expect(outcome.reason).toContain('2 tool call(s) failed');
    expect(outcome.actions).toEqual([]);
    expect(outcome.touchedSlSources).toEqual([]);
    expect(deps.resetHardTo).toHaveBeenCalledWith('pre');
  });

  it('dangling wiki refs are deferred to the final gate and preserve actions', async () => {
    const deps = makeDeps();
    deps.sessionWorktreeGit.revParseHead = vi.fn().mockResolvedValueOnce('pre').mockResolvedValueOnce('post');
    deps.agentRunner.runLoop = vi.fn().mockImplementation(() => {
      deps.sessionActions.push({ target: 'wiki', type: 'created', key: 'page-a', detail: 'Page A' });
      return Promise.resolve({ stopReason: 'natural' });
    });

    const outcome = await executeWorkUnit(deps, makeWu());

    expect(outcome.status).toBe('success');
    expect(outcome.actions.map((action) => action.key)).toEqual(['page-a']);
    expect(outcome.touchedSlSources).toEqual([]);
    expect(deps.resetHardTo).not.toHaveBeenCalled();
  });

  it('resolved wiki refs pass post-WU validation and preserve actions', async () => {
    const deps = makeDeps();
    deps.sessionWorktreeGit.revParseHead = vi.fn().mockResolvedValueOnce('pre').mockResolvedValueOnce('post');
    deps.agentRunner.runLoop = vi.fn().mockImplementation(() => {
      deps.sessionActions.push({ target: 'wiki', type: 'created', key: 'page-a', detail: 'Page A' });
      deps.sessionActions.push({ target: 'wiki', type: 'created', key: 'page-b', detail: 'Page B' });
      return Promise.resolve({ stopReason: 'natural' });
    });

    const outcome = await executeWorkUnit(deps, makeWu());

    expect(outcome.status).toBe('success');
    expect(outcome.actions.map((action) => action.key)).toEqual(['page-a', 'page-b']);
    expect(deps.resetHardTo).not.toHaveBeenCalled();
  });

  it('runner loop thrown exception resets to the pre-WU SHA and marks WU failed', async () => {
    const deps = makeDeps();
    deps.sessionWorktreeGit.revParseHead = vi.fn().mockResolvedValueOnce('pre').mockResolvedValueOnce('post');
    deps.agentRunner.runLoop = vi.fn().mockRejectedValue(new Error('provider disconnected'));

    const outcome = await executeWorkUnit(deps, makeWu());

    expect(outcome).toMatchObject({
      unitKey: 'u1',
      status: 'failed',
      reason: 'provider disconnected',
      preSha: 'pre',
      postSha: 'post',
      actions: [],
      touchedSlSources: [],
    });
    expect(deps.resetHardTo).toHaveBeenCalledWith('pre');
  });

  it('fails before model execution when the assembled prompt is too large', async () => {
    const deps = makeDeps();
    deps.sessionWorktreeGit.revParseHead = vi.fn().mockResolvedValue('pre');
    deps.buildSystemPrompt = () => 'sys';
    deps.buildUserPrompt = () => 'x'.repeat(260_000);

    const outcome = await executeWorkUnit(deps, makeWu());

    expect(outcome.status).toBe('failed');
    expect(outcome.reason).toMatch(/prompt too large/i);
    expect(deps.agentRunner.runLoop).not.toHaveBeenCalled();
    expect(deps.resetHardTo).not.toHaveBeenCalled();
  });

  it('no commits made during WU — skips resetHardTo even on runner error', async () => {
    const deps = makeDeps();
    deps.sessionWorktreeGit.revParseHead = vi.fn().mockResolvedValueOnce('same').mockResolvedValueOnce('same');
    deps.agentRunner.runLoop = vi.fn().mockResolvedValue({ stopReason: 'error', error: new Error('bail') });
    const outcome = await executeWorkUnit(deps, makeWu());
    expect(outcome.status).toBe('failed');
    expect(deps.resetHardTo).not.toHaveBeenCalled();
  });
});
