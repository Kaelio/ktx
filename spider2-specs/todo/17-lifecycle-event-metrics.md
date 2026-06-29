# 17 — Lifecycle-event metrics in the semantic layer

**Status:** draft (intake). Requirement-level; the implementer refines into `specs/17-*.md`.

## Problem / requirement

Many entities carry **several lifecycle timestamps** for the same record — an order has
`placed/purchased`, `approved`, `shipped/carrier-handoff`, `delivered`, and `estimated-delivery`
times; a ticket has `opened`, `assigned`, `resolved`, `closed`; a payment has `initiated`,
`authorized`, `settled`. When an analyst asks for a count/volume/rate of records **in a named
completed state, by period** ("delivered orders by month", "resolved tickets per week", "settled
payments by day"), the correct time anchor is the timestamp of *that named event*, not the
record-creation timestamp.

Today ktx ingests these timestamps as **peer date dimensions** with good column descriptions, but it
does **not model the lifecycle event itself** — so nothing in the semantic layer tells a solver (or a
human) that "delivered orders over time" should be anchored to the delivery timestamp. The choice is
left to per-query reasoning, which is exactly where it goes wrong. (A companion analytics-skill rule
now nudges the *solver* — ktx commit `226341cf` — but the durable, reusable home for this is the
**model**, so any consumer of the semantic layer gets it for free.)

**Requirement:** during enrichment/ingestion, when a source has a state/status column plus one or more
lifecycle timestamps whose names/descriptions map to that state's values, infer **lifecycle-event
metrics** — e.g. a `delivered_orders` metric defined as `COUNT(*)` filtered to the delivered state with
its **default time dimension** set to the matching event timestamp (`order_delivered_customer_date`),
distinct from the creation-anchored `orders` metric. Keep the inference conservative and
source-traceable (column names + enriched descriptions only); never invent a state/timestamp pairing
that the schema/descriptions don't independently support.

## Sketch (implementer to refine)

- Detect (state column, lifecycle-timestamp) pairs from column names + enrichment descriptions
  (e.g. status value `delivered` ↔ `*_delivered_*_date`; `resolved` ↔ `resolved_at`).
- Emit a metric per detected completed state: filter = the state predicate, grain = record,
  `defaultTimeDimension` = the matching event timestamp.
- Surface these via `discover_data` / `entity_details` so "delivered orders over time" retrieves the
  delivery-anchored metric rather than a bare row count over the creation date.
- Gate behind the existing `enrichment.mode: llm` path; respect the conservative-inference bar
  (precision over recall — a wrong pairing is worse than none).

## Generic use case (independent of the benchmark)

Any operational/transactional schema (e-commerce orders, support tickets, payments, claims, shipments)
has this multi-timestamp lifecycle shape. An analyst asking "how many X were <completed-state> last
month" almost always means *entered that state* last month. Encoding the event→timestamp mapping in the
model makes every downstream question (BI tool, ad-hoc SQL, an LLM agent) pick the right anchor without
re-deriving it, and prevents the silent "grouped by when they started" error.

## Benchmark context (motivation only — not a benchmark-specific rule)

Surfaced by the `spider2-autofix` loop, round r1: Spider 2.0-Lite `Brazilian_E_Commerce` cases local028
("delivered orders for each month") and local031 ("highest monthly delivered orders volume") both failed
because the solver bucketed delivered orders by `order_purchase_timestamp` instead of
`order_delivered_customer_date`. The trace showed the solver had both columns and even compared both
date bases for local031 before choosing purchase. A skill-text rule flipped both cases this round; this
spec is the **model-layer** form of the same fix, which would make the right anchor the default for any
solver and any lifecycle schema.
