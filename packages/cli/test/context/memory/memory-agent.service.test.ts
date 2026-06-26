import { describe, expect, it, vi } from 'vitest';
import { validateSingleSource } from '../../../src/context/sl/tools/sl-warehouse-validation.js';
import { createTouchedSlSources, hasTouchedSlSource } from '../../../src/context/tools/touched-sl-sources.js';
import { detectCaptureSignals, isWorthAnalyzing } from '../../../src/context/memory/capture-signals.js';
import { MemoryAgentService } from '../../../src/context/memory/memory-agent.service.js';

const passthroughValidator = {
  validateSingleSource: (d: unknown, c: string, n: string) => validateSingleSource(d as never, c, n),
} as never;

describe('MemoryAgentService.detectCaptureSignals', () => {
  it('fires sl on a long user message + SQL aggregate in assistant message', () => {
    const userMessage = `${'A'.repeat(120)} show me revenue by month`;
    const result = detectCaptureSignals({
      userId: 'u',
      chatId: 'c',
      userMessage,
      assistantMessage: 'SELECT SUM(amount) FROM orders GROUP BY month',
    });
    expect(result.sl).toBe(true);
    expect(result.reasons).toContain('sql aggregate in assistant message');
  });

  it('does NOT fire sl from aggregate alone when user message is short', () => {
    const result = detectCaptureSignals({
      userId: 'u',
      chatId: 'c',
      userMessage: 'show revenue',
      assistantMessage: 'SELECT SUM(amount) FROM orders',
    });
    expect(result.sl).toBe(false);
  });

  it('fires sl on assistant SQL for external_ingest despite a short boilerplate user message', () => {
    // `ktx ingest --file` keeps the content in assistantMessage and uses a fixed boilerplate
    // user message, so the substantive-turn gate must come from the deliberate submission itself.
    const result = detectCaptureSignals({
      userId: 'u',
      chatId: 'c',
      userMessage: 'Ingest external text artifact "verified_pairs.md" into ktx memory.',
      assistantMessage: 'Q: total claims completed?\nSQL: SELECT COUNT(DISTINCT Claim_No_Date) FROM dimJob_Details',
      sourceType: 'external_ingest',
    });
    expect(result.sl).toBe(true);
    expect(result.reasons).toContain('sql aggregate in assistant message');
  });

  it('keeps the substantive-turn gate for non-ingest source types with a short user message', () => {
    const result = detectCaptureSignals({
      userId: 'u',
      chatId: 'c',
      userMessage: 'Ingest external text artifact "verified_pairs.md" into ktx memory.',
      assistantMessage: 'SELECT COUNT(DISTINCT Claim_No_Date) FROM dimJob_Details',
      sourceType: 'research',
    });
    expect(result.sl).toBe(false);
  });

  it('fires sl on definition keywords in user message regardless of length', () => {
    const result = detectCaptureSignals({
      userId: 'u',
      chatId: 'c',
      userMessage: 'going forward exclude cancelled orders from revenue',
    });
    expect(result.sl).toBe(true);
    expect(result.reasons).toContain('sl-style definition keyword in user message');
  });

  it('fires knowledge on a definition keyword in user message', () => {
    const result = detectCaptureSignals({
      userId: 'u',
      chatId: 'c',
      userMessage: 'BYOL stands for Bring Your Own Lab',
    });
    expect(result.knowledge).toBe(true);
    expect(result.reasons).toContain('definition keyword in user message');
  });

  it('fires both sl and knowledge when both signals hit', () => {
    const result = detectCaptureSignals({
      userId: 'u',
      chatId: 'c',
      userMessage: 'going forward, define revenue as sum of paid orders',
    });
    expect(result.sl).toBe(true);
    expect(result.knowledge).toBe(true);
  });

  it('fires neither for a plain ad-hoc question', () => {
    const result = detectCaptureSignals({
      userId: 'u',
      chatId: 'c',
      userMessage: 'how many users signed up last week?',
      assistantMessage: '12 users.',
    });
    expect(result.sl).toBe(false);
    expect(result.knowledge).toBe(false);
    expect(result.reasons).toEqual([]);
  });

  it('fires knowledge when assistant emits a markdown definition table', () => {
    const result = detectCaptureSignals({
      userId: 'u',
      chatId: 'c',
      userMessage: 'list our protocols',
      assistantMessage: '| Term | Definition |\n|---|---|\n| TRT | Testosterone Replacement Therapy |',
    });
    expect(result.knowledge).toBe(true);
    expect(result.reasons).toContain('definition table in assistant message');
  });

  it('accepts JOIN and CTE-style aggregates as sl signals', () => {
    const userMessage = 'B'.repeat(150);
    const result = detectCaptureSignals({
      userId: 'u',
      chatId: 'c',
      userMessage,
      assistantMessage: 'WITH base AS (SELECT * FROM x) SELECT * FROM base',
    });
    expect(result.sl).toBe(true);
  });

  it('reasons array is empty when no signal fires', () => {
    const result = detectCaptureSignals({
      userId: 'u',
      chatId: 'c',
      userMessage: 'hello',
    });
    expect(result.reasons).toEqual([]);
  });

  it('detects LookML dialect from view/measure structural keywords', () => {
    const result = detectCaptureSignals({
      userId: 'u',
      chatId: 'c',
      userMessage: 'ingest this',
      assistantMessage:
        'view: fct_labs {\n  sql_table_name: analytics.fct_labs ;;\n  measure: count_lab_orders { type: count }\n}',
    });
    expect(result.dialect).toBe('lookml');
    expect(result.sl).toBe(true);
    expect(result.reasons).toContain('lookml structure in assistant message');
  });
});

describe('MemoryAgentService.isWorthAnalyzing (C1 + F1)', () => {
  const baseInput = (assistantMessage: string) => ({
    userId: 'u',
    chatId: 'c',
    userMessage: 'Ingest the following content into memory.',
    assistantMessage,
  });

  it('skips a pure LookML wrapper (only view + sql_table_name + dimensions + measure: count)', () => {
    const wrapper = `view: timeline {
  sql_table_name: analytics.timeline ;;
  dimension_group: date { type: time; description: "m/d/Y" }
  dimension: notes { type: string; description: "notes" }
  measure: count { type: count }
}`;
    expect(isWorthAnalyzing(baseInput(wrapper))).toBe(false);
  });

  it('keeps a LookML view with a non-count aggregate (count_distinct, sum, avg, …)', () => {
    const real = `view: fct_labs {
  sql_table_name: analytics.fct_labs ;;
  measure: count_lab_orders { type: count }
  measure: count_distinct_patients { type: count_distinct; sql: \${admin_user_id} ;; }
}`;
    expect(isWorthAnalyzing(baseInput(real))).toBe(true);
  });

  it('keeps a LookML view with derived_table even if it has no non-count measures', () => {
    const derived = `view: lab_results {
  derived_table: { sql: SELECT * FROM analytics.raw WHERE status = 'final' ;; }
  dimension: lab_order_id { primary_key: yes; type: string }
  measure: count { type: count }
}`;
    expect(isWorthAnalyzing(baseInput(derived))).toBe(true);
  });

  it('keeps a LookML view with sql_always_where', () => {
    const enforced = `view: rpt_daily_braze_email {
  sql_table_name: analytics.fct_email_sends ;;
  sql_always_where: \${TABLE}.channel = 'braze' ;;
  measure: count { type: count }
}`;
    expect(isWorthAnalyzing(baseInput(enforced))).toBe(true);
  });

  it('keeps a LookML view with a join: block', () => {
    const joined = `view: fct_labs {
  sql_table_name: analytics.fct_labs ;;
  join: dim_customers {
    sql_on: \${fct_labs.admin_user_id} = \${dim_customers.admin_user_id} ;;
    relationship: many_to_one
  }
}`;
    expect(isWorthAnalyzing(baseInput(joined))).toBe(true);
  });
});

describe('MemoryAgentService.reconcileCrossRefs', () => {
  type Action = { target: 'wiki' | 'sl'; type: 'created' | 'updated' | 'removed'; key: string; detail: string };

  const buildService = (overrides: {
    readPage?: ReturnType<typeof vi.fn>;
    syncFromWiki?: ReturnType<typeof vi.fn>;
  }) => {
    const wikiService = {
      readPage: overrides.readPage ?? vi.fn(),
    };
    const knowledgeSlRefsRepository = {
      syncFromWiki: overrides.syncFromWiki ?? vi.fn().mockResolvedValue({ inserted: 0, deleted: 0 }),
    };
    const svc = new MemoryAgentService({
      settings: {
        knowledge: { userScopedKnowledgeEnabled: false },
        slValidation: { probeRowCount: 1 },
        llm: { memoryIngestionModel: 'test-model' },
      },
      promptService: undefined as never,
      skillsRegistry: undefined as never,
      wikiService: wikiService as never,
      knowledgeIndex: undefined as never,
      knowledgeSlRefs: knowledgeSlRefsRepository as never,
      semanticLayerService: undefined as never,
      slSearchService: undefined as never,
      connections: undefined as never,
      rootFileStore: undefined as never,
      gitService: undefined as never,
      lockingService: undefined as never,
      slSourcesRepository: undefined as never,
      sessionWorktreeService: undefined as never,
      semanticLayerSourceReconciler: undefined as never,
      agentRunner: undefined as never,
      slValidator: undefined as never,
      toolsetFactory: undefined as never,
    });
    return { svc, wikiService, knowledgeSlRefsRepository };
  };

  const session = {
    userId: 'u',
    chatId: 'c',
    userMessage: 'test',
    connectionId: 'conn-1',
    userScopedEnabled: false,
    forceGlobalScope: false,
    touchedSlSources: createTouchedSlSources(),
    preHead: null,
  };

  it('projects a wiki page.sl_refs into knowledge_sl_refs via syncFromWiki', async () => {
    const { svc, knowledgeSlRefsRepository } = buildService({
      readPage: vi.fn().mockResolvedValue({
        pageKey: 'byol-definition',
        frontmatter: { summary: 'byol', sl_refs: ['fct_labs', 'lab_results'] },
        content: 'body',
      }),
      syncFromWiki: vi.fn().mockResolvedValue({ inserted: 2, deleted: 0 }),
    });

    const actions: Action[] = [{ target: 'wiki', type: 'created', key: 'byol-definition', detail: '' }];
    const synced = await svc.reconcileCrossRefs(actions, session);

    expect(synced).toBe(2);
    expect(knowledgeSlRefsRepository.syncFromWiki).toHaveBeenCalledWith({
      wikiPageKey: 'byol-definition',
      wikiScope: 'GLOBAL',
      wikiScopeId: null,
      refs: [
        { connectionId: 'conn-1', sourceName: 'fct_labs' },
        { connectionId: 'conn-1', sourceName: 'lab_results' },
      ],
    });
  });

  it('skips sync when the action has no connectionId in session', async () => {
    const { svc, knowledgeSlRefsRepository } = buildService({
      readPage: vi.fn().mockResolvedValue({
        pageKey: 'byol-definition',
        frontmatter: { summary: 'byol', sl_refs: ['fct_labs'] },
        content: 'body',
      }),
    });

    const actions: Action[] = [{ target: 'wiki', type: 'created', key: 'byol-definition', detail: '' }];
    const synced = await svc.reconcileCrossRefs(actions, { ...session, connectionId: undefined });

    expect(synced).toBe(0);
    expect(knowledgeSlRefsRepository.syncFromWiki).not.toHaveBeenCalled();
  });

  it('syncs an empty sl_refs list — clearing any stale rows for that wiki', async () => {
    const { svc, knowledgeSlRefsRepository } = buildService({
      readPage: vi.fn().mockResolvedValue({
        pageKey: 'byol-definition',
        frontmatter: { summary: 'byol' },
        content: 'body',
      }),
      syncFromWiki: vi.fn().mockResolvedValue({ inserted: 0, deleted: 1 }),
    });

    const actions: Action[] = [{ target: 'wiki', type: 'updated', key: 'byol-definition', detail: '' }];
    const synced = await svc.reconcileCrossRefs(actions, session);

    expect(synced).toBe(1);
    expect(knowledgeSlRefsRepository.syncFromWiki).toHaveBeenCalledWith({
      wikiPageKey: 'byol-definition',
      wikiScope: 'GLOBAL',
      wikiScopeId: null,
      refs: [],
    });
  });

  it('normalizes dotted sl_refs to bare source names, dedupes (H)', async () => {
    const { svc, knowledgeSlRefsRepository } = buildService({
      readPage: vi.fn().mockResolvedValue({
        pageKey: 'fct-labs-overview',
        frontmatter: {
          summary: 'fct_labs',
          sl_refs: ['fct_labs', 'fct_labs.count_lab_orders', 'fct_labs.count_distinct_patients', 'lab_results'],
        },
        content: 'body',
      }),
      syncFromWiki: vi.fn().mockResolvedValue({ inserted: 2, deleted: 0 }),
    });

    const actions: Action[] = [{ target: 'wiki', type: 'created', key: 'fct-labs-overview', detail: '' }];
    await svc.reconcileCrossRefs(actions, session);

    expect(knowledgeSlRefsRepository.syncFromWiki).toHaveBeenCalledWith({
      wikiPageKey: 'fct-labs-overview',
      wikiScope: 'GLOBAL',
      wikiScopeId: null,
      refs: [
        { connectionId: 'conn-1', sourceName: 'fct_labs' },
        { connectionId: 'conn-1', sourceName: 'lab_results' },
      ],
    });
  });

  it('ignores sl-only actions — the DB index is driven from the wiki side', async () => {
    const { svc, knowledgeSlRefsRepository } = buildService({});

    const actions: Action[] = [{ target: 'sl', type: 'updated', key: 'fct_labs', detail: '' }];
    const synced = await svc.reconcileCrossRefs(actions, session);

    expect(synced).toBe(0);
    expect(knowledgeSlRefsRepository.syncFromWiki).not.toHaveBeenCalled();
  });
});

describe('MemoryAgentService.gateRevertInvalidSources (J3)', () => {
  type Action = { target: 'wiki' | 'sl'; type: 'created' | 'updated' | 'removed'; key: string; detail: string };

  // Build a service with the minimal deps the gate needs: semanticLayerService
  // (readSourceFile, loadSource, writeSource for revert), dataSourcesService
  // (executeQuery for dry-run), configService (writeFile/deleteFile for revert),
  // gitService (getFileAtCommit).
  const buildService = (overrides: {
    readSourceFile?: ReturnType<typeof vi.fn>;
    executeQuery?: ReturnType<typeof vi.fn>;
    writeFile?: ReturnType<typeof vi.fn>;
    deleteFile?: ReturnType<typeof vi.fn>;
    getFileAtCommit?: ReturnType<typeof vi.fn>;
  }) => {
    const semanticLayerService = {
      readSourceFile: overrides.readSourceFile ?? vi.fn(),
      isManifestBacked: vi.fn().mockResolvedValue(false),
    };
    const connections = {
      listEnabledConnections: vi.fn().mockResolvedValue([]),
      getConnectionById: vi.fn().mockResolvedValue({
        id: 'conn-1',
        name: 'Warehouse',
        connectionType: 'POSTGRESQL',
      }),
      executeQuery: overrides.executeQuery ?? vi.fn(),
    };
    const configService = {
      writeFile: overrides.writeFile ?? vi.fn().mockResolvedValue({}),
      deleteFile: overrides.deleteFile ?? vi.fn().mockResolvedValue({}),
      // Revert resolves the live file by name; with no listing it falls back
      // to the writer-derived filename.
      listFiles: vi.fn().mockResolvedValue({ files: [] }),
      readFile: vi.fn().mockRejectedValue(new Error('ENOENT')),
    };
    const gitService = {
      getFileAtCommit: overrides.getFileAtCommit ?? vi.fn().mockRejectedValue(new Error('not present')),
    };
    const slSourcesRepository = {
      deleteByConnectionAndName: vi.fn().mockResolvedValue(undefined),
    };
    const svc = new MemoryAgentService({
      settings: {
        knowledge: { userScopedKnowledgeEnabled: false },
        slValidation: { probeRowCount: 1 },
        llm: { memoryIngestionModel: 'test-model' },
      },
      promptService: undefined as never,
      skillsRegistry: undefined as never,
      wikiService: undefined as never,
      knowledgeIndex: undefined as never,
      knowledgeSlRefs: undefined as never,
      semanticLayerService: semanticLayerService as never,
      slSearchService: undefined as never,
      connections: connections as never,
      rootFileStore: configService as never,
      gitService: gitService as never,
      lockingService: undefined as never,
      slSourcesRepository: slSourcesRepository as never,
      sessionWorktreeService: undefined as never,
      semanticLayerSourceReconciler: undefined as never,
      agentRunner: undefined as never,
      slValidator: passthroughValidator,
      toolsetFactory: undefined as never,
    });
    return { svc, semanticLayerService, connections, configService, gitService, slSourcesRepository };
  };

  const session = {
    userId: 'u',
    chatId: 'c',
    userMessage: 'test',
    connectionId: 'conn-1',
    userScopedEnabled: false,
    forceGlobalScope: false,
    touchedSlSources: createTouchedSlSources([{ connectionId: 'conn-1', sourceName: 'broken_source' }]),
    preHead: null,
  };

  it('reverts (deletes) a source whose dry-run fails and drops its action', async () => {
    const badYaml = `name: broken_source
source_type: sql
sql: |
  SELECT fake_col FROM analytics.x
grain: [fake_col]
columns: [{name: fake_col, type: string}]
measures: []
joins: []
`;
    const { svc, configService } = buildService({
      readSourceFile: vi.fn().mockResolvedValue({ content: badYaml, path: 'x' }),
      executeQuery: vi.fn().mockResolvedValue({
        headers: [],
        rows: [],
        totalRows: 0,
        error: 'Unrecognized name: fake_col',
      }),
    });
    const actions: Action[] = [
      { target: 'sl', type: 'created', key: 'broken_source', detail: 'create' },
      { target: 'wiki', type: 'created', key: 'some_wiki', detail: 'wiki' },
    ];
    const localSession = {
      ...session,
      touchedSlSources: createTouchedSlSources([{ connectionId: 'conn-1', sourceName: 'broken_source' }]),
    };

    const reverted = await svc.gateRevertInvalidSources(localSession as never, actions);

    expect(reverted).toEqual(['broken_source']);
    expect(configService.deleteFile).toHaveBeenCalledWith(
      'semantic-layer/conn-1/broken_source.yaml',
      expect.any(String),
      expect.any(String),
      expect.any(String),
      { skipLock: true },
    );
    // Wiki action survives; SL action is scrubbed.
    expect(actions.map((a) => `${a.target}:${a.key}`)).toEqual(['wiki:some_wiki']);
    expect(hasTouchedSlSource(localSession.touchedSlSources, 'conn-1', 'broken_source')).toBe(false);
  });

  it('leaves a source alone when its dry-run passes', async () => {
    const goodYaml = `name: good_source
source_type: sql
sql: |
  SELECT id FROM analytics.x
grain: [id]
columns: [{name: id, type: string}]
measures: []
joins: []
`;
    const { svc, configService } = buildService({
      readSourceFile: vi.fn().mockResolvedValue({ content: goodYaml, path: 'x' }),
      executeQuery: vi.fn().mockResolvedValue({ headers: ['id'], rows: [], totalRows: 0, error: null }),
    });
    const actions: Action[] = [{ target: 'sl', type: 'created', key: 'good_source', detail: 'create' }];
    const localSession = {
      ...session,
      touchedSlSources: createTouchedSlSources([{ connectionId: 'conn-1', sourceName: 'good_source' }]),
    };

    const reverted = await svc.gateRevertInvalidSources(localSession as never, actions);

    expect(reverted).toEqual([]);
    expect(configService.writeFile).not.toHaveBeenCalled();
    expect(configService.deleteFile).not.toHaveBeenCalled();
    expect(actions).toHaveLength(1);
  });
});
