import pLimit from 'p-limit';
import type { KtxLlmRuntimePort } from '../../context/llm/runtime-port.js';
import { getSqlDialectForDriver } from '../connections/dialects.js';
import { buildDefaultKtxProjectConfig, type KtxScanRelationshipConfig } from '../project/config.js';
import { KtxDescriptionGenerator } from './description-generation.js';
import { buildKtxColumnEmbeddingText } from './embedding-text.js';
import {
  completedKtxScanEnrichmentStateSummary,
  computeKtxDescriptionsStageHash,
  computeKtxEmbeddingsStageHash,
  computeKtxRelationshipsStageHash,
  computeKtxScanDescriptionDigest,
  KTX_SCAN_ENRICHMENT_STAGES,
  type KtxScanEmbeddingIdentity,
  type KtxScanEnrichmentStateStore,
  type KtxScanLlmIdentity,
  summarizeKtxScanEnrichmentState,
} from './enrichment-state.js';
import { skippedKtxScanEnrichmentSummary } from './enrichment-summary.js';
import type { KtxScanDescriptionResumeStore } from './local-enrichment-artifacts.js';
import { tableRefKey } from './table-ref.js';
import type {
  KtxEmbeddingUpdate,
  KtxEnrichedColumn,
  KtxEnrichedRelationship,
  KtxEnrichedSchema,
  KtxEnrichedTable,
  KtxRelationshipEndpoint,
  KtxRelationshipUpdate,
} from './enrichment-types.js';
import type { KtxCompositeRelationshipCandidate } from './relationship-composite-candidates.js';
import type { KtxRelationshipDetectionStopReason } from './relationship-detection-budget.js';
import type { KtxResolvedRelationshipDiscoveryCandidate } from './relationship-graph-resolver.js';
import { discoverKtxRelationships } from './relationship-discovery.js';
import type { KtxRelationshipProfileArtifact } from './relationship-profiling.js';
import type {
  KtxEmbeddingPort,
  KtxProgressPort,
  KtxScanConnector,
  KtxScanContext,
  KtxScanEnrichmentStage,
  KtxScanEnrichmentStateSummary,
  KtxScanEnrichmentSummary,
  KtxScanMode,
  KtxScanRelationshipSummary,
  KtxScanWarning,
  KtxSchemaColumn,
  KtxSchemaForeignKey,
  KtxSchemaSnapshot,
  KtxSchemaTable,
  KtxTableRef,
} from './types.js';

// Parallel per-table description generations. Default 4; raise via
// KTX_ENRICH_TABLE_CONCURRENCY for large schemas (the rate-limit governor still
// throttles if the provider pushes back, so a higher cap is safe headroom).
const DESCRIPTION_TABLE_CONCURRENCY = (() => {
  const raw = Number(process.env.KTX_ENRICH_TABLE_CONCURRENCY);
  return Number.isInteger(raw) && raw >= 1 && raw <= 64 ? raw : 4;
})();

export interface KtxLocalScanEnrichmentProviders {
  llmRuntime: KtxLlmRuntimePort;
  embedding?: KtxEmbeddingPort | null;
}

export interface KtxLocalScanEnrichmentInput {
  connectionId: string;
  mode: KtxScanMode;
  detectRelationships?: boolean;
  /**
   * Enrichment stages to (re)run this invocation. Undefined runs every eligible
   * stage and respects the completed-stage short-circuit (spec-19 resume). When
   * present, only the named stages run — each force-recomputes (bypassing the
   * short-circuit) while unselected stages are left untouched on disk (D3).
   */
  stages?: KtxScanEnrichmentStage[];
  connector: KtxScanConnector;
  snapshot?: KtxSchemaSnapshot;
  context: KtxScanContext;
  providers: KtxLocalScanEnrichmentProviders | null;
  stateStore?: KtxScanEnrichmentStateStore | null;
  /**
   * Durable per-batch resume record for the descriptions stage. When present, an
   * interrupted descriptions stage resumes by re-enriching only the tables not
   * already flushed (inputHash-gated). Null/undefined disables incremental flush.
   */
  descriptionResumeStore?: KtxScanDescriptionResumeStore | null;
  /**
   * Lazily loads the descriptions already persisted in the on-disk _schema, used
   * to feed embeddings + relationships their description context when the
   * descriptions stage does not run this invocation (e.g. `--stages relationships`).
   * Called at most once and only when a downstream stage needs it, so a normal
   * full run never pays the read.
   */
  loadPriorDescriptions?: (snapshot: KtxSchemaSnapshot) => Promise<KtxLocalScanEnrichmentResult['descriptionUpdates']>;
  syncId?: string;
  /** Description-LLM identity that keys the descriptions + relationships stage hashes. */
  llmIdentity?: KtxScanLlmIdentity;
  /** Embedding-model identity that keys the embeddings stage hash. */
  embeddingIdentity?: KtxScanEmbeddingIdentity;
  relationshipSettings?: KtxScanRelationshipConfig;
  now?: () => Date;
  /**
   * Invoked once the last non-relationship stage completes and before
   * relationship detection runs, so the descriptions + embeddings reach the
   * queryable layer even if the relationship stage is later interrupted.
   */
  onCheckpoint?: (checkpoint: KtxLocalScanEnrichmentResult) => Promise<void>;
}

export interface KtxLocalScanEnrichmentResult {
  snapshot: KtxSchemaSnapshot;
  summary: KtxScanEnrichmentSummary;
  relationships: KtxScanRelationshipSummary;
  state: KtxScanEnrichmentStateSummary;
  warnings: KtxScanWarning[];
  descriptionUpdates: Array<{
    table: KtxTableRef;
    tableDescription: string | null;
    columnDescriptions: Record<string, string | null>;
  }>;
  embeddingUpdates: KtxEmbeddingUpdate[];
  relationshipUpdate: KtxRelationshipUpdate | null;
  relationshipProfile: KtxRelationshipProfileArtifact | null;
  resolvedRelationships: KtxResolvedRelationshipDiscoveryCandidate[] | null;
  compositeRelationships: KtxCompositeRelationshipCandidate[] | null;
  relationshipPartial: { reason: KtxRelationshipDetectionStopReason } | null;
}

function tableId(table: KtxSchemaTable): string {
  return [table.catalog, table.db, table.name].filter((value): value is string => Boolean(value)).join('.');
}

function columnId(table: KtxSchemaTable, column: KtxSchemaColumn): string {
  return `${tableId(table)}.${column.name}`;
}

function tableRef(table: KtxSchemaTable): KtxTableRef {
  return {
    catalog: table.catalog,
    db: table.db,
    name: table.name,
  };
}

function endpoint(table: KtxEnrichedTable, column: KtxEnrichedColumn): KtxRelationshipEndpoint {
  return {
    tableId: table.id,
    columnIds: [column.id],
    table: table.ref,
    columns: [column.name],
  };
}

function relationshipId(from: KtxRelationshipEndpoint, to: KtxRelationshipEndpoint): string {
  return `${from.tableId}:(${from.columnIds.join(',')})->${to.tableId}:(${to.columnIds.join(',')})`;
}

function targetMatchesForeignKey(table: KtxEnrichedTable, foreignKey: KtxSchemaForeignKey): boolean {
  return (
    table.ref.name === foreignKey.toTable &&
    (foreignKey.toCatalog === null || table.ref.catalog === foreignKey.toCatalog) &&
    (foreignKey.toDb === null || table.ref.db === foreignKey.toDb)
  );
}

function assertConnectorDriverMatchesSnapshot(input: {
  connector: KtxScanConnector;
  snapshot: KtxSchemaSnapshot;
  connectionId: string;
}): void {
  if (input.connector.driver !== input.snapshot.driver) {
    throw new Error(
      `ktx scan connector driver "${input.connector.driver}" does not match snapshot driver "${input.snapshot.driver}" for connection "${input.connectionId}"`,
    );
  }
}

function formalRelationshipsFromSnapshot(
  snapshot: KtxSchemaSnapshot,
  tables: readonly KtxEnrichedTable[],
): KtxEnrichedRelationship[] {
  const tableById = new Map(tables.map((table) => [table.id, table]));
  const relationships: KtxEnrichedRelationship[] = [];

  for (const sourceTableSnapshot of snapshot.tables) {
    const sourceTable = tableById.get(tableId(sourceTableSnapshot));
    if (!sourceTable) {
      continue;
    }

    for (const foreignKey of sourceTableSnapshot.foreignKeys) {
      const sourceColumn = sourceTable.columns.find((column) => column.name === foreignKey.fromColumn);
      const targetTable = tables.find((table) => targetMatchesForeignKey(table, foreignKey));
      const targetColumn = targetTable?.columns.find((column) => column.name === foreignKey.toColumn);
      if (!sourceColumn || !targetTable || !targetColumn) {
        continue;
      }

      const from = endpoint(sourceTable, sourceColumn);
      const to = endpoint(targetTable, targetColumn);
      relationships.push({
        id: relationshipId(from, to),
        source: 'formal',
        from,
        to,
        relationshipType: 'many_to_one',
        confidence: 1,
        isPrimaryKeyReference: true,
      });
    }
  }

  return relationships.sort((left, right) => left.id.localeCompare(right.id));
}

function providerlessEnrichedWarning(relationshipDetection: boolean): KtxScanWarning {
  return {
    code: 'scan_enrichment_backend_not_configured',
    message:
      'Skipping description and embedding enrichment because scan.enrichment.mode is not configured; relationship discovery still ran.',
    recoverable: true,
    metadata: {
      skippedStages: ['descriptions', 'embeddings'],
      relationshipDetection,
    },
  };
}

function stagePrerequisiteReason(stage: KtxScanEnrichmentStage): string {
  switch (stage) {
    case 'descriptions':
      return 'LLM enrichment is not configured (set scan.enrichment.mode and an LLM provider)';
    case 'embeddings':
      return 'no embedding provider is configured (set scan.enrichment.embeddings)';
    case 'relationships':
      return 'relationship discovery is disabled (scan.relationships.enabled is false)';
  }
}

export function createDeterministicLocalScanEnrichmentProviders(): KtxLocalScanEnrichmentProviders {
  return {
    llmRuntime: deterministicLlmRuntime(),
  };
}

function deterministicLlmRuntime(): KtxLlmRuntimePort {
  return {
    async generateText(input) {
      return `Deterministic description for ${input.prompt.slice(0, 64).trim() || 'data source'}`;
    },
    async generateObject(input) {
      if (input.prompt.includes('Sample rows:')) {
        const columns = Array.from(input.prompt.matchAll(/^- ([^\s(]+)/gm), (match) => ({
          name: match[1] ?? 'column',
          description: `Deterministic description for ${match[1] ?? 'column'}`,
        }));
        return {
          tableDescription: `Deterministic description for ${input.prompt.slice(0, 64).trim() || 'table'}`,
          columns,
        } as never;
      }
      return { pkCandidates: [], fkCandidates: [] } as never;
    },
    async runAgentLoop() {
      return { stopReason: 'natural' };
    },
    subprocessForkSpec() {
      return null;
    },
  };
}

export function snapshotToKtxEnrichedSchema(
  snapshot: KtxSchemaSnapshot,
  embeddingsByColumnId: ReadonlyMap<string, number[]> = new Map(),
  descriptions: KtxLocalScanEnrichmentResult['descriptionUpdates'] = [],
): KtxEnrichedSchema {
  const descriptionByTable = new Map(descriptions.map((item) => [tableRefKey(item.table), item]));
  const tables: KtxEnrichedTable[] = snapshot.tables.map((table) => {
    const id = tableId(table);
    const ref = tableRef(table);
    const tableDescription = descriptionByTable.get(tableRefKey(ref));
    const columns: KtxEnrichedColumn[] = table.columns.map((column) => {
      const idForColumn = columnId(table, column);
      const aiColumnDescription = tableDescription?.columnDescriptions[column.name] ?? null;
      return {
        id: idForColumn,
        tableId: id,
        tableRef: ref,
        name: column.name,
        nativeType: column.nativeType,
        normalizedType: column.normalizedType,
        dimensionType: column.dimensionType,
        nullable: column.nullable,
        primaryKey: column.primaryKey,
        parentColumnId: null,
        descriptions: {
          ...(column.comment ? { db: column.comment } : {}),
          ...(aiColumnDescription ? { ai: aiColumnDescription } : {}),
        },
        embedding: embeddingsByColumnId.get(idForColumn) ?? null,
        sampleValues: null,
        cardinality: null,
      };
    });
    return {
      id,
      ref,
      enabled: true,
      descriptions: {
        ...(table.comment ? { db: table.comment } : {}),
        ...(tableDescription?.tableDescription ? { ai: tableDescription.tableDescription } : {}),
      },
      columns,
    };
  });

  return {
    connectionId: snapshot.connectionId,
    tables,
    relationships: formalRelationshipsFromSnapshot(snapshot, tables),
  };
}

function embeddingBatchSize(maxBatchSize: number): number {
  return Number.isInteger(maxBatchSize) && maxBatchSize > 0 ? maxBatchSize : 100;
}

type KtxScanDescriptionUpdate = KtxLocalScanEnrichmentResult['descriptionUpdates'][number];

// Per-batch flush cadence: bounds the at-risk window (and the manifest-rewrite /
// git-commit cost) to a small number of tables.
const DESCRIPTION_FLUSH_EVERY = 10;

function isEnrichedDescriptionUpdate(update: KtxScanDescriptionUpdate): boolean {
  return update.tableDescription !== null || Object.values(update.columnDescriptions).some((value) => value !== null);
}

function nullDescriptionUpdate(table: KtxSchemaTable): KtxScanDescriptionUpdate {
  return {
    table: tableRef(table),
    tableDescription: null,
    columnDescriptions: Object.fromEntries(table.columns.map((column) => [column.name, null])),
  };
}

async function generateDescriptions(input: {
  snapshot: KtxSchemaSnapshot;
  connector: KtxScanConnector;
  context: KtxScanContext;
  providers: KtxLocalScanEnrichmentProviders;
  inputHash: string;
  resumeStore?: KtxScanDescriptionResumeStore | null;
  progress?: KtxProgressPort;
  warnings?: KtxScanWarning[];
}): Promise<KtxLocalScanEnrichmentResult['descriptionUpdates']> {
  const warningSink = input.warnings;
  const generator = new KtxDescriptionGenerator({
    llmRuntime: input.providers.llmRuntime,
    ...(input.context.logger ? { logger: input.context.logger } : {}),
    ...(warningSink
      ? {
          onWarning: (warning: KtxScanWarning) => {
            warningSink.push(warning);
          },
        }
      : {}),
    settings: {
      columnMaxWords: 16,
      tableMaxWords: 24,
      dataSourceMaxWords: 32,
      concurrencyLimit: 4,
    },
  });

  const totalTables = input.snapshot.tables.length;
  if (totalTables === 0) {
    await input.progress?.update(1, 'No tables to describe');
    return [];
  }

  // Resume: recover already-enriched tables (inputHash-gated) and re-issue LLM
  // calls only for the remainder. A failed/skipped table carries null descriptions
  // and is not recovered, so it is retried.
  const recovered = input.resumeStore ? ((await input.resumeStore.load(input.inputHash)) ?? []) : [];
  const enrichedById = new Map<string, KtxScanDescriptionUpdate>();
  for (const update of recovered) {
    if (isEnrichedDescriptionUpdate(update)) {
      enrichedById.set(tableRefKey(update.table), update);
    }
  }
  const remaining = input.snapshot.tables.filter((table) => !enrichedById.has(tableRefKey(tableRef(table))));
  const recoveredCount = enrichedById.size;
  if (recoveredCount > 0) {
    input.context.logger?.info(
      `[enrich] resume: recovered ${recoveredCount}/${totalTables} descriptions, enriching ${remaining.length}`,
    );
  }

  const pendingChanged = new Set<string>();
  let sinceFlush = 0;
  let flushing = false;
  const flush = async (force: boolean): Promise<void> => {
    if (!input.resumeStore || flushing || pendingChanged.size === 0) {
      return;
    }
    if (!force && sinceFlush < DESCRIPTION_FLUSH_EVERY) {
      return;
    }
    flushing = true;
    const changedTableNames = new Set(pendingChanged);
    pendingChanged.clear();
    sinceFlush = 0;
    try {
      await input.resumeStore.flush({
        inputHash: input.inputHash,
        snapshot: input.snapshot,
        descriptionUpdates: [...enrichedById.values()],
        changedTableNames,
      });
    } finally {
      flushing = false;
    }
  };

  const limitTable = pLimit(DESCRIPTION_TABLE_CONCURRENCY);
  await Promise.all(
    remaining.map((table, index) =>
      limitTable(async () => {
        await input.progress?.update(
          (recoveredCount + index + 1) / totalTables,
          `Generating descriptions ${recoveredCount + index + 1}/${totalTables} (${table.name}, ${table.columns.length} cols)`,
          {
            transient: true,
          },
        );
        // Stage-level guarantee: a single table's failure costs one missing
        // description, never the whole stage's output. (generateBatchedTableDescriptions
        // already degrades its own failures to null descriptions; this backstop keeps
        // the guarantee at the fan-out even if a future path throws.) A genuine
        // cancellation still propagates so the stage fails and resumes.
        let update: KtxScanDescriptionUpdate;
        try {
          const batched = await generator.generateBatchedTableDescriptions({
            connectionId: input.snapshot.connectionId,
            connector: input.connector,
            context: input.context,
            dataSourceType: input.snapshot.driver,
            supportsNestedAnalysis: input.connector.capabilities.nestedAnalysis,
            table: {
              catalog: table.catalog,
              db: table.db,
              name: table.name,
              rawDescriptions: table.comment ? { db: table.comment } : {},
              columns: table.columns.map((column) => ({
                name: column.name,
                type: column.nativeType,
                ...(column.comment ? { rawDescriptions: { db: column.comment } } : {}),
              })),
            },
          });
          update = {
            table: tableRef(table),
            tableDescription: batched.tableDescription,
            columnDescriptions: Object.fromEntries(batched.columnDescriptions),
          };
        } catch (error) {
          if (input.context.signal?.aborted) {
            throw error;
          }
          const message = error instanceof Error ? error.message : String(error);
          input.context.logger?.warn(`[enrich] table ${table.name} failed: ${message}`);
          warningSink?.push({
            code: 'enrichment_failed',
            message: `Failed to generate description for ${table.name}: ${message}`,
            table: table.name,
            recoverable: true,
            metadata: {},
          });
          update = nullDescriptionUpdate(table);
        }
        if (isEnrichedDescriptionUpdate(update)) {
          enrichedById.set(tableRefKey(tableRef(table)), update);
          pendingChanged.add(table.name);
          sinceFlush += 1;
          await flush(false);
        }
      }),
    ),
  );
  await flush(true);
  await input.progress?.update(1, `Generated descriptions for ${totalTables} tables`);
  // Full set in snapshot order: recovered + freshly enriched, null for any still-failed.
  return input.snapshot.tables.map((table) => enrichedById.get(tableRefKey(tableRef(table))) ?? nullDescriptionUpdate(table));
}

// The exact per-column text fed to the embedding model. Shared by the embeddings
// stage and the descriptionDigest so the embeddings hash content-addresses the
// real text the model sees (D4).
function buildKtxColumnEmbeddingTexts(
  snapshot: KtxSchemaSnapshot,
  descriptions: KtxLocalScanEnrichmentResult['descriptionUpdates'],
): Array<{ columnId: string; text: string }> {
  const descriptionByTable = new Map(descriptions.map((item) => [tableRefKey(item.table), item]));
  const texts: Array<{ columnId: string; text: string }> = [];
  for (const table of snapshot.tables) {
    const tableDescriptions = descriptionByTable.get(tableRefKey(tableRef(table)));
    for (const column of table.columns) {
      const text = buildKtxColumnEmbeddingText({
        tableName: table.name,
        columnName: column.name,
        columnType: column.nativeType,
        resolvedDescription: tableDescriptions?.columnDescriptions[column.name] ?? column.comment,
        resolvedTableDescription: tableDescriptions?.tableDescription ?? table.comment,
        sampleValues: column.comment ? [column.comment] : null,
        foreignKeys: {
          outgoing: (table.foreignKeys ?? [])
            .filter((foreignKey) => foreignKey.fromColumn === column.name)
            .map((foreignKey) => ({ toTable: foreignKey.toTable, toColumn: foreignKey.toColumn })),
          incoming: [],
        },
      });
      texts.push({ columnId: columnId(table, column), text });
    }
  }
  return texts;
}

async function buildEmbeddings(input: {
  embedding: KtxEmbeddingPort;
  texts: Array<{ columnId: string; text: string }>;
  progress?: KtxProgressPort;
}): Promise<{ updates: KtxEmbeddingUpdate[]; byColumnId: Map<string, number[]> }> {
  const texts = input.texts;

  const embeddings: number[][] = [];
  const maxBatchSize = embeddingBatchSize(input.embedding.maxBatchSize);
  const embeddingTexts = texts.map((item) => item.text);
  const batchCount = Math.ceil(embeddingTexts.length / maxBatchSize);
  if (batchCount === 0) {
    await input.progress?.update(1, 'No embeddings to build');
  }
  for (let offset = 0; offset < embeddingTexts.length; offset += maxBatchSize) {
    const batchIndex = Math.floor(offset / maxBatchSize) + 1;
    await input.progress?.update(batchIndex / batchCount, `Building embeddings ${batchIndex}/${batchCount} batches`, {
      transient: true,
    });
    const batch = embeddingTexts.slice(offset, offset + maxBatchSize);
    const batchEmbeddings = await input.embedding.embedBatch(batch);
    if (batchEmbeddings.length !== batch.length) {
      throw new Error(`expected ${batch.length} embeddings, received ${batchEmbeddings.length}`);
    }
    embeddings.push(...batchEmbeddings);
  }

  const byColumnId = new Map<string, number[]>();
  const updates = texts.map((item, index) => {
    const embedding = embeddings[index] ?? [];
    byColumnId.set(item.columnId, embedding);
    return {
      columnId: item.columnId,
      text: item.text,
      embedding,
    };
  });
  if (batchCount > 0) {
    await input.progress?.update(1, `Built embeddings for ${updates.length} columns`);
  }
  return { updates, byColumnId };
}

async function runEnrichmentStage<TOutput>(input: {
  stateStore: KtxScanEnrichmentStateStore | null | undefined;
  runId: string;
  connectionId: string;
  syncId: string;
  mode: KtxScanMode;
  stage: KtxScanEnrichmentStage;
  inputHash: string;
  now: () => Date;
  resumedStages: KtxScanEnrichmentStage[];
  completedStages: KtxScanEnrichmentStage[];
  failedStages: KtxScanEnrichmentStage[];
  /**
   * When true the stage re-enters compute() even if a completed row matches,
   * skipping the spec-19 short-circuit. The intent of naming a stage in
   * `--stages` is "recompute this" (D3); the inner compute() still honors the
   * spec-20 per-table resume record.
   */
  forceRecompute?: boolean;
  compute: () => Promise<TOutput>;
}): Promise<TOutput> {
  if (!input.forceRecompute) {
    const existing = await input.stateStore?.findCompletedStage<TOutput>({
      connectionId: input.connectionId,
      stage: input.stage,
      inputHash: input.inputHash,
    });
    if (existing) {
      input.resumedStages.push(input.stage);
      input.completedStages.push(input.stage);
      return existing.output;
    }
  }

  try {
    const output = await input.compute();
    input.completedStages.push(input.stage);
    await input.stateStore?.saveCompletedStage({
      runId: input.runId,
      connectionId: input.connectionId,
      syncId: input.syncId,
      mode: input.mode,
      stage: input.stage,
      inputHash: input.inputHash,
      output,
      updatedAt: input.now().toISOString(),
    });
    return output;
  } catch (error) {
    input.failedStages.push(input.stage);
    await input.stateStore?.saveFailedStage({
      runId: input.runId,
      connectionId: input.connectionId,
      syncId: input.syncId,
      mode: input.mode,
      stage: input.stage,
      inputHash: input.inputHash,
      errorMessage: error instanceof Error ? error.message : String(error),
      updatedAt: input.now().toISOString(),
    });
    throw error;
  }
}

function embeddingsByColumnId(updates: KtxEmbeddingUpdate[]): Map<string, number[]> {
  return new Map(updates.map((update) => [update.columnId, update.embedding]));
}

export async function runLocalScanEnrichment(
  input: KtxLocalScanEnrichmentInput,
): Promise<KtxLocalScanEnrichmentResult> {
  const progress = input.context.progress;
  await progress?.update(0, 'Loading enrichment schema snapshot');
  const snapshot =
    input.snapshot ??
    (await input.connector.introspect(
      {
        connectionId: input.connectionId,
        driver: input.connector.driver,
        mode: input.mode,
        detectRelationships: input.detectRelationships,
      },
      input.context,
    ));
  await progress?.update(0.05, `Loaded schema snapshot with ${snapshot.tables.length} tables`);

  assertConnectorDriverMatchesSnapshot({
    connector: input.connector,
    snapshot,
    connectionId: input.connectionId,
  });
  const dialect = input.connector.capabilities.readOnlySql
    ? getSqlDialectForDriver(snapshot.driver)
    : null;
  const now = input.now ?? (() => new Date());
  const state = completedKtxScanEnrichmentStateSummary();
  const syncId = input.syncId ?? input.context.runId;
  const relationshipSettings = input.relationshipSettings ?? buildDefaultKtxProjectConfig().scan.relationships;
  const llmIdentity: KtxScanLlmIdentity = input.llmIdentity ?? { model: null, baseUrlConfigured: false };
  const embeddingIdentity: KtxScanEmbeddingIdentity = input.embeddingIdentity ?? {
    model: null,
    dimensions: null,
    batchSize: null,
  };
  const descriptionsHash = computeKtxDescriptionsStageHash({ snapshot, llmIdentity });
  const relationshipsHash = computeKtxRelationshipsStageHash({ snapshot, relationshipSettings, llmIdentity });
  const warnings: KtxScanWarning[] = [];
  const selectedStages = input.stages;
  const runsStage = (stage: KtxScanEnrichmentStage): boolean =>
    selectedStages === undefined || selectedStages.includes(stage);
  const forcesStage = (stage: KtxScanEnrichmentStage): boolean =>
    selectedStages !== undefined && selectedStages.includes(stage);

  let descriptions: KtxLocalScanEnrichmentResult['descriptionUpdates'] = [];
  let descriptionsRanThisInvocation = false;
  let priorDescriptions: KtxLocalScanEnrichmentResult['descriptionUpdates'] | null | undefined;
  // Best-available descriptions for the downstream stages (embeddings,
  // relationships): fresh ones when descriptions ran this invocation, else the
  // descriptions persisted in the on-disk _schema. Behavior follows the input
  // (did descriptions run?), not which stage subset the caller selected (D5).
  const resolveDownstreamDescriptions = async (): Promise<KtxLocalScanEnrichmentResult['descriptionUpdates']> => {
    if (descriptionsRanThisInvocation) {
      return descriptions;
    }
    if (priorDescriptions === undefined) {
      priorDescriptions = input.loadPriorDescriptions ? await input.loadPriorDescriptions(snapshot) : null;
    }
    return priorDescriptions ?? [];
  };

  let embeddingUpdates: KtxEmbeddingUpdate[] = [];
  const summary: KtxScanEnrichmentSummary = { ...skippedKtxScanEnrichmentSummary };
  const relationshipDetectionEnabled = relationshipSettings.enabled;
  const shouldDetectRelationships =
    relationshipDetectionEnabled &&
    (input.mode === 'relationships' || input.mode === 'enriched' || (input.detectRelationships ?? false));

  if (input.mode === 'enriched' && !input.providers) {
    warnings.push(providerlessEnrichedWarning(shouldDetectRelationships));
  }

  // A stage explicitly named in --stages whose prerequisite is missing must be
  // surfaced, never silently no-op (D2).
  if (selectedStages !== undefined) {
    const stageEligible: Record<KtxScanEnrichmentStage, boolean> = {
      descriptions: input.mode === 'enriched' && input.providers != null,
      embeddings: input.mode === 'enriched' && input.providers?.embedding != null,
      relationships: shouldDetectRelationships,
    };
    for (const stage of selectedStages) {
      if (!stageEligible[stage]) {
        warnings.push({
          code: 'enrichment_stage_skipped',
          message: `Requested --stages ${stage}, but it cannot run: ${stagePrerequisiteReason(stage)}.`,
          recoverable: true,
          metadata: { stage },
        });
      }
    }
  }

  if (input.mode === 'enriched' && input.providers) {
    const providers = input.providers;
    if (runsStage('descriptions')) {
      const descriptionProgress = progress?.startPhase(0.45);
      descriptions = await runEnrichmentStage({
        stateStore: input.stateStore,
        runId: input.context.runId,
        connectionId: input.connectionId,
        syncId,
        mode: input.mode,
        stage: 'descriptions',
        inputHash: descriptionsHash,
        now,
        forceRecompute: forcesStage('descriptions'),
        resumedStages: state.resumedStages,
        completedStages: state.completedStages,
        failedStages: state.failedStages,
        compute: () =>
          generateDescriptions({
            snapshot,
            connector: input.connector,
            context: input.context,
            providers,
            inputHash: descriptionsHash,
            resumeStore: input.descriptionResumeStore,
            progress: descriptionProgress,
            warnings,
          }),
      });
      descriptionsRanThisInvocation = true;
      summary.dataDictionary = input.connector.sampleColumn ? 'completed' : 'skipped';
      summary.tableDescriptions = 'completed';
      summary.columnDescriptions = 'completed';
    }

    const embedding = providers.embedding;
    if (embedding && runsStage('embeddings')) {
      const embeddingProgress = progress?.startPhase(0.2);
      const embeddingTexts = buildKtxColumnEmbeddingTexts(snapshot, await resolveDownstreamDescriptions());
      const embeddingsHash = computeKtxEmbeddingsStageHash({
        snapshot,
        embeddingIdentity,
        descriptionDigest: computeKtxScanDescriptionDigest(embeddingTexts.map((item) => item.text)),
      });
      embeddingUpdates = await runEnrichmentStage({
        stateStore: input.stateStore,
        runId: input.context.runId,
        connectionId: input.connectionId,
        syncId,
        mode: input.mode,
        stage: 'embeddings',
        inputHash: embeddingsHash,
        now,
        forceRecompute: forcesStage('embeddings'),
        resumedStages: state.resumedStages,
        completedStages: state.completedStages,
        failedStages: state.failedStages,
        compute: async () => {
          const embeddings = await buildEmbeddings({
            embedding,
            texts: embeddingTexts,
            progress: embeddingProgress,
          });
          return embeddings.updates;
        },
      });
      summary.embeddings = 'completed';
    }
  }

  let relationshipUpdate: KtxRelationshipUpdate | null = null;
  let relationshipProfile: KtxRelationshipProfileArtifact | null = null;
  let resolvedRelationships: KtxResolvedRelationshipDiscoveryCandidate[] | null = null;
  let compositeRelationships: KtxCompositeRelationshipCandidate[] | null = null;
  let relationshipPartial: { reason: KtxRelationshipDetectionStopReason } | null = null;
  let relationships: KtxScanRelationshipSummary = { accepted: 0, review: 0, rejected: 0, skipped: 0 };

  // Promote any non-relationship stage that ran this invocation (descriptions or
  // a `--stages embeddings,relationships` re-embed) before the slow, kill-prone
  // relationship stage, so an interruption degrades to "no joins," never lost
  // enrichment. descriptionUpdates uses the best-available set (D3): the manifest
  // merge overwrites scan-managed descriptions, so the empty this-invocation set
  // would delete prior on-disk ones.
  const checkpointablePaidWork = summary.tableDescriptions === 'completed' || summary.embeddings === 'completed';
  if (shouldDetectRelationships && checkpointablePaidWork && input.onCheckpoint) {
    await input.onCheckpoint({
      snapshot,
      summary: { ...summary },
      relationships,
      state: summarizeKtxScanEnrichmentState(state),
      warnings: [...warnings],
      descriptionUpdates: await resolveDownstreamDescriptions(),
      embeddingUpdates,
      relationshipUpdate: null,
      relationshipProfile: null,
      resolvedRelationships: null,
      compositeRelationships: null,
      relationshipPartial: null,
    });
  }

  if (shouldDetectRelationships && runsStage('relationships')) {
    const relationshipProgress = progress?.startPhase(0.25);
    // Relationship detection (incl. llmProposals) runs against the
    // best-available descriptions + this run's embeddings, so the join-proposal
    // prompt carries descriptions on both the full-run and relationships-only
    // paths (D5). Embeddings are this run's only — they are not re-hydrated.
    const relationshipSchema = snapshotToKtxEnrichedSchema(
      snapshot,
      embeddingsByColumnId(embeddingUpdates),
      await resolveDownstreamDescriptions(),
    );
    const relationshipStage = await runEnrichmentStage({
      stateStore: input.stateStore,
      runId: input.context.runId,
      connectionId: input.connectionId,
      syncId,
      mode: input.mode,
      stage: 'relationships',
      inputHash: relationshipsHash,
      now,
      forceRecompute: forcesStage('relationships'),
      resumedStages: state.resumedStages,
      completedStages: state.completedStages,
      failedStages: state.failedStages,
      compute: async () => {
        await relationshipProgress?.update(0, 'Detecting relationships');
        const detection = await discoverKtxRelationships({
          connectionId: input.connectionId,
          dialect,
          connector: input.connector,
          schema: relationshipSchema,
          context: input.context,
          settings: relationshipSettings,
          llmRuntime: input.providers?.llmRuntime ?? null,
          ...(relationshipProgress ? { progress: relationshipProgress } : {}),
          ...(input.now ? { now: () => input.now!().getTime() } : {}),
        });

        await relationshipProgress?.update(
          1,
          `Relationship detection found ${detection.relationships.accepted} accepted, ${detection.relationships.review} review`,
        );
        return {
          relationshipUpdate: detection.relationshipUpdate,
          relationshipProfile: detection.profile,
          resolvedRelationships: detection.resolvedRelationships,
          compositeRelationships: detection.compositeRelationships,
          relationships: detection.relationships,
          statisticalValidation: detection.statisticalValidation,
          llmRelationshipValidation: detection.llmRelationshipValidation,
          warnings: detection.warnings,
          partial: detection.partial,
        };
      },
    });

    summary.deterministicRelationships = 'completed';
    summary.llmRelationshipValidation = relationshipStage.llmRelationshipValidation;
    summary.statisticalValidation = relationshipStage.statisticalValidation;
    relationshipUpdate = relationshipStage.relationshipUpdate;
    relationshipProfile = relationshipStage.relationshipProfile;
    resolvedRelationships = relationshipStage.resolvedRelationships;
    compositeRelationships = relationshipStage.compositeRelationships;
    relationships = relationshipStage.relationships;
    relationshipPartial = relationshipStage.partial;
    warnings.push(...relationshipStage.warnings);
    if (relationshipPartial) {
      warnings.push({
        code: 'relationship_detection_partial',
        message:
          relationshipPartial.reason === 'aborted'
            ? 'Relationship detection was cancelled before completing; the joins found so far are partial.'
            : 'Relationship detection hit its wall-clock budget (scan.relationships.detectionBudgetMs) before completing; the joins found so far are partial. Raise the budget to run a fuller pass.',
        recoverable: true,
        metadata: { reason: relationshipPartial.reason },
      });
    }
  }

  // Derived staleness: after a selective run, surface (never silently leave) any
  // unselected stage whose stored hash no longer matches its current inputs (D4).
  // The embeddings hash includes the description digest, so a re-describe makes
  // embeddings diverge here; relationships are deliberately decoupled (D5) and so
  // never diverge from a description change.
  if (selectedStages !== undefined && input.stateStore) {
    const currentStageHash: Record<KtxScanEnrichmentStage, () => Promise<string>> = {
      descriptions: () => Promise.resolve(descriptionsHash),
      relationships: () => Promise.resolve(relationshipsHash),
      embeddings: async () => {
        const embeddingTexts = buildKtxColumnEmbeddingTexts(snapshot, await resolveDownstreamDescriptions());
        return computeKtxEmbeddingsStageHash({
          snapshot,
          embeddingIdentity,
          descriptionDigest: computeKtxScanDescriptionDigest(embeddingTexts.map((item) => item.text)),
        });
      },
    };
    for (const stage of KTX_SCAN_ENRICHMENT_STAGES) {
      if (selectedStages.includes(stage)) {
        continue;
      }
      const completed = await input.stateStore.findLatestCompletedStage({ connectionId: input.connectionId, stage });
      if (!completed) {
        continue;
      }
      if (completed.inputHash !== (await currentStageHash[stage]())) {
        warnings.push({
          code: 'enrichment_stage_stale',
          message: `The ${stage} enrichment stage is now stale: its inputs changed since it last ran. Refresh it with \`ktx ingest ${input.connectionId} --stages ${stage}\`.`,
          recoverable: true,
          metadata: { stage },
        });
      }
    }
  }

  await progress?.update(1, 'Enrichment complete');
  // The manifest merge treats ai/db descriptions as scan-managed and overwrites
  // them with whatever this run emits, so a subset run that skips descriptions
  // must still emit the prior on-disk ones — else the write deletes them (D3
  // "unselected stages are left untouched on disk"). Fresh-this-run if descriptions
  // ran, else loaded from the on-disk _schema.
  const writtenDescriptionUpdates = await resolveDownstreamDescriptions();
  return {
    snapshot,
    summary,
    relationships,
    state: summarizeKtxScanEnrichmentState(state),
    warnings,
    descriptionUpdates: writtenDescriptionUpdates,
    embeddingUpdates,
    relationshipUpdate,
    relationshipProfile,
    resolvedRelationships,
    compositeRelationships,
    relationshipPartial,
  };
}
