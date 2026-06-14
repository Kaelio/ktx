# Per-dialect SQL syntax notes, served on demand and scoped to the connection

> Refined spec. Intake draft: `todo/08-per-dialect-sql-syntax-notes.md`. Companion
> to `specs/07-analytics-skill-sql-craft.md`, which kept the analytics SQL craft
> dialect-agnostic and explicitly deferred per-dialect syntax to this spec.

## Problem

Spec 07 added universal, **dialect-agnostic** SQL-authoring craft to the
`ktx-analytics` skill (`packages/cli/src/skills/analytics/SKILL.md`). That craft
deliberately excludes anything that reads correctly on only one engine — no
`QUALIFY`, no `strftime`/`julianday`, no backtick or `DB.SCHEMA.TABLE` FQTNs —
because the flat skill is installed verbatim and an agent querying sqlite must
never see Snowflake syntax.

But a large share of *real* correctness depends on exactly that excluded,
engine-specific syntax:

- **Snowflake:** `DATABASE.SCHEMA.TABLE` FQTNs, double-quoted case-sensitive
  identifiers (unquoted folds to upper-case), VARIANT colon-paths
  (`col:field.sub::type`), `QUALIFY`.
- **BigQuery:** backtick FQTNs (`` `project.dataset.table` ``), `_TABLE_SUFFIX`
  for sharded/wildcard tables, `QUALIFY`, `JSON_VALUE`/`JSON_EXTRACT`.
- **sqlite:** `strftime`/`julianday`/`date()` for dates, no `QUALIFY`,
  `json_extract`.
- and the remaining supported engines (`postgres`, `mysql`, `clickhouse`,
  `sqlserver`/`tsql`), each with its own FQTN, quoting, date, top-N, and
  JSON conventions.

This guidance is genuinely useful to an agent writing SQL against a live
database, but it must **not** pollute the flat dialect-agnostic skill. It belongs
in a **dialect-aware** channel, surfaced only for the dialect the active
connection actually uses, and selected from the project's own configured state —
not guessed, not shown all at once.

## Generic use case

Any **ktx** project whose connections span more than one warehouse engine — a
Snowflake warehouse plus a BigQuery export plus a local sqlite extract, say. When
the agent (or a human analyst the agent assists) writes SQL for a given
connection, it should receive *that engine's* syntax conventions — FQTN form,
identifier quoting, date functions, top-N idiom, semi-structured access — and
nothing for the engines it is not querying. The need is independent of any
benchmark: it is what "write correct SQL against this specific warehouse" requires
on every multi-engine stack.

## Model

The change adds a **dialect-aware channel** alongside spec 07's flat skill. The
following decisions are committed by this refinement; the implementer owns the
exact prose and code.

### Delivery: a dynamic MCP tool (decision committed)

The draft posed two delivery mechanisms and asked the refinement to "weigh them
before committing." This spec commits to **dynamic MCP delivery**: a new
read-only MCP tool returns the syntax notes for a given `connectionId`, with the
dialect resolved server-side from the connection's configured `driver`. The flat
skill gains a one-line pointer to that tool. **No install-mechanism change is
required.**

The alternative — **multi-file skill delivery** (bundle `reference/<dialect>.md`
files and point the skill at the matching one) — is **rejected** for **ktx**, for
reasons that hold regardless of how the skill is otherwise authored:

1. **It cannot scope on two of the six install targets.** Cursor
   (`.cursor/rules/ktx-analytics.mdc`) and OpenCode
   (`.opencode/commands/ktx-analytics.md`) are physically **single-file**;
   `setup-agents.ts` flattens the skill to one file there. A bundled `reference/`
   directory degenerates to "concatenate every dialect into one file," so a
   sqlite agent would see Snowflake VARIANT syntax — **failing this spec's core
   no-leak criterion on those targets**, and defeating progressive disclosure
   (everything is in context at once). The MCP tool behaves **identically on all
   six targets** because it is a tool call, not an installed file.
2. **Selecting the dialect is a deterministic operation, so it belongs in code,
   not model judgment.** Anthropic's skill-authoring guidance explicitly says to
   *"prefer scripts [tools] for deterministic operations."* With bundled files the
   **model** must infer that connection X is Snowflake and open the right file —
   and on a multi-connection project it can open the wrong one. With the tool, the
   **server** resolves `driver → dialect` from `ktx.yaml` state and returns
   exactly the right notes.
3. **It needs a delivery subsystem that the tool does not.** Multi-file delivery
   requires reworking `readAnalyticsSkillContent`, `installTarget`,
   `plannedKtxAgentFiles`, the install manifest (a directory variant),
   `removeKtxAgentInstall`, and `writeClaudeDesktopSkillBundle`, plus a
   concatenation transform for the single-file targets. The MCP tool requires one
   read-only handler and one skill pointer.
4. **The dependency is free.** The `ktx-analytics` skill already hard-depends on
   the **ktx** MCP server — its entire workflow is calling `discover_data`,
   `entity_details`, `sql_execution`, and so on. Wherever the server is down, the
   skill is already non-functional; the tool adds **no new dependency**.
5. **Dropping Cursor/OpenCode does not change this.** Removing those targets would
   make multi-file delivery *possible*, but it would not make it better: reasons
   2–4 stand, and the drop is a disproportionate cost (Cursor is a major target)
   to neutralize a constraint the tool handles for free. Whether **ktx** supports
   those targets is a separate product decision and is out of scope here.

This is consistent with Anthropic's progressive-disclosure goal — load the
relevant material on demand, at zero context cost until needed — which the tool
satisfies (its output costs context only when called) while resolving *which*
dialect from state rather than from a model guess. Reference:
[Skill authoring best practices](https://platform.claude.com/docs/en/agents-and-tools/agent-skills/best-practices).

### Scope derived from state, through the one existing resolver

Which dialect's notes the agent sees is **derived** from the connection's
configured `driver`, via the resolver the rest of the system already uses —
`sqlAnalysisDialectForDriver(driver)` in
`packages/cli/src/context/sql-analysis/dialect.ts`. The same function already
selects the dialect for `sql_execution`, `sl_query`, and the Python SQL-analysis
daemon. This spec **must not** introduce a second driver→dialect map. The notes
are **keyed by the resolved `SqlAnalysisDialect`** (so the SQL Server entry is
keyed `tsql`, not `sqlserver`), tying the note key-space to the resolver's
codomain so the two cannot drift.

### Authored per-engine notes are sanctioned static content

Enumerating syntax notes per engine is **not** a rotting denylist of bad
specifics; FQTN form and identifier quoting are genuine, stable invariants of each
engine — the kind of universal fact **ktx**'s design rules explicitly permit as
static content. What must stay derived-from-state is note *selection* (the active
dialect) and note *coverage* (every configured driver must resolve to notes that
exist), both of which this spec ties to the connector registry.

### The flat skill stays dialect-agnostic (spec 07 invariant preserved)

This work adds a *separate* channel. It does **not** amend spec 07's `<sql_craft>`
block or inline any dialect syntax into `SKILL.md`. Spec 07's acceptance criterion
— no `QUALIFY`/`strftime`/`julianday`/backtick-FQTN/etc. in the flat skill — stays
green. The only `SKILL.md` change is the pointer in requirement 3, which names the
tool and contains no dialect syntax.

## Requirements

### 1. A read-only `sql_dialect_notes` MCP tool

Register a new tool beside the existing context tools
(`packages/cli/src/context/mcp/context-tools.ts`). The tool name is the
implementer's to finalize but should follow the existing snake_case convention
(`entity_details`, `sql_execution`); `sql_dialect_notes` is the suggested name.

- **Input:** `{ connectionId }`, **required** — matching its siblings
  `entity_details`/`sql_execution`, which always take an explicit connection.
- **Output:** `{ connectionId, dialect, notes }` where `dialect` is the resolved
  `SqlAnalysisDialect` and `notes` is the markdown guidance for that dialect.
- **Resolution:** `connectionId → connection.driver →
  sqlAnalysisDialectForDriver(driver) → notes[dialect]`, reusing the existing
  resolver. Do not duplicate the driver→dialect map.
- **Guards:**
  - A **non-SQL context-source** connection (driver `metabase`, `looker`,
    `lookml`, `notion`, `dbt`, `metricflow`) returns a **clear "not a SQL
    warehouse connection" error**, not postgres notes. Gate on the existing
    `isDatabaseDriver()` (`packages/cli/src/connection-drivers.ts`).
  - For any **SQL warehouse** connection the resolver always yields a dialect with
    notes (all seven warehouse drivers are covered — requirement 2); its built-in
    `postgres` default is a safety floor, so the tool never errors for a SQL
    connection and never emits a single-engine dialect (e.g. Snowflake) by
    accident.
- **Annotations:** read-only and idempotent, consistent with the other read
  tools.
- **Description (docs-grade, third person, states what and when):** e.g.
  *"Returns the SQL syntax conventions for a connection's dialect — FQTN form,
  identifier quoting and case-folding, date/time functions, top-N idiom, and
  semi-structured access. Use before authoring raw SQL against a connection so the
  SQL matches that engine."* The description drives the agent's decision to call
  the tool, so it must be specific.

### 2. Per-dialect note content

Author concise notes for each supported dialect against a **fixed rubric**, so
every dialect answers the same questions. Each facet is a line or two of timeless,
engine-true convention (no version-dated "as of vX" content), phrased as
guidance with the engine reason where it helps — inheriting spec 07's
heuristics-with-a-why tone. The rubric facets:

1. **FQTN form** — how to fully-qualify a table on this engine.
2. **Identifier quoting & case-folding** — quote character and how unquoted
   identifiers fold.
3. **Date/time** — the engine's date functions and common date-encoding idioms.
4. **Top-N / window-filtering idiom** — `QUALIFY` where supported; a CTE +
   outer-filter form where it is not; `TOP` for `tsql`.
5. **Semi-structured / JSON access** — VARIANT colon-paths, `JSON_VALUE`/
   `JSON_EXTRACT`, `->`/`->>`, `json_extract`, as applicable.
6. **Sharded / partition idiom** where the engine has one (e.g. BigQuery
   `_TABLE_SUFFIX`).

Constraints on the content:

- **Coverage = the reachable dialect set.** Every driver in the connector registry
  must resolve to a dialect that has non-empty notes. The reachable set is
  `postgres`, `mysql`, `snowflake`, `bigquery`, `sqlite`, `clickhouse`, and
  `tsql` (from `sqlserver`). Do **not** author notes for `duckdb`/`databricks`:
  they appear in the resolver map but no connector can produce them, so they are
  unreachable — matching the draft's "don't author for nonexistent drivers."
- **Keyed by `SqlAnalysisDialect`** (see Model).
- **Storage is the implementer's choice.** The notes MAY live as per-dialect
  markdown files inside the package (e.g. under the skill's directory) served by
  the tool, or as a typed map. If files are used they are **package-internal** —
  served by the tool, never installed onto an agent target — and already ship via
  the recursive `src/skills → dist/skills` copy
  (`packages/cli/scripts/copy-runtime-assets.mjs`); no `setup-agents.ts` change.
- **No benchmark, gold-answer, grader, or scoring references** anywhere in the
  notes.

The implementer must verify each engine's specifics against current official
documentation (the well-known anchors above are starting points, not a
substitute for checking the engine's docs).

### 3. The `SKILL.md` pointer (completes spec 07's deferral)

Add a **single one-line pointer** to the SQL-authoring step (step 4 "Plan" / step
5 "Query") of `packages/cli/src/skills/analytics/SKILL.md`, directing the agent to
call the tool before writing raw SQL against a connection — e.g. *"Before writing
raw `sql_execution` SQL, call `sql_dialect_notes` with the connection's id to get
that engine's syntax conventions."* This is the pointer spec 07 deliberately did
not add because the tool did not yet exist.

- The pointer **names the tool only**; it contains **no dialect syntax**, so the
  flat skill stays dialect-agnostic.
- Follow the skill's existing tool-reference convention. The skill currently names
  MCP tools by **bare** name (`discover_data`, `sql_execution`). Anthropic's
  guidance recommends **fully-qualified** `ServerName:tool` names to avoid
  "tool not found" when multiple MCP servers are present. Whether to fully-qualify
  the new pointer (and optionally retrofit the existing bare references) is a
  small, separable decision flagged for the maintainer — **not** a rename sweep
  this spec mandates.

### 4. Coverage is enforced from state, not by hand

A test must **derive** the required coverage from the connector registry rather
than hardcoding a dialect list: enumerate the configured warehouse drivers
(`warehouseDrivers` in `driver-schemas.ts` / `KTX_DATABASE_DRIVER_IDS` in
`connection-drivers.ts`), resolve each through `sqlAnalysisDialectForDriver`, and
assert each result has non-empty notes. Adding a connector later then **fails this
test** until its dialect gets notes — the allowlist-from-state discipline, not a
hand-maintained list.

### 5. No dialect syntax leaks into the flat skill

Spec 07's content assertion over `analytics/SKILL.md` stays green: the flat skill
(and its worked example) still contain no `QUALIFY`, `strftime`, `julianday`,
backtick/`DB.SCHEMA.TABLE` FQTN, or other single-engine construct. This spec adds
a tool and a tool-pointer; it does not move dialect syntax into the skill.

### 6. Delivery is unchanged

`setup-agents.ts` (`readAnalyticsSkillContent`, `installTarget`,
`writeClaudeDesktopSkillBundle`, `plannedKtxAgentFiles`) needs **no change**. The
skill still installs as a single `SKILL.md` per target. Confirm the channel works
on all six targets — Claude Code, Claude Desktop (zip), Codex, universal
`.agents`, Cursor (`.mdc`), OpenCode (`.md`) — by virtue of being a tool call,
including the single-file targets where multi-file delivery could not scope.

### 7. Coordination with specs 07 and 03

- **Spec 07** owns the dialect-agnostic `<sql_craft>` block. This spec must not
  amend it; it adds the tool, the pointer, and the notes.
- **Spec 03** (`03-multi-connection-routing-in-analytics-skill`) threads
  `connectionId` through the skill's tool calls. The `sql_dialect_notes` pointer
  is `connectionId`-scoped and fits that routing; keep the pointer consistent with
  spec 03's `connectionId` rules and do not rewrite the routing it owns.

## Acceptance criteria

- An agent querying a **sqlite** connection gets sqlite date idioms and **never**
  sees Snowflake/BigQuery-only syntax; an agent querying **Snowflake** gets
  FQTN / identifier / VARIANT guidance.
- The dialect shown is **derived from the connection's configured `driver`** via
  the existing `sqlAnalysisDialectForDriver`, not hardcoded per project and not
  guessed. No second driver→dialect map is introduced.
- **Every configured warehouse driver** (`postgres`, `mysql`, `snowflake`,
  `bigquery`, `sqlite`, `clickhouse`, `sqlserver`) resolves to a dialect with
  non-empty notes, and the coverage test derives this from the registry.
- A **non-SQL context-source** connection (e.g. `metabase`, `notion`) yields a
  clear "not a SQL warehouse" response, **not** postgres notes.
- `analytics/SKILL.md` remains dialect-agnostic — spec 07's criteria are
  unaffected. The new pointer references the tool only and adds no dialect syntax.
- The channel installs/serves correctly across **all six** agent targets,
  including the single-file Cursor/OpenCode shape, with **no `setup-agents.ts`
  change**.
- The notes contain **no** benchmark/gold/grader/scoring references and **no**
  time-sensitive ("as of version X") content.

## Implementation orientation

Line numbers drift; treat these as anchors, not addresses. The implementer owns
the design.

- **Dialect resolver (reuse, do not duplicate):**
  `packages/cli/src/context/sql-analysis/dialect.ts` —
  `sqlAnalysisDialectForDriver(driver)`, returning `SqlAnalysisDialect`
  (`./ports.ts`), default `postgres`.
- **Connector registry (drives coverage):**
  `packages/cli/src/connection-drivers.ts` (`KTX_DATABASE_DRIVER_IDS`,
  `isDatabaseDriver`) and `packages/cli/src/context/project/driver-schemas.ts`
  (`warehouseDrivers`, the per-driver `connectionConfigSchema`).
- **MCP tool registration:** `packages/cli/src/context/mcp/context-tools.ts`
  (register beside `connection_list`, `entity_details`, `sql_execution`); the
  `connectionId → driver → dialect` resolution already exists for `sql_execution`
  in `packages/cli/src/context/mcp/local-project-ports.ts` — route the new tool
  through the same path.
- **The skill (one-line pointer only):**
  `packages/cli/src/skills/analytics/SKILL.md` — add the tool pointer in step 4/5;
  leave `<workflow>`/`<rules>`/`<sql_craft>`/`<examples>` otherwise intact.
- **Note storage (if files):** under the skill directory, shipped by
  `packages/cli/scripts/copy-runtime-assets.mjs`'s recursive copy; served by the
  tool, never installed.
- **Delivery (confirm unchanged):** `packages/cli/src/setup-agents.ts`.
- **Tests:** unit tests for resolution (including `sqlserver → tsql`, unknown →
  `postgres`, and non-warehouse rejection); a registry-derived coverage test
  (requirement 4); a content test that each dialect's notes cover the rubric
  facets and contain no banned tokens; and an extension of spec 07's
  `analytics/SKILL.md` content test asserting the new pointer is present and the
  flat skill is still dialect-clean. Rebuild and re-link the dev binary so the
  playground picks up the change: `pnpm run build && pnpm run link:dev`.

## Benchmark context (motivation only)

The Spider 2.0-Lite v9 harnesses' only per-dialect content was Snowflake
(`DB.SCHEMA.TABLE` FQTNs, double-quoted lower-case columns, VARIANT colon-paths),
BigQuery (backtick FQTNs, `_TABLE_SUFFIX` for sharded tables), and sqlite
(`strftime`/`julianday`). That content is real and useful but engine-specific;
spec 07 kept it out of the flat skill and deferred it here so the dialect-agnostic
rules stay clean. Delivering it through a dialect-scoped **ktx** tool generalizes
the same correctness benefit to every multi-engine **ktx** project — improving the
benchmark score is a side effect, not the goal, and the shipped skill contains no
trace of the benchmark.

## Implementation notes

Implemented on branch `write-feature-spec-wiki`, alongside spec 07. The committed
decision (dynamic MCP delivery, not multi-file skill bundling) was implemented as
specified — no `setup-agents.ts` change.

**What was built**
- Per-dialect notes are markdown files under
  `packages/cli/src/context/sql-analysis/dialects/<dialect>.md` (one each for
  `postgres`, `mysql`, `snowflake`, `bigquery`, `sqlite`, `clickhouse`, `tsql`),
  served by `sqlDialectNotes(dialect)` in `sql-analysis/dialect-notes.ts` (lazy
  read + cache, `postgres` fallback floor; the authored set is the
  `DIALECTS_WITH_NOTES` const). `duckdb`/`databricks` are intentionally unauthored
  (unreachable from any connector). Each note answers the fixed rubric — FQTN,
  identifier quoting/case-folding, date/time, top-N/window idiom,
  JSON/semi-structured, plus a sharded-table line for BigQuery. Engine specifics
  were verified against current docs via Context7 (Snowflake VARIANT colon-paths
  and unquoted→UPPER case-folding; BigQuery `_TABLE_SUFFIX`, `QUALIFY`,
  `JSON_VALUE`; ClickHouse `LIMIT n BY` and `JSONExtract*`, with no `QUALIFY`). The
  files are package-internal — `copy-runtime-assets.mjs` ships them to `dist`; they
  are never installed onto an agent target.
- New read-only MCP tool `sql_dialect_notes` (`context-tools.ts`): input
  `{ connectionId }` (required), output `{ connectionId, dialect, notes }`, read-only
  + idempotent annotations. It resolves through the **existing**
  `connectionId → connection.driver → sqlAnalysisDialectForDriver` path (no second
  driver→dialect map), implemented as the unconditional `dialectNotes` port in
  `local-project-ports.ts` via an extracted `resolveDialectNotesForConnection`. A
  non-SQL context source (gated by `isDatabaseDriver`) throws `KtxExpectedError`
  ("not a SQL warehouse"), not postgres notes — so the expected agent mistake stays
  out of Error Tracking.
- `connection-drivers.ts`: `KTX_DATABASE_DRIVER_IDS` is now an exported (`@internal`)
  readonly tuple so the coverage test derives required coverage from the registry;
  `isDatabaseDriver` behavior is unchanged.
- `skills/analytics/SKILL.md`: a single dialect-agnostic pointer in step 5 ("call
  `sql_dialect_notes` … to get that engine's FQTN, identifier-quoting, date, top-N,
  and JSON conventions"). It names the tool only; spec 07's `<sql_craft>` block and
  its dialect-clean content test are untouched.

**Tests**
- `test/context/mcp/dialect-notes.test.ts`: registry-derived coverage (a future
  connector fails the test until its dialect has notes), the full rubric per dialect,
  leak isolation (sqlite shows `strftime` and never `VARIANT`/`_TABLE_SUFFIX`;
  `QUALIFY` only on snowflake/bigquery; engine-exclusive markers stay put), no
  benchmark/grader or version-dated content, the postgres fallback, and
  `resolveDialectNotesForConnection` resolving sqlite / snowflake / `sqlserver→tsql`
  and rejecting a non-SQL source / unknown connection with `KtxExpectedError`; plus a
  guard that the `DIALECTS_WITH_NOTES` const and the `dialects/*.md` files stay in sync.
- `test/context/mcp/server.test.ts`: `sql_dialect_notes` added to the retained tool
  set + annotations assertion + a handler-routing test, and the regenerated
  `__snapshots__/mcp-tools-list.json`.
- `test/skills/analytics-skill-content.test.ts`: asserts the new pointer is present
  and the flat skill stays dialect-clean.

**Verification** — `tsc -p tsconfig.json` (src) clean; full default suite 393 files /
3001 passing; slow suite green (incl. `local-project-ports.test.ts`); all three
`dead-code` checks clean; the `dialects/*.md` files copy into `dist`. Rebuilt and
re-linked `ktx-dev`.

**Deviations / notes**
- Notes are stored as per-dialect markdown files (not a typed map, and not bundled
  `reference/*.md` skill files) — all sanctioned by the spec; plain markdown is the
  most maintainable to edit. They are served by the tool and ship via a
  `copy-runtime-assets.mjs` entry (`src/context/sql-analysis/dialects → dist/…`); no
  `setup-agents.ts` change.
- `pnpm run type-check` still reports one pre-existing, unrelated error in
  `test/mcp-server-factory.test.ts` (committed in-flight MCP work on this branch);
  this change adds zero new type errors and does not touch that file.
