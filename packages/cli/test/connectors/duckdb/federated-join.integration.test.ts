import { describe, expect, it } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import Database from 'better-sqlite3';
import { executeFederatedQuery } from '../../../src/connectors/duckdb/federated-executor.js';
import type { FederatedMember } from '../../../src/context/connections/federation.js';

describe('federated cross-catalog join (live DuckDB)', () => {
  it('joins two sqlite catalogs and enforces read-only', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'ktx-fed-'));
    const booksPath = join(dir, 'books.db');
    const reviewsPath = join(dir, 'reviews.db');

    const books = new Database(booksPath);
    books.exec("CREATE TABLE books (id INTEGER, title TEXT); INSERT INTO books VALUES (1, 'Dune'), (2, 'Foundation');");
    books.close();

    const reviews = new Database(reviewsPath);
    reviews.exec('CREATE TABLE reviews (book_id INTEGER, stars INTEGER); INSERT INTO reviews VALUES (1, 5), (1, 4), (2, 2);');
    reviews.close();

    const members: FederatedMember[] = [
      { connectionId: 'books_db', driver: 'sqlite', projectDir: dir, connection: { driver: 'sqlite', path: booksPath } },
      { connectionId: 'reviews_db', driver: 'sqlite', projectDir: dir, connection: { driver: 'sqlite', path: reviewsPath } },
    ];

    try {
      const result = await executeFederatedQuery(members, {
        connectionId: '_ktx_federated',
        connection: undefined,
        sql: 'SELECT b.title, AVG(r.stars) AS avg_stars FROM books_db.books b JOIN reviews_db.reviews r ON b.id = r.book_id GROUP BY b.title ORDER BY b.title',
      });
      expect(result.headers).toEqual(['title', 'avg_stars']);
      // ORDER BY title: Dune, Foundation
      expect(result.rows.map((row) => row[0])).toEqual(['Dune', 'Foundation']);
      expect(Number(result.rows[0][1])).toBeCloseTo(4.5); // Dune: (5+4)/2
      expect(Number(result.rows[1][1])).toBeCloseTo(2.0); // Foundation: 2/1

      await expect(
        executeFederatedQuery(members, {
          connectionId: '_ktx_federated',
          connection: undefined,
          sql: "INSERT INTO books_db.books VALUES (2, 'Hack')",
        }),
      ).rejects.toThrow(/read-only/i);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('returns integer columns as JSON-safe numbers, not bigint', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'ktx-fed-bigint-'));
    const booksPath = join(dir, 'books.db');
    const reviewsPath = join(dir, 'reviews.db');

    const books = new Database(booksPath);
    books.exec("CREATE TABLE books (id INTEGER, title TEXT); INSERT INTO books VALUES (1, 'Dune'), (2, 'Foundation');");
    books.close();

    const reviews = new Database(reviewsPath);
    reviews.exec('CREATE TABLE reviews (book_id INTEGER, stars INTEGER); INSERT INTO reviews VALUES (1, 5), (1, 4), (2, 2);');
    reviews.close();

    const members: FederatedMember[] = [
      { connectionId: 'books_db', driver: 'sqlite', projectDir: dir, connection: { driver: 'sqlite', path: booksPath } },
      { connectionId: 'reviews_db', driver: 'sqlite', projectDir: dir, connection: { driver: 'sqlite', path: reviewsPath } },
    ];

    try {
      const result = await executeFederatedQuery(members, {
        connectionId: '_ktx_federated',
        connection: undefined,
        sql: 'SELECT b.id, count(*) AS n FROM books_db.books b JOIN reviews_db.reviews r ON b.id = r.book_id GROUP BY b.id ORDER BY b.id',
      });
      for (const row of result.rows) {
        for (const cell of row) {
          expect(typeof cell).not.toBe('bigint');
        }
      }
      expect(() => JSON.stringify(result)).not.toThrow();
      expect(result.rows[0][0]).toBe(1);
      expect(Number(result.rows[0][1])).toBeGreaterThan(0);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('preserves a BIGINT beyond 2^53 as an exact string instead of rounding', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'ktx-fed-bigint-large-'));
    const idsPath = join(dir, 'ids.db');
    const otherPath = join(dir, 'other.db');

    const ids = new Database(idsPath);
    // 9007199254740993 = 2^53 + 1, which rounds to ...992 as a JS number; the
    // literal lives in SQL text so sqlite stores it exactly.
    ids.exec('CREATE TABLE ids (big_id INTEGER); INSERT INTO ids VALUES (9007199254740993);');
    ids.close();
    const other = new Database(otherPath);
    other.exec('CREATE TABLE t (x INTEGER); INSERT INTO t VALUES (1);');
    other.close();

    const members: FederatedMember[] = [
      { connectionId: 'ids_db', driver: 'sqlite', projectDir: dir, connection: { driver: 'sqlite', path: idsPath } },
      { connectionId: 'other_db', driver: 'sqlite', projectDir: dir, connection: { driver: 'sqlite', path: otherPath } },
    ];

    try {
      const result = await executeFederatedQuery(members, {
        connectionId: '_ktx_federated',
        connection: undefined,
        sql: 'SELECT big_id FROM ids_db.ids',
      });
      expect(result.rows[0][0]).toBe('9007199254740993');
      expect(() => JSON.stringify(result)).not.toThrow();
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('joins catalogs whose connection ids contain hyphens', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'ktx-fed-hyphen-'));
    const booksPath = join(dir, 'books.db');
    const reviewsPath = join(dir, 'reviews.db');
    const books = new Database(booksPath);
    books.exec("CREATE TABLE books (id INTEGER, title TEXT); INSERT INTO books VALUES (1, 'Dune');");
    books.close();
    const reviews = new Database(reviewsPath);
    reviews.exec('CREATE TABLE reviews (book_id INTEGER, stars INTEGER); INSERT INTO reviews VALUES (1, 5), (1, 3);');
    reviews.close();
    const members: FederatedMember[] = [
      { connectionId: 'books-db', driver: 'sqlite', projectDir: dir, connection: { driver: 'sqlite', path: booksPath } },
      { connectionId: 'reviews-db', driver: 'sqlite', projectDir: dir, connection: { driver: 'sqlite', path: reviewsPath } },
    ];
    try {
      const result = await executeFederatedQuery(members, {
        connectionId: '_ktx_federated',
        connection: undefined,
        sql: 'SELECT b.title, AVG(r.stars) AS avg_stars FROM "books-db".books b JOIN "reviews-db".reviews r ON b.id = r.book_id GROUP BY b.title',
      });
      expect(result.rows[0][0]).toBe('Dune');
      expect(Number(result.rows[0][1])).toBeCloseTo(4.0);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});
