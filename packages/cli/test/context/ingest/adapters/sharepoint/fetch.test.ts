import { createHash } from 'node:crypto';
import { mkdtemp, readdir, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, relative } from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { fetchSharepointSnapshot } from '../../../../../src/context/ingest/adapters/sharepoint/fetch.js';
import { createDocxBuffer } from './test-docx.js';

async function listRelativeFiles(root: string): Promise<string[]> {
  const entries = await readdir(root, { recursive: true, withFileTypes: true });
  return entries
    .filter((entry) => entry.isFile())
    .map((entry) => relative(root, join(entry.parentPath, entry.name)).replace(/\\/g, '/'))
    .sort();
}

function docDir(title: string, itemId: string): string {
  const slug = title.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '');
  return `${slug}-${createHash('sha1').update(itemId).digest('hex').slice(0, 10)}`;
}

describe('fetchSharepointSnapshot', () => {
  let stagedDir: string;

  afterEach(async () => {
    await rm(stagedDir, { recursive: true, force: true });
    vi.restoreAllMocks();
  });

  it('writes compact staged paths and preserves metadata for markdown and docx files', async () => {
    stagedDir = await mkdtemp(join(tmpdir(), 'ktx-sharepoint-fetch-'));
    const client = {
      listDriveFiles: vi.fn(async () => [
        {
          item: {
            id: 'file-md',
            name: 'Ops Handbook.md',
            webUrl: 'https://tenant.sharepoint.com/docs/ops',
            lastModifiedDateTime: '2026-05-24T01:53:28.347Z',
            file: { mimeType: 'text/markdown' },
            folder: null,
            downloadUrl: null,
          },
          drivePath: ['Team Docs'],
        },
        {
          item: {
            id: 'file-docx',
            name: 'Quarterly Review.docx',
            webUrl: 'https://tenant.sharepoint.com/docs/review',
            lastModifiedDateTime: '2026-05-24T01:53:28.347Z',
            file: { mimeType: 'application/vnd.openxmlformats-officedocument.wordprocessingml.document' },
            folder: null,
            downloadUrl: null,
          },
          drivePath: [],
        },
        {
          item: {
            id: 'file-skip',
            name: 'Diagram.png',
            webUrl: null,
            lastModifiedDateTime: '2026-05-24T01:53:28.347Z',
            file: { mimeType: 'image/png' },
            folder: null,
            downloadUrl: null,
          },
          drivePath: [],
        },
      ]),
      downloadFile: vi.fn(async (_driveId: string, item: { id: string }) => {
        if (item.id === 'file-md') {
          return Buffer.from('Line 1\r\nLine 2\r\n');
        }
        return createDocxBuffer(`<w:p><w:r><w:t>Durable review notes.</w:t></w:r></w:p>`);
      }),
    };

    const manifest = await fetchSharepointSnapshot({
      client: client as never,
      config: {
        tenantId: 'tenant-1',
        clientId: 'client-1',
        clientSecret: 'secret-1', // pragma: allowlist secret
        driveId: 'drive-1',
        folderId: 'folder-1',
        recursive: true,
      },
      stagedDir,
    });

    expect(manifest.fileCount).toBe(2);
    expect(manifest.skipped).toEqual([{ externalId: 'file-skip', reason: 'unsupported file extension: .png' }]);
    expect(manifest.warnings[0]).toContain('Skipped 1 unsupported SharePoint / OneDrive file');

    const files = await listRelativeFiles(stagedDir);
    expect(files).toEqual([
      `docs/${docDir('Quarterly Review', 'file-docx')}/metadata.json`,
      `docs/${docDir('Quarterly Review', 'file-docx')}/page.md`,
      `docs/team-docs/${docDir('Ops Handbook', 'file-md')}/metadata.json`,
      `docs/team-docs/${docDir('Ops Handbook', 'file-md')}/page.md`,
      'manifest.json',
    ]);

    const mdMetadata = JSON.parse(
      await readFile(join(stagedDir, 'docs', 'team-docs', docDir('Ops Handbook', 'file-md'), 'metadata.json'), 'utf-8'),
    );
    expect(mdMetadata).toMatchObject({
      id: 'file-md',
      title: 'Ops Handbook',
      path: 'Team Docs / Ops Handbook',
      driveId: 'drive-1',
      folderId: 'folder-1',
      drivePath: ['Team Docs'],
      fileName: 'Ops Handbook.md',
    });
    await expect(
      readFile(join(stagedDir, 'docs', 'team-docs', docDir('Ops Handbook', 'file-md'), 'page.md'), 'utf-8'),
    ).resolves.toBe('Line 1\nLine 2\n');
    await expect(
      readFile(join(stagedDir, 'docs', docDir('Quarterly Review', 'file-docx'), 'page.md'), 'utf-8'),
    ).resolves.toContain('# Quarterly Review');
  });
});
