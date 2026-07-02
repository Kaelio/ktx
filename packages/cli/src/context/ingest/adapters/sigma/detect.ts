import { readdir, stat } from 'node:fs/promises';
import { join } from 'node:path';
import { STAGED_FILES } from './types.js';

export async function detectSigmaStagedDir(stagedDir: string): Promise<boolean> {
  try {
    await stat(join(stagedDir, STAGED_FILES.manifest));
  } catch {
    return false;
  }
  for (const subdir of [STAGED_FILES.dataModelsDir, STAGED_FILES.workbooksDir]) {
    let entries: string[];
    try {
      entries = await readdir(join(stagedDir, subdir));
    } catch {
      continue;
    }
    if (entries.some((name) => name.endsWith('.json'))) return true;
  }
  return false;
}
