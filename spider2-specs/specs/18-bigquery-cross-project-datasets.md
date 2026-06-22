# BigQuery cross-project dataset introspection (foreign-hosted datasets, billed in own project)

> Refined spec. Intake draft: `todo/18-bigquery-cross-project-datasets.md`.
>
> **Scope: let the BigQuery connector introspect a dataset hosted in a *different*
> project than the one it bills jobs to.** A `dataset_ids` entry may be written
> fully-qualified as `project.dataset`; the connector introspects each entry in
> *its own* project while every job still runs in `credentials.project_id`. A
> bare `dataset` keeps today's single-project behavior unchanged.
>
> Out of scope (confirmed during refinement): the interactive `ktx setup` wizard
> is **not** expected to *discover* foreign datasets — you cannot enumerate
> datasets in a project you don't own, and the wizard doesn't know which foreign
> projects to probe. Users hand-write `project.dataset` entries (in `ktx.yaml` or
> at the dataset prompt); the connector must accept and introspect them. See
> *Non-goals*.

## Problem

**ktx**'s BigQuery connector derives a single `projectId` from
`credentials.project_id` and uses it for **both** job billing **and** schema
introspection. There is no way to introspect a dataset that lives in another
project, even though *querying* such a dataset already works (a cross-project
read in a `FROM` clause bills to the caller's project — that path is proven).

Confirmed in the current connector (`packages/cli/src/connectors/bigquery/connector.ts`):

- **`:294`** — `projectId` is read only from `credentials.project_id`. There is
  no separate billing-vs-dataset project. `bigQueryConnectionConfigFromConfig`
  (`:278`–`:301`) returns `datasetIds: string[]` — raw, unparsed.
- **`datasetIds()` (`:163`)** — returns `dataset_ids` / `dataset_id` verbatim;
  it never parses a `project.` prefix.
- **`introspectDataset` (`:544`)** — calls `this.getClient().dataset(datasetId)`,
  which resolves the dataset in the **client's (billing) project**, and labels
  every table `catalog: this.resolved.projectId` (`:566`, `:574`) — including the
  introspection-failure warning metadata (`:566`).
- **`primaryKeys` (`:591`)** — builds `INFORMATION_SCHEMA` SQL as
  `` `<projectId>.<datasetId>.INFORMATION_SCHEMA.TABLE_CONSTRAINTS` `` using the
  **billing** project.
- **`listTables` (`:453`)** — queries
  `` `<projectId>`.`region-<region>`.INFORMATION_SCHEMA.TABLES `` against the
  **billing** project and labels each row `catalog: this.resolved.projectId`.
- **`testConnection` (`:344`)** — calls `client.dataset(datasetId).get()` in the
  billing project.

### Empirical confirmation (from the intake draft)

With a service account in project `ktx-spider2-lite`:

- ktx's call pattern `client.dataset("austin_311")` → **`404 NotFound`** (it looks
  in `projects/ktx-spider2-lite/datasets/austin_311`).
- The cross-project form `dataset("austin_311", { projectId: "bigquery-public-data" })`
  → **succeeds** (public metadata is readable by any authenticated principal).
- There is **no config knob** to separate the introspection project from billing.

### Why the table `catalog` label is load-bearing, not cosmetic

The BigQuery dialect generates **three-part `catalog.db.name`** SQL
(`connectors/bigquery/dialect.ts:38` → `formatDialectTableName(..., 'three-part')`;
`context/connections/dialect-helpers.ts:27`–`32` emits `catalog.db.name`). The
`catalog` stored on each scanned table is therefore the project that *every*
later query targets — `sampleTable`, `sampleColumn`, `getColumnDistinctValues`,
and ref-based `executeReadOnly` all format the ref through the dialect. If a
foreign dataset's tables are labeled with the billing project, every one of those
queries becomes `` `billing-project`.`austin_311`.`table` `` → `404`. So labeling
the table `catalog` with the dataset's own project is a **correctness
requirement**, and it is the single lever that makes sampling, dictionary value
extraction, and `discover_data` all resolve once the snapshot is right.

### One introspection path, no divergence

`connectors/bigquery/live-database-introspection.ts` wraps
`KtxBigQueryScanConnector.introspect` directly, so the ingest and live-database
paths share **one** introspection implementation. The SDK already supports the
fix: `client.dataset(id, { projectId })` — `@google-cloud/bigquery@8.3.1`'s
`DatasetOptions` exposes `projectId?: string`.

## Generic use case (independent of any benchmark)

Analysts routinely introspect datasets they can **read but do not own and do not
bill to**: Google's `bigquery-public-data`, a partner's shared project, an
organization's central data project that a smaller team queries from its own
billing project. To make those connectable in **ktx** — so `discover_data`, the
semantic layer, dictionary sampling, and `sql_dialect_notes` all work — the
connector must introspect a foreign-hosted dataset while billing jobs in the
credentials' own project. This is a standard BigQuery deployment shape and is
wholly independent of any benchmark.

The class to design for is "the dataset's project ≠ the billing project," and it
must generalize beyond one example: a single connection may reference datasets in
**several** foreign projects at once (e.g. one slice mixing `bigquery-public-data`
and `isb-cgc-bq`), and two different projects may host datasets with the **same
name**. The design must keep those distinct.

## Design decisions (resolved during refinement)

These resolve ambiguities the intake draft left open. They constrain the
implementer; the exact code is theirs.

### Carry the project inline on each dataset entry — no separate knob

The introspection project is expressed **per dataset**, inline, as the optional
`project.` prefix on a `dataset_ids` / `dataset_id` entry. There is no new config
field.

> Rejected alternative: a separate connection-level `dataset_project` (or
> `introspection_project`) field. It is a speculative runtime knob (against the
> repo's opinionated-defaults rule) and, more decisively, it **cannot express the
> requirement**: one connection must span *multiple* foreign projects, which a
> single global field cannot represent. The inline form also derives scope from
> the user's own declared input rather than adding a parallel setting.

### Parse to canonical `{ project, dataset }` pairs at the config boundary

Each entry is parsed **once**, in `bigQueryConnectionConfigFromConfig` /
`datasetIds()`, into a canonical pair: the project (when no prefix is present,
default it to `credentials.project_id`) and the bare dataset id. Every
introspection-side call site reads the resolved pair; nothing downstream re-parses
a `project.dataset` string.

> Rejected alternative: keep `datasetIds: string[]` raw and split the prefix
> lazily at each use site (`introspectDataset`, `primaryKeys`, `listTables`,
> `testConnection`). That re-implements one rule in four places and is exactly the
> drift trap the repo's single-source-of-truth rule warns about — a later fix
> lands on one path and not another. Normalize at the boundary; carry the
> canonical form downstream.

The internal resolved-config type (`KtxBigQueryResolvedConnectionConfig.datasetIds`)
changes shape from `string[]` to a structured pair list. That is an internal type;
the connector internals and the connector test fixtures are the only consumers.

### Parsing rule (at the boundary)

- An entry contains **at most one `.`**.
- With a dot: the segment **before** the dot is the project, validated by the
  existing `normalizeBigQueryProjectId` charset
  (`context/connections/bigquery-identifiers.ts`); the segment **after** is the
  dataset id (validated as a normal identifier).
- Without a dot: a bare dataset; the project defaults to `credentials.project_id`
  (today's behavior).
- **More than one `.`** (e.g. a stray `proj.ds.table`) is a clear config error
  raised at resolution time, naming the connection — not a silent
  mis-introspection.
- Legacy domain-scoped project ids that contain `:` (e.g. `example.com:proj`) stay
  **out of scope**, consistent with `normalizeBigQueryProjectId`'s current charset
  (which already rejects `.` and `:` in a project id).

### Billing is never the dataset's project

The BigQuery client is still constructed with `projectId = credentials.project_id`
(`getClient()`, `:487`–`:495`), and `createQueryJob` always bills there. Only the
*introspection* surfaces switch to the per-dataset project. Cross-project reads in
a `FROM` clause already bill to the caller — unchanged and already proven.

### Dataset identity downstream is `(catalog, db)`

Scanned tables are keyed by `(catalog, db, name)` throughout
(`context/scan/table-ref.ts`; `context/scan/warehouse-catalog.ts:107`). Because
the table `catalog` now holds the dataset's own project, two foreign projects that
each host a `austin_311` dataset remain distinct with no extra work — provided the
snapshot's `scope` / `metadata` also preserve the project (Requirement 6).

### Setup-wizard scope: accept, don't discover

The connector's region-scoped `listTables` (`:453`) is consumed **only** by the
`ktx setup` wizard's table-selection step (`setup-databases.ts`); the
ingest / `discover_data` path reads persisted snapshot JSON via
`WarehouseCatalogService.listTables`, not the connector method. The wizard is not
expected to enumerate foreign datasets (you can't list a project you don't own).
A `project.dataset` value hand-entered at the dataset prompt, or written into
`ktx.yaml`, must be accepted, validated, and introspected. See *Non-goals* for the
region caveat that follows from this.

## Requirements

### R1 — Accept and parse `project.dataset` at the config boundary

`datasetIds()` / `bigQueryConnectionConfigFromConfig` resolve each
`dataset_ids` and `dataset_id` entry into a canonical `{ project, dataset }` pair
per the parsing rule above, defaulting `project` to `credentials.project_id` when
unprefixed. A malformed entry (more than one `.`, an empty project or dataset
segment, or a project/dataset that fails identifier validation) raises a clear
error at resolution time that names the connection id.

### R2 — Introspect each dataset in its own project

`introspectDataset` resolves the dataset via the **dataset's** project —
`client.dataset(datasetId, { projectId })` — for `getTables()` and each
`tableRef.get()`. This requires extending the `KtxBigQueryClient.dataset` port to
accept the project (e.g. `dataset(id, projectId)` / `dataset(id, { projectId })`)
and forwarding it from `DefaultBigQueryClientFactory`.

### R3 — Label table `catalog` with the dataset's project

Every table produced by `introspectDataset` is labeled `catalog: <dataset's
project>` (not the billing project), and the introspection-failure warning
metadata (`object` / `catalog`) likewise reflects the dataset's project. This is
what makes downstream sample/distinct-value/read queries resolve.

### R4 — Primary-key discovery targets the dataset's project

The `primaryKeys` `INFORMATION_SCHEMA.TABLE_CONSTRAINTS` /
`KEY_COLUMN_USAGE` SQL is built against
`` `<dataset's project>.<datasetId>.INFORMATION_SCHEMA…` ``. (This INFORMATION_SCHEMA
view is dataset-qualified and therefore region-independent.) Its existing
soft-fail-on-denied behavior (`tryConstraintQuery`, scan warning) is preserved.

### R5 — `listTables` lists each dataset in its own project

`listTables` returns rows labeled `catalog: <that dataset's project>` and queries
each referenced project's region `INFORMATION_SCHEMA.TABLES`. Because a connection
can now span projects, it queries per distinct project rather than assuming one.
(This is the setup-wizard surface — see the cross-region caveat in *Non-goals*.)

### R6 — Snapshot scope and metadata reflect multiple projects

`introspect`'s returned snapshot keeps `metadata.project_id` = the **billing**
project, but `scope.catalogs` becomes the **distinct set of dataset projects**
actually introspected. `scope.datasets` / `metadata.datasets` must stay
unambiguous when two projects share a dataset name (e.g. carry the qualified
`project.dataset`, or otherwise preserve the project). The scoped table-name
lookup that today passes `catalog: this.resolved.projectId` (`:359`) must pass
each dataset's own project so `tableScope` / `enabled_tables` filtering still
matches.

### R7 — `testConnection` resolves foreign datasets

`testConnection` validates each configured dataset via its own project
(`client.dataset(datasetId, { projectId }).get()`), so a connection pointing only
at foreign datasets reports success rather than a spurious `404`.

### R8 — Billing unchanged; bare dataset is a strict no-op

`createQueryJob` continues to bill in `credentials.project_id`. A connection whose
`dataset_ids` are all bare (no `project.` prefix) behaves **exactly** as before:
same resolved project, same `catalog` labels, same INFORMATION_SCHEMA targets, no
behavioral change.

### R9 — `getTableRowCount` honors the parsed entry

`getTableRowCount`'s default-dataset handling (`:431`, today
`this.resolved.datasetIds[0]`) resolves through the canonical pair so a foreign
default dataset is introspected in its own project.

### R10 — Docs reflect the qualified form

Document that a BigQuery `dataset_ids` / `dataset_id` entry may be written
`project.dataset` to introspect a dataset hosted in another project (billing stays
in `credentials.project_id`). Update the BigQuery rows/examples in
`docs-site/content/docs/configuration/ktx-yaml.mdx` and
`docs-site/content/docs/integrations/primary-sources.mdx` (and the dataset-scope
note in `docs-site/content/docs/cli-reference/ktx-setup.mdx`). Keep examples
copy-pasteable and follow the `fumadocs-mdx-structure` skill.

## Acceptance criteria

1. **Foreign single-project introspection.** With credentials in project
   `ktx-spider2-lite` and `dataset_ids: ['bigquery-public-data.austin_311']`,
   `ktx ingest <conn>` introspects the tables, enriches, and samples values;
   `discover_data` / `dictionary_search` return them. Tables are labeled
   `catalog: 'bigquery-public-data'`.
2. **Multi-project connection.** `dataset_ids: ['bigquery-public-data.x',
   'other-project.y']` introspects **both**, each under its own project; the
   snapshot's `scope.catalogs` contains both projects.
3. **Cross-project query still bills locally.** `sql_execution` of a
   fully-qualified `project.dataset.table` query runs and bills in
   `credentials.project_id`.
4. **Same dataset name, two projects.** `['proj-a.shared', 'proj-b.shared']`
   yields two distinct dataset groups; tables do not collide.
5. **No regression.** `dataset_ids: ['my_dataset']` (or singular `dataset_id`)
   behaves exactly as before — resolved under `credentials.project_id`, same
   `catalog` labels and INFORMATION_SCHEMA targets.
6. **Malformed entry fails clearly.** `dataset_ids: ['proj.ds.table']` (or an
   empty segment) raises a config error naming the connection, not a `404` at
   scan time.
7. **Test coverage** (extend `packages/cli/test/connectors/bigquery/connector.test.ts`,
   using the existing fake `clientFactory` harness):
   - the fake `dataset()` is called with the dataset's project for a prefixed
     entry, and with the billing project for a bare entry;
   - a prefixed entry yields tables with `catalog: '<dataset project>'`;
   - a mixed two-project `dataset_ids` introspects both;
   - `bigQueryConnectionConfigFromConfig` rejects a multi-dot / empty-segment
     entry;
   - the existing single-project tests still pass unchanged.

## Non-goals

- **Foreign-dataset discovery in the setup wizard.** The wizard does not
  enumerate datasets in projects the credentials don't own; users supply
  `project.dataset` explicitly (scope decision A).
- **Cross-region `listTables`.** `listTables`' region-scoped
  `region-<location>.INFORMATION_SCHEMA.TABLES` query uses the connection-level
  `location`; a foreign dataset in a *different* region than the connection's
  `location` will not be listed by that wizard-facing query. This does **not**
  affect ingest/`discover_data`, whose introspection path
  (`introspectDataset` REST metadata + dataset-qualified PK INFORMATION_SCHEMA) is
  region-independent. A per-dataset region knob is a separate spec if ever needed.
- **Domain-scoped legacy project ids** containing `:` (e.g. `example.com:proj`),
  already unsupported by `normalizeBigQueryProjectId`.
- **A separate billing/introspection config field** — explicitly rejected above.

## Implementation orientation

Pointers from exploration; line numbers may have drifted, and the implementer owns
the design.

- `packages/cli/src/connectors/bigquery/connector.ts`
  - `datasetIds()` (`:163`) and `bigQueryConnectionConfigFromConfig` (`:278`) —
    parse + canonicalize (R1); change `KtxBigQueryResolvedConnectionConfig.datasetIds`
    shape.
  - `KtxBigQueryClient.dataset` port (`:100`–`:110`) and
    `DefaultBigQueryClientFactory.dataset` (`:130`–`:135`) — thread `projectId`
    (R2). `getClient()` (`:487`) keeps the billing project (R8).
  - `introspectDataset` (`:544`) — `dataset(id, { projectId })`, table `catalog`
    + warning metadata (R2, R3).
  - `primaryKeys` (`:591`) — dataset-qualified INFORMATION_SCHEMA (R4).
  - `listTables` (`:453`) — per-project region INFORMATION_SCHEMA + row catalog
    (R5).
  - `introspect` (`:352`) — `scope.catalogs`, `scope.datasets`, scoped-name lookup
    (`:359`) (R6).
  - `testConnection` (`:339`) (R7); `getTableRowCount` (`:431`) (R9).
- `packages/cli/src/connectors/bigquery/live-database-introspection.ts` — wraps
  `introspect`; no separate change needed (it inherits the fix).
- `packages/cli/src/context/connections/bigquery-identifiers.ts` —
  `normalizeBigQueryProjectId` is the project-segment validator.
- `packages/cli/src/context/connections/dialect-helpers.ts` /
  `connectors/bigquery/dialect.ts` — three-part naming; no change, but this is
  *why* R3 matters.
- After implementing, rebuild and re-link so the playground picks it up:
  `pnpm run build && pnpm run link:dev`. Run
  `pnpm --filter @kaelio/ktx run type-check` and the connector test suite.

## Benchmark context (motivation, not a requirement — do not encode benchmark specifics)

Spider 2.0-Lite's **BigQuery slice (~205 questions)** is otherwise unservable
faithfully: every one of its ~74 logical databases groups datasets hosted in
foreign public projects (`bigquery-public-data`, `isb-cgc-bq`,
`data-to-insights`, …), never in a project we own. Query execution already works
cross-project; ktx-only *discovery* is the sole blocker, and it is blocked exactly
because the connector can't introspect a foreign-hosted dataset. Of 74 BQ
databases only **one** spans more than one source project, so "let `dataset_ids`
carry `project.dataset` and introspect each in its own project" covers the
benchmark and the general case alike. None of these project names belong in the
code — they are derived from the user's own `dataset_ids` input.

## Implementation notes

Implemented on branch `write-feature-spec-wiki`. The whole change is contained in
the BigQuery connector, its identifier helpers, the connector test suite, and three
docs pages.

**Config boundary (R1).** Added `normalizeBigQueryDatasetId`
(`packages/cli/src/context/connections/bigquery-identifiers.ts`, charset
`[A-Za-z0-9_]`) next to the existing project/region validators. In
`connectors/bigquery/connector.ts`, a single `parseBigQueryDatasetEntry(entry,
defaultProject, connectionId)` parses one entry by splitting on `.`: zero dots →
bare dataset in `defaultProject`; one dot → `project.dataset` (each segment
validated; empty segment throws); two or more dots → throws. `resolveDatasetRefs`
resolves `env:`/`file:` references first, trims/filters empties, then parses each.
`bigQueryConnectionConfigFromConfig` calls it with the billing `project_id` as the
default, so the canonical pair list is produced once at the boundary.
`KtxBigQueryResolvedConnectionConfig.datasetIds` changed from `string[]` to the new
`BigQueryDatasetRef[]` (`{ project, dataset }`). All errors name
`connections.<id>.dataset_ids entry "<entry>"`.

**Client port (R2).** `KtxBigQueryClient.dataset` now takes
`(datasetId, projectId)`; `DefaultBigQueryClientFactory` forwards
`client.dataset(datasetId, { projectId })` (`@google-cloud/bigquery` `DatasetOptions.projectId`).
`getClient()` still constructs the client with the **billing** `project_id`, so
`createQueryJob` bills locally regardless of the dataset's project (R8, acceptance 3).

**Per-dataset introspection (R3–R7, R9).** Every introspection site reads the
resolved pair: `introspectDataset(ref, …)` resolves `dataset(ref.dataset, ref.project)`
and labels tables (and the introspection-failure warning, via `tryIntrospectObject`'s
`catalog.db.object`) with `ref.project`; `primaryKeys(ref)` builds dataset-qualified
`` `<project>.<dataset>.INFORMATION_SCHEMA…` `` SQL; `testConnection` validates each
dataset under its own project; `getTableRowCount`'s default resolves through the first
pair. `introspect` sets `scope.catalogs` to the distinct set of dataset projects and
keeps `metadata.project_id` = billing. `scope.datasets` / `metadata.datasets` use a
`qualifiedDatasetLabel` helper — bare in the billing project (so the single-project
snapshot is byte-for-byte unchanged), `project.dataset` otherwise (so two projects with
the same dataset name stay distinct, R6/acceptance 4).

**`listTables` (R5).** Split into `listTables` (parse override entries, group by
project) and `listTablesInProject(project, region, datasets?)`. With no override it
lists the billing project's region (unchanged); with an override it runs one
region-`INFORMATION_SCHEMA.TABLES` query per distinct project, filtered to that
project's bare datasets, and labels rows with that project. The existing single-region
test is unchanged (bare entries collapse to one billing-project query).

**Docs (R10).** Added a "Cross-project datasets" subsection to
`integrations/primary-sources.mdx` (qualified-entry example + the setup/region caveats),
plus pointers from `configuration/ktx-yaml.mdx` and `cli-reference/ktx-setup.mdx`.

**Tests.** Extended `test/connectors/bigquery/connector.test.ts`: parse-to-pairs and
malformed-entry rejection (`proj.ds.table`, `proj.`, `.ds`); a foreign-only connection
calls `dataset('austin_311', 'bigquery-public-data')`, labels tables
`catalog: 'bigquery-public-data'`, builds the client with the billing project, and keeps
`metadata.project_id` local; a mixed `['bigquery-public-data.austin_311', 'analytics']`
connection introspects both under their own projects; and `['proj_a.shared',
'proj_b.shared']` stays distinct. The internal `datasetIds`-shape assertion was updated
to the pair list; all pre-existing behavioral tests pass unchanged.

**Verification.** `pnpm --filter @kaelio/ktx run type-check`, the connector suite
(18 tests), `test/setup-databases.test.ts` + `bigquery-identifiers.test.ts`,
`pnpm run build`, `pnpm run dead-code` (Biome + Knip default + production),
`pnpm run link:dev` (`ktx-dev` → 0.12.0), and `pre-commit` on the changed files all
pass. Acceptance criteria 1–4 are exercised by unit tests with the fake client factory;
criteria 5–6 by unit tests; criterion 3 (cross-project query bills locally) is
structurally guaranteed (single billing client) and asserted via the `createClient`
project. End-to-end ingest against live `bigquery-public-data` was not run here (no live
credentials in this worktree); the `link:dev` binary is ready for the playground agent to
validate.

**No deviations from the spec design.** The only judgment call: `scope.datasets`
renders bare-in-billing / qualified-otherwise rather than always-qualified, chosen to
satisfy both the no-regression requirement (R8/acceptance 5) and the disambiguation
requirement (R6/acceptance 4) with one unambiguous, dot-delimited form.
