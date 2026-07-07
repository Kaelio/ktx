import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { initKtxProject } from '../src/context/project/project.js';
import { parseKtxProjectConfig, serializeKtxProjectConfig } from '../src/context/project/config.js';
import { runKtxConnection } from '../src/connection.js';

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

describe('runKtxConnection sharepoint', () => {
  let tempDir: string;

  beforeEach(async () => {
    tempDir = await mkdtemp(join(tmpdir(), 'ktx-cli-connection-sharepoint-'));
  });

  afterEach(async () => {
    await rm(tempDir, { recursive: true, force: true });
  });

  async function writeConnections(
    projectDir: string,
    connections: ReturnType<typeof parseKtxProjectConfig>['connections'],
  ): Promise<void> {
    const config = parseKtxProjectConfig(await readFile(join(projectDir, 'ktx.yaml'), 'utf-8'));
    await writeFile(join(projectDir, 'ktx.yaml'), serializeKtxProjectConfig({ ...config, connections }), 'utf-8');
  }

  it('tests a SharePoint connection by verifying folder access and counting supported docs', async () => {
    const projectDir = join(tempDir, 'project');
    await initKtxProject({ projectDir });
    await writeConnections(projectDir, {
      docs_sharepoint: {
        driver: 'sharepoint',
        tenant_id_ref: 'env:AZURE_TENANT_ID',
        client_id_ref: 'env:AZURE_CLIENT_ID',
        client_secret_ref: 'env:AZURE_CLIENT_SECRET', // pragma: allowlist secret
        drive_id: 'drive-123',
        folder_id: 'folder-456',
        recursive: true,
      },
    });
    const createSharepointClient = vi.fn(async (_project, _connectionId) => ({
      getDriveItem: vi.fn(async () => ({
        id: 'folder-456',
        name: 'Docs',
        webUrl: null,
        lastModifiedDateTime: null,
        file: null,
        folder: { childCount: 3 },
        downloadUrl: null,
      })),
      listDriveFiles: vi.fn(async () => [
        {
          item: {
            id: '1',
            name: 'Spec.md',
            webUrl: null,
            lastModifiedDateTime: null,
            file: { mimeType: 'text/markdown' },
            folder: null,
            downloadUrl: null,
          },
          drivePath: [],
        },
        {
          item: {
            id: '2',
            name: 'Guide.docx',
            webUrl: null,
            lastModifiedDateTime: null,
            file: { mimeType: 'application/vnd.openxmlformats-officedocument.wordprocessingml.document' },
            folder: null,
            downloadUrl: null,
          },
          drivePath: [],
        },
        {
          item: {
            id: '3',
            name: 'Diagram.png',
            webUrl: null,
            lastModifiedDateTime: null,
            file: { mimeType: 'image/png' },
            folder: null,
            downloadUrl: null,
          },
          drivePath: [],
        },
      ]),
    }));
    const io = makeIo();

    await expect(
      runKtxConnection({ command: 'test', projectDir, connectionId: 'docs_sharepoint' }, io.io, { createSharepointClient }),
    ).resolves.toBe(0);

    expect(io.stdout()).toContain('Connection test passed: docs_sharepoint');
    expect(io.stdout()).toContain('Driver: sharepoint');
    expect(io.stdout()).toContain('Docs: 2');
  });
});
