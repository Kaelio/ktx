import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { runKtxConnection } from '../src/connection.js';
import { initKtxProject } from '../src/context/project/project.js';
import { parseKtxProjectConfig, serializeKtxProjectConfig } from '../src/context/project/config.js';
import type { KtxProjectConnectionConfig } from '../src/context/project/config.js';

function makeIo() {
  const out: string[] = [];
  return {
    io: {
      stdout: { isTTY: false, write: (c: string) => { out.push(c); return true; } },
      stderr: { write: () => true },
    },
    stdout: () => out.join(''),
  };
}

async function writeConnections(
  projectDir: string,
  connections: Record<string, KtxProjectConnectionConfig>,
): Promise<void> {
  const config = parseKtxProjectConfig(await readFile(join(projectDir, 'ktx.yaml'), 'utf-8'));
  await writeFile(join(projectDir, 'ktx.yaml'), serializeKtxProjectConfig({ ...config, connections }), 'utf-8');
}

describe('ktx connection list federated entry', () => {
  let tempDir: string;

  beforeEach(async () => {
    tempDir = await mkdtemp(join(tmpdir(), 'ktx-conn-fed-'));
  });

  afterEach(async () => {
    await rm(tempDir, { recursive: true, force: true });
  });

  it('shows _ktx_federated when 2+ attach-compatible connections exist', async () => {
    const projectDir = join(tempDir, 'project');
    await initKtxProject({ projectDir });
    await writeConnections(projectDir, {
      books_db: { driver: 'sqlite' },
      reviews_db: { driver: 'sqlite' },
    });
    const io = makeIo();
    const code = await runKtxConnection({ command: 'list', projectDir }, io.io);
    const printed = io.stdout();
    expect(code).toBe(0);
    expect(printed).toContain('_ktx_federated');
    expect(printed).toContain('books_db, reviews_db');
    expect(printed).toContain('Cross-database queries run here');
  });

  it('omits _ktx_federated with a single connection', async () => {
    const projectDir = join(tempDir, 'project');
    await initKtxProject({ projectDir });
    await writeConnections(projectDir, {
      books_db: { driver: 'sqlite' },
    });
    const io = makeIo();
    await runKtxConnection({ command: 'list', projectDir }, io.io);
    expect(io.stdout()).not.toContain('_ktx_federated');
  });
});
