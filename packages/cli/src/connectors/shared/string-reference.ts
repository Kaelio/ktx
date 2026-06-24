import { readFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { resolve } from 'node:path';

/**
 * Resolves a config string that may reference an environment variable
 * (`env:NAME`) or a file (`file:/path`, `~` expands to the home dir).
 * Plain values pass through unchanged.
 */
export function resolveStringReference(value: string, env: NodeJS.ProcessEnv): string {
  if (value.startsWith('env:')) {
    return env[value.slice('env:'.length)] ?? '';
  }
  if (value.startsWith('file:')) {
    const rawPath = value.slice('file:'.length);
    const path = rawPath.startsWith('~') ? resolve(homedir(), rawPath.slice(rawPath[1] === '/' ? 2 : 1)) : rawPath;
    return readFileSync(path, 'utf-8').trim();
  }
  return value;
}
