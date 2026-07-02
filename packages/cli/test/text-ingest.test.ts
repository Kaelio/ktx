import { describe, expect, it, vi } from 'vitest';
import type { MemoryIngestStatus } from '../src/context/memory/memory-runs.js';
import type { KtxLocalProject } from '../src/context/project/project.js';
import { runKtxTextIngest, type TextMemoryIngestPort } from '../src/text-ingest.js';
import type { VerbatimIngestItem, VerbatimIngestorPort } from '../src/verbatim-ingest.js';

function fakeVerbatim(
  options: { calls?: VerbatimIngestItem[]; throwOn?: (item: VerbatimIngestItem) => boolean } = {},
): VerbatimIngestorPort {
  return {
    ingest: vi.fn(async (item: VerbatimIngestItem) => {
      options.calls?.push(item);
      if (options.throwOn?.(item)) {
        throw new Error(`verbatim write failed for ${item.origin.kind}`);
      }
      return {
        pageKey: item.origin.kind === 'file' && item.origin.path ? 'haversine' : 'page',
        outcome: 'written' as const,
        connections: item.connectionId ? [item.connectionId] : [],
        commitHash: null,
      };
    }),
  };
}

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

function fakeIngest(
  options: {
    failRunIds?: Set<string>;
    missingStatusRunIds?: Set<string>;
    events?: string[];
  } = {},
): TextMemoryIngestPort {
  let next = 1;
  return {
    ingest: vi.fn(async () => {
      const runId = `run-${next++}`;
      options.events?.push(`ingest:${runId}`);
      return { runId };
    }),
    waitForRun: vi.fn(async (runId: string) => {
      options.events?.push(`wait:${runId}`);
    }),
    status: vi.fn(async (runId: string) => {
      options.events?.push(`status:${runId}`);
      if (options.missingStatusRunIds?.has(runId)) {
        return null;
      }
      if (options.failRunIds?.has(runId)) {
        return {
          runId,
          status: 'error',
          stage: 'ingesting',
          done: true,
          captured: { wiki: [], sl: [], xrefs: [] },
          error: `${runId} failed`,
          commitHash: null,
          skillsLoaded: [],
          signalDetected: false,
        } satisfies MemoryIngestStatus;
      }
      return {
        runId,
        status: 'done',
        stage: 'ingesting',
        done: true,
        captured: { wiki: [`wiki-${runId}`], sl: [`sl-${runId}`], xrefs: [] },
        error: null,
        commitHash: `commit-${runId}`,
        skillsLoaded: ['wiki_capture', 'sl'],
        signalDetected: true,
      } satisfies MemoryIngestStatus;
    }),
  };
}

function fakeProject(projectDir = '/tmp/project'): KtxLocalProject {
  return { projectDir } as KtxLocalProject;
}

describe('runKtxTextIngest', () => {
  it('ingests repeated inline text sequentially with generated internal chat ids', async () => {
    const io = makeIo();
    const events: string[] = [];
    const ingest = fakeIngest({ events });
    const createMemoryIngest = vi.fn(() => ingest);

    await expect(
      runKtxTextIngest(
        {
          projectDir: '/tmp/project',
          texts: ['Revenue means gross receipts.', 'Orders are completed purchases.'],
          files: [],
          userId: 'local-cli',
          json: true,
          failFast: false,
        },
        io.io,
        {
          loadProject: vi.fn(async () => fakeProject()),
          createMemoryIngest,
          now: () => 1_700_000_000_000,
        },
      ),
    ).resolves.toBe(0);

    expect(createMemoryIngest).toHaveBeenCalledWith({ projectDir: '/tmp/project' });
    expect(ingest.ingest).toHaveBeenNthCalledWith(
      1,
      expect.objectContaining({
        userId: 'local-cli',
        chatId: 'cli-text-ingest-1700000000000-1',
        userMessage: 'Ingest external text artifact "Revenue means gross receipts." into ktx memory.',
        assistantMessage: 'Revenue means gross receipts.',
        sourceType: 'external_ingest',
      }),
    );
    expect(ingest.ingest).toHaveBeenNthCalledWith(
      2,
      expect.objectContaining({
        chatId: 'cli-text-ingest-1700000000000-2',
        userMessage: 'Ingest external text artifact "Orders are completed purchases." into ktx memory.',
        assistantMessage: 'Orders are completed purchases.',
      }),
    );
    expect(ingest.ingest).not.toHaveBeenCalledWith(expect.objectContaining({ connectionId: expect.anything() }));
    expect(events).toEqual(['ingest:run-1', 'wait:run-1', 'status:run-1', 'ingest:run-2', 'wait:run-2', 'status:run-2']);
    expect(JSON.parse(io.stdout())).toMatchObject({
      status: 'done',
      results: [
        {
          label: '"Revenue means gross receipts."',
          runId: 'run-1',
          status: 'done',
          captured: { wiki: ['wiki-run-1'], sl: ['sl-run-1'] },
        },
        {
          label: '"Orders are completed purchases."',
          runId: 'run-2',
          status: 'done',
          captured: { wiki: ['wiki-run-2'], sl: ['sl-run-2'] },
        },
      ],
    });
  });

  it('loads files and stdin as batch items and passes a global connection id', async () => {
    const io = makeIo();
    const ingest = fakeIngest();

    await expect(
      runKtxTextIngest(
        {
          projectDir: '/tmp/project',
          texts: [],
          files: ['/tmp/docs/revenue.md', '-'],
          connectionId: 'warehouse',
          userId: 'agent',
          json: false,
          failFast: false,
        },
        io.io,
        {
          loadProject: vi.fn(async () => fakeProject()),
          createMemoryIngest: vi.fn(() => ingest),
          readFile: vi.fn(async (path) => `file:${path}`),
          readStdin: vi.fn(async () => 'stdin content'),
          now: () => 10,
        },
      ),
    ).resolves.toBe(0);

    expect(ingest.ingest).toHaveBeenNthCalledWith(
      1,
      expect.objectContaining({
        connectionId: 'warehouse',
        userId: 'agent',
        userMessage: 'Ingest external text artifact "revenue.md" into ktx memory.',
        assistantMessage: 'file:/tmp/docs/revenue.md',
      }),
    );
    expect(ingest.ingest).toHaveBeenNthCalledWith(
      2,
      expect.objectContaining({
        connectionId: 'warehouse',
        userMessage: 'Ingest external text artifact "stdin" into ktx memory.',
        assistantMessage: 'stdin content',
      }),
    );
    expect(io.stdout()).toContain('Ingesting text memory');
    expect(io.stdout()).toContain('Texts:');
    expect(io.stdout()).toContain('revenue.md');
    expect(io.stdout()).toContain('stdin');
  });

  it('uses bounded inline text previews as labels in plain output and ingest metadata', async () => {
    const io = makeIo();
    const ingest = fakeIngest();
    const longText = `This inline note is intentionally long ${'x'.repeat(120)}`;

    await expect(
      runKtxTextIngest(
        {
          projectDir: '/tmp/project',
          texts: ['remember to call me Andrey', '  first line\n\tsecond line  ', longText],
          files: [],
          userId: 'local-cli',
          json: false,
          failFast: false,
        },
        io.io,
        {
          loadProject: vi.fn(async () => fakeProject()),
          createMemoryIngest: vi.fn(() => ingest),
          now: () => 10,
        },
      ),
    ).resolves.toBe(0);

    const output = io.stdout();
    expect(output).toContain('"remember to call me Andrey"');
    expect(output).toContain('"first line second line"');
    expect(output).toContain('"This inline note is intentionally long xxxxxxxx..."');
    expect(output).not.toContain('text-1');
    expect(output).not.toContain(longText);

    expect(ingest.ingest).toHaveBeenNthCalledWith(
      1,
      expect.objectContaining({
        userMessage: 'Ingest external text artifact "remember to call me Andrey" into ktx memory.',
      }),
    );
    expect(ingest.ingest).toHaveBeenNthCalledWith(
      2,
      expect.objectContaining({
        userMessage: 'Ingest external text artifact "first line second line" into ktx memory.',
      }),
    );
    expect(ingest.ingest).toHaveBeenNthCalledWith(
      3,
      expect.objectContaining({
        userMessage: 'Ingest external text artifact "This inline note is intentionally long xxxxxxxx..." into ktx memory.',
      }),
    );
  });

  it('continues after an item failure by default and stops when failFast is set', async () => {
    const continueIo = makeIo();
    const continueIngest = fakeIngest({ failRunIds: new Set(['run-1']) });

    await expect(
      runKtxTextIngest(
        {
          projectDir: '/tmp/project',
          texts: ['bad', 'good'],
          files: [],
          userId: 'local-cli',
          json: true,
          failFast: false,
        },
        continueIo.io,
        {
          loadProject: vi.fn(async () => fakeProject()),
          createMemoryIngest: vi.fn(() => continueIngest),
        },
      ),
    ).resolves.toBe(1);

    expect(continueIngest.ingest).toHaveBeenCalledTimes(2);
    expect(JSON.parse(continueIo.stdout())).toMatchObject({
      status: 'failed',
      results: [
        { label: '"bad"', status: 'error', error: 'run-1 failed' },
        { label: '"good"', status: 'done' },
      ],
    });

    const failFastIo = makeIo();
    const failFastIngest = fakeIngest({ failRunIds: new Set(['run-1']) });

    await expect(
      runKtxTextIngest(
        {
          projectDir: '/tmp/project',
          texts: ['bad', 'skipped'],
          files: [],
          userId: 'local-cli',
          json: true,
          failFast: true,
        },
        failFastIo.io,
        {
          loadProject: vi.fn(async () => fakeProject()),
          createMemoryIngest: vi.fn(() => failFastIngest),
        },
      ),
    ).resolves.toBe(1);

    expect(failFastIngest.ingest).toHaveBeenCalledTimes(1);
    expect(JSON.parse(failFastIo.stdout()).results).toHaveLength(1);
  });

  it('rejects empty batches and empty text items', async () => {
    const noInputIo = makeIo();
    await expect(
      runKtxTextIngest(
        {
          projectDir: '/tmp/project',
          texts: [],
          files: [],
          userId: 'local-cli',
          json: false,
          failFast: false,
        },
        noInputIo.io,
        { loadProject: vi.fn(), createMemoryIngest: vi.fn() },
      ),
    ).resolves.toBe(1);
    expect(noInputIo.stderr()).toContain('Provide at least one text item');

    const emptyIo = makeIo();
    await expect(
      runKtxTextIngest(
        {
          projectDir: '/tmp/project',
          texts: ['   '],
          files: [],
          userId: 'local-cli',
          json: false,
          failFast: false,
        },
        emptyIo.io,
        { loadProject: vi.fn(), createMemoryIngest: vi.fn() },
      ),
    ).resolves.toBe(1);
    expect(emptyIo.stderr()).toContain('Text item "text-1" is empty');
  });

  it('routes verbatim file items to the verbatim ingestor instead of the memory agent', async () => {
    const io = makeIo();
    const calls: VerbatimIngestItem[] = [];
    const verbatim = fakeVerbatim({ calls });
    const createMemoryIngest = vi.fn(() => fakeIngest());

    await expect(
      runKtxTextIngest(
        {
          projectDir: '/tmp/project',
          texts: [],
          files: ['/tmp/docs/haversine.md'],
          userId: 'local-cli',
          json: true,
          failFast: false,
          verbatim: true,
        },
        io.io,
        {
          loadProject: vi.fn(async () => fakeProject()),
          createMemoryIngest,
          createVerbatimIngestor: vi.fn(() => verbatim),
          readFile: vi.fn(async (path) => `file:${path}`),
          now: () => 1,
        },
      ),
    ).resolves.toBe(0);

    expect(createMemoryIngest).not.toHaveBeenCalled();
    expect(verbatim.ingest).toHaveBeenCalledTimes(1);
    expect(calls[0]?.origin).toEqual({ kind: 'file', path: '/tmp/docs/haversine.md' });
    expect(calls[0]?.content).toBe('file:/tmp/docs/haversine.md');
    expect(JSON.parse(io.stdout())).toMatchObject({
      status: 'done',
      results: [{ status: 'done', captured: { wiki: ['haversine'] } }],
    });
  });

  it('routes verbatim inline text with a text origin and forwards the connection id', async () => {
    const io = makeIo();
    const calls: VerbatimIngestItem[] = [];
    const verbatim = fakeVerbatim({ calls });

    await expect(
      runKtxTextIngest(
        {
          projectDir: '/tmp/project',
          texts: ['# Title\n\nbody'],
          files: [],
          connectionId: 'db1',
          userId: 'local-cli',
          json: true,
          failFast: false,
          verbatim: true,
        },
        io.io,
        {
          loadProject: vi.fn(async () => fakeProject()),
          createVerbatimIngestor: vi.fn(() => verbatim),
          now: () => 1,
        },
      ),
    ).resolves.toBe(0);

    expect(calls[0]?.origin).toEqual({ kind: 'text' });
    expect(calls[0]?.content).toBe('# Title\n\nbody');
    expect(calls[0]?.connectionId).toBe('db1');
  });

  it('fails the run when a verbatim item throws and honors fail-fast', async () => {
    const io = makeIo();
    const calls: VerbatimIngestItem[] = [];
    const verbatim = fakeVerbatim({ calls, throwOn: () => true });

    await expect(
      runKtxTextIngest(
        {
          projectDir: '/tmp/project',
          texts: [],
          files: ['/tmp/a.md', '/tmp/b.md'],
          userId: 'local-cli',
          json: true,
          failFast: true,
          verbatim: true,
        },
        io.io,
        {
          loadProject: vi.fn(async () => fakeProject()),
          createVerbatimIngestor: vi.fn(() => verbatim),
          readFile: vi.fn(async (path) => `file:${path}`),
          now: () => 1,
        },
      ),
    ).resolves.toBe(1);

    expect(verbatim.ingest).toHaveBeenCalledTimes(1);
  });
});
