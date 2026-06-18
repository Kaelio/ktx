import { describe, expect, it, vi } from 'vitest';
import type { KtxSemanticLayerComputePort } from '../../../src/context/daemon/semantic-layer-compute.js';
import type { KtxLocalProject } from '../../../src/context/project/project.js';
import { compileLocalSlQuery } from '../../../src/context/sl/local-query.js';

function makeFakeProject(): KtxLocalProject {
  const fileStore = {
    listFiles: vi.fn(async () => ({ files: [] })),
    readFile: vi.fn(async () => ({ content: '' })),
    writeFile: vi.fn(async () => ({})),
    deleteFile: vi.fn(async () => ({})),
    fileHistory: vi.fn(async () => []),
    headCommit: vi.fn(async () => null),
  } as unknown as KtxLocalProject['fileStore'];

  return {
    projectDir: '/tmp/fake-ktx-project',
    configPath: '/tmp/fake-ktx-project/ktx.yaml',
    config: {
      connections: {
        pg_books: { driver: 'postgres' },
        sqlite_reviews: { driver: 'sqlite' },
      },
      storage: { state: 'sqlite', search: 'sqlite-fts5', git: {} },
      llm: {},
      ingest: {},
      agent: {},
      scan: {},
    } as unknown as KtxLocalProject['config'],
    coreConfig: {} as KtxLocalProject['coreConfig'],
    git: {} as KtxLocalProject['git'],
    fileStore,
  };
}

function makeFakeProjectWithFiles(
  connections: Record<string, { driver: string }>,
  files: Record<string, string>,
): KtxLocalProject {
  const fileStore = {
    listFiles: vi.fn(async (dir: string) => ({
      files: Object.keys(files).filter((path) => path.startsWith(`${dir}/`)),
    })),
    readFile: vi.fn(async (path: string) => ({ content: files[path] ?? '' })),
    writeFile: vi.fn(async () => ({})),
    deleteFile: vi.fn(async () => ({})),
    fileHistory: vi.fn(async () => []),
    headCommit: vi.fn(async () => null),
  } as unknown as KtxLocalProject['fileStore'];

  return {
    projectDir: '/tmp/fake-ktx-project',
    configPath: '/tmp/fake-ktx-project/ktx.yaml',
    config: {
      connections,
      storage: { state: 'sqlite', search: 'sqlite-fts5', git: {} },
      llm: {},
      ingest: {},
      agent: {},
      scan: {},
    } as unknown as KtxLocalProject['config'],
    coreConfig: {} as KtxLocalProject['coreConfig'],
    git: {} as KtxLocalProject['git'],
    fileStore,
  };
}

function makeFakeCompute(): KtxSemanticLayerComputePort & {
  lastDialect: string | undefined;
  lastSources: Array<{ name: string; joins?: Array<{ to: string }> }> | undefined;
} {
  const fake = {
    lastDialect: undefined as string | undefined,
    lastSources: undefined as Array<{ name: string; joins?: Array<{ to: string }> }> | undefined,
    query: vi.fn(async (input: { dialect: string; query: unknown; sources: unknown[] }) => {
      fake.lastDialect = input.dialect;
      fake.lastSources = input.sources as Array<{ name: string; joins?: Array<{ to: string }> }>;
      return {
        sql: 'select 1',
        dialect: input.dialect,
        columns: [],
        plan: { measures: [], dimensions: [] },
      };
    }),
    validateSources: vi.fn(),
    generateSources: vi.fn(),
  };
  return fake;
}

describe('compileLocalSlQuery — federated connection', () => {
  it('rejects federated queries and points to raw SQL', async () => {
    const project = makeFakeProject();
    const compute = makeFakeCompute();

    await expect(
      compileLocalSlQuery(project, {
        connectionId: '_ktx_federated',
        query: { measures: [], dimensions: [] },
        compute,
        execute: false,
      }),
    ).rejects.toThrow(/_ktx_federated[\s\S]*ktx sql/);
    // The compute adapter must never be invoked for a federated query.
    expect(compute.query).not.toHaveBeenCalled();
  });

  it('still uses the driver dialect for a normal connection', async () => {
    const project = makeFakeProject();
    const compute = makeFakeCompute();

    await compileLocalSlQuery(project, {
      connectionId: 'pg_books',
      query: { measures: [], dimensions: [] },
      compute,
      execute: false,
    });

    expect(compute.lastDialect).toBe('postgres');
  });

  it('drops a cross-connection join target so a member query is not poisoned', async () => {
    // A preserved cross-DB join (to: sqlite_reviews.reviews) would otherwise be
    // an orphan target the planner rejects, breaking every pg_books SL query.
    const manifest = `tables:
  books:
    table: public.books
    columns:
      - name: id
        type: number
        pk: true
      - name: author_id
        type: number
    joins:
      - to: sqlite_reviews.reviews
        on: books.id = reviews.book_id
        relationship: one_to_many
      - to: authors
        on: books.author_id = authors.id
        relationship: many_to_one
  authors:
    table: public.authors
    columns:
      - name: id
        type: number
        pk: true
`;
    const project = makeFakeProjectWithFiles(
      { pg_books: { driver: 'postgres' }, sqlite_reviews: { driver: 'sqlite' } },
      { 'semantic-layer/pg_books/_schema/public.yaml': manifest },
    );
    const compute = makeFakeCompute();

    await compileLocalSlQuery(project, {
      connectionId: 'pg_books',
      query: { measures: [], dimensions: [] },
      compute,
      execute: false,
    });

    expect(compute.query).toHaveBeenCalledTimes(1);
    const books = compute.lastSources?.find((source) => source.name === 'books');
    // The same-connection join survives; only the federated-sibling target is dropped.
    expect(books?.joins?.map((join) => join.to)).toEqual(['authors']);
  });

  it('keeps a same-connection join whose target name collides with another connection id', async () => {
    // Connection ids and source names share a vocabulary, so a sibling connection
    // can be named `authors` while a same-connection source is also `authors`. The
    // join target resolves within the connection and must not be pruned.
    const manifest = `tables:
  books:
    table: public.books
    columns:
      - name: id
        type: number
        pk: true
      - name: author_id
        type: number
    joins:
      - to: authors
        on: books.author_id = authors.id
        relationship: many_to_one
  authors:
    table: public.authors
    columns:
      - name: id
        type: number
        pk: true
`;
    const project = makeFakeProjectWithFiles(
      { pg_books: { driver: 'postgres' }, authors: { driver: 'postgres' } },
      { 'semantic-layer/pg_books/_schema/public.yaml': manifest },
    );
    const compute = makeFakeCompute();

    await compileLocalSlQuery(project, {
      connectionId: 'pg_books',
      query: { measures: [], dimensions: [] },
      compute,
      execute: false,
    });

    const books = compute.lastSources?.find((source) => source.name === 'books');
    expect(books?.joins?.map((join) => join.to)).toEqual(['authors']);
  });
});
