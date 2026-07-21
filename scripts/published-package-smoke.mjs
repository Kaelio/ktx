#!/usr/bin/env node

import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { promisify } from 'node:util';

import {
  buildPublishedPackageSmokeCommands,
  readPublishedPackageSmokeConfigFromPolicyFile,
} from './published-package-smoke-config.mjs';

export {
  buildPublishedPackageNpxCommand,
  buildPublishedPackageSmokeCommands,
  publishedPackageSpec,
  readPublishedPackageSmokeConfig,
} from './published-package-smoke-config.mjs';

const execFileAsync = promisify(execFile);
const SMOKE_TIMEOUT_MS = 180_000;
const TRANSIENT_LOOKUP_RETRY_ATTEMPTS = 6;
const TRANSIENT_LOOKUP_RETRY_DELAY_MS = 10_000;

const VERSION_LABELS = new Set([
  'published package npx version',
  'published package local version',
  'published package global version',
]);

export function isPublishedPackageVersionLabel(label) {
  return VERSION_LABELS.has(label);
}

export function publishedPackageSmokePnpmWorkspaceYaml() {
  return ['packages:', '  - "."', 'allowBuilds:', '  better-sqlite3: true', '  lz4: true', ''].join('\n');
}

export function isTransientPublishedPackageLookupFailure(result) {
  return (
    result.code !== 0 &&
    (result.stderr.includes('npm error code ETARGET') ||
      result.stderr.includes('No matching version found for @kaelio/ktx@'))
  );
}

function scriptRootDir() {
  return resolve(dirname(fileURLToPath(import.meta.url)), '..');
}

function releasePolicyPath(rootDir = scriptRootDir()) {
  return join(rootDir, 'release-policy.json');
}

async function runCommand(command, args, options = {}) {
  process.stdout.write(`$ ${command} ${args.join(' ')}\n`);
  try {
    const result = await execFileAsync(command, args, {
      cwd: options.cwd,
      env: Object.assign({}, process.env, options.env ?? {}),
      encoding: 'utf8',
      maxBuffer: 10 * 1024 * 1024,
      timeout: SMOKE_TIMEOUT_MS,
    });
    return { code: 0, stdout: result.stdout, stderr: result.stderr };
  } catch (error) {
    return {
      code: typeof error.code === 'number' ? error.code : 1,
      stdout: error.stdout ?? '',
      stderr: error.stderr ?? error.message,
    };
  }
}

function delay(ms) {
  return new Promise((resolvePromise) => setTimeout(resolvePromise, ms));
}

async function runCommandWithRegistryRetry(command, args, options = {}) {
  const attempts = options.retryAttempts ?? TRANSIENT_LOOKUP_RETRY_ATTEMPTS;
  const retryDelayMs = options.retryDelayMs ?? TRANSIENT_LOOKUP_RETRY_DELAY_MS;
  let result = await runCommand(command, args, options);

  for (let attempt = 2; attempt <= attempts && isTransientPublishedPackageLookupFailure(result); attempt += 1) {
    process.stdout.write(`npm registry has not exposed the package yet; retrying smoke command (${attempt}/${attempts})\n`);
    await delay(retryDelayMs);
    result = await runCommand(command, args, options);
  }

  return result;
}

function requireSuccess(label, result) {
  assert.equal(
    result.code,
    0,
    `${label} failed with code ${result.code}\nstdout:\n${result.stdout}\nstderr:\n${result.stderr}`,
  );
}

export async function runPublishedPackageSmoke(config) {
  const root = await mkdtemp(join(tmpdir(), 'ktx-published-package-smoke-'));
  try {
    const projectDir = join(root, 'demo-project');

    await writeFile(join(root, 'pnpm-workspace.yaml'), publishedPackageSmokePnpmWorkspaceYaml());

    const commands = buildPublishedPackageSmokeCommands(config, projectDir);
    const pnpmHome = join(root, 'pnpm-home');
    const globalEnv = {
      PNPM_HOME: pnpmHome,
      PATH: [join(pnpmHome, 'bin'), pnpmHome, process.env.PATH ?? ''].join(process.platform === 'win32' ? ';' : ':'),
    };
    for (const command of commands) {
      const isGlobalCommand = command.label.includes('global');
      const result = await runCommandWithRegistryRetry(command.command, command.args, {
        cwd: command.label.includes('local') || isGlobalCommand ? root : undefined,
        env: isGlobalCommand ? { ...globalEnv, ...command.env } : command.env,
      });
      requireSuccess(command.label, result);
      if (isPublishedPackageVersionLabel(command.label)) {
        assert.match(result.stdout, /@kaelio\/ktx /);
      }
    }

    process.stdout.write('published package invocation smoke verified\n');
  } finally {
    await rm(root, { recursive: true, force: true });
  }
}

async function main() {
  const config = await readPublishedPackageSmokeConfigFromPolicyFile(
    releasePolicyPath(),
    process.env,
    process.argv.slice(2),
  );

  if (!config.enabled) {
    if (config.requireConfig) {
      throw new Error(config.reason);
    }
    process.stdout.write(`Published ktx package smoke skipped: ${config.reason}\n`);
    return;
  }

  await runPublishedPackageSmoke(config);
}

if (import.meta.url === pathToFileURL(process.argv[1] ?? '').href) {
  try {
    await main();
  } catch (error) {
    process.stderr.write(`${error instanceof Error ? error.stack : String(error)}\n`);
    process.exitCode = 1;
  }
}
