import type { KtxLlmRuntimePort } from '../../context/llm/runtime-port.js';
import type { KtxSqlDialect } from '../connections/dialects.js';
import type { KtxScanRelationshipConfig } from '../project/config.js';
import type { KtxEnrichedRelationship, KtxEnrichedSchema, KtxRelationshipUpdate } from './enrichment-types.js';
import {
  generateKtxRelationshipDiscoveryCandidates,
  type KtxRelationshipDiscoveryCandidate,
  mergeKtxRelationshipDiscoveryCandidates,
} from './relationship-candidates.js';
import {
  discoverKtxCompositeRelationships,
  type KtxCompositeRelationshipCandidate,
} from './relationship-composite-candidates.js';
import { collectKtxFormalMetadataRelationships } from './relationship-formal-metadata.js';
import {
  type KtxResolvedRelationshipDiscoveryCandidate,
  resolveKtxRelationshipGraph,
} from './relationship-graph-resolver.js';
import { proposeKtxRelationshipCandidatesWithLlm } from './relationship-llm-proposal.js';
import {
  createKtxRelationshipProfileCache,
  type KtxRelationshipProfileArtifact,
  type KtxRelationshipReadOnlyExecutor,
  profileKtxRelationshipSchema,
} from './relationship-profiling.js';
import { validateKtxRelationshipDiscoveryCandidates } from './relationship-validation.js';
import type {
  KtxScanConnector,
  KtxScanContext,
  KtxScanEnrichmentSummary,
  KtxScanRelationshipSummary,
  KtxScanWarning,
} from './types.js';

export interface DiscoverKtxRelationshipsInput {
  connectionId: string;
  dialect: KtxSqlDialect | null;
  connector: KtxScanConnector;
  schema: KtxEnrichedSchema;
  context: KtxScanContext;
  settings: KtxScanRelationshipConfig;
  llmRuntime?: KtxLlmRuntimePort | null;
}

export interface DiscoverKtxRelationshipsResult {
  relationshipUpdate: KtxRelationshipUpdate;
  relationships: KtxScanRelationshipSummary;
  profile: KtxRelationshipProfileArtifact;
  resolvedRelationships: KtxResolvedRelationshipDiscoveryCandidate[];
  compositeRelationships: KtxCompositeRelationshipCandidate[];
  statisticalValidation: KtxScanEnrichmentSummary['statisticalValidation'];
  llmRelationshipValidation: KtxScanEnrichmentSummary['llmRelationshipValidation'];
  warnings: KtxScanWarning[];
}

function relationshipFromResolved(candidate: KtxResolvedRelationshipDiscoveryCandidate): KtxEnrichedRelationship {
  return {
    id: candidate.id,
    source: 'inferred',
    from: candidate.from,
    to: candidate.to,
    relationshipType: candidate.relationshipType,
    confidence: candidate.fkScore,
    isPrimaryKeyReference: candidate.pkScore >= 0.78,
  };
}

function relationshipFromComposite(candidate: KtxCompositeRelationshipCandidate): KtxEnrichedRelationship {
  return {
    id: candidate.id,
    source: 'inferred',
    from: {
      tableId: candidate.from.tableId,
      columnIds: candidate.from.columnIds,
      table: candidate.from.table,
      columns: candidate.from.columns,
    },
    to: {
      tableId: candidate.to.tableId,
      columnIds: candidate.to.columnIds,
      table: candidate.to.table,
      columns: candidate.to.columns,
    },
    relationshipType: candidate.relationshipType,
    confidence: candidate.confidence,
    isPrimaryKeyReference: candidate.status === 'accepted',
  };
}

function relationshipId(input: Pick<KtxEnrichedRelationship, 'from' | 'to'>): string {
  return `${input.from.tableId}:(${input.from.columnIds.join(',')})->${input.to.tableId}:(${input.to.columnIds.join(',')})`;
}

function nonFormalAcceptedRelationships(input: {
  formalIds: ReadonlySet<string>;
  resolvedRelationships: readonly KtxResolvedRelationshipDiscoveryCandidate[];
}): KtxEnrichedRelationship[] {
  return input.resolvedRelationships
    .filter((candidate) => candidate.status === 'accepted' && !input.formalIds.has(candidate.id))
    .map(relationshipFromResolved);
}

function relationshipSummary(
  resolvedRelationships: readonly KtxResolvedRelationshipDiscoveryCandidate[],
): KtxScanRelationshipSummary {
  return {
    accepted: resolvedRelationships.filter((candidate) => candidate.status === 'accepted').length,
    review: resolvedRelationships.filter((candidate) => candidate.status === 'review').length,
    rejected: resolvedRelationships.filter((candidate) => candidate.status === 'rejected').length,
    skipped: 0,
  };
}

function compositeSummary(relationships: readonly KtxCompositeRelationshipCandidate[]): KtxScanRelationshipSummary {
  return {
    accepted: relationships.filter((candidate) => candidate.status === 'accepted').length,
    review: relationships.filter((candidate) => candidate.status === 'review').length,
    rejected: relationships.filter((candidate) => candidate.status === 'rejected').length,
    skipped: 0,
  };
}

async function detectCompositeRelationships(input: {
  connectionId: string;
  dialect: KtxSqlDialect | null;
  schema: KtxEnrichedSchema;
  profile: KtxRelationshipProfileArtifact;
  executor: KtxRelationshipReadOnlyExecutor | null;
  context: DiscoverKtxRelationshipsInput['context'];
  warnings: KtxScanWarning[];
}): Promise<KtxCompositeRelationshipCandidate[]> {
  if (!input.executor || !input.profile.sqlAvailable || !input.dialect) {
    return [];
  }
  const dialect = input.dialect;
  try {
    const compositeDetection = await discoverKtxCompositeRelationships({
      connectionId: input.connectionId,
      dialect,
      schema: input.schema,
      profiles: input.profile,
      executor: input.executor,
      ctx: input.context,
    });
    for (const warning of compositeDetection.warnings) {
      input.warnings.push({
        code: 'relationship_validation_failed',
        message: warning,
        recoverable: true,
        metadata: { source: 'composite_relationship_detection' },
      });
    }
    return compositeDetection.relationships;
  } catch (error) {
    input.warnings.push({
      code: 'relationship_validation_failed',
      message: `ktx composite relationship detection failed: ${error instanceof Error ? error.message : String(error)}`,
      recoverable: true,
      metadata: { source: 'composite_relationship_detection' },
    });
    return [];
  }
}

function combinedRelationshipSummary(input: {
  formalAccepted: number;
  formalSkipped: number;
  resolvedRelationships: readonly KtxResolvedRelationshipDiscoveryCandidate[];
}): KtxScanRelationshipSummary {
  const graph = relationshipSummary(input.resolvedRelationships);
  return {
    accepted: input.formalAccepted + graph.accepted,
    review: graph.review,
    rejected: graph.rejected,
    skipped: input.formalSkipped,
  };
}

function sqlExecutor(input: DiscoverKtxRelationshipsInput): {
  executor: KtxRelationshipReadOnlyExecutor | null;
  warnings: KtxScanWarning[];
} {
  if (!input.connector.capabilities.readOnlySql) {
    return {
      executor: null,
      warnings: [
        {
          code: 'connector_capability_missing',
          message: 'ktx scan connector cannot run read-only SQL relationship validation',
          recoverable: true,
          metadata: { capability: 'readOnlySql' },
        },
      ],
    };
  }

  if (!input.connector.executeReadOnly) {
    return {
      executor: null,
      warnings: [
        {
          code: 'relationship_validation_failed',
          message: 'ktx scan connector advertises readOnlySql but does not expose executeReadOnly',
          recoverable: true,
          metadata: { capability: 'readOnlySql' },
        },
      ],
    };
  }

  return {
    executor: {
      executeReadOnly: input.connector.executeReadOnly.bind(input.connector),
    },
    warnings: [],
  };
}

export async function discoverKtxRelationships(
  input: DiscoverKtxRelationshipsInput,
): Promise<DiscoverKtxRelationshipsResult> {
  const { executor, warnings } = sqlExecutor(input);
  const formalMetadata = collectKtxFormalMetadataRelationships(input.schema);
  const profileCache = createKtxRelationshipProfileCache();
  const profile = await profileKtxRelationshipSchema({
    connectionId: input.connectionId,
    driver: input.connector.driver,
    dialect: input.dialect,
    schema: input.schema,
    executor,
    ctx: input.context,
    profileSampleRows: input.settings.profileSampleRows,
    profileConcurrency: input.settings.profileConcurrency,
    cache: profileCache,
  });
  const deterministicCandidates: KtxRelationshipDiscoveryCandidate[] = generateKtxRelationshipDiscoveryCandidates(
    input.schema,
    {
      maxCandidatesPerColumn: input.settings.maxCandidatesPerColumn,
      profiles: profile,
    },
  );
  const llmProposalResult = input.settings.llmProposals
    ? await proposeKtxRelationshipCandidatesWithLlm({
        connectionId: input.connectionId,
        schema: input.schema,
        profile,
        llmRuntime: input.llmRuntime ?? null,
        settings: {
          maxTablesPerBatch: input.settings.maxLlmTablesPerBatch,
        },
      })
    : { candidates: [], warnings: [], llmCalls: 0, summary: 'skipped' as const };
  const candidates = mergeKtxRelationshipDiscoveryCandidates([
    ...deterministicCandidates,
    ...llmProposalResult.candidates,
  ]).filter((candidate) => !formalMetadata.acceptedIds.has(candidate.id));
  warnings.push(...llmProposalResult.warnings);
  const validated = await validateKtxRelationshipDiscoveryCandidates({
    connectionId: input.connectionId,
    dialect: input.dialect,
    candidates,
    profiles: profile,
    executor,
    ctx: input.context,
    tableCount: input.schema.tables.length,
    settings: {
      acceptThreshold: input.settings.acceptThreshold,
      reviewThreshold: input.settings.reviewThreshold,
      maxDistinctSourceValues: input.settings.profileSampleRows,
      concurrency: input.settings.validationConcurrency,
      validationBudget: input.settings.validationBudget,
    },
  });
  const graph = resolveKtxRelationshipGraph({
    schema: input.schema,
    profiles: profile,
    candidates: validated,
    settings: {
      acceptThreshold: input.settings.acceptThreshold,
      reviewThreshold: input.settings.reviewThreshold,
      validationRequiredForManifest: input.settings.validationRequiredForManifest,
    },
  });
  const compositeRelationships = await detectCompositeRelationships({
    connectionId: input.connectionId,
    dialect: input.dialect,
    schema: input.schema,
    profile,
    executor,
    context: input.context,
    warnings,
  });
  const inferredAccepted = nonFormalAcceptedRelationships({
    formalIds: formalMetadata.acceptedIds,
    resolvedRelationships: graph.relationships,
  });
  const compositeAccepted = compositeRelationships
    .filter((candidate) => candidate.status === 'accepted')
    .map(relationshipFromComposite);
  const relationshipsForAcceptance = formalMetadata.accepted.concat(inferredAccepted, compositeAccepted);
  const acceptedById = new Map(relationshipsForAcceptance.map((relationship) => [relationship.id, relationship]));
  const accepted = Array.from(acceptedById.values()).sort((left, right) =>
    relationshipId(left).localeCompare(relationshipId(right)),
  );
  const rejected = graph.relationships
    .filter((candidate) => candidate.status === 'rejected')
    .map(relationshipFromResolved);
  const combined = combinedRelationshipSummary({
    formalAccepted: formalMetadata.accepted.length,
    formalSkipped: formalMetadata.skipped.length,
    resolvedRelationships: graph.relationships,
  });
  const compositeCounts = compositeSummary(compositeRelationships);

  return {
    relationshipUpdate: {
      connectionId: input.connectionId,
      accepted,
      rejected,
      skipped: formalMetadata.skipped,
    },
    relationships: {
      accepted: combined.accepted + compositeCounts.accepted,
      review: combined.review + compositeCounts.review,
      rejected: combined.rejected + compositeCounts.rejected,
      skipped: combined.skipped,
    },
    profile,
    resolvedRelationships: graph.relationships,
    compositeRelationships,
    statisticalValidation: profile.sqlAvailable ? 'completed' : 'skipped',
    llmRelationshipValidation: llmProposalResult.summary,
    warnings,
  };
}
