import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import Database from 'better-sqlite3';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { buildDefaultKtxProjectConfig } from '../../../src/context/project/config.js';
import { executeProjectReadOnlySql } from '../../../src/context/connections/project-sql-executor.js';
import type { GitService } from '../../../src/context/core/git.service.js';
import { LocalGitFileStore } from '../../../src/context/project/local-git-file-store.js';
import type { KtxLocalProject } from '../../../src/context/project/project.js';
import { loadLocalSlSourceRecords } from '../../../src/context/sl/local-sl.js';

const BOOKS_MANIFEST = `tables:
  books:
    table: main.books
    columns:
      - name: id
        type: number
        pk: true
      - name: title
        type: string
`;

const REVIEWS_MANIFEST = `tables:
  reviews:
    table: main.reviews
    columns:
      - name: book_id
        type: number
        pk: true
      - name: stars
        type: number
`;

// On-disk file store only (no git init/commit) so manifest seeding never hits
// the gpg-signing path; connections also carry real sqlite paths so the
// federated executor can attach them.
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

async function seedManifest(project: KtxLocalProject, path: string, content: string): Promise<void> {
  await project.fileStore.writeFile(path, content, 'ktx', 'ktx@example.com', 'seed manifest', { skipLock: true });
}

describe('federated SL source loading and physical execution (real DuckDB)', () => {
  let tempDir: string;

  beforeEach(async () => {
    tempDir = await mkdtemp(join(tmpdir(), 'ktx-local-query-fed-'));
  });

  afterEach(async () => {
    await rm(tempDir, { recursive: true, force: true });
  });

  it('namespaces source names while keeping physical table refs, and executes against them', async () => {
    const projectDir = join(tempDir, 'project');
    const booksPath = join(tempDir, 'books.db');
    const reviewsPath = join(tempDir, 'reviews.db');

    const books = new Database(booksPath);
    books.exec("CREATE TABLE books (id INTEGER, title TEXT); INSERT INTO books VALUES (1, 'Dune'), (2, 'Foundation');");
    books.close();
    const reviews = new Database(reviewsPath);
    reviews.exec('CREATE TABLE reviews (book_id INTEGER, stars INTEGER); INSERT INTO reviews VALUES (1, 5), (1, 4), (2, 2);');
    reviews.close();

    const project = fakeProject(projectDir, {
      sqlite_books: { driver: 'sqlite', path: booksPath },
      sqlite_reviews: { driver: 'sqlite', path: reviewsPath },
    });
    await seedManifest(project, 'semantic-layer/sqlite_books/_schema/main.yaml', BOOKS_MANIFEST);
    await seedManifest(project, 'semantic-layer/sqlite_reviews/_schema/main.yaml', REVIEWS_MANIFEST);

    // (a) Name-vs-physical separation: federated loading namespaces source.name
    // by member id while source.table stays the unprefixed physical ref.
    const records = await loadLocalSlSourceRecords(project, { connectionId: '_ktx_federated' });
    const byName = new Map(records.map((record) => [record.source.name, record.source.table]));
    expect([...byName.keys()].sort()).toEqual(['sqlite_books.books', 'sqlite_reviews.reviews']);
    expect(byName.get('sqlite_books.books')).toBe('main.books');
    expect(byName.get('sqlite_reviews.reviews')).toBe('main.reviews');

    // (b) Physical targeting end-to-end: a federated query joining the two
    // attached catalogs by their connectionId-prefixed physical refs returns
    // the correct joined rows through live DuckDB.
    const result = await executeProjectReadOnlySql({
      project,
      input: {
        connectionId: '_ktx_federated',
        connection: undefined,
        sql: 'SELECT b.title, AVG(r.stars) AS avg_stars FROM sqlite_books.books b JOIN sqlite_reviews.reviews r ON b.id = r.book_id GROUP BY b.title ORDER BY b.title',
        maxRows: 100,
      },
      createConnector: () => {
        throw new Error('federated path must not create a scan connector');
      },
    });
    expect(result.rows.map((row) => row[0])).toEqual(['Dune', 'Foundation']);
    expect(Number(result.rows[0][1])).toBeCloseTo(4.5);
  });
});
