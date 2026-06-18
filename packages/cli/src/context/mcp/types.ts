import type { MemoryIngestService } from '../../context/memory/memory-runs.js';
import type { KtxCliIo } from '../../cli-runtime.js';
import type { KtxEntityDetailsInput, KtxEntityDetailsResponse } from '../scan/entity-details.js';
import type { KtxDiscoverDataInput, KtxDiscoverDataResponse } from '../../context/search/discover.js';
import type { KtxDictionarySearchInput, KtxDictionarySearchResponse } from '../../context/sl/dictionary-search.js';
import type { SemanticLayerQueryInput } from '../../context/sl/types.js';
import type { WikiSearchLaneSummary, WikiSearchMatchReason } from '../../context/wiki/types.js';

interface KtxMcpTextContent {
  type: 'text';
  text: string;
}

export type NonArrayObject = object & { length?: never };

export interface KtxMcpToolResult<T extends NonArrayObject = NonArrayObject> {
  content: KtxMcpTextContent[];
  structuredContent?: T;
  isError?: true;
}

interface KtxMcpProgressEvent {
  progress: number;
  total?: number;
  message: string;
}

export type KtxMcpProgressCallback = (event: KtxMcpProgressEvent) => void | Promise<void>;

export interface KtxMcpToolHandlerContext {
  _meta?: { progressToken?: string | number; [key: string]: unknown };
  sendNotification?: (notification: {
    method: 'notifications/progress';
    params: {
      progressToken: string | number;
      progress: number;
      total?: number;
      message?: string;
    };
  }) => Promise<void>;
}

/** @internal */
export interface MemoryIngestPort {
  ingest: MemoryIngestService['ingest'];
  status: MemoryIngestService['status'];
}

export interface KtxMcpUserContext {
  userId: string;
}

/**
 * Identity of the connected MCP client tool (e.g. Claude Desktop, Cursor),
 * read from the initialize handshake. Untrusted, client-controlled strings —
 * use only as telemetry properties, never to build paths or log lines.
 */
export interface KtxMcpClientInfo {
  name: string;
  version: string;
}

export interface KtxMcpServerLike {
  registerTool(
    name: string,
    config: {
      title?: string;
      description?: string;
      inputSchema: unknown;
      outputSchema?: unknown;
      annotations?: Record<string, unknown>;
    },
    handler: (input: Record<string, unknown>, context?: KtxMcpToolHandlerContext) => Promise<unknown>,
  ): void;
}

interface KtxConnectionSummary {
  id: string;
  name: string;
  connectionType: string;
  members?: string[];
  hint?: string;
}

interface KtxConnectionsMcpPort {
  list(): Promise<KtxConnectionSummary[]>;
}

interface KtxKnowledgeSearchResult {
  key: string;
  path: string;
  scope: 'GLOBAL' | 'USER';
  summary: string;
  score: number;
  matchReasons?: WikiSearchMatchReason[];
  lanes?: WikiSearchLaneSummary[];
}

interface KtxKnowledgeSearchResponse {
  results: KtxKnowledgeSearchResult[];
  totalFound: number;
}

interface KtxKnowledgePage {
  key: string;
  summary: string;
  content: string;
  scope: 'GLOBAL' | 'USER';
  tags?: string[];
  refs?: string[];
  slRefs?: string[];
}

/** @internal */
export interface KtxKnowledgeMcpPort {
  search(input: { userId: string; query: string; limit: number }): Promise<KtxKnowledgeSearchResponse>;
  read(input: { userId: string; key: string }): Promise<KtxKnowledgePage | null>;
}

interface KtxSemanticLayerReadResponse {
  sourceName: string;
  yaml: string;
}

/** @internal */
export interface KtxSemanticLayerQueryResponse {
  connectionId?: string;
  dialect?: string;
  sql: string;
  headers: string[];
  rows: unknown[][];
  totalRows: number;
  plan?: Record<string, unknown>;
}

/** @internal */
export interface KtxSemanticLayerMcpPort {
  readSource(input: { connectionId: string; sourceName: string }): Promise<KtxSemanticLayerReadResponse | null>;
  query(
    input: { connectionId?: string; query: SemanticLayerQueryInput },
    options?: { onProgress?: KtxMcpProgressCallback },
  ): Promise<KtxSemanticLayerQueryResponse>;
}

/** @internal */
export interface KtxEntityDetailsMcpPort {
  read(input: KtxEntityDetailsInput): Promise<KtxEntityDetailsResponse>;
}

/** @internal */
export interface KtxDictionarySearchMcpPort {
  search(input: KtxDictionarySearchInput): Promise<KtxDictionarySearchResponse>;
}

/** @internal */
export interface KtxDiscoverDataMcpPort {
  search(input: KtxDiscoverDataInput): Promise<KtxDiscoverDataResponse>;
}

export interface KtxSqlExecutionResponse {
  headers: string[];
  headerTypes?: string[];
  rows: unknown[][];
  rowCount: number;
}

/** @internal */
export interface KtxSqlExecutionMcpPort {
  execute(
    input: { connectionId: string; sql: string; maxRows: number },
    options?: { onProgress?: KtxMcpProgressCallback },
  ): Promise<KtxSqlExecutionResponse>;
}

export interface KtxMcpContextPorts {
  connections?: KtxConnectionsMcpPort;
  knowledge?: KtxKnowledgeMcpPort;
  semanticLayer?: KtxSemanticLayerMcpPort;
  entityDetails?: KtxEntityDetailsMcpPort;
  dictionarySearch?: KtxDictionarySearchMcpPort;
  discover?: KtxDiscoverDataMcpPort;
  sqlExecution?: KtxSqlExecutionMcpPort;
  memoryIngest?: MemoryIngestPort;
}

export interface KtxMcpServerDeps {
  server: KtxMcpServerLike;
  userContext: KtxMcpUserContext;
  contextTools?: KtxMcpContextPorts;
  projectDir?: string;
  io?: KtxCliIo;
  /** Reads the connected client's identity once the initialize handshake completes. */
  getClientInfo?: () => KtxMcpClientInfo | undefined;
}
