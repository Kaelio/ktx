import { createHash } from 'node:crypto';
import { mkdir, writeFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { createGoogleDocsClients, driveFolderChildrenQuery } from './gdrive-client.js';
import { normalizeGoogleDocToMarkdown } from './normalize.js';
import type { GdriveFileRecord, GdriveManifest, GdrivePullConfig } from './types.js';
import { GDRIVE_DOC_MIME_TYPE, GDRIVE_FOLDER_MIME_TYPE, GDRIVE_SOURCE_KEY } from './types.js';

async function writeJson(path: string, value: unknown): Promise<void> {
  await mkdir(dirname(path), { recursive: true });
  await writeFile(path, `${JSON.stringify(value, null, 2)}\n`, 'utf-8');
}

async function writeText(path: string, value: string): Promise<void> {
  await mkdir(dirname(path), { recursive: true });
  await writeFile(path, value.endsWith('\n') ? value : `${value}\n`, 'utf-8');
}

function slugifySegment(value: string): string {
  const normalized = value
    .normalize('NFKD')
    .replace(/[^\x00-\x7F]/g, '')
    .replace(/[^a-zA-Z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .toLowerCase();
  return normalized || 'untitled';
}

function compactSegment(value: string, maxLength = 24): string {
  const slug = slugifySegment(value);
  return slug.length > maxLength ? slug.slice(0, maxLength).replace(/-+$/g, '') || 'untitled' : slug;
}

function shortHash(value: string, length = 10): string {
  return createHash('sha1').update(value).digest('hex').slice(0, length);
}

function gdriveDocDirName(title: string, fileId: string): string {
  return `${compactSegment(title)}-${shortHash(fileId)}`;
}

interface GdriveDocRecord {
  file: GdriveFileRecord;
  drivePath: string[];
  folderId: string;
}

interface GdriveSkippedFile {
  externalId: string;
  reason: string;
}

interface ListFolderResult {
  docs: GdriveDocRecord[];
  skipped: GdriveSkippedFile[];
}

async function listFolderFiles(
  drive: ReturnType<typeof createGoogleDocsClients>['drive'],
  folderId: string,
  recursive: boolean,
  parents: string[] = [],
): Promise<ListFolderResult> {
  const q = driveFolderChildrenQuery(folderId);
  const docs: GdriveDocRecord[] = [];
  const skipped: GdriveSkippedFile[] = [];
  let pageToken: string | undefined;
  do {
    const page = await drive.listFiles({ q, pageToken });
    for (const file of page.files) {
      if (file.mimeType === GDRIVE_FOLDER_MIME_TYPE) {
        if (recursive) {
          const nested = await listFolderFiles(drive, file.id, true, [...parents, file.name]);
          docs.push(...nested.docs);
          skipped.push(...nested.skipped);
        }
        continue;
      }
      if (file.mimeType !== GDRIVE_DOC_MIME_TYPE) {
        skipped.push({ externalId: file.id, reason: `unsupported mime type: ${file.mimeType}` });
        continue;
      }
      docs.push({ file, drivePath: parents, folderId });
    }
    pageToken = page.nextPageToken ?? undefined;
  } while (pageToken);
  return { docs, skipped };
}

export async function fetchGdriveSnapshot(params: {
  key: unknown;
  config: GdrivePullConfig;
  stagedDir: string;
}): Promise<GdriveManifest> {
  await mkdir(params.stagedDir, { recursive: true });
  const clients = createGoogleDocsClients(params.key);
  const { docs, skipped } = await listFolderFiles(clients.drive, params.config.folderId, params.config.recursive);

  for (const { file, drivePath, folderId } of docs) {
    const document = await clients.docs.getDocument(file.id);
    const title = (document.title?.trim() || file.name).trim();
    const relDir = join('docs', ...drivePath.map((segment) => compactSegment(segment)), gdriveDocDirName(title, file.id));
    const markdownBody = normalizeGoogleDocToMarkdown(document);
    const pageMarkdown = [`# ${title}`, markdownBody].filter(Boolean).join('\n\n');
    await writeJson(join(params.stagedDir, relDir, 'metadata.json'), {
      id: file.id,
      title,
      path: [...drivePath, title].join(' / ') || title,
      url: file.webViewLink,
      mimeType: file.mimeType,
      folderId,
      drivePath,
      modifiedTime: file.modifiedTime,
    });
    await writeText(join(params.stagedDir, relDir, 'page.md'), pageMarkdown);
  }

  const manifest: GdriveManifest = {
    source: GDRIVE_SOURCE_KEY,
    folderId: params.config.folderId,
    recursive: params.config.recursive,
    fetchedAt: new Date().toISOString(),
    fileCount: docs.length,
    skipped,
    warnings:
      skipped.length > 0
        ? [`Skipped ${skipped.length} non-Google-Doc file(s); only Google Docs are ingested in v1.`]
        : [],
  };
  await writeJson(join(params.stagedDir, 'manifest.json'), manifest);
  return manifest;
}
