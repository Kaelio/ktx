import { KtxIngestEmbeddingPortAdapter } from './context/llm/embedding-port.js';
import { createDefaultKtxMcpServer } from './context/mcp/server.js';
import { createLocalProjectMcpContextPorts } from './context/mcp/local-project-ports.js';
import { createLocalProjectMemoryIngest } from './context/memory/local-memory.js';
import { assertConfiguredConnectionId } from './context/connections/configured-connections.js';
import type { KtxMcpLogger } from './context/mcp/logger.js';
import type { MemoryIngestPort } from './context/mcp/types.js';
import type { KtxLocalProject } from './context/project/project.js';
import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import type { KtxCliIo } from './cli-runtime.js';
import { resolveProjectEmbeddingProvider } from './embedding-resolution.js';
import { createKtxCliIngestQueryExecutor } from './ingest-query-executor.js';
import { createKtxCliScanConnector } from './local-scan-connectors.js';
import { createLazyManagedPythonSemanticLayerComputePort } from './managed-python-command.js';
import { createManagedDaemonSqlAnalysisPort } from './managed-python-http.js';

function noopMcpIo(): KtxCliIo {
  return {
    stdout: { write() {} },
    stderr: { write() {} },
  };
}

export async function createKtxMcpServerFactory(input: {
  project: KtxLocalProject;
  projectDir: string;
  cliVersion: string;
  io?: KtxCliIo;
  logger?: KtxMcpLogger;
}): Promise<() => McpServer> {
  const io = input.io ?? noopMcpIo();
  const queryExecutor = createKtxCliIngestQueryExecutor(input.project);
  const semanticLayerCompute = createLazyManagedPythonSemanticLayerComputePort({
    cliVersion: input.cliVersion,
    installPolicy: 'auto',
    io,
  });
  const sqlAnalysis = createManagedDaemonSqlAnalysisPort({
    cliVersion: input.cliVersion,
    projectDir: input.projectDir,
    installPolicy: 'auto',
    io,
  });
  const resolution = await resolveProjectEmbeddingProvider(input.project, {
    mode: 'use-if-running',
    cliVersion: input.cliVersion,
    io,
  });
  const embeddingProvider =
    resolution.kind === 'configured' || resolution.kind === 'managed-running' || resolution.kind === 'managed-started'
      ? resolution.provider
      : null;
  const embeddingService = embeddingProvider ? new KtxIngestEmbeddingPortAdapter(embeddingProvider) : null;
  const contextTools = createLocalProjectMcpContextPorts(input.project, {
    semanticLayerCompute,
    queryExecutor,
    sqlAnalysis,
    embeddingService,
    localScan: {
      createConnector: async (connectionId) => createKtxCliScanConnector(input.project, connectionId),
    },
  });

  let memoryIngest: MemoryIngestPort | undefined;
  try {
    const baseMemoryIngest = createLocalProjectMemoryIngest(input.project, {
      semanticLayerCompute,
      queryExecutor,
      embeddingProvider,
    });
    // Validate the explicit connectionId argument here so a typo is rejected with the
    // configured ids before the ingest run starts; persisted page scope is validated
    // separately (warn-only) and must not fail.
    memoryIngest = {
      ingest: (ingestInput) => {
        if (ingestInput.connectionId !== undefined) {
          assertConfiguredConnectionId(input.project.config.connections, ingestInput.connectionId);
        }
        return baseMemoryIngest.ingest(ingestInput);
      },
      status: (runId) => baseMemoryIngest.status(runId),
    };
  } catch (error) {
    io.stderr.write(`ktx MCP memory_ingest disabled: ${error instanceof Error ? error.message : String(error)}\n`);
  }

  return () =>
    createDefaultKtxMcpServer({
      name: 'ktx',
      version: input.cliVersion,
      userContext: { userId: 'local' },
      projectDir: input.projectDir,
      io,
      ...(input.logger ? { logger: input.logger } : {}),
      contextTools: {
        ...contextTools,
        ...(memoryIngest ? { memoryIngest } : {}),
      },
    });
}
