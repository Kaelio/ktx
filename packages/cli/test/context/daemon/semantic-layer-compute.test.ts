import { once } from 'node:events';
import { createServer } from 'node:http';
import { describe, expect, it, vi } from 'vitest';
import { createHttpSemanticLayerComputePort, createPythonSemanticLayerComputePort } from '../../../src/context/daemon/semantic-layer-compute.js';
import { KtxExpectedError } from '../../../src/errors.js';

const exitingCommand = (code: number, stderr: string) => ({
  command: process.execPath,
  args: [
    '-e',
    `process.stdin.on('data',()=>{});process.stdin.on('end',()=>{process.stderr.write(${JSON.stringify(stderr)});process.exit(${code})});`,
  ],
});

async function rejection(promise: Promise<unknown>): Promise<unknown> {
  return promise.then(
    () => {
      throw new Error('expected rejection');
    },
    (error) => error,
  );
}

const source = {
  name: 'orders',
  table: 'public.orders',
  grain: ['id'],
  columns: [{ name: 'id', type: 'number' }],
  joins: [],
  measures: [{ name: 'order_count', expr: 'count(*)' }],
};

const sourceGenerationInput = {
  tables: [
    {
      name: 'orders',
      db: 'public',
      comment: 'Orders table',
      columns: [
        { name: 'id', type: 'integer', primaryKey: true, nullable: false, comment: 'Order ID' },
        { name: 'customer_id', type: 'integer' },
        { name: 'amount', type: 'decimal', comment: 'Order amount' },
      ],
    },
    {
      name: 'customers',
      db: 'public',
      columns: [
        { name: 'id', type: 'integer', primaryKey: true },
        { name: 'email', type: 'varchar' },
      ],
    },
  ],
  links: [
    {
      fromTable: 'orders',
      fromColumn: 'customer_id',
      toTable: 'customers',
      toColumn: 'id',
      relationshipType: 'MANY_TO_ONE',
    },
  ],
  dialect: 'postgres',
};

const sourceGenerationDaemonPayload = {
  tables: [
    {
      name: 'orders',
      db: 'public',
      comment: 'Orders table',
      columns: [
        { name: 'id', type: 'integer', primary_key: true, nullable: false, comment: 'Order ID' },
        { name: 'customer_id', type: 'integer' },
        { name: 'amount', type: 'decimal', comment: 'Order amount' },
      ],
    },
    {
      name: 'customers',
      db: 'public',
      columns: [
        { name: 'id', type: 'integer', primary_key: true },
        { name: 'email', type: 'varchar' },
      ],
    },
  ],
  links: [
    {
      from_table: 'orders',
      from_column: 'customer_id',
      to_table: 'customers',
      to_column: 'id',
      relationship_type: 'MANY_TO_ONE',
    },
  ],
  dialect: 'postgres',
};

const sourceGenerationDaemonResponse = {
  source_count: 2,
  sources: [
    {
      name: 'orders',
      table: 'public.orders',
      grain: ['id'],
      columns: [{ name: 'id', type: 'number' }],
      joins: [
        {
          to: 'customers',
          on: 'customer_id = customers.id',
          relationship: 'many_to_one',
        },
      ],
      measures: [{ name: 'record_count', expr: 'count(id)' }],
    },
  ],
};

describe('createPythonSemanticLayerComputePort', () => {
  it('calls the semantic-query stdio command', async () => {
    const runJson = vi.fn(async () => ({
      sql: 'select count(*) from public.orders',
      dialect: 'postgres',
      columns: [{ name: 'orders.order_count' }],
      plan: { sources_used: ['orders'] },
    }));
    const port = createPythonSemanticLayerComputePort({
      runJson,
      projectId: 'hashed-project-id',
    });

    await expect(
      port.query({
        sources: [source],
        dialect: 'postgres',
        query: { measures: ['orders.order_count'], dimensions: [] },
      }),
    ).resolves.toEqual({
      sql: 'select count(*) from public.orders',
      dialect: 'postgres',
      columns: [{ name: 'orders.order_count' }],
      plan: { sources_used: ['orders'] },
    });

    expect(runJson).toHaveBeenCalledWith('semantic-query', {
      sources: [source],
      dialect: 'postgres',
      query: { measures: ['orders.order_count'], dimensions: [] },
      projectId: 'hashed-project-id',
    });
  });

  it('calls the semantic-validate stdio command', async () => {
    const runJson = vi.fn(async () => ({
      valid: true,
      errors: [],
      warnings: [],
      per_source_warnings: {},
    }));
    const port = createPythonSemanticLayerComputePort({ runJson });

    await expect(
      port.validateSources({
        sources: [source],
        dialect: 'postgres',
        recentlyTouched: ['orders'],
      }),
    ).resolves.toEqual({
      valid: true,
      errors: [],
      warnings: [],
      perSourceWarnings: {},
    });

    expect(runJson).toHaveBeenCalledWith('semantic-validate', {
      sources: [source],
      dialect: 'postgres',
      recently_touched: ['orders'],
    });
  });

  it('calls the semantic-generate-sources stdio command', async () => {
    const runJson = vi.fn(async () => sourceGenerationDaemonResponse);
    const port = createPythonSemanticLayerComputePort({ runJson });

    await expect(port.generateSources(sourceGenerationInput)).resolves.toEqual({
      sourceCount: 2,
      sources: sourceGenerationDaemonResponse.sources,
    });

    expect(runJson).toHaveBeenCalledWith('semantic-generate-sources', sourceGenerationDaemonPayload);
  });

  it('classifies a daemon request-rejection exit code as an expected error', async () => {
    const port = createPythonSemanticLayerComputePort(exitingCommand(3, "Measure 'x' is ambiguous"));

    const error = await rejection(
      port.query({ sources: [source], dialect: 'postgres', query: { measures: ['orders.order_count'], dimensions: [] } }),
    );

    expect(error).toBeInstanceOf(KtxExpectedError);
    expect((error as Error).message).toContain("Measure 'x' is ambiguous");
  });

  it('classifies a daemon fault exit code as a plain error', async () => {
    const port = createPythonSemanticLayerComputePort(exitingCommand(1, 'ModuleNotFoundError: pydantic_core'));

    const error = await rejection(
      port.query({ sources: [source], dialect: 'postgres', query: { measures: ['orders.order_count'], dimensions: [] } }),
    );

    expect(error).toBeInstanceOf(Error);
    expect(error).not.toBeInstanceOf(KtxExpectedError);
  });
});

describe('createHttpSemanticLayerComputePort', () => {
  it('calls semantic query and validate HTTP endpoints through an injected runner', async () => {
    const requestJson = vi.fn(async (path: string) => {
      if (path === '/semantic-layer/query') {
        return {
          sql: 'select count(*) from public.orders',
          dialect: 'postgres',
          columns: [{ name: 'orders.order_count' }],
          plan: { sources_used: ['orders'] },
        };
      }
      return {
        valid: true,
        errors: [],
        warnings: [],
        per_source_warnings: {},
      };
    });
    const port = createHttpSemanticLayerComputePort({ baseUrl: 'http://127.0.0.1:8765/', requestJson });

    await expect(
      port.query({
        sources: [source],
        dialect: 'postgres',
        query: { measures: ['orders.order_count'], dimensions: [] },
      }),
    ).resolves.toEqual({
      sql: 'select count(*) from public.orders',
      dialect: 'postgres',
      columns: [{ name: 'orders.order_count' }],
      plan: { sources_used: ['orders'] },
    });

    await expect(
      port.validateSources({
        sources: [source],
        dialect: 'postgres',
        recentlyTouched: ['orders'],
      }),
    ).resolves.toEqual({
      valid: true,
      errors: [],
      warnings: [],
      perSourceWarnings: {},
    });

    expect(requestJson).toHaveBeenNthCalledWith(1, '/semantic-layer/query', {
      sources: [source],
      dialect: 'postgres',
      query: { measures: ['orders.order_count'], dimensions: [] },
    });
    expect(requestJson).toHaveBeenNthCalledWith(2, '/semantic-layer/validate', {
      sources: [source],
      dialect: 'postgres',
      recently_touched: ['orders'],
    });
  });

  it('calls the semantic source-generation HTTP endpoint through an injected runner', async () => {
    const requestJson = vi.fn(async () => sourceGenerationDaemonResponse);
    const port = createHttpSemanticLayerComputePort({ baseUrl: 'http://127.0.0.1:8765/', requestJson });

    await expect(port.generateSources(sourceGenerationInput)).resolves.toEqual({
      sourceCount: 2,
      sources: sourceGenerationDaemonResponse.sources,
    });

    expect(requestJson).toHaveBeenCalledWith('/semantic-layer/generate-sources', sourceGenerationDaemonPayload);
  });

  it('posts JSON to a running HTTP daemon endpoint', async () => {
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
        response.end(
          JSON.stringify({
            sql: 'select count(*) from public.orders',
            dialect: 'postgres',
            columns: [{ name: 'orders.order_count' }],
            plan: { sources_used: ['orders'] },
          }),
        );
      });
    });

    server.listen(0, '127.0.0.1');
    await once(server, 'listening');
    try {
      const address = server.address();
      if (!address || typeof address === 'string') {
        throw new Error('expected TCP server address');
      }
      const port = createHttpSemanticLayerComputePort({ baseUrl: `http://127.0.0.1:${address.port}` });

      await expect(
        port.query({
          sources: [source],
          dialect: 'postgres',
          query: { measures: ['orders.order_count'], dimensions: [] },
        }),
      ).resolves.toMatchObject({
        sql: 'select count(*) from public.orders',
        dialect: 'postgres',
      });

      expect(requests).toEqual([
        {
          url: '/semantic-layer/query',
          body: {
            sources: [source],
            dialect: 'postgres',
            query: { measures: ['orders.order_count'], dimensions: [] },
          },
        },
      ]);
    } finally {
      server.close();
    }
  });

  it('posts source-generation JSON to a running HTTP daemon endpoint', async () => {
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
        response.end(JSON.stringify(sourceGenerationDaemonResponse));
      });
    });

    server.listen(0, '127.0.0.1');
    await once(server, 'listening');
    try {
      const address = server.address();
      if (!address || typeof address === 'string') {
        throw new Error('expected TCP server address');
      }
      const port = createHttpSemanticLayerComputePort({ baseUrl: `http://127.0.0.1:${address.port}` });

      await expect(port.generateSources(sourceGenerationInput)).resolves.toEqual({
        sourceCount: 2,
        sources: sourceGenerationDaemonResponse.sources,
      });

      expect(requests).toEqual([
        {
          url: '/semantic-layer/generate-sources',
          body: sourceGenerationDaemonPayload,
        },
      ]);
    } finally {
      server.close();
    }
  });

  it('classifies an HTTP 400 request rejection as an expected error', async () => {
    const server = createServer((_request, response) => {
      response.writeHead(400, { 'content-type': 'application/json' });
      response.end(JSON.stringify({ detail: "Measure 'x' is ambiguous" }));
    });
    server.listen(0, '127.0.0.1');
    await once(server, 'listening');
    try {
      const address = server.address();
      if (!address || typeof address === 'string') {
        throw new Error('expected TCP server address');
      }
      const port = createHttpSemanticLayerComputePort({ baseUrl: `http://127.0.0.1:${address.port}` });
      const error = await rejection(
        port.query({ sources: [source], dialect: 'postgres', query: { measures: ['orders.order_count'], dimensions: [] } }),
      );
      expect(error).toBeInstanceOf(KtxExpectedError);
    } finally {
      server.close();
    }
  });

  it('classifies an HTTP 500 fault as a plain error', async () => {
    const server = createServer((_request, response) => {
      response.writeHead(500, { 'content-type': 'application/json' });
      response.end(JSON.stringify({ detail: 'boom' }));
    });
    server.listen(0, '127.0.0.1');
    await once(server, 'listening');
    try {
      const address = server.address();
      if (!address || typeof address === 'string') {
        throw new Error('expected TCP server address');
      }
      const port = createHttpSemanticLayerComputePort({ baseUrl: `http://127.0.0.1:${address.port}` });
      const error = await rejection(
        port.query({ sources: [source], dialect: 'postgres', query: { measures: ['orders.order_count'], dimensions: [] } }),
      );
      expect(error).toBeInstanceOf(Error);
      expect(error).not.toBeInstanceOf(KtxExpectedError);
    } finally {
      server.close();
    }
  });
});
