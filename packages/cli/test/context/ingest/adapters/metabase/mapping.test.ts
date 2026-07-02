import { describe, expect, it, vi } from 'vitest';
import type { MetabaseRuntimeClient } from '../../../../../src/context/ingest/adapters/metabase/client-port.js';
import {
  METABASE_ENGINE_TO_CONNECTION_TYPE,
  computeMetabaseMappingDrift,
  computeMetabaseMappingPhysicalMismatches,
  discoverMetabaseDatabases,
  findBestMatch,
  refreshMetabaseMapping,
  validateMappingPhysicalMatch,
  validateMetabaseMappings,
} from '../../../../../src/context/ingest/adapters/metabase/mapping.js';

describe('discoverMetabaseDatabases', () => {
  it('filters sample databases and extracts host plus database names from Metabase details', async () => {
    const client = {
      getDatabases: vi.fn().mockResolvedValue([
        {
          id: 1,
          name: 'Sample',
          engine: 'postgres',
          details: { host: 'sample.internal', dbname: 'sample' },
          is_sample: true,
        },
        {
          id: 2,
          name: 'Analytics',
          engine: 'postgres',
          details: { host: 'pg.internal:5432', dbname: 'analytics' },
          is_sample: false,
        },
        {
          id: 3,
          name: 'Warehouse',
          engine: 'mysql',
          details: { host: 'mysql.internal', db: 'warehouse' },
          is_sample: false,
        },
      ]),
    } as Pick<MetabaseRuntimeClient, 'getDatabases'> as MetabaseRuntimeClient;

    await expect(discoverMetabaseDatabases(client)).resolves.toEqual([
      { id: 2, name: 'Analytics', engine: 'postgres', host: 'pg.internal:5432', dbName: 'analytics' },
      { id: 3, name: 'Warehouse', engine: 'mysql', host: 'mysql.internal', dbName: 'warehouse' },
    ]);
  });
});

describe('computeMetabaseMappingDrift', () => {
  it('reports unmapped discovered databases, stale mappings, and in-sync mappings', () => {
    const drift = computeMetabaseMappingDrift({
      currentMappings: {
        '2': 'target-postgres',
        '9': 'target-stale',
      },
      discovered: [
        { id: 2, name: 'Analytics', engine: 'postgres', host: 'pg.internal', dbName: 'analytics' },
        { id: 3, name: 'Warehouse', engine: 'mysql', host: 'mysql.internal', dbName: 'warehouse' },
      ],
    });

    expect(drift).toEqual({
      unmappedDiscovered: [
        { id: 3, name: 'Warehouse', engine: 'mysql', host: 'mysql.internal', dbName: 'warehouse' },
      ],
      staleMappings: [{ id: '9', reason: 'database_not_found' }],
      inSync: [{ id: 2, ktxConnectionId: 'target-postgres' }],
    });
  });
});

describe('validateMetabaseMappings', () => {
  it('accepts mappings whose target connection ids exist', () => {
    expect(
      validateMetabaseMappings({
        mappings: { '2': 'target-postgres' },
        knownKtxConnectionIds: new Set(['target-postgres']),
      }),
    ).toEqual({ ok: true });
  });

  it('returns one error per missing target connection id', () => {
    expect(
      validateMetabaseMappings({
        mappings: { '2': 'missing-target', '3': 'target-mysql' },
        knownKtxConnectionIds: new Set(['target-mysql']),
      }),
    ).toEqual({
      ok: false,
      errors: [{ key: '2', reason: 'ktx connection missing-target does not exist' }],
    });
  });
});

describe('validateMappingPhysicalMatch', () => {
  it('returns null when Snowflake mapping points at the same database', () => {
    expect(
      validateMappingPhysicalMatch(
        { metabaseEngine: 'snowflake', metabaseDbName: 'ANALYTICS', metabaseHost: null },
        { connection_type: 'SNOWFLAKE', database: 'ANALYTICS', account: 'EMOVRJS-CZ07756' },
      ),
    ).toBeNull();
  });

  it('returns a reason when Snowflake mapping points at a different database', () => {
    const reason = validateMappingPhysicalMatch(
      { metabaseEngine: 'snowflake', metabaseDbName: 'SNAPSHOTS', metabaseHost: null },
      { connection_type: 'SNOWFLAKE', database: 'ANALYTICS', account: 'EMOVRJS-CZ07756' },
    );

    expect(reason).toContain('SNAPSHOTS');
    expect(reason).toContain('ANALYTICS');
  });

  it('returns a reason when engine type mismatches', () => {
    const reason = validateMappingPhysicalMatch(
      { metabaseEngine: 'snowflake', metabaseDbName: 'ANALYTICS', metabaseHost: null },
      { connection_type: 'POSTGRESQL', database: 'ANALYTICS', host: 'pg.internal' },
    );

    expect(reason).toContain('engine');
  });

  it('accepts Athena mappings when the target connection type is ATHENA', () => {
    expect(
      validateMappingPhysicalMatch(
        { metabaseEngine: 'athena', metabaseDbName: 'analytics', metabaseHost: null },
        { connection_type: 'ATHENA', database: 'analytics' },
      ),
    ).toBeNull();
  });

  it('returns null when Postgres host and database both match after normalization', () => {
    expect(
      validateMappingPhysicalMatch(
        { metabaseEngine: 'postgres', metabaseDbName: 'app', metabaseHost: 'PG.INTERNAL:5432' },
        { connection_type: 'POSTGRESQL', host: 'pg.internal', database: 'APP' },
      ),
    ).toBeNull();
  });

  it('returns a reason when Postgres host matches but database differs', () => {
    const reason = validateMappingPhysicalMatch(
      { metabaseEngine: 'postgres', metabaseDbName: 'app', metabaseHost: 'pg.internal' },
      { connection_type: 'POSTGRESQL', host: 'pg.internal', database: 'other_app' },
    );

    expect(reason).toContain('app');
    expect(reason).toContain('other_app');
  });

  it('uses BigQuery dataset_id before project_id when comparing database names', () => {
    expect(
      validateMappingPhysicalMatch(
        { metabaseEngine: 'bigquery', metabaseDbName: 'analytics_dataset', metabaseHost: null },
        { connection_type: 'BIGQUERY', dataset_id: 'analytics_dataset', project_id: 'warehouse-project' },
      ),
    ).toBeNull();
  });

  it('returns null for unknown engines because ktx cannot validate them', () => {
    expect(
      validateMappingPhysicalMatch(
        { metabaseEngine: 'unknown-engine', metabaseDbName: 'X', metabaseHost: 'host' },
        { connection_type: 'OTHER' },
      ),
    ).toBeNull();
  });
});

describe('METABASE_ENGINE_TO_CONNECTION_TYPE', () => {
  it('maps Metabase Athena databases to AWS Athena warehouse connections', () => {
    expect(METABASE_ENGINE_TO_CONNECTION_TYPE.athena).toBe('ATHENA');
    expect(
      validateMappingPhysicalMatch(
        { metabaseEngine: 'athena', metabaseDbName: 'analytics', metabaseHost: null },
        { connection_type: 'POSTGRESQL', database: 'analytics' },
      ),
    ).toBe("Metabase database engine 'athena' does not match ktx connection type 'POSTGRESQL'");
  });
});

describe('computeMetabaseMappingPhysicalMismatches', () => {
  it('returns only mismatched physical mappings', () => {
    expect(
      computeMetabaseMappingPhysicalMismatches([
        {
          mappingId: 'mapping-ok',
          metabase: { metabaseEngine: 'postgres', metabaseHost: 'pg.internal', metabaseDbName: 'app' },
          target: { connection_type: 'POSTGRESQL', host: 'pg.internal', database: 'app' },
        },
        {
          mappingId: 'mapping-bad',
          metabase: { metabaseEngine: 'postgres', metabaseHost: 'pg.internal', metabaseDbName: 'app' },
          target: { connection_type: 'POSTGRESQL', host: 'pg.internal', database: 'other_app' },
        },
      ]),
    ).toEqual([
      {
        mappingId: 'mapping-bad',
        reason: "Metabase database 'app' does not match ktx connection database 'other_app'",
      },
    ]);
  });
});

describe('refreshMetabaseMapping', () => {
  it('combines discovery drift and physical validation through a caller-provided target resolver', async () => {
    const client = {
      getDatabases: vi.fn().mockResolvedValue([
        {
          id: 2,
          name: 'Analytics',
          engine: 'postgres',
          details: { host: 'pg.internal', dbname: 'analytics' },
          is_sample: false,
        },
      ]),
    } as Pick<MetabaseRuntimeClient, 'getDatabases'> as MetabaseRuntimeClient;

    await expect(
      refreshMetabaseMapping({
        client,
        currentMappings: { '2': 'target-postgres' },
        resolveKtxConnectionPhysicalInfo: vi.fn().mockResolvedValue({
          connection_type: 'POSTGRESQL',
          host: 'pg.internal',
          database: 'wrong_database',
        }),
      }),
    ).resolves.toEqual({
      drift: {
        unmappedDiscovered: [],
        staleMappings: [],
        inSync: [{ id: 2, ktxConnectionId: 'target-postgres' }],
      },
      physicalMismatches: [
        {
          mappingId: '2',
          reason: "Metabase database 'analytics' does not match ktx connection database 'wrong_database'",
        },
      ],
    });
  });
});

describe('findBestMatch', () => {
  const candidates = [
    {
      id: 'snowflake-target',
      name: 'Warehouse Snowflake',
      connection_type: 'SNOWFLAKE',
      connection_params: { account: 'EMOVRJS-CZ07756', database: 'ANALYTICS' },
    },
    {
      id: 'postgres-host-only',
      name: 'Host Only Postgres',
      connection_type: 'POSTGRESQL',
      connection_params: { host: 'pg.internal', database: 'other_app' },
    },
    {
      id: 'postgres-db-only',
      name: 'Database Only Postgres',
      connection_type: 'POSTGRESQL',
      connection_params: { host: 'other.internal', database: 'app' },
    },
    {
      id: 'postgres-full',
      name: 'Full Postgres',
      connection_type: 'POSTGRESQL',
      connection_params: { host: 'pg.internal', database: 'app' },
    },
  ];

  it('chooses a host-and-database match over weaker matches', () => {
    expect(
      findBestMatch({ metabaseEngine: 'postgres', metabaseHost: 'pg.internal:5432', metabaseDbName: 'APP' }, candidates),
    ).toEqual({
      connectionId: 'postgres-full',
      connectionName: 'Full Postgres',
      reason: 'host_and_database',
    });
  });

  it('falls back to database-only matching when host does not match', () => {
    expect(
      findBestMatch(
        { metabaseEngine: 'postgres', metabaseHost: 'unknown.internal', metabaseDbName: 'app' },
        candidates,
      ),
    ).toEqual({
      connectionId: 'postgres-db-only',
      connectionName: 'Database Only Postgres',
      reason: 'database_only',
    });
  });

  it('returns null for unsupported Metabase engines', () => {
    expect(
      findBestMatch({ metabaseEngine: 'unknown-engine', metabaseHost: 'pg.internal', metabaseDbName: 'app' }, candidates),
    ).toBeNull();
  });
});

describe('METABASE_ENGINE_TO_CONNECTION_TYPE', () => {
  it('keeps the server-supported Metabase engine table in ktx', () => {
    expect(METABASE_ENGINE_TO_CONNECTION_TYPE).toMatchObject({
      postgres: 'POSTGRESQL',
      bigquery: 'BIGQUERY',
      'bigquery-cloud-sdk': 'BIGQUERY',
      snowflake: 'SNOWFLAKE',
      sqlserver: 'SQLSERVER',
      mysql: 'MYSQL',
    });
  });
});
