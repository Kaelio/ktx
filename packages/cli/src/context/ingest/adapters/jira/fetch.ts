import { mkdir, readdir, readFile, rm, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { JiraClient } from './client.js';
import { JIRA_SOURCE_KEY, type JiraManifest, type JiraPullConfig, STAGED_FILES, stagedIssueSchema } from './types.js';

export interface JiraFetchLogger {
  warn(message: string): void;
}

interface FetchJiraSnapshotParams {
  config: JiraPullConfig;
  stagedDir: string;
  logger?: JiraFetchLogger;
}

async function writeJson(path: string, value: unknown): Promise<void> {
  await mkdir(join(path, '..'), { recursive: true });
  await writeFile(path, `${JSON.stringify(value, null, 2)}\n`, 'utf-8');
}

function buildJql(projects: string[], labels: string[], effectiveSince?: string): string {
  const projectList = projects.map((p) => `"${p}"`).join(',');
  const labelList = labels.map((l) => `"${l}"`).join(',');
  const datePart = effectiveSince ? ` AND updated >= "${effectiveSince}"` : '';
  return `project IN (${projectList}) AND labels IN (${labelList})${datePart} ORDER BY updated DESC`;
}

/** Returns the max `updated` ISO string across all valid staged issues, or null if none exist. */
async function maxUpdatedFromStagedIssues(issuesDir: string): Promise<string | null> {
  let entries: string[];
  try {
    entries = await readdir(issuesDir);
  } catch {
    return null;
  }
  let max: string | null = null;
  for (const entry of entries.filter((e) => e.endsWith('.json'))) {
    try {
      const raw = JSON.parse(await readFile(join(issuesDir, entry), 'utf-8'));
      const issue = stagedIssueSchema.safeParse(raw);
      if (issue.success && issue.data.updated && (!max || issue.data.updated > max)) {
        max = issue.data.updated;
      }
    } catch {
      // skip unparseable files
    }
  }
  return max;
}

export async function fetchJiraSnapshot({ config, stagedDir, logger }: FetchJiraSnapshotParams): Promise<void> {
  const issuesDir = join(stagedDir, STAGED_FILES.issuesDir);

  // Derive the incremental floor from the most recently updated staged issue.
  // When present: keep existing issues and only fetch updates since that timestamp.
  // When absent (first run): full eviction, use static since from config.
  const latestUpdated = await maxUpdatedFromStagedIssues(issuesDir);
  const effectiveSince = latestUpdated ?? config.since;
  const incremental = latestUpdated !== null;

  if (!incremental) {
    await rm(issuesDir, { recursive: true, force: true });
  }
  await mkdir(issuesDir, { recursive: true });

  const client = new JiraClient(config);
  const jql = buildJql(config.projects, config.labels, effectiveSince);

  let issueCount = 0;
  const warnings: string[] = [];

  try {
    for await (const issue of client.searchIssues(jql)) {
      issueCount += 1;
      await writeJson(join(issuesDir, `${issue.key}.json`), issue);
    }
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    warnings.push(`Jira fetch error: ${message}`);
    logger?.warn(`Jira fetch error: ${message}`);
  }

  const manifest: JiraManifest = {
    source: JIRA_SOURCE_KEY,
    fetchedAt: new Date().toISOString(),
    baseUrl: config.baseUrl,
    projects: config.projects,
    labels: config.labels,
    since: effectiveSince ?? null,
    issueCount,
    warnings,
  };

  await writeJson(join(stagedDir, STAGED_FILES.manifest), manifest);
}
