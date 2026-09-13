import { describe, expect, it, vi } from 'vitest';
import {
  ensureManagedLocalEmbeddingsDaemon,
  managedLocalEmbeddingHealthConfig,
  tryUseManagedLocalEmbeddingsDaemon,
} from '../src/managed-local-embeddings.js';
import type { ManagedPythonCommandRuntime } from '../src/managed-python-command.js';
import type { ManagedPythonDaemonStartResult } from '../src/managed-python-daemon.js';
import type { ManagedPythonDaemonLayout } from '../src/managed-python-runtime.js';

function makeIo(stdoutIsTty = false) {
  let stdout = '';
  let stderr = '';
  return {
    io: {
      stdout: {
        isTTY: stdoutIsTty,
        write: (chunk: string) => {
          stdout += chunk;
        },
      },
      stderr: {
        write: (chunk: string) => {
          stderr += chunk;
        },
      },
    },
    stdout: () => stdout,
    stderr: () => stderr,
  };
}

function runtime(): ManagedPythonCommandRuntime {
  return {
    layout: {
      cliVersion: '0.2.0',
      runtimeRoot: '/runtime',
      versionDir: '/runtime/0.2.0',
      venvDir: '/runtime/0.2.0/.venv',
      manifestPath: '/runtime/0.2.0/manifest.json',
      installLogPath: '/runtime/0.2.0/install.log',
      assetDir: '/assets/python',
      assetManifestPath: '/assets/python/manifest.json',
      pythonPath: '/runtime/0.2.0/.venv/bin/python',
      daemonPath: '/runtime/0.2.0/.venv/bin/ktx-daemon',
    },
    manifest: {
      schemaVersion: 1,
      cliVersion: '0.2.0',
      installedAt: '2026-05-11T00:00:00.000Z',
      asset: {
        schemaVersion: 1,
        distributionName: 'kaelio-ktx',
        normalizedName: 'kaelio_ktx',
        version: '0.2.0',
        wheel: {
          file: 'kaelio_ktx-0.2.0-py3-none-any.whl',
          sha256: 'a'.repeat(64),
          bytes: 123,
        },
      },
      features: ['core', 'local-embeddings'],
      python: {
        executable: '/runtime/0.2.0/.venv/bin/python',
        daemonExecutable: '/runtime/0.2.0/.venv/bin/ktx-daemon',
      },
      installLog: '/runtime/0.2.0/install.log',
    },
  };
}

function daemonResult(status: 'started' | 'reused' = 'reused'): ManagedPythonDaemonStartResult {
  return {
    status,
    layout: {
      ...runtime().layout,
      projectDir: '/work/proj',
      daemonStateDir: '/work/proj/.ktx/runtime',
      daemonStatePath: '/work/proj/.ktx/runtime/daemon.json',
      daemonStdoutPath: '/work/proj/.ktx/runtime/daemon.stdout.log',
      daemonStderrPath: '/work/proj/.ktx/runtime/daemon.stderr.log',
    },
    baseUrl: 'http://127.0.0.1:61234',
    state: {
      schemaVersion: 1,
      pid: 12345,
      host: '127.0.0.1',
      port: 61234,
      version: '0.2.0',
      features: ['core', 'local-embeddings'],
      startedAt: '2026-05-11T00:00:00.000Z',
      stdoutLog: '/work/proj/.ktx/runtime/daemon.stdout.log',
      stderrLog: '/work/proj/.ktx/runtime/daemon.stderr.log',
    },
  };
}

describe('managedLocalEmbeddingHealthConfig', () => {
  it('uses the active ktx daemon URL for the immediate health check', () => {
    expect(
      managedLocalEmbeddingHealthConfig({
        baseUrl: 'http://127.0.0.1:61234',
        model: 'all-MiniLM-L6-v2',
        dimensions: 384,
      }),
    ).toEqual({
      backend: 'sentence-transformers',
      model: 'all-MiniLM-L6-v2',
      dimensions: 384,
      sentenceTransformers: { baseURL: 'http://127.0.0.1:61234', pathPrefix: '' },
    });
  });
});

describe('ensureManagedLocalEmbeddingsDaemon', () => {
  it('ensures the local-embeddings feature and starts the ktx daemon', async () => {
    const io = makeIo();
    const ensureRuntime = vi.fn(async () => runtime());
    const startDaemon = vi.fn(async () => daemonResult('started'));

    await expect(
      ensureManagedLocalEmbeddingsDaemon({
        cliVersion: '0.2.0',
        projectDir: '/work/proj',
        installPolicy: 'auto',
        io: io.io,
        ensureRuntime,
        startDaemon,
      }),
    ).resolves.toEqual({
      baseUrl: 'http://127.0.0.1:61234',
      stdoutLog: '/work/proj/.ktx/runtime/daemon.stdout.log',
      stderrLog: '/work/proj/.ktx/runtime/daemon.stderr.log',
    });

    expect(ensureRuntime).toHaveBeenCalledWith({
      cliVersion: '0.2.0',
      installPolicy: 'auto',
      io: io.io,
      feature: 'local-embeddings',
    });
    expect(startDaemon).toHaveBeenCalledWith({
      cliVersion: '0.2.0',
      projectDir: '/work/proj',
      features: ['local-embeddings'],
      force: false,
    });
    expect(io.stderr()).toContain('Started ktx daemon: http://127.0.0.1:61234');
  });

  it('reuses an already running daemon without reporting a new start', async () => {
    const io = makeIo();

    await ensureManagedLocalEmbeddingsDaemon({
      cliVersion: '0.2.0',
      projectDir: '/work/proj',
      installPolicy: 'prompt',
      io: io.io,
      ensureRuntime: vi.fn(async () => runtime()),
      startDaemon: vi.fn(async () => daemonResult('reused')),
    });

    expect(io.stderr()).toContain('Using ktx daemon: http://127.0.0.1:61234');
  });

  it('keeps the spinner static on a TTY so the daemon start cannot leave stdin in raw mode', async () => {
    // Regression test for #361. On a TTY the animated clack spinner takes
    // stdin over through @clack/core's block(), which calls setRawMode(true)
    // and is never undone, killing Ctrl-C for the rest of the ingest. The
    // static spinner writes to stderr only and never touches stdin, so the
    // giveaway is that stdout stays completely empty even when it is a TTY.
    const io = makeIo(true);

    await ensureManagedLocalEmbeddingsDaemon({
      cliVersion: '0.2.0',
      projectDir: '/work/proj',
      installPolicy: 'auto',
      io: io.io,
      ensureRuntime: vi.fn(async () => runtime()),
      startDaemon: vi.fn(async () => daemonResult('started')),
    });

    expect(io.stdout()).toBe('');
    expect(io.stderr()).toContain('Starting ktx embedding daemon');
    expect(io.stderr()).toContain('Started ktx daemon: http://127.0.0.1:61234');
  });

  it('reports the failure through the same static spinner and rethrows', async () => {
    const io = makeIo(true);
    const boom = new Error('daemon exploded');

    await expect(
      ensureManagedLocalEmbeddingsDaemon({
        cliVersion: '0.2.0',
        projectDir: '/work/proj',
        installPolicy: 'auto',
        io: io.io,
        ensureRuntime: vi.fn(async () => runtime()),
        startDaemon: vi.fn(async () => {
          throw boom;
        }),
      }),
    ).rejects.toBe(boom);

    expect(io.stdout()).toBe('');
    expect(io.stderr()).toContain('ktx embedding daemon failed to start');
  });
});

describe('tryUseManagedLocalEmbeddingsDaemon', () => {
  it('returns the daemon when one is running and healthy', async () => {
    const readStatus = vi.fn(async () => ({
      kind: 'running' as const,
      detail: 'ok',
      layout: {} as ManagedPythonDaemonLayout,
      state: {
        schemaVersion: 1 as const,
        pid: 123,
        host: '127.0.0.1' as const,
        port: 4321,
        version: '0.5.0',
        features: ['local-embeddings' as const],
        startedAt: '2026-05-21T00:00:00Z',
        stdoutLog: '/tmp/stdout.log',
        stderrLog: '/tmp/stderr.log',
      },
      baseUrl: 'http://127.0.0.1:4321',
    }));
    const result = await tryUseManagedLocalEmbeddingsDaemon({
      cliVersion: '0.5.0',
      projectDir: '/work/proj',
      readStatus,
    });
    expect(result).toEqual({
      baseUrl: 'http://127.0.0.1:4321',
      stdoutLog: '/tmp/stdout.log',
      stderrLog: '/tmp/stderr.log',
    });
    expect(readStatus).toHaveBeenCalledWith({
      cliVersion: '0.5.0',
      projectDir: '/work/proj',
    });
  });

  it('returns null when no daemon state exists', async () => {
    const readStatus = vi.fn(async () => ({
      kind: 'stopped' as const,
      detail: 'no state',
      layout: {} as ManagedPythonDaemonLayout,
    }));
    const result = await tryUseManagedLocalEmbeddingsDaemon({
      cliVersion: '0.5.0',
      projectDir: '/work/proj',
      readStatus,
    });
    expect(result).toBeNull();
  });

  it('returns null when daemon is stale', async () => {
    const readStatus = vi.fn(async () => ({
      kind: 'stale' as const,
      detail: 'process gone',
      layout: {} as ManagedPythonDaemonLayout,
    }));
    const result = await tryUseManagedLocalEmbeddingsDaemon({
      cliVersion: '0.5.0',
      projectDir: '/work/proj',
      readStatus,
    });
    expect(result).toBeNull();
  });

  it('rejects daemons that do not advertise local-embeddings', async () => {
    const readStatus = vi.fn(async () => ({
      kind: 'running' as const,
      detail: 'ok',
      layout: {} as ManagedPythonDaemonLayout,
      state: {
        schemaVersion: 1 as const,
        pid: 123,
        host: '127.0.0.1' as const,
        port: 4321,
        version: '0.5.0',
        features: ['core' as const],
        startedAt: '2026-05-21T00:00:00Z',
        stdoutLog: '/tmp/stdout.log',
        stderrLog: '/tmp/stderr.log',
      },
      baseUrl: 'http://127.0.0.1:4321',
    }));
    const result = await tryUseManagedLocalEmbeddingsDaemon({
      cliVersion: '0.5.0',
      projectDir: '/work/proj',
      readStatus,
    });
    expect(result).toBeNull();
  });
});
