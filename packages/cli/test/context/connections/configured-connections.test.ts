import { describe, expect, it } from 'vitest';
import type { KtxProjectConnectionConfig } from '../../../src/context/project/config.js';
import { assertConfiguredConnectionId } from '../../../src/context/connections/configured-connections.js';

const connections = {
  sales_db: { driver: 'sqlite' } as unknown as KtxProjectConnectionConfig,
  events_db: { driver: 'sqlite' } as unknown as KtxProjectConnectionConfig,
};

describe('assertConfiguredConnectionId', () => {
  it('returns the id when configured', () => {
    expect(assertConfiguredConnectionId(connections, 'sales_db')).toBe('sales_db');
  });

  it('throws listing the configured ids when unknown', () => {
    expect(() => assertConfiguredConnectionId(connections, 'warehouse')).toThrow(
      'Unknown connection "warehouse". Configured connections: events_db, sales_db.',
    );
  });

  it('reports none configured for an empty connections map', () => {
    expect(() => assertConfiguredConnectionId({}, 'warehouse')).toThrow(
      'Unknown connection "warehouse". Configured connections: (none configured).',
    );
  });
});
