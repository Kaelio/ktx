import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import Database from 'better-sqlite3';
import { describe, expect, it, vi } from 'vitest';
import { createLocalProjectMcpContextPorts } from '../../../src/context/mcp/local-project-ports.js';
import { initKtxProject } from '../../../src/context/project/project.js';

describe('MCP sql_execution — federated routing (live DuckDB)', () => {
  it('routes _ktx_federated through the shared federated executor, validating with the duckdb dialect', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'ktx-mcp-fed-'));
    try {
      const booksPath = join(dir, 'books.db');
      const reviewsPath = join(dir, 'reviews.db');
      const books = new Database(booksPath);
      books.exec("CREATE TABLE books (id INTEGER, title TEXT); INSERT INTO books VALUES (1, 'Dune');");
      books.close();
      const reviews = new Database(reviewsPath);
      reviews.exec('CREATE TABLE reviews (book_id INTEGER, stars INTEGER); INSERT INTO reviews VALUES (1, 5), (1, 3);');
      reviews.close();

      const project = await initKtxProject({ projectDir: dir });
      project.config.connections.books_db = { driver: 'sqlite', path: booksPath };
      project.config.connections.reviews_db = { driver: 'sqlite', path: reviewsPath };

      const validateReadOnly = vi.fn(async () => ({ ok: true, error: null }));
      const ports = createLocalProjectMcpContextPorts(project, {
        sqlAnalysis: {
          analyzeForFingerprint: vi.fn(),
          analyzeBatch: vi.fn(),
          validateReadOnly,
        } as never,
        localScan: {
          createConnector: () => {
            throw new Error('federated path must not create a scan connector');
          },
        },
        embeddingService: null,
      });

      const result = await ports.sqlExecution?.execute({
        connectionId: '_ktx_federated',
        sql: 'SELECT b.title, AVG(r.stars) AS avg_stars FROM books_db.books b JOIN reviews_db.reviews r ON b.id = r.book_id GROUP BY b.title',
        maxRows: 100,
      });

      expect(result?.rows?.[0]?.[0]).toBe('Dune');
      // Federated validation uses the duckdb dialect, not a member driver.
      expect(validateReadOnly).toHaveBeenCalledWith(expect.any(String), 'duckdb');
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  it('serializes integer columns from a federated query without throwing on bigint', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'ktx-mcp-fed-int-'));
    try {
      const booksPath = join(dir, 'books.db');
      const reviewsPath = join(dir, 'reviews.db');
      const books = new Database(booksPath);
      books.exec("CREATE TABLE books (id INTEGER, title TEXT); INSERT INTO books VALUES (1, 'Dune');");
      books.close();
      const reviews = new Database(reviewsPath);
      reviews.exec('CREATE TABLE reviews (book_id INTEGER, stars INTEGER); INSERT INTO reviews VALUES (1, 5), (1, 3);');
      reviews.close();

      const project = await initKtxProject({ projectDir: dir });
      project.config.connections.books_db = { driver: 'sqlite', path: booksPath };
      project.config.connections.reviews_db = { driver: 'sqlite', path: reviewsPath };

      const validateReadOnly = vi.fn(async () => ({ ok: true, error: null }));
      const ports = createLocalProjectMcpContextPorts(project, {
        sqlAnalysis: {
          analyzeForFingerprint: vi.fn(),
          analyzeBatch: vi.fn(),
          validateReadOnly,
        } as never,
        localScan: {
          createConnector: () => {
            throw new Error('federated path must not create a scan connector');
          },
        },
        embeddingService: null,
      });

      const result = await ports.sqlExecution?.execute({
        connectionId: '_ktx_federated',
        sql: 'SELECT b.title, count(*) AS n FROM books_db.books b JOIN reviews_db.reviews r ON b.id = r.book_id GROUP BY b.title',
        maxRows: 100,
      });

      expect(() => JSON.stringify(result)).not.toThrow();
      expect(result?.rows?.[0]?.[0]).toBe('Dune');
      expect(result?.rows?.[0]?.[1]).toBe(2);
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });
});
