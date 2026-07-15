import { describe, expect, it, vi } from 'vitest';
import type { HistoricSqlDialect } from '../../../src/context/ingest/adapters/historic-sql/types.js';
import {
  historicSqlProbeCatalogName,
  runHistoricSqlReadinessProbe,
  type HistoricSqlProbeRunner,
  type HistoricSqlProbeRunnerFactoryEntry,
} from '../../../src/context/ingest/historic-sql-probes.js';

function fakeRunner(
  dialect: HistoricSqlDialect,
  catalogName: string,
  options: { result?: unknown; error?: unknown } = {},
): HistoricSqlProbeRunner & { runCalls: () => number } {
  let calls = 0;
  return {
    dialect,
    catalogName,
    async run() {
      calls += 1;
      if (options.error) {
        throw options.error;
      }
      return options.result ?? { warnings: [], info: [] };
    },
    formatSuccessDetail() {
      return { detail: `${catalogName} ready`, warnings: [] };
    },
    fixAdvice(error) {
      return {
        failHeadline: error instanceof Error ? error.message : String(error),
        remediation: 'Fix the test probe.',
      };
    },
    runCalls: () => calls,
  };
}

function factories(
  overrides: Partial<Record<HistoricSqlDialect, HistoricSqlProbeRunner>>,
): Record<HistoricSqlDialect, HistoricSqlProbeRunnerFactoryEntry> {
  const postgres = overrides.postgres ?? fakeRunner('postgres', 'pg_stat_statements');
  const snowflake =
    overrides.snowflake ??
    fakeRunner('snowflake', 'SNOWFLAKE.ACCOUNT_USAGE.QUERY_HISTORY');
  const bigquery =
    overrides.bigquery ?? fakeRunner('bigquery', 'INFORMATION_SCHEMA.JOBS_BY_PROJECT');
  const hologres = overrides.hologres ?? fakeRunner('hologres', 'hologres.hg_query_log');

  return {
    postgres: {
      catalogName: 'pg_stat_statements',
      load: vi.fn(async () => postgres),
    },
    snowflake: {
      catalogName: 'SNOWFLAKE.ACCOUNT_USAGE.QUERY_HISTORY',
      load: vi.fn(async () => snowflake),
    },
    bigquery: {
      catalogName: 'INFORMATION_SCHEMA.JOBS_BY_PROJECT',
      load: vi.fn(async () => bigquery),
    },
    hologres: {
      catalogName: 'hologres.hg_query_log',
      load: vi.fn(async () => hologres),
    },
  };
}

describe('historic-SQL probe registry', () => {
  it('returns null when the connection has no query-history dialect', async () => {
    const deps = { factories: factories({}), cache: new Map() };

    await expect(
      runHistoricSqlReadinessProbe(
        {
          projectDir: '/work/project',
          connectionId: 'mysql',
          connection: {
            driver: 'mysql',
            context: { queryHistory: { enabled: true } },
          },
          env: {},
        },
        deps,
      ),
    ).resolves.toBeNull();

    expect(deps.factories.postgres.load).not.toHaveBeenCalled();
    expect(deps.factories.snowflake.load).not.toHaveBeenCalled();
    expect(deps.factories.bigquery.load).not.toHaveBeenCalled();
  });

  it('dispatches to the dialect runner and caches the runner instance', async () => {
    const runner = fakeRunner('postgres', 'pg_stat_statements', {
      result: { pgServerVersion: 'PostgreSQL 16.4', warnings: [], info: [] },
    });
    const deps = { factories: factories({ postgres: runner }), cache: new Map() };
    const input = {
      projectDir: '/work/project',
      connectionId: 'warehouse',
      connection: {
        driver: 'postgres' as const,
        url: 'env:DATABASE_URL',
        context: { queryHistory: { enabled: true } },
      },
      env: {},
    };

    const first = await runHistoricSqlReadinessProbe(input, deps);
    const second = await runHistoricSqlReadinessProbe(input, deps);

    expect(first).toMatchObject({ ok: true, dialect: 'postgres', runner });
    expect(second).toMatchObject({ ok: true, dialect: 'postgres', runner });
    expect(deps.factories.postgres.load).toHaveBeenCalledTimes(1);
    expect(runner.runCalls()).toBe(2);
  });

  it('normalizes runner errors into a failed outcome', async () => {
    const error = new Error('missing grants');
    const runner = fakeRunner('bigquery', 'INFORMATION_SCHEMA.JOBS_BY_PROJECT', {
      error,
    });
    const deps = { factories: factories({ bigquery: runner }), cache: new Map() };

    await expect(
      runHistoricSqlReadinessProbe(
        {
          projectDir: '/work/project',
          connectionId: 'bq',
          connection: {
            driver: 'bigquery',
            credentials_json: '{"project_id":"project-1"}',
            context: { queryHistory: { enabled: true } },
          },
          env: {},
        },
        deps,
      ),
    ).resolves.toEqual({
      ok: false,
      dialect: 'bigquery',
      runner,
      error,
    });
  });

  it('returns catalog names without loading runner modules', () => {
    const deps = { factories: factories({}), cache: new Map() };

    expect(historicSqlProbeCatalogName('postgres', deps)).toBe('pg_stat_statements');
    expect(historicSqlProbeCatalogName('snowflake', deps)).toBe(
      'SNOWFLAKE.ACCOUNT_USAGE.QUERY_HISTORY',
    );
    expect(historicSqlProbeCatalogName('bigquery', deps)).toBe(
      'INFORMATION_SCHEMA.JOBS_BY_PROJECT',
    );
    expect(deps.factories.postgres.load).not.toHaveBeenCalled();
    expect(deps.factories.snowflake.load).not.toHaveBeenCalled();
    expect(deps.factories.bigquery.load).not.toHaveBeenCalled();
  });
});
