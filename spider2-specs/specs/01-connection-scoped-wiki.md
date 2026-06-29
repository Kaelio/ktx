# Connection-scoped wiki pages

> Refined spec. Intake draft: `todo/01-connection-scoped-wiki.md`.

## Problem

Wiki pages have only two scopes today: `GLOBAL` and `USER`
(`packages/cli/src/context/wiki/types.ts`, `WikiScope`). Scope is expressed by
directory (`wiki/global/<key>.md`, `wiki/user/<userId>/<key>.md`) and the
search path filters by loading only the in-scope pages before any lane runs.
There is no way to associate a page with a **connection** (a warehouse/database
defined under `connections:` in `ktx.yaml`).

In a project with many connections this causes two distinct failures:

1. **Cross-database relevance pollution.** All pages share one search index, so
   `wiki_search` for a generic term (`orders`, `revenue`, `average order
   value`) surfaces pages written about the wrong database. Concept names
   collide across databases constantly in real multi-connection projects
   (several databases each with `orders`, `customers`, …).
2. **Silent overwrite on shared keys.** Page keys are a flat, global namespace.
   The write path resolves a repeated key to the existing file and updates it
   in place. So if the agent writes an `orders` page while ingesting database B
   and an `orders` page already exists for database A, B's content **overwrites
   A's** — same-concept pages for different databases cannot coexist today.

Today, when `memory_ingest` is called with a `connectionId`, that id only
scopes which semantic-layer sources the triage agent can see
(`memory-agent.service.ts`); it is **not** persisted on the resulting wiki page
and **not** validated against `ktx.yaml`.

## Generic use case

Any org with multiple databases/warehouses in one **ktx** project: org-wide
definitions ("fiscal year starts in February") should be visible everywhere,
while database-specific conventions ("in the events DB, `user_id` is the
anonymous device id, not the account id") should not pollute searches about
other databases — and two databases that both have an `orders` concept must be
able to keep separate, non-colliding pages.

## Model

`connections` is **additive frontmatter metadata**, orthogonal to the existing
`GLOBAL`/`USER` directory scope — not a third scope dimension:

- A page is still `GLOBAL` or `USER` and lives where it lives today. It may
  **additionally** carry a `connections` list.
- **Page keys remain a flat, globally-unique namespace.** `connections` does
  **not** namespace keys; a page is addressable by key alone, unchanged.
- A page may list **multiple** connections.
- **Absent or empty `connections` ⇒ unscoped: the page applies to all
  connections.** This is exactly today's behavior, so every existing page is
  unaffected.

This keeps `wiki_read` and refs untouched and adds no parallel scope axis;
filtering by connection is purely a search/relevance concern.

## Requirements

### 1. Frontmatter field

Add an optional `connections` field to wiki page frontmatter — a list of
connection ids.

- Accept a single string too; normalize to a list at parse time (reuse the
  existing array-coercion helper used for `tags`/`refs`/`sl_refs`).
- Round-trips through parse/serialize without loss.
- Absent or empty ⇒ unscoped (see Model). Existing pages are unaffected by
  construction.

### 2. Page identity and key distinctness

`connections` does not change how pages are identified or addressed:

- Keys stay flat and globally unique; `wiki_read(key)` is unchanged.
- Because the write path updates a page in place when its key already exists,
  same-concept pages for different connections **MUST** use distinct keys
  (e.g. `orders_sales_db` vs `orders_events_db`). Connection-distinctive keys
  for database-specific pages are the primary mechanism (driven by write-path
  prompt guidance, requirement 5).
- **Data-loss guard (code, not prompt):** a connection-scoped write whose key
  matches an existing page whose `connections` scope is **disjoint** from the
  incoming scope MUST surface a collision instead of silently overwriting the
  existing page. (Updating a page within the same connection scope, or
  broadening/narrowing its own `connections`, is a normal update — not a
  collision.) The implementer owns whether the collision is a hard error or a
  suffixed new key; it must not be a silent clobber.

### 3. Search filtering

Add an optional connection filter to the search surfaces:

- **MCP:** `wiki_search(query, connectionId?)` (`context-tools.ts`).
- **CLI:** `ktx wiki search` and `ktx wiki list` accept `--connection <id>`
  (with `-c` alias), matching the `ktx sql` connection flag.

Semantics:

- With `connectionId: X` ⇒ return pages whose `connections` is empty
  (unscoped) **∪** pages whose `connections` contains X.
- Without ⇒ current behavior, all pages.
- The filter **MUST** apply uniformly to **all three search lanes** (lexical
  FTS5, semantic/embedding, token fallback) at the **candidate-source level**,
  so each lane draws its full candidate pool from the already-scoped set. It
  **MUST NOT** be a post-filter on the merged/ranked results — that would let
  off-scope candidates consume both the per-lane pool and the final result
  limit unevenly.

*Orientation:* the existing `GLOBAL`/`USER` scoping already filters at the
disk-load step that feeds both the in-memory token lane and the synced SQLite
index (`local-knowledge.ts`); the connection filter fits the same seam.

### 4. Index persistence

The `.ktx/db.sqlite` knowledge index is re-synced from files on every search.
The implementer owns whether to persist `connections` as index columns / a side
table, or to filter the loaded page-set before the per-search sync. The binding
requirement is the uniform-across-lanes behavior in requirement 3 — not a
specific schema.

*Trade-off note (non-binding):* filtering the loaded page-set re-syncs only the
scoped subset and gives up a little embedding-cache reuse when searches
alternate between connections (recompute is one embedding per scoped page per
connection switch — negligible at the scale this targets). Persisting
`connections` in the index avoids that at the cost of a schema addition and a
per-lane predicate. Either is acceptable.

### 5. Write path

- The memory agent's page-write tool (`wiki-write.tool.ts`) accepts a
  `connections` input field with the same REPLACE semantics as
  `tags`/`refs`/`sl_refs`: omit ⇒ keep existing on update; `[]` ⇒ clear to
  unscoped; `[ids]` ⇒ set.
- When `memory_ingest` / the memory agent runs with a `connectionId`, prompt
  guidance directs the agent to:
  - set `connections: [connectionId]` on new **database-specific** pages, using
    connection-distinctive keys; and
  - leave `connections` empty for clearly **org-wide** content.
- This is **prompt guidance, not a code auto-default.** A connection-scoped
  ingest must remain able to produce unscoped org-wide pages, so the tool must
  not force the session's `connectionId` onto every page.

### 6. `wiki_read` and refs unchanged

Pages remain addressable by key regardless of scoping. `wiki_read`, `refs`, and
`sl_refs` semantics are unchanged; `connections` is a search/relevance concern
only.

### 7. Validation

Validation behavior splits by surface, because an explicit argument is a
typo-prone input while persisted content drifts independently of config:

- **Explicit argument** — a connection id supplied as a command/tool argument
  (`wiki_search`/`memory_ingest` `connectionId`, `ktx wiki … --connection`)
  MUST be validated against `ktx.yaml` connections and **rejected with a clear
  error listing the configured ids** when unknown. Reuse the canonical
  `project.config.connections[id]` check. This also closes the current gap
  where `memory_ingest`'s `connectionId` is accepted unvalidated.
- **Persisted frontmatter** — a connection id that appears only in a stored
  page's `connections` and is not in `ktx.yaml` MUST **warn (not fail)** during
  validation/doctor, and MUST NOT break loading, searching, or reading that
  page. Config and content can evolve independently.

### 8. Scope boundary

This spec delivers the **mechanism** (frontmatter storage + uniform filter +
write surface + validation). Driving the agent to actually pass `connectionId`
during analytics work is the concern of
`03-multi-connection-routing-in-analytics-skill`. It composes with the
`--connection` flag on `ktx ingest` from `02-verbatim-ingest-mode`.

## Acceptance criteria

- A page with `connections: [db_a]` is returned by
  `wiki_search(query, connectionId: "db_a")` and by an unfiltered search, but
  **not** by `wiki_search(query, connectionId: "db_b")`.
- A page with no `connections` field is returned in all three cases above.
- Two pages — `orders_sales_db` (`connections: [sales_db]`) and
  `orders_events_db` (`connections: [events_db]`) — coexist; a search scoped to
  `sales_db` returns the first and not the second, and neither overwrote the
  other on write.
- A connection-scoped write whose key matches an existing page scoped to a
  **different** connection surfaces a collision instead of silently
  overwriting (data-loss guard, requirement 2).
- Filtering works in each lane independently (test with embeddings disabled to
  exercise the lexical and token lanes alone).
- `memory_ingest(content, connectionId)` produces a page scoped to that
  connection for database-specific content.
- `wiki_search`/`ktx wiki search --connection <unknown>` fails with an error
  that lists the configured connection ids.
- A page whose `connections` references an id absent from `ktx.yaml` produces a
  warning but stays searchable and readable; search and read do not throw.
- `connections` accepts a single string and a list, both normalized to a list.
- Existing projects with no scoped pages and no `connectionId`/`--connection`
  behave identically before/after.

## Implementation orientation

Line numbers drift; treat these as anchors, not addresses. The implementer owns
the design.

- **Frontmatter type + parse/serialize:** `wiki/types.ts` (`WikiFrontmatter`),
  `wiki/knowledge-wiki.service.ts` (`parsePage`/`serializePage`), array
  coercion `wiki/local-knowledge.ts` (`stringArray`).
- **Search lanes + per-search re-sync:** `wiki/local-knowledge.ts`
  (`searchLocalKnowledgePagesWithSqlite`; the disk-load step that already
  scopes `GLOBAL`/`USER`; token lane), `wiki/sqlite-knowledge-index.ts`
  (FTS5 `knowledge_pages_fts` lexical lane, semantic scan, `sync`).
- **MCP surface:** `mcp/context-tools.ts` (`wiki_search`, `wiki_read`,
  `memory_ingest`; `connectionId` already present on `memory_ingest` but
  unvalidated).
- **CLI surface:** `commands/knowledge-commands.ts`
  (`ktx wiki search`/`list`/`read`); canonical `--connection` flag in
  `commands/sql-commands.ts`; validation pattern
  `project.config.connections[id]` in `mcp/local-project-ports.ts`.
- **Write path:** `wiki/tools/wiki-write.tool.ts` (input schema, REPLACE
  semantics, scope decision), `memory/memory-agent.service.ts` (`connectionId`
  threaded through the capture session and tool session;
  `external_ingest` forces `GLOBAL` scope).
- **Connection config:** `context/project/config.ts` (`connections` record in
  `ktx.yaml`).

## Benchmark context (motivation only)

Spider 2.0-Lite local subset = one project with ~30 SQLite connections whose
schemas share table/concept names (Northwind, sakila, two e-commerce DBs…).
External-knowledge docs (RFM definition, F1 overtake rules) are each relevant
to exactly one database and must not surface for the other 29.

## Implementation notes

Shipped on branch `write-feature-spec-wiki` (ktx worktree `tallinn-v2`). All
acceptance criteria covered; full package suite green (2924 passing),
type-check, knip/biome dead-code, and pre-commit clean.

**What was built / where**

1. **Frontmatter field (req 1).** `connections?: string[]` added to
   `WikiFrontmatter` (`context/wiki/types.ts`) and to the file-layer page model
   `LocalKnowledgePage` (`context/wiki/local-knowledge.ts`). Parsed via a new
   `stringList()` coercion (single string → list); round-trips through both
   serializers. Absent/empty ⇒ unscoped.
2. **Search/list filter (req 3, req 4).** `connectionId?` threaded through
   `searchLocalKnowledgePages` → both the sqlite-FTS and scan impls →
   `loadAllKnowledgePages`, and through `listLocalKnowledgePages`. The filter is
   applied at the **disk-load seam** (`pageMatchesConnection`: unscoped ∪ pages
   listing the id), so the token lane and the per-search SQLite sync (lexical +
   semantic) both draw their candidate pool from the already-scoped set —
   candidate-source level, not a post-filter.
   - Chose req 4 **option B (filter the loaded page-set)** over persisting a
     column. Verified-safe here: standalone ktx's memory agent reads pages from
     files via a no-op `LocalKnowledgeIndex`, so `.ktx/db.sqlite`'s
     `knowledge_pages` is a per-search cache that `searchLocalKnowledgePages`
     rebuilds every call — scoping the sync corrupts no shared state. Only cost
     is one embedding recompute per scoped page on a connection switch (the
     spec's acknowledged, negligible trade-off). No index-schema change.
3. **Page identity + data-loss guard (req 2).** Keys stay flat/global;
   `wiki_read`/refs unchanged. The write tool (`wiki/tools/wiki-write.tool.ts`)
   rejects (hard error, no silent clobber) a connection-scoped write whose
   incoming `connections` is **disjoint** from a same-key existing page's
   non-empty `connections`, suggesting a connection-distinctive key. Same-scope,
   overlapping, broaden/narrow, and unscoped-existing updates are allowed.
   Chose a hard error over auto-suffixing so the conflict reaches the agent
   (the decision-maker) instead of silently forking the key namespace.
4. **Write path (req 5).** `wiki_write` accepts `connections` (string or list)
   with REPLACE semantics (omit ⇒ keep, `[]` ⇒ unscoped, `[ids]` ⇒ set); no
   code auto-default of the session connection. Prompt guidance added to the
   shared `wiki_capture` skill (new "Connection scoping" section) and the
   `memory_agent_external_ingest` prompt. The session `connectionId` is now
   surfaced to the agent so the guidance is actionable: in the memory-agent
   prompt header and in the ingest work-unit `<context>` block
   (`build-wu-context.ts`, fed from `ingest-bundle.runner.ts`).
5. **Validation (req 7).** New shared helper
   `context/connections/configured-connections.ts → assertConfiguredConnectionId`
   validates explicit connection-id arguments against `ktx.yaml` and throws an
   error listing the configured ids. Routed from all three explicit-arg
   surfaces: MCP `wiki_search` (`local-project-ports.ts`), MCP `memory_ingest`
   (validated at the boundary in `mcp-server-factory.ts` — this also closes the
   prior gap where `memory_ingest`'s `connectionId` was accepted unvalidated),
   and CLI `ktx wiki --connection`/`-c` (`commands/knowledge-commands.ts` +
   `knowledge.ts`). Persisted-frontmatter ids absent from config are **warn-only**:
   `listReferencedConnectionIds` + a non-fatal `ktx status` warning
   (`status-project.ts`); loading/searching/reading never throw on them.

**Deviations / notes**

- Req 1 says "reuse the existing array-coercion helper used for `tags`/`refs`".
  That helper (`stringArray`) is array-only and does **not** coerce a single
  string; added a dedicated `stringList` for `connections` to meet the
  single-string acceptance criterion rather than change `stringArray`'s
  behavior for the other fields.
- **Scope boundary kept:** `discover_data` (MCP) also searches wiki and already
  takes `connectionId`, but req 3/8 scope the filter to `wiki_search` + CLI, so
  its wiki lane is intentionally left unscoped. Worth a follow-up if
  `discover_data`'s wiki results should also be connection-scoped for
  consistency.
- MCP tools-list snapshot and the `mcp-server-factory` test were updated for the
  new `wiki_search.connectionId` param and the `memory_ingest` validation
  wrapper (the port is no longer the raw service object; it delegates).
