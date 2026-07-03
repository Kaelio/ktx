import type { MetabaseDatabase, MetabaseRuntimeClient } from './client-port.js';

/** @internal */
export const METABASE_ENGINE_TO_CONNECTION_TYPE = {
  postgres: 'POSTGRESQL',
  bigquery: 'BIGQUERY',
  'bigquery-cloud-sdk': 'BIGQUERY',
  snowflake: 'SNOWFLAKE',
  sqlserver: 'SQLSERVER',
  mysql: 'MYSQL',
  athena: 'ATHENA',
} as const;

export interface DiscoveredMetabaseDatabase {
  id: number;
  name: string;
  engine: string;
  host: string | null;
  dbName: string | null;
}

export interface MetabaseMappingDrift {
  unmappedDiscovered: DiscoveredMetabaseDatabase[];
  staleMappings: Array<{ id: string; reason: 'database_not_found' }>;
  inSync: Array<{ id: number; ktxConnectionId: string }>;
}

export interface MappingPhysicalInfo {
  metabaseEngine: string | null;
  metabaseDbName: string | null;
  metabaseHost: string | null;
}

export interface KtxConnectionPhysicalInfo {
  connection_type: string;
  database?: unknown;
  host?: unknown;
  account?: unknown;
  dataset_id?: unknown;
  project_id?: unknown;
  [key: string]: unknown;
}

/** @internal */
export interface PhysicalMismatchInput {
  mappingId: string;
  metabase: MappingPhysicalInfo;
  target: KtxConnectionPhysicalInfo;
}

/** @internal */
export interface PhysicalMismatch {
  mappingId: string;
  reason: string;
}

/** @internal */
export interface MappingRefreshReport {
  drift: MetabaseMappingDrift;
  physicalMismatches: PhysicalMismatch[];
}

/** @internal */
export type MetabaseMappingValidationResult =
  | { ok: true }
  | { ok: false; errors: Array<{ key: string; reason: string }> };

/** @internal */
export interface AutoMatchCandidate {
  id: string;
  name: string;
  connection_type: string;
  connection_params: unknown;
}

/** @internal */
export interface AutoMatchResult {
  connectionId: string;
  connectionName: string;
  reason: 'host_and_database' | 'database_only' | 'host_only';
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

function readString(record: Record<string, unknown>, key: string): string | null {
  const value = record[key];
  return typeof value === 'string' && value.length > 0 ? value : null;
}

function normalizeHost(host: unknown): string | null {
  if (typeof host !== 'string' || host.length === 0) {
    return null;
  }
  return host.toLowerCase().replace(/:\d+$/, '');
}

function normalizeName(name: unknown): string | null {
  if (typeof name !== 'string' || name.length === 0) {
    return null;
  }
  return name.toLowerCase();
}

function displayValue(value: unknown): string {
  return typeof value === 'string' && value.length > 0 ? value : 'unknown';
}

function getTargetDatabase(target: KtxConnectionPhysicalInfo): unknown {
  if (target.connection_type === 'BIGQUERY') {
    return target.dataset_id ?? target.project_id ?? target.database;
  }
  return target.database;
}

function extractHost(params: Record<string, unknown>, connectionType: string): string | null {
  switch (connectionType) {
    case 'POSTGRESQL':
    case 'SQLSERVER':
    case 'MYSQL':
      return readString(params, 'host');
    case 'SNOWFLAKE':
      return readString(params, 'account');
    default:
      return null;
  }
}

function extractDatabase(params: Record<string, unknown>, connectionType: string): string | null {
  switch (connectionType) {
    case 'POSTGRESQL':
    case 'SQLSERVER':
    case 'SNOWFLAKE':
    case 'MYSQL':
      return readString(params, 'database');
    case 'BIGQUERY':
      return readString(params, 'dataset_id');
    default:
      return null;
  }
}

function toDiscoveredMetabaseDatabase(database: MetabaseDatabase): DiscoveredMetabaseDatabase {
  const details = isRecord(database.details) ? database.details : {};
  return {
    id: database.id,
    name: database.name,
    engine: database.engine ?? '',
    host: readString(details, 'host'),
    dbName: readString(details, 'dbname') ?? readString(details, 'db'),
  };
}

export async function discoverMetabaseDatabases(
  client: Pick<MetabaseRuntimeClient, 'getDatabases'>,
): Promise<DiscoveredMetabaseDatabase[]> {
  const databases = await client.getDatabases();
  return databases.filter((database) => !database.is_sample).map(toDiscoveredMetabaseDatabase);
}

export function computeMetabaseMappingDrift(args: {
  currentMappings: Record<string, string | null | undefined>;
  discovered: DiscoveredMetabaseDatabase[];
}): MetabaseMappingDrift {
  const discoveredById = new Map(args.discovered.map((database) => [String(database.id), database]));
  const unmappedDiscovered = args.discovered.filter((database) => !args.currentMappings[String(database.id)]);
  const staleMappings = Object.keys(args.currentMappings)
    .filter((id) => !discoveredById.has(id))
    .map((id) => ({ id, reason: 'database_not_found' as const }));
  const inSync = Object.entries(args.currentMappings)
    .filter(([id, ktxConnectionId]) => discoveredById.has(id) && typeof ktxConnectionId === 'string')
    .map(([id, ktxConnectionId]) => ({ id: Number(id), ktxConnectionId: ktxConnectionId as string }));

  return { unmappedDiscovered, staleMappings, inSync };
}

/** @internal */
export function validateMetabaseMappings(args: {
  mappings: Record<string, string | null | undefined>;
  knownKtxConnectionIds: Set<string>;
}): MetabaseMappingValidationResult {
  const errors: Array<{ key: string; reason: string }> = [];
  for (const [key, connectionId] of Object.entries(args.mappings)) {
    if (!connectionId) {
      continue;
    }
    if (!args.knownKtxConnectionIds.has(connectionId)) {
      errors.push({ key, reason: `ktx connection ${connectionId} does not exist` });
    }
  }
  return errors.length === 0 ? { ok: true } : { ok: false, errors };
}

export function validateMappingPhysicalMatch(
  mapping: MappingPhysicalInfo,
  target: KtxConnectionPhysicalInfo,
): string | null {
  const engine = mapping.metabaseEngine?.toLowerCase();
  if (!engine) {
    return null;
  }

  const expectedType = METABASE_ENGINE_TO_CONNECTION_TYPE[engine as keyof typeof METABASE_ENGINE_TO_CONNECTION_TYPE];
  if (!expectedType) {
    return null;
  }

  if (target.connection_type !== expectedType) {
    return `Metabase database engine '${engine}' does not match ktx connection type '${target.connection_type}'`;
  }

  const metabaseDb = normalizeName(mapping.metabaseDbName);
  const targetDb = normalizeName(getTargetDatabase(target));

  if (engine === 'snowflake' || engine === 'bigquery' || engine === 'bigquery-cloud-sdk') {
    if (metabaseDb && targetDb && metabaseDb !== targetDb) {
      return `Metabase database '${mapping.metabaseDbName}' does not match ktx connection database '${displayValue(
        getTargetDatabase(target),
      )}'`;
    }
    return null;
  }

  if (engine === 'postgres' || engine === 'mysql' || engine === 'sqlserver') {
    const metabaseHost = normalizeHost(mapping.metabaseHost);
    const targetHost = normalizeHost(target.host);

    if (metabaseHost && targetHost && metabaseHost !== targetHost) {
      return `Metabase host '${mapping.metabaseHost}' does not match ktx connection host '${displayValue(
        target.host,
      )}'`;
    }
    if (metabaseDb && targetDb && metabaseDb !== targetDb) {
      return `Metabase database '${mapping.metabaseDbName}' does not match ktx connection database '${displayValue(
        getTargetDatabase(target),
      )}'`;
    }
    return null;
  }

  return null;
}

/** @internal */
export function computeMetabaseMappingPhysicalMismatches(inputs: PhysicalMismatchInput[]): PhysicalMismatch[] {
  const mismatches: PhysicalMismatch[] = [];
  for (const input of inputs) {
    const reason = validateMappingPhysicalMatch(input.metabase, input.target);
    if (reason) {
      mismatches.push({ mappingId: input.mappingId, reason });
    }
  }
  return mismatches;
}

/** @internal */
export async function refreshMetabaseMapping(args: {
  client: Pick<MetabaseRuntimeClient, 'getDatabases'>;
  currentMappings: Record<string, string | null | undefined>;
  resolveKtxConnectionPhysicalInfo: (ktxConnectionId: string) => Promise<KtxConnectionPhysicalInfo | null>;
}): Promise<MappingRefreshReport> {
  const discovered = await discoverMetabaseDatabases(args.client);
  const drift = computeMetabaseMappingDrift({ currentMappings: args.currentMappings, discovered });
  const discoveredById = new Map(discovered.map((database) => [database.id, database]));
  const physicalMismatches: PhysicalMismatch[] = [];

  for (const mapping of drift.inSync) {
    const discoveredDatabase = discoveredById.get(mapping.id);
    if (!discoveredDatabase) {
      continue;
    }
    const target = await args.resolveKtxConnectionPhysicalInfo(mapping.ktxConnectionId);
    if (!target) {
      physicalMismatches.push({
        mappingId: String(mapping.id),
        reason: `ktx connection ${mapping.ktxConnectionId} does not exist`,
      });
      continue;
    }
    const reason = validateMappingPhysicalMatch(
      {
        metabaseEngine: discoveredDatabase.engine,
        metabaseHost: discoveredDatabase.host,
        metabaseDbName: discoveredDatabase.dbName,
      },
      target,
    );
    if (reason) {
      physicalMismatches.push({ mappingId: String(mapping.id), reason });
    }
  }

  return { drift, physicalMismatches };
}

/** @internal */
export function findBestMatch(mapping: MappingPhysicalInfo, candidates: AutoMatchCandidate[]): AutoMatchResult | null {
  const engine = mapping.metabaseEngine?.toLowerCase();
  if (!engine) {
    return null;
  }

  const expectedType = METABASE_ENGINE_TO_CONNECTION_TYPE[engine as keyof typeof METABASE_ENGINE_TO_CONNECTION_TYPE];
  if (!expectedType) {
    return null;
  }

  const compatibleConnections = candidates.filter((candidate) => candidate.connection_type === expectedType);
  if (compatibleConnections.length === 0) {
    return null;
  }

  const metabaseHost = normalizeHost(mapping.metabaseHost);
  const metabaseDb = normalizeName(mapping.metabaseDbName);
  let bestMatch: AutoMatchResult | null = null;
  let bestScore = 0;

  for (const connection of compatibleConnections) {
    if (!isRecord(connection.connection_params)) {
      continue;
    }

    const connHost = normalizeHost(extractHost(connection.connection_params, connection.connection_type));
    const connDb = normalizeName(extractDatabase(connection.connection_params, connection.connection_type));
    const hostMatch = metabaseHost && connHost && metabaseHost === connHost;
    const dbMatch = metabaseDb && connDb && metabaseDb === connDb;

    let score = 0;
    let reason: AutoMatchResult['reason'] = 'host_only';
    if (hostMatch && dbMatch) {
      score = 3;
      reason = 'host_and_database';
    } else if (dbMatch) {
      score = 2;
      reason = 'database_only';
    } else if (hostMatch) {
      score = 1;
      reason = 'host_only';
    }

    if (score > bestScore) {
      bestScore = score;
      bestMatch = {
        connectionId: connection.id,
        connectionName: connection.name,
        reason,
      };
    }
  }

  return bestMatch;
}
