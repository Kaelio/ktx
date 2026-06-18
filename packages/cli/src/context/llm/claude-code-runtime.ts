import {
  createSdkMcpServer,
  query as defaultQuery,
  type Options,
  type SDKMessage,
  type SDKResultMessage,
} from '@anthropic-ai/claude-agent-sdk';
import { z } from 'zod';
import { createAbortError, isAbortError, throwIfAborted } from '../core/abort.js';
import { createKtxClaudeCodeEnv } from './claude-code-env.js';
import { resolveClaudeCodeModel } from './claude-code-models.js';
import type { RateLimitGovernor, RateLimitSignal } from './rate-limit-governor.js';
import { createClaudeSdkTools, mcpToolIds } from './runtime-tools.js';
import type {
  KtxGenerateObjectInput,
  KtxGenerateTextInput,
  KtxLlmRuntimePort,
  KtxRuntimeToolSet,
  LlmTokenUsage,
  RunLoopParams,
  RunLoopResult,
  RunLoopStopReason,
} from './runtime-port.js';

type QueryResult = AsyncIterable<SDKMessage> & {
  interrupt?: () => void | Promise<void>;
};

type QueryFn = (params: Parameters<typeof defaultQuery>[0]) => QueryResult;

interface ClaudeQueryOutcome {
  result: SDKResultMessage;
  rejectedRateLimitSignal?: RateLimitSignal;
}

function claudeTokenUsage(result: SDKResultMessage): LlmTokenUsage {
  const usage = (result as { usage?: { input_tokens?: number; output_tokens?: number } }).usage;
  if (!usage) {
    return {};
  }
  const { input_tokens: inputTokens, output_tokens: outputTokens } = usage;
  const totalTokens = inputTokens !== undefined && outputTokens !== undefined ? inputTokens + outputTokens : undefined;
  return {
    ...(inputTokens !== undefined ? { inputTokens } : {}),
    ...(outputTokens !== undefined ? { outputTokens } : {}),
    ...(totalTokens !== undefined ? { totalTokens } : {}),
  };
}

export interface ClaudeCodeKtxLlmRuntimeDeps {
  projectDir: string;
  modelSlots: { default: string } & Partial<Record<string, string>>;
  query?: QueryFn;
  env?: NodeJS.ProcessEnv;
  rateLimitGovernor?: Pick<RateLimitGovernor, 'waitForReady' | 'report' | 'maxRetryAttempts'>;
}

const BUILTIN_TOOLS = [
  'Agent',
  'Task',
  'AskUserQuestion',
  'Bash',
  'Read',
  'Edit',
  'Write',
  'Glob',
  'Grep',
  'WebFetch',
  'WebSearch',
  'TodoWrite',
];

const KTX_MCP_SERVER_NAME = 'ktx';

// SDK-internal pseudo-tool that the Claude Code CLI announces in its
// system/init message whenever outputFormat: { type: 'json_schema' } is set.
// Structured output is returned via result.structured_output (not through
// canUseTool), so the tool only needs to be whitelisted for generateObject's
// init isolation check; generateText / runAgentLoop never see it.
const STRUCTURED_OUTPUT_TOOL_NAME = 'StructuredOutput';

function isResult(message: SDKMessage): message is SDKResultMessage {
  return message.type === 'result';
}

function resultError(result: SDKResultMessage): Error | undefined {
  if (result.subtype === 'success') {
    return undefined;
  }
  const details = result.errors.length > 0 ? `: ${result.errors.join('; ')}` : '';
  return new Error(`Claude Code query failed (${result.subtype})${details}`);
}

/** @internal */
export function mapClaudeCodeStopReason(result: SDKResultMessage): RunLoopStopReason {
  if (result.subtype === 'error_max_turns') {
    return 'budget';
  }
  if (result.terminal_reason === 'max_turns' || result.stop_reason === 'max_turns') {
    return 'budget';
  }
  if (result.subtype === 'success') {
    return result.terminal_reason && result.terminal_reason !== 'completed' ? 'error' : 'natural';
  }
  return 'error';
}

function jsonSchema(schema: z.ZodType): Record<string, unknown> {
  return z.toJSONSchema(schema, { target: 'draft-7' }) as Record<string, unknown>;
}

function modelForRole(modelSlots: ClaudeCodeKtxLlmRuntimeDeps['modelSlots'], role: string): string {
  return resolveClaudeCodeModel(modelSlots[role] ?? modelSlots.default);
}

function assertInitIsolation(
  message: SDKMessage,
  allowedToolIds: Set<string>,
  expectedMcpServerNames: Set<string>,
): void {
  if (message.type !== 'system' || message.subtype !== 'init') {
    return;
  }
  const activeToolIds = new Set(message.tools);
  const unexpectedTools = message.tools.filter((toolName) => !allowedToolIds.has(toolName));
  const missingTools = [...allowedToolIds].filter((toolName) => !activeToolIds.has(toolName));
  const activeMcpServerNames = message.mcp_servers.map((server) => server.name);
  const unexpectedMcpServers = activeMcpServerNames.filter((name) => !expectedMcpServerNames.has(name));
  const missingMcpServers = [...expectedMcpServerNames].filter((name) => !activeMcpServerNames.includes(name));
  const unexpectedPlugins = message.plugins.map((plugin) => plugin.name);
  if (
    unexpectedTools.length > 0 ||
    missingTools.length > 0 ||
    unexpectedMcpServers.length > 0 ||
    missingMcpServers.length > 0 ||
    unexpectedPlugins.length > 0
  ) {
    throw new Error(
      `Claude Code runtime isolation failed: tools=${unexpectedTools.join(',') || '(none)'} missing_tools=${
        missingTools.join(',') || '(none)'
      } mcp_servers=${unexpectedMcpServers.join(',') || '(none)'} missing_mcp_servers=${
        missingMcpServers.join(',') || '(none)'
      } plugins=${unexpectedPlugins.join(',') || '(none)'} host_slash_commands=${
        message.slash_commands.length
      } host_skills=${message.skills.length} host_agents=${message.agents?.join(',') || '(none)'}`,
    );
  }
}

function expectedMcpServerNames(tools: KtxRuntimeToolSet | undefined): Set<string> {
  return tools && Object.keys(tools).length > 0 ? new Set([KTX_MCP_SERVER_NAME]) : new Set();
}

// "session limit" is the Claude Code subscription cap ("You've hit your session
// limit · resets …"); the rest are transient 429-style throttling. All mean
// Claude Code authenticated successfully, so they must not be read as auth
// failures by the governor classifier or the auth probe.
const CLAUDE_RATE_LIMIT_ERROR_MARKERS =
  /\b429\b|rate limit|session limit|usage limit|too many requests|quota exceeded|overloaded|max_retries/i;

// The subscription cap is its own case: re-authenticating and retrying both fail
// until reset, so it gets a distinct message from transient rate limiting.
const CLAUDE_SESSION_LIMIT_MARKERS = /session limit|usage limit/i;

function describeClaudeProbeFailure(message: string): string {
  if (CLAUDE_SESSION_LIMIT_MARKERS.test(message)) {
    return `Claude Code session limit reached. Wait for the reset shown, then rerun setup or the command. Details: ${message}`;
  }
  if (CLAUDE_RATE_LIMIT_ERROR_MARKERS.test(message)) {
    return `Claude Code is rate limited. Retry shortly, then rerun setup or the command. Details: ${message}`;
  }
  return `Claude Code authentication is not usable. Authenticate Claude Code locally with the Claude Code CLI, then rerun setup or the command. ${message}`;
}

function normalizeClaudeResetAtMs(value: unknown): number | undefined {
  if (typeof value === 'number' && Number.isFinite(value) && value > 0) {
    return Math.round(value < 10_000_000_000 ? value * 1_000 : value);
  }
  if (typeof value === 'string') {
    const numeric = Number(value);
    if (Number.isFinite(numeric) && numeric > 0) {
      return normalizeClaudeResetAtMs(numeric);
    }
    const parsed = Date.parse(value);
    return Number.isFinite(parsed) ? parsed : undefined;
  }
  return undefined;
}

function isClaudeRateLimitResult(result: SDKResultMessage, rejectedSignal: RateLimitSignal | undefined): boolean {
  const error = resultError(result);
  if (!error) {
    return false;
  }
  if (rejectedSignal?.status === 'rejected') {
    return true;
  }
  const resultDetails = result as {
    stop_reason?: unknown;
    terminal_reason?: unknown;
    errors?: unknown[];
  };
  const details = [
    error.message,
    resultDetails.stop_reason,
    resultDetails.terminal_reason,
    ...(resultDetails.errors ?? []),
  ]
    .filter((value): value is string => typeof value === 'string' && value.length > 0)
    .join('\n');
  return CLAUDE_RATE_LIMIT_ERROR_MARKERS.test(details);
}

function claudeRateLimitSignal(message: SDKMessage): RateLimitSignal | null {
  const record = message as Record<string, unknown>;
  if (record.type === 'rate_limit_event') {
    const info = record.rate_limit_info as Record<string, unknown> | undefined;
    if (!info) return null;
    const rawStatus = typeof info.status === 'string' ? info.status : 'allowed';
    const resetAtMs = normalizeClaudeResetAtMs(info.resetsAt);
    return {
      provider: 'claude-subscription',
      status: rawStatus === 'rejected' ? 'rejected' : rawStatus === 'allowed_warning' ? 'warning' : 'allowed',
      ...(resetAtMs !== undefined ? { resetAtMs } : {}),
      ...(typeof info.rateLimitType === 'string' ? { rateLimitType: info.rateLimitType } : {}),
      ...(typeof info.utilization === 'number' ? { utilization: info.utilization } : {}),
    };
  }
  if (record.subtype === 'api_retry' || record.type === 'api_retry') {
    const retryDelayMs = typeof record.retry_delay_ms === 'number' ? record.retry_delay_ms : undefined;
    return {
      provider: 'claude-subscription',
      status: 'warning',
      ...(retryDelayMs !== undefined ? { retryAfterMs: retryDelayMs } : {}),
      rateLimitType: 'api_retry',
    };
  }
  return null;
}

function managedMcpSettings(serverNames: string[]): NonNullable<Options['managedSettings']> {
  return {
    allowManagedMcpServersOnly: true,
    allowedMcpServers: serverNames.map((serverName) => ({ serverName })),
  };
}

function baseOptions(input: {
  projectDir: string;
  model: string;
  env: NodeJS.ProcessEnv | undefined;
  maxTurns: number;
  tools?: KtxRuntimeToolSet;
}): Options {
  const toolIds = mcpToolIds(input.tools ?? {});
  const allowedToolIds = new Set(toolIds);
  const expectedServerNames = [...expectedMcpServerNames(input.tools)];
  return {
    cwd: input.projectDir,
    model: input.model,
    maxTurns: input.maxTurns,
    settingSources: [],
    skills: [],
    plugins: [],
    tools: [],
    managedSettings: managedMcpSettings(expectedServerNames),
    strictMcpConfig: true,
    allowedTools: toolIds,
    disallowedTools: BUILTIN_TOOLS,
    canUseTool: async (toolName, _toolInput, options) =>
      allowedToolIds.has(toolName)
        ? { behavior: 'allow', toolUseID: options.toolUseID }
        : {
            behavior: 'deny',
            message: `ktx claude-code runtime only permits current ktx MCP tools; denied ${toolName}.`,
            toolUseID: options.toolUseID,
          },
    permissionMode: 'dontAsk',
    persistSession: false,
    env: createKtxClaudeCodeEnv(input.env),
    ...(input.tools && Object.keys(input.tools).length > 0
      ? {
          mcpServers: {
            [KTX_MCP_SERVER_NAME]: createSdkMcpServer({
              name: KTX_MCP_SERVER_NAME,
              tools: createClaudeSdkTools(input.tools),
            }),
          },
        }
      : {}),
  };
}

async function collectResult(params: {
  query: QueryFn;
  prompt: string;
  options: Options;
  allowedToolIds: Set<string>;
  expectedMcpServerNames: Set<string>;
  rateLimitGovernor?: Pick<RateLimitGovernor, 'waitForReady' | 'report' | 'maxRetryAttempts'>;
  abortSignal?: AbortSignal;
}): Promise<ClaudeQueryOutcome> {
  let result: SDKResultMessage | undefined;
  let rejectedRateLimitSignal: RateLimitSignal | undefined;
  throwIfAborted(params.abortSignal);
  await params.rateLimitGovernor?.waitForReady(params.abortSignal);
  throwIfAborted(params.abortSignal);
  const queryResult = params.query({ prompt: params.prompt, options: params.options });
  const onAbort = () => {
    void Promise.resolve(queryResult.interrupt?.()).catch(() => undefined);
  };
  params.abortSignal?.addEventListener('abort', onAbort, { once: true });
  try {
    for await (const message of queryResult) {
      throwIfAborted(params.abortSignal);
      const rateLimitSignal = claudeRateLimitSignal(message);
      if (rateLimitSignal) {
        if (rateLimitSignal.status === 'rejected') {
          rejectedRateLimitSignal = rateLimitSignal;
        }
        params.rateLimitGovernor?.report(rateLimitSignal);
      }
      assertInitIsolation(message, params.allowedToolIds, params.expectedMcpServerNames);
      if (isResult(message)) {
        result = message;
      }
    }
  } finally {
    params.abortSignal?.removeEventListener('abort', onAbort);
  }
  if (params.abortSignal?.aborted) {
    throw createAbortError();
  }
  if (!result) {
    throw new Error('Claude Code query returned no result message');
  }
  return {
    result,
    ...(rejectedRateLimitSignal ? { rejectedRateLimitSignal } : {}),
  };
}

async function collectResultWithRateLimitRetry(params: Parameters<typeof collectResult>[0]): Promise<SDKResultMessage> {
  // maxRetryAttempts() returns 1 when no governor is present or pacing is
  // disabled, so a rate-limited result surfaces without an extra query; the
  // Claude Code SDK applies its own backoff for transient rejections.
  const maxAttempts = params.rateLimitGovernor?.maxRetryAttempts() ?? 1;
  for (let attempt = 0; ; attempt += 1) {
    const outcome = await collectResult(params);
    if (!isClaudeRateLimitResult(outcome.result, outcome.rejectedRateLimitSignal) || attempt >= maxAttempts - 1) {
      return outcome.result;
    }
  }
}

export class ClaudeCodeKtxLlmRuntime implements KtxLlmRuntimePort {
  private readonly runQuery: QueryFn;

  constructor(private readonly deps: ClaudeCodeKtxLlmRuntimeDeps) {
    this.runQuery = deps.query ?? defaultQuery;
  }

  async generateText(input: KtxGenerateTextInput): Promise<string> {
    const options = baseOptions({
      projectDir: this.deps.projectDir,
      model: modelForRole(this.deps.modelSlots, input.role),
      env: this.deps.env,
      maxTurns: 1,
      tools: input.tools,
    });
    const startedAt = Date.now();
    const result = await collectResultWithRateLimitRetry({
      query: this.runQuery,
      prompt: [input.system, input.prompt].filter(Boolean).join('\n\n'),
      options,
      allowedToolIds: new Set(mcpToolIds(input.tools ?? {})),
      expectedMcpServerNames: expectedMcpServerNames(input.tools),
      rateLimitGovernor: this.deps.rateLimitGovernor,
      abortSignal: input.abortSignal,
    });
    input.onMetrics?.({ totalMs: Date.now() - startedAt, usage: claudeTokenUsage(result) });
    const error = resultError(result);
    if (error) {
      throw error;
    }
    if (result.subtype !== 'success') {
      throw new Error(`Claude Code query failed (${result.subtype})`);
    }
    return result.result;
  }

  async generateObject<TOutput, TSchema extends z.ZodType<TOutput>>(
    input: KtxGenerateObjectInput<TOutput, TSchema>,
  ): Promise<TOutput> {
    const options = {
      ...baseOptions({
        projectDir: this.deps.projectDir,
        model: modelForRole(this.deps.modelSlots, input.role),
        env: this.deps.env,
        // Structured output occasionally takes more than one assistant turn —
        // the model may emit thinking/text before the StructuredOutput tool
        // call, or the SDK may count assistant + tool-result as separate turns.
        // 5 leaves headroom without enabling unbounded loops; the json_schema
        // constraint still forces the final answer to be the schema.
        maxTurns: 5,
        tools: input.tools,
      }),
      outputFormat: { type: 'json_schema' as const, schema: jsonSchema(input.schema as z.ZodType) },
    };
    const startedAt = Date.now();
    const result = await collectResultWithRateLimitRetry({
      query: this.runQuery,
      prompt: [input.system, input.prompt].filter(Boolean).join('\n\n'),
      options,
      allowedToolIds: new Set([...mcpToolIds(input.tools ?? {}), STRUCTURED_OUTPUT_TOOL_NAME]),
      expectedMcpServerNames: expectedMcpServerNames(input.tools),
      rateLimitGovernor: this.deps.rateLimitGovernor,
      abortSignal: input.abortSignal,
    });
    input.onMetrics?.({ totalMs: Date.now() - startedAt, usage: claudeTokenUsage(result) });
    const error = resultError(result);
    if (error) {
      throw error;
    }
    if (result.subtype !== 'success') {
      throw new Error(`Claude Code query failed (${result.subtype})`);
    }
    return (input.schema as z.ZodType<TOutput>).parse(result.structured_output);
  }

  async runAgentLoop(params: RunLoopParams): Promise<RunLoopResult> {
    const startedAt = Date.now();
    try {
      const options = baseOptions({
        projectDir: this.deps.projectDir,
        model: modelForRole(this.deps.modelSlots, params.modelRole),
        env: this.deps.env,
        maxTurns: params.stepBudget,
        tools: params.toolSet,
      });
      const result = await collectResultWithRateLimitRetry({
        query: this.runQuery,
        prompt: params.userPrompt,
        options: { ...options, systemPrompt: params.systemPrompt },
        allowedToolIds: new Set(mcpToolIds(params.toolSet)),
        expectedMcpServerNames: expectedMcpServerNames(params.toolSet),
        rateLimitGovernor: this.deps.rateLimitGovernor,
        abortSignal: params.abortSignal,
      });
      const stopReason = mapClaudeCodeStopReason(result);
      const error = resultError(result);
      return {
        stopReason,
        ...(stopReason === 'error' && error ? { error } : {}),
        metrics: {
          totalMs: Date.now() - startedAt,
          // Authoritative turn count from the SDK result. The runtime no longer
          // re-derives a per-turn counter: it could not match the SDK's `num_turns`
          // and overshot `maxTurns` (the source of the misleading `step 70/40`).
          // Per-step boundaries require that counter and are not consumed anywhere.
          stepCount: result.num_turns,
          stepBoundariesMs: [],
          usage: claudeTokenUsage(result),
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
        metrics: { totalMs: Date.now() - startedAt, stepCount: 0, stepBoundariesMs: [], usage: {} },
      };
    }
  }
}

export async function runClaudeCodeAuthProbe(input: {
  projectDir: string;
  model: string;
  query?: QueryFn;
  env?: NodeJS.ProcessEnv;
}): Promise<{ ok: true } | { ok: false; message: string }> {
  let model: string;
  try {
    model = resolveClaudeCodeModel(input.model);
  } catch (error) {
    return {
      ok: false,
      message: error instanceof Error ? error.message : String(error),
    };
  }

  try {
    const options = baseOptions({
      projectDir: input.projectDir,
      model,
      env: input.env,
      maxTurns: 1,
    });
    const result = await collectResultWithRateLimitRetry({
      query: input.query ?? defaultQuery,
      prompt: 'Reply with exactly: ok',
      options,
      allowedToolIds: new Set(),
      expectedMcpServerNames: new Set(),
    });
    const error = resultError(result);
    if (error) {
      throw error;
    }
    return { ok: true };
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    return {
      ok: false,
      message: describeClaudeProbeFailure(message),
    };
  }
}
