import { access, mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { initKtxProject, type KtxLocalProject } from '../../../src/context/project/project.js';
import {
  listLocalKnowledgePageKeys,
  listLocalKnowledgePages,
  listReferencedConnectionIds,
  readLocalKnowledgePage,
  searchLocalKnowledgePages,
  writeLocalKnowledgePage,
} from '../../../src/context/wiki/local-knowledge.js';
import { SqliteKnowledgeIndex } from '../../../src/context/wiki/sqlite-knowledge-index.js';

class FakeEmbeddingPort {
  readonly maxBatchSize = 16;

  async computeEmbedding(text: string): Promise<number[]> {
    return text.toLowerCase().includes('semantic revenue') ? [1, 0] : [0, 1];
  }

  async computeEmbeddingsBulk(texts: string[]): Promise<number[][]> {
    return Promise.all(texts.map((text) => this.computeEmbedding(text)));
  }
}

class ArrSynonymEmbeddingPort {
  readonly maxBatchSize = 16;

  async computeEmbedding(text: string): Promise<number[]> {
    const lower = text.toLowerCase();
    if (lower.trim() === 'annual recurring revenue' || lower.includes('arr') || lower.includes('contract-first')) {
      return [1, 0];
    }
    if (lower.includes('net revenue') || lower.includes('gross') || lower.includes('refund')) {
      return [0, 1];
    }
    return [0.5, 0.5];
  }

  async computeEmbeddingsBulk(texts: string[]): Promise<number[][]> {
    return Promise.all(texts.map((text) => this.computeEmbedding(text)));
  }
}

describe('local knowledge helpers', () => {
  let tempDir: string;
  let project: KtxLocalProject;

  beforeEach(async () => {
    tempDir = await mkdtemp(join(tmpdir(), 'ktx-local-knowledge-'));
    project = await initKtxProject({ projectDir: join(tempDir, 'project') });
  });

  afterEach(async () => {
    await rm(tempDir, { recursive: true, force: true });
  });

  it('writes, reads, lists, and searches global wiki pages', async () => {
    const write = await writeLocalKnowledgePage(project, {
      key: 'metrics-revenue',
      scope: 'GLOBAL',
      summary: 'Revenue metric definition',
      content: 'Revenue is recognized when an order is paid.',
      tags: ['finance'],
      refs: ['semantic-layer/warehouse/orders.yaml'],
      slRefs: ['orders'],
    });

    expect(write.path).toBe('wiki/global/metrics-revenue.md');
    expect(write.operation).toBe('write');

    await expect(readLocalKnowledgePage(project, { key: 'metrics-revenue', userId: 'local' })).resolves.toMatchObject({
      key: 'metrics-revenue',
      scope: 'GLOBAL',
      summary: 'Revenue metric definition',
      content: 'Revenue is recognized when an order is paid.',
      tags: ['finance'],
      refs: ['semantic-layer/warehouse/orders.yaml'],
      slRefs: ['orders'],
    });

    await expect(listLocalKnowledgePages(project, { userId: 'local' })).resolves.toEqual([
      {
        key: 'metrics-revenue',
        path: 'wiki/global/metrics-revenue.md',
        scope: 'GLOBAL',
        summary: 'Revenue metric definition',
      },
    ]);

    const search = await searchLocalKnowledgePages(project, { query: 'paid order', userId: 'local' });
    expect(search).toEqual([
      expect.objectContaining({
        key: 'metrics-revenue',
        path: 'wiki/global/metrics-revenue.md',
        scope: 'GLOBAL',
        score: expect.any(Number),
        matchReasons: expect.arrayContaining(['lexical']),
        lanes: expect.arrayContaining([expect.objectContaining({ lane: 'lexical', status: 'available' })]),
      }),
    ]);
    expect(search[0]?.score).toBeGreaterThan(0);
    await expect(access(join(project.projectDir, '.ktx', 'db.sqlite'))).resolves.toBeUndefined();
  });

  it('lists page keys across scopes, deduped and sorted, for completion', async () => {
    await writeLocalKnowledgePage(project, {
      key: 'metrics-revenue',
      scope: 'GLOBAL',
      summary: 'Revenue metric definition',
      content: 'Revenue is recognized when an order is paid.',
    });
    await writeLocalKnowledgePage(project, {
      key: 'metrics-churn',
      scope: 'USER',
      userId: 'local',
      summary: 'Churn metric definition',
      content: 'Churn is measured monthly.',
    });
    // Same key in both scopes must collapse to a single completion candidate.
    await writeLocalKnowledgePage(project, {
      key: 'metrics-revenue',
      scope: 'USER',
      userId: 'local',
      summary: 'User override of revenue',
      content: 'Local revenue note.',
    });

    await expect(listLocalKnowledgePageKeys(project, { userId: 'local' })).resolves.toEqual([
      'metrics-churn',
      'metrics-revenue',
    ]);
  });

  it('adds the token lane alongside lexical wiki matches', async () => {
    await writeLocalKnowledgePage(project, {
      key: 'metrics-revenue',
      scope: 'GLOBAL',
      summary: 'Revenue metric definition',
      content: 'Revenue is recognized when an order is paid.',
      tags: ['finance'],
    });

    const search = await searchLocalKnowledgePages(project, { query: 'paid---', userId: 'local', limit: 5 });

    expect(search[0]).toMatchObject({
      key: 'metrics-revenue',
      matchReasons: expect.arrayContaining(['token']),
      lanes: expect.arrayContaining([expect.objectContaining({ lane: 'token', status: 'available' })]),
    });
  });

  it('uses stored page embeddings when a wiki embedding backend is configured', async () => {
    await writeLocalKnowledgePage(project, {
      key: 'metrics-revenue',
      scope: 'GLOBAL',
      summary: 'Semantic revenue definition',
      content: 'Revenue search text.',
      tags: ['finance'],
    });
    await writeLocalKnowledgePage(project, {
      key: 'support-escalations',
      scope: 'GLOBAL',
      summary: 'Support escalation process',
      content: 'Support search text.',
      tags: ['operations'],
    });

    const search = await searchLocalKnowledgePages(project, {
      query: 'semantic revenue',
      userId: 'local',
      limit: 5,
      embeddingService: new FakeEmbeddingPort(),
    });

    expect(search[0]).toMatchObject({
      key: 'metrics-revenue',
      matchReasons: expect.arrayContaining(['semantic']),
      lanes: expect.arrayContaining([expect.objectContaining({ lane: 'semantic', status: 'available' })]),
    });
  });

  it('ranks ARR synonym queries by semantic page embeddings over stronger lexical revenue matches', async () => {
    await writeLocalKnowledgePage(project, {
      key: 'arr-definition',
      scope: 'GLOBAL',
      summary: 'ARR is calculated contract-first for active customer contracts.',
      content: 'Contract-first active contract value takes precedence over subscription values.',
      tags: ['arr', 'contracts', 'finance'],
    });
    await writeLocalKnowledgePage(project, {
      key: 'net-revenue-definition',
      scope: 'GLOBAL',
      summary: 'Net revenue definition',
      content: 'Annual revenue is gross invoice revenue minus credits and refunds.',
      tags: ['revenue', 'finance'],
    });

    const search = await searchLocalKnowledgePages(project, {
      query: 'annual recurring revenue',
      userId: 'local',
      limit: 2,
      embeddingService: new ArrSynonymEmbeddingPort(),
    });

    expect(search.map((result) => result.key)).toEqual(['arr-definition', 'net-revenue-definition']);
    expect(search[0]).toMatchObject({
      key: 'arr-definition',
      matchReasons: expect.arrayContaining(['semantic']),
      lanes: expect.arrayContaining([expect.objectContaining({ lane: 'semantic', status: 'available' })]),
    });
  });

  it('reports semantic lane as skipped when wiki embeddings are not configured', async () => {
    await writeLocalKnowledgePage(project, {
      key: 'metrics-revenue',
      scope: 'GLOBAL',
      summary: 'Revenue metric definition',
      content: 'Revenue is recognized when an order is paid.',
      tags: ['finance'],
    });

    const search = await searchLocalKnowledgePages(project, { query: 'revenue', userId: 'local', limit: 5 });

    expect(search[0]?.lanes).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ lane: 'semantic', status: 'skipped', reason: 'embedding_unconfigured' }),
      ]),
    );
  });

  it('prefers user knowledge over global pages with the same key', async () => {
    await writeLocalKnowledgePage(project, {
      key: 'handoff',
      scope: 'GLOBAL',
      summary: 'Global handoff',
      content: 'Global context.',
    });
    await writeLocalKnowledgePage(project, {
      key: 'handoff',
      scope: 'USER',
      userId: 'agent-1',
      summary: 'User handoff',
      content: 'User context.',
    });

    await expect(readLocalKnowledgePage(project, { key: 'handoff', userId: 'agent-1' })).resolves.toMatchObject({
      scope: 'USER',
      summary: 'User handoff',
    });
  });

  it('serializes historic-SQL frontmatter fields for global pages', async () => {
    await writeLocalKnowledgePage(project, {
      key: 'monthly-paid-orders',
      scope: 'GLOBAL',
      summary: 'Monthly paid orders',
      content: '## Monthly paid order count',
      tags: ['historic-sql', 'query-pattern'],
      slRefs: ['analytics.orders'],
      source: 'historic-sql',
      intent: 'Monthly paid order count',
      tables: ['analytics.orders'],
      representativeSql: "SELECT count(*) FROM analytics.orders WHERE status = 'paid'",
      usage: {
        executions: 42,
        distinct_users: 3,
        first_seen: '2026-02-01',
        last_seen: '2026-05-04',
        p50_runtime_ms: 100,
        p95_runtime_ms: 200,
        error_rate: 0,
        rows_produced: 42,
      },
      fingerprints: ['fp_paid_orders'],
    });

    const raw = await project.fileStore.readFile('wiki/global/monthly-paid-orders.md');
    expect(raw.content).toContain('source: historic-sql');
    expect(raw.content).toContain('intent: Monthly paid order count');
    expect(raw.content).toContain(['tables:', '  - analytics.orders'].join('\n'));
    expect(raw.content).toContain("representative_sql: SELECT count(*) FROM analytics.orders WHERE status = 'paid'");
    expect(raw.content).toContain(['usage:', '  executions: 42', '  distinct_users: 3'].join('\n'));
    expect(raw.content).toContain(['fingerprints:', '  - fp_paid_orders'].join('\n'));
  });

  it('round-trips a connections list through write, read, and list', async () => {
    await writeLocalKnowledgePage(project, {
      key: 'orders-sales-db',
      scope: 'GLOBAL',
      summary: 'Orders concept for the sales database',
      content: 'In sales_db, orders are recognized when paid.',
      connections: ['sales_db'],
    });

    const raw = await project.fileStore.readFile('wiki/global/orders-sales-db.md');
    expect(raw.content).toContain(['connections:', '  - sales_db'].join('\n'));

    await expect(readLocalKnowledgePage(project, { key: 'orders-sales-db', userId: 'local' })).resolves.toMatchObject({
      key: 'orders-sales-db',
      connections: ['sales_db'],
    });
  });

  it('normalizes a single connections string to a list at parse time', async () => {
    await project.fileStore.writeFile(
      'wiki/global/single-scoped.md',
      '---\nsummary: Single connection as scalar\nusage_mode: auto\nconnections: events_db\n---\n\nBody\n',
      'Test',
      'test@example.com',
      'Write scalar connections page',
    );

    await expect(readLocalKnowledgePage(project, { key: 'single-scoped', userId: 'local' })).resolves.toMatchObject({
      key: 'single-scoped',
      connections: ['events_db'],
    });
  });

  it('treats an absent connections field as unscoped (empty list)', async () => {
    await writeLocalKnowledgePage(project, {
      key: 'fiscal-year',
      scope: 'GLOBAL',
      summary: 'Org-wide fiscal year',
      content: 'Fiscal year starts in February.',
    });

    await expect(readLocalKnowledgePage(project, { key: 'fiscal-year', userId: 'local' })).resolves.toMatchObject({
      key: 'fiscal-year',
      connections: [],
    });
  });

  it('scopes search to unscoped pages plus pages listing the requested connection', async () => {
    await writeLocalKnowledgePage(project, {
      key: 'orders-sales-db',
      scope: 'GLOBAL',
      summary: 'Sales DB orders',
      content: 'Orders are paid in the sales database.',
      connections: ['sales_db'],
    });
    await writeLocalKnowledgePage(project, {
      key: 'orders-events-db',
      scope: 'GLOBAL',
      summary: 'Events DB orders',
      content: 'Orders are paid in the events database.',
      connections: ['events_db'],
    });
    await writeLocalKnowledgePage(project, {
      key: 'orders-global',
      scope: 'GLOBAL',
      summary: 'Org-wide orders note',
      content: 'Orders are paid everywhere in the org.',
    });

    const scoped = await searchLocalKnowledgePages(project, {
      query: 'orders paid',
      userId: 'local',
      connectionId: 'sales_db',
    });
    const keys = scoped.map((result) => result.key).sort();
    expect(keys).toEqual(['orders-global', 'orders-sales-db']);
    expect(keys).not.toContain('orders-events-db');

    const unfiltered = await searchLocalKnowledgePages(project, { query: 'orders paid', userId: 'local' });
    expect(unfiltered.map((result) => result.key).sort()).toEqual([
      'orders-events-db',
      'orders-global',
      'orders-sales-db',
    ]);
  });

  it('keeps other-connection pages and embeddings in the sqlite index after a scoped search', async () => {
    const embedding = new FakeEmbeddingPort();
    await writeLocalKnowledgePage(project, {
      key: 'orders-sales-db',
      scope: 'GLOBAL',
      summary: 'Sales DB orders',
      content: 'Orders are paid in the sales database.',
      connections: ['sales_db'],
    });
    await writeLocalKnowledgePage(project, {
      key: 'orders-events-db',
      scope: 'GLOBAL',
      summary: 'Events DB orders',
      content: 'Orders are paid in the events database.',
      connections: ['events_db'],
    });

    const scoped = await searchLocalKnowledgePages(project, {
      query: 'orders paid',
      userId: 'local',
      connectionId: 'sales_db',
      embeddingService: embedding,
    });
    expect(scoped.map((result) => result.key)).toEqual(['orders-sales-db']);

    // A connection-scoped search must not prune the other connection's page (or
    // its cached embedding) from the shared persistent index.
    const index = new SqliteKnowledgeIndex({ dbPath: join(project.projectDir, '.ktx', 'db.sqlite') });
    const indexed = index.getExistingPages();
    expect([...indexed.keys()].sort()).toEqual([
      'wiki/global/orders-events-db.md',
      'wiki/global/orders-sales-db.md',
    ]);
    expect(indexed.get('wiki/global/orders-events-db.md')?.embedding).not.toBeNull();
  });

  it('filters search per connection across lexical and token lanes when embeddings are disabled', async () => {
    await writeLocalKnowledgePage(project, {
      key: 'rfm-events-db',
      scope: 'GLOBAL',
      summary: 'RFM definition for events_db',
      content: 'RFM segmentation rules for the events database.',
      connections: ['events_db'],
    });
    await writeLocalKnowledgePage(project, {
      key: 'rfm-sales-db',
      scope: 'GLOBAL',
      summary: 'RFM definition for sales_db',
      content: 'RFM segmentation rules for the sales database.',
      connections: ['sales_db'],
    });

    const lexical = await searchLocalKnowledgePages(project, {
      query: 'rfm segmentation',
      userId: 'local',
      connectionId: 'events_db',
    });
    expect(lexical.map((result) => result.key)).toEqual(['rfm-events-db']);

    const token = await searchLocalKnowledgePages(project, {
      query: 'segmentation---',
      userId: 'local',
      connectionId: 'events_db',
    });
    expect(token.map((result) => result.key)).toEqual(['rfm-events-db']);
  });

  it('filters list output by connection while keeping unscoped pages', async () => {
    await writeLocalKnowledgePage(project, {
      key: 'orders-sales-db',
      scope: 'GLOBAL',
      summary: 'Sales DB orders',
      content: 'Sales orders.',
      connections: ['sales_db'],
    });
    await writeLocalKnowledgePage(project, {
      key: 'orders-events-db',
      scope: 'GLOBAL',
      summary: 'Events DB orders',
      content: 'Events orders.',
      connections: ['events_db'],
    });
    await writeLocalKnowledgePage(project, {
      key: 'orders-global',
      scope: 'GLOBAL',
      summary: 'Org-wide orders',
      content: 'Global orders.',
    });

    const scoped = await listLocalKnowledgePages(project, { userId: 'local', connectionId: 'sales_db' });
    expect(scoped.map((page) => page.key).sort()).toEqual(['orders-global', 'orders-sales-db']);
  });

  it('keeps a page referencing an unconfigured connection searchable and readable', async () => {
    await writeLocalKnowledgePage(project, {
      key: 'rfm-removed-db',
      scope: 'GLOBAL',
      summary: 'RFM for a since-removed database',
      content: 'RFM rules.',
      connections: ['removed_db'],
    });

    await expect(readLocalKnowledgePage(project, { key: 'rfm-removed-db', userId: 'local' })).resolves.toMatchObject({
      key: 'rfm-removed-db',
      connections: ['removed_db'],
    });
    const search = await searchLocalKnowledgePages(project, { query: 'rfm rules', userId: 'local' });
    expect(search.map((result) => result.key)).toContain('rfm-removed-db');
    await expect(listReferencedConnectionIds(project, { userId: 'local' })).resolves.toEqual(['removed_db']);
  });

  it('falls back to Markdown scanning when the config does not select sqlite-fts5', async () => {
    project.config.storage.search = 'postgres-hybrid';
    await writeLocalKnowledgePage(project, {
      key: 'metrics-revenue',
      scope: 'GLOBAL',
      summary: 'Revenue metric definition',
      content: 'Revenue is recognized when an order is paid.',
      tags: ['finance'],
    });

    await expect(searchLocalKnowledgePages(project, { query: 'paid order', userId: 'local' })).resolves.toEqual([
      expect.objectContaining({
        key: 'metrics-revenue',
        score: 3,
        matchReasons: ['token'],
      }),
    ]);
  });

  it('rejects unsafe knowledge keys', async () => {
    await expect(
      writeLocalKnowledgePage(project, {
        key: '../secret',
        scope: 'GLOBAL',
        summary: 'bad',
        content: 'bad',
      }),
    ).rejects.toThrow('Invalid wiki key "../secret". Wiki keys must be flat; use "secret".');
  });

  it('rejects slash-delimited knowledge keys with a flat-key suggestion', async () => {
    await expect(
      writeLocalKnowledgePage(project, {
        key: 'orbit/company-overview',
        scope: 'GLOBAL',
        summary: 'bad',
        content: 'bad',
      }),
    ).rejects.toThrow('Invalid wiki key "orbit/company-overview". Wiki keys must be flat; use "orbit-company-overview".');
  });

  it('ignores nested historic-SQL legacy paths when listing local wiki pages', async () => {
    await writeLocalKnowledgePage(project, {
      key: 'historic-sql-paid-orders',
      scope: 'GLOBAL',
      summary: 'Flat historic SQL page',
      content: 'Flat page body.',
      tags: ['historic-sql'],
    });
    await project.fileStore.writeFile(
      'wiki/global/historic-sql/paid-orders.md',
      '---\nsummary: Nested historic SQL page\nusage_mode: auto\n---\n\nNested body\n',
      'Test',
      'test@example.com',
      'Write nested legacy page',
    );

    await expect(listLocalKnowledgePages(project, { userId: 'local' })).resolves.toEqual([
      {
        key: 'historic-sql-paid-orders',
        path: 'wiki/global/historic-sql-paid-orders.md',
        scope: 'GLOBAL',
        summary: 'Flat historic SQL page',
      },
    ]);
  });
});
