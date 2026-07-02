import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { projectSigmaDataModels } from '../../../../../src/context/ingest/adapters/sigma/project.js';
import type { DeterministicProjectionContext } from '../../../../../src/context/ingest/types.js';
import type { SemanticLayerService } from '../../../../../src/context/sl/semantic-layer.service.js';
import type { SemanticLayerSource } from '../../../../../src/context/sl/types.js';

function makeCtx(
  stagedDir: string,
  writeSource: (connectionId: string, source: SemanticLayerSource, ...rest: string[]) => Promise<{ warnings: string[] }>,
): DeterministicProjectionContext {
  const svc = {
    writeSource,
    forWorktree: () => ({ writeSource }),
  } as unknown as SemanticLayerService;

  return {
    connectionId: 'sigma-prod',
    sourceKey: 'sigma-prod',
    syncId: 'sync-1',
    jobId: 'job-1',
    runId: 'run-1',
    stagedDir,
    workdir: '',
    semanticLayerService: svc,
  };
}

function makeSpec(elements: unknown[]) {
  return {
    schemaVersion: 1,
    name: 'Test Model',
    pages: [{ id: 'p1', name: 'Main', elements }],
  };
}

function makeStagedModel(id: string, name: string, spec: unknown) {
  return JSON.stringify({
    sigmaId: id,
    name,
    path: 'Finance/Models',
    latestVersion: 1,
    updatedAt: '2026-01-15T00:00:00Z',
    isArchived: false,
    spec,
  });
}

/** Write a projection config that maps the given sigma connection IDs to 'warehouse-main'. */
async function writeProjectionConfig(stagedDir: string, sigmaConnectionIds: string[]): Promise<void> {
  const mappings = Object.fromEntries(sigmaConnectionIds.map((id) => [id, 'warehouse-main']));
  await writeFile(
    join(stagedDir, 'sigma-projection-config.json'),
    JSON.stringify({ connectionMappings: mappings }),
    'utf-8',
  );
}

describe('projectSigmaDataModels', () => {
  let stagedDir: string;

  beforeEach(async () => {
    stagedDir = await mkdtemp(join(tmpdir(), 'sigma-project-'));
    await mkdir(join(stagedDir, 'data-models'), { recursive: true });
  });

  afterEach(async () => {
    await rm(stagedDir, { recursive: true, force: true });
  });

  it('returns empty result when data-models directory is missing', async () => {
    const emptyDir = await mkdtemp(join(tmpdir(), 'sigma-project-empty-'));
    try {
      const writeSource = vi.fn().mockResolvedValue({ warnings: [] });
      const result = await projectSigmaDataModels(makeCtx(emptyDir, writeSource), makeCtx(emptyDir, writeSource).semanticLayerService as never);
      expect(result.touchedSources).toHaveLength(0);
      expect(writeSource).not.toHaveBeenCalled();
    } finally {
      await rm(emptyDir, { recursive: true, force: true });
    }
  });

  it('converts a warehouse-table element to a semantic-layer source', async () => {
    await writeProjectionConfig(stagedDir, ['sigma-conn-uuid']);
    const spec = makeSpec([
      {
        id: 'elem1',
        kind: 'table',
        name: 'Opportunities',
        source: { kind: 'warehouse-table', connectionId: 'sigma-conn-uuid', path: ['FIVETRAN', 'SALESFORCE', 'OPPORTUNITIES'] },
        columns: [
          { id: 'c1', formula: '[OPPORTUNITIES/Amount]', name: 'Deal Amount' },
          { id: 'c2', formula: 'Sum([OPPORTUNITIES/Amount])', name: 'Total Amount' },
        ],
      },
    ]);
    await writeFile(join(stagedDir, 'data-models', 'dm-1.json'), makeStagedModel('dm-1', 'Revenue Model', spec));

    const written: Array<{ connectionId: string; source: SemanticLayerSource }> = [];
    const writeSource = vi.fn().mockImplementation((connectionId: string, source: SemanticLayerSource) => {
      written.push({ connectionId, source });
      return Promise.resolve({ warnings: [] });
    });

    const result = await projectSigmaDataModels(makeCtx(stagedDir, writeSource), makeCtx(stagedDir, writeSource).semanticLayerService as never);

    expect(writeSource).toHaveBeenCalledOnce();
    expect(written[0]!.connectionId).toBe('warehouse-main');
    const source = written[0]!.source;
    expect(source.table).toBe('FIVETRAN.SALESFORCE.OPPORTUNITIES');
    expect(source.columns.some((c) => c.name === 'deal_amount')).toBe(true);
    expect(source.columns.some((c) => c.name === 'total_amount')).toBe(false);
    expect(source.measures).toEqual([]);
    expect(result.touchedSources).toHaveLength(1);
    expect(result.errors).toHaveLength(0);
  });

  it('skips elements whose source kind is not warehouse-table', async () => {
    const spec = makeSpec([
      {
        id: 'elem1',
        kind: 'table',
        name: 'Derived',
        source: { kind: 'data-model', dataModelId: 'dm-other', elementId: 'e1' },
        columns: [{ id: 'c1', formula: '[Derived/Revenue]' }],
      },
    ]);
    await writeFile(join(stagedDir, 'data-models', 'dm-1.json'), makeStagedModel('dm-1', 'Derived Model', spec));

    const writeSource = vi.fn().mockResolvedValue({ warnings: [] });
    const result = await projectSigmaDataModels(makeCtx(stagedDir, writeSource), makeCtx(stagedDir, writeSource).semanticLayerService as never);

    expect(writeSource).not.toHaveBeenCalled();
    expect(result.touchedSources).toHaveLength(0);
  });

  it('skips hidden elements', async () => {
    const spec = makeSpec([
      {
        id: 'elem1',
        kind: 'table',
        name: 'Hidden',
        hidden: true,
        source: { kind: 'warehouse-table', connectionId: 'c', path: ['DB', 'SCHEMA', 'TABLE'] },
        columns: [{ id: 'c1', formula: '[TABLE/Col]' }],
      },
    ]);
    await writeFile(join(stagedDir, 'data-models', 'dm-1.json'), makeStagedModel('dm-1', 'Hidden Model', spec));

    const writeSource = vi.fn().mockResolvedValue({ warnings: [] });
    const result = await projectSigmaDataModels(makeCtx(stagedDir, writeSource), makeCtx(stagedDir, writeSource).semanticLayerService as never);
    expect(writeSource).not.toHaveBeenCalled();
    expect(result.touchedSources).toHaveLength(0);
  });

  it('skips hidden columns', async () => {
    await writeProjectionConfig(stagedDir, ['c']);
    const spec = makeSpec([
      {
        id: 'elem1',
        kind: 'table',
        name: 'Revenue',
        source: { kind: 'warehouse-table', connectionId: 'c', path: ['DB', 'S', 'T'] },
        columns: [
          { id: 'c1', formula: '[T/Visible]', name: 'Visible' },
          { id: 'c2', formula: '[T/Hidden]', name: 'Hidden', hidden: true },
        ],
      },
    ]);
    await writeFile(join(stagedDir, 'data-models', 'dm-1.json'), makeStagedModel('dm-1', 'Revenue', spec));

    const written: SemanticLayerSource[] = [];
    const writeSource = vi.fn().mockImplementation((_: string, source: SemanticLayerSource) => {
      written.push(source);
      return Promise.resolve({ warnings: [] });
    });
    await projectSigmaDataModels(makeCtx(stagedDir, writeSource), makeCtx(stagedDir, writeSource).semanticLayerService as never);
    const source = written[0]!;
    expect(source.columns.some((c) => c.name === 'visible')).toBe(true);
    expect(source.columns.some((c) => c.name === 'hidden')).toBe(false);
  });

  it('silently skips aggregation formula columns and never emits measures', async () => {
    await writeProjectionConfig(stagedDir, ['c']);
    const spec = makeSpec([
      {
        id: 'e1',
        kind: 'table',
        name: 'Sales',
        source: { kind: 'warehouse-table', connectionId: 'c', path: ['DB', 'S', 'ORDERS'] },
        columns: [
          { id: 'c1', formula: 'Sum([ORDERS/Revenue])', name: 'Total Revenue' },
          { id: 'c2', formula: 'CountDistinct([ORDERS/CustomerId])', name: 'Unique Customers' },
          { id: 'c3', formula: '[ORDERS/OrderDate]', name: 'Order Date' },
        ],
      },
    ]);
    await writeFile(join(stagedDir, 'data-models', 'dm-1.json'), makeStagedModel('dm-1', 'Sales', spec));

    const written: SemanticLayerSource[] = [];
    const writeSource = vi.fn().mockImplementation((_: string, source: SemanticLayerSource) => {
      written.push(source);
      return Promise.resolve({ warnings: [] });
    });
    await projectSigmaDataModels(makeCtx(stagedDir, writeSource), makeCtx(stagedDir, writeSource).semanticLayerService as never);

    const source = written[0]!;
    expect(source.measures).toEqual([]);
    expect(source.columns.map((c) => c.name)).toContain('order_date');
    expect(source.columns.map((c) => c.name)).not.toContain('total_revenue');
    expect(source.columns.map((c) => c.name)).not.toContain('unique_customers');
  });

  it('skips models with null spec', async () => {
    await writeFile(join(stagedDir, 'data-models', 'dm-1.json'), makeStagedModel('dm-1', 'No Spec Model', null));

    const writeSource = vi.fn().mockResolvedValue({ warnings: [] });
    const result = await projectSigmaDataModels(makeCtx(stagedDir, writeSource), makeCtx(stagedDir, writeSource).semanticLayerService as never);
    expect(writeSource).not.toHaveBeenCalled();
    expect(result.touchedSources).toHaveLength(0);
  });

  it('routes to the mapped warehouse connection when connectionMappings is set', async () => {
    // Write a projection config that maps the Sigma internal connection UUID to a ktx warehouse.
    await writeFile(
      join(stagedDir, 'sigma-projection-config.json'),
      JSON.stringify({ connectionMappings: { 'sigma-internal-uuid': 'snowflake-prod' } }),
      'utf-8',
    );

    const spec = makeSpec([
      {
        id: 'e1',
        kind: 'table',
        name: 'Accounts',
        source: { kind: 'warehouse-table', connectionId: 'sigma-internal-uuid', path: ['PROD', 'SF', 'ACCOUNTS'] },
        columns: [{ id: 'c1', formula: '[ACCOUNTS/Name]', name: 'Account Name' }],
      },
    ]);
    await writeFile(join(stagedDir, 'data-models', 'dm-1.json'), makeStagedModel('dm-1', 'Accounts', spec));

    const written: Array<{ connectionId: string }> = [];
    const writeSource = vi.fn().mockImplementation((connectionId: string) => {
      written.push({ connectionId });
      return Promise.resolve({ warnings: [] });
    });

    await projectSigmaDataModels(makeCtx(stagedDir, writeSource), makeCtx(stagedDir, writeSource).semanticLayerService as never);

    expect(written[0]!.connectionId).toBe('snowflake-prod');
  });

  it('skips SL source and emits a warning when no connectionMappings entry exists for the element', async () => {
    await writeFile(
      join(stagedDir, 'sigma-projection-config.json'),
      JSON.stringify({ connectionMappings: { 'other-uuid': 'snowflake-prod' } }),
      'utf-8',
    );

    const spec = makeSpec([
      {
        id: 'e1',
        kind: 'table',
        name: 'Orders',
        source: { kind: 'warehouse-table', connectionId: 'unmapped-uuid', path: ['DB', 'S', 'ORDERS'] },
        columns: [{ id: 'c1', formula: '[ORDERS/Id]', name: 'Order Id' }],
      },
    ]);
    await writeFile(join(stagedDir, 'data-models', 'dm-1.json'), makeStagedModel('dm-1', 'Orders', spec));

    const writeSource = vi.fn().mockResolvedValue({ warnings: [] });
    const result = await projectSigmaDataModels(
      makeCtx(stagedDir, writeSource),
      makeCtx(stagedDir, writeSource).semanticLayerService as never,
    );

    expect(writeSource).not.toHaveBeenCalled();
    expect(result.touchedSources).toHaveLength(0);
    expect(result.warnings.some((w) => w.includes('no connectionMappings entry'))).toBe(true);
  });

  it('surfaces writeSource warnings in result', async () => {
    await writeProjectionConfig(stagedDir, ['c']);
    const spec = makeSpec([
      {
        id: 'e1',
        kind: 'table',
        name: 'Revenue',
        source: { kind: 'warehouse-table', connectionId: 'c', path: ['DB', 'S', 'T'] },
        columns: [{ id: 'c1', formula: '[T/Amount]', name: 'Amount' }],
      },
    ]);
    await writeFile(join(stagedDir, 'data-models', 'dm-1.json'), makeStagedModel('dm-1', 'Revenue', spec));

    const writeSource = vi.fn().mockResolvedValue({ warnings: ['schema: some warning'] });
    const result = await projectSigmaDataModels(makeCtx(stagedDir, writeSource), makeCtx(stagedDir, writeSource).semanticLayerService as never);
    expect(result.warnings).toContain('schema: some warning');
  });
});
