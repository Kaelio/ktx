import { describe, expect, it } from 'vitest';
import { confluenceRuntimeConfigFromLocalConnection } from '../../../../../src/context/ingest/adapters/confluence/local-confluence.adapter.js';

describe('confluenceRuntimeConfigFromLocalConnection', () => {
  it('resolves runtime config from a literal api_token', () => {
    const result = confluenceRuntimeConfigFromLocalConnection('confluence-prod', {
      driver: 'confluence',
      base_url: 'https://example.atlassian.net',
      email: 'user@example.com',
      api_token: 'secret-token',
    });
    expect(result.baseUrl).toBe('https://example.atlassian.net');
    expect(result.email).toBe('user@example.com');
    expect(result.apiToken).toBe('secret-token');
  });

  it('resolves api_token_ref via env reference', () => {
    const env = { MY_TOKEN: 'env-secret' };
    const result = confluenceRuntimeConfigFromLocalConnection(
      'confluence-prod',
      {
        driver: 'confluence',
        base_url: 'https://example.atlassian.net',
        email: 'user@example.com',
        api_token_ref: 'env:MY_TOKEN',
      },
      env as NodeJS.ProcessEnv,
    );
    expect(result.apiToken).toBe('env-secret');
  });

  it('throws when driver is not confluence', () => {
    expect(() =>
      confluenceRuntimeConfigFromLocalConnection('warehouse', { driver: 'postgres' }),
    ).toThrow('not a Confluence connection');
  });

  it('throws when base_url is missing', () => {
    expect(() =>
      confluenceRuntimeConfigFromLocalConnection('c', {
        driver: 'confluence',
        base_url: '',
        email: 'user@example.com',
        api_token: 'token',
      }),
    ).toThrow('missing Confluence base_url');
  });

  it('throws when api_token and api_token_ref are both absent', () => {
    expect(() =>
      confluenceRuntimeConfigFromLocalConnection('c', {
        driver: 'confluence',
        base_url: 'https://example.atlassian.net',
        email: 'user@example.com',
      }),
    ).toThrow('missing Confluence api_token');
  });
});
