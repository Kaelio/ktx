import { mkdir, readFile, rm, mkdtemp, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { ConfluenceClientFactory, ConfluenceRuntimeClient } from '../../../../../src/context/ingest/adapters/confluence/client-port.js';
import { fetchConfluenceBundle } from '../../../../../src/context/ingest/adapters/confluence/fetch.js';

const TEST_PULL_CONFIG = { confluenceConnectionId: 'confluence-prod' };

function makeSpace(id: string, key: string, name: string) {
  return { id, key, name, type: 'global', status: 'current' };
}

function makeSummary(id: string, title: string, version: number, createdAt: string, parentId: string | null = null) {
  return {
    id,
    title,
    spaceId: 'space-1',
    parentId,
    status: 'current',
    version: { number: version, createdAt },
    _links: { webui: `/spaces/ENG/pages/${id}` },
  };
}

function makeFactory(client: Partial<ConfluenceRuntimeClient>): ConfluenceClientFactory {
  const fullClient: ConfluenceRuntimeClient = {
    baseUrl: 'https://example.atlassian.net',
    listSpaces: vi.fn().mockResolvedValue([]),
    listPagesInSpace: vi.fn().mockResolvedValue([]),
    getPageWithBody: vi.fn(),
    testConnection: vi.fn().mockResolvedValue({ success: true }),
    cleanup: vi.fn().mockResolvedValue(undefined),
    ...client,
  };
  return {
    createClient: vi.fn().mockResolvedValue(fullClient),
  };
}

describe('fetchConfluenceBundle', () => {
  let stagedDir: string;

  beforeEach(async () => {
    stagedDir = await mkdtemp(join(tmpdir(), 'confluence-fetch-'));
  });

  afterEach(async () => {
    await rm(stagedDir, { recursive: true, force: true });
  });

  it('creates confluence-manifest.json after a successful fetch', async () => {
    const factory = makeFactory({
      listSpaces: vi.fn().mockResolvedValue([makeSpace('space-1', 'ENG', 'Engineering')]),
      listPagesInSpace: vi.fn().mockResolvedValue([makeSummary('page-1', 'Runbook', 1, '2026-01-01T00:00:00Z')]),
      getPageWithBody: vi.fn().mockResolvedValue({ body: { storage: { value: '<p>content</p>' } } }),
    });
    await fetchConfluenceBundle({ pullConfig: TEST_PULL_CONFIG, stagedDir, ctx: {} as never, clientFactory: factory });
    const manifest = JSON.parse(await readFile(join(stagedDir, 'confluence-manifest.json'), 'utf-8'));
    expect(manifest.confluenceConnectionId).toBe('confluence-prod');
    expect(manifest.pageCount).toBe(1);
    expect(manifest.fetchedAt).toBeDefined();
  });

  it('skips re-fetching the body for a page whose version and lastEditedAt are unchanged', async () => {
    await mkdir(join(stagedDir, 'pages'), { recursive: true });
    await writeFile(
      join(stagedDir, 'pages', 'page-1.json'),
      JSON.stringify({
        pageId: 'page-1', spaceId: 'space-1', spaceKey: 'ENG', spaceName: 'Engineering',
        title: 'Runbook', parentId: null, breadcrumb: 'Engineering > Runbook',
        url: 'https://example.atlassian.net/wiki/spaces/ENG/pages/page-1',
        lastEditedAt: '2026-01-01T00:00:00Z', version: 1, status: 'current', contentStorage: '<p>old</p>',
      }),
      'utf-8',
    );
    const getPageWithBodyMock = vi.fn();
    const factory = makeFactory({
      listSpaces: vi.fn().mockResolvedValue([makeSpace('space-1', 'ENG', 'Engineering')]),
      listPagesInSpace: vi.fn().mockResolvedValue([makeSummary('page-1', 'Runbook', 1, '2026-01-01T00:00:00Z')]),
      getPageWithBody: getPageWithBodyMock,
    });
    await fetchConfluenceBundle({ pullConfig: TEST_PULL_CONFIG, stagedDir, ctx: {} as never, clientFactory: factory });
    expect(getPageWithBodyMock).not.toHaveBeenCalled();
    const manifest = JSON.parse(await readFile(join(stagedDir, 'confluence-manifest.json'), 'utf-8'));
    expect(manifest.pageCount).toBe(1);
  });

  it('re-fetches the body when the page version has changed', async () => {
    await mkdir(join(stagedDir, 'pages'), { recursive: true });
    await writeFile(
      join(stagedDir, 'pages', 'page-1.json'),
      JSON.stringify({
        pageId: 'page-1', spaceId: 'space-1', spaceKey: 'ENG', spaceName: 'Engineering',
        title: 'Runbook', parentId: null, breadcrumb: 'Engineering > Runbook',
        url: 'https://example.atlassian.net/wiki/spaces/ENG/pages/page-1',
        lastEditedAt: '2026-01-01T00:00:00Z', version: 1, status: 'current', contentStorage: '<p>old</p>',
      }),
      'utf-8',
    );
    const getPageWithBodyMock = vi.fn().mockResolvedValue({ body: { storage: { value: '<p>new</p>' } } });
    const factory = makeFactory({
      listSpaces: vi.fn().mockResolvedValue([makeSpace('space-1', 'ENG', 'Engineering')]),
      listPagesInSpace: vi.fn().mockResolvedValue([makeSummary('page-1', 'Runbook', 2, '2026-02-01T00:00:00Z')]),
      getPageWithBody: getPageWithBodyMock,
    });
    await fetchConfluenceBundle({ pullConfig: TEST_PULL_CONFIG, stagedDir, ctx: {} as never, clientFactory: factory });
    expect(getPageWithBodyMock).toHaveBeenCalledWith('page-1');
    const written = JSON.parse(await readFile(join(stagedDir, 'pages', 'page-1.json'), 'utf-8'));
    expect(written.contentStorage).toBe('<p>new</p>');
    expect(written.version).toBe(2);
  });

  it('removes the staged file when a page is no longer returned by the API', async () => {
    await mkdir(join(stagedDir, 'pages'), { recursive: true });
    await writeFile(
      join(stagedDir, 'pages', 'page-stale.json'),
      JSON.stringify({
        pageId: 'page-stale', spaceId: 'space-1', spaceKey: 'ENG', spaceName: 'Engineering',
        title: 'Deleted Page', parentId: null, breadcrumb: 'Engineering > Deleted Page',
        url: 'https://example.atlassian.net/wiki/spaces/ENG/pages/page-stale',
        lastEditedAt: '2026-01-01T00:00:00Z', version: 1, status: 'current', contentStorage: '<p>gone</p>',
      }),
      'utf-8',
    );
    const factory = makeFactory({
      listSpaces: vi.fn().mockResolvedValue([makeSpace('space-1', 'ENG', 'Engineering')]),
      listPagesInSpace: vi.fn().mockResolvedValue([makeSummary('page-active', 'Active Page', 1, '2026-01-01T00:00:00Z')]),
      getPageWithBody: vi.fn().mockResolvedValue({ body: { storage: { value: '<p>active</p>' } } }),
    });
    await fetchConfluenceBundle({ pullConfig: TEST_PULL_CONFIG, stagedDir, ctx: {} as never, clientFactory: factory });
    await expect(readFile(join(stagedDir, 'pages', 'page-stale.json'), 'utf-8')).rejects.toThrow();
    await expect(readFile(join(stagedDir, 'pages', 'page-active.json'), 'utf-8')).resolves.toBeDefined();
  });

  it('preserves the previously staged file when a page body fetch fails (transient error)', async () => {
    await mkdir(join(stagedDir, 'pages'), { recursive: true });
    const staged = {
      pageId: 'page-1', spaceId: 'space-1', spaceKey: 'ENG', spaceName: 'Engineering',
      title: 'Runbook', parentId: null, breadcrumb: 'Engineering > Runbook',
      url: 'https://example.atlassian.net/wiki/spaces/ENG/pages/page-1',
      lastEditedAt: '2026-01-01T00:00:00Z', version: 1, status: 'current', contentStorage: '<p>old</p>',
    };
    await writeFile(join(stagedDir, 'pages', 'page-1.json'), JSON.stringify(staged), 'utf-8');
    const factory = makeFactory({
      listSpaces: vi.fn().mockResolvedValue([makeSpace('space-1', 'ENG', 'Engineering')]),
      listPagesInSpace: vi.fn().mockResolvedValue([makeSummary('page-1', 'Runbook', 2, '2026-02-01T00:00:00Z')]),
      getPageWithBody: vi.fn().mockRejectedValue(new Error('timeout')),
    });
    await fetchConfluenceBundle({ pullConfig: TEST_PULL_CONFIG, stagedDir, ctx: {} as never, clientFactory: factory });
    // File is untouched (still the stale v1 content) rather than deleted or nulled out.
    const written = JSON.parse(await readFile(join(stagedDir, 'pages', 'page-1.json'), 'utf-8'));
    expect(written.version).toBe(1);
  });

  it('does not count a page whose body fetch failed on first fetch toward pageCount', async () => {
    const factory = makeFactory({
      listSpaces: vi.fn().mockResolvedValue([makeSpace('space-1', 'ENG', 'Engineering')]),
      listPagesInSpace: vi.fn().mockResolvedValue([
        makeSummary('page-good', 'Good Page', 1, '2026-01-01T00:00:00Z'),
        makeSummary('page-broken', 'Broken Page', 1, '2026-01-01T00:00:00Z'),
      ]),
      getPageWithBody: vi
        .fn()
        .mockResolvedValueOnce({ body: { storage: { value: '<p>ok</p>' } } })
        .mockRejectedValueOnce(new Error('500')),
    });
    await fetchConfluenceBundle({ pullConfig: TEST_PULL_CONFIG, stagedDir, ctx: {} as never, clientFactory: factory });
    const manifest = JSON.parse(await readFile(join(stagedDir, 'confluence-manifest.json'), 'utf-8'));
    expect(manifest.pageCount).toBe(1);
    await expect(readFile(join(stagedDir, 'pages', 'page-broken.json'), 'utf-8')).rejects.toThrow();
  });

  it('continues fetching other spaces when listing pages in one space fails', async () => {
    const factory = makeFactory({
      listSpaces: vi.fn().mockResolvedValue([
        makeSpace('space-1', 'ENG', 'Engineering'),
        makeSpace('space-2', 'SEC', 'Security'),
      ]),
      listPagesInSpace: vi
        .fn()
        .mockRejectedValueOnce(new Error('forbidden'))
        .mockResolvedValueOnce([makeSummary('page-1', 'Policy', 1, '2026-01-01T00:00:00Z')]),
      getPageWithBody: vi.fn().mockResolvedValue({ body: { storage: { value: '<p>policy</p>' } } }),
    });
    await fetchConfluenceBundle({ pullConfig: TEST_PULL_CONFIG, stagedDir, ctx: {} as never, clientFactory: factory });
    const manifest = JSON.parse(await readFile(join(stagedDir, 'confluence-manifest.json'), 'utf-8'));
    expect(manifest.pageCount).toBe(1);
  });

  it('calls cleanup on the client even when an error is thrown', async () => {
    const cleanupMock = vi.fn().mockResolvedValue(undefined);
    const factory = makeFactory({
      listSpaces: vi.fn().mockRejectedValue(new Error('Network failure')),
      cleanup: cleanupMock,
    });
    await expect(
      fetchConfluenceBundle({ pullConfig: TEST_PULL_CONFIG, stagedDir, ctx: {} as never, clientFactory: factory }),
    ).rejects.toThrow('Network failure');
    expect(cleanupMock).toHaveBeenCalledOnce();
  });

  it('passes spaceKeys from pullConfig to listSpaces', async () => {
    const listSpacesMock = vi.fn().mockResolvedValue([]);
    const factory = makeFactory({ listSpaces: listSpacesMock });
    await fetchConfluenceBundle({
      pullConfig: { confluenceConnectionId: 'confluence-prod', spaceKeys: ['ENG', 'SEC'] },
      stagedDir,
      ctx: {} as never,
      clientFactory: factory,
    });
    expect(listSpacesMock).toHaveBeenCalledWith({ spaceKeys: ['ENG', 'SEC'] });
  });

  it('throws on invalid pullConfig', async () => {
    const factory = makeFactory({});
    await expect(
      fetchConfluenceBundle({
        pullConfig: { confluenceConnectionId: 'invalid id with spaces' },
        stagedDir,
        ctx: {} as never,
        clientFactory: factory,
      }),
    ).rejects.toThrow();
  });

  it('handles zero pages gracefully', async () => {
    const factory = makeFactory({
      listSpaces: vi.fn().mockResolvedValue([makeSpace('space-1', 'ENG', 'Engineering')]),
      listPagesInSpace: vi.fn().mockResolvedValue([]),
    });
    await fetchConfluenceBundle({ pullConfig: TEST_PULL_CONFIG, stagedDir, ctx: {} as never, clientFactory: factory });
    const manifest = JSON.parse(await readFile(join(stagedDir, 'confluence-manifest.json'), 'utf-8'));
    expect(manifest.pageCount).toBe(0);
  });
});
