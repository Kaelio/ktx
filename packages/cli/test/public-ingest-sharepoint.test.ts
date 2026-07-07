import { describe, expect, it } from 'vitest';
import { buildDefaultKtxProjectConfig } from '../src/context/project/config.js';
import { buildPublicIngestPlan, type KtxPublicIngestProject } from '../src/public-ingest.js';

function projectWithConnections(connections: ReturnType<typeof buildDefaultKtxProjectConfig>['connections']): KtxPublicIngestProject {
  const config = buildDefaultKtxProjectConfig();
  return {
    projectDir: '/tmp/project',
    config: {
      ...config,
      connections,
      llm: {
        ...config.llm,
        provider: { backend: 'gateway', gateway: { api_key: 'env:KTX_GATEWAY_API_KEY' } }, // pragma: allowlist secret
        models: { default: 'gpt-test' },
      },
      scan: {
        ...config.scan,
        enrichment: {
          mode: 'llm',
          embeddings: {
            backend: 'openai',
            model: 'text-embedding-3-small',
            dimensions: 1536,
          },
        },
      },
    },
  };
}

describe('buildPublicIngestPlan sharepoint', () => {
  it('maps sharepoint connections to the sharepoint source adapter', () => {
    const project = projectWithConnections({
      docs_sharepoint: {
        driver: 'sharepoint',
        tenant_id_ref: 'env:AZURE_TENANT_ID',
        client_id_ref: 'env:AZURE_CLIENT_ID',
        client_secret_ref: 'env:AZURE_CLIENT_SECRET', // pragma: allowlist secret
        drive_id: 'drive-123',
        folder_id: 'folder-456',
      },
    });

    expect(buildPublicIngestPlan(project, { projectDir: '/tmp/project', all: true })).toEqual({
      projectDir: '/tmp/project',
      targets: [
        {
          connectionId: 'docs_sharepoint',
          driver: 'sharepoint',
          operation: 'source-ingest',
          adapter: 'sharepoint',
          debugCommand: 'ktx ingest docs_sharepoint --debug',
          steps: ['source-ingest', 'memory-update'],
        },
      ],
      warnings: [],
    });
  });
});
