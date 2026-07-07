import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  parseSharepointConnectionConfig,
  sharepointConnectionToPullConfig,
} from '../../../src/context/connections/sharepoint-config.js';

describe('standalone sharepoint connection config', () => {
  afterEach(async () => {
    vi.unstubAllEnvs();
  });

  it('parses config with safe defaults', () => {
    const parsed = parseSharepointConnectionConfig({
      driver: 'sharepoint',
      tenant_id_ref: 'env:AZURE_TENANT_ID',
      client_id_ref: 'env:AZURE_CLIENT_ID',
      client_secret_ref: 'env:AZURE_CLIENT_SECRET', // pragma: allowlist secret
      drive_id: 'drive-123',
      folder_id: 'folder-456',
    });

    expect(parsed).toEqual({
      driver: 'sharepoint',
      tenant_id_ref: 'env:AZURE_TENANT_ID',
      client_id_ref: 'env:AZURE_CLIENT_ID',
      client_secret_ref: 'env:AZURE_CLIENT_SECRET', // pragma: allowlist secret
      drive_id: 'drive-123',
      folder_id: 'folder-456',
      recursive: false,
    });
  });

  it('requires env refs for all credential fields', () => {
    expect(() =>
      parseSharepointConnectionConfig({
        driver: 'sharepoint',
        tenant_id_ref: 'file:/tmp/tenant',
        client_id_ref: 'env:AZURE_CLIENT_ID',
        client_secret_ref: 'env:AZURE_CLIENT_SECRET', // pragma: allowlist secret
        drive_id: 'drive-123',
        folder_id: 'folder-456',
      }),
    ).toThrow('sharepoint tenant_id_ref must use env:NAME');
  });

  it('resolves env refs into adapter pull config', async () => {
    const pullConfig = await sharepointConnectionToPullConfig(
      parseSharepointConnectionConfig({
        driver: 'sharepoint',
        tenant_id_ref: 'env:AZURE_TENANT_ID',
        client_id_ref: 'env:AZURE_CLIENT_ID',
        client_secret_ref: 'env:AZURE_CLIENT_SECRET', // pragma: allowlist secret
        drive_id: 'drive-123',
        folder_id: 'folder-456',
        recursive: true,
      }),
      {
        env: {
          AZURE_TENANT_ID: 'tenant-1',
          AZURE_CLIENT_ID: 'client-1',
          AZURE_CLIENT_SECRET: 'secret-1', // pragma: allowlist secret
        },
      },
    );

    expect(pullConfig).toEqual({
      tenantId: 'tenant-1',
      clientId: 'client-1',
      clientSecret: 'secret-1', // pragma: allowlist secret
      driveId: 'drive-123',
      folderId: 'folder-456',
      recursive: true,
    });
  });

  it('fails clearly when an env var is unset', async () => {
    await expect(
      sharepointConnectionToPullConfig(
        parseSharepointConnectionConfig({
          driver: 'sharepoint',
          tenant_id_ref: 'env:AZURE_TENANT_ID',
          client_id_ref: 'env:AZURE_CLIENT_ID',
          client_secret_ref: 'env:AZURE_CLIENT_SECRET', // pragma: allowlist secret
          drive_id: 'drive-123',
          folder_id: 'folder-456',
        }),
        { env: { AZURE_TENANT_ID: 'tenant-1', AZURE_CLIENT_ID: 'client-1' } },
      ),
    ).rejects.toThrow('SharePoint environment variable AZURE_CLIENT_SECRET is not set');
  });
});
