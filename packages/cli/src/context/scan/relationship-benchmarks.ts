import { createHash } from 'node:crypto';
import { mkdtemp, readdir, readFile, stat, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { gunzipSync } from 'node:zlib';
import Database from 'better-sqlite3';
import YAML from 'yaml';
import { z } from 'zod';
import { getSqlDialectForDriver } from '../connections/dialects.js';
import type { KtxLlmRuntimePort } from '../llm/runtime-port.js';
import type { KtxEnrichedRelationship, KtxEnrichedSchema, KtxRelationshipType } from './enrichment-types.js';
import { snapshotToKtxEnrichedSchema } from './local-enrichment.js';
import type { KtxRelationshipDiscoveryCandidate } from './relationship-candidates.js';
import {
  generateKtxRelationshipDiscoveryCandidates,
  mergeKtxRelationshipDiscoveryCandidates,
} from './relationship-candidates.js';
import { proposeKtxRelationshipCandidatesWithLlm } from './relationship-llm-proposal.js';
import {
  discoverKtxCompositeRelationships,
  type KtxCompositePrimaryKeyCandidate,
  type KtxCompositeRelationshipCandidate,
} from './relationship-composite-candidates.js';
import { emptyKtxRelationshipProfileArtifact } from './relationship-diagnostics.js';
import { collectKtxFormalMetadataRelationships } from './relationship-formal-metadata.js';
import { resolveKtxRelationshipGraph } from './relationship-graph-resolver.js';
import { type KtxRelationshipReadOnlyExecutor, profileKtxRelationshipSchema } from './relationship-profiling.js';
import type { KtxRelationshipValidationBudget } from './relationship-budget.js';
import type { KtxRelationshipFixtureOrigin } from './relationship-scoring.js';
import { validateKtxRelationshipDiscoveryCandidates } from './relationship-validation.js';
import type { KtxQueryResult, KtxReadOnlyQueryInput, KtxScanContext, KtxSchemaSnapshot } from './types.js';

export const KTX_RELATIONSHIP_BENCHMARK_MODES = [
  'metadata_present',
  'declared_fks_removed',
  'declared_pks_removed',
  'declared_pks_and_declared_fks_removed',
  'llm_disabled',
  'profiling_disabled',
  'validation_disabled',
  'embeddings_disabled',
] as const;

export type KtxRelationshipBenchmarkMode = (typeof KTX_RELATIONSHIP_BENCHMARK_MODES)[number];

export const KTX_RELATIONSHIP_BENCHMARK_TIERS = ['unit', 'row_bearing', 'schema_only', 'smoke', 'product'] as const;

export type KtxRelationshipBenchmarkTier = (typeof KTX_RELATIONSHIP_BENCHMARK_TIERS)[number];

export type KtxRelationshipBenchmarkStatus = 'accepted' | 'review' | 'rejected';

export interface KtxRelationshipBenchmarkExpectedPk {
  table: string;
  columns: string[];
}

export interface KtxRelationshipBenchmarkExpectedLink {
  fromTable: string;
  fromColumns: string[];
  toTable: string;
  toColumns: string[];
  relationship: KtxRelationshipType;
}

export interface KtxRelationshipBenchmarkExpectedLinks {
  expectedPks: KtxRelationshipBenchmarkExpectedPk[];
  expectedLinks: KtxRelationshipBenchmarkExpectedLink[];
}

export interface KtxRelationshipBenchmarkFixture {
  id: string;
  name: string;
  tier: KtxRelationshipBenchmarkTier;
  origin: KtxRelationshipFixtureOrigin;
  thresholdEligible?: boolean;
  validationBudget?: KtxRelationshipValidationBudget;
  snapshot: KtxSchemaSnapshot;
  expected: KtxRelationshipBenchmarkExpectedLinks;
  defaultModes: KtxRelationshipBenchmarkMode[];
  dataPath: string | null;
  columnEmbeddings: Record<string, number[]>;
}

export interface KtxRelationshipBenchmarkDetectedPk {
  table: string;
  columns: string[];
  score: number;
  status: KtxRelationshipBenchmarkStatus;
}

export interface KtxRelationshipBenchmarkDetectedLink {
  fromTable: string;
  fromColumns: string[];
  toTable: string;
  toColumns: string[];
  relationship: KtxRelationshipType;
  score: number;
  status: KtxRelationshipBenchmarkStatus;
  source: string;
}

export interface KtxRelationshipBenchmarkDetectorResult {
  pks: KtxRelationshipBenchmarkDetectedPk[];
  links: KtxRelationshipBenchmarkDetectedLink[];
  validationBlocked: boolean;
  sqlQueries: number;
  llmCalls: number;
  runtimeSeconds: number;
}

export interface KtxRelationshipBenchmarkDetectorInput {
  fixtureId: string;
  mode: KtxRelationshipBenchmarkMode;
  snapshot: KtxSchemaSnapshot;
  schema: KtxEnrichedSchema;
  dataPath: string | null;
  validationBudget?: KtxRelationshipValidationBudget;
}

export interface KtxRelationshipBenchmarkDetector {
  detect(input: KtxRelationshipBenchmarkDetectorInput): Promise<KtxRelationshipBenchmarkDetectorResult>;
}

export interface KtxRelationshipBenchmarkMetrics {
  pkPrecision: number;
  pkRecall: number;
  pkF1: number;
  fkPrecision: number;
  fkRecall: number;
  fkF1: number;
  acceptedFalsePositiveCount: number;
  reviewRecall: number;
  acceptedOrReviewRecall: number;
  runtimeSeconds: number;
  sqlQueries: number;
  llmCalls: number;
}

export interface KtxRelationshipBenchmarkCaseResult {
  fixtureId: string;
  mode: KtxRelationshipBenchmarkMode;
  metrics: KtxRelationshipBenchmarkMetrics;
  expected: {
    pk: string[];
    fk: string[];
  };
  predicted: {
    pk: string[];
    fk: string[];
    acceptedFk: string[];
    reviewFk: string[];
  };
  falsePositives: {
    pk: string[];
    fk: string[];
  };
  falseNegatives: {
    pk: string[];
    fk: string[];
  };
  skippedComposite: {
    pk: string[];
    fk: string[];
  };
  validationBlocked: boolean;
}

export interface KtxRelationshipBenchmarkSuiteResult {
  cases: KtxRelationshipBenchmarkCaseResult[];
  validationBlockedCases: string[];
  aggregate: {
    caseCount: number;
    headlineCaseCount: number;
    headlinePkRecall: number;
    headlineFkRecall: number;
    headlineAcceptedOrReviewRecall: number;
    meanPkRecall: number;
    meanFkRecall: number;
    meanAcceptedOrReviewRecall: number;
  };
}

class KtxRelationshipBenchmarkSqliteExecutor implements KtxRelationshipReadOnlyExecutor {
  private readonly db: Database.Database;
  queryCount = 0;

  constructor(dataPath: string) {
    this.db = new Database(dataPath, { readonly: true, fileMustExist: true });
  }

  async executeReadOnly(input: KtxReadOnlyQueryInput, _ctx: KtxScanContext): Promise<KtxQueryResult> {
    this.queryCount += 1;
    const rows = this.db.prepare(input.sql).all() as Record<string, unknown>[];
    const headers = Object.keys(rows[0] ?? {});
    return {
      headers,
      rows: rows.map((row) => headers.map((header) => row[header])),
      totalRows: rows.length,
      rowCount: rows.length,
    };
  }

  close(): void {
    this.db.close();
  }
}

async function fixtureText(fixtureDir: string, fileName: string): Promise<string> {
  const rawPath = join(fixtureDir, fileName);
  try {
    return await readFile(rawPath, 'utf-8');
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'ENOENT') {
      throw error;
    }
  }

  const compressed = await readFile(`${rawPath}.gz`);
  return gunzipSync(compressed).toString('utf-8');
}

async function fixtureDataPath(fixtureDir: string): Promise<string | null> {
  const dataPath = join(fixtureDir, 'data.sqlite');
  try {
    const dataStat = await stat(dataPath);
    return dataStat.isFile() ? dataPath : null;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'ENOENT') {
      throw error;
    }
  }

  const compressedPath = `${dataPath}.gz`;
  try {
    const compressedStat = await stat(compressedPath);
    if (!compressedStat.isFile()) {
      return null;
    }
    const digest = createHash('sha256').update(fixtureDir).digest('hex').slice(0, 16);
    const tempRoot = await mkdtemp(join(tmpdir(), `ktx-relationship-benchmark-${digest}-`));
    const extractedPath = join(tempRoot, 'data.sqlite');
    await writeFile(extractedPath, gunzipSync(await readFile(compressedPath)));
    return extractedPath;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') {
      return null;
    }
    throw error;
  }
}

async function fixtureColumnEmbeddings(fixtureDir: string): Promise<Record<string, number[]>> {
  const embeddingsPath = join(fixtureDir, 'column-embeddings.json');
  try {
    const raw = await readFile(embeddingsPath, 'utf-8');
    const parsed = JSON.parse(raw) as Record<string, unknown>;
    return Object.fromEntries(
      Object.entries(parsed).flatMap(([columnId, value]) => {
        if (!Array.isArray(value) || value.some((item) => typeof item !== 'number')) {
          return [];
        }
        return [[columnId, value as number[]]];
      }),
    );
  } catch {
    return {};
  }
}

const modeSchema = z.enum(KTX_RELATIONSHIP_BENCHMARK_MODES);
const tierSchema = z.enum(KTX_RELATIONSHIP_BENCHMARK_TIERS);
const originSchema = z.enum(['synthetic', 'public', 'customer']);
const validationBudgetSchema = z.union([z.literal('all'), z.number().int().nonnegative()]);

const fixtureConfigSchema = z.object({
  id: z.string().min(1),
  name: z.string().min(1),
  tier: tierSchema.default('unit'),
  origin: originSchema,
  thresholdEligible: z.boolean().optional(),
  validationBudget: validationBudgetSchema.optional(),
  defaultModes: z.array(modeSchema).min(1),
});

const expectedLinksSchema = z.object({
  expectedPks: z.array(
    z.object({
      table: z.string().min(1),
      columns: z.array(z.string().min(1)).min(1),
    }),
  ),
  expectedLinks: z.array(
    z.object({
      fromTable: z.string().min(1),
      fromColumns: z.array(z.string().min(1)).min(1),
      toTable: z.string().min(1),
      toColumns: z.array(z.string().min(1)).min(1),
      relationship: z.enum(['many_to_one', 'one_to_many', 'one_to_one']),
    }),
  ),
});

function sortedUnique(values: Iterable<string>): string[] {
  return Array.from(new Set(values)).sort((left, right) => left.localeCompare(right));
}

function tupleKey(columns: readonly string[]): string {
  return `(${columns.join(',')})`;
}

function pkKey(pk: Pick<KtxRelationshipBenchmarkExpectedPk, 'table' | 'columns'>): string {
  return `${pk.table}.${tupleKey(pk.columns)}`;
}

function fkKey(
  link: Pick<KtxRelationshipBenchmarkExpectedLink, 'fromTable' | 'fromColumns' | 'toTable' | 'toColumns'>,
): string {
  return `${link.fromTable}.${tupleKey(link.fromColumns)}->${link.toTable}.${tupleKey(link.toColumns)}`;
}

function relationshipKey(link: KtxRelationshipBenchmarkDetectedLink): string {
  return fkKey(link);
}

function relationshipToBenchmarkLink(candidate: KtxEnrichedRelationship): KtxRelationshipBenchmarkDetectedLink {
  return {
    fromTable: candidate.from.table.name,
    fromColumns: candidate.from.columns,
    toTable: candidate.to.table.name,
    toColumns: candidate.to.columns,
    relationship: candidate.relationshipType,
    score: candidate.confidence,
    status: 'accepted',
    source: candidate.source,
  };
}

function broadCandidateToBenchmarkLink(
  candidate: Pick<KtxRelationshipDiscoveryCandidate, 'confidence' | 'from' | 'relationshipType' | 'source' | 'to'>,
): KtxRelationshipBenchmarkDetectedLink {
  return {
    fromTable: candidate.from.table.name,
    fromColumns: candidate.from.columns,
    toTable: candidate.to.table.name,
    toColumns: candidate.to.columns,
    relationship: candidate.relationshipType,
    score: candidate.confidence,
    status: 'review',
    source: candidate.source,
  };
}

function compositePkToBenchmarkPk(candidate: KtxCompositePrimaryKeyCandidate): KtxRelationshipBenchmarkDetectedPk {
  return {
    table: candidate.table.name,
    columns: candidate.columns,
    score: candidate.score,
    status: candidate.status,
  };
}

function compositeRelationshipToBenchmarkLink(
  candidate: KtxCompositeRelationshipCandidate,
): KtxRelationshipBenchmarkDetectedLink {
  return {
    fromTable: candidate.from.table.name,
    fromColumns: candidate.from.columns,
    toTable: candidate.to.table.name,
    toColumns: candidate.to.columns,
    relationship: candidate.relationshipType,
    score: candidate.confidence,
    status: candidate.status,
    source: candidate.source,
  };
}

function ratio(numerator: number, denominator: number): number {
  return denominator === 0 ? 1 : numerator / denominator;
}

function f1(precision: number, recall: number): number {
  return precision + recall === 0 ? 0 : (2 * precision * recall) / (precision + recall);
}

function difference(left: readonly string[], right: readonly string[]): string[] {
  const rightSet = new Set(right);
  return left.filter((item) => !rightSet.has(item));
}

function intersectionSize(left: readonly string[], right: readonly string[]): number {
  const rightSet = new Set(right);
  return left.filter((item) => rightSet.has(item)).length;
}

function compositePkKeys(expected: KtxRelationshipBenchmarkExpectedLinks): string[] {
  return sortedUnique(expected.expectedPks.filter((pk) => pk.columns.length > 1).map(pkKey));
}

function compositeFkKeys(expected: KtxRelationshipBenchmarkExpectedLinks): string[] {
  return sortedUnique(
    expected.expectedLinks.filter((link) => link.fromColumns.length > 1 || link.toColumns.length > 1).map(fkKey),
  );
}

function scalarExpectedPkKeys(expected: KtxRelationshipBenchmarkExpectedLinks): string[] {
  return sortedUnique(expected.expectedPks.map(pkKey));
}

function scalarExpectedFkKeys(expected: KtxRelationshipBenchmarkExpectedLinks): string[] {
  return sortedUnique(expected.expectedLinks.map(fkKey));
}

function scoreBenchmarkCase(input: {
  fixtureId: string;
  mode: KtxRelationshipBenchmarkMode;
  expected: KtxRelationshipBenchmarkExpectedLinks;
  detected: KtxRelationshipBenchmarkDetectorResult;
}): KtxRelationshipBenchmarkCaseResult {
  const expectedPk = scalarExpectedPkKeys(input.expected);
  const expectedFk = scalarExpectedFkKeys(input.expected);
  const predictedPk = sortedUnique(input.detected.pks.map(pkKey));
  const predictedFk = sortedUnique(input.detected.links.map(relationshipKey));
  const acceptedFk = sortedUnique(
    input.detected.links.filter((link) => link.status === 'accepted').map(relationshipKey),
  );
  const reviewFk = sortedUnique(input.detected.links.filter((link) => link.status === 'review').map(relationshipKey));
  const acceptedOrReviewFk = sortedUnique([...acceptedFk, ...reviewFk]);

  const truePositivePk = intersectionSize(predictedPk, expectedPk);
  const truePositiveFk = intersectionSize(acceptedFk, expectedFk);
  const acceptedOrReviewTruePositiveFk = intersectionSize(acceptedOrReviewFk, expectedFk);
  const reviewTruePositiveFk = intersectionSize(reviewFk, expectedFk);
  const pkPrecision = ratio(truePositivePk, predictedPk.length);
  const pkRecall = ratio(truePositivePk, expectedPk.length);
  const fkPrecision = ratio(truePositiveFk, acceptedFk.length);
  const fkRecall = ratio(truePositiveFk, expectedFk.length);

  const falsePositiveFk = difference(acceptedFk, expectedFk);
  return {
    fixtureId: input.fixtureId,
    mode: input.mode,
    metrics: {
      pkPrecision,
      pkRecall,
      pkF1: f1(pkPrecision, pkRecall),
      fkPrecision,
      fkRecall,
      fkF1: f1(fkPrecision, fkRecall),
      acceptedFalsePositiveCount: falsePositiveFk.length,
      reviewRecall: ratio(reviewTruePositiveFk, expectedFk.length),
      acceptedOrReviewRecall: ratio(acceptedOrReviewTruePositiveFk, expectedFk.length),
      runtimeSeconds: input.detected.runtimeSeconds,
      sqlQueries: input.detected.sqlQueries,
      llmCalls: input.detected.llmCalls,
    },
    expected: {
      pk: expectedPk,
      fk: expectedFk,
    },
    predicted: {
      pk: predictedPk,
      fk: predictedFk,
      acceptedFk,
      reviewFk,
    },
    falsePositives: {
      pk: difference(predictedPk, expectedPk),
      fk: falsePositiveFk,
    },
    falseNegatives: {
      pk: difference(expectedPk, predictedPk),
      fk: difference(expectedFk, acceptedOrReviewFk),
    },
    skippedComposite: {
      pk: difference(compositePkKeys(input.expected), predictedPk),
      fk: difference(compositeFkKeys(input.expected), acceptedOrReviewFk),
    },
    validationBlocked: input.detected.validationBlocked,
  };
}

export function maskKtxRelationshipBenchmarkSnapshot(
  snapshot: KtxSchemaSnapshot,
  mode: KtxRelationshipBenchmarkMode,
): KtxSchemaSnapshot {
  const relationshipDiscoveryMode =
    mode === 'declared_pks_and_declared_fks_removed' ||
    mode === 'llm_disabled' ||
    mode === 'profiling_disabled' ||
    mode === 'validation_disabled' ||
    mode === 'embeddings_disabled';
  const removePks = relationshipDiscoveryMode || mode === 'declared_pks_removed';
  const removeFks = relationshipDiscoveryMode || mode === 'declared_fks_removed';

  return {
    ...snapshot,
    scope: { ...snapshot.scope },
    metadata: { ...snapshot.metadata },
    tables: snapshot.tables.map((table) => ({
      ...table,
      columns: table.columns.map((column) => ({
        ...column,
        primaryKey: removePks ? false : column.primaryKey,
      })),
      foreignKeys: removeFks ? [] : table.foreignKeys.map((foreignKey) => ({ ...foreignKey })),
    })),
  };
}

export function isKtxRelationshipBenchmarkTuningEligible(input: {
  fixture: Pick<KtxRelationshipBenchmarkFixture, 'tier' | 'thresholdEligible'>;
  mode: KtxRelationshipBenchmarkMode;
  validationBlocked: boolean;
}): boolean {
  if (input.validationBlocked || input.mode !== 'declared_pks_and_declared_fks_removed') {
    return false;
  }

  if (input.fixture.tier === 'smoke' || input.fixture.tier === 'schema_only') {
    return false;
  }

  if (input.fixture.thresholdEligible !== undefined) {
    return input.fixture.thresholdEligible;
  }

  return input.fixture.tier === 'unit' || input.fixture.tier === 'row_bearing';
}

export function ktxRelationshipBenchmarkDetectorWithLlm(
  llmRuntime: KtxLlmRuntimePort,
): KtxRelationshipBenchmarkDetector {
  return {
    async detect(input) {
      const startedAt = performance.now();
      const formalMetadata = collectKtxFormalMetadataRelationships(input.schema);
      const formalLinks = formalMetadata.accepted.map((relationship) => relationshipToBenchmarkLink(relationship));
      const acceptedKeys = new Set(formalLinks.map(fkKey));
      const sqliteDataAvailable = Boolean(input.dataPath && input.snapshot.driver === 'sqlite');
      const dialect = getSqlDialectForDriver(input.snapshot.driver);
      const profilingExecutor =
        sqliteDataAvailable && input.mode !== 'profiling_disabled'
          ? new KtxRelationshipBenchmarkSqliteExecutor(input.dataPath as string)
          : null;
      const validationExecutor = profilingExecutor && input.mode !== 'validation_disabled' ? profilingExecutor : null;
      const profiles =
        input.mode === 'profiling_disabled'
          ? emptyKtxRelationshipProfileArtifact({
              connectionId: input.snapshot.connectionId,
              driver: input.snapshot.driver,
              reason: 'relationship_benchmark_profiling_disabled',
            })
          : await profileKtxRelationshipSchema({
              connectionId: input.snapshot.connectionId,
              driver: input.snapshot.driver,
              dialect,
              schema: input.schema,
              executor: profilingExecutor,
              ctx: { runId: `relationship-benchmark:${input.fixtureId}:${input.mode}:profile` },
            });
      const broadRelationshipCandidates = generateKtxRelationshipDiscoveryCandidates(input.schema, {
        profiles,
        useEmbeddings: input.mode !== 'embeddings_disabled',
      });
      const llmProposalResult =
        input.mode === 'llm_disabled'
          ? { candidates: [], warnings: [], llmCalls: 0, summary: 'skipped' as const }
          : await proposeKtxRelationshipCandidatesWithLlm({
              connectionId: input.snapshot.connectionId,
              schema: input.schema,
              profile: profiles,
              llmRuntime,
            });
      const candidates = mergeKtxRelationshipDiscoveryCandidates([
        ...broadRelationshipCandidates,
        ...llmProposalResult.candidates,
      ]);
      const validationBudget =
        input.validationBudget === 'all'
          ? 'all'
          : input.validationBudget === undefined
            ? 'all'
            : Math.max(0, input.validationBudget - profiles.queryCount);
      const validatedBroadCandidates = await validateKtxRelationshipDiscoveryCandidates({
        connectionId: input.snapshot.connectionId,
        dialect,
        candidates,
        profiles,
        executor: validationExecutor,
        ctx: { runId: `relationship-benchmark:${input.fixtureId}:${input.mode}:validate` },
        tableCount: input.schema.tables.length,
        settings: {
          validationBudget,
        },
      });
      const compositeDetection =
        validationBudget === 'all' &&
        validationExecutor &&
        input.mode !== 'profiling_disabled' &&
        input.mode !== 'validation_disabled'
          ? await discoverKtxCompositeRelationships({
              connectionId: input.snapshot.connectionId,
              dialect,
              schema: input.schema,
              profiles,
              executor: validationExecutor,
              ctx: { runId: `relationship-benchmark:${input.fixtureId}:${input.mode}:composite` },
            })
          : { primaryKeys: [], relationships: [], queryCount: 0, warnings: [] };
      profilingExecutor?.close();
      const graph = resolveKtxRelationshipGraph({
        schema: input.schema,
        profiles,
        candidates: validatedBroadCandidates,
      });
      const acceptedBroadCandidates = graph.relationships
        .filter((candidate) => candidate.status === 'accepted')
        .map((candidate) => ({
          ...broadCandidateToBenchmarkLink(candidate),
          score: candidate.fkScore,
          status: 'accepted' as const,
        }))
        .filter((candidate) => !acceptedKeys.has(fkKey(candidate)));
      const reviewCandidates = graph.relationships
        .filter((candidate) => candidate.status === 'review')
        .map((candidate) => ({
          ...broadCandidateToBenchmarkLink(candidate),
          score: candidate.fkScore,
          status: 'review' as const,
        }))
        .filter((candidate) => !acceptedKeys.has(fkKey(candidate)));
      const resolvedPks = graph.pks
        .filter((pk) => pk.status !== 'rejected')
        .map((pk) => ({
          table: pk.table,
          columns: pk.columns,
          score: pk.pkScore,
          status: pk.status,
        }));
      const compositePks = compositeDetection.primaryKeys.map(compositePkToBenchmarkPk);
      const allPksByKey = new Map([...resolvedPks, ...compositePks].map((candidate) => [pkKey(candidate), candidate]));
      const pks = sortedUnique(allPksByKey.keys()).flatMap((key) => {
        const candidate = allPksByKey.get(key);
        return candidate ? [candidate] : [];
      });

      return {
        pks,
        links: [
          ...formalLinks,
          ...acceptedBroadCandidates,
          ...reviewCandidates,
          ...compositeDetection.relationships
            .map(compositeRelationshipToBenchmarkLink)
            .filter((candidate) => !acceptedKeys.has(fkKey(candidate))),
        ],
        validationBlocked:
          input.mode === 'validation_disabled' ||
          input.mode === 'profiling_disabled' ||
          (input.dataPath !== null && broadRelationshipCandidates.length > 0 && !profiles.sqlAvailable),
        sqlQueries: profilingExecutor?.queryCount ?? profiles.queryCount,
        llmCalls: llmProposalResult.llmCalls,
        runtimeSeconds: Number(((performance.now() - startedAt) / 1000).toFixed(6)),
      };
    },
  };
}

export function currentKtxRelationshipBenchmarkDetector(): KtxRelationshipBenchmarkDetector {
  return {
    async detect(input) {
      const startedAt = performance.now();
      const formalMetadata = collectKtxFormalMetadataRelationships(input.schema);
      const formalLinks = formalMetadata.accepted.map((relationship) => relationshipToBenchmarkLink(relationship));
      const acceptedKeys = new Set(formalLinks.map(fkKey));
      const sqliteDataAvailable = Boolean(input.dataPath && input.snapshot.driver === 'sqlite');
      const dialect = getSqlDialectForDriver(input.snapshot.driver);
      const profilingExecutor =
        sqliteDataAvailable && input.mode !== 'profiling_disabled'
          ? new KtxRelationshipBenchmarkSqliteExecutor(input.dataPath as string)
          : null;
      const validationExecutor = profilingExecutor && input.mode !== 'validation_disabled' ? profilingExecutor : null;
      const profiles =
        input.mode === 'profiling_disabled'
          ? emptyKtxRelationshipProfileArtifact({
              connectionId: input.snapshot.connectionId,
              driver: input.snapshot.driver,
              reason: 'relationship_benchmark_profiling_disabled',
            })
          : await profileKtxRelationshipSchema({
              connectionId: input.snapshot.connectionId,
              driver: input.snapshot.driver,
              dialect,
              schema: input.schema,
              executor: profilingExecutor,
              ctx: { runId: `relationship-benchmark:${input.fixtureId}:${input.mode}:profile` },
            });
      const broadRelationshipCandidates = generateKtxRelationshipDiscoveryCandidates(input.schema, {
        profiles,
        useEmbeddings: input.mode !== 'embeddings_disabled',
      });
      const validationBudget =
        input.validationBudget === 'all'
          ? 'all'
          : input.validationBudget === undefined
            ? 'all'
            : Math.max(0, input.validationBudget - profiles.queryCount);
      const validatedBroadCandidates = await validateKtxRelationshipDiscoveryCandidates({
        connectionId: input.snapshot.connectionId,
        dialect,
        candidates: broadRelationshipCandidates,
        profiles,
        executor: validationExecutor,
        ctx: { runId: `relationship-benchmark:${input.fixtureId}:${input.mode}:validate` },
        tableCount: input.schema.tables.length,
        settings: {
          validationBudget,
        },
      });
      const compositeDetection =
        validationBudget === 'all' &&
        validationExecutor &&
        input.mode !== 'profiling_disabled' &&
        input.mode !== 'validation_disabled'
          ? await discoverKtxCompositeRelationships({
              connectionId: input.snapshot.connectionId,
              dialect,
              schema: input.schema,
              profiles,
              executor: validationExecutor,
              ctx: { runId: `relationship-benchmark:${input.fixtureId}:${input.mode}:composite` },
            })
          : { primaryKeys: [], relationships: [], queryCount: 0, warnings: [] };
      profilingExecutor?.close();
      const graph = resolveKtxRelationshipGraph({
        schema: input.schema,
        profiles,
        candidates: validatedBroadCandidates,
      });
      const acceptedBroadCandidates = graph.relationships
        .filter((candidate) => candidate.status === 'accepted')
        .map((candidate) => ({
          ...broadCandidateToBenchmarkLink(candidate),
          score: candidate.fkScore,
          status: 'accepted' as const,
        }))
        .filter((candidate) => !acceptedKeys.has(fkKey(candidate)));
      const reviewCandidates = graph.relationships
        .filter((candidate) => candidate.status === 'review')
        .map((candidate) => ({
          ...broadCandidateToBenchmarkLink(candidate),
          score: candidate.fkScore,
          status: 'review' as const,
        }))
        .filter((candidate) => !acceptedKeys.has(fkKey(candidate)));
      const resolvedPks = graph.pks
        .filter((pk) => pk.status !== 'rejected')
        .map((pk) => ({
          table: pk.table,
          columns: pk.columns,
          score: pk.pkScore,
          status: pk.status,
        }));
      const compositePks = compositeDetection.primaryKeys.map(compositePkToBenchmarkPk);
      const allPksByKey = new Map([...resolvedPks, ...compositePks].map((candidate) => [pkKey(candidate), candidate]));
      const pks = sortedUnique(allPksByKey.keys()).flatMap((key) => {
        const candidate = allPksByKey.get(key);
        return candidate ? [candidate] : [];
      });

      return {
        pks,
        links: [
          ...formalLinks,
          ...acceptedBroadCandidates,
          ...reviewCandidates,
          ...compositeDetection.relationships
            .map(compositeRelationshipToBenchmarkLink)
            .filter((candidate) => !acceptedKeys.has(fkKey(candidate))),
        ],
        validationBlocked:
          input.mode === 'validation_disabled' ||
          input.mode === 'profiling_disabled' ||
          (input.dataPath !== null && broadRelationshipCandidates.length > 0 && !profiles.sqlAvailable),
        sqlQueries: profilingExecutor?.queryCount ?? profiles.queryCount,
        llmCalls: 0,
        runtimeSeconds: Number(((performance.now() - startedAt) / 1000).toFixed(6)),
      };
    },
  };
}

export async function loadKtxRelationshipBenchmarkFixture(
  fixtureDir: string,
): Promise<KtxRelationshipBenchmarkFixture> {
  const [fixtureRaw, snapshotRaw, expectedRaw] = await Promise.all([
    fixtureText(fixtureDir, 'fixture.yaml'),
    fixtureText(fixtureDir, 'snapshot.json'),
    fixtureText(fixtureDir, 'expected-links.yaml'),
  ]);
  const fixture = fixtureConfigSchema.parse(YAML.parse(fixtureRaw));
  const expected = expectedLinksSchema.parse(YAML.parse(expectedRaw));
  const snapshot = JSON.parse(snapshotRaw) as KtxSchemaSnapshot;

  return {
    ...fixture,
    snapshot,
    expected,
    dataPath: await fixtureDataPath(fixtureDir),
    columnEmbeddings: await fixtureColumnEmbeddings(fixtureDir),
  };
}

export async function loadKtxRelationshipBenchmarkFixtures(
  fixtureRoot: string,
): Promise<KtxRelationshipBenchmarkFixture[]> {
  const entries = await readdir(fixtureRoot, { withFileTypes: true });
  const fixtureDirs = entries
    .filter((entry) => entry.isDirectory())
    .map((entry) => join(fixtureRoot, entry.name))
    .sort((left, right) => left.localeCompare(right));

  return Promise.all(fixtureDirs.map((fixtureDir) => loadKtxRelationshipBenchmarkFixture(fixtureDir)));
}

export async function runKtxRelationshipBenchmarkCase(input: {
  fixture: KtxRelationshipBenchmarkFixture;
  mode: KtxRelationshipBenchmarkMode;
  detector?: KtxRelationshipBenchmarkDetector;
}): Promise<KtxRelationshipBenchmarkCaseResult> {
  const snapshot = maskKtxRelationshipBenchmarkSnapshot(input.fixture.snapshot, input.mode);
  const embeddings =
    input.mode === 'embeddings_disabled'
      ? new Map<string, number[]>()
      : new Map(Object.entries(input.fixture.columnEmbeddings));
  const schema = snapshotToKtxEnrichedSchema(snapshot, embeddings);
  const detected = await (input.detector ?? currentKtxRelationshipBenchmarkDetector()).detect({
    fixtureId: input.fixture.id,
    mode: input.mode,
    snapshot,
    schema,
    dataPath: input.fixture.dataPath,
    validationBudget: input.fixture.validationBudget,
  });

  return scoreBenchmarkCase({
    fixtureId: input.fixture.id,
    mode: input.mode,
    expected: input.fixture.expected,
    detected,
  });
}

export async function runKtxRelationshipBenchmarkSuite(input: {
  fixtures: KtxRelationshipBenchmarkFixture[];
  detector?: KtxRelationshipBenchmarkDetector;
}): Promise<KtxRelationshipBenchmarkSuiteResult> {
  const cases: KtxRelationshipBenchmarkCaseResult[] = [];
  for (const fixture of input.fixtures) {
    for (const mode of fixture.defaultModes) {
      cases.push(
        await runKtxRelationshipBenchmarkCase({
          fixture,
          mode,
          detector: input.detector,
        }),
      );
    }
  }

  const fixtureById = new Map(input.fixtures.map((fixture) => [fixture.id, fixture]));
  const headlineCases = cases.filter((item) => {
    const fixture = fixtureById.get(item.fixtureId);
    return fixture
      ? isKtxRelationshipBenchmarkTuningEligible({
          fixture,
          mode: item.mode,
          validationBlocked: item.validationBlocked,
        })
      : false;
  });
  const aggregateCases = cases.length === 0 ? [] : cases;

  return {
    cases,
    validationBlockedCases: cases
      .filter((item) => item.validationBlocked)
      .map((item) => `${item.fixtureId}:${item.mode}`),
    aggregate: {
      caseCount: cases.length,
      headlineCaseCount: headlineCases.length,
      headlinePkRecall: mean(headlineCases.map((item) => item.metrics.pkRecall)),
      headlineFkRecall: mean(headlineCases.map((item) => item.metrics.fkRecall)),
      headlineAcceptedOrReviewRecall: mean(headlineCases.map((item) => item.metrics.acceptedOrReviewRecall)),
      meanPkRecall: mean(aggregateCases.map((item) => item.metrics.pkRecall)),
      meanFkRecall: mean(aggregateCases.map((item) => item.metrics.fkRecall)),
      meanAcceptedOrReviewRecall: mean(aggregateCases.map((item) => item.metrics.acceptedOrReviewRecall)),
    },
  };
}

function mean(values: number[]): number {
  if (values.length === 0) {
    return 0;
  }
  return values.reduce((sum, value) => sum + value, 0) / values.length;
}
