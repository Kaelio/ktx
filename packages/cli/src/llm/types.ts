import type { LanguageModel, TelemetrySettings, ToolCallRepairFunction, ToolSet } from 'ai';

export const KTX_MODEL_ROLES = ['default', 'triage', 'candidateExtraction', 'curator', 'reconcile', 'repair'] as const;

export type KtxModelRole = (typeof KTX_MODEL_ROLES)[number];
type KtxLlmBackend = 'anthropic' | 'vertex' | 'gateway' | 'openai-compatible' | 'claude-code' | 'codex';
export type KtxPromptCacheTtl = '5m' | '1h';

type KtxJsonValue =
  | null
  | string
  | number
  | boolean
  | KtxJsonValue[]
  | { [key: string]: KtxJsonValue | undefined };

export type KtxProviderOptions = Record<string, { [key: string]: KtxJsonValue | undefined }>;

export interface KtxPromptCachingConfig {
  enabled: boolean;
  systemTtl: KtxPromptCacheTtl;
  toolsTtl: KtxPromptCacheTtl;
  historyTtl: KtxPromptCacheTtl;
  cacheSystem: boolean;
  cacheTools: boolean;
  cacheHistory: boolean;
  vertexFallbackTo5m: boolean;
}

interface KtxTokenUsageEvent {
  source?: string;
  modelId?: string;
  inputTokens?: number;
  outputTokens?: number;
  totalTokens?: number;
}

export interface KtxLlmConfig {
  backend: KtxLlmBackend;
  vertex?: { project?: string; location: string };
  anthropic?: { apiKey?: string; baseURL?: string };
  gateway?: { baseURL?: string; apiKey?: string };
  openaiCompatible?: { apiKey?: string; baseURL?: string };
  modelSlots: { default: string } & Partial<Record<KtxModelRole, string>>;
  promptCaching?: Partial<KtxPromptCachingConfig>;
  telemetry?: {
    experimentalTelemetry?: TelemetrySettings;
    onTokenUsage?: (event: KtxTokenUsageEvent) => void;
  };
}

export interface KtxLlmProvider {
  getModel(role: KtxModelRole): LanguageModel;
  getModelByName(modelId: string): LanguageModel;
  cacheMarker(
    ttl: KtxPromptCacheTtl,
    model?: LanguageModel | string,
  ): { anthropic: { cacheControl: { type: 'ephemeral'; ttl: KtxPromptCacheTtl } } } | undefined;
  repairToolCallHandler(options?: { source?: string }): ToolCallRepairFunction<ToolSet>;
  thinkingProviderOptions(role: KtxModelRole, budgetTokens: number): KtxProviderOptions;
  telemetryConfig(): TelemetrySettings | undefined;
  promptCachingConfig(): KtxPromptCachingConfig;
  activeBackend(): KtxLlmBackend;
}

type KtxEmbeddingBackend = 'openai' | 'sentence-transformers';

interface KtxEmbeddingTokenUsageEvent {
  backend: KtxEmbeddingBackend;
  model: string;
  inputCount: number;
  totalTokens?: number;
}

export interface KtxEmbeddingConfig {
  backend: KtxEmbeddingBackend;
  model: string;
  dimensions: number;
  openai?: { apiKey?: string; baseURL?: string };
  sentenceTransformers?: { baseURL: string; pathPrefix?: string };
  batchSize?: number;
  telemetry?: { onTokenUsage?: (event: KtxEmbeddingTokenUsageEvent) => void };
}

export interface KtxEmbeddingProvider {
  readonly dimensions: number;
  readonly maxBatchSize: number;
  embed(text: string): Promise<number[]>;
  embedMany(texts: string[]): Promise<number[][]>;
}

export interface KtxPromptParts {
  staticSystem: string;
  dynamicSystem?: string;
  leadingUserContext?: string;
}
