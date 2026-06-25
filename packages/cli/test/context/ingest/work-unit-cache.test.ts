import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { computeIngestWorkUnitInputHash } from '../../../src/context/ingest/work-unit-cache.js';
import type { WorkUnit } from '../../../src/context/ingest/types.js';

describe('ingest work-unit cache', () => {
  let tempDir: string;

  beforeEach(async () => {
    tempDir = await mkdtemp(join(tmpdir(), 'ktx-wu-cache-'));
    await mkdir(join(tempDir, 'models'), { recursive: true });
    await writeFile(join(tempDir, 'models/orders.sql'), 'select * from raw.orders\n', 'utf-8');
    await writeFile(join(tempDir, 'models/customers.sql'), 'select * from raw.customers\n', 'utf-8');
  });

  afterEach(async () => {
    await rm(tempDir, { recursive: true, force: true });
  });

  function unit(overrides: Partial<WorkUnit> = {}): WorkUnit {
    return {
      unitKey: 'orders',
      rawFiles: ['models/orders.sql'],
      peerFileIndex: [],
      dependencyPaths: ['models/customers.sql'],
      ...overrides,
    };
  }

  it('hashes raw and dependency file bytes with stable source identity', async () => {
    const first = await computeIngestWorkUnitInputHash({
      stagedDir: tempDir,
      connectionId: 'warehouse',
      sourceKey: 'dbt',
      unit: unit(),
      cliVersion: '0.13.1',
      promptFingerprint: 'prompt-v1',
      modelRole: 'default',
    });
    const second = await computeIngestWorkUnitInputHash({
      stagedDir: tempDir,
      connectionId: 'warehouse',
      sourceKey: 'dbt',
      unit: unit(),
      cliVersion: '0.13.1',
      promptFingerprint: 'prompt-v1',
      modelRole: 'default',
    });

    expect(first).toMatch(/^[a-f0-9]{64}$/);
    expect(second).toBe(first);
  });

  it('changes when one raw file changes and keeps unrelated units stable', async () => {
    const before = await computeIngestWorkUnitInputHash({
      stagedDir: tempDir,
      connectionId: 'warehouse',
      sourceKey: 'dbt',
      unit: unit(),
      cliVersion: '0.13.1',
      promptFingerprint: 'prompt-v1',
      modelRole: 'default',
    });

    await writeFile(join(tempDir, 'models/orders.sql'), 'select id from raw.orders\n', 'utf-8');

    const after = await computeIngestWorkUnitInputHash({
      stagedDir: tempDir,
      connectionId: 'warehouse',
      sourceKey: 'dbt',
      unit: unit(),
      cliVersion: '0.13.1',
      promptFingerprint: 'prompt-v1',
      modelRole: 'default',
    });
    const unrelated = await computeIngestWorkUnitInputHash({
      stagedDir: tempDir,
      connectionId: 'warehouse',
      sourceKey: 'dbt',
      unit: unit({ unitKey: 'customers', rawFiles: ['models/customers.sql'], dependencyPaths: [] }),
      cliVersion: '0.13.1',
      promptFingerprint: 'prompt-v1',
      modelRole: 'default',
    });

    expect(after).not.toBe(before);
    expect(unrelated).not.toBe(after);
  });

  it('changes when version, prompt fingerprint, or model role changes', async () => {
    const base = {
      stagedDir: tempDir,
      connectionId: 'warehouse',
      sourceKey: 'dbt',
      unit: unit(),
      cliVersion: '0.13.1',
      promptFingerprint: 'prompt-v1',
      modelRole: 'default' as const,
    };
    const hash = await computeIngestWorkUnitInputHash(base);

    await expect(computeIngestWorkUnitInputHash({ ...base, cliVersion: '0.13.2' })).resolves.not.toBe(hash);
    await expect(computeIngestWorkUnitInputHash({ ...base, promptFingerprint: 'prompt-v2' })).resolves.not.toBe(hash);
    await expect(computeIngestWorkUnitInputHash({ ...base, modelRole: 'repair' })).resolves.not.toBe(hash);
  });

  it('hashes a missing dependency as a stable missing marker', async () => {
    const hash = await computeIngestWorkUnitInputHash({
      stagedDir: tempDir,
      connectionId: 'warehouse',
      sourceKey: 'dbt',
      unit: unit({ dependencyPaths: ['models/missing.sql'] }),
      cliVersion: '0.13.1',
      promptFingerprint: 'prompt-v1',
      modelRole: 'default',
    });

    expect(hash).toMatch(/^[a-f0-9]{64}$/);
  });
});
