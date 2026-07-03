import { KtxQueryError } from '../../errors.js';
import type { KtxProjectConfig, KtxProjectConnectionConfig } from '../project/config.js';
import { deriveFederatedConnection, FEDERATED_CONNECTION_ID } from './federation.js';
import { isSqlQueryableDriver } from './dialects.js';

export type KtxConnectionQueryPolicy = 'read-only-sql' | 'semantic-layer-only';

export function connectionQueryPolicy(
  connection: KtxProjectConnectionConfig | undefined,
): KtxConnectionQueryPolicy {
  return connection !== undefined && connection.query_policy === 'semantic-layer-only'
    ? 'semantic-layer-only'
    : 'read-only-sql';
}

/** Member ids whose policy blocks raw SQL through the federated connection. */
export function restrictedFederatedMemberIds(config: KtxProjectConfig, projectDir: string): string[] {
  const descriptor = deriveFederatedConnection(config.connections, projectDir);
  if (!descriptor) {
    return [];
  }
  return descriptor.members
    .filter((member) => connectionQueryPolicy(member.connection) === 'semantic-layer-only')
    .map((member) => member.connectionId);
}

export function assertRawSqlAllowed(config: KtxProjectConfig, projectDir: string, connectionId: string): void {
  if (connectionId === FEDERATED_CONNECTION_ID) {
    const restricted = restrictedFederatedMemberIds(config, projectDir);
    if (restricted.length > 0) {
      throw new KtxQueryError(
        `Federated SQL execution is disabled: member connection(s) ${restricted
          .map((id) => `"${id}"`)
          .join(', ')} are restricted to semantic-layer queries (query_policy: semantic-layer-only in ktx.yaml).`,
      );
    }
    return;
  }
  if (connectionQueryPolicy(config.connections[connectionId]) === 'semantic-layer-only') {
    throw new KtxQueryError(
      `Connection "${connectionId}" is restricted to semantic-layer queries (query_policy: semantic-layer-only in ktx.yaml); ` +
        'raw SQL execution is disabled. Query it through the semantic layer with predefined measures instead ' +
        '(the sl_query tool or `ktx sl query`).',
    );
  }
}

/**
 * False only when the project has SQL-queryable connections and every one of
 * them is restricted — then no raw-SQL surface can succeed and the
 * sql_execution tool should not be offered at all.
 */
export function projectAllowsRawSql(config: KtxProjectConfig): boolean {
  const sqlConnections = Object.values(config.connections).filter((connection) =>
    isSqlQueryableDriver(connection.driver),
  );
  if (sqlConnections.length === 0) {
    return true;
  }
  return sqlConnections.some((connection) => connectionQueryPolicy(connection) === 'read-only-sql');
}
