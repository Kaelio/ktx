import { getDriverRegistration } from '../../../connections/drivers.js';
import type { KtxConnectionDriver } from '../../../scan/types.js';
import type { HistoricSqlDialect } from './types.js';

const historicSqlDialects: readonly HistoricSqlDialect[] = ['postgres', 'bigquery', 'snowflake', 'hologres'];

function recordOrNull(value: unknown): Record<string, unknown> | null {
  return value && typeof value === 'object' && !Array.isArray(value) ? (value as Record<string, unknown>) : null;
}

function queryHistoryRecord(connection: unknown): Record<string, unknown> | null {
  const conn = recordOrNull(connection);
  const context = conn ? recordOrNull(conn.context) : null;
  return context ? recordOrNull(context.queryHistory) : null;
}

function historicSqlDialectForDriver(driver: KtxConnectionDriver): HistoricSqlDialect {
  const dialect = historicSqlDialects.find((candidate) => candidate === driver);
  if (!dialect) {
    throw new Error(`Driver "${driver}" is marked as historic-SQL capable but has no HistoricSqlDialect mapping.`);
  }
  return dialect;
}

export function isQueryHistoryEnabled(connection: unknown): boolean {
  return queryHistoryRecord(connection)?.enabled === true;
}

/**
 * Resolves the query-history dialect from the connection's driver capability
 * alone, ignoring whether query history is enabled in ktx.yaml. Use this on the
 * adapter-registration path when query history has been explicitly requested
 * for the run (e.g. via `--query-history`, which is itself the opt-in): the
 * persisted `context.queryHistory.enabled` flag must not gate registration.
 * Returns null when the connection's driver has no query-history reader.
 */
export function historicSqlDialectForConnectionDriver(connection: unknown): HistoricSqlDialect | null {
  const conn = recordOrNull(connection);
  const driver = String(conn?.driver ?? '').toLowerCase();
  const registration = getDriverRegistration(driver);
  return registration?.hasHistoricSqlReader ? historicSqlDialectForDriver(registration.driver) : null;
}

/**
 * Resolves the query-history dialect for a connection. Returns null when
 * query history is disabled, or when the connection's driver has no
 * query-history reader.
 */
export function queryHistoryDialectForConnection(connection: unknown): HistoricSqlDialect | null {
  if (!isQueryHistoryEnabled(connection)) {
    return null;
  }
  return historicSqlDialectForConnectionDriver(connection);
}
