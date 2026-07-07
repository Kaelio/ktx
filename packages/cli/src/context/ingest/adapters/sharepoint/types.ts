import { z } from 'zod';

export const SHAREPOINT_SOURCE_KEY = 'sharepoint';
export const SHAREPOINT_ALLOWED_EXTENSIONS = new Set(['.docx', '.md']);
export const SHAREPOINT_GRAPH_SCOPE = 'https://graph.microsoft.com/.default';

export const sharepointPullConfigSchema = z.object({
  tenantId: z.string().min(1),
  clientId: z.string().min(1),
  clientSecret: z.string().min(1),
  driveId: z.string().min(1),
  folderId: z.string().min(1),
  recursive: z.boolean().default(false),
});
export type SharepointPullConfig = z.infer<typeof sharepointPullConfigSchema>;

export const sharepointManifestSchema = z.object({
  source: z.literal(SHAREPOINT_SOURCE_KEY),
  driveId: z.string().min(1),
  folderId: z.string().min(1),
  recursive: z.boolean(),
  fetchedAt: z.string().datetime(),
  fileCount: z.number().int().nonnegative(),
  skipped: z.array(z.object({ externalId: z.string(), reason: z.string() })).default([]),
  warnings: z.array(z.string()).default([]),
});
export type SharepointManifest = z.infer<typeof sharepointManifestSchema>;

export const sharepointMetadataSchema = z.object({
  id: z.string(),
  title: z.string(),
  path: z.string(),
  url: z.string().nullable().default(null),
  mimeType: z.enum(['text/markdown', 'application/vnd.openxmlformats-officedocument.wordprocessingml.document']),
  driveId: z.string(),
  folderId: z.string(),
  drivePath: z.array(z.string()).default([]),
  fileName: z.string(),
  lastModifiedDateTime: z.string().datetime().nullable().default(null),
});
export interface SharepointDriveItem {
  id: string;
  name: string;
  webUrl: string | null;
  lastModifiedDateTime: string | null;
  file: { mimeType?: string | null } | null;
  folder: { childCount?: number | null } | null;
  downloadUrl: string | null;
}

export interface SharepointDiscoveredDrive {
  id: string;
  name: string;
  webUrl: string | null;
}
