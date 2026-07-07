import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { initKtxProject, loadKtxProject, type KtxLocalProject } from '../../../src/context/project/project.js';
import { createDefaultLocalIngestAdapters, localPullConfigForAdapter } from '../../../src/context/ingest/local-adapters.js';

describe('local sharepoint adapter wiring', () => {
  let tempDir: string;
  let project: KtxLocalProject;

  beforeEach(async () => {
    tempDir = await mkdtemp(join(tmpdir(), 'ktx-local-sharepoint-'));
    const projectDir = join(tempDir, 'project');
    await initKtxProject({ projectDir });
    project = await loadKtxProject({ projectDir });
  });

  afterEach(async () => {
    vi.unstubAllEnvs();
    await rm(tempDir, { recursive: true, force: true });
  });

  it('builds sharepoint pull config from a local connection', async () => {
    vi.stubEnv('AZURE_TENANT_ID', 'tenant-1');
    vi.stubEnv('AZURE_CLIENT_ID', 'client-1');
    vi.stubEnv('AZURE_CLIENT_SECRET', 'secret-1'); // pragma: allowlist secret
    const sharepointProject: KtxLocalProject = {
      ...project,
      config: {
        ...project.config,
        connections: {
          docs_sharepoint: {
            driver: 'sharepoint',
            tenant_id_ref: 'env:AZURE_TENANT_ID',
            client_id_ref: 'env:AZURE_CLIENT_ID',
            client_secret_ref: 'env:AZURE_CLIENT_SECRET', // pragma: allowlist secret
            drive_id: 'drive-123',
            folder_id: 'folder-456',
            recursive: true,
          },
        },
      },
    };

    const adapter = createDefaultLocalIngestAdapters(sharepointProject).find((candidate) => candidate.source === 'sharepoint');
    await expect(localPullConfigForAdapter(sharepointProject, adapter!, 'docs_sharepoint')).resolves.toEqual({
      tenantId: 'tenant-1',
      clientId: 'client-1',
      clientSecret: 'secret-1', // pragma: allowlist secret
      driveId: 'drive-123',
      folderId: 'folder-456',
      recursive: true,
    });
  });
});
