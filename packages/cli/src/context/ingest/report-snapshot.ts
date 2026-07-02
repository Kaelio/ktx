import * as z from 'zod';
import { memoryFlowReplayInputSchema } from './memory-flow/schema.js';
import type { IngestReportSnapshot } from './reports.js';

const ingestDiffSummarySchema = z.object({
  added: z.number().int(),
  modified: z.number().int(),
  deleted: z.number().int(),
  unchanged: z.number().int(),
});

const ingestActionSchema = z.object({
  target: z.enum(['wiki', 'sl']),
  type: z.enum(['created', 'updated', 'removed']),
  key: z.string(),
  detail: z.string(),
  targetConnectionId: z.string().nullable().default(null),
  rawPaths: z.array(z.string()).optional(),
});

const touchedSlSourceSchema = z.object({
  connectionId: z.string().min(1),
  sourceName: z.string().min(1),
});

const conflictResolvedSchema = z
  .object({
    unitKey: z.string().optional(),
    kind: z.enum(['structural_duplicate', 'near_duplicate', 'definitional_contradiction', 're_ingest_change']),
    contestedKey: z.string().optional(),
    artifactKey: z.string(),
    detail: z.string(),
    flaggedForHuman: z.boolean(),
  })
  .passthrough();

const evictionAppliedSchema = z
  .object({
    rawPath: z.string(),
    artifactKind: z.enum(['sl', 'wiki']),
    artifactKey: z.string(),
    action: z.literal('removed'),
    reason: z.string(),
  })
  .passthrough();

const unmappedFallbackSchema = z
  .object({
    rawPath: z.string(),
    reason: z.enum([
      'no_connection_mapping',
      'looker_template_unresolved',
      'derived_table_not_supported',
      'no_physical_table',
      'multiple_table_references',
      'unsupported_dialect',
      'parse_error',
      'missing_target_table',
    ]),
    detail: z.string().optional(),
    fallback: z.enum(['sql_standalone', 'wiki_only', 'flagged']),
  })
  .passthrough();

const artifactResolutionSchema = z
  .object({
    rawPath: z.string(),
    artifactKind: z.enum(['sl', 'wiki']),
    artifactKey: z.string(),
    actionType: z.enum(['merged', 'subsumed']),
    reason: z.string(),
  })
  .passthrough();

const provenanceDetailSchema = z.object({
  rawPath: z.string(),
  artifactKind: z.enum(['sl', 'wiki']).nullable(),
  artifactKey: z.string().nullable(),
  targetConnectionId: z.string().nullable().default(null),
  actionType: z.enum([
    'source_created',
    'measure_added',
    'join_added',
    'merged',
    'subsumed',
    'wiki_written',
    'skipped',
  ]),
});

const toolTranscriptSummarySchema = z.object({
  unitKey: z.string(),
  path: z.string(),
  toolCallCount: z.number().int().min(0),
  errorCount: z.number().int().min(0),
  toolNames: z.array(z.string()),
});

const sourceFetchIssueKindSchema = z.enum([
  'unmapped_looker_connection',
  'unparseable_sql_table_name',
  'looker_template_unresolved',
  'derived_table_not_supported',
  'lookml_connection_mismatch',
]);

const sourceFetchIssueSchema = z.object({
  rawPath: z.string(),
  entityType: z.string(),
  entityId: z.string().nullable(),
  severity: z.enum(['warning', 'error']),
  statusCode: z.number().int().nullable(),
  message: z.string(),
  retryRecommended: z.boolean(),
  kind: sourceFetchIssueKindSchema.optional(),
  details: z.record(z.string(), z.unknown()).optional(),
});

const sourceFetchReportSchema = z.object({
  status: z.enum(['success', 'partial']),
  retryRecommended: z.boolean(),
  skipped: z.array(sourceFetchIssueSchema).default([]),
  warnings: z.array(sourceFetchIssueSchema).default([]),
});

const ingestReportFailureSchema = z.object({
  phase: z.string().min(1),
  message: z.string().min(1),
  details: z.record(z.string(), z.unknown()).optional(),
});

const finalizationMismatchSchema = z.object({
  artifactKind: z.enum(['sl', 'wiki']),
  key: z.string().min(1),
  direction: z.enum(['missing_from_adapter_declaration', 'extra_in_adapter_declaration']),
});

const finalizationProvenanceExclusionSchema = z.object({
  action: ingestActionSchema,
  reason: z.enum(['missing_raw_paths', 'raw_path_not_defensible']),
  invalidRawPaths: z.array(z.string()).optional(),
});

const finalizationOutcomeSchema = z.object({
  sourceKey: z.string().min(1),
  status: z.enum(['success', 'failed', 'skipped']),
  commitSha: z.string().nullable(),
  touchedPaths: z.array(z.string()),
  declaredTouchedSources: z.array(touchedSlSourceSchema),
  derivedTouchedSources: z.array(touchedSlSourceSchema),
  declaredChangedWikiPageKeys: z.array(z.string()),
  derivedChangedWikiPageKeys: z.array(z.string()),
  mismatches: z.array(finalizationMismatchSchema).default([]),
  result: z.unknown().optional(),
  errors: z.array(z.string()),
  warnings: z.array(z.string()),
  actions: z.array(ingestActionSchema).default([]),
  provenanceExclusions: z.array(finalizationProvenanceExclusionSchema).default([]),
});

const finalGatePrunedReferenceSchema = z.object({
  kind: z.enum(['join', 'wiki_ref', 'wiki_sl_ref', 'wiki_body_ref']),
  artifact: z.string(),
  removedRef: z.string(),
  absentTarget: z.string(),
});

const finalGateDroppedSourceSchema = z.object({
  connectionId: z.string(),
  sourceName: z.string(),
  reason: z.string(),
});

const ingestReportSnapshotSchema = z
  .object({
    id: z.string().min(1),
    runId: z.string().min(1),
    jobId: z.string().min(1),
    connectionId: z.string().min(1),
    sourceKey: z.string().min(1),
    createdAt: z.string().min(1),
    body: z
      .object({
        status: z.enum(['completed', 'failed']).optional(),
        syncId: z.string().min(1),
        diffSummary: ingestDiffSummarySchema,
        fetch: sourceFetchReportSchema.optional(),
        commitSha: z.string().nullable(),
        tracePath: z.string().optional(),
        failure: ingestReportFailureSchema.optional(),
        isolatedDiff: z
          .object({
            enabled: z.boolean(),
            integrationWorktreePath: z.string().optional(),
            ingestionBaseSha: z.string().optional(),
            projectionSha: z.string().nullable().optional(),
            acceptedPatches: z.number().int().min(0),
            textualConflicts: z.number().int().min(0),
            semanticConflicts: z.number().int().min(0),
            resolverAttempts: z.number().int().min(0).default(0),
            resolverRepairs: z.number().int().min(0).default(0),
            resolverFailures: z.number().int().min(0).default(0),
          })
          .optional(),
        workUnits: z.array(
          z.object({
            unitKey: z.string().min(1),
            rawFiles: z.array(z.string()),
            status: z.enum(['success', 'failed']),
            reason: z.string().optional(),
            actions: z.array(ingestActionSchema),
            touchedSlSources: z.array(touchedSlSourceSchema),
            slDisallowed: z.boolean().optional(),
            slDisallowedReason: z.enum(['lookml_connection_mismatch']).optional(),
          }),
        ),
        failedWorkUnits: z.array(z.string()),
        reconciliationSkipped: z.boolean(),
        reconciliationActions: z.array(ingestActionSchema).default([]),
        conflictsResolved: z.array(conflictResolvedSchema).default([]),
        evictionsApplied: z.array(evictionAppliedSchema).default([]),
        unmappedFallbacks: z.array(unmappedFallbackSchema).default([]),
        artifactResolutions: z.array(artifactResolutionSchema).default([]),
        evictionInputs: z.array(z.string()),
        unresolvedCards: z.array(z.unknown()).default([]),
        supersededBy: z.string().nullable().default(null),
        overrideOf: z.string().nullable().default(null),
        provenanceRows: z.array(provenanceDetailSchema).default([]),
        toolTranscripts: z.array(toolTranscriptSummarySchema).default([]),
        finalization: finalizationOutcomeSchema.optional(),
        finalGatePrunedReferences: z.array(finalGatePrunedReferenceSchema).default([]),
        finalGateDroppedSources: z.array(finalGateDroppedSourceSchema).default([]),
        memoryFlow: memoryFlowReplayInputSchema.optional(),
      })
      .passthrough(),
  })
  .passthrough();

export function parseIngestReportSnapshot(value: unknown): IngestReportSnapshot {
  const result = ingestReportSnapshotSchema.safeParse(value);
  if (!result.success) {
    throw new Error(`Invalid ingest report snapshot: ${z.prettifyError(result.error)}`);
  }
  return result.data as IngestReportSnapshot;
}
