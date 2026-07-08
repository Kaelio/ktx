import type { KtxProjectConnectionConfig } from '../../../../context/project/config.js';
import type { KtxLocalProject } from '../../../../context/project/project.js';
import { resolveKtxConfigReference } from '../../../core/config-reference.js';
import {
  DEFAULT_CONFLUENCE_CLIENT_CONFIG,
  DefaultConfluenceClient,
  type ConfluenceClientConfig,
  type ConfluenceClientRuntimeConfig,
} from './client.js';
import type { ConfluenceClientFactory, ConfluenceRuntimeClient } from './client-port.js';
import type { ConfluenceFetchLogger } from './fetch.js';
import type { ConfluencePullConfig } from './types.js';
import { ConfluenceSourceAdapter } from './confluence.adapter.js';
import type { FetchContext } from '../../types.js';

function stringField(value: unknown): string | null {
  return typeof value === 'string' && value.trim().length > 0 ? value.trim() : null;
}

/** @internal */
export function confluenceRuntimeConfigFromLocalConnection(
  connectionId: string,
  connection: KtxProjectConnectionConfig | undefined,
  env: NodeJS.ProcessEnv = process.env,
): ConfluenceClientRuntimeConfig {
  if (!connection || String(connection.driver).toLowerCase() !== 'confluence') {
    throw new Error(`Connection "${connectionId}" is not a Confluence connection`);
  }

  const baseUrl = stringField(connection.base_url);
  const email = stringField(connection.email);
  const literalToken = stringField(connection.api_token);
  const tokenRef = stringField(connection.api_token_ref);
  const apiToken = literalToken ?? (tokenRef ? (resolveKtxConfigReference(tokenRef, env) ?? null) : null);

  if (!baseUrl) throw new Error(`Connection "${connectionId}" is missing Confluence base_url`);
  if (!email) throw new Error(`Connection "${connectionId}" is missing Confluence email`);
  if (!apiToken) {
    throw new Error(`Connection "${connectionId}" is missing Confluence api_token or api_token_ref`);
  }

  return { baseUrl, email, apiToken };
}

interface CreateLocalConfluenceSourceAdapterOptions {
  env?: NodeJS.ProcessEnv;
  defaultClientConfig?: ConfluenceClientConfig;
  logger?: ConfluenceFetchLogger;
}

class LocalConfluenceClientFactory implements ConfluenceClientFactory {
  constructor(
    private readonly project: KtxLocalProject,
    private readonly options: CreateLocalConfluenceSourceAdapterOptions,
  ) {}

  createClient(config: ConfluencePullConfig, _ctx: FetchContext): ConfluenceRuntimeClient {
    const runtimeConfig = confluenceRuntimeConfigFromLocalConnection(
      config.confluenceConnectionId,
      this.project.config.connections[config.confluenceConnectionId],
      this.options.env,
    );
    return new DefaultConfluenceClient(
      runtimeConfig,
      this.options.defaultClientConfig ?? DEFAULT_CONFLUENCE_CLIENT_CONFIG,
    );
  }
}

export function createLocalConfluenceSourceAdapter(
  project: KtxLocalProject,
  options: CreateLocalConfluenceSourceAdapterOptions = {},
): ConfluenceSourceAdapter {
  return new ConfluenceSourceAdapter({
    clientFactory: new LocalConfluenceClientFactory(project, options),
    ...(options.logger ? { logger: options.logger } : {}),
  });
}
