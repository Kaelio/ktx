import { mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { isDeepStrictEqual } from 'node:util';
import YAML from 'yaml';
import type { KtxModelRole } from '../../llm/types.js';
import { stableContentHash } from '../cache/content-result-cache.js';
import type { GitService } from '../core/git.service.js';
import type { MemoryAction } from '../memory/types.js';
import type { TouchedSlSource } from '../tools/touched-sl-sources.js';
import type { IngestTraceWriter } from './ingest-trace.js';
import type { IngestSessionWorktreePort } from './ports.js';
import type { WorkUnit } from './types.js';

export const INGEST_WORK_UNIT_CACHE_NAMESPACE = 'ingest:work-unit';

export interface IngestWorkUnitCachedArtifactFile {
  path: string;
  beforeBase64: string | null;
  afterBase64: string | null;
}

export interface IngestWorkUnitCachePayload {
  schemaVersion: 2;
  unitKey: string;
  patchTouchedPaths: string[];
  // Replay re-derives the patch from these before/after snapshots; the diff text
  // itself is never stored, so the payload carries each touched file only once.
  artifactFiles: IngestWorkUnitCachedArtifactFile[];
  actions: MemoryAction[];
  touchedSlSources: TouchedSlSource[];
  slDisallowed?: boolean;
  slDisallowedReason?: 'lookml_connection_mismatch';
}

export interface ComputeIngestWorkUnitInputHashInput {
  stagedDir: string;
  connectionId: string;
  sourceKey: string;
  unit: WorkUnit;
  cliVersion: string;
  promptFingerprint: string;
  modelRole: KtxModelRole;
}

async function fileDigest(
  stagedDir: string,
  path: string,
): Promise<{ path: string; status: 'present' | 'missing'; hash: string | null }> {
  try {
    const bytes = await readFile(join(stagedDir, path));
    return { path, status: 'present', hash: stableContentHash(bytes.toString('base64')) };
  } catch (error) {
    if (error && typeof error === 'object' && 'code' in error && error.code === 'ENOENT') {
      return { path, status: 'missing', hash: null };
    }
    throw error;
  }
}

export async function computeIngestWorkUnitInputHash(input: ComputeIngestWorkUnitInputHashInput): Promise<string> {
  const rawFiles = [...input.unit.rawFiles].sort();
  const dependencyPaths = [...input.unit.dependencyPaths].sort();
  const [raw, dependencies] = await Promise.all([
    Promise.all(rawFiles.map((path) => fileDigest(input.stagedDir, path))),
    Promise.all(dependencyPaths.map((path) => fileDigest(input.stagedDir, path))),
  ]);

  return stableContentHash({
    schemaVersion: 2,
    connectionId: input.connectionId,
    sourceKey: input.sourceKey,
    unitKey: input.unit.unitKey,
    rawFiles: raw,
    dependencyPaths: dependencies,
    slDisallowed: input.unit.slDisallowed === true,
    slDisallowedReason: input.unit.slDisallowedReason ?? null,
    cliVersion: input.cliVersion,
    promptFingerprint: input.promptFingerprint,
    modelRole: input.modelRole,
  });
}

async function readFileBase64(workdir: string, path: string): Promise<string | null> {
  try {
    return (await readFile(join(workdir, path))).toString('base64');
  } catch (error) {
    if (error && typeof error === 'object' && 'code' in error && error.code === 'ENOENT') {
      return null;
    }
    throw error;
  }
}

async function readGitFileBase64(git: GitService, path: string, commitSha: string): Promise<string | null> {
  try {
    return Buffer.from(await git.getFileAtCommit(path, commitSha), 'utf-8').toString('base64');
  } catch {
    return null;
  }
}

function decodeBase64(value: string | null): string | null {
  return value === null ? null : Buffer.from(value, 'base64').toString('utf-8');
}

function parseYamlObject(content: string): Record<string, unknown> | null {
  const parsed = YAML.parse(content);
  return parsed && typeof parsed === 'object' && !Array.isArray(parsed) ? (parsed as Record<string, unknown>) : null;
}

function isSubsequenceOfDeepValues(current: unknown[], output: unknown[]): boolean {
  let outputIndex = 0;
  for (const item of current) {
    while (outputIndex < output.length && !isDeepStrictEqual(item, output[outputIndex])) {
      outputIndex += 1;
    }
    if (outputIndex >= output.length) {
      return false;
    }
    outputIndex += 1;
  }
  return true;
}

function isSemanticLayerPruneShape(current: string, output: string): boolean {
  const currentYaml = parseYamlObject(current);
  const outputYaml = parseYamlObject(output);
  if (!currentYaml || !outputYaml) {
    return false;
  }
  const currentJoins = Array.isArray(currentYaml.joins) ? currentYaml.joins : [];
  const outputJoins = Array.isArray(outputYaml.joins) ? outputYaml.joins : [];
  if (currentJoins.length >= outputJoins.length) {
    return false;
  }
  if (!isSubsequenceOfDeepValues(currentJoins, outputJoins)) {
    return false;
  }
  const normalizedOutput = { ...outputYaml, joins: currentJoins };
  return isDeepStrictEqual(currentYaml, normalizedOutput);
}

function parseWikiPage(raw: string): { frontmatter: Record<string, unknown>; content: string } | null {
  const match = raw.match(/^---\n([\s\S]*?)\n---\n?([\s\S]*)$/);
  if (!match) {
    return null;
  }
  const frontmatter = YAML.parse(match[1] ?? '') as Record<string, unknown>;
  return { frontmatter, content: (match[2] ?? '').trim() };
}

function withoutRemovedWikiTokens(output: string, current: string): string {
  let projected = output;
  for (const match of output.matchAll(/\[\[\s*([^|\]\n]+)(?:\|[^\]\n]+)?\s*\]\]/g)) {
    const token = match[0] ?? '';
    if (token && !current.includes(token)) {
      projected = projected.replaceAll(token, '').replace(/[ \t]+([.,;:!?])/g, '$1');
    }
  }
  for (const match of output.matchAll(/`([^`\n]+)`/g)) {
    const token = match[0] ?? '';
    if (token && !current.includes(token)) {
      projected = projected.replaceAll(token, '').replace(/[ \t]+([.,;:!?])/g, '$1');
    }
  }
  projected = projected.replace(/,\s*,/g, ',').replace(/[ \t]+([.,;:!?])/g, '$1');
  return projected.trim();
}

function isWikiPruneShape(current: string, output: string): boolean {
  const currentPage = parseWikiPage(current);
  const outputPage = parseWikiPage(output);
  if (!currentPage || !outputPage) {
    return false;
  }
  const currentRefs = Array.isArray(currentPage.frontmatter.refs) ? currentPage.frontmatter.refs : [];
  const outputRefs = Array.isArray(outputPage.frontmatter.refs) ? outputPage.frontmatter.refs : [];
  const currentSlRefs = Array.isArray(currentPage.frontmatter.sl_refs) ? currentPage.frontmatter.sl_refs : [];
  const outputSlRefs = Array.isArray(outputPage.frontmatter.sl_refs) ? outputPage.frontmatter.sl_refs : [];
  if (currentRefs.length > outputRefs.length || currentSlRefs.length > outputSlRefs.length) {
    return false;
  }
  if (!isSubsequenceOfDeepValues(currentRefs, outputRefs) || !isSubsequenceOfDeepValues(currentSlRefs, outputSlRefs)) {
    return false;
  }
  const normalizedOutputFrontmatter = {
    ...outputPage.frontmatter,
    refs: currentRefs,
    sl_refs: currentSlRefs,
  };
  if (!isDeepStrictEqual(currentPage.frontmatter, normalizedOutputFrontmatter)) {
    return false;
  }
  return withoutRemovedWikiTokens(outputPage.content, currentPage.content) === currentPage.content.trim();
}

/** @internal */
export function isPruneShapedCachedReplayBase(path: string, currentContent: string, outputContent: string): boolean {
  if (path.startsWith('semantic-layer/') && path.endsWith('.yaml')) {
    return isSemanticLayerPruneShape(currentContent, outputContent);
  }
  if (path.startsWith('wiki/') && path.endsWith('.md')) {
    return isWikiPruneShape(currentContent, outputContent);
  }
  return false;
}

export async function captureIngestWorkUnitCachedArtifactFiles(input: {
  git: GitService;
  workdir: string;
  baseSha: string;
  patchTouchedPaths: string[];
}): Promise<IngestWorkUnitCachedArtifactFile[]> {
  const paths = [...new Set(input.patchTouchedPaths)].sort();
  return Promise.all(
    paths.map(async (path) => ({
      path,
      beforeBase64: await readGitFileBase64(input.git, path, input.baseSha),
      afterBase64: await readFileBase64(input.workdir, path),
    })),
  );
}

async function writeCachedFile(workdir: string, file: IngestWorkUnitCachedArtifactFile): Promise<void> {
  const target = join(workdir, file.path);
  if (file.afterBase64 === null) {
    await rm(target, { force: true });
    return;
  }
  await mkdir(dirname(target), { recursive: true });
  await writeFile(target, Buffer.from(file.afterBase64, 'base64'));
}

function cacheFileCanReplayFromCurrentBase(file: IngestWorkUnitCachedArtifactFile, currentBase64: string | null): boolean {
  if (currentBase64 === file.beforeBase64 || currentBase64 === file.afterBase64) {
    return true;
  }
  const current = decodeBase64(currentBase64);
  const output = decodeBase64(file.afterBase64);
  if (current === null || output === null) {
    return false;
  }
  return isPruneShapedCachedReplayBase(file.path, current, output);
}

export async function materializeCachedWorkUnitReplayPatch(input: {
  sessionWorktreeService: IngestSessionWorktreePort;
  baseSha: string;
  jobId: string;
  unitKey: string;
  patchPath: string;
  artifactFiles: IngestWorkUnitCachedArtifactFile[];
  author: { name: string; email: string };
  trace: IngestTraceWriter;
}): Promise<'materialized' | 'unsafe_drift'> {
  const replay = await input.sessionWorktreeService.create(`${input.jobId}-${input.unitKey}-cache-replay`, input.baseSha);
  let cleanup: 'success' | 'crash' = 'crash';
  try {
    for (const file of input.artifactFiles) {
      const currentBase64 = await readFileBase64(replay.workdir, file.path);
      if (!cacheFileCanReplayFromCurrentBase(file, currentBase64)) {
        cleanup = 'success';
        return 'unsafe_drift';
      }
    }
    for (const file of input.artifactFiles) {
      await writeCachedFile(replay.workdir, file);
    }
    const changedPaths = await replay.git.changedPaths();
    if (changedPaths.length > 0) {
      await replay.git.commitFiles(
        changedPaths,
        `ingest: materialize cached WorkUnit ${input.unitKey}`,
        input.author.name,
        input.author.email,
      );
    }
    await replay.git.writeBinaryNoRenamePatch(input.baseSha, 'HEAD', input.patchPath);
    await input.trace.event('debug', 'work_unit', 'work_unit_cache_patch_materialized', {
      unitKey: input.unitKey,
      patchPath: input.patchPath,
      touchedPaths: changedPaths,
    });
    cleanup = 'success';
    return 'materialized';
  } finally {
    await input.sessionWorktreeService.cleanup(replay, cleanup);
  }
}

export function ingestWorkUnitCacheScopeKey(input: { connectionId: string; sourceKey: string }): string {
  return `${input.connectionId}:${input.sourceKey}`;
}

export function computeIngestWorkUnitPromptFingerprint(input: {
  cliVersion: string;
  baseFraming: string;
  skillsPrompt: string;
  canonicalPins: unknown[];
  sourceKey: string;
  connectionId: string;
  skillNames: string[];
}): string {
  return stableContentHash({
    schemaVersion: 1,
    cliVersion: input.cliVersion,
    baseFraming: input.baseFraming,
    skillsPrompt: input.skillsPrompt,
    canonicalPins: input.canonicalPins,
    sourceKey: input.sourceKey,
    connectionId: input.connectionId,
    skillNames: [...input.skillNames].sort(),
  });
}
