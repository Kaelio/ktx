import { describe, expect, it, vi } from 'vitest';
import { KtxExpectedError } from '../../../src/errors.js';
import {
  KtxHologresScanConnector,
  isKtxHologresConnectionConfig,
  type KtxHologresConnectionConfig,
} from '../../../src/connectors/hologres/connector.js';
import type { KtxPostgresPoolConfig, KtxPostgresPoolFactory } from '../../../src/connectors/postgres/connector.js';

interface FakeQueryResult {
  rows: Record<string, unknown>[];
  fields?: Array<{ name: string; dataTypeID: number }>;
}

type FakeQueryResponse = FakeQueryResult | Error;

function fakePoolFactory(results: Map<string, FakeQueryResponse>): KtxPostgresPoolFactory {
  const query = vi.fn(async (sql: string, _params?: unknown[]) => {
    const normalized = sql.replace(/\s+/g, ' ').trim();
    for (const [key, value] of results.entries()) {
      if (normalized.includes(key)) {
        if (value instanceof Error) {
          throw value;
        }
        return value;
      }
    }
    throw new Error(`Unexpected SQL: ${normalized}`);
  });
  return {
    createPool(_config: KtxPostgresPoolConfig) {
      return {
        async connect() {
          return { query, release: vi.fn() };
        },
        end: vi.fn(async () => undefined),
      };
    },
  };
}

const connection: KtxHologresConnectionConfig = {
  driver: 'hologres',
  host: 'holo.example.test',
  database: 'analytics',
  username: 'reader',
  password: 'test-password', // pragma: allowlist secret
  schema: 'public',
};

function hologresVersionResult(version: string): FakeQueryResult {
  return {
    fields: [{ name: 'hg_version', dataTypeID: 25 }],
    rows: [{ hg_version: `Hologres ${version} (tag: -abc build: Release), compatible with PostgreSQL 11.3 on x86_64-linux` }],
  };
}

describe('isKtxHologresConnectionConfig', () => {
  it('accepts hologres connections and rejects everything else', () => {
    expect(isKtxHologresConnectionConfig(connection)).toBe(true);
    expect(isKtxHologresConnectionConfig({ driver: 'postgres' })).toBe(false);
    expect(isKtxHologresConnectionConfig(undefined)).toBe(false);
  });
});

describe('KtxHologresScanConnector', () => {
  it('reports the hologres driver and id', () => {
    const connector = new KtxHologresScanConnector({
      connectionId: 'wh',
      connection,
      poolFactory: fakePoolFactory(new Map()),
    });
    expect(connector.driver).toBe('hologres');
    expect(connector.id).toBe('hologres:wh');
  });

  it('drops Hologres system schemas from listSchemas while keeping user schemas that share the hologres_ prefix', async () => {
    const results = new Map<string, FakeQueryResponse>([
      [
        'FROM information_schema.schemata',
        {
          rows: [
            { schema_name: 'analytics' },
            { schema_name: 'hg_internal' },
            { schema_name: 'hg_recyclebin' },
            { schema_name: 'hologres' },
            { schema_name: 'hologres_dataset_tpch_10g' },
            { schema_name: 'hologres_object_table' },
            { schema_name: 'hologres_sample' },
            { schema_name: 'hologres_statistic' },
            { schema_name: 'hologres_streaming_mv' },
            { schema_name: 'public' },
          ],
        },
      ],
    ]);
    const connector = new KtxHologresScanConnector({
      connectionId: 'wh',
      connection,
      poolFactory: fakePoolFactory(results),
    });
    await expect(connector.listSchemas()).resolves.toEqual(['analytics', 'hologres_dataset_tpch_10g', 'public']);
  });

  it('introspects a schema and stamps the snapshot driver as hologres', async () => {
    const results = new Map<string, FakeQueryResponse>([
      ['hg_version()', hologresVersionResult('4.2.10')],
      [
        'c.reltuples::bigint AS row_count',
        { rows: [{ table_name: 'orders', table_kind: 'r', row_count: '5', table_comment: 'order facts' }] },
      ],
      [
        'format_type(a.atttypid, a.atttypmod)',
        {
          rows: [
            { table_name: 'orders', column_name: 'id', data_type: 'bigint', is_nullable: false, column_comment: null },
          ],
        },
      ],
      ["constraint_type = 'PRIMARY KEY'", { rows: [{ table_name: 'orders', column_name: 'id' }] }],
      ["constraint_type = 'FOREIGN KEY'", { rows: [] }],
    ]);
    const connector = new KtxHologresScanConnector({
      connectionId: 'wh',
      connection,
      poolFactory: fakePoolFactory(results),
      now: () => new Date('2026-07-15T00:00:00.000Z'),
    });
    const snapshot = await connector.introspect({ connectionId: 'wh', driver: 'hologres' }, { runId: 'run-1' });
    expect(snapshot.driver).toBe('hologres');
    expect(snapshot.scope).toEqual({ schemas: ['public'] });
    expect(snapshot.tables.map((table) => [table.db, table.name, table.kind, table.estimatedRows])).toEqual([
      ['public', 'orders', 'table', 5],
    ]);
    expect(snapshot.tables[0]?.columns.map((column) => [column.name, column.primaryKey])).toEqual([['id', true]]);
  });

  it('passes the connection test on Hologres 4.0 or newer', async () => {
    const connector = new KtxHologresScanConnector({
      connectionId: 'wh',
      connection,
      poolFactory: fakePoolFactory(
        new Map<string, FakeQueryResponse>([
          ['SELECT 1', { rows: [] }],
          ['hg_version()', hologresVersionResult('4.0.1')],
        ]),
      ),
    });
    await expect(connector.testConnection()).resolves.toEqual({ success: true });
  });

  it('rejects introspection against Hologres older than 4.0', async () => {
    const connector = new KtxHologresScanConnector({
      connectionId: 'wh',
      connection,
      poolFactory: fakePoolFactory(new Map<string, FakeQueryResponse>([['hg_version()', hologresVersionResult('3.9.5')]])),
    });
    await expect(
      connector.introspect({ connectionId: 'wh', driver: 'hologres' }, { runId: 'r' }),
    ).rejects.toBeInstanceOf(KtxExpectedError);
    await expect(
      connector.introspect({ connectionId: 'wh', driver: 'hologres' }, { runId: 'r' }),
    ).rejects.toThrow(/Hologres 4\.0 or newer/);
  });

  it('fails the connection test on Hologres older than 4.0', async () => {
    const connector = new KtxHologresScanConnector({
      connectionId: 'wh',
      connection,
      poolFactory: fakePoolFactory(
        new Map<string, FakeQueryResponse>([
          ['SELECT 1', { rows: [] }],
          ['hg_version()', hologresVersionResult('3.9.5')],
        ]),
      ),
    });
    expect((await connector.testConnection()).success).toBe(false);
  });
});
