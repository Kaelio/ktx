import { createPythonSemanticLayerComputePort, type KtxSemanticLayerComputePort } from './context/daemon/semantic-layer-compute.js';
import type { KtxCliIo } from './cli-runtime.js';
import { createClackPromptAdapter, createCliSpinner, type KtxCliSpinner } from './clack.js';
import {
  installManagedPythonRuntime,
  readManagedPythonRuntimeStatus,
  type InstalledKtxRuntimeManifest,
  type KtxRuntimeFeature,
  type ManagedPythonRuntimeInstallOptions,
  type ManagedPythonRuntimeInstallResult,
  type ManagedPythonRuntimeLayout,
  type ManagedPythonRuntimeLayoutOptions,
  type ManagedPythonRuntimeStatus,
} from './managed-python-runtime.js';
import { readExistingTelemetryProjectId } from './telemetry/identity.js';

export type KtxManagedPythonInstallPolicy = 'prompt' | 'auto' | 'never';

export function runtimeInstallPolicyFromFlags(options: {
  yes?: boolean;
  input?: boolean;
}): KtxManagedPythonInstallPolicy {
  if (options.yes === true && options.input === false) {
    throw new Error('Choose only one runtime install mode: --yes or --no-input');
  }
  if (options.yes === true) {
    return 'auto';
  }
  return options.input === false ? 'never' : 'prompt';
}

export interface ManagedPythonCommandRuntime {
  layout: ManagedPythonRuntimeLayout;
  manifest: InstalledKtxRuntimeManifest;
}

interface ManagedPythonCommandDeps {
  readStatus?: (options: ManagedPythonRuntimeLayoutOptions) => Promise<ManagedPythonRuntimeStatus>;
  installRuntime?: (options: ManagedPythonRuntimeInstallOptions) => Promise<ManagedPythonRuntimeInstallResult>;
  confirmInstall?: (message: string, io: KtxCliIo) => Promise<boolean>;
  spinner?: () => KtxCliSpinner;
}

export interface ManagedPythonCommandOptions extends ManagedPythonCommandDeps {
  cliVersion: string;
  installPolicy: KtxManagedPythonInstallPolicy;
  io: KtxCliIo;
  feature?: KtxRuntimeFeature;
}

export interface ManagedPythonSemanticLayerComputeOptions extends ManagedPythonCommandOptions {
  createPythonCompute?: typeof createPythonSemanticLayerComputePort;
  projectDir?: string;
}

/** @internal */
export function managedRuntimeInstallCommand(feature: KtxRuntimeFeature): string {
  return feature === 'local-embeddings'
    ? 'ktx admin runtime install --feature local-embeddings --yes'
    : 'ktx admin runtime install --yes';
}

function installPrompt(feature: KtxRuntimeFeature): string {
  const label = feature === 'local-embeddings' ? 'local embeddings Python runtime' : 'core Python runtime';
  return `ktx needs to install the ${label}. This downloads Python dependencies with uv. Continue?`;
}

function runtimeRequiredMessage(feature: KtxRuntimeFeature): string {
  return `ktx Python runtime is required for this command. Run: ${managedRuntimeInstallCommand(feature)}`;
}

function hasFeature(manifest: InstalledKtxRuntimeManifest, feature: KtxRuntimeFeature): boolean {
  return manifest.features.includes(feature);
}

async function defaultConfirmInstall(message: string, io: KtxCliIo): Promise<boolean> {
  if (io.stdout.isTTY !== true) {
    return false;
  }
  const prompts = createClackPromptAdapter();
  return await prompts.confirm({ message, initialValue: true });
}

export async function ensureManagedPythonCommandRuntime(
  options: ManagedPythonCommandOptions,
): Promise<ManagedPythonCommandRuntime> {
  const feature = options.feature ?? 'core';
  const readStatus = options.readStatus ?? readManagedPythonRuntimeStatus;
  const installRuntime = options.installRuntime ?? installManagedPythonRuntime;
  const status = await readStatus({ cliVersion: options.cliVersion });

  if (status.kind === 'ready' && status.manifest && hasFeature(status.manifest, feature)) {
    return { layout: status.layout, manifest: status.manifest };
  }

  if (options.installPolicy === 'never') {
    throw new Error(runtimeRequiredMessage(feature));
  }

  if (options.installPolicy === 'prompt') {
    const confirmInstall = options.confirmInstall ?? defaultConfirmInstall;
    const confirmed = await confirmInstall(installPrompt(feature), options.io);
    if (!confirmed) {
      throw new Error(`ktx Python runtime installation was cancelled. Run: ${managedRuntimeInstallCommand(feature)}`);
    }
  }

  const progress = (options.spinner ?? (() => createCliSpinner(options.io)))();
  progress.start(`Installing ktx Python runtime (${feature}) with uv...`);
  try {
    const installed = await installRuntime({
      cliVersion: options.cliVersion,
      features: [feature],
      force: false,
    });
    progress.stop(`ktx Python runtime ready: ${installed.layout.versionDir}`);
    return { layout: installed.layout, manifest: installed.manifest };
  } catch (error) {
    progress.error(`ktx Python runtime install failed: ${error instanceof Error ? error.message : String(error)}`);
    throw error;
  }
}

export function createManagedPythonSemanticLayerComputePort(
  options: ManagedPythonSemanticLayerComputeOptions,
): KtxSemanticLayerComputePort {
  const createPythonCompute = options.createPythonCompute ?? createPythonSemanticLayerComputePort;
  let cachedPort: KtxSemanticLayerComputePort | undefined;

  // Runtime install is deferred to the first compute call so an MCP session
  // that only searches never installs the Python runtime at boot. Cached on
  // success, so a failed install retries on the next call.
  const resolvePort = async (): Promise<KtxSemanticLayerComputePort> => {
    if (cachedPort) {
      return cachedPort;
    }
    const runtime = await ensureManagedPythonCommandRuntime({
      cliVersion: options.cliVersion,
      installPolicy: options.installPolicy,
      io: options.io,
      feature: 'core',
      ...(options.readStatus ? { readStatus: options.readStatus } : {}),
      ...(options.installRuntime ? { installRuntime: options.installRuntime } : {}),
      ...(options.confirmInstall ? { confirmInstall: options.confirmInstall } : {}),
      ...(options.spinner ? { spinner: options.spinner } : {}),
    });
    const projectId = options.projectDir
      ? await readExistingTelemetryProjectId({ projectDir: options.projectDir })
      : undefined;
    cachedPort = createPythonCompute({
      command: runtime.manifest.python.daemonExecutable,
      args: [],
      ...(projectId ? { projectId } : {}),
    });
    return cachedPort;
  };

  return {
    query: async (input) => (await resolvePort()).query(input),
    validateSources: async (input) => (await resolvePort()).validateSources(input),
    generateSources: async (input) => (await resolvePort()).generateSources(input),
  };
}
