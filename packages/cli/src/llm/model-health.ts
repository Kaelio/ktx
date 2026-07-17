import { generateText } from 'ai';
import { createKtxLlmProvider, type KtxLlmProviderFactoryDeps } from './model-provider.js';
import type { KtxLlmConfig } from './types.js';

export type KtxLlmHealthCheckResult = { ok: true } | { ok: false; message: string };

interface KtxLlmHealthCheckDeps extends Omit<KtxLlmProviderFactoryDeps, 'generateText'> {
  generateText?: (options: Parameters<typeof generateText>[0]) => Promise<unknown>;
}

export interface KtxLlmHealthCheckOptions {
  prompt?: string;
  timeoutMs?: number;
  deps?: KtxLlmHealthCheckDeps;
}

function redactHealthCheckMessage(message: string, config: KtxLlmConfig): string {
  const secrets = [config.anthropic?.apiKey, config.gateway?.apiKey, config.openaiCompatible?.apiKey].filter(
    (value): value is string => typeof value === 'string' && value.length > 0,
  );
  return secrets.reduce((current, secret) => current.split(secret).join('[redacted]'), message);
}

async function withTimeout<T>(promise: Promise<T>, timeoutMs: number): Promise<T> {
  let timeout: NodeJS.Timeout | undefined;
  const timeoutPromise = new Promise<never>((_resolve, reject) => {
    timeout = setTimeout(() => reject(new Error(`LLM health check timed out after ${timeoutMs}ms`)), timeoutMs);
  });
  try {
    return await Promise.race([promise, timeoutPromise]);
  } finally {
    if (timeout) {
      clearTimeout(timeout);
    }
  }
}

export async function runKtxLlmHealthCheck(
  config: KtxLlmConfig,
  options: KtxLlmHealthCheckOptions = {},
): Promise<KtxLlmHealthCheckResult> {
  try {
    const { generateText: runGenerateTextOverride, ...providerDeps } = options.deps ?? {};
    const provider = createKtxLlmProvider(config, { ...providerDeps, devtoolsEnabled: false });
    const runGenerateText = runGenerateTextOverride ?? generateText;
    await withTimeout(
      runGenerateText({
        model: provider.getModel('default'),
        prompt: options.prompt ?? 'Reply with exactly: ok',
        temperature: 0,
        maxOutputTokens: 8,
      }),
      options.timeoutMs ?? 15_000,
    );
    return { ok: true };
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    return { ok: false, message: redactHealthCheckMessage(message, config) };
  }
}
