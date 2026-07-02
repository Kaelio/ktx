import type { KtxModelRole } from '../../llm/types.js';
import type { KtxEmbeddingPort } from '../core/embedding.js';
import type { GitService } from '../../context/core/git.service.js';
import type { KtxFileStorePort } from '../../context/core/file-store.js';
import type { KtxLogger } from '../../context/core/config.js';
import type { SessionOutcome } from '../../context/core/session-worktree.service.js';
import type { AgentRunnerPort, KtxLlmRuntimePort, KtxRuntimeToolSet } from '../../context/llm/runtime-port.js';
import type { RateLimitGovernor } from '../llm/rate-limit-governor.js';
import type { MemoryAction, MemoryKnowledgeSlRefsPort } from '../../context/memory/types.js';
import type { PromptService } from '../../context/prompts/prompt.service.js';
import type { SkillsRegistryService } from '../../context/skills/skills-registry.service.js';
import type { SemanticLayerService } from '../../context/sl/semantic-layer.service.js';
import type { SlConnectionCatalogPort, SlSourcesIndexPort } from '../../context/sl/ports.js';
import type { SlSearchService } from '../../context/sl/sl-search.service.js';
import type { SlValidationDeps } from '../../context/sl/tools/sl-warehouse-validation.js';
import type { SlValidatorPort } from '../../context/sl/sl-validator.port.js';
import type { ToolContext } from '../../context/tools/base-tool.js';
import type { ToolSession } from '../../context/tools/tool-session.js';
import type { KnowledgeIndexPort } from '../../context/wiki/ports.js';
import type { KnowledgeWikiService } from '../../context/wiki/knowledge-wiki.service.js';
import type { ContentResultCache } from '../cache/content-result-cache.js';
import type { CanonicalPin } from './canonical-pins.js';
import type { IngestTraceLevel } from './ingest-trace.js';
import type { IngestReportSnapshot } from './reports.js';
import type {
  ReconcileCandidateForPrompt,
  ReconcileCandidateSummary,
  ReconcilePromptRunState,
} from './stages/build-reconcile-context.js';
import type { ReconciliationOutcome } from './stages/stage-4-reconciliation.js';
import type { StageIndex } from './stages/stage-index.types.js';
import type {
  DiffSet,
  EvictionUnit,
  IngestDiffSummary,
  IngestTrigger,
  SourceAdapter,
} from './types.js';

type JsonPrimitive = string | number | boolean | null;
export type JsonValue = JsonPrimitive | JsonValue[] | { [key: string]: JsonValue | undefined };

export interface IngestRunRecord {
  id: string;
}

export interface CreateIngestRunArgs {
  jobId: string;
  connectionId: string;
  sourceKey: string;
  syncId: string;
  trigger: IngestTrigger;
  scopeFingerprint?: string | null;
}

export interface IngestRunsPort {
  create(args: CreateIngestRunArgs): Promise<IngestRunRecord>;
  markCompleted(id: string, diffSummary: IngestDiffSummary, status?: 'completed' | 'partial'): Promise<void>;
  markFailed(id: string): Promise<void>;
}

export type ProvenanceActionType =
  | 'source_created'
  | 'measure_added'
  | 'join_added'
  | 'merged'
  | 'subsumed'
  | 'wiki_written'
  | 'skipped';

export interface IngestProvenanceInsert {
  connectionId: string;
  sourceKey: string;
  syncId: string;
  rawPath: string;
  rawContentHash: string;
  artifactKind: 'sl' | 'wiki' | null;
  artifactKey: string | null;
  targetConnectionId?: string | null;
  artifactContentHash: string | null;
  actionType: ProvenanceActionType;
}

export interface IngestProvenanceRow {
  sync_id: string;
  raw_path: string;
  raw_content_hash: string;
  artifact_kind: 'sl' | 'wiki' | null;
  artifact_key: string | null;
  target_connection_id: string | null;
  artifact_content_hash: string | null;
  action_type: ProvenanceActionType;
}

export interface IngestProvenancePort {
  insertMany(rows: IngestProvenanceInsert[]): Promise<void>;
  findLatestHashesForCompletedSyncs(connectionId: string, sourceKey: string): Promise<Map<string, string>>;
  findLatestArtifactsForRawPaths(
    connectionId: string,
    sourceKey: string,
    rawPaths: string[],
  ): Promise<Map<string, IngestProvenanceRow[]>>;
}

export interface IngestReportsPort {
  create(args: {
    runId: string;
    jobId: string;
    connectionId: string;
    sourceKey: string;
    body: unknown;
  }): Promise<unknown>;
  findByJobId(jobId: string): Promise<IngestReportSnapshot | null>;
  findReportByAnyId?(id: string): Promise<IngestReportSnapshot | null>;
  markSuperseded(jobId: string, supersededByJobId: string): Promise<void>;
}

export interface IngestCanonicalPinsPort {
  listPins(connectionIds: string[]): Promise<CanonicalPin[]>;
}

export interface IngestLockPort {
  withLock<T>(key: string, fn: () => Promise<T>): Promise<T>;
}

interface IngestFileStorePort extends KtxFileStorePort<IngestFileStorePort> {}

export interface IngestSessionWorktree {
  chatId: string;
  workdir: string;
  branch: string;
  baseSha: string;
  createdAt: Date;
  git: GitService;
  config: IngestFileStorePort;
}

export interface IngestSessionWorktreePort {
  create(sessionKey: string, baseSha: string): Promise<IngestSessionWorktree>;
  cleanup(session: IngestSessionWorktree, outcome: SessionOutcome): Promise<void>;
}

interface IngestSettingsPort {
  memoryIngestionModel: string;
  cliVersion: string;
  probeRowCount: number;
  workUnitMaxConcurrency?: number;
  workUnitStepBudget?: number;
  workUnitFailureMode?: 'abort' | 'continue';
  rateLimitGovernor?: RateLimitGovernor;
  /** Print a timing breakdown to stderr at the end of each run (config-driven; see also KTX_PROFILE_INGEST). `'json'` emits the raw structured profile. */
  profileIngest?: boolean | 'json';
  ingestTraceLevel?: IngestTraceLevel;
}

interface IngestGitAuthor {
  name: string;
  email: string;
}

export interface IngestStoragePort {
  homeDir: string;
  systemGitAuthor: IngestGitAuthor;
  resolveUploadDir(uploadId: string): string;
  resolvePullDir(jobId: string): string;
  resolveTranscriptDir(jobId: string): string;
  resolveTracePath(jobId: string): string;
}

export interface IngestCommitMessagePort {
  enqueueForExternalCommit(args: { commitHash: string }, message: string, pathFilter: string): Promise<void>;
}

export interface IngestToolsetLike {
  toRuntimeTools(context: ToolContext): KtxRuntimeToolSet;
}

export interface IngestToolsetFactoryPort {
  createIngestWuToolset(session: ToolSession, options?: { includeContextEvidenceTools?: boolean }): IngestToolsetLike;
}

type IngestKnowledgeIndexPort = Pick<KnowledgeIndexPort, 'listPagesForUser'>;

export interface SourceAdapterRegistryPort {
  register(adapter: SourceAdapter): void;
  get(sourceKey: string): SourceAdapter;
  has(sourceKey: string): boolean;
  list(): string[];
}

interface DiffSetComputerPort {
  compute(
    connectionId: string,
    sourceKey: string,
    currentHashes: Map<string, string>,
    isPathInScope?: (rawPath: string) => boolean,
  ): Promise<{
    added: string[];
    modified: string[];
    deleted: string[];
    unchanged: string[];
  }>;
}

export interface ContextEvidenceIndexSummary {
  documentsIndexed: number;
  chunksIndexed: number;
  documentsDeleted: number;
  embeddingFailures: number;
  warnings: string[];
}

interface ContextEvidenceIndexPort {
  indexStagedDir(args: {
    stagedDir: string;
    runId: string;
    connectionId: string;
    sourceKey: string;
    syncId: string;
    diffSet: DiffSet;
    currentHashes: Map<string, string>;
  }): Promise<ContextEvidenceIndexSummary>;
  publishSync(args: { connectionId: string; sourceKey: string; syncId: string; diffSet: DiffSet }): Promise<unknown>;
}

export interface PageTriageRunResult {
  enabled: boolean;
  report?: {
    pageCount: number;
    skip: number;
    light: number;
    full: number;
    classifierFailures: number;
    lightExtractionFailures: number;
  };
  fullRawPaths: Set<string>;
  warnings: string[];
}

interface PageTriagePort {
  triageRun(args: {
    stagedDir: string;
    runId: string;
    connectionId: string;
    sourceKey: string;
    syncId: string;
    jobId: string;
    diffSet: DiffSet;
    adapter: SourceAdapter;
  }): Promise<PageTriageRunResult>;
}

interface ContextCandidateCarryforwardPort {
  carryForward(args: { runId: string; connectionId: string; sourceKey: string }): Promise<{ warnings: string[] }>;
}

export interface ContextCandidateForDedup {
  id: string;
  candidateKey: string;
  topic: string;
  assertion: string;
  promotionScore: number;
  createdAt: Date;
  evidenceChunkIds: string[];
  evidenceRefs: JsonValue;
  embedding: string | null;
  lane: 'light' | 'full' | null;
}

export interface CandidateDedupResult {
  enabled: boolean;
  candidatesIn: number;
  clustersOut: number;
  mergedCount: number;
  largestClusterSize: number;
  embeddingFailures: number;
  representatives: ContextCandidateForDedup[];
  warnings: string[];
}

interface CandidateDedupPort {
  deduplicateRun(runId: string): Promise<CandidateDedupResult>;
}

export interface ContextCandidateSummary {
  total: number;
  pending: number;
  promoted: number;
  merged: number;
  rejected: number;
  conflict: number;
}

interface ContextEvidenceCandidatesPort {
  getCandidateSummary(runId: string): Promise<ContextCandidateSummary>;
}

export interface CuratorPaginationReport {
  passesRun: number;
  topicsExamined: number;
  topicsByVerdict: {
    promoted: number;
    merged: number;
    rejected: number;
    conflict: number;
  };
  topicsRejectedByReason: Record<string, number>;
  budgetExhausted: boolean;
}

export interface CuratorPaginationPort {
  reconcile(input: {
    runId: string;
    sourceKey: string;
    jobId: string;
    stageIndex: StageIndex;
    evictionUnit: EvictionUnit | undefined;
    representatives: ContextCandidateForDedup[];
    initialBudget: { creates: number; updates: number };
    modelRole: KtxModelRole;
    buildSystemPrompt: () => string;
    buildUserPrompt: (input: {
      summary: ReconcileCandidateSummary;
      items: ReconcileCandidateForPrompt[];
      runState: ReconcilePromptRunState;
    }) => string;
    buildToolSet: (passNumber: number) => KtxRuntimeToolSet;
    getReconciliationActions: () => MemoryAction[];
    abortSignal?: AbortSignal;
  }): Promise<ReconciliationOutcome & { report: CuratorPaginationReport; warnings: string[] }>;
}

export interface IngestBundleRunnerDeps {
  runs: IngestRunsPort;
  provenance: IngestProvenancePort;
  reports: IngestReportsPort;
  canonicalPins: IngestCanonicalPinsPort;
  contentCache: ContentResultCache;
  registry: SourceAdapterRegistryPort;
  diffSetService: DiffSetComputerPort;
  sessionWorktreeService: IngestSessionWorktreePort;
  agentRunner: AgentRunnerPort;
  llmRuntime?: KtxLlmRuntimePort;
  gitService: GitService;
  lockingService: IngestLockPort;
  storage: IngestStoragePort;
  settings: IngestSettingsPort;
  skillsRegistry: SkillsRegistryService;
  promptService: PromptService;
  wikiService: KnowledgeWikiService;
  knowledgeSlRefs?: MemoryKnowledgeSlRefsPort;
  knowledgeIndex?: IngestKnowledgeIndexPort;
  semanticLayerService: SemanticLayerService;
  slSearchService: SlSearchService;
  slSourcesRepository: SlSourcesIndexPort;
  connections: SlConnectionCatalogPort;
  slValidator: SlValidatorPort<SlValidationDeps>;
  toolsetFactory: IngestToolsetFactoryPort;
  commitMessages: IngestCommitMessagePort;
  embedding: KtxEmbeddingPort;
  contextEvidenceIndex?: ContextEvidenceIndexPort;
  pageTriage?: PageTriagePort;
  contextEvidenceCandidates?: ContextEvidenceCandidatesPort;
  candidateDedup?: CandidateDedupPort;
  contextCandidateCarryforward?: ContextCandidateCarryforwardPort;
  curatorPagination?: CuratorPaginationPort;
  logger?: KtxLogger;
}
