import { describe, expect, it, vi } from 'vitest';
import type { ToolSession } from '../../../../src/context/tools/tool-session.js';
import { createTouchedSlSources } from '../../../../src/context/tools/touched-sl-sources.js';
import type { ToolContext } from '../../../../src/context/tools/base-tool.js';
import { WikiWriteTool } from '../../../../src/context/wiki/tools/wiki-write.tool.js';

function makeTool(overrides: any = {}) {
  const wikiService = {
    readPage: vi.fn().mockResolvedValue(null),
    listPageKeys: vi.fn().mockResolvedValue([]),
    writePage: vi.fn().mockResolvedValue(undefined),
    syncSinglePage: vi.fn().mockResolvedValue(undefined),
    ...overrides.wikiService,
  };
  const pagesRepository = {
    findPageByKey: vi.fn().mockResolvedValue(null),
    getUserPageCount: vi.fn().mockResolvedValue(0),
    ...overrides.pagesRepository,
  };
  const knowledgeRepository = {
    createEvent: vi.fn().mockResolvedValue(undefined),
    ...overrides.knowledgeRepository,
  };
  const tool = new WikiWriteTool(wikiService as any, pagesRepository as any, knowledgeRepository as any);
  return { tool, wikiService, pagesRepository, knowledgeRepository };
}

describe('WikiWriteTool', () => {
  const baseContext: ToolContext = { sourceId: 's', messageId: 'm', userId: 'u' };

  it('creates a new page and indexes it when no session is present', async () => {
    const { tool, wikiService } = makeTool();
    const result = await tool.call(
      { key: 'leads-source', summary: 'Lead source definitions', content: '# Leads' } as any,
      baseContext,
    );
    expect(wikiService.writePage).toHaveBeenCalledTimes(1);
    expect(wikiService.syncSinglePage).toHaveBeenCalledTimes(1);
    expect(result.markdown).toMatch(/created/i);
  });

  it('rejects slash-delimited page keys with a flat-key suggestion', async () => {
    const { tool, wikiService } = makeTool();
    const result = await tool.call(
      { key: 'orbit/company-overview', summary: 'Company overview', content: '# Orbit' } as any,
      baseContext,
    );

    expect(result.structured).toEqual({ success: false, key: 'orbit/company-overview' });
    expect(result.markdown).toContain(
      'Invalid wiki key "orbit/company-overview". Wiki keys must be flat; use "orbit-company-overview".',
    );
    expect(wikiService.readPage).not.toHaveBeenCalled();
    expect(wikiService.writePage).not.toHaveBeenCalled();
  });

  it('normalizes accidentally escaped markdown newlines before writing', async () => {
    const { tool, wikiService } = makeTool();

    await tool.call(
      {
        key: 'large-contract-requesters',
        summary: 'Cross-schema Metabase query',
        content:
          '# Large Contract Requesters\\n\\n**Source card:** Metabase #110\\n\\n## SQL\\n\\n```sql\\nselect * from orbit_analytics.mart_account_segments\\n```\\n',
      } as any,
      baseContext,
    );

    expect(wikiService.writePage.mock.calls[0][4]).toBe(
      '# Large Contract Requesters\n\n**Source card:** Metabase #110\n\n## SQL\n\n```sql\nselect * from orbit_analytics.mart_account_segments\n```\n',
    );
    expect(wikiService.syncSinglePage.mock.calls[0][4]).toBe(
      '# Large Contract Requesters\n\n**Source card:** Metabase #110\n\n## SQL\n\n```sql\nselect * from orbit_analytics.mart_account_segments\n```\n',
    );
  });

  it('preserves intentional escaped newline examples in inline code', async () => {
    const { tool, wikiService } = makeTool();

    await tool.call(
      {
        key: 'newline-token',
        summary: 'Escaped newline token',
        content: 'Use `\\n\\n` when documenting the literal separator.',
      } as any,
      baseContext,
    );

    expect(wikiService.writePage.mock.calls[0][4]).toBe('Use `\\n\\n` when documenting the literal separator.');
  });

  it('skips syncSinglePage when session is worktree-scoped', async () => {
    const { tool, wikiService } = makeTool();
    const session: ToolSession = {
      connectionId: 'conn-1',
      isWorktreeScoped: true,
      preHead: null,
      touchedSlSources: createTouchedSlSources(),
      actions: [],
      semanticLayerService: {} as any,
      wikiService: wikiService as any,
      configService: {} as any,
      gitService: {} as any,
    };
    const context: ToolContext = { ...baseContext, session };
    await tool.call({ key: 'k', summary: 's', content: '# x' } as any, context);
    expect(wikiService.writePage).toHaveBeenCalledTimes(1);
    expect(wikiService.syncSinglePage).not.toHaveBeenCalled();
    expect(session.actions).toContainEqual(expect.objectContaining({ target: 'wiki', type: 'created', key: 'k' }));
  });

  it('requires either content or replacements', async () => {
    const { tool } = makeTool();
    const result = await tool.call({ key: 'k', summary: 's' } as any, baseContext);
    expect(result.structured.success).toBe(false);
    expect(result.markdown).toMatch(/content.*or.*replacements/i);
  });

  it('updates frontmatter only on an existing page while preserving content', async () => {
    const { tool, wikiService } = makeTool({
      wikiService: {
        readPage: vi.fn().mockResolvedValue({
          pageKey: 'orbit-customers',
          frontmatter: {
            summary: 'Customer source details',
            usage_mode: 'auto',
            sort_order: 0,
            tags: ['notion'],
            refs: ['notion:old'],
            sl_refs: ['postgres-warehouse/orbit_analytics.customer'],
          },
          content: '# Orbit Customers\n\nSource: Notion - Orbit Customers Source.',
        }),
      },
    });

    const result = await tool.call(
      {
        key: 'orbit-customers',
        summary: 'Customer source details mapped to the warehouse customer view',
        sl_refs: ['postgres-warehouse/orbit_analytics.customer', 'dbt-main/customer'],
      } as any,
      baseContext,
    );

    expect(result.structured).toMatchObject({ success: true, key: 'orbit-customers', action: 'updated' });
    expect(wikiService.writePage).toHaveBeenCalledWith(
      'USER',
      'u',
      'orbit-customers',
      expect.objectContaining({
        summary: 'Customer source details mapped to the warehouse customer view',
        tags: ['notion'],
        refs: ['notion:old'],
        sl_refs: ['postgres-warehouse/orbit_analytics.customer', 'dbt-main/customer'],
      }),
      '# Orbit Customers\n\nSource: Notion - Orbit Customers Source.',
      expect.any(String),
      expect.any(String),
    );
  });

  it('writes historic-SQL frontmatter fields', async () => {
    const { tool, wikiService } = makeTool();

    await tool.call(
      {
        key: 'monthly-paid-orders',
        summary: 'Monthly paid orders',
        tags: ['historic-sql', 'query-pattern'],
        sl_refs: ['analytics.orders'],
        source: 'historic-sql',
        intent: 'Monthly paid order count',
        tables: ['analytics.orders'],
        representative_sql: "SELECT count(*) FROM analytics.orders WHERE status = 'paid'",
        usage: {
          executions: 42,
          distinct_users: 3,
          first_seen: '2026-02-01',
          last_seen: '2026-05-04',
          p50_runtime_ms: 100,
          p95_runtime_ms: 200,
          error_rate: 0,
          rows_produced: 42,
        },
        fingerprints: ['fp_paid_orders'],
        content: '## Monthly paid order count',
      } as any,
      baseContext,
    );

    expect(wikiService.writePage.mock.calls[0][3]).toEqual({
      summary: 'Monthly paid orders',
      usage_mode: 'auto',
      sort_order: 0,
      tags: ['historic-sql', 'query-pattern'],
      refs: undefined,
      sl_refs: ['analytics.orders'],
      source: 'historic-sql',
      intent: 'Monthly paid order count',
      tables: ['analytics.orders'],
      representative_sql: "SELECT count(*) FROM analytics.orders WHERE status = 'paid'",
      usage: {
        executions: 42,
        distinct_users: 3,
        first_seen: '2026-02-01',
        last_seen: '2026-05-04',
        p50_runtime_ms: 100,
        p95_runtime_ms: 200,
        error_rate: 0,
        rows_produced: 42,
      },
      fingerprints: ['fp_paid_orders'],
    });
  });

  it('preserves historic-SQL frontmatter fields when update omits them', async () => {
    const existingFrontmatter = {
      summary: 'Monthly paid orders',
      usage_mode: 'auto' as const,
      sort_order: 0,
      tags: ['historic-sql'],
      sl_refs: ['analytics.orders'],
      source: 'historic-sql',
      intent: 'Monthly paid order count',
      tables: ['analytics.orders'],
      representative_sql: "SELECT count(*) FROM analytics.orders WHERE status = 'paid'",
      usage: {
        executions: 42,
        distinct_users: 3,
        first_seen: '2026-02-01',
        last_seen: '2026-05-04',
        p50_runtime_ms: 100,
        p95_runtime_ms: 200,
        error_rate: 0,
        rows_produced: 42,
      },
      fingerprints: ['fp_paid_orders'],
    };
    const { tool, wikiService } = makeTool({
      wikiService: {
        readPage: vi.fn().mockResolvedValue({
          pageKey: 'monthly-paid-orders',
          frontmatter: existingFrontmatter,
          content: 'old body',
        }),
      },
    });

    await tool.call(
      {
        key: 'monthly-paid-orders',
        summary: 'Monthly paid orders updated',
        content: '## Monthly paid order count updated',
      } as any,
      baseContext,
    );

    expect(wikiService.writePage.mock.calls[0][3]).toEqual({
      ...existingFrontmatter,
      summary: 'Monthly paid orders updated',
    });
  });

  it('sets connections on a new page and normalizes a single string to a list', async () => {
    const { tool, wikiService } = makeTool();

    await tool.call(
      { key: 'orders-sales-db', summary: 'Sales orders', content: '# Orders', connections: 'sales_db' } as any,
      baseContext,
    );

    expect(wikiService.writePage.mock.calls[0][3]).toMatchObject({ connections: ['sales_db'] });
  });

  it('applies REPLACE semantics for connections on update', async () => {
    const existing = {
      pageKey: 'orders',
      frontmatter: { summary: 'Orders', usage_mode: 'auto' as const, sort_order: 0, connections: ['sales_db'] },
      content: 'body',
    };
    // omit ⇒ keep existing connections
    {
      const { tool, wikiService } = makeTool({ wikiService: { readPage: vi.fn().mockResolvedValue(existing) } });
      await tool.call({ key: 'orders', summary: 'Orders', content: 'new body' } as any, baseContext);
      expect(wikiService.writePage.mock.calls[0][3]).toMatchObject({ connections: ['sales_db'] });
    }
    // [] ⇒ clear to unscoped
    {
      const { tool, wikiService } = makeTool({ wikiService: { readPage: vi.fn().mockResolvedValue(existing) } });
      await tool.call({ key: 'orders', summary: 'Orders', content: 'new body', connections: [] } as any, baseContext);
      expect(wikiService.writePage.mock.calls[0][3]).toMatchObject({ connections: [] });
    }
    // [ids] ⇒ set (broaden within overlap is allowed)
    {
      const { tool, wikiService } = makeTool({ wikiService: { readPage: vi.fn().mockResolvedValue(existing) } });
      await tool.call(
        { key: 'orders', summary: 'Orders', content: 'new body', connections: ['sales_db', 'events_db'] } as any,
        baseContext,
      );
      expect(wikiService.writePage.mock.calls[0][3]).toMatchObject({ connections: ['sales_db', 'events_db'] });
    }
  });

  it('blocks a connection-scoped write whose key collides with a disjoint-connection page', async () => {
    const { tool, wikiService } = makeTool({
      wikiService: {
        readPage: vi.fn().mockResolvedValue({
          pageKey: 'orders',
          frontmatter: { summary: 'Events orders', usage_mode: 'auto', sort_order: 0, connections: ['events_db'] },
          content: 'events body',
        }),
      },
    });

    const result = await tool.call(
      { key: 'orders', summary: 'Sales orders', content: 'sales body', connections: ['sales_db'] } as any,
      baseContext,
    );

    expect(result.structured).toEqual({ success: false, key: 'orders' });
    expect(result.markdown).toContain('already exists scoped to a different connection');
    expect(result.markdown).toContain('orders_sales_db');
    expect(wikiService.writePage).not.toHaveBeenCalled();
  });

  it('allows narrowing a connection-scoped page within its own scope', async () => {
    const { tool, wikiService } = makeTool({
      wikiService: {
        readPage: vi.fn().mockResolvedValue({
          pageKey: 'orders',
          frontmatter: { summary: 'Orders', usage_mode: 'auto', sort_order: 0, connections: ['sales_db', 'events_db'] },
          content: 'body',
        }),
      },
    });

    const result = await tool.call(
      { key: 'orders', summary: 'Orders', content: 'body', connections: ['sales_db'] } as any,
      baseContext,
    );

    expect(result.structured).toMatchObject({ success: true, action: 'updated' });
    expect(wikiService.writePage.mock.calls[0][3]).toMatchObject({ connections: ['sales_db'] });
  });

  it('allows scoping a previously unscoped page (existing connections empty)', async () => {
    const { tool, wikiService } = makeTool({
      wikiService: {
        readPage: vi.fn().mockResolvedValue({
          pageKey: 'orders',
          frontmatter: { summary: 'Orders', usage_mode: 'auto', sort_order: 0 },
          content: 'body',
        }),
      },
    });

    const result = await tool.call(
      { key: 'orders', summary: 'Orders', content: 'body', connections: ['sales_db'] } as any,
      baseContext,
    );

    expect(result.structured).toMatchObject({ success: true, action: 'updated' });
    expect(wikiService.writePage.mock.calls[0][3]).toMatchObject({ connections: ['sales_db'] });
  });

  it('rejects frontmatter refs that target missing wiki pages', async () => {
    const { tool, wikiService } = makeTool({
      wikiService: {
        listPageKeys: vi.fn().mockResolvedValue(['orbit-company-overview']),
      },
    });

    const result = await tool.call(
      {
        key: 'orbit-how-we-work',
        summary: 'Operating norms',
        content: '## How We Work',
        refs: ['orbit-company-overview', 'orbit-team-lanes-detail'],
      } as any,
      baseContext,
    );

    expect(result.structured.success).toBe(false);
    expect(result.markdown).toMatch(/orbit-team-lanes-detail/);
    expect(wikiService.writePage).not.toHaveBeenCalled();
  });

  it('rejects inline wiki links that target missing wiki pages', async () => {
    const { tool, wikiService } = makeTool({
      wikiService: {
        listPageKeys: vi.fn().mockResolvedValue(['orbit-company-overview']),
      },
    });

    const result = await tool.call(
      {
        key: 'orbit-how-we-work',
        summary: 'Operating norms',
        content: 'See [[orbit-company-overview]] and [[orbit-team-lanes-detail]].',
      } as any,
      baseContext,
    );

    expect(result.structured.success).toBe(false);
    expect(result.markdown).toMatch(/orbit-team-lanes-detail/);
    expect(wikiService.writePage).not.toHaveBeenCalled();
  });

  it('accepts forward refs during ingest sessions for post-pass validation', async () => {
    const { tool, wikiService } = makeTool({
      wikiService: {
        listPageKeys: vi.fn().mockResolvedValue(['orbit-company-overview']),
      },
    });
    const session: ToolSession = {
      connectionId: 'conn-1',
      isWorktreeScoped: true,
      preHead: null,
      touchedSlSources: createTouchedSlSources(),
      actions: [],
      semanticLayerService: {} as any,
      wikiService: wikiService as any,
      configService: {} as any,
      gitService: {} as any,
      ingest: { runId: 'run-1', jobId: 'job-1', syncId: 'sync-1', sourceKey: 'notion' },
    };

    const result = await tool.call(
      {
        key: 'orbit-how-we-work',
        summary: 'Operating norms',
        content: 'See [[orbit-team-lanes-detail]].',
        refs: ['orbit-company-overview', 'orbit-team-lanes-detail'],
      } as any,
      { ...baseContext, session },
    );

    expect(result.structured).toMatchObject({ success: true, key: 'orbit-how-we-work', action: 'created' });
    expect(wikiService.writePage).toHaveBeenCalledTimes(1);
    expect(session.actions).toContainEqual(
      expect.objectContaining({ target: 'wiki', type: 'created', key: 'orbit-how-we-work' }),
    );
  });
});
