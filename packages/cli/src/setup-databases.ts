import { execFile as execFileCallback } from 'node:child_process';
import { readFile, writeFile } from 'node:fs/promises';
import { delimiter, dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { promisify } from 'node:util';
import { deriveFederatedConnection, FEDERATED_CONNECTION_ID } from './context/connections/federation.js';
import { getDriverRegistration } from './context/connections/drivers.js';
import { createLocalKtxLlmRuntimeFromConfig } from './context/llm/local-config.js';
import type { KtxLlmRuntimePort } from './context/llm/runtime-port.js';
import { queryHistoryDialectForConnection } from './context/ingest/adapters/historic-sql/connection-dialect.js';
import {
  proposeQueryHistoryServiceAccountFilters,
  type ProposeQueryHistoryServiceAccountFiltersInput,
  type QueryHistoryFilterProposal,
} from './context/ingest/adapters/historic-sql/query-history-filter-picker.js';
import { resolveQueryHistoryScopeFloor } from './context/ingest/adapters/historic-sql/scope-floor.js';
import type { HistoricSqlDialect } from './context/ingest/adapters/historic-sql/types.js';
import {
  runHistoricSqlReadinessProbe,
  type HistoricSqlProbeOutcome,
  type HistoricSqlReadinessProbe,
} from './context/ingest/historic-sql-probes.js';
import { type KtxProjectConnectionConfig, serializeKtxProjectConfig } from './context/project/config.js';
import { loadKtxProject } from './context/project/project.js';
import { markKtxSetupStateStepComplete, setKtxSetupDatabaseConnectionIds } from './context/project/setup-config.js';
import type { KtxTableListEntry } from './context/scan/types.js';
import { getKtxCliPackageInfo, type KtxCliIo } from './cli-runtime.js';
import {
  errorMessage,
  flushPrefixedBufferedCommandOutput,
  writePrefixedLines,
} from './clack.js';
import { runKtxConnection } from './connection.js';
import { createBufferedCommandIo } from './io/buffered-command-io.js';
import {
  runConnectionSetupWithRecovery,
  type ConfigureResult,
  type RecoveryOutcome,
  type ValidateResult,
} from './connection-recovery.js';
import {
  pickDatabaseScope as defaultPickDatabaseScope,
  type DatabaseScopePickResult,
  type PickDatabaseScopeArgs,
} from './database-tree-picker.js';
import { withMultiselectNavigation, withTextInputNavigation } from './prompt-navigation.js';
import { createKtxCliHistoricSqlRuntime } from './local-adapters.js';
import type { KtxManagedPythonInstallPolicy } from './managed-python-command.js';
import type { ManagedPythonCoreDaemonOptions } from './managed-python-http.js';
import { queryHistoryPullConfig } from './public-ingest.js';
import { runKtxScan } from './scan.js';
import { writeProjectLocalSecretReference } from './setup-secrets.js';
import { isDemoConnection } from './telemetry/demo-detect.js';
import { emitTelemetryEvent } from './telemetry/index.js';
import {
  createKtxSetupPromptAdapter,
  createKtxSetupUiAdapter,
  type KtxSetupPromptOption,
} from './setup-prompts.js';

const HISTORIC_SQL_WORK_UNIT_MAX_CONCURRENCY = 6;
const KTX_DEMO_START_URL = 'https://www.kaelio.com/start';
const execFileAsync = promisify(execFileCallback);

export type KtxSetupDatabaseDriver =
  | 'sqlite'
  | 'duckdb'
  | 'postgres'
  | 'mysql'
  | 'clickhouse'
  | 'sqlserver'
  | 'bigquery'
  | 'snowflake'
  | 'mongodb';

export interface KtxSetupDatabasesArgs {
  projectDir: string;
  inputMode: 'auto' | 'disabled';
  debug?: boolean;
  yes?: boolean;
  cliVersion?: string;
  runtimeInstallPolicy?: KtxManagedPythonInstallPolicy;
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
}

export type KtxSetupDatabasesResult =
  | {
      status: 'ready';
      projectDir: string;
      connectionIds: string[];
      skipSources?: boolean;
    }
  | { status: 'skipped'; projectDir: string }
  | { status: 'back'; projectDir: string }
  | { status: 'missing-input'; projectDir: string }
  | { status: 'failed'; projectDir: string };

/** @internal */
export interface KtxSetupDatabasesPromptAdapter {
  multiselect(options: {
    message: string;
    options: KtxSetupPromptOption[];
    required?: boolean;
    initialValues?: string[];
  }): Promise<string[]>;
  select(options: { message: string; options: KtxSetupPromptOption[] }): Promise<string>;
  autocompleteMultiselect(options: {
    message: string;
    options: KtxSetupPromptOption[];
    placeholder?: string;
    required?: boolean;
    maxItems?: number;
    initialValues?: string[];
  }): Promise<string[]>;
  text(options: { message: string; placeholder?: string; initialValue?: string }): Promise<string | undefined>;
  password(options: { message: string }): Promise<string | undefined>;
  cancel(message: string): void;
}

interface KtxSetupHistoricSqlProbeResult {
  ok: boolean;
  lines: string[];
}

export interface KtxSetupDatabasesDeps {
  prompts?: KtxSetupDatabasesPromptAdapter;
  testConnection?: (projectDir: string, connectionId: string, io: KtxCliIo) => Promise<number>;
  scanConnection?: (projectDir: string, connectionId: string, io: KtxCliIo) => Promise<number>;
  rebuildNativeSqlite?: (io: KtxCliIo) => Promise<number>;
  listSchemas?: (projectDir: string, connectionId: string) => Promise<string[]>;
  listTables?: (projectDir: string, connectionId: string, schemas?: string[]) => Promise<KtxTableListEntry[]>;
  pickDatabaseScope?: (args: PickDatabaseScopeArgs, io: KtxCliIo) => Promise<DatabaseScopePickResult>;
  historicSqlReadinessProbe?: HistoricSqlReadinessProbe;
  queryHistoryFilterPicker?: (
    input: ProposeQueryHistoryServiceAccountFiltersInput,
  ) => Promise<QueryHistoryFilterProposal>;
  createQueryHistoryLlmRuntime?: (
    projectDir: string,
    project: Awaited<ReturnType<typeof loadKtxProject>>,
  ) => KtxLlmRuntimePort | null;
}

const DRIVER_OPTIONS: Array<{ value: KtxSetupDatabaseDriver; label: string }> = [
  { value: 'postgres', label: 'PostgreSQL' },
  { value: 'bigquery', label: 'BigQuery' },
  { value: 'snowflake', label: 'Snowflake' },
  { value: 'mysql', label: 'MySQL' },
  { value: 'clickhouse', label: 'ClickHouse' },
  { value: 'sqlserver', label: 'SQL Server' },
  { value: 'mongodb', label: 'MongoDB' },
  { value: 'sqlite', label: 'SQLite' },
  { value: 'duckdb', label: 'DuckDB' },
];

const DRIVER_LABELS = Object.fromEntries(DRIVER_OPTIONS.map((option) => [option.value, option.label])) as Record<
  KtxSetupDatabaseDriver,
  string
>;

const HISTORIC_SQL_DIALECT_BY_DRIVER: Partial<Record<KtxSetupDatabaseDriver, HistoricSqlDialect>> = {
  snowflake: 'snowflake',
  bigquery: 'bigquery',
  postgres: 'postgres',
};

const DEFAULT_CONNECTION_IDS: Record<KtxSetupDatabaseDriver, string> = {
  sqlite: 'sqlite-local',
  duckdb: 'duckdb-local',
  postgres: 'postgres-warehouse',
  mysql: 'mysql-warehouse',
  clickhouse: 'clickhouse-warehouse',
  sqlserver: 'sqlserver-warehouse',
  bigquery: 'bigquery-warehouse',
  snowflake: 'snowflake-warehouse',
  mongodb: 'mongodb-source',
};

interface ScopeDiscoverySpec {
  noun: string;
  nounPlural: string;
  promptLabel: string;
  configArrayField: string;
  configSingleField?: string;
  suggest: ScopeSuggest;
}

interface ScopeSuggestion {
  excluded: Set<string>;
  suggested: Set<string>;
}

type ScopeSuggest = (values: string[]) => ScopeSuggestion;

const SUGGESTED_SCOPE_PATTERN = /^(mart|prod|analytics|core|dim|fact|gold)(_|$)/i;
const EXCLUDED_SCOPE_PATTERN = /^(information_schema|pg_catalog|pg_toast|_airbyte_|mysql$|performance_schema$|sys$)/i;

function defaultSuggest(values: string[]): ScopeSuggestion {
  const excluded = new Set(values.filter((value) => EXCLUDED_SCOPE_PATTERN.test(value)));
  const suggested = new Set(
    values.filter((value) => !excluded.has(value) && SUGGESTED_SCOPE_PATTERN.test(value)),
  );
  return { excluded, suggested };
}

const SCOPE_DISCOVERY_SPECS: Partial<Record<KtxSetupDatabaseDriver, ScopeDiscoverySpec>> = {
  postgres: {
    noun: 'schema',
    nounPlural: 'schemas',
    promptLabel: 'PostgreSQL schemas',
    configArrayField: 'schemas',
    configSingleField: 'schema',
    suggest: defaultSuggest,
  },
  mysql: {
    noun: 'database',
    nounPlural: 'databases',
    promptLabel: 'MySQL databases',
    configArrayField: 'schemas',
    configSingleField: 'schema',
    suggest: defaultSuggest,
  },
  clickhouse: {
    noun: 'database',
    nounPlural: 'databases',
    promptLabel: 'ClickHouse databases',
    configArrayField: 'databases',
    suggest: defaultSuggest,
  },
  mongodb: {
    noun: 'database',
    nounPlural: 'databases',
    promptLabel: 'MongoDB databases',
    configArrayField: 'databases',
    suggest: defaultSuggest,
  },
  sqlserver: {
    noun: 'schema',
    nounPlural: 'schemas',
    promptLabel: 'SQL Server schemas',
    configArrayField: 'schemas',
    configSingleField: 'schema',
    suggest: defaultSuggest,
  },
  bigquery: {
    noun: 'dataset',
    nounPlural: 'datasets',
    promptLabel: 'BigQuery datasets',
    configArrayField: 'dataset_ids',
    configSingleField: 'dataset_id',
    suggest: defaultSuggest,
  },
  snowflake: {
    noun: 'schema',
    nounPlural: 'schemas',
    promptLabel: 'Snowflake schemas',
    configArrayField: 'schema_names',
    configSingleField: 'schema_name',
    suggest: defaultSuggest,
  },
};

type UrlDriverType = Extract<KtxSetupDatabaseDriver, 'postgres' | 'mysql' | 'clickhouse' | 'sqlserver'>;

const DRIVER_CONNECTION_DEFAULTS: Record<UrlDriverType, { port: string }> = {
  postgres: { port: '5432' },
  mysql: { port: '3306' },
  clickhouse: { port: '8123' },
  sqlserver: { port: '1433' },
};

function driverLabel(driver: KtxSetupDatabaseDriver): string {
  return DRIVER_LABELS[driver];
}

function connectionNamePrompt(label: string): string {
  return `Name this ${label} connection\nktx will use this short name in commands and config. You can rename it now.`;
}

function missingConnectionDetailsPrompt(
  label: string,
  canReturnToDriverSelection: boolean,
): { message: string; options: Array<{ value: string; label: string }> } {
  const backDestination = canReturnToDriverSelection ? 'database selection' : 'the previous setup step';
  return {
    message:
      `Some ${label} connection details are missing.\n` +
      `Continue entering details, or go back to ${backDestination}.`,
    options: [
      { value: 'retry', label: `Continue entering ${label} details` },
      { value: 'back', label: `Back to ${backDestination}` },
    ],
  };
}

function createPromptAdapter(): KtxSetupDatabasesPromptAdapter {
  return createKtxSetupPromptAdapter({
    selectCancelValue: 'back',
    multiselectCancelValue: 'back',
    confirmEmptyOptionalMultiselect: true,
  });
}

function normalizeDriver(driver: string | undefined): KtxSetupDatabaseDriver | null {
  const normalized = String(driver ?? '').toLowerCase();
  if (normalized === 'postgresql') return 'postgres';
  if (normalized === 'sqlite3') return 'sqlite';
  return DRIVER_OPTIONS.some((option) => option.value === normalized) ? (normalized as KtxSetupDatabaseDriver) : null;
}

function unique(values: string[]): string[] {
  return [...new Set(values.filter((value) => value.trim().length > 0))];
}

function assertSafeDatabaseConnectionId(connectionId: string): void {
  if (!/^[a-zA-Z0-9_][a-zA-Z0-9_-]*$/.test(connectionId)) {
    throw new Error(`Unsafe connection id: ${connectionId}`);
  }
}

function stringConfigField(connection: KtxProjectConnectionConfig | undefined, field: string): string | undefined {
  const value = connection?.[field];
  return typeof value === 'string' && value.trim().length > 0 ? value.trim() : undefined;
}

function numberConfigField(connection: KtxProjectConnectionConfig | undefined, field: string): number | undefined {
  const value = connection?.[field];
  return typeof value === 'number' && Number.isFinite(value) ? value : undefined;
}

function contextRecord(connection: KtxProjectConnectionConfig | undefined): Record<string, unknown> {
  const context = connection?.context;
  return context && typeof context === 'object' && !Array.isArray(context) ? (context as Record<string, unknown>) : {};
}

function queryHistoryConfigRecord(connection: KtxProjectConnectionConfig | undefined): Record<string, unknown> | null {
  const queryHistory = contextRecord(connection).queryHistory;
  return queryHistory && typeof queryHistory === 'object' && !Array.isArray(queryHistory)
    ? (queryHistory as Record<string, unknown>)
    : null;
}

function withQueryHistoryConfig(
  connection: KtxProjectConnectionConfig,
  queryHistory: Record<string, unknown>,
): KtxProjectConnectionConfig {
  return {
    ...connection,
    context: {
      ...contextRecord(connection),
      queryHistory,
    },
  };
}

function setupHistoricSqlProbeResult(
  outcome: HistoricSqlProbeOutcome | null,
): KtxSetupHistoricSqlProbeResult {
  if (!outcome) {
    return { ok: true, lines: [] };
  }
  if (outcome.ok) {
    const { detail, warnings } = outcome.runner.formatSuccessDetail(outcome.result);
    return {
      ok: true,
      lines: [`  OK ${detail}`, ...warnings.map((warning) => `  ! ${warning}`)],
    };
  }
  const advice = outcome.runner.fixAdvice(outcome.error);
  return {
    ok: false,
    lines: [`  FAIL ${advice.failHeadline}`, `  Fix: ${advice.remediation}`],
  };
}

async function defaultListSchemas(projectDir: string, connectionId: string): Promise<string[]> {
  const project = await loadKtxProject({ projectDir });
  const connection = project.config.connections[connectionId];
  const driver = normalizeDriver(connection?.driver);
  const registration = driver ? getDriverRegistration(driver) : undefined;
  if (!registration) return [];

  const connectorModule = await registration.load();
  if (!connectorModule.isConnectionConfig(connection)) return [];

  const connector = connectorModule.createScanConnector({ connectionId, connection, projectDir });
  try {
    return await connector.listSchemas();
  } finally {
    await connector.cleanup?.();
  }
}

function configuredSchemas(connection: KtxProjectConnectionConfig | undefined, driver: KtxSetupDatabaseDriver): string[] | undefined {
  if (!connection) return undefined;
  const spec = SCOPE_DISCOVERY_SPECS[driver];
  if (!spec) return undefined;
  const values = configuredScopeValues(connection, spec);
  return values.length > 0 ? values : undefined;
}

async function defaultListTables(
  projectDir: string,
  connectionId: string,
  schemasOverride?: string[],
): Promise<KtxTableListEntry[]> {
  const project = await loadKtxProject({ projectDir });
  const connection = project.config.connections[connectionId];
  const driver = normalizeDriver(connection?.driver);
  const schemas = schemasOverride ?? (driver ? configuredSchemas(connection, driver) : undefined);
  const registration = driver ? getDriverRegistration(driver) : undefined;
  if (!registration) return [];

  const connectorModule = await registration.load();
  if (!connectorModule.isConnectionConfig(connection)) return [];

  const connector = connectorModule.createScanConnector({ connectionId, connection, projectDir });
  try {
    return await connector.listTables(schemas);
  } finally {
    await connector.cleanup?.();
  }
}

function existingConnectionIdsByDriver(
  connections: Record<string, KtxProjectConnectionConfig>,
  driver: KtxSetupDatabaseDriver,
): string[] {
  return Object.entries(connections)
    .filter(([, connection]) => normalizeDriver(connection.driver) === driver)
    .map(([connectionId]) => connectionId)
    .sort((left, right) => left.localeCompare(right));
}

function configuredPrimaryConnectionIds(
  connections: Record<string, KtxProjectConnectionConfig>,
  setupConnectionIds: string[] | undefined,
): string[] {
  const configuredIds =
    setupConnectionIds
      ?.filter((connectionId) => normalizeDriver(connections[connectionId]?.driver) !== null)
      .filter((connectionId, index, ids) => ids.indexOf(connectionId) === index) ?? [];
  if (configuredIds.length > 0) {
    return configuredIds;
  }
  return Object.entries(connections)
    .filter(([, connection]) => normalizeDriver(connection.driver) !== null)
    .map(([connectionId]) => connectionId)
    .sort((left, right) => left.localeCompare(right));
}

function configuredPrimaryDrivers(
  connections: Record<string, KtxProjectConnectionConfig>,
  connectionIds: string[],
): KtxSetupDatabaseDriver[] {
  const configured = new Set(
    connectionIds
      .map((connectionId) => normalizeDriver(connections[connectionId]?.driver))
      .filter((driver): driver is KtxSetupDatabaseDriver => driver !== null),
  );
  return DRIVER_OPTIONS.map((option) => option.value).filter((driver) => configured.has(driver));
}

function configuredPrimarySourcesPrompt(connectionIds: string[]): {
  message: string;
  options: Array<{ value: string; label: string }>;
} {
  return {
    message: `Databases configured: ${connectionIds.join(', ')}\nWhat would you like to do?`,
    options: [
      { value: 'continue', label: 'Continue to context sources' },
      { value: 'skip-sources', label: 'Skip context sources' },
      { value: 'edit', label: 'Edit an existing database' },
      { value: 'add', label: 'Add another database' },
    ],
  };
}

function pushUniqueConnectionId(connectionIds: string[], connectionId: string): void {
  if (!connectionIds.includes(connectionId)) {
    connectionIds.push(connectionId);
  }
}

function defaultConnectionIdForDriver(
  connections: Record<string, KtxProjectConnectionConfig>,
  driver: KtxSetupDatabaseDriver,
): string {
  const base = DEFAULT_CONNECTION_IDS[driver];
  if (!connections[base]) {
    return base;
  }
  let index = 2;
  while (connections[`${base}-${index}`]) {
    index += 1;
  }
  return `${base}-${index}`;
}

async function promptText(
  prompts: KtxSetupDatabasesPromptAdapter,
  message: string,
  fallback?: string,
): Promise<string | undefined> {
  const value = await prompts.text({
    message: withTextInputNavigation(message),
    ...(fallback ? { placeholder: fallback, initialValue: fallback } : {}),
  });
  if (value === undefined) {
    return undefined;
  }
  return value.trim() || fallback || '';
}

function urlHasCredentials(url: string): boolean {
  return /:\/\/[^/\s]*@/.test(url);
}

function normalizeInputReference(value: string): string {
  if (value.startsWith('$') && /^\$[A-Z_][A-Z0-9_]*$/i.test(value)) {
    return `env:${value.slice(1)}`;
  }
  return value;
}

function normalizeFileReference(value: string): string {
  const normalized = normalizeInputReference(value);
  if (normalized.startsWith('env:') || normalized.startsWith('file:')) {
    return normalized;
  }
  return `file:${normalized}`;
}

function displayFileReference(value: string | undefined): string | undefined {
  if (value === undefined) return undefined;
  if (value.startsWith('file:')) return value.slice('file:'.length);
  return value;
}

function scriptedScopeConfigForDriver(
  driver: KtxSetupDatabaseDriver,
  databaseSchemas: string[],
): Record<string, unknown> {
  if (databaseSchemas.length === 0) return {};
  const registration = getDriverRegistration(driver);
  if (!registration?.scopeConfigKey) return {};
  return { [registration.scopeConfigKey]: databaseSchemas };
}

function databaseNameFromLiteralUrl(url: string): string | undefined {
  if (url.startsWith('env:') || url.startsWith('file:')) {
    return undefined;
  }
  try {
    return new URL(url).pathname.replace(/^\/+/, '') || undefined;
  } catch {
    return undefined;
  }
}

async function promptCredential(input: {
  prompts: KtxSetupDatabasesPromptAdapter;
  message: string;
  projectDir: string;
  connectionId: string;
  secretName: string;
}): Promise<string | null | 'back'> {
  const value = await input.prompts.password({
    message: withTextInputNavigation(input.message),
  });
  if (value === undefined) return 'back';
  if (!value.trim()) return null;

  const normalized = normalizeInputReference(value.trim());
  if (normalized.startsWith('env:') || normalized.startsWith('file:')) {
    return normalized;
  }

  return await writeProjectLocalSecretReference({
    projectDir: input.projectDir,
    fileName: `${input.connectionId}-${input.secretName}`,
    value: normalized,
  });
}

async function buildFieldsConnectionConfig(input: {
  driver: UrlDriverType;
  connectionId: string;
  args: KtxSetupDatabasesArgs;
  prompts: KtxSetupDatabasesPromptAdapter;
  existingConnection?: KtxProjectConnectionConfig;
}): Promise<KtxProjectConnectionConfig | null | 'back'> {
  const label = driverLabel(input.driver);
  const defaults = DRIVER_CONNECTION_DEFAULTS[input.driver];

  const host = await promptText(
    input.prompts,
    `${label} host`,
    stringConfigField(input.existingConnection, 'host') ?? 'localhost',
  );
  if (host === undefined) return 'back';
  if (!host) return null;

  const portStr = await promptText(
    input.prompts,
    `${label} port`,
    String(numberConfigField(input.existingConnection, 'port') ?? defaults.port),
  );
  if (portStr === undefined) return 'back';
  const port = Number(portStr || defaults.port);

  const database = await promptText(
    input.prompts,
    `${label} database name`,
    stringConfigField(input.existingConnection, 'database'),
  );
  if (database === undefined) return 'back';
  if (!database) return null;

  const username = await promptText(
    input.prompts,
    `${label} username`,
    stringConfigField(input.existingConnection, 'username'),
  );
  if (username === undefined) return 'back';
  if (!username) return null;

  let passwordRef: string | undefined;
  {
    const credentialResult = await promptCredential({
      prompts: input.prompts,
      message: `${label} password`,
      projectDir: input.args.projectDir,
      connectionId: input.connectionId,
      secretName: 'password', // pragma: allowlist secret
    });
    if (credentialResult === 'back') return 'back';
    if (credentialResult) passwordRef = credentialResult;
    if (!credentialResult) passwordRef = stringConfigField(input.existingConnection, 'password');
  }

  return {
    driver: input.driver,
    host,
    port,
    database,
    username,
    ...(passwordRef ? { password: passwordRef } : {}),
    ...scriptedScopeConfigForDriver(input.driver, input.args.databaseSchemas),
  };
}

async function buildPastedUrlConnectionConfig(input: {
  driver: UrlDriverType;
  connectionId: string;
  args: KtxSetupDatabasesArgs;
  prompts: KtxSetupDatabasesPromptAdapter;
  existingConnection?: KtxProjectConnectionConfig;
}): Promise<KtxProjectConnectionConfig | null | 'back'> {
  const label = driverLabel(input.driver);
  const rawUrl = await promptText(
    input.prompts,
    `${label} connection URL`,
    stringConfigField(input.existingConnection, 'url'),
  );
  if (rawUrl === undefined) return 'back';
  if (!rawUrl) return null;

  const url = normalizeInputReference(rawUrl);

  if (url.startsWith('env:') || url.startsWith('file:')) {
    return {
      driver: input.driver,
      url,
      ...scriptedScopeConfigForDriver(input.driver, input.args.databaseSchemas),
    };
  }

  const database = input.driver === 'clickhouse' ? databaseNameFromLiteralUrl(url) : undefined;
  if (urlHasCredentials(url)) {
    const ref = await writeProjectLocalSecretReference({
      projectDir: input.args.projectDir,
      fileName: `${input.connectionId}-url`,
      value: url,
    });
    return {
      driver: input.driver,
      url: ref,
      ...(database ? { database } : {}),
      ...scriptedScopeConfigForDriver(input.driver, input.args.databaseSchemas),
    };
  }

  return {
    driver: input.driver,
    url,
    ...(database ? { database } : {}),
    ...scriptedScopeConfigForDriver(input.driver, input.args.databaseSchemas),
  };
}

async function buildUrlConnectionConfig(input: {
  driver: UrlDriverType;
  connectionId: string;
  args: KtxSetupDatabasesArgs;
  prompts: KtxSetupDatabasesPromptAdapter;
  existingConnection?: KtxProjectConnectionConfig;
}): Promise<KtxProjectConnectionConfig | null | 'back'> {
  if (input.args.inputMode === 'disabled' && !input.args.databaseUrl) return null;

  if (input.args.databaseUrl) {
    const url = normalizeInputReference(input.args.databaseUrl);
    if (urlHasCredentials(url)) {
      const database = input.driver === 'clickhouse' ? databaseNameFromLiteralUrl(url) : undefined;
      const ref = await writeProjectLocalSecretReference({
        projectDir: input.args.projectDir,
        fileName: `${input.connectionId}-url`,
        value: url,
      });
      return {
        driver: input.driver,
        url: ref,
        ...(database ? { database } : {}),
        ...scriptedScopeConfigForDriver(input.driver, input.args.databaseSchemas),
      };
    }
    const database = input.driver === 'clickhouse' ? databaseNameFromLiteralUrl(url) : undefined;
    return {
      driver: input.driver,
      url,
      ...(database ? { database } : {}),
      ...scriptedScopeConfigForDriver(input.driver, input.args.databaseSchemas),
    };
  }

  const label = driverLabel(input.driver);
  while (true) {
    const choice = await input.prompts.select({
      message: `How do you want to connect to ${label}?`,
      options: [
        { value: 'url', label: 'Paste a connection URL' },
        { value: 'fields', label: 'Enter connection details (host, port, database, user)' },
        { value: 'back', label: 'Back' },
      ],
    });
    if (choice === 'back') return 'back';
    const result =
      choice === 'url' ? await buildPastedUrlConnectionConfig(input) : await buildFieldsConnectionConfig(input);
    if (result === 'back') continue;
    return result;
  }
}

async function buildMongoConnectionConfig(input: {
  connectionId: string;
  args: KtxSetupDatabasesArgs;
  prompts: KtxSetupDatabasesPromptAdapter;
  existingConnection?: KtxProjectConnectionConfig;
}): Promise<KtxProjectConnectionConfig | null | 'back'> {
  if (input.args.inputMode === 'disabled' && !input.args.databaseUrl) return null;

  const rawUrl =
    input.args.databaseUrl ??
    (await promptText(
      input.prompts,
      'MongoDB connection URL\nFor example mongodb+srv://user:pass@cluster.example.net/app.', // pragma: allowlist secret
      stringConfigField(input.existingConnection, 'url'),
    ));
  if (rawUrl === undefined) return 'back';
  if (!rawUrl) return null;

  const url = normalizeInputReference(rawUrl);
  const scope = scriptedScopeConfigForDriver('mongodb', input.args.databaseSchemas);

  if (url.startsWith('env:') || url.startsWith('file:')) {
    return { driver: 'mongodb', url, ...scope };
  }
  if (urlHasCredentials(url)) {
    const ref = await writeProjectLocalSecretReference({
      projectDir: input.args.projectDir,
      fileName: `${input.connectionId}-url`,
      value: url,
    });
    return { driver: 'mongodb', url: ref, ...scope };
  }
  return { driver: 'mongodb', url, ...scope };
}

async function buildConnectionConfig(input: {
  driver: KtxSetupDatabaseDriver;
  connectionId: string;
  args: KtxSetupDatabasesArgs;
  prompts: KtxSetupDatabasesPromptAdapter;
  existingConnection?: KtxProjectConnectionConfig;
}): Promise<KtxProjectConnectionConfig | null | 'back'> {
  const { driver, args, prompts } = input;
  if (driver === 'sqlite') {
    if (args.inputMode === 'disabled' && !args.databaseUrl) return null;
    const path =
      args.databaseUrl ??
      (await promptText(
        prompts,
        'SQLite database file\nEnter a relative or absolute path, for example ./warehouse.sqlite.',
        stringConfigField(input.existingConnection, 'path'),
      ));
    if (path === undefined) return 'back';
    return path ? { driver: 'sqlite', path } : null;
  }
  if (driver === 'duckdb') {
    if (args.inputMode === 'disabled' && !args.databaseUrl) return null;
    const path =
      args.databaseUrl ??
      (await promptText(
        prompts,
        'DuckDB database file\nEnter a relative or absolute path, for example ./warehouse.duckdb.',
        stringConfigField(input.existingConnection, 'path'),
      ));
    if (path === undefined) return 'back';
    return path ? { driver: 'duckdb', path } : null;
  }
  if (driver === 'postgres' || driver === 'mysql' || driver === 'clickhouse' || driver === 'sqlserver') {
    return await buildUrlConnectionConfig({
      driver,
      connectionId: input.connectionId,
      args,
      prompts,
      existingConnection: input.existingConnection,
    });
  }
  if (driver === 'mongodb') {
    return await buildMongoConnectionConfig({
      connectionId: input.connectionId,
      args,
      prompts,
      existingConnection: input.existingConnection,
    });
  }
  if (driver === 'bigquery') {
    const credentialsPath = await promptText(
      prompts,
      'Path to service account JSON file',
      displayFileReference(stringConfigField(input.existingConnection, 'credentials_json')),
    );
    if (credentialsPath === undefined) return 'back';
    const location = await promptText(
      prompts,
      'BigQuery location\nPress Enter for US, or enter a location like EU.',
      stringConfigField(input.existingConnection, 'location') ?? 'US',
    );
    if (location === undefined) return 'back';
    if (!credentialsPath) return null;
    return {
      driver: 'bigquery',
      credentials_json: normalizeFileReference(credentialsPath),
      ...(location ? { location } : {}),
      ...scriptedScopeConfigForDriver('bigquery', args.databaseSchemas),
    };
  }
  if (driver === 'snowflake') {
    const account = await promptText(
      prompts,
      'Snowflake account identifier',
      stringConfigField(input.existingConnection, 'account'),
    );
    if (account === undefined) return 'back';
    const warehouse = await promptText(
      prompts,
      'Snowflake warehouse\nFor example ANALYTICS_WH.',
      stringConfigField(input.existingConnection, 'warehouse'),
    );
    if (warehouse === undefined) return 'back';
    const database = await promptText(
      prompts,
      'Snowflake database name',
      stringConfigField(input.existingConnection, 'database'),
    );
    if (database === undefined) return 'back';
    const username = await promptText(
      prompts,
      'Snowflake username',
      stringConfigField(input.existingConnection, 'username'),
    );
    if (username === undefined) return 'back';
    const authChoice = await prompts.select({
      message: 'Snowflake authentication method',
      options: [
        { value: 'password', label: 'Password' },
        { value: 'rsa', label: 'Key-pair (RSA / JWT)' },
        { value: 'back', label: 'Back' },
      ],
    });
    if (authChoice === 'back') return 'back';
    const authMethod: 'password' | 'rsa' = authChoice === 'rsa' ? 'rsa' : 'password';
    let passwordRef: string | null = null;
    let privateKeyInput: string | undefined;
    let passphraseRef: string | null = null;
    if (authMethod === 'password') {
      const ref = await promptCredential({
        prompts,
        message: 'Snowflake password',
        projectDir: args.projectDir,
        connectionId: input.connectionId,
        secretName: 'password', // pragma: allowlist secret
      });
      if (ref === 'back') return 'back'; // pragma: allowlist secret
      passwordRef = ref;
    } else {
      privateKeyInput = await promptText(
        prompts,
        'Path to Snowflake private key (PEM)\nFor example ~/.ssh/snowflake_rsa_key.p8, or $ENV_VAR / env:NAME / file:/abs/path.',
        displayFileReference(stringConfigField(input.existingConnection, 'privateKey')),
      );
      if (privateKeyInput === undefined) return 'back';
      const phr = await promptCredential({
        prompts,
        message: 'Private key passphrase (optional)\nPress Enter to skip.',
        projectDir: args.projectDir,
        connectionId: input.connectionId,
        secretName: 'snowflake-passphrase', // pragma: allowlist secret
      });
      if (phr === 'back') return 'back';
      passphraseRef = phr;
    }
    const role = await promptText(
      prompts,
      'Snowflake role (optional)\nPress Enter to skip.',
      stringConfigField(input.existingConnection, 'role'),
    );
    if (role === undefined) return 'back';
    if (authMethod === 'password') {
      const resolvedPasswordRef = passwordRef ?? stringConfigField(input.existingConnection, 'password');
      if (!account || !warehouse || !database || !username || !resolvedPasswordRef) return null;
      return {
        driver: 'snowflake',
        authMethod: 'password',
        account,
        warehouse,
        database,
        username,
        password: resolvedPasswordRef,
        ...(role ? { role } : {}),
      };
    }
    const resolvedPrivateKey = privateKeyInput
      ? normalizeFileReference(privateKeyInput)
      : stringConfigField(input.existingConnection, 'privateKey');
    if (!account || !warehouse || !database || !username || !resolvedPrivateKey) return null;
    const resolvedPassphrase = passphraseRef ?? stringConfigField(input.existingConnection, 'passphrase');
    return {
      driver: 'snowflake',
      authMethod: 'rsa',
      account,
      warehouse,
      database,
      username,
      privateKey: resolvedPrivateKey,
      ...(resolvedPassphrase ? { passphrase: resolvedPassphrase } : {}),
      ...(role ? { role } : {}),
    };
  }
  throw new Error(`Unsupported database driver: ${driver}`);
}

async function maybeApplyHistoricSqlConfig(input: {
  connection: KtxProjectConnectionConfig;
  driver: KtxSetupDatabaseDriver;
  args: KtxSetupDatabasesArgs;
  prompts: KtxSetupDatabasesPromptAdapter;
}): Promise<KtxProjectConnectionConfig | 'back'> {
  const dialect = HISTORIC_SQL_DIALECT_BY_DRIVER[input.driver];
  if (!dialect) {
    if (input.args.enableQueryHistory === true) {
      throw new Error(
        `Query history setup is only supported for Snowflake, BigQuery, and Postgres, not ${driverLabel(input.driver)}.`,
      );
    }
    return input.connection;
  }

  let enabled = input.args.enableQueryHistory === true;
  if (input.args.disableQueryHistory === true) {
    enabled = false;
  } else if (input.args.inputMode !== 'disabled' && input.args.enableQueryHistory !== true) {
    const choice = await input.prompts.select({
      message: `Enable query-history ingest for this ${driverLabel(input.driver)} connection?`,
      options: [
        { value: 'yes', label: 'Enable query history (recommended)' },
        { value: 'no', label: 'Do not enable query history' },
        { value: 'back', label: 'Back' },
      ],
    });
    if (choice === 'back') return 'back';
    if (choice === 'yes') {
      enabled = true;
    } else if (choice === 'no') {
      enabled = false;
    } else {
      return input.connection;
    }
  }

  const { dialect: _dialect, ...existing } = queryHistoryConfigRecord(input.connection) ?? {};

  if (!enabled) {
    return withQueryHistoryConfig(input.connection, { ...existing, enabled: false });
  }

  const existingFilters =
    existing.filters && typeof existing.filters === 'object' && !Array.isArray(existing.filters)
      ? (existing.filters as Record<string, unknown>)
      : {};
  const common: Record<string, unknown> = {
    ...existing,
    enabled: true,
    filters: historicSqlFiltersForSetup(input.args.queryHistoryServiceAccountPatterns, existingFilters),
  };

  if (dialect === 'postgres') {
    return withQueryHistoryConfig(input.connection, {
      ...common,
      minExecutions: input.args.queryHistoryMinExecutions ?? 5,
    });
  }

  return withQueryHistoryConfig(input.connection, {
    ...common,
    windowDays: input.args.queryHistoryWindowDays ?? 90,
    redactionPatterns: input.args.queryHistoryRedactionPatterns ?? [],
  });
}

function historicSqlFiltersForSetup(
  patterns: string[] | undefined,
  existingFilters: Record<string, unknown> = {},
) {
  const serviceAccountPatterns = patterns ?? [];
  return {
    ...existingFilters,
    dropTrivialProbes: true,
    ...(serviceAccountPatterns.length > 0
      ? {
          serviceAccounts: {
            patterns: serviceAccountPatterns,
            mode: 'exclude' as const,
          },
        }
      : {}),
  };
}

async function defaultTestConnection(projectDir: string, connectionId: string, io: KtxCliIo): Promise<number> {
  return await runKtxConnection({ command: 'test', projectDir, connectionId }, io);
}

async function defaultScanConnection(projectDir: string, connectionId: string, io: KtxCliIo): Promise<number> {
  return await runKtxScan(
    {
      command: 'run',
      projectDir,
      connectionId,
      mode: 'structural',
      detectRelationships: false,
      dryRun: false,
    },
    io,
  );
}

function envWithCurrentNodeFirst(env: NodeJS.ProcessEnv = process.env): NodeJS.ProcessEnv {
  return {
    ...env,
    PATH: `${dirname(process.execPath)}${delimiter}${env.PATH ?? ''}`,
  };
}

function errorTextProperty(error: unknown, property: 'stderr' | 'stdout'): string {
  if (typeof error !== 'object' || error === null || !(property in error)) {
    return '';
  }
  const value = (error as Record<typeof property, unknown>)[property];
  return typeof value === 'string' ? value : '';
}

function commandFailureOutput(error: unknown): string {
  const stderr = errorTextProperty(error, 'stderr');
  const stdout = errorTextProperty(error, 'stdout');
  const message = error instanceof Error ? error.message : String(error);
  return [stderr.trim(), stdout.trim(), message.trim()].filter((line) => line.length > 0).join('\n');
}

type PackageJsonScriptStatus = 'has-script' | 'exists' | 'missing';

async function packageJsonScriptStatus(
  packageJsonPath: string,
  scriptName: string,
): Promise<PackageJsonScriptStatus> {
  try {
    const parsed = JSON.parse(await readFile(packageJsonPath, 'utf-8')) as unknown;
    if (typeof parsed !== 'object' || parsed === null || !('scripts' in parsed)) {
      return 'exists';
    }
    const scripts = (parsed as { scripts?: unknown }).scripts;
    return typeof scripts === 'object' && scripts !== null && scriptName in scripts ? 'has-script' : 'exists';
  } catch {
    return 'missing';
  }
}

async function nativeSqliteRebuildCommand(): Promise<{ cwd: string; args: string[] }> {
  let dir = dirname(fileURLToPath(import.meta.url));
  let packageRoot: string | undefined;
  while (true) {
    const status = await packageJsonScriptStatus(join(dir, 'package.json'), 'native:rebuild');
    if (status === 'has-script') {
      return { cwd: dir, args: ['run', 'native:rebuild'] };
    }
    if (status === 'exists') {
      packageRoot ??= dir;
    }

    const parent = dirname(dir);
    if (parent === dir) {
      return { cwd: packageRoot ?? process.cwd(), args: ['rebuild', 'better-sqlite3'] };
    }
    dir = parent;
  }
}

async function defaultRebuildNativeSqlite(io: KtxCliIo): Promise<number> {
  const command = await nativeSqliteRebuildCommand();
  try {
    await execFileAsync('pnpm', command.args, {
      cwd: command.cwd,
      env: envWithCurrentNodeFirst(),
      maxBuffer: 1024 * 1024 * 16,
    });
    return 0;
  } catch (error) {
    writePrefixedLines((chunk) => io.stderr.write(chunk), commandFailureOutput(error));
    return typeof (error as { code?: unknown })?.code === 'number' ? (error as { code: number }).code : 1;
  }
}

function nativeSqliteAbiMismatchDetail(output: string): string | null {
  const mentionsBetterSqlite = /\bbetter-sqlite3\b|better_sqlite3/i.test(output);
  const mentionsAbiMismatch = /compiled against a different Node\.js version|NODE_MODULE_VERSION/i.test(output);
  if (!mentionsBetterSqlite || !mentionsAbiMismatch) {
    return null;
  }

  const versionMatch = output.match(
    /compiled against[\s\S]*?NODE_MODULE_VERSION\s+(\d+)[\s\S]*?requires[\s\S]*?NODE_MODULE_VERSION\s+(\d+)/i,
  );
  if (!versionMatch) {
    return 'better-sqlite3 native module could not load for the current Node.js runtime.';
  }

  return `better-sqlite3 was compiled for NODE_MODULE_VERSION ${versionMatch[1]}, but this Node.js requires ${versionMatch[2]}.`;
}

function readOutputValue(output: string, label: string): string | undefined {
  const escapedLabel = label.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  const match = new RegExp(`^\\s*${escapedLabel}:\\s*(.+?)\\s*$`, 'im').exec(output);
  return match?.[1]?.trim();
}

function summarizeScanChanges(output: string): string {
  const newTables = Number(readOutputValue(output, 'New tables') ?? NaN);
  const changedTables = Number(readOutputValue(output, 'Changed tables') ?? NaN);
  const removedTables = Number(readOutputValue(output, 'Removed tables') ?? NaN);
  const parts: string[] = [];

  if (Number.isFinite(newTables) && newTables > 0) {
    parts.push(`${newTables} new ${newTables === 1 ? 'table' : 'tables'}`);
  }
  if (Number.isFinite(changedTables) && changedTables > 0) {
    parts.push(`${changedTables} changed ${changedTables === 1 ? 'table' : 'tables'}`);
  }
  if (Number.isFinite(removedTables) && removedTables > 0) {
    parts.push(`${removedTables} removed ${removedTables === 1 ? 'table' : 'tables'}`);
  }
  if (parts.length > 0) {
    return parts.join(' · ');
  }

  const semanticComparison = /^\s*Semantic layer comparison found\s+(.+?)\s*$/im.exec(output)?.[1]?.trim();
  if (semanticComparison) {
    return semanticComparison;
  }

  return 'no table changes';
}

function writeSetupSection(io: KtxCliIo, title: string, lines: string[]): void {
  io.stdout.write(`◇  ${title}\n`);
  for (const line of lines) {
    io.stdout.write(`│  ${line}\n`);
  }
  io.stdout.write('│\n');
}

async function writeConnectionConfig(input: {
  projectDir: string;
  connectionId: string;
  connection: KtxProjectConnectionConfig;
  io?: KtxCliIo;
}): Promise<void> {
  const project = await loadKtxProject({ projectDir: input.projectDir });
  const config = {
    ...project.config,
    connections: {
      ...project.config.connections,
      [input.connectionId]: input.connection,
    },
  };
  await writeFile(project.configPath, serializeKtxProjectConfig(config), 'utf-8');
  if (input.io) {
    await emitTelemetryEvent({
      name: 'connection_added',
      projectDir: input.projectDir,
      io: input.io,
      fields: {
        driver: String(input.connection.driver ?? 'unknown').toLowerCase(),
        isDemoConnection: isDemoConnection(input.connectionId, input.connection),
      },
    });
  }

  const queryHistory = queryHistoryConfigRecord(input.connection);
  if (queryHistory?.enabled === true) {
    await ensureHistoricSqlIngestDefaults(input.projectDir);
  }

  if (input.io) {
    const federationNotice = federationNoticeFor(config.connections, input.projectDir);
    if (federationNotice) {
      writeSetupSection(input.io, 'Federated connection available', [federationNotice]);
    }
  }
}

/** @internal */
export function federationNoticeFor(
  connections: Record<string, KtxProjectConnectionConfig>,
  projectDir: string,
): string | null {
  const descriptor = deriveFederatedConnection(connections, projectDir);
  if (!descriptor) {
    return null;
  }
  const names = descriptor.members.map((m) => m.connectionId).join(', ');
  return `Detected ${descriptor.members.length} attach-compatible databases (${names}). Run a cross-database join as read-only SQL against \`${FEDERATED_CONNECTION_ID}\` (ktx sql -c ${FEDERATED_CONNECTION_ID} "SELECT ..."), using catalog-qualified table names.`;
}

async function disableConnectionQueryHistory(projectDir: string, connectionId: string): Promise<void> {
  const project = await loadKtxProject({ projectDir });
  const connection = project.config.connections[connectionId];
  if (!connection) {
    return;
  }
  const existing = queryHistoryConfigRecord(connection) ?? {};
  await writeConnectionConfig({
    projectDir,
    connectionId,
    connection: withQueryHistoryConfig(connection, { ...existing, enabled: false }),
  });
}

function okValidateResult(): ValidateResult {
  return { status: 'ok' };
}

function backValidateResult(): ValidateResult {
  return { status: 'back' };
}

function failedValidateResult(): ValidateResult {
  return { status: 'failed' };
}

function queryHistoryUnavailableResult(projectDir: string, connectionId: string): ValidateResult {
  return {
    status: 'failed',
    extraActions: [
      {
        value: 'disable-query-history',
        label: 'Disable query history and retry',
        run: () => disableConnectionQueryHistory(projectDir, connectionId),
      },
    ],
  };
}

async function createConnectionConfigRollback(projectDir: string, connectionId: string): Promise<() => Promise<void>> {
  const project = await loadKtxProject({ projectDir });
  const previousConnection = project.config.connections[connectionId];
  const hadPreviousConnection = previousConnection !== undefined;
  return async () => {
    const latest = await loadKtxProject({ projectDir });
    const connections = { ...latest.config.connections };
    if (hadPreviousConnection) {
      connections[connectionId] = previousConnection;
    } else {
      delete connections[connectionId];
    }
    await writeFile(
      latest.configPath,
      serializeKtxProjectConfig({
        ...latest.config,
        connections,
      }),
      'utf-8',
    );
  };
}

function withExistingPrimaryEditPromptDefaults(input: {
  previous: KtxProjectConnectionConfig;
  next: KtxProjectConnectionConfig;
  driver: KtxSetupDatabaseDriver;
}): KtxProjectConnectionConfig {
  const merged: KtxProjectConnectionConfig = { ...input.next };
  const spec = SCOPE_DISCOVERY_SPECS[input.driver];
  if (spec) {
    const nextArray = input.next[spec.configArrayField];
    const previousArray = input.previous[spec.configArrayField];
    if (
      !(Array.isArray(nextArray) && nextArray.length > 0) &&
      Array.isArray(previousArray) &&
      previousArray.length > 0
    ) {
      if (spec.configSingleField) {
        delete merged[spec.configSingleField];
      }
      merged[spec.configArrayField] = previousArray;
    } else if (
      !Object.hasOwn(input.next, spec.configArrayField) &&
      (!spec.configSingleField || !Object.hasOwn(input.next, spec.configSingleField))
    ) {
      if (!spec.configSingleField) {
        return merged;
      }
      const previousSingle = input.previous[spec.configSingleField];
      if (typeof previousSingle === 'string' && previousSingle.trim().length > 0) {
        merged[spec.configSingleField] = previousSingle;
      }
    }
  }
  if (!Object.hasOwn(input.next, 'enabled_tables') && Array.isArray(input.previous.enabled_tables)) {
    merged.enabled_tables = input.previous.enabled_tables;
  }
  if (!Object.hasOwn(input.next, 'context') && input.previous.context !== undefined) {
    merged.context = input.previous.context;
  }
  return merged;
}

function configuredScopeValues(
  connection: KtxProjectConnectionConfig | undefined,
  spec: ScopeDiscoverySpec,
): string[] {
  if (!connection) return [];
  const arrayVal = connection[spec.configArrayField];
  if (Array.isArray(arrayVal)) {
    return arrayVal
      .filter((v): v is string => typeof v === 'string' && v.trim().length > 0)
      .map((v) => v.trim());
  }
  if (!spec.configSingleField) {
    return [];
  }
  const singleVal = connection[spec.configSingleField];
  return typeof singleVal === 'string' && singleVal.trim().length > 0 ? [singleVal.trim()] : [];
}

async function writeScopeConfig(input: {
  projectDir: string;
  connectionId: string;
  values: string[];
  spec: ScopeDiscoverySpec;
}): Promise<void> {
  const project = await loadKtxProject({ projectDir: input.projectDir });
  const connection = project.config.connections[input.connectionId];
  if (!connection) return;
  const cleaned = Object.fromEntries(
    Object.entries(connection).filter(([key]) => key !== input.spec.configSingleField),
  ) as KtxProjectConnectionConfig;
  await writeConnectionConfig({
    projectDir: input.projectDir,
    connectionId: input.connectionId,
    connection: {
      ...cleaned,
      [input.spec.configArrayField]: unique(input.values),
    },
  });
}

async function promptCommaSeparatedScope(input: {
  prompts: KtxSetupDatabasesPromptAdapter;
  connectionId: string;
  spec: ScopeDiscoverySpec;
}): Promise<string[] | undefined> {
  const example =
    input.spec.nounPlural === 'datasets' ? 'sales, marketing' : 'SALES, MARKETING';
  const value = await promptText(
    input.prompts,
    `Enter ${input.spec.nounPlural} for ${input.connectionId} as a comma-separated list (e.g. ${example}).`,
  );
  if (value === undefined) return undefined;
  return unique(value.split(',').map((part) => part.trim()));
}

async function maybeConfigureDatabaseScope(input: {
  projectDir: string;
  connectionId: string;
  args: KtxSetupDatabasesArgs;
  deps: KtxSetupDatabasesDeps;
  io: KtxCliIo;
  prompts: KtxSetupDatabasesPromptAdapter;
  forcePrompt?: boolean;
}): Promise<ValidateResult> {
  const project = await loadKtxProject({ projectDir: input.projectDir });
  const connection = project.config.connections[input.connectionId];
  const driver = normalizeDriver(connection?.driver);
  const spec = driver ? SCOPE_DISCOVERY_SPECS[driver] : undefined;
  // Drivers with no scope spec are single-namespace (sqlite, duckdb): there is no
  // schema to choose, so skip the scope picker and ingest every table.
  if (!driver || !spec) return okValidateResult();

  const existingTables = connection?.enabled_tables;
  const hasExistingTables = Array.isArray(existingTables) && existingTables.length > 0;
  const existingScope = spec ? configuredScopeValues(connection, spec) : [];
  const hasExistingScope = !spec || existingScope.length > 0;

  if (hasExistingTables && hasExistingScope && input.forcePrompt !== true) {
    return okValidateResult();
  }

  const cliSchemas = input.args.databaseSchemas;

  if (input.args.inputMode === 'disabled') {
    if (!spec) {
      return okValidateResult();
    }
    if (cliSchemas.length > 0) {
      await writeScopeConfig({
        projectDir: input.projectDir,
        connectionId: input.connectionId,
        values: cliSchemas,
        spec,
      });
      const capitalNounPlural = spec.nounPlural[0]!.toUpperCase() + spec.nounPlural.slice(1);
      writeSetupSection(input.io, `${capitalNounPlural} saved for ${input.connectionId}`, [
        `✓ ${cliSchemas.join(', ')}`,
      ]);
      return okValidateResult();
    }
    if (existingScope.length > 0) {
      return okValidateResult();
    }
    writePrefixedLines(
      (chunk) => input.io.stderr.write(chunk),
      `No ${spec.nounPlural} configured for ${input.connectionId}. ` +
        `Pass --database-schema <${spec.noun}> (repeatable) or set ` +
        `connections.${input.connectionId}.${spec.configArrayField} in ktx.yaml.`,
    );
    return failedValidateResult();
  }

  if (spec && cliSchemas.length > 0) {
    await writeScopeConfig({
      projectDir: input.projectDir,
      connectionId: input.connectionId,
      values: cliSchemas,
      spec,
    });
  }

  writeSetupSection(input.io, 'Discovering tables', [`Connecting to ${input.connectionId}…`]);

  let effectiveCliSchemas = cliSchemas;
  let listedSchemas: string[];
  if (cliSchemas.length > 0) {
    listedSchemas = cliSchemas;
  } else if (!spec) {
    listedSchemas = [];
  } else {
    try {
      listedSchemas = await (input.deps.listSchemas ?? defaultListSchemas)(
        input.projectDir,
        input.connectionId,
      );
    } catch (error) {
      writePrefixedLines(
        (chunk) => input.io.stderr.write(chunk),
        `Could not discover ${spec.promptLabel.toLowerCase()} for ${input.connectionId}; ${errorMessage(error)}`,
      );
      const typed = await promptCommaSeparatedScope({
        prompts: input.prompts,
        connectionId: input.connectionId,
        spec,
      });
      if (typed === undefined) return backValidateResult();
      effectiveCliSchemas = typed;
      listedSchemas = typed;
      if (typed.length > 0) {
        await writeScopeConfig({
          projectDir: input.projectDir,
          connectionId: input.connectionId,
          values: typed,
          spec,
        });
      }
    }
  }
  const schemas = unique(listedSchemas);
  if (spec && schemas.length === 0) {
    return okValidateResult();
  }
  const schemaSuggestion =
    effectiveCliSchemas.length > 0
      ? { excluded: new Set<string>(), suggested: new Set(effectiveCliSchemas) }
      : spec?.suggest(schemas) ?? { excluded: new Set<string>(), suggested: new Set<string>() };
  const existingEnabled =
    hasExistingTables && input.forcePrompt === true
      ? (existingTables ?? []).filter((table): table is string => typeof table === 'string')
      : [];

  let pickResult: DatabaseScopePickResult;
  try {
    pickResult = await (input.deps.pickDatabaseScope ?? defaultPickDatabaseScope)(
      {
        connectionId: input.connectionId,
        schemaNoun: spec?.noun ?? 'schema',
        schemaNounPlural: spec?.nounPlural ?? 'schemas',
        schemas,
        schemaSuggestion,
        existing: { enabledTables: existingEnabled },
        supportsSchemaScope: spec !== undefined,
        initialSchemas: effectiveCliSchemas.length > 0 ? effectiveCliSchemas : undefined,
        prompts: input.prompts,
        listTablesForSchemas: (selectedSchemas) =>
          (input.deps.listTables ?? defaultListTables)(input.projectDir, input.connectionId, selectedSchemas),
      },
      input.io,
    );
  } catch (error) {
    const detail = errorMessage(error);
    writePrefixedLines(
      (chunk) => input.io.stderr.write(chunk),
      input.forcePrompt === true
        ? `Could not discover tables for ${input.connectionId}; edit was not saved. ${detail}`
        : `Could not discover tables for ${input.connectionId}; continuing without table filter. ${detail}`,
    );
    return input.forcePrompt === true ? failedValidateResult() : okValidateResult();
  }
  if (pickResult.kind === 'back') {
    return backValidateResult();
  }
  const enabledTables = pickResult.enabledTables;
  const activeSchemas = pickResult.activeSchemas;

  if (spec) {
    await writeScopeConfig({
      projectDir: input.projectDir,
      connectionId: input.connectionId,
      values: activeSchemas,
      spec,
    });
  }
  const refreshedProject = await loadKtxProject({ projectDir: input.projectDir });
  const currentConnection = refreshedProject.config.connections[input.connectionId];
  if (!currentConnection) return okValidateResult();
  await writeConnectionConfig({
    projectDir: input.projectDir,
    connectionId: input.connectionId,
    connection: { ...currentConnection, enabled_tables: enabledTables },
    io: input.io,
  });

  if (spec && activeSchemas.length > 0) {
    const capitalNounPlural = spec.nounPlural[0]!.toUpperCase() + spec.nounPlural.slice(1);
    writeSetupSection(input.io, `${capitalNounPlural} saved for ${input.connectionId}`, [
      `✓ ${activeSchemas.join(', ')}`,
    ]);
  }
  writeSetupSection(input.io, `Tables enabled for ${input.connectionId}`, [
    `✓ ${enabledTables.length} tables enabled`,
  ]);
  return okValidateResult();
}

async function ensureHistoricSqlIngestDefaults(projectDir: string): Promise<void> {
  const project = await loadKtxProject({ projectDir });
  const maxConcurrency = Math.max(
    project.config.ingest.workUnits.maxConcurrency,
    HISTORIC_SQL_WORK_UNIT_MAX_CONCURRENCY,
  );
  if (maxConcurrency === project.config.ingest.workUnits.maxConcurrency) {
    return;
  }
  await writeFile(
    project.configPath,
    serializeKtxProjectConfig({
      ...project.config,
      ingest: {
        ...project.config.ingest,
        workUnits: {
          ...project.config.ingest.workUnits,
          maxConcurrency,
        },
      },
    }),
    'utf-8',
  );
}

async function markDatabasesComplete(projectDir: string, connectionIds: string[]): Promise<void> {
  const project = await loadKtxProject({ projectDir });
  const config = setKtxSetupDatabaseConnectionIds(project.config, unique(connectionIds));
  await writeFile(project.configPath, serializeKtxProjectConfig(config), 'utf-8');
  await markKtxSetupStateStepComplete(projectDir, 'databases');
}

async function maybeRunHistoricSqlSetupProbe(input: {
  projectDir: string;
  connectionId: string;
  io: KtxCliIo;
  deps: KtxSetupDatabasesDeps;
}): Promise<boolean> {
  const project = await loadKtxProject({ projectDir: input.projectDir });
  const connection = project.config.connections[input.connectionId];
  const queryHistory = queryHistoryConfigRecord(connection);
  if (queryHistory?.enabled !== true) {
    return true;
  }
  if (!connection) {
    return true;
  }
  const dialect = queryHistoryDialectForConnection(connection);
  if (!dialect) {
    return true;
  }

  input.io.stdout.write('│  Query history probe...\n');
  const probe = input.deps.historicSqlReadinessProbe ?? runHistoricSqlReadinessProbe;
  const result = setupHistoricSqlProbeResult(
    await probe({
      projectDir: input.projectDir,
      connectionId: input.connectionId,
      connection,
      env: process.env,
    }),
  );
  for (const line of result.lines) {
    input.io.stdout.write(`│${line}\n`);
  }
  if (!result.ok) {
    input.io.stdout.write('│  Setup written; query history will be skipped until fixed.\n');
  }
  return result.ok;
}

function hasServiceAccountsBlock(connection: KtxProjectConnectionConfig | undefined): boolean {
  const queryHistory = queryHistoryConfigRecord(connection);
  const filters = queryHistory?.filters;
  if (!filters || typeof filters !== 'object' || Array.isArray(filters)) {
    return false;
  }
  return 'serviceAccounts' in filters;
}

function printQueryHistoryFilterProposal(io: KtxCliIo, proposal: QueryHistoryFilterProposal, debug = false): void {
  if (debug && proposal.parseFailedTemplateIds.length > 0) {
    io.stderr.write(
      `[debug] query-history filter picker could not parse ${proposal.parseFailedTemplateIds.length} template(s): ${proposal.parseFailedTemplateIds.join(', ')}\n`,
    );
  }
  if (proposal.excludedRoles.length === 0) {
    if (proposal.skipped?.reason === 'no-llm') {
      io.stdout.write('│  Query-history filter picker skipped: no LLM is configured.\n');
    } else if (proposal.skipped?.reason === 'no-daemon') {
      io.stdout.write('│  Query-history filter picker skipped: SQL analysis is unavailable.\n');
    } else if (proposal.skipped?.reason === 'no-in-scope-history') {
      io.stdout.write('│  Query-history filter picker found no in-scope service-account exclusions.\n');
    }
    if (proposal.parseFailedTemplateIds.length > 0) {
      const count = proposal.parseFailedTemplateIds.length;
      io.stdout.write(
        `│  Skipped ${count} query template${count === 1 ? '' : 's'} ktx could not parse (run with --debug to list them).\n`,
      );
    }
    for (const warning of proposal.warnings) {
      io.stdout.write(`│  ! ${warning}\n`);
    }
    return;
  }

  io.stdout.write('│  Proposed query-history service-account filters:\n');
  for (const excluded of proposal.excludedRoles) {
    io.stdout.write(`│  - ${excluded.role}: ${excluded.reason}\n`);
  }
}

async function shouldApplyQueryHistoryFilterProposal(input: {
  args: KtxSetupDatabasesArgs;
  prompts: KtxSetupDatabasesPromptAdapter;
  proposal: QueryHistoryFilterProposal;
}): Promise<boolean> {
  if (input.proposal.excludedRoles.length === 0 || input.proposal.skipped?.reason === 'user-block-present') {
    return false;
  }
  if (input.args.yes === true || input.args.inputMode === 'disabled') {
    return true;
  }
  const choice = await input.prompts.select({
    message: `Apply ${input.proposal.excludedRoles.length} derived query-history service-account exclusion${
      input.proposal.excludedRoles.length === 1 ? '' : 's'
    }?`,
    options: [
      { value: 'apply', label: 'Apply derived filters (recommended)' },
      { value: 'skip', label: 'Leave query history filters unchanged' },
    ],
  });
  return choice === 'apply';
}

function createSetupQueryHistoryLlmRuntime(input: {
  projectDir: string;
  project: Awaited<ReturnType<typeof loadKtxProject>>;
  deps: KtxSetupDatabasesDeps;
}): KtxLlmRuntimePort | null {
  try {
    return (
      input.deps.createQueryHistoryLlmRuntime?.(input.projectDir, input.project) ??
      createLocalKtxLlmRuntimeFromConfig(input.project.config.llm, {
        projectDir: input.projectDir,
      })
    );
  } catch {
    return null;
  }
}

/** @internal */
export function managedDaemonOptionsForSetupQueryHistoryPicker(input: {
  projectDir: string;
  args: Pick<KtxSetupDatabasesArgs, 'cliVersion' | 'runtimeInstallPolicy' | 'inputMode'>;
  io: KtxCliIo;
}): ManagedPythonCoreDaemonOptions {
  return {
    cliVersion: input.args.cliVersion ?? getKtxCliPackageInfo().version,
    projectDir: input.projectDir,
    installPolicy: input.args.runtimeInstallPolicy ?? (input.args.inputMode === 'disabled' ? 'never' : 'prompt'),
    io: input.io,
  };
}

async function maybeProposeQueryHistoryFilters(input: {
  projectDir: string;
  connectionId: string;
  io: KtxCliIo;
  deps: KtxSetupDatabasesDeps;
  args: KtxSetupDatabasesArgs;
  prompts: KtxSetupDatabasesPromptAdapter;
}): Promise<void> {
  const project = await loadKtxProject({ projectDir: input.projectDir });
  const connection = project.config.connections[input.connectionId];
  const queryHistory = queryHistoryConfigRecord(connection);
  if (!connection || queryHistory?.enabled !== true) {
    return;
  }
  const dialect = queryHistoryDialectForConnection(connection);
  if (!dialect) {
    return;
  }

  const picker = input.deps.queryHistoryFilterPicker ?? proposeQueryHistoryServiceAccountFilters;
  const llmRuntime = createSetupQueryHistoryLlmRuntime({
    projectDir: input.projectDir,
    project,
    deps: input.deps,
  });
  if (!llmRuntime && !input.deps.queryHistoryFilterPicker) {
    printQueryHistoryFilterProposal(
      input.io,
      {
        excludedRoles: [],
        consideredRoleCount: 0,
        skipped: { reason: 'no-llm' },
        warnings: [],
        parseFailedTemplateIds: [],
      },
      input.args.debug === true,
    );
    return;
  }

  const runtime = createKtxCliHistoricSqlRuntime(project, input.connectionId, {
    managedDaemon: managedDaemonOptionsForSetupQueryHistoryPicker({
      projectDir: input.projectDir,
      args: input.args,
      io: input.io,
    }),
  });
  if (!runtime) {
    return;
  }
  const userServiceAccountsPresent = hasServiceAccountsBlock(connection);
  const scopeFloor = await resolveQueryHistoryScopeFloor({
    projectDir: input.projectDir,
    connectionId: input.connectionId,
    driver: String(connection.driver ?? ''),
    connection: connection as Record<string, unknown>,
    storedQueryHistory: queryHistory,
  });
  const pullConfig = queryHistoryPullConfig({
    stored: queryHistory,
    dialect,
    enabledTables: scopeFloor.enabledTables,
    enabledSchemas: scopeFloor.enabledSchemas,
    modeledTableCatalog: scopeFloor.modeledTableCatalog,
    scopeFloorWarnings: scopeFloor.warnings,
  });
  const proposal = await picker({
    connectionId: input.connectionId,
    dialect,
    queryClient: runtime.queryClient,
    reader: runtime.reader,
    sqlAnalysis: runtime.sqlAnalysis,
    llmRuntime,
    pullConfig,
    userServiceAccountsPresent,
  });

  printQueryHistoryFilterProposal(input.io, proposal, input.args.debug === true);
  await emitTelemetryEvent({
    name: 'query_history_filter_completed',
    projectDir: input.projectDir,
    io: input.io,
    fields: {
      dialect,
      consideredRoleCount: proposal.consideredRoleCount,
      excludedRoleCount: proposal.excludedRoles.length,
      parseFailedCount: proposal.parseFailedTemplateIds.length,
      outcome: 'ok',
    },
  });
  if (proposal.skipped?.reason === 'user-block-present') {
    input.io.stdout.write('│  Existing query-history service-account filters left unchanged.\n');
    return;
  }
  if (!(await shouldApplyQueryHistoryFilterProposal({ args: input.args, prompts: input.prompts, proposal }))) {
    return;
  }

  await writeConnectionConfig({
    projectDir: input.projectDir,
    connectionId: input.connectionId,
    connection: withQueryHistoryConfig(connection, {
      ...queryHistory,
      filters: {
        ...(queryHistory.filters && typeof queryHistory.filters === 'object' && !Array.isArray(queryHistory.filters)
          ? queryHistory.filters
          : {}),
        serviceAccounts: {
          mode: 'exclude',
          patterns: proposal.excludedRoles.map((role) => role.pattern),
        },
      },
    }),
  });
}

async function applyHistoricSqlConfigToExistingConnection(input: {
  projectDir: string;
  connectionId: string;
  args: KtxSetupDatabasesArgs;
  prompts: KtxSetupDatabasesPromptAdapter;
}): Promise<'back' | void> {
  if (
    input.args.inputMode === 'disabled' &&
    input.args.enableQueryHistory !== true &&
    input.args.disableQueryHistory !== true
  ) {
    return;
  }

  const project = await loadKtxProject({ projectDir: input.projectDir });
  const existing = project.config.connections[input.connectionId];
  const driver = normalizeDriver(existing?.driver);
  if (!existing || !driver) {
    return;
  }

  const withHistoricSql = await maybeApplyHistoricSqlConfig({
    connection: existing,
    driver,
    args: input.args,
    prompts: input.prompts,
  });
  if (withHistoricSql === 'back') return 'back';
  await writeConnectionConfig({
    projectDir: input.projectDir,
    connectionId: input.connectionId,
    connection: withHistoricSql,
  });
}

async function validateAndScanConnection(input: {
  projectDir: string;
  connectionId: string;
  io: KtxCliIo;
  deps: KtxSetupDatabasesDeps;
  args: KtxSetupDatabasesArgs;
  prompts: KtxSetupDatabasesPromptAdapter;
  forceScopeAndTables?: boolean;
}): Promise<ValidateResult> {
  const testConnection = input.deps.testConnection ?? defaultTestConnection;
  const scanConnection = input.deps.scanConnection ?? defaultScanConnection;
  const project = await loadKtxProject({ projectDir: input.projectDir });
  const configuredDriver = normalizeDriver(project.config.connections[input.connectionId]?.driver);
  const configuredDriverLabel = configuredDriver ? driverLabel(configuredDriver) : undefined;
  const testIo = createBufferedCommandIo();
  const testCode = await testConnection(input.projectDir, input.connectionId, testIo);
  if (testCode !== 0) {
    flushPrefixedBufferedCommandOutput(input.io, testIo);
    writePrefixedLines(
      (chunk) => input.io.stderr.write(chunk),
      `Connection test failed for ${input.connectionId}.`,
    );
    return failedValidateResult();
  }
  const testOutput = testIo.stdoutText();
  const outputDriver = normalizeDriver(readOutputValue(testOutput, 'Driver'));
  const driverDisplay = outputDriver ? driverLabel(outputDriver) : (configuredDriverLabel ?? 'Unknown driver');
  const testLines = ['✓ Connection test passed', `Driver: ${driverDisplay}`];
  writeSetupSection(input.io, `Testing ${input.connectionId}`, testLines);

  const scopeStatus = await maybeConfigureDatabaseScope({ ...input, forcePrompt: input.forceScopeAndTables });
  if (scopeStatus.status !== 'ok') {
    return scopeStatus;
  }

  const queryHistoryAvailable = await maybeRunHistoricSqlSetupProbe({
    projectDir: input.projectDir,
    connectionId: input.connectionId,
    io: input.io,
    deps: input.deps,
  });
  writeSetupSection(input.io, `Building schema context for ${input.connectionId}`, [
    'Running database scan…',
  ]);
  let scanIo = createBufferedCommandIo();
  let scanCode = await scanConnection(input.projectDir, input.connectionId, scanIo);
  if (scanCode !== 0) {
    const nativeSqliteDetail = nativeSqliteAbiMismatchDetail(`${scanIo.stderrText()}\n${scanIo.stdoutText()}`);
    if (nativeSqliteDetail) {
      writePrefixedLines(
        (chunk) => input.io.stderr.write(chunk),
          [
            `Database scan failed for ${input.connectionId}.`,
            'Native SQLite is built for a different Node.js ABI.',
            `Detail: ${nativeSqliteDetail}`,
            'Rebuilding Native SQLite with pnpm run native:rebuild…',
        ].join('\n'),
      );
      const rebuildNativeSqlite = input.deps.rebuildNativeSqlite ?? defaultRebuildNativeSqlite;
      const rebuildCode = await rebuildNativeSqlite(input.io);
      if (rebuildCode === 0) {
        writePrefixedLines(
          (chunk) => input.io.stderr.write(chunk),
          'Native SQLite rebuild complete. Retrying database scan…',
        );
        const retryScanIo = createBufferedCommandIo();
        scanCode = await scanConnection(input.projectDir, input.connectionId, retryScanIo);
        scanIo = retryScanIo;
      }
      if (scanCode !== 0) {
        writePrefixedLines(
          (chunk) => input.io.stderr.write(chunk),
          [
            rebuildCode === 0
              ? `Database scan still failed for ${input.connectionId} after rebuilding Native SQLite.`
              : `Native SQLite rebuild failed for ${input.connectionId}.`,
            'Fix: pnpm run native:rebuild',
            `Retry: ktx ingest ${input.connectionId} --project-dir ${input.projectDir}`,
          ].join('\n'),
        );
      }
    } else {
      flushPrefixedBufferedCommandOutput(input.io, scanIo);
      writePrefixedLines(
        (chunk) => input.io.stderr.write(chunk),
        [
          `Database scan failed for ${input.connectionId}.`,
          `Debug command: ktx ingest ${input.connectionId} --project-dir ${input.projectDir} --debug`,
        ].join('\n'),
      );
    }
    if (scanCode !== 0) {
      return queryHistoryAvailable
        ? failedValidateResult()
        : queryHistoryUnavailableResult(input.projectDir, input.connectionId);
    }
  }
  const scanOutput = scanIo.stdoutText();
  writeSetupSection(
    input.io,
    `Schema context complete for ${input.connectionId}`,
    [`Changes: ${summarizeScanChanges(scanOutput)}`],
  );
  if (queryHistoryAvailable) {
    await maybeProposeQueryHistoryFilters({
      projectDir: input.projectDir,
      connectionId: input.connectionId,
      io: input.io,
      deps: input.deps,
      args: input.args,
      prompts: input.prompts,
    });
  }
  writeSetupSection(input.io, 'Database ready', [
    `${input.connectionId} · ${driverDisplay} · schema context complete`,
  ]);
  return okValidateResult();
}

async function chooseDrivers(
  args: KtxSetupDatabasesArgs,
  io: KtxCliIo,
  prompts: KtxSetupDatabasesPromptAdapter,
  options?: { hasPrimarySources?: boolean; initialDrivers?: KtxSetupDatabaseDriver[] },
): Promise<KtxSetupDatabaseDriver[] | 'back' | 'missing-input'> {
  if (args.databaseDrivers && args.databaseDrivers.length > 0) {
    return [...new Set(args.databaseDrivers)];
  }
  if (args.databaseConnectionIds && args.databaseConnectionIds.length > 0) {
    return [];
  }
  if (args.inputMode === 'disabled') {
    io.stderr.write(
      'ktx cannot work without a database. Pass --database or --database-connection-id, or pass --skip-databases to leave setup incomplete.\n',
    );
    return 'missing-input';
  }
  const initialValues = unique(options?.initialDrivers ?? []);
  createKtxSetupUiAdapter().note(
    `Get demo credentials: ${KTX_DEMO_START_URL}`,
    '🎁 Need a warehouse to play with?',
    io,
  );
  const choices = await prompts.multiselect({
    message: withMultiselectNavigation('Which databases should ktx connect to?'),
    options: [...DRIVER_OPTIONS],
    ...(initialValues.length > 0 ? { initialValues } : {}),
    required: true,
  });
  if (choices.includes('back')) {
    return 'back';
  }
  return choices as KtxSetupDatabaseDriver[];
}

async function chooseConnectionIdForDriver(input: {
  driver: KtxSetupDatabaseDriver;
  connections: Record<string, KtxProjectConnectionConfig>;
  args: KtxSetupDatabasesArgs;
  prompts: KtxSetupDatabasesPromptAdapter;
}): Promise<{ kind: 'existing' | 'new' | 'edit'; connectionId: string } | 'back' | 'missing-input'> {
  if (input.args.databaseConnectionId) {
    assertSafeDatabaseConnectionId(input.args.databaseConnectionId);
    return { kind: 'new', connectionId: input.args.databaseConnectionId };
  }
  if (input.args.inputMode === 'disabled') {
    if (!input.args.databaseConnectionId) return 'missing-input';
    assertSafeDatabaseConnectionId(input.args.databaseConnectionId);
    return { kind: 'new', connectionId: input.args.databaseConnectionId };
  }

  const existingIds = existingConnectionIdsByDriver(input.connections, input.driver);
  const defaultId = defaultConnectionIdForDriver(input.connections, input.driver);
  const label = driverLabel(input.driver);

  if (existingIds.length === 0) {
    const entered = await input.prompts.text({
      message: withTextInputNavigation(connectionNamePrompt(label)),
      placeholder: defaultId,
      initialValue: defaultId,
    });
    if (entered === undefined) return 'back';
    const connectionId = entered.trim() || defaultId;
    assertSafeDatabaseConnectionId(connectionId);
    return connectionId ? { kind: 'new', connectionId } : 'missing-input';
  }

  while (true) {
    const choice = await input.prompts.select({
      message: `Configure ${label}`,
      options: [
        ...existingIds.map((connectionId) => ({
          value: `existing:${connectionId}`,
          label: `Keep existing ${label} connection: ${connectionId}`,
        })),
        ...existingIds.map((connectionId) => ({
          value: `edit:${connectionId}`,
          label: `Edit ${label} connection: ${connectionId}`,
        })),
        { value: 'new', label: `Add another ${label} connection` },
        { value: 'back', label: 'Back' },
      ],
    });
    if (choice === 'back') return 'back';
    if (choice.startsWith('existing:')) return { kind: 'existing', connectionId: choice.slice('existing:'.length) };
    if (choice.startsWith('edit:')) return { kind: 'edit', connectionId: choice.slice('edit:'.length) };
    const entered = await input.prompts.text({
      message: withTextInputNavigation(connectionNamePrompt(label)),
      placeholder: defaultId,
      initialValue: defaultId,
    });
    if (entered === undefined) continue;
    const connectionId = entered.trim() || defaultId;
    assertSafeDatabaseConnectionId(connectionId);
    return connectionId ? { kind: 'new', connectionId } : 'missing-input';
  }
}

async function choosePrimarySourceToEdit(input: {
  projectDir: string;
  connectionIds: string[];
  prompts: KtxSetupDatabasesPromptAdapter;
}): Promise<string | 'back'> {
  const project = await loadKtxProject({ projectDir: input.projectDir });
  const options = input.connectionIds
    .map((connectionId) => {
      const driver = normalizeDriver(project.config.connections[connectionId]?.driver);
      if (!driver) return null;
      return { value: connectionId, label: `${connectionId} (${driverLabel(driver)})` };
    })
    .filter((option): option is { value: string; label: string } => option !== null);
  if (options.length === 0) return 'back';
  const choice = await input.prompts.select({
    message: 'Database to edit',
    options: [...options, { value: 'back', label: 'Back' }],
  });
  return choice === 'back' ? 'back' : choice;
}

async function configureDatabaseConnection(input: {
  projectDir: string;
  connectionId: string;
  driver: KtxSetupDatabaseDriver;
  args: KtxSetupDatabasesArgs;
  prompts: KtxSetupDatabasesPromptAdapter;
  io: KtxCliIo;
  canReturnToDriverSelection: boolean;
  editBaseline?: KtxProjectConnectionConfig;
}): Promise<ConfigureResult> {
  const project = await loadKtxProject({ projectDir: input.projectDir });
  const latestConnection = project.config.connections[input.connectionId];
  let connection = await buildConnectionConfig({
    driver: input.driver,
    connectionId: input.connectionId,
    args: input.args,
    prompts: input.prompts,
    existingConnection: latestConnection,
  });

  while (!connection && input.args.inputMode !== 'disabled') {
    const action = await input.prompts.select(
      missingConnectionDetailsPrompt(driverLabel(input.driver), input.canReturnToDriverSelection),
    );
    if (action === 'back') {
      return 'back';
    }
    connection = await buildConnectionConfig({
      driver: input.driver,
      connectionId: input.connectionId,
      args: input.args,
      prompts: input.prompts,
      existingConnection: latestConnection,
    });
  }

  if (connection === 'back') {
    return 'back';
  }
  if (!connection) {
    input.io.stderr.write(`Missing connection details for ${driverLabel(input.driver)}.\n`);
    return 'cancelled';
  }

  const withHistoricSql = await maybeApplyHistoricSqlConfig({
    connection,
    driver: input.driver,
    args: input.args,
    prompts: input.prompts,
  });
  if (withHistoricSql === 'back') {
    return 'back';
  }

  await writeConnectionConfig({
    projectDir: input.projectDir,
    connectionId: input.connectionId,
    connection: input.editBaseline
      ? withExistingPrimaryEditPromptDefaults({
          previous: input.editBaseline,
          next: withHistoricSql,
          driver: input.driver,
        })
      : withHistoricSql,
    io: input.io,
  });
  return 'configured';
}

async function runDatabaseConnectionSetupWithRecovery(input: {
  projectDir: string;
  connectionId: string;
  driver: KtxSetupDatabaseDriver;
  args: KtxSetupDatabasesArgs;
  prompts: KtxSetupDatabasesPromptAdapter;
  io: KtxCliIo;
  deps: KtxSetupDatabasesDeps;
  canReturnToDriverSelection: boolean;
  allowSkip: boolean;
  interactive?: boolean;
  forceScopeAndTables?: boolean;
  editBaseline?: KtxProjectConnectionConfig;
  reuseExistingOnFirstConfigure?: boolean;
}): Promise<RecoveryOutcome | 'missing-input'> {
  let configureCalls = 0;
  // `configureDatabaseConnection` returns 'cancelled' only when required
  // connection details are absent in non-interactive mode. The recovery
  // primitive collapses that into 'failed', so we track it here to restore the
  // distinct 'missing-input' outcome the surrounding step reports for
  // incomplete flags (vs. a real connection/probe failure).
  let sawMissingInput = false;

  const outcome = await runConnectionSetupWithRecovery({
    label: input.connectionId,
    interactive: input.interactive ?? input.args.inputMode !== 'disabled',
    allowSkip: input.allowSkip,
    io: input.io,
    prompts: input.prompts,
    snapshot: () => createConnectionConfigRollback(input.projectDir, input.connectionId),
    configure: async () => {
      configureCalls += 1;
      if (input.reuseExistingOnFirstConfigure && configureCalls === 1) {
        const historicSqlResult = await applyHistoricSqlConfigToExistingConnection({
          projectDir: input.projectDir,
          connectionId: input.connectionId,
          args: input.args,
          prompts: input.prompts,
        });
        return historicSqlResult === 'back' ? 'back' : 'configured';
      }
      const configured = await configureDatabaseConnection({
        projectDir: input.projectDir,
        connectionId: input.connectionId,
        driver: input.driver,
        args: input.args,
        prompts: input.prompts,
        io: input.io,
        canReturnToDriverSelection: input.canReturnToDriverSelection,
        editBaseline: input.editBaseline,
      });
      if (configured === 'cancelled') {
        sawMissingInput = true;
      }
      return configured;
    },
    validate: () =>
      validateAndScanConnection({
        projectDir: input.projectDir,
        connectionId: input.connectionId,
        io: input.io,
        deps: input.deps,
        args: input.args,
        prompts: input.prompts,
        forceScopeAndTables: input.forceScopeAndTables,
      }),
  });

  if (outcome === 'failed' && sawMissingInput) {
    return 'missing-input';
  }
  return outcome;
}

async function runPrimarySourceFullEdit(input: {
  projectDir: string;
  connectionId: string;
  args: KtxSetupDatabasesArgs;
  prompts: KtxSetupDatabasesPromptAdapter;
  io: KtxCliIo;
  deps: KtxSetupDatabasesDeps;
}): Promise<'ready' | 'back' | 'failed' | 'missing-input'> {
  const project = await loadKtxProject({ projectDir: input.projectDir });
  const existing = project.config.connections[input.connectionId];
  const driver = normalizeDriver(existing?.driver);
  if (!existing || !driver) {
    writePrefixedLines(
      (chunk) => input.io.stderr.write(chunk),
      `Connection "${input.connectionId}" is not a configured database.`,
    );
    return 'failed';
  }

  const outcome = await runDatabaseConnectionSetupWithRecovery({
    projectDir: input.projectDir,
    connectionId: input.connectionId,
    driver,
    args: input.args,
    prompts: input.prompts,
    io: input.io,
    deps: input.deps,
    canReturnToDriverSelection: true,
    allowSkip: false,
    forceScopeAndTables: true,
    editBaseline: existing,
  });

  return outcome === 'skip' ? 'back' : outcome;
}

export async function runKtxSetupDatabasesStep(
  args: KtxSetupDatabasesArgs,
  io: KtxCliIo,
  deps: KtxSetupDatabasesDeps = {},
): Promise<KtxSetupDatabasesResult> {
  if (args.skipDatabases) {
    io.stdout.write('│  Database setup skipped. ktx cannot work until you add a database.\n');
    return { status: 'skipped', projectDir: args.projectDir };
  }

  const prompts = deps.prompts ?? createPromptAdapter();

  if (args.databaseConnectionIds && args.databaseConnectionIds.length > 0) {
    const selectedConnectionIds: string[] = [];
    for (const connectionId of unique(args.databaseConnectionIds)) {
      const project = await loadKtxProject({ projectDir: args.projectDir });
      const driver = normalizeDriver(project.config.connections[connectionId]?.driver);
      if (!driver) {
        writePrefixedLines((chunk) => io.stderr.write(chunk), `Connection "${connectionId}" is not configured.`);
        return { status: 'failed', projectDir: args.projectDir };
      }
      const setupOutcome = await runDatabaseConnectionSetupWithRecovery({
        projectDir: args.projectDir,
        connectionId,
        driver,
        args,
        prompts,
        io,
        deps,
        canReturnToDriverSelection: false,
        allowSkip: false,
        interactive: false,
        reuseExistingOnFirstConfigure: true,
      });
      if (setupOutcome === 'back') {
        return { status: 'back', projectDir: args.projectDir };
      }
      if (setupOutcome === 'missing-input') {
        return { status: 'missing-input', projectDir: args.projectDir };
      }
      if (setupOutcome === 'failed') {
        return { status: 'failed', projectDir: args.projectDir };
      }
      if (setupOutcome === 'ready') {
        selectedConnectionIds.push(connectionId);
      }
    }
    await markDatabasesComplete(args.projectDir, selectedConnectionIds);
    return { status: 'ready', projectDir: args.projectDir, connectionIds: selectedConnectionIds };
  }

  const canReturnToDriverSelection = args.databaseDrivers === undefined || args.databaseDrivers.length === 0;
  const initialProject = await loadKtxProject({ projectDir: args.projectDir });
  const selectedConnectionIds =
    args.inputMode !== 'disabled' && canReturnToDriverSelection
      ? configuredPrimaryConnectionIds(initialProject.config.connections, initialProject.config.setup?.database_connection_ids)
      : [];
  let showConfiguredPrimaryMenu = selectedConnectionIds.length > 0;

  while (true) {
    if (showConfiguredPrimaryMenu) {
      const action = await prompts.select(configuredPrimarySourcesPrompt(selectedConnectionIds));
      if (action === 'continue' || action === 'back') {
        await markDatabasesComplete(args.projectDir, selectedConnectionIds);
        return { status: 'ready', projectDir: args.projectDir, connectionIds: selectedConnectionIds };
      }
      if (action === 'skip-sources') {
        await markDatabasesComplete(args.projectDir, selectedConnectionIds);
        return {
          status: 'ready',
          projectDir: args.projectDir,
          connectionIds: selectedConnectionIds,
          skipSources: true,
        };
      }
      if (action === 'edit') {
        const connectionId = await choosePrimarySourceToEdit({
          projectDir: args.projectDir,
          connectionIds: selectedConnectionIds,
          prompts,
        });
        if (connectionId === 'back') {
          showConfiguredPrimaryMenu = true;
          continue;
        }
        const editResult = await runPrimarySourceFullEdit({
          projectDir: args.projectDir,
          connectionId,
          args,
          prompts,
          io,
          deps,
        });
        if (editResult === 'back') {
          showConfiguredPrimaryMenu = true;
          continue;
        }
        if (editResult === 'missing-input') {
          return { status: 'missing-input', projectDir: args.projectDir };
        }
        if (editResult === 'failed') {
          return { status: 'failed', projectDir: args.projectDir };
        }
        pushUniqueConnectionId(selectedConnectionIds, connectionId);
        showConfiguredPrimaryMenu = true;
        continue;
      }
    }
    showConfiguredPrimaryMenu = false;

    const driverProject = await loadKtxProject({ projectDir: args.projectDir });
    const drivers = await chooseDrivers(args, io, prompts, {
      hasPrimarySources: selectedConnectionIds.length > 0,
      initialDrivers: configuredPrimaryDrivers(driverProject.config.connections, selectedConnectionIds),
    });
    if (drivers === 'back') {
      if (selectedConnectionIds.length > 0 && canReturnToDriverSelection && args.inputMode !== 'disabled') {
        showConfiguredPrimaryMenu = true;
        continue;
      }
      return { status: 'back', projectDir: args.projectDir };
    }
    if (drivers === 'missing-input') return { status: 'missing-input', projectDir: args.projectDir };
    if (drivers.length === 0) {
      await markDatabasesComplete(args.projectDir, []);
      io.stdout.write('│  ktx cannot work without a database.\n');
      return { status: 'skipped', projectDir: args.projectDir };
    }

    let returnToDriverSelection = false;

    for (const driver of drivers) {
      const project = await loadKtxProject({ projectDir: args.projectDir });
      let connectionChoice: Awaited<ReturnType<typeof chooseConnectionIdForDriver>>;
      try {
        connectionChoice = await chooseConnectionIdForDriver({
          driver,
          connections: project.config.connections,
          args,
          prompts,
        });
      } catch (error) {
        writePrefixedLines((chunk) => io.stderr.write(chunk), errorMessage(error));
        return { status: 'failed', projectDir: args.projectDir };
      }
      if (connectionChoice === 'back') {
        if (!canReturnToDriverSelection) return { status: 'back', projectDir: args.projectDir };
        returnToDriverSelection = true;
        break;
      }
      if (connectionChoice === 'missing-input') {
        io.stderr.write('Missing database connection id: pass --database-connection-id.\n');
        return { status: 'missing-input', projectDir: args.projectDir };
      }

      if (connectionChoice.kind === 'edit') {
        const editResult = await runPrimarySourceFullEdit({
          projectDir: args.projectDir,
          connectionId: connectionChoice.connectionId,
          args,
          prompts,
          io,
          deps,
        });
        if (editResult === 'back') {
          if (!canReturnToDriverSelection) return { status: 'back', projectDir: args.projectDir };
          returnToDriverSelection = true;
          break;
        }
        if (editResult === 'missing-input') {
          return { status: 'missing-input', projectDir: args.projectDir };
        }
        if (editResult === 'failed') {
          return { status: 'failed', projectDir: args.projectDir };
        }
      } else {
        const setupOutcome = await runDatabaseConnectionSetupWithRecovery({
          projectDir: args.projectDir,
          connectionId: connectionChoice.connectionId,
          driver,
          args,
          prompts,
          io,
          deps,
          canReturnToDriverSelection,
          allowSkip: true,
          reuseExistingOnFirstConfigure: connectionChoice.kind === 'existing',
        });
        if (setupOutcome === 'back') {
          if (!canReturnToDriverSelection) return { status: 'back', projectDir: args.projectDir };
          returnToDriverSelection = true;
          break;
        }
        if (setupOutcome === 'missing-input') {
          return { status: 'missing-input', projectDir: args.projectDir };
        }
        if (setupOutcome === 'failed') {
          return { status: 'failed', projectDir: args.projectDir };
        }
        if (setupOutcome === 'skip') {
          continue;
        }
      }
      if (returnToDriverSelection) break;

      pushUniqueConnectionId(selectedConnectionIds, connectionChoice.connectionId);
    }

    if (returnToDriverSelection) {
      if (selectedConnectionIds.length > 0 && canReturnToDriverSelection && args.inputMode !== 'disabled') {
        showConfiguredPrimaryMenu = true;
      }
      continue;
    }

    if (selectedConnectionIds.length === 0) {
      io.stderr.write('No database connections completed setup.\n');
      return { status: 'failed', projectDir: args.projectDir };
    }

    if (canReturnToDriverSelection && args.inputMode !== 'disabled') {
      showConfiguredPrimaryMenu = true;
      continue;
    }

    await markDatabasesComplete(args.projectDir, selectedConnectionIds);
    return { status: 'ready', projectDir: args.projectDir, connectionIds: selectedConnectionIds };
  }
}
