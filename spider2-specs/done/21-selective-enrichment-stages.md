# 21 — Selective enrichment stages (`--stages`) + per-stage cache keys

**Status:** draft (intake). Requirement-level; the implementer refines into `specs/21-*.md`.

Follow-on to spec 19 (durable/resumable relationship detection) and spec 20 (resilient enrichment).
Those made enrichment *survivable and resumable*; this makes it *selectively re-runnable* — re-run one
enrichment stage without re-paying for the others.

## Problem / requirement

Enrichment has three stages — **`descriptions`** (per-table LLM text), **`embeddings`**
(sentence-transformers over the schema/descriptions), **`relationships`** (FK/join detection, optionally
LLM-proposed). Today you cannot re-run a *subset* of them, and three facts in the current code make a
targeted re-run impossible without a full, expensive re-enrich:

1. **One coarse cache key gates all three stages.** `context/scan/local-enrichment.ts:611` computes a
   single `inputHash` from `{snapshot, mode, detectRelationships, providerIdentity, relationshipSettings}`,
   and all three stages reuse it (descriptions ~`:641`, embeddings ~`:672`, relationships ~`:728`). So
   changing *any* one stage's inputs invalidates *every* stage's cache. Concretely: flipping
   `scan.relationships.llmProposals`, switching the LLM backend, or upgrading the embeddings model forces
   ktx to re-run the **expensive per-table descriptions** even though they didn't conceptually change.
2. **No CLI surface to select stages.** The enrichment internally already supports a relationships-only
   path (`mode: 'relationships'`, which skips the description/embedding stages — they're gated on
   `mode === 'enriched'`), but `ktx ingest` exposes no flag to invoke it (only `--no-query-history`).
   The capability is built; it's just not reachable.
3. **The per-stage storage already exists** (`local_scan_enrichment_stages` PK `(connection_id, stage,
   input_hash)`) and the **additive write already preserves existing descriptions** on re-ingest — so the
   foundation for "touch one stage, keep the rest" is in place; only the key granularity and the CLI
   surface are missing.

**Requirement:** let an operator re-run a chosen subset of enrichment stages on already-ingested
connection(s), recomputing only those stages and **preserving the others' artifacts untouched** — cheaply,
without re-running unchanged (especially the costly `descriptions`) stages.

## Design decisions (resolved during intake; implementer may refine)

- **CLI flag: `--stages <comma-list>`** (plural). Accepts a comma-separated subset of
  `descriptions,embeddings,relationships`; default = all three (current behaviour). Plural because it takes
  a *set*; `--stages relationships` and `--stages descriptions,embeddings` both read naturally, and the
  plural signals "list expected" (singular `--stage` implies exactly one). **Validate** the names — an
  unknown stage is an error, never silently ignored.
- **Per-stage `inputHash`.** Split the single coarse hash so each stage keys on *only its own* inputs:
  - `descriptions` → `{snapshot, mode, providerIdentity}` (NOT relationship settings, NOT embedding model)
  - `embeddings`   → `{snapshot, embeddings model/provider, + the description text it embeds}`
  - `relationships`→ `{snapshot, relationshipSettings (incl. llmProposals), providerIdentity}`
  Then flipping `llmProposals` invalidates only `relationships`; swapping the embeddings model invalidates
  only `embeddings`; improving description prompts/LLM invalidates only `descriptions`.
- **Preserve-others semantics.** Stages not named in `--stages` are left exactly as on disk (additive write,
  already the behaviour). A selective run never deletes another stage's artifacts.
- **Downstream-staleness handling.** Stages have a dependency order (`descriptions → embeddings`;
  `relationships` depends only on the schema snapshot). Re-running `descriptions` alone can leave existing
  `embeddings` semantically stale (they embedded the old text). The run must **warn** when a selected
  re-run leaves an unselected downstream stage stale, and the operator can opt to cascade
  (`--stages descriptions,embeddings`). Do not silently leave a stale-but-unflagged downstream.
- **`relationships` uses existing descriptions as context.** When re-running `relationships` only, the
  stage should read the existing enriched schema (incl. on-disk `ai:` descriptions) so `llmProposals` has
  full context — not just raw column names.
- **Scope:** the three enrichment stages for now. Design the stage-name namespace so it can later extend to
  the broader scan phases (schema / query-history / source / memory) and subsume the inconsistent
  `--no-query-history` negative flag, but that unification is out of scope here.

## Sketch (implementer to refine)

- Add `--stages` to `ktx ingest`; parse+validate into a stage set; thread it to the enrichment entry so it
  selects which stage blocks run (reuse the existing `mode`/stage gating — `mode: 'relationships'` is the
  precedent).
- Replace the single `computeKtxScanEnrichmentInputHash` call with per-stage hash computation keyed on each
  stage's own inputs; gate each stage's resume/skip on its own hash.
- Ensure selective runs read + preserve the on-disk enriched schema and write additively.
- Emit a clear staleness warning when an unselected downstream stage is invalidated by a selected one.

## Generic use case (independent of the benchmark)

Any team running ktx in production maintains its semantic layer over time: they improve description prompts
or switch the description LLM, upgrade the embeddings model, or turn on LLM-proposed joins. Today each of
those forces a **full re-enrich of every connection** — re-running the expensive per-table descriptions
even when only embeddings or relationships changed. Selective `--stages` re-runs makes these routine
maintenance operations cheap and targeted: "re-embed everything on the new model" or "backfill joins now
that llmProposals is on" become a single fast pass that leaves the untouched stages — and their cost —
alone. This is core operability for a long-lived ingestion product and is wholly independent of any
benchmark.

## Benchmark context (motivation only — not a benchmark-specific rule)

Surfaced during the Spider 2.0-Lite multi-backend ingestion (2026-06-24). A level-aware audit found (a) a
tail of BigQuery dbs with poor *column*-description coverage (`google_dei` ~1%, `gnomAD`, `usfs_fia`, …)
that want a **`descriptions`-only** re-run with a longer timeout, and (b) a desire to **backfill joins**
across all already-ingested dbs after enabling `llmProposals` — without re-paying for descriptions. Both
were blocked by the coarse single `inputHash` (flipping `llmProposals` or re-describing would invalidate
the whole enrichment) and the absence of a stage-selective CLI flag. The benchmark just exercised
large-scale multi-backend ingestion; the gap and the fix are generic.
