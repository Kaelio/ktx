# Structured, leveled logging for the ktx MCP server

> **Scope: observability only.** This spec is about *seeing* what the MCP server
> does (which tool, what params, when, how long, outcome). *Preventing* a runaway
> query from blocking the server (off-event-loop / interruptible query execution)
> is a separate concern — see "Non-goals" and the sibling spec note below.

## Problem

The ktx MCP server (`packages/cli/src/mcp-http-server.ts` +
`mcp-server-factory.ts`; raw `node:http` + `@modelcontextprotocol/sdk`
`StreamableHTTPServerTransport`) emits almost no operational logs. There is no
server-side record of **which MCP tool was called, with what parameters, when,
how long it took, or whether it succeeded** — nor of session open/close or
transport errors. When a tool call is slow, hangs, or a client connection drops
("Transport channel closed"), an operator has no trail to diagnose it and must
resort to process sampling / `lsof` / guesswork — and the offending input
(e.g. the exact SQL) is typically unrecoverable.

## Generic use case

Anyone running a long-lived ktx MCP server — a developer's local instance, a
shared team server, or a hosted deployment — needs observability into tool-call
activity to:
- diagnose slow or hung tool calls (which `sql_execution` ran, against which
  connection, with what SQL, for how long);
- explain client-visible connection failures from the server side (session
  lifecycle, transport-closed events);
- audit what agents asked the server to do;
- spot patterns (hot tools, slow connections, error rates).

This is standard production-server hygiene; the server currently provides none.

## Requirements (sketch — refine when picked up)

1. **One structured (JSON) logger, low overhead.** Suggested `pino` (orientation
   only; implementer owns the choice). A single shared instance; write **JSON to
   stdout** (12-factor — the launcher/aggregator routes it). No in-app file
   rotation. Optional human-readable pretty output only when attached to a TTY
   (dev).
2. **Configurable level via env** (e.g. `KTX_LOG_LEVEL`, default `info`; `debug`
   for diagnosis) — verbose logging on demand without code changes.
3. **Per-session / per-call context** via child loggers: every line carries a
   `sessionId` (from the transport session) and, for tool calls, a `callId` +
   `tool` name, so one session's or call's activity can be traced/grepped.
4. **Tool-call logging — START logged BEFORE execution, COMPLETION after.** For
   every MCP tool invocation:
   - on entry: log `{ tool, params, sessionId, callId }` **before** running the
     handler (so the record exists even if the handler never returns);
   - on exit: log `durationMs` + outcome (ok with result size, or error with
     stack).
   This makes a **hung / never-returning call identifiable**: a start with no
   matching completion is the culprit, with its exact parameters and timestamp.
   This matters specifically because handlers like `sql_execution` run a
   *synchronous* better-sqlite3 query — a runaway query blocks the process and no
   completion is ever logged, so the start line (flushed before the blocking
   call) is the only record. For `sql_execution`, `params` should include the SQL
   text (the most useful field). Emit a **WARN** when a *completed* call exceeds a
   configurable slow threshold (e.g. `KTX_SLOW_TOOL_MS`).
5. **Connection / session lifecycle:** log session open/close (with `sessionId`)
   and transport errors (the SDK's closed-channel / "Transport channel closed"
   events) so client-side connection failures have a server-side counterpart.
6. **Error logging** with structured stack traces (a standard error serializer),
   not bare strings.
7. **Light redaction — credentials only** (bearer token, connection
   passwords/secrets). SQL text and tool params are *not* secrets and must be
   logged. Do not over-redact.
8. **Synchronous logging is fine.** The server uses a synchronous DB client, so
   logging need not be async; prefer the simpler synchronous stdout path over
   async/worker transports (which can lose buffered lines on a hard crash). Do
   not introduce async-logging machinery.

## Acceptance criteria (sketch)

- With `KTX_LOG_LEVEL=debug`, invoking any MCP tool produces a `tool.start`
  (tool, params, sessionId, callId) and a `tool.end` (durationMs, outcome) line
  on the server's stdout, as JSON.
- A tool call that never returns (e.g. a runaway `sql_execution`) leaves a
  `tool.start` line carrying its **exact SQL and timestamp** and **no**
  `tool.end` — so the offending query is recoverable from the log alone, with no
  process sampling.
- A completed tool call slower than the configured threshold emits a WARN with
  its duration.
- Session open/close and transport-closed events are logged with the `sessionId`.
- At default level (`info`), routine per-tool lines are suppressed but lifecycle,
  slow-call warnings, and errors are present.
- Credentials (bearer token, connection secrets) never appear in logs; SQL and
  tool params do.
- No new heavy dependencies beyond the logger; no OpenTelemetry/metrics stack; no
  async-transport machinery.

## Non-goals

- **Preventing/interrupting runaway queries** (off-event-loop execution, query
  timeouts, worker-thread isolation). That is a *separate* spec; a single
  synchronous query that fans out into a massive nested-loop join can peg the
  single-threaded server for hours and break new connections — observability
  surfaces *which* query, but the fix is execution-model work. (This logging is
  also a prerequisite for a future watchdog that detects a `tool.start` with no
  `tool.end` past a threshold and recycles the server.)
- Metrics/tracing/OpenTelemetry exporters.
- Forwarding logs to the MCP *client* via the protocol's logging capability
  (`notifications/message`, `logging/setLevel`) — a possible later enhancement,
  distinct from operational stdout logging.

## Benchmark context (motivation, not a requirement)

Running Spider 2.0-Lite against the MCP server at concurrency, an
adversarial-reviewer-generated query degenerated into a massive nested-loop join;
synchronous better-sqlite3 executed it on the event loop, pegging a server at
~100% CPU for hours and breaking new MCP connections to it ("Transport channel
closed"). We could not determine *which* query, because the server logs nothing
about tool calls — diagnosis required `sample`/`lsof` on the live process and the
exact SQL was never recovered. Structured tool-call logging (especially
start-before-execute) would have turned this into a one-line `grep` of the server
log.
