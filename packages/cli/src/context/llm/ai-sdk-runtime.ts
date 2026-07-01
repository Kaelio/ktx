import { KtxMessageBuilder, splitKtxSystemMessages } from '../../llm/message-builder.js';
import type { KtxLlmProvider } from '../../llm/types.js';
import { generateText, Output, stepCountIs, type FlexibleSchema, type TelemetrySettings, type ToolSet } from 'ai';
import type { z } from 'zod';
import { noopLogger, type KtxLogger } from '../../context/core/config.js';
import { isAbortError } from '../core/abort.js';
import { summarizeKtxLlmDebugRequest, type KtxLlmDebugRequestRecorder } from './debug-request-recorder.js';
import type { RateLimitGovernor, RateLimitProvider, RateLimitSignal } from './rate-limit-governor.js';
import { createAiSdkToolSet } from './runtime-tools.js';
import type {
  KtxGenerateObjectInput,
  KtxGenerateTextInput,
  KtxLlmRuntimePort,
  LlmTokenUsage,
  RunLoopParams,
  RunLoopResult,
} from './runtime-port.js';

interface AgentTelemetryPort {
  createTelemetry(tags: Record<string, string>): TelemetrySettings;
}

interface MaybeUsage {
  inputTokens?: number;
  outputTokens?: number;
  totalTokens?: number;
}

function toLlmTokenUsage(usage: MaybeUsage | undefined): LlmTokenUsage {
  if (!usage) {
    return {};
  }
  return {
    ...(usage.inputTokens !== undefined ? { inputTokens: usage.inputTokens } : {}),
    ...(usage.outputTokens !== undefined ? { outputTokens: usage.outputTokens } : {}),
    ...(usage.totalTokens !== undefined ? { totalTokens: usage.totalTokens } : {}),
  };
}

export interface AiSdkKtxLlmRuntimeDeps {
  llmProvider: KtxLlmProvider;
  telemetry?: AgentTelemetryPort;
  logger?: KtxLogger;
  debugRequestRecorder?: KtxLlmDebugRequestRecorder;
  rateLimitGovernor?: Pick<RateLimitGovernor, 'waitForReady' | 'report' | 'maxRetryAttempts'>;
}

function hasTools(tools: Record<string, unknown>): boolean {
  return Object.keys(tools).length > 0;
}

function modelProviderName(model: unknown): RateLimitProvider {
  const provider = (model as { provider?: string }).provider ?? '';
  return provider.includes('vertex') || provider.includes('google') ? 'vertex' : 'anthropic-api';
}

interface HeaderLimitPair {
  limit: string;
  remaining: string;
  rateLimitType: string;
}

const RATE_LIMIT_HEADER_PAIRS: HeaderLimitPair[] = [
  {
    limit: 'anthropic-ratelimit-requests-limit',
    remaining: 'anthropic-ratelimit-requests-remaining',
    rateLimitType: 'rpm',
  },
  {
    limit: 'anthropic-ratelimit-tokens-limit',
    remaining: 'anthropic-ratelimit-tokens-remaining',
    rateLimitType: 'tpm',
  },
  {
    limit: 'anthropic-ratelimit-input-tokens-limit',
    remaining: 'anthropic-ratelimit-input-tokens-remaining',
    rateLimitType: 'itpm',
  },
  {
    limit: 'anthropic-ratelimit-output-tokens-limit',
    remaining: 'anthropic-ratelimit-output-tokens-remaining',
    rateLimitType: 'otpm',
  },
  {
    limit: 'x-ratelimit-limit-requests',
    remaining: 'x-ratelimit-remaining-requests',
    rateLimitType: 'rpm',
  },
  {
    limit: 'x-ratelimit-limit-tokens',
    remaining: 'x-ratelimit-remaining-tokens',
    rateLimitType: 'tpm',
  },
];

function normalizeHeaders(headers: unknown): Record<string, string> {
  if (!headers || typeof headers !== 'object') {
    return {};
  }
  const get = (headers as { get?: unknown }).get;
  if (typeof get === 'function') {
    const out: Record<string, string> = {};
    for (const pair of RATE_LIMIT_HEADER_PAIRS) {
      const limit = get.call(headers, pair.limit);
      const remaining = get.call(headers, pair.remaining);
      if (typeof limit === 'string') out[pair.limit] = limit;
      if (typeof remaining === 'string') out[pair.remaining] = remaining;
    }
    return out;
  }
  return Object.fromEntries(
    Object.entries(headers as Record<string, unknown>)
      .filter((entry): entry is [string, string | number] => typeof entry[1] === 'string' || typeof entry[1] === 'number')
      .map(([key, value]) => [key.toLowerCase(), String(value)]),
  );
}

function numericHeader(headers: Record<string, string>, key: string): number | undefined {
  const value = Number(headers[key]);
  return Number.isFinite(value) && value >= 0 ? value : undefined;
}

function utilizationForPair(headers: Record<string, string>, pair: HeaderLimitPair): number | undefined {
  const limit = numericHeader(headers, pair.limit);
  const remaining = numericHeader(headers, pair.remaining);
  if (limit === undefined || remaining === undefined || limit <= 0) {
    return undefined;
  }
  return 1 - Math.min(limit, remaining) / limit;
}

function aiSdkHeaderRateLimitSignal(provider: RateLimitProvider, result: unknown): RateLimitSignal | undefined {
  const headers = normalizeHeaders((result as { response?: { headers?: unknown } }).response?.headers);
  let best: { utilization: number; rateLimitType: string } | undefined;
  for (const pair of RATE_LIMIT_HEADER_PAIRS) {
    const utilization = utilizationForPair(headers, pair);
    if (utilization === undefined) {
      continue;
    }
    if (!best || utilization > best.utilization) {
      best = { utilization, rateLimitType: pair.rateLimitType };
    }
  }
  if (!best) {
    return undefined;
  }
  return {
    provider,
    status: 'allowed',
    rateLimitType: best.rateLimitType,
    utilization: Number(best.utilization.toFixed(4)),
  };
}

function retryAfterMs(error: unknown): number | undefined {
  const value = (error as { retryAfter?: unknown }).retryAfter;
  if (typeof value === 'number' && Number.isFinite(value) && value > 0) {
    return value < 1_000 ? value * 1_000 : value;
  }
  return undefined;
}

function isAiSdkRateLimitError(error: unknown): boolean {
  const record = error as { name?: string; statusCode?: number; status?: number };
  return record.name === 'TooManyRequestsError' || record.statusCode === 429 || record.status === 429;
}

export class AiSdkKtxLlmRuntime implements KtxLlmRuntimePort {
  private readonly logger: KtxLogger;

  constructor(private readonly deps: AiSdkKtxLlmRuntimeDeps) {
    this.logger = deps.logger ?? noopLogger;
  }

  // HTTP backend: abortSignal cancels the underlying fetch natively, so there is
  // no SDK-owned child to tree-kill.
  subprocessForkSpec(): null {
    return null;
  }

  private async generateTextWithRateLimitRetry<T>(
    provider: RateLimitProvider,
    abortSignal: AbortSignal | undefined,
    run: () => Promise<T>,
  ): Promise<T> {
    // maxRetryAttempts() returns 1 when no governor is present or pacing is
    // disabled, so a 429 throws immediately instead of hammering the provider
    // with no backoff; the AI SDK's own maxRetries still handles transient 429s.
    const maxAttempts = this.deps.rateLimitGovernor?.maxRetryAttempts() ?? 1;
    let attempt = 0;
    while (true) {
      await this.deps.rateLimitGovernor?.waitForReady(abortSignal);
      try {
        const result = await run();
        const signal = aiSdkHeaderRateLimitSignal(provider, result);
        if (signal) {
          this.deps.rateLimitGovernor?.report(signal);
        }
        return result;
      } catch (error) {
        if (isAbortError(error) || !isAiSdkRateLimitError(error) || attempt >= maxAttempts - 1) {
          throw error;
        }
        attempt += 1;
        const retryAfter = retryAfterMs(error);
        this.deps.rateLimitGovernor?.report({
          provider,
          status: 'rejected',
          rateLimitType: 'http_429',
          ...(retryAfter !== undefined ? { retryAfterMs: retryAfter } : {}),
        });
      }
    }
  }

  async generateText(input: KtxGenerateTextInput): Promise<string> {
    const model = this.deps.llmProvider.getModel(input.role);
    if ((model as { provider?: string }).provider === 'deterministic') {
      return `Deterministic description for ${input.prompt.slice(0, 64).trim() || 'data source'}`;
    }
    const tools = createAiSdkToolSet(input.tools ?? {});
    const built = new KtxMessageBuilder(this.deps.llmProvider).wrapSimple({
      system: input.system,
      messages: [{ role: 'user', content: input.prompt }],
      tools,
      model,
    });
    const split = splitKtxSystemMessages(built.messages);
    const startedAt = Date.now();
    const request = {
      model,
      temperature: input.temperature ?? 0,
      ...(split.system ? { system: split.system } : {}),
      messages: split.messages,
      tools: built.tools as ToolSet,
      ...(input.abortSignal ? { abortSignal: input.abortSignal } : {}),
      ...(hasTools(tools)
        ? {
            experimental_repairToolCall: this.deps.llmProvider.repairToolCallHandler({
              source: `ktx-${input.role}`,
            }),
          }
        : {}),
    };
    const result = await this.generateTextWithRateLimitRetry(modelProviderName(model), input.abortSignal, () => generateText(request));
    input.onMetrics?.({ totalMs: Date.now() - startedAt, usage: toLlmTokenUsage(result.totalUsage ?? result.usage) });
    if (typeof result.text !== 'string') {
      throw new Error('ktx LLM text generation returned no text');
    }
    return result.text;
  }

  async generateObject<TOutput, TSchema extends z.ZodType<TOutput>>(
    input: KtxGenerateObjectInput<TOutput, TSchema>,
  ): Promise<TOutput> {
    const model = this.deps.llmProvider.getModel(input.role);
    const tools = createAiSdkToolSet(input.tools ?? {});
    const built = new KtxMessageBuilder(this.deps.llmProvider).wrapSimple({
      system: input.system,
      messages: [{ role: 'user', content: input.prompt }],
      tools,
      model,
    });
    const split = splitKtxSystemMessages(built.messages);
    const startedAt = Date.now();
    const request = {
      model,
      temperature: input.temperature ?? 0,
      ...(split.system ? { system: split.system } : {}),
      messages: split.messages,
      tools: built.tools as ToolSet,
      ...(input.abortSignal ? { abortSignal: input.abortSignal } : {}),
      ...(hasTools(tools)
        ? {
            experimental_repairToolCall: this.deps.llmProvider.repairToolCallHandler({
              source: `ktx-${input.role}`,
            }),
          }
        : {}),
      output: Output.object({ schema: input.schema as FlexibleSchema<TOutput> }),
    };
    const result = await this.generateTextWithRateLimitRetry(modelProviderName(model), input.abortSignal, () => generateText(request));
    input.onMetrics?.({ totalMs: Date.now() - startedAt, usage: toLlmTokenUsage(result.totalUsage ?? result.usage) });
    if (result.output == null) {
      throw new Error('ktx LLM object generation returned no output');
    }
    return result.output as TOutput;
  }

  async runAgentLoop(params: RunLoopParams): Promise<RunLoopResult> {
    let stepIndex = 0;
    const startedAt = Date.now();
    const stepBoundariesMs: number[] = [];
    try {
      const model = this.deps.llmProvider.getModel(params.modelRole);
      const tools = createAiSdkToolSet(params.toolSet);
      const builder = new KtxMessageBuilder(this.deps.llmProvider);
      const built = builder.wrapSimple({
        system: params.systemPrompt,
        messages: [{ role: 'user', content: params.userPrompt }],
        tools,
        model,
      });
      const promptMessages = splitKtxSystemMessages(built.messages);

      await this.deps.debugRequestRecorder?.record(
        summarizeKtxLlmDebugRequest({
          operationName: params.telemetryTags.operationName ?? 'ktx-agent-runner',
          source: params.telemetryTags.source,
          jobId: params.telemetryTags.jobId,
          unitKey: params.telemetryTags.unitKey,
          modelRole: params.modelRole,
          modelId: (model as { modelId?: string }).modelId ?? params.modelRole,
          messages: built.messages,
          tools: built.tools as Record<string, { providerOptions?: unknown }>,
        }),
      );

      const request = {
        model,
        temperature: 0,
        stopWhen: stepCountIs(params.stepBudget),
        experimental_telemetry: this.deps.telemetry?.createTelemetry(params.telemetryTags) ?? this.deps.llmProvider.telemetryConfig(),
        experimental_repairToolCall: this.deps.llmProvider.repairToolCallHandler({
          source: params.telemetryTags.operationName ?? 'ktx-agent-runner',
        }),
        ...(promptMessages.system ? { system: promptMessages.system } : {}),
        messages: promptMessages.messages,
        tools: built.tools as ToolSet,
        ...(params.abortSignal ? { abortSignal: params.abortSignal } : {}),
        // Count model round-trips locally for metrics. `stepCountIs(stepBudget)`
        // caps the loop, so this counter never exceeds the budget.
        onStepFinish: () => {
          stepIndex += 1;
          stepBoundariesMs.push(Date.now() - startedAt);
        },
      };
      const result = await this.generateTextWithRateLimitRetry(modelProviderName(model), params.abortSignal, () => generateText(request));
      return {
        stopReason: 'natural',
        metrics: {
          totalMs: Date.now() - startedAt,
          stepCount: stepIndex,
          stepBoundariesMs,
          usage: toLlmTokenUsage(result.totalUsage ?? result.usage),
        },
      };
    } catch (error) {
      if (isAbortError(error)) {
        throw error;
      }
      const err = error instanceof Error ? error : new Error(String(error));
      this.logger.warn(`[agent-runner] loop failed: ${err.message}`);
      return {
        stopReason: 'error',
        error: err,
        metrics: { totalMs: Date.now() - startedAt, stepCount: stepIndex, stepBoundariesMs, usage: {} },
      };
    }
  }
}
