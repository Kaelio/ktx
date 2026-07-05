import type { ChunkResult, DiffSet, FetchContext, SourceAdapter } from '../../types.js';
import { chunkTableauStagedDir } from './chunk.js';
import type { TableauClientFactory } from './client-port.js';
import { detectTableauStagedDir } from './detect.js';
import { fetchTableauBundle, type TableauFetchLogger } from './fetch.js';

export interface TableauSourceAdapterDeps {
  clientFactory: TableauClientFactory;
  logger?: TableauFetchLogger;
  now?: () => Date;
}

export class TableauSourceAdapter implements SourceAdapter {
  readonly source = 'tableau';
  readonly skillNames: string[] = ['tableau_ingest'];

  constructor(private readonly deps: TableauSourceAdapterDeps) {}

  detect(stagedDir: string): Promise<boolean> {
    return detectTableauStagedDir(stagedDir);
  }

  async fetch(pullConfig: unknown, stagedDir: string, ctx: FetchContext): Promise<void> {
    await fetchTableauBundle({
      pullConfig,
      stagedDir,
      ctx,
      clientFactory: this.deps.clientFactory,
      ...(this.deps.logger ? { logger: this.deps.logger } : {}),
      ...(this.deps.now ? { now: this.deps.now } : {}),
    });
  }

  chunk(stagedDir: string, diffSet?: DiffSet): Promise<ChunkResult> {
    return chunkTableauStagedDir(stagedDir, { diffSet });
  }
}
