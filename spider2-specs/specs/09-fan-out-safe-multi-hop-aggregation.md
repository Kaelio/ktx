# Strengthen fan-out-join safety for multi-hop aggregation in the analytics skill

> Refined spec. Intake draft: `todo/09-fan-out-safe-multi-hop-aggregation.md`.
> Extends spec 07 (`specs/07-analytics-skill-sql-craft.md`), which shipped the
> `<sql_craft>` block. Additive, content-only.

## Problem

The shipped `ktx-analytics` skill
(`packages/cli/src/skills/analytics/SKILL.md`) already carries a single-hop
fan-out rule in `<sql_craft>` → **Composition**:

> **Avoid fan-out joins.** Add columns only from tables already at the target
> grain, or pre-aggregate to that grain before joining. A join that multiplies
> rows quietly inflates every downstream `SUM`/`COUNT`.

In practice the agent honors that on a single join but still **silently
fans out on multi-hop join chains**, where the inflation is one or two joins
removed from the aggregate and therefore much harder to notice.

The failure shape: a measure that lives at a *coarse* grain (one row per parent
record) is counted/summed *after* the parent has been joined down to a *finer*
grain (one row per child line). Every parent-level value is then duplicated by
its child fan-out, so `COUNT(*)` / `SUM(amount)` over-counts by a data-dependent
amount — runnable SQL, plausible-looking number, quietly wrong.

The rule today is stated only as a **prohibition** ("Avoid…"). It needs two
upgrades: (a) generalize it so the danger is understood as *cumulative across a
whole join chain*, not a single join; and (b) pair it with an **affirmative
verification habit** the agent runs while composing, so a grain change is
detected and fixed rather than merely warned against.

## Generic use case (independent of any benchmark)

An analyst on any production warehouse asks a counting/summing question whose
path runs through several one-to-many hops — e.g. *"how many orders per region
contain a returned item?"* where the path is `region → store → order →
order_line`. The honest answer counts each order once. The naïve join chain joins
`order_line` (to apply the line-level condition) and then counts orders, so an
order with three returned lines is counted three times. The inflation happens
**three joins below the `COUNT`**, where it is easy to miss. This is one of the
most common silently-wrong analytics mistakes on normalized schemas — not
specific to any dataset, dialect, or benchmark.

## Model (invariants — the implementer owns the prose)

These constrain the change; the exact wording is the implementer's. Each is
grounded in Anthropic's skill-authoring and prompt-engineering guidance so the
addition stays consistent with how spec 07 was written.

### Additive, inline-only, dialect-agnostic (inherited from spec 07)

The change is **additive content inside `skills/analytics/SKILL.md`** only — no
bundled `reference/*.md` file (the delivery path ships a single `SKILL.md` per
target; see spec 07 §Model "Inline-only delivery"). No new tool, flag, or config.
Every addition must read correctly on any dialect: **no** `QUALIFY`,
`strftime`/`julianday`, backtick/`DB.SCHEMA.TABLE` FQTNs, or other single-dialect
construct — including in the worked example. The existing `<workflow>`, `<rules>`,
`<examples>`, and the other four `<sql_craft>` sub-headings are preserved
unchanged.

### Heuristic-plus-*why*, because SQL authoring is a high-freedom task

Anthropic's "set appropriate degrees of freedom" guidance classifies tasks with
many valid approaches where decisions depend on context as **high freedom →
text-based heuristics**, the "open field, many paths" case (versus low-freedom,
fragile operations that need an exact script). SQL authoring is squarely
high-freedom. So the new content is phrased as **heuristics with a one-line,
universal rationale**, never as bare `ALWAYS`/`NEVER` imperatives — matching the
existing `<sql_craft>` style and Anthropic's "add context / explain why so Claude
generalizes" principle.

### Affirmative framing for the verification step (do, not don't)

Anthropic's prompt-engineering guidance is explicit: **"Tell Claude what to do
instead of what not to do."** The draft's requirement for "a detect-and-fix
*habit*, not just a prohibition" is the same principle. Therefore:

- The **generalized rule keeps the established `Avoid fan-out joins` lead and the
  term `fan-out`** — it is spec 07's consistent terminology and the existing
  content test references that phrase; reframing it would churn shared vocabulary
  for no gain.
- The **new verification step is phrased affirmatively** (e.g. *"Verify the grain
  holds across each join"*) — an action the agent performs while composing, not a
  warning. The two together satisfy both principles: a recognized anti-pattern
  name *and* a positive habit.

### One default with an escape hatch, not two equal options

Anthropic: **"Avoid offering too many options… provide a default with an escape
hatch."** The fix for an inflated aggregate is presented as exactly that:

- **Default: pre-aggregate the measure to its own grain in a CTE, then join the
  already-aggregated result.** This is the single-hop fix generalized, and it is
  the *only* correct fix for `SUM`/`AVG` — you cannot de-duplicate a summed
  measure with `DISTINCT` (two legitimately-equal amounts would collapse).
- **Escape hatch: `COUNT(DISTINCT key)` — for a pure count only.** It rescues an
  inflated count in one line, but must be stated as count-only, not as a general
  remedy.

This is the deepest correctness point in the spec and the easiest to get wrong; a
naïve blanket "just use `COUNT(DISTINCT)`" is silently wrong for sums.

### Consistent terminology

Anthropic: **"Choose one term and use it throughout."** Reuse spec 07's existing
vocabulary verbatim — **`grain`**, **`fan-out`**, **`pre-aggregate`** — do not
introduce synonyms (e.g. do not rename the concept "row blow-up" or
"multiplication factor"). Prose may vary, but the named concepts stay fixed.

### Concise — the addition must justify its token cost

Anthropic: **"Concise is key… does this paragraph justify its token cost?"** and
"Claude is already very smart." The agent knows what a join and a `GROUP BY` are;
the addition explains only the non-obvious trap (cumulative grain inflation) and
shows the fix. Net addition is roughly one rewritten bullet, one new bullet, and
one worked example — the skill stays comfortably under the 500-line budget
(~117 lines today).

### Examples over descriptions — exactly one

Anthropic's "examples pattern": **"Examples help Claude understand the desired
style and level of detail more clearly than descriptions alone"** and
"examples are concrete, not abstract." The multishot guidance favors 3–5 examples
in general, but here **conciseness and spec 07's one-example-per-rule economy
win**: the skill already carries the window-then-filter example, so this adds
**exactly one** compact wrong-vs-right example. The wrong/right contrast inside
that single example supplies the diversity multishot calls for, at one example's
token cost.

### Leak-safety (hard constraint)

The worked example must be a **synthetic, generic schema invented for teaching** —
not the tables, column names, query, or numeric results of any Spider 2.0-Lite
question. It demonstrates the *pattern* (a coarse-grain measure aggregated after a
one-to-many join), which is universal and reconstructable from first principles. A
reviewer must find nothing in it that ties it to a specific benchmark instance.
See "Leak-safety" below.

## Requirements

All four land in the **Composition** sub-heading of `<sql_craft>` in
`packages/cli/src/skills/analytics/SKILL.md`. Structure (chosen design): rewrite
the existing fan-out bullet, add one affirmative verification bullet, add one
worked example. Do not touch the other four sub-headings or `<workflow>`/`<rules>`/
`<examples>`.

### 1. Generalize the fan-out rule to multi-hop chains

Rewrite the existing **`Avoid fan-out joins.`** bullet so it makes explicit that
the danger is **cumulative**: *any* one-to-many hop on the path between a measure's
owning table and the aggregate inflates that measure, **even when the offending
join is several hops away from the `SUM`/`COUNT`**. The fix is the same as the
single-hop case — **pre-aggregate the measure to its own grain in a CTE, then join
the already-aggregated result** — but the agent must apply it **per
measure-owning table along the whole chain**, not just at the final join. Keep the
`fan-out` term and the one-line *why*.

### 2. Add an affirmative grain-verification habit

Add a companion bullet, phrased as an action the agent performs **while
composing** (not a prohibition):

- Confirm that a join intended to be one-to-one / many-to-one **did not change the
  grain** it aggregates at — e.g. check that the row count (or the count of the
  aggregate's key) is unchanged across that join.
- When a join is genuinely one-to-many, **reach for the default fix
  (pre-aggregate to grain)**; for a **pure count**, `COUNT(DISTINCT key)` is an
  acceptable escape hatch.
- State the caveat once: **`SUM`/`AVG` of a fanned-out measure must pre-aggregate**
  — `DISTINCT` cannot de-duplicate a sum.

This is spec 07's "build incrementally and check each layer" discipline pointed
specifically at grain preservation, in affirmative form.

### 3. One concrete, generic multi-hop worked example

Add **exactly one** compact wrong-vs-right `sql` example inside `<sql_craft>`
demonstrating the multi-hop inflation and the pre-aggregate fix. It is the
**second** `sql` fence in the skill (the first is spec 07's window-then-filter
example).

**Required properties** (these are the constraints; the SQL below is orientation):

- **Multi-hop chain** where the inflating one-to-many hop is **≥1 join removed**
  from the aggregate (not the single-hop case spec 07 already covers).
- **Unambiguous attribution**: each counted entity maps to **exactly one** group,
  so the honest answer is well-defined. (This rules out "coarse measure attributed
  to a fine dimension reached by descending," where one entity spans several
  groups and the correct number is itself ambiguous — that would teach a murky
  pattern.)
- **Motivated descent**: the finer-grain table is joined for a real reason (a
  line-level filter or a needed line-level value), so the reader sees *why* the
  fan-out join is there.
- **Plain `COUNT`/`SUM`**, not `AVG` — averaging collides with the existing
  *Macro vs micro average* bullet and would muddy the fan-out lesson.
- The **RIGHT side demonstrates the default fix** (pre-aggregate to grain in a
  CTE) and is **actually correct**, not merely runnable — its number must equal the
  honest answer, not just avoid an error.
- Generic invented schema, standard dialect-agnostic SQL (no `QUALIFY`, no dialect
  functions), no benchmark identifiers or values.

**Recommended sketch** (implementer may adjust within the properties above):

```sql
-- "How many orders per region contain a returned item?"
-- WRONG: joining order_lines to apply the line-level filter multiplies orders —
-- an order with two returned lines is counted twice, three joins below the COUNT.
SELECT r.region_id, COUNT(*) AS n_orders
FROM regions r
JOIN stores s      ON s.region_id = r.region_id
JOIN orders o      ON o.store_id  = s.store_id
JOIN order_lines l ON l.order_id  = o.order_id
WHERE l.status = 'returned'
GROUP BY r.region_id;

-- RIGHT: collapse order_lines to one row per qualifying order first, then join up.
WITH returned_orders AS (
  SELECT order_id FROM order_lines WHERE status = 'returned' GROUP BY order_id
)
SELECT r.region_id, COUNT(*) AS n_orders
FROM regions r
JOIN stores s           ON s.region_id  = r.region_id
JOIN orders o           ON o.store_id   = s.store_id
JOIN returned_orders ro ON ro.order_id  = o.order_id
GROUP BY r.region_id;
-- A pure count could also use COUNT(DISTINCT o.order_id); a SUM/AVG of an
-- order-level measure fanned out this way must pre-aggregate — DISTINCT can't
-- de-duplicate a sum.
```

### 4. Placement and structure

- Both bullets live under the existing **Composition** sub-heading; the example
  follows them. The five-sub-heading structure spec 07 established is unchanged.
- **State each rule once** (Anthropic "consistent terminology / don't repeat"):
  do not also restate the multi-hop rule in `<workflow>` steps 5/6 — those already
  carry a one-line pointer into `<sql_craft>`, which is sufficient.

### 5. Coordination with spec 07 (supersession)

Spec 07's requirement 3 and acceptance criteria say the skill contains **exactly
one** worked example and "Do not add a second example." **This spec supersedes
that constraint**: the skill now carries **two** `sql` worked examples
(window-then-filter from spec 07, plus this multi-hop fan-out example). Annotate
spec 07 at those two spots with a one-line "superseded by spec 09" note so the two
permanent specs do not contradict. No other spec 07 content changes.

## Leak-safety (hard constraint on this spec and its example)

The benchmark's gold answers must never appear in ktx. The worked example must be
a **synthetic, generic schema invented for teaching** — not the tables, column
names, query, or numeric results of any Spider 2.0-Lite question. The example
demonstrates the *pattern* (a coarse-grain measure counted after a one-to-many
join), which is universal; it must be reconstructable from first principles by
anyone, with zero reference to benchmark data. A reviewer should be able to read
the example and find nothing that ties it to a specific benchmark instance.

## Acceptance criteria

- The `<sql_craft>` **Composition** section states the **multi-hop generalization**
  of the fan-out rule (cumulative danger across the chain; pre-aggregate per
  measure-owning table) and an **affirmative grain-verification habit**, inline and
  dialect-agnostic.
- The fix is presented as **default (pre-aggregate to grain) + escape hatch
  (`COUNT(DISTINCT key)`, count-only)**, with the explicit caveat that `SUM`/`AVG`
  of a fanned-out measure must pre-aggregate.
- Exactly **one** new, **generic** worked example (wrong vs. pre-aggregated-right)
  using an invented schema, with no benchmark-derived identifiers or values, whose
  RIGHT side is actually correct (unambiguous attribution; honest number).
- The skill now contains **two** `sql` worked examples total; the existing content
  test's fence-count assertion is updated `1 → 2` and new assertions cover the
  multi-hop rule phrase and the grain-verification-habit phrase.
- Terminology is consistent with spec 07 (`grain`, `fan-out`, `pre-aggregate`); no
  synonyms introduced.
- **No new tool, flag, or config.** Skill-content only; additive to spec 07.
- All spec 07 invariants still hold: the skill remains dialect-agnostic (no
  `QUALIFY`/`strftime`/`julianday`, no backtick three-part FQTN, no relative-time
  anchoring to a `MAX(...)` date) and free of any benchmark/grader/gold reference,
  including in the new example; `<workflow>`/`<rules>`/`<examples>` and the other
  four sub-headings are intact; frontmatter still parses through
  `SkillsRegistryService.parseFrontmatter`; the skill stays under 500 lines.
- Spec 07's "exactly one example" constraint is annotated as superseded (no
  contradiction between the two permanent specs).

## Implementation orientation

Line numbers drift; treat these as anchors, not addresses. The implementer owns
the prose.

- **The skill file:** `packages/cli/src/skills/analytics/SKILL.md` →
  `<sql_craft>` → **Composition**. Rewrite the `Avoid fan-out joins` bullet, add
  the affirmative grain-verification bullet, add the one worked example after them.
  Leave the other four sub-headings, `<workflow>`, `<rules>`, and `<examples>`
  unchanged.
- **Tests:** `packages/cli/test/skills/analytics-skill-content.test.ts`. Update the
  "ships exactly one … worked example" test: `match(/```sql/g)` length `1 → 2`,
  add an assertion for the new fan-out example's distinctive tokens (e.g.
  `WITH returned_orders AS`), add the multi-hop-rule and grain-verification-habit
  phrases to the behavior-presence list, and keep all banned-construct and
  size-budget guards. This is a content assertion over the source `SKILL.md` — the
  right level for prompt content.
- **Spec 07 annotation:** add a one-line "superseded by spec 09" note at spec 07's
  requirement 3 and at its "Exactly one new worked example" acceptance bullet.
- **Rebuild/re-link** the dev binary so the playground picks up the change:
  `pnpm run build && pnpm run link:dev` (provides `ktx-dev`).

## Benchmark context (motivation only)

Multi-hop aggregation questions (counting/averaging a coarse-grained measure
reached through several one-to-many joins) are a recurring source of
result-mismatch failures in the SQLite subset: the agent produces runnable SQL
with the right tables but a fan-out-inflated number. These are correctness
failures, not knowledge or schema-discovery failures (zero execution errors in the
latest run), so the fix belongs in the product's authoring craft — where it also
helps any real analyst — not in a benchmark-specific prompt. The skill itself must
contain no trace of the benchmark.

## Implementation notes

Shipped as specified — additive, content-only, no new tool/flag/config.

- **`packages/cli/src/skills/analytics/SKILL.md`** → `<sql_craft>` → **Composition**:
  - Rewrote the `Avoid fan-out joins` bullet to `**Avoid fan-out joins — the
    danger is cumulative.**`, generalizing to multi-hop chains: any one-to-many
    hop between a measure's owning table and the aggregate inflates that measure
    even when several hops below the `SUM`/`COUNT`; fix is pre-aggregate per
    measure-owning table along the whole chain. Kept the `fan-out` term and the
    one-line *why*.
  - Added the affirmative `**Verify the grain holds across each join.**` bullet:
    confirm a one-to-one / many-to-one join did not change the grain (row/key
    count unchanged); default fix is pre-aggregate to grain, escape hatch is
    `COUNT(DISTINCT key)` for a pure count only; stated once that `SUM`/`AVG` of a
    fanned-out measure must pre-aggregate because `DISTINCT` cannot de-duplicate a
    sum.
  - Added one generic wrong-vs-right worked example (orders→regions via
    stores/order_lines, `WITH returned_orders AS …`) — the second `sql` fence in
    the skill. The inflating hop is three joins below the `COUNT`; the RIGHT side
    pre-aggregates `order_lines` to one row per qualifying order so each order is
    counted once (honest answer), and the trailing comment names the count-only
    `COUNT(DISTINCT o.order_id)` escape hatch plus the `SUM`/`AVG` caveat. Invented
    schema, dialect-agnostic SQL, no benchmark identifiers/values.
  - The other four sub-headings and `<workflow>`/`<rules>`/`<examples>` are
    untouched. Skill is 147 lines (well under the 500-line budget).
- **`packages/cli/test/skills/analytics-skill-content.test.ts`**: sql-fence count
  `1 → 2`; added the multi-hop phrase (`the danger is cumulative`) and the
  grain-verification phrase (`Verify the grain holds across each join`) to the
  behavior-presence list; added new-example token assertions
  (`WITH returned_orders AS`, `COUNT(DISTINCT o.order_id)`). All banned-construct,
  relative-time, and size-budget guards retained. Test file passes (9/9).
- **Spec 07** annotated as superseded at requirement 3 and at its "exactly one
  worked example" acceptance bullet — no contradiction between the two permanent
  specs.

**Verification:** `vitest run test/skills/analytics-skill-content.test.ts` → 9
passed. `pnpm run build` (src `tsc -p tsconfig.json`) succeeds and the built
`dist/skills/analytics/SKILL.md` carries the new content; `pnpm run link:dev`
re-linked `ktx-dev`. A pre-existing, unrelated type error in
`test/mcp-server-factory.test.ts` (`KtxMcpContextPorts`/`context_tool`, last
touched in commit `2677b3ef`) surfaces under the full `type-check`'s
`tsconfig.test.json` pass; it is outside this change's surface and not introduced
here.
