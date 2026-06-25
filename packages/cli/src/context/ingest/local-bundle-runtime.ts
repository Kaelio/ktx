import { mkdirSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import YAML from 'yaml';
import { localConnectionInfoFromConfig } from '../../context/connections/local-warehouse-descriptor.js';
import type { KtxSqlQueryExecutorPort } from '../../context/connections/query-executor.js';
import type { SqlAnalysisPort } from '../../context/sql-analysis/ports.js';
import type { KtxEmbeddingPort } from '../../context/core/embedding.js';
import type { KtxLogger } from '../../context/core/config.js';
import { noopLogger } from '../../context/core/config.js';
import { SessionWorktreeService } from '../../context/core/session-worktree.service.js';
import type { KtxSemanticLayerComputePort } from '../../context/daemon/semantic-layer-compute.js';
import { createRuntimeToolDescriptorFromAiTool } from '../../context/llm/runtime-tools.js';
import { createLocalKtxLlmRuntimeFromConfig } from '../../context/llm/local-config.js';
import { KtxIngestEmbeddingPortAdapter } from '../../context/llm/embedding-port.js';
import { createRateLimitGovernorConfig, RateLimitGovernor } from '../../context/llm/rate-limit-governor.js';
import { RuntimeAgentRunner, type AgentRunnerPort, type KtxLlmRuntimePort, type KtxRuntimeToolSet } from '../../context/llm/runtime-port.js';
import { getKtxCliPackageInfo } from '../../cli-runtime.js';
import type { KtxEmbeddingProvider } from '../../llm/types.js';
import type { KtxLocalProject } from '../../context/project/project.js';
import { ktxLocalStateDbPath } from '../../context/project/local-state-db.js';
import { PromptService } from '../../context/prompts/prompt.service.js';
import { SkillsRegistryService } from '../../context/skills/skills-registry.service.js';
import type { KtxConnectionInfo, KtxQueryResult, SlConnectionCatalogPort, SlPythonPort, SlSourcesIndexPort } from '../../context/sl/ports.js';
import { SemanticLayerService } from '../../context/sl/semantic-layer.service.js';
import { SlDiscoverTool } from '../../context/sl/tools/sl-discover.tool.js';
import { SlEditSourceTool } from '../../context/sl/tools/sl-edit-source.tool.js';
import { SlReadSourceTool } from '../../context/sl/tools/sl-read-source.tool.js';
import { SlRollbackTool } from '../../context/sl/tools/sl-rollback.tool.js';
import { SlSearchService } from '../../context/sl/sl-search.service.js';
import { SlValidateTool } from '../../context/sl/tools/sl-validate.tool.js';
import type { SlValidationDeps } from '../../context/sl/tools/sl-warehouse-validation.js';
import type { SlValidatorPort } from '../../context/sl/sl-validator.port.js';
import { SlWriteSourceTool } from '../../context/sl/tools/sl-write-source.tool.js';
import { SqliteSlSourcesIndex } from '../../context/sl/sqlite-sl-sources-index.js';
import { sourceDefinitionSchema, sourceOverlaySchema } from '../../context/sl/schemas.js';
import { BaseTool, type ToolContext } from '../../context/tools/base-tool.js';
import { ContextCandidateMarkTool } from '../../context/tools/context-candidate-mark.tool.js';
import { ContextCandidateWriteTool } from '../../context/tools/context-candidate-write.tool.js';
import { ContextEvidenceNeighborsTool } from '../../context/tools/context-evidence-neighbors.tool.js';
import { ContextEvidenceReadTool } from '../../context/tools/context-evidence-read.tool.js';
import { ContextEvidenceSearchTool } from '../../context/tools/context-evidence-search.tool.js';
import type { GitAuthorResolverPort } from '../../context/tools/authors.js';
import type { ToolSession } from '../../context/tools/tool-session.js';
import { buildKnowledgeSearchText } from '../../context/wiki/knowledge-search-text.js';
import type { KnowledgeEventPort, KnowledgeIndexPort, KnowledgeIndexPageListing } from '../../context/wiki/ports.js';
import { KnowledgeWikiService } from '../../context/wiki/knowledge-wiki.service.js';
import { searchLocalKnowledgePages } from '../../context/wiki/local-knowledge.js';
import { SqliteKnowledgeIndex, type SqliteKnowledgeIndexPage } from '../../context/wiki/sqlite-knowledge-index.js';
import { WikiListTagsTool } from '../../context/wiki/tools/wiki-list-tags.tool.js';
import { WikiReadTool } from '../../context/wiki/tools/wiki-read.tool.js';
import { WikiRemoveTool } from '../../context/wiki/tools/wiki-remove.tool.js';
import { WikiSearchTool } from '../../context/wiki/tools/wiki-search.tool.js';
import { WikiWriteTool } from '../../context/wiki/tools/wiki-write.tool.js';
import { CandidateDedupService } from '../../context/ingest/context-candidates/candidate-dedup.service.js';
import { ContextCandidateCarryforwardService } from '../../context/ingest/context-candidates/context-candidate-carryforward.service.js';
import { CuratorPaginationService } from '../../context/ingest/context-candidates/curator-pagination.service.js';
import { SqliteContentResultCache } from '../cache/sqlite-content-result-cache.js';
import { createEmitHistoricSqlEvidenceTool } from './adapters/historic-sql/evidence-tool.js';
import { ContextEvidenceIndexService } from '../../context/ingest/context-evidence/context-evidence-index.service.js';
import { SqliteContextEvidenceStore } from '../../context/ingest/context-evidence/sqlite-context-evidence-store.js';
import { DiffSetService } from './diff-set.service.js';
import { ingestTracePathForJob, type IngestTraceLevel } from './ingest-trace.js';
import { IngestBundleRunner } from './ingest-bundle.runner.js';
import { PageTriageService } from '../../context/ingest/page-triage/page-triage.service.js';
import { createWarehouseVerificationTools } from '../../context/ingest/tools/warehouse-verification/create-warehouse-verification-tools.js';
import type {
  IngestBundleRunnerDeps,
  IngestCommitMessagePort,
  IngestLockPort,
  IngestStoragePort,
  IngestToolsetFactoryPort,
  IngestToolsetLike,
  SourceAdapterRegistryPort,
} from './ports.js';
import { SourceAdapterRegistry } from './source-adapter-registry.js';
import { SqliteBundleIngestStore } from './sqlite-bundle-ingest-store.js';
import type { SourceAdapter } from './types.js';

const promptsDir = fileURLToPath(new URL('../../prompts', import.meta.url));
const skillsDir = fileURLToPath(new URL('../../skills', import.meta.url));
const LOCAL_AUTHOR = { name: 'ktx Local', email: 'local@ktx.local' };
const LOCAL_SHAPE_WARNING = 'Local ingest validates semantic-layer YAML shape only.';
const INGEST_TRACE_LEVELS = new Set<IngestTraceLevel>(['error', 'info', 'debug', 'trace']);

function ingestTraceLevelFromEnv(env: NodeJS.ProcessEnv = process.env): IngestTraceLevel {
  const raw = env.KTX_INGEST_TRACE_LEVEL;
  return raw && INGEST_TRACE_LEVELS.has(raw as IngestTraceLevel) ? (raw as IngestTraceLevel) : 'debug';
}

export interface CreateLocalBundleIngestRuntimeOptions {
  project: KtxLocalProject;
  adapters: SourceAdapter[];
  agentRunner?: AgentRunnerPort;
  llmRuntime?: KtxLlmRuntimePort;
  createLlmRuntime?: typeof createLocalKtxLlmRuntimeFromConfig;
  llmDebugRequestFile?: string;
  memoryModel?: string;
  semanticLayerCompute?: KtxSemanticLayerComputePort;
  queryExecutor?: KtxSqlQueryExecutorPort;
  sqlAnalysis?: SqlAnalysisPort;
  jobIdFactory?: () => string;
  logger?: KtxLogger;
  embeddingProvider?: KtxEmbeddingProvider | null;
}

export interface LocalBundleIngestRuntime {
  runner: IngestBundleRunner;
  store: SqliteBundleIngestStore;
  contextStore: SqliteContextEvidenceStore;
  storage: IngestStoragePort;
  registry: SourceAdapterRegistryPort;
  nextJobId(): string;
}

class NoopEmbeddingPort implements KtxEmbeddingPort {
  readonly maxBatchSize = 64;

  async computeEmbedding(): Promise<number[]> {
    return [];
  }

  async computeEmbeddingsBulk(texts: string[]): Promise<number[][]> {
    return texts.map(() => []);
  }
}

class LocalIngestStorage implements IngestStoragePort {
  readonly homeDir: string;
  readonly systemGitAuthor = LOCAL_AUTHOR;

  constructor(private readonly project: KtxLocalProject) {
    this.homeDir = join(project.projectDir, '.ktx');
  }

  resolveUploadDir(uploadId: string): string {
    return join(this.project.projectDir, '.ktx/cache/local-ingest', uploadId, 'upload');
  }

  resolvePullDir(jobId: string): string {
    return join(this.project.projectDir, '.ktx/cache/local-ingest', jobId, 'pull');
  }

  resolveTranscriptDir(jobId: string): string {
    return join(this.project.projectDir, '.ktx/ingest-transcripts', jobId);
  }

  resolveTracePath(jobId: string): string {
    return ingestTracePathForJob(this.homeDir, jobId);
  }
}

class LocalIngestLock implements IngestLockPort {
  async withLock<T>(_key: string, fn: () => Promise<T>): Promise<T> {
    return fn();
  }
}

class LocalCommitMessagePort implements IngestCommitMessagePort {
  async enqueueForExternalCommit(): Promise<void> {}
}

class LocalAuthorResolver implements GitAuthorResolverPort {
  async resolve() {
    return LOCAL_AUTHOR;
  }
}

class LocalConnectionCatalog implements SlConnectionCatalogPort {
  constructor(
    private readonly project: KtxLocalProject,
    private readonly queryExecutor?: KtxSqlQueryExecutorPort,
  ) {}

  async listEnabledConnections(ids: string[]): Promise<KtxConnectionInfo[]> {
    return ids
      .map((id) => localConnectionInfoFromConfig(id, this.project.config.connections[id]))
      .filter((connection): connection is KtxConnectionInfo => connection !== null);
  }

  async getConnectionById(connectionId: string): Promise<KtxConnectionInfo> {
    const connection = localConnectionInfoFromConfig(connectionId, this.project.config.connections[connectionId]);
    if (!connection) {
      throw new Error(`Connection not found: ${connectionId}`);
    }
    return connection;
  }

  async executeQuery(connectionId: string, sql: string): Promise<KtxQueryResult> {
    if (!this.queryExecutor) {
      throw new Error('Local ingest has no query executor configured');
    }
    return this.queryExecutor.execute({
      connectionId,
      projectDir: this.project.projectDir,
      connection: this.project.config.connections[connectionId],
      sql,
    });
  }
}

class LocalSlPythonPort implements SlPythonPort {
  constructor(private readonly compute?: KtxSemanticLayerComputePort) {}

  async validateSources(input: Parameters<SlPythonPort['validateSources']>[0]) {
    if (!this.compute) {
      return { data: { errors: [], warnings: [LOCAL_SHAPE_WARNING], per_source_warnings: {} } };
    }
    const result = await this.compute.validateSources({
      sources: input.sources,
      dialect: input.dialect,
      recentlyTouched: input.recently_touched,
    });
    return {
      data: {
        errors: result.errors,
        warnings: result.warnings,
        per_source_warnings: result.perSourceWarnings,
      },
    };
  }

  async query(input: Parameters<SlPythonPort['query']>[0]) {
    if (!this.compute) {
      return { error: 'Local ingest has no semantic compute adapter configured' };
    }
    const result = await this.compute.query({
      sources: input.sources,
      dialect: input.dialect,
      query: input.query,
    });
    return { data: { sql: result.sql, plan: result.plan } };
  }
}

class LocalShapeOnlySlValidator implements SlValidatorPort<SlValidationDeps> {
  private validateParsedSource(sourceName: string, parsed: unknown) {
    const fields = (parsed ?? {}) as { table?: unknown; sql?: unknown };
    const isOverlay = fields.table == null && fields.sql == null;
    const result = (isOverlay ? sourceOverlaySchema : sourceDefinitionSchema).safeParse(parsed);
    return result.success
      ? { errors: [], warnings: [LOCAL_SHAPE_WARNING] }
      : {
          errors: result.error.issues.map(
            (issue) => `${sourceName}: ${issue.path.join('.') || 'source'} ${issue.message}`,
          ),
          warnings: [],
        };
  }

  private async validateComposedSource(
    deps: SlValidationDeps,
    connectionId: string,
    sourceName: string,
    readError: unknown,
  ) {
    try {
      const { sources, loadErrors } = await deps.semanticLayerService.loadAllSources(connectionId);
      const source = sources.find((candidate) => candidate.name === sourceName);
      if (source) {
        return this.validateParsedSource(sourceName, source);
      }
      const detail =
        loadErrors.length > 0
          ? loadErrors.join('; ')
          : readError instanceof Error
            ? readError.message
            : String(readError);
      return { errors: [`${sourceName}: ${detail}`], warnings: [] };
    } catch (fallbackError) {
      return {
        errors: [`${sourceName}: ${fallbackError instanceof Error ? fallbackError.message : String(fallbackError)}`],
        warnings: [],
      };
    }
  }

  async validateSingleSource(deps: SlValidationDeps, connectionId: string, sourceName: string) {
    const file = await deps.semanticLayerService.readSourceFile(connectionId, sourceName);
    if (!file) {
      return this.validateComposedSource(deps, connectionId, sourceName, 'no standalone or overlay file found');
    }

    try {
      const parsed = YAML.parse(file.content) as Record<string, unknown>;
      return this.validateParsedSource(sourceName, parsed);
    } catch (error) {
      return {
        errors: [`${sourceName}: invalid YAML — ${error instanceof Error ? error.message : String(error)}`],
        warnings: [],
      };
    }
  }
}

function parseWiki(raw: string): { summary: string; content: string } {
  const match = raw.match(/^---\n([\s\S]*?)\n---\n?([\s\S]*)$/);
  if (!match) {
    return { summary: '', content: raw.trim() };
  }
  const frontmatter = (YAML.parse(match[1]) ?? {}) as Record<string, unknown>;
  return {
    summary: typeof frontmatter.summary === 'string' ? frontmatter.summary : '',
    content: match[2].trim(),
  };
}

function parseWikiTags(raw: string): string[] {
  const match = raw.match(/^---\n([\s\S]*?)\n---\n?/);
  if (!match) {
    return [];
  }
  const frontmatter = (YAML.parse(match[1]) ?? {}) as Record<string, unknown>;
  return Array.isArray(frontmatter.tags)
    ? frontmatter.tags.filter((tag): tag is string => typeof tag === 'string')
    : [];
}

function scoreText(text: string, query: string): number {
  const normalized = query.toLowerCase().trim();
  if (!normalized) {
    return 0;
  }
  const haystack = text.toLowerCase();
  if (haystack.includes(normalized)) {
    return 1;
  }
  const words = normalized.split(/\s+/).filter(Boolean);
  return words.filter((word) => haystack.includes(word)).length / Math.max(words.length, 1);
}

class LocalKnowledgeIndex implements KnowledgeIndexPort {
  private readonly sqlite: SqliteKnowledgeIndex;

  constructor(
    private readonly project: KtxLocalProject,
    private readonly embedding: KtxEmbeddingPort,
  ) {
    this.sqlite = new SqliteKnowledgeIndex({ dbPath: ktxLocalStateDbPath(project) });
  }

  async upsertPage(): Promise<void> {
    await this.syncAllPagesFromDisk();
  }

  async applyDiffTransactional(): Promise<void> {
    await this.syncAllPagesFromDisk();
  }

  async getExistingSearchTexts(
    scope: string,
    scopeId: string | null,
  ): Promise<Map<string, { searchText: string; hasEmbedding: boolean }>> {
    const prefix = scope === 'GLOBAL' ? 'wiki/global/' : `wiki/user/${scopeId}/`;
    const result = new Map<string, { searchText: string; hasEmbedding: boolean }>();
    for (const [path, page] of this.sqlite.getExistingPages()) {
      if (!path.startsWith(prefix)) {
        continue;
      }
      result.set(path.slice(prefix.length).replace(/\.md$/, ''), {
        searchText: page.searchText,
        hasEmbedding: page.embedding !== null,
      });
    }
    return result;
  }

  async deleteStale(): Promise<number> {
    await this.syncAllPagesFromDisk();
    return 0;
  }

  async deleteByScope(): Promise<number> {
    await this.syncAllPagesFromDisk();
    return 0;
  }

  async deleteByKey(): Promise<number> {
    await this.syncAllPagesFromDisk();
    return 0;
  }

  async findPageByKey(scope: string, scopeId: string | null, pageKey: string) {
    const path = scope === 'GLOBAL' ? `wiki/global/${pageKey}.md` : `wiki/user/${scopeId}/${pageKey}.md`;
    try {
      await this.project.fileStore.readFile(path);
      return { page_key: pageKey };
    } catch {
      return null;
    }
  }

  async listPagesForUser(
    userId: string,
  ): Promise<KnowledgeIndexPageListing[]> {
    const pages: KnowledgeIndexPageListing[] = [];
    for (const scope of [
      { scope: 'GLOBAL', scopeId: null, dir: 'wiki/global' },
      { scope: 'USER', scopeId: userId, dir: `wiki/user/${userId}` },
    ]) {
      const listed = await this.project.fileStore.listFiles(scope.dir, true);
      for (const file of listed.files.filter((entry) => entry.endsWith('.md'))) {
        const parsedPath = parseKnowledgeIndexPath(file.startsWith('global/') || file.startsWith('user/') ? file : `${scope.dir.replace('wiki/', '')}/${file}`);
        if (!parsedPath || parsedPath.scope !== scope.scope) {
          continue;
        }
        const pageKey = parsedPath.pageKey;
        const raw = await this.project.fileStore.readFile(`${scope.dir}/${file}`);
        const parsed = parseWiki(raw.content);
        pages.push({
          page_key: pageKey,
          summary: parsed.summary,
          scope: scope.scope,
          scope_id: scope.scopeId,
          tags: parseWikiTags(raw.content),
        });
      }
    }
    return pages.sort((left, right) => left.page_key.localeCompare(right.page_key));
  }

  async getUserPageCount(userId: string): Promise<number> {
    return (await this.listPagesForUser(userId)).filter((page) => page.scope === 'USER').length;
  }

  async incrementUsageCount(): Promise<void> {}

  async searchRRF(
    userId: string,
    _embedding: number[] | null,
    queryText: string,
    limit: number,
  ): Promise<Array<{ pageKey: string; summary: string; rrfScore: number }>> {
    const pages = await this.listPagesForUser(userId);
    return pages
      .map((page) => ({
        pageKey: page.page_key,
        summary: page.summary,
        rrfScore: scoreText(`${page.page_key} ${page.summary}`, queryText),
      }))
      .filter((page) => page.rrfScore > 0)
      .sort((left, right) => right.rrfScore - left.rrfScore || left.pageKey.localeCompare(right.pageKey))
      .slice(0, limit);
  }

  private async syncAllPagesFromDisk(): Promise<void> {
    const listed = await this.project.fileStore.listFiles('wiki', true);
    const existingPages = this.sqlite.getExistingPages();
    const pages: SqliteKnowledgeIndexPage[] = [];
    for (const file of listed.files.filter((entry) => entry.endsWith('.md'))) {
      const parsedPath = parseKnowledgeIndexPath(file);
      if (!parsedPath) {
        continue;
      }
      const path = `wiki/${file}`;
      const raw = await this.project.fileStore.readFile(path);
      const parsed = parseWiki(raw.content);
      const tags = parseWikiTags(raw.content);
      const searchText = buildKnowledgeSearchText(parsedPath.pageKey, parsed.summary, parsed.content, tags);
      const existing = existingPages.get(path);
      const embedding =
        existing?.searchText === searchText && existing.embedding
          ? existing.embedding
          : await this.embedding.computeEmbedding(searchText).catch(() => null);
      pages.push({
        path,
        key: parsedPath.pageKey,
        scope: parsedPath.scope,
        summary: parsed.summary,
        content: parsed.content,
        tags,
        embedding,
      });
    }
    this.sqlite.sync(pages);
  }
}

function parseKnowledgeIndexPath(file: string): { scope: 'GLOBAL' | 'USER'; pageKey: string } | null {
  const segments = file.split('/');
  if (segments.length === 2 && segments[0] === 'global') {
    const pageKey = segments[1].replace(/\.md$/, '');
    return /^[a-zA-Z0-9_][a-zA-Z0-9_-]*$/.test(pageKey) ? { scope: 'GLOBAL', pageKey } : null;
  }
  if (segments.length === 3 && segments[0] === 'user') {
    const pageKey = segments[2].replace(/\.md$/, '');
    return /^[a-zA-Z0-9_][a-zA-Z0-9_-]*$/.test(pageKey) ? { scope: 'USER', pageKey } : null;
  }
  return null;
}

class NoopKnowledgeEventPort implements KnowledgeEventPort {
  async createEvent(): Promise<void> {}
}

class LocalIngestToolSet implements IngestToolsetLike {
  constructor(
    private readonly tools: BaseTool[],
    private readonly sourceTools: KtxRuntimeToolSet = {},
  ) {}

  toRuntimeTools(context: ToolContext): KtxRuntimeToolSet {
    return {
      ...Object.fromEntries(this.tools.map((tool) => [tool.name, tool.toRuntimeTool(context)])),
      ...this.sourceTools,
    };
  }
}

class LocalIngestToolsetFactory implements IngestToolsetFactoryPort {
  private readonly baseTools: BaseTool[];
  private readonly contextTools: BaseTool[];

  constructor(deps: {
    project: KtxLocalProject;
    wikiService: KnowledgeWikiService;
    knowledgeIndex: KnowledgeIndexPort;
    knowledgeEvents: KnowledgeEventPort;
    semanticLayerService: SemanticLayerService;
    slSearchService: SlSearchService;
    authorResolver: GitAuthorResolverPort;
    slSourcesRepository: SlSourcesIndexPort;
    connections: SlConnectionCatalogPort;
    sqlAnalysis?: SqlAnalysisPort;
    contextStore: SqliteContextEvidenceStore;
    embedding: KtxEmbeddingPort;
  }) {
    const slDeps = {
      semanticLayerService: deps.semanticLayerService,
      slSearchService: deps.slSearchService,
      authorResolver: deps.authorResolver,
    };
    const wikiSearchTool = new WikiSearchTool({
      search: async (input) => {
        const results = await searchLocalKnowledgePages(deps.project, {
          userId: input.userId,
          query: input.query,
          limit: input.limit,
          embeddingService: deps.embedding,
        });
        return {
          results: results.slice(0, input.limit).map((result) => ({
            key: result.key,
            path: result.path,
            summary: result.summary,
            score: result.score,
            matchReasons: result.matchReasons,
            lanes: result.lanes,
          })),
          totalFound: results.length,
        };
      },
    });
    const slDiscoverTool = new SlDiscoverTool(slDeps, { maxSources: 25, minRrfScore: 0, maxDetailedSources: 5 });
    const warehouseVerificationTools = createWarehouseVerificationTools({
      connections: deps.connections,
      ...(deps.sqlAnalysis ? { sqlAnalysis: deps.sqlAnalysis } : {}),
      fallbackFileStore: deps.project.fileStore,
      wikiSearchTool,
      slDiscoverTool,
    });
    this.baseTools = [
      new WikiReadTool(deps.wikiService, deps.knowledgeIndex),
      wikiSearchTool,
      new WikiListTagsTool(deps.knowledgeIndex),
      new WikiWriteTool(deps.wikiService, deps.knowledgeIndex, deps.knowledgeEvents),
      new WikiRemoveTool(deps.wikiService, deps.knowledgeIndex, deps.knowledgeEvents),
      slDiscoverTool,
      new SlEditSourceTool(slDeps),
      new SlReadSourceTool(slDeps),
      new SlWriteSourceTool(slDeps),
      new SlValidateTool(slDeps),
      new SlRollbackTool(deps.slSourcesRepository, deps.connections, 0),
      ...warehouseVerificationTools,
    ];
    this.contextTools = [
      new ContextEvidenceSearchTool(deps.contextStore, deps.embedding),
      new ContextEvidenceReadTool(deps.contextStore),
      new ContextEvidenceNeighborsTool(deps.contextStore),
      new ContextCandidateWriteTool(deps.contextStore, deps.embedding),
      new ContextCandidateMarkTool(deps.contextStore),
    ];
  }

  createIngestWuToolset(session: ToolSession, options?: { includeContextEvidenceTools?: boolean }): IngestToolsetLike {
    const sourceTools: KtxRuntimeToolSet =
      session.ingest?.sourceKey === 'historic-sql'
        ? {
            emit_historic_sql_evidence: createRuntimeToolDescriptorFromAiTool(
              'emit_historic_sql_evidence',
              createEmitHistoricSqlEvidenceTool({
                connectionId: session.connectionId,
                session,
              }),
            ),
          }
        : {};
    return new LocalIngestToolSet(
      options?.includeContextEvidenceTools ? [...this.baseTools, ...this.contextTools] : this.baseTools,
      sourceTools,
    );
  }
}

function registerAdapters(adapters: SourceAdapter[]): SourceAdapterRegistry {
  const registry = new SourceAdapterRegistry();
  for (const adapter of adapters) {
    registry.register(adapter);
  }
  return registry;
}

function nextLocalJobId(): string {
  return `local-${Date.now().toString(36)}`;
}

function localIngestLlmProviderGuardMessage(projectDir: string): string {
  return [
    'ktx ingest requires llm.provider.backend: anthropic, vertex, gateway, claude-code, or codex, or an injected agentRunner.',
    'Configure a local Claude Code/Codex session or API-backed LLM, then rerun ingest:',
    `  ktx setup --project-dir ${projectDir} --llm-backend claude-code --no-input`,
    `  ktx setup --project-dir ${projectDir} --llm-backend codex --no-input`,
    `  ktx setup --project-dir ${projectDir} --llm-backend anthropic --anthropic-api-key-env ANTHROPIC_API_KEY --no-input`,
  ].join('\n');
}

function resolveAgentRunner(options: CreateLocalBundleIngestRuntimeOptions, rateLimitGovernor: RateLimitGovernor): {
  agentRunner: AgentRunnerPort;
  llmRuntime?: KtxLlmRuntimePort;
} {
  const llmRuntime =
    options.llmRuntime ??
    (options.createLlmRuntime ?? createLocalKtxLlmRuntimeFromConfig)(options.project.config.llm, {
      projectDir: options.project.projectDir,
      env: process.env,
      rateLimitGovernor,
    }) ??
    undefined;

  if (options.agentRunner) {
    return { agentRunner: options.agentRunner, ...(llmRuntime ? { llmRuntime } : {}) };
  }

  if (!llmRuntime) {
    throw new Error(localIngestLlmProviderGuardMessage(options.project.projectDir));
  }

  return {
    agentRunner: new RuntimeAgentRunner(llmRuntime),
    llmRuntime,
  };
}

export function createLocalBundleIngestRuntime(
  options: CreateLocalBundleIngestRuntimeOptions,
): LocalBundleIngestRuntime {
  const logger = options.logger ?? noopLogger;
  const dbPath = ktxLocalStateDbPath(options.project);
  mkdirSync(join(options.project.projectDir, '.ktx/cache/local-ingest'), { recursive: true });
  const store = new SqliteBundleIngestStore({ dbPath });
  const contextStore = new SqliteContextEvidenceStore({ dbPath });
  const contentCache = new SqliteContentResultCache({ dbPath });
  const embeddingProvider = options.embeddingProvider ?? null;
  if (!embeddingProvider && options.project.config.ingest.embeddings.backend !== 'none') {
    // Embedding-dependent stages (CandidateDedup clustering, ContextEvidenceIndex
    // chunk indexing) silently produce zero-vector data with NoopEmbeddingPort.
    // Surface that fact so the caller knows ingest will not be running its
    // configured backend.
    logger.warn(
      `[local-bundle-runtime] embeddings backend "${options.project.config.ingest.embeddings.backend}" is configured but no embedding provider was passed; embedding-dependent stages will run against a no-op embedding port.`,
    );
  }
  const embedding = embeddingProvider ? new KtxIngestEmbeddingPortAdapter(embeddingProvider) : new NoopEmbeddingPort();
  const connections = new LocalConnectionCatalog(options.project, options.queryExecutor);
  const rootFileStore = options.project.fileStore;
  const semanticLayerService = new SemanticLayerService(
    rootFileStore,
    connections,
    new LocalSlPythonPort(options.semanticLayerCompute),
    logger,
  );
  const slSourcesRepository = new SqliteSlSourcesIndex({ dbPath });
  const slSearchService = new SlSearchService(embedding, slSourcesRepository, logger);
  const knowledgeIndex = new LocalKnowledgeIndex(options.project, embedding);
  const knowledgeEvents = new NoopKnowledgeEventPort();
  const wikiService = new KnowledgeWikiService(rootFileStore, embedding, knowledgeIndex, options.project.git, logger);
  const rateLimitGovernor = new RateLimitGovernor(
    createRateLimitGovernorConfig({
      ...options.project.config.ingest.rateLimit,
      maxConcurrency: options.project.config.ingest.workUnits.maxConcurrency,
    }),
  );
  const { agentRunner, llmRuntime } = resolveAgentRunner(options, rateLimitGovernor);
  const promptService = new PromptService({ promptsDir, partials: [], logger });
  const storage = new LocalIngestStorage(options.project);
  const registry = registerAdapters(options.adapters);
  const toolsetFactory = new LocalIngestToolsetFactory({
    project: options.project,
    wikiService,
    knowledgeIndex,
    knowledgeEvents,
    semanticLayerService,
    slSearchService,
    authorResolver: new LocalAuthorResolver(),
    slSourcesRepository,
    connections,
    ...(options.sqlAnalysis ? { sqlAnalysis: options.sqlAnalysis } : {}),
    contextStore,
    embedding,
  });

  const deps: IngestBundleRunnerDeps = {
    runs: store,
    provenance: store,
    reports: store,
    canonicalPins: store,
    contentCache,
    registry,
    diffSetService: new DiffSetService(store),
    sessionWorktreeService: new SessionWorktreeService({
      coreConfig: options.project.coreConfig,
      gitService: options.project.git,
      configService: rootFileStore,
    }),
    agentRunner,
    gitService: options.project.git,
    lockingService: new LocalIngestLock(),
    storage,
    settings: {
      memoryIngestionModel: options.project.config.llm.models.default ?? 'local-ingest-model',
      cliVersion: getKtxCliPackageInfo().version,
      probeRowCount: 0,
      workUnitMaxConcurrency: options.project.config.ingest.workUnits.maxConcurrency,
      workUnitStepBudget: options.project.config.ingest.workUnits.stepBudget,
      workUnitFailureMode: options.project.config.ingest.workUnits.failureMode,
      rateLimitGovernor,
      profileIngest: options.project.config.ingest.profile,
      ingestTraceLevel: ingestTraceLevelFromEnv(),
    },
    skillsRegistry: new SkillsRegistryService({ skillsDir, logger }),
    promptService,
    wikiService,
    knowledgeIndex,
    semanticLayerService,
    slSearchService,
    slSourcesRepository,
    connections,
    slValidator: new LocalShapeOnlySlValidator(),
    toolsetFactory,
    commitMessages: new LocalCommitMessagePort(),
    embedding,
    contextEvidenceIndex: new ContextEvidenceIndexService({ store: contextStore, embeddings: embedding, logger }),
    llmRuntime,
    pageTriage: llmRuntime
      ? new PageTriageService({
          store: contextStore,
          llmRuntime,
          settings: {
            enabled: true,
            maxConcurrency: 2,
            lightExtractionEnabled: true,
            classifierModel: null,
            lightExtractionMaxCandidates: 5,
          },
          promptService,
          logger,
        })
      : undefined,
    contextEvidenceCandidates: contextStore,
    candidateDedup: new CandidateDedupService({
      store: contextStore,
      embeddings: embedding,
      settings: { enabled: true, topicSimilarityThreshold: 0.86, scoreAggregation: 'max' },
      logger,
    }),
    contextCandidateCarryforward: new ContextCandidateCarryforwardService({
      store: contextStore,
      settings: { reExamineBudgetExhaustedOnRerun: true },
      logger,
    }),
    curatorPagination: new CuratorPaginationService({
      store: contextStore,
      agentRunner,
      settings: { batchSize: 8, maxPasses: 8, stepBudgetPerPass: 60 },
      logger,
    }),
    logger,
  };

  return {
    runner: new IngestBundleRunner(deps),
    store,
    contextStore,
    storage,
    registry,
    nextJobId: options.jobIdFactory ?? nextLocalJobId,
  };
}
