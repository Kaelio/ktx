import { stableContentHash } from '../cache/content-result-cache.js';
import type { KtxScanRelationshipConfig } from '../project/config.js';
import type { KtxScanEnrichmentStage, KtxScanEnrichmentStateSummary, KtxScanMode, KtxSchemaSnapshot } from './types.js';

/**
 * Canonical enrichment-stage registry. The `--stages` CLI parser validates
 * against this list, and stage selection / iteration derives its order here.
 */
export const KTX_SCAN_ENRICHMENT_STAGES: readonly KtxScanEnrichmentStage[] = [
  'descriptions',
  'embeddings',
  'relationships',
] as const;

export interface KtxScanEnrichmentStageLookup {
  connectionId: string;
  stage: KtxScanEnrichmentStage;
  inputHash: string;
}

export interface KtxScanEnrichmentCompletedStage<TOutput = unknown> {
  runId: string;
  connectionId: string;
  syncId: string;
  mode: KtxScanMode;
  stage: KtxScanEnrichmentStage;
  inputHash: string;
  status: 'completed';
  output: TOutput;
  errorMessage: null;
  updatedAt: string;
}

export interface KtxScanEnrichmentFailedStage {
  runId: string;
  connectionId: string;
  syncId: string;
  mode: KtxScanMode;
  stage: KtxScanEnrichmentStage;
  inputHash: string;
  status: 'failed';
  output: null;
  errorMessage: string;
  updatedAt: string;
}

export type KtxScanEnrichmentStageRecord<TOutput = unknown> =
  | KtxScanEnrichmentCompletedStage<TOutput>
  | KtxScanEnrichmentFailedStage;

export interface KtxScanEnrichmentStateStore {
  findCompletedStage<TOutput = unknown>(
    input: KtxScanEnrichmentStageLookup,
  ): Promise<KtxScanEnrichmentCompletedStage<TOutput> | null>;
  /**
   * The most recently completed row for a (connection, stage) pair regardless of
   * input hash. Used by the staleness check to compare a stage's stored hash
   * against its freshly recomputed one (D4).
   */
  findLatestCompletedStage(input: {
    connectionId: string;
    stage: KtxScanEnrichmentStage;
  }): Promise<KtxScanEnrichmentCompletedStage | null>;
  saveCompletedStage<TOutput = unknown>(
    input: Omit<KtxScanEnrichmentCompletedStage<TOutput>, 'status' | 'errorMessage'>,
  ): Promise<void>;
  saveFailedStage(input: Omit<KtxScanEnrichmentFailedStage, 'status' | 'output'>): Promise<void>;
  listRunStages(runId: string): Promise<KtxScanEnrichmentStageRecord[]>;
}

/** Description-LLM identity: the inputs that change a description's content. */
export interface KtxScanLlmIdentity {
  model: string | null;
  baseUrlConfigured: boolean;
}

/** Embedding-model identity: the inputs that change an embedding vector. */
export interface KtxScanEmbeddingIdentity {
  model: string | null;
  dimensions: number | null;
  batchSize: number | null;
}

export interface KtxDescriptionsStageHashInput {
  snapshot: KtxSchemaSnapshot;
  llmIdentity: KtxScanLlmIdentity;
}

export interface KtxEmbeddingsStageHashInput {
  snapshot: KtxSchemaSnapshot;
  embeddingIdentity: KtxScanEmbeddingIdentity;
  /** Digest of the resolved description text the embeddings consume (see {@link computeKtxScanDescriptionDigest}). */
  descriptionDigest: string;
}

export interface KtxRelationshipsStageHashInput {
  snapshot: KtxSchemaSnapshot;
  relationshipSettings: KtxScanRelationshipConfig;
  llmIdentity: KtxScanLlmIdentity;
}

export function computeKtxDescriptionsStageHash(input: KtxDescriptionsStageHashInput): string {
  return stableContentHash({ snapshot: input.snapshot, llmIdentity: input.llmIdentity });
}

export function computeKtxEmbeddingsStageHash(input: KtxEmbeddingsStageHashInput): string {
  return stableContentHash({
    snapshot: input.snapshot,
    embeddingIdentity: input.embeddingIdentity,
    descriptionDigest: input.descriptionDigest,
  });
}

export function computeKtxRelationshipsStageHash(input: KtxRelationshipsStageHashInput): string {
  return stableContentHash({
    snapshot: input.snapshot,
    relationshipSettings: input.relationshipSettings,
    llmIdentity: input.llmIdentity,
  });
}

/**
 * Content digest of the resolved per-column description text the embeddings
 * stage consumes. Folding it into the embeddings hash content-addresses
 * embeddings on their real upstream, so re-describing busts only the embeddings
 * that depend on the changed text (D4 self-healing).
 */
export function computeKtxScanDescriptionDigest(texts: readonly string[]): string {
  return stableContentHash(texts);
}

function uniqueStages(stages: KtxScanEnrichmentStage[]): KtxScanEnrichmentStage[] {
  const seen = new Set<KtxScanEnrichmentStage>();
  const ordered: KtxScanEnrichmentStage[] = [];
  for (const stage of KTX_SCAN_ENRICHMENT_STAGES) {
    if (stages.includes(stage) && !seen.has(stage)) {
      seen.add(stage);
      ordered.push(stage);
    }
  }
  return ordered;
}

export function completedKtxScanEnrichmentStateSummary(): KtxScanEnrichmentStateSummary {
  return {
    resumedStages: [],
    completedStages: [],
    failedStages: [],
  };
}

export function summarizeKtxScanEnrichmentState(input: KtxScanEnrichmentStateSummary): KtxScanEnrichmentStateSummary {
  return {
    resumedStages: uniqueStages(input.resumedStages),
    completedStages: uniqueStages(input.completedStages),
    failedStages: uniqueStages(input.failedStages),
  };
}
