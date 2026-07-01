import { createHash } from 'node:crypto';

type ContentCacheMetadata = Record<string, unknown>;

export interface ContentResultCacheLookup {
  namespace: string;
  scopeKey: string;
  inputHash: string;
}

export interface ContentResultCacheCompleted<TOutput = unknown> extends ContentResultCacheLookup {
  runId: string;
  status: 'completed';
  output: TOutput;
  errorMessage: null;
  metadata: ContentCacheMetadata;
  updatedAt: string;
}

export interface ContentResultCacheFailed extends ContentResultCacheLookup {
  runId: string;
  status: 'failed';
  output: null;
  errorMessage: string;
  metadata: ContentCacheMetadata;
  updatedAt: string;
}

export type ContentResultCacheRecord<TOutput = unknown> =
  | ContentResultCacheCompleted<TOutput>
  | ContentResultCacheFailed;

export interface ContentResultCache {
  findCompletedResult<TOutput = unknown>(
    input: ContentResultCacheLookup,
  ): Promise<ContentResultCacheCompleted<TOutput> | null>;
  findLatestCompletedResult(input: {
    namespace: string;
    scopeKey: string;
  }): Promise<ContentResultCacheCompleted | null>;
  saveCompletedResult<TOutput = unknown>(
    input: Omit<ContentResultCacheCompleted<TOutput>, 'status' | 'errorMessage'>,
  ): Promise<void>;
  saveFailedResult(input: Omit<ContentResultCacheFailed, 'status' | 'output'>): Promise<void>;
  deleteResult(input: ContentResultCacheLookup): Promise<void>;
  listRunResults(runId: string): Promise<ContentResultCacheRecord[]>;
}

function stableJson(value: unknown): string {
  if (Array.isArray(value)) {
    return `[${value.map(stableJson).join(',')}]`;
  }
  if (value && typeof value === 'object') {
    const entries = Object.entries(value as Record<string, unknown>).sort(([left], [right]) =>
      left.localeCompare(right),
    );
    return `{${entries.map(([key, item]) => `${JSON.stringify(key)}:${stableJson(item)}`).join(',')}}`;
  }
  return JSON.stringify(value) ?? 'undefined';
}

export function stableContentHash(value: unknown): string {
  return createHash('sha256').update(stableJson(value)).digest('hex');
}
