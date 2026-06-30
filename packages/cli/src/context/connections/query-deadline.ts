import { KtxQueryError } from '../../errors.js';

/**
 * Canonical default bound on read-query execution time. Generous headroom over
 * any indexed aggregate or normal profiling probe; a pathological nested-loop
 * scan blows past it immediately. Overridable per-connection via
 * `query_timeout_ms`. Production reads it through {@link resolveQueryDeadlineMs};
 * exported for the resolver's own unit tests.
 * @internal
 */
export const DEFAULT_QUERY_TIMEOUT_MS = 30_000;

interface QueryTimeoutConnectionConfig {
  query_timeout_ms?: unknown;
  [key: string]: unknown;
}

/**
 * Single source of truth for the read-query deadline: the per-connection
 * `query_timeout_ms` override (milliseconds) when present, else the default.
 * Every connector resolves through here so the default and override precedence
 * live in exactly one place. A malformed override (zero, negative, non-integer,
 * non-number) is a config error — surfaced here even though `ktx.yaml`
 * validation also rejects it, so programmatically-built connectors cannot
 * silently run unbounded.
 */
export function resolveQueryDeadlineMs(connection: QueryTimeoutConnectionConfig | undefined): number {
  const raw = connection?.query_timeout_ms;
  if (raw === undefined || raw === null) {
    return DEFAULT_QUERY_TIMEOUT_MS;
  }
  if (typeof raw !== 'number' || !Number.isInteger(raw) || raw <= 0) {
    throw new Error(`query_timeout_ms must be a positive integer in milliseconds, received ${JSON.stringify(raw)}.`);
  }
  return raw;
}

/**
 * The canonical, driver-independent timeout error an agent sees regardless of
 * which connector enforced the deadline. Reads in whole seconds. Remote
 * connectors pass the driver's own timeout error as `cause`.
 */
export function queryDeadlineExceededError(deadlineMs: number, options?: ErrorOptions): KtxQueryError {
  return new KtxQueryError(`query exceeded ${Math.round(deadlineMs / 1000)}s`, options);
}
