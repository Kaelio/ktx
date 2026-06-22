# 18 — BigQuery cross-project dataset support (introspect foreign-hosted datasets, bill in own project)

**Status:** intake draft (todo). Requirement-level; the implementer refines into `specs/18-…`.

## Problem (generic, real-world)

Analysts routinely query datasets that live in a **different** BigQuery project than the one
they bill jobs to — Google's `bigquery-public-data`, a partner's shared project, an
organization's central data project, etc. To make those connectable in ktx (so `discover_data`,
the semantic layer, dictionary sampling, and `sql_dialect_notes` work), ktx must be able to
**introspect a dataset hosted in a foreign project while running/billing jobs in the
credentials' own project**.

Today it can't. ktx's BigQuery connector derives a single `projectId` from
`credentials.project_id` and uses it for **both** job billing **and** schema introspection:

- `connectors/bigquery/connector.ts:294` — `projectId` is read only from `credentials.project_id`;
  there is no separate billing-vs-dataset project knob.
- `:544` (`introspectDataset`) — calls `this.getClient().dataset(datasetId)`, which resolves the
  dataset **in the client's (billing) project**, and labels every table `catalog: this.resolved.projectId`.
- `:453` (`listTables`) — queries `\`${projectId}\`.\`region-…\`.INFORMATION_SCHEMA.TABLES`, i.e. the
  **billing** project's INFORMATION_SCHEMA.
- `:163` (`datasetIds()`) — returns `dataset_ids` verbatim; it never parses a `project.` prefix.

So a `dataset_id` naming a dataset in another project can't be introspected, even though querying
it works fine (cross-project reads bill to the caller's project — that path already works).

### Empirical confirmation
With a service account in project `ktx-spider2-lite`:
- ktx's call pattern `client.dataset("austin_311")` → **`404 NotFound`** (looks in
  `projects/ktx-spider2-lite/datasets/austin_311`).
- The cross-project form `DatasetReference("bigquery-public-data","austin_311")` → **succeeds**
  (lists the public tables; public metadata is readable by any authenticated principal).
- There is **no config knob** to separate the introspection project from the billing project.

## Requirement

The BigQuery connector must accept **fully-qualified `project.dataset` entries** in `dataset_ids`
(a single connection may span more than one source project), and for each:
- **introspect** via the *dataset's* project — `client.dataset(id, { projectId })` /
  `DatasetReference(project, dataset)`, query the **dataset project's** `INFORMATION_SCHEMA`, and
  label the table `catalog` with the dataset's project;
- **run jobs / bill** in `credentials.project_id` (unchanged).

A bare `dataset` (no `project.`) keeps today's behavior (resolve in `credentials.project_id`), so
existing single-project connections are unaffected.

## Acceptance

- `dataset_ids: ['bigquery-public-data.austin_311']` (credentials in a *different* project) →
  `ktx ingest <conn>` introspects the tables, enriches, and samples values; `discover_data` /
  `dictionary_search` return them.
- A connection mixing `['bigquery-public-data.x', 'other-project.y']` introspects both.
- `sql_execution` of a fully-qualified `project.dataset.table` query still runs and bills in
  `credentials.project_id`.
- Single-project `dataset_ids: ['my_dataset']` behaves exactly as before (no regression).

## Benchmark context (motivation only — do not encode benchmark specifics)

Spider 2.0-Lite's **BigQuery slice (205 questions)** is otherwise **unservable faithfully**: every
one of its ~74 logical databases groups datasets hosted in foreign public projects
(`bigquery-public-data`, `isb-cgc-bq`, `data-to-insights`, …), never in a project we own. Query
execution already works cross-project (proven), but ktx-only *discovery* (the whole point of the
faithful surface) is blocked because the connector can't introspect them. Scope is small: of 74
BQ dbs only **1** spans more than one source project, so "let `dataset_ids` carry `project.dataset`
and introspect each in its own project" covers the benchmark and the general case alike. This is
the sole blocker for the BigQuery leaderboard slice (the Snowflake slice needed no connector
change and is already baselined).
