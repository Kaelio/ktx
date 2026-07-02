import { access, mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { SqliteKnowledgeIndex, type SqliteKnowledgeIndexPage } from '../../../src/context/wiki/sqlite-knowledge-index.js';

describe('SqliteKnowledgeIndex', () => {
  let tempDir: string;
  let dbPath: string;

  beforeEach(async () => {
    tempDir = await mkdtemp(join(tmpdir(), 'ktx-sqlite-knowledge-index-'));
    dbPath = join(tempDir, 'db.sqlite');
  });

  afterEach(async () => {
    await rm(tempDir, { recursive: true, force: true });
  });

  function page(overrides: Partial<SqliteKnowledgeIndexPage> = {}): SqliteKnowledgeIndexPage {
    return {
      path: 'wiki/global/revenue.md',
      key: 'revenue',
      scope: 'GLOBAL',
      summary: 'Revenue definition',
      content: 'Revenue is the sum of paid order amounts.',
      tags: ['finance'],
      embedding: null,
      ...overrides,
    };
  }

  it('creates a SQLite FTS5 index and returns lexical lane candidates', async () => {
    const index = new SqliteKnowledgeIndex({ dbPath });

    index.sync([
      page(),
      page({
        path: 'wiki/global/support.md',
        key: 'support',
        summary: 'Support queue',
        content: 'Tickets are grouped by priority.',
        tags: ['operations'],
      }),
    ]);

    await expect(access(dbPath)).resolves.toBeUndefined();
    expect(index.searchLexicalCandidates({ queryText: 'paid order', limit: 10 })).toEqual([
      expect.objectContaining({
        id: 'wiki/global/revenue.md',
        path: 'wiki/global/revenue.md',
        rank: 1,
        rawScore: expect.any(Number),
      }),
    ]);
  });

  it('removes stale rows when the Markdown source list changes', () => {
    const index = new SqliteKnowledgeIndex({ dbPath });
    index.rebuild([page(), page({ path: 'wiki/global/churn.md', key: 'churn', content: 'Churn risk.' })]);
    expect(index.search('churn', 10)).toHaveLength(1);

    index.rebuild([page()]);

    expect(index.search('churn', 10)).toEqual([]);
  });

  it('clear removes one wiki scope and leaves other scopes intact', async () => {
    const index = new SqliteKnowledgeIndex({ dbPath });
    index.sync([
      page({ path: 'wiki/global/revenue.md', key: 'revenue', scope: 'GLOBAL', scopeId: null }),
      page({
        path: 'wiki/user/local/revenue.md',
        key: 'revenue',
        scope: 'USER',
        scopeId: 'local',
        summary: 'Local revenue',
        content: 'Local revenue notes.',
      }),
      page({
        path: 'wiki/user/alex/revenue.md',
        key: 'revenue',
        scope: 'USER',
        scopeId: 'alex',
        summary: 'Alex revenue',
        content: 'Alex revenue notes.',
      }),
    ]);

    expect(index.clear('USER', 'local')).toBe(1);

    expect(index.search('Local', 10)).toEqual([]);
    expect(index.search('Alex', 10)).toEqual([expect.objectContaining({ path: 'wiki/user/alex/revenue.md' })]);
    expect(index.search('definition', 10)).toEqual([expect.objectContaining({ path: 'wiki/global/revenue.md' })]);
  });

  it('exposes existing search text and embedding state for incremental refresh', () => {
    const index = new SqliteKnowledgeIndex({ dbPath });
    index.sync([page({ path: 'wiki/global/revenue.md', key: 'revenue', embedding: [1, 0] })]);

    expect(index.getExistingPages()).toEqual(
      new Map([
        [
          'wiki/global/revenue.md',
          expect.objectContaining({
            searchText: expect.stringContaining('Revenue definition'),
            embedding: [1, 0],
          }),
        ],
      ]),
    );
  });

  it('does not treat empty embeddings as indexed semantic vectors', () => {
    const index = new SqliteKnowledgeIndex({ dbPath });
    index.sync([page({ path: 'wiki/global/revenue.md', key: 'revenue', embedding: [] })]);

    expect(index.getExistingPages().get('wiki/global/revenue.md')?.embedding).toBeNull();
    expect(index.searchSemanticCandidates({ queryEmbedding: [1, 0], limit: 10 })).toEqual([]);
  });

  it('returns semantic lane candidates from stored page embeddings', () => {
    const index = new SqliteKnowledgeIndex({ dbPath });
    index.sync([
      page({ path: 'wiki/global/revenue.md', key: 'revenue', embedding: [1, 0] }),
      page({ path: 'wiki/global/support.md', key: 'support', summary: 'Support queue', embedding: [0, 1] }),
    ]);

    expect(index.searchSemanticCandidates({ queryEmbedding: [1, 0], limit: 10 })).toEqual([
      expect.objectContaining({
        id: 'wiki/global/revenue.md',
        path: 'wiki/global/revenue.md',
        rank: 1,
        rawScore: 1,
      }),
      expect.objectContaining({
        id: 'wiki/global/support.md',
        path: 'wiki/global/support.md',
        rank: 2,
        rawScore: 0,
      }),
    ]);
  });

  it('restricts lexical candidates to the allowlist', () => {
    const index = new SqliteKnowledgeIndex({ dbPath });
    index.sync([
      page({ path: 'wiki/global/revenue.md', key: 'revenue' }),
      page({ path: 'wiki/global/support.md', key: 'support', content: 'Orders are paid by the support team.' }),
    ]);

    expect(
      index
        .searchLexicalCandidates({ queryText: 'paid', limit: 10, allowedPaths: ['wiki/global/support.md'] })
        .map((row) => row.path),
    ).toEqual(['wiki/global/support.md']);
  });

  it('applies the allowlist before the semantic limit so an in-scope match survives', () => {
    const index = new SqliteKnowledgeIndex({ dbPath });
    index.sync([
      page({ path: 'wiki/global/noise-a.md', key: 'noise-a', embedding: [1, 0] }),
      page({ path: 'wiki/global/noise-b.md', key: 'noise-b', embedding: [1, 0] }),
      page({ path: 'wiki/global/target.md', key: 'target', embedding: [1, 0] }),
    ]);

    // All three tie on similarity; a limit of 1 over the full corpus drops the target.
    expect(index.searchSemanticCandidates({ queryEmbedding: [1, 0], limit: 1 }).map((row) => row.path)).toEqual([
      'wiki/global/noise-a.md',
    ]);

    // Scoped to the target, the limit applies after the allowlist, so it survives.
    expect(
      index
        .searchSemanticCandidates({ queryEmbedding: [1, 0], limit: 1, allowedPaths: ['wiki/global/target.md'] })
        .map((row) => row.path),
    ).toEqual(['wiki/global/target.md']);
  });

  it('treats an empty allowlist as no page in scope', () => {
    const index = new SqliteKnowledgeIndex({ dbPath });
    index.sync([page({ embedding: [1, 0] })]);

    expect(index.searchLexicalCandidates({ queryText: 'paid order', limit: 10, allowedPaths: [] })).toEqual([]);
    expect(index.searchSemanticCandidates({ queryEmbedding: [1, 0], limit: 10, allowedPaths: [] })).toEqual([]);
  });

  it('returns an empty result for blank or punctuation-only queries', () => {
    const index = new SqliteKnowledgeIndex({ dbPath });
    index.rebuild([page()]);

    expect(index.search('   ', 10)).toEqual([]);
    expect(index.search('---', 10)).toEqual([]);
  });
});
