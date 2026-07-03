import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import Database from 'better-sqlite3';
import { describe, expect, it, vi } from 'vitest';
import YAML from 'yaml';
import { buildDefaultKtxProjectConfig } from '../../../src/context/project/config.js';
import { initKtxProject } from '../../../src/context/project/project.js';
import {
  loadOnDiskDescriptionUpdates,
  writeLocalScanEnrichmentArtifacts,
} from '../../../src/context/scan/local-enrichment-artifacts.js';
import type {
  KtxScanEnrichmentCompletedStage,
  KtxScanEnrichmentFailedStage,
  KtxScanEnrichmentStageLookup,
  KtxScanEnrichmentStateStore,
} from '../../../src/context/scan/enrichment-state.js';
import {
  createDeterministicLocalScanEnrichmentProviders,
  runLocalScanEnrichment,
  snapshotToKtxEnrichedSchema,
} from '../../../src/context/scan/local-enrichment.js';
import {
  createKtxConnectorCapabilities,
  type KtxQueryResult,
  type KtxReadOnlyQueryInput,
  type KtxEmbeddingPort,
  type KtxScanConnector,
  type KtxScanContext,
  type KtxSchemaSnapshot,
} from '../../../src/context/scan/types.js';

function fakeScanEmbedding(options: { dimensions: number; maxBatchSize?: number }): KtxEmbeddingPort {
  return {
    dimensions: options.dimensions,
    maxBatchSize: options.maxBatchSize ?? 64,
    async embedBatch(texts) {
      return texts.map((_, textIndex) =>
        Array.from({ length: options.dimensions }, (__, dimensionIndex) => textIndex + dimensionIndex),
      );
    },
  };
}

const snapshot: KtxSchemaSnapshot = {
  connectionId: 'warehouse',
  driver: 'postgres',
  extractedAt: '2026-04-29T12:00:00.000Z',
  scope: { schemas: ['public'] },
  metadata: {},
  tables: [
    {
      catalog: null,
      db: 'public',
      name: 'customers',
      kind: 'table',
      comment: 'Customer accounts',
      estimatedRows: 2,
      foreignKeys: [],
      columns: [
        {
          name: 'id',
          nativeType: 'integer',
          normalizedType: 'integer',
          dimensionType: 'number',
          nullable: false,
          primaryKey: true,
          comment: 'Customer id',
        },
      ],
    },
    {
      catalog: null,
      db: 'public',
      name: 'orders',
      kind: 'table',
      comment: 'Customer orders',
      estimatedRows: 3,
      foreignKeys: [],
      columns: [
        {
          name: 'id',
          nativeType: 'integer',
          normalizedType: 'integer',
          dimensionType: 'number',
          nullable: false,
          primaryKey: true,
          comment: 'Order id',
        },
        {
          name: 'customer_id',
          nativeType: 'integer',
          normalizedType: 'integer',
          dimensionType: 'number',
          nullable: false,
          primaryKey: false,
          comment: 'Customer id',
        },
      ],
    },
  ],
};

function connector(): KtxScanConnector {
  return {
    id: 'test:warehouse',
    driver: 'postgres',
    capabilities: createKtxConnectorCapabilities({
      tableSampling: true,
      columnSampling: true,
      readOnlySql: true,
      columnStats: true,
    }),
    introspect: vi.fn(async () => snapshot),
    listSchemas: vi.fn(async () => []),
    listTables: vi.fn(async () => []),
    sampleTable: vi.fn(async () => ({
      headers: ['id', 'customer_id'],
      rows: [[1, 10]],
      totalRows: 1,
    })),
    sampleColumn: vi.fn(async () => ({
      values: ['10', '11'],
      nullCount: 0,
      distinctCount: 2,
    })),
  };
}

class InMemorySqliteExecutor {
  readonly db = new Database(':memory:');

  executeReadOnly(input: KtxReadOnlyQueryInput, _ctx: KtxScanContext): Promise<KtxQueryResult> {
    const rows = this.db.prepare(input.sql).all() as Record<string, unknown>[];
    const headers = Object.keys(rows[0] ?? {});
    return Promise.resolve({
      headers,
      rows: rows.map((row) => headers.map((header) => row[header])),
      totalRows: rows.length,
      rowCount: rows.length,
    });
  }

  close(): void {
    this.db.close();
  }
}

function noDeclaredRelationshipSnapshot(): KtxSchemaSnapshot {
  return {
    connectionId: 'warehouse',
    driver: 'sqlite',
    extractedAt: '2026-05-07T00:00:00.000Z',
    scope: {},
    metadata: {},
    tables: [
      {
        catalog: null,
        db: null,
        name: 'accounts',
        kind: 'table',
        comment: null,
        estimatedRows: 2,
        foreignKeys: [],
        columns: [
          {
            name: 'id',
            nativeType: 'INTEGER',
            normalizedType: 'integer',
            dimensionType: 'number',
            nullable: false,
            primaryKey: false,
            comment: null,
          },
        ],
      },
      {
        catalog: null,
        db: null,
        name: 'orders',
        kind: 'table',
        comment: null,
        estimatedRows: 3,
        foreignKeys: [],
        columns: [
          {
            name: 'id',
            nativeType: 'INTEGER',
            normalizedType: 'integer',
            dimensionType: 'number',
            nullable: false,
            primaryKey: false,
            comment: null,
          },
          {
            name: 'account_id',
            nativeType: 'INTEGER',
            normalizedType: 'integer',
            dimensionType: 'number',
            nullable: false,
            primaryKey: false,
            comment: null,
          },
        ],
      },
    ],
  };
}

function memoryEnrichmentStateStore(): KtxScanEnrichmentStateStore {
  const records = new Map<string, KtxScanEnrichmentCompletedStage | KtxScanEnrichmentFailedStage>();
  const key = (input: Pick<KtxScanEnrichmentStageLookup, 'connectionId' | 'stage' | 'inputHash'>) =>
    `${input.connectionId}:${input.stage}:${input.inputHash}`;
  return {
    async findCompletedStage<TOutput>(input: KtxScanEnrichmentStageLookup) {
      const record = records.get(key(input));
      if (!record || record.status !== 'completed') {
        return null;
      }
      return record as KtxScanEnrichmentCompletedStage<TOutput>;
    },
    async findLatestCompletedStage(input) {
      const matches = [...records.values()].filter(
        (record): record is KtxScanEnrichmentCompletedStage =>
          record.status === 'completed' && record.connectionId === input.connectionId && record.stage === input.stage,
      );
      matches.sort((left, right) => (left.updatedAt < right.updatedAt ? 1 : -1));
      return matches[0] ?? null;
    },
    async saveCompletedStage(input) {
      records.set(key(input), {
        ...input,
        status: 'completed',
        errorMessage: null,
      });
    },
    async saveFailedStage(input) {
      records.set(key(input), {
        ...input,
        status: 'failed',
        output: null,
      });
    },
    async listRunStages(runId) {
      return [...records.values()].filter((record) => record.runId === runId);
    },
  };
}

describe('local scan enrichment', () => {
  it('maps a scan snapshot into relationship detector schema', () => {
    const schema = snapshotToKtxEnrichedSchema(snapshot);

    expect(schema.connectionId).toBe('warehouse');
    expect(schema.tables).toHaveLength(2);
    expect(schema.tables[1]?.columns.map((column) => column.name)).toEqual(['id', 'customer_id']);
    expect(schema.tables[1]?.columns[1]).toMatchObject({
      id: 'public.orders.customer_id',
      tableId: 'public.orders',
      primaryKey: false,
      sampleValues: null,
      embedding: null,
    });
  });

  it('scopes descriptions by full table identity across same-named tables in different schemas', () => {
    const multiSchemaSnapshot: KtxSchemaSnapshot = {
      connectionId: 'warehouse',
      driver: 'postgres',
      extractedAt: '2026-04-29T12:00:00.000Z',
      scope: { schemas: ['analytics', 'staging'] },
      metadata: {},
      tables: ['analytics', 'staging'].map((schema) => ({
        catalog: null,
        db: schema,
        name: 'orders',
        kind: 'table',
        comment: null,
        estimatedRows: 1,
        foreignKeys: [],
        columns: [
          {
            name: 'id',
            nativeType: 'integer',
            normalizedType: 'integer',
            dimensionType: 'number',
            nullable: false,
            primaryKey: true,
            comment: null,
          },
        ],
      })),
    };
    const descriptions = [
      {
        table: { catalog: null, db: 'analytics', name: 'orders' },
        tableDescription: 'Curated analytics orders',
        columnDescriptions: { id: 'Analytics order id' },
      },
      {
        table: { catalog: null, db: 'staging', name: 'orders' },
        tableDescription: 'Raw staging orders',
        columnDescriptions: { id: 'Staging order id' },
      },
    ];

    const schema = snapshotToKtxEnrichedSchema(multiSchemaSnapshot, new Map(), descriptions);

    const analytics = schema.tables.find((table) => table.id === 'analytics.orders');
    const staging = schema.tables.find((table) => table.id === 'staging.orders');
    expect(analytics?.descriptions.ai).toBe('Curated analytics orders');
    expect(staging?.descriptions.ai).toBe('Raw staging orders');
    expect(analytics?.columns[0]?.descriptions.ai).toBe('Analytics order id');
    expect(staging?.columns[0]?.descriptions.ai).toBe('Staging order id');
  });

  it('maps snapshot foreign keys into formal schema relationships', () => {
    const source = noDeclaredRelationshipSnapshot();
    const snapshotWithForeignKey = {
      ...source,
      tables: source.tables.map((table) =>
        table.name === 'orders'
          ? {
              ...table,
              foreignKeys: [
                {
                  fromColumn: 'account_id',
                  toCatalog: null,
                  toDb: null,
                  toTable: 'accounts',
                  toColumn: 'id',
                  constraintName: 'orders_account_id_fkey',
                },
              ],
            }
          : table.name === 'accounts'
            ? {
                ...table,
                columns: table.columns.map((column) =>
                  column.name === 'id' ? { ...column, primaryKey: true } : column,
                ),
              }
            : table,
      ),
    };

    const schema = snapshotToKtxEnrichedSchema(snapshotWithForeignKey);

    expect(schema.relationships).toEqual([
      {
        id: 'orders:(orders.account_id)->accounts:(accounts.id)',
        source: 'formal',
        from: {
          tableId: 'orders',
          columnIds: ['orders.account_id'],
          table: { catalog: null, db: null, name: 'orders' },
          columns: ['account_id'],
        },
        to: {
          tableId: 'accounts',
          columnIds: ['accounts.id'],
          table: { catalog: null, db: null, name: 'accounts' },
          columns: ['id'],
        },
        relationshipType: 'many_to_one',
        confidence: 1,
        isPrimaryKeyReference: true,
      },
    ]);
  });

  it('uses the supplied snapshot without calling connector.introspect', async () => {
    const scanConnector = connector();
    const introspect = vi.mocked(scanConnector.introspect);

    const result = await runLocalScanEnrichment({
      connectionId: 'warehouse',
      mode: 'structural',
      connector: scanConnector,
      snapshot,
      context: { runId: 'scan-run-snapshot' },
      providers: null,
    });

    expect(result.snapshot).toEqual(snapshot);
    expect(introspect).not.toHaveBeenCalled();
  });

  it('falls back to connector.introspect when no snapshot is supplied', async () => {
    const scanConnector = connector();

    const result = await runLocalScanEnrichment({
      connectionId: 'warehouse',
      mode: 'structural',
      connector: scanConnector,
      context: { runId: 'scan-run-introspect' },
      providers: null,
    });

    expect(result.snapshot).toEqual(snapshot);
    expect(scanConnector.introspect).toHaveBeenCalledTimes(1);
  });

  it('fails when connector driver and snapshot driver differ', async () => {
    const mismatchedConnector: KtxScanConnector = {
      ...connector(),
      driver: 'mysql',
    };

    await expect(
      runLocalScanEnrichment({
        connectionId: 'warehouse',
        mode: 'relationships',
        detectRelationships: true,
        connector: mismatchedConnector,
        snapshot,
        context: { runId: 'scan-run-driver-mismatch' },
        providers: null,
      }),
    ).rejects.toThrow(
      'ktx scan connector driver "mysql" does not match snapshot driver "postgres" for connection "warehouse"',
    );
  });

  it('runs deterministic relationship detection for relationship scans', async () => {
    const result = await runLocalScanEnrichment({
      connectionId: 'warehouse',
      mode: 'relationships',
      detectRelationships: true,
      connector: connector(),
      context: { runId: 'scan-run-1' },
      providers: null,
    });

    expect(result.summary).toMatchObject({
      deterministicRelationships: 'completed',
      llmRelationshipValidation: 'skipped',
      embeddings: 'skipped',
    });
    expect(result.relationships).toEqual({ accepted: 0, review: 1, rejected: 0, skipped: 0 });
    expect(result.summary.statisticalValidation).toBe('skipped');
    expect(result.warnings).toContainEqual({
      code: 'relationship_validation_failed',
      message: 'ktx scan connector advertises readOnlySql but does not expose executeReadOnly',
      recoverable: true,
      metadata: { capability: 'readOnlySql' },
    });
  });

  it('runs relationship discovery with connector SQL evidence', async () => {
    const executor = new InMemorySqliteExecutor();
    try {
      executor.db.exec(`
        CREATE TABLE accounts (id INTEGER NOT NULL);
        CREATE TABLE orders (id INTEGER NOT NULL, account_id INTEGER NOT NULL);
        INSERT INTO accounts (id) VALUES (1), (2);
        INSERT INTO orders (id, account_id) VALUES (10, 1), (11, 1), (12, 2);
      `);
      const scanConnector = {
        ...connector(),
        driver: 'sqlite' as const,
        capabilities: createKtxConnectorCapabilities({ readOnlySql: true, columnStats: true }),
        introspect: vi.fn(async () => noDeclaredRelationshipSnapshot()),
        executeReadOnly: executor.executeReadOnly.bind(executor),
      };

      const result = await runLocalScanEnrichment({
        connectionId: 'warehouse',
        mode: 'relationships',
        detectRelationships: true,
        connector: scanConnector,
        context: { runId: 'scan-run-relationship-discovery' },
        providers: null,
      });

      expect(result.relationships).toEqual({ accepted: 1, review: 0, rejected: 0, skipped: 0 });
      expect(result.summary.statisticalValidation).toBe('completed');
      expect(result.relationshipProfile).toMatchObject({ sqlAvailable: true });
      expect(result.resolvedRelationships).toEqual([
        expect.objectContaining({
          status: 'accepted',
          from: expect.objectContaining({ table: expect.objectContaining({ name: 'orders' }), columns: ['account_id'] }),
          to: expect.objectContaining({ table: expect.objectContaining({ name: 'accounts' }), columns: ['id'] }),
        }),
      ]);
      expect(result.relationshipUpdate?.accepted).toHaveLength(1);
    } finally {
      executor.close();
    }
  });

  it('honors scan relationship config when LLM proposals are disabled', async () => {
    const providers = createDeterministicLocalScanEnrichmentProviders();
    const generateObject = vi.fn();
    const result = await runLocalScanEnrichment({
      connectionId: 'warehouse',
      mode: 'relationships',
      detectRelationships: true,
      connector: connector(),
      context: { runId: 'scan-run-llm-disabled' },
      providers: {
        ...providers,
        llmRuntime: {
          ...providers.llmRuntime,
          generateObject: generateObject as never,
        },
      },
      relationshipSettings: {
        ...buildDefaultKtxProjectConfig().scan.relationships,
        llmProposals: false,
        maxLlmTablesPerBatch: 40,
      },
    });

    expect(result.summary.llmRelationshipValidation).toBe('skipped');
    expect(generateObject).not.toHaveBeenCalled();
  });

  it('skips relationship detection when scan relationships are disabled', async () => {
    const settings = {
      ...buildDefaultKtxProjectConfig().scan.relationships,
      enabled: false,
    };
    const result = await runLocalScanEnrichment({
      connectionId: 'warehouse',
      mode: 'enriched',
      connector: connector(),
      context: { runId: 'disabled-relationships' },
      providers: createDeterministicLocalScanEnrichmentProviders(),
      relationshipSettings: settings,
    });

    expect(result.summary.deterministicRelationships).toBe('skipped');
    expect(result.summary.statisticalValidation).toBe('skipped');
    expect(result.summary.llmRelationshipValidation).toBe('skipped');
    expect(result.relationships).toEqual({ accepted: 0, review: 0, rejected: 0, skipped: 0 });
    expect(result.relationshipUpdate).toBeNull();
    expect(result.relationshipProfile).toBeNull();
    expect(result.resolvedRelationships).toBeNull();
  });

  it('forwards context.logger and emits warnings when sampleTable fails repeatedly', async () => {
    const failingConnector: KtxScanConnector = {
      ...connector(),
      sampleTable: vi.fn(async () => {
        throw new Error('pool: ECONNRESET');
      }),
    };
    const logger = {
      debug: vi.fn(),
      info: vi.fn(),
      warn: vi.fn(),
      error: vi.fn(),
    };

    const result = await runLocalScanEnrichment({
      connectionId: 'warehouse',
      mode: 'enriched',
      detectRelationships: false,
      connector: failingConnector,
      context: { runId: 'scan-run-warnings', logger },
      providers: createDeterministicLocalScanEnrichmentProviders(),
    });

    const codes = result.warnings.map((warning) => warning.code);
    expect(codes).toContain('sampling_failed');
    expect(codes).toContain('description_fallback_used');
    expect(result.warnings.some((warning) => warning.table === 'customers')).toBe(true);
    expect(logger.warn).toHaveBeenCalled();
    expect(logger.error).toHaveBeenCalled();
    // Each of the two tables produced sampling_failed + description_fallback_used, so 2 + 2 = 4 warnings minimum.
    expect(result.warnings.length).toBeGreaterThanOrEqual(4);
    // Sampling was retried 3× for each of the 2 tables = 6 calls
    expect(failingConnector.sampleTable).toHaveBeenCalledTimes(6);
  });

  it('runs configured deterministic enrichment with descriptions and no embeddings', async () => {
    const result = await runLocalScanEnrichment({
      connectionId: 'warehouse',
      mode: 'enriched',
      detectRelationships: true,
      connector: connector(),
      context: { runId: 'scan-run-2' },
      providers: createDeterministicLocalScanEnrichmentProviders(),
    });

    expect(result.summary).toMatchObject({
      dataDictionary: 'completed',
      tableDescriptions: 'completed',
      columnDescriptions: 'completed',
      embeddings: 'skipped',
      deterministicRelationships: 'completed',
    });
    expect(result.embeddingUpdates).toEqual([]);
    expect(result.snapshot).toEqual(snapshot);
    expect(result.relationships).toEqual({ accepted: 0, review: 1, rejected: 0, skipped: 0 });
  });

  it('generates batched table descriptions with bounded table-level concurrency', async () => {
    const concurrentSnapshot: KtxSchemaSnapshot = {
      ...snapshot,
      tables: Array.from({ length: 8 }, (_, index) => ({
        catalog: null,
        db: 'public',
        name: `table_${index + 1}`,
        kind: 'table' as const,
        comment: null,
        estimatedRows: 2,
        foreignKeys: [],
        columns: [
          {
            name: 'id',
            nativeType: 'integer',
            normalizedType: 'integer',
            dimensionType: 'number' as const,
            nullable: false,
            primaryKey: true,
            comment: null,
          },
        ],
      })),
    };
    let activeTableSamples = 0;
    let maxActiveTableSamples = 0;
    const scanConnector = {
      ...connector(),
      introspect: vi.fn(async () => concurrentSnapshot),
      sampleColumn: vi.fn(async () => ({
        values: ['1'],
        nullCount: 0,
        distinctCount: 1,
      })),
      sampleTable: vi.fn(async () => {
        activeTableSamples += 1;
        maxActiveTableSamples = Math.max(maxActiveTableSamples, activeTableSamples);
        await new Promise((resolve) => setTimeout(resolve, 10));
        activeTableSamples -= 1;
        return {
          headers: ['id'],
          rows: [[1]],
          totalRows: 1,
        };
      }),
    };
    const settings = {
      ...buildDefaultKtxProjectConfig().scan.relationships,
      enabled: false,
    };

    await runLocalScanEnrichment({
      connectionId: 'warehouse',
      mode: 'enriched',
      connector: scanConnector,
      context: { runId: 'scan-run-concurrent-descriptions' },
      providers: createDeterministicLocalScanEnrichmentProviders(),
      relationshipSettings: settings,
    });

    expect(maxActiveTableSamples).toBe(4);
    expect(scanConnector.sampleColumn).not.toHaveBeenCalled();
  });

  it('reports enrichment progress for countable stages', async () => {
    const events: Array<{ progress: number; message?: string; transient?: boolean }> = [];
    const progress = {
      async update(progressValue: number, message?: string, options?: { transient?: boolean }) {
        events.push({ progress: progressValue, message, transient: options?.transient });
      },
      startPhase() {
        return progress;
      },
    };

    await runLocalScanEnrichment({
      connectionId: 'warehouse',
      mode: 'enriched',
      detectRelationships: true,
      connector: connector(),
      context: { runId: 'scan-run-progress', progress },
      providers: {
        ...createDeterministicLocalScanEnrichmentProviders(),
        embedding: fakeScanEmbedding({ dimensions: 6 }),
      },
    });

    expect(events).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ message: 'Generating descriptions 1/2 (customers, 1 cols)', transient: true }),
        expect.objectContaining({ message: 'Generating descriptions 2/2 (orders, 2 cols)', transient: true }),
        expect.objectContaining({ message: 'Building embeddings 1/1 batches', transient: true }),
        expect.objectContaining({ message: 'Detecting relationships' }),
      ]),
    );
  });

  it('reports progress before enrichment connector introspection starts', async () => {
    const events: Array<{ progress: number; message?: string; transient?: boolean }> = [];
    const progress = {
      async update(progressValue: number, message?: string, options?: { transient?: boolean }) {
        events.push({ progress: progressValue, message, transient: options?.transient });
      },
      startPhase() {
        return progress;
      },
    };
    const scanConnector = {
      ...connector(),
      introspect: vi.fn(async () => {
        expect(events).toContainEqual(expect.objectContaining({ message: 'Loading enrichment schema snapshot' }));
        return snapshot;
      }),
    };

    await runLocalScanEnrichment({
      connectionId: 'warehouse',
      mode: 'relationships',
      detectRelationships: true,
      connector: scanConnector,
      context: { runId: 'scan-run-progress-before-introspection', progress },
      providers: null,
    });

    expect(scanConnector.introspect).toHaveBeenCalled();
  });

  it('splits enrichment embedding requests by provider batch size', async () => {
    const manyColumnSnapshot: KtxSchemaSnapshot = {
      ...snapshot,
      tables: [
        {
          catalog: null,
          db: 'public',
          name: 'wide_orders',
          kind: 'table',
          comment: 'Wide order facts',
          estimatedRows: 3,
          foreignKeys: [],
          columns: Array.from({ length: 5 }, (_, index) => ({
            name: `metric_${index + 1}`,
            nativeType: 'integer',
            normalizedType: 'integer',
            dimensionType: 'number' as const,
            nullable: false,
            primaryKey: false,
            comment: `Metric ${index + 1}`,
          })),
        },
      ],
    };
    const scanConnector = {
      ...connector(),
      introspect: vi.fn(async () => manyColumnSnapshot),
    };
    const deterministicProviders = createDeterministicLocalScanEnrichmentProviders();
    const embedBatch = vi.fn(async (texts: string[]) => {
      if (texts.length > 2) {
        throw new Error(`Embedding batch size ${texts.length} exceeds maximum 2`);
      }
      return texts.map((_, index) => [index, index + 1, index + 2]);
    });

    const result = await runLocalScanEnrichment({
      connectionId: 'warehouse',
      mode: 'enriched',
      detectRelationships: false,
      connector: scanConnector,
      context: { runId: 'scan-run-batched-embeddings' },
      providers: {
        llmRuntime: deterministicProviders.llmRuntime,
        embedding: {
          dimensions: 3,
          maxBatchSize: 2,
          embedBatch,
        },
      },
    });

    expect(result.embeddingUpdates).toHaveLength(5);
    expect(embedBatch.mock.calls.map(([texts]) => texts).map((texts) => texts.length)).toEqual([2, 2, 1]);
  });

  it('reuses completed description and embedding stages across a fresh run id by content identity', async () => {
    const stateStore = memoryEnrichmentStateStore();
    const scanConnector = connector();
    const providers = {
      ...createDeterministicLocalScanEnrichmentProviders(),
      embedding: fakeScanEmbedding({ dimensions: 6 }),
    };

    const first = await runLocalScanEnrichment({
      connectionId: 'warehouse',
      mode: 'enriched',
      detectRelationships: true,
      connector: scanConnector,
      context: { runId: 'scan-run-resume-1' },
      providers,
      stateStore,
      syncId: 'sync-resume-1',
      llmIdentity: { model: 'fake', baseUrlConfigured: false },
      embeddingIdentity: { model: 'fake-embed', dimensions: 6, batchSize: 64 },
    });

    const generateObject = vi.spyOn(providers.llmRuntime, 'generateObject');
    const embedBatch = vi.spyOn(providers.embedding, 'embedBatch');
    // A re-run mints a brand-new runId/syncId (as a real interrupted ingest
    // would); resume must still hit the cache via (connectionId, stage, inputHash).
    const second = await runLocalScanEnrichment({
      connectionId: 'warehouse',
      mode: 'enriched',
      detectRelationships: true,
      connector: scanConnector,
      context: { runId: 'scan-run-resume-2' },
      providers,
      stateStore,
      syncId: 'sync-resume-2',
      llmIdentity: { model: 'fake', baseUrlConfigured: false },
      embeddingIdentity: { model: 'fake-embed', dimensions: 6, batchSize: 64 },
    });

    expect(first.state.completedStages).toEqual(['descriptions', 'embeddings', 'relationships']);
    expect(first.state.resumedStages).toEqual([]);
    expect(second.state.resumedStages).toEqual(['descriptions', 'embeddings', 'relationships']);
    expect(second.state.completedStages).toEqual(['descriptions', 'embeddings', 'relationships']);
    expect(generateObject).not.toHaveBeenCalled();
    expect(embedBatch).not.toHaveBeenCalled();
    expect(second.descriptionUpdates).toEqual(first.descriptionUpdates);
    expect(second.embeddingUpdates).toEqual(first.embeddingUpdates);
    expect(second.relationships).toEqual(first.relationships);
  });

  it('marks a budget-truncated relationship stage partial, persists it, and re-runs only when the budget is raised', async () => {
    const executor = new InMemorySqliteExecutor();
    try {
      executor.db.exec(`
        CREATE TABLE accounts (id INTEGER NOT NULL);
        CREATE TABLE orders (id INTEGER NOT NULL, account_id INTEGER NOT NULL);
        INSERT INTO accounts (id) VALUES (1), (2);
        INSERT INTO orders (id, account_id) VALUES (10, 1), (11, 1), (12, 2);
      `);
      const scanConnector = {
        ...connector(),
        driver: 'sqlite' as const,
        capabilities: createKtxConnectorCapabilities({ readOnlySql: true, columnStats: true }),
        introspect: vi.fn(async () => noDeclaredRelationshipSnapshot()),
        executeReadOnly: executor.executeReadOnly.bind(executor),
      };
      const stateStore = memoryEnrichmentStateStore();
      const base = Date.parse('2026-06-01T00:00:00.000Z');
      let calls = 0;
      // A clock that jumps a second per read against a 1ms budget trips at the
      // first table-profile boundary.
      const advancingNow = () => new Date(base + calls++ * 1000);
      const tightSettings = {
        ...buildDefaultKtxProjectConfig().scan.relationships,
        detectionBudgetMs: 1,
      };

      const first = await runLocalScanEnrichment({
        connectionId: 'warehouse',
        mode: 'relationships',
        detectRelationships: true,
        connector: scanConnector,
        context: { runId: 'budget-run-1' },
        providers: null,
        stateStore,
        syncId: 'sync-budget-1',
        relationshipSettings: tightSettings,
        now: advancingNow,
      });

      expect(first.relationshipPartial).toEqual({ reason: 'budget' });
      expect(first.warnings.map((warning) => warning.code)).toContain('relationship_detection_partial');
      expect(first.state.completedStages).toContain('relationships');

      // A re-run with a fresh runId resumes the saved partial from cache.
      const second = await runLocalScanEnrichment({
        connectionId: 'warehouse',
        mode: 'relationships',
        detectRelationships: true,
        connector: scanConnector,
        context: { runId: 'budget-run-2' },
        providers: null,
        stateStore,
        syncId: 'sync-budget-2',
        relationshipSettings: tightSettings,
      });
      expect(second.state.resumedStages).toContain('relationships');

      // Raising the budget changes the content identity, forcing a fuller run.
      const third = await runLocalScanEnrichment({
        connectionId: 'warehouse',
        mode: 'relationships',
        detectRelationships: true,
        connector: scanConnector,
        context: { runId: 'budget-run-3' },
        providers: null,
        stateStore,
        syncId: 'sync-budget-3',
        relationshipSettings: { ...tightSettings, detectionBudgetMs: 600_000 },
      });
      expect(third.state.resumedStages).not.toContain('relationships');
      expect(third.relationshipPartial).toBeNull();
    } finally {
      executor.close();
    }
  });

  it('checkpoints descriptions and embeddings before the relationship stage queries the database', async () => {
    const executor = new InMemorySqliteExecutor();
    try {
      executor.db.exec(`
        CREATE TABLE accounts (id INTEGER NOT NULL);
        CREATE TABLE orders (id INTEGER NOT NULL, account_id INTEGER NOT NULL);
        INSERT INTO accounts (id) VALUES (1), (2);
        INSERT INTO orders (id, account_id) VALUES (10, 1), (11, 1), (12, 2);
      `);
      const checkpoints: Array<Awaited<ReturnType<typeof runLocalScanEnrichment>>> = [];
      let sawRelationshipQuery = false;
      let relationshipQueryRanAfterCheckpoint = true;
      const scanConnector = {
        ...connector(),
        driver: 'sqlite' as const,
        capabilities: createKtxConnectorCapabilities({ readOnlySql: true, columnStats: true }),
        introspect: vi.fn(async () => noDeclaredRelationshipSnapshot()),
        executeReadOnly: (input: KtxReadOnlyQueryInput, ctx: KtxScanContext) => {
          sawRelationshipQuery = true;
          if (checkpoints.length === 0) {
            relationshipQueryRanAfterCheckpoint = false;
          }
          return executor.executeReadOnly(input, ctx);
        },
      };

      const result = await runLocalScanEnrichment({
        connectionId: 'warehouse',
        mode: 'enriched',
        detectRelationships: true,
        connector: scanConnector,
        context: { runId: 'checkpoint-order' },
        providers: {
          ...createDeterministicLocalScanEnrichmentProviders(),
          embedding: fakeScanEmbedding({ dimensions: 6 }),
        },
        onCheckpoint: async (checkpoint) => {
          checkpoints.push(checkpoint);
        },
      });

      expect(checkpoints).toHaveLength(1);
      const checkpoint = checkpoints[0];
      if (!checkpoint) {
        throw new Error('Expected a checkpoint');
      }
      expect(checkpoint.summary.tableDescriptions).toBe('completed');
      expect(checkpoint.summary.embeddings).toBe('completed');
      expect(checkpoint.descriptionUpdates.length).toBeGreaterThan(0);
      expect(checkpoint.embeddingUpdates.length).toBeGreaterThan(0);
      // The relationship-specific outputs are deliberately absent at checkpoint time.
      expect(checkpoint.relationshipUpdate).toBeNull();
      expect(checkpoint.relationshipProfile).toBeNull();
      expect(sawRelationshipQuery).toBe(true);
      expect(relationshipQueryRanAfterCheckpoint).toBe(true);
      // The final result still carries the relationship outputs.
      expect(result.relationshipProfile).not.toBeNull();
    } finally {
      executor.close();
    }
  });

  it('checkpoints recomputed embeddings before relationships even when descriptions load from disk', async () => {
    const executor = new InMemorySqliteExecutor();
    try {
      executor.db.exec(`
        CREATE TABLE accounts (id INTEGER NOT NULL);
        CREATE TABLE orders (id INTEGER NOT NULL, account_id INTEGER NOT NULL);
        INSERT INTO accounts (id) VALUES (1), (2);
        INSERT INTO orders (id, account_id) VALUES (10, 1), (11, 1), (12, 2);
      `);
      const priorDescriptions: Array<{
        table: { catalog: null; db: null; name: string };
        tableDescription: string | null;
        columnDescriptions: Record<string, string | null>;
      }> = [
        {
          table: { catalog: null, db: null, name: 'orders' },
          tableDescription: 'Customer purchase orders',
          columnDescriptions: { id: 'Order identifier', account_id: 'The owning account reference' },
        },
        {
          table: { catalog: null, db: null, name: 'accounts' },
          tableDescription: 'Account records',
          columnDescriptions: { id: 'Account identifier' },
        },
      ];
      const scanConnector = {
        ...connector(),
        driver: 'sqlite' as const,
        capabilities: createKtxConnectorCapabilities({ readOnlySql: true, columnStats: true }),
        introspect: vi.fn(async () => noDeclaredRelationshipSnapshot()),
        executeReadOnly: executor.executeReadOnly.bind(executor),
      };
      const checkpoints: Array<Awaited<ReturnType<typeof runLocalScanEnrichment>>> = [];

      await runLocalScanEnrichment({
        connectionId: 'warehouse',
        mode: 'enriched',
        detectRelationships: true,
        connector: scanConnector,
        context: { runId: 'embeddings-rel-checkpoint' },
        providers: {
          ...createDeterministicLocalScanEnrichmentProviders(),
          embedding: fakeScanEmbedding({ dimensions: 6 }),
        },
        stages: ['embeddings', 'relationships'],
        loadPriorDescriptions: async () => priorDescriptions,
        onCheckpoint: async (checkpoint) => {
          checkpoints.push(checkpoint);
        },
      });

      expect(checkpoints).toHaveLength(1);
      const checkpoint = checkpoints[0];
      if (!checkpoint) {
        throw new Error('Expected a checkpoint');
      }
      // Descriptions were loaded from disk (not re-run), but the recomputed
      // embeddings are promoted before the kill-prone relationship stage.
      expect(checkpoint.summary.tableDescriptions).toBe('skipped');
      expect(checkpoint.summary.embeddings).toBe('completed');
      expect(checkpoint.embeddingUpdates.length).toBeGreaterThan(0);
      // The checkpoint must carry the on-disk descriptions, not an empty set, or
      // the manifest merge would delete them (D3).
      expect(checkpoint.descriptionUpdates.length).toBeGreaterThan(0);
      expect(checkpoint.relationshipUpdate).toBeNull();
    } finally {
      executor.close();
    }
  });

  it('does not checkpoint when relationship detection is skipped', async () => {
    const onCheckpoint = vi.fn(async () => {});
    await runLocalScanEnrichment({
      connectionId: 'warehouse',
      mode: 'enriched',
      connector: connector(),
      context: { runId: 'no-checkpoint' },
      providers: createDeterministicLocalScanEnrichmentProviders(),
      relationshipSettings: { ...buildDefaultKtxProjectConfig().scan.relationships, enabled: false },
      onCheckpoint,
    });
    expect(onCheckpoint).not.toHaveBeenCalled();
  });

  it('does not reuse completed stages when the snapshot changes', async () => {
    const stateStore = memoryEnrichmentStateStore();
    const providers = {
      ...createDeterministicLocalScanEnrichmentProviders(),
      embedding: fakeScanEmbedding({ dimensions: 6 }),
    };
    const scanConnector = connector();

    await runLocalScanEnrichment({
      connectionId: 'warehouse',
      mode: 'enriched',
      detectRelationships: false,
      connector: scanConnector,
      context: { runId: 'scan-run-resume-hash' },
      providers,
      stateStore,
      syncId: 'sync-resume-hash',
      llmIdentity: { model: 'fake', baseUrlConfigured: false },
      embeddingIdentity: { model: 'fake-embed', dimensions: 6, batchSize: 64 },
    });

    const firstTable = snapshot.tables[0];
    if (!firstTable) {
      throw new Error('Expected test snapshot table');
    }
    const changedConnector = {
      ...connector(),
      introspect: vi.fn(async () => ({
        ...snapshot,
        tables: [{ ...firstTable, name: 'customers' }],
      })),
    };
    const generateObject = vi.spyOn(providers.llmRuntime, 'generateObject');

    const result = await runLocalScanEnrichment({
      connectionId: 'warehouse',
      mode: 'enriched',
      detectRelationships: false,
      connector: changedConnector,
      context: { runId: 'scan-run-resume-hash' },
      providers,
      stateStore,
      syncId: 'sync-resume-hash',
      llmIdentity: { model: 'fake', baseUrlConfigured: false },
      embeddingIdentity: { model: 'fake-embed', dimensions: 6, batchSize: 64 },
    });

    expect(result.state.resumedStages).toEqual([]);
    expect(result.state.completedStages).toEqual(['descriptions', 'embeddings', 'relationships']);
    expect(generateObject).toHaveBeenCalled();
  });

  it('runs providerless enriched scans as relationship-only discovery enrichment', async () => {
    const executor = new InMemorySqliteExecutor();
    try {
      executor.db.exec(`
        CREATE TABLE accounts (id INTEGER NOT NULL);
        CREATE TABLE orders (id INTEGER NOT NULL, account_id INTEGER NOT NULL);
        INSERT INTO accounts (id) VALUES (1), (2);
        INSERT INTO orders (id, account_id) VALUES (10, 1), (11, 1), (12, 2);
      `);
      const scanConnector = {
        ...connector(),
        driver: 'sqlite' as const,
        capabilities: createKtxConnectorCapabilities({ readOnlySql: true, columnStats: true }),
        introspect: vi.fn(async () => noDeclaredRelationshipSnapshot()),
        executeReadOnly: executor.executeReadOnly.bind(executor),
      };

      const result = await runLocalScanEnrichment({
        connectionId: 'warehouse',
        mode: 'enriched',
        detectRelationships: false,
        connector: scanConnector,
        context: { runId: 'scan-run-providerless-enriched' },
        providers: null,
      });

      expect(result.summary).toEqual({
        dataDictionary: 'skipped',
        tableDescriptions: 'skipped',
        columnDescriptions: 'skipped',
        embeddings: 'skipped',
        deterministicRelationships: 'completed',
        llmRelationshipValidation: 'skipped',
        statisticalValidation: 'completed',
      });
      expect(result.descriptionUpdates).toEqual([]);
      expect(result.embeddingUpdates).toEqual([]);
      expect(result.relationships).toEqual({ accepted: 1, review: 0, rejected: 0, skipped: 0 });
      expect(result.relationshipUpdate?.accepted).toHaveLength(1);
      expect(result.relationshipProfile).toMatchObject({ sqlAvailable: true });
      expect(result.resolvedRelationships).toEqual([
        expect.objectContaining({
          status: 'accepted',
          from: expect.objectContaining({ table: expect.objectContaining({ name: 'orders' }), columns: ['account_id'] }),
          to: expect.objectContaining({ table: expect.objectContaining({ name: 'accounts' }), columns: ['id'] }),
        }),
      ]);
      expect(result.warnings).toContainEqual({
        code: 'scan_enrichment_backend_not_configured',
        message:
          'Skipping description and embedding enrichment because scan.enrichment.mode is not configured; relationship discovery still ran.',
        recoverable: true,
        metadata: {
          skippedStages: ['descriptions', 'embeddings'],
          relationshipDetection: true,
        },
      });
    } finally {
      executor.close();
    }
  });

  it('merges ai descriptions into the enriched relationship schema', () => {
    const schema = snapshotToKtxEnrichedSchema(snapshot, new Map(), [
      {
        table: { catalog: null, db: 'public', name: 'orders' },
        tableDescription: 'All customer orders',
        columnDescriptions: { customer_id: 'FK to the owning customer' },
      },
    ]);
    const orders = schema.tables.find((table) => table.ref.name === 'orders');
    expect(orders?.descriptions).toMatchObject({ db: 'Customer orders', ai: 'All customer orders' });
    expect(orders?.columns.find((column) => column.name === 'customer_id')?.descriptions).toMatchObject({
      db: 'Customer id',
      ai: 'FK to the owning customer',
    });
  });

  it('force-reruns a named stage past the completed-row short-circuit and leaves unselected stages untouched', async () => {
    const stateStore = memoryEnrichmentStateStore();
    const scanConnector = connector();
    const providers = {
      ...createDeterministicLocalScanEnrichmentProviders(),
      embedding: fakeScanEmbedding({ dimensions: 6 }),
    };
    const identity = {
      llmIdentity: { model: 'fake', baseUrlConfigured: false },
      embeddingIdentity: { model: 'fake-embed', dimensions: 6, batchSize: 64 },
    };

    await runLocalScanEnrichment({
      connectionId: 'warehouse',
      mode: 'enriched',
      detectRelationships: true,
      connector: scanConnector,
      context: { runId: 'force-1' },
      providers,
      stateStore,
      syncId: 'force-s1',
      ...identity,
    });

    const generateObject = vi.spyOn(providers.llmRuntime, 'generateObject');
    const embedBatch = vi.spyOn(providers.embedding, 'embedBatch');

    const rerun = await runLocalScanEnrichment({
      connectionId: 'warehouse',
      mode: 'enriched',
      detectRelationships: true,
      connector: scanConnector,
      context: { runId: 'force-2' },
      providers,
      stateStore,
      syncId: 'force-s2',
      stages: ['descriptions'],
      ...identity,
    });

    // Only descriptions ran, and it recomputed (not resumed) despite a matching
    // completed row; embeddings + relationships were left untouched.
    expect(rerun.state.completedStages).toEqual(['descriptions']);
    expect(rerun.state.resumedStages).toEqual([]);
    expect(generateObject).toHaveBeenCalled();
    expect(embedBatch).not.toHaveBeenCalled();
  });

  it('naming every stage forces a full recompute rather than a no-op resume', async () => {
    const stateStore = memoryEnrichmentStateStore();
    const scanConnector = connector();
    const providers = {
      ...createDeterministicLocalScanEnrichmentProviders(),
      embedding: fakeScanEmbedding({ dimensions: 6 }),
    };
    const identity = {
      llmIdentity: { model: 'fake', baseUrlConfigured: false },
      embeddingIdentity: { model: 'fake-embed', dimensions: 6, batchSize: 64 },
    };

    await runLocalScanEnrichment({
      connectionId: 'warehouse',
      mode: 'enriched',
      detectRelationships: true,
      connector: scanConnector,
      context: { runId: 'full-1' },
      providers,
      stateStore,
      syncId: 'full-s1',
      ...identity,
    });

    const generateObject = vi.spyOn(providers.llmRuntime, 'generateObject');
    const embedBatch = vi.spyOn(providers.embedding, 'embedBatch');

    const rerun = await runLocalScanEnrichment({
      connectionId: 'warehouse',
      mode: 'enriched',
      detectRelationships: true,
      connector: scanConnector,
      context: { runId: 'full-2' },
      providers,
      stateStore,
      syncId: 'full-s2',
      stages: ['descriptions', 'embeddings', 'relationships'],
      ...identity,
    });

    expect(rerun.state.resumedStages).toEqual([]);
    expect(rerun.state.completedStages).toEqual(['descriptions', 'embeddings', 'relationships']);
    expect(generateObject).toHaveBeenCalled();
    expect(embedBatch).toHaveBeenCalled();
  });

  it('isolates per-stage invalidation: changing the embedding identity re-runs only embeddings', async () => {
    const stateStore = memoryEnrichmentStateStore();
    const scanConnector = connector();
    const providers = {
      ...createDeterministicLocalScanEnrichmentProviders(),
      embedding: fakeScanEmbedding({ dimensions: 6 }),
    };
    const llmIdentity = { model: 'fake', baseUrlConfigured: false };

    await runLocalScanEnrichment({
      connectionId: 'warehouse',
      mode: 'enriched',
      detectRelationships: true,
      connector: scanConnector,
      context: { runId: 'iso-1' },
      providers,
      stateStore,
      syncId: 'iso-s1',
      llmIdentity,
      embeddingIdentity: { model: 'embed-v1', dimensions: 6, batchSize: 64 },
    });

    const generateObject = vi.spyOn(providers.llmRuntime, 'generateObject');
    const embedBatch = vi.spyOn(providers.embedding, 'embedBatch');

    const rerun = await runLocalScanEnrichment({
      connectionId: 'warehouse',
      mode: 'enriched',
      detectRelationships: true,
      connector: scanConnector,
      context: { runId: 'iso-2' },
      providers,
      stateStore,
      syncId: 'iso-s2',
      llmIdentity,
      embeddingIdentity: { model: 'embed-v2', dimensions: 6, batchSize: 64 },
    });

    // Only the embeddings hash moved: descriptions + relationships resume from
    // cache, embeddings recompute. No LLM description/proposal calls fire.
    expect(rerun.state.resumedStages).toEqual(['descriptions', 'relationships']);
    expect(rerun.state.completedStages).toEqual(['descriptions', 'embeddings', 'relationships']);
    expect(generateObject).not.toHaveBeenCalled();
    expect(embedBatch).toHaveBeenCalled();
  });

  it('warns when a selected stage cannot run because its prerequisite is missing', async () => {
    const result = await runLocalScanEnrichment({
      connectionId: 'warehouse',
      mode: 'enriched',
      detectRelationships: false,
      connector: connector(),
      context: { runId: 'prereq-1' },
      // No embedding provider configured.
      providers: createDeterministicLocalScanEnrichmentProviders(),
      stages: ['embeddings'],
      llmIdentity: { model: 'fake', baseUrlConfigured: false },
    });

    expect(result.summary.embeddings).toBe('skipped');
    expect(result.warnings).toContainEqual(
      expect.objectContaining({ code: 'enrichment_stage_skipped', metadata: { stage: 'embeddings' } }),
    );
  });

  it('feeds on-disk descriptions into the llmProposals prompt on a relationships-only run', async () => {
    const executor = new InMemorySqliteExecutor();
    try {
      executor.db.exec(`
        CREATE TABLE accounts (id INTEGER NOT NULL);
        CREATE TABLE orders (id INTEGER NOT NULL, account_id INTEGER NOT NULL);
        INSERT INTO accounts (id) VALUES (1), (2);
        INSERT INTO orders (id, account_id) VALUES (10, 1), (11, 1), (12, 2);
      `);
      const scanConnector = {
        ...connector(),
        driver: 'sqlite' as const,
        capabilities: createKtxConnectorCapabilities({ readOnlySql: true, columnStats: true }),
        introspect: vi.fn(async () => noDeclaredRelationshipSnapshot()),
        executeReadOnly: executor.executeReadOnly.bind(executor),
      };
      const providers = createDeterministicLocalScanEnrichmentProviders();
      const generateObject = vi.spyOn(providers.llmRuntime, 'generateObject');
      const onDiskDescriptions: Array<{
        table: { catalog: null; db: null; name: string };
        tableDescription: string | null;
        columnDescriptions: Record<string, string | null>;
      }> = [
        {
          table: { catalog: null, db: null, name: 'orders' },
          tableDescription: 'Customer purchase orders',
          columnDescriptions: { id: 'Order identifier', account_id: 'The owning account reference' },
        },
        {
          table: { catalog: null, db: null, name: 'accounts' },
          tableDescription: 'Account records',
          columnDescriptions: { id: 'Account identifier' },
        },
      ];

      await runLocalScanEnrichment({
        connectionId: 'warehouse',
        mode: 'enriched',
        detectRelationships: true,
        connector: scanConnector,
        context: { runId: 'rel-only-hydration' },
        providers,
        stages: ['relationships'],
        llmIdentity: { model: 'fake', baseUrlConfigured: false },
        loadPriorDescriptions: async () => onDiskDescriptions,
      });

      // The relationship-proposal prompt (the only generateObject calls on a
      // relationships-only run) carries the on-disk descriptions, not just names.
      const prompts = generateObject.mock.calls.map((call) => String((call[0] as { prompt: string }).prompt));
      expect(prompts.length).toBeGreaterThan(0);
      expect(prompts.some((prompt) => prompt.includes('The owning account reference'))).toBe(true);
    } finally {
      executor.close();
    }
  });

  it('resume record still skips already-enriched tables when a forced descriptions rerun re-enters compute', async () => {
    const stateStore = memoryEnrichmentStateStore();
    const scanConnector = connector();
    const providers = createDeterministicLocalScanEnrichmentProviders();
    const identity = { llmIdentity: { model: 'fake', baseUrlConfigured: false } };
    const resumeStore = {
      load: vi.fn(async () => [
        {
          table: { catalog: null, db: 'public', name: 'customers' },
          tableDescription: 'Recovered customers description',
          columnDescriptions: { id: 'Recovered id' },
        },
      ]),
      flush: vi.fn(async () => {}),
    };

    // Populate a completed descriptions row so a non-forced run would short-circuit.
    await runLocalScanEnrichment({
      connectionId: 'warehouse',
      mode: 'enriched',
      detectRelationships: false,
      connector: scanConnector,
      context: { runId: 'resume-force-1' },
      providers,
      stateStore,
      syncId: 'resume-force-s1',
      ...identity,
    });

    const generateObject = vi.spyOn(providers.llmRuntime, 'generateObject');
    const rerun = await runLocalScanEnrichment({
      connectionId: 'warehouse',
      mode: 'enriched',
      detectRelationships: false,
      connector: scanConnector,
      context: { runId: 'resume-force-2' },
      providers,
      stateStore,
      syncId: 'resume-force-s2',
      stages: ['descriptions'],
      descriptionResumeStore: resumeStore,
      ...identity,
    });

    // Forced compute re-entered, consulted the resume record, recovered
    // 'customers', and only re-issued the LLM for the un-recovered 'orders'.
    expect(resumeStore.load).toHaveBeenCalled();
    expect(generateObject).toHaveBeenCalledTimes(1);
    expect(rerun.descriptionUpdates.find((update) => update.table.name === 'customers')?.tableDescription).toBe(
      'Recovered customers description',
    );
    expect(rerun.state.resumedStages).toEqual([]);
  });

  it('resumes per table identity, re-enriching a same-named table in another schema', async () => {
    const multiSchemaSnapshot: KtxSchemaSnapshot = {
      connectionId: 'warehouse',
      driver: 'postgres',
      extractedAt: '2026-04-29T12:00:00.000Z',
      scope: { schemas: ['analytics', 'staging'] },
      metadata: {},
      tables: ['analytics', 'staging'].map((schema) => ({
        catalog: null,
        db: schema,
        name: 'orders',
        kind: 'table',
        comment: null,
        estimatedRows: 1,
        foreignKeys: [],
        columns: [
          {
            name: 'id',
            nativeType: 'integer',
            normalizedType: 'integer',
            dimensionType: 'number',
            nullable: false,
            primaryKey: true,
            comment: null,
          },
        ],
      })),
    };
    const scanConnector = connector();
    const providers = createDeterministicLocalScanEnrichmentProviders();
    const generateObject = vi.spyOn(providers.llmRuntime, 'generateObject');
    // Only the analytics.orders description was flushed before the interruption.
    const resumeStore = {
      load: vi.fn(async () => [
        {
          table: { catalog: null, db: 'analytics', name: 'orders' },
          tableDescription: 'Recovered analytics orders',
          columnDescriptions: { id: 'Recovered analytics id' },
        },
      ]),
      flush: vi.fn(async () => {}),
    };

    const result = await runLocalScanEnrichment({
      connectionId: 'warehouse',
      mode: 'enriched',
      detectRelationships: false,
      connector: scanConnector,
      snapshot: multiSchemaSnapshot,
      context: { runId: 'resume-identity' },
      providers,
      descriptionResumeStore: resumeStore,
      relationshipSettings: { ...buildDefaultKtxProjectConfig().scan.relationships, enabled: false },
    });

    // staging.orders is not recovered (different identity), so it is re-enriched
    // exactly once; analytics.orders keeps its recovered description.
    expect(generateObject).toHaveBeenCalledTimes(1);
    const analytics = result.descriptionUpdates.find((update) => update.table.db === 'analytics');
    const staging = result.descriptionUpdates.find((update) => update.table.db === 'staging');
    expect(analytics?.tableDescription).toBe('Recovered analytics orders');
    expect(staging?.tableDescription).not.toBe('Recovered analytics orders');
    expect(staging?.tableDescription).toBeTruthy();
  });

  it('flags an unselected stage stale when its inputs changed, names the cascade, and clears after re-running it', async () => {
    const stateStore = memoryEnrichmentStateStore();
    const scanConnector = connector();
    const providers = {
      ...createDeterministicLocalScanEnrichmentProviders(),
      embedding: fakeScanEmbedding({ dimensions: 6 }),
    };
    const llmIdentity = { model: 'fake', baseUrlConfigured: false };
    const embeddingV1 = { model: 'embed-v1', dimensions: 6, batchSize: 64 };
    const embeddingV2 = { model: 'embed-v2', dimensions: 6, batchSize: 64 };

    // Full run captures embeddings + relationships keyed on the v1 embedding model.
    const full = await runLocalScanEnrichment({
      connectionId: 'warehouse',
      mode: 'enriched',
      detectRelationships: true,
      connector: scanConnector,
      context: { runId: 'stale-1' },
      providers,
      stateStore,
      syncId: 'stale-s1',
      llmIdentity,
      embeddingIdentity: embeddingV1,
    });
    // Stand in for the persisted _schema so embeddings-only runs see the same
    // descriptions the descriptions stage produces (deterministic content).
    const loadPriorDescriptions = async () => full.descriptionUpdates;

    // The embedding model changed in config, but the operator re-ran only descriptions.
    const reDescribe = await runLocalScanEnrichment({
      connectionId: 'warehouse',
      mode: 'enriched',
      detectRelationships: true,
      connector: scanConnector,
      context: { runId: 'stale-2' },
      providers,
      stateStore,
      syncId: 'stale-s2',
      stages: ['descriptions'],
      loadPriorDescriptions,
      llmIdentity,
      embeddingIdentity: embeddingV2,
    });
    const stale = reDescribe.warnings.filter((warning) => warning.code === 'enrichment_stage_stale');
    expect(stale.map((warning) => warning.metadata?.stage)).toEqual(['embeddings']);
    expect(stale[0]?.message).toContain('--stages embeddings');

    // Re-embedding on v2 stores the fresh embeddings hash, clearing the staleness.
    await runLocalScanEnrichment({
      connectionId: 'warehouse',
      mode: 'enriched',
      detectRelationships: true,
      connector: scanConnector,
      context: { runId: 'stale-3' },
      providers,
      stateStore,
      syncId: 'stale-s3',
      stages: ['embeddings'],
      loadPriorDescriptions,
      llmIdentity,
      embeddingIdentity: embeddingV2,
    });
    const afterReembed = await runLocalScanEnrichment({
      connectionId: 'warehouse',
      mode: 'enriched',
      detectRelationships: true,
      connector: scanConnector,
      context: { runId: 'stale-4' },
      providers,
      stateStore,
      syncId: 'stale-s4',
      stages: ['descriptions'],
      loadPriorDescriptions,
      llmIdentity,
      embeddingIdentity: embeddingV2,
    });
    expect(afterReembed.warnings.filter((warning) => warning.code === 'enrichment_stage_stale')).toEqual([]);
  });

  const enrichedFixtureSnapshot = (): KtxSchemaSnapshot => ({
    connectionId: 'warehouse',
    driver: 'sqlite',
    extractedAt: '2026-05-07T00:00:00.000Z',
    scope: {},
    metadata: {},
    tables: [
      {
        catalog: null,
        db: null,
        name: 'accounts',
        kind: 'table',
        comment: 'DB accounts',
        estimatedRows: 2,
        foreignKeys: [],
        columns: [
          {
            name: 'id',
            nativeType: 'INTEGER',
            normalizedType: 'integer',
            dimensionType: 'number',
            nullable: false,
            primaryKey: false,
            comment: 'DB accounts id',
          },
        ],
      },
      {
        catalog: null,
        db: null,
        name: 'orders',
        kind: 'table',
        comment: 'DB orders',
        estimatedRows: 3,
        foreignKeys: [],
        columns: [
          {
            name: 'id',
            nativeType: 'INTEGER',
            normalizedType: 'integer',
            dimensionType: 'number',
            nullable: false,
            primaryKey: false,
            comment: 'DB orders id',
          },
          {
            name: 'account_id',
            nativeType: 'INTEGER',
            normalizedType: 'integer',
            dimensionType: 'number',
            nullable: false,
            primaryKey: false,
            comment: 'DB account ref',
          },
        ],
      },
    ],
  });

  const countKeyOccurrences = (text: string, key: string): number =>
    (text.match(new RegExp(`\\b${key}:`, 'g')) ?? []).length;

  // Regression (spec 21 defect, 2026-06-24): a --stages subset that omits a stage
  // must not delete that stage's on-disk artifacts from the written _schema.
  it('a --stages relationships run preserves on-disk descriptions while adding joins', async () => {
    const tempDir = await mkdtemp(join(tmpdir(), 'ktx-stage-preserve-rel-'));
    const executor = new InMemorySqliteExecutor();
    try {
      executor.db.exec(`
        CREATE TABLE accounts (id INTEGER NOT NULL);
        CREATE TABLE orders (id INTEGER NOT NULL, account_id INTEGER NOT NULL);
        INSERT INTO accounts (id) VALUES (1), (2);
        INSERT INTO orders (id, account_id) VALUES (10, 1), (11, 1), (12, 2);
      `);
      const project = await initKtxProject({ projectDir: join(tempDir, 'project') });
      const shardPath = 'semantic-layer/warehouse/_schema/public.yaml';
      // Enriched fixture: full ai + db descriptions, zero joins.
      await project.fileStore.writeFile(
        shardPath,
        YAML.stringify(
          {
            tables: {
              accounts: {
                table: 'accounts',
                descriptions: { ai: 'AI accounts table', db: 'DB accounts' },
                columns: [{ name: 'id', type: 'number', descriptions: { ai: 'AI accounts id', db: 'DB accounts id' } }],
              },
              orders: {
                table: 'orders',
                descriptions: { ai: 'AI orders table', db: 'DB orders' },
                columns: [
                  { name: 'id', type: 'number', descriptions: { ai: 'AI orders id', db: 'DB orders id' } },
                  { name: 'account_id', type: 'number', descriptions: { ai: 'AI account ref', db: 'DB account ref' } },
                ],
              },
            },
          },
          { indent: 2, lineWidth: 0 },
        ),
        'ktx',
        'ktx@example.com',
        'Seed enriched fixture',
      );
      const before = await readFile(join(project.projectDir, shardPath), 'utf-8');
      const aiBefore = countKeyOccurrences(before, 'ai');
      const dbBefore = countKeyOccurrences(before, 'db');
      expect(aiBefore).toBeGreaterThan(0);

      const scanConnector = {
        ...connector(),
        driver: 'sqlite' as const,
        capabilities: createKtxConnectorCapabilities({ readOnlySql: true, columnStats: true }),
        introspect: vi.fn(async () => enrichedFixtureSnapshot()),
        executeReadOnly: executor.executeReadOnly.bind(executor),
      };
      const result = await runLocalScanEnrichment({
        connectionId: 'warehouse',
        mode: 'enriched',
        detectRelationships: true,
        connector: scanConnector,
        context: { runId: 'preserve-rel-1' },
        providers: createDeterministicLocalScanEnrichmentProviders(),
        stages: ['relationships'],
        syncId: 'sync-preserve-rel',
        loadPriorDescriptions: (snap) => loadOnDiskDescriptionUpdates(project, 'warehouse', snap),
      });
      await writeLocalScanEnrichmentArtifacts({
        project,
        connectionId: 'warehouse',
        syncId: 'sync-preserve-rel',
        driver: 'sqlite',
        enrichment: result,
        dryRun: false,
      });

      const after = await readFile(join(project.projectDir, shardPath), 'utf-8');
      // Every prior ai:/db: description survived the relationships-only run...
      expect(countKeyOccurrences(after, 'ai')).toBe(aiBefore);
      expect(countKeyOccurrences(after, 'db')).toBe(dbBefore);
      expect(after).toContain('AI orders table');
      expect(after).toContain('AI account ref');
      // ...and the relationships stage actually added joins (it was 0 before).
      expect(result.relationships.accepted).toBeGreaterThan(0);
      const shard = YAML.parse(after) as { tables: Record<string, { joins?: unknown[] }> };
      expect(Object.values(shard.tables).some((table) => (table.joins ?? []).length > 0)).toBe(true);
    } finally {
      executor.close();
      await rm(tempDir, { recursive: true, force: true });
    }
  });

  it('a --stages descriptions run preserves on-disk joins while refreshing descriptions', async () => {
    const tempDir = await mkdtemp(join(tmpdir(), 'ktx-stage-preserve-desc-'));
    try {
      const project = await initKtxProject({ projectDir: join(tempDir, 'project') });
      const shardPath = 'semantic-layer/warehouse/_schema/public.yaml';
      // Fixture: an inferred join present, descriptions absent.
      await project.fileStore.writeFile(
        shardPath,
        YAML.stringify(
          {
            tables: {
              accounts: { table: 'accounts', columns: [{ name: 'id', type: 'number' }] },
              orders: {
                table: 'orders',
                columns: [
                  { name: 'id', type: 'number' },
                  { name: 'account_id', type: 'number' },
                ],
                joins: [
                  { to: 'accounts', on: 'orders.account_id = accounts.id', relationship: 'many_to_one', source: 'inferred' },
                ],
              },
            },
          },
          { indent: 2, lineWidth: 0 },
        ),
        'ktx',
        'ktx@example.com',
        'Seed joins fixture',
      );

      const scanConnector = {
        ...connector(),
        driver: 'sqlite' as const,
        introspect: vi.fn(async () => enrichedFixtureSnapshot()),
      };
      const result = await runLocalScanEnrichment({
        connectionId: 'warehouse',
        mode: 'enriched',
        detectRelationships: true,
        connector: scanConnector,
        context: { runId: 'preserve-desc-1' },
        providers: createDeterministicLocalScanEnrichmentProviders(),
        stages: ['descriptions'],
        syncId: 'sync-preserve-desc',
        loadPriorDescriptions: (snap) => loadOnDiskDescriptionUpdates(project, 'warehouse', snap),
      });
      await writeLocalScanEnrichmentArtifacts({
        project,
        connectionId: 'warehouse',
        syncId: 'sync-preserve-desc',
        driver: 'sqlite',
        enrichment: result,
        dryRun: false,
      });

      const after = await readFile(join(project.projectDir, shardPath), 'utf-8');
      const shard = YAML.parse(after) as {
        tables: Record<string, { joins?: Array<{ to: string; source: string }> }>;
      };
      // The inferred join survived the descriptions-only run...
      expect(shard.tables.orders?.joins?.some((join) => join.to === 'accounts' && join.source === 'inferred')).toBe(true);
      // ...and the descriptions stage (re)wrote ai descriptions.
      expect(countKeyOccurrences(after, 'ai')).toBeGreaterThan(0);
    } finally {
      await rm(tempDir, { recursive: true, force: true });
    }
  });
});
