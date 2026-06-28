import { readFile } from 'node:fs/promises';
import { homedir } from 'node:os';
import { resolve } from 'node:path';
import type { KtxProjectConnectionConfig } from '../project/config.js';
import type { GdrivePullConfig } from '../ingest/adapters/gdrive/types.js';
import { gdrivePullConfigSchema } from '../ingest/adapters/gdrive/types.js';

type RawKtxGdriveConnectionConfig = Extract<KtxProjectConnectionConfig, { driver: 'gdrive' }>;

export type KtxGdriveConnectionConfig = Omit<
  RawKtxGdriveConnectionConfig,
  'service_account_key_ref' | 'folder_id' | 'recursive'
> & {
  driver: 'gdrive';
  service_account_key_ref: string;
  folder_id: string;
  recursive: boolean;
};

interface ResolveKeyOptions {
  readTextFile?: (path: string) => Promise<string>;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function expandHome(path: string): string {
  return path === '~' || path.startsWith('~/') ? resolve(homedir(), path.slice(2)) : path;
}

export function parseGdriveConnectionConfig(raw: unknown): KtxGdriveConnectionConfig {
  if (!isRecord(raw)) {
    throw new Error('gdrive connection config must be an object');
  }
  if (raw.driver !== 'gdrive') {
    throw new Error('gdrive connection config requires driver: gdrive');
  }
  const keyRef =
    typeof raw.service_account_key_ref === 'string' && raw.service_account_key_ref.trim().length > 0 // pragma: allowlist secret
      ? raw.service_account_key_ref.trim()
      : null;
  if (!keyRef) {
    throw new Error('gdrive connection config requires service_account_key_ref');
  }
  if (!keyRef.startsWith('file:')) {
    throw new Error('gdrive service_account_key_ref must use file:/path/to/key.json');
  }
  const folderId = typeof raw.folder_id === 'string' && raw.folder_id.trim().length > 0 ? raw.folder_id.trim() : null;
  if (!folderId) {
    throw new Error('gdrive connection config requires folder_id');
  }
  return {
    driver: 'gdrive',
    service_account_key_ref: keyRef,
    folder_id: folderId,
    recursive: raw.recursive === true,
  };
}

/** @internal */
export async function resolveGdriveServiceAccountKey(
  serviceAccountKeyRef: string,
  options: ResolveKeyOptions = {},
): Promise<string> {
  if (!serviceAccountKeyRef.startsWith('file:')) {
    throw new Error('gdrive service_account_key_ref must use file:/path/to/key.json');
  }
  const path = expandHome(serviceAccountKeyRef.slice('file:'.length));
  const readTextFile = options.readTextFile ?? ((filePath: string) => readFile(filePath, 'utf-8'));
  const value = (await readTextFile(path)).trim();
  if (!value) {
    throw new Error(`gdrive service account key file is empty: ${path}`);
  }
  return value;
}

export async function gdriveConnectionToPullConfig(
  config: KtxGdriveConnectionConfig,
  options: ResolveKeyOptions = {},
): Promise<GdrivePullConfig> {
  return gdrivePullConfigSchema.parse({
    serviceAccountKey: await resolveGdriveServiceAccountKey(config.service_account_key_ref, options),
    folderId: config.folder_id,
    recursive: config.recursive,
  });
}
