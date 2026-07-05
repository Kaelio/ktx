import { z } from 'zod';

const tableauLocalConnectionIdSchema = z.string().regex(/^[a-zA-Z0-9][a-zA-Z0-9_-]*$/);

/** Filters applied when listing published data sources. */
const datasourceFilterSchema = z.object({
  /** ISO 8601 date string. Only data sources updated on or after this date are fetched. */
  updatedSince: z.string().optional(),
});

/** Input shape for datasource filtering — all fields optional. */
export type DatasourceFilterInput = z.input<typeof datasourceFilterSchema>;

/** Filters applied when listing workbooks. */
const workbookFilterSchema = z.object({
  /** ISO 8601 date string. Only workbooks updated on or after this date are ingested. */
  updatedSince: z.string().optional(),
});

/** Input shape for workbook filtering — all fields optional. */
export type WorkbookFilterInput = z.input<typeof workbookFilterSchema>;

/**
 * The lean config the adapter needs at `fetch()` time, stored in the ingest job's `bundleRef.config`.
 */
const tableauPullConfigSchema = z.object({
  /** The ktx connection ID for the Tableau instance being swept. */
  tableauConnectionId: tableauLocalConnectionIdSchema,
  /** Filters applied when listing data sources during ingest. */
  datasourceFilter: datasourceFilterSchema.optional(),
  /** Filters applied when listing workbooks during ingest. */
  workbookFilter: workbookFilterSchema.optional(),
});

export type TableauPullConfig = z.infer<typeof tableauPullConfigSchema>;

export function parseTableauPullConfig(raw: unknown): TableauPullConfig {
  return tableauPullConfigSchema.parse(raw);
}

/** Written to stagedDir during fetch() and read back by chunk(), project(), and the tableau_ingest skill. */
export const tableauProjectionConfigSchema = z.object({
  /** Filters that were active when data sources were last fetched. Tells the skill what the staged set covers. */
  datasourceFilter: datasourceFilterSchema.optional(),
  /** Filters that were active when workbooks were last fetched. */
  workbookFilter: workbookFilterSchema.optional(),
});

export type TableauProjectionConfig = z.infer<typeof tableauProjectionConfigSchema>;

/**
 * A field on a published data source. A `formula` marks it as a calculated field; a plain
 * column field carries `dataType`/`role` only. `role` is Tableau's dimension/measure classification.
 */
export const stagedFieldSchema = z.object({
  name: z.string(),
  /** Tableau field role, e.g. "DIMENSION" | "MEASURE". */
  role: z.string().optional(),
  /** Tableau data type, e.g. "STRING" | "INTEGER" | "REAL" | "DATE". */
  dataType: z.string().optional(),
  /** The calculation expression for a CalculatedField; absent for a plain ColumnField. */
  formula: z.string().optional(),
  description: z.string().optional(),
  /** True when this field is a Tableau CalculatedField (has a formula). */
  isCalculated: z.boolean().default(false),
});

export type StagedField = z.infer<typeof stagedFieldSchema>;

/** An upstream (physical) table feeding a data source — the lineage edge to the warehouse. */
export const stagedUpstreamTableSchema = z.object({
  luid: z.string().optional(),
  name: z.string(),
  /** Schema/dataset the table lives in, when Tableau reports it. */
  schema: z.string().optional(),
  /** Fully-qualified name as Tableau reports it, e.g. "DATABASE.SCHEMA.TABLE". */
  fullName: z.string().optional(),
});

export type StagedUpstreamTable = z.infer<typeof stagedUpstreamTableSchema>;

/**
 * A staged published-data-source file, one per `datasources/<luid>.json`.
 * This document IS the graph: its `fields` (including calculated-field formulas) plus its
 * `upstreamTables` (lineage to physical warehouse tables).
 */
export const stagedDatasourceFileSchema = z.object({
  luid: z.string(),
  name: z.string(),
  /** Tableau project (folder) the data source lives in. */
  projectName: z.string().optional(),
  updatedAt: z.string().optional(),
  hasExtracts: z.boolean().default(false),
  description: z.string().optional(),
  fields: z.array(stagedFieldSchema).default([]),
  upstreamTables: z.array(stagedUpstreamTableSchema).default([]),
});

export type StagedDatasourceFile = z.infer<typeof stagedDatasourceFileSchema>;

/**
 * A staged workbook file, one per `workbooks/<luid>.json`.
 * Summary metadata only (name, project, description) — the durable business signal is the name.
 */
export const stagedWorkbookFileSchema = z.object({
  luid: z.string(),
  name: z.string(),
  projectName: z.string().optional(),
  description: z.string().optional(),
  updatedAt: z.string().optional(),
});

export type StagedWorkbookFile = z.infer<typeof stagedWorkbookFileSchema>;

/** The manifest written once per `fetch()`. Presence acts as the detect() sentinel. */
export const tableauManifestSchema = z.object({
  tableauConnectionId: tableauLocalConnectionIdSchema,
  fetchedAt: z.string(),
  datasourceCount: z.number().int(),
  workbookCount: z.number().int().default(0),
});

export type TableauManifest = z.infer<typeof tableauManifestSchema>;

/** Filenames inside stagedDir. Centralized so chunk() + fetch() + detect() all agree. */
export const STAGED_FILES = {
  manifest: 'tableau-manifest.json',
  projectionConfig: 'tableau-projection-config.json',
  datasourcesDir: 'datasources',
  workbooksDir: 'workbooks',
} as const;
