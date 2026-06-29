# Verbatim ingest mode for authoritative documents

> Refined spec. Intake draft: `todo/02-verbatim-ingest-mode.md`.

## Problem

`ktx ingest --text/--file` routes captured content through the memory agent.
`runKtxTextIngest` (`packages/cli/src/text-ingest.ts`) builds a
`MemoryAgentInput` with `sourceType: 'external_ingest'` and hands it to
`MemoryAgentService.ingest` (`context/memory/memory-agent.service.ts`), which
runs a multi-step LLM triage loop (≈30-step budget, content clipped to ~48k
chars) inside a session worktree. The agent decides — via the `wiki_write`
tool — what to persist, so it may **rewrite, condense, split, or re-title** the
content before it lands as a wiki page. The body is produced by an LLM, not
copied by code.

For *authoritative* documents — formula definitions, metric specs, runbooks,
compliance text — paraphrasing is a defect, not a feature:

- exact thresholds, constants, and rule wording must survive unchanged;
- lexical (BM25/FTS5) search works best when the stored text matches the
  phrasing users and agents query with;
- ingestion should be deterministic and reproducible — the same input file
  yields the same page, and re-running is safe.

Two further gaps block authoritative ingest today:

- The memory agent hard-requires an LLM backend
  (`context/memory/local-memory.ts` throws when `llm.provider.backend: none`
  and no runner is injected), so there is **no** offline ingest path at all.
- The agent's write tool *merges* a repeated same-scope key in place (REPLACE
  frontmatter semantics in `wiki/tools/wiki-write.tool.ts`), i.e. exactly the
  silent in-place rewrite an authoritative-document workflow must avoid.

## Generic use case

Any team ingesting documents that are already the source of truth: metric
definition sheets, SLA documents, calculation-methodology docs, regulatory
text. The user wants **ktx** to *index and surface* the document, not to
re-author it. Today they work around the memory agent by hand-writing
frontmatter and copying files into `wiki/global/`; verbatim mode makes that a
first-class, supported `ktx ingest` workflow.

## Model

`ktx ingest --verbatim` is a **distinct, code-driven ingest path**, not a
constrained prompt over the existing agent loop. Its defining invariants:

- **The stored page body is the input document body, written by code.** The LLM
  never produces, edits, or relays the body. It is confined to generating
  *metadata* about the body.
- **Behavior follows from inputs, not from a mode prompt.** Whether metadata is
  LLM-generated or derived offline follows from the configured backend
  (`llm.provider.backend`), not from a second user-facing switch.
- **Pages are `GLOBAL`-scoped.** Verbatim ingest targets org/project
  authoritative docs (the content teams copy into `wiki/global/` today).
  Connection association is expressed by the **additive `connections`
  frontmatter** from spec 01, never by directory.
- **Deterministic and idempotent.** The page key, the merged frontmatter, and
  the stored body are all functions of the input alone (given a fixed backend),
  so the same input produces the same page and a re-run is a safe no-op.

### "Byte-for-byte" scope

The guarantee is on the document's **interior**: no paraphrase, no condense, no
split, no re-title, no reflow, **no clipping**. The shared wiki store
canonicalizes *surrounding* whitespace — `parsePage` trims the body and
`serializePage` emits a single trailing newline
(`wiki/knowledge-wiki.service.ts`) — so leading/trailing blank lines are
normalized by the storage layer. Verbatim mode **MUST** write through that
shared `writePage`/`serializePage` path rather than fork a parallel serializer;
the interior bytes (thresholds, constants, wording) are what must be preserved
exactly, and they are. Acceptance hashes compare the stored body against the
**trimmed** input body.

## Requirements

### 1. Flag

`ktx ingest --file <path> --verbatim` and `ktx ingest --text <content>
--verbatim`. `--verbatim` is a boolean that applies to every `--file`/`--text`
item in the invocation; each item becomes its own page.

- It composes with the existing `--connection-id <id>` flag
  (`commands/ingest-commands.ts`) so the resulting page can be
  connection-scoped (see spec 01). **Note:** the intake draft wrote
  `--connection`; the shipped flag is `--connection-id`. Use `--connection-id`.
- No new `--key` flag (see requirement 4). No second behavioral switch beyond
  `--verbatim` itself.

### 2. Body preservation is enforced by code, not by prompt

The stored page body is the input content (interior preserved exactly, per
**Model → "Byte-for-byte" scope**).

- Verbatim mode **MUST NOT** route the body through the memory-agent LLM loop
  or any `wiki_write` tool call where a model could alter it.
- The LLM, when used, generates **only** metadata: `summary`, `tags`, and
  `sl_refs`. A single constrained structured-output call (AI SDK v6
  `generateObject` with a `zod` schema) is the intended mechanism — the full
  memory-agent loop, worktree, and squash-merge are **not** required and should
  not be used.
- The page key is **not** LLM-generated (requirement 4).

### 3. No clipping of the stored body

The ~48k clip may apply only to the text **sent to the LLM** for metadata
generation. It **MUST NOT** apply to the text **written** to the page. A
document larger than the clip limit is stored in full; only its metadata is
derived from the clipped prefix.

### 4. Deterministic page key

The key is derived from the input, never chosen by the LLM (an LLM-chosen slug
would break determinism and the requirement-6 idempotency guarantee):

- **`--file <path>`** → `suggestFlatWikiKey(basename without extension)`
  (`wiki/keys.ts`). This is the primary document case and is always
  deterministic.
- **`--text <content>`** → if the content opens with a Markdown heading, the
  key is `suggestFlatWikiKey(heading text)`. If there is no leading heading,
  **hard error**: inline verbatim text needs a leading heading to derive a
  stable key, or should be passed as `--file`.
- No hash-based keys (unfindable) and no `--key` override flag. A real need for
  explicit key control can add `--key` later.

### 5. Frontmatter: passthrough + gap-fill

If the input has its own YAML frontmatter, split it from the body: the body is
everything after the closing `---`; the frontmatter is authoritative metadata.

- **Passthrough.** Every input frontmatter field is preserved in the stored
  page, **including fields not in `WikiFrontmatter`** (`effective_date`,
  `version`, `owner`, …). The serializer `YAML.stringify`s the object, so
  unknown keys round-trip. Dropping them would be silent data loss on
  authoritative docs.
- **Gap-fill only.** Generated/derived metadata fills **absent** fields only;
  it **MUST NOT** overwrite an explicit value. An input `summary:` is never
  replaced by a generated one; explicit `tags`/`sl_refs` are likewise kept.
- **Defaults.** `usage_mode` defaults to `auto` (findable via search, not
  force-injected) when the input does not set it.
- **Connection scoping.** `--connection-id X` (validated via
  `assertConfiguredConnectionId`, `context/connections/configured-connections.ts`)
  sets `connections: [X]` when the input frontmatter does not already declare
  `connections`. If the input frontmatter declares a **different**
  `connections` than the flag, **hard error** (ambiguous intent) rather than
  silently choosing one. If they match, or only one source is present, proceed.

### 6. Degraded mode (`llm.provider.backend: none`)

`--verbatim` **MUST** work with no LLM backend — this is its capability the
regular agent ingest lacks.

- `summary` is derived from the leading Markdown heading text, or, if none, the
  first non-empty sentence of the body (trimmed to a reasonable length).
- `tags` and `sl_refs` are left empty.
- The body is still stored in full (requirement 3 applies unchanged).

### 7. Key collisions: idempotent-if-identical, else hard error

Verbatim mode does **not** reuse the agent write tool's in-place merge. Before
writing, read any existing `GLOBAL` page at the derived key:

- **No existing page** → write.
- **Existing page, stored body identical** to the new body (compared after the
  storage-layer normalization in **Model**) → **idempotent no-op success**
  (re-running the same file is safe).
- **Existing page, body differs** → **hard error** naming the conflicting key
  and directing the user to a distinct key. Never a silent overwrite, never an
  auto-suffixed second page (which would produce the duplicated/divergent pages
  this mode must avoid).

### 8. LLM-failure handling

When a backend **is** configured but the metadata call fails (rate limit,
transport error, malformed output after retries), **fail the item** (honoring
`--fail-fast` and the per-item exit-code aggregation in `text-ingest.ts`).
**MUST NOT** silently fall back to degraded derivation: a degraded page written
on a transient error would, under requirement 7, refuse to be replaced by a
healthy re-run — breaking reproducibility. Degraded derivation is reserved for
`backend: none`.

### 9. Findability

After write, the page is reindexed so search returns it:

- `wiki_search` for a phrase taken from the document body returns the page via
  the lexical lane (the body is indexed in `buildKnowledgeSearchText`).
- `wiki_search` for a paraphrase of the document's topic returns it via the
  semantic lane **when embeddings are enabled** (this is what the generated
  `summary`/`tags` buy over a bare degraded page).

## Acceptance criteria

- Ingesting a file with `--verbatim` produces a page whose body is
  byte-identical to the trimmed input body (assert with a hash in tests).
- A >48k-char file is stored in full (assert stored body length ≥ input length
  minus trim).
- Running the same `--verbatim` ingest twice is idempotent: one page, identical
  bytes both times, no error on the second run.
- A second ingest to the same derived key with **different** body content fails
  loudly (requirement 7) and does not modify the existing page or create a
  suffixed one.
- Input frontmatter with an unknown field (e.g. `effective_date`) is preserved
  in the stored page; an explicit input `summary` is **not** overwritten by a
  generated one.
- With `llm.provider.backend: none`, `--verbatim` still produces a page: full
  body stored, `summary` derived from the heading/first sentence, `tags` and
  `sl_refs` empty.
- `--verbatim --connection-id X` yields a page with `connections: [X]`; an
  unknown id is rejected with an error listing the configured ids. (Depends on
  spec 01, now shipped.)
- `--verbatim --connection-id X` where the input frontmatter already declares a
  different `connections` fails with an ambiguity error.
- `ktx ingest --text "no heading here" --verbatim` errors asking for a leading
  heading or `--file`.
- `wiki_search` for a body phrase returns the page (lexical lane); for a topic
  paraphrase it returns the page when embeddings are enabled (semantic lane).

## Implementation orientation

Line numbers drift; treat these as anchors, not addresses. The implementer owns
module layout and design, subject to the invariants above.

- **Command flag:** `commands/ingest-commands.ts` (`ktx ingest` option table;
  `--text`/`--file`/`--connection-id`/`--fail-fast` already present — add
  `--verbatim` and thread it into `KtxTextIngestArgs`).
- **Orchestration:** `text-ingest.ts` (`runKtxTextIngest`, `loadItems`,
  `validateItems`, per-item loop and exit-code aggregation). The verbatim flow
  reuses item loading and replaces the `memoryIngest.ingest(...)` call with a
  code-driven write for `--verbatim` items. Keep the new logic in a focused
  module (e.g. a `verbatim-ingest` sibling) rather than swelling `text-ingest`.
- **Frontmatter split / write / serialize:** `wiki/knowledge-wiki.service.ts`
  (`parsePage` for the `---…---` split shape, `serializePage`, `writePage`,
  `readPage` for the collision check). Write through this shared path — do not
  re-implement YAML framing.
- **Key derivation:** `wiki/keys.ts` (`suggestFlatWikiKey`, `assertFlatWikiKey`).
- **Frontmatter type:** `wiki/types.ts` (`WikiFrontmatter`; `summary` and
  `usage_mode` are the required fields; unknown passthrough fields live
  alongside).
- **Connection validation:** `context/connections/configured-connections.ts`
  (`assertConfiguredConnectionId`, shipped with spec 01).
- **Metadata LLM call:** the local LLM runtime/config resolution in
  `context/llm/` (e.g. `local-config.ts`; `backend: none` ⇒ no runtime). Use a
  single `generateObject` call with a `zod` metadata schema; the `ai-sdk` skill
  covers v6 patterns.
- **Reindex / search lanes:** `wiki/local-knowledge.ts`
  (`loadAllKnowledgePages`, `buildKnowledgeSearchText`, the lexical/token/
  semantic lanes) and `wiki/sqlite-knowledge-index.ts` (`sync`).
- **Tests:** extend `packages/cli/test/text-ingest.test.ts` and add a
  verbatim-focused test file covering the acceptance criteria above.

## Benchmark context (motivation only)

Spider 2.0-Lite ships 8 external-knowledge markdown docs (RFM bucket
definitions, the haversine formula, F1 overtake rules, …). Gold SQL was
authored against their **exact** text; an LLM paraphrase that drops a bucket
boundary or rounds a constant loses the corresponding question. The current
workaround is hand-writing frontmatter and copying files into `wiki/global/`.
Verbatim mode turns that manual step into a supported **ktx** workflow, and
composes with the connection scoping from spec 01 so a doc relevant to exactly
one of the benchmark's ~30 SQLite databases does not surface for the other 29.

## Implementation notes

Shipped on branch `write-feature-spec-wiki`. All acceptance criteria are covered
by tests and verified end-to-end through the linked `ktx-dev` binary.

**What was built**

- New module `packages/cli/src/verbatim-ingest.ts`: `createLocalProjectVerbatimIngestor`
  + `LocalVerbatimIngestor`, plus the pure helpers `splitInputDocument`,
  `deriveVerbatimPageKey`, `deriveDegradedSummary`, and `buildVerbatimFrontmatter`
  (the last four are `@internal` exports for unit testing).
- `--verbatim` flag added to `ktx ingest` in `commands/ingest-commands.ts`, with a
  guard that rejects `--verbatim` without `--text`/`--file`. The flag is threaded
  into `KtxTextIngestArgs.verbatim`.
- `text-ingest.ts` now tags each loaded item with an `origin`
  (`file` / `text` / `stdin`) and, when `verbatim` is set, constructs the verbatim
  ingestor once and branches the per-item loop to a code-driven write instead of
  `memoryIngest.ingest(...)`. The shared view, exit-code aggregation, and
  `--fail-fast` handling are reused.

**Deviations from the literal spec (design refinements, per "implementer owns the design")**

- *Metadata call.* The spec suggested raw AI SDK v6 `generateObject`. The
  implementation routes through the existing `KtxLlmRuntimePort.generateObject`
  instead — it is implemented by all three backends (ai-sdk, claude-code, codex),
  and the ai-sdk one already wraps `generateText` + `Output.object({schema})`.
  This realizes the spec's "single constrained structured-output call" intent via
  the canonical cross-backend path rather than forking a second LLM entry point.
- *Reindex (requirement 9).* In the standalone CLI, `searchLocalKnowledgePages`
  rebuilds the SQLite index from disk on every call (recomputing embeddings for
  changed pages), so a written page is findable without a dedicated reindex step.
  The write still goes through the shared `KnowledgeWikiService.writePage` +
  `syncSinglePage` path, so the page is also eagerly indexed.
- *Gap-fill optimization.* The LLM is skipped entirely when the input frontmatter
  already supplies `summary`, `tags`, and `sl_refs` (generated metadata only fills
  absent fields, so there is nothing to generate). A fully specified document thus
  ingests with a configured backend without any LLM call.

**Tests**

- `packages/cli/test/verbatim-ingest.test.ts` — helper units + ingestor integration
  against a real `initKtxProject` git repo (byte-identical body hash, >48k no-clip,
  idempotency, conflict hard-error, frontmatter passthrough, explicit-summary
  preservation, degraded mode, connection scoping + unknown-id rejection +
  ambiguity error, no-heading inline error, LLM gap-fill, LLM-failure-fails-item,
  lexical + semantic findability).
- `packages/cli/test/text-ingest.test.ts` — verbatim routing, origin tagging,
  connection-id forwarding, fail-fast.
- `packages/cli/test/index.test.ts` — `--verbatim` flag threading and the
  requires-`--text`/`--file` guard.

**Docs**

- `docs-site/content/docs/cli-reference/ktx-ingest.mdx` (flag, "Verbatim ingest"
  section, examples, common errors) and
  `docs-site/content/docs/guides/writing-context.mdx` (authoritative-document
  workflow).

**Verification**

- Full CLI suite: 2959 passed, 1 skipped. `pnpm run build` and `pnpm run dead-code`
  (Biome + Knip default + production) clean; pre-commit clean on changed files.
  A pre-existing, unrelated type error in `test/mcp-server-factory.test.ts` is
  untouched — it predates this work.
