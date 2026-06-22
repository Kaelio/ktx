import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { buildProjectStackSnapshotFields } from '../../src/telemetry/project-snapshot.js';

describe('buildProjectStackSnapshotFields', () => {
  let projectDir: string;

  beforeEach(async () => {
    projectDir = await mkdtemp(join(tmpdir(), 'ktx-stack-snapshot-'));
  });

  afterEach(async () => {
    await rm(projectDir, { recursive: true, force: true });
  });

  it('summarizes connectors and project capabilities without names or paths', async () => {
    await mkdir(join(projectDir, 'semantic-layer', 'warehouse'), { recursive: true });
    await mkdir(join(projectDir, 'wiki', 'global'), { recursive: true });
    await writeFile(join(projectDir, 'semantic-layer', 'warehouse', 'orders.yaml'), 'name: orders\n');
    await writeFile(join(projectDir, 'wiki', 'global', 'revenue.md'), '# Revenue\n');
    await writeFile(join(projectDir, '.mcp.json'), '{"mcpServers":{"ktx":{}}}\n');

    const fields = await buildProjectStackSnapshotFields({
      projectDir,
      config: {
        connections: {
          orbit_demo: { driver: 'sqlite', path: join(projectDir, 'demo.db') },
          warehouse: { driver: 'postgres', readonly: true },
        },
        ingest: {
          adapters: [],
          embeddings: { backend: 'sentence-transformers', dimensions: 384 },
          workUnits: { stepBudget: 40, maxConcurrency: 1, failureMode: 'continue' },
          rateLimit: {
            enabled: true,
            throttleThreshold: 0.8,
            minConcurrencyUnderPressure: 1,
            retry: {
              maxAttempts: 6,
              baseDelayMs: 1_000,
              maxDelayMs: 60_000,
              jitter: true,
            },
          },
          profile: false,
        },
        llm: { provider: { backend: 'none' }, models: {}, promptCaching: {} },
        scan: {
          enrichment: { mode: 'none' },
          relationships: {
            enabled: true,
            llmProposals: true,
            validationRequiredForManifest: true,
            acceptThreshold: 0.85,
            reviewThreshold: 0.55,
            maxLlmTablesPerBatch: 40,
            maxCandidatesPerColumn: 25,
            profileSampleRows: 10000,
            profileConcurrency: 4,
            validationConcurrency: 4,
            detectionBudgetMs: 600000,
          },
        },
        storage: {
          state: 'sqlite',
          search: 'sqlite-fts5',
          git: { author: 'ktx <ktx@example.com>' },
        },
        agent: { run_research: { enabled: false, max_iterations: 20, default_toolset: [] } },
      },
    });

    expect(fields).toEqual({
      connectors: [
        { driver: 'sqlite', isDemo: true },
        { driver: 'postgres', isDemo: false },
      ],
      connectionCount: 2,
      hasSl: true,
      hasWiki: true,
      hasMcp: true,
      hasManagedRuntime: true,
    });
    expect(JSON.stringify(fields)).not.toContain(projectDir);
    expect(JSON.stringify(fields)).not.toContain('warehouse');
  });
});
