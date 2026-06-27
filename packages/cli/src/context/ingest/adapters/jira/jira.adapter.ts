import type {
  ChunkResult,
  DiffSet,
  FetchContext,
  ScopeDescriptor,
  SourceAdapter,
  WorkUnit,
} from '../../types.js';
import { chunkJiraStagedDir, describeJiraScope } from './chunk.js';
import { detectJiraStagedDir } from './detect.js';
import { fetchJiraSnapshot, type JiraFetchLogger } from './fetch.js';
import { parseJiraPullConfig } from './types.js';

export interface JiraSourceAdapterDeps {
  logger?: JiraFetchLogger;
}

export class JiraSourceAdapter implements SourceAdapter {
  readonly source = 'jira';
  readonly skillNames = ['jira_ingest'];
  readonly reconcileSkillNames: string[] = [];
  readonly evidenceIndexing = undefined;
  readonly triageSupported = false;

  constructor(private readonly deps: JiraSourceAdapterDeps = {}) {}

  detect(stagedDir: string): Promise<boolean> {
    return detectJiraStagedDir(stagedDir);
  }

  async fetch(pullConfig: unknown, stagedDir: string, _ctx: FetchContext): Promise<void> {
    const config = parseJiraPullConfig(pullConfig);
    await fetchJiraSnapshot({ config, stagedDir, ...(this.deps.logger ? { logger: this.deps.logger } : {}) });
  }

  chunk(stagedDir: string, diffSet?: DiffSet): Promise<ChunkResult> {
    return chunkJiraStagedDir(stagedDir, diffSet);
  }

  describeScope(stagedDir: string): Promise<ScopeDescriptor> {
    return describeJiraScope(stagedDir);
  }

  async listTargetConnectionIds(_stagedDir: string): Promise<string[]> {
    return [];
  }

  async clusterWorkUnits(ctx: { workUnits: WorkUnit[] }): Promise<WorkUnit[]> {
    return ctx.workUnits;
  }
}
