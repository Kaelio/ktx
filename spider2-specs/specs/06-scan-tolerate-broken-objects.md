# Schema scan tolerates individual objects that fail introspection

> Refined spec. Intake draft: `todo/06-scan-tolerate-broken-objects.md`.

## Problem

A single broken or inaccessible object zeroes out an entire connection's
context. Schema introspection iterates objects with no per-object error
handling, so one throw aborts the whole scan, the live-database adapter's
`fetch()` rejects, and the connection ends with **no semantic layer at all** —
even when every other object was healthy.

The failure surfaces in two phases, and the contract must hold in both:

- **Metadata read (sqlite).** `connectors/sqlite/connector.ts` does
  `rawTables.map((t) => this.readTable(...))` (≈ line 171) with no try/catch.
  `readTable` runs `PRAGMA table_info(<object>)`, which *executes* a view's
  body to resolve its columns — so a view over a dropped/renamed column (the
  `oracle_sql` case: `emp_hire_periods_with_name` selecting `ehp.start_date`
  from a base table that has no such column) raises `no such column:
  ehp.start_date` and aborts introspection of all ~48 healthy objects.
- **Profiling read (warehouse drivers).** postgres/mysql/clickhouse/sqlserver/
  bigquery/snowflake read metadata in bulk from catalog / `information_schema`
  (a broken view rarely breaks that), then fail when a per-object profiling or
  sampling `SELECT` runs against a broken object. Enrichment sampling is
  *already* isolated (`description-generation.ts` wraps `sampleTable` in
  try/catch → `sampling_failed`), but mandatory introspection-phase reads are
  not uniformly isolated across drivers.

A second, related defect blocks the documented escape hatch. Setting
`enabled_tables: ["main.customers"]` on a sqlite connection produces a
different hard failure — `Adapter "database schema" did not recognize fetched
source output`. Root cause: the sqlite connector emits every object as
`{ db: null }` and filters the scope with `scopedTableNames(scope, { db: null })`
(`context/scan/table-ref.ts` ≈ line 47, `if (ref.db !== wantDb) continue`), but
`"main.customers"` parses to `{ db: "main", name: "customers" }`
(`context/scan/enabled-tables.ts`, `parseDottedTableEntry`). `"main" !== null`,
so the entry matches **nothing**, zero table files are written, and
`detectLiveDatabaseStagedDir` (`stage.ts` ≈ line 138) returns false, tripping
the generic "did not recognize fetched source output" error at
`context/ingest/local-stage-ingest.ts` (≈ line 291). The bare form
`enabled_tables: ["customers"]` would have worked; the `main.`-qualified form
silently matches nothing.

## Generic use case

Real warehouses routinely contain broken or inaccessible objects: views over
dropped/renamed columns, views referencing tables the connection role can't
read, permission-denied tables, and vendor system views that error on read.
**ktx** should ingest everything it *can* and skip what it can't, so one bad
object never zeroes out an entire connection's context. This is baseline
production robustness, independent of any benchmark — the same tolerance a
33-warehouse fleet needs the first time one of its databases has a stale view.

## Design

The unit of failure is **one object** (table or view). Introspecting or
profiling an object is an operation that can fail independently; a failure skips
that object, records a recoverable warning, and the scan continues from the
objects that succeeded.

Because seven Node connectors and the Python daemon each introspect differently
(sqlite reads metadata per-object via `PRAGMA`; warehouse drivers read metadata
in bulk and fail per-object during profiling), the **semantics** of "skip /
warn / total-failure" are defined **once** and every connector routes through
them — rather than seven copies of the same try/catch that drift apart:

- A shared per-object helper in the `scan/` layer — the sibling of the existing
  `tryConstraintQuery` (`context/scan/constraint-discovery.ts`) — wraps a single
  object read and returns `{ ok: true, table } | { ok: false, warning }`, with a
  standard warning code (e.g. `object_introspection_failed`).
- A shared post-check enforces the total-failure rule (R3) uniformly.
- Each connector keeps its **natural** shape: sqlite routes each `readTable`
  through the helper; bulk-read drivers route their per-object profiling reads
  through it. The contract is uniform; the loop is not forced to be.
- The Python daemon implements the **same contract** in its own helper, adds a
  `warnings` field to `DatabaseIntrospectionResponse`, and the Node adapter maps
  those warnings into `KtxSchemaSnapshot` (`daemon-introspection.ts`).

The warning channel already exists end to end on the Node side
(`KtxSchemaSnapshot.warnings`, the `KtxScanWarning` shape with `table`/`column`/
`recoverable`, the `KtxScanWarningCode` enum, and the staged `warnings.json`
artifact written by `writeLiveDatabaseSnapshot`); sqlite simply never populates
it. This spec makes that channel carry object-skip warnings and surfaces them in
the ingest summary, the persisted report body, and `ktx status`.

## Requirements

### R1 — Per-object isolation (the contract)

If introspecting or profiling one object throws, the scan **MUST** skip that
object, record a `KtxScanWarning` (object name, the error message, and any
schema/catalog qualifier; `recoverable: true`), and continue with the remaining
objects. No single object may abort the scan.

- The contract holds in **both** phases: the mandatory metadata read *and* any
  profiling/row-count/sample read performed during introspection.
- It holds for **all seven Node connectors**
  (`packages/cli/src/connectors/<driver>/`) and the **Python daemon** postgres
  path (R6).
- The semantics are defined once (the shared helper + warning code from the
  Design section) and every connector routes through them. Do not inline a
  divergent per-driver copy.
- Warnings **MUST NOT** carry secrets or full SQL bodies; record the object
  identifier and the database's error text, redacted through the existing
  `redactKtxSensitiveMetadata` path that `warnings.json` already uses.

### R2 — Surface, don't hide

Skipped objects **MUST** be reported both at ingest time and in the durable
status view:

- **Ingest summary.** The `ktx ingest` run summary (human-facing output) reports
  a count plus the object name and a short reason for each skip — e.g.
  `Skipped 1 object — emp_hire_periods_with_name: no such column ehp.start_date`.
- **Run report.** Object skips land in the run report's `warnings.json` artifact
  (already written) and in the persisted report body (`IngestReportBody`), whose
  natural home is the existing `fetch?: SourceFetchReport` field — the fetch
  phase *is* introspection.
- **`ktx status`.** `ktx status` shows a per-connection skipped-objects line for
  the connection's latest ingest — e.g. `oracle_sql: 1 object skipped —
  emp_hire_periods_with_name: no such column ehp.start_date`. This is **derived
  from the latest persisted report, not new persisted state**: the report body
  is already stored whole as a JSON blob (`local_ingest_reports.body_json`), so
  surfacing it requires **no `.ktx/db.sqlite` schema migration** — `status`
  reads and renders the skip info already present in the latest report body. A
  connection whose latest ingest skipped nothing shows no such line.

### R3 — Failure semantics (partial vs total)

Per-object skipping is **unconditional** — there is **no new config knob**, and
the existing `ingest.workUnits.failureMode` (which governs the later LLM
work-unit stage, not introspection) is untouched and orthogonal. Outcomes are
derived from object counts, not from a mode:

| Scope | Objects discovered / matched | Introspection outcome | Result |
| --- | --- | --- | --- |
| none | 0 | n/a (legitimately empty DB) | **success**, empty layer |
| none | N > 0 | ≥ 1 succeeds | **success** + warnings for the rest |
| none | N > 0 | all N fail | **connection failure** (clear error) |
| `enabled_tables` | matches 0 objects | n/a | **clear scope error** (R5) |
| `enabled_tables` | matches M > 0 | ≥ 1 succeeds | **success** + warnings |
| `enabled_tables` | matches M > 0 | all M fail | **connection failure** |

- "Connection failure" means the connector / `fetch()` raises a **clear,
  actionable error** for that connection. It **MUST NOT** surface as the generic
  `did not recognize fetched source output` (that message is reserved for a
  genuinely unrecognized staged dir, not an empty/total-failure result).
- A total failure of one connection follows existing per-connection ingest
  orchestration for whether sibling connections continue; this spec does not
  change cross-connection behavior.

### R4 — A broken view never blocks base tables

A broken view **MUST NEVER** prevent base-table ingest.

- View introspection failures are isolated exactly like any other object (R1).
- Mandatory introspection **MUST** prefer reading an object's structure from the
  catalog where possible over executing the object's body, and **MUST NOT** run
  a data-reading query (row count, sample) against a view as a required step.
  (sqlite already skips `COUNT(*)` for views; the remaining gap is isolating the
  metadata read that executes the view definition.)

### R5 — `enabled_tables` allowlist works

The documented allowlist escape hatch **MUST** reliably restrict the scan to the
listed objects, with no spurious adapter error:

- **sqlite qualification.** The schema-qualified form `"main.<name>"` **MUST**
  resolve to the same object as the bare form `"<name>"` (sqlite's sole schema
  is `main`; the connector emits `db: null`). Both forms select the object;
  neither silently matches nothing.
- **Documented format.** The accepted qualification forms for each driver
  (`catalog.db.name` / `db.name` / `name`) and the sqlite-specific `main`
  equivalence **MUST** be documented where `enabled_tables` is described
  (`context/project/driver-schemas.ts` and the user-facing config docs).
- **Zero-match is a clear error.** A non-empty `enabled_tables` that resolves to
  **zero** matched objects **MUST** fail with an actionable error naming the
  connection, the unmatched entries, and the available object names — **not** the
  generic `did not recognize fetched source output`. This is distinct from a
  legitimately empty database (R3 row 1) and from a matched-but-all-broken scope
  (R3 last row).
- **Any subset works.** An `enabled_tables` matching M > 0 objects ingests
  **exactly** those M objects (minus any that fail per R1), with no adapter
  recognition error regardless of how small or edge-case the set is.

### R6 — Python daemon parity

The daemon's postgres introspection path **MUST** honor the same contract:

- Add a `warnings` field to `DatabaseIntrospectionResponse`
  (`python/ktx-daemon/src/ktx_daemon/database_introspection.py`) carrying the
  same shape Node expects (code, message, object identifier, recoverable).
- Isolate per-object failures in the daemon's introspection so one broken object
  does not abort the response; apply the R3 total-failure rule there too.
- Map daemon warnings into `KtxSchemaSnapshot.warnings` in
  `mapDaemonSnapshot` (`context/ingest/adapters/live-database/daemon-introspection.ts`),
  which currently drops them.
- The Node and Python warning shapes **MUST** stay in parity (the codebase
  already mirrors Node↔Python schemas for telemetry; follow the same discipline
  so the daemon cannot emit a code Node can't render).

## Acceptance criteria

- Ingesting a sqlite DB with one broken view + N healthy tables yields a
  semantic layer for the N healthy tables and **exactly one** warning naming the
  broken view and its error; exit is **success**.
- The skipped object appears in the `ktx ingest` summary output, in the run's
  `warnings.json`, and in `ktx status` as a per-connection skipped-objects line
  on the connection's latest ingest.
- A sqlite DB in which **every** discovered object fails introspection (and the
  file opens) exits as a **connection failure** with a clear error — not an
  empty "success" and not `did not recognize fetched source output`.
- A genuinely empty sqlite DB (zero objects) exits **success** with an empty
  layer (not a failure).
- `enabled_tables: ["main.customers"]` and `enabled_tables: ["customers"]` both
  ingest exactly the `customers` object on a sqlite connection.
- `enabled_tables` restricted to a valid subset of M objects ingests exactly
  that subset, with **no** adapter-output error.
- `enabled_tables` that matches zero objects fails with an error naming the
  connection, the unmatched entries, and available objects — distinguishable
  from the empty-DB and all-broken cases.
- A broken view does not prevent ingest of base tables in the same connection
  (regression test with a view that errors on read alongside a healthy table).
- The daemon's `DatabaseIntrospectionResponse` carries a `warnings` array, and a
  per-object failure in the daemon path produces a warning mapped into
  `KtxSchemaSnapshot.warnings` (Node↔Python parity test).
- A warehouse-driver object whose profiling/sample read fails is skipped with a
  warning and does not abort introspection of its siblings.
- Existing healthy-only ingests (no broken objects, no `enabled_tables`) behave
  identically before/after — no warnings, same semantic layer.

## Implementation orientation

Line numbers drift; treat these as anchors, not addresses. The implementer owns
the design.

- **Shared semantics:** `context/scan/constraint-discovery.ts`
  (`tryConstraintQuery` / `constraintDiscoveryWarning` — the precedent to mirror
  for the per-object helper), `context/scan/types.ts`
  (`KtxSchemaSnapshot.warnings`, `KtxScanWarning`, `KtxScanWarningCode` — add the
  new object-skip code here).
- **Node connectors:** `packages/cli/src/connectors/<driver>/connector.ts` and
  each `live-database-introspection.ts`. sqlite's loop is
  `connectors/sqlite/connector.ts` `introspect` (≈ line 158) → `readTable`
  (≈ line 306); the missing try/catch is the `rawTables.map(...)` at ≈ line 171.
  Existing per-table sample isolation precedent: `description-generation.ts`
  (≈ line 867, `sampling_failed`).
- **Driver dispatch:** `packages/cli/src/local-adapters.ts` (≈ lines 122-156)
  routes every driver to its Node connector; the daemon is the `else` fallback.
- **`enabled_tables` matching:** `context/scan/enabled-tables.ts`
  (`resolveEnabledTables`, `parseDottedTableEntry`), `context/scan/table-ref.ts`
  (`scopedTableNames`, the `ref.db !== wantDb` filter ≈ line 47),
  `context/project/driver-schemas.ts` (`enabled_tables` schema + description).
- **Staging / detect / error surface:**
  `context/ingest/adapters/live-database/stage.ts`
  (`writeLiveDatabaseSnapshot`, `warningArtifact` ≈ line 94,
  `detectLiveDatabaseStagedDir` ≈ line 138),
  `context/ingest/local-stage-ingest.ts` (the
  `did not recognize fetched source output` throw ≈ line 291 — must stop being
  the surface for empty-scope and total-failure).
- **Ingest summary:** `packages/cli/src/ingest.ts` (`writeReportStatus`
  ≈ line 202), `context/ingest/memory-flow/summary.ts`
  (`formatMemoryFlowFinalSummary`) — thread object skips into the human-facing
  summary.
- **Report body + `ktx status`:** `context/ingest/reports.ts` (`IngestReportBody`;
  `SourceFetchReport` as the home for scan warnings),
  `context/ingest/sqlite-local-ingest-store.ts` (the report body is persisted
  whole as `body_json` ≈ line 90 — no migration needed), `status-project.ts`
  (`buildLocalStatsStatus` reads `local_ingest_reports`; parse the latest body
  per connection and render the skipped line via `renderLocalStatsAsLines`).
- **Daemon path:** `python/ktx-daemon/src/ktx_daemon/database_introspection.py`
  (`DatabaseIntrospectionResponse` ≈ line 165, `introspect_database_response`
  ≈ line 323, `_load_postgres_rows` ≈ line 227, `_map_rows_to_tables`
  ≈ line 267), and the Node mapping in
  `context/ingest/adapters/live-database/daemon-introspection.ts`
  (`mapDaemonSnapshot` ≈ line 209).

## Benchmark context (motivation only)

`oracle_sql` (8 of the 135 local sqlite questions) currently has **no** semantic
layer because of its one broken view, so those questions fall back to raw
`sql`-tool introspection instead of ktx's enriched context. Tolerant scanning
restores enriched context for that database. The same robustness is required for
the full Spider 2.0-Lite run across BigQuery and Snowflake, where broken or
permission-restricted objects are common and a single one must not zero out a
warehouse's context.

## Implementation notes

Shipped on branch `write-feature-spec-wiki`. All requirements implemented;
verified with `pnpm --filter @kaelio/ktx run test` (2981 passing),
`pnpm run dead-code`, `uv run pytest python/ktx-daemon/tests` (97 passing),
`uv run pre-commit`, and `pnpm run build && pnpm run link:dev`.

**Shared semantics (R1).** New `context/scan/object-introspection.ts` exposes
`tryIntrospectObject(ctx, fn)` (sibling of `tryConstraintQuery`), returning
`{ ok, table } | { ok: false, warning }` and building an
`object_introspection_failed` warning (object name + redactable DB error). It
rethrows native programming faults (`isNativeProgrammingFault`) so a ktx bug is
never masked as an object skip. The new warning code was added to
`KtxScanWarningCode` (`scan/types.ts`), the `scanWarningCodes` allowlist
(`local-structural-artifacts.ts`, plus a new exported `isKtxScanWarningCode`
validator), and `describeWarningGroup` (`scan.ts`).

**Per-object isolation, where it actually exists (R1/R4).** Only sqlite
(`readTable` via `PRAGMA`) and bigquery (`tableRef.get()` per dataset) do
per-object reads during *mandatory* introspection; both now route each object
through `tryIntrospectObject`. The other five Node connectors (postgres, mysql,
clickhouse, sqlserver, snowflake) read metadata in bulk from the catalog/
`information_schema` (already object-safe at this phase) and isolate per-object
profiling/sampling in the enrichment phase (`description-generation.ts`,
`sampling_failed`), so no divergent per-driver try/catch was added there. sqlite
also tolerates a `COUNT(*)` (profiling) failure without dropping a
structurally-readable table, and a broken view's metadata read is isolated so it
never blocks base tables (R4).

**Single-source outcome decision (R3/R5).** New
`adapters/live-database/scan-outcome.ts#assertLiveDatabaseScanOutcome` runs once
in `LiveDatabaseSourceAdapter.fetch()` — the one path every driver (and the
daemon) routes through — and derives the outcome from the snapshot + scope:
≥1 object → success (skips ride along as warnings); all matched objects failed →
clear `KtxExpectedError`; non-empty `enabled_tables` matched nothing → clear
zero-match error naming the connection, the requested entries, and the available
objects (sqlite/bigquery attach the discovered inventory via
`metadata.discovered_object_names`); empty database (no scope) → success with an
empty layer. `detectLiveDatabaseStagedDir` no longer requires table files, so a
valid empty staging is recognized; total-failure/zero-match now throw a clear
connection error before staging instead of surfacing the generic
`did not recognize fetched source output`.

**`enabled_tables` matching (R5).** Normalized at the scope boundary in
`resolveEnabledTables` using `connection.driver`: for sqlite, `main.<name>` →
`{ db: null }`, so `"main.customers"` and `"customers"` select the same object.
`table-ref.ts` stayed generic. Documented in `driver-schemas.ts` and
`docs-site/.../configuration/ktx-yaml.mdx`.

**Surfacing (R2).** Deviation from the spec's orientation: live-database schema
ingest runs through the **stage-only** path (`runLocalStageOnlyIngest` →
`local_ingest_reports`), not the bundle runner, so the home for scan warnings is
`LocalIngestRunRecord.fetch` (a new `SourceFetchReport` field; `body_json` is
persisted whole, so **no migration**), not the bundle-only
`IngestReportBody.fetch`. Both ingest paths read `adapter.readFetchReport`
(`live-database/fetch-report.ts` derives skips from the existing `warnings.json`).
The ingest summary is already rendered by `runKtxScan` from `report.warnings`
(the new `describeWarningGroup` case), and `ktx status`
(`status-project.ts#buildLocalStatsStatus`/`renderLocalStats`) now parses the
latest report body per connection and prints a per-connection
`N object(s) skipped — name: reason` line.

**Daemon parity (R6).** `database_introspection.py` adds a `warnings` field to
`DatabaseIntrospectionResponse` and a `DatabaseIntrospectionWarning` model,
isolates per-object failures in `_map_rows_to_tables`, and shares the
`OBJECT_INTROSPECTION_FAILED_CODE = "object_introspection_failed"` string with
Node. `mapDaemonSnapshot` maps `raw.warnings` into `KtxSchemaSnapshot.warnings`,
dropping any code Node cannot render (validated via `isKtxScanWarningCode`).
Deviation: the daemon does **not** re-enforce the R3 total-failure rule — the
shared Node post-check (`assertLiveDatabaseScanOutcome`) owns it for every driver
including the daemon, avoiding a divergent second implementation. Parity is
covered by a Node test (daemon-shaped warning round-trips) and a pytest
(per-object failure → warning with the shared code).
