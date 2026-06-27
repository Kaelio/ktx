import { mkdir, readdir, readFile, rm, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import type { FetchContext } from '../../types.js';
import type { SigmaClientFactory } from './client-port.js';
import {
  type SigmaManifest,
  type SigmaProjectionConfig,
  type StagedDataModelFile,
  type StagedWorkbookFile,
  parseSigmaPullConfig,
  stagedDataModelFileSchema,
  stagedWorkbookFileSchema,
  STAGED_FILES,
} from './types.js';

export interface SigmaFetchLogger {
  log(message: string): void;
  warn(message: string): void;
}

const noopLogger: SigmaFetchLogger = { log: () => undefined, warn: () => undefined };

export interface FetchSigmaBundleParams {
  pullConfig: unknown;
  stagedDir: string;
  ctx: FetchContext;
  clientFactory: SigmaClientFactory;
  logger?: SigmaFetchLogger;
}

async function loadExistingStagedFiles(stagedDir: string): Promise<Map<string, StagedDataModelFile>> {
  const existing = new Map<string, StagedDataModelFile>();
  const dmDir = join(stagedDir, STAGED_FILES.dataModelsDir);
  let entries: string[];
  try {
    entries = await readdir(dmDir);
  } catch {
    return existing;
  }
  for (const entry of entries) {
    if (!entry.endsWith('.json')) continue;
    try {
      const body = await readFile(join(dmDir, entry), 'utf-8');
      const parsed = stagedDataModelFileSchema.parse(JSON.parse(body));
      existing.set(parsed.sigmaId, parsed);
    } catch {
      // Skip malformed files.
    }
  }
  return existing;
}

async function loadExistingWorkbookFiles(stagedDir: string): Promise<Map<string, StagedWorkbookFile>> {
  const existing = new Map<string, StagedWorkbookFile>();
  const wbDir = join(stagedDir, STAGED_FILES.workbooksDir);
  let entries: string[];
  try {
    entries = await readdir(wbDir);
  } catch {
    return existing;
  }
  for (const entry of entries) {
    if (!entry.endsWith('.json')) continue;
    try {
      const body = await readFile(join(wbDir, entry), 'utf-8');
      const parsed = stagedWorkbookFileSchema.parse(JSON.parse(body));
      existing.set(parsed.sigmaId, parsed);
    } catch {
      // Skip malformed files.
    }
  }
  return existing;
}

export async function fetchSigmaBundle({
  pullConfig,
  stagedDir,
  ctx,
  clientFactory,
  logger = noopLogger,
}: FetchSigmaBundleParams): Promise<void> {
  const config = parseSigmaPullConfig(pullConfig);
  const client = await clientFactory.createClient(config, ctx);

  try {
    await mkdir(join(stagedDir, STAGED_FILES.dataModelsDir), { recursive: true });
    await mkdir(join(stagedDir, STAGED_FILES.workbooksDir), { recursive: true });

    // Load existing staged files to enable incremental sync.
    const existingByModelId = await loadExistingStagedFiles(stagedDir);
    const existingByWorkbookId = await loadExistingWorkbookFiles(stagedDir);

    logger.log('Listing Sigma data models...');
    const summaries = await client.listDataModels();
    const nonArchivedIds = new Set(summaries.filter((dm) => !dm.isArchived).map((dm) => dm.dataModelId));
    let active = [...nonArchivedIds].map((id) => summaries.find((dm) => dm.dataModelId === id)!);
    if (config.dataModelFilter?.updatedSince) {
      const since = new Date(config.dataModelFilter.updatedSince).getTime();
      active = active.filter((dm) => new Date(dm.updatedAt).getTime() >= since);
    }
    logger.log(`Found ${active.length} active data model(s) (${summaries.length} total).`);

    let fetched = 0;
    let skipped = 0;

    const SPEC_CONCURRENCY = 10;
    const queue = [...active];
    await Promise.all(
      Array.from({ length: Math.min(SPEC_CONCURRENCY, queue.length) }, async () => {
        let summary;
        while ((summary = queue.shift()) !== undefined) {
          const existing = existingByModelId.get(summary.dataModelId);

          if (existing && existing.updatedAt === summary.updatedAt) {
            logger.log(`Unchanged: ${summary.name}`);
            skipped++;
            continue;
          }

          let spec: unknown = null;
          try {
            spec = await client.getDataModelSpec(summary.dataModelId);
          } catch (err) {
            const msg = err instanceof Error ? err.message : String(err);
            if (msg.includes('dataSource subtype not supported')) {
              logger.warn(
                `Skipping spec for "${summary.name}" (${summary.dataModelId}): data source type not supported by Sigma spec export API.`,
              );
            } else {
              logger.warn(`Failed to fetch spec for "${summary.name}" (${summary.dataModelId}): ${msg}`);
            }
          }

          const staged: StagedDataModelFile = {
            sigmaId: summary.dataModelId,
            name: summary.name,
            path: summary.path,
            latestVersion: summary.latestVersion,
            updatedAt: summary.updatedAt,
            isArchived: summary.isArchived ?? false,
            dataModelUrlId: summary.dataModelUrlId,
            spec,
          };

          const filePath = join(stagedDir, STAGED_FILES.dataModelsDir, `${summary.dataModelId}.json`);
          await writeFile(filePath, JSON.stringify(staged, null, 2), 'utf-8');
          logger.log(`Staged data model: ${summary.name}`);
          fetched++;
        }
      }),
    );

    // Remove staged files for models that are archived or deleted — but not those merely outside the filter window.
    for (const [modelId] of existingByModelId) {
      if (nonArchivedIds.has(modelId)) continue;
      try {
        await rm(join(stagedDir, STAGED_FILES.dataModelsDir, `${modelId}.json`));
        logger.log(`Removed stale staged file for model ${modelId}.`);
      } catch {
        // Best-effort removal.
      }
    }

    // Fetch workbooks (summary metadata only — no separate spec endpoint).
    logger.log('Listing Sigma workbooks...');
    const activeWorkbooks = await client.listWorkbooks(config.workbookFilter);
    logger.log(`Found ${activeWorkbooks.length} workbook(s) matching filter.`);

    const seenWorkbookIds = new Set<string>();
    let workbooksFetched = 0;
    let workbooksSkipped = 0;

    for (const wb of activeWorkbooks) {
      seenWorkbookIds.add(wb.workbookId);
      const existing = existingByWorkbookId.get(wb.workbookId);

      if (existing && existing.updatedAt === wb.updatedAt) {
        workbooksSkipped++;
        continue;
      }

      const staged: StagedWorkbookFile = {
        sigmaId: wb.workbookId,
        name: wb.name,
        path: wb.path,
        latestVersion: wb.latestVersion,
        updatedAt: wb.updatedAt,
        isArchived: wb.isArchived ?? false,
        workbookUrlId: wb.workbookUrlId,
        description: wb.description,
      };

      const filePath = join(stagedDir, STAGED_FILES.workbooksDir, `${wb.workbookId}.json`);
      await writeFile(filePath, JSON.stringify(staged, null, 2), 'utf-8');
      logger.log(`Staged workbook: ${wb.name}`);
      workbooksFetched++;
    }

    for (const [workbookId] of existingByWorkbookId) {
      if (seenWorkbookIds.has(workbookId)) continue;
      try {
        await rm(join(stagedDir, STAGED_FILES.workbooksDir, `${workbookId}.json`));
        logger.log(`Removed stale staged file for workbook ${workbookId}.`);
      } catch {
        // Best-effort removal.
      }
    }

    const projectionConfig: SigmaProjectionConfig = {
      connectionMappings: config.connectionMappings ?? {},
      workbookFilter: config.workbookFilter ?? { includeArchived: false, includeExplorations: false },
    };
    await writeFile(
      join(stagedDir, STAGED_FILES.projectionConfig),
      JSON.stringify(projectionConfig, null, 2),
      'utf-8',
    );

    const manifest: SigmaManifest = {
      sigmaConnectionId: config.sigmaConnectionId,
      fetchedAt: new Date().toISOString(),
      dataModelCount: active.length,
      workbookCount: activeWorkbooks.length,
    };
    await writeFile(join(stagedDir, STAGED_FILES.manifest), JSON.stringify(manifest, null, 2), 'utf-8');
    logger.log(
      `Sigma fetch complete. Data models: ${fetched} fetched, ${skipped} unchanged. Workbooks: ${workbooksFetched} fetched, ${workbooksSkipped} unchanged.`,
    );
  } finally {
    await client.cleanup();
  }
}
