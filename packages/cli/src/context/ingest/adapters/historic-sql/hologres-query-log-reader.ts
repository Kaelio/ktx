import { HistoricSqlExtensionMissingError } from './errors.js';
import {
  aggregatedTemplateSchema,
  type AggregatedTemplate,
  type HistoricSqlTimeWindow,
  type HistoricSqlUnifiedPullConfig,
} from './types.js';

interface QueryResultLike {
  headers: string[];
  rows: unknown[][];
  totalRows?: number;
  error?: string;
}

interface QueryClientLike {
  executeQuery(sql: string, params?: unknown[]): Promise<QueryResultLike>;
}

export interface HologresQueryLogProbeResult {
  warnings: string[];
  info: string[];
}

const HOLOGRES_QUERY_LOG_RELATION = 'hologres.hg_query_log';
const PROBE_SQL = `SELECT 1 FROM ${HOLOGRES_QUERY_LOG_RELATION} LIMIT 1`;
const GRANTS_PROBE_SQL = "SELECT pg_has_role(current_user, 'pg_read_all_stats', 'USAGE') AS has_role";

const HOLOGRES_QUERY_LOG_REMEDIATION =
  'Ensure the connection role can read hologres.hg_query_log. A superuser or a member of pg_read_all_stats sees every database; a db_admin (SPM/SLPM) sees the current database.';
const HOLOGRES_GRANTS_INFO =
  'connection role lacks pg_read_all_stats; only the current user\'s query log is visible, so hg_query_log coverage is partial';

// hg_query_log is a per-execution slow-query log keyed by digest (a SQL fingerprint
// Hologres computes for SELECT/INSERT/UPDATE/DELETE). Aggregating by digest over a
// query_start window mirrors the windowed Snowflake/BigQuery readers. Single
// read-only statement — no transaction (Hologres forbids multi-statement DML/DDL).
const AGGREGATE_SQL = `
WITH filtered AS (
  SELECT digest, query, usename, status, duration, query_start, result_rows
  FROM ${HOLOGRES_QUERY_LOG_RELATION}
  WHERE digest IS NOT NULL
    AND query_start >= $1::timestamptz
    AND query_start < $2::timestamptz
),
template_stats AS (
  SELECT
    digest AS template_id,
    MIN(query) AS canonical_sql,
    COUNT(*) AS executions,
    COUNT(DISTINCT usename) AS distinct_users,
    MIN(query_start) AS first_seen,
    MAX(query_start) AS last_seen,
    PERCENTILE_CONT(0.50) WITHIN GROUP (ORDER BY duration) AS p50_ms,
    PERCENTILE_CONT(0.95) WITHIN GROUP (ORDER BY duration) AS p95_ms,
    (COUNT(*) FILTER (WHERE status = 'FAILED'))::float8 / NULLIF(COUNT(*), 0) AS error_rate,
    SUM(result_rows)::bigint AS rows_produced
  FROM filtered
  GROUP BY digest
  HAVING COUNT(*) >= $3
),
template_users AS (
  SELECT digest AS template_id, usename AS user_name, COUNT(*) AS executions, MAX(query_start) AS last_seen
  FROM filtered
  GROUP BY digest, usename
)
SELECT
  stats.template_id,
  stats.canonical_sql,
  stats.executions,
  stats.distinct_users,
  stats.first_seen,
  stats.last_seen,
  stats.p50_ms,
  stats.p95_ms,
  stats.error_rate,
  stats.rows_produced,
  COALESCE(
    json_agg(json_build_object('user', users.user_name, 'executions', users.executions)
      ORDER BY users.executions DESC, users.last_seen DESC)
      FILTER (WHERE users.user_name IS NOT NULL),
    '[]'::json
  )::text AS top_users
FROM template_stats AS stats
LEFT JOIN template_users AS users ON users.template_id = stats.template_id
GROUP BY
  stats.template_id,
  stats.canonical_sql,
  stats.executions,
  stats.distinct_users,
  stats.first_seen,
  stats.last_seen,
  stats.p50_ms,
  stats.p95_ms,
  stats.error_rate,
  stats.rows_produced
ORDER BY stats.executions DESC
`.trim();

function queryClient(client: unknown): QueryClientLike {
  if (
    client &&
    typeof client === 'object' &&
    'executeQuery' in client &&
    typeof (client as { executeQuery?: unknown }).executeQuery === 'function'
  ) {
    return client as QueryClientLike;
  }
  throw new Error('Historic SQL Hologres reader requires a query client with executeQuery(sql, params?)');
}

async function execute(client: QueryClientLike, sql: string, params?: unknown[]): Promise<QueryResultLike> {
  const result = await client.executeQuery(sql, params);
  if ('error' in result && typeof result.error === 'string' && result.error.length > 0) {
    throw new Error(result.error);
  }
  return result;
}

function indexByHeader(headers: string[]): Map<string, number> {
  const out = new Map<string, number>();
  headers.forEach((header, index) => out.set(header.toLowerCase(), index));
  return out;
}

function value(row: unknown[], indexes: Map<string, number>, name: string): unknown {
  const index = indexes.get(name.toLowerCase());
  return index === undefined ? null : row[index];
}

function nullableString(raw: unknown): string | null {
  if (raw === null || raw === undefined) {
    return null;
  }
  const text = String(raw);
  return text.length > 0 ? text : null;
}

function requiredString(raw: unknown, field: string): string {
  const text = nullableString(raw);
  if (!text) {
    throw new Error(`Hologres hg_query_log row is missing ${field}`);
  }
  return text;
}

function nullableNumber(raw: unknown): number | null {
  if (raw === null || raw === undefined || raw === '') {
    return null;
  }
  const number = typeof raw === 'number' ? raw : Number(raw);
  return Number.isFinite(number) ? number : null;
}

function requiredNumber(raw: unknown, field: string): number {
  const number = nullableNumber(raw);
  if (number === null) {
    throw new Error(`Hologres hg_query_log row has invalid ${field}: ${String(raw)}`);
  }
  return number;
}

function requiredInteger(raw: unknown, field: string): number {
  return Math.trunc(requiredNumber(raw, field));
}

function nullableInteger(raw: unknown): number | null {
  const number = nullableNumber(raw);
  return number === null ? null : Math.trunc(number);
}

function isoTimestamp(raw: unknown, field: string): string {
  if (raw instanceof Date) {
    return raw.toISOString();
  }
  const text = requiredString(raw, field);
  const date = new Date(text);
  if (Number.isNaN(date.getTime())) {
    throw new Error(`Hologres hg_query_log row has invalid ${field}: ${text}`);
  }
  return date.toISOString();
}

function parseTopUsers(raw: unknown): Array<{ user: string | null; executions: number }> {
  const text = nullableString(raw);
  if (!text) {
    return [];
  }
  try {
    const parsed = JSON.parse(text) as unknown;
    if (!Array.isArray(parsed)) {
      return [];
    }
    return parsed.flatMap((entry) => {
      if (!entry || typeof entry !== 'object') {
        return [];
      }
      const user = nullableString((entry as { user?: unknown }).user);
      const executions = nullableInteger((entry as { executions?: unknown }).executions);
      return executions === null ? [] : [{ user, executions }];
    });
  } catch {
    return [];
  }
}

function mapAggregatedRow(row: unknown[], indexes: Map<string, number>, lastSeenFallback: string): AggregatedTemplate {
  return aggregatedTemplateSchema.parse({
    templateId: requiredString(value(row, indexes, 'template_id'), 'template_id'),
    canonicalSql: requiredString(value(row, indexes, 'canonical_sql'), 'canonical_sql'),
    dialect: 'hologres',
    stats: {
      executions: requiredInteger(value(row, indexes, 'executions'), 'executions'),
      distinctUsers: requiredInteger(value(row, indexes, 'distinct_users'), 'distinct_users'),
      firstSeen: isoTimestamp(value(row, indexes, 'first_seen'), 'first_seen'),
      lastSeen: isoTimestamp(value(row, indexes, 'last_seen') ?? lastSeenFallback, 'last_seen'),
      p50RuntimeMs: nullableNumber(value(row, indexes, 'p50_ms')),
      p95RuntimeMs: nullableNumber(value(row, indexes, 'p95_ms')),
      errorRate: requiredNumber(value(row, indexes, 'error_rate'), 'error_rate'),
      rowsProduced: nullableInteger(value(row, indexes, 'rows_produced')),
    },
    topUsers: parseTopUsers(value(row, indexes, 'top_users')),
  });
}

export class HologresQueryLogReader {
  async probe(client: unknown): Promise<HologresQueryLogProbeResult> {
    const pgClient = queryClient(client);
    try {
      await execute(pgClient, PROBE_SQL);
    } catch (error) {
      throw new HistoricSqlExtensionMissingError({
        dialect: 'hologres',
        message: 'hologres.hg_query_log is not accessible for historic-SQL ingest.',
        remediation: HOLOGRES_QUERY_LOG_REMEDIATION,
        cause: error,
      });
    }
    const warnings: string[] = [];
    try {
      const grants = await execute(pgClient, GRANTS_PROBE_SQL);
      if (value(grants.rows[0] ?? [], indexByHeader(grants.headers), 'has_role') !== true) {
        warnings.push(HOLOGRES_GRANTS_INFO);
      }
    } catch {
      warnings.push(HOLOGRES_GRANTS_INFO);
    }
    return { warnings, info: [] };
  }

  async *fetchAggregated(
    client: unknown,
    window: HistoricSqlTimeWindow,
    config: HistoricSqlUnifiedPullConfig,
  ): AsyncIterable<AggregatedTemplate> {
    const pgClient = queryClient(client);
    const result = await execute(pgClient, AGGREGATE_SQL, [window.start, window.end, config.minExecutions]);
    const indexes = indexByHeader(result.headers);
    const lastSeenFallback = window.end.toISOString();
    for (const row of result.rows) {
      yield mapAggregatedRow(row, indexes, lastSeenFallback);
    }
  }
}
