import { join } from 'node:path';
import YAML from 'yaml';
import { z } from 'zod';
import type { KtxEmbeddingPort } from '../../context/core/embedding.js';
import { deriveFederatedConnection, FEDERATED_CONNECTION_ID } from '../connections/federation.js';
import type { KtxLocalProject } from '../../context/project/project.js';
import { HybridSearchCore } from '../../context/search/hybrid-search-core.js';
import type { SearchCandidateGenerator } from '../../context/search/types.js';
import { DEFAULT_PRIORITY, resolveDescription } from './descriptions.js';
import { normalizeSemanticLayerDescriptions } from './description-normalization.js';
import { sourceDefinitionSchema, sourceOverlaySchema } from './schemas.js';
import {
  composeOverlay,
  type ManifestTableEntry,
  projectManifestEntry,
  SemanticLayerService,
  toResolvedWire,
} from './semantic-layer.service.js';
import type { PgliteSlSearchPrototypeOwnerOptions } from './pglite-sl-search-prototype.js';
import { loadLatestSlDictionaryEntries } from './sl-dictionary-profile.js';
import {
  assertSafeConnectionId,
  isSafeConnectionId,
  isSlYamlPath,
  slSourceNameForFile,
  sourceNameFromPath,
} from './source-files.js';
import { buildSemanticLayerSourceSearchText, SlSearchService } from './sl-search.service.js';
import { SqliteSlSourcesIndex } from './sqlite-sl-sources-index.js';
import type { SemanticLayerSource, SlDictionaryMatch, SlSearchLaneSummary, SlSearchMatchReason } from './types.js';

export interface LocalSlSourceSummary {
  connectionId: string;
  name: string;
  path: string;
  description?: string;
  columnCount: number;
  measureCount: number;
  joinCount: number;
}

export interface LocalSlSourceSearchResult extends LocalSlSourceSummary {
  score: number;
  frequencyTier?: NonNullable<SemanticLayerSource['usage']>['frequencyTier'];
  snippet?: string;
  matchReasons?: SlSearchMatchReason[];
  dictionaryMatches?: SlDictionaryMatch[];
  lanes?: SlSearchLaneSummary[];
}

export interface LocalSlSearchInput {
  connectionId?: string;
  query: string;
  embeddingService?: KtxEmbeddingPort | null;
  limit?: number;
  backend?: 'pglite-owner-prototype';
  pglite?: PgliteSlSearchPrototypeOwnerOptions;
}

/** @internal */
export interface LocalSlSource extends LocalSlSourceSummary {
  yaml: string;
}

export interface LocalSlSourceRecord extends LocalSlSource {
  source: SemanticLayerSource;
}

export interface LocalSlValidationResult {
  valid: boolean;
  errors: string[];
}

export type ResolvedSlSource =
  | { kind: 'found'; source: LocalSlSource }
  | { kind: 'not-found' }
  | { kind: 'ambiguous'; connectionIds: string[] };

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function parseYamlRecord(raw: string): Record<string, unknown> {
  const parsed = YAML.parse(raw) as unknown;
  if (!isRecord(parsed)) {
    throw new Error('Semantic-layer source YAML must contain an object');
  }
  return parsed;
}

function descriptionMap(value: Record<string, unknown>): Record<string, string> | undefined {
  const result: Record<string, string> = {};
  const descriptions = value.descriptions;
  if (isRecord(descriptions)) {
    for (const [key, text] of Object.entries(descriptions)) {
      if (typeof text === 'string' && text.trim().length > 0) {
        result[key] = text;
      }
    }
  }

  const flatDescription = value.description;
  if (!result.user && typeof flatDescription === 'string' && flatDescription.trim().length > 0) {
    result.user = flatDescription;
  }

  return Object.keys(result).length > 0 ? result : undefined;
}

function validationErrors(error: unknown): string[] {
  if (error instanceof z.ZodError) {
    return error.issues.map((issue) => `${issue.path.join('.') || '<root>'}: ${issue.message}`);
  }
  return [error instanceof Error ? error.message : String(error)];
}

function summarizeSource(args: { connectionId: string; path: string; raw: string }): LocalSlSourceSummary {
  const parsed = parseYamlRecord(args.raw);
  const name = typeof parsed.name === 'string' && parsed.name.length > 0 ? parsed.name : sourceNameFromPath(args.path);
  const description = resolveDescription(descriptionMap(parsed), { priority: DEFAULT_PRIORITY }) ?? undefined;
  return {
    connectionId: args.connectionId,
    name,
    path: args.path,
    ...(description ? { description } : {}),
    columnCount: Array.isArray(parsed.columns) ? parsed.columns.length : 0,
    measureCount: Array.isArray(parsed.measures) ? parsed.measures.length : 0,
    joinCount: Array.isArray(parsed.joins) ? parsed.joins.length : 0,
  };
}

function sourceToYaml(source: SemanticLayerSource): string {
  return YAML.stringify(source, { indent: 2, lineWidth: 0, version: '1.1' });
}

function summarizeSemanticSource(args: {
  connectionId: string;
  path: string;
  source: SemanticLayerSource;
}): LocalSlSourceSummary {
  const description = resolveDescription(args.source.descriptions, { priority: DEFAULT_PRIORITY }) ?? undefined;
  return {
    connectionId: args.connectionId,
    name: args.source.name,
    path: args.path,
    ...(description ? { description } : {}),
    columnCount: args.source.columns.length,
    measureCount: args.source.measures.length,
    joinCount: args.source.joins.length,
  };
}

function manifestTables(value: Record<string, unknown>): Record<string, ManifestTableEntry> | null {
  return isRecord(value.tables) ? (value.tables as Record<string, ManifestTableEntry>) : null;
}

function parsedStandaloneSource(parsed: Record<string, unknown>, name: string): SemanticLayerSource {
  const source = parsed as Partial<SemanticLayerSource>;
  return normalizeSemanticLayerDescriptions({
    ...source,
    name,
    grain: Array.isArray(parsed.grain) ? (parsed.grain.filter((item) => typeof item === 'string') as string[]) : [],
    columns: Array.isArray(parsed.columns) ? (parsed.columns as SemanticLayerSource['columns']) : [],
    joins: Array.isArray(parsed.joins) ? (parsed.joins as SemanticLayerSource['joins']) : [],
    measures: Array.isArray(parsed.measures) ? (parsed.measures as SemanticLayerSource['measures']) : [],
  });
}

export async function loadLocalSlSourceRecords(
  project: KtxLocalProject,
  input: { connectionId: string },
): Promise<LocalSlSourceRecord[]> {
  if (input.connectionId === FEDERATED_CONNECTION_ID) {
    const descriptor = deriveFederatedConnection(project.config.connections, project.projectDir);
    if (!descriptor) {
      return [];
    }
    const perMember = await Promise.all(
      descriptor.members.map(async (member) => {
        const records = await loadSingleConnectionSourceRecords(project, member.connectionId);
        return records.map((record) => {
          // The federated view is one virtual connection: rows carry its id and a
          // member-prefixed name, so a listing/search row round-trips to
          // `ktx sl -c _ktx_federated read <name>`. Member origin lives in the name.
          const name = `${member.connectionId}.${record.name}`;
          return {
            ...record,
            connectionId: FEDERATED_CONNECTION_ID,
            name,
            source: { ...record.source, name },
          };
        });
      }),
    );
    return perMember.flat();
  }
  return loadSingleConnectionSourceRecords(project, input.connectionId);
}

async function loadSingleConnectionSourceRecords(
  project: KtxLocalProject,
  rawConnectionId: string,
): Promise<LocalSlSourceRecord[]> {
  const connectionId = assertSafeConnectionId(rawConnectionId);
  const dir = `semantic-layer/${connectionId}`;
  const schemaDir = `${dir}/_schema`;
  const listed = await project.fileStore.listFiles(dir);
  const paths = listed.files.filter(isSlYamlPath).sort();
  const sources = new Map<string, LocalSlSourceRecord>();

  for (const path of paths.filter((file) => file.startsWith(`${schemaDir}/`))) {
    const raw = await project.fileStore.readFile(path);
    let tables: Record<string, ManifestTableEntry> | null;
    try {
      tables = manifestTables(parseYamlRecord(raw.content));
    } catch (error) {
      throw new Error(`${path}: ${error instanceof Error ? error.message : String(error)}`);
    }
    if (!tables) {
      continue;
    }
    for (const [name, entry] of Object.entries(tables)) {
      const source = projectManifestEntry(name, entry);
      const projectedPath = `${path}#${name}`;
      sources.set(name, {
        ...summarizeSemanticSource({ connectionId, path: projectedPath, source }),
        yaml: sourceToYaml(source),
        source,
      });
    }
  }

  for (const path of paths.filter((file) => !file.startsWith(`${schemaDir}/`))) {
    const raw = await project.fileStore.readFile(path);
    let parsed: Record<string, unknown>;
    try {
      parsed = parseYamlRecord(raw.content);
    } catch {
      // A source mid-edit (e.g. an agent saved half-written YAML) must not take
      // down reads, listings, or search for its siblings. Key it by the same
      // name the writer side uses (the intact top-level `name:`, recovered even
      // when the YAML is broken below it; filename only as a last resort) so a
      // broken uppercase/hashed/human-renamed source stays reachable under its
      // real name, and surface the raw content for repair.
      const brokenName = slSourceNameForFile(path, raw.content);
      sources.set(brokenName, {
        connectionId,
        name: brokenName,
        path,
        columnCount: 0,
        measureCount: 0,
        joinCount: 0,
        yaml: raw.content,
        source: { name: brokenName, grain: [], columns: [], joins: [], measures: [] },
      });
      continue;
    }
    const name = typeof parsed.name === 'string' && parsed.name.length > 0 ? parsed.name : sourceNameFromPath(path);
    if (parsed.table || parsed.sql) {
      const source = parsedStandaloneSource(parsed, name);
      sources.set(name, { ...summarizeSource({ connectionId, path, raw: raw.content }), yaml: raw.content, source });
      continue;
    }

    const base = sources.get(name);
    if (!base) {
      continue;
    }
    let source: SemanticLayerSource;
    try {
      source = composeOverlay(base.source, parsed);
    } catch (error) {
      throw new Error(`${path}: ${error instanceof Error ? error.message : String(error)}`);
    }
    sources.set(name, {
      ...summarizeSemanticSource({ connectionId, path, source }),
      yaml: sourceToYaml(source),
      source,
    });
  }

  return [...sources.values()].sort((left, right) => left.name.localeCompare(right.name));
}

export async function validateLocalSlSource(
  rawYaml: string,
  options?: { project?: KtxLocalProject; connectionId?: string; sourceName?: string },
): Promise<LocalSlValidationResult> {
  try {
    const parsed = parseYamlRecord(rawYaml);
    const schema = parsed.table || parsed.sql ? sourceDefinitionSchema : sourceOverlaySchema;
    const result = schema.parse(parsed);
    const errors: string[] = [];

    if (options?.project && options.connectionId && 'table' in result && result.table) {
      const service = new SemanticLayerService(options.project.fileStore, {} as never, {} as never);
      errors.push(
        ...(await service.validatePhysicalTableReferences(options.connectionId, [result as SemanticLayerSource])),
      );
    }

    if ('table' in result || 'sql' in result) {
      toResolvedWire(result as SemanticLayerSource);
    }

    return { valid: errors.length === 0, errors };
  } catch (error) {
    return { valid: false, errors: validationErrors(error) };
  }
}

export async function readLocalSlSource(
  project: KtxLocalProject,
  input: { connectionId: string; sourceName: string },
): Promise<LocalSlSource | null> {
  // Source identity is the in-file `name:` (mirroring the warehouse identifier
  // verbatim, e.g. Snowflake's uppercase `WIDGET_SALES`), never the filename. The
  // record loader resolves standalone files, overlays, manifest-backed sources,
  // and mid-edit files whose YAML no longer parses — so readers — `ktx sl read`,
  // `ktx sl validate`, and the `sl_read_source` MCP tool — can surface broken
  // content for repair instead of failing on it.
  const records = await loadLocalSlSourceRecords(project, {
    connectionId: input.connectionId,
  });
  const record = records.find((source) => source.name === input.sourceName);
  return record ? { ...record } : null;
}

export async function resolveLocalSlSource(
  project: KtxLocalProject,
  input: { sourceName: string; connectionId?: string },
): Promise<ResolvedSlSource> {
  if (input.connectionId !== undefined) {
    const source = await readLocalSlSource(project, {
      connectionId: input.connectionId,
      sourceName: input.sourceName,
    });
    return source ? { kind: 'found', source } : { kind: 'not-found' };
  }

  const summaries = await listLocalSlSources(project, {});
  const matches = summaries.filter((summary) => summary.name === input.sourceName);
  if (matches.length === 0) {
    return { kind: 'not-found' };
  }
  if (matches.length > 1) {
    return {
      kind: 'ambiguous',
      connectionIds: [...new Set(matches.map((match) => match.connectionId))].sort(),
    };
  }

  const match = matches[0];
  if (match === undefined) {
    return { kind: 'not-found' };
  }
  const source = await readLocalSlSource(project, {
    connectionId: match.connectionId,
    sourceName: input.sourceName,
  });
  return source ? { kind: 'found', source } : { kind: 'not-found' };
}

export async function listLocalSlSources(
  project: KtxLocalProject,
  input: { connectionId?: string } = {},
): Promise<LocalSlSourceSummary[]> {
  if (input.connectionId) {
    return (await loadLocalSlSourceRecords(project, { connectionId: input.connectionId })).map(
      ({ source: _source, yaml: _yaml, ...summary }) => summary,
    );
  }
  const listed = await project.fileStore.listFiles('semantic-layer');
  const connectionIds = [...new Set(listed.files.map((path) => path.split('/')[1]).filter(isSafeConnectionId))].sort();
  const summaries: LocalSlSourceSummary[] = [];
  for (const connectionId of connectionIds) {
    const records = await loadLocalSlSourceRecords(project, { connectionId });
    summaries.push(...records.map(({ source: _source, yaml: _yaml, ...summary }) => summary));
  }
  return summaries.sort(
    (left, right) => left.connectionId.localeCompare(right.connectionId) || left.name.localeCompare(right.name),
  );
}

interface LocalSlSearchCandidate {
  summary: LocalSlSourceSummary;
  source: SemanticLayerSource;
  searchText: string;
}

function sqliteSlDbPath(project: KtxLocalProject): string {
  return join(project.projectDir, '.ktx', 'db.sqlite');
}

async function loadLocalSlSearchCandidates(
  project: KtxLocalProject,
  input: { connectionId?: string } = {},
): Promise<LocalSlSearchCandidate[]> {
  if (input.connectionId) {
    return (await loadLocalSlSourceRecords(project, { connectionId: input.connectionId })).map((record) => ({
      summary: {
        connectionId: record.connectionId,
        name: record.name,
        path: record.path,
        ...(record.description ? { description: record.description } : {}),
        columnCount: record.columnCount,
        measureCount: record.measureCount,
        joinCount: record.joinCount,
      },
      source: record.source,
      searchText: buildSemanticLayerSourceSearchText(record.source),
    }));
  }

  const listed = await project.fileStore.listFiles('semantic-layer');
  const connectionIds = [...new Set(listed.files.map((path) => path.split('/')[1]).filter(isSafeConnectionId))].sort();
  const candidates: LocalSlSearchCandidate[] = [];
  for (const connectionId of connectionIds) {
    candidates.push(...(await loadLocalSlSearchCandidates(project, { connectionId })));
  }
  return candidates.sort(
    (left, right) =>
      left.summary.connectionId.localeCompare(right.summary.connectionId) ||
      left.summary.name.localeCompare(right.summary.name),
  );
}

function candidateKey(summary: LocalSlSourceSummary): string {
  return `${summary.connectionId}/${summary.name}`;
}

function searchResultUsageFields(source: SemanticLayerSource): Pick<LocalSlSourceSearchResult, 'frequencyTier'> {
  return source.usage?.frequencyTier ? { frequencyTier: source.usage.frequencyTier } : {};
}

function tokenLaneCandidates(candidates: LocalSlSearchCandidate[], terms: readonly string[]) {
  if (terms.length === 0) {
    return [];
  }
  return candidates
    .map((candidate) => {
      const haystack = candidate.searchText.toLowerCase();
      const matchedTerms = terms.filter((term) => haystack.includes(term));
      return {
        candidate,
        score: matchedTerms.length / terms.length,
      };
    })
    .filter((result) => result.score > 0)
    .sort(
      (left, right) =>
        right.score - left.score ||
        left.candidate.summary.connectionId.localeCompare(right.candidate.summary.connectionId) ||
        left.candidate.summary.name.localeCompare(right.candidate.summary.name),
    );
}

async function refreshHybridSlIndexes(input: {
  index: SqliteSlSourcesIndex;
  project: KtxLocalProject;
  candidates: LocalSlSearchCandidate[];
  embeddingService?: KtxEmbeddingPort | null;
}): Promise<void> {
  const candidatesByConnection = new Map<string, LocalSlSearchCandidate[]>();
  for (const candidate of input.candidates) {
    candidatesByConnection.set(candidate.summary.connectionId, [
      ...(candidatesByConnection.get(candidate.summary.connectionId) ?? []),
      candidate,
    ]);
  }

  for (const [connectionId, group] of candidatesByConnection) {
    if (input.embeddingService) {
      const service = new SlSearchService(input.embeddingService, input.index);
      await service.indexSources(
        connectionId,
        group.map((candidate) => candidate.source),
      );
    } else {
      await input.index.upsertSources(
        connectionId,
        group.map((candidate) => ({
          sourceName: candidate.summary.name,
          searchText: candidate.searchText,
          embedding: null,
        })),
      );
      await input.index.deleteStale(
        connectionId,
        group.map((candidate) => candidate.summary.name),
      );
    }
  }

  const dictionaryEntries = await loadLatestSlDictionaryEntries(input.project, [...candidatesByConnection.keys()]);
  for (const connectionId of candidatesByConnection.keys()) {
    await input.index.replaceDictionaryEntries(
      connectionId,
      dictionaryEntries.filter((entry) => entry.connectionId === connectionId),
    );
  }
}

export async function searchLocalSlSources(
  project: KtxLocalProject,
  input: LocalSlSearchInput,
): Promise<LocalSlSourceSearchResult[]> {
  const query = input.query.trim();
  if (!query) {
    return (await listLocalSlSources(project, { connectionId: input.connectionId })).map((source) => ({
      ...source,
      score: 1,
    }));
  }

  if (input.backend === 'pglite-owner-prototype') {
    if (!input.pglite) {
      throw new Error('PGlite semantic-layer search prototype requires pglite owner-process options.');
    }
    const { searchLocalSlSourcesWithPglitePrototype } = await import('./pglite-sl-search-prototype.js');
    return searchLocalSlSourcesWithPglitePrototype(project, {
      connectionId: input.connectionId,
      query,
      embeddingService: input.embeddingService ?? null,
      limit: input.limit,
      pglite: input.pglite,
    });
  }

  const candidates = await loadLocalSlSearchCandidates(project, { connectionId: input.connectionId });
  if (project.config.storage.search !== 'sqlite-fts5') {
    return candidates
      .map((candidate) => {
        const terms = query
          .toLowerCase()
          .split(/\s+/)
          .map((term) => term.trim())
          .filter(Boolean);
        return {
          candidate,
          score:
            terms.length === 0
              ? 0
              : terms.filter((term) => candidate.searchText.toLowerCase().includes(term)).length / terms.length,
        };
      })
      .filter((result) => result.score > 0)
      .map((result) => ({
        ...result.candidate.summary,
        score: result.score,
        matchReasons: ['token'],
        ...searchResultUsageFields(result.candidate.source),
      }))
      .sort(
        (left, right) =>
          right.score - left.score ||
          left.connectionId.localeCompare(right.connectionId) ||
          left.path.localeCompare(right.path),
      );
  }

  const index = new SqliteSlSourcesIndex({ dbPath: sqliteSlDbPath(project) });
  await refreshHybridSlIndexes({ index, project, candidates, embeddingService: input.embeddingService ?? null });

  const candidateById = new Map(candidates.map((candidate) => [candidateKey(candidate.summary), candidate]));
  const connectionIds = input.connectionId ? [input.connectionId] : undefined;
  const finalLimit = input.limit ?? candidates.length;
  const core = new HybridSearchCore();
  const dictionaryEvidence = new Map<string, SlDictionaryMatch[]>();
  const lexicalSnippets = new Map<string, string>();

  const generators: SearchCandidateGenerator[] = [
    {
      lane: 'lexical',
      async generate(args) {
        const rows = await index.searchLexicalCandidates({
          connectionIds,
          queryText: args.queryText,
          limit: args.laneCandidatePoolLimit,
        });
        for (const row of rows) {
          if (row.snippet) {
            lexicalSnippets.set(row.id, row.snippet);
          }
        }
        return {
          candidates: rows.map((row) => ({ id: row.id, rank: row.rank, rawScore: row.rawScore })),
        };
      },
    },
    {
      lane: 'dictionary',
      async generate(args) {
        const rows = await index.searchDictionaryCandidates({
          connectionIds,
          queryText: args.queryText,
          limit: args.laneCandidatePoolLimit,
        });
        for (const row of rows) {
          dictionaryEvidence.set(row.id, row.matches);
        }
        return {
          candidates: rows.map((row) => ({
            id: row.id,
            rank: row.rank,
            rawScore: row.rawScore,
            evidence: row.matches,
          })),
        };
      },
    },
    {
      lane: 'token',
      async generate(args) {
        const rows = tokenLaneCandidates(candidates, args.normalizedQuery.terms).slice(0, args.laneCandidatePoolLimit);
        return {
          candidates: rows.map((row, index) => ({
            id: candidateKey(row.candidate.summary),
            rank: index + 1,
            rawScore: row.score,
          })),
        };
      },
    },
    {
      lane: 'semantic',
      async generate(args) {
        if (!input.embeddingService) {
          return { status: 'skipped', candidates: [], reason: 'embedding_unconfigured' };
        }
        try {
          const queryEmbedding = await input.embeddingService.computeEmbedding(args.queryText);
          const rows = await index.searchSemanticCandidates({
            connectionIds,
            queryEmbedding,
            limit: args.laneCandidatePoolLimit,
          });
          return {
            candidates: rows.map((row) => ({ id: row.id, rank: row.rank, rawScore: row.rawScore })),
          };
        } catch (error) {
          return {
            status: 'skipped',
            candidates: [],
            reason: `embedding_unhealthy:${error instanceof Error ? error.message : String(error)}`,
          };
        }
      },
    },
  ];

  const result = await core.search({ queryText: query, limit: finalLimit, generators });
  const hydrated: LocalSlSourceSearchResult[] = [];
  for (const fused of result.results) {
    const candidate = candidateById.get(fused.id);
    if (!candidate) {
      continue;
    }
    const dictionaryMatches = dictionaryEvidence.get(fused.id);
    const snippet = lexicalSnippets.get(fused.id);
    hydrated.push({
      ...candidate.summary,
      score: fused.score,
      ...searchResultUsageFields(candidate.source),
      ...(snippet ? { snippet } : {}),
      matchReasons: fused.matchReasons as SlSearchMatchReason[],
      ...(dictionaryMatches && dictionaryMatches.length > 0 ? { dictionaryMatches } : {}),
      lanes: result.lanes,
    });
  }
  return hydrated;
}
