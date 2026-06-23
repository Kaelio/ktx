import { createHash } from 'node:crypto';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import type { KtxEmbeddingPort } from '../src/context/core/embedding.js';
import type { KtxLlmRuntimePort } from '../src/context/llm/runtime-port.js';
import { initKtxProject, loadKtxProject, type KtxLocalProject } from '../src/context/project/project.js';
import { readLocalKnowledgePage, searchLocalKnowledgePages } from '../src/context/wiki/local-knowledge.js';
import {
  buildVerbatimFrontmatter,
  createLocalProjectVerbatimIngestor,
  deriveDegradedSummary,
  deriveVerbatimPageKey,
  splitInputDocument,
} from '../src/verbatim-ingest.js';

describe('splitInputDocument', () => {
  it('splits leading YAML frontmatter from the body', () => {
    const result = splitInputDocument('---\nsummary: In doc\neffective_date: 2024-01-01\n---\n\nBody here\n');
    expect(result.frontmatter).toEqual({ summary: 'In doc', effective_date: '2024-01-01' });
    expect(result.body).toBe('Body here');
  });

  it('treats a document without frontmatter as an empty-frontmatter body', () => {
    const result = splitInputDocument('# Title\n\ncontent\n');
    expect(result.frontmatter).toEqual({});
    expect(result.body).toBe('# Title\n\ncontent');
  });
});

describe('deriveVerbatimPageKey', () => {
  it('derives a file key from the basename without extension', () => {
    expect(deriveVerbatimPageKey({ kind: 'file', path: '/docs/haversine-formula.md' }, 'irrelevant')).toBe(
      'haversine-formula',
    );
  });

  it('slugifies a messy file basename', () => {
    expect(deriveVerbatimPageKey({ kind: 'file', path: '/docs/RFM Buckets.md' }, 'irrelevant')).toBe('RFM-Buckets');
  });

  it('derives an inline-text key from a leading Markdown heading', () => {
    expect(deriveVerbatimPageKey({ kind: 'text' }, '# Haversine Formula\n\ndetails')).toBe('Haversine-Formula');
  });

  it('rejects inline text with no leading heading', () => {
    expect(() => deriveVerbatimPageKey({ kind: 'text' }, 'no heading here')).toThrow(/heading|--file/);
  });

  it('derives a stdin key from a leading heading like inline text', () => {
    expect(deriveVerbatimPageKey({ kind: 'stdin' }, '## RFM Buckets\n\nrows')).toBe('RFM-Buckets');
  });
});

describe('deriveDegradedSummary', () => {
  it('uses the leading heading text when present', () => {
    expect(deriveDegradedSummary('# Haversine Formula\n\nThe formula computes distance.')).toBe('Haversine Formula');
  });

  it('falls back to the first non-empty sentence when there is no heading', () => {
    expect(deriveDegradedSummary('The haversine formula computes great-circle distance. More text.')).toBe(
      'The haversine formula computes great-circle distance.',
    );
  });
});

describe('buildVerbatimFrontmatter', () => {
  it('gap-fills absent fields with generated metadata and defaults usage_mode to auto', () => {
    const fm = buildVerbatimFrontmatter({
      inputFrontmatter: {},
      summary: 'generated summary',
      tags: ['finance'],
      slRefs: ['orders'],
    });
    expect(fm.summary).toBe('generated summary');
    expect(fm.tags).toEqual(['finance']);
    expect(fm.sl_refs).toEqual(['orders']);
    expect(fm.usage_mode).toBe('auto');
  });

  it('preserves an explicit input summary instead of the generated one', () => {
    const fm = buildVerbatimFrontmatter({
      inputFrontmatter: { summary: 'authoritative summary' },
      summary: 'generated summary',
      tags: ['x'],
      slRefs: [],
    });
    expect(fm.summary).toBe('authoritative summary');
  });

  it('passes through unknown frontmatter fields verbatim', () => {
    const fm = buildVerbatimFrontmatter({
      inputFrontmatter: { effective_date: '2024-01-01', version: 3, owner: 'data-team' },
      summary: 'generated summary',
      tags: [],
      slRefs: [],
    });
    expect(fm.effective_date).toBe('2024-01-01');
    expect(fm.version).toBe(3);
    expect(fm.owner).toBe('data-team');
  });

  it('keeps an explicit usage_mode', () => {
    const fm = buildVerbatimFrontmatter({
      inputFrontmatter: { usage_mode: 'always' },
      summary: 'generated summary',
      tags: [],
      slRefs: [],
    });
    expect(fm.usage_mode).toBe('always');
  });

  it('sets connections from the flag when the input declares none', () => {
    const fm = buildVerbatimFrontmatter({
      inputFrontmatter: {},
      summary: 's',
      tags: [],
      slRefs: [],
      connectionId: 'db1',
    });
    expect(fm.connections).toEqual(['db1']);
  });

  it('keeps input connections when the flag matches', () => {
    const fm = buildVerbatimFrontmatter({
      inputFrontmatter: { connections: ['db1'] },
      summary: 's',
      tags: [],
      slRefs: [],
      connectionId: 'db1',
    });
    expect(fm.connections).toEqual(['db1']);
  });

  it('keeps input connections when no flag is given', () => {
    const fm = buildVerbatimFrontmatter({
      inputFrontmatter: { connections: ['db2'] },
      summary: 's',
      tags: [],
      slRefs: [],
    });
    expect(fm.connections).toEqual(['db2']);
  });

  it('errors when input connections differ from the flag', () => {
    expect(() =>
      buildVerbatimFrontmatter({
        inputFrontmatter: { connections: ['db2'] },
        summary: 's',
        tags: [],
        slRefs: [],
        connectionId: 'db1',
      }),
    ).toThrow(/connection/i);
  });
});

class FakeEmbeddingPort implements KtxEmbeddingPort {
  readonly maxBatchSize = 16;

  async computeEmbedding(text: string): Promise<number[]> {
    return /haversine|distance|geospatial|sphere|proximity|great-circle/i.test(text) ? [1, 0] : [0, 1];
  }

  async computeEmbeddingsBulk(texts: string[]): Promise<number[][]> {
    return Promise.all(texts.map((text) => this.computeEmbedding(text)));
  }
}

function fakeLlmRuntime(metadata: { summary: string; tags: string[]; sl_refs: string[] }): KtxLlmRuntimePort {
  return {
    async generateText() {
      throw new Error('generateText is not used by verbatim ingest');
    },
    async generateObject(input) {
      return input.schema.parse(metadata);
    },
    async runAgentLoop() {
      throw new Error('runAgentLoop is not used by verbatim ingest');
    },
    subprocessForkSpec() {
      return null;
    },
  };
}

function throwingLlmRuntime(): KtxLlmRuntimePort {
  return {
    async generateText() {
      throw new Error('generateText is not used by verbatim ingest');
    },
    async generateObject() {
      throw new Error('rate limit exceeded');
    },
    async runAgentLoop() {
      throw new Error('runAgentLoop is not used by verbatim ingest');
    },
    subprocessForkSpec() {
      return null;
    },
  };
}

describe('LocalVerbatimIngestor', () => {
  let projectDir: string;
  let project: KtxLocalProject;

  beforeEach(async () => {
    projectDir = await mkdtemp(join(tmpdir(), 'ktx-verbatim-'));
    await initKtxProject({ projectDir });
    project = await loadKtxProject({ projectDir });
  });

  afterEach(async () => {
    await rm(projectDir, { recursive: true, force: true });
  });

  it('stores the document body byte-for-byte (after trim)', async () => {
    const body = '# Haversine Formula\n\nUse R = 6371 km. The DRS threshold = 0.5 and bucket boundary is [30, 60).';
    const ingestor = createLocalProjectVerbatimIngestor(project, { llmRuntime: null });
    const result = await ingestor.ingest({ origin: { kind: 'file', path: '/docs/haversine-formula.md' }, content: body });

    expect(result.pageKey).toBe('haversine-formula');
    expect(result.outcome).toBe('written');
    const page = await readLocalKnowledgePage(project, { key: 'haversine-formula' });
    expect(page?.content).toBe(body.trim());
    expect(createHash('sha256').update(page!.content).digest('hex')).toBe(
      createHash('sha256').update(body.trim()).digest('hex'),
    );
  });

  it('stores a document larger than the LLM clip limit in full', async () => {
    const body = `# Big Doc\n\n${'x'.repeat(60_000)}`;
    const ingestor = createLocalProjectVerbatimIngestor(project, { llmRuntime: null });
    await ingestor.ingest({ origin: { kind: 'file', path: '/docs/big-doc.md' }, content: body });

    const page = await readLocalKnowledgePage(project, { key: 'big-doc' });
    expect(page!.content.length).toBeGreaterThanOrEqual(body.trim().length);
  });

  it('is idempotent when re-ingesting the same document', async () => {
    const body = '# Doc\n\nstable body content';
    const item = { origin: { kind: 'file' as const, path: '/docs/doc.md' }, content: body };
    const ingestor = createLocalProjectVerbatimIngestor(project, { llmRuntime: null });

    const first = await ingestor.ingest(item);
    expect(first.outcome).toBe('written');
    const second = await ingestor.ingest(item);
    expect(second.outcome).toBe('unchanged');

    const page = await readLocalKnowledgePage(project, { key: 'doc' });
    expect(page?.content).toBe(body.trim());
  });

  it('hard-errors on a different body at the same key without modifying the existing page', async () => {
    const ingestor = createLocalProjectVerbatimIngestor(project, { llmRuntime: null });
    await ingestor.ingest({ origin: { kind: 'file', path: '/docs/doc.md' }, content: '# Doc\n\nfirst body' });

    await expect(
      ingestor.ingest({ origin: { kind: 'file', path: '/docs/doc.md' }, content: '# Doc\n\nsecond body' }),
    ).rejects.toThrow(/doc/);

    const page = await readLocalKnowledgePage(project, { key: 'doc' });
    expect(page?.content).toContain('first body');
    expect(page?.content).not.toContain('second body');
  });

  it('passes through unknown frontmatter and never overwrites an explicit summary', async () => {
    const content =
      '---\nsummary: Authoritative summary\neffective_date: 2024-01-01\n---\n\n# Metric Spec\n\nbody text';
    const ingestor = createLocalProjectVerbatimIngestor(project, { llmRuntime: null });
    await ingestor.ingest({ origin: { kind: 'file', path: '/docs/metric-spec.md' }, content });

    const page = await readLocalKnowledgePage(project, { key: 'metric-spec' });
    expect(page?.summary).toBe('Authoritative summary');
    const raw = await readFile(join(projectDir, 'wiki/global/metric-spec.md'), 'utf-8');
    expect(raw).toContain('effective_date: 2024-01-01');
  });

  it('derives a degraded summary and empty tags with no LLM backend', async () => {
    const body = '# RFM Buckets\n\nRecency 1-30 days is bucket A.';
    const ingestor = createLocalProjectVerbatimIngestor(project, { llmRuntime: null });
    await ingestor.ingest({ origin: { kind: 'file', path: '/docs/rfm-buckets.md' }, content: body });

    const page = await readLocalKnowledgePage(project, { key: 'rfm-buckets' });
    expect(page?.summary).toBe('RFM Buckets');
    expect(page?.tags).toEqual([]);
    expect(page?.slRefs).toEqual([]);
  });

  it('scopes the page to a configured connection via the flag', async () => {
    project.config.connections = { db1: { driver: 'sqlite' } };
    const ingestor = createLocalProjectVerbatimIngestor(project, { llmRuntime: null });
    await ingestor.ingest({
      origin: { kind: 'file', path: '/docs/scoped.md' },
      content: '# Scoped\n\nbody',
      connectionId: 'db1',
    });

    const page = await readLocalKnowledgePage(project, { key: 'scoped' });
    expect(page?.connections).toEqual(['db1']);
  });

  it('rejects an unknown connection id and lists the configured ids', async () => {
    const ingestor = createLocalProjectVerbatimIngestor(project, { llmRuntime: null });
    await expect(
      ingestor.ingest({ origin: { kind: 'file', path: '/docs/x.md' }, content: '# X\n\nbody', connectionId: 'nope' }),
    ).rejects.toThrow(/Configured connections/);
  });

  it('errors when the flag connection disagrees with frontmatter connections', async () => {
    project.config.connections = { db1: { driver: 'sqlite' } };
    const content = '---\nconnections:\n  - db2\n---\n\n# Amb\n\nbody';
    const ingestor = createLocalProjectVerbatimIngestor(project, { llmRuntime: null });
    await expect(
      ingestor.ingest({ origin: { kind: 'file', path: '/docs/amb.md' }, content, connectionId: 'db1' }),
    ).rejects.toThrow(/connection/i);
  });

  it('errors on inline text without a leading heading', async () => {
    const ingestor = createLocalProjectVerbatimIngestor(project, { llmRuntime: null });
    await expect(ingestor.ingest({ origin: { kind: 'text' }, content: 'no heading here' })).rejects.toThrow(
      /heading|--file/,
    );
  });

  it('uses LLM-generated metadata to gap-fill absent fields', async () => {
    const runtime = fakeLlmRuntime({ summary: 'LLM summary', tags: ['t1'], sl_refs: ['orders'] });
    const ingestor = createLocalProjectVerbatimIngestor(project, { llmRuntime: runtime });
    await ingestor.ingest({ origin: { kind: 'file', path: '/docs/llm-doc.md' }, content: '# LLM Doc\n\nabout orders' });

    const page = await readLocalKnowledgePage(project, { key: 'llm-doc' });
    expect(page?.summary).toBe('LLM summary');
    expect(page?.tags).toEqual(['t1']);
    expect(page?.slRefs).toEqual(['orders']);
  });

  it('fails the item on LLM error and writes no page when a backend is configured', async () => {
    const ingestor = createLocalProjectVerbatimIngestor(project, { llmRuntime: throwingLlmRuntime() });
    await expect(
      ingestor.ingest({ origin: { kind: 'file', path: '/docs/fail-doc.md' }, content: '# Fail Doc\n\nbody' }),
    ).rejects.toThrow();

    const page = await readLocalKnowledgePage(project, { key: 'fail-doc' });
    expect(page).toBeNull();
  });

  it('is findable by a body phrase via the lexical lane', async () => {
    const ingestor = createLocalProjectVerbatimIngestor(project, { llmRuntime: null });
    await ingestor.ingest({
      origin: { kind: 'file', path: '/docs/overtake.md' },
      content: '# Overtake Rule\n\nThe overtake rule grants DRS within one second.',
    });

    const results = await searchLocalKnowledgePages(project, { query: 'overtake rule grants DRS' });
    expect(results.some((result) => result.key === 'overtake')).toBe(true);
  });

  it('is findable by a topic paraphrase via the semantic lane when embeddings are enabled', async () => {
    const ingestor = createLocalProjectVerbatimIngestor(project, { llmRuntime: null });
    await ingestor.ingest({
      origin: { kind: 'file', path: '/docs/haversine.md' },
      content: '# Haversine\n\nThe haversine formula computes great-circle distance.',
    });

    const results = await searchLocalKnowledgePages(project, {
      query: 'geospatial proximity',
      embeddingService: new FakeEmbeddingPort(),
    });
    const match = results.find((result) => result.key === 'haversine');
    expect(match).toBeDefined();
    expect(match?.matchReasons).toContain('semantic');
  });
});
