import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import YAML from 'yaml';
import { initKtxProject, type KtxLocalProject } from '../../../src/context/project/project.js';
import type { KtxLocalScanEnrichmentResult } from '../../../src/context/scan/local-enrichment.js';
import {
  loadOnDiskDescriptionUpdates,
  writeLocalScanEnrichmentArtifacts,
  writeLocalScanManifestShards,
} from '../../../src/context/scan/local-enrichment-artifacts.js';
import type { KtxSchemaSnapshot } from '../../../src/context/scan/types.js';

const snapshot: KtxSchemaSnapshot = {
  connectionId: 'warehouse',
  driver: 'postgres',
  extractedAt: '2026-04-29T12:00:00.000Z',
  scope: { schemas: ['public'] },
  metadata: {},
  tables: [
    {
      catalog: null,
      db: 'public',
      name: 'customers',
      kind: 'table',
      comment: 'DB customer table',
      estimatedRows: 2,
      foreignKeys: [],
      columns: [
        {
          name: 'id',
          nativeType: 'integer',
          normalizedType: 'integer',
          dimensionType: 'number',
          nullable: false,
          primaryKey: true,
          comment: 'DB customer id',
        },
      ],
    },
    {
      catalog: null,
      db: 'public',
      name: 'orders',
      kind: 'table',
      comment: 'DB orders table',
      estimatedRows: 3,
      foreignKeys: [
        {
          fromColumn: 'customer_id',
          toCatalog: null,
          toDb: 'public',
          toTable: 'customers',
          toColumn: 'id',
          constraintName: 'orders_customer_id_fkey',
        },
      ],
      columns: [
        {
          name: 'id',
          nativeType: 'integer',
          normalizedType: 'integer',
          dimensionType: 'number',
          nullable: false,
          primaryKey: true,
          comment: 'DB order id',
        },
        {
          name: 'customer_id',
          nativeType: 'integer',
          normalizedType: 'integer',
          dimensionType: 'number',
          nullable: false,
          primaryKey: false,
          comment: 'DB customer id',
        },
      ],
    },
  ],
};

function enrichment(): KtxLocalScanEnrichmentResult {
  return {
    snapshot,
    summary: {
      dataDictionary: 'completed',
      tableDescriptions: 'completed',
      columnDescriptions: 'completed',
      embeddings: 'completed',
      deterministicRelationships: 'completed',
      llmRelationshipValidation: 'skipped',
      statisticalValidation: 'skipped',
    },
    relationships: { accepted: 1, review: 0, rejected: 0, skipped: 0 },
    state: {
      resumedStages: [],
      completedStages: ['descriptions', 'embeddings', 'relationships'],
      failedStages: [],
    },
    warnings: [],
    descriptionUpdates: [
      {
        table: { catalog: null, db: 'public', name: 'orders' },
        tableDescription: 'AI orders table',
        columnDescriptions: {
          id: 'AI order id',
          customer_id: 'AI customer reference',
        },
      },
      {
        table: { catalog: null, db: 'public', name: 'customers' },
        tableDescription: 'AI customers table',
        columnDescriptions: {
          id: 'AI customer id',
        },
      },
    ],
    embeddingUpdates: [
      { columnId: 'public.orders.id', text: 'orders id', embedding: [0.1, 0.2] },
      { columnId: 'public.orders.customer_id', text: 'orders customer_id', embedding: [0.3, 0.4] },
    ],
    relationshipUpdate: {
      connectionId: 'warehouse',
      accepted: [
        {
          id: 'public.orders:public.orders.customer_id->public.customers:public.customers.id',
          source: 'inferred',
          from: {
            tableId: 'public.orders',
            columnIds: ['public.orders.customer_id'],
            table: { catalog: null, db: 'public', name: 'orders' },
            columns: ['customer_id'],
          },
          to: {
            tableId: 'public.customers',
            columnIds: ['public.customers.id'],
            table: { catalog: null, db: 'public', name: 'customers' },
            columns: ['id'],
          },
          relationshipType: 'many_to_one',
          confidence: 0.95,
          isPrimaryKeyReference: true,
        },
      ],
      rejected: [],
      skipped: [],
    },
    relationshipProfile: {
      connectionId: 'warehouse',
      driver: 'postgres',
      sqlAvailable: true,
      queryCount: 6,
      tables: [{ table: { catalog: null, db: 'public', name: 'customers' }, rowCount: 2 }],
      columns: {
        'customers.id': {
          table: { catalog: null, db: 'public', name: 'customers' },
          column: 'id',
          nativeType: 'integer',
          normalizedType: 'integer',
          rowCount: 2,
          nullCount: 0,
          distinctCount: 2,
          uniquenessRatio: 1,
          nullRate: 0,
          sampleValues: ['1', '2'],
          minTextLength: 1,
          maxTextLength: 1,
        },
      },
      warnings: [],
    },
    resolvedRelationships: [
      {
        id: 'public.orders:public.orders.customer_id->public.customers:public.customers.id',
        source: 'llm_proposal',
        status: 'accepted',
        from: {
          tableId: 'public.orders',
          columnIds: ['public.orders.customer_id'],
          table: { catalog: null, db: 'public', name: 'orders' },
          columns: ['customer_id'],
        },
        to: {
          tableId: 'public.customers',
          columnIds: ['public.customers.id'],
          table: { catalog: null, db: 'public', name: 'customers' },
          columns: ['id'],
        },
        relationshipType: 'many_to_one',
        confidence: 0.92,
        pkScore: 0.95,
        fkScore: 0.91,
        score: 0.9,
        evidence: {
          sourceColumnBase: 'buyer',
          targetTableBase: 'customer',
          targetColumnBase: 'id',
          targetKeyScore: 0.88,
          nameScore: 0.45,
          reasons: ['llm_proposal', 'llm_pk_proposal'],
          llmConfidence: 0.89,
          llmRationale: 'Buyer reference values align with customer identifiers.',
        },
        validation: {
          targetUniqueness: 1,
          sourceCoverage: 1,
          violationCount: 0,
          violationRatio: 0,
          sourceNullRate: 0,
          targetNullRate: 0,
          childDistinct: 2,
          parentDistinct: 2,
          overlap: 2,
          checkedValues: 2,
          reasons: ['validation_passed'],
        },
        graph: {
          targetPkScore: 0.95,
          incomingCandidateCount: 1,
          conflictRank: 1,
          reasons: ['target_pk_score_passed', 'validation_passed', 'fk_score_passed'],
        },
      },
    ],
    compositeRelationships: null,
    relationshipPartial: null,
  };
}

describe('writeLocalScanEnrichmentArtifacts', () => {
  let tempDir: string;
  let project: KtxLocalProject;

  beforeEach(async () => {
    tempDir = await mkdtemp(join(tmpdir(), 'ktx-local-enrichment-artifacts-'));
    project = await initKtxProject({
      projectDir: join(tempDir, 'project'),
    });
  });

  afterEach(async () => {
    await rm(tempDir, { recursive: true, force: true });
  });

  it('scopes manifest descriptions by full table identity across same-named tables in different schemas', async () => {
    const multiSchemaSnapshot: KtxSchemaSnapshot = {
      connectionId: 'warehouse',
      driver: 'postgres',
      extractedAt: '2026-04-29T12:00:00.000Z',
      scope: { schemas: ['analytics', 'staging'] },
      metadata: {},
      tables: ['analytics', 'staging'].map((schema) => ({
        catalog: null,
        db: schema,
        name: 'orders',
        kind: 'table',
        comment: null,
        estimatedRows: 1,
        foreignKeys: [],
        columns: [
          {
            name: 'id',
            nativeType: 'integer',
            normalizedType: 'integer',
            dimensionType: 'number',
            nullable: false,
            primaryKey: true,
            comment: null,
          },
        ],
      })),
    };
    const descriptionUpdates = [
      {
        table: { catalog: null, db: 'analytics', name: 'orders' },
        tableDescription: 'Curated analytics orders',
        columnDescriptions: { id: 'Analytics order id' },
      },
      {
        table: { catalog: null, db: 'staging', name: 'orders' },
        tableDescription: 'Raw staging orders',
        columnDescriptions: { id: 'Staging order id' },
      },
    ];

    await writeLocalScanManifestShards({
      project,
      connectionId: 'warehouse',
      syncId: 'sync-multi',
      driver: 'postgres',
      snapshot: multiSchemaSnapshot,
      descriptionUpdates,
      dryRun: false,
    });

    type Shard = {
      tables: Record<
        string,
        { descriptions?: Record<string, string>; columns: Array<{ name: string; descriptions?: Record<string, string> }> }
      >;
    };
    const analyticsShard = YAML.parse(
      await readFile(join(project.projectDir, 'semantic-layer/warehouse/_schema/analytics.yaml'), 'utf-8'),
    ) as Shard;
    const stagingShard = YAML.parse(
      await readFile(join(project.projectDir, 'semantic-layer/warehouse/_schema/staging.yaml'), 'utf-8'),
    ) as Shard;

    expect(analyticsShard.tables.orders?.descriptions?.ai).toBe('Curated analytics orders');
    expect(stagingShard.tables.orders?.descriptions?.ai).toBe('Raw staging orders');
    expect(analyticsShard.tables.orders?.columns[0]?.descriptions?.ai).toBe('Analytics order id');
    expect(stagingShard.tables.orders?.columns[0]?.descriptions?.ai).toBe('Staging order id');

    // The on-disk reconstruction (used by selective `--stages` runs that skip the
    // descriptions stage) must also resolve per identity, not collapse names.
    const reconstructed = await loadOnDiskDescriptionUpdates(project, 'warehouse', multiSchemaSnapshot);
    const analytics = reconstructed.find((update) => update.table.db === 'analytics');
    const staging = reconstructed.find((update) => update.table.db === 'staging');
    expect(analytics?.tableDescription).toBe('Curated analytics orders');
    expect(staging?.tableDescription).toBe('Raw staging orders');
    expect(analytics?.columnDescriptions.id).toBe('Analytics order id');
    expect(staging?.columnDescriptions.id).toBe('Staging order id');
  });

  it('writes enrichment artifacts and manifest shards while preserving external descriptions', async () => {
    await project.fileStore.writeFile(
      'semantic-layer/warehouse/_schema/public.yaml',
      YAML.stringify(
        {
          tables: {
            orders: {
              table: 'public.orders',
              descriptions: { user: 'Pinned analyst description', ai: 'Old AI description' },
              columns: [
                {
                  name: 'id',
                  type: 'number',
                  descriptions: { user: 'Pinned id description', ai: 'Old AI id' },
                },
                { name: 'customer_id', type: 'number' },
              ],
              joins: [
                {
                  to: 'customers',
                  on: 'orders.id = customers.id',
                  relationship: 'many_to_one',
                  source: 'manual',
                },
              ],
            },
          },
        },
        { indent: 2, lineWidth: 0 },
      ),
      'ktx',
      'ktx@example.com',
      'Seed manifest shard',
    );

    const result = await writeLocalScanEnrichmentArtifacts({
      project,
      connectionId: 'warehouse',
      syncId: 'sync-1',
      driver: 'postgres',
      enrichment: enrichment(),
      dryRun: false,
      relationshipSettings: {
        enabled: true,
        llmProposals: false,
        validationRequiredForManifest: true,
        acceptThreshold: 0.91,
        reviewThreshold: 0.61,
        maxLlmTablesPerBatch: 12,
        maxCandidatesPerColumn: 7,
        profileSampleRows: 500,
        profileConcurrency: 3,
        validationConcurrency: 2,
        detectionBudgetMs: 600000,
      },
    });

    expect(result).toEqual({
      enrichmentArtifacts: [
        'raw-sources/warehouse/live-database/sync-1/enrichment/descriptions.json',
        'raw-sources/warehouse/live-database/sync-1/enrichment/embeddings.json',
        'raw-sources/warehouse/live-database/sync-1/enrichment/relationships.json',
        'raw-sources/warehouse/live-database/sync-1/enrichment/relationship-profile.json',
        'raw-sources/warehouse/live-database/sync-1/enrichment/relationship-diagnostics.json',
      ],
      manifestShards: ['semantic-layer/warehouse/_schema/public.yaml'],
      manifestShardsWritten: 1,
    });

    await expect(
      readFile(
        join(project.projectDir, 'raw-sources/warehouse/live-database/sync-1/enrichment/descriptions.json'),
        'utf-8',
      ),
    ).resolves.toContain('AI orders table');

    const relationshipsRaw = await readFile(
      join(project.projectDir, 'raw-sources/warehouse/live-database/sync-1/enrichment/relationships.json'),
      'utf-8',
    );
    const relationshipsArtifact = JSON.parse(relationshipsRaw) as {
      accepted: Array<{
        id: string;
        status: string;
        source: string;
        pkScore: number;
        fkScore: number;
        evidence: unknown;
        reasons: string[];
        validation: unknown;
        graph: unknown;
      }>;
      review: unknown[];
      rejected: unknown[];
      skipped: unknown[];
    };
    expect(relationshipsArtifact.accepted).toHaveLength(1);
    expect(relationshipsArtifact.accepted[0]).toMatchObject({
      id: 'public.orders:public.orders.customer_id->public.customers:public.customers.id',
      status: 'accepted',
      source: 'llm_proposal',
      pkScore: 0.95,
      fkScore: 0.91,
      evidence: expect.objectContaining({
        llmConfidence: 0.89,
        llmRationale: 'Buyer reference values align with customer identifiers.',
      }),
      reasons: expect.arrayContaining(['llm_proposal', 'llm_pk_proposal']),
      validation: expect.objectContaining({ reasons: ['validation_passed'] }),
      graph: expect.objectContaining({ reasons: ['target_pk_score_passed', 'validation_passed', 'fk_score_passed'] }),
    });
    expect(relationshipsArtifact.review).toEqual([]);
    expect(relationshipsArtifact.rejected).toEqual([]);
    expect(relationshipsArtifact.skipped).toEqual([]);

    const profileRaw = await readFile(
      join(project.projectDir, 'raw-sources/warehouse/live-database/sync-1/enrichment/relationship-profile.json'),
      'utf-8',
    );
    expect(JSON.parse(profileRaw)).toMatchObject({
      connectionId: 'warehouse',
      driver: 'postgres',
      sqlAvailable: true,
      queryCount: 6,
      warnings: [],
    });

    const diagnosticsRaw = await readFile(
      join(project.projectDir, 'raw-sources/warehouse/live-database/sync-1/enrichment/relationship-diagnostics.json'),
      'utf-8',
    );
    expect(JSON.parse(diagnosticsRaw)).toMatchObject({
      connectionId: 'warehouse',
      summary: { accepted: 1, review: 0, rejected: 0, skipped: 0 },
      noAcceptedReason: null,
      candidateCountsBySource: { llm_proposal: 1 },
      validation: { available: true, sqlAvailable: true, queryCount: 6 },
      thresholds: { acceptThreshold: 0.91, reviewThreshold: 0.61 },
      policy: {
        validationRequiredForManifest: true,
        maxCandidatesPerColumn: 7,
        profileSampleRows: 500,
        profileConcurrency: 3,
        validationConcurrency: 2,
      },
      profileWarnings: [],
    });

    const manifestRaw = await readFile(
      join(project.projectDir, 'semantic-layer/warehouse/_schema/public.yaml'),
      'utf-8',
    );
    const manifest = YAML.parse(manifestRaw) as {
      tables: {
        orders: {
          descriptions: Record<string, string>;
          columns: Array<{ name: string; descriptions?: Record<string, string> }>;
          joins: Array<{ to: string; on: string; source: string }>;
        };
      };
    };

    expect(manifest.tables.orders.descriptions).toEqual({
      user: 'Pinned analyst description',
      db: 'DB orders table',
      ai: 'AI orders table',
    });
    expect(manifest.tables.orders.columns.find((column) => column.name === 'id')?.descriptions).toEqual({
      user: 'Pinned id description',
      db: 'DB order id',
      ai: 'AI order id',
    });
    expect(manifest.tables.orders.joins).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          to: 'customers',
          on: 'orders.customer_id = customers.id',
          source: 'formal',
        }),
        expect.objectContaining({
          to: 'customers',
          on: 'orders.id = customers.id',
          source: 'manual',
        }),
      ]),
    );
  });

  it('writes formal accepted relationships into relationship artifacts and manifest shards', async () => {
    const source = enrichment();
    const formalEnrichment: KtxLocalScanEnrichmentResult = {
      ...source,
      relationshipUpdate: {
        connectionId: 'warehouse',
        accepted: [
          {
            id: 'public.orders:public.orders.customer_id->public.customers:public.customers.id',
            source: 'formal',
            from: {
              tableId: 'public.orders',
              columnIds: ['public.orders.customer_id'],
              table: { catalog: null, db: 'public', name: 'orders' },
              columns: ['customer_id'],
            },
            to: {
              tableId: 'public.customers',
              columnIds: ['public.customers.id'],
              table: { catalog: null, db: 'public', name: 'customers' },
              columns: ['id'],
            },
            relationshipType: 'many_to_one',
            confidence: 1,
            isPrimaryKeyReference: true,
          },
        ],
        rejected: [],
        skipped: [],
      },
      resolvedRelationships: [],
      compositeRelationships: null,
    };

    const result = await writeLocalScanEnrichmentArtifacts({
      project,
      connectionId: 'warehouse',
      driver: 'sqlite',
      syncId: 'sync-formal',
      enrichment: formalEnrichment,
      relationshipSettings: {
        enabled: true,
        llmProposals: false,
        validationRequiredForManifest: true,
        acceptThreshold: 0.85,
        reviewThreshold: 0.55,
        maxLlmTablesPerBatch: 40,
        maxCandidatesPerColumn: 25,
        profileSampleRows: 10000,
        profileConcurrency: 4,
        validationConcurrency: 4,
        detectionBudgetMs: 600000,
      },
      dryRun: false,
    });

    const relationshipsPath = 'raw-sources/warehouse/live-database/sync-formal/enrichment/relationships.json';
    const relationships = JSON.parse((await project.fileStore.readFile(relationshipsPath)).content) as {
      accepted: Array<{ source: string; reasons: string[] }>;
    };
    expect(relationships.accepted).toEqual([
      expect.objectContaining({
        source: 'formal',
        reasons: ['formal_metadata_accepted'],
      }),
    ]);

    const manifestPath = result.manifestShards[0];
    if (!manifestPath) {
      throw new Error('Expected manifest shard path');
    }
    const manifest = YAML.parse((await project.fileStore.readFile(manifestPath)).content) as {
      tables: { orders: { joins: Array<{ to: string; on: string; source: string }> } };
    };
    expect(manifest.tables.orders.joins).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          to: 'customers',
          on: 'orders.customer_id = customers.id',
          source: 'formal',
        }),
      ]),
    );
  });

  it('writes manually applied relationship joins with manual source', async () => {
    const result = await writeLocalScanManifestShards({
      project,
      connectionId: 'warehouse',
      syncId: 'sync-manual',
      driver: 'postgres',
      snapshot,
      dryRun: false,
      relationshipUpdate: {
        connectionId: 'warehouse',
        accepted: [
          {
            id: 'public.orders:(public.orders.customer_id)->public.customers:(public.customers.id)',
            source: 'manual',
            from: {
              tableId: 'public.orders',
              columnIds: ['public.orders.customer_id'],
              table: { catalog: null, db: 'public', name: 'orders' },
              columns: ['customer_id'],
            },
            to: {
              tableId: 'public.customers',
              columnIds: ['public.customers.id'],
              table: { catalog: null, db: 'public', name: 'customers' },
              columns: ['id'],
            },
            relationshipType: 'many_to_one',
            confidence: 1,
            isPrimaryKeyReference: true,
          },
        ],
        rejected: [],
        skipped: [],
      },
    });

    expect(result.manifestShardsWritten).toBe(1);
    const shard = YAML.parse(await readFile(join(tempDir, 'project/semantic-layer/warehouse/_schema/public.yaml'), 'utf8'));
    expect(shard.tables.orders.joins).toContainEqual({
      to: 'customers',
      on: 'orders.customer_id = customers.id',
      relationship: 'many_to_one',
      source: 'manual',
    });
  });

  it('does not persist generated error descriptions in manifest shards', async () => {
    await writeLocalScanManifestShards({
      project,
      connectionId: 'warehouse',
      syncId: 'sync-error-description',
      driver: 'postgres',
      snapshot,
      descriptionUpdates: [
        {
          table: { catalog: null, db: 'public', name: 'orders' },
          tableDescription: 'Error generating description: timeout exceeded when trying to connect',
          columnDescriptions: {
            id: 'Error generating description: timeout exceeded when trying to connect',
            customer_id: 'AI customer reference',
          },
        },
      ],
      dryRun: false,
    });

    const shard = YAML.parse(
      await readFile(join(tempDir, 'project/semantic-layer/warehouse/_schema/public.yaml'), 'utf8'),
    ) as {
      tables: {
        orders: {
          descriptions?: Record<string, string>;
          columns: Array<{ name: string; descriptions?: Record<string, string> }>;
        };
      };
    };

    expect(shard.tables.orders.descriptions).toEqual({ db: 'DB orders table' });
    expect(shard.tables.orders.columns.find((column) => column.name === 'id')?.descriptions).toEqual({
      db: 'DB order id',
    });
    expect(shard.tables.orders.columns.find((column) => column.name === 'customer_id')?.descriptions).toEqual({
      db: 'DB customer id',
      ai: 'AI customer reference',
    });
  });

  it('writes accepted composite relationships to relationship artifacts and manifest shards', async () => {
    const compositeSnapshot: KtxSchemaSnapshot = {
      connectionId: 'warehouse',
      driver: 'postgres',
      extractedAt: '2026-05-07T12:00:00.000Z',
      scope: { schemas: ['public'] },
      metadata: {},
      tables: [
        {
          catalog: null,
          db: 'public',
          name: 'order_lines',
          kind: 'table',
          comment: null,
          estimatedRows: 2,
          foreignKeys: [],
          columns: [
            {
              name: 'order_id',
              nativeType: 'integer',
              normalizedType: 'integer',
              dimensionType: 'number',
              nullable: false,
              primaryKey: false,
              comment: null,
            },
            {
              name: 'line_number',
              nativeType: 'integer',
              normalizedType: 'integer',
              dimensionType: 'number',
              nullable: false,
              primaryKey: false,
              comment: null,
            },
          ],
        },
        {
          catalog: null,
          db: 'public',
          name: 'order_line_allocations',
          kind: 'table',
          comment: null,
          estimatedRows: 2,
          foreignKeys: [],
          columns: [
            {
              name: 'order_id',
              nativeType: 'integer',
              normalizedType: 'integer',
              dimensionType: 'number',
              nullable: false,
              primaryKey: false,
              comment: null,
            },
            {
              name: 'line_number',
              nativeType: 'integer',
              normalizedType: 'integer',
              dimensionType: 'number',
              nullable: false,
              primaryKey: false,
              comment: null,
            },
          ],
        },
      ],
    };
    const compositeEnrichment: KtxLocalScanEnrichmentResult = Object.assign(enrichment(), {
      snapshot: compositeSnapshot,
      relationships: { accepted: 1, review: 0, rejected: 0, skipped: 0 },
      descriptionUpdates: [],
      embeddingUpdates: [],
      relationshipUpdate: {
        connectionId: 'warehouse',
        accepted: [
          {
            id: 'order_line_allocations.(order_id,line_number)->order_lines.(order_id,line_number)',
            source: 'inferred',
            from: {
              tableId: 'public.order_line_allocations',
              columnIds: ['public.order_line_allocations.order_id', 'public.order_line_allocations.line_number'],
              table: { catalog: null, db: 'public', name: 'order_line_allocations' },
              columns: ['order_id', 'line_number'],
            },
            to: {
              tableId: 'public.order_lines',
              columnIds: ['public.order_lines.order_id', 'public.order_lines.line_number'],
              table: { catalog: null, db: 'public', name: 'order_lines' },
              columns: ['order_id', 'line_number'],
            },
            relationshipType: 'many_to_one',
            confidence: 0.95,
            isPrimaryKeyReference: true,
          },
        ],
        rejected: [],
        skipped: [],
      },
      resolvedRelationships: [],
      compositeRelationships: [
        {
          id: 'order_line_allocations.(order_id,line_number)->order_lines.(order_id,line_number)',
          source: 'composite_profile_match',
          status: 'accepted',
          from: {
            tableId: 'public.order_line_allocations',
            columnIds: ['public.order_line_allocations.order_id', 'public.order_line_allocations.line_number'],
            table: { catalog: null, db: 'public', name: 'order_line_allocations' },
            columns: ['order_id', 'line_number'],
          },
          to: {
            tableId: 'public.order_lines',
            columnIds: ['public.order_lines.order_id', 'public.order_lines.line_number'],
            table: { catalog: null, db: 'public', name: 'order_lines' },
            columns: ['order_id', 'line_number'],
          },
          relationshipType: 'many_to_one',
          confidence: 0.95,
          validation: {
            targetUniqueness: 1,
            sourceCoverage: 1,
            violationCount: 0,
            violationRatio: 0,
            childDistinct: 2,
            parentDistinct: 2,
            overlap: 2,
            reasons: ['composite_validation_passed'],
          },
        },
      ],
    });

    const result = await writeLocalScanEnrichmentArtifacts({
      project,
      connectionId: 'warehouse',
      driver: 'postgres',
      syncId: 'sync-composite',
      enrichment: compositeEnrichment,
      relationshipSettings: {
        enabled: true,
        llmProposals: false,
        validationRequiredForManifest: true,
        acceptThreshold: 0.85,
        reviewThreshold: 0.55,
        maxLlmTablesPerBatch: 40,
        maxCandidatesPerColumn: 25,
        profileSampleRows: 10000,
        profileConcurrency: 4,
        validationConcurrency: 4,
        detectionBudgetMs: 600000,
      },
      dryRun: false,
    });

    const relationships = JSON.parse(
      (await project.fileStore.readFile('raw-sources/warehouse/live-database/sync-composite/enrichment/relationships.json'))
        .content,
    ) as { accepted: Array<{ from: { columns: string[] }; to: { columns: string[] }; reasons: string[] }> };
    expect(relationships.accepted[0]).toMatchObject({
      from: { columns: ['order_id', 'line_number'] },
      to: { columns: ['order_id', 'line_number'] },
      reasons: ['composite_validation_passed'],
    });

    const manifestPath = result.manifestShards[0];
    if (!manifestPath) {
      throw new Error('Expected manifest shard path');
    }
    const manifest = YAML.parse((await project.fileStore.readFile(manifestPath)).content) as {
      tables: { order_line_allocations: { joins: Array<{ to: string; on: string; source: string }> } };
    };
    expect(manifest.tables.order_line_allocations.joins).toEqual([
      {
        to: 'order_lines',
        on: 'order_line_allocations.order_id = order_lines.order_id AND order_line_allocations.line_number = order_lines.line_number',
        relationship: 'many_to_one',
        source: 'inferred',
      },
    ]);
  });

  it('writes structural manifest shards without enrichment artifacts', async () => {
    await project.fileStore.writeFile(
      'semantic-layer/warehouse/_schema/public.yaml',
      YAML.stringify(
        {
          tables: {
            orders: {
              table: 'public.orders',
              descriptions: { user: 'Pinned structural description', ai: 'Old generated text' },
              usage: {
                narrative: 'Orders are commonly filtered by lifecycle status.',
                frequencyTier: 'high',
                commonFilters: ['status'],
                commonJoins: [{ table: 'public.customers', on: ['customer_id'] }],
                ownerNote: 'Preserve analyst note',
              },
              columns: [
                {
                  name: 'id',
                  type: 'number',
                  descriptions: { user: 'Pinned structural id', ai: 'Old generated id' },
                },
                { name: 'customer_id', type: 'number' },
              ],
              joins: [
                {
                  to: 'customers',
                  on: 'orders.id = customers.id',
                  relationship: 'many_to_one',
                  source: 'manual',
                },
              ],
            },
          },
        },
        { indent: 2, lineWidth: 0 },
      ),
      'ktx',
      'ktx@example.com',
      'Seed structural manifest shard',
    );

    const result = await writeLocalScanManifestShards({
      project,
      connectionId: 'warehouse',
      syncId: 'sync-structural-1',
      driver: 'postgres',
      snapshot,
      dryRun: false,
    });

    expect(result).toEqual({
      manifestShards: ['semantic-layer/warehouse/_schema/public.yaml'],
      manifestShardsWritten: 1,
    });

    await expect(
      readFile(
        join(project.projectDir, 'raw-sources/warehouse/live-database/sync-structural-1/enrichment/descriptions.json'),
        'utf-8',
      ),
    ).rejects.toMatchObject({ code: 'ENOENT' });

    const manifestRaw = await readFile(
      join(project.projectDir, 'semantic-layer/warehouse/_schema/public.yaml'),
      'utf-8',
    );
    const manifest = YAML.parse(manifestRaw) as {
      tables: {
        orders: {
          descriptions: Record<string, string>;
          usage?: Record<string, unknown>;
          columns: Array<{ name: string; descriptions?: Record<string, string> }>;
          joins: Array<{ to: string; on: string; source: string }>;
        };
      };
    };

    expect(manifest.tables.orders.descriptions).toEqual({
      user: 'Pinned structural description',
      db: 'DB orders table',
    });
    expect(manifest.tables.orders.usage).toEqual({
      narrative: 'Orders are commonly filtered by lifecycle status.',
      frequencyTier: 'high',
      commonFilters: ['status'],
      commonJoins: [{ table: 'public.customers', on: ['customer_id'] }],
      ownerNote: 'Preserve analyst note',
    });
    expect(manifest.tables.orders.columns.find((column) => column.name === 'id')?.descriptions).toEqual({
      user: 'Pinned structural id',
      db: 'DB order id',
    });
    expect(manifest.tables.orders.joins).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          to: 'customers',
          on: 'orders.customer_id = customers.id',
          source: 'formal',
        }),
        expect.objectContaining({
          to: 'customers',
          on: 'orders.id = customers.id',
          source: 'manual',
        }),
      ]),
    );
  });

  it('returns planned empty paths without writing files during dry runs', async () => {
    const result = await writeLocalScanEnrichmentArtifacts({
      project,
      connectionId: 'warehouse',
      syncId: 'sync-dry-run',
      driver: 'postgres',
      enrichment: enrichment(),
      dryRun: true,
    });

    expect(result).toEqual({
      enrichmentArtifacts: [],
      manifestShards: [],
      manifestShardsWritten: 0,
    });
    await expect(
      readFile(
        join(project.projectDir, 'raw-sources/warehouse/live-database/sync-dry-run/enrichment/descriptions.json'),
        'utf-8',
      ),
    ).rejects.toMatchObject({ code: 'ENOENT' });
  });
});
