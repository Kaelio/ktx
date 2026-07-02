import { stat as statAsync, readdir as readdirAsync } from 'node:fs/promises';
import { basename, join } from 'node:path';
import { runClaudeCodeAuthProbe } from './context/llm/claude-code-runtime.js';
import {
  CODEX_ISOLATION_WARNING,
  CODEX_ISOLATION_WARNING_FIX,
} from './context/llm/codex-isolation.js';
import { runCodexAuthProbe } from './context/llm/codex-runtime.js';
import type { KtxConfigIssue, KtxProjectConfig, KtxProjectConnectionConfig, KtxProjectEmbeddingConfig, KtxProjectLlmConfig } from './context/project/config.js';
import type { KtxLocalProject } from './context/project/project.js';
import { ktxLocalStateDbPath } from './context/project/local-state-db.js';
import { listReferencedConnectionIds } from './context/wiki/local-knowledge.js';
import {
  isQueryHistoryEnabled,
  queryHistoryDialectForConnection,
} from './context/ingest/adapters/historic-sql/connection-dialect.js';
import {
  historicSqlProbeCatalogName,
  runHistoricSqlReadinessProbe,
  type HistoricSqlReadinessProbe,
} from './context/ingest/historic-sql-probes.js';
import {
  formatClaudeCodePromptCachingFix,
  formatClaudeCodePromptCachingWarning,
  ignoredClaudeCodePromptCachingFields,
} from './claude-code-prompt-caching.js';
import type { DoctorCheck } from './doctor.js';
import {
  bold as _bold,
  dim as _dim,
  green,
  red,
  yellow,
} from './io/symbols.js';
import { KTX_NEXT_STEP_DIRECT_COMMANDS } from './next-steps.js';

type ProjectStatusLevel = 'ok' | 'warn' | 'fail' | 'skipped';
type ProjectVerdict = 'ready' | 'partial' | 'blocked';

interface ProjectStatusLine {
  status: ProjectStatusLevel;
  detail: string;
  fix?: string;
}

interface LlmStatus extends ProjectStatusLine {
  backend: string;
  model?: string;
}

interface EmbeddingsStatus extends ProjectStatusLine {
  backend: string;
  model?: string;
  dimensions?: number;
}

interface ConnectionStatus extends ProjectStatusLine {
  name: string;
  driver: string;
}

interface QueryHistoryStatus extends ProjectStatusLine {
  connection: string;
  driver: string;
  dialect: string;
}

interface PipelineStatus {
  adapters: string[];
  enrichmentMode: string;
  relationshipsEnabled: boolean;
  relationshipsLlmProposals: boolean;
  relationshipsValidationRequired: boolean;
  agentEnabled: boolean;
  agentTools: string[];
  agentMaxIterations: number;
}

interface StorageStatus {
  state: string;
  search: string;
  gitAuthor: string;
}

interface ConfigStatus {
  status: ProjectStatusLevel;
  detail: string;
  issues: KtxConfigIssue[];
}

interface WarningItem {
  message: string;
  fix?: string;
}

type ClaudeCodeAuthProbe = (input: {
  projectDir: string;
  model: string;
  env?: NodeJS.ProcessEnv;
}) => Promise<{ ok: true } | { ok: false; message: string }>;

type CodexAuthProbe = (input: {
  projectDir: string;
  model: string;
}) => Promise<{ ok: true } | { ok: false; message: string; fix: string }>;

const PROJECT_READY_COMMANDS = KTX_NEXT_STEP_DIRECT_COMMANDS.map((step) => step.command);

interface LocalStatsIngestPerConnection {
  connectionId: string;
  adapter: string;
  lastCompletedAt: string;
  skippedObjects: Array<{ name: string; reason: string }>;
}

interface LocalStatsSemanticLayerEntry {
  connectionId: string;
  sourceCount: number;
  embeddedSourceCount: number;
  dictionaryValueCount: number;
}

interface LocalStatsWikiEntry {
  scope: string;
  count: number;
  embeddedCount: number;
}

interface LocalStatsProjectDir {
  dbSqliteBytes: number | null;
  ktxCacheBytes: number;
  rawSources: { fileCount: number; bytes: number };
}

/** @internal */
export interface LocalStatsStatus {
  ingest: {
    totalCompletedRuns: number;
    perConnection: LocalStatsIngestPerConnection[];
  };
  wikiPages: LocalStatsWikiEntry[];
  semanticLayer: LocalStatsSemanticLayerEntry[];
  projectDir: LocalStatsProjectDir;
  unavailable?: string;
}

export interface ProjectStatus {
  projectName: string;
  projectDir: string;
  config: ConfigStatus;
  llm: LlmStatus;
  embeddings: EmbeddingsStatus;
  storage: StorageStatus;
  connections: ConnectionStatus[];
  queryHistory: QueryHistoryStatus[];
  pipeline: PipelineStatus;
  warnings: WarningItem[];
  localStats: LocalStatsStatus;
  verdict: ProjectVerdict;
  verdictReason: string;
  nextActions: string[];
  promptCaching?: { enabled: boolean; systemTtl?: string; toolsTtl?: string; historyTtl?: string };
  workUnits?: { stepBudget: number; maxConcurrency: number; failureMode: string };
  relationshipsDetail?: {
    acceptThreshold: number;
    reviewThreshold: number;
    maxLlmTablesPerBatch: number;
    validationConcurrency: number;
  };
}

function resolveRef(value: unknown, env: NodeJS.ProcessEnv): { resolved: string; via: 'literal' | 'env' | 'file' | 'missing' } {
  if (typeof value !== 'string') return { resolved: '', via: 'missing' };
  const trimmed = value.trim();
  if (trimmed.length === 0) return { resolved: '', via: 'missing' };
  if (trimmed.startsWith('env:')) {
    const name = trimmed.slice(4).trim();
    const v = env[name];
    return v && v.trim().length > 0 ? { resolved: v, via: 'env' } : { resolved: '', via: 'missing' };
  }
  if (trimmed.startsWith('file:')) {
    return { resolved: trimmed.slice(5), via: 'file' };
  }
  return { resolved: trimmed, via: 'literal' };
}

function failureDetail(error: unknown): string {
  if (error instanceof Error && error.message.trim().length > 0) {
    return error.message.trim().split('\n')[0] ?? error.message.trim();
  }
  return String(error);
}

function envHint(value: unknown): string | undefined {
  if (typeof value === 'string' && value.trim().startsWith('env:')) {
    return value.trim().slice(4).trim();
  }
  return undefined;
}

async function buildLlmStatus(
  config: KtxProjectLlmConfig,
  options: {
    projectDir: string;
    env: NodeJS.ProcessEnv;
    claudeCodeAuthProbe?: ClaudeCodeAuthProbe;
    codexAuthProbe?: CodexAuthProbe;
    fast?: boolean;
    useSpinner?: boolean;
  },
): Promise<LlmStatus> {
  const env = options.env;
  const backend = config.provider.backend;
  const model = config.models?.default;
  if (backend === 'none') {
    return {
      backend,
      model,
      status: 'fail',
      detail: 'no LLM configured; research agent will not run',
      fix: 'Run: ktx setup (choose an LLM provider)',
    };
  }
  // The runtime (resolveModelSlots) hard-requires llm.models.default for every
  // non-none backend; without it ingest/scan/memory throw. Report that here so
  // status never marks a project ready that the runtime would refuse to run.
  if (!model || model.trim().length === 0) {
    return {
      backend,
      model,
      status: 'fail',
      detail: `llm.models.default is required for backend "${backend}"`,
      fix: 'Set llm.models.default in ktx.yaml, then rerun `ktx status` (or rerun `ktx setup`).',
    };
  }
  if (backend === 'anthropic') {
    const ref = config.provider.anthropic?.api_key;
    const resolved = resolveRef(ref, env);
    if (resolved.resolved.length > 0) {
      return { backend, model, status: 'ok', detail: `key set${resolved.via === 'env' ? ` (env)` : ''}` };
    }
    if (env.ANTHROPIC_API_KEY && env.ANTHROPIC_API_KEY.trim().length > 0) {
      return { backend, model, status: 'ok', detail: 'key set (env: ANTHROPIC_API_KEY)' };
    }
    const hint = envHint(ref);
    return {
      backend,
      model,
      status: 'warn',
      detail: hint ? `key missing (env: ${hint})` : 'key missing',
      fix: hint ? `Set ${hint}` : 'Set ANTHROPIC_API_KEY or rerun `ktx setup`',
    };
  }
  if (backend === 'vertex') {
    const project = config.provider.vertex?.project;
    if (project && project.length > 0) {
      return { backend, model, status: 'ok', detail: `project=${project}` };
    }
    return { backend, model, status: 'warn', detail: 'vertex project not configured', fix: 'Rerun `ktx setup`' };
  }
  if (backend === 'gateway') {
    const ref = config.provider.gateway?.api_key;
    const resolved = resolveRef(ref, env);
    if (resolved.resolved.length > 0) {
      return { backend, model, status: 'ok', detail: 'key set' };
    }
    const hint = envHint(ref);
    return {
      backend,
      model,
      status: 'warn',
      detail: hint ? `key missing (env: ${hint})` : 'key missing',
      fix: hint ? `Set ${hint}` : 'Set the gateway api_key or rerun `ktx setup`',
    };
  }
  if (backend === 'claude-code') {
    const modelName = model;
    if (options.fast === true) {
      return {
        backend,
        model: modelName,
        status: 'skipped',
        detail: 'auth probe skipped (--fast)',
      };
    }
    const probe = options.claudeCodeAuthProbe ?? runClaudeCodeAuthProbe;
    const auth = await withSpinner(options.useSpinner === true, 'Probing Claude Code authentication', () =>
      probe({ projectDir: options.projectDir, model: modelName, env }),
    );
    if (auth.ok) {
      return {
        backend,
        model: modelName,
        status: 'ok',
        detail: 'local Claude Code session authenticated',
      };
    }
    return {
      backend,
      model: modelName,
      status: 'fail',
      detail: auth.message,
      fix: 'Authenticate Claude Code locally with the Claude Code CLI, then rerun `ktx status`.',
    };
  }
  if (backend === 'codex') {
    const modelName = model;
    if (options.fast === true) {
      return {
        backend,
        model: modelName,
        status: 'skipped',
        detail: 'auth probe skipped (--fast)',
      };
    }
    const probe = options.codexAuthProbe ?? runCodexAuthProbe;
    const auth = await withSpinner(options.useSpinner === true, 'Probing Codex authentication', () =>
      probe({ projectDir: options.projectDir, model: modelName }),
    );
    if (auth.ok) {
      return {
        backend,
        model: modelName,
        status: 'ok',
        detail: 'local Codex session authenticated',
      };
    }
    return {
      backend,
      model: modelName,
      status: 'fail',
      detail: auth.message,
      fix: auth.fix,
    };
  }
  return { backend, model, status: 'warn', detail: 'unknown LLM backend' };
}

function buildEmbeddingsStatus(config: KtxProjectEmbeddingConfig, env: NodeJS.ProcessEnv): EmbeddingsStatus {
  const backend = config.backend;
  const model = config.model;
  const dimensions = config.dimensions;
  if (backend === 'none') {
    return {
      backend,
      model,
      dimensions,
      status: 'warn',
      detail: 'disabled — semantic search will be skipped',
    };
  }
  if (backend === 'openai') {
    const ref = config.openai?.api_key;
    const resolved = resolveRef(ref, env);
    if (resolved.resolved.length > 0 || (env.OPENAI_API_KEY && env.OPENAI_API_KEY.trim().length > 0)) {
      return { backend, model, dimensions, status: 'ok', detail: 'key set' };
    }
    const hint = envHint(ref);
    return {
      backend,
      model,
      dimensions,
      status: 'warn',
      detail: hint ? `key missing (env: ${hint})` : 'key missing',
      fix: hint ? `Set ${hint}` : 'Set OPENAI_API_KEY or rerun `ktx setup`',
    };
  }
  if (backend === 'sentence-transformers') {
    const url = config.sentenceTransformers?.base_url;
    if (typeof url === 'string' && url.length > 0) {
      return { backend, model, dimensions, status: 'ok', detail: `service: ${url}` };
    }
    return {
      backend,
      model,
      dimensions,
      status: 'ok',
      detail: 'managed local embeddings daemon',
    };
  }
  return { backend, model, dimensions, status: 'warn', detail: 'unknown embedding backend' };
}

function buildConnectionStatus(
  name: string,
  conn: KtxProjectConnectionConfig,
  env: NodeJS.ProcessEnv,
): ConnectionStatus {
  const driver = (conn.driver ?? 'unknown').toLowerCase();
  const ok = (detail: string): ConnectionStatus => ({ name, driver, status: 'ok', detail });
  const warn = (detail: string, fix?: string): ConnectionStatus => ({ name, driver, status: 'warn', detail, fix });

  switch (driver) {
    case 'postgres':
    case 'mysql':
    case 'clickhouse':
    case 'sqlserver': {
      const urlRef = resolveRef(conn.url, env);
      if (urlRef.resolved.length > 0) return ok(`url configured`);
      if (typeof (conn as Record<string, unknown>).host === 'string') return ok('host configured');
      const hint = envHint(conn.url);
      return warn(hint ? `url missing (env: ${hint})` : 'url not set', hint ? `Set ${hint}` : 'Rerun `ktx setup`');
    }
    case 'snowflake': {
      const account = (conn as Record<string, unknown>).account;
      if (typeof account === 'string' && account.length > 0) return ok(`account: ${account}`);
      return warn('account not set', 'Rerun `ktx setup`');
    }
    case 'bigquery': {
      const cred = resolveRef((conn as Record<string, unknown>).credentials_json, env);
      if (cred.resolved.length > 0) return ok('credentials configured');
      const hint = envHint((conn as Record<string, unknown>).credentials_json);
      return warn(hint ? `credentials missing (env: ${hint})` : 'credentials not set', hint ? `Set ${hint}` : 'Rerun `ktx setup`');
    }
    case 'duckdb':
    case 'sqlite': {
      const path = (conn as Record<string, unknown>).path;
      if (typeof path === 'string' && path.length > 0) return ok(`path: ${path}`);
      return warn('path not set', 'Rerun `ktx setup`');
    }
    case 'notion': {
      const tokenRef =
        (conn as Record<string, unknown>).auth_token_ref ??
        (conn as Record<string, unknown>).auth_token;
      const resolved = resolveRef(tokenRef, env);
      if (resolved.resolved.length > 0) return ok('auth token configured');
      const hint = envHint(tokenRef);
      return warn(hint ? `auth token missing (env: ${hint})` : 'auth token not set', hint ? `Set ${hint}` : 'Rerun `ktx setup`');
    }
    case 'dbt':
    case 'dbt-core':
    case 'dbt-cloud': {
      const repoUrl =
        (conn as Record<string, unknown>).repoUrl ??
        (conn as Record<string, unknown>).repo_url;
      if (typeof repoUrl === 'string' && repoUrl.length > 0) return ok(`repo: ${repoUrl}`);
      return warn('repoUrl not set', 'Rerun `ktx setup`');
    }
    case 'metabase': {
      const url = (conn as Record<string, unknown>).api_url;
      if (typeof url === 'string' && url.length > 0) return ok(`url: ${url}`);
      return warn('api_url not set', 'Rerun `ktx setup`');
    }
    case 'looker':
    case 'lookml': {
      const url = (conn as Record<string, unknown>).base_url ?? (conn as Record<string, unknown>).url;
      if (typeof url === 'string' && url.length > 0) return ok(`url: ${url}`);
      return warn('base_url not set', 'Rerun `ktx setup`');
    }
    case 'metricflow': {
      const repoUrl = (conn as Record<string, unknown>).repoUrl ?? (conn as Record<string, unknown>).repo_url;
      if (typeof repoUrl === 'string' && repoUrl.length > 0) return ok(`repo: ${repoUrl}`);
      return warn('repoUrl not set', 'Rerun `ktx setup`');
    }
    default:
      return { name, driver, status: 'ok', detail: 'configured' };
  }
}

async function buildQueryHistoryStatus(
  project: KtxLocalProject,
  options: BuildProjectStatusOptions,
): Promise<QueryHistoryStatus[]> {
  const targets = Object.entries(project.config.connections)
    .filter(([, connection]) => isQueryHistoryEnabled(connection))
    .sort(([left], [right]) => left.localeCompare(right));

  const probe = options.queryHistoryReadinessProbe ?? runHistoricSqlReadinessProbe;
  const env = options.env ?? process.env;
  const statuses: QueryHistoryStatus[] = [];

  for (const [connectionId, connection] of targets) {
    const driver = String(connection.driver ?? 'unknown').toLowerCase();
    const dialect = queryHistoryDialectForConnection(connection);

    if (!dialect) {
      statuses.push({
        connection: connectionId,
        driver,
        dialect: driver,
        status: 'fail',
        detail: `query history is not supported for driver "${driver}"`,
        fix: `Disable connections.${connectionId}.context.queryHistory, or use a postgres, snowflake, or bigquery connection`,
      });
      continue;
    }

    const catalogName = historicSqlProbeCatalogName(dialect);

    if (options.fast === true) {
      statuses.push({
        connection: connectionId,
        driver,
        dialect,
        status: 'skipped',
        detail: `${catalogName} probe skipped (--fast)`,
      });
      continue;
    }

    const outcome = await withSpinner(
      options.useSpinner === true,
      `Probing ${catalogName} on ${connectionId}`,
      () =>
        probe({
          projectDir: project.projectDir,
          connectionId,
          connection,
          env,
        }),
    );

    if (!outcome) {
      statuses.push({
        connection: connectionId,
        driver,
        dialect: driver,
        status: 'fail',
        detail: `query history is not supported for driver "${driver}"`,
        fix: `Disable connections.${connectionId}.context.queryHistory, or use a postgres, snowflake, or bigquery connection`,
      });
      continue;
    }

    if (outcome.ok) {
      const { detail, warnings } = outcome.runner.formatSuccessDetail(outcome.result);
      statuses.push({
        connection: connectionId,
        driver,
        dialect,
        status: warnings.length > 0 ? 'warn' : 'ok',
        detail,
        ...(dialect === 'postgres' && warnings.length > 0
          ? {
              fix: `Update the Postgres parameter group or config, then rerun \`ktx status --project-dir ${project.projectDir}\``,
            }
          : {}),
      });
      continue;
    }

    const advice = outcome.runner.fixAdvice(outcome.error);
    statuses.push({
      connection: connectionId,
      driver,
      dialect,
      status: 'fail',
      detail: advice.failHeadline,
      fix: advice.remediation,
    });
  }

  return statuses;
}

const ADAPTER_DRIVER_REQUIREMENT: Record<string, string[]> = {
  'live-database': ['postgres', 'mysql', 'snowflake', 'bigquery', 'clickhouse', 'sqlite', 'duckdb', 'sqlserver'],
  dbt: ['dbt', 'dbt-core', 'dbt-cloud'],
  notion: ['notion'],
  metabase: ['metabase'],
  looker: ['looker', 'lookml'],
  lookml: ['looker', 'lookml'],
  metricflow: ['metricflow'],
};

function buildPipelineStatus(config: KtxProjectConfig): PipelineStatus {
  return {
    adapters: config.ingest.adapters,
    enrichmentMode: config.scan.enrichment.mode,
    relationshipsEnabled: config.scan.relationships.enabled,
    relationshipsLlmProposals: config.scan.relationships.llmProposals,
    relationshipsValidationRequired: config.scan.relationships.validationRequiredForManifest,
    agentEnabled: config.agent.run_research.enabled,
    agentTools: config.agent.run_research.default_toolset,
    agentMaxIterations: config.agent.run_research.max_iterations,
  };
}

function buildStorageStatus(config: KtxProjectConfig): StorageStatus {
  return {
    state: config.storage.state,
    search: config.storage.search,
    gitAuthor: config.storage.git.author,
  };
}

/**
 * Warn (never fail) when stored wiki pages reference connection ids that are no
 * longer in `ktx.yaml`. Config and page content evolve independently, so a
 * dangling reference is a soft condition — the pages still load, search, and
 * read; it just signals a typo or a removed connection.
 */
async function buildUnknownConnectionWarning(project: KtxLocalProject): Promise<WarningItem | null> {
  let referenced: string[];
  try {
    referenced = await listReferencedConnectionIds(project);
  } catch {
    return null;
  }
  const unknown = referenced.filter((id) => !Object.hasOwn(project.config.connections, id));
  if (unknown.length === 0) {
    return null;
  }
  return {
    message: `Wiki pages reference connection id(s) not in ktx.yaml: ${unknown.join(', ')}. Those pages still load and search.`,
    fix: 'Add the connection(s) via `ktx setup`, or update the pages’ `connections` frontmatter.',
  };
}

function buildWarnings(
  config: KtxProjectConfig,
  connections: ConnectionStatus[],
  llm: LlmStatus,
  embeddings: EmbeddingsStatus,
): WarningItem[] {
  const warnings: WarningItem[] = [];

  for (const adapter of config.ingest.adapters) {
    const requiredDrivers = ADAPTER_DRIVER_REQUIREMENT[adapter];
    if (!requiredDrivers) continue;
    const hasMatching = connections.some((c) => requiredDrivers.includes(c.driver));
    if (!hasMatching) {
      warnings.push({
        message: `Adapter "${adapter}" is enabled but no connection of type ${requiredDrivers.slice(0, 2).join('/')} is configured.`,
        fix: 'Rerun `ktx setup` to add a connection, or remove the adapter from ingest.adapters.',
      });
    }
  }

  if (config.agent.run_research.enabled && llm.backend === 'none') {
    warnings.push({
      message: 'Research agent is enabled but LLM is not configured.',
      fix: 'Set up an LLM provider via `ktx setup` or disable agent.run_research.enabled.',
    });
  }

  if (embeddings.backend === 'none' && config.ingest.adapters.includes('live-database')) {
    warnings.push({
      message: 'Semantic search is off (embeddings backend = none). Lexical/dictionary lanes still work.',
    });
  }

  const warning = formatClaudeCodePromptCachingWarning(ignoredClaudeCodePromptCachingFields(config.llm));
  if (warning) {
    warnings.push({
      message: warning,
      fix: formatClaudeCodePromptCachingFix(),
    });
  }

  if (llm.backend === 'codex') {
    warnings.push({
      message: CODEX_ISOLATION_WARNING,
      fix: CODEX_ISOLATION_WARNING_FIX,
    });
  }

  return warnings;
}

function buildVerdict(
  llm: LlmStatus,
  embeddings: EmbeddingsStatus,
  connections: ConnectionStatus[],
  queryHistory: QueryHistoryStatus[],
  warnings: WarningItem[],
): { verdict: ProjectVerdict; reason: string; nextActions: string[] } {
  if (llm.status === 'fail') {
    return {
      verdict: 'blocked',
      reason: 'LLM not configured; research agent will not run.',
      nextActions: ['ktx setup'],
    };
  }
  const failedQueryHistory = queryHistory.filter((entry) => entry.status === 'fail').length;
  if (failedQueryHistory > 0) {
    return {
      verdict: 'blocked',
      reason: `Query history readiness failed for ${failedQueryHistory} connection${failedQueryHistory === 1 ? '' : 's'}.`,
      nextActions: ['ktx status --verbose'],
    };
  }

  const reasons: string[] = [];
  if (llm.status === 'warn') reasons.push('LLM credentials missing');
  if (embeddings.status === 'warn') {
    if (embeddings.backend === 'none') {
      reasons.push('semantic search disabled');
    } else {
      reasons.push('embedding credentials missing');
    }
  }
  const missing = connections.filter((c) => c.status !== 'ok' && c.status !== 'skipped').length;
  if (missing > 0) reasons.push(`${missing} connection${missing === 1 ? '' : 's'} need configuration`);
  const queryHistoryWarnings = queryHistory.filter((entry) => entry.status === 'warn').length;
  if (queryHistoryWarnings > 0) {
    reasons.push(`${queryHistoryWarnings} query history warning${queryHistoryWarnings === 1 ? '' : 's'}`);
  }
  if (warnings.length > 0) reasons.push(`${warnings.length} config warning${warnings.length === 1 ? '' : 's'}`);

  if (reasons.length === 0) {
    return {
      verdict: 'ready',
      reason: 'Ready.',
      nextActions: [...PROJECT_READY_COMMANDS],
    };
  }

  return {
    verdict: 'partial',
    reason: `Partially ready — ${reasons.join('; ')}.`,
    nextActions: ['ktx setup'],
  };
}

export interface BuildProjectStatusOptions {
  env?: NodeJS.ProcessEnv;
  queryHistoryReadinessProbe?: HistoricSqlReadinessProbe;
  claudeCodeAuthProbe?: ClaudeCodeAuthProbe;
  codexAuthProbe?: CodexAuthProbe;
  configIssues?: KtxConfigIssue[];
  fast?: boolean;
  useSpinner?: boolean;
}

async function withSpinner<T>(
  useSpinner: boolean,
  label: string,
  run: () => Promise<T>,
): Promise<T> {
  if (!useSpinner) return run();
  const { spinner } = await import('@clack/prompts');
  const s = spinner();
  s.start(label);
  try {
    const result = await run();
    s.stop(label);
    return result;
  } catch (error) {
    s.stop(`${label} — failed`);
    throw error;
  }
}

function buildConfigStatus(issues: KtxConfigIssue[] | undefined): ConfigStatus {
  const list = issues ?? [];
  if (list.length === 0) {
    return { status: 'ok', detail: 'ktx.yaml schema valid', issues: [] };
  }
  // Error-severity issues never reach here — the doctor exits on them first.
  return {
    status: 'warn',
    detail: `ktx.yaml schema valid · ${list.length} ignored field${list.length === 1 ? '' : 's'}`,
    issues: list,
  };
}

interface DirSummary {
  fileCount: number;
  bytes: number;
}

async function summarizeDir(dir: string, maxDepth = 10): Promise<DirSummary> {
  let fileCount = 0;
  let bytes = 0;
  const walk = async (current: string, depth: number): Promise<void> => {
    if (depth > maxDepth) return;
    let entries;
    try {
      entries = await readdirAsync(current, { withFileTypes: true });
    } catch {
      return;
    }
    for (const entry of entries) {
      const full = join(current, entry.name);
      if (entry.isDirectory()) {
        await walk(full, depth + 1);
        continue;
      }
      if (!entry.isFile()) continue;
      try {
        const s = await statAsync(full);
        fileCount += 1;
        bytes += s.size;
      } catch {
        // skip individual stat failures
      }
    }
  };
  await walk(dir, 0);
  return { fileCount, bytes };
}

async function fileSizeOrNull(filePath: string): Promise<number | null> {
  try {
    const s = await statAsync(filePath);
    return s.isFile() ? s.size : null;
  } catch {
    return null;
  }
}

function tryQuery<T>(run: () => T, fallback: T): T {
  try {
    return run();
  } catch {
    return fallback;
  }
}

function skippedObjectsFromReportBody(bodyJson: string): Array<{ name: string; reason: string }> {
  try {
    const body = JSON.parse(bodyJson) as { fetch?: { skipped?: Array<{ entityId?: unknown; message?: unknown }> } };
    const skipped = body.fetch?.skipped;
    if (!Array.isArray(skipped)) return [];
    return skipped.map((issue) => ({
      name: typeof issue.entityId === 'string' && issue.entityId.length > 0 ? issue.entityId : 'object',
      reason: typeof issue.message === 'string' ? issue.message : 'introspection failed',
    }));
  } catch {
    return [];
  }
}

/** @internal */
export async function buildLocalStatsStatus(project: KtxLocalProject): Promise<LocalStatsStatus> {
  const dbPath = ktxLocalStateDbPath(project);
  const dbSqliteBytes = await fileSizeOrNull(dbPath);

  const projectDirSummary: LocalStatsProjectDir = {
    dbSqliteBytes,
    ktxCacheBytes: (await summarizeDir(join(project.projectDir, '.ktx', 'cache'))).bytes,
    rawSources: await summarizeDir(join(project.projectDir, 'raw-sources')),
  };

  if (dbSqliteBytes === null) {
    return {
      ingest: { totalCompletedRuns: 0, perConnection: [] },
      wikiPages: [],
      semanticLayer: [],
      projectDir: projectDirSummary,
      unavailable: 'no .ktx/db.sqlite yet',
    };
  }

  let database: import('better-sqlite3').Database | null = null;
  try {
    const { default: Database } = await import('better-sqlite3');
    database = new Database(dbPath, { readonly: true, fileMustExist: true });
    const db = database;

    const totalCompletedRuns = tryQuery(
      () =>
        (
          db
            .prepare(`SELECT COUNT(*) AS n FROM local_ingest_reports WHERE status = 'done'`)
            .get() as { n: number } | undefined
        )?.n ?? 0,
      0,
    );

    type IngestStatsRow = { connection_id: string; adapter: string; last_completed_at: string; body_json: string };
    const ingestRows = tryQuery(
      () =>
        // SQLite returns body_json from the MAX(completed_at) row for each group.
        db
          .prepare(
            `SELECT connection_id, adapter, MAX(completed_at) AS last_completed_at, body_json
             FROM local_ingest_reports
             WHERE status = 'done'
             GROUP BY connection_id, adapter`,
          )
          .all() as IngestStatsRow[],
      [] as IngestStatsRow[],
    );
    const perConnectionMap = new Map<string, LocalStatsIngestPerConnection>();
    for (const row of ingestRows) {
      const existing = perConnectionMap.get(row.connection_id);
      if (!existing || row.last_completed_at > existing.lastCompletedAt) {
        perConnectionMap.set(row.connection_id, {
          connectionId: row.connection_id,
          adapter: row.adapter,
          lastCompletedAt: row.last_completed_at,
          skippedObjects: skippedObjectsFromReportBody(row.body_json),
        });
      }
    }
    const perConnection = [...perConnectionMap.values()].sort((left, right) =>
      left.connectionId.localeCompare(right.connectionId),
    );

    const wikiRows = tryQuery(
      () =>
        db
          .prepare(
            `SELECT scope, COUNT(*) AS n, SUM(CASE WHEN embedding_json IS NOT NULL THEN 1 ELSE 0 END) AS embedded
             FROM knowledge_pages
             GROUP BY scope
             ORDER BY scope`,
          )
          .all() as Array<{ scope: string; n: number; embedded: number | null }>,
      [] as Array<{ scope: string; n: number; embedded: number | null }>,
    );
    const wikiPages: LocalStatsWikiEntry[] = wikiRows.map((row) => ({
      scope: row.scope,
      count: row.n,
      embeddedCount: row.embedded ?? 0,
    }));

    const sourceRows = tryQuery(
      () =>
        db
          .prepare(
            `SELECT connection_id, COUNT(*) AS n, SUM(CASE WHEN embedding_json IS NOT NULL THEN 1 ELSE 0 END) AS embedded
             FROM local_sl_sources
             GROUP BY connection_id`,
          )
          .all() as Array<{ connection_id: string; n: number; embedded: number | null }>,
      [] as Array<{ connection_id: string; n: number; embedded: number | null }>,
    );
    const dictionaryRows = tryQuery(
      () =>
        db
          .prepare(
            `SELECT connection_id, COUNT(*) AS n FROM local_sl_dictionary_values GROUP BY connection_id`,
          )
          .all() as Array<{ connection_id: string; n: number }>,
      [] as Array<{ connection_id: string; n: number }>,
    );
    const slMap = new Map<string, LocalStatsSemanticLayerEntry>();
    for (const row of sourceRows) {
      slMap.set(row.connection_id, {
        connectionId: row.connection_id,
        sourceCount: row.n,
        embeddedSourceCount: row.embedded ?? 0,
        dictionaryValueCount: 0,
      });
    }
    for (const row of dictionaryRows) {
      const existing = slMap.get(row.connection_id) ?? {
        connectionId: row.connection_id,
        sourceCount: 0,
        embeddedSourceCount: 0,
        dictionaryValueCount: 0,
      };
      existing.dictionaryValueCount = row.n;
      slMap.set(row.connection_id, existing);
    }
    const semanticLayer = [...slMap.values()].sort((left, right) =>
      left.connectionId.localeCompare(right.connectionId),
    );

    return {
      ingest: { totalCompletedRuns, perConnection },
      wikiPages,
      semanticLayer,
      projectDir: projectDirSummary,
    };
  } catch (error) {
    return {
      ingest: { totalCompletedRuns: 0, perConnection: [] },
      wikiPages: [],
      semanticLayer: [],
      projectDir: projectDirSummary,
      unavailable: failureDetail(error),
    };
  } finally {
    if (database) {
      try {
        database.close();
      } catch {
        // ignore close failures
      }
    }
  }
}

export async function buildProjectStatus(project: KtxLocalProject, options: BuildProjectStatusOptions = {}): Promise<ProjectStatus> {
  const env = options.env ?? process.env;
  const config = project.config;

  const configStatus = buildConfigStatus(options.configIssues);
  const llm = await buildLlmStatus(config.llm, {
    projectDir: project.projectDir,
    env,
    claudeCodeAuthProbe: options.claudeCodeAuthProbe,
    codexAuthProbe: options.codexAuthProbe,
    fast: options.fast,
    useSpinner: options.useSpinner,
  });
  const embeddings = buildEmbeddingsStatus(config.ingest.embeddings, env);
  const storage = buildStorageStatus(config);
  const connections = Object.entries(config.connections).map(([name, conn]) =>
    buildConnectionStatus(name, conn, env),
  );
  const queryHistory = await buildQueryHistoryStatus(project, options);
  const pipeline = buildPipelineStatus(config);
  const warnings = buildWarnings(config, connections, llm, embeddings);
  const unknownConnectionWarning = await buildUnknownConnectionWarning(project);
  if (unknownConnectionWarning) {
    warnings.push(unknownConnectionWarning);
  }
  const localStats = await buildLocalStatsStatus(project);
  const { verdict, reason, nextActions } = buildVerdict(llm, embeddings, connections, queryHistory, warnings);

  return {
    projectName: basename(project.projectDir) || project.projectDir,
    projectDir: project.projectDir,
    config: configStatus,
    llm,
    embeddings,
    storage,
    connections,
    queryHistory,
    pipeline,
    warnings,
    localStats,
    verdict,
    verdictReason: reason,
    nextActions,
    promptCaching: config.llm.promptCaching
      ? {
          enabled: config.llm.promptCaching.enabled ?? false,
          systemTtl: config.llm.promptCaching.systemTtl,
          toolsTtl: config.llm.promptCaching.toolsTtl,
          historyTtl: config.llm.promptCaching.historyTtl,
        }
      : undefined,
    workUnits: {
      stepBudget: config.ingest.workUnits.stepBudget,
      maxConcurrency: config.ingest.workUnits.maxConcurrency,
      failureMode: config.ingest.workUnits.failureMode,
    },
    relationshipsDetail: {
      acceptThreshold: config.scan.relationships.acceptThreshold,
      reviewThreshold: config.scan.relationships.reviewThreshold,
      maxLlmTablesPerBatch: config.scan.relationships.maxLlmTablesPerBatch,
      validationConcurrency: config.scan.relationships.validationConcurrency,
    },
  };
}

// ─── Rendering ──────────────────────────────────────────────────────────────

const SYMBOL: Record<ProjectStatusLevel, string> = { ok: '✓', warn: '⚠', fail: '✗', skipped: '-' };

function colorForLevel(useColor: boolean, level: ProjectStatusLevel, text: string): string {
  if (!useColor) return text;
  if (level === 'ok') return green(text);
  if (level === 'warn') return yellow(text);
  if (level === 'fail') return red(text);
  return _dim(text);
}

function formatBytes(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  const units = ['KiB', 'MiB', 'GiB', 'TiB'];
  let value = bytes / 1024;
  let unitIndex = 0;
  while (value >= 1024 && unitIndex < units.length - 1) {
    value /= 1024;
    unitIndex += 1;
  }
  const precision = value >= 100 ? 0 : value >= 10 ? 1 : 2;
  return `${value.toFixed(precision)} ${units[unitIndex]}`;
}

const RELATIVE_TIME_DIVISIONS: Array<{ amount: number; name: Intl.RelativeTimeFormatUnit }> = [
  { amount: 60, name: 'second' },
  { amount: 60, name: 'minute' },
  { amount: 24, name: 'hour' },
  { amount: 7, name: 'day' },
  { amount: 4.34524, name: 'week' },
  { amount: 12, name: 'month' },
  { amount: Number.POSITIVE_INFINITY, name: 'year' },
];

function formatRelativeFromNow(iso: string): string {
  const parsed = Date.parse(iso);
  if (Number.isNaN(parsed)) return iso;
  const formatter = new Intl.RelativeTimeFormat('en', { numeric: 'auto' });
  let duration = (parsed - Date.now()) / 1000;
  for (const division of RELATIVE_TIME_DIVISIONS) {
    if (Math.abs(duration) < division.amount) {
      return formatter.format(Math.round(duration), division.name);
    }
    duration /= division.amount;
  }
  return iso;
}

function abbreviateHome(filePath: string, env: NodeJS.ProcessEnv): string {
  const home = env.HOME;
  if (home && (filePath === home || filePath.startsWith(`${home}/`))) {
    return filePath === home ? '~' : `~${filePath.slice(home.length)}`;
  }
  return filePath;
}

function renderLocalStats(
  lines: string[],
  stats: LocalStatsStatus,
  dim: (text: string) => string,
  bold: (text: string) => string,
): void {
  lines.push(`  ${bold('Local data')}`);
  if (stats.unavailable) {
    lines.push(`    ${dim(`(—) ${stats.unavailable}`)}`);
    lines.push('');
    return;
  }

  const localLabelWidth = Math.max(
    'Ingest'.length,
    'Wiki'.length,
    'Semantic layer'.length,
    'Disk'.length,
  );
  const lLabel = (text: string) => text.padEnd(localLabelWidth);

  const ingest = stats.ingest;
  const ingestSummary =
    ingest.totalCompletedRuns === 0
      ? dim('no completed runs yet')
      : `${ingest.totalCompletedRuns} completed run${ingest.totalCompletedRuns === 1 ? '' : 's'}`;
  lines.push(`    ${lLabel('Ingest')}   ${ingestSummary}`);
  if (ingest.perConnection.length > 0) {
    const nameWidth = Math.max(...ingest.perConnection.map((entry) => entry.connectionId.length));
    const adapterWidth = Math.max(...ingest.perConnection.map((entry) => entry.adapter.length));
    for (const entry of ingest.perConnection) {
      lines.push(
        `      ${entry.connectionId.padEnd(nameWidth)}   ${dim(entry.adapter.padEnd(adapterWidth))}   ${dim(`last ${formatRelativeFromNow(entry.lastCompletedAt)}`)}`,
      );
      if (entry.skippedObjects.length > 0) {
        const first = entry.skippedObjects[0]!;
        const extra = entry.skippedObjects.length - 1;
        const detail = `${first.name}: ${first.reason}${extra > 0 ? ` (+${extra} more)` : ''}`;
        lines.push(
          `      ${' '.repeat(nameWidth)}   ${dim(`${entry.skippedObjects.length} object${entry.skippedObjects.length === 1 ? '' : 's'} skipped — ${detail}`)}`,
        );
      }
    }
  }

  if (stats.wikiPages.length === 0) {
    lines.push(`    ${lLabel('Wiki')}   ${dim('no pages yet')}`);
  } else {
    const wikiText = stats.wikiPages
      .map((entry) => `${entry.scope}=${entry.count} ${dim(`(${entry.embeddedCount} embedded)`)}`)
      .join(` ${dim('·')} `);
    lines.push(`    ${lLabel('Wiki')}   ${wikiText}`);
  }

  if (stats.semanticLayer.length === 0) {
    lines.push(`    ${lLabel('Semantic layer')}   ${dim('no indexed sources yet')}`);
  } else {
    const nameWidth = Math.max(...stats.semanticLayer.map((entry) => entry.connectionId.length));
    let firstLine = true;
    for (const entry of stats.semanticLayer) {
      const prefix = firstLine ? lLabel('Semantic layer') : ' '.repeat(localLabelWidth);
      const sourcesText = `${entry.sourceCount} source${entry.sourceCount === 1 ? '' : 's'} (${entry.embeddedSourceCount} embedded)`;
      const dictText = `${entry.dictionaryValueCount} dictionary value${entry.dictionaryValueCount === 1 ? '' : 's'}`;
      lines.push(
        `    ${prefix}   ${entry.connectionId.padEnd(nameWidth)}   ${dim(`${sourcesText} · ${dictText}`)}`,
      );
      firstLine = false;
    }
  }

  const disk = stats.projectDir;
  const diskBits: string[] = [];
  diskBits.push(`db=${disk.dbSqliteBytes === null ? '–' : formatBytes(disk.dbSqliteBytes)}`);
  diskBits.push(`cache=${formatBytes(disk.ktxCacheBytes)}`);
  diskBits.push(
    `raw-sources=${disk.rawSources.fileCount} file${disk.rawSources.fileCount === 1 ? '' : 's'} (${formatBytes(disk.rawSources.bytes)})`,
  );
  lines.push(`    ${lLabel('Disk')}   ${dim(diskBits.join(`  ${dim('·')}  `))}`);
  lines.push('');
}

export interface RenderProjectStatusOptions {
  verbose?: boolean;
  useColor?: boolean;
  durationMs?: number;
  toolchainChecks?: DoctorCheck[];
  env?: NodeJS.ProcessEnv;
}

export function renderProjectStatus(status: ProjectStatus, options: RenderProjectStatusOptions = {}): string {
  const verbose = options.verbose ?? false;
  const useColor = options.useColor ?? false;
  const env = options.env ?? process.env;
  const dim = useColor ? _dim : (s: string) => s;
  const bold = useColor ? _bold : (s: string) => s;
  const color = (level: ProjectStatusLevel, s: string) => colorForLevel(useColor, level, s);
  const sym = (level: ProjectStatusLevel) => color(level, SYMBOL[level]);

  const lines: string[] = [];
  const dirStr = abbreviateHome(status.projectDir, env);
  lines.push(`${bold('ktx status')} ${dim('·')} ${status.projectName} ${dim(`(${dirStr})`)}`);
  lines.push('');

  const labelPad = 'Connections'.length;
  const label = (text: string) => text.padEnd(labelPad);

  // Core readiness rows
  const llmDetail = [status.llm.backend, status.llm.model].filter(Boolean).join(` ${dim('·')} `);
  lines.push(`  ${label('LLM')}   ${llmDetail}  ${sym(status.llm.status)} ${dim(status.llm.detail)}`);

  const embedParts = [status.embeddings.backend];
  if (status.embeddings.model) embedParts.push(status.embeddings.model);
  const embedDim = status.embeddings.dimensions ? `(${status.embeddings.dimensions}d)` : '';
  const embedDetail = `${embedParts.join(` ${dim('·')} `)}${embedDim ? ` ${embedDim}` : ''}`;
  lines.push(`  ${label('Embeddings')}   ${embedDetail}  ${sym(status.embeddings.status)} ${dim(status.embeddings.detail)}`);

  lines.push(`  ${label('Storage')}   ${dim(`${status.storage.state} (state) · ${status.storage.search} (search)`)}`);
  lines.push(`  ${label('Config')}   ${sym(status.config.status)} ${dim(status.config.detail)}`);
  if (status.config.issues.length > 0) {
    for (const issue of status.config.issues) {
      lines.push(`      ${color('warn', SYMBOL.warn)} ${issue.message}`);
      if (issue.fix) lines.push(`        ${dim(`→ ${issue.fix}`)}`);
    }
  }
  lines.push('');

  // Connections
  if (status.connections.length === 0) {
    lines.push(`  ${bold('Connections')} ${dim('(none)')}`);
    lines.push(`      ${dim('No connections configured. Run `ktx setup` to add one.')}`);
  } else {
    lines.push(`  ${bold('Connections')} ${dim(`(${status.connections.length})`)}`);
    const nameWidth = Math.max(...status.connections.map((c) => c.name.length));
    const driverWidth = Math.max(...status.connections.map((c) => c.driver.length));
    for (const conn of status.connections) {
      lines.push(
        `    ${sym(conn.status)} ${conn.name.padEnd(nameWidth)}   ${dim(conn.driver.padEnd(driverWidth))}   ${conn.detail}`,
      );
      if (conn.fix && conn.status !== 'ok') {
        const indent = 6 + nameWidth + 3 + driverWidth + 3;
        lines.push(`${' '.repeat(indent)}${dim(`→ ${conn.fix}`)}`);
      }
    }
  }
  lines.push('');

  if (status.queryHistory.length > 0) {
    lines.push(`  ${bold('Query history')}`);
    const connectionWidth = Math.max(...status.queryHistory.map((entry) => entry.connection.length));
    for (const entry of status.queryHistory) {
      lines.push(
        `    ${sym(entry.status)} ${entry.connection.padEnd(connectionWidth)}   ${dim(entry.dialect)}   ${entry.detail}`,
      );
      if (entry.fix && entry.status !== 'ok') {
        const indent = 6 + connectionWidth + 3 + entry.dialect.length + 3;
        lines.push(`${' '.repeat(indent)}${dim(`→ ${entry.fix}`)}`);
      }
    }
    lines.push('');
  }

  // Pipeline
  lines.push(`  ${bold('Pipeline')}`);
  const pipelineLabelWidth = Math.max('Adapters'.length, 'Enrichment'.length, 'Research agent'.length);
  const pLabel = (text: string) => text.padEnd(pipelineLabelWidth);
  lines.push(`    ${pLabel('Adapters')}   ${status.pipeline.adapters.length > 0 ? status.pipeline.adapters.join(', ') : dim('(none)')}`);
  const enrichmentDetail = [`${status.pipeline.enrichmentMode} mode`];
  if (status.pipeline.relationshipsEnabled) {
    const bits = ['relationships on'];
    if (status.pipeline.relationshipsLlmProposals) bits.push('LLM proposals');
    if (status.pipeline.relationshipsValidationRequired) bits.push('validation required');
    enrichmentDetail.push(bits.join(', '));
  } else {
    enrichmentDetail.push('relationships off');
  }
  lines.push(`    ${pLabel('Enrichment')}   ${enrichmentDetail.join(` ${dim('·')} `)}`);
  const agentDetail = status.pipeline.agentEnabled
    ? `enabled ${dim(`(${status.pipeline.agentTools.length} tool${status.pipeline.agentTools.length === 1 ? '' : 's'})`)}`
    : dim('disabled');
  lines.push(`    ${pLabel('Research agent')}   ${agentDetail}`);
  lines.push('');

  // Local data
  renderLocalStats(lines, status.localStats, dim, bold);

  // Warnings
  if (status.warnings.length > 0) {
    lines.push(`  ${bold('Warnings')}`);
    for (const w of status.warnings) {
      lines.push(`    ${color('warn', SYMBOL.warn)} ${w.message}`);
      if (w.fix) lines.push(`        ${dim(`→ ${w.fix}`)}`);
    }
    lines.push('');
  }

  // Verbose extras
  if (verbose) {
    if (options.toolchainChecks && options.toolchainChecks.length > 0) {
      lines.push(`  ${bold('Toolchain')}`);
      for (const check of options.toolchainChecks) {
        const lv: ProjectStatusLevel = check.status === 'pass' ? 'ok' : check.status === 'warn' ? 'warn' : 'fail';
        lines.push(`    ${sym(lv)} ${check.label}: ${check.detail}`);
        if (check.fix && lv !== 'ok') lines.push(`        ${dim(`→ ${check.fix}`)}`);
      }
      lines.push('');
    }
    if (status.promptCaching) {
      const pc = status.promptCaching;
      const bits = [`enabled=${pc.enabled}`];
      if (pc.systemTtl) bits.push(`system=${pc.systemTtl}`);
      if (pc.toolsTtl) bits.push(`tools=${pc.toolsTtl}`);
      if (pc.historyTtl) bits.push(`history=${pc.historyTtl}`);
      lines.push(`  ${bold('Prompt caching')}   ${dim(bits.join(', '))}`);
    }
    if (status.workUnits) {
      const wu = status.workUnits;
      lines.push(`  ${bold('Work units')}       ${dim(`stepBudget=${wu.stepBudget}, maxConcurrency=${wu.maxConcurrency}, failureMode=${wu.failureMode}`)}`);
    }
    if (status.relationshipsDetail) {
      const r = status.relationshipsDetail;
      lines.push(
        `  ${bold('Relationships')}    ${dim(`accept=${r.acceptThreshold}, review=${r.reviewThreshold}, maxLlmTables=${r.maxLlmTablesPerBatch}, concurrency=${r.validationConcurrency}`)}`,
      );
    }
    lines.push(
      `  ${bold('Agent')}            ${dim(`max_iterations=${status.pipeline.agentMaxIterations}, tools=${status.pipeline.agentTools.join(', ') || '(none)'}`)}`,
    );
    lines.push(`  ${bold('Git')}              ${dim(`author=${status.storage.gitAuthor}`)}`);
    lines.push('');
  }

  // Verdict + next steps
  const verdictLevel: ProjectStatusLevel =
    status.verdict === 'ready' ? 'ok' : status.verdict === 'partial' ? 'warn' : 'fail';
  const duration = options.durationMs !== undefined ? ` ${dim(`(${(options.durationMs / 1000).toFixed(2)}s)`)}` : '';
  if (status.verdict === 'ready') {
    const hint = `  ${dim('Try:')} ${status.nextActions.join(dim('  ·  '))}`;
    lines.push(`${color(verdictLevel, status.verdictReason)}${hint}${duration}`);
  } else {
    const hint = status.nextActions.length > 0 ? `  ${dim('Next:')} ${status.nextActions.join(dim('  ·  '))}` : '';
    lines.push(`${color(verdictLevel, status.verdictReason)}${hint}${duration}`);
  }
  lines.push('');

  return lines.join('\n');
}
