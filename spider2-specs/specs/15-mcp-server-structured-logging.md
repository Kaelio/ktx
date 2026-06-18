# Structured, leveled logging for the ktx MCP server

> Refined spec. Intake draft: `todo/15-mcp-server-structured-logging.md`.
>
> **Scope: observability only.** This spec is about *seeing* what the MCP server
> does (which tool, what params, when, how long, outcome). *Preventing* a runaway
> query from blocking the server (off-event-loop / interruptible execution) is a
> separate concern — see "Non-goals".

## Problem

The ktx MCP server (`mcp-http-server.ts` + `mcp-stdio-server.ts`, both built
through `mcp-server-factory.ts` on raw `node:http` + the
`@modelcontextprotocol/sdk` transports) emits almost no operational logs. There
is no server-side record of **which MCP tool was called, with what parameters,
when, how long it took, or whether it succeeded** — nor of session open/close or
transport errors. When a tool call is slow, hangs, or a client connection drops
("Transport channel closed"), an operator has no trail to diagnose it and must
resort to process sampling / `lsof` / guesswork — and the offending input
(e.g. the exact SQL) is typically unrecoverable.

The hook to fix this already exists but is half-built: `instrumentMcpServer`
(`context/mcp/context-tools.ts`) wraps every tool handler and already times it,
but it emits **only on completion** (a sampled `mcp_request_completed` telemetry
event) and **never writes a start line and never writes to the server log**. A
call that never returns therefore leaves no trace at all.

## Generic use case (independent of any benchmark)

Anyone running a long-lived ktx MCP server — a developer's local instance
(stdio, launched by Claude Desktop / Cursor), a foreground HTTP server, or a
shared/hosted HTTP daemon — needs observability into tool-call activity to:

- diagnose slow or hung tool calls (which `sql_execution` ran, against which
  connection, with what SQL, for how long);
- explain client-visible connection failures from the server side (session
  lifecycle, transport-closed events);
- audit what agents asked the server to do;
- spot patterns (hot tools, slow connections, error rates).

This is standard production-server hygiene; the server currently provides none.

## Design decisions (resolved during refinement)

These resolve ambiguities the intake draft left open. They constrain the
implementer; the exact code is theirs.

### One `pino` logger, synchronous, written to **stderr**

Use `pino` — the de-facto standard structured-JSON logger for Node servers — as
a single shared instance. Two corrections to the draft's sketch:

- **stderr, not stdout.** The stdio transport reserves **stdout** for the
  JSON-RPC protocol (`mcp-stdio-server.ts` deliberately no-ops `stdout.write`);
  writing logs there would corrupt the protocol stream. The HTTP daemon already
  redirects **both** child fds to `.ktx/logs/mcp.log`
  (`managed-mcp-daemon.ts`: `stdio: ['ignore', log.fd, log.fd]`), so stderr lands
  in the same log file (surfaced by `ktx mcp logs`). **stderr is therefore the
  one universally-correct sink** for both transports.
- **Synchronous, no worker-thread transport.** `pino` writes through a
  `DestinationStream` (`{ write(msg) }`) — the server's existing
  `KtxCliIo.stderr` sink satisfies that interface directly. Configure pino with a
  **synchronous** destination (`pino.destination({ sync: true })`, or the
  pino-pretty stream below with `sync: true`). This is load-bearing: the
  `tool.start` line **must** be flushed to the fd *before* the (possibly
  blocking) handler runs, so a runaway synchronous `better-sqlite3` query that
  pegs the event loop still leaves the start line on disk. A worker-thread
  transport (`transport: { target: ... }`) buffers and can lose that exact line
  on a hard crash — **do not use transport mode.**

### Format is derived from `stderr.isTTY`, not a config flag

One logger, two serializations chosen by the environment (the "behavior follows
from inputs" rule — not a user-visible knob):

- **TTY** (`ktx mcp start --foreground` or `ktx mcp stdio` run in a terminal) →
  **`pino-pretty` as a synchronous in-process stream** (`pretty({ sync: true,
  destination: <stderr sink> })`, colorized). A readable live dev view.
- **Not a TTY** (the detached daemon, whose stderr is the `.ktx/logs/mcp.log`
  file fd) → **plain JSON line** via the synchronous pino destination. The log
  *file* stays structured JSON so the incident workflow ("recover the hung query
  with a one-line `grep` / `jq`") works — colorized ANSI in a file would defeat
  it.

`KtxCliIo.stderr` has no `isTTY` field (`cli-runtime.ts`), so detect the terminal
from the underlying stream (`process.stderr.isTTY`) at logger construction, while
still writing *through* the `io.stderr` sink so tests can capture emitted lines.

### Single hook: extend `instrumentMcpServer`, do not fork a second wrapper

Tool-call logging is added to the existing `instrumentMcpServer`
(`context-tools.ts`), which already wraps `registerTool` and measures duration.
It receives the **raw** tool input (it wraps the schema-parsing handler from
`registerParsedTool`), so the params it logs include `sql` for `sql_execution`.
The existing telemetry emission stays unchanged; logging is **additive** beside
it. Because both transports build their server through `mcp-server-factory.ts` →
`registerKtxContextTools`, this single change gives **both HTTP and stdio**
tool-call logging for free.

### `sessionId` / `callId` provenance

- **`sessionId`** comes from the SDK's per-call handler context
  (`RequestHandlerExtra.sessionId`; confirmed present in `@modelcontextprotocol/sdk`
  `1.29.0`). It is populated for the HTTP StreamableHTTP transport and absent for
  stdio (single session) — log it when present, omit otherwise. Add
  `sessionId?: string` to `KtxMcpToolHandlerContext` (`context/mcp/types.ts`).
- **`callId`** is generated per invocation with `randomUUID()` (already imported
  in `context-tools.ts`). It correlates a `tool.start` with its `tool.end`.

### No redaction in v1 (explicit)

v1 ships **no log redaction**. Rationale recorded here so it is a deliberate
choice, not an oversight: these logs are **local** (stderr → `.ktx/logs/mcp.log`),
**never transmitted off-box**, and sit at the **same trust boundary** as the
`ktx.yaml` / environment that already hold the connection credentials. Concretely:

- Request **headers are never logged** at all, so the bearer token
  (`KTX_MCP_TOKEN`) simply isn't collected — this is "not logged," not "redacted."
- Errors are logged with their **full message and stack** via pino's standard
  `err` serializer.
- SQL text and tool params are logged **verbatim** (they are not secrets).

Credential redaction (e.g. a DB URL embedded in a driver error string) is an
explicit **v1 non-goal**; revisit only if these logs are ever shipped off-box.
This drops the draft's "light redaction" requirement and the
`collectTelemetryRedactionSecrets` / scrubber reuse it implied.

## Requirements

### 1. One shared pino logger

- A single `pino` instance per server process, constructed once and threaded to
  both the transport layer (for lifecycle events) and the tool layer (for
  tool-call events). Level set from env (Requirement 7), default `info`.
- Synchronous destination bound to the server's stderr sink (see Design
  decisions). Pretty (`pino-pretty`, sync stream) when `process.stderr.isTTY`,
  otherwise plain JSON. Each line carries pino's standard `time` and `level`.
- No new dependency beyond `pino` and `pino-pretty`. No OpenTelemetry / metrics
  stack, no async/worker transport, no in-app file rotation.

### 2. Per-session / per-call context via child loggers

Use pino child loggers so every line carries the relevant correlation fields:
a per-call child binds `{ tool, callId }` plus `sessionId` when present, so one
session's or one call's activity can be grepped from the log.

### 3. Tool-call logging — START before execute, END after

In `instrumentMcpServer`, for **every** MCP tool invocation:

- **On entry, before invoking the handler**, write `tool.start` with
  `{ tool, callId, sessionId?, params }` at **`info`**. `params` is the raw tool
  input; for `sql_execution` this includes the full **SQL text** (the single most
  useful field). The write is synchronous so the line exists even if the handler
  never returns.
- **On normal completion**, write `tool.end` with
  `{ tool, callId, sessionId?, durationMs, outcome: "ok", resultSize }` at
  **`info`** — *unless* it is a slow call (Requirement 4). `resultSize` is a
  tool-agnostic size measure (byte length of the serialized result text content).
- **On error**, write `tool.end` with
  `{ tool, callId, sessionId?, durationMs, outcome: "error", err }` at **`error`**,
  where `err` is the serialized error (message + stack) per Requirement 6.

`tool.start` and `tool.end` share the **same correlation fields and the same
`info` level** (for the non-slow, non-error case) so that an **unmatched
`tool.start`** — a start with no `tool.end` for the same `callId` — is an
unambiguous "this call hung" signal. This is the property that makes a runaway
`sql_execution` identifiable from the log alone, with its exact SQL and
timestamp, no process sampling.

> **Deliberate change from the intake draft.** The draft put `tool.start` /
> `tool.end` at `debug` (suppressed at the default `info`). That defeats the
> motivating incident: a hang is unpredictable, so debug would have to be enabled
> *before* it occurs, which never happens. v1 logs start/end at **`info`** — an
> always-on access log — so the offending query is recoverable at the default
> level. `debug` is reserved for heavier detail (Requirement 7).

### 4. Slow-call warning

When a call **completes** with `durationMs` greater than the configured slow
threshold (Requirement 7), emit its `tool.end` at **`warn`** (carrying the same
fields plus the duration) instead of `info`. This makes a completed-but-slow call
stand out and keeps it visible even when the level is raised to `warn`.

### 5. Connection / session lifecycle and transport errors

- **HTTP** (`mcp-http-server.ts`, in `newTransport`): log `session.open` from
  `onsessioninitialized` and `session.close` from `onsessionclosed` /
  `transport.onclose`, each with `sessionId`, at `info`. **Wire the currently
  unused `transport.onerror`** to log `transport.error` (the SDK's
  closed-channel / "Transport channel closed" events) at `error`, so a
  client-visible connection failure has a server-side counterpart.
- **stdio** (`mcp-stdio-server.ts`): route the existing raw
  `transport.onerror` stderr string (it currently writes a plain string) through
  the logger as a `transport.error` line at `error`. A single `session.open` /
  `session.close` pair for the one stdio connection MAY be logged at `info`.

### 6. Structured error logging

Errors are logged as structured objects via pino's standard `err` serializer
(`pino.stdSerializers.err` or equivalent), carrying error class, message, and
stack — never a bare interpolated string. The existing telemetry exception
reporting in `instrumentMcpServer` / `registerParsedTool` is unchanged.

### 7. Configuration surface

- **`KTX_MCP_LOG_LEVEL`** — pino level (`error` | `warn` | `info` | `debug` |
  …), default **`info`**. MCP-scoped name because the MCP server is the only
  emitter today; naming it global (`KTX_LOG_LEVEL`) would imply a logging system
  that does not exist.
- **`KTX_MCP_SLOW_TOOL_MS`** — slow-call threshold in milliseconds (Requirement
  4), default **`10000`**. Justified as a real ops knob: "slow" differs sharply
  between a local SQLite file and a remote warehouse.
- Level ladder that results from Requirements 3–5:
  - `debug`: everything below **plus** heavier detail (e.g. result bodies,
    progress notifications) — implementer's discretion on what extra to attach.
  - `info` (default): `tool.start` / `tool.end`, session lifecycle, slow `warn`s,
    errors.
  - `warn`: slow-call `tool.end`s, `transport.error`, errored `tool.end`s — but
    not routine tool traffic.
  - `error`: errored `tool.end`s and `transport.error` only.

## Acceptance criteria

- At default level (`info`), invoking any MCP tool produces a `tool.start`
  (`tool`, `callId`, `sessionId` when HTTP, `params`) and a matching `tool.end`
  (`durationMs`, `outcome`, `resultSize`) line, as **JSON to stderr** when stderr
  is not a TTY.
- A tool call that never returns (e.g. a runaway `sql_execution`) leaves a
  `tool.start` line carrying its **exact SQL and timestamp** and **no** matching
  `tool.end` for that `callId` — so the offending query is recoverable from the
  log alone, with no process sampling.
- A completed call slower than `KTX_MCP_SLOW_TOOL_MS` emits its `tool.end` at
  `warn` with its `durationMs`.
- Session open/close and transport-closed (`transport.error`) events are logged
  with the `sessionId` (HTTP); the stdio transport error path goes through the
  logger, not a raw `stderr.write`.
- At level `warn`, routine `tool.start` / `tool.end` are suppressed but
  slow-call warnings, transport errors, and errored calls are present.
- When stderr is a TTY (`ktx mcp start --foreground` / `ktx mcp stdio` in a
  terminal), output is human-readable colorized `pino-pretty`; the daemon log
  file (`.ktx/logs/mcp.log`) is plain JSON. Both paths are synchronous.
- The bearer token never appears in any log line (headers are not logged); SQL
  and tool params do appear.
- No worker-thread / async log transport is introduced; no OpenTelemetry /
  metrics stack; the only new dependencies are `pino` and `pino-pretty`.
- The existing `mcp_request_completed` telemetry and exception reporting still
  work unchanged.

## Non-goals

- **Preventing / interrupting runaway queries** (off-event-loop execution, query
  timeouts, worker-thread isolation). A single synchronous query that fans out
  into a massive nested-loop join can peg the single-threaded server for hours
  and break new connections — observability surfaces *which* query, but the fix
  is execution-model work in a separate spec. (This logging is also the
  prerequisite for a future watchdog that detects a `tool.start` with no
  `tool.end` past a threshold and recycles the server.)
- **Log redaction** (see Design decisions) — explicit v1 non-goal.
- **Pretty output as a worker-thread transport** — the TTY path uses pino-pretty
  as a synchronous in-process stream only.
- Metrics / tracing / OpenTelemetry exporters.
- Forwarding logs to the MCP *client* via the protocol logging capability
  (`notifications/message`, `logging/setLevel`) — a possible later enhancement,
  distinct from operational stderr logging.
- A global `KTX_LOG_LEVEL` spanning non-MCP commands — out of scope until other
  surfaces emit structured logs.

## Implementation orientation

Line numbers drift; treat these as anchors, not addresses. The implementer owns
the design.

- **New module** — a small logger factory, e.g.
  `packages/cli/src/context/mcp/logger.ts`: builds the shared pino instance from
  the stderr sink + `KTX_MCP_LOG_LEVEL`, choosing the pino-pretty (sync) stream
  when `process.stderr.isTTY` else `pino.destination({ sync: true })`, and
  exposes a `slow-threshold` read from `KTX_MCP_SLOW_TOOL_MS`.
- **Tool-call logging** — `packages/cli/src/context/mcp/context-tools.ts`:
  extend `instrumentMcpServer` (~line 585) to write `tool.start` before
  `handler(...)` and `tool.end` after (ok / slow-`warn` / `error`); generate
  `callId` via the already-imported `randomUUID`; read `sessionId` from the
  handler `context`. Thread the logger via `RegisterKtxContextToolsDeps`
  (~line 26) and `registerKtxContextTools` (~line 650). Leave `registerParsedTool`
  and the existing telemetry emission intact.
- **Context type** — `packages/cli/src/context/mcp/types.ts`: add
  `sessionId?: string` to `KtxMcpToolHandlerContext`; add the logger to
  `KtxMcpServerDeps` / the register deps.
- **Server wiring** — `packages/cli/src/context/mcp/server.ts`
  (`createDefaultKtxMcpServer` / `createKtxMcpServer`) and
  `packages/cli/src/mcp-server-factory.ts` (`createKtxMcpServerFactory`): accept
  and pass the logger down to `registerKtxContextTools`.
- **HTTP lifecycle** — `packages/cli/src/mcp-http-server.ts`: construct (or
  receive) the logger; in `newTransport` (~line 186) log `session.open` /
  `session.close` and add `transport.onerror` → `transport.error`.
- **stdio lifecycle** — `packages/cli/src/mcp-stdio-server.ts`: construct (or
  receive) the logger; route the existing `transport.onerror` (~line 54) through
  it.
- **Log destination is already captured** — `packages/cli/src/managed-mcp-daemon.ts`
  redirects child stdout+stderr to `.ktx/logs/mcp.log`; `ktx mcp logs`
  (`commands/mcp-commands.ts`) tails it. No change needed there.
- **Dependencies** — add `pino` and `pino-pretty` to
  `packages/cli/package.json`. Verify Knip/Biome dead-code and bundle checks
  still pass.
- **Tests** — extend `packages/cli/test/mcp-http-server.test.ts`,
  `mcp-server-factory.test.ts`, `context/mcp/server.test.ts`, and
  `commands/mcp-commands.test.ts`: assert (a) a `tool.start` JSON line is written
  before a (mock) handler runs and carries `params`/`sql`; (b) a matching
  `tool.end` with `durationMs`/`outcome`; (c) a hung-handler scenario yields a
  `tool.start` with no `tool.end` for that `callId`; (d) a slow completion emits
  `warn`; (e) session lifecycle + `transport.error` lines; (f) the bearer token
  never appears. Inject a capturing `io.stderr` and parse the JSON lines.
  *Note:* `mcp-server-factory.test.ts` carries a pre-existing
  `KtxMcpContextPorts`/`contextTools` type error (from commit `2677b3ef`,
  unrelated to this work) — do not let it mask new failures.
- After implementing, rebuild and re-link so the playground picks it up:
  `pnpm run build && pnpm run link:dev`.

## Benchmark context (motivation, not a requirement)

Running Spider 2.0-Lite against the MCP server at concurrency, an
adversarial-reviewer-generated query degenerated into a massive nested-loop join;
synchronous `better-sqlite3` executed it on the event loop, pegging a server at
~100% CPU for hours and breaking new MCP connections ("Transport channel
closed"). We could not determine *which* query, because the server logs nothing
about tool calls — diagnosis required `sample` / `lsof` on the live process and
the exact SQL was never recovered. Structured tool-call logging — especially
`tool.start` written synchronously *before* execution, at the default level —
would have turned this into a one-line `grep` of the server log. Improving the
benchmark is a side effect; the logging is generic production-server hygiene.

## Implementation notes

Implemented on branch `write-feature-spec-wiki`. All requirements and acceptance
criteria are satisfied.

**What was built / where**

- **New module `packages/cli/src/context/mcp/logger.ts`** — `createMcpLogger(io,
  { isTTY? })` builds one synchronous `pino` (v10) instance written through the
  `io.stderr` sink: plain JSON when stderr is not a TTY, a `pino-pretty` (v13)
  synchronous in-process stream (`{ colorize: true, sync: true }`, wrapping the
  sink in a `node:stream.Writable`) when it is. Also exports `mcpLogLevel`
  (`KTX_MCP_LOG_LEVEL`, validated against pino levels, default `info`),
  `mcpSlowToolMs` (`KTX_MCP_SLOW_TOOL_MS`, default `10000`), and
  `serializeMcpError`. No worker/async transport; no global `KTX_LOG_LEVEL`.
- **Tool-call logging — `instrumentMcpServer` (`context/mcp/context-tools.ts`)** —
  per invocation: `callId = randomUUID()`, a child logger bound to
  `{ tool, callId, sessionId? }`, `tool.start { params }` written at `info`
  **before** awaiting the handler (synchronous, so a runaway query still leaves it
  on disk), and `tool.end` after: `info { durationMs, outcome:"ok", resultSize }`,
  `warn` when `durationMs > KTX_MCP_SLOW_TOOL_MS`, or `error { outcome:"error",
  err }`. `resultSize` is the UTF-8 byte length of the serialized text content.
  The existing `mcp_request_completed` telemetry + `reportException` are unchanged
  (`durationMs` is now computed once and shared); `registerParsedTool` is intact.
- **`sessionId` / logger plumbing** — `sessionId?: string` added to
  `KtxMcpToolHandlerContext`; a single per-process logger threads from each
  transport entrypoint through `createKtxMcpServerFactory` →
  `createDefaultKtxMcpServer` → `createKtxMcpServer` → `registerKtxContextTools`
  (`KtxMcpServerDeps.logger`, `RegisterKtxContextToolsDeps.logger`).
- **HTTP lifecycle (`mcp-http-server.ts`)** — `session.open` from
  `onsessioninitialized`, `session.close` from `transport.onclose`, and the
  previously-unused `transport.onerror` wired to `transport.error` at `error`.
- **stdio lifecycle (`mcp-stdio-server.ts`)** — the raw `transport.onerror`
  string write is replaced by a `transport.error` log line; `session.open` /
  `session.close` are logged for the single stdio session.
- **Deps** — `pino ^10.3.1`, `pino-pretty ^13.1.3` added to
  `packages/cli/package.json`.
- **Tests** — `test/context/mcp/logger.test.ts` (factory, level/threshold env
  parsing, error serializer, TTY vs JSON), a "MCP tool-call logging" block in
  `test/context/mcp/server.test.ts` (start-before-handler, matching end with
  `resultSize`, hung-handler leaves an unmatched start, slow→`warn`, `warn`-level
  suppression with errored end still present, no-logger no-op), session lifecycle
  + bearer-token-never-logged in `test/mcp-http-server.test.ts`, and
  `test/mcp-stdio-server.test.ts` for `transport.error`.

**Deviations / decisions**

- **In-band errors carry no stack (inherent).** `registerParsedTool` converts a
  thrown handler error into an `{ isError: true }` result (and reports the full
  error via telemetry) before it reaches `instrumentMcpServer`, so the original
  stack is already gone. `tool.end` for such a result logs `outcome:"error"` with
  `err.message` only; a genuine throw that escapes gets the full pino `err`
  serialization (type + message + stack). The field is always `err` for
  consistency. This honours "leave `registerParsedTool` intact."
- **`session.close` is logged from `transport.onclose`** (the universal close
  signal for both clean DELETE and dropped connections) rather than
  `onsessionclosed`, to avoid duplicate lines; `onsessionclosed` keeps its
  session-map cleanup role.
- **The logger is optional throughout.** Production always wires one per process;
  when absent (programmatic/test callers that inject `createMcpServer`), tool-call
  logging is simply off — which keeps existing tests unchanged.
- `createMcpLogger` accepts an optional `isTTY` purely as a test seam; production
  derives format from `process.stderr.isTTY`.

**Verification**

`pnpm --filter @kaelio/ktx exec vitest run` for the four touched/added MCP test
files: 57 passed. Full default `pnpm run test`: 3018 passed, 1 skipped — the only
2 failures are in `test/skills/analytics-skill-content.test.ts`, pre-existing and
unrelated to this change (in-progress analytics-skill work on this branch).
`pnpm run dead-code` (Biome + Knip default + Knip production) clean. `pnpm run
build` and `pnpm run link:dev` succeed. `pnpm run type-check` reports only the
one pre-existing, test-only error in `test/mcp-server-factory.test.ts` from commit
`2677b3ef` (documented above); all source and the new tests type-check clean.
