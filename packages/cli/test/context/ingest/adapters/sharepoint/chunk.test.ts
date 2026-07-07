import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { chunkSharepointStagedDir } from '../../../../../src/context/ingest/adapters/sharepoint/chunk.js';

describe('chunkSharepointStagedDir', () => {
  let stagedDir: string;

  beforeEach(async () => {
    stagedDir = await mkdtemp(join(tmpdir(), 'ktx-sharepoint-chunk-'));
  });

  afterEach(async () => {
    await rm(stagedDir, { recursive: true, force: true });
  });

  it('chunks changed documents into work units and normalizes diff paths', async () => {
    await writeFile(
      join(stagedDir, 'manifest.json'),
      JSON.stringify({
        source: 'sharepoint',
        driveId: 'drive-1',
        folderId: 'folder-1',
        recursive: true,
        fetchedAt: '2026-05-23T00:00:00.000Z',
        fileCount: 1,
        skipped: [],
        warnings: [],
      }),
      'utf-8',
    );
    await mkdir(join(stagedDir, 'docs', 'team-docs', 'ops-handbook-abc123'), { recursive: true });
    await writeFile(
      join(stagedDir, 'docs', 'team-docs', 'ops-handbook-abc123', 'metadata.json'),
      JSON.stringify({
        id: 'file-1',
        title: 'Ops Handbook',
        path: 'Team Docs / Ops Handbook',
        url: 'https://tenant.sharepoint.com/docs/ops',
        mimeType: 'text/markdown',
        driveId: 'drive-1',
        folderId: 'folder-1',
        drivePath: ['Team Docs'],
        fileName: 'Ops Handbook.md',
        lastModifiedDateTime: '2026-05-23T00:00:00.000Z',
      }),
      'utf-8',
    );
    await writeFile(join(stagedDir, 'docs', 'team-docs', 'ops-handbook-abc123', 'page.md'), '# Ops Handbook\n', 'utf-8');

    const result = await chunkSharepointStagedDir(stagedDir, {
      added: ['docs\\team-docs\\ops-handbook-abc123\\metadata.json', 'docs\\team-docs\\ops-handbook-abc123\\page.md'],
      modified: [],
      deleted: ['docs\\old-doc\\page.md'],
      unchanged: ['manifest.json'],
    });

    expect(result.workUnits).toHaveLength(1);
    expect(result.workUnits[0]).toMatchObject({
      displayLabel: 'Team Docs / Ops Handbook',
      rawFiles: ['docs/team-docs/ops-handbook-abc123/metadata.json', 'docs/team-docs/ops-handbook-abc123/page.md'],
      dependencyPaths: ['manifest.json'],
    });
    expect(result.workUnits[0].notes).toContain('Do not create semantic-layer sources from sharepoint content in v1.');
    expect(result.eviction).toEqual({ deletedRawPaths: ['docs/old-doc/page.md'] });
  });
});
