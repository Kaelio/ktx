# Add universal SQL-authoring craft to the ktx-analytics skill

> Priority: HIGH. The `ktx-analytics` skill currently tells the agent *which
> ktx tools to call and in what order*, but gives almost no guidance on
> *writing correct SQL*. In benchmark runs the agent reliably produced
> runnable SQL (0 execution errors) yet failed on correctness — precision,
> determinism, type mismatches, and answer completeness. These are universal
> analytics-engineering truths that every ktx user benefits from, so they
> belong in the shipped skill, not in any caller's prompt.

## Scope guard (read first)

Only **universally-true** SQL/analytics craft goes here — guidance that helps a
real ktx user querying a **live** database. The test for inclusion: *"Would this
advice be correct and useful for an analyst on a current, production database?"*

**Dialect-specific syntax is out of scope here.** The v9 harnesses' only
per-dialect content (Snowflake: `DB.SCHEMA.TABLE` FQTNs, double-quoted
lowercase cols, VARIANT colon-paths; BigQuery: backtick FQTNs, `_TABLE_SUFFIX`
for sharded tables; sqlite: `strftime`/`julianday`) is genuinely useful but
belongs in a **dialect-aware** location (per-driver notes), not this flat
skill. Track separately as a follow-up; the rules below must stay
dialect-agnostic.

Explicitly **do NOT** add (these are application/consumer concerns, not skill
concerns, and some are actively wrong for live data):
- Output-format contracts ("return a bare result set with exactly these
  columns, no prose"). The skill is for interactive analysis and already
  favors readable tables + summaries; a caller that needs a strict result
  shape specifies that itself.
- Anchoring relative time ("recent", "past N months") to `MAX(date)` of the
  data. On a live database "recent" means relative to *now*; this is only true
  for static snapshots and must not be baked into the product.
- Anything justified by a grader/scoring comparator.

## File

`packages/cli/src/skills/analytics/SKILL.md` (the shipped skill;
`setup-agents.ts` installs it into agent environments — the copy under a
project's `.claude/skills/` is regenerated from this source). Extend the
existing `<rules>` block and step 5 ("Query") / step 6 ("Validate and
explain"); keep the existing interactive guidance intact.

## Requirements — add these as general rules (behavior only, no rationale that
references answers/graders)

**Schema discovery before writing SQL**
1. Inspect representative sample rows of each table before composing SQL —
   confirm date/time encoding (e.g. `YYYYMMDD` vs ISO vs epoch), null
   prevalence in join/filter keys, and the actual set of categorical/enum
   values. (`entity_details` + a small `sql_execution` sample.)
2. Cast a column to its real type before comparing it in `WHERE`/`JOIN`. A
   string column compared against a numeric literal (or vice versa) can
   silently match nothing.

**Composition discipline**
3. Build complex queries incrementally — one CTE at a time, verifying each
   layer's output on a small sample before stacking the next.
4. Avoid joins that fan out row counts. Add columns only from tables already
   required by the grain, or pre-aggregate to the target grain before joining.

**Window-function correctness**
5. Give every ranking/ordering window function a complete, deterministic
   tie-breaker (append unique key columns), so `RANK`/`ROW_NUMBER`/`LAG`
   results are stable rather than flickering across runs.
6. Apply row filters **after** window functions for sequence / "first" /
   "most recent" / "since" questions — compute over the full partition, then
   filter.

**Numeric precision**
7. Compute at full precision; round only in the final projection, never inside
   intermediate CTEs.
8. Be explicit about truncation (`CAST AS INT` truncates; use explicit
   rounding when rounding is intended).
9. Distinguish "average of per-group averages" (macro: `AVG(group_metric)`)
   from "overall/weighted average" (micro: `SUM(num)/SUM(den)`) based on the
   question's wording.

**Answer completeness / interpretation**
10. "top / highest / most / lowest" → return only the winning row(s) (e.g.
    `RANK() = 1` / `QUALIFY`), not the full ranked list, unless a list is asked
    for.
11. "for each X / per X / by X" → exactly one row per X; don't collapse to a
    single value unless the question says "overall" or "total across X".
12. When a question asks for inputs and a derived value ("X, Y, and their
    ratio"), include the inputs as columns alongside the derived value.
13. When grouping by a human-readable label (a name), also expose the entity's
    identifier — identity, not just the label, is part of the result.
14. When a result is unexpectedly empty, relax filters one at a time to find
    which predicate removed the rows.

## Acceptance criteria

- The shipped `analytics/SKILL.md` contains the rules above, phrased as general
  truths with **no reference to any benchmark, gold answer, or scoring
  comparator**.
- Existing interactive guidance (compact result tables, summaries,
  clarification prompts, the tool-order workflow) is preserved — the skill must
  still read well for an interactive human-facing analysis session.
- None of the excluded items (output-shape contract, `MAX(date)` anchoring,
  grader-driven advice) appear.
- Skill stays within a reasonable size; group the new rules under clear
  sub-headings so they're scannable.

## Benchmark context (motivation only)

On the Spider 2.0-Lite sqlite subset, the solver produced 0 execution errors
but ~50 result mismatches; a large share traced to exactly these gaps
(premature rounding, string-vs-number compares, non-deterministic window
ordering, returning full lists for "top" questions, dropping inputs to derived
values). These are generic SQL-authoring defects — fixing them in the skill
improves ktx for everyone and, as a side effect, the benchmark.
