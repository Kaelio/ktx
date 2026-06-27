import type { ChunkResult, DiffSet, FetchContext, SourceAdapter } from '../../types.js';
import { chunkConfluenceStagedDir } from './chunk.js';
import type { ConfluenceClientFactory } from './client-port.js';
import { detectConfluenceStagedDir } from './detect.js';
import { fetchConfluenceBundle, type ConfluenceFetchLogger } from './fetch.js';
import { CONFLUENCE_SOURCE_KEY } from './types.js';

export interface ConfluenceSourceAdapterDeps {
  clientFactory: ConfluenceClientFactory;
  logger?: ConfluenceFetchLogger;
}

export class ConfluenceSourceAdapter implements SourceAdapter {
  readonly source = CONFLUENCE_SOURCE_KEY;
  readonly skillNames: string[] = ['confluence_synthesize'];

  constructor(private readonly deps: ConfluenceSourceAdapterDeps) {}

  detect(stagedDir: string): Promise<boolean> {
    return detectConfluenceStagedDir(stagedDir);
  }

  async fetch(pullConfig: unknown, stagedDir: string, ctx: FetchContext): Promise<void> {
    await fetchConfluenceBundle({
      pullConfig,
      stagedDir,
      ctx,
      clientFactory: this.deps.clientFactory,
      ...(this.deps.logger ? { logger: this.deps.logger } : {}),
    });
  }

  chunk(stagedDir: string, diffSet?: DiffSet): Promise<ChunkResult> {
    return chunkConfluenceStagedDir(stagedDir, { diffSet });
  }
}
