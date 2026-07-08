import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { detectConfluenceStagedDir } from '../../../../../src/context/ingest/adapters/confluence/detect.js';

async function touch(dir: string, relPath: string, body = '{}'): Promise<void> {
  const abs = join(dir, relPath);
  await mkdir(join(abs, '..'), { recursive: true });
  await writeFile(abs, body, 'utf-8');
}

describe('detectConfluenceStagedDir', () => {
  let stagedDir: string;

  beforeEach(async () => {
    stagedDir = await mkdtemp(join(tmpdir(), 'confluence-detect-'));
  });

  afterEach(async () => {
    await rm(stagedDir, { recursive: true, force: true });
  });

  it('returns true when manifest and page files are present', async () => {
    await touch(stagedDir, 'confluence-manifest.json');
    await touch(stagedDir, 'pages/aaa111.json');
    expect(await detectConfluenceStagedDir(stagedDir)).toBe(true);
  });

  it('returns true when manifest is present with no pages (zero-page fetch)', async () => {
    await touch(stagedDir, 'confluence-manifest.json');
    expect(await detectConfluenceStagedDir(stagedDir)).toBe(true);
  });

  it('returns true when manifest is present and pages dir exists but is empty', async () => {
    await touch(stagedDir, 'confluence-manifest.json');
    await mkdir(join(stagedDir, 'pages'), { recursive: true });
    expect(await detectConfluenceStagedDir(stagedDir)).toBe(true);
  });

  it('returns false when confluence-manifest.json is absent', async () => {
    await touch(stagedDir, 'pages/aaa111.json');
    expect(await detectConfluenceStagedDir(stagedDir)).toBe(false);
  });

  it('returns false for a completely empty directory', async () => {
    expect(await detectConfluenceStagedDir(stagedDir)).toBe(false);
  });

  it('returns false when only unrelated files are present', async () => {
    await touch(stagedDir, 'pages/aaa111.json');
    expect(await detectConfluenceStagedDir(stagedDir)).toBe(false);
  });
});
