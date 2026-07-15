import { mkdir, mkdtemp, readFile, rm, stat, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { initKtxProject } from '../src/context/project/project.js';
import { parseKtxProjectConfig } from '../src/context/project/config.js';
import { readKtxSetupState, writeKtxSetupState } from '../src/context/project/setup-config.js';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  type KtxSetupModelPromptAdapter,
  runKtxSetupAnthropicModelStep,
} from '../src/setup-models.js';

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

function makeSpinnerEvents() {
  const events: string[] = [];
  const spinner = vi.fn(() => ({
    start: (msg: string) => events.push(`start:${msg}`),
    message: (msg: string) => events.push(`message:${msg}`),
    stop: (msg: string) => events.push(`stop:${msg}`),
    error: (msg: string) => events.push(`error:${msg}`),
  }));
  return { events, spinner };
}

function makePromptAdapter(options: {
  providerChoice?: string;
  selectValues?: string[];
  credentialChoice?: string;
  modelChoice?: string;
  textValues?: string[];
  passwordValue?: string;
  passwordValues?: Array<string | undefined>;
}): KtxSetupModelPromptAdapter {
  const selectValues = [...(options.selectValues ?? [])];
  const textValues = [...(options.textValues ?? [])];
  const passwordValues = [...(options.passwordValues ?? [])];
  let providerPromptCount = 0;
  const choose = async ({ message }: { message: string }) => {
    if (message.includes('LLM provider')) {
      providerPromptCount += 1;
      const nextProviderChoice = selectValues[0];
      if (
        nextProviderChoice === 'anthropic' ||
        nextProviderChoice === 'vertex' ||
        nextProviderChoice === 'claude-code' ||
        nextProviderChoice === 'codex' ||
        nextProviderChoice === 'back'
      ) {
        return selectValues.shift() ?? nextProviderChoice;
      }
      if (options.credentialChoice === 'back' && providerPromptCount > 1) {
        return 'back';
      }
      return options.providerChoice ?? 'anthropic';
    }
    const nextValue = selectValues.shift();
    if (nextValue) {
      return nextValue;
    }
    if (message.includes('Anthropic API key')) {
      return options.credentialChoice ?? 'env';
    }
    return options.modelChoice ?? 'claude-sonnet-4-6';
  };
  return {
    select: vi.fn(choose),
    autocomplete: vi.fn(choose),
    text: vi.fn(async () => textValues.shift() ?? ''),
    password: vi.fn(
      async () =>
        passwordValues.length > 0 ? passwordValues.shift() : options.passwordValue ?? 'sk-ant-pasted', // pragma: allowlist secret
    ),
    cancel: vi.fn(),
  };
}

const anthropicPreset = {
  default: 'claude-sonnet-4-6',
  triage: 'claude-haiku-4-5',
  candidateExtraction: 'claude-sonnet-4-6',
  curator: 'claude-opus-4-7',
  reconcile: 'claude-opus-4-7',
  repair: 'claude-haiku-4-5',
};

const claudeCodePreset = {
  default: 'sonnet',
  triage: 'haiku',
  candidateExtraction: 'sonnet',
  curator: 'opus',
  reconcile: 'opus',
  repair: 'haiku',
};

const codexPreset = {
  default: 'gpt-5.5',
  triage: 'gpt-5.5',
  candidateExtraction: 'gpt-5.5',
  curator: 'gpt-5.5',
  reconcile: 'gpt-5.5',
  repair: 'gpt-5.5',
};

describe('setup Anthropic model step', () => {
  let tempDir: string;

  beforeEach(async () => {
    tempDir = await mkdtemp(join(tmpdir(), 'ktx-setup-models-'));
    await initKtxProject({ projectDir: tempDir });
  });

  afterEach(async () => {
    await rm(tempDir, { recursive: true, force: true });
  });

  it('offers Anthropic provider paths in the preferred order', async () => {
    const prompts = makePromptAdapter({ providerChoice: 'back' });

    const result = await runKtxSetupAnthropicModelStep(
      { projectDir: tempDir, inputMode: 'auto', skipLlm: false },
      makeIo().io,
      { prompts, env: {} },
    );

    expect(result.status).toBe('back');
    expect(prompts.select).toHaveBeenCalledWith(
      expect.objectContaining({
        message: expect.stringContaining('Which LLM provider should ktx use?'),
        options: [
          { value: 'claude-code', label: 'Claude subscription (Pro/Max)' },
          { value: 'codex', label: 'Codex subscription' },
          { value: 'openai-compatible', label: 'OpenAI-compatible endpoint (base URL + API key)' },
          { value: 'anthropic', label: 'Anthropic API key' },
          { value: 'vertex', label: 'Google Vertex AI for Anthropic Claude' },
          { value: 'back', label: 'Back' },
        ],
      }),
    );
  });

  it('configures the openai-compatible backend from flags and persists the provider block', async () => {
    const io = makeIo();
    const healthCheck = vi.fn(async () => ({ ok: true as const }));
    const { spinner } = makeSpinnerEvents();

    const result = await runKtxSetupAnthropicModelStep(
      {
        projectDir: tempDir,
        inputMode: 'disabled',
        llmBackend: 'openai-compatible',
        llmBaseUrl: 'https://maas.example/compatible-mode/v1',
        llmModel: 'qwen3.7-max',
        llmApiKeyEnv: 'KTX_MAAS_KEY',
        skipLlm: false,
      },
      io.io,
      { env: { KTX_MAAS_KEY: 'sk-maas' }, healthCheck, spinner }, // pragma: allowlist secret
    );

    expect(result.status).toBe('ready');
    expect(healthCheck).toHaveBeenCalledTimes(1);
    expect(healthCheck).toHaveBeenCalledWith(
      expect.objectContaining({
        backend: 'openai-compatible',
        openaiCompatible: { baseURL: 'https://maas.example/compatible-mode/v1', apiKey: 'sk-maas' }, // pragma: allowlist secret
        modelSlots: { default: 'qwen3.7-max' },
      }),
    );
    const config = parseKtxProjectConfig(await readFile(join(tempDir, 'ktx.yaml'), 'utf-8'));
    expect(config.llm.provider).toMatchObject({
      backend: 'openai-compatible',
      openaiCompatible: { api_key: 'env:KTX_MAAS_KEY', base_url: 'https://maas.example/compatible-mode/v1' }, // pragma: allowlist secret
    });
    expect(config.llm.models.default).toBe('qwen3.7-max');
    expect(config.llm.models.curator).toBe('qwen3.7-max');
    expect(config.scan.enrichment.mode).toBe('llm');
  });

  it('requires the openai-compatible base URL in non-interactive mode', async () => {
    const io = makeIo();
    const result = await runKtxSetupAnthropicModelStep(
      { projectDir: tempDir, inputMode: 'disabled', llmBackend: 'openai-compatible', llmModel: 'qwen3.7-max', skipLlm: false },
      io.io,
      { env: {} },
    );
    expect(result.status).toBe('missing-input');
    expect(io.stderr()).toContain('Missing OpenAI-compatible base URL');
  });

  it('requires the openai-compatible model in non-interactive mode', async () => {
    const io = makeIo();
    const result = await runKtxSetupAnthropicModelStep(
      {
        projectDir: tempDir,
        inputMode: 'disabled',
        llmBackend: 'openai-compatible',
        llmBaseUrl: 'https://maas.example/v1',
        skipLlm: false,
      },
      io.io,
      { env: {} },
    );
    expect(result.status).toBe('missing-input');
    expect(io.stderr()).toContain('Missing OpenAI-compatible model');
  });

  it('reports missing-input when the openai-compatible api key env var is unset', async () => {
    const io = makeIo();
    const result = await runKtxSetupAnthropicModelStep(
      {
        projectDir: tempDir,
        inputMode: 'disabled',
        llmBackend: 'openai-compatible',
        llmBaseUrl: 'https://maas.example/v1',
        llmModel: 'qwen3.7-max',
        llmApiKeyEnv: 'KTX_MAAS_KEY',
        skipLlm: false,
      },
      io.io,
      { env: {} },
    );
    expect(result.status).toBe('missing-input');
    expect(io.stderr()).toContain('KTX_MAAS_KEY is not set');
  });

  it('allows a keyless openai-compatible endpoint and omits api_key', async () => {
    const io = makeIo();
    const healthCheck = vi.fn(async () => ({ ok: true as const }));
    const { spinner } = makeSpinnerEvents();
    const result = await runKtxSetupAnthropicModelStep(
      {
        projectDir: tempDir,
        inputMode: 'disabled',
        llmBackend: 'openai-compatible',
        llmBaseUrl: 'http://localhost:8000/v1',
        llmModel: 'local-model',
        skipLlm: false,
      },
      io.io,
      { env: {}, healthCheck, spinner },
    );
    expect(result.status).toBe('ready');
    expect(healthCheck).toHaveBeenCalledWith(
      expect.objectContaining({
        backend: 'openai-compatible',
        openaiCompatible: { baseURL: 'http://localhost:8000/v1' },
        modelSlots: { default: 'local-model' },
      }),
    );
    const config = parseKtxProjectConfig(await readFile(join(tempDir, 'ktx.yaml'), 'utf-8'));
    expect(config.llm.provider).toMatchObject({
      backend: 'openai-compatible',
      openaiCompatible: { base_url: 'http://localhost:8000/v1' },
    });
    expect((config.llm.provider as { openaiCompatible?: { api_key?: string } }).openaiCompatible?.api_key).toBeUndefined();
  });

  it('fails when the openai-compatible health check fails in non-interactive mode', async () => {
    const io = makeIo();
    const healthCheck = vi.fn(async () => ({ ok: false as const, message: 'model not found' }));
    const { spinner } = makeSpinnerEvents();
    const result = await runKtxSetupAnthropicModelStep(
      {
        projectDir: tempDir,
        inputMode: 'disabled',
        llmBackend: 'openai-compatible',
        llmBaseUrl: 'https://maas.example/v1',
        llmModel: 'bad-model',
        llmApiKeyEnv: 'KTX_MAAS_KEY',
        skipLlm: false,
      },
      io.io,
      { env: { KTX_MAAS_KEY: 'sk-maas' }, healthCheck, spinner }, // pragma: allowlist secret
    );
    expect(result.status).toBe('failed');
    expect(io.stderr()).toContain('OpenAI-compatible model health check failed');
  });

  it('walks the interactive openai-compatible flow and persists provider config', async () => {
    const io = makeIo();
    const healthCheck = vi.fn(async () => ({ ok: true as const }));
    const { spinner } = makeSpinnerEvents();
    const textValues = ['https://maas.example/v1', 'DASHSCOPE_API_KEY', 'qwen3.7-max'];
    const prompts: KtxSetupModelPromptAdapter = {
      select: vi.fn(async ({ message }: { message: string }) => {
        if (message.includes('Which LLM provider')) {
          return 'openai-compatible';
        }
        if (message.includes('authenticate to the OpenAI-compatible endpoint')) {
          return 'env';
        }
        return 'back';
      }),
      autocomplete: vi.fn(async () => 'back'),
      text: vi.fn(async () => textValues.shift() ?? ''),
      password: vi.fn(async () => undefined),
      cancel: vi.fn(),
    };

    const result = await runKtxSetupAnthropicModelStep(
      { projectDir: tempDir, inputMode: 'auto', skipLlm: false },
      io.io,
      { prompts, healthCheck, spinner, env: { DASHSCOPE_API_KEY: 'sk-dash' } }, // pragma: allowlist secret
    );

    expect(result.status).toBe('ready');
    expect(healthCheck).toHaveBeenCalledWith(
      expect.objectContaining({
        backend: 'openai-compatible',
        openaiCompatible: { baseURL: 'https://maas.example/v1', apiKey: 'sk-dash' }, // pragma: allowlist secret
        modelSlots: { default: 'qwen3.7-max' },
      }),
    );
    const config = parseKtxProjectConfig(await readFile(join(tempDir, 'ktx.yaml'), 'utf-8'));
    expect(config.llm.provider).toMatchObject({
      backend: 'openai-compatible',
      openaiCompatible: { api_key: 'env:DASHSCOPE_API_KEY', base_url: 'https://maas.example/v1' }, // pragma: allowlist secret
    });
  });

  it('configures Claude Code backend and validates local auth', async () => {
    const io = makeIo();
    const authProbe = vi.fn(async () => ({ ok: true as const }));
    const { events: spinnerEvents, spinner } = makeSpinnerEvents();

    const result = await runKtxSetupAnthropicModelStep(
      {
        projectDir: tempDir,
        inputMode: 'disabled',
        llmBackend: 'claude-code',
        skipLlm: false,
      },
      io.io,
      { claudeCodeAuthProbe: authProbe, spinner },
    );

    expect(result.status).toBe('ready');
    const config = parseKtxProjectConfig(await readFile(join(tempDir, 'ktx.yaml'), 'utf-8'));
    expect(config.llm).toMatchObject({
      provider: { backend: 'claude-code' },
      models: claudeCodePreset,
    });
    expect(authProbe).toHaveBeenCalledTimes(3);
    expect(authProbe).toHaveBeenNthCalledWith(1, expect.objectContaining({ projectDir: tempDir, model: 'sonnet' }));
    expect(authProbe).toHaveBeenNthCalledWith(2, expect.objectContaining({ projectDir: tempDir, model: 'haiku' }));
    expect(authProbe).toHaveBeenNthCalledWith(3, expect.objectContaining({ projectDir: tempDir, model: 'opus' }));
    expect(spinnerEvents).toEqual([
      'start:Checking Claude subscription LLM (sonnet).',
      'stop:LLM test passed (Claude subscription, sonnet)',
      'start:Checking Claude subscription LLM (haiku).',
      'stop:LLM test passed (Claude subscription, haiku)',
      'start:Checking Claude subscription LLM (opus).',
      'stop:LLM test passed (Claude subscription, opus)',
    ]);
  });

  it('does not prompt for a Claude Code model during interactive setup', async () => {
    const io = makeIo();
    const prompts = makePromptAdapter({ selectValues: ['claude-code'] });
    const authProbe = vi.fn(async () => ({ ok: true as const }));
    const { spinner } = makeSpinnerEvents();

    const result = await runKtxSetupAnthropicModelStep(
      { projectDir: tempDir, inputMode: 'auto', skipLlm: false },
      io.io,
      { prompts, claudeCodeAuthProbe: authProbe, spinner },
    );

    expect(result.status).toBe('ready');
    expect(prompts.select).toHaveBeenCalledWith(
      expect.objectContaining({
        message: expect.stringContaining('Which LLM provider should ktx use?'),
      }),
    );
    expect(prompts.select).not.toHaveBeenCalledWith(
      expect.objectContaining({
        message: expect.stringContaining('Which Claude Code model should ktx use?'),
      }),
    );
    const config = parseKtxProjectConfig(await readFile(join(tempDir, 'ktx.yaml'), 'utf-8'));
    expect(config.llm.models).toMatchObject(claudeCodePreset);
  });

  it('configures Codex backend and validates local auth', async () => {
    const io = makeIo();
    const codexAuthProbe = vi.fn(async () => ({ ok: true as const }));
    const { events: spinnerEvents, spinner } = makeSpinnerEvents();

    const result = await runKtxSetupAnthropicModelStep(
      {
        projectDir: tempDir,
        inputMode: 'disabled',
        llmBackend: 'codex',
        skipLlm: false,
      },
      io.io,
      { codexAuthProbe, spinner },
    );

    expect(result.status).toBe('ready');
    const config = parseKtxProjectConfig(await readFile(join(tempDir, 'ktx.yaml'), 'utf-8'));
    expect(config.llm).toMatchObject({
      provider: { backend: 'codex' },
      models: codexPreset,
    });
    expect(codexAuthProbe).toHaveBeenCalledTimes(1);
    expect(codexAuthProbe).toHaveBeenCalledWith(expect.objectContaining({ projectDir: tempDir, model: 'gpt-5.5' }));
    expect(spinnerEvents).toEqual([
      'start:Checking Codex LLM (gpt-5.5).',
      'stop:LLM test passed (Codex, gpt-5.5)',
    ]);
    // The warning carries the clack gutter so it renders inside the setup frame.
    expect(io.stderr()).toContain('│  Codex backend isolation is limited');
    expect(io.stderr()).toContain('may still load user Codex config');
  });

  it('defaults the Codex model to gpt-5.5 when none is provided non-interactively', async () => {
    const io = makeIo();
    const codexAuthProbe = vi.fn(async () => ({ ok: true as const }));
    const { spinner } = makeSpinnerEvents();

    const result = await runKtxSetupAnthropicModelStep(
      {
        projectDir: tempDir,
        inputMode: 'disabled',
        llmBackend: 'codex',
        skipLlm: false,
      },
      io.io,
      { codexAuthProbe, spinner },
    );

    expect(result.status).toBe('ready');
    const config = parseKtxProjectConfig(await readFile(join(tempDir, 'ktx.yaml'), 'utf-8'));
    expect(config.llm).toMatchObject({
      provider: { backend: 'codex' },
      models: codexPreset,
    });
    expect(codexAuthProbe).toHaveBeenCalledTimes(1);
    expect(codexAuthProbe).toHaveBeenCalledWith(expect.objectContaining({ projectDir: tempDir, model: 'gpt-5.5' }));
  });

  it('warns during Claude Code setup when existing prompt-caching fields will be ignored', async () => {
    await writeFile(
      join(tempDir, 'ktx.yaml'),
      [
        'llm:',
        '  provider:',
        '    backend: anthropic',
        '  models:',
        '    default: claude-sonnet-4-6',
        '  promptCaching:',
        '    enabled: true',
        '    systemTtl: 1h',
        '    toolsTtl: 1h',
        '    historyTtl: 5m',
        '',
      ].join('\n'),
      'utf-8',
    );
    const io = makeIo();
    const { spinner } = makeSpinnerEvents();

    const result = await runKtxSetupAnthropicModelStep(
      {
        projectDir: tempDir,
        inputMode: 'disabled',
        llmBackend: 'claude-code',
        skipLlm: false,
      },
      io.io,
      {
        claudeCodeAuthProbe: async () => ({ ok: true as const }),
        spinner,
      },
    );

    expect(result.status).toBe('ready');
    expect(io.stderr()).toContain('claude-code ignores llm.promptCaching.systemTtl');
    expect(io.stderr()).toContain('Claude Agent SDK does not expose ktx prompt-cache TTL, tool, or history markers');
  });

  it('returns from Anthropic credential Back to provider selection', async () => {
    const prompts = makePromptAdapter({ selectValues: ['anthropic', 'back', 'back'] });

    const result = await runKtxSetupAnthropicModelStep(
      { projectDir: tempDir, inputMode: 'auto', skipLlm: false },
      makeIo().io,
      { prompts, env: {} },
    );

    expect(result.status).toBe('back');
    expect(prompts.select).toHaveBeenNthCalledWith(
      3,
      expect.objectContaining({
        message: expect.stringContaining('Which LLM provider should ktx use?'),
      }),
    );
  });

  it('configures env credentials, selected model, prompt caching, and llm completion state', async () => {
    const io = makeIo();
    const { events: spinnerEvents, spinner } = makeSpinnerEvents();
    const result = await runKtxSetupAnthropicModelStep(
      {
        projectDir: tempDir,
        inputMode: 'disabled',
        anthropicApiKeyEnv: 'ANTHROPIC_API_KEY', // pragma: allowlist secret
        skipLlm: false,
      },
      io.io,
      {
        env: { ANTHROPIC_API_KEY: 'sk-ant-test' }, // pragma: allowlist secret
        healthCheck: vi.fn(async () => ({ ok: true as const })),
        spinner,
      },
    );

    expect(result.status).toBe('ready');
    const config = parseKtxProjectConfig(await readFile(join(tempDir, 'ktx.yaml'), 'utf-8'));
    expect(config.llm).toMatchObject({
      provider: {
        backend: 'anthropic',
        anthropic: { api_key: 'env:ANTHROPIC_API_KEY' }, // pragma: allowlist secret
      },
      models: anthropicPreset,
      promptCaching: { enabled: true },
    });
    expect(config.scan.enrichment.mode).toBe('llm');
    expect(await readFile(join(tempDir, 'ktx.yaml'), 'utf-8')).not.toContain('completed_steps:');
    expect((await readKtxSetupState(tempDir)).completed_steps).toContain('llm');
    expect(spinnerEvents).toEqual([
      'start:Checking Anthropic API LLM (claude-sonnet-4-6).',
      'stop:LLM test passed (Anthropic API, claude-sonnet-4-6)',
      'start:Checking Anthropic API LLM (claude-haiku-4-5).',
      'stop:LLM test passed (Anthropic API, claude-haiku-4-5)',
      'start:Checking Anthropic API LLM (claude-opus-4-7).',
      'stop:LLM test passed (Anthropic API, claude-opus-4-7)',
    ]);
    expect(io.stdout()).toContain('LLM ready: yes');
    expect(io.stdout()).not.toContain('sk-ant-test');
  });

  it('degrades unavailable Anthropic non-anchor models to the anchor before persisting', async () => {
    const io = makeIo();
    const { events: spinnerEvents, spinner } = makeSpinnerEvents();
    const healthCheck = vi
      .fn()
      .mockResolvedValueOnce({ ok: true as const })
      .mockResolvedValueOnce({ ok: false as const, message: 'model not enabled' })
      .mockResolvedValueOnce({ ok: true as const });

    const result = await runKtxSetupAnthropicModelStep(
      {
        projectDir: tempDir,
        inputMode: 'disabled',
        anthropicApiKeyEnv: 'ANTHROPIC_API_KEY', // pragma: allowlist secret
        skipLlm: false,
      },
      io.io,
      {
        env: { ANTHROPIC_API_KEY: 'sk-ant-test' }, // pragma: allowlist secret
        healthCheck,
        spinner,
      },
    );

    expect(result.status).toBe('ready');
    const config = parseKtxProjectConfig(await readFile(join(tempDir, 'ktx.yaml'), 'utf-8'));
    expect(config.llm.models).toMatchObject({
      default: 'claude-sonnet-4-6',
      triage: 'claude-sonnet-4-6',
      candidateExtraction: 'claude-sonnet-4-6',
      curator: 'claude-opus-4-7',
      reconcile: 'claude-opus-4-7',
      repair: 'claude-sonnet-4-6',
    });
    expect(io.stderr()).toContain(
      'LLM model claude-haiku-4-5 is unavailable for triage, repair; using claude-sonnet-4-6 for those roles.',
    );
    expect(spinnerEvents).toEqual([
      'start:Checking Anthropic API LLM (claude-sonnet-4-6).',
      'stop:LLM test passed (Anthropic API, claude-sonnet-4-6)',
      'start:Checking Anthropic API LLM (claude-haiku-4-5).',
      'error:LLM test failed',
      'start:Checking Anthropic API LLM (claude-opus-4-7).',
      'stop:LLM test passed (Anthropic API, claude-opus-4-7)',
    ]);
  });

  it('configures Vertex AI provider, selected model, prompt caching, and llm completion state', async () => {
    const io = makeIo();
    const healthCheck = vi.fn(async () => ({ ok: true as const }));
    const { events: spinnerEvents, spinner } = makeSpinnerEvents();

    const result = await runKtxSetupAnthropicModelStep(
      {
        projectDir: tempDir,
        inputMode: 'disabled',
        llmBackend: 'vertex',
        vertexProject: 'local-gcp-project',
        vertexLocation: 'us-east5',
        skipLlm: false,
      },
      io.io,
      { env: {}, healthCheck, spinner },
    );

    expect(result.status).toBe('ready');
    expect(healthCheck).toHaveBeenNthCalledWith(1, {
      backend: 'vertex',
      vertex: { project: 'local-gcp-project', location: 'us-east5' },
      modelSlots: { default: 'claude-sonnet-4-6' },
      promptCaching: { enabled: true, vertexFallbackTo5m: true },
    });
    expect(healthCheck).toHaveBeenNthCalledWith(2, {
      backend: 'vertex',
      vertex: { project: 'local-gcp-project', location: 'us-east5' },
      modelSlots: { default: 'claude-haiku-4-5' },
      promptCaching: { enabled: true, vertexFallbackTo5m: true },
    });
    expect(healthCheck).toHaveBeenNthCalledWith(3, {
      backend: 'vertex',
      vertex: { project: 'local-gcp-project', location: 'us-east5' },
      modelSlots: { default: 'claude-opus-4-7' },
      promptCaching: { enabled: true, vertexFallbackTo5m: true },
    });
    const config = parseKtxProjectConfig(await readFile(join(tempDir, 'ktx.yaml'), 'utf-8'));
    expect(config.llm).toMatchObject({
      provider: {
        backend: 'vertex',
        vertex: { project: 'local-gcp-project', location: 'us-east5' },
      },
      models: anthropicPreset,
      promptCaching: { enabled: true, vertexFallbackTo5m: true },
    });
    expect(config.scan.enrichment.mode).toBe('llm');
    expect(await readFile(join(tempDir, 'ktx.yaml'), 'utf-8')).not.toContain('completed_steps:');
    expect((await readKtxSetupState(tempDir)).completed_steps).toContain('llm');
    expect(spinnerEvents).toEqual([
      'start:Checking Vertex AI LLM (claude-sonnet-4-6).',
      'stop:LLM test passed (Vertex AI, claude-sonnet-4-6)',
      'start:Checking Vertex AI LLM (claude-haiku-4-5).',
      'stop:LLM test passed (Vertex AI, claude-haiku-4-5)',
      'start:Checking Vertex AI LLM (claude-opus-4-7).',
      'stop:LLM test passed (Vertex AI, claude-opus-4-7)',
    ]);
    expect(io.stdout()).toContain('LLM ready: yes (claude-sonnet-4-6)');
  });

  it('uses existing Vertex AI credentials without an extra auth choice', async () => {
    const io = makeIo();
    const prompts = makePromptAdapter({ selectValues: ['vertex', 'local-gcp-project'] });
    const readGcloudProject = vi.fn(async () => 'local-gcp-project');
    const listGcloudProjects = vi.fn(async () => [
      { projectId: 'local-gcp-project', name: 'Local project' },
      { projectId: 'other-gcp-project', name: 'Other project' },
    ]);
    const healthCheck = vi.fn(async () => ({ ok: true as const }));

    const result = await runKtxSetupAnthropicModelStep(
      { projectDir: tempDir, inputMode: 'auto', skipLlm: false },
      io.io,
      {
        prompts,
        env: {},
        readGcloudProject,
        listGcloudProjects,
        healthCheck,
      },
    );

    expect(result.status).toBe('ready');
    expect(prompts.select).not.toHaveBeenCalledWith(
      expect.objectContaining({
        message: expect.stringContaining('How should ktx authenticate with Google Vertex AI?'),
      }),
    );
    expect(readGcloudProject).toHaveBeenCalled();
    expect(listGcloudProjects).toHaveBeenCalled();
    expect(prompts.text).not.toHaveBeenCalled();
    expect(prompts.autocomplete).toHaveBeenCalledWith(
      expect.objectContaining({
        message: expect.stringContaining('Which Google Cloud project should ktx use for Vertex AI?'),
        options: [
          { value: 'local-gcp-project', label: 'local-gcp-project - Local project (current gcloud project)' },
          { value: 'other-gcp-project', label: 'other-gcp-project - Other project' },
          { value: 'manual', label: 'Enter a project ID manually' },
          { value: 'back', label: 'Back' },
        ],
      }),
    );
    expect(healthCheck).toHaveBeenCalledWith({
      backend: 'vertex',
      vertex: { project: 'local-gcp-project', location: 'us-east5' },
      modelSlots: { default: 'claude-sonnet-4-6' },
      promptCaching: { enabled: true, vertexFallbackTo5m: true },
    });
    const config = parseKtxProjectConfig(await readFile(join(tempDir, 'ktx.yaml'), 'utf-8'));
    expect(config.llm.provider).toMatchObject({
      backend: 'vertex',
      vertex: { project: 'local-gcp-project', location: 'us-east5' },
    });
  });

  it('skips the Vertex AI auth choice when Application Default Credentials are the only option', async () => {
    const io = makeIo();
    const prompts = makePromptAdapter({ selectValues: ['vertex', 'local-gcp-project'] });
    const healthCheck = vi.fn(async () => ({ ok: true as const }));

    const result = await runKtxSetupAnthropicModelStep(
      { projectDir: tempDir, inputMode: 'auto', skipLlm: false },
      io.io,
      {
        prompts,
        env: {},
        readGcloudProject: vi.fn(async () => 'local-gcp-project'),
        listGcloudProjects: vi.fn(async () => [{ projectId: 'local-gcp-project', name: 'Local project' }]),
        healthCheck,
      },
    );

    expect(result.status).toBe('ready');
    expect(prompts.select).not.toHaveBeenCalledWith(
      expect.objectContaining({
        message: expect.stringContaining('How should ktx authenticate with Google Vertex AI?'),
      }),
    );
    expect(prompts.autocomplete).toHaveBeenCalledWith(
      expect.objectContaining({
        message: expect.stringContaining('Which Google Cloud project should ktx use for Vertex AI?'),
      }),
    );
    expect(healthCheck).toHaveBeenCalledWith(
      expect.objectContaining({
        backend: 'vertex',
        vertex: { project: 'local-gcp-project', location: 'us-east5' },
      }),
    );
  });

  it('lets users choose a different visible gcloud project for Vertex AI', async () => {
    const io = makeIo();
    const prompts = makePromptAdapter({ selectValues: ['vertex', 'other-gcp-project'] });
    const healthCheck = vi.fn(async () => ({ ok: true as const }));

    const result = await runKtxSetupAnthropicModelStep(
      { projectDir: tempDir, inputMode: 'auto', skipLlm: false },
      io.io,
      {
        prompts,
        env: {},
        readGcloudProject: vi.fn(async () => 'current-gcp-project'),
        listGcloudProjects: vi.fn(async () => [
          { projectId: 'current-gcp-project', name: 'Current project' },
          { projectId: 'other-gcp-project', name: 'Other project' },
        ]),
        healthCheck,
      },
    );

    expect(result.status).toBe('ready');
    expect(healthCheck).toHaveBeenCalledWith({
      backend: 'vertex',
      vertex: { project: 'other-gcp-project', location: 'us-east5' },
      modelSlots: { default: 'claude-sonnet-4-6' },
      promptCaching: { enabled: true, vertexFallbackTo5m: true },
    });
    const config = parseKtxProjectConfig(await readFile(join(tempDir, 'ktx.yaml'), 'utf-8'));
    expect(config.llm.provider).toMatchObject({
      backend: 'vertex',
      vertex: { project: 'other-gcp-project', location: 'us-east5' },
    });
  });

  it('allows manual Vertex AI project entry when gcloud project listing is empty', async () => {
    const io = makeIo();
    const prompts = makePromptAdapter({ selectValues: ['vertex', 'manual'], textValues: ['manual-gcp-project'] });
    const healthCheck = vi.fn(async () => ({ ok: true as const }));

    const result = await runKtxSetupAnthropicModelStep(
      { projectDir: tempDir, inputMode: 'auto', skipLlm: false },
      io.io,
      {
        prompts,
        env: {},
        readGcloudProject: vi.fn(async () => undefined),
        listGcloudProjects: vi.fn(async () => []),
        healthCheck,
      },
    );

    expect(result.status).toBe('ready');
    expect(prompts.autocomplete).toHaveBeenCalledWith(
      expect.objectContaining({
        message: expect.stringContaining('Which Google Cloud project should ktx use for Vertex AI?'),
        options: [
          { value: 'manual', label: 'Enter a project ID manually' },
          { value: 'back', label: 'Back' },
        ],
      }),
    );
    expect(prompts.text).toHaveBeenCalledWith(
      expect.objectContaining({
        message: 'Google Cloud project ID\n│  Press Escape to go back.\n│',
      }),
    );
    expect(healthCheck).toHaveBeenCalledWith(
      expect.objectContaining({
        vertex: { project: 'manual-gcp-project', location: 'us-east5' },
      }),
    );
  });

  it('lets users retry Vertex AI project listing after gcloud auth fails', async () => {
    const io = makeIo();
    const prompts = makePromptAdapter({ selectValues: ['vertex', 'retry', 'other-gcp-project'] });
    const listGcloudProjects = vi
      .fn()
      .mockRejectedValueOnce(new Error('Reauthentication failed. cannot prompt during non-interactive execution.'))
      .mockResolvedValueOnce([
        { projectId: 'local-gcp-project', name: 'Local project' },
        { projectId: 'other-gcp-project', name: 'Other project' },
      ]);
    const healthCheck = vi.fn(async () => ({ ok: true as const }));

    const result = await runKtxSetupAnthropicModelStep(
      { projectDir: tempDir, inputMode: 'auto', skipLlm: false },
      io.io,
      {
        prompts,
        env: {},
        readGcloudProject: vi.fn(async () => 'local-gcp-project'),
        listGcloudProjects,
        healthCheck,
      },
    );

    expect(result.status).toBe('ready');
    expect(listGcloudProjects).toHaveBeenCalledTimes(2);
    expect(prompts.autocomplete).toHaveBeenCalledWith(
      expect.objectContaining({
        message: expect.stringContaining('Could not list Google Cloud projects with gcloud'),
        options: expect.arrayContaining([{ value: 'retry', label: 'Retry loading Google Cloud projects' }]),
      }),
    );
    expect(prompts.autocomplete).toHaveBeenCalledWith(
      expect.objectContaining({
        message: expect.stringContaining(
          `${String.fromCharCode(0x1b)}[33mCould not list Google Cloud projects with gcloud`,
        ),
      }),
    );
    expect(prompts.autocomplete).toHaveBeenCalledWith(
      expect.objectContaining({
        message: expect.stringContaining('gcloud auth login --update-adc'),
      }),
    );
    expect(prompts.autocomplete).toHaveBeenCalledWith(
      expect.objectContaining({
        message: expect.stringContaining(
          `${String.fromCharCode(0x1b)}[33mRun \`gcloud auth login --update-adc\``,
        ),
      }),
    );
    expect(healthCheck).toHaveBeenCalledWith(
      expect.objectContaining({
        vertex: { project: 'other-gcp-project', location: 'us-east5' },
      }),
    );
  });

  it('returns from Vertex AI project selection Back to provider selection', async () => {
    const prompts = makePromptAdapter({ selectValues: ['vertex', 'back', 'back'] });

    const result = await runKtxSetupAnthropicModelStep(
      { projectDir: tempDir, inputMode: 'auto', skipLlm: false },
      makeIo().io,
      {
        prompts,
        env: {},
        readGcloudProject: vi.fn(async () => 'current-gcp-project'),
        listGcloudProjects: vi.fn(async () => [{ projectId: 'current-gcp-project', name: 'Current project' }]),
      },
    );

    expect(result.status).toBe('back');
    expect(prompts.select).toHaveBeenNthCalledWith(
      2,
      expect.objectContaining({
        message: expect.stringContaining('Which LLM provider should ktx use?'),
      }),
    );
  });

  it('explains common Vertex AI Forbidden health-check causes', async () => {
    const io = makeIo();

    const result = await runKtxSetupAnthropicModelStep(
      {
        projectDir: tempDir,
        inputMode: 'disabled',
        llmBackend: 'vertex',
        vertexProject: 'kaelio-orbit-looker-20260430',
        vertexLocation: 'us-east5',
        skipLlm: false,
      },
      io.io,
      {
        env: {},
        healthCheck: vi.fn(async () => ({ ok: false as const, message: 'Forbidden' })),
      },
    );

    expect(result.status).toBe('failed');
    expect(io.stderr()).toContain('project kaelio-orbit-looker-20260430');
    expect(io.stderr()).toContain('Vertex AI API is enabled');
    expect(io.stderr()).toContain('Anthropic Claude model access');
    expect(io.stderr()).toContain('roles/aiplatform.user');
  });

  it('resolves --anthropic-api-key-file for health checks and stores a file reference', async () => {
    const io = makeIo();
    const secretPath = join(tempDir, 'anthropic-api-key');
    await writeFile(secretPath, 'sk-ant-file', 'utf-8'); // pragma: allowlist secret
    const healthCheck = vi.fn(async () => ({ ok: true as const }));

    const result = await runKtxSetupAnthropicModelStep(
      {
        projectDir: tempDir,
        inputMode: 'disabled',
        anthropicApiKeyFile: secretPath,
        skipLlm: false,
      },
      io.io,
      { env: {}, healthCheck },
    );

    expect(result.status).toBe('ready');
    expect(healthCheck).toHaveBeenNthCalledWith(
      1,
      expect.objectContaining({
        anthropic: { apiKey: 'sk-ant-file' }, // pragma: allowlist secret
        modelSlots: { default: 'claude-sonnet-4-6' },
      }),
    );
    expect(healthCheck).toHaveBeenNthCalledWith(
      2,
      expect.objectContaining({
        anthropic: { apiKey: 'sk-ant-file' }, // pragma: allowlist secret
        modelSlots: { default: 'claude-haiku-4-5' },
      }),
    );
    expect(healthCheck).toHaveBeenNthCalledWith(
      3,
      expect.objectContaining({
        anthropic: { apiKey: 'sk-ant-file' }, // pragma: allowlist secret
        modelSlots: { default: 'claude-opus-4-7' },
      }),
    );
    const config = parseKtxProjectConfig(await readFile(join(tempDir, 'ktx.yaml'), 'utf-8'));
    expect(config.llm).toMatchObject({
      provider: {
        backend: 'anthropic',
        anthropic: { api_key: `file:${secretPath}` }, // pragma: allowlist secret
      },
      models: anthropicPreset,
    });
    expect(await readFile(join(tempDir, 'ktx.yaml'), 'utf-8')).not.toContain('completed_steps:');
    expect((await readKtxSetupState(tempDir)).completed_steps).toContain('llm');
    expect(io.stdout()).not.toContain('sk-ant-file');
  });

  it('returns missing-input when --anthropic-api-key-file points to a missing file', async () => {
    const io = makeIo();
    const missingSecretPath = join(tempDir, 'missing-anthropic-api-key');
    const healthCheck = vi.fn(async () => ({ ok: true as const }));

    const result = await runKtxSetupAnthropicModelStep(
      {
        projectDir: tempDir,
        inputMode: 'disabled',
        anthropicApiKeyFile: missingSecretPath,
        skipLlm: false,
      },
      io.io,
      { env: {}, healthCheck },
    );

    expect(result.status).toBe('missing-input');
    expect(healthCheck).not.toHaveBeenCalled();
    expect(io.stderr()).toContain(`Missing Anthropic API key file: ${missingSecretPath}`);
  });

  it('fails clearly when non-interactive setup has no LLM backend instead of assuming Anthropic', async () => {
    const io = makeIo();

    const result = await runKtxSetupAnthropicModelStep(
      { projectDir: tempDir, inputMode: 'disabled', skipLlm: false },
      io.io,
    );

    expect(result.status).toBe('missing-input');
    const stderr = io.stderr();
    expect(stderr).toContain('Missing LLM backend: pass --llm-backend');
    // Names every backend so the user can choose without reading hidden --help flags.
    expect(stderr).toContain('claude-code');
    expect(stderr).toContain('codex');
    expect(stderr).toContain('anthropic');
    expect(stderr).toContain('vertex');
    // Does not mislead with an Anthropic-key error the user never opted into.
    expect(stderr).not.toContain('Missing Anthropic API key');
    // Does not nudge users to skip the LLM.
    expect(stderr).not.toContain('--skip-llm');
  });

  it('writes pasted keys to .ktx/secrets and never prints the key', async () => {
    const io = makeIo();
    const prompts = makePromptAdapter({
      credentialChoice: 'paste',
      passwordValue: 'sk-ant-pasted', // pragma: allowlist secret
    });

    const result = await runKtxSetupAnthropicModelStep(
      { projectDir: tempDir, inputMode: 'auto', skipLlm: false },
      io.io,
      {
        prompts,
        env: {},
        healthCheck: vi.fn(async () => ({ ok: true as const })),
      },
    );

    expect(result.status).toBe('ready');
    await expect(readFile(join(tempDir, '.ktx/secrets/anthropic-api-key'), 'utf-8')).resolves.toBe('sk-ant-pasted\n'); // pragma: allowlist secret
    if (process.platform !== 'win32') {
      expect((await stat(join(tempDir, '.ktx/secrets/anthropic-api-key'))).mode & 0o777).toBe(0o600);
    }
    const yaml = await readFile(join(tempDir, 'ktx.yaml'), 'utf-8');
    expect(yaml).toContain('api_key: file:');
    expect(yaml).not.toContain('sk-ant-pasted');
    expect(io.stdout()).not.toContain('sk-ant-pasted');
  });

  it('opens pasted key entry directly and tells users Escape goes back', async () => {
    const prompts = makePromptAdapter({
      selectValues: ['paste'],
      passwordValue: 'sk-ant-pasted', // pragma: allowlist secret
    });

    const result = await runKtxSetupAnthropicModelStep(
      { projectDir: tempDir, inputMode: 'auto', skipLlm: false },
      makeIo().io,
      {
        prompts,
        env: {},
        healthCheck: vi.fn(async () => ({ ok: true as const })),
      },
    );

    expect(result.status).toBe('ready');
    expect(prompts.select).not.toHaveBeenCalledWith(expect.objectContaining({ message: 'Paste Anthropic API key now?' }));
    expect(prompts.password).toHaveBeenCalledWith({
      message: 'Anthropic API key\n│  Press Escape to go back.\n│',
    });
  });

  it('does not offer skipping while choosing an Anthropic credential source', async () => {
    const prompts = makePromptAdapter({ credentialChoice: 'back' });

    const result = await runKtxSetupAnthropicModelStep(
      { projectDir: tempDir, inputMode: 'auto', skipLlm: false },
      makeIo().io,
      { prompts, env: {} },
    );

    expect(result.status).toBe('back');
    expect(prompts.select).toHaveBeenCalledWith(
      expect.objectContaining({
        message: expect.stringContaining('How should ktx find your Anthropic API key?'),
        options: expect.not.arrayContaining([expect.objectContaining({ value: 'skip' })]),
      }),
    );
  });

  it('explains why ktx asks for an Anthropic API key', async () => {
    const io = makeIo();
    const prompts = makePromptAdapter({ credentialChoice: 'back' });
    const expectedPromptMessage = [
      'How should ktx find your Anthropic API key?',
      '',
      [
        'ktx uses the key to verify Anthropic model access now and to run ingest agents that turn schemas, SQL,',
        'BI metadata, and docs into semantic-layer sources and wiki context. ktx.yaml stores an env: or file:',
        'reference, not the raw key.',
      ].join(' '),
    ].join('\n');

    const result = await runKtxSetupAnthropicModelStep(
      { projectDir: tempDir, inputMode: 'auto', skipLlm: false },
      io.io,
      { prompts, env: {} },
    );

    expect(result.status).toBe('back');
    expect(prompts.select).toHaveBeenCalledWith(
      expect.objectContaining({
        message: expectedPromptMessage,
      }),
    );
    expect(io.stdout()).not.toContain('ktx uses the key');
  });

  it('does not persist llm completion when the health check fails', async () => {
    const io = makeIo();
    const result = await runKtxSetupAnthropicModelStep(
      {
        projectDir: tempDir,
        inputMode: 'disabled',
        anthropicApiKeyEnv: 'ANTHROPIC_API_KEY', // pragma: allowlist secret
        skipLlm: false,
      },
      io.io,
      {
        env: { ANTHROPIC_API_KEY: 'sk-ant-test' }, // pragma: allowlist secret
        healthCheck: vi.fn(async () => ({ ok: false as const, message: '401 invalid x-api-key [redacted]' })),
      },
    );

    expect(result.status).toBe('failed');
    expect(await readFile(join(tempDir, 'ktx.yaml'), 'utf-8')).not.toContain('completed_steps:');
    expect(io.stderr()).toContain('Anthropic model health check failed: 401 invalid x-api-key [redacted]');
    expect(io.stderr()).not.toContain('sk-ant-test');
  });

  it('re-prompts after an interactive health-check failure and saves after retry success', async () => {
    const io = makeIo();
    const prompts = makePromptAdapter({ selectValues: ['env', 'env'] });
    const healthCheck = vi
      .fn()
      .mockResolvedValueOnce({ ok: false as const, message: 'model not found' })
      .mockResolvedValueOnce({ ok: true as const })
      .mockResolvedValueOnce({ ok: true as const })
      .mockResolvedValueOnce({ ok: true as const });

    const result = await runKtxSetupAnthropicModelStep(
      { projectDir: tempDir, inputMode: 'auto', skipLlm: false },
      io.io,
      {
        prompts,
        env: { ANTHROPIC_API_KEY: 'sk-ant-test' }, // pragma: allowlist secret
        healthCheck,
      },
    );

    expect(result.status).toBe('ready');
    expect(healthCheck).toHaveBeenCalledTimes(4);
    expect(prompts.select).toHaveBeenCalledTimes(3);
    expect(prompts.autocomplete).not.toHaveBeenCalledWith(
      expect.objectContaining({
        message: expect.stringContaining('Which Anthropic model should ktx use?'),
      }),
    );
    expect(io.stderr()).toContain('Anthropic model health check failed: model not found');
    expect(io.stderr()).toContain('Choose a different credential source or Back.');
    const config = parseKtxProjectConfig(await readFile(join(tempDir, 'ktx.yaml'), 'utf-8'));
    expect(config.llm.models).toMatchObject(anthropicPreset);
    expect(await readFile(join(tempDir, 'ktx.yaml'), 'utf-8')).not.toContain('completed_steps:');
    expect((await readKtxSetupState(tempDir)).completed_steps).toContain('llm');
    expect(io.stderr()).not.toContain('sk-ant-test');
  });

  it('leaves setup incomplete when skipped', async () => {
    const result = await runKtxSetupAnthropicModelStep(
      { projectDir: tempDir, inputMode: 'disabled', skipLlm: true },
      makeIo().io,
    );

    expect(result.status).toBe('skipped');
    expect(await readFile(join(tempDir, 'ktx.yaml'), 'utf-8')).not.toContain('completed_steps:');
  });

  it('returns back without writing config when Back is selected', async () => {
    const prompts = makePromptAdapter({ credentialChoice: 'back' });
    const result = await runKtxSetupAnthropicModelStep(
      { projectDir: tempDir, inputMode: 'auto', skipLlm: false },
      makeIo().io,
      { prompts, env: {} },
    );

    expect(result.status).toBe('back');
    const config = parseKtxProjectConfig(await readFile(join(tempDir, 'ktx.yaml'), 'utf-8'));
    expect(config.llm.provider.backend).toBe('none');
  });

  it('returns from pasted key entry Escape to credential selection and can use env credentials', async () => {
    const prompts = makePromptAdapter({ selectValues: ['paste', 'env'], passwordValues: [undefined] });

    const result = await runKtxSetupAnthropicModelStep(
      { projectDir: tempDir, inputMode: 'auto', skipLlm: false },
      makeIo().io,
      {
        prompts,
        env: { ANTHROPIC_API_KEY: 'sk-ant-env' }, // pragma: allowlist secret
        healthCheck: vi.fn(async () => ({ ok: true as const })),
      },
    );

    expect(result.status).toBe('ready');
    expect(prompts.password).toHaveBeenCalledWith({
      message: 'Anthropic API key\n│  Press Escape to go back.\n│',
    });
    await expect(readFile(join(tempDir, '.ktx/secrets/anthropic-api-key'), 'utf-8')).rejects.toMatchObject({
      code: 'ENOENT',
    });
    const config = parseKtxProjectConfig(await readFile(join(tempDir, 'ktx.yaml'), 'utf-8'));
    expect(config.llm.provider).toMatchObject({
      backend: 'anthropic',
      anthropic: { api_key: 'env:ANTHROPIC_API_KEY' }, // pragma: allowlist secret
    });
  });

  it('preserves already completed llm setup when no model args request changes', async () => {
    await mkdir(join(tempDir, '.ktx'), { recursive: true });
    await initKtxProject({ projectDir: tempDir, force: true });
    await writeFile(
      join(tempDir, 'ktx.yaml'),
      [
        'setup:',
        '  database_connection_ids: []',
        'connections: {}',
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
      ].join('\n'),
      'utf-8',
    );
    await writeKtxSetupState(tempDir, { completed_steps: ['project', 'llm'] });

    const healthCheck = vi.fn(async () => ({ ok: true as const }));
    await expect(
      runKtxSetupAnthropicModelStep({ projectDir: tempDir, inputMode: 'disabled', skipLlm: false }, makeIo().io, {
        env: { ANTHROPIC_API_KEY: 'sk-ant-test' }, // pragma: allowlist secret
        healthCheck,
      }),
    ).resolves.toMatchObject({ status: 'ready' });
    expect(healthCheck).not.toHaveBeenCalled();
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
  ])('preserves already configured $backend llm setup without asking for Anthropic credentials', async (fixture) => {
    await writeFile(
      join(tempDir, 'ktx.yaml'),
      [
        'setup:',
        '  database_connection_ids: []',
        'connections: {}',
        'llm:',
        '  provider:',
        ...fixture.providerLines,
        '  models:',
        `    default: ${fixture.model}`,
        'ingest:',
        '  embeddings:',
        '    backend: none',
        '    dimensions: 8',
      ].join('\n'),
      'utf-8',
    );
    await writeKtxSetupState(tempDir, { completed_steps: ['project', 'llm'] });

    const healthCheck = vi.fn(async () => ({ ok: true as const }));
    const io = makeIo();
    await expect(
      runKtxSetupAnthropicModelStep({ projectDir: tempDir, inputMode: 'disabled', skipLlm: false }, io.io, {
        healthCheck,
      }),
    ).resolves.toMatchObject({ status: 'ready' });

    expect(healthCheck).not.toHaveBeenCalled();
    expect(io.stdout()).toContain(`LLM ready: yes (${fixture.model})`);
    expect(io.stderr()).not.toContain('Anthropic');
  });
});
