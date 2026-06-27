import { readdir, readFile } from 'node:fs/promises';
import { join, relative } from 'node:path';
import type { ChunkResult, DiffSet, WorkUnit } from '../../types.js';
import {
  type ConfluenceManifest,
  type StagedPageFile,
  confluenceManifestSchema,
  stagedPageFileSchema,
  STAGED_FILES,
} from './types.js';

interface LoadedBundle {
  manifest: ConfluenceManifest | null;
  pagesByPath: Map<string, StagedPageFile>;
  allPaths: string[];
}

async function walkStagedDir(stagedDir: string): Promise<string[]> {
  let entries;
  try {
    entries = await readdir(stagedDir, { withFileTypes: true, recursive: true });
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === 'ENOENT') return [];
    throw err;
  }
  const paths: string[] = [];
  for (const entry of entries) {
    if (!entry.isFile()) continue;
    const abs = join(entry.parentPath, entry.name);
    paths.push(relative(stagedDir, abs).replace(/\\/g, '/'));
  }
  paths.sort();
  return paths;
}

async function loadBundle(stagedDir: string): Promise<LoadedBundle> {
  const allPaths = await walkStagedDir(stagedDir);
  let manifest: ConfluenceManifest | null = null;
  try {
    const body = await readFile(join(stagedDir, STAGED_FILES.manifest), 'utf-8');
    manifest = confluenceManifestSchema.parse(JSON.parse(body));
  } catch {
    manifest = null;
  }

  const pagesByPath = new Map<string, StagedPageFile>();
  const pagesPrefix = `${STAGED_FILES.pagesDir}/`;
  for (const path of allPaths) {
    if (!path.startsWith(pagesPrefix) || !path.endsWith('.json')) continue;
    try {
      const body = await readFile(join(stagedDir, path), 'utf-8');
      const parsed = stagedPageFileSchema.parse(JSON.parse(body));
      pagesByPath.set(path, parsed);
    } catch {
      // Malformed file — skip.
    }
  }

  return { manifest, pagesByPath, allPaths };
}

/** @internal */
export const PAGES_PER_UNIT = 30;

function emitBatches(
  paths: string[],
  pages: Map<string, StagedPageFile>,
  perUnit: number,
  allPaths: string[],
): WorkUnit[] {
  const batches = Math.ceil(paths.length / perUnit) || 0;
  const units: WorkUnit[] = [];
  for (let i = 0; i < batches; i++) {
    const batch = paths.slice(i * perUnit, (i + 1) * perUnit);
    const spaceKeys = [
      ...new Set(batch.map((p) => pages.get(p)?.spaceKey).filter((k): k is string => Boolean(k))),
    ].sort();
    const spaceLabel = spaceKeys.length > 0 ? spaceKeys.join(', ') : 'pages';
    const rawFiles = [...batch, STAGED_FILES.manifest].sort();
    const rawFilesSet = new Set(rawFiles);
    const suffix = batches > 1 ? `-${i}` : '';
    const labelBase =
      batches > 1
        ? `Confluence: ${spaceLabel} (${i + 1}/${batches})`
        : `Confluence: ${spaceLabel}`;
    units.push({
      unitKey: `confluence-pages${suffix}`,
      displayLabel: labelBase,
      rawFiles,
      peerFileIndex: allPaths.filter((p) => !rawFilesSet.has(p)).sort(),
      dependencyPaths: [],
      notes: `${batch.length} Confluence page${batch.length === 1 ? '' : 's'} from space${spaceKeys.length === 1 ? '' : 's'} ${spaceLabel}`,
    });
  }
  return units;
}

interface ChunkOptions {
  diffSet?: DiffSet;
}

export async function chunkConfluenceStagedDir(
  stagedDir: string,
  opts: ChunkOptions = {},
): Promise<ChunkResult> {
  const bundle = await loadBundle(stagedDir);
  if (!bundle.manifest) {
    return { workUnits: [] };
  }

  const pagePaths = [...bundle.pagesByPath.keys()].sort();
  const firstRunUnits = emitBatches(pagePaths, bundle.pagesByPath, PAGES_PER_UNIT, bundle.allPaths);

  if (!opts.diffSet) {
    return { workUnits: firstRunUnits };
  }

  const touched = new Set([...opts.diffSet.added, ...opts.diffSet.modified]);
  const kept: WorkUnit[] = [];
  for (const wu of firstRunUnits) {
    const anyTouched = wu.rawFiles.some((p) => touched.has(p));
    if (!anyTouched) continue;
    const changedFiles = wu.rawFiles.filter((p) => touched.has(p));
    const unchangedFiles = wu.rawFiles.filter((p) => !touched.has(p));
    const deps = new Set([...wu.dependencyPaths, ...unchangedFiles]);
    kept.push({ ...wu, rawFiles: changedFiles.sort(), dependencyPaths: [...deps].sort() });
  }
  const eviction =
    opts.diffSet.deleted.length > 0 ? { deletedRawPaths: [...opts.diffSet.deleted].sort() } : undefined;
  return { workUnits: kept, eviction };
}
