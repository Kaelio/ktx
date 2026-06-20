import { existsSync } from 'node:fs';
import { join } from 'node:path';
import { Command, type CommandUnknownOpts, InvalidArgumentError } from '@commander-js/extra-typings';
import type { KtxCliDeps, KtxCliIo, KtxCliPackageInfo } from './cli-runtime.js';
import { SLACK_HELP_FOOTER, writeErrorCommunityHint } from './community-cta.js';
import { registerCompletionCommands } from './commands/completion-commands.js';
import { registerConnectionCommands } from './commands/connection-commands.js';
import { registerIngestCommands } from './commands/ingest-commands.js';
import { registerWikiCommands } from './commands/knowledge-commands.js';
import { registerMcpCommands } from './commands/mcp-commands.js';
import { registerSetupCommands } from './commands/setup-commands.js';
import { registerSlCommands } from './commands/sl-commands.js';
import { registerSqlCommands } from './commands/sql-commands.js';
import { registerStatusCommands } from './commands/status-commands.js';
import { registerAdminCommands } from './admin.js';
import { renderMissingProjectMessage } from './doctor.js';
import { findNearestKtxProjectDir, resolveKtxProjectDir } from './project-resolver.js';
import { profileMark, profileSpan } from './startup-profile.js';
import type { CommandOutcome } from './telemetry/index.js';
import { prepareUpdateCheckNotice, type PrepareUpdateCheckNoticeOptions } from './update-check/update-check.js';

profileMark('module:cli-program');

export interface KtxCliCommandContext {
  io: KtxCliIo;
  deps: KtxCliDeps;
  packageInfo: KtxCliPackageInfo;
  setExitCode: (code: number) => void;
  runInit: (args: { projectDir: string; force: boolean }, io: KtxCliIo) => Promise<number>;
  writeDebug?: (command: string, commandContext: CommandWithGlobalOptions) => void;
}

export interface OutputModeOptions {
  plain?: boolean;
  json?: boolean;
  viz?: boolean;
  input?: boolean;
}

interface KtxCommanderProgramOptions {
  runInit: (args: { projectDir: string; force: boolean }, io: KtxCliIo) => Promise<number>;
}

type KtxCliUpdateCheckOptions = Pick<PrepareUpdateCheckNoticeOptions, 'env' | 'fetchDistTags' | 'homeDir' | 'now'>;

export interface BuildKtxProgramOptions {
  io: KtxCliIo;
  deps: KtxCliDeps;
  packageInfo: KtxCliPackageInfo;
  runInit: (args: { projectDir: string; force: boolean }, io: KtxCliIo) => Promise<number>;
  setExitCode?: (code: number) => void;
  argv?: string[];
  setTelemetryModule?: (telemetry: typeof import('./telemetry/index.js')) => void;
  updateCheck?: KtxCliUpdateCheckOptions;
}

type CommanderExitLike = { exitCode: number; code: string; message: string };

interface KtxGlobalOptionValues {
  projectDir?: string;
  debug?: boolean;
}

type CommandPathNode = CommandWithGlobalOptions & {
  name: () => string;
  parent?: CommandPathNode | null;
};

const PROJECT_AWARE_ROOT_COMMANDS = new Set(['setup', 'connection', 'ingest', 'wiki', 'sl', 'sql', 'status', 'mcp']);
const PROJECT_INDEPENDENT_ADMIN_COMMANDS = new Set(['runtime', 'schema']);
const COMMANDS_THAT_CREATE_PROJECT = new Set(['setup', 'ktx admin init']);
const COMMANDS_WITH_OWN_MISSING_PROJECT_HANDLING = new Set(['status']);
const GLOBAL_OPTIONS_WITH_VALUE = new Set(['--project-dir']);
const GLOBAL_OPTIONS_WITHOUT_VALUE = new Set(['--debug', '--help', '-h', '--version', '-v']);

class KtxProjectMissingAbortError extends Error {
  readonly isKtxProjectMissingAbort = true;
  constructor() {
    super('ktx project missing');
  }
}

function isKtxProjectMissingAbortError(error: unknown): error is KtxProjectMissingAbortError {
  return (
    error instanceof KtxProjectMissingAbortError ||
    (typeof error === 'object' && error !== null && (error as { isKtxProjectMissingAbort?: unknown }).isKtxProjectMissingAbort === true)
  );
}
export interface CommandWithGlobalOptions {
  opts: () => object;
  optsWithGlobals?: () => object;
}

function isCommanderExit(error: unknown): error is CommanderExitLike {
  return (
    typeof error === 'object' &&
    error !== null &&
    'exitCode' in error &&
    typeof (error as { exitCode: unknown }).exitCode === 'number' &&
    'code' in error &&
    typeof (error as { code: unknown }).code === 'string'
  );
}

export function collectOption(value: string, previous: string[] = []): string[] {
  return [...previous, value];
}

export function parsePositiveIntegerOption(value: string): number {
  const parsed = Number(value);
  if (!Number.isInteger(parsed) || parsed < 1) {
    throw new InvalidArgumentError('must be a positive integer');
  }
  return parsed;
}

export function parseNonNegativeIntegerOption(value: string): number {
  const parsed = Number(value);
  if (!Number.isInteger(parsed) || parsed < 0) {
    throw new InvalidArgumentError('must be a non-negative integer');
  }
  return parsed;
}

export function parseBooleanStringOption(value: string): boolean {
  if (value === 'true') {
    return true;
  }
  if (value === 'false') {
    return false;
  }
  throw new InvalidArgumentError('must be true or false');
}

export function parseSafeConnectionIdOption(value: string): string {
  if (!/^[a-zA-Z0-9_][a-zA-Z0-9_-]*$/.test(value)) {
    throw new InvalidArgumentError(`Unsafe connection id: ${value}`);
  }
  return value;
}

export function parseNonEmptyAssignmentOption(value: string): { key: string; value: string } {
  const separatorIndex = value.indexOf('=');
  if (separatorIndex <= 0 || separatorIndex === value.length - 1) {
    throw new InvalidArgumentError('must be a non-empty <key>=<value> assignment');
  }
  return {
    key: value.slice(0, separatorIndex),
    value: value.slice(separatorIndex + 1),
  };
}

function optionsWithGlobals(command: CommandWithGlobalOptions): KtxGlobalOptionValues {
  const options = command.optsWithGlobals ? command.optsWithGlobals() : command.opts();
  const values = options as { projectDir?: unknown; debug?: unknown };
  return {
    projectDir: typeof values.projectDir === 'string' ? values.projectDir : undefined,
    debug: typeof values.debug === 'boolean' ? values.debug : undefined,
  };
}

function commandOptions(command: CommandWithGlobalOptions): Record<string, unknown> {
  return (command.optsWithGlobals ? command.optsWithGlobals() : command.opts()) as Record<string, unknown>;
}

function commandPath(command: CommandPathNode): string[] {
  const path: string[] = [];
  let current: CommandPathNode | null | undefined = command;

  while (current) {
    path.unshift(current.name());
    current = current.parent;
  }

  return path;
}

function isProjectAwareCommand(path: string[]): boolean {
  if (path.includes('__complete')) {
    return false;
  }

  const rootCommand = path[1];
  if (rootCommand === 'admin') {
    return path[2] !== undefined && !PROJECT_INDEPENDENT_ADMIN_COMMANDS.has(path[2]);
  }
  return rootCommand !== undefined && PROJECT_AWARE_ROOT_COMMANDS.has(rootCommand);
}

function shouldSuppressProjectDirLine(path: string[], options: Record<string, unknown>): boolean {
  const commandPathKey = path.join(' ');
  if (commandPathKey === 'ktx admin init') {
    return true;
  }

  if (commandPathKey === 'ktx setup') {
    return true;
  }

  if (commandPathKey === 'ktx mcp stdio') {
    return true;
  }

  if (
    commandPathKey === 'ktx status' &&
    typeof options.projectDir !== 'string' &&
    process.env.KTX_PROJECT_DIR === undefined &&
    !findNearestKtxProjectDir(process.cwd())
  ) {
    return true;
  }

  if (options.viz === true) {
    return true;
  }

  const demoIndex = path.indexOf('demo');
  if (demoIndex >= 0) {
    const demoCommand = path[demoIndex + 1];
    return (
      options.json !== true &&
      options.plain !== true &&
      (demoCommand === undefined || demoCommand === 'replay' || demoCommand === 'ingest')
    );
  }

  return false;
}

function shouldPrintProjectDir(command: CommandPathNode): boolean {
  const path = commandPath(command);
  if (!isProjectAwareCommand(path)) {
    return false;
  }

  const options = commandOptions(command);
  if (options.json === true || options.output === 'json' || options.format === 'json') {
    return false;
  }

  return !shouldSuppressProjectDirLine(path, options);
}

export function resolveCommandProjectDir(command: CommandWithGlobalOptions): string {
  return resolveKtxProjectDir({ explicitProjectDir: optionsWithGlobals(command).projectDir });
}

export function resolveCommandProjectDirOverride(command: CommandWithGlobalOptions): string | undefined {
  return optionsWithGlobals(command).projectDir ?? process.env.KTX_PROJECT_DIR;
}

function createBaseProgram(info: KtxCliPackageInfo, io: KtxCliIo): Command {
  return new Command()
    .name('ktx')
    .description('ktx data agent context layer CLI')
    .option('--project-dir <path>', 'ktx project directory (default: KTX_PROJECT_DIR, nearest ktx.yaml, or cwd)')
    .option('--debug', 'Enable diagnostic logging to stderr')
    .version(`${info.name} ${info.version}`, '-v, --version', 'Show CLI version')
    .helpOption('-h, --help', 'Show this help text')
    .configureHelp({ showGlobalOptions: true })
    .showHelpAfterError()
    .addHelpText('after', `\n${SLACK_HELP_FOOTER}`)
    .exitOverride()
    .configureOutput({
      writeOut: (chunk) => io.stdout.write(chunk),
      writeErr: (chunk) => io.stderr.write(chunk),
      outputError: (chunk, write) => write(chunk),
    });
}

function writeDebug(io: KtxCliIo, commandContext: CommandWithGlobalOptions, command: string): void {
  const global = optionsWithGlobals(commandContext);
  if (global.debug !== true) {
    return;
  }
  io.stderr.write(`[debug] projectDir=${resolveCommandProjectDir(commandContext)}\n`);
  io.stderr.write(`[debug] dispatch=${command}\n`);
}

function ktxYamlExists(projectDir: string): boolean {
  return existsSync(join(projectDir, 'ktx.yaml'));
}

function commandRendersMissingProjectMessage(path: string[]): boolean {
  if (!isProjectAwareCommand(path)) {
    return false;
  }
  const pathKey = path.join(' ');
  const rootCommand = path[1];
  if (rootCommand !== undefined && COMMANDS_THAT_CREATE_PROJECT.has(rootCommand)) {
    return false;
  }
  if (COMMANDS_THAT_CREATE_PROJECT.has(pathKey)) {
    return false;
  }
  return true;
}

function requiresExistingProject(path: string[]): boolean {
  if (!commandRendersMissingProjectMessage(path)) {
    return false;
  }
  const rootCommand = path[1];
  if (rootCommand !== undefined && COMMANDS_WITH_OWN_MISSING_PROJECT_HANDLING.has(rootCommand)) {
    return false;
  }
  return true;
}

function writeProjectDir(io: KtxCliIo, commandContext: CommandPathNode): void {
  if (!shouldPrintProjectDir(commandContext)) {
    return;
  }
  const projectDir = resolveCommandProjectDir(commandContext);
  if (commandRendersMissingProjectMessage(commandPath(commandContext)) && !ktxYamlExists(projectDir)) {
    return;
  }
  io.stderr.write(`Project: ${projectDir}\n`);
}

function ensureProjectAvailable(io: KtxCliIo, command: CommandPathNode): void {
  const path = commandPath(command);
  if (!requiresExistingProject(path)) {
    return;
  }
  const projectDir = resolveCommandProjectDir(command);
  if (ktxYamlExists(projectDir)) {
    return;
  }
  const options = commandOptions(command);
  const outputMode: 'plain' | 'json' = options.json === true ? 'json' : 'plain';
  renderMissingProjectMessage(projectDir, outputMode, io);
  throw new KtxProjectMissingAbortError();
}

function formatCliError(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function commandOutcomeForParseResult(error: unknown, exitCode: number): CommandOutcome {
  if (error) {
    return isKtxProjectMissingAbortError(error) ? 'aborted' : 'error';
  }
  return exitCode === 0 ? 'ok' : 'error';
}

function shouldAttachCommandProjectGroup(path: string[], hasProject: boolean): boolean {
  if (hasProject) {
    return true;
  }
  const rootCommand = path[1];
  const pathKey = path.join(' ');
  return (
    (rootCommand !== undefined && COMMANDS_THAT_CREATE_PROJECT.has(rootCommand)) ||
    COMMANDS_THAT_CREATE_PROJECT.has(pathKey)
  );
}

function firstTopLevelCommandToken(argv: string[]): string | null {
  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];
    if (arg === undefined) {
      continue;
    }
    if (arg === '--') {
      return null;
    }
    if (GLOBAL_OPTIONS_WITH_VALUE.has(arg)) {
      index += 1;
      continue;
    }
    if ([...GLOBAL_OPTIONS_WITH_VALUE].some((option) => arg.startsWith(`${option}=`))) {
      continue;
    }
    if (GLOBAL_OPTIONS_WITHOUT_VALUE.has(arg) || arg.startsWith('-')) {
      continue;
    }
    return arg;
  }
  return null;
}

function isKnownTopLevelCommand(program: Command, commandName: string): boolean {
  return program.commands.some((command) => command.name() === commandName || command.aliases().includes(commandName));
}

async function runBareInteractiveCommand(
  program: Command,
  io: KtxCliIo,
  context: KtxCliCommandContext,
): Promise<number> {
  const nearestProjectDir = findNearestKtxProjectDir(process.cwd());
  const envProjectDir = process.env.KTX_PROJECT_DIR;
  const runner = context.deps.setup ?? (await import('./setup.js')).runKtxSetup;

  if (!nearestProjectDir && !envProjectDir) {
    return await runner(
      {
        command: 'run',
        projectDir: resolveKtxProjectDir(),
        mode: 'auto',
        agents: false,
        agentScope: 'project',
        skipAgents: false,
        inputMode: 'auto',
        yes: false,
        cliVersion: context.packageInfo.version,
        skipLlm: false,
        skipEmbeddings: false,
        databaseSchemas: [],
        skipDatabases: false,
        skipSources: false,
      },
      io,
    );
  }

  program.outputHelp();
  return 0;
}

/** @internal */
export function collectCommandFlagsPresent(command: CommandUnknownOpts): Record<string, boolean> {
  const flags: Record<string, boolean> = {};
  let current: CommandUnknownOpts | null = command;
  while (current) {
    for (const option of current.options) {
      const key = option.attributeName();
      if (current.getOptionValueSource(key) === 'cli') {
        flags[key] = true;
      }
    }
    current = current.parent;
  }
  return flags;
}

export function buildKtxProgram(options: BuildKtxProgramOptions): Command {
  const program = createBaseProgram(options.packageInfo, options.io);
  let pendingUpdateNotice: string | null = null;

  program.hook('preAction', async (_thisCommand, actionCommand) => {
    // The hidden completion command must stay silent and side-effect free: skip
    // the telemetry notice, command span, project checks, and update checks entirely.
    if (commandPath(actionCommand as CommandPathNode).includes('__complete')) {
      return;
    }
    const commandNode = actionCommand as CommandPathNode;
    const updateCheck = await prepareUpdateCheckNotice({
      io: options.io,
      env: options.updateCheck?.env,
      fetchDistTags: options.updateCheck?.fetchDistTags,
      homeDir: options.updateCheck?.homeDir,
      installedVersion: options.packageInfo.version,
      now: options.updateCheck?.now,
      commandOptions: commandOptions(commandNode),
    });
    pendingUpdateNotice = updateCheck.notice;

    const telemetry = await import('./telemetry/index.js');
    options.setTelemetryModule?.(telemetry);
    await telemetry.showTelemetryNoticeIfNeeded(options.io, options.packageInfo);
    const path = commandPath(commandNode);
    const projectDir = resolveCommandProjectDir(commandNode);
    const hasProject = ktxYamlExists(projectDir);
    const attachProjectGroup = shouldAttachCommandProjectGroup(path, hasProject);
    telemetry.beginCommandSpan({
      commandPath: path,
      flagsPresent: collectCommandFlagsPresent(actionCommand),
      projectDir: attachProjectGroup ? projectDir : undefined,
      hasProject,
      attachProjectGroup,
      startedAt: performance.now(),
    });
    writeProjectDir(options.io, commandNode);
    ensureProjectAvailable(options.io, commandNode);
  });

  program.hook('postAction', () => {
    if (pendingUpdateNotice) {
      options.io.stderr.write(pendingUpdateNotice);
      pendingUpdateNotice = null;
    }
  });

  const context: KtxCliCommandContext = {
    io: options.io,
    deps: options.deps,
    packageInfo: options.packageInfo,
    setExitCode: options.setExitCode ?? (() => {}),
    runInit: options.runInit,
    writeDebug: (command: string, commandContext: CommandWithGlobalOptions) => {
      writeDebug(options.io, commandContext, command);
    },
  };

  registerSetupCommands(program, context);
  registerConnectionCommands(program, context);
  registerIngestCommands(program, context, {
    runTextIngest: async (textIngestArgs, ingestIo, ingestDeps) => {
      const { runKtxTextIngest } = await import('./text-ingest.js');
      return await (ingestDeps.textIngest ?? runKtxTextIngest)(textIngestArgs, ingestIo);
    },
  });
  registerWikiCommands(program, context);
  registerSlCommands(program, context);
  registerSqlCommands(program, context);
  registerStatusCommands(program, context);
  registerMcpCommands(program, context);
  registerAdminCommands(program, context);
  registerCompletionCommands(program, context);

  return program;
}

export async function runCommanderKtxCli(
  argv: string[],
  io: KtxCliIo,
  deps: KtxCliDeps,
  info: KtxCliPackageInfo,
  options: KtxCommanderProgramOptions,
): Promise<number> {
  profileMark('commander:entry');
  let exitCode = 0;
  let telemetryModule: typeof import('./telemetry/index.js') | undefined;
  const program = buildKtxProgram({
    io,
    deps,
    packageInfo: info,
    runInit: options.runInit,
    argv,
    setExitCode: (code: number) => {
      exitCode = code;
    },
    setTelemetryModule: (telemetry) => {
      telemetryModule = telemetry;
    },
  });
  profileMark('commander:program-built');
  const context: KtxCliCommandContext = {
    io,
    deps,
    packageInfo: info,
    setExitCode: (code: number) => {
      exitCode = code;
    },
    runInit: options.runInit,
    writeDebug: (command: string, commandContext: CommandWithGlobalOptions) => {
      writeDebug(io, commandContext, command);
    },
  };

  if (argv.length === 0) {
    if (io.stdout.isTTY === true) {
      try {
        return await runBareInteractiveCommand(program, io, context);
      } catch (error) {
        const telemetry = await import('./telemetry/index.js');
        await telemetry.reportException({
          error,
          context: { source: 'bare-interactive', handled: true, fatal: false },
          packageInfo: info,
          io,
        });
        io.stderr.write(`${formatCliError(error)}\n`);
        writeErrorCommunityHint(io, 'error');
        return 1;
      }
    }
    program.outputHelp();
    return 0;
  }

  const topLevelCommand = firstTopLevelCommandToken(argv);
  if (topLevelCommand && !isKnownTopLevelCommand(program, topLevelCommand)) {
    io.stderr.write(`error: unknown command '${topLevelCommand}'\n`);
    return 1;
  }

  let parseError: unknown;
  try {
    await profileSpan('commander:parseAsync', () => program.parseAsync(argv, { from: 'user' }));
  } catch (error) {
    parseError = error;
    if (isKtxProjectMissingAbortError(error)) {
      exitCode = 1;
    } else if (isCommanderExit(error)) {
      exitCode = error.exitCode === 0 ? 0 : 1;
    } else {
      io.stderr.write(`${formatCliError(error)}\n`);
      writeErrorCommunityHint(io, 'error');
      exitCode = 1;
    }
  } finally {
    if (telemetryModule) {
      const completed = telemetryModule.completeCommandSpan({
        completedAt: performance.now(),
        outcome: commandOutcomeForParseResult(parseError, exitCode),
        error: parseError,
      });
      if (
        parseError &&
        !isCommanderExit(parseError) &&
        !isKtxProjectMissingAbortError(parseError)
      ) {
        await telemetryModule.reportException({
          error: parseError,
          context: {
            source: completed?.commandPath.join(' ') ?? 'commander parseAsync',
            handled: true,
            fatal: false,
          },
          projectDir: completed?.projectGroupAttached ? completed.projectDir : undefined,
          packageInfo: info,
          io,
        });
      }
      await telemetryModule.emitCompletedCommand({ completed, packageInfo: info, io });
      await telemetryModule.shutdownTelemetryEmitter();
    }
  }

  return exitCode;
}
