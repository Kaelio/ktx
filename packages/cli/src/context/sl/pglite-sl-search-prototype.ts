import { mkdir } from 'node:fs/promises';
import { join } from 'node:path';
import type { KtxEmbeddingPort } from '../../context/core/embedding.js';
import type { KtxLocalProject } from '../../context/project/project.js';
import { HybridSearchCore } from '../../context/search/hybrid-search-core.js';
import type { SearchCandidateGenerator } from '../../context/search/types.js';
import { KtxPGliteOwnerProcess } from '../search/pglite-owner-process.js';
import {
  listLocalSlSources,
  loadLocalSlSourceRecords,
  type LocalSlSourceSearchResult,
  type LocalSlSourceSummary,
} from './local-sl.js';
import { loadLatestSlDictionaryEntries, type SlDictionaryEntry } from './sl-dictionary-profile.js';
import { buildSemanticLayerSourceSearchText } from './sl-search.service.js';
import type { SemanticLayerSource, SlDictionaryMatch, SlSearchMatchReason } from './types.js';

export interface PgliteSlSearchPrototypeOwnerOptions {
  dataDir?: string;
  host: string;
  port: number;
}

export interface PgliteSlSearchPrototypeInput {
  connectionId?: string;
  query: string;
  embeddingService?: KtxEmbeddingPort | null;
  limit?: number;
  pglite: PgliteSlSearchPrototypeOwnerOptions;
}

interface LocalSlSearchCandidate {
  summary: LocalSlSourceSummary;
  source: SemanticLayerSource;
  searchText: string;
}

interface PgliteLaneRow {
  id: string;
  connection_id: string;
  source_name: string;
  score: number | string;
}

interface PgliteDictionaryRow extends PgliteLaneRow {
  column_name: string;
  value: string;
}

function candidateKey(summary: LocalSlSourceSummary): string {
  return `${summary.connectionId}/${summary.name}`;
}

function pgliteDataDir(project: KtxLocalProject, input: PgliteSlSearchPrototypeOwnerOptions): string {
  return input.dataDir ?? join(project.projectDir, '.ktx', 'pglite-search-prototype');
}

function vectorDimensions(project: KtxLocalProject): number {
  const dimensions = project.config.ingest.embeddings.dimensions;
  if (!Number.isInteger(dimensions) || dimensions <= 0) {
    throw new Error(`PGlite SL search prototype needs a positive embedding dimension, got ${String(dimensions)}.`);
  }
  return dimensions;
}

function connectionIdsForSearch(input: { connectionId?: string }): string[] | null {
  return input.connectionId ? [input.connectionId] : null;
}

async function loadCandidates(
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
  const connectionIds = [
    ...new Set(
      listed.files
        .map((path) => path.split('/')[1])
        .filter((connectionId): connectionId is string =>
          typeof connectionId === 'string' && /^[a-zA-Z0-9_][a-zA-Z0-9_-]*$/.test(connectionId),
        ),
    ),
  ].sort();
  const candidates: LocalSlSearchCandidate[] = [];
  for (const connectionId of connectionIds) {
    candidates.push(...(await loadCandidates(project, { connectionId })));
  }
  return candidates.sort(
    (left, right) =>
      left.summary.connectionId.localeCompare(right.summary.connectionId) ||
      left.summary.name.localeCompare(right.summary.name),
  );
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

function postgresqlOrTsQuery(query: string): string {
  const terms = query
    .toLowerCase()
    .split(/[^a-z0-9_]+/u)
    .map((term) => term.trim())
    .filter(Boolean);

  return [...new Set(terms)].join(' | ');
}

async function resetPrototypeSchema(owner: KtxPGliteOwnerProcess, dimensions: number): Promise<void> {
  await owner.query(`
    DROP TABLE IF EXISTS prototype_sl_dictionary_values;
    DROP TABLE IF EXISTS prototype_sl_sources;

    CREATE TABLE prototype_sl_sources (
      connection_id TEXT NOT NULL,
      source_name TEXT NOT NULL,
      path TEXT NOT NULL,
      description TEXT,
      column_count INTEGER NOT NULL,
      measure_count INTEGER NOT NULL,
      join_count INTEGER NOT NULL,
      search_text TEXT NOT NULL,
      embedding vector(${dimensions}),
      PRIMARY KEY (connection_id, source_name)
    );

    CREATE INDEX prototype_sl_sources_fts_idx
      ON prototype_sl_sources
      USING GIN (to_tsvector('english', search_text));

    CREATE INDEX prototype_sl_sources_vector_idx
      ON prototype_sl_sources
      USING ivfflat (embedding vector_cosine_ops)
      WITH (lists = 1);

    CREATE TABLE prototype_sl_dictionary_values (
      connection_id TEXT NOT NULL,
      source_name TEXT NOT NULL,
      column_name TEXT NOT NULL,
      value TEXT NOT NULL,
      value_lower TEXT NOT NULL,
      cardinality INTEGER,
      PRIMARY KEY (connection_id, source_name, column_name, value)
    );

    CREATE INDEX prototype_sl_dictionary_values_trgm_idx
      ON prototype_sl_dictionary_values
      USING GIN (value gin_trgm_ops);
  `);
}

async function sourceEmbeddings(input: {
  candidates: LocalSlSearchCandidate[];
  embeddingService?: KtxEmbeddingPort | null;
  dimensions: number;
}): Promise<Map<string, number[]> | null> {
  if (!input.embeddingService) {
    return null;
  }

  const texts = input.candidates.map((candidate) => candidate.searchText);
  const embeddings = await input.embeddingService.computeEmbeddingsBulk(texts);
  const byId = new Map<string, number[]>();
  embeddings.forEach((embedding, index) => {
    if (embedding.length !== input.dimensions) {
      throw new Error(
        `PGlite SL search prototype expected ${input.dimensions} embedding dimensions, got ${embedding.length}.`,
      );
    }
    const candidate = input.candidates[index];
    if (candidate) {
      byId.set(candidateKey(candidate.summary), embedding);
    }
  });
  return byId;
}

async function insertSourceRows(input: {
  owner: KtxPGliteOwnerProcess;
  candidates: LocalSlSearchCandidate[];
  embeddings: Map<string, number[]> | null;
}): Promise<void> {
  for (const candidate of input.candidates) {
    const summary = candidate.summary;
    const embedding = input.embeddings?.get(candidateKey(summary));
    await input.owner.query(
      `
        INSERT INTO prototype_sl_sources (
          connection_id,
          source_name,
          path,
          description,
          column_count,
          measure_count,
          join_count,
          search_text,
          embedding
        )
        VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9::vector)
      `,
      [
        summary.connectionId,
        summary.name,
        summary.path,
        summary.description ?? null,
        summary.columnCount,
        summary.measureCount,
        summary.joinCount,
        candidate.searchText,
        embedding ? JSON.stringify(embedding) : null,
      ],
    );
  }
}

async function insertDictionaryRows(owner: KtxPGliteOwnerProcess, entries: SlDictionaryEntry[]): Promise<void> {
  for (const entry of entries) {
    await owner.query(
      `
        INSERT INTO prototype_sl_dictionary_values (
          connection_id,
          source_name,
          column_name,
          value,
          value_lower,
          cardinality
        )
        VALUES ($1, $2, $3, $4, lower($4), $5)
      `,
      [entry.connectionId, entry.sourceName, entry.columnName, entry.value, entry.cardinality ?? null],
    );
  }
}

function groupDictionaryRows(rows: PgliteDictionaryRow[], limit: number) {
  const grouped = new Map<string, PgliteDictionaryRow[]>();
  for (const row of rows) {
    grouped.set(row.id, [...(grouped.get(row.id) ?? []), row]);
  }

  return [...grouped.entries()]
    .map(([id, group]) => {
      const first = group[0];
      const byColumn = new Map<string, string[]>();
      for (const row of group.sort(
        (left, right) => left.column_name.localeCompare(right.column_name) || left.value.localeCompare(right.value),
      )) {
        byColumn.set(row.column_name, [...(byColumn.get(row.column_name) ?? []), row.value]);
      }
      const matches: SlDictionaryMatch[] = [...byColumn.entries()].map(([column, values]) => ({
        column,
        values: values.slice(0, 5),
        ...(values.length > 5 ? { overflowCount: values.length - 5 } : {}),
      }));
      return {
        id,
        connectionId: first?.connection_id ?? '',
        sourceName: first?.source_name ?? '',
        rawScore: matches.reduce((total, match) => total + match.values.length, 0),
        matches,
      };
    })
    .sort(
      (left, right) =>
        right.rawScore - left.rawScore ||
        right.matches.length - left.matches.length ||
        left.connectionId.localeCompare(right.connectionId) ||
        left.sourceName.localeCompare(right.sourceName),
    )
    .slice(0, Math.max(1, limit))
    .map((candidate, index) => ({ ...candidate, rank: index + 1 }));
}

async function queryLexicalCandidates(input: {
  owner: KtxPGliteOwnerProcess;
  queryText: string;
  connectionIds: string[] | null;
  limit: number;
}) {
  const tsQuery = postgresqlOrTsQuery(input.queryText);
  if (!tsQuery) {
    return [];
  }

  const result = await input.owner.query<PgliteLaneRow>(
    `
      SELECT
        connection_id || '/' || source_name AS id,
        connection_id,
        source_name,
        ts_rank_cd(to_tsvector('english', search_text), to_tsquery('english', $1)) AS score
      FROM prototype_sl_sources
      WHERE to_tsvector('english', search_text) @@ to_tsquery('english', $1)
        AND ($2::text[] IS NULL OR connection_id = ANY($2::text[]))
      ORDER BY score DESC, connection_id ASC, source_name ASC
      LIMIT $3
    `,
    [tsQuery, input.connectionIds, Math.max(1, input.limit)],
  );

  return result.rows.map((row, index) => ({
    id: row.id,
    connectionId: row.connection_id,
    sourceName: row.source_name,
    rank: index + 1,
    rawScore: Number(row.score),
  }));
}

async function querySemanticCandidates(input: {
  owner: KtxPGliteOwnerProcess;
  queryText: string;
  connectionIds: string[] | null;
  embeddingService?: KtxEmbeddingPort | null;
  dimensions: number;
  limit: number;
}) {
  if (!input.embeddingService) {
    return { status: 'skipped' as const, candidates: [], reason: 'embedding_unconfigured' };
  }

  try {
    const queryEmbedding = await input.embeddingService.computeEmbedding(input.queryText);
    if (queryEmbedding.length !== input.dimensions) {
      return {
        status: 'skipped' as const,
        candidates: [],
        reason: `embedding_unhealthy:expected ${input.dimensions} dimensions, got ${queryEmbedding.length}`,
      };
    }

    const result = await input.owner.query<PgliteLaneRow>(
      `
        SELECT
          connection_id || '/' || source_name AS id,
          connection_id,
          source_name,
          1 - (embedding <=> $1::vector) AS score
        FROM prototype_sl_sources
        WHERE embedding IS NOT NULL
          AND ($2::text[] IS NULL OR connection_id = ANY($2::text[]))
        ORDER BY embedding <=> $1::vector, connection_id ASC, source_name ASC
        LIMIT $3
      `,
      [JSON.stringify(queryEmbedding), input.connectionIds, Math.max(1, input.limit)],
    );

    return {
      candidates: result.rows.map((row, index) => ({
        id: row.id,
        connectionId: row.connection_id,
        sourceName: row.source_name,
        rank: index + 1,
        rawScore: Number(row.score),
      })),
    };
  } catch (error) {
    return {
      status: 'skipped' as const,
      candidates: [],
      reason: `embedding_unhealthy:${error instanceof Error ? error.message : String(error)}`,
    };
  }
}

async function queryDictionaryCandidates(input: {
  owner: KtxPGliteOwnerProcess;
  queryText: string;
  connectionIds: string[] | null;
  limit: number;
}) {
  const query = input.queryText.trim();
  if (!query) {
    return [];
  }

  const result = await input.owner.query<PgliteDictionaryRow>(
    `
      SELECT
        connection_id || '/' || source_name AS id,
        connection_id,
        source_name,
        column_name,
        value,
        GREATEST(
          similarity(value, $1),
          CASE WHEN value_lower = lower($1) THEN 1 ELSE 0 END,
          CASE WHEN value_lower LIKE '%' || lower($1) || '%' THEN 0.75 ELSE 0 END
        ) AS score
      FROM prototype_sl_dictionary_values
      WHERE (
          similarity(value, $1) > 0
          OR value_lower = lower($1)
          OR value_lower LIKE '%' || lower($1) || '%'
        )
        AND ($2::text[] IS NULL OR connection_id = ANY($2::text[]))
      ORDER BY score DESC, connection_id ASC, source_name ASC, column_name ASC, value ASC
      LIMIT $3
    `,
    [query, input.connectionIds, Math.max(25, input.limit * 4)],
  );

  return groupDictionaryRows(result.rows, input.limit);
}

export async function searchLocalSlSourcesWithPglitePrototype(
  project: KtxLocalProject,
  input: PgliteSlSearchPrototypeInput,
): Promise<LocalSlSourceSearchResult[]> {
  const query = input.query.trim();
  if (!query) {
    return (await listLocalSlSources(project, { connectionId: input.connectionId })).map((source) => ({
      ...source,
      score: 1,
    }));
  }

  const candidates = await loadCandidates(project, { connectionId: input.connectionId });
  const dimensions = vectorDimensions(project);
  const dataDir = pgliteDataDir(project, input.pglite);
  await mkdir(dataDir, { recursive: true });

  const owner = await KtxPGliteOwnerProcess.start({
    dataDir,
    host: input.pglite.host,
    port: input.pglite.port,
  });

  try {
    const embeddings = await sourceEmbeddings({
      candidates,
      embeddingService: input.embeddingService ?? null,
      dimensions,
    });
    await resetPrototypeSchema(owner, dimensions);
    await insertSourceRows({ owner, candidates, embeddings });

    const candidateConnectionIds = [...new Set(candidates.map((candidate) => candidate.summary.connectionId))].sort();
    const dictionaryEntries = await loadLatestSlDictionaryEntries(project, candidateConnectionIds);
    await insertDictionaryRows(owner, dictionaryEntries);

    const candidateById = new Map(candidates.map((candidate) => [candidateKey(candidate.summary), candidate]));
    const connectionIds = connectionIdsForSearch(input);
    const finalLimit = input.limit ?? candidates.length;
    const dictionaryEvidence = new Map<string, SlDictionaryMatch[]>();
    const core = new HybridSearchCore();

    const generators: SearchCandidateGenerator[] = [
      {
        lane: 'lexical',
        async generate(args) {
          const rows = await queryLexicalCandidates({
            owner,
            queryText: args.queryText,
            connectionIds,
            limit: args.laneCandidatePoolLimit,
          });
          return {
            candidates: rows.map((row) => ({ id: row.id, rank: row.rank, rawScore: row.rawScore })),
          };
        },
      },
      {
        lane: 'dictionary',
        async generate(args) {
          const rows = await queryDictionaryCandidates({
            owner,
            queryText: args.queryText,
            connectionIds,
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
          const rows = tokenLaneCandidates(candidates, args.normalizedQuery.terms).slice(
            0,
            args.laneCandidatePoolLimit,
          );
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
          return querySemanticCandidates({
            owner,
            queryText: args.queryText,
            connectionIds,
            embeddingService: input.embeddingService ?? null,
            dimensions,
            limit: args.laneCandidatePoolLimit,
          });
        },
      },
    ];

    const fused = await core.search({ queryText: query, limit: finalLimit, generators });
    const hydrated: LocalSlSourceSearchResult[] = [];
    for (const result of fused.results) {
      const candidate = candidateById.get(result.id);
      if (!candidate) {
        continue;
      }
      const dictionaryMatches = dictionaryEvidence.get(result.id);
      const frequencyTier = candidate.source.usage?.frequencyTier;
      hydrated.push({
        ...candidate.summary,
        score: result.score,
        ...(frequencyTier ? { frequencyTier } : {}),
        matchReasons: result.matchReasons as SlSearchMatchReason[],
        ...(dictionaryMatches && dictionaryMatches.length > 0 ? { dictionaryMatches } : {}),
        lanes: fused.lanes,
      });
    }
    return hydrated;
  } finally {
    await owner.stop();
  }
}
