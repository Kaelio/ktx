---
name: tableau_ingest
description: Extract durable ktx wiki knowledge from staged Tableau published data sources (fields, calculated fields) and workbook summaries. Load for WorkUnits with unitKey tableau-datasources or tableau-workbooks.
callers: [memory_agent]
---

# Tableau Ingest

Tableau ingest turns staged published-data-source definitions and workbook summaries into durable
ktx wiki knowledge. Each published data source is a graph-shaped semantic model: its fields
(including calculated fields with formulas) plus the upstream physical tables it draws from.

## Work unit structure

Tableau produces at minimum two work units per ingest run:

- `tableau-datasources` or `tableau-datasources-N`
  - `rawFiles`: `datasources/<luid>.json` files (one per published data source in this batch)
  - `peerFileIndex`: `workbooks/<luid>.json` files + `tableau-manifest.json` + `tableau-projection-config.json`
  - When the site has more than 50 data sources, split into batches: `tableau-datasources-0`,
    `tableau-datasources-1`, … with `displayLabel` like `"Tableau: data sources (1/8)"`. When ≤50,
    the unitKey is simply `tableau-datasources` with no suffix.
- `tableau-workbooks` or `tableau-workbooks-N`
  - `rawFiles`: `workbooks/<luid>.json` files (one per workbook in this batch)
  - `peerFileIndex`: `datasources/<luid>.json` files + `tableau-manifest.json` + `tableau-projection-config.json`
  - When the site has more than 2000 workbooks, split into batches: `tableau-workbooks-0`, … with
    `displayLabel` like `"Tableau: workbooks (1/4)"`. When ≤2000, the unitKey is simply
    `tableau-workbooks` with no suffix.

`tableau-manifest.json` and `tableau-projection-config.json` are never in `rawFiles`. They live at
the staged dir root and always appear in `peerFileIndex`.

## Staged file shapes

**`datasources/<luid>.json`** — one per published data source (in `rawFiles` for data-source units):
```json
{
  "luid": "ds-1",
  "name": "Revenue Model",
  "projectName": "Finance",
  "updatedAt": "2026-04-01T00:00:00Z",
  "hasExtracts": true,
  "description": "Published revenue data source",
  "fields": [
    { "name": "Order Amount", "role": "MEASURE", "dataType": "INTEGER", "isCalculated": false },
    {
      "name": "Net Revenue",
      "role": "MEASURE",
      "dataType": "REAL",
      "formula": "SUM([Gross Revenue]) - SUM([Refunds])",
      "description": "Gross revenue minus refunds",
      "isCalculated": true
    }
  ],
  "upstreamTables": [
    { "luid": "t-1", "name": "ORDERS", "schema": "PUBLIC", "fullName": "DEMO.PUBLIC.ORDERS" }
  ]
}
```

- `fields[]` — every field on the data source. `isCalculated: true` (equivalently, a non-empty
  `formula`) marks a Tableau **calculated field**; the `formula` is the business logic to capture.
  `role` is `DIMENSION` or `MEASURE`.
- `upstreamTables[]` — the physical warehouse tables the data source draws from (lineage). Use
  `fullName` / `schema` when verifying identifiers.

**`workbooks/<luid>.json`** — one per workbook (in `rawFiles` for workbook units; summary only):
```json
{
  "luid": "wb-1",
  "name": "ARR Tracker",
  "projectName": "Finance",
  "description": "Tracks ARR by segment and cohort for the finance team",
  "updatedAt": "2026-04-02T00:00:00Z"
}
```

**Peer files (available via `peerFileIndex`, not `rawFiles`):**

**`tableau-manifest.json`** — fetch summary; use for provenance only.

**`tableau-projection-config.json`** — written by `fetch()`; records the `datasourceFilter` /
`workbookFilter` that were active during the last fetch. When `updatedSince` was set, the staged set
is a recent-changes slice, not the full site — do not infer that absent data sources or workbooks
were deleted.

## Required workflow

1. Read every `rawFiles` entry for the WorkUnit.
2. Read `tableau-projection-config.json` from the staged dir to understand the fetch window.
3. For each data source file: extract business semantics from the data source name/description,
   field names, calculated-field formulas, and field descriptions. A calculated field's `formula`
   often encodes a governed metric definition worth capturing.
4. For each workbook file: extract business domain knowledge from the name and description. When a
   filter `updatedSince` is set, treat the staged set as a recent-changes slice.
5. Use `discover_data` before writing to find existing wiki pages on the same topic.
6. Write wiki candidates with `context_candidate_write`. Do not call `wiki_write` directly from a
   Tableau WorkUnit; Stage 4 reconciliation promotes candidates.

## Identifier Verification Protocol

Before writing a wiki page on any topic:

1. `discover_data({query: "<topic>"})` — see what wikis, SL sources, and raw tables already exist.
   Prefer updating existing pages over creating new ones.

Before emitting any `schema.table` or `schema.table.column` into a wiki body, `tables:` frontmatter,
`sl_refs`, or `emit_unmapped_fallback`:

2. `entity_details({connectionId, targets: [{display: "<identifier>"}]})` — confirm the identifier
   resolves; inspect native types, FK/PK, and sampleValues. Use a warehouse `connectionId` that
   covers the data source's `upstreamTables[].fullName`. If no warehouse connection covers it, skip
   `entity_details` and wrap any identifier references with `[unverified - from <rawPath>]`.
3. For literal values from a formula (status codes, plan tiers), check whether they appear in
   `entity_details` sampleValues for the relevant column. If sampleValues is short or may have missed
   real values, run a probe with the same warehouse connection id:
   `sql_execution({connectionId, sql: "SELECT DISTINCT <col> FROM <ref> LIMIT 50"})`.
4. If the candidate identifier still does not resolve, do one of:
   - Use `sql_execution({connectionId, sql: "SELECT 1 FROM <ref> LIMIT 0"})`. If it errors, the
     identifier is fictional.
   - Wrap the identifier in `[unverified - from <rawPath>]` in the wiki body, citing the exact raw
     path that mentioned it.
5. Never copy `<schema>.<table>` placeholder strings from these instructions into output.

## Capture rules

Write wiki candidates for:
- Metric definitions encoded in calculated-field names and formulas (e.g. "Net Revenue",
  "Churned ARR") — capture the business meaning, and the formula when it clarifies the definition.
- Domain conventions revealed by field names/descriptions (segment taxonomies, cohort or fiscal
  rules).
- Business concepts a workbook name/description reveals (e.g. "ARR Tracker" → ARR tracking). Write
  one candidate per distinct concept, not one per workbook.

Skip:
- Visualization settings, layout, colors, chart types.
- Owner names, project/folder paths, and version numbers as wiki narrative.
- Hidden or purely technical fields with no business meaning.
- Workbooks whose name/description carries no durable semantics (e.g. "Untitled", "Test Dashboard").

## Note on semantic-layer output

In this version the Tableau adapter does not run a deterministic `project()` step, so **no
semantic-layer YAML is written for Tableau** — all durable output is wiki knowledge. Do not claim an
SL source exists for a data source; reference upstream warehouse tables only via the verification
protocol above.
