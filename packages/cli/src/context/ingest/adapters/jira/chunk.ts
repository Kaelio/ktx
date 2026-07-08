import { readdir, readFile } from 'node:fs/promises';
import { join, relative } from 'node:path';
import type { ChunkResult, DiffSet, ScopeDescriptor, WorkUnit } from '../../types.js';
import { createHash } from 'node:crypto';
import { jiraManifestSchema, stagedIssueSchema, STAGED_FILES } from './types.js';

async function walk(root: string): Promise<string[]> {
  const entries = await readdir(root, { withFileTypes: true, recursive: true });
  return entries
    .filter((entry) => entry.isFile())
    .map((entry) => relative(root, join(entry.parentPath, entry.name)).replace(/\\/g, '/'))
    .sort();
}

async function readManifest(stagedDir: string) {
  try {
    return jiraManifestSchema.parse(JSON.parse(await readFile(join(stagedDir, STAGED_FILES.manifest), 'utf-8')));
  } catch (error) {
    throw new Error(`Invalid Jira manifest: ${error instanceof Error ? error.message : String(error)}`);
  }
}

const JIRA_INGEST_NOTES =
  'Synthesize durable wiki knowledge from these Jira issues. Each issue is a JSON file in issues/. Extract reusable business concepts, decisions, policies, and process rules. Skip transient task descriptions, status updates, and project-management boilerplate. Use context_candidate_write to stage wiki candidates; do not call wiki_write directly from a Jira WorkUnit.';

export async function chunkJiraStagedDir(stagedDir: string, diffSet?: DiffSet): Promise<ChunkResult> {
  const files = await walk(stagedDir);
  const manifest = await readManifest(stagedDir);
  const touched = diffSet ? new Set([...diffSet.added, ...diffSet.modified]) : null;

  // Group issue files by project key.
  const byProject = new Map<string, string[]>();
  for (const file of files.filter((f) => f.startsWith(`${STAGED_FILES.issuesDir}/`) && f.endsWith('.json'))) {
    const raw = await readFile(join(stagedDir, file), 'utf-8').catch(() => null);
    if (!raw) continue;
    const issue = stagedIssueSchema.safeParse(JSON.parse(raw));
    if (!issue.success) continue;
    const projectKey = issue.data.project.key;
    if (!byProject.has(projectKey)) byProject.set(projectKey, []);
    byProject.get(projectKey)!.push(file);
  }

  const workUnits: WorkUnit[] = [];

  for (const [projectKey, issuePaths] of byProject.entries()) {
    const rawFiles = touched
      ? issuePaths.filter((path) => touched.has(path)).sort()
      : issuePaths.sort();

    if (touched && rawFiles.length === 0) continue;

    const dependencyPaths = [STAGED_FILES.manifest].filter((p) => !rawFiles.includes(p));
    const excluded = new Set([...rawFiles, ...dependencyPaths]);
    const peerFileIndex = files.filter((f) => !excluded.has(f)).sort();

    workUnits.push({
      unitKey: `jira-${projectKey.toLowerCase()}`,
      displayLabel: `Jira: ${projectKey} (${issuePaths.length} issue${issuePaths.length === 1 ? '' : 's'})`,
      rawFiles,
      dependencyPaths,
      peerFileIndex,
      notes: JIRA_INGEST_NOTES,
    });
  }

  return {
    workUnits,
    eviction: diffSet && diffSet.deleted.length > 0 ? { deletedRawPaths: [...diffSet.deleted].sort() } : undefined,
    reconcileNotes: [
      `Jira projects: ${manifest.projects.join(', ')}`,
      `Jira label filter: ${manifest.labels.join(', ')}`,
      'Issues are filtered by label — every staged issue matches at least one configured label.',
      manifest.since ? `Fetched issues updated on or after ${manifest.since}.` : '',
    ].filter(Boolean),
    contextReport: {
      warnings: manifest.warnings,
    },
  };
}

export async function describeJiraScope(stagedDir: string): Promise<ScopeDescriptor> {
  const manifest = await readManifest(stagedDir);
  const scopeKey = JSON.stringify({ projects: [...manifest.projects].sort(), labels: [...manifest.labels].sort() });
  const fingerprint = createHash('sha256').update(scopeKey).digest('hex');

  return {
    fingerprint,
    isPathInScope: (rawPath) => rawPath === STAGED_FILES.manifest || rawPath.startsWith(`${STAGED_FILES.issuesDir}/`),
  };
}
