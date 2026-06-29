import { tableRefSet, type KtxTableRefKey } from './table-ref.js';
import type { KtxTableRef } from './types.js';

/**
 * Parses the `enabled_tables` field on a connection into a scope of
 * fully-qualified table refs. Returns `null` when the field is absent or
 * empty (meaning "no scope — include every table in the resolved schemas").
 *
 * Accepted entry forms:
 *   "catalog.db.name"  — fully qualified
 *   "db.name"          — schema-qualified (catalog = null)
 *   "name"             — bare (catalog = db = null; SQLite-shape)
 *
 * SQLite exposes a single schema named `main` but the connector emits objects
 * with `db: null`, so the `"main.<name>"` form is normalized to the bare shape
 * to match. Both `"main.customers"` and `"customers"` therefore select the same
 * object.
 */
export function resolveEnabledTables(
  connection: Record<string, unknown> | undefined,
): ReadonlySet<KtxTableRefKey> | null {
  const raw = connection?.enabled_tables;
  if (!Array.isArray(raw) || raw.length === 0) return null;
  const driver = typeof connection?.driver === 'string' ? connection.driver : undefined;
  const refs: KtxTableRef[] = [];
  for (const value of raw) {
    const parsed = parseEnabledTableEntry(value);
    if (parsed) refs.push(normalizeRefForDriver(parsed, driver));
  }
  if (refs.length === 0) return null;
  return tableRefSet(refs);
}

function normalizeRefForDriver(ref: KtxTableRef, driver: string | undefined): KtxTableRef {
  if (driver === 'sqlite' && ref.catalog === null && ref.db === 'main') {
    return { catalog: null, db: null, name: ref.name };
  }
  return ref;
}

function parseEnabledTableEntry(value: unknown): KtxTableRef | null {
  if (typeof value === 'string') {
    return parseDottedTableEntry(value);
  }
  return null;
}

/** @internal */
export function parseDottedTableEntry(value: string): KtxTableRef | null {
  const trimmed = value.trim();
  if (trimmed.length === 0) return null;
  const parts = trimmed.split('.');
  if (parts.length === 3) {
    return { catalog: parts[0]!, db: parts[1]!, name: parts[2]! };
  }
  if (parts.length === 2) {
    return { catalog: null, db: parts[0]!, name: parts[1]! };
  }
  if (parts.length === 1) {
    return { catalog: null, db: null, name: parts[0]! };
  }
  return null;
}
