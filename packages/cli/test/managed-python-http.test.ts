import { EventEmitter } from 'node:events';
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { createServer, type IncomingMessage, type ServerResponse } from 'node:http';
import type { AddressInfo } from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  ManagedPythonDaemonStartError,
  startManagedPythonDaemon,
  type ManagedPythonDaemonChild,
  type ManagedPythonDaemonFetch,
  type ManagedPythonDaemonStartResult,
} from '../src/managed-python-daemon.js';
import {
  createManagedDaemonHttpJsonRunner,
  createManagedDaemonLookerTableIdentifierParser,
  createManagedDaemonSqlAnalysisPort,
  managedDaemonDatabaseIntrospectionOptions,
  type ManagedPythonCoreDaemonOptions,
} from '../src/managed-python-http.js';

type StartDaemon = NonNullable<ManagedPythonCoreDaemonOptions['startDaemon']>;
type PostJson = (baseUrl: string, path: string, payload: Record<string, unknown>) => Promise<Record<string, unknown>>;
type ManagedRunnerOptions = ManagedPythonCoreDaemonOptions & { postJson?: PostJson };

const STALE_URL = 'http://127.0.0.1:61001';
const REPLACEMENT_URL = 'http://127.0.0.1:61002';
const THIRD_URL = 'http://127.0.0.1:61003';

function io() {
  let stderr = '';
  return {
    io: {
      stdout: { write: vi.fn() },
      stderr: { write: (chunk: string) => (stderr += chunk) },
    },
    stderr: () => stderr,
  };
}

interface JsonTestServer {
  baseUrl: string;
  port: number;
  requests: string[];
  close(): Promise<void>;
}

const openServers: JsonTestServer[] = [];
const tempDirs: string[] = [];

afterEach(async () => {
  await Promise.all(openServers.splice(0).map((server) => server.close()));
  await Promise.all(tempDirs.splice(0).map((dir) => rm(dir, { recursive: true, force: true })));
});

function respondLikeDaemon(request: IncomingMessage, response: ServerResponse): void {
  response.end(JSON.stringify(request.url === '/health' ? { status: 'healthy', version: '0.2.0' } : { ok: true }));
}

async function startJsonServer(
  respond: (request: IncomingMessage, response: ServerResponse) => void = respondLikeDaemon,
): Promise<JsonTestServer> {
  const requests: string[] = [];
  const server = createServer((request, response) => {
    requests.push(request.url ?? '');
    request.resume();
    request.on('end', () => {
      // Avoids keep-alive socket reuse so a closed server deterministically refuses the next connect.
      response.setHeader('connection', 'close');
      respond(request, response);
    });
  });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const { port } = server.address() as AddressInfo;
  let closed: Promise<void> | undefined;
  const handle: JsonTestServer = {
    baseUrl: `http://127.0.0.1:${port}`,
    port,
    requests,
    close: () => {
      closed ??= new Promise<void>((resolve) => {
        server.closeAllConnections();
        server.close(() => resolve());
      });
      return closed;
    },
  };
  openServers.push(handle);
  return handle;
}

async function makeTempDir(): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), 'ktx-managed-http-'));
  tempDirs.push(dir);
  return dir;
}

function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (error: unknown) => void;
  const promise = new Promise<T>((onResolve, onReject) => {
    resolve = onResolve;
    reject = onReject;
  });
  return { promise, resolve, reject };
}

function refused(port = 61001): Error {
  return Object.assign(new Error(`connect ECONNREFUSED 127.0.0.1:${port}`), {
    code: 'ECONNREFUSED',
    syscall: 'connect',
    address: '127.0.0.1',
    port,
  });
}

function daemonStart(
  baseUrl: string,
  options: { status?: 'started' | 'reused'; pid?: number } = {},
): ManagedPythonDaemonStartResult {
  return {
    status: options.status ?? 'started',
    layout: {} as never,
    state: { pid: options.pid ?? 1234, stderrLog: '/work/proj/.ktx/runtime/daemon.stderr.log' } as never,
    baseUrl,
  };
}

function managedOptions(overrides: Partial<ManagedRunnerOptions> = {}): ManagedRunnerOptions {
  return {
    cliVersion: '0.2.0',
    projectDir: '/work/recovery-project',
    installPolicy: 'auto',
    io: io().io,
    ensureRuntime: vi.fn(async () => ({ layout: {} as never, manifest: {} as never })),
    ...overrides,
  };
}

function fakeChild(pid: number): ManagedPythonDaemonChild {
  return Object.assign(new EventEmitter(), { pid, unref: vi.fn() });
}

function fakeInstall() {
  return { manifest: { python: { daemonExecutable: '/runtime/ktx-daemon' }, features: ['core'] } } as never;
}

async function writeDaemonState(projectDir: string, state: { pid: number; port: number }): Promise<string> {
  const stateDir = join(projectDir, '.ktx', 'runtime');
  await mkdir(stateDir, { recursive: true });
  const statePath = join(stateDir, 'daemon.json');
  await writeFile(
    statePath,
    `${JSON.stringify({
      schemaVersion: 1,
      pid: state.pid,
      host: '127.0.0.1',
      port: state.port,
      version: '0.2.0',
      features: ['core'],
      startedAt: `2026-05-11T00:00:0${state.pid % 10}.000Z`,
      stdoutLog: join(stateDir, 'daemon.stdout.log'),
      stderrLog: join(stateDir, 'daemon.stderr.log'),
    })}\n`,
  );
  return statePath;
}

describe('createManagedDaemonHttpJsonRunner managed mode', () => {
  it('ensures the core runtime and starts the daemon once across requests', async () => {
    const testIo = io();
    const ensureRuntime = vi.fn(async () => ({ layout: {} as never, manifest: {} as never }));
    const startDaemon = vi.fn<StartDaemon>(async () => daemonStart('http://127.0.0.1:61234'));
    const postJson = vi.fn<PostJson>(async () => ({ ok: true }));
    const runner = createManagedDaemonHttpJsonRunner({
      cliVersion: '0.2.0',
      projectDir: '/work/proj',
      installPolicy: 'auto',
      io: testIo.io,
      ensureRuntime,
      startDaemon,
      postJson,
    });

    await expect(runner('/sql/analyze-batch', { items: [] })).resolves.toEqual({ ok: true });
    await expect(runner('/sql/analyze-batch', { items: [] })).resolves.toEqual({ ok: true });

    expect(ensureRuntime).toHaveBeenCalledTimes(1);
    expect(ensureRuntime).toHaveBeenCalledWith({
      cliVersion: '0.2.0',
      installPolicy: 'auto',
      io: testIo.io,
      feature: 'core',
    });
    expect(startDaemon).toHaveBeenCalledTimes(1);
    expect(startDaemon).toHaveBeenCalledWith({
      cliVersion: '0.2.0',
      projectDir: '/work/proj',
      features: ['core'],
      force: false,
    });
    expect(postJson).toHaveBeenNthCalledWith(2, 'http://127.0.0.1:61234', '/sql/analyze-batch', { items: [] });
    expect(testIo.stderr()).toMatch(/Started ktx daemon: http:\/\/127\.0\.0\.1:61234 \(pid 1234, healthy after \d+ms\)/);
  });

  it('reports daemon reuse without reinstalling after the first request', async () => {
    const testIo = io();
    const ensureRuntime = vi.fn(async () => ({ layout: {} as never, manifest: {} as never }));
    const startDaemon = vi.fn<StartDaemon>(async () => daemonStart('http://127.0.0.1:61234', { status: 'reused' }));
    const runner = createManagedDaemonHttpJsonRunner({
      cliVersion: '0.2.0',
      projectDir: '/work/proj',
      installPolicy: 'never',
      io: testIo.io,
      ensureRuntime,
      startDaemon,
      postJson: async () => ({ ok: true }),
    });

    await runner('/sql/analyze-batch', { items: [] });
    await runner('/sql/analyze-batch', { items: [] });

    expect(ensureRuntime).toHaveBeenCalledTimes(1);
    expect(startDaemon).toHaveBeenCalledTimes(1);
    expect(testIo.stderr()).toContain('Using existing ktx daemon: http://127.0.0.1:61234 (pid 1234)');
  });

  it('sends the first request only after the started daemon passes its health check', async () => {
    const root = await makeTempDir();
    const events: string[] = [];
    let probes = 0;
    const fetch = vi.fn<ManagedPythonDaemonFetch>(async () => {
      probes += 1;
      if (probes < 3) {
        events.push('health: refused');
        throw new TypeError('fetch failed', { cause: refused(61234) });
      }
      events.push('health: ok');
      return { ok: true, status: 200, json: async () => ({ status: 'healthy', version: '0.2.0' }), text: async () => '' };
    });
    const startDaemon = vi.fn<StartDaemon>((options) =>
      startManagedPythonDaemon({
        ...options,
        runtimeRoot: join(root, 'runtime'),
        installRuntime: async () => fakeInstall(),
        spawnDaemon: () => fakeChild(4321),
        fetch,
        allocatePort: async () => 61234,
        processAlive: () => true,
        killProcess: vi.fn(),
        pollIntervalMs: 1,
      }),
    );
    const postJson = vi.fn<PostJson>(async () => {
      events.push('request');
      return { ok: true };
    });
    const runner = createManagedDaemonHttpJsonRunner(
      managedOptions({ projectDir: join(root, 'project'), startDaemon, postJson }),
    );

    await expect(runner('/sql/validate-read-only', { sql: 'select 1' })).resolves.toEqual({ ok: true });

    expect(events).toEqual(['health: refused', 'health: refused', 'health: ok', 'request']);
    expect(postJson).toHaveBeenCalledWith('http://127.0.0.1:61234', '/sql/validate-read-only', { sql: 'select 1' });
  });

  it('resolves an externally provided base URL lazily for each HTTP JSON request', async () => {
    const postJson = vi.fn(async () => ({ ok: true }));
    const runner = createManagedDaemonHttpJsonRunner({
      resolveBaseUrl: async () => 'http://127.0.0.1:61234',
      postJson,
    });

    await expect(runner('/sql/parse-table-identifier', { items: [] })).resolves.toEqual({ ok: true });

    expect(postJson).toHaveBeenCalledWith('http://127.0.0.1:61234', '/sql/parse-table-identifier', { items: [] });
  });
});

describe('managed daemon request recovery', () => {
  it('re-resolves the daemon after the cached endpoint refuses connections and retries once', async () => {
    const original = await startJsonServer();
    const replacement = await startJsonServer();
    const startDaemon = vi
      .fn<StartDaemon>()
      .mockResolvedValueOnce(daemonStart(original.baseUrl))
      .mockResolvedValueOnce(daemonStart(replacement.baseUrl));
    const runner = createManagedDaemonHttpJsonRunner(managedOptions({ startDaemon }));

    await expect(runner('/sql/validate-read-only', { sql: 'select 1' })).resolves.toEqual({ ok: true });
    await original.close();

    await expect(runner('/sql/validate-read-only', { sql: 'select 2' })).resolves.toEqual({ ok: true });
    expect(startDaemon).toHaveBeenCalledTimes(2);
    expect(original.requests).toEqual(['/sql/validate-read-only']);
    expect(replacement.requests).toEqual(['/sql/validate-read-only']);
  });

  it('retries against a healthy replacement daemon that another process recorded, without starting one', async () => {
    const root = await makeTempDir();
    const projectDir = join(root, 'project');
    const original = await startJsonServer();
    const replacement = await startJsonServer();
    await writeDaemonState(projectDir, { pid: 1111, port: original.port });
    const installRuntime = vi.fn();
    const spawnDaemon = vi.fn();
    const killProcess = vi.fn();
    const startDaemon = vi.fn<StartDaemon>((options) =>
      startManagedPythonDaemon({
        ...options,
        runtimeRoot: join(root, 'runtime'),
        installRuntime,
        spawnDaemon,
        processAlive: () => true,
        killProcess,
      }),
    );
    const runner = createManagedDaemonHttpJsonRunner(managedOptions({ projectDir, startDaemon }));

    await expect(runner('/sql/validate-read-only', { sql: 'select 1' })).resolves.toEqual({ ok: true });
    await original.close();
    const statePath = await writeDaemonState(projectDir, { pid: 2222, port: replacement.port });

    await expect(runner('/sql/validate-read-only', { sql: 'select 2' })).resolves.toEqual({ ok: true });
    expect(startDaemon).toHaveBeenCalledTimes(2);
    expect(installRuntime).not.toHaveBeenCalled();
    expect(spawnDaemon).not.toHaveBeenCalled();
    expect(killProcess).not.toHaveBeenCalled();
    expect(original.requests).toEqual(['/health', '/sql/validate-read-only']);
    expect(replacement.requests).toEqual(['/health', '/sql/validate-read-only']);
    expect(JSON.parse(await readFile(statePath, 'utf8'))).toMatchObject({ pid: 2222, port: replacement.port });
  });

  it('accepts a re-resolved daemon on the same port', async () => {
    const startDaemon = vi
      .fn<StartDaemon>()
      .mockResolvedValueOnce(daemonStart(STALE_URL, { pid: 1111 }))
      .mockResolvedValueOnce(daemonStart(STALE_URL, { pid: 2222, status: 'reused' }));
    const postJson = vi.fn<PostJson>().mockRejectedValueOnce(refused()).mockResolvedValueOnce({ ok: true });
    const runner = createManagedDaemonHttpJsonRunner(managedOptions({ startDaemon, postJson }));

    await expect(runner('/sql/validate-read-only', {})).resolves.toEqual({ ok: true });
    expect(startDaemon).toHaveBeenCalledTimes(2);
    expect(postJson.mock.calls.map(([baseUrl]) => baseUrl)).toEqual([STALE_URL, STALE_URL]);
  });

  it('shares one start across concurrent first requests from separate runners', async () => {
    const start = deferred<ManagedPythonDaemonStartResult>();
    const ensureRuntime = vi.fn(async () => ({ layout: {} as never, manifest: {} as never }));
    const startDaemon = vi.fn<StartDaemon>(() => start.promise);
    const postJson = vi.fn<PostJson>(async (baseUrl, path) => ({ baseUrl, path }));
    const first = createManagedDaemonHttpJsonRunner(managedOptions({ ensureRuntime, startDaemon, postJson }));
    const second = createManagedDaemonHttpJsonRunner(managedOptions({ ensureRuntime, startDaemon, postJson }));

    const requests = Promise.all([first('/a', {}), second('/b', {}), first('/c', {})]);
    await vi.waitFor(() => expect(startDaemon).toHaveBeenCalledTimes(1));
    start.resolve(daemonStart(STALE_URL));

    await expect(requests).resolves.toEqual([
      { baseUrl: STALE_URL, path: '/a' },
      { baseUrl: STALE_URL, path: '/b' },
      { baseUrl: STALE_URL, path: '/c' },
    ]);
    expect(ensureRuntime).toHaveBeenCalledTimes(1);
    expect(startDaemon).toHaveBeenCalledTimes(1);
  });

  it('shares one recovery when concurrent requests are refused by the same endpoint', async () => {
    const recovery = deferred<ManagedPythonDaemonStartResult>();
    const startDaemon = vi
      .fn<StartDaemon>()
      .mockResolvedValueOnce(daemonStart(STALE_URL))
      .mockImplementationOnce(() => recovery.promise);
    const postJson = vi.fn<PostJson>(async (baseUrl, path) => {
      if (baseUrl === STALE_URL) {
        throw refused();
      }
      return { baseUrl, path };
    });
    const first = createManagedDaemonHttpJsonRunner(managedOptions({ startDaemon, postJson }));
    const second = createManagedDaemonHttpJsonRunner(managedOptions({ startDaemon, postJson }));

    const requests = Promise.all([first('/a', {}), second('/b', {}), first('/c', {})]);
    await vi.waitFor(() => expect(startDaemon).toHaveBeenCalledTimes(2));
    recovery.resolve(daemonStart(REPLACEMENT_URL));

    await expect(requests).resolves.toEqual([
      { baseUrl: REPLACEMENT_URL, path: '/a' },
      { baseUrl: REPLACEMENT_URL, path: '/b' },
      { baseUrl: REPLACEMENT_URL, path: '/c' },
    ]);
    expect(startDaemon).toHaveBeenCalledTimes(2);
    expect(postJson.mock.calls.filter(([baseUrl]) => baseUrl === STALE_URL)).toHaveLength(3);
  });

  it('keeps the newer endpoint when a request to an older endpoint fails late', async () => {
    const slow = deferred<Record<string, unknown>>();
    const startDaemon = vi
      .fn<StartDaemon>()
      .mockResolvedValueOnce(daemonStart(STALE_URL))
      .mockResolvedValueOnce(daemonStart(REPLACEMENT_URL));
    let staleCalls = 0;
    const postJson = vi.fn<PostJson>(async (baseUrl, path) => {
      if (baseUrl === STALE_URL) {
        staleCalls += 1;
        if (staleCalls === 1) {
          return await slow.promise;
        }
        throw refused();
      }
      return { baseUrl, path };
    });
    const runner = createManagedDaemonHttpJsonRunner(managedOptions({ startDaemon, postJson }));

    const late = runner('/late', {});
    await vi.waitFor(() => expect(staleCalls).toBe(1));
    await expect(runner('/prompt', {})).resolves.toEqual({ baseUrl: REPLACEMENT_URL, path: '/prompt' });
    slow.reject(refused());

    await expect(late).resolves.toEqual({ baseUrl: REPLACEMENT_URL, path: '/late' });
    await expect(runner('/next', {})).resolves.toEqual({ baseUrl: REPLACEMENT_URL, path: '/next' });
    expect(startDaemon).toHaveBeenCalledTimes(2);
  });

  it('gives up after one retry when the recovered endpoint also refuses, then recovers on a later request', async () => {
    const startDaemon = vi
      .fn<StartDaemon>()
      .mockResolvedValueOnce(daemonStart(STALE_URL))
      .mockResolvedValueOnce(daemonStart(REPLACEMENT_URL))
      .mockResolvedValueOnce(daemonStart(THIRD_URL));
    const postJson = vi.fn<PostJson>(async (baseUrl) => {
      if (baseUrl === THIRD_URL) {
        return { ok: true };
      }
      throw refused();
    });
    const runner = createManagedDaemonHttpJsonRunner(managedOptions({ startDaemon, postJson }));

    const error = await runner('/sql/validate-read-only', {}).catch((value: unknown) => value);

    expect(error).toMatchObject({
      name: 'ManagedPythonDaemonUnavailableError',
      message: `ktx daemon at ${REPLACEMENT_URL} refused the connection (ECONNREFUSED) after recovering from ${STALE_URL}; giving up after 2 attempts`,
      cause: expect.objectContaining({ code: 'ECONNREFUSED', syscall: 'connect' }),
    });
    expect(postJson).toHaveBeenCalledTimes(2);
    expect(startDaemon).toHaveBeenCalledTimes(2);

    await expect(runner('/sql/validate-read-only', {})).resolves.toEqual({ ok: true });
    expect(startDaemon).toHaveBeenCalledTimes(3);
  });

  it('reports a failed recovery start with its cause without replaying the request', async () => {
    const startError = new ManagedPythonDaemonStartError(
      'ktx-daemon exited before becoming healthy (exit code 1)',
      '/work/proj/.ktx/runtime/daemon.stderr.log',
      'exited-before-ready',
    );
    const startDaemon = vi
      .fn<StartDaemon>()
      .mockResolvedValueOnce(daemonStart(STALE_URL))
      .mockRejectedValueOnce(startError)
      .mockResolvedValueOnce(daemonStart(REPLACEMENT_URL));
    const postJson = vi.fn<PostJson>(async (baseUrl) => {
      if (baseUrl === STALE_URL) {
        throw refused();
      }
      return { ok: true };
    });
    const runner = createManagedDaemonHttpJsonRunner(managedOptions({ startDaemon, postJson }));

    const error = await runner('/sql/validate-read-only', {}).catch((value: unknown) => value);

    expect(error).toMatchObject({ name: 'ManagedPythonDaemonUnavailableError', cause: startError });
    expect((error as Error).message).toContain(`ktx daemon at ${STALE_URL} refused the connection (ECONNREFUSED)`);
    expect((error as Error).message).toContain('exited before becoming healthy (exit code 1)');
    expect(postJson).toHaveBeenCalledTimes(1);

    await expect(runner('/sql/validate-read-only', {})).resolves.toEqual({ ok: true });
    expect(startDaemon).toHaveBeenCalledTimes(3);
  });

  it('does not install or retry when the runtime is unavailable during recovery', async () => {
    const denied = new Error('ktx Python runtime installation was cancelled. Run: ktx admin runtime install');
    const ensureRuntime = vi
      .fn<NonNullable<ManagedPythonCoreDaemonOptions['ensureRuntime']>>()
      .mockResolvedValueOnce({ layout: {} as never, manifest: {} as never })
      .mockRejectedValueOnce(denied);
    const startDaemon = vi.fn<StartDaemon>().mockResolvedValueOnce(daemonStart(STALE_URL));
    const postJson = vi.fn<PostJson>().mockRejectedValueOnce(refused());
    const runner = createManagedDaemonHttpJsonRunner(managedOptions({ ensureRuntime, startDaemon, postJson }));

    const error = await runner('/sql/validate-read-only', {}).catch((value: unknown) => value);

    expect(error).toMatchObject({ name: 'ManagedPythonDaemonUnavailableError', cause: denied });
    expect(startDaemon).toHaveBeenCalledTimes(1);
    expect(postJson).toHaveBeenCalledTimes(1);
  });

  it('shares a failed initial start with concurrent callers and starts again on the next request', async () => {
    const startError = new ManagedPythonDaemonStartError(
      'could not spawn ktx-daemon: spawn ENOENT',
      '/work/proj/.ktx/runtime/daemon.stderr.log',
      'spawn-failed',
    );
    const startDaemon = vi
      .fn<StartDaemon>()
      .mockRejectedValueOnce(startError)
      .mockResolvedValueOnce(daemonStart(REPLACEMENT_URL));
    const postJson = vi.fn<PostJson>(async () => ({ ok: true }));
    const runner = createManagedDaemonHttpJsonRunner(managedOptions({ startDaemon, postJson }));

    const results = await Promise.allSettled([runner('/a', {}), runner('/b', {})]);

    expect(results).toEqual([
      { status: 'rejected', reason: startError },
      { status: 'rejected', reason: startError },
    ]);
    expect(postJson).not.toHaveBeenCalled();
    await expect(runner('/c', {})).resolves.toEqual({ ok: true });
    expect(startDaemon).toHaveBeenCalledTimes(2);
  });

  const cyclic = Object.assign(new Error('outer'), { code: 'EPIPE' });
  (cyclic as Error & { cause?: unknown }).cause = new Error('inner', { cause: cyclic });

  it.each([
    ['a direct refused connect', refused()],
    ['a refused connect wrapped by fetch', new TypeError('fetch failed', { cause: refused() })],
    ['a refused connect nested two causes deep', new Error('request failed', { cause: new TypeError('fetch failed', { cause: refused() }) })],
    ['an AggregateError of refused connects', new AggregateError([refused(), refused()], 'connect failed')],
  ])('retries once after %s', async (_label, failure) => {
    const startDaemon = vi
      .fn<StartDaemon>()
      .mockResolvedValueOnce(daemonStart(STALE_URL))
      .mockResolvedValueOnce(daemonStart(REPLACEMENT_URL));
    const postJson = vi.fn<PostJson>().mockRejectedValueOnce(failure).mockResolvedValueOnce({ ok: true });
    const runner = createManagedDaemonHttpJsonRunner(managedOptions({ startDaemon, postJson }));

    await expect(runner('/sql/validate-read-only', {})).resolves.toEqual({ ok: true });
    expect(startDaemon).toHaveBeenCalledTimes(2);
    expect(postJson.mock.calls.map(([baseUrl]) => baseUrl)).toEqual([STALE_URL, REPLACEMENT_URL]);
  });

  it.each([
    ['a bare fetch failure', new TypeError('fetch failed')],
    ['a refusal message without a structured code', new Error('connect ECONNREFUSED 127.0.0.1:61001')],
    ['a connection reset', Object.assign(new Error('read ECONNRESET'), { code: 'ECONNRESET', syscall: 'read' })],
    ['a connect timeout', Object.assign(new Error('connect ETIMEDOUT'), { code: 'ETIMEDOUT', syscall: 'connect' })],
    ['a permission error', Object.assign(new Error('connect EACCES'), { code: 'EACCES', syscall: 'connect' })],
    ['a cancellation', new DOMException('This operation was aborted', 'AbortError')],
    ['a cyclic cause chain', cyclic],
    ['an AggregateError with a non-refusal', new AggregateError([refused(), new Error('connect ETIMEDOUT')], 'connect failed')],
  ])('does not re-resolve or retry after %s', async (_label, failure) => {
    const startDaemon = vi.fn<StartDaemon>(async () => daemonStart(STALE_URL));
    const postJson = vi.fn<PostJson>().mockRejectedValue(failure);
    const runner = createManagedDaemonHttpJsonRunner(managedOptions({ startDaemon, postJson }));

    await expect(runner('/sql/validate-read-only', {})).rejects.toBe(failure);
    expect(startDaemon).toHaveBeenCalledTimes(1);
    expect(postJson).toHaveBeenCalledTimes(1);
  });

  it.each([400, 401, 403, 422, 500])('does not re-resolve or retry after HTTP %i', async (status) => {
    const server = await startJsonServer((_request, response) => {
      response.statusCode = status;
      response.end('Daemon request failed: [Errno 111] ECONNREFUSED');
    });
    const startDaemon = vi.fn<StartDaemon>(async () => daemonStart(server.baseUrl));
    const runner = createManagedDaemonHttpJsonRunner(managedOptions({ startDaemon }));

    await expect(runner('/sql/validate-read-only', { sql: 'select 1' })).rejects.toThrow(
      `ktx daemon HTTP /sql/validate-read-only failed with ${status}`,
    );
    expect(startDaemon).toHaveBeenCalledTimes(1);
    expect(server.requests).toEqual(['/sql/validate-read-only']);
  });

  it.each([
    ['invalid JSON', 'not json', SyntaxError],
    ['a non-object JSON body', '[1, 2]', Error],
  ])('does not re-resolve or retry after %s', async (_label, body, errorType) => {
    const server = await startJsonServer((_request, response) => {
      response.end(body);
    });
    const startDaemon = vi.fn<StartDaemon>(async () => daemonStart(server.baseUrl));
    const runner = createManagedDaemonHttpJsonRunner(managedOptions({ startDaemon }));

    await expect(runner('/sql/validate-read-only', { sql: 'select 1' })).rejects.toBeInstanceOf(errorType);
    expect(startDaemon).toHaveBeenCalledTimes(1);
    expect(server.requests).toEqual(['/sql/validate-read-only']);
  });

  it('passes refused connections from an injected requestJson through unchanged', async () => {
    const failure = refused();
    const requestJson = vi.fn(async () => {
      throw failure;
    });
    const runner = createManagedDaemonHttpJsonRunner({ requestJson });

    await expect(runner('/sql/validate-read-only', {})).rejects.toBe(failure);
    expect(requestJson).toHaveBeenCalledTimes(1);
  });

  it('does not re-resolve or retry an externally resolved endpoint', async () => {
    const failure = refused();
    const resolveBaseUrl = vi.fn(async () => STALE_URL);
    const postJson = vi.fn<PostJson>().mockRejectedValue(failure);
    const runner = createManagedDaemonHttpJsonRunner({ resolveBaseUrl, postJson });

    await expect(runner('/sql/validate-read-only', {})).rejects.toBe(failure);
    expect(resolveBaseUrl).toHaveBeenCalledTimes(1);
    expect(postJson).toHaveBeenCalledTimes(1);
  });

  it('writes recovery diagnostics to stderr without request payloads', async () => {
    const testIo = io();
    const startDaemon = vi
      .fn<StartDaemon>()
      .mockResolvedValueOnce(daemonStart(STALE_URL, { pid: 1111, status: 'reused' }))
      .mockResolvedValueOnce(daemonStart(REPLACEMENT_URL, { pid: 2222 }));
    const postJson = vi.fn<PostJson>().mockRejectedValueOnce(refused()).mockResolvedValueOnce({ ok: true });
    const runner = createManagedDaemonHttpJsonRunner(managedOptions({ io: testIo.io, startDaemon, postJson }));

    await runner('/sql/validate-read-only', { sql: 'select secret_column from customers' });

    expect(testIo.io.stdout.write).not.toHaveBeenCalled();
    const stderr = testIo.stderr();
    expect(stderr).toContain(`Using existing ktx daemon: ${STALE_URL} (pid 1111)`);
    expect(stderr).toMatch(
      new RegExp(
        `ktx daemon at ${STALE_URL} \\(pid 1111\\) refused the connection \\(ECONNREFUSED\\) after \\d+ms; ` +
          're-resolving the daemon and retrying once\\. Daemon log: /work/proj/\\.ktx/runtime/daemon\\.stderr\\.log',
      ),
    );
    expect(stderr).toMatch(new RegExp(`Started ktx daemon: ${REPLACEMENT_URL} \\(pid 2222, healthy after \\d+ms\\)`));
    expect(stderr).toMatch(new RegExp(`Recovered ktx daemon request on ${REPLACEMENT_URL} after \\d+ms`));
    expect(stderr).not.toContain('secret_column');
  });
});

describe('ktx daemon ingest ports', () => {
  it('creates a Looker table parser backed by the ktx daemon runner', async () => {
    const requestJson = vi.fn(async () => ({
      results: {
        'model.explore': {
          ok: true,
          catalog: 'warehouse',
          schema: 'public',
          name: 'orders',
          canonical_table: 'public.orders',
        },
      },
    }));
    const parser = createManagedDaemonLookerTableIdentifierParser({ requestJson });

    await expect(
      parser.parse([{ key: 'model.explore', sql_table_name: 'public.orders', dialect: 'postgres' }]),
    ).resolves.toEqual({
      'model.explore': {
        ok: true,
        catalog: 'warehouse',
        schema: 'public',
        name: 'orders',
        canonical_table: 'public.orders',
      },
    });
    expect(requestJson).toHaveBeenCalledWith('/sql/parse-table-identifier', {
      items: [{ key: 'model.explore', sql_table_name: 'public.orders', dialect: 'postgres' }],
    });
  });

  it('creates a SQL analysis port backed by the ktx daemon runner', async () => {
    const requestJson = vi.fn(async () => ({
      fingerprint: 'select-orders',
      normalized_sql: 'SELECT * FROM public.orders WHERE id = ?',
      tables_touched: ['public.orders'],
      literal_slots: [{ position: 1, type: 'number', example_value: '42' }],
    }));
    const sqlAnalysis = createManagedDaemonSqlAnalysisPort({ requestJson });

    await expect(sqlAnalysis.analyzeForFingerprint('SELECT * FROM public.orders WHERE id = 42', 'postgres')).resolves
      .toEqual({
        fingerprint: 'select-orders',
        normalizedSql: 'SELECT * FROM public.orders WHERE id = ?',
        tablesTouched: ['public.orders'],
        literalSlots: [{ position: 1, type: 'number', exampleValue: '42' }],
      });
    expect(requestJson).toHaveBeenCalledWith('/api/sql/analyze-for-fingerprint', {
      sql: 'SELECT * FROM public.orders WHERE id = 42',
      dialect: 'postgres',
    });
  });

  it('routes SQL batch analysis through the ktx daemon runner', async () => {
    const requestJson = vi.fn(async () => ({
      results: {
        orders: {
          tables_touched: [{ catalog: null, db: 'public', name: 'orders' }],
          columns_by_clause: { select: ['status'] },
          error: null,
        },
      },
    }));
    const sqlAnalysis = createManagedDaemonSqlAnalysisPort({ requestJson });

    await expect(sqlAnalysis.analyzeBatch([{ id: 'orders', sql: 'select status from public.orders' }], 'postgres'))
      .resolves.toEqual(
        new Map([
          [
            'orders',
            {
              tablesTouched: [{ catalog: null, db: 'public', name: 'orders' }],
              columnsByClause: { select: ['status'] },
              error: null,
            },
          ],
        ]),
      );
    expect(requestJson).toHaveBeenCalledWith('/sql/analyze-batch', {
      dialect: 'postgres',
      items: [{ id: 'orders', sql: 'select status from public.orders' }],
    });
  });

  it('returns live-database daemon request options backed by the managed runner', async () => {
    const requestJson = vi.fn(async () => ({
      connection_id: 'warehouse',
      tables: [],
    }));
    const options = managedDaemonDatabaseIntrospectionOptions({ requestJson });
    expect(options.requestJson).toBeDefined();

    await expect(options.requestJson?.('/database/introspect', { connection_id: 'warehouse' })).resolves.toEqual({
      connection_id: 'warehouse',
      tables: [],
    });
    expect(requestJson).toHaveBeenCalledWith('/database/introspect', { connection_id: 'warehouse' });
  });
});
