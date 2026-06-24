import { execFileSync } from 'node:child_process';
import { mkdir, mkdtemp, readFile, realpath, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import type { KtxCoreConfig } from '../../../src/context/core/config.js';
import { classifyKtxRepoOwnership, GitService } from '../../../src/context/core/git.service.js';

function coreConfig(configDir: string): KtxCoreConfig {
  return {
    storage: { configDir, homeDir: configDir },
    git: {
      userName: 'Test User',
      userEmail: 'test@example.com',
      bootstrapMessage: 'Initialize test config repo',
      bootstrapAuthor: 'test-system',
      bootstrapAuthorEmail: 'system@example.com',
    },
  };
}

function git(cwd: string, args: string[]): string {
  // `-c commit.gpgsign=false` keeps fixture commits deterministic regardless of the host's git
  // config: a contributor with commit.gpgsign=true would otherwise fail these raw commits under a
  // synthetic identity that owns no secret key.
  const fixtureArgs = args[0] === 'commit' ? ['-c', 'commit.gpgsign=false', ...args] : args;
  return execFileSync('git', fixtureArgs, {
    cwd,
    encoding: 'utf-8',
    env: {
      ...process.env,
      GIT_AUTHOR_NAME: 'Parent User',
      GIT_AUTHOR_EMAIL: 'parent@example.com',
      GIT_COMMITTER_NAME: 'Parent User',
      GIT_COMMITTER_EMAIL: 'parent@example.com',
    },
  }).trim();
}

describe('GitService repository ownership', () => {
  let tempDir: string;

  beforeEach(async () => {
    tempDir = await mkdtemp(join(tmpdir(), 'git-service-isolation-'));
  });

  afterEach(async () => {
    await rm(tempDir, { recursive: true, force: true });
  });

  it('creates and commits inside its own repo when nested in an enclosing repo', async () => {
    const parentDir = join(tempDir, 'parent');
    const projectDir = join(parentDir, '.ktx-project');
    await mkdir(projectDir, { recursive: true });

    git(parentDir, ['init']);
    await writeFile(join(parentDir, 'README.md'), '# Parent\n', 'utf-8');
    git(parentDir, ['add', 'README.md']);
    git(parentDir, ['commit', '-m', 'parent baseline']);
    const parentHeadBefore = git(parentDir, ['rev-parse', 'HEAD']);

    await writeFile(join(projectDir, 'ktx.yaml'), 'connections: {}\n', 'utf-8');
    const service = new GitService(coreConfig(projectDir));
    await service.onModuleInit();

    expect(await classifyKtxRepoOwnership(projectDir)).toBe('ktx-managed');
    expect(git(parentDir, ['rev-parse', 'HEAD'])).toBe(parentHeadBefore);
    expect(await realpath(git(projectDir, ['rev-parse', '--show-toplevel']))).toBe(await realpath(projectDir));

    await writeFile(join(projectDir, 'wiki.md'), '# Wiki\n', 'utf-8');
    await service.commitFile('wiki.md', 'Add wiki page', 'Test User', 'test@example.com');

    expect(git(parentDir, ['rev-parse', 'HEAD'])).toBe(parentHeadBefore);
    expect(git(projectDir, ['log', '--oneline', '--max-count=1'])).toContain('Add wiki page');
    expect(git(parentDir, ['status', '--short'])).toContain('?? .ktx-project/');
  });

  it('rejects a foreign repo rooted at the project dir', async () => {
    const projectDir = join(tempDir, 'foreign');
    await mkdir(projectDir, { recursive: true });
    git(projectDir, ['init']);
    const configBefore = await readFile(join(projectDir, '.git', 'config'), 'utf-8');

    const service = new GitService(coreConfig(projectDir));

    await expect(service.onModuleInit()).rejects.toThrow(/already a git repository that ktx did not create/);
    expect(await readFile(join(projectDir, '.git', 'config'), 'utf-8')).toBe(configBefore);
  });

  it('rejects a gitfile at the project dir as foreign even when a ktx.yaml sits beside it', async () => {
    // A linked worktree is never ktx's own repo, whatever files live in it.
    const projectDir = join(tempDir, 'linked-worktree');
    await mkdir(projectDir, { recursive: true });
    await writeFile(join(projectDir, '.git'), 'gitdir: ../actual.git\n', 'utf-8');
    await writeFile(join(projectDir, 'ktx.yaml'), 'connections: {}\n', 'utf-8');

    const service = new GitService(coreConfig(projectDir));

    await expect(service.onModuleInit()).rejects.toThrow(/already a git repository that ktx did not create/);
  });

  it('re-initializes an existing ktx project repo without a second bootstrap commit', async () => {
    const projectDir = join(tempDir, 'owned');
    await mkdir(projectDir, { recursive: true });
    await writeFile(join(projectDir, 'ktx.yaml'), 'connections: {}\n', 'utf-8');
    const service = new GitService(coreConfig(projectDir));
    await service.onModuleInit();
    const before = await service.revParseHead();

    const second = new GitService(coreConfig(projectDir));
    await second.onModuleInit();

    expect(await second.revParseHead()).toBe(before);
  });

  it('accepts a project created by an older ktx: repo history plus an untracked root ktx.yaml', async () => {
    // Older projects have ktx commit history and an uncommitted root ktx.yaml
    // (it holds secret refs); the on-disk file is still the ownership signal.
    const projectDir = join(tempDir, 'legacy');
    await mkdir(join(projectDir, '.ktx'), { recursive: true });
    git(projectDir, ['init']);
    await writeFile(join(projectDir, '.ktx', '.gitignore'), 'secrets/\n', 'utf-8');
    git(projectDir, ['add', '.ktx/.gitignore']);
    git(projectDir, ['commit', '-m', 'Initialize KTX project: legacy']);
    await writeFile(join(projectDir, 'ktx.yaml'), 'connections: {}\n', 'utf-8');
    const headBefore = git(projectDir, ['rev-parse', 'HEAD']);

    const service = new GitService(coreConfig(projectDir));
    await expect(service.onModuleInit()).resolves.toBeUndefined();

    expect(await service.revParseHead()).toBe(headBefore);
    expect(git(projectDir, ['status', '--short'])).toContain('?? ktx.yaml');
  });

  it('still rejects a user repo with history but no root ktx.yaml', async () => {
    const projectDir = join(tempDir, 'app-repo');
    await mkdir(projectDir, { recursive: true });
    git(projectDir, ['init']);
    await writeFile(join(projectDir, 'README.md'), '# App\n', 'utf-8');
    git(projectDir, ['add', 'README.md']);
    git(projectDir, ['commit', '-m', 'app baseline']);

    const service = new GitService(coreConfig(projectDir));
    await expect(service.onModuleInit()).rejects.toThrow(/already a git repository that ktx did not create/);
  });
});

describe('classifyKtxRepoOwnership', () => {
  let tempDir: string;

  beforeEach(async () => {
    tempDir = await mkdtemp(join(tmpdir(), 'git-ownership-'));
  });

  afterEach(async () => {
    await rm(tempDir, { recursive: true, force: true });
  });

  it('reports unowned when no .git exists at the directory', async () => {
    const dir = join(tempDir, 'fresh');
    await mkdir(dir, { recursive: true });
    expect(await classifyKtxRepoOwnership(dir)).toBe('unowned');
  });

  it('reports unowned for a fresh directory nested inside an enclosing repo', async () => {
    const parentDir = join(tempDir, 'parent');
    const nestedDir = join(parentDir, 'nested');
    await mkdir(nestedDir, { recursive: true });
    git(parentDir, ['init']);
    expect(await classifyKtxRepoOwnership(nestedDir)).toBe('unowned');
  });

  it('reports ktx-managed for a repo with a root ktx.yaml (even untracked)', async () => {
    const dir = join(tempDir, 'owned');
    await mkdir(dir, { recursive: true });
    git(dir, ['init']);
    await writeFile(join(dir, 'ktx.yaml'), 'connections: {}\n', 'utf-8');
    expect(await classifyKtxRepoOwnership(dir)).toBe('ktx-managed');
  });

  it('reports foreign for a repo ktx did not create', async () => {
    const dir = join(tempDir, 'foreign');
    await mkdir(dir, { recursive: true });
    git(dir, ['init']);
    expect(await classifyKtxRepoOwnership(dir)).toBe('foreign');
  });

  it('reports foreign for a non-ktx repo that has commits but no ktx.yaml', async () => {
    const dir = join(tempDir, 'app');
    await mkdir(dir, { recursive: true });
    git(dir, ['init']);
    await writeFile(join(dir, 'README.md'), '# App\n', 'utf-8');
    git(dir, ['add', 'README.md']);
    git(dir, ['commit', '-m', 'baseline']);
    expect(await classifyKtxRepoOwnership(dir)).toBe('foreign');
  });

  it('reports foreign for a .git file (linked worktree)', async () => {
    const dir = join(tempDir, 'linked');
    await mkdir(dir, { recursive: true });
    await writeFile(join(dir, '.git'), 'gitdir: ../actual.git\n', 'utf-8');
    expect(await classifyKtxRepoOwnership(dir)).toBe('foreign');
  });

  it('reports unowned when the path is itself a file', async () => {
    const filePath = join(tempDir, 'notes.txt');
    await writeFile(filePath, 'a file, not a folder\n', 'utf-8');
    expect(await classifyKtxRepoOwnership(filePath)).toBe('unowned');
  });
});
