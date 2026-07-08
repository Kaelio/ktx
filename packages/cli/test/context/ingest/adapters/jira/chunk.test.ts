import { cp, mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { chunkJiraStagedDir } from '../../../../../src/context/ingest/adapters/jira/chunk.js';

const FIXTURES_DIR = new URL('./fixtures', import.meta.url).pathname;

describe('chunkJiraStagedDir', () => {
  let stagedDir: string;

  beforeEach(async () => {
    stagedDir = await mkdtemp(join(tmpdir(), 'jira-chunk-'));
    await cp(FIXTURES_DIR, stagedDir, { recursive: true });
  });

  afterEach(async () => {
    await rm(stagedDir, { recursive: true, force: true });
  });

  it('produces one work unit per project', async () => {
    const result = await chunkJiraStagedDir(stagedDir);
    expect(result.workUnits).toHaveLength(1);
    expect(result.workUnits[0].unitKey).toBe('jira-docs');
  });

  it('work unit displayLabel includes project key and issue count', async () => {
    const result = await chunkJiraStagedDir(stagedDir);
    expect(result.workUnits[0].displayLabel).toMatch(/Jira: DOCS/);
    expect(result.workUnits[0].displayLabel).toMatch(/2 issues/);
  });

  it('work unit rawFiles contains the issue paths', async () => {
    const result = await chunkJiraStagedDir(stagedDir);
    const rawFiles = result.workUnits[0].rawFiles;
    expect(rawFiles.some((f) => f.endsWith('DOCS-1.json'))).toBe(true);
    expect(rawFiles.some((f) => f.endsWith('DOCS-2.json'))).toBe(true);
  });

  it('manifest.json is in dependencyPaths', async () => {
    const result = await chunkJiraStagedDir(stagedDir);
    expect(result.workUnits[0].dependencyPaths).toContain('manifest.json');
  });

  it('reconcileNotes include project and label info', async () => {
    const result = await chunkJiraStagedDir(stagedDir);
    expect(result.reconcileNotes?.some((n) => n.includes('DOCS'))).toBe(true);
    expect(result.reconcileNotes?.some((n) => n.includes('kb'))).toBe(true);
  });
});
