import { describe, expect, it } from 'vitest';
import type { KtxEnrichedRelationship, KtxRelationshipEndpoint } from '../../../src/context/scan/enrichment-types.js';
import type { KtxResolvedRelationshipDiscoveryCandidate } from '../../../src/context/scan/relationship-graph-resolver.js';
import {
  buildKtxRelationshipArtifacts,
  buildKtxRelationshipDiagnostics,
  emptyKtxRelationshipProfileArtifact,
} from '../../../src/context/scan/relationship-diagnostics.js';

function endpoint(table: string, column: string): KtxRelationshipEndpoint {
  return {
    tableId: table,
    columnIds: [`${table}.${column}`],
    table: { catalog: null, db: null, name: table },
    columns: [column],
  };
}

function enrichedRelationship(input: {
  id: string;
  fromTable: string;
  fromColumn: string;
  toTable: string;
  toColumn: string;
  confidence?: number;
}): KtxEnrichedRelationship {
  return {
    id: input.id,
    source: 'inferred',
    from: endpoint(input.fromTable, input.fromColumn),
    to: endpoint(input.toTable, input.toColumn),
    relationshipType: 'many_to_one',
    confidence: input.confidence ?? 0.92,
    isPrimaryKeyReference: true,
  };
}

function resolvedRelationship(input: {
  id: string;
  status: 'accepted' | 'review' | 'rejected';
  source?: 'normalized_table_match' | 'exact_column_match' | 'inflection' | 'self_reference' | 'llm_proposal';
  fkScore?: number;
  pkScore?: number;
  validationReasons?: string[];
  graphReasons?: string[];
}): KtxResolvedRelationshipDiscoveryCandidate {
  return {
    id: input.id,
    from: endpoint('orders', 'customer_id'),
    to: endpoint('customers', 'id'),
    relationshipType: 'many_to_one',
    confidence: 0.88,
    source: input.source ?? 'normalized_table_match',
    status: input.status,
    evidence:
      input.source === 'llm_proposal'
        ? {
            sourceColumnBase: 'buyer',
            targetTableBase: 'customer',
            targetColumnBase: 'id',
            targetKeyScore: 0.88,
            nameScore: 0.45,
            reasons: ['llm_proposal', 'llm_pk_proposal'],
            llmConfidence: 0.89,
            llmRationale: 'Buyer reference values align with customer identifiers.',
          }
        : {
            sourceColumnBase: 'customer',
            targetTableBase: 'customer',
            targetColumnBase: 'id',
            targetKeyScore: 0.9,
            nameScore: 0.85,
            reasons: ['table_name_matches_source_column'],
          },
    score: 0.91,
    validation: {
      targetUniqueness: 1,
      sourceCoverage: input.status === 'rejected' ? 0.2 : 1,
      violationCount: input.status === 'rejected' ? 8 : 0,
      violationRatio: input.status === 'rejected' ? 0.8 : 0,
      sourceNullRate: 0,
      targetNullRate: 0,
      childDistinct: 10,
      parentDistinct: 10,
      overlap: input.status === 'rejected' ? 2 : 10,
      checkedValues: 10,
      reasons: input.validationReasons ?? ['validation_passed'],
    },
    pkScore: input.pkScore ?? 0.97,
    fkScore: input.fkScore ?? 0.94,
    graph: {
      targetPkScore: input.pkScore ?? 0.97,
      incomingCandidateCount: 1,
      conflictRank: 1,
      reasons: input.graphReasons ?? ['target_pk_score_passed', 'fk_score_passed'],
    },
  };
}

describe('relationship diagnostics artifacts', () => {
  it('groups graph-resolved relationships and preserves evidence reasons', () => {
    const artifacts = buildKtxRelationshipArtifacts({
      connectionId: 'warehouse',
      resolvedRelationships: [
        resolvedRelationship({ id: 'accepted-edge', status: 'accepted', source: 'llm_proposal' }),
        resolvedRelationship({
          id: 'review-edge',
          status: 'review',
          validationReasons: ['validation_unavailable'],
          graphReasons: ['validation_unavailable_review_only', 'fk_score_review'],
        }),
        resolvedRelationship({
          id: 'rejected-edge',
          status: 'rejected',
          validationReasons: ['low_source_coverage'],
          graphReasons: ['fk_score_rejected'],
        }),
      ],
    });

    expect(artifacts.accepted).toHaveLength(1);
    expect(artifacts.accepted[0]).toMatchObject({
      source: 'llm_proposal',
      evidence: {
        llmConfidence: 0.89,
        llmRationale: 'Buyer reference values align with customer identifiers.',
      },
      reasons: expect.arrayContaining(['llm_proposal', 'llm_pk_proposal']),
    });
    expect(artifacts.review).toHaveLength(1);
    expect(artifacts.rejected).toHaveLength(1);
    expect(artifacts.review[0]).toMatchObject({
      id: 'review-edge',
      status: 'review',
      source: 'normalized_table_match',
      fkScore: 0.94,
      reasons: expect.arrayContaining(['validation_unavailable', 'validation_unavailable_review_only']),
    });
    expect(artifacts.rejected[0]?.reasons).toEqual(
      expect.arrayContaining(['table_name_matches_source_column', 'low_source_coverage', 'fk_score_rejected']),
    );
  });

  it('adapts relationship updates into the artifact shape', () => {
    const artifacts = buildKtxRelationshipArtifacts({
      connectionId: 'warehouse',
      relationshipUpdate: {
        connectionId: 'warehouse',
        accepted: [
          enrichedRelationship({
            id: 'orders-customer',
            fromTable: 'orders',
            fromColumn: 'customer_id',
            toTable: 'customers',
            toColumn: 'id',
          }),
        ],
        rejected: [
          enrichedRelationship({
            id: 'orders-account',
            fromTable: 'orders',
            fromColumn: 'account_id',
            toTable: 'accounts',
            toColumn: 'id',
            confidence: 0.4,
          }),
        ],
        skipped: [{ relationshipId: 'orders-region', reason: 'validation_port_unavailable' }],
      },
    });

    expect(artifacts.accepted[0]).toMatchObject({
      id: 'orders-customer',
      status: 'accepted',
      source: 'inferred',
      reasons: ['accepted_relationship_update'],
    });
    expect(artifacts.rejected[0]).toMatchObject({
      id: 'orders-account',
      status: 'rejected',
      reasons: ['rejected_relationship_update'],
    });
    expect(artifacts.skipped).toEqual([{ relationshipId: 'orders-region', reason: 'validation_port_unavailable' }]);
  });

  it('deduplicates resolved and formal relationship update artifacts by edge id', () => {
    const artifacts = buildKtxRelationshipArtifacts({
      connectionId: 'warehouse',
      resolvedRelationships: [
        {
          id: 'orders:orders.account_id->accounts:accounts.id',
          from: endpoint('orders', 'account_id'),
          to: endpoint('accounts', 'id'),
          relationshipType: 'many_to_one',
          source: 'normalized_table_match',
          status: 'accepted',
          confidence: 0.92,
          score: 0.9,
          pkScore: 0.92,
          fkScore: 0.9,
          evidence: {
            sourceColumnBase: 'account',
            targetTableBase: 'account',
            targetColumnBase: 'id',
            targetKeyScore: 0.92,
            nameScore: 0.92,
            reasons: ['foreign_key_suffix'],
          },
          validation: {
            targetUniqueness: 1,
            sourceCoverage: 1,
            violationCount: 0,
            violationRatio: 0,
            sourceNullRate: 0,
            targetNullRate: 0,
            childDistinct: 2,
            parentDistinct: 2,
            overlap: 2,
            checkedValues: 2,
            reasons: ['validation_passed'],
          },
          graph: {
            targetPkScore: 0.92,
            incomingCandidateCount: 1,
            conflictRank: 1,
            reasons: ['fk_score_passed'],
          },
        },
      ],
      relationshipUpdate: {
        connectionId: 'warehouse',
        accepted: [
          {
            id: 'orders:orders.account_id->accounts:accounts.id',
            source: 'formal',
            from: endpoint('orders', 'account_id'),
            to: endpoint('accounts', 'id'),
            relationshipType: 'many_to_one',
            confidence: 1,
            isPrimaryKeyReference: true,
          },
        ],
        rejected: [],
        skipped: [],
      },
    });

    expect(artifacts.accepted).toHaveLength(1);
    expect(artifacts.accepted[0]).toMatchObject({
      id: 'orders:orders.account_id->accounts:accounts.id',
      source: 'normalized_table_match',
      reasons: expect.arrayContaining(['foreign_key_suffix', 'validation_passed', 'fk_score_passed']),
    });
  });

  it('explains validation-unavailable review candidates', () => {
    const artifacts = buildKtxRelationshipArtifacts({
      connectionId: 'warehouse',
      resolvedRelationships: [
        resolvedRelationship({
          id: 'review-edge',
          status: 'review',
          validationReasons: ['validation_unavailable'],
          graphReasons: ['validation_unavailable_review_only'],
        }),
      ],
    });
    const profile = emptyKtxRelationshipProfileArtifact({
      connectionId: 'warehouse',
      driver: 'sqlite',
      reason: 'read_only_sql_unavailable',
    });

    const diagnostics = buildKtxRelationshipDiagnostics({
      connectionId: 'warehouse',
      generatedAt: '2026-05-07T12:00:00.000Z',
      artifacts,
      profile,
      warnings: [
        {
          code: 'connector_capability_missing',
          message: 'ktx scan connector cannot run standalone statistical relationship validation',
          recoverable: true,
          metadata: { capability: 'readOnlySql' },
        },
      ],
      thresholds: { acceptThreshold: 0.85, reviewThreshold: 0.55 },
    });

    expect(diagnostics.summary).toEqual({ accepted: 0, review: 1, rejected: 0, skipped: 0 });
    expect(diagnostics.noAcceptedReason).toBe('validation unavailable; review candidates written');
    expect(diagnostics.candidateCountsBySource).toEqual({ normalized_table_match: 1 });
    expect(diagnostics.validation).toEqual({
      available: false,
      sqlAvailable: false,
      queryCount: 0,
    });
    expect(diagnostics.profileWarnings).toEqual(['read_only_sql_unavailable']);
    expect(diagnostics.warnings[0]).toMatchObject({ code: 'connector_capability_missing' });
  });

  it('explains empty relationship output as a no-candidate outcome', () => {
    const artifacts = buildKtxRelationshipArtifacts({ connectionId: 'warehouse' });
    const diagnostics = buildKtxRelationshipDiagnostics({
      connectionId: 'warehouse',
      generatedAt: '2026-05-07T12:00:00.000Z',
      artifacts,
      profile: emptyKtxRelationshipProfileArtifact({
        connectionId: 'warehouse',
        driver: 'sqlite',
        reason: 'relationship_profiling_not_run',
      }),
    });

    expect(diagnostics.summary).toEqual({ accepted: 0, review: 0, rejected: 0, skipped: 0 });
    expect(diagnostics.noAcceptedReason).toBe('no candidate pairs passed type compatibility');
    expect(diagnostics.candidateCountsBySource).toEqual({});
    expect(diagnostics.partial).toBe(false);
    expect(diagnostics.partialReason).toBeNull();
  });

  it('marks the diagnostics partial with its stop reason when relationship detection was truncated', () => {
    const artifacts = buildKtxRelationshipArtifacts({ connectionId: 'warehouse' });
    const diagnostics = buildKtxRelationshipDiagnostics({
      connectionId: 'warehouse',
      generatedAt: '2026-05-07T12:00:00.000Z',
      artifacts,
      profile: emptyKtxRelationshipProfileArtifact({
        connectionId: 'warehouse',
        driver: 'sqlite',
        reason: 'relationship_profiling_not_run',
      }),
      partial: { reason: 'budget' },
    });

    expect(diagnostics.partial).toBe(true);
    expect(diagnostics.partialReason).toBe('budget');
  });

  it('records composite relationship endpoints in relationship artifacts', () => {
    const artifacts = buildKtxRelationshipArtifacts({
      connectionId: 'warehouse',
      compositeRelationships: [
        {
          id: 'order_line_allocations.(order_id,line_number)->order_lines.(order_id,line_number)',
          source: 'composite_profile_match',
          status: 'accepted',
          from: {
            tableId: 'order_line_allocations',
            columnIds: ['order_line_allocations.order_id', 'order_line_allocations.line_number'],
            table: { catalog: null, db: null, name: 'order_line_allocations' },
            columns: ['order_id', 'line_number'],
          },
          to: {
            tableId: 'order_lines',
            columnIds: ['order_lines.order_id', 'order_lines.line_number'],
            table: { catalog: null, db: null, name: 'order_lines' },
            columns: ['order_id', 'line_number'],
          },
          relationshipType: 'many_to_one',
          confidence: 0.95,
          validation: {
            targetUniqueness: 1,
            sourceCoverage: 1,
            violationCount: 0,
            violationRatio: 0,
            childDistinct: 2,
            parentDistinct: 2,
            overlap: 2,
            reasons: ['composite_validation_passed'],
          },
        },
      ],
    });

    expect(artifacts.accepted).toEqual([
      expect.objectContaining({
        id: 'order_line_allocations.(order_id,line_number)->order_lines.(order_id,line_number)',
        source: 'composite_profile_match',
        from: expect.objectContaining({
          columnIds: ['order_line_allocations.order_id', 'order_line_allocations.line_number'],
          columns: ['order_id', 'line_number'],
        }),
        to: expect.objectContaining({
          columnIds: ['order_lines.order_id', 'order_lines.line_number'],
          columns: ['order_id', 'line_number'],
        }),
        reasons: ['composite_validation_passed'],
        validation: expect.objectContaining({ sourceCoverage: 1 }),
      }),
    ]);
  });
});
