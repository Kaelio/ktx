import { readFile, readdir } from 'node:fs/promises';
import { join } from 'node:path';

export async function detectGdriveStagedDir(stagedDir: string): Promise<boolean> {
  try {
    const manifest = JSON.parse(await readFile(join(stagedDir, 'manifest.json'), 'utf-8')) as { source?: unknown };
    if (manifest.source === 'gdrive') {
      return true;
    }
  } catch {
    // Fall through to structural detection.
  }

  try {
    const entries = await readdir(stagedDir, { withFileTypes: true, recursive: true });
    return entries.some((entry) => entry.isFile() && entry.name === 'page.md');
  } catch {
    return false;
  }
}
