import type { KtxLocalProject } from '../../context/project/project.js';
import type {
  KtxConnectionDriver,
  KtxScanWarning,
  KtxSchemaColumn,
  KtxSchemaForeignKey,
  KtxSchemaSnapshot,
  KtxSchemaTable,
} from './types.js';

export interface ReadLocalScanStructuralSnapshotInput {
  project: KtxLocalProject;
  connectionId: string;
  driver: KtxConnectionDriver;
  rawSourcesDir: string;
  extractedAtFallback: string;
}

interface LiveDatabaseConnectionArtifact {
  connectionId?: unknown;
  extractedAt?: unknown;
  metadata?: unknown;
  scope?: unknown;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function metadataRecord(value: unknown): Record<string, unknown> {
  return isRecord(value) ? value : {};
}

const scanWarningCodes = new Set<KtxScanWarning['code']>([
  'connector_capability_missing',
  'sampling_failed',
  'statistics_failed',
  'llm_unavailable',
  'embedding_unavailable',
  'scan_enrichment_backend_not_configured',
  'relationship_validation_failed',
  'relationship_llm_invalid_reference',
  'relationship_llm_proposal_failed',
  'credential_redacted',
  'enrichment_failed',
  'description_fallback_used',
  'constraint_discovery_unauthorized',
  'object_introspection_failed',
]);

/** @internal */
export function isKtxScanWarningCode(code: string): code is KtxScanWarning['code'] {
  return scanWarningCodes.has(code as KtxScanWarning['code']);
}

function parseWarning(rawWarning: unknown, path: string): KtxScanWarning {
  if (
    !isRecord(rawWarning) ||
    typeof rawWarning.code !== 'string' ||
    !scanWarningCodes.has(rawWarning.code as KtxScanWarning['code']) ||
    typeof rawWarning.message !== 'string' ||
    typeof rawWarning.recoverable !== 'boolean'
  ) {
    throw new Error(`Invalid ktx schema warning artifact: ${path}`);
  }
  return {
    code: rawWarning.code as KtxScanWarning['code'],
    message: rawWarning.message,
    recoverable: rawWarning.recoverable,
    ...(typeof rawWarning.table === 'string' ? { table: rawWarning.table } : {}),
    ...(typeof rawWarning.column === 'string' ? { column: rawWarning.column } : {}),
    ...(isRecord(rawWarning.metadata) ? { metadata: rawWarning.metadata } : {}),
  };
}

async function readWarnings(input: ReadLocalScanStructuralSnapshotInput): Promise<KtxScanWarning[]> {
  const path = `${input.rawSourcesDir}/warnings.json`;
  try {
    const warningRaw = await input.project.fileStore.readFile(path);
    const parsed = JSON.parse(warningRaw.content) as unknown;
    if (!isRecord(parsed) || !Array.isArray(parsed.warnings)) {
      throw new Error(`Invalid ktx schema warnings artifact: ${path}`);
    }
    return parsed.warnings.map((warning) => parseWarning(warning, path));
  } catch (error) {
    if (error instanceof Error && /not found|ENOENT|no such file/i.test(error.message)) {
      return [];
    }
    throw error;
  }
}

function optionalStringOrNull(value: unknown): string | null | undefined {
  if (value === undefined) {
    return undefined;
  }
  return typeof value === 'string' ? value : null;
}

function parseColumn(rawColumn: unknown, path: string): KtxSchemaColumn {
  if (
    !isRecord(rawColumn) ||
    typeof rawColumn.name !== 'string' ||
    typeof rawColumn.nativeType !== 'string' ||
    typeof rawColumn.normalizedType !== 'string' ||
    (rawColumn.dimensionType !== 'time' &&
      rawColumn.dimensionType !== 'string' &&
      rawColumn.dimensionType !== 'number' &&
      rawColumn.dimensionType !== 'boolean')
  ) {
    throw new Error(`Invalid ktx schema column artifact: ${path}`);
  }
  return {
    name: rawColumn.name,
    nativeType: rawColumn.nativeType,
    normalizedType: rawColumn.normalizedType,
    dimensionType: rawColumn.dimensionType,
    nullable: rawColumn.nullable === true,
    primaryKey: rawColumn.primaryKey === true,
    comment: optionalStringOrNull(rawColumn.comment) ?? null,
  };
}

function parseForeignKey(rawForeignKey: unknown, path: string): KtxSchemaForeignKey {
  if (
    !isRecord(rawForeignKey) ||
    typeof rawForeignKey.fromColumn !== 'string' ||
    typeof rawForeignKey.toTable !== 'string' ||
    typeof rawForeignKey.toColumn !== 'string'
  ) {
    throw new Error(`Invalid ktx schema foreign key artifact: ${path}`);
  }
  return {
    fromColumn: rawForeignKey.fromColumn,
    toCatalog: optionalStringOrNull(rawForeignKey.toCatalog) ?? null,
    toDb: optionalStringOrNull(rawForeignKey.toDb) ?? null,
    toTable: rawForeignKey.toTable,
    toColumn: rawForeignKey.toColumn,
    constraintName: optionalStringOrNull(rawForeignKey.constraintName) ?? null,
  };
}

function parseTable(raw: string, path: string): KtxSchemaTable {
  const parsed = JSON.parse(raw) as unknown;
  if (!isRecord(parsed) || typeof parsed.name !== 'string' || !Array.isArray(parsed.columns)) {
    throw new Error(`Invalid ktx schema table artifact: ${path}`);
  }
  return {
    catalog: optionalStringOrNull(parsed.catalog) ?? null,
    db: optionalStringOrNull(parsed.db) ?? null,
    name: parsed.name,
    kind:
      parsed.kind === 'view' || parsed.kind === 'external' || parsed.kind === 'event_stream' ? parsed.kind : 'table',
    comment: optionalStringOrNull(parsed.comment) ?? null,
    estimatedRows: typeof parsed.estimatedRows === 'number' ? parsed.estimatedRows : null,
    columns: parsed.columns.map((column) => parseColumn(column, path)),
    foreignKeys: Array.isArray(parsed.foreignKeys)
      ? parsed.foreignKeys.map((foreignKey) => parseForeignKey(foreignKey, path))
      : [],
  };
}

export async function readLocalScanStructuralSnapshot(
  input: ReadLocalScanStructuralSnapshotInput,
): Promise<KtxSchemaSnapshot> {
  const connectionRaw = await input.project.fileStore.readFile(`${input.rawSourcesDir}/connection.json`);
  const connection = JSON.parse(connectionRaw.content) as LiveDatabaseConnectionArtifact;
  const listedTables = await input.project.fileStore.listFiles(`${input.rawSourcesDir}/tables`);
  const tablePaths = listedTables.files.filter((path) => path.endsWith('.json')).sort();

  const tables: KtxSchemaTable[] = [];
  for (const path of tablePaths) {
    const tableRaw = await input.project.fileStore.readFile(path);
    tables.push(parseTable(tableRaw.content, path));
  }
  const warnings = await readWarnings(input);

  return {
    connectionId: typeof connection.connectionId === 'string' ? connection.connectionId : input.connectionId,
    driver: input.driver,
    extractedAt: typeof connection.extractedAt === 'string' ? connection.extractedAt : input.extractedAtFallback,
    scope: isRecord(connection.scope) ? connection.scope : {},
    metadata: metadataRecord(connection.metadata),
    tables,
    warnings,
  };
}
