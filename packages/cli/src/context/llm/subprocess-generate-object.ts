import { fork, spawn, type ChildProcess } from 'node:child_process';
import { existsSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import type { z } from 'zod';
import type { KtxModelRole } from '../../llm/types.js';
import { createAbortError } from '../core/abort.js';
import type { SubprocessRuntimeForkSpec } from './runtime-port.js';

export interface SubprocessGenerateObjectRequest {
  forkSpec: SubprocessRuntimeForkSpec;
  role: KtxModelRole;
  prompt: string;
  system?: string;
  jsonSchema: Record<string, unknown>;
}

export type SubprocessGenerateObjectResponse = { ok: true; output: unknown } | { ok: false; message: string };

// In dist, this file and the child are siblings; under vitest the compiled .js is
// absent and Node strips types from the .ts. The real child imports the codex /
// claude SDKs (which use constructor parameter properties), so it only runs as
// built .js — tests inject a fake child via the spawnChild seam.
function childUrl(): URL {
  const builtChild = new URL('./subprocess-generate-object-child.js', import.meta.url);
  return existsSync(fileURLToPath(builtChild)) ? builtChild : new URL('./subprocess-generate-object-child.ts', import.meta.url);
}

function forkSubprocessGenerateObjectChild(): ChildProcess {
  // detached: the child becomes a process-group leader so the SDK's grandchild
  // (the codex/claude binary) inherits its group and a negative-pid SIGKILL reaps
  // the whole tree. Empty execArgv keeps it a clean Node process.
  return fork(childUrl(), {
    execArgv: [],
    serialization: 'advanced',
    detached: true,
    stdio: ['ignore', 'ignore', 'inherit', 'ipc'],
  });
}

/** A per-table enrichment subprocess that did not return before its deadline. */
export class KtxSubprocessDeadlineError extends Error {
  constructor(public readonly deadlineMs: number) {
    super(`enrichment subprocess exceeded ${Math.round(deadlineMs / 1000)}s`);
    this.name = 'KtxSubprocessDeadlineError';
  }
}

// SIGTERM is too gentle for a child wedged on a hung provider socket; the SDK
// grandchild ignores it and survives. Kill the whole tree: the detached process
// group on POSIX, the process tree via taskkill /T on Windows.
function killProcessTree(child: ChildProcess): void {
  if (child.pid === undefined) {
    return;
  }
  if (process.platform === 'win32') {
    spawn('taskkill', ['/pid', String(child.pid), '/T', '/F'], { stdio: 'ignore' }).on('error', () => undefined);
    return;
  }
  try {
    process.kill(-child.pid, 'SIGKILL');
  } catch {
    try {
      child.kill('SIGKILL');
    } catch {
      // Already exited.
    }
  }
}

export interface RunGenerateObjectInSubprocessInput<TOutput, TSchema extends z.ZodType<TOutput>> {
  forkSpec: SubprocessRuntimeForkSpec;
  role: KtxModelRole;
  prompt: string;
  system?: string;
  schema: TSchema;
  jsonSchema: Record<string, unknown>;
  deadlineMs: number;
  signal?: AbortSignal;
  /** @internal Test seam: spawn the child so tests can observe its lifecycle. */
  spawnChild?: () => ChildProcess;
}

/**
 * Run one structured LLM call for a subprocess-backed runtime behind a boundary
 * ktx can hard-kill. On the deadline or an external abort, the whole process
 * group/tree is SIGKILLed (reaping the SDK's wedged model child) and the promise
 * settles promptly; on success the raw output is validated against the Zod schema.
 */
export function runGenerateObjectInSubprocess<TOutput, TSchema extends z.ZodType<TOutput>>(
  input: RunGenerateObjectInSubprocessInput<TOutput, TSchema>,
): Promise<TOutput> {
  return new Promise<TOutput>((resolvePromise, rejectPromise) => {
    const child = (input.spawnChild ?? forkSubprocessGenerateObjectChild)();
    let settled = false;
    const onDeadline = () => settle(() => rejectPromise(new KtxSubprocessDeadlineError(input.deadlineMs)));
    const onAbort = () => settle(() => rejectPromise(createAbortError()));
    const timer = setTimeout(onDeadline, input.deadlineMs);
    function settle(finish: () => void): void {
      if (settled) {
        return;
      }
      settled = true;
      clearTimeout(timer);
      input.signal?.removeEventListener('abort', onAbort);
      if (child.exitCode === null && child.signalCode === null) {
        killProcessTree(child);
      }
      finish();
    }
    child.on('message', (message: SubprocessGenerateObjectResponse) => {
      if (message.ok) {
        let parsed: TOutput;
        try {
          parsed = input.schema.parse(message.output);
        } catch (error) {
          settle(() => rejectPromise(error instanceof Error ? error : new Error(String(error))));
          return;
        }
        settle(() => resolvePromise(parsed));
      } else {
        settle(() => rejectPromise(new Error(message.message)));
      }
    });
    child.on('error', (error) => settle(() => rejectPromise(error)));
    child.on('exit', (code, processSignal) => {
      if (!settled) {
        settle(() =>
          rejectPromise(
            new Error(`enrichment subprocess exited before returning a result (code ${code}, signal ${processSignal}).`),
          ),
        );
      }
    });
    if (input.signal?.aborted) {
      onAbort();
      return;
    }
    input.signal?.addEventListener('abort', onAbort, { once: true });
    try {
      const request: SubprocessGenerateObjectRequest = {
        forkSpec: input.forkSpec,
        role: input.role,
        prompt: input.prompt,
        ...(input.system !== undefined ? { system: input.system } : {}),
        jsonSchema: input.jsonSchema,
      };
      child.send(request);
    } catch (error) {
      settle(() => rejectPromise(error instanceof Error ? error : new Error(String(error))));
    }
  });
}
