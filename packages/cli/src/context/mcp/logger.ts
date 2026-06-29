import { Writable } from 'node:stream';
import pino, { type DestinationStream, type Logger } from 'pino';
import PinoPretty from 'pino-pretty';
import type { KtxCliIo } from '../../cli-runtime.js';

export type KtxMcpLogger = Logger;

const LOG_LEVELS = new Set(['trace', 'debug', 'info', 'warn', 'error', 'fatal', 'silent']);

const DEFAULT_LEVEL = 'info';
const DEFAULT_SLOW_TOOL_MS = 10_000;

/** @internal */
export function mcpLogLevel(env: NodeJS.ProcessEnv = process.env): string {
  const raw = env.KTX_MCP_LOG_LEVEL?.trim().toLowerCase();
  return raw && LOG_LEVELS.has(raw) ? raw : DEFAULT_LEVEL;
}

/** @internal */
export function mcpSlowToolMs(env: NodeJS.ProcessEnv = process.env): number {
  const raw = Number(env.KTX_MCP_SLOW_TOOL_MS);
  return Number.isFinite(raw) && raw >= 0 ? raw : DEFAULT_SLOW_TOOL_MS;
}

/**
 * Serialize an error for a structured `err` field. Genuine `Error`s get pino's
 * standard serializer (type + message + stack); everything else is reduced to a
 * message — the in-band tool-error path has already lost the original stack.
 */
export function serializeMcpError(error: unknown): Record<string, unknown> {
  if (error instanceof Error) {
    return { ...pino.stdSerializers.err(error) };
  }
  return { message: typeof error === 'string' ? error : String(error) };
}

/**
 * One synchronous pino logger per MCP server process, written to the `io.stderr`
 * sink. stderr is the only universally-correct sink: the stdio transport reserves
 * stdout for JSON-RPC, and the HTTP daemon redirects stderr into `.ktx/logs/mcp.log`.
 * Synchronous writes are load-bearing — a `tool.start` line must reach the fd before
 * a blocking handler runs, so a runaway query still leaves its start record on disk.
 * Format follows the terminal, not a flag: pretty for a TTY, plain JSON otherwise.
 */
export function createMcpLogger(io: KtxCliIo, options: { isTTY?: boolean } = {}): KtxMcpLogger {
  const level = mcpLogLevel();
  const isTTY = options.isTTY ?? process.stderr.isTTY === true;
  if (isTTY) {
    const sink = new Writable({
      write(chunk: Buffer | string, _encoding, callback) {
        io.stderr.write(typeof chunk === 'string' ? chunk : chunk.toString('utf8'));
        callback();
      },
    });
    return pino({ level }, PinoPretty({ colorize: true, sync: true, destination: sink }));
  }
  return pino({ level }, io.stderr as DestinationStream);
}
