import { readdir, readFile } from 'node:fs/promises';
import { join, relative } from 'node:path';
import type { ChunkResult, DiffSet, WorkUnit } from '../../types.js';
import {
  type StagedDatasourceFile,
  type StagedWorkbookFile,
  type TableauManifest,
  stagedDatasourceFileSchema,
  stagedWorkbookFileSchema,
  tableauManifestSchema,
  STAGED_FILES,
} from './types.js';

interface LoadedBundle {
  manifest: TableauManifest | null;
  datasourcesByPath: Map<string, StagedDatasourceFile>;
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

async function loadTyped<T>(
  stagedDir: string,
  allPaths: string[],
  prefix: string,
  parse: (raw: unknown) => T,
): Promise<Map<string, T>> {
  const byPath = new Map<string, T>();
  for (const path of allPaths) {
    if (!path.startsWith(prefix) || !path.endsWith('.json')) continue;
    try {
      const body = await readFile(join(stagedDir, path), 'utf-8');
      byPath.set(path, parse(JSON.parse(body)));
    } catch {
      // Malformed file — skip.
    }
  }
  return byPath;
}

async function loadBundle(stagedDir: string): Promise<LoadedBundle> {
  const allPaths = await walkStagedDir(stagedDir);
  let manifest: TableauManifest | null = null;
  try {
    const body = await readFile(join(stagedDir, STAGED_FILES.manifest), 'utf-8');
    manifest = tableauManifestSchema.parse(JSON.parse(body));
  } catch {
    manifest = null;
  }

  const datasourcesByPath = await loadTyped(stagedDir, allPaths, `${STAGED_FILES.datasourcesDir}/`, (raw) =>
    stagedDatasourceFileSchema.parse(raw),
  );
  const workbooksByPath = await loadTyped(stagedDir, allPaths, `${STAGED_FILES.workbooksDir}/`, (raw) =>
    stagedWorkbookFileSchema.parse(raw),
  );

  return { manifest, datasourcesByPath, workbooksByPath, allPaths };
}

/** Max data sources per LLM work unit. Controls parallel processing granularity. */
const DATASOURCES_PER_UNIT = 50;
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
  const dsPaths = [...bundle.datasourcesByPath.keys()].sort();
  const wbPaths = [...bundle.workbooksByPath.keys()].sort();
  return [
    ...emitBatches(dsPaths, DATASOURCES_PER_UNIT, 'tableau-datasources', 'Tableau: data sources', 'data source', bundle.allPaths),
    ...emitBatches(wbPaths, WORKBOOKS_PER_UNIT, 'tableau-workbooks', 'Tableau: workbooks', 'workbook', bundle.allPaths),
  ];
}

interface ChunkOptions {
  diffSet?: DiffSet;
}

export async function chunkTableauStagedDir(stagedDir: string, opts: ChunkOptions = {}): Promise<ChunkResult> {
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
