import type {
  ListWorkbooksOptions,
  SigmaDataModelSummary,
  SigmaRuntimeClient,
  SigmaTestConnectionResult,
  SigmaWorkbookSummary,
} from './client-port.js';

export interface SigmaClientRuntimeConfig {
  apiUrl: string;
  clientId: string;
  clientSecret: string;
}

export interface SigmaClientConfig {
  maxRetries: number;
  baseDelayMs: number;
  maxDelayMs: number;
  timeoutMs: number;
}

export const DEFAULT_SIGMA_CLIENT_CONFIG: SigmaClientConfig = {
  maxRetries: 3,
  baseDelayMs: 500,
  maxDelayMs: 10_000,
  timeoutMs: 30_000,
};

interface TokenResponse {
  access_token: string;
  refresh_token?: string;
  token_type: string;
  expires_in: number;
}

interface PaginatedResponse<T> {
  entries: T[];
  nextPage: string | null;
  total?: number;
}

function isNonRetryable500(text: string): boolean {
  try {
    const body = JSON.parse(text) as Record<string, unknown>;
    // service_error indicates a deterministic Sigma rejection (e.g. unsupported data
    // source subtype). Retrying will not help, so throw immediately.
    return body['code'] === 'service_error';
  } catch {
    return false;
  }
}

export class DefaultSigmaClient implements SigmaRuntimeClient {
  private accessToken: string | null = null;
  private refreshToken: string | null = null;
  private tokenExpiresAt = 0;
  private tokenInflight: Promise<void> | null = null;

  constructor(
    private readonly runtimeConfig: SigmaClientRuntimeConfig,
    private readonly clientConfig: SigmaClientConfig = DEFAULT_SIGMA_CLIENT_CONFIG,
  ) {}

  private get apiUrl(): string {
    return this.runtimeConfig.apiUrl.replace(/\/$/, '');
  }

  private basicAuthHeader(): string {
    const credentials = Buffer.from(
      `${this.runtimeConfig.clientId}:${this.runtimeConfig.clientSecret}`,
    ).toString('base64');
    return `Basic ${credentials}`;
  }

  private async fetchToken(body: URLSearchParams): Promise<TokenResponse> {
    const res = await fetch(`${this.apiUrl}/v2/auth/token`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/x-www-form-urlencoded',
        Authorization: this.basicAuthHeader(),
      },
      body: body.toString(),
      signal: AbortSignal.timeout(this.clientConfig.timeoutMs),
    });
    if (!res.ok) {
      const text = await res.text().catch(() => '');
      throw new Error(`Sigma auth failed (${res.status}): ${text}`);
    }
    return res.json() as Promise<TokenResponse>;
  }

  private async ensureToken(): Promise<void> {
    const now = Date.now();
    // Refresh 60 s before expiry so in-flight requests don't get 401.
    if (this.accessToken && now < this.tokenExpiresAt - 60_000) {
      return;
    }
    if (this.tokenInflight) return this.tokenInflight;
    const body = new URLSearchParams();
    if (this.refreshToken) {
      body.set('grant_type', 'refresh_token');
      body.set('refresh_token', this.refreshToken);
    } else {
      body.set('grant_type', 'client_credentials');
    }
    this.tokenInflight = this.fetchToken(body)
      .then((data) => {
        this.accessToken = data.access_token;
        this.refreshToken = data.refresh_token ?? null;
        this.tokenExpiresAt = Date.now() + data.expires_in * 1000;
      })
      .finally(() => {
        this.tokenInflight = null;
      });
    return this.tokenInflight;
  }

  private async request<T>(path: string, query?: Record<string, string>): Promise<T> {
    await this.ensureToken();

    const url = new URL(`${this.apiUrl}${path}`);
    if (query) {
      for (const [k, v] of Object.entries(query)) {
        url.searchParams.set(k, v);
      }
    }

    let lastError: Error | null = null;
    for (let attempt = 0; attempt <= this.clientConfig.maxRetries; attempt++) {
      if (attempt > 0) {
        const delay = Math.min(
          this.clientConfig.baseDelayMs * 2 ** (attempt - 1),
          this.clientConfig.maxDelayMs,
        );
        await new Promise<void>((resolve) => setTimeout(resolve, delay));
      }

      const res = await fetch(url.toString(), {
        headers: { Authorization: `Bearer ${this.accessToken}` },
        signal: AbortSignal.timeout(this.clientConfig.timeoutMs),
      });

      if (res.status === 401) {
        // Token rejected — force full re-auth and retry once.
        this.accessToken = null;
        this.refreshToken = null;
        this.tokenExpiresAt = 0;
        await this.ensureToken();
        const retried = await fetch(url.toString(), {
          headers: { Authorization: `Bearer ${this.accessToken}` },
          signal: AbortSignal.timeout(this.clientConfig.timeoutMs),
        });
        if (!retried.ok) {
          const text = await retried.text().catch(() => '');
          throw new Error(`Sigma API error after token refresh (${retried.status}): ${text}`);
        }
        return retried.json() as Promise<T>;
      }

      if (res.status === 429 || res.status >= 500) {
        const text = await res.text().catch(() => '');
        lastError = new Error(`Sigma API error (${res.status}): ${text}`);
        if (isNonRetryable500(text)) throw lastError;
        continue;
      }

      if (!res.ok) {
        const text = await res.text().catch(() => '');
        throw new Error(`Sigma API error (${res.status}): ${text}`);
      }

      return res.json() as Promise<T>;
    }

    throw lastError ?? new Error('Sigma API request failed after retries');
  }

  private async paginateAll<T>(path: string, query: Record<string, string> = {}): Promise<T[]> {
    const all: T[] = [];
    let page: string | null = null;
    do {
      const q: Record<string, string> = { ...query, limit: '1000' };
      if (page) {
        q['page'] = page;
      }
      const res = await this.request<PaginatedResponse<T>>(path, q);
      all.push(...res.entries);
      page = res.nextPage ?? null;
    } while (page !== null);
    return all;
  }

  async testConnection(): Promise<SigmaTestConnectionResult> {
    try {
      await this.ensureToken();
      return { success: true };
    } catch (err) {
      return { success: false, error: err instanceof Error ? err.message : String(err) };
    }
  }

  async listDataModels(): Promise<SigmaDataModelSummary[]> {
    return this.paginateAll<SigmaDataModelSummary>('/v2/dataModels');
  }

  async listWorkbooks(opts: ListWorkbooksOptions = {}): Promise<SigmaWorkbookSummary[]> {
    const query: Record<string, string> = {};
    if (!opts.includeExplorations) query['excludeExplorations'] = 'true';

    let results = await this.paginateAll<SigmaWorkbookSummary>('/v2/workbooks', query);

    if (!opts.includeArchived) {
      results = results.filter((wb) => !wb.isArchived);
    }
    if (opts.updatedSince) {
      const since = new Date(opts.updatedSince).getTime();
      results = results.filter((wb) => new Date(wb.updatedAt).getTime() >= since);
    }
    return results;
  }

  async getDataModelSpec(dataModelId: string): Promise<unknown> {
    return this.request<unknown>(`/v2/dataModels/${encodeURIComponent(dataModelId)}/spec`);
  }

  async cleanup(): Promise<void> {
    this.accessToken = null;
    this.refreshToken = null;
    this.tokenExpiresAt = 0;
  }
}
