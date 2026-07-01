import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { LookerClient } from '../src/context/ingest/adapters/looker/client.js';
import type { MetabaseRuntimeClient } from '../src/context/ingest/adapters/metabase/client-port.js';
import type { NotionClient } from '../src/context/ingest/adapters/notion/notion-client.js';
import { initKtxProject } from '../src/context/project/project.js';
import { parseKtxProjectConfig, serializeKtxProjectConfig } from '../src/context/project/config.js';
import type { KtxConnectionDriver, KtxScanConnector } from '../src/context/scan/types.js';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { runKtxConnection } from '../src/connection.js';

const reportExceptionMock = vi.hoisted(() => vi.fn(async () => {}));

vi.mock('../src/telemetry/exception.js', () => ({
  reportException: reportExceptionMock,
}));

function stripAnsi(s: string): string {
  return s.replace(/\[[0-9;]*m/g, '');
}

function makeIo() {
  let stdout = '';
  let stderr = '';
  return {
    io: {
      stdout: {
        isTTY: true,
        write: (chunk: string) => {
          stdout += chunk;
        },
      },
      stderr: {
        write: (chunk: string) => {
          stderr += chunk;
        },
      },
    },
    stdout: () => stdout,
    stderr: () => stderr,
  };
}

function nativeConnector(
  driver: KtxConnectionDriver,
  testResult: { success: true } | { success: false; error: string; cause?: unknown } = { success: true },
) {
  const testConnection = vi.fn(async () => testResult);
  const cleanup = vi.fn(async () => undefined);
  const connector: KtxScanConnector = {
    id: `${driver}:warehouse`,
    driver,
    capabilities: {
      structuralIntrospection: true,
      tableSampling: false,
      columnSampling: false,
      columnStats: false,
      readOnlySql: false,
      nestedAnalysis: false,
      eventStreamDiscovery: false,
      formalForeignKeys: false,
      estimatedRowCounts: false,
    },
    introspect: vi.fn(async () => {
      throw new Error('introspect should not be called from connection test');
    }),
    listSchemas: vi.fn(async () => []),
    listTables: vi.fn(async () => []),
    testConnection,
    cleanup,
  };
  return { connector, testConnection, cleanup };
}

describe('runKtxConnection', () => {
  let tempDir: string;

  beforeEach(async () => {
    tempDir = await mkdtemp(join(tmpdir(), 'ktx-cli-connection-'));
    reportExceptionMock.mockClear();
  });

  afterEach(async () => {
    vi.unstubAllEnvs();
    await rm(tempDir, { recursive: true, force: true });
  });

  async function writeConnections(
    projectDir: string,
    connections: ReturnType<typeof parseKtxProjectConfig>['connections'],
  ): Promise<void> {
    const config = parseKtxProjectConfig(await readFile(join(projectDir, 'ktx.yaml'), 'utf-8'));
    await writeFile(join(projectDir, 'ktx.yaml'), serializeKtxProjectConfig({ ...config, connections }), 'utf-8');
  }

  it('lists configured connections without resolving secrets', async () => {
    const projectDir = join(tempDir, 'project');
    await initKtxProject({ projectDir });
    await writeConnections(projectDir, {
      warehouse: { driver: 'postgres', url: 'env:DATABASE_URL' },
      docs: { driver: 'notion', auth_token_ref: 'env:NOTION_TOKEN', crawl_mode: 'all_accessible' },
    });
    const io = makeIo();

    await expect(runKtxConnection({ command: 'list', projectDir }, io.io)).resolves.toBe(0);

    expect(io.stdout()).toContain('warehouse');
    expect(io.stdout()).toContain('postgres');
    expect(io.stdout()).toContain('docs');
    expect(io.stdout()).toContain('notion');
    expect(io.stderr()).toBe('');
  });

  it('prints an empty-state message that points at setup instead of removed connection add', async () => {
    const projectDir = join(tempDir, 'project');
    await initKtxProject({ projectDir });
    const io = makeIo();

    await expect(runKtxConnection({ command: 'list', projectDir }, io.io)).resolves.toBe(0);

    expect(io.stdout()).toContain('No connections configured. Run `ktx setup` to add one.');
    expect(io.stdout()).not.toContain('ktx connection add');
  });

  it('tests a native connection by calling connector.testConnection (not introspect)', async () => {
    const projectDir = join(tempDir, 'project');
    await initKtxProject({ projectDir });
    await writeConnections(projectDir, {
      warehouse: { driver: 'sqlite' },
    });
    const { connector, testConnection, cleanup } = nativeConnector('sqlite');
    const createScanConnector = vi.fn(async () => connector);
    const io = makeIo();

    await expect(
      runKtxConnection({ command: 'test', projectDir, connectionId: 'warehouse' }, io.io, {
        createScanConnector,
      }),
    ).resolves.toBe(0);

    expect(createScanConnector).toHaveBeenCalledWith(expect.objectContaining({ projectDir }), 'warehouse');
    expect(testConnection).toHaveBeenCalledTimes(1);
    expect(connector.introspect).not.toHaveBeenCalled();
    expect(cleanup).toHaveBeenCalledTimes(1);
    expect(io.stdout()).toContain('Connection test passed: warehouse');
    expect(io.stdout()).toContain('Driver: sqlite');
    expect(io.stdout()).toContain('Status: ok');
  });

  it('emits debug telemetry for connection tests without project paths', async () => {
    vi.stubEnv('KTX_TELEMETRY_DEBUG', '1');
    vi.stubEnv('CI', '');
    const projectDir = join(tempDir, 'project');
    await initKtxProject({ projectDir });
    await writeConnections(projectDir, {
      warehouse: { driver: 'postgres', url: 'env:DATABASE_URL' },
    });
    const { connector } = nativeConnector('postgres');
    const io = makeIo();

    const code = await runKtxConnection({ command: 'test', projectDir, connectionId: 'warehouse' }, io.io, {
      createScanConnector: vi.fn(async () => connector),
    });

    expect(code).toBe(0);
    expect(io.stderr()).toContain('"event":"connection_test"');
    expect(io.stderr()).toContain('"driver":"postgres"');
    expect(io.stderr()).not.toContain(projectDir);
  });

  it('records the raw errorDetail in connection_test telemetry when a native test fails', async () => {
    vi.stubEnv('KTX_TELEMETRY_DEBUG', '1');
    vi.stubEnv('CI', '');
    vi.stubEnv('DATABASE_URL', 'postgres://svc:db-url-password@db.example.test/analytics'); // pragma: allowlist secret
    const projectDir = join(tempDir, 'project');
    await initKtxProject({ projectDir });
    await writeConnections(projectDir, {
      warehouse: { driver: 'postgres', url: 'env:DATABASE_URL' },
    });
    const { connector } = nativeConnector('postgres', { success: false, error: 'database file is unreadable' });
    const io = makeIo();

    const code = await runKtxConnection({ command: 'test', projectDir, connectionId: 'warehouse' }, io.io, {
      createScanConnector: vi.fn(async () => connector),
    });

    expect(code).toBe(1);
    expect(io.stderr()).toContain('"event":"connection_test"');
    expect(io.stderr()).toContain('"outcome":"error"');
    expect(io.stderr()).toContain('"errorDetail":"database file is unreadable"');
    expect(reportExceptionMock).toHaveBeenCalledWith(
      expect.objectContaining({
        context: expect.objectContaining({ source: 'connection test', handled: true, fatal: false }),
        projectDir,
        redactionSecrets: expect.arrayContaining([
          'postgres://svc:db-url-password@db.example.test/analytics', // pragma: allowlist secret
          'db-url-password',
        ]),
      }),
    );
  });

  it('preserves the driver error class and code in connection_test telemetry', async () => {
    vi.stubEnv('KTX_TELEMETRY_DEBUG', '1');
    vi.stubEnv('CI', '');
    const projectDir = join(tempDir, 'project');
    await initKtxProject({ projectDir });
    await writeConnections(projectDir, {
      warehouse: { driver: 'sqlserver', host: 'db.example.test', database: 'analytics', username: 'svc_ro' },
    });
    class ConnectionError extends Error {
      readonly code = 'ELOGIN';
    }
    const driverError = new ConnectionError("Login failed for user 'svc_ro'.");
    const { connector } = nativeConnector('sqlserver', {
      success: false,
      error: driverError.message,
      cause: driverError,
    });
    const io = makeIo();

    const code = await runKtxConnection({ command: 'test', projectDir, connectionId: 'warehouse' }, io.io, {
      createScanConnector: vi.fn(async () => connector),
    });

    expect(code).toBe(1);
    expect(io.stderr()).toContain('"errorClass":"ConnectionError"');
    expect(io.stderr()).toContain('"errorDetail":"ELOGIN: Login failed for user \'svc_ro\'."');
  });

  it('reports the connector error and still cleans up when native testConnection fails', async () => {
    const projectDir = join(tempDir, 'project');
    await initKtxProject({ projectDir });
    await writeConnections(projectDir, {
      warehouse: { driver: 'sqlite' },
    });
    const { connector, cleanup } = nativeConnector('sqlite', { success: false, error: 'database file is unreadable' });
    const io = makeIo();

    await expect(
      runKtxConnection({ command: 'test', projectDir, connectionId: 'warehouse' }, io.io, {
        createScanConnector: vi.fn(async () => connector),
      }),
    ).resolves.toBe(1);

    expect(cleanup).toHaveBeenCalledTimes(1);
    expect(io.stderr()).toContain('database file is unreadable');
  });

  it('tests a configured Metabase connection through the Metabase runtime client', async () => {
    const projectDir = join(tempDir, 'project');
    await initKtxProject({ projectDir });
    await writeConnections(projectDir, {
      prod_metabase: {
        driver: 'metabase',
        api_url: 'http://metabase.example.test',
        api_key: 'mb_test', // pragma: allowlist secret
      },
    });
    const testConnection = vi.fn(async () => ({ success: true as const }));
    const getDatabases = vi.fn(async () => [
      { id: 1, name: 'Analytics', engine: 'postgres', details: {}, is_sample: false },
      { id: 2, name: 'Sample Database', engine: 'h2', details: {}, is_sample: true },
    ]);
    const cleanup = vi.fn(async () => undefined);
    const createMetabaseClient = vi.fn(
      async (): Promise<Pick<MetabaseRuntimeClient, 'testConnection' | 'getDatabases' | 'cleanup'>> => ({
        testConnection,
        getDatabases,
        cleanup,
      }),
    );
    const createScanConnector = vi.fn(async () => {
      throw new Error('native scanner should not be used for Metabase');
    });
    const io = makeIo();

    await expect(
      runKtxConnection({ command: 'test', projectDir, connectionId: 'prod_metabase' }, io.io, {
        createScanConnector,
        createMetabaseClient,
      }),
    ).resolves.toBe(0);

    expect(createScanConnector).not.toHaveBeenCalled();
    expect(createMetabaseClient).toHaveBeenCalledWith(expect.objectContaining({ projectDir }), 'prod_metabase');
    expect(testConnection).toHaveBeenCalledTimes(1);
    expect(getDatabases).toHaveBeenCalledTimes(1);
    expect(cleanup).toHaveBeenCalledTimes(1);
    expect(io.stdout()).toContain('Connection test passed: prod_metabase');
    expect(io.stdout()).toContain('Driver: metabase');
    expect(io.stdout()).toContain('Databases: 1');
    expect(io.stderr()).toBe('');
  });

  it('tests a Looker connection through the Looker client', async () => {
    const projectDir = join(tempDir, 'project');
    await initKtxProject({ projectDir });
    await writeConnections(projectDir, {
      bi_looker: {
        driver: 'looker',
        base_url: 'https://looker.example.test',
        client_id: 'cid',
        client_secret: 'csecret', // pragma: allowlist secret
      },
    });
    const testConnection = vi.fn(async () => ({
      success: true as const,
      metadata: { displayName: 'Alice Analyst', userId: '42' },
    }));
    const createLookerClient = vi.fn(async (): Promise<Pick<LookerClient, 'testConnection'>> => ({ testConnection }));
    const io = makeIo();

    await expect(
      runKtxConnection({ command: 'test', projectDir, connectionId: 'bi_looker' }, io.io, { createLookerClient }),
    ).resolves.toBe(0);

    expect(createLookerClient).toHaveBeenCalledWith(expect.objectContaining({ projectDir }), 'bi_looker');
    expect(testConnection).toHaveBeenCalledTimes(1);
    expect(io.stdout()).toContain('Connection test passed: bi_looker');
    expect(io.stdout()).toContain('Driver: looker');
    expect(io.stdout()).toContain('User: Alice Analyst');
  });

  it('falls back to userId when Looker metadata has no display name', async () => {
    const projectDir = join(tempDir, 'project');
    await initKtxProject({ projectDir });
    await writeConnections(projectDir, {
      bi_looker: {
        driver: 'looker',
        base_url: 'https://looker.example.test',
        client_id: 'cid',
        client_secret: 'csecret', // pragma: allowlist secret
      },
    });
    const createLookerClient = vi.fn(async (): Promise<Pick<LookerClient, 'testConnection'>> => ({
      testConnection: vi.fn(async () => ({
        success: true as const,
        metadata: { displayName: null, userId: '42' },
      })),
    }));
    const io = makeIo();

    await expect(
      runKtxConnection({ command: 'test', projectDir, connectionId: 'bi_looker' }, io.io, { createLookerClient }),
    ).resolves.toBe(0);
    expect(io.stdout()).toContain('User: 42');
  });

  it('reports the Looker error when testConnection fails', async () => {
    const projectDir = join(tempDir, 'project');
    await initKtxProject({ projectDir });
    await writeConnections(projectDir, {
      bi_looker: {
        driver: 'looker',
        base_url: 'https://looker.example.test',
        client_id: 'cid',
        client_secret: 'csecret', // pragma: allowlist secret
      },
    });
    const createLookerClient = vi.fn(async (): Promise<Pick<LookerClient, 'testConnection'>> => ({
      testConnection: vi.fn(async () => ({ success: false as const, error: 'invalid client_id' })),
    }));
    const io = makeIo();

    await expect(
      runKtxConnection({ command: 'test', projectDir, connectionId: 'bi_looker' }, io.io, { createLookerClient }),
    ).resolves.toBe(1);
    expect(io.stderr()).toContain('Looker connection test failed: invalid client_id');
  });

  it('tests a Notion connection by retrieving the bot user', async () => {
    const projectDir = join(tempDir, 'project');
    await initKtxProject({ projectDir });
    await writeConnections(projectDir, {
      docs: {
        driver: 'notion',
        auth_token: 'secret_token', // pragma: allowlist secret
        crawl_mode: 'all_accessible',
      },
    });
    const retrieveBotUser = vi.fn(async () => ({ id: 'bot-1', name: 'Analytics Bot' }));
    const createNotionClient = vi.fn(async (): Promise<Pick<NotionClient, 'retrieveBotUser'>> => ({ retrieveBotUser }));
    const io = makeIo();

    await expect(
      runKtxConnection({ command: 'test', projectDir, connectionId: 'docs' }, io.io, { createNotionClient }),
    ).resolves.toBe(0);

    expect(createNotionClient).toHaveBeenCalledWith(expect.objectContaining({ projectDir }), 'docs');
    expect(retrieveBotUser).toHaveBeenCalledTimes(1);
    expect(io.stdout()).toContain('Connection test passed: docs');
    expect(io.stdout()).toContain('Driver: notion');
    expect(io.stdout()).toContain('Bot: Analytics Bot');
  });

  it('falls back to bot id when Notion bot has no name', async () => {
    const projectDir = join(tempDir, 'project');
    await initKtxProject({ projectDir });
    await writeConnections(projectDir, {
      docs: {
        driver: 'notion',
        auth_token: 'secret_token', // pragma: allowlist secret
        crawl_mode: 'all_accessible',
      },
    });
    const createNotionClient = vi.fn(async (): Promise<Pick<NotionClient, 'retrieveBotUser'>> => ({
      retrieveBotUser: vi.fn(async () => ({ id: 'bot-1', name: null })),
    }));
    const io = makeIo();

    await expect(
      runKtxConnection({ command: 'test', projectDir, connectionId: 'docs' }, io.io, { createNotionClient }),
    ).resolves.toBe(0);
    expect(io.stdout()).toContain('Bot: bot-1');
  });

  it('tests a Google Drive connection by listing visible Google Docs', async () => {
    const projectDir = join(tempDir, 'project');
    await initKtxProject({ projectDir });
    await writeConnections(projectDir, {
      docs_drive: {
        driver: 'gdrive',
        service_account_key_ref: 'file:/tmp/gdrive-key.json', // pragma: allowlist secret
        folder_id: 'folder-123',
        recursive: false,
      },
    });
    const listFiles = vi.fn(async () => ({
      files: [
        { id: '1', name: 'Spec', mimeType: 'application/vnd.google-apps.document', parents: [], webViewLink: null, modifiedTime: null },
        { id: '2', name: 'Sheet', mimeType: 'application/vnd.google-apps.spreadsheet', parents: [], webViewLink: null, modifiedTime: null },
      ],
      nextPageToken: null,
    }));
    const getFile = vi.fn(async () => ({
      id: 'folder-123',
      name: 'Docs',
      mimeType: 'application/vnd.google-apps.folder',
      parents: [],
      webViewLink: null,
      modifiedTime: null,
    }));
    const createGdriveClient = vi.fn(async () => ({ listFiles, getFile }));
    const io = makeIo();

    await expect(
      runKtxConnection({ command: 'test', projectDir, connectionId: 'docs_drive' }, io.io, { createGdriveClient }),
    ).resolves.toBe(0);

    expect(createGdriveClient).toHaveBeenCalledWith(expect.objectContaining({ projectDir }), 'docs_drive');
    expect(getFile).toHaveBeenCalledWith('folder-123');
    expect(listFiles).toHaveBeenCalledWith({ q: "'folder-123' in parents and trashed = false", pageToken: undefined });
    expect(io.stdout()).toContain('Connection test passed: docs_drive');
    expect(io.stdout()).toContain('Driver: gdrive');
    expect(io.stdout()).toContain('Docs: 1');
  });

  it('fails a Google Drive connection test when the folder is not accessible', async () => {
    const projectDir = join(tempDir, 'project');
    await initKtxProject({ projectDir });
    await writeConnections(projectDir, {
      docs_drive: {
        driver: 'gdrive',
        service_account_key_ref: 'file:/tmp/gdrive-key.json', // pragma: allowlist secret
        folder_id: 'missing-folder',
        recursive: false,
      },
    });
    const listFiles = vi.fn();
    const getFile = vi.fn(async () => null);
    const createGdriveClient = vi.fn(async () => ({ listFiles, getFile }));
    const io = makeIo();

    await expect(
      runKtxConnection({ command: 'test', projectDir, connectionId: 'docs_drive' }, io.io, { createGdriveClient }),
    ).resolves.toBe(1);

    expect(getFile).toHaveBeenCalledWith('missing-folder');
    expect(listFiles).not.toHaveBeenCalled();
    expect(io.stderr()).toContain('is not accessible');
  });

  it('tests a dbt connection via testRepoConnection (success)', async () => {
    const projectDir = join(tempDir, 'project');
    await initKtxProject({ projectDir });
    process.env.DBT_TOKEN = 'gh_token_abc'; // pragma: allowlist secret
    await writeConnections(projectDir, {
      'dbt-main': {
        driver: 'dbt',
        repo_url: 'https://github.com/example/dbt-project',
        auth_token_ref: 'env:DBT_TOKEN',
      },
    });
    const testRepoConnection = vi.fn(async () => ({ ok: true as const }));
    const io = makeIo();

    try {
      await expect(
        runKtxConnection({ command: 'test', projectDir, connectionId: 'dbt-main' }, io.io, { testRepoConnection }),
      ).resolves.toBe(0);

      expect(testRepoConnection).toHaveBeenCalledWith({
        repoUrl: 'https://github.com/example/dbt-project',
        authToken: 'gh_token_abc',
      });
      expect(io.stdout()).toContain('Connection test passed: dbt-main');
      expect(io.stdout()).toContain('Driver: dbt');
      expect(io.stdout()).toContain('Repo: https://github.com/example/dbt-project');
    } finally {
      delete process.env.DBT_TOKEN;
    }
  });

  it('reports the git error when testRepoConnection fails for dbt', async () => {
    const projectDir = join(tempDir, 'project');
    await initKtxProject({ projectDir });
    await writeConnections(projectDir, {
      'dbt-main': {
        driver: 'dbt',
        repo_url: 'https://github.com/example/dbt-project',
      },
    });
    const testRepoConnection = vi.fn(async () => ({ ok: false as const, error: 'fatal: auth failed' }));
    const io = makeIo();

    await expect(
      runKtxConnection({ command: 'test', projectDir, connectionId: 'dbt-main' }, io.io, { testRepoConnection }),
    ).resolves.toBe(1);

    expect(testRepoConnection).toHaveBeenCalledWith({
      repoUrl: 'https://github.com/example/dbt-project',
      authToken: null,
    });
    expect(io.stderr()).toContain('dbt repository check failed: fatal: auth failed');
  });

  it('tests a LookML connection via testRepoConnection with camelCase repoUrl', async () => {
    const projectDir = join(tempDir, 'project');
    await initKtxProject({ projectDir });
    await writeConnections(projectDir, {
      lookml_main: {
        driver: 'lookml',
        repoUrl: 'https://github.com/example/lookml',
      },
    });
    const testRepoConnection = vi.fn(async () => ({ ok: true as const }));
    const io = makeIo();

    await expect(
      runKtxConnection({ command: 'test', projectDir, connectionId: 'lookml_main' }, io.io, { testRepoConnection }),
    ).resolves.toBe(0);
    expect(testRepoConnection).toHaveBeenCalledWith({
      repoUrl: 'https://github.com/example/lookml',
      authToken: null,
    });
    expect(io.stdout()).toContain('Driver: lookml');
    expect(io.stdout()).toContain('Repo: https://github.com/example/lookml');
  });

  it('tests a MetricFlow connection via the nested metricflow block', async () => {
    const projectDir = join(tempDir, 'project');
    await initKtxProject({ projectDir });
    await writeConnections(projectDir, {
      mf_main: {
        driver: 'metricflow',
        metricflow: { repoUrl: 'https://github.com/example/metricflow' },
      },
    });
    const testRepoConnection = vi.fn(async () => ({ ok: true as const }));
    const io = makeIo();

    await expect(
      runKtxConnection({ command: 'test', projectDir, connectionId: 'mf_main' }, io.io, { testRepoConnection }),
    ).resolves.toBe(0);
    expect(testRepoConnection).toHaveBeenCalledWith({
      repoUrl: 'https://github.com/example/metricflow',
      authToken: null,
    });
    expect(io.stdout()).toContain('Driver: metricflow');
  });

  it('--all: prints a single coherent list with one row per connection', async () => {
    const projectDir = join(tempDir, 'project');
    await initKtxProject({ projectDir });
    await writeConnections(projectDir, {
      warehouse: { driver: 'sqlite' },
      docs: { driver: 'notion', auth_token: 'secret_token', crawl_mode: 'all_accessible' }, // pragma: allowlist secret
    });
    const { connector } = nativeConnector('sqlite');
    const createScanConnector = vi.fn(async () => connector);
    const createNotionClient = vi.fn(async (): Promise<Pick<NotionClient, 'retrieveBotUser'>> => ({
      retrieveBotUser: vi.fn(async () => ({ id: 'bot-1', name: 'Docs Bot' })),
    }));
    const io = makeIo();

    await expect(
      runKtxConnection({ command: 'test-all', projectDir }, io.io, { createScanConnector, createNotionClient }),
    ).resolves.toBe(0);

    const out = stripAnsi(io.stdout());
    expect(out).toContain('connection test --all');
    expect(out).toMatch(/docs\s+notion\s+✓ ok\s+Bot: Docs Bot/);
    expect(out).toMatch(/warehouse\s+sqlite\s+✓ ok\s+Status: ok/);
    expect(out).toContain('2 tested');
    expect(out).toContain('2 passed');
    expect(out).not.toContain('failed');
    expect(io.stderr()).toBe('');
  });

  it('--all: includes Google Drive rows in the summary table', async () => {
    const projectDir = join(tempDir, 'project');
    await initKtxProject({ projectDir });
    await writeConnections(projectDir, {
      docs_drive: {
        driver: 'gdrive',
        service_account_key_ref: 'file:/tmp/gdrive-key.json', // pragma: allowlist secret
        folder_id: 'folder-123',
        recursive: false,
      },
    });
    const createGdriveClient = vi.fn(async () => ({
      listFiles: vi.fn(async () => ({
        files: [
          { id: '1', name: 'Spec', mimeType: 'application/vnd.google-apps.document', parents: [], webViewLink: null, modifiedTime: null },
        ],
        nextPageToken: null,
      })),
      getFile: vi.fn(async () => ({
        id: 'folder-123',
        name: 'Docs',
        mimeType: 'application/vnd.google-apps.folder',
        parents: [],
        webViewLink: null,
        modifiedTime: null,
      })),
    }));
    const io = makeIo();

    await expect(
      runKtxConnection({ command: 'test-all', projectDir }, io.io, { createGdriveClient }),
    ).resolves.toBe(0);

    expect(stripAnsi(io.stdout())).toMatch(/docs_drive\s+gdrive\s+✓ ok\s+Docs: 1/);
  });

  it('--all: marks failing connections, keeps passing ones, and returns non-zero', async () => {
    const projectDir = join(tempDir, 'project');
    await initKtxProject({ projectDir });
    await writeConnections(projectDir, {
      warehouse: { driver: 'sqlite' },
      broken: { driver: 'sqlite' },
    });
    const okConnector = nativeConnector('sqlite').connector;
    const failConnector = nativeConnector('sqlite', { success: false, error: 'database file is unreadable' }).connector;
    const createScanConnector = vi.fn(async (_p, connectionId: string) =>
      connectionId === 'broken' ? failConnector : okConnector,
    );
    const io = makeIo();

    await expect(
      runKtxConnection({ command: 'test-all', projectDir }, io.io, { createScanConnector }),
    ).resolves.toBe(1);

    const out = stripAnsi(io.stdout());
    expect(out).toMatch(/broken\s+sqlite\s+✗ failed\s+database file is unreadable/);
    expect(out).toMatch(/warehouse\s+sqlite\s+✓ ok\s+Status: ok/);
    expect(out).toContain('1 passed');
    expect(out).toContain('1 failed');
    expect(io.stderr()).toBe('');
  });

  it('--all: shows an empty-state message when no connections are configured', async () => {
    const projectDir = join(tempDir, 'project');
    await initKtxProject({ projectDir });
    const io = makeIo();

    await expect(runKtxConnection({ command: 'test-all', projectDir }, io.io)).resolves.toBe(0);

    const out = stripAnsi(io.stdout());
    expect(out).toContain('connection test --all');
    expect(out).toContain('No connections configured. Run `ktx setup` to add one.');
  });

  it('rejects unknown drivers with a helpful error', async () => {
    const projectDir = join(tempDir, 'project');
    await initKtxProject({ projectDir });
    await writeFile(
      join(projectDir, 'ktx.yaml'),
      'connections:\n  mystery:\n    driver: nonsense\n',
      'utf-8',
    );
    const io = makeIo();

    await expect(
      runKtxConnection({ command: 'test', projectDir, connectionId: 'mystery' }, io.io),
    ).resolves.toBe(1);
    expect(io.stderr()).toContain('connections.mystery.driver');
    expect(io.stderr()).toContain('postgres');
  });
});
