# ktx examples

## local-warehouse

`local-warehouse/` is a contributor fixture for local CLI smoke tests. It uses
the internal fake ingest adapter so tests can exercise memory-flow behavior
without a live database or external service.

For normal context building, use the public connection-centric commands:

```bash
ktx ingest <connectionId>
ktx ingest --all
```

The copied project initializes its own Git repository on first use.

## orbit-relationship-verification

`orbit-relationship-verification/` is a checked-in **ktx** project used by
`pnpm run relationships:verify-orbit`. It points the `orbit` SQLite connection
at the Orbit-style no-declared-constraint relationship fixture and verifies that
relationship enrichment writes nine accepted joins without requiring a local
warehouse credential.

## mongodb

`mongodb/` is a manual container-backed example for the MongoDB connector. It
seeds a representative dataset (nested documents, arrays, a mixed-type field, a
nullable field, and a view), then exercises the connector as a fast no-LLM
introspection smoke (`scripts/smoke.sh`) and documents a full keyless
`ktx ingest` run. Works with Docker Compose or `podman compose`.

## postgres-historic

`postgres-historic/` is a manual Docker-backed smoke for Postgres
query-history ingest via `pg_stat_statements`. It verifies setup, staged
query-history artifacts, **ktx** daemon batch SQL analysis, bounded pattern
WorkUnit shards, and no-WorkUnit idempotency for unchanged bucketed table
inputs and pattern shards.

## package-artifacts

`package-artifacts/` documents the artifact smoke checks. Those checks create
temporary projects instead of storing sample projects in this directory.
