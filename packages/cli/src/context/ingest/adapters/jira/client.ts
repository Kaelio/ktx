import type { JiraPullConfig, StagedIssue } from './types.js';
import { adfToMarkdown } from './adf-to-markdown.js';

interface JiraIssueFields {
  summary: string;
  description: unknown;
  status: { name: string };
  issuetype: { name: string };
  labels: string[];
  project: { key: string; name: string };
  created: string;
  updated: string;
  assignee: { displayName: string } | null;
  priority: { name: string } | null;
}

interface JiraIssueRaw {
  id: string;
  key: string;
  fields: JiraIssueFields;
}

interface JiraSearchResponse {
  issues: JiraIssueRaw[];
  nextPageToken?: string;
}

const FIELDS = ['summary', 'description', 'status', 'labels', 'project', 'issuetype', 'created', 'updated', 'assignee', 'priority'];
const PAGE_SIZE = 100;

export class JiraClient {
  private readonly auth: string;

  constructor(private readonly config: JiraPullConfig) {
    this.auth = `Basic ${Buffer.from(`${config.email}:${config.apiToken}`).toString('base64')}`;
  }

  private async request<T>(path: string): Promise<T> {
    const url = `${this.config.baseUrl}${path}`;
    const response = await fetch(url, {
      headers: { Authorization: this.auth, Accept: 'application/json' },
    });
    if (!response.ok) {
      const body = await response.text().catch(() => '');
      throw new Error(`Jira API ${response.status} ${response.statusText} at ${path}: ${body.slice(0, 200)}`);
    }
    return response.json() as Promise<T>;
  }

  async *searchIssues(jql: string): AsyncGenerator<StagedIssue> {
    let nextPageToken: string | undefined;

    do {
      const params = new URLSearchParams({
        jql,
        maxResults: String(PAGE_SIZE),
        fields: FIELDS.join(','),
        ...(nextPageToken ? { nextPageToken } : {}),
      });

      const result = await this.request<JiraSearchResponse>(`/rest/api/3/search/jql?${params.toString()}`);

      for (const raw of result.issues ?? []) {
        yield this.toStagedIssue(raw);
      }

      nextPageToken = result.nextPageToken;
    } while (nextPageToken);
  }

  private toStagedIssue(raw: JiraIssueRaw): StagedIssue {
    const f = raw.fields;
    return {
      id: raw.id,
      key: raw.key,
      summary: f.summary,
      description: f.description ? adfToMarkdown(f.description) : null,
      status: f.status?.name ?? 'Unknown',
      issuetype: f.issuetype?.name ?? 'Unknown',
      labels: f.labels ?? [],
      project: { key: f.project?.key ?? '', name: f.project?.name ?? '' },
      created: f.created,
      updated: f.updated,
      assignee: f.assignee?.displayName ?? null,
      priority: f.priority?.name ?? null,
      url: `${this.config.baseUrl}/browse/${raw.key}`,
    };
  }
}
