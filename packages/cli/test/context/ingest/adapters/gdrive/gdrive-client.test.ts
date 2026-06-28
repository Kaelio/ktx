import { describe, expect, it, vi } from 'vitest';
import {
  driveFolderChildrenQuery,
  fetchWithGoogleRetry,
  verifyGdriveFolderAndCountDocs,
  type GoogleDriveClient,
} from '../../../../../src/context/ingest/adapters/gdrive/gdrive-client.js';
import {
  GDRIVE_DOC_MIME_TYPE,
  GDRIVE_FOLDER_MIME_TYPE,
  type GdriveFileRecord,
} from '../../../../../src/context/ingest/adapters/gdrive/types.js';

function fileRecord(partial: Partial<GdriveFileRecord> & { id: string; mimeType: string }): GdriveFileRecord {
  return {
    name: partial.name ?? partial.id,
    parents: [],
    webViewLink: null,
    modifiedTime: null,
    ...partial,
  };
}

describe('driveFolderChildrenQuery', () => {
  it('escapes single quotes and backslashes in the folder id', () => {
    expect(driveFolderChildrenQuery('abc')).toBe("'abc' in parents and trashed = false");
    expect(driveFolderChildrenQuery("a'b")).toBe("'a\\'b' in parents and trashed = false");
    expect(driveFolderChildrenQuery('a\\b')).toBe("'a\\\\b' in parents and trashed = false");
  });
});

describe('verifyGdriveFolderAndCountDocs', () => {
  it('throws a caller-facing error when the folder is not accessible', async () => {
    const drive: GoogleDriveClient = {
      getFile: vi.fn(async () => null),
      listFiles: vi.fn(),
    };
    await expect(verifyGdriveFolderAndCountDocs(drive, 'missing')).rejects.toThrow('is not accessible');
    expect(drive.listFiles).not.toHaveBeenCalled();
  });

  it('throws when the id resolves to a non-folder', async () => {
    const drive: GoogleDriveClient = {
      getFile: vi.fn(async () => fileRecord({ id: 'doc-1', mimeType: GDRIVE_DOC_MIME_TYPE })),
      listFiles: vi.fn(),
    };
    await expect(verifyGdriveFolderAndCountDocs(drive, 'doc-1')).rejects.toThrow('is not a folder');
    expect(drive.listFiles).not.toHaveBeenCalled();
  });

  it('counts Google Docs across pages and ignores non-Docs', async () => {
    const listFiles = vi
      .fn()
      .mockResolvedValueOnce({
        files: [
          fileRecord({ id: '1', mimeType: GDRIVE_DOC_MIME_TYPE }),
          fileRecord({ id: '2', mimeType: 'application/vnd.google-apps.spreadsheet' }),
        ],
        nextPageToken: 'page-2',
      })
      .mockResolvedValueOnce({
        files: [fileRecord({ id: '3', mimeType: GDRIVE_DOC_MIME_TYPE })],
        nextPageToken: null,
      });
    const drive: GoogleDriveClient = {
      getFile: vi.fn(async () => fileRecord({ id: 'folder', mimeType: GDRIVE_FOLDER_MIME_TYPE })),
      listFiles,
    };
    await expect(verifyGdriveFolderAndCountDocs(drive, 'folder')).resolves.toBe(2);
    expect(listFiles).toHaveBeenCalledTimes(2);
  });
});

describe('fetchWithGoogleRetry', () => {
  const noopSleep = async () => {};

  it('retries transient 5xx responses then returns success', async () => {
    const doFetch = vi
      .fn()
      .mockResolvedValueOnce(new Response('busy', { status: 503 }))
      .mockResolvedValueOnce(new Response('{}', { status: 200 }));
    const response = await fetchWithGoogleRetry(doFetch, { sleep: noopSleep });
    expect(response.status).toBe(200);
    expect(doFetch).toHaveBeenCalledTimes(2);
  });

  it('does not retry non-retryable responses', async () => {
    const doFetch = vi.fn().mockResolvedValue(new Response('nope', { status: 404 }));
    const response = await fetchWithGoogleRetry(doFetch, { sleep: noopSleep });
    expect(response.status).toBe(404);
    expect(doFetch).toHaveBeenCalledTimes(1);
  });

  it('stops after maxAttempts when responses stay transient', async () => {
    const doFetch = vi.fn().mockResolvedValue(new Response('rate', { status: 429 }));
    const response = await fetchWithGoogleRetry(doFetch, { sleep: noopSleep, maxAttempts: 3 });
    expect(response.status).toBe(429);
    expect(doFetch).toHaveBeenCalledTimes(3);
  });
});
