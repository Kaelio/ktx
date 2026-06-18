import { describe, expect, it, vi } from 'vitest';
import { KtxExpectedError } from '../src/errors.js';
import {
  createLazyManagedPythonSemanticLayerComputePort,
  createManagedPythonSemanticLayerComputePort,
  ensureManagedPythonCommandRuntime,
  managedRuntimeInstallCommand,
  runtimeInstallPolicyFromFlags,
} from '../src/managed-python-command.js';
import type {
  InstalledKtxRuntimeManifest,
  KtxRuntimeFeature,
  ManagedPythonRuntimeInstallResult,
  ManagedPythonRuntimeLayout,
  ManagedPythonRuntimeStatus,
} from '../src/managed-python-runtime.js';

function makeIo() {
  let stdout = '';
  let stderr = '';
  return {
    io: {
      stdout: {
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

function layout(): ManagedPythonRuntimeLayout {
  return {
    cliVersion: '0.2.0',
    runtimeRoot: '/runtime',
    versionDir: '/runtime/0.2.0',
    venvDir: '/runtime/0.2.0/.venv',
    manifestPath: '/runtime/0.2.0/manifest.json',
    installLogPath: '/runtime/0.2.0/install.log',
    assetDir: '/assets/python',
    assetManifestPath: '/assets/python/manifest.json',
    pythonPath: '/runtime/0.2.0/.venv/bin/python',
    daemonPath: '/runtime/0.2.0/.venv/bin/ktx-daemon',
  };
}

function manifest(features: KtxRuntimeFeature[] = ['core']): InstalledKtxRuntimeManifest {
  return {
    schemaVersion: 1,
    cliVersion: '0.2.0',
    installedAt: '2026-05-11T00:00:00.000Z',
    asset: {
      schemaVersion: 1,
      distributionName: 'kaelio-ktx',
      normalizedName: 'kaelio_ktx',
      version: '0.2.0',
      wheel: {
        file: 'kaelio_ktx-0.2.0-py3-none-any.whl',
        sha256: 'a'.repeat(64),
        bytes: 123,
      },
    },
    features,
    python: {
      executable: '/runtime/0.2.0/.venv/bin/python',
      daemonExecutable: '/runtime/0.2.0/.venv/bin/ktx-daemon',
    },
    installLog: '/runtime/0.2.0/install.log',
  };
}

function readyStatus(features: KtxRuntimeFeature[] = ['core']): ManagedPythonRuntimeStatus {
  return {
    kind: 'ready',
    detail: 'Runtime ready at /runtime/0.2.0',
    layout: layout(),
    manifest: manifest(features),
  };
}

function missingStatus(): ManagedPythonRuntimeStatus {
  return {
    kind: 'missing',
    detail: 'No runtime manifest at /runtime/0.2.0/manifest.json',
    layout: layout(),
  };
}

function installResult(features: KtxRuntimeFeature[] = ['core']): ManagedPythonRuntimeInstallResult {
  const installedManifest = manifest(features);
  return {
    status: 'installed',
    layout: layout(),
    asset: {
      manifest: installedManifest.asset,
      wheelPath: '/assets/python/kaelio_ktx-0.2.0-py3-none-any.whl',
      requiresPython: { specifier: '>=3.13', minimumVersion: '3.13' },
    },
    manifest: installedManifest,
  };
}

function makeSpinnerEvents() {
  const events: string[] = [];
  const spinner = vi.fn(() => ({
    start: (msg: string) => events.push(`start:${msg}`),
    message: (msg: string) => events.push(`message:${msg}`),
    stop: (msg: string) => events.push(`stop:${msg}`),
    error: (msg: string) => events.push(`error:${msg}`),
  }));
  return { events, spinner };
}

describe('managedRuntimeInstallCommand', () => {
  it('prints the exact command for each managed runtime feature', () => {
    expect(managedRuntimeInstallCommand('core')).toBe('ktx admin runtime install --yes');
    expect(managedRuntimeInstallCommand('local-embeddings')).toBe(
      'ktx admin runtime install --feature local-embeddings --yes',
    );
  });
});

describe('runtimeInstallPolicyFromFlags', () => {
  it('maps command flags to managed runtime install policies', () => {
    expect(runtimeInstallPolicyFromFlags({})).toBe('prompt');
    expect(runtimeInstallPolicyFromFlags({ yes: false })).toBe('prompt');
    expect(runtimeInstallPolicyFromFlags({ yes: true })).toBe('auto');
    expect(runtimeInstallPolicyFromFlags({ input: false })).toBe('never');
  });

  it('rejects conflicting runtime install flags', () => {
    expect(() => runtimeInstallPolicyFromFlags({ yes: true, input: false })).toThrow(
      'Choose only one runtime install mode: --yes or --no-input',
    );
  });
});

describe('createManagedPythonSemanticLayerComputePort', () => {
  it('uses non-animated runtime setup status by default', async () => {
    const io = makeIo();

    await expect(
      ensureManagedPythonCommandRuntime({
        cliVersion: '0.2.0',
        installPolicy: 'auto',
        io: io.io,
        readStatus: vi.fn(async () => missingStatus()),
        installRuntime: vi.fn(async () => installResult(['local-embeddings'])),
        feature: 'local-embeddings',
      }),
    ).resolves.toMatchObject({
      layout: { versionDir: '/runtime/0.2.0' },
    });

    expect(io.stderr()).toContain('Installing ktx Python runtime (local-embeddings) with uv...');
    expect(io.stderr()).toContain('ktx Python runtime ready: /runtime/0.2.0');
    expect(io.stderr().match(/Installing ktx Python runtime/g)).toHaveLength(1);
  });

  it('shows runtime installation progress with the CLI spinner', async () => {
    const io = makeIo();
    const { events, spinner } = makeSpinnerEvents();

    const options = {
      cliVersion: '0.2.0',
      installPolicy: 'auto' as const,
      io: io.io,
      readStatus: vi.fn(async () => missingStatus()),
      installRuntime: vi.fn(async () => installResult(['local-embeddings'])),
      feature: 'local-embeddings' as const,
      spinner,
    };

    await expect(ensureManagedPythonCommandRuntime(options)).resolves.toMatchObject({
      layout: { versionDir: '/runtime/0.2.0' },
    });

    expect(events).toEqual([
      'start:Installing ktx Python runtime (local-embeddings) with uv...',
      'stop:ktx Python runtime ready: /runtime/0.2.0',
    ]);
  });

  it('uses the managed ktx-daemon executable when the runtime is ready', async () => {
    const io = makeIo();
    const compute = { query: vi.fn(), validateSources: vi.fn(), generateSources: vi.fn() };
    const createPythonCompute = vi.fn(() => compute);

    await expect(
      createManagedPythonSemanticLayerComputePort({
        cliVersion: '0.2.0',
        installPolicy: 'never',
        io: io.io,
        readStatus: vi.fn(async () => readyStatus()),
        installRuntime: vi.fn(),
        createPythonCompute,
      }),
    ).resolves.toBe(compute);

    expect(createPythonCompute).toHaveBeenCalledWith({
      command: '/runtime/0.2.0/.venv/bin/ktx-daemon',
      args: [],
    });
    expect(io.stderr()).toBe('');
  });

  it('fails with a preparation command when input is disabled and the runtime is missing', async () => {
    const io = makeIo();
    const installRuntime = vi.fn();

    await expect(
      createManagedPythonSemanticLayerComputePort({
        cliVersion: '0.2.0',
        installPolicy: 'never',
        io: io.io,
        readStatus: vi.fn(async () => missingStatus()),
        installRuntime,
      }),
    ).rejects.toThrow('ktx Python runtime is required for this command. Run: ktx admin runtime install --yes');

    expect(installRuntime).not.toHaveBeenCalled();
  });

  it('installs the core runtime without prompting when policy is auto', async () => {
    const io = makeIo();
    const { events, spinner } = makeSpinnerEvents();
    const compute = { query: vi.fn(), validateSources: vi.fn(), generateSources: vi.fn() };
    const createPythonCompute = vi.fn(() => compute);
    const installRuntime = vi.fn(async () => installResult());

    await expect(
      createManagedPythonSemanticLayerComputePort({
        cliVersion: '0.2.0',
        installPolicy: 'auto',
        io: io.io,
        readStatus: vi.fn(async () => missingStatus()),
        installRuntime,
        createPythonCompute,
        spinner,
      }),
    ).resolves.toBe(compute);

    expect(installRuntime).toHaveBeenCalledWith({
      cliVersion: '0.2.0',
      features: ['core'],
      force: false,
    });
    expect(events).toEqual([
      'start:Installing ktx Python runtime (core) with uv...',
      'stop:ktx Python runtime ready: /runtime/0.2.0',
    ]);
  });

  it('prompts before installing when policy is prompt', async () => {
    const io = makeIo();
    const { events, spinner } = makeSpinnerEvents();
    const confirmInstall = vi.fn(async () => true);
    const installRuntime = vi.fn(async () => installResult());

    await createManagedPythonSemanticLayerComputePort({
      cliVersion: '0.2.0',
      installPolicy: 'prompt',
      io: io.io,
      readStatus: vi.fn(async () => missingStatus()),
      installRuntime,
      createPythonCompute: vi.fn(() => ({ query: vi.fn(), validateSources: vi.fn(), generateSources: vi.fn() })),
      confirmInstall,
      spinner,
    });

    expect(confirmInstall).toHaveBeenCalledWith(
      'ktx needs to install the core Python runtime. This downloads a pinned, checksum-verified uv build, Python, and dependencies. Continue?',
      io.io,
    );
    expect(installRuntime).toHaveBeenCalledWith({
      cliVersion: '0.2.0',
      features: ['core'],
      force: false,
    });
    expect(events).toContainEqual('start:Installing ktx Python runtime (core) with uv...');
  });

  it('uses injected runtime confirmation instead of reading process TTY directly', async () => {
    const io = makeIo();
    const { events, spinner } = makeSpinnerEvents();
    const compute = { query: vi.fn(), validateSources: vi.fn(), generateSources: vi.fn() };
    const installRuntime = vi.fn(async (): Promise<ManagedPythonRuntimeInstallResult> => installResult());
    const confirmInstall = vi.fn(async () => true);

    await expect(
      createManagedPythonSemanticLayerComputePort({
        cliVersion: '0.2.0',
        installPolicy: 'prompt',
        io: io.io,
        readStatus: async () => missingStatus(),
        installRuntime,
        confirmInstall,
        createPythonCompute: () => compute,
        spinner,
      }),
    ).resolves.toBe(compute);

    expect(confirmInstall).toHaveBeenCalledWith(
      'ktx needs to install the core Python runtime. This downloads a pinned, checksum-verified uv build, Python, and dependencies. Continue?',
      io.io,
    );
    expect(events).toContainEqual('start:Installing ktx Python runtime (core) with uv...');
  });

  it('can decide default runtime prompting from injected io capabilities', async () => {
    const io = makeIo();
    Object.assign(io.io.stdout, { isTTY: false });

    await expect(
      createManagedPythonSemanticLayerComputePort({
        cliVersion: '0.2.0',
        installPolicy: 'prompt',
        io: io.io,
        readStatus: async () => missingStatus(),
        installRuntime: vi.fn(),
        createPythonCompute: () => ({ query: vi.fn(), validateSources: vi.fn(), generateSources: vi.fn() }),
      }),
    ).rejects.toThrow('ktx Python runtime installation was cancelled');
  });
});

describe('createLazyManagedPythonSemanticLayerComputePort', () => {
  it('does not touch the managed runtime at construction, so a server starts without uv', async () => {
    const io = makeIo();
    const readStatus = vi.fn(async () => missingStatus());
    const installRuntime = vi.fn(async (): Promise<ManagedPythonRuntimeInstallResult> => {
      throw new KtxExpectedError('uv missing');
    });
    const createPythonCompute = vi.fn(() => ({ query: vi.fn(), validateSources: vi.fn(), generateSources: vi.fn() }));

    const port = createLazyManagedPythonSemanticLayerComputePort({
      cliVersion: '0.2.0',
      installPolicy: 'auto',
      io: io.io,
      readStatus,
      installRuntime,
      createPythonCompute,
    });

    expect(readStatus).not.toHaveBeenCalled();
    expect(installRuntime).not.toHaveBeenCalled();
    expect(createPythonCompute).not.toHaveBeenCalled();

    await expect(port.query({ sources: [], query: {} as never, dialect: 'postgres' })).rejects.toBeInstanceOf(
      KtxExpectedError,
    );
    expect(installRuntime).toHaveBeenCalledTimes(1);
  });

  it('resolves the runtime once and reuses it across calls', async () => {
    const io = makeIo();
    const readStatus = vi.fn(async () => readyStatus());
    const compute = {
      query: vi.fn(),
      validateSources: vi.fn(),
      generateSources: vi.fn(),
    };
    const createPythonCompute = vi.fn(() => compute);

    const port = createLazyManagedPythonSemanticLayerComputePort({
      cliVersion: '0.2.0',
      installPolicy: 'never',
      io: io.io,
      readStatus,
      installRuntime: vi.fn(),
      createPythonCompute,
    });

    await port.query({ sources: [], query: {} as never, dialect: 'postgres' });
    await port.validateSources({ sources: [], dialect: 'postgres' });

    expect(readStatus).toHaveBeenCalledTimes(1);
    expect(createPythonCompute).toHaveBeenCalledTimes(1);
    expect(compute.query).toHaveBeenCalledTimes(1);
    expect(compute.validateSources).toHaveBeenCalledTimes(1);
  });

  it('retries the runtime resolution after a failed attempt', async () => {
    const io = makeIo();
    const compute = {
      query: vi.fn(),
      validateSources: vi.fn(),
      generateSources: vi.fn(),
    };
    const createPythonCompute = vi.fn(() => compute);
    let attempt = 0;
    const installRuntime = vi.fn(async (): Promise<ManagedPythonRuntimeInstallResult> => {
      attempt += 1;
      if (attempt === 1) {
        throw new KtxExpectedError('uv missing');
      }
      return installResult();
    });

    const port = createLazyManagedPythonSemanticLayerComputePort({
      cliVersion: '0.2.0',
      installPolicy: 'auto',
      io: io.io,
      readStatus: vi.fn(async () => missingStatus()),
      installRuntime,
      createPythonCompute,
    });

    await expect(port.query({ sources: [], query: {} as never, dialect: 'postgres' })).rejects.toBeInstanceOf(
      KtxExpectedError,
    );
    await port.query({ sources: [], query: {} as never, dialect: 'postgres' });

    expect(installRuntime).toHaveBeenCalledTimes(2);
    expect(compute.query).toHaveBeenCalledTimes(1);
  });
});
