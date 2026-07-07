import type { ChunkResult, DiffSet, FetchContext, ScopeDescriptor, SourceAdapter } from '../../types.js';
import { chunkSharepointStagedDir, describeSharepointScope } from './chunk.js';
import { detectSharepointStagedDir } from './detect.js';
import { fetchSharepointSnapshot } from './fetch.js';
import { createSharepointGraphClient } from './graph-client.js';
import { sharepointPullConfigSchema } from './types.js';

export class SharepointSourceAdapter implements SourceAdapter {
  readonly source = 'sharepoint';
  readonly skillNames = ['sharepoint_synthesize'];
  readonly reconcileSkillNames: string[] = [];
  readonly evidenceIndexing = 'documents' as const;

  detect(stagedDir: string): Promise<boolean> {
    return detectSharepointStagedDir(stagedDir);
  }

  async fetch(pullConfig: unknown, stagedDir: string, _ctx: FetchContext): Promise<void> {
    const config = sharepointPullConfigSchema.parse(pullConfig);
    await fetchSharepointSnapshot({
      client: createSharepointGraphClient(config),
      config,
      stagedDir,
    });
  }

  chunk(stagedDir: string, diffSet?: DiffSet): Promise<ChunkResult> {
    return chunkSharepointStagedDir(stagedDir, diffSet);
  }

  describeScope(stagedDir: string): Promise<ScopeDescriptor> {
    return describeSharepointScope(stagedDir);
  }
}
