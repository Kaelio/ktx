import { createHash } from 'node:crypto';
import { mkdir, writeFile } from 'node:fs/promises';
import { dirname, extname, join } from 'node:path';
import { SharepointGraphClient } from './graph-client.js';
import { normalizeSharepointFileToMarkdown } from './normalize.js';
import {
  SHAREPOINT_ALLOWED_EXTENSIONS,
  SHAREPOINT_SOURCE_KEY,
  type SharepointManifest,
  type SharepointPullConfig,
} from './types.js';

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

function sharepointDocDirName(title: string, itemId: string): string {
  return `${compactSegment(title)}-${shortHash(itemId)}`;
}

export async function fetchSharepointSnapshot(params: {
  client: SharepointGraphClient;
  config: SharepointPullConfig;
  stagedDir: string;
}): Promise<SharepointManifest> {
  await mkdir(params.stagedDir, { recursive: true });
  const listed = await params.client.listDriveFiles({
    driveId: params.config.driveId,
    folderId: params.config.folderId,
    recursive: params.config.recursive,
  });
  const skipped: Array<{ externalId: string; reason: string }> = [];
  let fileCount = 0;

  for (const { item, drivePath } of listed) {
    const extension = extname(item.name).toLowerCase();
    if (!SHAREPOINT_ALLOWED_EXTENSIONS.has(extension)) {
      skipped.push({ externalId: item.id, reason: `unsupported file extension: ${extension || '(none)'}` });
      continue;
    }
    const title = item.name.replace(/\.[^.]+$/, '').trim() || item.name.trim();
    const content = await params.client.downloadFile(params.config.driveId, item);
    const markdown = normalizeSharepointFileToMarkdown(
      item.name,
      extension === '.md' ? content.toString('utf-8') : content,
      title,
    );
    const relDir = join('docs', ...drivePath.map((segment) => compactSegment(segment)), sharepointDocDirName(title, item.id));
    await writeJson(join(params.stagedDir, relDir, 'metadata.json'), {
      id: item.id,
      title,
      path: [...drivePath, title].join(' / ') || title,
      url: item.webUrl,
      mimeType: extension === '.md' ? 'text/markdown' : 'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
      driveId: params.config.driveId,
      folderId: params.config.folderId,
      drivePath,
      fileName: item.name,
      lastModifiedDateTime: item.lastModifiedDateTime,
    });
    await writeText(join(params.stagedDir, relDir, 'page.md'), markdown);
    fileCount += 1;
  }

  const manifest: SharepointManifest = {
    source: SHAREPOINT_SOURCE_KEY,
    driveId: params.config.driveId,
    folderId: params.config.folderId,
    recursive: params.config.recursive,
    fetchedAt: new Date().toISOString(),
    fileCount,
    skipped,
    warnings:
      skipped.length > 0
        ? [`Skipped ${skipped.length} unsupported SharePoint / OneDrive file(s); only Markdown and Word documents are ingested in v1.`]
        : [],
  };
  await writeJson(join(params.stagedDir, 'manifest.json'), manifest);
  return manifest;
}
