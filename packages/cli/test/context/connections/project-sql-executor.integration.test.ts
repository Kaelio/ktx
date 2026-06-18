import { describe, expect, it } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import Database from 'better-sqlite3';
import { executeProjectReadOnlySql } from '../../../src/context/connections/project-sql-executor.js';
import type { KtxLocalProject } from '../../../src/context/project/project.js';

function fakeProject(projectDir: string, connections: Record<string, { driver: string; path: string }>): KtxLocalProject {
  return {
    projectDir,
    configPath: join(projectDir, 'ktx.yaml'),
    config: { connections } as unknown as KtxLocalProject['config'],
    coreConfig: {} as KtxLocalProject['coreConfig'],
    git: {} as KtxLocalProject['git'],
    fileStore: {} as KtxLocalProject['fileStore'],
  };
}

describe('executeProjectReadOnlySql — federated integration (real DuckDB)', () => {
  it('runs a federated cross-catalog join through the default executeFederatedQuery', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'ktx-fed-exec-'));
    const booksPath = join(dir, 'books.db');
    const reviewsPath = join(dir, 'reviews.db');

    const books = new Database(booksPath);
    books.exec("CREATE TABLE books (id INTEGER, title TEXT); INSERT INTO books VALUES (1, 'Dune'), (2, 'Foundation');");
    books.close();
    const reviews = new Database(reviewsPath);
    reviews.exec('CREATE TABLE reviews (book_id INTEGER, stars INTEGER); INSERT INTO reviews VALUES (1, 5), (1, 4), (2, 2);');
    reviews.close();

    const project = fakeProject(dir, {
      books_db: { driver: 'sqlite', path: booksPath },
      reviews_db: { driver: 'sqlite', path: reviewsPath },
    });

    try {
      const result = await executeProjectReadOnlySql({
        project,
        input: {
          connectionId: '_ktx_federated',
          connection: undefined,
          sql: 'SELECT b.title, AVG(r.stars) AS avg_stars FROM books_db.books b JOIN reviews_db.reviews r ON b.id = r.book_id GROUP BY b.title ORDER BY b.title',
          maxRows: 100,
        },
        createConnector: () => {
          throw new Error('federated path must not create a scan connector');
        },
      });
      expect(result.rows.map((row) => row[0])).toEqual(['Dune', 'Foundation']);
      expect(Number(result.rows[0][1])).toBeCloseTo(4.5);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});
