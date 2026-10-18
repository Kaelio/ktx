import { EventEmitter } from 'node:events';
import { writeFileSync } from 'node:fs';
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { createServer } from 'node:http';
import type { AddressInfo } from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  ManagedPythonDaemonStartError,
  readManagedPythonDaemonStatus,
  startManagedPythonDaemon,
  stopAllManagedPythonDaemons,
  stopManagedPythonDaemon,
  type ManagedPythonDaemonChild,
  type ManagedPythonDaemonFetch,
  type ManagedPythonDaemonProcessInfo,
  type ManagedPythonDaemonSpawn,
  type ManagedPythonDaemonState,
} from '../src/managed-python-daemon.js';
import type {
  InstalledKtxRuntimeManifest,
  ManagedPythonDaemonLayout,
  ManagedPythonRuntimeInstallResult,
  ManagedPythonRuntimeLayout,
} from '../src/managed-python-runtime.js';

function layout(root: string): ManagedPythonDaemonLayout {
  const projectDir = join(root, 'project');
  return {
    cliVersion: '0.2.0',
    runtimeRoot: join(root, 'runtime'),
    versionDir: join(root, 'runtime', '0.2.0'),
    venvDir: join(root, 'runtime', '0.2.0', '.venv'),
    manifestPath: join(root, 'runtime', '0.2.0', 'manifest.json'),
    installLogPath: join(root, 'runtime', '0.2.0', 'install.log'),
    assetDir: join(root, 'assets', 'python'),
    assetManifestPath: join(root, 'assets', 'python', 'manifest.json'),
    pythonPath: join(root, 'runtime', '0.2.0', '.venv', 'bin', 'python'),
    daemonPath: join(root, 'runtime', '0.2.0', '.venv', 'bin', 'ktx-daemon'),
    projectDir,
    daemonStateDir: join(projectDir, '.ktx', 'runtime'),
    daemonStatePath: join(projectDir, '.ktx', 'runtime', 'daemon.json'),
    daemonStdoutPath: join(projectDir, '.ktx', 'runtime', 'daemon.stdout.log'),
    daemonStderrPath: join(projectDir, '.ktx', 'runtime', 'daemon.stderr.log'),
  };
}

function installLayout(root: string): ManagedPythonRuntimeLayout {
  const { projectDir: _projectDir, daemonStateDir: _d, daemonStatePath: _ds, daemonStdoutPath: _so, daemonStderrPath: _se, ...rest } = layout(root);
  return rest;
}

function manifest(root: string, features: Array<'core' | 'local-embeddings'> = ['core']): InstalledKtxRuntimeManifest {
  const runtimeLayout = layout(root);
  return {
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
    features,
    python: {
      executable: runtimeLayout.pythonPath,
      daemonExecutable: runtimeLayout.daemonPath,
    },
    installLog: runtimeLayout.installLogPath,
  };
}

function installResult(root: string, features: Array<'core' | 'local-embeddings'> = ['core']): ManagedPythonRuntimeInstallResult {
  return {
    status: 'ready',
    layout: installLayout(root),
    asset: {
      manifest: manifest(root, features).asset,
      wheelPath: join(root, 'assets', 'python', 'kaelio_ktx-0.2.0-py3-none-any.whl'),
      requiresPython: { specifier: '>=3.13', minimumVersion: '3.13' },
    },
    manifest: manifest(root, features),
  };
}

function makeFetch(version = '0.2.0'): ManagedPythonDaemonFetch {
  return vi.fn(async () => ({
    ok: true,
    status: 200,
    json: async () => ({ status: 'healthy', version }),
    text: async () => '',
  }));
}

type FakeDaemonChild = ManagedPythonDaemonChild & EventEmitter;

function makeChild(pid: number | undefined): FakeDaemonChild {
  return Object.assign(new EventEmitter(), { pid, unref: vi.fn() });
}

function makeSpawn(pid = 4242, children: FakeDaemonChild[] = []): ManagedPythonDaemonSpawn {
  return vi.fn((_command, _args, _options): ManagedPythonDaemonChild => {
    const child = makeChild(pid);
    children.push(child);
    return child;
  });
}

function refusedConnect(port = 61234): Error {
  return Object.assign(new Error(`connect ECONNREFUSED 127.0.0.1:${port}`), {
    code: 'ECONNREFUSED',
    syscall: 'connect',
    address: '127.0.0.1',
    port,
  });
}

function runningState(root: string, overrides: Partial<ManagedPythonDaemonState> = {}): ManagedPythonDaemonState {
  const runtimeLayout = layout(root);
  return {
    schemaVersion: 1,
    pid: 4242,
    host: '127.0.0.1',
    port: 58731,
    version: '0.2.0',
    features: ['core'],
    startedAt: '2026-05-11T00:00:00.000Z',
    stdoutLog: runtimeLayout.daemonStdoutPath,
    stderrLog: runtimeLayout.daemonStderrPath,
    ...overrides,
  };
}

function daemonOptionsBase(root: string) {
  return {
    cliVersion: '0.2.0',
    projectDir: layout(root).projectDir,
    runtimeRoot: join(root, 'runtime'),
  } as const;
}

describe('ktx daemon lifecycle', () => {
  let tempDir: string;

  beforeEach(async () => {
    tempDir = await mkdtemp(join(tmpdir(), 'ktx-managed-daemon-'));
  });

  afterEach(async () => {
    vi.unstubAllEnvs();
    await rm(tempDir, { recursive: true, force: true });
  });

  it('reports stopped when no daemon state exists', async () => {
    const status = await readManagedPythonDaemonStatus({
      ...daemonOptionsBase(tempDir),
      processAlive: vi.fn(() => false),
      fetch: makeFetch(),
    });

    expect(status.kind).toBe('stopped');
    expect(status.detail).toContain('No daemon state');
  });

  it('starts ktx-daemon serve-http, waits for health, and writes state', async () => {
    const spawnDaemon = makeSpawn(5555);
    const installRuntime = vi.fn(async () => installResult(tempDir));

    const result = await startManagedPythonDaemon({
      ...daemonOptionsBase(tempDir),
      features: ['core'],
      installRuntime,
      spawnDaemon,
      fetch: makeFetch(),
      allocatePort: vi.fn(async () => 61234),
      now: () => new Date('2026-05-11T00:00:00.000Z'),
      pollIntervalMs: 1,
    });

    expect(result.status).toBe('started');
    expect(result.baseUrl).toBe('http://127.0.0.1:61234');
    expect(installRuntime).toHaveBeenCalledWith({
      cliVersion: '0.2.0',
      runtimeRoot: join(tempDir, 'runtime'),
      features: ['core'],
      force: false,
    });
    expect(spawnDaemon).toHaveBeenCalledWith(
      layout(tempDir).daemonPath,
      ['serve-http', '--host', '127.0.0.1', '--port', '61234'],
      expect.objectContaining({
        detached: true,
        env: expect.objectContaining({ KTX_DAEMON_VERSION: '0.2.0' }),
      }),
    );
    expect(JSON.parse(await readFile(layout(tempDir).daemonStatePath, 'utf8'))).toMatchObject({
      pid: 5555,
      port: 61234,
      version: '0.2.0',
      features: ['core'],
      stdoutLog: layout(tempDir).daemonStdoutPath,
      stderrLog: layout(tempDir).daemonStderrPath,
    });
  });

  it('sanitizes IPv6 CIDR entries from child NO_PROXY env', async () => {
    vi.stubEnv('NO_PROXY', 'localhost,fd07:b51a:cc66:f0::/64,127.0.0.0/8');
    vi.stubEnv('no_proxy', '::1,fd00::/8,*.orb.local');
    const spawnDaemon = makeSpawn(5555);

    await startManagedPythonDaemon({
      ...daemonOptionsBase(tempDir),
      features: ['local-embeddings'],
      installRuntime: vi.fn(async () => installResult(tempDir, ['core', 'local-embeddings'])),
      spawnDaemon,
      fetch: makeFetch(),
      allocatePort: vi.fn(async () => 61234),
      now: () => new Date('2026-05-11T00:00:00.000Z'),
      pollIntervalMs: 1,
    });

    const env = vi.mocked(spawnDaemon).mock.calls[0]?.[2].env;
    expect(env?.NO_PROXY).toBe('localhost,127.0.0.0/8,::1,*.orb.local');
    expect(env?.no_proxy).toBe(env?.NO_PROXY);
  });

  it('makes a final health probe before reporting startup failure', async () => {
    const spawnDaemon = makeSpawn(5556);
    const installRuntime = vi.fn(async () => installResult(tempDir));
    const fetch = vi
      .fn<ManagedPythonDaemonFetch>()
      .mockRejectedValueOnce(new Error('fetch failed'))
      .mockResolvedValueOnce({
        ok: true,
        status: 200,
        json: async () => ({ status: 'healthy', version: '0.2.0' }),
        text: async () => '',
      });

    const result = await startManagedPythonDaemon({
      ...daemonOptionsBase(tempDir),
      features: ['core'],
      installRuntime,
      spawnDaemon,
      fetch,
      allocatePort: vi.fn(async () => 61234),
      now: () => new Date('2026-05-11T00:00:00.000Z'),
      startupTimeoutMs: 5,
      pollIntervalMs: 20,
    });

    expect(result.status).toBe('started');
    expect(fetch).toHaveBeenCalledTimes(2);
    expect(JSON.parse(await readFile(layout(tempDir).daemonStatePath, 'utf8'))).toMatchObject({
      pid: 5556,
      port: 61234,
      version: '0.2.0',
    });
  });

  it('kills the spawned daemon when the startup health check times out', async () => {
    const spawnDaemon = makeSpawn(7777);
    const killProcess = vi.fn();
    const fetch = vi.fn<ManagedPythonDaemonFetch>().mockRejectedValue(new Error('fetch failed'));

    await expect(
      startManagedPythonDaemon({
        ...daemonOptionsBase(tempDir),
        features: ['core'],
        installRuntime: vi.fn(async () => installResult(tempDir)),
        spawnDaemon,
        fetch,
        processAlive: vi.fn(() => true),
        killProcess,
        allocatePort: vi.fn(async () => 61234),
        now: () => new Date('2026-05-11T00:00:00.000Z'),
        startupTimeoutMs: 5,
        pollIntervalMs: 1,
      }),
    ).rejects.toBeInstanceOf(ManagedPythonDaemonStartError);

    expect(killProcess).toHaveBeenCalledWith(7777);
    await expect(readFile(layout(tempDir).daemonStatePath, 'utf8')).rejects.toMatchObject({ code: 'ENOENT' });
  });

  it('surfaces the underlying fetch cause in the startup failure message', async () => {
    const cause = new Error('connect ECONNREFUSED 127.0.0.1:61234');
    const fetchError = new Error('fetch failed');
    (fetchError as Error & { cause?: unknown }).cause = cause;

    const error = await startManagedPythonDaemon({
      ...daemonOptionsBase(tempDir),
      features: ['core'],
      installRuntime: vi.fn(async () => installResult(tempDir)),
      spawnDaemon: makeSpawn(7778),
      fetch: vi.fn<ManagedPythonDaemonFetch>().mockRejectedValue(fetchError),
      processAlive: vi.fn(() => false),
      killProcess: vi.fn(),
      allocatePort: vi.fn(async () => 61234),
      now: () => new Date('2026-05-11T00:00:00.000Z'),
      startupTimeoutMs: 5,
      pollIntervalMs: 1,
    }).catch((value: unknown) => value);

    expect(error).toBeInstanceOf(ManagedPythonDaemonStartError);
    const startError = error as ManagedPythonDaemonStartError;
    expect(startError.detail).toContain('fetch failed');
    expect(startError.detail).toContain('ECONNREFUSED');
    expect(startError.message).toContain('ECONNREFUSED');
  });

  it('reports a spawn failure from the child error event instead of crashing', async () => {
    const children: FakeDaemonChild[] = [];
    const spawnDaemon = vi.fn<ManagedPythonDaemonSpawn>(() => {
      const child = makeChild(undefined);
      children.push(child);
      process.nextTick(() =>
        child.emit(
          'error',
          Object.assign(new Error('spawn /runtime/ktx-daemon ENOENT'), { code: 'ENOENT', syscall: 'spawn' }),
        ),
      );
      return child;
    });
    const killProcess = vi.fn();

    const error = await startManagedPythonDaemon({
      ...daemonOptionsBase(tempDir),
      features: ['core'],
      installRuntime: vi.fn(async () => installResult(tempDir)),
      spawnDaemon,
      fetch: vi.fn<ManagedPythonDaemonFetch>().mockRejectedValue(refusedConnect()),
      processAlive: vi.fn(() => false),
      killProcess,
      allocatePort: vi.fn(async () => 61234),
      startupTimeoutMs: 10_000,
      pollIntervalMs: 1,
    }).catch((value: unknown) => value);

    expect(error).toBeInstanceOf(ManagedPythonDaemonStartError);
    expect((error as ManagedPythonDaemonStartError).reason).toBe('spawn-failed');
    expect((error as ManagedPythonDaemonStartError).detail).toContain('ENOENT');
    expect(killProcess).not.toHaveBeenCalled();
    expect(children[0]?.listenerCount('error')).toBe(0);
    expect(children[0]?.listenerCount('exit')).toBe(0);
    await expect(readFile(layout(tempDir).daemonStatePath, 'utf8')).rejects.toMatchObject({ code: 'ENOENT' });
  });

  it.each([
    [1, null, 'exit code 1'],
    [null, 'SIGKILL', 'signal SIGKILL'],
  ] as const)('reports a daemon that exits before readiness (%s, %s) without waiting for the deadline', async (code, signal, outcome) => {
    const children: FakeDaemonChild[] = [];
    let alive = true;
    const fetch = vi.fn<ManagedPythonDaemonFetch>(async () => {
      if (alive) {
        alive = false;
        setImmediate(() => children[0]?.emit('exit', code, signal));
      }
      throw new TypeError('fetch failed', { cause: refusedConnect() });
    });
    const killProcess = vi.fn();

    const error = await startManagedPythonDaemon({
      ...daemonOptionsBase(tempDir),
      features: ['core'],
      installRuntime: vi.fn(async () => installResult(tempDir)),
      spawnDaemon: makeSpawn(7790, children),
      fetch,
      processAlive: vi.fn(() => alive),
      killProcess,
      allocatePort: vi.fn(async () => 61234),
      startupTimeoutMs: 10_000,
      pollIntervalMs: 5,
    }).catch((value: unknown) => value);

    expect(error).toBeInstanceOf(ManagedPythonDaemonStartError);
    expect(error).toMatchObject({
      reason: 'exited-before-ready',
      detail: `ktx-daemon exited before becoming healthy (${outcome})`,
      stderrLog: layout(tempDir).daemonStderrPath,
    });
    expect(killProcess).not.toHaveBeenCalled();
    expect(children[0]?.listenerCount('exit')).toBe(0);
    await expect(readFile(layout(tempDir).daemonStatePath, 'utf8')).rejects.toMatchObject({ code: 'ENOENT' });
  });

  it('aborts a hanging health probe and fails at the startup deadline', async () => {
    const signals: AbortSignal[] = [];
    const fetch = vi.fn<ManagedPythonDaemonFetch>(
      (_url, init) =>
        new Promise((_resolve, reject) => {
          const signal = init?.signal;
          if (signal) {
            signals.push(signal);
            signal.addEventListener('abort', () => reject(new DOMException('aborted', 'AbortError')));
          }
        }),
    );
    const killProcess = vi.fn();

    const error = await startManagedPythonDaemon({
      ...daemonOptionsBase(tempDir),
      features: ['core'],
      installRuntime: vi.fn(async () => installResult(tempDir)),
      spawnDaemon: makeSpawn(7791),
      fetch,
      processAlive: vi.fn(() => true),
      killProcess,
      allocatePort: vi.fn(async () => 61234),
      startupTimeoutMs: 50,
      pollIntervalMs: 5,
    }).catch((value: unknown) => value);

    expect(error).toMatchObject({
      reason: 'readiness-timeout',
      detail: 'not healthy after 50ms: Health check timed out after 50ms',
    });
    expect(signals.length).toBeGreaterThan(0);
    expect(signals.every((signal) => signal.aborted)).toBe(true);
    expect(killProcess).toHaveBeenCalledWith(7791);
  });

  it('bounds a real health response whose body never completes', async () => {
    const server = createServer((_request, response) => {
      response.writeHead(200, { 'content-type': 'application/json' });
      response.write('{"status":');
    });
    await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
    const { port } = server.address() as AddressInfo;
    const startedAt = Date.now();
    try {
      const error = await startManagedPythonDaemon({
        ...daemonOptionsBase(tempDir),
        features: ['core'],
        installRuntime: vi.fn(async () => installResult(tempDir)),
        spawnDaemon: makeSpawn(7792),
        processAlive: vi.fn(() => true),
        killProcess: vi.fn(),
        allocatePort: vi.fn(async () => port),
        startupTimeoutMs: 200,
        pollIntervalMs: 10,
      }).catch((value: unknown) => value);

      expect(error).toMatchObject({ reason: 'readiness-timeout' });
      expect((error as ManagedPythonDaemonStartError).detail).toContain('Health check timed out after 200ms');
      expect(Date.now() - startedAt).toBeLessThan(2_000);
    } finally {
      server.closeAllConnections();
      await new Promise<void>((resolve) => server.close(() => resolve()));
    }
  });

  it('keeps polling an unhealthy response until the deadline and reports the last probe', async () => {
    const fetch = vi.fn<ManagedPythonDaemonFetch>(async () => ({
      ok: false,
      status: 503,
      json: async () => ({}),
      text: async () => 'warming up',
    }));

    const error = await startManagedPythonDaemon({
      ...daemonOptionsBase(tempDir),
      features: ['core'],
      installRuntime: vi.fn(async () => installResult(tempDir)),
      spawnDaemon: makeSpawn(7793),
      fetch,
      processAlive: vi.fn(() => false),
      killProcess: vi.fn(),
      allocatePort: vi.fn(async () => 61234),
      startupTimeoutMs: 20,
      pollIntervalMs: 2,
    }).catch((value: unknown) => value);

    expect(error).toMatchObject({
      reason: 'readiness-timeout',
      detail: 'not healthy after 20ms: Health check returned HTTP 503: warming up',
    });
    expect(fetch.mock.calls.length).toBeGreaterThan(1);
  });

  it('fails fast when the allocated port answers health checks for another daemon version', async () => {
    const killProcess = vi.fn();
    const fetch = makeFetch('9.9.9');

    const error = await startManagedPythonDaemon({
      ...daemonOptionsBase(tempDir),
      features: ['core'],
      installRuntime: vi.fn(async () => installResult(tempDir)),
      spawnDaemon: makeSpawn(7794),
      fetch,
      processAlive: vi.fn(() => true),
      killProcess,
      allocatePort: vi.fn(async () => 61234),
      startupTimeoutMs: 10_000,
      pollIntervalMs: 1,
    }).catch((value: unknown) => value);

    expect(error).toMatchObject({
      reason: 'version-mismatch',
      detail: 'Daemon version 9.9.9 does not match CLI 0.2.0',
    });
    expect(fetch).toHaveBeenCalledTimes(1);
    expect(killProcess).toHaveBeenCalledWith(7794);
  });

  it('removes its child listeners once the daemon is ready', async () => {
    const children: FakeDaemonChild[] = [];

    await startManagedPythonDaemon({
      ...daemonOptionsBase(tempDir),
      features: ['core'],
      installRuntime: vi.fn(async () => installResult(tempDir)),
      spawnDaemon: makeSpawn(7795, children),
      fetch: makeFetch(),
      allocatePort: vi.fn(async () => 61234),
      pollIntervalMs: 1,
    });

    expect(children[0]?.listenerCount('error')).toBe(0);
    expect(children[0]?.listenerCount('exit')).toBe(0);
  });

  it('does not remove a daemon state that another attempt recorded while this start failed', async () => {
    const otherState = runningState(tempDir, { pid: 8888, port: 61299, startedAt: '2026-05-11T00:00:09.000Z' });
    const fetch = vi.fn<ManagedPythonDaemonFetch>(async () => {
      await mkdir(layout(tempDir).daemonStateDir, { recursive: true });
      await writeFile(layout(tempDir).daemonStatePath, `${JSON.stringify(otherState)}\n`);
      throw new TypeError('fetch failed', { cause: refusedConnect() });
    });

    const error = await startManagedPythonDaemon({
      ...daemonOptionsBase(tempDir),
      features: ['core'],
      installRuntime: vi.fn(async () => installResult(tempDir)),
      spawnDaemon: makeSpawn(7796),
      fetch,
      processAlive: vi.fn(() => false),
      killProcess: vi.fn(),
      allocatePort: vi.fn(async () => 61234),
      startupTimeoutMs: 5,
      pollIntervalMs: 1,
    }).catch((value: unknown) => value);

    expect(error).toBeInstanceOf(ManagedPythonDaemonStartError);
    expect(JSON.parse(await readFile(layout(tempDir).daemonStatePath, 'utf8'))).toEqual(otherState);
  });

  it('leaves a newer recorded daemon alone and yields to it instead of publishing a second daemon', async () => {
    await mkdir(layout(tempDir).daemonStateDir, { recursive: true });
    const staleState = runningState(tempDir, { pid: 4242 });
    const newerState = runningState(tempDir, { pid: 5151, port: 61300, startedAt: '2026-05-11T00:00:05.000Z' });
    await writeFile(layout(tempDir).daemonStatePath, `${JSON.stringify(staleState)}\n`);
    const processAlive = vi.fn((pid: number) => {
      if (pid === staleState.pid) {
        // Another process replaces the stale daemon between this attempt's status read and its cleanup.
        writeFileSync(layout(tempDir).daemonStatePath, `${JSON.stringify(newerState)}\n`);
        return false;
      }
      return true;
    });
    const killProcess = vi.fn();
    const spawnDaemon = makeSpawn(7797);

    const result = await startManagedPythonDaemon({
      ...daemonOptionsBase(tempDir),
      features: ['core'],
      installRuntime: vi.fn(async () => installResult(tempDir)),
      spawnDaemon,
      fetch: makeFetch(),
      processAlive,
      killProcess,
      allocatePort: vi.fn(async () => 61234),
      pollIntervalMs: 1,
    });

    expect(result).toMatchObject({ status: 'reused', baseUrl: 'http://127.0.0.1:61300', state: newerState });
    expect(killProcess).toHaveBeenCalledTimes(1);
    expect(killProcess).toHaveBeenCalledWith(7797);
    expect(JSON.parse(await readFile(layout(tempDir).daemonStatePath, 'utf8'))).toEqual(newerState);
  });

  it('exposes the daemon stderr log path on startup failure', async () => {
    const error = await startManagedPythonDaemon({
      ...daemonOptionsBase(tempDir),
      features: ['core'],
      installRuntime: vi.fn(async () => installResult(tempDir)),
      spawnDaemon: makeSpawn(7779),
      fetch: vi.fn<ManagedPythonDaemonFetch>().mockRejectedValue(new Error('fetch failed')),
      processAlive: vi.fn(() => false),
      killProcess: vi.fn(),
      allocatePort: vi.fn(async () => 61234),
      now: () => new Date('2026-05-11T00:00:00.000Z'),
      startupTimeoutMs: 5,
      pollIntervalMs: 1,
    }).catch((value: unknown) => value);

    expect(error).toBeInstanceOf(ManagedPythonDaemonStartError);
    expect((error as ManagedPythonDaemonStartError).stderrLog).toBe(layout(tempDir).daemonStderrPath);
  });

  it('reuses a healthy daemon with the requested feature set', async () => {
    await mkdir(layout(tempDir).daemonStateDir, { recursive: true });
    await writeFile(layout(tempDir).daemonStatePath, `${JSON.stringify(runningState(tempDir), null, 2)}\n`);
    const spawnDaemon = makeSpawn(9999);

    const result = await startManagedPythonDaemon({
      ...daemonOptionsBase(tempDir),
      features: ['core'],
      installRuntime: vi.fn(async () => installResult(tempDir)),
      spawnDaemon,
      fetch: makeFetch(),
      processAlive: vi.fn(() => true),
      pollIntervalMs: 1,
    });

    expect(result.status).toBe('reused');
    expect(result.baseUrl).toBe('http://127.0.0.1:58731');
    expect(spawnDaemon).not.toHaveBeenCalled();
  });

  it('starts a fresh daemon when the previous state is stale', async () => {
    await mkdir(layout(tempDir).daemonStateDir, { recursive: true });
    await writeFile(
      layout(tempDir).daemonStatePath,
      `${JSON.stringify(runningState(tempDir, { version: '0.1.0' }), null, 2)}\n`,
    );

    const result = await startManagedPythonDaemon({
      ...daemonOptionsBase(tempDir),
      features: ['core'],
      installRuntime: vi.fn(async () => installResult(tempDir)),
      spawnDaemon: makeSpawn(6666),
      fetch: makeFetch(),
      processAlive: vi.fn(() => true),
      killProcess: vi.fn(),
      allocatePort: vi.fn(async () => 61235),
      now: () => new Date('2026-05-11T00:00:00.000Z'),
      pollIntervalMs: 1,
    });

    expect(result.status).toBe('started');
    expect(JSON.parse(await readFile(layout(tempDir).daemonStatePath, 'utf8'))).toMatchObject({
      pid: 6666,
      port: 61235,
      version: '0.2.0',
    });
  });

  it('stops a recorded daemon and removes the state file', async () => {
    await mkdir(layout(tempDir).daemonStateDir, { recursive: true });
    await writeFile(layout(tempDir).daemonStatePath, `${JSON.stringify(runningState(tempDir), null, 2)}\n`);
    const killProcess = vi.fn();

    const result = await stopManagedPythonDaemon({
      ...daemonOptionsBase(tempDir),
      processAlive: vi.fn(() => true),
      killProcess,
    });

    expect(result.status).toBe('stopped');
    expect(killProcess).toHaveBeenCalledWith(4242);
    await expect(readFile(layout(tempDir).daemonStatePath, 'utf8')).rejects.toThrow();
  });

  it('stops the recorded daemon for this project and removes the state file', async () => {
    await mkdir(layout(tempDir).daemonStateDir, { recursive: true });
    await writeFile(layout(tempDir).daemonStatePath, `${JSON.stringify(runningState(tempDir), null, 2)}\n`);
    const alive = new Set([4242]);
    const killProcess = vi.fn((pid: number) => {
      alive.delete(pid);
    });

    const result = await stopAllManagedPythonDaemons({
      ...daemonOptionsBase(tempDir),
      listProcesses: vi.fn(async () => []),
      processAlive: vi.fn((pid) => alive.has(pid)),
      killProcess,
      stopGraceMs: 0,
    });

    expect(result.failed).toHaveLength(0);
    expect(result.stopped.map((entry) => entry.pid)).toEqual([4242]);
    expect(killProcess).toHaveBeenCalledWith(4242, 'SIGTERM');
    await expect(readFile(layout(tempDir).daemonStatePath, 'utf8')).rejects.toThrow();
  });

  it('removes stale state when the recorded daemon process is no longer alive', async () => {
    await mkdir(layout(tempDir).daemonStateDir, { recursive: true });
    await writeFile(layout(tempDir).daemonStatePath, `${JSON.stringify(runningState(tempDir), null, 2)}\n`);

    const result = await stopAllManagedPythonDaemons({
      ...daemonOptionsBase(tempDir),
      listProcesses: vi.fn(async () => []),
      processAlive: vi.fn(() => false),
      killProcess: vi.fn(),
      stopGraceMs: 0,
    });

    expect(result.stopped).toHaveLength(0);
    expect(result.stale.map((entry) => entry.pid)).toEqual([4242]);
    await expect(readFile(layout(tempDir).daemonStatePath, 'utf8')).rejects.toThrow();
  });

  it('deduplicates a daemon found by state and process scan, preferring state metadata', async () => {
    await mkdir(layout(tempDir).daemonStateDir, { recursive: true });
    await writeFile(layout(tempDir).daemonStatePath, `${JSON.stringify(runningState(tempDir), null, 2)}\n`);
    const alive = new Set([4242]);
    const killProcess = vi.fn((pid: number) => {
      alive.delete(pid);
    });

    const result = await stopAllManagedPythonDaemons({
      ...daemonOptionsBase(tempDir),
      listProcesses: vi.fn(async (): Promise<ManagedPythonDaemonProcessInfo[]> => [
        { pid: 4242, command: 'uv run ktx-daemon serve-http --host 127.0.0.1 --port 61234' },
      ]),
      processAlive: vi.fn((pid) => alive.has(pid)),
      killProcess,
      stopGraceMs: 0,
    });

    expect(result.stopped).toHaveLength(1);
    expect(result.stopped[0]).toMatchObject({
      pid: 4242,
      source: 'state',
      url: 'http://127.0.0.1:58731',
    });
    expect(killProcess).toHaveBeenCalledTimes(1);
  });

  it('stops unrecorded ktx-daemon serve-http processes from process scan results', async () => {
    const alive = new Set([3333, 5555]);
    const killProcess = vi.fn((pid: number) => {
      alive.delete(pid);
    });

    const result = await stopAllManagedPythonDaemons({
      ...daemonOptionsBase(tempDir),
      listProcesses: vi.fn(async (): Promise<ManagedPythonDaemonProcessInfo[]> => [
        { pid: 3333, command: 'uv run ktx-daemon serve-http --host 127.0.0.1 --port 8765' },
        { pid: 4444, command: 'node server.js --port 8765' },
        { pid: 5555, command: 'grep ktx-daemon serve-http --port 8765' },
      ]),
      processAlive: vi.fn((pid) => alive.has(pid)),
      killProcess,
      stopGraceMs: 0,
    });

    expect(result.failed).toHaveLength(0);
    expect(result.stopped).toEqual([
      expect.objectContaining({
        pid: 3333,
        source: 'process',
        url: 'http://127.0.0.1:8765',
      }),
    ]);
    expect(killProcess).toHaveBeenCalledWith(3333, 'SIGTERM');
    expect(killProcess).not.toHaveBeenCalledWith(4444, expect.anything());
    expect(killProcess).not.toHaveBeenCalledWith(5555, expect.anything());
  });

  it('reports a failed stop when TERM and KILL leave a daemon running', async () => {
    await mkdir(layout(tempDir).daemonStateDir, { recursive: true });
    await writeFile(layout(tempDir).daemonStatePath, `${JSON.stringify(runningState(tempDir), null, 2)}\n`);

    const result = await stopAllManagedPythonDaemons({
      ...daemonOptionsBase(tempDir),
      listProcesses: vi.fn(async () => []),
      processAlive: vi.fn(() => true),
      killProcess: vi.fn(),
      stopGraceMs: 0,
    });

    expect(result.stopped).toHaveLength(0);
    expect(result.failed).toEqual([
      expect.objectContaining({
        pid: 4242,
        detail: 'Process still running after SIGKILL',
      }),
    ]);
    expect(await readFile(layout(tempDir).daemonStatePath, 'utf8')).toContain('"pid": 4242');
  });
});
