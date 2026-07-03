import { describe, expect, it, vi } from 'vitest';
import type { executeFederatedQuery } from '../../../src/connectors/duckdb/federated-executor.js';
import { executeProjectRawSql, executeProjectReadOnlySql } from '../../../src/context/connections/project-sql-executor.js';
import type { KtxLocalProject } from '../../../src/context/project/project.js';
import type { KtxScanConnector } from '../../../src/context/scan/types.js';
import type { SqlAnalysisPort } from '../../../src/context/sql-analysis/ports.js';
import { KtxQueryError } from '../../../src/errors.js';

function fakeProject(
  connections: Record<string, { driver: string; query_policy?: 'semantic-layer-only' }>,
): KtxLocalProject {
  return {
    projectDir: '/tmp/proj',
    configPath: '/tmp/proj/ktx.yaml',
    config: { connections } as unknown as KtxLocalProject['config'],
    coreConfig: {} as KtxLocalProject['coreConfig'],
    git: {} as KtxLocalProject['git'],
    fileStore: {} as KtxLocalProject['fileStore'],
  };
}

describe('executeProjectReadOnlySql — federated routing', () => {
  it('routes _ktx_federated through the federated executor with derived members', async () => {
    const project = fakeProject({ pg: { driver: 'postgres' }, lite: { driver: 'sqlite' } });
    const executeFederated = vi.fn<typeof executeFederatedQuery>(async () => ({
      headers: ['x'],
      rows: [[1]],
      totalRows: 1,
      command: 'SELECT',
      rowCount: 1,
    }));
    const createConnector = vi.fn();

    const result = await executeProjectReadOnlySql({
      project,
      input: { connectionId: '_ktx_federated', connection: undefined, sql: 'SELECT 1', maxRows: 100 },
      createConnector: createConnector as never,
      executeFederated,
    });

    expect(result.rows).toEqual([[1]]);
    expect(executeFederated).toHaveBeenCalledOnce();
    const members = executeFederated.mock.calls[0][0];
    expect(members.map((m) => m.connectionId).sort()).toEqual(['lite', 'pg']);
    expect(createConnector).not.toHaveBeenCalled();
  });

  it('throws when _ktx_federated requested but fewer than 2 compatible members', async () => {
    const project = fakeProject({ pg: { driver: 'postgres' } });
    await expect(
      executeProjectReadOnlySql({
        project,
        input: { connectionId: '_ktx_federated', connection: undefined, sql: 'SELECT 1', maxRows: 100 },
        createConnector: (() => {
          throw new Error('should not be called');
        }) as never,
        executeFederated: vi.fn(),
      }),
    ).rejects.toThrow(/fewer than 2/i);
  });

  it('routes a normal connection through the scan connector', async () => {
    const project = fakeProject({ pg: { driver: 'postgres' } });
    const connector = {
      driver: 'postgres',
      capabilities: { readOnlySql: true },
      executeReadOnly: vi.fn(async () => ({ headers: ['a'], rows: [['v']], totalRows: 1, rowCount: 1 })),
      cleanup: vi.fn(async () => {}),
    };
    const result = await executeProjectReadOnlySql({
      project,
      input: { connectionId: 'pg', connection: { driver: 'postgres' }, sql: 'SELECT a', maxRows: 50 },
      createConnector: (async () => connector) as never,
      executeFederated: vi.fn(),
    });
    expect(result.rows).toEqual([['v']]);
    expect(connector.executeReadOnly).toHaveBeenCalledOnce();
    expect(connector.cleanup).toHaveBeenCalledOnce();
  });
});

function connectorReturning(result: {
  headers: string[];
  headerTypes?: string[];
  rows: unknown[][];
  totalRows: number;
  rowCount: number | null;
}): KtxScanConnector {
  return {
    driver: 'sqlite',
    capabilities: { readOnlySql: true },
    async executeReadOnly() {
      return result;
    },
  } as unknown as KtxScanConnector;
}

describe('executeProjectReadOnlySql headerTypes', () => {
  it('forwards connector headerTypes on the non-federated branch', async () => {
    const project = {
      projectDir: '/tmp/p',
      config: { connections: { books_db: { driver: 'sqlite', path: './b.db' } } },
    } as never;

    const result = await executeProjectReadOnlySql({
      project,
      input: { connectionId: 'books_db', connection: undefined, sql: 'SELECT 1', maxRows: 10 },
      createConnector: () =>
        connectorReturning({
          headers: ['id'],
          headerTypes: ['INTEGER'],
          rows: [[1]],
          totalRows: 1,
          rowCount: 1,
        }),
    });

    expect(result.headerTypes).toEqual(['INTEGER']);
  });
});

function fakeSqlAnalysis(validation: { ok: boolean; error: string | null }): SqlAnalysisPort {
  return {
    analyzeForFingerprint: vi.fn(),
    analyzeBatch: vi.fn(),
    validateReadOnly: vi.fn(async () => validation),
  } as unknown as SqlAnalysisPort;
}

describe('executeProjectRawSql', () => {
  it('validates then executes raw SQL on an unrestricted connection', async () => {
    const project = fakeProject({ pg: { driver: 'postgres' } });
    const sqlAnalysis = fakeSqlAnalysis({ ok: true, error: null });
    const connector = connectorReturning({
      headers: ['id'],
      rows: [[1]],
      totalRows: 1,
      rowCount: 1,
    });

    const result = await executeProjectRawSql({
      project,
      connectionId: 'pg',
      sql: 'SELECT id FROM orders',
      maxRows: 25,
      sqlAnalysis,
      createConnector: () => connector,
      runId: 'test-raw-sql',
    });

    expect(result.rows).toEqual([[1]]);
    expect(sqlAnalysis.validateReadOnly).toHaveBeenCalledWith('SELECT id FROM orders', 'postgres');
  });

  it('rejects a restricted connection before validation or execution', async () => {
    const project = fakeProject({ pg: { driver: 'postgres', query_policy: 'semantic-layer-only' } });
    const sqlAnalysis = fakeSqlAnalysis({ ok: true, error: null });
    const createConnector = vi.fn();

    const execution = executeProjectRawSql({
      project,
      connectionId: 'pg',
      sql: 'SELECT 1',
      maxRows: 25,
      sqlAnalysis,
      createConnector: createConnector as never,
      runId: 'test-raw-sql',
    });
    await expect(execution).rejects.toBeInstanceOf(KtxQueryError);
    await expect(execution).rejects.toThrow(/query_policy: semantic-layer-only/);
    expect(sqlAnalysis.validateReadOnly).not.toHaveBeenCalled();
    expect(createConnector).not.toHaveBeenCalled();
  });

  it('rejects federated raw SQL when a member connection is restricted', async () => {
    const project = fakeProject({
      pg: { driver: 'postgres', query_policy: 'semantic-layer-only' },
      lite: { driver: 'sqlite' },
    });
    const executeFederated = vi.fn();

    await expect(
      executeProjectRawSql({
        project,
        connectionId: '_ktx_federated',
        sql: 'SELECT 1',
        maxRows: 25,
        sqlAnalysis: fakeSqlAnalysis({ ok: true, error: null }),
        createConnector: vi.fn() as never,
        executeFederated: executeFederated as never,
        runId: 'test-raw-sql',
      }),
    ).rejects.toThrow(/"pg"/);
    expect(executeFederated).not.toHaveBeenCalled();
  });

  it('classifies a read-only validation failure as an expected query error', async () => {
    const project = fakeProject({ pg: { driver: 'postgres' } });
    const createConnector = vi.fn();

    const execution = executeProjectRawSql({
      project,
      connectionId: 'pg',
      sql: 'DROP TABLE orders',
      maxRows: 25,
      sqlAnalysis: fakeSqlAnalysis({ ok: false, error: 'SQL is not read-only: DROP.' }),
      createConnector: createConnector as never,
      runId: 'test-raw-sql',
    });
    await expect(execution).rejects.toBeInstanceOf(KtxQueryError);
    await expect(execution).rejects.toThrow('SQL is not read-only: DROP.');
    expect(createConnector).not.toHaveBeenCalled();
  });
});
