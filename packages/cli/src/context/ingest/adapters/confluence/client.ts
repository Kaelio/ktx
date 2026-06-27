import type {
  ConfluencePageBody,
  ConfluencePageSummary,
  ConfluenceRuntimeClient,
  ConfluenceSpaceSummary,
} from './client-port.js';

export interface ConfluenceClientRuntimeConfig {
  baseUrl: string;
  email: string;
  apiToken: string;
}

export interface ConfluenceClientConfig {
  maxRetries: number;
  baseDelayMs: number;
  maxDelayMs: number;
  timeoutMs: number;
}

export const DEFAULT_CONFLUENCE_CLIENT_CONFIG: ConfluenceClientConfig = {
  maxRetries: 3,
  baseDelayMs: 500,
  maxDelayMs: 10_000,
  timeoutMs: 30_000,
};

type PaginatedV2Response<T> = {
  results: T[];
  _links: { next?: string; base?: string };
};

export class DefaultConfluenceClient implements ConfluenceRuntimeClient {
  constructor(
    private readonly runtimeConfig: ConfluenceClientRuntimeConfig,
    private readonly clientConfig: ConfluenceClientConfig = DEFAULT_CONFLUENCE_CLIENT_CONFIG,
  ) {}

  get baseUrl(): string {
    return this.runtimeConfig.baseUrl.replace(/\/$/, '');
  }

  private get apiBase(): string {
    return `${this.baseUrl}/wiki/api/v2`;
  }

  private authHeader(): string {
    const credentials = Buffer.from(
      `${this.runtimeConfig.email}:${this.runtimeConfig.apiToken}`,
    ).toString('base64');
    return `Basic ${credentials}`;
  }

  private async fetchWithRetry(url: string): Promise<Response> {
    let lastErr: unknown;
    for (let attempt = 0; attempt <= this.clientConfig.maxRetries; attempt++) {
      if (attempt > 0) {
        const delay = Math.min(
          this.clientConfig.baseDelayMs * 2 ** (attempt - 1),
          this.clientConfig.maxDelayMs,
        );
        await new Promise((resolve) => setTimeout(resolve, delay));
      }
      try {
        const res = await fetch(url, {
          headers: {
            Authorization: this.authHeader(),
            Accept: 'application/json',
          },
          signal: AbortSignal.timeout(this.clientConfig.timeoutMs),
        });
        if (res.status === 429 || res.status >= 500) {
          const text = await res.text().catch(() => '');
          lastErr = new Error(`Confluence API error (${res.status}): ${text}`);
          continue;
        }
        return res;
      } catch (err) {
        lastErr = err;
      }
    }
    throw lastErr;
  }

  private async getJson<T>(path: string): Promise<T> {
    const url = path.startsWith('http') ? path : `${this.apiBase}${path}`;
    const res = await this.fetchWithRetry(url);
    if (!res.ok) {
      const text = await res.text().catch(() => '');
      throw new Error(`Confluence API error (${res.status}) at ${url}: ${text}`);
    }
    return res.json() as Promise<T>;
  }

  private async paginateAll<T>(initialPath: string): Promise<T[]> {
    const results: T[] = [];
    let nextUrl: string | null = initialPath;
    while (nextUrl) {
      const page: PaginatedV2Response<T> = await this.getJson<PaginatedV2Response<T>>(nextUrl);
      results.push(...page.results);
      const nextLink: string | undefined = page._links?.next;
      if (!nextLink) break;
      // next is a relative path like /wiki/api/v2/spaces?cursor=...
      const base: string = page._links?.base ?? this.runtimeConfig.baseUrl.replace(/\/$/, '');
      nextUrl = nextLink.startsWith('http') ? nextLink : `${base}${nextLink}`;
    }
    return results;
  }

  async listSpaces(opts?: { spaceKeys?: string[] }): Promise<ConfluenceSpaceSummary[]> {
    const all = await this.paginateAll<ConfluenceSpaceSummary>('/spaces?limit=250&status=current&type=global');
    if (!opts?.spaceKeys?.length) return all;
    const filter = new Set(opts.spaceKeys.map((k) => k.toUpperCase()));
    return all.filter((s) => filter.has(s.key.toUpperCase()));
  }

  async listPagesInSpace(spaceId: string, opts?: { limit?: number }): Promise<ConfluencePageSummary[]> {
    const limit = Math.min(opts?.limit ?? 250, 250);
    return this.paginateAll<ConfluencePageSummary>(`/spaces/${spaceId}/pages?limit=${limit}&status=current`);
  }

  async getPageWithBody(pageId: string): Promise<ConfluencePageBody> {
    return this.getJson<ConfluencePageBody>(`/pages/${pageId}?body-format=storage`);
  }

  async testConnection(): Promise<{ success: boolean; message?: string; error?: string }> {
    try {
      const res = await this.fetchWithRetry(`${this.apiBase}/spaces?limit=1`);
      if (res.ok) {
        return { success: true, message: 'Connected to Confluence Cloud' };
      }
      const text = await res.text().catch(() => '');
      return { success: false, error: `HTTP ${res.status}: ${text.slice(0, 200)}` };
    } catch (err) {
      return { success: false, error: err instanceof Error ? err.message : String(err) };
    }
  }

  async cleanup(): Promise<void> {
    // No persistent connections to close.
  }
}

