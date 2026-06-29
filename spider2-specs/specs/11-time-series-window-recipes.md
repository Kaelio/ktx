# Time-series window craft — running totals, rolling-over-time (min-periods), period-over-period

> Refined spec. Intake draft: `todo/11-time-series-window-recipes.md`.

## Problem

A large share of analytics questions are time-series shaped: a **running /
cumulative balance**, a **rolling N-day average**, or **period-over-period
growth**. The agent already knows window functions exist — spec 07 gave the
`<sql_craft>` "Window functions" group its determinism and window-then-filter
rules, and spec 10 added panel/period completeness — but it still gets the
*time-series specifics* wrong:

- a cumulative balance computed **without an explicit unbounded-preceding
  frame**, or with the implicit frame misbehaving when there are **ties on the
  order key**;
- "rolling 30 days" implemented as `ROWS BETWEEN 29 PRECEDING` over **gappy**
  daily data, so the window spans the wrong calendar span when days are missing;
- no **minimum-periods** handling — a rolling average reported before the window
  is actually full;
- "growth vs the previous period" written **without `LAG`** (or against the wrong
  neighbor), with an **unguarded** `(cur - prev) / prev` that breaks on a zero or
  absent prior.

These are runnable-but-wrong: the structure is close, the edge case diverges.
It is the same failure shape spec 07 addressed at the general level; this spec
adds the time-series specifics to the **same Window-functions group**, building
on the rules already there rather than restating them.

## Generic use case (independent of any benchmark)

- "Each account's month-end running balance over 2023" — a cumulative sum of
  monthly net over an ordered window.
- "30-day rolling average of daily revenue, only once 30 days of history exist."
- "Month-over-month revenue growth rate."

All three are bread-and-butter for any analyst on any time-series table, with no
benchmark in sight. The methodology is universal analyst craft, so it belongs in
the shipped skill — it transfers to every ktx user querying a live database.

## Model

The change is **additive content across two surfaces** — the same split spec 10
made, and for the same reason. The split is the central design decision; it
satisfies spec 07's hard dialect-agnostic invariant for `<sql_craft>` without
weakening it.

### Why two surfaces (the dialect-agnostic reconciliation)

Two of the three recipes are **pure standard SQL** and stay entirely in the
dialect-agnostic skill:

- **Cumulative / running total** — `SUM(x) OVER (... ROWS BETWEEN UNBOUNDED
  PRECEDING AND CURRENT ROW)` is standard on every engine.
- **Period-over-period** — `LAG(metric) OVER (...)`, the growth ratio, and a
  `NULLIF`-style divide-by-zero guard are standard on every engine.

The third recipe — a **rolling window over calendar time** — has one piece that
is genuinely dialect-divergent: the **calendar-range window frame**. A native
range frame such as `RANGE BETWEEN INTERVAL '29 days' PRECEDING AND CURRENT ROW`
exists on some engines (e.g. postgres, mysql 8) but **not others** — sqlite has
no date-interval range frame, and SQL Server has **no offset `RANGE` frames at
all**; bigquery's `RANGE` frames are numeric-only. So a portable skill cannot
inline a range frame any more than it could inline a date-series generator.

ktx already routes that kind of engine-specific syntax through the per-dialect
notes in `packages/cli/src/context/sql-analysis/dialects/<dialect>.md`, served by
the `sql_dialect_notes` MCP tool (spec 08). Spec 10 established the precedent
exactly: series/spine generation was not in the dialect rubric, so it was added
there (the **Series** line) and the dialect-agnostic skill points to it.
Rolling-window framing is the next construct in that same position — not in the
rubric yet, dialect-specific — so the **rolling-window idiom belongs in the
dialect notes**, and the skill points to it.

Surface 1 (skill) carries the **pattern** (calendar range, not a row count; the
min-periods guard; the spine-or-range choice). Surface 2 (dialect notes) carries
the **concrete rolling-window frame syntax** per engine.

### Additive, inline, heuristic-with-a-why

Consistent with specs 07 and 10: the skill change is **additive content in one
Markdown file** (`skills/analytics/SKILL.md`), inline (no bundled `reference/`
file — `setup-agents.ts` ships only `SKILL.md`), dialect-agnostic, and phrased as
**heuristics with a one-line generic rationale**, not a wall of MUSTs. The
dialect-notes change is additive content in the seven existing `dialects/*.md`
files. No new tool, flag, or config on either surface.

### Build on the rules already present; do not restate them

The Window-functions group already carries **"Make the ordering deterministic"**
(complete tie-breaker) from spec 07, and the Numeric-precision group carries
**"Round only at the end."** The cumulative and period-over-period recipes
**reference** these rather than repeat them (state each rule once — Anthropic's
"consistent terminology / don't repeat" guidance, already followed in spec 07).
Spec 10's **Series** dialect line is likewise **referenced** by the rolling
recipe's spine fallback, not duplicated.

## Requirements

### 1. Skill surface — `<sql_craft>` "Window functions" group (three recipes)

Add three recipes to the **existing** "Window functions" group, after its two
current bullets (deterministic ordering; filter-after-the-window). Each is a
heuristic with a generic *why*, dialect-agnostic.

1. **Cumulative / running total.** Use an **explicit frame** — `SUM(x) OVER
   (PARTITION BY k ORDER BY t ROWS BETWEEN UNBOUNDED PRECEDING AND CURRENT ROW)` —
   with a **complete tie-breaker** on the `ORDER BY` (per the group's existing
   deterministic-ordering rule; reference it, do not restate). *Why:* a bare
   `ORDER BY` defaults to a `RANGE … CURRENT ROW` frame, which on **ties in the
   order key** folds every tied peer into the same cumulative value — it runs and
   looks plausible, but the running total jumps at each tie boundary.

2. **Rolling window over calendar time, plus minimum periods.** "Rolling N
   days/months" must span a **calendar range**, not a fixed row count: a `ROWS
   BETWEEN n-1 PRECEDING` frame silently measures the wrong span when days are
   missing. Two sanctioned techniques:
   - **Spine + `ROWS` (portable).** Build a gap-free date spine first (spec 10's
     **Series**, via `sql_dialect_notes`) so the data has one row per calendar
     unit; then a `ROWS BETWEEN n-1 PRECEDING AND CURRENT ROW` frame equals the
     intended calendar span. This path is fully dialect-agnostic.
   - **Native range frame or date-keyed self-join (engine-specific).** Where the
     engine supports it, a calendar **range frame** expresses the window directly;
     otherwise a self-join keyed on the date does. Both use engine-specific
     syntax — get the **rolling-window** idiom from `sql_dialect_notes` (see
     requirement 3); show no inline range frame in the skill.

   **Minimum periods.** When the question says "only after N periods of data" (or
   a rolling metric implies it), emit `NULL` / skip until the window is actually
   full — guard on a window count, e.g. `COUNT(*) OVER (<same frame>) = N`. On a
   gap-free spine, `COUNT(*)` counts calendar slots; count the **non-null
   observations** instead when "N periods" means N data points rather than N
   calendar units. *Why:* a row-count frame over missing dates measures the wrong
   span, and a partial early window is not the requested metric.

3. **Period-over-period.** Use `LAG(metric) OVER (PARTITION BY k ORDER BY period)`
   for the prior-period comparison; compute growth as `(cur - prev) / prev` at
   **full precision**, rounding only in the final projection (per the existing
   "Round only at the end" rule), and **guard divide-by-zero / NULL prev**
   (e.g. divide by `NULLIF(prev, 0)`). *Why:* without `LAG` — or ordered against
   the wrong neighbor — the comparison lands on the wrong period, and an unguarded
   ratio errors or returns garbage when the prior period is zero or absent.

**Step pointer (no duplication).** The step-5 `sql_dialect_notes` provision list
(currently "FQTN, identifier-quoting, date, top-N, series/calendar, and JSON
conventions") should also name the **rolling-window** convention now that it
exists. State each rule once inside `<sql_craft>`; the workflow steps only point
to it.

### 2. One worked example — cumulative running total (dialect-agnostic)

Add **exactly one** new compact before/after `sql` example, demonstrating the
**cumulative running total** — the subtlest of the three (the implicit-frame trap
runs fine and is wrong only at tie boundaries) and the highest-value to show.
Use a synthetic generic schema (e.g. `account_txns(account_id, txn_date, net)`):

- **Wrong:** `SUM(net) OVER (PARTITION BY account_id ORDER BY txn_date)` — the
  implicit `RANGE` frame makes two txns on the same date share one inflated
  running balance.
- **Right:** the same with an explicit `ROWS BETWEEN UNBOUNDED PRECEDING AND
  CURRENT ROW` frame and a complete tie-breaker (`ORDER BY txn_date, txn_id`).

Standard SQL only — no `QUALIFY`, no dialect functions, no series generation, no
`RANGE … INTERVAL`. Keep it ~10–14 lines. The **rolling-over-time** recipe gets
**no** inline example (its correct form needs the engine-specific frame/spine,
delegated to `sql_dialect_notes`, exactly as spec 10's period-spine variant was
prose-only); the **period-over-period** recipe is self-evident from its bullet
and also gets no example. This is the **fourth** worked `sql` example in the
skill, after spec 07 (window-then-filter), spec 09 (multi-hop fan-out), and
spec 10 (panel-completeness spine).

### 3. Dialect-notes surface — `dialects/*.md` (rolling window)

Add a **rolling-window-over-time** idiom line to **each** of the seven authored
dialect files, parallel to spec 10's **Series** line. Each note is
engine-exclusive — a SQLite analyst gets the SQLite idiom and never another
engine's construct, per the existing dialect-notes leak guards. Each note either
gives the engine's native calendar-range frame **or** references its own
**Series** line for the spine + `ROWS` fallback (a cross-reference within the
file, not a duplicate of the Series line).

Orientation only — **`RANGE`-frame support genuinely varies by engine and
version, so the implementer must verify each engine's current support against
authoritative docs (context7 / the engine's manual) rather than assert it from
memory.** Starting points:

- **postgres:** native — `... OVER (ORDER BY day RANGE BETWEEN INTERVAL '29 days'
  PRECEDING AND CURRENT ROW)`.
- **mysql (8.0+):** native — `RANGE BETWEEN INTERVAL 29 DAY PRECEDING AND CURRENT
  ROW` over a temporal order key.
- **bigquery:** `RANGE` frames are **numeric** — range over an integer day key
  (e.g. `UNIX_DATE(day)`) with `RANGE BETWEEN 29 PRECEDING AND CURRENT ROW`, or
  build a spine (see **Series**) and use a `ROWS` frame.
- **sqlite:** **no** date-interval range frame — build a date spine (see
  **Series**) and use a `ROWS` frame.
- **tsql (SQL Server):** **no** offset `RANGE` frames at all — build a spine (see
  **Series**) and use a `ROWS` frame, or a date-keyed self-join.
- **snowflake / clickhouse:** range-frame support over dates is limited — verify;
  default to a spine (see **Series**) + `ROWS` frame where a native calendar range
  frame is unavailable.

This line is what makes the rolling-over-time recipe executable from the
dialect-agnostic skill. It is **distinct** from spec 10's Series line (Series =
how to *generate* a spine; Rolling window = how to compute a *moving
calendar-range aggregate*, natively or via that spine), and it cross-references
the Series line rather than overlapping it.

### 4. Explicit constraints / exclusions

None of the following may appear (consistent with specs 07 and 10):

- **No inline dialect-specific range-frame syntax in the skill** — no
  `RANGE … INTERVAL` frame, no series generator, no dialect function. The skill
  stays dialect-clean; the range frame lives only in the dialect notes.
- **No anchoring of relative time to `MAX(date)`.** "Recent" / "past N months"
  means relative to *now* on a live database. A range *bound* may be derived from
  the question's explicit range or, for "all periods present," from `MIN`/`MAX`
  over the **unfiltered** facts (range derivation, per spec 10) — but the metric
  must never silently redefine "recent" as the data's maximum date.
- **No grader / gold-answer / benchmark reference**, and no output-shape contract
  (the skill is for interactive analysis).

### 5. Coordination with specs 07 and 10

All three recipes live in the **existing** `<sql_craft>` "Window functions"
group; the two current bullets and the spec-07 window-then-filter example must
stay intact and uncontradicted.

- **Spec 07** owns the deterministic-ordering rule (Window functions) and the
  round-at-the-end rule (Numeric precision). Spec 11 **builds on** both —
  references them, never restates them.
- **Spec 10** owns the spine concept and the dialect **Series** line. Spec 11
  **references** the spine for the gappy-rolling fallback and adds the **distinct**
  rolling-window dialect line. Keep them non-overlapping: spec 10 = how to make a
  spine; spec 11 = how to compute a moving calendar-range aggregate (native frame
  or spine + `ROWS`).

## Leak-safety (hard constraint)

Every worked example or note uses a **synthetic generic schema** (e.g.
`daily_revenue(day, amount)` or `account_txns(account_id, txn_date, net)`) and
shows only the *pattern*. **No** benchmark table names, SQL, or result values on
either surface. The dialect-notes additions, like the existing notes, carry no
benchmark / grader / version-dated content. The behavior is reconstructable from
first principles and tied to no specific instance.

## Acceptance criteria

- The `<sql_craft>` "Window functions" group states the three recipes — inline,
  dialect-agnostic, each with a generic *why*, and each **building on** (not
  restating) the deterministic-ordering and round-at-the-end rules:
  - **cumulative / running total** with an explicit `ROWS BETWEEN UNBOUNDED
    PRECEDING AND CURRENT ROW` frame and a complete tie-breaker;
  - **rolling window over calendar time + minimum periods** — calendar range not
    row count, the spine-or-range choice, the min-periods `COUNT(*) OVER (...)`
    guard — delegating the engine's range-frame syntax to `sql_dialect_notes`;
  - **period-over-period** via `LAG`, with full-precision growth and a
    divide-by-zero / NULL-prev guard.
- Exactly **one** new worked `sql` example: the cumulative running total,
  wrong-vs-right, with the explicit `ROWS BETWEEN UNBOUNDED PRECEDING AND CURRENT
  ROW` frame and a complete tie-breaker, in standard dialect-agnostic SQL. The
  skill then carries **four** `sql` worked examples total.
- Each of the seven `dialects/*.md` files gains a **rolling-window-over-time**
  idiom line in its engine's own idiom (native calendar-range frame where
  supported, otherwise a spine + `ROWS` fallback that references its **Series**
  line); no engine leaks another engine's construct, and the additions contain no
  benchmark / grader / version-dated content.
- The skill remains **dialect-clean:** no `QUALIFY`, `strftime`, `julianday`,
  `generate_series`, `GENERATE_DATE_ARRAY`, backtick three-part FQTN, **and no
  inline `RANGE … INTERVAL` frame**, anywhere in `SKILL.md` including the new
  example.
- The step-5 `sql_dialect_notes` provision list names the **rolling-window**
  convention alongside FQTN / identifier-quoting / date / top-N / series/calendar /
  JSON.
- The existing interactive guidance (`<workflow>`, `<rules>`, the other
  examples), the two existing Window-functions bullets, the window-then-filter
  example, and the existing dialect-note rubric lines (including **Series**) are
  intact and uncontradicted.
- No grader / benchmark reference, no output-shape contract, and no anchoring of
  *relative* time ("recent" / "past N months") to a `MAX(date)` over the data.
- The skill stays scannable and comfortably under the 500-line budget; frontmatter
  still parses as `ktx-analytics`.

## Implementation orientation

Line numbers drift; treat these as anchors, not addresses. The implementer owns
the prose.

- **Skill:** `packages/cli/src/skills/analytics/SKILL.md` — add the three recipes
  to the "Window functions" group (after its two existing bullets), the single
  cumulative worked example, and extend the step-5 dialect-notes provision list to
  name the rolling-window convention. Leave `<workflow>` / `<rules>` / the other
  examples and the two existing window bullets intact. Delivery is unchanged
  (single `SKILL.md` per target via `readAnalyticsSkillContent` in
  `setup-agents.ts`) — confirm, no change required.
- **Dialect notes:** the seven files under
  `packages/cli/src/context/sql-analysis/dialects/`. The list is kept in sync with
  `DIALECTS_WITH_NOTES` (`dialect-notes.ts`) and shipped to `dist` by
  `copy-runtime-assets.mjs` — no plumbing change, content only. **Verify each
  engine's actual `RANGE`-frame support against authoritative docs before writing
  the idiom; do not assert from memory.**
- **Tests:**
  - `packages/cli/test/skills/analytics-skill-content.test.ts` — add a
    representative phrase for each of the three recipes; bump the `sql`-fence count
    assertion **3 → 4**; assert the cumulative example shape (e.g. `ROWS BETWEEN
    UNBOUNDED PRECEDING AND CURRENT ROW`); and **strengthen** the dialect-clean
    guard with a no-inline-`RANGE … INTERVAL` assertion (mirroring spec 10 adding
    `generate_series` / `GENERATE_DATE_ARRAY` to the banned list, so the
    "range frame lives only in the dialect notes" criterion is *enforced*, not
    incidentally true).
  - `packages/cli/test/context/mcp/dialect-notes.test.ts` — extend the "answers the
    full rubric for every dialect" loop with the rolling-window assertion, e.g.
    `expect(notes).toMatch(/\*\*Rolling/)`, so every dialect must answer it.
    Coverage is derived from `DIALECTS_WITH_NOTES`, so the new assertion enforces
    all seven without a hand-maintained list.
- Rebuild and re-link the dev binary so the playground picks up both surfaces:
  `pnpm run build && pnpm run link:dev`.

## Benchmark context (motivation only)

Running-balance / rolling / period-over-period questions are the single largest
result-mismatch cluster in the SQLite subset (financial-transactions-style DBs):
cumulative balances with the wrong frame on ties, rolling windows that mis-span
gappy dates, partial early windows, and unguarded period-over-period ratios. The
methodology is universal analyst craft, so it belongs in the product's skill
(where it helps every real user) plus the per-dialect rolling-window syntax that
makes it executable — not in a benchmark-specific prompt. Depends on spec 10 (the
date spine) for the gappy-rolling fallback. Improving the benchmark score is a
side effect; the skill and the dialect notes contain no trace of the benchmark.

## Implementation notes

Shipped as additive content across the two surfaces the spec specified — no new
tool, flag, or config.

**Skill (`packages/cli/src/skills/analytics/SKILL.md`).** Added the three recipes
to the existing `<sql_craft>` "Window functions" group, after its two bullets and
the spec-07 window-then-filter example: **Cumulative / running total** (explicit
`ROWS BETWEEN UNBOUNDED PRECEDING AND CURRENT ROW` + a tie-breaker, referencing
the deterministic-ordering rule), **Rolling window over calendar time, plus
minimum periods** (calendar range not row count; spine-or-native-range choice
delegated to `sql_dialect_notes`; the `COUNT(*) OVER (<same frame>) = N`
min-periods guard), and **Period-over-period** (`LAG` + full-precision growth +
`NULLIF` divide guard, referencing the round-at-the-end rule). Added one worked
`sql` example — the cumulative running total, wrong-vs-right, using
`account_txns(account_id, txn_id, txn_date, net)` — bringing the skill to four
worked examples. Extended the step-5 `sql_dialect_notes` provision list to name
the rolling-window convention. No inline `RANGE … INTERVAL` frame anywhere in the
skill; it stays dialect-clean.

**Dialect notes (`packages/cli/src/context/sql-analysis/dialects/*.md`).** Added a
**Rolling window over time** line to all seven files, parallel to the spec-10
**Series** line and cross-referencing it for the spine fallback.

**Deviation — `RANGE`-frame support verified against authoritative docs (the
spec's hard requirement), which corrected two of its starting points:**

- **postgres** — native interval frame: `RANGE BETWEEN INTERVAL '29 days'
  PRECEDING AND CURRENT ROW` (as the spec guessed).
- **mysql** — native interval frame over a temporal key: `RANGE BETWEEN INTERVAL
  29 DAY PRECEDING AND CURRENT ROW` (as guessed).
- **bigquery** — `RANGE` is numeric-only: range over `UNIX_DATE(day)` with
  `RANGE BETWEEN 29 PRECEDING AND CURRENT ROW`, or spine + `ROWS` (as guessed).
- **snowflake** — **corrected:** the spec said "limited; default to a spine," but
  Snowflake *does* support a native interval `RANGE` frame over a date/timestamp
  key and it is gap-tolerant, so the note gives the native frame
  (`RANGE BETWEEN INTERVAL '29 days' PRECEDING AND CURRENT ROW`), no spine needed.
- **clickhouse** — **corrected:** the spec said "limited; default to a spine," but
  ClickHouse supports a numeric `RANGE` offset over a `Date` column (counts in
  days, gap-tolerant); the `INTERVAL` form is unsupported (use seconds for
  `DateTime`). The note gives the numeric `RANGE` frame, with spine + `ROWS` as
  the fallback.
- **sqlite** — no date-interval range frame (no native date type): spine + `ROWS`
  (as guessed).
- **tsql** — `RANGE` supports only `UNBOUNDED`/`CURRENT ROW` (no offset frame):
  spine + `ROWS`, or a date-keyed self-join (as guessed).

**Tests.** `test/skills/analytics-skill-content.test.ts` — added a representative
phrase per recipe (plus `minimum periods`), bumped the `sql`-fence count 3 → 4,
asserted the cumulative example shape (`ROWS BETWEEN UNBOUNDED PRECEDING AND
CURRENT ROW` and the `ORDER BY txn_date, txn_id` tie-breaker), and strengthened
the dialect-clean guard with a no-inline-`RANGE … INTERVAL` regex.
`test/context/mcp/dialect-notes.test.ts` — extended the per-dialect rubric loop
with `expect(notes).toMatch(/\*\*Rolling/)`, so every dialect (derived from
`DIALECTS_WITH_NOTES`) must answer the rolling-window rubric.

**Verification.** Full `@kaelio/ktx` vitest suite green (3001 passed, 1 skipped);
`pnpm run build` mirrors both surfaces into `dist`; `pnpm run link:dev` refreshed
`ktx-dev`. Pre-existing, unrelated note: `tsc -p tsconfig.test.json` reports one
error in `test/mcp-server-factory.test.ts` (a `KtxMcpContextPorts` cast) that is
present in committed branch code and untouched by this work.
