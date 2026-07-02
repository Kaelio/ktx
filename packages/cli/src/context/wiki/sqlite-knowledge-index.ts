import { mkdirSync } from 'node:fs';
import { dirname } from 'node:path';
import Database from 'better-sqlite3';
import { buildKnowledgeSearchText } from './knowledge-search-text.js';
import type { LocalKnowledgeScope } from './local-knowledge.js';
import type { KnowledgeIndexPageListing, UpsertPageParams } from './ports.js';

export interface SqliteKnowledgeIndexOptions {
  dbPath: string;
}

export interface SqliteKnowledgeIndexPage {
  path: string;
  key: string;
  scope: LocalKnowledgeScope;
  scopeId?: string | null;
  summary: string;
  content: string;
  tags: string[];
  embedding?: number[] | null;
}

export interface SqliteKnowledgeIndexSearchResult {
  path: string;
  score: number;
}

export interface WikiSqliteLaneCandidate {
  id: string;
  path: string;
  rank: number;
  rawScore: number;
}

export interface ExistingKnowledgeIndexPage {
  searchText: string;
  embedding: number[] | null;
}

interface SearchRow {
  path: string;
  rank: number;
}

type IndexedPageRow = {
  path: string;
  embedding_json: string | null;
};

function cosineSimilarity(left: number[], right: number[]): number {
  if (left.length === 0 || left.length !== right.length) {
    return 0;
  }
  let dot = 0;
  let leftNorm = 0;
  let rightNorm = 0;
  for (let i = 0; i < left.length; i++) {
    const l = left[i] ?? 0;
    const r = right[i] ?? 0;
    dot += l * r;
    leftNorm += l * l;
    rightNorm += r * r;
  }
  if (leftNorm === 0 || rightNorm === 0) {
    return 0;
  }
  return dot / (Math.sqrt(leftNorm) * Math.sqrt(rightNorm));
}

function scoreFromRank(rank: number): number {
  return Number((1 / (1 + Math.abs(rank))).toFixed(6));
}

function parseEmbedding(raw: string | null): number[] | null {
  if (!raw) {
    return null;
  }
  try {
    const embedding = JSON.parse(raw) as unknown;
    return Array.isArray(embedding) && embedding.length > 0 && embedding.every((value) => typeof value === 'number')
      ? embedding
      : null;
  } catch {
    return null;
  }
}

/** A provided-but-empty allowlist means "no page is in scope", distinct from an absent (unfiltered) one. */
function isEmptyAllowlist(allowedPaths: readonly string[] | undefined): boolean {
  return allowedPaths !== undefined && allowedPaths.length === 0;
}

/** Build a `<keyword> path IN (?, …)` fragment so the scope filter applies inside the query, before any LIMIT. */
function pathInClause(
  keyword: 'AND' | 'WHERE',
  allowedPaths: readonly string[] | undefined,
): { sql: string; params: string[] } {
  if (allowedPaths === undefined || allowedPaths.length === 0) {
    return { sql: '', params: [] };
  }
  return { sql: ` ${keyword} path IN (${allowedPaths.map(() => '?').join(', ')})`, params: [...allowedPaths] };
}

function normalizeFtsQuery(query: string): string {
  const terms = query
    .toLowerCase()
    .split(/[^a-z0-9_]+/u)
    .map((term) => term.trim())
    .filter(Boolean);

  return [...new Set(terms)].map((term) => `"${term.replaceAll('"', '""')}"`).join(' OR ');
}

export class SqliteKnowledgeIndex {
  private readonly db: Database.Database;

  constructor(options: SqliteKnowledgeIndexOptions) {
    mkdirSync(dirname(options.dbPath), { recursive: true });
    this.db = new Database(options.dbPath);
    this.db.pragma('journal_mode = WAL');
    this.db.pragma('foreign_keys = ON');
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS knowledge_pages (
        path TEXT PRIMARY KEY,
        key TEXT NOT NULL,
        scope TEXT NOT NULL,
        scope_id TEXT,
        summary TEXT NOT NULL,
        content TEXT NOT NULL,
        tags TEXT NOT NULL,
        search_text TEXT NOT NULL,
        embedding_json TEXT
      );

      CREATE VIRTUAL TABLE IF NOT EXISTS knowledge_pages_fts USING fts5(
        path UNINDEXED,
        key,
        summary,
        content,
        tags
      );
    `);
    const columns = this.db.prepare('PRAGMA table_info(knowledge_pages)').all() as Array<{ name: string }>;
    const columnNames = new Set(columns.map((column) => column.name));
    if (!columnNames.has('search_text')) {
      this.db.exec("ALTER TABLE knowledge_pages ADD COLUMN search_text TEXT NOT NULL DEFAULT ''");
    }
    if (!columnNames.has('embedding_json')) {
      this.db.exec('ALTER TABLE knowledge_pages ADD COLUMN embedding_json TEXT');
    }
    if (!columnNames.has('scope_id')) {
      this.db.exec('ALTER TABLE knowledge_pages ADD COLUMN scope_id TEXT');
    }
  }

  sync(pages: SqliteKnowledgeIndexPage[]): void {
    const keepPaths = pages.map((page) => page.path);
    const clearPages =
      keepPaths.length === 0
        ? this.db.prepare('DELETE FROM knowledge_pages')
        : this.db.prepare(`DELETE FROM knowledge_pages WHERE path NOT IN (${keepPaths.map(() => '?').join(', ')})`);
    const clearFts =
      keepPaths.length === 0
        ? this.db.prepare('DELETE FROM knowledge_pages_fts')
        : this.db.prepare(`DELETE FROM knowledge_pages_fts WHERE path NOT IN (${keepPaths.map(() => '?').join(', ')})`);
    const upsertPage = this.db.prepare(`
      INSERT INTO knowledge_pages (path, key, scope, scope_id, summary, content, tags, search_text, embedding_json)
      VALUES (@path, @key, @scope, @scopeId, @summary, @content, @tags, @searchText, @embeddingJson)
      ON CONFLICT(path) DO UPDATE SET
        key = excluded.key,
        scope = excluded.scope,
        scope_id = excluded.scope_id,
        summary = excluded.summary,
        content = excluded.content,
        tags = excluded.tags,
        search_text = excluded.search_text,
        embedding_json = excluded.embedding_json
    `);
    const deleteFts = this.db.prepare('DELETE FROM knowledge_pages_fts WHERE path = @path');
    const insertFts = this.db.prepare(`
      INSERT INTO knowledge_pages_fts (path, key, summary, content, tags)
      VALUES (@path, @key, @summary, @content, @tags)
    `);

    const transaction = this.db.transaction((items: SqliteKnowledgeIndexPage[]) => {
      clearPages.run(...keepPaths);
      clearFts.run(...keepPaths);
      for (const page of items) {
        const searchText = buildKnowledgeSearchText(page.key, page.summary, page.content, page.tags);
        const row = {
          path: page.path,
          key: page.key,
          scope: page.scope,
          scopeId: page.scopeId ?? null,
          summary: page.summary,
          content: searchText,
          tags: page.tags.join(' '),
          searchText,
          embeddingJson: page.embedding && page.embedding.length > 0 ? JSON.stringify(page.embedding) : null,
        };
        upsertPage.run(row);
        deleteFts.run(row);
        insertFts.run(row);
      }
    });

    transaction(pages);
  }

  rebuild(pages: SqliteKnowledgeIndexPage[]): void {
    this.sync(pages);
  }

  getExistingPages(): Map<string, ExistingKnowledgeIndexPage> {
    const rows = this.db
      .prepare(
        `
        SELECT path, search_text, embedding_json
        FROM knowledge_pages
        ORDER BY path ASC
      `,
      )
      .all() as Array<{ path: string; search_text: string; embedding_json: string | null }>;

    return new Map(
      rows.map((row) => [
        row.path,
        {
          searchText: row.search_text,
          embedding: parseEmbedding(row.embedding_json),
        },
      ]),
    );
  }

  searchLexicalCandidates(input: {
    queryText: string;
    limit: number;
    allowedPaths?: readonly string[];
  }): WikiSqliteLaneCandidate[] {
    const ftsQuery = normalizeFtsQuery(input.queryText);
    if (!ftsQuery || isEmptyAllowlist(input.allowedPaths)) {
      return [];
    }

    const pathFilter = pathInClause('AND', input.allowedPaths);
    const rows = this.db
      .prepare(
        `
        SELECT path, bm25(knowledge_pages_fts) AS rank
        FROM knowledge_pages_fts
        WHERE knowledge_pages_fts MATCH ?${pathFilter.sql}
        ORDER BY rank ASC, path ASC
        LIMIT ?
      `,
      )
      .all(ftsQuery, ...pathFilter.params, Math.max(1, input.limit)) as SearchRow[];

    return rows.map((row, index) => ({
      id: row.path,
      path: row.path,
      rank: index + 1,
      rawScore: Number(row.rank),
    }));
  }

  searchSemanticCandidates(input: {
    queryEmbedding: number[];
    limit: number;
    allowedPaths?: readonly string[];
  }): WikiSqliteLaneCandidate[] {
    if (isEmptyAllowlist(input.allowedPaths)) {
      return [];
    }

    const pathFilter = pathInClause('WHERE', input.allowedPaths);
    const rows = this.db
      .prepare(
        `
        SELECT path, embedding_json
        FROM knowledge_pages${pathFilter.sql}
        ORDER BY path ASC
      `,
      )
      .all(...pathFilter.params) as IndexedPageRow[];

    return rows
      .flatMap((row) => {
        if (!row.embedding_json) {
          return [];
        }
        const embedding = parseEmbedding(row.embedding_json);
        if (!embedding) {
          return [];
        }
        return [
          {
            id: row.path,
            path: row.path,
            rank: 0,
            rawScore: cosineSimilarity(input.queryEmbedding, embedding),
          },
        ];
      })
      .sort((left, right) => right.rawScore - left.rawScore || left.path.localeCompare(right.path))
      .slice(0, Math.max(1, input.limit))
      .map((candidate, index) => ({ ...candidate, rank: index + 1 }));
  }

  search(query: string, limit: number): SqliteKnowledgeIndexSearchResult[] {
    return this.searchLexicalCandidates({ queryText: query, limit }).map((row) => ({
      path: row.path,
      score: scoreFromRank(row.rawScore),
    }));
  }

  private pathForPage(scope: string, scopeId: string | null, pageKey: string): string {
    return scope === 'GLOBAL' ? `wiki/global/${pageKey}.md` : `wiki/user/${scopeId ?? 'local'}/${pageKey}.md`;
  }

  async upsertPage(params: UpsertPageParams): Promise<void> {
    const path = this.pathForPage(params.scope, params.scopeId, params.pageKey);
    const row = {
      path,
      key: params.pageKey,
      scope: params.scope,
      scopeId: params.scopeId,
      summary: params.summary,
      content: params.searchText,
      tags: '',
      searchText: params.searchText,
      embeddingJson: params.embedding && params.embedding.length > 0 ? JSON.stringify(params.embedding) : null,
    };
    const write = this.db.transaction(() => {
      this.db
        .prepare(
          `
          INSERT INTO knowledge_pages (path, key, scope, scope_id, summary, content, tags, search_text, embedding_json)
          VALUES (@path, @key, @scope, @scopeId, @summary, @content, @tags, @searchText, @embeddingJson)
          ON CONFLICT(path) DO UPDATE SET
            key = excluded.key,
            scope = excluded.scope,
            scope_id = excluded.scope_id,
            summary = excluded.summary,
            content = excluded.content,
            tags = excluded.tags,
            search_text = excluded.search_text,
            embedding_json = excluded.embedding_json
        `,
        )
        .run(row);
      this.db.prepare('DELETE FROM knowledge_pages_fts WHERE path = @path').run(row);
      this.db
        .prepare(
          `
          INSERT INTO knowledge_pages_fts (path, key, summary, content, tags)
          VALUES (@path, @key, @summary, @content, @tags)
        `,
        )
        .run(row);
    });
    write();
  }

  async getExistingSearchTexts(
    scope: string,
    scopeId: string | null,
  ): Promise<Map<string, { searchText: string; hasEmbedding: boolean }>> {
    const rows = this.db
      .prepare(
        `
        SELECT key, search_text, embedding_json
        FROM knowledge_pages
        WHERE scope = ?
          AND scope_id IS ?
        ORDER BY key ASC
      `,
      )
      .all(scope, scopeId) as Array<{ key: string; search_text: string; embedding_json: string | null }>;
    return new Map(
      rows.map((row) => [row.key, { searchText: row.search_text, hasEmbedding: row.embedding_json !== null }]),
    );
  }

  async deleteStale(scope: string, scopeId: string | null, keepKeys: string[]): Promise<number> {
    if (keepKeys.length === 0) {
      return this.deleteByScope(scope, scopeId);
    }
    const placeholders = keepKeys.map(() => '?').join(', ');
    const stale = this.db
      .prepare(
        `
        SELECT key
        FROM knowledge_pages
        WHERE scope = ?
          AND scope_id IS ?
          AND key NOT IN (${placeholders})
      `,
      )
      .all(scope, scopeId, ...keepKeys) as Array<{ key: string }>;
    for (const row of stale) {
      await this.deleteByKey(scope, scopeId, row.key);
    }
    return stale.length;
  }

  async deleteByScope(scope: string, scopeId: string | null): Promise<number> {
    return this.clear(scope, scopeId);
  }

  async deleteByKey(scope: string, scopeId: string | null, pageKey: string): Promise<number> {
    const path = this.pathForPage(scope, scopeId, pageKey);
    const remove = this.db.transaction(() => {
      this.db.prepare('DELETE FROM knowledge_pages_fts WHERE path = ?').run(path);
      const result = this.db.prepare('DELETE FROM knowledge_pages WHERE path = ?').run(path);
      return Number(result.changes);
    });
    return remove();
  }

  clear(scope: string, scopeId: string | null): number {
    const rows = this.db
      .prepare('SELECT path FROM knowledge_pages WHERE scope = ? AND scope_id IS ?')
      .all(scope, scopeId) as Array<{ path: string }>;
    const remove = this.db.transaction((paths: string[]) => {
      for (const path of paths) {
        this.db.prepare('DELETE FROM knowledge_pages_fts WHERE path = ?').run(path);
        this.db.prepare('DELETE FROM knowledge_pages WHERE path = ?').run(path);
      }
    });
    remove(rows.map((row) => row.path));
    return rows.length;
  }

  async applyDiffTransactional(params: {
    runId: string;
    upserts: UpsertPageParams[];
    deletes: Array<{ scope: string; scopeId: string | null; pageKey: string }>;
  }): Promise<void> {
    void params.runId;
    for (const page of params.upserts) {
      await this.upsertPage(page);
    }
    for (const page of params.deletes) {
      await this.deleteByKey(page.scope, page.scopeId, page.pageKey);
    }
  }

  async findPageByKey(
    scope: string,
    scopeId: string | null,
    pageKey: string,
  ): Promise<{ id?: string; page_key: string } | null> {
    const path = this.pathForPage(scope, scopeId, pageKey);
    const row = this.db.prepare('SELECT path, key FROM knowledge_pages WHERE path = ?').get(path) as
      | { path: string; key: string }
      | undefined;
    return row ? { id: row.path, page_key: row.key } : null;
  }

  async listPagesForUser(userId: string): Promise<KnowledgeIndexPageListing[]> {
    const rows = this.db
      .prepare(
        `
        SELECT path, key, scope, scope_id, summary, tags
        FROM knowledge_pages
        WHERE scope = 'GLOBAL'
           OR (scope = 'USER' AND scope_id = ?)
        ORDER BY scope ASC, key ASC
      `,
      )
      .all(userId) as Array<{
      path: string;
      key: string;
      scope: string;
      scope_id: string | null;
      summary: string;
      tags: string;
    }>;
    return rows.map((row) => ({
      id: row.path,
      page_key: row.key,
      summary: row.summary,
      scope: row.scope,
      scope_id: row.scope_id,
      tags: row.tags.split(/\s+/).filter(Boolean),
    }));
  }

  async getUserPageCount(userId: string): Promise<number> {
    const row = this.db
      .prepare("SELECT COUNT(*) AS count FROM knowledge_pages WHERE scope = 'USER' AND scope_id = ?")
      .get(userId) as { count: number };
    return row.count;
  }

  async incrementUsageCount(): Promise<void> {}

  async searchRRF(
    userId: string,
    _embedding: number[] | null,
    queryText: string,
    limit: number,
  ): Promise<Array<{ pageKey: string; summary: string; rrfScore: number }>> {
    const allowedPages = new Map((await this.listPagesForUser(userId)).map((page) => [page.id, page]));
    return this.search(queryText, limit)
      .map((row) => {
        const page = allowedPages.get(row.path);
        return page ? { pageKey: page.page_key, summary: page.summary, rrfScore: row.score } : null;
      })
      .filter((row): row is { pageKey: string; summary: string; rrfScore: number } => row !== null);
  }
}
