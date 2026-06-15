import { access, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { createLocalProjectMemoryIngest } from '../../../src/context/memory/local-memory.js';
import { detectCaptureSignals } from '../../../src/context/memory/capture-signals.js';
import type { MemoryAgentInput } from '../../../src/context/memory/types.js';
import { parseKtxProjectConfig, serializeKtxProjectConfig } from '../../../src/context/project/config.js';
import { initKtxProject } from '../../../src/context/project/project.js';
import { jsonToolResult } from '../../../src/context/mcp/context-tools.js';
import { createDefaultKtxMcpServer, createKtxMcpServer } from '../../../src/context/mcp/server.js';
import type {
  KtxDiscoverDataMcpPort,
  KtxDictionarySearchMcpPort,
  KtxEntityDetailsMcpPort,
  KtxKnowledgeMcpPort,
  KtxMcpContextPorts,
  KtxMcpToolHandlerContext,
  KtxSemanticLayerMcpPort,
  KtxSqlExecutionMcpPort,
  KtxSqlExecutionResponse,
  MemoryIngestPort,
} from '../../../src/context/mcp/types.js';

const reportExceptionMock = vi.hoisted(() => vi.fn(async () => {}));

vi.mock('../../../src/telemetry/exception.js', () => ({
  reportException: reportExceptionMock,
}));

type RegisteredTool = {
  name: string;
  config: {
    title?: string;
    description?: string;
    inputSchema: unknown;
    outputSchema?: unknown;
    annotations?: Record<string, unknown>;
  };
  handler: (input: Record<string, unknown>, context?: KtxMcpToolHandlerContext) => Promise<unknown>;
};

function makeFakeServer() {
  const tools: RegisteredTool[] = [];
  return {
    tools,
    server: {
      registerTool(name: string, config: RegisteredTool['config'], handler: RegisteredTool['handler']): void {
        tools.push({ name, config, handler });
      },
    },
  };
}

function makeIo(stdoutIsTTY = true) {
  let stderr = '';
  return {
    stdout: { isTTY: stdoutIsTTY, write() {} },
    stderr: {
      write(chunk: string) {
        stderr += chunk;
      },
    },
    stderrText: () => stderr,
  };
}

function getTool(tools: RegisteredTool[], name: string): RegisteredTool {
  const found = tools.find((tool) => tool.name === name);
  if (!found) {
    throw new Error(`Tool not registered: ${name}`);
  }
  return found;
}

const retainedToolNames = [
  'connection_list',
  'dictionary_search',
  'discover_data',
  'entity_details',
  'memory_ingest',
  'memory_ingest_status',
  'sl_query',
  'sl_read_source',
  'sql_execution',
  'wiki_read',
  'wiki_search',
] as const;

function makeAllContextTools(): KtxMcpContextPorts {
  return {
    connections: {
      list: vi.fn().mockResolvedValue([{ id: 'warehouse', name: 'Warehouse', connectionType: 'POSTGRES' }]),
    },
    knowledge: {
      search: vi.fn<KtxKnowledgeMcpPort['search']>().mockResolvedValue({ results: [], totalFound: 0 }),
      read: vi.fn<KtxKnowledgeMcpPort['read']>().mockResolvedValue({
        key: 'revenue',
        summary: 'Paid order value',
        content: '# Revenue',
        scope: 'GLOBAL',
        tags: ['finance'],
        refs: [],
        slRefs: ['orders'],
      }),
    },
    semanticLayer: {
      readSource: vi.fn<KtxSemanticLayerMcpPort['readSource']>().mockResolvedValue({
        sourceName: 'orders',
        yaml: 'name: orders\n',
      }),
      query: vi.fn<KtxSemanticLayerMcpPort['query']>().mockResolvedValue({
        sql: 'select 1',
        headers: ['count'],
        rows: [[1]],
        totalRows: 1,
        plan: { sources: ['orders'] },
      }),
    },
    entityDetails: {
      read: vi.fn<KtxEntityDetailsMcpPort['read']>().mockResolvedValue({ results: [] }),
    },
    dictionarySearch: {
      search: vi.fn<KtxDictionarySearchMcpPort['search']>().mockResolvedValue({ searched: [], results: [] }),
    },
    discover: {
      search: vi.fn<KtxDiscoverDataMcpPort['search']>().mockResolvedValue([]),
    },
    sqlExecution: {
      execute: vi.fn<KtxSqlExecutionMcpPort['execute']>().mockResolvedValue({
        headers: ['count'],
        headerTypes: ['integer'],
        rows: [[1]],
        rowCount: 1,
      }),
    },
    memoryIngest: {
      ingest: vi.fn<MemoryIngestPort['ingest']>().mockResolvedValue({ runId: 'run-1' }),
      status: vi.fn<MemoryIngestPort['status']>().mockResolvedValue({
        runId: 'run-1',
        status: 'done',
        stage: 'done',
        done: true,
        captured: { wiki: [], sl: [], xrefs: [] },
        error: null,
        commitHash: null,
        skillsLoaded: [],
        signalDetected: false,
      }),
    },
  };
}

async function listToolsThroughSdk(contextTools: KtxMcpContextPorts) {
  const server = createDefaultKtxMcpServer({
    name: 'ktx-test',
    version: '0.0.0-test',
    userContext: { userId: 'mcp-user' },
    contextTools,
  });
  const client = new Client({ name: 'ktx-test-client', version: '0.0.0-test' });
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();

  await Promise.all([server.connect(serverTransport), client.connect(clientTransport)]);
  try {
    return await client.listTools();
  } finally {
    await client.close();
    await server.close();
  }
}

describe('createKtxMcpServer', () => {
  afterEach(() => {
    vi.unstubAllEnvs();
    vi.restoreAllMocks();
  });

  it('registers annotations and output schemas for every retained tool', async () => {
    const fake = makeFakeServer();
    createKtxMcpServer({
      server: fake.server,
      userContext: { userId: 'mcp-user' },
      contextTools: makeAllContextTools(),
    });

    expect(fake.tools.map((tool) => tool.name).sort()).toEqual([...retainedToolNames].sort());

    const expectedAnnotations: Record<string, Record<string, unknown>> = {
      connection_list: { title: 'Connection List', readOnlyHint: true, idempotentHint: true, openWorldHint: false },
      discover_data: { title: 'Discover Data', readOnlyHint: true, openWorldHint: false },
      wiki_search: { title: 'Wiki Search', readOnlyHint: true, openWorldHint: false },
      wiki_read: { title: 'Wiki Read', readOnlyHint: true, idempotentHint: true, openWorldHint: false },
      entity_details: { title: 'Entity Details', readOnlyHint: true, idempotentHint: true, openWorldHint: false },
      dictionary_search: { title: 'Dictionary Search', readOnlyHint: true, openWorldHint: false },
      sl_read_source: {
        title: 'Semantic Layer Read Source',
        readOnlyHint: true,
        idempotentHint: true,
        openWorldHint: false,
      },
      sl_query: { title: 'Semantic Layer Query', readOnlyHint: true, openWorldHint: false },
      sql_execution: { title: 'SQL Execution', readOnlyHint: true, openWorldHint: false },
      memory_ingest: { title: 'Memory Ingest', destructiveHint: true, openWorldHint: false },
      memory_ingest_status: { title: 'Memory Ingest Status', readOnlyHint: true, openWorldHint: false },
    };

    for (const toolName of retainedToolNames) {
      const tool = getTool(fake.tools, toolName);
      expect(tool.config.title).toBe(expectedAnnotations[toolName]?.title);
      expect(tool.config.annotations).toEqual(expectedAnnotations[toolName]);
      expect(tool.config.outputSchema).toBeDefined();
      const inputShape = tool.config.inputSchema as Record<string, { description?: string }>;
      for (const inputSchema of Object.values(inputShape)) {
        expect(inputSchema.description).toEqual(expect.any(String));
      }
    }
  });

  it('exposes annotations and output schemas through the SDK tools/list response', async () => {
    const result = await listToolsThroughSdk(makeAllContextTools());
    const toolNames = result.tools.map((tool) => tool.name).sort();
    expect(toolNames).toEqual([...retainedToolNames].sort());

    await expect(`${JSON.stringify(result.tools, null, 2)}\n`).toMatchFileSnapshot(
      '__snapshots__/mcp-tools-list.json',
    );
  });

  it('registers context tools without memory capture tools when memory capture is omitted', async () => {
    const fake = makeFakeServer();

    createKtxMcpServer({
      server: fake.server,
      userContext: { userId: 'local-user' },
      contextTools: {
        connections: {
          async list() {
            return [{ id: 'warehouse', name: 'warehouse', connectionType: 'postgres' }];
          },
        },
      },
    });

    expect(fake.tools.map((tool) => tool.name)).toEqual(['connection_list']);
    await expect(getTool(fake.tools, 'connection_list').handler({})).resolves.toMatchObject({
      structuredContent: {
        connections: [{ id: 'warehouse', name: 'warehouse', connectionType: 'postgres' }],
      },
    });
  });

  it('emits sampled debug telemetry for MCP tool requests', async () => {
    vi.spyOn(Math, 'random').mockReturnValue(0);
    vi.stubEnv('KTX_TELEMETRY_DEBUG', '1');
    vi.stubEnv('CI', '');
    const fake = makeFakeServer();
    const io = makeIo();
    const projectDir = '/tmp/ktx-mcp-telemetry';

    createKtxMcpServer({
      server: fake.server,
      userContext: { userId: 'local-user' },
      projectDir,
      io,
      contextTools: {
        knowledge: {
          search: vi.fn<KtxKnowledgeMcpPort['search']>().mockResolvedValue({ results: [], totalFound: 0 }),
          read: vi.fn<KtxKnowledgeMcpPort['read']>().mockResolvedValue(null),
        },
      },
    });

    await expect(getTool(fake.tools, 'wiki_search').handler({ query: 'revenue recognition', limit: 5 })).resolves.toMatchObject({
      structuredContent: { results: [], totalFound: 0 },
    });

    expect(io.stderrText()).toContain('"event":"mcp_request_completed"');
    expect(io.stderrText()).toContain('"toolName":"wiki_search"');
    expect(io.stderrText()).toContain('"sampleRate":1');
    expect(io.stderrText()).not.toContain(projectDir);
    // No client connected through the SDK here, so getClientInfo is absent: the
    // event still emits and the optional client fields are simply omitted.
    expect(io.stderrText()).not.toContain('mcpClientName');
    expect(io.stderrText()).not.toContain('mcpClientVersion');
  });

  it('records the failure message as errorDetail when a tool returns an error', async () => {
    vi.spyOn(Math, 'random').mockReturnValue(0);
    vi.stubEnv('KTX_TELEMETRY_DEBUG', '1');
    vi.stubEnv('CI', '');
    const fake = makeFakeServer();
    const io = makeIo();

    createKtxMcpServer({
      server: fake.server,
      userContext: { userId: 'local-user' },
      projectDir: '/tmp/ktx-mcp-error-detail',
      io,
      contextTools: {
        knowledge: {
          search: vi.fn<KtxKnowledgeMcpPort['search']>().mockRejectedValue(new Error('wiki search exploded')),
          read: vi.fn<KtxKnowledgeMcpPort['read']>().mockResolvedValue(null),
        },
      },
    });

    await expect(getTool(fake.tools, 'wiki_search').handler({ query: 'revenue', limit: 5 })).resolves.toMatchObject({
      isError: true,
    });

    expect(io.stderrText()).toContain('"event":"mcp_request_completed"');
    expect(io.stderrText()).toContain('"outcome":"error"');
    expect(io.stderrText()).toContain('"errorDetail":"wiki search exploded"');
  });

  it('reports MCP tool exceptions with a tool-derived source', async () => {
    reportExceptionMock.mockClear();
    vi.stubEnv('ANTHROPIC_API_KEY', 'mcp-anthropic-secret'); // pragma: allowlist secret
    const fake = makeFakeServer();
    const io = makeIo();
    const projectDir = await mkdtemp(join(tmpdir(), 'ktx-mcp-exception-'));
    try {
      await initKtxProject({ projectDir });
      const config = parseKtxProjectConfig(await readFile(join(projectDir, 'ktx.yaml'), 'utf-8'));
      await writeFile(
        join(projectDir, 'ktx.yaml'),
        serializeKtxProjectConfig({
          ...config,
          llm: {
            ...config.llm,
            provider: {
              backend: 'anthropic',
              anthropic: { api_key: 'env:ANTHROPIC_API_KEY' }, // pragma: allowlist secret
            },
            models: { default: 'claude-sonnet-4-6' },
          },
        }),
        'utf-8',
      );

      createKtxMcpServer({
        server: fake.server,
        userContext: { userId: 'local-user' },
        projectDir,
        io,
        contextTools: {
          knowledge: {
            search: vi.fn<KtxKnowledgeMcpPort['search']>().mockRejectedValue(new Error('wiki failed')),
            read: vi.fn<KtxKnowledgeMcpPort['read']>().mockResolvedValue(null),
          },
        },
      });

      await expect(getTool(fake.tools, 'wiki_search').handler({ query: 'revenue recognition', limit: 5 })).resolves.toMatchObject({
        isError: true,
      });

      expect(reportExceptionMock).toHaveBeenCalledWith(
        expect.objectContaining({
          context: expect.objectContaining({ source: 'mcp:wiki_search', handled: true, fatal: false }),
          projectDir,
          redactionSecrets: expect.arrayContaining(['mcp-anthropic-secret']),
        }),
      );
    } finally {
      await rm(projectDir, { recursive: true, force: true });
    }
  });

  it('captures the connecting MCP client name and version', async () => {
    vi.stubEnv('KTX_TELEMETRY_DEBUG', '1');
    vi.stubEnv('CI', '');
    // Non-TTY io keeps the test hermetic (no ~/.ktx/telemetry.json is created)
    // and mirrors a real headless MCP server; debug mode still emits the payload.
    const io = makeIo(false);

    const server = createDefaultKtxMcpServer({
      name: 'ktx-test',
      version: '0.0.0-test',
      userContext: { userId: 'mcp-user' },
      projectDir: '/tmp/ktx-mcp-client-telemetry',
      io,
      contextTools: {
        knowledge: {
          search: vi.fn<KtxKnowledgeMcpPort['search']>().mockResolvedValue({ results: [], totalFound: 0 }),
          read: vi.fn<KtxKnowledgeMcpPort['read']>().mockResolvedValue(null),
        },
      },
    });
    const client = new Client({ name: 'test-agent', version: '9.9.9' });
    const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
    await Promise.all([server.connect(serverTransport), client.connect(clientTransport)]);

    try {
      await client.callTool({ name: 'wiki_search', arguments: { query: 'revenue recognition', limit: 5 } });
    } finally {
      await client.close();
      await server.close();
    }

    expect(io.stderrText()).toContain('"event":"mcp_request_completed"');
    expect(io.stderrText()).toContain('"mcpClientName":"test-agent"');
    expect(io.stderrText()).toContain('"mcpClientVersion":"9.9.9"');
  });

  it('registers parser-gated sql_execution when the host provides a SQL execution port', async () => {
    const fake = makeFakeServer();
    const response: KtxSqlExecutionResponse = {
      headers: ['status', 'count'],
      headerTypes: ['text', 'bigint'],
      rows: [['paid', 42]],
      rowCount: 1,
    };
    const sqlExecution: KtxSqlExecutionMcpPort = {
      execute: vi.fn<KtxSqlExecutionMcpPort['execute']>().mockResolvedValue(response),
    };

    createKtxMcpServer({
      server: fake.server,
      userContext: { userId: 'local-user' },
      contextTools: {
        sqlExecution,
      },
    });

    expect(fake.tools.map((tool) => tool.name)).toEqual(['sql_execution']);
    await expect(
      getTool(fake.tools, 'sql_execution').handler({
        connectionId: 'warehouse',
        sql: 'select status, count(*) from public.orders group by status',
        maxRows: 50,
      }),
    ).resolves.toEqual({
      content: [
        {
          type: 'text',
          text: JSON.stringify({
            headers: ['status', 'count'],
            headerTypes: ['text', 'bigint'],
            rows: [['paid', 42]],
            rowCount: 1,
          }),
        },
      ],
      structuredContent: {
        headers: ['status', 'count'],
        headerTypes: ['text', 'bigint'],
        rows: [['paid', 42]],
        rowCount: 1,
      },
    });
    expect(sqlExecution.execute).toHaveBeenCalledWith(
      {
        connectionId: 'warehouse',
        sql: 'select status, count(*) from public.orders group by status',
        maxRows: 50,
      },
      undefined,
    );
  });

  it('registers entity_details when the host provides an entity-details port', async () => {
    const fake = makeFakeServer();
    const entityDetails: KtxEntityDetailsMcpPort = {
      read: vi.fn<KtxEntityDetailsMcpPort['read']>().mockResolvedValue({
        results: [
          {
            ok: true,
            connectionId: 'warehouse',
            tableRef: { catalog: null, db: 'public', name: 'orders' },
            display: 'public.orders',
            kind: 'table',
            comment: 'Customer orders',
            estimatedRows: 12,
            columns: [
              {
                name: 'id',
                nativeType: 'integer',
                normalizedType: 'integer',
                dimensionType: 'number',
                nullable: false,
                primaryKey: true,
                comment: null,
              },
            ],
            foreignKeys: [],
            snapshot: {
              syncId: 'sync-1',
              extractedAt: '2026-05-14T09:00:00.000Z',
              scanRunId: 'scan-1',
            },
          },
        ],
      }),
    };

    createKtxMcpServer({
      server: fake.server,
      userContext: { userId: 'local-user' },
      contextTools: { entityDetails },
    });

    expect(fake.tools.map((tool) => tool.name)).toEqual(['entity_details']);
    await expect(
      getTool(fake.tools, 'entity_details').handler({
        connectionId: 'warehouse',
        entities: [{ table: 'public.orders', columns: ['id'] }],
      }),
    ).resolves.toMatchObject({
      structuredContent: {
        results: [
          {
            ok: true,
            connectionId: 'warehouse',
            display: 'public.orders',
            columns: [{ name: 'id' }],
          },
        ],
      },
    });
    expect(entityDetails.read).toHaveBeenCalledWith({
      connectionId: 'warehouse',
      entities: [{ table: 'public.orders', columns: ['id'] }],
    });
  });

  it('registers dictionary_search when the host provides a dictionary-search port', async () => {
    const fake = makeFakeServer();
    const dictionarySearch: KtxDictionarySearchMcpPort = {
      search: vi.fn<KtxDictionarySearchMcpPort['search']>().mockResolvedValue({
        searched: [
          {
            connectionId: 'warehouse',
            coverage: {
              sampledRows: null,
              valuesPerColumn: null,
              profiledColumns: 1,
              syncId: 'sync-1',
              profiledAt: null,
            },
            status: 'ready',
          },
        ],
        results: [
          {
            value: 'paid',
            matches: [
              {
                connectionId: 'warehouse',
                sourceName: 'orders',
                columnName: 'status',
                matchedValue: 'paid',
                cardinality: 3,
              },
            ],
            misses: [],
          },
        ],
      }),
    };

    createKtxMcpServer({
      server: fake.server,
      userContext: { userId: 'local-user' },
      contextTools: { dictionarySearch },
    });

    expect(fake.tools.map((tool) => tool.name)).toEqual(['dictionary_search']);
    await expect(
      getTool(fake.tools, 'dictionary_search').handler({
        connectionId: 'warehouse',
        values: ['paid'],
      }),
    ).resolves.toMatchObject({
      structuredContent: {
        searched: [{ connectionId: 'warehouse', status: 'ready' }],
        results: [
          {
            value: 'paid',
            matches: [{ connectionId: 'warehouse', sourceName: 'orders', columnName: 'status' }],
            misses: [],
          },
        ],
      },
    });
    expect(dictionarySearch.search).toHaveBeenCalledWith({
      connectionId: 'warehouse',
      values: ['paid'],
    });
  });

  it('sl_query rejects cube-style order_by aliases and bare strings', async () => {
    const fake = makeFakeServer();
    const semanticLayer: KtxSemanticLayerMcpPort = {
      readSource: vi.fn(),
      query: vi.fn<KtxSemanticLayerMcpPort['query']>().mockResolvedValue({
        sql: '',
        headers: [],
        rows: [],
        totalRows: 0,
      }),
    };

    createKtxMcpServer({
      server: fake.server,
      userContext: { userId: 'local-user' },
      contextTools: { semanticLayer },
    });

    await expect(
      getTool(fake.tools, 'sl_query').handler({
        connectionId: 'warehouse',
        measures: ['orders.count'],
        order_by: [{ id: 'orders.quarter_label', desc: false }],
      }),
    ).resolves.toMatchObject({ isError: true });
    await expect(
      getTool(fake.tools, 'sl_query').handler({
        connectionId: 'warehouse',
        measures: ['orders.count'],
        order_by: ['orders.segment'],
      }),
    ).resolves.toMatchObject({ isError: true });

    expect(semanticLayer.query).not.toHaveBeenCalled();
  });

  it('sl_query accepts canonical order_by entries', async () => {
    const fake = makeFakeServer();
    const semanticLayer: KtxSemanticLayerMcpPort = {
      readSource: vi.fn(),
      query: vi.fn<KtxSemanticLayerMcpPort['query']>().mockResolvedValue({
        sql: '',
        headers: [],
        rows: [],
        totalRows: 0,
      }),
    };

    createKtxMcpServer({
      server: fake.server,
      userContext: { userId: 'local-user' },
      contextTools: { semanticLayer },
    });

    await getTool(fake.tools, 'sl_query').handler({
      connectionId: 'warehouse',
      measures: ['orders.count'],
      order_by: [
        { field: 'orders.total', direction: 'desc' },
        { field: 'orders.segment' },
      ],
    });

    expect(semanticLayer.query).toHaveBeenCalledWith(
      {
        connectionId: 'warehouse',
        query: expect.objectContaining({
          order_by: [
            { field: 'orders.total', direction: 'desc' },
            { field: 'orders.segment', direction: 'asc' },
          ],
        }),
      },
      undefined,
    );
  });

  it('sl_query rejects cube-style dimensions and bare strings', async () => {
    const fake = makeFakeServer();
    const semanticLayer = makeAllContextTools().semanticLayer!;

    createKtxMcpServer({
      server: fake.server,
      userContext: { userId: 'local-user' },
      contextTools: { semanticLayer },
    });

    await expect(
      getTool(fake.tools, 'sl_query').handler({
        connectionId: 'warehouse',
        measures: ['orders.count'],
        dimensions: [{ dimension: 'orders.created_at', granularity: 'month' }],
      }),
    ).resolves.toMatchObject({ isError: true });
    await expect(
      getTool(fake.tools, 'sl_query').handler({
        connectionId: 'warehouse',
        measures: ['orders.count'],
        dimensions: ['orders.status'],
      }),
    ).resolves.toMatchObject({ isError: true });

    expect(semanticLayer.query).not.toHaveBeenCalled();
  });

  it('sl_query accepts canonical field dimensions', async () => {
    const fake = makeFakeServer();
    const semanticLayer = makeAllContextTools().semanticLayer!;

    createKtxMcpServer({
      server: fake.server,
      userContext: { userId: 'local-user' },
      contextTools: { semanticLayer },
    });

    await getTool(fake.tools, 'sl_query').handler({
      connectionId: 'warehouse',
      measures: ['orders.count'],
      dimensions: [{ field: 'orders.created_at', granularity: 'month' }, { field: 'orders.status' }],
    });

    expect(semanticLayer.query).toHaveBeenCalledWith(
      {
        connectionId: 'warehouse',
        query: expect.objectContaining({
          dimensions: [{ field: 'orders.created_at', granularity: 'month' }, { field: 'orders.status' }],
        }),
      },
      undefined,
    );
  });

  it('sl_query default response omits plan and sql but keeps compile-only and fan-out notes', async () => {
    const fake = makeFakeServer();
    const semanticLayer: KtxSemanticLayerMcpPort = {
      readSource: vi.fn(),
      query: vi.fn<KtxSemanticLayerMcpPort['query']>().mockResolvedValue({
        connectionId: 'warehouse',
        dialect: 'postgres',
        sql: 'select count(*) from public.orders',
        headers: ['order_count'],
        rows: [],
        totalRows: 0,
        plan: {
          sources_used: ['orders'],
          has_fan_out: true,
          fan_out_description: 'orders fans out across line_items',
          execution: { mode: 'compile_only', reason: 'No execution adapter configured.' },
        },
      }),
    };

    createKtxMcpServer({
      server: fake.server,
      userContext: { userId: 'local-user' },
      contextTools: { semanticLayer },
    });

    const result = await getTool(fake.tools, 'sl_query').handler({
      connectionId: 'warehouse',
      measures: ['orders.order_count'],
    });

    expect(result).toMatchObject({
      structuredContent: {
        connectionId: 'warehouse',
        dialect: 'postgres',
        headers: ['order_count'],
        rows: [],
        totalRows: 0,
        notes: ['No execution adapter configured.', 'orders fans out across line_items'],
      },
    });
    const structured = (result as { structuredContent: Record<string, unknown> }).structuredContent;
    expect(structured.sql).toBeUndefined();
    expect(structured.plan).toBeUndefined();
  });

  it('sl_query attaches sql and plan only when include requests them', async () => {
    const fake = makeFakeServer();
    const plan = { sources_used: ['orders'], execution: { mode: 'executed' } };
    const semanticLayer: KtxSemanticLayerMcpPort = {
      readSource: vi.fn(),
      query: vi.fn<KtxSemanticLayerMcpPort['query']>().mockResolvedValue({
        connectionId: 'warehouse',
        dialect: 'postgres',
        sql: 'select count(*) from public.orders',
        headers: ['order_count'],
        rows: [[3]],
        totalRows: 1,
        plan,
      }),
    };

    createKtxMcpServer({
      server: fake.server,
      userContext: { userId: 'local-user' },
      contextTools: { semanticLayer },
    });

    const result = await getTool(fake.tools, 'sl_query').handler({
      connectionId: 'warehouse',
      measures: ['orders.order_count'],
      include: ['plan', 'sql'],
    });

    expect(result).toMatchObject({
      structuredContent: {
        sql: 'select count(*) from public.orders',
        plan,
        rows: [[3]],
        totalRows: 1,
      },
    });
    const structured = (result as { structuredContent: Record<string, unknown> }).structuredContent;
    expect(structured.notes).toBeUndefined();
  });

  it('entity_details rejects sql-style schema table ref aliases', async () => {
    const fake = makeFakeServer();
    const entityDetails = makeAllContextTools().entityDetails!;

    createKtxMcpServer({
      server: fake.server,
      userContext: { userId: 'local-user' },
      contextTools: { entityDetails },
    });

    await expect(
      getTool(fake.tools, 'entity_details').handler({
        connectionId: 'warehouse',
        entities: [{ table: { schema: 'public', table: 'orders' }, columns: ['id'] }],
      }),
    ).resolves.toMatchObject({ isError: true });

    expect(entityDetails.read).not.toHaveBeenCalled();
  });

  it('entity_details accepts canonical table refs', async () => {
    const fake = makeFakeServer();
    const entityDetails = makeAllContextTools().entityDetails!;

    createKtxMcpServer({
      server: fake.server,
      userContext: { userId: 'local-user' },
      contextTools: { entityDetails },
    });

    await getTool(fake.tools, 'entity_details').handler({
      connectionId: 'warehouse',
      entities: [{ table: { catalog: null, db: 'public', name: 'orders' }, columns: ['id'] }],
    });

    expect(entityDetails.read).toHaveBeenCalledWith({
      connectionId: 'warehouse',
      entities: [{ table: { catalog: null, db: 'public', name: 'orders' }, columns: ['id'] }],
    });
  });

  it('wraps handler exceptions in-band for non-sql tools', async () => {
    const fake = makeFakeServer();
    const knowledge: KtxKnowledgeMcpPort = {
      search: vi.fn<KtxKnowledgeMcpPort['search']>().mockRejectedValue(new Error('wiki index unavailable')),
      read: vi.fn(),
    };

    createKtxMcpServer({
      server: fake.server,
      userContext: { userId: 'local-user' },
      contextTools: { knowledge },
    });

    await expect(getTool(fake.tools, 'wiki_search').handler({ query: 'revenue' })).resolves.toEqual({
      content: [{ type: 'text', text: 'wiki index unavailable' }],
      isError: true,
    });
  });

  it('wires sql_execution progress to MCP notifications when a progress token is present', async () => {
    const fake = makeFakeServer();
    const notifications: unknown[] = [];
    const sqlExecution: KtxSqlExecutionMcpPort = {
      execute: vi.fn<KtxSqlExecutionMcpPort['execute']>().mockImplementation(async (_input, options) => {
        await options?.onProgress?.({ progress: 0, message: 'Validating SQL' });
        await options?.onProgress?.({ progress: 0.3, message: 'Executing' });
        await options?.onProgress?.({ progress: 1, message: 'Fetched 1 rows' });
        return { headers: ['count'], rows: [[1]], rowCount: 1 };
      }),
    };

    createKtxMcpServer({
      server: fake.server,
      userContext: { userId: 'local-user' },
      contextTools: { sqlExecution },
    });

    await getTool(fake.tools, 'sql_execution').handler(
      { connectionId: 'warehouse', sql: 'select 1' },
      {
        _meta: { progressToken: 'progress-1' },
        sendNotification: async (notification) => {
          notifications.push(notification);
        },
      },
    );

    expect(notifications).toEqual([
      {
        method: 'notifications/progress',
        params: { progressToken: 'progress-1', progress: 0, message: 'Validating SQL' },
      },
      {
        method: 'notifications/progress',
        params: { progressToken: 'progress-1', progress: 0.3, message: 'Executing' },
      },
      {
        method: 'notifications/progress',
        params: { progressToken: 'progress-1', progress: 1, message: 'Fetched 1 rows' },
      },
    ]);
  });

  it('registers discover_data when the host provides a discover port', async () => {
    const fake = makeFakeServer();
    const discover: KtxDiscoverDataMcpPort = {
      search: vi.fn<KtxDiscoverDataMcpPort['search']>().mockResolvedValue([
        {
          kind: 'table',
          id: 'public.orders',
          score: 1,
          summary: 'Orders table',
          snippet: 'id, status',
          matchedOn: 'name',
          connectionId: 'warehouse',
          tableRef: { catalog: null, db: 'public', name: 'orders' },
        },
      ]),
    };

    createKtxMcpServer({
      server: fake.server,
      userContext: { userId: 'local-user' },
      contextTools: { discover },
    });

    expect(fake.tools.map((tool) => tool.name)).toEqual(['discover_data']);
    await expect(
      getTool(fake.tools, 'discover_data').handler({
        query: 'orders',
        connectionId: 'warehouse',
        kinds: ['table'],
        limit: 5,
      }),
    ).resolves.toMatchObject({
      structuredContent: {
        refs: [
          {
            kind: 'table',
            id: 'public.orders',
            connectionId: 'warehouse',
            tableRef: { catalog: null, db: 'public', name: 'orders' },
          },
        ],
      },
    });
    expect(discover.search).toHaveBeenCalledWith({
      query: 'orders',
      connectionId: 'warehouse',
      kinds: ['table'],
      limit: 5,
    });
  });

  it('registers memory ingest tools through the context tool surface', async () => {
    const fake = makeFakeServer();
    let receivedInput: MemoryAgentInput | undefined;
    const ingest: MemoryIngestPort = {
      ingest: vi.fn<MemoryIngestPort['ingest']>().mockImplementation(async (input) => {
        receivedInput = input;
        return { runId: 'run-1' };
      }),
      status: vi.fn<MemoryIngestPort['status']>().mockResolvedValue({
        runId: 'run-1',
        status: 'done',
        stage: 'done',
        done: true,
        captured: { wiki: ['revenue'], sl: [], xrefs: [] },
        error: null,
        commitHash: 'abc123',
        skillsLoaded: ['wiki_capture'],
        signalDetected: true,
      }),
    };

    createKtxMcpServer({
      server: fake.server,
      userContext: { userId: 'mcp-user' },
      contextTools: { memoryIngest: ingest },
    });

    expect(fake.tools.map((tool) => tool.name).sort()).toEqual(['memory_ingest', 'memory_ingest_status']);

    const content = [
      'view: orders {',
      '  sql_table_name: public.orders ;;',
      '  measure: gross_revenue {',
      '    type: sum',
      '    sql: ${TABLE}.gross_revenue_cents ;;',
      '  }',
      '}',
    ].join('\n');
    const memoryIngest = getTool(fake.tools, 'memory_ingest');
    await expect(
      memoryIngest.handler({
        content,
        connectionId: '00000000-0000-4000-8000-000000000001',
      }),
    ).resolves.toEqual({
      content: [{ type: 'text', text: JSON.stringify({ runId: 'run-1' }) }],
      structuredContent: { runId: 'run-1' },
    });
    expect(ingest.ingest).toHaveBeenCalledWith({
      userId: 'mcp-user',
      chatId: expect.stringMatching(/^mcp-/),
      userMessage: 'Ingest external knowledge into ktx memory.',
      assistantMessage: content,
      connectionId: '00000000-0000-4000-8000-000000000001',
      sourceType: 'external_ingest',
    });

    const cliEquivalentInput: MemoryAgentInput = {
      userId: 'mcp-user',
      chatId: 'cli-text-ingest-test-1',
      userMessage: 'Ingest external text artifact "orders lookml" into ktx memory.',
      assistantMessage: content,
      connectionId: '00000000-0000-4000-8000-000000000001',
      sourceType: 'external_ingest',
    };
    expect(detectCaptureSignals(receivedInput!)).toEqual(detectCaptureSignals(cliEquivalentInput));

    const memoryStatus = getTool(fake.tools, 'memory_ingest_status');
    await expect(memoryStatus.handler({ runId: 'run-1' })).resolves.toEqual({
      content: [
        {
          type: 'text',
          text: JSON.stringify({
            runId: 'run-1',
            status: 'done',
            stage: 'done',
            done: true,
            captured: { wiki: ['revenue'], sl: [], xrefs: [] },
            error: null,
            commitHash: 'abc123',
            skillsLoaded: ['wiki_capture'],
            signalDetected: true,
          }),
        },
      ],
      structuredContent: {
        runId: 'run-1',
        status: 'done',
        stage: 'done',
        done: true,
        captured: { wiki: ['revenue'], sl: [], xrefs: [] },
        error: null,
        commitHash: 'abc123',
        skillsLoaded: ['wiki_capture'],
        signalDetected: true,
      },
    });
  });

  it('returns an in-band error when a memory ingest run is missing', async () => {
    const fake = makeFakeServer();
    const ingest: MemoryIngestPort = {
      ingest: vi.fn<MemoryIngestPort['ingest']>(),
      status: vi.fn<MemoryIngestPort['status']>().mockResolvedValue(null),
    };

    createKtxMcpServer({
      server: fake.server,
      userContext: { userId: 'mcp-user' },
      contextTools: { memoryIngest: ingest },
    });

    const memoryStatus = getTool(fake.tools, 'memory_ingest_status');
    await expect(memoryStatus.handler({ runId: 'missing-run' })).resolves.toEqual({
      content: [{ type: 'text', text: 'Memory ingest run "missing-run" was not found.' }],
      isError: true,
    });
  });

  it('runs MCP memory_ingest against a local project memory port', async () => {
      const tempDir = await mkdtemp(join(tmpdir(), 'ktx-mcp-local-memory-'));
      try {
        const project = await initKtxProject({ projectDir: tempDir });
        const agentRunner = {
          runLoop: async ({
            toolSet,
          }: {
            toolSet: Record<string, { execute: (input: unknown, options?: { toolCallId?: string }) => Promise<unknown> }>;
          }) => {
            await toolSet.load_skill.execute({ name: 'wiki_capture' });
            await toolSet.wiki_write.execute(
            {
              key: 'arr',
              summary: 'ARR definition',
              content: 'ARR means annual recurring revenue.',
            },
            { toolCallId: 'wiki-write' },
          );
          return { stopReason: 'natural' as const };
        },
      };
      const memoryIngest = createLocalProjectMemoryIngest(project, {
        agentRunner: agentRunner as never,
        runIdFactory: () => 'memory-run-mcp',
      });
      const ingestSpy = vi.spyOn(memoryIngest, 'ingest');
      const fake = makeFakeServer();

      createKtxMcpServer({
        server: fake.server,
        userContext: { userId: 'local' },
        contextTools: { memoryIngest },
      });

      const capture = await getTool(fake.tools, 'memory_ingest').handler({
        content: 'Revenue means paid order value.',
        connectionId: 'warehouse',
      });
      expect(capture).toMatchObject({
        structuredContent: { runId: 'memory-run-mcp' },
      });
      await memoryIngest.waitForRun('memory-run-mcp');
      expect(ingestSpy).toHaveBeenCalledWith({
        userId: 'local',
        chatId: expect.stringMatching(/^mcp-/),
        userMessage: 'Ingest external knowledge into ktx memory.',
        assistantMessage: 'Revenue means paid order value.',
        connectionId: 'warehouse',
        sourceType: 'external_ingest',
      });

      await expect(
        getTool(fake.tools, 'memory_ingest_status').handler({ runId: 'memory-run-mcp' }),
      ).resolves.toMatchObject({
        structuredContent: {
          runId: 'memory-run-mcp',
          status: 'done',
          done: true,
          captured: { wiki: ['arr'], sl: [], xrefs: [] },
        },
      });
      await expect(access(join(project.projectDir, '.ktx/db.sqlite'))).resolves.toBeUndefined();
      await expect(access(join(project.projectDir, '.ktx/memory-runs/memory-run-mcp.json'))).rejects.toThrow();
      await expect(readFile(join(project.projectDir, 'wiki/global/arr.md'), 'utf-8')).resolves.toContain(
        'ARR means annual recurring revenue.',
      );
    } finally {
      await rm(tempDir, { recursive: true, force: true });
    }
  });

  it('registers ktx context MCP tools when context ports are supplied', async () => {
    const fake = makeFakeServer();
    const contextTools: KtxMcpContextPorts = {
      connections: {
        list: vi.fn().mockResolvedValue([
          {
            id: '00000000-0000-4000-8000-000000000001',
            name: 'Warehouse',
            connectionType: 'POSTGRES',
          },
        ]),
      },
      knowledge: {
        search: vi.fn<KtxKnowledgeMcpPort['search']>().mockResolvedValue({
          results: [
            {
              key: 'revenue',
              path: 'wiki/global/revenue.md',
              scope: 'GLOBAL',
              summary: 'Paid order value',
              score: 0.42,
              matchReasons: ['lexical'],
            },
          ],
          totalFound: 1,
        }),
        read: vi.fn<KtxKnowledgeMcpPort['read']>().mockResolvedValue({
          key: 'revenue',
          summary: 'Paid order value',
          content: '# Revenue',
          scope: 'GLOBAL',
          tags: ['finance'],
          refs: [],
          slRefs: ['orders'],
        }),
      },
      semanticLayer: {
        readSource: vi.fn<KtxSemanticLayerMcpPort['readSource']>().mockResolvedValue({
          sourceName: 'orders',
          yaml: 'name: orders\n',
        }),
        query: vi.fn<KtxSemanticLayerMcpPort['query']>().mockResolvedValue({
          sql: 'select 1',
          headers: ['count'],
          rows: [[1]],
          totalRows: 1,
          plan: { sources: ['orders'] },
        }),
      },
      entityDetails: {
        read: vi.fn<KtxEntityDetailsMcpPort['read']>().mockResolvedValue({ results: [] }),
      },
      dictionarySearch: {
        search: vi.fn<KtxDictionarySearchMcpPort['search']>().mockResolvedValue({
          searched: [],
          results: [],
        }),
      },
      discover: {
        search: vi.fn<KtxDiscoverDataMcpPort['search']>().mockResolvedValue([]),
      },
      sqlExecution: {
        execute: vi.fn<KtxSqlExecutionMcpPort['execute']>().mockResolvedValue({
          headers: ['count'],
          headerTypes: ['integer'],
          rows: [[1]],
          rowCount: 1,
        }),
      },
      memoryIngest: {
        ingest: vi.fn<MemoryIngestPort['ingest']>().mockResolvedValue({ runId: 'run-1' }),
        status: vi.fn<MemoryIngestPort['status']>().mockResolvedValue(null),
      },
    };

    createKtxMcpServer({
      server: fake.server,
      userContext: { userId: 'mcp-user' },
      contextTools,
    });

    expect(fake.tools.map((tool) => tool.name).sort()).toEqual([
      'connection_list',
      'dictionary_search',
      'discover_data',
      'entity_details',
      'memory_ingest',
      'memory_ingest_status',
      'sl_query',
      'sl_read_source',
      'sql_execution',
      'wiki_read',
      'wiki_search',
    ]);

    await expect(getTool(fake.tools, 'connection_list').handler({})).resolves.toEqual({
      content: [
        {
          type: 'text',
          text: JSON.stringify({
            connections: [
              {
                id: '00000000-0000-4000-8000-000000000001',
                name: 'Warehouse',
                connectionType: 'POSTGRES',
              },
            ],
          }),
        },
      ],
      structuredContent: {
        connections: [
          {
            id: '00000000-0000-4000-8000-000000000001',
            name: 'Warehouse',
            connectionType: 'POSTGRES',
          },
        ],
      },
    });

    await getTool(fake.tools, 'wiki_search').handler({ query: 'revenue', limit: 5 });
    expect(contextTools.knowledge?.search).toHaveBeenCalledWith({
      userId: 'mcp-user',
      query: 'revenue',
      limit: 5,
    });

    await getTool(fake.tools, 'wiki_read').handler({ key: 'revenue' });
    expect(contextTools.knowledge?.read).toHaveBeenCalledWith({
      userId: 'mcp-user',
      key: 'revenue',
    });

    await getTool(fake.tools, 'sl_read_source').handler({
      connectionId: 'warehouse',
      sourceName: 'orders',
    });
    expect(contextTools.semanticLayer?.readSource).toHaveBeenCalledWith({
      connectionId: 'warehouse',
      sourceName: 'orders',
    });

    await getTool(fake.tools, 'sl_query').handler({
      connectionId: '00000000-0000-4000-8000-000000000001',
      measures: ['orders.count'],
      dimensions: [{ field: 'orders.created_at' }],
      filters: ['orders.status = paid'],
      limit: 25,
    });
    expect(contextTools.semanticLayer?.query).toHaveBeenCalledWith(
      {
        connectionId: '00000000-0000-4000-8000-000000000001',
        query: {
          measures: ['orders.count'],
          dimensions: [{ field: 'orders.created_at' }],
          filters: ['orders.status = paid'],
          segments: [],
          order_by: [],
          limit: 25,
          include_empty: true,
        },
      },
      undefined,
    );
  });

  it('keeps jsonToolResult typed to non-array objects', () => {
    expect(jsonToolResult({ ok: true }).structuredContent).toEqual({ ok: true });

    if (false) {
      // @ts-expect-error bare arrays are not valid MCP structuredContent objects in ktx
      jsonToolResult([]);
    }
  });
});
