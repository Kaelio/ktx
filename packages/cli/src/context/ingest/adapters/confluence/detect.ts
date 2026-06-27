import { stat } from 'node:fs/promises';
import { join } from 'node:path';
import { STAGED_FILES } from './types.js';

export async function detectConfluenceStagedDir(stagedDir: string): Promise<boolean> {
  try {
    await stat(join(stagedDir, STAGED_FILES.manifest));
    return true;
  } catch {
    return false;
  }
}
