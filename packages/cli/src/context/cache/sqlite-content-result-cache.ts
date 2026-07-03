import { mkdirSync } from 'node:fs';
import { dirname } from 'node:path';
import Database from 'better-sqlite3';
import type {
  ContentResultCache,
  ContentResultCacheCompleted,
  ContentResultCacheFailed,
  ContentResultCacheLookup,
  ContentResultCacheRecord,
} from './content-result-cache.js';

export interface SqliteContentResultCacheOptions {
  dbPath: string;
}

interface ResultRow {
  run_id: string;
  namespace: string;
  scope_key: string;
  input_hash: string;
  status: 'completed' | 'failed';
  output_json: string | null;
  error_message: string | null;
  metadata_json: string;
  updated_at: string;
}

const RESULTS_TABLE = 'local_content_results';
const RESULTS_PRIMARY_KEY = ['namespace', 'scope_key', 'input_hash'] as const;

function isSafeRunId(runId: string): boolean {
  return /^[a-zA-Z0-9][a-zA-Z0-9_.-]*$/.test(runId);
}

function parseResultRow<TOutput = unknown>(row: ResultRow): ContentResultCacheRecord<TOutput> {
  const base = {
    runId: row.run_id,
    namespace: row.namespace,
    scopeKey: row.scope_key,
    inputHash: row.input_hash,
    metadata: JSON.parse(row.metadata_json || '{}') as Record<string, unknown>,
    updatedAt: row.updated_at,
  };
  if (row.status === 'completed') {
    return {
      ...base,
      status: 'completed',
      output: JSON.parse(row.output_json ?? 'null') as TOutput,
      errorMessage: null,
    };
  }
  return {
    ...base,
    status: 'failed',
    output: null,
    errorMessage: row.error_message ?? 'Unknown content result failure',
  };
}

export class SqliteContentResultCache implements ContentResultCache {
  private readonly db: Database.Database;

  constructor(options: SqliteContentResultCacheOptions) {
    mkdirSync(dirname(options.dbPath), { recursive: true });
    this.db = new Database(options.dbPath);
    this.db.pragma('journal_mode = WAL');
    this.db.exec('DROP TABLE IF EXISTS local_scan_enrichment_stages');
    this.dropResultsTableIfPrimaryKeyDiffers();
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS local_content_results (
        run_id TEXT NOT NULL,
        namespace TEXT NOT NULL,
        scope_key TEXT NOT NULL,
        input_hash TEXT NOT NULL,
        status TEXT NOT NULL,
        output_json TEXT,
        error_message TEXT,
        metadata_json TEXT NOT NULL,
        updated_at TEXT NOT NULL,
        PRIMARY KEY (namespace, scope_key, input_hash)
      );

      CREATE INDEX IF NOT EXISTS local_content_results_lookup_idx
        ON local_content_results (namespace, scope_key, input_hash, updated_at);
      CREATE INDEX IF NOT EXISTS local_content_results_run_idx
        ON local_content_results (run_id, updated_at, namespace);
    `);
  }

  private dropResultsTableIfPrimaryKeyDiffers(): void {
    const columns = this.db.prepare(`PRAGMA table_info(${RESULTS_TABLE})`).all() as Array<{
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
      primaryKey.length === RESULTS_PRIMARY_KEY.length &&
      primaryKey.every((name, index) => name === RESULTS_PRIMARY_KEY[index]);
    if (!matches) {
      this.db.exec(`DROP TABLE ${RESULTS_TABLE}`);
    }
  }

  async findCompletedResult<TOutput = unknown>(
    input: ContentResultCacheLookup,
  ): Promise<ContentResultCacheCompleted<TOutput> | null> {
    const row = this.db
      .prepare(
        `
        SELECT *
        FROM local_content_results
        WHERE namespace = ?
          AND scope_key = ?
          AND input_hash = ?
          AND status = 'completed'
        ORDER BY updated_at DESC
        LIMIT 1
      `,
      )
      .get(input.namespace, input.scopeKey, input.inputHash) as ResultRow | undefined;
    if (!row) {
      return null;
    }
    const parsed = parseResultRow<TOutput>(row);
    return parsed.status === 'completed' ? parsed : null;
  }

  async findLatestCompletedResult(input: {
    namespace: string;
    scopeKey: string;
  }): Promise<ContentResultCacheCompleted | null> {
    const row = this.db
      .prepare(
        `
        SELECT *
        FROM local_content_results
        WHERE namespace = ?
          AND scope_key = ?
          AND status = 'completed'
        ORDER BY updated_at DESC
        LIMIT 1
      `,
      )
      .get(input.namespace, input.scopeKey) as ResultRow | undefined;
    if (!row) {
      return null;
    }
    const parsed = parseResultRow(row);
    return parsed.status === 'completed' ? parsed : null;
  }

  async saveCompletedResult<TOutput = unknown>(
    input: Omit<ContentResultCacheCompleted<TOutput>, 'status' | 'errorMessage'>,
  ): Promise<void> {
    this.db
      .prepare(
        `
        INSERT INTO local_content_results (
          run_id,
          namespace,
          scope_key,
          input_hash,
          status,
          output_json,
          error_message,
          metadata_json,
          updated_at
        )
        VALUES (
          @runId,
          @namespace,
          @scopeKey,
          @inputHash,
          'completed',
          @outputJson,
          NULL,
          @metadataJson,
          @updatedAt
        )
        ON CONFLICT(namespace, scope_key, input_hash) DO UPDATE SET
          run_id = excluded.run_id,
          status = excluded.status,
          output_json = excluded.output_json,
          error_message = excluded.error_message,
          metadata_json = excluded.metadata_json,
          updated_at = excluded.updated_at
      `,
      )
      .run({
        runId: input.runId,
        namespace: input.namespace,
        scopeKey: input.scopeKey,
        inputHash: input.inputHash,
        outputJson: JSON.stringify(input.output),
        metadataJson: JSON.stringify(input.metadata),
        updatedAt: input.updatedAt,
      });
  }

  async saveFailedResult(input: Omit<ContentResultCacheFailed, 'status' | 'output'>): Promise<void> {
    this.db
      .prepare(
        `
        INSERT INTO local_content_results (
          run_id,
          namespace,
          scope_key,
          input_hash,
          status,
          output_json,
          error_message,
          metadata_json,
          updated_at
        )
        VALUES (
          @runId,
          @namespace,
          @scopeKey,
          @inputHash,
          'failed',
          NULL,
          @errorMessage,
          @metadataJson,
          @updatedAt
        )
        ON CONFLICT(namespace, scope_key, input_hash) DO UPDATE SET
          run_id = excluded.run_id,
          status = excluded.status,
          output_json = excluded.output_json,
          error_message = excluded.error_message,
          metadata_json = excluded.metadata_json,
          updated_at = excluded.updated_at
      `,
      )
      .run({
        runId: input.runId,
        namespace: input.namespace,
        scopeKey: input.scopeKey,
        inputHash: input.inputHash,
        errorMessage: input.errorMessage,
        metadataJson: JSON.stringify(input.metadata),
        updatedAt: input.updatedAt,
      });
  }

  async deleteResult(input: ContentResultCacheLookup): Promise<void> {
    this.db
      .prepare(
        `
        DELETE FROM local_content_results
        WHERE namespace = ?
          AND scope_key = ?
          AND input_hash = ?
      `,
      )
      .run(input.namespace, input.scopeKey, input.inputHash);
  }

  async listRunResults(runId: string): Promise<ContentResultCacheRecord[]> {
    if (!isSafeRunId(runId)) {
      return [];
    }
    const rows = this.db
      .prepare(
        `
        SELECT *
        FROM local_content_results
        WHERE run_id = ?
        ORDER BY updated_at ASC, namespace ASC
      `,
      )
      .all(runId) as ResultRow[];
    return rows.map((row) => parseResultRow(row));
  }
}
