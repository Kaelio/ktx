import { KtxIngestEmbeddingPortAdapter } from './context/llm/embedding-port.js';
import type { KtxEmbeddingPort } from './context/core/embedding.js';
import { loadKtxProject } from './context/project/project.js';
import { assertConfiguredConnectionId } from './context/connections/configured-connections.js';
import {
  type LocalKnowledgeSearchResult,
  type LocalKnowledgeSummary,
  listLocalKnowledgePages,
  readLocalKnowledgePage,
  searchLocalKnowledgePages as defaultSearchLocalKnowledgePages,
} from './context/wiki/local-knowledge.js';
import {
  resolveProjectEmbeddingProvider,
  type EmbeddingProviderResolution,
} from './embedding-resolution.js';
import { resolveOutputMode } from './io/mode.js';
import { createRankBadgeFormatter, printList, type PrintListColumn } from './io/print-list.js';
import { emitTelemetryEvent } from './telemetry/index.js';

export type KtxKnowledgeArgs =
  | {
      command: 'list';
      projectDir: string;
      userId: string;
      connectionId?: string;
      output?: string;
      json?: boolean;
      cliVersion: string;
    }
  | {
      command: 'search';
      projectDir: string;
      query: string;
      userId: string;
      connectionId?: string;
      output?: string;
      json?: boolean;
      limit?: number;
      debug?: boolean;
      cliVersion: string;
    }
  | { command: 'read'; projectDir: string; key: string; userId: string };

type KtxKnowledgeIo = import('./cli-runtime.js').KtxCliIo;

const WIKI_LIST_COLUMNS: ReadonlyArray<PrintListColumn<LocalKnowledgeSummary>> = [
  { key: 'scope', label: 'SCOPE', plain: '' },
  { key: 'key', label: 'KEY', plain: '' },
  { key: 'summary', label: 'SUMMARY', plain: '', optional: true, dim: true },
];

function wikiSearchColumns(
  rows: ReadonlyArray<LocalKnowledgeSearchResult>,
): ReadonlyArray<PrintListColumn<LocalKnowledgeSearchResult>> {
  return [
    {
      key: 'score',
      label: 'SCORE',
      plain: 'score=',
      role: 'badge',
      prettyFormat: createRankBadgeFormatter(rows),
      dim: true,
    },
    { key: 'scope', label: 'SCOPE', plain: '' },
    { key: 'key', label: 'KEY', plain: '' },
    { key: 'summary', label: 'SUMMARY', plain: '', optional: true, dim: true },
  ];
}

interface KtxKnowledgeDeps {
  embeddingService?: KtxEmbeddingPort | null;
  resolveEmbeddingProvider?: typeof resolveProjectEmbeddingProvider;
  searchLocalKnowledgePages?: typeof defaultSearchLocalKnowledgePages;
}

function resolutionToEmbeddingPort(resolution: EmbeddingProviderResolution): KtxEmbeddingPort | null {
  if (
    resolution.kind === 'configured' ||
    resolution.kind === 'managed-running' ||
    resolution.kind === 'managed-started'
  ) {
    return new KtxIngestEmbeddingPortAdapter(resolution.provider);
  }
  return null;
}

async function wikiSearchEmbeddingService(
  project: Awaited<ReturnType<typeof loadKtxProject>>,
  deps: KtxKnowledgeDeps,
  args: { cliVersion: string },
  io: KtxKnowledgeIo,
): Promise<KtxEmbeddingPort | null> {
  if ('embeddingService' in deps) {
    return deps.embeddingService ?? null;
  }
  const resolution = await (deps.resolveEmbeddingProvider ?? resolveProjectEmbeddingProvider)(project, {
    mode: 'use-if-running',
    cliVersion: args.cliVersion,
    io,
  });
  return resolutionToEmbeddingPort(resolution);
}

function writeWikiSearchDebug(
  io: KtxKnowledgeIo,
  input: {
    mode: string;
    embeddingConfigured: boolean;
    results: LocalKnowledgeSearchResult[];
  },
): void {
  io.stderr.write(
    `[debug] wiki search mode=${input.mode} embedding=${input.embeddingConfigured ? 'configured' : 'unconfigured'} results=${input.results.length}\n`,
  );
  const lanes = input.results[0]?.lanes ?? [];
  for (const lane of lanes) {
    const reason = lane.reason ? ` reason=${lane.reason}` : '';
    io.stderr.write(
      `[debug] wiki search lane=${lane.lane} status=${lane.status} returned=${lane.returnedCandidateCount} weight=${lane.weight}${reason}\n`,
    );
  }
}

export async function runKtxKnowledge(
  args: KtxKnowledgeArgs,
  io: KtxKnowledgeIo = process,
  deps: KtxKnowledgeDeps = {},
): Promise<number> {
  const startedAt = performance.now();
  try {
    const project = await loadKtxProject({ projectDir: args.projectDir });
    if (args.command === 'list') {
      const connectionId =
        args.connectionId === undefined
          ? undefined
          : assertConfiguredConnectionId(project.config.connections, args.connectionId);
      const pages = await listLocalKnowledgePages(project, {
        userId: args.userId,
        ...(connectionId !== undefined ? { connectionId } : {}),
      });
      const mode = resolveOutputMode({ explicit: args.output, json: args.json, io });
      printList<LocalKnowledgeSummary>({
        rows: pages,
        columns: WIKI_LIST_COLUMNS,
        groupBy: 'scope',
        emptyMessage: `No local wiki pages found in ${project.projectDir}`,
        emptyHint: 'Add Markdown files under wiki/ or run `ktx ingest <connectionId>`.',
        unit: 'page',
        command: 'wiki list',
        mode,
        io,
      });
      return 0;
    }
    if (args.command === 'read') {
      const page = await readLocalKnowledgePage(project, { key: args.key, userId: args.userId });
      if (!page) {
        throw new Error(`No wiki page found for key '${args.key}'`);
      }
      const raw = await project.fileStore.readFile(page.path);
      io.stdout.write(raw.content);
      return 0;
    }
    if (args.command === 'search') {
      const connectionId =
        args.connectionId === undefined
          ? undefined
          : assertConfiguredConnectionId(project.config.connections, args.connectionId);
      const embeddingService = await wikiSearchEmbeddingService(project, deps, { cliVersion: args.cliVersion }, io);
      const search = deps.searchLocalKnowledgePages ?? defaultSearchLocalKnowledgePages;
      const results = await search(project, {
        query: args.query,
        userId: args.userId,
        embeddingService,
        limit: args.limit,
        ...(connectionId !== undefined ? { connectionId } : {}),
      });
      await emitTelemetryEvent({
        name: 'wiki_query_completed',
        projectDir: args.projectDir,
        io,
        fields: {
          queryLength: args.query.length,
          resultCount: results.length,
          durationMs: Math.max(0, performance.now() - startedAt),
          outcome: 'ok',
        },
      });
      if (args.debug) {
        writeWikiSearchDebug(io, {
          mode: project.config.storage.search,
          embeddingConfigured: embeddingService !== null,
          results,
        });
      }
      const mode = resolveOutputMode({ explicit: args.output, json: args.json, io });
      let emptyMessage = `No local wiki pages matched "${args.query}"`;
      let emptyHint = 'Run `ktx wiki` to inspect available pages.';
      if (results.length === 0 && mode !== 'json') {
        const pages = await listLocalKnowledgePages(project, { userId: args.userId });
        if (pages.length === 0) {
          emptyMessage = `No local wiki pages found in ${project.projectDir}`;
          emptyHint = 'Add Markdown files under wiki/ or run `ktx ingest <connectionId>`.';
        }
      }
      printList<LocalKnowledgeSearchResult>({
        rows: results,
        columns: wikiSearchColumns(results),
        groupBy: 'scope',
        emptyMessage,
        emptyHint,
        unit: 'page',
        command: 'wiki search',
        mode,
        io,
      });
      return 0;
    }
    return 0;
  } catch (error) {
    if (args.command === 'search') {
      await emitTelemetryEvent({
        name: 'wiki_query_completed',
        projectDir: args.projectDir,
        io,
        fields: {
          queryLength: args.query.length,
          resultCount: 0,
          durationMs: Math.max(0, performance.now() - startedAt),
          outcome: 'error',
        },
      });
    }
    io.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`);
    return 1;
  }
}
