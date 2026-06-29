# Resilient enrichment under a slow/hung LLM backend

> Refined spec. Intake draft: `todo/20-resilient-enrichment-under-slow-llm.md`.
>
> **Scope: make the descriptions enrichment stage survive a hung LLM backend and
> an interrupted run.** Two compounding gaps live *inside* the per-table
> description-enrichment path: (1) the per-table LLM timeout fires in JS but does
> not terminate a wedged subprocess backend, so a hung table wedges the whole
> stage indefinitely; (2) descriptions are persisted only at full-stage
> completion, so any interruption discards every already-enriched table. This is
> the enrichment-stage analog of spec 16 (enforced query cancellation — a deadline
> that *stops the work*, not just abandons the promise) and spec 19 (move the
> durability boundary to the cost boundary so expensive LLM work is not lost). It
> composes with both rather than replacing them.

## Problem

Two compounding failure modes on the per-table description-enrichment path, both
confirmed in the current code and observed end-to-end together. Their union turned
a single hung table into an indefinite wedge *plus* total loss of an entire
stage's LLM work.

### 1. The per-table LLM timeout does not terminate the work

`KtxDescriptionGenerator.generateBatchedTableDescriptions`
(`context/scan/description-generation.ts`, the bounded call ~760–866) wraps the
per-table `this.llmRuntime.generateObject(...)` call in `retryAsync` with a fresh
`AbortSignal.timeout(KTX_ENRICH_LLM_TIMEOUT_MS)` per attempt (commit `01f63380`).
A fired timeout is surfaced as `KtxAbortedError` so it is **not** retried (one
wedge stays one timeout, not 3×). That is the correct policy — but the abort never
actually stops a subprocess backend, so the timeout is cosmetic.

The runtime is selected by the `backend` config field
(`context/llm/local-config.ts`, `KTX_LLM_BACKENDS =
['none','anthropic','vertex','gateway','claude-code','codex']`). Two backends spawn
a **child process the SDK owns** and to which ktx hands only an `AbortSignal`:

- **`codex`** (`@openai/codex-sdk`, via `context/llm/codex-runtime.ts` →
  `codex-sdk-runner.ts`): the SDK runs `spawn(executable, args, { signal })`. Node's
  `spawn` signal-option sends the child **SIGTERM** (not SIGKILL) on abort, and the
  SDK consumes the child's stdout with `for await (const line of rl)`, re-throwing
  the abort error **only after that loop ends**. A child wedged on a hung provider
  socket survives SIGTERM → its stdout never closes → the readline loop never ends
  → the SDK never throws → ktx's `await generateObject` **never settles**, past the
  per-attempt timeout, indefinitely. The child leaks (open provider connections,
  ~0% CPU).
- **`claude-code`** (`@anthropic-ai/claude-agent-sdk`, via
  `context/llm/claude-code-runtime.ts`, `collectResult` ~275–322): on abort it calls
  best-effort `queryResult.interrupt?.()` (errors swallowed) and only checks
  `throwIfAborted` **between** streamed messages. A wedged child emits no message, so
  the `for await (const message of queryResult)` loop blocks and the graceful
  `interrupt()` may never land — the same hang class.

By contrast, **HTTP backends** (`anthropic`/`vertex`/`gateway`/`openai`, via
`context/llm/ai-sdk-runtime.ts`) pass `abortSignal` straight to the AI SDK's
`generateObject`, which cancels the underlying `fetch` natively — the await settles
promptly and there is no child to leak.

So ktx holds **no kill handle** on the subprocess backends, and SIGTERM is too
gentle for a wedged child. Spec 16's mechanism (ktx *itself* forks
`read-query-child` and `SIGKILL`s it) works precisely because ktx owns the fork —
which it does not here.

Observed (BigQuery ingest, codex backend, 2026-06-23): with
`KTX_ENRICH_LLM_TIMEOUT_MS=1800000` (30 min, an operator override), two of
`covid19_usa`'s 252-column tables hung; the stage sat at **268/285 for 41+
minutes** — well past the 30-min per-attempt timeout — with exactly two codex
children, each holding 3 ESTABLISHED connections at ~0% CPU, until killed by hand.

### 2. Descriptions are persisted only at full-stage completion

`generateDescriptions` (`context/scan/local-enrichment.ts` ~279–352) fans out
per-table work through `pLimit(DESCRIPTION_TABLE_CONCURRENCY)` (default 4) and
**accumulates every table's result in an in-memory `updates` array**, returned only
when the whole stage finishes. `runEnrichmentStage` (~413, ~421–474) then calls
`saveCompletedStage` (writing the whole-stage row to `local_scan_enrichment_stages`)
**after** `compute()` returns, and the spec-19 checkpoint write
(`writeLocalScanEnrichmentCheckpoint`, `local-enrichment-artifacts.ts` ~351–379,
fired by the `onCheckpoint` hook in `local-scan.ts`) also runs **only once the
descriptions stage completes**. There is no within-stage persistence: while the
stage runs, every enriched table's description lives only in memory.

So if the stage cannot complete — 2 of 285 tables hang (gap #1), or the process is
killed, or a supervising watchdog fires — **all** already-enriched tables are lost,
even though their (expensive, paid) LLM descriptions were finished. On the next run,
`findCompletedStage` finds no row, so the descriptions stage **recomputes from
scratch**.

Observed (same run): `covid19_usa` had **283/285** tables enriched in memory but
**0** rows in `local_scan_enrichment_stages` and **0** `ai:` descriptions on disk;
killing the wedged ingest discarded all 283, forcing a from-scratch re-ingest. The
cost of 2 pathological tables was 283 tables' worth of redone LLM calls.

Sharper still (re-ingest with a short, *enforced* timeout): even when the stage
**runs to the end** — the 2 hung tables hit their timeout and were skipped, so
**283/285** descriptions were generated and the ingest reported success (`Scan
completed` / `Ingest finished`, embeddings built, exit 0) — the descriptions were
**still persisted as 0** (0 `ai:` on disk, 0 stage rows). So the loss is **not**
only "discarded on kill": a stage that completes with *any* skipped/aborted table
threw away **every** successfully-generated description. The skip must be
**graceful** — a skipped table costs one missing description, not the entire stage's
output — which is the strongest argument for per-table incremental persistence: the
283 good descriptions should have been durable the moment each was produced.

The on-disk artifacts already carry everything needed to fix this *additively*: the
`_schema` manifest encodes per-table completion (a table with `descriptions.ai` is
AI-enriched), and rewrites preserve existing descriptions
(`mergeDescriptionsPreservingExternal`, `manifest.ts` ~96–115;
`loadExistingManifestState`, `local-enrichment-artifacts.ts` ~196–253 — the basis
spec 19 relies on). The durable record and the resume-skip set can be **derived from
the system's own on-disk state**, with no new cache schema.

## Generic use case (independent of any benchmark)

Anyone ingesting a large or wide schema with an LLM enrichment backend —
especially a **subprocess** backend, the common local/desktop setup — will
eventually hit a table whose description call hangs: a provider stall, a rate-limit
black-hole, a pathologically large prompt. Without an *enforced* timeout, one such
table wedges the entire ingest indefinitely and leaks the spawned child; without
*incremental* persistence, any interruption throws away all the per-table LLM work
already done — the dominant ingest cost. Both fixes make large-schema enrichment
**resilient and resumable**: a few bad tables degrade to a few skipped
descriptions, not a hung process and a from-scratch redo. This is core robustness
for a general-purpose ingestion product, wholly independent of any benchmark.

## Design decisions (resolved during refinement)

These resolve ambiguities the intake draft left open. They constrain the
implementer; the exact code is theirs (requirement-level, per the specs README).

### D1 — One bounded-call guarantee; enforcement follows the backend's nature

The canonical contract is a single guarantee for the per-table enrichment call:
**the in-flight work terminates and ktx's await settles within the per-table
deadline plus a small grace, on every backend.** How that guarantee is met follows
from a structural property of the configured backend — *does it own a subprocess?*
— not from a hand-maintained list of provider names:

- **Subprocess-backed (`codex`, `claude-code`):** the SDK's own abort is
  insufficient (SIGTERM-only, and ktx has no kill handle), so ktx runs the call
  behind a **boundary it can hard-kill** — a short-lived ktx-owned child process,
  made a **process-group leader** (`detached`). The SDK's grandchild (the
  `codex`/`claude` binary) inherits that group. On deadline (or `ctx.signal`), ktx
  **tree-kills the whole group with SIGKILL** — reaping the wrapper *and* the
  grandchild — and rejects promptly. This mirrors spec 16's child-process +
  SIGKILL mechanism, extended by the critical step that **killing the immediate
  child is not enough**: the grandchild would otherwise orphan to init and keep its
  provider connections. Killing the group is the real fix.
- **HTTP-backed (`anthropic`/`vertex`/`gateway`/`openai`):** unchanged. The existing
  in-process `abortSignal` → `fetch` cancellation already satisfies the contract —
  the await settles promptly and there is no subprocess to leak. Routing these
  through a subprocess would pay fork + IPC + credential-passing cost for no benefit.

> The branch on "subprocess-backed?" is behavior following from an input the backend
> declares about itself, not vendor enumeration — the same guarantee is reached two
> ways because the backends differ structurally. This matches the intake's own split
> ("subprocess SIGKILL for process-backed; request abort for HTTP-backed").
>
> Rejected alternative — a *settle-only race* (reject ktx's promise on the deadline
> regardless of the SDK, but leave the SDK's child running). It unwedges the stage
> but leaves the orphaned child holding provider connections — the exact leak the
> incident showed — so it fails the intake's "actually cancelled" requirement and
> compounds over a long ingest that hits several hung tables.
>
> Rejected alternative — a *persistent ktx subprocess pool* hosting the runtime,
> killed and respawned on timeout. Terminate-on-deadline destroys the worker, so a
> pool needs respawn + in-flight job-tracking for no benefit: the enrichment call is
> low-frequency relative to its own latency and already concurrency-bounded (4), so
> one short-lived child per call (spec 16's resolved choice) is simpler and as fast.

**Portability.** ktx supports Windows, where POSIX process groups and
`process.kill(-pgid, …)` do not exist. The tree-kill MUST be portable: a detached
process group + `kill(-pgid, 'SIGKILL')` on POSIX, and a tree-terminating
equivalent on Windows (e.g. `taskkill /pid <pid> /T /F` or a job object) so the
grandchild is reaped on every platform the subprocess backends run on.

### D2 — Default stays moderate and the retry/skip policy is unchanged

The per-table timeout default stays **120s** (`KTX_ENRICH_LLM_TIMEOUT_MS`), with the
existing per-attempt retry (`KTX_ENRICH_LLM_ATTEMPTS`, default 3) and the
no-retry-on-timeout policy. A hung table costs **at most one timeout**, then the
table is skipped with the existing `enrichment_timeout` warning and the stage
proceeds. The 30-min value in the incident was an operator stopgap chosen *because*
the timeout was cosmetic; once D1 makes the timeout actually terminate the work, a
long timeout is strictly worse for a hang (a hang costs the full timeout), so the
moderate default is the correct operating point. The retry loop stays in
`description-generation.ts`: each attempt runs through the bounded boundary (D1), so
a transient backend error retries while a timeout surfaces as `KtxAbortedError` and
does not.

> Not introducing a new `ktx.yaml` config field for the timeout. The existing env
> override is the tuning seam; adding a per-connection/per-call/global knob would
> multiply the runtime surface for no stated need (one opinionated default + the
> existing env override is the canonical ktx shape).

### D3 — Persist descriptions incrementally; derive the resume-skip set from on-disk state

During the descriptions fan-out, flush completed tables **per batch** (every N
tables / on a timer, at a cadence that bounds the at-risk window) to the durable
on-disk artifacts, reusing spec 19's additive write:

- the raw descriptions artifact (`descriptions.json`) is the **resume-skip source**;
- the `_schema` manifest is updated additively (`mergeDescriptionsPreservingExternal`
  preserves prior `ai:`/`db:`/external keys) so finished descriptions are also
  **queryable** the moment they are computed — the spec-19 invariant, one level
  deeper. The implementer MAY bound manifest-rewrite cost on huge schemas by
  rewriting only changed shards.

On resume, `generateDescriptions` reads the existing record, **skips any table
already enriched**, computes only the remainder, and returns the merged full set so
the embeddings stage, the checkpoint write, and the stage-store row all see a
complete result exactly as today.

**The skip is `inputHash`-gated**, preserving spec 19's recompute semantics. The
durable record is tagged with the descriptions stage's `inputHash`
(`computeKtxScanEnrichmentInputHash`). Resume reuses it to skip tables **only when
the current `inputHash` matches** — a genuine resume-after-interruption of the same
content identity. A changed `inputHash` (schema or enrichment settings changed)
ignores the prior record for skipping and recomputes the stage as today; the
manifest write stays additive regardless. The artifact's on-disk shape may gain the
`inputHash` tag with **no migration bridge** (ktx owns the artifact; a stale-shaped
record simply forces one non-incremental run), consistent with ktx's
no-backward-compatibility policy.

> The skip set is **derived from the artifacts ktx already writes**, not from a new
> per-table cache table. The manifest's `ai:` field already encodes "this table is
> enriched"; a parallel per-table SQLite record would be a second source of truth for
> the same fact and would drift. The whole-stage `local_scan_enrichment_stages` row is
> still written at stage completion (it remains the stage-level resume gate — a clean
> re-run skips the descriptions stage as today); the incremental record only matters
> when the stage did **not** complete — exactly the case where no row exists and
> `compute()` re-runs.

### D4 — A killed-mid-stage run is durable; resume is cheap

A process killed mid-stage (gap #1 wedge, SIGKILL, crash, supervisor) leaves the
per-batch-flushed tables durable on disk. The next run resumes the descriptions
stage (no completed `local_scan_enrichment_stages` row → `compute()` runs again),
but `generateDescriptions` now **re-issues LLM calls only for the unfinished
tables**. A failed/skipped table (timeout or exhausted retries) is left for the
remainder set and is retried on the next resume — never silently treated as done.

## Requirements

### 1. The per-table enrichment timeout is enforced for subprocess backends

When the per-table deadline fires (or `ctx.signal` aborts) on a subprocess-backed
backend (`codex`, `claude-code`), the in-flight LLM work — the spawned child **and
its descendants** — MUST be terminated (SIGKILL of the process group / tree), and
ktx's `generateObject` await MUST settle within the deadline plus a small bounded
grace. A hung table MUST cost at most ~one timeout of wall-clock, never unbounded.
The termination MUST be portable across the platforms the subprocess backends run on
(POSIX process-group kill and a Windows tree-kill equivalent). HTTP-backed backends
keep their existing native `abortSignal` → `fetch` cancellation; the guarantee is one
contract met two ways, branching on the backend's structural "owns a subprocess"
property, not on a list of provider names.

### 2. The timeout default and retry/skip policy are unchanged

The default per-table timeout stays moderate (current 120s, `KTX_ENRICH_LLM_TIMEOUT_MS`),
with the existing per-attempt retry (default 3, `KTX_ENRICH_LLM_ATTEMPTS`) and the
no-retry-on-timeout policy. On timeout, the table is skipped with the existing
`enrichment_timeout` recoverable warning and the stage proceeds. No new
per-connection / per-call / global timeout knob is added.

### 3. Descriptions are persisted incrementally during the stage

Enriched descriptions MUST be flushed to the durable on-disk artifacts **per batch**
(per-table or per-N-tables / on a timer) during the descriptions stage, at a cadence
that bounds the at-risk window to a small number of tables. The flush MUST be
idempotent and additive (never clobber a prior `ai:` description; preserve `db:` and
external keys via the existing merge). Finished tables MUST remain durable even if the
stage never completes — is wedged, killed, or interrupted. A failed/skipped
relationship/embedding stage or a killed descriptions stage MUST NOT lose the
descriptions already flushed.

### 4. Resume re-enriches only the unfinished tables

On a resumed ingest with an unchanged `inputHash`, the descriptions stage MUST
re-issue LLM description calls **only for tables not already enriched**, deriving the
already-enriched set from the on-disk artifacts (the `inputHash`-tagged durable
record / the manifest's `ai:` descriptions), and MUST return the merged full result
so downstream stages behave as on a fresh run. A changed `inputHash` (schema or
enrichment settings changed) MUST recompute the stage as today (spec 19's
inputHash-gated semantics preserved). The durable record MAY be recreated without a
migration bridge if its on-disk shape changes (it is regenerable local/artifact
state).

### 5. No regression for small or uninterrupted ingests

A small or single-run ingest that is never interrupted MUST produce the same
artifacts (descriptions, manifest, embeddings) as today. The incremental flush MUST
be idempotent with the spec-19 checkpoint and the terminal write (descriptions
survive the embeddings/relationship rewrites). The bounded-call boundary MUST NOT
change a normal successful enrichment's output, only how a wedged call is terminated.

### 6. A skipped table costs one description, never the stage's output

A descriptions stage that **completes** with one or more skipped/aborted tables MUST
persist every successfully-generated description (the durable record and the `ai:`
manifest entries) and MUST mark the stage completed (a `local_scan_enrichment_stages`
row, embeddings + downstream proceeding) — it MUST NOT discard the whole stage's
output because some tables were skipped. No single table's failure may reject the
per-table fan-out: a per-table failure degrades to one missing description (left for
the resume remainder), not a failed stage. A genuine `ctx.signal` cancellation is the
only thing that fails the stage (so it resumes), and even then the already-flushed
descriptions remain durable.

## Acceptance criteria

- **Enforced timeout (subprocess backend):** a subprocess-backed enrichment call
  that hangs past the deadline is terminated within the deadline plus a small grace;
  ktx's await settles, the spawned child **and a grandchild it spawned** both exit
  (verified via the child's `exit`, not left spinning), and the table is skipped with
  an `enrichment_timeout` warning. The stage advances rather than wedging. A
  `ctx.signal` abort terminates the same way.
- **HTTP backend unaffected:** an HTTP-backed enrichment call still cancels promptly
  on abort via the existing native path, with no subprocess involved.
- **Default + policy:** the default timeout is 120s and a timeout is not retried (one
  wedge = one timeout); a transient error is still retried up to the attempt limit.
- **Graceful skip persists the rest:** a stage that completes with one table failing
  (timeout, exhausted retries, or an unexpected throw) still writes the other N−1
  descriptions to the durable record + `ai:` `_schema` and marks the stage completed
  (a `local_scan_enrichment_stages` row exists); the failed table is a single `null`
  description left for the resume remainder, not a discarded stage.
- **Incremental durability:** interrupting the descriptions stage after K of N tables
  leaves those K durable on disk (raw artifact + `ai:` descriptions in `_schema`),
  with no completed `local_scan_enrichment_stages` row.
- **Resume does not re-spend:** re-running the interrupted ingest (unchanged
  `inputHash`, fresh `runId`) issues **no** LLM description calls for the K already-
  enriched tables and enriches only the remaining N−K; the returned result is the
  full merged set. A changed `inputHash` recomputes the stage.
- **No regression:** a small uninterrupted ingest yields identical artifacts and the
  same descriptions/embeddings output as today; the incremental flush is idempotent
  with the checkpoint and terminal writes.

## Non-goals

- **Incremental persistence of embeddings.** Embeddings are fast and already covered
  by spec 19's stage-level cross-run resume; the dominant loss is descriptions. This
  spec scopes incremental persistence to the `descriptions` stage.
- **Changing the timeout default, retry counts, or adding a timeout config knob.**
  D2 keeps the moderate default and the single env tuning seam.
- **Routing HTTP backends through the subprocess boundary.** Their native abort
  already meets the contract; a subprocess would add cost and a credential-passing
  surface for no benefit.
- **A persistent subprocess pool.** One short-lived ktx child per subprocess-backed
  call; no pool, no respawn/job-tracking (D1).
- **Re-implementing spec 16 (per-query deadline) or spec 19 (relationship-stage
  budget, cost-boundary checkpoint, cross-run stage resume).** This spec composes
  above them: spec 16 bounds individual queries, spec 19 makes whole stages durable
  and resumable, and this spec hardens the per-table enrichment call's termination
  and adds within-stage description durability.
- **A general per-stage incremental-flush framework.** The incremental flush is
  specifically the descriptions stage; it is not a generic abstraction over every
  enrichment stage.

## Implementation orientation

Line numbers drift; treat these as anchors, not addresses. The implementer owns the
design.

- **Bounded per-table call (gap #1)** — `context/scan/description-generation.ts`,
  `KtxDescriptionGenerator.generateBatchedTableDescriptions` (the bounded+retry block
  ~760–866; `enrichTimeoutMs` ~769, `enrichAttempts` ~770, `KtxAbortedError` on
  timeout ~811, `enrichment_timeout`/`enrichment_failed` warnings ~858). The retry
  loop stays here; each attempt runs through the kill boundary for subprocess
  backends.
- **LLM runtime + backend selection** — `context/llm/runtime-port.ts`
  (`KtxLlmRuntimePort.generateObject`, `abortSignal` on the input),
  `context/llm/local-config.ts` (~127–163, selects `CodexKtxLlmRuntime` /
  `ClaudeCodeKtxLlmRuntime` / `AiSdkKtxLlmRuntime`), `context/project/config.ts`
  (`KTX_LLM_BACKENDS`). The "owns a subprocess" property should be declared by the
  backend/runtime (e.g. on the runtime interface), not inferred from a name list.
- **Subprocess backends** — `context/llm/codex-runtime.ts` +
  `context/llm/codex-sdk-runner.ts` (`CodexSdkCliRunner.runStreamed`, the SDK's
  `spawn(executable, args, { signal })` is in `@openai/codex-sdk`),
  `context/llm/claude-code-runtime.ts` (`collectResult` ~275–322, the `interrupt()`
  abort path). These are what the kill boundary must wrap and tree-kill.
- **Reuse spec 16's mechanism (extended to group/tree kill)** —
  `connectors/sqlite/read-query-child.ts` (the forked child shape) and
  `connectors/sqlite/connector.ts` `runReadQueryOffProcess` (~292–350: `fork`,
  deadline timer, `child.kill('SIGKILL')`, `settle()`, the `.js`-if-exists-else-`.ts`
  child-URL resolver ~25–27, knip dynamic entry). Gap #1 differs by making the child a
  process-group leader and killing the **group/tree** (the SDK grandchild), portably.
  Abort helpers: `context/core/abort.ts` (`createAbortError`, `throwIfAborted`,
  `linkAbortSignal`). Note the new child hosts an LLM runtime, so the implementer owns
  passing the backend config/credentials to it (env/IPC) and serializing the
  structured result back.
- **Incremental persistence (gap #2)** —
  `context/scan/local-enrichment.ts` (`generateDescriptions` ~279–352: the per-table
  `pLimit` fan-out and the in-memory `updates` accumulation; `runEnrichmentStage`
  ~413/~421–474 with `findCompletedStage` ~427 and `saveCompletedStage`; the
  `onCheckpoint` hook ~598–612). Make `generateDescriptions` resume-aware: read the
  existing record, skip already-enriched tables, flush per batch, return the merged
  full set.
- **Artifact writer + additive merge** — `context/scan/local-enrichment-artifacts.ts`
  (`writeLocalScanEnrichmentCheckpoint` ~351–379, `writeEnrichmentDescriptionArtifacts`
  with `descriptions.json` ~316, `writeLocalScanManifestShards` ~270–308,
  `loadExistingManifestState` ~196–253, `tableDescription`/`columnDescription`
  ~75–105); `context/scan/manifest.ts` (`mergeDescriptionsPreservingExternal` ~96–115,
  `SCAN_MANAGED_DESCRIPTION_KEYS`). Factor a per-batch flush that reuses the additive
  description/manifest write; tag the durable record with `inputHash`.
- **Stage store + input hash** —
  `context/scan/sqlite-local-enrichment-state-store.ts` (`STAGES_TABLE =
  'local_scan_enrichment_stages'`, PK `(connection_id, stage, input_hash)`,
  `findCompletedStage`, `saveCompletedStage`),
  `context/scan/enrichment-state.ts` (`computeKtxScanEnrichmentInputHash` ~78). The
  whole-stage row stays; the `inputHash` is the gate for the resume-skip set.
- **Scan driver** — `context/scan/local-scan.ts` (the `onCheckpoint` wiring and the
  terminal `writeLocalScanEnrichmentArtifacts`), and `KtxScanContext.signal`
  (`context/scan/types.ts`) which the kill boundary must honor.
- **Tests** — gap #1: a fake subprocess-backed runtime whose child hangs (ignores
  SIGTERM) is killed at a tiny test-seam deadline; assert the await settles within
  deadline+grace, the child and a spawned grandchild both exit, and the table is
  skipped with `enrichment_timeout`; assert an HTTP-backed abort still settles via the
  native path. gap #2: interrupt the descriptions stage after K/N tables (a flush
  seam), assert the K are durable (raw artifact + `ai:` in `_schema`) with no completed
  stage row; a resume with matching `inputHash` issues no LLM calls for the K and
  enriches only N−K; a changed `inputHash` recomputes; regression: a small
  uninterrupted ingest yields identical artifacts.
- After implementing, rebuild and re-link so the playground picks it up:
  `pnpm run build && pnpm run link:dev`.

## Benchmark context (motivation, not a requirement)

Surfaced during the Spider 2.0-Lite **BigQuery** ingest (2026-06-23, codex enrichment
backend). Re-enriching the giant public datasets, `covid19_usa` wedged at 268/285 for
41+ minutes on 2 hung 252-column tables; the 30-min per-table `AbortSignal` timeout
never killed the hung codex children, and because descriptions checkpoint only at
stage completion, the 283 already-enriched tables were unrecoverable — the operator
had to kill, cache-bust, and re-ingest the database from scratch (with a short timeout
as a stopgap). The benchmark merely exercised a large/wide multi-dataset ingest at
scale; the gaps and the fixes are generic production hygiene for any agent that
enriches a real warehouse with a subprocess LLM backend. Do not encode any benchmark
specifics in the implementation.

## Implementation notes

Implemented on branch `write-feature-spec-wiki`. Both gaps shipped; all acceptance
criteria are covered by tests. The full ktx test surface for the touched code is
green (the only failures in the whole suite are 3 pre-existing assertions in
`test/skills/analytics-skill-content.test.ts` about the analytics SKILL.md markdown
— an unrelated subsystem this change does not touch).

### Gap #1 — enforced timeout for subprocess backends

- **Structural property on the runtime, not a name list.** Added
  `subprocessForkSpec(): SubprocessRuntimeForkSpec | null` to `KtxLlmRuntimePort`
  (`context/llm/runtime-port.ts`). `CodexKtxLlmRuntime` / `ClaudeCodeKtxLlmRuntime`
  return a serializable `{ backend, projectDir, modelSlots }`; `AiSdkKtxLlmRuntime`
  (and the deterministic stub) return `null`. The per-table call branches on this,
  never on a vendor list (D1).
- **Shared structured core.** Both subprocess runtimes gained
  `generateStructuredJson(jsonSchema)` (returns the raw object; the caller
  Zod-validates). Their existing `generateObject` was refactored to delegate to the
  same streaming core, so structured generation has one implementation.
- **Kill boundary.** New `context/llm/subprocess-generate-object.ts`
  (`runGenerateObjectInSubprocess`, `KtxSubprocessDeadlineError`) forks a ktx-owned
  child (`subprocess-generate-object-child.ts`) **detached** (process-group leader);
  the SDK's model binary inherits the group. On the deadline or `ctx.signal`, ktx
  tree-kills the group with `SIGKILL` (`process.kill(-pid, …)` on POSIX,
  `taskkill /pid <pid> /T /F` on Windows) and rejects promptly; on success the raw
  output is Zod-validated. Credentials reach the child via inherited `process.env`
  (the runtimes re-derive their allowlisted env), never over IPC.
- **Wiring.** `KtxDescriptionGenerator.generateBatchedTableDescriptions`
  (`context/scan/description-generation.ts`) routes each retry attempt through the
  boundary for subprocess backends and keeps the native `AbortSignal` → `fetch`
  path for HTTP backends. A fired deadline maps to the existing
  `KtxAbortedError`/`enrichment_timeout` no-retry policy (one wedge = one timeout);
  default stays 120s (D2).
- **Tests.** `test/context/llm/subprocess-generate-object.test.ts` forks a real
  fixture child that spawns a grandchild and ignores SIGTERM, and asserts the
  deadline/abort tree-kills both (the grandchild PID is reaped) and the await
  settles within deadline+grace; plus success / schema-failure / child-error paths.
  `test/context/scan/description-generation.test.ts` adds the generator-level
  timeout-skip and the "HTTP backend spawns no child" cases.

### Gap #2 — incremental descriptions persistence + resume

- **Durable record + resume store.** `createKtxScanDescriptionResumeStore`
  (`context/scan/local-enrichment-artifacts.ts`) writes the descriptions-so-far to
  a durable record (inputHash-tagged) and **only the manifest shards that gained a
  table this batch** (new `onlyChangedTableNames` filter on
  `writeLocalScanManifestShards`, additive merge preserved). `load(inputHash)`
  returns the prior enriched set only on a matching inputHash (D3).
- **Resume-aware fan-out.** `generateDescriptions` (`context/scan/local-enrichment.ts`)
  loads the prior record, skips already-enriched tables, enriches only the
  remainder, flushes every `DESCRIPTION_FLUSH_EVERY` (10) completed tables (a single
  in-flight flush; the final force-flush drains the tail), and returns the full
  merged set (recovered + fresh + `null` for still-failed, so failures are retried,
  D4). Wired through `local-scan.ts` (store constructed when not `--dry-run`).
- **Graceful-skip backstop (requirement 6).** The per-table worker wraps the call in
  a try/catch: any non-cancellation failure degrades to one `null` description + an
  `enrichment_failed` warning and the fan-out continues, so no single table can
  reject `Promise.all` / abort the stage. This makes the "one skipped table costs one
  description, not the stage's output" guarantee live at the stage boundary
  (`generateBatchedTableDescriptions` already degrades its own failures; this is the
  explicit backstop). A `ctx.signal` cancellation still propagates (the stage fails
  and resumes), and the already-flushed descriptions stay durable. This closes the
  field bug where a completed-with-skips stage persisted 0 descriptions / 0 stage rows.
- **Deviation from the spec's literal path (necessary correction).** The durable
  record lives at a **stable, non-`syncId`** path
  (`raw-sources/<connectionId>/live-database/enrichment-progress/descriptions.json`),
  not the `syncId`-scoped `…/<syncId>/enrichment/descriptions.json` the spec named.
  Reason: a from-scratch interruption (the incident's exact case — no prior
  *completed* run) gets a **fresh `syncId`** on the next run
  (`buildSyncId` in `context/ingest/local-stage-ingest.ts`), so a `syncId`-scoped
  record would be unreachable on resume. The manifest is already at the stable
  per-connection scope (`semantic-layer/<connectionId>/_schema/`), so this keeps the
  resume source at the same stable scope. The `syncId`-scoped `enrichment/descriptions.json`
  debug artifact written by the terminal/checkpoint writers is unchanged.
- **Tests.** `test/context/scan/description-resume.test.ts` drives
  `runLocalScanEnrichment` against a real git-backed project: a fresh run flushes a
  durable record + `ai:` manifest descriptions; a matching-`inputHash` resume issues
  zero LLM calls and returns the full merged set; a partial record re-enriches only
  the missing tables; a changed `inputHash` recomputes; the changed-shard filter
  rewrites only the affected shard; and (requirement 6) a run where one table fails
  still persists the other tables (durable record + `ai:`) and **completes the stage**
  (a completed `local_scan_enrichment_stages` row), with the failed table left `null`
  for resume.

### Incidental

- Fixed a stale assertion in `description-generation.test.ts` ("does not run
  per-column fallback…" expected 1 call) to `3`, matching the retry policy added in
  commit `01f63380` (D2 / acceptance: a transient error retries up to the attempt
  limit). The HTTP path is unchanged; the assertion simply predated the retry.
- No new `ktx.yaml` config field or runtime knob was added (D2). The rate-limit
  governor is not wired into the scan-enrichment path, so the kill-boundary child
  loses no pacing.
- Rebuilt and re-linked (`pnpm run build && pnpm run link:dev`); the child compiles
  to `dist/context/llm/subprocess-generate-object-child.js`.
