import { describe, expect, it } from 'vitest';
import { connectionConfigSchema } from '../../../src/context/project/driver-schemas.js';

describe('connectionConfigSchema - sharepoint', () => {
  it('parses a sharepoint connection', () => {
    const parsed = connectionConfigSchema.parse({
      driver: 'sharepoint',
      tenant_id_ref: 'env:AZURE_TENANT_ID',
      client_id_ref: 'env:AZURE_CLIENT_ID',
      client_secret_ref: 'env:AZURE_CLIENT_SECRET', // pragma: allowlist secret
      drive_id: 'drive-123',
      folder_id: 'folder-456',
      recursive: true,
    });

    expect(parsed).toMatchObject({
      driver: 'sharepoint',
      tenant_id_ref: 'env:AZURE_TENANT_ID',
      client_id_ref: 'env:AZURE_CLIENT_ID',
      client_secret_ref: 'env:AZURE_CLIENT_SECRET', // pragma: allowlist secret
      drive_id: 'drive-123',
      folder_id: 'folder-456',
      recursive: true,
    });
  });

  it('rejects sharepoint connections with missing required ids', () => {
    expect(() =>
      connectionConfigSchema.parse({
        driver: 'sharepoint',
        tenant_id_ref: 'env:AZURE_TENANT_ID',
        client_id_ref: 'env:AZURE_CLIENT_ID',
        client_secret_ref: 'env:AZURE_CLIENT_SECRET', // pragma: allowlist secret
        drive_id: '',
        folder_id: 'folder-456',
      }),
    ).toThrow();
  });
});
