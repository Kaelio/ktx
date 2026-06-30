import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { SigmaSourceAdapter } from '../../../../../src/context/ingest/adapters/sigma/sigma.adapter.js';
import type { SigmaClientFactory } from '../../../../../src/context/ingest/adapters/sigma/client-port.js';

function makeFactory(): SigmaClientFactory {
  return { createClient: vi.fn() };
}

describe('SigmaSourceAdapter.listTargetConnectionIds', () => {
  let stagedDir: string;

  beforeEach(async () => {
    stagedDir = await mkdtemp(join(tmpdir(), 'sigma-adapter-'));
  });

  afterEach(async () => {
    await rm(stagedDir, { recursive: true, force: true });
  });

  async function writeProjectionConfig(mappings: Record<string, string>) {
    await writeFile(
      join(stagedDir, 'sigma-projection-config.json'),
      JSON.stringify({ connectionMappings: mappings }),
      'utf-8',
    );
  }

  it('returns mapped warehouse connection IDs when mappings are present', async () => {
    await writeProjectionConfig({ 'uuid-a': 'snowflake-prod', 'uuid-b': 'snowflake-prod', 'uuid-c': 'bigquery-prod' });
    const adapter = new SigmaSourceAdapter({ clientFactory: makeFactory() });
    const ids = await adapter.listTargetConnectionIds(stagedDir);
    expect(ids).toEqual(['bigquery-prod', 'snowflake-prod']);
  });

  it('returns empty array when connectionMappings is empty', async () => {
    await writeProjectionConfig({});
    const adapter = new SigmaSourceAdapter({ clientFactory: makeFactory() });
    const ids = await adapter.listTargetConnectionIds(stagedDir);
    expect(ids).toEqual([]);
  });

  it('returns empty array when the projection config file is missing', async () => {
    const adapter = new SigmaSourceAdapter({ clientFactory: makeFactory() });
    const ids = await adapter.listTargetConnectionIds(stagedDir);
    expect(ids).toEqual([]);
  });

  it('returns empty array when the projection config is malformed', async () => {
    await mkdir(stagedDir, { recursive: true });
    await writeFile(join(stagedDir, 'sigma-projection-config.json'), 'not json', 'utf-8');
    const adapter = new SigmaSourceAdapter({ clientFactory: makeFactory() });
    const ids = await adapter.listTargetConnectionIds(stagedDir);
    expect(ids).toEqual([]);
  });

  it('returns empty array when both projection config and manifest are missing', async () => {
    const adapter = new SigmaSourceAdapter({ clientFactory: makeFactory() });
    const ids = await adapter.listTargetConnectionIds(stagedDir);
    expect(ids).toEqual([]);
  });
});
