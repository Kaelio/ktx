import { createHash } from 'node:crypto';
import YAML from 'yaml';
import type { KtxEmbeddingPort } from '../../context/core/embedding.js';
import type { KtxFileStorePort, KtxFileWriteResult } from '../../context/core/file-store.js';
import type { KtxLogger } from '../../context/core/config.js';
import { noopLogger } from '../../context/core/config.js';
import type { ReindexWorkResult } from '../index-sync/types.js';
import { assertFlatWikiKey, isFlatWikiKey } from './keys.js';
import { buildKnowledgeSearchText } from './knowledge-search-text.js';
import type { KnowledgeGitDiffPort, KnowledgeIndexPort, UpsertPageParams } from './ports.js';
import type { WikiFrontmatter, WikiPage, WikiPageWithScope } from './types.js';

const WIKI_PREFIX = 'wiki';

export type { WikiFrontmatter };
export class KnowledgeWikiService {
  private isWorktreeScoped = false;
  constructor(
    private readonly configService: KtxFileStorePort,
    private readonly embeddingService: KtxEmbeddingPort | null,
    private readonly pagesRepository: KnowledgeIndexPort,
    private readonly gitService: KnowledgeGitDiffPort,
    private readonly logger: KtxLogger = noopLogger,
  ) {}

  /**
   * Return a clone of this service whose disk writes go through a worktree-scoped
   * ConfigService AND whose DB-index writes are no-ops. Used by memory-agent
   * session worktrees so wiki tool calls during the LLM loop land on the session
   * branch. The shared `knowledge` table is only touched once per run, atomically,
   * via `syncFromCommit` after Stage 6 squashes the branch into main.
   */
  forWorktree(workdir: string): KnowledgeWikiService {
    return new KnowledgeWikiService(
      this.configService.forWorktree(workdir) as KtxFileStorePort,
      this.embeddingService,
      this.pagesRepository,
      this.gitService,
      this.logger,
    ).markWorktreeScoped();
  }

  private markWorktreeScoped(): KnowledgeWikiService {
    this.isWorktreeScoped = true;
    return this;
  }

  // ── File paths ────────────────────────────────────────────────

  private scopeDir(scope: string, scopeId?: string | null): string {
    if (scope === 'GLOBAL') {
      return `${WIKI_PREFIX}/global`;
    }
    return `${WIKI_PREFIX}/user/${scopeId}`;
  }

  pagePath(scope: string, scopeId: string | null | undefined, pageKey: string): string {
    return `${this.scopeDir(scope, scopeId)}/${assertFlatWikiKey(pageKey)}.md`;
  }

  // ── Parsing / serialization ───────────────────────────────────

  parsePage(raw: string): { frontmatter: WikiFrontmatter; content: string } {
    const match = raw.match(/^---\n([\s\S]*?)\n---\n?([\s\S]*)$/);
    if (!match) {
      throw new Error('Invalid wiki page: missing YAML frontmatter');
    }
    const frontmatter = YAML.parse(match[1]) as WikiFrontmatter;
    const content = match[2].trim();
    return { frontmatter, content };
  }

  serializePage(frontmatter: WikiFrontmatter, content: string): string {
    const yaml = YAML.stringify(frontmatter, { indent: 2, lineWidth: 0 }).trimEnd();
    return `---\n${yaml}\n---\n\n${content}\n`;
  }

  // ── File CRUD ─────────────────────────────────────────────────

  async writePage(
    scope: string,
    scopeId: string | null | undefined,
    pageKey: string,
    frontmatter: WikiFrontmatter,
    content: string,
    author: string,
    authorEmail: string,
    commitMessage?: string,
    options?: { skipLock?: boolean },
  ) {
    const path = this.pagePath(scope, scopeId, pageKey);
    const serialized = this.serializePage(frontmatter, content);
    const message = commitMessage ?? `Update wiki page: ${pageKey}`;
    return this.configService.writeFile(path, serialized, author, authorEmail, message, {
      skipLock: options?.skipLock,
    });
  }

  async readPage(scope: string, scopeId: string | null | undefined, pageKey: string): Promise<WikiPage | null> {
    const path = this.pagePath(scope, scopeId, pageKey);
    let raw: string;
    try {
      const result = await this.configService.readFile(path);
      raw = result.content;
    } catch {
      return null;
    }
    try {
      const { frontmatter, content } = this.parsePage(raw);
      return { pageKey, frontmatter, content };
    } catch (error) {
      // The file exists but parsing failed. Returning null without surfacing the
      // parse error would let callers (and the memory agent) treat it as "page
      // doesn't exist" and clobber the broken page on the next write.
      this.logger.warn(
        `[readPage] ${path}: parse failed: ${error instanceof Error ? error.message : String(error)}`,
      );
      return null;
    }
  }

  async deletePage(
    scope: string,
    scopeId: string | null | undefined,
    pageKey: string,
    author: string,
    authorEmail: string,
  ) {
    const path = this.pagePath(scope, scopeId, pageKey);
    try {
      return await this.configService.deleteFile(path, author, authorEmail, `Remove wiki page: ${pageKey}`);
    } catch (error) {
      // Check if the file actually exists — if not, deletion is a no-op
      try {
        await this.configService.readFile(path);
      } catch {
        // File doesn't exist, nothing to delete
        return null;
      }
      // File exists but delete failed — propagate so callers don't assume success
      this.logger.error(`Failed to delete wiki page at ${path} despite file existing`);
      throw error;
    }
  }

  async listPageKeys(scope: string, scopeId?: string | null): Promise<string[]> {
    const dir = this.scopeDir(scope, scopeId);
    let files: string[];
    try {
      const result = await this.configService.listFiles(dir);
      files = result.files;
    } catch (error) {
      // listFiles returns [] for missing directories; reaching this catch means
      // an IO-level failure that should at least be surfaced before we report
      // "no pages" the same as a freshly-initialised store would.
      this.logger.warn(
        `[listPageKeys] ${dir}: ${error instanceof Error ? error.message : String(error)}`,
      );
      return [];
    }
    return files
      .filter((f) => f.endsWith('.md'))
      .map((f) => f.replace(`${dir}/`, '').replace(/\.md$/, ''))
      .filter(isFlatWikiKey);
  }

  async getPageHistory(scope: string, scopeId: string | null | undefined, pageKey: string) {
    const path = this.pagePath(scope, scopeId, pageKey);
    return this.configService.getFileHistory(path);
  }

  // ── Read page for user (USER scope first, fallback to GLOBAL) ─

  async readPageForUser(userId: string, pageKey: string): Promise<WikiPageWithScope | null> {
    // Try USER scope first
    const userPage = await this.readPage('USER', userId, pageKey);
    if (userPage) {
      return { ...userPage, scope: 'USER' };
    }
    // Fall back to GLOBAL
    const globalPage = await this.readPage('GLOBAL', null, pageKey);
    if (globalPage) {
      return { ...globalPage, scope: 'GLOBAL' };
    }
    return null;
  }

  /**
   * Write a page verbatim from raw .md text (front-matter + body) after parse-validation.
   * Preserves the user's exact formatting (raw mode source-of-truth).
   */
  async writeRawPageAndSync(
    scope: string,
    scopeId: string | null | undefined,
    pageKey: string,
    rawContent: string,
    author: string,
    authorEmail: string,
    commitMessage?: string,
  ): Promise<{ frontmatter: WikiFrontmatter; content: string }> {
    const parsed = this.parsePage(rawContent);
    if (!parsed.frontmatter.summary || String(parsed.frontmatter.summary).trim().length === 0) {
      throw new Error('Front-matter field "summary" is required');
    }
    const validModes = ['always', 'auto', 'never'];
    if (!validModes.includes(parsed.frontmatter.usage_mode)) {
      throw new Error(`Front-matter field "usage_mode" must be one of: ${validModes.join(', ')}`);
    }

    const path = this.pagePath(scope, scopeId, pageKey);
    await this.configService.writeFile(
      path,
      rawContent,
      author,
      authorEmail,
      commitMessage ?? `Update wiki page (raw): ${pageKey}`,
    );
    await this.syncSinglePage(scope, scopeId, pageKey, parsed.frontmatter, parsed.content);
    return parsed;
  }

  /**
   * Write a wiki page and then sync it to the DB search index.
   * Chains the two operations so the index is only updated after the file write succeeds.
   */
  async writePageAndSync(
    scope: string,
    scopeId: string | null | undefined,
    pageKey: string,
    frontmatter: WikiFrontmatter,
    content: string,
    author: string,
    authorEmail: string,
    commitMessage?: string,
  ): Promise<KtxFileWriteResult> {
    const writeResult = await this.writePage(
      scope,
      scopeId,
      pageKey,
      frontmatter,
      content,
      author,
      authorEmail,
      commitMessage,
    );
    const serialized = this.serializePage(frontmatter, content);
    const contentHash = createHash('sha256').update(serialized).digest('hex');
    await this.syncSinglePage(scope, scopeId, pageKey, frontmatter, content, contentHash);
    return writeResult;
  }

  // ── Index sync (files → DB) ───────────────────────────────────

  /**
   * Sync a single page to the DB search index after a write.
   * Computes search_text and embedding, then upserts to knowledge index.
   */
  async syncSinglePage(
    scope: string,
    scopeId: string | null | undefined,
    pageKey: string,
    frontmatter: WikiFrontmatter,
    content: string,
    contentHash?: string | null,
  ): Promise<void> {
    if (this.isWorktreeScoped) {
      // Worktree-scoped writes stay on the session branch only. The shared
      // knowledge index is updated atomically from the squashed commit diff
      // after Stage 6 via syncFromCommit().
      return;
    }

    const searchText = buildKnowledgeSearchText(pageKey, frontmatter.summary, content, frontmatter.tags);

    let embedding: number[] | null = null;
    if (this.embeddingService) {
      try {
        embedding = await this.embeddingService.computeEmbedding(searchText);
      } catch (err) {
        this.logger.warn(`Embedding failed for page "${pageKey}": ${err instanceof Error ? err.message : String(err)}`);
      }
    }

    await this.pagesRepository.upsertPage({
      scope,
      scopeId: scopeId ?? null,
      pageKey,
      summary: frontmatter.summary,
      usageMode: frontmatter.usage_mode,
      sortOrder: frontmatter.sort_order ?? 0,
      searchText,
      embedding,
      contentHash: contentHash ?? null,
    });
  }

  /**
   * Full sync: load all pages from disk for a scope, reindex changed pages, clean stale entries.
   * Mirrors SlSearchService.indexSources() pattern.
   */
  async syncIndex(scope: string, scopeId?: string | null): Promise<ReindexWorkResult> {
    const pageKeys = await this.listPageKeys(scope, scopeId);
    const existing = await this.pagesRepository.getExistingSearchTexts(scope, scopeId ?? null);

    if (pageKeys.length === 0) {
      const deleted = await this.pagesRepository.deleteByScope(scope, scopeId ?? null);
      return {
        scanned: 0,
        updated: 0,
        deleted,
        embeddingsRecomputed: 0,
        embeddingsFailed: 0,
      };
    }

    const pages: Array<{ pageKey: string; frontmatter: WikiFrontmatter; content: string; searchText: string }> = [];
    for (const key of pageKeys) {
      const page = await this.readPage(scope, scopeId, key);
      if (page) {
        const searchText = buildKnowledgeSearchText(key, page.frontmatter.summary, page.content, page.frontmatter.tags);
        pages.push({ pageKey: key, frontmatter: page.frontmatter, content: page.content, searchText });
      }
    }

    const embeddingService = this.embeddingService;
    const changedPages = pages.filter((page) => {
      const previous = existing.get(page.pageKey);
      return (
        !previous ||
        previous.searchText !== page.searchText ||
        (embeddingService !== null && !previous.hasEmbedding)
      );
    });

    let embeddings: (number[] | null)[] = changedPages.map(() => null);
    let embeddingsRecomputed = 0;
    let embeddingsFailed = 0;

    if (embeddingService && changedPages.length > 0) {
      try {
        const changedTexts = changedPages.map((page) => page.searchText);
        const all: number[][] = [];
        for (let i = 0; i < changedTexts.length; i += embeddingService.maxBatchSize) {
          const batch = changedTexts.slice(i, i + embeddingService.maxBatchSize);
          all.push(...(await embeddingService.computeEmbeddingsBulk(batch)));
        }
        embeddings = all;
        embeddingsRecomputed = all.length;
      } catch (err) {
        this.logger.warn(`Embedding batch failed during sync: ${err instanceof Error ? err.message : String(err)}`);
        embeddingsFailed = changedPages.length;
      }
    }

    for (let i = 0; i < changedPages.length; i += 1) {
      const page = changedPages[i]!;
      await this.pagesRepository.upsertPage({
        scope,
        scopeId: scopeId ?? null,
        pageKey: page.pageKey,
        summary: page.frontmatter.summary,
        usageMode: page.frontmatter.usage_mode,
        sortOrder: page.frontmatter.sort_order ?? 0,
        searchText: page.searchText,
        embedding: embeddings[i] ?? null,
      });
    }

    const deleted = await this.pagesRepository.deleteStale(scope, scopeId ?? null, pageKeys);
    return {
      scanned: pages.length,
      updated: changedPages.length,
      deleted,
      embeddingsRecomputed,
      embeddingsFailed,
    };
  }

  /**
   * Delete a page from the DB index (after file deletion).
   */
  async deleteFromIndex(scope: string, scopeId: string | null | undefined, pageKey: string): Promise<void> {
    if (this.isWorktreeScoped) {
      return;
    }
    await this.pagesRepository.deleteByKey(scope, scopeId ?? null, pageKey);
  }

  /**
   * Apply the diff between two commits on the config repo to the shared
   * wiki index in a single transaction. Called by the ingest runner
   * after Stage 6 squashes the session branch into main: the pre-squash main
   * SHA and the post-squash SHA bracket exactly the set of wiki-file
   * changes this run produced.
   *
   * Any added/modified file becomes an upsert (tagged with `source_run_id`),
   * any deleted file becomes a delete. Parsing errors fail the whole
   * transaction so the shared table stays consistent.
   */
  async syncFromCommit(fromSha: string, toSha: string, runId: string): Promise<void> {
    const diff = await this.gitService.diffNameStatus(fromSha, toSha, 'wiki/');
    if (diff.length === 0) {
      return;
    }
    const upserts: UpsertPageParams[] = [];
    const deletes: Array<{ scope: string; scopeId: string | null; pageKey: string }> = [];

    for (const entry of diff) {
      const parsedPath = parseKnowledgePath(entry.path);
      if (!parsedPath) {
        this.logger.warn(`[wiki.sync] skipping unparseable path: ${entry.path}`);
        continue;
      }
      if (entry.status === 'D') {
        deletes.push(parsedPath);
        continue;
      }
      const content = await this.gitService.getFileAtCommit(entry.path, toSha);
      const parsed = this.parsePage(content);
      const searchText = buildKnowledgeSearchText(
        parsedPath.pageKey,
        parsed.frontmatter.summary,
        parsed.content,
        parsed.frontmatter.tags,
      );
      let embedding: number[] | null = null;
      if (this.embeddingService) {
        try {
          embedding = await this.embeddingService.computeEmbedding(searchText);
        } catch (err) {
          this.logger.warn(
            `[wiki.sync] embedding failed for ${parsedPath.pageKey}: ${err instanceof Error ? err.message : String(err)}`,
          );
        }
      }
      const contentHash = createHash('sha256').update(content).digest('hex');
      upserts.push({
        scope: parsedPath.scope,
        scopeId: parsedPath.scopeId,
        pageKey: parsedPath.pageKey,
        summary: parsed.frontmatter.summary,
        usageMode: parsed.frontmatter.usage_mode,
        sortOrder: parsed.frontmatter.sort_order ?? 0,
        searchText,
        embedding,
        contentHash,
      });
    }

    await this.pagesRepository.applyDiffTransactional({ runId, upserts, deletes });
    this.logger.log(`[wiki.sync] run=${runId} applied ${upserts.length} upsert(s), ${deletes.length} delete(s)`);
  }
}

/**
 * Parse a `wiki/<scope>/...` file path into its scope and page key.
 *   `wiki/global/foo.md` → { scope: 'GLOBAL', scopeId: null, pageKey: 'foo' }
 *   `wiki/user/<id>/bar.md` → { scope: 'USER', scopeId: '<id>', pageKey: 'bar' }
 */
function parseKnowledgePath(path: string): { scope: string; scopeId: string | null; pageKey: string } | null {
  if (!path.endsWith('.md')) {
    return null;
  }
  const segments = path.split('/');
  if (segments[0] !== 'wiki') {
    return null;
  }
  const rest = segments.slice(1);
  if (rest.length === 2 && rest[0] === 'global') {
    const pageKey = rest[1].replace(/\.md$/, '');
    return isFlatWikiKey(pageKey) ? { scope: 'GLOBAL', scopeId: null, pageKey } : null;
  }
  if (rest.length === 3 && rest[0] === 'user') {
    const pageKey = rest[2].replace(/\.md$/, '');
    return isFlatWikiKey(pageKey) ? { scope: 'USER', scopeId: rest[1], pageKey } : null;
  }
  return null;
}
