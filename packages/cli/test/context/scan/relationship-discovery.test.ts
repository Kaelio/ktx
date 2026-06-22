import Database from 'better-sqlite3';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { KtxLlmRuntimePort } from '../../../src/context/llm/runtime-port.js';
import { getSqlDialectForDriver } from '../../../src/context/connections/dialects.js';
import { buildDefaultKtxProjectConfig } from '../../../src/context/project/config.js';
import { snapshotToKtxEnrichedSchema } from '../../../src/context/scan/local-enrichment.js';
import {
  loadKtxRelationshipBenchmarkFixture,
  maskKtxRelationshipBenchmarkSnapshot,
} from '../../../src/context/scan/relationship-benchmarks.js';
import { discoverKtxRelationships } from '../../../src/context/scan/relationship-discovery.js';
import { createKtxConnectorCapabilities } from '../../../src/context/scan/types.js';
import type { KtxQueryResult, KtxReadOnlyQueryInput, KtxScanConnector, KtxScanContext, KtxSchemaSnapshot } from '../../../src/context/scan/types.js';

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

function snapshot(): KtxSchemaSnapshot {
  return {
    connectionId: 'warehouse',
    driver: 'sqlite',
    extractedAt: '2026-05-07T00:00:00.000Z',
    scope: {},
    metadata: {},
    tables: [
      {
        catalog: null,
        db: null,
        name: 'accounts',
        kind: 'table',
        comment: null,
        estimatedRows: 2,
        foreignKeys: [],
        columns: [
          {
            name: 'id',
            nativeType: 'INTEGER',
            normalizedType: 'integer',
            dimensionType: 'number',
            nullable: false,
            primaryKey: false,
            comment: null,
          },
          {
            name: 'name',
            nativeType: 'TEXT',
            normalizedType: 'text',
            dimensionType: 'string',
            nullable: false,
            primaryKey: false,
            comment: null,
          },
        ],
      },
      {
        catalog: null,
        db: null,
        name: 'orders',
        kind: 'table',
        comment: null,
        estimatedRows: 3,
        foreignKeys: [],
        columns: [
          {
            name: 'id',
            nativeType: 'INTEGER',
            normalizedType: 'integer',
            dimensionType: 'number',
            nullable: false,
            primaryKey: false,
            comment: null,
          },
          {
            name: 'account_id',
            nativeType: 'INTEGER',
            normalizedType: 'integer',
            dimensionType: 'number',
            nullable: false,
            primaryKey: false,
            comment: null,
          },
        ],
      },
    ],
  };
}

function declaredForeignKeySnapshot(): KtxSchemaSnapshot {
  const source = snapshot();
  return {
    ...source,
    tables: source.tables.map((table) =>
      table.name === 'accounts'
        ? {
            ...table,
            columns: table.columns.map((column) => (column.name === 'id' ? { ...column, primaryKey: true } : column)),
          }
        : table.name === 'orders'
          ? {
              ...table,
              foreignKeys: [
                {
                  fromColumn: 'account_id',
                  toCatalog: null,
                  toDb: null,
                  toTable: 'accounts',
                  toColumn: 'id',
                  constraintName: 'orders_account_id_fkey',
                },
              ],
            }
          : table,
    ),
  };
}

function naturalKeySnapshot(): KtxSchemaSnapshot {
  return {
    connectionId: 'warehouse',
    driver: 'sqlite',
    extractedAt: '2026-05-07T00:00:00.000Z',
    scope: {},
    metadata: {},
    tables: [
      {
        catalog: null,
        db: null,
        name: 'dim_countries',
        kind: 'table',
        comment: null,
        estimatedRows: 3,
        foreignKeys: [],
        columns: [
          {
            name: 'iso_code',
            nativeType: 'TEXT',
            normalizedType: 'text',
            dimensionType: 'string',
            nullable: false,
            primaryKey: false,
            comment: null,
          },
          {
            name: 'name',
            nativeType: 'TEXT',
            normalizedType: 'text',
            dimensionType: 'string',
            nullable: false,
            primaryKey: false,
            comment: null,
          },
        ],
      },
      {
        catalog: null,
        db: null,
        name: 'fct_accounts',
        kind: 'table',
        comment: null,
        estimatedRows: 4,
        foreignKeys: [],
        columns: [
          {
            name: 'id',
            nativeType: 'INTEGER',
            normalizedType: 'integer',
            dimensionType: 'number',
            nullable: false,
            primaryKey: false,
            comment: null,
          },
          {
            name: 'country_code',
            nativeType: 'TEXT',
            normalizedType: 'text',
            dimensionType: 'string',
            nullable: false,
            primaryKey: false,
            comment: null,
          },
        ],
      },
    ],
  };
}

function connector(executor: InMemorySqliteExecutor | null): KtxScanConnector {
  return {
    id: 'sqlite:test',
    driver: 'sqlite',
    capabilities: createKtxConnectorCapabilities({
      readOnlySql: executor !== null,
      columnStats: executor !== null,
      tableSampling: false,
      columnSampling: false,
    }),
    introspect: async () => snapshot(),
    listSchemas: async () => [],
    listTables: async () => [],
    executeReadOnly: executor ? executor.executeReadOnly.bind(executor) : undefined,
  };
}

function llmRuntime(output: unknown): KtxLlmRuntimePort {
  return {
    generateText: vi.fn(),
    generateObject: vi.fn(async () => output) as KtxLlmRuntimePort['generateObject'],
    runAgentLoop: vi.fn(),
  };
}

function relationshipSettings() {
  return buildDefaultKtxProjectConfig().scan.relationships;
}

function llmOnlyRelationshipSnapshot(): KtxSchemaSnapshot {
  return {
    connectionId: 'warehouse',
    driver: 'sqlite',
    extractedAt: '2026-05-07T00:00:00.000Z',
    scope: {},
    metadata: {},
    tables: [
      {
        catalog: null,
        db: null,
        name: 'customers',
        kind: 'table',
        comment: null,
        estimatedRows: 2,
        foreignKeys: [],
        columns: [
          {
            name: 'id',
            nativeType: 'INTEGER',
            normalizedType: 'integer',
            dimensionType: 'number',
            nullable: false,
            primaryKey: false,
            comment: null,
          },
        ],
      },
      {
        catalog: null,
        db: null,
        name: 'orders',
        kind: 'table',
        comment: null,
        estimatedRows: 2,
        foreignKeys: [],
        columns: [
          {
            name: 'id',
            nativeType: 'INTEGER',
            normalizedType: 'integer',
            dimensionType: 'number',
            nullable: false,
            primaryKey: false,
            comment: null,
          },
          {
            name: 'buyer_ref',
            nativeType: 'INTEGER',
            normalizedType: 'integer',
            dimensionType: 'number',
            nullable: false,
            primaryKey: false,
            comment: null,
          },
        ],
      },
    ],
  };
}

describe('production relationship discovery', () => {
  let executor: InMemorySqliteExecutor | null = null;

  afterEach(() => {
    executor?.close();
    executor = null;
  });

  it('accepts a validated relationship without declared PK or FK metadata', async () => {
    executor = new InMemorySqliteExecutor();
    executor.db.exec(`
      CREATE TABLE accounts (id INTEGER NOT NULL, name TEXT NOT NULL);
      CREATE TABLE orders (id INTEGER NOT NULL, account_id INTEGER NOT NULL);
      INSERT INTO accounts (id, name) VALUES (1, 'Acme'), (2, 'Globex');
      INSERT INTO orders (id, account_id) VALUES (10, 1), (11, 1), (12, 2);
    `);

    const result = await discoverKtxRelationships({
      connectionId: 'warehouse',
      dialect: getSqlDialectForDriver('sqlite'),
      connector: connector(executor),
      schema: snapshotToKtxEnrichedSchema(snapshot()),
      context: { runId: 'relationship-run-1' },
      settings: relationshipSettings(),
    });

    expect(result.relationships).toEqual({ accepted: 1, review: 0, rejected: 0, skipped: 0 });
    expect(result.statisticalValidation).toBe('completed');
    expect(result.profile.sqlAvailable).toBe(true);
    expect(result.profile.queryCount).toBeGreaterThan(0);
    expect(result.relationshipUpdate.accepted).toEqual([
      expect.objectContaining({
        from: expect.objectContaining({ table: expect.objectContaining({ name: 'orders' }), columns: ['account_id'] }),
        to: expect.objectContaining({ table: expect.objectContaining({ name: 'accounts' }), columns: ['id'] }),
        relationshipType: 'many_to_one',
        source: 'inferred',
        isPrimaryKeyReference: true,
      }),
    ]);
    expect(result.resolvedRelationships[0]).toMatchObject({
      status: 'accepted',
      validation: expect.objectContaining({ reasons: expect.arrayContaining(['validation_passed']) }),
      graph: expect.objectContaining({ reasons: expect.arrayContaining(['fk_score_passed']) }),
    });
  });

  it('accepts a profile-driven natural-key relationship without declared metadata', async () => {
    executor = new InMemorySqliteExecutor();
    executor.db.exec(`
      CREATE TABLE dim_countries (iso_code TEXT NOT NULL, name TEXT NOT NULL);
      CREATE TABLE fct_accounts (id INTEGER NOT NULL, country_code TEXT NOT NULL);
      INSERT INTO dim_countries (iso_code, name) VALUES ('US', 'United States'), ('FR', 'France'), ('DE', 'Germany');
      INSERT INTO fct_accounts (id, country_code) VALUES (1, 'US'), (2, 'FR'), (3, 'US'), (4, 'DE');
    `);

    const schema = naturalKeySnapshot();
    const result = await discoverKtxRelationships({
      connectionId: 'warehouse',
      dialect: getSqlDialectForDriver('sqlite'),
      connector: {
        ...connector(executor),
        introspect: async () => schema,
      },
      schema: snapshotToKtxEnrichedSchema(schema),
      context: { runId: 'natural-key-relationship-run' },
      settings: relationshipSettings(),
    });

    expect(result.relationships).toEqual({ accepted: 1, review: 0, rejected: 0, skipped: 0 });
    expect(result.relationshipUpdate.accepted).toEqual([
      expect.objectContaining({
        from: expect.objectContaining({ table: expect.objectContaining({ name: 'fct_accounts' }), columns: ['country_code'] }),
        to: expect.objectContaining({ table: expect.objectContaining({ name: 'dim_countries' }), columns: ['iso_code'] }),
        relationshipType: 'many_to_one',
        source: 'inferred',
        isPrimaryKeyReference: true,
      }),
    ]);
    expect(result.resolvedRelationships[0]).toMatchObject({
      source: 'profile_match',
      status: 'accepted',
      validation: expect.objectContaining({ reasons: expect.arrayContaining(['validation_passed']) }),
      graph: expect.objectContaining({ reasons: expect.arrayContaining(['fk_score_passed']) }),
    });
  });

  it('accepts an embedding-driven relationship without declared metadata or LLM proposals', async () => {
    executor = new InMemorySqliteExecutor();
    executor.db.exec(`
      CREATE TABLE customers (id INTEGER NOT NULL, name TEXT NOT NULL);
      CREATE TABLE orders (id INTEGER NOT NULL, buyer_ref INTEGER NOT NULL);
      INSERT INTO customers (id, name) VALUES (1, 'Acme'), (2, 'Orbit'), (3, 'Globex');
      INSERT INTO orders (id, buyer_ref) VALUES (10, 1), (11, 2), (12, 2), (13, 3);
    `);

    const sourceSnapshot = llmOnlyRelationshipSnapshot();
    const schema = snapshotToKtxEnrichedSchema(
      sourceSnapshot,
      new Map([
        ['customers.id', [1, 0, 0]],
        ['customers.name', [0, 1, 0]],
        ['orders.id', [0, 0, 1]],
        ['orders.buyer_ref', [0.995, 0.005, 0]],
      ]),
    );

    const result = await discoverKtxRelationships({
      connectionId: 'warehouse',
      dialect: getSqlDialectForDriver('sqlite'),
      connector: {
        ...connector(executor),
        introspect: async () => sourceSnapshot,
      },
      schema,
      context: { runId: 'embedding-relationship-run' },
      settings: {
        ...relationshipSettings(),
        llmProposals: false,
      },
    });

    expect(result.llmRelationshipValidation).toBe('skipped');
    expect(result.relationships).toEqual({ accepted: 1, review: 0, rejected: 0, skipped: 0 });
    expect(result.relationshipUpdate.accepted[0]).toMatchObject({
      from: { table: { name: 'orders' }, columns: ['buyer_ref'] },
      to: { table: { name: 'customers' }, columns: ['id'] },
    });
    expect(result.resolvedRelationships[0]).toMatchObject({
      source: 'embedding_similarity',
      status: 'accepted',
      validation: expect.objectContaining({ reasons: expect.arrayContaining(['validation_passed']) }),
      evidence: expect.objectContaining({
        reasons: expect.arrayContaining(['embedding_similarity', 'target_key_like']),
        embeddingSimilarity: expect.any(Number),
      }),
    });
  });

  it('keeps candidates review-only when read-only SQL is unavailable', async () => {
    const result = await discoverKtxRelationships({
      connectionId: 'warehouse',
      dialect: getSqlDialectForDriver('sqlite'),
      connector: connector(null),
      schema: snapshotToKtxEnrichedSchema(snapshot()),
      context: { runId: 'relationship-run-no-sql' },
      settings: relationshipSettings(),
    });

    expect(result.relationships).toEqual({ accepted: 0, review: 1, rejected: 0, skipped: 0 });
    expect(result.statisticalValidation).toBe('skipped');
    expect(result.relationshipUpdate.accepted).toEqual([]);
    expect(result.resolvedRelationships[0]).toMatchObject({
      status: 'review',
      validation: expect.objectContaining({ reasons: expect.arrayContaining(['validation_unavailable']) }),
    });
    expect(result.warnings).toContainEqual({
      code: 'connector_capability_missing',
      message: 'ktx scan connector cannot run read-only SQL relationship validation',
      recoverable: true,
      metadata: { capability: 'readOnlySql' },
    });
  });

  it('accepts formal metadata relationships when read-only SQL is unavailable', async () => {
    const sourceSnapshot = declaredForeignKeySnapshot();
    const result = await discoverKtxRelationships({
      connectionId: 'warehouse',
      dialect: getSqlDialectForDriver('sqlite'),
      connector: connector(null),
      schema: snapshotToKtxEnrichedSchema(sourceSnapshot),
      context: { runId: 'formal-metadata-no-sql' },
      settings: relationshipSettings(),
    });

    expect(result.statisticalValidation).toBe('skipped');
    expect(result.relationships).toEqual({ accepted: 1, review: 0, rejected: 0, skipped: 0 });
    expect(result.resolvedRelationships).toEqual([]);
    expect(result.relationshipUpdate.accepted).toEqual([
      expect.objectContaining({
        id: 'orders:(orders.account_id)->accounts:(accounts.id)',
        source: 'formal',
        confidence: 1,
        from: expect.objectContaining({ table: expect.objectContaining({ name: 'orders' }), columns: ['account_id'] }),
        to: expect.objectContaining({ table: expect.objectContaining({ name: 'accounts' }), columns: ['id'] }),
      }),
    ]);
    expect(result.relationshipUpdate.rejected).toEqual([]);
    expect(result.relationshipUpdate.skipped).toEqual([]);
  });

  it('accepts LLM-only relationship proposals only after SQL validation and graph resolution pass', async () => {
    executor = new InMemorySqliteExecutor();
    executor.db.exec(`
      CREATE TABLE customers (id INTEGER);
      CREATE TABLE orders (id INTEGER, buyer_ref INTEGER);
      INSERT INTO customers (id) VALUES (1), (2);
      INSERT INTO orders (id, buyer_ref) VALUES (10, 1), (11, 2);
    `);
    const llmOutput = {
      pkCandidates: [{ table: 'customers', column: 'id', confidence: 0.91, rationale: 'Unique customer key.' }],
      fkCandidates: [
        {
          fromTable: 'orders',
          fromColumn: 'buyer_ref',
          toTable: 'customers',
          toColumn: 'id',
          confidence: 0.89,
          rationale: 'Buyer reference values align with customer identifiers.',
        },
      ],
    };

    const result = await discoverKtxRelationships({
      connectionId: 'warehouse',
      dialect: getSqlDialectForDriver('sqlite'),
      connector: connector(executor),
      schema: snapshotToKtxEnrichedSchema(llmOnlyRelationshipSnapshot()),
      context: { runId: 'llm-relationship-orchestrator' },
      settings: relationshipSettings(),
      llmRuntime: llmRuntime(llmOutput),
    });

    expect(result.llmRelationshipValidation).toBe('completed');
    expect(result.relationships).toEqual({ accepted: 1, review: 0, rejected: 0, skipped: 0 });
    expect(result.resolvedRelationships[0]).toMatchObject({
      source: 'llm_proposal',
      status: 'accepted',
      evidence: {
        llmRationale: 'Buyer reference values align with customer identifiers.',
      },
    });
    expect(result.relationshipUpdate.accepted[0]).toMatchObject({
      from: { table: { name: 'orders' }, columns: ['buyer_ref'] },
      to: { table: { name: 'customers' }, columns: ['id'] },
    });
  });

  it('uses configured acceptance thresholds when resolving graph relationships', async () => {
    const executor = new InMemorySqliteExecutor();
    executor.db.exec(`
      CREATE TABLE accounts (id INTEGER NOT NULL, name TEXT NOT NULL);
      CREATE TABLE orders (id INTEGER NOT NULL, account_id INTEGER NOT NULL);
      INSERT INTO accounts VALUES (1, 'Acme'), (2, 'Orbit');
      INSERT INTO orders VALUES (10, 1), (11, 1), (12, 2);
    `);

    const settings = {
      ...buildDefaultKtxProjectConfig().scan.relationships,
      acceptThreshold: 0.99,
      reviewThreshold: 0.55,
    };

    const result = await discoverKtxRelationships({
      connectionId: 'warehouse',
      dialect: getSqlDialectForDriver('sqlite'),
      connector: connector(executor),
      schema: snapshotToKtxEnrichedSchema(snapshot()),
      context: { runId: 'configured-thresholds' },
      settings,
    });

    expect(result.relationships).toEqual({ accepted: 0, review: 1, rejected: 0, skipped: 0 });
    expect(result.relationshipUpdate.accepted).toEqual([]);
    expect(result.resolvedRelationships[0]).toMatchObject({
      status: 'review',
      graph: { reasons: expect.arrayContaining(['fk_score_review']) },
    });

    executor.close();
  });

  it('passes maxCandidatesPerColumn into broad deterministic candidate generation', async () => {
    const executor = new InMemorySqliteExecutor();
    executor.db.exec(`
      CREATE TABLE accounts (id INTEGER NOT NULL, name TEXT NOT NULL);
      CREATE TABLE account_archive (id INTEGER NOT NULL, name TEXT NOT NULL);
      CREATE TABLE orders (id INTEGER NOT NULL, account_id INTEGER NOT NULL);
      INSERT INTO accounts VALUES (1, 'Acme'), (2, 'Orbit');
      INSERT INTO account_archive VALUES (99, 'Archive');
      INSERT INTO orders VALUES (10, 1), (11, 1), (12, 2);
    `);

    const richSnapshot = snapshot();
    richSnapshot.tables.splice(1, 0, {
      catalog: null,
      db: null,
      name: 'account_archive',
      kind: 'table',
      comment: null,
      estimatedRows: 1,
      foreignKeys: [],
      columns: [
        {
          name: 'id',
          nativeType: 'INTEGER',
          normalizedType: 'integer',
          dimensionType: 'number',
          nullable: false,
          primaryKey: false,
          comment: null,
        },
        {
          name: 'name',
          nativeType: 'TEXT',
          normalizedType: 'text',
          dimensionType: 'string',
          nullable: false,
          primaryKey: false,
          comment: null,
        },
      ],
    });

    const result = await discoverKtxRelationships({
      connectionId: 'warehouse',
      dialect: getSqlDialectForDriver('sqlite'),
      connector: {
        ...connector(executor),
        introspect: async () => richSnapshot,
      },
      schema: snapshotToKtxEnrichedSchema(richSnapshot),
      context: { runId: 'candidate-cap' },
      settings: {
        ...buildDefaultKtxProjectConfig().scan.relationships,
        maxCandidatesPerColumn: 1,
      },
    });

    const sourceTargets = result.resolvedRelationships
      .filter((relationship) => relationship.from.columns[0] === 'account_id')
      .map((relationship) => `${relationship.to.table.name}.${relationship.to.columns[0]}`);
    expect(sourceTargets).toHaveLength(1);
    expect(sourceTargets).toEqual(['accounts.id']);

    executor.close();
  });

  it('accepts SQL-validated composite relationships in production relationship-discovery detection', async () => {
    const fixtureRoot = new URL(
      '../../fixtures/relationship-benchmarks/composite_keys_no_declared_constraints',
      import.meta.url,
    );
    const fixture = await loadKtxRelationshipBenchmarkFixture(fixtureRoot.pathname);
    const maskedSnapshot = maskKtxRelationshipBenchmarkSnapshot(fixture.snapshot, 'declared_pks_and_declared_fks_removed');
    const database = new Database(fixture.dataPath ?? '', { readonly: true, fileMustExist: true });
    const testConnector: KtxScanConnector = {
      id: 'sqlite:composite',
      driver: 'sqlite',
      capabilities: createKtxConnectorCapabilities({
        readOnlySql: true,
        columnStats: true,
        tableSampling: false,
        columnSampling: false,
      }),
      introspect: async () => maskedSnapshot,
      listSchemas: async () => [],
      listTables: async () => [],
      executeReadOnly: async (input) => {
        const rows = database.prepare(input.sql).all() as Record<string, unknown>[];
        const headers = Object.keys(rows[0] ?? {});
        return {
          headers,
          rows: rows.map((row) => headers.map((header) => row[header])),
          totalRows: rows.length,
          rowCount: rows.length,
        };
      },
    };

    const result = await discoverKtxRelationships({
      connectionId: maskedSnapshot.connectionId,
      dialect: getSqlDialectForDriver(maskedSnapshot.driver),
      connector: testConnector,
      schema: snapshotToKtxEnrichedSchema(maskedSnapshot, new Map()),
      context: { runId: 'test:production-composite' },
      settings: relationshipSettings(),
    });
    database.close();

    expect(
      result.relationshipUpdate.accepted.map(
        (relationship) =>
          `${relationship.from.table.name}.(${relationship.from.columns.join(',')})->${relationship.to.table.name}.(${relationship.to.columns.join(',')})`,
      ),
    ).toContain('order_line_allocations.(order_id,line_number)->order_lines.(order_id,line_number)');
    expect(result.relationships.accepted).toBeGreaterThanOrEqual(1);
    expect(result.compositeRelationships.map((relationship) => relationship.status)).toContain('accepted');
  });
});
