import { type ChildProcess, spawn } from 'node:child_process';
import { chmod, mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { createServer } from 'node:http';
import type { AddressInfo } from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import Database from 'better-sqlite3';
import { afterEach, beforeEach, describe, expect, it, type Mock, vi } from 'vitest';
import { parseKtxProjectConfig, serializeKtxProjectConfig } from '../src/context/project/config.js';
import { initKtxProject, loadKtxProject } from '../src/context/project/project.js';
import { KtxExpectedError } from '../src/errors.js';
import { createKtxMcpServerFactory } from '../src/mcp-server-factory.js';

const telemetry = vi.hoisted(() => ({
  emitTelemetryEvent: vi.fn(async (_input: { name: string; fields: Record<string, unknown> }) => {}),
  reportException: vi.fn(async (_input: { error: unknown }) => {}),
}));

vi.mock('../src/telemetry/index.js', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../src/telemetry/index.js')>()),
  emitTelemetryEvent: telemetry.emitTelemetryEvent,
  reportException: telemetry.reportException,
}));

const CLI_VERSION = '0.0.0-recovery-test';
const SQL = 'select count(*) as order_count from orders';

const FAKE_DAEMON_SCRIPT = `
const subcommand = process.argv[2];
let input = '';
process.stdin.on('data', (chunk) => { input += chunk; });
process.stdin.on('end', () => {
  if (subcommand !== 'semantic-query') {
    process.stderr.write('unsupported subcommand: ' + subcommand);
    process.exit(2);
  }
  const { query } = JSON.parse(input);
  if (JSON.stringify(query.measures).includes('orders.unknown')) {
    process.stderr.write('Unknown measure: orders.unknown');
    process.exit(3);
  }
  process.stdout.write(JSON.stringify({
    sql: ${JSON.stringify(SQL)},
    dialect: 'sqlite',
    columns: [{ name: 'order_count' }],
    plan: {},
  }));
});
`;

interface FakeDaemonServer {
  port: number;
  baseUrl: string;
  requests: string[];
  close(): Promise<void>;
}

type ToolResult = Awaited<ReturnType<Client['callTool']>>;

function textOf(result: ToolResult): string {
  return (result.content as Array<{ text?: string }>).map((item) => item.text ?? '').join('\n');
}

describe('MCP managed daemon recovery through production wiring', () => {
  let root: string;
  let projectDir: string;
  let sleeper: ChildProcess;
  let stderr: string;
  let stdoutWrite: Mock<(chunk: string) => void>;
  const servers: FakeDaemonServer[] = [];
  const clients: Client[] = [];

  async function startFakeDaemonServer(options: { closeAfterHealth?: boolean } = {}): Promise<FakeDaemonServer> {
    const requests: string[] = [];
    const server = createServer((request, response) => {
      requests.push(`${request.method} ${request.url}`);
      request.resume();
      request.on('end', () => {
        response.setHeader('connection', 'close');
        if (request.url === '/health') {
          response.end(JSON.stringify({ status: 'healthy', version: CLI_VERSION }));
          if (options.closeAfterHealth) {
            server.close();
          }
          return;
        }
        if (request.url === '/sql/validate-read-only') {
          response.end(JSON.stringify({ ok: true }));
          return;
        }
        response.statusCode = 404;
        response.end(JSON.stringify({ detail: 'not found' }));
      });
    });
    await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
    const { port } = server.address() as AddressInfo;
    let closed: Promise<void> | undefined;
    const handle: FakeDaemonServer = {
      port,
      baseUrl: `http://127.0.0.1:${port}`,
      requests,
      close: () => {
        closed ??= new Promise<void>((resolve) => {
          server.closeAllConnections();
          server.close(() => resolve());
        });
        return closed;
      },
    };
    servers.push(handle);
    return handle;
  }

  async function recordDaemon(server: FakeDaemonServer, startedAt: string): Promise<void> {
    const stateDir = join(projectDir, '.ktx', 'runtime');
    await mkdir(stateDir, { recursive: true });
    await writeFile(
      join(stateDir, 'daemon.json'),
      `${JSON.stringify({
        schemaVersion: 1,
        pid: sleeper.pid,
        host: '127.0.0.1',
        port: server.port,
        version: CLI_VERSION,
        features: ['core'],
        startedAt,
        stdoutLog: join(stateDir, 'daemon.stdout.log'),
        stderrLog: join(stateDir, 'daemon.stderr.log'),
      })}\n`,
    );
  }

  async function connectClient(): Promise<Client> {
    const project = await loadKtxProject({ projectDir });
    const createServerForSession = await createKtxMcpServerFactory({
      project,
      projectDir,
      cliVersion: CLI_VERSION,
      io: { stdout: { write: stdoutWrite }, stderr: { write: (chunk: string) => (stderr += chunk) } },
    });
    const client = new Client({ name: 'ktx-recovery-test', version: '0.0.0-test' });
    const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
    await createServerForSession().connect(serverTransport);
    await client.connect(clientTransport);
    clients.push(client);
    return client;
  }

  async function executeSql(client: Client): Promise<ToolResult> {
    return await client.callTool({ name: 'sql_execution', arguments: { connectionId: 'warehouse', sql: SQL } });
  }

  beforeEach(async () => {
    root = await mkdtemp(join(tmpdir(), 'ktx-mcp-recovery-'));
    projectDir = join(root, 'project');
    stderr = '';
    stdoutWrite = vi.fn();
    telemetry.emitTelemetryEvent.mockClear();
    telemetry.reportException.mockClear();

    const runtimeRoot = join(root, 'runtime');
    const versionDir = join(runtimeRoot, CLI_VERSION);
    const binDir = join(versionDir, '.venv', 'bin');
    await mkdir(binDir, { recursive: true });
    const scriptPath = join(root, 'fake-ktx-daemon.mjs');
    await writeFile(scriptPath, FAKE_DAEMON_SCRIPT);
    const daemonExecutable = join(binDir, 'ktx-daemon');
    await writeFile(daemonExecutable, `#!/bin/sh\nexec "${process.execPath}" "${scriptPath}" "$@"\n`);
    await chmod(daemonExecutable, 0o755);
    await writeFile(join(binDir, 'python'), '');
    await writeFile(
      join(versionDir, 'manifest.json'),
      JSON.stringify({
        schemaVersion: 1,
        cliVersion: CLI_VERSION,
        installedAt: '2026-05-11T00:00:00.000Z',
        asset: {
          schemaVersion: 1,
          distributionName: 'kaelio-ktx',
          normalizedName: 'kaelio_ktx',
          version: CLI_VERSION,
          wheel: { file: 'kaelio_ktx-0.0.0-py3-none-any.whl', sha256: 'a'.repeat(64), bytes: 1 },
        },
        features: ['core'],
        python: { executable: join(binDir, 'python'), daemonExecutable },
        installLog: join(versionDir, 'install.log'),
      }),
    );
    vi.stubEnv('KTX_RUNTIME_ROOT', runtimeRoot);
    vi.stubEnv('KTX_TELEMETRY_DISABLED', '1');

    await initKtxProject({ projectDir });
    const config = parseKtxProjectConfig(await readFile(join(projectDir, 'ktx.yaml'), 'utf-8'));
    await writeFile(
      join(projectDir, 'ktx.yaml'),
      serializeKtxProjectConfig({ ...config, connections: { warehouse: { driver: 'sqlite', path: 'warehouse.db' } } }),
      'utf-8',
    );
    const database = new Database(join(projectDir, 'warehouse.db'));
    database.exec("create table orders (id integer primary key, status text); insert into orders (status) values ('paid'), ('open');");
    database.close();

    // Recorded daemons point at a process this test owns, so no lifecycle path can signal the test runner.
    sleeper = spawn(process.execPath, ['-e', 'setInterval(() => {}, 1 << 30)'], { stdio: 'ignore' });
  });

  afterEach(async () => {
    await Promise.all(clients.splice(0).map((client) => client.close()));
    await Promise.all(servers.splice(0).map((server) => server.close()));
    sleeper.kill('SIGKILL');
    vi.unstubAllEnvs();
    await rm(root, { recursive: true, force: true });
  });

  it('recovers sql_execution after the recorded daemon is replaced while sl_query stays on the subprocess', async () => {
    const original = await startFakeDaemonServer();
    const replacement = await startFakeDaemonServer();
    await recordDaemon(original, '2026-05-11T00:00:01.000Z');
    const client = await connectClient();

    const first = await executeSql(client);
    expect(first.isError).not.toBe(true);
    expect(original.requests).toContain('POST /sql/validate-read-only');

    await original.close();
    await recordDaemon(replacement, '2026-05-11T00:00:02.000Z');

    const recovered = await executeSql(client);
    expect(recovered.isError).not.toBe(true);
    expect(textOf(recovered)).toContain('order_count');
    expect(replacement.requests).toEqual(['GET /health', 'POST /sql/validate-read-only']);
    expect(stderr).toContain(`ktx daemon at ${original.baseUrl} (pid ${sleeper.pid}) refused the connection (ECONNREFUSED)`);
    expect(stderr).toContain(`Using existing ktx daemon: ${replacement.baseUrl}`);

    const daemonRequestCount = original.requests.length + replacement.requests.length;
    const semanticQuery = await client.callTool({
      name: 'sl_query',
      arguments: { connectionId: 'warehouse', measures: ['orders.order_count'] },
    });
    expect(semanticQuery.isError).not.toBe(true);
    expect(textOf(semanticQuery)).toContain('order_count');
    expect(original.requests.length + replacement.requests.length).toBe(daemonRequestCount);

    expect(stdoutWrite).not.toHaveBeenCalled();
    const events = telemetry.emitTelemetryEvent.mock.calls.map(([input]) => input);
    expect(events.map((event) => event.name)).not.toEqual(
      expect.arrayContaining([expect.stringMatching(/^daemon_/)]),
    );
    const serializedFields = JSON.stringify(events.map((event) => event.fields));
    expect(serializedFields).not.toContain(root);
    expect(serializedFields).not.toContain(SQL);
  });

  it('reports a persistent daemon connectivity failure as a tool fault after one recovery attempt', async () => {
    const original = await startFakeDaemonServer();
    const replacement = await startFakeDaemonServer({ closeAfterHealth: true });
    await recordDaemon(original, '2026-05-11T00:00:01.000Z');
    const client = await connectClient();
    expect((await executeSql(client)).isError).not.toBe(true);

    await original.close();
    await recordDaemon(replacement, '2026-05-11T00:00:02.000Z');
    const result = await executeSql(client);

    expect(result.isError).toBe(true);
    expect(textOf(result)).toBe(
      `ktx daemon at ${replacement.baseUrl} refused the connection (ECONNREFUSED) after recovering from ` +
        `${original.baseUrl}; giving up after 2 attempts`,
    );
    expect(replacement.requests).toEqual(['GET /health']);
    const reported = telemetry.reportException.mock.calls.map(([input]) => input.error);
    expect(reported).toHaveLength(1);
    expect(reported[0]).toMatchObject({ name: 'ManagedPythonDaemonUnavailableError' });
    expect(reported[0]).not.toBeInstanceOf(KtxExpectedError);
    const failedEvent = telemetry.emitTelemetryEvent.mock.calls.map(([input]) => input).at(-1);
    expect(failedEvent?.fields).toMatchObject({ toolName: 'sql_execution', outcome: 'error' });
    expect(JSON.stringify(failedEvent?.fields)).not.toContain(root);
    expect(JSON.stringify(failedEvent?.fields)).not.toContain(SQL);
  });

  it('keeps semantic-query rejections as expected query errors without daemon recovery', async () => {
    const original = await startFakeDaemonServer();
    await recordDaemon(original, '2026-05-11T00:00:01.000Z');
    const client = await connectClient();
    const requestsBefore = [...original.requests];

    const result = await client.callTool({
      name: 'sl_query',
      arguments: { connectionId: 'warehouse', measures: ['orders.unknown'] },
    });

    expect(result.isError).toBe(true);
    expect(textOf(result)).toContain('Unknown measure: orders.unknown');
    expect(original.requests).toEqual(requestsBefore);
    expect(stderr).not.toContain('refused the connection');
    const reported = telemetry.reportException.mock.calls.map(([input]) => input.error);
    expect(reported).toHaveLength(1);
    expect(reported[0]).toBeInstanceOf(KtxExpectedError);
  });
});
