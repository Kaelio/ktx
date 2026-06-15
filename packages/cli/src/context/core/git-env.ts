import { simpleGit, type SimpleGit } from 'simple-git';

const GIT_HOOK_ENV_KEYS = [
  'GIT_ALTERNATE_OBJECT_DIRECTORIES',
  'GIT_DIR',
  'GIT_INDEX_FILE',
  'GIT_OBJECT_DIRECTORY',
  'GIT_PREFIX',
  'GIT_QUARANTINE_PATH',
  'GIT_WORK_TREE',
  'GIT_EDITOR',
  'GIT_EXEC_PATH',
  'GIT_PAGER',
  'PAGER',
  'VISUAL',
  'EDITOR',
] as const;

function sanitizedGitEnv(env: NodeJS.ProcessEnv = process.env): NodeJS.ProcessEnv {
  const sanitized = { ...env };
  for (const key of GIT_HOOK_ENV_KEYS) {
    delete sanitized[key];
  }
  return sanitized;
}

/**
 * Create a simple-git client scoped to `baseDir`. When an identity is provided, ktx's own
 * commits carry it through the GIT_AUTHOR and GIT_COMMITTER environment variables instead of
 * relying on repo-local or global git config. This keeps commits working when the project
 * directory is an existing repo ktx did not create and the machine has no configured git
 * identity (e.g. a fresh Mac with no ~/.gitconfig), without mutating the user's repo config.
 * Explicit `--author` flags on individual commits still take precedence over GIT_AUTHOR_NAME.
 *
 * `commit.gpgsign=false` is injected as a per-invocation `-c` override so ktx's commits never
 * attempt GPG signing: ktx commits under a synthetic identity that can never own a secret key, so
 * a user's `commit.gpgsign=true` would otherwise fail every commit with "No secret key".
 */
export function createSimpleGit(baseDir: string, identity?: { name: string; email: string }): SimpleGit {
  const env = sanitizedGitEnv();
  if (identity?.name && identity.email) {
    env.GIT_AUTHOR_NAME = identity.name;
    env.GIT_AUTHOR_EMAIL = identity.email;
    env.GIT_COMMITTER_NAME = identity.name;
    env.GIT_COMMITTER_EMAIL = identity.email;
  }
  return simpleGit({ baseDir, config: ['commit.gpgsign=false'], unsafe: { allowUnsafeAskPass: true } }).env(env);
}
