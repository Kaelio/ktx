# Strengthen fan-out-join safety for multi-hop aggregation in the analytics skill

## Problem

The `ktx-analytics` skill already carries a fan-out rule (spec 07, rule 4:
*"Avoid fan-out joins — add columns only from tables already at the target
grain, or pre-aggregate to that grain before joining; a join that multiplies
rows quietly inflates every downstream `SUM`/`COUNT`"*). In practice the agent
honors it on a single join but still **silently fan-outs on multi-hop join
chains**, where the inflation is one or two joins removed from the aggregate and
therefore much harder to notice.

The failure shape: a metric that lives at a *coarse* grain (e.g. one row per
parent record) is counted/summed *after* the parent has been joined down to a
*finer* grain (e.g. one row per child line). Every parent-level value is then
duplicated by its child fan-out, so `COUNT(*)` / `SUM(amount)` over-counts by an
amount that depends on the data — runnable SQL, plausible-looking number,
quietly wrong.

The rule today is stated as a *prohibition* ("avoid"). It needs to be a
*detect-and-fix habit*: a concrete multi-hop example of the trap, and an active
verification step the agent runs while composing, not just an instruction to be
careful.

## Generic use case (independent of any benchmark)

An analyst on any production warehouse asks: *"How many orders are there per
region?"* where the path from region to the order's detail runs through several
hops (region → store → order → order line). The honest answer counts each order
once. If the query descends to the line-level table along the way (e.g. for a
filter), each order is counted once **per line on the order**, inflating the
per-region total. Attribution here is unambiguous — each order belongs to exactly
one store and thus one region — so the *only* thing that can go wrong is the row
multiplication, which is exactly what makes it a clean teaching case. This is one
of the most common silently-wrong analytics mistakes on normalized schemas — it
is not
specific to any dataset, dialect, or benchmark.

## Requirements

This extends the existing `<sql_craft>` "Composition" guidance in the
`ktx-analytics` skill (spec 07). Additive only; keep it inline, dialect-agnostic,
and stated as a heuristic-plus-why (consistent with spec 07's style).

1. **Generalize the fan-out rule to multi-hop chains.** Make explicit that the
   danger is *cumulative*: any one-to-many hop on the path between the table that
   owns a measure and the aggregate inflates that measure, even when the
   offending join is several hops away from the `SUM`/`COUNT`. The fix is the
   same as the single-hop case — **pre-aggregate the measure to its own grain in
   a CTE, then join the already-aggregated result** — but the agent must apply it
   per measure-owning table along the whole chain, not just at the final join.

2. **Add a verification habit, not just a prohibition.** While composing, the
   agent should confirm a join did not change the grain it intends to aggregate
   at — e.g. check that the row count (or the count of the aggregate's key) is
   unchanged across a join that is supposed to be one-to-one / many-to-one, and
   pre-aggregate the finer table to grain when it is one-to-many. This is the same
   "build incrementally and check each layer" discipline spec 07 already endorses,
   pointed specifically at grain preservation.

   **Pre-aggregate is the general fix; `COUNT(DISTINCT)` is a count-only
   shortcut.** Pre-aggregating the finer table to the measure's grain in a CTE and
   then joining one-to-one is the remedy that works for every aggregate
   (`COUNT`/`SUM`/`AVG`). `COUNT(DISTINCT <key>)` is a valid one-liner *for counts
   only* — it must NOT be generalized to a fanned-out `SUM`/`AVG`, because two
   rows can legitimately hold equal amounts and `DISTINCT` would wrongly collapse
   them. State this trap explicitly; a naïve "just use `COUNT(DISTINCT)`" rule is
   silently wrong for sums.

3. **One concrete, generic multi-hop example.** Include a short worked example
   that shows the inflation and the fix. It must use an **invented, generic
   schema** — **no benchmark table names, no benchmark SQL, and no benchmark
   result values** (see "Leak-safety" below — hard constraint). The example must:
   (a) use a **plain `COUNT`** (not an average) so it isolates the fan-out lesson
   and does not entangle the skill's separate *macro-vs-micro average* rule; and
   (b) use a chain with **unambiguous single-owner attribution** so the only thing
   that can go wrong is row multiplication. The intended example is the chain
   `regions → stores → orders → order_lines` answering *"how many orders per region
   include at least one backordered line"* — each order belongs to exactly one
   store and thus exactly one region, so attribution is clean; the line-level
   filter gives `order_lines` a genuine reason to be joined (so the fix is the
   pre-aggregate remedy, not "drop the join"), and that join sits **several hops
   below** the region-level COUNT (the multi-hop point):

   ```sql
   -- "How many orders per region include at least one backordered line?"
   -- (order_lines is genuinely needed here — for the backordered filter — so the
   --  fix is NOT "just drop the join".)
   -- WRONG: the order_lines join is one row per matching line, joined several hops
   -- BELOW the COUNT. An order with 3 backordered lines is counted 3 times, so the
   -- per-region total is inflated by backordered-lines-per-order — silently wrong.
   SELECT r.region_id, COUNT(*) AS n_orders
   FROM regions r
   JOIN stores s      ON s.region_id = r.region_id
   JOIN orders o      ON o.store_id  = s.store_id
   JOIN order_lines l ON l.order_id  = o.order_id AND l.is_backordered  -- one-to-many: fan-out
   GROUP BY r.region_id;

   -- RIGHT (general remedy): collapse the finer table to the measure's grain in a
   -- CTE FIRST, then join one-to-one so nothing multiplies. This same shape works
   -- for SUM/AVG, not just COUNT.
   WITH qualifying_orders AS (                 -- back to ONE row per order
     SELECT DISTINCT order_id FROM order_lines WHERE is_backordered
   )
   SELECT r.region_id, COUNT(*) AS n_orders
   FROM regions r
   JOIN stores s            ON s.region_id = r.region_id
   JOIN orders o            ON o.store_id  = s.store_id
   JOIN qualifying_orders q ON q.order_id  = o.order_id
   GROUP BY r.region_id;

   -- Count-only shortcut: COUNT(DISTINCT o.order_id) over the WRONG query also works
   -- HERE. But it is counts-only — a fanned-out SUM/AVG of a per-order measure (e.g.
   -- summing each order's shipping_fee after joining lines) must pre-aggregate;
   -- DISTINCT would wrongly merge two orders that happen to share the same fee.
   ```

## Leak-safety (hard constraint on this spec and its example)

The benchmark's gold answers must never appear in ktx. The worked example must
be a **synthetic, generic schema invented for teaching** — not the tables,
column names, query, or numeric results of any Spider 2.0-Lite question. The
example demonstrates the *pattern* (coarse-grain measure counted after a
one-to-many join), which is universal; it must be reconstructable from first
principles by anyone, with zero reference to benchmark data. A reviewer should
be able to read the example and find nothing that ties it to a specific
benchmark instance.

## Acceptance criteria

- The skill's `<sql_craft>` Composition section states the multi-hop
  generalization of the fan-out rule and a grain-verification habit, inline and
  dialect-agnostic.
- It includes exactly one short, **generic** worked example (wrong vs.
  pre-aggregated-right) using an invented schema, with no benchmark-derived
  identifiers or values.
- No new tool, flag, or config; this is skill-content only (additive to spec 07).
- Existing analytics-skill content tests are updated to cover the added rule's
  presence (mirroring spec 07's `analytics-skill-content.test.ts`).

## Benchmark context (motivation only)

Multi-hop aggregation questions (counting/averaging a coarse-grained measure
reached through several one-to-many joins) are a recurring source of
result-mismatch failures in the SQLite subset: the agent produces runnable SQL
with the right tables but a fan-out-inflated number. These are correctness
failures, not knowledge or schema-discovery failures (zero execution errors in
the latest run), so the fix belongs in the product's authoring craft — where it
also helps any real analyst — not in a benchmark-specific prompt.
```
