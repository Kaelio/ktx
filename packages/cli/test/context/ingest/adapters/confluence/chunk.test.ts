import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { chunkConfluenceStagedDir, PAGES_PER_UNIT } from '../../../../../src/context/ingest/adapters/confluence/chunk.js';

const FIXTURES = resolve(import.meta.dirname, '../../../../fixtures/confluence');
const SINGLE = join(FIXTURES, 'single-space');
const MULTI = join(FIXTURES, 'multi-space');
const EMPTY = join(FIXTURES, 'empty-manifest');

describe('chunkConfluenceStagedDir — first run', () => {
  it('single-space fixture emits one WU', async () => {
    const result = await chunkConfluenceStagedDir(SINGLE);
    expect(result.workUnits).toHaveLength(1);
  });

  it('single-space WU has correct unitKey', async () => {
    const result = await chunkConfluenceStagedDir(SINGLE);
    expect(result.workUnits[0]!.unitKey).toBe('confluence-pages');
  });

  it('single-space WU displayLabel contains space key', async () => {
    const result = await chunkConfluenceStagedDir(SINGLE);
    expect(result.workUnits[0]!.displayLabel).toMatch(/Confluence/);
  });

  it('single-space WU rawFiles contains all page files and the manifest', async () => {
    const result = await chunkConfluenceStagedDir(SINGLE);
    const wu = result.workUnits[0]!;
    expect(wu.rawFiles).toContain('pages/page-aaa111.json');
    expect(wu.rawFiles).toContain('pages/page-bbb222.json');
    expect(wu.rawFiles).toContain('confluence-manifest.json');
  });

  it('single-space WU peerFileIndex excludes rawFiles', async () => {
    const result = await chunkConfluenceStagedDir(SINGLE);
    const wu = result.workUnits[0]!;
    const rawSet = new Set(wu.rawFiles);
    for (const peer of wu.peerFileIndex) {
      expect(rawSet.has(peer)).toBe(false);
    }
  });

  it('multi-space fixture emits one WU with pages from both spaces', async () => {
    const result = await chunkConfluenceStagedDir(MULTI);
    expect(result.workUnits).toHaveLength(1);
    const wu = result.workUnits[0]!;
    expect(wu.rawFiles).toContain('pages/page-aaa111.json');
    expect(wu.rawFiles).toContain('pages/page-bbb222.json');
    expect(wu.rawFiles).toContain('pages/page-ccc333.json');
  });

  it('empty-manifest fixture emits zero WUs', async () => {
    const result = await chunkConfluenceStagedDir(EMPTY);
    expect(result.workUnits).toHaveLength(0);
  });

  it('missing directory emits zero WUs without crashing', async () => {
    const result = await chunkConfluenceStagedDir('/tmp/confluence-nonexistent-ktx-test');
    expect(result.workUnits).toHaveLength(0);
  });

  it('is deterministic: two identical calls produce structurally equal output', async () => {
    const r1 = await chunkConfluenceStagedDir(SINGLE);
    const r2 = await chunkConfluenceStagedDir(SINGLE);
    expect(JSON.stringify(r1)).toBe(JSON.stringify(r2));
  });

  it('dependencyPaths is empty on first run', async () => {
    const result = await chunkConfluenceStagedDir(SINGLE);
    for (const wu of result.workUnits) {
      expect(wu.dependencyPaths).toEqual([]);
    }
  });

  it('unitKey is slug-safe (no slashes or spaces)', async () => {
    const result = await chunkConfluenceStagedDir(SINGLE);
    for (const wu of result.workUnits) {
      expect(wu.unitKey).toMatch(/^[a-zA-Z0-9_-]+$/);
    }
  });
});

describe('chunkConfluenceStagedDir — page batching', () => {
  let stagedDir: string;

  beforeEach(async () => {
    stagedDir = await mkdtemp(join(tmpdir(), 'confluence-batch-'));
    await mkdir(join(stagedDir, 'pages'), { recursive: true });
    const manifest = JSON.stringify({
      confluenceConnectionId: 'conn-1',
      baseUrl: 'https://example.atlassian.net',
      fetchedAt: new Date().toISOString(),
      spaceCount: 1,
      pageCount: PAGES_PER_UNIT + 1,
      capped: false,
    });
    await writeFile(join(stagedDir, 'confluence-manifest.json'), manifest);
    for (let i = 0; i < PAGES_PER_UNIT + 1; i++) {
      const page = JSON.stringify({
        pageId: `page-${i}`,
        spaceId: 'space-1',
        spaceKey: 'ENG',
        spaceName: 'Engineering',
        title: `Page ${i}`,
        parentId: null,
        breadcrumb: `Engineering > Page ${i}`,
        url: `https://example.atlassian.net/wiki/spaces/ENG/pages/${i}`,
        lastEditedAt: '2026-01-01T00:00:00.000Z',
        version: 1,
        status: 'current',
        contentStorage: '<p>Content</p>',
      });
      await writeFile(join(stagedDir, 'pages', `page-${String(i).padStart(6, '0')}.json`), page);
    }
  });

  afterEach(async () => {
    await rm(stagedDir, { recursive: true, force: true });
  });

  it('splits into two WUs when page count exceeds PAGES_PER_UNIT', async () => {
    const result = await chunkConfluenceStagedDir(stagedDir);
    expect(result.workUnits).toHaveLength(2);
  });

  it('batched WUs get indexed unitKeys (confluence-pages-0, confluence-pages-1)', async () => {
    const result = await chunkConfluenceStagedDir(stagedDir);
    const keys = result.workUnits.map((w) => w.unitKey).sort();
    expect(keys).toEqual(['confluence-pages-0', 'confluence-pages-1']);
  });

  it('first batch has exactly PAGES_PER_UNIT files plus manifest', async () => {
    const result = await chunkConfluenceStagedDir(stagedDir);
    const wu = result.workUnits.find((w) => w.unitKey === 'confluence-pages-0')!;
    expect(wu.rawFiles).toHaveLength(PAGES_PER_UNIT + 1);
  });

  it('displayLabel includes batch position when split', async () => {
    const result = await chunkConfluenceStagedDir(stagedDir);
    const wu = result.workUnits.find((w) => w.unitKey === 'confluence-pages-0')!;
    expect(wu.displayLabel).toMatch(/\(1\/2\)/);
  });
});

describe('chunkConfluenceStagedDir — diffSet re-sync', () => {
  let stagedDir: string;

  beforeEach(async () => {
    stagedDir = await mkdtemp(join(tmpdir(), 'confluence-diff-'));
    await mkdir(join(stagedDir, 'pages'), { recursive: true });
    const fs = await import('node:fs/promises');
    const manifestBody = await fs.readFile(join(SINGLE, 'confluence-manifest.json'), 'utf-8');
    await writeFile(join(stagedDir, 'confluence-manifest.json'), manifestBody);
    for (const file of ['page-aaa111.json', 'page-bbb222.json']) {
      const body = await fs.readFile(join(SINGLE, 'pages', file), 'utf-8');
      await writeFile(join(stagedDir, 'pages', file), body);
    }
  });

  afterEach(async () => {
    await rm(stagedDir, { recursive: true, force: true });
  });

  it('only the WU containing the modified file is kept', async () => {
    const result = await chunkConfluenceStagedDir(stagedDir, {
      diffSet: {
        added: [],
        modified: ['pages/page-aaa111.json'],
        deleted: [],
        unchanged: ['pages/page-bbb222.json', 'confluence-manifest.json'],
      },
    });
    expect(result.workUnits).toHaveLength(1);
    expect(result.workUnits[0]!.rawFiles).toEqual(['pages/page-aaa111.json']);
  });

  it('unchanged sibling page moves to dependencyPaths', async () => {
    const result = await chunkConfluenceStagedDir(stagedDir, {
      diffSet: {
        added: [],
        modified: ['pages/page-aaa111.json'],
        deleted: [],
        unchanged: ['pages/page-bbb222.json', 'confluence-manifest.json'],
      },
    });
    expect(result.workUnits[0]!.dependencyPaths).toContain('pages/page-bbb222.json');
  });

  it('all-unchanged diffSet produces zero WUs and no eviction', async () => {
    const result = await chunkConfluenceStagedDir(stagedDir, {
      diffSet: {
        added: [],
        modified: [],
        deleted: [],
        unchanged: ['pages/page-aaa111.json', 'pages/page-bbb222.json', 'confluence-manifest.json'],
      },
    });
    expect(result.workUnits).toHaveLength(0);
    expect(result.eviction).toBeUndefined();
  });

  it('deleted paths produce an eviction unit listing those paths', async () => {
    const result = await chunkConfluenceStagedDir(stagedDir, {
      diffSet: {
        added: [],
        modified: [],
        deleted: ['pages/page-aaa111.json'],
        unchanged: ['pages/page-bbb222.json', 'confluence-manifest.json'],
      },
    });
    expect(result.eviction?.deletedRawPaths).toContain('pages/page-aaa111.json');
  });
});
