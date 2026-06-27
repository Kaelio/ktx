import { mkdir, readdir, readFile, rm, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import type { FetchContext } from '../../types.js';
import type { ConfluenceClientFactory } from './client-port.js';
import {
  type ConfluenceManifest,
  type StagedPageFile,
  parseConfluencePullConfig,
  stagedPageFileSchema,
  STAGED_FILES,
} from './types.js';

export interface ConfluenceFetchLogger {
  log(message: string): void;
  warn(message: string): void;
}

const noopLogger: ConfluenceFetchLogger = { log: () => undefined, warn: () => undefined };

export interface FetchConfluenceBundleParams {
  pullConfig: unknown;
  stagedDir: string;
  ctx: FetchContext;
  clientFactory: ConfluenceClientFactory;
  logger?: ConfluenceFetchLogger;
}

async function loadExistingStagedPages(stagedDir: string): Promise<Map<string, StagedPageFile>> {
  const existing = new Map<string, StagedPageFile>();
  const pagesDir = join(stagedDir, STAGED_FILES.pagesDir);
  let entries: string[];
  try {
    entries = await readdir(pagesDir);
  } catch {
    return existing;
  }
  for (const entry of entries) {
    if (!entry.endsWith('.json')) continue;
    try {
      const body = await readFile(join(pagesDir, entry), 'utf-8');
      const parsed = stagedPageFileSchema.parse(JSON.parse(body));
      existing.set(parsed.pageId, parsed);
    } catch {
      // Skip malformed files.
    }
  }
  return existing;
}

function buildBreadcrumb(spaceName: string, title: string): string {
  return `${spaceName} > ${title}`;
}

export async function fetchConfluenceBundle({
  pullConfig,
  stagedDir,
  ctx,
  clientFactory,
  logger = noopLogger,
}: FetchConfluenceBundleParams): Promise<void> {
  const config = parseConfluencePullConfig(pullConfig);
  const client = await clientFactory.createClient(config, ctx);

  try {
    await mkdir(join(stagedDir, STAGED_FILES.pagesDir), { recursive: true });

    const existingByPageId = await loadExistingStagedPages(stagedDir);

    logger.log('Listing Confluence spaces...');
    const spaces = await client.listSpaces(
      config.spaceKeys?.length ? { spaceKeys: config.spaceKeys } : undefined,
    );
    logger.log(`Found ${spaces.length} space(s).`);

    const seenPageIds = new Set<string>();
    let totalFetched = 0;
    let totalSkipped = 0;

    for (const space of spaces) {
      logger.log(`Listing pages in space "${space.name}" (${space.key})...`);
      let summaries;
      try {
        summaries = await client.listPagesInSpace(space.id);
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        logger.warn(`Failed to list pages in space "${space.key}": ${msg}`);
        continue;
      }
      logger.log(`Found ${summaries.length} page(s) in "${space.key}".`);

      for (const summary of summaries) {
        seenPageIds.add(summary.id);
        const existing = existingByPageId.get(summary.id);

        if (existing && existing.lastEditedAt === summary.version.createdAt && existing.version === summary.version.number) {
          totalSkipped++;
          continue;
        }

        let pageWithBody;
        try {
          pageWithBody = await client.getPageWithBody(summary.id);
        } catch (err) {
          const msg = err instanceof Error ? err.message : String(err);
          logger.warn(`Failed to fetch body for page "${summary.title}" (${summary.id}): ${msg}`);
          continue;
        }

        const staged: StagedPageFile = {
          pageId: summary.id,
          spaceId: space.id,
          spaceKey: space.key,
          spaceName: space.name,
          title: summary.title,
          parentId: summary.parentId ?? null,
          breadcrumb: buildBreadcrumb(space.name, summary.title),
          url: `${client.baseUrl}/wiki${summary._links.webui}`,
          lastEditedAt: summary.version.createdAt,
          version: summary.version.number,
          status: summary.status,
          contentStorage: pageWithBody.body.storage.value,
        };

        await writeFile(
          join(stagedDir, STAGED_FILES.pagesDir, `${summary.id}.json`),
          JSON.stringify(staged, null, 2),
          'utf-8',
        );
        totalFetched++;
      }
    }

    // Remove staged files for pages that no longer exist.
    for (const [pageId] of existingByPageId) {
      if (seenPageIds.has(pageId)) continue;
      try {
        await rm(join(stagedDir, STAGED_FILES.pagesDir, `${pageId}.json`));
        logger.log(`Removed stale staged file for page ${pageId}.`);
      } catch {
        // Best-effort removal.
      }
    }

    const manifest: ConfluenceManifest = {
      confluenceConnectionId: config.confluenceConnectionId,
      baseUrl: client.baseUrl,
      fetchedAt: new Date().toISOString(),
      spaceCount: spaces.length,
      pageCount: totalFetched + existingByPageId.size,
      ...(config.spaceKeys?.length ? { spaceKeys: config.spaceKeys } : {}),
    };
    await writeFile(join(stagedDir, STAGED_FILES.manifest), JSON.stringify(manifest, null, 2), 'utf-8');
    logger.log(`Confluence fetch complete. Pages: ${totalFetched} fetched, ${totalSkipped} unchanged.`);
  } finally {
    await client.cleanup();
  }
}
