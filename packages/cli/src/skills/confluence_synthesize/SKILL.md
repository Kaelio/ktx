---
name: confluence_synthesize
description: Extract durable ktx wiki knowledge from staged Confluence Cloud pages. Load for WorkUnits with unitKey starting with confluence-pages.
callers: [memory_agent]
---

# Confluence Synthesize

Confluence synthesize turns staged Confluence page snapshots into durable **ktx** wiki knowledge. Pages contain business processes, technical documentation, metric definitions, team conventions, and domain knowledge.

## Work unit structure

Confluence produces one or more work units per ingest run:

- `confluence-pages` — all staged pages when ≤ 30 pages total.
- `confluence-pages-N` — batched when more than 30 pages are staged, e.g. `confluence-pages-0`, `confluence-pages-1`. The `displayLabel` includes `(N/total)`.

Each work unit includes `confluence-manifest.json` and a subset of `pages/{pageId}.json` files.

## Staged file shapes

**`pages/{pageId}.json`** — one per Confluence page:
```json
{
  "pageId": "393358",
  "spaceId": "393220",
  "spaceKey": "SEC",
  "spaceName": "Global Information Security",
  "title": "Global Information Security Office (GIS)",
  "parentId": null,
  "breadcrumb": "Global Information Security > Global Information Security Office (GIS)",
  "url": "https://yourorg.atlassian.net/wiki/spaces/SEC/overview",
  "lastEditedAt": "2026-04-27T17:04:03.456Z",
  "version": 113,
  "status": "current",
  "contentStorage": "<p>Welcome to the Security Wiki...</p>"
}
```

`contentStorage` is Confluence storage-format XML. Key constructs:
- `<p>`, `<h1>` through `<h6>` — paragraph and heading content
- `<strong>`, `<em>` — emphasis
- `<ul>`, `<ol>`, `<li>` — lists
- `<table>`, `<tr>`, `<td>`, `<th>` — tables
- `<a href="...">` — hyperlinks
- `<ac:link>` — internal Confluence links
- `<ri:page ri:content-title="...">` — page references

Extract the plain text and structure from these tags to understand page content.

**`confluence-manifest.json`** — fetch summary:
```json
{
  "confluenceConnectionId": "confluence-prod",
  "baseUrl": "https://yourorg.atlassian.net",
  "fetchedAt": "2026-06-27T10:00:00.000Z",
  "spaceCount": 8,
  "pageCount": 450,
  "capped": false,
  "spaceKeys": ["ENG", "SEC"]
}
```

`capped: true` means the run hit `maxPagesPerRun` — the staged set is a partial snapshot.

## Required workflow

1. Read every `rawFiles` entry for the WorkUnit.
2. For each page file: parse the `contentStorage` XML to extract headings, paragraphs, lists, and tables as plain text. Strip XML tags.
3. Use `discover_data` before writing to find existing wiki pages on the same topic.
4. Write wiki candidates with `context_candidate_write`. Do not call `wiki_write` directly.
5. Do not write SL sources from Confluence content — Confluence does not carry schema metadata.

## Content extraction from storage XML

When extracting content from `contentStorage`:
- Strip all `<ac:*>` and `<ri:*>` tags but preserve their text children where present.
- Replace `&amp;` → `&`, `&lt;` → `<`, `&gt;` → `>`, `&quot;` → `"`, `&#39;` → `'`.
- Treat `<h1>` through `<h6>` as section headers that organize the page hierarchy.
- Treat `<table>` content as structured data (process row by row).
- `<ac:link>` with `<ac:link-body>` children: treat as the linked page title.

## Capture rules

Write wiki candidates for:
- Business process documentation (how a team operates, workflows, runbooks)
- Metric or KPI definitions and their business context
- Technical architecture decisions, system design, or API contracts relevant to data consumers
- Domain terminology and conventions (e.g. how "active user" is defined at this company)
- Data governance policies or access procedures
- Team-specific glossaries or knowledge that agents querying data should understand

Skip:
- Meeting notes, agendas, or ephemeral status updates
- Personal directories, org charts, and contact lists (useful for people lookup, not data queries)
- Pages that are entirely navigation/index pages with no prose content
- Archived pages (`status !== "current"`)
- Pages whose title or content has no business semantic value for data queries

## Page hierarchy signals

Use `breadcrumb` and `parentId` to understand context:
- A page nested under "Finance > Metrics" likely contains finance domain knowledge.
- A page in "ENG > Architecture" likely contains technical context for data pipelines.
- Prefer space-level breadcrumbs to guide wiki tagging (use `spaceKey`/`spaceName` as topic signals).

## One wiki candidate per concept, not per page

Multiple Confluence pages can contribute to the same wiki concept. Prefer updating an existing candidate over creating a duplicate. When several pages describe the same metric or process from different angles, write one candidate that synthesizes them, citing all source pages.
