import { describe, expect, it, vi } from 'vitest';
import { HistoricSqlGrantsMissingError } from '../../../../src/context/ingest/adapters/historic-sql/errors.js';
import { BigQueryJobsByProjectProbeRunner } from '../../../../src/context/ingest/historic-sql-probes/bigquery-runner.js';

describe('BigQueryJobsByProjectProbeRunner', () => {
  it('creates a region-scoped reader, runs it, and cleans up the connector', async () => {
    const cleanup = vi.fn(async () => undefined);
    const reader = {
      probe: vi.fn(async () => ({ warnings: [], info: ['region: eu'] })),
    };
    const createReader = vi.fn(() => reader);
    const runner = new BigQueryJobsByProjectProbeRunner({
      createReader,
      createClient: () => ({ client: { executeQuery: vi.fn() }, cleanup }),
    });

    await expect(
      runner.run({
        projectDir: '/work/project',
        connectionId: 'bq',
        connection: {
          driver: 'bigquery',
          project_id: 'project-1',
          location: 'EU',
        },
        env: {},
      }),
    ).resolves.toEqual({ warnings: [], info: ['region: eu'] });
    expect(createReader).toHaveBeenCalledWith({ projectId: 'project-1', region: 'EU' });
    expect(reader.probe).toHaveBeenCalledOnce();
    expect(cleanup).toHaveBeenCalledOnce();
  });

  it('uses us as the default BigQuery region', async () => {
    const createReader = vi.fn(() => ({
      probe: vi.fn(async () => ({ warnings: [], info: [] })),
    }));
    const runner = new BigQueryJobsByProjectProbeRunner({
      createReader,
      createClient: () => ({ client: {}, cleanup: vi.fn(async () => undefined) }),
    });

    await runner.run({
      projectDir: '/work/project',
      connectionId: 'bq',
      connection: {
        driver: 'bigquery',
        project_id: 'project-1',
      },
      env: {},
    });

    expect(createReader).toHaveBeenCalledWith({ projectId: 'project-1', region: 'us' });
  });

  it('rejects a missing BigQuery project_id', async () => {
    const runner = new BigQueryJobsByProjectProbeRunner({
      createReader: vi.fn(),
      createClient: () => ({ client: {}, cleanup: vi.fn() }),
    });

    await expect(
      runner.run({
        projectDir: '/work/project',
        connectionId: 'bq',
        connection: {
          driver: 'bigquery',
        },
        env: {},
      }),
    ).rejects.toThrow('connections.bq.project_id');
  });

  it('formats successful BigQuery details', () => {
    const runner = new BigQueryJobsByProjectProbeRunner();

    expect(
      runner.formatSuccessDetail({
        warnings: ['JOBS_BY_PROJECT is delayed'],
        info: ['region: us'],
      }),
    ).toEqual({
      detail: 'INFORMATION_SCHEMA.JOBS_BY_PROJECT ready; region: us',
      warnings: ['JOBS_BY_PROJECT is delayed'],
    });
  });

  it('maps BigQuery grant errors to runner advice', () => {
    const runner = new BigQueryJobsByProjectProbeRunner();

    expect(
      runner.fixAdvice(
        new HistoricSqlGrantsMissingError({
          dialect: 'bigquery',
          message: 'principal cannot query JOBS_BY_PROJECT',
          remediation:
            'Grant roles/bigquery.resourceViewer on the BigQuery project, or grant a custom role containing bigquery.jobs.listAll.',
        }),
      ),
    ).toEqual({
      failHeadline: 'BigQuery principal cannot read INFORMATION_SCHEMA.JOBS_BY_PROJECT',
      remediation:
        'Grant roles/bigquery.resourceViewer on the BigQuery project, or grant a custom role containing bigquery.jobs.listAll.',
    });
  });
});
