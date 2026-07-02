import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import Database from 'better-sqlite3';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { stableContentHash } from '../../../src/context/cache/content-result-cache.js';
import { SqliteContentResultCache } from '../../../src/context/cache/sqlite-content-result-cache.js';

describe('content result cache', () => {
  let tempDir: string;
  let cache: SqliteContentResultCache;

  beforeEach(async () => {
    tempDir = await mkdtemp(join(tmpdir(), 'ktx-content-result-cache-'));
    cache = new SqliteContentResultCache({ dbPath: join(tempDir, 'db.sqlite') });
  });

  afterEach(async () => {
    await rm(tempDir, { recursive: true, force: true });
  });

  it('computes stable hashes independent of object key order', () => {
    const first = stableContentHash({ b: ['two', { z: 1, a: true }], a: 'one' });
    const second = stableContentHash({ a: 'one', b: ['two', { a: true, z: 1 }] });

    expect(first).toMatch(/^[a-f0-9]{64}$/);
    expect(second).toBe(first);
  });

  it('persists completed results by namespace, scope, and input hash', async () => {
    await cache.saveCompletedResult({
      runId: 'run-1',
      namespace: 'scan:descriptions',
      scopeKey: 'warehouse',
      inputHash: 'hash-1',
      output: { rows: 3 },
      metadata: { syncId: 'sync-1', mode: 'enriched' },
      updatedAt: '2026-06-25T10:00:00.000Z',
    });

    await expect(
      cache.findCompletedResult<{ rows: number }>({
        namespace: 'scan:descriptions',
        scopeKey: 'warehouse',
        inputHash: 'hash-1',
      }),
    ).resolves.toMatchObject({
      runId: 'run-1',
      namespace: 'scan:descriptions',
      scopeKey: 'warehouse',
      inputHash: 'hash-1',
      status: 'completed',
      output: { rows: 3 },
      metadata: { syncId: 'sync-1', mode: 'enriched' },
    });

    await expect(
      cache.findCompletedResult({
        namespace: 'scan:descriptions',
        scopeKey: 'warehouse',
        inputHash: 'hash-2',
      }),
    ).resolves.toBeNull();
  });

  it('records failed results without making them reusable', async () => {
    await cache.saveFailedResult({
      runId: 'run-2',
      namespace: 'scan:embeddings',
      scopeKey: 'warehouse',
      inputHash: 'hash-2',
      errorMessage: 'embedding service timed out',
      metadata: { syncId: 'sync-2', mode: 'enriched' },
      updatedAt: '2026-06-25T10:01:00.000Z',
    });

    await expect(
      cache.findCompletedResult({
        namespace: 'scan:embeddings',
        scopeKey: 'warehouse',
        inputHash: 'hash-2',
      }),
    ).resolves.toBeNull();

    await expect(cache.listRunResults('run-2')).resolves.toEqual([
      expect.objectContaining({
        runId: 'run-2',
        namespace: 'scan:embeddings',
        status: 'failed',
        errorMessage: 'embedding service timed out',
      }),
    ]);
  });

  it('drops the obsolete scan-specific cache table when opening the shared cache', async () => {
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
        PRIMARY KEY (connection_id, stage, input_hash)
      );
      INSERT INTO local_scan_enrichment_stages
        VALUES ('old-run', 'descriptions', 'hash', 'warehouse', 'sync', 'enriched', 'completed', 'null', NULL, '2026-01-01T00:00:00.000Z');
    `);
    legacy.close();

    const reopened = new SqliteContentResultCache({ dbPath });
    await reopened.saveCompletedResult({
      runId: 'new-run',
      namespace: 'scan:descriptions',
      scopeKey: 'warehouse',
      inputHash: 'hash',
      output: ['fresh'],
      metadata: { syncId: 'sync', mode: 'enriched' },
      updatedAt: '2026-06-25T10:02:00.000Z',
    });

    const db = new Database(dbPath, { readonly: true });
    const legacyRow = db
      .prepare(
        "SELECT name FROM sqlite_master WHERE type = 'table' AND name = 'local_scan_enrichment_stages'",
      )
      .get();
    db.close();

    expect(legacyRow).toBeUndefined();
    await expect(
      reopened.findCompletedResult({
        namespace: 'scan:descriptions',
        scopeKey: 'warehouse',
        inputHash: 'hash',
      }),
    ).resolves.toMatchObject({ runId: 'new-run', output: ['fresh'] });
  });
});
