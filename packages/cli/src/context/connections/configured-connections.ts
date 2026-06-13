import type { KtxProjectConnectionConfig } from '../project/config.js';

function listConfiguredConnectionIds(connections: Record<string, KtxProjectConnectionConfig>): string[] {
  return Object.keys(connections).sort();
}

/**
 * Validate a connection id supplied as an explicit command/tool argument against
 * the canonical `ktx.yaml` connections map. Returns the id when configured;
 * otherwise throws an error that lists the configured ids so the caller can fix
 * the typo. Use for explicit arguments only — persisted page frontmatter that
 * references a since-removed connection must warn, not fail.
 */
export function assertConfiguredConnectionId(
  connections: Record<string, KtxProjectConnectionConfig>,
  connectionId: string,
): string {
  if (Object.hasOwn(connections, connectionId)) {
    return connectionId;
  }
  const ids = listConfiguredConnectionIds(connections);
  const configured = ids.length > 0 ? ids.join(', ') : '(none configured)';
  throw new Error(`Unknown connection "${connectionId}". Configured connections: ${configured}.`);
}
