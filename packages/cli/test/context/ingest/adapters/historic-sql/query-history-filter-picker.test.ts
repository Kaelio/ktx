import { describe, expect, it, vi } from 'vitest';
import type { KtxLlmRuntimePort } from '../../../../../src/context/llm/runtime-port.js';
import type {
  SqlAnalysisBatchItem,
  SqlAnalysisBatchResult,
  SqlAnalysisPort,
} from '../../../../../src/context/sql-analysis/ports.js';
import {
  proposeQueryHistoryServiceAccountFilters,
  regexEscapeForExactRolePattern,
} from '../../../../../src/context/ingest/adapters/historic-sql/query-history-filter-picker.js';
import type {
  AggregatedTemplate,
  HistoricSqlReader,
} from '../../../../../src/context/ingest/adapters/historic-sql/types.js';

function aggregate(overrides: Partial<AggregatedTemplate> & { templateId: string; canonicalSql: string }): AggregatedTemplate {
  return {
    templateId: overrides.templateId,
    canonicalSql: overrides.canonicalSql,
    dialect: overrides.dialect ?? 'postgres',
    stats: overrides.stats ?? {
      executions: 25,
      distinctUsers: 1,
      firstSeen: '2026-05-01T00:00:00.000Z',
      lastSeen: '2026-06-01T00:00:00.000Z',
      p50RuntimeMs: 50,
      p95RuntimeMs: 100,
      errorRate: 0,
      rowsProduced: 10,
    },
    topUsers: overrides.topUsers ?? [{ user: 'analyst', executions: 25 }],
  };
}

function reader(...templates: AggregatedTemplate[]): HistoricSqlReader {
  return {
    async probe() {
      return { warnings: [], info: [] };
    },
    async *fetchAggregated() {
      for (const template of templates) {
        yield template;
      }
    },
  };
}

function sqlAnalysis(tablesById: Record<string, Array<{ catalog: string | null; db: string | null; name: string }>>): SqlAnalysisPort {
  return {
    analyzeForFingerprint: vi.fn(),
    analyzeBatch: vi.fn(async (items: SqlAnalysisBatchItem[]): Promise<Map<string, SqlAnalysisBatchResult>> =>
      new Map<string, SqlAnalysisBatchResult>(
        items.map((item) => [
          item.id,
          {
            tablesTouched: tablesById[item.id] ?? [],
            columnsByClause: {},
          },
        ]),
      ),
    ),
    validateReadOnly: vi.fn(async () => ({ ok: true })),
  };
}

function sqlAnalysisWithErrors(
  tablesById: Record<string, Array<{ catalog: string | null; db: string | null; name: string }>>,
  errorIds: string[],
): SqlAnalysisPort {
  const errors = new Set(errorIds);
  return {
    analyzeForFingerprint: vi.fn(),
    analyzeBatch: vi.fn(async (items: SqlAnalysisBatchItem[]): Promise<Map<string, SqlAnalysisBatchResult>> =>
      new Map<string, SqlAnalysisBatchResult>(
        items.map((item) => [
          item.id,
          errors.has(item.id)
            ? { tablesTouched: [], columnsByClause: {}, error: 'parse boom' }
            : { tablesTouched: tablesById[item.id] ?? [], columnsByClause: {} },
        ]),
      ),
    ),
    validateReadOnly: vi.fn(async () => ({ ok: true })),
  };
}

function llm(decisions: Array<{ role: string; exclude: boolean; reason: string }>): KtxLlmRuntimePort {
  const generateObject = vi.fn(async () => ({ roles: decisions })) as KtxLlmRuntimePort['generateObject'];
  return {
    generateText: vi.fn(),
    generateObject,
    runAgentLoop: vi.fn(),
    subprocessForkSpec: () => null,
  };
}

describe('query-history filter picker', () => {
  it('emits anchored escaped patterns for excluded roles from one batched LLM call', async () => {
    const runtime = llm([
      { role: 'svc.loader+prod', exclude: true, reason: 'Runs recurring loader traffic only.' },
      { role: 'analyst', exclude: false, reason: 'Interactive analytic usage.' },
    ]);
    const analysis = sqlAnalysis({
      loader: [{ catalog: null, db: 'analytics', name: 'orders' }],
      analyst: [{ catalog: null, db: 'analytics', name: 'orders' }],
    });

    const proposal = await proposeQueryHistoryServiceAccountFilters({
      connectionId: 'warehouse',
      dialect: 'postgres',
      queryClient: {},
      reader: reader(
        aggregate({
          templateId: 'loader',
          canonicalSql: 'merge into analytics.orders using staging.orders_delta on orders.id = orders_delta.id',
          topUsers: [{ user: 'svc.loader+prod', executions: 40 }],
        }),
        aggregate({
          templateId: 'analyst',
          canonicalSql: 'select status, count(*) from analytics.orders group by status',
          topUsers: [{ user: 'analyst', executions: 25 }],
        }),
      ),
      sqlAnalysis: analysis,
      llmRuntime: runtime,
      pullConfig: {
        dialect: 'postgres',
        enabledSchemas: ['analytics'],
        enabledTables: [],
        modeledTableCatalog: [{ catalog: null, db: 'analytics', name: 'orders' }],
        filters: { dropTrivialProbes: true },
      },
      now: new Date('2026-06-03T00:00:00.000Z'),
    });

    expect(runtime.generateObject).toHaveBeenCalledTimes(1);
    expect(proposal).toMatchObject({
      excludedRoles: [
        {
          role: 'svc.loader+prod',
          pattern: '^svc\\.loader\\+prod$',
          reason: 'Runs recurring loader traffic only.',
        },
      ],
      consideredRoleCount: 2,
      skipped: null,
      warnings: [],
    });
  });

  it('redacts representative SQL before sending role records to the LLM', async () => {
    const originalSql =
      "select * from public.api_events where api_key = 'sk_live_abc123' and note = 'Secret_Token_9f'"; // pragma: allowlist secret
    const runtime = llm([
      { role: 'svc_loader', exclude: false, reason: 'Keep by default.' },
      { role: 'analyst', exclude: false, reason: 'Interactive analytic usage.' },
    ]);
    const analysis = sqlAnalysis({
      secret: [{ catalog: null, db: 'public', name: 'api_events' }],
      analyst: [{ catalog: null, db: 'public', name: 'orders' }],
    });

    await proposeQueryHistoryServiceAccountFilters({
      connectionId: 'warehouse',
      dialect: 'postgres',
      queryClient: {},
      reader: reader(
        aggregate({
          templateId: 'secret',
          canonicalSql: originalSql,
          topUsers: [{ user: 'svc_loader', executions: 30 }],
        }),
        aggregate({
          templateId: 'analyst',
          canonicalSql: 'select status, count(*) from public.orders group by status',
          topUsers: [{ user: 'analyst', executions: 25 }],
        }),
      ),
      sqlAnalysis: analysis,
      llmRuntime: runtime,
      pullConfig: {
        dialect: 'postgres',
        enabledSchemas: ['public'],
        enabledTables: [],
        modeledTableCatalog: [],
        redactionPatterns: ['sk_live_[A-Za-z0-9]+', '(?i)secret_token_[a-z0-9]+'],
        filters: { dropTrivialProbes: true },
      },
      now: new Date('2026-06-03T00:00:00.000Z'),
    });

    expect(analysis.analyzeBatch).toHaveBeenCalledWith(
      [
        { id: 'secret', sql: originalSql },
        { id: 'analyst', sql: 'select status, count(*) from public.orders group by status' },
      ],
      'postgres',
      undefined,
    );
    const call = vi.mocked(runtime.generateObject).mock.calls[0]?.[0];
    expect(call?.prompt).toContain('[REDACTED]');
    expect(call?.prompt).not.toContain('sk_live_abc123');
    expect(call?.prompt).not.toContain('Secret_Token_9f');
  });

  it('fails open with no LLM runtime', async () => {
    const proposal = await proposeQueryHistoryServiceAccountFilters({
      connectionId: 'warehouse',
      dialect: 'postgres',
      queryClient: {},
      reader: reader(),
      sqlAnalysis: sqlAnalysis({}),
      llmRuntime: null,
      pullConfig: { dialect: 'postgres', filters: { dropTrivialProbes: true } },
    });

    expect(proposal).toEqual({
      excludedRoles: [],
      consideredRoleCount: 0,
      skipped: { reason: 'no-llm' },
      warnings: [],
      parseFailedTemplateIds: [],
    });
  });

  it('proposes nothing for a single-role stack', async () => {
    const runtime = llm([{ role: 'warehouse_user', exclude: true, reason: 'Only observed role.' }]);

    const proposal = await proposeQueryHistoryServiceAccountFilters({
      connectionId: 'warehouse',
      dialect: 'postgres',
      queryClient: {},
      reader: reader(
        aggregate({
          templateId: 'single-role',
          canonicalSql: 'select * from analytics.orders',
          topUsers: [{ user: 'warehouse_user', executions: 40 }],
        }),
      ),
      sqlAnalysis: sqlAnalysis({
        'single-role': [{ catalog: null, db: 'analytics', name: 'orders' }],
      }),
      llmRuntime: runtime,
      pullConfig: { dialect: 'postgres', enabledSchemas: ['analytics'], filters: { dropTrivialProbes: true } },
    });

    expect(runtime.generateObject).not.toHaveBeenCalled();
    expect(proposal.excludedRoles).toEqual([]);
    expect(proposal.skipped).toEqual({ reason: 'no-in-scope-history' });
  });

  it('records parse failures as template ids, not warnings', async () => {
    const proposal = await proposeQueryHistoryServiceAccountFilters({
      connectionId: 'warehouse',
      dialect: 'postgres',
      queryClient: {},
      reader: reader(
        aggregate({
          templateId: 'good',
          canonicalSql: 'select * from analytics.orders',
          topUsers: [{ user: 'analyst', executions: 30 }],
        }),
        aggregate({
          templateId: 'broken',
          canonicalSql: 'select * from where',
          topUsers: [{ user: 'analyst', executions: 5 }],
        }),
      ),
      sqlAnalysis: sqlAnalysisWithErrors({ good: [{ catalog: null, db: 'analytics', name: 'orders' }] }, ['broken']),
      llmRuntime: llm([]),
      pullConfig: { dialect: 'postgres', enabledSchemas: ['analytics'], filters: { dropTrivialProbes: true } },
    });

    expect(proposal.parseFailedTemplateIds).toEqual(['broken']);
    expect(proposal.warnings).toEqual([]);
  });

  it('keeps clean in-scope history when the model excludes nothing', async () => {
    const proposal = await proposeQueryHistoryServiceAccountFilters({
      connectionId: 'warehouse',
      dialect: 'bigquery',
      queryClient: {},
      reader: reader(
        aggregate({
          templateId: 'dashboard',
          canonicalSql: 'select status, count(*) from `demo.analytics.orders` group by status',
          dialect: 'bigquery',
          topUsers: [{ user: 'bi_runner', executions: 1 }],
        }),
        aggregate({
          templateId: 'analyst',
          canonicalSql: 'select * from `demo.analytics.orders` where id = @id',
          dialect: 'bigquery',
          topUsers: [{ user: 'analyst', executions: 1 }],
        }),
      ),
      sqlAnalysis: sqlAnalysis({
        dashboard: [{ catalog: 'demo', db: 'analytics', name: 'orders' }],
        analyst: [{ catalog: 'demo', db: 'analytics', name: 'orders' }],
      }),
      llmRuntime: llm([
        { role: 'bi_runner', exclude: false, reason: 'Dashboard usage is analytic.' },
        { role: 'analyst', exclude: false, reason: 'Interactive analyst usage.' },
      ]),
      pullConfig: {
        dialect: 'bigquery',
        windowDays: 90,
        enabledSchemas: ['analytics'],
        filters: { dropTrivialProbes: true },
      },
    });

    expect(proposal.excludedRoles).toEqual([]);
    expect(proposal.consideredRoleCount).toBe(2);
    expect(proposal.skipped).toBeNull();
  });

  it('escapes regex metacharacters for exact role matches', () => {
    expect(regexEscapeForExactRolePattern('svc.loader+prod')).toBe('^svc\\.loader\\+prod$');
    expect(regexEscapeForExactRolePattern('team[etl](west)')).toBe('^team\\[etl\\]\\(west\\)$');
  });
});
