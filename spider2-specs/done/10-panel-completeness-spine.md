# Panel/period completeness — emit the full set of groups, not only the populated ones

## Problem

When a question asks for a result *per period* or *per category* ("orders for each
month of 2023", "revenue by region", "count per status"), the natural `GROUP BY`
only returns groups that actually have rows. Periods/categories with **zero**
activity silently vanish, so a "12 months" answer comes back with 9 rows and the
ones that should read `0` are simply absent. The agent writes runnable SQL with
the right aggregate but an **incomplete panel**.

This is a universal reporting correctness issue: a monthly report with missing
months, or a category breakdown missing the empty categories, is wrong for any
analyst — and it is also a frequent result-mismatch shape on the benchmark.

## Generic use case (independent of any benchmark)

"How many orders were placed in each month of 2023?" must return **12 rows** even
if March had no orders (March = 0), not 11 rows. "Sales per region" should include
regions with no sales (as 0/NULL) when the question asks for *each* region.

## Requirements

Additive to the `ktx-analytics` skill's `<sql_craft>` "Answer completeness /
interpretation" group (consistent with spec 07's inline, dialect-agnostic, heuristic
+ why style).

1. **Recognize "full-panel" phrasing.** Cues like *each / every / per <period> /
   for all <category> / by month* signal that the answer's row set should be the
   **complete** set of periods or categories in scope, not just those present in
   the filtered fact rows.

2. **Build a spine, then LEFT JOIN.** Generate the full set of expected
   groups — a date/number series via a recursive CTE for periods, or the distinct
   dimension values from the authoritative dimension table for categories — and
   LEFT JOIN the aggregated facts onto it, defaulting missing measures with
   `COALESCE(metric, 0)` (or NULL when 0 would be wrong). *Why:* a plain inner
   `GROUP BY` can only emit groups that have at least one fact row.

3. **Don't over-apply.** When the question asks only about groups that exist
   ("which months had orders"), the spine is unnecessary; the cue is *each/all*
   vs *which*.

## Leak-safety (hard constraint)

Any worked example must use a **synthetic generic schema** (e.g. an `orders`
table with an `order_date`) and demonstrate only the *pattern* (spine + LEFT JOIN
+ COALESCE). No benchmark table names, SQL, or result values. The behavior is
reconstructable from first principles and tied to no specific instance.

## Acceptance criteria

- `<sql_craft>` states the full-panel cue, the spine + LEFT JOIN + COALESCE recipe,
  and the over-application guard — inline and dialect-agnostic.
- At most one short generic example (recursive-CTE date spine or distinct-dimension
  spine), no benchmark-derived content.
- Skill-content only; analytics-skill content tests updated to cover the rule.

## Benchmark context (motivation only)

Per-period / per-category questions where some periods are empty produce
short-row result mismatches in the SQLite subset. The fix is a universal
reporting habit (complete panels), so it belongs in the product's craft, where it
also helps real analysts — not in a benchmark-specific prompt. Related to spec 11
(rolling/cumulative windows need a complete date spine to be correct).
