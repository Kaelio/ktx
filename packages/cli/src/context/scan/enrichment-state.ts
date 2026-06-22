import { createHash } from 'node:crypto';
import type { KtxScanEnrichmentStage, KtxScanEnrichmentStateSummary, KtxScanMode, KtxSchemaSnapshot } from './types.js';

const KTX_SCAN_ENRICHMENT_STAGES: readonly KtxScanEnrichmentStage[] = [
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
  saveCompletedStage<TOutput = unknown>(
    input: Omit<KtxScanEnrichmentCompletedStage<TOutput>, 'status' | 'errorMessage'>,
  ): Promise<void>;
  saveFailedStage(input: Omit<KtxScanEnrichmentFailedStage, 'status' | 'output'>): Promise<void>;
  listRunStages(runId: string): Promise<KtxScanEnrichmentStageRecord[]>;
}

export interface ComputeKtxScanEnrichmentInputHashInput {
  snapshot: KtxSchemaSnapshot;
  mode: KtxScanMode;
  detectRelationships: boolean;
  providerIdentity: Record<string, unknown>;
  relationshipSettings?: unknown;
}

function stableJson(value: unknown): string {
  if (Array.isArray(value)) {
    return `[${value.map(stableJson).join(',')}]`;
  }
  if (value && typeof value === 'object') {
    const entries = Object.entries(value as Record<string, unknown>).sort(([left], [right]) =>
      left.localeCompare(right),
    );
    return `{${entries.map(([key, item]) => `${JSON.stringify(key)}:${stableJson(item)}`).join(',')}}`;
  }
  return JSON.stringify(value);
}

export function computeKtxScanEnrichmentInputHash(input: ComputeKtxScanEnrichmentInputHashInput): string {
  return createHash('sha256').update(stableJson(input)).digest('hex');
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
