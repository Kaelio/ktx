import type { KtxTableRef } from '../scan/types.js';

export type SqlAnalysisDialect =
  | 'bigquery'
  | 'snowflake'
  | 'postgres'
  | 'redshift'
  | 'mysql'
  | 'sqlite'
  | 'tsql'
  | 'clickhouse'
  | 'trino'
  | (string & {});

export type SqlAnalysisLiteralSlotType = 'string' | 'number' | 'timestamp' | 'date' | 'boolean' | 'null' | 'unknown';

export interface SqlAnalysisLiteralSlot {
  position: number;
  type: SqlAnalysisLiteralSlotType;
  exampleValue: string;
}

export interface SqlAnalysisFingerprintResult {
  fingerprint: string;
  normalizedSql: string;
  tablesTouched: string[];
  literalSlots: SqlAnalysisLiteralSlot[];
  error?: string | null;
}

type SqlAnalysisClause = 'select' | 'where' | 'join' | 'groupBy' | 'having' | 'orderBy' | (string & {});

export interface SqlAnalysisBatchItem {
  id: string;
  sql: string;
}

interface SqlAnalysisCatalogTable extends KtxTableRef {
  columns?: string[];
}

interface SqlAnalysisCatalog {
  tables: SqlAnalysisCatalogTable[];
}

export interface SqlAnalysisBatchOptions {
  catalog?: SqlAnalysisCatalog;
}

export interface SqlAnalysisBatchResult {
  tablesTouched: KtxTableRef[];
  columnsByClause: Partial<Record<SqlAnalysisClause, string[]>>;
  error?: string | null;
}

export interface SqlReadOnlyValidationResult {
  ok: boolean;
  error?: string | null;
}

export interface SqlAnalysisPort {
  analyzeForFingerprint(sql: string, dialect: SqlAnalysisDialect): Promise<SqlAnalysisFingerprintResult>;
  analyzeBatch(
    items: SqlAnalysisBatchItem[],
    dialect: SqlAnalysisDialect,
    options?: SqlAnalysisBatchOptions,
  ): Promise<Map<string, SqlAnalysisBatchResult>>;
  validateReadOnly(sql: string, dialect: SqlAnalysisDialect): Promise<SqlReadOnlyValidationResult>;
}
