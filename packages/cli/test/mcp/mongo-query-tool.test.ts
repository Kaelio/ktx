import { describe, expect, it, vi } from 'vitest';
import { KtxExpectedError } from '../../src/errors.js';
import { KtxMongoDbScanConnector } from '../../src/connectors/mongodb/connector.js';
import { createLocalProjectMcpContextPorts } from '../../src/context/mcp/local-project-ports.js';
import type { KtxLocalProject } from '../../src/context/project/project.js';
import type { KtxScanConnector } from '../../src/context/scan/types.js';

const MONGO_DOCS = [
  { _id: 'a1', city: 'Indianapolis' },
  { _id: 'a2', city: 'Indianapolis' },
];

function mongoConnector(): KtxMongoDbScanConnector {
  return new KtxMongoDbScanConnector({
    connectionId: 'mongo',
    connection: { driver: 'mongodb', url: 'mongodb://localhost:27017/app', databases: ['app'] },
    clientFactory: {
      create: () => ({
        listCollections: vi.fn(async () => []),
        estimatedDocumentCount: vi.fn(async () => 0),
        find: vi.fn(async () => []),
        aggregate: vi.fn(async () => MONGO_DOCS),
        ping: vi.fn(async () => undefined),
        close: vi.fn(async () => undefined),
      }),
    },
  });
}

function project(): KtxLocalProject {
  return {
    projectDir: '/tmp/ktx',
    config: {
      connections: {
        mongo: { driver: 'mongodb', url: 'mongodb://localhost:27017/app', databases: ['app'] },
        warehouse: { driver: 'postgres' },
      },
    },
  } as unknown as KtxLocalProject;
}

function warehouseConnector(): KtxScanConnector {
  return {
    id: 'postgres:warehouse',
    driver: 'postgres',
    capabilities: { structuralIntrospection: true } as KtxScanConnector['capabilities'],
    introspect: vi.fn(),
    listSchemas: vi.fn(async () => []),
    listTables: vi.fn(async () => []),
  } as unknown as KtxScanConnector;
}

function portsFor(createConnector: (id: string) => KtxScanConnector) {
  return createLocalProjectMcpContextPorts(project(), {
    embeddingService: null,
    localScan: { createConnector } as never,
  });
}

describe('mongoQuery MCP port', () => {
  it('fetches real rows from a mongodb connection', async () => {
    const ports = portsFor(() => mongoConnector());
    const result = await ports.mongoQuery!.execute({
      connectionId: 'mongo',
      collection: 'business',
      pipeline: [{ $match: { city: 'Indianapolis' } }],
      limit: 100,
    });
    expect(result.headers).toEqual(['_id', 'city']);
    expect(result.rowCount).toBe(2);
  });

  it('rejects a non-mongodb connection id with an expected error naming the wrong driver', async () => {
    const ports = portsFor((id) => (id === 'mongo' ? mongoConnector() : warehouseConnector()));
    await expect(
      ports.mongoQuery!.execute({ connectionId: 'warehouse', collection: 'x', pipeline: [], limit: 10 }),
    ).rejects.toThrow(/is not a MongoDB connection/);
    await expect(
      ports.mongoQuery!.execute({ connectionId: 'warehouse', collection: 'x', pipeline: [], limit: 10 }),
    ).rejects.toBeInstanceOf(KtxExpectedError);
  });
});
