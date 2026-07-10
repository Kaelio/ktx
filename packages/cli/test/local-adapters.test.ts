import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { loadKtxProject } from '../src/context/project/project.js';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { createKtxCliHistoricSqlRuntime, createKtxCliLocalIngestAdapters } from '../src/local-adapters.js';

function sqlAnalysisStub() {
  return {
    async analyzeForFingerprint(sql: string) {
      return {
        fingerprint: 'fp',
        normalizedSql: sql,
        tablesTouched: [],
        literalSlots: [],
      };
    },
    async analyzeBatch() {
      return new Map();
    },
    async validateReadOnly() {
      return { ok: true };
    },
  };
}

async function writeProject(projectDir: string, body: string): Promise<void> {
  await writeFile(join(projectDir, 'ktx.yaml'), body, 'utf-8');
}

describe('CLI local ingest adapters', () => {
  let tempDir: string;

  beforeEach(async () => {
    tempDir = await mkdtemp(join(tmpdir(), 'ktx-cli-local-adapters-'));
  });

  afterEach(async () => {
    await rm(tempDir, { recursive: true, force: true });
  });

  it('registers Postgres historic SQL from connection context query history', async () => {
    await writeProject(
      tempDir,
      [
        'connections:',
        '  warehouse:',
        '    driver: postgres',
        '    url: env:WAREHOUSE_DATABASE_URL',
        '    readonly: true',
        '    context:',
        '      queryHistory:',
        '        enabled: true',
        'ingest:',
        '  adapters:',
        '    - historic-sql',
        '',
      ].join('\n'),
    );
    const project = await loadKtxProject({ projectDir: tempDir });

    const adapters = createKtxCliLocalIngestAdapters(project, {
      historicSqlConnectionId: 'warehouse',
      sqlAnalysis: sqlAnalysisStub(),
    });

    expect(adapters.find((adapter) => adapter.source === 'historic-sql')?.skillNames).toEqual([
      'historic_sql_table_digest',
      'historic_sql_patterns',
    ]);
  });

  it('creates reusable query-history runtime dependencies for setup', async () => {
    await writeProject(
      tempDir,
      [
        'connections:',
        '  warehouse:',
        '    driver: postgres',
        '    url: env:WAREHOUSE_DATABASE_URL',
        '    readonly: true',
        '    context:',
        '      queryHistory:',
        '        enabled: true',
        '',
      ].join('\n'),
    );
    const project = await loadKtxProject({ projectDir: tempDir });
    const sqlAnalysis = sqlAnalysisStub();

    const runtime = createKtxCliHistoricSqlRuntime(project, 'warehouse', { sqlAnalysis });

    expect(runtime).toMatchObject({
      dialect: 'postgres',
      sqlAnalysis,
    });
    expect(runtime?.reader).toBeDefined();
    expect(runtime?.queryClient).toBeDefined();
  });

  it('uses managed daemon SQL analysis when query-history runtime gets managed daemon options', async () => {
    await writeProject(
      tempDir,
      [
        'connections:',
        '  warehouse:',
        '    driver: postgres',
        '    url: env:WAREHOUSE_DATABASE_URL',
        '    readonly: true',
        '    context:',
        '      queryHistory:',
        '        enabled: true',
        '',
      ].join('\n'),
    );
    const project = await loadKtxProject({ projectDir: tempDir });
    const testIo = {
      stdout: { write: vi.fn() },
      stderr: { write: vi.fn() },
    };
    const ensureRuntime = vi.fn(async () => ({
      layout: {} as never,
      manifest: {} as never,
    }));
    const startDaemon = vi.fn(async () => ({
      status: 'started' as const,
      layout: {} as never,
      state: { pid: 1234 } as never,
      baseUrl: 'http://127.0.0.1:61234',
    }));
    const postJson = vi.fn(async () => ({
      results: {
        probe: {
          tables_touched: [],
          columns_by_clause: {},
          error: null,
        },
      },
    }));

    const runtime = createKtxCliHistoricSqlRuntime(project, 'warehouse', {
      managedDaemon: {
        cliVersion: '0.2.0',
        projectDir: tempDir,
        installPolicy: 'auto',
        io: testIo,
        ensureRuntime,
        startDaemon,
        postJson,
      },
    });

    await expect(runtime?.sqlAnalysis.analyzeBatch([{ id: 'probe', sql: 'select 1' }], 'postgres')).resolves.toEqual(
      new Map([
        [
          'probe',
          {
            tablesTouched: [],
            columnsByClause: {},
            error: null,
          },
        ],
      ]),
    );
    expect(ensureRuntime).toHaveBeenCalledWith({
      cliVersion: '0.2.0',
      installPolicy: 'auto',
      io: testIo,
      feature: 'core',
    });
    expect(startDaemon).toHaveBeenCalledWith({
      cliVersion: '0.2.0',
      projectDir: tempDir,
      features: ['core'],
      force: false,
    });
    expect(postJson).toHaveBeenCalledWith('http://127.0.0.1:61234', '/sql/analyze-batch', {
      dialect: 'postgres',
      items: [{ id: 'probe', sql: 'select 1' }],
    });
  });

  it('registers historic SQL when explicitly requested even if connection query history is disabled', async () => {
    await writeProject(
      tempDir,
      [
        'connections:',
        '  warehouse:',
        '    driver: postgres',
        '    url: env:WAREHOUSE_DATABASE_URL',
        '    readonly: true',
        '    context:',
        '      queryHistory:',
        '        enabled: false',
        'ingest:',
        '  adapters:',
        '    - historic-sql',
        '',
      ].join('\n'),
    );
    const project = await loadKtxProject({ projectDir: tempDir });

    // `--query-history` sets historicSqlConnectionId for the run; that explicit
    // request is the opt-in, so the persisted context.queryHistory.enabled flag
    // must not gate adapter registration.
    const adapters = createKtxCliLocalIngestAdapters(project, {
      historicSqlConnectionId: 'warehouse',
      sqlAnalysis: sqlAnalysisStub(),
    });

    expect(adapters.some((adapter) => adapter.source === 'historic-sql')).toBe(true);
  });

  it('registers BigQuery historic SQL with Application Default Credentials', async () => {
    await writeProject(
      tempDir,
      [
        'connections:',
        '  bq:',
        '    driver: bigquery',
        '    project_id: demo-project',
        '    dataset_id: analytics',
        '    location: us',
        '    context:',
        '      queryHistory:',
        '        enabled: true',
        'ingest:',
        '  adapters:',
        '    - historic-sql',
        '',
      ].join('\n'),
    );
    const project = await loadKtxProject({ projectDir: tempDir });

    const adapters = createKtxCliLocalIngestAdapters(project, {
      historicSqlConnectionId: 'bq',
      sqlAnalysis: sqlAnalysisStub(),
    });

    expect(adapters.find((adapter) => adapter.source === 'historic-sql')?.skillNames).toEqual([
      'historic_sql_table_digest',
      'historic_sql_patterns',
    ]);
  });

  it('registers Snowflake historic SQL from the requested connection', async () => {
    await writeProject(
      tempDir,
      [
        'connections:',
        '  sf:',
        '    driver: snowflake',
        '    account: acct',
        '    warehouse: wh',
        '    database: ANALYTICS',
        '    schema_name: PUBLIC',
        '    username: reader',
        '    password: env:SNOWFLAKE_PASSWORD',
        '    context:',
        '      queryHistory:',
        '        enabled: true',
        'ingest:',
        '  adapters:',
        '    - historic-sql',
        '',
      ].join('\n'),
    );
    const project = await loadKtxProject({ projectDir: tempDir });

    const adapters = createKtxCliLocalIngestAdapters(project, {
      historicSqlConnectionId: 'sf',
      sqlAnalysis: sqlAnalysisStub(),
    });

    expect(adapters.find((adapter) => adapter.source === 'historic-sql')?.skillNames).toEqual([
      'historic_sql_table_digest',
      'historic_sql_patterns',
    ]);
  });

  it('resolves BigQuery credentials_json from a file: reference for query history ingest', async () => {
    const credentialsPath = join(tempDir, 'credentials.json');
    await writeFile(credentialsPath, JSON.stringify({ project_id: 'demo-project' }), 'utf-8');
    await writeProject(
      tempDir,
      [
        'connections:',
        '  bq:',
        '    driver: bigquery',
        '    project_id: demo-project',
        '    dataset_id: analytics',
        '    location: us',
        `    credentials_json: 'file:${credentialsPath}'`,
        '    context:',
        '      queryHistory:',
        '        enabled: true',
        'ingest:',
        '  adapters:',
        '    - historic-sql',
        '',
      ].join('\n'),
    );
    const project = await loadKtxProject({ projectDir: tempDir });

    const adapters = createKtxCliLocalIngestAdapters(project, {
      historicSqlConnectionId: 'bq',
      sqlAnalysis: sqlAnalysisStub(),
    });

    expect(adapters.find((adapter) => adapter.source === 'historic-sql')?.skillNames).toEqual([
      'historic_sql_table_digest',
      'historic_sql_patterns',
    ]);
  });

  it('uses the canonical BigQuery project validation for query history ingest', async () => {
    await writeProject(
      tempDir,
      [
        'connections:',
        '  bq:',
        '    driver: bigquery',
        '    readonly: true',
        '    dataset_id: analytics',
        '    context:',
        '      queryHistory:',
        '        enabled: true',
        'ingest:',
        '  adapters:',
        '    - historic-sql',
        '',
      ].join('\n'),
    );
    const project = await loadKtxProject({ projectDir: tempDir });

    expect(() =>
      createKtxCliLocalIngestAdapters(project, {
        historicSqlConnectionId: 'bq',
        sqlAnalysis: sqlAnalysisStub(),
      }),
    ).toThrow('connections.bq.project_id');
  });
});
