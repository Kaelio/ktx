import { randomUUID } from 'node:crypto';
import { createServer, type IncomingHttpHeaders, type IncomingMessage, type Server, type ServerResponse } from 'node:http';
import { loadKtxProject } from './context/project/project.js';
import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { StreamableHTTPServerTransport } from '@modelcontextprotocol/sdk/server/streamableHttp.js';
import { isInitializeRequest } from '@modelcontextprotocol/sdk/types.js';
import { getKtxCliPackageInfo, type KtxCliIo } from './cli-runtime.js';
import { createMcpLogger, serializeMcpError } from './context/mcp/logger.js';
import { createKtxMcpServerFactory } from './mcp-server-factory.js';

const DEFAULT_ALLOWED_HOSTS = ['localhost', '127.0.0.1', '::1'] as const;

export interface McpSecurityConfigInput {
  host: string;
  port: number;
  token?: string;
  allowedHosts: string[];
  allowedOrigins: string[];
}

export interface McpSecurityConfig {
  host: string;
  port: number;
  token?: string;
  allowedHosts: string[];
  allowedOrigins: string[];
}

/** @internal */
export type McpAuthorizationResult =
  | { ok: true }
  | { ok: false; status: 401 | 403; message: string };

function isLoopbackHost(host: string): boolean {
  const normalized = normalizeHostHeader(host);
  return normalized === 'localhost' || normalized === '127.0.0.1' || normalized === '::1';
}

/** @internal */
export function normalizeHostHeader(value: string): string {
  const trimmed = value.trim().toLowerCase();
  if (trimmed.startsWith('[')) {
    const close = trimmed.indexOf(']');
    return close >= 0 ? trimmed.slice(1, close) : trimmed.replace(/^\[/, '');
  }
  const colon = trimmed.lastIndexOf(':');
  if (colon > -1 && trimmed.indexOf(':') === colon) {
    return trimmed.slice(0, colon);
  }
  return trimmed;
}

function fullOrigin(value: string): string {
  let parsed: URL;
  try {
    parsed = new URL(value);
  } catch {
    throw new Error(`Allowed origin must be a full origin URL: ${value}`);
  }
  if (!parsed.protocol || !parsed.host || parsed.pathname !== '/' || parsed.search || parsed.hash) {
    throw new Error(`Allowed origin must be a full origin URL: ${value}`);
  }
  return parsed.origin;
}

export function buildMcpSecurityConfig(input: McpSecurityConfigInput): McpSecurityConfig {
  if (!isLoopbackHost(input.host) && !input.token) {
    throw new Error(`Binding ktx MCP to ${input.host} requires --token or KTX_MCP_TOKEN`);
  }
  const allowedHostSet = new Set<string>(DEFAULT_ALLOWED_HOSTS);
  if (!isLoopbackHost(input.host)) {
    allowedHostSet.add(normalizeHostHeader(input.host));
  }
  for (const host of input.allowedHosts) {
    allowedHostSet.add(normalizeHostHeader(host));
  }
  return {
    host: input.host,
    port: input.port,
    ...(input.token ? { token: input.token } : {}),
    allowedHosts: [...allowedHostSet],
    allowedOrigins: input.allowedOrigins.map(fullOrigin),
  };
}

function headerValue(headers: IncomingHttpHeaders | Record<string, string | undefined>, name: string): string | undefined {
  const value = headers[name.toLowerCase()];
  return Array.isArray(value) ? value[0] : value;
}

/** @internal */
export function isMcpRequestAuthorized(
  request: { path: string; headers: IncomingHttpHeaders | Record<string, string | undefined> },
  config: McpSecurityConfig,
): McpAuthorizationResult {
  const host = headerValue(request.headers, 'host');
  if (!host || !config.allowedHosts.includes(normalizeHostHeader(host))) {
    return { ok: false, status: 403, message: 'Host header is not allowed for ktx MCP.' };
  }
  const origin = headerValue(request.headers, 'origin');
  if (origin && !config.allowedOrigins.includes(origin)) {
    return { ok: false, status: 403, message: 'Origin header is not allowed for ktx MCP.' };
  }
  if (request.path === '/mcp' && config.token) {
    const auth = headerValue(request.headers, 'authorization');
    if (auth !== `Bearer ${config.token}`) {
      return { ok: false, status: 401, message: 'Missing or invalid ktx MCP bearer token.' };
    }
  }
  return { ok: true };
}

export interface KtxMcpHttpServerHandle {
  server: Server;
  close(): Promise<void>;
}

export interface RunKtxMcpHttpServerOptions extends McpSecurityConfigInput {
  projectDir: string;
  cliVersion?: string;
  io?: KtxCliIo;
  createMcpServer?: () => McpServer;
  loadProject?: typeof loadKtxProject;
}

function writeJson(res: ServerResponse, status: number, body: object): void {
  const payload = `${JSON.stringify(body)}\n`;
  res.writeHead(status, {
    'content-type': 'application/json',
    'content-length': Buffer.byteLength(payload),
  });
  res.end(payload);
}

function writeText(res: ServerResponse, status: number, body: string): void {
  res.writeHead(status, { 'content-type': 'text/plain; charset=utf-8' });
  res.end(body);
}

function requestPath(req: IncomingMessage): string {
  const url = new URL(req.url ?? '/', 'http://127.0.0.1');
  return url.pathname;
}

async function readJsonBody(req: IncomingMessage): Promise<unknown> {
  const chunks: Buffer[] = [];
  for await (const chunk of req) {
    chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk));
  }
  const raw = Buffer.concat(chunks).toString('utf8');
  return raw.trim().length === 0 ? undefined : (JSON.parse(raw) as unknown);
}

function listenerPort(server: Server, fallback: number): number {
  const address = server.address();
  return typeof address === 'object' && address ? address.port : fallback;
}

function transportAllowedHosts(config: McpSecurityConfig, server: Server): string[] {
  const port = listenerPort(server, config.port);
  const hosts = new Set<string>(config.allowedHosts);
  for (const host of config.allowedHosts) {
    hosts.add(`${host}:${port}`);
    if (config.port !== 0 && config.port !== port) {
      hosts.add(`${host}:${config.port}`);
    }
  }
  return [...hosts];
}

export async function runKtxMcpHttpServer(options: RunKtxMcpHttpServerOptions): Promise<KtxMcpHttpServerHandle> {
  const config = buildMcpSecurityConfig(options);
  const project =
    options.createMcpServer === undefined
      ? await (options.loadProject ?? loadKtxProject)({ projectDir: options.projectDir })
      : undefined;
  // One logger per process, shared by the tool layer (via the factory) and the
  // transport lifecycle below. Falls back to a no-op sink for programmatic callers.
  const logger = createMcpLogger(options.io ?? { stdout: { write() {} }, stderr: { write() {} } });
  const createMcpServer =
    options.createMcpServer ??
    (await createKtxMcpServerFactory({
      project: project!,
      projectDir: options.projectDir,
      cliVersion: options.cliVersion ?? getKtxCliPackageInfo().version,
      io: options.io,
      logger,
    }));
  const sessions = new Map<string, StreamableHTTPServerTransport>();

  async function newTransport(): Promise<StreamableHTTPServerTransport> {
    let transport: StreamableHTTPServerTransport;
    transport = new StreamableHTTPServerTransport({
      sessionIdGenerator: () => randomUUID(),
      onsessioninitialized: (sessionId) => {
        sessions.set(sessionId, transport);
        logger.info({ sessionId }, 'session.open');
      },
      onsessionclosed: (sessionId) => {
        sessions.delete(sessionId);
      },
      allowedHosts: transportAllowedHosts(config, server),
      allowedOrigins: config.allowedOrigins,
      enableDnsRebindingProtection: true,
    });
    // onclose is the universal session-end signal (clean DELETE and dropped connection both
    // close the transport), so session.close is logged here rather than in onsessionclosed.
    transport.onclose = () => {
      if (transport.sessionId) {
        sessions.delete(transport.sessionId);
        logger.info({ sessionId: transport.sessionId }, 'session.close');
      }
    };
    transport.onerror = (error) => {
      logger.error(
        { ...(transport.sessionId ? { sessionId: transport.sessionId } : {}), err: serializeMcpError(error) },
        'transport.error',
      );
    };
    await createMcpServer().connect(transport);
    return transport;
  }

  const startedAt = performance.now();
  const server = createServer(async (req, res) => {
    const path = requestPath(req);
    const auth = isMcpRequestAuthorized({ path, headers: req.headers }, config);
    if (!auth.ok) {
      writeText(res, auth.status, auth.message);
      return;
    }

    if (path === '/health' && req.method === 'GET') {
      const port = listenerPort(server, config.port);
      const uptimeMs = Math.round(performance.now() - startedAt);
      writeJson(res, 200, { status: 'ok', projectDir: options.projectDir, port, uptimeMs });
      return;
    }

    if (path !== '/mcp' || !['POST', 'GET', 'DELETE'].includes(req.method ?? '')) {
      writeText(res, 404, 'Not found');
      return;
    }

    const sessionId = req.headers['mcp-session-id'];
    const normalizedSessionId = Array.isArray(sessionId) ? sessionId[0] : sessionId;

    if (req.method === 'POST') {
      let body: unknown;
      try {
        body = await readJsonBody(req);
      } catch (error) {
        writeText(res, 400, `Invalid JSON body: ${error instanceof Error ? error.message : String(error)}`);
        return;
      }
      const existing = normalizedSessionId ? sessions.get(normalizedSessionId) : undefined;
      if (existing) {
        await existing.handleRequest(req, res, body);
        return;
      }
      if (normalizedSessionId) {
        writeText(res, 404, `Unknown MCP session: ${normalizedSessionId}`);
        return;
      }
      if (!isInitializeRequest(body)) {
        writeText(res, 400, 'MCP initialize request is required before session traffic.');
        return;
      }
      await (await newTransport()).handleRequest(req, res, body);
      return;
    }

    if (!normalizedSessionId || !sessions.has(normalizedSessionId)) {
      writeText(res, 404, normalizedSessionId ? `Unknown MCP session: ${normalizedSessionId}` : 'Missing MCP session id.');
      return;
    }
    await sessions.get(normalizedSessionId)!.handleRequest(req, res);
  });

  await new Promise<void>((resolve, reject) => {
    server.once('error', reject);
    server.listen(config.port, config.host, () => {
      server.off('error', reject);
      resolve();
    });
  });

  return {
    server,
    async close() {
      for (const transport of sessions.values()) {
        await transport.close();
      }
      await new Promise<void>((resolve, reject) => {
        server.close((error) => (error ? reject(error) : resolve()));
      });
    },
  };
}
