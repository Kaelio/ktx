import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import {
  driverRegistrations,
  getDriverRegistration,
  listSupportedDrivers,
} from '../../../src/context/connections/drivers.js';
import type {
  KtxDriverConnectorModule,
  KtxScopeConfigKey,
} from '../../../src/context/connections/drivers.js';
import type { KtxConnectionDriver } from '../../../src/context/scan/types.js';

type FixtureFactory = (projectDir: string) => Record<string, unknown>;

const connectionFixtures: Record<KtxConnectionDriver, FixtureFactory> = {
  postgres: () => ({
    driver: 'postgres',
    url: 'postgresql://reader:secret@localhost:5432/analytics', // pragma: allowlist secret
    schemas: ['public'],
  }),
  sqlite: () => ({ driver: 'sqlite', path: 'warehouse.db' }),
  duckdb: (projectDir) => ({ driver: 'duckdb', path: join(projectDir, 'warehouse.duckdb') }),
  mongodb: () => ({
    driver: 'mongodb',
    url: 'mongodb://localhost:27017/app',
    databases: ['app'],
  }),
  mysql: () => ({
    driver: 'mysql',
    host: 'localhost',
    database: 'analytics',
    username: 'reader',
    password: 'secret', // pragma: allowlist secret
    schemas: ['analytics'],
  }),
  clickhouse: () => ({
    driver: 'clickhouse',
    url: 'http://localhost:8123',
    database: 'analytics',
    username: 'reader',
    password: 'secret', // pragma: allowlist secret
  }),
  sqlserver: () => ({
    driver: 'sqlserver',
    host: 'localhost',
    database: 'analytics',
    username: 'reader',
    password: 'secret', // pragma: allowlist secret
    schemas: ['dbo'],
  }),
  bigquery: () => ({
    driver: 'bigquery',
    dataset_id: 'analytics',
    credentials_json: JSON.stringify({
      project_id: 'project-1',
      client_email: 'reader@example.test',
      private_key: '-----BEGIN PRIVATE KEY-----\nsecret\n-----END PRIVATE KEY-----\n', // pragma: allowlist secret
    }),
    location: 'US',
  }),
  snowflake: () => ({
    driver: 'snowflake',
    account: 'example-account',
    username: 'reader',
    password: 'secret', // pragma: allowlist secret
    warehouse: 'COMPUTE_WH',
    database: 'ANALYTICS',
    schema: 'PUBLIC',
  }),
};

const allowedScopeKeys = new Set(['dataset_ids', 'databases', 'schemas', 'schema_names']);
const historicSqlReaderDrivers = new Set<KtxConnectionDriver>(['postgres', 'bigquery', 'snowflake']);

function assertExportedRegistryBoundaryTypes(input: {
  scopeConfigKey: KtxScopeConfigKey;
  connectorModule: KtxDriverConnectorModule;
}): {
  scopeConfigKey: KtxScopeConfigKey;
  connectorModule: KtxDriverConnectorModule;
} {
  return input;
}

describe('driverRegistrations', () => {
  let projectDir: string;

  beforeEach(async () => {
    projectDir = await mkdtemp(join(tmpdir(), 'ktx-driver-registry-'));
  });

  afterEach(async () => {
    await rm(projectDir, { recursive: true, force: true });
  });

  it('lists every supported warehouse driver', () => {
    const registryDrivers = Object.keys(driverRegistrations).sort();
    expect(listSupportedDrivers()).toEqual(registryDrivers);
    expect(listSupportedDrivers()).toEqual([
      'bigquery',
      'clickhouse',
      'duckdb',
      'mongodb',
      'mysql',
      'postgres',
      'snowflake',
      'sqlite',
      'sqlserver',
    ]);
  });

  it('resolves registered drivers case-insensitively', () => {
    expect(getDriverRegistration(' Postgres ')?.driver).toBe('postgres');
    expect(getDriverRegistration('unknown')).toBeUndefined();
  });

  it.each(Object.values(driverRegistrations))('adapts $driver connector exports', async (registration) => {
    const connectorModule = await registration.load();
    const connection = connectionFixtures[registration.driver](projectDir);
    const exportedBoundary = assertExportedRegistryBoundaryTypes({
      scopeConfigKey: registration.scopeConfigKey ?? 'schemas',
      connectorModule,
    });
    expect(exportedBoundary.connectorModule.createScanConnector).toEqual(expect.any(Function));

    expect(connectorModule.isConnectionConfig(connection)).toBe(true);
    expect(connectorModule.isConnectionConfig({})).toBe(false);

    const connector = connectorModule.createScanConnector({
      connectionId: 'warehouse',
      connection,
      projectDir,
    });

    expect(connector.driver).toBe(registration.driver);
    expect(connector.listSchemas).toEqual(expect.any(Function));
    expect(connector.listTables).toEqual(expect.any(Function));
    await connector.cleanup?.();

    if (registration.driver === 'sqlite' || registration.driver === 'duckdb') {
      expect(registration.scopeConfigKey).toBeNull();
    } else {
      expect(registration.scopeConfigKey).not.toBeNull();
      expect(allowedScopeKeys.has(registration.scopeConfigKey ?? '')).toBe(true);
    }
    expect(registration.hasHistoricSqlReader).toBe(historicSqlReaderDrivers.has(registration.driver));
  });
});
