import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { describe, it } from 'node:test';

import {
  buildPublishedPackageNpxCommand,
  buildPublishedPackageSmokeCommands,
  isPublishedPackageVersionLabel,
  isTransientPublishedPackageLookupFailure,
  publishedPackageSmokePnpmWorkspaceYaml,
  publishedPackageSpec,
  readPublishedPackageSmokeConfig,
} from './published-package-smoke.mjs';

describe('published package smoke config', () => {
  it('skips by default until a published package name is supplied', () => {
    assert.deepEqual(readPublishedPackageSmokeConfig({}, []), {
      enabled: false,
      requireConfig: false,
      reason:
        'Set KTX_PUBLISHED_KTX_PACKAGE or release-policy.json publishedPackageSmoke.packageName to the published npm package name after the release decision.',
    });
  });

  it('can require the published package config for post-publication CI', () => {
    assert.deepEqual(readPublishedPackageSmokeConfig({}, ['--require-config']), {
      enabled: false,
      requireConfig: true,
      reason:
        'Set KTX_PUBLISHED_KTX_PACKAGE or release-policy.json publishedPackageSmoke.packageName to the published npm package name after the release decision.',
    });
  });

  it('reads the package, version, and registry from environment variables', () => {
    assert.deepEqual(
      readPublishedPackageSmokeConfig(
        {
          KTX_PUBLISHED_KTX_PACKAGE: '@kaelio/ktx',
          KTX_PUBLISHED_KTX_VERSION: 'latest',
          KTX_PUBLISHED_KTX_REGISTRY: 'https://registry.npmjs.org/',
        },
        [],
      ),
      {
        enabled: true,
        requireConfig: false,
        configSource: 'environment',
        packageName: '@kaelio/ktx',
        packageVersion: 'latest',
        registry: 'https://registry.npmjs.org/',
      },
    );
  });

  it('reads the package, version, and registry from release policy when env vars are absent', () => {
    assert.deepEqual(
      readPublishedPackageSmokeConfig(
        {},
        [],
        {
          packageName: '@kaelio/ktx',
          version: '2026.5.8',
          registry: 'https://registry.npmjs.org/',
        },
      ),
      {
        enabled: true,
        requireConfig: false,
        configSource: 'release-policy',
        packageName: '@kaelio/ktx',
        packageVersion: '2026.5.8',
        registry: 'https://registry.npmjs.org/',
      },
    );
  });

  it('lets environment variables override release policy values', () => {
    assert.deepEqual(
      readPublishedPackageSmokeConfig(
        {
          KTX_PUBLISHED_KTX_PACKAGE: '@kaelio/ktx',
          KTX_PUBLISHED_KTX_VERSION: 'latest',
        },
        [],
        {
          packageName: '@kaelio/ktx',
          version: '2026.5.8',
          registry: 'https://registry.npmjs.org/',
        },
      ),
      {
        enabled: true,
        requireConfig: false,
        configSource: 'environment',
        packageName: '@kaelio/ktx',
        packageVersion: 'latest',
        registry: 'https://registry.npmjs.org/',
      },
    );
  });

  it('rejects package names that would be unsafe as npx package specs', () => {
    assert.throws(
      () => readPublishedPackageSmokeConfig({ KTX_PUBLISHED_KTX_PACKAGE: '--package=@evil/pkg' }, []),
      /Invalid KTX_PUBLISHED_KTX_PACKAGE/,
    );
    assert.throws(
      () => readPublishedPackageSmokeConfig({ KTX_PUBLISHED_KTX_PACKAGE: '@kaelio/ktx public' }, []),
      /Invalid KTX_PUBLISHED_KTX_PACKAGE/,
    );
    assert.throws(
      () =>
        readPublishedPackageSmokeConfig(
          {},
          [],
          {
            packageName: '@kaelio/ktx public',
            version: 'latest',
            registry: null,
          },
        ),
      /Invalid release-policy\.json publishedPackageSmoke\.packageName/,
    );
  });

  it('rejects unsafe version tags and non-HTTP registries', () => {
    assert.throws(
      () =>
        readPublishedPackageSmokeConfig(
          {
            KTX_PUBLISHED_KTX_PACKAGE: '@kaelio/ktx',
            KTX_PUBLISHED_KTX_VERSION: '--tag latest',
          },
          [],
        ),
      /Invalid KTX_PUBLISHED_KTX_VERSION/,
    );
    assert.throws(
      () =>
        readPublishedPackageSmokeConfig(
          {
            KTX_PUBLISHED_KTX_PACKAGE: '@kaelio/ktx',
            KTX_PUBLISHED_KTX_REGISTRY: 'file:///tmp/npm',
          },
          [],
        ),
      /KTX_PUBLISHED_KTX_REGISTRY must be an http\(s\) URL/,
    );
  });
});

describe('published package smoke output validation labels', () => {
  it('classifies version commands', () => {
    assert.equal(isPublishedPackageVersionLabel('published package npx version'), true);
    assert.equal(isPublishedPackageVersionLabel('published package local version'), true);
    assert.equal(isPublishedPackageVersionLabel('published package global version'), true);
    assert.equal(isPublishedPackageVersionLabel('published package npx setup help'), false);
  });
});

describe('published package smoke registry retry classification', () => {
  it('recognizes npm propagation misses as transient lookup failures', () => {
    assert.equal(
      isTransientPublishedPackageLookupFailure({
        code: 1,
        stdout: '',
        stderr: [
          'npm error code ETARGET',
          'npm error notarget No matching version found for @kaelio/ktx@0.1.0-rc.4.',
        ].join('\n'),
      }),
      true,
    );
  });

  it('does not retry unrelated command failures', () => {
    assert.equal(
      isTransientPublishedPackageLookupFailure({
        code: 1,
        stdout: '',
        stderr: 'npm error code EOTP',
      }),
      false,
    );
  });
});

describe('published package smoke command construction', () => {
  const config = {
    enabled: true,
    requireConfig: false,
    packageName: '@kaelio/ktx',
    packageVersion: 'latest',
    registry: 'https://registry.npmjs.org/',
  };

  it('builds the npx package spec from package name and version tag', () => {
    assert.equal(publishedPackageSpec(config), '@kaelio/ktx@latest');
  });

  it('builds npx commands with a registry env patch instead of shell interpolation', () => {
    assert.deepEqual(buildPublishedPackageNpxCommand(config, ['--version']), {
      label: 'published package command',
      command: 'npx',
      args: ['--yes', '@kaelio/ktx@latest', '--version'],
      env: { npm_config_registry: 'https://registry.npmjs.org/' },
    });
  });

  it('builds the full public package smoke command list', () => {
    assert.deepEqual(
      buildPublishedPackageSmokeCommands(
        config,
        '/tmp/ktx-smoke/demo',
        '/tmp/ktx-smoke/managed-runtime',
      ),
      [
        {
          label: 'published package npx version',
          command: 'npx',
          args: ['--yes', '@kaelio/ktx@latest', '--version'],
          env: { npm_config_registry: 'https://registry.npmjs.org/' },
        },
        {
          label: 'published package npx setup help',
          command: 'npx',
          args: ['--yes', '@kaelio/ktx@latest', 'setup', '--help'],
          env: { npm_config_registry: 'https://registry.npmjs.org/' },
        },
        {
          label: 'published package npx status help',
          command: 'npx',
          args: ['--yes', '@kaelio/ktx@latest', 'status', '--help'],
          env: { npm_config_registry: 'https://registry.npmjs.org/' },
        },
        {
          label: 'published package local install',
          command: 'pnpm',
          args: ['add', '@kaelio/ktx@latest'],
          env: { npm_config_registry: 'https://registry.npmjs.org/' },
        },
        {
          label: 'published package local version',
          command: 'npx',
          args: ['ktx', '--version'],
          env: { npm_config_registry: 'https://registry.npmjs.org/' },
        },
        {
          label: 'published package local status help',
          command: 'npx',
          args: ['ktx', 'status', '--help'],
          env: { npm_config_registry: 'https://registry.npmjs.org/' },
        },
        {
          label: 'published package global install',
          command: 'pnpm',
          args: ['add', '--global', '@kaelio/ktx@latest'],
          env: { npm_config_registry: 'https://registry.npmjs.org/' },
        },
        {
          label: 'published package global version',
          command: 'ktx',
          args: ['--version'],
          env: { npm_config_registry: 'https://registry.npmjs.org/' },
        },
        {
          label: 'published package global status help',
          command: 'ktx',
          args: ['status', '--help'],
          env: { npm_config_registry: 'https://registry.npmjs.org/' },
        },
      ],
    );
  });

  it('allows native dependency build scripts in clean pnpm smoke installs', () => {
    assert.equal(
      publishedPackageSmokePnpmWorkspaceYaml(),
      ['packages:', '  - "."', 'allowBuilds:', '  better-sqlite3: true', '  lz4: true', ''].join('\n'),
    );
  });

  it('exposes the smoke through the package release script', async () => {
    const packageJson = JSON.parse(await readFile(new URL('../package.json', import.meta.url), 'utf8'));

    assert.equal(
      packageJson.scripts['release:published-smoke'],
      'node scripts/published-package-smoke.mjs --require-config',
    );
  });
});
