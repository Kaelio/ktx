# Offline schema-documentation ingest adapter

> **Priority: LOW / backlog.** Explicitly **not** needed for the Spider
> 2.0-Lite benchmark — we verified the benchmark's offline schema files
> (DDL dumps + sample-row JSONs) are a strict subset of what the live SQLite
> scan already captures (DDL, types, PKs, sample values, cardinality
> profiling). Implement specs 01-03 first; pick this up only if a real
> use case shows up.

## Problem

The ingest pipeline's schema knowledge comes from live database scans
(`live-database` adapter) or BI-tool adapters (metabase, looker, dbt…).
There is no adapter for **offline schema documentation**: files describing
tables/columns that exist outside the database — column-description
spreadsheets, data dictionaries, DDL exports with comments, hand-maintained
schema docs.

## Generic use case

Teams whose richest schema documentation lives outside `information_schema`:
a wiki export of column meanings, a governance tool's CSV data dictionary,
DDL files with COMMENT clauses the production scan can't see, or
environments where ktx has no live access at all and must build the semantic
layer from documentation alone.

## Requirements (sketch — refine when picked up)

1. A new ingest adapter (peer of `metabase`/`dbt` in
   `context/ingest/adapters/`) consuming a configured local path of schema
   docs per connection.
2. Input formats to start: DDL files (`.sql`/`.csv` of CREATE statements)
   and tabular column dictionaries (CSV/JSON: table, column, description,
   …). Extensible to other formats.
3. Output: **enrichment, not duplication** — merge descriptions/metadata
   into the manifest-backed semantic-layer sources and dictionary for the
   matching connection. Where a live scan exists, offline docs fill gaps
   (descriptions, enum meanings, deprecation notes) and flag drift
   (documented column missing from live schema and vice versa) rather than
   creating parallel wiki pages that duplicate schema info.
4. Works without live database access (documentation-only bootstrap of a
   connection's semantic layer), clearly marked as unverified-against-live.

## Acceptance criteria (sketch)

- Given a connection with a live scan plus an offline column dictionary,
  semantic-layer sources carry the documented descriptions, and drift
  between doc and live schema is reported.
- Given a connection with docs only (no live access), `sl list`/`sl read`
  expose manifest sources built from the docs.
- No wiki pages are created that merely restate table/column lists.
