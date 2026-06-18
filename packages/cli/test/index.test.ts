import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { createRequire } from 'node:module';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { initKtxProject } from '../src/context/project/project.js';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import {
  getKtxCliPackageInfo,
  packageInfoFromJson,
  rendererUnavailableVizFallback,
  renderMemoryFlowTui,
  resolveVizFallback,
  runKtxCli,
  sanitizeMemoryFlowTuiError,
  startLiveMemoryFlowTui,
  warnVizFallbackOnce,
} from '../src/index.js';

const require = createRequire(import.meta.url);

const cliPackageJson = require('@kaelio/ktx/package.json') as { name: string; version: string };
const cliVersion = cliPackageJson.version;

function makeIo(options: { stdoutIsTty?: boolean } = {}) {
  let stdout = '';
  let stderr = '';
  return {
    io: {
      stdout: {
        isTTY: options.stdoutIsTty,
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

describe('getKtxCliPackageInfo', () => {
  it('identifies the CLI package', () => {
    expect(getKtxCliPackageInfo()).toEqual({
      name: '@kaelio/ktx',
      version: cliVersion,
    });
  });

  it('exports package metadata for package managers and runtime diagnostics', () => {
    const packageJson = require('@kaelio/ktx/package.json') as { name: string; version: string };

    expect(packageJson).toMatchObject({
      name: '@kaelio/ktx',
      version: cliVersion,
    });
    expect(cliVersion).toMatch(/^\d+\.\d+\.\d+/);
  });

  it('normalizes public package metadata from package.json contents', () => {
    expect(
      packageInfoFromJson({
        name: '@kaelio/ktx',
        version: '0.1.0',
      }),
    ).toEqual({
      name: '@kaelio/ktx',
      version: '0.1.0',
    });
  });
});

describe('memory-flow renderer exports', () => {
  it('exports runtime-agnostic renderer entry points for hosted terminal clients', () => {
    expect(renderMemoryFlowTui).toBeTypeOf('function');
    expect(startLiveMemoryFlowTui).toBeTypeOf('function');
    expect(sanitizeMemoryFlowTuiError('token=abc123')).toBe('[redacted]');
  });

  it('exports shared visualization fallback helpers for hosted terminal clients', () => {
    const fallback = resolveVizFallback({ stdout: { isTTY: true }, stderr: { write: vi.fn() } }, { TERM: 'dumb' });

    expect(fallback).toEqual({
      shouldDegrade: true,
      reason: 'term-dumb',
      message: 'TERM=dumb does not support the visual renderer',
    });
    expect(rendererUnavailableVizFallback()).toEqual({
      shouldDegrade: true,
      reason: 'renderer-unavailable',
      message: 'the terminal renderer is unavailable',
    });
    expect(warnVizFallbackOnce).toBeTypeOf('function');
  });
});

describe('runKtxCli', () => {
  let tempDir: string;

  beforeEach(async () => {
    tempDir = await mkdtemp(join(tmpdir(), 'ktx-cli-'));
    await writeFile(join(tempDir, 'ktx.yaml'), '{}\n', 'utf-8');
  });

  afterEach(async () => {
    await rm(tempDir, { recursive: true, force: true });
  });

  it('prints version information', async () => {
    const testIo = makeIo();

    await expect(runKtxCli(['--version'], testIo.io)).resolves.toBe(0);

    expect(testIo.stdout()).toBe(`@kaelio/ktx ${cliVersion}\n`);
    expect(testIo.stderr()).toBe('');
  });

  it('prints the public command surface in root help', async () => {
    const testIo = makeIo();

    await expect(runKtxCli(['--help'], testIo.io)).resolves.toBe(0);

    expect(testIo.stdout()).toContain('Usage: ktx [options] [command]');
    expect(testIo.stdout()).toContain('ktx data agent context layer CLI');
    for (const command of ['setup', 'connection', 'ingest', 'wiki', 'sl', 'status', 'admin']) {
      expect(testIo.stdout()).toContain(`${command}`);
    }
    expect(testIo.stdout()).not.toMatch(/^  dev\s/m);
    expect(testIo.stdout()).not.toMatch(/^  scan\s/m);
    for (const removed of ['demo', 'init', 'connect', 'ask', 'knowledge', 'agent', 'serve']) {
      expect(testIo.stdout()).not.toMatch(new RegExp(`^\\s+${removed}(?:\\s|\\[|$)`, 'm'));
    }
    // `completion` is a public command; the internal `__complete` helper is hidden.
    expect(testIo.stdout()).toMatch(/^\s+completion <shell>/m);
    expect(testIo.stdout()).not.toContain('__complete');
    expect(testIo.stdout()).toContain('--project-dir <path>');
    expect(testIo.stdout()).toContain('KTX_PROJECT_DIR');
    expect(testIo.stdout()).toContain('--debug');
    expect(testIo.stdout()).not.toContain('--' + 'verbose');
    expect(testIo.stdout()).not.toContain('Advanced:');
    expect(testIo.stderr()).toBe('');
  });

  it('routes supported public wiki commands', async () => {
    const knowledge = vi.fn(async () => 0);

    const listIo = makeIo();
    await expect(runKtxCli(['--project-dir', tempDir, 'wiki', '--json'], listIo.io, { knowledge }))
      .resolves.toBe(0);
    expect(knowledge).toHaveBeenCalledWith(
      expect.objectContaining({
        command: 'list',
        projectDir: tempDir,
        userId: 'local',
        json: true,
      }),
      listIo.io,
    );

    const searchIo = makeIo();
    await expect(
      runKtxCli(['--project-dir', tempDir, 'wiki', 'revenue', '--limit', '5'], searchIo.io, { knowledge }),
    ).resolves.toBe(0);
    expect(knowledge).toHaveBeenLastCalledWith(
      expect.objectContaining({
        command: 'search',
        projectDir: tempDir,
        query: 'revenue',
        userId: 'local',
        json: false,
        limit: 5,
      }),
      searchIo.io,
    );

    const debugSearchIo = makeIo();
    await expect(
      runKtxCli(['--project-dir', tempDir, '--debug', 'wiki', 'revenue'], debugSearchIo.io, { knowledge }),
    ).resolves.toBe(0);
    expect(knowledge).toHaveBeenLastCalledWith(
      expect.objectContaining({
        command: 'search',
        projectDir: tempDir,
        query: 'revenue',
        userId: 'local',
        json: false,
        debug: true,
      }),
      debugSearchIo.io,
    );

    const multiWordIo = makeIo();
    await expect(
      runKtxCli(['--project-dir', tempDir, 'wiki', 'revenue', 'policy'], multiWordIo.io, { knowledge }),
    ).resolves.toBe(0);
    expect(knowledge).toHaveBeenLastCalledWith(
      expect.objectContaining({
        command: 'search',
        projectDir: tempDir,
        query: 'revenue policy',
        userId: 'local',
        json: false,
      }),
      multiWordIo.io,
    );
  });

  it('rejects unknown write-style flags on the flattened wiki and sl commands', async () => {
    const knowledge = vi.fn(async () => 0);
    const sl = vi.fn(async () => 0);

    const wikiIo = makeIo();
    await expect(
      runKtxCli(
        ['--project-dir', tempDir, 'wiki', 'revenue', '--summary', 'Revenue', '--content', 'Revenue.'],
        wikiIo.io,
        { knowledge },
      ),
    ).resolves.toBe(1);
    expect(wikiIo.stderr()).toMatch(/unknown option|error:/);
    expect(knowledge).not.toHaveBeenCalled();

    const slIo = makeIo();
    await expect(
      runKtxCli(
        ['--project-dir', tempDir, 'sl', 'orders', '--yaml', 'name: orders'],
        slIo.io,
        { sl },
      ),
    ).resolves.toBe(1);
    expect(slIo.stderr()).toMatch(/unknown option|error:/);
    expect(sl).not.toHaveBeenCalled();
  });

  it('routes sl search via the flattened query positional and rejects unknown flags', async () => {
    const sl = vi.fn(async () => 0);

    const searchIo = makeIo();
    await expect(
      runKtxCli(
        ['--project-dir', tempDir, 'sl', 'revenue', '--connection-id', 'warehouse', '--limit', '5', '--json'],
        searchIo.io,
        { sl },
      ),
    ).resolves.toBe(0);
    expect(sl).toHaveBeenCalledWith(
      expect.objectContaining({
        command: 'search',
        projectDir: tempDir,
        connectionId: 'warehouse',
        query: 'revenue',
        limit: 5,
        json: true,
        output: undefined,
      }),
      searchIo.io,
    );

    const bareIo = makeIo();
    await expect(
      runKtxCli(['--project-dir', tempDir, 'sl', '--connection-id', 'warehouse', '--json'], bareIo.io, { sl }),
    ).resolves.toBe(0);
    expect(sl).toHaveBeenLastCalledWith(
      expect.objectContaining({
        command: 'list',
        projectDir: tempDir,
        connectionId: 'warehouse',
        json: true,
        output: undefined,
      }),
      bareIo.io,
    );

    const unknownIo = makeIo();
    await expect(
      runKtxCli(['--project-dir', tempDir, 'sl', '--query', 'revenue'], unknownIo.io, { sl }),
    ).resolves.toBe(1);
    expect(unknownIo.stderr()).toContain("unknown option '--query'");
  });

  it('routes runtime management commands with the CLI package version', async () => {
    const runtime = vi.fn(async () => 0);
    const installIo = makeIo();
    const startIo = makeIo();
    const stopIo = makeIo();
    const stopAllIo = makeIo();
    const statusIo = makeIo();
    const pruneIo = makeIo();

    await expect(
      runKtxCli(['admin', 'runtime', 'install', '--feature', 'local-embeddings', '--force', '--yes'], installIo.io, {
        runtime,
      }),
    ).resolves.toBe(0);
    await expect(
      runKtxCli(['admin', 'runtime', 'start', '--feature', 'local-embeddings', '--force'], startIo.io, { runtime }),
    ).resolves.toBe(0);
    await expect(runKtxCli(['admin', 'runtime', 'stop'], stopIo.io, { runtime })).resolves.toBe(0);
    await expect(runKtxCli(['admin', 'runtime', 'stop', '--all'], stopAllIo.io, { runtime })).resolves.toBe(0);
    await expect(runKtxCli(['admin', 'runtime', 'status', '--json'], statusIo.io, { runtime })).resolves.toBe(0);
    await expect(runKtxCli(['admin', 'runtime', 'prune', '--dry-run'], pruneIo.io, { runtime })).resolves.toBe(1);

    expect(runtime).toHaveBeenNthCalledWith(
      1,
      {
        command: 'install',
        cliVersion,
        feature: 'local-embeddings',
        force: true,
      },
      installIo.io,
    );
    expect(runtime).toHaveBeenNthCalledWith(
      2,
      {
        command: 'start',
        cliVersion,
        projectDir: expect.any(String),
        feature: 'local-embeddings',
        force: true,
      },
      startIo.io,
    );
    expect(runtime).toHaveBeenNthCalledWith(
      3,
      {
        command: 'stop',
        cliVersion,
        projectDir: expect.any(String),
        all: false,
      },
      stopIo.io,
    );
    expect(runtime).toHaveBeenNthCalledWith(
      4,
      {
        command: 'stop',
        cliVersion,
        projectDir: expect.any(String),
        all: true,
      },
      stopAllIo.io,
    );
    expect(runtime).toHaveBeenNthCalledWith(
      5,
      {
        command: 'status',
        cliVersion,
        json: true,
      },
      statusIo.io,
    );
    expect(runtime).toHaveBeenCalledTimes(5);
    for (const io of [installIo, startIo, stopIo, stopAllIo, statusIo]) {
      expect(io.stderr()).toBe('');
    }
    expect(pruneIo.stderr()).toMatch(/unknown command|error:/);
  });

  it('prints the resolved project directory for ordinary project commands', async () => {
    const connection = vi.fn(async () => 0);
    const testIo = makeIo();

    await expect(runKtxCli(['--project-dir', tempDir, 'connection', 'list'], testIo.io, { connection })).resolves.toBe(
      0,
    );

    expect(connection).toHaveBeenCalledWith({ command: 'list', projectDir: tempDir }, testIo.io);
    expect(testIo.stderr()).toBe(`Project: ${tempDir}\n`);
  });

  it('does not print the command-level project directory line for setup', async () => {
    const setup = vi.fn(async () => 0);
    const testIo = makeIo();

    await expect(runKtxCli(['--project-dir', tempDir, 'setup', '--no-input'], testIo.io, { setup })).resolves.toBe(0);

    expect(setup).toHaveBeenCalledWith(
      expect.objectContaining({
        command: 'run',
        projectDir: tempDir,
      }),
      testIo.io,
    );
    expect(testIo.stderr()).toBe('');
  });

  it('skips the project directory line for JSON output mode', async () => {
    const publicIngest = vi.fn(async () => 0);
    const jsonIo = makeIo();

    await expect(
      runKtxCli(['--project-dir', tempDir, 'ingest', 'warehouse', '--json'], jsonIo.io, { publicIngest }),
    ).resolves.toBe(0);

    expect(jsonIo.stderr()).toBe('');
  });

  it('documents runtime stop all in command help', async () => {
    const testIo = makeIo();

    await expect(runKtxCli(['admin', 'runtime', 'stop', '--help'], testIo.io)).resolves.toBe(0);

    expect(testIo.stdout()).toContain('--all');
    expect(testIo.stdout()).toContain('Stop all ktx daemon processes recorded or discoverable');
    expect(testIo.stdout()).toContain('on this machine');
    expect(testIo.stderr()).toBe('');
  });

  it('routes sl query managed runtime install policies', async () => {
    const sl = vi.fn(async () => 0);

    const promptIo = makeIo();
    await expect(
      runKtxCli(
        ['--project-dir', tempDir, 'sl', 'query', '--connection-id', 'warehouse', '--measure', 'orders.order_count'],
        promptIo.io,
        { sl },
      ),
    ).resolves.toBe(0);
    expect(sl).toHaveBeenLastCalledWith(
      expect.objectContaining({
        command: 'query',
        projectDir: tempDir,
        connectionId: 'warehouse',
        cliVersion,
        runtimeInstallPolicy: 'prompt',
        query: expect.objectContaining({ measures: ['orders.order_count'], dimensions: [] }),
      }),
      promptIo.io,
    );

    const autoIo = makeIo();
    await expect(
      runKtxCli(
        [
          '--project-dir',
          tempDir,
          'sl',
          'query',
          '--connection-id',
          'warehouse',
          '--measure',
          'orders.order_count',
          '--yes',
        ],
        autoIo.io,
        { sl },
      ),
    ).resolves.toBe(0);
    expect(sl).toHaveBeenLastCalledWith(
      expect.objectContaining({
        cliVersion,
        runtimeInstallPolicy: 'auto',
      }),
      autoIo.io,
    );

    const noInputIo = makeIo();
    await expect(
      runKtxCli(
        [
          '--project-dir',
          tempDir,
          'sl',
          'query',
          '--connection-id',
          'warehouse',
          '--measure',
          'orders.order_count',
          '--no-input',
        ],
        noInputIo.io,
        { sl },
      ),
    ).resolves.toBe(0);
    expect(sl).toHaveBeenLastCalledWith(
      expect.objectContaining({
        cliVersion,
        runtimeInstallPolicy: 'never',
      }),
      noInputIo.io,
    );
  });

  it('rejects conflicting sl query runtime install flags', async () => {
    const io = makeIo();
    const sl = vi.fn(async () => 0);

    await expect(
      runKtxCli(
        [
          '--project-dir',
          tempDir,
          'sl',
          'query',
          '--connection-id',
          'warehouse',
          '--measure',
          'orders.order_count',
          '--yes',
          '--no-input',
        ],
        io.io,
        { sl },
      ),
    ).resolves.toBe(1);

    expect(sl).not.toHaveBeenCalled();
    expect(io.stderr()).toContain('Choose only one runtime install mode: --yes or --no-input');
  });

  it('documents setup with only the common interactive options visible', async () => {
    const testIo = makeIo();

    await expect(runKtxCli(['setup', '--help'], testIo.io)).resolves.toBe(0);

    const stdout = testIo.stdout();
    expect(stdout).toContain('Usage: ktx setup [options]');
    expect(stdout).toContain('--agents');
    expect(stdout).toContain('--target <target>');
    expect(stdout).toContain('--global');
    expect(stdout).toContain('--local');
    expect(stdout).toContain('--install-dir <path>');
    expect(stdout).toContain('--yes');
    expect(stdout).toContain('--no-input');
    expect(stdout).toContain('Global Options:');
    expect(stdout.match(/--project-dir <path>/g)).toHaveLength(1);
    expect(stdout).not.toContain('Commands:');
    expect(stdout).not.toContain('setup demo');
    expect(stdout).not.toContain('setup context');

    for (const hiddenFlag of [
      '--agent-scope',
      '--skip-agents',
      '--llm-backend',
      '--anthropic-api-key-env',
      '--vertex-project',
      '--embedding-backend',
      '--database ',
      '--database-connection-id',
      '--enable-historic-sql',
      '--historic-sql-min-executions',
      '--enable-query-history',
      '--disable-query-history',
      '--query-history-window-days',
      '--query-history-min-executions',
      '--query-history-service-account-pattern',
      '--query-history-redaction-pattern',
      '--skip-databases',
      '--source ',
      '--source-connection-id',
      '--metabase-database-id',
      '--notion-root-page-id',
      '--skip-initial-source-ingest',
      '--skip-sources',
      '--skip-llm',
      '--skip-embeddings',
      '--embedding-model',
      '--embedding-dimensions',
      '--embedding-base-url',
    ]) {
      expect(stdout).not.toContain(hiddenFlag);
    }
    expect(stdout).not.toMatch(/^  --project\s/m);
    expect(stdout).not.toContain('primary ' + 'source');
    expect(stdout).not.toContain('primary ' + 'sources');
    expect(testIo.stderr()).toBe('');
  });

  it('prints help for bare ktx outside a TTY', async () => {
    const setup = vi.fn(async () => 0);
    const testIo = makeIo({ stdoutIsTty: false });

    await expect(runKtxCli([], testIo.io, { setup })).resolves.toBe(0);

    expect(testIo.stdout()).toContain('Usage: ktx [options] [command]');
    expect(setup).not.toHaveBeenCalled();
    expect(testIo.stderr()).toBe('');
  });

  it('keeps representative JSON command stdout parseable', async () => {
    const projectDir = join(tempDir, 'project');
    await initKtxProject({ projectDir });
    const commands = [
      ['--project-dir', projectDir, 'status', '--json'],
      ['--project-dir', projectDir, 'sl', '--json'],
    ];

    for (const argv of commands) {
      const testIo = makeIo();
      const code = await runKtxCli(argv, testIo.io);
      expect([0, 1]).toContain(code);

      expect(() => JSON.parse(testIo.stdout())).not.toThrow();
      expect(testIo.stderr()).toBe('');
    }
  });

  it('starts setup for bare ktx in a TTY when no project is discoverable', async () => {
    const { mkdtemp, realpath, rm } = await import('node:fs/promises');
    const { tmpdir } = await import('node:os');
    const { join } = await import('node:path');
    const originalCwd = process.cwd();
    const tempDir = await mkdtemp(join(tmpdir(), 'ktx-bare-setup-'));
    const setup = vi.fn(async () => 0);
    const testIo = makeIo({ stdoutIsTty: true });
    const previousProjectDir = process.env.KTX_PROJECT_DIR;
    const expectedProjectDir = await realpath(tempDir);

    try {
      delete process.env.KTX_PROJECT_DIR;
      process.chdir(tempDir);

      await expect(runKtxCli([], testIo.io, { setup })).resolves.toBe(0);

      expect(setup).toHaveBeenCalledWith(
        {
          command: 'run',
          projectDir: expectedProjectDir,
          mode: 'auto',
          agents: false,
          agentScope: 'project',
          skipAgents: false,
          inputMode: 'auto',
          yes: false,
          cliVersion,
          skipLlm: false,
          skipEmbeddings: false,
          databaseSchemas: [],
          skipDatabases: false,
          skipSources: false,
        },
        testIo.io,
      );
      expect(testIo.stdout()).not.toContain('Usage: ktx [options] [command]');
      expect(testIo.stderr()).toBe('');
    } finally {
      process.chdir(originalCwd);
      if (previousProjectDir === undefined) {
        delete process.env.KTX_PROJECT_DIR;
      } else {
        process.env.KTX_PROJECT_DIR = previousProjectDir;
      }
      await rm(tempDir, { recursive: true, force: true });
    }
  });

  it('prints help without project status for bare ktx in a TTY when a project is discoverable', async () => {
    const { mkdtemp, realpath, rm, writeFile } = await import('node:fs/promises');
    const { tmpdir } = await import('node:os');
    const { join } = await import('node:path');
    const originalCwd = process.cwd();
    const previousProjectDir = process.env.KTX_PROJECT_DIR;
    const tempDir = await mkdtemp(join(tmpdir(), 'ktx-bare-existing-'));
    const setup = vi.fn(async () => 0);
    const testIo = makeIo({ stdoutIsTty: true });
    const expectedProjectDir = await realpath(tempDir);

    try {
      delete process.env.KTX_PROJECT_DIR;
      await writeFile(join(tempDir, 'ktx.yaml'), 'connections: {}\n', 'utf-8');
      process.chdir(tempDir);

      await expect(runKtxCli([], testIo.io, { setup })).resolves.toBe(0);

      expect(testIo.stdout()).toContain('Usage: ktx [options] [command]');
      expect(testIo.stdout()).not.toContain(`Project: ${expectedProjectDir}`);
      expect(setup).not.toHaveBeenCalled();
    } finally {
      process.chdir(originalCwd);
      if (previousProjectDir === undefined) {
        delete process.env.KTX_PROJECT_DIR;
      } else {
        process.env.KTX_PROJECT_DIR = previousProjectDir;
      }
      await rm(tempDir, { recursive: true, force: true });
    }
  });

  it('does not invoke status for bare ktx in a TTY when status would fail', async () => {
    const setup = vi.fn(async () => {
      throw new Error('Unsupported ingest.llm: use top-level llm.provider, llm.models, and ingest.workUnits');
    });
    const testIo = makeIo({ stdoutIsTty: true });
    const previousProjectDir = process.env.KTX_PROJECT_DIR;

    try {
      process.env.KTX_PROJECT_DIR = tempDir;

      await expect(runKtxCli([], testIo.io, { setup })).resolves.toBe(0);

      expect(testIo.stdout()).toContain('Usage: ktx [options] [command]');
      expect(setup).not.toHaveBeenCalled();
      expect(testIo.stderr()).toBe('');
    } finally {
      if (previousProjectDir === undefined) {
        delete process.env.KTX_PROJECT_DIR;
      } else {
        process.env.KTX_PROJECT_DIR = previousProjectDir;
      }
    }
  });

  it('rejects removed verbose global option through Commander', async () => {
    const testIo = makeIo();
    const removedVerboseOption = '--' + 'verbose';

    await expect(runKtxCli([removedVerboseOption, 'connection', 'list'], testIo.io)).resolves.toBe(1);

    expect(testIo.stderr()).toContain(`unknown option '${removedVerboseOption}'`);
    expect(testIo.stdout()).toBe('');
  });

  it('rejects removed shell completion commands', async () => {
    const completionIo = makeIo();
    const hiddenIo = makeIo();

    await expect(runKtxCli(['admin', 'completion', 'zsh'], completionIo.io)).resolves.toBe(1);
    await expect(
      runKtxCli(['admin', '__complete', '--shell', 'zsh', '--position', '2', '--', 'ktx', 'co'], hiddenIo.io),
    ).resolves.toBe(1);

    expect(completionIo.stderr()).toMatch(/unknown command|error:/);
    expect(hiddenIo.stderr()).toMatch(/unknown command|error:/);
  });

  it('rejects removed serve commands', async () => {
    const testIo = makeIo();

    await expect(runKtxCli(['--project-dir', tempDir, 'serve', '--mcp', 'stdio', '--user-id', 'agent'], testIo.io))
      .resolves.toBe(1);

    expect(testIo.stderr()).toMatch(/unknown command|error:/);
  });

  it('routes public connection-centric ingest shorthand', async () => {
    const testIo = makeIo();
    const publicIngest = vi.fn().mockResolvedValue(0);

    await expect(
      runKtxCli(['--project-dir', tempDir, 'ingest', 'warehouse', '--no-input'], testIo.io, {
        publicIngest,
      }),
    ).resolves.toBe(0);

    expect(publicIngest).toHaveBeenCalledWith(
      {
        command: 'run',
        projectDir: tempDir,
        targetConnectionId: 'warehouse',
        all: false,
        json: false,
        inputMode: 'disabled',
        queryHistory: 'default',
        cliVersion,
        runtimeInstallPolicy: 'never',
      },
      testIo.io,
    );
    expect(testIo.stderr()).toBe(`Project: ${tempDir}\n`);
  });

  it('routes public ingest --all with JSON output', async () => {
    const testIo = makeIo();
    const publicIngest = vi.fn().mockResolvedValue(0);

    await expect(
      runKtxCli(['--project-dir', tempDir, 'ingest', '--all', '--json'], testIo.io, {
        publicIngest,
      }),
    ).resolves.toBe(0);

    expect(publicIngest).toHaveBeenCalledWith(
      {
        command: 'run',
        projectDir: tempDir,
        all: true,
        json: true,
        inputMode: 'auto',
        queryHistory: 'default',
        cliVersion,
        runtimeInstallPolicy: 'prompt',
      },
      testIo.io,
    );
    expect(testIo.stderr()).toBe('');
  });

  it('routes public ingest --yes as automatic runtime installation', async () => {
    const testIo = makeIo();
    const publicIngest = vi.fn().mockResolvedValue(0);

    await expect(
      runKtxCli(['--project-dir', tempDir, 'ingest', 'warehouse', '--yes'], testIo.io, {
        publicIngest,
      }),
    ).resolves.toBe(0);

    expect(publicIngest).toHaveBeenCalledWith(
      expect.objectContaining({
        projectDir: tempDir,
        targetConnectionId: 'warehouse',
        runtimeInstallPolicy: 'auto',
      }),
      testIo.io,
    );
  });

  it('rejects conflicting public ingest runtime install modes', async () => {
    const testIo = makeIo();
    const publicIngest = vi.fn().mockResolvedValue(0);

    await expect(
      runKtxCli(['--project-dir', tempDir, 'ingest', 'warehouse', '--yes', '--no-input'], testIo.io, {
        publicIngest,
      }),
    ).resolves.toBe(1);

    expect(publicIngest).not.toHaveBeenCalled();
    expect(testIo.stderr()).toContain('Choose only one runtime install mode: --yes or --no-input');
  });

  it.each(['run', 'status', 'watch', 'replay'])(
    'routes former ingest subcommand name "%s" as a connection id',
    async (connectionId) => {
      const testIo = makeIo();
      const publicIngest = vi.fn(async () => 0);

      await expect(
        runKtxCli(['--project-dir', tempDir, 'ingest', connectionId, '--no-input'], testIo.io, {
          publicIngest,
        }),
      ).resolves.toBe(0);

      expect(publicIngest).toHaveBeenCalledWith(
        {
          command: 'run',
          projectDir: tempDir,
          targetConnectionId: connectionId,
          all: false,
          json: false,
          inputMode: 'disabled',
          queryHistory: 'default',
          cliVersion,
          runtimeInstallPolicy: 'never',
        },
        testIo.io,
      );
    },
  );

  it('rejects standalone demo commands', async () => {
    const testIo = makeIo();

    await expect(runKtxCli(['demo', '--mode', 'replay', '--no-input'], testIo.io)).resolves.toBe(1);

    expect(testIo.stderr()).toMatch(/unknown command|error:/i);
  });

  it('rejects removed setup subcommands', async () => {
    const setup = vi.fn(async () => 0);
    const cases = [
      ['setup', 'demo', '--mode', 'replay', '--no-input'],
      ['setup', '--no-input', 'demo', '--mode', 'seeded'],
      ['setup', 'demo', 'ingest', '--mode', 'full', '--no-input'],
      ['setup', 'context', 'build'],
      ['setup', 'context', 'watch', 'setup-context-local-1'],
      ['setup', 'context', 'status', 'setup-context-local-1', '--json'],
      ['setup', 'context', 'stop', 'setup-context-local-1'],
      ['setup', 'remove', '--agents'],
      ['setup', 'status', '--json'],
    ];

    for (const args of cases) {
      const testIo = makeIo();
      await expect(runKtxCli(['--project-dir', tempDir, ...args], testIo.io, { setup })).resolves.toBe(1);
      expect(testIo.stderr()).toMatch(/unknown command|error:/i);
    }

    expect(setup).not.toHaveBeenCalled();
  });

  it('rejects removed setup options', async () => {
    const setup = vi.fn(async () => 0);
    const cases = [
      ['setup', '--new'],
      ['setup', '--existing'],
      ['setup', '--project'],
      ['setup', '--agent-scope', 'global'],
      ['setup', '--anthropic-model', 'claude-sonnet-4-6'],
      ['setup', '--new-database-connection-id', 'warehouse'],
      ['setup', '--skip-initial-source-ingest'],
    ];

    for (const args of cases) {
      const testIo = makeIo();
      await expect(runKtxCli(['--project-dir', tempDir, ...args], testIo.io, { setup })).resolves.toBe(1);
      expect(testIo.stderr()).toMatch(/unknown option|error:/i);
    }

    expect(setup).not.toHaveBeenCalled();
  });

  it('prints ingest help without invoking ingest execution', async () => {
    const testIo = makeIo();
    const publicIngest = vi.fn();

    await expect(runKtxCli(['ingest', '--help'], testIo.io, { publicIngest })).resolves.toBe(0);

    expect(testIo.stdout()).toContain('Usage: ktx ingest');
    expect(testIo.stdout()).toContain('Build or inspect ktx context');
    expect(testIo.stdout()).toContain('--all');
    expect(testIo.stdout()).toContain('--query-history');
    expect(testIo.stdout()).toContain('--no-query-history');
    expect(testIo.stdout()).toContain('--query-history-window-days <days>');
    expect(testIo.stdout()).toContain('--text');
    expect(testIo.stdout()).toContain('--file');
    expect(testIo.stdout()).not.toMatch(/^  status\s/m);
    expect(testIo.stdout()).not.toMatch(/^  replay\s/m);
    expect(testIo.stdout()).not.toMatch(/^  run\s/m);
    expect(testIo.stdout()).not.toMatch(/^  watch\s/m);
    expect(testIo.stdout()).not.toContain('--manifest');
    expect(testIo.stderr()).toBe('');
    expect(publicIngest).not.toHaveBeenCalled();
  });

  it('routes text memory ingest through Commander without exposing chat ids', async () => {
    const textIngest = vi.fn(async () => 0);
    const testIo = makeIo();

    await expect(
      runKtxCli(
        [
          '--project-dir',
          tempDir,
          'ingest',
          '--text',
          'Revenue means gross receipts.',
          '--text',
          'Orders are completed purchases.',
          '--connection-id',
          'warehouse',
          '--user-id',
          'agent',
          '--json',
          '--fail-fast',
        ],
        testIo.io,
        { textIngest },
      ),
    ).resolves.toBe(0);

    expect(textIngest).toHaveBeenCalledWith(
      {
        projectDir: tempDir,
        texts: ['Revenue means gross receipts.', 'Orders are completed purchases.'],
        files: [],
        connectionId: 'warehouse',
        userId: 'agent',
        json: true,
        failFast: true,
      },
      testIo.io,
    );
    expect(testIo.stderr()).toBe('');
  });

  it('rejects a positional connection id when --text is supplied', async () => {
    const textIngest = vi.fn(async () => 0);
    const publicIngest = vi.fn(async () => 0);
    const testIo = makeIo();

    await expect(
      runKtxCli(
        ['--project-dir', tempDir, 'ingest', 'warehouse', '--text', 'hello'],
        testIo.io,
        { textIngest, publicIngest },
      ),
    ).resolves.toBe(1);

    expect(textIngest).not.toHaveBeenCalled();
    expect(publicIngest).not.toHaveBeenCalled();
    expect(testIo.stderr()).toMatch(/--text\/--file does not accept a positional connection id/);
  });

  it('treats bare ingest as ingest --all', async () => {
    const publicIngest = vi.fn().mockResolvedValue(0);
    const testIo = makeIo();

    await expect(
      runKtxCli(['--project-dir', tempDir, 'ingest', '--no-input'], testIo.io, { publicIngest }),
    ).resolves.toBe(0);

    expect(publicIngest).toHaveBeenCalledWith(
      expect.objectContaining({
        command: 'run',
        projectDir: tempDir,
        all: true,
      }),
      testIo.io,
    );
    const args = publicIngest.mock.calls[0]?.[0] as { targetConnectionId?: string };
    expect(args.targetConnectionId).toBeUndefined();
  });

  it('rejects old adapter-backed ingest flags at the top level and under admin', async () => {
    const rootRunIo = makeIo();
    const devRunIo = makeIo();
    const publicIngest = vi.fn(async () => 0);

    await expect(
      runKtxCli(['ingest', 'run', '--connection-id', 'warehouse', '--adapter', 'metabase'], rootRunIo.io, {
        publicIngest,
      }),
    ).resolves.toBe(1);
    await expect(
      runKtxCli(['admin', 'ingest', 'run', '--connection-id', 'warehouse', '--adapter', 'metabase'], devRunIo.io, {
        publicIngest,
      }),
    ).resolves.toBe(1);
    expect(publicIngest).not.toHaveBeenCalled();
    expect(rootRunIo.stderr()).toMatch(/unknown option '--connection-id'|error:/);
    expect(devRunIo.stderr()).toMatch(/unknown command|error:/);
  });

  it('rejects removed admin doctor and removed ingest parser cases', async () => {
    const doctor = vi.fn(async () => 0);
    const doctorIo = makeIo();
    const ingestRunIo = makeIo();

    await expect(runKtxCli(['admin', 'doctor', 'setup', '--json', '--no-input'], doctorIo.io, { doctor })).resolves.toBe(1);
    await expect(
      runKtxCli(
        [
          'ingest',
          'run',
          '--project-dir',
          tempDir,
          '--connection-id',
          'warehouse',
          '--adapter',
          'fake',
          '--source-dir',
          tempDir,
          '--debug-llm-request-file',
          `${tempDir}/debug.jsonl`,
          '--json',
          '--no-input',
        ],
        ingestRunIo.io,
        {},
      ),
    ).resolves.toBe(1);

    expect(doctor).not.toHaveBeenCalled();
    expect(doctorIo.stderr()).toMatch(/unknown command|error:/);
    expect(ingestRunIo.stderr()).toMatch(/unknown option '--connection-id'|error:/);
  });

  it('dispatches public connection through the existing connection implementation', async () => {
    const testIo = makeIo();
    const connection = vi.fn(async () => 0);

    await expect(runKtxCli(['--project-dir', tempDir, 'connection', 'list'], testIo.io, { connection })).resolves.toBe(
      0,
    );

    expect(connection).toHaveBeenCalledWith({ command: 'list', projectDir: tempDir }, testIo.io);
    expect(testIo.stderr()).toBe(`Project: ${tempDir}\n`);
  });

  it('routes top-level status through doctor', async () => {
    const setup = vi.fn(async () => 0);
    const doctor = vi.fn(async () => 0);
    const statusIo = makeIo();

    await expect(
      runKtxCli(['--project-dir', tempDir, 'status', '--json', '--no-input'], statusIo.io, { setup, doctor }),
    ).resolves.toBe(0);

    expect(setup).not.toHaveBeenCalled();
    expect(doctor).toHaveBeenCalledWith(
      { command: 'project', projectDir: tempDir, outputMode: 'json', inputMode: 'disabled', verbose: false, fast: false },
      statusIo.io,
    );
    expect(statusIo.stderr()).toBe('');
  });

  it('routes top-level status without a project to setup doctor checks', async () => {
    const { mkdtemp, rm } = await import('node:fs/promises');
    const { tmpdir } = await import('node:os');
    const { join } = await import('node:path');
    const originalCwd = process.cwd();
    const previousProjectDir = process.env.KTX_PROJECT_DIR;
    const tempCwd = await mkdtemp(join(tmpdir(), 'ktx-status-no-project-'));
    const doctor = vi.fn(async () => 0);
    const statusIo = makeIo();

    try {
      delete process.env.KTX_PROJECT_DIR;
      process.chdir(tempCwd);

      await expect(runKtxCli(['status', '--json', '--no-input'], statusIo.io, { doctor })).resolves.toBe(0);

      expect(doctor).toHaveBeenCalledWith(
        { command: 'setup', outputMode: 'json', inputMode: 'disabled', verbose: false },
        statusIo.io,
      );
      expect(statusIo.stderr()).toBe('');
    } finally {
      process.chdir(originalCwd);
      if (previousProjectDir === undefined) {
        delete process.env.KTX_PROJECT_DIR;
      } else {
        process.env.KTX_PROJECT_DIR = previousProjectDir;
      }
      await rm(tempCwd, { recursive: true, force: true });
    }
  });

  it('dispatches Anthropic setup flags to the setup runner', async () => {
    const setup = vi.fn(async () => 0);
    const setupIo = makeIo();

    await expect(
      runKtxCli(
        [
          '--project-dir',
          tempDir,
          'setup',
          '--no-input',
          '--anthropic-api-key-env',
          'ANTHROPIC_API_KEY',
        ],
        setupIo.io,
        { setup },
      ),
    ).resolves.toBe(0);

    expect(setup).toHaveBeenCalledWith(
      expect.objectContaining({
        command: 'run',
        projectDir: tempDir,
        inputMode: 'disabled',
        cliVersion,
        anthropicApiKeyEnv: 'ANTHROPIC_API_KEY', // pragma: allowlist secret
        skipLlm: false,
      }),
      setupIo.io,
    );
  });

  it('dispatches Vertex AI setup flags to the setup runner', async () => {
    const setup = vi.fn(async () => 0);
    const setupIo = makeIo();

    await expect(
      runKtxCli(
        [
          '--project-dir',
          tempDir,
          'setup',
          '--no-input',
          '--llm-backend',
          'vertex',
          '--vertex-project',
          'local-gcp-project',
          '--vertex-location',
          'us-east5',
        ],
        setupIo.io,
        { setup },
      ),
    ).resolves.toBe(0);

    expect(setup).toHaveBeenCalledWith(
      expect.objectContaining({
        command: 'run',
        projectDir: tempDir,
        inputMode: 'disabled',
        cliVersion,
        llmBackend: 'vertex',
        vertexProject: 'local-gcp-project',
        vertexLocation: 'us-east5',
        skipLlm: false,
      }),
      setupIo.io,
    );
  });

  it('rejects the removed --llm-model setup flag', async () => {
    const setup = vi.fn(async () => 0);
    const setupIo = makeIo();

    await expect(
      runKtxCli(
        [
          '--project-dir',
          tempDir,
          'setup',
          '--no-input',
          '--llm-backend',
          'claude-code',
          '--llm-model',
          'opus',
        ],
        setupIo.io,
        { setup },
      ),
    ).resolves.toBe(1);

    expect(setup).not.toHaveBeenCalled();
    expect(setupIo.stderr()).toContain("unknown option '--llm-model'");
  });

  it('rejects conflicting Anthropic credential setup flags', async () => {
    const setup = vi.fn(async () => 0);
    const setupIo = makeIo();

    await expect(
      runKtxCli(
        [
          '--project-dir',
          tempDir,
          'setup',
          '--anthropic-api-key-env',
          'ANTHROPIC_API_KEY',
          '--anthropic-api-key-file',
          '/tmp/anthropic-key',
        ],
        setupIo.io,
        { setup },
      ),
    ).resolves.toBe(1);

    expect(setup).not.toHaveBeenCalled();
    expect(setupIo.stderr()).toContain('Choose only one Anthropic credential source');
  });

  it('dispatches embedding setup flags to the setup runner', async () => {
    const setup = vi.fn(async () => 0);
    const setupIo = makeIo();

    await expect(
      runKtxCli(
        [
          '--project-dir',
          tempDir,
          'setup',
          '--no-input',
          '--skip-llm',
          '--embedding-backend',
          'openai',
          '--embedding-api-key-env',
          'OPENAI_API_KEY',
        ],
        setupIo.io,
        { setup },
      ),
    ).resolves.toBe(0);

    expect(setup).toHaveBeenCalledWith(
      expect.objectContaining({
        command: 'run',
        projectDir: tempDir,
        inputMode: 'disabled',
        skipLlm: true,
        embeddingBackend: 'openai',
        embeddingApiKeyEnv: 'OPENAI_API_KEY', // pragma: allowlist secret
        skipEmbeddings: false,
      }),
      setupIo.io,
    );
  });

  it('dispatches database setup flags to the setup runner', async () => {
    const setup = vi.fn(async () => 0);
    const setupIo = makeIo();

    await expect(
      runKtxCli(
        [
          'setup',
          '--project-dir',
          '/tmp/project',
          '--no-input',
          '--yes',
          '--skip-llm',
          '--skip-embeddings',
          '--database',
          'postgres',
          '--database-connection-id',
          'warehouse',
          '--database-url',
          'env:DATABASE_URL',
          '--database-schema',
          'public',
          '--enable-query-history',
          '--query-history-window-days',
          '30',
          '--query-history-min-executions',
          '12',
        ],
        setupIo.io,
        { setup },
      ),
    ).resolves.toBe(0);

    expect(setup).toHaveBeenCalledWith(
      expect.objectContaining({
        command: 'run',
        projectDir: '/tmp/project',
        inputMode: 'disabled',
        yes: true,
        cliVersion,
        skipLlm: true,
        skipEmbeddings: true,
        databaseDrivers: ['postgres'],
        databaseConnectionId: 'warehouse',
        databaseUrl: 'env:DATABASE_URL',
        databaseSchemas: ['public'],
        enableQueryHistory: true,
        queryHistoryWindowDays: 30,
        queryHistoryMinExecutions: 12,
        skipDatabases: false,
      }),
      setupIo.io,
    );
  });

  it('dispatches setup database connection ids that match former ingest subcommand names', async () => {
    const testIo = makeIo();
    const setup = vi.fn(async () => 0);

    await expect(
      runKtxCli(['setup', '--database-connection-id', 'status', '--no-input'], testIo.io, { setup }),
    ).resolves.toBe(0);

    expect(setup).toHaveBeenCalledWith(
      expect.objectContaining({
        command: 'run',
        databaseConnectionIds: ['status'],
      }),
      testIo.io,
    );
  });

  it('dispatches non-TTY agents setup with target without requiring --no-input or --yes', async () => {
    const testIo = makeIo({ stdoutIsTty: false });
    const setup = vi.fn(async () => 0);

    await expect(
      runKtxCli(['--project-dir', tempDir, 'setup', '--agents', '--target', 'claude-code'], testIo.io, { setup }),
    ).resolves.toBe(0);

    expect(setup).toHaveBeenCalledWith(
      expect.objectContaining({
        command: 'run',
        projectDir: tempDir,
        agents: true,
        target: 'claude-code',
        agentScope: 'project',
        inputMode: 'auto',
        yes: false,
      }),
      testIo.io,
    );
    expect(testIo.stderr()).toBe('');
  });

  it('dispatches setup source flags', async () => {
    const setup = vi.fn(async () => 0);
    const testIo = makeIo();

    await expect(
      runKtxCli(
        [
          '--project-dir',
          tempDir,
          'setup',
          '--no-input',
          '--source',
          'metabase',
          '--source-connection-id',
          'prod_metabase',
          '--source-url',
          'https://metabase.example.com',
          '--source-api-key-ref',
          'env:METABASE_API_KEY',
          '--source-warehouse-connection-id',
          'warehouse',
          '--metabase-database-id',
          '1',
          '--skip-llm',
          '--skip-embeddings',
          '--skip-databases',
        ],
        testIo.io,
        { setup },
      ),
    ).resolves.toBe(0);

    expect(setup).toHaveBeenCalledWith(
      expect.objectContaining({
        command: 'run',
        projectDir: tempDir,
        source: 'metabase',
        sourceConnectionId: 'prod_metabase',
        sourceUrl: 'https://metabase.example.com',
        sourceApiKeyRef: 'env:METABASE_API_KEY', // pragma: allowlist secret
        sourceWarehouseConnectionId: 'warehouse',
        metabaseDatabaseId: 1,
      }),
      testIo.io,
    );
  });

  it('dispatches setup agent flags', async () => {
    const setup = vi.fn(async () => 0);
    const setupIo = makeIo();

    await expect(
      runKtxCli(
        [
          '--project-dir',
          tempDir,
          'setup',
          '--agents',
          '--target',
          'codex',
          '--no-input',
          '--yes',
        ],
        setupIo.io,
        { setup },
      ),
    ).resolves.toBe(0);

    expect(setup).toHaveBeenCalledWith(
      expect.objectContaining({
        command: 'run',
        agents: true,
        target: 'codex',
        agentScope: 'project',
        inputMode: 'disabled',
        yes: true,
      }),
      setupIo.io,
    );
  });

  it('rejects --local with non-Claude targets', async () => {
    const setup = vi.fn(async () => 0);
    const setupIo = makeIo();

    await expect(
      runKtxCli(
        ['--project-dir', tempDir, 'setup', '--agents', '--target', 'cursor', '--local', '--no-input'],
        setupIo.io,
        { setup },
      ),
    ).resolves.toBe(1);

    expect(setupIo.stderr()).toContain('--local is only supported with --target claude-code');
    expect(setup).not.toHaveBeenCalled();
  });

  it('rejects --local and --global together', async () => {
    const setup = vi.fn(async () => 0);
    const setupIo = makeIo();

    await expect(
      runKtxCli(
        ['--project-dir', tempDir, 'setup', '--agents', '--target', 'claude-code', '--local', '--global', '--no-input'],
        setupIo.io,
        { setup },
      ),
    ).resolves.toBe(1);

    expect(setupIo.stderr()).toContain('Choose only one agent scope: --local or --global.');
    expect(setup).not.toHaveBeenCalled();
  });

  it('dispatches --install-dir as the agent install root', async () => {
    const setup = vi.fn(async () => 0);
    const setupIo = makeIo();

    await expect(
      runKtxCli(
        ['--project-dir', tempDir, 'setup', '--agents', '--target', 'claude-code', '--install-dir', '.', '--no-input'],
        setupIo.io,
        { setup },
      ),
    ).resolves.toBe(0);

    expect(setup).toHaveBeenCalledWith(
      expect.objectContaining({ agents: true, target: 'claude-code', agentScope: 'project', installRoot: '.' }),
      setupIo.io,
    );
  });

  it('rejects --install-dir together with --global', async () => {
    const setup = vi.fn(async () => 0);
    const setupIo = makeIo();

    await expect(
      runKtxCli(
        ['--project-dir', tempDir, 'setup', '--agents', '--target', 'claude-code', '--install-dir', '.', '--global', '--no-input'],
        setupIo.io,
        { setup },
      ),
    ).resolves.toBe(1);

    expect(setupIo.stderr()).toContain('Choose either --install-dir or a scope flag (--global / --local), not both.');
    expect(setup).not.toHaveBeenCalled();
  });

  it('rejects --install-dir together with --local', async () => {
    const setup = vi.fn(async () => 0);
    const setupIo = makeIo();

    await expect(
      runKtxCli(
        ['--project-dir', tempDir, 'setup', '--agents', '--target', 'claude-code', '--install-dir', '.', '--local', '--no-input'],
        setupIo.io,
        { setup },
      ),
    ).resolves.toBe(1);

    expect(setupIo.stderr()).toContain('Choose either --install-dir or a scope flag (--global / --local), not both.');
    expect(setup).not.toHaveBeenCalled();
  });

  it('treats an empty --install-dir as not provided', async () => {
    const setup = vi.fn(async () => 0);
    const setupIo = makeIo();

    await expect(
      runKtxCli(
        ['--project-dir', tempDir, 'setup', '--agents', '--target', 'claude-code', '--install-dir', '', '--global', '--no-input'],
        setupIo.io,
        { setup },
      ),
    ).resolves.toBe(0);

    expect(setup).toHaveBeenCalledWith(
      expect.objectContaining({ agents: true, target: 'claude-code', agentScope: 'global' }),
      setupIo.io,
    );
    expect(setup).toHaveBeenCalledWith(
      expect.not.objectContaining({ installRoot: expect.anything() }),
      setupIo.io,
    );
  });

  it('rejects --install-dir with --target claude-desktop', async () => {
    const setup = vi.fn(async () => 0);
    const setupIo = makeIo();

    await expect(
      runKtxCli(
        ['--project-dir', tempDir, 'setup', '--agents', '--target', 'claude-desktop', '--install-dir', '.', '--no-input'],
        setupIo.io,
        { setup },
      ),
    ).resolves.toBe(1);

    expect(setupIo.stderr()).toContain('--install-dir does not apply to --target claude-desktop, which is always global.');
    expect(setup).not.toHaveBeenCalled();
  });

  it('rejects source-path with source-git-url', async () => {
    const setup = vi.fn(async () => 0);
    const testIo = makeIo();

    await expect(
      runKtxCli(
        [
          '--project-dir',
          tempDir,
          'setup',
          '--no-input',
          '--source',
          'dbt',
          '--source-path',
          '/repo/dbt',
          '--source-git-url',
          'https://github.com/acme/dbt.git',
        ],
        testIo.io,
        { setup },
      ),
    ).resolves.toBe(1);

    expect(setup).not.toHaveBeenCalled();
    expect(testIo.stderr()).toContain('Choose only one source location');
  });

  it('rejects deterministic as a setup embedding backend', async () => {
    const setup = vi.fn(async () => 0);
    const setupIo = makeIo();

    await expect(
      runKtxCli(['--project-dir', tempDir, 'setup', '--embedding-backend', 'deterministic'], setupIo.io, { setup }),
    ).resolves.toBe(1);

    expect(setup).not.toHaveBeenCalled();
    expect(setupIo.stderr()).toContain("invalid choice 'deterministic'");
  });

  it('rejects gateway as a setup embedding backend', async () => {
    const setup = vi.fn(async () => 0);
    const setupIo = makeIo();

    await expect(
      runKtxCli(['--project-dir', tempDir, 'setup', '--embedding-backend', 'gateway'], setupIo.io, { setup }),
    ).resolves.toBe(1);

    expect(setup).not.toHaveBeenCalled();
    expect(setupIo.stderr()).toContain("invalid choice 'gateway'");
  });

  it('rejects conflicting embedding credential setup flags', async () => {
    const setup = vi.fn(async () => 0);
    const setupIo = makeIo();

    await expect(
      runKtxCli(
        [
          '--project-dir',
          tempDir,
          'setup',
          '--embedding-backend',
          'openai',
          '--embedding-api-key-env',
          'OPENAI_API_KEY',
          '--embedding-api-key-file',
          '/tmp/openai-key',
        ],
        setupIo.io,
        { setup },
      ),
    ).resolves.toBe(1);

    expect(setup).not.toHaveBeenCalled();
    expect(setupIo.stderr()).toContain('Choose only one embedding credential source');
  });

  it('rejects conflicting query-history setup flags', async () => {
    const setup = vi.fn(async () => 0);
    const setupIo = makeIo();

    await expect(
      runKtxCli(['--project-dir', tempDir, 'setup', '--enable-query-history', '--disable-query-history'], setupIo.io, {
        setup,
      }),
    ).resolves.toBe(1);

    expect(setup).not.toHaveBeenCalled();
    expect(setupIo.stderr()).toContain(
      'Choose only one query-history action: --enable-query-history or --disable-query-history.',
    );
  });

  it('rejects the removed hidden agent command', async () => {
    const io = makeIo();

    await expect(runKtxCli(['agent'], io.io)).resolves.toBe(1);

    expect(io.stderr()).toContain("unknown command 'agent'");
    expect(io.stdout()).toBe('');
  });

  it('routes public SL query files with managed runtime policies', async () => {
    const autoIo = makeIo();
    const neverIo = makeIo();
    const conflictIo = makeIo();
    const sl = vi.fn(async () => 0);

    await expect(
      runKtxCli(
        [
          '--project-dir',
          tempDir,
          'sl',
          'query',
          '--connection-id',
          'warehouse',
          '--query-file',
          '/tmp/query.json',
          '--yes',
        ],
        autoIo.io,
        { sl },
      ),
    ).resolves.toBe(0);

    await expect(
      runKtxCli(
        [
          '--project-dir',
          tempDir,
          'sl',
          'query',
          '--connection-id',
          'warehouse',
          '--query-file',
          '/tmp/query.json',
          '--no-input',
        ],
        neverIo.io,
        { sl },
      ),
    ).resolves.toBe(0);

    await expect(
      runKtxCli(
        [
          '--project-dir',
          tempDir,
          'sl',
          'query',
          '--connection-id',
          'warehouse',
          '--query-file',
          '/tmp/query.json',
          '--yes',
          '--no-input',
        ],
        conflictIo.io,
        { sl },
      ),
    ).resolves.toBe(1);

    expect(sl).toHaveBeenNthCalledWith(
      1,
      {
        command: 'query',
        projectDir: tempDir,
        connectionId: 'warehouse',
        queryFile: '/tmp/query.json',
        execute: false,
        format: 'json',
        cliVersion,
        runtimeInstallPolicy: 'auto',
      },
      autoIo.io,
    );
    expect(sl).toHaveBeenNthCalledWith(
      2,
      {
        command: 'query',
        projectDir: tempDir,
        connectionId: 'warehouse',
        queryFile: '/tmp/query.json',
        execute: false,
        format: 'json',
        cliVersion,
        runtimeInstallPolicy: 'never',
      },
      neverIo.io,
    );
    expect(conflictIo.stderr()).toContain('Choose only one runtime install mode: --yes or --no-input');
  });

  it('dispatches public connection subcommands through the existing connection implementation', async () => {
    const tempDir = await mkdtemp(join(tmpdir(), 'ktx-connection-dispatch-'));
    await writeFile(join(tempDir, 'ktx.yaml'), '{}\n', 'utf-8');
    const connection = vi.fn(async () => 0);

    await expect(
      runKtxCli(['--project-dir', tempDir, 'connection', 'list'], makeIo().io, { connection }),
    ).resolves.toBe(0);

    const testIo = makeIo();
    await expect(
      runKtxCli(['--project-dir', tempDir, 'connection', 'test', 'warehouse'], testIo.io, {
        connection,
      }),
    ).resolves.toBe(0);

    expect(connection).toHaveBeenNthCalledWith(1, { command: 'list', projectDir: tempDir }, expect.anything());
    expect(connection).toHaveBeenNthCalledWith(
      2,
      {
        command: 'test',
        projectDir: tempDir,
        connectionId: 'warehouse',
      },
      expect.anything(),
    );

    await rm(tempDir, { recursive: true, force: true });
  });

  it('prints only list and test in connection help', async () => {
    const helpIo = makeIo();

    await expect(runKtxCli(['connection', '--help'], helpIo.io)).resolves.toBe(0);

    expect(helpIo.stdout()).toContain('Usage: ktx connection');
    expect(helpIo.stdout()).toContain('list');
    expect(helpIo.stdout()).toContain('test [options] [connectionId]');
    for (const removed of ['add', 'remove', 'map', 'mapping', 'metabase', 'notion']) {
      expect(helpIo.stdout()).not.toMatch(new RegExp(`\\b${removed}\\b`));
    }
    expect(helpIo.stderr()).toBe('');
  });

  it('rejects removed connection subcommands', async () => {
    for (const argv of [
      ['connection', 'add', 'postgres', 'warehouse'],
      ['connection', 'remove', 'warehouse'],
      ['connection', 'map', 'prod-metabase'],
      ['connection', 'mapping'],
      ['connection', 'metabase'],
      ['connection', 'notion'],
    ]) {
      const testIo = makeIo();

      await expect(runKtxCli(argv, testIo.io)).resolves.toBe(1);

      expect(testIo.stderr()).toMatch(/unknown command|error:/);
    }
  });

  it('rejects commands removed from the May 6 root surface', async () => {
    for (const argv of [
      ['init'],
      ['connect', 'list'],
      ['knowledge', 'list'],
      ['ask', 'What sources are connected?'],
    ]) {
      const testIo = makeIo();

      await expect(runKtxCli(argv, testIo.io)).resolves.toBe(1);

      expect(testIo.stderr()).toMatch(/unknown command|error:/);
    }
  });

  it('writes basic debug dispatch information when --debug is set', async () => {
    const testIo = makeIo();
    const connection = vi.fn().mockResolvedValue(0);

    await expect(
      runKtxCli(['--project-dir', tempDir, '--debug', 'connection', 'list'], testIo.io, { connection }),
    ).resolves.toBe(0);

    expect(testIo.stderr()).toContain(`[debug] projectDir=${tempDir}`);
    expect(testIo.stderr()).toContain('[debug] dispatch=connection');
  });

  it.each([
    { argv: ['scan'] },
    { argv: ['scan', '--help'] },
    { argv: ['scan', 'warehouse'] },
    { argv: ['scan', 'warehouse', '--project-dir', '/tmp/project'] },
    { argv: ['scan', 'warehouse', '--mode', 'relationships'] },
  ])('rejects removed top-level scan command $argv', async ({ argv }) => {
    const testIo = makeIo();
    const publicIngest = vi.fn().mockResolvedValue(0);

    await expect(runKtxCli(argv, testIo.io, { publicIngest })).resolves.toBe(1);

    expect(testIo.stderr()).toMatch(/unknown command|error:/);
    expect(publicIngest).not.toHaveBeenCalled();
  });

  it('rejects removed public serve command options before dispatch', async () => {
    const serveIo = makeIo();

    await expect(
      runKtxCli(
        [
          'serve',
          '--mcp',
          'stdio',
          '--project-dir',
          tempDir,
          '--semantic-compute-url',
          'http://127.0.0.1:18080',
          '--execute-queries',
          '--memory-capture',
          '--memory-model',
          'openai/gpt-5.2',
        ],
        serveIo.io,
      ),
    ).resolves.toBe(1);

    expect(serveIo.stderr()).toMatch(/unknown command|error:/);
  });

  it('prints admin help for bare admin commands', async () => {
    const testIo = makeIo();

    await expect(runKtxCli(['admin'], testIo.io)).resolves.toBe(0);

    expect(testIo.stdout()).toContain('Usage: ktx admin [options] [command]');
    expect(testIo.stdout()).toContain('Low-level project initialization');
    expect(testIo.stdout()).toContain('init');
    expect(testIo.stdout()).toContain('runtime');
    expect(testIo.stdout()).not.toContain('scan');
    expect(testIo.stdout()).not.toContain('ingest');
    expect(testIo.stdout()).not.toContain('mapping');
    expect(testIo.stdout()).not.toContain('model');
    expect(testIo.stdout()).not.toContain('knowledge');
    expect(testIo.stderr()).toBe('');
  });

  it('rejects removed admin command groups without invoking execution', async () => {
    for (const command of ['scan', 'ingest', 'mapping']) {
      const testIo = makeIo();
      const publicIngest = vi.fn().mockResolvedValue(0);
      const sl = vi.fn().mockResolvedValue(0);

      await expect(runKtxCli(['admin', command], testIo.io, { publicIngest, sl })).resolves.toBe(1);

      expect(testIo.stderr()).toMatch(/unknown command|error:/);
      expect(publicIngest).not.toHaveBeenCalled();
      expect(sl).not.toHaveBeenCalled();
    }
  });

  it('rejects removed reserved admin subcommands', async () => {
    const testIo = makeIo();

    await expect(runKtxCli(['admin', 'artifacts'], testIo.io)).resolves.toBe(1);

    expect(testIo.stderr()).toMatch(/unknown command|error:/);
  });

  it('rejects mutually exclusive public ingest output modes before invoking runners', async () => {
    const publicIngest = vi.fn(async () => 0);

    const testIo = makeIo();
    await expect(runKtxCli(['ingest', 'warehouse', '--json', '--plain'], testIo.io, { publicIngest })).resolves.toBe(
      1,
    );

    expect(testIo.stderr()).toMatch(/conflict|cannot be used/i);
    expect(publicIngest).not.toHaveBeenCalled();
  });

  it('does not expose root init after setup owns project creation', async () => {
    const testIo = makeIo();

    await expect(runKtxCli(['init'], testIo.io)).resolves.toBe(1);

    expect(testIo.stderr()).toContain("error: unknown command 'init'");
  });

  it('returns an error code for unknown commands', async () => {
    const testIo = makeIo();

    await expect(runKtxCli(['unknown'], testIo.io)).resolves.toBe(1);

    expect(testIo.stderr()).toContain("error: unknown command 'unknown'");
  });
});
