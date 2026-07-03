import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import YAML from 'yaml';
import type { SourceAdapter } from '../../../src/context/ingest/types.js';
import type { KtxLlmRuntimePort } from '../../../src/context/llm/runtime-port.js';
import { initKtxProject, type KtxLocalProject, loadKtxProject } from '../../../src/context/project/project.js';
import { resolveEnabledTables } from '../../../src/context/scan/enabled-tables.js';
import { getLocalScanReport, getLocalScanStatus, runLocalScan } from '../../../src/context/scan/local-scan.js';
import { tableRefKey, tableRefSet, type KtxTableRefKey } from '../../../src/context/scan/table-ref.js';
import type {
  KtxQueryResult,
  KtxReadOnlyQueryInput,
  KtxScanConnector,
  KtxSchemaSnapshot,
} from '../../../src/context/scan/types.js';

const connectorScopeListing = {
  listSchemas: vi.fn(async () => []),
  listTables: vi.fn(async () => []),
};

function relationshipSqlResult(
  input: KtxReadOnlyQueryInput,
  options: { throwOnCoverage?: boolean } = {},
): KtxQueryResult {
  if (input.sql.includes('child_values')) {
    if (options.throwOnCoverage) {
      throw new Error('validation failed for postgres://reader:secret@example.test/db'); // pragma: allowlist secret
    }
    return {
      headers: ['child_distinct', 'parent_distinct', 'overlap', 'violation_count'],
      rows: [[100, 100, 99, 0]],
      totalRows: 1,
      rowCount: 1,
    };
  }
  if (input.sql.includes(' AS column_name')) {
    const tableRowCount = input.sql.includes('orders') || input.sql.includes('users') ? 1000 : 100;
    const columnNames = Array.from(input.sql.matchAll(/'([^']+)' AS column_name/g), (match) => match[1]);
    return {
      headers: [
        'column_name',
        'table_row_count',
        'row_count',
        'null_count',
        'distinct_count',
        'min_text_length',
        'max_text_length',
        'sample_values',
      ],
      rows: columnNames.map((columnName) => [
        columnName,
        tableRowCount,
        tableRowCount,
        0,
        columnName === 'id' ? tableRowCount : 100,
        1,
        3,
        '1\u001f2',
      ]),
      totalRows: columnNames.length,
      rowCount: columnNames.length,
    };
  }
  if (input.sql.includes('COUNT(*) AS row_count') && !input.sql.includes('COUNT(DISTINCT')) {
    return {
      headers: ['row_count'],
      rows: [[input.sql.includes('orders') ? 1000 : 100]],
      totalRows: 1,
      rowCount: 1,
    };
  }
  if (input.sql.includes('COUNT(DISTINCT')) {
    return {
      headers: ['row_count', 'null_count', 'distinct_count', 'min_text_length', 'max_text_length'],
      rows: [[input.sql.includes('orders') ? 1000 : 100, 0, input.sql.includes('orders') ? 100 : 100, 1, 3]],
      totalRows: 1,
      rowCount: 1,
    };
  }
  if (input.sql.includes(' AS value')) {
    return {
      headers: ['value'],
      rows: [[1], [2]],
      totalRows: 2,
      rowCount: 2,
    };
  }
  throw new Error(`Unexpected relationship SQL: ${input.sql}`);
}

function deterministicLlmRuntime(): KtxLlmRuntimePort {
  return {
    generateText: vi.fn(async (input) => `Deterministic description for ${input.prompt.slice(0, 64).trim() || 'data source'}`),
    generateObject: vi.fn(async () => ({ pkCandidates: [], fkCandidates: [] }) as never),
    runAgentLoop: vi.fn(),
    subprocessForkSpec: () => null,
  };
}

async function writeLiveDatabaseConfig(projectDir: string): Promise<void> {
  await writeFile(
    join(projectDir, 'ktx.yaml'),
    [
      'connections:',
      '  warehouse:',
      '    driver: postgres',
      '    url: env:DATABASE_URL',
      'ingest:',
      '  adapters:',
      '    - live-database',
      '',
    ].join('\n'),
    'utf-8',
  );
}

async function writeDatabaseConfigWithoutIngestAdapters(projectDir: string): Promise<void> {
  await writeFile(
    join(projectDir, 'ktx.yaml'),
    [
      'connections:',
      '  warehouse:',
      '    driver: postgres',
      '    url: env:DATABASE_URL',
      '    readonly: true',
      '',
    ].join('\n'),
    'utf-8',
  );
}

function defaultFetchSnapshot(options: { extractedAt?: () => string } = {}): KtxSchemaSnapshot {
  return {
    connectionId: 'warehouse',
    driver: 'postgres',
    extractedAt: options.extractedAt?.() ?? '2026-04-29T09:00:00.000Z',
    scope: { schemas: ['public'] },
    metadata: {},
    tables: [
      {
        name: 'orders',
        catalog: null,
        db: 'public',
        kind: 'table',
        comment: null,
        estimatedRows: null,
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
    ],
  };
}

function fetchOnlyAdapter(options: { extractedAt?: () => string; snapshot?: KtxSchemaSnapshot } = {}): SourceAdapter {
  const scanSnapshot = options.snapshot
    ? { ...options.snapshot, ...(options.extractedAt ? { extractedAt: options.extractedAt() } : {}) }
    : defaultFetchSnapshot(options);

  return {
    source: 'live-database',
    skillNames: ['live_database_ingest'],
    async fetch(_pullConfig, stagedDir) {
      await mkdir(join(stagedDir, 'tables'), { recursive: true });
      await writeFile(
        join(stagedDir, 'connection.json'),
        `${JSON.stringify({
          connectionId: scanSnapshot.connectionId,
          driver: scanSnapshot.driver,
          extractedAt: scanSnapshot.extractedAt,
          scope: scanSnapshot.scope,
          metadata: scanSnapshot.metadata,
        })}\n`,
        'utf-8',
      );
      await writeFile(join(stagedDir, 'foreign-keys.json'), '{"foreignKeys":[]}\n', 'utf-8');
      if (scanSnapshot.warnings?.length) {
        await writeFile(
          join(stagedDir, 'warnings.json'),
          `${JSON.stringify({ warnings: scanSnapshot.warnings })}\n`,
          'utf-8',
        );
      }
      for (const table of scanSnapshot.tables) {
        await writeFile(join(stagedDir, 'tables', `${table.name}.json`), `${JSON.stringify(table)}\n`, 'utf-8');
      }
    },
    async detect() {
      return true;
    },
    async chunk() {
      return {
        workUnits: scanSnapshot.tables.map((table) => ({
          unitKey: `live-database-${table.db ?? 'default'}-${table.name}`,
          rawFiles: [`tables/${table.name}.json`],
          dependencyPaths: ['connection.json', 'foreign-keys.json'],
          peerFileIndex: [],
        })),
      };
    },
  };
}

function nativeScanSnapshot(): KtxSchemaSnapshot {
  return {
    connectionId: 'warehouse',
    driver: 'postgres',
    extractedAt: '2026-04-29T09:00:00.000Z',
    scope: { schemas: ['public'] },
    metadata: {},
    tables: [
      {
        catalog: null,
        db: 'public',
        name: 'orders',
        kind: 'table',
        comment: 'Orders',
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
            comment: 'Order id',
          },
        ],
      },
    ],
  };
}

function nativeScanConnector(options: { cleanup?: () => Promise<void> } = {}): KtxScanConnector {
  return {
    id: 'test:warehouse',
    driver: 'postgres',
    capabilities: {
      structuralIntrospection: true,
      tableSampling: true,
      columnSampling: true,
      columnStats: false,
      readOnlySql: false,
      nestedAnalysis: false,
      eventStreamDiscovery: false,
      formalForeignKeys: false,
      estimatedRowCounts: false,
    },
    ...connectorScopeListing,
    introspect: vi.fn(async () => nativeScanSnapshot()),
    sampleTable: vi.fn(async () => ({ headers: ['id'], rows: [[1]], totalRows: 1 })),
    sampleColumn: vi.fn(async () => ({ values: ['1'], nullCount: 0, distinctCount: 1 })),
    ...(options.cleanup ? { cleanup: options.cleanup } : {}),
  };
}

describe('local scan', () => {
  let tempDir: string;
  let project: KtxLocalProject;

  beforeEach(async () => {
    tempDir = await mkdtemp(join(tmpdir(), 'ktx-local-scan-'));
    const projectDir = join(tempDir, 'project');
    await initKtxProject({ projectDir });
    await writeLiveDatabaseConfig(projectDir);
    project = await loadKtxProject({ projectDir });
  });

  afterEach(async () => {
    await rm(tempDir, { recursive: true, force: true });
  });

  it('runs a structural live-database scan and writes a durable scan report', async () => {
    const result = await runLocalScan({
      project,
      adapters: [fetchOnlyAdapter()],
      connectionId: 'warehouse',
      jobId: 'scan-run-1',
      now: () => new Date('2026-04-29T09:00:00.000Z'),
    });

    expect(result.report).toMatchObject({
      connectionId: 'warehouse',
      driver: 'postgres',
      runId: 'scan-run-1',
      syncId: '2026-04-29-090000-scan-run-1',
      trigger: 'cli',
      mode: 'structural',
      dryRun: false,
      artifactPaths: {
        rawSourcesDir: 'raw-sources/warehouse/live-database/2026-04-29-090000-scan-run-1',
        reportPath: 'raw-sources/warehouse/live-database/2026-04-29-090000-scan-run-1/scan-report.json',
        manifestShards: ['semantic-layer/warehouse/_schema/public.yaml'],
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
      manifestShardsWritten: 1,
      relationships: { accepted: 0, review: 0, rejected: 0, skipped: 0 },
    });

    await expect(
      readFile(
        join(project.projectDir, 'raw-sources/warehouse/live-database/2026-04-29-090000-scan-run-1/scan-report.json'),
        'utf-8',
      ),
    ).resolves.toContain('"runId": "scan-run-1"');

    const structuralManifest = await readFile(
      join(project.projectDir, 'semantic-layer/warehouse/_schema/public.yaml'),
      'utf-8',
    );
    expect(structuralManifest).toContain('orders:');
    expect(structuralManifest).toContain('table: public.orders');
    expect(structuralManifest).toContain('name: id');
    expect(structuralManifest).not.toContain('ai:');

    await expect(getLocalScanStatus(project, 'scan-run-1')).resolves.toMatchObject({
      runId: 'scan-run-1',
      status: 'done',
      done: true,
      connectionId: 'warehouse',
      mode: 'structural',
      reportPath: 'raw-sources/warehouse/live-database/2026-04-29-090000-scan-run-1/scan-report.json',
    });
    await expect(getLocalScanReport(project, 'scan-run-1')).resolves.toMatchObject({
      runId: 'scan-run-1',
      connectionId: 'warehouse',
    });
  });

  it('threads structural snapshot warnings into the final scan report', async () => {
    const result = await runLocalScan({
      project,
      adapters: [
        fetchOnlyAdapter({
          snapshot: {
            ...defaultFetchSnapshot(),
            warnings: [
              {
                code: 'constraint_discovery_unauthorized',
                message: 'Skipped primary-key discovery in public (insufficient grants on system catalogs)',
                recoverable: true,
                metadata: { schema: 'public', kind: 'primary_key' },
              },
            ],
          },
        }),
      ],
      connectionId: 'warehouse',
      jobId: 'scan-run-structural-warnings',
      now: () => new Date('2026-04-29T09:01:00.000Z'),
    });

    expect(result.report.warnings).toEqual([
      {
        code: 'constraint_discovery_unauthorized',
        message: 'Skipped primary-key discovery in public (insufficient grants on system catalogs)',
        recoverable: true,
        metadata: { schema: 'public', kind: 'primary_key' },
      },
    ]);
    await expect(
      readFile(
        join(
          project.projectDir,
          'raw-sources/warehouse/live-database/2026-04-29-090100-scan-run-structural-warnings/scan-report.json',
        ),
        'utf-8',
      ),
    ).resolves.toContain('"constraint_discovery_unauthorized"');
  });

  it('passes enabled_tables as fetch context tableScope and does not post-filter staged snapshots', async () => {
    project.config.connections.warehouse = {
      ...project.config.connections.warehouse,
      enabled_tables: ['public.orders'],
    };
    let capturedTableScope: ReadonlySet<KtxTableRefKey> | undefined;
    const adapter: SourceAdapter = {
      source: 'live-database',
      skillNames: ['live_database_ingest'],
      async fetch(_pullConfig, stagedDir, ctx) {
        capturedTableScope = ctx.tableScope;
        await mkdir(join(stagedDir, 'tables'), { recursive: true });
        await writeFile(
          join(stagedDir, 'connection.json'),
          '{"connectionId":"warehouse","driver":"postgres","scope":{"schemas":["public"]},"metadata":{}}\n',
          'utf-8',
        );
        await writeFile(join(stagedDir, 'foreign-keys.json'), '{"foreignKeys":[]}\n', 'utf-8');
        await writeFile(
          join(stagedDir, 'tables', 'customers.json'),
          '{"name":"customers","catalog":null,"db":"public","kind":"table","comment":null,"estimatedRows":100,"columns":[{"name":"id","nativeType":"integer","normalizedType":"integer","dimensionType":"number","nullable":false,"primaryKey":true,"comment":null}],"foreignKeys":[]}\n',
          'utf-8',
        );
        await writeFile(
          join(stagedDir, 'tables', 'orders.json'),
          '{"name":"orders","catalog":null,"db":"public","kind":"table","comment":null,"estimatedRows":1000,"columns":[{"name":"id","nativeType":"integer","normalizedType":"integer","dimensionType":"number","nullable":false,"primaryKey":true,"comment":null}],"foreignKeys":[]}\n',
          'utf-8',
        );
      },
      async detect() {
        return true;
      },
      async chunk() {
        return {
          workUnits: [
            {
              unitKey: 'live-database-public-customers',
              rawFiles: ['tables/customers.json'],
              dependencyPaths: ['connection.json', 'foreign-keys.json'],
              peerFileIndex: [],
            },
            {
              unitKey: 'live-database-public-orders',
              rawFiles: ['tables/orders.json'],
              dependencyPaths: ['connection.json', 'foreign-keys.json'],
              peerFileIndex: [],
            },
          ],
        };
      },
    };

    const result = await runLocalScan({
      project,
      adapters: [adapter],
      connectionId: 'warehouse',
      jobId: 'scan-strict-scope-fetch',
      now: () => new Date('2026-05-22T00:00:00.000Z'),
    });

    expect([...(capturedTableScope ?? [])]).toEqual([...tableRefSet([{ catalog: null, db: 'public', name: 'orders' }])]);
    expect(result.report.diffSummary.tablesAdded).toBe(2);
    const structuralManifest = await readFile(join(project.projectDir, 'semantic-layer/warehouse/_schema/public.yaml'), 'utf-8');
    expect(structuralManifest).toContain('customers:');
    expect(structuralManifest).toContain('orders:');
  });

  it('runs a structural database scan when live-database is not listed in ktx.yaml', async () => {
    await writeDatabaseConfigWithoutIngestAdapters(project.projectDir);
    project = await loadKtxProject({ projectDir: project.projectDir });

    const result = await runLocalScan({
      project,
      adapters: [fetchOnlyAdapter()],
      connectionId: 'warehouse',
      jobId: 'scan-run-without-public-adapter',
      now: () => new Date('2026-04-29T09:10:00.000Z'),
    });

    expect(result.report).toMatchObject({
      connectionId: 'warehouse',
      runId: 'scan-run-without-public-adapter',
      artifactPaths: {
        reportPath: 'raw-sources/warehouse/live-database/2026-04-29-091000-scan-run-without-public-adapter/scan-report.json',
      },
    });
  });

  it('threads the structural snapshot into enrichment without connector re-introspection', async () => {
    project.config.scan.enrichment = { mode: 'deterministic' };
    const connector = nativeScanConnector();
    const introspect = vi.mocked(connector.introspect);

    const result = await runLocalScan({
      project,
      adapters: [fetchOnlyAdapter()],
      connectionId: 'warehouse',
      mode: 'enriched',
      connector,
      jobId: 'scan-enrichment-snapshot-threading',
      now: () => new Date('2026-04-29T09:11:00.000Z'),
    });

    expect(result.report.enrichment.tableDescriptions).toBe('completed');
    expect(introspect).not.toHaveBeenCalled();
  });

  it('cleans up a scan connector constructed by local scan', async () => {
    const cleanup = vi.fn(async () => undefined);

    await runLocalScan({
      project,
      adapters: [fetchOnlyAdapter()],
      connectionId: 'warehouse',
      mode: 'relationships',
      detectRelationships: true,
      createConnector: vi.fn(async () => nativeScanConnector({ cleanup })),
      jobId: 'scan-owned-connector-cleanup',
      now: () => new Date('2026-04-29T09:13:00.000Z'),
    });

    expect(cleanup).toHaveBeenCalledTimes(1);
  });

  it('does not clean up a caller-supplied scan connector', async () => {
    const cleanup = vi.fn(async () => undefined);

    await runLocalScan({
      project,
      adapters: [fetchOnlyAdapter()],
      connectionId: 'warehouse',
      mode: 'relationships',
      detectRelationships: true,
      connector: nativeScanConnector({ cleanup }),
      jobId: 'scan-supplied-connector-cleanup',
      now: () => new Date('2026-04-29T09:13:30.000Z'),
    });

    expect(cleanup).not.toHaveBeenCalled();
  });

  it('reuses scan report and raw-source paths when the same local scan run id is retried', async () => {
    const first = await runLocalScan({
      project,
      adapters: [fetchOnlyAdapter()],
      connectionId: 'warehouse',
      jobId: 'scan-idempotent-run',
      now: () => new Date('2026-04-29T09:20:00.000Z'),
    });

    const retry = await runLocalScan({
      project,
      adapters: [fetchOnlyAdapter()],
      connectionId: 'warehouse',
      jobId: 'scan-idempotent-run',
      now: () => new Date('2026-04-29T10:20:00.000Z'),
    });

    expect(retry.runId).toBe(first.runId);
    expect(retry.syncId).toBe(first.syncId);
    expect(retry.report.artifactPaths.rawSourcesDir).toBe(first.report.artifactPaths.rawSourcesDir);
    expect(retry.report.artifactPaths.reportPath).toBe(first.report.artifactPaths.reportPath);
    expect(retry.report.artifactPaths.manifestShards).toEqual(first.report.artifactPaths.manifestShards);

    const status = await getLocalScanStatus(project, 'scan-idempotent-run');
    expect(status?.syncId).toBe(first.syncId);
    expect(status?.reportPath).toBe(first.report.artifactPaths.reportPath);

    const files = await project.fileStore.listFiles('raw-sources/warehouse/live-database');
    expect(files.files.every((file) => file.includes('2026-04-29-092000-scan-idempotent-run'))).toBe(true);
    expect(files.files.some((file) => file.includes('2026-04-29-102000-scan-idempotent-run'))).toBe(false);
  });

  it('reuses existing scan artifacts without writing when a new scan run has unchanged input', async () => {
    let extractedAt = '2026-04-29T09:25:00.000Z';
    const adapter = fetchOnlyAdapter({ extractedAt: () => extractedAt });
    const first = await runLocalScan({
      project,
      adapters: [adapter],
      connectionId: 'warehouse',
      jobId: 'scan-idempotent-new-run-1',
      now: () => new Date('2026-04-29T09:25:00.000Z'),
    });

    const writeSpy = vi.spyOn(project.fileStore, 'writeFile');
    const commitSpy = vi.spyOn(project.git, 'commitFiles');

    extractedAt = '2026-04-29T10:25:00.000Z';
    const second = await runLocalScan({
      project,
      adapters: [adapter],
      connectionId: 'warehouse',
      jobId: 'scan-idempotent-new-run-2',
      now: () => new Date('2026-04-29T10:25:00.000Z'),
    });

    expect(second.runId).toBe('scan-idempotent-new-run-2');
    expect(second.syncId).toBe(first.syncId);
    expect(second.report.runId).toBe('scan-idempotent-new-run-2');
    expect(second.report.artifactPaths.rawSourcesDir).toBe(first.report.artifactPaths.rawSourcesDir);
    expect(second.report.artifactPaths.reportPath).toBe(first.report.artifactPaths.reportPath);
    expect(second.report.artifactPaths.manifestShards).toEqual(first.report.artifactPaths.manifestShards);
    expect(second.report.diffSummary).toMatchObject({
      tablesAdded: 0,
      tablesModified: 0,
      tablesDeleted: 0,
      tablesUnchanged: 1,
    });
    expect(writeSpy).not.toHaveBeenCalled();
    expect(commitSpy).not.toHaveBeenCalled();

    await expect(getLocalScanReport(project, 'scan-idempotent-new-run-2')).resolves.toMatchObject({
      runId: 'scan-idempotent-new-run-2',
      syncId: first.syncId,
      diffSummary: {
        tablesAdded: 0,
        tablesModified: 0,
        tablesDeleted: 0,
        tablesUnchanged: 1,
        columnsAdded: 0,
        columnsModified: 0,
        columnsDeleted: 0,
      },
    });

    const files = await project.fileStore.listFiles('raw-sources/warehouse/live-database');
    expect(files.files.every((file) => file.includes(first.syncId))).toBe(true);

    writeSpy.mockRestore();
    commitSpy.mockRestore();
  });

  it('returns an in-memory dry-run report without persisting scan status or report files', async () => {
    const result = await runLocalScan({
      project,
      adapters: [fetchOnlyAdapter()],
      connectionId: 'warehouse',
      jobId: 'scan-dry-run-1',
      now: () => new Date('2026-04-29T09:05:00.000Z'),
      dryRun: true,
    });

    expect(result.report).toMatchObject({
      runId: 'scan-dry-run-1',
      dryRun: true,
      artifactPaths: {
        rawSourcesDir: null,
        reportPath: null,
        manifestShards: [],
        enrichmentArtifacts: [],
      },
    });
    await expect(getLocalScanStatus(project, 'scan-dry-run-1')).resolves.toBeNull();
    await expect(getLocalScanReport(project, 'scan-dry-run-1')).resolves.toBeNull();
  });

  it('runs relationship scans through a native scan connector and records relationship summary', async () => {
    const connector = {
      id: 'test:warehouse',
      driver: 'postgres' as const,
      capabilities: {
        structuralIntrospection: true as const,
        tableSampling: false,
        columnSampling: false,
        columnStats: false,
        readOnlySql: false,
        nestedAnalysis: false,
        eventStreamDiscovery: false,
        formalForeignKeys: false,
        estimatedRowCounts: false,
      },
      ...connectorScopeListing,
      async introspect() {
        return {
          connectionId: 'warehouse',
          driver: 'postgres' as const,
          extractedAt: '2026-04-29T09:00:00.000Z',
          scope: { schemas: ['public'] },
          metadata: {},
          tables: [
            {
              catalog: null,
              db: 'public',
              name: 'customers',
              kind: 'table' as const,
              comment: null,
              estimatedRows: null,
              foreignKeys: [],
              columns: [
                {
                  name: 'id',
                  nativeType: 'integer',
                  normalizedType: 'integer',
                  dimensionType: 'number' as const,
                  nullable: false,
                  primaryKey: true,
                  comment: null,
                },
              ],
            },
            {
              catalog: null,
              db: 'public',
              name: 'orders',
              kind: 'table' as const,
              comment: null,
              estimatedRows: null,
              foreignKeys: [],
              columns: [
                {
                  name: 'customer_id',
                  nativeType: 'integer',
                  normalizedType: 'integer',
                  dimensionType: 'number' as const,
                  nullable: false,
                  primaryKey: false,
                  comment: null,
                },
              ],
            },
          ],
        };
      },
    };
    const adapter = fetchOnlyAdapter({ snapshot: await connector.introspect() });

    const result = await runLocalScan({
      project,
      adapters: [adapter],
      connectionId: 'warehouse',
      mode: 'relationships',
      detectRelationships: true,
      connector,
      jobId: 'scan-relationships-1',
      now: () => new Date('2026-04-29T09:10:00.000Z'),
    });

    expect(result.report.mode).toBe('relationships');
    expect(result.report.enrichment.deterministicRelationships).toBe('completed');
    expect(result.report.relationships).toEqual({ accepted: 0, review: 1, rejected: 0, skipped: 0 });
  });

  it('records standalone statistical validation results in the scan report', async () => {
    const connector = {
      id: 'test:warehouse',
      driver: 'postgres' as const,
      capabilities: {
        structuralIntrospection: true as const,
        tableSampling: false,
        columnSampling: false,
        columnStats: true,
        readOnlySql: true,
        nestedAnalysis: false,
        eventStreamDiscovery: false,
        formalForeignKeys: false,
        estimatedRowCounts: true,
      },
      ...connectorScopeListing,
      async introspect() {
        return {
          connectionId: 'warehouse',
          driver: 'postgres' as const,
          extractedAt: '2026-04-29T09:00:00.000Z',
          scope: { schemas: ['public'] },
          metadata: {},
          tables: [
            {
              catalog: null,
              db: 'public',
              name: 'customers',
              kind: 'table' as const,
              comment: null,
              estimatedRows: 100,
              foreignKeys: [],
              columns: [
                {
                  name: 'id',
                  nativeType: 'integer',
                  normalizedType: 'integer',
                  dimensionType: 'number' as const,
                  nullable: false,
                  primaryKey: true,
                  comment: null,
                },
              ],
            },
            {
              catalog: null,
              db: 'public',
              name: 'orders',
              kind: 'table' as const,
              comment: null,
              estimatedRows: 1000,
              foreignKeys: [],
              columns: [
                {
                  name: 'customer_id',
                  nativeType: 'integer',
                  normalizedType: 'integer',
                  dimensionType: 'number' as const,
                  nullable: false,
                  primaryKey: false,
                  comment: null,
                },
              ],
            },
          ],
        };
      },
      async executeReadOnly(input: KtxReadOnlyQueryInput) {
        return relationshipSqlResult(input);
      },
    };
    const adapter = fetchOnlyAdapter({ snapshot: await connector.introspect() });

    const result = await runLocalScan({
      project,
      adapters: [adapter],
      connectionId: 'warehouse',
      mode: 'relationships',
      detectRelationships: true,
      connector,
      jobId: 'scan-statistical-relationships-1',
      now: () => new Date('2026-04-29T09:12:00.000Z'),
    });

    expect(result.report.enrichment.statisticalValidation).toBe('completed');
    expect(result.report.relationships).toEqual({ accepted: 1, review: 0, rejected: 0, skipped: 0 });
    expect(result.report.warnings).toEqual([]);
  });

  it('keeps prototype connector methods when enabled_tables is configured', async () => {
    project.config.connections.warehouse = {
      ...project.config.connections.warehouse,
      enabled_tables: ['public.customers', 'public.orders'],
    };
    const scopedAdapter: SourceAdapter = {
      source: 'live-database',
      skillNames: ['live_database_ingest'],
      async fetch(_pullConfig, stagedDir) {
        await mkdir(join(stagedDir, 'tables'), { recursive: true });
        await writeFile(
          join(stagedDir, 'connection.json'),
          '{"connectionId":"warehouse","driver":"postgres","scope":{"schemas":["public"]},"metadata":{}}\n',
          'utf-8',
        );
        await writeFile(join(stagedDir, 'foreign-keys.json'), '{"foreignKeys":[]}\n', 'utf-8');
        await writeFile(
          join(stagedDir, 'tables', 'customers.json'),
          '{"name":"customers","catalog":null,"db":"public","kind":"table","comment":null,"estimatedRows":100,"columns":[{"name":"id","nativeType":"integer","normalizedType":"integer","dimensionType":"number","nullable":false,"primaryKey":true,"comment":null}],"foreignKeys":[]}\n',
          'utf-8',
        );
        await writeFile(
          join(stagedDir, 'tables', 'orders.json'),
          '{"name":"orders","catalog":null,"db":"public","kind":"table","comment":null,"estimatedRows":1000,"columns":[{"name":"customer_id","nativeType":"integer","normalizedType":"integer","dimensionType":"number","nullable":false,"primaryKey":false,"comment":null}],"foreignKeys":[]}\n',
          'utf-8',
        );
      },
      async detect() {
        return true;
      },
      async chunk() {
        return {
          workUnits: [
            {
              unitKey: 'live-database-public-customers',
              rawFiles: ['tables/customers.json'],
              dependencyPaths: ['connection.json', 'foreign-keys.json'],
              peerFileIndex: [],
            },
            {
              unitKey: 'live-database-public-orders',
              rawFiles: ['tables/orders.json'],
              dependencyPaths: ['connection.json', 'foreign-keys.json'],
              peerFileIndex: [],
            },
          ],
        };
      },
    };
    class FakeClassConnector implements KtxScanConnector {
      readonly id = 'test:warehouse';
      readonly driver = 'postgres' as const;
      readonly capabilities = {
        structuralIntrospection: true as const,
        tableSampling: false,
        columnSampling: false,
        columnStats: true,
        readOnlySql: true,
        nestedAnalysis: false,
        eventStreamDiscovery: false,
        formalForeignKeys: false,
        estimatedRowCounts: true,
      };

      async introspect(): Promise<KtxSchemaSnapshot> {
        return {
          connectionId: 'warehouse',
          driver: 'postgres',
          extractedAt: '2026-05-22T00:00:00.000Z',
          scope: { schemas: ['public'] },
          metadata: {},
          tables: [
            {
              catalog: null,
              db: 'public',
              name: 'customers',
              kind: 'table',
              comment: null,
              estimatedRows: 100,
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
            {
              catalog: null,
              db: 'public',
              name: 'orders',
              kind: 'table',
              comment: null,
              estimatedRows: 1000,
              foreignKeys: [],
              columns: [
                {
                  name: 'customer_id',
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
      }

      async listSchemas(): Promise<string[]> {
        return [];
      }

      async listTables() {
        return [];
      }

      async executeReadOnly(input: KtxReadOnlyQueryInput): Promise<KtxQueryResult> {
        return relationshipSqlResult(input);
      }
    }

    const result = await runLocalScan({
      project,
      adapters: [scopedAdapter],
      connectionId: 'warehouse',
      mode: 'relationships',
      detectRelationships: true,
      connector: new FakeClassConnector(),
      jobId: 'scan-prototype-connector-scope',
      now: () => new Date('2026-05-22T00:00:00.000Z'),
    });

    expect(result.report.relationships.accepted).toBe(1);
    expect(result.report.warnings).toEqual([]);
  });

  it('threads scan relationship settings into relationship-only local scans', async () => {
    project.config.scan.enrichment = { mode: 'deterministic' };
    project.config.scan.relationships = {
      ...project.config.scan.relationships,
      llmProposals: false,
      maxLlmTablesPerBatch: 7,
    };
    const generateObject = vi.fn(async () => ({ pkCandidates: [], fkCandidates: [] }));
    const connector = {
      id: 'test:warehouse',
      driver: 'postgres' as const,
      capabilities: {
        structuralIntrospection: true as const,
        tableSampling: false,
        columnSampling: false,
        columnStats: true,
        readOnlySql: true,
        nestedAnalysis: false,
        eventStreamDiscovery: false,
        formalForeignKeys: false,
        estimatedRowCounts: true,
      },
      ...connectorScopeListing,
      async introspect() {
        return {
          connectionId: 'warehouse',
          driver: 'postgres' as const,
          extractedAt: '2026-04-29T09:30:00.000Z',
          scope: { schemas: ['public'] },
          metadata: {},
          tables: [
            {
              catalog: null,
              db: 'public',
              name: 'customers',
              kind: 'table' as const,
              comment: null,
              estimatedRows: null,
              foreignKeys: [],
              columns: [
                {
                  name: 'id',
                  nativeType: 'integer',
                  normalizedType: 'integer',
                  dimensionType: 'number' as const,
                  nullable: false,
                  primaryKey: false,
                  comment: null,
                },
              ],
            },
            {
              catalog: null,
              db: 'public',
              name: 'orders',
              kind: 'table' as const,
              comment: null,
              estimatedRows: null,
              foreignKeys: [],
              columns: [
                {
                  name: 'customer_id',
                  nativeType: 'integer',
                  normalizedType: 'integer',
                  dimensionType: 'number' as const,
                  nullable: false,
                  primaryKey: false,
                  comment: null,
                },
              ],
            },
          ],
        };
      },
      async executeReadOnly(input: KtxReadOnlyQueryInput) {
        return relationshipSqlResult(input);
      },
    };
    const adapter = fetchOnlyAdapter({ snapshot: await connector.introspect() });

    const result = await runLocalScan({
      project,
      adapters: [adapter],
      connectionId: 'warehouse',
      mode: 'relationships',
      detectRelationships: true,
      connector,
      enrichmentProviders: {
        llmRuntime: {
          ...deterministicLlmRuntime(),
          generateObject: generateObject as never,
        },
        embedding: {
          dimensions: 8,
          maxBatchSize: 64,
          async embedBatch() {
            return [];
          },
        },
      },
      jobId: 'scan-relationships-llm-disabled-1',
      now: () => new Date('2026-04-29T09:30:00.000Z'),
    });

    expect(result.report.relationships.accepted).toBe(1);
    expect(result.report.enrichment.llmRelationshipValidation).toBe('skipped');
    expect(generateObject).not.toHaveBeenCalled();
  });

  it('accepts no-declared-constraint relationships and writes relationship artifacts', async () => {
    const connector = {
      id: 'test:warehouse',
      driver: 'postgres' as const,
      capabilities: {
        structuralIntrospection: true as const,
        tableSampling: false,
        columnSampling: false,
        columnStats: true,
        readOnlySql: true,
        nestedAnalysis: false,
        eventStreamDiscovery: false,
        formalForeignKeys: false,
        estimatedRowCounts: true,
      },
      ...connectorScopeListing,
      async introspect() {
        return {
          connectionId: 'warehouse',
          driver: 'postgres' as const,
          extractedAt: '2026-05-07T09:00:00.000Z',
          scope: {},
          metadata: {},
          tables: [
            {
              catalog: null,
              db: null,
              name: 'accounts',
              kind: 'table' as const,
              comment: null,
              estimatedRows: 2,
              foreignKeys: [],
              columns: [
                {
                  name: 'id',
                  nativeType: 'integer',
                  normalizedType: 'integer',
                  dimensionType: 'number' as const,
                  nullable: false,
                  primaryKey: false,
                  comment: null,
                },
              ],
            },
            {
              catalog: null,
              db: null,
              name: 'orders',
              kind: 'table' as const,
              comment: null,
              estimatedRows: 3,
              foreignKeys: [],
              columns: [
                {
                  name: 'id',
                  nativeType: 'integer',
                  normalizedType: 'integer',
                  dimensionType: 'number' as const,
                  nullable: false,
                  primaryKey: false,
                  comment: null,
                },
                {
                  name: 'account_id',
                  nativeType: 'integer',
                  normalizedType: 'integer',
                  dimensionType: 'number' as const,
                  nullable: false,
                  primaryKey: false,
                  comment: null,
                },
              ],
            },
          ],
        };
      },
      async executeReadOnly(input: KtxReadOnlyQueryInput) {
        return relationshipSqlResult(input);
      },
    };
    const adapter = fetchOnlyAdapter({ snapshot: await connector.introspect() });

    const result = await runLocalScan({
      project,
      adapters: [adapter],
      connectionId: 'warehouse',
      mode: 'relationships',
      detectRelationships: true,
      connector,
      jobId: 'scan-relationship-discovery',
      now: () => new Date('2026-05-07T09:12:00.000Z'),
    });

    expect(result.report.relationships).toEqual({ accepted: 1, review: 0, rejected: 0, skipped: 0 });
    const enrichmentRoot = `raw-sources/warehouse/live-database/${result.report.syncId}/enrichment`;
    expect(result.report.artifactPaths.enrichmentArtifacts).toEqual([
      `${enrichmentRoot}/relationships.json`,
      `${enrichmentRoot}/relationship-profile.json`,
      `${enrichmentRoot}/relationship-diagnostics.json`,
    ]);

    const diagnostics = JSON.parse(
      (await project.fileStore.readFile(`${enrichmentRoot}/relationship-diagnostics.json`)).content,
    ) as {
      summary: { accepted: number; review: number; rejected: number; skipped: number };
      noAcceptedReason: string | null;
    };
    expect(diagnostics.summary).toEqual({ accepted: 1, review: 0, rejected: 0, skipped: 0 });
    expect(diagnostics.noAcceptedReason).toBeNull();

    const manifestPath = result.report.artifactPaths.manifestShards[0];
    if (!manifestPath) {
      throw new Error('Expected manifest shard path');
    }
    const manifest = YAML.parse((await project.fileStore.readFile(manifestPath)).content) as {
      tables: { orders: { joins: Array<{ to: string; on: string; source: string }> } };
    };
    expect(manifest.tables.orders.joins).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          to: 'accounts',
          on: 'orders.account_id = accounts.id',
          source: 'inferred',
        }),
      ]),
    );
  });

  it('runs enriched relationship discovery without scan enrichment backend', async () => {
    const connector = {
      id: 'test:warehouse',
      driver: 'postgres' as const,
      capabilities: {
        structuralIntrospection: true as const,
        tableSampling: false,
        columnSampling: false,
        columnStats: true,
        readOnlySql: true,
        nestedAnalysis: false,
        eventStreamDiscovery: false,
        formalForeignKeys: false,
        estimatedRowCounts: true,
      },
      ...connectorScopeListing,
      async introspect() {
        return {
          connectionId: 'warehouse',
          driver: 'postgres' as const,
          extractedAt: '2026-05-07T09:00:00.000Z',
          scope: {},
          metadata: {},
          tables: [
            {
              catalog: null,
              db: null,
              name: 'accounts',
              kind: 'table' as const,
              comment: null,
              estimatedRows: 2,
              foreignKeys: [],
              columns: [
                {
                  name: 'id',
                  nativeType: 'integer',
                  normalizedType: 'integer',
                  dimensionType: 'number' as const,
                  nullable: false,
                  primaryKey: false,
                  comment: null,
                },
              ],
            },
            {
              catalog: null,
              db: null,
              name: 'orders',
              kind: 'table' as const,
              comment: null,
              estimatedRows: 3,
              foreignKeys: [],
              columns: [
                {
                  name: 'id',
                  nativeType: 'integer',
                  normalizedType: 'integer',
                  dimensionType: 'number' as const,
                  nullable: false,
                  primaryKey: false,
                  comment: null,
                },
                {
                  name: 'account_id',
                  nativeType: 'integer',
                  normalizedType: 'integer',
                  dimensionType: 'number' as const,
                  nullable: false,
                  primaryKey: false,
                  comment: null,
                },
              ],
            },
          ],
        };
      },
      async executeReadOnly(input: KtxReadOnlyQueryInput) {
        return relationshipSqlResult(input);
      },
    };
    const adapter = fetchOnlyAdapter({ snapshot: await connector.introspect() });

    const result = await runLocalScan({
      project,
      adapters: [adapter],
      connectionId: 'warehouse',
      mode: 'enriched',
      connector,
      jobId: 'scan-providerless-enriched-relationship-discovery',
      now: () => new Date('2026-05-07T09:14:00.000Z'),
    });

    expect(result.report.mode).toBe('enriched');
    expect(result.report.enrichment).toEqual({
      dataDictionary: 'skipped',
      tableDescriptions: 'skipped',
      columnDescriptions: 'skipped',
      embeddings: 'skipped',
      deterministicRelationships: 'completed',
      llmRelationshipValidation: 'skipped',
      statisticalValidation: 'completed',
    });
    expect(result.report.relationships).toEqual({ accepted: 1, review: 0, rejected: 0, skipped: 0 });
    expect(result.report.warnings).toContainEqual({
      code: 'scan_enrichment_backend_not_configured',
      message:
        'Skipping description and embedding enrichment because scan.enrichment.mode is not configured; relationship discovery still ran.',
      recoverable: true,
      metadata: {
        skippedStages: ['descriptions', 'embeddings'],
        relationshipDetection: true,
      },
    });

    const enrichmentRoot = `raw-sources/warehouse/live-database/${result.report.syncId}/enrichment`;
    expect(result.report.artifactPaths.enrichmentArtifacts).toEqual(
      expect.arrayContaining([
        `${enrichmentRoot}/relationships.json`,
        `${enrichmentRoot}/relationship-profile.json`,
        `${enrichmentRoot}/relationship-diagnostics.json`,
      ]),
    );

    const manifestPath = result.report.artifactPaths.manifestShards[0];
    if (!manifestPath) {
      throw new Error('Expected manifest shard path');
    }
    const manifest = YAML.parse((await project.fileStore.readFile(manifestPath)).content) as {
      tables: { orders: { joins: Array<{ to: string; on: string; source: string }> } };
    };
    expect(manifest.tables.orders.joins).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          to: 'accounts',
          on: 'orders.account_id = accounts.id',
          source: 'inferred',
        }),
      ]),
    );
  });

  it('redacts credential-like warning messages before persisting local scan reports', async () => {
    const connector = {
      id: 'test:warehouse',
      driver: 'postgres' as const,
      capabilities: {
        structuralIntrospection: true as const,
        tableSampling: false,
        columnSampling: false,
        columnStats: true,
        readOnlySql: true,
        nestedAnalysis: false,
        eventStreamDiscovery: false,
        formalForeignKeys: false,
        estimatedRowCounts: true,
      },
      ...connectorScopeListing,
      async introspect() {
        return {
          connectionId: 'warehouse',
          driver: 'postgres' as const,
          extractedAt: '2026-04-29T09:00:00.000Z',
          scope: { schemas: ['public'] },
          metadata: {},
          tables: [
            {
              catalog: null,
              db: 'public',
              name: 'customers',
              kind: 'table' as const,
              comment: null,
              estimatedRows: 100,
              foreignKeys: [],
              columns: [
                {
                  name: 'id',
                  nativeType: 'integer',
                  normalizedType: 'integer',
                  dimensionType: 'number' as const,
                  nullable: false,
                  primaryKey: true,
                  comment: null,
                },
              ],
            },
            {
              catalog: null,
              db: 'public',
              name: 'orders',
              kind: 'table' as const,
              comment: null,
              estimatedRows: 1000,
              foreignKeys: [],
              columns: [
                {
                  name: 'customer_id',
                  nativeType: 'integer',
                  normalizedType: 'integer',
                  dimensionType: 'number' as const,
                  nullable: false,
                  primaryKey: false,
                  comment: null,
                },
              ],
            },
          ],
        };
      },
      async executeReadOnly(input: KtxReadOnlyQueryInput) {
        return relationshipSqlResult(input, { throwOnCoverage: true });
      },
    };
    const adapter = fetchOnlyAdapter({ snapshot: await connector.introspect() });

    const result = await runLocalScan({
      project,
      adapters: [adapter],
      connectionId: 'warehouse',
      mode: 'relationships',
      detectRelationships: true,
      connector,
      jobId: 'scan-redacted-warning-1',
      now: () => new Date('2026-04-29T09:14:00.000Z'),
    });

    expect(result.report.warnings[0]?.message).toContain('postgres://reader:<redacted>@example.test/db');
    expect(result.report.warnings[0]?.message).not.toContain(
      'postgres://reader:secret@example.test/db', // pragma: allowlist secret
    );
    const reportPath = result.report.artifactPaths.reportPath;
    if (!reportPath) {
      throw new Error('Expected local scan report path');
    }
    const persistedReport = await readFile(join(project.projectDir, reportPath), 'utf-8');
    expect(persistedReport).toContain('postgres://reader:<redacted>@example.test/db');
    expect(persistedReport).not.toContain('postgres://reader:secret@example.test/db'); // pragma: allowlist secret
  });

  it('runs enriched scans when deterministic standalone enrichment is configured without embeddings', async () => {
    await writeFile(
      join(project.projectDir, 'ktx.yaml'),
      [
        'connections:',
        '  warehouse:',
        '    driver: postgres',
        '    url: env:DATABASE_URL',
        'ingest:',
        '  adapters:',
        '    - live-database',
        'scan:',
        '  enrichment:',
        '    mode: deterministic',
        '',
      ].join('\n'),
      'utf-8',
    );
    project = await loadKtxProject({ projectDir: project.projectDir });

    const connector = {
      id: 'test:warehouse',
      driver: 'postgres' as const,
      capabilities: {
        structuralIntrospection: true as const,
        tableSampling: true,
        columnSampling: true,
        columnStats: false,
        readOnlySql: false,
        nestedAnalysis: false,
        eventStreamDiscovery: false,
        formalForeignKeys: false,
        estimatedRowCounts: false,
      },
      ...connectorScopeListing,
      async introspect() {
        return {
          connectionId: 'warehouse',
          driver: 'postgres' as const,
          extractedAt: '2026-04-29T09:00:00.000Z',
          scope: { schemas: ['public'] },
          metadata: {},
          tables: [
            {
              catalog: null,
              db: 'public',
              name: 'orders',
              kind: 'table' as const,
              comment: 'Orders',
              estimatedRows: 1,
              foreignKeys: [],
              columns: [
                {
                  name: 'id',
                  nativeType: 'integer',
                  normalizedType: 'integer',
                  dimensionType: 'number' as const,
                  nullable: false,
                  primaryKey: true,
                  comment: 'Order id',
                },
              ],
            },
          ],
        };
      },
      async sampleTable() {
        return { headers: ['id'], rows: [[1]], totalRows: 1 };
      },
      async sampleColumn() {
        return { values: ['1'], nullCount: 0, distinctCount: 1 };
      },
    };

    const result = await runLocalScan({
      project,
      adapters: [fetchOnlyAdapter()],
      connectionId: 'warehouse',
      mode: 'enriched',
      connector,
      jobId: 'scan-enriched-1',
      now: () => new Date('2026-04-29T09:15:00.000Z'),
    });

    expect(result.report.mode).toBe('enriched');
    expect(result.report.enrichment.tableDescriptions).toBe('completed');
    expect(result.report.enrichment.columnDescriptions).toBe('completed');
    expect(result.report.enrichment.embeddings).toBe('skipped');
    expect(result.report.artifactPaths.enrichmentArtifacts).toEqual([
      'raw-sources/warehouse/live-database/2026-04-29-091500-scan-enriched-1/enrichment/descriptions.json',
      'raw-sources/warehouse/live-database/2026-04-29-091500-scan-enriched-1/enrichment/relationships.json',
      'raw-sources/warehouse/live-database/2026-04-29-091500-scan-enriched-1/enrichment/relationship-profile.json',
      'raw-sources/warehouse/live-database/2026-04-29-091500-scan-enriched-1/enrichment/relationship-diagnostics.json',
    ]);
    expect(result.report.artifactPaths.manifestShards).toEqual(['semantic-layer/warehouse/_schema/public.yaml']);
    expect(result.report.manifestShardsWritten).toBe(1);

    await expect(
      readFile(
        join(
          project.projectDir,
          'raw-sources/warehouse/live-database/2026-04-29-091500-scan-enriched-1/enrichment/descriptions.json',
        ),
        'utf-8',
      ),
    ).resolves.toContain('Deterministic description');

    const manifestRaw = await readFile(
      join(project.projectDir, 'semantic-layer/warehouse/_schema/public.yaml'),
      'utf-8',
    );
    expect(manifestRaw).toContain('ai: |-');
    expect(manifestRaw).toContain('Deterministic description');
  });

  it('persists structural artifacts and a recoverable warning when standalone enrichment execution fails', async () => {
    const connector = {
      id: 'test:warehouse',
      driver: 'postgres' as const,
      capabilities: {
        structuralIntrospection: true as const,
        tableSampling: true,
        columnSampling: true,
        columnStats: false,
        readOnlySql: false,
        nestedAnalysis: false,
        eventStreamDiscovery: false,
        formalForeignKeys: false,
        estimatedRowCounts: false,
      },
      ...connectorScopeListing,
      async introspect() {
        return {
          connectionId: 'warehouse',
          driver: 'postgres' as const,
          extractedAt: '2026-04-29T09:00:00.000Z',
          scope: { schemas: ['public'] },
          metadata: {},
          tables: [
            {
              catalog: null,
              db: 'public',
              name: 'orders',
              kind: 'table' as const,
              comment: 'Orders',
              estimatedRows: 1,
              foreignKeys: [],
              columns: [
                {
                  name: 'id',
                  nativeType: 'integer',
                  normalizedType: 'integer',
                  dimensionType: 'number' as const,
                  nullable: false,
                  primaryKey: true,
                  comment: 'Order id',
                },
              ],
            },
          ],
        };
      },
      async sampleTable() {
        return { headers: ['id'], rows: [[1]], totalRows: 1 };
      },
      async sampleColumn() {
        return { values: ['1'], nullCount: 0, distinctCount: 1 };
      },
    };

    const result = await runLocalScan({
      project,
      adapters: [fetchOnlyAdapter()],
      connectionId: 'warehouse',
      mode: 'enriched',
      connector,
      enrichmentProviders: {
        llmRuntime: deterministicLlmRuntime(),
        embedding: {
          dimensions: 8,
          maxBatchSize: 64,
          async embedBatch() {
            throw new Error('embedding service timed out');
          },
        },
      },
      jobId: 'scan-enrichment-fails-1',
      now: () => new Date('2026-04-29T09:18:00.000Z'),
    });

    expect(result.report.mode).toBe('enriched');
    expect(result.report.enrichment).toEqual({
      dataDictionary: 'failed',
      tableDescriptions: 'failed',
      columnDescriptions: 'failed',
      embeddings: 'failed',
      deterministicRelationships: 'failed',
      llmRelationshipValidation: 'failed',
      statisticalValidation: 'failed',
    });
    expect(result.report.warnings).toEqual([
      {
        code: 'enrichment_failed',
        message: 'ktx scan enrichment failed after structural scan completed: embedding service timed out',
        recoverable: true,
        metadata: {
          mode: 'enriched',
          detectRelationships: false,
        },
      },
    ]);
    expect(result.report.artifactPaths.enrichmentArtifacts).toEqual([]);
    expect(result.report.artifactPaths.manifestShards).toEqual(['semantic-layer/warehouse/_schema/public.yaml']);

    const manifestRaw = await readFile(
      join(project.projectDir, 'semantic-layer/warehouse/_schema/public.yaml'),
      'utf-8',
    );
    expect(manifestRaw).toContain('orders:');
    expect(manifestRaw).toContain('table: public.orders');
    expect(manifestRaw).not.toContain('ai: Generated description');

    const reportPath = result.report.artifactPaths.reportPath;
    if (!reportPath) {
      throw new Error('Expected local scan report path');
    }
    const persistedReport = await readFile(join(project.projectDir, reportPath), 'utf-8');
    expect(persistedReport).toContain('"code": "enrichment_failed"');
    expect(persistedReport).toContain('embedding service timed out');
  });

  it('keeps AI descriptions in the queryable _schema when the relationship stage fails after enrichment', async () => {
    // Durability: the paid descriptions are checkpointed into the queryable
    // manifest before relationship detection runs, so a relationship-stage
    // failure degrades to "no joins", never "no descriptions".
    project.config.scan.enrichment = { mode: 'deterministic' };
    const connector = {
      id: 'test:warehouse',
      driver: 'postgres' as const,
      capabilities: {
        structuralIntrospection: true as const,
        tableSampling: true,
        columnSampling: true,
        columnStats: true,
        readOnlySql: true,
        nestedAnalysis: false,
        eventStreamDiscovery: false,
        formalForeignKeys: false,
        estimatedRowCounts: true,
      },
      ...connectorScopeListing,
      async introspect() {
        return {
          connectionId: 'warehouse',
          driver: 'postgres' as const,
          extractedAt: '2026-04-29T09:00:00.000Z',
          scope: { schemas: ['public'] },
          metadata: {},
          tables: [
            {
              catalog: null,
              db: 'public',
              name: 'customers',
              kind: 'table' as const,
              comment: 'Customer accounts',
              estimatedRows: 100,
              foreignKeys: [],
              columns: [
                {
                  name: 'id',
                  nativeType: 'integer',
                  normalizedType: 'integer',
                  dimensionType: 'number' as const,
                  nullable: false,
                  primaryKey: true,
                  comment: 'Customer id',
                },
              ],
            },
            {
              catalog: null,
              db: 'public',
              name: 'orders',
              kind: 'table' as const,
              comment: 'Customer orders',
              estimatedRows: 1000,
              foreignKeys: [],
              columns: [
                {
                  name: 'customer_id',
                  nativeType: 'integer',
                  normalizedType: 'integer',
                  dimensionType: 'number' as const,
                  nullable: false,
                  primaryKey: false,
                  comment: 'Owning customer',
                },
              ],
            },
          ],
        };
      },
      async sampleTable() {
        return { headers: ['id'], rows: [[1]], totalRows: 1 };
      },
      async sampleColumn() {
        return { values: ['1'], nullCount: 0, distinctCount: 1 };
      },
      // Profiling succeeds; the coverage probe in the relationship stage throws,
      // standing in for a relationship-stage interruption after enrichment.
      async executeReadOnly(input: KtxReadOnlyQueryInput) {
        return relationshipSqlResult(input, { throwOnCoverage: true });
      },
    };

    const result = await runLocalScan({
      project,
      adapters: [fetchOnlyAdapter({ snapshot: await connector.introspect() })],
      connectionId: 'warehouse',
      mode: 'enriched',
      detectRelationships: true,
      connector,
      jobId: 'scan-checkpoint-durability-1',
      now: () => new Date('2026-04-29T09:20:00.000Z'),
    });

    expect(result.report.warnings.map((warning) => warning.code)).toContain('enrichment_failed');

    const manifestRaw = await readFile(
      join(project.projectDir, 'semantic-layer/warehouse/_schema/public.yaml'),
      'utf-8',
    );
    expect(manifestRaw).toContain('ai: |-');
    expect(manifestRaw).toContain('Deterministic description');
  });

  it('resumes completed local enrichment stages when an enriched scan run is retried', async () => {
    let embeddingAttempts = 0;
    const connector = {
      id: 'test:warehouse',
      driver: 'postgres' as const,
      capabilities: {
        structuralIntrospection: true as const,
        tableSampling: true,
        columnSampling: true,
        columnStats: true,
        readOnlySql: false,
        nestedAnalysis: false,
        eventStreamDiscovery: false,
        formalForeignKeys: false,
        estimatedRowCounts: false,
      },
      ...connectorScopeListing,
      async introspect() {
        return {
          connectionId: 'warehouse',
          driver: 'postgres' as const,
          extractedAt: '2026-04-29T09:21:00.000Z',
          scope: { schemas: ['public'] },
          metadata: {},
          tables: [
            {
              catalog: null,
              db: 'public',
              name: 'orders',
              kind: 'table' as const,
              comment: 'Orders',
              estimatedRows: 1,
              foreignKeys: [],
              columns: [
                {
                  name: 'id',
                  nativeType: 'integer',
                  normalizedType: 'integer',
                  dimensionType: 'number' as const,
                  nullable: false,
                  primaryKey: true,
                  comment: 'Order id',
                },
              ],
            },
          ],
        };
      },
      async sampleTable() {
        return { headers: ['id'], rows: [[1]], totalRows: 1 };
      },
      async sampleColumn() {
        return { values: ['1'], nullCount: 0, distinctCount: 1 };
      },
    };
    const llmRuntime = deterministicLlmRuntime();
    const adapter = fetchOnlyAdapter({ snapshot: await connector.introspect() });

    const first = await runLocalScan({
      project,
      adapters: [adapter],
      connectionId: 'warehouse',
      mode: 'enriched',
      connector,
      enrichmentProviders: {
        llmRuntime,
        embedding: {
          dimensions: 8,
          maxBatchSize: 64,
          async embedBatch() {
            embeddingAttempts += 1;
            throw new Error('embedding service timed out once');
          },
        },
      },
      jobId: 'scan-enrichment-resume-1',
      now: () => new Date('2026-04-29T09:21:00.000Z'),
    });

    expect(first.report.enrichmentState).toEqual({
      resumedStages: [],
      completedStages: ['descriptions'],
      failedStages: ['embeddings'],
    });
    expect(first.report.enrichment.embeddings).toBe('failed');

    const generateObject = vi.spyOn(llmRuntime, 'generateObject');
    const retry = await runLocalScan({
      project,
      adapters: [adapter],
      connectionId: 'warehouse',
      mode: 'enriched',
      connector,
      enrichmentProviders: {
        llmRuntime,
        embedding: {
          dimensions: 8,
          maxBatchSize: 64,
          async embedBatch(texts) {
            embeddingAttempts += 1;
            return texts.map(() => [0.1, 0.2, 0.3, 0.4, 0.5, 0.6, 0.7, 0.8]);
          },
        },
      },
      jobId: 'scan-enrichment-resume-1',
      now: () => new Date('2026-04-29T09:22:00.000Z'),
    });

    expect(retry.syncId).toBe(first.syncId);
    expect(retry.report.enrichmentState).toEqual({
      resumedStages: ['descriptions'],
      completedStages: ['descriptions', 'embeddings', 'relationships'],
      failedStages: [],
    });
    expect(retry.report.enrichment.embeddings).toBe('completed');
    expect(generateObject).toHaveBeenCalledWith(expect.objectContaining({ role: 'candidateExtraction' }));
    expect(embeddingAttempts).toBe(2);

    const reportPath = retry.report.artifactPaths.reportPath;
    if (!reportPath) {
      throw new Error('Expected local scan report path');
    }
    const persistedReport = await readFile(join(project.projectDir, reportPath), 'utf-8');
    expect(persistedReport).toContain('"resumedStages": [');
    expect(persistedReport).toContain('"descriptions"');
  });

  it('accepts sqlite as a native standalone scan driver when the host supplies a live-database adapter', async () => {
    await writeFile(
      join(project.projectDir, 'ktx.yaml'),
      [
        'connections:',
        '  warehouse:',
        '    driver: sqlite',
        '    path: warehouse.db',
        'ingest:',
        '  adapters:',
        '    - live-database',
        '',
      ].join('\n'),
      'utf-8',
    );
    project = await loadKtxProject({ projectDir: project.projectDir });

    const result = await runLocalScan({
      project,
      adapters: [fetchOnlyAdapter()],
      connectionId: 'warehouse',
      jobId: 'scan-run-sqlite',
      now: () => new Date('2026-04-29T11:00:00.000Z'),
    });

    expect(result.report.driver).toBe('sqlite');
    expect(result.report.artifactPaths.reportPath).toBe(
      'raw-sources/warehouse/live-database/2026-04-29-110000-scan-run-sqlite/scan-report.json',
    );
  });

  it('accepts mysql as a native standalone scan driver when the host supplies a live-database adapter', async () => {
    await writeFile(
      join(project.projectDir, 'ktx.yaml'),
      [
        'connections:',
        '  warehouse:',
        '    driver: mysql',
        '    url: env:MYSQL_URL',
        'ingest:',
        '  adapters:',
        '    - live-database',
        '',
      ].join('\n'),
      'utf-8',
    );
    project = await loadKtxProject({ projectDir: project.projectDir });

    const result = await runLocalScan({
      project,
      adapters: [fetchOnlyAdapter()],
      connectionId: 'warehouse',
      jobId: 'scan-run-mysql',
      now: () => new Date('2026-04-29T13:00:00.000Z'),
    });

    expect(result.report.driver).toBe('mysql');
    expect(result.report.artifactPaths.reportPath).toBe(
      'raw-sources/warehouse/live-database/2026-04-29-130000-scan-run-mysql/scan-report.json',
    );
  });

  it('accepts clickhouse as a native standalone scan driver when the host supplies a live-database adapter', async () => {
    await writeFile(
      join(project.projectDir, 'ktx.yaml'),
      [
        'connections:',
        '  warehouse:',
        '    driver: clickhouse',
        '    host: env:CLICKHOUSE_HOST',
        '    database: analytics',
        '    username: reader',
        '    password: env:CLICKHOUSE_PASSWORD',
        'ingest:',
        '  adapters:',
        '    - live-database',
        '',
      ].join('\n'),
      'utf-8',
    );
    project = await loadKtxProject({ projectDir: project.projectDir });

    const result = await runLocalScan({
      project,
      adapters: [fetchOnlyAdapter()],
      connectionId: 'warehouse',
      jobId: 'scan-run-clickhouse',
      now: () => new Date('2026-04-29T15:00:00.000Z'),
    });

    expect(result.report.driver).toBe('clickhouse');
    expect(result.report.artifactPaths.reportPath).toBe(
      'raw-sources/warehouse/live-database/2026-04-29-150000-scan-run-clickhouse/scan-report.json',
    );
  });

  it('accepts sqlserver as a native standalone scan driver when the host supplies a live-database adapter', async () => {
    await writeFile(
      join(project.projectDir, 'ktx.yaml'),
      [
        'connections:',
        '  warehouse:',
        '    driver: sqlserver',
        '    host: env:SQLSERVER_HOST',
        '    database: analytics',
        '    username: reader',
        '    schema: dbo',
        'ingest:',
        '  adapters:',
        '    - live-database',
        '',
      ].join('\n'),
      'utf-8',
    );
    project = await loadKtxProject({ projectDir: project.projectDir });

    const result = await runLocalScan({
      project,
      adapters: [fetchOnlyAdapter()],
      connectionId: 'warehouse',
      jobId: 'scan-run-sqlserver',
      now: () => new Date('2026-04-29T16:00:00.000Z'),
    });

    expect(result.report.driver).toBe('sqlserver');
    expect(result.report.artifactPaths.reportPath).toBe(
      'raw-sources/warehouse/live-database/2026-04-29-160000-scan-run-sqlserver/scan-report.json',
    );
  });

  // Regression (spec 21 defect, 2026-06-24): the structural manifest write that runs
  // BEFORE enrichment must not let a `--stages` subset delete the prior on-disk
  // descriptions. This goes through the full runLocalScan path (the unit-level
  // enrichment test could not catch the structural-pre-write ordering).
  it('a --stages relationships scan preserves on-disk descriptions while adding joins', async () => {
    const snapshot: KtxSchemaSnapshot = {
      connectionId: 'warehouse',
      driver: 'postgres',
      extractedAt: '2026-05-07T09:00:00.000Z',
      scope: {},
      metadata: {},
      tables: [
        {
          catalog: null,
          db: null,
          name: 'accounts',
          kind: 'table',
          comment: null,
          estimatedRows: 2,
          foreignKeys: [],
          columns: [
            {
              name: 'id',
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
          db: null,
          name: 'orders',
          kind: 'table',
          comment: null,
          estimatedRows: 3,
          foreignKeys: [],
          columns: [
            {
              name: 'id',
              nativeType: 'integer',
              normalizedType: 'integer',
              dimensionType: 'number',
              nullable: false,
              primaryKey: false,
              comment: null,
            },
            {
              name: 'account_id',
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
    // Enriched fixture already on disk: ai descriptions, zero joins.
    await project.fileStore.writeFile(
      'semantic-layer/warehouse/_schema/public.yaml',
      YAML.stringify(
        {
          tables: {
            accounts: {
              table: 'accounts',
              descriptions: { ai: 'AI accounts table' },
              columns: [{ name: 'id', type: 'number', descriptions: { ai: 'AI accounts id' } }],
            },
            orders: {
              table: 'orders',
              descriptions: { ai: 'AI orders table' },
              columns: [
                { name: 'id', type: 'number', descriptions: { ai: 'AI orders id' } },
                { name: 'account_id', type: 'number', descriptions: { ai: 'AI account ref' } },
              ],
            },
          },
        },
        { indent: 2, lineWidth: 0 },
      ),
      'ktx',
      'ktx@example.com',
      'Seed enriched fixture',
    );
    const shardPath = 'semantic-layer/warehouse/_schema/public.yaml';
    const aiBefore = ((await project.fileStore.readFile(shardPath)).content.match(/\bai:/g) ?? []).length;
    expect(aiBefore).toBe(5);

    const connector: KtxScanConnector = {
      id: 'test:warehouse',
      driver: 'postgres',
      capabilities: {
        structuralIntrospection: true,
        tableSampling: false,
        columnSampling: false,
        columnStats: true,
        readOnlySql: true,
        nestedAnalysis: false,
        eventStreamDiscovery: false,
        formalForeignKeys: false,
        estimatedRowCounts: true,
      },
      ...connectorScopeListing,
      introspect: vi.fn(async () => snapshot),
      async executeReadOnly(input: KtxReadOnlyQueryInput) {
        return relationshipSqlResult(input);
      },
    };

    const result = await runLocalScan({
      project,
      adapters: [fetchOnlyAdapter({ snapshot })],
      connectionId: 'warehouse',
      mode: 'enriched',
      detectRelationships: true,
      stages: ['relationships'],
      connector,
      enrichmentProviders: { llmRuntime: deterministicLlmRuntime() },
      jobId: 'scan-stages-relationships-preserve',
      now: () => new Date('2026-05-07T09:30:00.000Z'),
    });

    // The relationships stage actually ran and accepted a join...
    expect(result.report.relationships.accepted).toBe(1);
    const after = (await project.fileStore.readFile(shardPath)).content;
    // ...and every prior ai description survived the structural + enrichment writes.
    expect((after.match(/\bai:/g) ?? []).length).toBe(aiBefore);
    expect(after).toContain('AI orders table');
    expect(after).toContain('AI account ref');
    const manifest = YAML.parse(after) as {
      tables: Record<string, { joins?: Array<{ to: string; source: string }> }>;
    };
    expect(manifest.tables.orders?.joins?.some((join) => join.to === 'accounts')).toBe(true);
  });

  it('accepts athena as a native standalone scan driver when the host supplies a live-database adapter', async () => {
    await writeFile(
      join(project.projectDir, 'ktx.yaml'),
      [
        'connections:',
        '  warehouse:',
        '    driver: athena',
        '    region: us-east-1',
        '    s3_staging_dir: s3://my-bucket/athena-results/',
        '    databases:',
        '      - analytics',
        'ingest:',
        '  adapters:',
        '    - live-database',
        '',
      ].join('\n'),
      'utf-8',
    );
    project = await loadKtxProject({ projectDir: project.projectDir });

    const result = await runLocalScan({
      project,
      adapters: [fetchOnlyAdapter()],
      connectionId: 'warehouse',
      jobId: 'scan-run-athena',
      now: () => new Date('2026-04-29T17:00:00.000Z'),
    });

    expect(result.report.driver).toBe('athena');
    expect(result.report.artifactPaths.reportPath).toBe(
      'raw-sources/warehouse/live-database/2026-04-29-170000-scan-run-athena/scan-report.json',
    );
  });
});

describe('resolveEnabledTables', () => {
  it('returns null when no enabled_tables field', () => {
    expect(resolveEnabledTables({ driver: 'postgres' })).toBeNull();
  });

  it('returns null for empty array', () => {
    expect(resolveEnabledTables({ driver: 'postgres', enabled_tables: [] })).toBeNull();
  });

  it('returns a canonical set of enabled table refs', () => {
    const result = resolveEnabledTables({
      driver: 'postgres',
      enabled_tables: ['public.users', 'public.orders'],
    });
    expect(result).toBeInstanceOf(Set);
    expect(result!.size).toBe(2);
    expect(result!.has(tableRefKey({ catalog: null, db: 'public', name: 'users' }))).toBe(true);
    expect(result!.has(tableRefKey({ catalog: null, db: 'public', name: 'orders' }))).toBe(true);
  });

  it('ignores legacy enabled_tables object entries', () => {
    expect(
      resolveEnabledTables({
        driver: 'postgres',
        enabled_tables: [{ catalog: null, db: 'public', name: 'orders' }],
      }),
    ).toBeNull();
  });

  it('returns null for undefined connection', () => {
    expect(resolveEnabledTables(undefined)).toBeNull();
  });
});
