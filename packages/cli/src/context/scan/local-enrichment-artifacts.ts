import YAML from 'yaml';
import { buildLiveDatabaseManifestShards, type LiveDatabaseManifestExistingDescriptions, type LiveDatabaseManifestJoinData, type LiveDatabaseManifestJoinEntry, type LiveDatabaseManifestShard, type LiveDatabaseManifestTableData } from '../../context/ingest/adapters/live-database/manifest.js';
import type { TableUsageOutput } from '../../context/ingest/adapters/historic-sql/skill-schemas.js';
import type { KtxScanRelationshipConfig } from '../project/config.js';
import type { KtxLocalProject } from '../../context/project/project.js';
import { isSlYamlPath } from '../../context/sl/source-files.js';
import { deriveFederatedConnection } from '../connections/federation.js';
import type { KtxLocalScanEnrichmentResult } from './local-enrichment.js';
import {
  buildKtxRelationshipArtifacts,
  buildKtxRelationshipDiagnostics,
  emptyKtxRelationshipProfileArtifact,
} from './relationship-diagnostics.js';
import type { KtxConnectionDriver, KtxSchemaColumn, KtxSchemaSnapshot, KtxSchemaTable } from './types.js';

const LIVE_DATABASE_ADAPTER = 'live-database';
const LOCAL_AUTHOR = 'ktx';
const LOCAL_AUTHOR_EMAIL = 'ktx@example.com';
const SCHEMA_DIR = '_schema';
const SL_DIR_PREFIX = 'semantic-layer';

export interface WriteLocalScanManifestShardsInput {
  project: KtxLocalProject;
  connectionId: string;
  syncId: string;
  driver: KtxConnectionDriver;
  snapshot: KtxSchemaSnapshot;
  dryRun: boolean;
  descriptionUpdates?: KtxLocalScanEnrichmentResult['descriptionUpdates'];
  relationshipUpdate?: KtxLocalScanEnrichmentResult['relationshipUpdate'];
}

export interface WriteLocalScanManifestShardsResult {
  manifestShards: string[];
  manifestShardsWritten: number;
}

export interface WriteLocalScanEnrichmentArtifactsInput {
  project: KtxLocalProject;
  connectionId: string;
  syncId: string;
  driver: KtxConnectionDriver;
  enrichment: KtxLocalScanEnrichmentResult;
  dryRun: boolean;
  relationshipSettings?: KtxScanRelationshipConfig;
}

export interface WriteLocalScanEnrichmentArtifactsResult extends WriteLocalScanManifestShardsResult {
  enrichmentArtifacts: string[];
}

interface ExistingManifestState {
  descriptions: Map<string, LiveDatabaseManifestExistingDescriptions>;
  preservedJoins: Map<string, LiveDatabaseManifestJoinEntry[]>;
  usage: Map<string, TableUsageOutput>;
}

type LocalDescriptionUpdates = KtxLocalScanEnrichmentResult['descriptionUpdates'];

function isGeneratedErrorDescription(description: string | null | undefined): boolean {
  const normalized = description?.trim().toLowerCase();
  return (
    normalized === 'failed to generate description' ||
    normalized?.startsWith('error generating description:') === true
  );
}

function artifactDir(connectionId: string, syncId: string): string {
  return `raw-sources/${connectionId}/${LIVE_DATABASE_ADAPTER}/${syncId}/enrichment`;
}

function schemaDir(connectionId: string): string {
  return `${SL_DIR_PREFIX}/${connectionId}/${SCHEMA_DIR}`;
}

function tableDescription(
  table: KtxSchemaTable,
  descriptionUpdates: LocalDescriptionUpdates = [],
): Record<string, string> | undefined {
  const update = descriptionUpdates.find((candidate) => candidate.table.name === table.name);
  const descriptions: Record<string, string> = {};
  if (table.comment) {
    descriptions.db = table.comment;
  }
  if (update?.tableDescription && !isGeneratedErrorDescription(update.tableDescription)) {
    descriptions.ai = update.tableDescription;
  }
  return Object.keys(descriptions).length > 0 ? descriptions : undefined;
}

function columnDescription(
  table: KtxSchemaTable,
  column: KtxSchemaColumn,
  descriptionUpdates: LocalDescriptionUpdates = [],
): Record<string, string> | undefined {
  const update = descriptionUpdates.find((candidate) => candidate.table.name === table.name);
  const aiDescription = update?.columnDescriptions[column.name] ?? null;
  const descriptions: Record<string, string> = {};
  if (column.comment) {
    descriptions.db = column.comment;
  }
  if (aiDescription && !isGeneratedErrorDescription(aiDescription)) {
    descriptions.ai = aiDescription;
  }
  return Object.keys(descriptions).length > 0 ? descriptions : undefined;
}

function snapshotTablesToManifestData(
  snapshot: KtxSchemaSnapshot,
  descriptionUpdates: LocalDescriptionUpdates = [],
): LiveDatabaseManifestTableData[] {
  return snapshot.tables.map((table) => ({
    name: table.name,
    catalog: table.catalog,
    db: table.db,
    descriptions: tableDescription(table, descriptionUpdates),
    columns: table.columns.map((column) => ({
      name: column.name,
      type: column.dimensionType,
      ...(column.primaryKey ? { pk: true } : {}),
      ...(column.nullable === false ? { nullable: false } : {}),
      descriptions: columnDescription(table, column, descriptionUpdates),
    })),
  }));
}

function formalJoins(snapshot: KtxSchemaSnapshot): LiveDatabaseManifestJoinData[] {
  const joins: LiveDatabaseManifestJoinData[] = [];
  for (const table of snapshot.tables) {
    for (const foreignKey of table.foreignKeys) {
      joins.push({
        fromTable: table.name,
        fromColumns: [foreignKey.fromColumn],
        toTable: foreignKey.toTable,
        toColumns: [foreignKey.toColumn],
        relationship: 'many_to_one',
        source: 'formal',
      });
    }
  }
  return joins;
}

function acceptedRelationshipJoins(
  relationshipUpdate: KtxLocalScanEnrichmentResult['relationshipUpdate'] | undefined,
): LiveDatabaseManifestJoinData[] {
  return (relationshipUpdate?.accepted ?? []).map((relationship) => ({
    fromTable: relationship.from.table.name,
    fromColumns: relationship.from.columns,
    toTable: relationship.to.table.name,
    toColumns: relationship.to.columns,
    relationship: relationship.relationshipType,
    source: relationship.source,
  }));
}

function relationshipJoins(
  snapshot: KtxSchemaSnapshot,
  relationshipUpdate: KtxLocalScanEnrichmentResult['relationshipUpdate'] | undefined,
): LiveDatabaseManifestJoinData[] {
  const accepted = acceptedRelationshipJoins(relationshipUpdate);
  const manual = accepted.filter((relationship) => relationship.source === 'manual');
  const generated = accepted.filter((relationship) => relationship.source !== 'manual');
  return [...manual, ...formalJoins(snapshot), ...generated];
}

function validColumns(snapshot: KtxSchemaSnapshot): Map<string, Set<string>> {
  return new Map(snapshot.tables.map((table) => [table.name, new Set(table.columns.map((column) => column.name))]));
}

function joinReferencesExistingColumns(
  join: LiveDatabaseManifestJoinEntry,
  columnsByTable: Map<string, Set<string>>,
): boolean {
  const terms = join.on.split(/\s+AND\s+/iu);
  for (const term of terms) {
    const match = term.match(/^(\w+)\.(\w+)\s*=\s*(\w+)\.(\w+)$/u);
    if (!match) {
      return true;
    }
    const leftTable = match[1];
    const leftColumn = match[2];
    const rightTable = match[3];
    const rightColumn = match[4];
    if (!leftTable || !leftColumn || !rightTable || !rightColumn) {
      return true;
    }
    const leftColumns = columnsByTable.get(leftTable);
    const rightColumns = columnsByTable.get(rightTable);
    if ((leftColumns && !leftColumns.has(leftColumn)) || (rightColumns && !rightColumns.has(rightColumn))) {
      return false;
    }
  }
  return true;
}

async function federatedSiblingTargets(
  project: KtxLocalProject,
  connectionId: string,
): Promise<Set<string>> {
  const descriptor = deriveFederatedConnection(project.config.connections, project.projectDir);
  if (!descriptor) {
    return new Set();
  }
  const siblings = descriptor.members.filter((member) => member.connectionId !== connectionId);
  const perSibling = await Promise.all(siblings.map((sibling) => siblingJoinTargets(project, sibling.connectionId)));
  return new Set(perSibling.flat());
}

async function siblingJoinTargets(project: KtxLocalProject, connectionId: string): Promise<string[]> {
  const listed = await project.fileStore.listFiles(schemaDir(connectionId)).catch(() => ({ files: [] }));
  const files = listed.files.filter(isSlYamlPath);
  const perFile = await Promise.all(
    files.map(async (file) => {
      const shard = await project.fileStore
        .readFile(file)
        .then(({ content }) => YAML.parse(content) as LiveDatabaseManifestShard | null)
        .catch(() => null);
      // entry.table is buildTableRef's member-local ref (1-3 parts:
      // table / schema.table / catalog.schema.table), never connectionId-
      // prefixed — so prefixing with the member id yields the fully-qualified
      // `to:` form authored in cross-DB joins.
      return Object.values(shard?.tables ?? {}).map((entry) => `${connectionId}.${entry.table}`);
    }),
  );
  return perFile.flat();
}

async function loadExistingManifestState(
  project: KtxLocalProject,
  connectionId: string,
  snapshot: KtxSchemaSnapshot,
  siblingTargets: Set<string>,
): Promise<ExistingManifestState> {
  const descriptions = new Map<string, LiveDatabaseManifestExistingDescriptions>();
  const preservedJoins = new Map<string, LiveDatabaseManifestJoinEntry[]>();
  const usage = new Map<string, TableUsageOutput>();
  const validTableNames = new Set(snapshot.tables.map((table) => table.name));
  const columnsByTable = validColumns(snapshot);

  let files: string[];
  try {
    files = (await project.fileStore.listFiles(schemaDir(connectionId))).files.filter(isSlYamlPath);
  } catch {
    return { descriptions, preservedJoins, usage };
  }

  for (const file of files) {
    try {
      const { content } = await project.fileStore.readFile(file);
      const shard = YAML.parse(content) as LiveDatabaseManifestShard | null;
      if (!shard?.tables) {
        continue;
      }
      for (const [tableName, entry] of Object.entries(shard.tables)) {
        if (!validTableNames.has(tableName)) {
          continue;
        }
        descriptions.set(tableName, {
          table: entry.descriptions ? { ...entry.descriptions } : undefined,
          columns: new Map(
            (entry.columns ?? []).flatMap((column) =>
              column.descriptions ? ([[column.name, { ...column.descriptions }]] as const) : [],
            ),
          ),
        });
        if (entry.usage) {
          usage.set(tableName, { ...entry.usage });
        }
        const joins = (entry.joins ?? []).filter((join) => {
          return (
            (join.source === 'manual' || join.source === 'inferred') &&
            (validTableNames.has(join.to) || siblingTargets.has(join.to)) &&
            joinReferencesExistingColumns(join, columnsByTable)
          );
        });
        if (joins.length > 0) {
          preservedJoins.set(tableName, joins);
        }
      }
    } catch {
      continue;
    }
  }

  return { descriptions, preservedJoins, usage };
}

async function writeJsonArtifact(
  project: KtxLocalProject,
  path: string,
  value: unknown,
  commitMessage: string,
): Promise<void> {
  await project.fileStore.writeFile(
    path,
    `${JSON.stringify(value, null, 2)}\n`,
    LOCAL_AUTHOR,
    LOCAL_AUTHOR_EMAIL,
    commitMessage,
  );
}

export async function writeLocalScanManifestShards(
  input: WriteLocalScanManifestShardsInput,
): Promise<WriteLocalScanManifestShardsResult> {
  if (input.dryRun) {
    return {
      manifestShards: [],
      manifestShardsWritten: 0,
    };
  }

  const siblingTargets = await federatedSiblingTargets(input.project, input.connectionId);
  const existing = await loadExistingManifestState(
    input.project,
    input.connectionId,
    input.snapshot,
    siblingTargets,
  );
  const { shards } = buildLiveDatabaseManifestShards({
    connectionType: input.driver.toUpperCase(),
    tables: snapshotTablesToManifestData(input.snapshot, input.descriptionUpdates),
    joins: relationshipJoins(input.snapshot, input.relationshipUpdate),
    existingDescriptions: existing.descriptions,
    existingPreservedJoins: existing.preservedJoins,
    existingUsage: existing.usage,
    federatedSiblingTargets: siblingTargets,
    mapColumnType: (dimensionType) => dimensionType,
  });

  const manifestShards: string[] = [];
  for (const [shardKey, shard] of [...shards.entries()].sort(([left], [right]) => left.localeCompare(right))) {
    const path = `${schemaDir(input.connectionId)}/${shardKey}.yaml`;
    await input.project.fileStore.writeFile(
      path,
      YAML.stringify(shard, { indent: 2, lineWidth: 0, version: '1.1' }),
      LOCAL_AUTHOR,
      LOCAL_AUTHOR_EMAIL,
      `scan(${LIVE_DATABASE_ADAPTER}): write manifest shard ${shardKey} syncId=${input.syncId}`,
    );
    manifestShards.push(path);
  }

  return {
    manifestShards,
    manifestShardsWritten: manifestShards.length,
  };
}

export async function writeLocalScanEnrichmentArtifacts(
  input: WriteLocalScanEnrichmentArtifactsInput,
): Promise<WriteLocalScanEnrichmentArtifactsResult> {
  if (input.dryRun) {
    return {
      enrichmentArtifacts: [],
      manifestShards: [],
      manifestShardsWritten: 0,
    };
  }

  const enrichmentRoot = artifactDir(input.connectionId, input.syncId);
  const descriptionsArtifact = `${enrichmentRoot}/descriptions.json`;
  const embeddingsArtifact = `${enrichmentRoot}/embeddings.json`;
  const relationshipsArtifact = `${enrichmentRoot}/relationships.json`;
  const relationshipProfileArtifact = `${enrichmentRoot}/relationship-profile.json`;
  const relationshipDiagnosticsArtifact = `${enrichmentRoot}/relationship-diagnostics.json`;
  const enrichmentArtifacts: string[] = [];

  if (
    input.enrichment.summary.tableDescriptions === 'completed' ||
    input.enrichment.summary.columnDescriptions === 'completed'
  ) {
    enrichmentArtifacts.push(descriptionsArtifact);
    await writeJsonArtifact(
      input.project,
      descriptionsArtifact,
      input.enrichment.descriptionUpdates,
      `scan(${LIVE_DATABASE_ADAPTER}): write enrichment descriptions syncId=${input.syncId}`,
    );
  }
  if (input.enrichment.summary.embeddings === 'completed') {
    enrichmentArtifacts.push(embeddingsArtifact);
    await writeJsonArtifact(
      input.project,
      embeddingsArtifact,
      input.enrichment.embeddingUpdates,
      `scan(${LIVE_DATABASE_ADAPTER}): write enrichment embeddings syncId=${input.syncId}`,
    );
  }
  enrichmentArtifacts.push(relationshipsArtifact, relationshipProfileArtifact, relationshipDiagnosticsArtifact);
  const hasResolvedRelationships = input.enrichment.resolvedRelationships !== null;
  const relationshipArtifacts = buildKtxRelationshipArtifacts({
    connectionId: input.connectionId,
    resolvedRelationships: hasResolvedRelationships ? (input.enrichment.resolvedRelationships ?? []) : undefined,
    compositeRelationships: input.enrichment.compositeRelationships ?? undefined,
    relationshipUpdate: input.enrichment.relationshipUpdate ?? {
      connectionId: input.connectionId,
      accepted: [],
      rejected: [],
      skipped: [],
    },
  });
  const relationshipProfile =
    input.enrichment.relationshipProfile ??
    emptyKtxRelationshipProfileArtifact({
      connectionId: input.connectionId,
      driver: input.driver,
      reason: 'relationship_profiling_not_run',
    });
  const relationshipDiagnostics = buildKtxRelationshipDiagnostics({
    connectionId: input.connectionId,
    artifacts: relationshipArtifacts,
    profile: relationshipProfile,
    warnings: input.enrichment.warnings,
    thresholds: input.relationshipSettings
      ? {
          acceptThreshold: input.relationshipSettings.acceptThreshold,
          reviewThreshold: input.relationshipSettings.reviewThreshold,
        }
      : undefined,
    policy: input.relationshipSettings
      ? {
          validationRequiredForManifest: input.relationshipSettings.validationRequiredForManifest,
          maxCandidatesPerColumn: input.relationshipSettings.maxCandidatesPerColumn,
          profileSampleRows: input.relationshipSettings.profileSampleRows,
          profileConcurrency: input.relationshipSettings.profileConcurrency,
          validationConcurrency: input.relationshipSettings.validationConcurrency,
        }
      : undefined,
  });

  await writeJsonArtifact(
    input.project,
    relationshipsArtifact,
    relationshipArtifacts,
    `scan(${LIVE_DATABASE_ADAPTER}): write enrichment relationships syncId=${input.syncId}`,
  );
  await writeJsonArtifact(
    input.project,
    relationshipProfileArtifact,
    relationshipProfile,
    `scan(${LIVE_DATABASE_ADAPTER}): write relationship profile syncId=${input.syncId}`,
  );
  await writeJsonArtifact(
    input.project,
    relationshipDiagnosticsArtifact,
    relationshipDiagnostics,
    `scan(${LIVE_DATABASE_ADAPTER}): write relationship diagnostics syncId=${input.syncId}`,
  );

  const manifestResult = await writeLocalScanManifestShards({
    project: input.project,
    connectionId: input.connectionId,
    syncId: input.syncId,
    driver: input.driver,
    snapshot: input.enrichment.snapshot,
    descriptionUpdates: input.enrichment.descriptionUpdates,
    relationshipUpdate: input.enrichment.relationshipUpdate,
    dryRun: false,
  });

  return {
    enrichmentArtifacts,
    manifestShards: manifestResult.manifestShards,
    manifestShardsWritten: manifestResult.manifestShardsWritten,
  };
}
