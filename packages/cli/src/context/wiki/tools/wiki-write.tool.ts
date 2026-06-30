import { z } from 'zod';
import type { KnowledgeIndexPort } from '../ports.js';
import type { KnowledgeEventPort } from '../ports.js';
type BlockScope = 'GLOBAL' | 'USER';
import { KnowledgeWikiService } from '../../../context/wiki/knowledge-wiki.service.js';
import type { WikiFrontmatter } from '../../../context/wiki/types.js';
import { validateFlatWikiKey } from '../keys.js';
import { findMissingWikiRefs } from '../wiki-ref-validation.js';
import { applySqlEdits } from '../../tools/sql-edit-replacer.js';
import { BaseTool, type ToolContext, type ToolOutput } from '../../../context/tools/base-tool.js';
import { validateActionRawPaths } from '../../../context/tools/action-raw-paths.js';

const MAX_USER_BLOCKS = 100;
const SYSTEM_AUTHOR = 'System User';
const SYSTEM_EMAIL = 'system@example.com';

const historicSqlUsageFrontmatterSchema = z.object({
  executions: z.number().int().nonnegative(),
  distinct_users: z.number().int().nonnegative(),
  first_seen: z.string().min(1),
  last_seen: z.string().min(1),
  p50_runtime_ms: z.number().nonnegative().nullable(),
  p95_runtime_ms: z.number().nonnegative().nullable(),
  error_rate: z.number().min(0).max(1),
  rows_produced: z.number().int().nonnegative().optional(),
});

const wikiWriteInputSchema = z.object({
  key: z.string().max(120),
  summary: z.string().max(200),
  content: z.string().max(4000).optional(),
  replacements: z
    .array(z.object({ oldText: z.string(), newText: z.string(), reason: z.string().optional() }))
    .optional(),
  tags: z.array(z.string()).optional(),
  refs: z.array(z.string()).optional(),
  sl_refs: z.array(z.string()).optional(),
  connections: z
    .union([z.string(), z.array(z.string())])
    .optional()
    .describe(
      'Connection ids this page applies to. Set [connectionId] on database-specific pages (with a connection-distinctive key); omit or leave empty for org-wide content. REPLACE semantics like tags.',
    ),
  source: z.string().optional(),
  intent: z.string().optional(),
  tables: z.array(z.string()).optional(),
  representative_sql: z.string().optional(),
  usage: historicSqlUsageFrontmatterSchema.optional(),
  fingerprints: z.array(z.string()).optional(),
  rawPaths: z
    .array(z.string().min(1))
    .optional()
    .describe('In ingest sessions, raw source file paths that directly support this wiki action.'),
});

type WikiWriteInput = z.infer<typeof wikiWriteInputSchema>;

interface WikiWriteStructured {
  success: boolean;
  key: string;
  action?: 'created' | 'updated';
  content?: string;
}

function looksLikeEscapedMarkdown(content: string): boolean {
  const withoutInlineCode = content.replace(/`[^`]*`/g, '');
  return /\\n\\n|(?:^|\\n)#{1,6}\s|\\n[-*]\s|\\n\d+\.\s|\\n```|\\n\|/.test(withoutInlineCode);
}

function normalizeAccidentalEscapedMarkdownNewlines(content: string): string {
  const escapedBreaks = content.match(/\\[rn]/g)?.length ?? 0;
  if (escapedBreaks < 2) return content;

  const actualBreaks = content.match(/\r?\n/g)?.length ?? 0;
  if (actualBreaks > 0 && escapedBreaks <= actualBreaks * 4) return content;
  if (!looksLikeEscapedMarkdown(content)) return content;

  return content.replace(/\\r\\n/g, '\n').replace(/\\n/g, '\n').replace(/\\r/g, '\n');
}

export class WikiWriteTool extends BaseTool<typeof wikiWriteInputSchema> {
  readonly name = 'wiki_write';

  constructor(
    private readonly wikiService: KnowledgeWikiService,
    private readonly pagesRepository: KnowledgeIndexPort,
    private readonly knowledgeRepository: KnowledgeEventPort,
  ) {
    super();
  }

  get description(): string {
    return `<purpose>
Create or update a wiki page. Provide content for create/rewrite, or replacements for targeted edits.
For existing pages, you may provide only frontmatter fields such as summary, tags, refs, or sl_refs to update metadata while preserving content.
tags/refs/sl_refs use REPLACE semantics: omit to keep existing on update, [] to clear, [values] to set.
Keys must be flat file names, not directory paths. Use tags/source frontmatter for grouping.
</purpose>`;
  }

  get inputSchema() {
    return wikiWriteInputSchema;
  }

  async call(input: WikiWriteInput, context: ToolContext): Promise<ToolOutput<WikiWriteStructured>> {
    const wikiService = context.session?.wikiService ?? this.wikiService;
    const writesGlobal = !!context.session;
    const skipIndex = context.session?.isWorktreeScoped === true;
    const keyValidation = validateFlatWikiKey(input.key);
    if (!keyValidation.ok) {
      return {
        markdown: keyValidation.error,
        structured: { success: false, key: input.key },
      };
    }
    const rawPathValidation = validateActionRawPaths(context.session, input.rawPaths);
    if (!rawPathValidation.ok) {
      return {
        markdown: `Error: ${rawPathValidation.error}`,
        structured: { success: false, key: input.key },
      };
    }

    const scope: BlockScope = writesGlobal ? 'GLOBAL' : 'USER';
    const scopeId = scope === 'USER' ? context.userId : null;
    const existing = await wikiService.readPage(scope, scopeId, input.key);

    const content = input.content;
    const hasContent = typeof content === 'string' && content.length > 0;
    const hasReplacements = !!input.replacements && input.replacements.length > 0;
    if (!existing && !hasContent && !hasReplacements) {
      return {
        markdown: 'Error: provide either content (for create/rewrite) or replacements (for edits).',
        structured: { success: false, key: input.key },
      };
    }

    if (!existing && !input.content) {
      return {
        markdown: `Page "${input.key}" does not exist. Provide content to create it.`,
        structured: { success: false, key: input.key },
      };
    }

    if (scope === 'USER' && !existing) {
      const count = await this.pagesRepository.getUserPageCount(context.userId);
      if (count >= MAX_USER_BLOCKS) {
        return {
          markdown: `Cannot create "${input.key}": user has reached the limit of ${MAX_USER_BLOCKS} pages.`,
          structured: { success: false, key: input.key },
        };
      }
    }

    const existingFm = existing?.frontmatter;
    const resolvedTags = input.tags === undefined ? existingFm?.tags : input.tags;
    const resolvedRefs = input.refs === undefined ? existingFm?.refs : input.refs;
    const resolvedSlRefs = input.sl_refs === undefined ? existingFm?.sl_refs : input.sl_refs;
    const incomingConnections =
      input.connections === undefined
        ? undefined
        : typeof input.connections === 'string'
          ? [input.connections]
          : input.connections;
    const resolvedConnections = incomingConnections === undefined ? existingFm?.connections : incomingConnections;

    // Data-loss guard: page keys are a flat global namespace, so a write whose
    // incoming connection scope is disjoint from an existing same-key page would
    // silently overwrite a different connection's page. Surface it instead.
    const existingConnections = existingFm?.connections ?? [];
    if (
      existing &&
      incomingConnections !== undefined &&
      incomingConnections.length > 0 &&
      existingConnections.length > 0 &&
      !incomingConnections.some((id) => existingConnections.includes(id))
    ) {
      return {
        markdown:
          `Error: page "${input.key}" already exists scoped to a different connection ` +
          `(connections: ${existingConnections.join(', ')}); writing it for ${incomingConnections.join(', ')} ` +
          `would overwrite that page. Use a connection-distinctive key (e.g. "${input.key}_${incomingConnections[0]}").`,
        structured: { success: false, key: input.key },
      };
    }

    let finalContent: string;
    const finalFm: WikiFrontmatter = {
      summary: input.summary,
      usage_mode: existingFm?.usage_mode ?? 'auto',
      sort_order: existingFm?.sort_order ?? 0,
      tags: resolvedTags,
      refs: resolvedRefs,
      sl_refs: resolvedSlRefs,
      connections: resolvedConnections,
      source: input.source === undefined ? existingFm?.source : input.source,
      intent: input.intent === undefined ? existingFm?.intent : input.intent,
      tables: input.tables === undefined ? existingFm?.tables : input.tables,
      representative_sql:
        input.representative_sql === undefined ? existingFm?.representative_sql : input.representative_sql,
      usage: input.usage === undefined ? existingFm?.usage : input.usage,
      fingerprints: input.fingerprints === undefined ? existingFm?.fingerprints : input.fingerprints,
    };

    if (hasContent) {
      finalContent = normalizeAccidentalEscapedMarkdownNewlines(content);
    } else if (hasReplacements) {
      const editResult = applySqlEdits(existing?.content ?? '', input.replacements ?? []);
      if (!editResult.success) {
        return {
          markdown: `Edit errors: ${editResult.errors.join('; ')}`,
          structured: { success: false, key: input.key },
        };
      }
      finalContent = editResult.sql;
    } else {
      finalContent = existing?.content ?? '';
    }

    const missingRefs = await findMissingWikiRefs({
      wikiService,
      scope,
      scopeId,
      pageKey: input.key,
      refs: finalFm.refs,
      content: finalContent,
    });
    const deferMissingRefs = !!context.session?.ingest;
    if (!deferMissingRefs && missingRefs.length > 0) {
      return {
        markdown:
          `Error: wiki references target missing page(s): ${missingRefs.join(', ')}. ` +
          'Create those pages first, retarget the links, or remove the refs.',
        structured: { success: false, key: input.key },
      };
    }

    await wikiService.writePage(scope, scopeId, input.key, finalFm, finalContent, SYSTEM_AUTHOR, SYSTEM_EMAIL);
    if (!skipIndex) {
      await wikiService.syncSinglePage(scope, scopeId, input.key, finalFm, finalContent);
    }

    await this.knowledgeRepository.createEvent({
      blockId: null,
      eventType: existing ? 'BLOCK_UPDATED' : 'BLOCK_CREATED',
      actorId: context.userId,
      chatId: null,
      messageId: null,
      payload: {
        pageKey: input.key,
        previousContent: existing ? existing.content.slice(0, 500) : null,
      },
    });

    const action = existing ? 'updated' : 'created';
    if (context.session) {
      context.session.actions.push({
        target: 'wiki',
        type: action,
        key: input.key,
        detail: input.summary,
        ...(rawPathValidation.rawPaths ? { rawPaths: rawPathValidation.rawPaths } : {}),
      });
    }

    // When the LLM used `replacements` (edit mode), it doesn't have the
    // post-edit content cached. Returning the result here prevents the
    // common bug where a follow-up edit uses an oldText string that no
    // longer matches because a prior edit already changed the page.
    const markdown = hasReplacements
      ? `Page "${input.key}" ${action}.\n\nCurrent content (use for subsequent edits):\n\n${finalContent}`
      : `Page "${input.key}" ${action}.`;

    return {
      markdown,
      structured: { success: true, key: input.key, action, content: finalContent },
    };
  }
}
