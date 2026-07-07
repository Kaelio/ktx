import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { detectSharepointStagedDir } from '../../../../../src/context/ingest/adapters/sharepoint/detect.js';

describe('detectSharepointStagedDir', () => {
  let stagedDir: string;

  beforeEach(async () => {
    stagedDir = await mkdtemp(join(tmpdir(), 'ktx-sharepoint-detect-'));
  });

  afterEach(async () => {
    await rm(stagedDir, { recursive: true, force: true });
  });

  it('detects a manifest-backed sharepoint staged dir', async () => {
    await writeFile(join(stagedDir, 'manifest.json'), JSON.stringify({ source: 'sharepoint' }), 'utf-8');
    await expect(detectSharepointStagedDir(stagedDir)).resolves.toBe(true);
  });
});
