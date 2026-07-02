---
name: sigma_ingest
description: Extract durable ktx wiki knowledge from staged Sigma data model specs and workbook summaries. Load for WorkUnits with unitKey sigma-data-models or sigma-workbooks.
callers: [memory_agent]
---

# Sigma Ingest

Sigma ingest turns staged data model specs and workbook summaries into durable ktx wiki knowledge. The deterministic `project()` step has already written semantic-layer YAML for all warehouse-table data model elements before this skill runs — do not re-write those SL sources.

## Work unit structure

Sigma produces at minimum two work units per ingest run:

- `sigma-data-models` or `sigma-data-models-N`
  - `rawFiles`: `data-models/<id>.json` files (one per data model in this batch)
  - `peerFileIndex`: `workbooks/<id>.json` files + `sigma-manifest.json` + `sigma-projection-config.json`
  - When the workspace has more than 50 data models, split into batches: `sigma-data-models-0`, `sigma-data-models-1`, … with `displayLabel` like `"Sigma: data models (1/8)"`. When ≤50 data models, the unitKey is simply `sigma-data-models` with no suffix.
- `sigma-workbooks` or `sigma-workbooks-N`
  - `rawFiles`: `workbooks/<id>.json` files (one per workbook in this batch)
  - `peerFileIndex`: `data-models/<id>.json` files + `sigma-manifest.json` + `sigma-projection-config.json`
  - When the workspace has more than 2000 workbooks, split into batches: `sigma-workbooks-0`, `sigma-workbooks-1`, … with `displayLabel` like `"Sigma: workbooks (1/4)"`. When ≤2000 workbooks, the unitKey is simply `sigma-workbooks` with no suffix.

`sigma-manifest.json` and `sigma-projection-config.json` are never in `rawFiles`. They live at the staged dir root and always appear in `peerFileIndex`.

## Staged file shapes

**`data-models/<id>.json`** — one per data model (in `rawFiles` for data-model units):
```json
{
  "sigmaId": "abc-123",
  "name": "Revenue Model",
  "path": "Finance/Revenue Model",
  "latestVersion": 3,
  "updatedAt": "2026-01-15T00:00:00Z",
  "isArchived": false,
  "spec": {
    "name": "Revenue Model",
    "pages": [{
      "id": "p1",
      "name": "Main",
      "elements": [{
        "id": "elem1",
        "kind": "table",
        "name": "Opportunities",
        "hidden": false,
        "source": {
          "kind": "warehouse-table",
          "connectionId": "<sigma-internal-uuid>",
          "path": ["DATABASE", "SCHEMA", "OPPORTUNITIES"]
        },
        "columns": [
          { "id": "c1", "name": "Deal Amount", "formula": "[OPPORTUNITIES/Amount]", "description": "Net contract value in USD" },
          { "id": "c2", "name": "Total ARR", "formula": "Sum([OPPORTUNITIES/ARR])", "description": "Annualised recurring revenue" }
        ]
      }]
    }]
  }
}
```

`source.kind` discriminates:
- `warehouse-table` — element maps directly to a warehouse table. Has `connectionId` and `path` (array of path segments forming the fully-qualified table name). `project()` writes an SL source when `connectionMappings` covers this `connectionId`.
- `table` — element is a derived view layered on top of another element; identified by `source.elementId`. No warehouse path. Wiki-only.

**`workbooks/<id>.json`** — one per workbook, in `rawFiles` for workbook units (summary only; no spec endpoint exists):
```json
{
  "sigmaId": "wb-abc",
  "name": "ARR Tracker",
  "path": "Finance/Dashboards",
  "latestVersion": 2,
  "updatedAt": "2026-01-16T00:00:00Z",
  "isArchived": false,
  "workbookUrlId": "57a96EMo3G...",
  "description": "Tracks ARR by segment and cohort for the finance team"
}
```

**Peer files (available via `peerFileIndex`, not `rawFiles`):**

**`sigma-manifest.json`** — fetch summary; use for provenance only.

**`sigma-projection-config.json`** — written by `fetch()`, contains two fields the skill must read:

- `connectionMappings`: `{sigmaInternalUuid: ktxWarehouseConnectionId}`. Use the mapped warehouse connection ID for `entity_details` when verifying warehouse identifiers found in data model specs.
- `workbookFilter`: the filter settings that were active when workbooks were last fetched:
  - `includeArchived` (default `false`) — when `false`, archived workbooks are not in `workbooks/`; `isArchived: true` files will only appear when this was `true`.
  - `includeExplorations` (default `false`) — when `false`, exploration-type workbooks (unsaved analyses) are excluded; treat present workbooks as intentional, curated reports.
  - `updatedSince` (optional ISO 8601 string) — when set, only workbooks updated on or after this date are staged; the set is a recent-changes slice, not the full workspace. Do not infer that absent workbooks were deleted.

`sigma-manifest.json` also reflects any active `dataModelFilter`. When `dataModelFilter.updatedSince` was set during fetch, `dataModelCount` reflects only matching models, not the full workspace. Do not infer that absent data models were deleted.

Read `sigma-projection-config.json` first and keep `workbookFilter` in scope while processing the WorkUnit.

## Required workflow

1. Read every `rawFiles` entry for the WorkUnit.
2. Read `sigma-projection-config.json` from the staged dir to get `connectionMappings`.
3. For each data model file: extract business semantics from element names, column descriptions, and the domain context of the model. Skip hidden elements and hidden columns.
4. For each workbook file: extract business domain knowledge from the name and description. When `workbookFilter.updatedSince` is set, treat the staged set as a recent-changes slice — absent workbooks were not deleted, they were simply outside the filter window.
5. Use `discover_data` before writing to find existing wiki pages on the same topic.
6. Write wiki candidates with `context_candidate_write`. Do not call `wiki_write` directly from a Sigma WorkUnit; Stage 4 reconciliation promotes candidates.
7. Do not write or edit SL sources. The `project()` step owns all SL output for Sigma.

## Identifier Verification Protocol

Before writing a wiki page or SL source on any topic:

1. `discover_data({query: "<topic>"})` - see what wikis, SL sources, and raw
   tables already exist. Prefer updating existing pages over creating new ones.

Before emitting any `schema.table` or `schema.table.column` into a wiki body,
SL source, `tables:` frontmatter, `sl_refs`, or `emit_unmapped_fallback`:

2. `entity_details({connectionId, targets: [{display: "<identifier>"}]})` -
   confirm the identifier resolves; inspect native types, FK/PK, and
   sampleValues. Use the warehouse `connectionId` from `connectionMappings` in
   `sigma-projection-config.json`, not the Sigma connection ID. If
   `connectionMappings` has no entry for the element's `source.connectionId`,
   skip `entity_details` — there is no mapped warehouse to verify against —
   and wrap any identifier references with `[unverified - from <rawPath>]`.
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

## Data model elements

### Warehouse-table elements (`source.kind === "warehouse-table"`)

`project()` writes an SL source for a warehouse-table element **only when** the element's `source.connectionId` has an entry in `connectionMappings`. When no mapping exists, no SL source is written and the element is wiki-only.

To determine whether an SL source exists: check whether `connectionMappings[element.source.connectionId]` resolves. If it does, use `sl_discover` to find the source by its slugified name (`<dataModelName>_<elementName>`), then:

- Read the existing SL source with `sl_read_source` to understand what columns and measures are captured.
- Write a wiki candidate about the business domain if the element name, column descriptions, or data model description reveals durable knowledge not already in the wiki.
- `sl_refs` in the wiki candidate should point to the already-written SL source name.

If `connectionMappings` has no entry for the element's `source.connectionId`, treat the element as wiki-only — do not attempt `sl_discover` or `sl_read_source` for it, as no source was written.

### Joins within a data model

Joins are not projected in v1; `joins: []` is always written by `project()`. `Lookup()` formulas may be described in wiki prose instead.

### Non-warehouse elements (`source.kind === "table"`)

These reference another element by `elementId` — they are derived views layered on top of a warehouse-table element. They have no warehouse path of their own. Do not attempt SL writes for these elements. They may produce wiki candidates if their column names or descriptions reveal business semantics not captured by the underlying warehouse-table element.

## Workbooks

Workbooks have summary metadata only. There is no spec endpoint.

Extract business domain knowledge from:
- `name`: the workbook's primary topic (e.g. "ARR Tracker" → ARR tracking concepts)
- `description`: business context and intended audience
- `path`: team or functional area (e.g. `Finance/Dashboards`)

Write wiki candidates when the name or description reveals a reusable business concept, metric definition, or domain convention. Write one candidate per distinct concept, not one per workbook.

Skip workbooks whose name or description contains no durable business semantics (e.g. "Untitled Workbook", "Test Dashboard").

## Capture rules

Write wiki candidates for:
- Metric definitions mentioned in element names or column descriptions (e.g. "Net ARR", "Churned MRR")
- Domain conventions such as cohort definitions, segment taxonomies, or fiscal calendar rules
- Relationships between business entities revealed by data model joins

Skip:
- Visualization settings, layout, colors, chart types
- Owner names, folder paths, and version numbers as wiki narrative
- Hidden elements and hidden columns
- Data model names that are purely technical with no business meaning
- When `workbookFilter.includeExplorations` is `false` (the default), all staged workbooks are intentional reports — no extra exploration filter needed. When it is `true`, workbooks without a description or with a generic auto-generated name are likely ephemeral explorations; skip those.

## Usage signals

Sigma workbooks carry `latestVersion` but no usage counts. Treat a higher `latestVersion` as weak evidence of continued maintenance; do not include version numbers in wiki prose.
