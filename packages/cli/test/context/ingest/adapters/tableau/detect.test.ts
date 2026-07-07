import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { detectTableauStagedDir } from '../../../../../src/context/ingest/adapters/tableau/detect.js';

const FIXTURES = resolve(import.meta.dirname, '../../../../fixtures/tableau');

describe('detectTableauStagedDir', () => {
  let dir: string;

  beforeEach(async () => {
    dir = await mkdtemp(join(tmpdir(), 'tableau-detect-'));
  });

  afterEach(async () => {
    await rm(dir, { recursive: true, force: true });
  });

  it('returns true for a valid staged dir with a manifest and a datasource', async () => {
    expect(await detectTableauStagedDir(join(FIXTURES, 'single'))).toBe(true);
  });

  it('returns false when the manifest is missing', async () => {
    await mkdir(join(dir, 'datasources'), { recursive: true });
    await writeFile(join(dir, 'datasources', 'ds-1.json'), '{}', 'utf-8');
    expect(await detectTableauStagedDir(dir)).toBe(false);
  });

  it('returns false when the manifest exists but no datasource/workbook json is present', async () => {
    await writeFile(join(dir, 'tableau-manifest.json'), '{}', 'utf-8');
    expect(await detectTableauStagedDir(dir)).toBe(false);
  });

  it('returns true when only a workbook json is present alongside the manifest', async () => {
    await writeFile(join(dir, 'tableau-manifest.json'), '{}', 'utf-8');
    await mkdir(join(dir, 'workbooks'), { recursive: true });
    await writeFile(join(dir, 'workbooks', 'wb-1.json'), '{}', 'utf-8');
    expect(await detectTableauStagedDir(dir)).toBe(true);
  });
});
