# Durable, resumable, bounded relationship detection during ingest enrichment

> Refined spec. Intake draft: `todo/19-durable-bounded-relationship-detection.md`.
>
> **Scope: make the expensive part of ingest enrichment survive an interrupted
> relationship stage.** Today the paid LLM descriptions + embeddings only become
> durable and queryable after the slowest, most-killable, least-valuable stage
> (relationship detection) also finishes. This spec moves the persistence boundary
> to the cost boundary, makes stage resume work across runs, and bounds + observes
> the one open-ended stage — the durability companion to spec 16 (bounded query
> execution), which this spec composes with rather than replaces.

## Problem

Three compounding failure modes, all confirmed in the current code, share one root
cause: **the three enrichment stages are treated as a single atomic unit for
persistence, identity, and bounding, even though they differ radically in cost,
durability value, runtime, and likelihood of being killed.**

`runLocalScanEnrichment` (`context/scan/local-enrichment.ts:472`) runs three stages
in a fixed order through `runEnrichmentStage` (`:413`):

| stage | order | cost | durability value | runtime on a large schema | likely to be killed |
|-------|-------|------|------------------|---------------------------|---------------------|
| `descriptions` (`:524`) | 1st | high — one paid LLM call per table | high | minutes | low |
| `embeddings` (`:553`) | 2nd | medium | high | seconds–minutes | low |
| `relationships` (`:587`) | 3rd | low — best-effort joins | low | **minutes, silent** | **high** |

The slowest, most-killable, least-valuable stage runs **last**, and it gates the
durability of the two expensive stages held in memory before it.

### 1. Enrichment is lost if relationship detection is interrupted

The queryable artifact agents search and execute against is the `_schema` manifest
YAML (`semantic-layer/<connectionId>/_schema/*.yaml`). It is written **twice**:

- bare (native column comments only) early, at `local-scan.ts:473`
  (`writeLocalScanManifestShards`), before enrichment runs; and
- rewritten **with AI descriptions + accepted joins** by
  `writeLocalScanEnrichmentArtifacts` (`local-enrichment-artifacts.ts:310`), called
  from `local-scan.ts:510` **after** `runLocalScanEnrichment` returns — i.e. after
  all three stages.

So the descriptions and embeddings reach the queryable layer only via that single
terminal write. If the process is killed/crashes/times out **during** the
`relationships` stage, `runLocalScanEnrichment` never returns, the terminal write
never runs, and the in-memory descriptions + embeddings are discarded — the
`_schema` retains only the bare native comments from the `:473` write.

Empirically (intake draft): ingesting a 95-table BigQuery dataset produced full
descriptions + embeddings (progress reached "Building embeddings 17/17"), then the
relationship stage ran silently past a supervising deadline and was killed; the
persisted `_schema` had **0** AI descriptions. The most expensive work is the most
likely to be thrown away.

> A stage-state store (below) does save each completed stage's output to an
> internal SQLite cache as the stage finishes — so the descriptions are not lost to
> the *resume cache*. They are simply never **promoted** to the queryable `_schema`
> until the terminal write. The data survives somewhere the agent cannot query, and
> (per failure mode 2) cannot be reused on the next run either.

### 2. Re-running does not resume — it re-spends

`runEnrichmentStage` resolves a completed stage with
`findCompletedStage({ runId, stage, inputHash })` (`local-enrichment.ts:427`), and
the store keys on **`runId`**: `SqliteLocalScanEnrichmentStateStore` declares
`PRIMARY KEY (run_id, stage)` and filters lookups by `run_id`
(`sqlite-local-enrichment-state-store.ts:83,91–115`). `runId` is minted fresh per
ingest invocation (`record.runId`). The cache therefore only resolves *within* one
run; re-running an interrupted ingest gets a new `runId`, misses every cached
stage, and **recomputes descriptions + embeddings from scratch** — re-paying for
LLM work that already succeeded.

The store already computes and persists `inputHash` next to `runId` —
a stable `sha256` of `{ snapshot, mode, detectRelationships, providerIdentity,
relationshipSettings }` (`enrichment-state.ts:78`). The correct content key is
already on the row; the lookup just uses the volatile column. This is a keying
defect, not a missing capability.

### 3. Relationship detection is unobservable and unbounded

`discoverKtxRelationships` (`context/scan/relationship-discovery.ts:218`) profiles a
row sample of **every enabled table** (`profileKtxRelationshipSchema`,
`relationship-profiling.ts:320` — one sampled query per table at
`profileConcurrency`, default 4), validates candidate joins
(`relationship-validation.ts:237` — one coverage query per candidate), and detects
composite keys (`relationship-composite-candidates.ts:515` — per-table plus
cross-table queries). None of the controls the rest of the scan pipeline relies on
were ever wired into this stack:

- **No progress.** `discoverKtxRelationships` does not accept a progress port; the
  caller can only emit start/end around it (`local-enrichment.ts:600,611` —
  `update(0, 'Detecting relationships')` … `update(1, 'found N')`). Minutes of
  silence between.
- **No honored cancellation.** `KtxScanContext.signal` exists on the contract
  (`types.ts`) but **no sub-stage reads it**.
- **No time budget.** Validation has a *count* budget (`validationBudget`, default
  `min(2 × tableCount, 1000)`); profiling and composite detection have none. On a
  schema with hundreds–thousands of tables, profiling is O(tables) silent queries
  with no internal stop condition.

A supervisor watching for liveness cannot tell a slow-but-working profile from a
true hang, and nothing inside the stage will voluntarily stop — so on a very large
schema it runs far past any reasonable deadline and is killed (which, via failure
mode 1, takes the descriptions with it).

## Generic use case (independent of any benchmark)

Any context layer that enriches a real warehouse with paid LLM work must make that
work durable the instant it is produced, resume it across process restarts without
re-paying, and bound the open-ended profiling stage so a large catalog cannot hang
ingest indefinitely. A data team ingesting a 500-table production warehouse over a
flaky connection, a rate-limited LLM budget, or a CI step with a wall-clock limit
hits all three failure modes regardless of any benchmark. This is general
durability and cost hygiene for the ingest pipeline; the benchmark only made it
acute at scale.

## Design decisions (resolved during refinement)

These resolve ambiguities the intake draft left open. They constrain the
implementer; the exact code is theirs (requirement-level, per the specs README).

### D1 — Checkpoint queryable artifacts at the cost boundary, before relationships

As soon as the last non-relationship stage completes — `embeddings` when an
embedding provider is configured, otherwise `descriptions` — persist the
descriptions + embeddings into the **queryable** `_schema` manifest (and the raw
`descriptions.json` / `embeddings.json` enrichment artifacts), **before** the
`relationships` stage runs. The relationship stage then writes its joins on top: the
manifest builder already re-reads and preserves existing descriptions and
manual/inferred joins on rewrite (`loadExistingManifestState`,
`local-enrichment-artifacts.ts:196`), so the second write is additive, not
destructive.

Net invariant: **the descriptions + embeddings are always durable and queryable the
moment they are computed**, even if relationship detection then fails, is
interrupted, is budget-truncated, or is skipped. A failed/partial/skipped
relationship stage degrades to "no joins" or "partial joins" — **never** to "no
descriptions." This is the inverse guarantee the current terminal-write ordering
violates.

The bare `:473` manifest write stays — it is the queryable schema for the
no-providers / enrichment-disabled path. The checkpoint is an additional write that
runs only when enrichment produced descriptions.

> Orientation (the implementer owns the seam): the lowest-coupling shape is a
> checkpoint hook — `runLocalScanEnrichment` invokes a caller-supplied callback once
> the last non-relationship stage completes, and `local-scan.ts` supplies a callback
> that calls the existing `writeLocalScanEnrichmentArtifacts` for the
> descriptions + embeddings + manifest only (no generated joins yet). The final
> write after the relationship stage proceeds as today. Relationship-specific
> artifacts (`relationships.json`, `relationship-profile.json`,
> `relationship-diagnostics.json`) are written by the final/relationship write, not
> the checkpoint, so the checkpoint never emits misleading empty relationship
> diagnostics.
>
> Rejected alternative: move all artifact writing inside `runLocalScanEnrichment`
> (inject the file store / project). That couples the enrichment module to
> persistence for no gain — the writer already lives in `local-scan.ts` and the
> checkpoint needs only a one-line hook, not a relocation.

### D2 — Resume by content identity, not by `runId`

Re-key completed-stage resolution on **`(connectionId, stage, inputHash)`**,
independent of `runId`, so a re-run with an unchanged schema and config resumes the
finished `descriptions` / `embeddings` stages from cache and re-runs only what
actually failed. `inputHash` is already the content fingerprint; `connectionId`
scopes it to the right source. When several rows share a content identity (one per
prior run), the most recent `updatedAt` wins.

`runId` stays on the stored row for diagnostics and for `listRunStages`, but leaves
the uniqueness/lookup key.

The state store is a **disposable local resume cache** (`.ktx` local state,
regenerable from a fresh ingest). Re-key it with **no migration bridge** — recreate
the table if its on-disk shape differs from the new `(connection_id, stage,
input_hash)` key, consistent with ktx's no-backward-compatibility policy. Losing the
old cache only means one ingest cannot resume; it never corrupts a queryable
artifact.

> Rejected alternative: include `syncId` or `mode` in the key. `mode` and the rest
> are already folded into `inputHash`; adding them again would only narrow the key
> and re-break cross-run resume when an incidental field differs.

### D3 — Make the relationship stage observable and bounded

Thread three things the rest of the pipeline already supports through
`discoverKtxRelationships` into profiling, validation, and composite detection:

- **Progress** through the existing progress port (the relationship phase is
  already `progress?.startPhase(0.25)` at `local-enrichment.ts:586`): emit per-unit
  liveness — "Profiling table K/N", "Validating candidate K/M", and the equivalent
  for composite probing — so a supervisor can distinguish slow-but-working from
  hung.
- **A flat wall-clock budget** for the whole relationship stage: a new
  `scan.relationships.detectionBudgetMs`, a positive integer of milliseconds,
  project-level, validated like the other `scan.relationships` fields, **default
  600_000 (10 min), enforced by default.** Checked at unit boundaries (before each
  table profile, each candidate validation, each composite probe). It sits **above**
  spec 16's per-query deadline (default 30s): each individual query is already
  bounded; this bounds the *sum* of them.
- **Honored cancellation:** where `KtxScanContext.signal` is available, the same
  unit-boundary check honors it, so external cancellation stops the stage too.

On budget exhaustion or abort: stop scheduling new work, let in-flight queries
finish (each already bounded by spec 16), finalize with the relationships found so
far, and return a **partial** result — never an unbounded hang and never an
exception that would lose the checkpointed descriptions.

> Rejected alternative — per-table-scaled budget (N seconds × table count). It is a
> second formula to reason about and "more tables → more budget" partly re-opens the
> unbounded door this requirement closes. One flat, generous, project-level number
> matches how the other `scan.relationships` knobs are shaped and is enough for a
> best-effort stage whose partial output is durable and improvable (D4).
>
> Rejected alternative — a global `KTX_RELATIONSHIP_BUDGET_MS` env knob or a
> per-call override. One opinionated project-level default with a config override is
> the canonical ktx shape; no second runtime path.

### D4 — A budget-truncated partial is a successful, cached, completed stage

A graceful budget stop is **not** a failure. The relationship stage saves its
partial result like any completed stage (so a plain re-run resumes it for free, no
re-querying) and marks it `partial` with a reason in the relationship diagnostics
plus a recoverable scan warning. Because `detectionBudgetMs` lives in
`relationshipSettings ⊂ inputHash`, **raising the budget changes the content
identity and triggers a fresh, fuller run** — that is the only "try harder"
mechanism, with no extra flag or runtime path.

Distinguish the two stop kinds:

- **Process killed mid-stage** (crash / SIGKILL / supervisor): nothing is saved as
  completed, so the next run recomputes the relationship stage (after resuming
  descriptions/embeddings from cache via D2). This is the primary durability path.
- **Graceful budget/abort stop**: a partial *is* saved as completed-partial and
  resumed cheaply on re-run, unless the budget is raised.

## Requirements

### 1. Checkpoint descriptions + embeddings before relationship detection

The descriptions and embeddings MUST be persisted into the durable, queryable
`_schema` manifest (and the raw enrichment artifacts) as soon as the last
non-relationship stage completes, before the `relationships` stage runs.
Relationship detection appends/merges its joins on completion. The expensive LLM +
embedding enrichment MUST be queryable even if the relationship stage subsequently
fails, is interrupted, is budget-truncated, or is skipped. A failed/partial/skipped
relationship stage MUST degrade to "no/partial joins," never to "no descriptions."

### 2. Stage resume resolves by content identity across runs

Completed-stage resolution MUST key on `(connectionId, stage, inputHash)`,
independent of `runId`, so re-running an interrupted ingest resumes the finished
`descriptions` / `embeddings` stages from cache and re-runs only what failed.
Re-running after an interruption MUST NOT re-issue LLM description or embedding
calls for stages that already completed. The resume cache MAY be recreated without a
migration bridge if its schema changes (it is disposable local state).

### 3. Relationship detection emits progress and honors a wall-clock budget

The relationship stage MUST emit per-unit progress through the existing progress
port (at minimum per-table during profiling and per-candidate during validation) so
liveness is observable. It MUST enforce a flat wall-clock budget
(`scan.relationships.detectionBudgetMs`, default 600_000 ms, project-level,
overridable, validated as a positive integer) checked at unit boundaries and layered
above spec 16's per-query deadline, and MUST honor `KtxScanContext.signal` where
available. On budget exhaustion or abort it MUST stop scheduling new work, finalize
with the relationships found so far, and return a partial result rather than running
unboundedly or throwing.

### 4. A budget-truncated relationship result is durable and marked partial

A graceful budget/abort stop MUST persist the partial relationship result as a
completed stage (so a plain re-run resumes it without re-querying) and MUST mark it
`partial` — in the relationship diagnostics artifact and as a recoverable scan
warning — so downstream consumers can see the joins are incomplete. Raising
`detectionBudgetMs` (which changes `inputHash`) MUST cause a fresh, fuller
relationship run; no separate flag is introduced for "redo." A process killed
mid-stage MUST NOT leave a completed record (so it recomputes on re-run).

### 5. No regression for small or uninterrupted ingests

A small or single-run ingest that is never interrupted MUST produce the same
artifacts and the same relationship output as today. The checkpoint write MUST be
idempotent with the final write (descriptions survive the join rewrite); the budget
default MUST be generous enough that normal and large-but-tractable schemas complete
relationship detection fully, hitting the budget only on pathological scale.

## Acceptance criteria

- **Durability across interruption:** interrupting an ingest **during** relationship
  detection still leaves a queryable semantic layer carrying the table/column
  descriptions + embeddings that were generated (verified: re-open the connection;
  AI descriptions are present in `_schema`, not just native comments).
- **Resume does not re-spend:** re-running an interrupted ingest does **not**
  regenerate descriptions/embeddings whose stage already completed (verified: no LLM
  description calls and no embedding calls for the cached tables; only the failed
  stage re-runs). Resolution is by `(connectionId, stage, inputHash)`, so the resume
  survives a fresh `runId`.
- **Observable + bounded relationships:** a connection with hundreds of tables emits
  relationship-stage progress (per-table profiling, per-candidate validation) and
  completes within `detectionBudgetMs`; when the budget is hit, the stage stops
  gracefully and persists the partial relationships found so far — without
  discarding enrichment — marked `partial` in diagnostics and via a recoverable
  warning.
- **Partial is cached and improvable:** re-running with an unchanged budget resumes
  the partial relationship result from cache (no re-querying); raising
  `detectionBudgetMs` triggers a fresh, fuller relationship run.
- **Budget validation:** `detectionBudgetMs` defaults to 600_000, honors a project
  override, and rejects an invalid value (zero / negative / non-integer) as a clear
  `ktx.yaml` config error.
- **No regression:** small/single-run ingests behave exactly as before — identical
  artifacts and relationship output when nothing is interrupted; the checkpoint +
  final writes leave descriptions intact alongside the generated joins.

## Non-goals

- **Bounding the descriptions stage's per-table LLM call.** Whether an individual
  enrichment LLM call can wedge is a separate concern (already being addressed in the
  working tree via a per-table enrichment timeout). This spec ensures whatever
  descriptions *did* complete are durable; it does not own the per-call timeout.
- **Changing relationship-detection quality, thresholds, or the candidate/validation
  algorithm.** The accept/review thresholds, scoring, and the existing
  `validationBudget` count cap are unchanged; this spec adds durability,
  cross-run resume, progress, and a time budget around them.
- **A per-connection or per-call relationship budget, or a global env override.**
  One flat project-level `detectionBudgetMs`; no second runtime path (D3).
- **A new per-query timeout.** Spec 16 already bounds individual queries; this spec
  composes above it and does not re-implement query-level deadlines.
- **Replacing the per-query deadline with the stage budget, or vice versa.** They
  are independent and layered: a single query is bounded by spec 16; the stage's sum
  is bounded by `detectionBudgetMs`.
- **A general checkpoint framework for every ingest stage.** The checkpoint is
  specifically the descriptions+embeddings → queryable-manifest promotion before
  relationships; it is not a generic per-stage artifact-flush abstraction.

## Implementation orientation

Line numbers drift; treat these as anchors, not addresses. The implementer owns the
design.

- **Enrichment orchestration** — `context/scan/local-enrichment.ts`:
  `runLocalScanEnrichment` (`:472`), the three `runEnrichmentStage` calls
  (`descriptions` `:524`, `embeddings` `:553`, `relationships` `:587`),
  `runEnrichmentStage` (`:413`) and its `findCompletedStage` lookup (`:427`). Add the
  checkpoint hook after the last non-relationship stage; thread the progress port,
  signal, and budget into the relationship stage.
- **Scan driver / write ordering** — `context/scan/local-scan.ts`: bare manifest
  write (`:473`), enrichment call (`:492`, currently passing only
  `{ runId, progress }` as `context` — wire `signal` through here too), terminal
  `writeLocalScanEnrichmentArtifacts` (`:510`), and the enrichment-failure catch
  (`:530`, which after D1 no longer loses descriptions). Supply the checkpoint
  callback here.
- **Artifact writer** — `context/scan/local-enrichment-artifacts.ts`:
  `writeLocalScanEnrichmentArtifacts` (`:310`), `writeLocalScanManifestShards`
  (`:270`), and the description-preserving merge in `loadExistingManifestState`
  (`:196`) — the basis for the additive checkpoint/final write.
- **Resume cache** — `context/scan/sqlite-local-enrichment-state-store.ts`:
  `PRIMARY KEY (run_id, stage)` (`:83`), `findCompletedStage` (`:91`),
  `saveCompletedStage` (`:117`). Re-key on `(connection_id, stage, input_hash)`,
  pick latest `updated_at`, recreate the table if shape differs (disposable cache).
  Lookup interface `KtxScanEnrichmentStageLookup` and `findCompletedStage`
  in `context/scan/enrichment-state.ts` (`:10,46`); `computeKtxScanEnrichmentInputHash`
  (`:78`).
- **Relationship stack (progress + budget + signal)** —
  `context/scan/relationship-discovery.ts` (`discoverKtxRelationships` `:218`, accept
  a progress port and budget/deadline + signal),
  `context/scan/relationship-profiling.ts` (`profileKtxRelationshipSchema` `:320` —
  per-table progress + budget check),
  `context/scan/relationship-validation.ts` (`validateKtxRelationshipDiscoveryCandidates`
  `:237` — per-candidate progress + budget check, alongside the existing
  `validationBudget`),
  `context/scan/relationship-composite-candidates.ts`
  (`discoverKtxCompositeRelationships` `:515` — budget check).
- **Config** — `context/project/config.ts` `scan.relationships`
  (`KtxScanRelationshipConfig`, `:171–213`): add `detectionBudgetMs` (positive
  integer ms, default 600_000) to the zod schema and the default config builder.
- **Partial marker** — `context/scan/relationship-diagnostics.ts`
  (`buildKtxRelationshipDiagnostics`, the profile/diagnostics artifact shape) carries
  a `partial` flag + reason; add a recoverable warning code to the
  `KtxScanWarningCode` union in `context/scan/types.ts` (e.g.
  `relationship_detection_partial`).
- **Tests** — durability: a fixture ingest interrupted during the relationship stage
  leaves AI descriptions in the queryable `_schema`. Resume: a second run with a
  fresh `runId` and unchanged `inputHash` resolves the cached descriptions/embeddings
  (assert no LLM/embedding calls) and re-runs only relationships. Budget: a schema
  large enough (or a tiny `detectionBudgetMs` as the test seam) hits the budget,
  emits per-unit progress, returns partial, persists it marked `partial`, and a
  re-run resumes the partial; raising the budget re-runs. Resolver/config unit tests
  for `detectionBudgetMs` (default / override / invalid). Regression: small
  uninterrupted ingest yields identical artifacts and relationship output.
- After implementing, rebuild and re-link so the playground picks it up:
  `pnpm run build && pnpm run link:dev`.

## Benchmark context (motivation, not a requirement)

The Spider 2.0-Lite BigQuery slice has datasets with hundreds–thousands of tables
(`ebi_chembl` 785, `fec` 486, `ga360` 366, …). Enriching them with claude-code
costs real, rate-limited LLM budget; losing that enrichment to a relationship-stage
interruption — and re-spending it on every retry — makes large-schema ingest
impractical, and an unbounded profiling stage runs past any supervising deadline and
is killed. This is a general durability/cost property of the ingest pipeline,
independent of the benchmark; the benchmark only made it acute at scale. Do not
encode any benchmark specifics in the implementation.

## Implementation notes

Implemented on branch `write-feature-spec-wiki` (ktx worktree `tallinn-v2`). All
four design decisions shipped; no deviations from the resolved design.

**D2 — resume by content identity** (`sqlite-local-enrichment-state-store.ts`,
`enrichment-state.ts`, `local-enrichment.ts`): the stage table is re-keyed to
`PRIMARY KEY (connection_id, stage, input_hash)`; `findCompletedStage` looks up by
`(connectionId, stage, inputHash)` ordered by `updated_at DESC` (most recent
content identity wins). `KtxScanEnrichmentStageLookup.runId` became `connectionId`;
`runId` stays on the row for diagnostics/`listRunStages`. The store drops and
recreates the table when the on-disk primary key differs (disposable cache, no
migration bridge), detected via `PRAGMA table_info`.

**D3 — observable + bounded relationship stage** (new
`relationship-detection-budget.ts`): a sticky `KtxRelationshipDetectionBudget`
(`check()`/`stopReason()`) built from `detectionBudgetMs` + `ctx.signal` + an
injectable `now`, plus `mapWithBudget` (a budget-aware concurrent map that
generalizes and replaces the old `mapWithConcurrency`). Threaded through
`discoverKtxRelationships` → profiling (per-table progress + budget stop),
validation (per-candidate progress + budget stop; budget-skipped candidates
degrade to the existing `validation_unattempted` review), and composite
detection (budget stops at PK-detection and coverage-probe boundaries).
`discoverKtxRelationships` now accepts `progress` and `now` and returns
`partial: { reason } | null`. The clock check fires only when work remains, so a
deadline elapsing after the last unit never marks a fully-processed stage partial.

**D1 — checkpoint before relationships** (`local-enrichment.ts`,
`local-enrichment-artifacts.ts`, `local-scan.ts`): `runLocalScanEnrichment` fires a
caller-supplied `onCheckpoint` once descriptions/embeddings complete and before
the relationship stage runs, gated on `shouldDetectRelationships` so the
no-relationship path keeps a single write. `local-scan.ts` supplies a callback
calling the new `writeLocalScanEnrichmentCheckpoint` (descriptions.json +
embeddings.json + manifest with descriptions and no generated joins — no
relationship artifacts, so no misleading empty diagnostics). The shared
description/embedding JSON writer was factored out so checkpoint and final writes
stay one implementation. `ctx.signal` is now threaded from `RunLocalScanOptions`
into the enrichment context (completing the existing `KtxScanContext.signal`
contract already read by the budget and the in-flight description timeout).

**D4 — partial is durable + marked** (`relationship-diagnostics.ts`,
`local-enrichment.ts`, `local-enrichment-artifacts.ts`): the diagnostics artifact
carries `partial` + `partialReason`; `runLocalScanEnrichment` pushes a recoverable
`relationship_detection_partial` warning (new `KtxScanWarningCode`) when truncated.
A graceful budget/abort stop returns normally, so the relationship stage saves as a
completed-partial record and resumes cheaply; a process killed mid-stage saves
nothing and recomputes. Raising `detectionBudgetMs` changes `inputHash`
(it lives in `relationshipSettings`), forcing a fresh, fuller run — the only
"try harder" mechanism, no extra flag.

**Config** (`config.ts`): `scan.relationships.detectionBudgetMs`, positive integer
ms, default `600_000`, validated like the other relationship fields. Documented in
`docs-site/content/docs/configuration/ktx-yaml.mdx`.

**Tests** (all green): budget unit tests (`relationship-detection-budget.test.ts`);
cross-run resume + table-recreate (`enrichment-state.test.ts`,
`local-enrichment.test.ts`); progress/budget/abort partial
(`relationship-discovery.test.ts`); partial persisted/resumed/re-run-on-raise +
checkpoint ordering + no-checkpoint-when-skipped (`local-enrichment.test.ts`);
end-to-end durability — a relationship-stage failure still leaves AI descriptions
in the queryable `_schema` (`local-scan.test.ts`); diagnostics partial flag
(`relationship-diagnostics.test.ts`); config default/override/invalid
(`config.test.ts`). `pnpm --filter @kaelio/ktx type-check`, `pnpm run dead-code`,
and `pnpm run build && pnpm run link:dev` all pass. (Pre-existing and unrelated:
three `analytics-skill-content.test.ts` markdown-structure assertions fail on this
branch from earlier analytics-skill commits — untouched here.)
