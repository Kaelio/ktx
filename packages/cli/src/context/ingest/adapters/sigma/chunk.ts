import { readdir, readFile } from 'node:fs/promises';
import { join, relative } from 'node:path';
import type { ChunkResult, DiffSet, WorkUnit } from '../../types.js';
import {
  type SigmaManifest,
  type StagedDataModelFile,
  type StagedWorkbookFile,
  sigmaManifestSchema,
  stagedDataModelFileSchema,
  stagedWorkbookFileSchema,
  STAGED_FILES,
} from './types.js';

interface LoadedBundle {
  manifest: SigmaManifest | null;
  dataModelsByPath: Map<string, StagedDataModelFile>;
  workbooksByPath: Map<string, StagedWorkbookFile>;
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
  let manifest: SigmaManifest | null = null;
  try {
    const body = await readFile(join(stagedDir, STAGED_FILES.manifest), 'utf-8');
    manifest = sigmaManifestSchema.parse(JSON.parse(body));
  } catch {
    manifest = null;
  }

  const dataModelsByPath = new Map<string, StagedDataModelFile>();
  const dmPrefix = `${STAGED_FILES.dataModelsDir}/`;
  for (const path of allPaths) {
    if (!path.startsWith(dmPrefix) || !path.endsWith('.json')) continue;
    try {
      const body = await readFile(join(stagedDir, path), 'utf-8');
      const parsed = stagedDataModelFileSchema.parse(JSON.parse(body));
      dataModelsByPath.set(path, parsed);
    } catch {
      // Malformed file — skip.
    }
  }

  const workbooksByPath = new Map<string, StagedWorkbookFile>();
  const wbPrefix = `${STAGED_FILES.workbooksDir}/`;
  for (const path of allPaths) {
    if (!path.startsWith(wbPrefix) || !path.endsWith('.json')) continue;
    try {
      const body = await readFile(join(stagedDir, path), 'utf-8');
      const parsed = stagedWorkbookFileSchema.parse(JSON.parse(body));
      workbooksByPath.set(path, parsed);
    } catch {
      // Malformed file — skip.
    }
  }

  return { manifest, dataModelsByPath, workbooksByPath, allPaths };
}

/** Max data models per LLM work unit. Controls parallel processing granularity. */
const DATA_MODELS_PER_UNIT = 50;
/** Max workbooks per LLM work unit. Controls incremental re-sync granularity. */
const WORKBOOKS_PER_UNIT = 2000;

function emitBatches(
  paths: string[],
  perUnit: number,
  unitKeyBase: string,
  labelBase: string,
  noun: string,
  allPaths: string[],
): WorkUnit[] {
  const batches = Math.ceil(paths.length / perUnit) || 0;
  const units: WorkUnit[] = [];
  for (let i = 0; i < batches; i++) {
    const batch = paths.slice(i * perUnit, (i + 1) * perUnit);
    const rawFiles = [...batch].sort();
    const rawFilesSet = new Set(rawFiles);
    const suffix = batches > 1 ? `-${i}` : '';
    units.push({
      unitKey: `${unitKeyBase}${suffix}`,
      displayLabel: batches > 1 ? `${labelBase} (${i + 1}/${batches})` : labelBase,
      rawFiles,
      peerFileIndex: allPaths.filter((p) => !rawFilesSet.has(p)).sort(),
      dependencyPaths: [],
      notes: `${batch.length} ${noun}${batch.length === 1 ? '' : 's'}`,
    });
  }
  return units;
}

function emitWorkUnits(bundle: LoadedBundle): WorkUnit[] {
  if (!bundle.manifest) return [];
  const dmPaths = [...bundle.dataModelsByPath.keys()].sort();
  const wbPaths = [...bundle.workbooksByPath.keys()].sort();
  return [
    ...emitBatches(dmPaths, DATA_MODELS_PER_UNIT, 'sigma-data-models', 'Sigma: data models', 'data model', bundle.allPaths),
    ...emitBatches(wbPaths, WORKBOOKS_PER_UNIT, 'sigma-workbooks', 'Sigma: workbooks', 'workbook', bundle.allPaths),
  ];
}

interface ChunkOptions {
  diffSet?: DiffSet;
}

export async function chunkSigmaStagedDir(stagedDir: string, opts: ChunkOptions = {}): Promise<ChunkResult> {
  const bundle = await loadBundle(stagedDir);
  if (!bundle.manifest) {
    return { workUnits: [] };
  }

  const firstRunUnits = emitWorkUnits(bundle);
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
