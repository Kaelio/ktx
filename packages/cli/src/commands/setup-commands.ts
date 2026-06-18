import { type Command, InvalidArgumentError, Option } from '@commander-js/extra-typings';
import type { KtxCliCommandContext } from '../cli-program.js';
import { resolveCommandProjectDir } from '../cli-program.js';
import type { KtxSetupDatabaseDriver } from '../setup-databases.js';
import { isKtxSetupLlmBackend, type KtxSetupLlmBackend } from '../setup-models.js';
import type { KtxSetupSourceType } from '../setup-sources.js';

async function runSetupArgs(
  context: KtxCliCommandContext,
  args: Parameters<NonNullable<typeof context.deps.setup>>[0],
) {
  const runner = context.deps.setup ?? (await import('../setup.js')).runKtxSetup;
  context.setExitCode(await runner(args, context.io));
}

function positiveInteger(value: string): number {
  const parsed = Number.parseInt(value, 10);
  if (!Number.isInteger(parsed) || parsed <= 0) {
    throw new InvalidArgumentError(`Expected a positive integer, received ${value}`);
  }
  return parsed;
}

function embeddingBackend(value: string): 'openai' | 'sentence-transformers' {
  if (value === 'openai' || value === 'sentence-transformers') {
    return value;
  }
  throw new InvalidArgumentError(`invalid choice '${value}'`);
}

function llmBackend(value: string): KtxSetupLlmBackend {
  if (isKtxSetupLlmBackend(value)) {
    return value;
  }
  throw new InvalidArgumentError(`invalid choice '${value}'`);
}

function databaseDriver(value: string): KtxSetupDatabaseDriver {
  if (
    value === 'sqlite' ||
    value === 'postgres' ||
    value === 'mysql' ||
    value === 'clickhouse' ||
    value === 'sqlserver' ||
    value === 'bigquery' ||
    value === 'snowflake'
  ) {
    return value;
  }
  throw new InvalidArgumentError(`invalid choice '${value}'`);
}

function sourceType(value: string): KtxSetupSourceType {
  if (
    value === 'dbt' ||
    value === 'metricflow' ||
    value === 'metabase' ||
    value === 'looker' ||
    value === 'lookml' ||
    value === 'notion'
  ) {
    return value;
  }
  throw new InvalidArgumentError(`invalid choice '${value}'`);
}

function positiveNumber(value: string): number {
  const parsed = Number.parseInt(value, 10);
  if (!Number.isInteger(parsed) || parsed <= 0) {
    throw new InvalidArgumentError(`Expected a positive integer, received ${value}`);
  }
  return parsed;
}

function optionWasSpecified(command: Command, optionName: string): boolean {
  const commandWithSources = command as Command & {
    getOptionValueSource?: (name: string) => string | undefined;
    getOptionValueSourceWithGlobals?: (name: string) => string | undefined;
  };
  const source =
    commandWithSources.getOptionValueSourceWithGlobals?.(optionName) ??
    commandWithSources.getOptionValueSource?.(optionName);
  return source !== undefined && source !== 'default';
}

function shouldShowSetupEntryMenu(
  options: {
    agents?: boolean;
    target?: string;
    global?: boolean;
    local?: boolean;
    installDir?: string;
    skipAgents?: boolean;
    yes?: boolean;
    input?: boolean;
    llmBackend?: KtxSetupLlmBackend;
    anthropicApiKeyEnv?: string;
    anthropicApiKeyFile?: string;
    vertexProject?: string;
    vertexLocation?: string;
    skipLlm?: boolean;
    embeddingBackend?: string;
    embeddingApiKeyEnv?: string;
    embeddingApiKeyFile?: string;
    skipEmbeddings?: boolean;
    database?: KtxSetupDatabaseDriver[];
    databaseConnectionId?: string[];
    databaseUrl?: string;
    databaseSchema?: string[];
    enableQueryHistory?: boolean;
    disableQueryHistory?: boolean;
    queryHistoryWindowDays?: number;
    queryHistoryMinExecutions?: number;
    queryHistoryServiceAccountPattern?: string[];
    queryHistoryRedactionPattern?: string[];
    skipDatabases?: boolean;
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
    notionCrawlMode?: string;
    notionRootPageId?: string[];
    skipSources?: boolean;
  },
  command: Command,
): boolean {
  if (options.database && options.database.length > 0) {
    return false;
  }
  if (options.databaseConnectionId && options.databaseConnectionId.length > 0) {
    return false;
  }
  if (options.databaseSchema && options.databaseSchema.length > 0) {
    return false;
  }
  if (options.queryHistoryServiceAccountPattern && options.queryHistoryServiceAccountPattern.length > 0) {
    return false;
  }
  if (options.queryHistoryRedactionPattern && options.queryHistoryRedactionPattern.length > 0) {
    return false;
  }
  if (options.notionRootPageId && options.notionRootPageId.length > 0) {
    return false;
  }

  return ![
    'agents',
    'target',
    'global',
    'local',
    'installDir',
    'skipAgents',
    'yes',
    'input',
    'llmBackend',
    'anthropicApiKeyEnv',
    'anthropicApiKeyFile',
    'vertexProject',
    'vertexLocation',
    'skipLlm',
    'embeddingBackend',
    'embeddingApiKeyEnv',
    'embeddingApiKeyFile',
    'skipEmbeddings',
    'databaseUrl',
    'enableQueryHistory',
    'disableQueryHistory',
    'queryHistoryWindowDays',
    'queryHistoryMinExecutions',
    'skipDatabases',
    'source',
    'sourceConnectionId',
    'sourcePath',
    'sourceGitUrl',
    'sourceBranch',
    'sourceSubpath',
    'sourceAuthTokenRef',
    'sourceUrl',
    'sourceApiKeyRef',
    'sourceClientId',
    'sourceClientSecretRef',
    'sourceWarehouseConnectionId',
    'sourceProjectName',
    'sourceProfilesPath',
    'sourceTarget',
    'metabaseDatabaseId',
    'notionCrawlMode',
    'skipSources',
  ].some((optionName) => optionWasSpecified(command, optionName));
}

export function registerSetupCommands(program: Command, context: KtxCliCommandContext): void {
  const setup = program
    .command('setup')
    .description('Set up or resume a local ktx project')
    .addOption(new Option('--project-dir <path>', 'ktx project directory').hideHelp())
    .option('--agents', 'Install agent integration only', false)
    .addOption(
      new Option('--target <target>', 'Agent target').choices([
        'claude-code',
        'claude-desktop',
        'codex',
        'cursor',
        'opencode',
        'universal',
      ]),
    )
    .option('--global', 'Install agent integration into the global target scope', false)
    .option('--local', 'Install Claude Code MCP config into the private per-project ~/.claude.json scope', false)
    .option(
      '--install-dir <path>',
      'Directory to install project-scoped agent config into (defaults to the ktx project directory)',
    )
    .addOption(new Option('--skip-agents', 'Leave agent integration incomplete for now').hideHelp().default(false))
    .option('--yes', 'Accept project creation and runtime install defaults where setup confirms', false)
    .option('--no-input', 'Disable interactive terminal input')
    .addOption(new Option('--llm-backend <backend>', 'LLM backend').argParser(llmBackend).hideHelp())
    .addOption(
      new Option('--anthropic-api-key-env <name>', 'Environment variable containing the Anthropic API key').hideHelp(),
    )
    .addOption(
      new Option('--anthropic-api-key-file <path>', 'File containing the Anthropic API key').hideHelp(),
    )
    .addOption(new Option('--vertex-project <project>', 'Google Vertex AI project ID, env:NAME, or file:/path').hideHelp())
    .addOption(new Option('--vertex-location <location>', 'Google Vertex AI location, env:NAME, or file:/path').hideHelp())
    .addOption(new Option('--skip-llm', 'Leave LLM setup incomplete for now').hideHelp().default(false))
    .addOption(new Option('--embedding-backend <backend>', 'Embedding backend').argParser(embeddingBackend).hideHelp())
    .addOption(
      new Option(
        '--embedding-api-key-env <name>',
        'Environment variable containing the embedding provider API key',
      ).hideHelp(),
    )
    .addOption(
      new Option('--embedding-api-key-file <path>', 'File containing the embedding provider API key').hideHelp(),
    )
    .addOption(new Option('--skip-embeddings', 'Leave embedding setup incomplete for now').hideHelp().default(false))
    .addOption(
      new Option('--database <driver>', 'Database driver to configure; repeatable')
        .argParser((value, previous: KtxSetupDatabaseDriver[]) => {
          return [...previous, databaseDriver(value)];
        })
        .default([] as KtxSetupDatabaseDriver[])
        .hideHelp(),
    )
    .addOption(
      new Option('--database-connection-id <id>', 'Existing selected connection id or new connection id')
        .argParser((value, previous: string[]) => [...previous, value])
        .default([] as string[])
        .hideHelp(),
    )
    .addOption(
      new Option('--database-url <url>', 'URL, env:NAME, or file:/path for one new URL-style database connection').hideHelp(),
    )
    .addOption(
      new Option('--database-schema <schema>', 'Database schema to include; repeatable')
        .argParser((value, previous: string[]) => [...previous, value])
        .default([] as string[])
        .hideHelp(),
    )
    .addOption(
      new Option('--enable-query-history', 'Enable query history when the selected database supports it')
        .hideHelp()
        .default(false),
    )
    .addOption(
      new Option('--disable-query-history', 'Disable query history for the selected database').hideHelp().default(false),
    )
    .addOption(
      new Option('--query-history-window-days <number>', 'Query-history lookback window')
        .argParser(positiveInteger)
        .hideHelp(),
    )
    .addOption(
      new Option('--query-history-min-executions <number>', 'Minimum executions for a query-history template')
        .argParser(positiveInteger)
        .hideHelp(),
    )
    .addOption(
      new Option('--query-history-service-account-pattern <pattern>', 'Query-history service-account regex; repeatable')
        .argParser((value, previous: string[]) => [...previous, value])
        .default([] as string[])
        .hideHelp(),
    )
    .addOption(
      new Option('--query-history-redaction-pattern <pattern>', 'Query-history SQL-literal redaction regex; repeatable')
        .argParser((value, previous: string[]) => [...previous, value])
        .default([] as string[])
        .hideHelp(),
    )
    .addOption(
      new Option('--skip-databases', 'Leave database setup incomplete; ktx cannot work until a database is added')
        .hideHelp()
        .default(false),
    )
    .addOption(new Option('--source <type>', 'Source connector type').argParser(sourceType).hideHelp())
    .addOption(new Option('--source-connection-id <id>', 'Connection id for source setup').hideHelp())
    .addOption(new Option('--source-path <path>', 'Local source path for dbt, MetricFlow, or LookML').hideHelp())
    .addOption(new Option('--source-git-url <url>', 'Git URL for dbt, MetricFlow, or LookML').hideHelp())
    .addOption(new Option('--source-branch <branch>', 'Git branch for source setup').hideHelp())
    .addOption(new Option('--source-subpath <path>', 'Repo subpath for source setup').hideHelp())
    .addOption(
      new Option(
        '--source-auth-token-ref <ref>',
        'env: or file: credential ref for source repo auth or Notion integration token',
      ).hideHelp(),
    )
    .addOption(new Option('--source-url <url>', 'Source service URL for Metabase or Looker').hideHelp())
    .addOption(new Option('--source-api-key-ref <ref>', 'env: or file: API key ref for Metabase').hideHelp())
    .addOption(new Option('--source-client-id <id>', 'Looker client id').hideHelp())
    .addOption(new Option('--source-client-secret-ref <ref>', 'env: or file: Looker client secret ref').hideHelp())
    .addOption(new Option('--source-warehouse-connection-id <id>', 'Mapped warehouse connection id').hideHelp())
    .addOption(new Option('--source-project-name <name>', 'dbt project name override').hideHelp())
    .addOption(new Option('--source-profiles-path <path>', 'dbt profiles path').hideHelp())
    .addOption(new Option('--source-target <target>', 'dbt target or source-specific mapping target').hideHelp())
    .addOption(new Option('--metabase-database-id <id>', 'Metabase database id to map').argParser(positiveNumber).hideHelp())
    .addOption(
      new Option('--notion-crawl-mode <mode>', 'Notion crawl mode')
        .choices(['all_accessible', 'selected_roots'])
        .hideHelp(),
    )
    .addOption(
      new Option('--notion-root-page-id <id>', 'Notion root page id; repeatable')
        .argParser((value, previous: string[]) => [...previous, value])
        .default([] as string[])
        .hideHelp(),
    )
    .addOption(new Option('--skip-sources', 'Mark optional source setup complete with no sources').hideHelp().default(false))
    .showHelpAfterError();

  setup.hook('preAction', (_thisCommand, actionCommand) => {
    context.writeDebug?.('setup', actionCommand);
  });

  setup.action(async (options, command) => {
    if (options.anthropicApiKeyEnv && options.anthropicApiKeyFile) {
      context.io.stderr.write(
        'Choose only one Anthropic credential source: --anthropic-api-key-env or --anthropic-api-key-file.\n',
      );
      context.setExitCode(1);
      return;
    }
    if (
      options.llmBackend &&
      options.llmBackend !== 'anthropic' &&
      (options.anthropicApiKeyEnv || options.anthropicApiKeyFile)
    ) {
      context.io.stderr.write('Anthropic API key flags are only valid with --llm-backend anthropic.\n');
      context.setExitCode(1);
      return;
    }
    if (options.llmBackend && options.llmBackend !== 'vertex' && (options.vertexProject || options.vertexLocation)) {
      context.io.stderr.write('Vertex AI flags are only valid with --llm-backend vertex.\n');
      context.setExitCode(1);
      return;
    }
    if (options.embeddingApiKeyEnv && options.embeddingApiKeyFile) {
      context.io.stderr.write(
        'Choose only one embedding credential source: --embedding-api-key-env or --embedding-api-key-file.\n',
      );
      context.setExitCode(1);
      return;
    }
    if (options.enableQueryHistory && options.disableQueryHistory) {
      context.io.stderr.write(
        'Choose only one query-history action: --enable-query-history or --disable-query-history.\n',
      );
      context.setExitCode(1);
      return;
    }
    if (options.sourcePath && options.sourceGitUrl) {
      context.io.stderr.write('Choose only one source location: --source-path or --source-git-url.\n');
      context.setExitCode(1);
      return;
    }
    if (options.skipSources && options.source) {
      context.io.stderr.write('Choose either --source or --skip-sources.\n');
      context.setExitCode(1);
      return;
    }
    if (options.local && options.global) {
      context.io.stderr.write('Choose only one agent scope: --local or --global.\n');
      context.setExitCode(1);
      return;
    }
    if (options.local && options.target && options.target !== 'claude-code') {
      context.io.stderr.write('--local is only supported with --target claude-code.\n');
      context.setExitCode(1);
      return;
    }
    if (options.installDir && (options.global || options.local)) {
      context.io.stderr.write('Choose either --install-dir or a scope flag (--global / --local), not both.\n');
      context.setExitCode(1);
      return;
    }
    if (options.installDir && options.target === 'claude-desktop') {
      context.io.stderr.write('--install-dir does not apply to --target claude-desktop, which is always global.\n');
      context.setExitCode(1);
      return;
    }

    const creatingDatabaseConnection = options.database.length > 0 || options.databaseUrl !== undefined;
    if (creatingDatabaseConnection && options.databaseConnectionId.length > 1) {
      context.io.stderr.write('Choose only one new database connection id when configuring a database.\n');
      context.setExitCode(1);
      return;
    }

    const resolvedAgentScope = options.local ? 'local' : options.global ? 'global' : 'project';
    const debugEnabled =
      ((command.optsWithGlobals ? command.optsWithGlobals() : command.opts()) as { debug?: unknown }).debug === true;
    await runSetupArgs(context, {
      command: 'run',
      projectDir: resolveCommandProjectDir(command),
      mode: 'auto',
      agents: options.agents === true,
      ...(options.target ? { target: options.target } : {}),
      agentScope: resolvedAgentScope,
      ...(options.installDir ? { installRoot: options.installDir } : {}),
      skipAgents: options.skipAgents === true,
      inputMode: options.input === false ? 'disabled' : 'auto',
      ...(debugEnabled ? { debug: true } : {}),
      yes: options.yes === true,
      cliVersion: context.packageInfo.version,
      ...(options.llmBackend ? { llmBackend: options.llmBackend } : {}),
      ...(options.anthropicApiKeyEnv ? { anthropicApiKeyEnv: options.anthropicApiKeyEnv } : {}),
      ...(options.anthropicApiKeyFile ? { anthropicApiKeyFile: options.anthropicApiKeyFile } : {}),
      ...(options.vertexProject ? { vertexProject: options.vertexProject } : {}),
      ...(options.vertexLocation ? { vertexLocation: options.vertexLocation } : {}),
      skipLlm: options.skipLlm === true,
      ...(options.embeddingBackend ? { embeddingBackend: options.embeddingBackend } : {}),
      ...(options.embeddingApiKeyEnv ? { embeddingApiKeyEnv: options.embeddingApiKeyEnv } : {}),
      ...(options.embeddingApiKeyFile ? { embeddingApiKeyFile: options.embeddingApiKeyFile } : {}),
      skipEmbeddings: options.skipEmbeddings === true,
      ...(options.database.length > 0 ? { databaseDrivers: options.database } : {}),
      ...(options.databaseConnectionId.length > 0 && creatingDatabaseConnection
        ? { databaseConnectionId: options.databaseConnectionId[0] }
        : {}),
      ...(options.databaseConnectionId.length > 0 && !creatingDatabaseConnection
        ? { databaseConnectionIds: options.databaseConnectionId }
        : {}),
      ...(options.databaseUrl ? { databaseUrl: options.databaseUrl } : {}),
      databaseSchemas: options.databaseSchema,
      ...(options.enableQueryHistory ? { enableQueryHistory: true } : {}),
      ...(options.disableQueryHistory ? { disableQueryHistory: true } : {}),
      ...(options.queryHistoryWindowDays !== undefined ? { queryHistoryWindowDays: options.queryHistoryWindowDays } : {}),
      ...(options.queryHistoryMinExecutions !== undefined
        ? { queryHistoryMinExecutions: options.queryHistoryMinExecutions }
        : {}),
      ...(options.queryHistoryServiceAccountPattern.length > 0
        ? { queryHistoryServiceAccountPatterns: options.queryHistoryServiceAccountPattern }
        : {}),
      ...(options.queryHistoryRedactionPattern.length > 0
        ? { queryHistoryRedactionPatterns: options.queryHistoryRedactionPattern }
        : {}),
      skipDatabases: options.skipDatabases === true,
      ...(options.source ? { source: options.source } : {}),
      ...(options.sourceConnectionId ? { sourceConnectionId: options.sourceConnectionId } : {}),
      ...(options.sourcePath ? { sourcePath: options.sourcePath } : {}),
      ...(options.sourceGitUrl ? { sourceGitUrl: options.sourceGitUrl } : {}),
      ...(options.sourceBranch ? { sourceBranch: options.sourceBranch } : {}),
      ...(options.sourceSubpath ? { sourceSubpath: options.sourceSubpath } : {}),
      ...(options.sourceAuthTokenRef ? { sourceAuthTokenRef: options.sourceAuthTokenRef } : {}),
      ...(options.sourceUrl ? { sourceUrl: options.sourceUrl } : {}),
      ...(options.sourceApiKeyRef ? { sourceApiKeyRef: options.sourceApiKeyRef } : {}),
      ...(options.sourceClientId ? { sourceClientId: options.sourceClientId } : {}),
      ...(options.sourceClientSecretRef ? { sourceClientSecretRef: options.sourceClientSecretRef } : {}),
      ...(options.sourceWarehouseConnectionId
        ? { sourceWarehouseConnectionId: options.sourceWarehouseConnectionId }
        : {}),
      ...(options.sourceProjectName ? { sourceProjectName: options.sourceProjectName } : {}),
      ...(options.sourceProfilesPath ? { sourceProfilesPath: options.sourceProfilesPath } : {}),
      ...(options.sourceTarget ? { sourceTarget: options.sourceTarget } : {}),
      ...(options.metabaseDatabaseId !== undefined ? { metabaseDatabaseId: options.metabaseDatabaseId } : {}),
      ...(options.notionCrawlMode ? { notionCrawlMode: options.notionCrawlMode } : {}),
      ...(options.notionRootPageId.length > 0 ? { notionRootPageIds: options.notionRootPageId } : {}),
      runInitialSourceIngest: false,
      skipSources: options.skipSources === true,
      showEntryMenu: shouldShowSetupEntryMenu(options, command),
    });
  });
}
