import { PassThrough } from 'node:stream';
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { describe, expect, it } from 'vitest';
import { runKtxMcpStdioServer } from '../src/mcp-stdio-server.js';

function capturingIo() {
  let buf = '';
  return {
    io: { stdout: { write() {} }, stderr: { write(chunk: string) { buf += chunk; } } },
    json: () =>
      buf
        .split('\n')
        .filter((line) => line.trim().startsWith('{'))
        .map((line) => JSON.parse(line) as Record<string, unknown>),
  };
}

function createTestMcpServer() {
  return () => {
    const server = new McpServer({ name: 'ktx-test', version: '0.0.0-test' });
    server.registerTool('ping', { inputSchema: {} }, async () => ({
      content: [{ type: 'text', text: 'pong' }],
    }));
    return server;
  };
}

describe('runKtxMcpStdioServer logging', () => {
  it('routes a transport error through the logger as transport.error and marks the session open', async () => {
    const cap = capturingIo();
    const stdin = new PassThrough();
    const stdout = new PassThrough();

    const run = runKtxMcpStdioServer({
      projectDir: '/tmp/ktx-project',
      createMcpServer: createTestMcpServer(),
      io: cap.io,
      stdin,
      stdout,
    });

    // A malformed JSON-RPC line makes the SDK stdio transport surface onerror.
    stdin.write('this is not json-rpc\n');

    await expect(run).rejects.toBeDefined();

    const lines = cap.json();
    expect(lines.some((line) => line.msg === 'session.open')).toBe(true);
    const transportError = lines.find((line) => line.msg === 'transport.error');
    expect(transportError).toBeDefined();
    expect(transportError?.err).toBeDefined();
  });
});
