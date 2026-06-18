import { arch, platform, release } from 'node:os';
import { z } from 'zod';

const telemetryCommonEnvelopeSchema = z
  .object({
    cliVersion: z.string(),
    nodeVersion: z.string(),
    osPlatform: z.string(),
    osRelease: z.string(),
    arch: z.string(),
    runtime: z.enum(['node', 'daemon-py']),
    isCi: z.boolean(),
  })
  .strict();

const installFirstRunSchema = telemetryCommonEnvelopeSchema.strict();

const commandSchema = telemetryCommonEnvelopeSchema
  .extend({
    commandPath: z.array(z.string()).min(1),
    durationMs: z.number().nonnegative(),
    outcome: z.enum(['ok', 'error', 'aborted']),
    errorClass: z.string().optional(),
    errorDetail: z.string().max(1000).optional(),
    flagsPresent: z.record(z.string(), z.boolean()),
    hasProject: z.boolean(),
    projectGroupAttached: z.boolean(),
  })
  .strict();

const outcomeSchema = z.enum(['ok', 'error']);

const setupStepSchema = telemetryCommonEnvelopeSchema
  .extend({
    step: z.enum([
      'project',
      'runtime',
      'models',
      'embeddings',
      'secrets',
      'databases',
      'sources',
      'context',
      'agents',
      'demo-tour',
    ]),
    outcome: z.enum(['completed', 'skipped', 'abandoned']),
    durationMs: z.number().nonnegative(),
    errorDetail: z.string().max(1000).optional(),
  })
  .strict();

const connectionAddedSchema = telemetryCommonEnvelopeSchema
  .extend({
    driver: z.string(),
    isDemoConnection: z.boolean(),
  })
  .strict();

const connectionTestSchema = telemetryCommonEnvelopeSchema
  .extend({
    driver: z.string(),
    isDemoConnection: z.boolean(),
    outcome: outcomeSchema,
    errorClass: z.string().optional(),
    errorDetail: z.string().max(1000).optional(),
    durationMs: z.number().nonnegative(),
    serverVersion: z.string().optional(),
  })
  .strict();

const projectStackSnapshotSchema = telemetryCommonEnvelopeSchema
  .extend({
    connectors: z.array(z.object({ driver: z.string(), isDemo: z.boolean() }).strict()),
    connectionCount: z.number().int().nonnegative(),
    hasSl: z.boolean(),
    hasWiki: z.boolean(),
    hasMcp: z.boolean(),
    hasManagedRuntime: z.boolean(),
  })
  .strict();

const rowsBucketSchema = z.enum(['<10k', '<100k', '<1M', '<10M', '>=10M']);

const ingestCompletedSchema = telemetryCommonEnvelopeSchema
  .extend({
    driver: z.string(),
    isDemoConnection: z.boolean(),
    schemaCount: z.number().int().nonnegative(),
    tableCount: z.number().int().nonnegative(),
    columnCount: z.number().int().nonnegative(),
    rowsBucket: rowsBucketSchema,
    durationMs: z.number().nonnegative(),
    outcome: outcomeSchema,
    errorClass: z.string().optional(),
    errorDetail: z.string().max(1000).optional(),
  })
  .strict();

const scanCompletedSchema = telemetryCommonEnvelopeSchema
  .extend({
    driver: z.string(),
    tableCount: z.number().int().nonnegative(),
    columnCount: z.number().int().nonnegative(),
    inferredFkCount: z.number().int().nonnegative(),
    declaredFkCount: z.number().int().nonnegative(),
    durationMs: z.number().nonnegative(),
    outcome: outcomeSchema,
    errorClass: z.string().optional(),
    errorDetail: z.string().max(1000).optional(),
  })
  .strict();

const slValidateCompletedSchema = telemetryCommonEnvelopeSchema
  .extend({
    sourceCount: z.number().int().nonnegative(),
    modelCount: z.number().int().nonnegative(),
    validationErrorCount: z.number().int().nonnegative(),
    outcome: outcomeSchema,
    errorClass: z.string().optional(),
    durationMs: z.number().nonnegative(),
  })
  .strict();

const slQueryCompletedSchema = telemetryCommonEnvelopeSchema
  .extend({
    mode: z.enum(['compile', 'execute']),
    referencedSourceCount: z.number().int().nonnegative(),
    referencedDimensionCount: z.number().int().nonnegative(),
    referencedMeasureCount: z.number().int().nonnegative(),
    durationMs: z.number().nonnegative(),
    outcome: outcomeSchema,
    errorClass: z.string().optional(),
  })
  .strict();

const sqlCompletedSchema = telemetryCommonEnvelopeSchema
  .extend({
    driver: z.string(),
    isDemoConnection: z.boolean(),
    queryVerb: z.enum(['select', 'explain', 'show', 'with', 'other']),
    referencedTableCount: z.number().int().nonnegative(),
    durationMs: z.number().nonnegative(),
    outcome: outcomeSchema,
    errorClass: z.string().optional(),
  })
  .strict();

const wikiQueryCompletedSchema = telemetryCommonEnvelopeSchema
  .extend({
    queryLength: z.number().int().nonnegative(),
    resultCount: z.number().int().nonnegative(),
    durationMs: z.number().nonnegative(),
    outcome: outcomeSchema,
  })
  .strict();

const mcpRequestCompletedSchema = telemetryCommonEnvelopeSchema
  .extend({
    toolName: z.string(),
    outcome: outcomeSchema,
    durationMs: z.number().nonnegative(),
    errorClass: z.string().optional(),
    errorDetail: z.string().max(1000).optional(),
    sampleRate: z.literal(1),
    // Raw, client-tool-controlled identity from the MCP initialize handshake
    // (clientInfo.name/version). Optional: clients may omit clientInfo. Stored
    // verbatim — normalize the free-form names at query time, not at write time.
    mcpClientName: z.string().optional(),
    mcpClientVersion: z.string().optional(),
  })
  .strict();

const daemonStartedSchema = telemetryCommonEnvelopeSchema
  .extend({
    daemonVersion: z.string(),
    pythonVersion: z.string(),
    runtimeVersion: z.string(),
    startupDurationMs: z.number().nonnegative(),
  })
  .strict();

const daemonStoppedSchema = telemetryCommonEnvelopeSchema
  .extend({
    reason: z.enum(['signal', 'request', 'crash']),
    uptimeMs: z.number().nonnegative(),
  })
  .strict();

const slPlanCompletedSchema = telemetryCommonEnvelopeSchema
  .extend({
    outcome: z.enum(['ok', 'error']),
    stage: z.enum(['parse', 'resolve', 'compile', 'transpile']),
    errorClass: z.string().optional(),
    durationMs: z.number().nonnegative(),
    sourceCount: z.number().int().nonnegative(),
    joinCount: z.number().int().nonnegative(),
  })
  .strict();

const sqlGenCompletedSchema = telemetryCommonEnvelopeSchema
  .extend({
    outcome: z.enum(['ok', 'error']),
    dialect: z.string(),
    errorClass: z.string().optional(),
    durationMs: z.number().nonnegative(),
  })
  .strict();

const queryHistoryFilterCompletedSchema = telemetryCommonEnvelopeSchema
  .extend({
    dialect: z.string(),
    consideredRoleCount: z.number().int().nonnegative(),
    excludedRoleCount: z.number().int().nonnegative(),
    parseFailedCount: z.number().int().nonnegative(),
    outcome: outcomeSchema,
  })
  .strict();

/** @internal */
export const telemetryEventSchemas = {
  install_first_run: installFirstRunSchema,
  command: commandSchema,
  setup_step: setupStepSchema,
  connection_added: connectionAddedSchema,
  connection_test: connectionTestSchema,
  project_stack_snapshot: projectStackSnapshotSchema,
  ingest_completed: ingestCompletedSchema,
  scan_completed: scanCompletedSchema,
  sl_validate_completed: slValidateCompletedSchema,
  sl_query_completed: slQueryCompletedSchema,
  sql_completed: sqlCompletedSchema,
  wiki_query_completed: wikiQueryCompletedSchema,
  mcp_request_completed: mcpRequestCompletedSchema,
  daemon_started: daemonStartedSchema,
  daemon_stopped: daemonStoppedSchema,
  sl_plan_completed: slPlanCompletedSchema,
  sql_gen_completed: sqlGenCompletedSchema,
  query_history_filter_completed: queryHistoryFilterCompletedSchema,
} as const;

/** @internal */
export const telemetryEventCatalog = [
  {
    name: 'install_first_run',
    description: 'Emitted once when ~/.ktx/telemetry.json is created.',
    fields: [],
  },
  {
    name: 'command',
    description: 'Emitted once for each Commander action that reaches preAction.',
    fields: [
      'commandPath',
      'durationMs',
      'outcome',
      'errorClass',
      'errorDetail',
      'flagsPresent',
      'hasProject',
      'projectGroupAttached',
    ],
  },
  {
    name: 'setup_step',
    description: 'Emitted after an interactive setup step completes, skips, or aborts.',
    fields: ['step', 'outcome', 'durationMs', 'errorDetail'],
  },
  {
    name: 'connection_added',
    description: 'Emitted when setup writes a database, source, or demo connection.',
    fields: ['driver', 'isDemoConnection'],
  },
  {
    name: 'connection_test',
    description: 'Emitted after ktx connection test completes.',
    fields: ['driver', 'isDemoConnection', 'outcome', 'errorClass', 'errorDetail', 'durationMs', 'serverVersion'],
  },
  {
    name: 'project_stack_snapshot',
    description: 'Emitted after commands that can summarize the local project stack.',
    fields: ['connectors', 'connectionCount', 'hasSl', 'hasWiki', 'hasMcp', 'hasManagedRuntime'],
  },
  {
    name: 'ingest_completed',
    description: 'Emitted after a public ingest target completes.',
    fields: [
      'driver',
      'isDemoConnection',
      'schemaCount',
      'tableCount',
      'columnCount',
      'rowsBucket',
      'durationMs',
      'outcome',
      'errorClass',
      'errorDetail',
    ],
  },
  {
    name: 'scan_completed',
    description: 'Emitted after schema scan or relationship inference completes.',
    fields: [
      'driver',
      'tableCount',
      'columnCount',
      'inferredFkCount',
      'declaredFkCount',
      'durationMs',
      'outcome',
      'errorClass',
      'errorDetail',
    ],
  },
  {
    name: 'sl_validate_completed',
    description: 'Emitted after ktx sl validate completes.',
    fields: ['sourceCount', 'modelCount', 'validationErrorCount', 'outcome', 'errorClass', 'durationMs'],
  },
  {
    name: 'sl_query_completed',
    description: 'Emitted after ktx sl query compiles or executes.',
    fields: [
      'mode',
      'referencedSourceCount',
      'referencedDimensionCount',
      'referencedMeasureCount',
      'durationMs',
      'outcome',
      'errorClass',
    ],
  },
  {
    name: 'sql_completed',
    description: 'Emitted after ktx sql completes validation and execution.',
    fields: [
      'driver',
      'isDemoConnection',
      'queryVerb',
      'referencedTableCount',
      'durationMs',
      'outcome',
      'errorClass',
    ],
  },
  {
    name: 'wiki_query_completed',
    description: 'Emitted after a wiki query completes.',
    fields: ['queryLength', 'resultCount', 'durationMs', 'outcome'],
  },
  {
    name: 'mcp_request_completed',
    description: 'Emitted for sampled MCP tool requests.',
    fields: [
      'toolName',
      'outcome',
      'durationMs',
      'errorClass',
      'errorDetail',
      'sampleRate',
      'mcpClientName',
      'mcpClientVersion',
    ],
  },
  {
    name: 'daemon_started',
    description: 'Emitted when the long-lived ktx-daemon HTTP server starts.',
    fields: ['daemonVersion', 'pythonVersion', 'runtimeVersion', 'startupDurationMs'],
  },
  {
    name: 'daemon_stopped',
    description: 'Emitted when the long-lived ktx-daemon HTTP server shuts down.',
    fields: ['reason', 'uptimeMs'],
  },
  {
    name: 'sl_plan_completed',
    description: 'Emitted after a daemon semantic-layer planning pass completes.',
    fields: ['outcome', 'stage', 'errorClass', 'durationMs', 'sourceCount', 'joinCount'],
  },
  {
    name: 'sql_gen_completed',
    description: 'Emitted after daemon SQL generation completes.',
    fields: ['outcome', 'dialect', 'errorClass', 'durationMs'],
  },
  {
    name: 'query_history_filter_completed',
    description: 'Emitted after the setup query-history service-account filter picker runs.',
    fields: ['dialect', 'consideredRoleCount', 'excludedRoleCount', 'parseFailedCount', 'outcome'],
  },
] as const;

export type TelemetryEventName = keyof typeof telemetryEventSchemas;
export type TelemetryCommonEnvelope = z.infer<typeof telemetryCommonEnvelopeSchema>;

export type TelemetryEventProperties<Name extends TelemetryEventName> = z.infer<
  (typeof telemetryEventSchemas)[Name]
>;

export interface BuiltTelemetryEvent<Name extends TelemetryEventName = TelemetryEventName> {
  name: Name;
  properties: TelemetryEventProperties<Name>;
}

export function buildCommonEnvelope(input: { cliVersion: string; isCi: boolean }): TelemetryCommonEnvelope {
  return {
    cliVersion: input.cliVersion,
    nodeVersion: process.version,
    osPlatform: platform(),
    osRelease: release(),
    arch: arch(),
    runtime: 'node',
    isCi: input.isCi,
  };
}

export function buildTelemetryEvent<Name extends TelemetryEventName>(
  name: Name,
  envelope: TelemetryCommonEnvelope,
  fields: Omit<TelemetryEventProperties<Name>, keyof TelemetryCommonEnvelope>,
): BuiltTelemetryEvent<Name> {
  const schema = telemetryEventSchemas[name];
  return {
    name,
    properties: schema.parse({ ...envelope, ...fields }) as TelemetryEventProperties<Name>,
  };
}
