import { mkdtemp, readdir, readFile, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, relative, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { localConnectionTypeForConfig } from './context/connections/local-warehouse-descriptor.js';
import { resolveNotionConnectionAuthToken } from './context/connections/notion-config.js';
import { resolveKtxConfigReference } from './context/core/config-reference.js';
import { cloneOrPull, testRepoConnection } from './context/ingest/repo-fetch.js';
import { DEFAULT_METABASE_CLIENT_CONFIG, MetabaseClient } from './context/ingest/adapters/metabase/client.js';
import { discoverMetabaseDatabases, type DiscoveredMetabaseDatabase } from './context/ingest/adapters/metabase/mapping.js';
import { loadDbtSchemaFiles } from './context/ingest/dbt-shared/schema-files.js';
import { loadProjectInfo } from './context/ingest/dbt-shared/project-vars.js';
import { type NotionApi, NotionClient } from './context/ingest/adapters/notion/notion-client.js';
import { parseLookmlStagedDir } from './context/ingest/adapters/lookml/parse.js';
import { parseMetricflowFiles } from './context/ingest/adapters/metricflow/deep-parse.js';
import { type KtxProjectConfig, type KtxProjectConnectionConfig, serializeKtxProjectConfig } from './context/project/config.js';
import { loadKtxProject } from './context/project/project.js';
import { markKtxSetupStateStepComplete } from './context/project/setup-config.js';
import type { KtxCliIo } from './cli-runtime.js';
import { createCliSpinner, errorMessage, writePrefixedLines } from './clack.js';
import { pickNotionRootPages } from './notion-page-picker.js';
import { runKtxSourceMapping } from './source-mapping.js';
import { assertSafeConnectionId } from './context/sl/source-files.js';
import {
  runConnectionSetupWithRecovery,
  type ConfigureResult,
  type RecoveryOutcome,
  type ValidateResult,
} from './connection-recovery.js';
import { withMultiselectNavigation, withTextInputNavigation } from './prompt-navigation.js';
import { runKtxPublicIngest } from './public-ingest.js';
import { writeProjectLocalSecretReference } from './setup-secrets.js';
import { isDemoConnection } from './telemetry/demo-detect.js';
import { emitTelemetryEvent } from './telemetry/index.js';
import {
  createKtxSetupPromptAdapter,
  type KtxSetupPromptOption,
} from './setup-prompts.js';

export type KtxSetupSourceType = 'dbt' | 'metricflow' | 'metabase' | 'looker' | 'lookml' | 'notion';

const DEFAULT_NOTION_MAX_KNOWLEDGE_CREATES_PER_RUN = 25;

export interface KtxSetupSourcesArgs {
  projectDir: string;
  inputMode: 'auto' | 'disabled';
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
  runInitialSourceIngest: boolean;
  skipSources: boolean;
}

export type KtxSetupSourcesResult =
  | { status: 'ready'; projectDir: string; connectionIds: string[] }
  | { status: 'skipped'; projectDir: string }
  | { status: 'back'; projectDir: string }
  | { status: 'missing-input'; projectDir: string }
  | { status: 'failed'; projectDir: string };

export interface KtxSetupSourcesPromptAdapter {
  multiselect(options: {
    message: string;
    options: KtxSetupPromptOption[];
    initialValues?: string[];
    required?: boolean;
  }): Promise<string[]>;
  select(options: { message: string; options: KtxSetupPromptOption[] }): Promise<string>;
  autocomplete(options: {
    message: string;
    placeholder?: string;
    options: KtxSetupPromptOption[];
  }): Promise<string>;
  text(options: { message: string; placeholder?: string; initialValue?: string }): Promise<string | undefined>;
  password(options: { message: string }): Promise<string | undefined>;
  cancel(message: string): void;
  log?(message: string): void;
}

type SourceValidationResult = { ok: true; detail?: string } | { ok: false; message: string };

export interface KtxSetupSourcesDeps {
  prompts?: KtxSetupSourcesPromptAdapter;
  testGitRepo?: (args: { repoUrl: string; authToken?: string | null }) => Promise<{ ok: true } | { ok: false; error: string }>;
  validateDbt?: (connection: KtxProjectConnectionConfig) => Promise<SourceValidationResult>;
  validateMetricflow?: (connection: KtxProjectConnectionConfig) => Promise<SourceValidationResult>;
  validateMetabase?: (projectDir: string, connectionId: string) => Promise<SourceValidationResult>;
  validateLooker?: (projectDir: string, connectionId: string) => Promise<SourceValidationResult>;
  validateLookml?: (connection: KtxProjectConnectionConfig) => Promise<SourceValidationResult>;
  validateNotion?: (connection: KtxProjectConnectionConfig) => Promise<SourceValidationResult>;
  pickNotionRootPages?: typeof pickNotionRootPages;
  discoverMetabaseDatabases?: (args: {
    sourceUrl: string;
    sourceApiKeyRef: string;
    sourceConnectionId: string;
  }) => Promise<DiscoveredMetabaseDatabase[]>;
  runMapping?: (projectDir: string, connectionId: string, io: KtxCliIo) => Promise<number>;
  runInitialIngest?: (
    projectDir: string,
    connectionId: string,
    io: KtxCliIo,
    options: { inputMode: KtxSetupSourcesArgs['inputMode'] },
  ) => Promise<number>;
}

const SOURCE_OPTIONS: Array<{ value: KtxSetupSourceType; label: string }> = [
  { value: 'dbt', label: 'dbt' },
  { value: 'metabase', label: 'Metabase' },
  { value: 'notion', label: 'Notion' },
  { value: 'metricflow', label: 'MetricFlow' },
  { value: 'looker', label: 'Looker' },
  { value: 'lookml', label: 'LookML' },
];

const SOURCE_LABELS = Object.fromEntries(SOURCE_OPTIONS.map((option) => [option.value, option.label])) as Record<
  KtxSetupSourceType,
  string
>;

const PRIMARY_SOURCE_DRIVERS = new Set([
  'sqlite',
  'postgres',
  'mysql',
  'clickhouse',
  'sqlserver',
  'bigquery',
  'snowflake',
]);

function createPromptAdapter(): KtxSetupSourcesPromptAdapter {
  return createKtxSetupPromptAdapter({
    selectCancelValue: 'back',
    multiselectCancelValue: 'back',
    confirmEmptyOptionalMultiselect: true,
  });
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function stringField(value: unknown): string | undefined {
  return typeof value === 'string' && value.trim().length > 0 ? value.trim() : undefined;
}

function sourceLabel(source: KtxSetupSourceType): string {
  return SOURCE_LABELS[source];
}

function sourceAdapter(source: KtxSetupSourceType): string {
  return source;
}

function connectionNamePrompt(label: string): string {
  return `Name this ${label} connection\nktx will use this short name in commands and config. You can rename it now.`;
}

function sourceSubpathPrompt(source: KtxSetupSourceType): string {
  if (source === 'dbt') {
    return [
      'Folder containing dbt_project.yml (optional)',
      'Press Enter when dbt_project.yml is at the repo root.',
      'For monorepos, enter a relative path like analytics/dbt.',
    ].join('\n');
  }
  return [
    `${sourceLabel(source)} project folder (optional)`,
    'If the project files are inside a subfolder, enter that path.',
    'Press Enter if the path or repo already points at the project.',
  ].join('\n');
}

const SCAN_SKIP_DIRS = new Set(['.git', 'node_modules', '.venv', 'target', 'dbt_packages', 'dbt_modules', '__pycache__']);

async function findDbtProjectSubpaths(rootDir: string): Promise<string[]> {
  const entries = await readdir(rootDir, { withFileTypes: true, recursive: true });
  const subpaths: string[] = [];
  for (const entry of entries) {
    if (!entry.isFile()) continue;
    if (entry.name !== 'dbt_project.yml' && entry.name !== 'dbt_project.yaml') continue;
    const relDir = relative(rootDir, entry.parentPath);
    if (relDir.split('/').some((part) => SCAN_SKIP_DIRS.has(part))) continue;
    subpaths.push(relDir);
  }
  return subpaths;
}

async function promptText(
  prompts: KtxSetupSourcesPromptAdapter,
  options: { message: string; placeholder?: string; initialValue?: string },
): Promise<string | undefined> {
  return await prompts.text({ ...options, message: withTextInputNavigation(options.message) });
}

function credentialRef(value: string | undefined, label: string): string {
  const ref = value?.trim();
  if (!ref) {
    throw new Error(`Missing ${label}; use env:NAME or file:/absolute/path`);
  }
  if (!ref.startsWith('env:') && !ref.startsWith('file:')) {
    throw new Error(`${label} must use env:NAME or file:/absolute/path`);
  }
  return ref;
}

type SourceCredentialFlag = {
  field: 'sourceAuthTokenRef' | 'sourceApiKeyRef' | 'sourceClientSecretRef';
  flag: string;
};

// Each connector reads exactly one credential ref; the flag name mirrors the
// ktx.yaml field it writes (auth_token_ref / api_key_ref / client_secret_ref).
const SOURCE_CREDENTIAL_FLAG: Record<KtxSetupSourceType, SourceCredentialFlag> = {
  dbt: { field: 'sourceAuthTokenRef', flag: '--source-auth-token-ref' },
  metricflow: { field: 'sourceAuthTokenRef', flag: '--source-auth-token-ref' },
  lookml: { field: 'sourceAuthTokenRef', flag: '--source-auth-token-ref' },
  notion: { field: 'sourceAuthTokenRef', flag: '--source-auth-token-ref' },
  metabase: { field: 'sourceApiKeyRef', flag: '--source-api-key-ref' },
  looker: { field: 'sourceClientSecretRef', flag: '--source-client-secret-ref' },
};

const ALL_SOURCE_CREDENTIAL_FLAGS: SourceCredentialFlag[] = [
  { field: 'sourceAuthTokenRef', flag: '--source-auth-token-ref' },
  { field: 'sourceApiKeyRef', flag: '--source-api-key-ref' },
  { field: 'sourceClientSecretRef', flag: '--source-client-secret-ref' },
];

// Reject a credential ref flag the chosen source does not read, so a wrong flag
// fails loudly instead of being silently dropped (KLO-724).
function assertSourceCredentialFlags(source: KtxSetupSourceType, args: KtxSetupSourcesArgs): void {
  const allowed = SOURCE_CREDENTIAL_FLAG[source];
  for (const { field, flag } of ALL_SOURCE_CREDENTIAL_FLAGS) {
    if (args[field] && field !== allowed.field) {
      throw new Error(`${flag} does not apply to --source ${source}; use ${allowed.flag}.`);
    }
  }
}

async function chooseSourceCredentialRef(input: {
  prompts: KtxSetupSourcesPromptAdapter;
  projectDir: string;
  label: string;
  envName: string;
  secretFileName: string;
  existingRef?: string;
}): Promise<string | 'back'> {
  while (true) {
    const choice = await input.prompts.select({
      message: `How should ktx find your ${input.label}?`,
      options: [
        ...(input.existingRef ? [{ value: 'keep', label: 'Keep existing credential' }] : []),
        { value: 'paste', label: 'Paste a key and save it as a local secret file' },
        { value: 'env', label: `Use ${input.envName} from the environment` },
        { value: 'back', label: 'Back' },
      ],
    });
    if (choice === 'back') return 'back';
    if (choice === 'keep' && input.existingRef) return input.existingRef;
    if (choice === 'paste') {
      const value = await input.prompts.password({ message: input.label });
      if (value === undefined) continue;
      if (!value.trim()) continue;
      const ref = await writeProjectLocalSecretReference({
        projectDir: input.projectDir,
        fileName: input.secretFileName,
        value,
      });
      input.prompts.log?.(`Saved to .ktx/secrets/${input.secretFileName}`);
      return ref;
    }
    return `env:${input.envName}`;
  }
}

async function chooseGitAuthCredentialRef(input: {
  prompts: KtxSetupSourcesPromptAdapter;
  projectDir: string;
  source: KtxSetupSourceType;
  connectionId: string;
  existingRef?: string;
  repoUrl?: string;
  testGitRepo?: (args: { repoUrl: string; authToken?: string | null }) => Promise<{ ok: true } | { ok: false; error: string }>;
}): Promise<string | undefined | 'back'> {
  const label = input.source === 'dbt' ? 'This' : `This ${sourceLabel(input.source)}`;
  while (true) {
    const choice = await input.prompts.select({
      message: `${label} repo requires authentication.`,
      options: [
        ...(input.existingRef ? [{ value: 'keep', label: 'Keep existing credential' }] : []),
        { value: 'paste', label: 'Paste a token and save it as a local secret file' },
        { value: 'env', label: 'Use GITHUB_TOKEN from the environment' },
        { value: 'skip', label: 'Skip — try without authentication' },
        { value: 'back', label: 'Back' },
      ],
    });
    if (choice === 'back') return 'back';
    if (choice === 'keep' && input.existingRef) return input.existingRef;
    if (choice === 'skip') return undefined;
    if (choice === 'paste') {
      const value = await input.prompts.password({ message: 'Git access token' });
      if (value === undefined) continue;
      if (!value.trim()) continue;
      if (input.testGitRepo && input.repoUrl) {
        const result = await input.testGitRepo({ repoUrl: input.repoUrl, authToken: value });
        if (!result.ok) {
          input.prompts.log?.(`Authentication failed: ${result.error}`);
          continue;
        }
      }
      const fileName = `${input.connectionId}-auth-token`;
      const ref = await writeProjectLocalSecretReference({
        projectDir: input.projectDir,
        fileName,
        value,
      });
      input.prompts.log?.(`Saved to .ktx/secrets/${fileName}`);
      return ref;
    }
    return 'env:GITHUB_TOKEN';
  }
}

function repoOrLocalSource(args: KtxSetupSourcesArgs): { sourceDir?: string; repoUrl?: string } {
  if (args.sourcePath && args.sourceGitUrl) {
    throw new Error('Choose only one source location: --source-path or --source-git-url.');
  }
  if (args.sourcePath) {
    return { sourceDir: resolve(args.sourcePath) };
  }
  if (args.sourceGitUrl) {
    return { repoUrl: args.sourceGitUrl };
  }
  throw new Error('Missing source location: pass --source-path or --source-git-url.');
}

function fileRepoUrl(sourceDir: string): string {
  return pathToFileURL(sourceDir).toString();
}

async function writeProjectConfig(projectDir: string, config: KtxProjectConfig): Promise<void> {
  const project = await loadKtxProject({ projectDir });
  await writeFile(project.configPath, serializeKtxProjectConfig(config), 'utf-8');
}

async function writeSourceConnection(
  projectDir: string,
  connectionId: string,
  connection: KtxProjectConnectionConfig,
  adapter: string,
  io?: KtxCliIo,
): Promise<() => Promise<void>> {
  assertSafeConnectionId(connectionId);
  const project = await loadKtxProject({ projectDir });
  const previousConnection = project.config.connections[connectionId];
  const hadPreviousConnection = previousConnection !== undefined;
  const shouldRemoveAdapterOnRollback = !project.config.ingest.adapters.includes(adapter);
  const config = {
    ...project.config,
    connections: {
      ...project.config.connections,
      [connectionId]: connection,
    },
    ingest: {
      ...project.config.ingest,
      adapters: project.config.ingest.adapters.includes(adapter)
        ? [...project.config.ingest.adapters]
        : [...project.config.ingest.adapters, adapter],
    },
  };
  await writeFile(project.configPath, serializeKtxProjectConfig(config), 'utf-8');
  if (io) {
    await emitTelemetryEvent({
      name: 'connection_added',
      projectDir,
      io,
      fields: {
        driver: String(connection.driver ?? adapter).toLowerCase(),
        isDemoConnection: isDemoConnection(connectionId, connection),
      },
    });
  }
  return async () => {
    const latest = await loadKtxProject({ projectDir });
    const connections = { ...latest.config.connections };
    if (hadPreviousConnection) {
      connections[connectionId] = previousConnection;
    } else {
      delete connections[connectionId];
    }
    await writeProjectConfig(projectDir, {
      ...latest.config,
      connections,
      ingest: {
        ...latest.config.ingest,
        adapters: shouldRemoveAdapterOnRollback
          ? latest.config.ingest.adapters.filter((candidate) => candidate !== adapter)
          : latest.config.ingest.adapters,
      },
    });
  };
}

async function ensureSourceAdapterEnabled(projectDir: string, source: KtxSetupSourceType): Promise<void> {
  const adapter = sourceAdapter(source);
  const project = await loadKtxProject({ projectDir });
  if (project.config.ingest.adapters.includes(adapter)) {
    return;
  }
  await writeProjectConfig(projectDir, {
    ...project.config,
    ingest: {
      ...project.config.ingest,
      adapters: [...project.config.ingest.adapters, adapter],
    },
  });
}

async function markSourcesComplete(projectDir: string): Promise<void> {
  const project = await loadKtxProject({ projectDir });
  await writeFile(project.configPath, serializeKtxProjectConfig(project.config), 'utf-8');
  await markKtxSetupStateStepComplete(projectDir, 'sources');
}

function hasPrimarySource(config: KtxProjectConfig): boolean {
  const setupPrimaryIds = config.setup?.database_connection_ids ?? [];
  if (setupPrimaryIds.some((connectionId) => Object.hasOwn(config.connections, connectionId))) {
    return true;
  }
  return Object.values(config.connections).some((connection) =>
    PRIMARY_SOURCE_DRIVERS.has(String(connection.driver ?? '').toLowerCase()),
  );
}

function buildDbtConnection(args: KtxSetupSourcesArgs): KtxProjectConnectionConfig {
  const source = repoOrLocalSource(args);
  return {
    driver: 'dbt',
    ...(source.sourceDir ? { source_dir: source.sourceDir } : {}),
    ...(source.repoUrl ? { repo_url: source.repoUrl } : {}),
    ...(args.sourceBranch ? { branch: args.sourceBranch } : {}),
    ...(args.sourceSubpath ? { path: args.sourceSubpath } : {}),
    ...(args.sourceAuthTokenRef
      ? { auth_token_ref: credentialRef(args.sourceAuthTokenRef, 'dbt private repo access token') }
      : {}),
    ...(args.sourceProfilesPath ? { profiles_path: resolve(args.sourceProfilesPath) } : {}),
    ...(args.sourceTarget ? { target: args.sourceTarget } : {}),
    ...(args.sourceProjectName ? { project_name: args.sourceProjectName } : {}),
  };
}

function buildMetricflowConnection(args: KtxSetupSourcesArgs): KtxProjectConnectionConfig {
  const source = repoOrLocalSource(args);
  return {
    driver: 'metricflow',
    metricflow: {
      repoUrl: source.repoUrl ?? fileRepoUrl(source.sourceDir ?? ''),
      ...(args.sourceBranch ? { branch: args.sourceBranch } : {}),
      ...(args.sourceSubpath ? { path: args.sourceSubpath } : {}),
      ...(args.sourceAuthTokenRef
        ? { auth_token_ref: credentialRef(args.sourceAuthTokenRef, 'MetricFlow auth token ref') }
        : {}),
    },
  };
}

function buildMetabaseConnection(args: KtxSetupSourcesArgs): KtxProjectConnectionConfig {
  if (!args.sourceUrl) {
    throw new Error('Missing Metabase URL: pass --source-url.');
  }
  if (!args.sourceWarehouseConnectionId) {
    throw new Error('Missing mapped warehouse: pass --source-warehouse-connection-id.');
  }
  if (!args.metabaseDatabaseId) {
    throw new Error('Missing Metabase database id: pass --metabase-database-id.');
  }
  return {
    driver: 'metabase',
    api_url: args.sourceUrl,
    api_key_ref: credentialRef(args.sourceApiKeyRef, 'Metabase API key ref'),
    mappings: {
      databaseMappings: { [String(args.metabaseDatabaseId)]: args.sourceWarehouseConnectionId },
      syncEnabled: { [String(args.metabaseDatabaseId)]: true },
      syncMode: 'ALL',
      selections: { collections: [], items: [] },
      defaultTagNames: [],
    },
  };
}

function buildLookerConnection(args: KtxSetupSourcesArgs): KtxProjectConnectionConfig {
  if (!args.sourceUrl) {
    throw new Error('Missing Looker base URL: pass --source-url.');
  }
  if (!args.sourceClientId) {
    throw new Error('Missing Looker client id: pass --source-client-id.');
  }
  if (!args.sourceWarehouseConnectionId) {
    throw new Error('Missing mapped warehouse: pass --source-warehouse-connection-id.');
  }
  return {
    driver: 'looker',
    base_url: args.sourceUrl,
    client_id: args.sourceClientId,
    client_secret_ref: credentialRef(args.sourceClientSecretRef, 'Looker client secret ref'),
    mappings: {
      connectionMappings: {
        [args.sourceTarget ?? args.sourceWarehouseConnectionId]: args.sourceWarehouseConnectionId,
      },
    },
  };
}

function buildLookmlConnection(args: KtxSetupSourcesArgs): KtxProjectConnectionConfig {
  const source = repoOrLocalSource(args);
  return {
    driver: 'lookml',
    repoUrl: source.repoUrl ?? fileRepoUrl(source.sourceDir ?? ''),
    ...(args.sourceBranch ? { branch: args.sourceBranch } : {}),
    ...(args.sourceSubpath ? { path: args.sourceSubpath } : {}),
    ...(args.sourceAuthTokenRef
      ? { auth_token_ref: credentialRef(args.sourceAuthTokenRef, 'LookML auth token ref') }
      : {}),
    mappings: {
      expectedLookerConnectionName: args.sourceTarget ?? args.sourceWarehouseConnectionId ?? null,
    },
  };
}

function buildNotionConnection(args: KtxSetupSourcesArgs): KtxProjectConnectionConfig {
  const rootPageIds = args.notionRootPageIds ?? [];
  const crawlMode = rootPageIds.length > 0 ? 'selected_roots' : (args.notionCrawlMode ?? 'selected_roots');
  if (crawlMode === 'selected_roots' && rootPageIds.length === 0) {
    throw new Error('Notion selected_roots requires --notion-root-page-id.');
  }
  return {
    driver: 'notion',
    auth_token_ref: credentialRef(args.sourceAuthTokenRef, 'Notion token ref'),
    crawl_mode: crawlMode,
    ...(rootPageIds.length > 0 ? { root_page_ids: rootPageIds } : {}),
    root_database_ids: [],
    root_data_source_ids: [],
    max_pages_per_run: 1000,
    max_knowledge_creates_per_run: DEFAULT_NOTION_MAX_KNOWLEDGE_CREATES_PER_RUN,
    max_knowledge_updates_per_run: 20,
  };
}

function sourcePathFromFileRepoUrl(repoUrl: string, subpath?: string): string {
  const root = fileURLToPath(repoUrl);
  return subpath ? join(root, subpath) : root;
}

function repoAuthToken(connection: KtxProjectConnectionConfig | Record<string, unknown>): string | null {
  const ref = stringField(connection.auth_token_ref);
  const literal = stringField(connection.auth_token);
  return literal ?? resolveKtxConfigReference(ref, process.env) ?? null;
}

async function collectYamlFilesRecursive(sourceRoot: string): Promise<Array<{ content: string; path: string }>> {
  const entries = await readdir(sourceRoot, { withFileTypes: true, recursive: true });
  const files: Array<{ content: string; path: string }> = [];
  for (const entry of entries) {
    if (!entry.isFile() || !/\.ya?ml$/i.test(entry.name)) {
      continue;
    }
    const path = join(entry.parentPath, entry.name);
    files.push({ path, content: await readFile(path, 'utf-8') });
  }
  return files;
}

async function defaultValidateDbt(connection: KtxProjectConnectionConfig): Promise<SourceValidationResult> {
  let sourceDir = stringField(connection.source_dir);
  const repoUrl = stringField(connection.repo_url);
  if (!sourceDir && repoUrl?.startsWith('file:')) {
    sourceDir = sourcePathFromFileRepoUrl(repoUrl, stringField(connection.path));
  }
  if (!sourceDir && repoUrl) {
    const cacheDir = await mkdtemp(join(tmpdir(), 'ktx-setup-dbt-'));
    try {
      await cloneOrPull({
        repoUrl,
        authToken: repoAuthToken(connection),
        cacheDir,
        branch: stringField(connection.branch) ?? 'main',
      });
    } catch (error) {
      const reason = error instanceof Error ? error.message : String(error);
      return { ok: false, message: `Failed to clone ${repoUrl}: ${reason}` };
    }
    sourceDir = stringField(connection.path) ? join(cacheDir, String(connection.path)) : cacheDir;
  }
  if (!sourceDir) {
    return { ok: false, message: 'dbt setup requires --source-path or --source-git-url.' };
  }
  const info = await loadProjectInfo(sourceDir);
  const schemaFiles = await loadDbtSchemaFiles(sourceDir);
  if (!info.projectName && typeof connection.project_name !== 'string') {
    return { ok: false, message: 'dbt project metadata is missing project name.' };
  }
  return { ok: true, detail: `project=${info.projectName ?? connection.project_name} schemas=${schemaFiles.length}` };
}

async function defaultValidateMetricflow(connection: KtxProjectConnectionConfig): Promise<SourceValidationResult> {
  const metricflow = isRecord(connection.metricflow) ? connection.metricflow : undefined;
  const repoUrl = stringField(metricflow?.repoUrl);
  if (!repoUrl) {
    return { ok: false, message: 'MetricFlow setup requires repoUrl.' };
  }
  if (!repoUrl.startsWith('file:')) {
    const result = await testRepoConnection({
      repoUrl,
      authToken: metricflow ? repoAuthToken(metricflow) : null,
    });
    if (!result.ok) {
      return { ok: false, message: result.error };
    }
    return { ok: true, detail: 'repository reachable' };
  }
  const path = sourcePathFromFileRepoUrl(repoUrl, stringField(metricflow?.path));
  const parsed = parseMetricflowFiles(await collectYamlFilesRecursive(path));
  return {
    ok: true,
    detail: `semanticModels=${parsed.semanticModels.length} metrics=${parsed.crossModelMetrics.length}`,
  };
}

async function defaultValidateLooker(projectDir: string, connectionId: string): Promise<SourceValidationResult> {
  const code = await runKtxSourceMapping(
    { command: 'refresh', projectDir, connectionId, autoAccept: true },
    { stdout: { write() {} }, stderr: { write() {} } },
  );
  return code === 0
    ? { ok: true, detail: 'Looker mapping refreshed' }
    : { ok: false, message: 'Looker validation failed' };
}

async function defaultValidateLookml(connection: KtxProjectConnectionConfig): Promise<SourceValidationResult> {
  const repoUrl = stringField(connection.repoUrl);
  if (!repoUrl) {
    return { ok: false, message: 'LookML setup requires repoUrl.' };
  }
  if (!repoUrl.startsWith('file:')) {
    const result = await testRepoConnection({ repoUrl, authToken: repoAuthToken(connection) });
    return result.ok ? { ok: true, detail: 'repository reachable' } : { ok: false, message: result.error };
  }
  const parsed = await parseLookmlStagedDir(sourcePathFromFileRepoUrl(repoUrl, stringField(connection.path)));
  const count = parsed.models.length + parsed.views.length + parsed.dashboards.length;
  return count > 0 ? { ok: true, detail: `lookmlFiles=${count}` } : { ok: false, message: 'No LookML files found' };
}

async function defaultValidateNotion(connection: KtxProjectConnectionConfig): Promise<SourceValidationResult> {
  const token = await resolveNotionConnectionAuthToken({
    auth_token: stringField(connection.auth_token) ?? null,
    auth_token_ref: stringField(connection.auth_token_ref) ?? null,
  });
  const client: NotionApi = new NotionClient(token);
  await client.retrieveBotUser();
  const roots = Array.isArray(connection.root_page_ids)
    ? connection.root_page_ids.filter((id): id is string => typeof id === 'string')
    : [];
  for (const root of roots) {
    await client.retrievePage(root);
  }
  return { ok: true, detail: `roots=${roots.length}` };
}

interface MappingJsonOutput {
  connectionId: string;
  refresh: { ok: boolean; output: string[] };
  validation: { ok: boolean; output: string[] };
  mappings: unknown[];
}

function splitOutputLines(output: string): string[] {
  return output
    .split('\n')
    .map((line) => line.trim())
    .filter(Boolean);
}

function writeSetupPrefixedLines(write: (chunk: string) => void, output: string): void {
  for (const line of output.split(/\r?\n/)) {
    if (line.length > 0) {
      write(`│  ${line}\n`);
    }
  }
}

function createSetupPrefixedIo(io: KtxCliIo): KtxCliIo {
  return {
    stdout: {
      isTTY: io.stdout.isTTY,
      columns: io.stdout.columns,
      write(chunk: string) {
        writeSetupPrefixedLines((line) => io.stdout.write(line), chunk);
      },
    },
    stderr: {
      write(chunk: string) {
        writeSetupPrefixedLines((line) => io.stderr.write(line), chunk);
      },
    },
  };
}

function parseMappingListJson(output: string): unknown[] {
  const trimmed = output.trim();
  if (!trimmed) {
    return [];
  }
  const parsed = JSON.parse(trimmed) as unknown;
  return Array.isArray(parsed) ? parsed : [];
}

function summarizeMappingResult(parsed: MappingJsonOutput): string {
  const mappingCount = parsed.mappings.length;
  const mappingNoun = mappingCount === 1 ? 'mapping' : 'mappings';
  return `Mapping validated — ${mappingCount} ${mappingNoun} configured`;
}

async function defaultRunMapping(projectDir: string, connectionId: string, io: KtxCliIo): Promise<number> {
  const outputs = {
    refresh: '',
    validation: '',
    list: '',
  };
  const refreshCode = await runKtxSourceMapping(
    { command: 'refresh', projectDir, connectionId, autoAccept: true },
    {
      stdout: { write(chunk: string) { outputs.refresh += chunk; } },
      stderr: io.stderr,
    },
  );
  if (refreshCode !== 0) {
    return refreshCode;
  }

  const validationCode = await runKtxSourceMapping(
    { command: 'validate', projectDir, connectionId },
    {
      stdout: { write(chunk: string) { outputs.validation += chunk; } },
      stderr: io.stderr,
    },
  );
  if (validationCode !== 0) {
    return validationCode;
  }

  const listCode = await runKtxSourceMapping(
    { command: 'list', projectDir, connectionId, json: true },
    {
      stdout: { write(chunk: string) { outputs.list += chunk; } },
      stderr: io.stderr,
    },
  );
  if (listCode !== 0) {
    return listCode;
  }

  const parsed: MappingJsonOutput = {
    connectionId,
    refresh: { ok: true, output: splitOutputLines(outputs.refresh) },
    validation: { ok: true, output: splitOutputLines(outputs.validation) },
    mappings: parseMappingListJson(outputs.list),
  };
  io.stdout.write(`${summarizeMappingResult(parsed)}\n`);
  return 0;
}

async function defaultRunInitialIngest(
  projectDir: string,
  connectionId: string,
  io: KtxCliIo,
  options: { inputMode: KtxSetupSourcesArgs['inputMode'] },
): Promise<number> {
  return await runKtxPublicIngest(
    {
      command: 'run',
      projectDir,
      targetConnectionId: connectionId,
      all: false,
      json: false,
      inputMode: options.inputMode,
    },
    io,
  );
}

async function runInitialSourceIngestWithRecovery(input: {
  args: KtxSetupSourcesArgs;
  connectionId: string;
  io: KtxCliIo;
  prompts: KtxSetupSourcesPromptAdapter;
  deps: KtxSetupSourcesDeps;
}): Promise<'ready' | 'continue' | 'back' | 'failed'> {
  while (true) {
    input.io.stdout.write(`│  Building context from ${input.connectionId}. Large sources can take a while.\n`);
    const ingestCode = await (input.deps.runInitialIngest ?? defaultRunInitialIngest)(
      input.args.projectDir,
      input.connectionId,
      input.io,
      {
        inputMode: input.args.inputMode,
      },
    );
    if (ingestCode === 0) {
      return 'ready';
    }
    if (input.args.inputMode === 'disabled') {
      return 'failed';
    }

    const action = await input.prompts.select({
      message: `Context build failed for ${input.connectionId}\nRetry now, continue setup and build this source later, or go back.`,
      options: [
        { value: 'retry', label: 'Retry context build' },
        { value: 'continue', label: 'Continue setup and build this source later' },
        { value: 'back', label: 'Back' },
      ],
    });
    if (action === 'retry') {
      continue;
    }
    if (action === 'continue') {
      input.io.stdout.write(`│  Context source saved without a completed context build for ${input.connectionId}.\n`);
      input.io.stdout.write(`│  Run later: ktx ingest ${input.connectionId}\n`);
      return 'continue';
    }
    return 'back';
  }
}

type SourceLocationChoice = 'path' | 'git';

type SourcePromptState = KtxSetupSourcesArgs & {
  sourceLocation?: SourceLocationChoice;
};

type SourcePromptStep = (state: SourcePromptState) => Promise<'next' | 'back'>;

interface WarehouseConnectionChoice {
  id: string;
  connectionType: string;
}

type InteractiveSourceConnectionChoice =
  | { kind: 'existing'; connectionId: string; connection: KtxProjectConnectionConfig }
  | { kind: 'new'; args: KtxSetupSourcesArgs }
  | { kind: 'edited'; connectionId: string; args: KtxSetupSourcesArgs }
  | 'back';

type SourceSetupChoiceResult =
  | { status: 'ready'; connectionId: string }
  | { status: Exclude<RecoveryOutcome, 'ready'> };

async function runSourcePromptSteps(
  initialState: SourcePromptState,
  stepsForState: (state: SourcePromptState) => SourcePromptStep[],
): Promise<KtxSetupSourcesArgs | 'back'> {
  let stepIndex = 0;
  while (true) {
    const steps = stepsForState(initialState);
    if (stepIndex >= steps.length) {
      const { sourceLocation: _sourceLocation, ...sourceArgs } = initialState;
      return sourceArgs;
    }

    const result = await steps[stepIndex]?.(initialState);
    if (result === 'back') {
      if (stepIndex === 0) {
        return 'back';
      }
      stepIndex -= 1;
      continue;
    }
    stepIndex += 1;
  }
}

function resetRepoLocationFields(state: SourcePromptState): void {
  delete state.sourcePath;
  delete state.sourceGitUrl;
  delete state.sourceBranch;
  delete state.sourceAuthTokenRef;
  delete state.sourceSubpath;
  delete state.sourceProjectName;
}

function sourceLocationFromArgs(args: KtxSetupSourcesArgs): SourceLocationChoice | undefined {
  if (args.sourcePath) return 'path';
  if (args.sourceGitUrl) return 'git';
  return undefined;
}

function warehouseConnectionChoices(config: KtxProjectConfig): WarehouseConnectionChoice[] {
  return Object.entries(config.connections)
    .filter(([, connection]) => PRIMARY_SOURCE_DRIVERS.has(String(connection.driver ?? '').toLowerCase()))
    .map(([id, connection]) => ({ id, connectionType: localConnectionTypeForConfig(id, connection) }))
    .sort((left, right) => left.id.localeCompare(right.id));
}

async function chooseMappedWarehouseConnectionId(input: {
  projectDir: string;
  prompts: KtxSetupSourcesPromptAdapter;
}): Promise<string | 'back'> {
  const project = await loadKtxProject({ projectDir: input.projectDir });
  const choices = warehouseConnectionChoices(project.config);
  if (choices.length === 1) {
    return choices[0].id;
  }
  if (choices.length === 0) {
    const entered = await promptText(input.prompts, { message: 'Mapped warehouse connection id' });
    return entered === undefined ? 'back' : entered;
  }

  const selected = await input.prompts.select({
    message: 'Mapped warehouse connection',
    options: [
      ...choices.map((choice) => ({
        value: choice.id,
        label: `${choice.id} (${choice.connectionType})`,
      })),
      { value: 'back', label: 'Back' },
    ],
  });
  return selected === 'back' ? 'back' : selected;
}

async function defaultDiscoverMetabaseDatabases(input: {
  sourceUrl: string;
  sourceApiKeyRef: string;
}): Promise<DiscoveredMetabaseDatabase[]> {
  const apiKey = resolveKtxConfigReference(input.sourceApiKeyRef, process.env);
  if (!apiKey) {
    throw new Error('Metabase API key ref could not be resolved');
  }
  const client = new MetabaseClient(
    { apiUrl: input.sourceUrl, apiKey },
    DEFAULT_METABASE_CLIENT_CONFIG,
  );
  try {
    return await discoverMetabaseDatabases(client);
  } finally {
    await client.cleanup();
  }
}

function metabaseDatabaseLabel(database: DiscoveredMetabaseDatabase): string {
  const detail = [database.engine].filter(Boolean).join(', ');
  return detail ? `${database.id}: ${database.name} (${detail})` : `${database.id}: ${database.name}`;
}

async function chooseMetabaseDatabaseId(input: {
  state: SourcePromptState;
  prompts: KtxSetupSourcesPromptAdapter;
  deps: KtxSetupSourcesDeps;
  io: KtxCliIo;
}): Promise<number | 'back'> {
  const sourceUrl = input.state.sourceUrl;
  const sourceApiKeyRef = input.state.sourceApiKeyRef;
  if (sourceUrl && sourceApiKeyRef) {
    const discoverSpinner = createCliSpinner(input.io);
    discoverSpinner.start('Discovering Metabase databases…');
    try {
      const discovered = await (input.deps.discoverMetabaseDatabases ?? defaultDiscoverMetabaseDatabases)({
        sourceUrl,
        sourceApiKeyRef,
        sourceConnectionId: input.state.sourceConnectionId ?? 'metabase-main',
      });
      discoverSpinner.stop(`Found ${discovered.length} ${discovered.length === 1 ? 'database' : 'databases'}`);
      if (discovered.length === 1) {
        return discovered[0].id;
      }
      if (discovered.length > 1) {
        const selected = await input.prompts.autocomplete({
          message: 'Metabase database',
          placeholder: 'Type to search databases',
          options: [
            ...discovered
              .slice()
              .sort((left, right) => left.id - right.id)
              .map((database) => ({
                value: String(database.id),
                label: metabaseDatabaseLabel(database),
              })),
            { value: 'back', label: 'Back' },
          ],
        });
        return selected === 'back' ? 'back' : Number.parseInt(selected, 10);
      }
    } catch {
      // Discovery is a convenience. Fall back to the raw id prompt when credentials
      // are unavailable locally or the Metabase API cannot be reached yet.
      discoverSpinner.error('Could not reach Metabase — enter the database id manually');
    }
  }

  const databaseId = await promptText(input.prompts, { message: 'Metabase database id' });
  return databaseId === undefined ? 'back' : Number.parseInt(databaseId, 10);
}

function connectionIdPromptSteps(
  args: KtxSetupSourcesArgs,
  source: KtxSetupSourceType,
  prompts: KtxSetupSourcesPromptAdapter,
  defaultConnectionId: string,
): SourcePromptStep[] {
  if (args.sourceConnectionId) {
    return [];
  }
  return [
    async (state) => {
      const enteredConnectionId = await promptText(prompts, {
        message: connectionNamePrompt(sourceLabel(source)),
        placeholder: defaultConnectionId,
        initialValue: defaultConnectionId,
      });
      if (enteredConnectionId === undefined) {
        return 'back';
      }
      state.sourceConnectionId = enteredConnectionId.trim() || defaultConnectionId;
      return 'next';
    },
  ];
}

async function promptForInteractiveSource(
  args: KtxSetupSourcesArgs,
  source: KtxSetupSourceType,
  prompts: KtxSetupSourcesPromptAdapter,
  io: KtxCliIo,
  deps: KtxSetupSourcesDeps,
  defaultConnectionId = `${source}-main`,
  testGitRepo: KtxSetupSourcesDeps['testGitRepo'] = testRepoConnection,
  discoverMetabaseDatabaseList?: KtxSetupSourcesDeps['discoverMetabaseDatabases'],
): Promise<KtxSetupSourcesArgs | 'back'> {
  const initialState: SourcePromptState = { ...args, source, sourceLocation: sourceLocationFromArgs(args) };
  if (args.sourceConnectionId) {
    initialState.sourceConnectionId = args.sourceConnectionId;
  }
  const connectionSteps = connectionIdPromptSteps(args, source, prompts, defaultConnectionId);

  if (source === 'dbt' || source === 'metricflow' || source === 'lookml') {
    return await runSourcePromptSteps(initialState, (state) => [
      ...connectionSteps,
      async () => {
        const selectedLocation = await prompts.select({
          message: `${source} source location`,
          options: [
            { value: 'git', label: 'Git URL' },
            { value: 'path', label: 'Local path' },
            { value: 'back', label: 'Back' },
          ],
        });
        if (selectedLocation !== 'path' && selectedLocation !== 'git') {
          return 'back';
        }
        if (state.sourceLocation !== selectedLocation) {
          resetRepoLocationFields(state);
        }
        state.sourceLocation = selectedLocation;
        return 'next';
      },
      ...(state.sourceLocation === 'path'
        ? [
            async (currentState: SourcePromptState) => {
              const sourcePath = await promptText(prompts, {
                message: `${source} local path`,
                ...(currentState.sourcePath ? { initialValue: currentState.sourcePath } : {}),
              });
              if (sourcePath === undefined) return 'back';
              currentState.sourcePath = sourcePath;
              return 'next';
            },
          ]
        : []),
      ...(state.sourceLocation === 'git'
        ? [
            async (currentState: SourcePromptState) => {
              const sourceGitUrl = await promptText(prompts, {
                message: `${source} git URL`,
                ...(currentState.sourceGitUrl ? { initialValue: currentState.sourceGitUrl } : {}),
              });
              if (sourceGitUrl === undefined) return 'back';
              currentState.sourceGitUrl = sourceGitUrl;
              return 'next';
            },
            async (currentState: SourcePromptState) => {
              const branch = await promptText(prompts, {
                message: `${source} git branch`,
                initialValue: currentState.sourceBranch ?? 'main',
              });
              if (branch === undefined) return 'back';
              currentState.sourceBranch = branch || 'main';
              return 'next';
            },
          ]
        : []),
      ...(state.sourceLocation === 'git'
        ? [
            async (currentState: SourcePromptState) => {
              const result = await testGitRepo!({ repoUrl: currentState.sourceGitUrl! });
              if (result.ok) {
                delete currentState.sourceAuthTokenRef;
                prompts.log?.('Repository connected.');
                return 'next';
              }
              const authRef = await chooseGitAuthCredentialRef({
                prompts,
                projectDir: args.projectDir,
                source,
                connectionId: currentState.sourceConnectionId ?? `${source}-main`,
                existingRef: currentState.sourceAuthTokenRef,
                repoUrl: currentState.sourceGitUrl,
                testGitRepo,
              });
              if (authRef === 'back') return 'back';
              if (authRef) {
                currentState.sourceAuthTokenRef = authRef;
              } else {
                delete currentState.sourceAuthTokenRef;
              }
              return 'next';
            },
          ]
        : []),
      ...(state.sourceLocation
        ? [
            async (currentState: SourcePromptState) => {
              if (source === 'dbt') {
                let scanDir: string | undefined;
                if (currentState.sourceLocation === 'path' && currentState.sourcePath) {
                  scanDir = currentState.sourcePath;
                } else if (currentState.sourceLocation === 'git' && currentState.sourceGitUrl) {
                  const cloneSpinner = createCliSpinner(io);
                  cloneSpinner.start('Cloning repository to scan for dbt projects…');
                  try {
                    const cacheDir = await mkdtemp(join(tmpdir(), 'ktx-setup-dbt-scan-'));
                    const authToken = currentState.sourceAuthTokenRef
                      ? resolveKtxConfigReference(currentState.sourceAuthTokenRef, process.env)
                      : null;
                    await cloneOrPull({
                      repoUrl: currentState.sourceGitUrl,
                      authToken,
                      cacheDir,
                      branch: currentState.sourceBranch ?? 'main',
                    });
                    scanDir = cacheDir;
                    cloneSpinner.stop('Repository cloned');
                  } catch {
                    cloneSpinner.error('Could not clone repository');
                    // Clone failed — fall through to manual prompt
                  }
                }
                if (scanDir) {
                  try {
                    const subpaths = await findDbtProjectSubpaths(scanDir);
                    if (subpaths.length === 1) {
                      const found = subpaths[0]!;
                      if (found) {
                        currentState.sourceSubpath = found;
                        prompts.log?.(`Found dbt_project.yml in ${found}/`);
                      } else {
                        delete currentState.sourceSubpath;
                      }
                      return 'next';
                    }
                    if (subpaths.length > 1) {
                      const selected = await prompts.select({
                        message: 'Multiple dbt projects found — which one should ktx use?',
                        options: [
                          ...subpaths.map((p) => ({ value: p || '.', label: p || '(project root)' })),
                          { value: 'back', label: 'Back' },
                        ],
                      });
                      if (selected === 'back') return 'back';
                      const subpath = selected === '.' ? '' : selected;
                      if (subpath) {
                        currentState.sourceSubpath = subpath;
                      } else {
                        delete currentState.sourceSubpath;
                      }
                      return 'next';
                    }
                  } catch {
                    // Directory unreadable — fall through to manual prompt
                  }
                }
              }
              const subpath = await promptText(prompts, {
                message: sourceSubpathPrompt(source),
                placeholder: 'optional',
                ...(currentState.sourceSubpath ? { initialValue: currentState.sourceSubpath } : {}),
              });
              if (subpath === undefined) return 'back';
              if (subpath) {
                currentState.sourceSubpath = subpath;
              } else {
                delete currentState.sourceSubpath;
              }
              return 'next';
            },
          ]
        : []),
    ]);
  }

  if (source === 'metabase') {
    return await runSourcePromptSteps(initialState, () => [
      ...connectionSteps,
      async (state) => {
        const sourceUrl = await promptText(prompts, {
          message: 'Metabase URL',
          ...(state.sourceUrl ? { initialValue: state.sourceUrl } : {}),
        });
        if (sourceUrl === undefined) return 'back';
        state.sourceUrl = sourceUrl;
        return 'next';
      },
      async (state) => {
        const ref = await chooseSourceCredentialRef({
          prompts,
          projectDir: args.projectDir,
          label: 'Metabase API key',
          envName: 'METABASE_API_KEY',
          secretFileName: `${state.sourceConnectionId ?? 'metabase-main'}-api-key`,
          existingRef: state.sourceApiKeyRef,
        });
        if (ref === 'back') return 'back';
        state.sourceApiKeyRef = ref;
        return 'next';
      },
      async (state) => {
        const sourceWarehouseConnectionId = await chooseMappedWarehouseConnectionId({
          projectDir: args.projectDir,
          prompts,
        });
        if (sourceWarehouseConnectionId === 'back') return 'back';
        state.sourceWarehouseConnectionId = sourceWarehouseConnectionId;
        return 'next';
      },
      async (state) => {
        const databaseId = await chooseMetabaseDatabaseId({
          state,
          prompts,
          deps: { discoverMetabaseDatabases: discoverMetabaseDatabaseList },
          io,
        });
        if (databaseId === 'back') return 'back';
        state.metabaseDatabaseId = databaseId;
        return 'next';
      },
    ]);
  }

  if (source === 'looker') {
    return await runSourcePromptSteps(initialState, () => [
      ...connectionSteps,
      async (state) => {
        const sourceUrl = await promptText(prompts, {
          message: 'Looker base URL',
          ...(state.sourceUrl ? { initialValue: state.sourceUrl } : {}),
        });
        if (sourceUrl === undefined) return 'back';
        state.sourceUrl = sourceUrl;
        return 'next';
      },
      async (state) => {
        const sourceClientId = await promptText(prompts, {
          message: 'Looker client id',
          ...(state.sourceClientId ? { initialValue: state.sourceClientId } : {}),
        });
        if (sourceClientId === undefined) return 'back';
        state.sourceClientId = sourceClientId;
        return 'next';
      },
      async (state) => {
        const ref = await chooseSourceCredentialRef({
          prompts,
          projectDir: args.projectDir,
          label: 'Looker client secret',
          envName: 'LOOKER_CLIENT_SECRET',
          secretFileName: `${state.sourceConnectionId ?? 'looker-main'}-client-secret`,
          existingRef: state.sourceClientSecretRef,
        });
        if (ref === 'back') return 'back';
        state.sourceClientSecretRef = ref;
        return 'next';
      },
      async (state) => {
        const sourceWarehouseConnectionId = await chooseMappedWarehouseConnectionId({
          projectDir: args.projectDir,
          prompts,
        });
        if (sourceWarehouseConnectionId === 'back') return 'back';
        state.sourceWarehouseConnectionId = sourceWarehouseConnectionId;
        return 'next';
      },
      async (state) => {
        const lookerConnectionName = await promptText(prompts, {
          message: 'Looker connection name',
          placeholder: 'optional',
          ...(state.sourceTarget ? { initialValue: state.sourceTarget } : {}),
        });
        if (lookerConnectionName === undefined) return 'back';
        if (lookerConnectionName) {
          state.sourceTarget = lookerConnectionName;
        } else {
          delete state.sourceTarget;
        }
        return 'next';
      },
    ]);
  }

  return await runSourcePromptSteps(initialState, (state) => [
    ...connectionSteps,
    async (currentState) => {
      const ref = await chooseSourceCredentialRef({
        prompts,
        projectDir: args.projectDir,
        label: 'Notion integration token',
        envName: 'NOTION_TOKEN',
        secretFileName: `${currentState.sourceConnectionId ?? 'notion-main'}-token`,
        existingRef: currentState.sourceAuthTokenRef,
      });
      if (ref === 'back') return 'back';
      currentState.sourceAuthTokenRef = ref;
      return 'next';
    },
    async (currentState) => {
      const crawlMode = await prompts.select({
        message: 'Which Notion pages should ktx ingest?',
        options: [
          { value: 'all_accessible', label: 'All pages the integration can access' },
          { value: 'selected_roots', label: 'Specific pages and their subpages (choose them in a picker)' },
          { value: 'back', label: 'Back' },
        ],
      });
      if (crawlMode === 'back') return 'back';
      currentState.notionCrawlMode = crawlMode === 'all_accessible' ? 'all_accessible' : 'selected_roots';
      if (currentState.notionCrawlMode === 'all_accessible') {
        delete currentState.notionRootPageIds;
      }
      return 'next';
    },
    ...(state.notionCrawlMode === 'selected_roots'
      ? [
          async (currentState: SourcePromptState) => {
            const connectionId = currentState.sourceConnectionId ?? 'notion-main';
            const result = await (deps.pickNotionRootPages ?? pickNotionRootPages)(
              {
                connectionId,
                connection: {
                  driver: 'notion',
                  auth_token_ref: credentialRef(currentState.sourceAuthTokenRef, 'Notion token ref'),
                  crawl_mode: 'selected_roots',
                  root_page_ids: currentState.notionRootPageIds ?? [],
                  root_database_ids: [],
                  root_data_source_ids: [],
                },
              },
              io,
            );
            if (result.kind === 'back') {
              return 'back';
            }
            if (result.kind === 'unavailable') {
              io.stderr.write(`${result.message}\n`);
              return 'back';
            }
            currentState.notionRootPageIds = result.rootPageIds;
            return 'next';
          },
        ]
      : []),
  ]);
}

function existingConnectionIdsBySource(
  connections: Record<string, KtxProjectConnectionConfig>,
  source: KtxSetupSourceType,
): string[] {
  return Object.entries(connections)
    .filter(([, connection]) => String(connection.driver ?? '').toLowerCase() === source)
    .map(([connectionId]) => connectionId)
    .sort((left, right) => left.localeCompare(right));
}

function sourceTypeForConnection(connection: KtxProjectConnectionConfig): KtxSetupSourceType | null {
  const driver = String(connection.driver ?? '').toLowerCase();
  return SOURCE_OPTIONS.some((option) => option.value === driver) ? (driver as KtxSetupSourceType) : null;
}

function contextSourceEditTargets(connections: Record<string, KtxProjectConnectionConfig>): Array<{
  connectionId: string;
  source: KtxSetupSourceType;
}> {
  return Object.entries(connections)
    .map(([connectionId, connection]) => {
      const source = sourceTypeForConnection(connection);
      return source ? { connectionId, source } : null;
    })
    .filter((target): target is { connectionId: string; source: KtxSetupSourceType } => target !== null)
    .sort((left, right) => left.connectionId.localeCompare(right.connectionId));
}

function sourceChecklistForConnections(connections: Record<string, KtxProjectConnectionConfig>): {
  options: Array<{ value: KtxSetupSourceType; label: string; hint?: string }>;
  initialValues: KtxSetupSourceType[];
} {
  const initialValues: KtxSetupSourceType[] = [];
  const options = SOURCE_OPTIONS.map((option) => {
    const existingIds = existingConnectionIdsBySource(connections, option.value);
    if (existingIds.length === 0) {
      return option;
    }
    initialValues.push(option.value);
    return { ...option, hint: `configured: ${existingIds.join(', ')}` };
  });
  return { options, initialValues };
}

function defaultConnectionIdForSource(
  connections: Record<string, KtxProjectConnectionConfig>,
  source: KtxSetupSourceType,
): string {
  const base = `${source}-main`;
  if (!connections[base]) {
    return base;
  }
  let index = 2;
  while (connections[`${base}-${index}`]) {
    index += 1;
  }
  return `${base}-${index}`;
}

function firstStringRecordEntry(value: unknown): [string, string] | undefined {
  if (!isRecord(value)) return undefined;
  for (const [key, raw] of Object.entries(value)) {
    if (typeof raw === 'string' && raw.trim().length > 0) {
      return [key, raw.trim()];
    }
  }
  return undefined;
}

function applyRepoSourceArgs(
  args: KtxSetupSourcesArgs,
  input: { repoUrl?: string; sourceDir?: string; branch?: string; subpath?: string; authTokenRef?: string },
): void {
  if (input.sourceDir) {
    args.sourcePath = input.sourceDir;
  } else if (input.repoUrl?.startsWith('file:')) {
    args.sourcePath = fileURLToPath(input.repoUrl);
  } else if (input.repoUrl) {
    args.sourceGitUrl = input.repoUrl;
  }
  if (input.branch) args.sourceBranch = input.branch;
  if (input.subpath) args.sourceSubpath = input.subpath;
  if (input.authTokenRef) args.sourceAuthTokenRef = input.authTokenRef;
}

function sourceArgsFromExistingConnection(input: {
  args: KtxSetupSourcesArgs;
  source: KtxSetupSourceType;
  connectionId: string;
  connection: KtxProjectConnectionConfig;
}): KtxSetupSourcesArgs {
  const sourceArgs: KtxSetupSourcesArgs = {
    projectDir: input.args.projectDir,
    inputMode: input.args.inputMode,
    source: input.source,
    sourceConnectionId: input.connectionId,
    runInitialSourceIngest: input.args.runInitialSourceIngest,
    skipSources: input.args.skipSources,
  };

  if (input.source === 'dbt') {
    applyRepoSourceArgs(sourceArgs, {
      sourceDir: stringField(input.connection.source_dir),
      repoUrl: stringField(input.connection.repo_url),
      branch: stringField(input.connection.branch),
      subpath: stringField(input.connection.path),
      authTokenRef: stringField(input.connection.auth_token_ref),
    });
    const profilesPath = stringField(input.connection.profiles_path);
    const target = stringField(input.connection.target);
    const projectName = stringField(input.connection.project_name);
    if (profilesPath) sourceArgs.sourceProfilesPath = profilesPath;
    if (target) sourceArgs.sourceTarget = target;
    if (projectName) sourceArgs.sourceProjectName = projectName;
    return sourceArgs;
  }

  if (input.source === 'metricflow') {
    const metricflow = isRecord(input.connection.metricflow) ? input.connection.metricflow : {};
    applyRepoSourceArgs(sourceArgs, {
      repoUrl: stringField(metricflow.repoUrl),
      branch: stringField(metricflow.branch),
      subpath: stringField(metricflow.path),
      authTokenRef: stringField(metricflow.auth_token_ref),
    });
    return sourceArgs;
  }

  if (input.source === 'lookml') {
    applyRepoSourceArgs(sourceArgs, {
      repoUrl: stringField(input.connection.repoUrl),
      branch: stringField(input.connection.branch),
      subpath: stringField(input.connection.path),
      authTokenRef: stringField(input.connection.auth_token_ref),
    });
    const mappings = isRecord(input.connection.mappings) ? input.connection.mappings : {};
    const expectedLookerConnectionName = stringField(mappings.expectedLookerConnectionName);
    if (expectedLookerConnectionName) sourceArgs.sourceTarget = expectedLookerConnectionName;
    return sourceArgs;
  }

  if (input.source === 'metabase') {
    sourceArgs.sourceUrl = stringField(input.connection.api_url);
    sourceArgs.sourceApiKeyRef = stringField(input.connection.api_key_ref);
    const mappings = isRecord(input.connection.mappings) ? input.connection.mappings : {};
    const databaseMapping = firstStringRecordEntry(mappings.databaseMappings);
    if (databaseMapping) {
      sourceArgs.metabaseDatabaseId = Number.parseInt(databaseMapping[0], 10);
      sourceArgs.sourceWarehouseConnectionId = databaseMapping[1];
    }
    return sourceArgs;
  }

  if (input.source === 'looker') {
    sourceArgs.sourceUrl = stringField(input.connection.base_url);
    sourceArgs.sourceClientId = stringField(input.connection.client_id);
    sourceArgs.sourceClientSecretRef = stringField(input.connection.client_secret_ref);
    const mappings = isRecord(input.connection.mappings) ? input.connection.mappings : {};
    const connectionMapping = firstStringRecordEntry(mappings.connectionMappings);
    if (connectionMapping) {
      sourceArgs.sourceTarget = connectionMapping[0];
      sourceArgs.sourceWarehouseConnectionId = connectionMapping[1];
    }
    return sourceArgs;
  }

  sourceArgs.sourceAuthTokenRef = stringField(input.connection.auth_token_ref);
  sourceArgs.notionCrawlMode =
    input.connection.crawl_mode === 'all_accessible' ? 'all_accessible' : 'selected_roots';
  if (Array.isArray(input.connection.root_page_ids)) {
    sourceArgs.notionRootPageIds = input.connection.root_page_ids.filter(
      (pageId): pageId is string => typeof pageId === 'string',
    );
  }
  return sourceArgs;
}

async function promptEditedSourceConnection(input: {
  args: KtxSetupSourcesArgs;
  source: KtxSetupSourceType;
  connectionId: string;
  connection: KtxProjectConnectionConfig;
  prompts: KtxSetupSourcesPromptAdapter;
  io: KtxCliIo;
  testGitRepo?: KtxSetupSourcesDeps['testGitRepo'];
  pickNotionRootPages?: KtxSetupSourcesDeps['pickNotionRootPages'];
  discoverMetabaseDatabases?: KtxSetupSourcesDeps['discoverMetabaseDatabases'];
}): Promise<Extract<InteractiveSourceConnectionChoice, { kind: 'edited' }> | 'back'> {
  const sourceArgs = await promptForInteractiveSource(
    sourceArgsFromExistingConnection({
      args: input.args,
      source: input.source,
      connectionId: input.connectionId,
      connection: input.connection,
    }),
    input.source,
    input.prompts,
    input.io,
    {
      pickNotionRootPages: input.pickNotionRootPages,
      discoverMetabaseDatabases: input.discoverMetabaseDatabases,
    },
    input.connectionId,
    input.testGitRepo,
    input.discoverMetabaseDatabases,
  );
  return sourceArgs === 'back'
    ? 'back'
    : { kind: 'edited', connectionId: input.connectionId, args: sourceArgs };
}

async function chooseContextSourceToEdit(input: {
  projectDir: string;
  prompts: KtxSetupSourcesPromptAdapter;
}): Promise<{ connectionId: string; source: KtxSetupSourceType } | 'back'> {
  const project = await loadKtxProject({ projectDir: input.projectDir });
  const targets = contextSourceEditTargets(project.config.connections);
  if (targets.length === 0) return 'back';
  const choice = await input.prompts.select({
    message: 'Context source to edit',
    options: [
      ...targets.map((target) => ({
        value: target.connectionId,
        label: `${target.connectionId} (${sourceLabel(target.source)})`,
      })),
      { value: 'back', label: 'Back' },
    ],
  });
  if (choice === 'back') return 'back';
  const target = targets.find((candidate) => candidate.connectionId === choice);
  return target ?? 'back';
}

async function chooseInteractiveSourceConnection(input: {
  args: KtxSetupSourcesArgs;
  source: KtxSetupSourceType;
  connections: Record<string, KtxProjectConnectionConfig>;
  prompts: KtxSetupSourcesPromptAdapter;
  io: KtxCliIo;
  testGitRepo?: KtxSetupSourcesDeps['testGitRepo'];
  pickNotionRootPages?: KtxSetupSourcesDeps['pickNotionRootPages'];
  discoverMetabaseDatabases?: KtxSetupSourcesDeps['discoverMetabaseDatabases'];
}): Promise<InteractiveSourceConnectionChoice> {
  const existingIds = existingConnectionIdsBySource(input.connections, input.source);
  const defaultConnectionId = defaultConnectionIdForSource(input.connections, input.source);
  const label = sourceLabel(input.source);

  if (existingIds.length === 0) {
    const sourceArgs = await promptForInteractiveSource(
      input.args,
      input.source,
      input.prompts,
      input.io,
      {
        pickNotionRootPages: input.pickNotionRootPages,
        discoverMetabaseDatabases: input.discoverMetabaseDatabases,
      },
      defaultConnectionId,
      input.testGitRepo,
      input.discoverMetabaseDatabases,
    );
    return sourceArgs === 'back' ? 'back' : { kind: 'new', args: sourceArgs };
  }

  while (true) {
    const choice = await input.prompts.select({
      message: `Configure ${label}`,
      options: [
        ...existingIds.map((connectionId) => ({
          value: `existing:${connectionId}`,
          label: `Use existing ${label} connection: ${connectionId}`,
        })),
        ...existingIds.map((connectionId) => ({
          value: `edit:${connectionId}`,
          label: `Edit existing ${label} connection: ${connectionId}`,
        })),
        { value: 'new', label: `Add new ${label} connection` },
        { value: 'back', label: 'Back' },
      ],
    });
    if (choice === 'back') return 'back';
    if (choice.startsWith('existing:')) {
      const connectionId = choice.slice('existing:'.length);
      const connection = input.connections[connectionId];
      if (connection) {
        return { kind: 'existing', connectionId, connection };
      }
      continue;
    }
    if (choice.startsWith('edit:')) {
      const connectionId = choice.slice('edit:'.length);
      const connection = input.connections[connectionId];
      if (!connection) {
        continue;
      }
      const edited = await promptEditedSourceConnection({
        args: input.args,
        source: input.source,
        connectionId,
        connection,
        prompts: input.prompts,
        io: input.io,
        testGitRepo: input.testGitRepo,
        pickNotionRootPages: input.pickNotionRootPages,
        discoverMetabaseDatabases: input.discoverMetabaseDatabases,
      });
      if (edited === 'back') {
        continue;
      }
      return edited;
    }
    const sourceArgs = await promptForInteractiveSource(
      input.args,
      input.source,
      input.prompts,
      input.io,
      {
        pickNotionRootPages: input.pickNotionRootPages,
        discoverMetabaseDatabases: input.discoverMetabaseDatabases,
      },
      defaultConnectionId,
      input.testGitRepo,
      input.discoverMetabaseDatabases,
    );
    if (sourceArgs === 'back') {
      continue;
    }
    return { kind: 'new', args: sourceArgs };
  }
}

function buildConnection(source: KtxSetupSourceType, args: KtxSetupSourcesArgs): KtxProjectConnectionConfig {
  if (source === 'dbt') {
    return buildDbtConnection(args);
  }
  if (source === 'metricflow') {
    return buildMetricflowConnection(args);
  }
  if (source === 'metabase') {
    return buildMetabaseConnection(args);
  }
  if (source === 'looker') {
    return buildLookerConnection(args);
  }
  if (source === 'lookml') {
    return buildLookmlConnection(args);
  }
  return buildNotionConnection(args);
}

async function validateSource(
  source: KtxSetupSourceType,
  args: { projectDir: string; connectionId: string; connection: KtxProjectConnectionConfig },
  deps: KtxSetupSourcesDeps,
): Promise<SourceValidationResult> {
  if (source === 'dbt') {
    return await (deps.validateDbt ?? defaultValidateDbt)(args.connection);
  }
  if (source === 'metricflow') {
    return await (deps.validateMetricflow ?? defaultValidateMetricflow)(args.connection);
  }
  if (source === 'metabase') {
    return deps.validateMetabase
      ? await deps.validateMetabase(args.projectDir, args.connectionId)
      : { ok: true, detail: 'mapping validation runs after the connection is saved' };
  }
  if (source === 'looker') {
    return await (deps.validateLooker ?? defaultValidateLooker)(args.projectDir, args.connectionId);
  }
  if (source === 'lookml') {
    return await (deps.validateLookml ?? defaultValidateLookml)(args.connection);
  }
  return await (deps.validateNotion ?? defaultValidateNotion)(args.connection);
}

async function createSourceSetupRollback(projectDir: string): Promise<() => Promise<void>> {
  const project = await loadKtxProject({ projectDir });
  const previousConfig = project.config;
  const configPath = project.configPath;
  return async () => {
    await writeFile(configPath, serializeKtxProjectConfig(previousConfig), 'utf-8');
  };
}

function sourceConnectionId(input: {
  source: KtxSetupSourceType;
  sourceChoice: Exclude<InteractiveSourceConnectionChoice, 'back'>;
}): string {
  return input.sourceChoice.kind === 'existing' || input.sourceChoice.kind === 'edited'
    ? input.sourceChoice.connectionId
    : (input.sourceChoice.args.sourceConnectionId ?? `${input.source}-main`);
}

async function validateSourceConnectionAndMapping(input: {
  args: KtxSetupSourcesArgs;
  source: KtxSetupSourceType;
  connectionId: string;
  connection: KtxProjectConnectionConfig;
  prompts: KtxSetupSourcesPromptAdapter;
  io: KtxCliIo;
  deps: KtxSetupSourcesDeps;
}): Promise<ValidateResult> {
  const validateSpinner = createCliSpinner(input.io);
  validateSpinner.start(`Validating ${sourceLabel(input.source)} source…`);
  let validation: SourceValidationResult;
  try {
    validation = await validateSource(
      input.source,
      { projectDir: input.args.projectDir, connectionId: input.connectionId, connection: input.connection },
      input.deps,
    );
  } catch (error) {
    validateSpinner.error(`${sourceLabel(input.source)} source validation failed`);
    throw error;
  }
  if (!validation.ok) {
    validateSpinner.error(`${sourceLabel(input.source)} source validation failed`);
    input.io.stderr.write(`${validation.message}\n`);
    return { status: 'failed' };
  }
  validateSpinner.stop(`${sourceLabel(input.source)} source validated`);

  if (input.source === 'metabase' || input.source === 'looker') {
    input.prompts.log?.(`Validating ${sourceLabel(input.source)} mapping...`);
    const mappingCode = await (input.deps.runMapping ?? defaultRunMapping)(
      input.args.projectDir,
      input.connectionId,
      createSetupPrefixedIo(input.io),
    );
    if (mappingCode !== 0) {
      return { status: 'failed' };
    }
  }

  return { status: 'ok' };
}

async function saveValidateAndMaybeBuildSource(input: {
  args: KtxSetupSourcesArgs;
  source: KtxSetupSourceType;
  sourceChoice: Exclude<InteractiveSourceConnectionChoice, 'back'>;
  prompts: KtxSetupSourcesPromptAdapter;
  io: KtxCliIo;
  deps: KtxSetupSourcesDeps;
}): Promise<SourceSetupChoiceResult> {
  let latestChoice = input.sourceChoice;
  let latestConnectionId = sourceConnectionId({ source: input.source, sourceChoice: latestChoice });
  let latestConnection =
    latestChoice.kind === 'existing'
      ? latestChoice.connection
      : buildConnection(input.source, latestChoice.args);
  let configureCount = 0;
  let rollbackAfterConfigure: (() => Promise<void>) | undefined;

  const outcome = await runConnectionSetupWithRecovery({
    label: latestConnectionId,
    interactive: input.args.inputMode !== 'disabled',
    allowSkip: true,
    io: input.io,
    prompts: input.prompts,
    snapshot: async () => {
      rollbackAfterConfigure = await createSourceSetupRollback(input.args.projectDir);
      return rollbackAfterConfigure;
    },
    configure: async (): Promise<ConfigureResult> => {
      configureCount += 1;
      if (latestChoice.kind === 'existing' && configureCount === 1) {
        await ensureSourceAdapterEnabled(input.args.projectDir, input.source);
        return 'configured';
      }

      const project = await loadKtxProject({ projectDir: input.args.projectDir });
      const currentConnection = project.config.connections[latestConnectionId] ?? latestConnection;
      const useAlreadyPromptedArgs = configureCount === 1 && latestChoice.kind !== 'existing';
      const sourceArgs =
        useAlreadyPromptedArgs && latestChoice.kind !== 'existing'
          ? latestChoice.args
          : input.args.inputMode === 'disabled'
            ? sourceArgsFromExistingConnection({
                args: input.args,
                source: input.source,
                connectionId: latestConnectionId,
                connection: currentConnection,
              })
            : await promptForInteractiveSource(
                sourceArgsFromExistingConnection({
                  args: input.args,
                  source: input.source,
                  connectionId: latestConnectionId,
                  connection: currentConnection,
                }),
                input.source,
                input.prompts,
                input.io,
                {
                  pickNotionRootPages: input.deps.pickNotionRootPages,
                  discoverMetabaseDatabases: input.deps.discoverMetabaseDatabases,
                },
                latestConnectionId,
                input.deps.testGitRepo,
                input.deps.discoverMetabaseDatabases,
              );

      if (sourceArgs === 'back') {
        return 'back';
      }

      latestConnectionId = sourceArgs.sourceConnectionId ?? latestConnectionId;
      latestConnection = buildConnection(input.source, sourceArgs);
      latestChoice =
        latestChoice.kind === 'new'
          ? { kind: 'new', args: sourceArgs }
          : { kind: 'edited', connectionId: latestConnectionId, args: sourceArgs };

      await writeSourceConnection(
        input.args.projectDir,
        latestConnectionId,
        latestConnection,
        sourceAdapter(input.source),
        input.io,
      );
      return 'configured';
    },
    validate: () =>
      validateSourceConnectionAndMapping({
        args: input.args,
        source: input.source,
        connectionId: latestConnectionId,
        connection: latestConnection,
        prompts: input.prompts,
        io: input.io,
        deps: input.deps,
      }),
  });

  if (outcome !== 'ready') {
    return { status: outcome };
  }

  if (input.args.runInitialSourceIngest) {
    const ingestResult = await runInitialSourceIngestWithRecovery({
      args: input.args,
      connectionId: latestConnectionId,
      io: input.io,
      prompts: input.prompts,
      deps: input.deps,
    });
    if (ingestResult === 'failed') {
      await rollbackAfterConfigure?.();
      return { status: 'failed' };
    }
    if (ingestResult === 'back') {
      await rollbackAfterConfigure?.();
      return { status: 'back' };
    }
  } else {
    input.io.stdout.write(`│  Context source ${latestConnectionId} saved. It will be built during the context build step.\n`);
  }

  return { status: 'ready', connectionId: latestConnectionId };
}

export async function runKtxSetupSourcesStep(
  args: KtxSetupSourcesArgs,
  io: KtxCliIo,
  deps: KtxSetupSourcesDeps = {},
): Promise<KtxSetupSourcesResult> {
  try {
    if (args.skipSources) {
      await markSourcesComplete(args.projectDir);
      io.stdout.write('│  Context source setup skipped.\n');
      return { status: 'skipped', projectDir: args.projectDir };
    }

    if (args.source) {
      assertSourceCredentialFlags(args.source, args);
    }

    const prompts = deps.prompts ?? createPromptAdapter();
    const project = await loadKtxProject({ projectDir: args.projectDir });
    if (!hasPrimarySource(project.config)) {
      const message = 'Connect a database before adding context sources.';
      if (args.source) {
        io.stderr.write(`${message}\n`);
        return { status: 'failed', projectDir: args.projectDir };
      }
      if (args.inputMode !== 'disabled') {
        io.stdout.write(`│  ${message}\n`);
        return { status: 'skipped', projectDir: args.projectDir };
      }
    }

    while (true) {
      const contextSourceChecklist = sourceChecklistForConnections(
        (await loadKtxProject({ projectDir: args.projectDir })).config.connections,
      );
      const selected = args.source
        ? [args.source]
        : args.inputMode === 'disabled'
          ? []
          : await prompts.multiselect({
              message: withMultiselectNavigation('Which context sources should ktx ingest?'),
              options: contextSourceChecklist.options,
              ...(contextSourceChecklist.initialValues.length > 0
                ? { initialValues: contextSourceChecklist.initialValues }
                : {}),
              required: false,
            });
      if (selected.includes('back')) {
        return { status: 'back', projectDir: args.projectDir };
      }
      if (selected.length === 0) {
        if (args.inputMode === 'disabled') {
          io.stderr.write('Missing context source selection: pass --source or --skip-sources.\n');
          return { status: 'missing-input', projectDir: args.projectDir };
        }
        await markSourcesComplete(args.projectDir);
        io.stdout.write('│  No context sources selected.\n');
        return { status: 'skipped', projectDir: args.projectDir };
      }

      const readyConnectionIds: string[] = [];
      let returnToSourceSelection = false;
      for (const source of selected as KtxSetupSourceType[]) {
        const sourceChoice = args.source
          ? ({ kind: 'new', args } as const)
          : await chooseInteractiveSourceConnection({
              args,
              source,
              connections: (await loadKtxProject({ projectDir: args.projectDir })).config.connections,
              prompts,
              io,
              testGitRepo: deps.testGitRepo,
              pickNotionRootPages: deps.pickNotionRootPages,
              discoverMetabaseDatabases: deps.discoverMetabaseDatabases,
            });
        if (sourceChoice === 'back') {
          if (args.source) {
            return { status: 'back', projectDir: args.projectDir };
          }
          returnToSourceSelection = true;
          break;
        }
        const choiceResult = await saveValidateAndMaybeBuildSource({
          args,
          source,
          sourceChoice,
          prompts,
          io,
          deps,
        });
        if (choiceResult.status === 'failed') {
          if (args.source) {
            return { status: 'failed', projectDir: args.projectDir };
          }
          prompts.log?.('Edit the connection or pick a different source to continue.');
          returnToSourceSelection = true;
          break;
        }
        if (choiceResult.status === 'back') {
          if (args.source) {
            return { status: 'back', projectDir: args.projectDir };
          }
          returnToSourceSelection = true;
          break;
        }
        if (choiceResult.status === 'skip') {
          continue;
        }
        if (choiceResult.status === 'ready') {
          if (!readyConnectionIds.includes(choiceResult.connectionId)) {
            readyConnectionIds.push(choiceResult.connectionId);
          }
        }
      }

      if (returnToSourceSelection) {
        continue;
      }

      if (readyConnectionIds.length > 0 && !args.source && args.inputMode !== 'disabled') {
        let restartSourceSelection = false;
        while (true) {
          const addMore = await prompts.select({
            message: `${readyConnectionIds.length} context source${readyConnectionIds.length > 1 ? 's' : ''} configured (${readyConnectionIds.join(', ')}). Add another?`,
            options: [
              { value: 'done', label: 'Done adding context sources' },
              { value: 'edit', label: 'Edit an existing context source' },
              { value: 'add', label: 'Add another context source' },
            ],
          });
          if (addMore === 'add') {
            restartSourceSelection = true;
            break;
          }
          if (addMore === 'edit') {
            const editTarget = await chooseContextSourceToEdit({ projectDir: args.projectDir, prompts });
            if (editTarget === 'back') {
              continue;
            }
            const projectForEdit = await loadKtxProject({ projectDir: args.projectDir });
            const connection = projectForEdit.config.connections[editTarget.connectionId];
            if (!connection) {
              continue;
            }
            const sourceChoice = await promptEditedSourceConnection({
              args,
              source: editTarget.source,
              connectionId: editTarget.connectionId,
              connection,
              prompts,
              io,
              testGitRepo: deps.testGitRepo,
              pickNotionRootPages: deps.pickNotionRootPages,
              discoverMetabaseDatabases: deps.discoverMetabaseDatabases,
            });
            if (sourceChoice === 'back') {
              continue;
            }
            const choiceResult = await saveValidateAndMaybeBuildSource({
              args,
              source: editTarget.source,
              sourceChoice,
              prompts,
              io,
              deps,
            });
            if (choiceResult.status === 'failed') {
              prompts.log?.('Edit the connection or pick a different source to continue.');
              continue;
            }
            if (choiceResult.status === 'back') {
              continue;
            }
            if (choiceResult.status === 'skip') {
              continue;
            }
            if (choiceResult.status === 'ready') {
              if (!readyConnectionIds.includes(choiceResult.connectionId)) {
                readyConnectionIds.push(choiceResult.connectionId);
              }
            }
            continue;
          }
          break;
        }
        if (restartSourceSelection) {
          continue;
        }
      }

      await markSourcesComplete(args.projectDir);
      return { status: 'ready', projectDir: args.projectDir, connectionIds: readyConnectionIds };
    }
  } catch (error) {
    writePrefixedLines((chunk) => io.stderr.write(chunk), errorMessage(error));
    return { status: 'failed', projectDir: args.projectDir };
  }
}
