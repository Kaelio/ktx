import { readFile } from 'node:fs/promises';
import { join } from 'node:path';
import type { ChunkResult, DeterministicProjectionContext, DiffSet, FetchContext, ProjectionResult, SourceAdapter } from '../../types.js';
import { chunkSigmaStagedDir } from './chunk.js';
import type { SigmaClientFactory } from './client-port.js';
import { detectSigmaStagedDir } from './detect.js';
import { fetchSigmaBundle, type SigmaFetchLogger } from './fetch.js';
import { projectSigmaDataModels } from './project.js';
import { sigmaManifestSchema, sigmaProjectionConfigSchema, STAGED_FILES } from './types.js';

export interface SigmaSourceAdapterDeps {
  clientFactory: SigmaClientFactory;
  logger?: SigmaFetchLogger;
}

export class SigmaSourceAdapter implements SourceAdapter {
  readonly source = 'sigma';
  readonly skillNames: string[] = ['sigma_ingest'];

  constructor(private readonly deps: SigmaSourceAdapterDeps) {}

  detect(stagedDir: string): Promise<boolean> {
    return detectSigmaStagedDir(stagedDir);
  }

  async fetch(pullConfig: unknown, stagedDir: string, ctx: FetchContext): Promise<void> {
    await fetchSigmaBundle({
      pullConfig,
      stagedDir,
      ctx,
      clientFactory: this.deps.clientFactory,
      ...(this.deps.logger ? { logger: this.deps.logger } : {}),
    });
  }

  chunk(stagedDir: string, diffSet?: DiffSet): Promise<ChunkResult> {
    return chunkSigmaStagedDir(stagedDir, { diffSet });
  }

  async listTargetConnectionIds(stagedDir: string): Promise<string[]> {
    try {
      const body = await readFile(join(stagedDir, STAGED_FILES.projectionConfig), 'utf-8');
      const config = sigmaProjectionConfigSchema.parse(JSON.parse(body));
      const mappedIds = [...new Set(Object.values(config.connectionMappings))].sort();
      if (mappedIds.length > 0) return mappedIds;
    } catch {
      // fall through to manifest fallback
    }
    // No warehouse mappings configured — fall back to the Sigma connection ID from
    // the manifest so the runner still has a target to validate against.
    try {
      const body = await readFile(join(stagedDir, STAGED_FILES.manifest), 'utf-8');
      const manifest = sigmaManifestSchema.parse(JSON.parse(body));
      return [manifest.sigmaConnectionId];
    } catch {
      return [];
    }
  }

  project(ctx: DeterministicProjectionContext): Promise<ProjectionResult> {
    return projectSigmaDataModels(ctx, ctx.semanticLayerService);
  }
}
