import { createHash } from 'node:crypto';
import { cp, mkdir, readdir, readFile, rm } from 'node:fs/promises';
import { isAbsolute, join, relative, resolve, sep } from 'node:path';
import type { KtxLocalProject } from '../../context/project/project.js';
import { ktxLocalStateDbPath } from '../project/local-state-db.js';
import { computeDiffSetFromHashes } from './diff-set.service.js';
import { localPullConfigForAdapter } from './local-adapters.js';
import { sanitizeMemoryFlowError } from './memory-flow/live-buffer.js';
import type { MemoryFlowEventSink, MemoryFlowPlannedWorkUnit } from './memory-flow/types.js';
import { buildSyncId } from './raw-sources-paths.js';
import { SqliteLocalIngestStore } from './sqlite-local-ingest-store.js';
import type { KtxTableRefKey } from '../scan/table-ref.js';
import type { IngestTrigger, SourceAdapter, SourceFetchReport, WorkUnit } from './types.js';

type LocalIngestStatus = 'running' | 'done' | 'error';

interface LocalIngestDiffPaths {
  added: string[];
  modified: string[];
  deleted: string[];
  unchanged: string[];
}

export interface LocalIngestRunRecord {
  runId: string;
  jobId: string;
  status: LocalIngestStatus;
  adapter: string;
  connectionId: string;
  sourceDir: string | null;
  syncId: string;
  startedAt: string;
  completedAt: string;
  progress: number;
  done: boolean;
  previousRunId: string | null;
  diffSummary: {
    added: number;
    modified: number;
    deleted: number;
    unchanged: number;
  };
  diffPaths: LocalIngestDiffPaths;
  workUnitCount: number;
  rawFileCount: number;
  workUnits: Array<Pick<WorkUnit, 'unitKey' | 'rawFiles' | 'peerFileIndex' | 'dependencyPaths'>>;
  evictionDeletedRawPaths: string[];
  errors: string[];
  /** Fetch-phase outcome (e.g. objects skipped during introspection). */
  fetch?: SourceFetchReport;
}

export type LocalIngestReport = LocalIngestRunRecord & {
  rawContentHashes: Record<string, string>;
};

export interface RunLocalStageOnlyIngestOptions {
  project: KtxLocalProject;
  adapters: SourceAdapter[];
  adapter: string;
  connectionId: string;
  sourceDir?: string;
  trigger?: IngestTrigger;
  jobId?: string;
  now?: () => Date;
  dryRun?: boolean;
  memoryFlow?: MemoryFlowEventSink;
  tableScope?: ReadonlySet<KtxTableRefKey>;
}

const LOCAL_AUTHOR = 'ktx';
const LOCAL_AUTHOR_EMAIL = 'ktx@example.com';

function safeSegment(kind: string, value: string): string {
  if (!/^[a-zA-Z0-9_][a-zA-Z0-9_-]*$/.test(value)) {
    throw new Error(`Unsafe ${kind}: ${value}`);
  }
  return value;
}

function normalizeRelativePath(filePath: string): string {
  return filePath.replaceAll('\\', '/');
}

function assertInside(rootDir: string, childPath: string): string {
  const root = resolve(rootDir);
  const child = resolve(childPath);
  if (child !== root && !child.startsWith(`${root}${sep}`)) {
    throw new Error(`Path escapes root directory: ${childPath}`);
  }
  return child;
}

async function walkFiles(rootDir: string, currentDir = rootDir): Promise<string[]> {
  const entries = await readdir(currentDir, { withFileTypes: true });
  const files: string[] = [];
  for (const entry of entries) {
    const absolutePath = join(currentDir, entry.name);
    if (entry.isDirectory()) {
      files.push(...(await walkFiles(rootDir, absolutePath)));
      continue;
    }
    if (entry.isFile()) {
      files.push(normalizeRelativePath(relative(rootDir, absolutePath)));
    }
  }
  return files.sort();
}

async function hashFile(path: string): Promise<string> {
  const content = await readFile(path);
  return createHash('sha256').update(content).digest('hex');
}

function stableLiveDatabaseHashContent(relativePath: string, content: Buffer): Buffer | string {
  if (relativePath !== 'connection.json') {
    return content;
  }

  try {
    const parsed = JSON.parse(content.toString('utf-8')) as unknown;
    if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) {
      return content;
    }
    const stable = { ...(parsed as Record<string, unknown>) };
    delete stable.extractedAt;
    return `${JSON.stringify(stable)}\n`;
  } catch {
    return content;
  }
}

async function hashStagedFile(adapter: SourceAdapter, stagedDir: string, relativePath: string): Promise<string> {
  const absolutePath = join(stagedDir, relativePath);
  if (adapter.source !== 'live-database') {
    return hashFile(absolutePath);
  }
  const content = await readFile(absolutePath);
  return createHash('sha256').update(stableLiveDatabaseHashContent(relativePath, content)).digest('hex');
}

function findAdapter(adapters: SourceAdapter[], source: string): SourceAdapter {
  const adapter = adapters.find((candidate) => candidate.source === source);
  if (!adapter) {
    throw new Error(`Adapter "${source}" is not available for local ingest`);
  }
  return adapter;
}

function assertConfigured(project: KtxLocalProject, adapter: string, connectionId: string): void {
  if (!project.config.connections[connectionId]) {
    throw new Error(`Connection "${connectionId}" is not configured in ktx.yaml`);
  }
  if (!project.config.ingest.adapters.includes(adapter)) {
    throw new Error(`Adapter "${adapter}" is not enabled in ktx.yaml`);
  }
}

function createLocalIngestStore(project: KtxLocalProject): SqliteLocalIngestStore {
  return new SqliteLocalIngestStore({ dbPath: ktxLocalStateDbPath(project) });
}

function buildLocalJobId(now: Date): string {
  return `local-${now.getTime().toString(36)}`;
}

function assertCompatibleExistingRun(
  existingRun: LocalIngestRunRecord | null,
  runId: string,
  adapter: string,
  connectionId: string,
): void {
  if (!existingRun) {
    return;
  }
  if (existingRun.adapter === adapter && existingRun.connectionId === connectionId) {
    return;
  }
  throw new Error(
    `Local ingest run "${runId}" already exists for ${existingRun.connectionId}/${existingRun.adapter} and cannot be reused for ${connectionId}/${adapter}`,
  );
}

function memoryFlowPlannedWorkUnits(
  workUnits: Array<Pick<WorkUnit, 'unitKey' | 'rawFiles' | 'peerFileIndex' | 'dependencyPaths'>>,
): MemoryFlowPlannedWorkUnit[] {
  return workUnits.map((workUnit) => ({
    unitKey: workUnit.unitKey,
    rawFiles: workUnit.rawFiles,
    peerFileCount: workUnit.peerFileIndex.length,
    dependencyCount: workUnit.dependencyPaths.length,
  }));
}

async function pruneStaleRawFiles(input: {
  project: KtxLocalProject;
  rawPrefix: string;
  nextRawPaths: string[];
  adapter: string;
}): Promise<string[]> {
  const existing = await input.project.fileStore.listFiles(input.rawPrefix);
  const nextRawPathSet = new Set(input.nextRawPaths);
  const staleRawPaths = existing.files.filter((path) => !nextRawPathSet.has(path));
  for (const staleRawPath of staleRawPaths) {
    await input.project.fileStore.deleteFile(
      staleRawPath,
      LOCAL_AUTHOR,
      LOCAL_AUTHOR_EMAIL,
      `Remove stale ${input.adapter} raw file: ${staleRawPath}`,
      { skipLock: true },
    );
  }
  return staleRawPaths;
}

async function rawSnapshotContainsFiles(
  project: KtxLocalProject,
  rawPrefix: string,
  relativeFiles: string[],
): Promise<boolean> {
  const existing = await project.fileStore.listFiles(rawPrefix);
  const existingFiles = new Set(existing.files);
  return relativeFiles.every((file) => existingFiles.has(`${rawPrefix}/${file}`));
}

async function prepareLocalStagedDir(
  project: KtxLocalProject,
  adapter: SourceAdapter,
  stagedDir: string,
  sourceDir: string | undefined,
  connectionId: string,
  tableScope: ReadonlySet<KtxTableRefKey> | undefined,
): Promise<string | null> {
  await rm(stagedDir, { recursive: true, force: true });
  await mkdir(stagedDir, { recursive: true });
  if (sourceDir) {
    if (!isAbsolute(sourceDir)) {
      throw new Error('sourceDir must be an absolute path');
    }
    const resolvedSourceDir = resolve(sourceDir);
    await cp(resolvedSourceDir, stagedDir, { recursive: true });
    return resolvedSourceDir;
  }
  if (!adapter.fetch) {
    throw new Error(
      `Local ingest adapter "${adapter.source}" requires sourceDir because it does not implement fetch().`,
    );
  }
  const pullConfig = await localPullConfigForAdapter(project, adapter, connectionId);
  await adapter.fetch(pullConfig, stagedDir, { connectionId, sourceKey: adapter.source, tableScope });
  return null;
}

export async function runLocalStageOnlyIngest(options: RunLocalStageOnlyIngestOptions): Promise<LocalIngestRunRecord> {
  try {
    return await runLocalStageOnlyIngestInner(options);
  } catch (error) {
    options.memoryFlow?.finish('error', [sanitizeMemoryFlowError(error)]);
    throw error;
  }
}

async function runLocalStageOnlyIngestInner(options: RunLocalStageOnlyIngestOptions): Promise<LocalIngestRunRecord> {
  const started = options.now?.() ?? new Date();
  const jobId = options.jobId ?? buildLocalJobId(started);
  const runId = jobId;
  const adapterName = safeSegment('adapter', options.adapter);
  const connectionId = safeSegment('connection id', options.connectionId);
  assertConfigured(options.project, adapterName, connectionId);
  const adapter = findAdapter(options.adapters, adapterName);
  options.memoryFlow?.update({
    runId,
    connectionId,
    adapter: adapter.source,
    status: 'running',
  });
  const store = createLocalIngestStore(options.project);
  const existingRun = options.dryRun ? null : store.findRunById(runId);
  assertCompatibleExistingRun(existingRun, runId, adapter.source, connectionId);

  const stagedDir = join(options.project.projectDir, '.ktx/cache/local-ingest', runId, 'staged');
  const sourceDir = await prepareLocalStagedDir(
    options.project,
    adapter,
    stagedDir,
    options.sourceDir,
    connectionId,
    options.tableScope,
  );

  const detected = await adapter.detect(stagedDir);
  if (!detected) {
    throw new Error(`Adapter "${adapter.source}" did not recognize ${sourceDir ?? 'fetched source output'}`);
  }

  const fetchReport = adapter.readFetchReport ? await adapter.readFetchReport(stagedDir) : null;

  const relativeFiles = await walkFiles(stagedDir);
  options.memoryFlow?.update({ sourceDir });
  options.memoryFlow?.emit({
    type: 'source_acquired',
    adapter: adapter.source,
    trigger: options.trigger ?? 'manual_resync',
    fileCount: relativeFiles.length,
  });
  const hashes = new Map<string, string>();
  for (const file of relativeFiles) {
    hashes.set(file, await hashStagedFile(adapter, stagedDir, file));
  }
  const latestReport = store.findLatestCompletedReport(connectionId, adapter.source, { excludeRunId: runId });
  const priorHashes = latestReport ? new Map(Object.entries(latestReport.rawContentHashes)) : new Map<string, string>();
  const scopeDescriptor = adapter.describeScope ? await adapter.describeScope(stagedDir) : null;
  options.memoryFlow?.emit({ type: 'scope_detected', fingerprint: scopeDescriptor?.fingerprint ?? null });
  const diffSet = computeDiffSetFromHashes(
    hashes,
    priorHashes,
    scopeDescriptor ? scopeDescriptor.isPathInScope.bind(scopeDescriptor) : undefined,
  );
  const matchesLatestCompletedRun =
    !existingRun &&
    !!latestReport &&
    diffSet.added.length === 0 &&
    diffSet.modified.length === 0 &&
    diffSet.deleted.length === 0;
  const reusableLatestSyncId = matchesLatestCompletedRun ? latestReport.syncId : null;
  const latestRawPrefix = reusableLatestSyncId
    ? `raw-sources/${connectionId}/${adapter.source}/${reusableLatestSyncId}`
    : null;
  const canReuseLatestCompletedRun =
    latestRawPrefix !== null && (await rawSnapshotContainsFiles(options.project, latestRawPrefix, relativeFiles));
  const syncId =
    existingRun?.syncId ?? (canReuseLatestCompletedRun && reusableLatestSyncId ? reusableLatestSyncId : buildSyncId(started, jobId));
  options.memoryFlow?.update({ syncId });
  options.memoryFlow?.emit({ type: 'raw_snapshot_written', syncId, rawFileCount: relativeFiles.length });
  options.memoryFlow?.emit({
    type: 'diff_computed',
    added: diffSet.added.length,
    modified: diffSet.modified.length,
    deleted: diffSet.deleted.length,
    unchanged: diffSet.unchanged.length,
  });
  const chunkResult = await adapter.chunk(stagedDir, diffSet);
  options.memoryFlow?.update({ plannedWorkUnits: memoryFlowPlannedWorkUnits(chunkResult.workUnits) });
  options.memoryFlow?.emit({
    type: 'chunks_planned',
    chunkCount: chunkResult.workUnits.length,
    workUnitCount: chunkResult.workUnits.length,
    evictionCount: chunkResult.eviction?.deletedRawPaths.length ?? 0,
  });
  const rawPrefix = `raw-sources/${connectionId}/${adapter.source}/${syncId}`;
  const rawPaths = relativeFiles.map((file) => `${rawPrefix}/${file}`);
  const staleRawPaths = options.dryRun || canReuseLatestCompletedRun
    ? []
    : await pruneStaleRawFiles({
        project: options.project,
        rawPrefix,
        nextRawPaths: rawPaths,
        adapter: adapter.source,
      });

  for (const file of relativeFiles) {
    const absolutePath = assertInside(stagedDir, join(stagedDir, file));
    const rawPath = `${rawPrefix}/${file}`;
    if (!options.dryRun && !canReuseLatestCompletedRun) {
      await options.project.fileStore.writeFile(
        rawPath,
        await readFile(absolutePath, 'utf-8'),
        LOCAL_AUTHOR,
        LOCAL_AUTHOR_EMAIL,
        `Stage ${adapter.source} raw file: ${file}`,
        { skipLock: true },
      );
    }
  }

  const completed = options.now?.() ?? new Date();
  const record: LocalIngestRunRecord = {
    runId,
    jobId,
    status: 'done',
    adapter: adapter.source,
    connectionId,
    sourceDir,
    syncId,
    startedAt: started.toISOString(),
    completedAt: completed.toISOString(),
    progress: 1,
    done: true,
    previousRunId: latestReport?.runId ?? null,
    diffSummary: {
      added: diffSet.added.length,
      modified: diffSet.modified.length,
      deleted: diffSet.deleted.length,
      unchanged: diffSet.unchanged.length,
    },
    diffPaths: {
      added: diffSet.added,
      modified: diffSet.modified,
      deleted: diffSet.deleted,
      unchanged: diffSet.unchanged,
    },
    workUnitCount: chunkResult.workUnits.length,
    rawFileCount: relativeFiles.length,
    workUnits: chunkResult.workUnits.map((workUnit) => ({
      unitKey: workUnit.unitKey,
      rawFiles: workUnit.rawFiles,
      peerFileIndex: workUnit.peerFileIndex,
      dependencyPaths: workUnit.dependencyPaths,
    })),
    evictionDeletedRawPaths: chunkResult.eviction?.deletedRawPaths ?? [],
    errors: [],
    ...(fetchReport ? { fetch: fetchReport } : {}),
  };

  if (!options.dryRun) {
    store.saveCompletedRun({
      record,
      rawContentHashes: Object.fromEntries(hashes),
    });

    const commitPaths = canReuseLatestCompletedRun ? [] : [...rawPaths, ...staleRawPaths].sort();
    if (commitPaths.length > 0) {
      await options.project.git.commitFiles(
        commitPaths,
        `ingest(${adapter.source}): ${jobId} syncId=${syncId}`,
        LOCAL_AUTHOR,
        LOCAL_AUTHOR_EMAIL,
      );
    }
  }

  options.memoryFlow?.emit({ type: 'report_created', runId });
  options.memoryFlow?.finish(record.status, record.errors);
  return record;
}

export async function getLocalStageOnlyIngestStatus(
  project: KtxLocalProject,
  runId: string,
): Promise<LocalIngestRunRecord | null> {
  return createLocalIngestStore(project).findRunById(runId);
}
