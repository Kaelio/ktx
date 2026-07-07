import type { KtxProjectConnectionConfig } from '../project/config.js';
import type { SharepointPullConfig } from '../ingest/adapters/sharepoint/types.js';
import { sharepointPullConfigSchema } from '../ingest/adapters/sharepoint/types.js';

type RawKtxSharepointConnectionConfig = Extract<KtxProjectConnectionConfig, { driver: 'sharepoint' }>;

export type KtxSharepointConnectionConfig = Omit<
  RawKtxSharepointConnectionConfig,
  'tenant_id_ref' | 'client_id_ref' | 'client_secret_ref' | 'drive_id' | 'folder_id' | 'recursive'
> & {
  driver: 'sharepoint';
  tenant_id_ref: string;
  client_id_ref: string;
  client_secret_ref: string;
  drive_id: string;
  folder_id: string;
  recursive: boolean;
};

interface ResolveSharepointOptions {
  env?: Record<string, string | undefined>;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function envRef(value: unknown, label: string): string {
  const trimmed = typeof value === 'string' && value.trim().length > 0 ? value.trim() : null;
  if (!trimmed) {
    throw new Error(`sharepoint connection config requires ${label}`);
  }
  if (!trimmed.startsWith('env:')) {
    throw new Error(`sharepoint ${label} must use env:NAME`);
  }
  return trimmed;
}

function stringField(value: unknown, label: string): string {
  const trimmed = typeof value === 'string' && value.trim().length > 0 ? value.trim() : null;
  if (!trimmed) {
    throw new Error(`sharepoint connection config requires ${label}`);
  }
  return trimmed;
}

export function parseSharepointConnectionConfig(raw: unknown): KtxSharepointConnectionConfig {
  if (!isRecord(raw)) {
    throw new Error('sharepoint connection config must be an object');
  }
  if (raw.driver !== 'sharepoint') {
    throw new Error('sharepoint connection config requires driver: sharepoint');
  }
  return {
    driver: 'sharepoint',
    tenant_id_ref: envRef(raw.tenant_id_ref, 'tenant_id_ref'),
    client_id_ref: envRef(raw.client_id_ref, 'client_id_ref'),
    client_secret_ref: envRef(raw.client_secret_ref, 'client_secret_ref'),
    drive_id: stringField(raw.drive_id, 'drive_id'),
    folder_id: stringField(raw.folder_id, 'folder_id'),
    recursive: raw.recursive === true,
  };
}

function resolveSharepointEnvRef(value: string, options: ResolveSharepointOptions = {}): string {
  if (!value.startsWith('env:')) {
    throw new Error('sharepoint credential refs must use env:NAME');
  }
  const name = value.slice('env:'.length);
  const resolved = (options.env ?? process.env)[name];
  if (!resolved || resolved.trim().length === 0) {
    throw new Error(`SharePoint environment variable ${name} is not set`);
  }
  return resolved.trim();
}

export async function sharepointConnectionToPullConfig(
  config: KtxSharepointConnectionConfig,
  options: ResolveSharepointOptions = {},
): Promise<SharepointPullConfig> {
  return sharepointPullConfigSchema.parse({
    tenantId: resolveSharepointEnvRef(config.tenant_id_ref, options),
    clientId: resolveSharepointEnvRef(config.client_id_ref, options),
    clientSecret: resolveSharepointEnvRef(config.client_secret_ref, options),
    driveId: config.drive_id,
    folderId: config.folder_id,
    recursive: config.recursive,
  });
}
