import { readFile } from 'node:fs/promises';
import { join } from 'node:path';
import type { KtxModelRole } from '../../llm/types.js';
import { stableContentHash } from '../cache/content-result-cache.js';
import type { MemoryAction } from '../memory/types.js';
import type { TouchedSlSource } from '../tools/touched-sl-sources.js';
import type { WorkUnit } from './types.js';

export const INGEST_WORK_UNIT_CACHE_NAMESPACE = 'ingest:work-unit';

export interface IngestWorkUnitCachePayload {
  unitKey: string;
  patch: string;
  patchTouchedPaths: string[];
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
    schemaVersion: 1,
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
