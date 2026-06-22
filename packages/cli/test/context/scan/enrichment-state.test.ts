import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import Database from 'better-sqlite3';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import {
  completedKtxScanEnrichmentStateSummary,
  computeKtxScanEnrichmentInputHash,
  summarizeKtxScanEnrichmentState,
} from '../../../src/context/scan/enrichment-state.js';
import { SqliteLocalScanEnrichmentStateStore } from '../../../src/context/scan/sqlite-local-enrichment-state-store.js';
import type { KtxSchemaSnapshot } from '../../../src/context/scan/types.js';

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

  it('computes stable input hashes without depending on object key order', () => {
    const first = computeKtxScanEnrichmentInputHash({
      snapshot,
      mode: 'enriched',
      detectRelationships: true,
      providerIdentity: { provider: 'local-heuristic', llmModel: 'a' },
    });
    const second = computeKtxScanEnrichmentInputHash({
      snapshot: { ...snapshot, metadata: {} },
      mode: 'enriched',
      detectRelationships: true,
      providerIdentity: { llmModel: 'a', provider: 'local-heuristic' },
    });
    const firstTable = snapshot.tables[0];
    if (!firstTable) {
      throw new Error('Expected test snapshot table');
    }
    const changed = computeKtxScanEnrichmentInputHash({
      snapshot: { ...snapshot, tables: [{ ...firstTable, name: 'orders_v2' }] },
      mode: 'enriched',
      detectRelationships: true,
      providerIdentity: { provider: 'local-heuristic', llmModel: 'a' },
    });

    expect(first).toMatch(/^[a-f0-9]{64}$/);
    expect(second).toBe(first);
    expect(changed).not.toBe(first);
  });

  it('persists completed stages and ignores stale hashes', async () => {
    const inputHash = computeKtxScanEnrichmentInputHash({
      snapshot,
      mode: 'enriched',
      detectRelationships: true,
      providerIdentity: { provider: 'local-heuristic' },
    });

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
    const inputHash = computeKtxScanEnrichmentInputHash({
      snapshot,
      mode: 'enriched',
      detectRelationships: true,
      providerIdentity: { provider: 'local-heuristic' },
    });

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

  it('recreates the resume cache when an older primary key shape is found', async () => {
    const dbPath = join(tempDir, 'legacy.sqlite');
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
        PRIMARY KEY (run_id, stage)
      );
      INSERT INTO local_scan_enrichment_stages
        VALUES ('old-run', 'descriptions', 'hash', 'warehouse', 'sync', 'enriched', 'completed', 'null', NULL, '2026-01-01T00:00:00.000Z');
    `);
    legacy.close();

    const recreated = new SqliteLocalScanEnrichmentStateStore({ dbPath });
    // The legacy row is dropped with the old table; the new key shape is in
    // force, so a fresh save + lookup round-trips cleanly.
    await recreated.saveCompletedStage({
      runId: 'new-run',
      connectionId: 'warehouse',
      syncId: 'sync',
      mode: 'enriched',
      stage: 'descriptions',
      inputHash: 'hash',
      output: ['fresh'],
      updatedAt: '2026-02-01T00:00:00.000Z',
    });
    await expect(
      recreated.findCompletedStage({ connectionId: 'warehouse', stage: 'descriptions', inputHash: 'hash' }),
    ).resolves.toMatchObject({ runId: 'new-run', output: ['fresh'] });
    await expect(recreated.listRunStages('old-run')).resolves.toEqual([]);
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
