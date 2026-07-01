import { basename, extname, join } from 'node:path';
import YAML from 'yaml';
import { z } from 'zod';
import { noopLogger } from './context/core/config.js';
import { assertConfiguredConnectionId } from './context/connections/configured-connections.js';
import { KtxIngestEmbeddingPortAdapter } from './context/llm/embedding-port.js';
import { createLocalKtxEmbeddingProviderFromConfig, createLocalKtxLlmRuntimeFromConfig } from './context/llm/local-config.js';
import type { KtxLlmRuntimePort } from './context/llm/runtime-port.js';
import type { KtxProjectConnectionConfig } from './context/project/config.js';
import type { KtxLocalProject } from './context/project/project.js';
import { KnowledgeWikiService } from './context/wiki/knowledge-wiki.service.js';
import { suggestFlatWikiKey } from './context/wiki/keys.js';
import { SqliteKnowledgeIndex } from './context/wiki/sqlite-knowledge-index.js';
import type { WikiFrontmatter } from './context/wiki/types.js';
import type { KtxEmbeddingProvider } from './llm/types.js';

const LOCAL_AUTHOR = 'ktx';
const LOCAL_AUTHOR_EMAIL = 'ktx@example.com';

/** Only the prefix sent to the LLM for metadata is clipped; the stored body is never clipped. */
const METADATA_CLIP_LENGTH = 48_000;

const VERBATIM_METADATA_SYSTEM_PROMPT = [
  'You generate search metadata for an authoritative document that ktx stores verbatim.',
  'You never rewrite, summarize into, or alter the document body — you only describe it.',
  'Return a concise one- or two-sentence summary, a few topical tags, and any semantic-layer',
  'source names the document is clearly about. Use empty arrays when none apply.',
].join(' ');

const verbatimMetadataSchema = z.object({
  summary: z.string().min(1).describe('A one- or two-sentence description of what the document defines or specifies.'),
  tags: z.array(z.string()).default([]).describe('Short topical keywords that aid lexical and semantic recall.'),
  sl_refs: z
    .array(z.string())
    .default([])
    .describe('Semantic-layer source names the document is clearly about, if any are evident.'),
});

type VerbatimMetadata = z.infer<typeof verbatimMetadataSchema>;

export interface VerbatimIngestOrigin {
  kind: 'file' | 'text' | 'stdin';
  /** Present only for `kind: 'file'`; the resolved path the key basename is derived from. */
  path?: string;
}

const DEGRADED_SUMMARY_MAX_LENGTH = 200;
const FRONTMATTER_PATTERN = /^---\n([\s\S]*?)\n---\n?([\s\S]*)$/;
const HEADING_PATTERN = /^#{1,6}\s+(.+?)\s*#*\s*$/;

type UsageMode = WikiFrontmatter['usage_mode'];

function isUsageMode(value: unknown): value is UsageMode {
  return value === 'always' || value === 'auto' || value === 'never';
}

function nonEmptyString(value: unknown): string | undefined {
  return typeof value === 'string' && value.trim().length > 0 ? value : undefined;
}

function stringArray(value: unknown): string[] {
  return Array.isArray(value) ? value.filter((item): item is string => typeof item === 'string') : [];
}

/** `connections` accepts a single id or a list in YAML; normalize either to a string list. */
function stringList(value: unknown): string[] {
  if (typeof value === 'string') {
    return value.trim().length > 0 ? [value] : [];
  }
  return stringArray(value);
}

function leadingHeadingText(body: string): string | null {
  const firstLine = body.trimStart().split('\n', 1)[0] ?? '';
  const match = firstLine.match(HEADING_PATTERN);
  return match ? match[1].trim() : null;
}

/** @internal */
export function splitInputDocument(raw: string): { frontmatter: Record<string, unknown>; body: string } {
  const match = raw.match(FRONTMATTER_PATTERN);
  if (!match) {
    return { frontmatter: {}, body: raw.trim() };
  }
  const parsed = YAML.parse(match[1]) as unknown;
  const frontmatter =
    parsed !== null && typeof parsed === 'object' && !Array.isArray(parsed)
      ? (parsed as Record<string, unknown>)
      : {};
  return { frontmatter, body: match[2].trim() };
}

/** @internal */
export function deriveVerbatimPageKey(origin: VerbatimIngestOrigin, body: string): string {
  if (origin.kind === 'file' && origin.path) {
    return suggestFlatWikiKey(basename(origin.path, extname(origin.path)));
  }
  const heading = leadingHeadingText(body);
  if (!heading) {
    throw new Error(
      'Verbatim inline text needs a leading Markdown heading to derive a stable page key. Add a "# Heading" line, or pass the content as --file <path>.',
    );
  }
  return suggestFlatWikiKey(heading);
}

/** @internal */
export function deriveDegradedSummary(body: string): string {
  const heading = leadingHeadingText(body);
  if (heading) {
    return heading;
  }
  const text = body.trim();
  const sentence = text.match(/^([\s\S]*?[.!?])(\s|$)/);
  const summary = sentence ? sentence[1].trim() : text;
  if (summary.length <= DEGRADED_SUMMARY_MAX_LENGTH) {
    return summary;
  }
  return `${summary.slice(0, DEGRADED_SUMMARY_MAX_LENGTH).trimEnd()}…`;
}

/** @internal */
export function buildVerbatimFrontmatter(input: {
  inputFrontmatter: Record<string, unknown>;
  summary: string;
  tags: string[];
  slRefs: string[];
  connectionId?: string;
}): WikiFrontmatter & Record<string, unknown> {
  const { inputFrontmatter } = input;

  const inputConnections = stringList(inputFrontmatter.connections);
  const flagConnections = input.connectionId ? [input.connectionId] : [];
  if (
    inputConnections.length > 0 &&
    flagConnections.length > 0 &&
    !connectionSetsEqual(inputConnections, flagConnections)
  ) {
    throw new Error(
      `Connection scope conflict: frontmatter declares connections [${inputConnections.join(
        ', ',
      )}] but --connection-id is "${input.connectionId}". Remove one so the intent is unambiguous.`,
    );
  }
  const connections = inputConnections.length > 0 ? inputConnections : flagConnections;

  const summary = nonEmptyString(inputFrontmatter.summary) ?? input.summary;
  const usageMode = isUsageMode(inputFrontmatter.usage_mode) ? inputFrontmatter.usage_mode : 'auto';
  const tags = inputFrontmatter.tags !== undefined ? stringArray(inputFrontmatter.tags) : input.tags;
  const slRefs = inputFrontmatter.sl_refs !== undefined ? stringArray(inputFrontmatter.sl_refs) : input.slRefs;

  const passthrough = Object.fromEntries(
    Object.entries(inputFrontmatter).filter(
      ([key]) => !['summary', 'usage_mode', 'tags', 'sl_refs', 'connections'].includes(key),
    ),
  );

  return {
    ...passthrough,
    summary,
    usage_mode: usageMode,
    ...(tags.length > 0 ? { tags } : {}),
    ...(slRefs.length > 0 ? { sl_refs: slRefs } : {}),
    ...(connections.length > 0 ? { connections } : {}),
  } satisfies WikiFrontmatter & Record<string, unknown>;
}

function connectionSetsEqual(left: string[], right: string[]): boolean {
  if (left.length !== right.length) {
    return false;
  }
  const rightSet = new Set(right);
  return left.every((id) => rightSet.has(id));
}

export interface VerbatimIngestItem {
  origin: VerbatimIngestOrigin;
  content: string;
  connectionId?: string;
}

export interface VerbatimIngestResult {
  pageKey: string;
  outcome: 'written' | 'unchanged';
  connections: string[];
  commitHash: string | null;
}

export interface VerbatimIngestorPort {
  ingest(item: VerbatimIngestItem): Promise<VerbatimIngestResult>;
}

export interface CreateLocalProjectVerbatimIngestorDeps {
  /** `undefined` ⇒ resolve from project config; `null` ⇒ force degraded (offline) metadata. */
  llmRuntime?: KtxLlmRuntimePort | null;
  embeddingProvider?: KtxEmbeddingProvider | null;
}

class LocalVerbatimIngestor implements VerbatimIngestorPort {
  constructor(
    private readonly deps: {
      wikiService: KnowledgeWikiService;
      llmRuntime: KtxLlmRuntimePort | null;
      configuredConnections: Record<string, KtxProjectConnectionConfig>;
      author: string;
      authorEmail: string;
    },
  ) {}

  async ingest(item: VerbatimIngestItem): Promise<VerbatimIngestResult> {
    if (item.connectionId) {
      assertConfiguredConnectionId(this.deps.configuredConnections, item.connectionId);
    }

    const { frontmatter: inputFrontmatter, body } = splitInputDocument(item.content);
    const pageKey = deriveVerbatimPageKey(item.origin, body);

    const generated = await this.resolveMetadata(inputFrontmatter, body);
    const frontmatter = buildVerbatimFrontmatter({
      inputFrontmatter,
      summary: generated.summary,
      tags: generated.tags,
      slRefs: generated.slRefs,
      ...(item.connectionId ? { connectionId: item.connectionId } : {}),
    });
    const connections = Array.isArray(frontmatter.connections) ? frontmatter.connections : [];

    const existing = await this.deps.wikiService.readPage('GLOBAL', null, pageKey);
    if (existing) {
      if (existing.content === body) {
        return { pageKey, outcome: 'unchanged', connections, commitHash: null };
      }
      throw new Error(
        `A different page already exists at key "${pageKey}". Re-run with a distinct document name or key, ` +
          'or remove the existing page first — verbatim ingest never overwrites a conflicting page.',
      );
    }

    const writeResult = await this.deps.wikiService.writePageAndSync(
      'GLOBAL',
      null,
      pageKey,
      frontmatter,
      body,
      this.deps.author,
      this.deps.authorEmail,
      `Ingest verbatim document: ${pageKey}`,
    );

    return { pageKey, outcome: 'written', connections, commitHash: writeResult.commitHash ?? null };
  }

  /**
   * Generated metadata is only used to gap-fill absent frontmatter fields, so the LLM is
   * skipped entirely when summary, tags, and sl_refs are all explicit. A configured backend
   * that fails surfaces the error (the item fails); degraded derivation is reserved for
   * `backend: none`, never used as a silent fallback that would poison the idempotency check.
   */
  private async resolveMetadata(
    inputFrontmatter: Record<string, unknown>,
    body: string,
  ): Promise<{ summary: string; tags: string[]; slRefs: string[] }> {
    const needsGeneration =
      nonEmptyString(inputFrontmatter.summary) === undefined ||
      inputFrontmatter.tags === undefined ||
      inputFrontmatter.sl_refs === undefined;

    if (this.deps.llmRuntime && needsGeneration) {
      const clipped = body.length > METADATA_CLIP_LENGTH ? body.slice(0, METADATA_CLIP_LENGTH) : body;
      const generated = await this.deps.llmRuntime.generateObject<VerbatimMetadata, typeof verbatimMetadataSchema>({
        role: 'triage',
        system: VERBATIM_METADATA_SYSTEM_PROMPT,
        prompt: clipped,
        schema: verbatimMetadataSchema,
      });
      return { summary: generated.summary, tags: generated.tags, slRefs: generated.sl_refs };
    }

    return { summary: deriveDegradedSummary(body), tags: [], slRefs: [] };
  }
}

export function createLocalProjectVerbatimIngestor(
  project: KtxLocalProject,
  deps: CreateLocalProjectVerbatimIngestorDeps = {},
): VerbatimIngestorPort {
  const llmRuntime =
    deps.llmRuntime !== undefined
      ? deps.llmRuntime
      : createLocalKtxLlmRuntimeFromConfig(project.config.llm, { projectDir: project.projectDir });

  const embeddingProvider =
    deps.embeddingProvider !== undefined
      ? deps.embeddingProvider
      : createLocalKtxEmbeddingProviderFromConfig(project.config.ingest.embeddings, { projectDir: project.projectDir });
  const embeddingPort = embeddingProvider ? new KtxIngestEmbeddingPortAdapter(embeddingProvider) : null;

  const knowledgeIndex = new SqliteKnowledgeIndex({ dbPath: join(project.projectDir, '.ktx', 'db.sqlite') });
  const wikiService = new KnowledgeWikiService(project.fileStore, embeddingPort, knowledgeIndex, project.git, noopLogger);

  return new LocalVerbatimIngestor({
    wikiService,
    llmRuntime,
    configuredConnections: project.config.connections,
    author: LOCAL_AUTHOR,
    authorEmail: LOCAL_AUTHOR_EMAIL,
  });
}
