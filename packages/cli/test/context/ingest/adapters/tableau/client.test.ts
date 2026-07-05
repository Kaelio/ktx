import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { DefaultTableauClient } from '../../../../../src/context/ingest/adapters/tableau/client.js';

const HOST = 'https://us-west-2b.online.tableau.com';

const SIGNIN_RESPONSE = {
  credentials: {
    token: 'test-auth-token',
    site: { id: 'site-1', contentUrl: 'mysite' },
    user: { id: 'user-1' },
  },
};

function makeResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'Content-Type': 'application/json' },
  });
}

function datasourcesPage(nodes: unknown[], hasNextPage = false) {
  return makeResponse({
    data: { publishedDatasourcesConnection: { totalCount: nodes.length, pageInfo: { hasNextPage }, nodes } },
  });
}

function workbooksPage(nodes: unknown[], hasNextPage = false) {
  return makeResponse({
    data: { workbooksConnection: { totalCount: nodes.length, pageInfo: { hasNextPage }, nodes } },
  });
}

function makeClient(): DefaultTableauClient {
  return new DefaultTableauClient(
    { host: HOST, siteContentUrl: 'mysite', apiVersion: '3.29', patName: 'ci', patSecret: 'secret' }, // pragma: allowlist secret
    { maxRetries: 1, baseDelayMs: 0, maxDelayMs: 0, timeoutMs: 5000, pageSize: 2 },
  );
}

beforeEach(() => {
  globalThis.fetch = vi.fn<typeof fetch>();
});

afterEach(() => {
  vi.restoreAllMocks();
});

describe('DefaultTableauClient.testConnection', () => {
  it('signs in with the PAT and returns success', async () => {
    vi.mocked(fetch).mockResolvedValueOnce(makeResponse(SIGNIN_RESPONSE));
    const client = makeClient();
    const result = await client.testConnection();
    expect(result.success).toBe(true);

    const [url, init] = vi.mocked(fetch).mock.calls[0]!;
    expect(String(url)).toBe(`${HOST}/api/3.29/auth/signin`);
    const body = JSON.parse(String((init as RequestInit).body));
    expect(body.credentials.personalAccessTokenName).toBe('ci');
    expect(body.credentials.personalAccessTokenSecret).toBe('secret');
    expect(body.credentials.site.contentUrl).toBe('mysite');
  });

  it('returns success:false with the error when sign-in fails', async () => {
    vi.mocked(fetch).mockResolvedValueOnce(makeResponse({ error: 'unauthorized' }, 401));
    const client = makeClient();
    const result = await client.testConnection();
    expect(result.success).toBe(false);
    expect(result.error).toMatch(/401/);
  });
});

describe('DefaultTableauClient.listDatasources', () => {
  it('sends the auth token as X-Tableau-Auth on metadata calls', async () => {
    vi.mocked(fetch).mockResolvedValueOnce(makeResponse(SIGNIN_RESPONSE)).mockResolvedValueOnce(datasourcesPage([]));
    const client = makeClient();
    await client.listDatasources();
    const [url, init] = vi.mocked(fetch).mock.calls[1]!;
    expect(String(url)).toBe(`${HOST}/api/metadata/graphql`);
    expect((init as RequestInit).headers).toMatchObject({ 'X-Tableau-Auth': 'test-auth-token' });
  });

  it('maps column fields and calculated fields (with formula)', async () => {
    vi.mocked(fetch)
      .mockResolvedValueOnce(makeResponse(SIGNIN_RESPONSE))
      .mockResolvedValueOnce(
        datasourcesPage([
          {
            luid: 'ds-1',
            name: 'Sales',
            projectName: 'Finance',
            updatedAt: '2026-01-01T00:00:00Z',
            hasExtracts: true,
            upstreamTables: [{ luid: 't-1', name: 'ORDERS', schema: 'PUBLIC', fullName: 'DB.PUBLIC.ORDERS' }],
            fields: [
              { __typename: 'ColumnField', name: 'amount', dataType: 'INTEGER', role: 'MEASURE' },
              { __typename: 'CalculatedField', name: 'Profit', formula: '[Revenue] - [Cost]', dataType: 'REAL', role: 'MEASURE' },
            ],
          },
        ]),
      );
    const client = makeClient();
    const datasources = await client.listDatasources();
    expect(datasources).toHaveLength(1);
    const ds = datasources[0]!;
    expect(ds.name).toBe('Sales');
    expect(ds.upstreamTables[0]!.fullName).toBe('DB.PUBLIC.ORDERS');
    const calc = ds.fields.find((f) => f.name === 'Profit');
    expect(calc?.formula).toBe('[Revenue] - [Cost]');
    const col = ds.fields.find((f) => f.name === 'amount');
    expect(col?.formula).toBeUndefined();
  });

  it('paginates using offset until hasNextPage is false', async () => {
    vi.mocked(fetch)
      .mockResolvedValueOnce(makeResponse(SIGNIN_RESPONSE))
      .mockResolvedValueOnce(datasourcesPage([{ luid: 'ds-1', name: 'A', fields: [], upstreamTables: [] }], true))
      .mockResolvedValueOnce(datasourcesPage([{ luid: 'ds-2', name: 'B', fields: [], upstreamTables: [] }], false));
    const client = makeClient();
    const datasources = await client.listDatasources();
    expect(datasources.map((d) => d.name)).toEqual(['A', 'B']);
    const secondQuery = JSON.parse(String((vi.mocked(fetch).mock.calls[2]![1] as RequestInit).body));
    expect(secondQuery.variables.offset).toBe(2);
  });

  it('filters by updatedSince', async () => {
    vi.mocked(fetch)
      .mockResolvedValueOnce(makeResponse(SIGNIN_RESPONSE))
      .mockResolvedValueOnce(
        datasourcesPage([
          { luid: 'ds-1', name: 'Old', updatedAt: '2026-01-10T00:00:00Z', fields: [], upstreamTables: [] },
          { luid: 'ds-2', name: 'New', updatedAt: '2026-01-20T00:00:00Z', fields: [], upstreamTables: [] },
        ]),
      );
    const client = makeClient();
    const datasources = await client.listDatasources({ updatedSince: '2026-01-15T00:00:00Z' });
    expect(datasources.map((d) => d.name)).toEqual(['New']);
  });
});

describe('DefaultTableauClient.listWorkbooks', () => {
  it('returns workbook summaries', async () => {
    vi.mocked(fetch)
      .mockResolvedValueOnce(makeResponse(SIGNIN_RESPONSE))
      .mockResolvedValueOnce(
        workbooksPage([{ luid: 'wb-1', name: 'ARR Tracker', projectName: 'Finance', description: 'ARR by segment' }]),
      );
    const client = makeClient();
    const workbooks = await client.listWorkbooks();
    expect(workbooks).toHaveLength(1);
    expect(workbooks[0]!.name).toBe('ARR Tracker');
  });
});

describe('DefaultTableauClient — error handling', () => {
  it('retries on 500 and succeeds on retry', async () => {
    vi.mocked(fetch)
      .mockResolvedValueOnce(makeResponse(SIGNIN_RESPONSE))
      .mockResolvedValueOnce(makeResponse({ error: 'server error' }, 500))
      .mockResolvedValueOnce(datasourcesPage([]));
    const client = makeClient();
    const datasources = await client.listDatasources();
    expect(datasources).toHaveLength(0);
  });

  it('surfaces GraphQL-level errors', async () => {
    vi.mocked(fetch)
      .mockResolvedValueOnce(makeResponse(SIGNIN_RESPONSE))
      .mockResolvedValueOnce(makeResponse({ errors: [{ message: 'Field "bogus" not found' }] }));
    const client = makeClient();
    await expect(client.listDatasources()).rejects.toThrow(/bogus/);
  });

  it('re-authenticates and retries on 401', async () => {
    vi.mocked(fetch)
      .mockResolvedValueOnce(makeResponse(SIGNIN_RESPONSE)) // initial sign-in
      .mockResolvedValueOnce(makeResponse({ error: 'expired' }, 401)) // 401 on first query
      .mockResolvedValueOnce(makeResponse(SIGNIN_RESPONSE)) // re-sign-in
      .mockResolvedValueOnce(datasourcesPage([])); // retried query
    const client = makeClient();
    const datasources = await client.listDatasources();
    expect(datasources).toHaveLength(0);
  });
});

describe('DefaultTableauClient.cleanup', () => {
  it('signs out and clears the token so the next call re-authenticates', async () => {
    vi.mocked(fetch)
      .mockResolvedValueOnce(makeResponse(SIGNIN_RESPONSE)) // first sign-in
      .mockResolvedValueOnce(datasourcesPage([])) // first list
      .mockResolvedValueOnce(makeResponse({})) // signout
      .mockResolvedValueOnce(makeResponse(SIGNIN_RESPONSE)) // second sign-in
      .mockResolvedValueOnce(datasourcesPage([])); // second list
    const client = makeClient();
    await client.listDatasources();
    await client.cleanup();
    await client.listDatasources();

    const signoutCall = vi.mocked(fetch).mock.calls[2]!;
    expect(String(signoutCall[0])).toBe(`${HOST}/api/3.29/auth/signout`);
    expect(vi.mocked(fetch)).toHaveBeenCalledTimes(5);
  });
});
