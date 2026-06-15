# Schema scan must tolerate individual objects that fail introspection

> Priority: MEDIUM. Found during the first full Spider2-lite sqlite ingest
> (2026-06-13): one database (`oracle_sql`) failed to ingest **entirely**
> because a single broken VIEW errored during introspection, leaving that
> connection with no semantic layer at all.

## Problem

`ktx ingest <connection>` aborts the whole database's schema scan when one
table/view errors during introspection/profiling. In `oracle_sql` the view
`emp_hire_periods_with_name` is defined as
`SELECT ehp.start_date, ehp.end_date ... FROM emp_hire_periods ehp ...` but the
base table has no `start_date`/`end_date` columns — so any attempt to read it
raises `no such column: ehp.start_date`. That single broken object failed the
ingest of all ~48 healthy tables/views in the database.

A second, related symptom: setting `enabled_tables: [main.customers]` to work
around it produced a different hard failure (`Adapter "database schema" did not
recognize fetched source output`), so the documented allowlist escape hatch did
not provide a clean fallback either.

## Generic use case

Real databases routinely contain broken or inaccessible objects: views over
dropped/renamed columns, views referencing tables the connection role can't
read, permission-denied tables, or vendor system views that error. ktx should
ingest everything it *can* and skip what it can't — never let one bad object
zero out an entire connection's context. This is basic robustness for
production warehouses, not benchmark-specific.

## Requirements

1. **Per-object isolation.** If introspecting/profiling one table or view
   throws, skip that object, record a warning (object name + error), and
   continue scanning the rest. The connection's semantic layer is built from
   the objects that succeeded.
2. **Surface, don't hide.** Report skipped objects in the ingest summary and in
   `ktx status` (e.g. "oracle_sql: 1 object skipped — emp_hire_periods_with_name:
   no such column ehp.start_date"). Honor `failureMode` for whole-connection
   aborts, but a single bad object should not count as a connection failure.
3. **Views vs tables.** A broken view should never block base-table ingest.
   Consider profiling views defensively (they are read-only projections).
4. **Allowlist fallback should work.** `enabled_tables` should reliably restrict
   the scan to the listed objects (and the qualification format for sqlite must
   be documented and accepted). Fix the `did not recognize fetched source
   output` failure when the allowlist yields a small/edge-case set.

## Acceptance criteria

- Ingesting a sqlite DB containing one broken view plus N healthy tables yields
  a semantic layer for the N healthy tables and a warning naming the broken view
  — exit is success (not "failed"), subject to `failureMode`.
- The skipped object is listed in the ingest summary and `ktx status`.
- `enabled_tables` restricted to a subset ingests exactly that subset without the
  adapter-output error.

## Benchmark context (motivation only)

`oracle_sql` (8 of the 135 sqlite questions) currently has no semantic layer
because of its one broken view; those questions must be solved from raw
`sql`-tool introspection instead of ktx's enriched context. Tolerant scanning
would restore enriched context for that database.
