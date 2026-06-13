# Verbatim ingest mode for authoritative documents

## Problem

`ktx ingest --text/--file` routes content through the memory agent
(`text-ingest.ts` ~246-357 → `memory-agent.service.ts`), an LLM triage loop
(30-step budget for `external_ingest`, content clipped at ~48k chars,
`memory-agent.service.ts` ~165) that may rewrite, condense, or split the
content before writing wiki pages.

For *authoritative* documents — formula definitions, specs, runbooks,
compliance text — paraphrasing is a bug, not a feature:

- exact thresholds, constants, and rule wording must survive byte-for-byte;
- lexical (BM25) search works best when the stored text matches the phrasing
  users/agents will query with;
- ingestion should be deterministic and reproducible — same input file, same
  resulting page.

## Generic use case

Any team ingesting documents that are already the source of truth: metric
definition sheets, SLA documents, calculation methodology docs, regulatory
text. The user wants ktx to *index and surface* the document, not to
re-author it.

## Requirements

1. **Flag.** `ktx ingest --file <path> --verbatim` (apply to `--text` too).
   Composes with the existing optional `--connection <id>` so the resulting
   page can be connection-scoped (see spec 01).
2. **Body preservation is enforced by code, not by prompt.** The stored page
   body must be the input content byte-for-byte. The LLM is used **only** to
   generate metadata: `summary`, `tags`, `sl_refs`, suggested page key/slug
   (and `connections` default from the flag). Implementation freedom: a
   single constrained LLM call is fine — the full memory-agent loop is not
   required for this mode.
3. **No clipping of the stored body.** The ~48k clip may apply to what is
   *sent to the LLM* for metadata generation, never to what is *written* to
   the wiki page.
4. **Existing frontmatter.** If the input file already has YAML frontmatter,
   preserve user-provided fields and only fill gaps (don't overwrite an
   explicit `summary` with a generated one).
5. **Key collisions.** Deterministic, non-destructive behavior: error or
   suffix — never silently overwrite an existing page.
6. **Degraded mode.** With `llm.provider.backend: none`, `--verbatim` should
   still work, deriving `summary` from the first heading/sentence and leaving
   optional metadata empty. (Regular agent ingest can't do this; verbatim
   mode can and should.)

## Acceptance criteria

- Ingesting a file with `--verbatim` produces a wiki page whose body is
  byte-identical to the input (assert with a hash in tests).
- Running the same ingest twice is idempotent or fails loudly on the second
  run (per requirement 5) — no duplicated/divergent pages.
- A >48k-char file is stored in full.
- `--verbatim --connection X` yields a page scoped to X (depends on spec 01;
  if 01 isn't implemented yet, the flag composition can land later).
- Generated metadata makes the page findable: `wiki_search` for a phrase
  from the document body returns it (lexical lane), and for a paraphrase of
  its topic returns it when embeddings are enabled (semantic lane).

## Benchmark context (motivation only)

Spider 2.0-Lite ships 8 external-knowledge markdown docs (RFM bucket
definitions, haversine formula, F1 overtake rules…). Gold SQL was authored
against their exact text; an LLM paraphrase that drops a bucket boundary
loses a question. We currently work around this by hand-writing frontmatter
and copying files into `wiki/global/` — verbatim mode makes that a supported
ktx workflow instead of a manual step.
