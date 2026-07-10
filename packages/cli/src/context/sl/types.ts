import type { TableUsageOutput } from '../ingest/adapters/historic-sql/skill-schemas.js';

export interface SemanticLayerSource {
  name: string;
  descriptions?: Record<string, string>;
  table?: string;
  sql?: string;
  inherits_columns_from?: string;
  grain: string[];
  columns: Array<{
    name: string;
    type: string;
    role?: string;
    visibility?: string;
    descriptions?: Record<string, string>;
    expr?: string;
    natural_granularity?: string;
    constraints?: { dbt?: { not_null?: boolean; unique?: boolean } };
    enum_values?: { dbt?: string[] };
    tests?: {
      dbt?: Array<{ name: string; package: string; kwargs?: Record<string, unknown> }>;
      dbt_by_package?: Record<string, string[]>;
    };
  }>;
  joins: Array<{
    to: string;
    on: string;
    relationship: string;
    alias?: string;
    source?: string;
  }>;
  measures: Array<{
    name: string;
    expr: string;
    filter?: string;
    segments?: string[];
    description?: string;
  }>;
  segments?: Array<{
    name: string;
    expr: string;
    description?: string;
  }>;
  default_time_dimension?: { dbt?: string };
  tags?: { dbt?: string[] };
  freshness?: { dbt?: { raw?: unknown; loaded_at_field?: string | null } };
  usage?: TableUsageOutput;
}

type SemanticLayerColumn = SemanticLayerSource['columns'][number];
type SemanticLayerJoin = SemanticLayerSource['joins'][number];

export interface SemanticLayerColumnOverride {
  name: string;
  role?: string;
  visibility?: string;
  descriptions?: Record<string, string>;
  constraints?: { dbt?: { not_null?: boolean; unique?: boolean } };
  enum_values?: { dbt?: string[] };
  tests?: {
    dbt?: Array<{ name: string; package: string; kwargs?: Record<string, unknown> }>;
    dbt_by_package?: Record<string, string[]>;
  };
}

export type ResolvedSemanticLayerSource = Omit<
  SemanticLayerSource,
  'inherits_columns_from' | 'usage' | 'joins'
> & {
  table?: string;
  sql?: string;
  columns: Array<SemanticLayerColumn & { type: string }>;
  joins: Array<Omit<SemanticLayerJoin, 'source'>>;
};

export interface SemanticLayerQueryInput {
  measures: Array<string | { expr: string; name: string }>;
  dimensions: Array<string | { field: string; granularity?: string }>;
  filters?: string[];
  segments?: string[];
  order_by?: Array<string | { field: string; direction?: string }>;
  limit?: number;
  include_empty?: boolean;
  // Set by compileLocalSlQuery from the connection's query_policy, never from
  // caller input: the planner rejects runtime-composed measures when true.
  predefined_measures_only?: boolean;
}

export interface SemanticLayerQueryExecutionResult {
  sql: string;
  headers: string[];
  rows: unknown[][];
  totalRows: number;
  plan: Record<string, unknown>;
}

export type SlSearchMatchReason = 'lexical' | 'semantic' | 'dictionary' | 'token' | (string & {});

export interface SlDictionaryMatch {
  column: string;
  values: string[];
  overflowCount?: number;
}

export interface SlSearchLaneSummary {
  lane: string;
  status: 'available' | 'skipped' | 'failed';
  requestedCandidatePoolLimit: number;
  effectiveCandidatePoolLimit: number;
  returnedCandidateCount: number;
  weight: number;
  reason?: string;
}
