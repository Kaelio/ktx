import { existsSync } from 'node:fs';
import { basename, join, resolve } from 'node:path';
import { getLatestLocalIngestStatus } from './context/ingest/local-ingest.js';
import { ingestReportOutcome, savedMemoryCountsForReport } from './context/ingest/reports.js';
import { ktxLocalStateDbPath } from './context/project/local-state-db.js';
import { loadKtxProject, type KtxLocalProject } from './context/project/project.js';
import { readKtxSetupState } from './context/project/setup-config.js';
import { getKtxCliPackageInfo, type KtxCliIo } from './cli-runtime.js';
import { SLACK_SETUP_NOTE } from './community-cta.js';
import { formatNextStepLines, formatSetupNextStepLines } from './next-steps.js';
import { runtimeInstallPolicyFromFlags } from './managed-python-command.js';
import { readManagedPythonRuntimeStatus } from './managed-python-runtime.js';
import { resolveProjectRuntimeRequirements } from './runtime-requirements.js';
import { isKtxSetupExitError } from './setup-interrupt.js';
import type { CommandOutcome } from './telemetry/index.js';
import {
  type KtxAgentScope,
  type KtxAgentTarget,
  type KtxSetupAgentsDeps,
  readKtxAgentInstallManifest,
  runKtxSetupAgentsStep,
  targetDisplayName,
} from './setup-agents.js';
import {
  type KtxSetupDatabaseDriver,
  type KtxSetupDatabasesDeps,
  runKtxSetupDatabasesStep,
} from './setup-databases.js';
import { type KtxSetupEmbeddingsDeps, runKtxSetupEmbeddingsStep } from './setup-embeddings.js';
import {
  type KtxSetupLlmBackend,
  type KtxSetupModelDeps,
  isKtxSetupLlmConfigReady,
  runKtxSetupAnthropicModelStep,
} from './setup-models.js';
import { type KtxSetupProjectDeps, runKtxSetupProjectStep } from './setup-project.js';
import {
  classifyKtxSetupCompletion,
  type KtxSetupReadyMenuDeps,
  runKtxSetupReadyMenu,
  setupHasContextTargets,
} from './setup-ready-menu.js';
import { type KtxSetupSourcesDeps, type KtxSetupSourceType, runKtxSetupSourcesStep } from './setup-sources.js';
import {
  type KtxSetupRuntimeDeps,
  type KtxSetupRuntimeResult,
  runKtxSetupRuntimeStep,
} from './setup-runtime.js';
import {
  createKtxSetupPromptAdapter,
  createKtxSetupUiAdapter,
  type KtxSetupPromptOption,
  type KtxSetupUiAdapter,
} from './setup-prompts.js';
import {
  readKtxSetupContextState,
  type KtxSetupContextDeps,
  type KtxSetupContextResult,
  runKtxSetupContextStep,
  setupContextStatusFromState,
  type KtxSetupContextStatusSummary,
} from './setup-context.js';

export interface KtxSetupStatus {
  project: { path: string; ready: boolean; name?: string };
  llm: { backend?: string; ready: boolean; model?: string };
  embeddings: { backend?: string; ready: boolean; model?: string; dimensions?: number };
  databases: Array<{ connectionId: string; ready: boolean }>;
  sources: Array<{ connectionId: string; type: string; ready: boolean }>;
  runtime: { required: boolean; ready: boolean; features: string[]; detail?: string };
  context: KtxSetupContextStatusSummary;
  agents: Array<{ target: string; scope: string; ready: boolean }>;
}

export type KtxSetupArgs =
  | {
      command: 'run';
      projectDir: string;
      mode: 'auto';
      agents: boolean;
      target?: KtxAgentTarget;
      agentScope?: KtxAgentScope;
      installRoot?: string;
      skipAgents?: boolean;
      inputMode: 'auto' | 'disabled';
      debug?: boolean;
      yes: boolean;
      cliVersion: string;
      llmBackend?: KtxSetupLlmBackend;
      anthropicApiKeyEnv?: string;
      anthropicApiKeyFile?: string;
      vertexProject?: string;
      vertexLocation?: string;
      skipLlm: boolean;
      embeddingBackend?: 'openai' | 'sentence-transformers';
      embeddingApiKeyEnv?: string;
      embeddingApiKeyFile?: string;
      skipEmbeddings: boolean;
      databaseDrivers?: KtxSetupDatabaseDriver[];
      databaseConnectionIds?: string[];
      databaseConnectionId?: string;
      databaseUrl?: string;
      databaseSchemas: string[];
      enableQueryHistory?: boolean;
      disableQueryHistory?: boolean;
      queryHistoryWindowDays?: number;
      queryHistoryMinExecutions?: number;
      queryHistoryServiceAccountPatterns?: string[];
      queryHistoryRedactionPatterns?: string[];
      skipDatabases: boolean;
      source?: KtxSetupSourceType;
      sourceConnectionId?: string;
      sourcePath?: string;
      sourceGitUrl?: string;
      sourceBranch?: string;
      sourceSubpath?: string;
      sourceAuthTokenRef?: string;
      sourceUrl?: string;
      sourceApiKeyRef?: string;
      sourceClientId?: string;
      sourceClientSecretRef?: string;
      sourceWarehouseConnectionId?: string;
      sourceProjectName?: string;
      sourceProfilesPath?: string;
      sourceTarget?: string;
      metabaseDatabaseId?: number;
      notionCrawlMode?: 'all_accessible' | 'selected_roots';
      notionRootPageIds?: string[];
      runInitialSourceIngest?: boolean;
      skipSources?: boolean;
      showEntryMenu?: boolean;
    };

export interface KtxSetupDeps {
  project?: KtxSetupProjectDeps;
  model?: (
    args: Parameters<typeof runKtxSetupAnthropicModelStep>[0],
    io: KtxCliIo,
  ) => Promise<Awaited<ReturnType<typeof runKtxSetupAnthropicModelStep>>>;
  modelDeps?: KtxSetupModelDeps;
  embeddings?: (
    args: Parameters<typeof runKtxSetupEmbeddingsStep>[0],
    io: KtxCliIo,
  ) => Promise<Awaited<ReturnType<typeof runKtxSetupEmbeddingsStep>>>;
  embeddingsDeps?: KtxSetupEmbeddingsDeps;
  databases?: (
    args: Parameters<typeof runKtxSetupDatabasesStep>[0],
    io: KtxCliIo,
  ) => Promise<Awaited<ReturnType<typeof runKtxSetupDatabasesStep>>>;
  databasesDeps?: KtxSetupDatabasesDeps;
  sources?: (
    args: Parameters<typeof runKtxSetupSourcesStep>[0],
    io: KtxCliIo,
  ) => Promise<Awaited<ReturnType<typeof runKtxSetupSourcesStep>>>;
  sourcesDeps?: KtxSetupSourcesDeps;
  runtime?: (args: Parameters<typeof runKtxSetupRuntimeStep>[0], io: KtxCliIo) => Promise<KtxSetupRuntimeResult>;
  runtimeDeps?: KtxSetupRuntimeDeps;
  agents?: (
    args: Parameters<typeof runKtxSetupAgentsStep>[0],
    io: KtxCliIo,
  ) => Promise<Awaited<ReturnType<typeof runKtxSetupAgentsStep>>>;
  agentsDeps?: KtxSetupAgentsDeps;
  context?: (args: Parameters<typeof runKtxSetupContextStep>[0], io: KtxCliIo) => Promise<KtxSetupContextResult>;
  contextDeps?: KtxSetupContextDeps;
  readyMenuDeps?: KtxSetupReadyMenuDeps;
  entryMenuDeps?: KtxSetupEntryMenuDeps;
  setupUi?: KtxSetupUiAdapter;
}

const SOURCE_DRIVERS = new Set(['dbt', 'metricflow', 'metabase', 'looker', 'lookml', 'notion']);
const KTX_DOCS_URL = 'https://docs.kaelio.com/ktx';

type KtxSetupEntryAction = 'setup' | 'new-project' | 'agents' | 'status' | 'demo' | 'exit';
type KtxSetupFlowStep = 'models' | 'embeddings' | 'databases' | 'sources' | 'runtime' | 'context' | 'agents';
type KtxSetupFlowStatus =
  | 'ready'
  | 'skipped'
  | 'back'
  | 'missing-input'
  | 'failed';
type TelemetrySetupStep =
  | 'project'
  | 'runtime'
  | 'models'
  | 'embeddings'
  | 'databases'
  | 'sources'
  | 'context'
  | 'agents'
  | 'demo-tour';

export interface KtxSetupEntryMenuPromptAdapter {
  select(options: { message: string; options: KtxSetupPromptOption[] }): Promise<string>;
  cancel(message: string): void;
}

export interface KtxSetupEntryMenuDeps {
  prompts?: KtxSetupEntryMenuPromptAdapter;
}

function createEntryMenuPromptAdapter(): KtxSetupEntryMenuPromptAdapter {
  return createKtxSetupPromptAdapter({
    selectCancelValue: 'exit',
    cancelOnSelectCancel: false,
  });
}

function setupTelemetryOutcome(
  status: KtxSetupFlowStatus | Extract<Awaited<ReturnType<typeof runKtxSetupProjectStep>>, { status: string }>['status'],
): 'completed' | 'skipped' | 'abandoned' {
  if (status === 'ready') return 'completed';
  if (status === 'skipped') return 'skipped';
  return 'abandoned';
}

interface SetupCommandAnnotation {
  outcome: CommandOutcome;
  errorClass?: string;
  errorDetail?: string;
}

/**
 * Classify a terminal non-ready setup status into the `command` telemetry
 * outcome. The setup flow is the decision-maker and knows the difference:
 * - `failed` is a genuine error; attach a step-scoped reason so the dashboard
 *   shows an actionable signature instead of a blank.
 * - `missing-input` from a *non-interactive* run is an automation error
 *   (required flags absent and no prompt was possible); attach a reason too.
 * - `missing-input` from an interactive prompt, or a project `cancelled`, is the
 *   user backing out of the wizard — an abort, not a failure. Keep it out of
 *   error telemetry so it stops inflating the error count.
 *
 * `interactive` must reflect whether a prompt could actually be shown — input
 * is enabled AND a TTY is attached. `inputMode: 'auto'` alone is not enough: a
 * piped/CI run without `--no-input` is still non-interactive, and steps such as
 * the project step return `missing-input` ("pass --yes …") there without ever
 * prompting. Treating that as an abort would make a broken automation run exit
 * 0, so it must classify as an error.
 *
 * Reasons are synthetic, step-scoped strings (no user input), so they satisfy
 * the telemetry privacy rules. The step's own `errorDetail`, when present, has
 * already been vetted for the `setup_step` event and is safe to reuse.
 */
function setupCommandOutcomeAnnotation(input: {
  status: 'failed' | 'missing-input' | 'cancelled';
  step: TelemetrySetupStep;
  interactive: boolean;
  errorDetail?: string;
}): SetupCommandAnnotation {
  if (input.status === 'failed') {
    return {
      outcome: 'error',
      errorClass: 'KtxSetupStepFailed',
      errorDetail: input.errorDetail ?? `${input.step} setup step failed`,
    };
  }
  if (input.status === 'missing-input' && !input.interactive) {
    return {
      outcome: 'error',
      errorClass: 'KtxSetupMissingInput',
      errorDetail: `${input.step} setup step requires input not provided in a non-interactive run`,
    };
  }
  return { outcome: 'aborted' };
}

/**
 * Single source of truth for how a non-ready setup step ends: the process exit
 * code and the telemetry annotation are both derived from one classification,
 * so they can never disagree. A genuine failure (`error`) exits non-zero; an
 * abort — the user leaving an interactive wizard — exits 0, matching the entry
 * menu's "Exit", a project cancellation, and a confirmed Ctrl+C.
 */
/** @internal */
export function setupTerminalOutcome(input: {
  status: 'failed' | 'missing-input' | 'cancelled';
  step: TelemetrySetupStep;
  interactive: boolean;
  errorDetail?: string;
}): { exitCode: number; annotation: SetupCommandAnnotation } {
  const annotation = setupCommandOutcomeAnnotation(input);
  return { exitCode: annotation.outcome === 'error' ? 1 : 0, annotation };
}

async function annotateSetupCommandOutcome(annotation: SetupCommandAnnotation): Promise<void> {
  const { annotateCommandOutcome } = await import('./telemetry/index.js');
  annotateCommandOutcome(annotation);
}

async function recordSetupStep(input: {
  projectDir: string;
  step: TelemetrySetupStep;
  status: KtxSetupFlowStatus | Extract<Awaited<ReturnType<typeof runKtxSetupProjectStep>>, { status: string }>['status'];
  startedAt: number;
  io: KtxCliIo;
  cliVersion?: string;
  errorDetail?: string;
}): Promise<void> {
  const { emitTelemetryEvent } = await import('./telemetry/index.js');
  await emitTelemetryEvent({
    name: 'setup_step',
    projectDir: input.projectDir,
    io: input.io,
    packageInfo: { ...getKtxCliPackageInfo(), version: input.cliVersion ?? getKtxCliPackageInfo().version },
    fields: {
      step: input.step,
      outcome: setupTelemetryOutcome(input.status),
      durationMs: Math.max(0, performance.now() - input.startedAt),
      ...(input.errorDetail ? { errorDetail: input.errorDetail } : {}),
    },
  });
}

async function runKtxSetupEntryMenu(
  status: KtxSetupStatus,
  deps: KtxSetupEntryMenuDeps = {},
): Promise<{ action: KtxSetupEntryAction }> {
  const prompts = deps.prompts ?? createEntryMenuPromptAdapter();
  const options = status.project.ready
    ? [
        { value: 'setup', label: 'Resume or change an existing setup' },
        { value: 'new-project', label: 'Create a new ktx project' },
        { value: 'agents', label: 'Connect a coding agent to ktx' },
        { value: 'status', label: 'Check setup status' },
        { value: 'demo', label: 'Explore a pre-built ktx project' },
        { value: 'exit', label: 'Exit' },
      ]
    : [
        { value: 'setup', label: 'Set up ktx for my data' },
        { value: 'status', label: 'Check setup status' },
        { value: 'demo', label: 'Explore a pre-built ktx project' },
        { value: 'exit', label: 'Exit' },
      ];
  const action = (await prompts.select({
    message: 'What do you want to do?',
    options,
  })) as KtxSetupEntryAction;
  return { action };
}

async function runKtxSetupDemoFromEntryMenu(
  args: Extract<KtxSetupArgs, { command: 'run' }>,
  io: KtxCliIo,
  deps: KtxSetupDeps,
): Promise<number> {
  const { runDemoTour } = await import('./setup-demo-tour.js');
  const startedAt = performance.now();
  const result = await runDemoTour(
    { inputMode: args.inputMode, cliVersion: args.cliVersion },
    io,
    { agents: deps.agents },
  );
  await recordSetupStep({
    projectDir: args.projectDir,
    step: 'demo-tour',
    status: result === 0 ? 'ready' : 'failed',
    startedAt,
    io,
    cliVersion: args.cliVersion,
  });
  return result;
}

function embeddingsReady(status: KtxSetupStatus['embeddings']): boolean {
  return (
    status.backend !== undefined &&
    status.backend !== 'none' &&
    typeof status.model === 'string' &&
    status.model.length > 0 &&
    typeof status.dimensions === 'number' &&
    status.dimensions > 0
  );
}

function sourceConnections(config: Awaited<ReturnType<typeof loadKtxProject>>['config']) {
  return Object.entries(config.connections)
    .filter(([, connection]) => SOURCE_DRIVERS.has(String(connection.driver ?? '').toLowerCase()))
    .map(([connectionId, connection]) => ({
      connectionId,
      type: String(connection.driver).toLowerCase(),
    }))
    .sort((left, right) => left.connectionId.localeCompare(right.connectionId));
}

type LocalIngestStatusReport = NonNullable<Awaited<ReturnType<typeof getLatestLocalIngestStatus>>>;

function reportHasSavedContext(report: LocalIngestStatusReport): boolean {
  if (ingestReportOutcome(report) === 'error') {
    return false;
  }
  const counts = savedMemoryCountsForReport(report);
  return counts.wikiCount > 0 || counts.slCount > 0;
}

async function readIngestContextStatus(project: KtxLocalProject): Promise<KtxSetupContextStatusSummary | null> {
  if (!existsSync(ktxLocalStateDbPath(project))) {
    return null;
  }
  const report = await getLatestLocalIngestStatus(project);
  if (!report || !reportHasSavedContext(report)) {
    return null;
  }
  return {
    ready: true,
    status: 'completed',
    runId: report.runId,
  };
}

export interface ReadKtxSetupStatusOptions {
  cliVersion?: string;
  env?: NodeJS.ProcessEnv;
  readRuntimeStatus?: typeof readManagedPythonRuntimeStatus;
}

export async function readKtxSetupStatus(
  projectDir: string,
  options: ReadKtxSetupStatusOptions = {},
): Promise<KtxSetupStatus> {
  const resolvedProjectDir = resolve(projectDir);
  if (!existsSync(join(resolvedProjectDir, 'ktx.yaml'))) {
    return {
      project: { path: resolvedProjectDir, ready: false },
      llm: { ready: false },
      embeddings: { ready: false },
      databases: [],
      sources: [],
      runtime: { required: false, ready: true, features: [] },
      context: setupContextStatusFromState(await readKtxSetupContextState(resolvedProjectDir)),
      agents: [],
    };
  }

  const project = await loadKtxProject({ projectDir: resolvedProjectDir });
  const llm = {
    backend: project.config.llm.provider.backend,
    ready: isKtxSetupLlmConfigReady(project.config.llm),
    model: project.config.llm.models.default,
  };

  const embeddings = {
    backend: project.config.ingest.embeddings.backend,
    ready: false,
    model: project.config.ingest.embeddings.model,
    dimensions: project.config.ingest.embeddings.dimensions,
  };
  embeddings.ready = embeddingsReady(embeddings);

  const completedSteps = (await readKtxSetupState(resolvedProjectDir)).completed_steps;
  const contextState = await readKtxSetupContextState(resolvedProjectDir);
  const setupContextStatus = setupContextStatusFromState(contextState, {
    completedStep: completedSteps.includes('context'),
  });
  const ingestContextStatus = setupContextStatus.ready ? null : await readIngestContextStatus(project);
  const databaseIds = project.config.setup?.database_connection_ids ?? Object.keys(project.config.connections);
  const databasesComplete = completedSteps.includes('databases');
  const manifest = await readKtxAgentInstallManifest(resolvedProjectDir);
  const agentMap = new Map<string, { target: string; scope: string; ready: boolean }>();
  for (const install of manifest?.installs ?? []) {
    agentMap.set(`${install.target}:${install.scope}`, {
      target: install.target,
      scope: install.scope,
      ready: true,
    });
  }
  const agents = [...agentMap.values()];
  const runtimeRequirements = resolveProjectRuntimeRequirements(project.config, {
    env: options.env ?? process.env,
  });
  let runtimeReady = runtimeRequirements.features.length === 0 || completedSteps.includes('runtime');
  let runtimeDetail: string | undefined;
  if (runtimeRequirements.features.length > 0 && options.cliVersion) {
    const readRuntimeStatus = options.readRuntimeStatus ?? readManagedPythonRuntimeStatus;
    const runtimeStatus = await readRuntimeStatus({ cliVersion: options.cliVersion, env: options.env ?? process.env });
    runtimeDetail = runtimeStatus.detail;
    runtimeReady =
      runtimeStatus.kind === 'ready' &&
      runtimeStatus.manifest !== undefined &&
      runtimeRequirements.features.every((feature) => runtimeStatus.manifest?.features.includes(feature));
  }

  return {
    project: { path: resolvedProjectDir, ready: true, name: basename(project.projectDir) || project.projectDir },
    llm,
    embeddings,
    databases: databaseIds.map((connectionId) => ({
      connectionId,
      ready: databasesComplete && Object.hasOwn(project.config.connections, connectionId),
    })),
    sources: sourceConnections(project.config).map((source) => ({
      ...source,
      ready: completedSteps.includes('sources'),
    })),
    runtime: {
      required: runtimeRequirements.features.length > 0,
      ready: runtimeReady,
      features: runtimeRequirements.features,
      ...(runtimeDetail ? { detail: runtimeDetail } : {}),
    },
    context: ingestContextStatus ?? setupContextStatus,
    agents,
  };
}

function formatReady(value: boolean): 'yes' | 'no' {
  return value ? 'yes' : 'no';
}

function formatConnectionList(ids: string[]): string {
  return ids.length > 0 ? `yes (${ids.join(', ')})` : 'no';
}

function formatContextBuilt(status: KtxSetupContextStatusSummary): string {
  if (status.ready) {
    return 'yes';
  }
  if (status.status === 'not_started') {
    return 'no';
  }
  const runSuffix = status.runId ? ` (${status.runId})` : '';
  return `${status.status.replaceAll('_', ' ')}${runSuffix}`;
}

export function formatKtxSetupStatus(status: KtxSetupStatus): string {
  if (!status.project.ready) {
    return [
      `No ktx project found at ${status.project.path}.`,
      '',
      'Check another project: ktx --project-dir <folder> status',
      'Or from that folder: ktx status',
      'Create a new ktx project here: ktx setup',
      '',
    ].join('\n');
  }

  const lines = [
    `ktx project: ${status.project.path}`,
    `Project ready: ${formatReady(status.project.ready)}`,
    `LLM ready: ${formatReady(status.llm.ready)}${status.llm.model ? ` (${status.llm.model})` : ''}`,
    `Embeddings ready: ${formatReady(status.embeddings.ready)}${
      status.embeddings.model ? ` (${status.embeddings.model})` : ''
    }`,
    `Databases configured: ${formatConnectionList(status.databases.map((database) => database.connectionId))}`,
    `Context sources configured: ${formatConnectionList(status.sources.map((source) => source.connectionId))}`,
    ...(status.runtime.required
      ? [
          `Runtime ready: ${formatReady(status.runtime.ready)}${
            status.runtime.features.length > 0 ? ` (${status.runtime.features.join(', ')})` : ''
          }`,
        ]
      : []),
    `ktx context built: ${formatContextBuilt(status.context)}`,
    `Agent integration ready: ${formatReady(status.agents.some((agent) => agent.ready))}${
      status.agents.length > 0 ? ` (${status.agents.map((agent) => `${agent.target}:${agent.scope}`).join(', ')})` : ''
    }`,
  ];
  if (!status.context.ready && status.context.status === 'failed' && status.context.detail) {
    lines.push(`Retry: ${status.context.retryCommand ?? `ktx setup --project-dir ${status.project.path}`}`);
  }

  return `${lines.join('\n')}\n`;
}

export function formatKtxSetupCompletionSummary(
  status: KtxSetupStatus,
  options: { agentNextActions?: string } = {},
): string {
  const readyAgents = status.agents.filter((agent) => agent.ready).map((agent) => targetDisplayName(agent.target));
  const lines = [
    'Project',
    `  ${status.project.path}`,
    '',
    'Context',
    `  ${status.context.ready ? 'built' : formatContextBuilt(status.context)}`,
    '',
    'Agents configured',
    `  ${readyAgents.length > 0 ? readyAgents.join(', ') : 'not installed'}`,
  ];
  const agentNextActions = options.agentNextActions?.trim();
  if (agentNextActions) {
    lines.push(
      '',
      'REQUIRED BEFORE USING AGENTS',
      '',
      ...agentNextActions.split('\n').map((line) => (line ? `  ${line}` : '')),
    );
  }
  lines.push('', agentNextActions ? 'After that, try' : 'Try it');
  lines.push('  Ask your agent: "Use ktx to show me the available tables."');
  return lines.join('\n');
}

function setupStatusReady(status: KtxSetupStatus): boolean {
  if (!status.project.ready) {
    return false;
  }
  if (!setupHasContextTargets(status)) {
    return true;
  }
  return (
    status.llm.ready &&
    embeddingsReady(status.embeddings) &&
    status.databases.every((database) => database.ready) &&
    status.sources.every((source) => source.ready) &&
    status.runtime.ready
  );
}

function setupContextReady(status: KtxSetupStatus): boolean {
  return status.context.ready;
}

function shouldPrintConciseReadySummary(status: KtxSetupStatus): boolean {
  return setupStatusReady(status) && setupContextReady(status) && status.agents.some((agent) => agent.ready);
}

function setupRuntimeInstallPolicy(args: Extract<KtxSetupArgs, { command: 'run' }>): 'prompt' | 'auto' | 'never' {
  if (args.yes) {
    return 'auto';
  }
  return runtimeInstallPolicyFromFlags({ input: args.inputMode === 'disabled' ? false : true });
}

async function commitSetupConfigChanges(projectDir: string): Promise<void> {
  const project = await loadKtxProject({ projectDir });
  await project.git.commitFile('ktx.yaml', 'setup: update ktx project config', 'ktx setup', 'setup@ktx.local');
}

export async function runKtxSetup(args: KtxSetupArgs, io: KtxCliIo, deps: KtxSetupDeps = {}): Promise<number> {
  try {
    return await runKtxSetupInner(args, io, deps);
  } catch (error) {
    if (isKtxSetupExitError(error)) {
      return 0;
    }
    throw error;
  }
}

async function runKtxSetupInner(args: KtxSetupArgs, io: KtxCliIo, deps: KtxSetupDeps = {}): Promise<number> {
  const setupUi = deps.setupUi ?? createKtxSetupUiAdapter();
  setupUi.intro('ktx setup', io);
  setupUi.note(KTX_DOCS_URL, '📚 Docs', io);
  let entryAction: KtxSetupEntryAction | undefined;
  let projectResult: Awaited<ReturnType<typeof runKtxSetupProjectStep>>;
  let agentNextActions: string | undefined;
  const canShowEntryMenu =
    args.showEntryMenu === true &&
    args.inputMode !== 'disabled' &&
    !args.agents &&
    (io.stdout.isTTY === true || deps.entryMenuDeps?.prompts !== undefined);
  // A prompt is only possible when input is enabled AND a TTY is attached. A
  // piped/CI `ktx setup` without `--no-input` is still `inputMode: 'auto'` but
  // cannot prompt, so its `missing-input` is an automation error, not an abort.
  const interactive = args.inputMode !== 'disabled' && io.stdout.isTTY === true;

  setupLoop: while (true) {
    entryAction = undefined;
    if (canShowEntryMenu) {
      const status = await readKtxSetupStatus(args.projectDir, { cliVersion: args.cliVersion });
      entryAction = (await runKtxSetupEntryMenu(status, deps.entryMenuDeps)).action;
      if (entryAction === 'exit') {
        (deps.entryMenuDeps?.prompts ?? createEntryMenuPromptAdapter()).cancel('Setup cancelled.');
        return 0;
      }
      if (entryAction === 'status') {
        io.stdout.write(formatKtxSetupStatus(status));
        return 0;
      }
      if (entryAction === 'demo') {
        return await runKtxSetupDemoFromEntryMenu(args, io, deps);
      }
    }

    const projectMode = entryAction === 'new-project' ? 'prompt-new' : args.mode;
    const projectStepStartedAt = performance.now();
    projectResult = await runKtxSetupProjectStep(
      {
        projectDir: args.projectDir,
        mode: projectMode,
        inputMode: args.inputMode,
        yes: args.yes,
        allowBack: canShowEntryMenu,
      },
      io,
      deps.project,
    );
    await recordSetupStep({
      projectDir: projectResult.projectDir,
      step: 'project',
      status: projectResult.status,
      startedAt: projectStepStartedAt,
      io,
      cliVersion: args.cliVersion,
    });

    if (projectResult.status === 'back') {
      continue;
    }

    if (projectResult.status !== 'ready') {
      const terminal = setupTerminalOutcome({
        status: projectResult.status,
        step: 'project',
        interactive,
      });
      await annotateSetupCommandOutcome(terminal.annotation);
      return terminal.exitCode;
    }

    const agentsRequested = args.agents || entryAction === 'agents';
    const currentStatus = await readKtxSetupStatus(projectResult.projectDir, { cliVersion: args.cliVersion });
    let readyAction: string | undefined;

    if (args.inputMode !== 'disabled' && !agentsRequested) {
      const completion = classifyKtxSetupCompletion(currentStatus);
      if (completion === 'ready') {
        setupUi.note(formatNextStepLines().join('\n'), 'ktx is ready', io);
        const choice = (await runKtxSetupReadyMenu(currentStatus, deps.readyMenuDeps)).action;
        if (choice === 'exit') return 0;
        readyAction = choice;
      } else if (completion === 'needs-context') {
        // Config is done; skip the re-walk and land straight on the build prompt.
        readyAction = 'context';
      } else if (completion === 'needs-agents') {
        readyAction = 'agents';
      }
      // 'incomplete' → readyAction stays undefined → run the full setup walk.
    }

    const runOnly = readyAction;
    const agentOnlySetup = agentsRequested || runOnly === 'agents';
    const shouldRunModels = !runOnly || runOnly === 'models';
    const shouldRunEmbeddings = !runOnly || runOnly === 'embeddings';
    const shouldRunDatabases = !runOnly || runOnly === 'databases';
    const shouldRunSources = !runOnly || runOnly === 'sources';
    const shouldRunRuntime =
      !agentOnlySetup && (!runOnly || runOnly === 'runtime' || runOnly === 'context');
    const shouldRunContext = !agentOnlySetup && (!runOnly || runOnly === 'context');
    const shouldRunAgents = agentsRequested || !runOnly || runOnly === 'agents';
    const showPromptInstructions = projectResult.confirmedCreation !== true;
    let skipSourcesFromDatabaseMenu = false;

    const setupSteps: KtxSetupFlowStep[] = agentOnlySetup
      ? []
      : ['models', 'embeddings', 'databases', 'sources', 'runtime', 'context'];
    if (shouldRunAgents && args.skipAgents !== true) {
      setupSteps.push('agents');
    }

    const forcePromptSteps = new Set<KtxSetupFlowStep>();
    const isNavigableSetupStep = (step: KtxSetupFlowStep): boolean => {
      if (step === 'models') return !args.skipLlm && shouldRunModels;
      if (step === 'embeddings') return !args.skipEmbeddings && shouldRunEmbeddings;
      if (step === 'databases') return !args.skipDatabases && shouldRunDatabases;
      if (step === 'sources') {
        return args.skipSources !== true && !skipSourcesFromDatabaseMenu && shouldRunSources;
      }
      if (step === 'runtime') return shouldRunRuntime;
      if (step === 'context') return shouldRunContext;
      return shouldRunAgents && args.skipAgents !== true;
    };
    const previousNavigableStepIndex = (currentIndex: number): number => {
      for (let index = currentIndex - 1; index >= 0; index -= 1) {
        const previousStep = setupSteps[index];
        if (previousStep && isNavigableSetupStep(previousStep)) {
          return index;
        }
      }
      return -1;
    };

    for (let stepIndex = 0; stepIndex < setupSteps.length; ) {
      const step = setupSteps[stepIndex];
      if (!step) break;

      const stepStartedAt = performance.now();
      let stepResult: { status: KtxSetupFlowStatus; errorDetail?: string };
      if (step === 'models') {
        const modelRunner =
          deps.model ?? ((modelArgs, modelIo) => runKtxSetupAnthropicModelStep(modelArgs, modelIo, deps.modelDeps));
        stepResult = await modelRunner(
          {
            projectDir: projectResult.projectDir,
            inputMode: args.inputMode,
            ...(args.llmBackend ? { llmBackend: args.llmBackend } : {}),
            ...(args.anthropicApiKeyEnv ? { anthropicApiKeyEnv: args.anthropicApiKeyEnv } : {}),
            ...(args.anthropicApiKeyFile ? { anthropicApiKeyFile: args.anthropicApiKeyFile } : {}),
            ...(args.vertexProject ? { vertexProject: args.vertexProject } : {}),
            ...(args.vertexLocation ? { vertexLocation: args.vertexLocation } : {}),
            forcePrompt: forcePromptSteps.has('models') || runOnly === 'models',
            showPromptInstructions,
            skipLlm: args.skipLlm || !shouldRunModels,
          },
          io,
        );
      } else if (step === 'embeddings') {
        const embeddingsRunner =
          deps.embeddings ??
          ((embeddingArgs, embeddingIo) => runKtxSetupEmbeddingsStep(embeddingArgs, embeddingIo, deps.embeddingsDeps));
        stepResult = await embeddingsRunner(
          {
            projectDir: projectResult.projectDir,
            inputMode: args.inputMode,
            cliVersion: args.cliVersion,
            runtimeInstallPolicy: setupRuntimeInstallPolicy(args),
            ...(args.embeddingBackend ? { embeddingBackend: args.embeddingBackend } : {}),
            ...(args.embeddingApiKeyEnv ? { embeddingApiKeyEnv: args.embeddingApiKeyEnv } : {}),
            ...(args.embeddingApiKeyFile ? { embeddingApiKeyFile: args.embeddingApiKeyFile } : {}),
            forcePrompt: forcePromptSteps.has('embeddings') || runOnly === 'embeddings',
            showPromptInstructions,
            skipEmbeddings: args.skipEmbeddings || !shouldRunEmbeddings,
          },
          io,
        );
      } else if (step === 'databases') {
        const databasesRunner =
          deps.databases ??
          ((databaseArgs, databaseIo) => runKtxSetupDatabasesStep(databaseArgs, databaseIo, deps.databasesDeps));
        const databaseResult = await databasesRunner(
          {
            projectDir: projectResult.projectDir,
            inputMode: args.inputMode,
            ...(args.debug !== undefined ? { debug: args.debug } : {}),
            yes: args.yes,
            cliVersion: args.cliVersion,
            runtimeInstallPolicy: setupRuntimeInstallPolicy(args),
            ...(args.databaseDrivers ? { databaseDrivers: args.databaseDrivers } : {}),
            ...(args.databaseConnectionIds ? { databaseConnectionIds: args.databaseConnectionIds } : {}),
            ...(args.databaseConnectionId ? { databaseConnectionId: args.databaseConnectionId } : {}),
            ...(args.databaseUrl ? { databaseUrl: args.databaseUrl } : {}),
            databaseSchemas: args.databaseSchemas,
            ...(args.enableQueryHistory !== undefined ? { enableQueryHistory: args.enableQueryHistory } : {}),
            ...(args.disableQueryHistory !== undefined ? { disableQueryHistory: args.disableQueryHistory } : {}),
            ...(args.queryHistoryWindowDays !== undefined ? { queryHistoryWindowDays: args.queryHistoryWindowDays } : {}),
            ...(args.queryHistoryMinExecutions !== undefined
              ? { queryHistoryMinExecutions: args.queryHistoryMinExecutions }
              : {}),
            ...(args.queryHistoryServiceAccountPatterns
              ? { queryHistoryServiceAccountPatterns: args.queryHistoryServiceAccountPatterns }
              : {}),
            ...(args.queryHistoryRedactionPatterns
              ? { queryHistoryRedactionPatterns: args.queryHistoryRedactionPatterns }
              : {}),
            skipDatabases: args.skipDatabases || !shouldRunDatabases,
          },
          io,
        );
        skipSourcesFromDatabaseMenu = databaseResult.status === 'ready' && databaseResult.skipSources === true;
        stepResult = databaseResult;
      } else if (step === 'sources') {
        const sourcesRunner =
          deps.sources ?? ((sourceArgs, sourceIo) => runKtxSetupSourcesStep(sourceArgs, sourceIo, deps.sourcesDeps));
        stepResult = await sourcesRunner(
          {
            projectDir: projectResult.projectDir,
            inputMode: args.inputMode,
            ...(args.source ? { source: args.source } : {}),
            ...(args.sourceConnectionId ? { sourceConnectionId: args.sourceConnectionId } : {}),
            ...(args.sourcePath ? { sourcePath: args.sourcePath } : {}),
            ...(args.sourceGitUrl ? { sourceGitUrl: args.sourceGitUrl } : {}),
            ...(args.sourceBranch ? { sourceBranch: args.sourceBranch } : {}),
            ...(args.sourceSubpath ? { sourceSubpath: args.sourceSubpath } : {}),
            ...(args.sourceAuthTokenRef ? { sourceAuthTokenRef: args.sourceAuthTokenRef } : {}),
            ...(args.sourceUrl ? { sourceUrl: args.sourceUrl } : {}),
            ...(args.sourceApiKeyRef ? { sourceApiKeyRef: args.sourceApiKeyRef } : {}),
            ...(args.sourceClientId ? { sourceClientId: args.sourceClientId } : {}),
            ...(args.sourceClientSecretRef ? { sourceClientSecretRef: args.sourceClientSecretRef } : {}),
            ...(args.sourceWarehouseConnectionId ? { sourceWarehouseConnectionId: args.sourceWarehouseConnectionId } : {}),
            ...(args.sourceProjectName ? { sourceProjectName: args.sourceProjectName } : {}),
            ...(args.sourceProfilesPath ? { sourceProfilesPath: args.sourceProfilesPath } : {}),
            ...(args.sourceTarget ? { sourceTarget: args.sourceTarget } : {}),
            ...(args.metabaseDatabaseId !== undefined ? { metabaseDatabaseId: args.metabaseDatabaseId } : {}),
            ...(args.notionCrawlMode ? { notionCrawlMode: args.notionCrawlMode } : {}),
            ...(args.notionRootPageIds ? { notionRootPageIds: args.notionRootPageIds } : {}),
            runInitialSourceIngest: args.runInitialSourceIngest ?? false,
            skipSources: args.skipSources === true || !shouldRunSources || skipSourcesFromDatabaseMenu,
          },
          io,
        );
      } else if (step === 'runtime') {
        const runtimeRunner =
          deps.runtime ??
          ((runtimeArgs, runtimeIo) => runKtxSetupRuntimeStep(runtimeArgs, runtimeIo, deps.runtimeDeps));
        stepResult = await runtimeRunner(
          {
            projectDir: projectResult.projectDir,
            inputMode: args.inputMode,
            cliVersion: args.cliVersion,
            runtimeInstallPolicy: setupRuntimeInstallPolicy(args),
          },
          io,
        );
      } else if (step === 'context') {
        const contextRunner =
          deps.context ??
          ((contextArgs, contextIo) => runKtxSetupContextStep(contextArgs, contextIo, deps.contextDeps));
        stepResult = await contextRunner(
          {
            projectDir: projectResult.projectDir,
            inputMode: args.inputMode,
            forcePrompt: forcePromptSteps.has('context') || runOnly === 'context',
            allowEmpty: true,
            cliVersion: args.cliVersion,
            runtimeInstallPolicy: setupRuntimeInstallPolicy(args),
          },
          io,
        );
      } else {
        const agentsRunner =
          deps.agents ?? ((agentArgs, agentIo) => runKtxSetupAgentsStep(agentArgs, agentIo, deps.agentsDeps));
        const agentResult = await agentsRunner(
          {
            projectDir: projectResult.projectDir,
            inputMode:
              args.inputMode === 'auto' && io.stdout.isTTY !== true && deps.agentsDeps?.prompts === undefined
                ? 'disabled'
                : args.inputMode,
            yes: args.yes,
            agents: true,
            ...(args.target ? { target: args.target } : {}),
            scope: args.agentScope ?? 'project',
            ...(args.installRoot ? { installRoot: args.installRoot } : {}),
            mode: 'mcp',
            skipAgents: false,
            showNextActions: agentsRequested,
          },
          io,
        );
        stepResult = agentResult;
        if (agentResult.status === 'ready') {
          agentNextActions = agentResult.nextActions;
        }
      }

      await recordSetupStep({
        projectDir: projectResult.projectDir,
        step,
        status: stepResult.status,
        startedAt: stepStartedAt,
        io,
        cliVersion: args.cliVersion,
        ...(stepResult.errorDetail ? { errorDetail: stepResult.errorDetail } : {}),
      });

      if (stepResult.status === 'failed' || stepResult.status === 'missing-input') {
        const terminal = setupTerminalOutcome({
          status: stepResult.status,
          step,
          interactive,
          ...(stepResult.errorDetail ? { errorDetail: stepResult.errorDetail } : {}),
        });
        await annotateSetupCommandOutcome(terminal.annotation);
        return terminal.exitCode;
      }
      if (stepResult.status === 'back') {
        const previousIndex = previousNavigableStepIndex(stepIndex);
        if (previousIndex < 0) {
          if (canShowEntryMenu) {
            continue setupLoop;
          }
          return 0;
        }
        const previousStep = setupSteps[previousIndex];
        if (previousStep) {
          forcePromptSteps.add(previousStep);
        }
        stepIndex = previousIndex;
        continue;
      }
      if (step === 'context' && stepResult.status !== 'ready') {
        if (shouldRunAgents && args.skipAgents !== true) {
          // Context isn't built, so skip agent install — but still reach the
          // completion screen, which states readiness and points at `ktx ingest`.
          break setupLoop;
        }
      }

      forcePromptSteps.delete(step);
      stepIndex += 1;
    }

    break;
  }

  await commitSetupConfigChanges(projectResult.projectDir);

  const status = await readKtxSetupStatus(projectResult.projectDir, { cliVersion: args.cliVersion });
  const focusedOnAgents = args.agents || entryAction === 'agents';
  if (!focusedOnAgents) {
    if (shouldPrintConciseReadySummary(status)) {
      setupUi.note(
        formatKtxSetupCompletionSummary(status, { agentNextActions }),
        agentNextActions ? 'Finish ktx agent setup' : 'ktx project ready',
        io,
        {
          format: (line) => line,
        },
      );
    } else {
      setupUi.note(formatKtxSetupStatus(status).trimEnd(), 'Project status', io, {
        format: (line) => line,
      });
      setupUi.note(
        formatSetupNextStepLines({
          setupReady: setupStatusReady(status),
          hasContextTargets: setupHasContextTargets(status),
          contextReady: setupContextReady(status),
          agentIntegrationReady: status.agents.some((agent) => agent.ready),
        }).join('\n'),
        'What you can do next',
        io,
      );
    }
  }
  setupUi.note(SLACK_SETUP_NOTE.body, SLACK_SETUP_NOTE.title, io);
  return 0;
}
