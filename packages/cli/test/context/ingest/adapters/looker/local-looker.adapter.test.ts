import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { lookerCredentialsFromLocalConnection } from '../../../../../src/context/ingest/adapters/looker/local-looker.adapter.js';
import type { KtxProjectConnectionConfig } from '../../../../../src/context/project/config.js';

const connectionId = '11111111-1111-4111-8111-111111111111';

function lookerConnection(overrides: Partial<KtxProjectConnectionConfig>): KtxProjectConnectionConfig {
  return {
    driver: 'looker',
    base_url: 'https://looker.example.com',
    client_id: 'client-123',
    ...overrides,
  } as KtxProjectConnectionConfig;
}

describe('lookerCredentialsFromLocalConnection', () => {
  let secretsDir: string;

  beforeEach(async () => {
    secretsDir = await mkdtemp(join(tmpdir(), 'looker-secret-'));
  });

  afterEach(async () => {
    await rm(secretsDir, { recursive: true, force: true });
  });

  it('resolves client_secret_ref written as a local secret file (ktx setup default)', async () => {
    const secretPath = join(secretsDir, 'looker-main-client-secret');
    await writeFile(secretPath, 'file-secret\n', 'utf-8');

    const credentials = lookerCredentialsFromLocalConnection(
      connectionId,
      lookerConnection({ client_secret_ref: `file:${secretPath}` }), // pragma: allowlist secret
      {},
    );

    expect(credentials.client_secret).toBe('file-secret');
  });

  it('resolves client_secret_ref from the environment', () => {
    const credentials = lookerCredentialsFromLocalConnection(
      connectionId,
      lookerConnection({ client_secret_ref: 'env:LOOKER_CLIENT_SECRET' }), // pragma: allowlist secret
      { LOOKER_CLIENT_SECRET: 'env-secret' }, // pragma: allowlist secret
    );

    expect(credentials.client_secret).toBe('env-secret');
  });

  it('prefers a literal client_secret over the reference', () => {
    const credentials = lookerCredentialsFromLocalConnection(
      connectionId,
      lookerConnection({ client_secret: 'literal-secret', client_secret_ref: 'env:UNSET' }), // pragma: allowlist secret
      {},
    );

    expect(credentials.client_secret).toBe('literal-secret');
  });

  it('throws when neither client_secret nor a resolvable client_secret_ref is present', () => {
    expect(() =>
      lookerCredentialsFromLocalConnection(
        connectionId,
        lookerConnection({ client_secret_ref: 'env:UNSET' }), // pragma: allowlist secret
        {},
      ),
    ).toThrow(/missing Looker client_secret/);
  });
});
