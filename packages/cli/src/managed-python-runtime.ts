import { execFile } from 'node:child_process';
import { createHash } from 'node:crypto';
import { access, appendFile, chmod, mkdir, readFile, rename, rm, writeFile } from 'node:fs/promises';
import { homedir } from 'node:os';
import { basename, dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { promisify } from 'node:util';
import { gunzipSync, strFromU8, unzipSync } from 'fflate';
import { z } from 'zod';
import { KtxExpectedError } from './errors.js';
import {
  MANAGED_UV_ARTIFACTS,
  MANAGED_UV_VERSION,
  type ManagedUvArtifact,
  type ManagedUvPlatformKey,
} from './managed-uv-release.js';

const execFileAsync = promisify(execFile);

export const runtimeFeatureSchema = z.enum(['core', 'local-embeddings']);
export type KtxRuntimeFeature = z.infer<typeof runtimeFeatureSchema>;

const runtimeAssetManifestSchema = z.object({
  schemaVersion: z.literal(1),
  distributionName: z.literal('kaelio-ktx'),
  normalizedName: z.literal('kaelio_ktx'),
  version: z.string().min(1),
  wheel: z.object({
    file: z.string().min(1),
    sha256: z.string().regex(/^[a-f0-9]{64}$/),
    bytes: z.number().int().nonnegative(),
  }),
});

type KtxRuntimeAssetManifest = z.infer<typeof runtimeAssetManifestSchema>;

const installedRuntimeManifestSchema = z.object({
  schemaVersion: z.literal(1),
  cliVersion: z.string().min(1),
  installedAt: z.string().min(1),
  asset: runtimeAssetManifestSchema,
  features: z.array(runtimeFeatureSchema).min(1),
  python: z.object({
    executable: z.string().min(1),
    daemonExecutable: z.string().min(1),
  }),
  installLog: z.string().min(1),
});

export type InstalledKtxRuntimeManifest = z.infer<typeof installedRuntimeManifestSchema>;

export interface ManagedPythonRuntimeLayoutOptions {
  cliVersion: string;
  platform?: NodeJS.Platform;
  env?: NodeJS.ProcessEnv;
  homeDir?: string;
  runtimeRoot?: string;
  assetDir?: string;
}

export interface ManagedPythonRuntimeLayout {
  cliVersion: string;
  runtimeRoot: string;
  versionDir: string;
  venvDir: string;
  manifestPath: string;
  installLogPath: string;
  assetDir: string;
  assetManifestPath: string;
  pythonPath: string;
  daemonPath: string;
}

export interface ManagedPythonDaemonLayoutOptions extends ManagedPythonRuntimeLayoutOptions {
  projectDir: string;
}

export interface ManagedPythonDaemonLayout extends ManagedPythonRuntimeLayout {
  projectDir: string;
  daemonStateDir: string;
  daemonStatePath: string;
  daemonStdoutPath: string;
  daemonStderrPath: string;
}

/** @internal */
export interface ManagedRuntimeAsset {
  manifest: KtxRuntimeAssetManifest;
  wheelPath: string;
  requiresPython: {
    specifier: string;
    minimumVersion: string;
  };
}

export type ManagedPythonRuntimeExec = (
  command: string,
  args: string[],
  options?: { cwd?: string; env?: NodeJS.ProcessEnv },
) => Promise<{ stdout: string; stderr: string }>;

export interface ManagedPythonRuntimeInstallOptions extends ManagedPythonRuntimeLayoutOptions {
  features: KtxRuntimeFeature[];
  force?: boolean;
  exec?: ManagedPythonRuntimeExec;
  fetchUvArtifact?: ManagedUvFetchArtifact;
}

export interface ManagedPythonRuntimeInstallResult {
  status: 'ready' | 'installed';
  layout: ManagedPythonRuntimeLayout;
  asset: ManagedRuntimeAsset;
  manifest: InstalledKtxRuntimeManifest;
}

type ManagedPythonRuntimeStatusKind = 'missing' | 'ready' | 'mismatched' | 'broken';

export interface ManagedPythonRuntimeStatus {
  kind: ManagedPythonRuntimeStatusKind;
  detail: string;
  layout: ManagedPythonRuntimeLayout;
  manifest?: InstalledKtxRuntimeManifest;
}

export interface ManagedPythonRuntimeDoctorCheck {
  id: 'uv' | 'asset' | 'runtime';
  label: string;
  status: 'pass' | 'fail';
  detail: string;
  fix?: string;
}

export type ManagedUvFetchArtifact = (url: string) => Promise<Uint8Array>;

/** @internal */
export interface ManagedUvRelease {
  version: string;
  artifacts: Partial<Record<ManagedUvPlatformKey, ManagedUvArtifact>>;
}

const PINNED_UV_RELEASE: ManagedUvRelease = {
  version: MANAGED_UV_VERSION,
  artifacts: MANAGED_UV_ARTIFACTS,
};

/** @internal */
export interface EnsureManagedUvOptions {
  platform?: NodeJS.Platform;
  arch?: string;
  env?: NodeJS.ProcessEnv;
  homeDir?: string;
  runtimeRoot?: string;
  fetchArtifact?: ManagedUvFetchArtifact;
  release?: ManagedUvRelease;
}

function defaultAssetDir(): string {
  return fileURLToPath(new URL('../assets/python/', import.meta.url));
}

function runtimeRootFor(input: { env: NodeJS.ProcessEnv; homeDir: string }): string {
  if (input.env.KTX_RUNTIME_ROOT) {
    return input.env.KTX_RUNTIME_ROOT;
  }
  return join(input.homeDir, '.ktx', 'runtime');
}

function executablePath(venvDir: string, platform: NodeJS.Platform, name: string): string {
  if (platform === 'win32') {
    return join(venvDir, 'Scripts', `${name}.exe`);
  }
  return join(venvDir, 'bin', name);
}

/** @internal */
export function managedPythonRuntimeLayout(options: ManagedPythonRuntimeLayoutOptions): ManagedPythonRuntimeLayout {
  const platform = options.platform ?? process.platform;
  const env = options.env ?? process.env;
  const homeDir = options.homeDir ?? homedir();
  const runtimeRoot = options.runtimeRoot ?? runtimeRootFor({ env, homeDir });
  const versionDir = join(runtimeRoot, options.cliVersion);
  const venvDir = join(versionDir, '.venv');
  const assetDir = options.assetDir ?? defaultAssetDir();

  return {
    cliVersion: options.cliVersion,
    runtimeRoot,
    versionDir,
    venvDir,
    manifestPath: join(versionDir, 'manifest.json'),
    installLogPath: join(versionDir, 'install.log'),
    assetDir,
    assetManifestPath: join(assetDir, 'manifest.json'),
    pythonPath: executablePath(venvDir, platform, 'python'),
    daemonPath: executablePath(venvDir, platform, 'ktx-daemon'),
  };
}

export function managedPythonDaemonLayout(options: ManagedPythonDaemonLayoutOptions): ManagedPythonDaemonLayout {
  const runtime = managedPythonRuntimeLayout(options);
  const daemonStateDir = join(options.projectDir, '.ktx', 'runtime');
  return {
    ...runtime,
    projectDir: options.projectDir,
    daemonStateDir,
    daemonStatePath: join(daemonStateDir, 'daemon.json'),
    daemonStdoutPath: join(daemonStateDir, 'daemon.stdout.log'),
    daemonStderrPath: join(daemonStateDir, 'daemon.stderr.log'),
  };
}

async function pathExists(path: string): Promise<boolean> {
  try {
    await access(path);
    return true;
  } catch {
    return false;
  }
}

function assertSafeWheelFilename(file: string): void {
  if (file !== basename(file) || file.includes('/') || file.includes('\\')) {
    throw new Error(`Unsafe runtime wheel filename in bundled manifest: ${file}`);
  }
}

async function readJsonFile(path: string): Promise<unknown> {
  return JSON.parse(await readFile(path, 'utf8')) as unknown;
}

function isErrnoException(error: unknown, code: string): boolean {
  return typeof error === 'object' && error !== null && 'code' in error && error.code === code;
}

function parseRequiresPythonFromWheel(input: { wheelPath: string; contents: Buffer }): ManagedRuntimeAsset['requiresPython'] {
  let files: Record<string, Uint8Array>;
  try {
    files = unzipSync(new Uint8Array(input.contents));
  } catch (error) {
    throw new Error(
      `Unable to read bundled Python runtime wheel metadata: ${error instanceof Error ? error.message : String(error)}`,
    );
  }
  const metadataEntry = Object.entries(files).find(([path]) => path.endsWith('.dist-info/METADATA'));
  if (!metadataEntry) {
    throw new Error(`Bundled Python runtime wheel metadata is missing: ${input.wheelPath}`);
  }

  const metadata = strFromU8(metadataEntry[1]);
  const requiresPython = metadata
    .split(/\r?\n/)
    .map((line) => line.match(/^Requires-Python:\s*(.+)\s*$/i)?.[1]?.trim())
    .find((value): value is string => typeof value === 'string' && value.length > 0);
  if (!requiresPython) {
    throw new Error('Bundled Python runtime wheel metadata is missing Requires-Python');
  }

  const minimumMatch = requiresPython.match(/(?:^|[,\s])>=\s*([0-9]+)\.([0-9]+)(?:\.[0-9]+)?\b/);
  if (!minimumMatch) {
    throw new Error(`Unsupported bundled Python runtime Requires-Python: ${requiresPython}`);
  }

  return {
    specifier: requiresPython,
    minimumVersion: `${minimumMatch[1]}.${minimumMatch[2]}`,
  };
}

/** @internal */
export async function verifyRuntimeAsset(input: { assetDir: string }): Promise<ManagedRuntimeAsset> {
  const manifestPath = join(input.assetDir, 'manifest.json');
  let manifestData: unknown;
  try {
    manifestData = await readJsonFile(manifestPath);
  } catch (error) {
    if (isErrnoException(error, 'ENOENT')) {
      throw new Error(
        [
          `Missing bundled Python runtime manifest: ${manifestPath}`,
          'In a source checkout, build the local runtime assets with: pnpm run artifacts:build',
          'Then retry the runtime-backed ktx command.',
        ].join('\n'),
      );
    }
    throw error;
  }
  const manifest = runtimeAssetManifestSchema.parse(manifestData);
  assertSafeWheelFilename(manifest.wheel.file);
  const wheelPath = join(input.assetDir, manifest.wheel.file);
  const wheel = await readFile(wheelPath);
  const sha256 = createHash('sha256').update(wheel).digest('hex');
  if (sha256 !== manifest.wheel.sha256 || wheel.byteLength !== manifest.wheel.bytes) {
    throw new Error(`Bundled Python runtime wheel checksum mismatch: ${wheelPath}`);
  }
  return { manifest, wheelPath, requiresPython: parseRequiresPythonFromWheel({ wheelPath, contents: wheel }) };
}

function normalizeFeatures(features: KtxRuntimeFeature[]): KtxRuntimeFeature[] {
  const requested = new Set<KtxRuntimeFeature>(['core', ...features]);
  return runtimeFeatureSchema.options.filter((feature) => requested.has(feature));
}

async function readInstalledManifest(path: string): Promise<InstalledKtxRuntimeManifest | undefined> {
  if (!(await pathExists(path))) {
    return undefined;
  }
  return installedRuntimeManifestSchema.parse(await readJsonFile(path));
}

function hasFeatures(manifest: InstalledKtxRuntimeManifest, features: KtxRuntimeFeature[]): boolean {
  return normalizeFeatures(features).every((feature) => manifest.features.includes(feature));
}

async function defaultExec(
  command: string,
  args: string[],
  options: { cwd?: string; env?: NodeJS.ProcessEnv } = {},
): Promise<{ stdout: string; stderr: string }> {
  const result = await execFileAsync(command, args, {
    cwd: options.cwd,
    env: options.env,
    encoding: 'utf8',
    maxBuffer: 1024 * 1024 * 20,
  });
  return { stdout: result.stdout, stderr: result.stderr };
}

function errorOutput(error: unknown): { stdout: string; stderr: string } {
  const value = error as { stdout?: unknown; stderr?: unknown };
  return {
    stdout: typeof value.stdout === 'string' ? value.stdout : '',
    stderr: typeof value.stderr === 'string' ? value.stderr : '',
  };
}

function installFailureMessage(input: { logPath: string; stdout: string; stderr: string }): string {
  const output = [input.stderr.trim(), input.stdout.trim()].filter((part) => part.length > 0).join('\n');
  if (!output) {
    return `Python runtime install failed. Install log: ${input.logPath}`;
  }
  return `Python runtime install failed.\n${output}\nInstall log: ${input.logPath}`;
}

async function runLogged(input: {
  exec: ManagedPythonRuntimeExec;
  logPath: string;
  command: string;
  args: string[];
  cwd?: string;
  env?: NodeJS.ProcessEnv;
}): Promise<{ stdout: string; stderr: string }> {
  await appendFile(input.logPath, `$ ${input.command} ${input.args.join(' ')}\n`);
  try {
    const result = await input.exec(input.command, input.args, { cwd: input.cwd, env: input.env });
    if (result.stdout) {
      await appendFile(input.logPath, result.stdout.endsWith('\n') ? result.stdout : `${result.stdout}\n`);
    }
    if (result.stderr) {
      await appendFile(input.logPath, result.stderr.endsWith('\n') ? result.stderr : `${result.stderr}\n`);
    }
    return result;
  } catch (error) {
    const output = errorOutput(error);
    if (output.stdout) {
      await appendFile(input.logPath, output.stdout.endsWith('\n') ? output.stdout : `${output.stdout}\n`);
    }
    if (output.stderr) {
      await appendFile(input.logPath, output.stderr.endsWith('\n') ? output.stderr : `${output.stderr}\n`);
    }
    throw new Error(installFailureMessage({ logPath: input.logPath, stdout: output.stdout, stderr: output.stderr }));
  }
}

function managedRuntimeUvEnv(baseEnv: NodeJS.ProcessEnv): NodeJS.ProcessEnv {
  return { ...baseEnv, UV_NO_CONFIG: '1' };
}

function managedUvBinaryName(platform: NodeJS.Platform): string {
  return platform === 'win32' ? 'uv.exe' : 'uv';
}

/** @internal */
export function managedUvPath(options: EnsureManagedUvOptions = {}): string {
  const platform = options.platform ?? process.platform;
  const env = options.env ?? process.env;
  const homeDir = options.homeDir ?? homedir();
  const runtimeRoot = options.runtimeRoot ?? runtimeRootFor({ env, homeDir });
  const version = (options.release ?? PINNED_UV_RELEASE).version;
  return join(runtimeRoot, 'uv', version, managedUvBinaryName(platform));
}

async function defaultFetchUvArtifact(url: string): Promise<Uint8Array> {
  const response = await fetch(url);
  if (!response.ok) {
    throw new Error(`HTTP ${response.status}`);
  }
  return new Uint8Array(await response.arrayBuffer());
}

function readTarField(block: Uint8Array, start: number, length: number): string {
  const field = block.subarray(start, start + length);
  const end = field.indexOf(0);
  return strFromU8(end < 0 ? field : field.subarray(0, end));
}

function findTarEntry(archive: Uint8Array, matches: (name: string) => boolean): Uint8Array | undefined {
  let offset = 0;
  while (offset + 512 <= archive.length) {
    const block = archive.subarray(offset, offset + 512);
    const name = readTarField(block, 0, 100);
    if (!name) {
      return undefined;
    }
    const size = Number.parseInt(readTarField(block, 124, 12).trim() || '0', 8);
    if (matches(name)) {
      return archive.subarray(offset + 512, offset + 512 + size);
    }
    offset += 512 + Math.ceil(size / 512) * 512;
  }
  return undefined;
}

function extractUvFromArchive(input: { file: string; contents: Uint8Array; binaryName: string }): Uint8Array {
  const entry = input.file.endsWith('.zip')
    ? unzipSync(input.contents)[input.binaryName]
    : findTarEntry(gunzipSync(input.contents), (name) => name === input.binaryName || name.endsWith(`/${input.binaryName}`));
  if (!entry) {
    throw new Error(`uv archive ${input.file} is missing the ${input.binaryName} binary`);
  }
  return entry;
}

/**
 * ktx provisions its own pinned uv under the runtime root; uv on PATH is never
 * consulted, so runtime installs behave identically on every machine. All
 * failures here are environment outcomes (offline host, intercepting proxy,
 * unsupported platform) and stay out of Error Tracking via KtxExpectedError —
 * except a pin/layout mismatch inside a checksum-verified archive, which is a
 * ktx release fault and must reach Error Tracking.
 * @internal
 */
export async function ensureManagedUv(options: EnsureManagedUvOptions = {}): Promise<string> {
  const platform = options.platform ?? process.platform;
  const arch = options.arch ?? process.arch;
  const release = options.release ?? PINNED_UV_RELEASE;
  const binaryName = managedUvBinaryName(platform);
  const uvPath = managedUvPath(options);
  if (await pathExists(uvPath)) {
    return uvPath;
  }

  const artifact = release.artifacts[`${platform}-${arch}` as ManagedUvPlatformKey];
  if (!artifact) {
    throw new KtxExpectedError(
      `ktx does not bundle uv for ${platform}-${arch}. Place a uv ${release.version} binary at ${uvPath} and retry: ktx admin runtime install --yes`,
    );
  }

  const url = `https://github.com/astral-sh/uv/releases/download/${release.version}/${artifact.file}`;
  let contents: Uint8Array;
  try {
    contents = await (options.fetchArtifact ?? defaultFetchUvArtifact)(url);
  } catch (error) {
    throw new KtxExpectedError(
      `ktx could not download uv ${release.version} (required to install the ktx Python runtime). ` +
        'Check network access to github.com and retry: ktx admin runtime install --yes. ' +
        `Air-gapped hosts: place the uv binary at ${uvPath}.`,
      { cause: error },
    );
  }

  const sha256 = createHash('sha256').update(contents).digest('hex');
  if (sha256 !== artifact.sha256) {
    throw new KtxExpectedError(
      `Downloaded uv ${release.version} failed checksum verification (a proxy or captive portal may have altered the download). Retry: ktx admin runtime install --yes`,
    );
  }

  const binary = extractUvFromArchive({ file: artifact.file, contents, binaryName });
  await mkdir(dirname(uvPath), { recursive: true });
  const stagedPath = `${uvPath}.${process.pid}.download`;
  await writeFile(stagedPath, binary);
  await chmod(stagedPath, 0o755);
  try {
    await rename(stagedPath, uvPath);
  } catch (error) {
    // On Windows a concurrent install may have won the rename; the binary at
    // uvPath is checksum-pinned identical, so reuse it.
    await rm(stagedPath, { force: true });
    if (!(await pathExists(uvPath))) {
      throw error;
    }
  }
  return uvPath;
}

async function ensureUv(input: {
  exec: ManagedPythonRuntimeExec;
  uvEnv: NodeJS.ProcessEnv;
  options: ManagedPythonRuntimeLayoutOptions & { fetchUvArtifact?: ManagedUvFetchArtifact };
}): Promise<{ uvPath: string; version: string }> {
  const uvPath = await ensureManagedUv({
    platform: input.options.platform,
    env: input.options.env,
    homeDir: input.options.homeDir,
    runtimeRoot: input.options.runtimeRoot,
    fetchArtifact: input.options.fetchUvArtifact,
  });
  try {
    const result = await input.exec(uvPath, ['--version'], { env: input.uvEnv });
    return { uvPath, version: result.stdout.trim() || `uv ${MANAGED_UV_VERSION}` };
  } catch (error) {
    throw new KtxExpectedError(
      `Managed uv at ${uvPath} failed to run. Delete it and retry: ktx admin runtime install --yes`,
      { cause: error },
    );
  }
}

export async function installManagedPythonRuntime(
  options: ManagedPythonRuntimeInstallOptions,
): Promise<ManagedPythonRuntimeInstallResult> {
  const layout = managedPythonRuntimeLayout(options);
  const exec = options.exec ?? defaultExec;
  const features = normalizeFeatures(options.features);
  const asset = await verifyRuntimeAsset({ assetDir: layout.assetDir });
  const uvEnv = managedRuntimeUvEnv(options.env ?? process.env);
  const existing = await readInstalledManifest(layout.manifestPath);
  if (
    options.force !== true &&
    existing &&
    existing.cliVersion === options.cliVersion &&
    existing.asset.wheel.sha256 === asset.manifest.wheel.sha256 &&
    hasFeatures(existing, features) &&
    (await pathExists(existing.python.executable)) &&
    (await pathExists(existing.python.daemonExecutable))
  ) {
    return { status: 'ready', layout, asset, manifest: existing };
  }

  // uv is acquired before the version dir is wiped, so a failed acquisition
  // never destroys a previously installed runtime.
  const { uvPath } = await ensureUv({ exec, uvEnv, options });
  await rm(layout.versionDir, { recursive: true, force: true });
  await mkdir(layout.versionDir, { recursive: true });
  await writeFile(layout.installLogPath, '');
  await runLogged({
    exec,
    logPath: layout.installLogPath,
    command: uvPath,
    args: ['python', 'install', asset.requiresPython.minimumVersion],
    env: uvEnv,
  });
  await runLogged({
    exec,
    logPath: layout.installLogPath,
    command: uvPath,
    args: ['venv', '--python', asset.requiresPython.minimumVersion, layout.venvDir],
    env: uvEnv,
  });
  const wheelSpec = features.includes('local-embeddings') ? `${asset.wheelPath}[local-embeddings]` : asset.wheelPath;
  await runLogged({
    exec,
    logPath: layout.installLogPath,
    command: uvPath,
    args: ['pip', 'install', '--python', layout.pythonPath, wheelSpec],
    env: uvEnv,
  });

  const manifest: InstalledKtxRuntimeManifest = {
    schemaVersion: 1,
    cliVersion: options.cliVersion,
    installedAt: new Date().toISOString(),
    asset: asset.manifest,
    features,
    python: {
      executable: layout.pythonPath,
      daemonExecutable: layout.daemonPath,
    },
    installLog: layout.installLogPath,
  };
  await writeFile(layout.manifestPath, `${JSON.stringify(manifest, null, 2)}\n`);
  return { status: 'installed', layout, asset, manifest };
}

export async function readManagedPythonRuntimeStatus(
  options: ManagedPythonRuntimeLayoutOptions,
): Promise<ManagedPythonRuntimeStatus> {
  const layout = managedPythonRuntimeLayout(options);
  let manifest: InstalledKtxRuntimeManifest | undefined;
  try {
    manifest = await readInstalledManifest(layout.manifestPath);
  } catch (error) {
    return {
      kind: 'broken',
      detail: `Runtime manifest is invalid: ${error instanceof Error ? error.message : String(error)}`,
      layout,
    };
  }
  if (!manifest) {
    return { kind: 'missing', detail: `No runtime manifest at ${layout.manifestPath}`, layout };
  }
  if (manifest.cliVersion !== options.cliVersion) {
    return {
      kind: 'mismatched',
      detail: `Runtime is for CLI ${manifest.cliVersion}, current CLI is ${options.cliVersion}`,
      layout,
      manifest,
    };
  }
  if (!(await pathExists(manifest.python.executable))) {
    return { kind: 'broken', detail: `Missing Python executable: ${manifest.python.executable}`, layout, manifest };
  }
  if (!(await pathExists(manifest.python.daemonExecutable))) {
    return { kind: 'broken', detail: `Missing ktx-daemon executable: ${manifest.python.daemonExecutable}`, layout, manifest };
  }
  return { kind: 'ready', detail: `Runtime ready at ${layout.versionDir}`, layout, manifest };
}

function check(
  status: ManagedPythonRuntimeDoctorCheck['status'],
  input: Omit<ManagedPythonRuntimeDoctorCheck, 'status'>,
): ManagedPythonRuntimeDoctorCheck {
  return { status, ...input };
}

export async function doctorManagedPythonRuntime(
  options: ManagedPythonRuntimeLayoutOptions & { exec?: ManagedPythonRuntimeExec; fetchUvArtifact?: ManagedUvFetchArtifact },
): Promise<ManagedPythonRuntimeDoctorCheck[]> {
  const exec = options.exec ?? defaultExec;
  const checks: ManagedPythonRuntimeDoctorCheck[] = [];
  try {
    const uv = await ensureUv({ exec, uvEnv: managedRuntimeUvEnv(options.env ?? process.env), options });
    checks.push(check('pass', { id: 'uv', label: 'uv', detail: `${uv.version} (managed: ${uv.uvPath})` }));
  } catch (error) {
    checks.push(
      check('fail', {
        id: 'uv',
        label: 'uv',
        detail: error instanceof Error ? error.message : String(error),
        fix: 'Check network access to github.com and run: ktx admin runtime install --yes',
      }),
    );
  }

  try {
    const asset = await verifyRuntimeAsset({ assetDir: managedPythonRuntimeLayout(options).assetDir });
    checks.push(check('pass', { id: 'asset', label: 'Bundled Python wheel', detail: asset.wheelPath }));
  } catch (error) {
    checks.push(
      check('fail', {
        id: 'asset',
        label: 'Bundled Python wheel',
        detail: error instanceof Error ? error.message : String(error),
        fix: 'Run: pnpm run artifacts:check',
      }),
    );
  }

  const status = await readManagedPythonRuntimeStatus(options);
  checks.push(
    check(status.kind === 'ready' ? 'pass' : 'fail', {
      id: 'runtime',
      label: 'Managed Python runtime',
      detail: status.detail,
      ...(status.kind === 'ready' ? {} : { fix: 'Run: ktx admin runtime install --yes' }),
    }),
  );
  return checks;
}
