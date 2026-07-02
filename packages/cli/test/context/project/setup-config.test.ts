import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { buildDefaultKtxProjectConfig } from '../../../src/context/project/config.js';
import {
  markKtxSetupStateStepComplete,
  mergeKtxSetupGitignoreEntries,
  readKtxSetupState,
  setKtxSetupDatabaseConnectionIds,
} from '../../../src/context/project/setup-config.js';

describe('ktx setup config helpers', () => {
  let tempDir: string;

  beforeEach(async () => {
    tempDir = await mkdtemp(join(tmpdir(), 'ktx-setup-state-'));
  });

  afterEach(async () => {
    await rm(tempDir, { recursive: true, force: true });
  });

  it('marks setup steps complete in local state without duplicating existing state', async () => {
    await markKtxSetupStateStepComplete(tempDir, 'project');
    await markKtxSetupStateStepComplete(tempDir, 'project');
    await markKtxSetupStateStepComplete(tempDir, 'llm');
    await markKtxSetupStateStepComplete(tempDir, 'runtime');
    await markKtxSetupStateStepComplete(tempDir, 'context');

    expect(await readKtxSetupState(tempDir)).toEqual({
      completed_steps: ['project', 'llm', 'runtime', 'context'],
    });
    await expect(readFile(join(tempDir, '.ktx', 'setup', 'state.json'), 'utf-8')).resolves.toBe(
      `${JSON.stringify({ completed_steps: ['project', 'llm', 'runtime', 'context'] }, null, 2)}\n`,
    );
  });

  it('sets setup database connection ids without duplicates', () => {
    const config = buildDefaultKtxProjectConfig();

    const withDatabases = setKtxSetupDatabaseConnectionIds(config, ['warehouse', 'analytics', 'warehouse']);

    expect(withDatabases.setup).toEqual({
      database_connection_ids: ['warehouse', 'analytics'],
    });
    expect(config.setup).toBeUndefined();
  });

  it('merges setup-local gitignore entries without removing existing lines', () => {
    expect(mergeKtxSetupGitignoreEntries('cache/\ndb.sqlite\n')).toBe(
      ['cache/', 'db.sqlite', 'db.sqlite-*', 'ingest-transcripts/', 'logs/', 'secrets/', 'setup/', 'agents/', ''].join('\n'),
    );
    expect(mergeKtxSetupGitignoreEntries('cache/\nsecrets/\n')).toBe(
      ['cache/', 'secrets/', 'db.sqlite', 'db.sqlite-*', 'ingest-transcripts/', 'logs/', 'setup/', 'agents/', ''].join('\n'),
    );
  });
});
