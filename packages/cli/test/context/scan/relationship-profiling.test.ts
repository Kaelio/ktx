import { readFile } from 'node:fs/promises';
import { join } from 'node:path';
import Database from 'better-sqlite3';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { getSqlDialectForDriver } from '../../../src/context/connections/dialects.js';
import type { KtxEnrichedColumn, KtxEnrichedSchema, KtxEnrichedTable } from '../../../src/context/scan/enrichment-types.js';
import { snapshotToKtxEnrichedSchema } from '../../../src/context/scan/local-enrichment.js';
import { loadKtxRelationshipBenchmarkFixture, maskKtxRelationshipBenchmarkSnapshot } from '../../../src/context/scan/relationship-benchmarks.js';
import { createKtxRelationshipProfileCache, profileKtxRelationshipSchema } from '../../../src/context/scan/relationship-profiling.js';
import type { KtxQueryResult, KtxReadOnlyQueryInput, KtxScanContext } from '../../../src/context/scan/types.js';

class InMemorySqliteExecutor {
  readonly db = new Database(':memory:');
  queryCount = 0;

  executeReadOnly(input: KtxReadOnlyQueryInput, _ctx: KtxScanContext): Promise<KtxQueryResult> {
    this.queryCount += 1;
    const rows = this.db.prepare(input.sql).all() as Record<string, unknown>[];
    const headers = Object.keys(rows[0] ?? {});
    return Promise.resolve({
      headers,
      rows: rows.map((row) => headers.map((header) => row[header])),
      totalRows: rows.length,
      rowCount: rows.length,
    });
  }

  close(): void {
    this.db.close();
  }
}

class FileSqliteExecutor {
  readonly db: Database.Database;
  queryCount = 0;

  constructor(dataPath: string) {
    this.db = new Database(dataPath, { readonly: true, fileMustExist: true });
  }

  executeReadOnly(input: KtxReadOnlyQueryInput, _ctx: KtxScanContext): Promise<KtxQueryResult> {
    this.queryCount += 1;
    const rows = this.db.prepare(input.sql).all() as Record<string, unknown>[];
    const headers = Object.keys(rows[0] ?? {});
    return Promise.resolve({
      headers,
      rows: rows.map((row) => headers.map((header) => row[header])),
      totalRows: rows.length,
      rowCount: rows.length,
    });
  }

  close(): void {
    this.db.close();
  }
}

function column(tableId: string, name: string, overrides: Partial<KtxEnrichedColumn> = {}): KtxEnrichedColumn {
  const tableRef = overrides.tableRef ?? { catalog: null, db: null, name: tableId };
  return {
    id: `${tableId}.${name}`,
    tableId,
    tableRef,
    name,
    nativeType: overrides.nativeType ?? 'INTEGER',
    normalizedType: overrides.normalizedType ?? 'integer',
    dimensionType: overrides.dimensionType ?? 'number',
    nullable: overrides.nullable ?? true,
    primaryKey: overrides.primaryKey ?? false,
    parentColumnId: null,
    descriptions: {},
    embedding: null,
    sampleValues: null,
    cardinality: null,
    ...overrides,
  };
}

function table(name: string, columns: KtxEnrichedColumn[]): KtxEnrichedTable {
  const ref = { catalog: null, db: null, name };
  return {
    id: name,
    ref,
    enabled: true,
    descriptions: {},
    columns: columns.map((item) => ({ ...item, tableId: name, tableRef: ref })),
  };
}

function schema(tables: KtxEnrichedTable[]): KtxEnrichedSchema {
  return { connectionId: 'warehouse', tables, relationships: [] };
}

describe('relationship profiling', () => {
  let executor: InMemorySqliteExecutor | null = null;

  afterEach(() => {
    executor?.close();
    executor = null;
  });

  it('keeps profiling on the batched table path', async () => {
    const source = await readFile(new URL('../../../src/context/scan/relationship-profiling.ts', import.meta.url), 'utf-8');

    expect(source).not.toMatch(new RegExp('queryColumn' + 'Profile'));
    expect(source).not.toMatch(/for \(const column of table\.columns\)[\s\S]*executeReadOnly/);
    expect(source).toMatch(/queryTableProfile/);
    expect(source).toMatch(/UNION ALL/);
  });

  it('profiles row count, null rate, uniqueness, sample values, and text lengths', async () => {
    executor = new InMemorySqliteExecutor();
    executor.db.exec(`
      CREATE TABLE accounts (id INTEGER, code TEXT, parent_id INTEGER);
      INSERT INTO accounts (id, code, parent_id) VALUES
        (1, 'A-1', NULL),
        (2, 'B-2', 1),
        (3, 'C-3', 1),
        (4, 'C-3', 2);
    `);

    const result = await profileKtxRelationshipSchema({
      connectionId: 'warehouse',
      driver: 'sqlite',
      dialect: getSqlDialectForDriver('sqlite'),
      schema: schema([
        table('accounts', [
          column('accounts', 'id', { primaryKey: false, nullable: false }),
          column('accounts', 'code', { nativeType: 'TEXT', normalizedType: 'text', dimensionType: 'string' }),
          column('accounts', 'parent_id'),
        ]),
      ]),
      executor,
      ctx: { runId: 'profile-test' },
      sampleValuesPerColumn: 3,
    });

    expect(result.sqlAvailable).toBe(true);
    expect(result.queryCount).toBe(1);
    expect(executor.queryCount).toBe(1);
    expect(result.tables).toHaveLength(1);
    expect(result.tables[0]).toMatchObject({ table: { name: 'accounts' }, rowCount: 4 });
    expect(result.columns['accounts.id']).toMatchObject({
      table: { name: 'accounts' },
      column: 'id',
      rowCount: 4,
      nullCount: 0,
      distinctCount: 4,
      uniquenessRatio: 1,
      nullRate: 0,
      minTextLength: 1,
      maxTextLength: 1,
    });
    expect(result.columns['accounts.code']).toMatchObject({
      distinctCount: 3,
      uniquenessRatio: 0.75,
      sampleValues: ['C-3', 'A-1', 'B-2'],
      minTextLength: 3,
      maxTextLength: 3,
    });
    expect(result.columns['accounts.parent_id']).toMatchObject({
      nullCount: 1,
      distinctCount: 2,
      uniquenessRatio: 0.5,
      nullRate: 0.25,
    });
  });

  it('profiles each enabled table with one read-only SQL query', async () => {
    executor = new InMemorySqliteExecutor();
    executor.db.exec(`
      CREATE TABLE accounts (id INTEGER, code TEXT, parent_id INTEGER);
      CREATE TABLE users (id INTEGER, account_id INTEGER);
      INSERT INTO accounts (id, code, parent_id) VALUES
        (1, 'A-1', NULL),
        (2, 'B-2', 1),
        (3, 'C-3', 1),
        (4, 'C-3', 2);
      INSERT INTO users (id, account_id) VALUES
        (10, 1),
        (11, 1),
        (12, 2);
    `);

    const result = await profileKtxRelationshipSchema({
      connectionId: 'warehouse',
      driver: 'sqlite',
      dialect: getSqlDialectForDriver('sqlite'),
      schema: schema([
        table('accounts', [
          column('accounts', 'id', { nullable: false }),
          column('accounts', 'code', { nativeType: 'TEXT', normalizedType: 'text', dimensionType: 'string' }),
          column('accounts', 'parent_id'),
        ]),
        table('users', [column('users', 'id', { nullable: false }), column('users', 'account_id')]),
      ]),
      executor,
      ctx: { runId: 'profile-batched-query-count' },
      sampleValuesPerColumn: 3,
    });

    expect(result.sqlAvailable).toBe(true);
    expect(result.queryCount).toBe(2);
    expect(executor.queryCount).toBe(2);
    expect(result.tables).toEqual([
      { table: { catalog: null, db: null, name: 'accounts' }, rowCount: 4 },
      { table: { catalog: null, db: null, name: 'users' }, rowCount: 3 },
    ]);
    expect(result.columns['accounts.code']).toMatchObject({
      distinctCount: 3,
      uniquenessRatio: 0.75,
      sampleValues: ['C-3', 'A-1', 'B-2'],
    });
    expect(result.columns['users.account_id']).toMatchObject({
      rowCount: 3,
      nullCount: 0,
      distinctCount: 2,
      uniquenessRatio: 2 / 3,
    });
  });

  it('bounds column profile statistics with profileSampleRows', async () => {
    const executor = new InMemorySqliteExecutor();
    executor.db.exec(`
      CREATE TABLE accounts (id INTEGER NOT NULL, account_code TEXT NOT NULL);
      INSERT INTO accounts VALUES (1, 'a1'), (2, 'a2'), (3, 'a3'), (4, 'a4');
    `);

    const profiles = await profileKtxRelationshipSchema({
      connectionId: 'warehouse',
      driver: 'sqlite',
      dialect: getSqlDialectForDriver('sqlite'),
      schema: schema([
        table('accounts', [
          column('accounts', 'id', { nullable: false }),
          column('accounts', 'account_code', {
            nativeType: 'TEXT',
            normalizedType: 'text',
            dimensionType: 'string',
            nullable: false,
          }),
        ]),
      ]),
      executor,
      ctx: { runId: 'profile-sample-rows' },
      profileSampleRows: 2,
    });

    expect(profiles.queryCount).toBe(1);
    expect(executor.queryCount).toBe(1);
    expect(profiles.tables).toEqual([{ table: { catalog: null, db: null, name: 'accounts' }, rowCount: 4 }]);
    expect(profiles.columns['accounts.id']).toMatchObject({
      rowCount: 2,
      distinctCount: 2,
      uniquenessRatio: 1,
    });
    expect(profiles.columns['accounts.account_code']?.sampleValues).toEqual(['a1', 'a2']);

    executor.close();
  });

  it('reuses a profile cache inside one scan run but re-queries with a fresh cache', async () => {
    executor = new InMemorySqliteExecutor();
    executor.db.exec(`
      CREATE TABLE accounts (id INTEGER NOT NULL, account_code TEXT NOT NULL);
      INSERT INTO accounts VALUES (1, 'a1'), (2, 'a2'), (3, 'a2');
    `);
    const relationshipSchema = schema([
      table('accounts', [
        column('accounts', 'id', { nullable: false }),
        column('accounts', 'account_code', {
          nativeType: 'TEXT',
          normalizedType: 'text',
          dimensionType: 'string',
          nullable: false,
        }),
      ]),
    ]);
    const cache = createKtxRelationshipProfileCache();

    const first = await profileKtxRelationshipSchema({
      connectionId: 'warehouse',
      driver: 'sqlite',
      dialect: getSqlDialectForDriver('sqlite'),
      schema: relationshipSchema,
      executor,
      ctx: { runId: 'profile-cache-run' },
      cache,
    });
    const second = await profileKtxRelationshipSchema({
      connectionId: 'warehouse',
      driver: 'sqlite',
      dialect: getSqlDialectForDriver('sqlite'),
      schema: relationshipSchema,
      executor,
      ctx: { runId: 'profile-cache-run' },
      cache,
    });
    const third = await profileKtxRelationshipSchema({
      connectionId: 'warehouse',
      driver: 'sqlite',
      dialect: getSqlDialectForDriver('sqlite'),
      schema: relationshipSchema,
      executor,
      ctx: { runId: 'profile-cache-fresh-run' },
      cache: createKtxRelationshipProfileCache(),
    });

    expect(first.queryCount).toBe(1);
    expect(second.queryCount).toBe(0);
    expect(third.queryCount).toBe(1);
    expect(executor.queryCount).toBe(2);
    expect(second.tables).toEqual(first.tables);
    expect(second.columns).toEqual(first.columns);
  });

  it('profiles the checked-in scale stress fixture with one query per table', async () => {
    const fixtureRoot = new URL('../../fixtures/relationship-benchmarks', import.meta.url);
    const fixture = await loadKtxRelationshipBenchmarkFixture(join(fixtureRoot.pathname, 'scale_stress_no_declared_constraints'));
    if (!fixture.dataPath) {
      throw new Error('scale_stress_no_declared_constraints is missing data.sqlite');
    }
    const maskedSnapshot = maskKtxRelationshipBenchmarkSnapshot(
      fixture.snapshot,
      'declared_pks_and_declared_fks_removed',
    );
    const scaleExecutor = new FileSqliteExecutor(fixture.dataPath);
    try {
      const result = await profileKtxRelationshipSchema({
        connectionId: fixture.snapshot.connectionId,
        driver: fixture.snapshot.driver,
        dialect: getSqlDialectForDriver(fixture.snapshot.driver),
        schema: snapshotToKtxEnrichedSchema(maskedSnapshot, new Map()),
        executor: scaleExecutor,
        ctx: { runId: 'scale-stress-profile-query-count' },
        profileSampleRows: 3,
      });

      expect(fixture.snapshot.tables).toHaveLength(400);
      expect(result.queryCount).toBe(400);
      expect(result.queryCount).toBeLessThanOrEqual(2 * fixture.snapshot.tables.length);
      expect(scaleExecutor.queryCount).toBe(400);
    } finally {
      scaleExecutor.close();
    }
  });

  it('profiles tables concurrently up to profileConcurrency', async () => {
    let inFlight = 0;
    let maxInFlight = 0;
    const executor = {
      executeReadOnly: vi.fn(async (input: KtxReadOnlyQueryInput) => {
        inFlight += 1;
        maxInFlight = Math.max(maxInFlight, inFlight);
        await new Promise((resolve) => setTimeout(resolve, 10));
        inFlight -= 1;
        return {
          headers: [
            'column_name',
            'table_row_count',
            'row_count',
            'null_count',
            'distinct_count',
            'min_text_length',
            'max_text_length',
            'sample_values',
          ],
          rows: [[input.sql.includes('accounts') ? 'id' : 'account_id', 2, 2, 0, 2, 1, 2, '1\u001f2']],
          totalRows: 1,
          rowCount: 1,
        };
      }),
    };

    await profileKtxRelationshipSchema({
      connectionId: 'warehouse',
      driver: 'sqlite',
      dialect: getSqlDialectForDriver('sqlite'),
      schema: schemaWithTables(['accounts', 'orders', 'payments', 'refunds']),
      executor,
      ctx: { runId: 'profile-concurrency' },
      profileConcurrency: 4,
    });

    expect(maxInFlight).toBe(4);
  });

  it('keeps profiling other tables when one table profile fails', async () => {
    const executor = {
      executeReadOnly: vi.fn(async (input: KtxReadOnlyQueryInput) => {
        if (input.sql.includes('"orders"')) {
          throw new Error('orders unavailable');
        }
        return {
          headers: [
            'column_name',
            'table_row_count',
            'row_count',
            'null_count',
            'distinct_count',
            'min_text_length',
            'max_text_length',
            'sample_values',
          ],
          rows: [['id', 2, 2, 0, 2, 1, 2, '1\u001f2']],
          totalRows: 1,
          rowCount: 1,
        };
      }),
    };

    const result = await profileKtxRelationshipSchema({
      connectionId: 'warehouse',
      driver: 'sqlite',
      dialect: getSqlDialectForDriver('sqlite'),
      schema: schemaWithTables(['accounts', 'orders']),
      executor,
      ctx: { runId: 'profile-error-isolated' },
      profileConcurrency: 2,
    });

    expect(result.warnings).toContain('profile_failed:orders:orders unavailable');
    expect(result.tables).toHaveLength(2);
    expect(Object.keys(result.columns)).toContain('accounts.id');
  });
});

function schemaWithTables(names: string[]): KtxEnrichedSchema {
  return schema(
    names.map((name) =>
      table(name, [
        column(name, name === 'orders' ? 'account_id' : 'id', {
          nullable: false,
          primaryKey: name !== 'orders',
        }),
      ]),
    ),
  );
}
