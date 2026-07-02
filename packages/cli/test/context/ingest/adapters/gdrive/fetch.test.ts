import { mkdtemp, readdir, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, relative } from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { fetchGdriveSnapshot } from '../../../../../src/context/ingest/adapters/gdrive/fetch.js';

const getDocument = vi.fn(async () => ({
  title: 'Herness and Enterprise Agent Operating Framework for Connected Systems',
  body: { content: [] },
}));
const listFiles = vi.fn(async () => ({
  files: [
    {
      id: 'doc-1',
      name: 'Herness and Enterprise Agent Operating Framework for Connected Systems',
      mimeType: 'application/vnd.google-apps.document',
      parents: ['folder-123'],
      webViewLink: 'https://docs.google.com/document/d/doc-1',
      modifiedTime: '2026-05-24T01:53:28.347Z',
    },
  ],
  nextPageToken: null,
}));

vi.mock('../../../../../src/context/ingest/adapters/gdrive/gdrive-client.js', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../../../../../src/context/ingest/adapters/gdrive/gdrive-client.js')>()),
  createGoogleDocsClients: vi.fn(() => ({
    drive: { listFiles },
    docs: { getDocument },
  })),
}));

vi.mock('../../../../../src/context/ingest/adapters/gdrive/normalize.js', () => ({
  normalizeGoogleDocToMarkdown: vi.fn(() => 'Durable operating rules.'),
}));

async function listRelativeFiles(root: string): Promise<string[]> {
  const entries = await readdir(root, { recursive: true, withFileTypes: true });
  return entries
    .filter((entry) => entry.isFile())
    .map((entry) => relative(root, join(entry.parentPath, entry.name)).replace(/\\/g, '/'))
    .sort();
}

describe('fetchGdriveSnapshot', () => {
  let stagedDir: string;

  afterEach(async () => {
    await rm(stagedDir, { recursive: true, force: true });
    vi.clearAllMocks();
  });

  it('writes compact staged paths while preserving full metadata title and path', async () => {
    stagedDir = await mkdtemp(join(tmpdir(), 'ktx-gdrive-fetch-'));

    const manifest = await fetchGdriveSnapshot({
      key: { client_email: 'bot@example.com', private_key: 'secret' }, // pragma: allowlist secret
      config: { serviceAccountKey: 'unused', folderId: 'folder-123', recursive: false }, // pragma: allowlist secret
      stagedDir,
    });

    expect(manifest.fileCount).toBe(1);
    expect(listFiles).toHaveBeenCalledWith({ q: "'folder-123' in parents and trashed = false", pageToken: undefined });
    expect(getDocument).toHaveBeenCalledWith('doc-1');

    const files = await listRelativeFiles(stagedDir);
    expect(files).toEqual([
      'docs/herness-and-enterprise-a-7913523027/metadata.json',
      'docs/herness-and-enterprise-a-7913523027/page.md',
      'manifest.json',
    ]);

    const metadata = JSON.parse(
      await readFile(join(stagedDir, 'docs', 'herness-and-enterprise-a-7913523027', 'metadata.json'), 'utf-8'),
    );
    expect(metadata).toMatchObject({
      id: 'doc-1',
      title: 'Herness and Enterprise Agent Operating Framework for Connected Systems',
      path: 'Herness and Enterprise Agent Operating Framework for Connected Systems',
    });
    await expect(
      readFile(join(stagedDir, 'docs', 'herness-and-enterprise-a-7913523027', 'page.md'), 'utf-8'),
    ).resolves.toContain('# Herness and Enterprise Agent Operating Framework for Connected Systems');
  });

  it('records skipped non-Google-Doc files in the manifest with a summary warning', async () => {
    stagedDir = await mkdtemp(join(tmpdir(), 'ktx-gdrive-fetch-'));
    listFiles.mockResolvedValueOnce({
      files: [
        {
          id: 'doc-1',
          name: 'Doc',
          mimeType: 'application/vnd.google-apps.document',
          parents: ['folder-123'],
          webViewLink: 'https://docs.google.com/document/d/doc-1',
          modifiedTime: '2026-05-24T01:53:28.347Z',
        },
        {
          id: 'sheet-1',
          name: 'Sheet',
          mimeType: 'application/vnd.google-apps.spreadsheet',
          parents: ['folder-123'],
          webViewLink: 'https://docs.google.com/spreadsheets/d/sheet-1',
          modifiedTime: '2026-05-24T01:53:28.347Z',
        },
      ],
      nextPageToken: null,
    });

    const manifest = await fetchGdriveSnapshot({
      key: { client_email: 'bot@example.com', private_key: 'secret' }, // pragma: allowlist secret
      config: { serviceAccountKey: 'unused', folderId: 'folder-123', recursive: false }, // pragma: allowlist secret
      stagedDir,
    });

    expect(manifest.fileCount).toBe(1);
    expect(manifest.skipped).toEqual([
      { externalId: 'sheet-1', reason: 'unsupported mime type: application/vnd.google-apps.spreadsheet' },
    ]);
    expect(manifest.warnings).toHaveLength(1);
    expect(manifest.warnings[0]).toContain('Skipped 1');
  });
});
