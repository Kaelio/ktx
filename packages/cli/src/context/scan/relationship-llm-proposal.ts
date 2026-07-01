import { z } from 'zod';
import type { KtxLlmRuntimePort } from '../../context/llm/runtime-port.js';
import type { KtxEnrichedColumn, KtxEnrichedSchema, KtxEnrichedTable } from './enrichment-types.js';
import {
  normalizeKtxRelationshipName,
  type KtxRelationshipDiscoveryCandidate,
} from './relationship-candidates.js';
import type { KtxRelationshipColumnProfile, KtxRelationshipProfileArtifact } from './relationship-profiling.js';
import type { KtxScanEnrichmentSummary, KtxScanWarning, KtxTableRef } from './types.js';

const relationshipLlmProposalSchema = z.object({
  pkCandidates: z.array(
    z.object({
      table: z.string(),
      column: z.string(),
      confidence: z.number(),
      rationale: z.string(),
    }),
  ),
  fkCandidates: z.array(
    z.object({
      fromTable: z.string(),
      fromColumn: z.string(),
      toTable: z.string(),
      toColumn: z.string(),
      confidence: z.number(),
      rationale: z.string(),
    }),
  ),
});

type KtxRelationshipLlmProposalOutput = z.infer<typeof relationshipLlmProposalSchema>;

interface KtxRelationshipLlmProposalSettings {
  maxTablesPerBatch: number;
  maxColumnsPerTable: number;
  maxSampleValuesPerColumn: number;
  minConfidence: number;
}

export interface ProposeKtxRelationshipCandidatesWithLlmInput {
  connectionId: string;
  schema: KtxEnrichedSchema;
  profile: KtxRelationshipProfileArtifact;
  llmRuntime: KtxLlmRuntimePort | null;
  settings?: Partial<KtxRelationshipLlmProposalSettings>;
}

export interface KtxRelationshipLlmProposalResult {
  candidates: KtxRelationshipDiscoveryCandidate[];
  warnings: KtxScanWarning[];
  llmCalls: number;
  summary: KtxScanEnrichmentSummary['llmRelationshipValidation'];
}

const DEFAULT_SETTINGS: KtxRelationshipLlmProposalSettings = {
  maxTablesPerBatch: 40,
  maxColumnsPerTable: 80,
  maxSampleValuesPerColumn: 5,
  minConfidence: 0.55,
};

function mergeSettings(
  settings: Partial<KtxRelationshipLlmProposalSettings> | undefined,
): KtxRelationshipLlmProposalSettings {
  return { ...DEFAULT_SETTINGS, ...settings };
}

function clampConfidence(value: number): number {
  return Number(Math.max(0, Math.min(1, value)).toFixed(3));
}

function findTable(schema: KtxEnrichedSchema, name: string): KtxEnrichedTable | null {
  const normalized = name.toLowerCase();
  return schema.tables.find((table) => table.ref.name.toLowerCase() === normalized) ?? null;
}

function findColumn(table: KtxEnrichedTable, name: string): KtxEnrichedColumn | null {
  const normalized = name.toLowerCase();
  return table.columns.find((column) => column.name.toLowerCase() === normalized) ?? null;
}

function profileKey(table: KtxTableRef, column: KtxEnrichedColumn): string {
  return `${table.name}.${column.name}`;
}

function profileForColumn(
  profile: KtxRelationshipProfileArtifact,
  table: KtxEnrichedTable,
  column: KtxEnrichedColumn,
): KtxRelationshipColumnProfile | null {
  return profile.columns[profileKey(table.ref, column)] ?? null;
}

function rowCountForTable(profile: KtxRelationshipProfileArtifact, table: KtxEnrichedTable): number | null {
  return profile.tables.find((item) => item.table.name.toLowerCase() === table.ref.name.toLowerCase())?.rowCount ?? null;
}

function resolvedDescription(descriptions: Partial<Record<string, string>>): string | null {
  return descriptions.ai ?? descriptions.db ?? null;
}

function buildEvidencePacket(
  schema: KtxEnrichedSchema,
  profile: KtxRelationshipProfileArtifact,
  settings: KtxRelationshipLlmProposalSettings,
): Record<string, unknown> {
  return {
    connectionId: schema.connectionId,
    sqlAvailable: profile.sqlAvailable,
    tables: schema.tables
      .filter((table) => table.enabled)
      .slice(0, settings.maxTablesPerBatch)
      .map((table) => {
        const tableDescription = resolvedDescription(table.descriptions);
        return {
        name: table.ref.name,
        catalog: table.ref.catalog,
        db: table.ref.db,
        rowCount: rowCountForTable(profile, table),
        ...(tableDescription ? { description: tableDescription } : {}),
        columns: table.columns.slice(0, settings.maxColumnsPerTable).map((column) => {
          const columnProfile = profileForColumn(profile, table, column);
          const columnDescription = resolvedDescription(column.descriptions);
          return {
            name: column.name,
            nativeType: column.nativeType,
            normalizedType: column.normalizedType,
            dimensionType: column.dimensionType,
            nullable: column.nullable,
            declaredPrimaryKey: column.primaryKey,
            ...(columnDescription ? { description: columnDescription } : {}),
            profile: columnProfile
              ? {
                  rowCount: columnProfile.rowCount,
                  nullCount: columnProfile.nullCount,
                  distinctCount: columnProfile.distinctCount,
                  uniquenessRatio: columnProfile.uniquenessRatio,
                  nullRate: columnProfile.nullRate,
                  sampleValues: columnProfile.sampleValues.slice(0, settings.maxSampleValuesPerColumn),
                }
              : null,
          };
        }),
        };
      }),
  };
}

function pkProposalKey(table: string, column: string): string {
  return `${table.toLowerCase()}.${column.toLowerCase()}`;
}

function endpoint(table: KtxEnrichedTable, column: KtxEnrichedColumn) {
  return {
    tableId: table.id,
    columnIds: [column.id],
    table: table.ref,
    columns: [column.name],
  };
}

function relationshipId(fromTable: KtxEnrichedTable, fromColumn: KtxEnrichedColumn, toTable: KtxEnrichedTable, toColumn: KtxEnrichedColumn): string {
  return `${fromTable.id}:(${fromColumn.id})->${toTable.id}:(${toColumn.id})`;
}

function invalidReferenceWarning(message: string, metadata: Record<string, unknown>): KtxScanWarning {
  return {
    code: 'relationship_llm_invalid_reference',
    message,
    recoverable: true,
    metadata,
  };
}

function mapValidProposals(
  schema: KtxEnrichedSchema,
  output: KtxRelationshipLlmProposalOutput,
  settings: KtxRelationshipLlmProposalSettings,
): { candidates: KtxRelationshipDiscoveryCandidate[]; warnings: KtxScanWarning[] } {
  const warnings: KtxScanWarning[] = [];
  const pkProposals = new Set(output.pkCandidates.map((item) => pkProposalKey(item.table, item.column)));
  const candidates: KtxRelationshipDiscoveryCandidate[] = [];

  for (const item of output.fkCandidates) {
    if (item.confidence < settings.minConfidence) {
      continue;
    }
    const fromTable = findTable(schema, item.fromTable);
    const toTable = findTable(schema, item.toTable);
    const fromColumn = fromTable ? findColumn(fromTable, item.fromColumn) : null;
    const toColumn = toTable ? findColumn(toTable, item.toColumn) : null;
    if (!fromTable || !toTable || !fromColumn || !toColumn) {
      warnings.push(
        invalidReferenceWarning('ktx relationship LLM proposal referenced a table or column that is not in the schema.', {
          proposal: item,
        }),
      );
      continue;
    }

    const pkProposalExists = pkProposals.has(pkProposalKey(toTable.ref.name, toColumn.name));
    candidates.push({
      id: relationshipId(fromTable, fromColumn, toTable, toColumn),
      from: endpoint(fromTable, fromColumn),
      to: endpoint(toTable, toColumn),
      source: 'llm_proposal',
      status: 'review',
      relationshipType: 'many_to_one',
      confidence: clampConfidence(item.confidence),
      evidence: {
        sourceColumnBase: normalizeKtxRelationshipName(fromColumn.name).singular,
        targetTableBase: normalizeKtxRelationshipName(toTable.ref.name).singular,
        targetColumnBase: normalizeKtxRelationshipName(toColumn.name).singular,
        targetKeyScore: pkProposalExists ? 0.88 : 0.68,
        nameScore: 0.45,
        reasons: pkProposalExists ? ['llm_proposal', 'llm_pk_proposal'] : ['llm_proposal'],
        llmConfidence: clampConfidence(item.confidence),
        llmRationale: item.rationale,
      },
    });
  }

  return { candidates, warnings };
}

function generationFailureWarning(error: unknown): KtxScanWarning {
  const message = error instanceof Error ? error.message : String(error);
  return {
    code: 'relationship_llm_proposal_failed',
    message: `ktx relationship LLM proposal failed: ${message}`,
    recoverable: true,
  };
}

export async function proposeKtxRelationshipCandidatesWithLlm(
  input: ProposeKtxRelationshipCandidatesWithLlmInput,
): Promise<KtxRelationshipLlmProposalResult> {
  if (!input.llmRuntime) {
    return { candidates: [], warnings: [], llmCalls: 0, summary: 'skipped' };
  }

  const settings = mergeSettings(input.settings);
  const evidence = buildEvidencePacket(input.schema, input.profile, settings);
  const system = [
    'You are helping ktx review possible SQL relationships before validation.',
    'Use only the compact schema evidence. Propose likely primary keys and foreign keys for later SQL validation.',
    'Return structured output only; never assume a join is accepted.',
  ].join('\n');
  const prompt = JSON.stringify(evidence);

  try {
    const generated = await input.llmRuntime.generateObject<
      KtxRelationshipLlmProposalOutput,
      typeof relationshipLlmProposalSchema
    >({
      role: 'candidateExtraction',
      system,
      prompt,
      schema: relationshipLlmProposalSchema,
    });
    const output = relationshipLlmProposalSchema.parse(generated);
    const mapped = mapValidProposals(input.schema, output, settings);
    return {
      candidates: mapped.candidates,
      warnings: mapped.warnings,
      llmCalls: 1,
      summary: 'completed',
    };
  } catch (error) {
    return {
      candidates: [],
      warnings: [generationFailureWarning(error)],
      llmCalls: 1,
      summary: 'failed',
    };
  }
}
