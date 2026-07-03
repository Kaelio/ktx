import { readFile } from 'node:fs/promises';
import type { GitService } from '../../../context/core/git.service.js';
import type { RepairVerification } from '../constrained-repair.js';
import type { IngestTraceWriter } from '../ingest-trace.js';
import { traceTimed } from '../ingest-trace.js';
import { assertPatchAllowedForWorkUnit, parsePatchTouchedPaths } from './git-patch.js';
import type { TextualConflictResolutionResult } from './textual-conflict-resolver.js';

export type PatchIntegrationResult =
  | {
      status: 'accepted';
      commitSha: string;
      touchedPaths: string[];
      textualResolution?: TextualConflictResolutionResult;
    }
  | {
      status: 'textual_conflict';
      reason: string;
      touchedPaths: string[];
      textualResolution?: TextualConflictResolutionResult;
    }
  | {
      status: 'semantic_conflict';
      reason: string;
      touchedPaths: string[];
      textualResolution?: TextualConflictResolutionResult;
    };

export interface IntegrateWorkUnitPatchInput {
  unitKey: string;
  patchPath: string;
  integrationGit: GitService;
  trace: IngestTraceWriter;
  author: { name: string; email: string };
  slDisallowed: boolean;
  allowedTargetConnectionIds: ReadonlySet<string>;
  validateAppliedTree(touchedPaths: string[]): Promise<void>;
  resolveTextualConflict?(input: {
    unitKey: string;
    patchPath: string;
    touchedPaths: string[];
    reason: string;
    verify(changedPaths: string[]): Promise<RepairVerification>;
  }): Promise<TextualConflictResolutionResult>;
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

export async function integrateWorkUnitPatch(input: IntegrateWorkUnitPatchInput): Promise<PatchIntegrationResult> {
  const preApplyHead = await input.integrationGit.revParseHead();
  const patch = await readFile(input.patchPath, 'utf-8');
  const touchedPaths = parsePatchTouchedPaths(patch).map((entry) => entry.path);
  if (touchedPaths.length === 0) {
    await input.trace.event('debug', 'integration', 'patch_noop_accepted', {
      unitKey: input.unitKey,
      patchPath: input.patchPath,
      patchBytes: Buffer.byteLength(patch),
    });
    return { status: 'accepted', commitSha: preApplyHead ?? '', touchedPaths };
  }
  try {
    assertPatchAllowedForWorkUnit({
      unitKey: input.unitKey,
      patch,
      slDisallowed: input.slDisallowed,
      allowedTargetConnectionIds: input.allowedTargetConnectionIds,
    });
  } catch (error) {
    await input.trace.event('error', 'integration', 'patch_policy_rejected', {
      unitKey: input.unitKey,
      patchPath: input.patchPath,
      touchedPaths,
      allowedTargetConnectionIds: [...input.allowedTargetConnectionIds].sort(),
      reason: errorMessage(error),
    });
    return {
      status: 'textual_conflict',
      reason: errorMessage(error),
      touchedPaths,
    };
  }

  // Repair and resolution success is decided by this check, not by whether
  // the repair agent edited files: the gates re-run over the union of the
  // patch's paths and everything the agent changed.
  const verifyAppliedTree = async (changedPaths: string[]): Promise<RepairVerification> => {
    const paths = [...new Set([...touchedPaths, ...changedPaths])].sort();
    try {
      await input.validateAppliedTree(paths);
      return { ok: true };
    } catch (error) {
      return { ok: false, reason: errorMessage(error) };
    }
  };

  try {
    await traceTimed(
      input.trace,
      'integration',
      'patch_apply',
      { unitKey: input.unitKey, patchPath: input.patchPath, touchedPaths },
      async () => {
        await input.integrationGit.applyPatchFile3WayIndex(input.patchPath);
        await input.integrationGit.assertWorktreeClean();
      },
    );
  } catch (error) {
    if (preApplyHead) {
      await input.integrationGit.resetHardTo(preApplyHead);
    }
    const reason = errorMessage(error);
    await input.trace.event('error', 'integration', 'patch_textual_conflict', {
      unitKey: input.unitKey,
      patchPath: input.patchPath,
      touchedPaths,
      reason,
    });

    if (!input.resolveTextualConflict) {
      return {
        status: 'textual_conflict',
        reason,
        touchedPaths,
      };
    }

    const textualResolution = await input.resolveTextualConflict({
      unitKey: input.unitKey,
      patchPath: input.patchPath,
      touchedPaths,
      reason,
      verify: verifyAppliedTree,
    });

    if (textualResolution.status === 'failed') {
      if (preApplyHead) {
        await input.integrationGit.resetHardTo(preApplyHead);
      }
      return {
        status: 'textual_conflict',
        reason: textualResolution.reason,
        touchedPaths,
        textualResolution,
      };
    }

    if (textualResolution.changedPaths.length === 0) {
      // The resolver declared the patch redundant and the gates verified the
      // current tree: the integration worktree already represents this work
      // unit's content (e.g. a duplicate page created by another work unit).
      await input.trace.event('debug', 'integration', 'patch_subsumed_after_textual_resolution', {
        unitKey: input.unitKey,
        patchPath: input.patchPath,
        touchedPaths,
        attempts: textualResolution.attempts,
      });
      return {
        status: 'accepted',
        commitSha: preApplyHead ?? '',
        touchedPaths: [],
        textualResolution,
      };
    }

    const commit = await input.integrationGit.commitFiles(
      textualResolution.changedPaths,
      `ingest: resolve WorkUnit ${input.unitKey} conflict`,
      input.author.name,
      input.author.email,
    );
    if (!commit.created) {
      // The resolver's writes left the tree byte-identical to the accepted
      // state, and the gates verified it — the patch is represented already.
      await input.trace.event('debug', 'integration', 'patch_subsumed_after_textual_resolution', {
        unitKey: input.unitKey,
        patchPath: input.patchPath,
        touchedPaths: textualResolution.changedPaths,
        attempts: textualResolution.attempts,
      });
      return {
        status: 'accepted',
        commitSha: preApplyHead ?? '',
        touchedPaths: [],
        textualResolution,
      };
    }

    await input.trace.event('debug', 'integration', 'patch_accepted_after_textual_resolution', {
      unitKey: input.unitKey,
      commitSha: commit.commitHash,
      touchedPaths: textualResolution.changedPaths,
      attempts: textualResolution.attempts,
    });
    return {
      status: 'accepted',
      commitSha: commit.commitHash,
      touchedPaths: textualResolution.changedPaths,
      textualResolution,
    };
  }

  try {
    await traceTimed(input.trace, 'integration', 'semantic_gate', { unitKey: input.unitKey, touchedPaths }, async () => {
      await input.validateAppliedTree(touchedPaths);
    });
  } catch (error) {
    const reason = errorMessage(error);
    await input.trace.event('error', 'integration', 'patch_semantic_conflict', {
      unitKey: input.unitKey,
      patchPath: input.patchPath,
      touchedPaths,
      reason,
    });

    if (preApplyHead) {
      await input.integrationGit.resetHardTo(preApplyHead);
    }
    return {
      status: 'semantic_conflict',
      reason,
      touchedPaths,
    };
  }

  const commit = await input.integrationGit.commitStaged(
    `ingest: accept WorkUnit ${input.unitKey}`,
    input.author.name,
    input.author.email,
  );
  await input.trace.event('debug', 'integration', 'patch_accepted', {
    unitKey: input.unitKey,
    commitSha: commit.commitHash,
    touchedPaths,
  });
  return { status: 'accepted', commitSha: commit.commitHash, touchedPaths };
}
