# MongoDB Connector Example

A manual, self-contained example for the **ktx** MongoDB connector. It starts a
local MongoDB, seeds a representative dataset, and exercises the connector both
as a fast no-LLM introspection smoke and as a full `ktx ingest` run.

MongoDB is a **context-only** primary source: collections become tables and
inferred top-level fields become columns, but `ktx sql` and semantic-layer
metric compilation do not apply. See
[`docs-site/content/docs/integrations/primary-sources.mdx`](../../docs-site/content/docs/integrations/primary-sources.mdx).

## Prerequisites

- Docker with Compose v2, or Podman with `podman compose`
- Node and pnpm matching the **ktx** workspace
- The built CLI: `pnpm --filter @kaelio/ktx run build`
- For the full ingest only: `uv` on `PATH` and a usable local Claude Code
  session (the keyless `claude-code` LLM backend)

## What the seed contains

[`init/seed.js`](init/seed.js) creates the `app` database with:

- `users` — `_id` (ObjectId), scalar fields, a nested `address`, an array
  `tags`, a `Decimal128` `balance`, a `ref` field that holds more than one type
  (inferred `mixed`), and an `age` field absent from one document (nullable)
- `orders` — an ObjectId `user_id` reference for relationship discovery
- `active_users` — a **view** (to confirm introspection never runs a count
  command on a view)

MongoDB applies the script once on first container start. Apply it by hand with:

```bash
mongosh "mongodb://localhost:27117" < examples/mongodb/init/seed.js
```

## Smoke (no LLM credentials)

From the **ktx** repository root:

```bash
examples/mongodb/scripts/smoke.sh
```

It starts MongoDB on `127.0.0.1:27117`, seeds it, and asserts the connector's
inferred schema (collections → tables, nested → `json`, `mixed`, nullability,
`_id` primary key, and a view introspected with `estimatedRows: null`). This
drives the same entry point `ktx ingest`'s "database schema" stage uses, without
needing an LLM or embeddings.

Podman:

```bash
KTX_MONGODB_COMPOSE="podman compose" examples/mongodb/scripts/smoke.sh
```

Set `KTX_MONGODB_KEEP=1` to leave the container running after the script exits.

## Full `ktx ingest`

The public database-ingest path requires a configured model and embeddings.
This runs entirely locally with the keyless `claude-code` LLM backend and the
**ktx**-managed `sentence-transformers` embedding daemon — no API keys.

Start MongoDB and create a project:

```bash
docker compose -f examples/mongodb/docker-compose.yml up -d --wait   # or: podman compose
node packages/cli/dist/bin.js admin init /tmp/ktx-mongodb-example
```

Add the connection and a keyless enrichment stack to
`/tmp/ktx-mongodb-example/ktx.yaml`:

```yaml
connections:
  mongo-prod:
    driver: mongodb
    url: mongodb://localhost:27117/app
    databases:
      - app
llm:
  provider:
    backend: claude-code
  models:
    default: sonnet
scan:
  enrichment:
    mode: llm
    embeddings:
      backend: sentence-transformers
      model: all-MiniLM-L6-v2
      dimensions: 384
      sentenceTransformers:
        base_url: ""
```

Test the connection and ingest:

```bash
node packages/cli/dist/bin.js connection test mongo-prod --project-dir /tmp/ktx-mongodb-example
node packages/cli/dist/bin.js ingest mongo-prod --project-dir /tmp/ktx-mongodb-example --yes --plain
```

The first ingest starts the **ktx** embedding daemon and downloads the
`all-MiniLM-L6-v2` model. Expected final state: `Database schema: done`.

Inspect the result:

- `raw-sources/mongo-prod/live-database/<run>/tables/*.json` — one per
  collection, including the `active_users` view with `estimatedRows: null`
- `raw-sources/mongo-prod/live-database/<run>/enrichment/relationships.json` —
  inferred relationships sit in `review` (a non-SQL source has no read-only SQL
  coverage validation), with `accepted: []`
- `semantic-layer/mongo-prod/_schema/app.yaml` — the schema with per-column AI
  descriptions

`ktx sql -c mongo-prod "SELECT 1"` is refused by the read-only SQL capability
gate, and `ktx sl query -c mongo-prod ...` is refused because MongoDB is not a
SQL source.

## Cleanup

```bash
docker compose -f examples/mongodb/docker-compose.yml down -v   # or: podman compose
rm -rf /tmp/ktx-mongodb-example
```
