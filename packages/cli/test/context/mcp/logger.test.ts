import { afterEach, describe, expect, it, vi } from 'vitest';
import { createMcpLogger, mcpLogLevel, mcpSlowToolMs, serializeMcpError } from '../../../src/context/mcp/logger.js';

function capturingIo() {
  let buf = '';
  return {
    io: { stdout: { write() {} }, stderr: { write(chunk: string) { buf += chunk; } } },
    text: () => buf,
    json: () =>
      buf
        .split('\n')
        .filter((line) => line.trim().startsWith('{'))
        .map((line) => JSON.parse(line) as Record<string, unknown>),
  };
}

describe('mcpLogLevel', () => {
  it('defaults to info when unset', () => {
    expect(mcpLogLevel({})).toBe('info');
  });

  it('accepts a recognized pino level', () => {
    expect(mcpLogLevel({ KTX_MCP_LOG_LEVEL: 'debug' })).toBe('debug');
    expect(mcpLogLevel({ KTX_MCP_LOG_LEVEL: 'WARN' })).toBe('warn');
  });

  it('falls back to info for an unrecognized value', () => {
    expect(mcpLogLevel({ KTX_MCP_LOG_LEVEL: 'loud' })).toBe('info');
  });
});

describe('mcpSlowToolMs', () => {
  it('defaults to 10000ms', () => {
    expect(mcpSlowToolMs({})).toBe(10_000);
  });

  it('parses a numeric override', () => {
    expect(mcpSlowToolMs({ KTX_MCP_SLOW_TOOL_MS: '250' })).toBe(250);
  });

  it('ignores a non-numeric or negative value', () => {
    expect(mcpSlowToolMs({ KTX_MCP_SLOW_TOOL_MS: 'soon' })).toBe(10_000);
    expect(mcpSlowToolMs({ KTX_MCP_SLOW_TOOL_MS: '-5' })).toBe(10_000);
  });
});

describe('serializeMcpError', () => {
  it('serializes an Error with type, message, and stack', () => {
    const out = serializeMcpError(new TypeError('boom'));
    expect(out.type).toBe('TypeError');
    expect(out.message).toBe('boom');
    expect(typeof out.stack).toBe('string');
  });

  it('reduces a non-error to a message (no synthetic stack)', () => {
    expect(serializeMcpError('plain text')).toEqual({ message: 'plain text' });
  });
});

describe('createMcpLogger', () => {
  afterEach(() => {
    vi.unstubAllEnvs();
  });

  it('writes structured JSON lines through io.stderr when not a TTY', () => {
    const cap = capturingIo();
    const logger = createMcpLogger(cap.io, { isTTY: false });
    logger.info({ tool: 'sql_execution', callId: 'abc' }, 'tool.start');

    const [line] = cap.json();
    expect(line.msg).toBe('tool.start');
    expect(line.tool).toBe('sql_execution');
    expect(line.callId).toBe('abc');
    expect(typeof line.time).toBe('number');
    expect(line.level).toBe(30);
  });

  it('writes human-readable (non-JSON) output for a TTY', () => {
    const cap = capturingIo();
    const logger = createMcpLogger(cap.io, { isTTY: true });
    logger.info({ tool: 'sql_execution' }, 'tool.start');

    expect(cap.text()).toContain('tool.start');
    // pino-pretty output is not a JSON line.
    expect(cap.text().trim().startsWith('{')).toBe(false);
  });

  it('honors KTX_MCP_LOG_LEVEL by suppressing below-threshold lines', () => {
    vi.stubEnv('KTX_MCP_LOG_LEVEL', 'warn');
    const cap = capturingIo();
    const logger = createMcpLogger(cap.io, { isTTY: false });
    logger.info({}, 'routine');
    logger.warn({}, 'slow');

    const messages = cap.json().map((line) => line.msg);
    expect(messages).not.toContain('routine');
    expect(messages).toContain('slow');
  });
});
