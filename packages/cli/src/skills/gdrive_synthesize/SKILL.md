---
name: gdrive_synthesize
description: Synthesize durable KTX wiki pages from staged Google Drive document pulls. Load when a WorkUnit contains Google Doc raw files from `docs/**`.
callers: [memory_agent]
---

# Google Drive Doc Synthesis

Use this skill when a WorkUnit contains staged Google Drive content from `docs/**`.

## Role

Each WorkUnit is one Google Doc plus its metadata. Read the assigned raw files, then write a small set of durable wiki entries that capture reusable organizational knowledge. Write final memory directly; do not write candidates.

## Required Workflow

1. Read the WorkUnit notes and `rawFiles` list. Document content lives in `page.md`; `metadata.json` holds title, path, url, modified time, and Drive folder context.
2. For each assigned doc, call `read_raw_file`, or `read_raw_span` for oversized docs when the notes specify a span.
3. Search `wiki_search` for existing pages that overlap the WorkUnit topics. Prefer updating an existing page over creating a duplicate.
4. Use `context_evidence_search`, `context_evidence_read`, and `context_evidence_neighbors` when indexed document chunks would help reconcile related facts. Pass `chunkId` and `documentId` values verbatim as returned by the evidence tools.
5. Write durable business knowledge with `wiki_write`. Aim for a small number of high-quality pages per doc. Include `rawPaths` with the exact Google Drive raw files that support each page.
6. If a doc references warehouse, dbt, Looker, Metabase, or MetricFlow objects, you may verify them with `discover_data`, `entity_details`, `sql_execution`, `sl_discover`, or `sl_read_source`, but Google Drive docs are knowledge-only in v1. Do not create semantic-layer sources under the `gdrive` connection.
7. For every deleted raw path in the Eviction Set, call `eviction_list`, decide retention, then `emit_eviction_decision`. Do this even when no wiki write is needed.

## What To Capture

Capture durable, reusable company knowledge:

- policies, workflows, process rules, ownership conventions, and operating procedures
- product definitions, business terminology, and organizational guidance
- source-of-truth statements, caveats, conflict notes, and supersession guidance
- cross-system aliases that connect doc terminology to warehouse, dbt, Looker, Metabase, or MetricFlow names

Skip noisy or transient content:

- brainstorming notes with no durable rule
- task lists, meeting scheduling details, and time-bounded status updates
- duplicate docs with no new fact
- shallow summaries that add no reusable policy or definition

## Quality

Prefer fewer, stronger entries. Every wiki entry must cite at least one Google Doc using its title or path and last modified date when available. When evidence conflicts, write a conflict note inside the wiki page rather than choosing silently.

If one doc covers several related ideas, synthesize the shared durable rules instead of writing one thin page per paragraph. For oversized spans, read only the assigned span unless the WorkUnit explicitly asks for neighboring context.

Search existing wiki pages for the same `tables:` or `sl_refs:` frontmatter and for source-of-truth aliases before creating a new page. If an existing page already documents the same warehouse object or business concept, update it instead of creating a differently named duplicate.

## Citation Style

```md
## Agentic Harness
- The harness provides the operational framework that turns an agent prototype into a production system.
- Source: Google Doc - Herness, last modified 2026-05-24.
- Conflict note: An older internal note uses a narrower definition focused only on tool wiring; treat the current Google Doc as the durable operating definition unless replaced explicitly.
```

## Semantic-Layer Rules

- Google Drive docs are knowledge-only in v1; keep durable output in wiki pages.
- Do not create semantic-layer sources under the `gdrive` connection.
- If a doc references an existing warehouse or semantic-layer object and you can verify it, you may attach `sl_refs` in wiki output after confirmation.
- If a doc mentions a table or source that cannot be verified, keep the identifier in wiki text as unverified or use `emit_unmapped_fallback` only when the missing physical object itself is the important durable fact.

## Identifier Verification Protocol

Before writing a wiki page on any topic:

1. `discover_data({query: "<topic>"})` - see what wikis, SL sources, and raw
   tables already exist. Prefer updating existing pages over creating new ones.

Before emitting any `schema.table` or `schema.table.column` into a wiki body,
`tables:` frontmatter, `sl_refs`, or `emit_unmapped_fallback`:

2. `entity_details({connectionId, targets: [{display: "<identifier>"}]})` -
   confirm the identifier resolves; inspect native types, FK/PK, and
   sampleValues.
3. For literal values from the doc, such as status codes or plan tiers,
   check whether they appear in `entity_details` sampleValues for the relevant
   column. If sampleValues is short or the sample may have missed real values,
   run a `sql_execution` probe with the same warehouse connection id:
   `sql_execution({connectionId, sql: "SELECT DISTINCT <col> FROM <ref> LIMIT 50"})`.
4. If the candidate identifier still does not resolve, do one of:
   - Use `sql_execution({connectionId, sql: "SELECT 1 FROM <ref> LIMIT 0"})`.
     If it errors, the identifier is fictional.
   - Wrap the identifier in `[unverified - from <rawPath>]` in the wiki body,
     citing the exact raw path that mentioned it.
   - When recording `emit_unmapped_fallback` with `no_physical_table`, include
     the failing probe error in `clarification`.
5. Never copy `<schema>.<table>` placeholder strings from these instructions
   into output.

## Tools

Allowed: `read_raw_file`, `read_raw_span`, `wiki_search`, `wiki_read`, `wiki_write`, `discover_data`, `entity_details`, `sql_execution`, `sl_discover`, `sl_read_source`, `context_evidence_search`, `context_evidence_read`, `context_evidence_neighbors`, `emit_unmapped_fallback`, `eviction_list`, `emit_eviction_decision`.

Not allowed: `context_candidate_write`, `context_candidate_mark`, `sl_write_source`, `sl_edit_source`, `sl_validate`.
