# spider2-specs — feature specs driven by the Spider 2.0-Lite benchmark

This directory is the handoff point between two agents working on different
sides of the same goal: making Claude Code + ktx score well on the Spider
2.0-Lite benchmark **without benchmark-specific instructions** — the agent
should succeed using only what ktx provides (skills, semantic layer, wiki).

## Mechanics

- **Playground agent** — works in
  `/Users/andrey/projects/kaelio/spider-clean-submission/playground`, runs the
  benchmark, and identifies ktx capability gaps. When it finds one, it writes a
  spec into `todo/`.
- **ktx worktree agent** — started from this repo root
  (`/Users/andrey/conductor/workspaces/ktx/tallinn-v2`), picks up specs from
  `todo/`, implements them in the ktx codebase, and **moves the spec file to
  `done/`** when implemented (append a short "Implementation notes" section to
  the spec before moving it: what was built, where, and any deviations from the
  spec).

Location is status: `todo/` = not implemented, `done/` = implemented. No other
tracking.

## Rules for specs

1. **Generic, not benchmark-overfit.** ktx is a general-purpose product; the
   benchmark only surfaces the need. Every spec must state a real-world use
   case independent of Spider 2.0-Lite. If a requirement only makes sense for
   the benchmark, it doesn't belong in ktx.
2. Specs are **requirement-level**, not implementation plans. Code pointers in
   specs are orientation hints from exploration (line numbers may have
   drifted); the implementer owns the design.
3. One spec per file, kebab-case, numeric prefix = suggested priority order.

## For the implementer

- After implementing, rebuild and re-link the dev binary so the playground
  picks it up: `pnpm run build && pnpm run link:dev` (provides `ktx-dev`).
- Add/extend tests in the ktx test suites; specs list acceptance criteria to
  cover.
- If a spec turns out to be wrong or already satisfied, don't silently drop
  it — move it to `done/` with notes explaining why no change was needed.
