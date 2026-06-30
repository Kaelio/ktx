import { readFile } from 'node:fs/promises';
import { join } from 'node:path';
import type { ChunkResult, DeterministicProjectionContext, DiffSet, FetchContext, ProjectionResult, SourceAdapter } from '../../types.js';
import { chunkSigmaStagedDir } from './chunk.js';
import type { SigmaClientFactory } from './client-port.js';
import { detectSigmaStagedDir } from './detect.js';
import { fetchSigmaBundle, type SigmaFetchLogger } from './fetch.js';
import { projectSigmaDataModels } from './project.js';
import { sigmaProjectionConfigSchema, STAGED_FILES } from './types.js';

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
      return [...new Set(Object.values(config.connectionMappings))].sort();
    } catch {
      return [];
    }
  }

  project(ctx: DeterministicProjectionContext): Promise<ProjectionResult> {
    return projectSigmaDataModels(ctx, ctx.semanticLayerService);
  }
}
