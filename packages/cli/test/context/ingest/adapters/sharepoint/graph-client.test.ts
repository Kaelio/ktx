import { afterEach, describe, expect, it, vi } from 'vitest';
import { createSharepointGraphClient } from '../../../../../src/context/ingest/adapters/sharepoint/graph-client.js';

function jsonResponse(body: unknown, init: ResponseInit = {}): Response {
  return new Response(JSON.stringify(body), {
    status: 200,
    headers: { 'content-type': 'application/json' },
    ...init,
  });
}

describe('SharepointGraphClient', () => {
  afterEach(async () => {
    vi.restoreAllMocks();
  });

  it('requests a token once and recursively paginates drive children', async () => {
    const fetchImpl = vi
      .fn<typeof fetch>()
      .mockResolvedValueOnce(jsonResponse({ access_token: 'graph-token' }))
      .mockResolvedValueOnce(
        jsonResponse({
          value: [
            { id: 'file-1', name: 'Root.md', file: { mimeType: 'text/markdown' } },
            { id: 'folder-2', name: 'Subfolder', folder: { childCount: 1 } },
          ],
          '@odata.nextLink': 'https://graph.microsoft.com/v1.0/next-page',
        }),
      )
      .mockResolvedValueOnce(jsonResponse({ value: [{ id: 'file-2', name: 'Root.docx', file: { mimeType: 'application/vnd.openxmlformats-officedocument.wordprocessingml.document' } }] }))
      .mockResolvedValueOnce(
        jsonResponse({
          value: [{ id: 'file-3', name: 'Nested.md', file: { mimeType: 'text/markdown' } }],
        }),
      );

    const client = createSharepointGraphClient({
      tenantId: 'tenant-1',
      clientId: 'client-1',
      clientSecret: 'secret-1', // pragma: allowlist secret
      fetchImpl,
    });
    const files = await client.listDriveFiles({ driveId: 'drive-1', folderId: 'folder-1', recursive: true });

    expect(fetchImpl).toHaveBeenCalledTimes(4);
    expect(fetchImpl.mock.calls[0]?.[0]).toBe('https://login.microsoftonline.com/tenant-1/oauth2/v2.0/token');
    expect(files.map(({ item, drivePath }) => ({ id: item.id, path: drivePath.join('/') }))).toEqual([
      { id: 'file-1', path: '' },
      { id: 'file-2', path: 'Subfolder' },
      { id: 'file-3', path: '' },
    ]);
  });

  it('downloads file content from the direct download URL when present', async () => {
    const fetchImpl = vi
      .fn<typeof fetch>()
      .mockResolvedValueOnce(jsonResponse({ access_token: 'graph-token' }))
      .mockResolvedValueOnce(new Response('document body', { status: 200 }));
    const client = createSharepointGraphClient({
      tenantId: 'tenant-1',
      clientId: 'client-1',
      clientSecret: 'secret-1', // pragma: allowlist secret
      fetchImpl,
    });

    const content = await client.downloadFile('drive-1', {
      id: 'file-1',
      name: 'Ops.md',
      webUrl: null,
      lastModifiedDateTime: null,
      file: { mimeType: 'text/markdown' },
      folder: null,
      downloadUrl: 'https://download.example/file-1',
    });

    expect(fetchImpl.mock.calls[1]?.[0]).toBe('https://download.example/file-1');
    expect(content.toString('utf-8')).toBe('document body');
  });

  it('lists site drives across paginated results', async () => {
    const fetchImpl = vi
      .fn<typeof fetch>()
      .mockResolvedValueOnce(jsonResponse({ access_token: 'graph-token' }))
      .mockResolvedValueOnce(
        jsonResponse({
          value: [{ id: 'drive-1', name: 'Documents', webUrl: 'https://tenant/sites/a/Documents' }],
          '@odata.nextLink': 'https://graph.microsoft.com/v1.0/sites/site-1/drives?page=2',
        }),
      )
      .mockResolvedValueOnce(jsonResponse({ value: [{ id: 'drive-2', name: 'Shared', webUrl: null }] }));
    const client = createSharepointGraphClient({
      tenantId: 'tenant-1',
      clientId: 'client-1',
      clientSecret: 'secret-1', // pragma: allowlist secret
      fetchImpl,
    });

    await expect(client.listDrivesForSite('site-1')).resolves.toEqual([
      { id: 'drive-1', name: 'Documents', webUrl: 'https://tenant/sites/a/Documents' },
      { id: 'drive-2', name: 'Shared', webUrl: null },
    ]);
  });
});
