import { createHash } from 'node:crypto';
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { gzipSync, strToU8, zipSync } from 'fflate';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { KtxExpectedError } from '../src/errors.js';
import {
  doctorManagedPythonRuntime,
  ensureManagedUv,
  installManagedPythonRuntime,
  managedPythonDaemonLayout,
  managedPythonRuntimeLayout,
  managedUvPath,
  readManagedPythonRuntimeStatus,
  verifyRuntimeAsset,
  type ManagedPythonRuntimeExec,
  type ManagedUvRelease,
} from '../src/managed-python-runtime.js';
import type { ManagedUvPlatformKey } from '../src/managed-uv-release.js';

async function placeFakeUv(runtimeRoot: string): Promise<string> {
  const uvPath = managedUvPath({ runtimeRoot });
  await mkdir(dirname(uvPath), { recursive: true });
  await writeFile(uvPath, '#!/bin/sh\n');
  return uvPath;
}

function tarball(entries: Record<string, Uint8Array>): Uint8Array {
  const blocks: Uint8Array[] = [];
  for (const [name, data] of Object.entries(entries)) {
    const header = new Uint8Array(512);
    header.set(strToU8(name), 0);
    header.set(strToU8('0000755\0'), 100);
    header.set(strToU8(`${data.length.toString(8).padStart(11, '0')}\0`), 124);
    blocks.push(header);
    const padded = new Uint8Array(Math.ceil(data.length / 512) * 512);
    padded.set(data);
    blocks.push(padded);
  }
  blocks.push(new Uint8Array(1024));
  const out = new Uint8Array(blocks.reduce((total, block) => total + block.length, 0));
  let offset = 0;
  for (const block of blocks) {
    out.set(block, offset);
    offset += block.length;
  }
  return out;
}

function releaseFor(file: string, contents: Uint8Array, key: ManagedUvPlatformKey): ManagedUvRelease {
  return {
    version: '9.9.9-test',
    artifacts: {
      [key]: { file, sha256: createHash('sha256').update(contents).digest('hex') },
    },
  };
}

function runtimeWheelContents(input: { label?: string; requiresPython?: string | null } = {}): Buffer {
  const label = input.label ?? 'runtime-wheel';
  const requiresPython = input.requiresPython === null ? [] : [`Requires-Python: ${input.requiresPython ?? '>=3.13'}`];
  return Buffer.from(
    zipSync({
      'kaelio_ktx-0.1.0.dist-info/METADATA': strToU8(
        [
          'Metadata-Version: 2.4',
          'Name: kaelio-ktx',
          'Version: 0.1.0',
          ...requiresPython,
          `Summary: ${label}`,
          '',
        ].join('\n'),
      ),
    }),
  );
}

async function writeAsset(
  root: string,
  options: { label?: string; requiresPython?: string | null; contents?: Buffer } = {},
) {
  const assetDir = join(root, 'assets', 'python');
  await mkdir(assetDir, { recursive: true });
  const wheelPath = join(assetDir, 'kaelio_ktx-0.1.0-py3-none-any.whl');
  const contents = options.contents ?? runtimeWheelContents(options);
  await writeFile(wheelPath, contents);
  await writeFile(
    join(assetDir, 'manifest.json'),
    `${JSON.stringify(
      {
        schemaVersion: 1,
        distributionName: 'kaelio-ktx',
        normalizedName: 'kaelio_ktx',
        version: '0.1.0',
        wheel: {
          file: 'kaelio_ktx-0.1.0-py3-none-any.whl',
          sha256: createHash('sha256').update(contents).digest('hex'),
          bytes: contents.byteLength,
        },
      },
      null,
      2,
    )}\n`,
  );
  return { assetDir, wheelPath };
}

describe('managedPythonRuntimeLayout', () => {
  it('uses ~/.ktx/runtime as the runtime root on macOS', () => {
    const layout = managedPythonRuntimeLayout({
      cliVersion: '0.2.0',
      platform: 'darwin',
      env: {},
      homeDir: '/Users/alex',
      assetDir: '/repo/packages/cli/assets/python',
    });

    expect(layout.runtimeRoot).toBe('/Users/alex/.ktx/runtime');
    expect(layout.versionDir).toBe('/Users/alex/.ktx/runtime/0.2.0');
    expect(layout.venvDir).toBe('/Users/alex/.ktx/runtime/0.2.0/.venv');
    expect(layout.pythonPath).toBe('/Users/alex/.ktx/runtime/0.2.0/.venv/bin/python');
    expect(layout.daemonPath).toBe('/Users/alex/.ktx/runtime/0.2.0/.venv/bin/ktx-daemon');
    expect(layout.assetManifestPath).toBe('/repo/packages/cli/assets/python/manifest.json');
  });

  it('uses ~/.ktx/runtime on Linux too', () => {
    const layout = managedPythonRuntimeLayout({
      cliVersion: '0.2.0',
      platform: 'linux',
      env: {},
      homeDir: '/home/alex',
      assetDir: '/repo/packages/cli/assets/python',
    });

    expect(layout.runtimeRoot).toBe('/home/alex/.ktx/runtime');
    expect(layout.versionDir).toBe('/home/alex/.ktx/runtime/0.2.0');
  });

  it('uses Scripts/*.exe layout on Windows under ~/.ktx/runtime', () => {
    const layout = managedPythonRuntimeLayout({
      cliVersion: '0.2.0',
      platform: 'win32',
      env: {},
      homeDir: 'C:\\Users\\Alex',
      assetDir: 'C:\\repo\\packages\\cli\\assets\\python',
    });

    expect(layout.runtimeRoot).toBe('C:\\Users\\Alex/.ktx/runtime');
    expect(layout.pythonPath).toBe('C:\\Users\\Alex/.ktx/runtime/0.2.0/.venv/Scripts/python.exe');
    expect(layout.daemonPath).toBe('C:\\Users\\Alex/.ktx/runtime/0.2.0/.venv/Scripts/ktx-daemon.exe');
  });

  it('honors KTX_RUNTIME_ROOT before the default ~/.ktx/runtime', () => {
    const layout = managedPythonRuntimeLayout({
      cliVersion: '0.2.0',
      platform: 'darwin',
      env: { KTX_RUNTIME_ROOT: '/tmp/ktx-runtime' },
      homeDir: '/Users/alex',
      assetDir: '/repo/packages/cli/assets/python',
    });

    expect(layout.runtimeRoot).toBe('/tmp/ktx-runtime');
    expect(layout.versionDir).toBe('/tmp/ktx-runtime/0.2.0');
  });
});

describe('managedPythonDaemonLayout', () => {
  it('places daemon state, stdout, and stderr under {projectDir}/.ktx/runtime', () => {
    const layout = managedPythonDaemonLayout({
      cliVersion: '0.2.0',
      projectDir: '/work/orbit-analytics',
      platform: 'darwin',
      env: {},
      homeDir: '/Users/alex',
      assetDir: '/repo/packages/cli/assets/python',
    });

    expect(layout.projectDir).toBe('/work/orbit-analytics');
    expect(layout.daemonStateDir).toBe('/work/orbit-analytics/.ktx/runtime');
    expect(layout.daemonStatePath).toBe('/work/orbit-analytics/.ktx/runtime/daemon.json');
    expect(layout.daemonStdoutPath).toBe('/work/orbit-analytics/.ktx/runtime/daemon.stdout.log');
    expect(layout.daemonStderrPath).toBe('/work/orbit-analytics/.ktx/runtime/daemon.stderr.log');
  });

  it('keeps install paths under the global runtime root regardless of projectDir', () => {
    const layout = managedPythonDaemonLayout({
      cliVersion: '0.2.0',
      projectDir: '/work/orbit-analytics',
      platform: 'darwin',
      env: {},
      homeDir: '/Users/alex',
      assetDir: '/repo/packages/cli/assets/python',
    });

    expect(layout.runtimeRoot).toBe('/Users/alex/.ktx/runtime');
    expect(layout.versionDir).toBe('/Users/alex/.ktx/runtime/0.2.0');
    expect(layout.pythonPath).toBe('/Users/alex/.ktx/runtime/0.2.0/.venv/bin/python');
  });
});

describe('verifyRuntimeAsset', () => {
  let tempDir: string;

  beforeEach(async () => {
    tempDir = await mkdtemp(join(tmpdir(), 'ktx-runtime-asset-'));
  });

  afterEach(async () => {
    await rm(tempDir, { recursive: true, force: true });
  });

  it('reads the manifest and verifies the wheel checksum', async () => {
    const { assetDir, wheelPath } = await writeAsset(tempDir, { label: 'valid-wheel' });

    const asset = await verifyRuntimeAsset({ assetDir });

    expect(asset.manifest.distributionName).toBe('kaelio-ktx');
    expect(asset.manifest.normalizedName).toBe('kaelio_ktx');
    expect(asset.wheelPath).toBe(wheelPath);
    expect(asset.requiresPython).toEqual({ specifier: '>=3.13', minimumVersion: '3.13' });
  });

  it('rejects a wheel whose checksum does not match the manifest', async () => {
    const { assetDir, wheelPath } = await writeAsset(tempDir, { label: 'original' });
    await writeFile(wheelPath, 'tampered');

    await expect(verifyRuntimeAsset({ assetDir })).rejects.toThrow(
      /Bundled Python runtime wheel checksum mismatch/,
    );
  });

  it('rejects an unsafe wheel filename in the manifest', async () => {
    const { assetDir } = await writeAsset(tempDir, { label: 'valid-wheel' });
    await writeFile(
      join(assetDir, 'manifest.json'),
      `${JSON.stringify({
        schemaVersion: 1,
        distributionName: 'kaelio-ktx',
        normalizedName: 'kaelio_ktx',
        version: '0.1.0',
        wheel: {
          file: '../kaelio_ktx-0.1.0-py3-none-any.whl',
          sha256: 'a'.repeat(64),
          bytes: 1,
        },
      })}\n`,
    );

    await expect(verifyRuntimeAsset({ assetDir })).rejects.toThrow(/Unsafe runtime wheel filename/);
  });

  it('reports the source-checkout artifact command when the bundled manifest is missing', async () => {
    const assetDir = join(tempDir, 'packages', 'cli', 'assets', 'python');

    await expect(verifyRuntimeAsset({ assetDir })).rejects.toThrow(
      /Missing bundled Python runtime manifest.*pnpm run artifacts:build/s,
    );
  });

  it('rejects a bundled wheel without Requires-Python metadata', async () => {
    const { assetDir } = await writeAsset(tempDir, { requiresPython: null });

    await expect(verifyRuntimeAsset({ assetDir })).rejects.toThrow(
      /Bundled Python runtime wheel metadata is missing Requires-Python/,
    );
  });

  it('rejects a bundled wheel without a supported minimum Python version', async () => {
    const { assetDir } = await writeAsset(tempDir, { requiresPython: '<4' });

    await expect(verifyRuntimeAsset({ assetDir })).rejects.toThrow(
      /Unsupported bundled Python runtime Requires-Python: <4/,
    );
  });
});

describe('installManagedPythonRuntime', () => {
  let tempDir: string;

  beforeEach(async () => {
    tempDir = await mkdtemp(join(tmpdir(), 'ktx-runtime-install-'));
  });

  afterEach(async () => {
    await rm(tempDir, { recursive: true, force: true });
  });

  it('creates a venv, installs the core wheel, and writes a manifest', async () => {
    const { assetDir } = await writeAsset(tempDir, { label: 'core-wheel' });
    const uvPath = await placeFakeUv(join(tempDir, 'runtime'));
    const commands: Array<{ command: string; args: string[] }> = [];
    const exec: ManagedPythonRuntimeExec = vi.fn(async (command, args) => {
      commands.push({ command, args });
      return { stdout: command === uvPath && args[0] === '--version' ? 'uv 0.9.5\n' : '', stderr: '' };
    });

    const result = await installManagedPythonRuntime({
      cliVersion: '0.2.0',
      runtimeRoot: join(tempDir, 'runtime'),
      assetDir,
      features: ['core'],
      exec,
    });

    expect(result.status).toBe('installed');
    expect(commands).toEqual([
      { command: uvPath, args: ['--version'] },
      { command: uvPath, args: ['python', 'install', '3.13'] },
      { command: uvPath, args: ['venv', '--python', '3.13', result.layout.venvDir] },
      {
        command: uvPath,
        args: ['pip', 'install', '--python', result.layout.pythonPath, result.asset.wheelPath],
      },
    ]);
    const manifest = JSON.parse(await readFile(result.layout.manifestPath, 'utf8')) as {
      cliVersion: string;
      features: string[];
      python: { executable: string; daemonExecutable: string };
    };
    expect(manifest.cliVersion).toBe('0.2.0');
    expect(manifest.features).toEqual(['core']);
    expect(manifest.python.executable).toBe(result.layout.pythonPath);
    expect(manifest.python.daemonExecutable).toBe(result.layout.daemonPath);
  });

  it('disables repo uv config for managed runtime uv commands', async () => {
    const { assetDir } = await writeAsset(tempDir, { label: 'core-wheel' });
    const uvPath = await placeFakeUv(join(tempDir, 'runtime'));
    const commands: Array<{ command: string; args: string[]; env?: NodeJS.ProcessEnv }> = [];
    const exec: ManagedPythonRuntimeExec = vi.fn(async (command, args, options) => {
      commands.push({ command, args, env: options?.env });
      return { stdout: command === uvPath && args[0] === '--version' ? 'uv 0.11.13\n' : '', stderr: '' };
    });

    await installManagedPythonRuntime({
      cliVersion: '0.2.0',
      runtimeRoot: join(tempDir, 'runtime'),
      assetDir,
      env: { PATH: '/opt/homebrew/bin', UV_NO_CONFIG: '0' },
      features: ['core'],
      exec,
    });

    expect(commands.map((call) => [call.command, call.args[0], call.env?.UV_NO_CONFIG, call.env?.PATH])).toEqual([
      [uvPath, '--version', '1', '/opt/homebrew/bin'],
      [uvPath, 'python', '1', '/opt/homebrew/bin'],
      [uvPath, 'venv', '1', '/opt/homebrew/bin'],
      [uvPath, 'pip', '1', '/opt/homebrew/bin'],
    ]);
  });

  it('installs the local-embeddings extra when requested', async () => {
    const { assetDir } = await writeAsset(tempDir, { label: 'embedding-wheel' });
    const uvPath = await placeFakeUv(join(tempDir, 'runtime'));
    const commands: Array<{ command: string; args: string[] }> = [];
    const exec: ManagedPythonRuntimeExec = vi.fn(async (command, args) => {
      commands.push({ command, args });
      return { stdout: command === uvPath && args[0] === '--version' ? 'uv 0.9.5\n' : '', stderr: '' };
    });

    const result = await installManagedPythonRuntime({
      cliVersion: '0.2.0',
      runtimeRoot: join(tempDir, 'runtime'),
      assetDir,
      features: ['local-embeddings'],
      exec,
    });

    expect(commands.at(-1)).toEqual({
      command: uvPath,
      args: ['pip', 'install', '--python', result.layout.pythonPath, `${result.asset.wheelPath}[local-embeddings]`],
    });
    const manifest = JSON.parse(await readFile(result.layout.manifestPath, 'utf8')) as { features: string[] };
    expect(manifest.features).toEqual(['core', 'local-embeddings']);
  });

  it('attempts the pinned uv download from github.com and rejects checksum mismatches', async () => {
    const { assetDir } = await writeAsset(tempDir, { label: 'core-wheel' });
    const runtimeRoot = join(tempDir, 'runtime');
    const archive = gzipSync(tarball({ 'uv-test/uv': strToU8('#!/bin/sh\necho uv\n') }));
    const fetchUvArtifact = vi.fn(async () => archive);
    const exec: ManagedPythonRuntimeExec = vi.fn(async () => ({ stdout: 'uv 9.9.9\n', stderr: '' }));

    const error = await installManagedPythonRuntime({
      cliVersion: '0.2.0',
      runtimeRoot,
      assetDir,
      features: ['core'],
      exec,
      fetchUvArtifact,
    }).catch((caught: unknown) => caught);

    expect(fetchUvArtifact).toHaveBeenCalledTimes(1);
    expect(fetchUvArtifact).toHaveBeenCalledWith(
      expect.stringMatching(/^https:\/\/github\.com\/astral-sh\/uv\/releases\/download\//),
    );
    expect(error).toBeInstanceOf(KtxExpectedError);
    expect((error as Error).message).toContain('failed checksum verification');
    expect(exec).not.toHaveBeenCalled();
  });

  it('fails with download guidance and preserves the existing runtime when uv cannot be fetched', async () => {
    const { assetDir } = await writeAsset(tempDir, { label: 'core-wheel' });
    const runtimeRoot = join(tempDir, 'runtime');
    const exec: ManagedPythonRuntimeExec = vi.fn(async () => ({ stdout: '', stderr: '' }));
    const fetchUvArtifact = vi.fn(async () => {
      throw new Error('getaddrinfo ENOTFOUND github.com');
    });
    const survivingRuntimeFile = join(runtimeRoot, '0.2.0', 'install.log');
    await mkdir(dirname(survivingRuntimeFile), { recursive: true });
    await writeFile(survivingRuntimeFile, 'stale runtime contents\n');

    const error = await installManagedPythonRuntime({
      cliVersion: '0.2.0',
      runtimeRoot,
      assetDir,
      features: ['core'],
      exec,
      fetchUvArtifact,
    }).catch((caught: unknown) => caught);

    // KtxExpectedError keeps this user-environment outcome out of Error Tracking.
    expect(error).toBeInstanceOf(KtxExpectedError);
    expect((error as Error).message).toContain('could not download uv');
    expect((error as Error).message).toContain('ktx admin runtime install --yes');
    expect(exec).not.toHaveBeenCalled();
    // A failed uv acquisition must not wipe whatever runtime is already on disk.
    await expect(readFile(survivingRuntimeFile, 'utf8')).resolves.toContain('stale');
  });

  it('reuses an existing compatible runtime when force is false', async () => {
    const { assetDir } = await writeAsset(tempDir, { label: 'core-wheel' });
    const uvPath = await placeFakeUv(join(tempDir, 'runtime'));
    const exec: ManagedPythonRuntimeExec = vi.fn(async (command, args) => ({
      stdout: command === uvPath && args[0] === '--version' ? 'uv 0.9.5\n' : '',
      stderr: '',
    }));

    const first = await installManagedPythonRuntime({
      cliVersion: '0.2.0',
      runtimeRoot: join(tempDir, 'runtime'),
      assetDir,
      features: ['core'],
      exec,
    });
    await mkdir(join(first.layout.venvDir, 'bin'), { recursive: true });
    await writeFile(first.layout.pythonPath, '#!/usr/bin/env python\n');
    await writeFile(first.layout.daemonPath, '#!/usr/bin/env python\n');

    const second = await installManagedPythonRuntime({
      cliVersion: '0.2.0',
      runtimeRoot: join(tempDir, 'runtime'),
      assetDir,
      features: ['core'],
      exec,
    });

    expect(second.status).toBe('ready');
    expect(exec).toHaveBeenCalledTimes(4);
  });

  it('keeps failed install logs in the versioned runtime directory', async () => {
    const { assetDir } = await writeAsset(tempDir, { label: 'core-wheel' });
    const uvPath = await placeFakeUv(join(tempDir, 'runtime'));
    const exec: ManagedPythonRuntimeExec = vi.fn(async (command, args) => {
      if (command === uvPath && args[0] === 'venv') {
        throw Object.assign(new Error('uv venv failed'), {
          stdout: 'creating\n',
          stderr: '× No solution found\n╰─▶ current Python version (3.12.3) does not satisfy Python>=3.13\n',
        });
      }
      return { stdout: command === uvPath && args[0] === '--version' ? 'uv 0.9.5\n' : '', stderr: '' };
    });

    await expect(
      installManagedPythonRuntime({
        cliVersion: '0.2.0',
        runtimeRoot: join(tempDir, 'runtime'),
        assetDir,
        features: ['core'],
        exec,
      }),
    ).rejects.toThrow(/current Python version \(3\.12\.3\) does not satisfy Python>=3\.13/);

    const log = await readFile(join(tempDir, 'runtime', '0.2.0', 'install.log'), 'utf8');
    expect(log).toContain(`$ ${uvPath} venv --python 3.13`);
    expect(log).toContain('current Python version (3.12.3) does not satisfy Python>=3.13');
  });
});

describe('ensureManagedUv', () => {
  let tempDir: string;

  beforeEach(async () => {
    tempDir = await mkdtemp(join(tmpdir(), 'ktx-managed-uv-'));
  });

  afterEach(async () => {
    await rm(tempDir, { recursive: true, force: true });
  });

  it('downloads, verifies, and extracts uv from a tar.gz artifact, then reuses the cached binary', async () => {
    const binary = strToU8('#!/bin/sh\necho uv\n');
    const archive = gzipSync(tarball({ 'uv-test/': new Uint8Array(0), 'uv-test/uvx': strToU8('x'), 'uv-test/uv': binary }));
    const release = releaseFor('uv-test.tar.gz', archive, 'linux-x64');
    const fetchArtifact = vi.fn(async () => archive);

    const uvPath = await ensureManagedUv({
      platform: 'linux',
      arch: 'x64',
      runtimeRoot: join(tempDir, 'runtime'),
      fetchArtifact,
      release,
    });

    expect(uvPath).toBe(join(tempDir, 'runtime', 'uv', '9.9.9-test', 'uv'));
    await expect(readFile(uvPath, 'utf8')).resolves.toBe('#!/bin/sh\necho uv\n');

    const again = await ensureManagedUv({
      platform: 'linux',
      arch: 'x64',
      runtimeRoot: join(tempDir, 'runtime'),
      fetchArtifact,
      release,
    });
    expect(again).toBe(uvPath);
    expect(fetchArtifact).toHaveBeenCalledTimes(1);
  });

  it('extracts uv.exe from a zip artifact on Windows', async () => {
    const archive = zipSync({ 'uv.exe': strToU8('MZ-uv'), 'uvx.exe': strToU8('MZ-uvx') });
    const release = releaseFor('uv-test.zip', archive, 'win32-x64');

    const uvPath = await ensureManagedUv({
      platform: 'win32',
      arch: 'x64',
      runtimeRoot: join(tempDir, 'runtime'),
      fetchArtifact: vi.fn(async () => archive),
      release,
    });

    expect(uvPath).toBe(join(tempDir, 'runtime', 'uv', '9.9.9-test', 'uv.exe'));
    await expect(readFile(uvPath, 'utf8')).resolves.toBe('MZ-uv');
  });

  it('rejects an artifact whose checksum does not match the pin', async () => {
    const archive = gzipSync(tarball({ 'uv-test/uv': strToU8('uv') }));
    const release = releaseFor('uv-test.tar.gz', archive, 'linux-x64');
    release.artifacts['linux-x64']!.sha256 = 'b'.repeat(64);

    const error = await ensureManagedUv({
      platform: 'linux',
      arch: 'x64',
      runtimeRoot: join(tempDir, 'runtime'),
      fetchArtifact: vi.fn(async () => archive),
      release,
    }).catch((caught: unknown) => caught);

    expect(error).toBeInstanceOf(KtxExpectedError);
    expect((error as Error).message).toContain('failed checksum verification');
  });

  it('fails with manual-placement guidance on platforms without a pinned artifact', async () => {
    const error = await ensureManagedUv({
      platform: 'sunos',
      arch: 'x64',
      runtimeRoot: join(tempDir, 'runtime'),
      fetchArtifact: vi.fn(),
      release: { version: '9.9.9-test', artifacts: {} },
    }).catch((caught: unknown) => caught);

    expect(error).toBeInstanceOf(KtxExpectedError);
    expect((error as Error).message).toContain('does not bundle uv for sunos-x64');
    expect((error as Error).message).toContain(join(tempDir, 'runtime', 'uv', '9.9.9-test', 'uv'));
  });
});

describe('readManagedPythonRuntimeStatus', () => {
  let tempDir: string;

  beforeEach(async () => {
    tempDir = await mkdtemp(join(tmpdir(), 'ktx-runtime-status-'));
  });

  afterEach(async () => {
    await rm(tempDir, { recursive: true, force: true });
  });

  it('reports missing before install', async () => {
    const status = await readManagedPythonRuntimeStatus({
      cliVersion: '0.2.0',
      runtimeRoot: join(tempDir, 'runtime'),
      assetDir: join(tempDir, 'assets', 'python'),
    });

    expect(status.kind).toBe('missing');
    expect(status.detail).toContain('No runtime manifest');
  });

  it('reports ready when manifest and executables exist', async () => {
    const { assetDir } = await writeAsset(tempDir, { label: 'core-wheel' });
    const uvPath = await placeFakeUv(join(tempDir, 'runtime'));
    const exec: ManagedPythonRuntimeExec = vi.fn(async (command, args) => ({
      stdout: command === uvPath && args[0] === '--version' ? 'uv 0.9.5\n' : '',
      stderr: '',
    }));
    const install = await installManagedPythonRuntime({
      cliVersion: '0.2.0',
      runtimeRoot: join(tempDir, 'runtime'),
      assetDir,
      features: ['core'],
      exec,
    });
    await mkdir(join(install.layout.venvDir, 'bin'), { recursive: true });
    await writeFile(install.layout.pythonPath, '#!/usr/bin/env python\n');
    await writeFile(install.layout.daemonPath, '#!/usr/bin/env python\n');

    const status = await readManagedPythonRuntimeStatus({
      cliVersion: '0.2.0',
      runtimeRoot: join(tempDir, 'runtime'),
      assetDir,
    });

    expect(status.kind).toBe('ready');
    expect(status.manifest?.features).toEqual(['core']);
  });

  it('reports broken when an executable is missing', async () => {
    const { assetDir } = await writeAsset(tempDir, { label: 'core-wheel' });
    const uvPath = await placeFakeUv(join(tempDir, 'runtime'));
    const exec: ManagedPythonRuntimeExec = vi.fn(async (command, args) => ({
      stdout: command === uvPath && args[0] === '--version' ? 'uv 0.9.5\n' : '',
      stderr: '',
    }));
    await installManagedPythonRuntime({
      cliVersion: '0.2.0',
      runtimeRoot: join(tempDir, 'runtime'),
      assetDir,
      features: ['core'],
      exec,
    });

    const status = await readManagedPythonRuntimeStatus({
      cliVersion: '0.2.0',
      runtimeRoot: join(tempDir, 'runtime'),
      assetDir,
    });

    expect(status.kind).toBe('broken');
    expect(status.detail).toContain('Missing Python executable');
  });
});

describe('doctorManagedPythonRuntime', () => {
  let tempDir: string;

  beforeEach(async () => {
    tempDir = await mkdtemp(join(tmpdir(), 'ktx-runtime-doctor-'));
  });

  afterEach(async () => {
    await rm(tempDir, { recursive: true, force: true });
  });

  it('checks uv, bundled assets, and installed runtime status', async () => {
    const { assetDir } = await writeAsset(tempDir, { label: 'core-wheel' });
    const uvPath = await placeFakeUv(join(tempDir, 'runtime'));
    const exec: ManagedPythonRuntimeExec = vi.fn(async (command, args) => ({
      stdout: command === uvPath && args[0] === '--version' ? 'uv 0.9.5\n' : '',
      stderr: '',
    }));

    const checks = await doctorManagedPythonRuntime({
      cliVersion: '0.2.0',
      runtimeRoot: join(tempDir, 'runtime'),
      assetDir,
      exec,
    });

    expect(checks.map((check) => [check.id, check.status])).toEqual([
      ['uv', 'pass'],
      ['asset', 'pass'],
      ['runtime', 'fail'],
    ]);
    expect(checks[0]?.detail).toBe(`uv 0.9.5 (managed: ${uvPath})`);
    expect(checks[2]?.fix).toBe('Run: ktx admin runtime install --yes');
  });

  it('fails the uv check with download guidance when uv cannot be acquired', async () => {
    const { assetDir } = await writeAsset(tempDir, { label: 'core-wheel' });
    const exec: ManagedPythonRuntimeExec = vi.fn(async () => ({ stdout: '', stderr: '' }));

    const checks = await doctorManagedPythonRuntime({
      cliVersion: '0.2.0',
      runtimeRoot: join(tempDir, 'runtime'),
      assetDir,
      exec,
      fetchUvArtifact: vi.fn(async () => {
        throw new Error('getaddrinfo ENOTFOUND github.com');
      }),
    });

    expect(checks[0]?.id).toBe('uv');
    expect(checks[0]?.status).toBe('fail');
    expect(checks[0]?.detail).toContain('could not download uv');
    expect(checks[0]?.fix).toBe('Check network access to github.com and run: ktx admin runtime install --yes');
  });
});
