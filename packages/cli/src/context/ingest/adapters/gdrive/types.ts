import { z } from 'zod';

const GDRIVE_DOCS_SCOPE = 'https://www.googleapis.com/auth/documents.readonly';
const GDRIVE_DRIVE_SCOPE = 'https://www.googleapis.com/auth/drive.readonly';
export const GDRIVE_SCOPES = [GDRIVE_DRIVE_SCOPE, GDRIVE_DOCS_SCOPE] as const;
export const GDRIVE_SOURCE_KEY = 'gdrive';
export const GDRIVE_DOC_MIME_TYPE = 'application/vnd.google-apps.document';
export const GDRIVE_FOLDER_MIME_TYPE = 'application/vnd.google-apps.folder';

export const gdrivePullConfigSchema = z.object({
  serviceAccountKey: z.string().min(1),
  folderId: z.string().min(1),
  recursive: z.boolean().default(false),
});
export type GdrivePullConfig = z.infer<typeof gdrivePullConfigSchema>;

export const gdriveManifestSchema = z.object({
  source: z.literal(GDRIVE_SOURCE_KEY),
  folderId: z.string().min(1),
  recursive: z.boolean(),
  fetchedAt: z.string().datetime(),
  fileCount: z.number().int().nonnegative(),
  skipped: z.array(z.object({ externalId: z.string(), reason: z.string() })).default([]),
  warnings: z.array(z.string()).default([]),
});
export type GdriveManifest = z.infer<typeof gdriveManifestSchema>;

export const gdriveMetadataSchema = z.object({
  id: z.string(),
  title: z.string(),
  path: z.string(),
  url: z.string().nullable().default(null),
  mimeType: z.literal(GDRIVE_DOC_MIME_TYPE),
  folderId: z.string(),
  drivePath: z.array(z.string()).default([]),
  modifiedTime: z.string().datetime().nullable().default(null),
});

export const gdriveServiceAccountKeySchema = z.object({
  client_email: z.string().email(),
  private_key: z.string().min(1),
  project_id: z.string().min(1).optional(),
});
export type GdriveServiceAccountKey = z.infer<typeof gdriveServiceAccountKeySchema>;

export interface GdriveFileRecord {
  id: string;
  name: string;
  mimeType: string;
  parents: string[];
  webViewLink: string | null;
  modifiedTime: string | null;
}

export interface GoogleDocsDocument {
  documentId?: string;
  title?: string;
  body?: {
    content?: GoogleDocsStructuralElement[];
  };
  documentStyle?: GoogleDocsDocumentStyle;
  lists?: Record<string, GoogleDocsList>;
  headers?: Record<string, GoogleDocsHeaderFooter>;
  footers?: Record<string, GoogleDocsHeaderFooter>;
  tabs?: GoogleDocsTab[];
}

export interface GoogleDocsList {
  listProperties?: {
    nestingLevels?: GoogleDocsListNestingLevel[];
  };
}

interface GoogleDocsListNestingLevel {
  glyphType?: string;
  glyphSymbol?: string;
}

export interface GoogleDocsTab {
  tabProperties?: {
    tabId?: string;
    title?: string;
  };
  childTabs?: GoogleDocsTab[];
  documentTab?: {
    body?: {
      content?: GoogleDocsStructuralElement[];
    };
    documentStyle?: GoogleDocsDocumentStyle;
    lists?: Record<string, GoogleDocsList>;
    headers?: Record<string, GoogleDocsHeaderFooter>;
    footers?: Record<string, GoogleDocsHeaderFooter>;
  };
}

export interface GoogleDocsDocumentStyle {
  defaultHeaderId?: string;
  defaultFooterId?: string;
  firstPageHeaderId?: string;
  firstPageFooterId?: string;
  evenPageHeaderId?: string;
  evenPageFooterId?: string;
}

export interface GoogleDocsHeaderFooter {
  headerId?: string;
  footerId?: string;
  content?: GoogleDocsStructuralElement[];
}

export interface GoogleDocsStructuralElement {
  paragraph?: GoogleDocsParagraph;
  table?: GoogleDocsTable;
  sectionBreak?: unknown;
}

export interface GoogleDocsTable {
  tableRows?: GoogleDocsTableRow[];
}

interface GoogleDocsTableRow {
  tableCells?: GoogleDocsTableCell[];
}

export interface GoogleDocsTableCell {
  content?: GoogleDocsStructuralElement[];
}

export interface GoogleDocsParagraph {
  elements?: GoogleDocsParagraphElement[];
  bullet?: {
    listId?: string;
    nestingLevel?: number;
  };
  paragraphStyle?: {
    namedStyleType?: string;
    headingId?: string;
  };
}

export interface GoogleDocsLinkTarget {
  id?: string;
  tabId?: string;
}

export interface GoogleDocsParagraphElement {
  textRun?: {
    content?: string;
    textStyle?: {
      bold?: boolean;
      italic?: boolean;
      underline?: boolean;
      strikethrough?: boolean;
      link?: {
        url?: string;
        tabId?: string;
        headingId?: string;
        bookmarkId?: string;
        heading?: GoogleDocsLinkTarget;
        bookmark?: GoogleDocsLinkTarget;
      };
      weightedFontFamily?: { fontFamily?: string };
      baselineOffset?: 'SUPERSCRIPT' | 'SUBSCRIPT' | string;
    };
  };
  inlineObjectElement?: unknown;
  pageBreak?: unknown;
}
