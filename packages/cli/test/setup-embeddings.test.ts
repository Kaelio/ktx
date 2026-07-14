import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { initKtxProject } from '../src/context/project/project.js';
import { parseKtxProjectConfig } from '../src/context/project/config.js';
import { readKtxSetupState, writeKtxSetupState } from '../src/context/project/setup-config.js';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { ManagedPythonDaemonStartError } from '../src/managed-python-daemon.js';
import { type KtxSetupEmbeddingsPromptAdapter, runKtxSetupEmbeddingsStep } from '../src/setup-embeddings.js';

const EMBEDDING_OPTION_PROMPT_MESSAGE = [
  'Which embedding option should ktx use?',
  '',
  'ktx uses embeddings for semantic search over semantic-layer sources, wiki context, schema metadata, ' +
    'and relationship evidence.',
].join('\n');

function makeIo() {
  let stdout = '';
  let stderr = '';
  return {
    io: {
      stdout: {
        isTTY: false,
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

function makePromptAdapter(options: {
  selectValues?: string[];
  passwordValue?: string;
  textValues?: string[];
}): KtxSetupEmbeddingsPromptAdapter {
  const selectValues = [...(options.selectValues ?? [])];
  const textValues = [...(options.textValues ?? [])];
  return {
    select: vi.fn(async () => selectValues.shift() ?? 'retry'),
    text: vi.fn(async () => textValues.shift() ?? ''),
    password: vi.fn(async () => options.passwordValue ?? 'embedding-secret'),
    cancel: vi.fn(),
  };
}

function managedDaemon(
  baseUrl = 'http://127.0.0.1:61234',
  logs: { stdoutLog?: string; stderrLog?: string } = {},
) {
  return {
    baseUrl,
    stdoutLog: logs.stdoutLog ?? '/tmp/ktx-daemon.stdout.log',
    stderrLog: logs.stderrLog ?? '/tmp/ktx-daemon.stderr.log',
  };
}

describe('setup embeddings step', () => {
  let tempDir: string;

  beforeEach(async () => {
    tempDir = await mkdtemp(join(tmpdir(), 'ktx-setup-embeddings-'));
    await initKtxProject({ projectDir: tempDir });
  });

  afterEach(async () => {
    await rm(tempDir, { recursive: true, force: true });
  });

  it('explains why interactive users choose an embedding option before validating embeddings', async () => {
    const io = makeIo();
    const healthCheck = vi.fn(async () => ({ ok: true as const }));
    const prompts = makePromptAdapter({ selectValues: ['back'] });

    const result = await runKtxSetupEmbeddingsStep(
      {
        projectDir: tempDir,
        inputMode: 'auto',
        cliVersion: '0.2.0',
        runtimeInstallPolicy: 'auto',
        skipEmbeddings: false,
      },
      io.io,
      { prompts, env: {}, healthCheck },
    );

    expect(result.status).toBe('back');
    expect(healthCheck).not.toHaveBeenCalled();
    expect(prompts.select).toHaveBeenCalledWith({
      message: EMBEDDING_OPTION_PROMPT_MESSAGE,
      options: [
        { value: 'sentence-transformers', label: 'Local sentence-transformers embeddings' },
        { value: 'openai', label: 'OpenAI embeddings', hint: 'recommended' },
        { value: 'back', label: 'Back' },
      ],
    });
  });

  it('returns from the OpenAI credential prompt to embedding option selection when Back is selected', async () => {
    const io = makeIo();
    const healthCheck = vi.fn(async () => ({ ok: true as const }));
    const prompts = makePromptAdapter({ selectValues: ['openai', 'back', 'sentence-transformers'] });

    const result = await runKtxSetupEmbeddingsStep(
      {
        projectDir: tempDir,
        inputMode: 'auto',
        cliVersion: '0.2.0',
        runtimeInstallPolicy: 'auto',
        skipEmbeddings: false,
      },
      io.io,
      { prompts, env: {}, healthCheck, ensureLocalEmbeddings: vi.fn(async () => managedDaemon()) },
    );

    expect(result.status).toBe('ready');
    expect(healthCheck).toHaveBeenCalledTimes(1);
    expect(healthCheck).toHaveBeenCalledWith({
      backend: 'sentence-transformers',
      model: 'all-MiniLM-L6-v2',
      dimensions: 384,
      sentenceTransformers: { baseURL: 'http://127.0.0.1:61234', pathPrefix: '' },
    });
    expect(vi.mocked(prompts.select).mock.calls.map((call) => call[0].message)).toEqual([
      EMBEDDING_OPTION_PROMPT_MESSAGE,
      'How should ktx find your OpenAI embedding API key?',
      EMBEDDING_OPTION_PROMPT_MESSAGE,
    ]);
  });

  it('configures local sentence-transformers embeddings after interactive selection', async () => {
    const io = makeIo();
    const healthCheck = vi.fn(async () => ({ ok: true as const }));
    const prompts = makePromptAdapter({ selectValues: ['sentence-transformers'] });
    const ensureLocalEmbeddings = vi.fn(async () => managedDaemon());
    const spinnerEvents: string[] = [];
    const spinner = vi.fn(() => ({
      start: (msg: string) => spinnerEvents.push(`start:${msg}`),
      message: (msg: string) => spinnerEvents.push(`message:${msg}`),
      stop: (msg: string) => spinnerEvents.push(`stop:${msg}`),
      error: (msg: string) => spinnerEvents.push(`error:${msg}`),
    }));

    const result = await runKtxSetupEmbeddingsStep(
      {
        projectDir: tempDir,
        inputMode: 'auto',
        cliVersion: '0.2.0',
        runtimeInstallPolicy: 'auto',
        skipEmbeddings: false,
      },
      io.io,
      { prompts, env: {}, healthCheck, ensureLocalEmbeddings, spinner },
    );

    expect(result.status).toBe('ready');
    expect(ensureLocalEmbeddings).toHaveBeenCalledWith({
      cliVersion: '0.2.0',
      projectDir: tempDir,
      installPolicy: 'auto',
      io: io.io,
    });
    expect(healthCheck).toHaveBeenCalledWith({
      backend: 'sentence-transformers',
      model: 'all-MiniLM-L6-v2',
      dimensions: 384,
      sentenceTransformers: { baseURL: 'http://127.0.0.1:61234', pathPrefix: '' },
    });
    const config = parseKtxProjectConfig(await readFile(join(tempDir, 'ktx.yaml'), 'utf-8'));
    expect(config.ingest.embeddings).toMatchObject({
      backend: 'sentence-transformers',
      model: 'all-MiniLM-L6-v2',
      dimensions: 384,
    });
    expect(config.ingest.embeddings.sentenceTransformers).toBeUndefined();
    expect(config.scan.enrichment.embeddings).toMatchObject(config.ingest.embeddings);
    expect(await readFile(join(tempDir, 'ktx.yaml'), 'utf-8')).not.toContain('completed_steps:');
    expect((await readKtxSetupState(tempDir)).completed_steps).toContain('embeddings');
    expect(spinnerEvents).toContainEqual('start:Testing local embeddings (all-MiniLM-L6-v2)');
    expect(io.stdout()).toContain('Embeddings ready: yes');
  });

  it('uses a short non-animated local embeddings health-check status when stdout is not a TTY', async () => {
    const io = makeIo();
    const healthCheck = vi.fn(async () => ({ ok: true as const }));
    const prompts = makePromptAdapter({ selectValues: ['sentence-transformers'] });

    const result = await runKtxSetupEmbeddingsStep(
      {
        projectDir: tempDir,
        inputMode: 'auto',
        cliVersion: '0.2.0',
        runtimeInstallPolicy: 'auto',
        skipEmbeddings: false,
      },
      io.io,
      { prompts, env: {}, healthCheck, ensureLocalEmbeddings: vi.fn(async () => managedDaemon()) },
    );

    expect(result.status).toBe('ready');
    expect(io.stderr()).toContain('Testing local embeddings (all-MiniLM-L6-v2)');
    expect(io.stderr()).not.toContain('First run may take up to 60 seconds');
    expect(io.stderr().match(/Testing local embeddings/g)).toHaveLength(1);
  });

  it('shows live progress while local sentence-transformers embeddings are being tested', async () => {
    const io = makeIo();
    const prompts = makePromptAdapter({ selectValues: ['sentence-transformers'] });
    let resolveHealthCheck: ((result: { ok: true }) => void) | undefined;
    const healthCheck = vi.fn(
      () =>
        new Promise<{ ok: true }>((resolve) => {
          resolveHealthCheck = resolve;
        }),
    );
    const spinnerEvents: string[] = [];
    const spinner = vi.fn(() => ({
      start: (msg: string) => spinnerEvents.push(`start:${msg}`),
      message: (msg: string) => spinnerEvents.push(`message:${msg}`),
      stop: (msg: string) => spinnerEvents.push(`stop:${msg}`),
      error: (msg: string) => spinnerEvents.push(`error:${msg}`),
    }));

    const result = runKtxSetupEmbeddingsStep(
      {
        projectDir: tempDir,
        inputMode: 'auto',
        cliVersion: '0.2.0',
        runtimeInstallPolicy: 'auto',
        skipEmbeddings: false,
      },
      io.io,
      { prompts, env: {}, healthCheck, ensureLocalEmbeddings: vi.fn(async () => managedDaemon()), spinner },
    );

    await vi.waitFor(() => {
      expect(spinnerEvents).toContainEqual('start:Testing local embeddings (all-MiniLM-L6-v2)');
    });

    expect(resolveHealthCheck).toBeDefined();
    resolveHealthCheck?.({ ok: true });
    await expect(result).resolves.toMatchObject({ status: 'ready' });
  });

  it('uses default local sentence-transformers embeddings in non-interactive setup', async () => {
    const io = makeIo();
    const healthCheck = vi.fn(async () => ({ ok: true as const }));

    const result = await runKtxSetupEmbeddingsStep(
      {
        projectDir: tempDir,
        inputMode: 'disabled',
        cliVersion: '0.2.0',
        runtimeInstallPolicy: 'auto',
        skipEmbeddings: false,
      },
      io.io,
      { env: {}, healthCheck, ensureLocalEmbeddings: vi.fn(async () => managedDaemon()) },
    );

    expect(result.status).toBe('ready');
    expect(healthCheck).toHaveBeenCalledWith({
      backend: 'sentence-transformers',
      model: 'all-MiniLM-L6-v2',
      dimensions: 384,
      sentenceTransformers: { baseURL: 'http://127.0.0.1:61234', pathPrefix: '' },
    });
    const config = parseKtxProjectConfig(await readFile(join(tempDir, 'ktx.yaml'), 'utf-8'));
    expect(config.ingest.embeddings).toMatchObject({
      backend: 'sentence-transformers',
      model: 'all-MiniLM-L6-v2',
      dimensions: 384,
    });
    expect(config.ingest.embeddings.sentenceTransformers).toBeUndefined();
    expect(config.scan.enrichment.embeddings).toMatchObject(config.ingest.embeddings);
    expect(await readFile(join(tempDir, 'ktx.yaml'), 'utf-8')).not.toContain('completed_steps:');
    expect((await readKtxSetupState(tempDir)).completed_steps).toContain('embeddings');
  });

  it('fails non-interactive local setup when the managed local embeddings runtime is missing', async () => {
    const io = makeIo();
    const ensureLocalEmbeddings = vi.fn(async () => {
      throw new Error(
        'ktx Python runtime is required for this command. Run: ktx admin runtime install --feature local-embeddings --yes',
      );
    });

    const result = await runKtxSetupEmbeddingsStep(
      {
        projectDir: tempDir,
        inputMode: 'disabled',
        cliVersion: '0.2.0',
        runtimeInstallPolicy: 'never',
        skipEmbeddings: false,
      },
      io.io,
      { env: {}, ensureLocalEmbeddings },
    );

    expect(result.status).toBe('failed');
    expect(io.stderr()).toContain(
      'ktx Python runtime is required for this command. Run: ktx admin runtime install --feature local-embeddings --yes',
    );
  });

  it('does not persist embedding completion when the health check fails', async () => {
    const io = makeIo();
    const result = await runKtxSetupEmbeddingsStep(
      {
        projectDir: tempDir,
        inputMode: 'disabled',
        cliVersion: '0.2.0',
        runtimeInstallPolicy: 'auto',
        skipEmbeddings: false,
      },
      io.io,
      {
        env: {},
        ensureLocalEmbeddings: vi.fn(async () => managedDaemon()),
        healthCheck: vi.fn(async () => ({ ok: false as const, message: '401 invalid api key [redacted]' })),
      },
    );

    expect(result.status).toBe('failed');
    const config = parseKtxProjectConfig(await readFile(join(tempDir, 'ktx.yaml'), 'utf-8'));
    expect(await readFile(join(tempDir, 'ktx.yaml'), 'utf-8')).not.toContain('completed_steps:');
    expect(config.ingest.embeddings.backend).toBe('none');
    expect(io.stderr()).toContain('Local embedding health check failed: 401 invalid api key [redacted]');
    expect(io.stderr()).toContain('Prepare the runtime with: ktx admin runtime start --feature local-embeddings');
    expect(io.stderr()).not.toContain('skip for now');
  });

  it('prints the recent daemon stderr tail when local embedding health check fails', async () => {
    const io = makeIo();
    const stderrLog = join(tempDir, '.ktx', 'runtime', 'daemon.stderr.log');
    await mkdir(join(tempDir, '.ktx', 'runtime'), { recursive: true });
    await writeFile(
      stderrLog,
      Array.from({ length: 45 }, (_value, index) => `daemon traceback line ${index + 1}`).join('\n'),
    );

    const result = await runKtxSetupEmbeddingsStep(
      {
        projectDir: tempDir,
        inputMode: 'disabled',
        cliVersion: '0.2.0',
        runtimeInstallPolicy: 'auto',
        skipEmbeddings: false,
      },
      io.io,
      {
        env: {},
        ensureLocalEmbeddings: vi.fn(async () => managedDaemon('http://127.0.0.1:61234', { stderrLog })),
        healthCheck: vi.fn(async () => ({ ok: false as const, message: 'HTTP 500' })),
      },
    );

    expect(result.status).toBe('failed');
    expect(io.stderr()).toContain('Recent ktx daemon stderr:');
    expect(io.stderr()).toContain('daemon traceback line 6');
    expect(io.stderr()).toContain('daemon traceback line 45');
    expect(io.stderr()).not.toContain('daemon traceback line 5');
  });

  it('prints the daemon stderr tail when the daemon fails to start', async () => {
    const io = makeIo();
    const stderrLog = join(tempDir, '.ktx', 'runtime', 'daemon.stderr.log');
    await mkdir(join(tempDir, '.ktx', 'runtime'), { recursive: true });
    await writeFile(
      stderrLog,
      Array.from({ length: 45 }, (_value, index) => `daemon startup traceback ${index + 1}`).join('\n'),
    );

    const result = await runKtxSetupEmbeddingsStep(
      {
        projectDir: tempDir,
        inputMode: 'disabled',
        cliVersion: '0.2.0',
        runtimeInstallPolicy: 'auto',
        skipEmbeddings: false,
      },
      io.io,
      {
        env: {},
        ensureLocalEmbeddings: vi.fn(async () => {
          throw new ManagedPythonDaemonStartError('fetch failed: connect ECONNREFUSED 127.0.0.1:61234', stderrLog);
        }),
      },
    );

    expect(result.status).toBe('failed');
    expect(io.stderr()).toContain('Local embedding health check failed: fetch failed: connect ECONNREFUSED');
    expect(io.stderr()).toContain('Recent ktx daemon stderr:');
    expect(io.stderr()).toContain('daemon startup traceback 6');
    expect(io.stderr()).toContain('daemon startup traceback 45');
    expect(io.stderr()).not.toContain('daemon startup traceback 5');
  });

  it('does not print daemon stderr diagnostics when the log is unavailable or empty', async () => {
    const io = makeIo();

    const result = await runKtxSetupEmbeddingsStep(
      {
        projectDir: tempDir,
        inputMode: 'disabled',
        cliVersion: '0.2.0',
        runtimeInstallPolicy: 'auto',
        skipEmbeddings: false,
      },
      io.io,
      {
        env: {},
        ensureLocalEmbeddings: vi.fn(async () =>
          managedDaemon('http://127.0.0.1:61234', {
            stderrLog: join(tempDir, '.ktx', 'runtime', 'missing.stderr.log'),
          }),
        ),
        healthCheck: vi.fn(async () => ({ ok: false as const, message: 'HTTP 500' })),
      },
    );

    expect(result.status).toBe('failed');
    expect(io.stderr()).not.toContain('Recent ktx daemon stderr:');
  });

  it('uses fixed OpenAI defaults and only asks for credentials when OpenAI is selected', async () => {
    const io = makeIo();
    const healthCheck = vi.fn(async () => ({ ok: true as const }));

    const result = await runKtxSetupEmbeddingsStep(
      {
        projectDir: tempDir,
        inputMode: 'disabled',
        embeddingBackend: 'openai',
        embeddingApiKeyEnv: 'OPENAI_API_KEY', // pragma: allowlist secret
        cliVersion: '0.2.0',
        runtimeInstallPolicy: 'auto',
        skipEmbeddings: false,
      },
      io.io,
      {
        env: { OPENAI_API_KEY: 'sk-openai-test' }, // pragma: allowlist secret
        healthCheck,
      },
    );

    expect(result.status).toBe('ready');
    expect(healthCheck).toHaveBeenCalledWith({
      backend: 'openai',
      model: 'text-embedding-3-small',
      dimensions: 1536,
      openai: { apiKey: 'sk-openai-test' }, // pragma: allowlist secret
    });
    const config = parseKtxProjectConfig(await readFile(join(tempDir, 'ktx.yaml'), 'utf-8'));
    expect(config.ingest.embeddings).toMatchObject({
      backend: 'openai',
      model: 'text-embedding-3-small',
      dimensions: 1536,
      openai: { api_key: 'env:OPENAI_API_KEY' }, // pragma: allowlist secret
    });
    expect(io.stdout()).not.toContain('sk-openai-test');
  });

  it('configures an OpenAI-compatible endpoint with custom base URL, model, and dimensions from flags', async () => {
    const io = makeIo();
    const healthCheck = vi.fn(async () => ({ ok: true as const }));

    const result = await runKtxSetupEmbeddingsStep(
      {
        projectDir: tempDir,
        inputMode: 'disabled',
        embeddingBackend: 'openai',
        embeddingApiKeyEnv: 'KTX_MAAS_KEY',
        embeddingBaseUrl: 'https://maas.example/compatible-mode/v1',
        embeddingModel: 'text-embedding-v4',
        embeddingDimensions: 1024,
        embeddingBatchSize: 10,
        cliVersion: '0.2.0',
        runtimeInstallPolicy: 'auto',
        skipEmbeddings: false,
      },
      io.io,
      { env: { KTX_MAAS_KEY: 'sk-maas' }, healthCheck }, // pragma: allowlist secret
    );

    expect(result.status).toBe('ready');
    expect(healthCheck).toHaveBeenCalledWith({
      backend: 'openai',
      model: 'text-embedding-v4',
      dimensions: 1024,
      openai: { apiKey: 'sk-maas', baseURL: 'https://maas.example/compatible-mode/v1' }, // pragma: allowlist secret
    });
    const config = parseKtxProjectConfig(await readFile(join(tempDir, 'ktx.yaml'), 'utf-8'));
    expect(config.ingest.embeddings).toMatchObject({
      backend: 'openai',
      model: 'text-embedding-v4',
      dimensions: 1024,
      batchSize: 10,
      openai: { api_key: 'env:KTX_MAAS_KEY', base_url: 'https://maas.example/compatible-mode/v1' }, // pragma: allowlist secret
    });
    // persistEmbeddingConfig mirrors the same config into the scan enrichment block,
    // so the schema scan's embedding requests honor the endpoint's batch cap too.
    expect(config.scan.enrichment.embeddings?.batchSize).toBe(10);
  });

  it('prompts for base URL, model, dimensions, and batch size in the interactive OpenAI flow', async () => {
    const io = makeIo();
    const healthCheck = vi.fn(async () => ({ ok: true as const }));
    const prompts = makePromptAdapter({
      selectValues: ['openai', 'env'],
      textValues: ['https://maas.example/v1', 'text-embedding-v4', '1024', '10'],
    });

    const result = await runKtxSetupEmbeddingsStep(
      { projectDir: tempDir, inputMode: 'auto', cliVersion: '0.2.0', runtimeInstallPolicy: 'auto', skipEmbeddings: false },
      io.io,
      { env: { OPENAI_API_KEY: 'sk-openai' }, healthCheck, prompts }, // pragma: allowlist secret
    );

    expect(result.status).toBe('ready');
    expect(healthCheck).toHaveBeenCalledWith({
      backend: 'openai',
      model: 'text-embedding-v4',
      dimensions: 1024,
      openai: { apiKey: 'sk-openai', baseURL: 'https://maas.example/v1' }, // pragma: allowlist secret
    });
    const config = parseKtxProjectConfig(await readFile(join(tempDir, 'ktx.yaml'), 'utf-8'));
    expect(config.ingest.embeddings).toMatchObject({
      backend: 'openai',
      model: 'text-embedding-v4',
      dimensions: 1024,
      batchSize: 10,
      openai: { api_key: 'env:OPENAI_API_KEY', base_url: 'https://maas.example/v1' }, // pragma: allowlist secret
    });
  });

  it('rejects a non-positive-integer dimensions value entered interactively', async () => {
    const io = makeIo();
    const healthCheck = vi.fn(async () => ({ ok: true as const }));
    const prompts = makePromptAdapter({
      selectValues: ['openai', 'env'],
      textValues: ['', 'text-embedding-v4', 'not-a-number'],
    });

    const result = await runKtxSetupEmbeddingsStep(
      { projectDir: tempDir, inputMode: 'auto', cliVersion: '0.2.0', runtimeInstallPolicy: 'auto', skipEmbeddings: false },
      io.io,
      { env: { OPENAI_API_KEY: 'sk-openai' }, healthCheck, prompts }, // pragma: allowlist secret
    );

    expect(result.status).toBe('missing-input');
    expect(io.stderr()).toContain('must be a positive integer');
    expect(healthCheck).not.toHaveBeenCalled();
  });

  it('can fall back to OpenAI after the default local daemon is unavailable', async () => {
    const io = makeIo();
    const prompts = makePromptAdapter({ selectValues: ['sentence-transformers', 'openai', 'env'] });
    const healthCheck = vi
      .fn()
      .mockResolvedValueOnce({ ok: false as const, message: 'fetch failed' })
      .mockResolvedValueOnce({ ok: true as const });

    const result = await runKtxSetupEmbeddingsStep(
      {
        projectDir: tempDir,
        inputMode: 'auto',
        cliVersion: '0.2.0',
        runtimeInstallPolicy: 'auto',
        skipEmbeddings: false,
      },
      io.io,
      {
        prompts,
        env: { OPENAI_API_KEY: 'sk-openai-test' }, // pragma: allowlist secret
        healthCheck,
        ensureLocalEmbeddings: vi.fn(async () => managedDaemon()),
      },
    );

    expect(result.status).toBe('ready');
    expect(healthCheck).toHaveBeenNthCalledWith(1, {
      backend: 'sentence-transformers',
      model: 'all-MiniLM-L6-v2',
      dimensions: 384,
      sentenceTransformers: { baseURL: 'http://127.0.0.1:61234', pathPrefix: '' },
    });
    expect(healthCheck).toHaveBeenNthCalledWith(2, {
      backend: 'openai',
      model: 'text-embedding-3-small',
      dimensions: 1536,
      openai: { apiKey: 'sk-openai-test' }, // pragma: allowlist secret
    });
    expect(prompts.select).toHaveBeenCalledWith(
      expect.objectContaining({
        message: 'Local embeddings are not reachable. Start the local ktx daemon, then retry.',
        options: expect.arrayContaining([expect.objectContaining({ value: 'openai' })]),
      }),
    );
    expect(vi.mocked(prompts.select).mock.calls[1]?.[0].options).toEqual([
      { value: 'retry', label: 'Retry' },
      { value: 'openai', label: 'Use OpenAI embeddings' },
      { value: 'back', label: 'Back' },
    ]);
    const config = parseKtxProjectConfig(await readFile(join(tempDir, 'ktx.yaml'), 'utf-8'));
    expect(config.ingest.embeddings.backend).toBe('openai');
  });

  it('leaves setup incomplete when skipped', async () => {
    const result = await runKtxSetupEmbeddingsStep(
      {
        projectDir: tempDir,
        inputMode: 'disabled',
        cliVersion: '0.2.0',
        runtimeInstallPolicy: 'auto',
        skipEmbeddings: true,
      },
      makeIo().io,
    );

    expect(result.status).toBe('skipped');
    const config = parseKtxProjectConfig(await readFile(join(tempDir, 'ktx.yaml'), 'utf-8'));
    expect(await readFile(join(tempDir, 'ktx.yaml'), 'utf-8')).not.toContain('completed_steps:');
    expect(config.ingest.embeddings.backend).toBe('none');
  });

  it('returns back without writing config when the local health check fails and Back is selected', async () => {
    const prompts = makePromptAdapter({ selectValues: ['sentence-transformers', 'back'] });
    const result = await runKtxSetupEmbeddingsStep(
      {
        projectDir: tempDir,
        inputMode: 'auto',
        cliVersion: '0.2.0',
        runtimeInstallPolicy: 'auto',
        skipEmbeddings: false,
      },
      makeIo().io,
      {
        prompts,
        env: {},
        ensureLocalEmbeddings: vi.fn(async () => managedDaemon()),
        healthCheck: vi.fn(async () => ({ ok: false as const, message: 'daemon unavailable' })),
      },
    );

    expect(result.status).toBe('back');
    const config = parseKtxProjectConfig(await readFile(join(tempDir, 'ktx.yaml'), 'utf-8'));
    expect(config.ingest.embeddings.backend).toBe('none');
  });

  it('preserves already completed embeddings setup when no embedding args request changes', async () => {
    await mkdir(join(tempDir, '.ktx'), { recursive: true });
    await initKtxProject({ projectDir: tempDir, force: true });
    await writeFile(
      join(tempDir, 'ktx.yaml'),
      [
        'setup:',
        '  database_connection_ids: []',
        'connections: {}',
        'ingest:',
        '  embeddings:',
        '    backend: sentence-transformers',
        '    model: all-MiniLM-L6-v2',
        '    dimensions: 384',
        '    sentenceTransformers:',
        '      base_url: http://127.0.0.1:8765',
        "      pathPrefix: ''",
      ].join('\n'),
      'utf-8',
    );
    await writeKtxSetupState(tempDir, { completed_steps: ['project', 'llm', 'embeddings'] });

    const healthCheck = vi.fn(async () => ({ ok: true as const }));
    await expect(
      runKtxSetupEmbeddingsStep(
        {
          projectDir: tempDir,
          inputMode: 'disabled',
          cliVersion: '0.2.0',
          runtimeInstallPolicy: 'auto',
          skipEmbeddings: false,
        },
        makeIo().io,
        {
          env: { OPENAI_API_KEY: 'sk-openai-test' }, // pragma: allowlist secret
          healthCheck,
        },
      ),
    ).resolves.toMatchObject({ status: 'ready' });
    expect(healthCheck).not.toHaveBeenCalled();
  });
});
