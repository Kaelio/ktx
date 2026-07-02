import { Buffer } from 'node:buffer';
import type { Dirent } from 'node:fs';
import { mkdir, readdir, readFile, writeFile } from 'node:fs/promises';
import { join, relative } from 'node:path';
import { redactKtxSensitiveMetadata } from '../../../core/redaction.js';
import type { KtxSchemaSnapshot, KtxSchemaTable, KtxTableRef } from '../../../scan/types.js';

export const LIVE_DATABASE_META_FILE = 'connection.json';
export const LIVE_DATABASE_FOREIGN_KEYS_FILE = 'foreign-keys.json';
/** @internal */
export const LIVE_DATABASE_WARNINGS_FILE = 'warnings.json';
const LIVE_DATABASE_TABLES_DIR = 'tables';

interface LiveDatabaseTableFile {
  path: string;
  table: KtxSchemaTable;
}

interface ForeignKeyIndexEntry {
  fromTable: string;
  fromTablePath: string;
  fromColumn: string;
  toCatalog: string | null;
  toDb: string | null;
  toTable: string;
  toColumn: string;
  constraintName: string | null;
}

function encodePathPart(value: string | null | undefined): string {
  return Buffer.from(value ?? '_', 'utf8').toString('base64url');
}

function tableSortKey(table: KtxTableRef): string {
  return `${table.catalog ?? ''}\u0000${table.db ?? ''}\u0000${table.name}`;
}

/** @internal */
export function liveDatabaseTablePath(table: KtxTableRef): string {
  return `${LIVE_DATABASE_TABLES_DIR}/${encodePathPart(table.catalog)}.${encodePathPart(table.db)}.${encodePathPart(
    table.name,
  )}.json`;
}

async function walkFiles(root: string, dir = root): Promise<string[]> {
  let entries: Dirent[];
  try {
    entries = await readdir(dir, { withFileTypes: true });
  } catch {
    return [];
  }
  const files: string[] = [];
  for (const entry of entries) {
    const absolute = join(dir, entry.name);
    if (entry.isDirectory()) {
      files.push(...(await walkFiles(root, absolute)));
    } else if (entry.isFile()) {
      files.push(relative(root, absolute).replace(/\\/g, '/'));
    }
  }
  return files.sort();
}

function stableJson(value: unknown): string {
  return `${JSON.stringify(value, null, 2)}\n`;
}

function foreignKeyIndex(snapshot: KtxSchemaSnapshot): ForeignKeyIndexEntry[] {
  const entries: ForeignKeyIndexEntry[] = [];
  for (const table of snapshot.tables) {
    for (const fk of table.foreignKeys) {
      entries.push({
        fromTable: table.name,
        fromTablePath: liveDatabaseTablePath(table),
        fromColumn: fk.fromColumn,
        toCatalog: fk.toCatalog,
        toDb: fk.toDb,
        toTable: fk.toTable,
        toColumn: fk.toColumn,
        constraintName: fk.constraintName,
      });
    }
  }
  entries.sort(
    (a, b) =>
      a.fromTable.localeCompare(b.fromTable) ||
      a.fromColumn.localeCompare(b.fromColumn) ||
      a.toTable.localeCompare(b.toTable) ||
      a.toColumn.localeCompare(b.toColumn),
  );
  return entries;
}

function warningArtifact(snapshot: KtxSchemaSnapshot): { warnings: KtxSchemaSnapshot['warnings'] } {
  const redacted = redactKtxSensitiveMetadata({ warnings: snapshot.warnings ?? [] });
  return {
    warnings: Array.isArray(redacted.warnings) ? (redacted.warnings as KtxSchemaSnapshot['warnings']) : [],
  };
}

export async function writeLiveDatabaseSnapshot(stagedDir: string, snapshot: KtxSchemaSnapshot): Promise<void> {
  await mkdir(join(stagedDir, LIVE_DATABASE_TABLES_DIR), { recursive: true });
  const sortedTables = [...snapshot.tables].sort((a, b) => tableSortKey(a).localeCompare(tableSortKey(b)));
  const metadata = {
    connectionId: snapshot.connectionId,
    driver: snapshot.driver,
    extractedAt: snapshot.extractedAt,
    scope: snapshot.scope,
    metadata: redactKtxSensitiveMetadata(snapshot.metadata),
    tableCount: sortedTables.length,
  };
  await writeFile(join(stagedDir, LIVE_DATABASE_META_FILE), stableJson(metadata));
  await writeFile(
    join(stagedDir, LIVE_DATABASE_FOREIGN_KEYS_FILE),
    stableJson({ foreignKeys: foreignKeyIndex(snapshot) }),
  );
  await writeFile(join(stagedDir, LIVE_DATABASE_WARNINGS_FILE), stableJson(warningArtifact(snapshot)));
  for (const table of sortedTables) {
    await writeFile(join(stagedDir, liveDatabaseTablePath(table)), stableJson(table));
  }
}

export async function readLiveDatabaseTableFiles(stagedDir: string): Promise<LiveDatabaseTableFile[]> {
  const files = await walkFiles(join(stagedDir, LIVE_DATABASE_TABLES_DIR));
  const out: LiveDatabaseTableFile[] = [];
  for (const file of files.filter((path) => path.endsWith('.json'))) {
    const path = `${LIVE_DATABASE_TABLES_DIR}/${file}`;
    const raw = await readFile(join(stagedDir, path), 'utf8');
    const parsed = JSON.parse(raw) as KtxSchemaTable;
    if (parsed && typeof parsed.name === 'string' && Array.isArray(parsed.columns)) {
      out.push({ path, table: parsed });
    }
  }
  out.sort((a, b) => tableSortKey(a.table).localeCompare(tableSortKey(b.table)));
  return out;
}

export async function detectLiveDatabaseStagedDir(stagedDir: string): Promise<boolean> {
  // A valid live-database staging is identified by its connection.json marker.
  // An empty table set is a legitimate outcome (an empty database), so the
  // presence of table files is not required — the total-vs-partial decision is
  // made earlier by assertLiveDatabaseScanOutcome, before staging.
  try {
    const meta = JSON.parse(await readFile(join(stagedDir, LIVE_DATABASE_META_FILE), 'utf8')) as unknown;
    return Boolean(meta) && typeof meta === 'object' && !Array.isArray(meta);
  } catch {
    return false;
  }
}
