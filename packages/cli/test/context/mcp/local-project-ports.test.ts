import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { initKtxProject } from '../../../src/context/project/project.js';
import { KtxExpectedError, KtxQueryError } from '../../../src/errors.js';
import { createKtxConnectorCapabilities, type KtxQueryResult, type KtxScanConnector, type KtxSchemaSnapshot } from '../../../src/context/scan/types.js';
import { SemanticLayerService } from '../../../src/context/sl/semantic-layer.service.js';
import type { SemanticLayerSource } from '../../../src/context/sl/types.js';
import { seedSlSourceFile } from '../sl/sl-source-seeding.test-utils.js';
import { createLocalProjectMcpContextPorts } from '../../../src/context/mcp/local-project-ports.js';

describe('createLocalProjectMcpContextPorts', () => {
  let tempDir: string;

  beforeEach(async () => {
    tempDir = await mkdtemp(join(tmpdir(), 'ktx-mcp-local-'));
  });

  afterEach(async () => {
    await rm(tempDir, { recursive: true, force: true });
  });

  function testSnapshot(connectionId = 'warehouse'): KtxSchemaSnapshot {
    return {
      connectionId,
      driver: 'postgres',
      extractedAt: '2026-04-29T12:00:00.000Z',
      scope: { schemas: ['public'] },
      metadata: {},
      tables: [
        {
          catalog: null,
          db: 'public',
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
        },
      ],
    };
  }

  function testConnector(snapshot = testSnapshot(), queryResult?: KtxQueryResult): KtxScanConnector {
    return {
      id: `test:${snapshot.connectionId}`,
      driver: snapshot.driver,
      capabilities: createKtxConnectorCapabilities({ readOnlySql: queryResult !== undefined }),
      introspect: vi.fn(async () => snapshot),
      listSchemas: vi.fn(async () => []),
      listTables: vi.fn(async () => []),
      executeReadOnly: queryResult === undefined ? undefined : vi.fn(async () => queryResult),
      cleanup: vi.fn(async () => {}),
    };
  }

  async function seedScanReport(projectDir: string, syncId = 'sync-1'): Promise<void> {
    const root = `raw-sources/warehouse/live-database/${syncId}`;
    await mkdir(join(projectDir, root, 'tables'), { recursive: true });
    await writeFile(
      join(projectDir, root, 'connection.json'),
      JSON.stringify(
        {
          connectionId: 'warehouse',
          driver: 'postgres',
          extractedAt: '2026-05-14T09:00:00.000Z',
          scope: { schemas: ['public'] },
        },
        null,
        2,
      ),
      'utf-8',
    );
    await writeFile(
      join(projectDir, root, 'tables', 'orders.json'),
      JSON.stringify(
        {
          catalog: null,
          db: 'public',
          name: 'orders',
          kind: 'table',
          comment: 'Customer orders',
          estimatedRows: 12,
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
          foreignKeys: [],
        },
        null,
        2,
      ),
      'utf-8',
    );
    await writeFile(
      join(projectDir, root, 'scan-report.json'),
      JSON.stringify(
        {
          connectionId: 'warehouse',
          driver: 'postgres',
          syncId,
          runId: 'scan-1',
          trigger: 'mcp',
          mode: 'structural',
          dryRun: false,
          artifactPaths: {
            rawSourcesDir: root,
            reportPath: `${root}/scan-report.json`,
            manifestShards: [],
            enrichmentArtifacts: [],
          },
          diffSummary: {
            tablesAdded: 0,
            tablesModified: 0,
            tablesDeleted: 0,
            tablesUnchanged: 1,
            columnsAdded: 0,
            columnsModified: 0,
            columnsDeleted: 0,
          },
          manifestShardsWritten: 0,
          structuralSyncStats: {
            tablesCreated: 1,
            tablesUpdated: 0,
            tablesDeleted: 0,
            columnsCreated: 0,
            columnsUpdated: 0,
            columnsDeleted: 0,
          },
          enrichment: {
            dataDictionary: 'skipped',
            tableDescriptions: 'skipped',
            columnDescriptions: 'skipped',
            embeddings: 'skipped',
            deterministicRelationships: 'skipped',
            llmRelationshipValidation: 'skipped',
            statisticalValidation: 'skipped',
          },
          capabilityGaps: [],
          warnings: [],
          relationships: { accepted: 0, review: 0, rejected: 0, skipped: 0 },
          enrichmentState: { resumedStages: [], completedStages: [], failedStages: [] },
          createdAt: '2026-05-14T09:00:00.000Z',
        },
        null,
        2,
      ),
      'utf-8',
    );
  }

  it('lists local project connections and exposes only retained research ports', async () => {
    const project = await initKtxProject({ projectDir: tempDir });
    project.config.connections.warehouse = {
      driver: 'postgres',
      url: 'env:DATABASE_URL',
    };
    const ports = createLocalProjectMcpContextPorts(project, { embeddingService: null });

    expect(Object.keys(ports).sort()).toEqual([
      'connections',
      'dialectNotes',
      'dictionarySearch',
      'discover',
      'entityDetails',
      'knowledge',
      'semanticLayer',
    ]);
    expect(Object.keys(ports.connections ?? {}).sort()).toEqual(['list']);
    expect(Object.keys(ports.knowledge ?? {}).sort()).toEqual(['read', 'search']);
    expect(Object.keys(ports.semanticLayer ?? {}).sort()).toEqual(['query', 'readSource']);
    expect(Object.keys(ports.dialectNotes ?? {}).sort()).toEqual(['read']);
    await expect(ports.connections?.list()).resolves.toEqual([
      { id: 'warehouse', name: 'warehouse', connectionType: 'POSTGRESQL' },
    ]);
  });

  it('adds sql_execution when parser validation and a SQL-capable connector are configured', async () => {
    const project = await initKtxProject({ projectDir: tempDir });
    project.config.connections.warehouse = {
      driver: 'postgres',
      url: 'env:DATABASE_URL',
    };
    const connector = testConnector(testSnapshot(), {
      headers: ['id'],
      headerTypes: ['integer'],
      rows: [[1]],
      totalRows: 1,
      rowCount: 1,
    });
    const createConnector = vi.fn(async () => connector);
    const sqlAnalysis = {
      analyzeForFingerprint: vi.fn(),
      analyzeBatch: vi.fn(),
      validateReadOnly: vi.fn(async () => ({ ok: true, error: null })),
    };
    const ports = createLocalProjectMcpContextPorts(project, {
      sqlAnalysis,
      localScan: {
        createConnector,
      },
      embeddingService: null,
    });

    expect(Object.keys(ports).sort()).toContain('sqlExecution');
    await expect(
      ports.sqlExecution?.execute({
        connectionId: 'warehouse',
        sql: 'select id from public.orders',
        maxRows: 5,
      }),
    ).resolves.toEqual({
      headers: ['id'],
      headerTypes: ['integer'],
      rows: [[1]],
      rowCount: 1,
    });
    expect(sqlAnalysis.validateReadOnly).toHaveBeenCalledWith('select id from public.orders', 'postgres');
    expect(createConnector).toHaveBeenCalledWith('warehouse');
    expect(connector.executeReadOnly).toHaveBeenCalledWith(
      {
        connectionId: 'warehouse',
        sql: 'select id from public.orders',
        maxRows: 5,
      },
      { runId: 'mcp-sql-execution' },
    );
    expect(connector.cleanup).toHaveBeenCalled();
  });

  it('omits sql_execution when every SQL connection is semantic-layer-only', async () => {
    const project = await initKtxProject({ projectDir: tempDir });
    project.config.connections.warehouse = {
      driver: 'postgres',
      url: 'env:DATABASE_URL',
      query_policy: 'semantic-layer-only',
    };
    const ports = createLocalProjectMcpContextPorts(project, {
      sqlAnalysis: {
        analyzeForFingerprint: vi.fn(),
        analyzeBatch: vi.fn(),
        validateReadOnly: vi.fn(async () => ({ ok: true, error: null })),
      },
      localScan: { createConnector: vi.fn(async () => testConnector()) },
      embeddingService: null,
    });

    expect(ports.sqlExecution).toBeUndefined();
  });

  it('keeps sql_execution in mixed projects but rejects restricted connections and flags them in connection_list', async () => {
    const project = await initKtxProject({ projectDir: tempDir });
    project.config.connections.warehouse = {
      driver: 'postgres',
      url: 'env:DATABASE_URL',
    };
    project.config.connections.finance = {
      driver: 'postgres',
      url: 'env:FINANCE_URL',
      query_policy: 'semantic-layer-only',
    };
    const createConnector = vi.fn(async () => testConnector());
    const sqlAnalysis = {
      analyzeForFingerprint: vi.fn(),
      analyzeBatch: vi.fn(),
      validateReadOnly: vi.fn(async () => ({ ok: true, error: null })),
    };
    const ports = createLocalProjectMcpContextPorts(project, {
      sqlAnalysis,
      localScan: { createConnector },
      embeddingService: null,
    });

    expect(ports.sqlExecution).toBeDefined();
    const execution = ports.sqlExecution?.execute({
      connectionId: 'finance',
      sql: 'select 1',
      maxRows: 5,
    });
    await expect(execution).rejects.toBeInstanceOf(KtxQueryError);
    await expect(execution).rejects.toThrow(/query_policy: semantic-layer-only/);
    expect(sqlAnalysis.validateReadOnly).not.toHaveBeenCalled();
    expect(createConnector).not.toHaveBeenCalled();

    // Both postgres members federate, so the restricted member also blocks federated raw SQL.
    await expect(
      ports.sqlExecution?.execute({ connectionId: '_ktx_federated', sql: 'select 1', maxRows: 5 }),
    ).rejects.toThrow(/"finance"/);

    await expect(ports.connections?.list()).resolves.toEqual([
      expect.objectContaining({
        id: 'finance',
        queryPolicy: 'semantic-layer-only',
        hint: expect.stringContaining('sl_query'),
      }),
      expect.objectContaining({ id: 'warehouse' }),
      expect.objectContaining({
        id: '_ktx_federated',
        queryPolicy: 'semantic-layer-only',
        hint: expect.stringContaining('finance'),
      }),
    ]);
  });

  it('rejects sql_execution against an unconfigured connection with an actionable expected error', async () => {
    const project = await initKtxProject({ projectDir: tempDir });
    project.config.connections.warehouse = {
      driver: 'postgres',
      url: 'env:DATABASE_URL',
    };
    const connector = testConnector(testSnapshot(), {
      headers: ['id'],
      headerTypes: ['integer'],
      rows: [[1]],
      totalRows: 1,
      rowCount: 1,
    });
    const createConnector = vi.fn(async () => connector);
    const sqlAnalysis = {
      analyzeForFingerprint: vi.fn(),
      analyzeBatch: vi.fn(),
      validateReadOnly: vi.fn(async () => ({ ok: true, error: null })),
    };
    const ports = createLocalProjectMcpContextPorts(project, {
      sqlAnalysis,
      localScan: { createConnector },
      embeddingService: null,
    });

    const execution = ports.sqlExecution?.execute({
      connectionId: 'DIG_SMART_REP',
      sql: 'select 1',
      maxRows: 5,
    });
    await expect(execution).rejects.toBeInstanceOf(KtxExpectedError);
    await expect(execution).rejects.toThrow(
      'Connection "DIG_SMART_REP" is not configured in ktx.yaml. Configured connections: warehouse.',
    );
    expect(createConnector).not.toHaveBeenCalled();
  });

  it('refuses sql_execution against a non-SQL (MongoDB) connection before SQL analysis', async () => {
    const project = await initKtxProject({ projectDir: tempDir });
    project.config.connections.mongo = { driver: 'mongodb', url: 'mongodb://localhost:27017/app' };
    const createConnector = vi.fn(async () => testConnector());
    const sqlAnalysis = {
      analyzeForFingerprint: vi.fn(),
      analyzeBatch: vi.fn(),
      validateReadOnly: vi.fn(async () => ({ ok: true, error: null })),
    };
    const ports = createLocalProjectMcpContextPorts(project, {
      sqlAnalysis,
      localScan: { createConnector },
      embeddingService: null,
    });

    const execution = ports.sqlExecution?.execute({
      connectionId: 'mongo',
      sql: 'select 1',
      maxRows: 5,
    });
    await expect(execution).rejects.toBeInstanceOf(KtxExpectedError);
    await expect(execution).rejects.toThrow("non-SQL driver 'mongodb'");
    // Refused before the parser dialect is chosen and before any connector is built.
    expect(sqlAnalysis.validateReadOnly).not.toHaveBeenCalled();
    expect(createConnector).not.toHaveBeenCalled();
  });

  it('emits sql_execution progress stages from local MCP ports', async () => {
    const project = await initKtxProject({ projectDir: tempDir });
    project.config.connections.warehouse = {
      driver: 'postgres',
      url: 'env:DATABASE_URL',
    };
    const connector = testConnector(testSnapshot(), {
      headers: ['id'],
      headerTypes: ['integer'],
      rows: [[1]],
      totalRows: 1,
      rowCount: 1,
    });
    const createConnector = vi.fn(async () => connector);
    const sqlAnalysis = {
      analyzeForFingerprint: vi.fn(),
      analyzeBatch: vi.fn(),
      validateReadOnly: vi.fn(async () => ({ ok: true, error: null })),
    };
    const progress: Array<{ progress: number; message: string }> = [];
    const ports = createLocalProjectMcpContextPorts(project, {
      sqlAnalysis,
      localScan: {
        createConnector,
      },
      embeddingService: null,
    });

    const result = await ports.sqlExecution?.execute(
      { connectionId: 'warehouse', sql: 'select id from public.orders', maxRows: 5 },
      {
        onProgress: (event) => {
          progress.push({ progress: event.progress, message: event.message });
        },
      },
    );

    expect(result?.rowCount).toBe(1);
    expect(progress).toEqual([
      { progress: 0, message: 'Validating SQL' },
      { progress: 0.3, message: 'Executing' },
      { progress: 1, message: 'Fetched 1 rows' },
    ]);
  });

  it('rejects MCP SQL before connector execution when parser validation fails', async () => {
    const project = await initKtxProject({ projectDir: tempDir });
    project.config.connections.warehouse = {
      driver: 'postgres',
      url: 'env:DATABASE_URL',
    };
    const connector = testConnector(testSnapshot(), {
      headers: ['id'],
      rows: [[1]],
      totalRows: 1,
      rowCount: 1,
    });
    const sqlAnalysis = {
      analyzeForFingerprint: vi.fn(),
      analyzeBatch: vi.fn(),
      validateReadOnly: vi.fn(async () => ({
        ok: false,
        error: 'SQL contains read/write operation: Insert',
      })),
    };
    const ports = createLocalProjectMcpContextPorts(project, {
      sqlAnalysis,
      localScan: {
        createConnector: vi.fn(async () => connector),
      },
      embeddingService: null,
    });

    await expect(
      ports.sqlExecution?.execute({
        connectionId: 'warehouse',
        sql: 'with x as (insert into t values (1) returning *) select * from x',
        maxRows: 1000,
      }),
    ).rejects.toThrow('SQL contains read/write operation: Insert');
    expect(connector.executeReadOnly).not.toHaveBeenCalled();
  });

  it('wraps warehouse execution errors as KtxQueryError while preserving the diagnostic message', async () => {
    const project = await initKtxProject({ projectDir: tempDir });
    project.config.connections.warehouse = {
      driver: 'snowflake',
      url: 'env:DATABASE_URL',
    };
    const driverError = new Error("SQL compilation error:\nsyntax error line 4 at position 14 unexpected 'rows'.");
    driverError.name = 'OperationFailedError';
    const connector: KtxScanConnector = {
      ...testConnector(testSnapshot(), { headers: [], rows: [], totalRows: 0, rowCount: 0 }),
      executeReadOnly: vi.fn(async () => {
        throw driverError;
      }),
    };
    const sqlAnalysis = {
      analyzeForFingerprint: vi.fn(),
      analyzeBatch: vi.fn(),
      validateReadOnly: vi.fn(async () => ({ ok: true, error: null })),
    };
    const ports = createLocalProjectMcpContextPorts(project, {
      sqlAnalysis,
      localScan: { createConnector: vi.fn(async () => connector) },
      embeddingService: null,
    });

    const execution = ports.sqlExecution?.execute({
      connectionId: 'warehouse',
      sql: 'select\n  count(*)\nfrom events\nlimit 100 rows',
      maxRows: 1000,
    });

    await expect(execution).rejects.toBeInstanceOf(KtxQueryError);
    await expect(execution).rejects.toThrow("syntax error line 4 at position 14 unexpected 'rows'.");
    await expect(execution).rejects.toMatchObject({ cause: driverError });
    expect(connector.cleanup).toHaveBeenCalled();
  });

  it('lets connector programming faults propagate instead of masking them as query errors', async () => {
    const project = await initKtxProject({ projectDir: tempDir });
    project.config.connections.warehouse = {
      driver: 'snowflake',
      url: 'env:DATABASE_URL',
    };
    const bug = new TypeError("Cannot read properties of undefined (reading 'rows')");
    const connector: KtxScanConnector = {
      ...testConnector(testSnapshot(), { headers: [], rows: [], totalRows: 0, rowCount: 0 }),
      executeReadOnly: vi.fn(async () => {
        throw bug;
      }),
    };
    const sqlAnalysis = {
      analyzeForFingerprint: vi.fn(),
      analyzeBatch: vi.fn(),
      validateReadOnly: vi.fn(async () => ({ ok: true, error: null })),
    };
    const ports = createLocalProjectMcpContextPorts(project, {
      sqlAnalysis,
      localScan: { createConnector: vi.fn(async () => connector) },
      embeddingService: null,
    });

    const execution = ports.sqlExecution?.execute({
      connectionId: 'warehouse',
      sql: 'select 1',
      maxRows: 10,
    });

    await expect(execution).rejects.toBe(bug);
    await expect(execution).rejects.toBeInstanceOf(TypeError);
    expect(connector.cleanup).toHaveBeenCalled();
  });

  it('exposes local scan entity details through MCP ports', async () => {
    const project = await initKtxProject({ projectDir: tempDir });
    project.config.connections.warehouse = {
      driver: 'postgres',
      url: 'env:DATABASE_URL',
    };
    await seedScanReport(project.projectDir);
    const ports = createLocalProjectMcpContextPorts(project, { embeddingService: null });

    await expect(
      ports.entityDetails?.read({
        connectionId: 'warehouse',
        entities: [{ table: 'public.orders', columns: ['id'] }],
      }),
    ).resolves.toMatchObject({
      results: [
        {
          ok: true,
          connectionId: 'warehouse',
          display: 'public.orders',
          columns: [{ name: 'id', nativeType: 'integer' }],
          snapshot: { syncId: 'sync-1', scanRunId: 'scan-1' },
        },
      ],
    });
  });

  it('returns a structured local entity details error when no scan exists', async () => {
    const project = await initKtxProject({ projectDir: tempDir });
    project.config.connections.warehouse = {
      driver: 'postgres',
      url: 'env:DATABASE_URL',
    };
    const ports = createLocalProjectMcpContextPorts(project, { embeddingService: null });

    await expect(
      ports.entityDetails?.read({
        connectionId: 'warehouse',
        entities: [{ table: 'public.orders' }],
      }),
    ).resolves.toMatchObject({
      results: [
        {
          ok: false,
          connectionId: 'warehouse',
          error: { code: 'scan_missing' },
        },
      ],
    });
  });

  it('exposes local dictionary search through MCP ports', async () => {
    const project = await initKtxProject({ projectDir: tempDir });
    project.config.connections.warehouse = {
      driver: 'postgres',
      url: 'env:DATABASE_URL',
    };
    await project.fileStore.writeFile(
      'raw-sources/warehouse/live-database/sync-1/enrichment/relationship-profile.json',
      `${JSON.stringify(
        {
          connectionId: 'warehouse',
          driver: 'postgres',
          sqlAvailable: true,
          queryCount: 4,
          tables: [],
          columns: {
            'orders.status': {
              table: { catalog: null, db: 'public', name: 'orders' },
              column: 'status',
              nativeType: 'text',
              normalizedType: 'string',
              distinctCount: 2,
              sampleValues: ['paid', 'refunded'],
            },
          },
          warnings: [],
        },
        null,
        2,
      )}\n`,
      'ktx',
      'ktx@example.com',
      'Seed dictionary profile',
    );

    const ports = createLocalProjectMcpContextPorts(project, { embeddingService: null });

    await expect(ports.dictionarySearch?.search({ values: ['paid'] })).resolves.toMatchObject({
      searched: [{ connectionId: 'warehouse', status: 'ready' }],
      results: [
        {
          value: 'paid',
          matches: [{ connectionId: 'warehouse', sourceName: 'orders', columnName: 'status', matchedValue: 'paid' }],
          misses: [],
        },
      ],
    });
  });

  it('reports missing local dictionary profiles through MCP ports', async () => {
    const project = await initKtxProject({ projectDir: tempDir });
    project.config.connections.warehouse = {
      driver: 'postgres',
      url: 'env:DATABASE_URL',
    };

    const ports = createLocalProjectMcpContextPorts(project, { embeddingService: null });

    await expect(ports.dictionarySearch?.search({ values: ['paid'] })).resolves.toEqual({
      searched: [
        {
          connectionId: 'warehouse',
          coverage: {
            sampledRows: null,
            valuesPerColumn: null,
            profiledColumns: 0,
            syncId: null,
            profiledAt: null,
          },
          status: 'no_profile_artifact',
        },
      ],
      results: [
        {
          value: 'paid',
          matches: [],
          misses: [{ connectionId: 'warehouse', reason: 'no_profile_artifact' }],
        },
      ],
    });
  });

  it('exposes local project discover_data across wiki, semantic-layer, and raw schema', async () => {
    const project = await initKtxProject({ projectDir: tempDir });
    project.config.connections.warehouse = {
      driver: 'postgres',
      url: 'env:DATABASE_URL',
    };
    await project.fileStore.writeFile(
      'wiki/global/orders-playbook.md',
      [
        '---',
        'summary: Paid order operations',
        'tags: [orders]',
        'refs: []',
        'sl_refs: []',
        'usage_mode: auto',
        '---',
        '',
        'Paid orders are used for customer activity analysis.',
        '',
      ].join('\n'),
      'ktx',
      'ktx@example.com',
      'seed wiki',
    );
    await project.fileStore.writeFile(
      'semantic-layer/warehouse/orders.yaml',
      [
        'name: orders',
        'descriptions:',
        '  user: Paid order facts',
        'table: public.orders',
        'grain: [id]',
        'columns:',
        '  - name: status',
        '    type: string',
        '    descriptions:',
        '      user: Payment status',
        'measures:',
        '  - name: order_count',
        '    expr: count(*)',
        '    description: Number of paid orders',
        '',
      ].join('\n'),
      'ktx',
      'ktx@example.com',
      'seed sl',
    );
    await project.fileStore.writeFile(
      'raw-sources/warehouse/live-database/sync-1/connection.json',
      JSON.stringify({ connectionId: 'warehouse', driver: 'postgres', extractedAt: '2026-05-14T09:00:00.000Z' }, null, 2),
      'ktx',
      'ktx@example.com',
      'seed connection',
    );
    await project.fileStore.writeFile(
      'raw-sources/warehouse/live-database/sync-1/tables/public-orders.json',
      JSON.stringify(
        {
          catalog: null,
          db: 'public',
          name: 'orders',
          kind: 'table',
          comment: 'Orders table',
          estimatedRows: 10,
          columns: [
            {
              name: 'status',
              nativeType: 'text',
              normalizedType: 'text',
              dimensionType: 'string',
              nullable: false,
              primaryKey: false,
              comment: 'Order status',
              sampleValues: ['paid'],
            },
          ],
          foreignKeys: [],
        },
        null,
        2,
      ),
      'ktx',
      'ktx@example.com',
      'seed table',
    );
    await project.fileStore.writeFile(
      'raw-sources/warehouse/live-database/sync-1/scan-report.json',
      JSON.stringify(
        {
          connectionId: 'warehouse',
          driver: 'postgres',
          syncId: 'sync-1',
          runId: 'scan-1',
          trigger: 'mcp',
          mode: 'enriched',
          dryRun: false,
          artifactPaths: {
            rawSourcesDir: 'raw-sources/warehouse/live-database/sync-1',
            reportPath: 'raw-sources/warehouse/live-database/sync-1/scan-report.json',
            manifestShards: [],
            enrichmentArtifacts: [],
          },
          diffSummary: {
            tablesAdded: 1,
            tablesModified: 0,
            tablesDeleted: 0,
            tablesUnchanged: 0,
            columnsAdded: 0,
            columnsModified: 0,
            columnsDeleted: 0,
          },
          manifestShardsWritten: 0,
          structuralSyncStats: {
            tablesCreated: 0,
            tablesUpdated: 0,
            tablesDeleted: 0,
            columnsCreated: 0,
            columnsUpdated: 0,
            columnsDeleted: 0,
          },
          enrichment: {
            dataDictionary: 'completed',
            tableDescriptions: 'completed',
            columnDescriptions: 'completed',
            embeddings: 'skipped',
            deterministicRelationships: 'skipped',
            llmRelationshipValidation: 'skipped',
            statisticalValidation: 'skipped',
          },
          capabilityGaps: [],
          warnings: [],
          relationships: { accepted: 0, review: 0, rejected: 0, skipped: 0 },
          enrichmentState: { resumedStages: [], completedStages: [], failedStages: [] },
          createdAt: '2026-05-14T09:00:00.000Z',
        },
        null,
        2,
      ),
      'ktx',
      'ktx@example.com',
      'seed scan report',
    );

    const ports = createLocalProjectMcpContextPorts(project, { embeddingService: null });
    const results = await ports.discover?.search({ query: 'paid orders', connectionId: 'warehouse', limit: 10 });

    expect(results).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ kind: 'wiki', id: 'orders-playbook' }),
        expect.objectContaining({ kind: 'sl_source', id: 'orders', connectionId: 'warehouse' }),
        expect.objectContaining({ kind: 'table', id: 'public.orders', connectionId: 'warehouse' }),
      ]),
    );
  });

  it('reads and searches seeded global wiki pages', async () => {
    const project = await initKtxProject({ projectDir: tempDir });
    await project.fileStore.writeFile(
      'wiki/global/revenue.md',
      [
        '---',
        'summary: Revenue definition',
        'tags: [finance]',
        'refs: [docs/revenue.md]',
        'sl_refs: [warehouse.orders]',
        'usage_mode: auto',
        '---',
        '',
        '# Revenue',
        '',
        'Revenue is net of refunds.',
        '',
      ].join('\n'),
      'ktx',
      'ktx@example.com',
      'Seed wiki',
    );
    const ports = createLocalProjectMcpContextPorts(project, { embeddingService: null });

    await expect(ports.knowledge?.read({ userId: 'local-user', key: 'revenue' })).resolves.toMatchObject({
      key: 'revenue',
      scope: 'GLOBAL',
      summary: 'Revenue definition',
      tags: ['finance'],
      refs: ['docs/revenue.md'],
      slRefs: ['warehouse.orders'],
      content: '# Revenue\n\nRevenue is net of refunds.',
    });

    const search = await ports.knowledge?.search({ userId: 'local-user', query: 'refunds', limit: 5 });
    expect(search).toEqual({
      results: [
        expect.objectContaining({
          key: 'revenue',
          path: 'wiki/global/revenue.md',
          scope: 'GLOBAL',
          summary: 'Revenue definition',
          score: expect.any(Number),
          matchReasons: expect.arrayContaining(['lexical']),
        }),
      ],
      totalFound: 1,
    });
    expect(search?.results[0]?.score).toBeGreaterThan(0);
  });

  it('scopes wiki_search to a connection and validates the connection id', async () => {
    const project = await initKtxProject({ projectDir: tempDir });
    project.config.connections.sales_db = { driver: 'sqlite', url: 'file:sales.db' };
    project.config.connections.events_db = { driver: 'sqlite', url: 'file:events.db' };
    const seed = async (key: string, connections: string[]) => {
      await project.fileStore.writeFile(
        `wiki/global/${key}.md`,
        [
          '---',
          `summary: Orders for ${key}`,
          'usage_mode: auto',
          ...(connections.length > 0 ? ['connections:', ...connections.map((id) => `  - ${id}`)] : []),
          '---',
          '',
          'Orders are recognized when paid.',
          '',
        ].join('\n'),
        'ktx',
        'ktx@example.com',
        `seed ${key}`,
      );
    };
    await seed('orders-sales', ['sales_db']);
    await seed('orders-events', ['events_db']);
    await seed('orders-global', []);

    const ports = createLocalProjectMcpContextPorts(project, { embeddingService: null });

    const scoped = await ports.knowledge?.search({
      userId: 'local-user',
      query: 'orders paid',
      limit: 10,
      connectionId: 'sales_db',
    });
    expect(scoped?.results.map((result) => result.key).sort()).toEqual(['orders-global', 'orders-sales']);

    await expect(
      ports.knowledge?.search({ userId: 'local-user', query: 'orders', limit: 10, connectionId: 'warehouse' }),
    ).rejects.toThrow('Unknown connection "warehouse". Configured connections: events_db, sales_db.');
  });

  it('reads seeded semantic-layer sources', async () => {
    const project = await initKtxProject({ projectDir: tempDir });
    await seedSlSourceFile(project, {
      connectionId: 'warehouse',
      sourceName: 'orders',
      yaml: [
        'name: orders',
        'table: public.orders',
        'grain:',
        '  - id',
        'columns:',
        '  - name: id',
        '    type: number',
        '',
      ].join('\n'),
    });
    const ports = createLocalProjectMcpContextPorts(project, { embeddingService: null });

    await expect(
      ports.semanticLayer?.readSource({ connectionId: 'warehouse', sourceName: 'orders' }),
    ).resolves.toMatchObject({
      sourceName: 'orders',
      yaml: expect.stringContaining('name: orders'),
    });
  });

  it('reads manifest-backed sources with uppercase warehouse identifiers', async () => {
    const project = await initKtxProject({ projectDir: tempDir });
    await project.fileStore.writeFile(
      'semantic-layer/warehouse/_schema/PUBLIC.yaml',
      [
        'tables:',
        '  WIDGET_SALES:',
        '    table: PUBLIC.WIDGET_SALES',
        '    columns:',
        '      - name: ID',
        '        type: number',
        '        pk: true',
        '',
      ].join('\n'),
      'ktx',
      'ktx@example.com',
      'seed uppercase manifest shard',
    );
    const ports = createLocalProjectMcpContextPorts(project, { embeddingService: null });

    await expect(
      ports.semanticLayer?.readSource({ connectionId: 'warehouse', sourceName: 'WIDGET_SALES' }),
    ).resolves.toMatchObject({
      sourceName: 'WIDGET_SALES',
      yaml: expect.stringContaining('table: PUBLIC.WIDGET_SALES'),
    });
  });

  it('composes an overlay written for an uppercase manifest source at a derived filename', async () => {
    const project = await initKtxProject({ projectDir: tempDir });
    await project.fileStore.writeFile(
      'semantic-layer/warehouse/_schema/PUBLIC.yaml',
      [
        'tables:',
        '  WIDGET_SALES:',
        '    table: PUBLIC.WIDGET_SALES',
        '    columns:',
        '      - name: ID',
        '        type: number',
        '        pk: true',
        '',
      ].join('\n'),
      'ktx',
      'ktx@example.com',
      'seed uppercase manifest shard',
    );

    // The production write path: agents overlay manifest sources via
    // SemanticLayerService.writeSource using the verbatim warehouse name.
    const service = new SemanticLayerService(project.fileStore as never, {} as never, {} as never);
    const overlay = {
      name: 'WIDGET_SALES',
      measures: [{ name: 'widget_sales_count', expr: 'count(*)' }],
    } as SemanticLayerSource;
    const write = await service.writeSource('warehouse', overlay, 'ktx', 'ktx@example.com');
    expect(write.path).toMatch(/^semantic-layer\/warehouse\/widget_sales-[0-9a-f]{8}\.yaml$/);

    const ports = createLocalProjectMcpContextPorts(project, { embeddingService: null });
    await expect(
      ports.semanticLayer?.readSource({ connectionId: 'warehouse', sourceName: 'WIDGET_SALES' }),
    ).resolves.toMatchObject({
      sourceName: 'WIDGET_SALES',
      yaml: expect.stringContaining('widget_sales_count'),
    });
  });

  it('returns a standalone source verbatim even when its YAML is currently broken', async () => {
    const project = await initKtxProject({ projectDir: tempDir });
    await project.fileStore.writeFile(
      'semantic-layer/warehouse/orders.yaml',
      'name: orders\nmeasures:\n  - name: revenue\n    expr: [unterminated\n',
      'ktx',
      'ktx@example.com',
      'seed broken source mid-edit',
    );
    const ports = createLocalProjectMcpContextPorts(project, { embeddingService: null });

    await expect(
      ports.semanticLayer?.readSource({ connectionId: 'warehouse', sourceName: 'orders' }),
    ).resolves.toMatchObject({
      sourceName: 'orders',
      yaml: expect.stringContaining('[unterminated'),
    });
  });

  it('keeps path-traversal keys away from the project directory', async () => {
    const project = await initKtxProject({ projectDir: tempDir });
    const ports = createLocalProjectMcpContextPorts(project, { embeddingService: null });

    await expect(
      ports.knowledge?.read({
        userId: 'local-user',
        key: '../outside',
      }),
    ).rejects.toThrow('Invalid wiki key "../outside". Wiki keys must be flat; use "outside".');

    // Source reads never derive a file path from the name; a traversal-style
    // name simply matches no record.
    await expect(
      ports.semanticLayer?.readSource({
        connectionId: 'warehouse',
        sourceName: '../orders',
      }),
    ).resolves.toBeNull();
  });

  it('uses semantic compute for compile-only sl_query when supplied', async () => {
    const project = await initKtxProject({ projectDir: tempDir });
    project.config.connections.warehouse = {
      driver: 'postgres',
      url: 'env:DATABASE_URL',
    };
    await seedSlSourceFile(project, {
      connectionId: 'warehouse',
      sourceName: 'orders',
      yaml: [
        'name: orders',
        'table: public.orders',
        'grain:',
        '  - id',
        'columns:',
        '  - name: id',
        '    type: number',
        '  - name: status',
        '    type: string',
        'joins: []',
        'measures:',
        '  - name: order_count',
        '    expr: count(*)',
        '',
      ].join('\n'),
    });

    const semanticLayerCompute = {
      validateSources: vi.fn(),
      query: vi.fn(async () => ({
        sql: 'select status, count(*) as order_count from public.orders group by status',
        dialect: 'postgres',
        columns: [{ name: 'orders.status' }, { name: 'orders.order_count' }],
        plan: { sources_used: ['orders'] },
      })),
      generateSources: vi.fn(),
    };
    const ports = createLocalProjectMcpContextPorts(project, { semanticLayerCompute, embeddingService: null });

    await expect(
      ports.semanticLayer?.query({
        connectionId: 'warehouse',
        query: {
          measures: ['orders.order_count'],
          dimensions: ['orders.status'],
        },
      }),
    ).resolves.toMatchObject({
      sql: 'select status, count(*) as order_count from public.orders group by status',
      headers: ['orders.status', 'orders.order_count'],
      rows: [],
      totalRows: 0,
      plan: {
        sources_used: ['orders'],
        execution: {
          mode: 'compile_only',
          reason: 'Local semantic-layer query compiled SQL but no data-source execution adapter is configured.',
        },
      },
    });
  });

  it('executes local MCP sl_query when a query executor is configured', async () => {
    const project = await initKtxProject({ projectDir: tempDir });
    project.config.connections.warehouse = {
      driver: 'postgres',
      url: 'env:DATABASE_URL',
    };
    await seedSlSourceFile(project, {
      connectionId: 'warehouse',
      sourceName: 'orders',
      yaml: [
        'name: orders',
        'table: public.orders',
        'grain:',
        '  - id',
        'columns:',
        '  - name: id',
        '    type: number',
        'joins: []',
        'measures:',
        '  - name: order_count',
        '    expr: count(*)',
        '',
      ].join('\n'),
    });
    const compute = {
      validateSources: vi.fn(),
      generateSources: vi.fn(),
      query: vi.fn(async () => ({
        sql: 'select count(*) as order_count from public.orders',
        dialect: 'postgres',
        columns: [{ name: 'orders.order_count' }],
        plan: {},
      })),
    };
    const queryExecutor = {
      execute: vi.fn(async () => ({
        headers: ['orders.order_count'],
        rows: [[3]],
        totalRows: 1,
        command: 'SELECT',
        rowCount: 1,
      })),
    };
    const ports = createLocalProjectMcpContextPorts(project, {
      semanticLayerCompute: compute,
      queryExecutor,
      embeddingService: null,
    });

    const result = await ports.semanticLayer?.query({
      connectionId: 'warehouse',
      query: { measures: ['orders.order_count'], dimensions: [], limit: 5 },
    });

    expect(result?.rows).toEqual([[3]]);
    expect(result?.totalRows).toBe(1);
    expect(queryExecutor.execute).toHaveBeenCalledWith(
      expect.objectContaining({
        connectionId: 'warehouse',
        maxRows: 5,
      }),
    );
  });
});
