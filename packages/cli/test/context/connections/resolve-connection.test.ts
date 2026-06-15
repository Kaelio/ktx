import { describe, expect, it } from 'vitest';
import {
  buildDefaultKtxProjectConfig,
  type KtxProjectConfig,
} from '../../../src/context/project/config.js';
import {
  resolveConfiguredConnection,
  resolveRequiredConnectionId,
} from '../../../src/context/connections/resolve-connection.js';
import { KtxExpectedError } from '../../../src/errors.js';

function configWith(ids: string[]): KtxProjectConfig {
  const config = buildDefaultKtxProjectConfig();
  for (const id of ids) {
    config.connections[id] = { driver: 'postgres' };
  }
  return config;
}

describe('resolveConfiguredConnection', () => {
  it('returns the connection config when the id is configured', () => {
    const config = configWith(['warehouse']);
    expect(resolveConfiguredConnection(config, 'warehouse')).toEqual({ driver: 'postgres' });
  });

  it('throws an expected error that lists the configured connections', () => {
    const config = configWith(['analytics', 'warehouse']);
    let error: unknown;
    try {
      resolveConfiguredConnection(config, 'ARK');
    } catch (caught) {
      error = caught;
    }
    expect(error).toBeInstanceOf(KtxExpectedError);
    expect((error as Error).message).toBe(
      'Connection "ARK" is not configured in ktx.yaml. Configured connections: analytics, warehouse.',
    );
  });

  it('reports when no connections are configured at all', () => {
    const config = configWith([]);
    expect(() => resolveConfiguredConnection(config, 'warehouse')).toThrow(
      'Connection "warehouse" is not configured in ktx.yaml. No connections are configured in ktx.yaml.',
    );
  });
});

describe('resolveRequiredConnectionId', () => {
  it('returns the requested id when it is configured', () => {
    const config = configWith(['warehouse']);
    expect(resolveRequiredConnectionId(config, 'warehouse')).toBe('warehouse');
  });

  it('throws an expected error listing connections when the requested id is unknown', () => {
    const config = configWith(['analytics', 'warehouse']);
    expect(() => resolveRequiredConnectionId(config, 'DIG_SMART_REP')).toThrow(KtxExpectedError);
    expect(() => resolveRequiredConnectionId(config, 'DIG_SMART_REP')).toThrow(
      'Connection "DIG_SMART_REP" is not configured in ktx.yaml. Configured connections: analytics, warehouse.',
    );
  });

  it('defaults to the only connection when the id is omitted', () => {
    const config = configWith(['warehouse']);
    expect(resolveRequiredConnectionId(config, undefined)).toBe('warehouse');
  });

  it('throws an expected error listing connections when the id is omitted and several exist', () => {
    const config = configWith(['analytics', 'warehouse']);
    let error: unknown;
    try {
      resolveRequiredConnectionId(config, undefined);
    } catch (caught) {
      error = caught;
    }
    expect(error).toBeInstanceOf(KtxExpectedError);
    expect((error as Error).message).toBe(
      'connectionId is required. Configured connections: analytics, warehouse.',
    );
  });
});
