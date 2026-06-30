import type { ChunkResult, DiffSet, FetchContext, SourceAdapter, SourceFetchReport } from '../../types.js';
import { chunkLiveDatabaseStagedDir } from './chunk.js';
import { readLiveDatabaseFetchReport } from './fetch-report.js';
import { assertLiveDatabaseScanOutcome } from './scan-outcome.js';
import { detectLiveDatabaseStagedDir, writeLiveDatabaseSnapshot } from './stage.js';
import type { LiveDatabaseSourceAdapterDeps } from './types.js';

export class LiveDatabaseSourceAdapter implements SourceAdapter {
  readonly source = 'live-database';
  readonly skillNames = ['live_database_ingest'];

  constructor(private readonly deps: LiveDatabaseSourceAdapterDeps) {}

  detect(stagedDir: string): Promise<boolean> {
    return detectLiveDatabaseStagedDir(stagedDir);
  }

  readFetchReport(stagedDir: string): Promise<SourceFetchReport | null> {
    return readLiveDatabaseFetchReport(stagedDir);
  }

  async fetch(_pullConfig: unknown, stagedDir: string, ctx: FetchContext): Promise<void> {
    const tableScope = ctx.tableScope;
    const snapshot = await this.deps.introspection.extractSchema(ctx.connectionId, { tableScope });
    const finalized = {
      ...snapshot,
      connectionId: ctx.connectionId,
      extractedAt: snapshot.extractedAt ?? (this.deps.now ?? (() => new Date()))().toISOString(),
    };
    assertLiveDatabaseScanOutcome({ connectionId: ctx.connectionId, scope: tableScope, snapshot: finalized });
    await writeLiveDatabaseSnapshot(stagedDir, finalized);
  }

  chunk(stagedDir: string, diffSet?: DiffSet): Promise<ChunkResult> {
    return chunkLiveDatabaseStagedDir(stagedDir, diffSet);
  }
}
