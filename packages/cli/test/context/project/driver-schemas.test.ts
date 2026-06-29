import { describe, expect, it } from 'vitest';
import { connectionConfigSchema } from '../../../src/context/project/driver-schemas.js';

describe('connectionConfigSchema (driver discriminated union)', () => {
  it.each([
    ['postgres', 'postgres://user:pass@host:5432/db'], // pragma: allowlist secret
    ['mysql', 'mysql://user:pass@host:3306/db'], // pragma: allowlist secret
    ['snowflake', 'snowflake://account/db'],
    ['bigquery', 'bigquery://project/dataset'],
    ['sqlite', 'sqlite:///tmp/db.sqlite'],
    ['clickhouse', 'clickhouse://host:8123/db'],
    ['sqlserver', 'sqlserver://host:1433;database=db'],
  ])('parses %s warehouse connection', (driver, url) => {
    expect(connectionConfigSchema.parse({ driver, url })).toMatchObject({ driver, url });
  });

  it('preserves unknown warehouse fields via looseObject passthrough', () => {
    const parsed = connectionConfigSchema.parse({
      driver: 'postgres',
      url: 'postgres://x',
      customField: { enabled: true },
      context: { queryHistory: { enabled: false } },
    });
    expect(parsed).toMatchObject({
      driver: 'postgres',
      customField: { enabled: true },
      context: { queryHistory: { enabled: false } },
    });
  });

  it('parses a mongodb connection with sampling fields', () => {
    const parsed = connectionConfigSchema.parse({
      driver: 'mongodb',
      url: 'env:MONGO_URL',
      databases: ['app'],
      enabled_tables: ['app.users'],
      sample_size: 500,
      order_by: 'createdAt',
    });
    expect(parsed).toMatchObject({
      driver: 'mongodb',
      url: 'env:MONGO_URL',
      databases: ['app'],
      sample_size: 500,
      order_by: 'createdAt',
    });
  });

  it('rejects a mongodb connection without a url', () => {
    expect(() => connectionConfigSchema.parse({ driver: 'mongodb', databases: ['app'] })).toThrow();
  });

  it('rejects an unknown driver', () => {
    expect(() => connectionConfigSchema.parse({ driver: 'nope', url: 'x' })).toThrow();
  });

  it('rejects legacy warehouse driver aliases', () => {
    expect(() => connectionConfigSchema.parse({ driver: 'postgresql', url: 'postgresql://host/db' })).toThrow();
  });
});

describe('connectionConfigSchema - context source drivers with mappings', () => {
  it('parses a metabase connection with mappings', () => {
    const parsed = connectionConfigSchema.parse({
      driver: 'metabase',
      api_url: 'https://metabase.example.com',
      api_key_ref: 'env:METABASE_API_KEY', // pragma: allowlist secret
      mappings: {
        databaseMappings: { '3': 'prod-warehouse' },
        syncEnabled: { '3': true },
        syncMode: 'ONLY',
      },
    });
    expect(parsed).toMatchObject({
      driver: 'metabase',
      api_url: 'https://metabase.example.com',
      mappings: {
        databaseMappings: { '3': 'prod-warehouse' },
        syncMode: 'ONLY',
      },
    });
  });

  it('parses a looker connection with connectionMappings', () => {
    const parsed = connectionConfigSchema.parse({
      driver: 'looker',
      base_url: 'https://looker.example.com',
      client_id: 'abc',
      client_secret_ref: 'env:LOOKER_CLIENT_SECRET', // pragma: allowlist secret
      mappings: { connectionMappings: { bigquery_prod: 'wh' } },
    });
    expect(parsed.mappings).toEqual({ connectionMappings: { bigquery_prod: 'wh' } });
  });

  it('parses a lookml connection with expectedLookerConnectionName', () => {
    const parsed = connectionConfigSchema.parse({
      driver: 'lookml',
      repoUrl: 'https://github.com/acme/looker.git',
      branch: 'main',
      mappings: { expectedLookerConnectionName: 'bigquery_prod' },
    });
    expect(parsed.mappings).toEqual({ expectedLookerConnectionName: 'bigquery_prod' });
  });

  it('rejects metabase mapping with non-integer database key', () => {
    expect(() =>
      connectionConfigSchema.parse({
        driver: 'metabase',
        api_url: 'https://x',
        mappings: { databaseMappings: { abc: 'wh' } },
      }),
    ).toThrow();
  });
});

describe('connectionConfigSchema - notion / gdrive / dbt / metricflow', () => {
  it('parses a notion connection with selected_roots crawl', () => {
    const parsed = connectionConfigSchema.parse({
      driver: 'notion',
      auth_token_ref: 'env:NOTION_TOKEN',
      crawl_mode: 'selected_roots',
      root_page_ids: ['abc', 'def'],
      max_pages_per_run: 500,
    });
    expect(parsed).toMatchObject({
      driver: 'notion',
      crawl_mode: 'selected_roots',
      root_page_ids: ['abc', 'def'],
      max_pages_per_run: 500,
    });
  });

  it('rejects notion with unknown crawl_mode', () => {
    expect(() =>
      connectionConfigSchema.parse({
        driver: 'notion',
        auth_token_ref: 'env:NOTION_TOKEN',
        crawl_mode: 'everything',
      }),
    ).toThrow();
  });

  it('parses a gdrive connection', () => {
    const parsed = connectionConfigSchema.parse({
      driver: 'gdrive',
      service_account_key_ref: 'file:/tmp/google-service-account.json', // pragma: allowlist secret
      folder_id: 'folder-123',
      recursive: true,
    });
    expect(parsed).toMatchObject({
      driver: 'gdrive',
      service_account_key_ref: 'file:/tmp/google-service-account.json', // pragma: allowlist secret
      folder_id: 'folder-123',
      recursive: true,
    });
  });

  it('parses a dbt connection from a local source_dir', () => {
    const parsed = connectionConfigSchema.parse({
      driver: 'dbt',
      source_dir: '/tmp/dbt-project',
      target: 'dev',
    });
    expect(parsed).toMatchObject({ driver: 'dbt', source_dir: '/tmp/dbt-project', target: 'dev' });
  });

  it('parses a metricflow connection with nested config', () => {
    const parsed = connectionConfigSchema.parse({
      driver: 'metricflow',
      metricflow: {
        repoUrl: 'https://github.com/acme/sl.git',
        branch: 'main',
      },
    });
    expect(parsed).toMatchObject({
      driver: 'metricflow',
      metricflow: { repoUrl: 'https://github.com/acme/sl.git' },
    });
  });
});
