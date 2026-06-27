import { z } from 'zod';

export const JIRA_SOURCE_KEY = 'jira';

const jiraPullConfigSchema = z.object({
  baseUrl: z.string().url(),
  email: z.string().min(1),
  apiToken: z.string().min(1),
  /** At least one project key required to bound the JQL query. */
  projects: z.array(z.string().min(1)).min(1, 'At least one project key is required'),
  /** At least one label required to prevent unfiltered exports. */
  labels: z.array(z.string().min(1)).min(1, 'At least one label is required to filter issues'),
  /** ISO date (YYYY-MM-DD). When set, only issues updated on or after this date are fetched. */
  since: z.string().optional(),
});

export type JiraPullConfig = z.infer<typeof jiraPullConfigSchema>;

export function parseJiraPullConfig(raw: unknown): JiraPullConfig {
  return jiraPullConfigSchema.parse(raw);
}

export const jiraManifestSchema = z.object({
  source: z.literal(JIRA_SOURCE_KEY),
  fetchedAt: z.string().datetime(),
  baseUrl: z.string(),
  projects: z.array(z.string()),
  labels: z.array(z.string()),
  since: z.string().nullable(),
  issueCount: z.number().int(),
  warnings: z.array(z.string()).default([]),
});

export type JiraManifest = z.infer<typeof jiraManifestSchema>;

export const stagedIssueSchema = z.object({
  id: z.string(),
  key: z.string(),
  summary: z.string(),
  /** ADF converted to markdown. Null when the issue has no description. */
  description: z.string().nullable(),
  status: z.string(),
  issuetype: z.string(),
  labels: z.array(z.string()),
  project: z.object({ key: z.string(), name: z.string() }),
  created: z.string(),
  updated: z.string(),
  assignee: z.string().nullable(),
  priority: z.string().nullable(),
  url: z.string(),
});

export type StagedIssue = z.infer<typeof stagedIssueSchema>;

export const STAGED_FILES = {
  manifest: 'manifest.json',
  issuesDir: 'issues',
} as const;
