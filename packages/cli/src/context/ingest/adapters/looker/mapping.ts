import type { ParsedTargetTable } from '../../parsed-target-table.js';
import { warehouseTargetDialect } from '../../../connections/connection-type-dialect.js';
import type { LookerWarehouseConnectionInfo } from './client.js';
import type { LookerPullConfig, LookerRuntimeCursors, StagedExploreFile, StagedLookmlModelsFile } from './types.js';

const LOOKER_DIALECT_TO_CONNECTION_TYPE = {
  bigquery: 'BIGQUERY',
  bigquery_standard_sql: 'BIGQUERY',
  snowflake: 'SNOWFLAKE',
  postgres: 'POSTGRESQL',
  mysql: 'MYSQL',
  sqlite: 'SQLITE',
  sqlserver: 'SQLSERVER',
  clickhouse: 'CLICKHOUSE',
  awsathena: 'ATHENA',
} as const;

/** @internal */
export type LookerWarehouseTargetConnectionType =
  (typeof LOOKER_DIALECT_TO_CONNECTION_TYPE)[keyof typeof LOOKER_DIALECT_TO_CONNECTION_TYPE];

export interface LookerConnectionMapping {
  lookerConnectionName: string;
  ktxConnectionId: string | null;
  lookerHost: string | null;
  lookerDatabase: string | null;
  lookerDialect: string | null;
}

export interface LookerTargetConnection {
  id: string;
  connection_type: string;
  connection_params?: Record<string, unknown> | null;
}

/** @internal */
export interface LookerMappingCandidateConnection extends LookerTargetConnection {}

export interface LookerMappingDrift {
  unmappedDiscovered: LookerWarehouseConnectionInfo[];
  staleMappings: Array<{ lookerConnectionName: string; reason: 'looker_connection_not_found' }>;
  inSync: Array<{ lookerConnectionName: string; ktxConnectionId: string }>;
}

export type LookerMappingValidationResult =
  | { ok: true }
  | { ok: false; errors: Array<{ key: string; reason: string }> };

export interface LookerTableIdentifierParseItem {
  key: string;
  sql_table_name: string;
  dialect: string;
}

type ParsedTargetTableFailureReason = Extract<ParsedTargetTable, { ok: false }>['reason'];

export interface LookerParsedIdentifier {
  ok: boolean;
  catalog?: string | null;
  schema?: string | null;
  name?: string | null;
  canonical_table?: string | null;
  reason?: ParsedTargetTableFailureReason | null;
  detail?: string | null;
}

export interface LookerTableIdentifierParser {
  parse(items: LookerTableIdentifierParseItem[]): Promise<Record<string, LookerParsedIdentifier>>;
}

export interface LookerMappingClient {
  listLookerConnections(): Promise<LookerWarehouseConnectionInfo[]>;
  listLookmlModels(): Promise<StagedLookmlModelsFile>;
  getExplore(modelName: string, exploreName: string): Promise<StagedExploreFile>;
}

export async function discoverLookerConnections(
  client: Pick<LookerMappingClient, 'listLookerConnections'>,
): Promise<LookerWarehouseConnectionInfo[]> {
  return client.listLookerConnections();
}

/** @internal */
export function lookerDialectToConnectionType(dialect: string | null): LookerWarehouseTargetConnectionType | null {
  if (!dialect) {
    return null;
  }
  return (
    LOOKER_DIALECT_TO_CONNECTION_TYPE[dialect.toLowerCase() as keyof typeof LOOKER_DIALECT_TO_CONNECTION_TYPE] ?? null
  );
}

/** @internal */
export function sqlglotDialectForConnectionType(connectionType: string): string | null {
  return warehouseTargetDialect(connectionType);
}

/** @internal */
export function validateLookerWarehouseTarget(connectionType: string): { ok: true } | { ok: false; reason: string } {
  return sqlglotDialectForConnectionType(connectionType)
    ? { ok: true }
    : {
        ok: false,
        reason: `Connection type ${connectionType} cannot be used as a Looker warehouse mapping target`,
      };
}

function extractWarehouseHost(params: unknown, connectionType: string): string | null {
  const record = isRecord(params) ? params : {};
  switch (connectionType) {
    case 'POSTGRESQL':
    case 'SQLSERVER':
    case 'MYSQL':
    case 'CLICKHOUSE':
      return readString(record, 'host');
    case 'SNOWFLAKE':
      return readString(record, 'account');
    default:
      return null;
  }
}

function extractWarehouseDatabase(params: unknown, connectionType: string): string | null {
  const record = isRecord(params) ? params : {};
  switch (connectionType) {
    case 'POSTGRESQL':
    case 'SQLSERVER':
    case 'MYSQL':
    case 'CLICKHOUSE':
    case 'SNOWFLAKE':
      return readString(record, 'database');
    case 'BIGQUERY':
      return readString(record, 'dataset_id');
    default:
      return null;
  }
}

function normalizeHost(value: string | null): string | null {
  return value ? value.toLowerCase().replace(/:\d+$/, '') : null;
}

function normalizeName(value: string | null): string | null {
  return value ? value.toLowerCase() : null;
}

/** @internal */
export function suggestKtxConnectionForLookerConnection(args: {
  lookerConnection: LookerWarehouseConnectionInfo;
  candidateConnections: LookerMappingCandidateConnection[];
}): string | null {
  const expectedType = lookerDialectToConnectionType(args.lookerConnection.dialect);
  if (!expectedType || !args.lookerConnection.host || !args.lookerConnection.database || !args.lookerConnection.dialect) {
    return null;
  }

  const matches = args.candidateConnections.filter((connection) => {
    if (connection.connection_type !== expectedType) {
      return false;
    }
    return (
      normalizeHost(extractWarehouseHost(connection.connection_params, connection.connection_type)) ===
        normalizeHost(args.lookerConnection.host) &&
      normalizeName(extractWarehouseDatabase(connection.connection_params, connection.connection_type)) ===
        normalizeName(args.lookerConnection.database)
    );
  });

  return matches.length === 1 ? matches[0].id : null;
}

export function computeLookerMappingDrift(args: {
  storedMappings: LookerConnectionMapping[];
  discovered: LookerWarehouseConnectionInfo[];
}): LookerMappingDrift {
  const discoveredByName = new Map(args.discovered.map((connection) => [connection.name, connection]));
  const storedByName = new Map(args.storedMappings.map((mapping) => [mapping.lookerConnectionName, mapping]));

  return {
    unmappedDiscovered: args.discovered.filter((connection) => !storedByName.get(connection.name)?.ktxConnectionId),
    staleMappings: args.storedMappings
      .filter((mapping) => !discoveredByName.has(mapping.lookerConnectionName))
      .map((mapping) => ({
        lookerConnectionName: mapping.lookerConnectionName,
        reason: 'looker_connection_not_found' as const,
      })),
    inSync: args.storedMappings
      .filter((mapping) => discoveredByName.has(mapping.lookerConnectionName) && mapping.ktxConnectionId)
      .map((mapping) => ({
        lookerConnectionName: mapping.lookerConnectionName,
        ktxConnectionId: mapping.ktxConnectionId as string,
      })),
  };
}

export function validateLookerMappings(args: {
  mappings: LookerConnectionMapping[];
  knownKtxConnectionIds: Set<string>;
  knownConnectionTypes: ReadonlyMap<string, string>;
}): LookerMappingValidationResult {
  const errors: Array<{ key: string; reason: string }> = [];
  for (const mapping of args.mappings) {
    if (!mapping.ktxConnectionId) {
      continue;
    }
    if (!args.knownKtxConnectionIds.has(mapping.ktxConnectionId)) {
      errors.push({
        key: mapping.lookerConnectionName,
        reason: `ktx connection ${mapping.ktxConnectionId} does not exist`,
      });
      continue;
    }
    const connectionType = args.knownConnectionTypes.get(mapping.ktxConnectionId);
    const validation = validateLookerWarehouseTarget(connectionType ?? 'unknown');
    if (!validation.ok) {
      errors.push({ key: mapping.lookerConnectionName, reason: validation.reason });
    }
  }
  return errors.length === 0 ? { ok: true } : { ok: false, errors };
}

/** @internal */
export function refreshLookerMappingPlaceholders(args: {
  stored: LookerConnectionMapping[];
  live: LookerWarehouseConnectionInfo[];
}): { mappings: LookerConnectionMapping[]; changed: boolean } {
  const byName = new Map(args.stored.map((mapping) => [mapping.lookerConnectionName, mapping]));
  let changed = false;

  for (const live of args.live) {
    const existing = byName.get(live.name);
    if (!existing) {
      byName.set(live.name, {
        lookerConnectionName: live.name,
        ktxConnectionId: null,
        lookerHost: live.host,
        lookerDatabase: live.database,
        lookerDialect: live.dialect,
      });
      changed = true;
      continue;
    }

    const refreshed: LookerConnectionMapping = {
      ...existing,
      lookerHost: live.host,
      lookerDatabase: live.database,
      lookerDialect: live.dialect,
    };
    if (
      refreshed.lookerHost !== existing.lookerHost ||
      refreshed.lookerDatabase !== existing.lookerDatabase ||
      refreshed.lookerDialect !== existing.lookerDialect
    ) {
      byName.set(live.name, refreshed);
      changed = true;
    }
  }

  return { mappings: [...byName.values()], changed };
}

/** @internal */
export function collectExploreParseItems(args: {
  explore: StagedExploreFile;
  connectionMappings: Record<string, string>;
  targetConnections: ReadonlyMap<string, Pick<LookerTargetConnection, 'id' | 'connection_type'>>;
}): { parsedTargetTables: Record<string, ParsedTargetTable>; parseItems: LookerTableIdentifierParseItem[] } {
  const parsedTargetTables: Record<string, ParsedTargetTable> = {};
  const parseItems: LookerTableIdentifierParseItem[] = [];
  const lookerConnectionName = args.explore.connectionName;
  const targetConnectionId = lookerConnectionName ? args.connectionMappings[lookerConnectionName] : undefined;

  if (!lookerConnectionName || !targetConnectionId) {
    return { parsedTargetTables, parseItems };
  }

  const targetConnection = args.targetConnections.get(targetConnectionId);
  const dialect = targetConnection ? sqlglotDialectForConnectionType(targetConnection.connection_type) : null;
  const key = `${args.explore.modelName}.${args.explore.exploreName}`;

  if (!dialect) {
    parsedTargetTables[key] = {
      ok: false,
      reason: 'unsupported_dialect',
      detail: `Connection type ${targetConnection?.connection_type ?? 'unknown'} does not map to a supported sqlglot dialect.`,
    };
    return { parsedTargetTables, parseItems };
  }

  if (args.explore.rawSqlTableName) {
    parseItems.push({ key, sql_table_name: args.explore.rawSqlTableName, dialect });
  }

  for (const join of args.explore.joins) {
    if (!join.rawSqlTableName) {
      continue;
    }
    parseItems.push({
      key: `${key}.${join.name}`,
      sql_table_name: join.rawSqlTableName,
      dialect,
    });
  }

  return { parsedTargetTables, parseItems };
}

/** @internal */
export function projectParsedIdentifier(row: LookerParsedIdentifier | undefined): ParsedTargetTable {
  if (!row) {
    return { ok: false, reason: 'parse_error', detail: 'Python parser response was missing this key.' };
  }
  if (row.ok && row.name && row.canonical_table) {
    return {
      ok: true,
      catalog: row.catalog ?? null,
      schema: row.schema ?? null,
      name: row.name,
      canonicalTable: row.canonical_table,
    };
  }
  return {
    ok: false,
    reason: row.reason ?? 'parse_error',
    detail: row.reason ? undefined : 'Python parser returned an invalid success row without name or canonical_table.',
  };
}

export async function buildLookerPullConfigFromInputs(args: {
  lookerConnectionId: string;
  cursors: LookerRuntimeCursors;
  refreshedMappings: LookerConnectionMapping[];
  targetConnections: ReadonlyMap<string, Pick<LookerTargetConnection, 'id' | 'connection_type'>>;
  client: Pick<LookerMappingClient, 'listLookmlModels' | 'getExplore'>;
  parser: LookerTableIdentifierParser;
}): Promise<LookerPullConfig> {
  const connectionMappings: Record<string, string> = {};
  const connectionTypes: Record<string, LookerWarehouseTargetConnectionType> = {};

  for (const mapping of args.refreshedMappings) {
    if (!mapping.ktxConnectionId) {
      continue;
    }
    const target = args.targetConnections.get(mapping.ktxConnectionId);
    if (!target || !validateLookerWarehouseTarget(target.connection_type).ok) {
      continue;
    }
    connectionMappings[mapping.lookerConnectionName] = mapping.ktxConnectionId;
    connectionTypes[mapping.lookerConnectionName] = target.connection_type as LookerWarehouseTargetConnectionType;
  }

  const parsedTargetTables = await parseExploreTargets({
    client: args.client,
    connectionMappings,
    targetConnections: args.targetConnections,
    parser: args.parser,
  });

  return {
    lookerConnectionId: args.lookerConnectionId,
    dashboardUpdatedSince: args.cursors.dashboardsLastSyncedAt,
    lookUpdatedSince: args.cursors.looksLastSyncedAt,
    connectionMappings,
    connectionTypes,
    parsedTargetTables,
  };
}

async function parseExploreTargets(args: {
  client: Pick<LookerMappingClient, 'listLookmlModels' | 'getExplore'>;
  connectionMappings: Record<string, string>;
  targetConnections: ReadonlyMap<string, Pick<LookerTargetConnection, 'id' | 'connection_type'>>;
  parser: LookerTableIdentifierParser;
}): Promise<Record<string, ParsedTargetTable>> {
  const parsedTargetTables: Record<string, ParsedTargetTable> = {};
  const parseItems: LookerTableIdentifierParseItem[] = [];

  let models: StagedLookmlModelsFile;
  try {
    models = await args.client.listLookmlModels();
  } catch {
    return parsedTargetTables;
  }

  for (const model of models.models) {
    for (const exploreRef of model.explores) {
      let explore: StagedExploreFile;
      try {
        explore = await args.client.getExplore(model.name, exploreRef.name);
      } catch {
        continue;
      }
      const collected = collectExploreParseItems({
        explore,
        connectionMappings: args.connectionMappings,
        targetConnections: args.targetConnections,
      });
      Object.assign(parsedTargetTables, collected.parsedTargetTables);
      parseItems.push(...collected.parseItems);
    }
  }

  if (parseItems.length === 0) {
    return parsedTargetTables;
  }

  let results: Record<string, LookerParsedIdentifier>;
  try {
    results = await args.parser.parse(parseItems);
  } catch {
    for (const item of parseItems) {
      parsedTargetTables[item.key] = {
        ok: false,
        reason: 'parse_error',
        detail: 'Python parse-table-identifier failed during Looker pull-config projection.',
      };
    }
    return parsedTargetTables;
  }

  for (const item of parseItems) {
    parsedTargetTables[item.key] = projectParsedIdentifier(results[item.key]);
  }
  return parsedTargetTables;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

function readString(record: Record<string, unknown>, key: string): string | null {
  const value = record[key];
  return typeof value === 'string' ? value : null;
}
