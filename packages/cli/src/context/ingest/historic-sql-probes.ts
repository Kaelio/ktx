import type { KtxProjectConnectionConfig } from '../project/config.js';
import { queryHistoryDialectForConnection } from './adapters/historic-sql/connection-dialect.js';
import type { HistoricSqlDialect } from './adapters/historic-sql/types.js';

export interface HistoricSqlFixAdvice {
  failHeadline: string;
  remediation: string;
}

export interface HistoricSqlSuccessDetail {
  detail: string;
  warnings: string[];
}

export interface HistoricSqlProbeInput {
  projectDir: string;
  connectionId: string;
  connection: KtxProjectConnectionConfig;
  env?: NodeJS.ProcessEnv;
}

export interface HistoricSqlProbeRunner {
  readonly dialect: HistoricSqlDialect;
  readonly catalogName: string;
  run(input: HistoricSqlProbeInput): Promise<unknown>;
  formatSuccessDetail(result: unknown): HistoricSqlSuccessDetail;
  fixAdvice(error: unknown): HistoricSqlFixAdvice;
}

/** @internal */
export interface HistoricSqlProbeRunnerFactoryEntry {
  readonly catalogName: string;
  load(): Promise<HistoricSqlProbeRunner>;
}

export type HistoricSqlProbeOutcome =
  | {
      ok: true;
      dialect: HistoricSqlDialect;
      runner: HistoricSqlProbeRunner;
      result: unknown;
    }
  | {
      ok: false;
      dialect: HistoricSqlDialect;
      runner: HistoricSqlProbeRunner;
      error: unknown;
    };

export type HistoricSqlReadinessProbe = (
  input: HistoricSqlProbeInput,
) => Promise<HistoricSqlProbeOutcome | null>;

export interface HistoricSqlProbeRegistryDeps {
  factories?: Record<HistoricSqlDialect, HistoricSqlProbeRunnerFactoryEntry>;
  cache?: Map<HistoricSqlDialect, HistoricSqlProbeRunner>;
}

const defaultHistoricSqlProbeRunnerFactories: Record<
  HistoricSqlDialect,
  HistoricSqlProbeRunnerFactoryEntry
> = {
  postgres: {
    catalogName: 'pg_stat_statements',
    load: async () => {
      const { PostgresPgssProbeRunner } = await import(
        './historic-sql-probes/postgres-runner.js'
      );
      return new PostgresPgssProbeRunner();
    },
  },
  snowflake: {
    catalogName: 'SNOWFLAKE.ACCOUNT_USAGE.QUERY_HISTORY',
    load: async () => {
      const { SnowflakeAccountUsageProbeRunner } = await import(
        './historic-sql-probes/snowflake-runner.js'
      );
      return new SnowflakeAccountUsageProbeRunner();
    },
  },
  bigquery: {
    catalogName: 'INFORMATION_SCHEMA.JOBS_BY_PROJECT',
    load: async () => {
      const { BigQueryJobsByProjectProbeRunner } = await import(
        './historic-sql-probes/bigquery-runner.js'
      );
      return new BigQueryJobsByProjectProbeRunner();
    },
  },
  hologres: {
    catalogName: 'hologres.hg_query_log',
    load: async () => {
      const { HologresQueryLogProbeRunner } = await import(
        './historic-sql-probes/hologres-runner.js'
      );
      return new HologresQueryLogProbeRunner();
    },
  },
};

const DEFAULT_RUNNER_CACHE = new Map<HistoricSqlDialect, HistoricSqlProbeRunner>();

function registryDeps(input: HistoricSqlProbeRegistryDeps) {
  return {
    factories: input.factories ?? defaultHistoricSqlProbeRunnerFactories,
    cache: input.cache ?? DEFAULT_RUNNER_CACHE,
  };
}

export function historicSqlProbeCatalogName(
  dialect: HistoricSqlDialect,
  deps: HistoricSqlProbeRegistryDeps = {},
): string {
  return registryDeps(deps).factories[dialect].catalogName;
}

async function loadHistoricSqlProbeRunner(
  dialect: HistoricSqlDialect,
  deps: HistoricSqlProbeRegistryDeps = {},
): Promise<HistoricSqlProbeRunner> {
  const { factories, cache } = registryDeps(deps);
  const cached = cache.get(dialect);
  if (cached) {
    return cached;
  }
  const runner = await factories[dialect].load();
  cache.set(dialect, runner);
  return runner;
}

export async function runHistoricSqlReadinessProbe(
  input: HistoricSqlProbeInput,
  deps: HistoricSqlProbeRegistryDeps = {},
): Promise<HistoricSqlProbeOutcome | null> {
  const dialect = queryHistoryDialectForConnection(input.connection);
  if (!dialect) {
    return null;
  }
  const runner = await loadHistoricSqlProbeRunner(dialect, deps);
  try {
    return {
      ok: true,
      dialect,
      runner,
      result: await runner.run(input),
    };
  } catch (error) {
    return { ok: false, dialect, runner, error };
  }
}
