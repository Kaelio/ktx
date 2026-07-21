import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, it } from 'node:test';

import { PUBLIC_NPM_PACKAGE_VERSION } from './public-npm-release-metadata.mjs';
import {
  CLI_PYTHON_ASSET_MANIFEST,
  RUNTIME_WHEEL_DISTRIBUTION_NAME,
  RUNTIME_WHEEL_NORMALIZED_NAME,
  RUNTIME_WHEEL_PACKAGE_VERSION,
  artifactManifestPath,
  buildArtifactCommands,
  copyRuntimeWheelAssets,
  findPythonArtifacts,
  NPM_ARTIFACT_PACKAGES,
  npmCliSmokeSource,
  npmRuntimeSmokeSource,
  npmSmokePackageJson,
  npmSmokePnpmWorkspaceYaml,
  npmVerifySource,
  packageArtifactLayout,
  packageReleaseMetadata,
  verifyArtifactManifest,
  writeArtifactManifest,
} from './package-artifacts.mjs';

async function writeJson(path, value) {
  await writeFile(path, `${JSON.stringify(value, null, 2)}\n`);
}

async function writeReleaseMetadataInputs(root) {
  await writeJson(join(root, 'release-policy.json'), {
    schemaVersion: 1,
    releaseMode: 'ci-artifact-only',
    npm: {
      publish: false,
      registry: null,
      access: 'public',
      tag: 'next',
      packages: ['@kaelio/ktx'],
    },
    python: {
      publish: false,
      repository: null,
      packages: ['kaelio-ktx'],
    },
    publishedPackageSmoke: {
      packageName: '@kaelio/ktx',
      version: PUBLIC_NPM_PACKAGE_VERSION,
      registry: null,
    },
    runtimeInstaller: {
      uvStrategy: 'path-prerequisite',
      bootstrapUv: false,
      missingUvBehavior: 'focused-error',
    },
    requiredBeforePublishing: ['Choose public release version.'],
  });

  for (const packageInfo of NPM_ARTIFACT_PACKAGES) {
    await mkdir(join(root, packageInfo.packageRoot), { recursive: true });
    await writeJson(join(root, packageInfo.packageRoot, 'package.json'), {
      name: packageInfo.name,
      version: PUBLIC_NPM_PACKAGE_VERSION,
    });
  }
}

function runtimeWheelFilename(version = RUNTIME_WHEEL_PACKAGE_VERSION) {
  return `kaelio_ktx-${version}-py3-none-any.whl`;
}

async function writeUploadableArtifactFixtures(layout) {
  await mkdir(layout.npmDir, { recursive: true });
  await mkdir(layout.pythonDir, { recursive: true });

  const fileContents = new Map([
    ...NPM_ARTIFACT_PACKAGES.map((packageInfo) => [
      layout.npmTarballs[packageInfo.name],
      `${packageInfo.name}-tarball`,
    ]),
    [
      join(layout.pythonDir, runtimeWheelFilename()),
      'kaelio-ktx-runtime-wheel',
    ],
  ]);

  for (const [path, contents] of fileContents) {
    await writeFile(path, contents);
  }
}

describe('packageArtifactLayout', () => {
  it('uses stable artifact paths under ktx/dist/artifacts', () => {
    const layout = packageArtifactLayout('/repo/ktx', PUBLIC_NPM_PACKAGE_VERSION);

    assert.equal(layout.artifactDir, join('/repo/ktx', 'dist', 'artifacts'));
    assert.equal(layout.npmDir, join('/repo/ktx', 'dist', 'artifacts', 'npm'));
    assert.equal(layout.pythonDir, join('/repo/ktx', 'dist', 'artifacts', 'python'));
    assert.equal(
      layout.cliTarball,
      join('/repo/ktx', 'dist', 'artifacts', 'npm', `kaelio-ktx-${PUBLIC_NPM_PACKAGE_VERSION}.tgz`),
    );
    assert.deepEqual(Object.keys(layout.npmTarballs), ['@kaelio/ktx']);
  });
});

describe('buildArtifactCommands', () => {
  it('builds the CLI package, then the runtime wheel, then packs the npm tarball directly', () => {
    const layout = packageArtifactLayout('/repo/ktx', PUBLIC_NPM_PACKAGE_VERSION);
    const commands = buildArtifactCommands(layout);
    const expectedBuildCommand =
      process.platform === 'win32'
        ? ['cmd.exe', ['/d', '/s', '/c', 'pnpm', '--filter', '@kaelio/ktx', 'run', 'build'], layout.rootDir]
        : ['pnpm', ['--filter', '@kaelio/ktx', 'run', 'build'], layout.rootDir];
    const expectedPackCommand =
      process.platform === 'win32'
        ? ['cmd.exe', ['/d', '/s', '/c', 'pnpm', 'pack', '--out', layout.cliTarball], join('/repo/ktx', 'packages', 'cli')]
        : ['pnpm', ['pack', '--out', layout.cliTarball], join('/repo/ktx', 'packages', 'cli')];

    assert.deepEqual(
      commands.map((command) => [command.command, command.args, command.cwd]),
      [
        expectedBuildCommand,
        [process.execPath, ['scripts/build-python-runtime-wheel.mjs'], layout.rootDir],
        expectedPackCommand,
      ],
    );
  });
});

describe('packageReleaseMetadata', () => {
  it('reads package identities and versions from package manifests', async () => {
    const root = await mkdtemp(join(tmpdir(), 'ktx-release-metadata-test-'));
    try {
      await writeReleaseMetadataInputs(root);

      assert.deepEqual(await packageReleaseMetadata(root), [
        {
          ecosystem: 'npm',
          packageName: '@kaelio/ktx',
          packageRoot: 'packages/cli',
          packageVersion: PUBLIC_NPM_PACKAGE_VERSION,
          private: false,
          releaseMode: 'ci-artifact-only',
        },
        {
          ecosystem: 'python',
          packageName: 'kaelio-ktx',
          packageRoot: 'python/runtime-wheel',
          packageVersion: RUNTIME_WHEEL_PACKAGE_VERSION,
          private: false,
          releaseMode: 'ci-artifact-only',
        },
      ]);
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });
});

describe('findPythonArtifacts', () => {
  it('finds the bundled runtime wheel only', async () => {
    const root = await mkdtemp(join(tmpdir(), 'ktx-artifacts-test-'));
    try {
      await writeFile(join(root, runtimeWheelFilename()), '');

      assert.deepEqual(await findPythonArtifacts(root), {
        runtimeWheel: join(root, runtimeWheelFilename()),
      });
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it('throws when a required Python artifact is missing', async () => {
    const root = await mkdtemp(join(tmpdir(), 'ktx-artifacts-test-'));
    try {
      await assert.rejects(() => findPythonArtifacts(root), /Missing Python artifact: kaelio-ktx runtime wheel/);
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });
});

describe('artifact manifest', () => {
  it('writes release metadata, source revision, checksums, and byte counts for every uploadable artifact', async () => {
    const root = await mkdtemp(join(tmpdir(), 'ktx-artifacts-manifest-test-'));
    const layout = packageArtifactLayout(root, PUBLIC_NPM_PACKAGE_VERSION);
    try {
      await writeReleaseMetadataInputs(root);
      await writeUploadableArtifactFixtures(layout);

      const manifest = await writeArtifactManifest(layout, new Date('2026-04-28T12:00:00.000Z'), {
        sourceRevision: 'abc123',
      });

      assert.equal(artifactManifestPath(layout), join(root, 'dist', 'artifacts', 'manifest.json'));
      assert.equal(manifest.schemaVersion, 2);
      assert.equal(manifest.generatedAt, '2026-04-28T12:00:00.000Z');
      assert.equal(manifest.sourceRevision, 'abc123');
      assert.deepEqual(
        manifest.packages.filter((entry) => entry.ecosystem === 'npm'),
        [
          {
            ecosystem: 'npm',
            packageName: '@kaelio/ktx',
            packageRoot: 'packages/cli',
            packageVersion: PUBLIC_NPM_PACKAGE_VERSION,
            private: false,
            releaseMode: 'ci-artifact-only',
          },
        ],
      );
      assert.deepEqual(
        manifest.packages.filter((entry) => entry.ecosystem === 'python'),
        [
          {
            ecosystem: 'python',
            packageName: 'kaelio-ktx',
            packageRoot: 'python/runtime-wheel',
            packageVersion: RUNTIME_WHEEL_PACKAGE_VERSION,
            private: false,
            releaseMode: 'ci-artifact-only',
          },
        ],
      );
      assert.deepEqual(
        manifest.files
          .filter((file) => file.ecosystem === 'npm')
          .map((file) => ({
            artifactKind: file.artifactKind,
            ecosystem: file.ecosystem,
            packageName: file.packageName,
            packageVersion: file.packageVersion,
            path: file.path,
          }))
          .sort((left, right) => left.packageName.localeCompare(right.packageName)),
        [
          {
            artifactKind: 'tarball',
            ecosystem: 'npm',
            packageName: '@kaelio/ktx',
            packageVersion: PUBLIC_NPM_PACKAGE_VERSION,
            path: `npm/kaelio-ktx-${PUBLIC_NPM_PACKAGE_VERSION}.tgz`,
          },
        ],
      );
      assert.deepEqual(
        manifest.files
          .filter((file) => file.ecosystem === 'python')
          .map((file) => ({
            artifactKind: file.artifactKind,
            ecosystem: file.ecosystem,
            packageName: file.packageName,
            packageVersion: file.packageVersion,
            path: file.path,
          })),
        [
          {
            artifactKind: 'wheel',
            ecosystem: 'python',
            packageName: 'kaelio-ktx',
            packageVersion: RUNTIME_WHEEL_PACKAGE_VERSION,
            path: `python/${runtimeWheelFilename()}`,
          },
        ],
      );

      const npmEntry = manifest.files.find(
        (file) => file.path === `npm/kaelio-ktx-${PUBLIC_NPM_PACKAGE_VERSION}.tgz`,
      );
      assert.ok(npmEntry);
      assert.equal(npmEntry.bytes, Buffer.byteLength('@kaelio/ktx-tarball'));
      assert.equal(npmEntry.sha256, createHash('sha256').update('@kaelio/ktx-tarball').digest('hex'));

      const writtenManifest = JSON.parse(await readFile(artifactManifestPath(layout), 'utf-8'));
      assert.deepEqual(writtenManifest, manifest);
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });
});

describe('verifyArtifactManifest', () => {
  it('accepts a schema version 2 manifest that matches the artifact directory', async () => {
    const root = await mkdtemp(join(tmpdir(), 'ktx-artifacts-verify-manifest-test-'));
    const layout = packageArtifactLayout(root, PUBLIC_NPM_PACKAGE_VERSION);
    try {
      await writeReleaseMetadataInputs(root);
      await writeUploadableArtifactFixtures(layout);
      await writeArtifactManifest(layout, new Date('2026-04-28T12:00:00.000Z'), {
        sourceRevision: 'abc123',
      });

      const manifest = await verifyArtifactManifest(layout, {
        expectedSourceRevision: 'abc123',
      });

      assert.equal(manifest.schemaVersion, 2);
      assert.equal(manifest.sourceRevision, 'abc123');
      assert.equal(manifest.files.length, NPM_ARTIFACT_PACKAGES.length + 1);
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it('rejects a manifest when a file checksum has drifted', async () => {
    const root = await mkdtemp(join(tmpdir(), 'ktx-artifacts-checksum-drift-test-'));
    const layout = packageArtifactLayout(root, PUBLIC_NPM_PACKAGE_VERSION);
    try {
      await writeReleaseMetadataInputs(root);
      await writeUploadableArtifactFixtures(layout);
      await writeArtifactManifest(layout, new Date('2026-04-28T12:00:00.000Z'), {
        sourceRevision: 'abc123',
      });
      await writeFile(layout.contextTarball, 'changed-context-tarball');

      await assert.rejects(
        () => verifyArtifactManifest(layout),
        /Artifact manifest files do not match artifact contents/,
      );
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it('rejects a manifest with an unsafe artifact path', async () => {
    const root = await mkdtemp(join(tmpdir(), 'ktx-artifacts-path-test-'));
    const layout = packageArtifactLayout(root, PUBLIC_NPM_PACKAGE_VERSION);
    try {
      await writeReleaseMetadataInputs(root);
      await writeUploadableArtifactFixtures(layout);
      const manifest = await writeArtifactManifest(layout, new Date('2026-04-28T12:00:00.000Z'), {
        sourceRevision: 'abc123',
      });
      manifest.files[0].path = '../outside.tgz';
      await writeFile(artifactManifestPath(layout), `${JSON.stringify(manifest, null, 2)}\n`);

      await assert.rejects(() => verifyArtifactManifest(layout), /Unsafe artifact manifest path: \.\.\/outside\.tgz/);
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it('rejects a manifest from the wrong source revision when one is required', async () => {
    const root = await mkdtemp(join(tmpdir(), 'ktx-artifacts-revision-test-'));
    const layout = packageArtifactLayout(root, PUBLIC_NPM_PACKAGE_VERSION);
    try {
      await writeReleaseMetadataInputs(root);
      await writeUploadableArtifactFixtures(layout);
      await writeArtifactManifest(layout, new Date('2026-04-28T12:00:00.000Z'), {
        sourceRevision: 'abc123',
      });

      await assert.rejects(
        () =>
          verifyArtifactManifest(layout, {
            expectedSourceRevision: 'def456',
          }),
        /Artifact manifest sourceRevision mismatch: expected def456, got abc123/,
      );
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });
});

describe('copyRuntimeWheelAssets', () => {
  it('copies the runtime wheel and checksum manifest into CLI assets', async () => {
    const root = await mkdtemp(join(tmpdir(), 'ktx-runtime-assets-test-'));
    const layout = packageArtifactLayout(root, PUBLIC_NPM_PACKAGE_VERSION);
    try {
      await mkdir(layout.pythonDir, { recursive: true });
      await writeFile(
        join(layout.pythonDir, runtimeWheelFilename()),
        'kaelio-ktx-runtime-wheel',
      );

      const assets = await copyRuntimeWheelAssets(layout, {
        runtimeWheel: join(layout.pythonDir, runtimeWheelFilename()),
      });

      assert.equal(
        assets.wheelPath,
        join(root, 'packages', 'cli', 'assets', 'python', runtimeWheelFilename()),
      );
      assert.equal(
        assets.manifestPath,
        join(root, 'packages', 'cli', 'assets', 'python', CLI_PYTHON_ASSET_MANIFEST),
      );
      const manifest = JSON.parse(await readFile(assets.manifestPath, 'utf8'));
      assert.deepEqual(manifest, {
        schemaVersion: 1,
        distributionName: RUNTIME_WHEEL_DISTRIBUTION_NAME,
        normalizedName: RUNTIME_WHEEL_NORMALIZED_NAME,
        version: RUNTIME_WHEEL_PACKAGE_VERSION,
        wheel: {
          file: runtimeWheelFilename(),
          sha256: createHash('sha256')
            .update('kaelio-ktx-runtime-wheel')
            .digest('hex'),
          bytes: Buffer.byteLength('kaelio-ktx-runtime-wheel'),
        },
      });
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });
});

describe('verifyNpmArtifacts', () => {
  it('does not prepare an external Python environment for the npm smoke', async () => {
    const source = await readFile(new URL('./package-artifacts.mjs', import.meta.url), 'utf8');
    const start = source.indexOf('async function verifyNpmArtifacts');
    const end = source.indexOf('async function verifyNpmCliArtifacts');
    assert.ok(start > 0, 'verifyNpmArtifacts function must exist');
    assert.ok(end > start, 'verifyNpmCliArtifacts must follow verifyNpmArtifacts');

    const body = source.slice(start, end);
    assert.doesNotMatch(body, /uv', \['venv', '\.venv'\]/);
    assert.doesNotMatch(body, /pythonArtifactInstallArgs/);
    assert.doesNotMatch(body, /npmSmokePythonEnv/);
  });
});

describe('standalone Python artifact cleanup', () => {
  it('does not build or verify standalone Python package artifacts', async () => {
    const source = await readFile(new URL('./package-artifacts.mjs', import.meta.url), 'utf8');

    assert.doesNotMatch(source, /uv', \['build', '--package', 'ktx-sl'/);
    assert.doesNotMatch(source, /uv', \['build', '--package', 'ktx-daemon'/);
    assert.doesNotMatch(source, /async function verifyPythonArtifacts/);
    assert.doesNotMatch(source, /pythonArtifactInstallArgs/);
    assert.doesNotMatch(source, /pythonVerifySource/);
    assert.doesNotMatch(source, /ktx_sl-0\.1\.0/);
    assert.doesNotMatch(source, /ktx_daemon-0\.1\.0/);
  });
});

describe('verification snippets', () => {
  it('pins the smoke project to the public package artifact', () => {
    const layout = packageArtifactLayout('/repo/ktx', PUBLIC_NPM_PACKAGE_VERSION);

    const packageJson = npmSmokePackageJson(layout);
    assert.deepEqual(packageJson.dependencies, {
      '@kaelio/ktx': `file:${layout.cliTarball}`,
    });
    assert.equal(packageJson.devDependencies, undefined);
    assert.equal(
      npmSmokePnpmWorkspaceYaml(),
      ['packages:', '  - "."', 'allowBuilds:', '  better-sqlite3: true', '  lz4: true', ''].join('\n'),
    );
  });

  it('exposes manifest verification as a package artifact command', async () => {
    const source = await readFile(new URL('./package-artifacts.mjs', import.meta.url), 'utf8');
    const packageJson = JSON.parse(await readFile(new URL('../package.json', import.meta.url), 'utf8'));

    assert.match(source, /if \(command === 'verify-manifest'\)/);
    assert.match(source, /await verifyArtifactManifest\(layout\)/);
    assert.equal(packageJson.scripts['artifacts:verify-demo'], 'node scripts/package-artifacts.mjs verify-demo');
    assert.equal(packageJson.scripts['artifacts:verify-manifest'], 'node scripts/package-artifacts.mjs verify-manifest');
  });

  it('asserts the public npm entry point that clean installs must expose', () => {
    const verifySource = npmVerifySource();

    assert.match(verifySource, /const cli = await import\('@kaelio\/ktx'\);/);
    assert.match(verifySource, /getKtxCliPackageInfo/);
    assert.match(verifySource, /runKtxCli/);
    assert.doesNotMatch(verifySource, /@ktx\/context/);
    assert.doesNotMatch(verifySource, /@ktx\/llm/);
    assert.doesNotMatch(verifySource, /@ktx\/connector-/);
  });

  it('runs installed CLI commands through the public package runtime', () => {
    const source = npmRuntimeSmokeSource();

    assert.match(source, /function pnpmCommand\(args\)/);
    assert.match(source, /process\.platform === 'win32'/);
    assert.match(source, /command: 'cmd\.exe'/);
    assert.match(source, /args: \['\/d', '\/s', '\/c', 'pnpm', \.\.\.args\]/);
    assert.match(source, /import \{ setTimeout as delay \} from 'node:timers\/promises';/);
    assert.match(source, /async function rmWithRetry\(path\)/);
    assert.match(source, /await delay\(500\)/);
    assert.match(source, /await rmWithRetry\(root\)/);
    assert.match(source, /ktx public package version/);
    assert.match(source, /installedPackageVersionPattern/);
    assert.doesNotMatch(source, /@kaelio\\\/ktx 0\\\.1\\\.0/);
    assert.match(source, /pnpmCommand\(\[\s*'exec',\s*'ktx',\s*'sl',\s*'query'/);
    assert.doesNotMatch(source, /@ktx\/context/);
    assert.doesNotMatch(source, /@modelcontextprotocol/);
    assert.doesNotMatch(source, /startSemanticDaemon/);
    assert.doesNotMatch(source, /run\('pnpm',/);
    assert.match(source, /pnpmCommand\(\[\s*'exec',\s*'ktx',\s*'setup'/);
    assert.match(source, /wiki', 'global', 'revenue\.md'/);
    assert.match(source, /pnpmCommand\(\[\s*'exec',\s*'ktx',\s*'wiki',\s*'revenue'/);
    assert.match(source, /semantic-layer', 'warehouse', 'orders\.yaml'/);
    assert.match(source, /pnpmCommand\(\[\s*'exec',\s*'ktx',\s*'sl',\s*'orders'/);
    assert.match(source, /orders\.order_count/);
    assert.match(source, /node:sqlite/);
    assert.match(source, /driver: sqlite/);
    assert.match(source, /path: warehouse\.db/);
    assert.doesNotMatch(source, /live-database/);
    assert.match(source, /'--execute'/);
    assert.match(source, /"mode": "compile_only"/);
    assert.match(source, /"mode": "executed"/);
    assert.match(source, /ktx sl query sqlite execute/);
    assert.match(source, /import \{ DatabaseSync \} from 'node:sqlite'/);
    assert.doesNotMatch(source, /run\('python'/);
    assert.match(source, /KTX_RUNTIME_ROOT/);
    assert.match(source, /managed-runtime/);
    assert.match(source, /ktx admin runtime status missing/);
    assert.match(source, /runtimeStatusBefore\.kind, 'missing'/);
    assert.ok(source.includes(String.raw`Installing ktx Python runtime \(core\) with uv`));
    assert.match(source, /ktx Python runtime ready:/);
    assert.match(source, /ktx admin runtime status ready/);
    assert.match(source, /runtimeStatusAfter\.kind, 'ready'/);
    assert.match(source, /runtimeStatusAfter\.manifest\.features/);
    assert.match(source, /ktx admin runtime status/);
    assert.match(source, /status: ready/);
    assert.match(source, /ktx admin runtime start/);
    assert.match(source, /ktx admin runtime start reuse/);
    assert.match(source, /Using existing ktx daemon/);
    assert.match(source, /ktx admin runtime stop/);
    assert.doesNotMatch(source, /ktx admin runtime prune/);
    assert.doesNotMatch(source, /staleRuntimeDir/);
    assert.match(source, /pnpmCommand\(\['exec', 'ktx', 'ingest', 'warehouse'/);
    assert.doesNotMatch(source, /'--fast'/);
    assert.doesNotMatch(source, /'--deep'/);
    assert.doesNotMatch(source, /'--enrich'/);
    assert.match(source, /ktx ingest enrichment guard verified/);
    assert.match(source, /enrichment is not configured/);
    assert.match(source, /requireStderr\('ktx ingest enrichment guard'/);
    assert.match(source, /enrichment:/);
    assert.match(source, /mode: deterministic/);
    assert.doesNotMatch(source, /run\('pnpm', \['exec', 'ktx', 'ingest', 'run'/);
    assert.match(source, /access\(join\(projectDir, '\.ktx', 'db\.sqlite'\)\)/);
    assert.match(source, /SQLite wiki index/);
    assert.doesNotMatch(source, /ktx ingest run requires llm\\.provider\\.backend: anthropic, vertex, or gateway/);
    assert.match(source, /ktx ingest state verified/);
  });

  describe('npmCliSmokeSource', () => {
    it('exercises supported public package CLI commands', () => {
      const source = npmCliSmokeSource();

      assert.match(source, /function pnpmCommand\(args\)/);
      assert.match(source, /process\.platform === 'win32'/);
      assert.doesNotMatch(source, /run\('pnpm',/);
      assert.match(source, /pnpmCommand\(\['exec', 'ktx', '--help'\]\)/);
      assert.match(source, /pnpmCommand\(\['exec', 'ktx', 'setup', '--help'\]\)/);
      assert.match(source, /Usage: ktx setup/);
      assert.doesNotMatch(source, new RegExp(["'demo'", "'--mode'", "'deterministic'"].join(', ')));
      assert.match(source, /'status', '--verbose', '--no-input'/);
      assert.match(source, /ktx status/);
      assert.match(source, /No project here yet/);
      assert.doesNotMatch(source, /function requireProjectStderr/);
      assert.match(source, /Object\.keys\(packageJson\.dependencies\)/);
      assert.match(source, /'@kaelio\/ktx'/);
    });
  });
});
