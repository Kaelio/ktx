# Panel/period completeness — emit the full set of groups, not only the populated ones

> Refined spec. Intake draft: `todo/10-panel-completeness-spine.md`.

## Problem

When a question asks for a result *per period* or *per category* ("orders for
each month of 2023", "revenue by region", "count per status"), a plain `GROUP BY`
only returns groups that actually have rows. Periods or categories with **zero**
activity silently vanish, so a "12 months" answer comes back with 9 rows and the
three that should read `0` are simply absent. The SQL is runnable and the
aggregate is right, but the **panel is incomplete** — and a monthly report with
missing months or a category breakdown missing its empty categories is wrong for
any analyst, on any database.

The existing `<sql_craft>` "Answer completeness / interpretation" group already
carries a *"For each X / per X / by X returns exactly one row per X"* rule, but
that rule only governs **grain** (don't collapse to a single value). It says
nothing about the **domain**: "one row per X" today means one row per *observed*
X, so empty groups still drop. This spec sharpens that rule from grain-only to
grain-and-completeness.

## Generic use case (independent of any benchmark)

"How many orders were placed in each month of 2023?" must return **12 rows** even
if March had no orders (March = 0), not 11. "Sales per region" should include
regions with no sales when the question asks for *each* region. Both are
bread-and-butter reporting for any analyst on any warehouse, with no benchmark in
sight.

## Model

The feature splits across **two surfaces**, each holding the half it is suited
for. This split is the central design decision and exists to satisfy spec 07's
hard dialect-agnostic invariant without weakening it.

### Why two surfaces (the dialect-agnostic reconciliation)

The draft asked for a *"recursive-CTE date spine"* worked example. But a real
date/number series is **inherently dialect-specific** — Postgres `generate_series`,
SQLite recursive `date(d,'+1 month')`, BigQuery `GENERATE_DATE_ARRAY`, Snowflake
`GENERATOR`+`DATEADD` — and spec 07 made `<sql_craft>` strictly dialect-agnostic
(the analytics-skill content test bans single-dialect constructs). Inlining a date
spine would violate that invariant; carving out a test exception would erode it.

ktx already has the canonical home for engine-specific syntax: the per-dialect
notes in `packages/cli/src/context/sql-analysis/dialects/<dialect>.md`, served by
the `sql_dialect_notes` MCP tool (spec 08). Those files answer a fixed rubric
(FQTN / Identifiers / Date-time / Top-N / JSON) — but **series/spine generation is
not in that rubric yet**. So the date-spine syntax belongs *there*, alongside the
other per-dialect idioms, and the dialect-agnostic skill points to it. This
routes the dialect-specific half through the existing channel rather than
standing up a parallel dialect-specific recipe inside the skill.

Surface 1 (skill) carries the **pattern**; surface 2 (dialect notes) carries the
**concrete series syntax**.

### Additive, inline, heuristic-with-a-why

Consistent with spec 07: the skill change is **additive content in one Markdown
file** (`skills/analytics/SKILL.md`), inline (no bundled `reference/` file — the
delivery mechanism in `setup-agents.ts` ships only `SKILL.md`), dialect-agnostic,
and phrased as a **heuristic with a one-line generic rationale**, not a wall of
MUSTs. The dialect-notes change is additive content in the seven existing
`dialects/*.md` files. No new tool, flag, or config on either surface.

## Requirements

### 1. Skill surface — `<sql_craft>` "Answer completeness / interpretation"

Add the panel-completeness rule to the existing group (it extends, and should sit
adjacent to, the *"For each X / per X / by X"* bullet). It must cover:

1. **Recognize the full-panel cue.** *each / every / all / per <period> / for all
   <category> / by month* signals that the answer's row set should be the
   **complete expected domain** of periods or categories in scope, not just those
   present in the filtered fact rows. *Why:* a plain inner `GROUP BY` can only emit
   groups that have at least one fact row.

2. **Spine → LEFT JOIN → COALESCE.** Build the full set of expected groups (the
   **spine**), then LEFT JOIN the aggregated facts onto it:
   - **Category/dimension spine:** the distinct values from the **domain-defining
     dimension/entity table** (e.g. all regions from a `regions` table), *not*
     `SELECT DISTINCT region FROM facts` — the latter yields only categories that
     already occur, so a zero-activity category still drops. When no dimension
     table exists, the distinct values from the **unfiltered** fact table are the
     best available domain (with the residual caveat that a category which never
     occurs at all cannot surface).
   - **Period/number spine:** generate the series for the question's stated range
     (e.g. each month of 2023 → Jan..Dec 2023). The series bounds come from the
     question's explicit range; when the range is "all periods present," derive
     bounds from `MIN`/`MAX` over the **unfiltered** facts. The concrete
     series-generation syntax is per-dialect — the rule points the author to
     `sql_dialect_notes` (see requirement 2) and shows no inline series SQL.

3. **COALESCE by measure additivity.** Default missing measures with
   `COALESCE(metric, 0)` for **additive** measures (a `COUNT` or `SUM` of events
   or amounts — "no activity" genuinely reads as 0). Leave **non-additive**
   measures (`AVG`, a running balance, a price, a rate, a ratio) as **NULL** —
   absence is "no data," and 0 would be a wrong reading. *Why:* 0 is a real value
   only for additive measures.

4. **Don't over-apply (the each-vs-which guard).** When the question asks only
   about groups that exist ("*which* months had orders", "regions that made a
   sale"), the spine is unnecessary and wrong — emit only observed groups. The cue
   is *each / all / every* (complete domain) vs *which / that have* (observed
   subset).

5. **One worked example — the category spine, fully portable.** Add **exactly
   one** compact before/after example demonstrating the pattern with a
   **distinct-dimension spine**: the wrong shape (`GROUP BY` over facts, empty
   groups missing) and the right shape (`SELECT DISTINCT` domain from the
   dimension table → LEFT JOIN aggregated facts → `COALESCE(metric, 0)`). Generic
   table/column names, standard SQL only — no series generation, no dialect
   functions, so the example stays dialect-clean. The period-spine variant is
   described in prose (requirement 2) and delegated to `sql_dialect_notes`; it
   gets **no** inline example. This is the **third** worked `sql` example in the
   skill (after spec 07's window-then-filter and spec 09's multi-hop fan-out).

6. **Step pointer, no duplication.** The validate/explain step (and/or the query
   step) already points into `<sql_craft>` for answer-completeness; extend that
   existing pointer's wording if needed, but state the rule **once** inside
   `<sql_craft>`. The step-5 pointer that lists what `sql_dialect_notes` provides
   ("FQTN, identifier-quoting, date, top-N, and JSON conventions") should also
   name the **series/calendar** convention now that it exists.

### 2. Dialect-notes surface — `dialects/*.md`

Add a **"Series"** (date/number range) line to **each** of the seven authored
dialect files, giving that engine's idiomatic way to generate a contiguous
date or integer series for use as a spine. Each note is engine-exclusive — a
SQLite analyst gets the SQLite idiom and never another engine's construct, per the
existing dialect-notes leak guards. Orientation (exact syntax is the
implementer's):

- **postgres:** `generate_series('2023-01-01'::date, '2023-12-01'::date, interval '1 month')`.
- **sqlite:** recursive CTE — `WITH RECURSIVE m(d) AS (SELECT '2023-01-01' UNION ALL SELECT date(d,'+1 month') FROM m WHERE d < '2023-12-01')`.
- **bigquery:** `UNNEST(GENERATE_DATE_ARRAY('2023-01-01','2023-12-01', INTERVAL 1 MONTH))` (and `GENERATE_ARRAY` for integers).
- **snowflake:** `TABLE(GENERATOR(ROWCOUNT => n))` with `DATEADD('month', SEQ4(), start)`, or a recursive CTE.
- **mysql:** recursive CTE (8.0+) with `DATE_ADD(d, INTERVAL 1 MONTH)`.
- **clickhouse:** `numbers(n)` / `range(n)` with `addMonths(start, number)` (or `arrayJoin`).
- **tsql:** recursive CTE with `DATEADD(month, …)`, or a numbers/tally table.

This line is what makes the period spine usable from the dialect-agnostic skill,
and it is also consumed by **spec 11** (rolling-window-over-gappy-dates needs the
same date spine) — so it is foundational, not scope creep.

### 3. Coordination with spec 11

Spec 11 (time-series window recipes) explicitly depends on this date spine for the
gappy-rolling case ("build a complete date spine first (see spec 10)"). Spec 10
establishes the spine concept in the Answer-completeness group and the
series syntax in the dialect notes; spec 11 reuses both from the Window-functions
group. Keep the two non-overlapping: spec 10 owns the spine; spec 11 references it.

## Leak-safety (hard constraint)

Any worked example or note must use a **synthetic generic schema** (e.g. an
`orders` table with an `order_date`, a `regions` dimension) and demonstrate only
the *pattern* (spine + LEFT JOIN + COALESCE). **No** benchmark table names, SQL,
or result values on either surface. The dialect-notes additions, like the existing
notes, carry no benchmark/grader/version-dated content. The behavior is
reconstructable from first principles and tied to no specific instance.

## Acceptance criteria

- `<sql_craft>` "Answer completeness / interpretation" states: the full-panel cue,
  the spine → LEFT JOIN → COALESCE recipe, the additive-vs-non-additive COALESCE
  discriminator (0 vs NULL), and the each-vs-which over-application guard —
  inline, dialect-agnostic, each with a generic *why*.
- Exactly **one** new worked `sql` example is present, a portable
  distinct-dimension spine (`SELECT DISTINCT` domain → LEFT JOIN → `COALESCE`),
  with no series generation and no dialect-specific syntax. The skill then carries
  **three** `sql` worked examples total.
- Each of the seven `dialects/*.md` files gains a **Series** (date/number range)
  line in its engine's own idiom; no engine leaks another engine's construct, and
  the additions contain no benchmark/grader/version-dated content.
- The skill remains dialect-clean: no `QUALIFY`, `strftime`, `julianday`,
  `generate_series`, `GENERATE_DATE_ARRAY`, backtick three-part FQTN, or other
  single-dialect construct anywhere in `SKILL.md`, including the new example.
- The existing interactive guidance (`<workflow>`, `<rules>`, the other examples)
  and the existing dialect-note rubric lines are intact and uncontradicted.
- No grader/benchmark reference, no output-shape contract, and no anchoring of
  *relative* time ("recent" / "past N months") to a `MAX(date)` over the data
  appears (period-spine bounds derive from the question's explicit range or, for
  "all periods present," from `MIN`/`MAX` over the facts — which is range
  derivation, not relative-time anchoring).
- The skill stays scannable and comfortably under the 500-line budget; frontmatter
  still parses as `ktx-analytics`.

## Implementation orientation

Line numbers drift; treat these as anchors, not addresses. The implementer owns
the prose.

- **Skill:** `packages/cli/src/skills/analytics/SKILL.md` — add the
  panel-completeness bullets to the Answer-completeness group, the single category
  spine example, and extend the existing step pointer / dialect-notes provision
  list to name the series convention. Leave `<workflow>`/`<rules>`/other examples
  intact. Delivery is unchanged (single `SKILL.md` per target via
  `readAnalyticsSkillContent` in `setup-agents.ts`) — confirm, no change required.
- **Dialect notes:** the seven files under
  `packages/cli/src/context/sql-analysis/dialects/`. The list is kept in sync with
  `DIALECTS_WITH_NOTES` (`dialect-notes.ts`) and shipped to `dist` by
  `copy-runtime-assets.mjs` — no plumbing change, content only.
- **Tests:**
  - `packages/cli/test/skills/analytics-skill-content.test.ts` — add a
    representative phrase for the completeness rule; bump the `sql`-fence count
    assertion **2 → 3**; assert the spine + LEFT JOIN + `COALESCE` shape; the
    existing dialect-clean guards already cover the no-inline-series requirement
    (the example is `SELECT DISTINCT`, so they pass unchanged).
  - `packages/cli/test/context/mcp/dialect-notes.test.ts` — extend the rubric loop
    (the "answers the full rubric for every dialect" test) so every dialect must
    also answer a **Series** line, e.g. `expect(notes).toMatch(/\*\*Series/)`.
    Coverage is derived from `DIALECTS_WITH_NOTES`, so the new assertion enforces
    all seven without a hand-maintained list.
- Rebuild and re-link the dev binary so the playground picks up both surfaces:
  `pnpm run build && pnpm run link:dev`.

## Benchmark context (motivation only)

Per-period / per-category questions where some periods are empty produce
short-row result mismatches in the SQLite subset, and the related rolling/cumulative
cluster (spec 11) needs a complete date spine to be correct at all. The fix is a
universal reporting habit (complete panels) plus the per-dialect series syntax
that makes it executable — both belong in the product, where they help real
analysts. Improving the benchmark score is a side effect; the skill and the
dialect notes contain no trace of the benchmark.

## Implementation notes

Shipped on branch `write-feature-spec-wiki`. Content-only across two surfaces, no
new tool/flag/config, no plumbing change.

**Surface 1 — skill (`packages/cli/src/skills/analytics/SKILL.md`):**
- Added a **"Complete the panel for 'each / every / all / per <period or
  category>'"** bullet to the `<sql_craft>` "Answer completeness / interpretation"
  group, directly after the *"For each X / per X / by X"* bullet, with three
  sub-bullets carrying the rest of the rule each with its generic *why*: **Spine
  source** (distinct domain from the dimension/entity table — not `SELECT DISTINCT`
  over the facts; period/number series across the question's stated range, bounds
  from `MIN`/`MAX` over the *unfiltered* facts for "all periods present"; series
  syntax delegated to `sql_dialect_notes`), **Default by additivity**
  (`COALESCE(metric, 0)` for additive measures, `NULL` for non-additive), and
  **Don't over-apply** (the each-vs-which guard).
- Added **one** worked `sql` example at the end of the Answer-completeness group: a
  portable distinct-dimension spine (`SELECT DISTINCT region_id FROM regions` →
  `LEFT JOIN` aggregated facts → `COALESCE(ro.n_orders, 0)`), wrong-vs-right,
  standard SQL only, no series generation, no dialect functions. The skill now
  carries **three** `sql` worked examples.
- Extended the step-5 dialect-notes pointer to name the **series/calendar**
  convention alongside FQTN / identifier-quoting / date / top-N / JSON.
- Delivery unchanged: `readAnalyticsSkillContent` in `setup-agents.ts` ships the
  single `SKILL.md` per target — confirmed, no change.

**Surface 2 — dialect notes (`packages/cli/src/context/sql-analysis/dialects/*.md`):**
- Added a `- **Series:**` line to all seven authored files (postgres, sqlite,
  bigquery, snowflake, mysql, clickhouse, tsql), each in that engine's own idiom
  (`generate_series`; recursive CTE with `date(d,'+1 month')`;
  `UNNEST(GENERATE_DATE_ARRAY(...))`; `GENERATOR`/`SEQ4`/`DATEADD`; recursive CTE
  with `DATE_ADD`; `numbers(n)`/`addMonths`; recursive CTE with `DATEADD` +
  `MAXRECURSION`), placed right after each file's Date/time line. No cross-engine
  leak, no version-dated/benchmark content. Shipped to `dist` unchanged by
  `copy-runtime-assets.mjs`; coverage stays derived from `DIALECTS_WITH_NOTES`.

**Tests:**
- `test/skills/analytics-skill-content.test.ts`: added the `Complete the panel`
  and `Default by additivity` phrases; renamed the worked-examples test and bumped
  the `sql`-fence count **2 → 3**; asserted the spine + `LEFT JOIN` + `COALESCE`
  shape. Also added `generate_series` and `GENERATE_DATE_ARRAY` to the
  dialect-clean banned list — a deliberate **strengthening** beyond the spec's
  test orientation so the "no inline series" acceptance criterion is *enforced*,
  not merely incidentally true of a `SELECT DISTINCT` example.
- `test/context/mcp/dialect-notes.test.ts`: extended the "answers the full rubric
  for every dialect" loop with `expect(notes).toMatch(/\*\*Series/)`, so all seven
  dialects are required to answer a Series line (coverage derived from
  `DIALECTS_WITH_NOTES`, no hand-maintained list).

**Verification:** both affected test files pass (19 tests). `src` type-check and
`pnpm run build` are clean, and `copy-runtime-assets.mjs` placed the Series line in
all seven `dist` dialect files; `pnpm run link:dev` re-linked `ktx-dev`. Note: an
unrelated, pre-existing `tsconfig.test.json` type error in
`test/mcp-server-factory.test.ts` exists on this branch — untouched by this work
and outside its scope.

**Coordination with spec 11:** the per-dialect Series line is the foundational
date spine that spec 11 (rolling/cumulative windows over gappy dates) references.
Spec 10 owns the spine (Answer-completeness group + dialect Series notes); spec 11
will reference it from the Window-functions group. No overlap introduced.
