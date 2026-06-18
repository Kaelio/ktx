import { resolveKtxConfigReference } from '../../../core/config-reference.js';
import type { KtxLocalProject } from '../../../../context/project/project.js';
import type { KtxProjectConnectionConfig } from '../../../../context/project/config.js';
import {
  type LookerCredentialResolver,
} from './factory.js';

function stringField(value: unknown): string | null {
  return typeof value === 'string' && value.trim().length > 0 ? value.trim() : null;
}

export function lookerCredentialsFromLocalConnection(
  connectionId: string,
  connection: KtxProjectConnectionConfig | undefined,
  env: NodeJS.ProcessEnv = process.env,
) {
  if (!connection || String(connection.driver).toLowerCase() !== 'looker') {
    throw new Error(`Connection "${connectionId}" is not a Looker connection`);
  }
  const baseUrl = stringField(connection.base_url);
  const clientId = stringField(connection.client_id);
  const clientSecret =
    stringField(connection.client_secret) ??
    resolveKtxConfigReference(stringField(connection.client_secret_ref) ?? undefined, env) ??
    null;

  if (!baseUrl) {
    throw new Error(`Connection "${connectionId}" is missing Looker base_url`);
  }
  if (!clientId) {
    throw new Error(`Connection "${connectionId}" is missing Looker client_id`);
  }
  if (!clientSecret) {
    throw new Error(`Connection "${connectionId}" is missing Looker client_secret or client_secret_ref`);
  }
  return { base_url: baseUrl, client_id: clientId, client_secret: clientSecret };
}

export function createLocalLookerCredentialResolver(
  project: KtxLocalProject,
  env: NodeJS.ProcessEnv = process.env,
): LookerCredentialResolver {
  return {
    async resolve(lookerConnectionId) {
      return lookerCredentialsFromLocalConnection(lookerConnectionId, project.config.connections[lookerConnectionId], env);
    },
  };
}
