# Bounded query execution (deadline + non-blocking) for read SQL

> Refined spec. Intake draft: `todo/16-bounded-query-execution-timeout.md`.
>
> **Scope: bound and cancel a read query that runs too long.** This is the
> execution-model companion to spec 15 (MCP structured logging). Spec 15
> *surfaces* a runaway query in the log; it explicitly defers *preventing* one —
> "off-event-loop execution, query timeouts, worker-thread isolation … is
> execution-model work in a separate spec." This is that spec.

## Problem

Two compounding gaps on the read-query path (`executeReadOnly`), confirmed in the
current code:

1. **No execution deadline, handled divergently per connector.** A single
   expensive query runs unbounded, and whether it is bounded at all depends
   entirely on which driver the caller hit:
   - **BigQuery** is the only connector with a real statement timeout — it sets
     `jobTimeoutMs` on the query job from a per-connection config field
     `job_timeout_ms` (`connectors/bigquery/connector.ts`, `query(...)` ~491–512).
   - **ClickHouse** sets a hardcoded 30s *HTTP* `request_timeout` at client
     creation (`connectors/clickhouse/connector.ts:602`) — a client-side give-up,
     not a server-side `max_execution_time`; the server keeps working.
   - **Snowflake, Postgres, MySQL, SQL Server** bound only pool/connection
     *acquisition* (Snowflake `acquireTimeoutMillis: 60_000`; Postgres
     `connectionTimeoutMillis: 10_000`; SQL Server `idleTimeoutMillis: 30000`;
     MySQL pool size only) — nothing bounds statement *execution*.
   - **SQLite** has nothing.

2. **In-process SQLite blocks the event loop and cannot be cancelled.** The
   SQLite connector executes on the main thread via synchronous
   `better-sqlite3 .prepare().all()` (`connectors/sqlite/connector.ts`,
   `query(...)` 311–318, used by `executeReadOnly` 247–251). A slow query freezes
   the whole MCP server — it cannot serve other requests, send progress, or write
   `tool.end` — and there is no in-thread way to interrupt it: better-sqlite3 (v12)
   exposes no interrupt/cancel API. Its documented mechanism for slow queries is a
   **worker thread**, and the only way to stop a runaway synchronous query is to
   **terminate the thread** executing it (context7 `/wiselibs/better-sqlite3`,
   `docs/threads.md`).

The observed failure (Spider2-lite sqlite run, 2026-06-18): a single
`sql_execution` MCP call —
`SELECT MIN(time_id), MAX(time_id), COUNT(*) FROM profits` on `complex_oracle`,
where `profits` is a VIEW (`costs ⋈ sales`, 918,843 × 82,112 rows, joined on a
4-column key with no composite index) — degraded to an O(N×M) nested-loop scan,
pegged a worker at 100% CPU for 13+ minutes, never returned, produced a
`tool.start` with no matching `tool.end`, and stalled an eval shard until the
worker was killed by hand. A row cap (`maxRows`) does not help: it bounds returned
rows, not scan work, and the failing query returned a single aggregate row.

## Generic use case (independent of any benchmark)

Any data agent that lets an LLM author SQL will eventually issue an
accidentally-expensive query — an unindexed or cartesian join, an expensive VIEW,
a wide aggregate over a large fact table. A general-purpose context layer must
bound that and return a clean, fast "query exceeded Ns" error so the agent can
revise (add filters, query base tables, narrow the range) instead of hanging the
tool and the server. This matters for embedded/local warehouses (SQLite, and any
future DuckDB-style in-process driver) and remote ones alike, and is wholly
independent of any benchmark.

## Design decisions (resolved during refinement)

These resolve ambiguities the intake draft left open. They constrain the
implementer; the exact code is theirs.

### One canonical deadline, applied uniformly at the contract

The deadline is enforced for **every** `executeReadOnly` caller, not only the MCP
`sql_execution` path. `executeReadOnly` has 13 call sites beyond MCP (ingest query
executor, relationship profiling and composite-candidate probes, relationship
validation, historic-SQL probes, `ktx sql`); the contract is the single place to
bound all of them. A heavy ingest profiling probe over a giant unindexed join is
exactly as worth abandoning as an interactive one — those call sites are
best-effort and degrade gracefully, so a deadline `KtxQueryError` becomes "skip
this probe / mark unprofiled," not "fail the source." (Requirement 8 covers the
call sites that must treat the timeout as recoverable.)

> Rejected alternative: a caller-resolved deadline (short on the interactive path,
> longer/none for ingest). That introduces a second value source and the open
> question "what is the ingest budget," for no real gain — the 30s default already
> clears any normal profiling probe, and a probe that exceeds it is one to drop.

### Default 30s, configurable per-connection via one shared field

- **Default `30_000` ms.** Fast enough that an LLM agent gets a clean
  "exceeded 30s" and revises within the same turn; generous headroom over any
  indexed aggregate or normal profiling probe; a genuine pathological nested-loop
  scan blows past it immediately.
- **One shared per-connection override**, honored by every connector:
  `query_timeout_ms` in `ktx.yaml` (`queryTimeoutMs` in TS), a positive integer
  in **milliseconds**. Milliseconds matches the BigQuery SDK and the field it
  replaces; the user-facing error still reads in seconds.
- **BigQuery's `job_timeout_ms` config key is removed**, not kept alongside the
  new field. BigQuery reads the shared `query_timeout_ms` and maps the resolved
  value onto its SDK's `jobTimeoutMs`. ktx keeps no backward compatibility, so
  there is exactly one way to set a query timeout — no parallel knob (intake
  requirement 1).
- **Granularity is per-connection only.** No global all-connections override —
  different warehouses have different performance envelopes, and a second
  (global) knob would double the configuration surface for no stated need.

### The shared contract is a value + an error, not a base class

There is **no shared connector base class or factory** — each connector is
constructed independently; the only shared registry is the *dialect* factory
(`context/connections/dialects.ts:47–55`). So "defined once" (intake requirement
3) means a single shared module that owns:

- `DEFAULT_QUERY_TIMEOUT_MS = 30_000`;
- `resolveQueryDeadlineMs(connectionConfig)` → the validated `query_timeout_ms`
  override, else the default — so the default and the override precedence live in
  exactly one place;
- `queryDeadlineExceededError(deadlineMs)` → a `KtxQueryError` with the canonical
  message `query exceeded ${Math.round(deadlineMs / 1000)}s`.

Each connector calls the resolver once (at construction; connectors already
receive their connection config) and stores `this.deadlineMs`. **Enforcement is
necessarily per-connector** — different engines cancel differently — but the
*value* and the *error message* are shared, so the agent sees one consistent,
actionable error regardless of driver.

### Real cancellation, not client-side give-up

Per intake requirement 5, the deadline must *stop the work*, not merely abandon
the promise while the query keeps running (which on a pooled driver also risks
returning a still-busy connection to the pool). So:

- **In-process (SQLite, and any future embedded driver):** run the query off the
  main thread and enforce the deadline by **terminating the worker thread**. There
  is no generic `Promise.race` outer wrapper — a `Promise.race` against a
  synchronous in-thread `.all()` can never fire (the loop is blocked), and against
  a pooled remote query it would poison the pool. Thread termination *is* the
  cancellation.
- **Remote engines:** set the engine's **server-side statement timeout** so the
  server itself aborts the query and frees the connection cleanly.

### Logging routes through spec 15's pino path — no second logger

The deadline cases are logged through the **existing** MCP tool-call logger
(spec 15's `instrumentMcpServer`, `context/mcp/context-tools.ts:644–730`), not a
new logging path threaded into the connector. Verified flow for a timeout:
`executeReadOnly` throws `queryDeadlineExceededError` (a `KtxQueryError`) →
`local-project-ports.ts` preserves it → `registerParsedTool` (:552) reports it
(`reportException` skips `$exception` for `KtxExpectedError`) and returns an
in-band `isError` result → `instrumentMcpServer` writes `tool.end` at **`error`**
with `outcome:"error"`, `err.message = "query exceeded {N}s"`, and the **same
`callId`** as the `tool.start`.

This is the central observability win and it requires **no new MCP logging code**:
spec 15 made a hang show up as a `tool.start` with *no* matching `tool.end`; this
spec turns it into a **matched `tool.start` → `tool.end(error)` pair** whose
`tool.end` names the deadline. The worker-termination (SQLite) and server-side
abort (remote) are internal enforcement mechanisms; their single observable signal
is that `tool.end`, so the connector does **not** get its own logger threaded
through `KtxScanContext` — that would fork a second path for one capability. The
"worker was actually reaped, not left spinning" guarantee is asserted by the
worker's `exit` event in tests (Requirement 3), not by a log line.

## Requirements

### 1. Shared deadline contract, defined once

A single new module (e.g. `packages/cli/src/context/connections/query-deadline.ts`)
exports `DEFAULT_QUERY_TIMEOUT_MS` (30_000), `resolveQueryDeadlineMs(connectionConfig)`,
and `queryDeadlineExceededError(deadlineMs)`. Every connector resolves its
deadline through this resolver; no connector hardcodes its own default or
duplicates the override-precedence logic.

### 2. Shared per-connection config field; BigQuery's removed

`query_timeout_ms` is added to the **shared** connection config schema (validated
as an optional positive integer, milliseconds) so every driver accepts it. The
BigQuery-specific `job_timeout_ms` config field and its dedicated reader
(`bigQueryJobTimeoutMsFromConnection`) are removed; BigQuery sources its timeout
from the shared field and applies it as `jobTimeoutMs`. A bad `query_timeout_ms`
(zero, negative, non-integer) is a clear config validation error, consistent with
how ktx validates `ktx.yaml`.

### 3. SQLite executes off the main thread, terminated on deadline

`executeReadOnly` on the SQLite connector MUST NOT block the MCP server event
loop:

- Read-only validation and the row-limit wrapper (`assertReadOnlySql` +
  `limitSqlForExecution`) run **on the main thread** before dispatch — invalid SQL
  fails instantly without spawning a worker, and read-only enforcement stays at
  the boundary (Requirement 7).
- The validated, row-limited SQL (and any params) is dispatched to a **worker
  thread** that opens the database `{ readonly: true, fileMustExist: true }`, runs
  the query, and posts back `{ headers, rows, totalRows }` (all values are
  structured-cloneable — primitives, `Buffer`, `BigInt`).
- The main thread arms a timer for `this.deadlineMs`; on expiry it calls
  `worker.terminate()` and rejects with `queryDeadlineExceededError`. On a normal
  message it clears the timer and resolves. On a worker error (SQLite rejected the
  SQL) it rejects with that error, message preserved. A provided
  `ctx.signal` (`KtxScanContext.signal`, already on the contract) also terminates
  the worker, for external cancellation.
- **One short-lived worker per call**, terminated on completion or deadline — not
  a persistent worker or pool. Terminate-on-deadline destroys the worker, so a
  pool would need respawn/job-tracking for no benefit: `executeReadOnly` is
  low-frequency (LLM-issued, serial per agent turn) and worker spawn cost is
  negligible against query latency. The other SQLite paths (introspect, sample,
  stats, distinct-values, row-count) stay on the main thread — they are
  ktx-authored, bounded, and not on the `executeReadOnly` contract.
- The event loop stays responsive throughout, so `tool.end` is always written and
  concurrent requests on the same port are served.

### 4. Remote engines set a real server-side statement timeout

Each remote connector applies `this.deadlineMs` as its engine's server-side
statement timeout, so the deadline stops server work rather than abandoning the
promise:

| Connector  | Mechanism                                              | Unit          |
|------------|--------------------------------------------------------|---------------|
| BigQuery   | `jobTimeoutMs` on the query job (replaces `job_timeout_ms`) | ms       |
| Postgres   | `statement_timeout`                                    | ms            |
| MySQL      | session `max_execution_time` (applies to read-only SELECT — the only kind on this path) | ms |
| Snowflake  | `STATEMENT_TIMEOUT_IN_SECONDS` (ALTER SESSION)         | s (ceil)      |
| ClickHouse | `max_execution_time` setting, with `request_timeout` aligned to the deadline so the HTTP client does not give up before the server aborts | s (ceil) |
| SQL Server | `mssql` `requestTimeout` (TDS attention cancels server-side) | ms       |

ClickHouse's existing hardcoded 30s `request_timeout` is brought under this
contract (derived from the resolved deadline), not left as a parallel mechanism.

### 5. Timeout resolves as a `KtxQueryError` with the canonical message

On exceeding the deadline, the path resolves with a `KtxQueryError`
(`query exceeded {N}s`) — a finite, decision-reaching outcome, never an unbounded
hang. For SQLite the worker-termination path throws `queryDeadlineExceededError`
directly. For remote engines, each connector recognizes **its own** engine's
timeout signal (Postgres `57014`; MySQL errno `3024`; ClickHouse code `159`;
SQL Server `ETIMEOUT`; Snowflake and BigQuery timeout errors) and re-wraps it as
`queryDeadlineExceededError`, keeping the driver error as `cause`. Each connector
owns its driver's signal — there is no central denylist of error codes to
maintain.

### 6. MCP surfacing and logging via the existing pino path

The MCP `sql_execution` path already (a) maps any non-native driver error to
`KtxQueryError` (`context/mcp/local-project-ports.ts:78–88`, guarded by
`isNativeProgrammingFault`), (b) reports it through `reportException`, which skips
`$exception` Error Tracking for `KtxExpectedError`, and (c) writes `tool.start`
synchronously before the handler and `tool.end` in `instrumentMcpServer`
(`context/mcp/context-tools.ts:644–730`). The deadline cases MUST surface through
this path — the implementer verifies and tests them, but adds **no parallel
classification or logging path**:

- **Query exceeds the deadline (any driver):** a `tool.end` at **`error`** with
  `outcome:"error"` and `err.message = "query exceeded {N}s"`, carrying the same
  `callId` as the `tool.start`. Classified as an expected error, so it is absent
  from `$exception` Error Tracking. The reason `tool.end` was previously missing
  is solely the blocked event loop (Requirement 3); once the loop stays free and
  the deadline throws, the existing instrumentation logs the matched pair — closing
  spec 15's "`tool.start` with no `tool.end` = hang" gap for this case.
- **Completed-but-slow query (under the deadline, over `KTX_MCP_SLOW_TOOL_MS`):**
  unchanged from spec 15 — its `tool.end` is emitted at **`warn`**. The deadline
  (default 30s) and the slow threshold (default 10s) are independent knobs; a query
  between 10s and 30s completes with a slow `warn`, one past 30s is killed with the
  `error` above.

### 7. Read-only enforcement and `maxRows` unchanged

`assertReadOnlySql` and the `maxRows` row cap (`limitSqlForExecution`) behave
exactly as today. The deadline is additive. `maxRows` is not a substitute for it
(it bounds returned rows, not scan work).

### 8. Best-effort callers treat a deadline timeout as recoverable

The non-interactive `executeReadOnly` call sites that are best-effort —
relationship profiling, composite-candidate probes, relationship validation,
historic-SQL probes — MUST treat a deadline `KtxQueryError` as "skip this
probe / mark unprofiled" and continue, never as a source-fatal error. The
implementer confirms each such site already swallows query errors into a
graceful-skip and adds that handling where it does not, so the uniform deadline
(Requirement 1, applied to all callers) cannot abort an ingest run. A skipped
probe is logged at the skip site through that path's existing scan/ingest logger
(`KtxScanContext.logger`, `warn`/`debug`), never silently dropped — these callers
are off the MCP tool-call path, so their visibility comes from the logger they
already use.

## Acceptance criteria

- A read query that exceeds the deadline returns a `KtxQueryError`
  (`query exceeded {N}s`) within roughly the deadline; the MCP worker stays
  responsive (a concurrent tool call on the same server completes while the slow
  query is still pending) and writes a matching `tool.end` with a non-ok outcome.
- **Logging:** a timed-out `sql_execution` produces a `tool.start` and a matching
  `tool.end` (same `callId`) at `error` with `outcome:"error"` and
  `err.message = "query exceeded {N}s"` — no unmatched `tool.start` remains. The
  timeout does not raise a `$exception` Error Tracking event (it is a
  `KtxExpectedError`). A completed query slower than `KTX_MCP_SLOW_TOOL_MS` but
  under the deadline still emits its `tool.end` at `warn`. No new logger is
  introduced — the lines come from the existing `instrumentMcpServer`.
- **SQLite specifically:** executing a deliberately pathological query (an
  expensive VIEW or an unindexed cross join) on a fixture does not block the event
  loop, is terminated at the deadline, and the worker exits (the off-main-thread
  executor is killed, not left spinning) so CPU returns to idle.
- **One server-side-timeout driver (Postgres):** the connector applies
  `statement_timeout` equal to the resolved deadline, and a `57014` cancellation
  is mapped to the canonical `KtxQueryError`.
- `resolveQueryDeadlineMs` returns 30_000 by default, honors a `query_timeout_ms`
  override, and rejects an invalid value (zero / negative / non-integer).
- **No regression:** normal fast queries return identical results; read-only
  rejection still works; `maxRows` still bounds returned rows.
- The shared `query_timeout_ms` field is accepted by every connector; BigQuery's
  former `job_timeout_ms` key is gone and BigQuery's timeout is driven by the
  shared field.

## Non-goals

- **A row/byte/cost budget on returned data.** This spec bounds *time*, not result
  size — `maxRows` already bounds rows, and BigQuery's `maximumBytesBilled` is a
  separate, retained concern.
- **A global `KTX_QUERY_TIMEOUT_MS` or per-call user flag.** One opinionated
  default plus a per-connection override; no per-call knob, no global knob.
- **A server watchdog that recycles the process on an unmatched `tool.start`.**
  Spec 15 names this as a possible future mitigation; this spec prevents the hang
  at the source, so the watchdog is out of scope here.
- **Moving SQLite introspection / sampling / stats off the main thread.** Only the
  `executeReadOnly` (LLM-SQL) path needs worker isolation; the rest are bounded
  ktx-authored queries.
- **Per-connection retry / backoff on timeout.** A timeout returns a clean error
  for the agent to revise; ktx does not auto-retry.
- **A second logger threaded into the connector.** The deadline cases are logged
  through spec 15's existing MCP tool-call logger; the connector gets no separate
  pino instance and `KtxScanContext` gets no MCP-logger thread (see "Logging routes
  through spec 15's pino path").

## Implementation orientation

Line numbers drift; treat these as anchors, not addresses. The implementer owns
the design.

- **Shared contract** — new `packages/cli/src/context/connections/query-deadline.ts`:
  `DEFAULT_QUERY_TIMEOUT_MS`, `resolveQueryDeadlineMs`, `queryDeadlineExceededError`.
  Error class is `KtxQueryError` (`packages/cli/src/errors.ts:25`).
- **Contract anchor** — `KtxScanConnector.executeReadOnly`
  (`context/scan/types.ts:343`), `KtxReadOnlyQueryInput` (`types.ts:285`),
  `KtxScanContext.signal` (`types.ts:176`, already present, currently unused on the
  MCP path).
- **Config schema** — add `query_timeout_ms` to the shared connection config
  (`context/project/config.ts`, `KtxProjectConnectionConfig` and its zod schema);
  remove BigQuery's `job_timeout_ms` reader.
- **SQLite worker** — new `packages/cli/src/connectors/sqlite/read-query-worker.ts`
  (constructed by path via `new URL('./read-query-worker.js', import.meta.url)`);
  rework `connectors/sqlite/connector.ts` `executeReadOnly` (247–251) to validate
  on the main thread then dispatch to the worker with a terminate-on-deadline
  timer. Reuse `normalizeQueryRows` (`context/connections/query-executor.ts`) in
  the worker. Register the worker as a dynamic entry in `knip.json` (it is
  referenced by path, not import) and confirm the build copies it into `dist`.
- **Remote connectors** — apply the resolved deadline and recognize the engine's
  timeout signal in each `executeReadOnly` / `query(...)`:
  `connectors/bigquery/connector.ts` (~491–512, `jobTimeoutMs`),
  `connectors/clickhouse/connector.ts` (~602/629–644, `max_execution_time` +
  `request_timeout`), `connectors/snowflake/connector.ts` (~354–371/510–534,
  `STATEMENT_TIMEOUT_IN_SECONDS`), `connectors/postgres/connector.ts` (~822–838,
  `statement_timeout`), `connectors/mysql/connector.ts` (~774–793,
  `max_execution_time`), `connectors/sqlserver/connector.ts` (~812–832,
  `requestTimeout`).
- **MCP path + logging (verify only)** — `context/mcp/local-project-ports.ts:69–88`
  (error mapping), the `sql_execution` registration (~915–943), and the logging in
  `instrumentMcpServer` (`context/mcp/context-tools.ts:644–730`, which writes
  `tool.start`/`tool.end` via the spec-15 pino logger `context/mcp/logger.ts`). No
  new classification or logging code; confirm the timeout flows through as an
  expected error producing a matching `tool.end(error)` with the canonical message.
- **Best-effort callers** — `context/scan/relationship-profiling.ts` (~227, 275),
  `context/scan/relationship-composite-candidates.ts` (~365, 440),
  `context/scan/relationship-validation.ts` (~259),
  `context/ingest/historic-sql-probes/bigquery-runner.ts` (~97), and the
  historic-sql clients: confirm a deadline `KtxQueryError` is swallowed into a
  graceful skip.
- **Tests** — a SQLite fixture with a pathological query (tiny `query_timeout_ms`
  as the test seam) asserting terminate-on-deadline, event-loop responsiveness
  (a concurrent promise resolves while the query is pending), and worker exit; a
  Postgres test asserting `statement_timeout` is set to the resolved deadline and
  a `57014` error maps to `KtxQueryError`; resolver unit tests (default /
  override / invalid); regression tests for normal results, read-only rejection,
  and `maxRows`. Extend the MCP logging tests (alongside spec 15's, e.g.
  `test/context/mcp/server.test.ts`) to assert a timed-out `sql_execution` yields a
  matched `tool.start`/`tool.end(error)` pair carrying `query exceeded {N}s`.
- After implementing, rebuild and re-link so the playground picks it up:
  `pnpm run build && pnpm run link:dev`.

## Benchmark context (motivation, not a requirement)

The Spider2-lite local set loads several warehouses into SQLite, some with
expensive VIEWs over large fact tables — e.g. `complex_oracle.profits` =
`costs ⋈ sales` on `(prod_id, time_id, channel_id, promo_id)`, 918,843 × 82,112
rows, no composite index, with `promo_id` (the index the optimizer picks) being
95.5% a single value. LLM-authored profiling queries (MIN/MAX/COUNT over such a
view) trigger O(N×M) nested-loop scans. Without a deadline these hang an eval
shard for 10+ minutes; with one, the agent gets a fast error and can scope the
query instead. Improving the benchmark is a side effect; the deadline is generic
production hygiene for any agent that lets an LLM author SQL.

## Implementation notes

Implemented on branch `write-feature-spec-wiki` (ktx worktree `tallinn-v2`). All
acceptance criteria are met; tests, type-check, dead-code, and build are green
for the changed surface.

### What was built, and where

- **Shared contract** — new `packages/cli/src/context/connections/query-deadline.ts`:
  `DEFAULT_QUERY_TIMEOUT_MS = 30_000`, `resolveQueryDeadlineMs(connection)` (returns
  the validated `query_timeout_ms` override else the default; throws on
  zero/negative/non-integer), and `queryDeadlineExceededError(deadlineMs, options?)`
  (a `KtxQueryError` reading `query exceeded ${round(ms/1000)}s`, carrying the
  driver error as `cause`). Unit-tested in `test/context/connections/query-deadline.test.ts`.
- **Config field** — `query_timeout_ms` (optional positive integer, ms) added to
  the **shared warehouse** schema. NOTE (spec drift): that schema lives in
  `context/project/driver-schemas.ts` (`warehouseConnectionSchema`), not
  `config.ts`. The warehouse schemas use `z.looseObject`, so the field had to be
  declared explicitly to be *validated* (otherwise it would pass through
  unvalidated). BigQuery's `job_timeout_ms` field and `bigQueryJobTimeoutMsFromConnection`
  reader were removed; BigQuery now resolves the shared field. Every connector
  resolves its deadline once at construction via `resolveQueryDeadlineMs`.

### Deviation from the spec's SQLite mechanism (worker thread → child process)

The spec mandated running SQLite read queries on a **worker thread** and enforcing
the deadline by `worker.terminate()`. This was **empirically disproven**:
`Worker.terminate()` cannot interrupt a CPU-bound synchronous `better-sqlite3`
scan — the native `sqlite3_step` loop never yields to V8, so terminate's promise
never even resolves (an 8s probe of the exact failing query shape confirmed the
thread keeps spinning). better-sqlite3 v12 exposes no `interrupt`/progress-handler
API, and `.iterate()` does not help because the failing query is a single
aggregate row produced only *after* the full scan.

The implemented mechanism is therefore **`child_process.fork` + `SIGKILL`**
(`packages/cli/src/connectors/sqlite/read-query-child.ts`, spawned from
`connector.ts`). SIGKILL lets the OS reclaim the whole process — a probe confirmed
the scan is interrupted in ~2 ms and CPU returns to idle. This satisfies *both*
SQLite requirements better than a thread (event loop stays free **and** the query
is genuinely cancellable). The child is self-contained (imports only
`better-sqlite3` + node builtins); validation/row-limiting (`limitSqlForExecution`)
and `normalizeQueryRows` stay on the main thread. One short-lived child per call,
killed on completion, deadline, or `ctx.signal` abort. Node v24's native
TS type-stripping lets the `.ts` child load under vitest; a `.js`-if-exists-else-`.ts`
URL resolver picks the compiled child in `dist`. Registered as a dynamic entry in
`knip.json`; `tsc` emits it to `dist` (verified, plus a dist-level end-to-end smoke).

### Remote connectors (server-side timeouts + own-signal mapping)

Each applies the resolved deadline server-side and re-wraps its own timeout signal
as `queryDeadlineExceededError(deadlineMs, { cause })`:

- **BigQuery** — `jobTimeoutMs` on the query job; maps a "Job timed out" / timeout-reason error.
- **Postgres** — `statement_timeout` via pool `options` (`-c statement_timeout=<ms>`); maps `57014`.
- **MySQL** — `SET SESSION max_execution_time = <ms>` before the read; maps errno `3024`.
- **Snowflake** — `ALTER SESSION SET STATEMENT_TIMEOUT_IN_SECONDS = <ceil(s)>` in the pooled connection; maps code `604` / "reached its … timeout".
- **ClickHouse** — `max_execution_time` (ceil seconds) setting, with `request_timeout` set to `deadline + 5s` so the HTTP client outlasts the server abort (replaces the old hardcoded 30s); maps code `159`.
- **SQL Server** — `requestTimeout` on the `mssql` pool config (TDS attention cancels server-side); maps `ETIMEOUT`.

Each connector has a focused test asserting the timeout is applied and its signal
maps to `KtxQueryError` (Postgres is the spec's required acceptance test).

### Best-effort callers (Requirement 8)

Confirmed already graceful: relationship **profiling** (outer try/catch →
`profile_failed` warning) and **composite-candidate** detection
(`detectCompositeRelationships` → recoverable warning, returns `[]`). Historic-SQL
**probes** flow through `runHistoricSqlReadinessProbe`, which catches *any* error
into `{ ok: false }`. **Added** handling to relationship **validation**: a
`KtxQueryError` on the per-candidate coverage probe now sends that one candidate to
`review` (`validation_query_failed`, logged via `ctx.logger.warn`) instead of
aborting the whole validation pass. `ingest-query-executor.ts` is a generic
executor port whose callers own recoverability — left unchanged.

### MCP surfacing/logging

No new MCP classification or logging code. The deadline `KtxQueryError` flows
through the existing `local-project-ports` mapping → `reportException` (skips
`$exception` for `KtxExpectedError`; existing test `telemetry/exception.test.ts`
covers the skip for `KtxQueryError`) → `instrumentMcpServer`, which logs a matched
`tool.start` → `tool.end(error, level 50)` pair carrying `err.message = "query
exceeded {N}s"`. A test in `test/context/mcp/server.test.ts` asserts the matched
pair, closing spec 15's "`tool.start` with no `tool.end` = hang" gap for this case.

### Pre-existing branch issues encountered (not part of this feature)

- `test/mcp-server-factory.test.ts` had a type error (an `as` cast to a shape with
  a fake `context_tool` key, introduced by branch commit `2677b3ef`) that broke
  `tsc -p tsconfig.test.json`. Fixed with a clean single cast to keep the
  type-check gate green; behavior unchanged.
- `test/skills/analytics-skill-content.test.ts` fails (2 cases: missing
  `**Window functions**` heading and `Expose identity, not just the label` prose
  in `src/skills/analytics/SKILL.md`). This is unrelated analytics-skill (spec
  13/14) content drift committed earlier on the branch; **left untouched** — no
  skill files were modified by this feature.
