import type { FetchContext } from '../../types.js';
import type { ConfluencePullConfig } from './types.js';

export interface ConfluenceSpaceSummary {
  id: string;
  key: string;
  name: string;
  type: string;
  status: string;
}

export interface ConfluencePageSummary {
  id: string;
  title: string;
  spaceId: string;
  parentId: string | null;
  status: string;
  version: { number: number; createdAt: string };
  _links: { webui: string };
}

export interface ConfluencePageBody {
  id: string;
  title: string;
  spaceId: string;
  parentId: string | null;
  status: string;
  version: { number: number; createdAt: string };
  body: { storage: { value: string } };
  _links: { webui: string };
}

export interface ConfluenceRuntimeClient {
  readonly baseUrl: string;
  listSpaces(opts?: { spaceKeys?: string[] }): Promise<ConfluenceSpaceSummary[]>;
  listPagesInSpace(spaceId: string, opts?: { limit?: number }): Promise<ConfluencePageSummary[]>;
  getPageWithBody(pageId: string): Promise<ConfluencePageBody>;
  testConnection(): Promise<{ success: boolean; message?: string; error?: string }>;
  cleanup(): Promise<void>;
}

export interface ConfluenceClientFactory {
  createClient(
    config: ConfluencePullConfig,
    ctx: FetchContext,
  ): Promise<ConfluenceRuntimeClient> | ConfluenceRuntimeClient;
}
