import type { ChunkResult, DiffSet, FetchContext, ScopeDescriptor, SourceAdapter } from '../../types.js';
import { chunkGdriveStagedDir, describeGdriveScope } from './chunk.js';
import { detectGdriveStagedDir } from './detect.js';
import { fetchGdriveSnapshot } from './fetch.js';
import { gdrivePullConfigSchema } from './types.js';

export class GdriveSourceAdapter implements SourceAdapter {
  readonly source = 'gdrive';
  readonly skillNames = ['gdrive_synthesize'];
  readonly reconcileSkillNames: string[] = [];
  readonly evidenceIndexing = 'documents' as const;

  detect(stagedDir: string): Promise<boolean> {
    return detectGdriveStagedDir(stagedDir);
  }

  async fetch(pullConfig: unknown, stagedDir: string, _ctx: FetchContext): Promise<void> {
    const config = gdrivePullConfigSchema.parse(pullConfig);
    await fetchGdriveSnapshot({
      key: JSON.parse(config.serviceAccountKey),
      config,
      stagedDir,
    });
  }

  chunk(stagedDir: string, diffSet?: DiffSet): Promise<ChunkResult> {
    return chunkGdriveStagedDir(stagedDir, diffSet);
  }

  describeScope(stagedDir: string): Promise<ScopeDescriptor> {
    return describeGdriveScope(stagedDir);
  }
}
