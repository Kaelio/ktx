import { mkdir, mkdtemp, readFile, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it, vi } from 'vitest';
import { GitService } from '../../../../src/context/core/git.service.js';
import { FileIngestTraceWriter } from '../../../../src/context/ingest/ingest-trace.js';
import { integrateWorkUnitPatch } from '../../../../src/context/ingest/isolated-diff/patch-integrator.js';

async function makeRepo() {
  const homeDir = await mkdtemp(join(tmpdir(), 'ktx-integrate-'));
  const configDir = join(homeDir, 'config');
  const git = new GitService({
    storage: { configDir, homeDir },
    git: {
      userName: 'System User',
      userEmail: 'system@example.com',
      bootstrapMessage: 'init',
      bootstrapAuthor: 'system',
      bootstrapAuthorEmail: 'system@example.com',
    },
  });
  await git.onModuleInit();
  await mkdir(join(configDir, 'wiki/global'), { recursive: true });
  await writeFile(join(configDir, 'wiki/global/a.md'), 'old\n');
  await git.commitFiles(['wiki/global/a.md'], 'base', 'System User', 'system@example.com');
  return { homeDir, configDir, git, baseSha: await git.revParseHead() };
}

describe('integrateWorkUnitPatch', () => {
  it('applies a clean patch, runs semantic gates, and commits accepted changes', async () => {
    const { homeDir, configDir, git, baseSha } = await makeRepo();
    const childDir = join(homeDir, 'child');
    await git.addWorktree(childDir, 'child', baseSha);
    const childGit = git.forWorktree(childDir);
    await writeFile(join(childDir, 'wiki/global/a.md'), 'new\n');
    await childGit.commitFiles(['wiki/global/a.md'], 'edit', 'System User', 'system@example.com');
    const patchPath = join(homeDir, 'patches/wu.patch');
    await childGit.writeBinaryNoRenamePatch(baseSha, 'HEAD', patchPath);
    const trace = new FileIngestTraceWriter({
      tracePath: join(homeDir, '.ktx/ingest-traces/job-1/trace.jsonl'),
      jobId: 'job-1',
      connectionId: 'c1',
      sourceKey: 'fake',
      level: 'trace',
    });

    const result = await integrateWorkUnitPatch({
      unitKey: 'wu-1',
      patchPath,
      integrationGit: git,
      trace,
      author: { name: 'ktx Test', email: 'system@ktx.local' },
      validateAppliedTree: vi.fn().mockResolvedValue(undefined),
      slDisallowed: false,
      allowedTargetConnectionIds: new Set(['c1']),
    });

    expect(result.status).toBe('accepted');
    await expect(readFile(join(configDir, 'wiki/global/a.md'), 'utf-8')).resolves.toBe('new\n');
    await expect(readFile(trace.tracePath, 'utf-8')).resolves.toContain('patch_apply_finished');
  });

  it('rolls back and classifies semantic conflicts', async () => {
    const { homeDir, configDir, git, baseSha } = await makeRepo();
    const childDir = join(homeDir, 'child-semantic');
    await git.addWorktree(childDir, 'child-semantic', baseSha);
    const childGit = git.forWorktree(childDir);
    await writeFile(join(childDir, 'wiki/global/a.md'), 'bad\n');
    await childGit.commitFiles(['wiki/global/a.md'], 'bad edit', 'System User', 'system@example.com');
    const patchPath = join(homeDir, 'patches/bad.patch');
    await childGit.writeBinaryNoRenamePatch(baseSha, 'HEAD', patchPath);
    const trace = new FileIngestTraceWriter({
      tracePath: join(homeDir, '.ktx/ingest-traces/job-2/trace.jsonl'),
      jobId: 'job-2',
      connectionId: 'c1',
      sourceKey: 'fake',
      level: 'trace',
    });

    const result = await integrateWorkUnitPatch({
      unitKey: 'wu-bad',
      patchPath,
      integrationGit: git,
      trace,
      author: { name: 'ktx Test', email: 'system@ktx.local' },
      validateAppliedTree: vi.fn().mockRejectedValue(new Error('final artifact gates failed')),
      slDisallowed: false,
      allowedTargetConnectionIds: new Set(['c1']),
    });

    expect(result.status).toBe('semantic_conflict');
    await expect(readFile(join(configDir, 'wiki/global/a.md'), 'utf-8')).resolves.toBe('old\n');
  });

  it('classifies slDisallowed patch policy failures as traced textual conflicts', async () => {
    const { homeDir, configDir, git, baseSha } = await makeRepo();
    await mkdir(join(configDir, 'semantic-layer/c1'), { recursive: true });
    await git.commitFiles(['semantic-layer/c1'], 'empty sl dir', 'System User', 'system@example.com');
    const childDir = join(homeDir, 'child-policy');
    await git.addWorktree(childDir, 'child-policy', baseSha);
    const childGit = git.forWorktree(childDir);
    await mkdir(join(childDir, 'semantic-layer/c1'), { recursive: true });
    await writeFile(join(childDir, 'semantic-layer/c1/orders.yaml'), 'name: orders\ncolumns: []\njoins: []\nmeasures: []\n');
    await childGit.commitFiles(['semantic-layer/c1/orders.yaml'], 'forbidden sl', 'System User', 'system@example.com');
    const patchPath = join(homeDir, 'patches/forbidden.patch');
    await childGit.writeBinaryNoRenamePatch(baseSha, 'HEAD', patchPath);
    const trace = new FileIngestTraceWriter({
      tracePath: join(homeDir, '.ktx/ingest-traces/job-policy/trace.jsonl'),
      jobId: 'job-policy',
      connectionId: 'c1',
      sourceKey: 'fake',
      level: 'trace',
    });

    const result = await integrateWorkUnitPatch({
      unitKey: 'lookml-mismatch',
      patchPath,
      integrationGit: git,
      trace,
      author: { name: 'ktx Test', email: 'system@ktx.local' },
      validateAppliedTree: vi.fn().mockResolvedValue(undefined),
      slDisallowed: true,
      allowedTargetConnectionIds: new Set(['c1']),
    });

    expect(result).toMatchObject({
      status: 'textual_conflict',
      touchedPaths: ['semantic-layer/c1/orders.yaml'],
    });
    const rawTrace = await readFile(trace.tracePath, 'utf-8');
    expect(rawTrace).toContain('patch_policy_rejected');
    expect(rawTrace).toContain('slDisallowed WorkUnit lookml-mismatch touched semantic-layer/c1/orders.yaml');
  });

  it('classifies unauthorized semantic-layer targets as traced textual conflicts', async () => {
    const { homeDir, git, baseSha } = await makeRepo();
    const childDir = join(homeDir, 'child-target-policy');
    await git.addWorktree(childDir, 'child-target-policy', baseSha);
    const childGit = git.forWorktree(childDir);
    await mkdir(join(childDir, 'semantic-layer/finance'), { recursive: true });
    await writeFile(
      join(childDir, 'semantic-layer/finance/orders.yaml'),
      'name: orders\ncolumns: []\njoins: []\nmeasures: []\n',
    );
    await childGit.commitFiles(['semantic-layer/finance/orders.yaml'], 'unauthorized sl', 'System User', 'system@example.com');
    const patchPath = join(homeDir, 'patches/unauthorized.patch');
    await childGit.writeBinaryNoRenamePatch(baseSha, 'HEAD', patchPath);
    const trace = new FileIngestTraceWriter({
      tracePath: join(homeDir, '.ktx/ingest-traces/job-target-policy/trace.jsonl'),
      jobId: 'job-target-policy',
      connectionId: 'c1',
      sourceKey: 'fake',
      level: 'trace',
    });

    const result = await integrateWorkUnitPatch({
      unitKey: 'wu-finance',
      patchPath,
      integrationGit: git,
      trace,
      author: { name: 'ktx Test', email: 'system@ktx.local' },
      validateAppliedTree: vi.fn().mockResolvedValue(undefined),
      slDisallowed: false,
      allowedTargetConnectionIds: new Set(['warehouse']),
    });

    expect(result).toMatchObject({
      status: 'textual_conflict',
      touchedPaths: ['semantic-layer/finance/orders.yaml'],
    });
    const rawTrace = await readFile(trace.tracePath, 'utf-8');
    expect(rawTrace).toContain('patch_policy_rejected');
    expect(rawTrace).toContain('semantic-layer target connection not allowed');
    expect(rawTrace).toContain('allowedTargetConnectionIds');
  });

  it('repairs a textual conflict through the bounded resolver and commits repaired files', async () => {
    const { homeDir, configDir, git, baseSha } = await makeRepo();
    await mkdir(join(configDir, 'wiki/global'), { recursive: true });
    await writeFile(join(configDir, 'wiki/global/a.md'), 'base\n', 'utf-8');
    await git.commitFiles(['wiki/global/a.md'], 'base page', 'System User', 'system@example.com');
    const conflictBase = await git.revParseHead();

    await writeFile(join(configDir, 'wiki/global/a.md'), 'accepted\n', 'utf-8');
    await git.commitFiles(['wiki/global/a.md'], 'accepted edit', 'System User', 'system@example.com');

    const childDir = join(homeDir, 'child-conflict');
    await git.addWorktree(childDir, 'child-conflict', conflictBase);
    const childGit = git.forWorktree(childDir);
    await writeFile(join(childDir, 'wiki/global/a.md'), 'proposal\n', 'utf-8');
    await childGit.commitFiles(['wiki/global/a.md'], 'proposal edit', 'System User', 'system@example.com');
    const patchPath = join(homeDir, 'proposal.patch');
    await childGit.writeBinaryNoRenamePatch(conflictBase, 'HEAD', patchPath);

    const trace = new FileIngestTraceWriter({
      tracePath: join(homeDir, '.ktx/ingest-traces/job-resolver/trace.jsonl'),
      jobId: 'job-resolver',
      connectionId: 'warehouse',
      sourceKey: 'metabase',
      level: 'trace',
    });

    const validateAppliedTree = vi.fn(async (paths: string[]) => {
      expect(paths).toEqual(['wiki/global/a.md']);
      await expect(readFile(join(configDir, 'wiki/global/a.md'), 'utf-8')).resolves.toBe('accepted\nproposal\n');
    });

    const result = await integrateWorkUnitPatch({
      unitKey: 'wu-conflict',
      patchPath,
      integrationGit: git,
      trace,
      author: { name: 'System User', email: 'system@example.com' },
      slDisallowed: false,
      allowedTargetConnectionIds: new Set(['warehouse']),
      validateAppliedTree,
      resolveTextualConflict: vi.fn(async (context) => {
        expect(context).toMatchObject({
          unitKey: 'wu-conflict',
          patchPath,
          touchedPaths: ['wiki/global/a.md'],
        });
        await writeFile(join(configDir, 'wiki/global/a.md'), 'accepted\nproposal\n', 'utf-8');
        await expect(context.verify(['wiki/global/a.md'])).resolves.toEqual({ ok: true });
        return {
          status: 'repaired' as const,
          attempts: 1,
          changedPaths: ['wiki/global/a.md'],
        };
      }),
    });

    expect(result).toMatchObject({
      status: 'accepted',
      touchedPaths: ['wiki/global/a.md'],
      textualResolution: {
        status: 'repaired',
        attempts: 1,
        changedPaths: ['wiki/global/a.md'],
      },
    });
    expect(validateAppliedTree).toHaveBeenCalledOnce();
    await expect(readFile(join(configDir, 'wiki/global/a.md'), 'utf-8')).resolves.toBe('accepted\nproposal\n');
    await expect(readFile(trace.tracePath, 'utf-8')).resolves.toContain('patch_accepted_after_textual_resolution');
    expect(await git.revParseHead()).not.toBe(baseSha);
  });

  it('keeps the pre-apply integration tree when the resolver cannot repair a textual conflict', async () => {
    const { homeDir, configDir, git } = await makeRepo();
    await mkdir(join(configDir, 'wiki/global'), { recursive: true });
    await writeFile(join(configDir, 'wiki/global/a.md'), 'base\n', 'utf-8');
    await git.commitFiles(['wiki/global/a.md'], 'base page', 'System User', 'system@example.com');
    const conflictBase = await git.revParseHead();

    await writeFile(join(configDir, 'wiki/global/a.md'), 'accepted\n', 'utf-8');
    await git.commitFiles(['wiki/global/a.md'], 'accepted edit', 'System User', 'system@example.com');
    const acceptedHead = await git.revParseHead();

    const childDir = join(homeDir, 'child-conflict-fails');
    await git.addWorktree(childDir, 'child-conflict-fails', conflictBase);
    const childGit = git.forWorktree(childDir);
    await writeFile(join(childDir, 'wiki/global/a.md'), 'proposal\n', 'utf-8');
    await childGit.commitFiles(['wiki/global/a.md'], 'proposal edit', 'System User', 'system@example.com');
    const patchPath = join(homeDir, 'proposal-fails.patch');
    await childGit.writeBinaryNoRenamePatch(conflictBase, 'HEAD', patchPath);

    const trace = new FileIngestTraceWriter({
      tracePath: join(homeDir, '.ktx/ingest-traces/job-resolver-fails/trace.jsonl'),
      jobId: 'job-resolver-fails',
      connectionId: 'warehouse',
      sourceKey: 'metabase',
      level: 'trace',
    });

    const result = await integrateWorkUnitPatch({
      unitKey: 'wu-conflict',
      patchPath,
      integrationGit: git,
      trace,
      author: { name: 'System User', email: 'system@example.com' },
      slDisallowed: false,
      allowedTargetConnectionIds: new Set(['warehouse']),
      validateAppliedTree: vi.fn(async () => {}),
      resolveTextualConflict: vi.fn(async () => ({
        status: 'failed' as const,
        attempts: 1,
        reason: 'resolver completed without editing an allowed path',
      })),
    });

    expect(result).toMatchObject({
      status: 'textual_conflict',
      textualResolution: {
        status: 'failed',
        attempts: 1,
        reason: 'resolver completed without editing an allowed path',
      },
    });
    expect(await git.revParseHead()).toBe(acceptedHead);
    await expect(readFile(join(configDir, 'wiki/global/a.md'), 'utf-8')).resolves.toBe('accepted\n');
  });

  it('accepts a redundant duplicate-creation patch as subsumed without committing', async () => {
    // Regression: two work units each emitted a creation patch for the same
    // wiki page. The second creation patch conflicts with the page already in
    // the tree; the resolver verifies a no-change resolution and the source
    // must not fail.
    const { homeDir, configDir, git, baseSha } = await makeRepo();
    await writeFile(join(configDir, 'wiki/global/b.md'), 'page from the first work unit\n', 'utf-8');
    await git.commitFiles(['wiki/global/b.md'], 'first creation', 'System User', 'system@example.com');
    const acceptedHead = await git.revParseHead();

    const childDir = join(homeDir, 'child-duplicate');
    await git.addWorktree(childDir, 'child-duplicate', baseSha);
    const childGit = git.forWorktree(childDir);
    await writeFile(join(childDir, 'wiki/global/b.md'), 'duplicate page from the second work unit\n', 'utf-8');
    await childGit.commitFiles(['wiki/global/b.md'], 'second creation', 'System User', 'system@example.com');
    const patchPath = join(homeDir, 'duplicate-creation.patch');
    await childGit.writeBinaryNoRenamePatch(baseSha, 'HEAD', patchPath);

    const trace = new FileIngestTraceWriter({
      tracePath: join(homeDir, '.ktx/ingest-traces/job-subsumed/trace.jsonl'),
      jobId: 'job-subsumed',
      connectionId: 'warehouse',
      sourceKey: 'notion',
      level: 'trace',
    });

    const result = await integrateWorkUnitPatch({
      unitKey: 'wu-duplicate',
      patchPath,
      integrationGit: git,
      trace,
      author: { name: 'System User', email: 'system@example.com' },
      slDisallowed: false,
      allowedTargetConnectionIds: new Set(['warehouse']),
      validateAppliedTree: vi.fn(async () => {}),
      resolveTextualConflict: vi.fn(async (context) => {
        await expect(context.verify([])).resolves.toEqual({ ok: true });
        return { status: 'repaired' as const, attempts: 1, changedPaths: [] };
      }),
    });

    expect(result).toMatchObject({
      status: 'accepted',
      touchedPaths: [],
      textualResolution: { status: 'repaired', attempts: 1, changedPaths: [] },
    });
    expect(await git.revParseHead()).toBe(acceptedHead);
    await expect(readFile(join(configDir, 'wiki/global/b.md'), 'utf-8')).resolves.toBe(
      'page from the first work unit\n',
    );
    await expect(readFile(trace.tracePath, 'utf-8')).resolves.toContain('patch_subsumed_after_textual_resolution');
  });
});
