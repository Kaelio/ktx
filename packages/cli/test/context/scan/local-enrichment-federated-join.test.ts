import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import YAML from 'yaml';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { buildDefaultKtxProjectConfig } from '../../../src/context/project/config.js';
import type { GitService } from '../../../src/context/core/git.service.js';
import { LocalGitFileStore } from '../../../src/context/project/local-git-file-store.js';
import type { KtxLocalProject } from '../../../src/context/project/project.js';
import { writeLocalScanManifestShards } from '../../../src/context/scan/local-enrichment-artifacts.js';
import type { KtxSchemaSnapshot } from '../../../src/context/scan/types.js';

// `writeLocalScanManifestShards` commits its output via git; the file is
// already on disk before the commit call, so the stub only returns commit info.
const stubGitCommitFile: Pick<GitService, 'commitFile'> = {
  commitFile: async () => ({
    commitHash: 'stub',
    shortHash: 'stub',
    message: 'stub',
    author: 'ktx',
    authorEmail: 'ktx@example.com',
    timestamp: new Date().toISOString(),
    committedDate: new Date().toISOString(),
    created: true,
  }),
};
const stubGit = stubGitCommitFile as GitService;

function fakeProject(projectDir: string, connections: KtxLocalProject['config']['connections']): KtxLocalProject {
  const fileStore = new LocalGitFileStore({ rootDir: projectDir, git: stubGit });
  return {
    projectDir,
    configPath: join(projectDir, 'ktx.yaml'),
    config: { ...buildDefaultKtxProjectConfig(), connections },
    coreConfig: {} as KtxLocalProject['coreConfig'],
    git: stubGit,
    fileStore,
  };
}

const EXISTING_BOOKS_SHARD = `tables:
  books:
    table: public.books
    columns:
      - name: id
        type: number
        pk: true
    joins:
      - to: sqlite_reviews.reviews
        on: books.id = reviews.book_id
        relationship: one_to_many
        source: manual
`;

const booksSnapshot: KtxSchemaSnapshot = {
  connectionId: 'pg_books',
  driver: 'postgres',
  extractedAt: new Date().toISOString(),
  scope: {},
  metadata: {},
  tables: [
    {
      name: 'books',
      catalog: null,
      db: 'public',
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
  ],
};

describe('writeLocalScanManifestShards federated cross-DB joins', () => {
  let tempDir: string;
  let project: KtxLocalProject;

  beforeEach(async () => {
    tempDir = await mkdtemp(join(tmpdir(), 'ktx-enrich-fed-'));
    project = fakeProject(join(tempDir, 'project'), {
      pg_books: { driver: 'postgres' },
      sqlite_reviews: { driver: 'sqlite' },
    });
    await project.fileStore.writeFile(
      'semantic-layer/pg_books/_schema/public.yaml',
      EXISTING_BOOKS_SHARD,
      'ktx',
      'ktx@example.com',
      'seed',
      { skipLock: true },
    );
    await project.fileStore.writeFile(
      'semantic-layer/sqlite_reviews/_schema/main.yaml',
      'tables:\n  reviews:\n    table: reviews\n    columns:\n      - name: book_id\n        type: number\n',
      'ktx',
      'ktx@example.com',
      'seed',
      { skipLock: true },
    );
  });

  afterEach(async () => {
    await rm(tempDir, { recursive: true, force: true });
  });

  it('preserves a manual cross-DB join to a sqlite sibling across a re-scan', async () => {
    await writeLocalScanManifestShards({
      project,
      connectionId: 'pg_books',
      syncId: 'sync1',
      driver: 'postgres',
      snapshot: booksSnapshot,
      dryRun: false,
    });
    const { content } = await project.fileStore.readFile('semantic-layer/pg_books/_schema/public.yaml');
    const shard = YAML.parse(content) as { tables: Record<string, { joins?: Array<{ to: string }> }> };
    expect(shard.tables.books?.joins?.map((j) => j.to)).toEqual(['sqlite_reviews.reviews']);
  });
});
