import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type {
  TableauClientFactory,
  TableauRuntimeClient,
} from '../../../../../src/context/ingest/adapters/tableau/client-port.js';
import { TableauSourceAdapter } from '../../../../../src/context/ingest/adapters/tableau/tableau.adapter.js';

const FIXTURES = resolve(import.meta.dirname, '../../../../fixtures/tableau');
const CTX = { connectionId: 'tableau-main', sourceKey: 'tableau' };

function fakeClient(): TableauRuntimeClient {
  return {
    testConnection: vi.fn().mockResolvedValue({ success: true }),
    listDatasources: vi.fn().mockResolvedValue([]),
    listWorkbooks: vi.fn().mockResolvedValue([]),
    cleanup: vi.fn().mockResolvedValue(undefined),
  };
}

function adapter(client: TableauRuntimeClient): TableauSourceAdapter {
  const clientFactory: TableauClientFactory = { createClient: vi.fn().mockResolvedValue(client) };
  return new TableauSourceAdapter({ clientFactory, now: () => new Date('2026-04-30T12:30:00.000Z') });
}

describe('TableauSourceAdapter', () => {
  let dir: string;

  beforeEach(async () => {
    dir = await mkdtemp(join(tmpdir(), 'tableau-adapter-'));
  });

  afterEach(async () => {
    await rm(dir, { recursive: true, force: true });
  });

  it('exposes the tableau source key and ingest skill', () => {
    const a = adapter(fakeClient());
    expect(a.source).toBe('tableau');
    expect(a.skillNames).toEqual(['tableau_ingest']);
  });

  it('detects a staged fixture bundle', async () => {
    const a = adapter(fakeClient());
    expect(await a.detect(resolve(FIXTURES, 'single'))).toBe(true);
  });

  it('fetch() drives the client and produces a detectable, chunkable bundle', async () => {
    const client = fakeClient();
    vi.mocked(client.listDatasources).mockResolvedValue([
      { luid: 'ds-1', name: 'Sales', fields: [], upstreamTables: [] },
    ]);
    const a = adapter(client);

    await a.fetch({ tableauConnectionId: 'tableau-main' }, dir, CTX);

    expect(client.listDatasources).toHaveBeenCalledTimes(1);
    expect(await a.detect(dir)).toBe(true);
    const chunked = await a.chunk(dir);
    expect(chunked.workUnits.map((u) => u.unitKey)).toContain('tableau-datasources');
  });
});
