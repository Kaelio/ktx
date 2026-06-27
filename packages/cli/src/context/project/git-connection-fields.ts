import type { KtxProjectConnectionConfig } from './config.js';

export interface GitRepoConnectionFields {
  repoUrl: string | null;
  sourceDir: string | null;
  branch: string | null;
  path: string | null;
  authTokenLiteral: string | null;
  authTokenRef: string | null;
}

function trimmedString(value: unknown): string | null {
  return typeof value === 'string' && value.trim().length > 0 ? value.trim() : null;
}

// metricflow nests its repo fields under `metricflow.*`; dbt/lookml keep them top-level.
function fieldRecord(connection: KtxProjectConnectionConfig, driver: string): Record<string, unknown> {
  if (driver === 'metricflow') {
    const nested = (connection as Record<string, unknown>).metricflow;
    if (typeof nested === 'object' && nested !== null && !Array.isArray(nested)) {
      return nested as Record<string, unknown>;
    }
    return {};
  }
  return connection as Record<string, unknown>;
}

/**
 * Single source of truth for where the git-repo context-source drivers
 * (dbt, metricflow, lookml) store their repository fields: dbt uses snake_case
 * `repo_url`/`source_dir`, lookml uses camelCase `repoUrl`, metricflow nests
 * camelCase fields under `metricflow.*`.
 */
export function readGitRepoConnectionFields(
  connection: KtxProjectConnectionConfig,
  driver: string,
): GitRepoConnectionFields {
  const record = fieldRecord(connection, driver);
  return {
    repoUrl: trimmedString(driver === 'dbt' ? record.repo_url : record.repoUrl),
    sourceDir: driver === 'dbt' ? trimmedString(record.source_dir) : null,
    branch: trimmedString(record.branch),
    path: trimmedString(record.path),
    authTokenLiteral: trimmedString(record.auth_token),
    authTokenRef: trimmedString(record.auth_token_ref),
  };
}
