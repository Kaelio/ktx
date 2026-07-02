import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { chunkSigmaStagedDir } from '../../../../../src/context/ingest/adapters/sigma/chunk.js';

// Keep in sync with constants in chunk.ts
const DATA_MODELS_PER_UNIT = 50;
const WORKBOOKS_PER_UNIT = 2000;

const FIXTURES = resolve(import.meta.dirname, '../../../../fixtures/sigma');
const SINGLE = join(FIXTURES, 'single-folder');
const MULTI = join(FIXTURES, 'multi-folder');
const EMPTY = join(FIXTURES, 'empty-manifest');

describe('chunkSigmaStagedDir — first run', () => {
  it('single-folder fixture emits two WUs (data-models and workbooks)', async () => {
    const result = await chunkSigmaStagedDir(SINGLE);
    expect(result.workUnits).toHaveLength(2);
  });

  it('data-models WU has correct unitKey and displayLabel', async () => {
    const result = await chunkSigmaStagedDir(SINGLE);
    const wu = result.workUnits.find((w) => w.unitKey === 'sigma-data-models')!;
    expect(wu).toBeDefined();
    expect(wu.displayLabel).toBe('Sigma: data models');
  });

  it('workbooks WU has correct unitKey and displayLabel', async () => {
    const result = await chunkSigmaStagedDir(SINGLE);
    const wu = result.workUnits.find((w) => w.unitKey === 'sigma-workbooks')!;
    expect(wu).toBeDefined();
    expect(wu.displayLabel).toBe('Sigma: workbooks');
  });

  it('data-models WU rawFiles contains data model files but not the manifest', async () => {
    const result = await chunkSigmaStagedDir(SINGLE);
    const wu = result.workUnits.find((w) => w.unitKey === 'sigma-data-models')!;
    expect(wu.rawFiles).toContain('data-models/dm-aaa111.json');
    expect(wu.rawFiles).toContain('data-models/dm-bbb222.json');
    expect(wu.rawFiles).not.toContain('sigma-manifest.json');
    expect(wu.rawFiles).not.toContain('workbooks/wb-xxx111.json');
  });

  it('manifest is in peerFileIndex so the LLM can read it without affecting the hash', async () => {
    const result = await chunkSigmaStagedDir(SINGLE);
    const dmWu = result.workUnits.find((w) => w.unitKey === 'sigma-data-models')!;
    const wbWu = result.workUnits.find((w) => w.unitKey === 'sigma-workbooks')!;
    expect(dmWu.peerFileIndex).toContain('sigma-manifest.json');
    expect(wbWu.peerFileIndex).toContain('sigma-manifest.json');
  });

  it('workbooks WU rawFiles contains workbook files but not the manifest', async () => {
    const result = await chunkSigmaStagedDir(SINGLE);
    const wu = result.workUnits.find((w) => w.unitKey === 'sigma-workbooks')!;
    expect(wu.rawFiles).toContain('workbooks/wb-xxx111.json');
    expect(wu.rawFiles).not.toContain('sigma-manifest.json');
    expect(wu.rawFiles).not.toContain('data-models/dm-aaa111.json');
  });

  it('data-models WU peerFileIndex contains workbook files', async () => {
    const result = await chunkSigmaStagedDir(SINGLE);
    const wu = result.workUnits.find((w) => w.unitKey === 'sigma-data-models')!;
    expect(wu.peerFileIndex).toContain('workbooks/wb-xxx111.json');
  });

  it('workbooks WU peerFileIndex contains data model files', async () => {
    const result = await chunkSigmaStagedDir(SINGLE);
    const wu = result.workUnits.find((w) => w.unitKey === 'sigma-workbooks')!;
    expect(wu.peerFileIndex).toContain('data-models/dm-aaa111.json');
    expect(wu.peerFileIndex).toContain('data-models/dm-bbb222.json');
  });

  it('data-models WU notes describes model count', async () => {
    const result = await chunkSigmaStagedDir(SINGLE);
    const wu = result.workUnits.find((w) => w.unitKey === 'sigma-data-models')!;
    expect(wu.notes).toBe('2 data models');
  });

  it('workbooks WU notes describes workbook count', async () => {
    const result = await chunkSigmaStagedDir(SINGLE);
    const wu = result.workUnits.find((w) => w.unitKey === 'sigma-workbooks')!;
    expect(wu.notes).toBe('1 workbook');
  });

  it('dependencyPaths is empty on first run for both WUs', async () => {
    const result = await chunkSigmaStagedDir(SINGLE);
    for (const wu of result.workUnits) {
      expect(wu.dependencyPaths).toEqual([]);
    }
  });

  it('multi-folder fixture still emits two WUs (data-models and workbooks)', async () => {
    const result = await chunkSigmaStagedDir(MULTI);
    expect(result.workUnits).toHaveLength(2);
    expect(result.workUnits.map((w) => w.unitKey).sort()).toEqual(['sigma-data-models', 'sigma-workbooks']);
  });

  it('multi-folder: data-models WU contains all data models regardless of folder', async () => {
    const result = await chunkSigmaStagedDir(MULTI);
    const wu = result.workUnits.find((w) => w.unitKey === 'sigma-data-models')!;
    expect(wu.rawFiles).toContain('data-models/dm-aaa111.json');
    expect(wu.rawFiles).toContain('data-models/dm-bbb222.json');
    expect(wu.rawFiles).toContain('data-models/dm-ccc333.json');
  });

  it('multi-folder: workbooks WU contains all workbooks regardless of folder', async () => {
    const result = await chunkSigmaStagedDir(MULTI);
    const wu = result.workUnits.find((w) => w.unitKey === 'sigma-workbooks')!;
    expect(wu.rawFiles).toContain('workbooks/wb-yyy222.json');
    expect(wu.rawFiles).toContain('workbooks/wb-zzz333.json');
  });

  it('unitKey is slug-safe (no slashes or spaces)', async () => {
    const result = await chunkSigmaStagedDir(SINGLE);
    for (const wu of result.workUnits) {
      expect(wu.unitKey).toMatch(/^[a-zA-Z0-9_-]+$/);
    }
  });

  it('empty-manifest fixture emits zero WUs', async () => {
    const result = await chunkSigmaStagedDir(EMPTY);
    expect(result.workUnits).toHaveLength(0);
  });

  it('missing manifest directory emits zero WUs without crashing', async () => {
    const result = await chunkSigmaStagedDir('/tmp/sigma-nonexistent-dir-ktx-test');
    expect(result.workUnits).toHaveLength(0);
  });

  it('is deterministic: two identical calls produce structurally equal output', async () => {
    const r1 = await chunkSigmaStagedDir(SINGLE);
    const r2 = await chunkSigmaStagedDir(SINGLE);
    expect(JSON.stringify(r1)).toBe(JSON.stringify(r2));
  });
});

describe('chunkSigmaStagedDir — data model batching', () => {
  let stagedDir: string;

  beforeEach(async () => {
    stagedDir = await mkdtemp(join(tmpdir(), 'sigma-dm-batch-'));
    await mkdir(join(stagedDir, 'data-models'), { recursive: true });
    const manifest = JSON.stringify({
      fetchedAt: new Date().toISOString(),
      dataModelCount: DATA_MODELS_PER_UNIT + 1,
      workbookCount: 0,
      sigmaConnectionId: 'conn-1',
    });
    await writeFile(join(stagedDir, 'sigma-manifest.json'), manifest);
    for (let i = 0; i < DATA_MODELS_PER_UNIT + 1; i++) {
      const dm = JSON.stringify({
        sigmaId: `dm-${i}`,
        name: `Data Model ${i}`,
        path: 'Engineering',
        latestVersion: 1,
        updatedAt: '2026-01-01T00:00:00Z',
        isArchived: false,
        dataModelUrlId: `url-${i}`,
        spec: null,
      });
      await writeFile(join(stagedDir, 'data-models', `dm-${String(i).padStart(6, '0')}.json`), dm);
    }
  });

  afterEach(async () => {
    await rm(stagedDir, { recursive: true, force: true });
  });

  it('splits into two data model WUs when count exceeds DATA_MODELS_PER_UNIT', async () => {
    const result = await chunkSigmaStagedDir(stagedDir);
    const dmUnits = result.workUnits.filter((w) => w.unitKey.startsWith('sigma-data-models'));
    expect(dmUnits).toHaveLength(2);
  });

  it('batched data model WUs get indexed unitKeys (sigma-data-models-0, sigma-data-models-1)', async () => {
    const result = await chunkSigmaStagedDir(stagedDir);
    const keys = result.workUnits.map((w) => w.unitKey).filter((k) => k.startsWith('sigma-data-models')).sort();
    expect(keys).toEqual(['sigma-data-models-0', 'sigma-data-models-1']);
  });

  it('first batch has exactly DATA_MODELS_PER_UNIT files (manifest excluded from rawFiles)', async () => {
    const result = await chunkSigmaStagedDir(stagedDir);
    const wu = result.workUnits.find((w) => w.unitKey === 'sigma-data-models-0')!;
    expect(wu.rawFiles).toHaveLength(DATA_MODELS_PER_UNIT);
  });

  it('displayLabel includes batch position when split', async () => {
    const result = await chunkSigmaStagedDir(stagedDir);
    const wu = result.workUnits.find((w) => w.unitKey === 'sigma-data-models-0')!;
    expect(wu.displayLabel).toMatch(/\(1\/2\)/);
  });
});

describe('chunkSigmaStagedDir — workbook batching', () => {
  let stagedDir: string;

  beforeEach(async () => {
    stagedDir = await mkdtemp(join(tmpdir(), 'sigma-batch-'));
    await mkdir(join(stagedDir, 'workbooks'), { recursive: true });
    const manifest = JSON.stringify({
      fetchedAt: new Date().toISOString(),
      dataModelCount: 0,
      workbookCount: WORKBOOKS_PER_UNIT + 1,
      sigmaConnectionId: 'conn-1',
    });
    await writeFile(join(stagedDir, 'sigma-manifest.json'), manifest);
    for (let i = 0; i < WORKBOOKS_PER_UNIT + 1; i++) {
      const wb = JSON.stringify({
        sigmaId: `wb-${i}`,
        name: `Workbook ${i}`,
        path: 'Finance',
        latestVersion: 1,
        updatedAt: '2026-01-01T00:00:00Z',
        isArchived: false,
        workbookUrlId: `url-${i}`,
      });
      await writeFile(join(stagedDir, 'workbooks', `wb-${String(i).padStart(6, '0')}.json`), wb);
    }
  });

  afterEach(async () => {
    await rm(stagedDir, { recursive: true, force: true });
  });

  it('splits into two workbook WUs when count exceeds WORKBOOKS_PER_UNIT', async () => {
    const result = await chunkSigmaStagedDir(stagedDir);
    const wbUnits = result.workUnits.filter((w) => w.unitKey.startsWith('sigma-workbooks'));
    expect(wbUnits).toHaveLength(2);
  });

  it('batched WUs get indexed unitKeys (sigma-workbooks-0, sigma-workbooks-1)', async () => {
    const result = await chunkSigmaStagedDir(stagedDir);
    const keys = result.workUnits.map((w) => w.unitKey).filter((k) => k.startsWith('sigma-workbooks')).sort();
    expect(keys).toEqual(['sigma-workbooks-0', 'sigma-workbooks-1']);
  });

  it('first batch has exactly WORKBOOKS_PER_UNIT files (manifest excluded from rawFiles)', async () => {
    const result = await chunkSigmaStagedDir(stagedDir);
    const wu = result.workUnits.find((w) => w.unitKey === 'sigma-workbooks-0')!;
    expect(wu.rawFiles).toHaveLength(WORKBOOKS_PER_UNIT);
  });

  it('second batch has the remainder only', async () => {
    const result = await chunkSigmaStagedDir(stagedDir);
    const wu = result.workUnits.find((w) => w.unitKey === 'sigma-workbooks-1')!;
    expect(wu.rawFiles).toHaveLength(1); // 1 overflow workbook
  });

  it('displayLabel includes batch position when split', async () => {
    const result = await chunkSigmaStagedDir(stagedDir);
    const wu = result.workUnits.find((w) => w.unitKey === 'sigma-workbooks-0')!;
    expect(wu.displayLabel).toMatch(/\(1\/2\)/);
  });
});

describe('chunkSigmaStagedDir — diffSet re-sync', () => {
  let stagedDir: string;

  beforeEach(async () => {
    stagedDir = await mkdtemp(join(tmpdir(), 'sigma-chunk-diff-'));
    await mkdir(join(stagedDir, 'data-models'), { recursive: true });
    const fs = await import('node:fs/promises');
    const manifestBody = await fs.readFile(join(SINGLE, 'sigma-manifest.json'), 'utf-8');
    await writeFile(join(stagedDir, 'sigma-manifest.json'), manifestBody);
    for (const file of ['dm-aaa111.json', 'dm-bbb222.json']) {
      const body = await fs.readFile(join(SINGLE, 'data-models', file), 'utf-8');
      await writeFile(join(stagedDir, 'data-models', file), body);
    }
  });

  afterEach(async () => {
    await rm(stagedDir, { recursive: true, force: true });
  });

  it('only the WU containing the modified file is kept', async () => {
    const result = await chunkSigmaStagedDir(stagedDir, {
      diffSet: {
        added: [],
        modified: ['data-models/dm-aaa111.json'],
        deleted: [],
        unchanged: ['data-models/dm-bbb222.json', 'sigma-manifest.json'],
      },
    });
    expect(result.workUnits).toHaveLength(1);
    expect(result.workUnits[0]!.rawFiles).toEqual(['data-models/dm-aaa111.json']);
  });

  it('unchanged sibling data-model moves to dependencyPaths', async () => {
    const result = await chunkSigmaStagedDir(stagedDir, {
      diffSet: {
        added: [],
        modified: ['data-models/dm-aaa111.json'],
        deleted: [],
        unchanged: ['data-models/dm-bbb222.json', 'sigma-manifest.json'],
      },
    });
    expect(result.workUnits[0]!.dependencyPaths).toContain('data-models/dm-bbb222.json');
  });

  it('all-unchanged diffSet produces zero WUs and no eviction', async () => {
    const result = await chunkSigmaStagedDir(stagedDir, {
      diffSet: {
        added: [],
        modified: [],
        deleted: [],
        unchanged: ['data-models/dm-aaa111.json', 'data-models/dm-bbb222.json', 'sigma-manifest.json'],
      },
    });
    expect(result.workUnits).toHaveLength(0);
    expect(result.eviction).toBeUndefined();
  });

  it('deleted paths produce an eviction unit listing those paths', async () => {
    const result = await chunkSigmaStagedDir(stagedDir, {
      diffSet: {
        added: [],
        modified: [],
        deleted: ['data-models/dm-aaa111.json'],
        unchanged: ['data-models/dm-bbb222.json', 'sigma-manifest.json'],
      },
    });
    expect(result.eviction?.deletedRawPaths).toContain('data-models/dm-aaa111.json');
  });
});
