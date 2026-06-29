# Bounded query execution (deadline + non-blocking) for read SQL

> Priority: HIGH. Found empirically during a Spider2-lite sqlite run
> (2026-06-18): a single `sql_execution` MCP call wedged a worker at 100% CPU
> for 13+ minutes and never returned. The query
> `SELECT MIN(time_id), MAX(time_id), COUNT(*) FROM profits` on the
> `complex_oracle` sqlite database hit a VIEW (`costs ⋈ sales`, 918,843 × 82,112
> rows, joined on a 4-column key with no composite index) whose plan degraded to
> an O(N×M) nested-loop scan. Because the sqlite connector runs
> `better_sqlite3 .all()` **synchronously with no timeout**, it blocked the MCP
> worker's entire event loop: no `tool.end` was ever logged, the port went
> unresponsive, and the query could not be cancelled. One of four eval shards
> stalled until the worker was killed by hand.

## Problem

Two compounding gaps on the read-query path:

1. **No execution deadline.** A single expensive query runs unbounded. This is
   handled divergently per connector, with no shared contract: BigQuery has a
   real server-side job timeout (`job_timeout_ms`); ClickHouse has an HTTP
   `request_timeout`; Snowflake, Postgres, MySQL, and SQL Server bound only
   connection/pool *acquisition*, not statement *execution*; SQLite has nothing.
   So whether a runaway query is bounded depends entirely on which driver the
   caller happened to hit.

2. **In-process engines block the event loop and can't be cancelled.** The
   sqlite connector executes on the main thread via synchronous
   `better_sqlite3 .all()`. A slow query freezes the whole MCP server (it can't
   serve other requests, send progress, or write `tool.end`), and there is no
   way to interrupt it: better-sqlite3 exposes no interrupt/cancel API — its
   documented mechanism for slow queries is to run them in a **worker thread**,
   and the only way to stop a runaway synchronous query is to terminate the
   thread executing it.

The net effect is a query that produces a `tool.start` with no matching
`tool.end`, an unresponsive server, and no self-recovery. A row cap (`maxRows`)
does not help — it bounds returned rows, not scan work, and the failing query
returned a single aggregate row.

## Generic use case

Any data agent that lets an LLM author SQL will eventually issue an
accidentally-expensive query — an unindexed or cartesian join, an expensive
VIEW, a wide aggregate over a large fact table. A general-purpose context layer
must bound that and return a clean, fast "query exceeded Ns" error so the agent
can revise (add filters, query base tables, narrow the range) instead of hanging
the tool and the server. This matters for embedded/local warehouses (sqlite,
duckdb) and remote ones alike, and is wholly independent of any benchmark.

## Requirements

1. Every read-query execution path (`executeReadOnly`) enforces a single
   canonical execution deadline. One opinionated default; **not** a per-call
   user flag. Where a driver already supports a per-connection timeout
   (BigQuery `job_timeout_ms`), reuse that as the per-connection override rather
   than inventing a parallel knob.
2. On exceeding the deadline the path resolves with a `KtxQueryError`
   ("query exceeded {N}s") — a finite, decision-reaching outcome, never an
   unbounded hang.
3. The deadline is a **shared contract at the connector boundary**, defined once
   (on the `executeReadOnly` contract or a shared wrapper at the call site) so
   all drivers participate. Bring the existing divergent timeouts (BigQuery job
   timeout, ClickHouse request timeout) under this one contract instead of
   leaving parallel mechanisms.
4. For in-process engines (sqlite today, any future embedded driver), execution
   MUST NOT block the MCP server event loop. Run the query off the main thread
   and enforce the deadline by terminating that thread on timeout (the
   better-sqlite3-documented approach, since synchronous queries are
   uncancellable in-thread). The event loop must stay responsive so `tool.end`
   is always written and concurrent requests on the same port are served.
5. Prefer real cancellation over client-side give-up. Where the engine supports
   a server-side statement timeout (Postgres `statement_timeout`, MySQL
   `max_execution_time`, Snowflake `STATEMENT_TIMEOUT_IN_SECONDS`, ClickHouse
   `max_execution_time`, BigQuery job timeout, SQL Server request timeout), set
   it so the deadline actually stops work, not merely abandons the promise while
   the query keeps running. For in-process engines, thread termination is the
   cancellation.
6. The MCP `sql_execution` tool surfaces the timeout as an expected error
   (classified as `KtxQueryError`, not a `$exception` fault, consistent with
   existing expected-error classification) and logs a `tool.end` with the error
   outcome.
7. Read-only enforcement (`assertReadOnlySql`) and the `maxRows` row cap remain
   unchanged. The deadline is additive; `maxRows` is not a substitute for it.

## Acceptance criteria

- A read query that exceeds the deadline returns a `KtxQueryError` within
  roughly the deadline; the MCP worker stays responsive (a concurrent tool call
  on the same server completes while the slow query is still pending) and writes
  a matching `tool.end` with a non-ok outcome.
- sqlite specifically: executing a deliberately pathological query (e.g. an
  expensive VIEW or an unindexed cross join) on a fixture does not block the
  event loop, is terminated at the deadline, and CPU returns to idle afterward
  (the off-main-thread executor is killed, not left spinning).
- No regression: normal fast queries return identical results; read-only
  rejection still works; `maxRows` still bounds returned rows.
- Tests cover the deadline path for at least the in-process driver (sqlite,
  terminate-on-deadline) and one server-side-timeout driver.

## Benchmark context (motivation only)

The Spider2-lite local set loads several warehouses into sqlite, some with
expensive VIEWs over large fact tables — e.g. `complex_oracle.profits` =
`costs ⋈ sales` on `(prod_id, time_id, channel_id, promo_id)`, 918,843 × 82,112
rows, no composite index, with `promo_id` (the index the optimizer picks) being
95.5% a single value. LLM-authored profiling queries (MIN/MAX/COUNT over such a
view) trigger O(N×M) nested-loop scans. Without a deadline these hang an eval
shard for 10+ minutes; with one, the agent gets a fast error and can scope the
query instead.

## Orientation hints (code pointers; may have drifted)

- Shared contract: `packages/cli/src/context/scan/types.ts` —
  `KtxScanConnector.executeReadOnly` (~343), `KtxReadOnlyQueryInput` (~285).
- MCP call site: `packages/cli/src/context/mcp/local-project-ports.ts:70`
  (`connector.executeReadOnly`); tool registration in
  `packages/cli/src/context/mcp/context-tools.ts`.
- In-process sync execution (the acute hang):
  `packages/cli/src/connectors/sqlite/connector.ts:311-313`
  (`better_sqlite3 .prepare().all()`).
- Existing divergent timeouts to unify: `connectors/bigquery/connector.ts`
  (`job_timeout_ms` / `jobTimeoutMs`), `connectors/clickhouse/connector.ts:602`
  (`request_timeout`), `connectors/snowflake/connector.ts:342` (test/pool only),
  `connectors/postgres/connector.ts`, `connectors/mysql/connector.ts`,
  `connectors/sqlserver/connector.ts` (pool/connection only).
- Error class: `packages/cli/src/errors.ts:25` (`KtxQueryError`).
- better-sqlite3 (context7 `/wiselibs/better-sqlite3`, v12.x): no
  interrupt/cancel API; `docs/threads.md` documents the worker-thread pattern
  for slow queries (master owns worker lifecycle and respawns on exit) — extend
  it with terminate-on-deadline to enforce the timeout.
