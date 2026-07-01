import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import Database from 'better-sqlite3';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { buildDefaultKtxProjectConfig, type KtxProjectConfig } from '../src/context/project/config.js';
import type { KtxLocalProject } from '../src/context/project/project.js';
import {
  buildLocalStatsStatus,
  buildProjectStatus,
  renderProjectStatus,
} from '../src/status-project.js';
import { initKtxProject, loadKtxProject } from '../src/context/project/project.js';
import { serializeKtxProjectConfig } from '../src/context/project/config.js';
import { writeLocalKnowledgePage } from '../src/context/wiki/local-knowledge.js';

const stubClaudeCodeAuthProbeForFileBacked = async () => ({ ok: true as const });

function projectWithConfig(config: KtxProjectConfig): KtxLocalProject {
  return {
    projectDir: '/work/proj',
    configPath: '/work/proj/ktx.yaml',
    config,
    coreConfig: {} as KtxLocalProject['coreConfig'],
    git: {} as KtxLocalProject['git'],
    fileStore: {} as KtxLocalProject['fileStore'],
  };
}

function withEmbeddings(
  config: KtxProjectConfig,
  embeddings: KtxProjectConfig['ingest']['embeddings'],
): KtxProjectConfig {
  return {
    ...config,
    ingest: { ...config.ingest, embeddings },
    scan: { ...config.scan, enrichment: { ...config.scan.enrichment, embeddings } },
  };
}

function withClaudeCodeLlm(config: KtxProjectConfig): KtxProjectConfig {
  return {
    ...config,
    llm: {
      ...config.llm,
      provider: { backend: 'claude-code' },
      models: { ...config.llm.models, default: 'sonnet' },
    },
  };
}

function withCodexLlm(config: KtxProjectConfig): KtxProjectConfig {
  return {
    ...config,
    llm: {
      ...config.llm,
      provider: { backend: 'codex' },
      models: { ...config.llm.models, default: 'gpt-5.5' },
    },
  };
}

function baseProjectConfig(): KtxProjectConfig {
  return withClaudeCodeLlm(buildDefaultKtxProjectConfig());
}

const stubClaudeCodeAuthProbe = async () => ({ ok: true as const });
const removedAutoCommitKey = ['auto', 'commit'].join('_');

describe('buildProjectStatus embeddings', () => {
  it('reports sentence-transformers with explicit base_url as ok', async () => {
    const project = projectWithConfig(
      withEmbeddings(baseProjectConfig(), {
        backend: 'sentence-transformers',
        model: 'all-MiniLM-L6-v2',
        dimensions: 384,
        sentenceTransformers: { base_url: 'http://my-st:8080', pathPrefix: '' },
      }),
    );

    const status = await buildProjectStatus(project, {
      claudeCodeAuthProbe: stubClaudeCodeAuthProbe,
    });

    expect(status.embeddings).toMatchObject({
      backend: 'sentence-transformers',
      status: 'ok',
      detail: 'service: http://my-st:8080',
    });
  });

  it('reports sentence-transformers with omitted base_url as managed daemon (ok)', async () => {
    const project = projectWithConfig(
      withEmbeddings(baseProjectConfig(), {
        backend: 'sentence-transformers',
        model: 'all-MiniLM-L6-v2',
        dimensions: 384,
      }),
    );

    const status = await buildProjectStatus(project, {
      claudeCodeAuthProbe: stubClaudeCodeAuthProbe,
    });

    expect(status.embeddings).toMatchObject({
      backend: 'sentence-transformers',
      status: 'ok',
      detail: 'managed local embeddings daemon',
    });
    expect(status.verdictReason).not.toMatch(/embedding credentials missing/);
  });

  it('reports sentence-transformers with empty base_url string as managed daemon (ok)', async () => {
    const project = projectWithConfig(
      withEmbeddings(baseProjectConfig(), {
        backend: 'sentence-transformers',
        model: 'all-MiniLM-L6-v2',
        dimensions: 384,
        sentenceTransformers: { base_url: '', pathPrefix: '' },
      }),
    );

    const status = await buildProjectStatus(project, {
      claudeCodeAuthProbe: stubClaudeCodeAuthProbe,
    });

    expect(status.embeddings).toMatchObject({
      backend: 'sentence-transformers',
      status: 'ok',
      detail: 'managed local embeddings daemon',
    });
  });

  it('reports openai backend with missing key as warn', async () => {
    const project = projectWithConfig(
      withEmbeddings(baseProjectConfig(), {
        backend: 'openai',
        model: 'text-embedding-3-small',
        dimensions: 1536,
        openai: { api_key: 'env:OPENAI_API_KEY' }, // pragma: allowlist secret
      }),
    );

    const status = await buildProjectStatus(project, {
      env: {},
      claudeCodeAuthProbe: stubClaudeCodeAuthProbe,
    });

    expect(status.embeddings.status).toBe('warn');
    expect(status.verdictReason).toMatch(/embedding credentials missing/);
  });
});

function withPostgresQueryHistory(config: KtxProjectConfig): KtxProjectConfig {
  return {
    ...config,
    connections: {
      ...config.connections,
      analytics: {
        driver: 'postgres',
        url: 'env:ANALYTICS_DATABASE_URL',
        context: { queryHistory: { enabled: true } },
      } as KtxProjectConfig['connections'][string],
    },
  };
}

function withSnowflakeQueryHistory(config: KtxProjectConfig): KtxProjectConfig {
  return {
    ...config,
    connections: {
      ...config.connections,
      warehouse: {
        driver: 'snowflake',
        account: 'EMOVRJS-CZ07756',
        warehouse: 'COMPUTE_WH',
        database: 'ANALYTICS',
        username: 'svc_ktx',
        password: 'env:SNOWFLAKE_PASSWORD', // pragma: allowlist secret
        context: { queryHistory: { enabled: true } },
      } as KtxProjectConfig['connections'][string],
    },
  };
}

function withBigQueryQueryHistory(config: KtxProjectConfig): KtxProjectConfig {
  return {
    ...config,
    connections: {
      ...config.connections,
      bq: {
        driver: 'bigquery',
        credentials_json: 'env:BQ_CREDENTIALS_JSON',
        context: { queryHistory: { enabled: true } },
      } as KtxProjectConfig['connections'][string],
    },
  };
}

function withMysqlQueryHistory(config: KtxProjectConfig): KtxProjectConfig {
  return {
    ...config,
    connections: {
      ...config.connections,
      legacy: {
        driver: 'mysql',
        host: 'db.example.com',
        database: 'analytics',
        username: 'svc',
        password: 'env:MYSQL_PASSWORD', // pragma: allowlist secret
        context: { queryHistory: { enabled: true } },
      } as KtxProjectConfig['connections'][string],
    },
  };
}

function fakeStatusRunner(
  dialect: 'postgres' | 'snowflake' | 'bigquery',
  catalogName: string,
) {
  return {
    dialect,
    catalogName,
    async run() {
      return { warnings: [], info: [] };
    },
    formatSuccessDetail(result: unknown) {
      const typed = result as { warnings: string[]; info?: string[]; pgServerVersion?: string };
      const info = typed.info && typed.info.length > 0 ? `; ${typed.info.join('; ')}` : '';
      const base =
        dialect === 'postgres'
          ? `pg_stat_statements ready (${typed.pgServerVersion ?? 'PostgreSQL 16.4'})`
          : `${catalogName} ready`;
      return { detail: `${base}${info}`, warnings: typed.warnings };
    },
    fixAdvice(error: unknown) {
      return {
        failHeadline: error instanceof Error ? error.message : String(error),
        remediation: 'Fix query-history grants.',
      };
    },
  };
}

describe('buildProjectStatus query history dispatch', () => {
  it('runs the shared probe for snowflake connections', async () => {
    let probeCalls = 0;
    const runner = fakeStatusRunner(
      'snowflake',
      'SNOWFLAKE.ACCOUNT_USAGE.QUERY_HISTORY',
    );
    const project = projectWithConfig(withSnowflakeQueryHistory(baseProjectConfig()));

    const status = await buildProjectStatus(project, {
      claudeCodeAuthProbe: stubClaudeCodeAuthProbe,
      queryHistoryReadinessProbe: async (input) => {
        probeCalls += 1;
        expect(input.connectionId).toBe('warehouse');
        return {
          ok: true,
          dialect: 'snowflake',
          runner,
          result: { warnings: [], info: [] },
        };
      },
    });

    expect(probeCalls).toBe(1);
    expect(status.queryHistory).toHaveLength(1);
    expect(status.queryHistory[0]).toMatchObject({
      connection: 'warehouse',
      driver: 'snowflake',
      dialect: 'snowflake',
      status: 'ok',
    });
    expect(status.queryHistory[0].detail).toMatch(/SNOWFLAKE\.ACCOUNT_USAGE\.QUERY_HISTORY/);
    expect(status.queryHistory[0].fix).toBeUndefined();
    expect(status.verdict).not.toBe('blocked');
  });

  it('reports snowflake probe failures with the reader-provided remediation', async () => {
    const project = projectWithConfig(withSnowflakeQueryHistory(baseProjectConfig()));

    const status = await buildProjectStatus(project, {
      claudeCodeAuthProbe: stubClaudeCodeAuthProbe,
      queryHistoryReadinessProbe: async () => ({
        ok: false,
        dialect: 'snowflake',
        runner: {
          ...fakeStatusRunner('snowflake', 'SNOWFLAKE.ACCOUNT_USAGE.QUERY_HISTORY'),
          fixAdvice: () => ({
            failHeadline: 'Snowflake role cannot read SNOWFLAKE.ACCOUNT_USAGE.QUERY_HISTORY',
            remediation: 'GRANT IMPORTED PRIVILEGES ON DATABASE SNOWFLAKE TO ROLE ktx;',
          }),
        },
        error: new Error('role cannot read SNOWFLAKE.ACCOUNT_USAGE.QUERY_HISTORY'),
      }),
    });

    expect(status.queryHistory[0]).toMatchObject({
      connection: 'warehouse',
      driver: 'snowflake',
      dialect: 'snowflake',
      status: 'fail',
      fix: 'GRANT IMPORTED PRIVILEGES ON DATABASE SNOWFLAKE TO ROLE ktx;',
    });
    expect(status.queryHistory[0].detail).not.toMatch(/Set connections.*driver to postgres/);
  });

  it('runs the bigquery probe for bigquery connections', async () => {
    let probeCalls = 0;
    const runner = fakeStatusRunner('bigquery', 'INFORMATION_SCHEMA.JOBS_BY_PROJECT');
    const project = projectWithConfig(withBigQueryQueryHistory(baseProjectConfig()));

    const status = await buildProjectStatus(project, {
      claudeCodeAuthProbe: stubClaudeCodeAuthProbe,
      queryHistoryReadinessProbe: async (input) => {
        probeCalls += 1;
        expect(input.connectionId).toBe('bq');
        return {
          ok: true,
          dialect: 'bigquery',
          runner,
          result: { warnings: [], info: [] },
        };
      },
    });

    expect(probeCalls).toBe(1);
    expect(status.queryHistory[0]).toMatchObject({
      connection: 'bq',
      driver: 'bigquery',
      dialect: 'bigquery',
      status: 'ok',
    });
    expect(status.queryHistory[0].detail).toMatch(/INFORMATION_SCHEMA\.JOBS_BY_PROJECT/);
  });

  it('fails with an accurate message for drivers without a query history reader', async () => {
    const project = projectWithConfig(withMysqlQueryHistory(baseProjectConfig()));

    const status = await buildProjectStatus(project, {
      claudeCodeAuthProbe: stubClaudeCodeAuthProbe,
      queryHistoryReadinessProbe: async () => {
        throw new Error('postgres probe must not run for mysql');
      },
    });

    expect(status.queryHistory).toHaveLength(1);
    expect(status.queryHistory[0]).toMatchObject({
      connection: 'legacy',
      driver: 'mysql',
      dialect: 'mysql',
      status: 'fail',
      detail: 'query history is not supported for driver "mysql"',
    });
    expect(status.queryHistory[0].fix).toMatch(
      /Disable connections\.legacy\.context\.queryHistory/,
    );
    expect(status.queryHistory[0].fix).not.toMatch(/driver to postgres/);
  });
});

describe('buildProjectStatus --fast', () => {
  it('skips claude-code probe and Postgres query-history probe', async () => {
    let claudeProbeCalls = 0;
    let queryHistoryProbeCalls = 0;
    const project = projectWithConfig(withPostgresQueryHistory(baseProjectConfig()));

    const status = await buildProjectStatus(project, {
      env: { ANALYTICS_DATABASE_URL: 'postgres://example' },
      fast: true,
      claudeCodeAuthProbe: async () => {
        claudeProbeCalls += 1;
        return { ok: true };
      },
      queryHistoryReadinessProbe: async () => {
        queryHistoryProbeCalls += 1;
        throw new Error('should not be called');
      },
    });

    expect(claudeProbeCalls).toBe(0);
    expect(queryHistoryProbeCalls).toBe(0);
    expect(status.llm.status).toBe('skipped');
    expect(status.llm.detail).toMatch(/--fast/);
    expect(status.queryHistory).toHaveLength(1);
    expect(status.queryHistory[0]).toMatchObject({
      connection: 'analytics',
      status: 'skipped',
    });
    expect(status.verdict).not.toBe('blocked');
  });

  it('does not call probes lazily when fast and reports skipped in render', async () => {
    const project = projectWithConfig(withPostgresQueryHistory(baseProjectConfig()));
    const status = await buildProjectStatus(project, {
      env: { ANALYTICS_DATABASE_URL: 'postgres://example' },
      fast: true,
      claudeCodeAuthProbe: stubClaudeCodeAuthProbe,
      queryHistoryReadinessProbe: async () => {
        throw new Error('should not be called');
      },
    });
    const rendered = renderProjectStatus(status, { verbose: false, useColor: false });
    expect(rendered).toContain('auth probe skipped (--fast)');
    expect(rendered).toContain('pg_stat_statements probe skipped (--fast)');
  });
});

describe('renderProjectStatus config cleanup', () => {
  it('does not render removed auto-commit status fields in verbose output', async () => {
    const project = projectWithConfig(baseProjectConfig());
    const status = await buildProjectStatus(project, {
      claudeCodeAuthProbe: stubClaudeCodeAuthProbe,
    });
    const rendered = renderProjectStatus(status, { verbose: true, useColor: false });

    expect(rendered).not.toContain(removedAutoCommitKey);
    expect(rendered).toContain('author=ktx <ktx@example.com>');
  });
});

describe('buildProjectStatus codex', () => {
  it('reports authenticated local Codex session', async () => {
    const project = projectWithConfig(withCodexLlm(buildDefaultKtxProjectConfig()));
    const status = await buildProjectStatus(project, {
      codexAuthProbe: async () => ({ ok: true as const }),
    });

    expect(status.llm).toMatchObject({
      backend: 'codex',
      model: 'gpt-5.5',
      status: 'ok',
      detail: 'local Codex session authenticated',
    });
    expect(status.warnings).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          message: expect.stringContaining('Codex backend isolation is limited'),
          fix: expect.stringContaining('claude-code'),
        }),
      ]),
    );
    const rendered = renderProjectStatus(status, { verbose: false, useColor: false });
    expect(rendered).toContain('Codex backend isolation is limited');
  });

  it('skips Codex auth probe with --fast', async () => {
    let probeCalls = 0;
    const project = projectWithConfig(withCodexLlm(buildDefaultKtxProjectConfig()));
    const status = await buildProjectStatus(project, {
      fast: true,
      codexAuthProbe: async () => {
        probeCalls += 1;
        return { ok: true };
      },
    });

    expect(probeCalls).toBe(0);
    expect(status.llm.status).toBe('skipped');
    expect(status.llm.detail).toMatch(/--fast/);
  });

  it('surfaces the probe fix for a model-access failure instead of an auth fix', async () => {
    const project = projectWithConfig(withCodexLlm(buildDefaultKtxProjectConfig()));
    const status = await buildProjectStatus(project, {
      codexAuthProbe: async () => ({
        ok: false,
        message: 'Codex is authenticated, but the configured model "gpt-5.5" is not available...',
        fix: 'Run `codex` to see the models your account supports, then set llm.models.default in ktx.yaml (or rerun `ktx setup`).',
      }),
    });

    expect(status.llm.status).toBe('fail');
    expect(status.llm.fix).toContain('llm.models.default');
    expect(status.llm.fix).not.toContain('Authenticate Codex');
  });
});

describe('buildProjectStatus llm models.default requirement', () => {
  function withBackendNoModel(
    backend: KtxProjectConfig['llm']['provider']['backend'],
  ): KtxProjectConfig {
    const config = buildDefaultKtxProjectConfig();
    return {
      ...config,
      llm: { ...config.llm, provider: { backend }, models: {} },
    };
  }

  it('fails codex without llm.models.default and never probes', async () => {
    let probeCalls = 0;
    const project = projectWithConfig(withBackendNoModel('codex'));
    const status = await buildProjectStatus(project, {
      codexAuthProbe: async () => {
        probeCalls += 1;
        return { ok: true };
      },
    });

    expect(probeCalls).toBe(0);
    expect(status.llm.status).toBe('fail');
    expect(status.llm.detail).toContain('llm.models.default');
    expect(status.verdict).toBe('blocked');
  });

  it('fails claude-code without llm.models.default and never probes', async () => {
    let probeCalls = 0;
    const project = projectWithConfig(withBackendNoModel('claude-code'));
    const status = await buildProjectStatus(project, {
      claudeCodeAuthProbe: async () => {
        probeCalls += 1;
        return { ok: true };
      },
    });

    expect(probeCalls).toBe(0);
    expect(status.llm.status).toBe('fail');
    expect(status.llm.detail).toContain('llm.models.default');
    expect(status.verdict).toBe('blocked');
  });

  it('fails anthropic without llm.models.default even when the key is set', async () => {
    const config = withBackendNoModel('anthropic');
    const project = projectWithConfig({
      ...config,
      llm: {
        ...config.llm,
        provider: { backend: 'anthropic', anthropic: { api_key: 'env:ANTHROPIC_API_KEY' } }, // pragma: allowlist secret
        models: {},
      },
    });
    const status = await buildProjectStatus(project, {
      env: { ANTHROPIC_API_KEY: 'sk-test' }, // pragma: allowlist secret
    });

    expect(status.llm.status).toBe('fail');
    expect(status.llm.detail).toContain('llm.models.default');
    expect(status.verdict).toBe('blocked');
  });
});

describe('buildLocalStatsStatus', () => {
  let tempDir: string;

  beforeEach(async () => {
    tempDir = await mkdtemp(join(tmpdir(), 'ktx-status-stats-'));
  });

  afterEach(async () => {
    await rm(tempDir, { recursive: true, force: true });
  });

  function projectIn(dir: string): KtxLocalProject {
    return {
      projectDir: dir,
      configPath: join(dir, 'ktx.yaml'),
      config: baseProjectConfig(),
      coreConfig: {} as KtxLocalProject['coreConfig'],
      git: {} as KtxLocalProject['git'],
      fileStore: {} as KtxLocalProject['fileStore'],
    };
  }

  it('returns unavailable when .ktx/db.sqlite is missing', async () => {
    const stats = await buildLocalStatsStatus(projectIn(tempDir));
    expect(stats.unavailable).toMatch(/no \.ktx\/db\.sqlite/);
    expect(stats.ingest.totalCompletedRuns).toBe(0);
    expect(stats.projectDir.dbSqliteBytes).toBeNull();
  });

  it('reads counts from a seeded SQLite DB and walks projectDir folders', async () => {
    await mkdir(join(tempDir, '.ktx'), { recursive: true });
    await mkdir(join(tempDir, '.ktx', 'cache'), { recursive: true });
    await writeFile(join(tempDir, '.ktx', 'cache', 'a.bin'), Buffer.alloc(2048));
    await mkdir(join(tempDir, 'raw-sources', 'analytics'), { recursive: true });
    await writeFile(join(tempDir, 'raw-sources', 'analytics', 'snap.json'), 'x'.repeat(100));
    await writeFile(join(tempDir, 'raw-sources', 'analytics', 'snap.bin'), Buffer.alloc(512));
    await mkdir(join(tempDir, 'wiki', 'global', 'sub'), { recursive: true });
    await writeFile(join(tempDir, 'wiki', 'global', 'one.md'), '# one');
    await writeFile(join(tempDir, 'wiki', 'global', 'sub', 'two.md'), '# two');
    await mkdir(join(tempDir, 'semantic-layer'), { recursive: true });
    await writeFile(join(tempDir, 'semantic-layer', 'orders.yaml'), 'name: orders');
    await writeFile(join(tempDir, 'semantic-layer', 'users.yml'), 'name: users');

    const dbPath = join(tempDir, '.ktx', 'db.sqlite');
    const db = new Database(dbPath);
    db.exec(`
      CREATE TABLE local_ingest_reports (
        run_id TEXT PRIMARY KEY,
        adapter TEXT NOT NULL,
        connection_id TEXT NOT NULL,
        status TEXT NOT NULL,
        completed_at TEXT NOT NULL,
        raw_content_hashes_json TEXT NOT NULL,
        body_json TEXT NOT NULL
      );
      INSERT INTO local_ingest_reports VALUES
        ('r1', 'live-database', 'analytics', 'done', '2026-04-01T10:00:00Z', '{}', '{}'),
        ('r2', 'live-database', 'analytics', 'done', '2026-05-10T10:00:00Z', '{}', '{}'),
        ('r3', 'notion', 'docs', 'done', '2026-05-01T10:00:00Z', '{}', '{}'),
        ('r4', 'notion', 'docs', 'error', '2026-05-02T10:00:00Z', '{}', '{}');

      CREATE TABLE knowledge_pages (
        path TEXT PRIMARY KEY,
        key TEXT NOT NULL,
        scope TEXT NOT NULL,
        scope_id TEXT,
        summary TEXT NOT NULL,
        content TEXT NOT NULL,
        tags TEXT NOT NULL,
        search_text TEXT NOT NULL DEFAULT '',
        embedding_json TEXT
      );
      INSERT INTO knowledge_pages VALUES
        ('a.md', 'a', 'GLOBAL', NULL, '', '', '[]', '', '[0.1,0.2]'),
        ('b.md', 'b', 'GLOBAL', NULL, '', '', '[]', '', NULL),
        ('c.md', 'c', 'PROJECT', NULL, '', '', '[]', '', '[0.3,0.4]');

      CREATE TABLE local_sl_sources (
        connection_id TEXT NOT NULL,
        source_name TEXT NOT NULL,
        search_text TEXT NOT NULL,
        embedding_json TEXT,
        content_hash TEXT,
        updated_at TEXT NOT NULL,
        PRIMARY KEY (connection_id, source_name)
      );
      INSERT INTO local_sl_sources VALUES
        ('analytics', 'orders', '', '[0.1,0.2]', NULL, '2026-05-10T10:00:00Z'),
        ('analytics', 'users', '', NULL, NULL, '2026-05-10T10:00:00Z');

      CREATE TABLE local_sl_dictionary_values (
        connection_id TEXT NOT NULL,
        source_name TEXT NOT NULL,
        column_name TEXT NOT NULL,
        value TEXT NOT NULL,
        value_lower TEXT NOT NULL,
        cardinality INTEGER,
        updated_at TEXT NOT NULL,
        PRIMARY KEY (connection_id, source_name, column_name, value)
      );
      INSERT INTO local_sl_dictionary_values VALUES
        ('analytics', 'orders', 'status', 'open', 'open', 1, '2026-05-10T10:00:00Z'),
        ('analytics', 'orders', 'status', 'closed', 'closed', 1, '2026-05-10T10:00:00Z');
    `);
    db.close();

    const stats = await buildLocalStatsStatus(projectIn(tempDir));
    expect(stats.unavailable).toBeUndefined();
    expect(stats.ingest.totalCompletedRuns).toBe(3);
    expect(stats.ingest.perConnection).toEqual([
      { connectionId: 'analytics', adapter: 'live-database', lastCompletedAt: '2026-05-10T10:00:00Z', skippedObjects: [] },
      { connectionId: 'docs', adapter: 'notion', lastCompletedAt: '2026-05-01T10:00:00Z', skippedObjects: [] },
    ]);
    expect(stats.wikiPages).toEqual([
      { scope: 'GLOBAL', count: 2, embeddedCount: 1 },
      { scope: 'PROJECT', count: 1, embeddedCount: 1 },
    ]);
    expect(stats.semanticLayer).toEqual([
      {
        connectionId: 'analytics',
        sourceCount: 2,
        embeddedSourceCount: 1,
        dictionaryValueCount: 2,
      },
    ]);
    expect(stats.projectDir.dbSqliteBytes).toBeGreaterThan(0);
    expect(stats.projectDir.ktxCacheBytes).toBe(2048);
    expect(stats.projectDir.rawSources).toEqual({ fileCount: 2, bytes: 612 });
  });

  it('tolerates a SQLite DB missing some tables', async () => {
    await mkdir(join(tempDir, '.ktx'), { recursive: true });
    const dbPath = join(tempDir, '.ktx', 'db.sqlite');
    const db = new Database(dbPath);
    db.exec(`
      CREATE TABLE local_ingest_reports (
        run_id TEXT PRIMARY KEY,
        adapter TEXT NOT NULL,
        connection_id TEXT NOT NULL,
        status TEXT NOT NULL,
        completed_at TEXT NOT NULL,
        raw_content_hashes_json TEXT NOT NULL,
        body_json TEXT NOT NULL
      );
      INSERT INTO local_ingest_reports VALUES
        ('r1', 'live-database', 'analytics', 'done', '2026-05-10T10:00:00Z', '{}', '{}');
    `);
    db.close();

    const stats = await buildLocalStatsStatus(projectIn(tempDir));
    expect(stats.unavailable).toBeUndefined();
    expect(stats.ingest.totalCompletedRuns).toBe(1);
    expect(stats.wikiPages).toEqual([]);
    expect(stats.semanticLayer).toEqual([]);
  });

  it('surfaces skipped objects from the latest report body', async () => {
    await mkdir(join(tempDir, '.ktx'), { recursive: true });
    const dbPath = join(tempDir, '.ktx', 'db.sqlite');
    const db = new Database(dbPath);
    const body = JSON.stringify({
      fetch: {
        status: 'partial',
        retryRecommended: false,
        warnings: [],
        skipped: [
          { rawPath: '', entityType: 'database_object', entityId: 'emp_hire_periods_with_name', severity: 'warning', statusCode: null, message: 'no such column: ehp.start_date', retryRecommended: false },
        ],
      },
    });
    db.exec(`
      CREATE TABLE local_ingest_reports (
        run_id TEXT PRIMARY KEY,
        adapter TEXT NOT NULL,
        connection_id TEXT NOT NULL,
        status TEXT NOT NULL,
        completed_at TEXT NOT NULL,
        raw_content_hashes_json TEXT NOT NULL,
        body_json TEXT NOT NULL
      );
    `);
    db.prepare(
      `INSERT INTO local_ingest_reports VALUES ('r1', 'live-database', 'oracle_sql', 'done', '2026-06-13T10:00:00Z', '{}', ?)`,
    ).run(body);
    db.close();

    const stats = await buildLocalStatsStatus(projectIn(tempDir));
    expect(stats.ingest.perConnection).toEqual([
      {
        connectionId: 'oracle_sql',
        adapter: 'live-database',
        lastCompletedAt: '2026-06-13T10:00:00Z',
        skippedObjects: [{ name: 'emp_hire_periods_with_name', reason: 'no such column: ehp.start_date' }],
      },
    ]);
  });
});

describe('renderProjectStatus Local data', () => {
  it('renders the Local data section with seeded stats', async () => {
    const project = projectWithConfig(baseProjectConfig());
    const status = await buildProjectStatus(project, { claudeCodeAuthProbe: stubClaudeCodeAuthProbe });
    status.localStats = {
      ingest: {
        totalCompletedRuns: 3,
        perConnection: [
          {
            connectionId: 'analytics',
            adapter: 'live-database',
            lastCompletedAt: new Date(Date.now() - 60 * 60 * 1000).toISOString(),
            skippedObjects: [],
          },
        ],
      },
      wikiPages: [
        { scope: 'GLOBAL', count: 2, embeddedCount: 2 },
        { scope: 'PROJECT', count: 1, embeddedCount: 0 },
      ],
      semanticLayer: [
        {
          connectionId: 'analytics',
          sourceCount: 12,
          embeddedSourceCount: 10,
          dictionaryValueCount: 200,
        },
      ],
      projectDir: {
        dbSqliteBytes: 4096,
        ktxCacheBytes: 1_048_576,
        rawSources: { fileCount: 5, bytes: 200 },
      },
    };
    const rendered = renderProjectStatus(status, { useColor: false });
    expect(rendered).toContain('Local data');
    expect(rendered).toContain('Wiki');
    expect(rendered).not.toContain('Knowledge');
    expect(rendered).toContain('3 completed runs');
    expect(rendered).not.toContain('skipped —');
    expect(rendered).toContain('GLOBAL=2 (2 embedded)');
    expect(rendered).toContain('PROJECT=1 (0 embedded)');
    expect(rendered).toContain('12 sources (10 embedded) · 200 dictionary values');
    expect(rendered).toContain('db=4.00 KiB');
    expect(rendered).toContain('cache=1.00 MiB');
    expect(rendered).not.toMatch(/wiki=\d+ md/);
    expect(rendered).not.toMatch(/semantic-layer=\d+ yaml/);
  });

  it('renders a per-connection skipped-objects line when the latest ingest skipped objects', async () => {
    const project = projectWithConfig(baseProjectConfig());
    const status = await buildProjectStatus(project, { claudeCodeAuthProbe: stubClaudeCodeAuthProbe });
    status.localStats = {
      ingest: {
        totalCompletedRuns: 1,
        perConnection: [
          {
            connectionId: 'oracle_sql',
            adapter: 'live-database',
            lastCompletedAt: new Date(Date.now() - 60 * 60 * 1000).toISOString(),
            skippedObjects: [{ name: 'emp_hire_periods_with_name', reason: 'no such column: ehp.start_date' }],
          },
        ],
      },
      wikiPages: [],
      semanticLayer: [],
      projectDir: { dbSqliteBytes: 4096, ktxCacheBytes: 0, rawSources: { fileCount: 0, bytes: 0 } },
    };
    const rendered = renderProjectStatus(status, { useColor: false });
    expect(rendered).toContain('1 object skipped — emp_hire_periods_with_name: no such column: ehp.start_date');
  });

  it('renders unavailable note when DB is missing', async () => {
    const project = projectWithConfig(baseProjectConfig());
    const status = await buildProjectStatus(project, { claudeCodeAuthProbe: stubClaudeCodeAuthProbe });
    status.localStats = {
      ingest: { totalCompletedRuns: 0, perConnection: [] },
      wikiPages: [],
      semanticLayer: [],
      projectDir: {
        dbSqliteBytes: null,
        ktxCacheBytes: 0,
        rawSources: { fileCount: 0, bytes: 0 },
      },
      unavailable: 'no .ktx/db.sqlite yet',
    };
    const rendered = renderProjectStatus(status, { useColor: false });
    expect(rendered).toContain('Local data');
    expect(rendered).toContain('no .ktx/db.sqlite yet');
  });
});

describe('buildProjectStatus connection-scoped wiki warnings', () => {
  let tempDir: string;

  beforeEach(async () => {
    tempDir = await mkdtemp(join(tmpdir(), 'ktx-status-connections-'));
  });

  afterEach(async () => {
    await rm(tempDir, { recursive: true, force: true });
  });

  async function projectWithConnections(ids: string[]): Promise<KtxLocalProject> {
    const projectDir = join(tempDir, 'project');
    await initKtxProject({ projectDir });
    const project = await loadKtxProject({ projectDir });
    project.config.llm = { ...project.config.llm, provider: { backend: 'claude-code' }, models: { default: 'sonnet' } };
    for (const id of ids) {
      project.config.connections[id] = { driver: 'sqlite', url: `file:${id}.db` };
    }
    await project.fileStore.writeFile(
      'ktx.yaml',
      serializeKtxProjectConfig(project.config),
      'ktx',
      'ktx@example.com',
      'configure connections',
    );
    return loadKtxProject({ projectDir });
  }

  it('warns when a wiki page references a connection id absent from ktx.yaml', async () => {
    const project = await projectWithConnections(['sales_db']);
    await writeLocalKnowledgePage(project, {
      key: 'orders-removed',
      scope: 'GLOBAL',
      summary: 'Orders for a removed db',
      content: 'Orders.',
      connections: ['removed_db'],
    });

    const status = await buildProjectStatus(project, { claudeCodeAuthProbe: stubClaudeCodeAuthProbeForFileBacked });
    expect(status.warnings).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          message: expect.stringContaining('reference connection id(s) not in ktx.yaml: removed_db'),
        }),
      ]),
    );
  });

  it('does not warn when all referenced connection ids are configured', async () => {
    const project = await projectWithConnections(['sales_db']);
    await writeLocalKnowledgePage(project, {
      key: 'orders-sales',
      scope: 'GLOBAL',
      summary: 'Sales orders',
      content: 'Orders.',
      connections: ['sales_db'],
    });

    const status = await buildProjectStatus(project, { claudeCodeAuthProbe: stubClaudeCodeAuthProbeForFileBacked });
    expect(status.warnings.some((warning) => warning.message.includes('not in ktx.yaml'))).toBe(false);
  });
});
