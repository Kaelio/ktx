import { request } from 'node:http';
import type { AddressInfo } from 'node:net';
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { describe, expect, it } from 'vitest';
import {
  buildMcpSecurityConfig,
  isMcpRequestAuthorized,
  normalizeHostHeader,
  runKtxMcpHttpServer,
} from '../src/mcp-http-server.js';

describe('normalizeHostHeader', () => {
  it('normalizes host headers before allow-list comparison', () => {
    expect(normalizeHostHeader('LOCALHOST:7878')).toBe('localhost');
    expect(normalizeHostHeader('127.0.0.1:7878')).toBe('127.0.0.1');
    expect(normalizeHostHeader('[::1]:7878')).toBe('::1');
    expect(normalizeHostHeader('  Example.COM  ')).toBe('example.com');
  });
});

describe('buildMcpSecurityConfig', () => {
  it('allows loopback hosts without a token', () => {
    const config = buildMcpSecurityConfig({
      host: '127.0.0.1',
      port: 7878,
      token: undefined,
      allowedHosts: [],
      allowedOrigins: [],
    });

    expect(config.token).toBeUndefined();
    expect(config.allowedHosts).toEqual(['localhost', '127.0.0.1', '::1']);
  });

  it('requires a token for non-loopback binding', () => {
    expect(() =>
      buildMcpSecurityConfig({
        host: '0.0.0.0',
        port: 7878,
        token: undefined,
        allowedHosts: [],
        allowedOrigins: [],
      }),
    ).toThrow('Binding ktx MCP to 0.0.0.0 requires --token or KTX_MCP_TOKEN');
  });

  it('validates allowed origins as full origins', () => {
    expect(() =>
      buildMcpSecurityConfig({
        host: '127.0.0.1',
        port: 7878,
        token: undefined,
        allowedHosts: [],
        allowedOrigins: ['localhost:7878'],
      }),
    ).toThrow('Allowed origin must be a full origin URL');
  });
});

describe('isMcpRequestAuthorized', () => {
  const config = buildMcpSecurityConfig({
    host: '0.0.0.0',
    port: 7878,
    token: 'secret-token',
    allowedHosts: ['mcp.example.test'],
    allowedOrigins: ['https://mcp.example.test'],
  });

  it('accepts a valid host, origin, and bearer token', () => {
    expect(
      isMcpRequestAuthorized(
        {
          path: '/mcp',
          headers: {
            host: 'mcp.example.test:7878',
            origin: 'https://mcp.example.test',
            authorization: 'Bearer secret-token',
          },
        },
        config,
      ),
    ).toEqual({ ok: true });
  });

  it('rejects bad host headers before MCP handling', () => {
    expect(
      isMcpRequestAuthorized(
        { path: '/health', headers: { host: 'evil.example.test' } },
        config,
      ),
    ).toEqual({ ok: false, status: 403, message: 'Host header is not allowed for ktx MCP.' });
  });

  it('rejects browser origins unless explicitly allowed', () => {
    expect(
      isMcpRequestAuthorized(
        {
          path: '/health',
          headers: { host: 'mcp.example.test', origin: 'https://evil.example.test' },
        },
        config,
      ),
    ).toEqual({ ok: false, status: 403, message: 'Origin header is not allowed for ktx MCP.' });
  });

  it('requires bearer auth on /mcp when token auth is enabled', () => {
    expect(
      isMcpRequestAuthorized(
        { path: '/mcp', headers: { host: 'mcp.example.test', authorization: 'Bearer wrong' } },
        config,
      ),
    ).toEqual({ ok: false, status: 401, message: 'Missing or invalid ktx MCP bearer token.' });
  });

  it('does not require bearer auth on /health', () => {
    expect(isMcpRequestAuthorized({ path: '/health', headers: { host: 'mcp.example.test' } }, config)).toEqual({
      ok: true,
    });
  });
});

function postJson(port: number, path: string, body: unknown, headers: Record<string, string> = {}) {
  return new Promise<{ status: number; headers: Record<string, string | string[] | undefined>; body: string }>(
    (resolve, reject) => {
      const payload = JSON.stringify(body);
      const req = request(
        {
          host: '127.0.0.1',
          port,
          path,
          method: 'POST',
          headers: {
            host: `127.0.0.1:${port}`,
            accept: 'application/json, text/event-stream',
            'content-type': 'application/json',
            'content-length': Buffer.byteLength(payload),
            ...headers,
          },
        },
        (res) => {
          const chunks: Buffer[] = [];
          res.on('data', (chunk: Buffer) => chunks.push(chunk));
          res.on('end', () =>
            resolve({
              status: res.statusCode ?? 0,
              headers: res.headers,
              body: Buffer.concat(chunks).toString('utf8'),
            }),
          );
        },
      );
      req.on('error', reject);
      req.end(payload);
    },
  );
}

function get(port: number, path: string, headers: Record<string, string> = {}) {
  return new Promise<{ status: number; headers: Record<string, string | string[] | undefined>; body: string }>(
    (resolve, reject) => {
      const req = request(
        {
          host: '127.0.0.1',
          port,
          path,
          method: 'GET',
          headers: { host: `127.0.0.1:${port}`, ...headers },
        },
        (res) => {
          const chunks: Buffer[] = [];
          res.on('data', (chunk: Buffer) => chunks.push(chunk));
          res.on('end', () =>
            resolve({
              status: res.statusCode ?? 0,
              headers: res.headers,
              body: Buffer.concat(chunks).toString('utf8'),
            }),
          );
        },
      );
      req.on('error', reject);
      req.end();
    },
  );
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

function initializeBody() {
  return {
    jsonrpc: '2.0' as const,
    id: 1,
    method: 'initialize',
    params: {
      protocolVersion: '2025-06-18',
      capabilities: {},
      clientInfo: { name: 'vitest', version: '0.0.0' },
    },
  };
}

describe('runKtxMcpHttpServer', () => {
  it('serves /health with project metadata', async () => {
    const handle = await runKtxMcpHttpServer({
      projectDir: '/tmp/ktx-project',
      host: '127.0.0.1',
      port: 0,
      allowedHosts: [],
      allowedOrigins: [],
      createMcpServer: createTestMcpServer(),
    });
    try {
      const port = (handle.server.address() as AddressInfo).port;
      const response = await get(port, '/health');
      expect(response.status).toBe(200);
      const body = JSON.parse(response.body);
      expect(body).toMatchObject({
        status: 'ok',
        projectDir: '/tmp/ktx-project',
        port,
      });
      expect(typeof body.uptimeMs).toBe('number');
      expect(body.uptimeMs).toBeGreaterThanOrEqual(0);
    } finally {
      await handle.close();
    }
  });

  it('allocates a stateful MCP session on initialize', async () => {
    const handle = await runKtxMcpHttpServer({
      projectDir: '/tmp/ktx-project',
      host: '127.0.0.1',
      port: 0,
      allowedHosts: [],
      allowedOrigins: [],
      createMcpServer: createTestMcpServer(),
    });
    try {
      const port = (handle.server.address() as AddressInfo).port;
      const response = await postJson(port, '/mcp', {
        jsonrpc: '2.0',
        id: 1,
        method: 'initialize',
        params: {
          protocolVersion: '2025-06-18',
          capabilities: {},
          clientInfo: { name: 'vitest', version: '0.0.0' },
        },
      });

      expect(response.status).toBe(200);
      expect(response.headers['mcp-session-id']).toBeTruthy();
    } finally {
      await handle.close();
    }
  });

  it('rejects unknown session ids with 404', async () => {
    const handle = await runKtxMcpHttpServer({
      projectDir: '/tmp/ktx-project',
      host: '127.0.0.1',
      port: 0,
      allowedHosts: [],
      allowedOrigins: [],
      createMcpServer: createTestMcpServer(),
    });
    try {
      const port = (handle.server.address() as AddressInfo).port;
      const response = await postJson(
        port,
        '/mcp',
        { jsonrpc: '2.0', id: 2, method: 'tools/list', params: {} },
        { 'mcp-session-id': 'missing-session' },
      );

      expect(response.status).toBe(404);
      expect(response.body).toContain('Unknown MCP session');
    } finally {
      await handle.close();
    }
  });

  it('logs session open and close with the session id', async () => {
    const cap = capturingIo();
    const handle = await runKtxMcpHttpServer({
      projectDir: '/tmp/ktx-project',
      host: '127.0.0.1',
      port: 0,
      allowedHosts: [],
      allowedOrigins: [],
      createMcpServer: createTestMcpServer(),
      io: cap.io,
    });
    let sessionId: string | undefined;
    try {
      const port = (handle.server.address() as AddressInfo).port;
      const response = await postJson(port, '/mcp', initializeBody());
      sessionId = response.headers['mcp-session-id'] as string;
      expect(sessionId).toBeTruthy();
    } finally {
      await handle.close();
    }

    const lines = cap.json();
    expect(lines.find((line) => line.msg === 'session.open')?.sessionId).toBe(sessionId);
    expect(lines.some((line) => line.msg === 'session.close' && line.sessionId === sessionId)).toBe(true);
  });

  it('never writes the bearer token to the log (headers are not logged)', async () => {
    const cap = capturingIo();
    const token = 'super-secret-token-value'; // pragma: allowlist secret
    const handle = await runKtxMcpHttpServer({
      projectDir: '/tmp/ktx-project',
      host: '127.0.0.1',
      port: 0,
      token,
      allowedHosts: [],
      allowedOrigins: [],
      createMcpServer: createTestMcpServer(),
      io: cap.io,
    });
    try {
      const port = (handle.server.address() as AddressInfo).port;
      const response = await postJson(port, '/mcp', initializeBody(), { authorization: `Bearer ${token}` });
      expect(response.status).toBe(200);
    } finally {
      await handle.close();
    }

    expect(cap.json().some((line) => line.msg === 'session.open')).toBe(true);
    expect(cap.text()).not.toContain(token);
  });
});
