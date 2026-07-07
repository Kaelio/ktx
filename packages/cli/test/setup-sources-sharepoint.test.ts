import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { initKtxProject } from '../src/context/project/project.js';
import { parseKtxProjectConfig, serializeKtxProjectConfig } from '../src/context/project/config.js';
import { runKtxSetupSourcesStep } from '../src/setup-sources.js';

function makeIo() {
  let stdout = '';
  let stderr = '';
  return {
    io: {
      stdout: {
        isTTY: true,
        write: (chunk: string) => {
          stdout += chunk;
        },
      },
      stderr: {
        write: (chunk: string) => {
          stderr += chunk;
        },
      },
    },
    stdout: () => stdout,
    stderr: () => stderr,
  };
}

describe('setup sources step sharepoint', () => {
  let tempDir: string;
  let projectDir: string;

  beforeEach(async () => {
    tempDir = await mkdtemp(join(tmpdir(), 'ktx-setup-sources-sharepoint-'));
    projectDir = join(tempDir, 'project');
    await initKtxProject({ projectDir });
    const config = parseKtxProjectConfig(await readFile(join(projectDir, 'ktx.yaml'), 'utf-8'));
    await writeFile(
      join(projectDir, 'ktx.yaml'),
      serializeKtxProjectConfig({
        ...config,
        connections: {
          warehouse: { driver: 'postgres', url: 'env:DATABASE_URL' },
        },
        setup: {
          ...config.setup,
          database_connection_ids: ['warehouse'],
        },
      }),
      'utf-8',
    );
  });

  afterEach(async () => {
    vi.unstubAllEnvs();
    await rm(tempDir, { recursive: true, force: true });
  });

  it('writes SharePoint config with env refs and recursive defaulting', async () => {
    const validateSharepoint = vi.fn(async () => ({ ok: true as const, detail: 'docs=2' }));
    const io = makeIo();

    await expect(
      runKtxSetupSourcesStep(
        {
          projectDir,
          inputMode: 'disabled',
          source: 'sharepoint',
          sourceConnectionId: 'docs_sharepoint',
          sharepointTenantIdRef: 'env:AZURE_TENANT_ID',
          sharepointClientIdRef: 'env:AZURE_CLIENT_ID',
          sharepointClientSecretRef: 'env:AZURE_CLIENT_SECRET', // pragma: allowlist secret
          sharepointDriveId: 'drive-123',
          sharepointFolderId: 'folder-456',
          runInitialSourceIngest: false,
          skipSources: false,
        },
        io.io,
        { validateSharepoint },
      ),
    ).resolves.toEqual({ status: 'ready', projectDir, connectionIds: ['docs_sharepoint'] });

    const config = parseKtxProjectConfig(await readFile(join(projectDir, 'ktx.yaml'), 'utf-8'));
    expect(config.connections.docs_sharepoint).toMatchObject({
      driver: 'sharepoint',
      tenant_id_ref: 'env:AZURE_TENANT_ID',
      client_id_ref: 'env:AZURE_CLIENT_ID',
      client_secret_ref: 'env:AZURE_CLIENT_SECRET', // pragma: allowlist secret
      drive_id: 'drive-123',
      folder_id: 'folder-456',
      recursive: false,
    });
  });
});
