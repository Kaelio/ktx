import { KTX_MODEL_ROLES } from '../../llm/types.js';
import YAML from 'yaml';
import * as z from 'zod';
import { connectionConfigSchema } from './driver-schemas.js';

const KTX_LLM_BACKENDS = ['none', 'anthropic', 'vertex', 'gateway', 'claude-code', 'codex'] as const;
const KTX_EMBEDDING_BACKENDS = ['none', 'openai', 'sentence-transformers'] as const;
const KTX_PROMPT_CACHE_TTLS = ['5m', '1h'] as const;
const KTX_ENRICHMENT_MODES = ['none', 'deterministic', 'llm'] as const;
const KTX_WORK_UNIT_FAILURE_MODES = ['abort', 'continue'] as const;
const KTX_STORAGE_STATES = ['sqlite', 'postgres'] as const;
const KTX_SEARCH_BACKENDS = ['sqlite-fts5', 'postgres-hybrid'] as const;

const apiCredentialsSchema = z
  .strictObject({
    api_key: z.string().min(1).optional().describe('API key for the provider. Read from this value or the provider-specific environment variable.'),
    base_url: z.string().min(1).optional().describe('Override the provider\'s default API base URL (e.g. a proxy or self-hosted gateway).'),
  })
  .describe('API credentials block: optional key and base URL for an LLM or embedding provider.');

const vertexProviderSchema = z
  .strictObject({
    project: z.string().min(1).optional().describe('Google Cloud project ID hosting the Vertex AI endpoint.'),
    location: z.string().min(1).describe('Vertex AI region (e.g. "us-east5"). Required whenever the vertex provider block is present.'),
  })
  .describe('Google Vertex AI provider configuration.');

const sentenceTransformersSchema = z
  .strictObject({
    base_url: z.string().default('').describe('Base URL of the sentence-transformers HTTP server. Leave empty (or omit) when the `ktx` CLI is expected to start and manage a local daemon for this project; programmatic consumers must populate it explicitly.'),
    pathPrefix: z.string().optional().describe('Optional URL path prefix prepended to embedding requests.'),
  })
  .describe('Sentence-transformers embedding server configuration.');

const llmProviderSchema = z
  .strictObject({
    backend: z
      .enum(KTX_LLM_BACKENDS)
      .default('none')
      .describe(
        'LLM provider backend. "none" disables LLM features; "anthropic" / "vertex" / "gateway" require the matching nested credentials block; "claude-code" uses the local Claude Code session; "codex" uses the local Codex session.',
      ),
    vertex: vertexProviderSchema.optional().describe('Vertex AI credentials, used when backend is "vertex".'),
    anthropic: apiCredentialsSchema.optional().describe('Anthropic API credentials, used when backend is "anthropic".'),
    gateway: apiCredentialsSchema.optional().describe('AI Gateway credentials, used when backend is "gateway".'),
  })
  .describe('LLM provider selection and credentials.');

const promptCachingSchema = z
  .strictObject({
    enabled: z.boolean().optional().describe('Master switch for Anthropic-style prompt caching. When omitted, the backend\'s default applies.'),
    systemTtl: z.enum(KTX_PROMPT_CACHE_TTLS).optional().describe('Cache TTL for the system prompt segment ("5m" or "1h").'),
    toolsTtl: z.enum(KTX_PROMPT_CACHE_TTLS).optional().describe('Cache TTL for the tools/schema segment ("5m" or "1h").'),
    historyTtl: z.enum(KTX_PROMPT_CACHE_TTLS).optional().describe('Cache TTL for conversation-history cache breakpoints ("5m" or "1h").'),
    vertexFallbackTo5m: z.boolean().optional().describe('When true, transparently downgrade 1h TTLs to 5m on Vertex, which does not support 1h caching.'),
  })
  .describe('Prompt-caching tunables for Anthropic-compatible providers.');

const llmSchema = z
  .strictObject({
    provider: llmProviderSchema.prefault({}).describe('LLM provider backend and credentials.'),
    models: z
      .partialRecord(z.enum(KTX_MODEL_ROLES), z.string().min(1))
      .default({})
      .describe('Per-role model overrides keyed by ktx model role (e.g. "default", "triage"). Values are provider-specific model identifiers.'),
    promptCaching: promptCachingSchema.optional().describe('Optional prompt-caching tunables.'),
  })
  .describe('LLM provider, per-role model overrides, and prompt-caching tunables.');

const embeddingSchema = z
  .strictObject({
    backend: z
      .enum(KTX_EMBEDDING_BACKENDS)
      .default('none')
      .describe('Embedding backend. "openai" and "sentence-transformers" call out to those providers; "none" disables embeddings.'),
    model: z.string().min(1).optional().describe('Provider-specific embedding model identifier (e.g. "text-embedding-3-small").'),
    dimensions: z
      .int()
      .positive()
      .default(8)
      .describe(
        'Embedding vector dimensionality. The default value 8 is a placeholder that is only valid alongside backend: none; ' +
          'before switching backend to openai/sentence-transformers, set this explicitly to match the chosen model ' +
          '(e.g. 384 for all-MiniLM-L6-v2, 1536 for text-embedding-3-small).',
      ),
    openai: apiCredentialsSchema.optional().describe('OpenAI credentials, used when backend is "openai".'),
    sentenceTransformers: sentenceTransformersSchema.optional().describe('Sentence-transformers server config, used when backend is "sentence-transformers".'),
    batchSize: z.int().positive().optional().describe('Number of texts per embedding API call. Omit to use the backend default.'),
  })
  .describe('Embedding backend, model, and provider credentials.');

const workUnitsSchema = z
  .strictObject({
    stepBudget: z.int().positive().default(40).describe('Maximum number of agent steps allowed per work unit before it is force-terminated.'),
    maxConcurrency: z.int().positive().default(1).describe('Maximum number of work units run concurrently during ingest.'),
    failureMode: z
      .enum(KTX_WORK_UNIT_FAILURE_MODES)
      .default('continue')
      .describe('Behavior when a work unit fails: "abort" stops the whole ingest run; "continue" records the failure and keeps going.'),
  })
  .describe('Concurrency and failure handling for ingest work units.');

const ingestRateLimitRetrySchema = z
  .strictObject({
    maxAttempts: z
      .int()
      .positive()
      .default(6)
      .describe(
        'Maximum attempts for a single rate-limited LLM call before the failure surfaces, counting the first try. Also bounds how far opaque backoff grows for providers that do not expose a reset time.',
      ),
    baseDelayMs: z.int().positive().default(1_000).describe('Initial opaque retry delay in milliseconds.'),
    maxDelayMs: z.int().positive().default(60_000).describe('Maximum opaque retry delay in milliseconds.'),
    jitter: z.boolean().default(true).describe('When true, apply bounded jitter to opaque retry delays.'),
  })
  .describe('Retry policy for rate-limit responses that do not include a reset time or retry-after value.');

const ingestRateLimitSchema = z
  .strictObject({
    enabled: z.boolean().default(true).describe('Master switch for ingest LLM rate-limit pacing and visible waits.'),
    throttleThreshold: z
      .number()
      .min(0)
      .max(1)
      .default(0.8)
      .describe('Provider utilization at or above which ingest throttles new work-unit starts.'),
    minConcurrencyUnderPressure: z
      .int()
      .positive()
      .default(1)
      .describe('Effective work-unit concurrency while a provider is under rate-limit pressure.'),
    maxWaitMs: z
      .int()
      .positive()
      .optional()
      .describe('Optional cap on a single provider reset wait. Omit to wait indefinitely until the provider reset time.'),
    retry: ingestRateLimitRetrySchema.prefault({}).describe('Opaque retry policy for providers without reset hints.'),
  })
  .describe('Rate-limit pacing and wait policy for ingest LLM calls.');

const ingestSchema = z
  .strictObject({
    adapters: z
      .array(z.string().min(1))
      .default([])
      .describe('Ingest adapter identifiers to run (e.g. "metabase", "looker", "historic-sql"). Empty array means no adapters are run.'),
    embeddings: embeddingSchema
      .prefault({ backend: 'none' })
      .describe('Embedding configuration used when ingest adapters need to embed documents.'),
    workUnits: workUnitsSchema.prefault({}).describe('Concurrency and failure handling for ingest work units.'),
    rateLimit: ingestRateLimitSchema.prefault({}).describe('LLM rate-limit pacing and visible-wait policy for ingest.'),
    profile: z
      .union([z.boolean(), z.literal('json')])
      .default(false)
      .describe(
        'Print a timing breakdown to stderr at the end of each ingest run. `true` prints a human table; `"json"` prints the raw structured profile for coding agents; `false` disables it. Equivalent to the KTX_PROFILE_INGEST environment variable (`1`/`true`/`json`).',
      ),
  })
  .describe('Ingest pipeline configuration: adapters, embeddings, and work-unit policy.');

const scanEnrichmentSchema = z
  .strictObject({
    mode: z
      .enum(KTX_ENRICHMENT_MODES)
      .default('none')
      .describe('Column/table enrichment mode. "none" disables enrichment; "deterministic" uses local heuristics; "llm" calls the configured LLM provider.'),
    embeddings: embeddingSchema.optional().describe('Optional embedding override for enrichment-time vectorization. Falls back to ingest.embeddings when omitted.'),
  })
  .describe('Schema-scan enrichment: how columns and tables are described.');

const scanRelationshipsSchema = z
  .strictObject({
    enabled: z.boolean().default(true).describe('Master switch for relationship discovery during scan.'),
    llmProposals: z.boolean().default(true).describe('When true, propose relationships using the configured LLM in addition to deterministic candidates.'),
    validationRequiredForManifest: z
      .boolean()
      .default(true)
      .describe('When true, only relationships that pass database-side validation are written to the manifest.'),
    acceptThreshold: z
      .number()
      .min(0)
      .max(1)
      .default(0.85)
      .describe('Confidence score (0–1) at or above which an LLM-proposed relationship is auto-accepted into the manifest.'),
    reviewThreshold: z
      .number()
      .min(0)
      .max(1)
      .default(0.55)
      .describe('Confidence score (0–1) at or above which a proposal is surfaced for human review (but not auto-accepted).'),
    maxLlmTablesPerBatch: z
      .int()
      .positive()
      .default(40)
      .describe('Maximum number of tables included in a single LLM relationship-proposal batch.'),
    maxCandidatesPerColumn: z
      .int()
      .positive()
      .default(25)
      .describe('Maximum number of candidate join partners considered per column during relationship discovery.'),
    profileSampleRows: z.int().positive().default(10000).describe('Number of rows sampled per table when profiling values for relationship inference.'),
    profileConcurrency: z
      .int()
      .positive()
      .default(4)
      .describe('Parallel relationship-profile queries run against the database during scan.'),
    validationConcurrency: z.int().positive().default(4).describe('Number of relationship validation queries run in parallel against the database.'),
    validationBudget: z
      .union([z.literal('all'), z.int().nonnegative()])
      .optional()
      .describe('Cap on validation queries per scan run. Use "all" for unlimited, an integer for a hard cap, or omit for the runtime default.'),
    detectionBudgetMs: z
      .int()
      .positive()
      .default(600_000)
      .describe('Wall-clock budget (ms) for the whole relationship-detection stage. Checked at table-profile, LLM-proposal, candidate-validation, and composite-probe boundaries; above the per-query deadline. On exhaustion the stage stops scheduling new work and returns the relationships found so far, marked partial. Raise it to trigger a fresher, fuller run.'),
  })
  .describe('Schema-scan relationship discovery and validation tunables.');

const scanSchema = z
  .strictObject({
    enrichment: scanEnrichmentSchema.prefault({}).describe('Column/table enrichment configuration.'),
    relationships: scanRelationshipsSchema.prefault({}).describe('Relationship discovery and validation configuration.'),
  })
  .describe('Schema-scan configuration: enrichment and relationship discovery.');

const setupSchema = z
  .strictObject({
    database_connection_ids: z
      .array(z.string().min(1))
      .default([])
      .describe('Connection IDs (keys of the top-level `connections` map) that the setup wizard treats as the project\'s primary databases.'),
  })
  .describe('Setup-wizard state captured during `ktx setup`.');

const storageGitSchema = z
  .strictObject({
    author: z
      .string()
      .min(1)
      .default('ktx <ktx@example.com>')
      .describe('Git author identity used for commits, in standard "Name <email>" form.'),
  })
  .describe('Git-backed storage author policy.');

const storageSchema = z
  .strictObject({
    state: z
      .enum(KTX_STORAGE_STATES)
      .default('sqlite')
      .describe('Backend for ktx state storage. "sqlite" uses .ktx/db.sqlite; "postgres" expects a configured Postgres connection.'),
    search: z
      .enum(KTX_SEARCH_BACKENDS)
      .default('sqlite-fts5')
      .describe('Backend for search indexes. "sqlite-fts5" uses SQLite FTS5; "postgres-hybrid" uses Postgres lexical + vector hybrid search.'),
    git: storageGitSchema.prefault({}).describe('Git-backed storage commit policy.'),
  })
  .describe('Storage backends and commit policy for ktx state and search indexes.');

const connectionSchema = connectionConfigSchema;

const agentSchema = z
  .strictObject({
    run_research: z
      .strictObject({
        enabled: z.boolean().default(false).describe('Master switch for the research agent.'),
        max_iterations: z
          .number()
          .int()
          .nonnegative()
          .default(20)
          .describe('Maximum number of tool-call iterations the research agent may take per run.'),
        default_toolset: z
          .array(z.string().min(1))
          .default(['sl_query', 'wiki_search', 'sl_read_source'])
          .describe('Default list of tool identifiers exposed to the research agent.'),
      })
      .prefault({})
      .describe('Research-agent configuration.'),
  })
  .describe('Agent feature configuration.');

const ktxProjectConfigSchema = z
  .strictObject({
    setup: setupSchema.optional().describe('Setup-wizard state. Written by `ktx setup`; may be omitted.'),
    connections: z
      .record(z.string(), connectionSchema)
      .default({})
      .describe('Map of connection ID to connector configuration. Keys are user-chosen names referenced elsewhere in the config.'),
    storage: storageSchema.prefault({}).describe('Storage backends and commit policy for ktx state and search indexes.'),
    llm: llmSchema.prefault({}).describe('LLM provider, per-role model overrides, and prompt-caching tunables.'),
    ingest: ingestSchema.prefault({}).describe('Ingest pipeline configuration.'),
    agent: agentSchema.prefault({}).describe('Agent feature configuration.'),
    scan: scanSchema.prefault({}).describe('Schema-scan configuration: enrichment and relationship discovery.'),
  })
  .describe('Configuration schema for ktx project files (ktx.yaml).');

export type KtxProjectConfig = z.infer<typeof ktxProjectConfigSchema>;
export type KtxProjectLlmConfig = z.infer<typeof llmSchema>;
export type KtxProjectEmbeddingConfig = z.infer<typeof embeddingSchema>;
export type KtxScanEnrichmentConfig = z.infer<typeof scanEnrichmentSchema>;
export type KtxScanRelationshipConfig = z.infer<typeof scanRelationshipsSchema>;
export type KtxProjectConnectionConfig = z.infer<typeof connectionSchema>;

export interface KtxConfigIssue {
  path: string;
  message: string;
  fix?: string;
  /**
   * 'error' blocks the project (bad value on a recognized field); 'warning' is
   * a condition the loader recovers from on its own (an ignored unknown key).
   */
  severity: 'error' | 'warning';
}

export interface KtxConfigValidation {
  ok: boolean;
  issues: KtxConfigIssue[];
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function dottedPath(path: ReadonlyArray<PropertyKey>): string {
  return path.map((segment) => String(segment)).join('.');
}

function valueAtPath(root: unknown, path: ReadonlyArray<PropertyKey>): unknown {
  let cursor: unknown = root;
  for (const segment of path) {
    if (cursor === null || typeof cursor !== 'object') return undefined;
    cursor = (cursor as Record<PropertyKey, unknown>)[segment];
  }
  return cursor;
}

interface UnknownKeyLocation {
  containerPath: ReadonlyArray<PropertyKey>;
  key: string;
}

/**
 * Zod reports unknown keys in two shapes: strict objects emit
 * `unrecognized_keys` (path → container, `keys` → offenders), enum-keyed
 * records (`llm.models`) emit one `invalid_key` per offender (path ends with
 * the key). Normalize both so the warning report and the strip always agree.
 */
function unknownKeyLocations(issue: z.core.$ZodIssue): UnknownKeyLocation[] {
  if (issue.code === 'unrecognized_keys') {
    return issue.keys.map((key) => ({ containerPath: issue.path, key }));
  }
  if (issue.code === 'invalid_key' && issue.path.length > 0) {
    return [
      {
        containerPath: issue.path.slice(0, -1),
        key: String(issue.path[issue.path.length - 1]),
      },
    ];
  }
  return [];
}

function formatIssue(issue: z.core.$ZodIssue, input: unknown): KtxConfigIssue[] {
  const unknownKeys = unknownKeyLocations(issue);
  if (unknownKeys.length > 0) {
    return unknownKeys.map(({ containerPath, key }) => {
      const base = dottedPath(containerPath);
      const fullPath = base.length > 0 ? `${base}.${key}` : key;
      return {
        path: fullPath,
        message: `Unsupported ${fullPath}: unknown field (ignored)`,
        fix: 'Unknown to this ktx version; it is ignored. Delete it from ktx.yaml when convenient.',
        severity: 'warning',
      };
    });
  }

  const basePath = dottedPath(issue.path);
  const lastSegment = issue.path[issue.path.length - 1];
  if (lastSegment === 'backend' && (issue.code === 'invalid_value' || issue.code === 'invalid_type')) {
    const value = valueAtPath(input, issue.path);
    return [{ path: basePath, message: `Unsupported ${basePath}: ${String(value)}`, severity: 'error' }];
  }

  return [
    {
      path: basePath,
      message: basePath.length > 0 ? `${basePath}: ${issue.message}` : issue.message,
      severity: 'error',
    },
  ];
}

function collectIssues(error: z.ZodError, input: unknown): KtxConfigIssue[] {
  return error.issues.flatMap((issue) => formatIssue(issue, input));
}

function formatZodError(error: z.ZodError, input: unknown): string {
  return collectIssues(error, input)
    .map((issue) => issue.message)
    .join('\n');
}

export function buildDefaultKtxProjectConfig(): KtxProjectConfig {
  return ktxProjectConfigSchema.parse({});
}

function stripUnrecognizedKeys(input: Record<string, unknown>): Record<string, unknown> {
  const result = ktxProjectConfigSchema.safeParse(input);
  if (result.success) {
    return input;
  }
  const unknownKeys = result.error.issues.flatMap(unknownKeyLocations);
  if (unknownKeys.length === 0) {
    return input;
  }
  const value = structuredClone(input);
  for (const { containerPath, key } of unknownKeys) {
    const container = valueAtPath(value, containerPath);
    if (container === null || typeof container !== 'object') continue;
    delete (container as Record<string, unknown>)[key];
  }
  return value;
}

function parseTolerant(input: Record<string, unknown>): KtxProjectConfig {
  const value = stripUnrecognizedKeys(input);
  const result = ktxProjectConfigSchema.safeParse(value);
  if (!result.success) {
    throw new Error(formatZodError(result.error, value));
  }
  return result.data;
}

/**
 * Parse and validate a ktx.yaml document. Keys this ktx version does not
 * recognize are stripped from the returned config — never from the file, which
 * a load must not rewrite — so a config written by a different ktx version
 * still loads. Malformed values on recognized fields still throw.
 */
export function parseKtxProjectConfig(raw: string): KtxProjectConfig {
  const parsed = YAML.parse(raw) as unknown;
  if (!isRecord(parsed)) {
    throw new Error('ktx.yaml must contain a YAML object');
  }
  return parseTolerant(parsed);
}

export function validateKtxProjectConfig(raw: string): KtxConfigValidation {
  let parsed: unknown;
  try {
    parsed = YAML.parse(raw);
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    return { ok: false, issues: [{ path: '', message: `ktx.yaml parse error: ${message}`, severity: 'error' }] };
  }
  if (!isRecord(parsed)) {
    return { ok: false, issues: [{ path: '', message: 'ktx.yaml must contain a YAML object', severity: 'error' }] };
  }
  const result = ktxProjectConfigSchema.safeParse(parsed);
  if (result.success) {
    return { ok: true, issues: [] };
  }
  const issues = collectIssues(result.error, parsed);
  const ok = !issues.some((issue) => issue.severity === 'error');
  return { ok, issues };
}

export function generateKtxProjectConfigJsonSchema(): Record<string, unknown> {
  const schema = z.toJSONSchema(ktxProjectConfigSchema, {
    target: 'draft-7',
    io: 'input',
  }) as Record<string, unknown>;
  return {
    $schema: 'http://json-schema.org/draft-07/schema#',
    $id: 'https://ktx.dev/schemas/ktx-project-config.json',
    title: 'ktx.yaml',
    ...schema,
  };
}

export function serializeKtxProjectConfig(config: KtxProjectConfig): string {
  const serializedConfig =
    config.ingest.adapters.length === 0
      ? {
          ...config,
          ingest: {
            embeddings: config.ingest.embeddings,
            workUnits: config.ingest.workUnits,
          },
        }
      : config;
  return `${YAML.stringify(serializedConfig, { indent: 2, lineWidth: 0 }).trimEnd()}\n`;
}
