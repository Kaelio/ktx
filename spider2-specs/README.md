# spider2-specs — feature specs driven by the Spider 2.0-Lite benchmark

This directory is the handoff point between two agents working on different
sides of the same goal: making Claude Code + ktx score well on the Spider
2.0-Lite benchmark **without benchmark-specific instructions** — the agent
should succeed using only what ktx provides (skills, semantic layer, wiki).

## Mechanics

Three directories form a pipeline. A feature flows `todo/` → `specs/` →
(implemented), and only its intake draft moves to `done/`:

- **`todo/`** — intake drafts. A **playground agent** (works in
  `/Users/andrey/projects/kaelio/spider-clean-submission/playground`, runs the
  benchmark, identifies ktx capability gaps) writes a draft spec here when it
  finds a gap.
- **`specs/`** — refined specs. A **refinement pass** (brainstorming) takes a
  `todo/` draft and produces a proper, implementation-ready spec at
  `specs/<same-filename>.md`: sharpened requirements, resolved ambiguities,
  acceptance criteria, and orientation hints. The refined spec is the **durable
  artifact** the implementer builds from — it stays in `specs/` permanently and
  never moves.
- **`done/`** — intake drafts whose feature has shipped (see below).

The **ktx worktree agent** (started from a ktx repo worktree, e.g.
`/Users/andrey/conductor/workspaces/ktx/tallinn-v2`) implements from the
refined spec in `specs/` (falling back to the `todo/` draft only if no refined
spec exists yet). When the feature is implemented it:

1. appends a short **"Implementation notes"** section to the refined spec in
   `specs/` (what was built, where, any deviations); and
2. **moves the original intake draft from `todo/` to `done/`.**

Location is status: `todo/` = draft awaiting implementation, `done/` = draft
whose feature shipped, `specs/` = refined specs (permanent home, do not move).
A draft and its refined spec share the same filename so they correspond
(`todo/01-foo.md` ↔ `specs/01-foo.md` ↔ `done/01-foo.md`). No other tracking.

## Rules for specs

1. **Generic, not benchmark-overfit.** ktx is a general-purpose product; the
   benchmark only surfaces the need. Every spec must state a real-world use
   case independent of Spider 2.0-Lite. If a requirement only makes sense for
   the benchmark, it doesn't belong in ktx.
2. Specs are **requirement-level**, not implementation plans. Code pointers in
   specs are orientation hints from exploration (line numbers may have
   drifted); the implementer owns the design.
3. One spec per file, kebab-case, numeric prefix = suggested priority order.
   A refined spec in `specs/` keeps the same filename as its `todo/` draft.

## For the implementer

- After implementing, rebuild and re-link the dev binary so the playground
  picks it up: `pnpm run build && pnpm run link:dev` (provides `ktx-dev`).
- Add/extend tests in the ktx test suites; specs list acceptance criteria to
  cover.
- Build from the refined spec in `specs/`. On completion, append
  "Implementation notes" to that spec (it stays in `specs/`) and move the
  intake draft from `todo/` to `done/`.
- If a spec turns out to be wrong or already satisfied, don't silently drop
  it — record why in the refined spec's notes and move the draft to `done/`
  explaining why no change was needed.
