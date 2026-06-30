import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import Database from 'better-sqlite3';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import {
  completedKtxScanEnrichmentStateSummary,
  computeKtxDescriptionsStageHash,
  computeKtxEmbeddingsStageHash,
  computeKtxRelationshipsStageHash,
  computeKtxScanDescriptionDigest,
  type KtxScanEmbeddingIdentity,
  type KtxScanLlmIdentity,
  summarizeKtxScanEnrichmentState,
} from '../../../src/context/scan/enrichment-state.js';
import { SqliteLocalScanEnrichmentStateStore } from '../../../src/context/scan/sqlite-local-enrichment-state-store.js';
import { buildDefaultKtxProjectConfig } from '../../../src/context/project/config.js';
import type { KtxSchemaSnapshot } from '../../../src/context/scan/types.js';

const llmIdentity: KtxScanLlmIdentity = { model: 'opus', baseUrlConfigured: false };
const embeddingIdentity: KtxScanEmbeddingIdentity = { model: 'minilm', dimensions: 384, batchSize: 64 };
const relationshipSettings = buildDefaultKtxProjectConfig().scan.relationships;

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
    },
  ],
};

describe('scan enrichment state', () => {
  let tempDir: string;
  let store: SqliteLocalScanEnrichmentStateStore;

  beforeEach(async () => {
    tempDir = await mkdtemp(join(tmpdir(), 'ktx-scan-enrichment-state-'));
    store = new SqliteLocalScanEnrichmentStateStore({ dbPath: join(tempDir, 'db.sqlite') });
  });

  afterEach(async () => {
    await rm(tempDir, { recursive: true, force: true });
  });

  it('computes stable per-stage hashes without depending on object key order', () => {
    const first = computeKtxDescriptionsStageHash({ snapshot, llmIdentity });
    const second = computeKtxDescriptionsStageHash({
      snapshot: { ...snapshot, metadata: {} },
      llmIdentity: { baseUrlConfigured: false, model: 'opus' },
    });
    const firstTable = snapshot.tables[0];
    if (!firstTable) {
      throw new Error('Expected test snapshot table');
    }
    const changed = computeKtxDescriptionsStageHash({
      snapshot: { ...snapshot, tables: [{ ...firstTable, name: 'orders_v2' }] },
      llmIdentity,
    });

    expect(first).toMatch(/^[a-f0-9]{64}$/);
    expect(second).toBe(first);
    expect(changed).not.toBe(first);
  });

  it('isolates per-stage invalidation: one input changes only its own stage', () => {
    const descriptionDigest = computeKtxScanDescriptionDigest(['orders.id (integer)']);
    const descriptions = computeKtxDescriptionsStageHash({ snapshot, llmIdentity });
    const embeddings = computeKtxEmbeddingsStageHash({ snapshot, embeddingIdentity, descriptionDigest });
    const relationships = computeKtxRelationshipsStageHash({ snapshot, relationshipSettings, llmIdentity });

    // Switching the description LLM re-keys descriptions + relationships (both
    // depend on llmIdentity) but NOT embeddings.
    const otherLlm: KtxScanLlmIdentity = { model: 'sonnet', baseUrlConfigured: false };
    expect(computeKtxDescriptionsStageHash({ snapshot, llmIdentity: otherLlm })).not.toBe(descriptions);
    expect(computeKtxRelationshipsStageHash({ snapshot, relationshipSettings, llmIdentity: otherLlm })).not.toBe(
      relationships,
    );
    expect(computeKtxEmbeddingsStageHash({ snapshot, embeddingIdentity, descriptionDigest })).toBe(embeddings);

    // Swapping the embeddings model re-keys only embeddings.
    const otherEmbedding: KtxScanEmbeddingIdentity = { model: 'mpnet', dimensions: 768, batchSize: 64 };
    expect(computeKtxEmbeddingsStageHash({ snapshot, embeddingIdentity: otherEmbedding, descriptionDigest })).not.toBe(
      embeddings,
    );
    expect(computeKtxDescriptionsStageHash({ snapshot, llmIdentity })).toBe(descriptions);
    expect(computeKtxRelationshipsStageHash({ snapshot, relationshipSettings, llmIdentity })).toBe(relationships);

    // A description-content change (new digest) re-keys only embeddings;
    // relationships are deliberately decoupled from description content (D5).
    const otherDigest = computeKtxScanDescriptionDigest(['orders.id (integer). A primary key.']);
    expect(computeKtxEmbeddingsStageHash({ snapshot, embeddingIdentity, descriptionDigest: otherDigest })).not.toBe(
      embeddings,
    );
    expect(computeKtxRelationshipsStageHash({ snapshot, relationshipSettings, llmIdentity })).toBe(relationships);

    // Flipping llmProposals re-keys only relationships.
    const otherRelationships = { ...relationshipSettings, llmProposals: !relationshipSettings.llmProposals };
    expect(
      computeKtxRelationshipsStageHash({ snapshot, relationshipSettings: otherRelationships, llmIdentity }),
    ).not.toBe(relationships);
    expect(computeKtxDescriptionsStageHash({ snapshot, llmIdentity })).toBe(descriptions);
    expect(computeKtxEmbeddingsStageHash({ snapshot, embeddingIdentity, descriptionDigest })).toBe(embeddings);
  });

  it('persists completed stages and ignores stale hashes', async () => {
    const inputHash = computeKtxDescriptionsStageHash({ snapshot, llmIdentity });

    await store.saveCompletedStage({
      runId: 'scan-run-1',
      connectionId: 'warehouse',
      syncId: 'sync-1',
      mode: 'enriched',
      stage: 'descriptions',
      inputHash,
      output: [{ table: { catalog: null, db: 'public', name: 'orders' }, tableDescription: 'Orders' }],
      updatedAt: '2026-04-29T12:01:00.000Z',
    });

    await expect(
      store.findCompletedStage({
        connectionId: 'warehouse',
        stage: 'descriptions',
        inputHash,
      }),
    ).resolves.toMatchObject({
      runId: 'scan-run-1',
      stage: 'descriptions',
      status: 'completed',
      output: [{ table: { catalog: null, db: 'public', name: 'orders' }, tableDescription: 'Orders' }],
    });

    await expect(
      store.findCompletedStage({
        connectionId: 'warehouse',
        stage: 'descriptions',
        inputHash: 'different-hash',
      }),
    ).resolves.toBeNull();
  });

  it('resolves a completed stage across a fresh run id by content identity', async () => {
    const inputHash = computeKtxDescriptionsStageHash({ snapshot, llmIdentity });

    await store.saveCompletedStage({
      runId: 'scan-run-first',
      connectionId: 'warehouse',
      syncId: 'sync-first',
      mode: 'enriched',
      stage: 'descriptions',
      inputHash,
      output: [{ table: { catalog: null, db: 'public', name: 'orders' }, tableDescription: 'first' }],
      updatedAt: '2026-04-29T12:00:00.000Z',
    });
    // A later run with the SAME content identity overwrites in place (the
    // primary key no longer includes run_id), and the lookup resolves it
    // without ever knowing the run id that produced it.
    await store.saveCompletedStage({
      runId: 'scan-run-second',
      connectionId: 'warehouse',
      syncId: 'sync-second',
      mode: 'enriched',
      stage: 'descriptions',
      inputHash,
      output: [{ table: { catalog: null, db: 'public', name: 'orders' }, tableDescription: 'second' }],
      updatedAt: '2026-04-29T12:05:00.000Z',
    });

    const resolved = await store.findCompletedStage({
      connectionId: 'warehouse',
      stage: 'descriptions',
      inputHash,
    });
    expect(resolved?.runId).toBe('scan-run-second');
    expect(resolved?.output).toEqual([
      { table: { catalog: null, db: 'public', name: 'orders' }, tableDescription: 'second' },
    ]);
  });

  it('records failed stages without making them reusable', async () => {
    await store.saveFailedStage({
      runId: 'scan-run-2',
      connectionId: 'warehouse',
      syncId: 'sync-2',
      mode: 'enriched',
      stage: 'embeddings',
      inputHash: 'hash-2',
      errorMessage: 'embedding service timed out',
      updatedAt: '2026-04-29T12:02:00.000Z',
    });

    await expect(
      store.findCompletedStage({
        connectionId: 'warehouse',
        stage: 'embeddings',
        inputHash: 'hash-2',
      }),
    ).resolves.toBeNull();

    await expect(store.listRunStages('scan-run-2')).resolves.toEqual([
      expect.objectContaining({
        runId: 'scan-run-2',
        stage: 'embeddings',
        status: 'failed',
        errorMessage: 'embedding service timed out',
      }),
    ]);
  });

  it('round-trips a relationships-mode stage through listRunStages', async () => {
    // A relationships-mode scan persists the relationships stage with
    // mode 'relationships'; listRunStages must accept it, not reject it as
    // invalid metadata (the mode allowlist once omitted 'relationships').
    await store.saveCompletedStage({
      runId: 'scan-run-rel',
      connectionId: 'warehouse',
      syncId: 'sync-rel',
      mode: 'relationships',
      stage: 'relationships',
      inputHash: 'rel-hash',
      output: { relationshipUpdate: null },
      updatedAt: '2026-04-29T12:03:00.000Z',
    });

    await expect(store.listRunStages('scan-run-rel')).resolves.toEqual([
      expect.objectContaining({
        runId: 'scan-run-rel',
        syncId: 'sync-rel',
        mode: 'relationships',
        stage: 'relationships',
        status: 'completed',
      }),
    ]);
  });

  it('uses the shared content-result cache and ignores the obsolete scan-specific table', async () => {
    const dbPath = join(tempDir, 'shared.sqlite');
    const legacy = new Database(dbPath);
    legacy.exec(`
      CREATE TABLE local_scan_enrichment_stages (
        run_id TEXT NOT NULL,
        stage TEXT NOT NULL,
        input_hash TEXT NOT NULL,
        connection_id TEXT NOT NULL,
        sync_id TEXT NOT NULL,
        mode TEXT NOT NULL,
        status TEXT NOT NULL,
        output_json TEXT,
        error_message TEXT,
        updated_at TEXT NOT NULL,
        PRIMARY KEY (connection_id, stage, input_hash)
      );
      INSERT INTO local_scan_enrichment_stages
        VALUES ('old-run', 'descriptions', 'hash', 'warehouse', 'sync', 'enriched', 'completed', 'null', NULL, '2026-01-01T00:00:00.000Z');
    `);
    legacy.close();

    const recreated = new SqliteLocalScanEnrichmentStateStore({ dbPath });
    await recreated.saveCompletedStage({
      runId: 'new-run',
      connectionId: 'warehouse',
      syncId: 'sync',
      mode: 'enriched',
      stage: 'descriptions',
      inputHash: 'hash',
      output: ['fresh'],
      updatedAt: '2026-06-25T00:00:00.000Z',
    });

    await expect(
      recreated.findCompletedStage({ connectionId: 'warehouse', stage: 'descriptions', inputHash: 'hash' }),
    ).resolves.toMatchObject({ runId: 'new-run', output: ['fresh'] });
    await expect(recreated.listRunStages('old-run')).resolves.toEqual([]);
  });

  it('lists scan stages through the shared cache metadata', async () => {
    await store.saveCompletedStage({
      runId: 'scan-run-shared',
      connectionId: 'warehouse',
      syncId: 'sync-shared',
      mode: 'enriched',
      stage: 'relationships',
      inputHash: 'relationship-hash',
      output: { accepted: [] },
      updatedAt: '2026-06-25T00:00:00.000Z',
    });

    await expect(store.listRunStages('scan-run-shared')).resolves.toEqual([
      expect.objectContaining({
        runId: 'scan-run-shared',
        connectionId: 'warehouse',
        syncId: 'sync-shared',
        mode: 'enriched',
        stage: 'relationships',
        inputHash: 'relationship-hash',
        status: 'completed',
        output: { accepted: [] },
      }),
    ]);
  });

  it('summarizes resumed, completed, and failed stages for reports', () => {
    expect(
      summarizeKtxScanEnrichmentState({
        resumedStages: ['descriptions'],
        completedStages: ['descriptions', 'embeddings'],
        failedStages: ['relationships'],
      }),
    ).toEqual({
      resumedStages: ['descriptions'],
      completedStages: ['descriptions', 'embeddings'],
      failedStages: ['relationships'],
    });

    expect(completedKtxScanEnrichmentStateSummary()).toEqual({
      resumedStages: [],
      completedStages: [],
      failedStages: [],
    });
  });
});
