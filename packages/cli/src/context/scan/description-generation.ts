import type { ChildProcess } from 'node:child_process';
import { z } from 'zod';
import type { KtxLlmRuntimePort } from '../../context/llm/runtime-port.js';
import {
  KtxSubprocessDeadlineError,
  runGenerateObjectInSubprocess,
} from '../../context/llm/subprocess-generate-object.js';
import type {
  KtxColumnSampleInput,
  KtxColumnSampleResult,
  KtxScanContext,
  KtxScanLoggerPort,
  KtxScanWarning,
  KtxTableRef,
  KtxTableSampleInput,
  KtxTableSampleResult,
} from './types.js';

interface KtxDescriptionTableColumn {
  name: string;
  nativeType?: string | null;
  comment?: string | null;
}

export interface KtxDescriptionCachePort {
  buildTableKey(table: KtxTableRef): string;
  buildColumnKey(table: KtxTableRef, columnName: string): string;
  buildConnectionKey(connectionName: string): string;
  get(key: string): Promise<string | null>;
  set(key: string, value: string): Promise<void>;
}

interface KtxDescriptionSamplingPort {
  id: string;
  sampleColumn?(input: KtxColumnSampleInput, ctx: KtxScanContext): Promise<KtxColumnSampleResult>;
  sampleTable?(input: KtxTableSampleInput, ctx: KtxScanContext): Promise<KtxTableSampleResult>;
}

interface KtxDescriptionGenerationSettings {
  columnMaxWords: number;
  tableMaxWords: number;
  dataSourceMaxWords: number;
  temperature?: number;
  concurrencyLimit?: number;
}

interface ResolvedKtxDescriptionGenerationSettings {
  columnMaxWords: number;
  tableMaxWords: number;
  dataSourceMaxWords: number;
  temperature?: number;
  concurrencyLimit: number;
}

export interface KtxDescriptionColumn {
  name: string;
  type?: string;
  rawDescriptions?: Record<string, string>;
  sampleValues?: unknown[];
}

interface KtxDescriptionColumnTable extends KtxTableRef {
  columns: KtxDescriptionColumn[];
}

interface KtxDescriptionTableInput extends KtxTableRef {
  rawDescriptions?: Record<string, string>;
  columns?: KtxDescriptionTableColumn[];
}

export interface KtxColumnAnalysisResult {
  columnDescriptions: Array<[string, string | null]>;
  processedColumns: string[];
  skippedColumns: string[];
}

/** @internal */
export interface KtxColumnDescriptionPromptInput {
  columnName: string;
  columnValues: unknown[];
  tableContext: string;
  dataSourceType: string;
  supportsNestedAnalysis: boolean;
  rawDescriptions?: Record<string, string>;
}

/** @internal */
export interface KtxTableDescriptionPromptInput {
  tableName: string;
  sampleData?: KtxTableSampleResult;
  columns?: KtxDescriptionTableColumn[];
  dataSourceType: string;
  rawDescriptions?: Record<string, string>;
}

/** @internal */
export interface KtxDataSourceDescriptionPromptInput {
  tableSamples: Array<[string, KtxTableSampleResult]>;
  dataSourceType: string;
}

export interface KtxGenerateColumnDescriptionsInput {
  connectionId: string;
  connector: KtxDescriptionSamplingPort;
  context: KtxScanContext;
  dataSourceType: string;
  supportsNestedAnalysis: boolean;
  table: KtxDescriptionColumnTable;
  skipExisting?: boolean;
  existingDescriptions?: Record<string, string | null>;
}

export interface KtxGenerateTableDescriptionInput {
  connectionId: string;
  connector: KtxDescriptionSamplingPort;
  context: KtxScanContext;
  dataSourceType: string;
  table: KtxDescriptionTableInput;
}

export interface KtxGenerateBatchedTableDescriptionsInput {
  connectionId: string;
  connector: KtxDescriptionSamplingPort;
  context: KtxScanContext;
  dataSourceType: string;
  supportsNestedAnalysis: boolean;
  table: KtxDescriptionColumnTable & {
    rawDescriptions?: Record<string, string>;
    columns: Array<KtxDescriptionColumn & { type?: string; comment?: string | null }>;
  };
}

export interface KtxBatchedTableDescriptionsResult {
  tableDescription: string | null;
  columnDescriptions: Map<string, string | null>;
}

export interface KtxGenerateDataSourceDescriptionInput {
  connectionId: string;
  connector: KtxDescriptionSamplingPort;
  context: KtxScanContext;
  dataSourceType: string;
  tables: KtxTableRef[];
  connectionName?: string;
}

export interface KtxDescriptionGeneratorOptions {
  llmRuntime: KtxLlmRuntimePort;
  cache?: KtxDescriptionCachePort;
  logger?: KtxScanLoggerPort;
  onWarning?: (warning: KtxScanWarning) => void;
  settings: KtxDescriptionGenerationSettings;
  /** @internal Test seam: spawn the kill-boundary child for subprocess backends. */
  spawnSubprocessGenerateChild?: () => ChildProcess;
}

interface ColumnTaskResult {
  columnName: string;
  description: string | null;
  processed: boolean;
  skipped: boolean;
}

const batchedTableDescriptionSchema = z.object({
  tableDescription: z.string(),
  columns: z.array(
    z.object({
      name: z.string(),
      description: z.string(),
    }),
  ),
});

type BatchedTableDescriptionOutput = z.infer<typeof batchedTableDescriptionSchema>;

function descriptionSources(rawDescriptions: Record<string, string> | undefined): Array<[string, string]> {
  if (!rawDescriptions) {
    return [];
  }

  return Object.entries(rawDescriptions).filter(([source, text]) => source !== 'ai' && source !== 'user' && !!text);
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

class KtxAbortedError extends Error {
  constructor() {
    super('aborted');
    this.name = 'KtxAbortedError';
  }
}

async function delayWithAbort(ms: number, signal?: AbortSignal): Promise<void> {
  if (!signal) {
    await new Promise<void>((resolve) => setTimeout(resolve, ms));
    return;
  }
  if (signal.aborted) {
    throw new KtxAbortedError();
  }
  await new Promise<void>((resolve, reject) => {
    const timer = setTimeout(() => {
      signal.removeEventListener('abort', onAbort);
      resolve();
    }, ms);
    const onAbort = (): void => {
      clearTimeout(timer);
      reject(new KtxAbortedError());
    };
    signal.addEventListener('abort', onAbort, { once: true });
  });
}

interface RetryAsyncOptions {
  attempts: number;
  baseDelayMs: number;
  signal?: AbortSignal;
  onAttemptFailure?: (error: unknown, attempt: number) => void;
}

async function retryAsync<T>(fn: () => Promise<T>, options: RetryAsyncOptions): Promise<T> {
  const attempts = Math.max(1, options.attempts);
  let lastError: unknown;
  for (let attempt = 1; attempt <= attempts; attempt += 1) {
    if (options.signal?.aborted) {
      throw new KtxAbortedError();
    }
    try {
      return await fn();
    } catch (error) {
      lastError = error;
      if (error instanceof KtxAbortedError) {
        throw error;
      }
      options.onAttemptFailure?.(error, attempt);
      if (attempt === attempts) {
        break;
      }
      const delay = options.baseDelayMs * 2 ** (attempt - 1);
      await delayWithAbort(delay, options.signal);
    }
  }
  throw lastError;
}

function toTableRef(table: KtxTableRef): KtxTableRef {
  return {
    catalog: table.catalog,
    db: table.db,
    name: table.name,
  };
}

async function runWithConcurrency<TInput, TOutput>(
  items: readonly TInput[],
  concurrencyLimit: number,
  worker: (item: TInput, index: number) => Promise<TOutput>,
): Promise<TOutput[]> {
  const results: TOutput[] = [];
  let nextIndex = 0;
  const workerCount = Math.max(1, Math.min(concurrencyLimit, items.length || 1));

  await Promise.all(
    Array.from({ length: workerCount }, async () => {
      while (nextIndex < items.length) {
        const index = nextIndex;
        nextIndex += 1;
        const item = items[index];
        if (item !== undefined) {
          results[index] = await worker(item, index);
        }
      }
    }),
  );

  return results;
}

export interface KtxDescriptionPrompt {
  system: string;
  user: string;
}

function wordLimitLine(maxWords: number): string {
  return `Please provide a concise description in ${maxWords} words or less.`;
}

function sampleValuesByColumn(
  columns: readonly KtxDescriptionColumn[],
  sampleData: KtxTableSampleResult | null,
): Map<string, unknown[]> {
  const values = new Map<string, unknown[]>();
  for (const column of columns) {
    const existingValues = column.sampleValues?.filter((value) => value !== null && value !== undefined) ?? [];
    if (existingValues.length > 0) {
      values.set(column.name, existingValues);
    }
  }
  if (!sampleData) {
    return values;
  }
  for (const column of columns) {
    const index = sampleData.headers.findIndex((header) => header.toLowerCase() === column.name.toLowerCase());
    if (index < 0) {
      continue;
    }
    const sampledValues = sampleData.rows
      .map((row) => row[index])
      .filter((value) => value !== null && value !== undefined);
    if (sampledValues.length > 0) {
      values.set(column.name, sampledValues);
    }
  }
  return values;
}

function batchedPrompt(input: {
  table: KtxGenerateBatchedTableDescriptionsInput['table'];
  sampleData: KtxTableSampleResult | null;
  dataSourceType: string;
  tableMaxWords: number;
  columnMaxWords: number;
}): KtxDescriptionPrompt {
  const columnLines = input.table.columns
    .map((column) => {
      const typePart = column.type ? ` (${column.type})` : '';
      const commentPart = column.rawDescriptions?.db ? ` - ${column.rawDescriptions.db}` : '';
      return `- ${column.name}${typePart}${commentPart}`;
    })
    .join('\n');
  const sampleLines =
    input.sampleData && input.sampleData.rows.length > 0
      ? input.sampleData.rows
          .slice(0, 5)
          .map((row) =>
            input.sampleData!.headers.map((header, index) => `${header}=${String(row[index] ?? '')}`).join(', '),
          )
          .join('\n')
      : 'unavailable';
  return {
    system: [
      'Analyze one database table and return structured JSON matching the supplied schema.',
      `The table description must be ${input.tableMaxWords} words or less.`,
      `Each column description must be ${input.columnMaxWords} words or less.`,
      'Describe business meaning directly. Do not repeat table or column names as filler.',
    ].join('\n'),
    user: [
      `Table: ${input.table.name}`,
      `Data source type: ${input.dataSourceType}`,
      'Columns:',
      columnLines,
      'Sample rows:',
      sampleLines,
    ].join('\n'),
  };
}

/** @internal */
export function buildKtxColumnDescriptionPrompt(
  input: KtxColumnDescriptionPromptInput & { maxWords?: number },
): KtxDescriptionPrompt {
  const sampleValues = input.columnValues.slice(0, 5);
  const valuesStr = sampleValues
    .filter((value) => value !== null && value !== undefined)
    .map((value) => String(value))
    .join(', ');

  const systemParts: string[] = [
    `Analyze database columns and provide a concise description.

Provide a brief description of what the column contains without repeating the column name.
Focus on the data's meaning and business purpose. Start directly with the content description.
Example:
"first names of individuals, likely employees or contacts" instead of "The column contains first names..."
"Job titles or roles of individuals..." instead of "This column contains job titles..."`,
  ];
  if (input.dataSourceType === 'BIGQUERY' && input.supportsNestedAnalysis) {
    systemParts.push(
      'If the sampled values indicate nested/structured data (JSON, STRUCT, or ARRAY), describe its general business purpose and data organization.',
    );
  }
  if (input.maxWords !== undefined) {
    systemParts.push(wordLimitLine(input.maxWords));
  }

  const sampleValuesContent = valuesStr.length > 0 ? valuesStr : 'unavailable';
  let user = `<table_context> ${input.tableContext} </table_context>

<column_name> ${input.columnName} </column_name>

<sample_values> ${sampleValuesContent} </sample_values>
`;

  const sources = descriptionSources(input.rawDescriptions);
  if (sources.length > 0) {
    user += '\nExisting descriptions from other sources:\n';
    for (const [source, text] of sources) {
      user += `<${source}_documentation> ${text} </${source}_documentation>\n`;
    }
    user +=
      '\nSynthesize a description that captures the most important information from all sources. Prioritize the sources as authoritative context.\n';
  }

  return { system: systemParts.join('\n\n'), user: user.trim() };
}

/** @internal */
export function buildKtxTableDescriptionPrompt(
  input: KtxTableDescriptionPromptInput & { maxWords?: number },
): KtxDescriptionPrompt {
  const systemParts: string[] = [
    `Analyze database tables and provide a concise description.

Provide a brief description of what the table represents and its business purpose.
Do NOT list or describe individual columns or fields.
Start directly with the content description without mentioning the table name.
Focus on the data's meaning and business purpose.
Example: "Information about healthcare professionals used for workforce management" instead of "The blahblah table contains information about healthcare professionals including their names, titles..."`,
  ];
  if (input.dataSourceType === 'BIGQUERY') {
    systemParts.push(
      "Note (don't include in the final answer): BigQuery tables may contain nested structures, arrays, or other complex data types.",
    );
  }
  if (input.maxWords !== undefined) {
    systemParts.push(wordLimitLine(input.maxWords));
  }

  const hasSamples = !!input.sampleData && input.sampleData.rows.length > 0;
  let columnsLine: string;
  let rowsLine: string;
  if (hasSamples) {
    const sampleData = input.sampleData!;
    const columnInfo: string[] = [];
    for (let index = 0; index < Math.min(sampleData.headers.length, 10); index += 1) {
      const header = sampleData.headers[index];
      const sampleValues = sampleData.rows
        .slice(0, 3)
        .map((row) => row[index])
        .filter((value) => value !== null && value !== undefined);
      columnInfo.push(`${header}: ${sampleValues.map((value) => String(value)).join(', ')}`);
    }
    columnsLine = `Columns and sample data: ${columnInfo.join(' | ')}`;
    rowsLine = `Total rows in sample: ${sampleData.rows.length}`;
  } else if (input.columns && input.columns.length > 0) {
    const columnInfo = input.columns.slice(0, 30).map((column) => {
      const typePart = column.nativeType ? ` (${column.nativeType})` : '';
      const commentPart = column.comment ? ` — ${column.comment}` : '';
      return `${column.name}${typePart}${commentPart}`;
    });
    columnsLine = `Columns (metadata only, no sample rows): ${columnInfo.join(' | ')}`;
    rowsLine = 'Sample rows: unavailable';
  } else {
    columnsLine = 'Columns: unavailable';
    rowsLine = 'Sample rows: unavailable';
  }

  let user = `Table: ${input.tableName}
${columnsLine}
${rowsLine}
Data source type: ${input.dataSourceType}`;

  const sources = descriptionSources(input.rawDescriptions);
  if (sources.length > 0) {
    user += '\n\nExisting descriptions from other sources:\n';
    for (const [source, text] of sources) {
      user += `${source}: ${text}\n`;
    }
    user +=
      '\nSynthesize a description that captures the most important information from all sources. Prioritize the sources as authoritative context.';
  }

  return { system: systemParts.join('\n\n'), user: user.trim() };
}

/** @internal */
export function buildKtxDataSourceDescriptionPrompt(
  input: KtxDataSourceDescriptionPromptInput & { maxWords?: number },
): KtxDescriptionPrompt {
  const tablesText = input.tableSamples
    .map(
      ([tableName, sampleData]) =>
        `${tableName} (${sampleData.headers.length} columns, ${sampleData.rows.length} sample rows)`,
    )
    .join(' | ');

  const systemParts: string[] = [
    `Analyze databases and provide a concise description.

Provide a direct, concise description of what the database represents and its business purpose.
Do NOT start with phrases like "This database appears to represent" or "This BigQuery dataset".
Start directly with the domain or business area description.
Focus on the overall data model and its intended use.
Example: "Healthcare-related database with a focus on patient management..." instead of "This database appears to represent a healthcare-related system..."`,
  ];
  if (input.dataSourceType === 'BIGQUERY') {
    systemParts.push(
      "Note (don't include in the final answer): BigQuery datasets may contain large-scale analytics data, nested structures, and complex data types.",
    );
  }
  if (input.maxWords !== undefined) {
    systemParts.push(wordLimitLine(input.maxWords));
  }

  const user = `Tables: ${tablesText}
Total tables analyzed: ${input.tableSamples.length}
Data source type: ${input.dataSourceType}`;

  return { system: systemParts.join('\n\n'), user };
}

export class KtxDescriptionGenerator {
  private readonly llmRuntime: KtxLlmRuntimePort;
  private readonly cache?: KtxDescriptionCachePort;
  private readonly logger?: KtxScanLoggerPort;
  private readonly onWarning?: (warning: KtxScanWarning) => void;
  private readonly settings: ResolvedKtxDescriptionGenerationSettings;
  private readonly spawnSubprocessGenerateChild?: () => ChildProcess;

  constructor(options: KtxDescriptionGeneratorOptions) {
    this.llmRuntime = options.llmRuntime;
    this.cache = options.cache;
    this.logger = options.logger;
    this.onWarning = options.onWarning;
    this.spawnSubprocessGenerateChild = options.spawnSubprocessGenerateChild;
    this.settings = {
      columnMaxWords: options.settings.columnMaxWords,
      tableMaxWords: options.settings.tableMaxWords,
      dataSourceMaxWords: options.settings.dataSourceMaxWords,
      ...(options.settings.temperature !== undefined ? { temperature: options.settings.temperature } : {}),
      concurrencyLimit: options.settings.concurrencyLimit ?? 5,
    };
  }

  async generateColumnDescriptions(input: KtxGenerateColumnDescriptionsInput): Promise<KtxColumnAnalysisResult> {
    const columnsToProcess = input.table.columns;
    const tableContext = `Table: ${input.table.name} | Columns: ${columnsToProcess.map((column) => column.name).join(', ')} | Data source: ${input.dataSourceType}`;

    const results = await runWithConcurrency(columnsToProcess, this.settings.concurrencyLimit, async (column) =>
      this.generateOneColumnDescription(input, column, tableContext),
    );

    const columnDescriptions: Array<[string, string | null]> = [];
    const processedColumns: string[] = [];
    const skippedColumns: string[] = [];

    for (const result of results) {
      columnDescriptions.push([result.columnName, result.description]);
      if (result.skipped) {
        skippedColumns.push(result.columnName);
      } else if (result.processed) {
        processedColumns.push(result.columnName);
      }
    }

    return {
      columnDescriptions,
      processedColumns,
      skippedColumns,
    };
  }

  async generateTableDescription(input: KtxGenerateTableDescriptionInput): Promise<string | null> {
    const tableRef = toTableRef(input.table);
    const cacheKey = this.cache?.buildTableKey(tableRef);
    if (cacheKey) {
      const cached = await this.cache?.get(cacheKey);
      if (cached) {
        return cached;
      }
    }

    const connector = input.connector;
    let sampleData: KtxTableSampleResult | null = null;
    let fallbackReason: 'capability_missing' | 'sampling_failed' | 'empty_sample' | null = null;

    if (!connector.sampleTable) {
      fallbackReason = 'capability_missing';
      this.logger?.warn('ktx scan connector does not support table sampling; falling back to metadata-only prompt', {
        connectorId: input.connector.id,
        table: input.table.name,
      });
      this.onWarning?.({
        code: 'connector_capability_missing',
        message: `Connector ${input.connector.id} does not support sampleTable; using metadata-only description prompt`,
        table: input.table.name,
        recoverable: true,
        metadata: { connectorId: input.connector.id, capability: 'sampleTable' },
      });
    } else {
      try {
        sampleData = await retryAsync(
          () =>
            connector.sampleTable!(
              {
                connectionId: input.connectionId,
                table: tableRef,
                limit: 20,
              },
              input.context,
            ),
          {
            attempts: 3,
            baseDelayMs: 200,
            signal: input.context.signal,
            onAttemptFailure: (error, attempt) => {
              this.logger?.warn(
                `sampleTable attempt ${attempt} failed for ${input.table.name}: ${errorMessage(error)}`,
                {
                  connectorId: input.connector.id,
                  table: input.table.name,
                  attempt,
                },
              );
            },
          },
        );
        if (sampleData.rows.length === 0) {
          fallbackReason = 'empty_sample';
          this.logger?.warn('sampleTable returned no rows; using metadata-only prompt', {
            connectorId: input.connector.id,
            table: input.table.name,
          });
        }
      } catch (error) {
        if (error instanceof KtxAbortedError) {
          throw error;
        }
        fallbackReason = 'sampling_failed';
        this.logger?.error(`sampleTable exhausted retries for ${input.table.name}: ${errorMessage(error)}`, {
          connectorId: input.connector.id,
          table: input.table.name,
        });
        this.onWarning?.({
          code: 'sampling_failed',
          message: `Failed to sample table ${input.table.name} after retries: ${errorMessage(error)}`,
          table: input.table.name,
          recoverable: true,
          metadata: { connectorId: input.connector.id, error: errorMessage(error) },
        });
      }
    }

    try {
      const prompt = buildKtxTableDescriptionPrompt({
        tableName: input.table.name,
        ...(fallbackReason === null && sampleData ? { sampleData } : {}),
        ...(input.table.columns && input.table.columns.length > 0 ? { columns: input.table.columns } : {}),
        dataSourceType: input.dataSourceType,
        rawDescriptions: input.table.rawDescriptions,
        maxWords: this.settings.tableMaxWords,
      });
      const description = await this.generateAiDescription(prompt, 'ktx-table-description');
      if (cacheKey && description) {
        await this.cache?.set(cacheKey, description);
      }
      if (description && fallbackReason !== null) {
        this.onWarning?.({
          code: 'description_fallback_used',
          message: `Generated table description without sample rows for ${input.table.name} (reason: ${fallbackReason})`,
          table: input.table.name,
          recoverable: true,
          metadata: { connectorId: input.connector.id, reason: fallbackReason },
        });
      }
      if (!description) {
        this.onWarning?.({
          code: 'enrichment_failed',
          message: `Failed to generate description for table ${input.table.name}`,
          table: input.table.name,
          recoverable: true,
          metadata: { connectorId: input.connector.id, usedFallback: fallbackReason !== null },
        });
      }
      return description;
    } catch (error) {
      this.logger?.error(`Error generating table description: ${errorMessage(error)}`, {
        connectorId: input.connector.id,
        table: input.table.name,
      });
      this.onWarning?.({
        code: 'enrichment_failed',
        message: `Failed to generate description for table ${input.table.name}: ${errorMessage(error)}`,
        table: input.table.name,
        recoverable: true,
        metadata: { connectorId: input.connector.id },
      });
      return null;
    }
  }

  async generateBatchedTableDescriptions(
    input: KtxGenerateBatchedTableDescriptionsInput,
  ): Promise<KtxBatchedTableDescriptionsResult> {
    const tableRef = toTableRef(input.table);
    let sampleData: KtxTableSampleResult | null = null;
    let fallbackReason: 'capability_missing' | 'sampling_failed' | 'empty_sample' | null = null;
    if (!input.connector.sampleTable) {
      fallbackReason = 'capability_missing';
      this.logger?.warn('ktx scan connector does not support table sampling; falling back to metadata-only prompt', {
        connectorId: input.connector.id,
        table: input.table.name,
      });
      this.onWarning?.({
        code: 'connector_capability_missing',
        message: `Connector ${input.connector.id} does not support sampleTable; using metadata-only description prompt`,
        table: input.table.name,
        recoverable: true,
        metadata: { connectorId: input.connector.id, capability: 'sampleTable' },
      });
    } else {
      try {
        sampleData = await retryAsync(
          () =>
            input.connector.sampleTable!(
              {
                connectionId: input.connectionId,
                table: tableRef,
                limit: 20,
              },
              input.context,
            ),
          {
            attempts: 3,
            baseDelayMs: 200,
            signal: input.context.signal,
            onAttemptFailure: (error, attempt) => {
              this.logger?.warn(`sampleTable attempt ${attempt} failed for ${input.table.name}: ${errorMessage(error)}`, {
                connectorId: input.connector.id,
                table: input.table.name,
                attempt,
              });
            },
          },
        );
        if (sampleData.rows.length === 0) {
          fallbackReason = 'empty_sample';
          this.logger?.warn('sampleTable returned no rows; using metadata-only prompt', {
            connectorId: input.connector.id,
            table: input.table.name,
          });
        }
      } catch (error) {
        if (error instanceof KtxAbortedError) {
          throw error;
        }
        fallbackReason = 'sampling_failed';
        this.logger?.error(`sampleTable exhausted retries for ${input.table.name}: ${errorMessage(error)}`, {
          connectorId: input.connector.id,
          table: input.table.name,
        });
        this.onWarning?.({
          code: 'sampling_failed',
          message: `Failed to sample table ${input.table.name} after retries: ${errorMessage(error)}`,
          table: input.table.name,
          recoverable: true,
          metadata: { connectorId: input.connector.id, error: errorMessage(error) },
        });
      }
    }

    const sampleValues = sampleValuesByColumn(input.table.columns, sampleData);
    const descriptions = new Map<string, string | null>();
    let tableDescription: string | null = null;
    let structuredGenerationSucceeded = false;

    // Bound + retry the per-table enrichment LLM call. A transient backend error
    // (e.g. an "overloaded"/burst rejection when many tables enrich concurrently)
    // otherwise nulls a whole table's descriptions on the FIRST failure — sampleTable
    // already retries, this call did not, so transient errors silently dropped most
    // tables of a db. retryAsync gives it the same 3-attempt backoff. A FRESH timeout
    // per attempt still bounds a wedged wide table (it never returns a result message);
    // a timeout is surfaced as KtxAbortedError so retryAsync does NOT retry it (one
    // wedge stays one timeout, not 3×). Tune via KTX_ENRICH_LLM_TIMEOUT_MS (default
    // 120s) and KTX_ENRICH_LLM_ATTEMPTS (default 3).
    const rawEnrichTimeoutMs = Number(process.env.KTX_ENRICH_LLM_TIMEOUT_MS);
    const enrichTimeoutMs = Number.isFinite(rawEnrichTimeoutMs) && rawEnrichTimeoutMs > 0 ? rawEnrichTimeoutMs : 120_000;
    const enrichAttempts = Math.max(1, Number(process.env.KTX_ENRICH_LLM_ATTEMPTS ?? 3) || 3);
    let llmStartedAt = 0;
    let lastTimedOut = false;

    try {
      const prompt = batchedPrompt({
        table: input.table,
        sampleData,
        dataSourceType: input.dataSourceType,
        tableMaxWords: this.settings.tableMaxWords,
        columnMaxWords: this.settings.columnMaxWords,
      });
      llmStartedAt = Date.now();
      this.logger?.info(
        `[enrich] llm:start table=${input.table.name} cols=${input.table.columns.length} promptChars=${prompt.user.length} timeoutMs=${enrichTimeoutMs} attempts=${enrichAttempts}`,
        { connectorId: input.connector.id, table: input.table.name, columns: input.table.columns.length },
      );
      // Subprocess backends (codex/claude-code) own an SDK child that ignores the
      // in-process abort, so each attempt runs behind a tree-killable boundary;
      // HTTP backends keep the native abortSignal -> fetch cancellation.
      const enrichForkSpec = this.llmRuntime.subprocessForkSpec();
      const enrichJsonSchema = enrichForkSpec
        ? (z.toJSONSchema(batchedTableDescriptionSchema, { target: 'draft-7' }) as Record<string, unknown>)
        : null;
      const generated = await retryAsync(
        async () => {
          if (enrichForkSpec && enrichJsonSchema) {
            try {
              return await runGenerateObjectInSubprocess<
                BatchedTableDescriptionOutput,
                typeof batchedTableDescriptionSchema
              >({
                forkSpec: enrichForkSpec,
                role: 'candidateExtraction',
                system: prompt.system,
                prompt: prompt.user,
                schema: batchedTableDescriptionSchema,
                jsonSchema: enrichJsonSchema,
                deadlineMs: enrichTimeoutMs,
                ...(input.context.signal ? { signal: input.context.signal } : {}),
                ...(this.spawnSubprocessGenerateChild
                  ? { spawnChild: this.spawnSubprocessGenerateChild }
                  : {}),
              });
            } catch (error) {
              // The boundary tree-kills the wedged child on deadline; a per-table
              // timeout is not worth retrying (it would just time out again), so
              // surface it as KtxAbortedError so retryAsync stops immediately.
              if (error instanceof KtxSubprocessDeadlineError && !input.context.signal?.aborted) {
                lastTimedOut = true;
                throw new KtxAbortedError();
              }
              throw error;
            }
          }
          const enrichTimeout = AbortSignal.timeout(enrichTimeoutMs);
          const abortSignal = input.context.signal
            ? AbortSignal.any([enrichTimeout, input.context.signal])
            : enrichTimeout;
          try {
            return await this.llmRuntime.generateObject<
              BatchedTableDescriptionOutput,
              typeof batchedTableDescriptionSchema
            >({
              role: 'candidateExtraction',
              system: prompt.system,
              prompt: prompt.user,
              schema: batchedTableDescriptionSchema,
              temperature: this.settings.temperature,
              abortSignal,
            });
          } catch (error) {
            // A per-table timeout is not worth retrying (it would just time out
            // again); surface it as KtxAbortedError so retryAsync stops immediately.
            // A genuine context cancellation is handled by retryAsync's own signal check.
            if (enrichTimeout.aborted && !input.context.signal?.aborted) {
              lastTimedOut = true;
              throw new KtxAbortedError();
            }
            throw error;
          }
        },
        {
          attempts: enrichAttempts,
          baseDelayMs: 500,
          ...(input.context.signal ? { signal: input.context.signal } : {}),
          onAttemptFailure: (error, attempt) => {
            this.logger?.warn(
              `[enrich] llm:retry table=${input.table.name} attempt=${attempt}: ${errorMessage(error)}`,
              { connectorId: input.connector.id, table: input.table.name, attempt },
            );
          },
        },
      );
      this.logger?.info(`[enrich] llm:done table=${input.table.name} ms=${Date.now() - llmStartedAt}`, {
        connectorId: input.connector.id,
        table: input.table.name,
      });
      structuredGenerationSucceeded = true;
      tableDescription = generated.tableDescription.trim() || null;
      const generatedColumns = new Map(
        generated.columns.map((column) => [column.name.toLowerCase(), column.description.trim() || null]),
      );
      for (const column of input.table.columns) {
        const description = generatedColumns.get(column.name.toLowerCase()) ?? null;
        descriptions.set(column.name, description);
      }
      if (tableDescription && fallbackReason !== null) {
        this.onWarning?.({
          code: 'description_fallback_used',
          message: `Generated table description without sample rows for ${input.table.name} (reason: ${fallbackReason})`,
          table: input.table.name,
          recoverable: true,
          metadata: { connectorId: input.connector.id, reason: fallbackReason },
        });
      }
    } catch (error) {
      // A genuine cancellation propagates so the stage fails and resumes; a
      // per-table timeout (context.signal not aborted) still degrades to null.
      if (input.context.signal?.aborted) {
        throw error;
      }
      const elapsedMs = llmStartedAt ? Date.now() - llmStartedAt : 0;
      const timedOut = lastTimedOut;
      this.logger?.warn(
        `[enrich] llm:${timedOut ? 'TIMEOUT' : 'fail'} table=${input.table.name} cols=${input.table.columns.length} ms=${elapsedMs}: ${errorMessage(error)}`,
        { connectorId: input.connector.id, table: input.table.name, timedOut, elapsedMs },
      );
      this.onWarning?.({
        code: timedOut ? 'enrichment_timeout' : 'enrichment_failed',
        message: `${
          timedOut ? `Timed out after ${elapsedMs}ms generating` : 'Failed to generate'
        } batched description for table ${input.table.name}: ${errorMessage(error)}`,
        table: input.table.name,
        recoverable: true,
        metadata: { connectorId: input.connector.id, ...(timedOut ? { timeoutMs: enrichTimeoutMs } : {}) },
      });
    }

    if (!structuredGenerationSucceeded) {
      for (const column of input.table.columns) {
        descriptions.set(column.name, null);
      }
      return { tableDescription, columnDescriptions: descriptions };
    }

    const tableContext = `Table: ${input.table.name} | Columns: ${input.table.columns.map((column) => column.name).join(', ')} | Data source: ${input.dataSourceType}`;
    for (const column of input.table.columns) {
      if (descriptions.get(column.name)) {
        continue;
      }
      const fallback = await this.generateColumnDescriptionFromPreparedValues({
        column,
        columnValues: sampleValues.get(column.name) ?? [],
        tableContext,
        dataSourceType: input.dataSourceType,
        supportsNestedAnalysis: input.supportsNestedAnalysis,
      });
      descriptions.set(column.name, fallback);
    }

    return { tableDescription, columnDescriptions: descriptions };
  }

  async generateDataSourceDescription(input: KtxGenerateDataSourceDescriptionInput): Promise<string | null> {
    if (input.tables.length === 0) {
      return 'No tables found in database';
    }

    const cacheKey = input.connectionName ? this.cache?.buildConnectionKey(input.connectionName) : undefined;
    if (cacheKey) {
      const cached = await this.cache?.get(cacheKey);
      if (cached) {
        return cached;
      }
    }

    if (!input.connector.sampleTable) {
      this.logger?.warn('ktx scan connector does not support table sampling for data-source description generation', {
        connectorId: input.connector.id,
      });
      return 'No accessible tables found in database';
    }

    const tablesToAnalyze = input.tables.slice(0, 10);
    const tableSamples = await runWithConcurrency(tablesToAnalyze, this.settings.concurrencyLimit, async (table) => {
      try {
        const sampleData = await input.connector.sampleTable!(
          {
            connectionId: input.connectionId,
            table: toTableRef(table),
            limit: 5,
          },
          input.context,
        );
        return [table.name, sampleData] as [string, KtxTableSampleResult];
      } catch (error) {
        this.logger?.warn(`Failed to sample table '${table.name}' for data source analysis - ${errorMessage(error)}`);
        return null;
      }
    });

    const accessibleSamples = tableSamples.filter(
      (sample): sample is [string, KtxTableSampleResult] => sample !== null,
    );
    if (accessibleSamples.length === 0) {
      return 'No accessible tables found in database';
    }

    try {
      const prompt = buildKtxDataSourceDescriptionPrompt({
        tableSamples: accessibleSamples,
        dataSourceType: input.dataSourceType,
        maxWords: this.settings.dataSourceMaxWords,
      });
      const description = await this.generateAiDescription(prompt, 'ktx-data-source-description');
      if (cacheKey && description) {
        await this.cache?.set(cacheKey, description);
      }
      return description;
    } catch (error) {
      this.logger?.error(`Error generating data source description: ${errorMessage(error)}`);
      return 'Failed to generate data source description';
    }
  }

  private async generateOneColumnDescription(
    input: KtxGenerateColumnDescriptionsInput,
    column: KtxDescriptionColumn,
    tableContext: string,
  ): Promise<ColumnTaskResult> {
    const existingDescription = input.existingDescriptions?.[column.name];
    if (input.skipExisting && existingDescription) {
      return {
        columnName: column.name,
        description: existingDescription,
        skipped: true,
        processed: false,
      };
    }

    const tableRef = toTableRef(input.table);
    const cacheKey = this.cache?.buildColumnKey(tableRef, column.name);
    if (cacheKey) {
      const cached = await this.cache?.get(cacheKey);
      if (cached) {
        return {
          columnName: column.name,
          description: cached,
          skipped: true,
          processed: false,
        };
      }
    }

    try {
      let columnValues = column.sampleValues;
      if (!columnValues || columnValues.length === 0) {
        if (!input.connector.sampleColumn) {
          this.logger?.warn('ktx scan connector does not support column sampling; using available metadata only', {
            connectorId: input.connector.id,
            table: input.table.name,
            column: column.name,
          });
          columnValues = [];
        } else {
          const connector = input.connector;
          try {
            const sample = await retryAsync(
              () =>
                connector.sampleColumn!(
                  {
                    connectionId: input.connectionId,
                    table: tableRef,
                    column: column.name,
                    limit: 50,
                  },
                  input.context,
                ),
              {
                attempts: 3,
                baseDelayMs: 200,
                signal: input.context.signal,
                onAttemptFailure: (error, attempt) => {
                  this.logger?.warn(
                    `sampleColumn attempt ${attempt} failed for ${input.table.name}.${column.name}: ${errorMessage(error)}`,
                    {
                      connectorId: input.connector.id,
                      table: input.table.name,
                      column: column.name,
                      attempt,
                    },
                  );
                },
              },
            );
            columnValues = sample.values;
          } catch (error) {
            if (error instanceof KtxAbortedError) {
              throw error;
            }
            this.logger?.warn(
              `sampleColumn exhausted retries for ${input.table.name}.${column.name}; using available metadata only: ${errorMessage(error)}`,
              {
                connectorId: input.connector.id,
                table: input.table.name,
                column: column.name,
              },
            );
            columnValues = [];
          }
        }
      }

      const description = await this.generateColumnDescriptionFromPreparedValues({
        column,
        columnValues: columnValues ?? [],
        tableContext,
        dataSourceType: input.dataSourceType,
        supportsNestedAnalysis: input.supportsNestedAnalysis,
      });

      if (cacheKey && description) {
        await this.cache?.set(cacheKey, description);
      }

      return {
        columnName: column.name,
        description,
        skipped: false,
        processed: description !== null,
      };
    } catch (error) {
      if (error instanceof KtxAbortedError) {
        throw error;
      }
      this.logger?.error(`Error analyzing column '${column.name}': ${errorMessage(error)}`, {
        connectorId: input.connector.id,
        table: input.table.name,
        column: column.name,
      });
      return {
        columnName: column.name,
        description: null,
        skipped: false,
        processed: false,
      };
    }
  }

  private async generateColumnDescriptionFromPreparedValues(input: {
    column: KtxDescriptionColumn;
    columnValues: unknown[];
    tableContext: string;
    dataSourceType: string;
    supportsNestedAnalysis: boolean;
  }): Promise<string | null> {
    const nonNullValues = input.columnValues.filter((value) => value !== null && value !== undefined);
    const hasRawDescriptions = descriptionSources(input.column.rawDescriptions).length > 0;
    if (nonNullValues.length === 0 && !hasRawDescriptions) {
      return null;
    }
    const prompt = buildKtxColumnDescriptionPrompt({
      columnName: input.column.name,
      columnValues: nonNullValues,
      tableContext: input.tableContext,
      dataSourceType: input.dataSourceType,
      supportsNestedAnalysis: input.supportsNestedAnalysis,
      rawDescriptions: input.column.rawDescriptions,
      maxWords: this.settings.columnMaxWords,
    });
    return this.generateAiDescription(prompt, 'ktx-column-description');
  }

  private async generateAiDescription(prompt: KtxDescriptionPrompt, _operationName: string): Promise<string | null> {
    try {
      const text = await this.llmRuntime.generateText({
        role: 'candidateExtraction',
        system: prompt.system,
        prompt: prompt.user,
        temperature: this.settings.temperature,
      });
      const description = text.trim();
      return description || null;
    } catch (error) {
      this.logger?.error(`Error generating AI description: ${errorMessage(error)}`);
      return null;
    }
  }
}
