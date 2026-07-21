import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import type { SqlAnalysisDialect } from './ports.js';

// Per-engine SQL syntax notes live as markdown files under ./dialects (one per
// dialect), served by the sql_dialect_notes MCP tool. They are package-internal:
// copy-runtime-assets.mjs ships them to dist, and they are never installed onto an
// agent target. The set covers every dialect reachable from a configured warehouse driver.

/** @internal Dialects with an authored ./dialects/<dialect>.md file. */
export const DIALECTS_WITH_NOTES = [
  'postgres',
  'mysql',
  'snowflake',
  'bigquery',
  'sqlite',
  'duckdb',
  'clickhouse',
  'databricks',
  'tsql',
  'athena',
] as const;

type DialectWithNotes = (typeof DIALECTS_WITH_NOTES)[number];

const notesCache = new Map<DialectWithNotes, string>();

function readDialectNotes(dialect: DialectWithNotes): string {
  const cached = notesCache.get(dialect);
  if (cached !== undefined) {
    return cached;
  }
  const path = fileURLToPath(new URL(`./dialects/${dialect}.md`, import.meta.url));
  const content = readFileSync(path, 'utf-8').trimEnd();
  notesCache.set(dialect, content);
  return content;
}

function hasNotes(dialect: SqlAnalysisDialect): dialect is DialectWithNotes {
  return (DIALECTS_WITH_NOTES as readonly string[]).includes(dialect);
}

/**
 * SQL syntax notes for a resolved dialect. Falls back to `postgres` — the
 * resolver's own default for unrecognized drivers — so any SQL connection yields
 * usable guidance rather than an empty string.
 */
export function sqlDialectNotes(dialect: SqlAnalysisDialect): string {
  return readDialectNotes(hasNotes(dialect) ? dialect : 'postgres');
}
