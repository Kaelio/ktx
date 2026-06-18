import { KtxExpectedError } from '../../errors.js';
import type { KtxProjectConfig, KtxProjectConnectionConfig } from '../project/config.js';

function configuredConnectionIds(config: KtxProjectConfig): string[] {
  return Object.keys(config.connections).sort();
}

function availableConnectionsHint(config: KtxProjectConfig): string {
  const ids = configuredConnectionIds(config);
  return ids.length === 0
    ? 'No connections are configured in ktx.yaml.'
    : `Configured connections: ${ids.join(', ')}.`;
}

/**
 * Look up a connection by id, throwing an expected (caller-driven) error that
 * names the configured connections so an agent or CLI user can self-correct.
 */
export function resolveConfiguredConnection(
  config: KtxProjectConfig,
  connectionId: string,
): KtxProjectConnectionConfig {
  const connection = config.connections[connectionId];
  if (!connection) {
    throw new KtxExpectedError(
      `Connection "${connectionId}" is not configured in ktx.yaml. ${availableConnectionsHint(config)}`,
    );
  }
  return connection;
}

/**
 * Resolve the connection id to run against: validate a requested id against the
 * configured connections, or default to the sole connection when none is given.
 * Throws an expected error that lists the configured connections otherwise.
 */
export function resolveRequiredConnectionId(
  config: KtxProjectConfig,
  requested: string | undefined,
): string {
  if (requested !== undefined) {
    resolveConfiguredConnection(config, requested);
    return requested;
  }
  const ids = configuredConnectionIds(config);
  if (ids.length === 1) {
    return ids[0];
  }
  throw new KtxExpectedError(`connectionId is required. ${availableConnectionsHint(config)}`);
}
