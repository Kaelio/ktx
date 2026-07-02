---
name: wiki_capture
description: ktx's knowledge base - wiki pages for durable, reusable business knowledge. Covers capture workflow for user preferences, metric definitions, organizational conventions, and cross-references between wiki pages and semantic-layer sources. Loaded by the post-turn memory-agent only. The research agent reads wiki via `wiki_read`/`wiki_search` but does not write it.
callers: [memory_agent]
---

# Wiki Capture

## Role

The knowledge base stores durable, reusable business knowledge for an analytics assistant. Each page is a self-contained rule, definition, or convention that answers "how should this concept be handled in this organization?" - written once and reused across chats.

Scope selection is handled by the runtime:
- When user-scoped knowledge is enabled AND the caller is a chat turn, writes go to the user's **personal** scope.
- When the caller is an admin-driven ingest (`sourceType: 'external_ingest'`), writes go to the **global** scope.
- When user-scoped knowledge is disabled, all writes go to the global scope.

The `wiki_write` tool picks the right scope based on the session. Capture logic does not need to choose - focus on whether the content is worth capturing at all.

## What to capture

Capture when the user or the ingested document expresses:
- A metric definition ("revenue means booked revenue after refunds").
- A filter or convention that should always apply ("exclude test accounts when reporting ARR").
- A mapping or alias ("mood_stress_sleep = Oxytocin protocol").
- A domain rule that is not visible from column names alone ("status = 'T' means terminated, not 'terminated'").
- A link or external system convention ("medplum_patient_id is the primary key in the EMR at https://emr.example/patients/{id}").

Do NOT capture:
- One-off requests ("answer under 100 words").
- Temporary instructions scoped to the current chat.
- Ad-hoc formatting preferences.
- Information already present in the semantic layer (column names, join paths, measure formulas - those belong in SL).
- **Query results, snapshots, or time-bounded benchmark tables.** Numbers go stale; pasting "Oct 2025: 25%, Nov 2025: 19.9%, …" creates misinformation as soon as new data lands. Reference the SL source by name (`sl_refs`) and let future query tools pull live data - the wiki captures the *rule* (definition, exclusion, segmentation), the SL source captures the *measure*, and query execution captures the *current values*.
- **Interpretive narrative tied to a specific snapshot** ("M1 retention degraded sharply from Dec 2025"). The observation is anchored to data that will move; the actionable convention (e.g., "always exclude in-progress cohorts") may be worth capturing on its own, but the snapshot-specific commentary is not.

If nothing is worth capturing, respond without calling any tool.

## Workflow

1. Read the wiki index (provided in the prompt) and decide whether the turn introduces durable knowledge.
2. **Before writing**, search for related content so cross-references are accurate:
   - `discover_data` first when a page relates to data or SL concepts - find
     existing wiki pages, SL sources, and raw warehouse schema together.
   - `wiki_search` with the topic - find related wiki pages to populate `refs`.
   - `sl_discover` with the concept - if the page defines a metric (revenue, churn, retention, LTV, ARR, MRR, CAC, attribution, etc.), find matching SL sources or measures to populate `sl_refs`. If no matches, pass `sl_refs: []` so future readers know you checked.
3. If updating an existing page, `wiki_read` it first. Use the returned `structured.content` or markdown body as the exact stored text for targeted replacements; current tags, refs, and sl_refs are returned in structured metadata.
4. `wiki_write` to create or update. Prefer merging into an existing page over creating a new one.
5. `wiki_remove` only when a page is truly obsolete - not to replace stale content (update it instead).

For bundle/external ingest, include `rawPaths` on every `wiki_write`/`wiki_remove` call with only the raw files that directly support that wiki action. This keeps ingest provenance tied to the actual source file, not every file in the WorkUnit.

## Identifier Verification Protocol

Before writing a wiki page or SL source on any topic:

1. `discover_data({query: "<topic>"})` - see what wikis, SL sources, and raw
   tables already exist. Prefer updating existing pages over creating new ones.

Before emitting any `schema.table` or `schema.table.column` into a wiki body,
SL source, `tables:` frontmatter, `sl_refs`, or `emit_unmapped_fallback`:

2. `entity_details({connectionId, targets: [{display: "<identifier>"}]})` -
   confirm the identifier resolves; inspect native types, FK/PK, and
   sampleValues.
3. For literal values from the source, such as status codes or plan tiers,
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

## Keys, summaries, and content

- **Keys** are short kebab-case topic identifiers: `leads-source-filter`, `revenue-definition`, `churn-calculation`. No namespacing, no prefixes.
- **Summary** is a one-line hook (≤200 chars) shown in the index.
- **Content** is concise markdown - actionable rules, not prose.

```
## [Topic Title]
- Rule or preference statement
- Another rule if applicable
```

Prefer fewer, richer pages over many thin ones. Each page covers one coherent topic thoroughly. If the new information relates to an existing page, update that page instead of fragmenting the knowledge.

## Tags, refs, sl_refs

The `wiki_write` tool accepts three array fields that go into the page frontmatter:

- **`tags`**: 1–3 short lowercase topic tags (`["finance"]`, `["data-quality"]`). Call `wiki_list_tags` first to reuse existing tags for consistency.
- **`refs`**: keys of related wiki pages. Add when the new page materially depends on concepts from another (e.g., a churn definition that uses the paid-orders filter from a revenue definition). Don't add refs just because pages share a topic area.
- **`sl_refs`**: names of SL sources or measures the page relates to. Format: `"source_name"` or `"source_name.measure_name"`. Discover via `sl_discover` → inspect with `sl_read_source` → include the confirmed matches.

Wiki page keys must be flat slugs. Use `large-contract-requesters`, not
`historic-sql/large-contract-requesters`. Use `tags`, `source`, and content
headings for grouping.

### Replace semantics

All three fields use REPLACE semantics on update:

- Omit the field → existing value is kept.
- Pass `[]` → field is cleared.
- Pass `[values]` → replaces existing with exactly those values (no merging).

## Connection scoping

A project may have several databases whose schemas reuse the same concept names
(two warehouses each with `orders`, `customers`, …). The `connections`
frontmatter field keeps database-specific pages from polluting searches about
other databases.

- The `wiki_write` tool accepts a `connections` field (list of connection ids,
  same REPLACE semantics as `tags`). Absent or empty ⇒ the page is **unscoped**
  and applies to every connection.
- When this ingest/turn is scoped to a connection (its id appears in the prompt
  context — e.g. `connectionId: warehouse` in the SL Sources header or the
  `<context>` block), set `connections: [<that id>]` on pages whose content is
  **specific to that database** ("in this warehouse `user_id` is the device id,
  not the account id"). Pair this with a connection-distinctive key so two
  databases' same-concept pages can coexist: `orders_sales_db`, not `orders`.
- Leave `connections` empty for clearly **org-wide** knowledge ("fiscal year
  starts in February") so it stays visible everywhere. Do not scope a page to a
  connection just because the turn happened to be connection-scoped.
- Keys are still a flat, global namespace; `connections` does not namespace
  them. A connection-scoped write whose key already belongs to a page scoped to
  a *different* connection is rejected to prevent silently overwriting it — pick
  a connection-distinctive key instead.

## Editing existing pages

Two modes:

- **Full content** - pass `content` to rewrite the whole page. Use when the page structure needs to change.
- **Targeted edits** - pass `replacements: [{ oldText, newText }]` to apply exact-string replacements. Use for small updates; preserves the rest of the page.

When editing, read the page first so the edit matches exact whitespace and indentation.

## Overriding an organization rule

Organization (GLOBAL) pages are read-only from a user's personal-scope session. To override a global rule for a single user, write a personal page with the **same key**. At read time the USER page wins.

## Worked example - capturing a metric with cross-references

User says: "Going forward, the official refund rate is total refunded amount divided by total gross transaction amount."

```
wiki_list_tags()
  → existing tags include "finance"
wiki_search({ query: "refund revenue paid orders" })
  → returns `revenue-definition` (related - defines paid-orders filter)
sl_discover({ query: "refund rate" })
  → returns fct_orders (score 0.08), fct_gaap_revenue (0.06)
sl_read_source({ connectionId: "warehouse", sourceName: "fct_orders" })
  → confirms amount_refunded_dollars and transaction_amount_dollars exist
wiki_write({
  key: "refund-rate-definition",
  summary: "Refund rate = refunded amount / gross transaction amount",
  content: "## Refund Rate\n- Definition: sum(amount_refunded_dollars) / sum(transaction_amount_dollars)\n- Source of truth: fct_orders\n- Related: see revenue-definition for paid-orders filter.",
  tags: ["finance"],
  refs: ["revenue-definition"],
  sl_refs: ["fct_orders.refund_rate_pct", "fct_orders"]
})
```

Search-then-write order matters. Cross-references are part of the page's identity, not an afterthought.

## Rules

- Read existing pages before updating them.
- Prefer merging into an existing page over creating a new one.
- Prefer fewer, richer pages over many thin ones.
- Write content as clear, actionable rules - not narrative prose.
- Discover cross-references via search before writing, not after.
- If nothing is worth capturing, respond without calling any tool.
