import { mkdir, mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { fetchJiraSnapshot } from '../../../../../src/context/ingest/adapters/jira/fetch.js';
import type { JiraPullConfig } from '../../../../../src/context/ingest/adapters/jira/types.js';

const BASE_CONFIG: JiraPullConfig = {
  baseUrl: 'https://example.atlassian.net',
  email: 'user@example.com',
  apiToken: 'test-token',
  projects: ['DOCS'],
  labels: ['kb'],
};

const mockIssue = (key: string, updated = '2026-06-01T00:00:00.000Z', labels: string[] = ['kb']) => ({
  id: key,
  key,
  fields: {
    summary: `Summary for ${key}`,
    description: null,
    status: { name: 'Done' },
    issuetype: { name: 'Task' },
    labels,
    project: { key: 'DOCS', name: 'Test Docs' },
    created: '2026-01-01T00:00:00.000Z',
    updated,
    assignee: null,
    priority: null,
  },
});

function makeFetchResponse(issues: ReturnType<typeof mockIssue>[], nextPageToken?: string) {
  return { issues, ...(nextPageToken ? { nextPageToken } : {}) };
}

describe('fetchJiraSnapshot', () => {
  let stagedDir: string;

  beforeEach(async () => {
    stagedDir = await mkdtemp(join(tmpdir(), 'jira-fetch-'));
  });

  afterEach(async () => {
    await rm(stagedDir, { recursive: true, force: true });
    vi.restoreAllMocks();
  });

  it('writes issues and manifest on a successful fetch', async () => {
    vi.stubGlobal('fetch', async () => ({
      ok: true,
      json: async () => makeFetchResponse([mockIssue('DOCS-1'), mockIssue('DOCS-2')]),
    }));

    await fetchJiraSnapshot({ config: BASE_CONFIG, stagedDir });

    const manifest = JSON.parse(await readFile(join(stagedDir, 'manifest.json'), 'utf-8'));
    expect(manifest.source).toBe('jira');
    expect(manifest.issueCount).toBe(2);
    expect(manifest.since).toBeNull();

    const issue1 = JSON.parse(await readFile(join(stagedDir, 'issues', 'DOCS-1.json'), 'utf-8'));
    expect(issue1.key).toBe('DOCS-1');
    expect(issue1.url).toBe('https://example.atlassian.net/browse/DOCS-1');
  });

  it('includes since date in manifest and JQL when configured', async () => {
    const capturedUrls: string[] = [];
    vi.stubGlobal('fetch', async (url: string) => {
      capturedUrls.push(url);
      return { ok: true, json: async () => makeFetchResponse([mockIssue('DOCS-1')]) };
    });

    const config = { ...BASE_CONFIG, since: '2025-01-01' };
    await fetchJiraSnapshot({ config, stagedDir });

    const manifest = JSON.parse(await readFile(join(stagedDir, 'manifest.json'), 'utf-8'));
    expect(manifest.since).toBe('2025-01-01');
    expect(capturedUrls[0]).toContain('updated+%3E%3D+%222025-01-01%22');
  });

  it('incremental run: uses max updated from existing issues as JQL floor, keeps existing files', async () => {
    // Seed a prior issue with a known updated timestamp.
    const priorUpdated = '2026-05-01T00:00:00.000Z';
    await mkdir(join(stagedDir, 'issues'), { recursive: true });
    const fs = await import('node:fs/promises');
    const priorIssue = {
      id: 'DOCS-OLD', key: 'DOCS-OLD', summary: 'Old', description: null,
      status: 'Done', issuetype: 'Task', labels: ['kb'],
      project: { key: 'DOCS', name: 'Test Docs' },
      created: '2026-01-01T00:00:00.000Z', updated: priorUpdated,
      assignee: null, priority: null,
      url: 'https://example.atlassian.net/browse/DOCS-OLD',
    };
    await fs.writeFile(join(stagedDir, 'issues', 'DOCS-OLD.json'), JSON.stringify(priorIssue), 'utf-8');

    const capturedUrls: string[] = [];
    vi.stubGlobal('fetch', async (url: string) => {
      capturedUrls.push(url);
      return { ok: true, json: async () => makeFetchResponse([mockIssue('DOCS-NEW', '2026-06-01T00:00:00.000Z')]) };
    });

    await fetchJiraSnapshot({ config: BASE_CONFIG, stagedDir });

    // JQL uses the prior issue's updated timestamp as the since floor, normalized to the
    // "yyyy-MM-dd HH:mm" literal JQL accepts (it rejects full ISO-8601 timestamps).
    // URLSearchParams encodes the space as `+`, not `%20`.
    expect(capturedUrls[0]).toContain('2026-05-01+00%3A00');
    expect(capturedUrls[0]).not.toContain(encodeURIComponent(priorUpdated));

    // Both the prior issue and the newly fetched one are present.
    const { access } = await import('node:fs/promises');
    await expect(access(join(stagedDir, 'issues', 'DOCS-OLD.json'))).resolves.toBeUndefined();
    await expect(access(join(stagedDir, 'issues', 'DOCS-NEW.json'))).resolves.toBeUndefined();
  });

  it('full run evicts stale issues when no prior issues exist', async () => {
    await mkdir(join(stagedDir, 'issues'), { recursive: true });
    const stalePath = join(stagedDir, 'issues', 'DOCS-STALE.json');
    // Write a file that is NOT a valid staged issue (no updated field) so it doesn't count as prior state.
    await import('node:fs/promises').then((fs) =>
      fs.writeFile(stalePath, JSON.stringify({ invalid: true }), 'utf-8'),
    );

    vi.stubGlobal('fetch', async () => ({
      ok: true,
      json: async () => makeFetchResponse([mockIssue('DOCS-1')]),
    }));

    await fetchJiraSnapshot({ config: BASE_CONFIG, stagedDir });

    const { access } = await import('node:fs/promises');
    await expect(access(stalePath)).rejects.toThrow();
    const issue1 = JSON.parse(await readFile(join(stagedDir, 'issues', 'DOCS-1.json'), 'utf-8'));
    expect(issue1.key).toBe('DOCS-1');
  });

  it('writes manifest with warnings when API fails', async () => {
    vi.stubGlobal('fetch', async () => ({
      ok: false,
      status: 401,
      statusText: 'Unauthorized',
      text: async () => 'Unauthorized',
    }));

    await fetchJiraSnapshot({ config: BASE_CONFIG, stagedDir });

    const manifest = JSON.parse(await readFile(join(stagedDir, 'manifest.json'), 'utf-8'));
    expect(manifest.issueCount).toBe(0);
    expect(manifest.warnings.length).toBeGreaterThan(0);
    expect(manifest.warnings[0]).toContain('401');
  });

  it('converts ADF description to markdown', async () => {
    const adfDesc = {
      type: 'doc',
      content: [{ type: 'paragraph', content: [{ type: 'text', text: 'Hello world', marks: [{ type: 'strong' }] }] }],
    };
    const issueWithAdf = {
      id: 'DOCS-3', key: 'DOCS-3',
      fields: {
        summary: 'Summary for DOCS-3',
        description: adfDesc as unknown as null,
        status: { name: 'Done' }, issuetype: { name: 'Task' }, labels: ['kb'],
        project: { key: 'DOCS', name: 'Test Docs' },
        created: '2026-01-01T00:00:00.000Z', updated: '2026-06-01T00:00:00.000Z',
        assignee: null, priority: null,
      },
    };
    vi.stubGlobal('fetch', async () => ({
      ok: true,
      json: async () => makeFetchResponse([issueWithAdf]),
    }));

    await fetchJiraSnapshot({ config: BASE_CONFIG, stagedDir });

    const issue = JSON.parse(await readFile(join(stagedDir, 'issues', 'DOCS-3.json'), 'utf-8'));
    expect(issue.description).toContain('**Hello world**');
  });
});
