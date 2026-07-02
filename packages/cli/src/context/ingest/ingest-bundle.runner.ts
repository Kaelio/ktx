import { cp, mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import pLimit from 'p-limit';
import { z } from 'zod';
import { type KtxLogger, noopLogger } from '../../context/core/config.js';
import type { RateLimitWaitState } from '../../context/llm/rate-limit-governor.js';
import { createRuntimeToolDescriptorFromAiTool } from '../../context/llm/runtime-tools.js';
import type { KtxRuntimeToolSet } from '../../context/llm/runtime-port.js';
import type { KtxModelRole } from '../../llm/types.js';
import type { CaptureSession, MemoryAction } from '../../context/memory/types.js';
import type { SemanticLayerService } from '../../context/sl/semantic-layer.service.js';
import { isSlYamlPath, slSourceFilePath, slSourceNameForFile, sourceNameFromPath } from '../../context/sl/source-files.js';
import type { SemanticLayerSource } from '../../context/sl/types.js';
import type { SlValidationDeps } from '../../context/sl/tools/sl-warehouse-validation.js';
import { createTouchedSlSources, type TouchedSlSource } from '../../context/tools/touched-sl-sources.js';
import type { ToolContext } from '../../context/tools/base-tool.js';
import type { ToolSession } from '../../context/tools/tool-session.js';
import type { KnowledgeWikiService } from '../../context/wiki/knowledge-wiki.service.js';
import { findDanglingWikiRefsForActions } from '../wiki/wiki-ref-validation.js';
import { actionTargetConnectionId } from './action-identity.js';
import { NOTION_DEFAULT_MAX_KNOWLEDGE_CREATES_PER_RUN } from './adapters/notion/types.js';
import {
  formatFinalArtifactGateFindings,
  isFinalArtifactGateFindingPruneable,
  validateFinalIngestArtifacts,
  validateProvenanceRawPaths,
} from './artifact-gates.js';
import { selectRelevantCanonicalPins } from './canonical-pins.js';
import {
  compareFinalizationDeclarations,
  deriveFinalizationTouchedSources,
  deriveFinalizationWikiPageKeys,
} from './finalization-scope.js';
import {
  pruneFinalGateFindings,
  type FinalGateDroppedSource,
  type FinalGatePrunedReference,
} from './final-gate-prune.js';
import { FileIngestTraceWriter, ingestTracePathForJob, type IngestTraceWriter, traceTimed } from './ingest-trace.js';
import { formatIngestProfile, formatIngestProfileJson, readIngestProfile, resolveIngestProfileMode } from './ingest-profile.js';
import { integrateWorkUnitPatch } from './isolated-diff/patch-integrator.js';
import { resolveTextualConflict } from './isolated-diff/textual-conflict-resolver.js';
import { runIsolatedWorkUnit, workUnitPatchFileName } from './isolated-diff/work-unit-executor.js';
import { sanitizeMemoryFlowError } from './memory-flow/live-buffer.js';
import type { CanonicalPin } from './canonical-pins.js';
import type { MemoryFlowEvent, MemoryFlowEventSink, MemoryFlowPlannedWorkUnit } from './memory-flow/types.js';
import type {
  ContextEvidenceIndexSummary,
  IngestBundleRunnerDeps,
  IngestProvenanceInsert,
  IngestProvenanceRow,
  IngestRunsPort,
  IngestSessionWorktree,
  PageTriageRunResult,
} from './ports.js';
import { buildSyncId, rawSourcesDirForSync } from './raw-sources-paths.js';
import {
  buildStageIndexFromReportBody,
  type IngestReportFinalizationProvenanceExclusion,
  type IngestReportFinalizationOutcome,
  type IngestReportProvenanceDetail,
  type IngestReportSnapshot,
  type IngestReportWorkUnit,
} from './reports.js';
import {
  buildReconcileSystemPrompt,
  buildReconcileToolSet,
  buildReconcileUserPrompt,
} from './stages/build-reconcile-context.js';
import { buildWuSystemPrompt, buildWuToolSet, buildWuUserPrompt } from './stages/build-wu-context.js';
import { stageRawFilesStage1 } from './stages/stage-1-stage-raw-files.js';
import { executeWorkUnit, type WorkUnitOutcome } from './stages/stage-3-work-units.js';
import { runReconciliationStage4 } from './stages/stage-4-reconciliation.js';
import type { StageIndex } from './stages/stage-index.types.js';
import { validateWuTouchedSources } from './stages/validate-wu-sources.js';
import { assertSemanticLayerTargetPathsAllowed } from './semantic-layer-target-policy.js';
import {
  computeIngestWorkUnitInputHash,
  computeIngestWorkUnitPromptFingerprint,
  INGEST_WORK_UNIT_CACHE_NAMESPACE,
  ingestWorkUnitCacheScopeKey,
  materializeCachedWorkUnitReplayPatch,
  type IngestWorkUnitCachePayload,
} from './work-unit-cache.js';
import { createEmitArtifactResolutionTool } from './tools/emit-artifact-resolution.tool.js';
import { createEmitConflictResolutionTool } from './tools/emit-conflict-resolution.tool.js';
import { createEmitEvictionDecisionTool } from './tools/emit-eviction-decision.tool.js';
import { createEmitUnmappedFallbackTool } from './tools/emit-unmapped-fallback.tool.js';
import { createEvictionListTool } from './tools/eviction-list.tool.js';
import { createReadRawSpanTool } from './tools/read-raw-span.tool.js';
import { createStageDiffTool } from './tools/stage-diff.tool.js';
import { createStageListTool } from './tools/stage-list.tool.js';
import { flushToolCallLogs, type ToolCallLogEntry, wrapToolsWithLogger } from './tools/tool-call-logger.js';
import {
  createMutableToolTranscriptSummary,
  recordToolTranscriptEntry,
  type MutableToolTranscriptSummary,
} from './tools/tool-transcript-summary.js';
import type {
  IngestDiffSummary,
  EvictionUnit,
  IngestBundleJob,
  IngestBundleResult,
  IngestJobContext,
  UnresolvedCardInfo,
  WorkUnit,
} from './types.js';
import { repairWikiSlRefs, type WikiSlRefRepairResult } from './wiki-sl-ref-repair.js';

type MemoryFlowStageProgress = Extract<MemoryFlowEvent, { type: 'stage_progress' }>;

async function copyTransientIngestEvidence(sourceWorkdir: string, targetWorkdir: string): Promise<void> {
  const source = join(sourceWorkdir, '.ktx/ingest-evidence');
  const target = join(targetWorkdir, '.ktx/ingest-evidence');
  await cp(source, target, { recursive: true, force: true }).catch((error: NodeJS.ErrnoException) => {
    if (error.code !== 'ENOENT') {
      throw error;
    }
  });
}

function workUnitToMemoryFlowPlannedWorkUnit(workUnit: WorkUnit): MemoryFlowPlannedWorkUnit {
  return {
    unitKey: workUnit.unitKey,
    rawFiles: workUnit.rawFiles,
    peerFileCount: workUnit.peerFileIndex.length,
    dependencyCount: workUnit.dependencyPaths.length,
  };
}

function stageIndexWorkUnitToMemoryFlowPlannedWorkUnit(
  workUnit: StageIndex['workUnits'][number],
): MemoryFlowPlannedWorkUnit {
  return {
    unitKey: workUnit.unitKey,
    rawFiles: workUnit.rawFiles,
    peerFileCount: 0,
    dependencyCount: 0,
  };
}

function countMemoryFlowActions(actions: MemoryAction[], target: MemoryAction['target']): number {
  return actions.filter((action) => action.target === target).length;
}

function reportIdFromCreateResult(result: unknown): string | undefined {
  if (!result || typeof result !== 'object' || !('id' in result)) {
    return undefined;
  }
  const id = (result as { id?: unknown }).id;
  return typeof id === 'string' && id.length > 0 ? id : undefined;
}

function normalizeTableReference(value: string): string {
  return value
    .trim()
    .replace(/["`]/g, '')
    .replace(/[\[\]]/g, '')
    .toLowerCase();
}

function finalReferenceSegment(value: string): string {
  const parts = value.split('.').filter((part) => part.length > 0);
  return parts.at(-1) ?? value;
}

function semanticSourceMatchesTableRef(source: SemanticLayerSource, tableRef: string): boolean {
  const normalizedRef = normalizeTableReference(tableRef);
  if (!normalizedRef) {
    return false;
  }

  const refIsQualified = normalizedRef.includes('.');
  const normalizedSourceName = normalizeTableReference(source.name);
  if (normalizedSourceName === normalizedRef) {
    return true;
  }

  const table = typeof source.table === 'string' ? normalizeTableReference(source.table) : '';
  if (table && (table === normalizedRef || table.endsWith(`.${normalizedRef}`))) {
    return true;
  }
  if (!refIsQualified && table && finalReferenceSegment(table) === normalizedRef) {
    return true;
  }

  return false;
}

function rawPathsForAction(action: MemoryAction, fallbackRawPaths: string[]): string[] {
  return action.rawPaths && action.rawPaths.length > 0 ? [...new Set(action.rawPaths)] : fallbackRawPaths;
}

type ProvenanceRowOrigin =
  | {
      source: 'work_unit_action';
      unitKey: string;
      unitIndex: number;
      unitRawFiles: string[];
      actionIndex: number;
      action: MemoryAction;
    }
  | {
      source: 'reconciliation_action';
      actionIndex: number;
      action: MemoryAction;
    }
  | {
      source: 'finalization_action';
      actionIndex: number;
      action: MemoryAction;
    }
  | {
      source: 'artifact_resolution';
      resolutionIndex: number;
      resolution: NonNullable<StageIndex['artifactResolutions']>[number];
    }
  | {
      source: 'raw_snapshot_fallback';
      rawPath: string;
    };

interface ProvenanceRowDiagnostic {
  row: IngestProvenanceInsert;
  origin: ProvenanceRowOrigin;
}

interface ProvenancePlan {
  rows: IngestProvenanceInsert[];
  diagnostics: ProvenanceRowDiagnostic[];
}

type CachedWorkUnitOutcome = WorkUnitOutcome & {
  cacheInputHash: string;
  cacheHit: true;
};

function isCachedWorkUnitOutcome(outcome: WorkUnitOutcome | CachedWorkUnitOutcome): outcome is CachedWorkUnitOutcome {
  return 'cacheHit' in outcome && outcome.cacheHit === true;
}

export class IngestBundleRunner {
  private readonly logger: KtxLogger;
  private readonly chainByConnection = new Map<string, Promise<unknown>>();

  constructor(private readonly deps: IngestBundleRunnerDeps) {
    this.logger = deps.logger ?? noopLogger;
  }

  private async cachedWorkUnitOutcome(input: {
    runId: string;
    syncId: string;
    connectionId: string;
    sourceKey: string;
    stagedDir: string;
    unit: WorkUnit;
    unitIndex: number;
    patchDir: string;
    ingestionBaseSha: string;
    promptFingerprint: string;
    modelRole: KtxModelRole;
    trace: IngestTraceWriter;
  }): Promise<CachedWorkUnitOutcome | { cacheInputHash: string; cacheHit: false }> {
    const inputHash = await computeIngestWorkUnitInputHash({
      stagedDir: input.stagedDir,
      connectionId: input.connectionId,
      sourceKey: input.sourceKey,
      unit: input.unit,
      cliVersion: this.deps.settings.cliVersion,
      promptFingerprint: input.promptFingerprint,
      modelRole: input.modelRole,
    });
    const cached = await this.deps.contentCache.findCompletedResult<IngestWorkUnitCachePayload>({
      namespace: INGEST_WORK_UNIT_CACHE_NAMESPACE,
      scopeKey: ingestWorkUnitCacheScopeKey(input),
      inputHash,
    });
    if (!cached) {
      await input.trace.event('trace', 'work_unit', 'work_unit_cache_miss', {
        unitKey: input.unit.unitKey,
        inputHash,
      });
      return { cacheInputHash: inputHash, cacheHit: false };
    }

    await mkdir(input.patchDir, { recursive: true });
    const patchPath = join(input.patchDir, workUnitPatchFileName(input.unitIndex, input.unit.unitKey));
    if (cached.output.schemaVersion !== 2 || !Array.isArray(cached.output.artifactFiles)) {
      await this.deps.contentCache.deleteResult({
        namespace: INGEST_WORK_UNIT_CACHE_NAMESPACE,
        scopeKey: ingestWorkUnitCacheScopeKey(input),
        inputHash,
      });
      return { cacheInputHash: inputHash, cacheHit: false };
    }
    const materialized = await materializeCachedWorkUnitReplayPatch({
      sessionWorktreeService: this.deps.sessionWorktreeService,
      baseSha: input.ingestionBaseSha,
      jobId: input.runId,
      unitKey: input.unit.unitKey,
      patchPath,
      artifactFiles: cached.output.artifactFiles,
      author: this.deps.storage.systemGitAuthor,
      trace: input.trace,
    });
    if (materialized === 'unsafe_drift') {
      await this.deps.contentCache.deleteResult({
        namespace: INGEST_WORK_UNIT_CACHE_NAMESPACE,
        scopeKey: ingestWorkUnitCacheScopeKey(input),
        inputHash,
      });
      await input.trace.event('debug', 'work_unit', 'work_unit_cache_unsafe_drift', {
        unitKey: input.unit.unitKey,
        inputHash,
      });
      return { cacheInputHash: inputHash, cacheHit: false };
    }
    await input.trace.event('debug', 'work_unit', 'work_unit_cache_hit', {
      unitKey: input.unit.unitKey,
      inputHash,
      producerRunId: cached.runId,
      artifactFileCount: cached.output.artifactFiles.length,
    });
    await input.trace.event('debug', 'work_unit', 'work_unit_cache_replayed', {
      unitKey: input.unit.unitKey,
      patchPath,
      inputHash,
    });
    return {
      unitKey: input.unit.unitKey,
      status: 'success',
      preSha: '',
      postSha: '',
      actions: cached.output.actions,
      touchedSlSources: cached.output.touchedSlSources,
      slDisallowed: cached.output.slDisallowed,
      slDisallowedReason: cached.output.slDisallowedReason,
      patchPath,
      patchTouchedPaths: cached.output.patchTouchedPaths,
      artifactFiles: cached.output.artifactFiles,
      cacheInputHash: inputHash,
      cacheHit: true,
    };
  }

  private async saveSuccessfulWorkUnitCache(input: {
    runId: string;
    syncId: string;
    connectionId: string;
    sourceKey: string;
    inputHash: string;
    outcome: WorkUnitOutcome;
  }): Promise<void> {
    if (input.outcome.status !== 'success' || !input.outcome.patchPath) {
      return;
    }
    await this.deps.contentCache.saveCompletedResult<IngestWorkUnitCachePayload>({
      runId: input.runId,
      namespace: INGEST_WORK_UNIT_CACHE_NAMESPACE,
      scopeKey: ingestWorkUnitCacheScopeKey(input),
      inputHash: input.inputHash,
      output: {
        schemaVersion: 2,
        unitKey: input.outcome.unitKey,
        patchTouchedPaths: input.outcome.patchTouchedPaths ?? [],
        artifactFiles: input.outcome.artifactFiles ?? [],
        actions: input.outcome.actions,
        touchedSlSources: input.outcome.touchedSlSources,
        slDisallowed: input.outcome.slDisallowed,
        slDisallowedReason: input.outcome.slDisallowedReason,
      },
      metadata: {
        syncId: input.syncId,
        connectionId: input.connectionId,
        sourceKey: input.sourceKey,
      },
      updatedAt: new Date().toISOString(),
    });
  }

  async run(job: IngestBundleJob, ctx?: IngestJobContext): Promise<IngestBundleResult> {
    const unsubscribeRateLimitGovernor = this.subscribeRateLimitGovernor({
      trace: this.createTrace(job),
      memoryFlow: ctx?.memoryFlow,
    });
    const key = job.connectionId;
    const previous = this.chainByConnection.get(key);
    if (previous) {
      this.logger.log(`[ingest-bundle] queued behind previous job for connection=${key}`);
    }
    const run = (previous ?? Promise.resolve()).catch(() => undefined).then(() => this.runInner(job, ctx));
    const chainSlot = run.finally(() => {
      if (this.chainByConnection.get(key) === chainSlot) {
        this.chainByConnection.delete(key);
      }
    });
    // Keep the chain alive but silence unhandled rejection — callers await `run` directly.
    chainSlot.catch(() => undefined);
    this.chainByConnection.set(key, chainSlot);
    try {
      const result = await run;
      ctx?.memoryFlow?.finish('done');
      return { ...result, jobId: job.jobId };
    } catch (error) {
      ctx?.memoryFlow?.finish('error', [sanitizeMemoryFlowError(error)]);
      throw error;
    } finally {
      unsubscribeRateLimitGovernor();
      await this.maybeEmitIngestProfile(job.jobId);
    }
  }

  private formatRateLimitWait(
    state: Extract<RateLimitWaitState, { kind: 'wait_tick' | 'wait_started' | 'wait_finished' }>,
  ): string {
    const seconds = Math.ceil(state.remainingMs / 1_000);
    const minutes = Math.floor(seconds / 60);
    const remainder = seconds % 60;
    const duration = minutes > 0 ? `${minutes}m${String(remainder).padStart(2, '0')}s` : `${seconds}s`;
    const type = state.rateLimitType ? ` ${state.rateLimitType}` : '';
    return `Rate-limited (${state.provider}${type}); resuming in ${duration}; Ctrl+C to stop`;
  }

  private subscribeRateLimitGovernor(input: {
    trace: IngestTraceWriter;
    memoryFlow?: MemoryFlowEventSink;
  }): () => void {
    const governor = this.deps.settings.rateLimitGovernor;
    if (!governor) {
      return () => undefined;
    }
    return governor.subscribe((state: RateLimitWaitState) => {
      if (state.kind === 'rate_limit_observed') {
        void input.trace.event('info', 'rate_limit', 'rate_limit_observed', { ...state });
        return;
      }
      if (state.kind === 'concurrency_adjusted') {
        void input.trace.event('info', 'rate_limit', 'concurrency_adjusted', { ...state });
        return;
      }
      void input.trace.event('info', 'rate_limit', state.kind, { ...state });
      if (state.kind === 'wait_tick' || state.kind === 'wait_started') {
        input.memoryFlow?.emit({
          type: 'rate_limit_wait',
          provider: state.provider,
          ...(state.rateLimitType ? { rateLimitType: state.rateLimitType } : {}),
          resumeAtMs: state.resumeAtMs,
          remainingMs: state.remainingMs,
        });
        input.memoryFlow?.emit({
          type: 'stage_progress',
          stage: 'integration',
          percent: 50,
          message: this.formatRateLimitWait(state),
          transient: true,
        });
      }
    });
  }

  private async withRateLimitWorkSlot<T>(abortSignal: AbortSignal | undefined, fn: () => Promise<T>): Promise<T> {
    const governor = this.deps.settings.rateLimitGovernor;
    if (!governor) {
      return fn();
    }
    const release = await governor.acquireWorkSlot(abortSignal);
    try {
      return await fn();
    } finally {
      release();
    }
  }

  /**
   * When profiling is enabled — via the `KTX_PROFILE_INGEST` env var or the
   * `ingest.profile` config setting — read the job's trace + tool transcripts
   * and print a rolled-up timing breakdown to stderr. `json` emits the raw
   * structured profile for coding agents; `table` emits a human summary.
   * Best-effort: profiling never affects the run outcome.
   */
  private async maybeEmitIngestProfile(jobId: string): Promise<void> {
    const mode = resolveIngestProfileMode(this.deps.settings.profileIngest);
    if (mode === 'off') {
      return;
    }
    try {
      // Tool transcripts are appended fire-and-forget; flush them so per-work-unit
      // toolMs (and the derived model-vs-tool split) is complete before we read.
      await flushToolCallLogs();
      const storage = this.deps.storage as typeof this.deps.storage & {
        resolveTracePath?: (jobId: string) => string;
      };
      const profile = await readIngestProfile(jobId, {
        tracePath: storage.resolveTracePath?.(jobId) ?? ingestTracePathForJob(this.deps.storage.homeDir, jobId),
        transcriptDir: this.deps.storage.resolveTranscriptDir(jobId),
      });
      process.stderr.write(`\n${mode === 'json' ? formatIngestProfileJson(profile) : formatIngestProfile(profile)}`);
    } catch (error) {
      this.logger.warn(
        `[ingest-bundle] ingest profile unavailable for job=${jobId}: ${
          error instanceof Error ? error.message : String(error)
        }`,
      );
    }
  }

  protected stageRawFilesStage1 = stageRawFilesStage1;

  private async syncKnowledgeSlRefsFromActions(connectionId: string, actions: MemoryAction[]): Promise<void> {
    if (!this.deps.knowledgeSlRefs) {
      return;
    }

    const slTargetsBySourceName = new Map<string, Set<string>>();
    const wikiActionsByKey = new Map<string, MemoryAction>();
    for (const action of actions) {
      if (action.target === 'sl') {
        const bucket = slTargetsBySourceName.get(action.key) ?? new Set<string>();
        bucket.add(actionTargetConnectionId(action, connectionId));
        slTargetsBySourceName.set(action.key, bucket);
      }
      if (action.target === 'wiki') {
        wikiActionsByKey.set(action.key, action);
      }
    }

    for (const action of wikiActionsByKey.values()) {
      if (action.type === 'removed') {
        await this.deps.knowledgeSlRefs.syncFromWiki({
          wikiPageKey: action.key,
          wikiScope: 'GLOBAL',
          wikiScopeId: null,
          refs: [],
        });
        continue;
      }

      const page = await this.deps.wikiService.readPage('GLOBAL', null, action.key);
      const bareSources = [
        ...new Set(
          (page?.frontmatter.sl_refs ?? [])
            .map((ref) => ref.split('.')[0])
            .filter((sourceName): sourceName is string => sourceName.length > 0),
        ),
      ];
      const refs = bareSources.flatMap((sourceName) => {
        const targets = slTargetsBySourceName.get(sourceName);
        if (!targets || targets.size === 0) {
          return [{ connectionId, sourceName }];
        }
        return [...targets].sort().map((targetConnectionId) => ({ connectionId: targetConnectionId, sourceName }));
      });

      await this.deps.knowledgeSlRefs.syncFromWiki({
        wikiPageKey: action.key,
        wikiScope: 'GLOBAL',
        wikiScopeId: null,
        refs,
      });
    }
  }

  protected async materializeOverrideSnapshot(
    report: IngestReportSnapshot,
    ctx: { connectionId: string; sourceKey: string; jobId: string },
  ): Promise<string> {
    const rawRoot = rawSourcesDirForSync(ctx.connectionId, ctx.sourceKey, report.body.syncId);
    const files = await this.deps.gitService.listFilesAtHead(rawRoot);
    if (files.length === 0) {
      throw new Error(`override ingest: no raw-source files found for prior sync ${report.body.syncId}`);
    }

    const stagedDir = this.deps.storage.resolvePullDir(ctx.jobId);
    await rm(stagedDir, { recursive: true, force: true });
    await mkdir(stagedDir, { recursive: true });

    for (const file of files) {
      const relativePath = file.startsWith(`${rawRoot}/`) ? file.slice(rawRoot.length + 1) : file;
      const absoluteTarget = join(stagedDir, relativePath);
      await mkdir(dirname(absoluteTarget), { recursive: true });
      await writeFile(absoluteTarget, await this.deps.gitService.getFileAtCommit(file, 'HEAD'), 'utf-8');
    }

    return stagedDir;
  }

  protected async loadOverrideReport(job: IngestBundleJob): Promise<IngestReportSnapshot | null> {
    if (job.bundleRef.kind !== 'override') {
      return null;
    }
    const report = await this.deps.reports.findByJobId(job.bundleRef.priorJobId);
    if (!report) {
      throw new Error(`override ingest: prior report ${job.bundleRef.priorJobId} not found`);
    }
    if (report.connectionId !== job.connectionId || report.sourceKey !== job.sourceKey) {
      throw new Error(
        `override ingest: prior report ${job.bundleRef.priorJobId} belongs to ${report.connectionId}/${report.sourceKey}, not ${job.connectionId}/${job.sourceKey}`,
      );
    }
    return report;
  }

  protected async resolveStagedDir(
    ref: IngestBundleJob['bundleRef'],
    ctx: { connectionId: string; sourceKey: string; jobId: string; memoryFlow?: MemoryFlowEventSink },
  ): Promise<string> {
    if (ref.kind === 'upload') {
      return this.deps.storage.resolveUploadDir(ref.uploadId);
    }
    if (ref.kind === 'override') {
      throw new Error('override bundle refs must be materialized from the prior report snapshot');
    }
    const stagedDir = this.deps.storage.resolvePullDir(ctx.jobId);
    await mkdir(stagedDir, { recursive: true });
    const adapter = this.deps.registry.get(ctx.sourceKey);
    if (!adapter.fetch) {
      throw new Error(`source adapter '${ctx.sourceKey}' does not support scheduled_pull (no fetch() method)`);
    }
    await adapter.fetch(ref.config, stagedDir, {
      connectionId: ctx.connectionId,
      sourceKey: ctx.sourceKey,
      ...(ctx.memoryFlow ? { memoryFlow: ctx.memoryFlow } : {}),
    });
    return stagedDir;
  }

  protected buildCommitMessage(
    job: IngestBundleJob,
    syncId: string,
    diffSummary: { added: number; modified: number; deleted: number; unchanged: number },
    failedWUs: string[],
  ): string {
    const diff = `+${diffSummary.added}/~${diffSummary.modified}/-${diffSummary.deleted}/=${diffSummary.unchanged}`;
    const failed = failedWUs.length > 0 ? `; failed WUs: ${failedWUs.join(', ')}` : '';
    return `ingest(${job.sourceKey}): ${job.jobId} syncId=${syncId} diff=${diff}${failed}`;
  }

  private async buildWikiIndex(): Promise<string> {
    const pages = await this.deps.knowledgeIndex?.listPagesForUser('system');
    if (!pages || pages.length === 0) {
      return '(empty)';
    }

    return `## Wiki Pages\n${pages.map((page) => `- ${page.page_key}: ${page.summary}`).join('\n')}`;
  }

  private async buildSlIndex(connectionIds: string[]): Promise<string> {
    const blocks = await Promise.all(
      connectionIds.map(async (connectionId) => {
        try {
          const { sources } = await this.deps.semanticLayerService.loadAllSources(connectionId);
          const names = sources.map((source) => source.name).sort((left, right) => left.localeCompare(right));
          const body = names.length > 0 ? names.join('\n') : '(no sources yet)';
          return `## ${connectionId}\n${body}`;
        } catch {
          try {
            const files = await this.deps.semanticLayerService.listFilesForConnection(connectionId);
            const names = files
              .filter((f) => !f.startsWith('_schema/'))
              .map((f) => sourceNameFromPath(f))
              .sort((left, right) => left.localeCompare(right));
            const body = names.length > 0 ? names.join('\n') : '(no sources yet)';
            return `## ${connectionId}\n${body}`;
          } catch {
            return `## ${connectionId}\n(empty)`;
          }
        }
      }),
    );
    return blocks.join('\n\n');
  }

  private async tableRefExistsInSemanticLayer(
    semanticLayerService: SemanticLayerService,
    connectionIds: string[],
    tableRef: string,
  ): Promise<boolean> {
    for (const connectionId of connectionIds) {
      try {
        const { sources } = await semanticLayerService.loadAllSources(connectionId);
        if (sources.some((source) => semanticSourceMatchesTableRef(source, tableRef))) {
          return true;
        }
      } catch {
        // Fallback diagnostics should not fail an ingest stage if an index lookup is temporarily unavailable.
      }
    }
    return false;
  }

  private async loadSourcesByConnection(
    workdir: string,
    connectionIds: string[],
  ): Promise<Map<string, SemanticLayerSource[]>> {
    const service = this.deps.semanticLayerService.forWorktree(workdir);
    const result = new Map<string, SemanticLayerSource[]>();
    for (const connectionId of connectionIds) {
      const { sources } = await service.loadAllSources(connectionId);
      result.set(connectionId, sources);
    }
    return result;
  }

  private resolveContextCuratorBudget(
    bundleRef: IngestBundleJob['bundleRef'],
    stageIndex: StageIndex,
  ): { creates: number; updates: number } {
    const rawConfig =
      bundleRef.kind === 'scheduled_pull' && bundleRef.config && typeof bundleRef.config === 'object'
        ? (bundleRef.config as Record<string, unknown>)
        : {};
    const configuredCreates =
      typeof rawConfig.maxKnowledgeCreatesPerRun === 'number'
        ? rawConfig.maxKnowledgeCreatesPerRun
        : NOTION_DEFAULT_MAX_KNOWLEDGE_CREATES_PER_RUN;
    const configuredUpdates =
      typeof rawConfig.maxKnowledgeUpdatesPerRun === 'number' ? rawConfig.maxKnowledgeUpdatesPerRun : 20;
    const wikiActions = stageIndex.workUnits.flatMap((wu) => wu.actions).filter((action) => action.target === 'wiki');
    const usedCreates = wikiActions.filter((action) => action.type === 'created').length;
    const usedUpdates = wikiActions.filter((action) => action.type === 'updated').length;

    return {
      creates: Math.max(0, configuredCreates - usedCreates),
      updates: Math.max(0, configuredUpdates - usedUpdates),
    };
  }

  private filterWorkUnitsForTriage(
    workUnits: WorkUnit[],
    triageResult: { enabled: boolean; fullRawPaths: Set<string> } | null,
  ): WorkUnit[] {
    if (!triageResult?.enabled) {
      return workUnits;
    }
    return workUnits.filter((wu) => wu.rawFiles.some((rawPath) => triageResult.fullRawPaths.has(rawPath)));
  }

  private createTrace(job: IngestBundleJob): IngestTraceWriter {
    const storage = this.deps.storage as typeof this.deps.storage & { resolveTracePath?: (jobId: string) => string };
    return new FileIngestTraceWriter({
      tracePath: storage.resolveTracePath?.(job.jobId) ?? ingestTracePathForJob(this.deps.storage.homeDir, job.jobId),
      jobId: job.jobId,
      connectionId: job.connectionId,
      sourceKey: job.sourceKey,
      level: this.deps.settings.ingestTraceLevel ?? 'debug',
    });
  }

  private errorMessage(error: unknown): string {
    return error instanceof Error ? error.message : String(error);
  }

  private buildProvenancePlan(input: {
    job: IngestBundleJob;
    syncId: string;
    currentHashes: Map<string, string>;
    stageIndex: StageIndex;
    reconcileActions: MemoryAction[];
    finalizationActions: MemoryAction[];
  }): ProvenancePlan {
    const rows: IngestProvenanceInsert[] = [];
    const diagnostics: ProvenanceRowDiagnostic[] = [];
    const actionToType = (action: MemoryAction): IngestProvenanceInsert['actionType'] => {
      if (action.target === 'wiki') {
        return 'wiki_written';
      }
      return action.type === 'created' ? 'source_created' : 'measure_added';
    };
    const producedPaths = new Set<string>();
    const pushRow = (row: IngestProvenanceInsert, origin: ProvenanceRowOrigin): void => {
      rows.push(row);
      diagnostics.push({ row, origin });
      producedPaths.add(row.rawPath);
    };
    const pushActionProvenance = (rawPath: string, action: MemoryAction, origin: ProvenanceRowOrigin): void => {
      const hash = input.currentHashes.get(rawPath) ?? '';
      pushRow(
        {
          connectionId: input.job.connectionId,
          sourceKey: input.job.sourceKey,
          syncId: input.syncId,
          rawPath,
          rawContentHash: hash,
          artifactKind: action.target,
          artifactKey: action.key,
          targetConnectionId: action.target === 'sl' ? actionTargetConnectionId(action, input.job.connectionId) : null,
          artifactContentHash: null,
          actionType: actionToType(action),
        },
        origin,
      );
    };

    input.stageIndex.workUnits.forEach((wu, unitIndex) => {
      wu.actions.forEach((action, actionIndex) => {
        for (const rawPath of rawPathsForAction(action, wu.rawFiles)) {
          pushActionProvenance(rawPath, action, {
            source: 'work_unit_action',
            unitKey: wu.unitKey,
            unitIndex,
            unitRawFiles: wu.rawFiles,
            actionIndex,
            action,
          });
        }
      });
    });
    input.reconcileActions.forEach((action, actionIndex) => {
      for (const rawPath of action.rawPaths ?? []) {
        pushActionProvenance(rawPath, action, {
          source: 'reconciliation_action',
          actionIndex,
          action,
        });
      }
    });
    input.finalizationActions.forEach((action, actionIndex) => {
      for (const rawPath of action.rawPaths ?? []) {
        pushActionProvenance(rawPath, action, {
          source: 'finalization_action',
          actionIndex,
          action,
        });
      }
    });
    (input.stageIndex.artifactResolutions ?? []).forEach((resolution, resolutionIndex) => {
      const hash = input.currentHashes.get(resolution.rawPath) ?? '';
      pushRow(
        {
          connectionId: input.job.connectionId,
          sourceKey: input.job.sourceKey,
          syncId: input.syncId,
          rawPath: resolution.rawPath,
          rawContentHash: hash,
          artifactKind: resolution.artifactKind,
          artifactKey: resolution.artifactKey,
          targetConnectionId: null,
          artifactContentHash: null,
          actionType: resolution.actionType,
        },
        {
          source: 'artifact_resolution',
          resolutionIndex,
          resolution,
        },
      );
    });
    for (const [rawPath, hash] of input.currentHashes) {
      if (producedPaths.has(rawPath)) {
        continue;
      }
      pushRow(
        {
          connectionId: input.job.connectionId,
          sourceKey: input.job.sourceKey,
          syncId: input.syncId,
          rawPath,
          rawContentHash: hash,
          artifactKind: null,
          artifactKey: null,
          targetConnectionId: null,
          artifactContentHash: null,
          actionType: 'skipped',
        },
        { source: 'raw_snapshot_fallback', rawPath },
      );
    }

    return { rows, diagnostics };
  }

  private partitionFinalizationActionsForProvenance(input: {
    actions: MemoryAction[];
    currentRawPaths: Set<string>;
    currentEvictionRawPaths: Set<string>;
    overrideEvictionRawPaths: Set<string>;
  }): { actions: MemoryAction[]; exclusions: IngestReportFinalizationProvenanceExclusion[] } {
    const defensible = new Set([
      ...input.currentRawPaths,
      ...input.currentEvictionRawPaths,
      ...input.overrideEvictionRawPaths,
    ]);
    const actions: MemoryAction[] = [];
    const exclusions: IngestReportFinalizationProvenanceExclusion[] = [];
    for (const action of input.actions) {
      const rawPaths = action.rawPaths ?? [];
      if (rawPaths.length === 0) {
        exclusions.push({ action, reason: 'missing_raw_paths' });
        continue;
      }
      const invalidRawPaths = rawPaths.filter((rawPath) => !defensible.has(rawPath)).sort();
      if (invalidRawPaths.length > 0) {
        exclusions.push({ action, reason: 'raw_path_not_defensible', invalidRawPaths });
        continue;
      }
      actions.push(action);
    }
    return { actions, exclusions };
  }

  private toReportProvenanceRows(rows: IngestProvenanceInsert[]): IngestReportProvenanceDetail[] {
    return rows.map(({ rawPath, artifactKind, artifactKey, actionType, targetConnectionId }) => ({
      rawPath,
      artifactKind,
      artifactKey,
      targetConnectionId: targetConnectionId ?? null,
      actionType,
    }));
  }

  private toReportWorkUnits(stageIndex: StageIndex): IngestReportWorkUnit[] {
    return stageIndex.workUnits.map((wu) => ({
      unitKey: wu.unitKey,
      rawFiles: wu.rawFiles,
      status: wu.status,
      reason: wu.reason,
      actions: wu.actions,
      touchedSlSources: wu.touchedSlSources,
      slDisallowed: wu.slDisallowed,
      slDisallowedReason: wu.slDisallowedReason,
    }));
  }

  private provenanceValidationTraceData(input: {
    plan: ProvenancePlan;
    currentRawPaths: Set<string>;
    deletedRawPaths: Set<string>;
  }): Record<string, unknown> {
    const invalidRows = input.plan.diagnostics.filter(
      ({ row }) => !input.currentRawPaths.has(row.rawPath) && !input.deletedRawPaths.has(row.rawPath),
    );
    return {
      rowCount: input.plan.rows.length,
      currentRawPathCount: input.currentRawPaths.size,
      deletedRawPathCount: input.deletedRawPaths.size,
      currentRawPaths: [...input.currentRawPaths].sort(),
      deletedRawPaths: [...input.deletedRawPaths].sort(),
      invalidRawPaths: [...new Set(invalidRows.map(({ row }) => row.rawPath))].sort(),
      invalidRows,
    };
  }

  private wikiPageKeysFromPaths(paths: string[]): string[] {
    return [
      ...new Set(
        paths
          .filter((path) => path.startsWith('wiki/global/') && path.endsWith('.md'))
          .map((path) => path.slice('wiki/global/'.length, -'.md'.length)),
      ),
    ].sort();
  }

  private async touchedSlSourcesFromPaths(
    worktree: IngestSessionWorktree,
    paths: string[],
    deletedFileSha: string,
  ): Promise<TouchedSlSource[]> {
    const sources: TouchedSlSource[] = [];
    for (const path of paths) {
      if (!path.startsWith('semantic-layer/') || !isSlYamlPath(path) || path.includes('/_schema/')) {
        continue;
      }
      const [, connectionId] = path.split('/');
      if (!connectionId) {
        continue;
      }
      // Source identity is the in-file `name:`, never the filename — an uppercase
      // warehouse source like `WIDGET_SALES` lives in a hash-derived
      // `widget_sales-<hash>.yaml`, so parsing the basename yields a phantom name.
      // Read the live file; when it was deleted this run, recover its declared
      // name from the pre-change commit the way `revertSourceToPreHead` resolves a
      // gone file from history. The filename is a last resort only when the content
      // is unrecoverable from both.
      let content: string | null;
      try {
        content = await readFile(join(worktree.workdir, path), 'utf-8');
      } catch {
        content = await worktree.git.getFileAtCommit(path, deletedFileSha).catch(() => null);
      }
      const sourceName = content === null ? sourceNameFromPath(path) : slSourceNameForFile(path, content);
      if (sourceName.length > 0) {
        sources.push({ connectionId, sourceName });
      }
    }
    return sources;
  }

  // Inverse direction for commits and repair allowlists: resolve each touched
  // source to its real on-disk path, falling back to the writer's derived
  // filename when the file was deleted in this run.
  private async touchedSlSourcePaths(workdir: string, touched: TouchedSlSource[]): Promise<string[]> {
    const service = this.deps.semanticLayerService.forWorktree(workdir);
    const paths: string[] = [];
    for (const source of touched) {
      const file = await service.readSourceFile(source.connectionId, source.sourceName);
      paths.push(file?.path ?? slSourceFilePath(source.connectionId, source.sourceName));
    }
    return paths;
  }

  private touchedSlSourcesFromActions(actions: MemoryAction[], fallbackConnectionId: string): TouchedSlSource[] {
    return actions
      .filter((action) => action.target === 'sl')
      .map((action) => ({
        connectionId: actionTargetConnectionId(action, fallbackConnectionId),
        sourceName: action.key,
      }));
  }

  private wikiPageKeysFromActions(actions: MemoryAction[]): string[] {
    return actions.filter((action) => action.target === 'wiki').map((action) => action.key);
  }

  private uniqueWikiPageKeys(keys: string[]): string[] {
    return [...new Set(keys.filter((key): key is string => typeof key === 'string' && key.length > 0))].sort();
  }

  private uniqueTouchedSlSources(sources: TouchedSlSource[]): TouchedSlSource[] {
    const seen = new Set<string>();
    const unique: TouchedSlSource[] = [];
    for (const source of sources) {
      const key = `${source.connectionId}:${source.sourceName}`;
      if (seen.has(key)) {
        continue;
      }
      seen.add(key);
      unique.push(source);
    }
    return unique.sort((left, right) => {
      const byConnection = left.connectionId.localeCompare(right.connectionId);
      return byConnection === 0 ? left.sourceName.localeCompare(right.sourceName) : byConnection;
    });
  }

  private removedWikiPageKeysFromActions(actions: MemoryAction[]): string[] {
    return this.uniqueWikiPageKeys(
      actions.filter((action) => action.target === 'wiki' && action.type === 'removed').map((action) => action.key),
    );
  }

  private markFinalGateDroppedSourceWorkUnits(input: {
    stageIndex: StageIndex;
    workUnitOutcomes: WorkUnitOutcome[];
    failedWorkUnits: string[];
    droppedSources: FinalGateDroppedSource[];
    fallbackConnectionId: string;
  }): void {
    const unitFailures = new Map<string, string[]>();
    for (const dropped of input.droppedSources) {
      for (const workUnit of input.stageIndex.workUnits) {
        const producedByAction = workUnit.actions.some(
          (action) =>
            action.target === 'sl' &&
            action.key === dropped.sourceName &&
            actionTargetConnectionId(action, input.fallbackConnectionId) === dropped.connectionId,
        );
        const producedByTouchedSource = workUnit.touchedSlSources.some(
          (source) => source.connectionId === dropped.connectionId && source.sourceName === dropped.sourceName,
        );
        if (!producedByAction && !producedByTouchedSource) {
          continue;
        }
        const reasons = unitFailures.get(workUnit.unitKey) ?? [];
        reasons.push(`${dropped.connectionId}:${dropped.sourceName} (${dropped.reason})`);
        unitFailures.set(workUnit.unitKey, reasons);
      }
    }

    for (const [unitKey, reasons] of unitFailures) {
      const reason = `final artifact gate dropped invalid source(s): ${reasons.join(', ')}`;
      const reportWorkUnit = input.stageIndex.workUnits.find((workUnit) => workUnit.unitKey === unitKey);
      if (reportWorkUnit) {
        reportWorkUnit.status = 'failed';
        reportWorkUnit.reason = reason;
      }
      const outcome = input.workUnitOutcomes.find((workUnit) => workUnit.unitKey === unitKey);
      if (outcome) {
        outcome.status = 'failed';
        outcome.reason = reason;
      }
      if (!input.failedWorkUnits.includes(unitKey)) {
        input.failedWorkUnits.push(unitKey);
      }
    }
  }

  private finalGateActionOrigins(input: {
    stageIndex: StageIndex;
    reconcileActions: MemoryAction[];
    fallbackConnectionId: string;
  }) {
    const actionContext = (action: MemoryAction, fallbackRawPaths: string[]) => ({
      target: action.target,
      type: action.type,
      key: action.key,
      detail: action.detail,
      rawPaths: rawPathsForAction(action, fallbackRawPaths),
      ...(action.target === 'sl' ? { targetConnectionId: actionTargetConnectionId(action, input.fallbackConnectionId) } : {}),
    });

    return [
      ...input.stageIndex.workUnits.flatMap((workUnit, unitIndex) =>
        workUnit.actions.map((action, actionIndex) => ({
          source: 'work_unit_action',
          unitKey: workUnit.unitKey,
          unitIndex,
          unitRawFiles: workUnit.rawFiles,
          actionIndex,
          action: actionContext(action, workUnit.rawFiles),
        })),
      ),
      ...input.reconcileActions.map((action, actionIndex) => ({
        source: 'reconciliation_action',
        actionIndex,
        action: actionContext(action, []),
      })),
    ];
  }

  private async wikiPageKeysForFinalGates(input: {
    wikiService: ReturnType<KnowledgeWikiService['forWorktree']>;
    changedWikiPageKeys: string[];
    touchedSlSources: TouchedSlSource[];
    actions: MemoryAction[];
  }): Promise<{
    pageKeys: string[];
    trace: {
      global: boolean;
      reasons: string[];
      changedWikiPageKeys: string[];
      removedWikiPageKeys: string[];
      pageKeysValidated: string[];
    };
  }> {
    const changedWikiPageKeys = this.uniqueWikiPageKeys(input.changedWikiPageKeys);
    const removedWikiPageKeys = this.removedWikiPageKeysFromActions(input.actions);
    const reasons: string[] = [];
    if (input.touchedSlSources.length > 0) {
      reasons.push('semantic_layer_changed');
    }
    if (removedWikiPageKeys.length > 0) {
      reasons.push('wiki_page_removed');
    }

    let pageKeys = changedWikiPageKeys;
    if (reasons.length > 0) {
      pageKeys = this.uniqueWikiPageKeys([
        ...changedWikiPageKeys,
        ...(await input.wikiService.listPageKeys('GLOBAL', null)),
      ]);
    }

    return {
      pageKeys,
      trace: {
        global: reasons.length > 0,
        reasons,
        changedWikiPageKeys,
        removedWikiPageKeys,
        pageKeysValidated: pageKeys,
      },
    };
  }

  private async runWorkUnitInWorktree(input: {
    job: IngestBundleJob;
    syncId: string;
    wu: WorkUnit;
    worktree: IngestSessionWorktree;
    stagedDir: string;
    contextReport: ContextEvidenceIndexSummary | null;
    ingestToolMetadata: { runId: string; jobId: string; syncId: string; sourceKey: string };
    slConnectionIds: string[];
    wikiIndex: string;
    slIndex: string;
    priorProvenance: Map<string, IngestProvenanceRow[]>;
    scopedWikiService: ReturnType<KnowledgeWikiService['forWorktree']>;
    scopedSemanticLayerService: ReturnType<SemanticLayerService['forWorktree']>;
    baseFraming: string;
    skillsPrompt: string;
    canonicalPins: CanonicalPin[];
    workUnitSettings: { maxConcurrency: number; stepBudget: number; failureMode: 'abort' | 'continue' };
    transcriptDir: string;
    transcriptSummaries: Map<string, MutableToolTranscriptSummary>;
    recordTranscriptEntry(path: string): (entry: ToolCallLogEntry) => MutableToolTranscriptSummary;
    stageIndex: StageIndex;
    includeContextEvidenceTools: boolean;
    currentTableExists(tableRef: string): Promise<boolean>;
    memoryFlow?: MemoryFlowEventSink;
    abortSignal?: AbortSignal;
    wuSkillNames: string[];
  }): Promise<WorkUnitOutcome> {
    const session: CaptureSession = {
      userId: 'system',
      chatId: input.wu.unitKey,
      userMessage: `ingest(${input.job.sourceKey}) WU=${input.wu.unitKey}`,
      connectionId: input.job.connectionId,
      userScopedEnabled: false,
      forceGlobalScope: true,
      touchedSlSources: createTouchedSlSources(),
      preHead: input.worktree.baseSha,
    };
    const sessionActions: MemoryAction[] = [];

    const toolSession: ToolSession = {
      connectionId: input.job.connectionId,
      isWorktreeScoped: true,
      preHead: input.worktree.baseSha,
      touchedSlSources: session.touchedSlSources,
      actions: sessionActions,
      allowedRawPaths: new Set(input.wu.rawFiles),
      allowedConnectionNames: new Set(input.slConnectionIds),
      semanticLayerService: input.scopedSemanticLayerService,
      wikiService: input.scopedWikiService,
      configService: input.worktree.config,
      gitService: input.worktree.git,
      ingest: input.ingestToolMetadata,
    };

    const slValidationDeps: SlValidationDeps = {
      semanticLayerService: input.scopedSemanticLayerService,
      connections: this.deps.connections,
      configService: input.worktree.config,
      gitService: input.worktree.git,
      slSourcesRepository: this.deps.slSourcesRepository,
      probeRowCount: this.deps.settings.probeRowCount,
    };

    const wuToolset = this.deps.toolsetFactory.createIngestWuToolset(toolSession, {
      includeContextEvidenceTools: input.includeContextEvidenceTools,
    });
    const wuToolContext: ToolContext = {
      sourceId: 'ingest',
      messageId: `${input.job.jobId}-wu-${input.wu.unitKey}`,
      userId: 'system',
      connectionId: input.job.connectionId,
      ingest: input.ingestToolMetadata,
      session: toolSession,
    };

    const skillsLoadedPerWu: string[] = [];
    const loadSkillTool: KtxRuntimeToolSet = {
      load_skill: {
        name: 'load_skill',
        description:
          'Load a skill to get specialized instructions. Call this when a skill listed in the system prompt matches the current task.',
        inputSchema: z.object({ name: z.string() }),
        execute: async ({ name }) => {
          const skill = await this.deps.skillsRegistry.getSkill(name, 'memory_agent');
          if (!skill) {
            const available =
              (await this.deps.skillsRegistry.listSkills('memory_agent')).map((s) => s.name).join(', ') || '(none)';
            return { markdown: `Skill "${name}" not available. Available: ${available}` };
          }
          const body = await readFile(join(skill.path, 'SKILL.md'), 'utf-8');
          if (!skillsLoadedPerWu.includes(skill.name)) {
            skillsLoadedPerWu.push(skill.name);
          }
          const structured = {
            name: skill.name,
            skillDirectory: skill.path,
            content: this.deps.skillsRegistry.stripFrontmatter(body),
          };
          return {
            markdown: `# ${structured.name}\n\n${structured.content}`,
            structured,
          };
        },
      },
    };

    const wuEmitUnmappedFallbackTool = {
      emit_unmapped_fallback: createRuntimeToolDescriptorFromAiTool(
        'emit_unmapped_fallback',
        createEmitUnmappedFallbackTool({
          stageIndex: input.stageIndex,
          allowedPaths: new Set(input.wu.rawFiles),
          tableRefExists: input.currentTableExists,
        }),
      ),
    };

    const systemPrompt = buildWuSystemPrompt({
      baseFraming: input.baseFraming,
      skillsPrompt: input.skillsPrompt,
      syncId: input.syncId,
      sourceKey: input.job.sourceKey,
      connectionId: input.job.connectionId,
      canonicalPins: input.canonicalPins,
    });

    input.memoryFlow?.emit({
      type: 'work_unit_started',
      unitKey: input.wu.unitKey,
      skills: input.wuSkillNames,
    });
    return executeWorkUnit(
      {
        sessionWorktreeGit: input.worktree.git,
        agentRunner: this.deps.agentRunner,
        validateTouchedSources: (touched) =>
          validateWuTouchedSources({ ...slValidationDeps, slValidator: this.deps.slValidator }, touched),
        resetHardTo: (targetSha) => input.worktree.git.resetHardTo(targetSha),
        buildSystemPrompt: () => systemPrompt,
        buildUserPrompt: (wuInner) =>
          buildWuUserPrompt({
            wu: wuInner,
            wikiIndex: input.wikiIndex,
            slIndex: input.slIndex,
            priorProvenance: input.priorProvenance,
          }),
        buildToolSet: (wuInner) => {
          const transcriptPath = join(input.transcriptDir, `${wuInner.unitKey}.jsonl`);
          const record = input.recordTranscriptEntry(transcriptPath);
          return wrapToolsWithLogger(
            buildWuToolSet({
              sourceKey: input.job.sourceKey,
              stagedDir: input.stagedDir,
              wu: wuInner,
              loadSkillTool,
              emitUnmappedFallbackTool: wuEmitUnmappedFallbackTool,
              toolsetTools: wuToolset.toRuntimeTools(wuToolContext),
            }),
            transcriptPath,
            wuInner.unitKey,
            {
              // Drive the live HUD heartbeat from real tool calls: each invocation
              // ticks the running per-unit count. This is an observed signal, not a
              // re-derived turn count, so it can never overshoot a budget.
              onEntry: (entry) => {
                const summary = record(entry);
                input.memoryFlow?.emit({
                  type: 'work_unit_step',
                  unitKey: wuInner.unitKey,
                  toolCalls: summary.toolCallCount,
                });
              },
            },
          );
        },
        captureSession: session,
        sessionActions,
        modelRole: 'candidateExtraction',
        stepBudget: input.workUnitSettings.stepBudget,
        sourceKey: input.job.sourceKey,
        connectionId: input.job.connectionId,
        jobId: input.job.jobId,
        toolFailureCount: (unitKey) => input.transcriptSummaries.get(unitKey)?.fatalErrorCount ?? 0,
        abortSignal: input.abortSignal,
      },
      input.wu,
    );
  }

  protected async runInner(job: IngestBundleJob, ctx?: IngestJobContext): Promise<Omit<IngestBundleResult, 'jobId'>> {
    const syncId = buildSyncId(new Date(), job.jobId);
    const trace = this.createTrace(job);
    const transcriptSummaries = new Map<string, MutableToolTranscriptSummary>();
    let activeTrace: IngestTraceWriter = trace;
    let activePhase = 'run';
    let runRow: Awaited<ReturnType<IngestRunsPort['create']>> | null = null;
    let latestDiffSummary: IngestDiffSummary = { added: 0, modified: 0, deleted: 0, unchanged: 0 };
    let latestWorkUnits: WorkUnitOutcome[] = [];
    let latestFailedWorkUnits: string[] = [];
    let latestReconciliationSkipped = true;
    let latestReportWorkUnits: IngestReportWorkUnit[] = [];
    let latestReconciliationActions: MemoryAction[] = [];
    let latestConflictsResolved: StageIndex['conflictsResolved'] = [];
    let latestEvictionsApplied: StageIndex['evictionsApplied'] = [];
    let latestUnmappedFallbacks: StageIndex['unmappedFallbacks'] = [];
    let latestArtifactResolutions: NonNullable<StageIndex['artifactResolutions']> = [];
    let latestEvictionInputs: string[] = [];
    let latestUnresolvedCards: UnresolvedCardInfo[] = [];
    let latestReportProvenanceRows: IngestReportProvenanceDetail[] = [];
    let latestFinalizationOutcome: IngestReportFinalizationOutcome | undefined;
    let activeFailureDetails: Record<string, unknown> | undefined;
    let latestIsolatedDiffSummary:
      | {
          enabled: boolean;
          integrationWorktreePath?: string;
          ingestionBaseSha?: string;
          projectionSha?: string | null;
          acceptedPatches: number;
          textualConflicts: number;
          semanticConflicts: number;
          resolverAttempts: number;
          resolverRepairs: number;
          resolverFailures: number;
        }
      | undefined;
    await trace.event('info', 'run', 'ingest_started', {
      trigger: job.trigger,
      bundleRefKind: job.bundleRef.kind,
    });
    try {
    const memoryFlow = ctx?.memoryFlow;
    const emitStageProgress = (
      stage: MemoryFlowStageProgress['stage'],
      percent: number,
      message: string,
      options: { transient?: boolean } = {},
    ): void => {
      memoryFlow?.emit({
        type: 'stage_progress',
        stage,
        percent,
        message,
        ...(options.transient !== undefined ? { transient: options.transient } : {}),
      });
    };
    const baseSha = await this.deps.lockingService.withLock('config:repo', () => this.deps.gitService.revParseHead());
    if (!baseSha) {
      throw new Error('ingest-bundle: config repo has no HEAD');
    }
    const transcriptDir = this.deps.storage.resolveTranscriptDir(job.jobId);
    const recordTranscriptEntry =
      (path: string) =>
      (entry: ToolCallLogEntry): MutableToolTranscriptSummary => {
        const current =
          transcriptSummaries.get(entry.wuKey) ?? createMutableToolTranscriptSummary(entry.wuKey, path);
        recordToolTranscriptEntry(current, entry);
        transcriptSummaries.set(entry.wuKey, current);
        return current;
      };
    const overrideReport = await this.loadOverrideReport(job);

    const stage1 = ctx?.startPhase(0.08);
    await stage1?.updateProgress(0.0, 'Fetching source files');

    const adapter = this.deps.registry.get(job.sourceKey);
    activePhase = 'fetch';
    const stagedDir = await traceTimed(
      trace,
      'fetch',
      'resolve_staged_dir',
      {
        bundleRefKind: job.bundleRef.kind,
        sourceKey: job.sourceKey,
      },
      () =>
        overrideReport
          ? this.materializeOverrideSnapshot(overrideReport, {
              connectionId: job.connectionId,
              sourceKey: job.sourceKey,
              jobId: job.jobId,
            })
          : this.resolveStagedDir(job.bundleRef, {
              connectionId: job.connectionId,
              sourceKey: job.sourceKey,
              jobId: job.jobId,
              ...(memoryFlow ? { memoryFlow } : {}),
            }),
    );
    const fetchReport = adapter.readFetchReport ? await adapter.readFetchReport(stagedDir) : null;

    const scopeDescriptor = adapter.describeScope ? await adapter.describeScope(stagedDir) : null;

    const sessionWorktree = await traceTimed(
      trace,
      'worktree',
      'session_worktree_created',
      { jobId: job.jobId },
      () =>
        this.deps.lockingService.withLock('config:repo', () =>
          this.deps.sessionWorktreeService.create(job.jobId, baseSha),
        ),
    );
    let cleanupOutcome: 'success' | 'crash' | 'conflict' = 'crash';

    try {
      activePhase = 'stage_raw_files';
      const { currentHashes, rawDirInWorktree } = await traceTimed(
        trace,
        'stage_raw_files',
        'stage_raw_files',
        {
          stagedDir,
          worktreePath: sessionWorktree.workdir,
          connectionId: job.connectionId,
          sourceKey: job.sourceKey,
          syncId,
        },
        () =>
          this.stageRawFilesStage1({
            stagedDir,
            worktreeRoot: sessionWorktree.workdir,
            connectionId: job.connectionId,
            sourceKey: job.sourceKey,
            syncId,
          }),
      );
      memoryFlow?.update({
        connectionId: job.connectionId,
        adapter: job.sourceKey,
        sourceDir: stagedDir,
        syncId,
      });
      memoryFlow?.emit({
        type: 'source_acquired',
        adapter: job.sourceKey,
        trigger: job.trigger,
        fileCount: currentHashes.size,
      });
      memoryFlow?.emit({ type: 'scope_detected', fingerprint: scopeDescriptor?.fingerprint ?? null });
      memoryFlow?.emit({ type: 'raw_snapshot_written', syncId, rawFileCount: currentHashes.size });

      await sessionWorktree.git.commitFiles(
        [rawDirInWorktree],
        `ingest(${job.sourceKey}): stage raw files syncId=${syncId}`,
        this.deps.storage.systemGitAuthor.name,
        this.deps.storage.systemGitAuthor.email,
      );

      await stage1?.updateProgress(0.5, 'Checking what changed');

      activePhase = 'diff';
      const diffSet = await traceTimed(
        trace,
        'diff',
        'compute_diff_set',
        {
          connectionId: job.connectionId,
          sourceKey: job.sourceKey,
          currentHashCount: currentHashes.size,
          scopeFingerprint: scopeDescriptor?.fingerprint ?? null,
        },
        () =>
          this.deps.diffSetService.compute(
            job.connectionId,
            job.sourceKey,
            currentHashes,
            scopeDescriptor ? scopeDescriptor.isPathInScope.bind(scopeDescriptor) : undefined,
          ),
      );
      const diffSummary = {
        added: diffSet.added.length,
        modified: diffSet.modified.length,
        deleted: diffSet.deleted.length,
        unchanged: diffSet.unchanged.length,
      };
      latestDiffSummary = diffSummary;
      memoryFlow?.emit({ type: 'diff_computed', ...diffSummary });

      runRow = await this.deps.runs.create({
        jobId: job.jobId,
        connectionId: job.connectionId,
        sourceKey: job.sourceKey,
        syncId,
        trigger: job.trigger,
        scopeFingerprint: scopeDescriptor?.fingerprint ?? null,
      });
      memoryFlow?.update({ runId: runRow.id });
      const ingestToolMetadata = {
        runId: runRow.id,
        jobId: job.jobId,
        syncId,
        sourceKey: job.sourceKey,
      };
      const runTrace = trace.withContext({ runId: runRow.id, syncId });
      activeTrace = runTrace;
      const createdRunRow = runRow;
      await runTrace.event('debug', 'snapshot', 'input_snapshot', {
        baseSha,
        stagedDir,
        rawFileCount: currentHashes.size,
        rawDirInWorktree,
        diffSummary,
        scopeFingerprint: scopeDescriptor?.fingerprint ?? null,
      });

      await stage1?.updateProgress(
        1.0,
        `${diffSet.added.length} new, ${diffSet.modified.length} changed, ${diffSet.deleted.length} removed`,
      );

      activePhase = 'detect';
      const detected = await traceTimed(runTrace, 'detect', 'adapter_detect', { stagedDir, sourceKey: job.sourceKey }, () =>
        adapter.detect(stagedDir),
      );
      await runTrace.event('debug', 'detect', 'adapter_detected', { detected });
      if (!detected) {
        await this.deps.runs.markFailed(runRow.id);
        throw new Error(`source adapter '${job.sourceKey}' did not recognize staged dir`);
      }

      let contextReport: ContextEvidenceIndexSummary | null = null;
      if (adapter.evidenceIndexing === 'documents' && this.deps.contextEvidenceIndex) {
        contextReport = await this.deps.contextEvidenceIndex.indexStagedDir({
          stagedDir,
          runId: runRow.id,
          connectionId: job.connectionId,
          sourceKey: job.sourceKey,
          syncId,
          diffSet,
          currentHashes,
        });
      }

      const stage2 = ctx?.startPhase(0.04);
      await stage2?.updateProgress(0.0, 'Planning updates');
      activePhase = 'planning';
      let workUnits: WorkUnit[] = [];
      let eviction: EvictionUnit | undefined;
      let unresolvedCards: UnresolvedCardInfo[] | undefined;
      let sourceContextReport: { capped?: boolean; warnings?: string[] } | undefined;
      let parseArtifacts: unknown;
      let finalizationOutcome: IngestReportFinalizationOutcome | undefined;
      let wikiSlRefRepairResult: WikiSlRefRepairResult | null = null;
      let reconcileNotes: string[] = [];
      let triageResult: PageTriageRunResult | null = null;
      if (overrideReport) {
        eviction =
          overrideReport.body.evictionInputs.length > 0
            ? { deletedRawPaths: overrideReport.body.evictionInputs }
            : undefined;
        unresolvedCards = overrideReport.body.unresolvedCards;
        await stage2?.updateProgress(1.0, `Loaded prior report ${overrideReport.jobId} for override reconciliation`);
      } else {
        const chunk = await traceTimed(
          runTrace,
          'planning',
          'chunk_work_units',
          {
            stagedDir,
            added: diffSet.added.length,
            modified: diffSet.modified.length,
            deleted: diffSet.deleted.length,
          },
          () => adapter.chunk(stagedDir, diffSet),
        );
        workUnits = chunk.workUnits;
        eviction = chunk.eviction;
        unresolvedCards = chunk.unresolvedCards;
        sourceContextReport = chunk.contextReport;
        parseArtifacts = chunk.parseArtifacts;
        reconcileNotes = chunk.reconcileNotes ?? [];
        const pageTriage = this.deps.pageTriage;
        const triageRunId = runRow.id;
        triageResult =
          contextReport && adapter.triageSupported && pageTriage
            ? await traceTimed(runTrace, 'triage', 'page_triage', { sourceKey: job.sourceKey }, () =>
                pageTriage.triageRun({
                  stagedDir,
                  runId: triageRunId,
                  connectionId: job.connectionId,
                  sourceKey: job.sourceKey,
                  syncId,
                  jobId: job.jobId,
                  diffSet,
                  adapter,
                }),
              )
            : null;
        workUnits = this.filterWorkUnitsForTriage(workUnits, triageResult);
        const clusterWorkUnits = adapter.clusterWorkUnits;
        if (clusterWorkUnits && workUnits.length > 0) {
          const preClusterCount = workUnits.length;
          workUnits = await traceTimed(
            runTrace,
            'clustering',
            'cluster_work_units',
            { workUnitCount: preClusterCount },
            () => clusterWorkUnits({ workUnits, stagedDir, embedding: this.deps.embedding }),
          );
        }
        await stage2?.updateProgress(1.0, `Planned ${workUnits.length} update${workUnits.length === 1 ? '' : 's'}`);
      }
      await runTrace.event('debug', 'planning', 'work_units_planned', {
        workUnitCount: workUnits.length,
        evictionCount: eviction?.deletedRawPaths.length ?? 0,
        unresolvedCardCount: unresolvedCards?.length ?? 0,
        triageEnabled: triageResult?.enabled ?? false,
      });

      const targetConnectionIds = new Set<string>([job.connectionId]);
      if (!overrideReport && adapter.listTargetConnectionIds) {
        for (const connectionId of await adapter.listTargetConnectionIds(stagedDir)) {
          targetConnectionIds.add(connectionId);
        }
      }
      if (overrideReport) {
        for (const wu of overrideReport.body.workUnits) {
          for (const action of wu.actions) {
            if (action.target === 'sl' && action.targetConnectionId) {
              targetConnectionIds.add(action.targetConnectionId);
            }
          }
          for (const touched of wu.touchedSlSources) {
            targetConnectionIds.add(touched.connectionId);
          }
        }
      }
      const slConnectionIds = [...targetConnectionIds].sort();
      await runTrace.event('debug', 'planning', 'target_connections_resolved', {
        connectionIds: slConnectionIds,
      });

      // Build shared per-job context.
      const [wikiIndex, slIndex] = await traceTimed(
        runTrace,
        'index_build',
        'build_indexes',
        { connectionCount: slConnectionIds.length },
        () => Promise.all([this.buildWikiIndex(), this.buildSlIndex(slConnectionIds)]),
      );

      const baseFraming = await this.deps.promptService.loadPrompt('memory_agent_bundle_ingest_work_unit');
      const wuSkillNames = Array.from(
        new Set<string>([...adapter.skillNames, 'ingest_triage', 'sl_capture', 'wiki_capture']),
      );
      const wuSkills = await this.deps.skillsRegistry.listSkills(wuSkillNames, 'memory_agent');
      const skillsPrompt = this.deps.skillsRegistry.buildSkillsPrompt(wuSkills, 'memory_agent');
      const canonicalPins = await this.deps.canonicalPins.listPins(slConnectionIds);
      const workUnitModelRole = 'candidateExtraction' as const;
      const workUnitPromptFingerprint = computeIngestWorkUnitPromptFingerprint({
        cliVersion: this.deps.settings.cliVersion,
        baseFraming,
        skillsPrompt,
        canonicalPins,
        sourceKey: job.sourceKey,
        connectionId: job.connectionId,
        skillNames: wuSkillNames,
      });

      const workUnitOutcomes: WorkUnitOutcome[] = [];
      const failedWorkUnits: string[] = [];
      const stageIndex: StageIndex = overrideReport
        ? buildStageIndexFromReportBody(job.jobId, overrideReport.connectionId, overrideReport.body)
        : {
            jobId: job.jobId,
            connectionId: job.connectionId,
            workUnits: [],
            conflictsResolved: [],
            evictionsApplied: [],
            unmappedFallbacks: [],
            artifactResolutions: [],
          };
      const memoryFlowPlannedWorkUnits = overrideReport
        ? stageIndex.workUnits.map(stageIndexWorkUnitToMemoryFlowPlannedWorkUnit)
        : workUnits.map(workUnitToMemoryFlowPlannedWorkUnit);
      memoryFlow?.update({ plannedWorkUnits: memoryFlowPlannedWorkUnits });
      memoryFlow?.emit({
        type: 'chunks_planned',
        chunkCount: memoryFlowPlannedWorkUnits.length,
        workUnitCount: memoryFlowPlannedWorkUnits.length,
        evictionCount: eviction?.deletedRawPaths.length ?? 0,
      });
      const isolatedDiffEnabled = !overrideReport;
      const isolatedDiffSummary = {
        enabled: isolatedDiffEnabled,
        integrationWorktreePath: isolatedDiffEnabled ? sessionWorktree.workdir : undefined,
        ingestionBaseSha: undefined as string | undefined,
        projectionSha: null as string | null,
        acceptedPatches: 0,
        textualConflicts: 0,
        semanticConflicts: 0,
        resolverAttempts: 0,
        resolverRepairs: 0,
        resolverFailures: 0,
      };
      latestIsolatedDiffSummary = isolatedDiffSummary;

      const stage3 = ctx?.startPhase(0.6);
      await stage3?.updateProgress(0.0, `Processing ${workUnits.length} update${workUnits.length === 1 ? '' : 's'}`);
      activePhase = 'work_units';
      this.logger.log(`[ingest-bundle] job=${job.jobId} tool-call transcripts: ${transcriptDir}/`);
      let projectionTouchedSources: TouchedSlSource[] = [];
      let projectionChangedWikiPageKeys: string[] = [];
      let projectionTouchedPaths: string[] = [];

      if (!overrideReport) {
        await runTrace.event('info', 'routing', 'isolated_diff_enabled', {
          sourceKey: job.sourceKey,
          workUnitCount: workUnits.length,
          integrationWorktreePath: sessionWorktree.workdir,
        });

        if (adapter.project) {
          const preProjectionSha = await sessionWorktree.git.revParseHead();
          const projection = await traceTimed(
            runTrace,
            'projection',
            'deterministic_projection',
            { sourceKey: job.sourceKey },
            () =>
              adapter.project!({
                connectionId: job.connectionId,
                sourceKey: job.sourceKey,
                syncId,
                jobId: job.jobId,
                runId: createdRunRow.id,
                stagedDir,
                workdir: sessionWorktree.workdir,
                parseArtifacts,
                semanticLayerService: this.deps.semanticLayerService,
              }),
          );
          if (projection.errors.length > 0) {
            await this.deps.runs.markFailed(runRow.id);
            throw new Error(`deterministic projection failed: ${projection.errors.join('; ')}`);
          }
          projectionTouchedSources = projection.touchedSources;
          projectionChangedWikiPageKeys = projection.changedWikiPageKeys;
          const projectionPaths = [
            ...(await this.touchedSlSourcePaths(sessionWorktree.workdir, projection.touchedSources)),
            ...projection.changedWikiPageKeys.map((pageKey) => `wiki/global/${pageKey}.md`),
          ];
          projectionTouchedPaths = projectionPaths;
          const projectionCommit =
            projectionPaths.length > 0
              ? await sessionWorktree.git.commitFiles(
                  projectionPaths,
                  `ingest(${job.sourceKey}): deterministic projection syncId=${syncId}`,
                  this.deps.storage.systemGitAuthor.name,
                  this.deps.storage.systemGitAuthor.email,
                )
              : await sessionWorktree.git.commitStaged(
                  `ingest(${job.sourceKey}): deterministic projection syncId=${syncId}`,
                  this.deps.storage.systemGitAuthor.name,
                  this.deps.storage.systemGitAuthor.email,
                );
          isolatedDiffSummary.projectionSha =
            projectionCommit.created || projectionCommit.commitHash !== preProjectionSha
              ? projectionCommit.commitHash
              : null;
          await runTrace.event('debug', 'projection', 'deterministic_projection_committed', {
            projectionSha: isolatedDiffSummary.projectionSha,
            touchedSources: projectionTouchedSources,
            changedWikiPageKeys: projectionChangedWikiPageKeys,
            warnings: projection.warnings,
          });
        }

        const ingestionBaseSha = await sessionWorktree.git.revParseHead();
        isolatedDiffSummary.ingestionBaseSha = ingestionBaseSha;
        const patchDir = join(this.deps.storage.homeDir, 'ingest-patches', job.jobId);
        const workUnitSettings = {
          maxConcurrency: this.deps.settings.workUnitMaxConcurrency ?? 1,
          stepBudget: this.deps.settings.workUnitStepBudget ?? 40,
          failureMode: this.deps.settings.workUnitFailureMode ?? 'continue',
        };
        const limitWorkUnit = pLimit(workUnitSettings.maxConcurrency);
        const workUnitOutcomesByIndex: WorkUnitOutcome[] = [];
        let completedWorkUnits = 0;

        if (workUnits.length === 0) {
          await stage3?.updateProgress(1.0, '0 of 0 work units complete');
        }

        const runFreshIsolatedWorkUnit = async (wu: WorkUnit, index: number): Promise<WorkUnitOutcome> =>
          runIsolatedWorkUnit({
            unitIndex: index,
            ingestionBaseSha,
            sessionWorktreeService: this.deps.sessionWorktreeService,
            patchDir,
            trace: runTrace,
            workUnit: wu,
            abortSignal: ctx?.abortSignal,
            afterSuccess: (child) => copyTransientIngestEvidence(child.workdir, sessionWorktree.workdir),
            run: async (child) => {
              const scopedWikiService = this.deps.wikiService.forWorktree(child.workdir);
              const scopedSemanticLayerService = this.deps.semanticLayerService.forWorktree(child.workdir);
              return this.runWorkUnitInWorktree({
                job,
                syncId,
                wu,
                worktree: child,
                stagedDir,
                contextReport,
                ingestToolMetadata,
                slConnectionIds,
                wikiIndex,
                slIndex,
                priorProvenance: await this.deps.provenance.findLatestArtifactsForRawPaths(
                  job.connectionId,
                  job.sourceKey,
                  wu.rawFiles,
                ),
                scopedWikiService,
                scopedSemanticLayerService,
                baseFraming,
                skillsPrompt,
                canonicalPins,
                workUnitSettings,
                transcriptDir,
                transcriptSummaries,
                recordTranscriptEntry,
                stageIndex,
                includeContextEvidenceTools: adapter.evidenceIndexing === 'documents' && !!contextReport,
                currentTableExists: (tableRef) =>
                  this.tableRefExistsInSemanticLayer(scopedSemanticLayerService, slConnectionIds, tableRef),
                abortSignal: ctx?.abortSignal,
                memoryFlow,
                wuSkillNames,
              });
            },
          });

        try {
          await Promise.all(
            workUnits.map((wu, index) =>
              limitWorkUnit(() =>
                this.withRateLimitWorkSlot(ctx?.abortSignal, async () => {
                  const cached = await this.cachedWorkUnitOutcome({
                    runId: createdRunRow.id,
                    syncId,
                    connectionId: job.connectionId,
                    sourceKey: job.sourceKey,
                    stagedDir,
                    unit: wu,
                    unitIndex: index,
                    patchDir,
                    ingestionBaseSha,
                    promptFingerprint: workUnitPromptFingerprint,
                    modelRole: workUnitModelRole,
                    trace: runTrace,
                  });
                  const outcome = cached.cacheHit ? cached : await runFreshIsolatedWorkUnit(wu, index);
                  if (!cached.cacheHit) {
                    await this.saveSuccessfulWorkUnitCache({
                      runId: createdRunRow.id,
                      syncId,
                      connectionId: job.connectionId,
                      sourceKey: job.sourceKey,
                      inputHash: cached.cacheInputHash,
                      outcome,
                    });
                  }
                  workUnitOutcomesByIndex[index] = outcome;
                  for (const action of outcome.actions) {
                    memoryFlow?.emit({
                      type: 'candidate_action',
                      unitKey: outcome.unitKey,
                      target: action.target,
                      action: action.type,
                      key: action.key,
                    });
                  }
                  memoryFlow?.emit({
                    type: 'work_unit_finished',
                    unitKey: outcome.unitKey,
                    status: outcome.status,
                    ...(outcome.reason ? { reason: outcome.reason } : {}),
                  });
                  completedWorkUnits += 1;
                  await stage3?.updateProgress(
                    completedWorkUnits / workUnits.length,
                    `${completedWorkUnits} of ${workUnits.length} work units complete`,
                  );
                }),
              ),
            ),
          );
        } catch (error) {
          await this.deps.runs.markFailed(runRow.id);
          throw error;
        }

        const refreshWorkUnitState = () => {
          workUnitOutcomes.length = 0;
          workUnitOutcomes.push(
            ...workUnitOutcomesByIndex.filter((outcome): outcome is WorkUnitOutcome => Boolean(outcome)),
          );
          failedWorkUnits.length = 0;
          failedWorkUnits.push(
            ...workUnitOutcomes.filter((outcome) => outcome.status === 'failed').map((outcome) => outcome.unitKey),
          );
          latestWorkUnits = workUnitOutcomes;
          latestFailedWorkUnits = failedWorkUnits;
          stageIndex.workUnits = workUnitOutcomes.map((o) => ({
            unitKey: o.unitKey,
            rawFiles: workUnits.find((w) => w.unitKey === o.unitKey)?.rawFiles ?? [],
            status: o.status,
            reason: o.reason,
            actions: o.actions,
            touchedSlSources: o.touchedSlSources,
            slDisallowed: o.slDisallowed,
            slDisallowedReason: o.slDisallowedReason,
          }));
        };
        refreshWorkUnitState();

        activePhase = 'integration';
        const integrablePatchCount = workUnitOutcomesByIndex.filter(
          (outcome) => outcome?.status === 'success' && !!outcome.patchPath,
        ).length;
        let integratedPatchCount = 0;
        for (const [index, outcome] of workUnitOutcomesByIndex.entries()) {
          if (!outcome || outcome.status !== 'success' || !outcome.patchPath) {
            continue;
          }
          const wu = workUnits[index];
          if (!wu) {
            continue;
          }
          let outcomeForIntegration: WorkUnitOutcome | CachedWorkUnitOutcome = outcome;
          let recomputedCachedPatch = false;
          while (true) {
            const patchPath = outcomeForIntegration.patchPath;
            if (!patchPath) {
              activeFailureDetails = undefined;
              break;
            }
            const integrationFailureDetails = {
              unitKey: outcomeForIntegration.unitKey,
              patchPath,
              allowedTargetConnectionIds: slConnectionIds,
            };
            activeFailureDetails = integrationFailureDetails;
            emitStageProgress(
              'integration',
              80,
              `Integrating ${integratedPatchCount + 1}/${integrablePatchCount} patches: ${outcomeForIntegration.unitKey}`,
            );
            const integration = await integrateWorkUnitPatch({
              unitKey: outcomeForIntegration.unitKey,
              patchPath,
              integrationGit: sessionWorktree.git,
              trace: runTrace,
              author: this.deps.storage.systemGitAuthor,
              slDisallowed: wu.slDisallowed === true,
              allowedTargetConnectionIds: new Set(slConnectionIds),
              validateAppliedTree: async (touchedPaths) => {
                const gate = await validateFinalIngestArtifacts({
                  connectionIds: slConnectionIds,
                  changedWikiPageKeys: this.wikiPageKeysFromPaths(touchedPaths),
                  touchedSlSources: await this.touchedSlSourcesFromPaths(
                    sessionWorktree,
                    touchedPaths,
                    await sessionWorktree.git.revParseHead(),
                  ),
                  wikiService: this.deps.wikiService.forWorktree(sessionWorktree.workdir),
                  semanticLayerService: this.deps.semanticLayerService.forWorktree(sessionWorktree.workdir),
                  validateTouchedSources: (touched) =>
                    validateWuTouchedSources(
                      {
                        semanticLayerService: this.deps.semanticLayerService.forWorktree(sessionWorktree.workdir),
                        connections: this.deps.connections,
                        configService: sessionWorktree.config,
                        gitService: sessionWorktree.git,
                        slSourcesRepository: this.deps.slSourcesRepository,
                        probeRowCount: this.deps.settings.probeRowCount,
                        slValidator: this.deps.slValidator,
                      },
                      touched,
                    ),
                  tableExists: (connectionId, tableRef) =>
                    this.tableRefExistsInSemanticLayer(
                      this.deps.semanticLayerService.forWorktree(sessionWorktree.workdir),
                      [connectionId],
                      tableRef,
                    ),
                });
                if (!gate.ok) {
                  const blocking = gate.findings.filter((finding) => !isFinalArtifactGateFindingPruneable(finding));
                  if (blocking.length > 0) {
                    throw new Error(formatFinalArtifactGateFindings(blocking));
                  }
                  await runTrace.event('debug', 'integration', 'patch_semantic_gate_deferred_to_final_prune', {
                    unitKey: outcomeForIntegration.unitKey,
                    findings: gate.findings,
                  });
                }
              },
              resolveTextualConflict: async (context) => {
                emitStageProgress('integration', 81, `Resolving text conflict for ${context.unitKey}`);
                const result = await resolveTextualConflict({
                  agentRunner: this.deps.agentRunner,
                  workdir: sessionWorktree.workdir,
                  unitKey: context.unitKey,
                  patchPath: context.patchPath,
                  touchedPaths: context.touchedPaths,
                  trace: runTrace,
                  reason: context.reason,
                  verify: context.verify,
                  maxAttempts: 2,
                  stepBudget: 12,
                  abortSignal: ctx?.abortSignal,
                });
                emitStageProgress(
                  'integration',
                  82,
                  result.status === 'repaired'
                    ? `Resolved text conflict for ${context.unitKey}`
                    : `Text conflict resolver failed for ${context.unitKey}`,
                );
                return result;
              },
            });
            if (integration.textualResolution) {
              isolatedDiffSummary.resolverAttempts += integration.textualResolution.attempts;
              if (integration.textualResolution.status === 'repaired') {
                isolatedDiffSummary.textualConflicts += 1;
                isolatedDiffSummary.resolverRepairs += 1;
              } else {
                isolatedDiffSummary.resolverFailures += 1;
              }
            }
            if (
              integration.status !== 'accepted' &&
              isCachedWorkUnitOutcome(outcomeForIntegration) &&
              !recomputedCachedPatch
            ) {
              await this.deps.contentCache.deleteResult({
                namespace: INGEST_WORK_UNIT_CACHE_NAMESPACE,
                scopeKey: ingestWorkUnitCacheScopeKey({ connectionId: job.connectionId, sourceKey: job.sourceKey }),
                inputHash: outcomeForIntegration.cacheInputHash,
              });
              await runTrace.event('debug', 'integration', 'work_unit_cache_stale_recompute', {
                unitKey: outcomeForIntegration.unitKey,
                inputHash: outcomeForIntegration.cacheInputHash,
                reason: integration.reason,
              });
              const recomputed = await runFreshIsolatedWorkUnit(wu, index);
              workUnitOutcomesByIndex[index] = recomputed;
              await this.saveSuccessfulWorkUnitCache({
                runId: createdRunRow.id,
                syncId,
                connectionId: job.connectionId,
                sourceKey: job.sourceKey,
                inputHash: outcomeForIntegration.cacheInputHash,
                outcome: recomputed,
              });
              refreshWorkUnitState();
              if (recomputed.status !== 'success' || !recomputed.patchPath) {
                activeFailureDetails = undefined;
                break;
              }
              outcomeForIntegration = recomputed;
              recomputedCachedPatch = true;
              continue;
            }
            if (integration.status === 'textual_conflict') {
              isolatedDiffSummary.textualConflicts += 1;
              await this.deps.runs.markFailed(runRow.id);
              cleanupOutcome = 'conflict';
              activeFailureDetails = {
                ...integrationFailureDetails,
                touchedPaths: integration.touchedPaths,
                reason: integration.reason,
              };
              throw new Error(`isolated diff textual conflict in ${outcomeForIntegration.unitKey}: ${integration.reason}`);
            }
            if (integration.status === 'semantic_conflict') {
              isolatedDiffSummary.semanticConflicts += 1;
              await this.deps.runs.markFailed(runRow.id);
              cleanupOutcome = 'conflict';
              activeFailureDetails = {
                ...integrationFailureDetails,
                touchedPaths: integration.touchedPaths,
                reason: integration.reason,
              };
              throw new Error(`isolated diff semantic conflict in ${outcomeForIntegration.unitKey}: ${integration.reason}`);
            }
            activeFailureDetails = undefined;
            if (integration.touchedPaths.length > 0) {
              isolatedDiffSummary.acceptedPatches += 1;
              integratedPatchCount += 1;
            }
            emitStageProgress(
              'integration',
              83,
              `Integrated ${integratedPatchCount}/${integrablePatchCount} patches`,
            );
            break;
          }
        }

      }
      const carryForwardResult =
        contextReport && this.deps.contextCandidateCarryforward
          ? await this.deps.contextCandidateCarryforward.carryForward({
              runId: runRow.id,
              connectionId: job.connectionId,
              sourceKey: job.sourceKey,
            })
          : null;
      const dedupResult =
        contextReport && this.deps.candidateDedup ? await this.deps.candidateDedup.deduplicateRun(runRow.id) : null;
      const preReconciliationSha = await sessionWorktree.git.revParseHead();
      activePhase = 'reconciliation';

      // Stage 4 — reconciliation. Shares scoped wiki/SL with a fresh CaptureSession
      // so reconciliation writes land in the same worktree Stage 3 used.
      const reconcileSession: CaptureSession = {
        userId: 'system',
        chatId: `${job.jobId}-reconcile`,
        userMessage: `reconcile(${job.sourceKey})`,
        connectionId: job.connectionId,
        userScopedEnabled: false,
        forceGlobalScope: true,
        touchedSlSources: createTouchedSlSources(),
        preHead: await sessionWorktree.git.revParseHead(),
      };
      const reconcileActions: MemoryAction[] = [];
      const rcScopedWiki = this.deps.wikiService.forWorktree(sessionWorktree.workdir);
      const rcScopedSl = this.deps.semanticLayerService.forWorktree(sessionWorktree.workdir);
      const reconciliationAllowedRawPaths = new Set<string>([
        ...currentHashes.keys(),
        ...(eviction?.deletedRawPaths ?? []),
      ]);

      const rcToolSession: ToolSession = {
        connectionId: job.connectionId,
        isWorktreeScoped: true,
        preHead: reconcileSession.preHead,
        touchedSlSources: reconcileSession.touchedSlSources,
        actions: reconcileActions,
        allowedRawPaths: reconciliationAllowedRawPaths,
        allowedConnectionNames: new Set(slConnectionIds),
        semanticLayerService: rcScopedSl,
        wikiService: rcScopedWiki,
        configService: sessionWorktree.config,
        gitService: sessionWorktree.git,
        ingest: ingestToolMetadata,
        evictionDecisions: [],
      };

      const rcToolset = this.deps.toolsetFactory.createIngestWuToolset(rcToolSession, {
        includeContextEvidenceTools: adapter.evidenceIndexing === 'documents' && !!contextReport,
      });
      const rcToolContext: ToolContext = {
        sourceId: 'ingest',
        messageId: `${job.jobId}-reconcile`,
        userId: 'system',
        connectionId: job.connectionId,
        ingest: ingestToolMetadata,
        session: rcToolSession,
      };
      const rcLoadSkill: KtxRuntimeToolSet = {
        load_skill: {
          name: 'load_skill',
          description: 'Load a skill.',
          inputSchema: z.object({ name: z.string() }),
          execute: async ({ name }) => {
            const skill = await this.deps.skillsRegistry.getSkill(name, 'memory_agent');
            if (!skill) {
              return { markdown: `Skill "${name}" not found` };
            }
            const body = await readFile(join(skill.path, 'SKILL.md'), 'utf-8');
            const structured = { name: skill.name, content: this.deps.skillsRegistry.stripFrontmatter(body) };
            return { markdown: `# ${structured.name}\n\n${structured.content}`, structured };
          },
        },
      };
      const allStagedPaths = new Set<string>([...currentHashes.keys()]);
      const rcRawSpanTool = {
        read_raw_span: createRuntimeToolDescriptorFromAiTool(
          'read_raw_span',
          createReadRawSpanTool({ stagedDir, allowedPaths: allStagedPaths }),
        ),
      };
      const rcStageListTool = {
        stage_list: createRuntimeToolDescriptorFromAiTool('stage_list', createStageListTool({ stageIndex })),
      };
      const rcStageDiffTool = {
        stage_diff: createRuntimeToolDescriptorFromAiTool('stage_diff', createStageDiffTool({ stageIndex })),
      };
      const rcEvictionListTool = {
        eviction_list: createRuntimeToolDescriptorFromAiTool(
          'eviction_list',
          createEvictionListTool({
            provenance: this.deps.provenance,
            connectionId: job.connectionId,
            sourceKey: job.sourceKey,
            deletedRawPaths: eviction?.deletedRawPaths ?? [],
          }),
        ),
      };
      const rcEmitConflictResolutionTool = {
        emit_conflict_resolution: createRuntimeToolDescriptorFromAiTool(
          'emit_conflict_resolution',
          createEmitConflictResolutionTool({ stageIndex }),
        ),
      };
      const rcEmitEvictionDecisionTool = {
        emit_eviction_decision: createRuntimeToolDescriptorFromAiTool(
          'emit_eviction_decision',
          createEmitEvictionDecisionTool({
            stageIndex,
            deletedRawPaths: eviction?.deletedRawPaths ?? [],
          }),
        ),
      };
      const rcEmitArtifactResolutionTool = {
        emit_artifact_resolution: createRuntimeToolDescriptorFromAiTool(
          'emit_artifact_resolution',
          createEmitArtifactResolutionTool({
            stageIndex,
            allowedPaths: allStagedPaths,
          }),
        ),
      };
      const rcEmitUnmappedFallbackTool = {
        emit_unmapped_fallback: createRuntimeToolDescriptorFromAiTool(
          'emit_unmapped_fallback',
          createEmitUnmappedFallbackTool({
            stageIndex,
            allowedPaths: allStagedPaths,
            tableRefExists: (tableRef) => this.tableRefExistsInSemanticLayer(rcScopedSl, slConnectionIds, tableRef),
          }),
        ),
      };

      const reconcileBaseFraming = await this.deps.promptService.loadPrompt('memory_agent_bundle_ingest_reconcile');
      const reconcileSkills = await this.deps.skillsRegistry.listSkills(
        Array.from(
          new Set(['ingest_triage', 'sl_capture', 'wiki_capture', ...(adapter.reconcileSkillNames ?? [])]),
        ),
        'memory_agent',
      );
      const reconcileSkillsPrompt = this.deps.skillsRegistry.buildSkillsPrompt(reconcileSkills, 'memory_agent');
      const relevantCanonicalPins = selectRelevantCanonicalPins(stageIndex, canonicalPins);

      const stage4 = ctx?.startPhase(0.16);
      const hasCandidateReconcileWork = (dedupResult?.representatives.length ?? 0) > 0;
      const hasReconcileWork =
        stageIndex.workUnits.some((wu) => wu.actions.length > 0) ||
        (eviction?.deletedRawPaths.length ?? 0) > 0 ||
        hasCandidateReconcileWork;
      if (hasReconcileWork || overrideReport) {
        emitStageProgress('reconciliation', 84, 'Reconciling results');
        await stage4?.updateProgress(0.0, 'Reconciling results');
      }

      let curatorReport = null;
      let curatorWarnings: string[] = [];
      let reconcileOutcome: Awaited<ReturnType<typeof runReconciliationStage4>>;

      // Reconcile shares the work-unit liveness model: the HUD heartbeat is driven
      // by real tool calls (a monotonic, observed count), not a re-derived turn
      // counter. The soft cap only paces the phase progress bar; it is never shown
      // to the user, so it cannot read as a misleading "X/Y" fraction.
      const reconcileTranscriptPath = join(transcriptDir, 'reconcile.jsonl');
      const reconcileProgressSoftCap = 40;
      const buildReconcileToolSetWithHeartbeat = (): KtxRuntimeToolSet => {
        const record = recordTranscriptEntry(reconcileTranscriptPath);
        return wrapToolsWithLogger(
          buildReconcileToolSet({
            loadSkillTool: rcLoadSkill,
            stageListTool: rcStageListTool,
            stageDiffTool: rcStageDiffTool,
            evictionListTool: rcEvictionListTool,
            emitConflictResolutionTool: rcEmitConflictResolutionTool,
            emitEvictionDecisionTool: rcEmitEvictionDecisionTool,
            emitArtifactResolutionTool: rcEmitArtifactResolutionTool,
            emitUnmappedFallbackTool: rcEmitUnmappedFallbackTool,
            readRawSpanTool: rcRawSpanTool,
            toolsetTools: rcToolset.toRuntimeTools(rcToolContext),
          }),
          reconcileTranscriptPath,
          'reconcile',
          {
            onEntry: (entry) => {
              const summary = record(entry);
              if (!stage4) {
                return;
              }
              const label = `Reconciling results · ${summary.toolCallCount} action${
                summary.toolCallCount === 1 ? '' : 's'
              }`;
              emitStageProgress('reconciliation', 85, label, { transient: true });
              void stage4.updateProgress(Math.min(0.95, summary.toolCallCount / reconcileProgressSoftCap), label);
            },
          },
        );
      };

      const reconcileStartedAt = Date.now();
      const reconcileMode = contextReport && this.deps.curatorPagination ? 'curator' : 'single';
      if (contextReport && this.deps.curatorPagination) {
        const curatorOutcome = await this.deps.curatorPagination.reconcile({
          runId: runRow.id,
          sourceKey: job.sourceKey,
          jobId: job.jobId,
          stageIndex,
          evictionUnit: eviction,
          representatives: dedupResult?.representatives ?? [],
          initialBudget: this.resolveContextCuratorBudget(job.bundleRef, stageIndex),
          modelRole: 'curator',
          buildSystemPrompt: () =>
            buildReconcileSystemPrompt({
              baseFraming: reconcileBaseFraming,
              skillsPrompt: reconcileSkillsPrompt,
              syncId,
              sourceKey: job.sourceKey,
              canonicalPins: relevantCanonicalPins,
            }),
          buildUserPrompt: ({ summary, items, runState }) =>
            buildReconcileUserPrompt(stageIndex, eviction, { summary, items }, reconcileNotes, runState),
          buildToolSet: (_passNumber) => buildReconcileToolSetWithHeartbeat(),
          getReconciliationActions: () => reconcileActions,
          abortSignal: ctx?.abortSignal,
        });
        curatorReport = curatorOutcome.report;
        curatorWarnings = curatorOutcome.warnings;
        reconcileOutcome = {
          skipped: curatorOutcome.skipped,
          stopReason: curatorOutcome.stopReason,
          error: curatorOutcome.error,
        };
      } else {
        reconcileOutcome = await runReconciliationStage4({
          stageIndex,
          evictionUnit: eviction,
          agentRunner: this.deps.agentRunner,
          buildSystemPrompt: () =>
            buildReconcileSystemPrompt({
              baseFraming: reconcileBaseFraming,
              skillsPrompt: reconcileSkillsPrompt,
              syncId,
              sourceKey: job.sourceKey,
              canonicalPins: relevantCanonicalPins,
            }),
          buildUserPrompt: (idx, ev) => buildReconcileUserPrompt(idx, ev, undefined, reconcileNotes),
          buildToolSet: () => buildReconcileToolSetWithHeartbeat(),
          modelRole: 'reconcile',
          stepBudget: 60,
          sourceKey: job.sourceKey,
          jobId: job.jobId,
          force: !!overrideReport,
          abortSignal: ctx?.abortSignal,
        });
      }
      await runTrace.event(
        'debug',
        'reconciliation',
        'reconciliation_executed',
        {
          mode: reconcileMode,
          skipped: reconcileOutcome.skipped,
          ...(reconcileOutcome.stopReason ? { stopReason: reconcileOutcome.stopReason } : {}),
          ...(reconcileOutcome.metrics
            ? {
                agentLoopMs: reconcileOutcome.metrics.totalMs,
                stepCount: reconcileOutcome.metrics.stepCount,
                ...(reconcileOutcome.metrics.usage.inputTokens !== undefined
                  ? { inputTokens: reconcileOutcome.metrics.usage.inputTokens }
                  : {}),
                ...(reconcileOutcome.metrics.usage.outputTokens !== undefined
                  ? { outputTokens: reconcileOutcome.metrics.usage.outputTokens }
                  : {}),
                ...(reconcileOutcome.metrics.usage.totalTokens !== undefined
                  ? { totalTokens: reconcileOutcome.metrics.usage.totalTokens }
                  : {}),
              }
            : {}),
        },
        undefined,
        Date.now() - reconcileStartedAt,
      );
      latestReconciliationSkipped = reconcileOutcome.skipped;

      const danglingReconcileWikiRefs = await findDanglingWikiRefsForActions({
        wikiService: rcScopedWiki,
        scope: 'GLOBAL',
        scopeId: null,
        actions: reconcileActions,
      });
      if (danglingReconcileWikiRefs.length > 0) {
        await this.deps.runs.markFailed(runRow.id);
        throw new Error(`wiki references target missing page(s): ${danglingReconcileWikiRefs.join(', ')}`);
      }

      const candidateSummaryAfterReconcile =
        contextReport && this.deps.contextEvidenceCandidates
          ? await this.deps.contextEvidenceCandidates.getCandidateSummary(runRow.id)
          : null;
      memoryFlow?.emit({
        type: 'reconciliation_finished',
        conflictCount: stageIndex.conflictsResolved.length,
        fallbackCount: stageIndex.unmappedFallbacks.length,
      });
      await runTrace.event('debug', 'reconciliation', 'reconciliation_finished', {
        skipped: reconcileOutcome.skipped,
        stopReason: reconcileOutcome.stopReason ?? null,
        actionCount: reconcileActions.length,
        conflictCount: stageIndex.conflictsResolved.length,
        fallbackCount: stageIndex.unmappedFallbacks.length,
        artifactResolutionCount: stageIndex.artifactResolutions?.length ?? 0,
      });

      await stage4?.updateProgress(1.0, reconcileOutcome.skipped ? 'No reconciliation needed' : 'Reconciled');

      const preFinalizationSha = await sessionWorktree.git.revParseHead();
      const preFinalizationSourcesByConnection = await this.loadSourcesByConnection(
        sessionWorktree.workdir,
        slConnectionIds,
      );
      let finalizationActions: MemoryAction[] = [];
      let finalizationTouchedPaths: string[] = [];
      let finalizationTouchedSources: TouchedSlSource[] = [];
      let finalizationChangedWikiPageKeys: string[] = [];
      let finalizationSha: string | null = null;

      activePhase = 'finalization';
      if (adapter.finalize) {
        const stageFinalization = ctx?.startPhase(0.04);
        const finalizationStartedAt = Date.now();
        emitStageProgress('finalization', 87, 'Running deterministic finalization');
        await stageFinalization?.updateProgress(0.0, 'Running deterministic finalization');
        await runTrace.event('debug', 'finalization', 'finalization_started', { sourceKey: job.sourceKey });
        const result = await adapter.finalize({
          connectionId: job.connectionId,
          sourceKey: job.sourceKey,
          syncId,
          jobId: job.jobId,
          runId: createdRunRow.id,
          stagedDir,
          workdir: sessionWorktree.workdir,
          ...(overrideReport ? {} : { parseArtifacts }),
          stageIndex,
          workUnitOutcomes,
          reconciliationActions: reconcileActions,
          ...(overrideReport
            ? {
                overrideReplay: {
                  priorJobId: overrideReport.jobId,
                  priorRunId: overrideReport.runId,
                  priorSyncId: overrideReport.body.syncId,
                  evictionRawPaths: overrideReport.body.evictionInputs,
                },
              }
            : {}),
        });
        if (result.errors.length > 0) {
          finalizationOutcome = {
            sourceKey: job.sourceKey,
            status: 'failed',
            commitSha: null,
            touchedPaths: [],
            declaredTouchedSources: result.touchedSources,
            derivedTouchedSources: [],
            declaredChangedWikiPageKeys: result.changedWikiPageKeys,
            derivedChangedWikiPageKeys: [],
            mismatches: [],
            result: result.result,
            errors: result.errors,
            warnings: result.warnings,
            actions: result.actions ?? [],
            provenanceExclusions: [],
          };
          latestFinalizationOutcome = finalizationOutcome;
          await runTrace.event('error', 'finalization', 'finalization_failed', {
            sourceKey: job.sourceKey,
            errors: result.errors,
            warnings: result.warnings,
          });
          throw new Error(`deterministic finalization failed: ${result.errors.join('; ')}`);
        }

        const changedBeforeFinalization = new Set([
          ...projectionTouchedPaths,
          ...workUnitOutcomes.flatMap((outcome) => outcome.patchTouchedPaths ?? []),
          ...(preReconciliationSha && preFinalizationSha !== preReconciliationSha
            ? (await sessionWorktree.git.diffNameStatus(preReconciliationSha, preFinalizationSha)).map(
                (entry) => entry.path,
              )
            : []),
        ]);
        finalizationTouchedPaths = await sessionWorktree.git.changedPaths();
        const overlapping = finalizationTouchedPaths.filter((path) => changedBeforeFinalization.has(path));
        if (overlapping.length > 0) {
          await runTrace.event('error', 'finalization', 'finalization_failed', {
            sourceKey: job.sourceKey,
            reason: 'path_overlap',
            overlappingPaths: overlapping.sort(),
          });
          throw new Error(
            `finalization modified path(s) already changed earlier in this run: ${overlapping.sort().join(', ')}`,
          );
        }

        const finalizationCommit =
          finalizationTouchedPaths.length > 0
            ? await sessionWorktree.git.commitFiles(
                finalizationTouchedPaths,
                `ingest(${job.sourceKey}): deterministic finalization syncId=${syncId}`,
                this.deps.storage.systemGitAuthor.name,
                this.deps.storage.systemGitAuthor.email,
              )
            : await sessionWorktree.git.commitStaged(
                `ingest(${job.sourceKey}): deterministic finalization syncId=${syncId}`,
                this.deps.storage.systemGitAuthor.name,
                this.deps.storage.systemGitAuthor.email,
              );
        finalizationSha = finalizationCommit.created ? finalizationCommit.commitHash : null;
        const postFinalizationSha = await sessionWorktree.git.revParseHead();
        finalizationTouchedPaths =
          preFinalizationSha !== postFinalizationSha
            ? (await sessionWorktree.git.diffNameStatus(preFinalizationSha, postFinalizationSha)).map(
                (entry) => entry.path,
              )
            : [];

        // Validate the write scope before deriving touched sources: attribution
        // by before/after diff is only defined for connections whose
        // pre-finalization snapshot was loaded (slConnectionIds), and an
        // out-of-scope write would otherwise surface downstream as a bogus
        // unresolved-path or declaration-mismatch failure instead of the real
        // policy violation.
        await traceTimed(
          runTrace,
          'finalization',
          'semantic_layer_target_policy',
          {
            sourceKey: job.sourceKey,
            allowedTargetConnectionIds: slConnectionIds,
            touchedPaths: [...new Set(finalizationTouchedPaths)].sort(),
          },
          async () => {
            assertSemanticLayerTargetPathsAllowed({
              paths: finalizationTouchedPaths,
              allowedConnectionIds: new Set(slConnectionIds),
            });
          },
        );

        const postFinalizationSourcesByConnection = await this.loadSourcesByConnection(
          sessionWorktree.workdir,
          slConnectionIds,
        );
        const scope = deriveFinalizationTouchedSources({
          changedPaths: finalizationTouchedPaths,
          beforeSourcesByConnection: preFinalizationSourcesByConnection,
          afterSourcesByConnection: postFinalizationSourcesByConnection,
        });
        if (scope.unresolvedPaths.length > 0) {
          await runTrace.event('error', 'finalization', 'finalization_failed', {
            sourceKey: job.sourceKey,
            reason: 'unresolved_semantic_layer_paths',
            unresolvedPaths: scope.unresolvedPaths,
          });
          throw new Error(`could not resolve finalization semantic-layer path(s): ${scope.unresolvedPaths.join(', ')}`);
        }
        finalizationTouchedSources = scope.touchedSources;
        finalizationChangedWikiPageKeys = deriveFinalizationWikiPageKeys(finalizationTouchedPaths);
        const mismatches = compareFinalizationDeclarations({
          declaredTouchedSources: result.touchedSources,
          derivedTouchedSources: finalizationTouchedSources,
          declaredChangedWikiPageKeys: result.changedWikiPageKeys,
          derivedChangedWikiPageKeys: finalizationChangedWikiPageKeys,
        });
        if (mismatches.length > 0) {
          finalizationOutcome = {
            sourceKey: job.sourceKey,
            status: 'failed',
            commitSha: finalizationSha,
            touchedPaths: finalizationTouchedPaths,
            declaredTouchedSources: result.touchedSources,
            derivedTouchedSources: finalizationTouchedSources,
            declaredChangedWikiPageKeys: result.changedWikiPageKeys,
            derivedChangedWikiPageKeys: finalizationChangedWikiPageKeys,
            mismatches,
            result: result.result,
            errors: ['finalization touched artifact declaration mismatch'],
            warnings: result.warnings,
            actions: result.actions ?? [],
            provenanceExclusions: [],
          };
          latestFinalizationOutcome = finalizationOutcome;
          await runTrace.event('error', 'finalization', 'finalization_failed', {
            sourceKey: job.sourceKey,
            reason: 'declaration_mismatch',
            mismatches,
          });
          throw new Error(
            `finalization touched artifact declaration mismatch: ${mismatches
              .map((mismatch) => `${mismatch.direction}:${mismatch.artifactKind}:${mismatch.key}`)
              .join(', ')}`,
          );
        }
        finalizationActions = result.actions ?? [];
        finalizationOutcome = {
          sourceKey: job.sourceKey,
          status: 'success',
          commitSha: finalizationSha,
          touchedPaths: finalizationTouchedPaths,
          declaredTouchedSources: result.touchedSources,
          derivedTouchedSources: finalizationTouchedSources,
          declaredChangedWikiPageKeys: result.changedWikiPageKeys,
          derivedChangedWikiPageKeys: finalizationChangedWikiPageKeys,
          mismatches,
          result: result.result,
          errors: [],
          warnings: result.warnings,
          actions: finalizationActions,
          provenanceExclusions: [],
        };
        latestFinalizationOutcome = finalizationOutcome;
        emitStageProgress('finalization', 88, 'Deterministic finalization complete');
        await stageFinalization?.updateProgress(1.0, 'Deterministic finalization complete');
        await runTrace.event(
          'debug',
          'finalization',
          'finalization_committed',
          {
            sourceKey: job.sourceKey,
            commitSha: finalizationSha,
            touchedPaths: finalizationTouchedPaths,
            touchedSources: finalizationTouchedSources,
            changedWikiPageKeys: finalizationChangedWikiPageKeys,
            warnings: result.warnings,
          },
          undefined,
          Date.now() - finalizationStartedAt,
        );
      } else {
        await runTrace.event('debug', 'finalization', 'finalization_skipped', { sourceKey: job.sourceKey });
      }

      const repairConnectionIds = [
        ...new Set([
          ...slConnectionIds,
          ...finalizationTouchedSources.map((source) => source.connectionId),
        ]),
      ].sort();
      const preWikiSlRefRepairSha = await sessionWorktree.git.revParseHead();
      const preWikiSlRefRepairPaths =
        preReconciliationSha && preWikiSlRefRepairSha && preReconciliationSha !== preWikiSlRefRepairSha
          ? (await sessionWorktree.git.diffNameStatus(preReconciliationSha, preWikiSlRefRepairSha)).map(
              (entry) => entry.path,
            )
          : [];
      const wikiPageKeysForFinalPrune = this.uniqueWikiPageKeys([
        ...(isolatedDiffEnabled ? projectionChangedWikiPageKeys : []),
        ...workUnitOutcomes
          .flatMap((outcome) => outcome.patchTouchedPaths ?? [])
          .flatMap((path) => this.wikiPageKeysFromPaths([path])),
        ...this.wikiPageKeysFromActions(reconcileActions),
        ...finalizationChangedWikiPageKeys,
        ...preWikiSlRefRepairPaths.flatMap((path) => this.wikiPageKeysFromPaths([path])),
      ]);
      activePhase = 'wiki_sl_ref_repair';
      emitStageProgress('wiki_sl_ref_repair', 88, 'Repairing wiki semantic-layer references');
      wikiSlRefRepairResult = await traceTimed(
        runTrace,
        'wiki_sl_ref_repair',
        'wiki_sl_refs_repair',
        { connectionIds: repairConnectionIds },
        () =>
          repairWikiSlRefs({
            wikiService: this.deps.wikiService.forWorktree(sessionWorktree.workdir),
            semanticLayerService: this.deps.semanticLayerService.forWorktree(sessionWorktree.workdir),
            configService: sessionWorktree.config,
            connectionIds: repairConnectionIds,
            deferGlobalPageKeys: wikiPageKeysForFinalPrune,
          }),
      );
      await runTrace.event('debug', 'wiki_sl_ref_repair', 'wiki_sl_refs_repaired', {
        repairCount: wikiSlRefRepairResult.repairs.length,
        repairs: wikiSlRefRepairResult.repairs,
        warnings: wikiSlRefRepairResult.warnings,
      });
      emitStageProgress('wiki_sl_ref_repair', 88, 'Checked wiki semantic-layer references');
      const postReconciliationSha = await sessionWorktree.git.revParseHead();
      const postReconciliationPaths =
        preReconciliationSha && postReconciliationSha && preReconciliationSha !== postReconciliationSha
          ? (await sessionWorktree.git.diffNameStatus(preReconciliationSha, postReconciliationSha)).map((entry) => entry.path)
          : [];
      const baseFinalChangedWikiPageKeys = this.uniqueWikiPageKeys([
        ...(isolatedDiffEnabled ? projectionChangedWikiPageKeys : []),
        ...workUnitOutcomes
          .flatMap((outcome) => outcome.patchTouchedPaths ?? [])
          .flatMap((path) => this.wikiPageKeysFromPaths([path])),
        ...this.wikiPageKeysFromActions(reconcileActions),
        ...finalizationChangedWikiPageKeys,
        ...postReconciliationPaths.flatMap((path) => this.wikiPageKeysFromPaths([path])),
        ...wikiSlRefRepairResult.repairs.filter((repair) => repair.scope === 'GLOBAL').map((repair) => repair.pageKey),
      ]);
      const finalTouchedSlSources = this.uniqueTouchedSlSources([
        ...(isolatedDiffEnabled ? projectionTouchedSources : []),
        ...workUnitOutcomes.flatMap((outcome) => outcome.touchedSlSources),
        ...this.touchedSlSourcesFromActions(reconcileActions, job.connectionId),
        ...(await this.touchedSlSourcesFromPaths(sessionWorktree, postReconciliationPaths, preReconciliationSha)),
        ...finalizationTouchedSources,
      ]);
      const finalWikiGateScope = await this.wikiPageKeysForFinalGates({
        wikiService: this.deps.wikiService.forWorktree(sessionWorktree.workdir),
        changedWikiPageKeys: baseFinalChangedWikiPageKeys,
        touchedSlSources: finalTouchedSlSources,
        actions: [...stageIndex.workUnits.flatMap((wu) => wu.actions), ...reconcileActions],
      });
      const finalChangedWikiPageKeys = finalWikiGateScope.pageKeys;

      const finalTargetPolicyPaths = [
        ...projectionTouchedPaths,
        ...workUnitOutcomes.flatMap((outcome) => outcome.patchTouchedPaths ?? []),
        ...postReconciliationPaths,
        ...finalizationTouchedPaths,
      ];
      const targetPolicyTraceData = {
        allowedTargetConnectionIds: slConnectionIds,
        touchedPaths: [...new Set(finalTargetPolicyPaths)].sort(),
      };
      activePhase = 'target_policy';
      activeFailureDetails = targetPolicyTraceData;
      emitStageProgress('final_gates', 88, 'Checking semantic-layer target policy');
      await traceTimed(runTrace, 'target_policy', 'semantic_layer_target_policy', targetPolicyTraceData, async () => {
        assertSemanticLayerTargetPathsAllowed({
          paths: finalTargetPolicyPaths,
          allowedConnectionIds: new Set(slConnectionIds),
        });
      });
      activeFailureDetails = undefined;

      const finalArtifactGateTraceData = {
        changedWikiPageKeys: finalChangedWikiPageKeys,
        wikiReferenceGateScope: finalWikiGateScope.trace,
        touchedSlSources: finalTouchedSlSources,
        projectionTouchedPaths,
        workUnitPatchTouchedPaths: workUnitOutcomes.flatMap((outcome) => outcome.patchTouchedPaths ?? []),
        actionOrigins: this.finalGateActionOrigins({
          stageIndex,
          reconcileActions,
          fallbackConnectionId: job.connectionId,
        }),
        preReconciliationSha,
        postReconciliationSha,
        postReconciliationPaths,
        reconciliationActionCount: reconcileActions.length,
        wikiSlRefRepairCount: wikiSlRefRepairResult.repairs.length,
      };
      activePhase = 'final_gates';
      activeFailureDetails = finalArtifactGateTraceData;
      emitStageProgress('final_gates', 89, 'Running final artifact gates');
      let finalGatePrunedReferences: FinalGatePrunedReference[] = [];
      let finalGateDroppedSources: FinalGateDroppedSource[] = [];
      const runFinalArtifactGates = async (touchedSources = finalTouchedSlSources) =>
        validateFinalIngestArtifacts({
          connectionIds: repairConnectionIds,
          changedWikiPageKeys: finalChangedWikiPageKeys,
          touchedSlSources: touchedSources,
          wikiService: this.deps.wikiService.forWorktree(sessionWorktree.workdir),
          semanticLayerService: this.deps.semanticLayerService.forWorktree(sessionWorktree.workdir),
          validateTouchedSources: (touched) =>
            validateWuTouchedSources(
              {
                semanticLayerService: this.deps.semanticLayerService.forWorktree(sessionWorktree.workdir),
                connections: this.deps.connections,
                configService: sessionWorktree.config,
                gitService: sessionWorktree.git,
                slSourcesRepository: this.deps.slSourcesRepository,
                probeRowCount: this.deps.settings.probeRowCount,
                slValidator: this.deps.slValidator,
              },
              touched,
            ),
          tableExists: (connectionId, tableRef) =>
            this.tableRefExistsInSemanticLayer(
              this.deps.semanticLayerService.forWorktree(sessionWorktree.workdir),
              [connectionId],
              tableRef,
            ),
        });

      const firstGate = await traceTimed(
        runTrace,
        'final_gates',
        'final_artifact_gates',
        finalArtifactGateTraceData,
        () => runFinalArtifactGates(),
      );
      if (!firstGate.ok) {
        emitStageProgress('final_gates', 89, 'Pruning final artifact gates');
        const firstPrune = await pruneFinalGateFindings({
          workdir: sessionWorktree.workdir,
          semanticLayerFiles: sessionWorktree.config,
          findings: firstGate.findings,
          droppedSources: [],
          trace: runTrace,
          author: this.deps.storage.systemGitAuthor,
          wikiService: this.deps.wikiService.forWorktree(sessionWorktree.workdir),
        });
        finalGateDroppedSources = firstPrune.droppedSources;
        finalGatePrunedReferences = firstPrune.prunedReferences;
        const droppedKeys = new Set(
          finalGateDroppedSources.map((source) => `${source.connectionId}:${source.sourceName}`),
        );
        const touchedAfterDrop = finalTouchedSlSources.filter(
          (source) => !droppedKeys.has(`${source.connectionId}:${source.sourceName}`),
        );
        const secondGate = await runFinalArtifactGates(touchedAfterDrop);
        if (!secondGate.ok) {
          const secondPrune = await pruneFinalGateFindings({
            workdir: sessionWorktree.workdir,
            semanticLayerFiles: sessionWorktree.config,
            findings: secondGate.findings.filter((finding) => finding.kind !== 'invalid_source'),
            droppedSources: finalGateDroppedSources,
            trace: runTrace,
            author: this.deps.storage.systemGitAuthor,
            wikiService: this.deps.wikiService.forWorktree(sessionWorktree.workdir),
          });
          finalGateDroppedSources = secondPrune.droppedSources;
          finalGatePrunedReferences = [...finalGatePrunedReferences, ...secondPrune.prunedReferences];
        }
        const pruneTouchedPaths = await sessionWorktree.git.changedPaths();
        if (pruneTouchedPaths.length > 0) {
          const pruneCommit = await sessionWorktree.git.commitFiles(
            pruneTouchedPaths,
            `ingest(${job.sourceKey}): prune final gate findings syncId=${syncId}`,
            this.deps.storage.systemGitAuthor.name,
            this.deps.storage.systemGitAuthor.email,
          );
          await runTrace.event('debug', 'final_gates', 'final_gate_prune_committed', {
            commitSha: pruneCommit.created ? pruneCommit.commitHash : null,
            touchedPaths: pruneTouchedPaths,
          });
        }
        const confirmGate = await runFinalArtifactGates(touchedAfterDrop);
        if (!confirmGate.ok) {
          throw new Error(`final artifact gates still failed after prune:\n${formatFinalArtifactGateFindings(confirmGate.findings)}`);
        }
        await runTrace.event('info', 'final_gates', 'final_gate_prune_finished', {
          prunedReferences: finalGatePrunedReferences,
          droppedSources: finalGateDroppedSources,
        });
        this.markFinalGateDroppedSourceWorkUnits({
          stageIndex,
          workUnitOutcomes,
          failedWorkUnits,
          droppedSources: finalGateDroppedSources,
          fallbackConnectionId: job.connectionId,
        });
      }
      activeFailureDetails = undefined;

      activePhase = 'provenance_validation';
      emitStageProgress('provenance', 90, 'Validating provenance rows');
      latestReportWorkUnits = this.toReportWorkUnits(stageIndex);
      latestReconciliationActions = reconcileActions;
      latestConflictsResolved = stageIndex.conflictsResolved;
      latestEvictionsApplied = stageIndex.evictionsApplied;
      latestUnmappedFallbacks = stageIndex.unmappedFallbacks;
      latestArtifactResolutions = stageIndex.artifactResolutions ?? [];
      latestEvictionInputs = eviction?.deletedRawPaths ?? [];
      latestUnresolvedCards = unresolvedCards ?? [];
      const finalizationProvenance = this.partitionFinalizationActionsForProvenance({
        actions: finalizationActions,
        currentRawPaths: new Set(currentHashes.keys()),
        currentEvictionRawPaths: new Set(stageIndex.evictionsApplied.map((entry) => entry.rawPath)),
        overrideEvictionRawPaths: new Set(overrideReport?.body.evictionInputs ?? []),
      });
      if (finalizationOutcome) {
        finalizationOutcome.provenanceExclusions = finalizationProvenance.exclusions;
        latestFinalizationOutcome = finalizationOutcome;
      }
      const provenancePlan = this.buildProvenancePlan({
        job,
        syncId,
        currentHashes,
        stageIndex,
        reconcileActions,
        finalizationActions: finalizationProvenance.actions,
      });
      const provenanceRows = provenancePlan.rows;
      const currentRawPaths = new Set(currentHashes.keys());
      const deletedRawPaths = new Set(eviction?.deletedRawPaths ?? []);
      const provenanceValidationData = this.provenanceValidationTraceData({
        plan: provenancePlan,
        currentRawPaths,
        deletedRawPaths,
      });
      const reportProvenanceRows = this.toReportProvenanceRows(provenanceRows);
      latestReportProvenanceRows = reportProvenanceRows;
      activeFailureDetails = provenanceValidationData;
      await traceTimed(
        runTrace,
        'provenance',
        'provenance_rows_validation',
        provenanceValidationData,
        async () => {
          validateProvenanceRawPaths({
            rows: provenanceRows,
            currentRawPaths,
            deletedRawPaths,
          });
        },
      );
      activeFailureDetails = undefined;

      // Stage 6 — squash commit
      activePhase = 'squash';
      const stage6 = ctx?.startPhase(0.04);
      emitStageProgress('save', 91, 'Saving changes');
      await stage6?.updateProgress(0.0, 'Saving changes');
      const squashStartedAt = Date.now();
      try {
        await sessionWorktree.git.assertWorktreeClean();
      } catch (error) {
        await this.deps.runs.markFailed(runRow.id);
        throw error;
      }
      const commitMessage = this.buildCommitMessage(job, syncId, diffSummary, failedWorkUnits);
      const squashResult = await this.deps.lockingService.withLock('config:repo', async () => {
        const preSquashSha = await this.deps.gitService.revParseHead();
        const merge = await this.deps.gitService.squashMergeIntoMain(
          sessionWorktree.branch,
          this.deps.storage.systemGitAuthor.name,
          this.deps.storage.systemGitAuthor.email,
          commitMessage,
        );
        return { preSquashSha, merge };
      });
      const mergeResult = squashResult.merge;
      if (!mergeResult.ok) {
        await this.deps.runs.markFailed(runRow.id);
        throw new Error(`squash merge conflict: ${mergeResult.conflictPaths.join(', ')}`);
      }
      const commitSha = mergeResult.touchedPaths.length === 0 ? null : mergeResult.squashSha;
      await runTrace.event(
        'debug',
        'squash',
        'squash_finished',
        {
          commitSha,
          touchedPaths: mergeResult.touchedPaths,
        },
        undefined,
        Date.now() - squashStartedAt,
      );
      const memoryFlowSavedActions = stageIndex.workUnits
        .flatMap((wu) => wu.actions)
        .concat(reconcileActions)
        .concat(finalizationActions);
      memoryFlow?.emit({
        type: 'saved',
        commitSha,
        wikiCount: countMemoryFlowActions(memoryFlowSavedActions, 'wiki'),
        slCount: countMemoryFlowActions(memoryFlowSavedActions, 'sl'),
      });
      await stage6?.updateProgress(1.0, commitSha ? `Saved changes (${commitSha.slice(0, 8)})` : 'No changes to save');

      // Sync the shared `knowledge` index from the squashed diff in a single
      // transaction. If this throws, the run fails and no partial index state
      // survives (thanks to the transactional upsert in applyDiffTransactional).
      if (commitSha) {
        const indexSyncStartedAt = Date.now();
        // Multi-file squash → omit path so the handler diffs the whole commit
        // (a comma-joined pathspec would match nothing and the job would no-op).
        const pathFilter = mergeResult.touchedPaths.length === 1 ? mergeResult.touchedPaths[0] : '';
        await this.deps.commitMessages.enqueueForExternalCommit({ commitHash: commitSha }, commitMessage, pathFilter);
        await this.deps.wikiService.syncFromCommit(squashResult.preSquashSha, commitSha, runRow.id);
        await this.syncKnowledgeSlRefsFromActions(job.connectionId, memoryFlowSavedActions);
        const touchedConnections = [
          ...new Set(
            memoryFlowSavedActions
              .filter((action) => action.target === 'sl')
              .map((action) => actionTargetConnectionId(action, job.connectionId))
              .concat(finalizationTouchedSources.map((source) => source.connectionId)),
          ),
        ].sort();
        for (const connectionId of touchedConnections) {
          try {
            const { sources: allSources } = await this.deps.semanticLayerService.loadAllSources(connectionId);
            await this.deps.slSearchService.indexSources(connectionId, allSources);
          } catch (err) {
            this.logger.warn(
              `[ingest-bundle] post-squash SL reindex failed for connection=${connectionId}: ${err instanceof Error ? err.message : String(err)}`,
            );
          }
        }
        await runTrace.event(
          'debug',
          'index_sync',
          'post_squash_index_sync_finished',
          { connectionCount: touchedConnections.length },
          undefined,
          Date.now() - indexSyncStartedAt,
        );
      }

      const stage5 = ctx?.startPhase(0.04);
      emitStageProgress('provenance', 95, 'Recording history');
      await stage5?.updateProgress(0.0, 'Recording history');
      activePhase = 'provenance';

      await this.deps.provenance.insertMany(provenanceRows);
      await runTrace.event('debug', 'provenance', 'provenance_rows_inserted', {
        rowCount: provenanceRows.length,
      });
      memoryFlow?.emit({ type: 'provenance_recorded', rowCount: provenanceRows.length });
      await stage5?.updateProgress(
        1.0,
        `Recorded ${provenanceRows.length} history entr${provenanceRows.length === 1 ? 'y' : 'ies'}`,
      );

      const stage7 = ctx?.startPhase(0.04);
      emitStageProgress('report', 97, 'Wrapping up');
      await stage7?.updateProgress(0.0, 'Wrapping up');
      activePhase = 'report';

      const reportToolTranscripts = Array.from(transcriptSummaries.values()).map((summary) => ({
        unitKey: summary.unitKey,
        path: summary.path,
        toolCallCount: summary.toolCallCount,
        errorCount: summary.errorCount,
        toolNames: Array.from(summary.toolNames).sort(),
      }));
      const capturedMemoryFlow = memoryFlow?.snapshot();
      const reportMemoryFlow = capturedMemoryFlow
        ? {
            ...capturedMemoryFlow,
            metadata: {
              schemaVersion: 1 as const,
              mode: 'full' as const,
              origin: 'captured' as const,
              timing: 'captured' as const,
              capturedAt: new Date().toISOString(),
              sourceReportId: null,
              sourceReportPath: null,
              fallbackReason: null,
            },
          }
        : undefined;

      const reportBody = {
        status: 'completed' as const,
        syncId,
        diffSummary,
        fetch: fetchReport ?? undefined,
        commitSha,
        tracePath: runTrace.tracePath,
        isolatedDiff: !overrideReport ? isolatedDiffSummary : undefined,
        workUnits: stageIndex.workUnits.map((wu) => ({
          unitKey: wu.unitKey,
          rawFiles: wu.rawFiles,
          status: wu.status,
          reason: wu.reason,
          actions: wu.actions,
          touchedSlSources: wu.touchedSlSources,
          slDisallowed: wu.slDisallowed,
          slDisallowedReason: wu.slDisallowedReason,
        })),
        failedWorkUnits,
        reconciliationSkipped: reconcileOutcome.skipped,
        conflictsResolved: stageIndex.conflictsResolved,
        evictionsApplied: stageIndex.evictionsApplied,
        unmappedFallbacks: stageIndex.unmappedFallbacks,
        artifactResolutions: stageIndex.artifactResolutions ?? [],
        evictionInputs: eviction?.deletedRawPaths ?? [],
        reconciliationActions: reconcileActions,
        evictionDecisions: rcToolSession.evictionDecisions ?? [],
        unresolvedCards: unresolvedCards ?? [],
        supersededBy: null,
        overrideOf: overrideReport?.jobId ?? null,
        provenanceRows: reportProvenanceRows,
        toolTranscripts: reportToolTranscripts,
        finalization: finalizationOutcome,
        finalGatePrunedReferences,
        finalGateDroppedSources,
        wikiSlRefRepairs: wikiSlRefRepairResult.repairs,
        wikiSlRefRepairWarnings: wikiSlRefRepairResult.warnings,
        ...(reportMemoryFlow ? { memoryFlow: reportMemoryFlow } : {}),
        context: contextReport
          ? {
              documentsIndexed: contextReport.documentsIndexed,
              chunksIndexed: contextReport.chunksIndexed,
              documentsDeleted: contextReport.documentsDeleted,
              embeddingFailures: contextReport.embeddingFailures,
              candidatesCreated: candidateSummaryAfterReconcile?.total ?? 0,
              candidatesPromoted: candidateSummaryAfterReconcile?.promoted ?? 0,
              candidatesRejected: candidateSummaryAfterReconcile?.rejected ?? 0,
              triage: triageResult?.report,
              dedup: dedupResult?.enabled
                ? {
                    candidatesIn: dedupResult.candidatesIn,
                    clustersOut: dedupResult.clustersOut,
                    mergedCount: dedupResult.mergedCount,
                    largestClusterSize: dedupResult.largestClusterSize,
                    embeddingFailures: dedupResult.embeddingFailures,
                  }
                : undefined,
              curator: curatorReport ?? undefined,
              knowledgeCreates: stageIndex.workUnits
                .flatMap((wu) => wu.actions)
                .concat(reconcileActions)
                .filter((action) => action.target === 'wiki' && action.type === 'created').length,
              knowledgeUpdates: stageIndex.workUnits
                .flatMap((wu) => wu.actions)
                .concat(reconcileActions)
                .filter((action) => action.target === 'wiki' && action.type === 'updated').length,
              capped: sourceContextReport?.capped ?? false,
              warnings: [
                ...new Set([
                  ...contextReport.warnings,
                  ...(sourceContextReport?.warnings ?? []),
                  ...(triageResult?.warnings ?? []),
                  ...(carryForwardResult?.warnings ?? []),
                  ...(dedupResult?.warnings ?? []),
                  ...curatorWarnings,
                ]),
              ],
            }
          : undefined,
      };
      const createdReport = await this.deps.reports.create({
        runId: runRow.id,
        jobId: job.jobId,
        connectionId: job.connectionId,
        sourceKey: job.sourceKey,
        body: reportBody,
      });
      const reportId = reportIdFromCreateResult(createdReport);
      await runTrace.event('debug', 'report', 'success_report_created', {
        reportId,
        runId: runRow.id,
        tracePath: runTrace.tracePath,
      });
      memoryFlow?.update({
        ...(reportId ? { reportId, reportPath: reportId } : {}),
      });
      memoryFlow?.emit({
        type: 'report_created',
        runId: runRow.id,
        ...(reportId ? { reportPath: reportId } : {}),
      });
      if (overrideReport) {
        await this.deps.reports.markSuperseded(overrideReport.jobId, job.jobId);
      }
      if (contextReport && this.deps.contextEvidenceIndex) {
        await this.deps.contextEvidenceIndex.publishSync({
          connectionId: job.connectionId,
          sourceKey: job.sourceKey,
          syncId,
          diffSet,
        });
      }

      // Stage 7 — status
      await this.deps.runs.markCompleted(
        runRow.id,
        diffSummary,
        fetchReport?.status === 'partial' ? 'partial' : 'completed',
      );
      if (job.bundleRef.kind === 'scheduled_pull') {
        await adapter.onPullSucceeded?.({
          connectionId: job.connectionId,
          sourceKey: job.sourceKey,
          syncId,
          trigger: job.trigger,
          completedAt: new Date(),
          stagedDir,
        });
      }
      await stage7?.updateProgress(1.0, 'Done');
      await runTrace.event('info', 'run', 'ingest_finished', {
        status: 'completed',
        commitSha,
        failedWorkUnits,
        tracePath: runTrace.tracePath,
      });

      cleanupOutcome = 'success';
      return {
        runId: runRow.id,
        syncId,
        diffSummary,
        workUnitCount: workUnits.length,
        failedWorkUnits,
        artifactsWritten: provenanceRows.filter((r) => r.actionType !== 'skipped').length,
        commitSha,
        finalGatePrunedReferences,
        finalGateDroppedSources,
      };
    } finally {
      await this.deps.sessionWorktreeService.cleanup(sessionWorktree, cleanupOutcome);
    }
    } catch (error) {
      await activeTrace.event(
        'error',
        'run',
        'ingest_failed',
        {
          tracePath: activeTrace.tracePath,
          phase: activePhase,
          runId: runRow?.id ?? null,
          syncId,
        },
        error,
      );
      if (runRow) {
        await this.deps.runs.markFailed(runRow.id);
        await this.deps.reports.create({
          runId: runRow.id,
          jobId: job.jobId,
          connectionId: job.connectionId,
          sourceKey: job.sourceKey,
          body: {
            status: 'failed' as const,
            syncId,
            diffSummary: latestDiffSummary,
            commitSha: null,
            tracePath: activeTrace.tracePath,
            isolatedDiff: latestIsolatedDiffSummary,
            failure: {
              phase: activePhase,
              message: this.errorMessage(error),
              ...(activeFailureDetails ? { details: activeFailureDetails } : {}),
            },
            workUnits:
              latestReportWorkUnits.length > 0
                ? latestReportWorkUnits
                : latestWorkUnits.map((wu) => ({
                    unitKey: wu.unitKey,
                    rawFiles: [],
                    status: wu.status,
                    reason: wu.reason,
                    actions: wu.actions,
                    touchedSlSources: wu.touchedSlSources,
                    slDisallowed: wu.slDisallowed,
                    slDisallowedReason: wu.slDisallowedReason,
                  })),
            failedWorkUnits: latestFailedWorkUnits,
            reconciliationSkipped: latestReconciliationSkipped,
            conflictsResolved: latestConflictsResolved,
            evictionsApplied: latestEvictionsApplied,
            unmappedFallbacks: latestUnmappedFallbacks,
            artifactResolutions: latestArtifactResolutions,
            evictionInputs: latestEvictionInputs,
            reconciliationActions: latestReconciliationActions,
            finalization: latestFinalizationOutcome,
            evictionDecisions: [],
            unresolvedCards: latestUnresolvedCards,
            supersededBy: null,
            overrideOf: null,
            provenanceRows: latestReportProvenanceRows,
            toolTranscripts: Array.from(transcriptSummaries.values()).map((summary) => ({
              unitKey: summary.unitKey,
              path: summary.path,
              toolCallCount: summary.toolCallCount,
              errorCount: summary.errorCount,
              toolNames: Array.from(summary.toolNames).sort(),
            })),
          },
        });
        await activeTrace.event('info', 'report', 'failure_report_created', {
          runId: runRow.id,
          jobId: job.jobId,
          tracePath: activeTrace.tracePath,
        });
      }
      throw error;
    }
  }
}
