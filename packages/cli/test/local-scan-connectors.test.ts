import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { initKtxProject, loadKtxProject } from '../src/context/project/project.js';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { createKtxCliScanConnector } from '../src/local-scan-connectors.js';

const bigQueryMock = vi.hoisted(() => ({
  constructorInputs: [] as Array<{
    connectionId: string;
    connection: unknown;
  }>,
}));

vi.mock('../src/connectors/bigquery/connector.js', () => ({
  isKtxBigQueryConnectionConfig: (connection: { driver?: unknown } | undefined) =>
    String(connection?.driver ?? '').toLowerCase() === 'bigquery',
  KtxBigQueryScanConnector: class {
    readonly id: string;
    readonly driver = 'bigquery';

    constructor(options: { connectionId: string; connection: unknown }) {
      bigQueryMock.constructorInputs.push(options);
      this.id = `bigquery:${options.connectionId}`;
    }
  },
}));

describe('createKtxCliScanConnector', () => {
  let tempDir: string;

  beforeEach(async () => {
    bigQueryMock.constructorInputs.length = 0;
    tempDir = await mkdtemp(join(tmpdir(), 'ktx-cli-scan-connector-'));
  });

  afterEach(async () => {
    await rm(tempDir, { recursive: true, force: true });
  });

  it('creates a native sqlite connector from standalone config', async () => {
    await initKtxProject({ projectDir: tempDir });
    await writeFile(
      join(tempDir, 'ktx.yaml'),
      [
        'connections:',
        '  warehouse:',
        '    driver: sqlite',
        '    path: warehouse.db',
        '',
      ].join('\n'),
      'utf-8',
    );
    const project = await loadKtxProject({ projectDir: tempDir });

    const connector = await createKtxCliScanConnector(project, 'warehouse');

    expect(connector.id).toBe('sqlite:warehouse');
    expect(connector.driver).toBe('sqlite');
  });

  it('passes canonical BigQuery YAML scan limits through to the connector', async () => {
    await initKtxProject({ projectDir: tempDir });
    await writeFile(
      join(tempDir, 'ktx.yaml'),
      [
        'connections:',
        '  warehouse:',
        '    driver: bigquery',
        '    dataset_id: analytics',
        '    max_bytes_billed: "987654321"',
        '    query_timeout_ms: 30000',
        '',
      ].join('\n'),
      'utf-8',
    );
    const project = await loadKtxProject({ projectDir: tempDir });

    const connector = await createKtxCliScanConnector(project, 'warehouse');

    expect(connector.id).toBe('bigquery:warehouse');
    expect(connector.driver).toBe('bigquery');
    expect(bigQueryMock.constructorInputs).toEqual([
      expect.objectContaining({
        connectionId: 'warehouse',
        connection: expect.objectContaining({
          max_bytes_billed: '987654321',
          query_timeout_ms: 30000,
        }),
      }),
    ]);
    expect(bigQueryMock.constructorInputs[0]).not.toHaveProperty('maxBytesBilled');
  });

  it('resolves a duckdb connection to the DuckDB scan connector', async () => {
    await initKtxProject({ projectDir: tempDir });
    await writeFile(
      join(tempDir, 'ktx.yaml'),
      [
        'connections:',
        '  warehouse:',
        '    driver: duckdb',
        '    path: warehouse.duckdb',
        '',
      ].join('\n'),
      'utf-8',
    );
    const project = await loadKtxProject({ projectDir: tempDir });

    const connector = await createKtxCliScanConnector(project, 'warehouse');

    expect(connector.id).toBe('duckdb:warehouse');
    expect(connector.driver).toBe('duckdb');
  });

  it('rejects connection blocks with no driver field at config parse time', async () => {
    await initKtxProject({ projectDir: tempDir });
    await writeFile(
      join(tempDir, 'ktx.yaml'),
      [
        'connections:',
        '  warehouse:',
        '    type: postgres',
        '    url: postgresql://example/db',
        '',
      ].join('\n'),
      'utf-8',
    );

    await expect(loadKtxProject({ projectDir: tempDir })).rejects.toThrow(
      /connections\.warehouse\.driver:.*Invalid discriminator value/,
    );
  });
});
