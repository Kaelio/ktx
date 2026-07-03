import { readFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { resolve } from 'node:path';
import { KtxExpectedError } from '../../errors.js';

/** @internal */
export function resolveKtxHomePath(path: string): string {
  if (path === '~') {
    return homedir();
  }

  if (path.startsWith('~/')) {
    return resolve(homedir(), path.slice(2));
  }

  return resolve(path);
}

export function resolveKtxConfigReference(value: string | undefined, env: NodeJS.ProcessEnv): string | undefined {
  if (!value) {
    return undefined;
  }

  if (value.startsWith('env:')) {
    const envName = value.slice('env:'.length).trim();
    const envValue = env[envName];
    return envValue && envValue.trim().length > 0 ? envValue.trim() : undefined;
  }

  if (value.startsWith('file:')) {
    const filePath = resolveKtxHomePath(value.slice('file:'.length).trim());
    let fileValue: string;
    try {
      fileValue = readFileSync(filePath, 'utf8').trim();
    } catch (error) {
      // A `file:` secret whose target is missing or unreadable is a config
      // problem (secrets/ is gitignored, so absent after a clone), not a ktx
      // fault — classify it so it stays out of Error Tracking.
      throw new KtxExpectedError(`Could not read the secret file referenced in ktx.yaml: ${filePath}`, { cause: error });
    }
    return fileValue.length > 0 ? fileValue : undefined;
  }

  const trimmed = value.trim();
  return trimmed.length > 0 ? trimmed : undefined;
}
