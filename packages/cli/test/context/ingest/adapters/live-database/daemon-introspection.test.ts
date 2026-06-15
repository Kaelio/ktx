import { once } from 'node:events';
import { createServer } from 'node:http';
import { describe, expect, it, vi } from 'vitest';
import { tableRefSet } from '../../../../../src/context/scan/table-ref.js';
import { createDaemonLiveDatabaseIntrospection } from '../../../../../src/context/ingest/adapters/live-database/daemon-introspection.js';

const daemonResponse = {
  connection_id: 'warehouse',
  extracted_at: '2026-04-28T10:00:00+00:00',
  metadata: { driver: 'postgres', schemas: ['public'] },
  tables: [
    {
      catalog: 'warehouse',
      db: 'public',
      name: 'customers',
      comment: null,
      columns: [{ name: 'id', type: 'integer', nullable: false, primary_key: true, comment: null }],
      foreign_keys: [],
    },
    {
      catalog: 'warehouse',
      db: 'public',
      name: 'orders',
      comment: 'Order facts',
      columns: [
        { name: 'id', type: 'integer', nullable: false, primary_key: true, comment: 'Order id' },
        { name: 'customer_id', type: 'integer', nullable: false, primary_key: false, comment: null },
      ],
      foreign_keys: [
        {
          from_column: 'customer_id',
          to_table: 'customers',
          to_column: 'id',
          constraint_name: 'orders_customer_id_fkey',
        },
      ],
    },
  ],
};

describe('createDaemonLiveDatabaseIntrospection', () => {
  it('calls the database-introspect daemon command and maps the snapshot response', async () => {
    const runJson = vi.fn(async () => daemonResponse);
    const introspection = createDaemonLiveDatabaseIntrospection({
      connections: {
        warehouse: {
          driver: 'postgres',
          url: 'postgres://localhost:5432/warehouse',
        },
      },
      schemas: ['public'],
      runJson,
    });

    await expect(introspection.extractSchema('warehouse')).resolves.toEqual({
      connectionId: 'warehouse',
      driver: 'postgres',
      extractedAt: '2026-04-28T10:00:00+00:00',
      scope: { schemas: ['public'] },
      metadata: { driver: 'postgres', schemas: ['public'] },
      tables: [
        {
          catalog: 'warehouse',
          db: 'public',
          name: 'customers',
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
        {
          catalog: 'warehouse',
          db: 'public',
          name: 'orders',
          kind: 'table',
          comment: 'Order facts',
          estimatedRows: null,
          columns: [
            {
              name: 'id',
              nativeType: 'integer',
              normalizedType: 'integer',
              dimensionType: 'number',
              nullable: false,
              primaryKey: true,
              comment: 'Order id',
            },
            {
              name: 'customer_id',
              nativeType: 'integer',
              normalizedType: 'integer',
              dimensionType: 'number',
              nullable: false,
              primaryKey: false,
              comment: null,
            },
          ],
          foreignKeys: [
            {
              fromColumn: 'customer_id',
              toCatalog: null,
              toDb: null,
              toTable: 'customers',
              toColumn: 'id',
              constraintName: 'orders_customer_id_fkey',
            },
          ],
        },
      ],
    });

    expect(runJson).toHaveBeenCalledWith('database-introspect', {
      connection_id: 'warehouse',
      driver: 'postgres',
      url: 'postgres://localhost:5432/warehouse',
      schemas: ['public'],
      statement_timeout_ms: 30_000,
      connection_timeout_seconds: 5,
    });
  });

  it('maps daemon warnings into the snapshot and drops codes Node cannot render', async () => {
    const runJson = vi.fn(async () => ({
      ...daemonResponse,
      tables: [],
      warnings: [
        {
          code: 'object_introspection_failed',
          message: 'permission denied for relation locked',
          table: 'locked',
          recoverable: true,
          metadata: { object: 'public.locked' },
        },
        { code: 'totally_unknown_code', message: 'ignored', recoverable: true },
      ],
    }));
    const introspection = createDaemonLiveDatabaseIntrospection({
      connections: { warehouse: { driver: 'postgres', url: 'postgres://localhost:5432/warehouse' } },
      schemas: ['public'],
      runJson,
    });

    const snapshot = await introspection.extractSchema('warehouse');
    expect(snapshot.warnings).toEqual([
      {
        code: 'object_introspection_failed',
        message: 'permission denied for relation locked',
        table: 'locked',
        recoverable: true,
        metadata: { object: 'public.locked' },
      },
    ]);
  });

  it('calls a running daemon HTTP endpoint when baseUrl is configured', async () => {
    const requests: Array<{ url: string | undefined; body: unknown }> = [];
    const server = createServer((request, response) => {
      const chunks: Buffer[] = [];
      request.on('data', (chunk: Buffer) => chunks.push(chunk));
      request.on('end', () => {
        requests.push({
          url: request.url,
          body: JSON.parse(Buffer.concat(chunks).toString('utf8')),
        });
        response.writeHead(200, { 'content-type': 'application/json' });
        response.end(JSON.stringify(daemonResponse));
      });
    });

    server.listen(0, '127.0.0.1');
    await once(server, 'listening');
    try {
      const address = server.address();
      if (!address || typeof address === 'string') {
        throw new Error('expected TCP server address');
      }
      const introspection = createDaemonLiveDatabaseIntrospection({
        connections: {
          warehouse: {
            driver: 'postgres',
            url: 'postgres://localhost:5432/warehouse',
          },
        },
        baseUrl: `http://127.0.0.1:${address.port}`,
      });

      await expect(
        introspection.extractSchema('warehouse', {
          tableScope: tableRefSet([{ catalog: 'warehouse', db: 'public', name: 'orders' }]),
        }),
      ).resolves.toMatchObject({
        connectionId: 'warehouse',
        tables: [{ name: 'customers' }, { name: 'orders' }],
      });

      expect(requests).toEqual([
        {
          url: '/database/introspect',
          body: {
            connection_id: 'warehouse',
            driver: 'postgres',
            url: 'postgres://localhost:5432/warehouse',
            schemas: ['public'],
            statement_timeout_ms: 30_000,
            connection_timeout_seconds: 5,
            table_scope: [{ catalog: 'warehouse', db: 'public', name: 'orders' }],
          },
        },
      ]);
    } finally {
      server.close();
    }
  });

  it('requires a configured postgres connection with a url', async () => {
    const introspection = createDaemonLiveDatabaseIntrospection({
      connections: {
        warehouse: {
          driver: 'postgres',
        },
      },
      runJson: vi.fn(async () => daemonResponse),
    });

    await expect(introspection.extractSchema('warehouse')).rejects.toThrow(
      'Local live-database ingest requires connections.warehouse.url.',
    );
  });

  it('rejects unsupported local connection drivers before calling the daemon', async () => {
    const runJson = vi.fn(async () => daemonResponse);
    const introspection = createDaemonLiveDatabaseIntrospection({
      connections: {
        warehouse: {
          driver: 'snowflake',
          url: 'snowflake://example',
        },
      },
      runJson,
    });

    await expect(introspection.extractSchema('warehouse')).rejects.toThrow(
      'Local live-database ingest cannot run driver "snowflake".',
    );
    expect(runJson).not.toHaveBeenCalled();
  });

  it('does not use connection enabled_tables as a response filter', async () => {
    const runJson = vi.fn(async () => daemonResponse);
    const introspection = createDaemonLiveDatabaseIntrospection({
      connections: {
        warehouse: {
          driver: 'postgres',
          url: 'postgres://localhost:5432/warehouse',
          enabled_tables: ['public.orders'],
        },
      },
      schemas: ['public'],
      runJson,
    });

    const snapshot = await introspection.extractSchema('warehouse');
    expect(snapshot.tables.map((table) => `${table.db}.${table.name}`)).toEqual(['public.customers', 'public.orders']);
    expect(runJson).toHaveBeenCalledWith('database-introspect', expect.not.objectContaining({ table_scope: expect.anything() }));
  });

  it('passes through every table when enabled_tables is omitted or empty', async () => {
    const runJson = vi.fn(async () => daemonResponse);
    const introspection = createDaemonLiveDatabaseIntrospection({
      connections: {
        warehouse: {
          driver: 'postgres',
          url: 'postgres://localhost:5432/warehouse',
          enabled_tables: [],
        },
      },
      schemas: ['public'],
      runJson,
    });

    const snapshot = await introspection.extractSchema('warehouse');
    expect(snapshot.tables.map((table) => table.name)).toEqual(['customers', 'orders']);
  });
});
