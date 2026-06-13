export type WikiScope = 'GLOBAL' | 'USER';

export interface HistoricSqlWikiUsageFrontmatter {
  executions: number;
  distinct_users: number;
  first_seen: string;
  last_seen: string;
  p50_runtime_ms: number | null;
  p95_runtime_ms: number | null;
  error_rate: number;
  rows_produced?: number;
}

export interface WikiFrontmatter {
  summary: string;
  tags?: string[];
  refs?: string[];
  sl_refs?: string[];
  /**
   * Connection ids this page applies to. Absent or empty ⇒ unscoped: the page
   * applies to all connections. Additive metadata, orthogonal to GLOBAL/USER
   * scope; it does not namespace page keys.
   */
  connections?: string[];
  usage_mode: 'always' | 'auto' | 'never';
  sort_order?: number;
  source?: string;
  intent?: string;
  tables?: string[];
  representative_sql?: string;
  usage?: HistoricSqlWikiUsageFrontmatter;
  fingerprints?: string[];
  stale_since?: string;
  archived_since?: string;
}

export interface WikiPage {
  pageKey: string;
  frontmatter: WikiFrontmatter;
  content: string;
}

export interface WikiPageWithScope extends WikiPage {
  scope: WikiScope;
}

export type WikiSearchMatchReason = 'lexical' | 'semantic' | 'token' | (string & {});

export interface WikiSearchLaneSummary {
  lane: string;
  status: 'available' | 'skipped' | 'failed';
  requestedCandidatePoolLimit: number;
  effectiveCandidatePoolLimit: number;
  returnedCandidateCount: number;
  weight: number;
  reason?: string;
}
