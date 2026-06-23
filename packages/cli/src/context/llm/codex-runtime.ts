import { z } from 'zod';
import { isAbortError, linkAbortSignal } from '../core/abort.js';
import { isCompletedAgentStep, summarizeCodexExecEvents, type CodexExecEventSummary } from './codex-exec-events.js';
import {
  startCodexRuntimeMcpServer,
  type CodexRuntimeMcpServerHandle,
} from './codex-mcp-runtime-server.js';
import { resolveCodexModel } from './codex-models.js';
import { buildCodexRuntimeConfig } from './codex-runtime-config.js';
import { CodexSdkCliRunner, type CodexSdkRunner } from './codex-sdk-runner.js';
import type { RateLimitGovernor } from './rate-limit-governor.js';
import type { KtxModelRole } from '../../llm/types.js';
import type {
  KtxGenerateObjectInput,
  KtxGenerateStructuredJsonInput,
  KtxGenerateTextInput,
  KtxLlmRuntimePort,
  KtxRuntimeToolSet,
  LlmTokenUsage,
  RunLoopParams,
  RunLoopResult,
  SubprocessRuntimeForkSpec,
} from './runtime-port.js';

export interface CodexKtxLlmRuntimeDeps {
  projectDir: string;
  modelSlots: { default: string } & Partial<Record<string, string>>;
  runner?: CodexSdkRunner;
  startMcpServer?: (input: { projectDir: string; toolSet: KtxRuntimeToolSet }) => Promise<CodexRuntimeMcpServerHandle>;
  rateLimitGovernor?: Pick<RateLimitGovernor, 'waitForReady' | 'report' | 'maxRetryAttempts'>;
}

function modelForRole(modelSlots: CodexKtxLlmRuntimeDeps['modelSlots'], role: string): string {
  return resolveCodexModel(modelSlots[role] ?? modelSlots.default);
}

function promptWithSystem(system: string | undefined, prompt: string): string {
  return [system, prompt].filter(Boolean).join('\n\n');
}

interface CollectCodexEventsOptions {
  stepBudget?: number;
  abortController?: AbortController;
}

interface CollectCodexEventsResult {
  events: unknown[];
  budgetExceeded: boolean;
  streamError?: Error;
}

function eventRecord(value: unknown): Record<string, unknown> | undefined {
  return value && typeof value === 'object' ? (value as Record<string, unknown>) : undefined;
}

function isTurnCompleted(event: unknown): boolean {
  return eventRecord(event)?.type === 'turn.completed';
}

/**
 * Drains the Codex stream once, counting each completed agent action so the
 * step budget is enforced mid-run. Every
 * completed agent-action item counts (see {@link isCompletedAgentStep}), so
 * built-in `command_execution` steps decrement the budget the same as
 * `mcp_tool_call`s. A turn that produced no actions still counts as one step,
 * matching the metrics summary and the AI SDK backend.
 */
async function collectEvents(
  events: AsyncIterable<unknown>,
  options: CollectCodexEventsOptions = {},
): Promise<CollectCodexEventsResult> {
  const collected: unknown[] = [];
  let completedSteps = 0;
  let sawActionStep = false;
  let budgetExceeded = false;
  let streamError: Error | undefined;

  // The SDK yields every stdout event, then throws on a non-zero codex exec
  // exit. Catch that throw so the events already collected (which carry the
  // real `turn.failed`/`error` reason) survive for the summary; the masked
  // exit message is kept only as a fallback when no error event was emitted.
  try {
    for await (const event of events) {
      collected.push(event);

      const isActionStep = isCompletedAgentStep(event);
      if (isActionStep) {
        sawActionStep = true;
      } else if (sawActionStep || !isTurnCompleted(event)) {
        // Only fall back to counting a bare turn as a step when the turn produced
        // no agent actions; a completed turn is terminal, so it never aborts.
        continue;
      }

      completedSteps += 1;
      if (isActionStep && options.stepBudget !== undefined && completedSteps >= options.stepBudget) {
        budgetExceeded = true;
        options.abortController?.abort();
        break;
      }
    }
  } catch (error) {
    streamError = error instanceof Error ? error : new Error(String(error));
  }

  return { events: collected, budgetExceeded, ...(streamError ? { streamError } : {}) };
}

function metrics(summary: CodexExecEventSummary, startedAt: number): { totalMs: number; usage: LlmTokenUsage } {
  return { totalMs: Date.now() - startedAt, usage: summary.usage };
}

function summaryError(summary: CodexExecEventSummary, streamError?: Error): Error | undefined {
  // A `turn.failed`/`error` event carries the real reason; prefer it over the
  // SDK's generic non-zero-exit throw. Fall back to the stream error only when
  // no event explained the failure (e.g. spawn failure or auth before a turn).
  if (summary.error) {
    return summary.error;
  }
  if (summary.toolFailures.length > 0) {
    return new Error(`Codex runtime tool call failed: ${summary.toolFailures.join('; ')}`);
  }
  return streamError;
}

function assertSuccessfulText(summary: CodexExecEventSummary, streamError?: Error): string {
  const error = summaryError(summary, streamError);
  if (error) {
    throw error;
  }
  if (!summary.finalText.trim()) {
    throw new Error('Codex completed without an agent message');
  }
  return summary.finalText;
}

function parseStructuredOutput<TOutput, TSchema extends z.ZodType<TOutput>>(schema: TSchema, text: string): TOutput {
  try {
    return schema.parse(JSON.parse(text));
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    throw new Error(`Codex structured output failed validation: ${message}`);
  }
}

async function mcpForTools(input: {
  projectDir: string;
  toolSet?: KtxRuntimeToolSet;
  startMcpServer: CodexKtxLlmRuntimeDeps['startMcpServer'];
}): Promise<CodexRuntimeMcpServerHandle | undefined> {
  if (!input.toolSet || Object.keys(input.toolSet).length === 0) {
    return undefined;
  }
  return (input.startMcpServer ?? startCodexRuntimeMcpServer)({
    projectDir: input.projectDir,
    toolSet: input.toolSet,
  });
}

function runtimeToolNames(toolSet: KtxRuntimeToolSet | undefined): string[] {
  return Object.values(toolSet ?? {}).map((descriptor) => descriptor.name);
}

const CODEX_RATE_LIMIT_MARKERS = /\b429\b|rate limit|too many requests|quota exceeded|temporarily overloaded/i;

function isCodexRateLimitError(error: Error | undefined): boolean {
  return !!error && CODEX_RATE_LIMIT_MARKERS.test(error.message);
}

export class CodexKtxLlmRuntime implements KtxLlmRuntimePort {
  private readonly runner: CodexSdkRunner;

  constructor(private readonly deps: CodexKtxLlmRuntimeDeps) {
    this.runner = deps.runner ?? new CodexSdkCliRunner();
  }

  private async runWithRateLimitRetry<T>(
    abortSignal: AbortSignal | undefined,
    run: () => Promise<T>,
    getError: (result: T) => Error | undefined,
  ): Promise<T> {
    // maxRetryAttempts() returns 1 when no governor is present or pacing is
    // disabled, so an opaque rate-limit failure surfaces on the first attempt
    // instead of being retried with no backoff.
    const maxAttempts = this.deps.rateLimitGovernor?.maxRetryAttempts() ?? 1;
    for (let attempt = 0; ; attempt += 1) {
      await this.deps.rateLimitGovernor?.waitForReady(abortSignal);
      const lastAttempt = attempt >= maxAttempts - 1;
      try {
        const result = await run();
        const error = getError(result);
        if (!isCodexRateLimitError(error) || lastAttempt) {
          return result;
        }
      } catch (error) {
        if (isAbortError(error)) {
          throw error;
        }
        const err = error instanceof Error ? error : new Error(String(error));
        if (!isCodexRateLimitError(err) || lastAttempt) {
          throw error;
        }
      }
      this.deps.rateLimitGovernor?.report({ provider: 'codex', status: 'rejected', rateLimitType: 'opaque' });
    }
  }

  async generateText(input: KtxGenerateTextInput): Promise<string> {
    const startedAt = Date.now();
    const model = modelForRole(this.deps.modelSlots, input.role);
    const mcp = await mcpForTools({
      projectDir: this.deps.projectDir,
      toolSet: input.tools,
      startMcpServer: this.deps.startMcpServer,
    });
    try {
      const config = buildCodexRuntimeConfig({
        model,
        ...(mcp
          ? {
              mcp: {
                url: mcp.url,
                bearerTokenEnvVar: mcp.bearerTokenEnvVar,
                bearerToken: mcp.bearerToken,
                toolNames: runtimeToolNames(input.tools),
              },
            }
          : {}),
      });
      const result = await this.runWithRateLimitRetry(
        input.abortSignal,
        async () => {
          const collected = await collectEvents(
            await this.runner.runStreamed({
              projectDir: this.deps.projectDir,
              model,
              prompt: promptWithSystem(input.system, input.prompt),
              configOverrides: config.configOverrides,
              env: config.env,
              ...(input.abortSignal ? { signal: input.abortSignal } : {}),
            }),
          );
          const summary = summarizeCodexExecEvents(collected.events, { startedAt });
          return { collected, summary };
        },
        ({ collected, summary }) => summaryError(summary, collected.streamError),
      );
      input.onMetrics?.(metrics(result.summary, startedAt));
      return assertSuccessfulText(result.summary, result.collected.streamError);
    } finally {
      await mcp?.close();
    }
  }

  // Structured generation has no tools, so it skips the MCP server that
  // generateText/runAgentLoop need; generateObject and generateStructuredJson
  // (the kill-boundary child path) share this one streaming implementation.
  private async streamStructuredText(input: {
    role: KtxModelRole;
    prompt: string;
    system?: string;
    jsonSchema: Record<string, unknown>;
    abortSignal?: AbortSignal;
  }): Promise<{ text: string; summary: CodexExecEventSummary; startedAt: number }> {
    const startedAt = Date.now();
    const model = modelForRole(this.deps.modelSlots, input.role);
    const config = buildCodexRuntimeConfig({ model });
    const result = await this.runWithRateLimitRetry(
      input.abortSignal,
      async () => {
        const collected = await collectEvents(
          await this.runner.runStreamed({
            projectDir: this.deps.projectDir,
            model,
            prompt: promptWithSystem(input.system, input.prompt),
            configOverrides: config.configOverrides,
            env: config.env,
            outputSchema: input.jsonSchema,
            ...(input.abortSignal ? { signal: input.abortSignal } : {}),
          }),
        );
        const summary = summarizeCodexExecEvents(collected.events, { startedAt });
        return { collected, summary };
      },
      ({ collected, summary }) => summaryError(summary, collected.streamError),
    );
    return {
      text: assertSuccessfulText(result.summary, result.collected.streamError),
      summary: result.summary,
      startedAt,
    };
  }

  async generateObject<TOutput, TSchema extends z.ZodType<TOutput>>(
    input: KtxGenerateObjectInput<TOutput, TSchema>,
  ): Promise<TOutput> {
    const { text, summary, startedAt } = await this.streamStructuredText({
      role: input.role,
      prompt: input.prompt,
      ...(input.system !== undefined ? { system: input.system } : {}),
      jsonSchema: z.toJSONSchema(input.schema, { target: 'draft-7' }) as Record<string, unknown>,
      ...(input.abortSignal ? { abortSignal: input.abortSignal } : {}),
    });
    input.onMetrics?.(metrics(summary, startedAt));
    return parseStructuredOutput(input.schema, text);
  }

  async generateStructuredJson(input: KtxGenerateStructuredJsonInput): Promise<unknown> {
    const { text } = await this.streamStructuredText({
      role: input.role,
      prompt: input.prompt,
      ...(input.system !== undefined ? { system: input.system } : {}),
      jsonSchema: input.jsonSchema,
      ...(input.abortSignal ? { abortSignal: input.abortSignal } : {}),
    });
    try {
      return JSON.parse(text);
    } catch (error) {
      throw new Error(`Codex structured output is not valid JSON: ${error instanceof Error ? error.message : String(error)}`);
    }
  }

  subprocessForkSpec(): SubprocessRuntimeForkSpec {
    return { backend: 'codex', projectDir: this.deps.projectDir, modelSlots: this.deps.modelSlots };
  }

  async runAgentLoop(params: RunLoopParams): Promise<RunLoopResult> {
    const startedAt = Date.now();
    const model = modelForRole(this.deps.modelSlots, params.modelRole);
    let mcp: CodexRuntimeMcpServerHandle | undefined;
    try {
      mcp = await mcpForTools({
        projectDir: this.deps.projectDir,
        toolSet: params.toolSet,
        startMcpServer: this.deps.startMcpServer,
      });
      const config = buildCodexRuntimeConfig({
        model,
        ...(mcp
          ? {
              mcp: {
                url: mcp.url,
                bearerTokenEnvVar: mcp.bearerTokenEnvVar,
                bearerToken: mcp.bearerToken,
                toolNames: runtimeToolNames(params.toolSet),
              },
            }
          : {}),
      });
      const result = await this.runWithRateLimitRetry(
        params.abortSignal,
        async () => {
          const linked = linkAbortSignal(params.abortSignal);
          const abortController = linked.controller;
          try {
            const collected = await collectEvents(
              await this.runner.runStreamed({
                projectDir: this.deps.projectDir,
                model,
                prompt: promptWithSystem(params.systemPrompt, params.userPrompt),
                configOverrides: config.configOverrides,
                env: config.env,
                signal: abortController.signal,
              }),
              { stepBudget: params.stepBudget, abortController },
            );
            const summary = summarizeCodexExecEvents(collected.events, { startedAt });
            return { collected, summary };
          } finally {
            linked.dispose();
          }
        },
        ({ collected, summary }) => summaryError(summary, collected.streamError),
      );
      const error = summaryError(result.summary, result.collected.streamError);
      if (isAbortError(error)) {
        throw error;
      }
      const stopReason = result.collected.budgetExceeded ? 'budget' : error ? 'error' : result.summary.stopReason;
      return {
        stopReason,
        ...(stopReason === 'error' && error ? { error } : {}),
        metrics: {
          totalMs: Date.now() - startedAt,
          usage: result.summary.usage,
          stepCount: result.summary.stepCount,
          stepBoundariesMs: result.summary.stepBoundariesMs,
        },
      };
    } catch (error) {
      if (isAbortError(error)) {
        throw error;
      }
      const err = error instanceof Error ? error : new Error(String(error));
      return {
        stopReason: 'error',
        error: err,
        metrics: { totalMs: Date.now() - startedAt, usage: {}, stepCount: 0, stepBoundariesMs: [] },
      };
    } finally {
      await mcp?.close();
    }
  }
}

// A rejected model is not an auth failure: Codex authenticated, connected, and
// the API refused the model id. These markers come from the API error envelope
// (e.g. "model is not supported", "invalid_request_error").
const MODEL_UNAVAILABLE_MARKERS =
  /\bnot supported\b|\bnot available\b|\bdoes not exist\b|invalid_request_error|\bunknown model\b|\bunsupported model\b/i;

function describeCodexProbeFailure(model: string, message: string): { message: string; fix: string } {
  if (MODEL_UNAVAILABLE_MARKERS.test(message)) {
    const fix = `Run \`codex\` to see the models your account supports, then set llm.models.default in ktx.yaml (or rerun \`ktx setup\`).`;
    return {
      message: `Codex is authenticated, but the configured model "${model}" is not available for this Codex account. ${fix} Details: ${message}`,
      fix,
    };
  }
  const fix = `Authenticate Codex locally with the Codex CLI, verify the Codex CLI is installed, then rerun setup or \`ktx status\`.`;
  return {
    message: `Codex authentication is not usable. ${fix} Details: ${message}`,
    fix,
  };
}

export async function runCodexAuthProbe(input: {
  projectDir: string;
  model: string;
  runner?: CodexSdkRunner;
}): Promise<{ ok: true } | { ok: false; message: string; fix: string }> {
  let model: string;
  try {
    model = resolveCodexModel(input.model);
  } catch (error) {
    return {
      ok: false,
      message: error instanceof Error ? error.message : String(error),
      fix: 'Set llm.models.default in ktx.yaml to a supported codex model (codex, default, or a gpt-* / codex-* id), or rerun `ktx setup`.',
    };
  }

  const runtime = new CodexKtxLlmRuntime({
    projectDir: input.projectDir,
    modelSlots: { default: model },
    ...(input.runner ? { runner: input.runner } : {}),
  });
  try {
    await runtime.generateText({ role: 'default', prompt: 'Reply with exactly: ok' });
    return { ok: true };
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    return { ok: false, ...describeCodexProbeFailure(model, message) };
  }
}
