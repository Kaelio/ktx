import { access, mkdir, rm } from 'node:fs/promises';
import { join } from 'node:path';
import type { CloneOptions } from 'simple-git';
import { createSimpleGit } from './git-env.js';

/** @internal */
export interface RepoFetchConfig {
  repoUrl: string;
  branch?: string;
  authToken?: string | null;
}

/** @internal */
export class RepoConfigError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'RepoConfigError';
  }
}

/** @internal */
export class RepoFetchError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'RepoFetchError';
  }
}

/** @internal */
export function validateRepoConfig(config: RepoFetchConfig): void {
  if (!config.repoUrl) {
    throw new RepoConfigError('Repository URL is required');
  }

  try {
    new URL(config.repoUrl);
  } catch {
    throw new RepoConfigError(`Invalid repository URL: ${config.repoUrl}`);
  }
}

/** @internal */
export function buildAuthenticatedUrl(repoUrl: string, authToken: string | null | undefined): string {
  if (!authToken) {
    return repoUrl;
  }

  try {
    const url = new URL(repoUrl);
    if (url.protocol === 'file:') {
      return repoUrl;
    }
    if (url.hostname.includes('github.com')) {
      url.username = 'x-token-auth';
      url.password = authToken;
    } else if (url.hostname.includes('gitlab.com')) {
      url.username = 'oauth2';
      url.password = authToken;
    } else {
      url.username = 'token';
      url.password = authToken;
    }
    return url.toString();
  } catch {
    return repoUrl;
  }
}

export function sanitizeRepoError(err: unknown, authToken: string | null | undefined): string {
  const raw = err instanceof Error ? err.message : String(err);
  let sanitized = raw.replace(/:[^@/]*@/g, ':***@');
  if (authToken) {
    sanitized = sanitized.split(authToken).join('***');
  }
  return sanitized;
}

/** @internal */
export async function repoDirExists(dir: string): Promise<boolean> {
  try {
    await access(join(dir, '.git'));
    return true;
  } catch {
    return false;
  }
}

export async function cloneOrPull(args: {
  repoUrl: string;
  authToken?: string | null;
  cacheDir: string;
  branch?: string;
  freshOnPullFailure?: boolean;
}): Promise<{ commitHash: string }> {
  validateRepoConfig(args);

  const branch = args.branch || 'main';
  const authUrl = buildAuthenticatedUrl(args.repoUrl, args.authToken);

  try {
    if (await repoDirExists(args.cacheDir)) {
      const pulled = await tryPull(args.cacheDir, authUrl, branch);
      if (!pulled) {
        if (args.freshOnPullFailure === false) {
          throw new RepoFetchError(`Failed to pull repository: ${args.repoUrl}`);
        }
        await cleanupRepoDir(args.cacheDir);
        await cloneFresh(authUrl, args.cacheDir, branch);
      }
    } else {
      await cloneFresh(authUrl, args.cacheDir, branch);
    }

    const git = createSimpleGit(args.cacheDir);
    const log = await git.log({ maxCount: 1 });
    return { commitHash: log.latest?.hash ?? 'unknown' };
  } catch (error) {
    if (error instanceof RepoFetchError) {
      throw error;
    }
    throw new RepoFetchError(sanitizeRepoError(error, args.authToken));
  }
}

export async function testRepoConnection(args: {
  repoUrl: string;
  authToken?: string | null;
}): Promise<{ ok: true } | { ok: false; error: string }> {
  try {
    validateRepoConfig(args);
    const repoUrl = buildAuthenticatedUrl(args.repoUrl, args.authToken);
    await createSimpleGit().listRemote([repoUrl, '--heads']);
    return { ok: true };
  } catch (error) {
    return { ok: false, error: sanitizeRepoError(error, args.authToken) };
  }
}

/** @internal */
export async function cleanupRepoDir(dir: string): Promise<void> {
  await rm(dir, { recursive: true, force: true });
}

async function cloneFresh(authUrl: string, cacheDir: string, branch: string): Promise<void> {
  await mkdir(cacheDir, { recursive: true });
  const git = createSimpleGit();
  const opts: CloneOptions = { '--branch': branch, '--depth': 1, '--single-branch': null };
  await git.clone(authUrl, cacheDir, opts);
}

async function tryPull(cacheDir: string, authUrl: string, branch: string): Promise<boolean> {
  try {
    const git = createSimpleGit(cacheDir);
    await git.remote(['set-url', 'origin', authUrl]);
    await git.fetch(['origin', branch]);
    await git.checkout(branch);
    // --ff-only makes divergence fail deterministically instead of silently rebasing or
    // merging per the caller's ambient pull.rebase/pull.ff config, which would let a
    // locally-diverged cache survive instead of falling back to cloneFresh below.
    await git.pull('origin', branch, ['--ff-only']);
    return true;
  } catch {
    return false;
  }
}
