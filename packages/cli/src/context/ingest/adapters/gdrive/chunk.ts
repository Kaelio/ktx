import { createHash } from 'node:crypto';
import { readdir, readFile } from 'node:fs/promises';
import { join, relative } from 'node:path';
import type { ChunkResult, DiffSet, ScopeDescriptor, WorkUnit } from '../../types.js';
import { gdriveManifestSchema, gdriveMetadataSchema } from './types.js';

const GDRIVE_RECONCILE_GUIDANCE =
  'Synthesize durable wiki knowledge from this Google Doc. Preserve product definitions, process documentation, and operating rules as wiki pages. Do not create semantic-layer sources from gdrive content in v1.';

function normalizeRawPath(path: string): string {
  return path.replace(/\\/g, '/');
}

async function walk(root: string): Promise<string[]> {
  const entries = await readdir(root, { withFileTypes: true, recursive: true });
  return entries
    .filter((entry) => entry.isFile())
    .map((entry) => normalizeRawPath(relative(root, join(entry.parentPath, entry.name))))
    .sort();
}

function safeUnitKey(path: string): string {
  return `gdrive-${path.replace(/^docs\//, '').replace(/\/page\.md$/, '').replace(/[^a-zA-Z0-9]+/g, '-').replace(/^-+|-+$/g, '')}`;
}

async function readManifest(stagedDir: string) {
  try {
    return gdriveManifestSchema.parse(JSON.parse(await readFile(join(stagedDir, 'manifest.json'), 'utf-8')));
  } catch (error) {
    throw new Error(`Invalid gdrive manifest: ${error instanceof Error ? error.message : String(error)}`);
  }
}

export async function chunkGdriveStagedDir(stagedDir: string, diffSet?: DiffSet): Promise<ChunkResult> {
  const files = await walk(stagedDir);
  const manifest = await readManifest(stagedDir);
  const touched = diffSet
    ? new Set([...diffSet.added, ...diffSet.modified].map((path) => normalizeRawPath(path)))
    : null;
  const workUnits: WorkUnit[] = [];

  for (const pagePath of files.filter((path) => path.endsWith('/page.md'))) {
    const metadataPath = pagePath.replace(/\/page\.md$/, '/metadata.json');
    const primary = [metadataPath, pagePath].filter((path) => files.includes(path));
    if (touched && !primary.some((path) => touched.has(path))) {
      continue;
    }
    const metadata = gdriveMetadataSchema.parse(JSON.parse(await readFile(join(stagedDir, metadataPath), 'utf-8')));
    const rawFiles = touched ? primary.filter((path) => touched.has(path)).sort() : primary.sort();
    const dependencyPaths = ['manifest.json'].filter((path) => !rawFiles.includes(path));
    const excluded = new Set([...rawFiles, ...dependencyPaths]);
    const peerFileIndex = files.filter((path) => !excluded.has(path)).sort();
    workUnits.push({
      unitKey: safeUnitKey(pagePath),
      displayLabel: metadata.path,
      rawFiles,
      dependencyPaths,
      peerFileIndex,
      notes: GDRIVE_RECONCILE_GUIDANCE,
    });
  }

  return {
    workUnits,
    eviction:
      diffSet && diffSet.deleted.length > 0
        ? { deletedRawPaths: diffSet.deleted.map((path) => normalizeRawPath(path)).sort() }
        : undefined,
    reconcileNotes: ['Google Drive docs are knowledge-only in v1; keep output in wiki pages unless later follow-up work expands scope.'],
    contextReport: { capped: false, warnings: manifest.warnings },
  };
}

export async function describeGdriveScope(stagedDir: string): Promise<ScopeDescriptor> {
  const manifest = await readManifest(stagedDir);
  const scopeKey = JSON.stringify({
    folderId: manifest.folderId,
    recursive: manifest.recursive,
  });
  const fingerprint = createHash('sha256').update(scopeKey).digest('hex');
  return {
    fingerprint,
    isPathInScope: (rawPath) => rawPath === 'manifest.json' || rawPath.startsWith('docs/'),
  };
}
