import type { MemoryAction } from '../../context/memory/types.js';
import type { TouchedSlSource } from '../../context/tools/touched-sl-sources.js';
import type { MemoryFlowReplayInput } from './memory-flow/types.js';
import type { FinalGateDroppedSource, FinalGatePrunedReference } from './final-gate-prune.js';
import type { IngestProvenanceInsert } from './ports.js';
import type {
  ArtifactResolutionRecord,
  ConflictResolvedRecord,
  EvictionAppliedRecord,
  StageIndex,
  UnmappedFallbackRecord,
} from './stages/stage-index.types.js';
import type { WikiSlRefRepair } from './wiki-sl-ref-repair.js';
import type { IngestDiffSummary, SourceFetchReport, UnresolvedCardInfo } from './types.js';

export interface IngestReportWorkUnit {
  unitKey: string;
  rawFiles: string[];
  status: 'success' | 'failed';
  reason?: string;
  actions: MemoryAction[];
  touchedSlSources: TouchedSlSource[];
  slDisallowed?: boolean;
  slDisallowedReason?: 'lookml_connection_mismatch';
}

export interface IngestReportProvenanceDetail {
  rawPath: string;
  artifactKind: 'sl' | 'wiki' | null;
  artifactKey: string | null;
  targetConnectionId?: string | null;
  actionType: IngestProvenanceInsert['actionType'];
}

interface IngestReportToolTranscriptSummary {
  unitKey: string;
  path: string;
  toolCallCount: number;
  errorCount: number;
  toolNames: string[];
}

export interface IngestReportFinalizationMismatch {
  artifactKind: 'sl' | 'wiki';
  key: string;
  direction: 'missing_from_adapter_declaration' | 'extra_in_adapter_declaration';
}

export interface IngestReportFinalizationProvenanceExclusion {
  action: MemoryAction;
  reason: 'missing_raw_paths' | 'raw_path_not_defensible';
  invalidRawPaths?: string[];
}

export interface IngestReportFinalizationOutcome {
  sourceKey: string;
  status: 'success' | 'failed' | 'skipped';
  commitSha: string | null;
  touchedPaths: string[];
  declaredTouchedSources: TouchedSlSource[];
  derivedTouchedSources: TouchedSlSource[];
  declaredChangedWikiPageKeys: string[];
  derivedChangedWikiPageKeys: string[];
  mismatches: IngestReportFinalizationMismatch[];
  result?: unknown;
  errors: string[];
  warnings: string[];
  actions: MemoryAction[];
  provenanceExclusions: IngestReportFinalizationProvenanceExclusion[];
}

interface IngestReportFailure {
  phase: string;
  message: string;
  details?: Record<string, unknown>;
}

export interface IngestReportBody {
  status?: 'completed' | 'failed';
  syncId: string;
  diffSummary: IngestDiffSummary;
  fetch?: SourceFetchReport;
  commitSha: string | null;
  tracePath?: string;
  failure?: IngestReportFailure;
  isolatedDiff?: {
    enabled: boolean;
    integrationWorktreePath?: string;
    ingestionBaseSha?: string;
    projectionSha?: string | null;
    acceptedPatches: number;
    textualConflicts: number;
    semanticConflicts: number;
    resolverAttempts?: number;
    resolverRepairs?: number;
    resolverFailures?: number;
  };
  workUnits: IngestReportWorkUnit[];
  failedWorkUnits: string[];
  reconciliationSkipped: boolean;
  // Actions emitted by the reconciliation stage (wiki/sl writes from
  // cross-WU reconciliation). Counted alongside workUnit.actions in
  // savedMemoryCountsForReport so progress reports reflect all writes.
  reconciliationActions?: MemoryAction[];
  conflictsResolved: ConflictResolvedRecord[];
  evictionsApplied: EvictionAppliedRecord[];
  unmappedFallbacks: UnmappedFallbackRecord[];
  artifactResolutions?: ArtifactResolutionRecord[];
  evictionInputs: string[];
  unresolvedCards: UnresolvedCardInfo[];
  supersededBy: string | null;
  overrideOf: string | null;
  provenanceRows: IngestReportProvenanceDetail[];
  toolTranscripts: IngestReportToolTranscriptSummary[];
  finalization?: IngestReportFinalizationOutcome;
  finalGatePrunedReferences?: FinalGatePrunedReference[];
  finalGateDroppedSources?: FinalGateDroppedSource[];
  wikiSlRefRepairs?: WikiSlRefRepair[];
  wikiSlRefRepairWarnings?: string[];
  memoryFlow?: MemoryFlowReplayInput;
}

export interface IngestReportSnapshot {
  id: string;
  runId: string;
  jobId: string;
  connectionId: string;
  sourceKey: string;
  body: IngestReportBody;
  createdAt: string;
}

export interface IngestSavedMemoryCounts {
  wikiCount: number;
  slCount: number;
}

export function savedMemoryCountsForReport(report: IngestReportSnapshot): IngestSavedMemoryCounts {
  const workUnitActions = report.body.workUnits.flatMap((workUnit) => workUnit.actions);
  const reconciliationActions = report.body.reconciliationActions ?? [];
  const finalizationActions = report.body.finalization?.actions ?? [];
  const actions = [...workUnitActions, ...reconciliationActions, ...finalizationActions];
  return {
    wikiCount: actions.filter((action) => action.target === 'wiki').length,
    slCount: actions.filter((action) => action.target === 'sl').length,
  };
}

/** @internal */
export type IngestReportOutcome = 'done' | 'partial' | 'error';

export function ingestReportOutcome(report: IngestReportSnapshot): IngestReportOutcome {
  if (report.body.status === 'failed') {
    return 'error';
  }
  const hasPruneOrDrop =
    (report.body.finalGatePrunedReferences?.length ?? 0) > 0 ||
    (report.body.finalGateDroppedSources?.length ?? 0) > 0;
  if (report.body.failedWorkUnits.length === 0 && !hasPruneOrDrop) {
    return 'done';
  }
  const { wikiCount, slCount } = savedMemoryCountsForReport(report);
  return wikiCount + slCount > 0 ? 'partial' : 'error';
}

export function buildStageIndexFromReportBody(jobId: string, connectionId: string, body: IngestReportBody): StageIndex {
  return {
    jobId,
    connectionId,
    workUnits: body.workUnits.map((wu) => ({
      unitKey: wu.unitKey,
      rawFiles: wu.rawFiles,
      status: wu.status,
      reason: wu.reason,
      actions: wu.actions,
      touchedSlSources: wu.touchedSlSources,
      slDisallowed: wu.slDisallowed,
      slDisallowedReason: wu.slDisallowedReason,
    })),
    conflictsResolved: [],
    evictionsApplied: [],
    unmappedFallbacks: [],
    artifactResolutions: body.artifactResolutions ?? [],
  };
}
