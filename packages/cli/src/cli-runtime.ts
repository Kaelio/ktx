import { createRequire } from 'node:module';

import type { KtxConnectionArgs } from './connection.js';
import type { KtxAdminReindexArgs } from './admin-reindex.js';
import type { KtxDoctorArgs } from './doctor.js';
import type { KtxKnowledgeArgs } from './knowledge.js';
import type { KtxMongoQueryArgs } from './mongo-query.js';
import type { KtxPublicIngestArgs } from './public-ingest.js';
import type { KtxRuntimeArgs } from './runtime.js';
import type { KtxSetupArgs } from './setup.js';
import type { KtxSlArgs } from './sl.js';
import type { KtxSqlArgs } from './sql.js';
import { profileMark, profileSpan } from './startup-profile.js';
import type { KtxTextIngestArgs } from './text-ingest.js';
import { assertCliVersion } from './release-version.js';
import { writeErrorCommunityHint } from './community-cta.js';

profileMark('module:cli-runtime');

const requirePackageJson = createRequire(import.meta.url);

export interface KtxCliPackageInfo {
  name: string;
  version: string;
}

export interface KtxCliIo {
  stdout: { isTTY?: boolean; columns?: number; write(chunk: string): void };
  stderr: { write(chunk: string): void };
}

export interface KtxCliDeps {
  adminReindex?: (args: KtxAdminReindexArgs, io: KtxCliIo) => Promise<number>;
  setup?: (args: KtxSetupArgs, io: KtxCliIo) => Promise<number>;
  connection?: (args: KtxConnectionArgs, io: KtxCliIo) => Promise<number>;
  doctor?: (args: KtxDoctorArgs, io: KtxCliIo) => Promise<number>;
  publicIngest?: (args: KtxPublicIngestArgs, io: KtxCliIo) => Promise<number>;
  textIngest?: (args: KtxTextIngestArgs, io: KtxCliIo) => Promise<number>;
  runtime?: (args: KtxRuntimeArgs, io: KtxCliIo) => Promise<number>;
  knowledge?: (args: KtxKnowledgeArgs, io: KtxCliIo) => Promise<number>;
  sl?: (args: KtxSlArgs, io: KtxCliIo) => Promise<number>;
  sql?: (args: KtxSqlArgs, io: KtxCliIo) => Promise<number>;
  mongoQuery?: (args: KtxMongoQueryArgs, io: KtxCliIo) => Promise<number>;
  mcp?: {
    startDaemon?: typeof import('./managed-mcp-daemon.js').startKtxMcpDaemon;
    stopDaemon?: typeof import('./managed-mcp-daemon.js').stopKtxMcpDaemon;
    readStatus?: typeof import('./managed-mcp-daemon.js').readKtxMcpDaemonStatus;
    runServer?: typeof import('./mcp-http-server.js').runKtxMcpHttpServer;
    runStdioServer?: typeof import('./mcp-stdio-server.js').runKtxMcpStdioServer;
  };
}

export function getKtxCliPackageInfo(): KtxCliPackageInfo {
  return packageInfoFromJson(requirePackageJson('../package.json'));
}

export function packageInfoFromJson(packageJson: unknown): KtxCliPackageInfo {
  if (
    typeof packageJson !== 'object' ||
    packageJson === null ||
    !('name' in packageJson) ||
    !('version' in packageJson) ||
    typeof packageJson.name !== 'string' ||
    typeof packageJson.version !== 'string'
  ) {
    throw new Error('Invalid ktx CLI package metadata');
  }

  return {
    name: packageJson.name,
    version: assertCliVersion(packageJson.version, `${packageJson.name}/package.json`),
  };
}

async function runInit(args: { projectDir: string; force: boolean }, io: KtxCliIo): Promise<number> {
  const { initKtxProject } = await import('./context/project/project.js');;
  const result = await initKtxProject({
    projectDir: args.projectDir,
    force: args.force,
  });

  io.stdout.write(`Initialized ktx project at ${result.projectDir}\n`);
  io.stdout.write(`Config: ${result.configPath}\n`);
  io.stdout.write(`Commit: ${result.commitHash ?? 'none'}\n`);
  return 0;
}

export async function runInitForCommander(
  args: { projectDir: string; force: boolean },
  io: KtxCliIo,
): Promise<number> {
  return await runInit(args, io);
}

function signalExitCode(signal: NodeJS.Signals): number {
  // 128 + signal number: SIGINT (2) -> 130, SIGTERM (15) -> 143.
  return signal === 'SIGTERM' ? 143 : 130;
}

/**
 * Flush telemetry on interrupt for the real CLI process. `capture()` is
 * fire-and-forget and the only flush guarantee lives in a `finally` a signal
 * skips, so Ctrl-C / `kill` of a long-running command (ingest, `mcp stdio`)
 * would otherwise drop its `command` event and queued events. Installed only
 * when driving the actual process; programmatic/test callers pass their own
 * `io` and never reach here. Returns a disposer that removes the listeners.
 */
function installTelemetrySignalFlush(io: KtxCliIo, info: KtxCliPackageInfo): () => void {
  let handling = false;
  const handle = (signal: NodeJS.Signals): void => {
    if (handling) {
      process.exit(signalExitCode(signal));
    }
    handling = true;
    void (async () => {
      try {
        const { emitAbortedCommandAndShutdown } = await import('./telemetry/index.js');
        await emitAbortedCommandAndShutdown({ packageInfo: info, io });
      } catch {
        // Best-effort: never let a telemetry hiccup block the interrupt exit.
      }
      process.exit(signalExitCode(signal));
    })();
  };
  const onSigint = (): void => handle('SIGINT');
  const onSigterm = (): void => handle('SIGTERM');
  process.on('SIGINT', onSigint);
  process.on('SIGTERM', onSigterm);
  return () => {
    process.off('SIGINT', onSigint);
    process.off('SIGTERM', onSigterm);
  };
}

/** @internal */
export function createGlobalExceptionReporter(io: KtxCliIo, info: KtxCliPackageInfo) {
  return async (source: 'uncaughtException' | 'unhandledRejection', error: unknown): Promise<void> => {
    const { reportException, shutdownTelemetryEmitter } = await import('./telemetry/index.js');
    await reportException({
      error,
      context: { source, handled: false, fatal: true },
      io,
      packageInfo: info,
      immediate: true,
    });
    await shutdownTelemetryEmitter();
  };
}

/** @internal */
export function writeGlobalExceptionToStderr(io: KtxCliIo, error: unknown): void {
  if (error instanceof Error && error.stack) {
    io.stderr.write(`${error.stack}\n`);
  } else {
    io.stderr.write(`${String(error)}\n`);
  }
  writeErrorCommunityHint(io, 'crash');
}

export function installGlobalExceptionHandlers(io: KtxCliIo, info: KtxCliPackageInfo): () => void {
  const report = createGlobalExceptionReporter(io, info);
  const handle = (source: 'uncaughtException' | 'unhandledRejection', error: unknown): void => {
    void (async () => {
      try {
        await report(source, error);
      } catch {
        // Best-effort: preserve Node's process termination behavior.
      }
      writeGlobalExceptionToStderr(io, error);
      process.exit(1);
    })();
  };
  const onUncaught = (error: Error): void => handle('uncaughtException', error);
  const onUnhandled = (reason: unknown): void => handle('unhandledRejection', reason);
  process.on('uncaughtException', onUncaught);
  process.on('unhandledRejection', onUnhandled);
  return () => {
    process.off('uncaughtException', onUncaught);
    process.off('unhandledRejection', onUnhandled);
  };
}

export async function runKtxCli(
  argv = process.argv.slice(2),
  io: KtxCliIo = process,
  deps: KtxCliDeps = {},
): Promise<number> {
  const info = getKtxCliPackageInfo();
  profileMark('runtime:runKtxCli');
  const { runCommanderKtxCli } = await profileSpan('import ./cli-program.js', () => import('./cli-program.js'));

  // Real-process entry only: flush telemetry if interrupted. Test/programmatic
  // callers pass their own `io`, so they never install process-level handlers.
  const removeSignalFlush = (io as unknown) === process ? installTelemetrySignalFlush(io, info) : undefined;
  const removeGlobalExceptionHandlers =
    (io as unknown) === process ? installGlobalExceptionHandlers(io, info) : undefined;
  try {
    return await runCommanderKtxCli(argv, io, deps, info, {
      runInit: runInitForCommander,
    });
  } finally {
    removeGlobalExceptionHandlers?.();
    removeSignalFlush?.();
  }
}
