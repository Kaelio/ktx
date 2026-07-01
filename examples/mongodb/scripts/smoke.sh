#!/usr/bin/env bash
set -euo pipefail

# Manual smoke for the MongoDB connector: start MongoDB, seed it, and assert the
# connector's schema introspection (the deterministic, no-LLM half of ktx ingest's
# "database schema" stage). The full enrichment ingest is documented in README.md.

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
EXAMPLE_DIR="$(cd "$SCRIPT_DIR/.." && pwd)"
KTX_ROOT="$(cd "$EXAMPLE_DIR/../.." && pwd)"
COMPOSE_FILE="$EXAMPLE_DIR/docker-compose.yml"
CONNECTOR="$KTX_ROOT/packages/cli/dist/connectors/mongodb/live-database-introspection.js"
MONGO_URL="${KTX_MONGODB_URL:-mongodb://localhost:27117/app}"

# Compose engine: docker by default, override for podman:
#   KTX_MONGODB_COMPOSE="podman compose" examples/mongodb/scripts/smoke.sh
COMPOSE="${KTX_MONGODB_COMPOSE:-docker compose}"

cleanup() {
  if [[ "${KTX_MONGODB_KEEP:-0}" != "1" ]]; then
    $COMPOSE -f "$COMPOSE_FILE" down -v >/dev/null 2>&1 || true
  fi
}
trap cleanup EXIT

if [[ ! -f "$CONNECTOR" ]]; then
  echo "Build the CLI first: pnpm --filter @kaelio/ktx run build" >&2
  exit 1
fi

echo "Starting MongoDB and seeding (${COMPOSE})…"
$COMPOSE -f "$COMPOSE_FILE" up -d --wait

echo "Asserting connector introspection against ${MONGO_URL}…"
node "$SCRIPT_DIR/introspect-smoke.mjs" "$MONGO_URL"

echo "Smoke passed."
