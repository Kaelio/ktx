import { mkdir, readFile } from 'node:fs/promises';
import { join } from 'node:path';
import type { SessionOutcome } from '../../../context/core/session-worktree.service.js';
import type { IngestSessionWorktree, IngestSessionWorktreePort } from '../ports.js';
import type { WorkUnit } from '../types.js';
import type { IngestTraceWriter } from '../ingest-trace.js';
import type { WorkUnitOutcome } from '../stages/stage-3-work-units.js';
import { captureIngestWorkUnitCachedArtifactFiles } from '../work-unit-cache.js';
import { parsePatchTouchedPaths } from './git-patch.js';

export interface RunIsolatedWorkUnitInput {
  unitIndex: number;
  ingestionBaseSha: string;
  sessionWorktreeService: IngestSessionWorktreePort;
  patchDir: string;
  trace: IngestTraceWriter;
  workUnit: WorkUnit;
  abortSignal?: AbortSignal;
  run(child: IngestSessionWorktree): Promise<WorkUnitOutcome>;
  afterSuccess?(child: IngestSessionWorktree): Promise<void>;
}

export function workUnitPatchFileName(unitIndex: number, unitKey: string): string {
  const safeKey = unitKey.replace(/[^a-zA-Z0-9_.-]+/g, '-');
  return `${String(unitIndex).padStart(4, '0')}-${safeKey}.patch`;
}

export async function runIsolatedWorkUnit(input: RunIsolatedWorkUnitInput): Promise<WorkUnitOutcome> {
  const sessionKey = `${input.trace.context.jobId}-${input.workUnit.unitKey}`;
  let cleanupOutcome: SessionOutcome = 'crash';
  const createStartedAt = Date.now();
  const child = await input.sessionWorktreeService.create(sessionKey, input.ingestionBaseSha);
  await input.trace.event(
    'debug',
    'work_unit',
    'work_unit_child_created',
    {
      unitKey: input.workUnit.unitKey,
      unitIndex: input.unitIndex,
      worktreePath: child.workdir,
      baseSha: input.ingestionBaseSha,
    },
    undefined,
    Date.now() - createStartedAt,
  );

  try {
    const runStartedAt = Date.now();
    const outcome = await input.run(child);
    await input.trace.event(
      'debug',
      'work_unit',
      'work_unit_executed',
      {
        unitKey: input.workUnit.unitKey,
        unitIndex: input.unitIndex,
        status: outcome.status,
        ...(outcome.metrics
          ? {
              agentLoopMs: outcome.metrics.totalMs,
              stepCount: outcome.metrics.stepCount,
              ...(outcome.metrics.usage.inputTokens !== undefined
                ? { inputTokens: outcome.metrics.usage.inputTokens }
                : {}),
              ...(outcome.metrics.usage.outputTokens !== undefined
                ? { outputTokens: outcome.metrics.usage.outputTokens }
                : {}),
              ...(outcome.metrics.usage.totalTokens !== undefined
                ? { totalTokens: outcome.metrics.usage.totalTokens }
                : {}),
            }
          : {}),
      },
      undefined,
      Date.now() - runStartedAt,
    );
    if (outcome.status !== 'success') {
      cleanupOutcome = 'success';
      await input.trace.event('error', 'work_unit', 'work_unit_failed_before_patch', {
        unitKey: input.workUnit.unitKey,
        reason: outcome.reason ?? 'unknown failure',
      });
      return { ...outcome, childWorktreePath: child.workdir };
    }

    await input.afterSuccess?.(child);
    await mkdir(input.patchDir, { recursive: true });
    const patchPath = join(input.patchDir, workUnitPatchFileName(input.unitIndex, input.workUnit.unitKey));
    await child.git.writeBinaryNoRenamePatch(input.ingestionBaseSha, 'HEAD', patchPath);
    const patch = await readFile(patchPath, 'utf-8');
    const touched = parsePatchTouchedPaths(patch);
    const patchTouchedPaths = touched.map((entry) => entry.path);
    const artifactFiles = await captureIngestWorkUnitCachedArtifactFiles({
      git: child.git,
      workdir: child.workdir,
      baseSha: input.ingestionBaseSha,
      patchTouchedPaths,
    });
    cleanupOutcome = 'success';
    await input.trace.event('debug', 'work_unit', 'work_unit_patch_collected', {
      unitKey: input.workUnit.unitKey,
      patchPath,
      touchedPaths: patchTouchedPaths,
      patchBytes: Buffer.byteLength(patch),
    });
    return {
      ...outcome,
      patchPath,
      patchTouchedPaths,
      artifactFiles,
      childWorktreePath: child.workdir,
    };
  } catch (error) {
    await input.trace.event(
      'error',
      'work_unit',
      'work_unit_child_failed',
      { unitKey: input.workUnit.unitKey, worktreePath: child.workdir },
      error,
    );
    cleanupOutcome = 'success';
    throw error;
  } finally {
    const cleanupStartedAt = Date.now();
    await input.sessionWorktreeService.cleanup(child, cleanupOutcome);
    await input.trace.event(
      'trace',
      'work_unit',
      'work_unit_child_cleanup',
      {
        unitKey: input.workUnit.unitKey,
        outcome: cleanupOutcome,
        worktreePath: child.workdir,
      },
      undefined,
      Date.now() - cleanupStartedAt,
    );
  }
}
