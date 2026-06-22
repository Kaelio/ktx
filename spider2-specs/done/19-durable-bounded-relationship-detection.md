# 19 — Durable, resumable, bounded relationship detection during ingest enrichment

**Status:** intake draft (todo). Requirement-level; the implementer refines into `specs/19-…`.

## Problem (generic, real-world)

Ingest enrichment runs three stages in a fixed order inside `runLocalScanEnrichment`
(`packages/cli/src/context/scan/local-enrichment.ts`):

1. `descriptions` (`:530`) — per-table LLM descriptions (the expensive step: one model call per
   table; on a large schema this is minutes of paid LLM work).
2. `embeddings` (`:559`) — column embeddings.
3. `relationships` (`:593`) — FK/join discovery: profiles a row sample of **every** table, then
   validates candidate joins.

The queryable semantic-layer artifacts are persisted **once, at the very end**, by
`writeLocalScanEnrichmentArtifacts` in `local-scan.ts:510` — which runs **after**
`runLocalScanEnrichment` returns, i.e. after all three stages.

This creates three failure modes that compound on large schemas (hundreds of tables):

1. **Enrichment is lost if relationship detection is interrupted.** The descriptions + embeddings
   are computed and held in memory, but they only reach the durable, queryable artifacts when the
   final write runs after the `relationships` stage. If the process is killed/crashes/times out
   **during** relationship detection (the last, slowest, silent stage), the artifacts are never
   written — the schema survives (it was written earlier at `local-scan.ts:473`) but **all the
   paid LLM enrichment is discarded**. Empirically: ingesting a 95-table BigQuery dataset produced
   full descriptions + embeddings (progress reached "Building embeddings 17/17"), then the
   relationships stage ran silently past a supervising deadline and was killed — the persisted
   `_schema` had **0** AI descriptions, only the native column comments. Every larger dataset hits
   this, so the most expensive work is the most likely to be thrown away.

2. **Re-running does not resume — it re-spends.** There is a stage state store
   (`SqliteLocalScanEnrichmentStateStore`) and a `runEnrichmentStage` helper (`:413`) that saves
   each completed stage's output. But the completed-stage lookup keys on **`runId`**
   (`findCompletedStage({ runId, stage, inputHash })`, `:427`), and `runId` is fresh per ingest
   invocation. So resume only works *within* a single run; re-running an interrupted ingest gets a
   new `runId`, misses the cache, and **re-computes descriptions + embeddings from scratch**
   (re-paying for the LLM work that already succeeded).

3. **Relationship detection is unobservable and unbounded.** The stage emits no progress between
   "Detecting relationships" and the final "Relationship detection found N accepted" — minutes of
   silence on a large schema. A supervisor watching for liveness cannot distinguish a slow-but-
   working profile from a true hang, and there is no internal time/work budget, so on a very large
   schema it can run far longer than any reasonable deadline.

## Requirements

1. **Checkpoint queryable artifacts before relationship detection.** Persist the descriptions +
   embeddings into the semantic-layer artifacts as soon as the `embeddings` stage completes, before
   the `relationships` stage runs. Relationship detection then appends/merges its own artifact on
   completion. Net: the expensive LLM + embedding enrichment is **always durable and queryable**,
   even if relationship detection fails, is interrupted, or is skipped. (A failed/partial
   relationship stage should degrade to "no/partial joins", never to "no descriptions".)

2. **Make stage resume work across runs.** Resolve a completed stage by stable content identity
   — `(connectionId, stage, inputHash)` — independent of `runId`, so re-running an interrupted
   ingest resumes the finished `descriptions`/`embeddings` stages from cache and only re-runs what
   actually failed (e.g. `relationships`). Re-running after an interruption must not re-spend LLM
   credits on stages that already succeeded.

3. **Make relationship detection observable and bounded** (mirrors spec 16's bounded query
   execution). Emit progress through the existing progress port — e.g. "Profiling table K/N",
   "Validating candidate K/M" — so liveness is visible. Enforce an overall time/work budget
   (configurable, e.g. under `scan.relationships`) so on a very large schema the stage stops
   gracefully and returns the relationships found so far (partial) rather than running unboundedly.
   Partial completion is persisted (per requirement 1) and marked as such.

## Acceptance

- Interrupting an ingest **during** relationship detection still leaves a queryable semantic layer
  with the table/column descriptions + embeddings that were generated (verified: re-open the
  connection, descriptions are present).
- Re-running an interrupted ingest **does not** regenerate descriptions/embeddings whose stage
  already completed (verified: no LLM description calls for the cached tables; only the failed
  stage re-runs).
- A connection with hundreds of tables emits relationship-stage progress and completes within the
  configured budget, persisting partial relationships if the budget is hit — without discarding
  enrichment.
- Small/single-run ingests behave exactly as before (no regression in artifacts or relationship
  output when nothing is interrupted).

## Benchmark context (motivation only — do not encode benchmark specifics)

The Spider 2.0-Lite BigQuery slice has datasets with hundreds–thousands of tables (`ebi_chembl`
785, `fec` 486, `ga360` 366, …). Enriching them with claude-code costs real, rate-limited LLM
budget; losing that enrichment to a relationship-stage interruption — and re-spending it on every
retry — makes large-schema ingest impractical. This is a general durability/cost property of the
ingest pipeline, independent of the benchmark; the benchmark only made it acute at scale.
