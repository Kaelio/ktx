import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { GdriveSourceAdapter } from '../../../../../src/context/ingest/adapters/gdrive/gdrive.adapter.js';

describe('GdriveSourceAdapter', () => {
  let stagedDir: string;

  beforeEach(async () => {
    stagedDir = await mkdtemp(join(tmpdir(), 'ktx-gdrive-adapter-'));
  });

  afterEach(async () => {
    await rm(stagedDir, { recursive: true, force: true });
  });

  it('declares gdrive source behavior', () => {
    const adapter = new GdriveSourceAdapter();
    expect(adapter.source).toBe('gdrive');
    expect(adapter.skillNames).toEqual(['gdrive_synthesize']);
    expect(adapter.reconcileSkillNames).toEqual([]);
    expect(adapter.evidenceIndexing).toBe('documents');
  });

  it('detects a gdrive staged dir from manifest source', async () => {
    const adapter = new GdriveSourceAdapter();
    await writeFile(join(stagedDir, 'manifest.json'), JSON.stringify({ source: 'gdrive' }), 'utf-8');
    await expect(adapter.detect(stagedDir)).resolves.toBe(true);
  });

  it('reports malformed manifests with a gdrive-specific error', async () => {
    const adapter = new GdriveSourceAdapter();
    await writeFile(join(stagedDir, 'manifest.json'), '{bad json', 'utf-8');
    await expect(adapter.chunk(stagedDir)).rejects.toThrow(/Invalid gdrive manifest/);
  });

  it('describes complete folder scope', async () => {
    const adapter = new GdriveSourceAdapter();
    await writeFile(
      join(stagedDir, 'manifest.json'),
      JSON.stringify({
        source: 'gdrive',
        folderId: 'folder-123',
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
