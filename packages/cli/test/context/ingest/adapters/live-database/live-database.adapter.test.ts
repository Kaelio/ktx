import Database from 'better-sqlite3';
import { mkdtemp, readdir, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { tableRefSet, type KtxTableRefKey } from '../../../../../src/context/scan/table-ref.js';
import { LiveDatabaseSourceAdapter } from '../../../../../src/context/ingest/adapters/live-database/live-database.adapter.js';
import { createSqliteLiveDatabaseIntrospection } from '../../../../../src/connectors/sqlite/live-database-introspection.js';
import { resolveEnabledTables } from '../../../../../src/context/scan/enabled-tables.js';
import { KtxExpectedError } from '../../../../../src/errors.js';
import type { FetchContext } from '../../../../../src/context/ingest/types.js';

describe('LiveDatabaseSourceAdapter', () => {
  it('fetches a schema snapshot through the introspection port', async () => {
    const extractSchema = vi.fn().mockResolvedValue({
      connectionId: 'conn-1',
      driver: 'postgres',
      extractedAt: '2026-04-27T00:00:00.000Z',
      scope: { schemas: ['public'] },
      metadata: {},
      tables: [
        {
          name: 'orders',
          catalog: null,
          db: 'public',
          kind: 'table',
          comment: null,
          estimatedRows: null,
          columns: [
            {
              name: 'id',
              nativeType: 'integer',
              normalizedType: 'integer',
              dimensionType: 'number',
              nullable: false,
              primaryKey: true,
              comment: null,
            },
          ],
          foreignKeys: [],
        },
      ],
    });
    const adapter = new LiveDatabaseSourceAdapter({
      introspection: { extractSchema },
      now: () => new Date('2026-04-27T00:00:00.000Z'),
    });
    const dir = await mkdtemp(join(tmpdir(), 'ktx-live-db-adapter-'));

    await adapter.fetch(undefined, dir, { connectionId: 'conn-1', sourceKey: 'live-database' });

    expect(extractSchema).toHaveBeenCalledWith('conn-1', { tableScope: undefined });
    await expect(adapter.detect(dir)).resolves.toBe(true);
    const chunked = await adapter.chunk(dir);
    expect(chunked.workUnits.map((wu) => wu.unitKey)).toEqual(['live-database-public-orders']);
  });

  it('declares the live database source and skill', () => {
    const adapter = new LiveDatabaseSourceAdapter({
      introspection: { extractSchema: vi.fn() },
    });
    expect(adapter.source).toBe('live-database');
    expect(adapter.skillNames).toEqual(['live_database_ingest']);
  });

  it('threads tableScope from fetch context into the introspection port without post-filtering', async () => {
    const extractSchema = vi.fn(
      async (_connectionId: string, _options?: { tableScope?: ReadonlySet<KtxTableRefKey> }) => ({
        connectionId: 'warehouse',
        driver: 'snowflake' as const,
        extractedAt: '2026-05-22T00:00:00.000Z',
        scope: {},
        metadata: {},
        tables: [
          {
            catalog: 'A',
            db: 'MARTS',
            name: 'IN_SCOPE',
            kind: 'table' as const,
            comment: null,
            estimatedRows: 0,
            columns: [],
            foreignKeys: [],
          },
          {
            catalog: 'A',
            db: 'MARTS',
            name: 'OUT_OF_SCOPE',
            kind: 'table' as const,
            comment: null,
            estimatedRows: 0,
            columns: [],
            foreignKeys: [],
          },
        ],
      }),
    );
    const scope = tableRefSet([{ catalog: 'A', db: 'MARTS', name: 'IN_SCOPE' }]);
    const adapter = new LiveDatabaseSourceAdapter({
      introspection: { extractSchema },
    });
    const stagedDir = await mkdtemp(join(tmpdir(), 'ktx-livedb-scope-'));
    try {
      await adapter.fetch(undefined, stagedDir, {
        connectionId: 'warehouse',
        sourceKey: 'live-database',
        tableScope: scope,
      });
      expect(extractSchema).toHaveBeenCalledWith('warehouse', { tableScope: scope });
      const tables = await readdir(join(stagedDir, 'tables'));
      expect(tables).toHaveLength(2);
    } finally {
      await rm(stagedDir, { recursive: true, force: true });
    }
  });
});

describe('LiveDatabaseSourceAdapter (sqlite) tolerant scan', () => {
  const CONNECTION_ID = 'warehouse';
  let tempDir: string;

  beforeEach(async () => {
    tempDir = await mkdtemp(join(tmpdir(), 'ktx-live-db-tolerant-'));
  });

  afterEach(async () => {
    await rm(tempDir, { recursive: true, force: true });
  });

  function adapterFor(dbPath: string): LiveDatabaseSourceAdapter {
    return new LiveDatabaseSourceAdapter({
      introspection: createSqliteLiveDatabaseIntrospection({
        projectDir: tempDir,
        connections: { [CONNECTION_ID]: { driver: 'sqlite', path: dbPath } },
      }),
    });
  }

  function ctx(overrides: Partial<FetchContext> = {}): FetchContext {
    return { connectionId: CONNECTION_ID, sourceKey: 'live-database', ...overrides };
  }

  it('ingests healthy objects and reports the broken view as a skip', async () => {
    const dbPath = join(tempDir, 'partial.db');
    const db = new Database(dbPath);
    db.exec(`
      CREATE TABLE base (id INTEGER PRIMARY KEY, start_date TEXT);
      CREATE VIEW emp_hire_periods_with_name AS SELECT id, start_date FROM base;
      CREATE TABLE customers (id INTEGER PRIMARY KEY, name TEXT NOT NULL);
      DROP TABLE base;
    `);
    db.close();

    const adapter = adapterFor(dbPath);
    const stagedDir = join(tempDir, 'staged-partial');
    await adapter.fetch(undefined, stagedDir, ctx());

    await expect(adapter.detect(stagedDir)).resolves.toBe(true);

    const warnings = JSON.parse(await readFile(join(stagedDir, 'warnings.json'), 'utf8')) as {
      warnings: Array<{ code: string; table?: string }>;
    };
    expect(warnings.warnings).toHaveLength(1);
    expect(warnings.warnings[0]).toMatchObject({
      code: 'object_introspection_failed',
      table: 'emp_hire_periods_with_name',
    });

    const report = await adapter.readFetchReport(stagedDir);
    expect(report?.skipped.map((issue) => issue.entityId)).toEqual(['emp_hire_periods_with_name']);
  });

  it('raises a clear connection error when every object fails introspection', async () => {
    const dbPath = join(tempDir, 'all-broken.db');
    const db = new Database(dbPath);
    db.exec(`
      CREATE TABLE base (id INTEGER PRIMARY KEY, value TEXT);
      CREATE VIEW only_view AS SELECT id, value FROM base;
      DROP TABLE base;
    `);
    db.close();

    const adapter = adapterFor(dbPath);
    await expect(adapter.fetch(undefined, join(tempDir, 'staged-all-broken'), ctx())).rejects.toThrow(KtxExpectedError);
  });

  it('treats a genuinely empty database as a recognized, empty success', async () => {
    const dbPath = join(tempDir, 'empty.db');
    new Database(dbPath).close();

    const adapter = adapterFor(dbPath);
    const stagedDir = join(tempDir, 'staged-empty');
    await adapter.fetch(undefined, stagedDir, ctx());
    await expect(adapter.detect(stagedDir)).resolves.toBe(true);
    await expect(adapter.readFetchReport(stagedDir)).resolves.toBeNull();
  });

  it('ingests exactly the enabled_tables subset and fails clearly on a zero-match scope', async () => {
    const dbPath = join(tempDir, 'scoped.db');
    const db = new Database(dbPath);
    db.exec(`
      CREATE TABLE customers (id INTEGER PRIMARY KEY, name TEXT);
      CREATE TABLE orders (id INTEGER PRIMARY KEY, customer_id INTEGER);
    `);
    db.close();
    const adapter = adapterFor(dbPath);

    const scope = resolveEnabledTables({ driver: 'sqlite', enabled_tables: ['main.customers'] }) ?? undefined;
    const stagedDir = join(tempDir, 'staged-scoped');
    await adapter.fetch(undefined, stagedDir, ctx({ tableScope: scope }));
    const meta = JSON.parse(await readFile(join(stagedDir, 'connection.json'), 'utf8')) as { tableCount: number };
    expect(meta.tableCount).toBe(1);

    const typoScope = resolveEnabledTables({ driver: 'sqlite', enabled_tables: ['nope'] }) ?? undefined;
    await expect(
      adapter.fetch(undefined, join(tempDir, 'staged-zero'), ctx({ tableScope: typoScope })),
    ).rejects.toThrow(/matched no objects.*Available objects: customers, orders/s);
  });
});
