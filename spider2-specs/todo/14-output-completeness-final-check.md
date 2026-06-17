# Enforce answer-output completeness with a final pre-emit check in the analytics skill

## Problem

The single largest correctness failure mode is **incomplete output**: the query runs and the
methodology is roughly right, but the result is missing columns the question asked for. Three
recurring sub-patterns:

1. **Multi-part questions answered partially.** A question that asks for several things ("report
   the highest *and* the lowest month, each with its count and average, *and* the difference")
   comes back with only the first part — one column instead of the several requested.
2. **Identity dropped.** Grouping by a human-readable name but not projecting the entity's
   identifier (e.g. a product name without its product id, a customer name without its
   customer id).
3. **Inputs to a derived value dropped.** Returning a ratio / percentage / difference but not
   the underlying counts the question also asked for.

Sub-patterns 2 and 3 are **already covered by `<sql_craft>` rules** in the analytics skill
(spec 07: *"expose identity, not just the label"* and *"keep the inputs to a derived value"*),
yet they are frequently **not applied**. So the gap is not missing knowledge — it is that these
rules are passive heuristics buried in a list, and the agent doesn't reliably check them before
finalizing. The fix is to (a) add the missing multi-part-completeness rule and (b) turn
output-completeness into an **explicit final verification step** the agent performs before
emitting SQL.

This is reinforced by evidence that the failure is **model-independent**: a markedly stronger
model produced the same incomplete-output mistakes on these questions, which means it is a
craft/enforcement gap, not a capability gap.

## Generic use case (independent of any benchmark)

An analyst is asked: *"For each region, report the highest and the lowest monthly order count,
and the difference between them."* A complete, useful answer has a column for the region's id
and name, the highest count, the lowest count, and the difference — five columns. Returning just
the region and a single number answers only part of the request. This is a universal expectation
on any database: answer **every** part of a multi-part request, identify the entities, and show
the inputs behind any derived figure.

## Requirements

Additive to the analytics skill's `<sql_craft>` "Answer completeness / interpretation" group and
its workflow's validate step (inline, dialect-agnostic, heuristic + why, consistent with spec 07).

1. **Multi-part / multi-output completeness (new rule).** When a question requests several
   outputs — a list ("A, B, and C"), paired extremes ("the highest *and* the lowest"), or a
   value plus its components ("X, Y, and their ratio") — the final projection must contain a
   column for **each** requested output. *Why:* answering only the first clause is the most common
   way a runnable query is still wrong; the grain and methodology can be perfect yet the answer
   is short by columns.

2. **Fold the existing identity / inputs rules into the same completeness notion.** The
   already-shipped rules — project the entity **identifier** alongside any human-readable label,
   and **keep the inputs** to any derived value — are part of output completeness; reference them
   from the check below so they are actually applied, not just listed.

3. **Add an explicit final completeness check (the enforcement mechanism).** Before emitting the
   final SQL, the skill should have the agent **re-read the question and confirm the projection
   covers**: every named metric/attribute; the identifier of every grouped/named entity; every
   input to a derived value; all at the grain the question specifies. This is a short, concrete
   checkpoint at the validate step — the point is to convert the passive heuristics into an active
   pre-finalize verification. (Do **not** add unrequested/extra columns to be "safe" — that is
   grader-gaming; the check is about matching the request exactly, not padding it.)

   Generic teaching example (synthetic schema — see Leak-safety):
   ```sql
   -- "For each region, report the highest and lowest monthly order count and their difference."
   -- WRONG: answers only the first clause; no region id, no lowest, no difference.
   SELECT region_name, MAX(monthly_orders) AS highest
   FROM region_monthly GROUP BY region_name;

   -- RIGHT: one column per requested output + the entity's identity, at the region grain.
   SELECT r.region_id, r.region_name,
          MAX(m.monthly_orders) AS highest_monthly_orders,
          MIN(m.monthly_orders) AS lowest_monthly_orders,
          MAX(m.monthly_orders) - MIN(m.monthly_orders) AS difference
   FROM regions r
   JOIN region_monthly m ON m.region_id = r.region_id
   GROUP BY r.region_id, r.region_name;
   ```

## Leak-safety (hard constraint)

The example must use an **invented, generic schema** (`regions`, `region_monthly`) and made-up
columns — **no benchmark table names, SQL, or result values.** It teaches the *pattern* (cover
every requested output + identity + inputs), which is universal and tied to no specific instance.

## Acceptance criteria

- The skill states the multi-part-completeness rule and a concrete **final completeness check**
  (re-read question → verify metrics + identity + inputs + grain), inline and dialect-agnostic,
  cross-referencing the existing identity/inputs rules so they're enforced.
- Includes the over-projection guard (don't pad with extra columns — that's grader-gaming).
- One short generic example (wrong vs complete); no benchmark-derived content.
- Skill-content only; analytics-skill content tests updated to cover the new rule + check.

## Benchmark context (motivation only)

In the latest SQLite-subset run, **incomplete output was the single largest failure bucket
(~13 of 51 voted failures)**: multi-part questions answered partially, and identity / derived-value
inputs dropped — the latter two being spec-07 rules that already exist but weren't applied. A
probe with a much stronger model reproduced the *same* incomplete-output failures, confirming this
is a craft-enforcement gap rather than a model-capability one. The fix — answer every requested
part, identify entities, keep inputs — is universal analyst craft, so it belongs in the product
skill (and transfers to real users), enforced as a final check rather than left as a passive hint.
```
