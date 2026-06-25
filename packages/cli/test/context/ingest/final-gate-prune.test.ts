import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { pruneFinalGateFindings } from '../../../src/context/ingest/final-gate-prune.js';
import { KnowledgeWikiService } from '../../../src/context/wiki/knowledge-wiki.service.js';

describe('final gate prune', () => {
  let tempDir: string;

  beforeEach(async () => {
    tempDir = await mkdtemp(join(tmpdir(), 'ktx-final-gate-prune-'));
    await mkdir(join(tempDir, 'semantic-layer/warehouse'), { recursive: true });
    await mkdir(join(tempDir, 'wiki/global'), { recursive: true });
  });

  afterEach(async () => {
    await rm(tempDir, { recursive: true, force: true });
  });

  it('drops invalid sources and prunes dangling joins from surviving sources', async () => {
    await writeFile(
      join(tempDir, 'semantic-layer/warehouse/orders.yaml'),
      'name: orders\ngrain: [id]\ncolumns: [{name: id, type: number}]\njoins:\n  - to: missing_customers\n    on: orders.customer_id = missing_customers.id\nmeasures: []\n',
      'utf-8',
    );
    await writeFile(
      join(tempDir, 'semantic-layer/warehouse/bad.yaml'),
      'name: bad\ngrain: [id]\ncolumns: [{name: id, type: number}]\njoins: []\nmeasures: []\n',
      'utf-8',
    );

    const result = await pruneFinalGateFindings({
      workdir: tempDir,
      findings: [
        { kind: 'invalid_source', connectionId: 'warehouse', sourceName: 'bad', errors: ['dry run failed'] },
        {
          kind: 'missing_join_target',
          ownerConnectionId: 'warehouse',
          ownerSourceName: 'orders',
          targetSourceName: 'missing_customers',
          message: 'join target "missing_customers" does not exist',
        },
      ],
      droppedSources: [],
      trace: { event: vi.fn() } as never,
      author: { name: 'ktx Test', email: 'system@ktx.local' },
    });

    await expect(readFile(join(tempDir, 'semantic-layer/warehouse/bad.yaml'), 'utf-8')).rejects.toThrow();
    await expect(readFile(join(tempDir, 'semantic-layer/warehouse/orders.yaml'), 'utf-8')).resolves.not.toContain(
      'missing_customers',
    );
    expect(result.droppedSources).toEqual([
      { connectionId: 'warehouse', sourceName: 'bad', reason: 'dry run failed' },
    ]);
    expect(result.prunedReferences).toEqual([
      {
        kind: 'join',
        artifact: 'semantic-layer/warehouse/orders',
        removedRef: 'missing_customers',
        absentTarget: 'missing_customers',
      },
    ]);
  });

  it('prunes wiki refs, wiki sl_refs, and body ref tokens from owning pages', async () => {
    await writeFile(
      join(tempDir, 'wiki/global/revenue.md'),
      '---\nsummary: Revenue\nusage_mode: auto\nrefs:\n  - missing-page\nsl_refs:\n  - missing_source\n---\n\nRevenue uses [[missing-page]], `source:missing_source`, and `orders.missing_measure`.\n',
      'utf-8',
    );
    const wikiService = new KnowledgeWikiService(
      {
        readFile: async (path: string) => ({ content: await readFile(join(tempDir, path), 'utf-8'), hash: 'h' }),
        writeFile: async (path: string, content: string) => {
          await writeFile(join(tempDir, path), content, 'utf-8');
          return { commitHash: 'c', path };
        },
        deleteFile: vi.fn(),
        listFiles: vi.fn(),
        forWorktree: vi.fn(),
      } as never,
      { computeEmbedding: vi.fn(), computeEmbeddingsBulk: vi.fn(), maxBatchSize: 1 } as never,
      { upsertPage: vi.fn(), deletePage: vi.fn(), listPagesForUser: vi.fn() } as never,
      {} as never,
    );

    const result = await pruneFinalGateFindings({
      workdir: tempDir,
      findings: [
        { kind: 'missing_wiki_ref', pageKey: 'revenue', targetPageKey: 'missing-page', message: 'revenue -> missing-page' },
        {
          kind: 'missing_wiki_sl_ref',
          pageKey: 'revenue',
          ref: 'missing_source',
          sourceName: 'missing_source',
          entityName: null,
          message: 'revenue: unknown sl_refs entry missing_source',
        },
        {
          kind: 'missing_wiki_body_sl_source',
          pageKey: 'revenue',
          rawToken: 'source:missing_source',
          sourceName: 'missing_source',
          message: 'revenue: unknown semantic-layer source missing_source',
        },
        {
          kind: 'missing_wiki_body_sl_entity',
          pageKey: 'revenue',
          rawToken: 'orders.missing_measure',
          sourceName: 'orders',
          entityName: 'missing_measure',
          message: 'revenue: unknown semantic-layer entity orders.missing_measure',
        },
      ],
      droppedSources: [],
      trace: { event: vi.fn() } as never,
      author: { name: 'ktx Test', email: 'system@ktx.local' },
      wikiService,
    });

    const page = await readFile(join(tempDir, 'wiki/global/revenue.md'), 'utf-8');
    expect(page).not.toContain('missing-page');
    expect(page).not.toContain('missing_source');
    expect(page).not.toContain('orders.missing_measure');
    expect(result.prunedReferences.map((ref) => ref.kind)).toEqual([
      'wiki_ref',
      'wiki_sl_ref',
      'wiki_body_ref',
      'wiki_body_ref',
    ]);
  });
});
