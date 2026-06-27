import { mkdir, rm, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { JiraClient } from './client.js';
import { JIRA_SOURCE_KEY, type JiraManifest, type JiraPullConfig, STAGED_FILES } from './types.js';

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

function buildJql(projects: string[], labels: string[], since?: string): string {
  const projectList = projects.map((p) => `"${p}"`).join(',');
  const labelList = labels.map((l) => `"${l}"`).join(',');
  const datePart = since ? ` AND updated >= "${since}"` : '';
  return `project IN (${projectList}) AND labels IN (${labelList})${datePart} ORDER BY updated DESC`;
}

export async function fetchJiraSnapshot({ config, stagedDir, logger }: FetchJiraSnapshotParams): Promise<void> {
  const issuesDir = join(stagedDir, STAGED_FILES.issuesDir);
  // Clear previous issues to evict stale entries on each full fetch.
  await rm(issuesDir, { recursive: true, force: true });
  await mkdir(issuesDir, { recursive: true });

  const client = new JiraClient(config);
  const jql = buildJql(config.projects, config.labels, config.since);

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
    since: config.since ?? null,
    issueCount,
    warnings,
  };

  await writeJson(join(stagedDir, STAGED_FILES.manifest), manifest);
}
