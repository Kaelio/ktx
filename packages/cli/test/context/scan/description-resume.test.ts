import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import YAML from 'yaml';
import type { KtxLlmRuntimePort } from '../../../src/context/llm/runtime-port.js';
import { buildDefaultKtxProjectConfig, type KtxScanRelationshipConfig } from '../../../src/context/project/config.js';
import { initKtxProject, type KtxLocalProject } from '../../../src/context/project/project.js';
import {
  createKtxScanDescriptionResumeStore,
  writeLocalScanManifestShards,
} from '../../../src/context/scan/local-enrichment-artifacts.js';
import { runLocalScanEnrichment, type KtxLocalScanEnrichmentResult } from '../../../src/context/scan/local-enrichment.js';
import { SqliteLocalScanEnrichmentStateStore } from '../../../src/context/scan/sqlite-local-enrichment-state-store.js';
import { createKtxConnectorCapabilities, type KtxScanConnector, type KtxSchemaSnapshot } from '../../../src/context/scan/types.js';

const PROGRESS_PATH = 'raw-sources/warehouse/live-database/enrichment-progress/descriptions.json';
const SHARD_PATH = 'semantic-layer/warehouse/_schema/public.yaml';

function column(name: string) {
  return {
    name,
    nativeType: 'integer',
    normalizedType: 'integer' as const,
    dimensionType: 'number' as const,
    nullable: false,
    primaryKey: name === 'id',
    comment: null,
  };
}

function table(name: string) {
  return {
    catalog: null,
    db: 'public',
    name,
    kind: 'table' as const,
    comment: null,
    estimatedRows: 1,
    foreignKeys: [],
    columns: [column('id'), column('value')],
  };
}

const snapshot: KtxSchemaSnapshot = {
  connectionId: 'warehouse',
  driver: 'postgres',
  extractedAt: '2026-04-29T12:00:00.000Z',
  scope: { schemas: ['public'] },
  metadata: {},
  tables: [table('customers'), table('orders'), table('products')],
};

function connector(): KtxScanConnector {
  return {
    id: 'test:warehouse',
    driver: 'postgres',
    capabilities: createKtxConnectorCapabilities({ tableSampling: true, columnSampling: true }),
    introspect: vi.fn(async () => snapshot),
    listSchemas: vi.fn(async () => []),
    listTables: vi.fn(async () => []),
    sampleTable: vi.fn(async () => ({ headers: ['id', 'value'], rows: [[1, 2]], totalRows: 1 })),
    sampleColumn: vi.fn(async () => ({ values: ['1', '2'], nullCount: 0, distinctCount: 2 })),
  };
}

function countingRuntime() {
  let calls = 0;
  const runtime: KtxLlmRuntimePort = {
    generateText: vi.fn(async () => 'AI column description'),
    generateObject: vi.fn(async () => {
      calls += 1;
      return { tableDescription: 'AI table description', columns: [] };
    }) as KtxLlmRuntimePort['generateObject'],
    runAgentLoop: vi.fn(),
    subprocessForkSpec: () => null,
  };
  return { runtime, calls: () => calls };
}

function relationshipsDisabled(): KtxScanRelationshipConfig {
  return { ...buildDefaultKtxProjectConfig().scan.relationships, enabled: false };
}

describe('descriptions stage incremental persistence + resume', () => {
  let tempDir: string;
  let project: KtxLocalProject;

  async function runEnrichment(runId: string): Promise<{ result: KtxLocalScanEnrichmentResult; calls: number }> {
    const llm = countingRuntime();
    const result = await runLocalScanEnrichment({
      connectionId: 'warehouse',
      mode: 'enriched',
      connector: connector(),
      snapshot,
      context: { runId },
      providers: { llmRuntime: llm.runtime, embedding: null },
      descriptionResumeStore: createKtxScanDescriptionResumeStore({
        project,
        connectionId: 'warehouse',
        syncId: 'sync-1',
        driver: 'postgres',
      }),
      syncId: 'sync-1',
      relationshipSettings: relationshipsDisabled(),
    });
    return { result, calls: llm.calls() };
  }

  async function readProgress(): Promise<{ inputHash: string; descriptions: Array<{ table: { name: string } }> }> {
    return JSON.parse((await project.fileStore.readFile(PROGRESS_PATH)).content);
  }

  async function writeProgress(record: unknown): Promise<void> {
    await project.fileStore.writeFile(PROGRESS_PATH, `${JSON.stringify(record, null, 2)}\n`, 'ktx', 'ktx@example.com', 'edit');
  }

  beforeEach(async () => {
    tempDir = await mkdtemp(join(tmpdir(), 'ktx-desc-resume-'));
    project = await initKtxProject({ projectDir: join(tempDir, 'project') });
  });

  afterEach(async () => {
    await rm(tempDir, { recursive: true, force: true });
  });

  it('flushes durable descriptions + ai manifest descriptions on a fresh run', async () => {
    const { calls } = await runEnrichment('run-1');
    expect(calls).toBe(3);

    const progress = await readProgress();
    expect(progress.descriptions.map((entry) => entry.table.name).sort()).toEqual(['customers', 'orders', 'products']);

    const shard = YAML.parse((await project.fileStore.readFile(SHARD_PATH)).content) as {
      tables: Record<string, { descriptions?: { ai?: string } }>;
    };
    expect(shard.tables.customers?.descriptions?.ai).toBe('AI table description');
    expect(shard.tables.products?.descriptions?.ai).toBe('AI table description');
  });

  it('re-issues no LLM calls when every table is already enriched (matching inputHash)', async () => {
    await runEnrichment('run-1');
    const { result, calls } = await runEnrichment('run-2');

    expect(calls).toBe(0);
    expect(result.descriptionUpdates).toHaveLength(3);
    expect(result.descriptionUpdates.every((update) => update.tableDescription === 'AI table description')).toBe(true);
  });

  it('re-enriches only the tables missing from the durable record', async () => {
    await runEnrichment('run-1');
    const progress = await readProgress();
    progress.descriptions = progress.descriptions.filter((entry) => entry.table.name !== 'orders');
    await writeProgress(progress);

    const { result, calls } = await runEnrichment('run-2');

    expect(calls).toBe(1);
    expect(result.descriptionUpdates.map((update) => update.table.name).sort()).toEqual([
      'customers',
      'orders',
      'products',
    ]);
  });

  it('recomputes the whole stage when the durable record inputHash differs', async () => {
    await runEnrichment('run-1');
    const progress = await readProgress();
    await writeProgress({ ...progress, inputHash: 'stale-input-hash' });

    const { calls } = await runEnrichment('run-2');
    expect(calls).toBe(3);
  });

  it('persists the other tables and completes the stage when one table fails', async () => {
    const stateStore = new SqliteLocalScanEnrichmentStateStore({ dbPath: join(tempDir, 'state.sqlite') });
    let calls = 0;
    const runtime: KtxLlmRuntimePort = {
      generateText: vi.fn(async () => 'AI column description'),
      generateObject: vi.fn(async (input: { prompt: string }) => {
        calls += 1;
        if (input.prompt.includes('orders')) {
          throw new Error('backend overloaded');
        }
        return { tableDescription: 'AI table description', columns: [] };
      }) as KtxLlmRuntimePort['generateObject'],
      runAgentLoop: vi.fn(),
      subprocessForkSpec: () => null,
    };

    const result = await runLocalScanEnrichment({
      connectionId: 'warehouse',
      mode: 'enriched',
      connector: connector(),
      snapshot,
      context: { runId: 'run-skip' },
      providers: { llmRuntime: runtime, embedding: null },
      descriptionResumeStore: createKtxScanDescriptionResumeStore({
        project,
        connectionId: 'warehouse',
        syncId: 'sync-1',
        driver: 'postgres',
      }),
      stateStore,
      syncId: 'sync-1',
      relationshipSettings: relationshipsDisabled(),
    });

    // orders retries to the attempt limit (3) then fails; customers + products succeed once each.
    expect(calls).toBe(5);
    // The failed table is a single missing description, not the whole stage's loss.
    const byName = new Map(result.descriptionUpdates.map((update) => [update.table.name, update]));
    expect(byName.get('orders')?.tableDescription).toBeNull();
    expect(byName.get('customers')?.tableDescription).toBe('AI table description');
    expect(byName.get('products')?.tableDescription).toBe('AI table description');

    // The stage completed (a completed row exists, not zero).
    const stages = await stateStore.listRunStages('run-skip');
    expect(stages.some((stage) => stage.stage === 'descriptions' && stage.status === 'completed')).toBe(true);

    // The good tables are durable: progress record + ai: in the manifest; the failed one is absent.
    const progress = await readProgress();
    expect(progress.descriptions.map((entry) => entry.table.name).sort()).toEqual(['customers', 'products']);
    const shard = YAML.parse((await project.fileStore.readFile(SHARD_PATH)).content) as {
      tables: Record<string, { descriptions?: { ai?: string } }>;
    };
    expect(shard.tables.customers?.descriptions?.ai).toBe('AI table description');
    expect(shard.tables.orders?.descriptions?.ai).toBeUndefined();
  });

  it('rewrites only the manifest shards that gained a changed table', async () => {
    const multiDb: KtxSchemaSnapshot = {
      ...snapshot,
      tables: [
        { ...table('customers'), db: 'sales' },
        { ...table('orders'), db: 'ops' },
      ],
    };
    await writeLocalScanManifestShards({
      project,
      connectionId: 'warehouse',
      syncId: 'sync-1',
      driver: 'postgres',
      snapshot: multiDb,
      dryRun: false,
    });

    const flushed = await writeLocalScanManifestShards({
      project,
      connectionId: 'warehouse',
      syncId: 'sync-1',
      driver: 'postgres',
      snapshot: multiDb,
      dryRun: false,
      descriptionUpdates: [
        { table: { catalog: null, db: 'sales', name: 'customers' }, tableDescription: 'desc', columnDescriptions: {} },
      ],
      onlyChangedTableNames: new Set(['customers']),
    });

    expect(flushed.manifestShards).toHaveLength(1);
    expect(flushed.manifestShards[0]).toContain('sales');
  });
});
