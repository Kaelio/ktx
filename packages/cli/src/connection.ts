import { DEFAULT_METABASE_CLIENT_CONFIG, DefaultMetabaseConnectionClientFactory } from './context/ingest/adapters/metabase/client.js';
import { DefaultLookerConnectionClientFactory } from './context/ingest/adapters/looker/factory.js';
import type { LookerClient } from './context/ingest/adapters/looker/client.js';
import type { MetabaseRuntimeClient } from './context/ingest/adapters/metabase/client-port.js';
import { type NotionBotInfo, NotionClient } from './context/ingest/adapters/notion/notion-client.js';
import { createLocalLookerCredentialResolver } from './context/ingest/adapters/looker/local-looker.adapter.js';
import { metabaseRuntimeConfigFromLocalConnection } from './context/ingest/adapters/metabase/local-metabase.adapter.js';
import { testRepoConnection } from './context/ingest/repo-fetch.js';
import { federatedConnectionListing } from './context/connections/federation.js';
import { getDriverRegistration } from './context/connections/drivers.js';
import { parseNotionConnectionConfig, resolveNotionConnectionAuthToken } from './context/connections/notion-config.js';
import { resolveKtxConfigReference } from './context/core/config-reference.js';
import { type KtxLocalProject, loadKtxProject } from './context/project/project.js';
import type { KtxScanConnector } from './context/scan/types.js';
import type { KtxCliIo } from './index.js';
import { bold, dim, green, red, SYMBOLS } from './io/symbols.js';
import { createKtxCliScanConnector } from './local-scan-connectors.js';
import { profileMark } from './startup-profile.js';
import { isDemoConnection } from './telemetry/demo-detect.js';
import { emitTelemetryEvent, reportException } from './telemetry/index.js';
import { collectTelemetryRedactionSecrets } from './telemetry/redaction-secrets.js';
import { formatErrorDetail, scrubErrorClass } from './telemetry/scrubber.js';

profileMark('module:connection');

export type KtxConnectionArgs =
  | { command: 'list'; projectDir: string }
  | { command: 'test'; projectDir: string; connectionId: string }
  | { command: 'test-all'; projectDir: string };

type MetabaseTestPort = Pick<MetabaseRuntimeClient, 'testConnection' | 'getDatabases' | 'cleanup'>;
type LookerTestPort = Pick<LookerClient, 'testConnection'>;
type NotionTestPort = Pick<NotionClient, 'retrieveBotUser'>;
type TestRepoConnection = typeof testRepoConnection;

export interface KtxConnectionDeps {
  createScanConnector?: typeof createKtxCliScanConnector;
  createMetabaseClient?: (project: KtxLocalProject, connectionId: string) => Promise<MetabaseTestPort>;
  createLookerClient?: (project: KtxLocalProject, connectionId: string) => Promise<LookerTestPort>;
  createNotionClient?: (project: KtxLocalProject, connectionId: string) => Promise<NotionTestPort>;
  testRepoConnection?: TestRepoConnection;
}

const SUPPORTED_TEST_DRIVERS = [
  'sqlite',
  'postgres',
  'mysql',
  'clickhouse',
  'sqlserver',
  'bigquery',
  'snowflake',
  'metabase',
  'looker',
  'notion',
  'dbt',
  'metricflow',
  'lookml',
];

function normalizedConnectionDriver(project: KtxLocalProject, connectionId: string): string {
  return String(project.config.connections[connectionId]?.driver ?? '')
    .trim()
    .toLowerCase();
}

async function testNativeConnection(
  project: KtxLocalProject,
  connectionId: string,
  createScanConnector: typeof createKtxCliScanConnector,
): Promise<{ driver: string }> {
  let connector: KtxScanConnector | null = null;
  try {
    connector = await createScanConnector(project, connectionId);
    if (!connector.testConnection) {
      throw new Error(`Connector for "${connectionId}" does not implement testConnection`);
    }
    const result = await connector.testConnection();
    if (!result.success) {
      // Re-throw the driver's original error so connection_test telemetry records
      // its real class (e.g. ConnectionError) and code (e.g. ELOGIN) instead of
      // collapsing every native failure to a generic Error with no code.
      if (result.cause instanceof Error) {
        throw result.cause;
      }
      throw new Error(result.error ?? 'connection test failed');
    }
    return { driver: connector.driver };
  } finally {
    if (connector?.cleanup) {
      await connector.cleanup();
    }
  }
}

async function createDefaultMetabaseClient(
  project: KtxLocalProject,
  connectionId: string,
): Promise<MetabaseTestPort> {
  const factory = new DefaultMetabaseConnectionClientFactory(
    (metabaseConnectionId) =>
      metabaseRuntimeConfigFromLocalConnection(
        metabaseConnectionId,
        project.config.connections[metabaseConnectionId],
      ),
    DEFAULT_METABASE_CLIENT_CONFIG,
  );
  return factory.createClient(connectionId);
}

async function testMetabaseConnection(
  project: KtxLocalProject,
  connectionId: string,
  createClient: (project: KtxLocalProject, connectionId: string) => Promise<MetabaseTestPort>,
): Promise<{ databaseCount: number }> {
  let client: MetabaseTestPort | null = null;
  try {
    client = await createClient(project, connectionId);
    const testResult = await client.testConnection();
    if (!testResult.success) {
      throw new Error(`Metabase connection test failed: ${testResult.error ?? testResult.message ?? 'unknown error'}`);
    }
    const databases = await client.getDatabases();
    const databaseCount = databases.filter((database) => database.is_sample !== true).length;
    if (databaseCount === 0) {
      throw new Error('Metabase auth worked but no usable databases were returned');
    }
    return { databaseCount };
  } finally {
    await client?.cleanup();
  }
}

async function createDefaultLookerClient(
  project: KtxLocalProject,
  connectionId: string,
): Promise<LookerTestPort> {
  const factory = new DefaultLookerConnectionClientFactory(createLocalLookerCredentialResolver(project));
  return factory.createLookerClient(connectionId);
}

async function testLookerConnection(
  project: KtxLocalProject,
  connectionId: string,
  createClient: (project: KtxLocalProject, connectionId: string) => Promise<LookerTestPort>,
): Promise<{ user: string }> {
  const client = await createClient(project, connectionId);
  const result = await client.testConnection();
  if (!result.success) {
    throw new Error(`Looker connection test failed: ${result.error ?? 'unknown error'}`);
  }
  const metadata = (result.metadata ?? {}) as { displayName?: string | null; userId?: string };
  const user = (metadata.displayName ?? metadata.userId ?? 'unknown').trim() || 'unknown';
  return { user };
}

async function createDefaultNotionClient(
  project: KtxLocalProject,
  connectionId: string,
): Promise<NotionTestPort> {
  const connection = project.config.connections[connectionId];
  if (!connection) {
    throw new Error(`Connection "${connectionId}" is not configured in ktx.yaml`);
  }
  const parsed = parseNotionConnectionConfig(connection);
  const token = await resolveNotionConnectionAuthToken(parsed);
  return new NotionClient(token);
}

function describeNotionBot(bot: NotionBotInfo): string {
  const name = typeof bot.name === 'string' ? bot.name.trim() : '';
  if (name) return name;
  const id = typeof bot.id === 'string' ? bot.id.trim() : '';
  return id || 'unknown';
}

async function testNotionConnection(
  project: KtxLocalProject,
  connectionId: string,
  createClient: (project: KtxLocalProject, connectionId: string) => Promise<NotionTestPort>,
): Promise<{ bot: string }> {
  const client = await createClient(project, connectionId);
  const bot = await client.retrieveBotUser();
  return { bot: describeNotionBot(bot) };
}

interface GitConnectionFields {
  repoUrl: string;
  authToken: string | null;
}

function extractGitConnectionFields(
  project: KtxLocalProject,
  connectionId: string,
  driver: string,
): GitConnectionFields {
  const connection = project.config.connections[connectionId];
  if (!connection) {
    throw new Error(`Connection "${connectionId}" is not configured in ktx.yaml`);
  }
  const stringField = (value: unknown): string | null =>
    typeof value === 'string' && value.trim().length > 0 ? value.trim() : null;
  const record =
    driver === 'metricflow' && typeof connection.metricflow === 'object' && connection.metricflow !== null
      ? (connection.metricflow as Record<string, unknown>)
      : (connection as Record<string, unknown>);
  const repoUrl = driver === 'dbt' ? stringField(record.repo_url) : stringField(record.repoUrl);
  if (!repoUrl) {
    const field = driver === 'dbt' ? 'repo_url' : 'repoUrl';
    throw new Error(`Connection "${connectionId}" (driver: ${driver}) is missing ${field}`);
  }
  const literalToken = stringField(record.auth_token);
  const ref = stringField(record.auth_token_ref);
  const resolvedRef = ref ? resolveKtxConfigReference(ref, process.env) : null;
  return { repoUrl, authToken: literalToken ?? resolvedRef ?? null };
}

async function testGitRepoConnection(
  project: KtxLocalProject,
  connectionId: string,
  driver: string,
  runTest: TestRepoConnection,
): Promise<{ repoUrl: string }> {
  const { repoUrl, authToken } = extractGitConnectionFields(project, connectionId, driver);
  const result = await runTest({ repoUrl, authToken });
  if (!result.ok) {
    throw new Error(`${driver} repository check failed: ${result.error}`);
  }
  return { repoUrl };
}

interface DriverTestOutcome {
  driver: string;
  detailKey: string;
  detailValue: string;
}

async function testConnectionByDriver(
  project: KtxLocalProject,
  connectionId: string,
  deps: KtxConnectionDeps,
): Promise<DriverTestOutcome> {
  const driver = normalizedConnectionDriver(project, connectionId);
  if (!driver) {
    throw new Error(`Connection "${connectionId}" has no \`driver\` field in ktx.yaml`);
  }

  if (driver === 'metabase') {
    const result = await testMetabaseConnection(
      project,
      connectionId,
      deps.createMetabaseClient ?? createDefaultMetabaseClient,
    );
    return { driver, detailKey: 'Databases', detailValue: String(result.databaseCount) };
  }

  if (driver === 'looker') {
    const result = await testLookerConnection(
      project,
      connectionId,
      deps.createLookerClient ?? createDefaultLookerClient,
    );
    return { driver, detailKey: 'User', detailValue: result.user };
  }

  if (driver === 'notion') {
    const result = await testNotionConnection(
      project,
      connectionId,
      deps.createNotionClient ?? createDefaultNotionClient,
    );
    return { driver, detailKey: 'Bot', detailValue: result.bot };
  }

  if (driver === 'dbt' || driver === 'metricflow' || driver === 'lookml') {
    const result = await testGitRepoConnection(
      project,
      connectionId,
      driver,
      deps.testRepoConnection ?? testRepoConnection,
    );
    return { driver, detailKey: 'Repo', detailValue: result.repoUrl };
  }

  if (getDriverRegistration(driver)) {
    const result = await testNativeConnection(
      project,
      connectionId,
      deps.createScanConnector ?? createKtxCliScanConnector,
    );
    return { driver: result.driver, detailKey: 'Status', detailValue: 'ok' };
  }

  throw new Error(
    `Connection "${connectionId}" uses driver "${driver}", which has no test implementation in ktx. Supported: ${SUPPORTED_TEST_DRIVERS.join(', ')}.`,
  );
}

interface ConnectionTestRow {
  connectionId: string;
  driver: string;
  ok: boolean;
  detail: string;
}

async function emitConnectionTest(input: {
  project: KtxLocalProject;
  connectionId: string;
  driver: string;
  outcome: 'ok' | 'error';
  durationMs: number;
  error?: unknown;
  io: KtxCliIo;
}): Promise<void> {
  const errorClass = input.error ? scrubErrorClass(input.error) : undefined;
  const errorDetail = input.error ? formatErrorDetail(input.error) : undefined;
  await emitTelemetryEvent({
    name: 'connection_test',
    projectDir: input.project.projectDir,
    io: input.io,
    fields: {
      driver: input.driver,
      isDemoConnection: isDemoConnection(input.connectionId, input.project.config.connections[input.connectionId]),
      outcome: input.outcome,
      durationMs: input.durationMs,
      ...(errorClass ? { errorClass } : {}),
      ...(errorDetail ? { errorDetail } : {}),
    },
  });
  if (input.error) {
    await reportException({
      error: input.error,
      context: { source: 'connection test', handled: true, fatal: false },
      projectDir: input.project.projectDir,
      io: input.io,
      redactionSecrets: await collectTelemetryRedactionSecrets({
        project: input.project,
        connectionId: input.connectionId,
        includeLlm: false,
        includeEmbeddings: false,
        env: process.env,
      }),
    });
  }
}

function visualWidth(text: string): number {
  // styleText wraps content in ANSI escape sequences; strip them before measuring.
  return text.replace(/\[[0-9;]*m/g, '').length;
}

function padVisual(text: string, width: number): string {
  const pad = width - visualWidth(text);
  return pad > 0 ? `${text}${' '.repeat(pad)}` : text;
}

function renderTestAll(io: KtxCliIo, rows: ReadonlyArray<ConnectionTestRow>): void {
  io.stdout.write(`${bold('connection test --all')}\n`);

  if (rows.length === 0) {
    io.stdout.write(`\n  No connections configured. Run \`ktx setup\` to add one.\n\n`);
    return;
  }

  io.stdout.write('\n');
  const okLabel = green('✓ ok');
  const failLabel = red('✗ failed');
  const idWidth = Math.max(...rows.map((r) => r.connectionId.length));
  const driverWidth = Math.max(...rows.map((r) => r.driver.length));
  const statusWidth = Math.max(visualWidth(okLabel), visualWidth(failLabel));

  for (const row of rows) {
    const id = bold(padVisual(row.connectionId, idWidth));
    const driver = dim(padVisual(row.driver, driverWidth));
    const status = padVisual(row.ok ? okLabel : failLabel, statusWidth);
    const detail = dim(row.detail);
    io.stdout.write(`  ${id}  ${driver}  ${status}  ${detail}\n`);
  }

  const failed = rows.filter((r) => !r.ok).length;
  const passed = rows.length - failed;
  io.stdout.write('\n');
  const summary =
    failed === 0
      ? `${rows.length} tested ${dim(SYMBOLS.middot)} ${green(`${passed} passed`)}`
      : `${rows.length} tested ${dim(SYMBOLS.middot)} ${green(`${passed} passed`)} ${dim(SYMBOLS.middot)} ${red(`${failed} failed`)}`;
  io.stdout.write(`${summary}\n`);
}

async function runTestAll(
  project: KtxLocalProject,
  io: KtxCliIo,
  deps: KtxConnectionDeps,
): Promise<number> {
  const entries = Object.entries(project.config.connections).sort(([a], [b]) => a.localeCompare(b));
  const rows = await Promise.all(
    entries.map(async ([connectionId, connection]): Promise<ConnectionTestRow> => {
      const declaredDriver = String(connection.driver ?? '').trim().toLowerCase() || 'unknown';
      const startedAt = performance.now();
      try {
        const outcome = await testConnectionByDriver(project, connectionId, deps);
        await emitConnectionTest({
          project,
          connectionId,
          driver: outcome.driver || declaredDriver,
          outcome: 'ok',
          durationMs: Math.max(0, performance.now() - startedAt),
          io,
        });
        return {
          connectionId,
          driver: outcome.driver || declaredDriver,
          ok: true,
          detail: `${outcome.detailKey}: ${outcome.detailValue}`,
        };
      } catch (error) {
        await emitConnectionTest({
          project,
          connectionId,
          driver: declaredDriver,
          outcome: 'error',
          durationMs: Math.max(0, performance.now() - startedAt),
          error,
          io,
        });
        return {
          connectionId,
          driver: declaredDriver,
          ok: false,
          detail: error instanceof Error ? error.message : String(error),
        };
      }
    }),
  );
  renderTestAll(io, rows);
  return rows.some((row) => !row.ok) ? 1 : 0;
}

export async function runKtxConnection(
  args: KtxConnectionArgs,
  io: KtxCliIo = process,
  deps: KtxConnectionDeps = {},
): Promise<number> {
  try {
    const project = await loadKtxProject({ projectDir: args.projectDir });
    if (args.command === 'list') {
      const entries = Object.entries(project.config.connections).sort(([a], [b]) => a.localeCompare(b));
      if (entries.length === 0) {
        io.stdout.write('No connections configured. Run `ktx setup` to add one.\n');
        return 0;
      }
      const federated = federatedConnectionListing(project.config.connections, args.projectDir);
      const idCandidates = [...entries.map(([id]) => id), ...(federated ? [federated.id] : [])];
      const driverLengths = [
        ...entries.map(([, c]) => (c.driver ?? 'unknown').length),
        ...(federated ? [federated.driver.length] : []),
      ];
      const idWidth = Math.max('ID'.length, ...idCandidates.map((id) => id.length));
      const driverWidth = Math.max('DRIVER'.length, ...driverLengths);
      io.stdout.write(`${'ID'.padEnd(idWidth)}  ${'DRIVER'.padEnd(driverWidth)}\n`);
      for (const [id, connection] of entries) {
        io.stdout.write(`${id.padEnd(idWidth)}  ${(connection.driver ?? 'unknown').padEnd(driverWidth)}\n`);
      }
      if (federated) {
        io.stdout.write(`${federated.id.padEnd(idWidth)}  ${federated.driver.padEnd(driverWidth)}\n`);
        io.stdout.write(`  federates: ${federated.members.join(', ')}\n`);
        io.stdout.write(`  ${federated.hint}\n`);
      }
      return 0;
    }

    if (args.command === 'test-all') {
      return await runTestAll(project, io, deps);
    }

    const startedAt = performance.now();
    let driver = normalizedConnectionDriver(project, args.connectionId) || 'unknown';
    let detailKey: string;
    let detailValue: string;
    try {
      const outcome = await testConnectionByDriver(project, args.connectionId, deps);
      driver = outcome.driver;
      detailKey = outcome.detailKey;
      detailValue = outcome.detailValue;
      await emitConnectionTest({
        project,
        connectionId: args.connectionId,
        driver,
        outcome: 'ok',
        durationMs: Math.max(0, performance.now() - startedAt),
        io,
      });
    } catch (error) {
      await emitConnectionTest({
        project,
        connectionId: args.connectionId,
        driver,
        outcome: 'error',
        durationMs: Math.max(0, performance.now() - startedAt),
        error,
        io,
      });
      throw error;
    }
    io.stdout.write(`Connection test passed: ${args.connectionId}\n`);
    io.stdout.write(`Driver: ${driver}\n`);
    io.stdout.write(`${detailKey}: ${detailValue}\n`);
    return 0;
  } catch (error) {
    io.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`);
    return 1;
  }
}
