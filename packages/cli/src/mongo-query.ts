import { runMongoQuery } from './context/mcp/mongo-query-runner.js';
import { resolveConfiguredConnection } from './context/connections/resolve-connection.js';
import { loadKtxProject, type KtxLocalProject } from './context/project/project.js';
import type { KtxMongoQueryInput } from './context/scan/types.js';
import type { KtxCliIo } from './cli-runtime.js';
import { type KtxOutputMode, resolveOutputMode } from './io/mode.js';
import { type KtxResultTable, printResultTable } from './io/result-table.js';
import { createKtxCliScanConnector } from './local-scan-connectors.js';
import { profileMark } from './startup-profile.js';
import { isDemoConnection } from './telemetry/demo-detect.js';
import { emitTelemetryEvent, reportException } from './telemetry/index.js';
import { collectTelemetryRedactionSecrets } from './telemetry/redaction-secrets.js';
import { scrubErrorClass } from './telemetry/scrubber.js';

profileMark('module:mongo-query');

export type KtxMongoQueryArgs = KtxMongoQueryInput & {
  projectDir: string;
  output?: KtxOutputMode;
  json?: boolean;
  cliVersion: string;
};

export interface KtxMongoQueryCliDeps {
  loadProject?: typeof loadKtxProject;
  createScanConnector?: typeof createKtxCliScanConnector;
}

export async function runKtxMongoQuery(
  args: KtxMongoQueryArgs,
  io: KtxCliIo = process,
  deps: KtxMongoQueryCliDeps = {},
): Promise<number> {
  const startedAt = performance.now();
  let driver = 'unknown';
  let demoConnection = false;
  let project: KtxLocalProject | undefined;
  try {
    project = await (deps.loadProject ?? loadKtxProject)({ projectDir: args.projectDir });
    const connection = resolveConfiguredConnection(project.config, args.connectionId);
    driver = String(connection?.driver ?? 'unknown').toLowerCase();
    demoConnection = isDemoConnection(args.connectionId, connection);

    const createScanConnector = deps.createScanConnector ?? createKtxCliScanConnector;
    const result = await runMongoQuery((connectionId) => createScanConnector(project!, connectionId), {
      connectionId: args.connectionId,
      collection: args.collection,
      database: args.database,
      pipeline: args.pipeline,
      limit: args.limit,
    });

    const output: KtxResultTable = {
      connectionId: args.connectionId,
      headers: result.headers,
      rows: result.rows,
      rowCount: result.rowCount,
    };
    const mode = resolveOutputMode({ explicit: args.output, json: args.json, io });
    printResultTable(output, mode, io);
    await emitTelemetryEvent({
      name: 'mongo_query_completed',
      projectDir: args.projectDir,
      io,
      fields: {
        driver,
        isDemoConnection: demoConnection,
        stageCount: args.pipeline.length,
        durationMs: Math.max(0, performance.now() - startedAt),
        outcome: 'ok',
      },
    });
    return 0;
  } catch (error) {
    const errorClass = scrubErrorClass(error);
    await emitTelemetryEvent({
      name: 'mongo_query_completed',
      projectDir: args.projectDir,
      io,
      fields: {
        driver,
        isDemoConnection: demoConnection,
        stageCount: args.pipeline.length,
        durationMs: Math.max(0, performance.now() - startedAt),
        outcome: 'error',
        ...(errorClass ? { errorClass } : {}),
      },
    });
    await reportException({
      error,
      context: { source: 'mongo-query run', handled: true, fatal: false },
      projectDir: args.projectDir,
      io,
      redactionSecrets: await collectTelemetryRedactionSecrets({
        project,
        projectDir: args.projectDir,
        connectionId: args.connectionId,
        includeLlm: false,
        includeEmbeddings: false,
        env: process.env,
      }),
    });
    io.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`);
    return 1;
  }
}
