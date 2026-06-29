import type { KtxSqlDialect } from '../connections/dialects.js';
import type { KtxRelationshipEndpoint } from './enrichment-types.js';
import { applyKtxRelationshipValidationBudget, type KtxRelationshipValidationBudget } from './relationship-budget.js';
import type { KtxRelationshipDiscoveryCandidate } from './relationship-candidates.js';
import {
  type KtxRelationshipProfileArtifact,
  type KtxRelationshipReadOnlyExecutor,
} from './relationship-profiling.js';
import type { KtxQueryResult, KtxScanContext, KtxTableRef } from './types.js';

type KtxValidatedRelationshipStatus = 'accepted' | 'review' | 'rejected';

interface KtxRelationshipValidationSettings {
  acceptThreshold: number;
  reviewThreshold: number;
  minTargetUniqueness: number;
  minSourceCoverage: number;
  maxViolationRatio: number;
  maxDistinctSourceValues: number;
  concurrency: number;
  validationBudget?: KtxRelationshipValidationBudget;
}

interface KtxRelationshipValidationEvidence {
  targetUniqueness: number;
  sourceCoverage: number;
  violationCount: number;
  violationRatio: number;
  sourceNullRate: number;
  targetNullRate: number;
  childDistinct: number;
  parentDistinct: number;
  overlap: number;
  checkedValues: number;
  reasons: string[];
}

export interface KtxValidatedRelationshipDiscoveryCandidate
  extends Omit<KtxRelationshipDiscoveryCandidate, 'status'> {
  status: KtxValidatedRelationshipStatus;
  score: number;
  validation: KtxRelationshipValidationEvidence;
}

export interface ValidateKtxRelationshipDiscoveryCandidatesInput {
  connectionId: string;
  dialect: KtxSqlDialect | null;
  candidates: readonly KtxRelationshipDiscoveryCandidate[];
  profiles: KtxRelationshipProfileArtifact;
  executor: KtxRelationshipReadOnlyExecutor | null;
  ctx: KtxScanContext;
  tableCount?: number;
  settings?: Partial<KtxRelationshipValidationSettings>;
}

const DEFAULT_SETTINGS: KtxRelationshipValidationSettings = {
  acceptThreshold: 0.85,
  reviewThreshold: 0.55,
  minTargetUniqueness: 0.9,
  minSourceCoverage: 0.9,
  maxViolationRatio: 0.01,
  maxDistinctSourceValues: 10000,
  concurrency: 4,
};

function mergeSettings(
  settings: Partial<KtxRelationshipValidationSettings> | undefined,
): KtxRelationshipValidationSettings {
  return { ...DEFAULT_SETTINGS, ...settings };
}

function profileKey(table: string, column: string): string {
  return `${table}.${column}`;
}

function singleRelationshipColumn(endpointValue: KtxRelationshipEndpoint): string {
  const column = endpointValue.columns[0];
  if (!column) {
    throw new Error(`Expected relationship endpoint ${endpointValue.table.name} to contain one column`);
  }
  return column;
}

function headerIndex(result: KtxQueryResult, header: string): number {
  return result.headers.findIndex((candidate) => candidate.toLowerCase() === header.toLowerCase());
}

function firstRow(result: KtxQueryResult): unknown[] {
  return result.rows[0] ?? [];
}

function numberAt(result: KtxQueryResult, header: string): number {
  const value = firstRow(result)[headerIndex(result, header)];
  if (typeof value === 'number') {
    return value;
  }
  if (typeof value === 'bigint') {
    return Number(value);
  }
  if (typeof value === 'string' && value.trim() !== '') {
    return Number(value);
  }
  return 0;
}

function sqlSuffix(fragment: string): string {
  return fragment ? ` ${fragment}` : '';
}

function buildCoverageSql(input: {
  dialect: KtxSqlDialect;
  childTable: KtxTableRef;
  childColumn: string;
  parentTable: KtxTableRef;
  parentColumn: string;
  maxDistinctSourceValues: number;
}): string {
  const childTable = input.dialect.formatTableName(input.childTable);
  const parentTable = input.dialect.formatTableName(input.parentTable);
  const childColumn = input.dialect.quoteIdentifier(input.childColumn);
  const parentColumn = input.dialect.quoteIdentifier(input.parentColumn);
  const limit = sqlSuffix(input.dialect.getLimitOffsetClause(input.maxDistinctSourceValues));
  const top = input.dialect.getTopClause(input.maxDistinctSourceValues);

  return [
    'WITH child_values AS (',
    `SELECT DISTINCT${top ? ` ${top}` : ''} ${childColumn} AS value FROM ${childTable} WHERE ${childColumn} IS NOT NULL${limit}`,
    '), parent_values AS (',
    `SELECT DISTINCT ${parentColumn} AS value FROM ${parentTable} WHERE ${parentColumn} IS NOT NULL`,
    ')',
    'SELECT',
    '(SELECT COUNT(*) FROM child_values) AS child_distinct,',
    '(SELECT COUNT(*) FROM parent_values) AS parent_distinct,',
    'SUM(CASE WHEN parent_values.value IS NOT NULL THEN 1 ELSE 0 END) AS overlap,',
    'SUM(CASE WHEN parent_values.value IS NULL THEN 1 ELSE 0 END) AS violation_count',
    'FROM child_values',
    'LEFT JOIN parent_values ON child_values.value = parent_values.value',
  ].join(' ');
}

function score(input: {
  candidateConfidence: number;
  targetUniqueness: number;
  sourceCoverage: number;
  violationRatio: number;
}): number {
  const violationScore = Math.max(0, 1 - input.violationRatio);
  return Number(
    Math.min(
      1,
      0.2 * input.candidateConfidence +
        0.3 * input.targetUniqueness +
        0.4 * input.sourceCoverage +
        0.1 * violationScore,
    ).toFixed(3),
  );
}

function statusFor(input: {
  score: number;
  reasons: readonly string[];
  settings: KtxRelationshipValidationSettings;
}): KtxValidatedRelationshipStatus {
  if (
    input.reasons.includes('low_target_uniqueness') ||
    input.reasons.includes('low_source_coverage') ||
    input.reasons.includes('excessive_violations')
  ) {
    return 'rejected';
  }
  if (
    input.score >= input.settings.acceptThreshold &&
    !input.reasons.includes('low_target_uniqueness') &&
    !input.reasons.includes('low_source_coverage') &&
    !input.reasons.includes('excessive_violations')
  ) {
    return 'accepted';
  }
  if (input.score >= input.settings.reviewThreshold) {
    return 'review';
  }
  return 'rejected';
}

export async function mapWithConcurrency<TInput, TOutput>(
  inputs: readonly TInput[],
  concurrency: number,
  mapOne: (input: TInput) => Promise<TOutput>,
): Promise<TOutput[]> {
  const safeConcurrency = Math.max(1, Math.floor(concurrency));
  const outputs: TOutput[] = new Array(inputs.length);
  let nextIndex = 0;

  async function worker(): Promise<void> {
    while (nextIndex < inputs.length) {
      const index = nextIndex;
      nextIndex += 1;
      outputs[index] = await mapOne(inputs[index] as TInput);
    }
  }

  await Promise.all(Array.from({ length: Math.min(safeConcurrency, inputs.length) }, () => worker()));
  return outputs;
}

function reviewWithoutValidation(
  candidate: KtxRelationshipDiscoveryCandidate,
  profiles: KtxRelationshipProfileArtifact,
  reason: 'validation_unavailable' | 'profile_unavailable' | 'validation_unattempted',
): KtxValidatedRelationshipDiscoveryCandidate {
  const sourceColumn = singleRelationshipColumn(candidate.from);
  const targetColumn = singleRelationshipColumn(candidate.to);
  const sourceProfile = profiles.columns[profileKey(candidate.from.table.name, sourceColumn)];
  const targetProfile = profiles.columns[profileKey(candidate.to.table.name, targetColumn)];

  return {
    ...candidate,
    status: 'review',
    score: Number((candidate.confidence * 0.6).toFixed(3)),
    validation: {
      targetUniqueness: targetProfile?.uniquenessRatio ?? 0,
      sourceCoverage: 0,
      violationCount: 0,
      violationRatio: 1,
      sourceNullRate: sourceProfile?.nullRate ?? 0,
      targetNullRate: targetProfile?.nullRate ?? 0,
      childDistinct: sourceProfile?.distinctCount ?? 0,
      parentDistinct: targetProfile?.distinctCount ?? 0,
      overlap: 0,
      checkedValues: 0,
      reasons: [reason],
    },
  };
}

export async function validateKtxRelationshipDiscoveryCandidates(
  input: ValidateKtxRelationshipDiscoveryCandidatesInput,
): Promise<KtxValidatedRelationshipDiscoveryCandidate[]> {
  const settings = mergeSettings(input.settings);
  if (!input.executor || !input.profiles.sqlAvailable || !input.dialect) {
    return input.candidates.map((candidate) =>
      reviewWithoutValidation(candidate, input.profiles, 'validation_unavailable'),
    );
  }

  const executor = input.executor;
  const dialect = input.dialect;

  async function validateCandidate(
    candidate: KtxRelationshipDiscoveryCandidate,
  ): Promise<KtxValidatedRelationshipDiscoveryCandidate> {
    const sourceColumn = singleRelationshipColumn(candidate.from);
    const targetColumn = singleRelationshipColumn(candidate.to);
    const sourceProfile = input.profiles.columns[profileKey(candidate.from.table.name, sourceColumn)];
    const targetProfile = input.profiles.columns[profileKey(candidate.to.table.name, targetColumn)];
    if (!sourceProfile || !targetProfile) {
      return reviewWithoutValidation(candidate, input.profiles, 'profile_unavailable');
    }

    const result = await executor.executeReadOnly(
      {
        connectionId: input.connectionId,
        sql: buildCoverageSql({
          dialect,
          childTable: candidate.from.table,
          childColumn: sourceColumn,
          parentTable: candidate.to.table,
          parentColumn: targetColumn,
          maxDistinctSourceValues: settings.maxDistinctSourceValues,
        }),
        maxRows: 1,
      },
      input.ctx,
    );
    const childDistinct = numberAt(result, 'child_distinct');
    const parentDistinct = numberAt(result, 'parent_distinct');
    const overlap = numberAt(result, 'overlap');
    const violationCount = numberAt(result, 'violation_count');
    const sourceCoverage = childDistinct === 0 ? 0 : overlap / childDistinct;
    const violationRatio = childDistinct === 0 ? 1 : violationCount / childDistinct;
    const targetUniqueness = targetProfile.uniquenessRatio;
    const reasons: string[] = [];

    if (targetUniqueness < settings.minTargetUniqueness) {
      reasons.push('low_target_uniqueness');
    }
    if (sourceCoverage < settings.minSourceCoverage) {
      reasons.push('low_source_coverage');
    }
    if (violationRatio > settings.maxViolationRatio) {
      reasons.push('excessive_violations');
    }
    if (reasons.length === 0) {
      reasons.push('validation_passed');
    }

    const candidateScore = score({
      candidateConfidence: candidate.confidence,
      targetUniqueness,
      sourceCoverage,
      violationRatio,
    });
    const candidateStatus = statusFor({ score: candidateScore, reasons, settings });
    if (candidate.source === 'llm_proposal' && candidateStatus === 'rejected') {
      reasons.push('llm_proposed_but_validation_failed');
    }
    return {
      ...candidate,
      status: candidateStatus,
      score: candidateScore,
      validation: {
        targetUniqueness,
        sourceCoverage,
        violationCount,
        violationRatio,
        sourceNullRate: sourceProfile.nullRate,
        targetNullRate: targetProfile.nullRate,
        childDistinct,
        parentDistinct,
        overlap,
        checkedValues: childDistinct,
        reasons,
      },
    };
  }

  const budgeted = applyKtxRelationshipValidationBudget({
    candidates: input.candidates,
    tableCount: input.tableCount ?? 0,
    budget: settings.validationBudget,
    score: (candidate) => candidate.confidence,
  });
  const validated = await mapWithConcurrency(
    budgeted.toValidate.map((entry) => entry.candidate),
    settings.concurrency,
    validateCandidate,
  );
  const byOriginalIndex = new Map<number, KtxValidatedRelationshipDiscoveryCandidate>();
  for (let index = 0; index < budgeted.toValidate.length; index += 1) {
    const originalIndex = budgeted.toValidate[index]?.originalIndex;
    const candidate = validated[index];
    if (originalIndex !== undefined && candidate) {
      byOriginalIndex.set(originalIndex, candidate);
    }
  }
  for (const entry of budgeted.deferred) {
    byOriginalIndex.set(
      entry.originalIndex,
      reviewWithoutValidation(entry.candidate, input.profiles, 'validation_unattempted'),
    );
  }

  return input.candidates.map((_, index) => {
    const candidate = byOriginalIndex.get(index);
    if (!candidate) {
      throw new Error(`Missing relationship validation result for candidate at index ${index}`);
    }
    return candidate;
  });
}
