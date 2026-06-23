# 20 — Resilient enrichment under a slow/hung LLM backend

**Status:** draft (intake). Requirement-level; the implementer refines into `specs/20-*.md`.

This is the **enrichment-stage** analog of two already-shipped specs:
- spec 16 (bounded query execution) — bound *and actually cancel* a runaway read query (child-thread/process kill, not a cosmetic JS deadline);
- spec 19 (durable/bounded relationship detection) — checkpoint expensive ingest work so an interruption doesn't lose it.

Spec 16 hardened the **read-query** path and spec 19 checkpointed at **stage boundaries**. The same two
weaknesses still exist *inside the descriptions enrichment stage*, and together they turned a single hung
table into an indefinite wedge plus total loss of an entire stage's LLM work.

## Problem / requirement

Two compounding gaps on the per-table description-enrichment path, observed end-to-end:

### 1. The per-table LLM timeout does not actually terminate the work

The per-table `generateObject` enrichment call is wrapped in `retryAsync` with a fresh
`AbortSignal.timeout(KTX_ENRICH_LLM_TIMEOUT_MS)` per attempt (ktx commit `01f63380`). When the LLM
backend is a **subprocess** (the `codex` backend spawns a child `codex` process; `claude-code` likewise
spawns a child) and that child **hangs with an open connection to the provider** (TCP ESTABLISHED, ~0%
CPU, no bytes flowing), the JS-level `AbortSignal` fires but **does not kill the child process or unblock
the await** — so the call sits *past* its own timeout indefinitely.

Observed (BigQuery ingest, codex backend, 2026-06-23): with `KTX_ENRICH_LLM_TIMEOUT_MS=1800000` (30 min),
two of `covid19_usa`'s widest tables (252 columns) hung; the stage sat at **268/285 for 41+ minutes** —
well past the 30-min per-attempt timeout — with exactly two codex children, each holding 3 ESTABLISHED
connections at ~0% CPU, until killed by hand. The timeout was cosmetic: it never terminated the hung
child. (This is precisely the failure mode spec 16 fixed for SQL — a deadline that fires in JS but cannot
interrupt the underlying work — applied to the enrichment LLM call instead of the query.)

**Requirement:** the per-table enrichment-call timeout must be **enforced**, not advisory — when it fires,
the in-flight work is actually cancelled (subprocess SIGKILL for process-backed providers; request abort
for HTTP-backed ones) and the call returns/throws *promptly* so the stage can proceed (skip the table per
the existing no-retry-on-timeout policy). A hung table must cost at most ~one timeout, never unbounded
wall-clock. Provider-agnostic: it must hold for `codex`, `claude-code`, and HTTP backends alike.

### 2. Descriptions are checkpointed only at full-stage completion, so a few bad tables lose all the good ones

Spec 19 persists the descriptions checkpoint **after the descriptions stage completes** (before
relationships). There is no *within-stage* persistence: while the stage runs, every enriched table's
description lives only in memory. So if the stage cannot complete — e.g. 2 tables out of 285 hang (gap #1),
or the process is killed, or it hits the stall watchdog — **all** the already-enriched tables are lost,
even though their (expensive) LLM descriptions were finished.

Observed (same run): `covid19_usa` had **283/285** tables enriched in memory but **0** rows in
`local_scan_enrichment_stages` and **0** `ai:` descriptions on disk; killing the wedged ingest discarded
all 283, forcing a from-scratch re-ingest. The cost of 2 pathological tables was 283 tables' worth of
redone LLM calls.

**Sharper observation (re-ingest with a short, enforced timeout):** even when the stage *does* run to
the end — the 2 hung tables hit a 4-min timeout and were skipped, so 283/285 descriptions were generated
and the ingest reported success (`Scan completed` / `Ingest finished`, embeddings built, exit 0) — the
descriptions were **still persisted as 0** (0 `ai:` on disk, 0 stage rows). So the discard is **not** just
"lost on kill": a stage that completes with *any* skipped/aborted table currently persists **nothing**,
throwing away every successfully-generated description. The skip must be graceful — a skipped table costs
one missing description, not the entire stage's output. (This is the strongest argument for per-table
incremental persistence: the 283 good descriptions should have been durable the moment each was produced.)

**Requirement:** persist enriched descriptions **incrementally** (per-table or per-batch) during the
descriptions stage, so that (a) tables that finished are durable even if the stage never completes, and
(b) a resumed ingest re-does only the *unfinished* tables, not the whole stage. The existing additive-write
design (spec 19 already preserves existing descriptions on re-ingest) is the foundation; this extends the
checkpoint granularity from once-per-stage to incremental.

## Sketch (implementer to refine)

- **Enforced timeout:** route enrichment-call cancellation through real termination — kill the codex/
  claude-code child process on timeout (reuse spec 16's child-kill mechanism), abort the HTTP request for
  network backends. A fired `AbortSignal` must guarantee the await settles within a bounded grace period.
- **Sane default + the right tradeoff:** the default per-table timeout should be **moderate** (single-digit
  minutes) with a small retry count, not very large — because the cost of a *hang* is the timeout value
  itself, a long timeout is strictly worse for hangs. (The 30-min value used in the incident was an operator
  override chosen to avoid cutting off slow-but-completing wide tables; with #1 enforced and incremental
  checkpointing, a moderate default + skip is the better operating point.)
- **Incremental persistence:** flush descriptions per-batch (e.g. every N completed tables or on a timer) to
  the same store/format used at stage completion; on resume, treat already-persisted tables as done and only
  enrich the remainder. Keep it idempotent and additive (don't clobber prior descriptions).
- **Interaction with the stall watchdog:** with #1 enforced, no single table can starve progress for longer
  than ~one timeout, so an external stall watchdog stops being the only backstop.

## Generic use case (independent of the benchmark)

Anyone ingesting a large or wide schema with an LLM enrichment backend (especially a *subprocess* backend,
which is the common local/desktop setup) will eventually hit a table whose description call hangs — a
provider stall, a rate-limit black-hole, a pathologically large prompt. Without an *enforced* timeout, one
such table wedges the whole ingest indefinitely; without *incremental* persistence, any interruption throws
away all the per-table LLM work already done (the dominant ingest cost). Both fixes make large-schema
enrichment **resilient and resumable** — a few bad tables degrade to a few skipped descriptions, not a
hung process and a from-scratch redo. This is core robustness for a general-purpose ingestion product,
wholly independent of any benchmark.

## Benchmark context (motivation only — not a benchmark-specific rule)

Surfaced during the Spider 2.0-Lite **BigQuery** ingest (2026-06-23, codex enrichment backend). Re-enriching
the giant public datasets, `covid19_usa` wedged at 268/285 for 41+ minutes on 2 hung 252-column tables; the
30-min per-table `AbortSignal` timeout never killed the hung codex children, and because descriptions
checkpoint only at stage completion, the 283 already-enriched tables were unrecoverable — the operator had
to kill, cache-bust, and re-ingest the db from scratch (with a short timeout as a stopgap). The benchmark
just exercised a large/wide multi-dataset ingest at scale; the gap and the fix are generic.
