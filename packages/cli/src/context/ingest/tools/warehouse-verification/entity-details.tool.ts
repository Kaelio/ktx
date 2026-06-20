import { z } from 'zod';
import type { KtxTableRef } from '../../../scan/types.js';
import { WarehouseCatalogService, type TableDetail } from '../../../scan/warehouse-catalog.js';
import { BaseTool, type ToolContext, type ToolOutput } from '../../../../context/tools/base-tool.js';

const targetSchema = z.union([
  z.object({ display: z.string().min(1) }),
  z.object({
    catalog: z.string().nullable(),
    db: z.string().nullable(),
    name: z.string().min(1),
    column: z.string().optional(),
  }),
]);

const entityDetailsInputSchema = z.object({
  connectionId: z.string().regex(/^[a-zA-Z0-9_][a-zA-Z0-9_-]*$/),
  targets: z.array(targetSchema).min(1).max(50),
}).strict();

type EntityDetailsInput = z.infer<typeof entityDetailsInputSchema>;
type EntityDetailsTarget = EntityDetailsInput['targets'][number];

export interface EntityDetailsStructured {
  resolved: TableDetail[];
  missing: Array<{ target: unknown; candidates: KtxTableRef[] }>;
  scanAvailable: boolean;
}

function allowedConnectionNames(context: ToolContext): ReadonlySet<string> | null {
  return context.session?.allowedConnectionNames ?? null;
}

function targetLabel(target: EntityDetailsTarget): string {
  if ('display' in target) {
    return target.display;
  }
  return [target.catalog, target.db, target.name, target.column].filter((part): part is string => !!part).join('.');
}

function appendMissingTargetMarkdown(parts: string[], target: EntityDetailsTarget, candidates: KtxTableRef[]): void {
  parts.push(`Not found in scan: ${targetLabel(target)}`);
  if (candidates.length > 0) {
    parts.push(`Closest matches: ${candidates.map((candidate) => candidate.name).join(', ')}`);
  }
}

async function resolveTarget(
  catalog: WarehouseCatalogService,
  connectionId: string,
  target: EntityDetailsTarget,
): Promise<{ resolved: (KtxTableRef & { column?: string }) | null; candidates: KtxTableRef[] }> {
  if ('display' in target) {
    return catalog.resolveDisplayTarget(connectionId, target.display);
  }

  const candidateResolution = await catalog.resolveDisplayTarget(connectionId, targetLabel(target));
  return {
    resolved: {
      catalog: target.catalog,
      db: target.db,
      name: target.name,
      column: target.column,
    },
    candidates: candidateResolution.candidates,
  };
}

function sampleText(values: string[]): string {
  return values.length > 0 ? ` - sample: ${JSON.stringify(values.slice(0, 10))}` : '';
}

function appendTableMarkdown(parts: string[], detail: TableDetail, columnName?: string): void {
  const columns = columnName ? detail.columns.filter((column) => column.name === columnName) : detail.columns;
  parts.push(`### ${detail.display}`);
  parts.push(`Type: ${detail.kind} | Native columns: ${detail.columns.length}`);
  if (detail.description || detail.comment) {
    parts.push(`Description: ${detail.description ?? detail.comment}`);
  }
  parts.push('', 'Columns:');
  for (const column of columns) {
    const pk = column.primaryKey ? ', PK' : '';
    parts.push(`- ${column.name} (${column.nativeType}, nullable=${column.nullable}${pk})${sampleText(column.sampleValues)}`);
  }
  parts.push('');
}

function findColumn(detail: TableDetail, columnName: string): TableDetail['columns'][number] | null {
  const normalized = columnName.toLowerCase();
  return detail.columns.find((column) => column.name.toLowerCase() === normalized) ?? null;
}

export class EntityDetailsTool extends BaseTool<typeof entityDetailsInputSchema> {
  readonly name = 'entity_details';

  constructor(private readonly catalogFactory: (context: ToolContext) => WarehouseCatalogService) {
    super();
  }

  get description(): string {
    return 'Verify warehouse tables and columns from the latest live-database scan before writing them into wiki or semantic-layer output.';
  }

  get inputSchema() {
    return entityDetailsInputSchema;
  }

  async call(input: EntityDetailsInput, context: ToolContext): Promise<ToolOutput<EntityDetailsStructured>> {
    const allowed = allowedConnectionNames(context);
    if (allowed && !allowed.has(input.connectionId)) {
      return {
        markdown: `Connection "${input.connectionId}" is not available to this ingest stage.`,
        structured: { resolved: [], missing: [], scanAvailable: false },
      };
    }

    const catalog = this.catalogFactory(context);
    const scanAvailable = await catalog.hasScan(input.connectionId);
    if (!scanAvailable) {
      return {
        markdown: `No live-database scan available for connection "${input.connectionId}"; run \`ktx scan\` first.`,
        structured: { resolved: [], missing: [], scanAvailable: false },
      };
    }

    const parts: string[] = [];
    const resolved: TableDetail[] = [];
    const missing: EntityDetailsStructured['missing'] = [];

    for (const target of input.targets) {
      const resolution = await resolveTarget(catalog, input.connectionId, target);
      if (!resolution.resolved) {
        missing.push({ target, candidates: resolution.candidates });
        appendMissingTargetMarkdown(parts, target, resolution.candidates);
        continue;
      }
      const detail = await catalog.getTable({ connectionId: input.connectionId, ...resolution.resolved });
      if (!detail) {
        missing.push({ target, candidates: resolution.candidates });
        appendMissingTargetMarkdown(parts, target, resolution.candidates);
        continue;
      }
      const requestedColumn = resolution.resolved.column;
      if (requestedColumn) {
        const column = findColumn(detail, requestedColumn);
        if (!column) {
          missing.push({
            target,
            candidates: [{ catalog: detail.catalog, db: detail.db, name: detail.name }],
          });
          parts.push(`Column not found in scan: ${detail.display}.${requestedColumn}`);
          parts.push(`Available columns: ${detail.columns.map((candidate) => candidate.name).join(', ')}`);
          continue;
        }
        const scopedDetail = { ...detail, columns: [column] };
        resolved.push(scopedDetail);
        appendTableMarkdown(parts, scopedDetail, column.name);
        continue;
      }

      resolved.push(detail);
      appendTableMarkdown(parts, detail);
    }

    return {
      markdown: parts.join('\n').trim(),
      structured: { resolved, missing, scanAvailable: true },
    };
  }
}
