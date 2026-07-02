import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { detectSigmaStagedDir } from '../../../../../src/context/ingest/adapters/sigma/detect.js';

async function touch(dir: string, relPath: string, body = '{}'): Promise<void> {
  const abs = join(dir, relPath);
  await mkdir(join(abs, '..'), { recursive: true });
  await writeFile(abs, body, 'utf-8');
}

describe('detectSigmaStagedDir', () => {
  let stagedDir: string;

  beforeEach(async () => {
    stagedDir = await mkdtemp(join(tmpdir(), 'sigma-detect-'));
  });

  afterEach(async () => {
    await rm(stagedDir, { recursive: true, force: true });
  });

  it('returns true when manifest and at least one data-model file are present', async () => {
    await touch(stagedDir, 'sigma-manifest.json');
    await touch(stagedDir, 'data-models/dm-aaa111.json');
    expect(await detectSigmaStagedDir(stagedDir)).toBe(true);
  });

  it('returns true when manifest and at least one workbook file are present', async () => {
    await touch(stagedDir, 'sigma-manifest.json');
    await touch(stagedDir, 'workbooks/wb-xxx111.json');
    expect(await detectSigmaStagedDir(stagedDir)).toBe(true);
  });

  it('returns false when sigma-manifest.json is absent', async () => {
    await touch(stagedDir, 'data-models/dm-aaa111.json');
    expect(await detectSigmaStagedDir(stagedDir)).toBe(false);
  });

  it('returns false for a completely empty directory', async () => {
    expect(await detectSigmaStagedDir(stagedDir)).toBe(false);
  });

  it('returns false when manifest is present but both entity dirs are empty', async () => {
    await touch(stagedDir, 'sigma-manifest.json');
    await mkdir(join(stagedDir, 'data-models'), { recursive: true });
    await mkdir(join(stagedDir, 'workbooks'), { recursive: true });
    expect(await detectSigmaStagedDir(stagedDir)).toBe(false);
  });

  it('returns false when manifest is present but entity dirs are absent', async () => {
    await touch(stagedDir, 'sigma-manifest.json');
    expect(await detectSigmaStagedDir(stagedDir)).toBe(false);
  });

  it('returns false when only unrelated files are present', async () => {
    await touch(stagedDir, 'data-models/dm-aaa111.json');
    expect(await detectSigmaStagedDir(stagedDir)).toBe(false);
  });
});
