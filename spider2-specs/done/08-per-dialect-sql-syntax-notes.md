# Per-dialect SQL syntax notes (dialect-aware, scoped to the connection)

> Intake draft. Companion to `specs/07-analytics-skill-sql-craft.md`, which kept
> the analytics SQL craft dialect-agnostic and explicitly deferred per-dialect
> syntax here.

## Problem

Spec 07 deliberately keeps the analytics SQL-authoring craft
**dialect-agnostic** — every rule must read correctly on any engine. But a lot of
*real* correctness depends on dialect-specific syntax that spec 07 excludes and
defers to this follow-up:

- **Snowflake:** `DB.SCHEMA.TABLE` FQTNs, double-quoted lowercase identifiers,
  VARIANT colon-paths.
- **BigQuery:** backtick FQTNs, `_TABLE_SUFFIX` for sharded tables, `QUALIFY`.
- **sqlite:** `strftime`/`julianday` for dates, no `QUALIFY`.

This guidance is genuinely useful to an agent writing SQL against a live
database, but it must **not** pollute the flat dialect-agnostic skill — an agent
querying sqlite should never see Snowflake VARIANT syntax. It belongs in a
**dialect-aware** location, surfaced only for the dialect the active connection
actually uses.

## Generic use case

Any ktx project whose connections span more than one warehouse engine (e.g. a
Snowflake warehouse + a BigQuery export + a local sqlite extract). When the agent
writes SQL for a given connection, it should get that engine's syntax
conventions — and nothing for the engines it isn't querying.

## Requirements

1. **Per-driver dialect notes.** Author concise, correct syntax notes per
   supported driver: FQTN form, identifier quoting/case, date/time functions,
   top-N / window-filtering idiom, semi-structured access. These are genuine
   per-engine invariants, so enumerating them per driver is acceptable (unlike a
   denylist of bad specifics).
2. **Scope to the active dialect, derived from state.** Which notes the agent
   sees must be selected from the connection's configured driver/dialect
   (`ktx.yaml` connections / the connector registry), not guessed and not shown
   all at once. The flat analytics skill stays dialect-agnostic (spec 07
   invariant preserved).
3. **Delivery mechanism (enabling sub-requirement).** The shipped skill is
   installed as a **single `SKILL.md`** per target (`setup-agents.ts` /
   `readAnalyticsSkillContent`). Surfacing per-dialect notes on demand needs one
   of two approaches; the refinement pass should compare them before committing:
   - **Multi-file skill delivery** — bundle `reference/<dialect>.md` files and
     have the skill point to the one matching the connection. Requires extending
     `setup-agents.ts` to copy a skill *directory* (Claude Code, Codex, universal
     `.agents`) and a multi-file zip (Claude Desktop), a **flatten/concatenate
     transform** for the single-file targets (Cursor `.mdc`, OpenCode `.md`), and
     **per-file manifest entries** for clean uninstall. This is the
     install-mechanism improvement spec 07's Model section flags as future work.
   - **Dynamic MCP delivery** — an MCP surface returns the dialect hints for a
     given `connectionId` (the MCP layer already resolves the connection's
     dialect), so no install change is needed and Cursor/OpenCode get identical
     behavior. May be the lower-cost, more uniform path; weigh it first.
4. **No dialect syntax leaks into the dialect-agnostic skill.** Spec 07's
   acceptance criterion (no `QUALIFY`/`strftime`/`julianday`/backtick-FQTN/etc. in
   `analytics/SKILL.md`) stays green. This work adds a *separate* dialect-aware
   channel; it does not amend the flat skill.

## Acceptance criteria

- An agent querying a sqlite connection gets sqlite date idioms and never sees
  Snowflake/BigQuery-only syntax; an agent querying Snowflake gets
  FQTN/identifier/VARIANT guidance.
- The dialect shown is **derived from the connection's configured driver**, not
  hardcoded per project and not guessed.
- `analytics/SKILL.md` remains dialect-agnostic — spec 07's criteria are
  unaffected.
- Whichever delivery mechanism is chosen installs/serves correctly across **all**
  supported agent targets, including the single-file Cursor/OpenCode shape.

## Benchmark context (motivation only)

The Spider 2.0-Lite v9 harnesses' only per-dialect content was Snowflake
(`DB.SCHEMA.TABLE` FQTNs, double-quoted lowercase cols, VARIANT colon-paths),
BigQuery (backtick FQTNs, `_TABLE_SUFFIX` for sharded tables), and sqlite
(`strftime`/`julianday`). That content is real and useful but engine-specific;
spec 07 kept it out of the flat skill and deferred it here so the
dialect-agnostic rules stay clean.
