import type { FetchContext } from '../../types.js';
import type { DatasourceFilterInput, TableauPullConfig, WorkbookFilterInput } from './types.js';

export interface TableauTestConnectionResult {
  success: boolean;
  message?: string;
  error?: string;
}

/** A field record as returned by the Metadata API for a published data source. */
export interface TableauFieldRecord {
  name: string;
  role?: string;
  dataType?: string;
  /** Present for a CalculatedField; absent for a plain ColumnField. */
  formula?: string;
  description?: string;
}

/** An upstream (physical) table record from the Metadata API lineage. */
export interface TableauUpstreamTableRecord {
  luid?: string;
  name: string;
  schema?: string;
  fullName?: string;
}

/** A published data source with its fields and upstream tables, from the Metadata API. */
export interface TableauDatasourceRecord {
  luid: string;
  name: string;
  projectName?: string;
  updatedAt?: string;
  hasExtracts?: boolean;
  description?: string;
  fields: TableauFieldRecord[];
  upstreamTables: TableauUpstreamTableRecord[];
}

/** Workbook summary metadata from the Metadata API. */
export interface TableauWorkbookRecord {
  luid: string;
  name: string;
  projectName?: string;
  description?: string;
  updatedAt?: string;
}

/** Re-exported so callers can reference the option types without importing from types.ts directly. */
export type { DatasourceFilterInput as ListDatasourcesOptions } from './types.js';
export type { WorkbookFilterInput as ListWorkbooksOptions } from './types.js';

export interface TableauRuntimeClient {
  testConnection(): Promise<TableauTestConnectionResult>;
  listDatasources(opts?: DatasourceFilterInput): Promise<TableauDatasourceRecord[]>;
  listWorkbooks(opts?: WorkbookFilterInput): Promise<TableauWorkbookRecord[]>;
  cleanup(): Promise<void>;
}

export interface TableauClientFactory {
  createClient(config: TableauPullConfig, ctx: FetchContext): Promise<TableauRuntimeClient> | TableauRuntimeClient;
}
