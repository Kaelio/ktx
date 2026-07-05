import { mkdtemp, readFile, readdir, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type {
  TableauClientFactory,
  TableauDatasourceRecord,
  TableauRuntimeClient,
  TableauWorkbookRecord,
} from '../../../../../src/context/ingest/adapters/tableau/client-port.js';
import { fetchTableauBundle } from '../../../../../src/context/ingest/adapters/tableau/fetch.js';

const CTX = { connectionId: 'tableau-main', sourceKey: 'tableau' };

function fakeClient(overrides: Partial<TableauRuntimeClient> = {}): TableauRuntimeClient {
  return {
    testConnection: vi.fn().mockResolvedValue({ success: true }),
    listDatasources: vi.fn().mockResolvedValue([] as TableauDatasourceRecord[]),
    listWorkbooks: vi.fn().mockResolvedValue([] as TableauWorkbookRecord[]),
    cleanup: vi.fn().mockResolvedValue(undefined),
    ...overrides,
  };
}

function factoryFor(client: TableauRuntimeClient): TableauClientFactory {
  return { createClient: vi.fn().mockResolvedValue(client) };
}

const NOW = () => new Date('2026-04-30T12:30:00.000Z');

describe('fetchTableauBundle', () => {
  let dir: string;

  beforeEach(async () => {
    dir = await mkdtemp(join(tmpdir(), 'tableau-fetch-'));
  });

  afterEach(async () => {
    await rm(dir, { recursive: true, force: true });
  });

  it('stages data sources (with calculated fields + upstream tables) and workbooks', async () => {
    const client = fakeClient({
      listDatasources: vi.fn().mockResolvedValue([
        {
          luid: 'ds-1',
          name: 'Revenue Model',
          projectName: 'Finance',
          updatedAt: '2026-04-01T00:00:00Z',
          hasExtracts: true,
          fields: [
            { name: 'amount', role: 'MEASURE', dataType: 'INTEGER' },
            { name: 'Net Revenue', role: 'MEASURE', dataType: 'REAL', formula: 'SUM([g]) - SUM([r])' },
          ],
          upstreamTables: [{ name: 'ORDERS', schema: 'PUBLIC', fullName: 'DEMO.PUBLIC.ORDERS' }],
        } satisfies TableauDatasourceRecord,
      ]),
      listWorkbooks: vi.fn().mockResolvedValue([
        { luid: 'wb-1', name: 'ARR Tracker', projectName: 'Finance', description: 'ARR by segment' } satisfies TableauWorkbookRecord,
      ]),
    });

    await fetchTableauBundle({
      pullConfig: { tableauConnectionId: 'tableau-main' },
      stagedDir: dir,
      ctx: CTX,
      clientFactory: factoryFor(client),
      now: NOW,
    });

    expect((await readdir(join(dir, 'datasources'))).sort()).toEqual(['ds-1.json']);
    expect((await readdir(join(dir, 'workbooks'))).sort()).toEqual(['wb-1.json']);

    const ds = JSON.parse(await readFile(join(dir, 'datasources', 'ds-1.json'), 'utf-8'));
    expect(ds.name).toBe('Revenue Model');
    expect(ds.upstreamTables[0].fullName).toBe('DEMO.PUBLIC.ORDERS');
    const calc = ds.fields.find((f: { name: string }) => f.name === 'Net Revenue');
    expect(calc.isCalculated).toBe(true);
    expect(calc.formula).toBe('SUM([g]) - SUM([r])');
    const col = ds.fields.find((f: { name: string }) => f.name === 'amount');
    expect(col.isCalculated).toBe(false);

    const manifest = JSON.parse(await readFile(join(dir, 'tableau-manifest.json'), 'utf-8'));
    expect(manifest).toMatchObject({
      tableauConnectionId: 'tableau-main',
      fetchedAt: '2026-04-30T12:30:00.000Z',
      datasourceCount: 1,
      workbookCount: 1,
    });

    // A projection config is always written for the chunk step / skill to read.
    const projection = JSON.parse(await readFile(join(dir, 'tableau-projection-config.json'), 'utf-8'));
    expect(projection).toBeTypeOf('object');

    expect(client.cleanup).toHaveBeenCalledTimes(1);
  });

  it('calls cleanup even when listing throws', async () => {
    const client = fakeClient({
      listDatasources: vi.fn().mockRejectedValue(new Error('boom')),
    });
    await expect(
      fetchTableauBundle({
        pullConfig: { tableauConnectionId: 'tableau-main' },
        stagedDir: dir,
        ctx: CTX,
        clientFactory: factoryFor(client),
        now: NOW,
      }),
    ).rejects.toThrow(/boom/);
    expect(client.cleanup).toHaveBeenCalledTimes(1);
  });
});
