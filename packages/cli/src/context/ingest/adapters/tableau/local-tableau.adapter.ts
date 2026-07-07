import type { KtxProjectConnectionConfig } from '../../../../context/project/config.js';
import type { KtxLocalProject } from '../../../../context/project/project.js';
import { resolveKtxConfigReference } from '../../../core/config-reference.js';
import type { FetchContext } from '../../types.js';
import {
  DEFAULT_TABLEAU_CLIENT_CONFIG,
  DefaultTableauClient,
  type TableauClientConfig,
  type TableauClientRuntimeConfig,
} from './client.js';
import type { TableauClientFactory, TableauRuntimeClient } from './client-port.js';
import type { TableauFetchLogger } from './fetch.js';
import { TableauSourceAdapter } from './tableau.adapter.js';
import type { TableauPullConfig } from './types.js';

/** REST API version used when a connection does not pin one. */
const DEFAULT_TABLEAU_API_VERSION = '3.29';

function stringField(value: unknown): string | null {
  return typeof value === 'string' && value.trim().length > 0 ? value.trim() : null;
}

export function tableauRuntimeConfigFromLocalConnection(
  connectionId: string,
  connection: KtxProjectConnectionConfig | undefined,
  env: NodeJS.ProcessEnv = process.env,
): TableauClientRuntimeConfig {
  if (!connection || String(connection.driver).toLowerCase() !== 'tableau') {
    throw new Error(`Connection "${connectionId}" is not a Tableau connection`);
  }

  const host = stringField(connection.host);
  const siteContentUrl = stringField(connection.site_content_url) ?? '';
  const apiVersion = stringField(connection.api_version) ?? DEFAULT_TABLEAU_API_VERSION;
  const patName = stringField(connection.personal_access_token_name);
  const literalSecret = stringField(connection.personal_access_token_secret);
  const secretRef = stringField(connection.personal_access_token_secret_ref);
  const patSecret = literalSecret ?? (secretRef ? (resolveKtxConfigReference(secretRef, env) ?? null) : null);

  if (!host) {
    throw new Error(`Connection "${connectionId}" is missing Tableau host`);
  }
  if (!patName) {
    throw new Error(`Connection "${connectionId}" is missing Tableau personal_access_token_name`);
  }
  if (!patSecret) {
    throw new Error(
      `Connection "${connectionId}" is missing Tableau personal_access_token_secret or personal_access_token_secret_ref`,
    );
  }

  return { host, siteContentUrl, apiVersion, patName, patSecret };
}

interface CreateLocalTableauSourceAdapterOptions {
  env?: NodeJS.ProcessEnv;
  defaultClientConfig?: TableauClientConfig;
  logger?: TableauFetchLogger;
  now?: () => Date;
}

class LocalTableauClientFactory implements TableauClientFactory {
  constructor(
    private readonly project: KtxLocalProject,
    private readonly options: CreateLocalTableauSourceAdapterOptions,
  ) {}

  createClient(config: TableauPullConfig, _ctx: FetchContext): TableauRuntimeClient {
    const runtimeConfig = tableauRuntimeConfigFromLocalConnection(
      config.tableauConnectionId,
      this.project.config.connections[config.tableauConnectionId],
      this.options.env,
    );
    return new DefaultTableauClient(runtimeConfig, this.options.defaultClientConfig ?? DEFAULT_TABLEAU_CLIENT_CONFIG);
  }
}

export function createLocalTableauSourceAdapter(
  project: KtxLocalProject,
  options: CreateLocalTableauSourceAdapterOptions = {},
): TableauSourceAdapter {
  return new TableauSourceAdapter({
    clientFactory: new LocalTableauClientFactory(project, options),
    ...(options.logger ? { logger: options.logger } : {}),
    ...(options.now ? { now: options.now } : {}),
  });
}
