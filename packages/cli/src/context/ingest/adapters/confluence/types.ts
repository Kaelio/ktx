import { z } from 'zod';

/** @internal */
export const CONFLUENCE_SOURCE_KEY = 'confluence';

const confluenceLocalConnectionIdSchema = z.string().regex(/^[a-zA-Z0-9][a-zA-Z0-9_-]*$/);

/** @internal */
export const confluencePullConfigSchema = z.object({
  confluenceConnectionId: confluenceLocalConnectionIdSchema,
  /** Limit crawl to specific space keys (e.g. ["ENG", "PROD"]). Defaults to all accessible spaces. */
  spaceKeys: z.array(z.string().min(1)).optional(),
});

export type ConfluencePullConfig = z.infer<typeof confluencePullConfigSchema>;

export function parseConfluencePullConfig(raw: unknown): ConfluencePullConfig {
  return confluencePullConfigSchema.parse(raw);
}

/** Written to stagedDir/pages/{pageId}.json during fetch(). */
export const stagedPageFileSchema = z.object({
  pageId: z.string(),
  spaceId: z.string(),
  spaceKey: z.string(),
  spaceName: z.string(),
  title: z.string(),
  parentId: z.string().nullable().default(null),
  breadcrumb: z.string(),
  url: z.string(),
  lastEditedAt: z.string().nullable().default(null),
  version: z.number().int(),
  status: z.string(),
  /** Raw Confluence storage-format XML. */
  contentStorage: z.string(),
});

export type StagedPageFile = z.infer<typeof stagedPageFileSchema>;

/** Written once per fetch() to stagedDir/confluence-manifest.json. Presence acts as detect() sentinel. */
export const confluenceManifestSchema = z.object({
  confluenceConnectionId: confluenceLocalConnectionIdSchema,
  baseUrl: z.string(),
  fetchedAt: z.string(),
  spaceCount: z.number().int(),
  pageCount: z.number().int(),
  spaceKeys: z.array(z.string()).optional(),
});

export type ConfluenceManifest = z.infer<typeof confluenceManifestSchema>;

/** Filenames inside stagedDir. Centralized so chunk() + fetch() + detect() all agree. */
export const STAGED_FILES = {
  manifest: 'confluence-manifest.json',
  pagesDir: 'pages',
} as const;
