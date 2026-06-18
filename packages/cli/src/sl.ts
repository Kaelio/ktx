import { readFile } from 'node:fs/promises';
import type { KtxCliIo } from './cli-runtime.js';
import type { KtxSqlQueryExecutorPort } from './context/connections/query-executor.js';
import { KtxIngestEmbeddingPortAdapter } from './context/llm/embedding-port.js';
import type { KtxEmbeddingPort } from './context/core/embedding.js';
import type { KtxSemanticLayerComputePort } from './context/daemon/semantic-layer-compute.js';
import { loadKtxProject, type KtxLocalProject } from './context/project/project.js';
import { compileLocalSlQuery } from './context/sl/local-query.js';
import {
  listLocalSlSources,
  resolveLocalSlSource,
  searchLocalSlSources as defaultSearchLocalSlSources,
  validateLocalSlSource,
  type LocalSlSourceSearchResult,
  type LocalSlSourceSummary,
} from './context/sl/local-sl.js';
import type { SemanticLayerQueryInput } from './context/sl/types.js';
import {
  resolveProjectEmbeddingProvider,
  type EmbeddingProviderResolution,
} from './embedding-resolution.js';
import { createKtxCliIngestQueryExecutor } from './ingest-query-executor.js';
import type { PrintListColumn } from './io/print-list.js';
import {
  createManagedPythonSemanticLayerComputePort,
  type KtxManagedPythonInstallPolicy,
} from './managed-python-command.js';
import { profileMark } from './startup-profile.js';
import { emitTelemetryEvent, reportException } from './telemetry/index.js';
import { collectTelemetryRedactionSecrets } from './telemetry/redaction-secrets.js';
import { scrubErrorClass } from './telemetry/scrubber.js';

profileMark('module:sl');

type SlQueryFormat = 'json' | 'sql';

export type KtxSlArgs =
  | {
      command: 'list';
      projectDir: string;
      connectionId?: string;
      output?: string;
      json?: boolean;
      cliVersion: string;
    }
  | {
      command: 'search';
      projectDir: string;
      connectionId?: string;
      query: string;
      limit?: number;
      output?: string;
      json?: boolean;
      cliVersion: string;
    }
  | { command: 'read'; projectDir: string; connectionId?: string; sourceName: string }
  | { command: 'validate'; projectDir: string; connectionId?: string; sourceName: string }
  | {
      command: 'query';
      projectDir: string;
      connectionId?: string;
      query?: SemanticLayerQueryInput;
      queryFile?: string;
      format: SlQueryFormat;
      execute: boolean;
      maxRows?: number;
      cliVersion: string;
      runtimeInstallPolicy: KtxManagedPythonInstallPolicy;
    };

type KtxSlIo = KtxCliIo;

interface KtxSlDeps {
  loadProject?: typeof loadKtxProject;
  resolveEmbeddingProvider?: typeof resolveProjectEmbeddingProvider;
  searchLocalSlSources?: typeof defaultSearchLocalSlSources;
  createSemanticLayerCompute?: () => KtxSemanticLayerComputePort;
  createManagedSemanticLayerCompute?: (options: {
    cliVersion: string;
    installPolicy: KtxManagedPythonInstallPolicy;
    io: KtxSlIo;
    projectDir?: string;
  }) => Promise<KtxSemanticLayerComputePort>;
  createQueryExecutor?: (project: KtxLocalProject) => KtxSqlQueryExecutorPort;
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

function queryMeasureCount(query: SemanticLayerQueryInput): number {
  return Array.isArray(query.measures) ? query.measures.length : 0;
}

function queryDimensionCount(query: SemanticLayerQueryInput): number {
  return Array.isArray(query.dimensions) ? query.dimensions.length : 0;
}

async function printSlSources(input: {
  rows: ReadonlyArray<LocalSlSourceSummary>;
  command: 'sl list';
  output?: string;
  json?: boolean;
  io: KtxSlIo;
  emptyMessage: string;
  emptyHint?: string;
}): Promise<void>;
async function printSlSources(input: {
  rows: ReadonlyArray<LocalSlSourceSearchResult>;
  command: 'sl search';
  output?: string;
  json?: boolean;
  io: KtxSlIo;
  emptyMessage: string;
  emptyHint?: string;
}): Promise<void>;
async function printSlSources(input: {
  rows: ReadonlyArray<LocalSlSourceSummary | LocalSlSourceSearchResult>;
  command: 'sl list' | 'sl search';
  output?: string;
  json?: boolean;
  io: KtxSlIo;
  emptyMessage: string;
  emptyHint?: string;
}): Promise<void> {
  const { resolveOutputMode } = await import('./io/mode.js');
  const { createRankBadgeFormatter, printList } = await import('./io/print-list.js');
  const mode = resolveOutputMode({ explicit: input.output, json: input.json, io: input.io });

  if (input.command === 'sl search') {
    const searchColumns: ReadonlyArray<PrintListColumn<LocalSlSourceSearchResult>> = [
      {
        key: 'score',
        label: 'SCORE',
        plain: 'score=',
        role: 'badge',
        prettyFormat: createRankBadgeFormatter(input.rows as ReadonlyArray<LocalSlSourceSearchResult>),
        dim: true,
      },
      { key: 'connectionId', label: 'CONNECTION', plain: '' },
      { key: 'name', label: 'NAME', plain: '' },
      { key: 'columnCount', label: 'COLS', plain: 'columns=', dim: true },
      { key: 'measureCount', label: 'MEASURES', plain: 'measures=', dim: true },
      { key: 'joinCount', label: 'JOINS', plain: 'joins=', dim: true },
      { key: 'description', label: 'DESCRIPTION', plain: false, optional: true, dim: true },
    ];
    printList<LocalSlSourceSearchResult>({
      rows: input.rows as ReadonlyArray<LocalSlSourceSearchResult>,
      columns: searchColumns,
      groupBy: 'connectionId',
      emptyMessage: input.emptyMessage,
      emptyHint: input.emptyHint,
      unit: 'source',
      command: input.command,
      mode,
      io: input.io,
    });
    return;
  }

  const listColumns: ReadonlyArray<PrintListColumn<LocalSlSourceSummary>> = [
    { key: 'connectionId', label: 'CONNECTION', plain: '' },
    { key: 'name', label: 'NAME', plain: '' },
    { key: 'columnCount', label: 'COLS', plain: 'columns=', dim: true },
    { key: 'measureCount', label: 'MEASURES', plain: 'measures=', dim: true },
    { key: 'joinCount', label: 'JOINS', plain: 'joins=', dim: true },
    { key: 'description', label: 'DESCRIPTION', plain: false, optional: true, dim: true },
  ];
  printList<LocalSlSourceSummary>({
    rows: input.rows as ReadonlyArray<LocalSlSourceSummary>,
    columns: listColumns,
    groupBy: 'connectionId',
    emptyMessage: input.emptyMessage,
    emptyHint: input.emptyHint,
    unit: 'source',
    command: input.command,
    mode,
    io: input.io,
  });
}

async function readSlQueryFile(path: string): Promise<SemanticLayerQueryInput> {
  const parsed = JSON.parse(await readFile(path, 'utf-8')) as unknown;
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
    throw new Error(`${path} must contain a JSON object.`);
  }
  return parsed as SemanticLayerQueryInput;
}

function ambiguousSourceMessage(sourceName: string, connectionIds: readonly string[]): string {
  return `Source '${sourceName}' exists in multiple connections: ${connectionIds.join(
    ', ',
  )}. Re-run with --connection-id <id>.`;
}

export async function runKtxSl(args: KtxSlArgs, io: KtxSlIo = process, deps: KtxSlDeps = {}): Promise<number> {
  const startedAt = performance.now();
  let queryForTelemetry: SemanticLayerQueryInput | undefined;
  let project: KtxLocalProject | undefined;
  try {
    project = await (deps.loadProject ?? loadKtxProject)({ projectDir: args.projectDir });
    if (args.command === 'list') {
      const sources = await listLocalSlSources(project, { connectionId: args.connectionId });
      await printSlSources({
        rows: sources,
        emptyMessage: `No semantic-layer sources found in ${project.projectDir}`,
        command: 'sl list',
        output: args.output,
        json: args.json,
        io,
      });
      return 0;
    }
    if (args.command === 'search') {
      const resolver = deps.resolveEmbeddingProvider ?? resolveProjectEmbeddingProvider;
      const resolution = await resolver(project, {
        mode: 'use-if-running',
        cliVersion: args.cliVersion,
        io,
      });
      const embeddingService = resolutionToEmbeddingPort(resolution);
      const search = deps.searchLocalSlSources ?? defaultSearchLocalSlSources;
      const sources = await search(project, {
        connectionId: args.connectionId,
        query: args.query,
        embeddingService,
        limit: args.limit,
      });
      if (sources.length === 0 && resolution.kind === 'managed-unavailable' && !args.json) {
        const { SYMBOLS } = await import('./io/symbols.js');
        io.stderr.write(`embeddings: unavailable ${SYMBOLS.emDash} ${resolution.reason}\n`);
      }
      await printSlSources({
        rows: sources,
        emptyMessage: `No semantic-layer sources matched "${args.query}" in ${project.projectDir}`,
        emptyHint: 'Run `ktx sl` to inspect available sources.',
        command: 'sl search',
        output: args.output,
        json: args.json,
        io,
      });
      return 0;
    }
    if (args.command === 'read') {
      const resolved = await resolveLocalSlSource(project, {
        connectionId: args.connectionId,
        sourceName: args.sourceName,
      });
      if (resolved.kind === 'not-found') {
        throw new Error(
          args.connectionId !== undefined
            ? `No semantic-layer source '${args.sourceName}' for connection '${args.connectionId}'`
            : `No semantic-layer source '${args.sourceName}'`,
        );
      }
      if (resolved.kind === 'ambiguous') {
        throw new Error(ambiguousSourceMessage(args.sourceName, resolved.connectionIds));
      }
      io.stdout.write(resolved.source.yaml);
      return 0;
    }
    if (args.command === 'validate') {
      const resolved = await resolveLocalSlSource(project, {
        connectionId: args.connectionId,
        sourceName: args.sourceName,
      });
      if (resolved.kind === 'not-found') {
        throw new Error(
          args.connectionId !== undefined
            ? `Semantic-layer source "${args.connectionId}/${args.sourceName}" was not found`
            : `Semantic-layer source "${args.sourceName}" was not found`,
        );
      }
      if (resolved.kind === 'ambiguous') {
        throw new Error(ambiguousSourceMessage(args.sourceName, resolved.connectionIds));
      }
      const result = await validateLocalSlSource(resolved.source.yaml, {
        project,
        connectionId: resolved.source.connectionId,
        sourceName: args.sourceName,
      });
      await emitTelemetryEvent({
        name: 'sl_validate_completed',
        projectDir: args.projectDir,
        io,
        fields: {
          sourceCount: 1,
          modelCount: 0,
          validationErrorCount: result.valid ? 0 : result.errors.length,
          outcome: result.valid ? 'ok' : 'error',
          durationMs: Math.max(0, performance.now() - startedAt),
        },
      });
      if (!result.valid) {
        for (const error of result.errors) {
          io.stderr.write(`${error}\n`);
        }
        return 1;
      }
      io.stdout.write(`Valid semantic-layer source: ${resolved.source.connectionId}/${args.sourceName}\n`);
      return 0;
    }
    if (args.command === 'query') {
      const query = args.query ?? (args.queryFile ? await readSlQueryFile(args.queryFile) : undefined);
      if (!query) {
        throw new Error('sl query requires query input from --query-file or at least one --measure');
      }
      queryForTelemetry = query;
      const compute = deps.createSemanticLayerCompute
        ? deps.createSemanticLayerCompute()
        : await (deps.createManagedSemanticLayerCompute ?? createManagedPythonSemanticLayerComputePort)({
            cliVersion: args.cliVersion,
            installPolicy: args.runtimeInstallPolicy,
            io,
            projectDir: args.projectDir,
          });
      const queryExecutor = args.execute ? (deps.createQueryExecutor ?? createKtxCliIngestQueryExecutor)(project) : undefined;
      const result = await compileLocalSlQuery(project, {
        connectionId: args.connectionId,
        query,
        compute,
        execute: args.execute,
        maxRows: args.maxRows,
        queryExecutor,
      });
      await emitTelemetryEvent({
        name: 'sl_query_completed',
        projectDir: args.projectDir,
        io,
        fields: {
          mode: args.execute ? 'execute' : 'compile',
          referencedSourceCount: result.plan && typeof result.plan === 'object' ? 1 : 0,
          referencedDimensionCount: queryDimensionCount(query),
          referencedMeasureCount: queryMeasureCount(query),
          durationMs: Math.max(0, performance.now() - startedAt),
          outcome: 'ok',
        },
      });
      if (args.format === 'sql') {
        io.stdout.write(`${result.sql}\n`);
        return 0;
      }
      io.stdout.write(`${JSON.stringify(result, null, 2)}\n`);
      return 0;
    }
    const _exhaustive: never = args;
    throw new Error(`Unsupported sl command: ${JSON.stringify(_exhaustive)}`);
  } catch (error) {
    await reportException({
      error,
      context: { source: `sl ${args.command}`, handled: true, fatal: false },
      projectDir: args.projectDir,
      io,
      redactionSecrets: await collectTelemetryRedactionSecrets({
        project,
        projectDir: args.projectDir,
        connectionId: args.connectionId,
        includeLlm: args.command === 'query',
        includeEmbeddings: args.command === 'search' || args.command === 'query',
        env: process.env,
      }),
    });
    if (args.command === 'validate') {
      const errorClass = scrubErrorClass(error);
      await emitTelemetryEvent({
        name: 'sl_validate_completed',
        projectDir: args.projectDir,
        io,
        fields: {
          sourceCount: 0,
          modelCount: 0,
          validationErrorCount: 0,
          outcome: 'error',
          ...(errorClass ? { errorClass } : {}),
          durationMs: Math.max(0, performance.now() - startedAt),
        },
      });
    }
    if (args.command === 'query') {
      const errorClass = scrubErrorClass(error);
      await emitTelemetryEvent({
        name: 'sl_query_completed',
        projectDir: args.projectDir,
        io,
        fields: {
          mode: args.execute ? 'execute' : 'compile',
          referencedSourceCount: 0,
          referencedDimensionCount: queryForTelemetry ? queryDimensionCount(queryForTelemetry) : 0,
          referencedMeasureCount: queryForTelemetry ? queryMeasureCount(queryForTelemetry) : 0,
          durationMs: Math.max(0, performance.now() - startedAt),
          outcome: 'error',
          ...(errorClass ? { errorClass } : {}),
        },
      });
    }
    io.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`);
    return 1;
  }
}
