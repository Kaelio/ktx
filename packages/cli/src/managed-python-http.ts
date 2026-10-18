import { request as httpRequest } from 'node:http';
import { request as httpsRequest } from 'node:https';
import { resolve as resolvePath } from 'node:path';
import { URL } from 'node:url';
import { createDaemonLookerTableIdentifierParser, type KtxDaemonTableIdentifierHttpJsonRunner } from './context/ingest/adapters/looker/daemon-table-identifier-parser.js';
import type { DaemonLiveDatabaseIntrospectionOptions, KtxDaemonDatabaseHttpJsonRunner } from './context/ingest/adapters/live-database/daemon-introspection.js';
import type { LookerTableIdentifierParser } from './context/ingest/adapters/looker/mapping.js';
import { createHttpSqlAnalysisPort, type KtxSqlAnalysisHttpJsonRunner } from './context/sql-analysis/http-sql-analysis-port.js';
import type { SqlAnalysisPort } from './context/sql-analysis/ports.js';
import type { KtxCliIo } from './cli-runtime.js';
import { writePrefixedLines } from './clack.js';
import { describeError } from './error-message.js';
import {
  ensureManagedPythonCommandRuntime,
  type KtxManagedPythonInstallPolicy,
  type ManagedPythonCommandRuntime,
} from './managed-python-command.js';
import { startManagedPythonDaemon, type ManagedPythonDaemonStartResult } from './managed-python-daemon.js';
import { managedPythonDaemonLayout } from './managed-python-runtime.js';

/** @internal */
export type ManagedPythonHttpJsonRunner = (
  path: string,
  payload: Record<string, unknown>,
) => Promise<Record<string, unknown>>;

type ManagedPythonHttpPostJson = (
  baseUrl: string,
  path: string,
  payload: Record<string, unknown>,
) => Promise<Record<string, unknown>>;

export interface ManagedPythonCoreDaemonOptions {
  cliVersion: string;
  projectDir: string;
  installPolicy: KtxManagedPythonInstallPolicy;
  io: KtxCliIo;
  ensureRuntime?: (options: {
    cliVersion: string;
    installPolicy: KtxManagedPythonInstallPolicy;
    io: KtxCliIo;
    feature: 'core';
  }) => Promise<ManagedPythonCommandRuntime>;
  startDaemon?: (options: {
    cliVersion: string;
    projectDir: string;
    features: ['core'];
    force: false;
  }) => Promise<ManagedPythonDaemonStartResult>;
}

export type ManagedPythonDaemonHttpOptions =
  | {
      requestJson: ManagedPythonHttpJsonRunner;
    }
  | {
      resolveBaseUrl: () => Promise<string>;
      postJson?: ManagedPythonHttpPostJson;
    }
  | (ManagedPythonCoreDaemonOptions & {
      postJson?: ManagedPythonHttpPostJson;
    });

function normalizedBaseUrl(baseUrl: string): string {
  return baseUrl.endsWith('/') ? baseUrl : `${baseUrl}/`;
}

function parseJsonObject(raw: string, path: string): Record<string, unknown> {
  const parsed = JSON.parse(raw) as unknown;
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
    throw new Error(`ktx daemon HTTP ${path} returned non-object JSON`);
  }
  return parsed as Record<string, unknown>;
}

async function postManagedDaemonJson(
  baseUrl: string,
  path: string,
  payload: Record<string, unknown>,
): Promise<Record<string, unknown>> {
  return await new Promise((resolve, reject) => {
    const target = new URL(path.replace(/^\//, ''), normalizedBaseUrl(baseUrl));
    const body = JSON.stringify(payload);
    const client = target.protocol === 'https:' ? httpsRequest : httpRequest;
    const request = client(
      target,
      {
        method: 'POST',
        headers: {
          accept: 'application/json',
          'content-type': 'application/json',
          'content-length': Buffer.byteLength(body),
        },
      },
      (response) => {
        const chunks: Buffer[] = [];
        response.on('data', (chunk: Buffer) => chunks.push(chunk));
        response.on('end', () => {
          const text = Buffer.concat(chunks).toString('utf8');
          const statusCode = response.statusCode ?? 0;
          if (statusCode < 200 || statusCode >= 300) {
            reject(new Error(`ktx daemon HTTP ${path} failed with ${statusCode}: ${text}`));
            return;
          }
          try {
            resolve(parseJsonObject(text, path));
          } catch (error) {
            reject(error);
          }
        });
      },
    );
    request.on('error', reject);
    request.end(body);
  });
}

class ManagedPythonDaemonUnavailableError extends Error {
  constructor(message: string, options: ErrorOptions) {
    super(message, options);
    this.name = 'ManagedPythonDaemonUnavailableError';
  }
}

interface ManagedDaemonEndpoint {
  baseUrl: string;
  pid: number;
  stderrLog: string;
  generation: number;
}

type AcquireManagedDaemon = () => Promise<ManagedPythonDaemonStartResult>;

class ManagedDaemonEndpoints {
  private current: ManagedDaemonEndpoint | undefined;
  private pending: Promise<ManagedDaemonEndpoint> | undefined;
  private generation = 0;

  resolve(acquire: AcquireManagedDaemon): Promise<ManagedDaemonEndpoint> {
    return this.current ? Promise.resolve(this.current) : this.acquireOnce(acquire);
  }

  replace(failed: ManagedDaemonEndpoint, acquire: AcquireManagedDaemon): Promise<ManagedDaemonEndpoint> {
    if (this.current && this.current.generation !== failed.generation) {
      return Promise.resolve(this.current);
    }
    this.invalidate(failed);
    return this.acquireOnce(acquire);
  }

  invalidate(failed: ManagedDaemonEndpoint): void {
    if (this.current?.generation === failed.generation) {
      this.current = undefined;
    }
  }

  private acquireOnce(acquire: AcquireManagedDaemon): Promise<ManagedDaemonEndpoint> {
    this.pending ??= acquire().then(
      (daemon) => {
        this.pending = undefined;
        this.generation += 1;
        this.current = {
          baseUrl: daemon.baseUrl,
          pid: daemon.state.pid,
          stderrLog: daemon.state.stderrLog,
          generation: this.generation,
        };
        return this.current;
      },
      (error: unknown) => {
        this.pending = undefined;
        throw error;
      },
    );
    return this.pending;
  }
}

// Keyed by lifecycle implementation and daemon state file, so every runner for one managed daemon in
// this process shares a single in-flight start or recovery. Other processes are not coordinated here.
const managedDaemonEndpoints = new WeakMap<object, Map<string, ManagedDaemonEndpoints>>();

function endpointsForDaemon(options: ManagedPythonCoreDaemonOptions): ManagedDaemonEndpoints {
  const startDaemon = options.startDaemon ?? startManagedPythonDaemon;
  const { daemonStatePath } = managedPythonDaemonLayout({ cliVersion: options.cliVersion, projectDir: options.projectDir });
  const key = `${options.cliVersion}\0${resolvePath(daemonStatePath)}`;
  let byStatePath = managedDaemonEndpoints.get(startDaemon);
  if (!byStatePath) {
    byStatePath = new Map();
    managedDaemonEndpoints.set(startDaemon, byStatePath);
  }
  let endpoints = byStatePath.get(key);
  if (!endpoints) {
    endpoints = new ManagedDaemonEndpoints();
    byStatePath.set(key, endpoints);
  }
  return endpoints;
}

function writeDiagnostic(io: KtxCliIo, line: string): void {
  writePrefixedLines((chunk) => io.stderr.write(chunk), line);
}

function elapsedMs(startedAt: number): number {
  return Math.round(performance.now() - startedAt);
}

function managedDaemonAcquirer(options: ManagedPythonCoreDaemonOptions): AcquireManagedDaemon {
  const ensureRuntime = options.ensureRuntime ?? ensureManagedPythonCommandRuntime;
  const startDaemon = options.startDaemon ?? startManagedPythonDaemon;
  return async () => {
    await ensureRuntime({
      cliVersion: options.cliVersion,
      installPolicy: options.installPolicy,
      io: options.io,
      feature: 'core',
    });
    const startedAt = performance.now();
    const daemon = await startDaemon({
      cliVersion: options.cliVersion,
      projectDir: options.projectDir,
      features: ['core'],
      force: false,
    });
    writeDiagnostic(
      options.io,
      daemon.status === 'started'
        ? `Started ktx daemon: ${daemon.baseUrl} (pid ${daemon.state.pid}, healthy after ${elapsedMs(startedAt)}ms)`
        : `Using existing ktx daemon: ${daemon.baseUrl} (pid ${daemon.state.pid})`,
    );
    return daemon;
  };
}

function isRefusedConnect(error: unknown): boolean {
  if (!error || typeof error !== 'object') {
    return false;
  }
  const { code, syscall } = error as { code?: unknown; syscall?: unknown };
  return code === 'ECONNREFUSED' && syscall === 'connect';
}

const MAX_CAUSE_DEPTH = 8;

// A refused connect proves the request never reached the daemon, so it is the only transport failure
// that is safe to retry. Resets, timeouts, and HTTP or parse errors may follow delivery.
function isConnectionRefused(error: unknown): boolean {
  const seen = new Set<unknown>();
  let current = error;
  while (current && typeof current === 'object' && !seen.has(current) && seen.size < MAX_CAUSE_DEPTH) {
    seen.add(current);
    if (isRefusedConnect(current)) {
      return true;
    }
    if (current instanceof AggregateError) {
      // net's autoSelectFamily reports one refused connect per attempted address.
      return current.errors.length > 0 && current.errors.every(isRefusedConnect);
    }
    current = (current as { cause?: unknown }).cause;
  }
  return false;
}

async function retryOnRecoveredDaemon(input: {
  endpoints: ManagedDaemonEndpoints;
  acquire: AcquireManagedDaemon;
  failed: ManagedDaemonEndpoint;
  path: string;
  payload: Record<string, unknown>;
  postJson: ManagedPythonHttpPostJson;
  io: KtxCliIo;
  startedAt: number;
}): Promise<Record<string, unknown>> {
  const { failed } = input;
  writeDiagnostic(
    input.io,
    `ktx daemon at ${failed.baseUrl} (pid ${failed.pid}) refused the connection (ECONNREFUSED) after ` +
      `${elapsedMs(input.startedAt)}ms; re-resolving the daemon and retrying once. Daemon log: ${failed.stderrLog}`,
  );
  let replacement: ManagedDaemonEndpoint;
  try {
    replacement = await input.endpoints.replace(failed, input.acquire);
  } catch (error) {
    throw new ManagedPythonDaemonUnavailableError(
      `ktx daemon at ${failed.baseUrl} refused the connection (ECONNREFUSED) and could not be recovered: ${describeError(error)}`,
      { cause: error },
    );
  }
  try {
    const result = await input.postJson(replacement.baseUrl, input.path, input.payload);
    writeDiagnostic(input.io, `Recovered ktx daemon request on ${replacement.baseUrl} after ${elapsedMs(input.startedAt)}ms`);
    return result;
  } catch (error) {
    if (!isConnectionRefused(error)) {
      throw error;
    }
    input.endpoints.invalidate(replacement);
    throw new ManagedPythonDaemonUnavailableError(
      `ktx daemon at ${replacement.baseUrl} refused the connection (ECONNREFUSED) after recovering from ` +
        `${failed.baseUrl}; giving up after 2 attempts`,
      { cause: error },
    );
  }
}

function isRequestJsonOnly(options: ManagedPythonDaemonHttpOptions): options is { requestJson: ManagedPythonHttpJsonRunner } {
  return 'requestJson' in options;
}

function isResolveBaseUrlOnly(
  options: ManagedPythonDaemonHttpOptions,
): options is { resolveBaseUrl: () => Promise<string>; postJson?: ManagedPythonHttpPostJson } {
  return 'resolveBaseUrl' in options;
}

/**
 * Runs daemon HTTP requests. Only the managed mode owns the daemon lifecycle, so only it re-resolves
 * the daemon and retries once after a refused connection; injected runners and URLs are used as-is.
 * @internal
 */
export function createManagedDaemonHttpJsonRunner(
  options: ManagedPythonDaemonHttpOptions,
): ManagedPythonHttpJsonRunner {
  if (isRequestJsonOnly(options)) {
    return options.requestJson;
  }
  const postJson = options.postJson ?? postManagedDaemonJson;
  if (isResolveBaseUrlOnly(options)) {
    const { resolveBaseUrl } = options;
    return async (path, payload) => postJson(await resolveBaseUrl(), path, payload);
  }
  const endpoints = endpointsForDaemon(options);
  const acquire = managedDaemonAcquirer(options);
  return async (path, payload) => {
    const endpoint = await endpoints.resolve(acquire);
    const startedAt = performance.now();
    try {
      return await postJson(endpoint.baseUrl, path, payload);
    } catch (error) {
      if (!isConnectionRefused(error)) {
        throw error;
      }
      return await retryOnRecoveredDaemon({
        endpoints,
        acquire,
        failed: endpoint,
        path,
        payload,
        postJson,
        io: options.io,
        startedAt,
      });
    }
  };
}

export function createManagedDaemonLookerTableIdentifierParser(
  options: ManagedPythonDaemonHttpOptions,
): LookerTableIdentifierParser {
  return createDaemonLookerTableIdentifierParser({
    baseUrl: 'http://127.0.0.1:0',
    requestJson: createManagedDaemonHttpJsonRunner(options) as KtxDaemonTableIdentifierHttpJsonRunner,
  });
}

export function createManagedDaemonSqlAnalysisPort(options: ManagedPythonDaemonHttpOptions): SqlAnalysisPort {
  return createHttpSqlAnalysisPort({
    baseUrl: 'http://127.0.0.1:0',
    requestJson: createManagedDaemonHttpJsonRunner(options) as KtxSqlAnalysisHttpJsonRunner,
  });
}

export function managedDaemonDatabaseIntrospectionOptions(
  options: ManagedPythonDaemonHttpOptions,
): Pick<DaemonLiveDatabaseIntrospectionOptions, 'requestJson'> {
  return {
    requestJson: createManagedDaemonHttpJsonRunner(options) as KtxDaemonDatabaseHttpJsonRunner,
  };
}
