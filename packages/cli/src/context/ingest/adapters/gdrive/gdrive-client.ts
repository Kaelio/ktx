import { JWT } from 'google-auth-library';
import type { GdriveFileRecord, GdriveServiceAccountKey, GoogleDocsDocument } from './types.js';
import { GDRIVE_DOC_MIME_TYPE, GDRIVE_FOLDER_MIME_TYPE, GDRIVE_SCOPES, gdriveServiceAccountKeySchema } from './types.js';

const GOOGLE_DRIVE_BASE_URL = 'https://www.googleapis.com/drive/v3';
const GOOGLE_DOCS_BASE_URL = 'https://docs.googleapis.com/v1';
const GOOGLE_FILE_FIELDS = 'id,name,mimeType,parents,webViewLink,modifiedTime';

const RETRYABLE_STATUSES = new Set([408, 429, 500, 502, 503, 504]);
const MAX_REQUEST_ATTEMPTS = 4;

interface GoogleApiFile {
  id?: string;
  name?: string;
  mimeType?: string;
  parents?: string[];
  webViewLink?: string;
  modifiedTime?: string;
}

interface GoogleApiListResponse {
  files?: GoogleApiFile[];
  nextPageToken?: string;
}

export interface GoogleDriveClient {
  listFiles(args: { q: string; pageToken?: string }): Promise<{ files: GdriveFileRecord[]; nextPageToken: string | null }>;
  getFile(fileId: string): Promise<GdriveFileRecord | null>;
}

export interface GoogleDocsClients {
  drive: GoogleDriveClient;
  docs: {
    getDocument(documentId: string): Promise<GoogleDocsDocument>;
  };
}

function defaultSleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function retryDelayMs(attempt: number, retryAfterHeader: string | null): number {
  const retryAfterSeconds = retryAfterHeader ? Number.parseInt(retryAfterHeader, 10) : Number.NaN;
  if (Number.isFinite(retryAfterSeconds) && retryAfterSeconds >= 0) {
    return Math.min(retryAfterSeconds * 1000, 30_000);
  }
  return Math.min(500 * 2 ** attempt, 8_000);
}

/** @internal Retries transient Google API responses (429/5xx) honoring Retry-After. */
export async function fetchWithGoogleRetry(
  doFetch: () => Promise<Response>,
  options: { maxAttempts?: number; sleep?: (ms: number) => Promise<void> } = {},
): Promise<Response> {
  const maxAttempts = options.maxAttempts ?? MAX_REQUEST_ATTEMPTS;
  const sleep = options.sleep ?? defaultSleep;
  let response = await doFetch();
  for (let attempt = 1; attempt < maxAttempts && !response.ok && RETRYABLE_STATUSES.has(response.status); attempt += 1) {
    await sleep(retryDelayMs(attempt - 1, response.headers.get('retry-after')));
    response = await doFetch();
  }
  return response;
}

async function parseGoogleResponse<T>(response: Response): Promise<T> {
  if (!response.ok) {
    const body = await response.text();
    throw new Error(`Google API request failed (${response.status}): ${body || response.statusText}`);
  }
  return (await response.json()) as T;
}

async function authorizedFetch(client: JWT, url: string): Promise<Response> {
  return fetchWithGoogleRetry(async () => {
    const headers = await client.getRequestHeaders(url);
    return fetch(url, { headers });
  });
}

function isGoogleApiFileRecord(file: GoogleApiFile): file is GoogleApiFile & {
  id: string;
  name: string;
  mimeType: string;
} {
  return typeof file.id === 'string' && typeof file.name === 'string' && typeof file.mimeType === 'string';
}

function toFileRecord(file: GoogleApiFile & { id: string; name: string; mimeType: string }): GdriveFileRecord {
  return {
    id: file.id,
    name: file.name,
    mimeType: file.mimeType,
    parents: Array.isArray(file.parents) ? file.parents.filter((parent): parent is string => typeof parent === 'string') : [],
    webViewLink: typeof file.webViewLink === 'string' ? file.webViewLink : null,
    modifiedTime: typeof file.modifiedTime === 'string' ? file.modifiedTime : null,
  };
}

function escapeDriveQueryValue(value: string): string {
  return value.replace(/\\/g, '\\\\').replace(/'/g, "\\'");
}

/** Builds the Drive query for the non-trashed direct children of a folder, escaping the folder id. */
export function driveFolderChildrenQuery(folderId: string): string {
  return `'${escapeDriveQueryValue(folderId)}' in parents and trashed = false`;
}

/**
 * Confirms `folderId` resolves to a folder the service account can read, then counts the
 * Google Docs directly inside it. Throws a caller-facing error when the id is missing or not a folder.
 */
export async function verifyGdriveFolderAndCountDocs(
  drive: GoogleDriveClient,
  folderId: string,
): Promise<number> {
  const folder = await drive.getFile(folderId);
  if (!folder) {
    throw new Error(
      `Google Drive folder "${folderId}" is not accessible. Share it with the service account email and verify folder_id.`,
    );
  }
  if (folder.mimeType !== GDRIVE_FOLDER_MIME_TYPE) {
    throw new Error(`Google Drive id "${folderId}" is not a folder (mimeType: ${folder.mimeType}).`);
  }
  const q = driveFolderChildrenQuery(folderId);
  let docs = 0;
  let pageToken: string | undefined;
  do {
    const page = await drive.listFiles({ q, pageToken });
    docs += page.files.filter((file) => file.mimeType === GDRIVE_DOC_MIME_TYPE).length;
    pageToken = page.nextPageToken ?? undefined;
  } while (pageToken);
  return docs;
}

export function createGoogleDocsClients(rawKey: unknown): GoogleDocsClients {
  const key = gdriveServiceAccountKeySchema.parse(rawKey) satisfies GdriveServiceAccountKey;
  const client = new JWT({
    email: key.client_email,
    key: key.private_key,
    scopes: [...GDRIVE_SCOPES],
  });

  return {
    drive: {
      async listFiles(args) {
        const params = new URLSearchParams({
          q: args.q,
          supportsAllDrives: 'true',
          includeItemsFromAllDrives: 'true',
          pageSize: '1000',
          fields: `nextPageToken,files(${GOOGLE_FILE_FIELDS})`,
        });
        if (args.pageToken) {
          params.set('pageToken', args.pageToken);
        }
        const response = await authorizedFetch(client, `${GOOGLE_DRIVE_BASE_URL}/files?${params.toString()}`);
        const parsed = await parseGoogleResponse<GoogleApiListResponse>(response);
        return {
          files: (parsed.files ?? []).filter(isGoogleApiFileRecord).map(toFileRecord),
          nextPageToken: typeof parsed.nextPageToken === 'string' ? parsed.nextPageToken : null,
        };
      },
      async getFile(fileId: string) {
        const params = new URLSearchParams({ supportsAllDrives: 'true', fields: GOOGLE_FILE_FIELDS });
        const response = await authorizedFetch(
          client,
          `${GOOGLE_DRIVE_BASE_URL}/files/${encodeURIComponent(fileId)}?${params.toString()}`,
        );
        if (response.status === 404) {
          return null;
        }
        const file = await parseGoogleResponse<GoogleApiFile>(response);
        return isGoogleApiFileRecord(file) ? toFileRecord(file) : null;
      },
    },
    docs: {
      async getDocument(documentId: string) {
        const params = new URLSearchParams({
          includeTabsContent: 'true',
          suggestionsViewMode: 'PREVIEW_WITHOUT_SUGGESTIONS',
        });
        const response = await authorizedFetch(client, `${GOOGLE_DOCS_BASE_URL}/documents/${documentId}?${params.toString()}`);
        return await parseGoogleResponse<GoogleDocsDocument>(response);
      },
    },
  };
}
