import { describe, expect, it, vi } from 'vitest';
import type { StagedExploreFile, StagedLookmlModelsFile } from '../../../../../src/context/ingest/adapters/looker/types.js';
import {
  buildLookerPullConfigFromInputs,
  collectExploreParseItems,
  computeLookerMappingDrift,
  discoverLookerConnections,
  lookerDialectToConnectionType,
  projectParsedIdentifier,
  refreshLookerMappingPlaceholders,
  sqlglotDialectForConnectionType,
  suggestKtxConnectionForLookerConnection,
  validateLookerMappings,
  validateLookerWarehouseTarget,
} from '../../../../../src/context/ingest/adapters/looker/mapping.js';

const liveConnections = [
  {
    name: 'b2b_sandbox_bq',
    host: 'warehouse.example.com',
    database: 'analytics',
    schema: null,
    dialect: 'bigquery_standard_sql',
  },
  {
    name: 'pg_runtime',
    host: 'pg.internal:5432',
    database: 'app',
    schema: 'public',
    dialect: 'postgres',
  },
];

const mappedExplore: StagedExploreFile = {
  modelName: 'b2b',
  exploreName: 'sales_pipeline',
  label: 'Sales Pipeline',
  description: null,
  rawSqlTableName: 'proj.analytics.opportunities AS opportunities',
  connectionName: 'b2b_sandbox_bq',
  viewName: 'opportunities',
  fields: { dimensions: [], measures: [] },
  joins: [
    {
      name: 'accounts',
      type: 'left_outer',
      relationship: 'many_to_one',
      rawSqlTableName: 'proj.analytics.accounts',
      sqlOn: null,
      from: null,
      targetTable: null,
    },
  ],
  targetWarehouseConnectionId: null,
  targetTable: null,
};

const models: StagedLookmlModelsFile = {
  models: [{ name: 'b2b', label: 'B2B', explores: [{ name: 'sales_pipeline', label: 'Sales Pipeline' }] }],
};

describe('discoverLookerConnections', () => {
  it('delegates to the runtime client connection discovery method', async () => {
    const client = { listLookerConnections: vi.fn().mockResolvedValue(liveConnections) };

    await expect(discoverLookerConnections(client)).resolves.toEqual(liveConnections);
    expect(client.listLookerConnections).toHaveBeenCalledTimes(1);
  });
});

describe('looker dialect and target validation helpers', () => {
  it('maps Looker dialect names to ktx connection types', () => {
    expect(lookerDialectToConnectionType('bigquery_standard_sql')).toBe('BIGQUERY');
    expect(lookerDialectToConnectionType('postgres')).toBe('POSTGRESQL');
    expect(lookerDialectToConnectionType('awsathena')).toBe('ATHENA');
    expect(lookerDialectToConnectionType('AWSATHENA')).toBe('ATHENA');
    expect(lookerDialectToConnectionType('mssql')).toBeNull();
    expect(lookerDialectToConnectionType('tsql')).toBeNull();
    expect(lookerDialectToConnectionType('unknown')).toBeNull();
  });

  it('maps supported warehouse connection types to sqlglot dialects', () => {
    expect(sqlglotDialectForConnectionType('BIGQUERY')).toBe('bigquery');
    expect(sqlglotDialectForConnectionType('POSTGRESQL')).toBe('postgres');
    expect(sqlglotDialectForConnectionType('ATHENA')).toBe('athena');
    expect(sqlglotDialectForConnectionType('LOOKER')).toBeNull();
  });

  it('returns a structured failure for unsupported Looker warehouse targets', () => {
    expect(validateLookerWarehouseTarget('LOOKER')).toEqual({
      ok: false,
      reason: 'Connection type LOOKER cannot be used as a Looker warehouse mapping target',
    });
  });
});

describe('suggestKtxConnectionForLookerConnection', () => {
  it('returns the single deterministic target with matching type, host, and database', () => {
    expect(
      suggestKtxConnectionForLookerConnection({
        lookerConnection: liveConnections[1],
        candidateConnections: [
          {
            id: 'wrong-type',
            connection_type: 'MYSQL',
            connection_params: { host: 'pg.internal', database: 'app' },
          },
          {
            id: 'pg-target',
            connection_type: 'POSTGRESQL',
            connection_params: { host: 'PG.INTERNAL', database: 'APP' },
          },
        ],
      }),
    ).toBe('pg-target');
  });

  it('returns null when more than one target matches', () => {
    expect(
      suggestKtxConnectionForLookerConnection({
        lookerConnection: liveConnections[1],
        candidateConnections: [
          {
            id: 'first',
            connection_type: 'POSTGRESQL',
            connection_params: { host: 'pg.internal', database: 'app' },
          },
          {
            id: 'second',
            connection_type: 'POSTGRESQL',
            connection_params: { host: 'pg.internal:5432', database: 'APP' },
          },
        ],
      }),
    ).toBeNull();
  });
});

describe('refreshLookerMappingPlaceholders', () => {
  it('adds newly discovered placeholders and refreshes live metadata without dropping saved targets', () => {
    expect(
      refreshLookerMappingPlaceholders({
        stored: [
          {
            lookerConnectionName: 'b2b_sandbox_bq',
            ktxConnectionId: 'warehouse',
            lookerHost: null,
            lookerDatabase: null,
            lookerDialect: null,
          },
        ],
        live: liveConnections,
      }),
    ).toEqual({
      changed: true,
      mappings: [
        {
          lookerConnectionName: 'b2b_sandbox_bq',
          ktxConnectionId: 'warehouse',
          lookerHost: 'warehouse.example.com',
          lookerDatabase: 'analytics',
          lookerDialect: 'bigquery_standard_sql',
        },
        {
          lookerConnectionName: 'pg_runtime',
          ktxConnectionId: null,
          lookerHost: 'pg.internal:5432',
          lookerDatabase: 'app',
          lookerDialect: 'postgres',
        },
      ],
    });
  });
});

describe('computeLookerMappingDrift and validateLookerMappings', () => {
  it('reports unmapped live connections, stale stored mappings, and in-sync mappings', () => {
    expect(
      computeLookerMappingDrift({
        storedMappings: [
          {
            lookerConnectionName: 'b2b_sandbox_bq',
            ktxConnectionId: 'warehouse',
            lookerHost: null,
            lookerDatabase: null,
            lookerDialect: null,
          },
          {
            lookerConnectionName: 'stale_runtime',
            ktxConnectionId: 'warehouse',
            lookerHost: null,
            lookerDatabase: null,
            lookerDialect: null,
          },
        ],
        discovered: liveConnections,
      }),
    ).toEqual({
      unmappedDiscovered: [liveConnections[1]],
      staleMappings: [{ lookerConnectionName: 'stale_runtime', reason: 'looker_connection_not_found' }],
      inSync: [{ lookerConnectionName: 'b2b_sandbox_bq', ktxConnectionId: 'warehouse' }],
    });
  });

  it('validates missing and unsupported target connection ids', () => {
    expect(
      validateLookerMappings({
        mappings: [
          {
            lookerConnectionName: 'b2b_sandbox_bq',
            ktxConnectionId: 'missing',
            lookerHost: null,
            lookerDatabase: null,
            lookerDialect: null,
          },
          {
            lookerConnectionName: 'pg_runtime',
            ktxConnectionId: 'looker-target',
            lookerHost: null,
            lookerDatabase: null,
            lookerDialect: null,
          },
        ],
        knownKtxConnectionIds: new Set(['looker-target']),
        knownConnectionTypes: new Map([['looker-target', 'LOOKER']]),
      }),
    ).toEqual({
      ok: false,
      errors: [
        { key: 'b2b_sandbox_bq', reason: 'ktx connection missing does not exist' },
        {
          key: 'pg_runtime',
          reason: 'Connection type LOOKER cannot be used as a Looker warehouse mapping target',
        },
      ],
    });
  });
});

describe('collectExploreParseItems and projectParsedIdentifier', () => {
  it('collects base explore and join parser inputs for mapped explores', () => {
    expect(
      collectExploreParseItems({
        explore: mappedExplore,
        connectionMappings: { b2b_sandbox_bq: 'warehouse' },
        targetConnections: new Map([['warehouse', { id: 'warehouse', connection_type: 'BIGQUERY' }]]),
      }),
    ).toEqual({
      parsedTargetTables: {},
      parseItems: [
        {
          key: 'b2b.sales_pipeline',
          sql_table_name: 'proj.analytics.opportunities AS opportunities',
          dialect: 'bigquery',
        },
        {
          key: 'b2b.sales_pipeline.accounts',
          sql_table_name: 'proj.analytics.accounts',
          dialect: 'bigquery',
        },
      ],
    });
  });

  it('collects Athena parser inputs with the athena sqlglot dialect', () => {
    expect(
      collectExploreParseItems({
        explore: {
          ...mappedExplore,
          rawSqlTableName: 'analytics.orders',
          joins: [
            {
              name: 'line_items',
              type: 'left_outer',
              relationship: 'one_to_many',
              rawSqlTableName: 'analytics.line_items',
              sqlOn: null,
              from: null,
              targetTable: null,
            },
          ],
        },
        connectionMappings: { b2b_sandbox_bq: 'athena-warehouse' },
        targetConnections: new Map([['athena-warehouse', { id: 'athena-warehouse', connection_type: 'ATHENA' }]]),
      }),
    ).toEqual({
      parsedTargetTables: {},
      parseItems: [
        {
          key: 'b2b.sales_pipeline',
          sql_table_name: 'analytics.orders',
          dialect: 'athena',
        },
        {
          key: 'b2b.sales_pipeline.line_items',
          sql_table_name: 'analytics.line_items',
          dialect: 'athena',
        },
      ],
    });
  });

  it('projects successful and failed parser rows into ktx parsed target tables', () => {
    expect(
      projectParsedIdentifier({
        ok: true,
        catalog: 'proj',
        schema: 'analytics',
        name: 'accounts',
        canonical_table: 'proj.analytics.accounts',
      }),
    ).toEqual({
      ok: true,
      catalog: 'proj',
      schema: 'analytics',
      name: 'accounts',
      canonicalTable: 'proj.analytics.accounts',
    });

    expect(projectParsedIdentifier({ ok: false, reason: 'derived_table_not_supported' })).toEqual({
      ok: false,
      reason: 'derived_table_not_supported',
    });
  });
});

describe('buildLookerPullConfigFromInputs', () => {
  it('builds the hosted-equivalent Looker pull config from caller-loaded inputs', async () => {
    const parser = {
      parse: vi.fn().mockResolvedValue({
        'b2b.sales_pipeline': {
          ok: true,
          catalog: 'proj',
          schema: 'analytics',
          name: 'opportunities',
          canonical_table: 'proj.analytics.opportunities',
        },
        'b2b.sales_pipeline.accounts': {
          ok: true,
          catalog: 'proj',
          schema: 'analytics',
          name: 'accounts',
          canonical_table: 'proj.analytics.accounts',
        },
      }),
    };
    const client = {
      listLookmlModels: vi.fn().mockResolvedValue(models),
      getExplore: vi.fn().mockResolvedValue(mappedExplore),
    };

    await expect(
      buildLookerPullConfigFromInputs({
        lookerConnectionId: 'prod-looker',
        cursors: {
          dashboardsLastSyncedAt: '2026-05-01T00:00:00.000Z',
          looksLastSyncedAt: null,
        },
        refreshedMappings: [
          {
            lookerConnectionName: 'b2b_sandbox_bq',
            ktxConnectionId: 'warehouse',
            lookerHost: 'warehouse.example.com',
            lookerDatabase: 'analytics',
            lookerDialect: 'bigquery_standard_sql',
          },
        ],
        targetConnections: new Map([['warehouse', { id: 'warehouse', connection_type: 'BIGQUERY' }]]),
        client,
        parser,
      }),
    ).resolves.toEqual({
      lookerConnectionId: 'prod-looker',
      dashboardUpdatedSince: '2026-05-01T00:00:00.000Z',
      lookUpdatedSince: null,
      connectionMappings: { b2b_sandbox_bq: 'warehouse' },
      connectionTypes: { b2b_sandbox_bq: 'BIGQUERY' },
      parsedTargetTables: {
        'b2b.sales_pipeline': {
          ok: true,
          catalog: 'proj',
          schema: 'analytics',
          name: 'opportunities',
          canonicalTable: 'proj.analytics.opportunities',
        },
        'b2b.sales_pipeline.accounts': {
          ok: true,
          catalog: 'proj',
          schema: 'analytics',
          name: 'accounts',
          canonicalTable: 'proj.analytics.accounts',
        },
      },
    });
  });

  it('marks parser failures as parse_error without blocking pull-config construction', async () => {
    const parser = { parse: vi.fn().mockRejectedValue(new Error('python unavailable')) };
    const client = {
      listLookmlModels: vi.fn().mockResolvedValue(models),
      getExplore: vi.fn().mockResolvedValue(mappedExplore),
    };

    const config = await buildLookerPullConfigFromInputs({
      lookerConnectionId: 'prod-looker',
      cursors: { dashboardsLastSyncedAt: null, looksLastSyncedAt: null },
      refreshedMappings: [
        {
          lookerConnectionName: 'b2b_sandbox_bq',
          ktxConnectionId: 'warehouse',
          lookerHost: null,
          lookerDatabase: null,
          lookerDialect: null,
        },
      ],
      targetConnections: new Map([['warehouse', { id: 'warehouse', connection_type: 'BIGQUERY' }]]),
      client,
      parser,
    });

    expect(config.parsedTargetTables).toMatchObject({
      'b2b.sales_pipeline': { ok: false, reason: 'parse_error' },
      'b2b.sales_pipeline.accounts': { ok: false, reason: 'parse_error' },
    });
  });
});
