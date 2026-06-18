import { mkdir, mkdtemp, readFile, rm, stat, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { readKtxSetupState } from '../src/context/project/setup-config.js';
import { strFromU8, unzipSync } from 'fflate';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  createAgentNextActionsLineFormatter,
  formatInstallSummaryLines,
  plannedKtxAgentFiles,
  readKtxAgentInstallManifest,
  removeKtxAgentInstall,
  runKtxSetupAgentsStep,
} from '../src/setup-agents.js';

function makeIo() {
  let stdout = '';
  let stderr = '';
  return {
    io: {
      stdout: { write: (chunk: string) => (stdout += chunk) },
      stderr: { write: (chunk: string) => (stderr += chunk) },
    },
    stdout: () => stdout,
    stderr: () => stderr,
  };
}

async function readZipText(path: string, entry: string): Promise<string> {
  const archive = unzipSync(new Uint8Array(await readFile(path)));
  const content = archive[entry];
  if (!content) throw new Error(`Missing zip entry: ${entry}`);
  return strFromU8(content);
}

function captureEnvKeys(env: NodeJS.ProcessEnv, keys: readonly string[]): Record<string, string | undefined> {
  const snapshot: Record<string, string | undefined> = {};
  for (const key of keys) snapshot[key] = env[key];
  return snapshot;
}

function clearEnvKeys(env: NodeJS.ProcessEnv, keys: readonly string[]): void {
  for (const key of keys) delete env[key];
}

function captureKtxEnv(env: NodeJS.ProcessEnv): Record<string, string | undefined> {
  const snapshot: Record<string, string | undefined> = {};
  for (const key of Object.keys(env)) {
    if (key.startsWith('KTX_')) snapshot[key] = env[key];
  }
  return snapshot;
}

function clearKtxEnv(env: NodeJS.ProcessEnv): void {
  for (const key of Object.keys(env)) {
    if (key.startsWith('KTX_')) delete env[key];
  }
}

function restoreEnvKeys(env: NodeJS.ProcessEnv, snapshot: Record<string, string | undefined>): void {
  for (const [key, value] of Object.entries(snapshot)) {
    if (value === undefined) delete env[key];
    else env[key] = value;
  }
}

describe('setup agents', () => {
  let tempDir: string;

  beforeEach(async () => {
    tempDir = await mkdtemp(join(tmpdir(), 'ktx-setup-agents-'));
    await mkdir(join(tempDir, '.ktx', 'agents'), { recursive: true });
    await writeFile(join(tempDir, 'ktx.yaml'), 'connections: {}\n', 'utf-8');
  });

  afterEach(async () => {
    await rm(tempDir, { recursive: true, force: true });
  });

  it('plans project-scoped MCP analytics files for every target', () => {
    expect(plannedKtxAgentFiles({ projectDir: tempDir, target: 'claude-code', scope: 'project', mode: 'mcp' })).toEqual([
      { kind: 'file', path: join(tempDir, '.claude/skills/ktx-analytics/SKILL.md'), role: 'analytics-skill' },
    ]);
    expect(plannedKtxAgentFiles({ projectDir: tempDir, target: 'claude-desktop', scope: 'global', mode: 'mcp' })).toEqual([
      {
        kind: 'file',
        path: join(tempDir, '.ktx/agents/claude/ktx-analytics.zip'),
        role: 'claude-desktop-skill-bundle',
      },
    ]);
    expect(plannedKtxAgentFiles({ projectDir: tempDir, target: 'codex', scope: 'project', mode: 'mcp' })).toEqual([
      { kind: 'file', path: join(tempDir, '.agents/skills/ktx-analytics/SKILL.md'), role: 'analytics-skill' },
    ]);
    expect(plannedKtxAgentFiles({ projectDir: tempDir, target: 'cursor', scope: 'project', mode: 'mcp' })).toEqual([
      { kind: 'file', path: join(tempDir, '.cursor/rules/ktx-analytics.mdc'), role: 'analytics-skill' },
    ]);
    expect(plannedKtxAgentFiles({ projectDir: tempDir, target: 'opencode', scope: 'project', mode: 'mcp' })).toEqual([
      { kind: 'file', path: join(tempDir, '.opencode/commands/ktx-analytics.md'), role: 'analytics-skill' },
    ]);
    expect(plannedKtxAgentFiles({ projectDir: tempDir, target: 'universal', scope: 'project', mode: 'mcp' })).toEqual([
      { kind: 'file', path: join(tempDir, '.agents/skills/ktx-analytics/SKILL.md'), role: 'analytics-skill' },
    ]);
  });

  it('plans project-scoped admin CLI files for every target when requested', () => {
    expect(plannedKtxAgentFiles({ projectDir: tempDir, target: 'claude-code', scope: 'project', mode: 'mcp-cli' })).toEqual([
      { kind: 'file', path: join(tempDir, '.claude/skills/ktx-analytics/SKILL.md'), role: 'analytics-skill' },
      { kind: 'file', path: join(tempDir, '.claude/skills/ktx/SKILL.md'), role: 'skill' },
      { kind: 'file', path: join(tempDir, '.claude/rules/ktx.md'), role: 'rule' },
    ]);
    expect(plannedKtxAgentFiles({ projectDir: tempDir, target: 'codex', scope: 'project', mode: 'mcp-cli' })).toEqual([
      { kind: 'file', path: join(tempDir, '.agents/skills/ktx-analytics/SKILL.md'), role: 'analytics-skill' },
      { kind: 'file', path: join(tempDir, '.agents/skills/ktx/SKILL.md'), role: 'skill' },
      { kind: 'file', path: join(tempDir, '.codex/instructions/ktx.md'), role: 'rule' },
    ]);
    expect(plannedKtxAgentFiles({ projectDir: tempDir, target: 'cursor', scope: 'project', mode: 'mcp-cli' })).toEqual([
      { kind: 'file', path: join(tempDir, '.cursor/rules/ktx-analytics.mdc'), role: 'analytics-skill' },
      { kind: 'file', path: join(tempDir, '.cursor/rules/ktx.mdc') },
    ]);
    expect(plannedKtxAgentFiles({ projectDir: tempDir, target: 'opencode', scope: 'project', mode: 'mcp-cli' })).toEqual([
      { kind: 'file', path: join(tempDir, '.opencode/commands/ktx-analytics.md'), role: 'analytics-skill' },
      { kind: 'file', path: join(tempDir, '.opencode/commands/ktx.md') },
    ]);
    expect(plannedKtxAgentFiles({ projectDir: tempDir, target: 'universal', scope: 'project', mode: 'mcp-cli' })).toEqual([
      { kind: 'file', path: join(tempDir, '.agents/skills/ktx-analytics/SKILL.md'), role: 'analytics-skill' },
      { kind: 'file', path: join(tempDir, '.agents/skills/ktx/SKILL.md') },
    ]);
    expect(plannedKtxAgentFiles({ projectDir: tempDir, target: 'claude-desktop', scope: 'global', mode: 'mcp-cli' })).toEqual([
      {
        kind: 'file',
        path: join(tempDir, '.ktx/agents/claude/ktx-analytics.zip'),
        role: 'claude-desktop-skill-bundle',
      },
      {
        kind: 'file',
        path: join(tempDir, '.ktx/agents/claude/ktx.zip'),
        role: 'claude-desktop-skill-bundle',
      },
    ]);
  });

  it('installs target files, writes a manifest, and marks agents complete', async () => {
    const io = makeIo();

    await expect(
      runKtxSetupAgentsStep(
        {
          projectDir: tempDir,
          inputMode: 'disabled',
          yes: true,
          agents: true,
          target: 'universal',
          scope: 'project',
          mode: 'mcp-cli',
          skipAgents: false,
        },
        io.io,
      ),
    ).resolves.toMatchObject({
      status: 'ready',
      projectDir: tempDir,
      installs: [{ target: 'universal', scope: 'project', mode: 'mcp-cli' }],
    });

    await expect(stat(join(tempDir, '.agents/skills/ktx/SKILL.md'))).resolves.toBeDefined();
    const skill = await readFile(join(tempDir, '.agents/skills/ktx/SKILL.md'), 'utf-8');
    expect(skill).toContain(`--project-dir ${tempDir}`);
    expect(skill).toContain('must not print secrets');
    expect(skill).toContain('status --json');
    expect(skill).toContain('sl --json');
    expect(skill).toContain('sl query');
    expect(skill).toContain('--format json');
    expect(skill).not.toContain('sl query --json');
    expect(skill).not.toContain('agent ');
    expect(skill).not.toContain('sql execute');
    expect(await readKtxAgentInstallManifest(tempDir)).toMatchObject({
      version: 1,
      projectDir: tempDir,
      installs: [{ target: 'universal', scope: 'project', mode: 'mcp-cli' }],
    });
    expect(await readKtxSetupState(tempDir)).toEqual({ completed_steps: ['agents'] });
    expect(io.stderr()).toBe('');
  });

  it('installs a specified target in non-interactive mode without --yes', async () => {
    const io = makeIo();

    await expect(
      runKtxSetupAgentsStep(
        {
          projectDir: tempDir,
          inputMode: 'disabled',
          yes: false,
          agents: true,
          target: 'claude-code',
          scope: 'project',
          mode: 'mcp',
          skipAgents: false,
        },
        io.io,
      ),
    ).resolves.toMatchObject({
      status: 'ready',
      projectDir: tempDir,
      installs: [{ target: 'claude-code', scope: 'project', mode: 'mcp' }],
    });

    await expect(stat(join(tempDir, '.claude/skills/ktx-analytics/SKILL.md'))).resolves.toBeDefined();
    const mcpConfig = JSON.parse(await readFile(join(tempDir, '.mcp.json'), 'utf-8')) as {
      mcpServers?: Record<string, unknown>;
    };
    expect(mcpConfig.mcpServers).toHaveProperty('ktx');
    expect(io.stderr()).toBe('');
  });

  it('prints concrete target guidance when non-interactive agent setup has no target', async () => {
    const io = makeIo();

    await expect(
      runKtxSetupAgentsStep(
        {
          projectDir: tempDir,
          inputMode: 'disabled',
          yes: false,
          agents: true,
          scope: 'project',
          mode: 'mcp',
          skipAgents: false,
        },
        io.io,
      ),
    ).resolves.toEqual({ status: 'missing-input', projectDir: tempDir });

    expect(io.stderr()).toBe('Run in a TTY, or pass --target <target>.\n');
  });

  it('prints standalone agent next actions after successful installation', async () => {
    const io = makeIo();

    const result = await runKtxSetupAgentsStep(
      {
        projectDir: tempDir,
        inputMode: 'disabled',
        yes: true,
        agents: true,
        target: 'claude-code',
        scope: 'project',
        mode: 'mcp-cli',
        skipAgents: false,
      },
      io.io,
    );

    expect(result).toMatchObject({
      status: 'ready',
      nextActions: expect.stringContaining('Run this command before using Claude Code:'),
    });
    expect(io.stdout()).toContain('Required before using agents');
    expect(io.stdout()).toContain('Run this command before using Claude Code:');
    expect(io.stdout()).toContain('RUN:');
    expect(io.stdout()).toContain(`ktx mcp start --project-dir ${tempDir}`);
    expect(io.stdout()).toContain('If you need to stop MCP later:');
    expect(io.stdout()).toContain(`ktx mcp stop --project-dir ${tempDir}`);
    expect(io.stdout()).toContain('All set.');
    expect(io.stdout()).not.toContain('Finish agent setup');
    expect(io.stdout()).not.toContain('Next actions');
  });

  it('can return agent next actions without printing them', async () => {
    const io = makeIo();

    const result = await runKtxSetupAgentsStep(
      {
        projectDir: tempDir,
        inputMode: 'disabled',
        yes: true,
        agents: true,
        target: 'claude-code',
        scope: 'project',
        mode: 'mcp-cli',
        skipAgents: false,
        showNextActions: false,
      },
      io.io,
    );

    expect(result).toMatchObject({
      status: 'ready',
      nextActions: expect.stringContaining(`ktx mcp start --project-dir ${tempDir}`),
    });
    expect(io.stdout()).toContain('Claude Code · Project scope');
    expect(io.stdout()).not.toContain('Agent integration complete');
    expect(io.stdout()).not.toContain('Required before using agents');
    expect(io.stdout()).not.toContain('All set.');
  });

  it('installs the analytics skill from the runtime asset', async () => {
    const io = makeIo();

    await expect(
      runKtxSetupAgentsStep(
        {
          projectDir: tempDir,
          inputMode: 'disabled',
          yes: true,
          agents: true,
          target: 'universal',
          scope: 'project',
          mode: 'mcp-cli',
          skipAgents: false,
        },
        io.io,
      ),
    ).resolves.toMatchObject({ status: 'ready' });

    const analyticsSkill = await readFile(join(tempDir, '.agents/skills/ktx-analytics/SKILL.md'), 'utf-8');
    expect(analyticsSkill).toContain('name: ktx-analytics');
    expect(analyticsSkill).toContain('Always run `discover_data` before writing SQL.');
    expect(analyticsSkill).toContain('Treat a `dictionary_search` miss as non-authoritative.');
    expect(analyticsSkill).toContain('memory_ingest');
    expect(analyticsSkill).toContain('ARR is reported in cents');
    expect(analyticsSkill).not.toContain(`memory_${'capture'}`);
  });

  it('writes PATH-independent launcher commands for skills', async () => {
    const io = makeIo();

    await expect(
      runKtxSetupAgentsStep(
        {
          projectDir: tempDir,
          inputMode: 'disabled',
          yes: true,
          agents: true,
          target: 'universal',
          scope: 'project',
          mode: 'mcp-cli',
          skipAgents: false,
        },
        io.io,
      ),
    ).resolves.toMatchObject({ status: 'ready' });

    const skill = await readFile(join(tempDir, '.agents/skills/ktx/SKILL.md'), 'utf-8');
    expect(skill).not.toContain('`ktx agent');
    expect(skill).toContain('status --json');
    expect(skill).toContain('sl query');
    expect(skill).toContain('--format json');
    expect(skill).not.toContain('sl query --json');
    expect(skill).not.toContain('sql execute');
  });

  it('writes Claude Code project MCP config and tracks the json key', async () => {
    const io = makeIo();

    await expect(
      runKtxSetupAgentsStep(
        {
          projectDir: tempDir,
          inputMode: 'disabled',
          yes: true,
          agents: true,
          target: 'claude-code',
          scope: 'project',
          mode: 'mcp-cli',
          skipAgents: false,
        },
        io.io,
      ),
    ).resolves.toMatchObject({ status: 'ready' });

    const mcpJson = JSON.parse(await readFile(join(tempDir, '.mcp.json'), 'utf-8')) as {
      mcpServers: { ktx: { type: string; url: string; headers?: Record<string, string> } };
    };
    expect(mcpJson.mcpServers.ktx).toEqual({ type: 'http', url: 'http://localhost:7878/mcp' });
    expect(await readKtxAgentInstallManifest(tempDir)).toMatchObject({
      entries: expect.arrayContaining([{ kind: 'json-key', path: join(tempDir, '.mcp.json'), jsonPath: ['mcpServers', 'ktx'] }]),
    });
  });

  it('prompts for MCP-first agent client connection mode in interactive setup', async () => {
    const io = makeIo();
    const prompts = {
      select: vi.fn(async ({ message }: { message: string }) => (message.startsWith('Where') ? 'project' : 'mcp')),
      multiselect: vi.fn(async () => ['claude-code']),
      text: vi.fn(async () => undefined),
      cancel: vi.fn(),
    };

    await expect(
      runKtxSetupAgentsStep(
        {
          projectDir: tempDir,
          inputMode: 'auto',
          yes: false,
          agents: true,
          scope: 'project',
          mode: 'mcp',
          skipAgents: false,
        },
        io.io,
        { prompts },
      ),
    ).resolves.toMatchObject({
      status: 'ready',
      installs: [{ target: 'claude-code', scope: 'project', mode: 'mcp' }],
    });

    expect(prompts.select).toHaveBeenCalledWith({
      message: 'What should agents be allowed to do with this ktx project?',
      options: [
        {
          value: 'mcp',
          label: 'Ask data questions with ktx MCP',
          hint: 'Installs the MCP connection and analytics workflow skill. Best for normal use.',
        },
        {
          value: 'mcp-cli',
          label: 'Ask data questions + manage ktx with CLI commands',
          hint: 'Adds an admin CLI skill so agents can run ktx status, sl, wiki, and setup commands.',
        },
        {
          value: 'skip',
          label: 'Skip agent setup for now',
          hint: 'Leaves agent integration incomplete. You can run ktx setup --agents later.',
        },
      ],
    });
    expect(prompts.multiselect).toHaveBeenCalledWith(
      expect.objectContaining({
        options: expect.arrayContaining([{ value: 'claude-desktop', label: 'Claude Desktop' }]),
      }),
    );
  });

  it('lets interactive setup skip agent integration from the connection mode prompt', async () => {
    const io = makeIo();
    const prompts = {
      select: vi.fn(async () => 'skip'),
      multiselect: vi.fn(async () => {
        throw new Error('target selection should not run');
      }),
      text: vi.fn(async () => undefined),
      cancel: vi.fn(),
    };

    await expect(
      runKtxSetupAgentsStep(
        {
          projectDir: tempDir,
          inputMode: 'auto',
          yes: false,
          agents: true,
          scope: 'project',
          mode: 'mcp',
          skipAgents: false,
        },
        io.io,
        { prompts },
      ),
    ).resolves.toMatchObject({ status: 'skipped', projectDir: tempDir });

    expect(prompts.select).toHaveBeenCalledWith({
      message: 'What should agents be allowed to do with this ktx project?',
      options: [
        {
          value: 'mcp',
          label: 'Ask data questions with ktx MCP',
          hint: 'Installs the MCP connection and analytics workflow skill. Best for normal use.',
        },
        {
          value: 'mcp-cli',
          label: 'Ask data questions + manage ktx with CLI commands',
          hint: 'Adds an admin CLI skill so agents can run ktx status, sl, wiki, and setup commands.',
        },
        {
          value: 'skip',
          label: 'Skip agent setup for now',
          hint: 'Leaves agent integration incomplete. You can run ktx setup --agents later.',
        },
      ],
    });
    expect(prompts.multiselect).not.toHaveBeenCalled();
    expect(io.stdout()).toContain('Agent integration skipped.');
    await expect(stat(join(tempDir, '.ktx/agents/install-manifest.json'))).rejects.toThrow();
    expect(await readKtxSetupState(tempDir)).toEqual({ completed_steps: [] });
  });

  it('prompts for global scope when every selected target supports it', async () => {
    const home = await mkdtemp(join(tmpdir(), 'ktx-setup-agents-home-'));
    const previousHome = process.env.HOME;
    process.env.HOME = home;
    try {
      const io = makeIo();
      const prompts = {
        select: vi.fn(async ({ message }: { message: string }) =>
          message.startsWith('Where should') ? 'global' : 'mcp',
        ),
        multiselect: vi.fn(async () => ['claude-code']),
        text: vi.fn(async () => undefined),
        cancel: vi.fn(),
      };

      await expect(
        runKtxSetupAgentsStep(
          {
            projectDir: tempDir,
            inputMode: 'auto',
            yes: false,
            agents: true,
            scope: 'project',
            mode: 'mcp',
            skipAgents: false,
            cwd: tempDir,
          },
          io.io,
          { prompts },
        ),
      ).resolves.toMatchObject({
        status: 'ready',
        installs: [{ target: 'claude-code', scope: 'global', mode: 'mcp' }],
      });

      expect(prompts.select).toHaveBeenCalledWith({
        message: `Where should ktx install agent config?\n\nktx project: ${tempDir}`,
        options: [
          { value: 'project', label: 'ktx project directory', hint: tempDir },
          { value: 'custom', label: 'Custom directory…', hint: 'Enter a path' },
          {
            value: 'global',
            label: 'Global scope (user config)',
            hint: 'Agents can load this ktx project from any working directory.',
          },
        ],
      });
    } finally {
      process.env.HOME = previousHome;
      await rm(home, { recursive: true, force: true });
    }
  });

  it('registers Claude Desktop MCP and ships an uploadable analytics skill zip', async () => {
    const home = await mkdtemp(join(tmpdir(), 'ktx-setup-agents-home-'));
    const previousHome = process.env.HOME;
    const envSnapshot = captureEnvKeys(process.env, ['OPENAI_API_KEY', 'ANTHROPIC_API_KEY']);
    const ktxEnvSnapshot = captureKtxEnv(process.env);
    process.env.HOME = home;
    clearEnvKeys(process.env, ['OPENAI_API_KEY', 'ANTHROPIC_API_KEY']);
    clearKtxEnv(process.env);
    try {
      const io = makeIo();

      await expect(
        runKtxSetupAgentsStep(
          {
            projectDir: tempDir,
            inputMode: 'disabled',
            yes: true,
            agents: true,
            target: 'claude-desktop',
            scope: 'project',
            mode: 'mcp',
            skipAgents: false,
          },
          io.io,
        ),
      ).resolves.toMatchObject({
        status: 'ready',
        installs: [{ target: 'claude-desktop', scope: 'global', mode: 'mcp' }],
      });

      const analyticsSkillPath = join(tempDir, '.ktx/agents/claude/ktx-analytics.zip');
      const adminSkillPath = join(tempDir, '.ktx/agents/claude/ktx.zip');
      const launcherPath = join(tempDir, '.ktx/agents/claude/ktx-plugin-runner.sh');
      await expect(stat(analyticsSkillPath)).resolves.toBeDefined();
      await expect(stat(adminSkillPath)).rejects.toThrow();
      await expect(stat(launcherPath)).rejects.toThrow();

      const configPath = join(home, 'Library/Application Support/Claude/claude_desktop_config.json');
      const config = JSON.parse(await readFile(configPath, 'utf-8')) as {
        mcpServers: { ktx: { command: string; args: string[]; env?: Record<string, string> } };
      };
      expect(config.mcpServers.ktx).toEqual({
        command: process.execPath,
        args: [expect.stringContaining('bin.js'), '--project-dir', tempDir, 'mcp', 'stdio'],
      });

      expect(await readZipText(analyticsSkillPath, 'ktx-analytics/SKILL.md')).toContain('ktx Analytics Workflow');
      await expect(readZipText(analyticsSkillPath, 'ktx/SKILL.md')).rejects.toThrow('Missing zip entry');
      await expect(readZipText(analyticsSkillPath, '.claude-plugin/plugin.json')).rejects.toThrow('Missing zip entry');
      await expect(readZipText(analyticsSkillPath, 'skills/ktx-analytics/SKILL.md')).rejects.toThrow(
        'Missing zip entry',
      );

      expect(io.stdout()).toContain('Claude Desktop');
      expect(io.stdout()).toContain(analyticsSkillPath);
      expect(io.stdout()).not.toContain(adminSkillPath);
      expect(io.stdout()).toContain('claude_desktop_config.json');
      expect(io.stdout()).toContain('Required before using agents');
      expect(io.stdout()).toContain('1. Restart Claude Desktop');
      expect(io.stdout()).toContain('Claude Desktop loads ktx MCP after restart.');
      expect(io.stdout()).toContain('2. Upload Claude Desktop skills');
      expect(io.stdout()).toContain('Customize > Skills > + > Create skill > Upload a skill');
      expect(io.stdout()).toContain('Upload this file:');
      expect(io.stdout()).toContain('Toggle the uploaded ktx skills on.');
      expect(io.stdout()).not.toContain('Run `ktx mcp start`');
    } finally {
      process.env.HOME = previousHome;
      restoreEnvKeys(process.env, envSnapshot);
      restoreEnvKeys(process.env, ktxEnvSnapshot);
      await rm(home, { recursive: true, force: true });
    }
  });

  it('captures KTX_*, OPENAI_API_KEY, and ANTHROPIC_API_KEY into the Claude Desktop MCP env block', async () => {
    const home = await mkdtemp(join(tmpdir(), 'ktx-setup-agents-home-'));
    const previousHome = process.env.HOME;
    const envSnapshot = captureEnvKeys(process.env, [
      'OPENAI_API_KEY',
      'ANTHROPIC_API_KEY',
      'KTX_LOG_LEVEL',
    ]);
    const ktxEnvSnapshot = captureKtxEnv(process.env);
    process.env.HOME = home;
    clearKtxEnv(process.env);
    process.env.OPENAI_API_KEY = 'sk-test-openai'; // pragma: allowlist secret
    process.env.ANTHROPIC_API_KEY = 'sk-ant-test'; // pragma: allowlist secret
    process.env.KTX_LOG_LEVEL = 'debug';
    try {
      const io = makeIo();
      await runKtxSetupAgentsStep(
        {
          projectDir: tempDir,
          inputMode: 'disabled',
          yes: true,
          agents: true,
          target: 'claude-desktop',
          scope: 'project',
          mode: 'mcp',
          skipAgents: false,
        },
        io.io,
      );

      const configPath = join(home, 'Library/Application Support/Claude/claude_desktop_config.json');
      const config = JSON.parse(await readFile(configPath, 'utf-8')) as {
        mcpServers: { ktx: { env?: Record<string, string> } };
      };
      expect(config.mcpServers.ktx.env).toEqual({
        OPENAI_API_KEY: 'sk-test-openai', // pragma: allowlist secret
        ANTHROPIC_API_KEY: 'sk-ant-test', // pragma: allowlist secret
        KTX_LOG_LEVEL: 'debug',
      });
    } finally {
      process.env.HOME = previousHome;
      restoreEnvKeys(process.env, envSnapshot);
      restoreEnvKeys(process.env, ktxEnvSnapshot);
      await rm(home, { recursive: true, force: true });
    }
  });

  it('includes an uploadable admin CLI skill zip for Claude Desktop when requested', async () => {
    const home = await mkdtemp(join(tmpdir(), 'ktx-setup-agents-home-'));
    const previousHome = process.env.HOME;
    process.env.HOME = home;
    try {
      const io = makeIo();

      await expect(
        runKtxSetupAgentsStep(
          {
            projectDir: tempDir,
            inputMode: 'disabled',
            yes: true,
            agents: true,
            target: 'claude-desktop',
            scope: 'project',
            mode: 'mcp-cli',
            skipAgents: false,
          },
          io.io,
        ),
      ).resolves.toMatchObject({
        status: 'ready',
        installs: [{ target: 'claude-desktop', scope: 'global', mode: 'mcp-cli' }],
      });

      const analyticsSkillPath = join(tempDir, '.ktx/agents/claude/ktx-analytics.zip');
      const adminSkillPath = join(tempDir, '.ktx/agents/claude/ktx.zip');
      expect(await readZipText(analyticsSkillPath, 'ktx-analytics/SKILL.md')).toContain('ktx Analytics Workflow');
      await expect(readZipText(analyticsSkillPath, 'ktx/SKILL.md')).rejects.toThrow('Missing zip entry');
      const adminSkill = await readZipText(adminSkillPath, 'ktx/SKILL.md');
      expect(adminSkill).toContain(`--project-dir ${tempDir}`);
      expect(adminSkill).toContain('status --json');
      await expect(readZipText(adminSkillPath, '.mcp.json')).rejects.toThrow('Missing zip entry');
      await expect(readZipText(adminSkillPath, 'ktx-analytics/SKILL.md')).rejects.toThrow('Missing zip entry');
      expect(io.stdout()).toContain(analyticsSkillPath);
      expect(io.stdout()).toContain(adminSkillPath);
      expect(io.stdout()).toContain('Upload each file separately:');
    } finally {
      process.env.HOME = previousHome;
      await rm(home, { recursive: true, force: true });
    }
  });

  it('installs MCP client config and analytics skill without admin CLI files', async () => {
    const io = makeIo();

    await expect(
      runKtxSetupAgentsStep(
        {
          projectDir: tempDir,
          inputMode: 'disabled',
          yes: true,
          agents: true,
          target: 'claude-code',
          scope: 'project',
          mode: 'mcp',
          skipAgents: false,
        },
        io.io,
      ),
    ).resolves.toMatchObject({
      status: 'ready',
      installs: [{ target: 'claude-code', scope: 'project', mode: 'mcp' }],
    });

    const mcpJson = JSON.parse(await readFile(join(tempDir, '.mcp.json'), 'utf-8')) as {
      mcpServers: { ktx: { type: string; url: string } };
    };
    expect(mcpJson.mcpServers.ktx).toEqual({ type: 'http', url: 'http://localhost:7878/mcp' });
    await expect(stat(join(tempDir, '.claude/skills/ktx-analytics/SKILL.md'))).resolves.toBeDefined();
    await expect(stat(join(tempDir, '.claude/skills/ktx/SKILL.md'))).rejects.toThrow();
    await expect(stat(join(tempDir, '.claude/rules/ktx.md'))).rejects.toThrow();
  });

  it('writes Cursor project MCP config', async () => {
    const io = makeIo();

    await runKtxSetupAgentsStep(
      {
        projectDir: tempDir,
        inputMode: 'disabled',
        yes: true,
        agents: true,
        target: 'cursor',
        scope: 'project',
        mode: 'mcp-cli',
        skipAgents: false,
      },
      io.io,
    );

    const cursorJson = JSON.parse(await readFile(join(tempDir, '.cursor/mcp.json'), 'utf-8')) as {
      mcpServers: { ktx: { url: string; headers?: Record<string, string> } };
    };
    expect(cursorJson.mcpServers.ktx).toEqual({ url: 'http://localhost:7878/mcp' });
  });

  it('prints Codex, opencode, and universal snippets without mutating printed-only config files', async () => {
    const codexIo = makeIo();
    await runKtxSetupAgentsStep(
      {
        projectDir: tempDir,
        inputMode: 'disabled',
        yes: true,
        agents: true,
        target: 'codex',
        scope: 'project',
        mode: 'mcp-cli',
        skipAgents: false,
      },
      codexIo.io,
    );
    expect(codexIo.stdout()).toContain('[mcp_servers.ktx]');
    expect(codexIo.stdout()).toContain('url = "http://localhost:7878/mcp"');
    expect(codexIo.stdout()).toContain('1. Configure Codex');
    expect(codexIo.stdout()).toContain('Open ~/.codex/config.toml, then paste this block:');
    expect(codexIo.stdout()).toContain('PASTE:');

    const opencodeIo = makeIo();
    await runKtxSetupAgentsStep(
      {
        projectDir: tempDir,
        inputMode: 'disabled',
        yes: true,
        agents: true,
        target: 'opencode',
        scope: 'project',
        mode: 'mcp-cli',
        skipAgents: false,
      },
      opencodeIo.io,
    );
    expect(opencodeIo.stdout()).toContain('"mcp"');
    expect(opencodeIo.stdout()).toContain('"type": "remote"');
    expect(opencodeIo.stdout()).toContain('1. Configure OpenCode');
    expect(opencodeIo.stdout()).toContain('Open opencode.json, then paste this block:');
    await expect(readFile(join(tempDir, 'opencode.json'), 'utf-8')).rejects.toThrow();

    const universalIo = makeIo();
    await runKtxSetupAgentsStep(
      {
        projectDir: tempDir,
        inputMode: 'disabled',
        yes: true,
        agents: true,
        target: 'universal',
        scope: 'project',
        mode: 'mcp',
        skipAgents: false,
      },
      universalIo.io,
    );
    expect(universalIo.stdout()).toContain('Universal MCP endpoint:');
    expect(universalIo.stdout()).toContain('http://localhost:7878/mcp');
    expect(universalIo.stdout()).toContain('1. Configure unsupported MCP clients');
    expect(universalIo.stdout()).toContain('Use this endpoint when setting up unsupported MCP clients:');
  });

  it('uses MCP daemon state for port and token metadata without rendering literal tokens', async () => {
    await mkdir(join(tempDir, '.ktx'), { recursive: true });
    await writeFile(
      join(tempDir, '.ktx/mcp.json'),
      `${JSON.stringify(
        {
          schemaVersion: 1,
          pid: 999999,
          host: '127.0.0.1',
          port: 8787,
          tokenAuth: true,
          projectDir: tempDir,
          startedAt: '2026-05-14T00:00:00.000Z',
          logPath: join(tempDir, '.ktx/logs/mcp.log'),
        },
        null,
        2,
      )}\n`,
      'utf-8',
    );
    const io = makeIo();
    const previousToken = process.env.KTX_MCP_TOKEN;
    process.env.KTX_MCP_TOKEN = 'secret-token';

    try {
      await runKtxSetupAgentsStep(
        {
          projectDir: tempDir,
          inputMode: 'disabled',
          yes: true,
          agents: true,
          target: 'claude-code',
          scope: 'project',
          mode: 'mcp-cli',
          skipAgents: false,
        },
        io.io,
      );

      const rendered = JSON.stringify(JSON.parse(await readFile(join(tempDir, '.mcp.json'), 'utf-8')));
      expect(rendered).toContain('http://127.0.0.1:8787/mcp');
      expect(rendered).toContain('Bearer ${KTX_MCP_TOKEN}');
      expect(rendered).not.toContain('secret-token');
      expect(io.stdout()).toContain('Run this command before using Claude Code:');
      expect(io.stdout()).toContain('RUN:');
      expect(io.stdout()).toContain(`ktx mcp start --project-dir ${tempDir}`);
    } finally {
      if (previousToken === undefined) {
        delete process.env.KTX_MCP_TOKEN;
      } else {
        process.env.KTX_MCP_TOKEN = previousToken;
      }
    }
  });

  it('writes Claude Code local MCP config under the project key in ~/.claude.json', async () => {
    const home = await mkdtemp(join(tmpdir(), 'ktx-setup-agents-home-'));
    const previousHome = process.env.HOME;
    process.env.HOME = home;
    try {
      const io = makeIo();
      await runKtxSetupAgentsStep(
        {
          projectDir: tempDir,
          inputMode: 'disabled',
          yes: true,
          agents: true,
          target: 'claude-code',
          scope: 'local',
          mode: 'mcp-cli',
          skipAgents: false,
        },
        io.io,
      );

      const config = JSON.parse(await readFile(join(home, '.claude.json'), 'utf-8')) as {
        projects: Record<string, { mcpServers: { ktx: { type: string; url: string } } }>;
      };
      expect(config.projects[tempDir].mcpServers.ktx).toEqual({ type: 'http', url: 'http://localhost:7878/mcp' });
    } finally {
      process.env.HOME = previousHome;
      await rm(home, { recursive: true, force: true });
    }
  });

  it('removes only manifest-listed files', async () => {
    const io = makeIo();
    await runKtxSetupAgentsStep(
      {
        projectDir: tempDir,
        inputMode: 'disabled',
        yes: true,
          agents: true,
          target: 'claude-code',
          scope: 'project',
          mode: 'mcp-cli',
          skipAgents: false,
        },
      io.io,
    );
    await writeFile(join(tempDir, '.claude/skills/ktx/keep.txt'), 'user file', 'utf-8');

    await expect(removeKtxAgentInstall(tempDir, io.io)).resolves.toBe(0);

    await expect(stat(join(tempDir, '.claude/skills/ktx/SKILL.md'))).rejects.toThrow();
    await expect(stat(join(tempDir, '.claude/rules/ktx.md'))).rejects.toThrow();
    await expect(stat(join(tempDir, '.claude/skills/ktx/keep.txt'))).resolves.toBeDefined();
    await expect(readKtxAgentInstallManifest(tempDir)).resolves.toEqual(null);
  });

  it('removes generated Claude Desktop skill zips from the manifest', async () => {
    const home = await mkdtemp(join(tmpdir(), 'ktx-setup-agents-home-'));
    const previousHome = process.env.HOME;
    process.env.HOME = home;
    try {
      const io = makeIo();
      await runKtxSetupAgentsStep(
        {
          projectDir: tempDir,
          inputMode: 'disabled',
          yes: true,
          agents: true,
          target: 'claude-desktop',
          scope: 'project',
          mode: 'mcp-cli',
          skipAgents: false,
        },
        io.io,
      );
      const analyticsSkillPath = join(tempDir, '.ktx/agents/claude/ktx-analytics.zip');
      const adminSkillPath = join(tempDir, '.ktx/agents/claude/ktx.zip');
      const launcherPath = join(tempDir, '.ktx/agents/claude/ktx-plugin-runner.sh');
      const configPath = join(home, 'Library/Application Support/Claude/claude_desktop_config.json');
      await expect(stat(analyticsSkillPath)).resolves.toBeDefined();
      await expect(stat(adminSkillPath)).resolves.toBeDefined();
      await expect(stat(launcherPath)).rejects.toThrow();
      const beforeConfig = JSON.parse(await readFile(configPath, 'utf-8')) as {
        mcpServers: Record<string, unknown>;
      };
      expect(beforeConfig.mcpServers.ktx).toBeDefined();

      await expect(removeKtxAgentInstall(tempDir, io.io)).resolves.toBe(0);

      await expect(stat(analyticsSkillPath)).rejects.toThrow();
      await expect(stat(adminSkillPath)).rejects.toThrow();
      const afterConfig = JSON.parse(await readFile(configPath, 'utf-8')) as {
        mcpServers: Record<string, unknown>;
      };
      expect(afterConfig.mcpServers.ktx).toBeUndefined();
      await expect(readKtxAgentInstallManifest(tempDir)).resolves.toEqual(null);
    } finally {
      process.env.HOME = previousHome;
      await rm(home, { recursive: true, force: true });
    }
  });

  it('treats cancel as skip in interactive mode', async () => {
    const io = makeIo();
    const prompts = {
      select: vi.fn(async () => 'back'),
      multiselect: vi.fn(async () => ['codex']),
      text: vi.fn(async () => undefined),
      cancel: vi.fn(),
    };

    await expect(
      runKtxSetupAgentsStep(
        {
          projectDir: tempDir,
          inputMode: 'auto',
          yes: false,
          agents: true,
          scope: 'project',
          mode: 'mcp-cli',
          skipAgents: false,
        },
        io.io,
        { prompts },
      ),
    ).resolves.toEqual({ status: 'skipped', projectDir: tempDir });
  });

  it('wraps the agent target prompt with the navigation hint and prints no separate hint line', async () => {
    const io = makeIo();
    const prompts = {
      select: vi.fn(async () => 'mcp-cli'),
      multiselect: vi.fn(async () => ['back']),
      text: vi.fn(async () => undefined),
      cancel: vi.fn(),
    };

    await expect(
      runKtxSetupAgentsStep(
        {
          projectDir: tempDir,
          inputMode: 'auto',
          yes: false,
          agents: true,
          scope: 'project',
          mode: 'mcp-cli',
          skipAgents: false,
        },
        io.io,
        { prompts },
      ),
    ).resolves.toEqual({ status: 'back', projectDir: tempDir });

    expect(prompts.multiselect).toHaveBeenCalledWith(
      expect.objectContaining({
        message:
          'Which agent targets should ktx install?\n' +
          'Up/Down to move, Tab to select or unselect, Enter to confirm, Escape to go back, Ctrl+C to exit.',
      }),
    );
    expect(io.stdout()).not.toContain('Space to select');
  });

  it('prints per-agent install summary after successful installation', async () => {
    const io = makeIo();

    await runKtxSetupAgentsStep(
      {
        projectDir: tempDir,
        inputMode: 'disabled',
        yes: true,
        agents: true,
        target: 'claude-code',
        scope: 'project',
        mode: 'mcp-cli',
        skipAgents: false,
      },
      io.io,
    );

    const output = io.stdout();
    expect(output).toContain('Claude Code · Project scope');
    expect(output).toContain(join(tempDir, '.mcp.json'));
    expect(output).toContain('Requires MCP to be started.');
    expect(output).toContain('Analytics skill installed.');
    expect(output).toContain('Admin CLI skill installed.');
    expect(output).not.toContain('Agent integration complete');
    expect(output).not.toContain(`ktx project\n  ${tempDir}`);
    expect(output).not.toContain('Installed agents');
    expect(output).not.toContain('.claude/skills/ktx-analytics/SKILL.md');
    expect(output).not.toContain('.claude/skills/ktx/SKILL.md');
    expect(output).not.toContain('.claude/rules/ktx.md');
  });

  it('formats summary with explicit project-scoped config paths', () => {
    const summary = formatInstallSummaryLines(
      [{ target: 'cursor', scope: 'project', mode: 'mcp-cli' }],
      [
        { kind: 'file', path: join(tempDir, '.cursor/rules/ktx-analytics.mdc'), role: 'analytics-skill' },
        { kind: 'file', path: join(tempDir, '.cursor/rules/ktx.mdc') },
        { kind: 'json-key', path: join(tempDir, '.cursor/mcp.json'), jsonPath: ['mcpServers', 'ktx'] },
      ],
      tempDir,
    );

    expect(summary).toEqual([
      {
        title: 'Cursor · Project scope',
        lines: [
          join(tempDir, '.cursor/mcp.json'),
          'Requires MCP to be started.',
          'Cursor rules installed.',
        ],
      },
    ]);
  });

  it('formats summary with multiple agent targets', () => {
    const summary = formatInstallSummaryLines(
      [
        { target: 'claude-code', scope: 'project', mode: 'mcp-cli' },
        { target: 'codex', scope: 'project', mode: 'mcp-cli' },
      ],
      [
        { kind: 'file', path: join(tempDir, '.claude/skills/ktx-analytics/SKILL.md'), role: 'analytics-skill' },
        { kind: 'file', path: join(tempDir, '.claude/skills/ktx/SKILL.md'), role: 'skill' },
        { kind: 'file', path: join(tempDir, '.claude/rules/ktx.md'), role: 'rule' },
        { kind: 'json-key', path: join(tempDir, '.mcp.json'), jsonPath: ['mcpServers', 'ktx'] },
        { kind: 'file', path: join(tempDir, '.agents/skills/ktx-analytics/SKILL.md'), role: 'analytics-skill' },
        { kind: 'file', path: join(tempDir, '.agents/skills/ktx/SKILL.md'), role: 'skill' },
        { kind: 'file', path: join(tempDir, '.codex/instructions/ktx.md'), role: 'rule' },
      ],
      tempDir,
    );

    expect(summary).toEqual([
      {
        title: 'Claude Code · Project scope',
        lines: [
          join(tempDir, '.mcp.json'),
          'Requires MCP to be started.',
          'Analytics skill installed.',
          'Admin CLI skill installed.',
        ],
      },
      {
        title: 'Codex · Project scope',
        lines: [
          'Add the snippet shown below to ~/.codex/config.toml.',
          'Requires MCP to be started.',
          'Codex guidance installed.',
        ],
      },
    ]);
  });

  it('prints one target-aware next actions block for mixed agent targets', async () => {
    const home = await mkdtemp(join(tmpdir(), 'ktx-setup-agents-home-'));
    const previousHome = process.env.HOME;
    process.env.HOME = home;
    try {
      const io = makeIo();
      const prompts = {
        select: vi.fn(async ({ message }: { message: string }) =>
          message.startsWith('Where should') ? 'project' : 'mcp',
        ),
        multiselect: vi.fn(async () => ['claude-code', 'claude-desktop']),
        text: vi.fn(async () => undefined),
        cancel: vi.fn(),
      };

      await expect(
        runKtxSetupAgentsStep(
          {
            projectDir: tempDir,
            inputMode: 'auto',
            yes: false,
            agents: true,
            scope: 'project',
            mode: 'mcp',
            skipAgents: false,
          },
          io.io,
          { prompts },
        ),
      ).resolves.toMatchObject({
        status: 'ready',
        installs: [
          { target: 'claude-code', scope: 'project', mode: 'mcp' },
          { target: 'claude-desktop', scope: 'global', mode: 'mcp' },
        ],
      });

      const output = io.stdout();
      expect(output).toContain('Required before using agents');
      expect(output).not.toContain('Next actions');
      expect(output).toContain('1. Start MCP');
      expect(output).toContain('Run this command before using Claude Code:');
      expect(output).toContain(`ktx mcp start --project-dir ${tempDir}`);
      expect(output).toContain(`ktx mcp stop --project-dir ${tempDir}\n\n2. Open Claude Code`);
      expect(output).toContain('Open Claude Code from the ktx project directory');
      expect(output).toContain('RUN:');
      expect(output).toContain(`cd '${tempDir}'`);
      expect(output).toContain('3. Restart Claude Desktop');
      expect(output).toContain('Claude Desktop loads ktx MCP after restart.');
      expect(output).toContain('4. Upload Claude Desktop skills');
      expect(output).toContain('Customize > Skills > + > Create skill > Upload a skill');
      expect(output).toContain(join(tempDir, '.ktx/agents/claude/ktx-analytics.zip'));
      expect(output).not.toContain(join(tempDir, '.ktx/agents/claude/ktx.zip'));
      expect(output).toContain('Upload this file:');
      expect(output).toContain('All set.');
      expect(output).not.toContain('Finish Claude Desktop setup');
      expect(output).not.toContain('Run `ktx mcp start` to enable the configured ktx MCP server.');
    } finally {
      process.env.HOME = previousHome;
      await rm(home, { recursive: true, force: true });
    }
  });

  it('does not tell global Claude Code installs to open from the project directory', async () => {
    const home = await mkdtemp(join(tmpdir(), 'ktx-setup-agents-home-'));
    const previousHome = process.env.HOME;
    process.env.HOME = home;
    try {
      const io = makeIo();

      await expect(
        runKtxSetupAgentsStep(
          {
            projectDir: tempDir,
            inputMode: 'disabled',
            yes: true,
            agents: true,
            target: 'claude-code',
            scope: 'global',
            mode: 'mcp',
            skipAgents: false,
          },
          io.io,
        ),
      ).resolves.toMatchObject({
        status: 'ready',
        installs: [{ target: 'claude-code', scope: 'global', mode: 'mcp' }],
      });

      const output = io.stdout();
      expect(output).toContain('2. Open Claude Code');
      expect(output).toContain('RUN:');
      expect(output).toContain('claude');
      expect(output).not.toContain('Open Claude Code from the ktx project directory');
      expect(output).not.toContain(`cd '${tempDir}'`);
    } finally {
      process.env.HOME = previousHome;
      await rm(home, { recursive: true, force: true });
    }
  });

  it('explains next actions for Codex, Cursor, OpenCode, and universal MCP targets', async () => {
    const io = makeIo();
    const prompts = {
      select: vi.fn(async ({ message }: { message: string }) =>
        message.startsWith('Where') ? 'project' : 'mcp-cli',
      ),
      multiselect: vi.fn(async () => ['codex', 'cursor', 'opencode', 'universal']),
      text: vi.fn(async () => undefined),
      cancel: vi.fn(),
    };

    await expect(
      runKtxSetupAgentsStep(
        {
          projectDir: tempDir,
          inputMode: 'auto',
          yes: false,
          agents: true,
          scope: 'project',
          mode: 'mcp-cli',
          skipAgents: false,
        },
        io.io,
        { prompts },
      ),
    ).resolves.toMatchObject({
      status: 'ready',
      installs: [
        { target: 'codex', scope: 'project', mode: 'mcp-cli' },
        { target: 'cursor', scope: 'project', mode: 'mcp-cli' },
        { target: 'opencode', scope: 'project', mode: 'mcp-cli' },
        { target: 'universal', scope: 'project', mode: 'mcp-cli' },
      ],
    });

    const output = io.stdout();
    expect(output).toContain('Required before using agents');
    expect(output).toContain('1. Configure Codex');
    expect(output).toContain('2. Configure OpenCode');
    expect(output).toContain('3. Configure unsupported MCP clients');
    expect(output).toContain('4. Start MCP');
    expect(output).toContain('Run this command before using Codex, Cursor, OpenCode, and Universal .agents:');
    expect(output).toContain('Open Cursor from the ktx project directory');
    expect(output).toContain('Open ~/.codex/config.toml, then paste this block:\n\n  PASTE:\n  [mcp_servers.ktx]');
    expect(output).toContain('Open opencode.json, then paste this block:');
    expect(output).toContain('Use this endpoint when setting up unsupported MCP clients:');
    expect(output).toContain('Codex guidance installed');
    expect(output).toContain('Cursor rules installed');
    expect(output).toContain('OpenCode commands installed');
    expect(output).toContain('.agents guidance installed');
  });

  describe('install root', () => {
    it('plans project-scoped files under installRoot, leaving projectDir as the default', () => {
      const installRoot = join(tempDir, 'opened-here');
      expect(
        plannedKtxAgentFiles({
          projectDir: tempDir,
          installRoot,
          target: 'claude-code',
          scope: 'project',
          mode: 'mcp-cli',
        }),
      ).toEqual([
        { kind: 'file', path: join(installRoot, '.claude/skills/ktx-analytics/SKILL.md'), role: 'analytics-skill' },
        { kind: 'file', path: join(installRoot, '.claude/skills/ktx/SKILL.md'), role: 'skill' },
        { kind: 'file', path: join(installRoot, '.claude/rules/ktx.md'), role: 'rule' },
      ]);

      expect(
        plannedKtxAgentFiles({ projectDir: tempDir, target: 'claude-code', scope: 'project', mode: 'mcp' }),
      ).toEqual([
        { kind: 'file', path: join(tempDir, '.claude/skills/ktx-analytics/SKILL.md'), role: 'analytics-skill' },
      ]);
    });

    it('shows the install path in the summary title only when installRoot differs from projectDir', () => {
      const installRoot = join(tempDir, 'app');
      const custom = formatInstallSummaryLines(
        [{ target: 'claude-code', scope: 'project', mode: 'mcp', installRoot }],
        [
          { kind: 'file', path: join(installRoot, '.claude/skills/ktx-analytics/SKILL.md'), role: 'analytics-skill' },
          { kind: 'json-key', path: join(installRoot, '.mcp.json'), jsonPath: ['mcpServers', 'ktx'] },
        ],
        tempDir,
      );
      expect(custom[0].title).toBe(`Claude Code · ${installRoot}`);

      const same = formatInstallSummaryLines(
        [{ target: 'claude-code', scope: 'project', mode: 'mcp', installRoot: tempDir }],
        [],
        tempDir,
      );
      expect(same[0].title).toBe('Claude Code · Project scope');
    });

    it('installs project files and next actions under an explicit installRoot', async () => {
      const io = makeIo();
      const installRoot = join(tempDir, 'workspace');

      const result = await runKtxSetupAgentsStep(
        {
          projectDir: tempDir,
          inputMode: 'disabled',
          yes: true,
          agents: true,
          target: 'claude-code',
          scope: 'project',
          mode: 'mcp-cli',
          skipAgents: false,
          installRoot,
        },
        io.io,
      );

      expect(result).toMatchObject({
        status: 'ready',
        installs: [{ target: 'claude-code', scope: 'project', mode: 'mcp-cli', installRoot }],
      });
      await expect(stat(join(installRoot, '.claude/skills/ktx/SKILL.md'))).resolves.toBeDefined();
      const mcp = JSON.parse(await readFile(join(installRoot, '.mcp.json'), 'utf-8')) as {
        mcpServers?: Record<string, unknown>;
      };
      expect(mcp.mcpServers).toHaveProperty('ktx');
      await expect(stat(join(tempDir, '.claude/skills/ktx/SKILL.md'))).rejects.toThrow();

      const output = io.stdout();
      expect(output).toContain('Open Claude Code from the install directory:');
      expect(output).toContain(`cd '${installRoot}'`);
      expect(output).toContain(`ktx mcp start --project-dir ${tempDir}`);

      expect(await readKtxAgentInstallManifest(tempDir)).toMatchObject({
        projectDir: tempDir,
        installs: [{ target: 'claude-code', scope: 'project', mode: 'mcp-cli', installRoot }],
      });
    });

    it('fails when an explicit installRoot points at an existing file', async () => {
      const io = makeIo();
      const filePath = join(tempDir, 'not-a-dir');
      await writeFile(filePath, 'x', 'utf-8');

      await expect(
        runKtxSetupAgentsStep(
          {
            projectDir: tempDir,
            inputMode: 'disabled',
            yes: true,
            agents: true,
            target: 'claude-code',
            scope: 'project',
            mode: 'mcp',
            skipAgents: false,
            installRoot: filePath,
          },
          io.io,
        ),
      ).resolves.toEqual({ status: 'failed', projectDir: tempDir });
      expect(io.stderr()).toContain('is a file, not a directory');
    });

    it('installs into the current directory and records it in the manifest', async () => {
      const io = makeIo();
      const openedDir = join(tempDir, 'opened');
      await mkdir(openedDir, { recursive: true });
      const prompts = {
        select: vi.fn(async ({ message }: { message: string }) =>
          message.startsWith('Where') ? 'current' : 'mcp',
        ),
        multiselect: vi.fn(async () => ['claude-code', 'cursor']),
        text: vi.fn(async () => undefined),
        cancel: vi.fn(),
      };

      const result = await runKtxSetupAgentsStep(
        {
          projectDir: tempDir,
          inputMode: 'auto',
          yes: false,
          agents: true,
          scope: 'project',
          mode: 'mcp',
          skipAgents: false,
          cwd: openedDir,
        },
        io.io,
        { prompts },
      );

      expect(result).toMatchObject({
        status: 'ready',
        installs: [
          { target: 'claude-code', scope: 'project', mode: 'mcp', installRoot: openedDir },
          { target: 'cursor', scope: 'project', mode: 'mcp', installRoot: openedDir },
        ],
      });
      await expect(stat(join(openedDir, '.claude/skills/ktx-analytics/SKILL.md'))).resolves.toBeDefined();
      await expect(stat(join(openedDir, '.cursor/mcp.json'))).resolves.toBeDefined();

      const output = io.stdout();
      expect(output).toContain('Open Cursor from the install directory:');
      expect(output).toContain(openedDir);

      expect(await readKtxAgentInstallManifest(tempDir)).toMatchObject({
        installs: [
          { target: 'claude-code', scope: 'project', mode: 'mcp', installRoot: openedDir },
          { target: 'cursor', scope: 'project', mode: 'mcp', installRoot: openedDir },
        ],
      });
    });

    it('creates and installs into a typed custom directory', async () => {
      const io = makeIo();
      const customDir = join(tempDir, 'custom-target');
      const prompts = {
        select: vi.fn(async ({ message }: { message: string }) =>
          message.startsWith('Where') ? 'custom' : 'mcp',
        ),
        multiselect: vi.fn(async () => ['claude-code']),
        text: vi.fn(async () => customDir),
        cancel: vi.fn(),
      };

      const result = await runKtxSetupAgentsStep(
        {
          projectDir: tempDir,
          inputMode: 'auto',
          yes: false,
          agents: true,
          scope: 'project',
          mode: 'mcp',
          skipAgents: false,
          cwd: tempDir,
        },
        io.io,
        { prompts },
      );

      expect(result).toMatchObject({
        status: 'ready',
        installs: [{ target: 'claude-code', scope: 'project', mode: 'mcp', installRoot: customDir }],
      });
      await expect(stat(join(customDir, '.claude/skills/ktx-analytics/SKILL.md'))).resolves.toBeDefined();
    });

    it('hides the current directory row when cwd equals the ktx project directory', async () => {
      const io = makeIo();
      const prompts = {
        select: vi.fn(async ({ message }: { message: string; options: Array<{ value: string }> }) =>
          message.startsWith('Where') ? 'project' : 'mcp',
        ),
        multiselect: vi.fn(async () => ['claude-code']),
        text: vi.fn(async () => undefined),
        cancel: vi.fn(),
      };

      await runKtxSetupAgentsStep(
        {
          projectDir: tempDir,
          inputMode: 'auto',
          yes: false,
          agents: true,
          scope: 'project',
          mode: 'mcp',
          skipAgents: false,
          cwd: tempDir,
        },
        io.io,
        { prompts },
      );

      const directoryCall = prompts.select.mock.calls.find(([opts]) => opts.message.startsWith('Where'));
      expect(directoryCall).toBeDefined();
      expect(directoryCall?.[0].options.map((option) => option.value)).toEqual(['project', 'custom', 'global']);
    });

    it('re-prompts when a typed custom directory is an existing file', async () => {
      const io = makeIo();
      const filePath = join(tempDir, 'afile');
      await writeFile(filePath, 'x', 'utf-8');
      const validDir = join(tempDir, 'valid');
      const prompts = {
        select: vi.fn(async ({ message }: { message: string }) =>
          message.startsWith('Where') ? 'custom' : 'mcp',
        ),
        multiselect: vi.fn(async () => ['claude-code']),
        text: vi.fn<() => Promise<string | undefined>>().mockResolvedValueOnce(filePath).mockResolvedValueOnce(validDir),
        cancel: vi.fn(),
      };

      const result = await runKtxSetupAgentsStep(
        {
          projectDir: tempDir,
          inputMode: 'auto',
          yes: false,
          agents: true,
          scope: 'project',
          mode: 'mcp',
          skipAgents: false,
          cwd: tempDir,
        },
        io.io,
        { prompts },
      );

      expect(result).toMatchObject({
        status: 'ready',
        installs: [{ target: 'claude-code', scope: 'project', mode: 'mcp', installRoot: validDir }],
      });
      expect(prompts.text).toHaveBeenCalledTimes(2);
      expect(io.stderr()).toContain('is a file, not a directory');
      await expect(stat(join(validDir, '.claude/skills/ktx-analytics/SKILL.md'))).resolves.toBeDefined();
    });

    it('expands a leading ~ in a typed custom directory', async () => {
      const home = await mkdtemp(join(tmpdir(), 'ktx-setup-agents-home-'));
      const previousHome = process.env.HOME;
      process.env.HOME = home;
      try {
        const io = makeIo();
        const prompts = {
          select: vi.fn(async ({ message }: { message: string }) =>
            message.startsWith('Where') ? 'custom' : 'mcp',
          ),
          multiselect: vi.fn(async () => ['claude-code']),
          text: vi.fn(async () => '~/opened-here'),
          cancel: vi.fn(),
        };

        const expected = join(home, 'opened-here');
        const result = await runKtxSetupAgentsStep(
          {
            projectDir: tempDir,
            inputMode: 'auto',
            yes: false,
            agents: true,
            scope: 'project',
            mode: 'mcp',
            skipAgents: false,
            cwd: tempDir,
          },
          io.io,
          { prompts },
        );

        expect(result).toMatchObject({
          status: 'ready',
          installs: [{ target: 'claude-code', scope: 'project', mode: 'mcp', installRoot: expected }],
        });
        await expect(stat(join(expected, '.claude/skills/ktx-analytics/SKILL.md'))).resolves.toBeDefined();
        await expect(stat(join(tempDir, '~'))).rejects.toThrow();
      } finally {
        process.env.HOME = previousHome;
        await rm(home, { recursive: true, force: true });
      }
    });

    it('expands a leading ~ in an explicit installRoot', async () => {
      const home = await mkdtemp(join(tmpdir(), 'ktx-setup-agents-home-'));
      const previousHome = process.env.HOME;
      process.env.HOME = home;
      try {
        const io = makeIo();
        const expected = join(home, 'flagged');

        const result = await runKtxSetupAgentsStep(
          {
            projectDir: tempDir,
            inputMode: 'disabled',
            yes: true,
            agents: true,
            target: 'claude-code',
            scope: 'project',
            mode: 'mcp',
            skipAgents: false,
            installRoot: '~/flagged',
            cwd: tempDir,
          },
          io.io,
        );

        expect(result).toMatchObject({
          status: 'ready',
          installs: [{ target: 'claude-code', scope: 'project', mode: 'mcp', installRoot: expected }],
        });
        await expect(stat(join(expected, '.claude/skills/ktx-analytics/SKILL.md'))).resolves.toBeDefined();
      } finally {
        process.env.HOME = previousHome;
        await rm(home, { recursive: true, force: true });
      }
    });
  });

  describe('createAgentNextActionsLineFormatter', () => {
    function makeColorStdout(): { write: (chunk: string) => boolean; hasColors: () => boolean } {
      return { write: () => true, hasColors: () => true };
    }

    function makePlainStdout(): { write: (chunk: string) => boolean; hasColors: () => boolean } {
      return { write: () => true, hasColors: () => false };
    }

    const ESC = String.fromCharCode(27);

    it('returns the line untouched when the stream cannot render colors', () => {
      const format = createAgentNextActionsLineFormatter(makePlainStdout());
      expect(format('2. Upload Claude Desktop skills')).toBe('2. Upload Claude Desktop skills');
      expect(format('  /tmp/ktx/.ktx/agents/claude/ktx.zip')).toBe('  /tmp/ktx/.ktx/agents/claude/ktx.zip');
    });

    it('styles step headings and aligns sub-prose under the title', () => {
      const format = createAgentNextActionsLineFormatter(makeColorStdout());
      const heading = format('2. Upload Claude Desktop skills');
      expect(heading).toContain(ESC);
      expect(heading).toContain('2');
      expect(heading).toContain('Upload Claude Desktop skills');
      expect(heading).not.toMatch(/^2\. /);

      const sub = format('  Toggle the uploaded ktx skills on.');
      expect(sub).toMatch(/^ {3}/);
      expect(sub).toContain('Toggle the uploaded ktx skills on.');
    });

    it('renders skill bundle .zip paths as bullets and shortens HOME to ~', () => {
      const previousHome = process.env.HOME;
      process.env.HOME = '/tmp/test-home';
      try {
        const format = createAgentNextActionsLineFormatter(makeColorStdout());
        const line = format('  /tmp/test-home/.ktx/agents/claude/ktx-analytics.zip');
        expect(line).toContain('•');
        expect(line).toContain('~/.ktx/agents/claude/ktx-analytics.zip');
        expect(line).not.toContain('/tmp/test-home/');
      } finally {
        if (previousHome === undefined) delete process.env.HOME;
        else process.env.HOME = previousHome;
      }
    });

    it('replaces breadcrumb separators with a typographic chevron', () => {
      const format = createAgentNextActionsLineFormatter(makeColorStdout());
      const line = format('  Open Claude Desktop: Customize > Skills > + > Create skill > Upload a skill.');
      expect(line).toContain('›');
      expect(line).not.toContain(' > ');
    });

    it('leaves already-styled lines untouched to avoid double-wrapping', () => {
      const format = createAgentNextActionsLineFormatter(makeColorStdout());
      const preStyled = `${ESC}[1m2. Already styled${ESC}[22m`;
      expect(format(preStyled)).toBe(preStyled);
    });
  });
});
