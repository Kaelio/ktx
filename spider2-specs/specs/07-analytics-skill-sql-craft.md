# Add universal SQL-authoring craft to the ktx-analytics skill

> Refined spec. Intake draft: `todo/07-analytics-skill-sql-craft.md`.

## Problem

The shipped `ktx-analytics` skill
(`packages/cli/src/skills/analytics/SKILL.md`) is an *orchestration* guide: its
`<workflow>` and `<rules>` tell the agent **which ktx tools to call and in what
order** (`discover_data` → `entity_details`/`sl_read_source` →
`sl_query`/`sql_execution` → validate → `memory_ingest`). It says almost nothing
about **writing correct SQL**.

That gap shows up as a specific failure shape: the agent reliably produces
*runnable* SQL but *wrong* results. The recurring defects are universal
analytics-engineering mistakes, not ktx-specific ones:

- comparing a string column to a numeric literal (or vice versa), which can
  silently match zero rows;
- rounding inside intermediate CTEs, so the final number is off;
- ranking/“first”/“most recent” windows with no deterministic tie-breaker, so
  results flicker run to run;
- filtering *before* a window function for sequence/“since”/“first” questions,
  truncating the partition the window should see;
- returning a full ranked list for a “top/highest” question, or collapsing a
  “per X” question to a single value;
- dropping the inputs (or the entity identifier) a derived value was built from.

These are correctness defects every ktx user hits on a live database. They
belong in the shipped skill — fixing them once improves ktx for everyone, rather
than living in any individual caller’s prompt.

## Generic use case

An analyst (human or agent) points ktx at a **live, production** database and
asks a real analytical question — “what’s the most recent order per customer”,
“top region by margin”, “average order value by month”. The schema is unfamiliar
(unknown date encodings, nullable join keys, string-typed numeric columns), the
question carries grain and ranking intent in its wording, and the answer must be
*correct and deterministic*, not merely executable. The skill should encode the
analytics-engineering craft that makes the difference between a query that runs
and a query that’s right — independent of any benchmark.

## Model

The change is **additive content in one Markdown file**, governed by these
invariants. They constrain the implementer; the exact prose is theirs.

### Inline-only delivery (this is a hard constraint, not a style preference)

All new guidance lives **inside `skills/analytics/SKILL.md`**. A bundled
`reference/*.md` file (the progressive-disclosure pattern Anthropic’s
skill-authoring guide recommends for large skills) **MUST NOT** be used here,
because the delivery mechanism ships only `SKILL.md`:

- `setup-agents.ts` installs the analytics skill via `readAnalyticsSkillContent()`,
  which reads **only** `./skills/analytics/SKILL.md` and writes a **single** file
  per target: `.claude/skills/ktx-analytics/SKILL.md` (Claude Code), the Codex /
  universal `.agents` equivalent, a **flattened** single rules file for Cursor
  (`.cursor/rules/ktx-analytics.mdc`) and OpenCode
  (`.opencode/commands/ktx-analytics.md`), and a Claude Desktop **zip that
  contains only `ktx-analytics/SKILL.md`** (`writeClaudeDesktopSkillBundle`).
- Nothing copies sibling files or subdirectories. A reference file would dangle
  on every target, and the Cursor/OpenCode flatten-to-one-file shape cannot
  represent a multi-file skill at all.

The skill is small enough that inline costs nothing meaningful: ~67 lines today
plus ~60 of craft is well under the 500-line budget. And this craft is **core
content** — consulted on every SQL-authoring turn — so even if multi-file delivery
existed it would still belong inline: progressive disclosure only pays off for
large, *conditionally-relevant* reference material loaded on demand, not for
always-needed craft.

Multi-file skill *delivery* is a legitimate future enhancement, but it must be
**pulled by a concrete need, not built ahead of one** — no shipped skill today
exceeds the budget (largest is ~346 lines) or uses a bundled reference. The first
real trigger is the **per-dialect SQL syntax follow-up**
(`todo/08-per-dialect-sql-syntax-notes.md`), whose load-on-demand
`reference/<dialect>.md` content is a genuine progressive-disclosure fit. When
that work is scoped, note that multi-file delivery is **not** a simple directory
copy: `setup-agents.ts` flattens the skill to a *single* file for Cursor
(`.mdc`) and OpenCode (`.md`), so those targets need a concatenation transform,
and uninstall needs per-file manifest entries. Recording the constraint here so a
future implementer does not “improve” this inline content into a bundled
reference that dangles on every target.

### Heuristics with a generic *why*, not a wall of MUSTs

The new rules are phrased as **heuristics with a one-line, universal rationale**,
because SQL authoring is a high-freedom task (many valid approaches, choice
depends on the question and the data). A bare imperative overfits; a rule plus
its *why* lets the model apply judgment and generalize. This follows Anthropic’s
own skill-authoring guidance (“if you find yourself writing ALWAYS/NEVER in all
caps or rigid structures, reframe and explain the reasoning”).

This **reconciles the draft’s “behavior only, no rationale” instruction**: the
prohibition is specifically on rationale that references a **grader, gold answer,
or the benchmark**. *Generic analytics-engineering rationale is required* — e.g.
“…so `RANK`/`ROW_NUMBER` results don’t flicker across runs”, “…a string-vs-number
compare can silently match nothing”. That is a universal truth, not a
grader reference.

### Dialect-agnostic

Every rule must read correctly on any SQL dialect a ktx connection might use.
**No dialect-specific syntax** — not `QUALIFY` (Snowflake/BigQuery/DuckDB only),
not `strftime`/`julianday` (sqlite), not backtick/`DB.SCHEMA.TABLE` FQTNs.
Per-dialect syntax notes are a **separate follow-up** living in a dialect-aware
(per-driver) location, explicitly out of scope here.

### Discovery craft attaches to discovery; authoring craft to query/validate

Two of the draft’s rules (inspect sample rows; cast before comparing) are
*schema-discovery* concerns that happen **before** SQL is composed. They belong
with the discovery steps of the existing workflow, not only at the query step.
The rest (composition, window correctness, precision, completeness) belong with
the query/validate steps. The draft’s “extend step 5/6” is the right home for
most rules but is slightly off for the discovery pair; this spec corrects that.

### Additive only

The existing `<workflow>`, `<rules>`, and `<examples>` — compact result tables,
summaries, clarification prompts, the tool-order workflow, the `connectionId`
scoping rules — are preserved unchanged. The skill must still read well for an
interactive, human-facing analysis session.

## Requirements

### 1. Placement and structure

Add a dedicated, scannable craft section to `SKILL.md`:

- A new top-level block — `<sql_craft>` (sibling to `<workflow>`/`<rules>`) — with
  **five sub-headings**: *Schema discovery*, *Composition*, *Window functions*,
  *Numeric precision*, *Answer completeness*. Sub-headings keep the block
  scannable (the draft’s “group under clear sub-headings” goal).
- **Pointers, not duplication.** Step 5 (“Query”) and step 6 (“Validate and
  explain”) each gain a **one-line pointer** into `<sql_craft>` rather than
  inlining the rules (state each rule once; Anthropic’s “consistent terminology /
  don’t repeat” guidance). The schema-discovery pair is additionally reflected as
  a brief cue in the discovery steps (step 2 “Inspect” / step 4 “Plan”), pointing
  to the same block.
- No new tool, flag, or config. This is content only.

### 2. The craft rules (all fourteen behaviors, grouped)

Every behavior from the intake draft must be represented. Tightly-related ones
**may** be merged into a single bullet where that reads better; none may be
dropped. Each carries a generic *why* (per Model). Dialect-agnostic throughout.

**Schema discovery** (cue in steps 2/4; lives in `<sql_craft>`)
1. Inspect representative **sample rows** of each table before composing SQL —
   confirm date/time encoding (`YYYYMMDD` vs ISO vs epoch), null prevalence in
   join/filter keys, and the real set of categorical/enum values
   (`entity_details` + a small `sql_execution` sample). *Why:* assumptions about
   encoding and nullability are the most common source of silently-wrong filters.
2. **Cast a column to its real type before comparing** it in `WHERE`/`JOIN`. A
   string column compared to a numeric literal (or vice versa) can silently match
   nothing.

**Composition**
3. Build complex queries **incrementally** — one CTE at a time, verifying each
   layer’s output on a small sample before stacking the next. *Why:* a wrong
   intermediate layer is far cheaper to catch early than to debug in the final
   result.
4. **Avoid fan-out joins.** Add columns only from tables already at the target
   grain, or **pre-aggregate** to that grain before joining. *Why:* a join that
   multiplies rows quietly inflates every downstream `SUM`/`COUNT`.

**Window functions**
5. Give every ranking/ordering window function a **complete, deterministic
   tie-breaker** (append unique key columns to `ORDER BY`), so
   `RANK`/`ROW_NUMBER`/`LAG` are stable rather than flickering across runs.
6. For sequence / “first” / “most recent” / “since” questions, **filter after the
   window**, not before: compute over the full partition, then keep the rows you
   want. *Why:* a pre-filter shrinks the partition the window ranks over, so
   “first”/“most recent” is computed against the wrong set. (See the worked
   example, requirement 3.)

**Numeric precision**
7. Compute at **full precision; round only in the final projection**, never inside
   intermediate CTEs.
8. Be **explicit about truncation** — `CAST AS INT` truncates; use explicit
   rounding when rounding is intended. (May merge with rule 7.)
9. Distinguish **macro vs micro averages** based on the question’s wording:
   “average of per-group averages” = `AVG(group_metric)`; “overall/weighted
   average” = `SUM(numerator)/SUM(denominator)`.

**Answer completeness / interpretation**
10. “top / highest / most / lowest” → return only the **winning row(s)** (keep the
    top-ranked row via the window result), not the full ranked list, unless a list
    is asked for. *(Phrase the mechanism dialect-agnostically — do not name
    `QUALIFY`.)*
11. “for each X / per X / by X” → **exactly one row per X**; don’t collapse to a
    single value unless the question says “overall” or “total across X”.
12. When a question asks for inputs and a derived value (“X, Y, and their ratio”),
    **include the inputs as columns** alongside the derived value.
13. When grouping by a human-readable label (a name), also **expose the entity’s
    identifier** — identity, not just the label, is part of the result (and
    disambiguates duplicate names).
14. When a result is **unexpectedly empty, relax filters one at a time** to find
    which predicate removed the rows. *Why:* this is the validation feedback loop
    that turns a silent empty result into a diagnosable one.

### 3. One worked example (dialect-agnostic)

Add **exactly one** compact before/after example to the skill, demonstrating the
**window-then-filter** rule (rule 6) — the subtlest and highest-value of the set.
It shows the wrong shape (filter inside, then rank) and the right shape (rank over
the full partition in a CTE, then filter to the top rank in the outer query),
using generic table/column names and standard SQL only (no `QUALIFY`, no
dialect functions). Keep it ~6–10 lines. Do not add a second example; the
existing three tool-orchestration examples stay as the primary example set.

### 4. Explicit exclusions

None of the following may appear in the skill (they are application/consumer
concerns, or actively wrong for live data):

- **Output-shape contracts** (“return a bare result set with exactly these
  columns, no prose”). The skill is for interactive analysis and already favors
  readable tables + summaries; a caller needing a strict shape specifies that
  itself.
- **Anchoring relative time to `MAX(date)` of the data.** On a live database
  “recent” / “past N months” means relative to *now*; `MAX(date)` anchoring is
  only valid for static snapshots and must not be baked into the product.
- **Any advice justified by a grader, gold answer, or scoring comparator.**
- **Dialect-specific syntax** (deferred to the per-driver follow-up).

### 5. Coordination with spec 03

`03-multi-connection-routing-in-analytics-skill` also edits this same file (it
adds a connection-routing “step 0” to `<workflow>` and threads `connectionId`
through the tool calls). Spec 07’s additions are **orthogonal**: they live in a
new `<sql_craft>` block and in step 5/6 pointers, and must not rewrite the
`<workflow>` routing or the `<rules>` `connectionId` scoping that spec 03 owns.
If both land, the result is one coherent skill: routing in `<workflow>`/`<rules>`,
SQL craft in `<sql_craft>`.

## Acceptance criteria

- The shipped `analytics/SKILL.md` contains all fourteen behaviors above, grouped
  under the five sub-headings, each phrased as a heuristic with a generic
  rationale.
- **Zero references** to any benchmark, gold answer, grader, or scoring
  comparator anywhere in the skill.
- **Dialect-agnostic:** the skill contains no `QUALIFY`, no `strftime`/`julianday`,
  no backtick/`DB.SCHEMA.TABLE` FQTN syntax, and no other single-dialect
  construct — including in the worked example.
- The existing interactive guidance is intact: the `<workflow>` steps, the
  `<rules>` (compact tables, summaries, clarification prompt, `connectionId`
  scoping), and the three existing examples all still read correctly and were not
  removed or contradicted.
- **None of the excluded items** (output-shape contract, `MAX(date)` anchoring of
  “recent”, grader-driven advice, dialect syntax) appear.
- Exactly **one** new worked example is present, demonstrating window-then-filter,
  in standard dialect-agnostic SQL.
- The craft is **inline in `SKILL.md`** — no bundled reference file is introduced,
  and the skill still installs as a single file through `setup-agents.ts` for all
  targets (Claude Code, Codex, Cursor, OpenCode, universal, Claude Desktop zip).
- The skill stays **scannable and within a reasonable size** (comfortably under
  the 500-line budget).
- The frontmatter (`name`, `description`) is unchanged and still parses through
  `SkillsRegistryService.parseFrontmatter`.

## Implementation orientation

Line numbers drift; treat these as anchors, not addresses. The implementer owns
the prose.

- **The skill file:** `packages/cli/src/skills/analytics/SKILL.md`. Add the
  `<sql_craft>` block; add one-line pointers in steps 5/6 and a discovery cue in
  steps 2/4; add the single worked example. Keep `<workflow>`/`<rules>`/`<examples>`
  otherwise intact.
- **Delivery (why inline is mandatory):** `packages/cli/src/setup-agents.ts`
  (`readAnalyticsSkillContent`, `installTarget`, `writeClaudeDesktopSkillBundle`,
  `plannedKtxAgentFiles`). Each target gets a single file derived from
  `SKILL.md`; Cursor/OpenCode flatten to one rules file; Claude Desktop zips only
  `ktx-analytics/SKILL.md`. No change to `setup-agents.ts` is required by this
  spec — confirm the skill still installs unchanged.
- **Coordination:** `03-multi-connection-routing-in-analytics-skill` edits the
  same file; keep the changes non-overlapping (see requirement 5).
- **Tests:** a content assertion over the shipped `analytics/SKILL.md` is the
  right level (this is prompt content, not executable logic). Assert the skill
  text contains the craft sub-headings / representative rule phrases, contains the
  worked example, and contains none of the banned constructs: the literal tokens
  `QUALIFY`/`strftime`/`julianday`, grader/benchmark words (`spider`, `benchmark`,
  `gold`, `grader`), and — checked as a phrase, not a raw `MAX(` grep, since
  `MAX()` is a legitimate aggregate — any instruction anchoring relative time
  (“recent”, “past N months”) to the data’s maximum date. The existing
  `SkillsRegistryService` frontmatter-parse test must still pass. The standalone
  `ktx-dev` binary should be rebuilt/re-linked (`pnpm run build && pnpm run
  link:dev`) so the playground picks up the updated skill.

## Benchmark context (motivation only)

On the Spider 2.0-Lite sqlite subset the solver produced **0 execution errors but
~50 result mismatches**, and a large share traced to exactly these gaps:
premature rounding, string-vs-number compares, non-deterministic window ordering,
returning full lists for “top” questions, and dropping the inputs to derived
values. These are generic SQL-authoring defects — fixing them in the skill
improves ktx for every user querying a live database, and improving the benchmark
score is a side effect, not the goal. The skill itself must contain no trace of
the benchmark.

## Implementation notes

Implemented on branch `write-feature-spec-wiki`.

**What was built**
- Added a new `<sql_craft>` block to `packages/cli/src/skills/analytics/SKILL.md`
  (sibling to `<workflow>`/`<rules>`, placed just before `<examples>`), with the
  five sub-headings — *Schema discovery before writing SQL*, *Composition*,
  *Window functions*, *Numeric precision*, *Answer completeness / interpretation* —
  and a one-line opener framing the bullets as heuristics-with-a-why.
- All fourteen behaviors are represented. Rules 7 and 8 (round-at-the-end /
  truncation) are merged into one "Round only at the end" bullet, as the spec
  permitted. Each bullet carries a generic analytics-engineering rationale; none
  references a benchmark, grader, or gold answer.
- Exactly one worked example (a fenced `sql` block inside `<sql_craft>`)
  demonstrates the window-then-filter rule, and incidentally the deterministic
  tie-breaker: the *wrong* shape filters before the window; the *right* shape
  ranks the full partition in a CTE, then filters in the outer query. Standard
  SQL only — no `QUALIFY`, no dialect functions.
- Step pointers added without duplicating the rules: a schema-discovery cue in
  steps 2 and 4, an authoring pointer in step 5, and a validation pointer in
  step 6, each pointing into `<sql_craft>`.
- The existing `<workflow>` / `<rules>` / `<examples>` (compact tables,
  summaries, clarification prompt, `connectionId` scoping, the three
  orchestration examples) are unchanged. Delivery is unchanged: still a single
  `SKILL.md` per target via `readAnalyticsSkillContent`; no bundled `reference/`
  file was introduced.

**Tests** — added `packages/cli/test/skills/analytics-skill-content.test.ts`, a
content assertion over the source `SKILL.md`: the five sub-headings, a
representative phrase for each behavior, exactly one `sql` worked example, the
preserved interactive guidance, and the absence of banned constructs
(`QUALIFY` / `strftime` / `julianday`, `spider` / `benchmark` / `gold` /
`grader`, a backtick three-part FQTN, and a phrase-level guard against anchoring
relative time to a `MAX(...)` date). The existing `setup-agents.test.ts` content
assertions and the `SkillsRegistryService` frontmatter test still pass (77/77
across the three relevant files). Rebuilt and re-linked `ktx-dev`
(`pnpm run build && pnpm run link:dev`); the craft block is present in the
shipped `dist` asset.

**Deviations / notes**
- The worked example runs ~18 lines including comments rather than the spec's
  "~6–10"; a faithful before/after with a CTE needs the extra lines, and the
  skill stays well within budget (~117 lines total).
- `pnpm run type-check` currently reports one **pre-existing, unrelated** error
  in `test/mcp-server-factory.test.ts` (MCP server deps typing), committed on
  this branch ahead of `origin/main`. The src type-check and `pnpm run build`
  are green; this change does not touch any MCP file.
- Per-dialect SQL syntax stays out of scope here (deferred to
  `todo/08-per-dialect-sql-syntax-notes.md`), so the skill remains
  dialect-agnostic. No dialect-tool pointer was added to `SKILL.md` yet — that
  belongs with spec 08's channel so the skill never references a tool that does
  not exist.
