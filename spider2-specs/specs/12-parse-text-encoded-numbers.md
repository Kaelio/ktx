# Parse text-encoded numeric columns before doing math on them

> Refined spec. Intake draft: `todo/12-parse-text-encoded-numbers.md`.

## Problem

Numeric measures are often stored as **text** with human formatting: unit
suffixes (`"1.2K"`, `"3M"`, `"4B"`), currency symbols and thousands separators
(`"$1,200"`), percent signs (`"12%"`), or non-numeric sentinels for missing/zero
(`"-"`, `"N/A"`, `""`). Aggregating or comparing such a column directly is
**silently wrong**: a string comparison orders `"100" < "9"`, and a naive
`CAST(x AS REAL)` yields `0`/NULL/partial on the formatted values rather than the
intended number. The query runs, the shape looks right, the number is garbage.

The agent already samples schemas before composing — spec 07 gave the
`<sql_craft>` "Schema discovery before writing SQL" group its *"Sample before you
compose"* and *"Cast to the real type before comparing"* rules. But those rules
guard **encoding** (date format, nullability) and **type-mismatch in `WHERE`**;
they say nothing about a column whose declared/affinity type is text yet whose
*meaning* is numeric. When the agent sees a "numeric-looking" column it tends to
assume a real number type and skips the parse, so the arithmetic runs on the raw
strings. This spec adds the detect → parse/scale → verify habit to that same
group, building on the two rules already there rather than restating them.

## Generic use case (independent of any benchmark)

- A `trade_volume` column stored as `"1.2K" / "3M" / "-"` must become
  `1200 / 3000000 / 0` before you can sum it or compute a daily change.
- A `price` stored as `"$1,299.00"` must become `1299.00` before averaging.
- A `conversion_rate` stored as `"12%"` must become `0.12` before weighting it.

This is routine data hygiene on real, messy production tables — every analyst
hits text-encoded measures on some warehouse, with no benchmark in sight. The
methodology is universal craft, so it belongs in the shipped skill; it transfers
to every ktx user querying a live database.

## Model

The change is **additive content across two surfaces** — the same split specs 10
and 11 made, and for the same reason. The split is the central design decision;
it satisfies spec 07's hard dialect-agnostic invariant for `<sql_craft>` without
weakening it.

### Why two surfaces (the dialect-agnostic reconciliation)

The **detect → parse → scale** half is **pure portable SQL** and stays entirely
in the dialect-agnostic skill:

- Stripping `$` / `,` / `%` is a portable chained `REPLACE` over a small, known
  set of literal characters — no regex needed.
- Suffix scaling (K=10³, M=10⁶, B=10⁹) is a portable `LIKE`/`CASE` expression.
- Sentinel mapping (`-` / `N/A` / empty → `0` or `NULL`) is a portable `CASE`.
- The final cast to a numeric type is `CAST(... AS DECIMAL)`, broadly portable.

The **verify** half has one piece that is genuinely dialect-divergent: a
**failure-detecting numeric cast** — a cast that signals (rather than silently
swallows) a value that did not parse. This is exactly what requirement 3
("confirm coverage") needs, and it cannot be written portably:

- **bigquery:** `SAFE_CAST(x AS FLOAT64)` → `NULL` on failure.
- **snowflake:** `TRY_TO_NUMBER(x)` / `TRY_CAST` → `NULL` on failure.
- **tsql (SQL Server):** `TRY_CAST(x AS DECIMAL(...))` / `TRY_CONVERT` → `NULL`.
- **clickhouse:** `toFloat64OrNull(x)` / `toDecimalOrNull(...)` → `NULL`.
- **postgres / mysql:** no `TRY_CAST` — guard with a numeric pattern test before
  casting (e.g. `CASE WHEN x ~ '^-?[0-9.]+$' THEN x::numeric END`).
- **sqlite (the gotcha):** a plain `CAST('abc' AS REAL)` returns **`0.0`** and
  `CAST('12abc' AS REAL)` returns **`12.0`** — it neither errors nor NULLs, so an
  `IS NULL` coverage check is **silently broken**. Detecting a failed parse needs
  a `GLOB`/`typeof` pattern guard.

So a portable skill cannot inline a safe cast any more than spec 10 could inline a
date-series generator or spec 11 a calendar range frame. ktx already routes that
kind of engine-specific syntax through the per-dialect notes in
`packages/cli/src/context/sql-analysis/dialects/<dialect>.md`, served by the
`sql_dialect_notes` MCP tool (spec 08). Specs 10 and 11 set the exact precedent:
a construct not yet in the dialect rubric, genuinely engine-specific, was added
there (the **Series** line; the **Rolling window** line) and the dialect-agnostic
skill points to it. The failure-detecting cast is the next construct in that same
position, so the **safe-cast idiom belongs in the dialect notes**, and the skill
points to it.

Surface 1 (skill) carries the **pattern** (detect the text encoding; parse/scale
in an early CTE; verify with a failure-detecting cast). Surface 2 (dialect notes)
carries the **concrete safe-cast syntax** per engine, including the sqlite
`CAST`-returns-0 gotcha.

The regex character-*strip* is deliberately **not** promoted to the dialect
notes: a portable chained `REPLACE` over a known character set is the opinionated
default, so there is no need for a per-dialect strip line (derive from need; one
default). The dialect surface gains exactly one thing — the safe cast — because
that is the only piece the portable path genuinely cannot express.

### Additive, inline, heuristic-with-a-why

Consistent with specs 07, 10, and 11: the skill change is **additive content in
one Markdown file** (`skills/analytics/SKILL.md`), inline (no bundled
`reference/` file — `setup-agents.ts` ships only `SKILL.md`), dialect-agnostic,
and phrased as **heuristics with a one-line generic rationale**, not a wall of
MUSTs. The dialect-notes change is additive content in the seven existing
`dialects/*.md` files. No new tool, flag, or config on either surface.

### Build on the rules already present; do not restate them

- The Schema-discovery group already carries **"Sample before you compose"** and
  **"Cast to the real type before comparing"** (spec 07). The detect rule
  **extends** the first (distinct-value sampling to learn the encoding) and the
  parse rule **complements** the second (text-meaning-numeric, not just
  text-vs-numeric literal mismatch) — reference them, do not repeat them.
- The sentinel **0-vs-NULL** choice is the **same additive-vs-non-additive
  judgment** spec 10 established in its *"Default by additivity"* rule (0 only
  when "no value" genuinely reads as 0; NULL otherwise). **Reference** that rule
  rather than restating the discriminator (state each rule once).

## Requirements

### 1. Skill surface — `<sql_craft>` "Schema discovery before writing SQL"

Add the text-encoded-numeric guidance to the **existing** group, after its two
current bullets. Phrase as heuristics, each with a generic *why*, dialect-agnostic.
It must cover:

1. **Detect text-encoded numerics during sampling.** When a column the question
   treats as a number is stored as text, sample its **distinct** values to learn
   the encodings actually present — unit suffixes (`K`/`M`/`B`), currency
   symbols, thousands separators, percent signs, and non-numeric sentinels
   (`-`, `N/A`, empty) — **before** composing. Never infer the format from the
   column name. *Why:* compared/aggregated as-is, the text sorts lexically
   (`'100' < '9'`) and a naive cast collapses formatted values to `0`/NULL —
   producing a silently wrong result instead of an error.

2. **Parse and scale in an early CTE.** Strip currency/separator/percent
   characters, multiply by the suffix scale (K=10³, M=10⁶, B=10⁹), map sentinels
   to `0` **or** `NULL` per the question's intent, then cast to a numeric type —
   all in **one early CTE**, so every downstream layer sees clean numbers. The
   `0`-vs-`NULL` choice for sentinels follows spec 10's **additive-vs-non-additive**
   rule (reference it; do not restate). *Why:* a string column aggregated as-is
   sorts lexically and casts to 0, so the math is silently wrong.

3. **Confirm coverage (verify).** After parsing, sanity-check that **no
   intended-numeric value silently failed to parse** — a failed parse should
   surface as `NULL`, which is only visible with a **failure-detecting cast**.
   Note the divergence: a plain `CAST` errors on some engines and, on sqlite,
   returns `0`/partial rather than NULL — so use the engine's safe-cast idiom from
   `sql_dialect_notes` (requirement 3), then count residual NULLs among
   non-sentinel rows. *Why:* an encoding the sample missed would otherwise vanish
   as `0`/NULL instead of being caught.

### 2. One worked example — parse/scale, fully portable

Add **exactly one** new compact before/after `sql` example demonstrating the
parse-and-scale pattern on a synthetic generic schema
(e.g. `metrics(label, value_text)` with values like `'1.2K'`, `'$1,200'`, `'-'`):

- **Wrong:** `SUM(CAST(value_text AS REAL))` (or summing the raw strings) — the
  formatted values collapse to `0`/partial, so the total is silently wrong.
- **Right:** an early CTE that strips symbols with chained `REPLACE`, applies a
  `CASE` for the K/M/B suffix scale, maps `'-'`/`'N/A'`/`''` to `0`, casts to
  `DECIMAL`, then `SUM`s the parsed column.

**Standard, portable SQL only** — no `REGEXP_REPLACE`, `SAFE_CAST`, `TRY_CAST`,
`TRY_TO_NUMBER`, `toFloat64OrNull`, `GLOB`, or any dialect function — so the
example stays dialect-clean. Keep it ~12–16 lines. The **verify** step gets **no**
inline example (its correct form needs the engine-specific safe cast, delegated to
`sql_dialect_notes`, exactly as spec 10's period-spine and spec 11's
rolling-window variants were prose-only).

This adds **one** worked `sql` example to the skill. Spec 11 independently adds
one as well; **do not hardcode the resulting total** — increment from the current
state. As of this writing the skill carries **three** examples (spec 07
window-then-filter, spec 09 multi-hop fan-out, spec 10 panel spine), so this is
the **fourth**; if spec 11 ships first it is the **fifth**. The fence-count test
assertion is incremented by one from its current value (see Acceptance criteria).

### 3. Dialect-notes surface — `dialects/*.md` (safe cast)

Add a **"Safe cast"** idiom line to **each** of the seven authored dialect files,
parallel to spec 10's **Series** line and spec 11's **Rolling window** line. Each
line gives that engine's **failure-detecting numeric cast** — a cast that returns
`NULL` (or is detectably invalid) on a non-numeric input — which is what makes the
verify step correct on that engine. Each note is engine-exclusive (a SQLite
analyst gets the SQLite idiom and never another engine's construct, per the
existing dialect-notes leak guards). Orientation only — exact syntax is the
implementer's; verify against authoritative docs (context7 / the engine manual)
rather than asserting from memory:

- **postgres:** no `TRY_CAST` — guard with a numeric pattern before casting,
  e.g. `CASE WHEN x ~ '^-?[0-9.]+$' THEN x::numeric END`. (`regexp_replace` is
  available for the strip, but chained `REPLACE` is the portable default.)
- **mysql (8.0+):** no `TRY_CAST` — guard with `x REGEXP '^-?[0-9.]+$'` before
  `CAST(... AS DECIMAL)`; `REGEXP_REPLACE` is available for the strip.
- **bigquery:** `SAFE_CAST(x AS FLOAT64)` (or `SAFE_CAST(... AS NUMERIC)`) →
  `NULL` on failure.
- **snowflake:** `TRY_TO_NUMBER(x)` / `TRY_TO_DECIMAL(x, p, s)` / `TRY_CAST` →
  `NULL` on failure.
- **clickhouse:** `toFloat64OrNull(x)` / `toDecimalOrNull(...)` → `NULL`.
- **tsql (SQL Server):** `TRY_CAST(x AS DECIMAL(18,4))` / `TRY_CONVERT` → `NULL`.
- **sqlite (the gotcha):** a plain `CAST` returns `0`/partial, **not** NULL or an
  error, so a coverage check must use a pattern guard such as
  `CASE WHEN cleaned GLOB '...' THEN CAST(cleaned AS REAL) END` (or a `typeof`
  check) to detect a value that did not parse.

This line is what makes the verify step executable from the dialect-agnostic
skill. It is **distinct** from the Series and Rolling-window lines (those generate
or window over a calendar; this detects a failed numeric parse). Phrase any
version note as `8.0+`-style, **not** "as of version …" (the dialect-notes test
bans version-dated wording).

### 4. Explicit constraints / exclusions

None of the following may appear (consistent with specs 07, 10, and 11):

- **No inline dialect-specific cast/regex syntax in the skill** — no `SAFE_CAST`,
  `TRY_CAST`, `TRY_TO_NUMBER`, `REGEXP_REPLACE`, `toFloat64OrNull`,
  `replaceRegexpAll`, or `GLOB` anywhere in `SKILL.md`. The portable strip is
  chained `REPLACE`; the failure-detecting cast lives only in the dialect notes.
- **No regex-strip dialect line.** The character strip stays the portable
  chained-`REPLACE` default; the dialect notes gain only the **safe cast**.
- **No grader / gold-answer / benchmark reference**, and no output-shape contract
  (the skill is for interactive analysis).

### 5. Coordination with specs 07, 08, 10, and 11

- **Spec 07** owns the Schema-discovery group and its two existing bullets
  (*"Sample before you compose"*, *"Cast to the real type before comparing"*).
  Spec 12 **extends** that group and **builds on** both bullets — references them,
  never restates them; they must stay intact and uncontradicted.
- **Spec 08** owns the dialect-notes channel and its leak guards. Spec 12 adds one
  rubric line through that channel; the engine-exclusivity guards apply unchanged.
- **Spec 10** owns the additive-vs-non-additive discriminator (Answer
  completeness) and the dialect **Series** line. Spec 12 **references** the
  additivity rule for the sentinel `0`-vs-`NULL` choice; do not duplicate it.
- **Spec 11** independently adds the dialect **Rolling window** line, one `sql`
  example, and the **rolling-window** entry to the step-5 provision list. Spec 12
  touches the **same** three places (the dialect-notes rubric loop, the example
  count, and the step-5 list). Both are independent and additive — **add to the
  current state, do not assume an order**: name **safe-cast** in the step-5 list
  without removing rolling-window/series; increment the example count by one from
  whatever it is; add `/\*\*Safe cast/` to the rubric loop alongside any
  `/\*\*Rolling/` assertion.

### 6. Step pointer (no duplication)

The step-5 `sql_dialect_notes` provision list (currently "FQTN,
identifier-quoting, date, top-N, series/calendar, and JSON conventions"; spec 11
also names rolling-window) should additionally name the **safe-cast** convention
now that it exists. State each rule once inside `<sql_craft>`; the workflow steps
only point to it.

## Leak-safety (hard constraint)

Every worked example or note uses a **synthetic generic schema** (e.g.
`metrics(label, value_text)`) and made-up values (`'1.2K'`, `'$1,200'`, `'-'`),
showing only the *pattern*. **No** benchmark table names, SQL, or result values on
either surface. The dialect-notes additions, like the existing notes, carry no
benchmark / grader / version-dated content. The behavior is reconstructable from
first principles and tied to no specific instance.

## Acceptance criteria

- The `<sql_craft>` "Schema discovery before writing SQL" group states the three
  heuristics — inline, dialect-agnostic, each with a generic *why*, and each
  **building on** (not restating) the existing *"Sample before you compose"* and
  *"Cast to the real type before comparing"* bullets and spec 10's additivity rule:
  - **detect** text-encoded numerics by sampling distinct values (suffixes,
    symbols, separators, sentinels) — never from the column name;
  - **parse and scale** in an early CTE (strip → suffix-scale → sentinel map →
    cast), sentinel `0`-vs-`NULL` per spec 10's additivity rule;
  - **confirm coverage** with a failure-detecting cast, delegating the engine's
    safe-cast syntax to `sql_dialect_notes`.
- Exactly **one** new worked `sql` example: parse-and-scale, wrong-vs-right, using
  chained `REPLACE` + `CASE` suffix scale + sentinel `CASE` + `CAST(... AS
  DECIMAL)`, in standard portable SQL. The `sql`-fence count assertion is
  incremented by **one** from its current value (3 today → 4; or 5 if spec 11
  shipped first).
- Each of the seven `dialects/*.md` files gains a **"Safe cast"** idiom line in its
  engine's own failure-detecting numeric-cast idiom (including the sqlite
  `CAST`-returns-0 gotcha); no engine leaks another engine's construct, and the
  additions contain no benchmark / grader / version-dated content.
- The skill remains **dialect-clean:** no `QUALIFY`, `strftime`, `julianday`,
  `generate_series`, `GENERATE_DATE_ARRAY`, backtick three-part FQTN, inline
  `RANGE … INTERVAL` frame, **and no `SAFE_CAST` / `TRY_CAST` / `TRY_TO_NUMBER` /
  `REGEXP_REPLACE` / `toFloat64OrNull` / `GLOB`**, anywhere in `SKILL.md`
  including the new example.
- The step-5 `sql_dialect_notes` provision list names the **safe-cast** convention
  alongside FQTN / identifier-quoting / date / top-N / series-calendar /
  rolling-window / JSON.
- The existing interactive guidance (`<workflow>`, `<rules>`, the other examples),
  the two existing Schema-discovery bullets, and the existing dialect-note rubric
  lines (including **Series** and, if present, **Rolling window**) are intact and
  uncontradicted.
- No grader / benchmark reference, and no output-shape contract.
- The skill stays scannable and comfortably under the 500-line budget; frontmatter
  still parses as `ktx-analytics`.

## Implementation orientation

Line numbers drift; treat these as anchors, not addresses. The implementer owns
the prose.

- **Skill:** `packages/cli/src/skills/analytics/SKILL.md` — add the three
  heuristics to the "Schema discovery before writing SQL" group (after its two
  existing bullets), the single parse-and-scale worked example, and extend the
  step-5 dialect-notes provision list to name the safe-cast convention. Leave
  `<workflow>` / `<rules>` / the other examples and the two existing
  schema-discovery bullets intact. Delivery is unchanged (single `SKILL.md` per
  target via `readAnalyticsSkillContent` in `setup-agents.ts`) — confirm, no
  change required.
- **Dialect notes:** the seven files under
  `packages/cli/src/context/sql-analysis/dialects/`. The list is kept in sync with
  `DIALECTS_WITH_NOTES` (`dialect-notes.ts`) and shipped to `dist` by
  `copy-runtime-assets.mjs` — no plumbing change, content only. **Verify each
  engine's actual safe-cast / try-cast support against authoritative docs before
  writing the idiom; do not assert from memory** (in particular the sqlite
  `CAST`-returns-0 behavior, which is the motivating gotcha).
- **Tests:**
  - `packages/cli/test/skills/analytics-skill-content.test.ts` — add a
    representative phrase for each of the three heuristics (e.g. a *detect*, a
    *parse/scale*, and a *confirm-coverage* phrase) to the `represents every craft
    behavior` list; bump the `sql`-fence count assertion **by one** from its
    current value; assert the example shape (e.g. `REPLACE(` and `CAST(` and a
    suffix-scale multiplier); and **strengthen** the dialect-clean guard by adding
    `SAFE_CAST`, `TRY_CAST`, `TRY_TO_NUMBER`, `REGEXP_REPLACE`, `toFloat64OrNull`,
    and `GLOB` to the banned list (mirroring spec 10 adding `generate_series` /
    `GENERATE_DATE_ARRAY` and spec 11 adding the no-inline-`RANGE … INTERVAL`
    guard, so the "safe cast lives only in the dialect notes" criterion is
    *enforced*, not incidentally true).
  - `packages/cli/test/context/mcp/dialect-notes.test.ts` — extend the "answers
    the full rubric for every dialect" loop with the safe-cast assertion,
    `expect(notes).toMatch(/\*\*Safe cast/)`, so every dialect must answer it.
    Coverage is derived from `DIALECTS_WITH_NOTES`, so the new assertion enforces
    all seven without a hand-maintained list. Do **not** add a false-exclusivity
    assertion for `TRY_CAST` (it is shared by snowflake and tsql); requiring the
    line per dialect is sufficient.
- Rebuild and re-link the dev binary so the playground picks up both surfaces:
  `pnpm run build && pnpm run link:dev`.

## Benchmark context (motivation only)

At least one SQLite-subset question stores trading volume as suffix-encoded text
(`"K"`/`"M"`, `"-"` for zero) and fails because the agent aggregates the raw
strings — runnable, plausible, wrong. The sqlite `CAST`-returns-0 behavior makes
the failure especially insidious: there is no error to alert the agent, and a
naive `IS NULL` coverage check would not catch it either, which is precisely why
the safe-cast idiom belongs in the dialect notes. The fix — parse messy encodings
before math, then verify coverage with a failure-detecting cast — is universal
data hygiene that helps any analyst on any warehouse, so it belongs in the
product's craft (skill) plus the per-dialect safe-cast syntax that makes the
verify step executable, not in a benchmark-specific prompt. Improving the
benchmark score is a side effect; the skill and the dialect notes contain no trace
of the benchmark.

## Implementation notes

Shipped on branch `write-feature-spec-wiki`, on top of specs 10 and 11 (both already
applied in the working tree). Built from the current state per the "do not assume an
order" guidance — there were **four** worked examples (specs 07 window-then-filter,
09 multi-hop fan-out, 10 panel spine, 11 cumulative running total), so this is the
**fifth**, and step 5 already named `series/calendar, rolling-window`.

**Skill — `packages/cli/src/skills/analytics/SKILL.md`:**
- Added the three heuristics to the **"Schema discovery before writing SQL"** group,
  after the two existing bullets: *Parse text-encoded numerics before doing math on
  them* (detect by sampling distinct values, extending *Sample before you compose*,
  never inferring from the column name), *Strip, scale, and cast in one early CTE*
  (the *meaning-is-numeric* complement to *Cast to the real type before comparing*,
  with the sentinel `0`-vs-`NULL` choice deferred to spec 10's *Default by
  additivity* rule), and *Confirm the parse covered every value* (failure-detecting
  cast from `sql_dialect_notes`). Each carries a one-line generic *why*; the existing
  bullets and the additivity rule are referenced, not restated.
- Added **one** portable worked example (`metrics(label, value_text)` with `'1.2K'`,
  `'3M'`, `'$1,200'`, `'-'`): wrong = `SUM(CAST(value_text AS REAL))`; right = an
  early `parsed` CTE that strips with chained `REPLACE`, scales the K/M/B suffix with
  a `CASE`, maps sentinels to `0`, casts to `DECIMAL(18,4)`, then `SUM`s. Standard
  portable SQL only — no dialect functions, no inline safe cast.
- Step 5 dialect-notes provision list now names **safe-cast** alongside the others.

**Dialect notes — `packages/cli/src/context/sql-analysis/dialects/*.md`:** added a
**Safe cast** line to all seven files (after the *Rolling window* line), each giving
that engine's failure-detecting numeric cast: postgres/mysql use a numeric pattern
guard before casting (no `TRY_CAST`; mysql's bare `CAST` returns `0` with a warning);
bigquery `SAFE_CAST`; snowflake `TRY_TO_NUMBER`/`TRY_TO_DECIMAL`/`TRY_CAST`; tsql
`TRY_CAST`/`TRY_CONVERT`; clickhouse `toFloat64OrNull`/`toDecimal64OrNull` (the
`...OrZero` variants return `0`); sqlite documents the `CAST`-returns-`0.0`/partial
gotcha and a `GLOB` pattern guard. ClickHouse function names were verified against
the official docs via context7 (the spec's loose `toDecimalOrNull` is not a real
name — the `to<Type>OrNull` family requires a bit width, hence `toDecimal64OrNull`).
No version-dated wording.

**Tests:** `analytics-skill-content.test.ts` — added the three representative
phrases, bumped the `sql`-fence count 4 → 5 (and the test title), asserted the
example shape (`WITH parsed AS`, `REPLACE(`, `AS DECIMAL(`, `LIKE '%K' THEN 1000`),
and strengthened the dialect-clean banned list with `SAFE_CAST`, `TRY_CAST`,
`TRY_TO_NUMBER`, `REGEXP_REPLACE`, `toFloat64OrNull`, and `GLOB` (mirroring spec 10's
`generate_series` / spec 11's inline-`RANGE … INTERVAL` guards). `dialect-notes.test.ts`
— added `expect(notes).toMatch(/\*\*Safe cast/)` to the per-dialect rubric loop, so
all seven (derived from `DIALECTS_WITH_NOTES`) must answer it; no false-exclusivity
assertion for the shared `TRY_CAST`.

**Verification:** both affected test files pass (19 tests); broader `test/skills` +
`test/context/mcp` pass (65 tests); production type-check (`tsc -p tsconfig.json`)
is clean; `pnpm run build` copies both surfaces into `dist` (7 dialect files carry
*Safe cast*, the built `SKILL.md` carries the parse example) and `pnpm run link:dev`
relinks `ktx-dev`. One **pre-existing, unrelated** type error remains in the
test-only config (`test/mcp-server-factory.test.ts:152`, byte-identical to HEAD,
untouched here) — out of scope for this spec.
