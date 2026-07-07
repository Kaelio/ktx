import type {
  TableauDatasourceRecord,
  TableauFieldRecord,
  TableauRuntimeClient,
  TableauTestConnectionResult,
  TableauUpstreamTableRecord,
  TableauWorkbookRecord,
} from './client-port.js';
import type { DatasourceFilterInput, WorkbookFilterInput } from './types.js';

export interface TableauClientRuntimeConfig {
  /** Base host URL of the Tableau Cloud pod or Tableau Server, e.g. https://us-west-2b.online.tableau.com */
  host: string;
  /** Site content URL (the site subpath). Empty string targets the Default site on Tableau Server. */
  siteContentUrl: string;
  /** REST API version, e.g. "3.29". */
  apiVersion: string;
  /** Personal Access Token name. */
  patName: string;
  /** Personal Access Token secret. */
  patSecret: string;
}

export interface TableauClientConfig {
  maxRetries: number;
  baseDelayMs: number;
  maxDelayMs: number;
  timeoutMs: number;
  /** Page size for Metadata API `*Connection(first, offset)` pagination. */
  pageSize: number;
}

export const DEFAULT_TABLEAU_CLIENT_CONFIG: TableauClientConfig = {
  maxRetries: 3,
  baseDelayMs: 500,
  maxDelayMs: 10_000,
  timeoutMs: 30_000,
  pageSize: 100,
};

interface SignInResponse {
  credentials: {
    token: string;
    site: { id: string; contentUrl: string };
    user: { id: string };
  };
}

interface GraphQLResponse<T> {
  data?: T;
  errors?: Array<{ message: string }>;
}

/**
 * A field as returned by the Metadata API. `fields` is polymorphic — a `CalculatedField`
 * carries `formula`, a `ColumnField` does not — so we read `formula` optionally off either.
 */
interface RawField {
  __typename?: string;
  name?: string;
  description?: string | null;
  dataType?: string | null;
  role?: string | null;
  formula?: string | null;
}

interface RawUpstreamTable {
  luid?: string | null;
  name?: string | null;
  schema?: string | null;
  fullName?: string | null;
}

interface RawDatasource {
  luid?: string | null;
  name?: string | null;
  projectName?: string | null;
  updatedAt?: string | null;
  hasExtracts?: boolean | null;
  description?: string | null;
  fields?: RawField[] | null;
  upstreamTables?: RawUpstreamTable[] | null;
}

interface RawWorkbook {
  luid?: string | null;
  name?: string | null;
  projectName?: string | null;
  description?: string | null;
  updatedAt?: string | null;
}

interface ConnectionPage<T> {
  totalCount?: number;
  pageInfo?: { hasNextPage?: boolean };
  nodes: T[];
}

const DATASOURCES_QUERY = `
query Datasources($first: Int!, $offset: Int!) {
  publishedDatasourcesConnection(first: $first, offset: $offset) {
    totalCount
    pageInfo { hasNextPage }
    nodes {
      luid
      name
      projectName
      updatedAt
      hasExtracts
      description
      upstreamTables { luid name schema fullName }
      fields {
        __typename
        name
        description
        ... on ColumnField { dataType role }
        ... on CalculatedField { formula dataType role }
      }
    }
  }
}`;

const WORKBOOKS_QUERY = `
query Workbooks($first: Int!, $offset: Int!) {
  workbooksConnection(first: $first, offset: $offset) {
    totalCount
    pageInfo { hasNextPage }
    nodes {
      luid
      name
      projectName
      description
      updatedAt
    }
  }
}`;

function nonEmpty(value: string | null | undefined): string | undefined {
  return typeof value === 'string' && value.trim().length > 0 ? value : undefined;
}

function mapField(raw: RawField): TableauFieldRecord | null {
  const name = nonEmpty(raw.name);
  if (!name) return null;
  const field: TableauFieldRecord = { name };
  const role = nonEmpty(raw.role);
  if (role) field.role = role;
  const dataType = nonEmpty(raw.dataType);
  if (dataType) field.dataType = dataType;
  const formula = nonEmpty(raw.formula);
  if (formula) field.formula = formula;
  const description = nonEmpty(raw.description);
  if (description) field.description = description;
  return field;
}

function mapUpstreamTable(raw: RawUpstreamTable): TableauUpstreamTableRecord | null {
  const name = nonEmpty(raw.name);
  if (!name) return null;
  const table: TableauUpstreamTableRecord = { name };
  const luid = nonEmpty(raw.luid);
  if (luid) table.luid = luid;
  const schema = nonEmpty(raw.schema);
  if (schema) table.schema = schema;
  const fullName = nonEmpty(raw.fullName);
  if (fullName) table.fullName = fullName;
  return table;
}

function mapDatasource(raw: RawDatasource): TableauDatasourceRecord | null {
  const luid = nonEmpty(raw.luid);
  const name = nonEmpty(raw.name);
  if (!luid || !name) return null;
  const record: TableauDatasourceRecord = {
    luid,
    name,
    hasExtracts: raw.hasExtracts ?? false,
    fields: (raw.fields ?? []).map(mapField).filter((f): f is TableauFieldRecord => f !== null),
    upstreamTables: (raw.upstreamTables ?? [])
      .map(mapUpstreamTable)
      .filter((t): t is TableauUpstreamTableRecord => t !== null),
  };
  const projectName = nonEmpty(raw.projectName);
  if (projectName) record.projectName = projectName;
  const updatedAt = nonEmpty(raw.updatedAt);
  if (updatedAt) record.updatedAt = updatedAt;
  const description = nonEmpty(raw.description);
  if (description) record.description = description;
  return record;
}

function mapWorkbook(raw: RawWorkbook): TableauWorkbookRecord | null {
  const luid = nonEmpty(raw.luid);
  const name = nonEmpty(raw.name);
  if (!luid || !name) return null;
  const record: TableauWorkbookRecord = { luid, name };
  const projectName = nonEmpty(raw.projectName);
  if (projectName) record.projectName = projectName;
  const description = nonEmpty(raw.description);
  if (description) record.description = description;
  const updatedAt = nonEmpty(raw.updatedAt);
  if (updatedAt) record.updatedAt = updatedAt;
  return record;
}

function isAfter(updatedAt: string | undefined, since: number): boolean {
  if (!updatedAt) return true; // keep records with no timestamp rather than silently dropping them
  const ts = new Date(updatedAt).getTime();
  return Number.isNaN(ts) ? true : ts >= since;
}

export class DefaultTableauClient implements TableauRuntimeClient {
  private authToken: string | null = null;
  private authInflight: Promise<void> | null = null;

  constructor(
    private readonly runtimeConfig: TableauClientRuntimeConfig,
    private readonly clientConfig: TableauClientConfig = DEFAULT_TABLEAU_CLIENT_CONFIG,
  ) {}

  private get host(): string {
    return this.runtimeConfig.host.replace(/\/$/, '');
  }

  private async signIn(): Promise<void> {
    const url = `${this.host}/api/${this.runtimeConfig.apiVersion}/auth/signin`;
    const res = await fetch(url, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Accept: 'application/json' },
      body: JSON.stringify({
        credentials: {
          personalAccessTokenName: this.runtimeConfig.patName,
          personalAccessTokenSecret: this.runtimeConfig.patSecret,
          site: { contentUrl: this.runtimeConfig.siteContentUrl },
        },
      }),
      signal: AbortSignal.timeout(this.clientConfig.timeoutMs),
    });
    if (!res.ok) {
      const text = await res.text().catch(() => '');
      throw new Error(`Tableau sign-in failed (${res.status}): ${text}`);
    }
    const body = (await res.json()) as SignInResponse;
    const token = body.credentials?.token;
    if (!token) {
      throw new Error('Tableau sign-in succeeded but returned no auth token');
    }
    this.authToken = token;
  }

  private async ensureToken(): Promise<void> {
    if (this.authToken) return;
    if (this.authInflight) return this.authInflight;
    this.authInflight = this.signIn().finally(() => {
      this.authInflight = null;
    });
    return this.authInflight;
  }

  /** Executes a Metadata API GraphQL query with retry + one re-auth on 401. */
  private async metadataQuery<T>(query: string, variables: Record<string, unknown>): Promise<T> {
    await this.ensureToken();
    const url = `${this.host}/api/metadata/graphql`;

    let lastError: Error | null = null;
    for (let attempt = 0; attempt <= this.clientConfig.maxRetries; attempt++) {
      if (attempt > 0) {
        const delay = Math.min(this.clientConfig.baseDelayMs * 2 ** (attempt - 1), this.clientConfig.maxDelayMs);
        await new Promise<void>((resolve) => setTimeout(resolve, delay));
      }

      const res = await fetch(url, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          Accept: 'application/json',
          'X-Tableau-Auth': this.authToken ?? '',
        },
        body: JSON.stringify({ query, variables }),
        signal: AbortSignal.timeout(this.clientConfig.timeoutMs),
      });

      if (res.status === 401) {
        // Token rejected/expired — force a fresh sign-in and retry once.
        this.authToken = null;
        await this.ensureToken();
        continue;
      }

      if (res.status === 429 || res.status >= 500) {
        const text = await res.text().catch(() => '');
        lastError = new Error(`Tableau Metadata API error (${res.status}): ${text}`);
        continue;
      }

      if (!res.ok) {
        const text = await res.text().catch(() => '');
        throw new Error(`Tableau Metadata API error (${res.status}): ${text}`);
      }

      const body = (await res.json()) as GraphQLResponse<T>;
      if (body.errors && body.errors.length > 0) {
        throw new Error(`Tableau Metadata API returned errors: ${body.errors.map((e) => e.message).join('; ')}`);
      }
      if (body.data === undefined) {
        throw new Error('Tableau Metadata API returned no data');
      }
      return body.data;
    }

    throw lastError ?? new Error('Tableau Metadata API request failed after retries');
  }

  private async paginate<TNode>(
    query: string,
    connectionField: string,
  ): Promise<TNode[]> {
    const all: TNode[] = [];
    let offset = 0;
    for (;;) {
      const data = await this.metadataQuery<Record<string, ConnectionPage<TNode>>>(query, {
        first: this.clientConfig.pageSize,
        offset,
      });
      const page = data[connectionField];
      const nodes = page?.nodes ?? [];
      all.push(...nodes);
      const hasNext = page?.pageInfo?.hasNextPage ?? false;
      if (!hasNext || nodes.length === 0) break;
      offset += this.clientConfig.pageSize;
    }
    return all;
  }

  async testConnection(): Promise<TableauTestConnectionResult> {
    try {
      await this.ensureToken();
      return { success: true };
    } catch (err) {
      return { success: false, error: err instanceof Error ? err.message : String(err) };
    }
  }

  async listDatasources(opts: DatasourceFilterInput = {}): Promise<TableauDatasourceRecord[]> {
    const raw = await this.paginate<RawDatasource>(DATASOURCES_QUERY, 'publishedDatasourcesConnection');
    let records = raw.map(mapDatasource).filter((d): d is TableauDatasourceRecord => d !== null);
    if (opts.updatedSince) {
      const since = new Date(opts.updatedSince).getTime();
      if (!Number.isNaN(since)) records = records.filter((d) => isAfter(d.updatedAt, since));
    }
    return records;
  }

  async listWorkbooks(opts: WorkbookFilterInput = {}): Promise<TableauWorkbookRecord[]> {
    const raw = await this.paginate<RawWorkbook>(WORKBOOKS_QUERY, 'workbooksConnection');
    let records = raw.map(mapWorkbook).filter((w): w is TableauWorkbookRecord => w !== null);
    if (opts.updatedSince) {
      const since = new Date(opts.updatedSince).getTime();
      if (!Number.isNaN(since)) records = records.filter((w) => isAfter(w.updatedAt, since));
    }
    return records;
  }

  async cleanup(): Promise<void> {
    // Best-effort sign-out so the session token is invalidated server-side.
    if (this.authToken) {
      try {
        await fetch(`${this.host}/api/${this.runtimeConfig.apiVersion}/auth/signout`, {
          method: 'POST',
          headers: { 'X-Tableau-Auth': this.authToken },
          signal: AbortSignal.timeout(this.clientConfig.timeoutMs),
        });
      } catch {
        // Ignore sign-out failures — the token will expire on its own.
      }
    }
    this.authToken = null;
  }
}
