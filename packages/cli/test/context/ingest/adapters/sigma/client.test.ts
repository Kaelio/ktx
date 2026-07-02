import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { DefaultSigmaClient } from '../../../../../src/context/ingest/adapters/sigma/client.js';

const BASE = 'https://api.sigmacomputing.com';

const TOKEN_RESPONSE = {
  access_token: 'test-token',
  token_type: 'Bearer',
  expires_in: 3600,
};

function makeResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'Content-Type': 'application/json' },
  });
}

function makeClient(): DefaultSigmaClient {
  return new DefaultSigmaClient(
    { apiUrl: BASE, clientId: 'cid', clientSecret: 'csec' }, // pragma: allowlist secret
    { maxRetries: 1, baseDelayMs: 0, maxDelayMs: 0, timeoutMs: 5000 },
  );
}

beforeEach(() => {
  globalThis.fetch = vi.fn<typeof fetch>();
});

afterEach(() => {
  vi.restoreAllMocks();
});

describe('DefaultSigmaClient.testConnection', () => {
  it('returns success:true when auth succeeds', async () => {
    vi.mocked(fetch).mockResolvedValueOnce(makeResponse(TOKEN_RESPONSE));
    const client = makeClient();
    const result = await client.testConnection();
    expect(result.success).toBe(true);
  });

  it('returns success:false with error message when auth fails', async () => {
    vi.mocked(fetch).mockResolvedValueOnce(makeResponse({ error: 'unauthorized' }, 401));
    const client = makeClient();
    const result = await client.testConnection();
    expect(result.success).toBe(false);
    expect(result.error).toMatch(/401/);
  });
});

describe('DefaultSigmaClient.listDataModels', () => {
  it('returns entries from a single page', async () => {
    vi.mocked(fetch)
      .mockResolvedValueOnce(makeResponse(TOKEN_RESPONSE)) // auth
      .mockResolvedValueOnce(
        makeResponse({
          entries: [
            {
              dataModelId: 'dm-1',
              dataModelUrlId: 'url-1',
              name: 'Revenue Model',
              path: 'Finance/Revenue',
              latestVersion: 1,
              ownerId: 'user-1',
              createdAt: '2026-01-01T00:00:00Z',
              updatedAt: '2026-01-01T00:00:00Z',
              isArchived: false,
            },
          ],
          nextPage: null,
        }),
      );
    const client = makeClient();
    const models = await client.listDataModels();
    expect(models).toHaveLength(1);
    expect(models[0]!.name).toBe('Revenue Model');
  });

  it('paginates across multiple pages', async () => {
    vi.mocked(fetch)
      .mockResolvedValueOnce(makeResponse(TOKEN_RESPONSE))
      .mockResolvedValueOnce(
        makeResponse({
          entries: [
            {
              dataModelId: 'dm-1',
              dataModelUrlId: 'url-1',
              name: 'Model A',
              path: 'Finance/A',
              latestVersion: 1,
              ownerId: 'u1',
              createdAt: '2026-01-01T00:00:00Z',
              updatedAt: '2026-01-01T00:00:00Z',
            },
          ],
          nextPage: 'cursor-abc',
        }),
      )
      .mockResolvedValueOnce(
        makeResponse({
          entries: [
            {
              dataModelId: 'dm-2',
              dataModelUrlId: 'url-2',
              name: 'Model B',
              path: 'Finance/B',
              latestVersion: 1,
              ownerId: 'u1',
              createdAt: '2026-01-02T00:00:00Z',
              updatedAt: '2026-01-02T00:00:00Z',
            },
          ],
          nextPage: null,
        }),
      );
    const client = makeClient();
    const models = await client.listDataModels();
    expect(models).toHaveLength(2);
    expect(models.map((m) => m.name)).toEqual(['Model A', 'Model B']);
  });

  it('second page request includes cursor in query string', async () => {
    vi.mocked(fetch)
      .mockResolvedValueOnce(makeResponse(TOKEN_RESPONSE))
      .mockResolvedValueOnce(makeResponse({ entries: [{ dataModelId: 'dm-1', dataModelUrlId: 'url-1', name: 'A', path: 'F/A', latestVersion: 1, ownerId: 'u', createdAt: '', updatedAt: '' }], nextPage: 'cursor-xyz' }))
      .mockResolvedValueOnce(makeResponse({ entries: [], nextPage: null }));
    const client = makeClient();
    await client.listDataModels();
    const calls = vi.mocked(fetch).mock.calls;
    const pageCall = calls[calls.length - 1]!;
    expect(String(pageCall[0])).toContain('cursor-xyz');
  });
});

function makeWorkbook(overrides: Record<string, unknown> = {}) {
  return {
    workbookId: 'wb-1',
    workbookUrlId: 'Sales-Dashboard-wb1',
    name: 'Sales Dashboard',
    url: 'https://app.sigmacomputing.com/workbooks/wb-1',
    path: 'Finance',
    latestVersion: 3,
    ownerId: 'user-1',
    createdAt: '2026-01-01T00:00:00Z',
    updatedAt: '2026-01-15T00:00:00Z',
    createdBy: 'user-1',
    updatedBy: 'user-1',
    isArchived: false,
    ...overrides,
  };
}

describe('DefaultSigmaClient.listWorkbooks', () => {
  it('returns entries from a single page', async () => {
    vi.mocked(fetch)
      .mockResolvedValueOnce(makeResponse(TOKEN_RESPONSE))
      .mockResolvedValueOnce(makeResponse({ entries: [makeWorkbook()], nextPage: null }));
    const client = makeClient();
    const workbooks = await client.listWorkbooks();
    expect(workbooks).toHaveLength(1);
    expect(workbooks[0]!.name).toBe('Sales Dashboard');
  });

  it('passes excludeExplorations=true by default', async () => {
    vi.mocked(fetch)
      .mockResolvedValueOnce(makeResponse(TOKEN_RESPONSE))
      .mockResolvedValueOnce(makeResponse({ entries: [], nextPage: null }));
    const client = makeClient();
    await client.listWorkbooks();
    const url = String(vi.mocked(fetch).mock.calls[1]![0]);
    expect(url).toContain('excludeExplorations=true');
  });

  it('omits excludeExplorations when includeExplorations=true', async () => {
    vi.mocked(fetch)
      .mockResolvedValueOnce(makeResponse(TOKEN_RESPONSE))
      .mockResolvedValueOnce(makeResponse({ entries: [], nextPage: null }));
    const client = makeClient();
    await client.listWorkbooks({ includeExplorations: true });
    const url = String(vi.mocked(fetch).mock.calls[1]![0]);
    expect(url).not.toContain('excludeExplorations');
  });

  it('filters out archived workbooks by default', async () => {
    vi.mocked(fetch)
      .mockResolvedValueOnce(makeResponse(TOKEN_RESPONSE))
      .mockResolvedValueOnce(
        makeResponse({
          entries: [makeWorkbook({ isArchived: false }), makeWorkbook({ workbookId: 'wb-2', name: 'Old', isArchived: true })],
          nextPage: null,
        }),
      );
    const client = makeClient();
    const workbooks = await client.listWorkbooks();
    expect(workbooks).toHaveLength(1);
    expect(workbooks[0]!.name).toBe('Sales Dashboard');
  });

  it('includes archived workbooks when includeArchived=true', async () => {
    vi.mocked(fetch)
      .mockResolvedValueOnce(makeResponse(TOKEN_RESPONSE))
      .mockResolvedValueOnce(
        makeResponse({
          entries: [makeWorkbook({ isArchived: false }), makeWorkbook({ workbookId: 'wb-2', name: 'Old', isArchived: true })],
          nextPage: null,
        }),
      );
    const client = makeClient();
    const workbooks = await client.listWorkbooks({ includeArchived: true });
    expect(workbooks).toHaveLength(2);
  });

  it('filters workbooks by updatedSince', async () => {
    vi.mocked(fetch)
      .mockResolvedValueOnce(makeResponse(TOKEN_RESPONSE))
      .mockResolvedValueOnce(
        makeResponse({
          entries: [
            makeWorkbook({ workbookId: 'wb-1', updatedAt: '2026-01-10T00:00:00Z' }),
            makeWorkbook({ workbookId: 'wb-2', updatedAt: '2026-01-20T00:00:00Z' }),
          ],
          nextPage: null,
        }),
      );
    const client = makeClient();
    const workbooks = await client.listWorkbooks({ updatedSince: '2026-01-15T00:00:00Z' });
    expect(workbooks).toHaveLength(1);
    expect(workbooks[0]!.workbookId).toBe('wb-2');
  });
});

describe('DefaultSigmaClient.getDataModelSpec', () => {
  it('calls the correct URL with encoded id', async () => {
    vi.mocked(fetch)
      .mockResolvedValueOnce(makeResponse(TOKEN_RESPONSE))
      .mockResolvedValueOnce(makeResponse({ schemaVersion: 1 }));
    const client = makeClient();
    const spec = await client.getDataModelSpec('dm/123');
    expect(spec).toEqual({ schemaVersion: 1 });
    const calls = vi.mocked(fetch).mock.calls;
    expect(String(calls[1]![0])).toContain('/v2/dataModels/dm%2F123/spec');
  });
});

describe('DefaultSigmaClient — error handling', () => {
  it('retries on 500 and succeeds on retry', async () => {
    vi.mocked(fetch)
      .mockResolvedValueOnce(makeResponse(TOKEN_RESPONSE)) // auth
      .mockResolvedValueOnce(makeResponse({ error: 'server error' }, 500)) // first attempt
      .mockResolvedValueOnce(makeResponse({ entries: [], nextPage: null })); // retry
    const client = makeClient();
    const models = await client.listDataModels();
    expect(models).toHaveLength(0);
  });

  it('throws after exhausting retries on 500', async () => {
    vi.mocked(fetch)
      .mockResolvedValueOnce(makeResponse(TOKEN_RESPONSE))
      .mockResolvedValue(makeResponse({ error: 'server error' }, 500));
    const client = makeClient();
    await expect(client.listDataModels()).rejects.toThrow(/500/);
  });

  it('throws immediately on service_error 500 without retrying', async () => {
    const serviceError = { requestId: 'abc', message: 'dataSource subtype not supported in data model read', code: 'service_error' };
    vi.mocked(fetch)
      .mockResolvedValueOnce(makeResponse(TOKEN_RESPONSE))
      .mockResolvedValueOnce(makeResponse(serviceError, 500));
    const client = makeClient();
    await expect(client.getDataModelSpec('dm-1')).rejects.toThrow(/service_error/);
    // Only 2 calls: auth + one request. No retries.
    expect(vi.mocked(fetch)).toHaveBeenCalledTimes(2);
  });

  it('throws immediately on 404 (non-retryable)', async () => {
    vi.mocked(fetch)
      .mockResolvedValueOnce(makeResponse(TOKEN_RESPONSE))
      .mockResolvedValueOnce(makeResponse({ error: 'not found' }, 404));
    const client = makeClient();
    await expect(client.getDataModelSpec('dm-999')).rejects.toThrow(/404/);
  });

  it('re-authenticates and retries on 401', async () => {
    vi.mocked(fetch)
      .mockResolvedValueOnce(makeResponse(TOKEN_RESPONSE)) // initial auth
      .mockResolvedValueOnce(makeResponse({ error: 'expired' }, 401)) // 401 on first request
      .mockResolvedValueOnce(makeResponse(TOKEN_RESPONSE)) // re-auth
      .mockResolvedValueOnce(makeResponse({ entries: [], nextPage: null })); // retried request
    const client = makeClient();
    const models = await client.listDataModels();
    expect(models).toHaveLength(0);
  });
});

describe('DefaultSigmaClient.cleanup', () => {
  it('clears cached token so next call re-authenticates', async () => {
    vi.mocked(fetch)
      .mockResolvedValueOnce(makeResponse(TOKEN_RESPONSE)) // first auth
      .mockResolvedValueOnce(makeResponse({ entries: [], nextPage: null })) // first list
      .mockResolvedValueOnce(makeResponse(TOKEN_RESPONSE)) // second auth after cleanup
      .mockResolvedValueOnce(makeResponse({ entries: [], nextPage: null })); // second list
    const client = makeClient();
    await client.listDataModels();
    await client.cleanup();
    await client.listDataModels();
    // 4 calls total: 2 auths + 2 lists
    expect(vi.mocked(fetch)).toHaveBeenCalledTimes(4);
  });
});
