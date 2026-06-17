# Canonical / authoritative-source measures in the semantic layer

## Problem

Many schemas contain an **authoritative table** that already encodes a metric's
business rules — an official standings/leaderboard table, a general-ledger or
period-end balance table, a materialized summary/snapshot — alongside the **raw
transactional** rows the metric *could* be re-derived from. Re-deriving the metric
from the raw rows frequently diverges from the canonical definition, because the
authoritative table bakes in rules the raw data doesn't expose (drop-scores,
penalties, adjustments, reconciliations, as-of snapshots).

Today ktx's semantic layer doesn't distinguish "authoritative summary" tables from
raw fact tables, so the analytics skill has no signal that one source is canonical
for a metric — and the agent often re-derives from raw rows and gets a defensible-
but-different number.

## Generic use case (independent of any benchmark)

- "Championship points per competitor this season" — a sports schema may hold both
  raw per-event results AND an official standings table that applies drop-scores
  and penalties. The standings table is the canonical source; summing raw results
  is wrong.
- "Account balance as of month end" — prefer a ledger/balance-snapshot table over
  re-summing every transaction (which may miss adjustments).
- "Monthly recognized revenue" — prefer a finance summary table over re-deriving
  from line items.

In each case a real analyst should be steered to the authoritative source.

## Requirements

1. **Detect candidate authoritative tables during ingest.** Heuristics only —
   e.g. tables whose name/role suggests a summary (`*standings*`, `*balance*`,
   `*summary*`, `*snapshot*`, `*ledger*`), tables that are a coarser-grained
   aggregation of another table, or tables documented as authoritative in provided
   docs/wiki. Surface them as such in the semantic layer.

2. **Represent the metric as an SL measure backed by the authoritative table.**
   Where a canonical source exists, define the measure over it so a query for that
   metric resolves to the authoritative source by default. (The analytics skill
   already prefers SL measures over raw SQL — spec 07/skill rule — so this plugs
   into existing behavior.)

3. **Keep raw re-derivation available** as a non-default alternative; the measure
   documents which source it uses and why, so the choice is transparent and
   overridable.

## Fairness boundary (HARD — this spec is fairness-sensitive)

The choice of authoritative source MUST be driven by **schema/structure or provided
documentation** — the table exists, is structured as a summary, or is documented as
authoritative. It must **NEVER** be driven by observing which interpretation matches
a benchmark gold answer. Concretely:

- ✅ Fair: "a table named/structured as official standings exists and aggregates the
  raw results → treat it as the canonical points source."
- ❌ Forbidden: "for question X, use table T because that's what reproduces the gold
  result." That is per-instance gold-tuning (cheating) and must not appear in ktx,
  the ingest heuristics, or any mapping.

If a metric is genuinely underspecified and only the gold answer disambiguates the
intended source, it is **not fairly fixable** — leave it. Whether this feature helps
any specific benchmark instance is therefore *conditional* on a real schema/doc basis
existing; do not manufacture one.

## Leak-safety (hard constraint)

No benchmark table names, queries, gold values, or instance-specific mappings
anywhere in the spec, the heuristics, or tests. Examples must be synthetic/generic.

## Acceptance criteria

- Ingest can flag candidate authoritative/summary tables via generic heuristics
  (name/role/aggregation/doc signals), with no benchmark-specific rules.
- The semantic layer can express a measure as backed by a designated authoritative
  source; the skill resolves the metric to it by default; raw re-derivation remains
  available and the choice is documented.
- Tests use synthetic schemas only; no gold-derived mappings exist anywhere.

## Benchmark context (motivation only)

Some SQLite-subset metric questions are underspecified between a raw-derivation and
an authoritative-table interpretation (e.g. season points from raw results vs an
official standings table). This is the roadmap's "canonical semantic-layer measures
from schema + provided docs" item. It is fair ONLY where schema/docs support one
source; the gold-only cases are explicitly out of scope (fixing them would require
tuning to gold). Larger than the spec 09–12 skill-content tweaks: this touches
ingest + the semantic-layer model.
