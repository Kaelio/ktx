import { type ChildProcess } from 'node:child_process';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { z } from 'zod';
import { isAbortError } from '../../../src/context/core/abort.js';
import {
  KtxSubprocessDeadlineError,
  runGenerateObjectInSubprocess,
} from '../../../src/context/llm/subprocess-generate-object.js';
import type { SubprocessRuntimeForkSpec } from '../../../src/context/llm/runtime-port.js';
import { HANGING_CHILD, killTestChildren, RESPONDING_CHILD, spawnTestChild } from './subprocess-test-children.test-utils.js';

const FORK_SPEC: SubprocessRuntimeForkSpec = { backend: 'codex', projectDir: '/tmp', modelSlots: { default: 'codex' } };

function isAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

describe('runGenerateObjectInSubprocess', () => {
  let children: ChildProcess[];
  let workDir: string;

  function forkFake(code: string, env: Record<string, string> = {}): () => ChildProcess {
    return () => spawnTestChild(children, code, env);
  }

  beforeEach(() => {
    children = [];
    workDir = mkdtempSync(join(tmpdir(), 'ktx-subproc-'));
  });

  afterEach(() => {
    killTestChildren(children);
    rmSync(workDir, { recursive: true, force: true });
  });

  it('tree-kills a wedged child at the deadline and reaps its grandchild', async () => {
    const pidFile = join(workDir, 'gc.pid');
    const start = Date.now();
    const pending = runGenerateObjectInSubprocess({
      forkSpec: FORK_SPEC,
      role: 'candidateExtraction',
      prompt: 'x',
      schema: z.object({ answer: z.string() }),
      jsonSchema: { type: 'object' },
      deadlineMs: 300,
      spawnChild: forkFake(HANGING_CHILD, { KTX_TEST_GC_PID_FILE: pidFile }),
    });

    await expect(pending).rejects.toBeInstanceOf(KtxSubprocessDeadlineError);
    // Settled within the deadline plus a small grace, not left wedged.
    expect(Date.now() - start).toBeLessThan(3000);

    const child = children[0]!;
    await vi.waitFor(() => expect(child.exitCode !== null || child.signalCode !== null).toBe(true), { timeout: 5000 });
    expect(child.signalCode).toBe('SIGKILL');

    const grandchildPid = Number(readFileSync(pidFile, 'utf8'));
    expect(Number.isInteger(grandchildPid)).toBe(true);
    await vi.waitFor(() => expect(isAlive(grandchildPid)).toBe(false), { timeout: 5000 });
  });

  it('tree-kills the same way on an external abort', async () => {
    const pidFile = join(workDir, 'gc.pid');
    const controller = new AbortController();
    const pending = runGenerateObjectInSubprocess({
      forkSpec: FORK_SPEC,
      role: 'candidateExtraction',
      prompt: 'x',
      schema: z.object({ answer: z.string() }),
      jsonSchema: { type: 'object' },
      deadlineMs: 60_000,
      signal: controller.signal,
      spawnChild: forkFake(HANGING_CHILD, { KTX_TEST_GC_PID_FILE: pidFile }),
    });
    void pending.catch(() => undefined);

    await vi.waitFor(() => expect(() => readFileSync(pidFile, 'utf8')).not.toThrow(), { timeout: 5000 });
    controller.abort();

    await expect(pending).rejects.toSatisfy(isAbortError);
    const child = children[0]!;
    await vi.waitFor(() => expect(child.exitCode !== null || child.signalCode !== null).toBe(true), { timeout: 5000 });
    const grandchildPid = Number(readFileSync(pidFile, 'utf8'));
    await vi.waitFor(() => expect(isAlive(grandchildPid)).toBe(false), { timeout: 5000 });
  });

  it('resolves with the schema-validated output on success', async () => {
    await expect(
      runGenerateObjectInSubprocess({
        forkSpec: FORK_SPEC,
        role: 'candidateExtraction',
        prompt: 'x',
        schema: z.object({ answer: z.string() }),
        jsonSchema: { type: 'object' },
        deadlineMs: 5_000,
        spawnChild: forkFake(RESPONDING_CHILD),
      }),
    ).resolves.toEqual({ answer: 'yes' });
  });

  it('rejects when the child output fails schema validation', async () => {
    await expect(
      runGenerateObjectInSubprocess({
        forkSpec: FORK_SPEC,
        role: 'candidateExtraction',
        prompt: 'x',
        schema: z.object({ answer: z.string() }),
        jsonSchema: { type: 'object' },
        deadlineMs: 5_000,
        spawnChild: forkFake(RESPONDING_CHILD, { KTX_TEST_RESPONSE: '{"ok":true,"output":{"wrong":1}}' }),
      }),
    ).rejects.toThrow();
  });

  it('rejects with the child error message when the child reports failure', async () => {
    await expect(
      runGenerateObjectInSubprocess({
        forkSpec: FORK_SPEC,
        role: 'candidateExtraction',
        prompt: 'x',
        schema: z.object({ answer: z.string() }),
        jsonSchema: { type: 'object' },
        deadlineMs: 5_000,
        spawnChild: forkFake(RESPONDING_CHILD, {
          KTX_TEST_RESPONSE: '{"ok":false,"message":"backend overloaded"}',
        }),
      }),
    ).rejects.toThrow('backend overloaded');
  });
});
