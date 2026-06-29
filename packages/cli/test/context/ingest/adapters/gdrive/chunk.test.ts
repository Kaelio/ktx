import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { chunkGdriveStagedDir } from '../../../../../src/context/ingest/adapters/gdrive/chunk.js';

describe('chunkGdriveStagedDir', () => {
  let stagedDir: string;

  beforeEach(async () => {
    stagedDir = await mkdtemp(join(tmpdir(), 'ktx-gdrive-chunk-'));
  });

  afterEach(async () => {
    await rm(stagedDir, { recursive: true, force: true });
  });

  it('chunks changed documents into work units', async () => {
    await writeFile(
      join(stagedDir, 'manifest.json'),
      JSON.stringify({
        source: 'gdrive',
        folderId: 'folder-123',
        recursive: false,
        fetchedAt: '2026-05-23T00:00:00.000Z',
        fileCount: 1,
        skipped: [],
        warnings: [],
      }),
      'utf-8',
    );
    await mkdir(join(stagedDir, 'docs', 'ops-handbook-doc-1'), { recursive: true });
    await writeFile(
      join(stagedDir, 'docs', 'ops-handbook-doc-1', 'metadata.json'),
      JSON.stringify({
        id: 'doc-1',
        title: 'Ops Handbook',
        path: 'Ops / Ops Handbook',
        url: 'https://docs.google.com/document/d/doc-1',
        mimeType: 'application/vnd.google-apps.document',
        folderId: 'folder-123',
        drivePath: ['Ops'],
        modifiedTime: '2026-05-23T00:00:00.000Z',
      }),
      'utf-8',
    );
    await writeFile(join(stagedDir, 'docs', 'ops-handbook-doc-1', 'page.md'), '# Ops Handbook\n', 'utf-8');

    const result = await chunkGdriveStagedDir(stagedDir, {
      added: ['docs/ops-handbook-doc-1/metadata.json', 'docs/ops-handbook-doc-1/page.md'],
      modified: [],
      deleted: [],
      unchanged: ['manifest.json'],
    });

    expect(result.workUnits).toHaveLength(1);
    expect(result.workUnits[0]).toMatchObject({
      displayLabel: 'Ops / Ops Handbook',
      rawFiles: ['docs/ops-handbook-doc-1/metadata.json', 'docs/ops-handbook-doc-1/page.md'],
      dependencyPaths: ['manifest.json'],
    });
    expect(result.workUnits[0].notes).toContain('Do not create semantic-layer sources from gdrive content in v1.');
  });

  it('normalizes Windows-style diff paths before matching touched files', async () => {
    await writeFile(
      join(stagedDir, 'manifest.json'),
      JSON.stringify({
        source: 'gdrive',
        folderId: 'folder-123',
        recursive: false,
        fetchedAt: '2026-05-23T00:00:00.000Z',
        fileCount: 1,
        skipped: [],
        warnings: [],
      }),
      'utf-8',
    );
    await mkdir(join(stagedDir, 'docs', 'ops-handbook-doc-1'), { recursive: true });
    await writeFile(
      join(stagedDir, 'docs', 'ops-handbook-doc-1', 'metadata.json'),
      JSON.stringify({
        id: 'doc-1',
        title: 'Ops Handbook',
        path: 'Ops / Ops Handbook',
        url: 'https://docs.google.com/document/d/doc-1',
        mimeType: 'application/vnd.google-apps.document',
        folderId: 'folder-123',
        drivePath: ['Ops'],
        modifiedTime: '2026-05-23T00:00:00.000Z',
      }),
      'utf-8',
    );
    await writeFile(join(stagedDir, 'docs', 'ops-handbook-doc-1', 'page.md'), '# Ops Handbook\n', 'utf-8');

    const result = await chunkGdriveStagedDir(stagedDir, {
      added: ['docs\\ops-handbook-doc-1\\metadata.json', 'docs\\ops-handbook-doc-1\\page.md'],
      modified: [],
      deleted: ['docs\\old-doc\\page.md'],
      unchanged: ['manifest.json'],
    });

    expect(result.workUnits).toHaveLength(1);
    expect(result.workUnits[0]?.rawFiles).toEqual([
      'docs/ops-handbook-doc-1/metadata.json',
      'docs/ops-handbook-doc-1/page.md',
    ]);
    expect(result.eviction).toEqual({ deletedRawPaths: ['docs/old-doc/page.md'] });
  });
});
