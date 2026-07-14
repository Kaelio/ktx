import { createKtxEmbeddingProvider } from '../../llm/embedding-provider.js';
import { createKtxLlmProvider } from '../../llm/model-provider.js';
import type { KtxEmbeddingConfig, KtxEmbeddingProvider, KtxLlmConfig, KtxLlmProvider, KtxModelRole } from '../../llm/types.js';
import { resolveKtxConfigReference } from '../core/config-reference.js';
import type { KtxProjectEmbeddingConfig, KtxProjectLlmConfig } from '../project/config.js';
import { AiSdkKtxLlmRuntime } from './ai-sdk-runtime.js';
import { ClaudeCodeKtxLlmRuntime } from './claude-code-runtime.js';
import { CodexKtxLlmRuntime } from './codex-runtime.js';
import type { RateLimitGovernor } from './rate-limit-governor.js';
import type { KtxLlmRuntimePort } from './runtime-port.js';

type ClaudeCodeRuntimeDeps = ConstructorParameters<typeof ClaudeCodeKtxLlmRuntime>[0] & {
  rateLimitGovernor?: RateLimitGovernor;
};
type CodexRuntimeDeps = ConstructorParameters<typeof CodexKtxLlmRuntime>[0] & {
  rateLimitGovernor?: RateLimitGovernor;
};
type AiSdkRuntimeDeps = ConstructorParameters<typeof AiSdkKtxLlmRuntime>[0] & {
  rateLimitGovernor?: RateLimitGovernor;
};

interface LocalConfigDeps {
  env?: NodeJS.ProcessEnv;
  projectDir?: string;
  rateLimitGovernor?: RateLimitGovernor;
  createKtxLlmProvider?: typeof createKtxLlmProvider;
  createKtxEmbeddingProvider?: typeof createKtxEmbeddingProvider;
  createClaudeCodeRuntime?: (deps: ClaudeCodeRuntimeDeps) => KtxLlmRuntimePort;
  createCodexRuntime?: (deps: CodexRuntimeDeps) => KtxLlmRuntimePort;
  createAiSdkRuntime?: (deps: AiSdkRuntimeDeps) => KtxLlmRuntimePort;
}

function resolveOptional(value: string | undefined, env: NodeJS.ProcessEnv): string | undefined {
  return resolveKtxConfigReference(value, env) || undefined;
}

function resolveRequired(value: string | undefined, env: NodeJS.ProcessEnv, message: string): string {
  const resolved = resolveOptional(value, env);
  if (!resolved) {
    throw new Error(message);
  }
  return resolved;
}

function resolveModelSlots(
  models: KtxProjectLlmConfig['models'],
  env: NodeJS.ProcessEnv,
): KtxLlmConfig['modelSlots'] {
  const resolved: Partial<Record<KtxModelRole, string>> & { default?: string } = {};
  for (const [role, value] of Object.entries(models)) {
    if (value) {
      resolved[role as KtxModelRole] = resolveRequired(value, env, `llm.models.${role} is required`);
    }
  }
  if (!resolved.default) {
    throw new Error('llm.models.default is required when llm.provider.backend is not none');
  }
  return resolved as KtxLlmConfig['modelSlots'];
}

function resolvedProviderConfig(
  config: { api_key?: string; base_url?: string } | undefined,
  env: NodeJS.ProcessEnv,
): { apiKey?: string; baseURL?: string } | undefined {
  if (!config) {
    return undefined;
  }

  const apiKey = resolveOptional(config.api_key, env);
  const baseURL = resolveOptional(config.base_url, env);
  if (!apiKey && !baseURL) {
    return undefined;
  }

  return {
    ...(apiKey ? { apiKey } : {}),
    ...(baseURL ? { baseURL } : {}),
  };
}

function resolvedVertexConfig(
  config: { project?: string; location?: string } | undefined,
  env: NodeJS.ProcessEnv,
): { project?: string; location: string } | undefined {
  if (!config) {
    return undefined;
  }

  const project = resolveOptional(config.project, env);
  const location = resolveRequired(config.location, env, 'llm.provider.vertex.location is required');
  return {
    ...(project ? { project } : {}),
    location,
  };
}

export function resolveLocalKtxLlmConfig(config: KtxProjectLlmConfig, env: NodeJS.ProcessEnv): KtxLlmConfig | null {
  if (config.provider.backend === 'none') {
    return null;
  }
  const modelSlots = resolveModelSlots(config.models, env);
  const vertex = config.provider.backend === 'vertex' ? resolvedVertexConfig(config.provider.vertex, env) : undefined;
  const anthropic = resolvedProviderConfig(config.provider.anthropic, env);
  const gateway = resolvedProviderConfig(config.provider.gateway, env);
  const openaiCompatible = resolvedProviderConfig(config.provider.openaiCompatible, env);
  return {
    backend: config.provider.backend,
    ...(vertex ? { vertex } : {}),
    ...(anthropic ? { anthropic } : {}),
    ...(gateway ? { gateway } : {}),
    ...(openaiCompatible ? { openaiCompatible } : {}),
    modelSlots,
    promptCaching: config.promptCaching,
  };
}

/** @internal */
export function createLocalKtxLlmProviderFromConfig(
  config: KtxProjectLlmConfig,
  deps: LocalConfigDeps = {},
): KtxLlmProvider | null {
  const resolved = resolveLocalKtxLlmConfig(config, deps.env ?? process.env);
  if (!resolved || resolved.backend === 'claude-code' || resolved.backend === 'codex') {
    return null;
  }
  return (deps.createKtxLlmProvider ?? createKtxLlmProvider)(resolved);
}

export function createLocalKtxLlmRuntimeFromConfig(
  config: KtxProjectLlmConfig,
  deps: LocalConfigDeps = {},
): KtxLlmRuntimePort | null {
  const resolved = resolveLocalKtxLlmConfig(config, deps.env ?? process.env);
  if (!resolved) {
    return null;
  }
  if (resolved.backend === 'claude-code') {
    const projectDir = deps.projectDir;
    if (!projectDir) {
      throw new Error('projectDir is required when creating the claude-code LLM runtime');
    }
    return (deps.createClaudeCodeRuntime ?? ((runtimeDeps) => new ClaudeCodeKtxLlmRuntime(runtimeDeps)))({
      projectDir,
      modelSlots: resolved.modelSlots,
      env: deps.env,
      rateLimitGovernor: deps.rateLimitGovernor,
    });
  }
  if (resolved.backend === 'codex') {
    const projectDir = deps.projectDir;
    if (!projectDir) {
      throw new Error('projectDir is required when creating the codex LLM runtime');
    }
    return (deps.createCodexRuntime ?? ((runtimeDeps) => new CodexKtxLlmRuntime(runtimeDeps)))({
      projectDir,
      modelSlots: resolved.modelSlots,
      rateLimitGovernor: deps.rateLimitGovernor,
    });
  }
  const llmProvider = (deps.createKtxLlmProvider ?? createKtxLlmProvider)(resolved);
  return (deps.createAiSdkRuntime ?? ((runtimeDeps) => new AiSdkKtxLlmRuntime(runtimeDeps)))({
    llmProvider,
    rateLimitGovernor: deps.rateLimitGovernor,
  });
}

export function resolveLocalKtxEmbeddingConfig(
  config: KtxProjectEmbeddingConfig,
  env: NodeJS.ProcessEnv,
): KtxEmbeddingConfig | null {
  if (config.backend === 'none') {
    return null;
  }
  if (config.backend === 'sentence-transformers') {
    const baseURL = config.sentenceTransformers?.base_url;
    if (!baseURL) {
      return null;
    }
    return {
      backend: config.backend,
      model: config.model ?? 'all-MiniLM-L6-v2',
      dimensions: config.dimensions,
      sentenceTransformers: {
        baseURL,
        pathPrefix: config.sentenceTransformers?.pathPrefix,
      },
      batchSize: config.batchSize,
    };
  }
  if (config.backend === 'openai') {
    const openai = resolvedProviderConfig(config.openai, env);
    if (!openai?.apiKey) {
      return null;
    }
    return {
      backend: config.backend,
      model: config.model ?? 'text-embedding-3-small',
      dimensions: config.dimensions,
      openai,
      batchSize: config.batchSize,
    };
  }
  throw new Error(`Unsupported ktx embedding backend: ${String((config as { backend?: string }).backend)}`);
}

/** @internal */
export function createLocalKtxEmbeddingProviderFromConfig(
  config: KtxProjectEmbeddingConfig,
  deps: LocalConfigDeps = {},
): KtxEmbeddingProvider | null {
  const resolved = resolveLocalKtxEmbeddingConfig(config, deps.env ?? process.env);
  return resolved ? (deps.createKtxEmbeddingProvider ?? createKtxEmbeddingProvider)(resolved) : null;
}
