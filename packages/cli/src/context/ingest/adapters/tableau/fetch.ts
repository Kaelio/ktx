import { mkdir, readdir, readFile, rm, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import type { FetchContext } from '../../types.js';
import type { TableauClientFactory } from './client-port.js';
import {
  type StagedDatasourceFile,
  type StagedWorkbookFile,
  type TableauManifest,
  type TableauProjectionConfig,
  parseTableauPullConfig,
  stagedDatasourceFileSchema,
  stagedWorkbookFileSchema,
  STAGED_FILES,
} from './types.js';

export interface TableauFetchLogger {
  log(message: string): void;
  warn(message: string): void;
}

const noopLogger: TableauFetchLogger = { log: () => undefined, warn: () => undefined };

export interface FetchTableauBundleParams {
  pullConfig: unknown;
  stagedDir: string;
  ctx: FetchContext;
  clientFactory: TableauClientFactory;
  logger?: TableauFetchLogger;
  /** Injectable clock for deterministic manifest timestamps in tests. */
  now?: () => Date;
}

async function loadExistingStaged<T>(
  stagedDir: string,
  subdir: string,
  parse: (raw: unknown) => T,
  keyOf: (parsed: T) => string,
): Promise<Map<string, T>> {
  const existing = new Map<string, T>();
  let entries: string[];
  try {
    entries = await readdir(join(stagedDir, subdir));
  } catch {
    return existing;
  }
  for (const entry of entries) {
    if (!entry.endsWith('.json')) continue;
    try {
      const body = await readFile(join(stagedDir, subdir, entry), 'utf-8');
      const parsed = parse(JSON.parse(body));
      existing.set(keyOf(parsed), parsed);
    } catch {
      // Skip malformed files.
    }
  }
  return existing;
}

export async function fetchTableauBundle({
  pullConfig,
  stagedDir,
  ctx,
  clientFactory,
  logger = noopLogger,
  now = () => new Date(),
}: FetchTableauBundleParams): Promise<void> {
  const config = parseTableauPullConfig(pullConfig);
  const client = await clientFactory.createClient(config, ctx);

  try {
    await mkdir(join(stagedDir, STAGED_FILES.datasourcesDir), { recursive: true });
    await mkdir(join(stagedDir, STAGED_FILES.workbooksDir), { recursive: true });

    const existingDatasources = await loadExistingStaged(
      stagedDir,
      STAGED_FILES.datasourcesDir,
      (raw) => stagedDatasourceFileSchema.parse(raw),
      (d) => d.luid,
    );
    const existingWorkbooks = await loadExistingStaged(
      stagedDir,
      STAGED_FILES.workbooksDir,
      (raw) => stagedWorkbookFileSchema.parse(raw),
      (w) => w.luid,
    );

    // --- Published data sources (the graph: fields incl. calculated formulas + upstream tables) ---
    logger.log('Listing Tableau published data sources...');
    const datasources = await client.listDatasources(config.datasourceFilter);
    const datasourceLuids = new Set(datasources.map((d) => d.luid));
    logger.log(`Found ${datasources.length} published data source(s).`);

    let datasourcesFetched = 0;
    let datasourcesSkipped = 0;
    for (const ds of datasources) {
      const existing = existingDatasources.get(ds.luid);
      if (existing && ds.updatedAt && existing.updatedAt === ds.updatedAt) {
        datasourcesSkipped++;
        continue;
      }
      const staged: StagedDatasourceFile = {
        luid: ds.luid,
        name: ds.name,
        ...(ds.projectName ? { projectName: ds.projectName } : {}),
        ...(ds.updatedAt ? { updatedAt: ds.updatedAt } : {}),
        hasExtracts: ds.hasExtracts ?? false,
        ...(ds.description ? { description: ds.description } : {}),
        fields: ds.fields.map((f) => ({
          name: f.name,
          ...(f.role ? { role: f.role } : {}),
          ...(f.dataType ? { dataType: f.dataType } : {}),
          ...(f.formula ? { formula: f.formula } : {}),
          ...(f.description ? { description: f.description } : {}),
          isCalculated: f.formula != null && f.formula.length > 0,
        })),
        upstreamTables: ds.upstreamTables.map((t) => ({
          name: t.name,
          ...(t.luid ? { luid: t.luid } : {}),
          ...(t.schema ? { schema: t.schema } : {}),
          ...(t.fullName ? { fullName: t.fullName } : {}),
        })),
      };
      await writeFile(
        join(stagedDir, STAGED_FILES.datasourcesDir, `${ds.luid}.json`),
        JSON.stringify(staged, null, 2),
        'utf-8',
      );
      logger.log(`Staged data source: ${ds.name}`);
      datasourcesFetched++;
    }

    // Evict staged files for data sources that no longer exist — but keep those merely outside
    // the updatedSince window (they are still present in the workspace, just not re-fetched).
    if (!config.datasourceFilter?.updatedSince) {
      for (const [luid] of existingDatasources) {
        if (datasourceLuids.has(luid)) continue;
        await rm(join(stagedDir, STAGED_FILES.datasourcesDir, `${luid}.json`)).catch(() => undefined);
        logger.log(`Removed stale staged data source ${luid}.`);
      }
    }

    // --- Workbooks (summary metadata; the durable signal is the name) ---
    logger.log('Listing Tableau workbooks...');
    const workbooks = await client.listWorkbooks(config.workbookFilter);
    const workbookLuids = new Set(workbooks.map((w) => w.luid));
    logger.log(`Found ${workbooks.length} workbook(s).`);

    let workbooksFetched = 0;
    let workbooksSkipped = 0;
    for (const wb of workbooks) {
      const existing = existingWorkbooks.get(wb.luid);
      if (existing && wb.updatedAt && existing.updatedAt === wb.updatedAt) {
        workbooksSkipped++;
        continue;
      }
      const staged: StagedWorkbookFile = {
        luid: wb.luid,
        name: wb.name,
        ...(wb.projectName ? { projectName: wb.projectName } : {}),
        ...(wb.description ? { description: wb.description } : {}),
        ...(wb.updatedAt ? { updatedAt: wb.updatedAt } : {}),
      };
      await writeFile(
        join(stagedDir, STAGED_FILES.workbooksDir, `${wb.luid}.json`),
        JSON.stringify(staged, null, 2),
        'utf-8',
      );
      logger.log(`Staged workbook: ${wb.name}`);
      workbooksFetched++;
    }

    if (!config.workbookFilter?.updatedSince) {
      for (const [luid] of existingWorkbooks) {
        if (workbookLuids.has(luid)) continue;
        await rm(join(stagedDir, STAGED_FILES.workbooksDir, `${luid}.json`)).catch(() => undefined);
        logger.log(`Removed stale staged workbook ${luid}.`);
      }
    }

    const projectionConfig: TableauProjectionConfig = {
      ...(config.datasourceFilter ? { datasourceFilter: config.datasourceFilter } : {}),
      ...(config.workbookFilter ? { workbookFilter: config.workbookFilter } : {}),
    };
    await writeFile(
      join(stagedDir, STAGED_FILES.projectionConfig),
      JSON.stringify(projectionConfig, null, 2),
      'utf-8',
    );

    const manifest: TableauManifest = {
      tableauConnectionId: config.tableauConnectionId,
      fetchedAt: now().toISOString(),
      datasourceCount: datasources.length,
      workbookCount: workbooks.length,
    };
    await writeFile(join(stagedDir, STAGED_FILES.manifest), JSON.stringify(manifest, null, 2), 'utf-8');
    logger.log(
      `Tableau fetch complete. Data sources: ${datasourcesFetched} fetched, ${datasourcesSkipped} unchanged. ` +
        `Workbooks: ${workbooksFetched} fetched, ${workbooksSkipped} unchanged.`,
    );
  } finally {
    await client.cleanup();
  }
}
