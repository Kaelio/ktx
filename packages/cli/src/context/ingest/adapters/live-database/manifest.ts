import type { TableUsageOutput } from '../historic-sql/skill-schemas.js';

const RELATIONSHIP_MAP: Record<string, string> = {
  MANY_TO_ONE: 'many_to_one',
  ONE_TO_MANY: 'one_to_many',
  ONE_TO_ONE: 'one_to_one',
};

const RELATIONSHIP_INVERSE: Record<string, string> = {
  many_to_one: 'one_to_many',
  one_to_many: 'many_to_one',
  one_to_one: 'one_to_one',
};

const SCAN_MANAGED_DESCRIPTION_KEYS = new Set(['db', 'ai']);
const HISTORIC_SQL_MANAGED_USAGE_KEYS = new Set([
  'narrative',
  'frequencyTier',
  'commonFilters',
  'commonGroupBys',
  'commonJoins',
  'staleSince',
]);

interface LiveDatabaseManifestColumn {
  name: string;
  type: string;
  pk?: boolean;
  nullable?: boolean;
  descriptions?: Record<string, string>;
}

export interface LiveDatabaseManifestJoinEntry {
  to: string;
  on: string;
  relationship: string;
  source: string;
}

interface LiveDatabaseManifestTableEntry {
  table: string;
  descriptions?: Record<string, string>;
  usage?: TableUsageOutput;
  columns: LiveDatabaseManifestColumn[];
  joins?: LiveDatabaseManifestJoinEntry[];
}

export interface LiveDatabaseManifestShard {
  tables: Record<string, LiveDatabaseManifestTableEntry>;
}

export interface LiveDatabaseManifestTableData {
  name: string;
  catalog: string | null;
  db: string | null;
  descriptions?: Record<string, string>;
  usage?: TableUsageOutput;
  columns: Array<{
    name: string;
    type: string;
    pk?: boolean;
    nullable?: boolean;
    descriptions?: Record<string, string>;
  }>;
}

export interface LiveDatabaseManifestJoinData {
  fromTable: string;
  fromColumns: string[];
  toTable: string;
  toColumns: string[];
  relationship: string;
  source: 'formal' | 'inferred' | 'manual';
}

export interface LiveDatabaseManifestExistingDescriptions {
  table?: Record<string, string>;
  columns: Map<string, Record<string, string>>;
}

export interface BuildLiveDatabaseManifestShardsInput {
  connectionType: string;
  tables: LiveDatabaseManifestTableData[];
  joins: LiveDatabaseManifestJoinData[];
  mapColumnType: (nativeType: string) => string;
  existingPreservedJoins?: Map<string, LiveDatabaseManifestJoinEntry[]>;
  existingDescriptions?: Map<string, LiveDatabaseManifestExistingDescriptions>;
  existingUsage?: Map<string, TableUsageOutput>;
  // Table refs owned by other federated members; declared cross-DB joins to
  // these survive even though the target has no shard in this snapshot.
  federatedSiblingTargets?: Set<string>;
}

export interface BuildLiveDatabaseManifestShardsResult {
  shards: Map<string, LiveDatabaseManifestShard>;
  tablesProcessed: number;
}

function mergeDescriptionsPreservingExternal(
  existing: Record<string, string> | undefined,
  incoming: Record<string, string> | undefined,
): Record<string, string> | undefined {
  if (!existing && !incoming) {
    return undefined;
  }
  const result: Record<string, string> = {};
  if (existing) {
    for (const [key, value] of Object.entries(existing)) {
      if (!SCAN_MANAGED_DESCRIPTION_KEYS.has(key)) {
        result[key] = value;
      }
    }
  }
  if (incoming) {
    Object.assign(result, incoming);
  }
  return Object.keys(result).length > 0 ? result : undefined;
}

export function mergeUsagePreservingExternal(
  existing: TableUsageOutput | undefined,
  incoming: TableUsageOutput | undefined,
): TableUsageOutput | undefined {
  if (!existing && !incoming) {
    return undefined;
  }
  if (!incoming) {
    return existing ? { ...existing } : undefined;
  }
  const result: Record<string, unknown> = {};
  if (existing) {
    for (const [key, value] of Object.entries(existing)) {
      if (!HISTORIC_SQL_MANAGED_USAGE_KEYS.has(key)) {
        result[key] = value;
      }
    }
  }
  Object.assign(result, incoming);
  return Object.keys(result).length > 0 ? (result as TableUsageOutput) : undefined;
}

function getShardKey(connectionType: string, catalog: string | null, db: string | null): string {
  const normalized = connectionType.toUpperCase();

  switch (normalized) {
    case 'SNOWFLAKE':
    case 'DATABRICKS': {
      const catalogPart = catalog ?? 'default';
      const schemaPart = db ?? 'public';
      return `${catalogPart}.${schemaPart}`;
    }
    case 'BIGQUERY': {
      return db ?? catalog ?? 'default';
    }
    case 'MYSQL':
    case 'CLICKHOUSE': {
      return db ?? catalog ?? 'default';
    }
    default: {
      return db ?? 'public';
    }
  }
}

function buildTableRef(name: string, catalog: string | null, db: string | null): string {
  const parts: string[] = [];
  if (catalog) {
    parts.push(catalog);
  }
  if (db) {
    parts.push(db);
  }
  parts.push(name);
  return parts.join('.');
}

function addJoinOnce(
  joinsByTable: Map<string, LiveDatabaseManifestJoinEntry[]>,
  tableName: string,
  join: LiveDatabaseManifestJoinEntry,
): void {
  const joins = joinsByTable.get(tableName) ?? [];
  const exists = joins.some((candidate) => candidate.to === join.to && candidate.on === join.on);
  if (!exists) {
    joins.push(join);
  }
  joinsByTable.set(tableName, joins);
}

function joinCondition(
  leftTable: string,
  leftColumns: readonly string[],
  rightTable: string,
  rightColumns: readonly string[],
): string {
  if (leftColumns.length === 0 || leftColumns.length !== rightColumns.length) {
    throw new Error(`Invalid relationship join from ${leftTable} to ${rightTable}: column tuple widths differ`);
  }
  return leftColumns
    .map((leftColumn, index) => {
      const rightColumn = rightColumns[index];
      if (!rightColumn) {
        throw new Error(`Invalid relationship join from ${leftTable} to ${rightTable}: missing target column`);
      }
      return `${leftTable}.${leftColumn} = ${rightTable}.${rightColumn}`;
    })
    .join(' AND ');
}

/** @internal */
export function buildJoinsByTable(
  tableNames: Set<string>,
  joins: LiveDatabaseManifestJoinData[],
  preservedJoins: Map<string, LiveDatabaseManifestJoinEntry[]>,
  federatedSiblingTargets: Set<string> = new Set(),
): Map<string, LiveDatabaseManifestJoinEntry[]> {
  const joinsByTable = new Map<string, LiveDatabaseManifestJoinEntry[]>();

  for (const join of joins) {
    const fromLocal = tableNames.has(join.fromTable);
    const toLocal = tableNames.has(join.toTable);
    const toSibling = federatedSiblingTargets.has(join.toTable);
    if (!fromLocal || (!toLocal && !toSibling)) {
      continue;
    }
    const relationship = RELATIONSHIP_MAP[join.relationship] ?? join.relationship;
    addJoinOnce(joinsByTable, join.fromTable, {
      to: join.toTable,
      on: joinCondition(join.fromTable, join.fromColumns, join.toTable, join.toColumns),
      relationship,
      source: join.source,
    });

    // Reverse direction only when the target is a local table in THIS snapshot;
    // a federated sibling has no shard here, so it gets no reverse entry.
    if (toLocal) {
      const reverseRelationship = RELATIONSHIP_INVERSE[relationship] ?? 'one_to_many';
      addJoinOnce(joinsByTable, join.toTable, {
        to: join.fromTable,
        on: joinCondition(join.toTable, join.toColumns, join.fromTable, join.fromColumns),
        relationship: reverseRelationship,
        source: join.source,
      });
    }
  }

  for (const [tableName, tableJoins] of preservedJoins) {
    if (!tableNames.has(tableName)) {
      continue;
    }
    for (const join of tableJoins) {
      if (tableNames.has(join.to) || federatedSiblingTargets.has(join.to)) {
        addJoinOnce(joinsByTable, tableName, join);
      }
    }
  }

  return joinsByTable;
}

export function buildLiveDatabaseManifestShards(
  input: BuildLiveDatabaseManifestShardsInput,
): BuildLiveDatabaseManifestShardsResult {
  const tableNames = new Set(input.tables.map((table) => table.name));
  const joinsByTable = buildJoinsByTable(
    tableNames,
    input.joins,
    input.existingPreservedJoins ?? new Map(),
    input.federatedSiblingTargets ?? new Set(),
  );
  const shards = new Map<string, LiveDatabaseManifestShard>();

  for (const table of input.tables) {
    const shardKey = getShardKey(input.connectionType, table.catalog, table.db);
    const shard = shards.get(shardKey) ?? { tables: {} };
    const existingDescriptions = input.existingDescriptions?.get(table.name);

    const columns: LiveDatabaseManifestColumn[] = table.columns.map((column) => {
      const manifestColumn: LiveDatabaseManifestColumn = {
        name: column.name,
        type: input.mapColumnType(column.type),
      };
      if (column.pk) {
        manifestColumn.pk = true;
      }
      if (column.nullable === false) {
        manifestColumn.nullable = false;
      }
      const descriptions = mergeDescriptionsPreservingExternal(
        existingDescriptions?.columns.get(column.name),
        column.descriptions,
      );
      if (descriptions) {
        manifestColumn.descriptions = descriptions;
      }
      return manifestColumn;
    });

    const entry: LiveDatabaseManifestTableEntry = {
      table: buildTableRef(table.name, table.catalog, table.db),
      columns,
    };

    const tableDescriptions = mergeDescriptionsPreservingExternal(existingDescriptions?.table, table.descriptions);
    if (tableDescriptions) {
      entry.descriptions = tableDescriptions;
    }

    const usage = mergeUsagePreservingExternal(input.existingUsage?.get(table.name), table.usage);
    if (usage) {
      entry.usage = usage;
    }

    const tableJoins = joinsByTable.get(table.name);
    if (tableJoins && tableJoins.length > 0) {
      entry.joins = tableJoins;
    }

    shard.tables[table.name] = entry;
    shards.set(shardKey, shard);
  }

  return {
    shards,
    tablesProcessed: input.tables.length,
  };
}
