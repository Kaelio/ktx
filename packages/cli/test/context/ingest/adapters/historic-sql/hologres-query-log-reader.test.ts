import { describe, expect, it, vi } from 'vitest';
import { HistoricSqlExtensionMissingError } from '../../../../../src/context/ingest/adapters/historic-sql/errors.js';
import { HologresQueryLogReader } from '../../../../../src/context/ingest/adapters/historic-sql/hologres-query-log-reader.js';
import {
  historicSqlUnifiedPullConfigSchema,
  type AggregatedTemplate,
} from '../../../../../src/context/ingest/adapters/historic-sql/types.js';

interface FakeQueryResult {
  headers: string[];
  rows: unknown[][];
  totalRows?: number;
  error?: string;
}

function queryClient(results: Array<FakeQueryResult | Error>) {
  const executeQuery = vi.fn(async (_sql: string, _params?: unknown[]) => {
    const next = results.shift();
    if (!next) {
      throw new Error('unexpected query');
    }
    if (next instanceof Error) {
      throw next;
    }
    return next;
  });
  return { executeQuery };
}

function executedSql(client: ReturnType<typeof queryClient>, index: number): string {
  const call = client.executeQuery.mock.calls[index];
  if (!call) {
    throw new Error(`expected query client call ${index}`);
  }
  return call[0];
}

const window = { start: new Date('2026-06-15T00:00:00.000Z'), end: new Date('2026-07-15T00:00:00.000Z') };
const config = historicSqlUnifiedPullConfigSchema.parse({ dialect: 'hologres', minExecutions: 5 });

describe('HologresQueryLogReader probe', () => {
  it('passes with no warnings when hg_query_log is accessible and pg_read_all_stats is granted', async () => {
    const client = queryClient([
      { headers: ['?column?'], rows: [[1]] },
      { headers: ['has_role'], rows: [[true]] },
    ]);
    await expect(new HologresQueryLogReader().probe(client)).resolves.toEqual({ warnings: [], info: [] });
    expect(executedSql(client, 0)).toBe('SELECT 1 FROM hologres.hg_query_log LIMIT 1');
    expect(executedSql(client, 1)).toContain("pg_has_role(current_user, 'pg_read_all_stats', 'USAGE')");
  });

  it('soft-warns instead of throwing when pg_read_all_stats is not granted', async () => {
    const client = queryClient([
      { headers: ['?column?'], rows: [[1]] },
      { headers: ['has_role'], rows: [[false]] },
    ]);
    const result = await new HologresQueryLogReader().probe(client);
    expect(result.warnings).toHaveLength(1);
    expect(result.warnings[0]).toContain('pg_read_all_stats');
  });

  it('throws HistoricSqlExtensionMissingError when hg_query_log is not accessible', async () => {
    const client = queryClient([new Error('relation "hologres.hg_query_log" does not exist')]);
    await expect(new HologresQueryLogReader().probe(client)).rejects.toBeInstanceOf(HistoricSqlExtensionMissingError);
  });
});

describe('HologresQueryLogReader fetchAggregated', () => {
  it('aggregates hg_query_log rows by digest into AggregatedTemplate shape', async () => {
    const client = queryClient([
      {
        headers: [
          'template_id',
          'canonical_sql',
          'executions',
          'distinct_users',
          'first_seen',
          'last_seen',
          'p50_ms',
          'p95_ms',
          'error_rate',
          'rows_produced',
          'top_users',
        ],
        rows: [
          [
            'digest-abc',
            'SELECT * FROM orders WHERE id = $1',
            '10',
            '2',
            new Date('2026-07-01T00:00:00.000Z'),
            new Date('2026-07-10T00:00:00.000Z'),
            12.5,
            340,
            0.1,
            '1000',
            '[{"user":"alice","executions":7},{"user":"bob","executions":3}]',
          ],
        ],
      },
    ]);
    const templates: AggregatedTemplate[] = [];
    for await (const template of new HologresQueryLogReader().fetchAggregated(client, window, config)) {
      templates.push(template);
    }
    expect(templates).toHaveLength(1);
    expect(templates[0]).toMatchObject({
      templateId: 'digest-abc',
      canonicalSql: 'SELECT * FROM orders WHERE id = $1',
      dialect: 'hologres',
      stats: {
        executions: 10,
        distinctUsers: 2,
        firstSeen: '2026-07-01T00:00:00.000Z',
        lastSeen: '2026-07-10T00:00:00.000Z',
        p50RuntimeMs: 12.5,
        p95RuntimeMs: 340,
        errorRate: 0.1,
        rowsProduced: 1000,
      },
      topUsers: [
        { user: 'alice', executions: 7 },
        { user: 'bob', executions: 3 },
      ],
    });
  });

  it('filters to fingerprinted queries and binds the window and minExecutions as parameters', async () => {
    const client = queryClient([{ headers: [], rows: [] }]);
    const results: AggregatedTemplate[] = [];
    for await (const template of new HologresQueryLogReader().fetchAggregated(client, window, config)) {
      results.push(template);
    }
    expect(results).toHaveLength(0);
    expect(executedSql(client, 0)).toContain('digest IS NOT NULL');
    expect(executedSql(client, 0)).toContain('FROM hologres.hg_query_log');
    expect(client.executeQuery.mock.calls[0]?.[1]).toEqual([window.start, window.end, 5]);
  });
});
