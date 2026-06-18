import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { buildDefaultKtxProjectConfig } from '../../../src/context/project/config.js';
import type { GitService } from '../../../src/context/core/git.service.js';
import { LocalGitFileStore } from '../../../src/context/project/local-git-file-store.js';
import type { KtxLocalProject } from '../../../src/context/project/project.js';
import { loadLocalSlSourceRecords } from '../../../src/context/sl/local-sl.js';

const BOOKS_MANIFEST = `tables:
  books:
    table: public.books
    columns:
      - name: book_id
        type: number
        pk: true
      - name: title
        type: string
`;

const REVIEWS_MANIFEST = `tables:
  reviews:
    table: main.reviews
    columns:
      - name: review_id
        type: number
        pk: true
      - name: rating
        type: number
`;

// Build a project backed only by an on-disk file store (no git init, no
// commit), so the fixture never hits the gpg-signing path during init.
function fakeProject(projectDir: string, connections: KtxLocalProject['config']['connections']): KtxLocalProject {
  const fileStore = new LocalGitFileStore({ rootDir: projectDir, git: {} as GitService });
  const config = { ...buildDefaultKtxProjectConfig(), connections };
  return {
    projectDir,
    configPath: join(projectDir, 'ktx.yaml'),
    config,
    coreConfig: {} as KtxLocalProject['coreConfig'],
    git: {} as GitService,
    fileStore,
  };
}

// `skipLock: true` writes the file to disk without committing, avoiding git.
async function seedManifest(project: KtxLocalProject, path: string, content: string): Promise<void> {
  await project.fileStore.writeFile(path, content, 'ktx', 'ktx@example.com', 'seed manifest', { skipLock: true });
}

describe('federated semantic-layer source loading', () => {
  let tempDir: string;
  let project: KtxLocalProject;
  let singleMemberProject: KtxLocalProject;

  beforeEach(async () => {
    tempDir = await mkdtemp(join(tmpdir(), 'ktx-local-sl-fed-'));

    project = fakeProject(join(tempDir, 'project'), {
      pg_books: { driver: 'postgres' },
      sqlite_reviews: { driver: 'sqlite' },
    });
    await seedManifest(project, 'semantic-layer/pg_books/_schema/public.yaml', BOOKS_MANIFEST);
    await seedManifest(project, 'semantic-layer/sqlite_reviews/_schema/main.yaml', REVIEWS_MANIFEST);

    singleMemberProject = fakeProject(join(tempDir, 'single'), {
      pg_books: { driver: 'postgres' },
    });
    await seedManifest(singleMemberProject, 'semantic-layer/pg_books/_schema/public.yaml', BOOKS_MANIFEST);
  });

  afterEach(async () => {
    await rm(tempDir, { recursive: true, force: true });
  });

  it('namespaces member source records by connection id for _ktx_federated', async () => {
    const records = await loadLocalSlSourceRecords(project, { connectionId: '_ktx_federated' });
    const names = records.map((r) => r.source.name).sort();
    expect(names).toEqual(['pg_books.books', 'sqlite_reviews.reviews']);
  });

  it('keeps colliding member table names distinct via namespacing', async () => {
    const collide = fakeProject(join(tempDir, 'collide'), {
      pg_a: { driver: 'postgres' },
      sqlite_b: { driver: 'sqlite' },
    });
    const usersManifest = `tables:\n  users:\n    table: public.users\n    columns:\n      - name: id\n        type: number\n`;
    await seedManifest(collide, 'semantic-layer/pg_a/_schema/public.yaml', usersManifest);
    await seedManifest(collide, 'semantic-layer/sqlite_b/_schema/main.yaml', usersManifest);
    const records = await loadLocalSlSourceRecords(collide, { connectionId: '_ktx_federated' });
    expect(records.map((r) => r.source.name).sort()).toEqual(['pg_a.users', 'sqlite_b.users']);
  });

  it('tags member records with the virtual federated connection id so reads round-trip', async () => {
    const records = await loadLocalSlSourceRecords(project, { connectionId: '_ktx_federated' });
    // The federated connection owns no directory and is addressed by one virtual
    // id; the member-prefixed names (asserted above) prove the union read from
    // member dirs, so the (connectionId, name) pair resolves back via `sl read`.
    expect(records.map((r) => r.connectionId)).toEqual(['_ktx_federated', '_ktx_federated']);
  });

  it('returns empty for _ktx_federated when fewer than 2 compatible members', async () => {
    const records = await loadLocalSlSourceRecords(singleMemberProject, { connectionId: '_ktx_federated' });
    expect(records).toEqual([]);
  });
});
