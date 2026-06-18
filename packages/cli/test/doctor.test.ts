import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { basename, join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import {
  formatDoctorReport,
  runKtxDoctor,
  runSetupDoctorChecks,
  type DoctorCheck,
} from '../src/doctor.js';

const removedAutoCommitKey = ['auto', 'commit'].join('_');

function makeIo() {
  let stdout = '';
  let stderr = '';
  return {
    io: {
      stdout: {
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

function fakeDoctorHistoricSqlRunner() {
  return {
    dialect: 'postgres' as const,
    catalogName: 'pg_stat_statements',
    async run() {
      return { warnings: [], info: [] };
    },
    formatSuccessDetail(result: unknown) {
      const typed = result as { pgServerVersion?: string; warnings: string[]; info?: string[] };
      const info = typed.info && typed.info.length > 0 ? `; ${typed.info.join('; ')}` : '';
      return {
        detail: `pg_stat_statements ready (${typed.pgServerVersion ?? 'PostgreSQL 16.4'})${info}`,
        warnings: typed.warnings,
      };
    },
    fixAdvice(error: unknown) {
      return {
        failHeadline: error instanceof Error ? error.message : String(error),
        remediation: 'Fix query-history grants.',
      };
    },
  };
}

describe('formatDoctorReport', () => {
  it('shows the failing check and its fix in plain output', () => {
    const checks: DoctorCheck[] = [
      { id: 'node', label: 'Node 22+', status: 'pass', detail: 'v22.16.0 ABI 127', group: 'toolchain' },
      {
        id: 'native-sqlite',
        label: 'Native SQLite',
        status: 'fail',
        detail: 'Cannot load better-sqlite3',
        fix: 'Run: pnpm run native:rebuild',
        group: 'toolchain',
      },
    ];

    const output = formatDoctorReport({ title: 'ktx status', checks });
    expect(output).toContain('ktx status');
    expect(output).toContain('✗ Environment');
    expect(output).toContain('1 of 2 need attention');
    expect(output).toContain('✗ Native SQLite: Cannot load better-sqlite3');
    expect(output).toContain('→ Run: pnpm run native:rebuild');
    expect(output).toContain('1 issue to fix.');
  });

  it('lists what was checked when a group has all passing checks', () => {
    const checks: DoctorCheck[] = [
      { id: 'node', label: 'Node 22+', status: 'pass', detail: 'v22.16.0', group: 'toolchain' },
      { id: 'pnpm', label: 'pnpm 10.20+', status: 'pass', detail: '10.28.0', group: 'toolchain' },
    ];

    const output = formatDoctorReport({ title: 'ktx status', checks });
    expect(output).toContain('✓ Environment');
    expect(output).toContain('Node 22+ · pnpm 10.20+');
    expect(output).not.toContain('v22.16.0');
    expect(output).toContain('Everything ready.');
    expect(output).toContain('ktx status --json');
    expect(output).toContain('ktx sl');
    expect(output).toContain('ktx wiki');
    expect(output).not.toContain('ktx scan');
    expect(output).not.toContain('ktx sl ask');
  });

  it('shows the underlying detail for a single-check group on the group line', () => {
    const checks: DoctorCheck[] = [
      {
        id: 'semantic-search-embeddings',
        label: 'Semantic search embeddings',
        status: 'pass',
        detail: 'openai/text-embedding-3-small (1536d) probe succeeded',
        group: 'search',
      },
    ];

    const output = formatDoctorReport({ title: 'ktx status', checks });
    expect(output).toContain('✓ Semantic search');
    expect(output).toContain('openai/text-embedding-3-small (1536d) probe succeeded');
  });

  it('lists every check in verbose mode', () => {
    const checks: DoctorCheck[] = [
      { id: 'node', label: 'Node 22+', status: 'pass', detail: 'v22.16.0', group: 'toolchain' },
    ];

    const output = formatDoctorReport({ title: 'ktx status', checks }, { verbose: true });
    expect(output).toContain('✓ Node 22+: v22.16.0');
  });
});

describe('runSetupDoctorChecks', () => {
  it('returns pass checks when injected commands and file checks succeed', async () => {
    const checks = await runSetupDoctorChecks({
      env: { PATH: '/bin' },
      workspaceRoot: '/workspace/ktx',
      execText: async (command, args) => {
        if (command === 'pnpm' && args[0] === '--version') return '10.28.0';
        if (command === 'corepack' && args[0] === '--version') return '0.32.0';
        if (command === 'uv' && args[0] === '--version') return 'uv 0.9.5';
        if (command === process.execPath && args.includes('--version')) return '@kaelio/ktx 0.0.0-private';
        throw new Error(`${command} ${args.join(' ')}`);
      },
      pathExists: async () => true,
      importBetterSqlite3: async () => ({ default: function Database() {} }),
    });

    expect(checks.map((check) => [check.id, check.status])).toEqual([
      ['node', 'pass'],
      ['pnpm', 'pass'],
      ['corepack', 'pass'],
      ['uv', 'pass'],
      ['native-sqlite', 'pass'],
      ['package-build', 'pass'],
      ['workspace-cli', 'pass'],
    ]);
  });

  it('returns exact fixes when setup checks fail', async () => {
    const checks = await runSetupDoctorChecks({
      env: {},
      workspaceRoot: '/workspace/ktx',
      execText: async (command) => {
        throw new Error(`${command} not found`);
      },
      pathExists: async () => false,
      importBetterSqlite3: async () => {
        throw new Error('Cannot find module better-sqlite3');
      },
    });

    expect(checks).toContainEqual({
      id: 'pnpm',
      label: 'pnpm 10.20+',
      status: 'fail',
      detail: 'pnpm not found',
      fix: 'Run: corepack enable && corepack prepare pnpm@10.28.0 --activate',
      group: 'toolchain',
    });
    expect(checks).toContainEqual({
      id: 'package-build',
      label: 'TypeScript package build',
      status: 'fail',
      detail: 'Missing packages/cli/dist/bin.js',
      fix: 'Run: pnpm run build',
      group: 'toolchain',
    });
  });

  it('treats missing corepack as a warning so setup doctor can still pass', async () => {
    const checks = await runSetupDoctorChecks({
      env: { PATH: '/bin' },
      workspaceRoot: '/workspace/ktx',
      execText: async (command, args) => {
        if (command === 'pnpm' && args[0] === '--version') return '10.28.0';
        if (command === 'corepack' && args[0] === '--version') throw new Error('spawn corepack ENOENT');
        if (command === 'uv' && args[0] === '--version') return 'uv 0.9.5';
        if (command === process.execPath && args.includes('--version')) return '@kaelio/ktx 0.0.0-private';
        throw new Error(`${command} ${args.join(' ')}`);
      },
      pathExists: async () => true,
      importBetterSqlite3: async () => ({ default: function Database() {} }),
    });
    const testIo = makeIo();

    await expect(
      runKtxDoctor(
        { command: 'setup', outputMode: 'plain', inputMode: 'disabled', verbose: true },
        testIo.io,
        { runSetupChecks: async () => checks },
      ),
    ).resolves.toBe(0);

    expect(checks).toContainEqual({
      id: 'corepack',
      label: 'Corepack',
      status: 'warn',
      detail: 'spawn corepack ENOENT',
      fix: 'Run: corepack enable',
      group: 'toolchain',
    });
    expect(testIo.stdout()).toContain('⚠ Corepack: spawn corepack ENOENT');
    expect(testIo.stderr()).toBe('');
  });
});

describe('runKtxDoctor', () => {
  let tempDir: string;

  beforeEach(async () => {
    tempDir = await mkdtemp(join(tmpdir(), 'ktx-doctor-'));
  });

  afterEach(async () => {
    await rm(tempDir, { recursive: true, force: true });
  });

  it('prints setup report and exits nonzero when a check fails', async () => {
    const testIo = makeIo();

    await expect(
      runKtxDoctor(
        { command: 'setup', outputMode: 'plain', inputMode: 'disabled' },
        testIo.io,
        {
          runSetupChecks: async () => [
            { id: 'node', label: 'Node 22+', status: 'pass', detail: 'v22.16.0 ABI 127' },
            {
              id: 'package-build',
              label: 'TypeScript package build',
              status: 'fail',
              detail: 'Missing packages/cli/dist/bin.js',
              fix: 'Run: pnpm run build',
            },
          ],
        },
      ),
    ).resolves.toBe(1);

    expect(testIo.stdout()).toContain('ktx status');
    expect(testIo.stdout()).toContain('No project here yet.');
    expect(testIo.stdout()).toContain('Before you can run');
    expect(testIo.stdout()).toContain('✗ TypeScript package build: Missing packages/cli/dist/bin.js');
    expect(testIo.stdout()).toContain('→ Run: pnpm run build');
    expect(testIo.stderr()).toBe('');
  });

  it('leads with `ktx setup` and hides toolchain warnings when no project exists', async () => {
    const testIo = makeIo();

    await expect(
      runKtxDoctor(
        { command: 'setup', outputMode: 'plain', inputMode: 'disabled' },
        testIo.io,
        {
          runSetupChecks: async () => [
            { id: 'node', label: 'Node 22+', status: 'pass', detail: 'v22.16.0', group: 'toolchain' },
            {
              id: 'corepack',
              label: 'Corepack',
              status: 'warn',
              detail: 'spawn corepack ENOENT',
              fix: 'Run: corepack enable',
              group: 'toolchain',
            },
          ],
        },
      ),
    ).resolves.toBe(0);

    const out = testIo.stdout();
    expect(out).toContain('No project here yet.');
    expect(out).toContain('Run');
    expect(out).toContain('ktx setup');
    expect(out).not.toContain('Corepack');
    expect(out).not.toContain('Node 22+');
  });

  it('prints JSON setup report', async () => {
    const testIo = makeIo();

    await expect(
      runKtxDoctor(
        { command: 'setup', outputMode: 'json', inputMode: 'disabled' },
        testIo.io,
        {
          runSetupChecks: async () => [
            { id: 'node', label: 'Node 22+', status: 'pass', detail: 'v22.16.0 ABI 127' },
          ],
        },
      ),
    ).resolves.toBe(0);

    expect(JSON.parse(testIo.stdout())).toEqual({
      title: 'ktx status',
      checks: [{ id: 'node', label: 'Node 22+', status: 'pass', detail: 'v22.16.0 ABI 127' }],
    });
  });

  it('prints a friendly message when ktx.yaml is missing at the project dir', async () => {
    const originalEnvProjectDir = process.env.KTX_PROJECT_DIR;
    process.env.KTX_PROJECT_DIR = tempDir;
    const testIo = makeIo();

    await expect(
      runKtxDoctor(
        { command: 'project', projectDir: tempDir, outputMode: 'plain', inputMode: 'disabled' },
        testIo.io,
        {},
      ),
    ).resolves.toBe(1);

    const out = testIo.stdout();
    expect(out).toContain('ktx status');
    expect(out).toContain('No ktx project here yet.');
    expect(out).toContain('ktx setup');
    expect(out).toContain('KTX_PROJECT_DIR');
    expect(out).not.toContain('ENOENT');
    expect(testIo.stderr()).toBe('');

    if (originalEnvProjectDir === undefined) {
      delete process.env.KTX_PROJECT_DIR;
    } else {
      process.env.KTX_PROJECT_DIR = originalEnvProjectDir;
    }
  });

  it('emits a structured JSON error when ktx.yaml is missing and JSON output is requested', async () => {
    const testIo = makeIo();

    await expect(
      runKtxDoctor(
        { command: 'project', projectDir: tempDir, outputMode: 'json', inputMode: 'disabled' },
        testIo.io,
        {},
      ),
    ).resolves.toBe(1);

    const parsed = JSON.parse(testIo.stdout()) as { error: string; projectDir: string };
    expect(parsed.error).toBe('missing_project');
    expect(parsed.projectDir).toBe(tempDir);
  });

  it('prints schema issues and exits 1 when ktx.yaml has an invalid value', async () => {
    await writeFile(
      join(tempDir, 'ktx.yaml'),
      ['storage:', '  state: mariadb', ''].join('\n'),
      'utf-8',
    );
    const testIo = makeIo();

    await expect(
      runKtxDoctor(
        { command: 'project', projectDir: tempDir, outputMode: 'plain', inputMode: 'disabled' },
        testIo.io,
        {},
      ),
    ).resolves.toBe(1);

    const out = testIo.stdout();
    expect(out).toContain('ktx status');
    expect(out).toContain('Config');
    expect(out).toContain('storage.state');
    expect(out).toContain('ktx.yaml');
  });

  it('emits structured JSON when ktx.yaml has an invalid value', async () => {
    await writeFile(
      join(tempDir, 'ktx.yaml'),
      ['storage:', '  state: mariadb', ''].join('\n'),
      'utf-8',
    );
    const testIo = makeIo();

    await expect(
      runKtxDoctor(
        { command: 'project', projectDir: tempDir, outputMode: 'json', inputMode: 'disabled' },
        testIo.io,
        {},
      ),
    ).resolves.toBe(1);

    const parsed = JSON.parse(testIo.stdout()) as {
      error: string;
      projectDir: string;
      issues: Array<{ path: string; message: string }>;
    };
    expect(parsed.error).toBe('invalid_config');
    expect(parsed.projectDir).toBe(tempDir);
    expect(parsed.issues.some((issue) => issue.path === 'storage.state')).toBe(true);
  });

  it('shows a Config row labelled "ktx.yaml schema valid" on the happy path', async () => {
    process.env.ANTHROPIC_API_KEY = 'test-key'; // pragma: allowlist secret
    await writeFile(
      join(tempDir, 'ktx.yaml'),
      [
        'connections:',
        '  warehouse:',
        '    driver: sqlite',
        '    path: ./warehouse.db',
        'llm:',
        '  provider:',
        '    backend: anthropic',
        '  models:',
        '    default: claude-sonnet-4-5',
        '',
      ].join('\n'),
      'utf-8',
    );
    const testIo = makeIo();

    await expect(
      runKtxDoctor(
        { command: 'project', projectDir: tempDir, outputMode: 'plain', inputMode: 'disabled' },
        testIo.io,
        {},
      ),
    ).resolves.toBe(0);

    expect(testIo.stdout()).toContain('ktx.yaml schema valid');
    delete process.env.ANTHROPIC_API_KEY;
  });

  it('runs project checks against a valid ktx.yaml', async () => {
    process.env.ANTHROPIC_API_KEY = 'test-key'; // pragma: allowlist secret
    await writeFile(
      join(tempDir, 'ktx.yaml'),
      [
        'connections:',
        '  warehouse:',
        '    driver: sqlite',
        '    path: ./warehouse.db',
        'llm:',
        '  provider:',
        '    backend: anthropic',
        '  models:',
        '    default: claude-sonnet-4-5',
        'ingest:',
        '  adapters:',
        '    - live-database',
        '  embeddings:',
        '    backend: openai',
        '    model: text-embedding-3-small',
        '    dimensions: 1536',
        '    openai:',
        '      api_key: env:OPENAI_API_KEY', // pragma: allowlist secret
        '',
      ].join('\n'),
      'utf-8',
    );
    process.env.OPENAI_API_KEY = 'test-key'; // pragma: allowlist secret
    const testIo = makeIo();

    await expect(
      runKtxDoctor(
        { command: 'project', projectDir: tempDir, outputMode: 'plain', inputMode: 'disabled' },
        testIo.io,
        {},
      ),
    ).resolves.toBe(0);

    const out = testIo.stdout();
    expect(out).toContain('ktx status');
    expect(out).toContain(`· ${basename(tempDir)}`);
    expect(out).toContain('Connections (1)');
    expect(out).toContain('LLM');
    expect(out).toContain('anthropic');
    expect(out).toContain('Embeddings');
    expect(out).toContain('Ready.');
    delete process.env.ANTHROPIC_API_KEY;
    delete process.env.OPENAI_API_KEY;
  });

  it('exits 0 and shows a Config warn row when ktx.yaml carries stale unknown fields', async () => {
    // The default `ktx status` path (command: 'project') must keep working on a
    // ktx.yaml written by a different ktx version: unknown fields surface as an
    // ignored-fields warning on the Config row, never as a failure.
    process.env.ANTHROPIC_API_KEY = 'test-key'; // pragma: allowlist secret
    await writeFile(
      join(tempDir, 'ktx.yaml'),
      [
        'connections:',
        '  warehouse:',
        '    driver: sqlite',
        '    path: ./warehouse.db',
        'llm:',
        '  provider:',
        '    backend: anthropic',
        '  models:',
        '    default: claude-sonnet-4-5',
        'storage:',
        '  git:',
        `    ${removedAutoCommitKey}: false`,
        'memory: {}',
        '',
      ].join('\n'),
      'utf-8',
    );
    const testIo = makeIo();

    await expect(
      runKtxDoctor(
        { command: 'project', projectDir: tempDir, outputMode: 'plain', inputMode: 'disabled' },
        testIo.io,
        {},
      ),
    ).resolves.toBe(0);

    const out = testIo.stdout();
    expect(out).toContain('Config');
    expect(out).toContain('ktx.yaml schema valid · 2 ignored fields');
    expect(out).toContain(`⚠ Unsupported storage.git.${removedAutoCommitKey}: unknown field (ignored)`);
    expect(out).toContain('⚠ Unsupported memory: unknown field (ignored)');
    delete process.env.ANTHROPIC_API_KEY;
  });

  it('reports Claude Code auth failures and ignored prompt-caching fields in project doctor output', async () => {
    await writeFile(
      join(tempDir, 'ktx.yaml'),
      [
        'llm:',
        '  provider:',
        '    backend: claude-code',
        '  models:',
        '    default: sonnet',
        '  promptCaching:',
        '    enabled: true',
        '    systemTtl: 1h',
        '    toolsTtl: 1h',
        '    historyTtl: 5m',
        '',
      ].join('\n'),
      'utf-8',
    );
    const testIo = makeIo();

    await expect(
      runKtxDoctor(
        { command: 'project', projectDir: tempDir, outputMode: 'plain', inputMode: 'disabled' },
        testIo.io,
        {
          claudeCodeAuthProbe: async () => ({
            ok: false as const,
            message: 'Authenticate Claude Code locally.',
          }),
        },
      ),
    ).resolves.toBe(1);

    expect(testIo.stdout()).toContain('claude-code');
    expect(testIo.stdout()).toContain('Authenticate Claude Code locally');
    expect(testIo.stdout()).toContain('claude-code ignores llm.promptCaching');
  });

  it('includes Postgres query-history readiness in project doctor output', async () => {
    process.env.ANTHROPIC_API_KEY = 'test-key'; // pragma: allowlist secret
    process.env.OPENAI_API_KEY = 'test-key'; // pragma: allowlist secret
    process.env.WAREHOUSE_DATABASE_URL = 'postgresql://reader@example.test/warehouse';
    await writeFile(
      join(tempDir, 'ktx.yaml'),
      [
        'connections:',
        '  warehouse:',
        '    driver: postgres',
        '    url: env:WAREHOUSE_DATABASE_URL',
        '    context:',
        '      queryHistory:',
        '        enabled: true',
        'llm:',
        '  provider:',
        '    backend: anthropic',
        '  models:',
        '    default: claude-sonnet-4-5',
        'ingest:',
        '  adapters:',
        '    - live-database',
        '    - historic-sql',
        '  embeddings:',
        '    backend: openai',
        '    model: text-embedding-3-small',
        '    dimensions: 1536',
        '    openai:',
        '      api_key: env:OPENAI_API_KEY', // pragma: allowlist secret
        '',
      ].join('\n'),
      'utf-8',
    );
    const testIo = makeIo();
    let probeCalls = 0;

    await expect(
      runKtxDoctor(
        { command: 'project', projectDir: tempDir, outputMode: 'plain', inputMode: 'disabled' },
        testIo.io,
        {
          queryHistoryReadinessProbe: async () => {
            probeCalls += 1;
            return {
              ok: true,
              dialect: 'postgres',
              runner: fakeDoctorHistoricSqlRunner(),
              result: {
                pgServerVersion: 'PostgreSQL 16.4',
                warnings: [],
                info: [
                  'pg_stat_statements.max is 1000; set it to at least 5000 to reduce query-template eviction churn',
                ],
              },
            };
          },
        },
      ),
    ).resolves.toBe(0);

    const out = testIo.stdout();
    expect(probeCalls).toBe(1);
    expect(out).toContain('Query history');
    expect(out).toContain('warehouse');
    expect(out).toContain('pg_stat_statements ready (PostgreSQL 16.4)');
    expect(out).toContain('pg_stat_statements.max is 1000');
    expect(out).not.toContain('Update the Postgres parameter group or config');
    expect(out).toContain('ktx status --json');
    expect(out).toContain('ktx sl');
    expect(out).toContain('ktx wiki');
    expect(out).not.toContain('ktx scan');
    expect(out).not.toContain('ktx sl ask');
    delete process.env.ANTHROPIC_API_KEY;
    delete process.env.OPENAI_API_KEY;
    delete process.env.WAREHOUSE_DATABASE_URL;
  });

  it('returns blocked verdict when LLM is not configured', async () => {
    await writeFile(
      join(tempDir, 'ktx.yaml'),
      [
        'connections:',
        '  warehouse:',
        '    driver: sqlite',
        '    path: ./warehouse.db',
        '',
      ].join('\n'),
      'utf-8',
    );
    const testIo = makeIo();

    await expect(
      runKtxDoctor(
        { command: 'project', projectDir: tempDir, outputMode: 'plain', inputMode: 'disabled' },
        testIo.io,
        {},
      ),
    ).resolves.toBe(1);

    expect(testIo.stdout()).toContain('no LLM configured');
    expect(testIo.stdout()).not.toContain('ktx ask');
    expect(testIo.stdout()).toContain('ktx setup');
  });

  it('does not warn about removed-field migration hints', async () => {
    process.env.ANTHROPIC_API_KEY = 'test-key'; // pragma: allowlist secret
    process.env.WAREHOUSE_DATABASE_URL = 'postgresql://reader@example.test/warehouse';
    process.env.NOTION_TOKEN = 'notion-secret';
    await writeFile(
      join(tempDir, 'ktx.yaml'),
      [
        'connections:',
        '  warehouse:',
        '    driver: postgres',
        '    url: env:WAREHOUSE_DATABASE_URL',
        '    readonly: true',
        '  local:',
        '    driver: sqlite',
        '    file_path: ./warehouse.db',
        '  docs:',
        '    driver: notion',
        '    auth_token_ref: env:NOTION_TOKEN',
        '    crawl_mode: all_accessible',
        '    last_successful_cursor: \'{"phase":"all_accessible_pages","cursor":"cursor-1"}\'',
        'ingest:',
        '  adapters:',
        '    - live-database',
        'llm:',
        '  provider:',
        '    backend: anthropic',
        '  models:',
        '    default: claude-sonnet-4-5',
        '',
      ].join('\n'),
      'utf-8',
    );
    const testIo = makeIo();

    await expect(
      runKtxDoctor(
        { command: 'project', projectDir: tempDir, outputMode: 'plain', inputMode: 'disabled' },
        testIo.io,
        {
          queryHistoryReadinessProbe: async () => ({
            ok: true,
            dialect: 'postgres',
            runner: fakeDoctorHistoricSqlRunner(),
            result: {
              pgServerVersion: 'PostgreSQL 16.4',
              warnings: [],
              info: [],
            },
          }),
        },
      ),
    ).resolves.toBe(0);

    const out = testIo.stdout();
    expect(out).not.toContain('connections.warehouse.readonly is no longer used.');
    expect(out).not.toContain('connections.local.file_path was removed.');
    expect(out).not.toContain('connections.docs.last_successful_cursor is local sync state.');
    delete process.env.ANTHROPIC_API_KEY;
    delete process.env.WAREHOUSE_DATABASE_URL;
    delete process.env.NOTION_TOKEN;
  });

  it('warns when semantic-search embeddings are not configured', async () => {
    process.env.ANTHROPIC_API_KEY = 'test-key'; // pragma: allowlist secret
    await writeFile(
      join(tempDir, 'ktx.yaml'),
      [
        'connections:',
        '  warehouse:',
        '    driver: sqlite',
        '    path: ./warehouse.db',
        'llm:',
        '  provider:',
        '    backend: anthropic',
        '  models:',
        '    default: claude-sonnet-4-5',
        'ingest:',
        '  adapters:',
        '    - live-database',
        '  embeddings:',
        '    backend: none',
        '    dimensions: 8',
        '',
      ].join('\n'),
      'utf-8',
    );
    const testIo = makeIo();

    await expect(
      runKtxDoctor(
        { command: 'project', projectDir: tempDir, outputMode: 'plain', inputMode: 'disabled' },
        testIo.io,
        {},
      ),
    ).resolves.toBe(0);

    expect(testIo.stdout()).toContain('Embeddings');
    expect(testIo.stdout()).toContain('none');
    expect(testIo.stdout()).toContain('semantic search will be skipped');
    delete process.env.ANTHROPIC_API_KEY;
  });

  describe('command: validate', () => {
    it('prints a success line and exits 0 when ktx.yaml is schema-valid', async () => {
      await writeFile(
        join(tempDir, 'ktx.yaml'),
        [
          'connections:',
          '  warehouse:',
          '    driver: sqlite',
          '    path: ./warehouse.db',
          'llm:',
          '  provider:',
          '    backend: anthropic',
          '',
        ].join('\n'),
        'utf-8',
      );
      const testIo = makeIo();

      await expect(
        runKtxDoctor(
          { command: 'validate', projectDir: tempDir, outputMode: 'plain', inputMode: 'disabled' },
          testIo.io,
          {},
        ),
      ).resolves.toBe(0);

      const out = testIo.stdout();
      expect(out).toContain('ktx status');
      expect(out).toContain('Config');
      expect(out).toContain('ktx.yaml schema valid');
      expect(out).not.toContain('LLM');
      expect(out).not.toContain('Connections');
      expect(out).not.toContain('Pipeline');
    });

    it('emits {ok: true} JSON when ktx.yaml is schema-valid', async () => {
      await writeFile(
        join(tempDir, 'ktx.yaml'),
        [
          'connections:',
          '  warehouse:',
          '    driver: sqlite',
          '    path: ./warehouse.db',
          'llm:',
          '  provider:',
          '    backend: anthropic',
          '',
        ].join('\n'),
        'utf-8',
      );
      const testIo = makeIo();

      await expect(
        runKtxDoctor(
          { command: 'validate', projectDir: tempDir, outputMode: 'json', inputMode: 'disabled' },
          testIo.io,
          {},
        ),
      ).resolves.toBe(0);

      expect(JSON.parse(testIo.stdout())).toEqual({ ok: true, projectDir: tempDir });
    });

    it('prints schema issues and exits 1 when ktx.yaml has an invalid value', async () => {
      await writeFile(
        join(tempDir, 'ktx.yaml'),
        ['storage:', '  state: mariadb', ''].join('\n'),
        'utf-8',
      );
      const testIo = makeIo();

      await expect(
        runKtxDoctor(
          { command: 'validate', projectDir: tempDir, outputMode: 'plain', inputMode: 'disabled' },
          testIo.io,
          {},
        ),
      ).resolves.toBe(1);

      const out = testIo.stdout();
      expect(out).toContain('storage.state');
    });

    it('emits structured JSON issues when validation fails', async () => {
      await writeFile(
        join(tempDir, 'ktx.yaml'),
        ['storage:', '  state: mariadb', ''].join('\n'),
        'utf-8',
      );
      const testIo = makeIo();

      await expect(
        runKtxDoctor(
          { command: 'validate', projectDir: tempDir, outputMode: 'json', inputMode: 'disabled' },
          testIo.io,
          {},
        ),
      ).resolves.toBe(1);

      const parsed = JSON.parse(testIo.stdout()) as { error: string; issues: Array<{ path: string }> };
      expect(parsed.error).toBe('invalid_config');
      expect(parsed.issues.some((issue) => issue.path === 'storage.state')).toBe(true);
    });

    it('tolerates unknown fields, reporting them as warnings and exiting 0', async () => {
      await writeFile(
        join(tempDir, 'ktx.yaml'),
        ['storrage:', '  state: sqlite', 'ingest:', '  llm:', '    backend: anthropic', ''].join('\n'),
        'utf-8',
      );
      const testIo = makeIo();

      await expect(
        runKtxDoctor(
          { command: 'validate', projectDir: tempDir, outputMode: 'plain', inputMode: 'disabled' },
          testIo.io,
          {},
        ),
      ).resolves.toBe(0);

      const out = testIo.stdout();
      expect(out).toContain('storrage');
      expect(out).toContain('ingest.llm');
      expect(out).toContain('ignored');
    });

    it('emits structured JSON warnings for unknown fields and exits 0', async () => {
      await writeFile(
        join(tempDir, 'ktx.yaml'),
        ['storrage: {}', ''].join('\n'),
        'utf-8',
      );
      const testIo = makeIo();

      await expect(
        runKtxDoctor(
          { command: 'validate', projectDir: tempDir, outputMode: 'json', inputMode: 'disabled' },
          testIo.io,
          {},
        ),
      ).resolves.toBe(0);

      const parsed = JSON.parse(testIo.stdout()) as { ok: boolean; warnings: Array<{ path: string; severity: string }> };
      expect(parsed.ok).toBe(true);
      expect(parsed.warnings.some((warning) => warning.path === 'storrage' && warning.severity === 'warning')).toBe(true);
    });

    it('renders unknown fields as ignored even when a real error blocks', async () => {
      // Mixed file: a bad value on a recognized field (blocks) plus a stale
      // unknown key (ignored). Only the error counts as a schema issue; the
      // warning keeps the ⚠ ignored-field treatment instead of a misleading ✗.
      await writeFile(
        join(tempDir, 'ktx.yaml'),
        ['storage:', '  state: mariadb', 'memory: {}', ''].join('\n'),
        'utf-8',
      );
      const testIo = makeIo();

      await expect(
        runKtxDoctor(
          { command: 'validate', projectDir: tempDir, outputMode: 'plain', inputMode: 'disabled' },
          testIo.io,
          {},
        ),
      ).resolves.toBe(1);

      const out = testIo.stdout();
      expect(out).toContain('ktx.yaml has 1 schema issue · 1 ignored field');
      expect(out).toContain('✗ storage.state');
      expect(out).toContain('⚠ Unsupported memory: unknown field (ignored)');
    });

    it('prints the missing-project message and exits 1 when ktx.yaml is absent', async () => {
      const testIo = makeIo();

      await expect(
        runKtxDoctor(
          { command: 'validate', projectDir: tempDir, outputMode: 'plain', inputMode: 'disabled' },
          testIo.io,
          {},
        ),
      ).resolves.toBe(1);

      expect(testIo.stdout()).toContain('No ktx project here yet.');
    });

    it('does not invoke the Postgres query-history probe in validate mode', async () => {
      await writeFile(
        join(tempDir, 'ktx.yaml'),
        [
          'connections:',
          '  warehouse:',
          '    driver: postgres',
          '    url: env:WAREHOUSE_DATABASE_URL',
          '    context:',
          '      queryHistory:',
          '        enabled: true',
          'llm:',
          '  provider:',
          '    backend: anthropic',
          '',
        ].join('\n'),
        'utf-8',
      );
      const testIo = makeIo();
      let probeCalls = 0;

      await expect(
        runKtxDoctor(
          { command: 'validate', projectDir: tempDir, outputMode: 'plain', inputMode: 'disabled' },
          testIo.io,
          {
            queryHistoryReadinessProbe: async () => {
              probeCalls += 1;
              return {
                ok: true,
                dialect: 'postgres',
                runner: fakeDoctorHistoricSqlRunner(),
                result: { pgServerVersion: 'PostgreSQL 16.4', warnings: [], info: [] },
              };
            },
          },
        ),
      ).resolves.toBe(0);

      expect(probeCalls).toBe(0);
      expect(testIo.stdout()).toContain('ktx.yaml schema valid');
    });
  });
});
