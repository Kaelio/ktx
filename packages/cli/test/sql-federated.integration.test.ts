import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import Database from 'better-sqlite3';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { parseKtxProjectConfig, serializeKtxProjectConfig } from '../src/context/project/config.js';
import { initKtxProject } from '../src/context/project/project.js';
import type { SqlAnalysisPort } from '../src/context/sql-analysis/ports.js';
import type { KtxCliIo } from '../src/cli-runtime.js';
import { runKtxSql } from '../src/sql.js';

function fakeIo(): { io: KtxCliIo; out: () => string; err: () => string } {
  let out = '';
  let err = '';
  return {
    io: {
      stdout: { write: (chunk: string) => ((out += chunk), true) },
      stderr: { write: (chunk: string) => ((err += chunk), true) },
    } as unknown as KtxCliIo,
    out: () => out,
    err: () => err,
  };
}

// Validation needs the Python daemon, unavailable in unit tests; execution is real.
const stubSqlAnalysis: SqlAnalysisPort = {
  analyzeForFingerprint: async () => ({ fingerprint: '', normalizedSql: '', tablesTouched: [], literalSlots: [] }),
  analyzeBatch: async () => new Map([['cli-sql', { tablesTouched: [], columnsByClause: {} }]]),
  validateReadOnly: async () => ({ ok: true, error: null }),
};

describe('ktx sql federated integration', () => {
  let dir: string;

  beforeEach(async () => {
    dir = await mkdtemp(join(tmpdir(), 'ktx-fed-int-'));
  });

  afterEach(async () => {
    await rm(dir, { recursive: true, force: true });
  });

  it('joins books and reviews across two sqlite files', async () => {
    const projectDir = join(dir, 'project');
    await initKtxProject({ projectDir });

    const books = new Database(join(projectDir, 'books.db'));
    books.exec("CREATE TABLE books (id INTEGER PRIMARY KEY, title TEXT); INSERT INTO books VALUES (1, 'Clean Code');");
    books.close();
    const reviews = new Database(join(projectDir, 'reviews.db'));
    reviews.exec('CREATE TABLE reviews (id INTEGER PRIMARY KEY, book_id INTEGER, rating INTEGER); INSERT INTO reviews VALUES (1, 1, 5);');
    reviews.close();

    const config = parseKtxProjectConfig(await readFile(join(projectDir, 'ktx.yaml'), 'utf-8'));
    await writeFile(
      join(projectDir, 'ktx.yaml'),
      serializeKtxProjectConfig({
        ...config,
        connections: {
          books_db: { driver: 'sqlite', path: 'books.db' },
          reviews_db: { driver: 'sqlite', path: 'reviews.db' },
        },
      }),
      'utf-8',
    );

    const { io, out, err } = fakeIo();
    const code = await runKtxSql(
      {
        command: 'execute',
        projectDir,
        connectionId: '_ktx_federated',
        sql: 'SELECT b.title, r.rating FROM books_db.books b JOIN reviews_db.reviews r ON b.id = r.book_id',
        maxRows: 100,
        json: true,
        cliVersion: 'test',
      },
      io,
      { createSqlAnalysis: () => stubSqlAnalysis },
    );

    expect(code, err()).toBe(0);
    const payload = JSON.parse(out()) as { connectionId: string; headers: string[]; rows: unknown[][] };
    expect(payload.connectionId).toBe('_ktx_federated');
    expect(payload.headers).toEqual(['title', 'rating']);
    expect(payload.rows).toHaveLength(1);
    expect(payload.rows[0][0]).toBe('Clean Code');
    expect(Number(payload.rows[0][1])).toBe(5);
  });
});
