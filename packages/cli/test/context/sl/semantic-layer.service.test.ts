import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { Mock } from 'vitest';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { initKtxProject, type KtxLocalProject } from '../../../src/context/project/project.js';

import {
  ColumnNameCollisionError,
  composeOverlay,
  ConflictingExcludeAndOverrideError,
  enrichColumnsFromManifest,
  findDanglingSegmentRefs,
  projectManifestEntry,
  SemanticLayerService,
  toResolvedWire,
  UnknownColumnOverrideError,
} from '../../../src/context/sl/semantic-layer.service.js';
import { resolvedSourceSchema, sourceDefinitionSchema, sourceOverlaySchema } from '../../../src/context/sl/schemas.js';
import type { SemanticLayerSource } from '../../../src/context/sl/types.js';

const pythonPort = {
  validateSources: vi.fn(),
  generateSources: vi.fn(),
  query: vi.fn(),
};

function connectionCatalog(connectionType = 'SNOWFLAKE') {
  return {
    listEnabledConnections: vi.fn().mockResolvedValue([]),
    getConnectionById: vi.fn().mockResolvedValue({ id: 'conn-1', name: 'conn-1', connectionType }),
    executeQuery: vi.fn(),
  };
}

const baseTable: SemanticLayerSource = {
  name: 'fct_labs',
  grain: ['lab_order_id'],
  table: 'analytics.fct_labs',
  columns: [
    { name: 'lab_order_id', type: 'string' },
    { name: 'admin_user_id', type: 'string' },
    { name: 'lab_type', type: 'string' },
  ],
  joins: [],
  measures: [],
};

describe('listConnectionIdsWithNames', () => {
  it('discovers local ktx connection ids from semantic-layer directories', async () => {
    const configService = {
      listFiles: vi.fn().mockResolvedValue({
        files: [
          'semantic-layer/warehouse/_schema/public.yaml',
          'semantic-layer/dbt-main/orders.yaml',
          'semantic-layer/.gitkeep',
        ],
      }),
    };
    const catalog = connectionCatalog();
    catalog.listEnabledConnections.mockImplementation(async (ids: string[]) =>
      ids.map((id) => ({ id, name: id, connectionType: id === 'warehouse' ? 'postgres' : 'dbt' })),
    );
    const service = new SemanticLayerService(configService as never, catalog, pythonPort);

    await expect(service.listConnectionIdsWithNames()).resolves.toEqual([
      { id: 'dbt-main', name: 'dbt-main', connectionType: 'dbt' },
      { id: 'warehouse', name: 'warehouse', connectionType: 'postgres' },
    ]);
    expect(catalog.listEnabledConnections).toHaveBeenCalledWith(['dbt-main', 'warehouse']);
  });
});

describe('loadSource', () => {
  it('warns and returns null when an existing source file has invalid YAML', async () => {
    const logger = { log: vi.fn(), warn: vi.fn(), error: vi.fn() };
    const configService = {
      listFiles: vi.fn().mockResolvedValue({ files: ['semantic-layer/warehouse/orders.yaml'] }),
      readFile: vi.fn().mockResolvedValue({ content: 'name: [' }),
    };
    const service = new SemanticLayerService(configService as never, connectionCatalog(), pythonPort, logger as never);

    await expect(service.loadSource('warehouse', 'orders')).resolves.toBeNull();

    expect(configService.readFile).toHaveBeenCalledWith('semantic-layer/warehouse/orders.yaml');
    expect(logger.warn).toHaveBeenCalledWith(
      expect.stringContaining('[loadSource] semantic-layer/warehouse/orders.yaml: YAML parse failed:'),
    );
  });

  it('returns null when no file declares the source name', async () => {
    const configService = {
      listFiles: vi.fn().mockResolvedValue({ files: [] }),
      readFile: vi.fn(),
    };
    const service = new SemanticLayerService(configService as never, connectionCatalog(), pythonPort);

    await expect(service.loadSource('warehouse', 'orders')).resolves.toBeNull();
    expect(configService.readFile).not.toHaveBeenCalled();
  });

  it('resolves a source by its in-file name when the filename differs', async () => {
    const configService = {
      listFiles: vi.fn().mockResolvedValue({ files: ['semantic-layer/warehouse/renamed.yaml'] }),
      readFile: vi.fn().mockResolvedValue({ content: 'name: SIGNED_UP\nmeasures: []\n' }),
    };
    const service = new SemanticLayerService(configService as never, connectionCatalog(), pythonPort);

    await expect(service.loadSource('warehouse', 'SIGNED_UP')).resolves.toEqual({
      name: 'SIGNED_UP',
      measures: [],
    });
  });
});

describe('composeOverlay', () => {
  it('carries top-level segments from overlay into the composed source', () => {
    const overlay = {
      name: 'fct_labs',
      segments: [{ name: 'byol', expr: "lab_type = 'byol'", description: 'BYOL cohort' }],
    };
    const composed = composeOverlay(baseTable, overlay);
    expect(composed.segments).toHaveLength(1);
    expect(composed.segments?.[0].name).toBe('byol');
    expect(composed.segments?.[0].expr).toBe("lab_type = 'byol'");
  });

  it('preserves measure-level segments references', () => {
    const overlay = {
      name: 'fct_labs',
      segments: [{ name: 'byol', expr: "lab_type = 'byol'" }],
      measures: [
        {
          name: 'byol_subscriber_count',
          expr: 'count(distinct admin_user_id)',
          segments: ['byol'],
          description: 'BYOL subscribers',
        },
      ],
    };
    const composed = composeOverlay(baseTable, overlay);
    expect(composed.measures).toHaveLength(1);
    expect(composed.measures[0].segments).toEqual(['byol']);
  });

  it('leaves base segments unchanged when overlay does not specify segments', () => {
    const baseWithSegments: SemanticLayerSource = {
      ...baseTable,
      segments: [{ name: 'pre_existing', expr: 'is_paid = true' }],
    };
    const overlay = { name: 'fct_labs', descriptions: { user: 'no segments here' } };
    const composed = composeOverlay(baseWithSegments, overlay);
    expect(composed.segments).toEqual([{ name: 'pre_existing', expr: 'is_paid = true' }]);
  });

  it('replaces base segments when overlay provides its own (even an empty array)', () => {
    const baseWithSegments: SemanticLayerSource = {
      ...baseTable,
      segments: [{ name: 'pre_existing', expr: 'is_paid = true' }],
    };
    const overlay = { name: 'fct_labs', segments: [] };
    const composed = composeOverlay(baseWithSegments, overlay);
    expect(composed.segments).toEqual([]);
  });

  it('throws on unknown top-level overlay keys with a pointed error', () => {
    const overlay = { name: 'fct_labs', frobnicate: true };
    expect(() => composeOverlay(baseTable, overlay)).toThrow(
      /overlay for 'fct_labs' has unhandled keys \[frobnicate\]/,
    );
  });

  it('lists every unknown key in the error message, not just the first', () => {
    const overlay = { name: 'fct_labs', foo: 1, bar: 2 };
    expect(() => composeOverlay(baseTable, overlay)).toThrow(/foo, bar/);
  });

  it('still handles existing known keys without regression', () => {
    const overlay = {
      name: 'fct_labs',
      descriptions: { user: 'patient lab orders' },
      exclude_columns: ['admin_user_id'],
      columns: [{ name: 'is_byol', type: 'boolean', expr: "lab_type = 'byol'" }],
      measures: [{ name: 'count_all', expr: 'count(*)' }],
    };
    const composed = composeOverlay(baseTable, overlay);
    expect(composed.columns.find((c) => c.name === 'admin_user_id')).toBeUndefined();
    expect(composed.columns.find((c) => c.name === 'is_byol')).toBeDefined();
    expect(composed.measures).toHaveLength(1);
  });

  it('applies column_overrides to same-named manifest columns', () => {
    const overlay = {
      name: 'fct_labs',
      column_overrides: [
        { name: 'lab_order_id', descriptions: { user: 'Primary key' } },
        { name: 'admin_user_id', descriptions: { user: 'FK to admin_users' } },
      ],
    };
    const composed = composeOverlay(baseTable, overlay);
    // No duplicate columns appended — same-named overlay entries merged onto the base.
    expect(composed.columns).toHaveLength(3);
    const labOrder = composed.columns.find((c) => c.name === 'lab_order_id');
    expect(labOrder?.type).toBe('string');
    expect(labOrder?.descriptions).toEqual({ user: 'Primary key' });
    const adminUser = composed.columns.find((c) => c.name === 'admin_user_id');
    expect(adminUser?.type).toBe('string');
    expect(adminUser?.descriptions).toEqual({ user: 'FK to admin_users' });
  });

  it('appends computed columns alongside column overrides', () => {
    const overlay = {
      name: 'fct_labs',
      column_overrides: [
        { name: 'lab_order_id', descriptions: { user: 'PK doc' } },
      ],
      columns: [
        { name: 'is_byol', type: 'boolean', expr: "lab_type = 'byol'" },
      ],
    };
    const composed = composeOverlay(baseTable, overlay);
    expect(composed.columns).toHaveLength(4);
    expect(composed.columns.find((c) => c.name === 'is_byol')?.expr).toBe("lab_type = 'byol'");
    expect(composed.columns.find((c) => c.name === 'lab_order_id')?.type).toBe('string');
  });

  it('rejects column_overrides that target unknown manifest columns', () => {
    expect(() =>
      composeOverlay(baseTable, {
        name: 'fct_labs',
        column_overrides: [{ name: 'missing', descriptions: { user: 'Nope' } }],
      }),
    ).toThrow(UnknownColumnOverrideError);
  });

  it('rejects computed columns whose names collide with manifest columns', () => {
    expect(() =>
      composeOverlay(baseTable, {
        name: 'fct_labs',
        columns: [{ name: 'lab_order_id', type: 'string', expr: 'lab_order_id' }],
      }),
    ).toThrow(ColumnNameCollisionError);
  });

  it('rejects exclude/override conflicts before applying exclusions', () => {
    expect(() =>
      composeOverlay(baseTable, {
        name: 'fct_labs',
        exclude_columns: ['lab_order_id'],
        column_overrides: [{ name: 'lab_order_id', descriptions: { user: 'Hidden PK' } }],
      }),
    ).toThrow(ConflictingExcludeAndOverrideError);
  });

  it('merges overlay descriptions (plural) with base descriptions keyed by source', () => {
    const baseWithDescriptions: SemanticLayerSource = {
      ...baseTable,
      descriptions: { db: 'scan-derived description', ai: 'AI description' },
    };
    const overlay = {
      name: 'fct_labs',
      descriptions: { dbt: 'dbt description', ai: 'AI description (overridden)' },
    };
    const composed = composeOverlay(baseWithDescriptions, overlay);
    expect(composed.descriptions).toEqual({
      db: 'scan-derived description',
      ai: 'AI description (overridden)',
      dbt: 'dbt description',
    });
  });

  it('replaces manifest usage only when an overlay explicitly provides usage', () => {
    const baseWithUsage: SemanticLayerSource = {
      ...baseTable,
      usage: {
        narrative: 'Orders are commonly queried by lifecycle status.',
        frequencyTier: 'high',
        commonFilters: ['status'],
        commonJoins: [{ table: 'public.customers', on: ['customer_id'] }],
      },
    };

    expect(composeOverlay(baseWithUsage, { name: 'fct_labs', measures: [] }).usage).toEqual(baseWithUsage.usage);

    const composed = composeOverlay(baseWithUsage, {
      name: 'fct_labs',
      usage: {
        narrative: 'Overlay-curated usage note.',
        frequencyTier: 'mid',
        commonFilters: ['created_at'],
        commonGroupBys: ['created_at'],
        commonJoins: [],
      },
    });

    expect(composed.usage).toEqual({
      narrative: 'Overlay-curated usage note.',
      frequencyTier: 'mid',
      commonFilters: ['created_at'],
      commonGroupBys: ['created_at'],
      commonJoins: [],
    });
  });
});

describe('enrichColumnsFromManifest', () => {
  const manifest: SemanticLayerSource = {
    name: 'CONSIGNMENTS',
    table: 'ANALYTICS.MARTS.CONSIGNMENTS',
    grain: ['CONSIGNED_ITEM_ID'],
    columns: [
      {
        name: 'CONSIGNED_ITEM_ID',
        type: 'string',
        descriptions: { ai: 'Unique identifier for the consigned item record.' },
      },
      {
        name: 'CASH_ADV_AMOUNT',
        type: 'number',
        descriptions: { ai: 'Amount of cash advance disbursed to consigners.' },
      },
      {
        name: 'CONSIGNMENT_CREATED_AT',
        type: 'time',
        role: 'time',
        descriptions: { ai: 'Timestamp when the consignment was created.' },
      },
    ],
    joins: [],
    measures: [],
  };

  it('fills blank type and descriptions on source columns from the manifest', () => {
    const source: SemanticLayerSource = {
      name: 'aav_consignments',
      sql: 'SELECT CONSIGNED_ITEM_ID, CASH_ADV_AMOUNT FROM MARTS.CONSIGNMENTS WHERE ...',
      inherits_columns_from: 'CONSIGNMENTS',
      grain: ['CONSIGNED_ITEM_ID'],
      columns: [
        { name: 'CONSIGNED_ITEM_ID', type: '' },
        { name: 'CASH_ADV_AMOUNT', type: '' },
      ],
      joins: [],
      measures: [],
    };
    const enriched = enrichColumnsFromManifest(source, manifest);
    expect(enriched.columns[0]).toEqual({
      name: 'CONSIGNED_ITEM_ID',
      type: 'string',
      descriptions: { ai: 'Unique identifier for the consigned item record.' },
    });
    expect(enriched.columns[1]).toEqual({
      name: 'CASH_ADV_AMOUNT',
      type: 'number',
      descriptions: { ai: 'Amount of cash advance disbursed to consigners.' },
    });
  });

  it('preserves a local description if the source already declared one', () => {
    const source: SemanticLayerSource = {
      name: 'aav_consignments',
      sql: 'SELECT CONSIGNED_ITEM_ID FROM ...',
      inherits_columns_from: 'CONSIGNMENTS',
      grain: ['CONSIGNED_ITEM_ID'],
      columns: [
        {
          name: 'CONSIGNED_ITEM_ID',
          type: 'string',
          descriptions: { ai: 'AAV-specific note: always non-null in this filtered view.' },
        },
      ],
      joins: [],
      measures: [],
    };
    const enriched = enrichColumnsFromManifest(source, manifest);
    expect(enriched.columns[0].descriptions).toEqual({
      ai: 'AAV-specific note: always non-null in this filtered view.',
    });
  });

  it('passes through columns absent from the manifest unchanged', () => {
    const source: SemanticLayerSource = {
      name: 'aav_consignments',
      sql: 'SELECT ALT_VALUE_COMBINED, my_derived FROM ...',
      inherits_columns_from: 'CONSIGNMENTS',
      grain: ['CONSIGNED_ITEM_ID'],
      columns: [{ name: 'my_derived', type: 'number', expr: 'CASH_ADV_AMOUNT * 2' }],
      joins: [],
      measures: [],
    };
    const enriched = enrichColumnsFromManifest(source, manifest);
    expect(enriched.columns[0]).toEqual({
      name: 'my_derived',
      type: 'number',
      expr: 'CASH_ADV_AMOUNT * 2',
    });
  });

  it('copies role from the manifest when the source omits it', () => {
    const source: SemanticLayerSource = {
      name: 'aav_consignments',
      sql: 'SELECT CONSIGNMENT_CREATED_AT FROM ...',
      inherits_columns_from: 'CONSIGNMENTS',
      grain: ['CONSIGNED_ITEM_ID'],
      columns: [{ name: 'CONSIGNMENT_CREATED_AT', type: '' }],
      joins: [],
      measures: [],
    };
    const enriched = enrichColumnsFromManifest(source, manifest);
    expect(enriched.columns[0].role).toBe('time');
    expect(enriched.columns[0].type).toBe('time');
  });

  it('returns the source unchanged when manifestEntry is null/undefined', () => {
    const source: SemanticLayerSource = {
      name: 'aav_consignments',
      sql: 'SELECT FOO FROM ...',
      grain: ['FOO'],
      columns: [{ name: 'FOO', type: '' }],
      joins: [],
      measures: [],
    };
    const enriched = enrichColumnsFromManifest(source, null);
    expect(enriched).toEqual(source);
  });
});

describe('sourceDefinitionSchema', () => {
  it('preserves dbt structural metadata fields used by manifest-backed SL readers', () => {
    const result = sourceDefinitionSchema.safeParse({
      name: 'orders',
      descriptions: { dbt: 'Order facts from dbt.' },
      table: 'public.orders',
      grain: ['id'],
      columns: [
        {
          name: 'status',
          type: 'string',
          descriptions: { dbt: 'Order lifecycle status.' },
          constraints: { dbt: { not_null: true, unique: true } },
          enum_values: { dbt: ['placed', 'shipped'] },
          tests: {
            dbt: [{ name: 'accepted_values', package: 'dbt' }],
            dbt_by_package: { dbt: ['accepted_values'] },
          },
        },
      ],
      joins: [],
      measures: [],
      tags: { dbt: ['mart', 'finance'] },
      freshness: { dbt: { loaded_at_field: 'updated_at', raw: { warn_after: { count: 12, period: 'hour' } } } },
      default_time_dimension: { dbt: 'updated_at' },
    });

    expect(result.success).toBe(true);
    if (!result.success) {
      return;
    }
    expect(result.data.descriptions).toEqual({ dbt: 'Order facts from dbt.' });
    expect(result.data.columns[0]).toMatchObject({
      descriptions: { dbt: 'Order lifecycle status.' },
      constraints: { dbt: { not_null: true, unique: true } },
      enum_values: { dbt: ['placed', 'shipped'] },
      tests: {
        dbt: [{ name: 'accepted_values', package: 'dbt' }],
        dbt_by_package: { dbt: ['accepted_values'] },
      },
    });
    expect(result.data.tags).toEqual({ dbt: ['mart', 'finance'] });
    expect(result.data.freshness).toEqual({
      dbt: { loaded_at_field: 'updated_at', raw: { warn_after: { count: 12, period: 'hour' } } },
    });
  });

  it('accepts historic SQL usage on standalone sources', () => {
    const result = sourceDefinitionSchema.safeParse({
      name: 'orders',
      table: 'public.orders',
      grain: ['id'],
      columns: [{ name: 'id', type: 'string' }],
      joins: [],
      measures: [],
      usage: {
        narrative: 'Orders are queried for fulfillment and revenue analysis.',
        frequencyTier: 'high',
        commonFilters: ['status', 'created_at'],
        commonJoins: [{ table: 'public.customers', on: ['customer_id'] }],
        externalOwner: 'analytics',
      },
    });

    expect(result.success).toBe(true);
    if (!result.success) {
      return;
    }
    expect(result.data.usage).toMatchObject({
      narrative: 'Orders are queried for fulfillment and revenue analysis.',
      frequencyTier: 'high',
      commonFilters: ['status', 'created_at'],
      commonJoins: [{ table: 'public.customers', on: ['customer_id'] }],
      externalOwner: 'analytics',
    });
  });

  it("rejects qualified grain names (e.g. 'activity.account_id')", () => {
    const result = sourceDefinitionSchema.safeParse({
      name: 'activity',
      table: 'public.activity',
      grain: ['activity.account_id'],
      columns: [{ name: 'account_id', type: 'number' }],
      joins: [],
      measures: [],
    });
    expect(result.success).toBe(false);
    if (result.success) return;
    expect(result.error.issues.some((i) => i.path.join('.').startsWith('grain'))).toBe(true);
  });

  it('rejects qualified column names', () => {
    const result = sourceDefinitionSchema.safeParse({
      name: 'activity',
      table: 'public.activity',
      grain: ['account_id'],
      columns: [{ name: 'activity.account_id', type: 'number' }],
      joins: [],
      measures: [],
    });
    expect(result.success).toBe(false);
    if (result.success) return;
    expect(result.error.issues.some((i) => i.path.join('.').startsWith('columns'))).toBe(true);
  });
});

describe('sourceOverlaySchema', () => {
  it('accepts column_overrides and keeps columns computed-only', () => {
    const result = sourceOverlaySchema.safeParse({
      name: 'orders',
      column_overrides: [{ name: 'status', descriptions: { user: 'Lifecycle status' } }],
      columns: [{ name: 'is_paid', type: 'boolean', expr: "status = 'paid'" }],
    });
    expect(result.success).toBe(true);
  });

  it('rejects typeless overlay columns and singular description on overrides', () => {
    const result = sourceOverlaySchema.safeParse({
      name: 'orders',
      column_overrides: [{ name: 'status', description: 'Lifecycle status' }],
      columns: [{ name: 'status', descriptions: { user: 'Lifecycle status' } }],
    });
    expect(result.success).toBe(false);
    if (!result.success) {
      const paths = result.error.issues.map((issue) => issue.path.join('.'));
      expect(paths).toContain('column_overrides.0');
      expect(paths).toContain('columns.0.type');
      expect(paths).toContain('columns.0.expr');
    }
  });
});

describe('toResolvedWire', () => {
  it('strips TS-only authoring and provenance fields before the Python boundary', () => {
    const wire = toResolvedWire({
      name: 'orders',
      table: 'public.orders',
      inherits_columns_from: 'orders',
      grain: ['id'],
      columns: [{ name: 'id', type: 'string' }],
      joins: [{ to: 'customers', on: 'orders.customer_id = customers.id', relationship: 'many_to_one', source: 'formal' }],
      measures: [],
      usage: {
        narrative: 'Frequently queried orders.',
        frequencyTier: 'high',
        commonFilters: ['status'],
        commonJoins: [],
      },
    });

    expect(wire).toEqual({
      name: 'orders',
      table: 'public.orders',
      grain: ['id'],
      columns: [{ name: 'id', type: 'string' }],
      joins: [{ to: 'customers', on: 'orders.customer_id = customers.id', relationship: 'many_to_one' }],
      measures: [],
    });
    expect(resolvedSourceSchema.parse(wire)).toEqual(wire);
  });
});

describe('projectManifestEntry', () => {
  it('projects manifest usage onto the semantic-layer source', () => {
    const source = projectManifestEntry('orders', {
      table: 'public.orders',
      usage: {
        narrative: 'Orders are frequently filtered by status.',
        frequencyTier: 'high',
        commonFilters: ['status'],
        commonJoins: [{ table: 'public.customers', on: ['customer_id'] }],
      },
      columns: [
        { name: 'id', type: 'string', pk: true },
        { name: 'status', type: 'string' },
      ],
    });

    expect(source.usage).toEqual({
      narrative: 'Orders are frequently filtered by status.',
      frequencyTier: 'high',
      commonFilters: ['status'],
      commonJoins: [{ table: 'public.customers', on: ['customer_id'] }],
    });
  });
});

describe('findManifestEntryByTableRef', () => {
  let configService: {
    listFiles: Mock<(dir: string, recursive?: boolean) => Promise<{ files: string[] }>>;
    readFile: Mock<(path: string) => Promise<{ content: string }>>;
  };
  let service: SemanticLayerService;

  beforeEach(() => {
    configService = {
      listFiles: vi.fn<(dir: string, recursive?: boolean) => Promise<{ files: string[] }>>().mockResolvedValue({
        files: ['semantic-layer/conn-1/_schema/marts.yaml'],
      }),
      readFile: vi.fn<(path: string) => Promise<{ content: string }>>().mockResolvedValue({
        content: [
          'tables:',
          '  CONSIGNMENTS:',
          '    table: ANALYTICS.MARTS.CONSIGNMENTS',
          '    columns:',
          '      - { name: CONSIGNED_ITEM_ID, type: string, pk: true }',
        ].join('\n'),
      }),
    };
    service = new SemanticLayerService(configService as never, connectionCatalog(), pythonPort);
  });

  it('finds by exact bare manifest key', async () => {
    const entry = await service.findManifestEntryByTableRef('conn-1', 'CONSIGNMENTS');
    expect(entry?.name).toBe('CONSIGNMENTS');
  });

  it('finds by fully-qualified table path', async () => {
    const entry = await service.findManifestEntryByTableRef('conn-1', 'ANALYTICS.MARTS.CONSIGNMENTS');
    expect(entry?.name).toBe('CONSIGNMENTS');
  });

  it('finds by schema-qualified suffix', async () => {
    const entry = await service.findManifestEntryByTableRef('conn-1', 'MARTS.CONSIGNMENTS');
    expect(entry?.name).toBe('CONSIGNMENTS');
  });

  it('matches case-insensitively on table path', async () => {
    const entry = await service.findManifestEntryByTableRef('conn-1', 'analytics.marts.consignments');
    expect(entry?.name).toBe('CONSIGNMENTS');
  });

  it('returns null when nothing matches', async () => {
    const entry = await service.findManifestEntryByTableRef('conn-1', 'NOT_A_TABLE');
    expect(entry).toBeNull();
  });
});

describe('loadAllSources — standalone enrichment via inherits_columns_from', () => {
  let configService: {
    listFiles: Mock<(dir: string, recursive?: boolean) => Promise<{ files: string[] }>>;
    readFile: Mock<(path: string) => Promise<{ content: string }>>;
  };
  let service: SemanticLayerService;

  beforeEach(() => {
    configService = {
      listFiles: vi.fn<(dir: string, recursive?: boolean) => Promise<{ files: string[] }>>(),
      readFile: vi.fn<(path: string) => Promise<{ content: string }>>(),
    };
    service = new SemanticLayerService(configService as never, connectionCatalog(), pythonPort);
  });

  it('preserves dbt metadata when projecting manifest-backed sources', async () => {
    const schemaPath = 'semantic-layer/conn-1/_schema/marts.yaml';
    configService.listFiles.mockImplementation((dir: string) => {
      if (dir === 'semantic-layer/conn-1' || dir === 'semantic-layer/conn-1/_schema') {
        return Promise.resolve({ files: [schemaPath] });
      }
      return Promise.resolve({ files: [] });
    });
    configService.readFile.mockResolvedValue({
      content: [
        'tables:',
        '  orders:',
        '    table: public.orders',
        '    tags: { dbt: [mart] }',
        '    freshness:',
        '      dbt:',
        '        loaded_at_field: updated_at',
        '    columns:',
        '      - name: status',
        '        type: string',
        '        constraints: { dbt: { not_null: true } }',
        '        enum_values: { dbt: [placed, shipped] }',
        '        tests:',
        '          dbt:',
        '            - { name: accepted_values, package: dbt }',
      ].join('\n'),
    });

    const { sources, loadErrors } = await service.loadAllSources('conn-1');
    expect(loadErrors).toEqual([]);

    expect(sources[0]).toMatchObject({
      name: 'orders',
      tags: { dbt: ['mart'] },
      freshness: { dbt: { loaded_at_field: 'updated_at' } },
      columns: [
        {
          name: 'status',
          constraints: { dbt: { not_null: true } },
          enum_values: { dbt: ['placed', 'shipped'] },
          tests: { dbt: [{ name: 'accepted_values', package: 'dbt' }] },
        },
      ],
    });
  });

  it('fills blank columns on a standalone source from the manifest entry it points at', async () => {
    const schemaPath = 'semantic-layer/conn-1/_schema/marts.yaml';
    const standalonePath = 'semantic-layer/conn-1/aav_consignments.yaml';

    configService.listFiles.mockImplementation((dir: string) => {
      if (dir === 'semantic-layer/conn-1') {
        return Promise.resolve({ files: [schemaPath, standalonePath] });
      }
      if (dir === 'semantic-layer/conn-1/_schema') {
        return Promise.resolve({ files: [schemaPath] });
      }
      return Promise.resolve({ files: [] });
    });
    configService.readFile.mockImplementation((path: string) => {
      if (path === schemaPath) {
        return Promise.resolve({
          content: [
            'tables:',
            '  CONSIGNMENTS:',
            '    table: ANALYTICS.MARTS.CONSIGNMENTS',
            '    columns:',
            '      - name: CONSIGNED_ITEM_ID',
            '        type: string',
            '        descriptions: { ai: "Unique consigned-item id." }',
            '      - name: CASH_ADV_AMOUNT',
            '        type: number',
            '        descriptions: { ai: "Cash advance amount." }',
          ].join('\n'),
        });
      }
      if (path === standalonePath) {
        return Promise.resolve({
          content: [
            'name: aav_consignments',
            'sql: |',
            '  SELECT CONSIGNED_ITEM_ID, CASH_ADV_AMOUNT FROM ANALYTICS.MARTS.CONSIGNMENTS WHERE x',
            'inherits_columns_from: CONSIGNMENTS',
            'grain: [CONSIGNED_ITEM_ID]',
            'columns:',
            '  - { name: CONSIGNED_ITEM_ID }',
            '  - { name: CASH_ADV_AMOUNT }',
          ].join('\n'),
        });
      }
      return Promise.reject(new Error(`Unexpected readFile: ${path}`));
    });

    const { sources, loadErrors } = await service.loadAllSources('conn-1');
    expect(loadErrors).toEqual([]);
    const aav = sources.find((s) => s.name === 'aav_consignments');
    expect(aav).toBeDefined();
    expect(aav?.columns).toEqual([
      { name: 'CONSIGNED_ITEM_ID', type: 'string', descriptions: { ai: 'Unique consigned-item id.' } },
      { name: 'CASH_ADV_AMOUNT', type: 'number', descriptions: { ai: 'Cash advance amount.' } },
    ]);
  });

  it('accepts a fully-qualified path in inherits_columns_from', async () => {
    const schemaPath = 'semantic-layer/conn-1/_schema/marts.yaml';
    const standalonePath = 'semantic-layer/conn-1/aav_consignments.yaml';
    configService.listFiles.mockImplementation((dir: string) => {
      if (dir === 'semantic-layer/conn-1') {
        return Promise.resolve({ files: [schemaPath, standalonePath] });
      }
      if (dir === 'semantic-layer/conn-1/_schema') {
        return Promise.resolve({ files: [schemaPath] });
      }
      return Promise.resolve({ files: [] });
    });
    configService.readFile.mockImplementation((path: string) => {
      if (path === schemaPath) {
        return Promise.resolve({
          content: [
            'tables:',
            '  CONSIGNMENTS:',
            '    table: ANALYTICS.MARTS.CONSIGNMENTS',
            '    columns:',
            '      - { name: CONSIGNED_ITEM_ID, type: string }',
          ].join('\n'),
        });
      }
      return Promise.resolve({
        content: [
          'name: aav_consignments',
          'sql: SELECT 1',
          'inherits_columns_from: ANALYTICS.MARTS.CONSIGNMENTS',
          'grain: [CONSIGNED_ITEM_ID]',
          'columns:',
          '  - { name: CONSIGNED_ITEM_ID }',
        ].join('\n'),
      });
    });

    const { sources, loadErrors } = await service.loadAllSources('conn-1');
    expect(loadErrors).toEqual([]);
    const aav = sources.find((s) => s.name === 'aav_consignments');
    expect(aav?.columns[0].type).toBe('string');
  });

  it('passes the source through unchanged if inherits_columns_from misses', async () => {
    const standalonePath = 'semantic-layer/conn-1/aav_consignments.yaml';
    configService.listFiles.mockImplementation((dir: string) => {
      if (dir === 'semantic-layer/conn-1') {
        return Promise.resolve({ files: [standalonePath] });
      }
      return Promise.resolve({ files: [] });
    });
    configService.readFile.mockResolvedValue({
      content: [
        'name: aav_consignments',
        'sql: SELECT 1',
        'inherits_columns_from: NO_SUCH_TABLE',
        'grain: [FOO]',
        'columns:',
        '  - { name: FOO, type: string }',
      ].join('\n'),
    });

    const { sources, loadErrors } = await service.loadAllSources('conn-1');
    expect(loadErrors).toEqual([]);
    const aav = sources.find((s) => s.name === 'aav_consignments');
    expect(aav?.columns).toEqual([{ name: 'FOO', type: 'string' }]);
  });

  it('loads standalone source and column description maps', async () => {
    const standalonePath = 'semantic-layer/conn-1/orders.yaml';
    configService.listFiles.mockResolvedValue({ files: [standalonePath] });
    configService.readFile.mockResolvedValue({
      content: [
        'name: orders',
        'descriptions:',
        '  user: Finance orders used for invoice reconciliation.',
        'table: public.orders',
        'grain: [id]',
        'columns:',
        '  - name: id',
        '    type: string',
        '    descriptions:',
        '      user: Stable order identifier.',
      ].join('\n'),
    });

    const { sources, loadErrors } = await service.loadAllSources('conn-1');
    expect(loadErrors).toEqual([]);

    expect(sources[0]).toMatchObject({
      name: 'orders',
      descriptions: { user: 'Finance orders used for invoice reconciliation.' },
      columns: [{ name: 'id', type: 'string', descriptions: { user: 'Stable order identifier.' } }],
    });
  });

  it('reports file-attributed errors for overlay columns that shadow manifest columns', async () => {
    const schemaPath = 'semantic-layer/conn-1/_schema/marts.yaml';
    const overlayPath = 'semantic-layer/conn-1/orders.yaml';
    configService.listFiles.mockResolvedValue({ files: [schemaPath, overlayPath] });
    configService.readFile.mockImplementation((path: string) => {
      if (path === schemaPath) {
        return Promise.resolve({
          content: [
            'tables:',
            '  orders:',
            '    table: public.orders',
            '    columns:',
            '      - { name: id, type: string, pk: true }',
          ].join('\n'),
        });
      }
      return Promise.resolve({
        content: ['name: orders', 'columns:', '  - name: id', '    descriptions: { user: "Stable id." }'].join('\n'),
      });
    });

    const { loadErrors } = await service.loadAllSources('conn-1');

    expect(loadErrors.join('\n')).toContain(overlayPath);
    expect(loadErrors.join('\n')).toContain("column 'id' in columns already exists on manifest source 'orders'");
    expect(loadErrors.join('\n')).not.toContain('column_overrides');
  });

  it('reports and logs directory listing failures instead of treating them as empty sources', async () => {
    const logger = { log: vi.fn(), warn: vi.fn(), error: vi.fn() };
    configService.listFiles.mockRejectedValue(new Error('permission denied'));
    service = new SemanticLayerService(configService as never, connectionCatalog(), pythonPort, logger as never);

    const { sources, loadErrors } = await service.loadAllSources('conn-1');

    expect(sources).toEqual([]);
    expect(loadErrors).toEqual([
      'Failed to list semantic-layer files under semantic-layer/conn-1: permission denied',
    ]);
    expect(logger.warn).toHaveBeenCalledWith(
      'Failed to list semantic-layer files under semantic-layer/conn-1: permission denied',
    );
  });
});

describe('validateWithProposedSource', () => {
  let configService: {
    listFiles: Mock<(dir: string, recursive?: boolean) => Promise<{ files: string[] }>>;
    readFile: Mock<(path: string) => Promise<{ content: string }>>;
  };
  let service: SemanticLayerService;

  beforeEach(() => {
    pythonPort.validateSources.mockReset();
    configService = {
      listFiles: vi.fn<(dir: string, recursive?: boolean) => Promise<{ files: string[] }>>().mockResolvedValue({
        files: [],
      }),
      readFile: vi.fn<(path: string) => Promise<{ content: string }>>(),
    };
    service = new SemanticLayerService(configService as never, connectionCatalog('BIGQUERY'), pythonPort);
  });

  it('uses the connection warehouse dialect, not hardcoded postgres', async () => {
    pythonPort.validateSources.mockResolvedValue({
      data: { errors: [], warnings: [] },
    });

    await service.validateWithProposedSource('conn-1', {
      name: 'std',
      table: 'analytics.std',
      grain: ['id'],
      columns: [{ name: 'id', type: 'number' }],
      joins: [],
      measures: [],
    });

    expect(pythonPort.validateSources).toHaveBeenCalledWith(
      expect.objectContaining({
        dialect: 'bigquery',
      }),
    );
  });

  it('uses the Athena sqlglot dialect when validating Athena sources', async () => {
    pythonPort.validateSources.mockResolvedValue({
      data: { errors: [], warnings: [] },
    });
    service = new SemanticLayerService(configService as never, connectionCatalog('ATHENA'), pythonPort);

    await service.validateWithProposedSource('conn-1', {
      name: 'orders',
      table: 'analytics.orders',
      grain: ['id'],
      columns: [{ name: 'id', type: 'number' }],
      joins: [],
      measures: [],
    });

    expect(pythonPort.validateSources).toHaveBeenCalledWith(
      expect.objectContaining({
        dialect: 'athena',
      }),
    );
  });

  it('composes a bare overlay with its manifest base before validating', async () => {
    const schemaPath = 'semantic-layer/conn-1/_schema/core.yaml';
    const listFilesImpl = (dir: string): Promise<{ files: string[] }> => {
      if (dir === 'semantic-layer/conn-1') {
        return Promise.resolve({ files: [schemaPath, 'semantic-layer/conn-1/fct_orders.yaml'] });
      }
      if (dir === 'semantic-layer/conn-1/_schema') {
        return Promise.resolve({ files: [schemaPath] });
      }
      return Promise.resolve({ files: [] });
    };
    const readFileImpl = (path: string): Promise<{ content: string }> => {
      if (path === schemaPath) {
        return Promise.resolve({
          content: [
            'tables:',
            '  fct_orders:',
            '    table: analytics.fct_orders',
            '    columns:',
            '      - { name: id, type: string, pk: true }',
            '      - { name: amount, type: number }',
          ].join('\n'),
        });
      }
      if (path === 'semantic-layer/conn-1/fct_orders.yaml') {
        return Promise.resolve({ content: 'name: fct_orders\nmeasures: []\n' });
      }
      return Promise.reject(new Error(`Unexpected readFile: ${path}`));
    };
    configService.listFiles.mockImplementation(listFilesImpl);
    configService.readFile.mockImplementation(readFileImpl);

    pythonPort.validateSources.mockResolvedValue({
      data: { errors: [], warnings: [] },
    });

    const overlay: SemanticLayerSource = {
      name: 'fct_orders',
      grain: ['id'],
      columns: [],
      joins: [],
      measures: [{ name: 'total_amount', expr: 'sum(amount)' }],
    };

    await service.validateWithProposedSource('conn-1', overlay);

    expect(pythonPort.validateSources).toHaveBeenCalledTimes(1);
    const sources = (pythonPort.validateSources.mock.calls[0][0]?.sources ?? []) as Array<Record<string, unknown>>;
    const composed = sources.find((s) => s.name === 'fct_orders');
    expect(composed).toBeDefined();
    expect(composed?.table).toBe('analytics.fct_orders');
    expect(composed?.measures).toEqual([{ name: 'total_amount', expr: 'sum(amount)' }]);
  });

  it('returns a pointed error when a bare overlay has no manifest base', async () => {
    configService.listFiles.mockResolvedValue({ files: [] });

    const overlay: SemanticLayerSource = {
      name: 'orphan',
      grain: [],
      columns: [],
      joins: [],
      measures: [],
    };

    const result = await service.validateWithProposedSource('conn-1', overlay);
    expect(result.errors[0]).toMatch(/Overlay 'orphan' has no matching manifest entry/);
    expect(pythonPort.validateSources).not.toHaveBeenCalled();
  });

  it('rejects table-backed sources whose declared columns are absent from a matching physical manifest', async () => {
    const schemaPath = 'semantic-layer/postgres-warehouse/_schema/orbit_analytics.yaml';
    configService.listFiles.mockImplementation((dir: string) => {
      if (dir === 'semantic-layer/dbt-main') {
        return Promise.resolve({ files: [] });
      }
      if (dir === 'semantic-layer') {
        return Promise.resolve({ files: [schemaPath] });
      }
      if (dir === 'semantic-layer/dbt-main/_schema' || dir === 'semantic-layer/postgres-warehouse/_schema') {
        return Promise.resolve({ files: dir.endsWith('postgres-warehouse/_schema') ? [schemaPath] : [] });
      }
      return Promise.resolve({ files: [] });
    });
    configService.readFile.mockImplementation((path: string) => {
      if (path === schemaPath) {
        return Promise.resolve({
          content: [
            'tables:',
            '  int_procurement_qualifying_actions:',
            '    table: orbit_analytics.int_procurement_qualifying_actions',
            '    columns:',
            '      - { name: action_id, type: string }',
            '      - { name: account_id, type: string }',
            '      - { name: user_id, type: string }',
            '      - { name: action_date, type: time }',
            '      - { name: action_type, type: string }',
          ].join('\n'),
        });
      }
      return Promise.reject(new Error(`Unexpected readFile: ${path}`));
    });
    pythonPort.validateSources.mockResolvedValue({
      data: { errors: [], warnings: [] },
    });

    const result = await service.validateWithProposedSource('dbt-main', {
      name: 'int_procurement_qualifying_actions',
      table: 'orbit_analytics.int_procurement_qualifying_actions',
      grain: ['purchase_request_id'],
      columns: [
        { name: 'purchase_request_id', type: 'string' },
        { name: 'account_id', type: 'string' },
        { name: 'requester_user_id', type: 'string' },
        { name: 'action_week', type: 'time' },
      ],
      joins: [],
      measures: [{ name: 'qualifying_action_count', expr: 'count(purchase_request_id)' }],
    });

    expect(result.errors.join('\n')).toMatch(/declared column\(s\) absent from physical table/);
    expect(result.errors.join('\n')).toMatch(/purchase_request_id/);
    expect(result.errors.join('\n')).toMatch(/requester_user_id/);
    expect(result.errors.join('\n')).toMatch(/action_week/);
    expect(result.errors.join('\n')).toMatch(/measure "qualifying_action_count" references unknown column\(s\)/);
  });

  it('keeps valid table-backed sources clean when a physical manifest matches', async () => {
    const schemaPath = 'semantic-layer/postgres-warehouse/_schema/orbit_analytics.yaml';
    configService.listFiles.mockImplementation((dir: string) => {
      if (dir === 'semantic-layer/dbt-main') {
        return Promise.resolve({ files: [] });
      }
      if (dir === 'semantic-layer') {
        return Promise.resolve({ files: [schemaPath] });
      }
      if (dir === 'semantic-layer/dbt-main/_schema' || dir === 'semantic-layer/postgres-warehouse/_schema') {
        return Promise.resolve({ files: dir.endsWith('postgres-warehouse/_schema') ? [schemaPath] : [] });
      }
      return Promise.resolve({ files: [] });
    });
    configService.readFile.mockResolvedValue({
      content: [
        'tables:',
        '  mart_revenue_daily:',
        '    table: orbit_analytics.mart_revenue_daily',
        '    columns:',
        '      - { name: revenue_date, type: time }',
        '      - { name: gross_revenue_cents, type: number }',
        '      - { name: credits_cents, type: number }',
        '      - { name: refunds_cents, type: number }',
        '      - { name: net_revenue_cents, type: number }',
      ].join('\n'),
    });
    pythonPort.validateSources.mockResolvedValue({
      data: { errors: [], warnings: [] },
    });

    const result = await service.validateWithProposedSource('dbt-main', {
      name: 'mart_revenue_daily',
      table: 'orbit_analytics.mart_revenue_daily',
      grain: ['revenue_date'],
      columns: [
        { name: 'revenue_date', type: 'time' },
        { name: 'gross_revenue_cents', type: 'number' },
        { name: 'credits_cents', type: 'number' },
        { name: 'refunds_cents', type: 'number' },
        { name: 'net_revenue_cents', type: 'number' },
      ],
      joins: [],
      measures: [{ name: 'net_revenue', expr: 'sum(net_revenue_cents)' }],
    });

    expect(result.errors).toEqual([]);
  });

  it('allows SQL syntax tokens and cast types in physical expression validation', async () => {
    const schemaPath = 'semantic-layer/postgres-warehouse/_schema/orbit_analytics.yaml';
    configService.listFiles.mockImplementation((dir: string) => {
      if (dir === 'semantic-layer/dbt-main') {
        return Promise.resolve({ files: [] });
      }
      if (dir === 'semantic-layer') {
        return Promise.resolve({ files: [schemaPath] });
      }
      if (dir === 'semantic-layer/dbt-main/_schema' || dir === 'semantic-layer/postgres-warehouse/_schema') {
        return Promise.resolve({ files: dir.endsWith('postgres-warehouse/_schema') ? [schemaPath] : [] });
      }
      return Promise.resolve({ files: [] });
    });
    configService.readFile.mockResolvedValue({
      content: [
        'tables:',
        '  mart_revenue_daily:',
        '    table: orbit_analytics.mart_revenue_daily',
        '    columns:',
        '      - { name: order_id, type: string }',
        '      - { name: revenue_date, type: time }',
        '      - { name: amount, type: number }',
        '      - { name: status, type: string }',
        '      - { name: created_at, type: time }',
      ].join('\n'),
    });
    pythonPort.validateSources.mockResolvedValue({
      data: { errors: [], warnings: [] },
    });

    const result = await service.validateWithProposedSource('dbt-main', {
      name: 'mart_revenue_daily',
      table: 'orbit_analytics.mart_revenue_daily',
      grain: ['order_id'],
      columns: [
        { name: 'order_id', type: 'string' },
        { name: 'revenue_date', type: 'time' },
        { name: 'amount', type: 'number' },
        { name: 'status', type: 'string' },
        { name: 'created_at', type: 'time' },
        { name: 'status_text', type: 'string', expr: 'status::text' },
      ],
      segments: [{ name: 'current_or_paid', expr: "created_at <= current_date OR status = 'paid'" }],
      joins: [],
      measures: [
        { name: 'paid_amount', expr: "sum(amount) FILTER (WHERE status = 'paid')" },
        { name: 'cast_amount_count', expr: 'count(cast(amount as text))' },
      ],
    });

    expect(result.errors).toEqual([]);
  });

  it('rejects join keys that are absent from matched physical sources', async () => {
    const schemaPath = 'semantic-layer/dbt-main/_schema/orbit_analytics.yaml';
    configService.listFiles.mockImplementation((dir: string) => {
      if (dir === 'semantic-layer/dbt-main' || dir === 'semantic-layer/dbt-main/_schema' || dir === 'semantic-layer') {
        return Promise.resolve({ files: [schemaPath] });
      }
      return Promise.resolve({ files: [] });
    });
    configService.readFile.mockResolvedValue({
      content: [
        'tables:',
        '  activity:',
        '    table: orbit_analytics.activity',
        '    columns:',
        '      - { name: account_id, type: string }',
        '  accounts:',
        '    table: orbit_analytics.accounts',
        '    columns:',
        '      - { name: account_id, type: string }',
      ].join('\n'),
    });
    pythonPort.validateSources.mockResolvedValue({
      data: { errors: [], warnings: [] },
    });

    const result = await service.validateWithProposedSource('dbt-main', {
      name: 'activity',
      table: 'orbit_analytics.activity',
      grain: ['account_id'],
      columns: [{ name: 'account_id', type: 'string' }],
      joins: [{ to: 'accounts', on: 'activity.account_name = accounts.account_uuid', relationship: 'many_to_one' }],
      measures: [],
    });

    expect(result.errors.join('\n')).toMatch(/local column "account_name"/);
    expect(result.errors.join('\n')).toMatch(/target column "account_uuid"/);
  });

  it('rejects joins whose target resolves to no source and no manifest entry anywhere', async () => {
    // Regression: a Metabase work unit wrote `joins: [{to: accounts}]` while
    // no `accounts` source or manifest table existed in the project. The
    // write tool must reject the source so the agent can fix its own join.
    configService.listFiles.mockResolvedValue({ files: [] });
    pythonPort.validateSources.mockResolvedValue({
      data: { errors: [], warnings: [] },
    });

    const result = await service.validateWithProposedSource('conn-1', {
      name: 'mart_account_segments',
      table: 'orbit_analytics.mart_account_segments',
      grain: ['account_id'],
      columns: [{ name: 'account_id', type: 'string' }],
      joins: [
        { to: 'accounts', on: 'mart_account_segments.account_id = accounts.account_id', relationship: 'many_to_one' },
      ],
      measures: [],
    });

    expect(result.errors.join('\n')).toMatch(/mart_account_segments: join target "accounts" does not exist/);
    expect(pythonPort.validateSources).not.toHaveBeenCalled();
  });

  it('rejects join targets that differ from the source name only by case', async () => {
    // The Python engine resolves joins[].to by exact name
    // (engine._collect_orphan_join_target_errors), so a case-insensitive
    // acceptance here would let the source pass gates and fail every query.
    const schemaPath = 'semantic-layer/conn-1/_schema/core.yaml';
    configService.listFiles.mockImplementation((dir: string) => {
      if (dir === 'semantic-layer/conn-1' || dir === 'semantic-layer/conn-1/_schema' || dir === 'semantic-layer') {
        return Promise.resolve({ files: [schemaPath] });
      }
      return Promise.resolve({ files: [] });
    });
    configService.readFile.mockResolvedValue({
      content: ['tables:', '  SIGNED_UP:', '    table: analytics.SIGNED_UP', '    columns:', '      - { name: account_id, type: string }'].join(
        '\n',
      ),
    });
    pythonPort.validateSources.mockResolvedValue({
      data: { errors: [], warnings: [] },
    });

    const result = await service.validateWithProposedSource('conn-1', {
      name: 'orders',
      table: 'analytics.orders',
      grain: ['account_id'],
      columns: [{ name: 'account_id', type: 'string' }],
      joins: [{ to: 'signed_up', on: 'orders.account_id = signed_up.account_id', relationship: 'many_to_one' }],
      measures: [],
    });

    expect(result.errors.join('\n')).toMatch(
      /orders: join target "signed_up" does not exist; join targets are case-sensitive — the source is named "SIGNED_UP"/,
    );
    expect(pythonPort.validateSources).not.toHaveBeenCalled();
  });

  it('rejects join targets written as table refs even when a manifest table matches', async () => {
    // `joins[].to` must be the source NAME ("accounts"), not the physical
    // table ref ("orbit_analytics.accounts") — the engine keys sources by name.
    const schemaPath = 'semantic-layer/conn-1/_schema/core.yaml';
    configService.listFiles.mockImplementation((dir: string) => {
      if (dir === 'semantic-layer/conn-1' || dir === 'semantic-layer/conn-1/_schema' || dir === 'semantic-layer') {
        return Promise.resolve({ files: [schemaPath] });
      }
      return Promise.resolve({ files: [] });
    });
    configService.readFile.mockResolvedValue({
      content: ['tables:', '  accounts:', '    table: orbit_analytics.accounts', '    columns:', '      - { name: account_id, type: string }'].join(
        '\n',
      ),
    });
    pythonPort.validateSources.mockResolvedValue({
      data: { errors: [], warnings: [] },
    });

    const result = await service.validateWithProposedSource('conn-1', {
      name: 'orders',
      table: 'orbit_analytics.orders',
      grain: ['account_id'],
      columns: [{ name: 'account_id', type: 'string' }],
      joins: [
        {
          to: 'orbit_analytics.accounts',
          on: 'orders.account_id = orbit_analytics.accounts.account_id',
          relationship: 'many_to_one',
        },
      ],
      measures: [],
    });

    expect(result.errors.join('\n')).toMatch(/orders: join target "orbit_analytics.accounts" does not exist/);
    expect(pythonPort.validateSources).not.toHaveBeenCalled();
  });
});

describe('executeQuery dialect resolution', () => {
  it('passes the Athena sqlglot dialect to the Python query engine for Athena connections', async () => {
    pythonPort.query.mockResolvedValue({ data: { sql: 'SELECT * FROM orders' } });
    const catalog = connectionCatalog('ATHENA');
    catalog.executeQuery.mockResolvedValue({ headers: ['id'], rows: [[1]], totalRows: 1 });
    const configService = {
      listFiles: vi.fn().mockResolvedValue({
        files: ['semantic-layer/conn-1/orders.yaml'],
      }),
      readFile: vi.fn().mockResolvedValue({
        content: [
          'name: orders',
          'table: analytics.orders',
          'grain:',
          '  - id',
          'columns:',
          '  - name: id',
          '    type: number',
          'joins: []',
          'measures:',
          '  - name: count',
          '    expr: count(*)',
        ].join('\n'),
      }),
    };
    const service = new SemanticLayerService(configService as never, catalog, pythonPort);

    await service.executeQuery('conn-1', { measures: ['count'] } as never);

    expect(pythonPort.query).toHaveBeenCalledWith(
      expect.objectContaining({
        dialect: 'athena',
      }),
    );
    expect(catalog.executeQuery).toHaveBeenCalledWith('conn-1', 'SELECT * FROM orders');
  });
});

describe('findDanglingSegmentRefs', () => {
  it('returns empty when every measure segment resolves', () => {
    const source = {
      segments: [{ name: 'byol' }, { name: 'paid' }],
      measures: [
        { name: 'byol_count', segments: ['byol'] },
        { name: 'paid_count', segments: ['paid', 'byol'] },
      ],
    };
    expect(findDanglingSegmentRefs(source)).toEqual([]);
  });

  it('flags measures whose segment reference does not exist on the source', () => {
    const source = {
      segments: [{ name: 'byol' }],
      measures: [{ name: 'broken', segments: ['byol', 'missing'] }],
    };
    const refs = findDanglingSegmentRefs(source);
    expect(refs).toHaveLength(1);
    expect(refs[0]).toMatch(/measure 'broken' references unknown segment 'missing'/);
  });

  it('flags when a source has zero segments but measures reference one', () => {
    const source = {
      measures: [{ name: 'broken', segments: ['byol'] }],
    };
    const refs = findDanglingSegmentRefs(source);
    expect(refs).toHaveLength(1);
    expect(refs[0]).toMatch(/unknown segment 'byol'/);
  });

  it('is a no-op for sources with no measures or no segment references', () => {
    expect(findDanglingSegmentRefs({ measures: [{ name: 'simple', expr: 'count(*)' }] })).toEqual([]);
    expect(findDanglingSegmentRefs({})).toEqual([]);
  });
});

describe('writeSource / deleteSource file naming', () => {
  let tempDir: string;
  let project: KtxLocalProject;
  let service: SemanticLayerService;

  const author = 'T U';
  const authorEmail = 't@u.com';

  beforeEach(async () => {
    tempDir = await mkdtemp(join(tmpdir(), 'ktx-sl-service-files-'));
    project = await initKtxProject({ projectDir: join(tempDir, 'project') });
    service = new SemanticLayerService(project.fileStore as never, connectionCatalog() as never, pythonPort as never);
  });

  afterEach(async () => {
    await rm(tempDir, { recursive: true, force: true });
  });

  const signedUp: SemanticLayerSource = {
    name: 'SIGNED_UP',
    table: 'PUBLIC.SIGNED_UP',
    grain: ['ID'],
    columns: [{ name: 'ID', type: 'number' }],
    joins: [],
    measures: [],
  };

  it('writes a new uppercase source at a derived filename and reads it back by name', async () => {
    const result = await service.writeSource('warehouse', signedUp, author, authorEmail);

    expect(result.path).toMatch(/^semantic-layer\/warehouse\/signed_up-[0-9a-f]{8}\.yaml$/);

    const file = await service.readSourceFile('warehouse', 'SIGNED_UP');
    expect(file?.path).toBe(result.path);
    expect(file?.content).toContain('name: SIGNED_UP');

    // Rewriting lands on the same file instead of deriving a second one.
    const rewrite = await service.writeSource('warehouse', signedUp, author, authorEmail);
    expect(rewrite.path).toBe(result.path);
  });

  it('repairs a broken file occupying the derived path instead of refusing the write', async () => {
    const written = await service.writeSource('warehouse', signedUp, author, authorEmail);
    await project.fileStore.writeFile(
      written.path,
      'name: SIGNED_UP\nmeasures: [unterminated\n',
      author,
      authorEmail,
      'break the file',
    );

    const repaired = await service.writeSource('warehouse', signedUp, author, authorEmail);

    expect(repaired.path).toBe(written.path);
    const file = await service.readSourceFile('warehouse', 'SIGNED_UP');
    expect(file?.path).toBe(written.path);
    expect(file?.content).toContain('name: SIGNED_UP');
  });

  it('rewrites a human-renamed file in place', async () => {
    await project.fileStore.writeFile(
      'semantic-layer/warehouse/custom.yaml',
      'name: orders\nmeasures: []\n',
      author,
      authorEmail,
      'seed renamed file',
    );

    const result = await service.writeSource(
      'warehouse',
      { name: 'orders', grain: [], columns: [], joins: [], measures: [] },
      author,
      authorEmail,
    );

    expect(result.path).toBe('semantic-layer/warehouse/custom.yaml');
    const listed = await project.fileStore.listFiles('semantic-layer/warehouse');
    expect(listed.files).toEqual(['semantic-layer/warehouse/custom.yaml']);
  });

  it('repairs a human-renamed broken file in place instead of deriving a second one', async () => {
    // Renamed (filename ≠ name) AND mid-edit broken: identity must survive the
    // syntax error so the rewrite lands on the original file rather than creating
    // a duplicate at the derived path that later trips the by-name resolver.
    await project.fileStore.writeFile(
      'semantic-layer/warehouse/custom.yaml',
      'name: SIGNED_UP\nmeasures: [unterminated\n',
      author,
      authorEmail,
      'seed broken renamed file',
    );

    const repaired = await service.writeSource('warehouse', signedUp, author, authorEmail);

    expect(repaired.path).toBe('semantic-layer/warehouse/custom.yaml');
    const listed = await project.fileStore.listFiles('semantic-layer/warehouse');
    expect(listed.files).toEqual(['semantic-layer/warehouse/custom.yaml']);
    const file = await service.readSourceFile('warehouse', 'SIGNED_UP');
    expect(file?.path).toBe('semantic-layer/warehouse/custom.yaml');
    expect(file?.content).toContain('name: SIGNED_UP');
  });

  it('keeps a .yml-renamed file visible to the loader and the by-name resolver alike', async () => {
    await project.fileStore.writeFile(
      'semantic-layer/warehouse/custom.yml',
      'name: orders\ntable: public.orders\ngrain: [id]\ncolumns:\n  - name: id\n    type: number\nmeasures: []\n',
      author,
      authorEmail,
      'seed .yml file',
    );

    const { sources, loadErrors } = await service.loadAllSources('warehouse');
    expect(loadErrors).toEqual([]);
    expect(sources.map((source) => source.name)).toEqual(['orders']);

    const file = await service.readSourceFile('warehouse', 'orders');
    expect(file?.path).toBe('semantic-layer/warehouse/custom.yml');
  });

  it('refuses to clobber a derived path occupied by a different source', async () => {
    await project.fileStore.writeFile(
      'semantic-layer/warehouse/orders.yaml',
      'name: other_source\nmeasures: []\n',
      author,
      authorEmail,
      'seed conflicting file',
    );

    await expect(
      service.writeSource(
        'warehouse',
        { name: 'orders', grain: [], columns: [], joins: [], measures: [] },
        author,
        authorEmail,
      ),
    ).rejects.toThrow("already defines source 'other_source'");
  });

  it('deletes the file resolved by name, wherever it lives', async () => {
    await project.fileStore.writeFile(
      'semantic-layer/warehouse/custom.yaml',
      'name: orders\nmeasures: []\n',
      author,
      authorEmail,
      'seed renamed file',
    );

    await service.deleteSource('warehouse', 'orders', author, authorEmail);

    const listed = await project.fileStore.listFiles('semantic-layer/warehouse');
    expect(listed.files).toEqual([]);
  });

  it('explains manifest-backed deletes instead of silently succeeding', async () => {
    await project.fileStore.writeFile(
      'semantic-layer/warehouse/_schema/public.yaml',
      'tables:\n  payments:\n    table: public.payments\n    columns:\n      - name: id\n        type: number\n',
      author,
      authorEmail,
      'seed manifest shard',
    );

    await expect(service.deleteSource('warehouse', 'payments', author, authorEmail)).rejects.toThrow(
      /scan manifest/,
    );
  });

  it('throws a plain not-found error for unknown sources', async () => {
    await expect(service.deleteSource('warehouse', 'missing', author, authorEmail)).rejects.toThrow(
      'Semantic-layer source not found: warehouse/missing',
    );
  });
});
