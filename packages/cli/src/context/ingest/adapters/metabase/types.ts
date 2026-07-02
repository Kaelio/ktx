import { z } from 'zod';

const metabaseSyncModeSchema = z.enum(['ALL', 'ONLY', 'EXCEPT']);
export type MetabaseSyncMode = z.infer<typeof metabaseSyncModeSchema>;

const metabaseLocalConnectionIdSchema = z.string().regex(/^[a-zA-Z0-9_][a-zA-Z0-9_-]*$/);

/**
 * The lean config the adapter needs at `fetch()` time. Lives in the BullMQ payload's
 * `bundleRef.config` when the runner invokes the adapter. Never persisted beyond one
 * job — the persisted state (enabled/disabled, auth, scheduling) lives on the
 * Metabase connection's `connections.config` JSONB.
 */
/** @internal */
export const metabasePullConfigSchema = z.object({
  /** The Metabase connection (source) — the thing being swept. */
  metabaseConnectionId: metabaseLocalConnectionIdSchema,
  /** The Metabase-side database id whose cards this bundle pulls (one bundle = one database). */
  metabaseDatabaseId: z.number().int().positive(),
});

export type MetabasePullConfig = z.infer<typeof metabasePullConfigSchema>;

export function parseMetabasePullConfig(raw: unknown): MetabasePullConfig {
  return metabasePullConfigSchema.parse(raw);
}

/** A Metabase column from `card.result_metadata`. Mirrors what the LLM consumes today. */
const stagedResultColumnSchema = z.object({
  name: z.string(),
  display_name: z.string().optional().nullable(),
  base_type: z.string(),
  semantic_type: z.string().optional().nullable(),
  description: z.string().optional().nullable(),
  fk_target_field_id: z.number().optional().nullable(),
  field_ref: z.array(z.unknown()).optional().nullable(),
});

export type StagedResultColumn = z.infer<typeof stagedResultColumnSchema>;

const stagedParameterSchema = z.object({
  id: z.string(),
  name: z.string(),
  type: z.string(),
  slug: z.string().optional().nullable(),
  default: z.unknown().optional().nullable(),
  sectionId: z.string().optional().nullable(),
});

export type StagedParameter = z.infer<typeof stagedParameterSchema>;

/** A template tag pulled from an MBQL card's `dataset_query.stages[0].template-tags`. */
const stagedTemplateTagSchema = z.object({
  name: z.string(),
  type: z.string(),
  defaultValue: z.string().optional().nullable(),
  /** If this tag is a saved-question reference (`{{#42}}`), the referenced card id. Null for plain tags. */
  cardReference: z.number().int().positive().optional().nullable(),
});

export type StagedTemplateTag = z.infer<typeof stagedTemplateTagSchema>;

/**
 * A serialized card file, one per `cards/<id>.json`. Hashed content-addressably by
 * the runner — key inputs that change cause re-ingest, cosmetic fields do not.
 */
export const stagedCardFileSchema = z.object({
  metabaseId: z.number().int().positive(),
  name: z.string(),
  description: z.string().nullable(),
  type: z.string(), // 'question' | 'model' | 'metric'
  databaseId: z.number().int().positive(),
  collectionId: z.union([z.number().int(), z.literal('root')]).nullable(),
  archived: z.boolean(),
  resolvedSql: z.string(),
  templateTags: z.array(stagedTemplateTagSchema),
  resultMetadata: z.array(stagedResultColumnSchema),
  /** Full collection breadcrumb path, e.g. ['Data', 'Orders Team']. `[]` for root cards. */
  collectionPath: z.array(z.string()),
  /** Card ids this card references via `{{#N}}` template tags or other saved-question refs. */
  referencedCardIds: z.array(z.number().int().positive()),
  parameters: z.array(stagedParameterSchema).default([]),
  lastRunAt: z.string().nullable().default(null),
  dashboardCount: z.number().int().nullable().default(null),
  resolutionStatus: z.enum(['resolved', 'fallback']),
});

export type StagedCardFile = z.infer<typeof stagedCardFileSchema>;

/** A serialized collection file, `collections/<id>.json`. Minimal — path lives on the card. */
const stagedCollectionFileSchema = z.object({
  metabaseId: z.union([z.number().int(), z.literal('root')]),
  name: z.string(),
  parentId: z.union([z.number().int(), z.literal('root')]).nullable(),
});

export type StagedCollectionFile = z.infer<typeof stagedCollectionFileSchema>;

/** A serialized database-mapping snapshot, `databases/<id>.json`. */
const stagedDatabaseFileSchema = z.object({
  metabaseDatabaseId: z.number().int().positive(),
  metabaseDatabaseName: z.string(),
  metabaseEngine: z.string().nullable(),
  targetConnectionId: metabaseLocalConnectionIdSchema,
});

export type StagedDatabaseFile = z.infer<typeof stagedDatabaseFileSchema>;

/** The filter snapshot. Written once per `fetch()` to `sync-config.json`. */
export const stagedSyncConfigSchema = z.object({
  metabaseConnectionId: metabaseLocalConnectionIdSchema,
  metabaseDatabaseId: z.number().int().positive(),
  syncMode: metabaseSyncModeSchema,
  selections: z.array(
    z.object({
      selectionType: z.enum(['collection', 'item']),
      metabaseObjectId: z.number().int(),
    }),
  ),
  defaultTagNames: z.array(z.string()),
  mapping: z.object({
    metabaseDatabaseId: z.number().int().positive(),
    metabaseDatabaseName: z.string(),
    metabaseEngine: z.string().nullable(),
    targetConnectionId: metabaseLocalConnectionIdSchema,
  }),
});

export type StagedSyncConfig = z.infer<typeof stagedSyncConfigSchema>;

/** Filenames inside stagedDir. Centralized so chunk() + fetch() + detect() all agree. */
export const STAGED_FILES = {
  syncConfig: 'sync-config.json',
  cardsDir: 'cards',
  collectionsDir: 'collections',
  databasesDir: 'databases',
  unresolvedCards: 'unresolved-cards.json',
} as const;
