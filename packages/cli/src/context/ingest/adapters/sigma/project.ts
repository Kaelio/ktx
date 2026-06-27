import { readdir, readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { z } from 'zod';
import type { SemanticLayerService } from '../../../../context/sl/semantic-layer.service.js';
import type { SemanticLayerSource } from '../../../../context/sl/types.js';
import type { DeterministicProjectionContext, ProjectionResult } from '../../types.js';
import { sigmaProjectionConfigSchema, stagedDataModelFileSchema, STAGED_FILES } from './types.js';

async function readProjectionConfig(stagedDir: string): Promise<Record<string, string>> {
  try {
    const body = await readFile(join(stagedDir, STAGED_FILES.projectionConfig), 'utf-8');
    return sigmaProjectionConfigSchema.parse(JSON.parse(body)).connectionMappings;
  } catch {
    return {};
  }
}

const SIGMA_AUTHOR = { name: 'Sigma', email: 'system@kaelio.dev' } as const;

// Best-effort schema for the raw spec blob stored in staged data model files.
const warehouseTableSourceSchema = z.object({
  kind: z.literal('warehouse-table'),
  connectionId: z.string(),
  path: z.array(z.string()),
});

const specColumnSchema = z
  .object({
    id: z.string(),
    formula: z.string().optional(),
    name: z.string().optional(),
    hidden: z.boolean().optional(),
    description: z.string().optional(),
    format: z.object({ kind: z.string() }).passthrough().optional(),
  })
  .passthrough();

const specElementSchema = z
  .object({
    id: z.string(),
    kind: z.string().optional(),
    name: z.string().optional(),
    hidden: z.boolean().optional(),
    source: z.object({ kind: z.string() }).passthrough().optional(),
    columns: z.array(specColumnSchema).optional(),
  })
  .passthrough();

const specPageSchema = z
  .object({
    id: z.string(),
    name: z.string().optional(),
    elements: z.array(specElementSchema).optional(),
  })
  .passthrough();

const sigmaSpecSchema = z
  .object({
    name: z.string().optional(),
    pages: z.array(specPageSchema).optional(),
  })
  .passthrough();

type SpecColumn = z.infer<typeof specColumnSchema>;

// Aggregation functions that classify a formula as a measure.
const AGG_PREFIXES = [
  'Sum(',
  'Count(',
  'CountDistinct(',
  'Avg(',
  'Average(',
  'Min(',
  'Max(',
  'StdDev(',
  'Variance(',
  'Median(',
  'Corr(',
];

function isAggregationFormula(formula: string): boolean {
  const trimmed = formula.trim();
  return AGG_PREFIXES.some((prefix) => trimmed.startsWith(prefix));
}

/** Extract the column name from a bracket formula like `[TABLE/Column Name]` or `[Column]`. */
function extractColumnName(formula: string): string | null {
  const match = /\[(?:[^\]/]+\/)?([^\]]+)\]/.exec(formula.trim());
  return match?.[1] ?? null;
}

function slugify(value: string): string {
  return value
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '_')
    .replace(/^_+|_+$/g, '');
}

function inferColumnType(col: SpecColumn): string {
  const kind = col.format?.kind;
  if (kind === 'datetime' || kind === 'date') return 'time';
  if (kind === 'number' || kind === 'currency' || kind === 'percent') return 'number';
  return 'string';
}

function buildSourceFromElement(
  dataModelName: string,
  elementName: string | undefined,
  elementId: string,
  warehousePath: string[],
  columns: SpecColumn[],
): SemanticLayerSource | null {
  const table = warehousePath.join('.');
  if (!table) return null;

  const modelSlug = slugify(dataModelName || elementId);
  const elemSlug = elementName ? slugify(elementName) : '';
  const sourceName = elemSlug && elemSlug !== modelSlug ? `${modelSlug}_${elemSlug}` : modelSlug;
  if (!sourceName) return null;

  const slColumns: SemanticLayerSource['columns'] = [];
  const measures: SemanticLayerSource['measures'] = [];

  for (const col of columns) {
    if (col.hidden) continue;
    if (!col.formula) continue;

    const displayName = col.name ?? extractColumnName(col.formula);
    if (!displayName) continue;
    const colSlug = slugify(displayName);
    if (!colSlug) continue;

    if (isAggregationFormula(col.formula)) {
      measures.push({
        name: colSlug,
        expr: col.formula,
        ...(col.description ? { description: col.description } : {}),
      });
    } else {
      slColumns.push({
        name: colSlug,
        type: inferColumnType(col),
        ...(col.description ? { descriptions: { user: col.description } } : {}),
      });
    }
  }

  const source: SemanticLayerSource = {
    name: sourceName,
    table,
    grain: [],
    columns: slColumns,
    joins: [],
    measures,
  };

  if (dataModelName) {
    source.descriptions = { user: dataModelName };
  }

  return source;
}

type SlService = Pick<SemanticLayerService, 'writeSource'> & {
  forWorktree(workdir: string): Pick<SemanticLayerService, 'writeSource'>;
};

/** @internal */
export async function projectSigmaDataModels(
  ctx: DeterministicProjectionContext,
  slService: SlService,
): Promise<ProjectionResult> {
  const svc = ctx.workdir ? slService.forWorktree(ctx.workdir) : slService;
  const warnings: string[] = [];
  const errors: string[] = [];
  const touchedSources: Array<{ connectionId: string; sourceName: string }> = [];

  // connectionMappings: Sigma internal connection UUID → ktx warehouse connection ID.
  // When a mapping exists the source lands under the warehouse connection (enabling sl_validate).
  // Unmapped elements fall back to the Sigma connection ID.
  const connectionMappings = await readProjectionConfig(ctx.stagedDir);

  const dmDir = join(ctx.stagedDir, STAGED_FILES.dataModelsDir);
  let entries: string[];
  try {
    entries = await readdir(dmDir);
  } catch {
    return { warnings, errors, touchedSources, changedWikiPageKeys: [] };
  }

  for (const entry of entries) {
    if (!entry.endsWith('.json')) continue;

    let stagedFile: z.infer<typeof stagedDataModelFileSchema>;
    try {
      const body = await readFile(join(dmDir, entry), 'utf-8');
      stagedFile = stagedDataModelFileSchema.parse(JSON.parse(body));
    } catch {
      warnings.push(`Skipping malformed staged file: ${entry}`);
      continue;
    }

    if (!stagedFile.spec) continue;

    let spec: z.infer<typeof sigmaSpecSchema>;
    try {
      spec = sigmaSpecSchema.parse(stagedFile.spec);
    } catch {
      warnings.push(`Skipping unparseable spec for data model "${stagedFile.name}"`);
      continue;
    }

    for (const page of spec.pages ?? []) {
      for (const element of page.elements ?? []) {
        if (element.hidden) continue;

        const warehouseSource = warehouseTableSourceSchema.safeParse(element.source);
        if (!warehouseSource.success) continue;

        const source = buildSourceFromElement(
          stagedFile.name,
          element.name,
          element.id,
          warehouseSource.data.path,
          element.columns ?? [],
        );
        if (!source) continue;

        // Only write SL sources for elements whose Sigma connection is mapped to a warehouse connection.
        // Writing under an unmapped connection produces gate failures because the Sigma connection
        // is not a warehouse connection and cannot be validated.
        const targetConnectionId = connectionMappings[warehouseSource.data.connectionId];
        if (!targetConnectionId) {
          warnings.push(
            `Skipping SL source for "${stagedFile.name}" / "${element.name ?? element.id}": ` +
              `no connectionMappings entry for Sigma connection ${warehouseSource.data.connectionId}. ` +
              `Add a connectionMappings entry in ktx.yaml to enable SL projection for this element.`,
          );
          continue;
        }

        try {
          const result = await svc.writeSource(
            targetConnectionId,
            source,
            SIGMA_AUTHOR.name,
            SIGMA_AUTHOR.email,
            `Sigma: import data model "${stagedFile.name}"`,
          );
          touchedSources.push({ connectionId: targetConnectionId, sourceName: source.name });
          warnings.push(...result.warnings);
        } catch (err) {
          errors.push(`Failed to write source "${source.name}": ${err instanceof Error ? err.message : String(err)}`);
        }
      }
    }
  }

  return { warnings, errors, touchedSources, changedWikiPageKeys: [] };
}
