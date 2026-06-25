import type { KtxModelRole } from '../../../llm/types.js';
import { isAbortError } from '../../core/abort.js';
import type { AgentRunnerPort, KtxRuntimeToolSet, RunLoopMetrics } from '../../../context/llm/runtime-port.js';
import type { CaptureSession, MemoryAction } from '../../../context/memory/types.js';
import { listTouchedSlSources, type TouchedSlSource } from '../../../context/tools/touched-sl-sources.js';
import {
  formatInvalidWuSources,
  hasBlockingWuSourceIssue,
  type WuValidationResult,
} from './validate-wu-sources.js';
import type { IngestWorkUnitCachedArtifactFile } from '../work-unit-cache.js';
import type { WorkUnit } from '../types.js';

const MAX_WORK_UNIT_PROMPT_CHARS = 240_000;

export interface WorkUnitExecutionDeps {
  sessionWorktreeGit: { revParseHead(): Promise<string | null> };
  agentRunner: AgentRunnerPort;
  validateTouchedSources: (touched: TouchedSlSource[]) => Promise<WuValidationResult>;
  resetHardTo: (targetSha: string) => Promise<void>;
  buildSystemPrompt: (wu: WorkUnit) => string;
  buildUserPrompt: (wu: WorkUnit) => string;
  buildToolSet: (wu: WorkUnit) => KtxRuntimeToolSet;
  captureSession: CaptureSession;
  sessionActions: MemoryAction[];
  modelRole: KtxModelRole;
  stepBudget: number;
  sourceKey: string;
  connectionId: string;
  jobId: string;
  abortSignal?: AbortSignal;
  toolFailureCount?: (unitKey: string) => number;
}

export interface WorkUnitOutcome {
  unitKey: string;
  status: 'success' | 'failed';
  reason?: string;
  preSha: string;
  postSha: string;
  actions: MemoryAction[];
  touchedSlSources: TouchedSlSource[];
  slDisallowed?: boolean;
  slDisallowedReason?: 'lookml_connection_mismatch';
  patchPath?: string;
  patchTouchedPaths?: string[];
  artifactFiles?: IngestWorkUnitCachedArtifactFile[];
  childWorktreePath?: string;
  /** Timing and token metrics for the work-unit agent loop, used for ingest profiling. */
  metrics?: RunLoopMetrics;
}

export async function executeWorkUnit(deps: WorkUnitExecutionDeps, wu: WorkUnit): Promise<WorkUnitOutcome> {
  const preSha = (await deps.sessionWorktreeGit.revParseHead()) ?? '';
  deps.captureSession.preHead = preSha || null;

  const failWithoutReset = (reason: string): WorkUnitOutcome => ({
    unitKey: wu.unitKey,
    status: 'failed',
    reason,
    preSha,
    postSha: preSha,
    actions: [],
    touchedSlSources: [],
    slDisallowed: wu.slDisallowed,
    slDisallowedReason: wu.slDisallowedReason,
  });

  const systemPrompt = deps.buildSystemPrompt(wu);
  const userPrompt = deps.buildUserPrompt(wu);
  const promptChars = systemPrompt.length + userPrompt.length;
  if (promptChars > MAX_WORK_UNIT_PROMPT_CHARS) {
    return failWithoutReset(
      `prompt too large for WorkUnit ${wu.unitKey}: ${promptChars} chars exceeds ${MAX_WORK_UNIT_PROMPT_CHARS}`,
    );
  }

  const failWithResetFromCurrentHead = async (reason: string): Promise<WorkUnitOutcome> => {
    const failureHead = (await deps.sessionWorktreeGit.revParseHead()) ?? preSha;
    if (failureHead !== preSha && preSha !== '') {
      await deps.resetHardTo(preSha);
    }
    return {
      unitKey: wu.unitKey,
      status: 'failed',
      reason,
      preSha,
      postSha: failureHead,
      actions: [],
      touchedSlSources: [],
      slDisallowed: wu.slDisallowed,
      slDisallowedReason: wu.slDisallowedReason,
    };
  };

  let runResult: Awaited<ReturnType<typeof deps.agentRunner.runLoop>>;
  try {
    runResult = await deps.agentRunner.runLoop({
      modelRole: deps.modelRole,
      systemPrompt,
      userPrompt,
      toolSet: deps.buildToolSet(wu),
      stepBudget: deps.stepBudget,
      telemetryTags: {
        operationName: 'ingest-bundle-wu',
        source: deps.sourceKey,
        unitKey: wu.unitKey,
        jobId: deps.jobId,
      },
      abortSignal: deps.abortSignal,
    });
  } catch (error) {
    if (isAbortError(error)) {
      throw error;
    }
    return failWithResetFromCurrentHead(error instanceof Error ? error.message : String(error));
  }

  const postSha = (await deps.sessionWorktreeGit.revParseHead()) ?? preSha;

  const failWithReset = async (reason: string): Promise<WorkUnitOutcome> => {
    if (postSha !== preSha && preSha !== '') {
      await deps.resetHardTo(preSha);
    }
    return {
      unitKey: wu.unitKey,
      status: 'failed',
      reason,
      preSha,
      postSha,
      actions: [],
      touchedSlSources: [],
      slDisallowed: wu.slDisallowed,
      slDisallowedReason: wu.slDisallowedReason,
      ...(runResult.metrics ? { metrics: runResult.metrics } : {}),
    };
  };

  if (runResult.stopReason === 'error') {
    return failWithReset(runResult.error?.message ?? 'agent loop errored');
  }

  const toolFailureCount = deps.toolFailureCount?.(wu.unitKey) ?? 0;
  if (toolFailureCount > 0) {
    return failWithReset(`${toolFailureCount} tool call(s) failed during WorkUnit ${wu.unitKey}`);
  }

  const touched = listTouchedSlSources(deps.captureSession.touchedSlSources);
  if (touched.length > 0) {
    const validation = await deps.validateTouchedSources(touched);
    const blockingInvalidSources = validation.invalidSources.filter(hasBlockingWuSourceIssue);
    if (blockingInvalidSources.length > 0) {
      return failWithReset(`sl_validate failed for: ${formatInvalidWuSources(blockingInvalidSources)}`);
    }
  }

  return {
    unitKey: wu.unitKey,
    status: 'success',
    preSha,
    postSha,
    actions: [...deps.sessionActions],
    touchedSlSources: touched,
    slDisallowed: wu.slDisallowed,
    slDisallowedReason: wu.slDisallowedReason,
    ...(runResult.metrics ? { metrics: runResult.metrics } : {}),
  };
}
