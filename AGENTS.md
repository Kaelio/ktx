# ktx Development Notes

**ktx** is a standalone open-source context layer for data agents. These
instructions apply to all agents working in this repository (Codex, Claude,
Gemini, and similar tools). Do not assume an external app server, frontend,
database migrations, ORPC contracts, or `python-service/` layout exist here.

## Critical Rules

### Absolute Requirements

- **MUST**: Use the active agent's task tracker for tasks with 3+ steps or
  complex operations (`TodoWrite` in Claude, `update_plan` in Codex).
- **MUST**: Read files before editing them.
- **MUST**: Complete all tracked tasks before finishing.
- **MUST**: Activate `.venv` before running Python code when a local virtualenv
  exists. If no `.venv` exists, use `uv run ...` from the relevant project root.
- **MUST**: After modifying Python files, run the relevant Python tests and run
  `uv run pre-commit run --files [FILES]` when a pre-commit config exists. If
  pre-commit cannot run because config or tool versions are missing, state that
  explicitly and run the closest available checks.
- **MUST**: Remove dead code; do not leave commented-out code, unused wrappers,
  or empty directories.
- **MUST**: Keep package/public API changes intentional. Do not add compatibility
  wrappers for old **ktx** names unless the user explicitly asks for a migration
  bridge.
- **MUST**: Avoid compatibility shims for old **ktx** features, command shapes,
  configuration formats, or internal APIs. This rule does not prohibit
  compatibility support for third-party systems and libraries, such as
  Metabase version differences. Keep the **ktx** codebase clean instead of
  preserving stale **ktx** behavior.
- **MUST**: Treat **ktx** as having no public users unless the user says otherwise.
  Legacy support is not necessary by default; prefer clean breaking changes over
  compatibility shims, migration bridges, or preserved stale behavior.

### Absolute Prohibitions

- **MUST NOT**: Use raw `pip`; use `uv`.
- **MUST NOT**: Use `npm` or `bun`; use `pnpm`.
- **MUST NOT**: Run destructive git cleanup commands (`git clean`,
  `git reset --hard`, `git checkout .`) unless the user explicitly requested
  that exact operation.
- **MUST NOT**: Run `git stash`, `git stash pop`, `git stash apply`, or
  `git stash drop` without explicit user instruction. Prefer a branch plus
  commit when the user asks to save work in progress.
- **MUST NOT**: Reintroduce external app conventions such as ORPC contracts,
  NestJS controllers, frontend routes, `routeTree.gen.ts`, or app database
  migration commands unless those systems are intentionally added to **ktx** later.

### Language Convention

- **MUST**: Absolute requirement, never deviate.
- **MUST NOT**: Absolute prohibition.
- **SHOULD**: Strong recommendation, deviate only with good reason.
- **MAY**: Optional, at agent's discretion.

## Priority Hierarchy

When rules conflict, follow this order:

1. Safety and user intent
2. Correctness: code works and verification passes
3. Single source of truth and DRY design
4. Code quality: types, readable boundaries, focused modules
5. Performance where it matters

## Opinionated Product Defaults

- **MUST**: Prefer one canonical behavior over configurable alternatives. A new
  flag, config field, environment variable, mode, strategy option, adapter hook,
  or fallback path is a product feature and must be justified by an explicit
  user request or a real correctness requirement.
- **MUST NOT**: Add speculative flexibility for imagined users, migrations,
  review preferences, local workflows, or "just in case" scenarios. If the
  requested behavior can work with one solid default, implement that default.
- **MUST NOT**: Add boolean switches that create two runtime paths unless both
  paths are essential and the user explicitly asked for the choice. Boolean
  policy knobs are especially suspect because they double the state space and
  test surface.
- **MUST**: When a design seems to need a new option, first try to remove the
  need by choosing the stronger default, tightening the invariant, or failing
  clearly. Ask the user before adding the option if it still seems necessary.
- **MUST**: Delete obsolete branches, tests, docs, and config when removing a
  behavior. Do not preserve dormant compatibility paths.

## Repository Shape

**ktx** is a pnpm + uv workspace.

- TypeScript package: `packages/cli` (the sole npm-published package source)
- Core context modules: `packages/cli/src/context/`
- LLM provider modules: `packages/cli/src/llm/`
- Database connector modules: `packages/cli/src/connectors/<driver>/`
- Python semantic layer: `python/ktx-sl`
- **ktx** daemon: `python/ktx-daemon`
- Examples and fixtures: `examples/`
- Workspace scripts: `scripts/`
- Local agent skills and internal planning docs are private overlays. Do not
  commit `.agents/`, `.claude/`, or `docs/superpowers/` to this public
  repository.

Some source identifiers still contain historical package-oriented names. Do not
mass-rename symbols, paths, or docs unless the task asks for that rename.

## Quick Commands

### TypeScript Workspace

```bash
pnpm install
pnpm run build
pnpm run type-check
pnpm run test
pnpm run check
pnpm run dead-code
pnpm --filter @kaelio/ktx run smoke
pnpm --filter './packages/*' run build
pnpm --filter './packages/*' run test
pnpm --filter './packages/*' run type-check
```

### Python Workspace

```bash
uv sync --all-groups
uv run pytest -q
uv run pytest python/ktx-sl/tests -q
uv run pytest python/ktx-daemon/tests -q
uv run pre-commit run --files [FILES]
```

If `pyproject.toml` pins a newer `uv` than the local binary, do not edit the
pin just to make checks pass. Report the version mismatch and run checks that
do not require changing project configuration.

### CLI and Release Checks

```bash
pnpm run setup:dev
pnpm run link:dev
pnpm run artifacts:verify
pnpm run release:readiness
pnpm run release:published-smoke
```

## Verification After Changes

Choose the smallest checks that cover the changed surface, then broaden when
shared contracts or package exports are affected.

- TypeScript package code: `pnpm --filter <package> run type-check` and
  `pnpm --filter <package> run test`
- Cross-package TypeScript changes: `pnpm run type-check` and `pnpm run test`
- Build/export changes: `pnpm run build`
- Workspace scripts: `node --test scripts/*.test.mjs` or the specific script
  test file
- TypeScript dead-code tooling/config changes: `pnpm run dead-code`
- Python semantic layer: `uv run pytest python/ktx-sl/tests -q`
- **ktx** daemon: `uv run pytest python/ktx-daemon/tests -q`
- Python files: also run `uv run pre-commit run --files [FILES]` when
  pre-commit is configured

For test suites that take a while, capture full output once and inspect that
file instead of rerunning to apply different filters:

```bash
pnpm run test 2>&1 | tee /tmp/ktx-test-output.log
```

## Avoiding Overengineering

For the code-design principles agents must apply when writing or changing
behavior — one way to say one thing, behavior follows from inputs (not
from which path the caller took), failures must reach a decision-maker,
don't build seams without a second piece on the other side, specification
and behavior are one artifact, verify the path you claim to have fixed,
and naming asymmetries are bugs in waiting — see
[`docs/code-design.md`](docs/code-design.md). Treat the `MUST` / `MUST NOT`
rules there with the same weight as the ones in this file.

## Design Reasoning Defaults

When proposing a design, an approach, or any non-trivial change, apply these
defaults and run the self-check before presenting it. They encode the
corrections users most often have to make; reaching these conclusions
autonomously — without being asked the leading question — is the bar.

- **MUST**: Optimize for the best outcome, not for an unstated constraint. Do not
  silently adopt "smallest change", "least effort", "cheapest", or "least user
  intervention" as the goal unless the user said so. Default to the most correct,
  durable solution, and present cost / effort / scope as information for the user
  to weigh — not as a ceiling you impose on their behalf.
- **MUST**: Separate one-time cost from recurring cost before discarding an
  option. A fixed cost paid once (a setup-time computation, an extra LLM call
  during setup, a contract change) to make every later run cheaper or more
  correct is usually worth it. Do not reject it with recurring-cost reasoning;
  quantify both sides. (Example smell: "don't add an LLM call to a cost-cutting
  feature" — wrong when the call is one-time and the savings recur.)
- **MUST**: Treat a user's example as a representative of a class, not as the
  spec. Design for the general population the example stands for, then stress-test
  against deliberately different instances — another warehouse, dialect, stack
  layout, or input shape — before committing. If a design only works because of an
  incidental property of the example (e.g. "the noise happened to be in a separate
  schema *on this demo*"), it is curve-fitting; generalize it or state the
  assumption explicitly.
- **MUST**: Prefer deriving from the system's own state over enumerating cases.
  Favor an allowlist computed from declared/observed state (config, scanned
  catalog, query log, the user's own inputs) over a denylist of known-bad
  specifics (particular tables, schemas, tools, or vendors). A hardcoded or
  hand-maintained list of external specifics is a smell: it rots and fails on the
  next stack. The only acceptable static patterns are genuinely universal
  invariants (e.g. DB-engine system catalogs) and ktx's own self-emitted
  signatures.
- **MUST**: Give each capability one implementation and route every caller
  through it. When some behavior — running a query, resolving a credential or
  config reference, authenticating, selecting a dialect, loading config —
  already has a working implementation that some call sites use, make new or
  divergent call sites depend on that path instead of standing up a second one.
  Parallel implementations of one capability drift apart silently: a fix, a
  newly supported input, or an added case lands on one path and not the other,
  so one entry point (a CLI command, an MCP tool, an ingest stage) succeeds
  while another fails on the same input. When two paths already do the same
  job, collapse onto the shared one and delete the duplicate instead of
  keeping both. When fixing a defect that lives on one path, fix the shared
  implementation; do not patch the symptom on a forked branch, which preserves
  the divergence you set out to remove.
- **SHOULD**: Before inventing an abstraction or hand-rolling structural logic,
  search for what already exists and reuse it — the codebase's canonical
  representation (a structured ref/key type) instead of a parallel string scheme,
  and a mandated/available tool (e.g. `sqlglot` for SQL structure; see
  [SQL and Structured Parsing](#sql-and-structured-parsing)) instead of
  hand-parsing. Normalize ambiguous input to the canonical form at the boundary;
  do not carry the ambiguity downstream. This is the single-source-of-truth / DRY
  item from the Priority Hierarchy applied at design time.

Before presenting a design, answer these explicitly:

1. Am I optimizing for a goal the user actually stated, or one I assumed?
2. Does this generalize beyond the example in front of me? Name a real case where
   it would break.
3. Am I enumerating known-bad cases when I could derive scope from the system's
   own declared/observed state?
4. Is there an existing canonical representation or mandated tool I should reuse
   instead of building or parsing my own?
5. Am I discarding the better option on a weak or misapplied constraint
   (one-time vs recurring cost, "more surface area", "more work now")?
6. Does another entry point already perform this operation through a shared
   implementation? If so, am I routing through that path instead of forking a
   parallel one — and if I'm fixing a bug, am I fixing the shared layer rather
   than one branch?
7. Am I adding a user-visible option or alternate runtime path that the user did
   not ask for? If yes, can one opinionated default solve the problem instead?
8. Does this option multiply behavior by caller path, config value, or local
   state? If yes, remove it unless it is explicitly required.

A user question that nudges toward an alternative ("would X help?", "should I
always do Y?", "will you hardcode Z?") is a signal that a better option exists.
Investigate the implied direction and reason it through *before* defending the
original proposal — and prefer to have asked yourself the question first.

Example: If generated context changes should be saved, choose one save policy
and route ingest, setup, memory, indexing, and docs through it. Do not add an
`auto_commit`-style switch unless the user explicitly asks for staged-only runs
and accepts the extra runtime path.

## Code Comments and Docstrings

Code must be self-explanatory. Clear names, types, and signatures do the
documenting; a comment or docstring exists only to state what the code cannot
show. Everything else belongs in the PR description or nowhere.

- **MUST**: Keep each comment to 1-3 lines stating only what the code cannot
  show: a cross-file invariant ("error-severity issues never reach here — the
  doctor exits on them first"), a required ordering ("ktx.yaml is written
  before git init, so a crash cannot leave a bare `.git`"), or a library quirk
  ("zod reports unknown record keys as `invalid_key`").
- **MUST**: Hold docstrings (Python `"""..."""`, JSDoc/TSDoc) to the same bar.
  A docstring states a function's purpose or contract in 1-3 lines; when a real
  quirk or invariant motivates the code, note it once and briefly. Let
  self-explanatory code carry the rest — a well-named, well-typed function
  often needs no docstring at all.
- **MUST**: State each invariant once, at the public entry point. Do not repeat
  the same guarantee across a module docstring, a helper, its wrapper, and the
  call site.
- **MUST NOT**: Write multi-paragraph docstrings or prose comment blocks —
  design rationale, alternatives considered, change narration ("is now written
  before…"), caller enumerations ("shared by X, Y, and Z"), worked examples
  that restate the code, or the same explanation repeated in a module docstring
  and the function it describes. That is the author addressing the reviewer; it
  belongs in the PR description and rots once merged.
- **MAY**: Open a regression test with a 1-3 line comment stating the scenario
  it guards when the test name cannot carry it. Omit design history and
  references to removed designs.

## TypeScript Standards

- Use Node 22+ and pnpm workspace commands.
- Keep packages ESM (`"type": "module"`) and preserve `NodeNext` TypeScript
  semantics.
- Prefer strict types over `any`; do not use `as unknown as`.
- Keep package exports, `types`, and built `dist` expectations aligned when
  changing public APIs.
- Use `zod` schemas for runtime validation at CLI/config/API boundaries.
- Keep connector modules thin: connector-specific scanning/auth behavior
  belongs in `packages/cli/src/connectors/<driver>/`; shared types and
  orchestration belong in `packages/cli/src/context/`.
- Avoid circular module dependencies. Shared code should move to the lowest
  sensible module, not be duplicated across connectors.
- Do not manually edit generated or built output under `dist/`; edit source and
  rebuild.

### Dead TypeScript Code Checks

**ktx** uses Biome for local unused-code linting and Knip for workspace graph
analysis. These checks are intentionally part of CI and pre-commit because the
normal development workflow is agent-based.

- `pnpm run dead-code` runs three checks: Biome (`dead-code:biome`), Knip
  default-mode (`dead-code:knip`), and Knip production-mode
  (`dead-code:knip:production`). All three must pass.
- Default-mode Knip catches dead code reachable from no entry at all (broken
  graph). Production-mode Knip catches code reachable only via tests —
  i.e. code that's tested but doesn't ship.
- Pre-commit runs `knip --fix` (auto-removes the `export` keyword from
  symbols that are exported but unused) plus `knip --production` (alerts on
  test-only paths). CI runs the same checks without `--fix` and fails on any
  finding.
- Treat Knip findings as investigation prompts, not automatic deletion orders.
- Remove private dead code when you confirm there are no imports, dynamic
  references, generated references, or tests that still need it.
- Preserve public package exports unless the task explicitly includes API
  pruning.
- Add narrow `knip.json` ignores only for intentional dynamic or public cases.
  Do not add broad package-level ignores to silence unrelated findings.
- Update `knip.json` when adding dynamic entrypoints, generated files, package
  exports, CLI bins, or framework files that Knip cannot infer.

#### Internal exports for testability

When a function, type, or constant must be exported solely so a unit test can
import it (i.e. it has no production cross-file consumer), annotate the
declaration with `/** @internal */` JSDoc. Knip's production-mode check
ignores `@internal` exports, so the convention keeps the gate clean without
silencing the rest of the file.

```typescript
/** @internal */
export function reindexHasErrors(result: ReindexResult): boolean { ... }
```

Do NOT use Vitest in-source testing (`if (import.meta.vitest)` blocks). Keep
tests in separate `*.test.ts(x)` files.

If the only consumer of an export is its own test and the underlying behavior
isn't used in production, delete both the export AND the test — testing dead
code is still dead code.

### CLI Standards

- Use Commander for CLI command trees, arguments, options, help text, custom
  parsers, and async action dispatch. Prefer `@commander-js/extra-typings` for
  typed command definitions, use `InvalidArgumentError` for parse failures, and
  call `parseAsync` when actions await asynchronous work.
- Use `@clack/prompts` for interactive flows. Always handle cancellation with
  `isCancel` plus `cancel`, stop active spinners before exiting, and keep prompts
  grouped or factored so multi-step setup flows share cancellation behavior.
- When CLI behavior is shared by the `ktx setup` wizard and other `ktx`
  commands, reuse or extract components in `packages/cli/src` instead of
  duplicating setup-only logic. Prefer neutral helpers such as `clack.ts`,
  `prompt-navigation.ts`, and command-independent prompt adapters over imports
  from setup command internals.
- Keep command behavior scriptable: prefer flags and config over prompts when
  values are supplied, and reserve prompts for interactive missing input or
  explicit setup flows.

### Zod Naming Convention

```typescript
const userSchema = z.object({
  id: z.uuid(),
  email: z.string().email(),
  name: z.string(),
});

type User = z.infer<typeof userSchema>;
```

Runtime schemas use `camelCase` plus the `Schema` suffix. Static inferred types
use `PascalCase` without the suffix.

## Python Standards

- Use `pyproject.toml`; do not add `requirements.txt`.
- Use type hints for new and changed Python code.
- Use `pathlib` instead of `os.path`.
- Use `logger.exception()` when catching and logging exceptions.
- Prefer explicit exception types over broad `except Exception`.
- Keep `python/ktx-sl` focused on semantic-layer planning and SQL generation.
- Keep `python/ktx-daemon` focused on portable daemon/API behavior around the
  semantic layer.

### SQL and Structured Parsing

- Prefer AST-based parsing over regex for structured input.
- For SQL, use `sqlglot`; it is already a dependency.
- In `python/ktx-sl`, follow the local `python/ktx-sl/AGENTS.md` guidance:
  parse expressions with sqlglot, quote reserved identifiers before parsing,
  and generate postgres-shaped SQL before final dialect transpilation.
- Regex may be used for non-structural sanitization, but not to interpret SQL
  structure.

## Telemetry

**ktx** ships PostHog usage telemetry. Catalog telemetry events use strict
schemas. When adding commands or events:

- **MUST NOT**: Add fields that carry user data — file paths, hostnames,
  environment values, SQL text, schema/table/column names, error messages,
  argv, or secrets. Schemas use Zod `.strict()`, so unknown fields throw at
  runtime; the privacy rule is enforced by the schema, not by goodwill.
- **MUST**: Add new event types in `packages/cli/src/telemetry/events.ts`.
  `pnpm run build` mirrors the catalog into the Python daemon schema; a
  pytest checks Node ↔ Python parity.
- **SHOULD**: Let Commander's `preAction` hook auto-emit the `command` event
  for any new CLI command — do not call `trackTelemetryEvent` manually for
  command-level success/failure.
- **MUST**: Update the public overview at
  `docs-site/content/docs/community/telemetry.mdx` only when the *category*
  of collected data changes. Adding another event with no new field types
  needs no docs change.

### Error reports

**ktx** also sends PostHog Error Tracking `$exception` events when telemetry is
enabled. This channel is separate from the strict catalog event schema and is
used only for exception diagnostics.

`$exception` events may include stack frames, error class names, raw error
messages, cause chains, `source`, `handled`, `fatal`, runtime version fields,
OS/runtime fields, and the hashed `projectId` when known. Stack frames may
include local file paths and the local username when those appear in paths.

`$exception` events must never intentionally include secrets, credentials,
database URLs, auth headers, raw argv, raw environment values, SQL text,
schema/table/column names as explicit properties, customer row data, user prompt
text, or raw MCP arguments. Reporters must redact call-site-provided secret
snapshots and common static credential patterns before the SDK serializes the
exception.

## Documentation and Specs

- Keep public documentation in `README.md`, package READMEs, example READMEs,
  and the `docs-site/` Fumadocs tree.
- Prefer concrete commands, file paths, and acceptance criteria over broad
  prose.
- When documenting examples, ensure referenced files and commands exist in the
  standalone **ktx** tree.
- Remove or rewrite stale external app references unless the doc is explicitly
  historical.

### Product Naming

- **MUST**: Write the product name as lowercase `ktx`.
- **MUST**: In Markdown prose, write `**ktx**` so the product name stays
  visually distinct from surrounding text.
- **MUST**: Use code font for the CLI command, binary, package/path fragments,
  configuration files, environment variables, source identifiers, and copied
  terminal output, for example `ktx`, `ktx setup`, `ktx.yaml`,
  `KTX_PROJECT_DIR`, and `.ktx/`.
- **MUST**: Use plain lowercase `ktx` in frontmatter, metadata, alt text,
  headings, nav labels, badges, UI strings, and generated index strings where
  Markdown emphasis is not rendered or would be visually noisy.
- **MUST NOT**: Write the bare all-caps spelling for the product name in docs prose.
  Keep uppercase only when it is part of an exact environment variable,
  source-code identifier, package/API name, or other literal value that must
  match the implementation.

### Product Category Naming

- **MUST**: Use **context layer** as the primary public category for **ktx**.
  Preferred phrase: `context layer for data agents`.
- **MUST**: Use **context engine** only as the secondary mechanism term for the
  active system that builds, reconciles, validates, searches, and serves the
  context layer.
- **MUST**: Keep **semantic layer** as the narrower term for executable metric
  definitions, semantic sources, joins, measures, and SQL compilation.
- **MUST NOT**: Replace every `semantic layer` occurrence with `context layer`;
  the semantic layer is one pillar inside the broader context layer.

Preferred pattern:

```md
**ktx** is an open-source context layer for data agents. Its context engine
ingests warehouse metadata, BI definitions, query history, docs, and approved
metrics, then turns them into reviewable files agents can search and execute.
```

### Terminology

For canonical vocabulary used across docs, code, comments, CLI strings, and
error messages — including the disambiguation rule for the overloaded word
`source` (semantic / primary / context / source of truth) — see
[`docs/terminology.md`](docs/terminology.md). Follow that file when choosing
between near-synonyms (e.g. `connector` vs `adapter`, `data agent` vs
`database agent`, `context-source ingest` vs `source ingest`). Product-name
rules in this section take precedence over anything in that file when they
conflict.

### Updating `docs-site/` After Code Changes

Before finishing a task, decide whether `docs-site/content/docs/` needs an
update. Update it when your change affects user-visible behavior, including:

- New, renamed, or removed CLI commands, flags, or subcommands
  (`docs-site/content/docs/cli-reference/`)
- Changes to `ktx.yaml`, environment variables, or other configuration users
  edit
- New or changed connectors, integrations, or supported drivers
  (`docs-site/content/docs/integrations/`)
- Changes to setup, install, or getting-started flows
  (`docs-site/content/docs/getting-started/`)
- New concepts, agent capabilities, or workflows users should know about
  (`docs-site/content/docs/concepts/`, `docs-site/content/docs/guides/`)

Skip docs updates for purely internal refactors, test-only changes, or fixes
that do not change user-facing behavior. When you do update docs, follow the
`fumadocs-mdx-structure` skill and keep examples copy-pasteable. If a change
warrants docs but you are out of scope, call it out in your final summary
rather than silently skipping it.

#### Monospace ligatures in `docs-site/`

- **MUST**: Disable monospace ligatures on every surface that uses the
  `var(--font-mono)` family (Geist Mono). Geist Mono fuses `--` into an
  em-dash glyph that visually eats the adjacent space, so prompts like
  `npx skills add Kaelio/ktx --skill ktx` render as
  `Kaelio/ktx--skill ktx`.
- **MUST**: When adding a new container that renders user-visible monospace
  text outside `<code>` / `<pre>` (e.g. a styled `<div className="font-mono">`
  for a copyable prompt), verify the global ligature-off rule in
  `docs-site/app/global.css` covers its selector. Either use Tailwind's
  `font-mono` utility (already covered) or extend the rule to match the new
  class — do not silently rely on Geist Mono's defaults.
- **SHOULD**: Prefer `<code>` / `<pre>` (or a `font-mono` wrapper) for any
  string that contains CLI flags, paths, or other tokens with `--`, `->`,
  `>=`, `!=`, `==`, `//` so ligatures never alter intent.

## LLM and Prompt Development

When creating or modifying agent prompts, system prompts, tool descriptions, or
skills:

- Use XML tags for major structure when it helps model reliability:
  `<role>`, `<workflow>`, `<examples>`, `<success_criteria>`.
- Use positive framing: tell the model what to do.
- Keep prompts compact and avoid duplicating the same rule in multiple places.
- Include 1-3 concrete examples when examples materially reduce ambiguity.
- Use AI SDK v6 patterns for TypeScript LLM work.
- Use the local `ai-sdk` skill when working with AI SDK code.

## Context7 and External Docs

- Use Context7 when official, current library documentation would materially
  reduce risk.
- Context7 "Monthly quota exceeded" errors are often transient. Retry before
  assuming the quota is exhausted.
- If Context7 remains unavailable, state the blocked lookup and use the best
  available local/source documentation.

## When to Ask vs Act

Act without asking when:

- Following explicit user instructions
- Running verification
- Fixing clear bugs or tool failures within the requested scope

Ask first when:

- Requirements are ambiguous
- The next step is destructive or would discard user work
- A breaking public API decision is not already implied by the task
- Missing credentials, live services, or external accounts are required

## Git and Worktree Safety

- The worktree may contain unrelated user changes. Do not revert files you did
  not change unless explicitly asked.
- Before committing, inspect `git status --short` and commit only intended
  files.
- Do not commit ignored dependency/build artifacts such as `node_modules/`,
  `.venv/`, `dist/`, coverage output, or local databases unless the task
  explicitly concerns packaged artifacts.
