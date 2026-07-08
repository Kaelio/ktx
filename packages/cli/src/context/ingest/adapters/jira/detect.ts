import { readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { JIRA_SOURCE_KEY } from './types.js';

export async function detectJiraStagedDir(stagedDir: string): Promise<boolean> {
  try {
    const manifest = JSON.parse(await readFile(join(stagedDir, 'manifest.json'), 'utf-8')) as { source?: unknown };
    return manifest.source === JIRA_SOURCE_KEY;
  } catch {
    return false;
  }
}
