import { mkdirSync } from 'node:fs';
import { dirname } from 'node:path';
import Database from 'better-sqlite3';
import type {
  KtxScanEnrichmentCompletedStage,
  KtxScanEnrichmentFailedStage,
  KtxScanEnrichmentStageLookup,
  KtxScanEnrichmentStageRecord,
  KtxScanEnrichmentStateStore,
} from './enrichment-state.js';
import type { KtxScanEnrichmentStage, KtxScanMode } from './types.js';

export interface SqliteLocalScanEnrichmentStateStoreOptions {
  dbPath: string;
}

interface StageRow {
  run_id: string;
  connection_id: string;
  sync_id: string;
  mode: KtxScanMode;
  stage: KtxScanEnrichmentStage;
  input_hash: string;
  status: 'completed' | 'failed';
  output_json: string | null;
  error_message: string | null;
  updated_at: string;
}

function parseStageRow<TOutput = unknown>(row: StageRow): KtxScanEnrichmentStageRecord<TOutput> {
  if (row.status === 'completed') {
    return {
      runId: row.run_id,
      connectionId: row.connection_id,
      syncId: row.sync_id,
      mode: row.mode,
      stage: row.stage,
      inputHash: row.input_hash,
      status: 'completed',
      output: JSON.parse(row.output_json ?? 'null') as TOutput,
      errorMessage: null,
      updatedAt: row.updated_at,
    };
  }

  return {
    runId: row.run_id,
    connectionId: row.connection_id,
    syncId: row.sync_id,
    mode: row.mode,
    stage: row.stage,
    inputHash: row.input_hash,
    status: 'failed',
    output: null,
    errorMessage: row.error_message ?? 'Unknown enrichment stage failure',
    updatedAt: row.updated_at,
  };
}

function isSafeRunId(runId: string): boolean {
  return /^[a-zA-Z0-9][a-zA-Z0-9_.-]*$/.test(runId);
}

const STAGES_TABLE = 'local_scan_enrichment_stages';
const STAGES_PRIMARY_KEY = ['connection_id', 'stage', 'input_hash'] as const;

export class SqliteLocalScanEnrichmentStateStore implements KtxScanEnrichmentStateStore {
  private readonly db: Database.Database;

  constructor(options: SqliteLocalScanEnrichmentStateStoreOptions) {
    mkdirSync(dirname(options.dbPath), { recursive: true });
    this.db = new Database(options.dbPath);
    this.db.pragma('journal_mode = WAL');
    // Disposable local resume cache: if a prior ktx wrote the table with a
    // different primary key, drop it rather than migrate. Losing it only means
    // one ingest cannot resume; it never corrupts a queryable artifact.
    this.dropStagesTableIfPrimaryKeyDiffers();
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS local_scan_enrichment_stages (
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

      CREATE INDEX IF NOT EXISTS local_scan_enrichment_stages_content_idx
        ON local_scan_enrichment_stages (connection_id, stage, input_hash, updated_at);
      CREATE INDEX IF NOT EXISTS local_scan_enrichment_stages_run_idx
        ON local_scan_enrichment_stages (run_id, updated_at, stage);
    `);
  }

  private dropStagesTableIfPrimaryKeyDiffers(): void {
    const columns = this.db.prepare(`PRAGMA table_info(${STAGES_TABLE})`).all() as Array<{
      name: string;
      pk: number;
    }>;
    if (columns.length === 0) {
      return;
    }
    const primaryKey = columns
      .filter((column) => column.pk > 0)
      .sort((left, right) => left.pk - right.pk)
      .map((column) => column.name);
    const matches =
      primaryKey.length === STAGES_PRIMARY_KEY.length &&
      primaryKey.every((name, index) => name === STAGES_PRIMARY_KEY[index]);
    if (!matches) {
      this.db.exec(`DROP TABLE ${STAGES_TABLE}`);
    }
  }

  async findCompletedStage<TOutput = unknown>(
    input: KtxScanEnrichmentStageLookup,
  ): Promise<KtxScanEnrichmentCompletedStage<TOutput> | null> {
    const row = this.db
      .prepare(
        `
        SELECT *
        FROM local_scan_enrichment_stages
        WHERE connection_id = ?
          AND stage = ?
          AND input_hash = ?
          AND status = 'completed'
        ORDER BY updated_at DESC
        LIMIT 1
      `,
      )
      .get(input.connectionId, input.stage, input.inputHash) as StageRow | undefined;

    if (!row) {
      return null;
    }
    const parsed = parseStageRow<TOutput>(row);
    return parsed.status === 'completed' ? parsed : null;
  }

  async findLatestCompletedStage(input: {
    connectionId: string;
    stage: KtxScanEnrichmentStage;
  }): Promise<KtxScanEnrichmentCompletedStage | null> {
    const row = this.db
      .prepare(
        `
        SELECT *
        FROM local_scan_enrichment_stages
        WHERE connection_id = ?
          AND stage = ?
          AND status = 'completed'
        ORDER BY updated_at DESC
        LIMIT 1
      `,
      )
      .get(input.connectionId, input.stage) as StageRow | undefined;

    if (!row) {
      return null;
    }
    const parsed = parseStageRow(row);
    return parsed.status === 'completed' ? parsed : null;
  }

  async saveCompletedStage<TOutput = unknown>(
    input: Omit<KtxScanEnrichmentCompletedStage<TOutput>, 'status' | 'errorMessage'>,
  ): Promise<void> {
    this.db
      .prepare(
        `
        INSERT INTO local_scan_enrichment_stages (
          run_id,
          stage,
          input_hash,
          connection_id,
          sync_id,
          mode,
          status,
          output_json,
          error_message,
          updated_at
        )
        VALUES (
          @runId,
          @stage,
          @inputHash,
          @connectionId,
          @syncId,
          @mode,
          'completed',
          @outputJson,
          NULL,
          @updatedAt
        )
        ON CONFLICT(connection_id, stage, input_hash) DO UPDATE SET
          run_id = excluded.run_id,
          sync_id = excluded.sync_id,
          mode = excluded.mode,
          status = excluded.status,
          output_json = excluded.output_json,
          error_message = excluded.error_message,
          updated_at = excluded.updated_at
      `,
      )
      .run({
        runId: input.runId,
        stage: input.stage,
        inputHash: input.inputHash,
        connectionId: input.connectionId,
        syncId: input.syncId,
        mode: input.mode,
        outputJson: JSON.stringify(input.output),
        updatedAt: input.updatedAt,
      });
  }

  async saveFailedStage(input: Omit<KtxScanEnrichmentFailedStage, 'status' | 'output'>): Promise<void> {
    this.db
      .prepare(
        `
        INSERT INTO local_scan_enrichment_stages (
          run_id,
          stage,
          input_hash,
          connection_id,
          sync_id,
          mode,
          status,
          output_json,
          error_message,
          updated_at
        )
        VALUES (
          @runId,
          @stage,
          @inputHash,
          @connectionId,
          @syncId,
          @mode,
          'failed',
          NULL,
          @errorMessage,
          @updatedAt
        )
        ON CONFLICT(connection_id, stage, input_hash) DO UPDATE SET
          run_id = excluded.run_id,
          sync_id = excluded.sync_id,
          mode = excluded.mode,
          status = excluded.status,
          output_json = excluded.output_json,
          error_message = excluded.error_message,
          updated_at = excluded.updated_at
      `,
      )
      .run({
        runId: input.runId,
        stage: input.stage,
        inputHash: input.inputHash,
        connectionId: input.connectionId,
        syncId: input.syncId,
        mode: input.mode,
        errorMessage: input.errorMessage,
        updatedAt: input.updatedAt,
      });
  }

  async listRunStages(runId: string): Promise<KtxScanEnrichmentStageRecord[]> {
    if (!isSafeRunId(runId)) {
      return [];
    }
    const rows = this.db
      .prepare(
        `
        SELECT *
        FROM local_scan_enrichment_stages
        WHERE run_id = ?
        ORDER BY updated_at ASC, stage ASC
      `,
      )
      .all(runId) as StageRow[];
    return rows.map((row) => parseStageRow(row));
  }
}
