import type { ContentResultCache, ContentResultCacheRecord } from '../cache/content-result-cache.js';
import { SqliteContentResultCache } from '../cache/sqlite-content-result-cache.js';
import type {
  KtxScanEnrichmentCompletedStage,
  KtxScanEnrichmentFailedStage,
  KtxScanEnrichmentStageLookup,
  KtxScanEnrichmentStageRecord,
  KtxScanEnrichmentStateStore,
} from './enrichment-state.js';
import { KTX_SCAN_ENRICHMENT_STAGES } from './enrichment-state.js';
import { KTX_SCAN_MODES } from './types.js';
import type { KtxScanEnrichmentStage, KtxScanMode } from './types.js';

export interface SqliteLocalScanEnrichmentStateStoreOptions {
  dbPath: string;
  cache?: ContentResultCache;
}

interface ScanStageMetadata {
  connectionId: string;
  syncId: string;
  mode: KtxScanMode;
  stage: KtxScanEnrichmentStage;
}

function namespace(stage: KtxScanEnrichmentStage): string {
  return `scan:${stage}`;
}

function metadataFor(input: {
  connectionId: string;
  syncId: string;
  mode: KtxScanMode;
  stage: KtxScanEnrichmentStage;
}): Record<string, unknown> {
  return {
    connectionId: input.connectionId,
    syncId: input.syncId,
    mode: input.mode,
    stage: input.stage,
  };
}

function isScanMode(value: unknown): value is KtxScanMode {
  return typeof value === 'string' && (KTX_SCAN_MODES as readonly string[]).includes(value);
}

function isScanEnrichmentStage(value: unknown): value is KtxScanEnrichmentStage {
  return typeof value === 'string' && (KTX_SCAN_ENRICHMENT_STAGES as readonly string[]).includes(value);
}

function parseMetadata(record: ContentResultCacheRecord): ScanStageMetadata {
  const { connectionId, syncId, mode, stage } = record.metadata as Partial<ScanStageMetadata>;
  if (typeof connectionId !== 'string' || typeof syncId !== 'string' || !isScanMode(mode) || !isScanEnrichmentStage(stage)) {
    throw new Error(`Invalid scan enrichment cache metadata for ${record.namespace}/${record.scopeKey}`);
  }
  return { connectionId, syncId, mode, stage };
}

function toScanRecord<TOutput = unknown>(record: ContentResultCacheRecord<TOutput>): KtxScanEnrichmentStageRecord<TOutput> {
  const metadata = parseMetadata(record);
  const base = {
    runId: record.runId,
    connectionId: metadata.connectionId,
    syncId: metadata.syncId,
    mode: metadata.mode,
    stage: metadata.stage,
    inputHash: record.inputHash,
    updatedAt: record.updatedAt,
  };
  if (record.status === 'completed') {
    return {
      ...base,
      status: 'completed',
      output: record.output,
      errorMessage: null,
    };
  }
  return {
    ...base,
    status: 'failed',
    output: null,
    errorMessage: record.errorMessage,
  };
}

export class SqliteLocalScanEnrichmentStateStore implements KtxScanEnrichmentStateStore {
  private readonly cache: ContentResultCache;

  constructor(options: SqliteLocalScanEnrichmentStateStoreOptions) {
    this.cache = options.cache ?? new SqliteContentResultCache({ dbPath: options.dbPath });
  }

  async findCompletedStage<TOutput = unknown>(
    input: KtxScanEnrichmentStageLookup,
  ): Promise<KtxScanEnrichmentCompletedStage<TOutput> | null> {
    const record = await this.cache.findCompletedResult<TOutput>({
      namespace: namespace(input.stage),
      scopeKey: input.connectionId,
      inputHash: input.inputHash,
    });
    return record ? (toScanRecord(record) as KtxScanEnrichmentCompletedStage<TOutput>) : null;
  }

  async findLatestCompletedStage(input: {
    connectionId: string;
    stage: KtxScanEnrichmentStage;
  }): Promise<KtxScanEnrichmentCompletedStage | null> {
    const record = await this.cache.findLatestCompletedResult({
      namespace: namespace(input.stage),
      scopeKey: input.connectionId,
    });
    return record ? (toScanRecord(record) as KtxScanEnrichmentCompletedStage) : null;
  }

  async saveCompletedStage<TOutput = unknown>(
    input: Omit<KtxScanEnrichmentCompletedStage<TOutput>, 'status' | 'errorMessage'>,
  ): Promise<void> {
    await this.cache.saveCompletedResult({
      runId: input.runId,
      namespace: namespace(input.stage),
      scopeKey: input.connectionId,
      inputHash: input.inputHash,
      output: input.output,
      metadata: metadataFor(input),
      updatedAt: input.updatedAt,
    });
  }

  async saveFailedStage(input: Omit<KtxScanEnrichmentFailedStage, 'status' | 'output'>): Promise<void> {
    await this.cache.saveFailedResult({
      runId: input.runId,
      namespace: namespace(input.stage),
      scopeKey: input.connectionId,
      inputHash: input.inputHash,
      errorMessage: input.errorMessage,
      metadata: metadataFor(input),
      updatedAt: input.updatedAt,
    });
  }

  async listRunStages(runId: string): Promise<KtxScanEnrichmentStageRecord[]> {
    const records = await this.cache.listRunResults(runId);
    return records
      .filter((record) => record.namespace.startsWith('scan:'))
      .map((record) => toScanRecord(record));
  }
}
