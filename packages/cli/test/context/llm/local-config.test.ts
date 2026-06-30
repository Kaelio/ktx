import { describe, expect, it, vi } from 'vitest';
import {
  buildDefaultKtxProjectConfig,
  type KtxProjectEmbeddingConfig,
  type KtxProjectLlmConfig,
} from '../../../src/context/project/config.js';
import {
  createLocalKtxEmbeddingProviderFromConfig,
  createLocalKtxLlmProviderFromConfig,
  createLocalKtxLlmRuntimeFromConfig,
  resolveLocalKtxEmbeddingConfig,
  resolveLocalKtxLlmConfig,
} from '../../../src/context/llm/local-config.js';

describe('local ktx LLM config', () => {
  it('resolves env and file references into a KtxLlmConfig', () => {
    const config: KtxProjectLlmConfig = {
      provider: {
        backend: 'gateway',
        gateway: { api_key: 'env:AI_GATEWAY_API_KEY', base_url: 'https://gateway.example/v1' }, // pragma: allowlist secret
      },
      models: { default: 'env:KTX_MODEL', triage: 'anthropic/claude-haiku-4-5' },
      promptCaching: { enabled: false },
    };

    expect(
      resolveLocalKtxLlmConfig(config, {
        AI_GATEWAY_API_KEY: 'gateway-key', // pragma: allowlist secret
        KTX_MODEL: 'anthropic/claude-sonnet-4-6',
      }),
    ).toEqual({
      backend: 'gateway',
      gateway: { apiKey: 'gateway-key', baseURL: 'https://gateway.example/v1' }, // pragma: allowlist secret
      modelSlots: { default: 'anthropic/claude-sonnet-4-6', triage: 'anthropic/claude-haiku-4-5' },
      promptCaching: { enabled: false },
    });
  });

  it('resolves Vertex AI env references into a KtxLlmConfig', () => {
    const config: KtxProjectLlmConfig = {
      provider: {
        backend: 'vertex',
        vertex: { project: 'env:GOOGLE_VERTEX_PROJECT', location: 'env:GOOGLE_VERTEX_LOCATION' },
      },
      models: { default: 'env:KTX_MODEL' },
      promptCaching: { enabled: true, vertexFallbackTo5m: true },
    };

    expect(
      resolveLocalKtxLlmConfig(config, {
        GOOGLE_VERTEX_PROJECT: 'local-gcp-project',
        GOOGLE_VERTEX_LOCATION: 'us-east5',
        KTX_MODEL: 'claude-sonnet-4-6',
      }),
    ).toEqual({
      backend: 'vertex',
      vertex: { project: 'local-gcp-project', location: 'us-east5' },
      modelSlots: { default: 'claude-sonnet-4-6' },
      promptCaching: { enabled: true, vertexFallbackTo5m: true },
    });
  });

  it('ignores inactive Vertex AI references for non-Vertex backends', () => {
    const config: KtxProjectLlmConfig = {
      provider: {
        backend: 'anthropic',
        anthropic: { api_key: 'env:ANTHROPIC_API_KEY' }, // pragma: allowlist secret
        vertex: { location: 'env:MISSING_VERTEX_LOCATION' },
      },
      models: { default: 'claude-sonnet-4-6' },
    };

    expect(
      resolveLocalKtxLlmConfig(config, {
        ANTHROPIC_API_KEY: 'sk-ant-test', // pragma: allowlist secret
      }),
    ).toEqual({
      backend: 'anthropic',
      anthropic: { apiKey: 'sk-ant-test' }, // pragma: allowlist secret
      modelSlots: { default: 'claude-sonnet-4-6' },
      promptCaching: undefined,
    });
  });

  it('returns null when the local LLM backend is disabled', () => {
    expect(
      createLocalKtxLlmProviderFromConfig({
        provider: { backend: 'none' },
        models: {},
      }),
    ).toBeNull();
  });

  it('constructs providers through LLM modules', () => {
    const createKtxLlmProvider = vi.fn(() => ({ getModel: vi.fn() }) as never);
    const result = createLocalKtxLlmProviderFromConfig(
      {
        provider: {
          backend: 'anthropic',
          anthropic: { api_key: 'env:ANTHROPIC_API_KEY' }, // pragma: allowlist secret
        },
        models: { default: 'claude-sonnet-4-6' },
      },
      { env: { ANTHROPIC_API_KEY: 'sk-ant-test' }, createKtxLlmProvider }, // pragma: allowlist secret
    );

    expect(result).not.toBeNull();
    expect(createKtxLlmProvider).toHaveBeenCalledWith({
      backend: 'anthropic',
      anthropic: { apiKey: 'sk-ant-test' }, // pragma: allowlist secret
      modelSlots: { default: 'claude-sonnet-4-6' },
      promptCaching: undefined,
    });
  });

  it('inherits enabled prompt caching from LLM modules when local config omits promptCaching', () => {
    const provider = createLocalKtxLlmProviderFromConfig({
      provider: {
        backend: 'gateway',
        gateway: { base_url: 'https://gateway.example/v1' },
      },
      models: { default: 'anthropic/claude-sonnet-4-6' },
    });

    expect(provider?.promptCachingConfig()).toMatchObject({
      enabled: true,
      systemTtl: '1h',
      toolsTtl: '1h',
      historyTtl: '5m',
      vertexFallbackTo5m: false,
    });
  });

  it('passes the rate-limit governor into created runtimes', () => {
    const rateLimitGovernor = {} as never;
    const createClaudeCodeRuntime = vi.fn(() => ({
      generateText: vi.fn(),
      generateObject: vi.fn(),
      runAgentLoop: vi.fn(),
      subprocessForkSpec: vi.fn(() => null),
    }));
    const createCodexRuntime = vi.fn(() => ({
      generateText: vi.fn(),
      generateObject: vi.fn(),
      runAgentLoop: vi.fn(),
      subprocessForkSpec: vi.fn(() => null),
    }));
    const createAiSdkRuntime = vi.fn(() => ({
      generateText: vi.fn(),
      generateObject: vi.fn(),
      runAgentLoop: vi.fn(),
      subprocessForkSpec: vi.fn(() => null),
    }));
    const createKtxLlmProvider = vi.fn(() => ({
      getModel: vi.fn(),
      getModelByName: vi.fn(),
      cacheMarker: vi.fn(),
      repairToolCallHandler: vi.fn(),
      thinkingProviderOptions: vi.fn(),
      telemetryConfig: vi.fn(),
      promptCachingConfig: vi.fn(),
      activeBackend: vi.fn(() => 'anthropic'),
    }));

    createLocalKtxLlmRuntimeFromConfig(
      {
        provider: { backend: 'claude-code' },
        models: { default: 'sonnet' },
        promptCaching: undefined,
      },
      { projectDir: '/tmp/project', env: {}, rateLimitGovernor, createClaudeCodeRuntime },
    );
    createLocalKtxLlmRuntimeFromConfig(
      {
        provider: { backend: 'codex' },
        models: { default: 'codex' },
        promptCaching: undefined,
      },
      { projectDir: '/tmp/project', env: {}, rateLimitGovernor, createCodexRuntime },
    );
    createLocalKtxLlmRuntimeFromConfig(
      {
        provider: { backend: 'anthropic' },
        models: { default: 'claude-sonnet-4-6' },
        promptCaching: undefined,
      },
      { env: {}, rateLimitGovernor, createAiSdkRuntime, createKtxLlmProvider: createKtxLlmProvider as never },
    );

    expect(createClaudeCodeRuntime).toHaveBeenCalledWith(expect.objectContaining({ rateLimitGovernor }));
    expect(createCodexRuntime).toHaveBeenCalledWith(expect.objectContaining({ rateLimitGovernor }));
    expect(createAiSdkRuntime).toHaveBeenCalledWith(expect.objectContaining({ rateLimitGovernor }));
  });
});

describe('local ktx embedding config', () => {
  it('resolves sentence-transformers config', () => {
    const config: KtxProjectEmbeddingConfig = {
      backend: 'sentence-transformers',
      model: 'all-MiniLM-L6-v2',
      dimensions: 384,
      sentenceTransformers: { base_url: 'http://localhost:18081', pathPrefix: '' },
      batchSize: 16,
    };

    expect(resolveLocalKtxEmbeddingConfig(config, {})).toEqual({
      backend: 'sentence-transformers',
      model: 'all-MiniLM-L6-v2',
      dimensions: 384,
      sentenceTransformers: { baseURL: 'http://localhost:18081', pathPrefix: '' },
      batchSize: 16,
    });
  });

  it('returns null when sentence-transformers has no base_url (managed daemon delegation)', () => {
    const config: KtxProjectEmbeddingConfig = {
      backend: 'sentence-transformers',
      model: 'all-MiniLM-L6-v2',
      dimensions: 384,
      sentenceTransformers: {
        base_url: '',
        pathPrefix: '',
      },
    };

    expect(resolveLocalKtxEmbeddingConfig(config, {})).toBeNull();
  });

  it('returns null when backend is openai but no apiKey is resolvable from env', () => {
    const config: KtxProjectEmbeddingConfig = {
      backend: 'openai',
      model: 'text-embedding-3-small',
      dimensions: 1536,
      openai: { api_key: 'env:OPENAI_API_KEY' }, // pragma: allowlist secret
    };

    expect(resolveLocalKtxEmbeddingConfig(config, {})).toBeNull();
  });

  it('resolves openai embedding config from env', () => {
    const config: KtxProjectEmbeddingConfig = {
      backend: 'openai',
      model: 'text-embedding-3-small',
      dimensions: 1536,
      openai: { api_key: 'env:OPENAI_API_KEY' }, // pragma: allowlist secret
    };

    expect(
      resolveLocalKtxEmbeddingConfig(config, { OPENAI_API_KEY: 'sk-test' }), // pragma: allowlist secret
    ).toEqual({
      backend: 'openai',
      model: 'text-embedding-3-small',
      dimensions: 1536,
      openai: { apiKey: 'sk-test' }, // pragma: allowlist secret
      batchSize: undefined,
    });
  });

  it('returns null for the default disabled project embedding config', () => {
    const createKtxEmbeddingProvider = vi.fn(() => ({}) as never);
    const provider = createLocalKtxEmbeddingProviderFromConfig(
      buildDefaultKtxProjectConfig().ingest.embeddings,
      { createKtxEmbeddingProvider },
    );

    expect(provider).toBeNull();
    expect(createKtxEmbeddingProvider).not.toHaveBeenCalled();
  });

  it('returns null when embeddings are disabled', () => {
    expect(createLocalKtxEmbeddingProviderFromConfig({ backend: 'none', dimensions: 8 })).toBeNull();
  });
});
