# Connection-scoped wiki pages

## Problem

Wiki pages have only two scopes today: `GLOBAL` and `USER`
(`packages/cli/src/context/wiki/types.ts`, frontmatter schema ~lines 14-29).
There is no way to associate a page with a connection. In a project with many
connections, all pages share one search index, so `wiki_search` for a generic
term ("orders", "revenue", "average order value") surfaces pages about the
wrong database. Concept names collide across databases constantly in
real-world multi-connection projects (several databases each with `orders`,
`customers`, etc.).

Today, when `memory_ingest` is called with a `connectionId`, that id is only
used to scope which semantic-layer sources the triage agent can see
(`memory-agent.service.ts` ~46-72, ~107-109); it is **not** persisted on the
resulting wiki page in any form.

## Generic use case

Any org with multiple databases/warehouses in one ktx project: org-wide
definitions ("fiscal year starts in February") should be visible everywhere,
while database-specific conventions ("in the events DB, `user_id` is the
anonymous device id, not the account id") should not pollute searches about
other databases.

## Requirements

1. **Frontmatter field.** Add an optional `connections:` field to wiki page
   frontmatter — a list of connection ids (accept a single string too,
   normalize to list).
   - **Absent or empty ⇒ unscoped: the page applies to all connections.**
     This is exactly today's behavior, so every existing page is unaffected
     (backward compatible by construction).
2. **Search filtering.** `wiki_search` (MCP tool, `context-tools.ts` ~46-64)
   and `ktx wiki search` / `ktx wiki list` (CLI,
   `knowledge-commands.ts`) accept an optional `connectionId`:
   - With `connectionId: X` ⇒ return pages scoped to X **∪** unscoped pages.
   - Without ⇒ current behavior, all pages.
   - The filter must apply to **all three search lanes** (lexical FTS5,
     semantic/embedding, token fallback) in
     `local-knowledge.ts` / `sqlite-knowledge-index.ts` — not as a post-filter
     that eats into the result limit unevenly.
3. **Index.** Persist the scoping in the `.ktx/db.sqlite` knowledge index
   (the index is already re-synced from files on every search,
   `local-knowledge.ts` ~286-310, so a schema addition + sync is sufficient).
4. **Write path.** The memory agent's wiki-write tool accepts the connections
   field; when `memory_ingest` is invoked with a `connectionId`, the agent
   should default new database-specific pages to that connection, while still
   being allowed to write unscoped pages for clearly org-wide content (prompt
   guidance, not a hard rule).
5. **`wiki_read` and refs are unchanged** — pages remain addressable by key
   regardless of scoping; `connections` is a search/relevance concern only.
6. **Validation.** Warn (don't fail) when a page references a connection id
   not present in `ktx.yaml` — config and content can evolve independently.

## Acceptance criteria

- A page with `connections: [db_a]` is returned by
  `wiki_search(query, connectionId: "db_a")` and by an unfiltered search, but
  **not** by `wiki_search(query, connectionId: "db_b")`.
- A page with no `connections` field is returned in all three cases above.
- Existing projects with no scoped pages behave identically before/after.
- Filtering works in each lane independently (test with embeddings disabled
  to exercise lexical/token lanes alone).
- `memory_ingest(content, connectionId)` produces a page scoped to that
  connection for database-specific content.

## Benchmark context (motivation only)

Spider 2.0-Lite local subset = one project with 30 SQLite connections whose
schemas share table/concept names (Northwind, sakila, two e-commerce DBs…).
External-knowledge docs (RFM definition, F1 overtake rules) are each relevant
to exactly one database and must not surface for the other 29.
