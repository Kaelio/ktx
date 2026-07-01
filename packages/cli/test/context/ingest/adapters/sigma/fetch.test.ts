import { mkdtemp, readFile, rm, writeFile, mkdir } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { SigmaClientFactory, SigmaRuntimeClient } from '../../../../../src/context/ingest/adapters/sigma/client-port.js';
import { fetchSigmaBundle } from '../../../../../src/context/ingest/adapters/sigma/fetch.js';
import type { SigmaPullConfig } from '../../../../../src/context/ingest/adapters/sigma/types.js';

const TEST_PULL_CONFIG = { sigmaConnectionId: 'sigma-prod' };

function makeSummary(id: string, name: string, path: string, isArchived = false) {
  return {
    dataModelId: id,
    dataModelUrlId: `${name.replace(/\s+/g, '-')}-${id}`,
    name,
    path,
    latestVersion: 1,
    ownerId: 'user-1',
    createdAt: '2026-01-01T00:00:00Z',
    updatedAt: '2026-01-15T00:00:00Z',
    isArchived,
  };
}

function makeFactory(client: Partial<SigmaRuntimeClient>): SigmaClientFactory {
  const fullClient: SigmaRuntimeClient = {
    testConnection: vi.fn().mockResolvedValue({ success: true }),
    listDataModels: vi.fn().mockResolvedValue([]),
    listWorkbooks: vi.fn().mockResolvedValue([]),
    getDataModelSpec: vi.fn().mockResolvedValue(null),
    cleanup: vi.fn().mockResolvedValue(undefined),
    ...client,
  };
  return {
    createClient: vi.fn().mockResolvedValue(fullClient),
  };
}

describe('fetchSigmaBundle', () => {
  let stagedDir: string;

  beforeEach(async () => {
    stagedDir = await mkdtemp(join(tmpdir(), 'sigma-fetch-'));
  });

  afterEach(async () => {
    await rm(stagedDir, { recursive: true, force: true });
  });

  it('creates sigma-manifest.json after a successful fetch', async () => {
    const factory = makeFactory({
      listDataModels: vi.fn().mockResolvedValue([
        makeSummary('dm-1', 'Revenue Model', 'Finance/Revenue'),
      ]),
      getDataModelSpec: vi.fn().mockResolvedValue({ schemaVersion: 1 }),
    });
    await fetchSigmaBundle({
      pullConfig: TEST_PULL_CONFIG,
      stagedDir,
      ctx: {} as never,
      clientFactory: factory,
    });
    const manifest = JSON.parse(await readFile(join(stagedDir, 'sigma-manifest.json'), 'utf-8'));
    expect(manifest.sigmaConnectionId).toBe('sigma-prod');
    expect(manifest.dataModelCount).toBe(1);
    expect(manifest.fetchedAt).toBeDefined();
  });

  it('writes one data-model file per active model', async () => {
    const factory = makeFactory({
      listDataModels: vi.fn().mockResolvedValue([
        makeSummary('dm-1', 'Revenue Model', 'Finance/Revenue'),
        makeSummary('dm-2', 'ARR Model', 'Finance/ARR'),
      ]),
      getDataModelSpec: vi.fn().mockResolvedValue({ schemaVersion: 1 }),
    });
    await fetchSigmaBundle({
      pullConfig: TEST_PULL_CONFIG,
      stagedDir,
      ctx: {} as never,
      clientFactory: factory,
    });
    const dm1 = JSON.parse(await readFile(join(stagedDir, 'data-models', 'dm-1.json'), 'utf-8'));
    const dm2 = JSON.parse(await readFile(join(stagedDir, 'data-models', 'dm-2.json'), 'utf-8'));
    expect(dm1.name).toBe('Revenue Model');
    expect(dm2.name).toBe('ARR Model');
  });

  it('skips archived models and does not write their files', async () => {
    const factory = makeFactory({
      listDataModels: vi.fn().mockResolvedValue([
        makeSummary('dm-1', 'Active Model', 'Finance/Active', false),
        makeSummary('dm-archived', 'Archived Model', 'Finance/Old', true),
      ]),
      getDataModelSpec: vi.fn().mockResolvedValue({ schemaVersion: 1 }),
    });
    await fetchSigmaBundle({
      pullConfig: TEST_PULL_CONFIG,
      stagedDir,
      ctx: {} as never,
      clientFactory: factory,
    });
    const manifest = JSON.parse(await readFile(join(stagedDir, 'sigma-manifest.json'), 'utf-8'));
    expect(manifest.dataModelCount).toBe(1);
    await expect(readFile(join(stagedDir, 'data-models', 'dm-archived.json'), 'utf-8')).rejects.toThrow();
  });

  it('logs a specific message for unsupported data source subtype (service_error)', async () => {
    const warnMessages: string[] = [];
    const factory = makeFactory({
      listDataModels: vi.fn().mockResolvedValue([
        makeSummary('dm-1', 'CSV Upload Model', 'Finance/CSV'),
      ]),
      getDataModelSpec: vi.fn().mockRejectedValue(
        new Error('Sigma API error (500): {"code":"service_error","message":"dataSource subtype not supported in data model read"}'),
      ),
    });
    await fetchSigmaBundle({
      pullConfig: TEST_PULL_CONFIG,
      stagedDir,
      ctx: {} as never,
      clientFactory: factory,
      logger: { log: () => undefined, warn: (m) => warnMessages.push(m) },
    });
    expect(warnMessages[0]).toContain('data source type not supported');
    expect(warnMessages[0]).not.toContain('Sigma API error (500)');
  });

  it('writes null spec when getDataModelSpec throws, and does not abort the whole fetch', async () => {
    const factory = makeFactory({
      listDataModels: vi.fn().mockResolvedValue([
        makeSummary('dm-1', 'Good Model', 'Finance/Good'),
        makeSummary('dm-2', 'Broken Model', 'Finance/Broken'),
      ]),
      getDataModelSpec: vi
        .fn()
        .mockResolvedValueOnce({ schemaVersion: 1 })
        .mockRejectedValueOnce(new Error('Spec fetch failed')),
    });
    await fetchSigmaBundle({
      pullConfig: TEST_PULL_CONFIG,
      stagedDir,
      ctx: {} as never,
      clientFactory: factory,
    });
    const dm2 = JSON.parse(await readFile(join(stagedDir, 'data-models', 'dm-2.json'), 'utf-8'));
    expect(dm2.spec).toBeNull();
    const manifest = JSON.parse(await readFile(join(stagedDir, 'sigma-manifest.json'), 'utf-8'));
    expect(manifest.dataModelCount).toBe(2);
  });

  it('calls cleanup on the client even when an error is thrown', async () => {
    const cleanupMock = vi.fn().mockResolvedValue(undefined);
    const factory = makeFactory({
      listDataModels: vi.fn().mockRejectedValue(new Error('Network failure')),
      cleanup: cleanupMock,
    });
    await expect(
      fetchSigmaBundle({
        pullConfig: TEST_PULL_CONFIG,
        stagedDir,
        ctx: {} as never,
        clientFactory: factory,
      }),
    ).rejects.toThrow('Network failure');
    expect(cleanupMock).toHaveBeenCalledOnce();
  });

  it('passes the resolved config to clientFactory.createClient', async () => {
    const createClientMock = vi.fn().mockResolvedValue({
      testConnection: vi.fn(),
      listDataModels: vi.fn().mockResolvedValue([]),
      listWorkbooks: vi.fn().mockResolvedValue([]),
      getDataModelSpec: vi.fn(),
      cleanup: vi.fn().mockResolvedValue(undefined),
    } satisfies SigmaRuntimeClient);
    const factory: SigmaClientFactory = { createClient: createClientMock };
    await fetchSigmaBundle({
      pullConfig: TEST_PULL_CONFIG,
      stagedDir,
      ctx: {} as never,
      clientFactory: factory,
    });
    const calledConfig = createClientMock.mock.calls[0]![0] as SigmaPullConfig;
    expect(calledConfig.sigmaConnectionId).toBe('sigma-prod');
  });

  it('writes sigma-projection-config.json with connectionMappings from pullConfig', async () => {
    const factory = makeFactory({});
    await fetchSigmaBundle({
      pullConfig: { sigmaConnectionId: 'sigma-prod', connectionMappings: { 'uuid-1': 'snowflake-prod' } },
      stagedDir,
      ctx: {} as never,
      clientFactory: factory,
    });
    const config = JSON.parse(await readFile(join(stagedDir, 'sigma-projection-config.json'), 'utf-8'));
    expect(config.connectionMappings['uuid-1']).toBe('snowflake-prod');
  });

  it('writes sigma-projection-config.json with empty mappings when none are provided', async () => {
    const factory = makeFactory({});
    await fetchSigmaBundle({ pullConfig: TEST_PULL_CONFIG, stagedDir, ctx: {} as never, clientFactory: factory });
    const config = JSON.parse(await readFile(join(stagedDir, 'sigma-projection-config.json'), 'utf-8'));
    expect(config.connectionMappings).toEqual({});
  });

  it('writes workbookFilter defaults to projection config when not specified', async () => {
    const factory = makeFactory({});
    await fetchSigmaBundle({ pullConfig: TEST_PULL_CONFIG, stagedDir, ctx: {} as never, clientFactory: factory });
    const config = JSON.parse(await readFile(join(stagedDir, 'sigma-projection-config.json'), 'utf-8'));
    expect(config.workbookFilter.includeArchived).toBe(false);
    expect(config.workbookFilter.includeExplorations).toBe(false);
    expect(config.workbookFilter.updatedSince).toBeUndefined();
  });

  it('writes explicit workbookFilter settings to projection config', async () => {
    const factory = makeFactory({});
    await fetchSigmaBundle({
      pullConfig: {
        sigmaConnectionId: 'sigma-prod',
        workbookFilter: { includeArchived: true, includeExplorations: false, updatedSince: '2026-01-01T00:00:00Z' },
      },
      stagedDir,
      ctx: {} as never,
      clientFactory: factory,
    });
    const config = JSON.parse(await readFile(join(stagedDir, 'sigma-projection-config.json'), 'utf-8'));
    expect(config.workbookFilter.includeArchived).toBe(true);
    expect(config.workbookFilter.updatedSince).toBe('2026-01-01T00:00:00Z');
  });

  it('throws on invalid pullConfig', async () => {
    const factory = makeFactory({});
    await expect(
      fetchSigmaBundle({
        pullConfig: { sigmaConnectionId: 'invalid id with spaces' },
        stagedDir,
        ctx: {} as never,
        clientFactory: factory,
      }),
    ).rejects.toThrow();
  });

  it('handles zero active models gracefully', async () => {
    const factory = makeFactory({
      listDataModels: vi.fn().mockResolvedValue([]),
    });
    await fetchSigmaBundle({
      pullConfig: TEST_PULL_CONFIG,
      stagedDir,
      ctx: {} as never,
      clientFactory: factory,
    });
    const manifest = JSON.parse(await readFile(join(stagedDir, 'sigma-manifest.json'), 'utf-8'));
    expect(manifest.dataModelCount).toBe(0);
  });

  it('skips spec fetch for a model whose updatedAt matches the existing staged file', async () => {
    const summary = makeSummary('dm-1', 'Revenue Model', 'Finance/Revenue');
    // Pre-populate a staged file with the same updatedAt.
    await mkdir(join(stagedDir, 'data-models'), { recursive: true });
    const existingStaged = {
      sigmaId: 'dm-1',
      name: 'Revenue Model',
      path: 'Finance/Revenue',
      latestVersion: 1,
      updatedAt: summary.updatedAt,
      isArchived: false,
      spec: { schemaVersion: 1, name: 'old' },
    };
    await writeFile(
      join(stagedDir, 'data-models', 'dm-1.json'),
      JSON.stringify(existingStaged),
      'utf-8',
    );
    const getSpecMock = vi.fn().mockResolvedValue({ schemaVersion: 1 });
    const factory = makeFactory({
      listDataModels: vi.fn().mockResolvedValue([summary]),
      getDataModelSpec: getSpecMock,
    });
    await fetchSigmaBundle({
      pullConfig: TEST_PULL_CONFIG,
      stagedDir,
      ctx: {} as never,
      clientFactory: factory,
    });
    // Spec fetch must be skipped for the unchanged model.
    expect(getSpecMock).not.toHaveBeenCalled();
  });

  it('retries spec fetch for a model whose updatedAt matches but staged spec is null (transient failure)', async () => {
    const summary = makeSummary('dm-1', 'Revenue Model', 'Finance/Revenue');
    await mkdir(join(stagedDir, 'data-models'), { recursive: true });
    const existingStaged = {
      sigmaId: 'dm-1',
      name: 'Revenue Model',
      path: 'Finance/Revenue',
      latestVersion: 1,
      updatedAt: summary.updatedAt,
      isArchived: false,
      spec: null,
    };
    await writeFile(
      join(stagedDir, 'data-models', 'dm-1.json'),
      JSON.stringify(existingStaged),
      'utf-8',
    );
    const freshSpec = { schemaVersion: 1, name: 'Revenue Model' };
    const getSpecMock = vi.fn().mockResolvedValue(freshSpec);
    const factory = makeFactory({
      listDataModels: vi.fn().mockResolvedValue([summary]),
      getDataModelSpec: getSpecMock,
    });
    await fetchSigmaBundle({
      pullConfig: TEST_PULL_CONFIG,
      stagedDir,
      ctx: {} as never,
      clientFactory: factory,
    });
    expect(getSpecMock).toHaveBeenCalledWith('dm-1');
    const written = JSON.parse(await readFile(join(stagedDir, 'data-models', 'dm-1.json'), 'utf-8'));
    expect(written.spec).toEqual(freshSpec);
  });

  it('writes workbook count to manifest', async () => {
    const factory = makeFactory({
      listWorkbooks: vi.fn().mockResolvedValue([
        { workbookId: 'wb-1', workbookUrlId: 'wb-url-1', name: 'Sales Dashboard', path: 'Finance/Dashboards', latestVersion: 1, ownerId: 'u1', createdAt: '2026-01-01T00:00:00Z', updatedAt: '2026-01-15T00:00:00Z', isArchived: false },
        { workbookId: 'wb-2', workbookUrlId: 'wb-url-2', name: 'ARR Tracker', path: 'Finance/Dashboards', latestVersion: 2, ownerId: 'u1', createdAt: '2026-01-02T00:00:00Z', updatedAt: '2026-01-16T00:00:00Z', isArchived: false },
      ]),
    });
    await fetchSigmaBundle({ pullConfig: TEST_PULL_CONFIG, stagedDir, ctx: {} as never, clientFactory: factory });
    const manifest = JSON.parse(await readFile(join(stagedDir, 'sigma-manifest.json'), 'utf-8'));
    expect(manifest.workbookCount).toBe(2);
  });

  it('writes one staged file per active workbook', async () => {
    const factory = makeFactory({
      listWorkbooks: vi.fn().mockResolvedValue([
        { workbookId: 'wb-1', workbookUrlId: 'wb-url-1', name: 'Sales Dashboard', path: 'Finance/Dashboards', latestVersion: 1, ownerId: 'u1', createdAt: '2026-01-01T00:00:00Z', updatedAt: '2026-01-15T00:00:00Z', isArchived: false, description: 'Finance overview' },
      ]),
    });
    await fetchSigmaBundle({ pullConfig: TEST_PULL_CONFIG, stagedDir, ctx: {} as never, clientFactory: factory });
    const wb = JSON.parse(await readFile(join(stagedDir, 'workbooks', 'wb-1.json'), 'utf-8'));
    expect(wb.name).toBe('Sales Dashboard');
    expect(wb.description).toBe('Finance overview');
  });

  it('skips workbook re-staging when updatedAt is unchanged', async () => {
    await mkdir(join(stagedDir, 'workbooks'), { recursive: true });
    const existing = { sigmaId: 'wb-1', name: 'Sales Dashboard', path: 'Finance', latestVersion: 1, updatedAt: '2026-01-15T00:00:00Z', isArchived: false };
    await writeFile(join(stagedDir, 'workbooks', 'wb-1.json'), JSON.stringify(existing), 'utf-8');
    const listWorkbooksMock = vi.fn().mockResolvedValue([
      { workbookId: 'wb-1', workbookUrlId: 'wb-url-1', name: 'Sales Dashboard', path: 'Finance', latestVersion: 1, ownerId: 'u1', createdAt: '2026-01-01T00:00:00Z', updatedAt: '2026-01-15T00:00:00Z', isArchived: false },
    ]);
    const factory = makeFactory({ listWorkbooks: listWorkbooksMock });
    await fetchSigmaBundle({ pullConfig: TEST_PULL_CONFIG, stagedDir, ctx: {} as never, clientFactory: factory });
    // File should still contain the pre-existing content (not overwritten).
    const wb = JSON.parse(await readFile(join(stagedDir, 'workbooks', 'wb-1.json'), 'utf-8'));
    expect(wb.sigmaId).toBe('wb-1');
  });

  it('removes the staged file when a model is no longer in the active list', async () => {
    // Pre-populate a staged file for dm-stale.
    await mkdir(join(stagedDir, 'data-models'), { recursive: true });
    const staleStaged = {
      sigmaId: 'dm-stale',
      name: 'Stale Model',
      path: 'Old/Stale',
      latestVersion: 1,
      updatedAt: '2026-01-01T00:00:00Z',
      isArchived: false,
      spec: null,
    };
    await writeFile(
      join(stagedDir, 'data-models', 'dm-stale.json'),
      JSON.stringify(staleStaged),
      'utf-8',
    );
    // API now returns only dm-1 (dm-stale was archived or deleted).
    const factory = makeFactory({
      listDataModels: vi.fn().mockResolvedValue([makeSummary('dm-1', 'Active Model', 'Finance/Active')]),
      getDataModelSpec: vi.fn().mockResolvedValue({ schemaVersion: 1 }),
    });
    await fetchSigmaBundle({
      pullConfig: TEST_PULL_CONFIG,
      stagedDir,
      ctx: {} as never,
      clientFactory: factory,
    });
    await expect(
      readFile(join(stagedDir, 'data-models', 'dm-stale.json'), 'utf-8'),
    ).rejects.toThrow();
    // The active model's file must still exist.
    await expect(
      readFile(join(stagedDir, 'data-models', 'dm-1.json'), 'utf-8'),
    ).resolves.toBeDefined();
  });

  it('filters spec fetches by dataModelFilter.updatedSince but preserves existing staged files for filtered-out models', async () => {
    // Pre-stage the old model from a previous full fetch.
    await mkdir(join(stagedDir, 'data-models'), { recursive: true });
    const oldStaged = {
      sigmaId: 'dm-old', name: 'Old Model', path: 'Finance/Old',
      latestVersion: 1, updatedAt: '2026-06-20T00:00:00Z', isArchived: false, spec: { schemaVersion: 0 },
    };
    await writeFile(join(stagedDir, 'data-models', 'dm-old.json'), JSON.stringify(oldStaged), 'utf-8');
    const getSpecMock = vi.fn().mockResolvedValue({ schemaVersion: 1 });
    const factory = makeFactory({
      listDataModels: vi.fn().mockResolvedValue([
        { ...makeSummary('dm-old', 'Old Model', 'Finance/Old'), updatedAt: '2026-06-20T00:00:00Z' },
        { ...makeSummary('dm-new', 'New Model', 'Finance/New'), updatedAt: '2026-06-26T00:00:00Z' },
      ]),
      getDataModelSpec: getSpecMock,
    });
    await fetchSigmaBundle({
      pullConfig: { sigmaConnectionId: 'sigma-prod', dataModelFilter: { updatedSince: '2026-06-25T00:00:00Z' } },
      stagedDir,
      ctx: {} as never,
      clientFactory: factory,
    });
    // Only the new model's spec is fetched (old one is outside the filter window).
    expect(getSpecMock).toHaveBeenCalledTimes(1);
    // Manifest reflects only the filtered count.
    const manifest = JSON.parse(await readFile(join(stagedDir, 'sigma-manifest.json'), 'utf-8'));
    expect(manifest.dataModelCount).toBe(1);
    // New model is staged.
    await expect(readFile(join(stagedDir, 'data-models', 'dm-new.json'), 'utf-8')).resolves.toBeDefined();
    // Old model's staged file is PRESERVED — it is still active, just outside the filter window.
    await expect(readFile(join(stagedDir, 'data-models', 'dm-old.json'), 'utf-8')).resolves.toBeDefined();
  });

  it('includes all active models when dataModelFilter is not set', async () => {
    const factory = makeFactory({
      listDataModels: vi.fn().mockResolvedValue([
        { ...makeSummary('dm-old', 'Old Model', 'Finance/Old'), updatedAt: '2026-01-01T00:00:00Z' },
        { ...makeSummary('dm-new', 'New Model', 'Finance/New'), updatedAt: '2026-06-26T00:00:00Z' },
      ]),
      getDataModelSpec: vi.fn().mockResolvedValue({ schemaVersion: 1 }),
    });
    await fetchSigmaBundle({ pullConfig: TEST_PULL_CONFIG, stagedDir, ctx: {} as never, clientFactory: factory });
    const manifest = JSON.parse(await readFile(join(stagedDir, 'sigma-manifest.json'), 'utf-8'));
    expect(manifest.dataModelCount).toBe(2);
  });

  it('removes the staged file when a workbook is no longer returned by the API', async () => {
    await mkdir(join(stagedDir, 'workbooks'), { recursive: true });
    const stale = {
      sigmaId: 'wb-stale',
      name: 'Old Dashboard',
      path: 'Finance/Old',
      latestVersion: 1,
      updatedAt: '2026-01-01T00:00:00Z',
      isArchived: false,
    };
    await writeFile(join(stagedDir, 'workbooks', 'wb-stale.json'), JSON.stringify(stale), 'utf-8');
    const factory = makeFactory({
      listWorkbooks: vi.fn().mockResolvedValue([
        { workbookId: 'wb-active', workbookUrlId: 'wb-url-active', name: 'Active Dashboard', path: 'Finance/Active', latestVersion: 1, ownerId: 'u1', createdAt: '2026-01-01T00:00:00Z', updatedAt: '2026-01-16T00:00:00Z', isArchived: false },
      ]),
    });
    await fetchSigmaBundle({ pullConfig: TEST_PULL_CONFIG, stagedDir, ctx: {} as never, clientFactory: factory });
    await expect(readFile(join(stagedDir, 'workbooks', 'wb-stale.json'), 'utf-8')).rejects.toThrow();
    await expect(readFile(join(stagedDir, 'workbooks', 'wb-active.json'), 'utf-8')).resolves.toBeDefined();
  });

  it('workbookFilter.updatedSince filters fetch but preserves existing staged files for older workbooks', async () => {
    // Pre-stage an old workbook from a previous full fetch.
    await mkdir(join(stagedDir, 'workbooks'), { recursive: true });
    const oldStaged = {
      sigmaId: 'wb-old', name: 'Old Dashboard', path: 'Finance/Old',
      latestVersion: 1, updatedAt: '2026-06-20T00:00:00Z', isArchived: false, workbookUrlId: 'wb-url-old',
    };
    await writeFile(join(stagedDir, 'workbooks', 'wb-old.json'), JSON.stringify(oldStaged), 'utf-8');
    const listWorkbooksMock = vi.fn().mockResolvedValue([
      { workbookId: 'wb-old', workbookUrlId: 'wb-url-old', name: 'Old Dashboard', path: 'Finance/Old', latestVersion: 1, ownerId: 'u1', createdAt: '2026-01-01T00:00:00Z', updatedAt: '2026-06-20T00:00:00Z', isArchived: false },
      { workbookId: 'wb-new', workbookUrlId: 'wb-url-new', name: 'New Dashboard', path: 'Finance/New', latestVersion: 1, ownerId: 'u1', createdAt: '2026-01-01T00:00:00Z', updatedAt: '2026-06-26T00:00:00Z', isArchived: false },
    ]);
    const factory = makeFactory({ listWorkbooks: listWorkbooksMock });
    await fetchSigmaBundle({
      pullConfig: { sigmaConnectionId: 'sigma-prod', workbookFilter: { updatedSince: '2026-06-25T00:00:00Z' } },
      stagedDir,
      ctx: {} as never,
      clientFactory: factory,
    });
    // Only the new workbook is staged on this run.
    await expect(readFile(join(stagedDir, 'workbooks', 'wb-new.json'), 'utf-8')).resolves.toBeDefined();
    // Old workbook's staged file is PRESERVED — it is still active, just outside the filter window.
    await expect(readFile(join(stagedDir, 'workbooks', 'wb-old.json'), 'utf-8')).resolves.toBeDefined();
    // listWorkbooks is called without updatedSince to get the full universe for eviction.
    expect(listWorkbooksMock).toHaveBeenCalledWith(expect.not.objectContaining({ updatedSince: expect.anything() }));
  });
});
