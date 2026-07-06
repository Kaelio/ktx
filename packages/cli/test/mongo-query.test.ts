import { describe, expect, it, vi } from 'vitest';
import { runKtxMongoQuery } from '../src/mongo-query.js';
import { KtxMongoDbScanConnector } from '../src/connectors/mongodb/connector.js';
import type { KtxCliIo } from '../src/cli-runtime.js';
import type { KtxLocalProject } from '../src/context/project/project.js';

function captureIo(): { io: KtxCliIo; out: () => string; err: () => string } {
  let out = '';
  let err = '';
  const io = {
    stdout: { write: (s: string) => { out += s; return true; }, isTTY: false },
    stderr: { write: (s: string) => { err += s; return true; } },
  } as unknown as KtxCliIo;
  return { io, out: () => out, err: () => err };
}

function mongoConnector(): KtxMongoDbScanConnector {
  return new KtxMongoDbScanConnector({
    connectionId: 'mongo',
    connection: { driver: 'mongodb', url: 'mongodb://localhost:27017/app', databases: ['app'] },
    clientFactory: {
      create: () => ({
        listCollections: vi.fn(async () => []),
        estimatedDocumentCount: vi.fn(async () => 0),
        find: vi.fn(async () => []),
        aggregate: vi.fn(async () => [{ _id: 'a1', city: 'Indianapolis' }, { _id: 'a2', city: 'Indianapolis' }]),
        ping: vi.fn(async () => undefined),
        close: vi.fn(async () => undefined),
      }),
    },
  });
}

const project = {
  projectDir: '/tmp/ktx',
  config: { connections: { mongo: { driver: 'mongodb', url: 'mongodb://localhost:27017/app', databases: ['app'] } } },
} as unknown as KtxLocalProject;

const baseArgs = {
  projectDir: '/tmp/ktx',
  connectionId: 'mongo',
  collection: 'business',
  pipeline: [{ $match: { city: 'Indianapolis' } }],
  limit: 100,
  cliVersion: '0.0.0-test',
};

describe('runKtxMongoQuery', () => {
  it('prints rows in plain mode and returns exit code 0', async () => {
    const { io, out } = captureIo();
    const code = await runKtxMongoQuery({ ...baseArgs, output: 'plain' }, io, {
      loadProject: async () => project,
      createScanConnector: (async () => mongoConnector()) as never,
    });
    expect(code).toBe(0);
    expect(out()).toContain('_id\tcity');
    expect(out()).toContain('a1\tIndianapolis');
  });

  it('returns exit code 1 and writes the error message for an unconfigured connection', async () => {
    const { io, err } = captureIo();
    const code = await runKtxMongoQuery({ ...baseArgs, connectionId: 'nope' }, io, {
      loadProject: async () => project,
      createScanConnector: (async () => mongoConnector()) as never,
    });
    expect(code).toBe(1);
    expect(err().length).toBeGreaterThan(0);
  });
});
