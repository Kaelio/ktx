import { readFile as fsReadFile } from 'node:fs/promises';
import { basename, resolve } from 'node:path';
import { createLocalProjectMemoryIngest } from './context/memory/local-memory.js';
import type { MemoryAgentInput } from './context/memory/types.js';
import type { MemoryIngestStatus } from './context/memory/memory-runs.js';
import { loadKtxProject, type KtxLocalProject } from './context/project/project.js';
import type { KtxCliIo } from './cli-runtime.js';
import { createRepainter, initViewState, renderContextBuildView, type ContextBuildTargetState } from './context-build-view.js';
import { formatDuration } from './demo-metrics.js';
import type { KtxPublicIngestPlanTarget } from './public-ingest.js';
import {
  createLocalProjectVerbatimIngestor,
  type VerbatimIngestItem,
  type VerbatimIngestOrigin,
  type VerbatimIngestorPort,
  type VerbatimIngestResult,
} from './verbatim-ingest.js';

export interface KtxTextIngestArgs {
  projectDir: string;
  texts: string[];
  files: string[];
  connectionId?: string;
  userId: string;
  json: boolean;
  failFast: boolean;
  /** Code-driven verbatim ingest: store the document body unchanged, LLM derives metadata only. */
  verbatim?: boolean;
}

/** @internal */
export interface TextMemoryIngestPort {
  ingest(input: MemoryAgentInput): Promise<{ runId: string }>;
  waitForRun(runId: string): Promise<void>;
  status(runId: string): Promise<MemoryIngestStatus | null>;
}

interface TextIngestItem {
  label: string;
  content: string;
  origin: VerbatimIngestOrigin;
}

interface TextIngestResult {
  label: string;
  runId: string | null;
  status: 'done' | 'error';
  captured: MemoryIngestStatus['captured'];
  commitHash: string | null;
  error: string | null;
}

export interface KtxTextIngestDeps {
  loadProject?: (options: { projectDir: string }) => Promise<KtxLocalProject>;
  createMemoryIngest?: (project: KtxLocalProject) => TextMemoryIngestPort;
  createVerbatimIngestor?: (project: KtxLocalProject) => VerbatimIngestorPort;
  readFile?: (path: string) => Promise<string>;
  readStdin?: () => Promise<string>;
  now?: () => number;
}

const INLINE_TEXT_LABEL_MAX_LENGTH = 50;
const ANSI_ESCAPE_PATTERN = /\x1B\[[0-?]*[ -/]*[@-~]/g;

function defaultCreateMemoryIngest(project: KtxLocalProject): TextMemoryIngestPort {
  return createLocalProjectMemoryIngest(project);
}

function defaultCreateVerbatimIngestor(project: KtxLocalProject): VerbatimIngestorPort {
  return createLocalProjectVerbatimIngestor(project);
}

async function defaultReadStdin(): Promise<string> {
  const chunks: string[] = [];
  process.stdin.setEncoding('utf-8');
  for await (const chunk of process.stdin) {
    chunks.push(String(chunk));
  }
  return chunks.join('');
}

async function defaultReadFile(path: string): Promise<string> {
  return await fsReadFile(path, 'utf-8');
}

function emptyCaptured(): MemoryIngestStatus['captured'] {
  return { wiki: [], sl: [], xrefs: [] };
}

function normalizedTextPreview(content: string): string {
  return content
    .replace(ANSI_ESCAPE_PATTERN, '')
    .replace(/[\u0000-\u001f\u007f-\u009f]/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

function truncateLabel(label: string, maxLength = INLINE_TEXT_LABEL_MAX_LENGTH): string {
  const chars = Array.from(label);
  if (chars.length <= maxLength) {
    return label;
  }
  return `${chars.slice(0, maxLength - 3).join('').trimEnd()}...`;
}

function quoteInlineTextLabel(label: string): string {
  return JSON.stringify(label);
}

function makeUniqueLabel(label: string, usedLabels: Set<string>): string {
  if (!usedLabels.has(label)) {
    return label;
  }

  for (let index = 2; ; index++) {
    const suffix = ` (${index})`;
    const candidate = `${truncateLabel(label, INLINE_TEXT_LABEL_MAX_LENGTH - suffix.length)}${suffix}`;
    if (!usedLabels.has(candidate)) {
      return candidate;
    }
  }
}

function textLabel(content: string, index: number, usedLabels: Set<string>): string {
  const preview = normalizedTextPreview(content);
  const baseLabel = preview.length > 0 ? quoteInlineTextLabel(truncateLabel(preview)) : `text-${index + 1}`;
  return makeUniqueLabel(baseLabel, usedLabels);
}

function artifactReference(label: string): string {
  return label.startsWith('"') ? label : `"${label}"`;
}

function stdinLabel(items: TextIngestItem[]): string {
  if (!items.some((item) => item.label === 'stdin')) {
    return 'stdin';
  }
  return `stdin-${items.filter((item) => item.label.startsWith('stdin')).length + 1}`;
}

async function loadItems(args: KtxTextIngestArgs, deps: KtxTextIngestDeps): Promise<TextIngestItem[]> {
  const items: TextIngestItem[] = [];
  const usedTextLabels = new Set<string>();
  args.texts.forEach((content, index) => {
    const label = textLabel(content, index, usedTextLabels);
    usedTextLabels.add(label);
    items.push({ label, content, origin: { kind: 'text' } });
  });

  const readFile = deps.readFile ?? defaultReadFile;
  const readStdin = deps.readStdin ?? defaultReadStdin;
  for (const file of args.files) {
    if (file === '-') {
      items.push({ label: stdinLabel(items), content: await readStdin(), origin: { kind: 'stdin' } });
    } else {
      const path = resolve(file);
      items.push({ label: basename(path), content: await readFile(path), origin: { kind: 'file', path } });
    }
  }

  return items;
}

function validateItems(items: TextIngestItem[], io: KtxCliIo): boolean {
  if (items.length === 0) {
    io.stderr.write('Provide at least one text item with --text, a file path, or - for stdin.\n');
    return false;
  }

  for (const item of items) {
    if (item.content.trim().length === 0) {
      io.stderr.write(`Text item "${item.label}" is empty.\n`);
      return false;
    }
  }
  return true;
}

function makeTarget(label: string): KtxPublicIngestPlanTarget {
  return {
    connectionId: label,
    driver: 'text',
    operation: 'source-ingest',
    debugCommand: '',
    steps: ['memory-update'],
  };
}

function allTargets(state: ReturnType<typeof initViewState>): ContextBuildTargetState[] {
  return [...state.primarySources, ...state.contextSources];
}

function renderTextIngestView(state: ReturnType<typeof initViewState>, styled: boolean, verbatim: boolean): string {
  return renderContextBuildView(state, {
    styled,
    title: verbatim ? 'Writing verbatim pages' : 'Ingesting text memory',
    contextGroupLabel: verbatim ? 'Documents' : 'Texts',
    sourceIngestRunningText: verbatim ? 'writing...' : 'capturing...',
    completedItemName: verbatim ? { singular: 'page', plural: 'pages' } : { singular: 'text', plural: 'texts' },
  });
}

function summarizeCaptured(captured: MemoryIngestStatus['captured']): string {
  const parts = [
    `wiki=${captured.wiki.length}`,
    `sl=${captured.sl.length}`,
    `xrefs=${captured.xrefs.length}`,
  ];
  return parts.join(', ');
}

function resultFromStatus(label: string, status: MemoryIngestStatus): TextIngestResult {
  return {
    label,
    runId: status.runId,
    status: status.status === 'done' ? 'done' : 'error',
    captured: status.captured,
    commitHash: status.commitHash,
    error: status.error,
  };
}

function errorResult(label: string, runId: string | null, error: unknown): TextIngestResult {
  return {
    label,
    runId,
    status: 'error',
    captured: emptyCaptured(),
    commitHash: null,
    error: error instanceof Error ? error.message : String(error),
  };
}

function writeJsonResult(args: KtxTextIngestArgs, results: TextIngestResult[], io: KtxCliIo): void {
  io.stdout.write(
    `${JSON.stringify(
      {
        status: results.some((result) => result.status === 'error') ? 'failed' : 'done',
        projectDir: args.projectDir,
        connectionId: args.connectionId ?? null,
        results,
      },
      null,
      2,
    )}\n`,
  );
}

function writePlainFailures(results: TextIngestResult[], io: KtxCliIo): void {
  const failures = results.filter((result) => result.status === 'error');
  if (failures.length === 0) {
    return;
  }

  io.stdout.write('\nFailed text items:\n');
  for (const result of failures) {
    io.stdout.write(`  ${result.label}: ${result.error ?? 'failed'}\n`);
  }
}

export async function runKtxTextIngest(
  args: KtxTextIngestArgs,
  io: KtxCliIo,
  deps: KtxTextIngestDeps = {},
): Promise<number> {
  const items = await loadItems(args, deps);
  if (!validateItems(items, io)) {
    return 1;
  }

  const project = await (deps.loadProject ?? loadKtxProject)({ projectDir: args.projectDir });
  const isVerbatim = args.verbatim === true;
  const verbatimIngestor = isVerbatim ? (deps.createVerbatimIngestor ?? defaultCreateVerbatimIngestor)(project) : null;
  const memoryIngest = isVerbatim ? null : (deps.createMemoryIngest ?? defaultCreateMemoryIngest)(project);
  const now = deps.now ?? (() => Date.now());
  const batchId = now();
  const state = initViewState(items.map((item) => makeTarget(item.label)));
  const targets = allTargets(state);
  const isTTY = io.stdout.isTTY === true && args.json !== true;
  const repainter = isTTY ? createRepainter(io) : null;
  const results: TextIngestResult[] = [];

  state.startedAt = now();
  const paint = () => repainter?.paint(renderTextIngestView(state, true, isVerbatim));
  paint();

  let spinnerInterval: ReturnType<typeof setInterval> | null = null;
  if (repainter) {
    spinnerInterval = setInterval(() => {
      const current = now();
      state.frame++;
      state.totalElapsedMs = state.startedAt === null ? 0 : current - state.startedAt;
      for (const target of targets) {
        if (target.status === 'running' && target.startedAt !== null) {
          target.elapsedMs = current - target.startedAt;
        }
      }
      paint();
    }, 140);
  }

  try {
    for (let index = 0; index < items.length; index++) {
      const item = items[index]!;
      const target = targets[index]!;
      target.status = 'running';
      target.startedAt = now();
      target.detailLine = isVerbatim ? 'writing...' : 'capturing...';
      target.progressUpdatedAtMs = target.startedAt;
      paint();

      let runId: string | null = null;
      let result: TextIngestResult;
      try {
        if (verbatimIngestor) {
          const verbatimItem: VerbatimIngestItem = {
            origin: item.origin,
            content: item.content,
            ...(args.connectionId ? { connectionId: args.connectionId } : {}),
          };
          const outcome: VerbatimIngestResult = await verbatimIngestor.ingest(verbatimItem);
          result = {
            label: item.label,
            runId: null,
            status: 'done',
            captured: { wiki: [outcome.pageKey], sl: [], xrefs: [] },
            commitHash: outcome.commitHash,
            error: null,
          };
        } else {
          // memoryIngest is set whenever verbatim is off — they are mutually exclusive.
          if (!memoryIngest) {
            throw new Error('Memory ingest was not initialized.');
          }
          const ingestInput: MemoryAgentInput = {
            userId: args.userId,
            chatId: `cli-text-ingest-${batchId}-${index + 1}`,
            userMessage: `Ingest external text artifact ${artifactReference(item.label)} into ktx memory.`,
            assistantMessage: item.content.trim(),
            ...(args.connectionId ? { connectionId: args.connectionId } : {}),
            sourceType: 'external_ingest',
          };
          const ingest = await memoryIngest.ingest(ingestInput);
          runId = ingest.runId;
          await memoryIngest.waitForRun(runId);
          const status = await memoryIngest.status(runId);
          if (!status) {
            throw new Error(`Memory ingest run "${runId}" was not found.`);
          }
          result = resultFromStatus(item.label, status);
        }
      } catch (error) {
        result = errorResult(item.label, runId, error);
      }

      results.push(result);
      target.elapsedMs = now() - (target.startedAt ?? now());
      target.detailLine = null;
      target.status = result.status === 'done' ? 'done' : 'failed';
      target.summaryText = result.status === 'done' ? summarizeCaptured(result.captured) : null;
      target.failureText = result.status === 'error' ? result.error : null;
      paint();

      if (result.status === 'error' && args.failFast) {
        break;
      }
    }
  } finally {
    if (spinnerInterval) {
      clearInterval(spinnerInterval);
    }
  }

  if (state.startedAt !== null) {
    state.totalElapsedMs = now() - state.startedAt;
  }

  if (args.json) {
    writeJsonResult(args, results, io);
  } else if (repainter) {
    repainter.paint(renderTextIngestView(state, true, isVerbatim));
    writePlainFailures(results, io);
  } else {
    io.stdout.write(renderTextIngestView(state, false, isVerbatim));
    writePlainFailures(results, io);
  }

  if (!args.json && results.length > 0) {
    const duration = state.totalElapsedMs > 0 ? ` in ${formatDuration(state.totalElapsedMs)}` : '';
    const outcome = results.some((result) => result.status === 'error') ? 'finished with failures' : 'finished';
    const label = isVerbatim ? 'Verbatim ingest' : 'Text memory ingest';
    io.stdout.write(`${label} ${outcome}${duration}.\n`);
  }

  return results.some((result) => result.status === 'error') ? 1 : 0;
}
