import type { KtxTableRefKey } from './table-ref.js';

export type KtxConnectionDriver =
  | 'sqlite'
  | 'duckdb'
  | 'postgres'
  | 'sqlserver'
  | 'bigquery'
  | 'snowflake'
  | 'mysql'
  | 'clickhouse'
  | 'mongodb';

/** Canonical scan-mode registry. Runtime validation derives its allowlist here. */
export const KTX_SCAN_MODES = ['structural', 'relationships', 'enriched'] as const;
export type KtxScanMode = (typeof KTX_SCAN_MODES)[number];

export type KtxScanTrigger = 'cli' | 'mcp' | 'schema_scan' | 'scheduled' | 'manual';

export interface KtxConnectorCapabilities {
  structuralIntrospection: true;
  tableSampling: boolean;
  columnSampling: boolean;
  columnStats: boolean;
  readOnlySql: boolean;
  nestedAnalysis: boolean;
  eventStreamDiscovery: boolean;
  formalForeignKeys: boolean;
  estimatedRowCounts: boolean;
}

export type KtxOptionalConnectorCapabilities = Partial<Omit<KtxConnectorCapabilities, 'structuralIntrospection'>>;

export function createKtxConnectorCapabilities(
  capabilities: KtxOptionalConnectorCapabilities = {},
): KtxConnectorCapabilities {
  return {
    structuralIntrospection: true,
    tableSampling: capabilities.tableSampling ?? false,
    columnSampling: capabilities.columnSampling ?? false,
    columnStats: capabilities.columnStats ?? false,
    readOnlySql: capabilities.readOnlySql ?? false,
    nestedAnalysis: capabilities.nestedAnalysis ?? false,
    eventStreamDiscovery: capabilities.eventStreamDiscovery ?? false,
    formalForeignKeys: capabilities.formalForeignKeys ?? false,
    estimatedRowCounts: capabilities.estimatedRowCounts ?? false,
  };
}

interface KtxSchemaScope {
  catalogs?: string[];
  schemas?: string[];
  datasets?: string[];
}

type KtxSchemaTableKind = 'table' | 'view' | 'external' | 'event_stream';

export type KtxSchemaDimensionType = 'time' | 'string' | 'number' | 'boolean';

export interface KtxSchemaColumn {
  name: string;
  nativeType: string;
  normalizedType: string;
  dimensionType: KtxSchemaDimensionType;
  nullable: boolean;
  primaryKey: boolean;
  comment: string | null;
}

export interface KtxSchemaForeignKey {
  fromColumn: string;
  toCatalog: string | null;
  toDb: string | null;
  toTable: string;
  toColumn: string;
  constraintName: string | null;
}

export interface KtxSchemaTable {
  catalog: string | null;
  db: string | null;
  name: string;
  kind: KtxSchemaTableKind;
  comment: string | null;
  estimatedRows: number | null;
  columns: KtxSchemaColumn[];
  foreignKeys: KtxSchemaForeignKey[];
}

export interface KtxSchemaSnapshot {
  connectionId: string;
  driver: KtxConnectionDriver;
  extractedAt: string;
  scope: KtxSchemaScope;
  tables: KtxSchemaTable[];
  metadata: Record<string, unknown>;
  warnings?: KtxScanWarning[];
}

interface KtxCredentialEnvReference {
  kind: 'env';
  name: string;
}

interface KtxCredentialFileReference {
  kind: 'file';
  path: string;
}

interface KtxResolvedCredentialEnvelope {
  kind: 'resolved';
  source: 'standalone' | 'host';
  values: Record<string, unknown>;
  redacted?: boolean;
}

export type KtxCredentialEnvelope =
  | KtxCredentialEnvReference
  | KtxCredentialFileReference
  | KtxResolvedCredentialEnvelope;

/** @internal */
export interface KtxNetworkEndpoint {
  host: string;
  port: number;
  close?: () => Promise<void>;
}

interface KtxNetworkTunnelRequest<TConnection = Record<string, unknown>> {
  connectionId: string;
  driver: KtxConnectionDriver;
  host: string;
  port: number;
  connection: TConnection;
}

/** @internal */
export interface KtxNetworkTunnelPort<TConnection = Record<string, unknown>> {
  resolveEndpoint(input: KtxNetworkTunnelRequest<TConnection>): Promise<KtxNetworkEndpoint | null>;
}

export interface KtxScanInput {
  connectionId: string;
  driver: KtxConnectionDriver;
  scope?: KtxSchemaScope;
  /**
   * Restricts introspection to a specific set of fully-qualified tables.
   * `undefined` means "all tables within {@link scope}". Connectors that honor
   * this field should push the filter into their metadata queries. Callers do
   * not post-filter, so a connector that ignores `tableScope` will over-fetch
   * and surface the extra tables in output.
   */
  tableScope?: ReadonlySet<KtxTableRefKey>;
  mode?: KtxScanMode;
  dryRun?: boolean;
  detectRelationships?: boolean;
  credentials?: KtxCredentialEnvelope;
  metadata?: Record<string, unknown>;
}

export interface KtxProgressUpdateOptions {
  transient?: boolean;
}

export interface KtxProgressPort {
  update(progress: number, message?: string, options?: KtxProgressUpdateOptions): Promise<void>;
  startPhase(weight: number): KtxProgressPort;
}

export interface KtxScanLoggerPort {
  debug(message: string, metadata?: Record<string, unknown>): void;
  info(message: string, metadata?: Record<string, unknown>): void;
  warn(message: string, metadata?: Record<string, unknown>): void;
  error(message: string, metadata?: Record<string, unknown>): void;
}

export interface KtxScanContext {
  runId: string;
  signal?: AbortSignal;
  progress?: KtxProgressPort;
  logger?: KtxScanLoggerPort;
}

export interface KtxTableRef {
  catalog: string | null;
  db: string | null;
  name: string;
}

export interface KtxTableSampleInput {
  connectionId: string;
  table: KtxTableRef;
  columns?: string[];
  limit: number;
}

export interface KtxTableSampleResult {
  headers: string[];
  rows: unknown[][];
  totalRows: number;
}

export interface KtxColumnSampleInput {
  connectionId: string;
  table: KtxTableRef;
  column: string;
  limit: number;
}

export interface KtxColumnSampleResult {
  values: unknown[];
  nullCount: number | null;
  distinctCount: number | null;
}

export interface KtxColumnStatsInput {
  connectionId: string;
  table: KtxTableRef;
  column: string;
}

export interface KtxColumnStatsResult {
  min: unknown;
  max: unknown;
  average: number | null;
  nullCount: number | null;
  distinctCount: number | null;
}

/** @internal */
export interface KtxEventTypeDiscoveryInput {
  connectionId: string;
  table: KtxTableRef;
  eventColumn: string;
  limit: number;
  minCount?: number;
  lookbackDays?: number;
}

/** @internal */
export interface KtxEventTypeDiscovery {
  value: string;
  count: number;
}

/** @internal */
export interface KtxEventPropertyDiscoveryInput {
  connectionId: string;
  table: KtxTableRef;
  jsonColumn: string;
  sampleSize: number;
  limit: number;
  lookbackDays?: number;
}

/** @internal */
export interface KtxEventPropertyDiscovery {
  key: string;
  count: number;
}

/** @internal */
export interface KtxEventPropertyValuesInput {
  connectionId: string;
  table: KtxTableRef;
  jsonColumn: string;
  propertyKey: string;
  limit: number;
  maxCardinality?: number;
  lookbackDays?: number;
}

/** @internal */
export interface KtxEventPropertyValuesResult {
  values: string[];
  cardinality: number;
}

/** @internal */
export interface KtxEventStreamDiscoveryPort {
  listEventTypes(input: KtxEventTypeDiscoveryInput, ctx: KtxScanContext): Promise<KtxEventTypeDiscovery[]>;
  listPropertyKeys(input: KtxEventPropertyDiscoveryInput, ctx: KtxScanContext): Promise<KtxEventPropertyDiscovery[]>;
  listPropertyValues(
    input: KtxEventPropertyValuesInput,
    ctx: KtxScanContext,
  ): Promise<KtxEventPropertyValuesResult | null>;
}

export interface KtxReadOnlyQueryInput {
  connectionId: string;
  sql: string;
  maxRows?: number;
}

export interface KtxQueryResult {
  headers: string[];
  headerTypes?: string[];
  rows: unknown[][];
  totalRows: number;
  rowCount: number | null;
}

export interface KtxTableListEntry {
  catalog: string | null;
  schema: string;
  name: string;
  kind: 'table' | 'view';
}

export interface KtxConnectorTestResult {
  success: boolean;
  error?: string;
  /**
   * The original error thrown by the driver, preserved unflattened so the
   * connection-test path can re-throw it. Keeping the real error object lets
   * telemetry record the driver's actual error class (e.g. `ConnectionError`)
   * and `.code` (e.g. `ELOGIN`) instead of collapsing every failure to `Error`.
   */
  cause?: unknown;
}

/**
 * Single source of truth for a failed connector test result. Captures the
 * driver's message for display while preserving the original error as `cause`
 * so callers can surface its real class and code.
 */
export function connectorTestFailure(error: unknown): KtxConnectorTestResult {
  return {
    success: false,
    error: error instanceof Error ? error.message : String(error),
    cause: error,
  };
}

export interface KtxScanConnector {
  id: string;
  driver: KtxConnectionDriver;
  capabilities: KtxConnectorCapabilities;
  eventStreamDiscovery?: KtxEventStreamDiscoveryPort;
  introspect(input: KtxScanInput, ctx: KtxScanContext): Promise<KtxSchemaSnapshot>;
  listSchemas(): Promise<string[]>;
  listTables(schemas?: string[]): Promise<KtxTableListEntry[]>;
  testConnection?(): Promise<KtxConnectorTestResult>;
  sampleColumn?(input: KtxColumnSampleInput, ctx: KtxScanContext): Promise<KtxColumnSampleResult>;
  sampleTable?(input: KtxTableSampleInput, ctx: KtxScanContext): Promise<KtxTableSampleResult>;
  columnStats?(input: KtxColumnStatsInput, ctx: KtxScanContext): Promise<KtxColumnStatsResult | null>;
  executeReadOnly?(input: KtxReadOnlyQueryInput, ctx: KtxScanContext): Promise<KtxQueryResult>;
  cleanup?(): Promise<void>;
}

export interface KtxEmbeddingPort {
  dimensions: number;
  maxBatchSize: number;
  embedBatch(texts: string[]): Promise<number[][]>;
}

interface KtxStructuralSyncStats {
  tablesCreated: number;
  tablesUpdated: number;
  tablesDeleted: number;
  columnsCreated: number;
  columnsUpdated: number;
  columnsDeleted: number;
}

interface KtxScanDiffSummary {
  tablesAdded: number;
  tablesModified: number;
  tablesDeleted: number;
  tablesUnchanged: number;
  columnsAdded: number;
  columnsModified: number;
  columnsDeleted: number;
}

interface KtxScanArtifactPaths {
  rawSourcesDir: string | null;
  reportPath: string | null;
  manifestShards: string[];
  enrichmentArtifacts: string[];
}

type KtxScanWarningCode =
  | 'connector_capability_missing'
  | 'sampling_failed'
  | 'statistics_failed'
  | 'llm_unavailable'
  | 'embedding_unavailable'
  | 'scan_enrichment_backend_not_configured'
  | 'relationship_validation_failed'
  | 'relationship_detection_partial'
  | 'enrichment_stage_skipped'
  | 'enrichment_stage_stale'
  | 'relationship_llm_invalid_reference'
  | 'relationship_llm_proposal_failed'
  | 'credential_redacted'
  | 'enrichment_failed'
  | 'enrichment_timeout'
  | 'description_fallback_used'
  | 'constraint_discovery_unauthorized'
  | 'object_introspection_failed';

export interface KtxScanWarning {
  code: KtxScanWarningCode;
  message: string;
  table?: string;
  column?: string;
  recoverable: boolean;
  metadata?: Record<string, unknown>;
}

export interface KtxScanEnrichmentSummary {
  dataDictionary: 'skipped' | 'completed' | 'failed';
  tableDescriptions: 'skipped' | 'completed' | 'failed';
  columnDescriptions: 'skipped' | 'completed' | 'failed';
  embeddings: 'skipped' | 'completed' | 'failed';
  deterministicRelationships: 'skipped' | 'completed' | 'failed';
  llmRelationshipValidation: 'skipped' | 'completed' | 'failed';
  statisticalValidation: 'skipped' | 'completed' | 'failed';
}

export interface KtxScanRelationshipSummary {
  accepted: number;
  review: number;
  rejected: number;
  skipped: number;
}

export type KtxScanEnrichmentStage = 'descriptions' | 'embeddings' | 'relationships';

export interface KtxScanEnrichmentStateSummary {
  resumedStages: KtxScanEnrichmentStage[];
  completedStages: KtxScanEnrichmentStage[];
  failedStages: KtxScanEnrichmentStage[];
}

export interface KtxScanReport {
  connectionId: string;
  driver: KtxConnectionDriver;
  syncId: string;
  runId: string;
  trigger: KtxScanTrigger;
  mode: KtxScanMode;
  dryRun: boolean;
  artifactPaths: KtxScanArtifactPaths;
  diffSummary: KtxScanDiffSummary;
  manifestShardsWritten: number;
  structuralSyncStats: KtxStructuralSyncStats;
  enrichment: KtxScanEnrichmentSummary;
  capabilityGaps: Array<keyof Omit<KtxConnectorCapabilities, 'structuralIntrospection'>>;
  warnings: KtxScanWarning[];
  relationships: KtxScanRelationshipSummary;
  enrichmentState: KtxScanEnrichmentStateSummary;
  createdAt: string;
}
