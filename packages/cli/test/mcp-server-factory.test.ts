import { beforeEach, describe, expect, it, vi } from 'vitest';
import { createDefaultKtxMcpServer } from '../src/context/mcp/server.js';
import { createLocalProjectMcpContextPorts } from '../src/context/mcp/local-project-ports.js';
import { createLocalProjectMemoryIngest } from '../src/context/memory/local-memory.js';
import { resolveProjectEmbeddingProvider } from '../src/embedding-resolution.js';
import { createKtxCliScanConnector } from '../src/local-scan-connectors.js';
import { createLazyManagedPythonSemanticLayerComputePort } from '../src/managed-python-command.js';
import { createKtxMcpServerFactory } from '../src/mcp-server-factory.js';

type FakeEmbeddingProvider = {
  maxBatchSize: number;
  embed(text: string): Promise<number[]>;
  embedMany(texts: string[]): Promise<number[][]>;
};

const mocks = vi.hoisted(() => ({
  queryExecutor: { execute: vi.fn() },
  semanticLayerCompute: { validateSources: vi.fn(), generateSources: vi.fn(), query: vi.fn() },
  sqlAnalysis: { analyzeForFingerprint: vi.fn(), analyzeBatch: vi.fn(), validateReadOnly: vi.fn() },
  memoryIngest: { ingest: vi.fn(), status: vi.fn(), waitForRun: vi.fn() },
}));

vi.mock('../src/context/llm/embedding-port.js', () => ({
  KtxIngestEmbeddingPortAdapter: class {
    readonly maxBatchSize: number;

    constructor(private readonly provider: FakeEmbeddingProvider) {
      this.maxBatchSize = provider.maxBatchSize;
    }

    computeEmbedding(text: string): Promise<number[]> {
      return this.provider.embed(text);
    }

    computeEmbeddingsBulk(texts: string[]): Promise<number[][]> {
      return this.provider.embedMany(texts);
    }
  },
}));

vi.mock('../src/context/mcp/server.js', () => ({
  createDefaultKtxMcpServer: vi.fn(() => ({ kind: 'mcp-server' })),
}));

vi.mock('../src/context/mcp/local-project-ports.js', () => ({
  createLocalProjectMcpContextPorts: vi.fn(() => ({ context_tool: { name: 'context_tool' } })),
}));

vi.mock('../src/context/memory/local-memory.js', () => ({
  createLocalProjectMemoryIngest: vi.fn(() => mocks.memoryIngest),
}));

vi.mock('../src/embedding-resolution.js', () => ({
  resolveProjectEmbeddingProvider: vi.fn(),
}));

vi.mock('../src/ingest-query-executor.js', () => ({
  createKtxCliIngestQueryExecutor: vi.fn(() => mocks.queryExecutor),
}));

vi.mock('../src/local-scan-connectors.js', () => ({
  createKtxCliScanConnector: vi.fn(() => ({ source: 'fake-scan-connector' })),
}));

vi.mock('../src/managed-python-command.js', () => ({
  createLazyManagedPythonSemanticLayerComputePort: vi.fn(() => mocks.semanticLayerCompute),
}));

vi.mock('../src/managed-python-http.js', () => ({
  createManagedDaemonSqlAnalysisPort: vi.fn(() => mocks.sqlAnalysis),
}));

const project = {
  projectDir: '/work/project',
  configPath: '/work/project/ktx.yaml',
  config: {},
  coreConfig: {},
  git: {},
  fileStore: {},
};

const io = {
  stdout: { write: vi.fn() },
  stderr: { write: vi.fn() },
};

describe('createKtxMcpServerFactory', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('passes a resolved embedding provider to MCP context ports and memory ingest', async () => {
    const provider = {
      maxBatchSize: 4,
      embed: vi.fn(async () => [0.2, 0.4]),
      embedMany: vi.fn(async () => [[0.2, 0.4]]),
    };
    vi.mocked(resolveProjectEmbeddingProvider).mockResolvedValue({ kind: 'configured', provider } as never);

    const factory = await createKtxMcpServerFactory({
      project: project as never,
      projectDir: project.projectDir,
      cliVersion: '0.5.0',
      io,
    });

    const contextOptions = vi.mocked(createLocalProjectMcpContextPorts).mock.calls[0][1] as {
      embeddingService: {
        computeEmbedding(text: string): Promise<number[]>;
        computeEmbeddingsBulk(texts: string[]): Promise<number[][]>;
      };
      queryExecutor: unknown;
      semanticLayerCompute: unknown;
      sqlAnalysis: unknown;
      localScan: {
        createConnector(connectionId: string): Promise<unknown>;
      };
    };
    await expect(contextOptions.embeddingService.computeEmbedding('gross revenue')).resolves.toEqual([0.2, 0.4]);
    await expect(contextOptions.embeddingService.computeEmbeddingsBulk(['gross revenue'])).resolves.toEqual([[0.2, 0.4]]);
    await expect(contextOptions.localScan.createConnector('warehouse')).resolves.toEqual({
      source: 'fake-scan-connector',
    });

    expect(provider.embed).toHaveBeenCalledWith('gross revenue');
    expect(provider.embedMany).toHaveBeenCalledWith(['gross revenue']);
    expect(createKtxCliScanConnector).toHaveBeenCalledWith(project, 'warehouse');
    // The server must wire the lazy compute port so startup never blocks on (or
    // fails over) a missing managed Python runtime / uv.
    expect(createLazyManagedPythonSemanticLayerComputePort).toHaveBeenCalledWith({
      cliVersion: '0.5.0',
      installPolicy: 'auto',
      io,
    });
    expect(contextOptions).toMatchObject({
      queryExecutor: mocks.queryExecutor,
      semanticLayerCompute: mocks.semanticLayerCompute,
      sqlAnalysis: mocks.sqlAnalysis,
    });
    expect(createLocalProjectMemoryIngest).toHaveBeenCalledWith(
      project,
      expect.objectContaining({
        embeddingProvider: provider,
        queryExecutor: mocks.queryExecutor,
        semanticLayerCompute: mocks.semanticLayerCompute,
      }),
    );

    expect(factory()).toEqual({ kind: 'mcp-server' });
    // memoryIngest is wrapped to validate an explicit connectionId before delegating,
    // so it is no longer the raw service object — assert it delegates instead.
    const contextTools = (vi.mocked(createDefaultKtxMcpServer).mock.calls[0]![0].contextTools ?? {}) as Record<
      string,
      unknown
    >;
    expect(contextTools.context_tool).toEqual({ name: 'context_tool' });
    const memoryIngestPort = contextTools.memoryIngest as
      | { ingest: (input: unknown) => unknown; status: (runId: string) => unknown }
      | undefined;
    expect(memoryIngestPort).toBeDefined();
    await memoryIngestPort?.ingest({ userId: 'local', chatId: 'c', userMessage: 'm', assistantMessage: 'a' });
    expect(mocks.memoryIngest.ingest).toHaveBeenCalled();
    await memoryIngestPort?.status('run-1');
    expect(mocks.memoryIngest.status).toHaveBeenCalledWith('run-1');
  });

  it('uses null embedding ports when no configured provider is available', async () => {
    vi.mocked(resolveProjectEmbeddingProvider).mockResolvedValue({ kind: 'managed-unavailable' } as never);

    await createKtxMcpServerFactory({
      project: project as never,
      projectDir: project.projectDir,
      cliVersion: '0.5.0',
      io,
    });

    expect(vi.mocked(createLocalProjectMcpContextPorts).mock.calls[0][1]).toMatchObject({
      embeddingService: null,
    });
    expect(createLocalProjectMemoryIngest).toHaveBeenCalledWith(
      project,
      expect.objectContaining({
        embeddingProvider: null,
      }),
    );
  });

  it('omits memory ingest and logs when memory ingest construction fails', async () => {
    vi.mocked(resolveProjectEmbeddingProvider).mockResolvedValue({ kind: 'disabled' } as never);
    vi.mocked(createLocalProjectMemoryIngest).mockImplementationOnce(() => {
      throw new Error('missing local memory prerequisites');
    });

    const factory = await createKtxMcpServerFactory({
      project: project as never,
      projectDir: project.projectDir,
      cliVersion: '0.5.0',
      io,
    });

    factory();

    expect(io.stderr.write).toHaveBeenCalledWith(
      'ktx MCP memory_ingest disabled: missing local memory prerequisites\n',
    );
    expect(createDefaultKtxMcpServer).toHaveBeenCalledWith(
      expect.objectContaining({
        contextTools: { context_tool: { name: 'context_tool' } },
      }),
    );
  });
});
