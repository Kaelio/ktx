import { mkdir, mkdtemp, readFile, rm, unlink, writeFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { tmpdir } from 'node:os';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { KtxFileStorePort } from '../../../src/context/core/file-store.js';
import { pruneFinalGateFindings } from '../../../src/context/ingest/final-gate-prune.js';
import { slSourceFilePath } from '../../../src/context/sl/source-files.js';
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

  function tempFileStore(): KtxFileStorePort {
    const absolute = (path: string) => join(tempDir, path);
    const walk = async (root: string): Promise<string[]> => {
      const { readdir, stat } = await import('node:fs/promises');
      const entries = await readdir(root).catch((error: NodeJS.ErrnoException) => {
        if (error.code === 'ENOENT') {
          return [];
        }
        throw error;
      });
      const files: string[] = [];
      for (const entry of entries) {
        const path = join(root, entry);
        const info = await stat(path);
        if (info.isDirectory()) {
          files.push(...(await walk(path)));
        } else {
          files.push(path);
        }
      }
      return files;
    };

    return {
      writeFile: async (path, content) => {
        await mkdir(dirname(absolute(path)), { recursive: true });
        await writeFile(absolute(path), content, 'utf-8');
        return { success: true, commitHash: null, path };
      },
      readFile: async (path) => ({ content: await readFile(absolute(path), 'utf-8') }),
      deleteFile: async (path) => {
        await unlink(absolute(path)).catch((error: NodeJS.ErrnoException) => {
          if (error.code !== 'ENOENT') {
            throw error;
          }
        });
        return { success: true, commitHash: null, path };
      },
      listFiles: async (path) => {
        const root = absolute(path);
        const files = await walk(root);
        return { files: files.map((file) => file.slice(tempDir.length + 1).replaceAll('\\', '/')).sort() };
      },
      getFileHistory: vi.fn(),
      forWorktree: vi.fn(),
    };
  }

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
      semanticLayerFiles: tempFileStore(),
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

  it('prunes a dangling join from an untouched sibling that points at a dropped source', async () => {
    // The gate only flags joins owned by re-ingested (touched) sources, so a
    // pre-existing sibling joining to a just-dropped source produces no
    // missing_join_target finding. The drop must still prune that edge (D5),
    // or the committed orphan join breaks every SL query on the connection.
    await writeFile(
      join(tempDir, 'semantic-layer/warehouse/orders.yaml'),
      'name: orders\ngrain: [id]\ncolumns: [{name: id, type: number}]\njoins:\n  - to: customers\n    on: orders.customer_id = customers.id\nmeasures: []\n',
      'utf-8',
    );
    await writeFile(
      join(tempDir, 'semantic-layer/warehouse/customers.yaml'),
      'name: customers\ngrain: [id]\ncolumns: [{name: id, type: number}]\njoins: []\nmeasures: []\n',
      'utf-8',
    );

    const result = await pruneFinalGateFindings({
      workdir: tempDir,
      semanticLayerFiles: tempFileStore(),
      findings: [
        { kind: 'invalid_source', connectionId: 'warehouse', sourceName: 'customers', errors: ['dry run failed'] },
      ],
      droppedSources: [],
      trace: { event: vi.fn() } as never,
      author: { name: 'ktx Test', email: 'system@ktx.local' },
    });

    await expect(readFile(join(tempDir, 'semantic-layer/warehouse/customers.yaml'), 'utf-8')).rejects.toThrow();
    await expect(readFile(join(tempDir, 'semantic-layer/warehouse/orders.yaml'), 'utf-8')).resolves.not.toContain(
      'customers',
    );
    expect(result.droppedSources).toEqual([
      { connectionId: 'warehouse', sourceName: 'customers', reason: 'dry run failed' },
    ]);
    expect(result.prunedReferences).toEqual([
      {
        kind: 'join',
        artifact: 'semantic-layer/warehouse/orders',
        removedRef: 'customers',
        absentTarget: 'customers',
      },
    ]);
  });

  it('resolves semantic-layer source files by declared source name before pruning or dropping', async () => {
    const ordersPath = slSourceFilePath('warehouse', 'ORDERS');
    const customersPath = slSourceFilePath('warehouse', 'CUSTOMERS');
    await mkdir(dirname(join(tempDir, ordersPath)), { recursive: true });
    await writeFile(
      join(tempDir, ordersPath),
      [
        'name: ORDERS',
        'grain: [ORDER_ID]',
        'columns: [{name: ORDER_ID, type: number}, {name: CUSTOMER_ID, type: number}]',
        'joins:',
        '  - to: CUSTOMERS',
        '    on: ORDERS.CUSTOMER_ID = CUSTOMERS.CUSTOMER_ID',
        'measures: []',
        '',
      ].join('\n'),
      'utf-8',
    );
    await writeFile(
      join(tempDir, customersPath),
      'name: CUSTOMERS\ngrain: [CUSTOMER_ID]\ncolumns: [{name: CUSTOMER_ID, type: number}]\njoins: []\nmeasures: []\n',
      'utf-8',
    );

    const result = await pruneFinalGateFindings({
      workdir: tempDir,
      semanticLayerFiles: tempFileStore(),
      findings: [
        {
          kind: 'invalid_source',
          connectionId: 'warehouse',
          sourceName: 'CUSTOMERS',
          errors: ['dry run failed'],
        },
        {
          kind: 'missing_join_target',
          ownerConnectionId: 'warehouse',
          ownerSourceName: 'ORDERS',
          targetSourceName: 'CUSTOMERS',
          message: 'join target "CUSTOMERS" does not exist',
        },
      ],
      droppedSources: [],
      trace: { event: vi.fn() } as never,
      author: { name: 'ktx Test', email: 'system@ktx.local' },
    });

    await expect(readFile(join(tempDir, customersPath), 'utf-8')).rejects.toThrow();
    await expect(readFile(join(tempDir, ordersPath), 'utf-8')).resolves.not.toContain('to: CUSTOMERS');
    await expect(readFile(join(tempDir, 'semantic-layer/warehouse/CUSTOMERS.yaml'), 'utf-8')).rejects.toThrow();
    await expect(readFile(join(tempDir, 'semantic-layer/warehouse/ORDERS.yaml'), 'utf-8')).rejects.toThrow();
    expect(result.droppedSources).toEqual([
      { connectionId: 'warehouse', sourceName: 'CUSTOMERS', reason: 'dry run failed' },
    ]);
    expect(result.prunedReferences).toEqual([
      {
        kind: 'join',
        artifact: 'semantic-layer/warehouse/ORDERS',
        removedRef: 'CUSTOMERS',
        absentTarget: 'CUSTOMERS',
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
      semanticLayerFiles: tempFileStore(),
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
