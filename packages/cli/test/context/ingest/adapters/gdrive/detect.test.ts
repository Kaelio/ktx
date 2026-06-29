import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { detectGdriveStagedDir } from '../../../../../src/context/ingest/adapters/gdrive/detect.js';

describe('detectGdriveStagedDir', () => {
  let stagedDir: string;

  beforeEach(async () => {
    stagedDir = await mkdtemp(join(tmpdir(), 'ktx-gdrive-detect-'));
  });

  afterEach(async () => {
    await rm(stagedDir, { recursive: true, force: true });
  });

  it('detects a manifest-backed gdrive staged dir', async () => {
    await writeFile(join(stagedDir, 'manifest.json'), JSON.stringify({ source: 'gdrive' }), 'utf-8');
    await expect(detectGdriveStagedDir(stagedDir)).resolves.toBe(true);
  });
});
