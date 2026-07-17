import { z } from 'zod';
import type { SqlAnalysisPort } from '../../../../context/sql-analysis/ports.js';

export const HISTORIC_SQL_SOURCE_KEY = 'historic-sql' as const;

const historicSqlDialectSchema = z.enum(['snowflake', 'bigquery', 'postgres', 'hologres']);
export type HistoricSqlDialect = z.infer<typeof historicSqlDialectSchema>;

const filterModeSchema = z.enum(['exclude', 'include', 'mark-only']);

const ktxTableRefSchema = z.object({
  catalog: z.string().nullable(),
  db: z.string().nullable(),
  name: z.string().min(1),
}).strict();

const ktxTableRefWithColumnsSchema = ktxTableRefSchema.extend({
  columns: z.array(z.string().min(1)).optional(),
}).strict();

const historicSqlCommonPullConfigSchema = z.object({
  minExecutions: z.number().int().nonnegative().default(5),
  enabledTables: z.array(ktxTableRefSchema).default([]),
  enabledSchemas: z.array(z.string().min(1)).default([]),
  modeledTableCatalog: z.array(ktxTableRefWithColumnsSchema).default([]),
  scopeFloorWarnings: z.array(z.string()).default([]),
  filters: z.object({
    serviceAccounts: z.object({
      patterns: z.array(z.string()).default([]),
      mode: filterModeSchema.default('exclude'),
    }).optional(),
    orchestrators: z.object({
      mode: filterModeSchema.default('mark-only'),
    }).optional(),
    dropTrivialProbes: z.boolean().default(true),
    dropFailedBelow: z.object({
      errorRate: z.number().min(0).max(1),
      executions: z.number().int().nonnegative(),
    }).optional(),
  }).default({ dropTrivialProbes: true }),
  redactionPatterns: z.array(z.string()).default([]),
  staleArchiveAfterDays: z.number().int().positive().default(90),
});

const historicSqlWindowedPullConfigSchema = historicSqlCommonPullConfigSchema.extend({
  dialect: z.enum(['snowflake', 'bigquery', 'hologres']),
  windowDays: z.number().int().positive().default(90),
});

const historicSqlPostgresPullConfigSchema = historicSqlCommonPullConfigSchema.extend({
  dialect: z.literal('postgres'),
});

export const historicSqlUnifiedPullConfigSchema = z.discriminatedUnion('dialect', [
  historicSqlWindowedPullConfigSchema,
  historicSqlPostgresPullConfigSchema,
]);

export type HistoricSqlUnifiedPullConfig = z.infer<typeof historicSqlUnifiedPullConfigSchema>;

export const aggregatedTemplateSchema = z.object({
  templateId: z.string().min(1),
  canonicalSql: z.string().min(1),
  dialect: historicSqlDialectSchema,
  stats: z.object({
    executions: z.number().int().nonnegative(),
    distinctUsers: z.number().int().nonnegative(),
    firstSeen: z.iso.datetime(),
    lastSeen: z.iso.datetime(),
    p50RuntimeMs: z.number().nonnegative().nullable(),
    p95RuntimeMs: z.number().nonnegative().nullable(),
    errorRate: z.number().min(0).max(1),
    rowsProduced: z.number().int().nonnegative().nullable(),
  }),
  topUsers: z.array(z.object({
    user: z.string().nullable(),
    executions: z.number().int().nonnegative(),
  })).default([]),
});
export type AggregatedTemplate = z.infer<typeof aggregatedTemplateSchema>;

export const stagedTableInputSchema = z.object({
  table: z.string().min(1),
  tableRef: ktxTableRefSchema,
  stats: z.object({
    executionsBucket: z.string(),
    distinctUsersBucket: z.string(),
    errorRateBucket: z.string(),
    p95RuntimeBucket: z.string(),
    recencyBucket: z.string(),
  }),
  columnsByClause: z.record(z.string(), z.array(z.tuple([z.string(), z.string()]))),
  observedJoins: z.array(z.object({
    withTable: z.string(),
    on: z.array(z.string()),
    freq: z.string(),
  })),
  topTemplates: z.array(z.object({
    id: z.string(),
    canonicalSql: z.string(),
    topUsers: z.array(z.object({ user: z.string().nullable() })),
  })),
});
export type StagedTableInput = z.infer<typeof stagedTableInputSchema>;

export const stagedPatternsInputSchema = z.object({
  templates: z.array(z.object({
    id: z.string(),
    canonicalSql: z.string(),
    tablesTouched: z.array(ktxTableRefSchema),
    executionsBucket: z.string(),
    distinctUsersBucket: z.string(),
    dialect: historicSqlDialectSchema,
  })),
});
export type StagedPatternsInput = z.infer<typeof stagedPatternsInputSchema>;

export const stagedManifestSchema = z.object({
  source: z.literal(HISTORIC_SQL_SOURCE_KEY),
  connectionId: z.string().min(1),
  dialect: historicSqlDialectSchema,
  fetchedAt: z.iso.datetime(),
  windowStart: z.iso.datetime(),
  windowEnd: z.iso.datetime(),
  snapshotRowCount: z.number().int().nonnegative(),
  touchedTableCount: z.number().int().nonnegative(),
  parseFailures: z.number().int().nonnegative(),
  warnings: z.array(z.string()),
  probeWarnings: z.array(z.string()),
  staleArchiveAfterDays: z.number().int().positive().default(90),
});

interface HistoricSqlProbeResult {
  warnings: string[];
  info?: string[];
}

export interface HistoricSqlReader {
  probe(client: unknown): Promise<HistoricSqlProbeResult>;
  fetchAggregated(
    client: unknown,
    window: HistoricSqlTimeWindow,
    config: HistoricSqlUnifiedPullConfig,
  ): AsyncIterable<AggregatedTemplate>;
}

export interface HistoricSqlTimeWindow {
  start: Date;
  end: Date;
}

export interface KtxPostgresQueryClient {
  executeQuery(sql: string, params?: unknown[]): Promise<{ headers: string[]; rows: unknown[][]; totalRows?: number }>;
}

export interface PostgresPgssProbeResult extends HistoricSqlProbeResult {
  pgServerVersion: string;
  warnings: string[];
  info: string[];
}

export interface HistoricSqlSourceAdapterDeps {
  sqlAnalysis: SqlAnalysisPort;
  reader: HistoricSqlReader;
  queryClient: unknown;
  now?: () => Date;
}
