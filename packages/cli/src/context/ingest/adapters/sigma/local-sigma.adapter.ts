import type { KtxProjectConnectionConfig } from '../../../../context/project/config.js';
import type { KtxLocalProject } from '../../../../context/project/project.js';
import { resolveKtxConfigReference } from '../../../core/config-reference.js';
import { DEFAULT_SIGMA_CLIENT_CONFIG, DefaultSigmaClient, type SigmaClientConfig } from './client.js';
import type { SigmaClientFactory, SigmaRuntimeClient } from './client-port.js';
import type { SigmaFetchLogger } from './fetch.js';
import type { SigmaPullConfig } from './types.js';
import { SigmaSourceAdapter } from './sigma.adapter.js';
import type { FetchContext } from '../../types.js';

function stringField(value: unknown): string | null {
  return typeof value === 'string' && value.trim().length > 0 ? value.trim() : null;
}

export function sigmaRuntimeConfigFromLocalConnection(
  connectionId: string,
  connection: KtxProjectConnectionConfig | undefined,
  env: NodeJS.ProcessEnv = process.env,
): { apiUrl: string; clientId: string; clientSecret: string } {
  if (!connection || String(connection.driver).toLowerCase() !== 'sigma') {
    throw new Error(`Connection "${connectionId}" is not a Sigma connection`);
  }

  const apiUrl = stringField(connection.api_url) ?? 'https://api.sigmacomputing.com';
  const clientId = stringField(connection.client_id);
  const literalSecret = stringField(connection.client_secret);
  const secretRef = stringField(connection.client_secret_ref);
  const clientSecret =
    literalSecret ?? (secretRef ? (resolveKtxConfigReference(secretRef, env) ?? null) : null);

  if (!clientId) {
    throw new Error(`Connection "${connectionId}" is missing Sigma client_id`);
  }
  if (!clientSecret) {
    throw new Error(
      `Connection "${connectionId}" is missing Sigma client_secret or client_secret_ref`,
    );
  }

  return { apiUrl, clientId, clientSecret };
}

interface CreateLocalSigmaSourceAdapterOptions {
  env?: NodeJS.ProcessEnv;
  defaultClientConfig?: SigmaClientConfig;
  logger?: SigmaFetchLogger;
}

class LocalSigmaClientFactory implements SigmaClientFactory {
  constructor(
    private readonly project: KtxLocalProject,
    private readonly options: CreateLocalSigmaSourceAdapterOptions,
  ) {}

  createClient(config: SigmaPullConfig, _ctx: FetchContext): SigmaRuntimeClient {
    const runtimeConfig = sigmaRuntimeConfigFromLocalConnection(
      config.sigmaConnectionId,
      this.project.config.connections[config.sigmaConnectionId],
      this.options.env,
    );
    return new DefaultSigmaClient(
      runtimeConfig,
      this.options.defaultClientConfig ?? DEFAULT_SIGMA_CLIENT_CONFIG,
    );
  }
}

export function createLocalSigmaSourceAdapter(
  project: KtxLocalProject,
  options: CreateLocalSigmaSourceAdapterOptions = {},
): SigmaSourceAdapter {
  return new SigmaSourceAdapter({
    clientFactory: new LocalSigmaClientFactory(project, options),
    ...(options.logger ? { logger: options.logger } : {}),
  });
}
