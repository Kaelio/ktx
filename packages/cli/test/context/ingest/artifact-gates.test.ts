import { describe, expect, it, vi } from 'vitest';
import { validateFinalIngestArtifacts, validateProvenanceRawPaths } from '../../../src/context/ingest/artifact-gates.js';

function wikiServiceWithPages(
  pages: Record<string, { refs?: string[]; content?: string; slRefs?: string[] }>,
) {
  return {
    listPageKeys: vi.fn().mockResolvedValue(Object.keys(pages)),
    readPage: vi.fn().mockImplementation((_scope: string, _scopeId: string | null, pageKey: string) => {
      const page = pages[pageKey];
      if (!page) {
        return Promise.resolve(null);
      }
      return Promise.resolve({
        pageKey,
        frontmatter: {
          summary: pageKey,
          usage_mode: 'auto',
          refs: page.refs,
          sl_refs: page.slRefs,
        },
        content: page.content ?? '',
      });
    }),
  };
}

describe('artifact gates', () => {
  it('fails the final tree when wiki body references a stale semantic-layer measure', async () => {
    const wikiService = wikiServiceWithPages({
      'account-segments': {
        slRefs: ['mart_account_segments'],
        content: 'ARR is `mart_account_segments.total_contract_arr_cents`.',
      },
    });
    const semanticLayerService = {
      loadAllSources: vi.fn().mockResolvedValue({
        sources: [
          {
            name: 'mart_account_segments',
            grain: ['account_id'],
            columns: [{ name: 'account_id', type: 'string' }],
            joins: [],
            measures: [{ name: 'total_contract_arr', expr: 'sum(contract_arr)' }],
            table: 'analytics.mart_account_segments',
          },
        ],
        loadErrors: [],
      }),
    };

    await expect(
      validateFinalIngestArtifacts({
        connectionIds: ['warehouse'],
        changedWikiPageKeys: ['account-segments'],
        touchedSlSources: [{ connectionId: 'warehouse', sourceName: 'mart_account_segments' }],
        wikiService: wikiService as never,
        semanticLayerService: semanticLayerService as never,
        validateTouchedSources: async () => ({ invalidSources: [], validSources: ['mart_account_segments'] }),
        tableExists: async () => true,
      }),
    ).resolves.toMatchObject({
      ok: false,
      findings: [
        {
          kind: 'missing_wiki_body_sl_entity',
          message: 'account-segments: unknown semantic-layer entity mart_account_segments.total_contract_arr_cents',
        },
      ],
    });
  });

  it('fails before provenance insertion when a raw path cannot be tied to the current snapshot or eviction set', () => {
    expect(() =>
      validateProvenanceRawPaths({
        rows: [{ rawPath: 'cards/missing.json' }],
        currentRawPaths: new Set(['cards/present.json']),
        deletedRawPaths: new Set(['cards/deleted.json']),
      }),
    ).toThrow(/provenance row references raw path outside this snapshot: cards\/missing\.json/);
  });

  it('accepts equivalent provenance raw paths across platform path separators', () => {
    expect(() =>
      validateProvenanceRawPaths({
        rows: [
          { rawPath: 'docs/herness-a88aa1bf05/page.md' },
          { rawPath: 'docs/herness-a88aa1bf05/metadata.json' },
        ],
        currentRawPaths: new Set(['docs\\herness-a88aa1bf05\\page.md', 'docs\\herness-a88aa1bf05\\metadata.json']),
        deletedRawPaths: new Set(),
      }),
    ).not.toThrow();
  });

  it('fails measure-level wiki frontmatter sl_refs that point at missing entities', async () => {
    const wikiService = wikiServiceWithPages({
      'account-segments': {
        slRefs: ['mart_account_segments.total_contract_arr_cents'],
        content: 'ARR uses a renamed measure.',
      },
    });
    const semanticLayerService = {
      loadAllSources: vi.fn().mockResolvedValue({
        sources: [
          {
            name: 'mart_account_segments',
            grain: ['account_id'],
            columns: [{ name: 'account_id', type: 'string' }],
            joins: [],
            measures: [{ name: 'total_contract_arr', expr: 'sum(contract_arr)' }],
            table: 'analytics.mart_account_segments',
          },
        ],
        loadErrors: [],
      }),
    };

    await expect(
      validateFinalIngestArtifacts({
        connectionIds: ['warehouse'],
        changedWikiPageKeys: ['account-segments'],
        touchedSlSources: [{ connectionId: 'warehouse', sourceName: 'mart_account_segments' }],
        wikiService: wikiService as never,
        semanticLayerService: semanticLayerService as never,
        validateTouchedSources: async () => ({ invalidSources: [], validSources: ['warehouse:mart_account_segments'] }),
        tableExists: async () => true,
      }),
    ).resolves.toMatchObject({
      ok: false,
      findings: [
        {
          kind: 'missing_wiki_sl_ref',
          message: 'account-segments: unknown sl_refs entity mart_account_segments.total_contract_arr_cents',
        },
      ],
    });
  });

  it('passes touched sources to the shared validation path and surfaces its reasons', async () => {
    // Join-neighbor expansion lives inside validateTouchedSources (the same
    // path work units use); the gate hands over the raw touched set and must
    // carry the per-source reasons into the failure it throws.
    const semanticLayerService = {
      loadAllSources: vi.fn().mockResolvedValue({ sources: [], loadErrors: [] }),
    };
    const validateTouchedSources = vi.fn().mockResolvedValue({
      validSources: [],
      invalidSources: [
        {
          source: 'warehouse:mart_account_segments',
          errors: ['join target "accounts" does not exist'],
        },
      ],
    });

    await expect(
      validateFinalIngestArtifacts({
        connectionIds: ['warehouse'],
        changedWikiPageKeys: [],
        touchedSlSources: [{ connectionId: 'warehouse', sourceName: 'mart_account_segments' }],
        wikiService: { readPage: vi.fn() } as never,
        semanticLayerService: semanticLayerService as never,
        validateTouchedSources,
        tableExists: async () => true,
      }),
    ).resolves.toMatchObject({
      ok: false,
      findings: [
        {
          kind: 'invalid_source',
          connectionId: 'warehouse',
          sourceName: 'mart_account_segments',
          errors: ['join target "accounts" does not exist'],
        },
      ],
    });

    expect(validateTouchedSources).toHaveBeenCalledWith([
      { connectionId: 'warehouse', sourceName: 'mart_account_segments' },
    ]);
  });

  it('fails final gates when a changed wiki page references a missing wiki page', async () => {
    const wikiService = wikiServiceWithPages({
      'account-segments': {
        refs: ['missing-frontmatter-page'],
        content: 'See [[missing-inline-page]] for the related process.',
      },
    });
    const semanticLayerService = {
      loadAllSources: vi.fn().mockResolvedValue({ sources: [], loadErrors: [] }),
    };

    await expect(
      validateFinalIngestArtifacts({
        connectionIds: ['warehouse'],
        changedWikiPageKeys: ['account-segments'],
        touchedSlSources: [],
        wikiService: wikiService as never,
        semanticLayerService: semanticLayerService as never,
        validateTouchedSources: async () => ({ invalidSources: [], validSources: [] }),
        tableExists: async () => true,
      }),
    ).resolves.toMatchObject({
      ok: false,
      findings: [
        { kind: 'missing_wiki_ref', targetPageKey: 'missing-frontmatter-page' },
        { kind: 'missing_wiki_ref', targetPageKey: 'missing-inline-page' },
      ],
    });
  });

  it('returns structured final gate findings instead of throwing', async () => {
    const wikiService = wikiServiceWithPages({
      'account-segments': {
        refs: ['missing-page'],
        slRefs: ['missing_source'],
        content: 'Revenue depends on `source:missing_source`.',
      },
    });
    const semanticLayerService = {
      loadAllSources: vi.fn().mockResolvedValue({ sources: [], loadErrors: [] }),
    };

    const result = await validateFinalIngestArtifacts({
      connectionIds: ['warehouse'],
      changedWikiPageKeys: ['account-segments'],
      touchedSlSources: [{ connectionId: 'warehouse', sourceName: 'orders' }],
      wikiService: wikiService as never,
      semanticLayerService: semanticLayerService as never,
      validateTouchedSources: async () => ({
        validSources: [],
        invalidSources: [
          {
            source: 'warehouse:orders',
            errors: ['dry run failed', 'join target "customers" does not exist'],
            issues: [
              { kind: 'source_validation', message: 'dry run failed' },
              {
                kind: 'missing_join_target',
                targetSourceName: 'customers',
                caseMismatch: null,
                message: 'join target "customers" does not exist',
              },
            ],
          },
        ],
      }),
      tableExists: async () => true,
    });

    expect(result).toEqual({
      ok: false,
      findings: [
        { kind: 'invalid_source', connectionId: 'warehouse', sourceName: 'orders', errors: ['dry run failed'] },
        {
          kind: 'missing_join_target',
          ownerConnectionId: 'warehouse',
          ownerSourceName: 'orders',
          targetSourceName: 'customers',
          message: 'join target "customers" does not exist',
        },
        {
          kind: 'missing_wiki_sl_ref',
          pageKey: 'account-segments',
          ref: 'missing_source',
          sourceName: 'missing_source',
          entityName: null,
          message: 'account-segments: unknown sl_refs entry missing_source',
        },
        {
          kind: 'missing_wiki_ref',
          pageKey: 'account-segments',
          targetPageKey: 'missing-page',
          message: 'account-segments -> missing-page',
        },
        {
          kind: 'missing_wiki_body_sl_source',
          pageKey: 'account-segments',
          rawToken: 'source:missing_source',
          sourceName: 'missing_source',
          message: 'account-segments: unknown semantic-layer source missing_source',
        },
      ],
    });
  });
});
