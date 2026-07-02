import { randomUUID } from 'node:crypto';
import { cp, mkdir, rm } from 'node:fs/promises';
import { isAbsolute, resolve } from 'node:path';
import type { KtxSqlQueryExecutorPort } from '../../context/connections/query-executor.js';
import type { SqlAnalysisPort } from '../../context/sql-analysis/ports.js';
import type { KtxLogger } from '../../context/core/config.js';
import { createAbortError, isAbortError } from '../../context/core/abort.js';
import type { KtxSemanticLayerComputePort } from '../../context/daemon/semantic-layer-compute.js';
import type { AgentRunnerPort, KtxLlmRuntimePort } from '../../context/llm/runtime-port.js';
import type { KtxLocalProject } from '../../context/project/project.js';
import { ktxLocalStateDbPath } from '../../context/project/local-state-db.js';
import { planMetabaseFanoutChildren } from './adapters/metabase/fanout-planner.js';
import { KtxYamlMetabaseSourceStateReader, LocalMetabaseDiscoveryCache } from './adapters/metabase/local-source-state-store.js';
import { localPullConfigForAdapter, type DefaultLocalIngestAdaptersOptions } from './local-adapters.js';
import { createLocalBundleIngestRuntime } from './local-bundle-runtime.js';
import type { MemoryFlowEventSink } from './memory-flow/types.js';
import { buildSyncId } from './raw-sources-paths.js';
import { ingestReportOutcome } from './reports.js';
import type { IngestReportBody, IngestReportSnapshot } from './reports.js';
import { SqliteBundleIngestStore } from './sqlite-bundle-ingest-store.js';
import type { IngestBundleResult, IngestJobContext, IngestJobPhase, IngestTrigger, SourceAdapter } from './types.js';

export interface RunLocalIngestOptions {
  project: KtxLocalProject;
  adapters: SourceAdapter[];
  adapter: string;
  connectionId: string;
  sourceDir?: string;
  pullConfigOptions?: DefaultLocalIngestAdaptersOptions;
  trigger?: IngestTrigger;
  jobId?: string;
  memoryFlow?: MemoryFlowEventSink;
  agentRunner?: AgentRunnerPort;
  llmRuntime?: KtxLlmRuntimePort;
  llmDebugRequestFile?: string;
  memoryModel?: string;
  semanticLayerCompute?: KtxSemanticLayerComputePort;
  queryExecutor?: KtxSqlQueryExecutorPort;
  sqlAnalysis?: SqlAnalysisPort;
  logger?: KtxLogger;
  embeddingProvider?: import('../../llm/types.js').KtxEmbeddingProvider | null;
  abortSignal?: AbortSignal;
}

export interface LocalIngestResult {
  result: IngestBundleResult;
  report: IngestReportSnapshot;
}

interface LocalMetabaseFanoutChild {
  jobId: string;
  metabaseConnectionId: string;
  metabaseDatabaseId: number;
  targetConnectionId: string;
  result: IngestBundleResult;
  report: IngestReportSnapshot;
}

export interface LocalMetabaseFanoutResult {
  metabaseConnectionId: string;
  children: LocalMetabaseFanoutChild[];
  status: 'all_succeeded' | 'partial_failure' | 'all_failed';
  totals?: { workUnits: number; failedWorkUnits: number };
}

interface LocalMetabaseFanoutProgressChild {
  metabaseDatabaseId: number;
  targetConnectionId: string;
}

export interface LocalMetabaseFanoutProgress {
  onMetabaseFanoutPlanned?(event: {
    metabaseConnectionId: string;
    children: LocalMetabaseFanoutProgressChild[];
  }): void;
  onMetabaseChildStarted?(event: {
    metabaseConnectionId: string;
    metabaseDatabaseId: number;
    targetConnectionId: string;
    jobId: string;
  }): void;
  onMetabaseChildCompleted?(event: {
    metabaseConnectionId: string;
    metabaseDatabaseId: number;
    targetConnectionId: string;
    jobId: string;
    status: 'done' | 'partial' | 'failed';
  }): void;
}

export interface RunLocalMetabaseIngestOptions
  extends Omit<RunLocalIngestOptions, 'adapter' | 'connectionId' | 'sourceDir' | 'jobId'> {
  metabaseConnectionId: string;
  jobIdFactory?: () => string;
  progress?: LocalMetabaseFanoutProgress;
}

class LocalIngestPhase implements IngestJobPhase {
  async updateProgress(): Promise<void> {}

  startPhase(): IngestJobPhase {
    return new LocalIngestPhase();
  }
}

function safeSegment(kind: string, value: string): string {
  if (!/^[a-zA-Z0-9_][a-zA-Z0-9_-]*$/.test(value)) {
    throw new Error(`Unsafe ${kind}: ${value}`);
  }
  return value;
}

function assertConfigured(project: KtxLocalProject, adapter: string, connectionId: string): void {
  if (!project.config.connections[connectionId]) {
    throw new Error(`Connection "${connectionId}" is not configured in ktx.yaml`);
  }
  if (!project.config.ingest.adapters.includes(adapter)) {
    throw new Error(`Adapter "${adapter}" is not enabled in ktx.yaml`);
  }
}

function findAdapter(adapters: SourceAdapter[], source: string): SourceAdapter {
  const adapter = adapters.find((candidate) => candidate.source === source);
  if (!adapter) {
    throw new Error(`Adapter "${source}" is not available for local ingest`);
  }
  return adapter;
}

function localJobContext(jobId: string, memoryFlow?: MemoryFlowEventSink, abortSignal?: AbortSignal): IngestJobContext {
  return {
    jobId,
    ...(memoryFlow ? { memoryFlow } : {}),
    ...(abortSignal ? { abortSignal } : {}),
    startPhase() {
      return new LocalIngestPhase();
    },
  };
}

async function copySourceDirToUpload(sourceDir: string, uploadDir: string): Promise<void> {
  if (!isAbsolute(sourceDir)) {
    throw new Error('sourceDir must be an absolute path');
  }
  await rm(uploadDir, { recursive: true, force: true });
  await mkdir(uploadDir, { recursive: true });
  await cp(resolve(sourceDir), uploadDir, { recursive: true });
}

async function runScheduledPullJob(options: {
  project: KtxLocalProject;
  adapters: SourceAdapter[];
  adapter: SourceAdapter;
  connectionId: string;
  pullConfig: unknown;
  trigger?: IngestTrigger;
  jobId?: string;
  memoryFlow?: MemoryFlowEventSink;
  agentRunner?: AgentRunnerPort;
  llmRuntime?: KtxLlmRuntimePort;
  memoryModel?: string;
  semanticLayerCompute?: KtxSemanticLayerComputePort;
  queryExecutor?: KtxSqlQueryExecutorPort;
  sqlAnalysis?: SqlAnalysisPort;
  logger?: KtxLogger;
  embeddingProvider?: import('../../llm/types.js').KtxEmbeddingProvider | null;
  abortSignal?: AbortSignal;
}): Promise<LocalIngestResult> {
  const runtime = createLocalBundleIngestRuntime(options);
  const jobId = options.jobId ?? runtime.nextJobId();
  const result = await runtime.runner.run(
    {
      jobId,
      connectionId: options.connectionId,
      sourceKey: options.adapter.source,
      trigger: options.trigger ?? 'manual_resync',
      bundleRef: { kind: 'scheduled_pull', config: options.pullConfig },
    },
    localJobContext(jobId, options.memoryFlow, options.abortSignal),
  );
  const report = await runtime.store.findByJobId(jobId);
  if (!report) {
    throw new Error(`Local ingest report for job "${jobId}" was not created`);
  }
  return { result, report };
}

export async function runLocalIngest(options: RunLocalIngestOptions): Promise<LocalIngestResult> {
  const adapterName = safeSegment('adapter', options.adapter);
  const connectionId = safeSegment('connection id', options.connectionId);
  assertConfigured(options.project, adapterName, connectionId);
  const adapter = findAdapter(options.adapters, adapterName);
  const pullConfig = options.sourceDir
    ? undefined
    : await localPullConfigForAdapter(options.project, adapter, connectionId, options.pullConfigOptions);
  const runtime = createLocalBundleIngestRuntime(options);
  const jobId = options.jobId ?? runtime.nextJobId();

  const bundleRef = options.sourceDir
    ? { kind: 'upload' as const, uploadId: jobId }
    : { kind: 'scheduled_pull' as const, config: pullConfig };

  if (options.sourceDir) {
    await copySourceDirToUpload(options.sourceDir, runtime.storage.resolveUploadDir(jobId));
  } else {
    return runScheduledPullJob({
      project: options.project,
      adapters: options.adapters,
      adapter,
      connectionId,
      pullConfig,
      trigger: options.trigger,
      jobId,
      memoryFlow: options.memoryFlow,
      agentRunner: options.agentRunner,
      llmRuntime: options.llmRuntime,
      memoryModel: options.memoryModel,
      semanticLayerCompute: options.semanticLayerCompute,
      queryExecutor: options.queryExecutor,
      sqlAnalysis: options.sqlAnalysis,
      logger: options.logger,
      embeddingProvider: options.embeddingProvider,
      abortSignal: options.abortSignal,
    });
  }

  const result = await runtime.runner.run(
    {
      jobId,
      connectionId,
      sourceKey: adapter.source,
      trigger: options.trigger ?? (options.sourceDir ? 'upload' : 'manual_resync'),
      bundleRef,
    },
    localJobContext(jobId, options.memoryFlow, options.abortSignal),
  );
  const report = await runtime.store.findByJobId(jobId);
  if (!report) {
    throw new Error(`Local ingest report for job "${jobId}" was not created`);
  }
  return { result, report };
}

function metabaseFanoutStatus(children: LocalMetabaseFanoutChild[]): LocalMetabaseFanoutResult['status'] {
  const outcomes = children.map((child) => ingestReportOutcome(child.report));
  if (outcomes.every((outcome) => outcome === 'done')) {
    return 'all_succeeded';
  }
  if (outcomes.every((outcome) => outcome === 'error')) {
    return 'all_failed';
  }
  return 'partial_failure';
}

function metabaseFanoutTotals(children: LocalMetabaseFanoutChild[]): LocalMetabaseFanoutResult['totals'] {
  return {
    workUnits: children.reduce((sum, child) => sum + child.report.body.workUnits.length, 0),
    failedWorkUnits: children.reduce((sum, child) => sum + child.report.body.failedWorkUnits.length, 0),
  };
}

const METABASE_FETCH_FAILURE_UNIT = 'metabase-fetch';

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function metabaseChildJobId(metabaseDatabaseId: number): string {
  return `local-metabase-${metabaseDatabaseId}-${randomUUID()}`;
}

async function recordLocalMetabaseChildFailure(options: {
  project: KtxLocalProject;
  jobId: string;
  targetConnectionId: string;
  metabaseDatabaseId: number;
  trigger?: IngestTrigger;
  error: unknown;
}): Promise<LocalIngestResult> {
  const store = new SqliteBundleIngestStore({ dbPath: ktxLocalStateDbPath(options.project) });
  const syncId = buildSyncId(new Date(), options.jobId);
  const diffSummary = { added: 0, modified: 0, deleted: 0, unchanged: 0 };
  const reason = errorMessage(options.error);
  const run = await store.create({
    jobId: options.jobId,
    connectionId: options.targetConnectionId,
    sourceKey: 'metabase',
    syncId,
    trigger: options.trigger ?? 'manual_resync',
    scopeFingerprint: null,
  });
  await store.markFailed(run.id);

  const body: IngestReportBody = {
    syncId,
    diffSummary,
    commitSha: null,
    workUnits: [
      {
        unitKey: METABASE_FETCH_FAILURE_UNIT,
        rawFiles: [],
        status: 'failed',
        reason,
        actions: [],
        touchedSlSources: [],
      },
    ],
    failedWorkUnits: [METABASE_FETCH_FAILURE_UNIT],
    reconciliationSkipped: true,
    conflictsResolved: [],
    evictionsApplied: [],
    unmappedFallbacks: [],
    artifactResolutions: [],
    evictionInputs: [],
    unresolvedCards: [],
    supersededBy: null,
    overrideOf: null,
    provenanceRows: [],
    toolTranscripts: [],
  };

  const report = await store.create({
    runId: run.id,
    jobId: options.jobId,
    connectionId: options.targetConnectionId,
    sourceKey: 'metabase',
    body,
  });

  return {
    result: {
      jobId: options.jobId,
      runId: run.id,
      syncId,
      diffSummary,
      workUnitCount: 1,
      failedWorkUnits: [METABASE_FETCH_FAILURE_UNIT],
      artifactsWritten: 0,
      commitSha: null,
    },
    report,
  };
}

export async function runLocalMetabaseIngest(
  options: RunLocalMetabaseIngestOptions,
): Promise<LocalMetabaseFanoutResult> {
  if ((options as RunLocalMetabaseIngestOptions & { sourceDir?: string }).sourceDir) {
    throw new Error('source-dir uploads are not supported for the Metabase fanout adapter');
  }

  const metabaseConnectionId = safeSegment('metabase connection id', options.metabaseConnectionId);
  assertConfigured(options.project, 'metabase', metabaseConnectionId);
  const adapter = findAdapter(options.adapters, 'metabase');
  const sourceStateReader = new KtxYamlMetabaseSourceStateReader(options.project, {
    discoveryCache: new LocalMetabaseDiscoveryCache({ dbPath: ktxLocalStateDbPath(options.project) }),
  });

  const state = await sourceStateReader.getSourceState(metabaseConnectionId);
  const childPlans = planMetabaseFanoutChildren({
    metabaseConnectionId,
    mappings: state.mappings,
  });
  options.progress?.onMetabaseFanoutPlanned?.({
    metabaseConnectionId,
    children: childPlans.map((childPlan) => ({
      metabaseDatabaseId: childPlan.metabaseDatabaseId,
      targetConnectionId: childPlan.targetConnectionId,
    })),
  });

  const children: LocalMetabaseFanoutChild[] = [];
  for (const childPlan of childPlans) {
    if (options.abortSignal?.aborted) {
      throw createAbortError();
    }
    const targetConnectionId = safeSegment('target connection id', childPlan.targetConnectionId);
    if (!options.project.config.connections[targetConnectionId]) {
      throw new Error(`Target connection "${targetConnectionId}" is not configured in ktx.yaml`);
    }
    const childJobId = options.jobIdFactory?.() ?? metabaseChildJobId(childPlan.metabaseDatabaseId);
    options.progress?.onMetabaseChildStarted?.({
      metabaseConnectionId,
      metabaseDatabaseId: childPlan.metabaseDatabaseId,
      targetConnectionId,
      jobId: childJobId,
    });
    let child: LocalIngestResult;
    try {
      child = await runScheduledPullJob({
        project: options.project,
        adapters: options.adapters,
        adapter,
        connectionId: targetConnectionId,
        pullConfig: childPlan.pullConfig,
        trigger: options.trigger,
        jobId: childJobId,
        memoryFlow: options.memoryFlow,
        agentRunner: options.agentRunner,
        llmRuntime: options.llmRuntime,
        memoryModel: options.memoryModel,
        semanticLayerCompute: options.semanticLayerCompute,
        queryExecutor: options.queryExecutor,
        sqlAnalysis: options.sqlAnalysis,
        logger: options.logger,
        embeddingProvider: options.embeddingProvider,
        abortSignal: options.abortSignal,
      });
    } catch (error) {
      if (isAbortError(error)) {
        throw error;
      }
      child = await recordLocalMetabaseChildFailure({
        project: options.project,
        jobId: childJobId,
        targetConnectionId,
        metabaseDatabaseId: childPlan.metabaseDatabaseId,
        trigger: options.trigger,
        error,
      });
    }
    const childOutcome = ingestReportOutcome(child.report);
    options.progress?.onMetabaseChildCompleted?.({
      metabaseConnectionId,
      metabaseDatabaseId: childPlan.metabaseDatabaseId,
      targetConnectionId,
      jobId: child.report.jobId,
      status: childOutcome === 'error' ? 'failed' : childOutcome,
    });
    children.push({
      jobId: child.report.jobId,
      metabaseConnectionId,
      metabaseDatabaseId: childPlan.metabaseDatabaseId,
      targetConnectionId,
      result: child.result,
      report: child.report,
    });
  }

  return {
    metabaseConnectionId,
    children,
    status: metabaseFanoutStatus(children),
    totals: metabaseFanoutTotals(children),
  };
}

export async function getLocalIngestStatus(
  project: KtxLocalProject,
  id: string,
): Promise<IngestReportSnapshot | null> {
  return new SqliteBundleIngestStore({ dbPath: ktxLocalStateDbPath(project) }).findReportByAnyId(id);
}

export async function getLatestLocalIngestStatus(project: KtxLocalProject): Promise<IngestReportSnapshot | null> {
  return new SqliteBundleIngestStore({ dbPath: ktxLocalStateDbPath(project) }).findLatestReport();
}
