import { execFile } from 'node:child_process';
import { mkdir, mkdtemp, readFile, rm, stat, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { promisify } from 'node:util';
import { writeKtxSetupState } from '../src/context/project/setup-config.js';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { localFakeBundleReport, persistLocalBundleReport } from './ingest.test-utils.js';
import { beginCommandSpan, completeCommandSpan, resetCommandSpan } from '../src/telemetry/command-hook.js';
import { contextBuildCommands, writeKtxSetupContextState } from '../src/setup-context.js';
import { runDemoTour } from '../src/setup-demo-tour.js';
import {
  formatKtxSetupCompletionSummary,
  formatKtxSetupStatus,
  readKtxSetupStatus,
  runKtxSetup,
  setupTerminalOutcome,
} from '../src/setup.js';

vi.mock('../src/setup-demo-tour.js', () => ({
  runDemoTour: vi.fn(async () => 0),
}));

const execFileAsync = promisify(execFile);

function makeIo(stdoutIsTTY = false) {
  let stdout = '';
  let stderr = '';
  return {
    io: {
      stdout: {
        isTTY: stdoutIsTTY,
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

function runtimeReady(projectDir: string) {
  return { status: 'ready' as const, projectDir, requirements: { features: ['core' as const], requirements: [] } };
}

async function writeReadyRuntime(rootDir: string, cliVersion = '0.2.0') {
  const runtimeRoot = join(rootDir, '.runtime');
  const versionDir = join(runtimeRoot, cliVersion);
  const pythonPath = join(versionDir, '.venv', 'bin', 'python');
  const daemonPath = join(versionDir, '.venv', 'bin', 'ktx-daemon');
  await mkdir(join(versionDir, '.venv', 'bin'), { recursive: true });
  await writeFile(pythonPath, '', 'utf-8');
  await writeFile(daemonPath, '', 'utf-8');
  await writeFile(
    join(versionDir, 'manifest.json'),
    `${JSON.stringify(
      {
        schemaVersion: 1,
        cliVersion,
        installedAt: '2026-05-09T10:02:00.000Z',
        asset: {
          schemaVersion: 1,
          distributionName: 'kaelio-ktx',
          normalizedName: 'kaelio_ktx',
          version: '0.1.0',
          wheel: {
            file: 'kaelio_ktx-0.1.0-py3-none-any.whl',
            sha256: '0'.repeat(64),
            bytes: 0,
          },
        },
        features: ['core'],
        python: {
          executable: pythonPath,
          daemonExecutable: daemonPath,
        },
        installLog: join(versionDir, 'install.log'),
      },
      null,
      2,
    )}\n`,
    'utf-8',
  );
  return runtimeRoot;
}

describe('setup status', () => {
  let tempDir: string;

  beforeEach(async () => {
    tempDir = await mkdtemp(join(tmpdir(), 'ktx-setup-status-'));
  });

  afterEach(async () => {
    vi.unstubAllEnvs();
    await rm(tempDir, { recursive: true, force: true });
  });

  it('reports a missing project without creating files', async () => {
    const status = await readKtxSetupStatus(tempDir);

    expect(status).toMatchObject({
      project: { path: tempDir, ready: false },
      llm: { ready: false },
      embeddings: { ready: false },
      databases: [],
      sources: [],
      context: { ready: false, status: 'not_started' },
      agents: [],
    });
  });

  it('reports disabled default embeddings as not setup-ready', async () => {
    await mkdir(tempDir, { recursive: true });
    await writeFile(
      join(tempDir, 'ktx.yaml'),
      [
        'llm:',
        '  provider:',
        '    backend: anthropic',
        '    anthropic:',
        '      api_key: env:ANTHROPIC_API_KEY', // pragma: allowlist secret
        '  models:',
        '    default: claude-sonnet-4-6',
        'ingest:',
        '  embeddings:',
        '    backend: none',
        '    dimensions: 8',
        'connections: {}',
      ].join('\n'),
      'utf-8',
    );

    await expect(readKtxSetupStatus(tempDir)).resolves.toMatchObject({
      project: { path: tempDir, ready: true },
      llm: { backend: 'anthropic', ready: true, model: 'claude-sonnet-4-6' },
      embeddings: { backend: 'none', ready: false, dimensions: 8 },
    });
  });

  it.each([
    {
      backend: 'vertex',
      providerLines: ['    backend: vertex', '    vertex:', '      project: kaelio-dev', '      location: us-east5'],
      model: 'claude-sonnet-4-6',
    },
    {
      backend: 'gateway',
      providerLines: ['    backend: gateway', '    gateway:', '      api_key: env:AI_GATEWAY_API_KEY'],
      model: 'anthropic/claude-sonnet-4-6',
    },
  ])('reports configured $backend llm backends as setup-ready', async (fixture) => {
    await mkdir(tempDir, { recursive: true });
    await writeFile(
      join(tempDir, 'ktx.yaml'),
      [
        'llm:',
        '  provider:',
        ...fixture.providerLines,
        '  models:',
        `    default: ${fixture.model}`,
        'connections: {}',
      ].join('\n'),
      'utf-8',
    );

    await expect(readKtxSetupStatus(tempDir)).resolves.toMatchObject({
      llm: { backend: fixture.backend, ready: true, model: fixture.model },
    });
  });

  it('uses setup database connection ids when present', async () => {
    await writeFile(
      join(tempDir, 'ktx.yaml'),
      [
        'setup:',
        '  database_connection_ids:',
        '    - warehouse',
        '    - analytics',
        'connections:',
        '  warehouse:',
        '    driver: postgres',
        '    url: env:WAREHOUSE_URL',
        'ingest:',
        '  embeddings:',
        '    backend: openai',
        '    model: text-embedding-3-small',
        '    dimensions: 1536',
        '    openai:',
        '      api_key: env:OPENAI_API_KEY', // pragma: allowlist secret
      ].join('\n'),
      'utf-8',
    );
    await writeKtxSetupState(tempDir, { completed_steps: ['project', 'databases'] });

    await expect(readKtxSetupStatus(tempDir)).resolves.toMatchObject({
      databases: [
        { connectionId: 'warehouse', ready: true },
        { connectionId: 'analytics', ready: false },
      ],
    });
  });

  it('reports selected databases as ready only after the database setup step is complete', async () => {
    await writeFile(
      join(tempDir, 'ktx.yaml'),
      [
        'setup:',
        '  database_connection_ids:',
        '    - warehouse',
        'connections:',
        '  warehouse:',
        '    driver: postgres',
        '    url: env:DATABASE_URL',
        '',
      ].join('\n'),
      'utf-8',
    );
    await writeKtxSetupState(tempDir, { completed_steps: ['project'] });

    await expect(readKtxSetupStatus(tempDir)).resolves.toMatchObject({
      databases: [{ connectionId: 'warehouse', ready: false }],
    });

    await writeFile(
      join(tempDir, 'ktx.yaml'),
      [
        'setup:',
        '  database_connection_ids:',
        '    - warehouse',
        'connections:',
        '  warehouse:',
        '    driver: postgres',
        '    url: env:DATABASE_URL',
        '',
      ].join('\n'),
      'utf-8',
    );
    await writeKtxSetupState(tempDir, { completed_steps: ['project', 'databases'] });

    await expect(readKtxSetupStatus(tempDir)).resolves.toMatchObject({
      databases: [{ connectionId: 'warehouse', ready: true }],
    });
  });

  it('reports source status from configured source connections', async () => {
    await writeFile(
      join(tempDir, 'ktx.yaml'),
      [
        'setup:',
        '  database_connection_ids: []',
        'connections:',
        '  docs:',
        '    driver: notion',
        '    auth_token_ref: env:NOTION_TOKEN',
        '    crawl_mode: all_accessible',
        '  warehouse:',
        '    driver: postgres',
        '    url: env:DATABASE_URL',
        '',
      ].join('\n'),
      'utf-8',
    );
    await writeKtxSetupState(tempDir, { completed_steps: ['project', 'sources'] });

    await expect(readKtxSetupStatus(tempDir)).resolves.toMatchObject({
      sources: [{ connectionId: 'docs', type: 'notion', ready: true }],
    });
  });

  it('reports agent status from the install manifest', async () => {
    await mkdir(join(tempDir, '.ktx', 'agents'), { recursive: true });
    await writeFile(join(tempDir, 'ktx.yaml'), 'connections: {}\n', 'utf-8');
    await writeFile(
      join(tempDir, '.ktx/agents/install-manifest.json'),
      JSON.stringify(
        {
          version: 1,
          projectDir: tempDir,
          installedAt: '2026-05-07T00:00:00.000Z',
          installs: [
            { target: 'codex', scope: 'project', mode: 'mcp' },
            { target: 'codex', scope: 'project', mode: 'mcp-cli' },
          ],
          entries: [],
        },
        null,
        2,
      ),
      'utf-8',
    );

    await expect(readKtxSetupStatus(tempDir)).resolves.toMatchObject({
      agents: [{ target: 'codex', scope: 'project', ready: true }],
    });
  });

  it('reports setup-managed context build status and commands', async () => {
    await writeFile(
      join(tempDir, 'ktx.yaml'),
      [
        'setup:',
        '  database_connection_ids:',
        '    - warehouse',
        'connections:',
        '  warehouse:',
        '    driver: postgres',
        '    url: env:DATABASE_URL',
        'llm:',
        '  provider:',
        '    backend: anthropic',
        '  models:',
        '    default: claude-sonnet-4-6',
        'ingest:',
        '  embeddings:',
        '    backend: openai',
        '    model: text-embedding-3-small',
        '    dimensions: 1536',
        '',
      ].join('\n'),
      'utf-8',
    );
    await writeKtxSetupState(tempDir, {
      completed_steps: ['project', 'llm', 'embeddings', 'databases', 'sources'],
    });
    await writeKtxSetupContextState(tempDir, {
      runId: 'setup-context-local-abc123',
      status: 'stale',
      startedAt: '2026-05-09T10:00:00.000Z',
      updatedAt: '2026-05-09T10:01:00.000Z',
      primarySourceConnectionIds: ['warehouse'],
      contextSourceConnectionIds: [],
      reportIds: [],
      artifactPaths: [],
      retryableFailedTargets: [],
      commands: contextBuildCommands(tempDir),
      failureReason: 'Previous foreground context build did not finish. Rerun setup or ktx ingest.',
    });

    await expect(readKtxSetupStatus(tempDir)).resolves.toMatchObject({
      context: {
        ready: false,
        status: 'stale',
        runId: 'setup-context-local-abc123',
        statusCommand: `ktx status --project-dir ${tempDir}`,
        detail: 'Previous foreground context build did not finish. Rerun setup or ktx ingest.',
      },
    });
  });

  it('reports Vertex LLM and context ready after a successful Metabase ingest report', async () => {
    await writeFile(
      join(tempDir, 'ktx.yaml'),
      [
        'setup:',
        '  database_connection_ids:',
        '    - warehouse',
        'connections:',
        '  warehouse:',
        '    driver: postgres',
        '    url: env:DATABASE_URL',
        '  metabase:',
        '    driver: metabase',
        '    api_url: https://metabase.example.test',
        '    api_key_ref: env:METABASE_API_KEY',
        '    warehouse_connection_id: warehouse',
        'llm:',
        '  provider:',
        '    backend: vertex',
        '    vertex:',
        '      project: kaelio-dev',
        '      location: us-east5',
        '  models:',
        '    default: claude-sonnet-4-6',
        'ingest:',
        '  embeddings:',
        '    backend: none',
        '    dimensions: 8',
        '',
      ].join('\n'),
      'utf-8',
    );
    await writeKtxSetupState(tempDir, { completed_steps: ['project', 'databases', 'sources'] });
    await persistLocalBundleReport(
      tempDir,
      localFakeBundleReport('metabase-job-1', {
        connectionId: 'warehouse',
        sourceKey: 'metabase',
      }),
    );

    const status = await readKtxSetupStatus(tempDir);
    const rendered = formatKtxSetupStatus(status);

    expect(status.llm).toMatchObject({ backend: 'vertex', ready: true, model: 'claude-sonnet-4-6' });
    expect(status.context).toMatchObject({ ready: true, status: 'completed' });
    expect(rendered).toContain('LLM ready: yes (claude-sonnet-4-6)');
    expect(rendered).toContain('ktx context built: yes');
  });

  it('reports context ready after a partial ingest report saved memory', async () => {
    await writeFile(
      join(tempDir, 'ktx.yaml'),
      [
        'setup:',
        '  database_connection_ids:',
        '    - warehouse',
        'connections:',
        '  warehouse:',
        '    driver: postgres',
        '    url: env:DATABASE_URL',
        'ingest:',
        '  embeddings:',
        '    backend: none',
        '    dimensions: 8',
        '',
      ].join('\n'),
      'utf-8',
    );
    await writeKtxSetupState(tempDir, { completed_steps: ['project', 'databases'] });
    await persistLocalBundleReport(
      tempDir,
      localFakeBundleReport('warehouse-job-partial', {
        connectionId: 'warehouse',
        sourceKey: 'fake',
        body: {
          failedWorkUnits: ['orders-bad'],
          workUnits: [
            {
              unitKey: 'orders-ok',
              rawFiles: ['orders/orders.json'],
              status: 'success',
              actions: [{ target: 'wiki', type: 'created', key: 'wiki/orders.md', detail: 'orders' }],
              touchedSlSources: [],
            },
            {
              unitKey: 'orders-bad',
              rawFiles: ['orders/bad.json'],
              status: 'failed',
              reason: 'writer tool failed',
              actions: [],
              touchedSlSources: [],
            },
          ],
        },
      }),
    );

    const status = await readKtxSetupStatus(tempDir);

    expect(status.context).toMatchObject({ ready: true, status: 'completed' });
  });

  it('formats plain and JSON setup status payloads', async () => {
    const status = await readKtxSetupStatus(tempDir);
    const rendered = formatKtxSetupStatus(status);

    expect(rendered).toContain(`No ktx project found at ${tempDir}.`);
    expect(rendered).toContain('Check another project: ktx --project-dir <folder> status');
    expect(rendered).toContain('Or from that folder: ktx status');
    expect(rendered).toContain('Create a new ktx project here: ktx setup');
    expect(rendered).not.toContain('Project ready: no');
    expect(JSON.parse(JSON.stringify(status))).toMatchObject({ project: { path: tempDir, ready: false } });
  });

  it('prints the readiness checklist for an existing project', async () => {
    await writeFile(join(tempDir, 'ktx.yaml'), 'connections: {}\n', 'utf-8');

    const rendered = formatKtxSetupStatus(await readKtxSetupStatus(tempDir));

    expect(rendered).toContain(`ktx project: ${tempDir}`);
    expect(rendered).toContain('Project ready: yes');
    expect(rendered).toContain('LLM ready: no');
    expect(rendered).toContain('Databases configured: no');
    expect(rendered).not.toContain(['Primary sources', 'configured'].join(' '));
    expect(rendered).toContain('ktx context built: no');
    expect(rendered).not.toContain('No ktx project found.');
  });

  it('formats a concise ready summary for completed agent setup', () => {
    const rendered = formatKtxSetupCompletionSummary(
      {
        project: { path: tempDir, ready: true },
        llm: { ready: true, model: 'sonnet' },
        embeddings: { ready: true, model: 'text-embedding-3-small' },
        databases: [{ connectionId: 'postgres-warehouse', ready: true }],
        sources: [{ connectionId: 'dbt-main', type: 'dbt', ready: true }],
        runtime: { required: true, ready: true, features: ['core'] },
        context: { ready: true, status: 'completed' },
        agents: [
          { target: 'claude-code', scope: 'project', ready: true },
          { target: 'claude-desktop', scope: 'global', ready: true },
        ],
      },
      {
        agentNextActions: [
          '1. Start MCP',
          '  Run this command before using Claude Code:',
          '',
          '  RUN:',
          `  ktx mcp start --project-dir ${tempDir}`,
          '',
          '  If you need to stop MCP later:',
          `  ktx mcp stop --project-dir ${tempDir}`,
          '',
          '2. Open Claude Code',
          '  Open Claude Code from the ktx project directory:',
          '',
          '  RUN:',
          `  cd '${tempDir}'`,
          '  claude',
        ].join('\n'),
      },
    );

    expect(rendered).toContain(`Project\n  ${tempDir}`);
    expect(rendered).toContain('Context\n  built');
    expect(rendered).toContain('Agents configured\n  Claude Code, Claude Desktop');
    expect(rendered).toContain('REQUIRED BEFORE USING AGENTS\n\n  1. Start MCP');
    expect(rendered).toContain('    Run this command before using Claude Code:');
    expect(rendered).toContain('    RUN:');
    expect(rendered).toContain('    If you need to stop MCP later:');
    expect(rendered).toContain(`ktx mcp stop --project-dir ${tempDir}`);
    expect(rendered).toContain('After that, try\n  Ask your agent: "Use ktx to show me the available tables."');
    expect(rendered).not.toContain('Verify');
    expect(rendered).not.toContain('Project ready: yes');
    expect(rendered).not.toContain('What you can do next');
  });

  it('prints agent next actions inside the final ready summary during full setup', async () => {
    const testIo = makeIo();

    await expect(
      runKtxSetup(
        {
          command: 'run',
          projectDir: tempDir,
          mode: 'auto',
          agents: false,
          target: 'claude-code',
          skipAgents: false,
          inputMode: 'disabled',
          yes: true,
          cliVersion: '0.2.0',
          skipLlm: true,
          skipEmbeddings: true,
          skipDatabases: true,
          skipSources: true,
          databaseSchemas: [],
        },
        testIo.io,
        {
          runtime: async () => runtimeReady(tempDir),
          context: async () => {
            await writeKtxSetupContextState(tempDir, {
              runId: 'setup-context-local-test',
              status: 'completed',
              primarySourceConnectionIds: [],
              contextSourceConnectionIds: [],
              reportIds: [],
              artifactPaths: [],
              retryableFailedTargets: [],
              commands: contextBuildCommands(tempDir),
            });
            await writeKtxSetupState(tempDir, { completed_steps: ['project', 'context'] });
            return { status: 'ready', projectDir: tempDir, runId: 'setup-context-local-test' };
          },
        },
      ),
    ).resolves.toBe(0);

    const output = testIo.stdout();
    expect(output).toContain('Claude Code · Project scope');
    expect(output).toContain(join(tempDir, '.mcp.json'));
    expect(output).toContain('Requires MCP to be started.');
    expect(output).toContain('Analytics skill installed.');
    expect(output).not.toContain('Agent integration complete');
    expect(output).toContain('Finish ktx agent setup');
    expect(output).not.toContain('ktx project ready');
    expect(output).toContain('REQUIRED BEFORE USING AGENTS');
    expect(output).toContain('Run this command before using Claude Code:');
    expect(output).toContain(`ktx mcp start --project-dir ${tempDir}`);
    expect(output).not.toContain('Finish agent setup');
  });

  it('emits debug telemetry for setup steps without project paths', async () => {
    vi.stubEnv('KTX_TELEMETRY_DEBUG', '1');
    vi.stubEnv('CI', '');
    const testIo = makeIo();
    testIo.io.stdout.isTTY = true;

    await expect(
      runKtxSetup(
        {
          command: 'run',
          projectDir: tempDir,
          mode: 'auto',
          agents: false,
          skipAgents: true,
          inputMode: 'disabled',
          yes: true,
          cliVersion: '0.2.0',
          skipLlm: true,
          skipEmbeddings: true,
          skipDatabases: true,
          skipSources: true,
          databaseSchemas: [],
        },
        testIo.io,
        {
          runtime: async () => runtimeReady(tempDir),
          context: async () => ({ status: 'ready', projectDir: tempDir, runId: 'setup-context-local-test' }),
        },
      ),
    ).resolves.toBe(0);

    expect(testIo.stderr()).toContain('"event":"setup_step"');
    expect(testIo.stderr()).toContain('"step":"project"');
    expect(testIo.stderr()).toContain('"step":"models"');
    expect(testIo.stderr()).not.toContain(tempDir);
  });

  it('prints the setup shell intro for auto-created run mode', async () => {
    const testIo = makeIo();

    await expect(
      runKtxSetup(
        {
          command: 'run',
          projectDir: tempDir,
          mode: 'auto',
          agents: false,
          skipAgents: true,
          inputMode: 'disabled',
          yes: true,
          cliVersion: '0.2.0',
          skipLlm: true,
          skipEmbeddings: true,
          databaseSchemas: [],
          skipDatabases: true,
          skipSources: true,
        },
        testIo.io,
      ),
    ).resolves.toBe(0);

    expect(testIo.stdout()).toContain('ktx setup');
    expect(testIo.stdout()).toContain(`Project: ${tempDir}`);
    expect(testIo.stdout()).toContain('Project ready: yes');
    expect(testIo.stdout()).toContain('What you can do next:');
    expect(testIo.stdout()).toContain('Connect data, then build context.');
    expect(testIo.stdout()).toContain('ktx setup');
    expect(testIo.stdout()).not.toContain('ktx agent context --json');
    expect(testIo.stdout()).not.toContain('Optional MCP:');
    expect(testIo.stdout()).toContain('Community:');
    expect(testIo.stdout()).toContain('Questions or feedback? Join the ktx Slack: https://ktx.sh/slack');
    expect(testIo.stderr()).toBe('');
  });

  it('fails clearly when a non-interactive run has an agent target but no LLM backend', async () => {
    const testIo = makeIo();

    // --target selects agent integration, not the LLM provider. A non-interactive
    // run with no --llm-backend must say so plainly instead of assuming Anthropic.
    await expect(
      runKtxSetup(
        {
          command: 'run',
          projectDir: tempDir,
          mode: 'auto',
          agents: false,
          target: 'claude-code',
          skipAgents: true,
          inputMode: 'disabled',
          yes: true,
          cliVersion: '0.2.0',
          skipLlm: false,
          skipEmbeddings: true,
          skipDatabases: true,
          skipSources: true,
          databaseSchemas: [],
        },
        testIo.io,
      ),
    ).resolves.toBe(1);

    const stderr = testIo.stderr();
    expect(stderr).toContain('Missing LLM backend: pass --llm-backend');
    expect(stderr).not.toContain('Missing Anthropic API key');
  });

  it('preserves a newly created missing project directory when a later setup step fails', async () => {
    const projectDir = join(tempDir, 'missing-project');
    const testIo = makeIo();

    await expect(
      runKtxSetup(
        {
          command: 'run',
          projectDir,
          mode: 'auto',
          agents: false,
          skipAgents: true,
          inputMode: 'disabled',
          yes: true,
          cliVersion: '0.2.0',
          skipLlm: true,
          skipEmbeddings: true,
          databaseSchemas: [],
          skipDatabases: true,
          skipSources: true,
        },
        testIo.io,
        {
          model: async () => ({ status: 'skipped', projectDir }),
          embeddings: async () => ({ status: 'skipped', projectDir }),
          databases: async () => ({ status: 'skipped', projectDir }),
          sources: async () => ({ status: 'skipped', projectDir }),
          runtime: async () => ({ status: 'failed', projectDir, requirements: { features: ['core'], requirements: [] } }),
        },
      ),
    ).resolves.toBe(1);

    await expect(stat(projectDir)).resolves.toBeDefined();
    await expect(stat(join(projectDir, 'ktx.yaml'))).resolves.toBeDefined();
    await expect(stat(join(projectDir, '.ktx'))).resolves.toBeDefined();
  });

  it('preserves ktx scaffold files in an initially empty project directory when setup fails', async () => {
    const testIo = makeIo();

    await expect(
      runKtxSetup(
        {
          command: 'run',
          projectDir: tempDir,
          mode: 'auto',
          agents: false,
          skipAgents: true,
          inputMode: 'disabled',
          yes: true,
          cliVersion: '0.2.0',
          skipLlm: true,
          skipEmbeddings: true,
          databaseSchemas: [],
          skipDatabases: true,
          skipSources: true,
        },
        testIo.io,
        {
          model: async () => ({ status: 'skipped', projectDir: tempDir }),
          embeddings: async () => ({ status: 'skipped', projectDir: tempDir }),
          databases: async () => ({ status: 'skipped', projectDir: tempDir }),
          sources: async () => ({ status: 'skipped', projectDir: tempDir }),
          runtime: async () => ({ status: 'failed', projectDir: tempDir, requirements: { features: ['core'], requirements: [] } }),
        },
      ),
    ).resolves.toBe(1);

    await expect(stat(join(tempDir, 'ktx.yaml'))).resolves.toBeDefined();
    await expect(stat(join(tempDir, '.ktx'))).resolves.toBeDefined();
  });

  it('preserves partial context-build artifacts and resume state when the context step fails', async () => {
    const projectDir = join(tempDir, 'partial-context');
    const testIo = makeIo();

    await expect(
      runKtxSetup(
        {
          command: 'run',
          projectDir,
          mode: 'auto',
          agents: false,
          skipAgents: true,
          inputMode: 'disabled',
          yes: true,
          cliVersion: '0.2.0',
          skipLlm: true,
          skipEmbeddings: true,
          databaseSchemas: [],
          skipDatabases: true,
          skipSources: true,
        },
        testIo.io,
        {
          model: async () => ({ status: 'skipped', projectDir }),
          embeddings: async () => ({ status: 'skipped', projectDir }),
          databases: async () => ({ status: 'skipped', projectDir }),
          sources: async () => ({ status: 'skipped', projectDir }),
          runtime: async () => runtimeReady(projectDir),
          context: async () => {
            await mkdir(join(projectDir, '.ktx', 'setup'), { recursive: true });
            await writeFile(
              join(projectDir, '.ktx', 'setup', 'state.json'),
              JSON.stringify({ status: 'failed', retryableFailedTargets: [{ source: 'metabase' }] }),
              'utf-8',
            );
            await mkdir(join(projectDir, 'wiki'), { recursive: true });
            await writeFile(join(projectDir, 'wiki', 'postgres-warehouse.md'), '# warehouse\n', 'utf-8');
            await mkdir(join(projectDir, 'semantic-layer'), { recursive: true });
            await writeFile(join(projectDir, 'semantic-layer', 'orders.yaml'), 'name: orders\n', 'utf-8');
            return { status: 'failed', projectDir };
          },
        },
      ),
    ).resolves.toBe(1);

    await expect(stat(join(projectDir, 'ktx.yaml'))).resolves.toBeDefined();
    await expect(readFile(join(projectDir, '.ktx', 'setup', 'state.json'), 'utf-8')).resolves.toContain('"status":"failed"');
    await expect(readFile(join(projectDir, 'wiki', 'postgres-warehouse.md'), 'utf-8')).resolves.toContain('warehouse');
    await expect(readFile(join(projectDir, 'semantic-layer', 'orders.yaml'), 'utf-8')).resolves.toContain('orders');
  });

  it('preserves a pre-existing non-empty project directory when runtime setup fails', async () => {
    await writeFile(join(tempDir, 'notes.txt'), 'keep me\n', 'utf-8');
    const testIo = makeIo();

    await expect(
      runKtxSetup(
        {
          command: 'run',
          projectDir: tempDir,
          mode: 'auto',
          agents: false,
          skipAgents: true,
          inputMode: 'disabled',
          yes: true,
          cliVersion: '0.2.0',
          skipLlm: true,
          skipEmbeddings: true,
          databaseSchemas: [],
          skipDatabases: true,
          skipSources: true,
        },
        testIo.io,
        {
          model: async () => ({ status: 'skipped', projectDir: tempDir }),
          embeddings: async () => ({ status: 'skipped', projectDir: tempDir }),
          databases: async () => ({ status: 'skipped', projectDir: tempDir }),
          sources: async () => ({ status: 'skipped', projectDir: tempDir }),
          runtime: async () => ({ status: 'failed', projectDir: tempDir, requirements: { features: ['core'], requirements: [] } }),
        },
      ),
    ).resolves.toBe(1);

    await expect(readFile(join(tempDir, 'notes.txt'), 'utf-8')).resolves.toBe('keep me\n');
    await expect(stat(join(tempDir, 'ktx.yaml'))).resolves.toBeDefined();
  });

  it('shows demo near the bottom of the first setup intent menu before project creation', async () => {
    const testIo = makeIo();
    const select = vi.fn(async (options: { options: Array<{ value: string; label: string }> }) => {
      const labels = options.options.map((option) => option.label);
      expect(labels).toEqual([
        'Set up ktx for my data',
        'Check setup status',
        'Explore a pre-built ktx project',
        'Exit',
      ]);
      expect(labels.indexOf('Explore a pre-built ktx project')).toBe(labels.length - 2);
      return 'exit';
    });
    const cancel = vi.fn();

    await expect(
      runKtxSetup(
        {
          command: 'run',
          projectDir: tempDir,
          mode: 'auto',
          agents: false,
          skipAgents: false,
          inputMode: 'auto',
          yes: false,
          cliVersion: '0.2.0',
          skipLlm: false,
          skipEmbeddings: false,
          databaseSchemas: [],
          skipDatabases: false,
          skipSources: false,
          showEntryMenu: true,
        },
        testIo.io,
        { entryMenuDeps: { prompts: { select, cancel } } },
      ),
    ).resolves.toBe(0);

    expect(select).toHaveBeenCalledWith(expect.objectContaining({ message: 'What do you want to do?' }));
    expect(cancel).toHaveBeenCalledWith('Setup cancelled.');
  });

  it('shows agent connection only when the selected setup project exists', async () => {
    const missingIo = makeIo();
    const existingIo = makeIo();
    const missingSelect = vi.fn(async (options: { options: Array<{ value: string; label: string }> }) => {
      expect(options.options.map((option) => option.label)).not.toContain('Connect a coding agent to ktx');
      return 'exit';
    });
    const existingSelect = vi.fn(async (options: { options: Array<{ value: string; label: string }> }) => {
      const labels = options.options.map((option) => option.label);
      expect(labels).toEqual([
        'Resume or change an existing setup',
        'Create a new ktx project',
        'Connect a coding agent to ktx',
        'Check setup status',
        'Explore a pre-built ktx project',
        'Exit',
      ]);
      return 'exit';
    });

    await expect(
      runKtxSetup(
        {
          command: 'run',
          projectDir: tempDir,
          mode: 'auto',
          agents: false,
          skipAgents: false,
          inputMode: 'auto',
          yes: false,
          cliVersion: '0.2.0',
          skipLlm: false,
          skipEmbeddings: false,
          databaseSchemas: [],
          skipDatabases: false,
          skipSources: false,
          showEntryMenu: true,
        },
        missingIo.io,
        { entryMenuDeps: { prompts: { select: missingSelect, cancel: vi.fn() } } },
      ),
    ).resolves.toBe(0);

    await writeFile(join(tempDir, 'ktx.yaml'), 'connections: {}\n', 'utf-8');

    await expect(
      runKtxSetup(
        {
          command: 'run',
          projectDir: tempDir,
          mode: 'auto',
          agents: false,
          skipAgents: false,
          inputMode: 'auto',
          yes: false,
          cliVersion: '0.2.0',
          skipLlm: false,
          skipEmbeddings: false,
          databaseSchemas: [],
          skipDatabases: false,
          skipSources: false,
          showEntryMenu: true,
        },
        existingIo.io,
        { entryMenuDeps: { prompts: { select: existingSelect, cancel: vi.fn() } } },
      ),
    ).resolves.toBe(0);

    expect(missingSelect).toHaveBeenCalledTimes(1);
    expect(existingSelect).toHaveBeenCalledTimes(1);
  });

  it('lets Back from project selection return to the first setup intent menu', async () => {
    const entryChoices = ['setup', 'exit'];
    const entryPrompts = {
      select: vi.fn(async () => entryChoices.shift() ?? 'exit'),
      cancel: vi.fn(),
    };
    const projectPrompts = {
      select: vi.fn(async () => 'back'),
      text: vi.fn(),
      cancel: vi.fn(),
    };

    await expect(
      runKtxSetup(
        {
          command: 'run',
          projectDir: tempDir,
          mode: 'auto',
          agents: false,
          skipAgents: true,
          inputMode: 'auto',
          yes: false,
          cliVersion: '0.2.0',
          skipLlm: true,
          skipEmbeddings: true,
          databaseSchemas: [],
          skipDatabases: true,
          skipSources: true,
          showEntryMenu: true,
        },
        makeIo().io,
        {
          entryMenuDeps: { prompts: entryPrompts },
          project: { prompts: projectPrompts },
        },
      ),
    ).resolves.toBe(0);

    expect(projectPrompts.select).toHaveBeenCalledWith(
      expect.objectContaining({
        message: 'Where should ktx create the project?',
        options: expect.arrayContaining([expect.objectContaining({ value: 'back', label: 'Back' })]),
      }),
    );
    expect(projectPrompts.select).toHaveBeenCalledWith(
      expect.objectContaining({
        message: 'Where should ktx create the project?',
        options: expect.not.arrayContaining([expect.objectContaining({ value: 'exit', label: 'Exit' })]),
      }),
    );
    expect(entryPrompts.select).toHaveBeenCalledTimes(2);
    expect(entryPrompts.cancel).toHaveBeenCalledWith('Setup cancelled.');
    expect(projectPrompts.cancel).not.toHaveBeenCalled();
    await expect(stat(join(tempDir, 'ktx.yaml'))).rejects.toThrow();
  });

  it('lets Back from new project creation return to the first setup intent menu', async () => {
    const existingConfig = 'connections: {}\n';
    await writeFile(join(tempDir, 'ktx.yaml'), existingConfig, 'utf-8');

    const entryChoices = ['new-project', 'exit'];
    const entryPrompts = {
      select: vi.fn(async () => entryChoices.shift() ?? 'exit'),
      cancel: vi.fn(),
    };
    const projectPrompts = {
      select: vi.fn(async () => 'back'),
      text: vi.fn(),
      cancel: vi.fn(),
    };

    await expect(
      runKtxSetup(
        {
          command: 'run',
          projectDir: tempDir,
          mode: 'auto',
          agents: false,
          skipAgents: true,
          inputMode: 'auto',
          yes: false,
          cliVersion: '0.2.0',
          skipLlm: true,
          skipEmbeddings: true,
          databaseSchemas: [],
          skipDatabases: true,
          skipSources: true,
          showEntryMenu: true,
        },
        makeIo().io,
        {
          entryMenuDeps: { prompts: entryPrompts },
          project: { prompts: projectPrompts },
        },
      ),
    ).resolves.toBe(0);

    expect(projectPrompts.select).toHaveBeenCalledWith(
      expect.objectContaining({
        message: 'Where should ktx create the project?',
        options: expect.arrayContaining([expect.objectContaining({ value: 'back', label: 'Back' })]),
      }),
    );
    expect(entryPrompts.select).toHaveBeenCalledTimes(2);
    expect(entryPrompts.cancel).toHaveBeenCalledWith('Setup cancelled.');
    expect(projectPrompts.cancel).not.toHaveBeenCalled();
    await expect(readFile(join(tempDir, 'ktx.yaml'), 'utf-8')).resolves.toBe(existingConfig);
  });

  it('creates a separate project when the existing setup menu chooses new project', async () => {
    const existingProjectDir = join(tempDir, 'existing');
    const newProjectDir = join(tempDir, 'fresh');
    await mkdir(existingProjectDir, { recursive: true });
    const existingConfig = 'connections: {}\n';
    await writeFile(join(existingProjectDir, 'ktx.yaml'), existingConfig, 'utf-8');

    const projectChoices = ['custom', 'create'];
    const projectPrompts = {
      select: vi.fn(async () => projectChoices.shift() ?? 'exit'),
      text: vi.fn(async () => newProjectDir),
      cancel: vi.fn(),
    };
    const model = vi.fn(async (args: { projectDir: string }) => ({
      status: 'skipped' as const,
      projectDir: args.projectDir,
    }));
    const embeddings = vi.fn(async (args: { projectDir: string }) => ({
      status: 'skipped' as const,
      projectDir: args.projectDir,
    }));
    const databases = vi.fn(async (args: { projectDir: string }) => ({
      status: 'skipped' as const,
      projectDir: args.projectDir,
    }));
    const sources = vi.fn(async (args: { projectDir: string }) => ({
      status: 'skipped' as const,
      projectDir: args.projectDir,
    }));

    await expect(
      runKtxSetup(
        {
          command: 'run',
          projectDir: existingProjectDir,
          mode: 'auto',
          agents: false,
          skipAgents: true,
          inputMode: 'auto',
          yes: false,
          cliVersion: '0.2.0',
          skipLlm: true,
          skipEmbeddings: true,
          databaseSchemas: [],
          skipDatabases: true,
          skipSources: true,
          showEntryMenu: true,
        },
        makeIo().io,
        {
          entryMenuDeps: { prompts: { select: vi.fn(async () => 'new-project'), cancel: vi.fn() } },
          project: { prompts: projectPrompts },
          model,
          embeddings,
          databases,
          sources,
        },
      ),
    ).resolves.toBe(0);

    expect(projectPrompts.text).toHaveBeenCalledWith(
      expect.objectContaining({
        message: 'Project folder path\n│  Press Escape to go back.\n│',
        placeholder: './analytics-ktx, ~/analytics-ktx, or /Users/you/projects/analytics-ktx',
      }),
    );
    expect(projectPrompts.select).toHaveBeenCalledWith(
      expect.objectContaining({ message: 'Where should ktx create the project?' }),
    );
    await expect(stat(join(newProjectDir, 'ktx.yaml'))).resolves.toBeDefined();
    await expect(readFile(join(existingProjectDir, 'ktx.yaml'), 'utf-8')).resolves.toBe(existingConfig);
    expect(model).toHaveBeenCalledWith(expect.objectContaining({ projectDir: newProjectDir }), expect.anything());
    expect(embeddings).toHaveBeenCalledWith(expect.objectContaining({ projectDir: newProjectDir }), expect.anything());
    expect(databases).toHaveBeenCalledWith(expect.objectContaining({ projectDir: newProjectDir }), expect.anything());
    expect(sources).toHaveBeenCalledWith(expect.objectContaining({ projectDir: newProjectDir }), expect.anything());
  });

  it('does not print navigation instructions immediately after confirming new project creation', async () => {
    const existingProjectDir = join(tempDir, 'existing');
    const newProjectDir = join(tempDir, 'fresh');
    await mkdir(existingProjectDir, { recursive: true });
    await writeFile(join(existingProjectDir, 'ktx.yaml'), 'connections: {}\n', 'utf-8');

    const projectChoices = ['custom', 'create'];
    const projectPrompts = {
      select: vi.fn(async () => projectChoices.shift() ?? 'exit'),
      text: vi.fn(async () => newProjectDir),
      cancel: vi.fn(),
    };
    const model = vi.fn(async (args: { projectDir: string; showPromptInstructions?: boolean }) => {
      expect(args.showPromptInstructions).toBe(false);
      return { status: 'skipped' as const, projectDir: args.projectDir };
    });
    const testIo = makeIo();

    await expect(
      runKtxSetup(
        {
          command: 'run',
          projectDir: existingProjectDir,
          mode: 'auto',
          agents: false,
          skipAgents: true,
          inputMode: 'auto',
          yes: false,
          cliVersion: '0.2.0',
          skipLlm: false,
          skipEmbeddings: true,
          databaseSchemas: [],
          skipDatabases: true,
          skipSources: true,
          showEntryMenu: true,
        },
        testIo.io,
        {
          entryMenuDeps: { prompts: { select: vi.fn(async () => 'new-project'), cancel: vi.fn() } },
          project: { prompts: projectPrompts },
          model,
        },
      ),
    ).resolves.toBe(0);

    expect(testIo.stdout()).toContain(`Project: ${newProjectDir}\n`);
    expect(testIo.stdout()).not.toContain(
      'Use Up/Down to move, Enter to confirm the current selection, choose Back to return to the previous step, Ctrl+C to exit.',
    );
  });

  it('runs the demo tour when the first setup intent menu chooses demo', async () => {
    const testIo = makeIo();

    await expect(
      runKtxSetup(
        {
          command: 'run',
          projectDir: tempDir,
          mode: 'auto',
          agents: false,
          skipAgents: false,
          inputMode: 'auto',
          yes: false,
          cliVersion: '0.2.0',
          skipLlm: false,
          skipEmbeddings: false,
          databaseSchemas: [],
          skipDatabases: false,
          skipSources: false,
          showEntryMenu: true,
        },
        testIo.io,
        { entryMenuDeps: { prompts: { select: vi.fn(async () => 'demo'), cancel: vi.fn() } } },
      ),
    ).resolves.toBe(0);

    expect(runDemoTour).toHaveBeenCalledWith(
      { inputMode: 'auto', cliVersion: '0.2.0' },
      testIo.io,
      expect.objectContaining({}),
    );
  });

  it('creates a project through run mode when --yes is selected', async () => {
    const testIo = makeIo();

    await expect(
      runKtxSetup(
        {
          command: 'run',
          projectDir: tempDir,
          mode: 'auto',
          agents: false,
          skipAgents: true,
          inputMode: 'disabled',
          yes: true,
          cliVersion: '0.2.0',
          skipLlm: true,
          skipEmbeddings: true,
          databaseSchemas: [],
          skipDatabases: true,
          skipSources: true,
        },
        testIo.io,
      ),
    ).resolves.toBe(0);

    await expect(stat(join(tempDir, 'ktx.yaml'))).resolves.toBeDefined();
    expect(await readFile(join(tempDir, 'ktx.yaml'), 'utf-8')).not.toContain('completed_steps:');
    await expect(readFile(join(tempDir, '.ktx', 'setup', 'state.json'), 'utf-8')).resolves.toBe(
      `${JSON.stringify({ completed_steps: ['project', 'sources'] }, null, 2)}\n`,
    );
    expect(testIo.stdout()).toContain('ktx setup');
    expect(testIo.stdout()).toContain(`Project: ${tempDir}`);
    expect(testIo.stdout()).toContain('Project ready: yes');
    expect(testIo.stderr()).toBe('');
  });

  it('returns nonzero when project selection is missing in no-input mode even when optional sections are skipped', async () => {
    const testIo = makeIo();

    await expect(
      runKtxSetup(
        {
          command: 'run',
          projectDir: tempDir,
          mode: 'auto',
          agents: false,
          skipAgents: true,
          inputMode: 'disabled',
          yes: false,
          cliVersion: '0.2.0',
          skipLlm: true,
          skipEmbeddings: true,
          databaseSchemas: [],
          skipDatabases: true,
          skipSources: true,
        },
        testIo.io,
      ),
    ).resolves.toBe(1);

    expect(testIo.stderr()).toContain('Missing setup choice');
    await expect(stat(join(tempDir, 'ktx.yaml'))).rejects.toThrow();
  });

  it('returns nonzero when project selection is missing in non-interactive setup', async () => {
    const testIo = makeIo();

    await expect(
      runKtxSetup(
        {
          command: 'run',
          projectDir: tempDir,
          mode: 'auto',
          agents: false,
          skipAgents: true,
          inputMode: 'disabled',
          yes: false,
          cliVersion: '0.2.0',
          skipLlm: false,
          skipEmbeddings: true,
          databaseSchemas: [],
          skipDatabases: true,
          skipSources: true,
        },
        testIo.io,
      ),
    ).resolves.toBe(1);

    expect(testIo.stderr()).toContain('Missing setup choice');
    await expect(stat(join(tempDir, 'ktx.yaml'))).rejects.toThrow();
  });

  it('runs the Anthropic model step after project selection succeeds', async () => {
    const testIo = makeIo();
    const model = vi.fn(async () => ({ status: 'ready' as const, projectDir: tempDir }));

    await expect(
      runKtxSetup(
        {
          command: 'run',
          projectDir: tempDir,
          mode: 'auto',
          agents: false,
          skipAgents: true,
          inputMode: 'disabled',
          yes: true,
          cliVersion: '0.2.0',
          anthropicApiKeyEnv: 'ANTHROPIC_API_KEY', // pragma: allowlist secret
          skipLlm: false,
          skipEmbeddings: true,
          databaseSchemas: [],
          skipDatabases: true,
          skipSources: true,
        },
        testIo.io,
        { model },
      ),
    ).resolves.toBe(0);

    expect(model).toHaveBeenCalledWith(
      expect.objectContaining({
        projectDir: tempDir,
        inputMode: 'disabled',
        anthropicApiKeyEnv: 'ANTHROPIC_API_KEY', // pragma: allowlist secret
        skipLlm: false,
      }),
      testIo.io,
    );
  });

  it('passes Vertex AI model setup args after project selection succeeds', async () => {
    const testIo = makeIo();
    const model = vi.fn(async () => ({ status: 'ready' as const, projectDir: tempDir }));

    await expect(
      runKtxSetup(
        {
          command: 'run',
          projectDir: tempDir,
          mode: 'auto',
          agents: false,
          skipAgents: true,
          inputMode: 'disabled',
          yes: true,
          cliVersion: '0.2.0',
          llmBackend: 'vertex',
          vertexProject: 'local-gcp-project',
          vertexLocation: 'us-east5',
          skipLlm: false,
          skipEmbeddings: true,
          databaseSchemas: [],
          skipDatabases: true,
          skipSources: true,
        },
        testIo.io,
        { model },
      ),
    ).resolves.toBe(0);

    expect(model).toHaveBeenCalledWith(
      expect.objectContaining({
        projectDir: tempDir,
        inputMode: 'disabled',
        llmBackend: 'vertex',
        vertexProject: 'local-gcp-project',
        vertexLocation: 'us-east5',
        skipLlm: false,
      }),
      testIo.io,
    );
  });

  it('runs the embedding setup step after the model step succeeds', async () => {
    const testIo = makeIo();
    const model = vi.fn(async () => ({ status: 'ready' as const, projectDir: tempDir }));
    const embeddings = vi.fn(async () => ({ status: 'ready' as const, projectDir: tempDir }));

    await expect(
      runKtxSetup(
        {
          command: 'run',
          projectDir: tempDir,
          mode: 'auto',
          agents: false,
          skipAgents: true,
          inputMode: 'disabled',
          yes: true,
          cliVersion: '0.2.0',
          anthropicApiKeyEnv: 'ANTHROPIC_API_KEY', // pragma: allowlist secret
          skipLlm: false,
          embeddingBackend: 'openai',
          embeddingApiKeyEnv: 'OPENAI_API_KEY', // pragma: allowlist secret
          skipEmbeddings: false,
          databaseSchemas: [],
          skipDatabases: true,
          skipSources: true,
        },
        testIo.io,
        { model, embeddings },
      ),
    ).resolves.toBe(0);

    expect(embeddings).toHaveBeenCalledWith(
      expect.objectContaining({
        projectDir: tempDir,
        inputMode: 'disabled',
        cliVersion: '0.2.0',
        runtimeInstallPolicy: 'auto',
        embeddingBackend: 'openai',
        embeddingApiKeyEnv: 'OPENAI_API_KEY', // pragma: allowlist secret
        skipEmbeddings: false,
      }),
      testIo.io,
    );
  });

  it('passes no-input runtime policy to the embeddings step', async () => {
    const io = makeIo();
    const embeddings = vi.fn(async () => ({ status: 'failed' as const, projectDir: tempDir }));
    await writeFile(join(tempDir, 'ktx.yaml'), 'connections: {}\n', 'utf-8');

    await expect(
      runKtxSetup(
        {
          command: 'run',
          projectDir: tempDir,
          mode: 'auto',
          agents: false,
          agentScope: 'project',
          skipAgents: true,
          inputMode: 'disabled',
          yes: false,
          cliVersion: '0.2.0',
          skipLlm: true,
          skipEmbeddings: false,
          databaseSchemas: [],
          skipDatabases: true,
          skipSources: true,
        },
        io.io,
        { embeddings },
      ),
    ).resolves.toBe(1);

    expect(embeddings).toHaveBeenCalledWith(
      expect.objectContaining({
        cliVersion: '0.2.0',
        runtimeInstallPolicy: 'never',
      }),
      io.io,
    );
  });

  it('prompts before installing the managed runtime by default during setup', async () => {
    const io = makeIo();
    const embeddings = vi.fn(async () => ({ status: 'ready' as const, projectDir: tempDir }));
    const context = vi.fn(async () => ({ status: 'failed' as const, projectDir: tempDir }));
    await writeFile(join(tempDir, 'ktx.yaml'), 'connections: {}\n', 'utf-8');

    await expect(
      runKtxSetup(
        {
          command: 'run',
          projectDir: tempDir,
          mode: 'auto',
          agents: false,
          agentScope: 'project',
          skipAgents: true,
          inputMode: 'auto',
          yes: false,
          cliVersion: '0.2.0',
          skipLlm: true,
          skipEmbeddings: false,
          databaseSchemas: [],
          skipDatabases: true,
          skipSources: true,
        },
        io.io,
        {
          embeddings,
          context,
        },
      ),
    ).resolves.toBe(1);

    expect(embeddings).toHaveBeenCalledWith(
      expect.objectContaining({
        cliVersion: '0.2.0',
        runtimeInstallPolicy: 'prompt',
      }),
      io.io,
    );
    expect(context).toHaveBeenCalledWith(
      expect.objectContaining({
        cliVersion: '0.2.0',
        runtimeInstallPolicy: 'prompt',
      }),
      io.io,
    );
  });

  it('lets Back from embedding setup return to the model step instead of exiting', async () => {
    const testIo = makeIo();
    await writeFile(join(tempDir, 'ktx.yaml'), 'connections: {}\n', 'utf-8');
    const modelResults = [
      { status: 'ready' as const, projectDir: tempDir },
      { status: 'back' as const, projectDir: tempDir },
    ];
    const model = vi.fn(async () => modelResults.shift() ?? { status: 'back' as const, projectDir: tempDir });
    const embeddings = vi.fn(async () => ({ status: 'back' as const, projectDir: tempDir }));

    await expect(
      runKtxSetup(
        {
          command: 'run',
          projectDir: tempDir,
          mode: 'auto',
          agents: false,
          skipAgents: true,
          inputMode: 'auto',
          yes: false,
          cliVersion: '0.2.0',
          skipLlm: false,
          skipEmbeddings: false,
          databaseSchemas: [],
          skipDatabases: true,
          skipSources: true,
        },
        testIo.io,
        { model, embeddings },
      ),
    ).resolves.toBe(0);

    expect(model).toHaveBeenCalledTimes(2);
    expect(model).toHaveBeenNthCalledWith(2, expect.objectContaining({ forcePrompt: true }), testIo.io);
    expect(embeddings).toHaveBeenCalledTimes(1);
  });

  it('lets Back from database selection return to embedding setup', async () => {
    const testIo = makeIo();
    await writeFile(join(tempDir, 'ktx.yaml'), 'connections: {}\n', 'utf-8');
    const modelResults = [
      { status: 'ready' as const, projectDir: tempDir },
      { status: 'back' as const, projectDir: tempDir },
    ];
    const model = vi.fn(async () => modelResults.shift() ?? { status: 'back' as const, projectDir: tempDir });
    const embeddingResults = [
      { status: 'ready' as const, projectDir: tempDir },
      { status: 'back' as const, projectDir: tempDir },
    ];
    const embeddings = vi.fn(async () => embeddingResults.shift() ?? { status: 'back' as const, projectDir: tempDir });
    const databasePrompts = {
      multiselect: vi.fn(async () => ['back']),
      autocompleteMultiselect: vi.fn(async () => ['back']),
      select: vi.fn(async () => 'back'),
      text: vi.fn(),
      password: vi.fn(),
      cancel: vi.fn(),
    };

    await expect(
      runKtxSetup(
        {
          command: 'run',
          projectDir: tempDir,
          mode: 'auto',
          agents: false,
          skipAgents: true,
          inputMode: 'auto',
          yes: true,
          cliVersion: '0.2.0',
          skipLlm: false,
          skipEmbeddings: false,
          databaseSchemas: [],
          skipDatabases: false,
          skipSources: true,
        },
        testIo.io,
        {
          model,
          embeddings,
          databasesDeps: { prompts: databasePrompts },
        },
      ),
    ).resolves.toBe(0);

    expect(databasePrompts.select).not.toHaveBeenCalled();
    expect(embeddings).toHaveBeenCalledTimes(2);
    expect(embeddings).toHaveBeenNthCalledWith(2, expect.objectContaining({ forcePrompt: true }), testIo.io);
    expect(testIo.stderr()).not.toContain('No databases selected.');
  });

  it('lets Back from the first setup step return to the entry menu instead of exiting', async () => {
    await writeFile(join(tempDir, 'ktx.yaml'), 'connections: {}\n', 'utf-8');
    const testIo = makeIo();

    const entryChoices = ['setup', 'exit'];
    const entryPrompts = {
      select: vi.fn(async () => entryChoices.shift() ?? 'exit'),
      cancel: vi.fn(),
    };
    const model = vi.fn(async () => ({ status: 'back' as const, projectDir: tempDir }));

    await expect(
      runKtxSetup(
        {
          command: 'run',
          projectDir: tempDir,
          mode: 'auto',
          agents: false,
          skipAgents: true,
          inputMode: 'auto',
          yes: true,
          cliVersion: '0.2.0',
          skipLlm: false,
          skipEmbeddings: true,
          databaseSchemas: [],
          skipDatabases: true,
          skipSources: true,
          showEntryMenu: true,
        },
        testIo.io,
        {
          entryMenuDeps: { prompts: entryPrompts },
          model,
        },
      ),
    ).resolves.toBe(0);

    expect(entryPrompts.select).toHaveBeenCalledTimes(2);
    expect(entryPrompts.cancel).toHaveBeenCalledWith('Setup cancelled.');
    expect(model).toHaveBeenCalledTimes(1);
  });

  it('runs database setup after embeddings succeed', async () => {
    const testIo = makeIo();
    const model = vi.fn(async () => ({ status: 'ready' as const, projectDir: tempDir }));
    const embeddings = vi.fn(async () => ({ status: 'ready' as const, projectDir: tempDir }));
    const databases = vi.fn(async () => ({
      status: 'ready' as const,
      projectDir: tempDir,
      connectionIds: ['warehouse'],
    }));

    await expect(
      runKtxSetup(
        {
          command: 'run',
          projectDir: tempDir,
          mode: 'auto',
          agents: false,
          skipAgents: true,
          inputMode: 'disabled',
          yes: true,
          cliVersion: '0.2.0',
          anthropicApiKeyEnv: 'ANTHROPIC_API_KEY', // pragma: allowlist secret
          skipLlm: false,
          embeddingBackend: 'openai',
          embeddingApiKeyEnv: 'OPENAI_API_KEY', // pragma: allowlist secret
          skipEmbeddings: false,
          databaseDrivers: ['postgres'],
          databaseConnectionId: 'warehouse',
          databaseUrl: 'env:DATABASE_URL',
          databaseSchemas: ['public'],
          enableQueryHistory: true,
          queryHistoryWindowDays: 30,
          queryHistoryMinExecutions: 12,
          queryHistoryServiceAccountPatterns: ['^svc_'],
          queryHistoryRedactionPatterns: ['(?i)secret'],
          skipDatabases: false,
          skipSources: true,
        },
        testIo.io,
        { model, embeddings, databases },
      ),
    ).resolves.toBe(0);

    expect(databases).toHaveBeenCalledWith(
      expect.objectContaining({
        projectDir: tempDir,
        inputMode: 'disabled',
        yes: true,
        cliVersion: '0.2.0',
        runtimeInstallPolicy: 'auto',
        databaseDrivers: ['postgres'],
        databaseConnectionId: 'warehouse',
        databaseUrl: 'env:DATABASE_URL',
        databaseSchemas: ['public'],
        enableQueryHistory: true,
        queryHistoryWindowDays: 30,
        queryHistoryMinExecutions: 12,
        queryHistoryServiceAccountPatterns: ['^svc_'],
        queryHistoryRedactionPatterns: ['(?i)secret'],
        skipDatabases: false,
      }),
      testIo.io,
    );
  });

  it('runs sources after database setup', async () => {
    const calls: string[] = [];
    const io = makeIo();
    await writeFile(join(tempDir, 'ktx.yaml'), ['connections: {}', ''].join('\n'), 'utf-8');

    await expect(
      runKtxSetup(
        {
          command: 'run',
          projectDir: tempDir,
          mode: 'auto',
          agents: false,
          skipAgents: true,
          inputMode: 'disabled',
          yes: true,
          cliVersion: '0.2.0',
          skipLlm: true,
          skipEmbeddings: true,
          skipDatabases: true,
          skipSources: true,
          databaseSchemas: [],
        },
        io.io,
        {
          model: async () => {
            calls.push('model');
            return { status: 'skipped', projectDir: tempDir };
          },
          embeddings: async () => {
            calls.push('embeddings');
            return { status: 'skipped', projectDir: tempDir };
          },
          databases: async () => {
            calls.push('databases');
            return { status: 'skipped', projectDir: tempDir };
          },
          sources: async (args) => {
            expect(args.runInitialSourceIngest).toBe(false);
            calls.push('sources');
            return { status: 'skipped', projectDir: tempDir };
          },
        },
      ),
    ).resolves.toBe(0);

    expect(calls).toEqual(['model', 'embeddings', 'databases', 'sources']);
  });

  it('passes context-source skip selection from database setup into the sources step', async () => {
    const calls: string[] = [];
    const io = makeIo();
    await writeFile(join(tempDir, 'ktx.yaml'), ['connections: {}', ''].join('\n'), 'utf-8');

    await expect(
      runKtxSetup(
        {
          command: 'run',
          projectDir: tempDir,
          mode: 'auto',
          agents: false,
          skipAgents: true,
          inputMode: 'disabled',
          yes: true,
          cliVersion: '0.2.0',
          skipLlm: true,
          skipEmbeddings: true,
          skipDatabases: false,
          skipSources: false,
          databaseSchemas: [],
        },
        io.io,
        {
          model: async () => {
            calls.push('model');
            return { status: 'skipped', projectDir: tempDir };
          },
          embeddings: async () => {
            calls.push('embeddings');
            return { status: 'skipped', projectDir: tempDir };
          },
          databases: async () => {
            calls.push('databases');
            return {
              status: 'ready',
              projectDir: tempDir,
              connectionIds: ['warehouse'],
              skipSources: true,
            };
          },
          sources: async (args) => {
            expect(args.skipSources).toBe(true);
            calls.push('sources');
            return { status: 'skipped', projectDir: tempDir };
          },
          runtime: async () => {
            calls.push('runtime');
            return runtimeReady(tempDir);
          },
          context: async () => {
            calls.push('context');
            return { status: 'ready', projectDir: tempDir, runId: 'setup-context-local-test' };
          },
        },
      ),
    ).resolves.toBe(0);

    expect(calls).toEqual(['model', 'embeddings', 'databases', 'sources', 'runtime', 'context']);
  });

  it.each([
    {
      backend: 'vertex',
      providerLines: ['    backend: vertex', '    vertex:', '      project: kaelio-dev', '      location: us-east5'],
      model: 'claude-sonnet-4-6',
    },
    {
      backend: 'gateway',
      providerLines: ['    backend: gateway', '    gateway:', '      api_key: env:AI_GATEWAY_API_KEY'],
      model: 'anthropic/claude-sonnet-4-6',
    },
  ])('adds a dbt source in non-interactive setup with existing $backend llm config', async (fixture) => {
    const io = makeIo();
    await writeFile(
      join(tempDir, 'ktx.yaml'),
      [
        'setup:',
        '  database_connection_ids:',
        '    - warehouse',
        'connections:',
        '  warehouse:',
        '    driver: postgres',
        '    url: env:WAREHOUSE_URL',
        'llm:',
        '  provider:',
        ...fixture.providerLines,
        '  models:',
        `    default: ${fixture.model}`,
      ].join('\n'),
      'utf-8',
    );
    await writeKtxSetupState(tempDir, { completed_steps: ['project', 'databases'] });

    await expect(
      runKtxSetup(
        {
          command: 'run',
          projectDir: tempDir,
          mode: 'auto',
          agents: false,
          skipAgents: true,
          inputMode: 'disabled',
          yes: true,
          cliVersion: '0.2.0',
          skipLlm: false,
          skipEmbeddings: true,
          skipDatabases: true,
          source: 'dbt',
          sourceConnectionId: 'dbt-main',
          sourceGitUrl: 'https://github.com/Kaelio/klo-dbt-demo',
          sourceBranch: 'main',
          sourceProjectName: 'orbit_analytics',
          sourceWarehouseConnectionId: 'warehouse',
          skipSources: false,
          databaseSchemas: [],
        },
        io.io,
        {
          sourcesDeps: { validateDbt: vi.fn(async () => ({ ok: true as const, detail: 'dbt project valid' })) },
          context: vi.fn(async () => ({ status: 'ready' as const, projectDir: tempDir, runId: 'setup-context-test' })),
        },
      ),
    ).resolves.toBe(0);

    expect(io.stderr()).not.toContain('Anthropic');
    expect(await readFile(join(tempDir, 'ktx.yaml'), 'utf-8')).toContain('dbt-main:');
  });

  it('does not fail context build when prerequisites were explicitly skipped and agents are skipped', async () => {
    const calls: string[] = [];
    const io = makeIo();
    await writeFile(
      join(tempDir, 'ktx.yaml'),
      [
        'connections:',
        '  warehouse:',
        '    driver: postgres',
        '    url: env:DEMO_DATABASE_URL',
        '',
      ].join('\n'),
      'utf-8',
    );

    await expect(
      runKtxSetup(
        {
          command: 'run',
          projectDir: tempDir,
          mode: 'auto',
          agents: false,
          skipAgents: true,
          inputMode: 'disabled',
          yes: true,
          cliVersion: '0.2.0',
          skipLlm: true,
          skipEmbeddings: true,
          skipDatabases: true,
          skipSources: true,
          databaseSchemas: [],
        },
        io.io,
        {
          model: async () => {
            calls.push('model');
            return { status: 'skipped', projectDir: tempDir };
          },
          embeddings: async () => {
            calls.push('embeddings');
            return { status: 'skipped', projectDir: tempDir };
          },
          databases: async () => {
            calls.push('databases');
            return { status: 'skipped', projectDir: tempDir };
          },
          sources: async () => {
            calls.push('sources');
            return { status: 'skipped', projectDir: tempDir };
          },
        },
      ),
    ).resolves.toBe(0);

    expect(calls).toEqual(['model', 'embeddings', 'databases', 'sources']);
    expect(io.stderr()).not.toContain('ktx cannot build agent-ready context yet.');
  });

  it('runs context after sources and before agents in full setup', async () => {
    const calls: string[] = [];
    const io = makeIo();
    await writeFile(join(tempDir, 'ktx.yaml'), ['connections: {}', ''].join('\n'), 'utf-8');

    await expect(
      runKtxSetup(
        {
          command: 'run',
          projectDir: tempDir,
          mode: 'auto',
          agents: false,
          inputMode: 'disabled',
          yes: true,
          cliVersion: '0.2.0',
          skipLlm: true,
          skipEmbeddings: true,
          skipDatabases: true,
          skipSources: true,
          skipAgents: false,
          databaseSchemas: [],
        },
        io.io,
        {
          model: async () => {
            calls.push('model');
            return { status: 'skipped', projectDir: tempDir };
          },
          embeddings: async () => {
            calls.push('embeddings');
            return { status: 'skipped', projectDir: tempDir };
          },
          databases: async () => {
            calls.push('databases');
            return { status: 'skipped', projectDir: tempDir };
          },
          sources: async () => {
            calls.push('sources');
            return { status: 'skipped', projectDir: tempDir };
          },
          runtime: async () => {
            calls.push('runtime');
            return runtimeReady(tempDir);
          },
          context: async () => {
            calls.push('context');
            return { status: 'ready', projectDir: tempDir, runId: 'setup-context-local-test' };
          },
          agents: async () => {
            calls.push('agents');
            return {
              status: 'ready',
              projectDir: tempDir,
              installs: [{ target: 'codex', scope: 'project', mode: 'mcp-cli', installRoot: tempDir }],
            };
          },
        },
      ),
    ).resolves.toBe(0);

    expect(calls).toEqual(['model', 'embeddings', 'databases', 'sources', 'runtime', 'context', 'agents']);
  });

  it('commits setup config changes written by later setup steps', async () => {
    const io = makeIo();

    await expect(
      runKtxSetup(
        {
          command: 'run',
          projectDir: tempDir,
          mode: 'auto',
          agents: false,
          inputMode: 'disabled',
          yes: true,
          cliVersion: '0.2.0',
          skipLlm: true,
          skipEmbeddings: true,
          skipDatabases: true,
          skipSources: true,
          skipAgents: false,
          databaseSchemas: [],
        },
        io.io,
        {
          model: async () => ({ status: 'skipped', projectDir: tempDir }),
          embeddings: async () => ({ status: 'skipped', projectDir: tempDir }),
          databases: async () => {
            const configPath = join(tempDir, 'ktx.yaml');
            const current = await readFile(configPath, 'utf-8');
            await writeFile(
              configPath,
              current.replace(
                'connections: {}',
                ['connections:', '  warehouse:', '    driver: postgres', '    url: env:DATABASE_URL'].join('\n'),
              ),
              'utf-8',
            );
            return { status: 'skipped', projectDir: tempDir };
          },
          sources: async () => ({ status: 'skipped', projectDir: tempDir }),
          runtime: async () => runtimeReady(tempDir),
          context: async () => ({ status: 'ready', projectDir: tempDir, runId: 'setup-context-local-test' }),
          agents: async () => ({
            status: 'ready',
            projectDir: tempDir,
            installs: [{ target: 'codex', scope: 'project', mode: 'mcp-cli', installRoot: tempDir }],
          }),
        },
      ),
    ).resolves.toBe(0);

    const { stdout } = await execFileAsync('git', ['-C', tempDir, 'status', '--short', '--', 'ktx.yaml']);
    expect(stdout).toBe('');
    const committedConfig = await execFileAsync('git', ['-C', tempDir, 'show', 'HEAD:ktx.yaml']);
    expect(committedConfig.stdout).toContain('warehouse:');
  });

  it('runs agent setup without runtime or context in --agents mode', async () => {
    const calls: string[] = [];
    const io = makeIo();
    await writeFile(join(tempDir, 'ktx.yaml'), ['connections: {}', ''].join('\n'), 'utf-8');

    await expect(
      runKtxSetup(
        {
          command: 'run',
          projectDir: tempDir,
          mode: 'auto',
          agents: true,
          target: 'codex',
          agentScope: 'project',
          inputMode: 'disabled',
          yes: true,
          cliVersion: '0.2.0',
          skipLlm: true,
          skipEmbeddings: true,
          skipDatabases: true,
          skipSources: true,
          skipAgents: false,
          databaseSchemas: [],
        },
        io.io,
        {
          model: async () => ({ status: 'skipped', projectDir: tempDir }),
          embeddings: async () => ({ status: 'skipped', projectDir: tempDir }),
          databases: async () => ({ status: 'skipped', projectDir: tempDir }),
          sources: async () => ({ status: 'skipped', projectDir: tempDir }),
          runtime: async () => {
            calls.push('runtime');
            throw new Error('runtime should not run');
          },
          context: async () => {
            calls.push('context');
            throw new Error('context should not run');
          },
          agents: async () => {
            calls.push('agents');
            return {
              status: 'ready',
              projectDir: tempDir,
              installs: [{ target: 'codex', scope: 'project', mode: 'mcp-cli', installRoot: tempDir }],
            };
          },
        },
      ),
    ).resolves.toBe(0);

    expect(calls).toEqual(['agents']);
  });

  it('installs agents when non-interactive --agents finds context incomplete', async () => {
    const io = makeIo();
    const runtime = vi.fn(async () => runtimeReady(tempDir));
    const context = vi.fn(async () => ({ status: 'skipped' as const, projectDir: tempDir }));
    const agents = vi.fn(async () => ({
      status: 'ready' as const,
      projectDir: tempDir,
      installs: [{ target: 'codex' as const, scope: 'project' as const, mode: 'mcp-cli' as const, installRoot: tempDir }],
    }));
    await writeFile(join(tempDir, 'ktx.yaml'), ['connections: {}', ''].join('\n'), 'utf-8');

    await expect(
      runKtxSetup(
        {
          command: 'run',
          projectDir: tempDir,
          mode: 'auto',
          agents: true,
          target: 'codex',
          agentScope: 'project',
          inputMode: 'disabled',
          yes: true,
          cliVersion: '0.2.0',
          skipLlm: true,
          skipEmbeddings: true,
          skipDatabases: true,
          skipSources: true,
          skipAgents: false,
          databaseSchemas: [],
        },
        io.io,
        {
          runtime,
          context,
          agents,
        },
      ),
    ).resolves.toBe(0);

    expect(runtime).not.toHaveBeenCalled();
    expect(context).not.toHaveBeenCalled();
    expect(agents).toHaveBeenCalledTimes(1);
    expect(io.stderr()).not.toContain('ktx context is not ready for agents.');
  });

  it('runs non-TTY --agents with a target without requiring --no-input or --yes', async () => {
    const io = makeIo();
    const agents = vi.fn(async () => ({
      status: 'ready' as const,
      projectDir: tempDir,
      installs: [{ target: 'claude-code' as const, scope: 'project' as const, mode: 'mcp' as const, installRoot: tempDir }],
    }));
    await writeFile(join(tempDir, 'ktx.yaml'), ['connections: {}', ''].join('\n'), 'utf-8');

    await expect(
      runKtxSetup(
        {
          command: 'run',
          projectDir: tempDir,
          mode: 'auto',
          agents: true,
          target: 'claude-code',
          agentScope: 'project',
          inputMode: 'auto',
          yes: false,
          cliVersion: '0.2.0',
          skipLlm: false,
          skipEmbeddings: false,
          skipDatabases: false,
          skipSources: false,
          skipAgents: false,
          databaseSchemas: [],
        },
        io.io,
        { agents },
      ),
    ).resolves.toBe(0);

    expect(agents).toHaveBeenCalledWith(
      expect.objectContaining({
        inputMode: 'disabled',
        yes: false,
        agents: true,
        target: 'claude-code',
        scope: 'project',
        mode: 'mcp',
      }),
      io.io,
    );
    expect(io.stderr()).not.toContain('Interactive setup requires a terminal');
  });

  it('routes a ready project menu selection to agent setup', async () => {
    const calls: string[] = [];
    const io = makeIo();
    await mkdir(join(tempDir, '.ktx', 'agents'), { recursive: true });
    await writeFile(
      join(tempDir, 'ktx.yaml'),
      [
        'setup:',
        '  database_connection_ids: [warehouse]',
        'connections:',
        '  warehouse:',
        '    driver: postgres',
        '    url: env:DATABASE_URL',
        'llm:',
        '  provider:',
        '    backend: anthropic',
        '  models:',
        '    default: claude-sonnet-4-6',
        'ingest:',
        '  embeddings:',
        '    backend: openai',
        '    model: text-embedding-3-small',
        '    dimensions: 1536',
        '',
      ].join('\n'),
      'utf-8',
    );
    await writeKtxSetupState(tempDir, {
      completed_steps: ['project', 'llm', 'embeddings', 'databases', 'sources', 'runtime', 'context', 'agents'],
    });
    await writeFile(
      join(tempDir, '.ktx/agents/install-manifest.json'),
      JSON.stringify(
        {
          version: 1,
          projectDir: tempDir,
          installedAt: '2026-05-07T00:00:00.000Z',
          installs: [{ target: 'codex', scope: 'project', mode: 'mcp-cli', installRoot: tempDir }],
          entries: [],
        },
        null,
        2,
      ),
      'utf-8',
    );
    await writeKtxSetupContextState(tempDir, {
      runId: 'setup-context-local-ready',
      status: 'completed',
      startedAt: '2026-05-09T10:00:00.000Z',
      updatedAt: '2026-05-09T10:02:00.000Z',
      completedAt: '2026-05-09T10:02:00.000Z',
      primarySourceConnectionIds: [],
      contextSourceConnectionIds: [],
      reportIds: [],
      artifactPaths: [],
      retryableFailedTargets: [],
      commands: contextBuildCommands(tempDir),
    });

    const previousRuntimeRoot = process.env.KTX_RUNTIME_ROOT;
    process.env.KTX_RUNTIME_ROOT = await writeReadyRuntime(tempDir);
    try {
      await expect(
        runKtxSetup(
          {
            command: 'run',
            projectDir: tempDir,
            mode: 'auto',
            agents: false,
            inputMode: 'auto',
            yes: false,
            cliVersion: '0.2.0',
            skipLlm: false,
            skipEmbeddings: false,
            skipDatabases: false,
            skipSources: false,
            skipAgents: false,
            databaseSchemas: [],
          },
          io.io,
          {
            readyMenuDeps: {
              prompts: {
                select: vi.fn().mockResolvedValueOnce('change').mockResolvedValueOnce('agents'),
                cancel: vi.fn(),
              },
            },
            model: async (args) => {
              expect(args.skipLlm).toBe(true);
              return { status: 'skipped', projectDir: tempDir };
            },
            embeddings: async (args) => {
              expect(args.skipEmbeddings).toBe(true);
              return { status: 'skipped', projectDir: tempDir };
            },
            databases: async (args) => {
              expect(args.skipDatabases).toBe(true);
              return { status: 'skipped', projectDir: tempDir };
            },
            sources: async (args) => {
              expect(args.skipSources).toBe(true);
              return { status: 'skipped', projectDir: tempDir };
            },
            runtime: async () => {
              calls.push('runtime');
              return runtimeReady(tempDir);
            },
            agents: async () => {
              calls.push('agents');
              return {
                status: 'ready',
                projectDir: tempDir,
                installs: [{ target: 'codex', scope: 'project', mode: 'mcp-cli', installRoot: tempDir }],
              };
            },
          },
        ),
      ).resolves.toBe(0);
    } finally {
      if (previousRuntimeRoot === undefined) {
        delete process.env.KTX_RUNTIME_ROOT;
      } else {
        process.env.KTX_RUNTIME_ROOT = previousRuntimeRoot;
      }
    }

    expect(calls).toEqual(['agents']);
  });

  it('skips to agent setup when context is ready but agents are not configured', async () => {
    const calls: string[] = [];
    const io = makeIo();
    await writeFile(
      join(tempDir, 'ktx.yaml'),
      [
        'setup:',
        '  database_connection_ids: [warehouse]',
        'connections:',
        '  warehouse:',
        '    driver: postgres',
        '    url: env:DATABASE_URL',
        'llm:',
        '  provider:',
        '    backend: anthropic',
        '  models:',
        '    default: claude-sonnet-4-6',
        'ingest:',
        '  embeddings:',
        '    backend: openai',
        '    model: text-embedding-3-small',
        '    dimensions: 1536',
        '',
      ].join('\n'),
      'utf-8',
    );
    await writeKtxSetupState(tempDir, {
      completed_steps: ['project', 'llm', 'embeddings', 'databases', 'sources', 'context'],
    });
    await writeKtxSetupContextState(tempDir, {
      runId: 'setup-context-local-ready',
      status: 'completed',
      startedAt: '2026-05-09T10:00:00.000Z',
      updatedAt: '2026-05-09T10:02:00.000Z',
      completedAt: '2026-05-09T10:02:00.000Z',
      primarySourceConnectionIds: [],
      contextSourceConnectionIds: [],
      reportIds: [],
      artifactPaths: [],
      retryableFailedTargets: [],
      commands: contextBuildCommands(tempDir),
    });

    const readyMenuSelect = vi.fn();
    await expect(
      runKtxSetup(
        {
          command: 'run',
          projectDir: tempDir,
          mode: 'auto',
          agents: false,
          inputMode: 'auto',
          yes: false,
          cliVersion: '0.2.0',
          skipLlm: false,
          skipEmbeddings: false,
          skipDatabases: false,
          skipSources: false,
          skipAgents: false,
          databaseSchemas: [],
        },
        io.io,
        {
          readyMenuDeps: { prompts: { select: readyMenuSelect, cancel: vi.fn() } },
          model: async (args) => {
            expect(args.skipLlm).toBe(true);
            return { status: 'skipped', projectDir: tempDir };
          },
          embeddings: async (args) => {
            expect(args.skipEmbeddings).toBe(true);
            return { status: 'skipped', projectDir: tempDir };
          },
          databases: async (args) => {
            expect(args.skipDatabases).toBe(true);
            return { status: 'skipped', projectDir: tempDir };
          },
          sources: async (args) => {
            expect(args.skipSources).toBe(true);
            return { status: 'skipped', projectDir: tempDir };
          },
          runtime: async () => {
            calls.push('runtime');
            return runtimeReady(tempDir);
          },
          agents: async () => {
            calls.push('agents');
            return {
              status: 'ready',
              projectDir: tempDir,
              installs: [{ target: 'codex', scope: 'project', mode: 'mcp-cli', installRoot: tempDir }],
            };
          },
        },
      ),
    ).resolves.toBe(0);

    expect(readyMenuSelect).not.toHaveBeenCalled();
    expect(calls).toEqual(['agents']);
  });

  it('routes a returning user to the context build when config is ready but context is not built', async () => {
    const calls: string[] = [];
    const io = makeIo();
    await writeFile(
      join(tempDir, 'ktx.yaml'),
      [
        'setup:',
        '  database_connection_ids: [warehouse]',
        'connections:',
        '  warehouse:',
        '    driver: postgres',
        '    url: env:DATABASE_URL',
        'llm:',
        '  provider:',
        '    backend: anthropic',
        '  models:',
        '    default: claude-sonnet-4-6',
        'ingest:',
        '  embeddings:',
        '    backend: openai',
        '    model: text-embedding-3-small',
        '    dimensions: 1536',
        '',
      ].join('\n'),
      'utf-8',
    );
    await writeKtxSetupState(tempDir, {
      completed_steps: ['project', 'llm', 'embeddings', 'databases', 'sources', 'runtime'],
    });

    const readyMenuSelect = vi.fn();
    await expect(
      runKtxSetup(
        {
          command: 'run',
          projectDir: tempDir,
          mode: 'auto',
          agents: false,
          inputMode: 'auto',
          yes: false,
          cliVersion: '0.2.0',
          skipLlm: false,
          skipEmbeddings: false,
          skipDatabases: false,
          skipSources: false,
          skipAgents: false,
          databaseSchemas: [],
        },
        io.io,
        {
          readyMenuDeps: { prompts: { select: readyMenuSelect, cancel: vi.fn() } },
          model: async (args) => {
            expect(args.skipLlm).toBe(true);
            return { status: 'skipped', projectDir: tempDir };
          },
          embeddings: async (args) => {
            expect(args.skipEmbeddings).toBe(true);
            return { status: 'skipped', projectDir: tempDir };
          },
          databases: async (args) => {
            expect(args.skipDatabases).toBe(true);
            return { status: 'skipped', projectDir: tempDir };
          },
          sources: async (args) => {
            expect(args.skipSources).toBe(true);
            return { status: 'skipped', projectDir: tempDir };
          },
          runtime: async () => {
            calls.push('runtime');
            return runtimeReady(tempDir);
          },
          context: async (args) => {
            calls.push('context');
            expect(args.forcePrompt).toBe(true);
            return { status: 'skipped', projectDir: tempDir };
          },
          agents: async () => {
            calls.push('agents');
            return { status: 'ready', projectDir: tempDir, installs: [] };
          },
        },
      ),
    ).resolves.toBe(0);

    // Config is done, so the change-everything menu is not shown; setup routes straight
    // to the build prompt and never re-walks config or installs agents.
    expect(readyMenuSelect).not.toHaveBeenCalled();
    expect(calls).toContain('context');
    expect(calls).not.toContain('agents');
    const output = io.stdout();
    expect(output).toContain('Setup is complete. The only step left is to build context');
    expect(output).toContain('ktx ingest');
  });

  it('reaches the completion screen instead of a bare shell when the context build is skipped', async () => {
    const calls: string[] = [];
    const io = makeIo();
    await writeFile(
      join(tempDir, 'ktx.yaml'),
      [
        'setup:',
        '  database_connection_ids: [warehouse]',
        'connections:',
        '  warehouse:',
        '    driver: postgres',
        '    url: env:DATABASE_URL',
        'llm:',
        '  provider:',
        '    backend: anthropic',
        '  models:',
        '    default: claude-sonnet-4-6',
        'ingest:',
        '  embeddings:',
        '    backend: openai',
        '    model: text-embedding-3-small',
        '    dimensions: 1536',
        '',
      ].join('\n'),
      'utf-8',
    );
    await writeKtxSetupState(tempDir, {
      completed_steps: ['project', 'llm', 'embeddings', 'databases', 'sources', 'runtime'],
    });

    await expect(
      runKtxSetup(
        {
          command: 'run',
          projectDir: tempDir,
          mode: 'auto',
          agents: false,
          inputMode: 'disabled',
          yes: true,
          cliVersion: '0.2.0',
          skipLlm: true,
          skipEmbeddings: true,
          skipDatabases: true,
          skipSources: true,
          skipAgents: false,
          databaseSchemas: [],
        },
        io.io,
        {
          model: async () => ({ status: 'skipped', projectDir: tempDir }),
          embeddings: async () => ({ status: 'skipped', projectDir: tempDir }),
          databases: async () => ({ status: 'skipped', projectDir: tempDir }),
          sources: async () => ({ status: 'skipped', projectDir: tempDir }),
          runtime: async () => runtimeReady(tempDir),
          context: async () => ({ status: 'skipped', projectDir: tempDir }),
          agents: async () => {
            calls.push('agents');
            return { status: 'ready', projectDir: tempDir, installs: [] };
          },
        },
      ),
    ).resolves.toBe(0);

    // A skipped build must not install agents nor drop to a bare shell; the end screen
    // states readiness and points at `ktx ingest`.
    expect(calls).not.toContain('agents');
    const output = io.stdout();
    expect(output).toContain('Setup is complete. The only step left is to build context');
    expect(output).toContain('ktx ingest');
  });

  it('runs only project resolution and agent setup in --agents mode', async () => {
    const io = makeIo();
    const runtime = vi.fn(async () => runtimeReady(tempDir));
    const context = vi.fn(async () => ({ status: 'ready' as const, projectDir: tempDir, runId: 'setup-context-local-test' }));
    const agents = vi.fn(async () => ({
      status: 'ready' as const,
      projectDir: tempDir,
      installs: [{ target: 'universal' as const, scope: 'project' as const, mode: 'mcp-cli' as const, installRoot: tempDir }],
    }));

    await expect(
      runKtxSetup(
        {
          command: 'run',
          projectDir: tempDir,
          mode: 'auto',
          agents: true,
          target: 'universal',
          agentScope: 'project',
          inputMode: 'disabled',
          yes: true,
          cliVersion: '0.2.0',
          skipLlm: false,
          skipEmbeddings: false,
          skipDatabases: false,
          skipSources: false,
          skipAgents: false,
          databaseSchemas: [],
        },
        io.io,
        {
          model: async () => {
            throw new Error('model should not run');
          },
          runtime,
          context,
          agents,
        },
      ),
    ).resolves.toBe(0);

    expect(runtime).not.toHaveBeenCalled();
    expect(context).not.toHaveBeenCalled();
    expect(agents).toHaveBeenCalledTimes(1);
  });

  it('does not run embedding setup when the model step fails', async () => {
    const testIo = makeIo();
    const model = vi.fn(async () => ({ status: 'failed' as const, projectDir: tempDir }));
    const embeddings = vi.fn(async () => ({ status: 'ready' as const, projectDir: tempDir }));

    await expect(
      runKtxSetup(
        {
          command: 'run',
          projectDir: tempDir,
          mode: 'auto',
          agents: false,
          skipAgents: true,
          inputMode: 'disabled',
          yes: true,
          cliVersion: '0.2.0',
          anthropicApiKeyEnv: 'ANTHROPIC_API_KEY', // pragma: allowlist secret
          skipLlm: false,
          skipEmbeddings: false,
          databaseSchemas: [],
          skipDatabases: true,
        },
        testIo.io,
        { model, embeddings },
      ),
    ).resolves.toBe(1);

    expect(model).toHaveBeenCalledTimes(1);
    expect(embeddings).not.toHaveBeenCalled();
  });
});

describe('setupTerminalOutcome', () => {
  it('exits non-zero and reports a self-diagnosing error for a genuine step failure', () => {
    expect(setupTerminalOutcome({ status: 'failed', step: 'runtime', interactive: true })).toEqual({
      exitCode: 1,
      annotation: {
        outcome: 'error',
        errorClass: 'KtxSetupStepFailed',
        errorDetail: 'runtime setup step failed',
      },
    });
  });

  it('reuses a step-provided errorDetail for failures', () => {
    expect(
      setupTerminalOutcome({
        status: 'failed',
        step: 'sources',
        interactive: true,
        errorDetail: 'metabase source ingest failed',
      }),
    ).toEqual({
      exitCode: 1,
      annotation: {
        outcome: 'error',
        errorClass: 'KtxSetupStepFailed',
        errorDetail: 'metabase source ingest failed',
      },
    });
  });

  it('exits non-zero for missing input in a non-interactive run (an automation error)', () => {
    // Both `--no-input` and a piped/CI run without a TTY are non-interactive.
    expect(setupTerminalOutcome({ status: 'missing-input', step: 'models', interactive: false })).toEqual({
      exitCode: 1,
      annotation: {
        outcome: 'error',
        errorClass: 'KtxSetupMissingInput',
        errorDetail: 'models setup step requires input not provided in a non-interactive run',
      },
    });
  });

  it('exits zero and aborts (not errors) when the user leaves an interactive prompt', () => {
    expect(setupTerminalOutcome({ status: 'missing-input', step: 'models', interactive: true })).toEqual({
      exitCode: 0,
      annotation: { outcome: 'aborted' },
    });
  });

  it('exits zero and aborts on a project cancellation', () => {
    expect(setupTerminalOutcome({ status: 'cancelled', step: 'project', interactive: true })).toEqual({
      exitCode: 0,
      annotation: { outcome: 'aborted' },
    });
  });
});

describe('runKtxSetup command-span annotation', () => {
  let tempDir: string;

  beforeEach(async () => {
    tempDir = await mkdtemp(join(tmpdir(), 'ktx-setup-span-'));
  });

  afterEach(async () => {
    resetCommandSpan();
    await rm(tempDir, { recursive: true, force: true });
  });

  it('annotates the active command span with the step-failure reason on a non-throwing exit', async () => {
    resetCommandSpan();
    beginCommandSpan({
      commandPath: ['ktx', 'setup'],
      flagsPresent: {},
      hasProject: false,
      attachProjectGroup: true,
      startedAt: 0,
    });
    const testIo = makeIo();

    await expect(
      runKtxSetup(
        {
          command: 'run',
          projectDir: tempDir,
          mode: 'auto',
          agents: false,
          skipAgents: true,
          inputMode: 'disabled',
          yes: true,
          cliVersion: '0.2.0',
          skipLlm: true,
          skipEmbeddings: true,
          databaseSchemas: [],
          skipDatabases: true,
          skipSources: true,
        },
        testIo.io,
        {
          model: async () => ({ status: 'skipped', projectDir: tempDir }),
          embeddings: async () => ({ status: 'skipped', projectDir: tempDir }),
          databases: async () => ({ status: 'skipped', projectDir: tempDir }),
          sources: async () => ({ status: 'skipped', projectDir: tempDir }),
          runtime: async () => ({
            status: 'failed',
            projectDir: tempDir,
            requirements: { features: ['core'], requirements: [] },
          }),
        },
      ),
    ).resolves.toBe(1);

    // The wrapper would derive a blank 'error' from the non-zero exit; the
    // annotation supplies the actionable reason instead.
    const completed = completeCommandSpan({ completedAt: 1, outcome: 'error' });
    expect(completed?.outcome).toBe('error');
    expect(completed?.errorClass).toBe('KtxSetupStepFailed');
    expect(completed?.errorDetail).toBe('runtime setup step failed');
  });

  it('exits zero and marks the span aborted when the user abandons an interactive step', async () => {
    resetCommandSpan();
    beginCommandSpan({
      commandPath: ['ktx', 'setup'],
      flagsPresent: {},
      hasProject: true,
      attachProjectGroup: true,
      startedAt: 0,
    });
    await writeFile(join(tempDir, 'ktx.yaml'), 'connections: {}\n', 'utf-8');
    // A real interactive session: input enabled AND a TTY attached.
    const testIo = makeIo(true);

    await expect(
      runKtxSetup(
        {
          command: 'run',
          projectDir: tempDir,
          mode: 'auto',
          agents: false,
          agentScope: 'project',
          skipAgents: true,
          inputMode: 'auto',
          yes: false,
          cliVersion: '0.2.0',
          skipLlm: true,
          skipEmbeddings: false,
          databaseSchemas: [],
          skipDatabases: true,
          skipSources: true,
        },
        testIo.io,
        {
          // The user backs out of the embeddings prompt (interactive
          // missing-input). That is an abort, not a failure.
          embeddings: async () => ({ status: 'missing-input', projectDir: tempDir }),
        },
      ),
    ).resolves.toBe(0);

    const completed = completeCommandSpan({ completedAt: 1, outcome: 'error' });
    expect(completed?.outcome).toBe('aborted');
    expect(completed?.errorClass).toBeUndefined();
    expect(completed?.errorDetail).toBeUndefined();
  });

  it('exits non-zero with a reason when input is missing in a non-TTY run (no --no-input)', async () => {
    resetCommandSpan();
    beginCommandSpan({
      commandPath: ['ktx', 'setup'],
      flagsPresent: {},
      hasProject: true,
      attachProjectGroup: true,
      startedAt: 0,
    });
    await writeFile(join(tempDir, 'ktx.yaml'), 'connections: {}\n', 'utf-8');
    // `inputMode: 'auto'` but NO TTY — a piped/CI run that never prompted. The
    // step's missing-input is an automation error, not a user abort, so it must
    // exit non-zero rather than report an aborted "success".
    const testIo = makeIo(false);

    await expect(
      runKtxSetup(
        {
          command: 'run',
          projectDir: tempDir,
          mode: 'auto',
          agents: false,
          agentScope: 'project',
          skipAgents: true,
          inputMode: 'auto',
          yes: false,
          cliVersion: '0.2.0',
          skipLlm: true,
          skipEmbeddings: false,
          databaseSchemas: [],
          skipDatabases: true,
          skipSources: true,
        },
        testIo.io,
        {
          embeddings: async () => ({ status: 'missing-input', projectDir: tempDir }),
        },
      ),
    ).resolves.toBe(1);

    const completed = completeCommandSpan({ completedAt: 1, outcome: 'error' });
    expect(completed?.outcome).toBe('error');
    expect(completed?.errorClass).toBe('KtxSetupMissingInput');
    expect(completed?.errorDetail).toBe('embeddings setup step requires input not provided in a non-interactive run');
  });
});
