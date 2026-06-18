import Database from 'better-sqlite3';
import type { ChildProcess } from 'node:child_process';
import { writeFileSync } from 'node:fs';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { createSqliteLiveDatabaseIntrospection } from '../../../src/connectors/sqlite/live-database-introspection.js';
import {
  forkReadQueryChild,
  isKtxSqliteConnectionConfig,
  KtxSqliteScanConnector,
  sqliteDatabasePathFromConfig,
} from '../../../src/connectors/sqlite/connector.js';
import { tableRefSet } from '../../../src/context/scan/table-ref.js';
import { resolveEnabledTables } from '../../../src/context/scan/enabled-tables.js';

describe('KtxSqliteScanConnector', () => {
  let tempDir: string;
  let dbPath: string;

  beforeEach(async () => {
    tempDir = await mkdtemp(join(tmpdir(), 'ktx-connector-sqlite-'));
    dbPath = join(tempDir, 'warehouse.db');
    const db = new Database(dbPath);
    db.exec(`
      PRAGMA foreign_keys = ON;
      CREATE TABLE customers (
        id INTEGER PRIMARY KEY,
        name TEXT NOT NULL,
        tier TEXT
      );
      CREATE TABLE orders (
        id INTEGER PRIMARY KEY,
        customer_id INTEGER NOT NULL,
        status TEXT,
        total NUMERIC,
        created_at TEXT,
        FOREIGN KEY(customer_id) REFERENCES customers(id)
      );
      CREATE VIEW recent_orders AS SELECT id, customer_id, status FROM orders;
      INSERT INTO customers (id, name, tier) VALUES (1, 'Ada', 'enterprise'), (2, 'Grace', 'growth');
      INSERT INTO orders (id, customer_id, status, total, created_at)
        VALUES (10, 1, 'paid', 42.5, '2026-04-28'), (11, 2, 'open', 9.5, '2026-04-29');
    `);
    db.close();
  });

  afterEach(async () => {
    await rm(tempDir, { recursive: true, force: true });
  });

  it('resolves SQLite path configuration safely', () => {
    const originalDatabaseUrl = process.env.KTX_SQLITE_TEST_URL;
    const pointerPath = join(tempDir, 'sqlite-path.txt');
    process.env.KTX_SQLITE_TEST_URL = `sqlite:${dbPath}`;
    writeFileSync(pointerPath, dbPath, 'utf-8');

    try {
      expect(isKtxSqliteConnectionConfig({ driver: 'sqlite', path: 'warehouse.db' })).toBe(true);
      expect(isKtxSqliteConnectionConfig({ driver: 'postgres', url: 'env:DATABASE_URL' })).toBe(false);
      expect(
        sqliteDatabasePathFromConfig({
          connectionId: 'warehouse',
          projectDir: tempDir,
          connection: { driver: 'sqlite', path: 'warehouse.db' },
        }),
      ).toBe(dbPath);
      expect(
        sqliteDatabasePathFromConfig({
          connectionId: 'warehouse',
          projectDir: tempDir,
          connection: { driver: 'sqlite', url: 'env:KTX_SQLITE_TEST_URL' },
        }),
      ).toBe(dbPath);
      expect(
        sqliteDatabasePathFromConfig({
          connectionId: 'warehouse',
          projectDir: tempDir,
          connection: { driver: 'sqlite', url: `file://${dbPath}` },
        }),
      ).toBe(dbPath);
      expect(
        sqliteDatabasePathFromConfig({
          connectionId: 'warehouse',
          projectDir: tempDir,
          connection: { driver: 'sqlite', path: `file:${pointerPath}` },
        }),
      ).toBe(dbPath);
      expect(
        sqliteDatabasePathFromConfig({
          connectionId: 'warehouse',
          projectDir: tempDir,
          connection: { driver: 'sqlite', path: 'warehouse.db' },
        }),
      ).toBe(dbPath);
      expect(() =>
        sqliteDatabasePathFromConfig({
          connectionId: 'warehouse',
          projectDir: tempDir,
          connection: { driver: 'sqlite', file_path: 'warehouse.db' },
        }),
      ).toThrow('Native SQLite connector requires connections.warehouse.path or url');
    } finally {
      if (originalDatabaseUrl === undefined) {
        delete process.env.KTX_SQLITE_TEST_URL;
      } else {
        process.env.KTX_SQLITE_TEST_URL = originalDatabaseUrl;
      }
    }
  });

  it('introspects schema, primary keys, row counts, views, and foreign keys', async () => {
    const connector = new KtxSqliteScanConnector({
      connectionId: 'warehouse',
      connection: { driver: 'sqlite', path: dbPath },
      now: () => new Date('2026-04-29T10:00:00.000Z'),
    });

    const snapshot = await connector.introspect(
      { connectionId: 'warehouse', driver: 'sqlite' },
      { runId: 'scan-run-1' },
    );

    expect(snapshot).toMatchObject({
      connectionId: 'warehouse',
      driver: 'sqlite',
      extractedAt: '2026-04-29T10:00:00.000Z',
      metadata: {
        file_path: dbPath,
        table_count: 3,
        total_columns: 11,
      },
    });
    expect(snapshot.tables.map((table) => [table.name, table.kind, table.estimatedRows])).toEqual([
      ['customers', 'table', 2],
      ['orders', 'table', 2],
      ['recent_orders', 'view', null],
    ]);
    expect(snapshot.tables.find((table) => table.name === 'customers')?.columns[0]).toMatchObject({
      name: 'id',
      nativeType: 'INTEGER',
      normalizedType: 'INTEGER',
      dimensionType: 'number',
      nullable: false,
      primaryKey: true,
    });
    expect(snapshot.tables.find((table) => table.name === 'orders')?.foreignKeys).toEqual([
      {
        fromColumn: 'customer_id',
        toCatalog: null,
        toDb: null,
        toTable: 'customers',
        toColumn: 'id',
        constraintName: null,
      },
    ]);
  });

  it('skips an object that fails introspection and ingests the rest with one recoverable warning', async () => {
    const brokenDbPath = join(tempDir, 'broken.db');
    const brokenDb = new Database(brokenDbPath);
    brokenDb.exec(`
      CREATE TABLE base (id INTEGER PRIMARY KEY, start_date TEXT);
      CREATE VIEW emp_hire_periods_with_name AS SELECT id, start_date FROM base;
      CREATE TABLE customers (id INTEGER PRIMARY KEY, name TEXT NOT NULL);
      INSERT INTO customers (id, name) VALUES (1, 'Ada');
      DROP TABLE base;
    `);
    brokenDb.close();

    const connector = new KtxSqliteScanConnector({
      connectionId: 'warehouse',
      connection: { driver: 'sqlite', path: brokenDbPath },
    });

    const snapshot = await connector.introspect({ connectionId: 'warehouse', driver: 'sqlite' }, { runId: 'scan-run-broken' });

    expect(snapshot.tables.map((table) => table.name)).toEqual(['customers']);
    expect(snapshot.warnings).toHaveLength(1);
    expect(snapshot.warnings?.[0]).toMatchObject({
      code: 'object_introspection_failed',
      table: 'emp_hire_periods_with_name',
      recoverable: true,
    });
    expect(snapshot.warnings?.[0]?.message).toContain('no such table');
  });

  it('returns no tables and only warnings when every object fails introspection', async () => {
    const brokenDbPath = join(tempDir, 'all-broken.db');
    const brokenDb = new Database(brokenDbPath);
    brokenDb.exec(`
      CREATE TABLE base (id INTEGER PRIMARY KEY, value TEXT);
      CREATE VIEW only_view AS SELECT id, value FROM base;
      DROP TABLE base;
    `);
    brokenDb.close();

    const connector = new KtxSqliteScanConnector({
      connectionId: 'warehouse',
      connection: { driver: 'sqlite', path: brokenDbPath },
    });

    const snapshot = await connector.introspect({ connectionId: 'warehouse', driver: 'sqlite' }, { runId: 'scan-run-all-broken' });

    expect(snapshot.tables).toEqual([]);
    expect(snapshot.warnings).toHaveLength(1);
    expect(snapshot.warnings?.[0]?.code).toBe('object_introspection_failed');
  });

  it('restricts introspection to enabled_tables, accepting both "main.<name>" and bare "<name>"', async () => {
    const connector = new KtxSqliteScanConnector({
      connectionId: 'warehouse',
      connection: { driver: 'sqlite', path: dbPath },
    });

    for (const entry of ['main.customers', 'customers']) {
      const tableScope = resolveEnabledTables({ driver: 'sqlite', enabled_tables: [entry] }) ?? undefined;
      const snapshot = await connector.introspect(
        { connectionId: 'warehouse', driver: 'sqlite', ...(tableScope ? { tableScope } : {}) },
        { runId: `scan-run-scope-${entry}` },
      );
      expect(snapshot.tables.map((table) => table.name)).toEqual(['customers']);
      expect(snapshot.metadata.discovered_object_names).toEqual(['customers', 'orders', 'recent_orders']);
    }
  });

  it('lists schemaless tables and views for setup discovery', async () => {
    const connector = new KtxSqliteScanConnector({
      connectionId: 'warehouse',
      connection: { driver: 'sqlite', path: dbPath },
    });

    await expect(connector.listSchemas()).resolves.toEqual([]);
    await expect(connector.listTables(['ignored'])).resolves.toEqual([
      { catalog: null, schema: '', name: 'customers', kind: 'table' },
      { catalog: null, schema: '', name: 'orders', kind: 'table' },
      { catalog: null, schema: '', name: 'recent_orders', kind: 'view' },
    ]);
  });

  it('runs samples, distinct values, statistics, and read-only SQL', async () => {
    const connector = new KtxSqliteScanConnector({
      connectionId: 'warehouse',
      connection: { driver: 'sqlite', path: dbPath },
    });

    await expect(
      connector.sampleTable(
        { connectionId: 'warehouse', table: { catalog: null, db: null, name: 'orders' }, columns: ['id'], limit: 1 },
        { runId: 'scan-run-1' },
      ),
    ).resolves.toEqual({ headers: ['id'], rows: [[10]], totalRows: 1 });

    await expect(
      connector.sampleColumn(
        { connectionId: 'warehouse', table: { catalog: null, db: null, name: 'orders' }, column: 'status', limit: 5 },
        { runId: 'scan-run-1' },
      ),
    ).resolves.toMatchObject({ values: ['paid', 'open'], nullCount: null, distinctCount: null });

    await expect(
      connector.getColumnDistinctValues(
        { catalog: null, db: null, name: 'orders' },
        'status',
        { maxCardinality: 5, limit: 10, sampleSize: 100 },
      ),
    ).resolves.toEqual({ values: ['open', 'paid'], cardinality: 2 });

    await expect(
      connector.executeReadOnly(
        { connectionId: 'warehouse', sql: 'select id, status from orders order by id', maxRows: 1 },
        { runId: 'scan-run-1' },
      ),
    ).resolves.toEqual({ headers: ['id', 'status'], rows: [[10, 'paid']], totalRows: 1, rowCount: 1 });

    await expect(
      connector.executeReadOnly({ connectionId: 'warehouse', sql: 'delete from orders' }, { runId: 'scan-run-1' }),
    ).rejects.toThrow('Only read-only SELECT/WITH queries can be executed locally');

    await expect(
      connector.columnStats(
        { connectionId: 'warehouse', table: { catalog: null, db: null, name: 'orders' }, column: 'status' },
        { runId: 'scan-run-1' },
      ),
    ).resolves.toBeNull();
  });

  it('limits introspection to tables in tableScope', async () => {
    const connector = new KtxSqliteScanConnector({
      connectionId: 'warehouse',
      connection: { driver: 'sqlite', path: dbPath },
    });
    const scope = tableRefSet([{ catalog: null, db: null, name: 'orders' }]);
    const snapshot = await connector.introspect(
      { connectionId: 'warehouse', driver: 'sqlite', tableScope: scope },
      { runId: 'scope-test' },
    );
    expect(snapshot.tables.map((table) => table.name)).toEqual(['orders']);
  });

  describe('bounded read-query execution', () => {
    // A recursive CTE that spins ~1e9 iterations in SQLite's VM with no yield
    // point — the single-aggregate-row shape that maxRows cannot bound. Natural
    // completion is far beyond the test window, so a fast finish proves the
    // child was killed, not that the query completed.
    const pathologicalSql =
      'WITH RECURSIVE c(x) AS (SELECT 1 UNION ALL SELECT x + 1 FROM c WHERE x < 1000000000) SELECT COUNT(*) AS n FROM c';

    let children: ChildProcess[];
    const trackingSpawn = () => {
      const child = forkReadQueryChild();
      children.push(child);
      return child;
    };

    beforeEach(() => {
      children = [];
    });

    afterEach(() => {
      for (const child of children) {
        if (child.exitCode === null && child.signalCode === null) {
          child.kill('SIGKILL');
        }
      }
    });

    it('terminates a pathological query at the deadline, keeps the event loop free, and reaps the child', async () => {
      const connector = new KtxSqliteScanConnector({
        connectionId: 'warehouse',
        connection: { driver: 'sqlite', path: dbPath, query_timeout_ms: 250 },
        spawnReadQueryChild: trackingSpawn,
      });

      const pending = connector.executeReadOnly(
        { connectionId: 'warehouse', sql: pathologicalSql },
        { runId: 'deadline-test' },
      );

      // The event loop stays free while the query runs off-process, so this
      // concurrent timer fires before the deadline rejects the query.
      let concurrentFiredWhilePending = false;
      void pending.catch(() => {});
      await new Promise((resolveTimer) => setTimeout(resolveTimer, 80));
      concurrentFiredWhilePending = true;

      await expect(pending).rejects.toThrow(/^query exceeded \d+s$/);
      expect(concurrentFiredWhilePending).toBe(true);

      // The off-process executor was actually killed (SIGKILL), not left spinning.
      expect(children).toHaveLength(1);
      const child = children[0]!;
      await vi.waitFor(() => expect(child.exitCode !== null || child.signalCode !== null).toBe(true), {
        timeout: 5_000,
      });
      expect(child.signalCode).toBe('SIGKILL');
    });

    it('returns identical results to the in-process path for a normal query', async () => {
      const connector = new KtxSqliteScanConnector({
        connectionId: 'warehouse',
        connection: { driver: 'sqlite', path: dbPath },
        spawnReadQueryChild: trackingSpawn,
      });

      await expect(
        connector.executeReadOnly(
          { connectionId: 'warehouse', sql: 'select id, status from orders order by id' },
          { runId: 'normal' },
        ),
      ).resolves.toEqual({
        headers: ['id', 'status'],
        rows: [
          [10, 'paid'],
          [11, 'open'],
        ],
        totalRows: 2,
        rowCount: 2,
      });
    });

    it('rejects invalid SQL on the main thread without spawning a child', async () => {
      const connector = new KtxSqliteScanConnector({
        connectionId: 'warehouse',
        connection: { driver: 'sqlite', path: dbPath },
        spawnReadQueryChild: trackingSpawn,
      });

      await expect(
        connector.executeReadOnly({ connectionId: 'warehouse', sql: 'delete from orders' }, { runId: 'invalid' }),
      ).rejects.toThrow('Only read-only SELECT/WITH queries can be executed locally');
      expect(children).toHaveLength(0);
    });
  });

  it('adapts native SQLite snapshots to live-database introspection for local ingest', async () => {
    const introspection = createSqliteLiveDatabaseIntrospection({
      projectDir: tempDir,
      connections: {
        warehouse: { driver: 'sqlite', path: 'warehouse.db' },
      },
      now: () => new Date('2026-04-29T10:00:00.000Z'),
    });

    const snapshot = await introspection.extractSchema('warehouse');

    expect(snapshot).toMatchObject({
      connectionId: 'warehouse',
      extractedAt: '2026-04-29T10:00:00.000Z',
    });
    expect(snapshot.tables.find((table) => table.name === 'customers')).toMatchObject({
      name: 'customers',
      catalog: null,
      db: null,
      columns: [
        {
          name: 'id',
          nativeType: 'INTEGER',
          normalizedType: 'INTEGER',
          dimensionType: 'number',
          nullable: false,
          primaryKey: true,
          comment: null,
        },
        {
          name: 'name',
          nativeType: 'TEXT',
          normalizedType: 'TEXT',
          dimensionType: 'string',
          nullable: false,
          primaryKey: false,
          comment: null,
        },
        {
          name: 'tier',
          nativeType: 'TEXT',
          normalizedType: 'TEXT',
          dimensionType: 'string',
          nullable: true,
          primaryKey: false,
          comment: null,
        },
      ],
      foreignKeys: [],
    });
    expect(snapshot.tables.find((table) => table.name === 'orders')).toMatchObject({
      name: 'orders',
      catalog: null,
      db: null,
      foreignKeys: [{ fromColumn: 'customer_id', toTable: 'customers', toColumn: 'id' }],
    });
  });
});
