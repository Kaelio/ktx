# Output completeness — answer every requested part, enforced by a final pre-emit check

> Refined spec. Intake draft: `todo/14-output-completeness-final-check.md`.

## Problem

The single largest correctness failure mode for the analytics skill is
**incomplete output**: the query runs and the methodology is roughly right, but
the projection is missing columns the question asked for. The SQL is runnable and
the aggregate is correct — the answer is simply *short by columns*. Three
recurring shapes:

1. **Multi-part questions answered partially.** A question that asks for several
   things ("report the highest *and* the lowest month, each with its count and
   average, *and* the difference") comes back with only the first clause — one
   column where several were requested.
2. **Identity dropped.** Grouping by a human-readable name but not projecting the
   entity's identifier (a product name without its product id, a customer name
   without its customer id).
3. **Inputs to a derived value dropped.** Returning a ratio / percentage /
   difference but not the underlying counts the question also asked for.

Shapes 2 and 3 are **already covered** by shipped `<sql_craft>` rules — spec 07's
*"Expose identity, not just the label"* and *"Keep the inputs to a derived
value"* — yet they are frequently **not applied**. So the gap is not missing
knowledge: these rules sit as passive heuristics in a list, and nothing makes the
agent reliably check them before finalizing. The fix is twofold: (a) add the
missing **multi-part-completeness** rule that generalizes shapes 1–3, and (b)
turn output-completeness into an **explicit final verification step** the agent
performs before emitting SQL, so the existing identity/inputs rules are actually
enforced rather than merely listed.

The failure is **model-independent**: a markedly stronger model produced the same
incomplete-output mistakes on these questions, which means it is a
craft/enforcement gap, not a capability gap — exactly the kind of universal
analyst craft that belongs in the shipped skill.

## Generic use case (independent of any benchmark)

An analyst is asked: *"For each region, report the highest and the lowest monthly
order count, and the difference between them."* A complete answer has a column for
the region's id and name, the highest count, the lowest count, and the difference
— five columns. Returning just the region and a single number answers only part
of the request. This is a universal expectation on any database: answer **every**
part of a multi-part request, identify the entities, and show the inputs behind
any derived figure — and answer *exactly* that, without padding the result with
columns the question never asked for.

## Model

The change is **additive content in one Markdown file**
(`skills/analytics/SKILL.md`), governed by the same invariants spec 07
established. They constrain the implementer; the exact prose is theirs.

### Additive, inline, heuristic-with-a-why

Consistent with specs 07 and 10: the change is additive content in
`skills/analytics/SKILL.md`, **inline** (no bundled `reference/` file — the
`setup-agents.ts` delivery ships only `SKILL.md` per target), dialect-agnostic,
and phrased as **heuristics with a one-line generic rationale**, not a wall of
MUSTs. The new rule extends the existing `<sql_craft>` "Answer completeness /
interpretation" group; the shipped bullets in that group (including the *identity*
and *inputs* rules this spec builds on) are preserved unchanged. No new tool,
flag, or config.

### The over-projection guard carries a *universal* why, not a grader reference

The intake draft frames "don't pad the result with extra columns" as
*grader-gaming*. The skill forbids **any** reference to a grader, gold answer, or
benchmark (spec 07's hard invariant; the content test bans the words). So the
guard must ship with a **universal analytics rationale** instead: columns the
question did not ask for add noise, mislead the reader into thinking they matter,
and make the result harder to consume — match the request exactly, neither short
nor padded. This is the same reconciliation spec 07 applied to the draft's
"behavior only, no rationale" instruction: generic *why* is required; only
grader/gold/benchmark rationale is banned.

### Completeness is a closed set — identity and inputs are *inside* it

"Expose identity" and "keep the inputs" tell the agent to add columns; the
over-projection guard tells it not to. These only contradict if the target is
left fuzzy, so this spec pins it down. A **complete projection** is exactly:

> {every requested metric/attribute} ∪ {the identifier of each grouped/named
> entity} ∪ {the inputs to each derived value}, at the grain the question
> specifies.

Identity and inputs are **members of that set** — part of completeness, never
"padding." **Under-projection** is any member missing (the failure this spec
attacks); **over-projection** is any column *outside* the set (what the guard
forbids). The implementer must phrase the rule and guard against this single
definition so they read as one coherent notion, not two competing instructions.

### Dialect-agnostic, additive-only, exclusions intact

Every addition reads correctly on any dialect — no dialect-specific syntax in the
rule text or the worked example. The existing `<workflow>`, `<rules>`, and the
other `<sql_craft>` bullets and examples (specs 07/09/10/11/12) are preserved and
uncontradicted. Spec 07's exclusions still hold: no output-shape contract, no
`MAX(date)` anchoring of relative time, no grader-driven advice, no dialect
syntax.

## Requirements

### 1. Multi-part / multi-output completeness — a new umbrella rule

Add a bullet to the `<sql_craft>` "Answer completeness / interpretation" group:
when a question requests several outputs — a **list** ("A, B, and C"), **paired
extremes** ("the highest *and* the lowest"), or a **value plus its components**
("X, Y, and their ratio") — the final projection must contain a column for
**each** requested output. *Why:* answering only the first clause is the most
common way a runnable query is still wrong; the grain and methodology can be
perfect yet the answer is short by columns.

This rule is the **umbrella** over the two shipped completeness rules: the
*inputs* rule (*"Keep the inputs to a derived value"*) is its "value + components"
instance, and the *identity* rule (*"Expose identity, not just the label"*) is its
"entity identity" instance. The new bullet should **name that relationship**
(so the three read as one notion) rather than restating either rule.

Keep this distinct from the row-selection rules in the same group: *"Top /
highest / most / lowest"* and *"For each X / per X / by X"* govern **which rows**
appear; multi-part completeness governs **which columns** appear. They compose
(e.g. "highest and lowest per region" needs one row per region *and* a column per
clause).

### 2. Final completeness check — the enforcement mechanism

The rule content lives **once** in `<sql_craft>`; the trigger is promoted to a
first-class line in `<workflow>` step 6.

- **Capstone bullet in `<sql_craft>`** (closing the "Answer completeness /
  interpretation" group): *before emitting the final SQL, re-read the question and
  confirm the projection covers* —
  1. every named **metric / attribute** the question asks for (→ the multi-part
     rule);
  2. the **identifier** of every grouped or named entity (→ the *identity* rule);
  3. every **input** to each derived value (→ the *inputs* rule);
  4. all at the **grain** the question specifies (→ the *for each X* / panel
     rules).

  Each facet cross-references the rule it enforces, so the check is what makes
  those passive rules active. Phrase it as a short, concrete "confirm the
  projection covers…" checklist, not a wall of MUSTs.

- **Over-projection guard** (attached to the check): do **not** add columns the
  question did not ask for "to be safe" — extra columns add noise, mislead, and
  make the result harder to consume; match the request exactly. Carries the
  **universal** why from the Model, **never** a grader/gold/benchmark reference.

- **`<workflow>` step 6 line** (the explicit ritual): step 6 ("Validate and
  explain") gains a mandatory line directing the agent to **always** run the final
  completeness check before emitting — re-read the question and verify every
  requested output, each entity's identity, each derived value's inputs, and the
  grain are all projected — pointing into the `<sql_craft>` capstone for the
  detail. This **replaces the current conditional pointer's role** ("If a result
  is unexpectedly empty or its grain looks wrong, work through the … rules"): the
  empty/grain diagnostic stays available (it maps to the existing *"Diagnose empty
  results"* and grain rules), but the completeness check fires **unconditionally**,
  on every SQL-authoring turn, not only when a result looks off. The workflow line
  names the ritual and the four facets; the rationale, guard, and example are
  stated once in `<sql_craft>`, not duplicated into the workflow.

### 3. One worked example (dialect-agnostic)

Add **exactly one** compact before/after example to the "Answer completeness /
interpretation" group, demonstrating multi-part completeness on a **synthetic**
schema (`regions`, `region_monthly`):

- **WRONG:** answers only the first clause — `SELECT region_name,
  MAX(monthly_orders) AS highest … GROUP BY region_name` — with no region id, no
  lowest, no difference.
- **RIGHT:** one column per requested output plus the entity's identity, at the
  region grain — `region_id, region_name`, the highest, the lowest, and the
  difference, with `regions` joined to `region_monthly` and grouped by the region
  id and name.

Standard dialect-clean SQL only (no `QUALIFY`, no dialect functions; `MAX`/`MIN`
are portable aggregates). Keep it tight. It teaches multi-clause coverage +
identity + derived-value inputs in one capstone, and is **distinct** from the
spec-10 `regions` panel example: that one is about missing **rows** (LEFT-JOIN
spine + `COALESCE`); this one is about missing **columns**. This is the **sixth**
worked `sql` example in the skill (after specs 07/09/10/11/12).

### 4. Coordination with specs 03 and 07/09/10/11/12

- **Spec 03** (multi-connection routing) owns `<workflow>` step 0 and the
  `connectionId` threading/scoping. Spec 14 touches `<workflow>` only to add the
  completeness-check line to **step 6** — it must not rewrite the routing or the
  `<rules>` `connectionId` scoping. If both land, step 6 reads coherently: validate
  + the completeness ritual.
- **Specs 07/09/10/11/12** own their own bullets and worked examples in
  `<sql_craft>`. Spec 14 is **additive** to the same "Answer completeness /
  interpretation" group and adds one example; it must not remove or contradict
  theirs.

## Leak-safety (hard constraint)

The example uses an **invented, generic schema** (`regions`, `region_monthly`) and
made-up columns — **no benchmark table names, SQL, or result values.** It teaches
the *pattern* (cover every requested output + identity + inputs, at grain, without
padding), which is universal and tied to no specific instance. The over-projection
guard's rationale is **universal** (noise/clarity/consumability), never
"grader-gaming" or any other scoring reference. No part of the addition mentions a
benchmark, gold answer, grader, or scoring comparator.

## Acceptance criteria

- `<sql_craft>` "Answer completeness / interpretation" states the **multi-part /
  multi-output completeness** rule (a column per requested output; list / paired
  extremes / value-plus-components), named as the umbrella over the shipped
  *identity* and *inputs* rules — inline, dialect-agnostic, with a generic *why*.
- `<sql_craft>` states a concrete **final completeness check** (re-read the
  question → confirm metrics + entity identity + derived-value inputs + grain are
  projected), cross-referencing the existing identity/inputs/grain rules so they
  are enforced, not merely listed.
- The check carries the **over-projection guard** with a **universal** rationale
  (don't pad with unrequested columns — noise / misleading / harder to consume),
  and the skill contains **zero** grader/gold/benchmark references anywhere.
- `<workflow>` **step 6** carries a mandatory line that runs the completeness
  check **unconditionally** before emitting and points into the `<sql_craft>`
  capstone; the rule content is **stated once** in `<sql_craft>` (no duplicated
  rationale/guard in the workflow). The empty/grain diagnostic remains available.
- Exactly **one** new worked `sql` example is present (synthetic
  `regions`/`region_monthly`, wrong vs complete), in standard dialect-agnostic SQL;
  the skill then carries **six** `sql` worked examples total.
- The existing interactive guidance (`<workflow>` steps, `<rules>`, the other
  `<sql_craft>` bullets and the five prior examples) is intact and uncontradicted;
  the additive-only and dialect-clean invariants from specs 07/10 still hold.
- None of spec 07's excluded items appear (output-shape contract, `MAX(date)`
  anchoring of "recent"/"past N", grader-driven advice, dialect syntax).
- The skill stays scannable and comfortably under the 500-line budget; the
  frontmatter still parses as `ktx-analytics`.
- The analytics-skill **content test is updated** to cover the new rule and check
  (see Implementation orientation).

## Implementation orientation

Line numbers drift; treat these as anchors, not addresses. The implementer owns
the prose.

- **Skill:** `packages/cli/src/skills/analytics/SKILL.md`.
  - Add the multi-part-completeness bullet and the final-completeness-check
    capstone (with the over-projection guard) to the `<sql_craft>` "Answer
    completeness / interpretation" group; add the single
    `regions`/`region_monthly` worked example.
  - In `<workflow>` step 6, replace the current conditional answer-completeness
    pointer with the mandatory completeness-check line (unconditional, names the
    four facets, points into `<sql_craft>`); keep the empty/grain diagnostic.
  - Leave `<workflow>` steps 0–5, `<rules>`, and the other `<sql_craft>`
    bullets/examples intact. Delivery is unchanged (single `SKILL.md` per target
    via `readAnalyticsSkillContent` in `setup-agents.ts`) — confirm, no change
    required.
- **Tests:** `packages/cli/test/skills/analytics-skill-content.test.ts`.
  - Add representative phrases to the "represents every craft behavior" list for
    the multi-part rule, the final completeness check, and the over-projection
    guard.
  - Bump the worked-example `sql`-fence count assertion **5 → 6** (and update the
    test name/comment), and assert the new example's shape (e.g. `region_monthly`,
    `MAX(`, `MIN(`, the difference expression, `region_id`).
  - The existing dialect-clean, grader/benchmark-clean, and relative-time
    (`MAX(...)` anchoring) guards must still pass — the new example's `MAX`/`MIN`
    lines carry no "recent"/"past N" wording, so the phrase-level guard is
    unaffected. The `SkillsRegistryService` frontmatter test must still pass.
- Rebuild and re-link the dev binary so the playground picks up the updated skill:
  `pnpm run build && pnpm run link:dev`.

## Benchmark context (motivation only)

On the latest SQLite-subset run, **incomplete output was the single largest
failure bucket (~13 of 51 voted failures)**: multi-part questions answered
partially, plus dropped identity / derived-value inputs — the latter two being
spec-07 rules that already exist but weren't applied. A probe with a much stronger
model reproduced the *same* incomplete-output failures, confirming this is a
craft-enforcement gap rather than a model-capability one. The fix — answer every
requested part, identify the entities, keep the inputs, and don't pad — is
universal analyst craft, so it belongs in the product skill (and transfers to real
users), enforced as a final pre-emit check rather than left as a passive hint.
Improving the benchmark score is a side effect; the skill contains no trace of the
benchmark.

## Implementation notes

Implemented as additive content in one Markdown file plus a test update.

- **Skill — `packages/cli/src/skills/analytics/SKILL.md`** (`<sql_craft>` "Answer
  completeness / interpretation" group):
  - Added the **"Answer every requested output"** umbrella bullet (list / paired
    extremes / value-plus-components → a column per requested output, with a generic
    *why*). It names *keep the inputs* and *expose identity* as its "value +
    components" and "entity identity" instances, pins the closed-set definition of a
    complete projection, and marks itself as governing *which columns* appear —
    distinct from the *Top …* / *For each X* row-selection rules, with which it
    composes. The two shipped instance rules are preserved verbatim.
  - Added the **"Final completeness check"** capstone bullet: a four-facet
    "before emitting, re-read the question and confirm the projection covers…"
    checklist (metric/attribute → multi-part rule; identifier → *expose identity*;
    inputs → *keep the inputs*; grain → *for each X* / *complete the panel*), run on
    every query. It carries the **over-projection guard** with a universal rationale
    (unrequested columns add noise, mislead, and are harder to consume — match the
    request exactly), with **no** grader/gold/benchmark reference.
  - Added one worked `sql` example (synthetic `regions` / `region_monthly`): WRONG
    answers only the first clause (`SELECT region_name, MAX(monthly_orders) …`),
    dropping the region id, the lowest, and the difference; RIGHT projects
    `r.region_id, r.region_name`, `MAX` highest, `MIN` lowest, and the
    `MAX − MIN` difference, joining `regions` to `region_monthly` and grouping by id
    + name. This is the **sixth** `sql` example, dialect-clean (portable `MAX`/`MIN`).
  - `<workflow>` **step 6**: replaced the conditional answer-completeness pointer
    with an unconditional *"Always run the final completeness check before emitting"*
    line that names the four facets and points into the `<sql_craft>` capstone; the
    empty/grain diagnostic is retained for diagnosis. Steps 0–5, `<rules>`, and the
    other `<sql_craft>` bullets/examples are untouched.
  - Delivery is unchanged: `readAnalyticsSkillContent` in
    `packages/cli/src/setup-agents.ts` still ships the single `SKILL.md` per target
    (confirmed, no change required).
- **Tests — `packages/cli/test/skills/analytics-skill-content.test.ts`:** added the
  three representative phrases (`Answer every requested output`, `Final completeness
  check`, `Don't over-project`); bumped the `sql`-fence count assertion 5 → 6 and
  renamed that test; asserted the new example's shape (`region_monthly`,
  `MAX(rm.monthly_orders)`, `MIN(rm.monthly_orders)`, the `MAX − MIN` difference, and
  `r.region_id, r.region_name`). The dialect-clean, grader/benchmark-clean,
  relative-time, and frontmatter guards still pass.
- **Verification:** `analytics-skill-content` 9/9 and `setup-agents` 46/46 pass;
  production type-check (`tsconfig.json`, src) is clean; `pnpm run build` copied the
  updated skill into `dist/skills/analytics/SKILL.md` (6 fences, all new content
  present) and `pnpm -w run link:dev` re-linked `ktx-dev` so the playground picks it
  up. The skill is 244 lines (< 500 budget) and the frontmatter still parses as
  `ktx-analytics`.
- **Deviation (cosmetic):** the worked example uses alias `rm` and a difference
  column named `order_count_range`; the intake draft sketched alias `m` and
  `AS difference`. The spec leaves prose to the implementer, so the change is purely
  naming.
- **Unrelated pre-existing issue:** `tsconfig.test.json` reports one type error in
  `packages/cli/test/mcp-server-factory.test.ts` (a `KtxMcpContextPorts`/`contextTools`
  mismatch introduced by the earlier connection-scoped-wiki commit `2677b3ef`). It is
  untouched by this work and out of scope here.
