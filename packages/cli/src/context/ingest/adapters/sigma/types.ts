import { z } from 'zod';

const sigmaLocalConnectionIdSchema = z.string().regex(/^[a-zA-Z0-9][a-zA-Z0-9_-]*$/);

/** Filters applied when listing workbooks. Shared with ListWorkbooksOptions in client-port.ts. */
const workbookFilterSchema = z.object({
  includeArchived: z.boolean().default(false),
  includeExplorations: z.boolean().default(false),
  /** ISO 8601 date string. Only workbooks updated on or after this date are included. */
  updatedSince: z.string().optional(),
});

/** Input shape for listWorkbooks — all fields optional since the client applies its own defaults. */
export type WorkbookFilterInput = z.input<typeof workbookFilterSchema>;

const dataModelFilterSchema = z.object({
  /** ISO 8601 date string. Only data models updated on or after this date are fetched. */
  updatedSince: z.string().optional(),
});

/** The lean config the adapter needs at `fetch()` time, stored in the ingest job's `bundleRef.config`. */
const sigmaPullConfigSchema = z.object({
  /** The ktx connection ID for the Sigma instance being swept. */
  sigmaConnectionId: sigmaLocalConnectionIdSchema,
  /**
   * Maps Sigma internal connection UUIDs (source.connectionId in data model specs)
   * to ktx warehouse connection IDs. When present, projected semantic-layer sources
   * are written under the mapped warehouse connection rather than the Sigma connection.
   */
  connectionMappings: z.record(z.string(), z.string()).optional(),
  /** Filters applied when listing workbooks. Defaults exclude archived and exploration workbooks. */
  workbookFilter: workbookFilterSchema.default({ includeArchived: false, includeExplorations: false }),
  /** Filters applied when listing data models. */
  dataModelFilter: dataModelFilterSchema.optional(),
});

export type SigmaPullConfig = z.infer<typeof sigmaPullConfigSchema>;

export function parseSigmaPullConfig(raw: unknown): SigmaPullConfig {
  return sigmaPullConfigSchema.parse(raw);
}

/** Written to stagedDir during fetch() and read back by project(), listTargetConnectionIds(), and the sigma_ingest skill. */
export const sigmaProjectionConfigSchema = z.object({
  connectionMappings: z.record(z.string(), z.string()).default({}),
  /** Filters that were active when workbooks were last fetched. Tells the skill what the staged set covers. */
  workbookFilter: workbookFilterSchema.default({ includeArchived: false, includeExplorations: false }),
});

export type SigmaProjectionConfig = z.infer<typeof sigmaProjectionConfigSchema>;

/**
 * A staged data model file, one per `data-models/<id>.json`.
 * Stores the summary metadata plus the raw spec blob from GET /v2/dataModels/{id}/spec.
 */
export const stagedDataModelFileSchema = z.object({
  sigmaId: z.string(),
  name: z.string(),
  /** Full path in Sigma, e.g. "Finance/Revenue Model". */
  path: z.string(),
  latestVersion: z.number(),
  updatedAt: z.string(),
  isArchived: z.boolean().default(false),
  /** URL-safe slug Sigma uses in the web UI (dataModelUrlId from the API). */
  dataModelUrlId: z.string().optional(),
  /** Raw spec from GET /v2/dataModels/{id}/spec (JSON format). */
  spec: z.unknown(),
});

export type StagedDataModelFile = z.infer<typeof stagedDataModelFileSchema>;

/** The manifest written once per `fetch()`. Presence acts as the detect() sentinel. */
export const sigmaManifestSchema = z.object({
  sigmaConnectionId: sigmaLocalConnectionIdSchema,
  fetchedAt: z.string(),
  dataModelCount: z.number().int(),
  workbookCount: z.number().int().default(0),
});

export type SigmaManifest = z.infer<typeof sigmaManifestSchema>;

/**
 * A staged workbook file, one per `workbooks/<id>.json`.
 * Stores the summary metadata from GET /v2/workbooks (no separate spec endpoint).
 */
export const stagedWorkbookFileSchema = z.object({
  sigmaId: z.string(),
  name: z.string(),
  path: z.string(),
  latestVersion: z.number(),
  updatedAt: z.string(),
  isArchived: z.boolean().default(false),
  workbookUrlId: z.string().optional(),
  description: z.string().optional(),
});

export type StagedWorkbookFile = z.infer<typeof stagedWorkbookFileSchema>;

/** Filenames inside stagedDir. Centralized so chunk() + fetch() + detect() all agree. */
export const STAGED_FILES = {
  manifest: 'sigma-manifest.json',
  projectionConfig: 'sigma-projection-config.json',
  dataModelsDir: 'data-models',
  workbooksDir: 'workbooks',
} as const;
