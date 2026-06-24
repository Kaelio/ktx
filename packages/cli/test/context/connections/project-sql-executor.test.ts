import { describe, expect, it, vi } from 'vitest';
import type { executeFederatedQuery } from '../../../src/connectors/duckdb/federated-executor.js';
import { executeProjectReadOnlySql } from '../../../src/context/connections/project-sql-executor.js';
import type { KtxLocalProject } from '../../../src/context/project/project.js';
import type { KtxScanConnector } from '../../../src/context/scan/types.js';

function fakeProject(connections: Record<string, { driver: string }>): KtxLocalProject {
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
