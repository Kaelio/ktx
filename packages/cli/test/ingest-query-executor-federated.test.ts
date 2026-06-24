import { describe, expect, it, vi } from 'vitest';
import { createKtxCliIngestQueryExecutor } from '../src/ingest-query-executor.js';

describe('federated query executor routing', () => {
  it('routes _ktx_federated to the DuckDB federated executor, not a single connector', async () => {
    const project = {
      projectDir: '/tmp/x',
      config: { connections: { pg: { driver: 'postgres', url: 'env:PG' }, lite: { driver: 'sqlite', url: '/x.db' } } },
    } as never;

    const federatedSpy = vi.fn(async () => ({
      headers: ['n'], rows: [[1]], totalRows: 1, command: 'SELECT', rowCount: 1,
    }));

    const executor = createKtxCliIngestQueryExecutor(project, { executeFederated: federatedSpy });
    const result = await executor.execute({
      connectionId: '_ktx_federated',
      connection: undefined,
      sql: 'select 1 as n',
    });

    expect(federatedSpy).toHaveBeenCalledOnce();
    expect(result.totalRows).toBe(1);
  });

  it('throws if _ktx_federated requested but fewer than 2 compatible members', async () => {
    const project = {
      projectDir: '/tmp/x',
      config: { connections: { pg: { driver: 'postgres', url: 'env:PG' } } },
    } as never;
    const executor = createKtxCliIngestQueryExecutor(project, { executeFederated: vi.fn() });
    await expect(
      executor.execute({ connectionId: '_ktx_federated', connection: undefined, sql: 'select 1' }),
    ).rejects.toThrow(/2 attach-compatible/i);
  });
});
