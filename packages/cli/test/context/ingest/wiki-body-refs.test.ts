import { describe, expect, it } from 'vitest';
import {
  findInvalidWikiBodyRefIssues,
  findInvalidWikiBodyRefs,
  parseWikiBodyRefs,
} from '../../../src/context/ingest/wiki-body-refs.js';

const sources = [
  {
    name: 'mart_account_segments',
    grain: ['account_id'],
    columns: [
      { name: 'account_id', type: 'string' },
      { name: 'segment', type: 'string' },
    ],
    joins: [],
    measures: [{ name: 'total_contract_arr', expr: 'sum(contract_arr)' }],
    segments: [{ name: 'enterprise', expr: "segment = 'enterprise'" }],
    table: 'analytics.mart_account_segments',
  },
];

describe('wiki body refs', () => {
  it('parses only explicit inline-code body references outside fenced blocks', () => {
    const body = [
      'Valid `mart_account_segments.total_contract_arr` and `source:mart_account_segments`.',
      'Also `warehouse/mart_account_segments.segment` and `table:analytics.mart_account_segments`.',
      'Ignore prose mart_account_segments.total_contract_arr_cents.',
      'Ignore `single_token`.',
      'Ignore wildcard pattern `mart_nrr_quarterly.*_arr_cents`.',
      'Ignore condition `users.is_internal = false`.',
      '```sql',
      'select `mart_account_segments.total_contract_arr_cents`',
      '```',
    ].join('\n');

    expect(parseWikiBodyRefs(body)).toEqual([
      {
        kind: 'sl_entity',
        connectionId: null,
        sourceName: 'mart_account_segments',
        entityName: 'total_contract_arr',
        rawToken: 'mart_account_segments.total_contract_arr',
      },
      {
        kind: 'sl_source',
        connectionId: null,
        sourceName: 'mart_account_segments',
        rawToken: 'source:mart_account_segments',
      },
      {
        kind: 'sl_entity',
        connectionId: 'warehouse',
        sourceName: 'mart_account_segments',
        entityName: 'segment',
        rawToken: 'warehouse/mart_account_segments.segment',
      },
      {
        kind: 'table',
        connectionId: null,
        tableRef: 'analytics.mart_account_segments',
        rawToken: 'table:analytics.mart_account_segments',
      },
    ]);
  });

  it('rejects stale inline-code semantic-layer references', async () => {
    const invalid = await findInvalidWikiBodyRefs({
      pageKey: 'account-segments',
      body: 'ARR is documented as `mart_account_segments.total_contract_arr_cents`.',
      visibleConnectionIds: ['warehouse'],
      loadSources: async () => sources,
      tableExists: async () => true,
    });

    expect(invalid).toEqual([
      'account-segments: unknown semantic-layer entity mart_account_segments.total_contract_arr_cents',
    ]);
  });

  it('does not treat wildcard inline-code patterns as exact semantic-layer entity references', async () => {
    const invalid = await findInvalidWikiBodyRefs({
      pageKey: 'revenue-metrics-encoding',
      body: 'Cents columns include `mart_nrr_quarterly.*_arr_cents` and `mart_retention_movement_breakout.*_arr_cents`.',
      visibleConnectionIds: ['warehouse'],
      loadSources: async () => [
        { name: 'mart_nrr_quarterly', grain: [], columns: [], joins: [], measures: [], table: 'analytics.mart_nrr_quarterly' },
        {
          name: 'mart_retention_movement_breakout',
          grain: [],
          columns: [],
          joins: [],
          measures: [],
          table: 'analytics.mart_retention_movement_breakout',
        },
      ],
      tableExists: async () => true,
    });

    expect(invalid).toEqual([]);
  });

  it('does not treat inline-code SQL predicates as exact semantic-layer entity references', async () => {
    const invalid = await findInvalidWikiBodyRefs({
      pageKey: 'account-reporting-exclusions',
      body: 'Exclude internal users with `users.is_internal = false` and test users with `users.is_test = false`.',
      visibleConnectionIds: ['warehouse'],
      loadSources: async () => [
        {
          name: 'users',
          grain: [],
          columns: [
            { name: 'is_internal', type: 'boolean' },
            { name: 'is_test', type: 'boolean' },
          ],
          joins: [],
          measures: [],
          table: 'analytics.users',
        },
      ],
      tableExists: async () => true,
    });

    expect(invalid).toEqual([]);
  });

  it('validates source, dimension, segment, measure, and table references', async () => {
    const invalid = await findInvalidWikiBodyRefs({
      pageKey: 'account-segments',
      body: [
        '`mart_account_segments.total_contract_arr`',
        '`mart_account_segments.segment`',
        '`mart_account_segments.enterprise`',
        '`source:mart_account_segments`',
        '`table:analytics.mart_account_segments`',
      ].join('\n'),
      visibleConnectionIds: ['warehouse'],
      loadSources: async () => sources,
      tableExists: async (_connectionId, tableRef) => tableRef === 'analytics.mart_account_segments',
    });

    expect(invalid).toEqual([]);
  });

  it('ignores two-part inline code when the source is not visible', async () => {
    const invalid = await findInvalidWikiBodyRefs({
      pageKey: 'engineering-notes',
      body: [
        'A version token like `node.v22` is not a semantic-layer reference.',
        'A raw table must use `table:analytics.mart_account_segments`.',
      ].join('\n'),
      visibleConnectionIds: ['warehouse'],
      loadSources: async () => sources,
      tableExists: async (_connectionId, tableRef) => tableRef === 'analytics.mart_account_segments',
    });

    expect(invalid).toEqual([]);
  });

  it('still rejects explicit missing source and table references', async () => {
    const invalid = await findInvalidWikiBodyRefs({
      pageKey: 'account-segments',
      body: [
        '`source:missing_source`',
        '`warehouse/source:missing_source`',
        '`table:analytics.missing_table`',
      ].join('\n'),
      visibleConnectionIds: ['warehouse'],
      loadSources: async () => sources,
      tableExists: async () => false,
    });

    expect(invalid).toEqual([
      'account-segments: unknown semantic-layer source missing_source',
      'account-segments: unknown semantic-layer source warehouse/missing_source',
      'account-segments: unknown raw table analytics.missing_table',
    ]);
  });

  it('returns structured body ref issues with raw tokens', async () => {
    const issues = await findInvalidWikiBodyRefIssues({
      pageKey: 'revenue',
      body: '`orders.missing_measure`\n`source:missing_source`\n`table:analytics.missing_table`',
      visibleConnectionIds: ['warehouse'],
      loadSources: async () => [
        { name: 'orders', columns: [{ name: 'id', type: 'number' }], measures: [], segments: [], joins: [] },
      ] as never,
      tableExists: async () => false,
    });

    expect(issues).toEqual([
      {
        kind: 'missing_wiki_body_sl_entity',
        pageKey: 'revenue',
        rawToken: 'orders.missing_measure',
        sourceName: 'orders',
        entityName: 'missing_measure',
        message: 'revenue: unknown semantic-layer entity orders.missing_measure',
      },
      {
        kind: 'missing_wiki_body_sl_source',
        pageKey: 'revenue',
        rawToken: 'source:missing_source',
        sourceName: 'missing_source',
        message: 'revenue: unknown semantic-layer source missing_source',
      },
      {
        kind: 'missing_wiki_body_table',
        pageKey: 'revenue',
        rawToken: 'table:analytics.missing_table',
        tableRef: 'analytics.missing_table',
        message: 'revenue: unknown raw table analytics.missing_table',
      },
    ]);
  });
});
