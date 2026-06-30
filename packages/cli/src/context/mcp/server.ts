import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { registerKtxContextTools } from './context-tools.js';
import type { KtxMcpServerDeps, KtxMcpServerLike } from './types.js';

/** @internal */
export function createKtxMcpServer(deps: KtxMcpServerDeps): KtxMcpServerDeps['server'] {
  if (deps.contextTools) {
    registerKtxContextTools({
      server: deps.server,
      ports: deps.contextTools,
      userContext: deps.userContext,
      projectDir: deps.projectDir,
      io: deps.io,
      logger: deps.logger,
      getClientInfo: deps.getClientInfo,
    });
  }

  return deps.server;
}

export function createDefaultKtxMcpServer(
  deps: Omit<KtxMcpServerDeps, 'server'> & { name?: string; version: string },
): McpServer {
  const server = new McpServer({
    name: deps.name ?? 'ktx',
    version: deps.version,
  });
  createKtxMcpServer({
    server: server as KtxMcpServerLike,
    userContext: deps.userContext,
    contextTools: deps.contextTools,
    projectDir: deps.projectDir,
    io: deps.io,
    logger: deps.logger,
    // The SDK populates the client identity after the initialize handshake, so
    // read it lazily at emit time rather than at registration (undefined here).
    getClientInfo: () => server.server.getClientVersion(),
  });
  return server;
}
