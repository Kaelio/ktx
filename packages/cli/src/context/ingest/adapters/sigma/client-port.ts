import type { FetchContext } from '../../types.js';
import type { SigmaPullConfig, WorkbookFilterInput } from './types.js';

export interface SigmaTestConnectionResult {
  success: boolean;
  message?: string;
  error?: string;
}

/** Data model summary shape from GET /v2/dataModels list response. */
export interface SigmaDataModelSummary {
  dataModelId: string;
  dataModelUrlId: string;
  name: string;
  path: string;
  latestVersion: number;
  ownerId: string;
  createdAt: string;
  updatedAt: string;
  isArchived?: boolean;
}

/** Workbook summary shape from GET /v2/workbooks list response. */
export interface SigmaWorkbookSummary {
  workbookId: string;
  workbookUrlId: string;
  name: string;
  path: string;
  latestVersion: number;
  ownerId: string;
  createdAt: string;
  updatedAt: string;
  isArchived?: boolean;
  description?: string;
}

/** Re-exported so callers can reference the type without importing from types.ts directly. */
export type { WorkbookFilterInput as ListWorkbooksOptions } from './types.js';

export interface SigmaRuntimeClient {
  testConnection(): Promise<SigmaTestConnectionResult>;
  listDataModels(): Promise<SigmaDataModelSummary[]>;
  listWorkbooks(opts?: WorkbookFilterInput): Promise<SigmaWorkbookSummary[]>;
  /** Returns the raw spec object from GET /v2/dataModels/{id}/spec. */
  getDataModelSpec(dataModelId: string): Promise<unknown>;
  cleanup(): Promise<void>;
}

export interface SigmaClientFactory {
  createClient(config: SigmaPullConfig, ctx: FetchContext): Promise<SigmaRuntimeClient> | SigmaRuntimeClient;
}
