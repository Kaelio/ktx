import Database from 'better-sqlite3';
import { afterEach, describe, expect, it } from 'vitest';
import { KtxQueryError } from '../../../src/errors.js';
import { getSqlDialectForDriver } from '../../../src/context/connections/dialects.js';
import type { KtxEnrichedColumn, KtxEnrichedSchema, KtxEnrichedTable } from '../../../src/context/scan/enrichment-types.js';
import { generateKtxRelationshipDiscoveryCandidates } from '../../../src/context/scan/relationship-candidates.js';
import type { KtxRelationshipProfileArtifact } from '../../../src/context/scan/relationship-profiling.js';
import { profileKtxRelationshipSchema } from '../../../src/context/scan/relationship-profiling.js';
import { validateKtxRelationshipDiscoveryCandidates } from '../../../src/context/scan/relationship-validation.js';
import type { KtxQueryResult, KtxReadOnlyQueryInput, KtxScanContext } from '../../../src/context/scan/types.js';

// This harness runs SQL directly through SQLite; row-limit wrapper coverage lives
// in read-only-sql.test.ts and the SQL Server connector test.
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

function schema(tables?: KtxEnrichedTable[]): KtxEnrichedSchema {
  return {
    connectionId: 'warehouse',
    tables: tables ?? [
      table('accounts', [
        column('accounts', 'id', { nullable: false }),
        column('accounts', 'name', { nativeType: 'TEXT', normalizedType: 'text', dimensionType: 'string' }),
      ]),
      table('users', [column('users', 'id', { nullable: false }), column('users', 'account_id', { nullable: false })]),
      table('invoices', [
        column('invoices', 'id', { nullable: false }),
        column('invoices', 'account_id', { nullable: false }),
      ]),
    ],
    relationships: [],
  };
}

describe('relationship validation', () => {
  let executor: InMemorySqliteExecutor | null = null;

  afterEach(() => {
    executor?.close();
    executor = null;
  });

  it('accepts a relationship-discovery candidate with unique parent values and full source coverage', async () => {
    executor = new InMemorySqliteExecutor();
    executor.db.exec(`
      CREATE TABLE accounts (id INTEGER, name TEXT);
      CREATE TABLE users (id INTEGER, account_id INTEGER);
      CREATE TABLE invoices (id INTEGER, account_id INTEGER);
      INSERT INTO accounts (id, name) VALUES (1, 'Acme'), (2, 'Globex'), (3, 'Initech');
      INSERT INTO users (id, account_id) VALUES (10, 1), (11, 2), (12, 3);
      INSERT INTO invoices (id, account_id) VALUES (20, 1), (21, 2), (22, 999);
    `);
    const testSchema = schema();
    const profiles = await profileKtxRelationshipSchema({
      connectionId: 'warehouse',
      driver: 'sqlite',
      dialect: getSqlDialectForDriver('sqlite'),
      schema: testSchema,
      executor,
      ctx: { runId: 'validate-test' },
    });
    const candidates = generateKtxRelationshipDiscoveryCandidates(testSchema).filter(
      (candidate) => candidate.from.table.name === 'users',
    );

    const validated = await validateKtxRelationshipDiscoveryCandidates({
      connectionId: 'warehouse',
      dialect: getSqlDialectForDriver('sqlite'),
      candidates,
      profiles,
      executor,
      ctx: { runId: 'validate-test' },
      tableCount: testSchema.tables.length,
    });

    expect(validated).toHaveLength(1);
    expect(validated[0]).toMatchObject({
      from: { table: { name: 'users' }, columns: ['account_id'] },
      to: { table: { name: 'accounts' }, columns: ['id'] },
      status: 'accepted',
      score: expect.any(Number),
      validation: {
        targetUniqueness: 1,
        sourceCoverage: 1,
        violationCount: 0,
        violationRatio: 0,
        reasons: expect.arrayContaining(['validation_passed']),
      },
    });
    expect(validated[0]?.score).toBeGreaterThanOrEqual(0.85);
  });

  it('sends a candidate to review (not source-fatal) when its validation query times out', async () => {
    executor = new InMemorySqliteExecutor();
    executor.db.exec(`
      CREATE TABLE accounts (id INTEGER, name TEXT);
      CREATE TABLE users (id INTEGER, account_id INTEGER);
      CREATE TABLE invoices (id INTEGER, account_id INTEGER);
      INSERT INTO accounts (id, name) VALUES (1, 'Acme'), (2, 'Globex'), (3, 'Initech');
      INSERT INTO users (id, account_id) VALUES (10, 1), (11, 2), (12, 3);
      INSERT INTO invoices (id, account_id) VALUES (20, 1), (21, 2), (22, 999);
    `);
    const testSchema = schema();
    const profiles = await profileKtxRelationshipSchema({
      connectionId: 'warehouse',
      driver: 'sqlite',
      dialect: getSqlDialectForDriver('sqlite'),
      schema: testSchema,
      executor,
      ctx: { runId: 'validate-test' },
    });
    const candidates = generateKtxRelationshipDiscoveryCandidates(testSchema).filter(
      (candidate) => candidate.from.table.name === 'users',
    );

    const warnings: string[] = [];
    const timingOutExecutor = {
      executeReadOnly: () => Promise.reject(new KtxQueryError('query exceeded 30s')),
    };
    const validated = await validateKtxRelationshipDiscoveryCandidates({
      connectionId: 'warehouse',
      dialect: getSqlDialectForDriver('sqlite'),
      candidates,
      profiles,
      executor: timingOutExecutor,
      ctx: {
        runId: 'validate-test',
        logger: { debug() {}, info() {}, warn: (message) => warnings.push(message), error() {} },
      },
      tableCount: testSchema.tables.length,
    });

    expect(validated).toHaveLength(1);
    expect(validated[0]).toMatchObject({
      status: 'review',
      validation: { reasons: ['validation_query_failed'] },
    });
    expect(warnings.some((message) => message.includes('query exceeded 30s'))).toBe(true);
  });

  it('rejects a candidate with missing parent values and records the deterministic reason', async () => {
    executor = new InMemorySqliteExecutor();
    executor.db.exec(`
      CREATE TABLE accounts (id INTEGER, name TEXT);
      CREATE TABLE users (id INTEGER, account_id INTEGER);
      CREATE TABLE invoices (id INTEGER, account_id INTEGER);
      INSERT INTO accounts (id, name) VALUES (1, 'Acme'), (2, 'Globex');
      INSERT INTO users (id, account_id) VALUES (10, 1), (11, 2);
      INSERT INTO invoices (id, account_id) VALUES (20, 1), (21, 999), (22, 1000);
    `);
    const testSchema = schema();
    const profiles = await profileKtxRelationshipSchema({
      connectionId: 'warehouse',
      driver: 'sqlite',
      dialect: getSqlDialectForDriver('sqlite'),
      schema: testSchema,
      executor,
      ctx: { runId: 'validate-test' },
    });
    const candidates = generateKtxRelationshipDiscoveryCandidates(testSchema).filter(
      (candidate) => candidate.from.table.name === 'invoices',
    );

    const validated = await validateKtxRelationshipDiscoveryCandidates({
      connectionId: 'warehouse',
      dialect: getSqlDialectForDriver('sqlite'),
      candidates,
      profiles,
      executor,
      ctx: { runId: 'validate-test' },
      tableCount: testSchema.tables.length,
      settings: {
        minSourceCoverage: 0.9,
        maxViolationRatio: 0.01,
      },
    });

    expect(validated).toHaveLength(1);
    expect(validated[0]).toMatchObject({
      from: { table: { name: 'invoices' }, columns: ['account_id'] },
      to: { table: { name: 'accounts' }, columns: ['id'] },
      status: 'rejected',
      validation: {
        sourceCoverage: 1 / 3,
        violationCount: 2,
        violationRatio: 2 / 3,
        reasons: expect.arrayContaining(['low_source_coverage', 'excessive_violations']),
      },
    });
  });

  it('keeps over-budget candidates review-only without executing coverage SQL for them', async () => {
    executor = new InMemorySqliteExecutor();
    executor.db.exec(`
      CREATE TABLE accounts (id INTEGER, name TEXT);
      CREATE TABLE users (id INTEGER, account_id INTEGER);
      CREATE TABLE invoices (id INTEGER, account_id INTEGER);
      INSERT INTO accounts (id, name) VALUES (1, 'Acme'), (2, 'Globex'), (3, 'Initech');
      INSERT INTO users (id, account_id) VALUES (10, 1), (11, 2), (12, 3);
      INSERT INTO invoices (id, account_id) VALUES (20, 1), (21, 2), (22, 3);
    `);
    const testSchema = schema();
    const profiles = await profileKtxRelationshipSchema({
      connectionId: 'warehouse',
      driver: 'sqlite',
      dialect: getSqlDialectForDriver('sqlite'),
      schema: testSchema,
      executor,
      ctx: { runId: 'validate-budget-profile' },
    });
    executor.queryCount = 0;
    const candidates = generateKtxRelationshipDiscoveryCandidates(testSchema).map((candidate) => ({
      ...candidate,
      confidence: candidate.from.table.name === 'users' ? 0.99 : 0.5,
    }));

    const validated = await validateKtxRelationshipDiscoveryCandidates({
      connectionId: 'warehouse',
      dialect: getSqlDialectForDriver('sqlite'),
      candidates,
      profiles,
      executor,
      ctx: { runId: 'validate-budget' },
      tableCount: testSchema.tables.length,
      settings: {
        validationBudget: 1,
      },
    });

    expect(executor.queryCount).toBe(1);
    expect(validated).toHaveLength(2);
    expect(validated.find((candidate) => candidate.from.table.name === 'users')).toMatchObject({
      status: 'accepted',
      validation: { reasons: expect.arrayContaining(['validation_passed']) },
    });
    expect(validated.find((candidate) => candidate.from.table.name === 'invoices')).toMatchObject({
      status: 'review',
      validation: {
        reasons: ['validation_unattempted'],
      },
    });
  });

  it('treats validation budget zero as review-only validation without coverage SQL', async () => {
    executor = new InMemorySqliteExecutor();
    executor.db.exec(`
      CREATE TABLE accounts (id INTEGER, name TEXT);
      CREATE TABLE users (id INTEGER, account_id INTEGER);
      INSERT INTO accounts (id, name) VALUES (1, 'Acme'), (2, 'Globex');
      INSERT INTO users (id, account_id) VALUES (10, 1), (11, 2);
    `);
    const testSchema = schema([
      table('accounts', [
        column('accounts', 'id', { nullable: false }),
        column('accounts', 'name', { nativeType: 'TEXT', normalizedType: 'text', dimensionType: 'string' }),
      ]),
      table('users', [column('users', 'id', { nullable: false }), column('users', 'account_id', { nullable: false })]),
    ]);
    const profiles = await profileKtxRelationshipSchema({
      connectionId: 'warehouse',
      driver: 'sqlite',
      dialect: getSqlDialectForDriver('sqlite'),
      schema: testSchema,
      executor,
      ctx: { runId: 'validate-zero-budget-profile' },
    });
    executor.queryCount = 0;
    const candidates = generateKtxRelationshipDiscoveryCandidates(testSchema);

    const validated = await validateKtxRelationshipDiscoveryCandidates({
      connectionId: 'warehouse',
      dialect: getSqlDialectForDriver('sqlite'),
      candidates,
      profiles,
      executor,
      ctx: { runId: 'validate-zero-budget' },
      tableCount: testSchema.tables.length,
      settings: {
        validationBudget: 0,
      },
    });

    expect(executor.queryCount).toBe(0);
    expect(validated).toHaveLength(1);
    expect(validated[0]).toMatchObject({
      status: 'review',
      score: expect.any(Number),
      validation: {
        checkedValues: 0,
        reasons: ['validation_unattempted'],
      },
    });
  });

  it('marks rejected LLM proposals with the spec rejection reason', async () => {
    executor = new InMemorySqliteExecutor();
    executor.db.exec(`
      CREATE TABLE customers (id INTEGER);
      CREATE TABLE orders (buyer_ref INTEGER);
      INSERT INTO customers (id) VALUES (1), (2);
      INSERT INTO orders (buyer_ref) VALUES (98), (99);
    `);
    const testSchema = schema([
      table('customers', [column('customers', 'id', { nullable: false })]),
      table('orders', [column('orders', 'buyer_ref')]),
    ]);
    const profiles = await profileKtxRelationshipSchema({
      connectionId: 'warehouse',
      driver: 'sqlite',
      dialect: getSqlDialectForDriver('sqlite'),
      schema: testSchema,
      executor,
      ctx: { runId: 'llm-rejected-validation' },
    });
    const [candidate] = generateKtxRelationshipDiscoveryCandidates(
      schema([
        table('customers', [column('customers', 'id', { nullable: false })]),
        table('orders', [column('orders', 'customer_id')]),
      ]),
    );
    if (!candidate) {
      throw new Error('Expected base candidate');
    }
    const llmCandidate = {
      ...candidate,
      id: 'orders:(orders.buyer_ref)->customers:(customers.id)',
      from: { ...candidate.from, columnIds: ['orders.buyer_ref'], columns: ['buyer_ref'] },
      source: 'llm_proposal' as const,
      evidence: {
        ...candidate.evidence,
        reasons: ['llm_proposal'],
        llmConfidence: 0.84,
        llmRationale: 'Buyer references should map to customers.',
      },
    };

    const [validated] = await validateKtxRelationshipDiscoveryCandidates({
      connectionId: 'warehouse',
      dialect: getSqlDialectForDriver('sqlite'),
      candidates: [llmCandidate],
      profiles,
      executor,
      ctx: { runId: 'llm-rejected-validation' },
      tableCount: testSchema.tables.length,
    });

    expect(validated?.status).toBe('rejected');
    expect(validated?.validation.reasons).toEqual(
      expect.arrayContaining(['low_source_coverage', 'llm_proposed_but_validation_failed']),
    );
  });

  it('limits validation query concurrency', async () => {
    const executor = new InMemorySqliteExecutor();
    executor.db.exec(`
      CREATE TABLE accounts (id INTEGER NOT NULL);
      CREATE TABLE orders (id INTEGER NOT NULL, account_id INTEGER NOT NULL);
      CREATE TABLE invoices (id INTEGER NOT NULL, account_id INTEGER NOT NULL);
      INSERT INTO accounts VALUES (1), (2);
      INSERT INTO orders VALUES (10, 1), (11, 2);
      INSERT INTO invoices VALUES (20, 1), (21, 2);
    `);

    let active = 0;
    let maxActive = 0;
    const throttled = {
      executeReadOnly: async (input: KtxReadOnlyQueryInput, ctx: KtxScanContext) => {
        active += 1;
        maxActive = Math.max(maxActive, active);
        await new Promise((resolve) => setTimeout(resolve, input.sql.includes('WITH child_values') ? 10 : 0));
        const result = await executor.executeReadOnly(input, ctx);
        active -= 1;
        return result;
      },
    };

    const testSchema = schema([
      table('accounts', [column('accounts', 'id', { nullable: false })]),
      table('orders', [column('orders', 'id', { nullable: false }), column('orders', 'account_id')]),
      table('invoices', [column('invoices', 'id', { nullable: false }), column('invoices', 'account_id')]),
    ]);
    const profiles = await profileKtxRelationshipSchema({
      connectionId: 'warehouse',
      driver: 'sqlite',
      dialect: getSqlDialectForDriver('sqlite'),
      schema: testSchema,
      executor,
      ctx: { runId: 'validation-concurrency-profile' },
    });
    const candidates = generateKtxRelationshipDiscoveryCandidates(testSchema);

    await validateKtxRelationshipDiscoveryCandidates({
      connectionId: 'warehouse',
      dialect: getSqlDialectForDriver('sqlite'),
      candidates,
      profiles,
      executor: throttled,
      ctx: { runId: 'validation-concurrency' },
      tableCount: testSchema.tables.length,
      settings: { concurrency: 1 },
    });

    expect(maxActive).toBe(1);
    executor.close();
  });

  it('pins column_suffix_match validation scoring for plan-code suffix candidates', async () => {
    const candidate = {
      id: 'mart:(current_plan_code)->plans:(plan_code)',
      from: {
        tableId: 'mart-account-segments-id',
        columnIds: ['current-plan-code-col'],
        table: { catalog: null, db: null, name: 'mart_account_segments' },
        columns: ['current_plan_code'],
      },
      to: {
        tableId: 'plans-id',
        columnIds: ['plan-code-col'],
        table: { catalog: null, db: null, name: 'stg_plans' },
        columns: ['plan_code'],
      },
      relationshipType: 'many_to_one' as const,
      confidence: 0.902,
      source: 'column_suffix_match' as const,
      status: 'review' as const,
      evidence: {
        sourceColumnBase: 'current_plan',
        targetTableBase: 'plan',
        targetColumnBase: 'plan_code',
        targetKeyScore: 0.86,
        nameScore: 0.78,
        reasons: ['column_suffix_match', 'profile_unique_target'],
      },
    };
    const profiles = {
      connectionId: 'warehouse',
      driver: 'sqlite',
      sqlAvailable: true,
      queryCount: 0,
      tables: [],
      warnings: [],
      columns: {
        'mart_account_segments.current_plan_code': {
          table: { catalog: null, db: null, name: 'mart_account_segments' },
          column: 'current_plan_code',
          nativeType: 'TEXT',
          normalizedType: 'text',
          rowCount: 4,
          nullCount: 0,
          distinctCount: 4,
          uniquenessRatio: 1,
          nullRate: 0,
          sampleValues: ['basic', 'enterprise', 'free', 'pro'],
          minTextLength: 4,
          maxTextLength: 10,
        },
        'stg_plans.plan_code': {
          table: { catalog: null, db: null, name: 'stg_plans' },
          column: 'plan_code',
          nativeType: 'TEXT',
          normalizedType: 'text',
          rowCount: 4,
          nullCount: 0,
          distinctCount: 4,
          uniquenessRatio: 1,
          nullRate: 0,
          sampleValues: ['basic', 'enterprise', 'free', 'pro'],
          minTextLength: 4,
          maxTextLength: 10,
        },
      },
    } satisfies KtxRelationshipProfileArtifact;
    const executor = {
      async executeReadOnly() {
        return {
          headers: ['child_distinct', 'parent_distinct', 'overlap', 'violation_count'],
          rows: [[4, 4, 4, 0]],
          rowCount: 1,
          totalRows: 1,
        };
      },
    };

    const [validated] = await validateKtxRelationshipDiscoveryCandidates({
      connectionId: 'warehouse',
      dialect: getSqlDialectForDriver('sqlite'),
      candidates: [candidate],
      profiles,
      executor,
      ctx: { runId: 'rule-b-validation-score' },
      tableCount: 2,
    });

    expect(validated).toMatchObject({
      status: 'accepted',
      score: 0.98,
      validation: {
        targetUniqueness: 1,
        sourceCoverage: 1,
        violationRatio: 0,
        reasons: ['validation_passed'],
      },
    });
  });
});
