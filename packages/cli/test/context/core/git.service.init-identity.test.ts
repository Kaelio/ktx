import { execFileSync } from 'node:child_process';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import type { KtxCoreConfig } from '../../../src/context/core/config.js';
import { GitService } from '../../../src/context/core/git.service.js';

// Regression for bootstrapping a ktx-owned repo on a machine with no configured
// git identity. A foreign pre-existing repo is rejected by the ownership rule;
// this test covers the still-valid path where the repo is already ktx's own
// (root ktx.yaml present) but has no HEAD yet.
describe('GitService.initialize without a configured git identity', () => {
  let repoDir: string;
  let homeDir: string;
  let savedEnv: Record<string, string | undefined>;

  const IDENTITY_ENV_KEYS = [
    'HOME',
    'USERPROFILE',
    'XDG_CONFIG_HOME',
    'GIT_CONFIG_NOSYSTEM',
    'GIT_AUTHOR_NAME',
    'GIT_AUTHOR_EMAIL',
    'GIT_COMMITTER_NAME',
    'GIT_COMMITTER_EMAIL',
    'EMAIL',
  ];

  const coreConfig = (configDir: string): KtxCoreConfig => ({
    storage: { configDir, homeDir: configDir },
    git: {
      userName: 'Test User',
      userEmail: 'test@example.com',
      bootstrapMessage: 'Initialize test config repo',
      bootstrapAuthor: 'test-system',
      bootstrapAuthorEmail: 'system@example.com',
    },
  });

  beforeEach(async () => {
    repoDir = await mkdtemp(join(tmpdir(), 'git-service-identity-'));
    homeDir = await mkdtemp(join(tmpdir(), 'git-service-home-'));

    // Model a machine with no configured git identity, deterministically and independent of
    // the host's ~/.gitconfig. `useConfigOnly` disables git's username@hostname email guess,
    // so a missing identity is a hard failure rather than a hostname-dependent one. Note we
    // cannot use GIT_CONFIG_GLOBAL/GIT_CONFIG_SYSTEM here: simple-git rejects those env vars.
    await writeFile(join(homeDir, '.gitconfig'), '[user]\n\tuseConfigOnly = true\n', 'utf-8');

    savedEnv = Object.fromEntries(IDENTITY_ENV_KEYS.map((key) => [key, process.env[key]]));
    process.env.HOME = homeDir;
    process.env.USERPROFILE = homeDir;
    process.env.XDG_CONFIG_HOME = join(homeDir, 'xdg-empty');
    process.env.GIT_CONFIG_NOSYSTEM = '1';
    for (const key of ['GIT_AUTHOR_NAME', 'GIT_AUTHOR_EMAIL', 'GIT_COMMITTER_NAME', 'GIT_COMMITTER_EMAIL', 'EMAIL']) {
      delete process.env[key];
    }

    execFileSync('git', ['init'], { cwd: repoDir, env: process.env, stdio: 'ignore' });
    await writeFile(join(repoDir, 'ktx.yaml'), 'connections: {}\n', 'utf-8');
  });

  afterEach(async () => {
    for (const [key, value] of Object.entries(savedEnv)) {
      if (value === undefined) {
        delete process.env[key];
      } else {
        process.env[key] = value;
      }
    }
    await rm(repoDir, { recursive: true, force: true });
    await rm(homeDir, { recursive: true, force: true });
  });

  it('bootstraps a commit in a pre-existing empty repo so HEAD resolves', async () => {
    const service = new GitService(coreConfig(repoDir));

    await expect(service.onModuleInit()).resolves.toBeUndefined();

    const head = await service.revParseHead();
    expect(head).toMatch(/^[0-9a-f]{40}$/);
  });

  it("does not write its identity into the user's repo config", async () => {
    const service = new GitService(coreConfig(repoDir));
    await service.onModuleInit();

    // ktx must not hijack the identity the user would use for their own commits in this repo.
    const localName = execFileSync('git', ['config', '--local', '--default', '', 'user.name'], {
      cwd: repoDir,
      env: process.env,
      encoding: 'utf-8',
    }).trim();
    expect(localName).toBe('');
  });

  // Regression for KLO-735: a machine with commit.gpgsign=true makes git try to GPG-sign every
  // commit, but ktx commits under a synthetic identity that can never own a secret key, so signing
  // fails with "No secret key". ktx commits must succeed regardless of the user's signing config.
  it('commits even when the global git config forces gpg signing', async () => {
    // Force signing and point gpg at a program that always fails, mirroring a machine whose
    // configured signing key does not match ktx's synthetic identity.
    await writeFile(
      join(homeDir, '.gitconfig'),
      '[user]\n\tuseConfigOnly = true\n[commit]\n\tgpgsign = true\n[gpg]\n\tprogram = false\n',
      'utf-8',
    );

    const service = new GitService(coreConfig(repoDir));
    await expect(service.onModuleInit()).resolves.toBeUndefined();

    const head = await service.revParseHead();
    expect(head).toMatch(/^[0-9a-f]{40}$/);
  });
});
