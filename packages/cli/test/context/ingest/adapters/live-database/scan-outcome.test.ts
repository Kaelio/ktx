import { describe, expect, it } from 'vitest';
import { assertLiveDatabaseScanOutcome } from '../../../../../src/context/ingest/adapters/live-database/scan-outcome.js';
import { tableRefSet } from '../../../../../src/context/scan/table-ref.js';
import type { KtxSchemaSnapshot, KtxSchemaTable } from '../../../../../src/context/scan/types.js';

function table(name: string): KtxSchemaTable {
  return { catalog: null, db: null, name, kind: 'table', comment: null, estimatedRows: 0, columns: [], foreignKeys: [] };
}

function snapshot(overrides: Partial<KtxSchemaSnapshot>): KtxSchemaSnapshot {
  return {
    connectionId: 'warehouse',
    driver: 'sqlite',
    extractedAt: '2026-06-14T00:00:00.000Z',
    scope: {},
    metadata: {},
    tables: [],
    ...overrides,
  };
}

describe('assertLiveDatabaseScanOutcome', () => {
  it('passes when at least one object was ingested, even with skips', () => {
    expect(() =>
      assertLiveDatabaseScanOutcome({
        connectionId: 'warehouse',
        scope: undefined,
        snapshot: snapshot({
          tables: [table('customers')],
          warnings: [{ code: 'object_introspection_failed', message: 'boom', table: 'broken', recoverable: true }],
        }),
      }),
    ).not.toThrow();
  });

  it('passes for a legitimately empty database (no scope, no objects)', () => {
    expect(() =>
      assertLiveDatabaseScanOutcome({ connectionId: 'warehouse', scope: undefined, snapshot: snapshot({}) }),
    ).not.toThrow();
  });

  it('fails clearly when every introspected object failed', () => {
    expect(() =>
      assertLiveDatabaseScanOutcome({
        connectionId: 'warehouse',
        scope: undefined,
        snapshot: snapshot({
          warnings: [
            { code: 'object_introspection_failed', message: 'no such table: base', table: 'only_view', recoverable: true },
          ],
        }),
      }),
    ).toThrow(/all 1 introspected object failed.*only_view: no such table: base/s);
  });

  it('fails clearly when a non-empty enabled_tables scope matched nothing, naming available objects', () => {
    expect(() =>
      assertLiveDatabaseScanOutcome({
        connectionId: 'warehouse',
        scope: tableRefSet([{ catalog: null, db: null, name: 'typo_table' }]),
        snapshot: snapshot({ metadata: { discovered_object_names: ['customers', 'orders'] } }),
      }),
    ).toThrow(/matched no objects.*typo_table.*Available objects: customers, orders/s);
  });
});
