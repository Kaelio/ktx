import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { type ChildProcess } from 'node:child_process';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

vi.mock('ai', async (importOriginal) => {
  const actual = await importOriginal<typeof import('ai')>();
  return { ...actual, generateText: vi.fn() };
});

import { generateText } from 'ai';
import {
  buildKtxColumnDescriptionPrompt,
  buildKtxDataSourceDescriptionPrompt,
  buildKtxTableDescriptionPrompt,
  type KtxDescriptionCachePort,
  KtxDescriptionGenerator,
} from '../../../src/context/scan/description-generation.js';
import { createKtxConnectorCapabilities, type KtxScanConnector } from '../../../src/context/scan/types.js';
import { HANGING_CHILD, killTestChildren, spawnTestChild } from '../llm/subprocess-test-children.test-utils.js';

function createCache(initial: Record<string, string> = {}): KtxDescriptionCachePort {
  const data = new Map(Object.entries(initial));
  return {
    buildTableKey: (table) => [table.catalog, table.db, table.name].filter(Boolean).join('.'),
    buildColumnKey: (table, columnName) => [table.catalog, table.db, table.name, columnName].filter(Boolean).join('.'),
    buildConnectionKey: (connectionName) => `__connection:${connectionName}`,
    get: vi.fn(async (key: string) => data.get(key) ?? null),
    set: vi.fn(async (key: string, value: string) => {
      data.set(key, value);
    }),
  };
}

function createLlmProvider(text = 'generated description') {
  vi.mocked(generateText).mockResolvedValue({ text } as never);
  return {
    generateText: vi.fn(async (input) => {
      const result = await generateText({
        system: input.system ? { role: 'system', content: input.system } : undefined,
        messages: [{ role: 'user', content: input.prompt }],
        temperature: input.temperature,
      } as never);
      return result.text;
    }),
    generateObject: vi.fn(),
    runAgentLoop: vi.fn(),
    subprocessForkSpec: () => null,
  } as any;
}

function createFailingLlmProvider(message = 'timeout exceeded when trying to connect') {
  vi.mocked(generateText).mockRejectedValue(new Error(message) as never);
  return {
    generateText: vi.fn(async (input) => {
      const result = await generateText({
        system: input.system ? { role: 'system', content: input.system } : undefined,
        messages: [{ role: 'user', content: input.prompt }],
        temperature: input.temperature,
      } as never);
      return result.text;
    }),
    generateObject: vi.fn(),
    runAgentLoop: vi.fn(),
    subprocessForkSpec: () => null,
  } as any;
}

function createConnector(): KtxScanConnector {
  return {
    id: 'test-connector',
    driver: 'postgres',
    capabilities: createKtxConnectorCapabilities({
      tableSampling: true,
      columnSampling: true,
      nestedAnalysis: true,
    }),
    introspect: vi.fn(async () => {
      throw new Error('introspection is not used by description generation');
    }),
    listSchemas: vi.fn(async () => []),
    listTables: vi.fn(async () => []),
    sampleColumn: vi.fn(async () => ({
      values: ['paid', 'refunded', null],
      nullCount: 1,
      distinctCount: 2,
    })),
    sampleTable: vi.fn(async () => ({
      headers: ['id', 'status', 'amount'],
      rows: [
        [1, 'paid', 20],
        [2, 'refunded', 10],
      ],
      totalRows: 2,
    })),
  };
}

describe('ktx description prompt builders', () => {
  it('builds column prompts with sample values, source descriptions, and nested BigQuery guidance', () => {
    const { system, user } = buildKtxColumnDescriptionPrompt({
      columnName: 'payload',
      columnValues: [{ nested: true }, '[1,2]'],
      tableContext: 'Table: events | Columns: payload | Data source: BIGQUERY',
      dataSourceType: 'BIGQUERY',
      supportsNestedAnalysis: true,
      rawDescriptions: { db: 'Raw event payload', ai: 'Old AI text', user: 'User text' },
      maxWords: 12,
    });

    expect(user).toContain(
      '<table_context> Table: events | Columns: payload | Data source: BIGQUERY </table_context>',
    );
    expect(user).toContain('<column_name> payload </column_name>');
    expect(user).toContain('<sample_values> [object Object], [1,2] </sample_values>');
    expect(user).toContain('<db_documentation> Raw event payload </db_documentation>');
    expect(user).not.toContain('Old AI text');
    expect(user).not.toContain('User text');
    expect(system).toContain('nested/structured data');
    expect(system).toContain('12 words or less');
    expect(user).not.toContain('12 words or less');
  });

  it('builds table and data-source prompts from sampled rows', () => {
    const sample = {
      headers: ['id', 'status'],
      rows: [
        [1, 'paid'],
        [2, 'refunded'],
      ],
      totalRows: 2,
    };

    const table = buildKtxTableDescriptionPrompt({
      tableName: 'orders',
      sampleData: sample,
      dataSourceType: 'POSTGRESQL',
      rawDescriptions: { dbt: 'Fact table for commerce orders' },
    });
    expect(table.user).toContain('status: paid, refunded');
    expect(table.system).toContain('Analyze database tables');

    const datasource = buildKtxDataSourceDescriptionPrompt({
      tableSamples: [['orders', sample]],
      dataSourceType: 'POSTGRESQL',
    });
    expect(datasource.user).toContain('orders (2 columns, 2 sample rows)');
    expect(datasource.system).toContain('Analyze databases');
  });
});

describe('KtxDescriptionGenerator', () => {
  it('generates column descriptions with pre-fetched values, cache hits, and word-limit metadata', async () => {
    const cache = createCache({ 'warehouse.public.orders.cached_status': 'Cached status description' });
    const llmRuntime = createLlmProvider('Payment state');
    const connector = createConnector();
    const generator = new KtxDescriptionGenerator({
      llmRuntime,
      cache,
      settings: {
        columnMaxWords: 12,
        tableMaxWords: 18,
        dataSourceMaxWords: 24,
        temperature: 0.2,
        concurrencyLimit: 2,
      },
    });

    const result = await generator.generateColumnDescriptions({
      connectionId: 'conn-1',
      connector,
      context: { runId: 'run-1' },
      dataSourceType: 'POSTGRESQL',
      supportsNestedAnalysis: false,
      table: {
        catalog: 'warehouse',
        db: 'public',
        name: 'orders',
        columns: [
          { name: 'status', sampleValues: ['paid', 'refunded'], rawDescriptions: { db: 'Payment lifecycle' } },
          { name: 'cached_status', sampleValues: ['open'] },
        ],
      },
      skipExisting: false,
      existingDescriptions: {},
    });

    expect(result).toEqual({
      columnDescriptions: [
        ['status', 'Payment state'],
        ['cached_status', 'Cached status description'],
      ],
      processedColumns: ['status'],
      skippedColumns: ['cached_status'],
    });
    expect(connector.sampleColumn).not.toHaveBeenCalled();
    expect(generateText).toHaveBeenCalledWith(
      expect.objectContaining({
        temperature: 0.2,
        system: expect.objectContaining({
          role: 'system',
          content: expect.stringContaining('Please provide a concise description in 12 words or less.'),
        }),
        messages: expect.arrayContaining([
          expect.objectContaining({
            role: 'user',
            content: expect.stringContaining('<column_name> status </column_name>'),
          }),
        ]),
      }),
    );
    const lastCall = vi.mocked(generateText).mock.calls.at(-1)?.[0];
    expect(lastCall?.messages?.some((message) => message.role === 'system')).toBe(false);
  });

  it('samples through the connector when column values are not pre-fetched', async () => {
    const connector = createConnector();
    const generator = new KtxDescriptionGenerator({
      llmRuntime: createLlmProvider('Current order state'),
      settings: {
        columnMaxWords: 12,
        tableMaxWords: 18,
        dataSourceMaxWords: 24,
      },
    });

    const result = await generator.generateColumnDescriptions({
      connectionId: 'conn-1',
      connector,
      context: { runId: 'run-1' },
      dataSourceType: 'POSTGRESQL',
      supportsNestedAnalysis: false,
      table: {
        catalog: null,
        db: 'public',
        name: 'orders',
        columns: [{ name: 'status' }],
      },
    });

    expect(connector.sampleColumn).toHaveBeenCalledWith(
      {
        connectionId: 'conn-1',
        table: { catalog: null, db: 'public', name: 'orders' },
        column: 'status',
        limit: 50,
      },
      { runId: 'run-1' },
    );
    expect(result.columnDescriptions).toEqual([['status', 'Current order state']]);
  });

  it('samples through a description sampling port without requiring structural introspection', async () => {
    const sampler = {
      id: 'description-sampler:conn-1',
      sampleColumn: vi.fn(async () => ({
        values: ['paid', 'refunded'],
        nullCount: null,
        distinctCount: null,
      })),
      sampleTable: vi.fn(async () => ({
        headers: ['id', 'status'],
        rows: [[1, 'paid']],
        totalRows: 1,
      })),
    };
    const generator = new KtxDescriptionGenerator({
      llmRuntime: createLlmProvider('Generated through sampler'),
      settings: {
        columnMaxWords: 12,
        tableMaxWords: 18,
        dataSourceMaxWords: 24,
      },
    });

    const result = await generator.generateColumnDescriptions({
      connectionId: 'conn-1',
      connector: sampler,
      context: { runId: 'run-1' },
      dataSourceType: 'POSTGRESQL',
      supportsNestedAnalysis: false,
      table: {
        catalog: null,
        db: 'public',
        name: 'orders',
        columns: [{ name: 'status' }],
      },
    });

    expect(result.columnDescriptions).toEqual([['status', 'Generated through sampler']]);
    expect(sampler.sampleColumn).toHaveBeenCalledWith(
      {
        connectionId: 'conn-1',
        table: { catalog: null, db: 'public', name: 'orders' },
        column: 'status',
        limit: 50,
      },
      { runId: 'run-1' },
    );
    expect('introspect' in sampler).toBe(false);
  });

  it('does not turn LLM failures into generated descriptions', async () => {
    const cache = createCache();
    const connector = createConnector();
    const generator = new KtxDescriptionGenerator({
      llmRuntime: createFailingLlmProvider(),
      cache,
      settings: {
        columnMaxWords: 12,
        tableMaxWords: 18,
        dataSourceMaxWords: 24,
      },
    });

    const columnResult = await generator.generateColumnDescriptions({
      connectionId: 'conn-1',
      connector,
      context: { runId: 'run-1' },
      dataSourceType: 'POSTGRESQL',
      supportsNestedAnalysis: false,
      table: {
        catalog: null,
        db: 'public',
        name: 'orders',
        columns: [{ name: 'status' }],
      },
    });

    await expect(
      generator.generateTableDescription({
        connectionId: 'conn-1',
        connector,
        context: { runId: 'run-1' },
        dataSourceType: 'POSTGRESQL',
        table: { catalog: null, db: 'public', name: 'orders' },
      }),
    ).resolves.toBeNull();

    expect(columnResult).toEqual({
      columnDescriptions: [['status', null]],
      processedColumns: [],
      skippedColumns: [],
    });
    expect(cache.set).not.toHaveBeenCalled();
  });

  it('generates and caches table and data-source descriptions', async () => {
    const cache = createCache();
    const connector = createConnector();
    const generator = new KtxDescriptionGenerator({
      llmRuntime: createLlmProvider('Commerce orders'),
      cache,
      settings: {
        columnMaxWords: 12,
        tableMaxWords: 18,
        dataSourceMaxWords: 24,
        concurrencyLimit: 2,
      },
    });

    await expect(
      generator.generateTableDescription({
        connectionId: 'conn-1',
        connector,
        context: { runId: 'run-1' },
        dataSourceType: 'POSTGRESQL',
        table: { catalog: 'warehouse', db: 'public', name: 'orders', rawDescriptions: { db: 'Raw orders' } },
      }),
    ).resolves.toBe('Commerce orders');

    await expect(
      generator.generateDataSourceDescription({
        connectionId: 'conn-1',
        connector,
        context: { runId: 'run-1' },
        dataSourceType: 'POSTGRESQL',
        tables: [
          { catalog: 'warehouse', db: 'public', name: 'orders' },
          { catalog: 'warehouse', db: 'public', name: 'customers' },
        ],
        connectionName: 'Warehouse',
      }),
    ).resolves.toBe('Commerce orders');

    expect(cache.set).toHaveBeenCalledWith('warehouse.public.orders', 'Commerce orders');
    expect(cache.set).toHaveBeenCalledWith('__connection:Warehouse', 'Commerce orders');
  });

  it('generates one structured table description and reuses table samples for all columns', async () => {
    const llmRuntime = createLlmProvider('unused');
    llmRuntime.generateObject = vi.fn(async () => ({
      tableDescription: 'Commerce orders',
      columns: [
        { name: 'status', description: 'Current order state' },
        { name: 'amount', description: 'Order amount in dollars' },
      ],
    }));
    const connector = createConnector();
    const generator = new KtxDescriptionGenerator({
      llmRuntime,
      settings: { columnMaxWords: 12, tableMaxWords: 18, dataSourceMaxWords: 24 },
    });

    const result = await generator.generateBatchedTableDescriptions({
      connectionId: 'conn-1',
      connector,
      context: { runId: 'run-1' },
      dataSourceType: 'POSTGRESQL',
      supportsNestedAnalysis: false,
      table: {
        catalog: null,
        db: 'public',
        name: 'orders',
        rawDescriptions: { db: 'Orders fact table' },
        columns: [
          { name: 'status', type: 'text' },
          { name: 'amount', type: 'numeric' },
        ],
      },
    });

    expect(result.tableDescription).toBe('Commerce orders');
    expect(Object.fromEntries(result.columnDescriptions)).toEqual({
      status: 'Current order state',
      amount: 'Order amount in dollars',
    });
    expect(connector.sampleTable).toHaveBeenCalledTimes(1);
    expect(connector.sampleColumn).not.toHaveBeenCalled();
    expect(llmRuntime.generateObject).toHaveBeenCalledTimes(1);
    expect(llmRuntime.generateText).not.toHaveBeenCalled();
  });

  it('falls back to one column generateText call for each missing structured column', async () => {
    const llmRuntime = createLlmProvider('Fallback status');
    llmRuntime.generateObject = vi.fn(async () => ({
      tableDescription: 'Commerce orders',
      columns: [{ name: 'amount', description: 'Order amount in dollars' }],
    }));
    const connector = createConnector();
    const generator = new KtxDescriptionGenerator({
      llmRuntime,
      settings: { columnMaxWords: 12, tableMaxWords: 18, dataSourceMaxWords: 24 },
    });

    const result = await generator.generateBatchedTableDescriptions({
      connectionId: 'conn-1',
      connector,
      context: { runId: 'run-1' },
      dataSourceType: 'POSTGRESQL',
      supportsNestedAnalysis: false,
      table: {
        catalog: null,
        db: 'public',
        name: 'orders',
        columns: [
          { name: 'status', type: 'text' },
          { name: 'amount', type: 'numeric' },
        ],
      },
    });

    expect(Object.fromEntries(result.columnDescriptions)).toEqual({
      status: 'Fallback status',
      amount: 'Order amount in dollars',
    });
    expect(connector.sampleColumn).not.toHaveBeenCalled();
    expect(llmRuntime.generateObject).toHaveBeenCalledTimes(1);
    expect(llmRuntime.generateText).toHaveBeenCalledTimes(1);
  });

  it('does not run per-column fallback when structured object generation throws', async () => {
    const llmRuntime = createLlmProvider('Fallback description');
    llmRuntime.generateObject = vi.fn(async () => {
      throw new Error('object output unavailable');
    });
    const warnings: string[] = [];
    const generator = new KtxDescriptionGenerator({
      llmRuntime,
      onWarning: (warning) => warnings.push(warning.code),
      settings: { columnMaxWords: 12, tableMaxWords: 18, dataSourceMaxWords: 24 },
    });

    const result = await generator.generateBatchedTableDescriptions({
      connectionId: 'conn-1',
      connector: createConnector(),
      context: { runId: 'run-1' },
      dataSourceType: 'POSTGRESQL',
      supportsNestedAnalysis: false,
      table: {
        catalog: null,
        db: 'public',
        name: 'orders',
        columns: [{ name: 'status', type: 'text' }],
      },
    });

    expect(result.tableDescription).toBeNull();
    expect(Object.fromEntries(result.columnDescriptions)).toEqual({ status: null });
    expect(warnings).toContain('enrichment_failed');
    // A transient (non-timeout) failure retries up to the attempt limit (default 3).
    expect(llmRuntime.generateObject).toHaveBeenCalledTimes(3);
    expect(llmRuntime.generateText).not.toHaveBeenCalled();
  });
});

describe('KtxDescriptionGenerator resilience', () => {
  function createLogger() {
    return {
      debug: vi.fn(),
      info: vi.fn(),
      warn: vi.fn(),
      error: vi.fn(),
    };
  }

  it('retries sampleTable on transient failure and uses sampled rows when it eventually succeeds', async () => {
    const sampleTable = vi
      .fn<NonNullable<KtxScanConnector['sampleTable']>>()
      .mockRejectedValueOnce(new Error('pool: transient ECONNRESET'))
      .mockRejectedValueOnce(new Error('pool: transient ECONNRESET'))
      .mockResolvedValue({
        headers: ['id', 'status'],
        rows: [
          [1, 'paid'],
          [2, 'refunded'],
        ],
        totalRows: 2,
      });
    const connector: KtxScanConnector = {
      ...createConnector(),
      sampleTable,
    };
    const logger = createLogger();
    const warnings: Array<{ code: string; table?: string }> = [];
    const generator = new KtxDescriptionGenerator({
      llmRuntime: createLlmProvider('Commerce orders'),
      logger,
      onWarning: (warning) => warnings.push({ code: warning.code, ...(warning.table ? { table: warning.table } : {}) }),
      settings: { columnMaxWords: 12, tableMaxWords: 18, dataSourceMaxWords: 24, concurrencyLimit: 2 },
    });

    const description = await generator.generateTableDescription({
      connectionId: 'conn-1',
      connector,
      context: { runId: 'run-1' },
      dataSourceType: 'POSTGRESQL',
      table: { catalog: null, db: 'public', name: 'orders' },
    });

    expect(description).toBe('Commerce orders');
    expect(sampleTable).toHaveBeenCalledTimes(3);
    expect(logger.warn).toHaveBeenCalledTimes(2);
    expect(warnings).toEqual([]);
  });

  it('falls back to metadata-only prompt when sampleTable retries exhaust', async () => {
    const sampleTable = vi
      .fn<NonNullable<KtxScanConnector['sampleTable']>>()
      .mockRejectedValue(new Error('pool: connection refused'));
    const connector: KtxScanConnector = {
      ...createConnector(),
      sampleTable,
    };
    const logger = createLogger();
    const warnings: Array<{ code: string; table?: string; metadata?: Record<string, unknown> }> = [];
    const generator = new KtxDescriptionGenerator({
      llmRuntime: createLlmProvider('Customer reference data'),
      logger,
      onWarning: (warning) =>
        warnings.push({
          code: warning.code,
          ...(warning.table ? { table: warning.table } : {}),
          ...(warning.metadata ? { metadata: warning.metadata } : {}),
        }),
      settings: { columnMaxWords: 12, tableMaxWords: 18, dataSourceMaxWords: 24, concurrencyLimit: 2 },
    });

    const description = await generator.generateTableDescription({
      connectionId: 'conn-1',
      connector,
      context: { runId: 'run-1' },
      dataSourceType: 'POSTGRESQL',
      table: {
        catalog: null,
        db: 'public',
        name: 'customers',
        columns: [
          { name: 'id', nativeType: 'uuid' },
          { name: 'email', nativeType: 'text', comment: 'Primary contact email' },
        ],
      },
    });

    expect(description).toBe('Customer reference data');
    expect(sampleTable).toHaveBeenCalledTimes(3);
    expect(warnings.map((warning) => warning.code)).toEqual(['sampling_failed', 'description_fallback_used']);
    expect(warnings[1]?.metadata?.reason).toBe('sampling_failed');
    const userPrompt = (vi.mocked(generateText).mock.calls.at(-1)?.[0] as { messages: Array<{ role: string; content: string }> })
      .messages.find((message) => message.role === 'user')?.content;
    expect(userPrompt).toContain('Columns (metadata only, no sample rows)');
    expect(userPrompt).toContain('email (text)');
    expect(userPrompt).toContain('Primary contact email');
  });

  it('emits enrichment_failed and returns null when both sampling and metadata-only LLM fail', async () => {
    const sampleTable = vi
      .fn<NonNullable<KtxScanConnector['sampleTable']>>()
      .mockRejectedValue(new Error('pool: connection refused'));
    const connector: KtxScanConnector = {
      ...createConnector(),
      sampleTable,
    };
    const warnings: string[] = [];
    const generator = new KtxDescriptionGenerator({
      llmRuntime: createFailingLlmProvider(),
      onWarning: (warning) => warnings.push(warning.code),
      settings: { columnMaxWords: 12, tableMaxWords: 18, dataSourceMaxWords: 24 },
    });

    const description = await generator.generateTableDescription({
      connectionId: 'conn-1',
      connector,
      context: { runId: 'run-1' },
      dataSourceType: 'POSTGRESQL',
      table: { catalog: null, db: 'public', name: 'orphan', columns: [{ name: 'id' }] },
    });

    expect(description).toBeNull();
    expect(warnings).toEqual(['sampling_failed', 'enrichment_failed']);
  });

  it('uses metadata-only fallback when connector has no sampleTable', async () => {
    const connector = createConnector();
    const samplerWithoutTable: KtxScanConnector = {
      ...connector,
      sampleTable: undefined,
    };
    const warnings: string[] = [];
    const generator = new KtxDescriptionGenerator({
      llmRuntime: createLlmProvider('Orders mart'),
      onWarning: (warning) => warnings.push(warning.code),
      settings: { columnMaxWords: 12, tableMaxWords: 18, dataSourceMaxWords: 24 },
    });

    const description = await generator.generateTableDescription({
      connectionId: 'conn-1',
      connector: samplerWithoutTable,
      context: { runId: 'run-1' },
      dataSourceType: 'POSTGRESQL',
      table: {
        catalog: null,
        db: 'public',
        name: 'mart_orders',
        columns: [{ name: 'order_id', nativeType: 'uuid' }],
      },
    });

    expect(description).toBe('Orders mart');
    expect(warnings).toEqual(['connector_capability_missing', 'description_fallback_used']);
  });

  it('aborts retry loop when the scan context signal fires', async () => {
    const controller = new AbortController();
    const sampleTable = vi.fn<NonNullable<KtxScanConnector['sampleTable']>>().mockImplementation(async () => {
      controller.abort();
      throw new Error('first attempt blew up');
    });
    const connector: KtxScanConnector = {
      ...createConnector(),
      sampleTable,
    };
    const warnings: string[] = [];
    const generator = new KtxDescriptionGenerator({
      llmRuntime: createLlmProvider('should not be called'),
      onWarning: (warning) => warnings.push(warning.code),
      settings: { columnMaxWords: 12, tableMaxWords: 18, dataSourceMaxWords: 24 },
    });

    await expect(
      generator.generateTableDescription({
        connectionId: 'conn-1',
        connector,
        context: { runId: 'run-1', signal: controller.signal },
        dataSourceType: 'POSTGRESQL',
        table: { catalog: null, db: 'public', name: 'orders' },
      }),
    ).rejects.toThrow('aborted');

    expect(sampleTable).toHaveBeenCalledTimes(1);
    expect(warnings).toEqual([]);
  });

  it('propagates a genuine context abort during the batched LLM call instead of degrading to null', async () => {
    const controller = new AbortController();
    const llmRuntime = createLlmProvider('unused');
    llmRuntime.generateObject = vi.fn(async () => {
      controller.abort();
      throw new Error('The operation was aborted');
    });
    const warnings: string[] = [];
    const generator = new KtxDescriptionGenerator({
      llmRuntime,
      onWarning: (warning) => warnings.push(warning.code),
      settings: { columnMaxWords: 12, tableMaxWords: 18, dataSourceMaxWords: 24 },
    });

    await expect(
      generator.generateBatchedTableDescriptions({
        connectionId: 'conn-1',
        connector: createConnector(),
        context: { runId: 'run-1', signal: controller.signal },
        dataSourceType: 'POSTGRESQL',
        supportsNestedAnalysis: false,
        table: {
          catalog: null,
          db: 'public',
          name: 'orders',
          rawDescriptions: {},
          columns: [{ name: 'status', type: 'text' }],
        },
      }),
    ).rejects.toThrow();

    // A genuine cancellation must not be filed as a per-table failure/timeout.
    expect(warnings).toEqual([]);
  });

  it('generates column descriptions from rawDescriptions when sampleColumn is unavailable', async () => {
    const samplerWithoutColumn: KtxScanConnector = {
      ...createConnector(),
      sampleColumn: undefined,
    };
    const logger = createLogger();
    const generator = new KtxDescriptionGenerator({
      llmRuntime: createLlmProvider('Payment lifecycle state'),
      logger,
      settings: { columnMaxWords: 12, tableMaxWords: 18, dataSourceMaxWords: 24 },
    });

    const result = await generator.generateColumnDescriptions({
      connectionId: 'conn-1',
      connector: samplerWithoutColumn,
      context: { runId: 'run-1' },
      dataSourceType: 'POSTGRESQL',
      supportsNestedAnalysis: false,
      table: {
        catalog: null,
        db: 'public',
        name: 'orders',
        columns: [{ name: 'status', rawDescriptions: { db: 'order lifecycle state' } }],
      },
    });

    expect(result.columnDescriptions).toEqual([['status', 'Payment lifecycle state']]);
    expect(logger.warn).toHaveBeenCalled();
    const userPrompt = (
      vi.mocked(generateText).mock.calls.at(-1)?.[0] as { messages: Array<{ role: string; content: string }> }
    ).messages.find((message) => message.role === 'user')?.content;
    expect(userPrompt).toContain('<sample_values> unavailable </sample_values>');
    expect(userPrompt).toContain('<db_documentation> order lifecycle state </db_documentation>');
  });

  it('generates column descriptions from rawDescriptions when sampleColumn retries exhaust', async () => {
    const sampleColumn = vi
      .fn<NonNullable<KtxScanConnector['sampleColumn']>>()
      .mockRejectedValue(new Error('pool: connection refused'));
    const flakyConnector: KtxScanConnector = {
      ...createConnector(),
      sampleColumn,
    };
    const generator = new KtxDescriptionGenerator({
      llmRuntime: createLlmProvider('Customer reference identifier'),
      settings: { columnMaxWords: 12, tableMaxWords: 18, dataSourceMaxWords: 24 },
    });

    const result = await generator.generateColumnDescriptions({
      connectionId: 'conn-1',
      connector: flakyConnector,
      context: { runId: 'run-1' },
      dataSourceType: 'POSTGRESQL',
      supportsNestedAnalysis: false,
      table: {
        catalog: null,
        db: 'public',
        name: 'orders',
        columns: [{ name: 'customer_id', rawDescriptions: { db: 'FK to customers.id' } }],
      },
    });

    expect(sampleColumn).toHaveBeenCalledTimes(3);
    expect(result.columnDescriptions).toEqual([['customer_id', 'Customer reference identifier']]);
  });

  it('skips column LLM call only when neither samples nor rawDescriptions are available', async () => {
    const sampleColumn = vi
      .fn<NonNullable<KtxScanConnector['sampleColumn']>>()
      .mockResolvedValue({ values: [null, null], nullCount: 2, distinctCount: 0 });
    const connector: KtxScanConnector = {
      ...createConnector(),
      sampleColumn,
    };
    vi.mocked(generateText).mockClear();
    const generator = new KtxDescriptionGenerator({
      llmRuntime: createLlmProvider('should not be called'),
      settings: { columnMaxWords: 12, tableMaxWords: 18, dataSourceMaxWords: 24 },
    });

    const result = await generator.generateColumnDescriptions({
      connectionId: 'conn-1',
      connector,
      context: { runId: 'run-1' },
      dataSourceType: 'POSTGRESQL',
      supportsNestedAnalysis: false,
      table: {
        catalog: null,
        db: 'public',
        name: 'orders',
        columns: [{ name: 'opaque_blob' }],
      },
    });

    expect(result.columnDescriptions).toEqual([['opaque_blob', null]]);
    expect(generateText).not.toHaveBeenCalled();
  });
});

describe('KtxDescriptionGenerator subprocess kill boundary', () => {
  const children: ChildProcess[] = [];
  let workDir: string;
  let priorTimeout: string | undefined;

  beforeEach(() => {
    workDir = mkdtempSync(join(tmpdir(), 'ktx-enrich-'));
    priorTimeout = process.env.KTX_ENRICH_LLM_TIMEOUT_MS;
    process.env.KTX_ENRICH_LLM_TIMEOUT_MS = '300';
  });

  afterEach(() => {
    killTestChildren(children);
    children.length = 0;
    if (priorTimeout === undefined) {
      delete process.env.KTX_ENRICH_LLM_TIMEOUT_MS;
    } else {
      process.env.KTX_ENRICH_LLM_TIMEOUT_MS = priorTimeout;
    }
    rmSync(workDir, { recursive: true, force: true });
  });

  it('skips a wedged subprocess-backed table with enrichment_timeout and settles within deadline+grace', async () => {
    const pidFile = join(workDir, 'gc.pid');
    const llmRuntime = createLlmProvider('unused');
    llmRuntime.subprocessForkSpec = () => ({ backend: 'codex', projectDir: '/tmp', modelSlots: { default: 'codex' } });
    const warnings: string[] = [];
    const generator = new KtxDescriptionGenerator({
      llmRuntime,
      onWarning: (warning) => warnings.push(warning.code),
      settings: { columnMaxWords: 12, tableMaxWords: 18, dataSourceMaxWords: 24 },
      spawnSubprocessGenerateChild: () => spawnTestChild(children, HANGING_CHILD, { KTX_TEST_GC_PID_FILE: pidFile }),
    });

    const start = Date.now();
    const result = await generator.generateBatchedTableDescriptions({
      connectionId: 'conn-1',
      connector: createConnector(),
      context: { runId: 'run-1' },
      dataSourceType: 'POSTGRESQL',
      supportsNestedAnalysis: false,
      table: { catalog: null, db: 'public', name: 'orders', columns: [{ name: 'status', type: 'text' }] },
    });

    expect(Date.now() - start).toBeLessThan(5000);
    expect(result.tableDescription).toBeNull();
    expect(Object.fromEntries(result.columnDescriptions)).toEqual({ status: null });
    expect(warnings).toContain('enrichment_timeout');
    // One wedge = one timeout: the hung table is not retried.
    expect(children).toHaveLength(1);
    const child = children[0]!;
    await vi.waitFor(() => expect(child.exitCode !== null || child.signalCode !== null).toBe(true), { timeout: 5000 });
  });

  it('runs HTTP-backed enrichment in-process without spawning a child', async () => {
    const spawnSpy = vi.fn(() => {
      throw new Error('HTTP backend must not spawn a kill-boundary child');
    });
    const llmRuntime = createLlmProvider('unused');
    llmRuntime.subprocessForkSpec = () => null;
    llmRuntime.generateObject = vi.fn(async () => ({
      tableDescription: 'Orders fact table',
      columns: [{ name: 'status', description: 'Order lifecycle status' }],
    }));
    const generator = new KtxDescriptionGenerator({
      llmRuntime,
      settings: { columnMaxWords: 12, tableMaxWords: 18, dataSourceMaxWords: 24 },
      spawnSubprocessGenerateChild: spawnSpy,
    });

    const result = await generator.generateBatchedTableDescriptions({
      connectionId: 'conn-1',
      connector: createConnector(),
      context: { runId: 'run-1' },
      dataSourceType: 'POSTGRESQL',
      supportsNestedAnalysis: false,
      table: { catalog: null, db: 'public', name: 'orders', columns: [{ name: 'status', type: 'text' }] },
    });

    expect(spawnSpy).not.toHaveBeenCalled();
    expect(llmRuntime.generateObject).toHaveBeenCalledTimes(1);
    expect(result.tableDescription).toBe('Orders fact table');
    expect(Object.fromEntries(result.columnDescriptions)).toEqual({ status: 'Order lifecycle status' });
  });
});
