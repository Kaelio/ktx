import { randomUUID } from 'node:crypto';
import type { ToolAnnotations } from '@modelcontextprotocol/sdk/types.js';
import { z } from 'zod';
import type { KtxCliIo } from '../../cli-runtime.js';
import type { MemoryAgentInput } from '../../context/memory/types.js';
import {
  emitTelemetryEvent,
  mcpTelemetrySampleRate,
  reportException,
  shouldEmitMcpTelemetry,
} from '../../telemetry/index.js';
import { collectTelemetryRedactionSecrets } from '../../telemetry/redaction-secrets.js';
import { formatErrorDetail, scrubErrorClass } from '../../telemetry/scrubber.js';
import type {
  KtxMcpClientInfo,
  KtxMcpContextPorts,
  KtxMcpProgressCallback,
  KtxMcpServerLike,
  KtxMcpToolHandlerContext,
  KtxMcpToolResult,
  KtxMcpUserContext,
  KtxSemanticLayerQueryResponse,
  NonArrayObject,
} from './types.js';

export interface RegisterKtxContextToolsDeps {
  server: KtxMcpServerLike;
  ports: KtxMcpContextPorts;
  userContext: KtxMcpUserContext;
  projectDir?: string;
  io?: KtxCliIo;
  getClientInfo?: () => KtxMcpClientInfo | undefined;
}

const connectionIdSchema = z.string().min(1);
const unknownRecordSchema = z.record(z.string(), z.unknown());
const tableRefSchema = z.object({
  catalog: z.string().nullable(),
  db: z.string().nullable(),
  name: z.string(),
});

const toolAnnotations = {
  connection_list: { title: 'Connection List', readOnlyHint: true, idempotentHint: true, openWorldHint: false },
  discover_data: { title: 'Discover Data', readOnlyHint: true, openWorldHint: false },
  wiki_search: { title: 'Wiki Search', readOnlyHint: true, openWorldHint: false },
  wiki_read: { title: 'Wiki Read', readOnlyHint: true, idempotentHint: true, openWorldHint: false },
  entity_details: { title: 'Entity Details', readOnlyHint: true, idempotentHint: true, openWorldHint: false },
  dictionary_search: { title: 'Dictionary Search', readOnlyHint: true, openWorldHint: false },
  sl_read_source: { title: 'Semantic Layer Read Source', readOnlyHint: true, idempotentHint: true, openWorldHint: false },
  sl_query: { title: 'Semantic Layer Query', readOnlyHint: true, openWorldHint: false },
  sql_execution: { title: 'SQL Execution', readOnlyHint: true, openWorldHint: false },
  memory_ingest: { title: 'Memory Ingest', destructiveHint: true, openWorldHint: false },
  memory_ingest_status: { title: 'Memory Ingest Status', readOnlyHint: true, openWorldHint: false },
} satisfies Record<string, ToolAnnotations>;

const toolDescriptions = {
  connection_list:
    'List configured read-only data connections available to this ktx project. Use this before connection-scoped tools when the project may have multiple warehouses.',
  discover_data:
    'Search across ktx wiki pages, semantic-layer sources, measures, dimensions, raw tables, and columns. Example: discover_data({ query: "monthly orders by customer", connectionId: "warehouse", kinds: ["sl_source", "table"] }).',
  wiki_search:
    'Search ktx wiki pages for reusable business context. Example: wiki_search({ query: "revenue recognition", limit: 5 }).',
  wiki_read: 'Read a ktx wiki page by key returned from wiki_search. Example: wiki_read({ key: "global/revenue" }).',
  entity_details:
    'Read table and column metadata from the latest live-database scan snapshot. Example: entity_details({ connectionId: "warehouse", entities: [{ table: { catalog: null, db: "public", name: "orders" }, columns: ["id"] }] }).',
  dictionary_search:
    'Search profile-sampled warehouse values to locate likely source columns for business values. Example: dictionary_search({ values: ["Acme Corp"], connectionId: "warehouse" }).',
  sl_read_source:
    'Read a semantic-layer YAML source by connection id and source name. Example: sl_read_source({ connectionId: "warehouse", sourceName: "orders" }).',
  sl_query:
    'Execute a semantic-layer query and return headers, rows, and total row count, plus correctness notes (e.g. compile-only or fan-out) when relevant. The generated SQL and full query plan are omitted by default; request them with include: ["sql"] and/or include: ["plan"]. Example: sl_query({ connectionId: "warehouse", measures: ["orders.order_count"], dimensions: [{ field: "orders.created_at", granularity: "month" }], include: ["sql"] }).',
  sql_execution:
    'Execute one parser-validated read-only SQL query against a configured ktx connection. Example: sql_execution({ connectionId: "warehouse", sql: "select count(*) from public.orders", maxRows: 100 }).',
  memory_ingest:
    'Ingest free-form markdown knowledge into durable ktx memory. Use this for business rules, metric definitions, schema gotchas, recurring findings, or explicit user requests to remember something. Example: memory_ingest({ connectionId: "warehouse", content: "ARR is reported in cents in this warehouse." }).',
  memory_ingest_status:
    'Read the current or final status for a memory ingest run. Example: memory_ingest_status({ runId: "memory-run-1" }).',
} satisfies Record<string, string>;

const connectionListSchema = z.object({});

const knowledgeSearchSchema = z.object({
  query: z.string().min(1).describe('Natural-language wiki search query, e.g. "revenue recognition policy".'),
  limit: z.number().int().min(1).max(50).default(10).describe('Maximum wiki pages to return.'),
});

const knowledgeReadSchema = z.object({
  key: z.string().min(1).describe('Wiki page key returned by wiki_search, e.g. "global/revenue".'),
});

const slReadSourceSchema = z.object({
  connectionId: connectionIdSchema.describe('Connection id that owns the semantic-layer source.'),
  sourceName: z.string().min(1).describe('Semantic-layer source name without ".yaml", e.g. "orders".'),
});

const slQueryMeasureSchema = z.union([
  z.string().describe('Semantic-layer measure key, e.g. "orders.order_count".'),
  z.object({
    expr: z.string().min(1).describe('Ad hoc aggregate expression, e.g. "sum(orders.amount)".'),
    name: z.string().min(1).describe('Alias for the ad hoc measure, e.g. "gross_revenue".'),
  }),
]);

const slQueryDimensionSchema = z.object({
    field: z.string().min(1).describe('Dimension to group by, e.g. "orders.created_at" or "orders.status".'),
    granularity: z
      .string()
      .min(1)
      .optional()
      .describe('Time grain for time dimensions: day, week, month, quarter, or year.'),
  });

const slQueryOrderBySchema = z.object({
    field: z
      .string()
      .min(1)
      .describe(
        'Field/measure/dimension id to order by, e.g. "orders.created_at", a dimension key like "mart_nrr_quarterly.quarter_label", or a measure alias.',
      ),
    direction: z.enum(['asc', 'desc']).default('asc').describe('Sort direction for this field.'),
  });

const slQuerySchema = z.object({
  connectionId: connectionIdSchema
    .optional()
    .describe('Connection id to query. Omit only when the project has exactly one configured connection.'),
  measures: z.array(slQueryMeasureSchema).min(1).describe('Measures to select. Use semantic-layer keys when available.'),
  dimensions: z
    .array(slQueryDimensionSchema)
    .default([])
    .describe('Dimensions to group by. Use {field, granularity?} entries.'),
  filters: z
    .array(z.string().describe('Semantic-layer filter expression, e.g. "orders.status = paid".'))
    .default([])
    .describe('Semantic-layer filter expressions to apply.'),
  segments: z
    .array(z.string().describe('Semantic-layer segment key to apply.'))
    .default([])
    .describe('Semantic-layer segment keys to apply.'),
  order_by: z
    .array(slQueryOrderBySchema)
    .default([])
    .describe('Sort clauses. Use {field, direction?} entries.'),
  limit: z.number().int().min(0).default(1000).describe('Maximum rows to return.'),
  include_empty: z.boolean().default(true).describe('Whether to include empty dimension groups.'),
  include: z
    .array(z.enum(['plan', 'sql']))
    .default([])
    .describe('Extra detail to attach to the response: "sql" for the generated SQL, "plan" for the full query plan.'),
});

const entityDetailsTableRefSchema = z.object({
    catalog: z.string().nullable().describe('Catalog/project/database. Use null when not applicable.'),
    db: z.string().nullable().describe('Schema/database/dataset. Use null when not applicable.'),
    name: z.string().min(1).describe('Table name.'),
  });

const entityDetailsSchema = z.object({
  connectionId: connectionIdSchema.describe('Connection id whose latest scan snapshot should be read.'),
  entities: z
    .array(
      z.object({
        table: z
          .union([z.string().min(1), entityDetailsTableRefSchema])
          .describe('Table display string or canonical object ref.'),
        columns: z
          .array(z.string().min(1).describe('Column name to inspect.'))
          .optional()
          .describe('Optional column filter.'),
      }),
    )
    .min(1)
    .max(20)
    .describe('Tables or columns to inspect. Maximum 20 entities.'),
});

const dictionarySearchSchema = z.object({
  values: z
    .array(z.string().min(1).describe('Business value to locate, e.g. "Acme Corp" or "enterprise".'))
    .min(1)
    .max(20)
    .describe('Values to search for in sampled warehouse dictionaries.'),
  connectionId: connectionIdSchema
    .optional()
    .describe('Optional connection id. Pass it when user intent pins a specific warehouse.'),
});

const discoverDataKindSchema = z.enum(['wiki', 'sl_source', 'sl_measure', 'sl_dimension', 'table', 'column']);

const discoverDataSchema = z.object({
  query: z.string().min(1).describe('Natural-language discovery query, e.g. "monthly orders by customer".'),
  connectionId: connectionIdSchema
    .optional()
    .describe('Optional connection id. Pass it when user intent pins a specific warehouse.'),
  kinds: z.array(discoverDataKindSchema.describe('Reference kind to include.')).optional().describe('Optional kind filter.'),
  limit: z.number().int().min(1).max(50).default(10).optional().describe('Maximum refs to return.'),
});

const sqlExecutionSchema = z.object({
  connectionId: connectionIdSchema.describe('Connection id to execute against. Required for raw SQL.'),
  sql: z.string().min(1).describe('Parser-validated read-only SQL, e.g. "select count(*) from public.orders".'),
  maxRows: z.number().int().min(1).max(10_000).default(1000).optional().describe('Maximum rows to return.'),
});

const memoryIngestSchema = z.object({
  content: z
    .string()
    .min(1)
    .describe(
      'Free-form markdown to ingest. Include the knowledge itself plus any context (source, the user question, why this came up) that the memory agent should consider when triaging into wiki/SL.',
    ),
  connectionId: connectionIdSchema
    .optional()
    .describe(
      'Scope this memory to a specific connection. Required when the knowledge is warehouse-specific, including measure definitions, schema gotchas, or anything tied to a particular warehouse. Omit only for global wiki knowledge.',
    ),
});

const memoryIngestStatusSchema = z.object({
  runId: z.string().min(1).describe('The memory ingest run id returned by memory_ingest.'),
});

const connectionListOutputSchema = z.object({
  connections: z.array(
    z.object({
      id: z.string(),
      name: z.string(),
      connectionType: z.string(),
    }),
  ),
});

const wikiSearchOutputSchema = z.object({
  results: z.array(
    z.object({
      key: z.string(),
      path: z.string(),
      scope: z.enum(['GLOBAL', 'USER']),
      summary: z.string(),
      score: z.number(),
      matchReasons: z.array(z.string()).optional(),
      lanes: z
        .array(
          z.object({
            lane: z.string(),
            status: z.string(),
            requestedCandidatePoolLimit: z.number(),
            effectiveCandidatePoolLimit: z.number(),
            returnedCandidateCount: z.number(),
            weight: z.number(),
            reason: z.string().optional(),
          }),
        )
        .optional(),
    }),
  ),
  totalFound: z.number(),
});

const wikiReadOutputSchema = z.object({
  key: z.string(),
  summary: z.string(),
  content: z.string(),
  scope: z.enum(['GLOBAL', 'USER']),
  tags: z.array(z.string()).optional(),
  refs: z.array(z.string()).optional(),
  slRefs: z.array(z.string()).optional(),
});

const slReadSourceOutputSchema = z.object({
  sourceName: z.string(),
  yaml: z.string(),
});

const slQueryOutputSchema = z.object({
  connectionId: z.string().optional(),
  dialect: z.string().optional(),
  headers: z.array(z.string()),
  rows: z.array(z.array(z.unknown())),
  totalRows: z.number(),
  // Correctness signals hoisted out of `plan` so they survive default projection (e.g. compile-only
  // status, fan-out warnings). Present only when there is something to report.
  notes: z.array(z.string()).optional(),
  // Opt-in detail, attached only when requested via the `include` input.
  sql: z.string().optional(),
  plan: unknownRecordSchema.optional(),
});

const entityDetailsSnapshotOutputSchema = z.object({
  syncId: z.string(),
  extractedAt: z.string(),
  scanRunId: z.string().nullable(),
});

const entityDetailsColumnOutputSchema = z.object({
  name: z.string(),
  nativeType: z.string(),
  normalizedType: z.string(),
  dimensionType: z.enum(['time', 'string', 'number', 'boolean']),
  nullable: z.boolean(),
  primaryKey: z.boolean(),
  comment: z.string().nullable(),
});

const entityDetailsForeignKeyOutputSchema = z.object({
  fromColumn: z.string(),
  toCatalog: z.string().nullable(),
  toDb: z.string().nullable(),
  toTable: z.string(),
  toColumn: z.string(),
  constraintName: z.string().nullable(),
});

const entityDetailsOutputSchema = z.object({
  results: z.array(
    z.union([
      z.object({
        ok: z.literal(true),
        connectionId: z.string(),
        tableRef: tableRefSchema,
        display: z.string(),
        kind: z.enum(['table', 'view', 'external', 'event_stream']),
        comment: z.string().nullable(),
        estimatedRows: z.number().nullable(),
        columns: z.array(entityDetailsColumnOutputSchema),
        foreignKeys: z.array(entityDetailsForeignKeyOutputSchema),
        snapshot: entityDetailsSnapshotOutputSchema,
      }),
      z.object({
        ok: z.literal(false),
        connectionId: z.string(),
        table: z.union([z.string(), tableRefSchema]),
        snapshot: entityDetailsSnapshotOutputSchema.optional(),
        error: z.object({
          code: z.enum(['scan_missing', 'table_not_found', 'ambiguous_table', 'column_not_found']),
          message: z.string(),
          candidates: z
            .union([z.array(z.object({ tableRef: tableRefSchema, display: z.string() })), z.array(z.string())])
            .optional(),
        }),
      }),
    ]),
  ),
});

const dictionarySearchOutputSchema = z.object({
  searched: z.array(
    z.object({
      connectionId: z.string(),
      coverage: z.object({
        sampledRows: z.number().nullable(),
        valuesPerColumn: z.number().nullable(),
        profiledColumns: z.number(),
        syncId: z.string().nullable(),
        profiledAt: z.string().nullable(),
      }),
      status: z.enum(['ready', 'no_profile_artifact', 'no_candidate_columns']),
    }),
  ),
  results: z.array(
    z.object({
      value: z.string(),
      matches: z.array(
        z.object({
          connectionId: z.string(),
          sourceName: z.string(),
          columnName: z.string(),
          matchedValue: z.string(),
          cardinality: z.number().nullable(),
        }),
      ),
      misses: z.array(
        z.object({
          connectionId: z.string(),
          reason: z.enum(['no_profile_artifact', 'no_candidate_columns', 'value_not_in_sample']),
        }),
      ),
    }),
  ),
});

const discoverDataOutputSchema = z.object({
  refs: z.array(
    z.object({
      kind: discoverDataKindSchema,
      id: z.string(),
      score: z.number(),
      summary: z.string().nullable(),
      snippet: z.string().nullable(),
      matchedOn: z.enum(['name', 'display', 'description', 'comment', 'expr', 'sample_value', 'body']),
      connectionId: z.string().optional(),
      tableRef: tableRefSchema.optional(),
      columnName: z.string().optional(),
    }),
  ),
});

const sqlExecutionOutputSchema = z.object({
  headers: z.array(z.string()),
  headerTypes: z.array(z.string()).optional(),
  rows: z.array(z.array(z.unknown())),
  rowCount: z.number(),
});

const memoryIngestOutputSchema = z.object({
  runId: z.string(),
});

const memoryIngestStatusOutputSchema = z.object({
  runId: z.string(),
  status: z.enum(['running', 'done', 'error']),
  stage: z.string(),
  done: z.boolean(),
  captured: z.object({
    wiki: z.array(z.string()),
    sl: z.array(z.string()),
    xrefs: z.array(z.string()),
  }),
  error: z.string().nullable(),
  commitHash: z.string().nullable(),
  skillsLoaded: z.array(z.string()),
  signalDetected: z.boolean(),
});

/** @internal */
export function jsonToolResult<T extends NonArrayObject>(structuredContent: T): KtxMcpToolResult<T> {
  // Compact (non-indented) JSON: this `content` text is the copy the model reads. Pretty-printing
  // arrays-of-arrays (every `rows` payload) puts one scalar per line, inflating tabular results by
  // a large constant factor. `structuredContent` carries the same data for structured-output clients.
  return {
    content: [{ type: 'text', text: JSON.stringify(structuredContent) }],
    structuredContent,
  };
}

/**
 * Pull the correctness-critical signals out of a query plan so they survive even when the caller
 * did not opt into the full `plan`. Returns an empty list when there is nothing to flag.
 */
function slQueryNotes(plan: Record<string, unknown> | undefined): string[] {
  if (!plan) {
    return [];
  }
  const notes: string[] = [];
  const execution = plan.execution;
  if (
    execution &&
    typeof execution === 'object' &&
    (execution as Record<string, unknown>).mode === 'compile_only'
  ) {
    const reason = (execution as Record<string, unknown>).reason;
    notes.push(typeof reason === 'string' ? reason : 'Compiled SQL only; no rows were executed.');
  }
  if (plan.has_fan_out === true) {
    const description = typeof plan.fan_out_description === 'string' ? plan.fan_out_description.trim() : '';
    notes.push(description.length > 0 ? description : 'Fan-out detected: measure totals may be inflated by joins.');
  }
  return notes;
}

/**
 * Default sl_query response is the minimum the agent needs to read the result: connection, headers,
 * rows, totals, plus any correctness notes. The generated `sql` and the full `plan` are attached only
 * when explicitly requested via `include`, since both are large and echo information the caller already has.
 */
function projectSlQueryResult(result: KtxSemanticLayerQueryResponse, include: ('plan' | 'sql')[]) {
  const notes = slQueryNotes(result.plan);
  return {
    ...(result.connectionId !== undefined ? { connectionId: result.connectionId } : {}),
    ...(result.dialect !== undefined ? { dialect: result.dialect } : {}),
    headers: result.headers,
    rows: result.rows,
    totalRows: result.totalRows,
    ...(notes.length > 0 ? { notes } : {}),
    ...(include.includes('sql') ? { sql: result.sql } : {}),
    ...(include.includes('plan') && result.plan ? { plan: result.plan } : {}),
  };
}

function jsonErrorToolResult(text: string): KtxMcpToolResult<Record<string, never>> {
  return {
    content: [{ type: 'text', text }],
    isError: true,
  };
}

function formatToolError(error: unknown): string {
  if (error instanceof z.ZodError) {
    return error.issues
      .map((issue) => `${issue.path.length > 0 ? issue.path.join('.') : '<root>'}: ${issue.message}`)
      .join('\n');
  }
  return error instanceof Error ? error.message : String(error);
}

function mcpProgressCallback(context?: KtxMcpToolHandlerContext): KtxMcpProgressCallback | undefined {
  const progressToken = context?._meta?.progressToken;
  if (progressToken === undefined || !context?.sendNotification) {
    return undefined;
  }
  return async (event) => {
    await context.sendNotification?.({
      method: 'notifications/progress',
      params: {
        progressToken,
        progress: event.progress,
        ...(event.total !== undefined ? { total: event.total } : {}),
        message: event.message,
      },
    });
  };
}

function registerParsedTool<TSchema extends z.ZodType>(
  server: KtxMcpServerLike,
  name: string,
  config: {
    title: string;
    description: string;
    inputSchema: unknown;
    outputSchema: unknown;
    annotations: ToolAnnotations;
  },
  schema: TSchema,
  handler: (input: z.infer<TSchema>, context?: KtxMcpToolHandlerContext) => Promise<KtxMcpToolResult>,
  telemetry?: { projectDir?: string; io?: KtxCliIo },
): void {
  server.registerTool(name, config, async (input, context) => {
    try {
      return await handler(schema.parse(input), context);
    } catch (error) {
      if (telemetry?.io) {
        await reportException({
          error,
          context: { source: `mcp:${name}`, handled: true, fatal: false },
          projectDir: telemetry.projectDir,
          io: telemetry.io,
          redactionSecrets: await collectTelemetryRedactionSecrets({
            projectDir: telemetry.projectDir,
            includeLlm: true,
            includeEmbeddings: true,
            env: process.env,
          }),
        });
      }
      return jsonErrorToolResult(formatToolError(error));
    }
  });
}

/**
 * Resolves the connected client's identity into the raw telemetry fields. The
 * strings are client-controlled and untrusted, so they only ever land in the
 * telemetry property bag — never in paths, logs, or error messages.
 */
function clientTelemetryFields(
  getClientInfo: (() => KtxMcpClientInfo | undefined) | undefined,
): { mcpClientName?: string; mcpClientVersion?: string } {
  const client = getClientInfo?.();
  return {
    ...(client?.name ? { mcpClientName: client.name } : {}),
    ...(client?.version ? { mcpClientVersion: client.version } : {}),
  };
}

// Tools registered via registerParsedTool catch their own errors and return an
// isError result, so the telemetry layer never sees the thrown Error. Recover
// the failure message from the result's text content (the same string the agent
// reads) so the outcome event is self-diagnosing.
function mcpErrorResultDetail(result: unknown): string | undefined {
  if (typeof result !== 'object' || result === null || !('content' in result)) {
    return undefined;
  }
  const content = (result as { content?: unknown }).content;
  if (!Array.isArray(content)) {
    return undefined;
  }
  const text = content
    .map((block) =>
      typeof block === 'object' && block !== null && typeof (block as { text?: unknown }).text === 'string'
        ? (block as { text: string }).text
        : '',
    )
    .join('\n');
  return formatErrorDetail(text);
}

function instrumentMcpServer(
  server: KtxMcpServerLike,
  telemetry: { projectDir?: string; io?: KtxCliIo; getClientInfo?: () => KtxMcpClientInfo | undefined },
): KtxMcpServerLike {
  return {
    registerTool(name, config, handler) {
      server.registerTool(name, config, async (input, context) => {
        const startedAt = performance.now();
        try {
          const result = await handler(input, context);
          if (telemetry.io && telemetry.projectDir && shouldEmitMcpTelemetry()) {
            const isError =
              typeof result === 'object' && result !== null && 'isError' in result && result.isError === true;
            const errorDetail = isError ? mcpErrorResultDetail(result) : undefined;
            await emitTelemetryEvent({
              name: 'mcp_request_completed',
              projectDir: telemetry.projectDir,
              io: telemetry.io,
              fields: {
                toolName: name,
                outcome: isError ? 'error' : 'ok',
                durationMs: Math.max(0, performance.now() - startedAt),
                sampleRate: mcpTelemetrySampleRate(),
                ...(errorDetail ? { errorDetail } : {}),
                ...clientTelemetryFields(telemetry.getClientInfo),
              },
            });
          }
          return result;
        } catch (error) {
          if (telemetry.io) {
            await reportException({
              error,
              context: { source: `mcp:${name}`, handled: true, fatal: false },
              projectDir: telemetry.projectDir,
              io: telemetry.io,
              redactionSecrets: await collectTelemetryRedactionSecrets({
                projectDir: telemetry.projectDir,
                includeLlm: true,
                includeEmbeddings: true,
                env: process.env,
              }),
            });
          }
          if (telemetry.io && telemetry.projectDir && shouldEmitMcpTelemetry()) {
            const errorClass = scrubErrorClass(error);
            const errorDetail = formatErrorDetail(error);
            await emitTelemetryEvent({
              name: 'mcp_request_completed',
              projectDir: telemetry.projectDir,
              io: telemetry.io,
              fields: {
                toolName: name,
                outcome: 'error',
                ...(errorClass ? { errorClass } : {}),
                ...(errorDetail ? { errorDetail } : {}),
                durationMs: Math.max(0, performance.now() - startedAt),
                sampleRate: mcpTelemetrySampleRate(),
                ...clientTelemetryFields(telemetry.getClientInfo),
              },
            });
          }
          throw error;
        }
      });
    },
  };
}

export function registerKtxContextTools(deps: RegisterKtxContextToolsDeps): void {
  const { ports, userContext } = deps;
  const toolTelemetry = { projectDir: deps.projectDir, io: deps.io };
  const server = instrumentMcpServer(deps.server, {
    projectDir: deps.projectDir,
    io: deps.io,
    getClientInfo: deps.getClientInfo,
  });

  if (ports.connections) {
    const connections = ports.connections;
    registerParsedTool(
      server,
      'connection_list',
      {
        title: toolAnnotations.connection_list.title!,
        description: toolDescriptions.connection_list,
        inputSchema: connectionListSchema.shape,
        outputSchema: connectionListOutputSchema,
        annotations: toolAnnotations.connection_list,
      },
      connectionListSchema,
      async () => jsonToolResult({ connections: await connections.list() }),
      toolTelemetry,
    );
  }

  if (ports.knowledge) {
    const knowledge = ports.knowledge;
    registerParsedTool(
      server,
      'wiki_search',
      {
        title: toolAnnotations.wiki_search.title!,
        description: toolDescriptions.wiki_search,
        inputSchema: knowledgeSearchSchema.shape,
        outputSchema: wikiSearchOutputSchema,
        annotations: toolAnnotations.wiki_search,
      },
      knowledgeSearchSchema,
      async (input) =>
        jsonToolResult(
          await knowledge.search({
            userId: userContext.userId,
            query: input.query,
            limit: input.limit,
          }),
        ),
      toolTelemetry,
    );

    registerParsedTool(
      server,
      'wiki_read',
      {
        title: toolAnnotations.wiki_read.title!,
        description: toolDescriptions.wiki_read,
        inputSchema: knowledgeReadSchema.shape,
        outputSchema: wikiReadOutputSchema,
        annotations: toolAnnotations.wiki_read,
      },
      knowledgeReadSchema,
      async (input) => {
        const page = await knowledge.read({ userId: userContext.userId, key: input.key });
        return page ? jsonToolResult(page) : jsonErrorToolResult(`Wiki page "${input.key}" was not found.`);
      },
      toolTelemetry,
    );
  }

  if (ports.semanticLayer) {
    const semanticLayer = ports.semanticLayer;
    registerParsedTool(
      server,
      'sl_read_source',
      {
        title: toolAnnotations.sl_read_source.title!,
        description: toolDescriptions.sl_read_source,
        inputSchema: slReadSourceSchema.shape,
        outputSchema: slReadSourceOutputSchema,
        annotations: toolAnnotations.sl_read_source,
      },
      slReadSourceSchema,
      async (input) => {
        const source = await semanticLayer.readSource(input);
        return source
          ? jsonToolResult(source)
          : jsonErrorToolResult(`Semantic-layer source "${input.sourceName}" was not found.`);
      },
      toolTelemetry,
    );

    registerParsedTool(
      server,
      'sl_query',
      {
        title: toolAnnotations.sl_query.title!,
        description: toolDescriptions.sl_query,
        inputSchema: slQuerySchema.shape,
        outputSchema: slQueryOutputSchema,
        annotations: toolAnnotations.sl_query,
      },
      slQuerySchema,
      async (input, context) => {
        const onProgress = mcpProgressCallback(context);
        const result = await semanticLayer.query(
          {
            connectionId: input.connectionId,
            query: {
              measures: input.measures,
              dimensions: input.dimensions,
              filters: input.filters,
              segments: input.segments,
              order_by: input.order_by,
              limit: input.limit,
              include_empty: input.include_empty,
            },
          },
          onProgress ? { onProgress } : undefined,
        );
        return jsonToolResult(projectSlQueryResult(result, input.include));
      },
      toolTelemetry,
    );
  }

  if (ports.entityDetails) {
    const entityDetails = ports.entityDetails;
    registerParsedTool(
      server,
      'entity_details',
      {
        title: toolAnnotations.entity_details.title!,
        description: toolDescriptions.entity_details,
        inputSchema: entityDetailsSchema.shape,
        outputSchema: entityDetailsOutputSchema,
        annotations: toolAnnotations.entity_details,
      },
      entityDetailsSchema,
      async (input) => jsonToolResult(await entityDetails.read(input)),
      toolTelemetry,
    );
  }

  if (ports.dictionarySearch) {
    const dictionarySearch = ports.dictionarySearch;
    registerParsedTool(
      server,
      'dictionary_search',
      {
        title: toolAnnotations.dictionary_search.title!,
        description: toolDescriptions.dictionary_search,
        inputSchema: dictionarySearchSchema.shape,
        outputSchema: dictionarySearchOutputSchema,
        annotations: toolAnnotations.dictionary_search,
      },
      dictionarySearchSchema,
      async (input) => jsonToolResult(await dictionarySearch.search(input)),
      toolTelemetry,
    );
  }

  if (ports.discover) {
    const discover = ports.discover;
    registerParsedTool(
      server,
      'discover_data',
      {
        title: toolAnnotations.discover_data.title!,
        description: toolDescriptions.discover_data,
        inputSchema: discoverDataSchema.shape,
        outputSchema: discoverDataOutputSchema,
        annotations: toolAnnotations.discover_data,
      },
      discoverDataSchema,
      async (input) => jsonToolResult({ refs: await discover.search(input) }),
      toolTelemetry,
    );
  }

  if (ports.sqlExecution) {
    const sqlExecution = ports.sqlExecution;
    registerParsedTool(
      server,
      'sql_execution',
      {
        title: toolAnnotations.sql_execution.title!,
        description: toolDescriptions.sql_execution,
        inputSchema: sqlExecutionSchema.shape,
        outputSchema: sqlExecutionOutputSchema,
        annotations: toolAnnotations.sql_execution,
      },
      sqlExecutionSchema,
      async (input, context) => {
        const onProgress = mcpProgressCallback(context);
        return jsonToolResult(
          await sqlExecution.execute(
            {
              connectionId: input.connectionId,
              sql: input.sql,
              maxRows: input.maxRows ?? 1000,
            },
            onProgress ? { onProgress } : undefined,
          ),
        );
      },
      toolTelemetry,
    );
  }

  if (ports.memoryIngest) {
    const memoryIngest = ports.memoryIngest;
    registerParsedTool(
      server,
      'memory_ingest',
      {
        title: toolAnnotations.memory_ingest.title!,
        description: toolDescriptions.memory_ingest,
        inputSchema: memoryIngestSchema.shape,
        outputSchema: memoryIngestOutputSchema,
        annotations: toolAnnotations.memory_ingest,
      },
      memoryIngestSchema,
      async (input) => {
        const ingestInput: MemoryAgentInput = {
          userId: userContext.userId,
          chatId: `mcp-${randomUUID()}`,
          userMessage: 'Ingest external knowledge into ktx memory.',
          assistantMessage: input.content,
          connectionId: input.connectionId,
          sourceType: 'external_ingest',
        };
        return jsonToolResult(await memoryIngest.ingest(ingestInput));
      },
      toolTelemetry,
    );

    registerParsedTool(
      server,
      'memory_ingest_status',
      {
        title: toolAnnotations.memory_ingest_status.title!,
        description: toolDescriptions.memory_ingest_status,
        inputSchema: memoryIngestStatusSchema.shape,
        outputSchema: memoryIngestStatusOutputSchema,
        annotations: toolAnnotations.memory_ingest_status,
      },
      memoryIngestStatusSchema,
      async (input) => {
        const status = await memoryIngest.status(input.runId);
        return status ? jsonToolResult(status) : jsonErrorToolResult(`Memory ingest run "${input.runId}" was not found.`);
      },
      toolTelemetry,
    );
  }
}
