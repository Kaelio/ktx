import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { SharepointSourceAdapter } from '../../../../../src/context/ingest/adapters/sharepoint/sharepoint.adapter.js';

describe('SharepointSourceAdapter', () => {
  let stagedDir: string;

  beforeEach(async () => {
    stagedDir = await mkdtemp(join(tmpdir(), 'ktx-sharepoint-adapter-'));
  });

  afterEach(async () => {
    await rm(stagedDir, { recursive: true, force: true });
  });

  it('declares sharepoint source behavior', () => {
    const adapter = new SharepointSourceAdapter();
    expect(adapter.source).toBe('sharepoint');
    expect(adapter.skillNames).toEqual(['sharepoint_synthesize']);
    expect(adapter.reconcileSkillNames).toEqual([]);
    expect(adapter.evidenceIndexing).toBe('documents');
  });

  it('detects a sharepoint staged dir from manifest source', async () => {
    const adapter = new SharepointSourceAdapter();
    await writeFile(join(stagedDir, 'manifest.json'), JSON.stringify({ source: 'sharepoint' }), 'utf-8');
    await expect(adapter.detect(stagedDir)).resolves.toBe(true);
  });

  it('describes complete folder scope', async () => {
    const adapter = new SharepointSourceAdapter();
    await writeFile(
      join(stagedDir, 'manifest.json'),
      JSON.stringify({
        source: 'sharepoint',
        driveId: 'drive-1',
        folderId: 'folder-1',
        recursive: false,
        fetchedAt: '2026-05-23T00:00:00.000Z',
        fileCount: 0,
        skipped: [],
        warnings: [],
      }),
      'utf-8',
    );
    await mkdir(join(stagedDir, 'docs'), { recursive: true });

    const scope = await adapter.describeScope?.(stagedDir);
    expect(scope?.isPathInScope('manifest.json')).toBe(true);
    expect(scope?.isPathInScope('docs/example/page.md')).toBe(true);
    expect(scope?.isPathInScope('pages/example/page.md')).toBe(false);
  });
});
