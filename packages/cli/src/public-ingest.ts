import { getKtxCliPackageInfo } from './cli-runtime.js';
import { loadKtxProject, type KtxLocalProject } from './context/project/project.js';
import type { KtxProjectConfig, KtxProjectConnectionConfig } from './context/project/config.js';
import type { KtxProgressPort } from './context/scan/types.js';
import type { KtxCliIo } from './index.js';
import type { KtxIngestArgs, KtxIngestDeps, KtxIngestProgressUpdate } from './ingest.js';
import { isDatabaseDriver, normalizeConnectionDriver } from './connection-drivers.js';
import { resolveQueryHistoryScopeFloor } from './context/ingest/adapters/historic-sql/scope-floor.js';
import {
  ensureManagedPythonCommandRuntime,
  type KtxManagedPythonInstallPolicy,
  type ManagedPythonCommandRuntime,
} from './managed-python-command.js';
import type { KtxRuntimeFeature } from './managed-python-runtime.js';
import {
  publicDatabaseIngestMessage,
  publicIngestOutputLine,
  publicQueryHistoryMessage,
} from './public-ingest-copy.js';
import { createAggregateProgressPort } from './progress-port-adapter.js';
import { resolvePublicIngestRuntimeRequirements } from './runtime-requirements.js';
import type { KtxScanArgs, KtxScanDeps } from './scan.js';
import type { KtxScanEnrichmentStage, KtxTableRef } from './context/scan/types.js';
import { profileMark } from './startup-profile.js';
import { isDemoConnection } from './telemetry/demo-detect.js';
import { emitProjectStackSnapshot, emitTelemetryEvent, reportException } from './telemetry/index.js';
import { collectTelemetryRedactionSecrets } from './telemetry/redaction-secrets.js';
import { formatErrorDetail } from './telemetry/scrubber.js';

profileMark('module:public-ingest');

type KtxPublicIngestStepName = 'database-schema' | 'query-history' | 'source-ingest' | 'memory-update';
type KtxPublicIngestStepStatus = 'done' | 'skipped' | 'failed' | 'not-run';
type KtxPublicIngestInputMode = 'auto' | 'disabled';
type KtxPublicIngestQueryHistoryFlag = 'default' | 'enabled' | 'disabled';
type HistoricSqlDialect = 'postgres' | 'bigquery' | 'snowflake';

export type KtxPublicIngestArgs =
  {
    command: 'run';
    projectDir: string;
    targetConnectionId?: string;
    all: boolean;
    json: boolean;
    inputMode: KtxPublicIngestInputMode;
    queryHistory?: KtxPublicIngestQueryHistoryFlag;
    queryHistoryWindowDays?: number;
    scanMode?: Extract<KtxScanArgs, { command: 'run' }>['mode'];
    stages?: KtxScanEnrichmentStage[];
    detectRelationships?: boolean;
    cliVersion?: string;
    runtimeInstallPolicy?: KtxManagedPythonInstallPolicy;
  };

export interface KtxPublicIngestPlanTarget {
  connectionId: string;
  driver: string;
  operation: 'database-ingest' | 'source-ingest';
  adapter?: string;
  sourceDir?: string;
  debugCommand: string;
  steps: KtxPublicIngestStepName[];
  detectRelationships?: boolean;
  preflightFailure?: string;
  queryHistory?: {
    enabled: boolean;
    dialect?: HistoricSqlDialect;
    windowDays?: number;
    pullConfig?: Record<string, unknown>;
    unsupported?: boolean;
  };
}

export interface KtxPublicIngestPlan {
  projectDir: string;
  targets: KtxPublicIngestPlanTarget[];
  warnings: string[];
  notices?: string[];
}

export interface KtxPublicIngestTargetResult {
  connectionId: string;
  driver: string;
  steps: Array<{
    operation: KtxPublicIngestStepName;
    status: KtxPublicIngestStepStatus;
    detail?: string;
    debugCommand?: string;
  }>;
}

export type KtxPublicIngestProject = Pick<KtxLocalProject, 'projectDir' | 'config'>;

type KtxPublicIngestPhaseKey = 'database-schema' | 'query-history' | 'source-ingest';

export interface KtxPublicIngestDeps {
  loadProject?: (options: { projectDir: string }) => Promise<KtxPublicIngestProject>;
  runScan?: (args: KtxScanArgs, io: KtxCliIo, deps?: KtxScanDeps) => Promise<number>;
  runIngest?: (args: KtxIngestArgs, io: KtxCliIo, deps?: KtxIngestDeps) => Promise<number>;
  runContextBuild?: (
    project: KtxPublicIngestProject,
    args: KtxPublicContextBuildArgs,
    io: KtxCliIo,
  ) => Promise<{ exitCode: number }>;
  scanProgress?: KtxProgressPort;
  ingestProgress?: (update: KtxIngestProgressUpdate) => void;
  ensureRuntime?: (options: {
    cliVersion: string;
    installPolicy: KtxManagedPythonInstallPolicy;
    io: KtxCliIo;
    feature: KtxRuntimeFeature;
  }) => Promise<ManagedPythonCommandRuntime>;
  env?: NodeJS.ProcessEnv;
  runtimeIo?: KtxCliIo;
  onPhaseStart?: (phaseKey: KtxPublicIngestPhaseKey) => void;
  onPhaseEnd?: (phaseKey: KtxPublicIngestPhaseKey, status: 'done' | 'failed' | 'skipped', summary?: string) => void;
}

interface KtxPublicContextBuildArgs {
  projectDir: string;
  inputMode: 'auto' | 'disabled';
  targetConnectionId?: string;
  all?: boolean;
  queryHistory?: KtxPublicIngestQueryHistoryFlag;
  queryHistoryWindowDays?: number;
  scanMode?: Extract<KtxScanArgs, { command: 'run' }>['mode'];
  stages?: KtxScanEnrichmentStage[];
  detectRelationships?: boolean;
  cliVersion?: string;
  runtimeInstallPolicy?: KtxManagedPythonInstallPolicy;
}

const sourceAdapterByDriver = new Map<string, string>([
  ['metabase', 'metabase'],
  ['local_metabase', 'metabase'],
  ['looker', 'looker'],
  ['notion', 'notion'],
  ['gdrive', 'gdrive'],
  ['metricflow', 'metricflow'],
  ['dbt', 'dbt'],
  ['lookml', 'lookml'],
  ['sigma', 'sigma'],
]);

export function publicProgressMessage(message: string, target: KtxPublicIngestPlanTarget): string {
  let current = message;
  if (target.operation === 'database-ingest') {
    current = publicDatabaseIngestMessage(current);
  }
  if (target.steps.includes('query-history')) {
    current = publicQueryHistoryMessage(current, target.connectionId);
  }
  return current;
}

const queryHistoryDialectByDriver = new Map<string, HistoricSqlDialect>([
  ['postgres', 'postgres'],
  ['bigquery', 'bigquery'],
  ['snowflake', 'snowflake'],
]);

interface KtxUnsupportedQueryHistoryWarning {
  connectionId: string;
  driver: string;
  reason: 'explicit' | 'stored';
}

interface KtxPublicIngestWarningAccumulator {
  warnings: string[];
  ignoredQueryHistoryForSources: string[];
  unsupportedQueryHistoryForDatabases: KtxUnsupportedQueryHistoryWarning[];
}

function createWarningAccumulator(): KtxPublicIngestWarningAccumulator {
  return {
    warnings: [],
    ignoredQueryHistoryForSources: [],
    unsupportedQueryHistoryForDatabases: [],
  };
}

function sourceIgnoredWarning(option: string, connectionIds: string[], all: boolean): string | null {
  if (connectionIds.length === 0) {
    return null;
  }
  if (all) {
    const sourceLabel =
      connectionIds.length === 1 ? '1 non-database source' : `${connectionIds.length} non-database sources`;
    return `${option} ignored for ${sourceLabel}.`;
  }
  return `${option} affects database ingest only; ignoring it for ${connectionIds[0]}.`;
}

function unsupportedDriverList(entries: KtxUnsupportedQueryHistoryWarning[]): string {
  return [...new Set(entries.map((entry) => entry.driver))]
    .sort((left, right) => left.localeCompare(right))
    .join(', ');
}

function unsupportedQueryHistoryWarnings(
  entries: KtxUnsupportedQueryHistoryWarning[],
  all: boolean,
): string[] {
  if (entries.length === 0) {
    return [];
  }

  const warnings: string[] = [];
  const explicitEntries = entries.filter((entry) => entry.reason === 'explicit');
  const storedEntries = entries.filter((entry) => entry.reason === 'stored');

  if (explicitEntries.length === 1 || (!all && explicitEntries.length > 0)) {
    warnings.push(
      ...explicitEntries.map(
        (entry) =>
          `--query-history is not supported for ${entry.driver}; running schema ingest for ${entry.connectionId}.`,
      ),
    );
  } else if (explicitEntries.length > 1) {
    warnings.push(
      `--query-history is not supported for ${explicitEntries.length} database connections (${unsupportedDriverList(
        explicitEntries,
      )}); running schema ingest for those connections.`,
    );
  }

  if (storedEntries.length === 1 || (!all && storedEntries.length > 0)) {
    warnings.push(
      ...storedEntries.map(
        (entry) =>
          `${entry.connectionId} has query history enabled in ktx.yaml, but ${entry.driver} does not support it; running schema ingest.`,
      ),
    );
  } else if (storedEntries.length > 1) {
    warnings.push(
      `${storedEntries.length} database connections have query history enabled in ktx.yaml, but their drivers do not support it; running schema ingest for those connections.`,
    );
  }

  return warnings;
}

function finalizeWarnings(
  accumulator: KtxPublicIngestWarningAccumulator,
  args: {
    all: boolean;
    queryHistory?: KtxPublicIngestQueryHistoryFlag;
    queryHistoryWindowDays?: number;
  },
): string[] {
  const warnings = [
    ...accumulator.warnings,
    ...unsupportedQueryHistoryWarnings(accumulator.unsupportedQueryHistoryForDatabases, args.all),
  ];
  if (args.queryHistory === 'enabled' || args.queryHistoryWindowDays !== undefined) {
    const warning = sourceIgnoredWarning('--query-history', accumulator.ignoredQueryHistoryForSources, args.all);
    if (warning) warnings.push(warning);
  }
  return warnings;
}

function schemaFirstQueryHistoryNotice(
  targets: KtxPublicIngestPlanTarget[],
  args: { queryHistory?: KtxPublicIngestQueryHistoryFlag },
): string | null {
  if (args.queryHistory !== 'enabled') {
    return null;
  }
  const queryHistoryTargets = targets.filter((target) => target.queryHistory?.enabled === true);
  if (queryHistoryTargets.length === 0) {
    return null;
  }
  if (queryHistoryTargets.length === 1) {
    return `Schema ingest runs before query history for ${queryHistoryTargets[0].connectionId}.`;
  }
  return `Schema ingest runs before query history for ${queryHistoryTargets.length} database connections.`;
}

function storedQueryHistory(connection: KtxProjectConnectionConfig): Record<string, unknown> {
  const context = connection.context;
  const contextRecord =
    context && typeof context === 'object' && !Array.isArray(context) ? (context as Record<string, unknown>) : {};
  const value = contextRecord.queryHistory;
  return typeof value === 'object' && value !== null && !Array.isArray(value) ? (value as Record<string, unknown>) : {};
}

function positiveInteger(value: unknown): number | undefined {
  return typeof value === 'number' && Number.isInteger(value) && value > 0 ? value : undefined;
}

/** @internal */
export function queryHistoryPullConfig(input: {
  stored: Record<string, unknown>;
  dialect: HistoricSqlDialect;
  windowDays?: number;
  enabledTables?: KtxTableRef[];
  enabledSchemas?: string[];
  modeledTableCatalog?: KtxTableRef[];
  scopeFloorWarnings?: string[];
}): Record<string, unknown> {
  const {
    enabled: _enabled,
    dialect: _dialect,
    enabledTables: _enabledTables,
    enabledSchemas: _enabledSchemas,
    scopeFloorWarnings: _scopeFloorWarnings,
    ...storedConfig
  } = input.stored;
  return {
    ...storedConfig,
    dialect: input.dialect,
    ...(input.enabledTables && input.enabledTables.length > 0 ? { enabledTables: input.enabledTables } : {}),
    ...(input.enabledSchemas && input.enabledSchemas.length > 0 ? { enabledSchemas: input.enabledSchemas } : {}),
    ...(input.modeledTableCatalog && input.modeledTableCatalog.length > 0
      ? { modeledTableCatalog: input.modeledTableCatalog }
      : {}),
    ...(input.scopeFloorWarnings && input.scopeFloorWarnings.length > 0
      ? { scopeFloorWarnings: input.scopeFloorWarnings }
      : {}),
    ...(input.windowDays !== undefined ? { windowDays: input.windowDays } : {}),
  };
}

function sourceDirForConnection(connection: KtxProjectConnectionConfig): string | undefined {
  const value = connection.source_dir;
  return typeof value === 'string' && value.trim().length > 0 ? value.trim() : undefined;
}

function resolveDatabaseTargetOptions(input: {
  connectionId: string;
  driver: string;
  connection: KtxProjectConnectionConfig;
  args: {
    queryHistory?: KtxPublicIngestQueryHistoryFlag;
    queryHistoryWindowDays?: number;
    scanMode?: Extract<KtxScanArgs, { command: 'run' }>['mode'];
  };
  warnings: KtxPublicIngestWarningAccumulator;
}): Pick<KtxPublicIngestPlanTarget, 'queryHistory' | 'steps'> {
  const storedQh = storedQueryHistory(input.connection);
  const dialect = queryHistoryDialectByDriver.get(input.driver);
  const explicitQueryHistory = input.args.queryHistory ?? 'default';
  const storedEnabled = storedQh.enabled === true;
  const windowOverrideRequested = input.args.queryHistoryWindowDays !== undefined;
  const requestedQh =
    explicitQueryHistory === 'enabled' ||
    (explicitQueryHistory !== 'disabled' && (windowOverrideRequested || storedEnabled));
  const queryHistory = {
    enabled: false,
    ...(input.args.queryHistoryWindowDays !== undefined
      ? { windowDays: input.args.queryHistoryWindowDays }
      : positiveInteger(storedQh.windowDays) !== undefined
        ? { windowDays: positiveInteger(storedQh.windowDays) }
        : {}),
  };

  if (requestedQh && !dialect) {
    input.warnings.unsupportedQueryHistoryForDatabases.push({
      connectionId: input.connectionId,
      driver: input.driver,
      reason:
        explicitQueryHistory === 'enabled' || input.args.queryHistoryWindowDays !== undefined ? 'explicit' : 'stored',
    });
    return {
      queryHistory: { ...queryHistory, unsupported: true },
      steps: ['database-schema'],
    };
  }

  if (requestedQh && dialect) {
    return {
      queryHistory: {
        ...queryHistory,
        enabled: true,
        dialect,
        pullConfig: queryHistoryPullConfig({
          stored: storedQh,
          dialect,
          windowDays: queryHistory.windowDays,
        }),
      },
      steps: ['database-schema', 'query-history'],
    };
  }

  return {
    queryHistory,
    steps: ['database-schema'],
  };
}

async function resolvedQueryHistoryPullConfigForTarget(
  target: KtxPublicIngestPlanTarget,
  project: KtxPublicIngestProject,
): Promise<Record<string, unknown> | null> {
  if (target.operation !== 'database-ingest' || target.queryHistory?.enabled !== true || !target.queryHistory.dialect) {
    return null;
  }
  const connection = project.config.connections[target.connectionId];
  if (!connection) {
    return (
      target.queryHistory.pullConfig ??
      queryHistoryPullConfig({
        stored: {},
        dialect: target.queryHistory.dialect,
        windowDays: target.queryHistory.windowDays,
      })
    );
  }
  const stored = storedQueryHistory(connection);
  const scopeFloor = await resolveQueryHistoryScopeFloor({
    projectDir: project.projectDir,
    connectionId: target.connectionId,
    driver: target.driver,
    connection: connection as Record<string, unknown>,
    storedQueryHistory: stored,
  });
  return queryHistoryPullConfig({
    stored,
    dialect: target.queryHistory.dialect,
    windowDays: target.queryHistory.windowDays,
    enabledTables: scopeFloor.enabledTables,
    enabledSchemas: scopeFloor.enabledSchemas,
    modeledTableCatalog: scopeFloor.modeledTableCatalog,
    scopeFloorWarnings: scopeFloor.warnings,
  });
}

function enrichmentReadinessGaps(config: KtxProjectConfig): string[] {
  const gaps: string[] = [];
  if (config.llm.provider.backend === 'none' || !config.llm.models.default) {
    gaps.push('model configuration');
  }

  if (config.scan.enrichment.mode !== 'llm') {
    gaps.push('scan enrichment mode');
  }

  const embeddings = config.scan.enrichment.embeddings;
  if (!embeddings || embeddings.backend === 'none' || !embeddings.model || embeddings.dimensions <= 0) {
    gaps.push('scan embeddings');
  }

  return gaps;
}

function targetForConnection(
  connectionId: string,
  connection: KtxProjectConnectionConfig,
  projectConfig: KtxPublicIngestProject['config'],
  args: {
    queryHistory?: KtxPublicIngestQueryHistoryFlag;
    queryHistoryWindowDays?: number;
    scanMode?: Extract<KtxScanArgs, { command: 'run' }>['mode'];
  },
  warnings: KtxPublicIngestWarningAccumulator,
): KtxPublicIngestPlanTarget {
  const driver = normalizeConnectionDriver(connection);
  const adapter = sourceAdapterByDriver.get(driver);
  const sourceDir = sourceDirForConnection(connection);
  if (adapter) {
    if (args.queryHistory === 'enabled' || args.queryHistoryWindowDays !== undefined) {
      warnings.ignoredQueryHistoryForSources.push(connectionId);
    }
    return {
      connectionId,
      driver,
      operation: 'source-ingest',
      adapter,
      ...(sourceDir ? { sourceDir } : {}),
      debugCommand: `ktx ingest ${connectionId} --debug`,
      steps: ['source-ingest', 'memory-update'],
    };
  }

  if (isDatabaseDriver(driver)) {
    const options = resolveDatabaseTargetOptions({ connectionId, driver, connection, args, warnings });
    const gaps = enrichmentReadinessGaps(projectConfig);
    return {
      connectionId,
      driver,
      operation: 'database-ingest',
      debugCommand: `ktx ingest ${connectionId} --debug`,
      detectRelationships: projectConfig.scan.relationships.enabled,
      ...(gaps.length > 0
        ? {
            preflightFailure: `${connectionId} cannot be ingested: enrichment is not configured (${gaps.join(
              ', ',
            )}). Run ktx setup to configure a model and embeddings.`,
          }
        : {}),
      ...options,
    };
  }

  throw new Error(`Connection "${connectionId}" uses unsupported public ingest driver "${driver || 'unknown'}"`);
}

export function buildPublicIngestPlan(
  project: KtxPublicIngestProject,
  args: {
    projectDir: string;
    targetConnectionId?: string;
    all: boolean;
    queryHistory?: KtxPublicIngestQueryHistoryFlag;
    queryHistoryWindowDays?: number;
    scanMode?: Extract<KtxScanArgs, { command: 'run' }>['mode'];
  },
): KtxPublicIngestPlan {
  const allConnections = args.all || !args.targetConnectionId;
  const entries = Object.entries(project.config.connections).sort(([a], [b]) => a.localeCompare(b));
  const selected = allConnections ? entries : entries.filter(([connectionId]) => connectionId === args.targetConnectionId);

  if (!allConnections && selected.length === 0) {
    throw new Error(`Connection "${args.targetConnectionId}" is not configured in ktx.yaml`);
  }
  if (selected.length === 0) {
    throw new Error('No configured connections are eligible for ingest');
  }

  const warnings = createWarningAccumulator();
  const targets = selected.map(([connectionId, connection]) =>
    targetForConnection(connectionId, connection, project.config, args, warnings),
  );
  const orderedTargets = [
    ...targets.filter((t) => t.operation === 'database-ingest'),
    ...targets.filter((t) => t.operation === 'source-ingest'),
  ];
  const notice = schemaFirstQueryHistoryNotice(orderedTargets, args);
  return {
    projectDir: args.projectDir,
    targets: orderedTargets,
    warnings: finalizeWarnings(warnings, args),
    ...(notice ? { notices: [notice] } : {}),
  };
}

function defaultSteps(target: KtxPublicIngestPlanTarget): KtxPublicIngestTargetResult['steps'] {
  return [
    {
      operation: 'database-schema',
      status: target.steps.includes('database-schema') ? 'not-run' : 'skipped',
      ...(target.operation === 'database-ingest' ? { debugCommand: target.debugCommand } : {}),
    },
    {
      operation: 'query-history',
      status: target.steps.includes('query-history') ? 'not-run' : 'skipped',
      ...(target.operation === 'database-ingest' ? { debugCommand: target.debugCommand } : {}),
    },
    {
      operation: 'source-ingest',
      status: target.steps.includes('source-ingest') ? 'not-run' : 'skipped',
      ...(target.operation === 'source-ingest' ? { debugCommand: target.debugCommand } : {}),
    },
    {
      operation: 'memory-update',
      status: target.steps.includes('memory-update') ? 'not-run' : 'skipped',
      ...(target.operation === 'source-ingest' ? { debugCommand: target.debugCommand } : {}),
    },
  ];
}

function retryCommandForTarget(
  target: KtxPublicIngestPlanTarget,
  args: Extract<KtxPublicIngestArgs, { command: 'run' }>,
): string {
  const projectPart = ` --project-dir ${args.projectDir}`;
  const queryHistoryPart = target.queryHistory?.enabled === true ? ' --query-history' : '';
  const windowPart =
    target.queryHistory?.enabled === true && target.queryHistory.windowDays !== undefined
      ? ` --query-history-window-days ${target.queryHistory.windowDays}`
      : '';
  return `ktx ingest ${target.connectionId}${projectPart}${queryHistoryPart}${windowPart}`;
}

function trimTrailingPeriod(value: string): string {
  return value.endsWith('.') ? value.slice(0, -1) : value;
}

function failureDetailWithRetry(input: {
  target: KtxPublicIngestPlanTarget;
  args: Extract<KtxPublicIngestArgs, { command: 'run' }>;
  failedOperation: KtxPublicIngestStepName;
  failureDetail?: string;
}): string {
  const detail = input.failureDetail?.trim();
  const base =
    detail && detail.startsWith(`${input.target.connectionId} `)
      ? detail
      : detail
        ? `${input.target.connectionId} failed: ${detail}`
        : `${input.target.connectionId} failed at ${input.failedOperation}.`;
  return `${trimTrailingPeriod(base)}. Retry: ${retryCommandForTarget(input.target, input.args)}`;
}

function markTargetResult(
  target: KtxPublicIngestPlanTarget,
  args: Extract<KtxPublicIngestArgs, { command: 'run' }>,
  status: 'done' | 'failed',
  failedOperation?: KtxPublicIngestStepName,
  failureDetail?: string,
): KtxPublicIngestTargetResult {
  const selectedFailedOperation =
    failedOperation ?? (target.operation === 'database-ingest' ? 'database-schema' : 'source-ingest');
  const selectedFailedOperationIndex = target.steps.indexOf(selectedFailedOperation);
  return {
    connectionId: target.connectionId,
    driver: target.driver,
    steps: defaultSteps(target).map((step) => {
      if (!target.steps.includes(step.operation)) {
        return step;
      }
      if (status === 'done') {
        return { ...step, status: 'done' };
      }
      const stepIndex = target.steps.indexOf(step.operation);
      if (selectedFailedOperationIndex >= 0 && stepIndex >= 0 && stepIndex < selectedFailedOperationIndex) {
        return { ...step, status: 'done' };
      }
      if (step.operation === selectedFailedOperation) {
        return {
          ...step,
          status: 'failed',
          detail: failureDetailWithRetry({
            target,
            args,
            failedOperation: selectedFailedOperation,
            failureDetail,
          }),
        };
      }
      return { ...step, status: 'not-run' };
    }),
  };
}

function markTargetWithSkippedQueryHistory(
  target: KtxPublicIngestPlanTarget,
  args: Extract<KtxPublicIngestArgs, { command: 'run' }>,
  detail: string,
): KtxPublicIngestTargetResult {
  const baseline = markTargetResult(target, args, 'done');
  return {
    ...baseline,
    steps: baseline.steps.map((step) =>
      step.operation === 'query-history' ? { ...step, status: 'skipped', detail } : step,
    ),
  };
}

function queryHistoryFailureDetail(input: {
  target: KtxPublicIngestPlanTarget;
  args: Extract<KtxPublicIngestArgs, { command: 'run' }>;
  capturedOutput?: string;
}): string {
  const captured = capturedFailureMessage(input.capturedOutput ?? '');
  return failureDetailWithRetry({
    target: input.target,
    args: input.args,
    failedOperation: 'query-history',
    failureDetail: captured,
  });
}

function resultFailed(result: KtxPublicIngestTargetResult): boolean {
  return result.steps.some((step) => step.status === 'failed');
}

function resultSkippedQueryHistory(
  result: KtxPublicIngestTargetResult,
): { connectionId: string; detail: string } | null {
  const skipped = result.steps.find(
    (step) => step.operation === 'query-history' && step.status === 'skipped' && step.detail !== undefined,
  );
  return skipped?.detail ? { connectionId: result.connectionId, detail: skipped.detail } : null;
}

function rowsBucket(): '<10k' | '<100k' | '<1M' | '<10M' | '>=10M' {
  return '<10k';
}

async function emitIngestCompleted(input: {
  args: Extract<KtxPublicIngestArgs, { command: 'run' }>;
  project: KtxPublicIngestProject;
  target: KtxPublicIngestPlanTarget;
  result: KtxPublicIngestTargetResult;
  startedAt: number;
  io: KtxCliIo;
}): Promise<void> {
  const failed = resultFailed(input.result);
  const failureDetail = failed
    ? formatErrorDetail(input.result.steps.find((step) => step.status === 'failed')?.detail)
    : undefined;
  await emitTelemetryEvent({
    name: 'ingest_completed',
    projectDir: input.args.projectDir,
    io: input.io,
    fields: {
      driver: input.target.driver,
      isDemoConnection: isDemoConnection(
        input.target.connectionId,
        input.project.config.connections[input.target.connectionId],
      ),
      schemaCount: 0,
      tableCount: 0,
      columnCount: 0,
      rowsBucket: rowsBucket(),
      durationMs: Math.max(0, performance.now() - input.startedAt),
      outcome: failed ? 'error' : 'ok',
      ...(failureDetail ? { errorDetail: failureDetail } : {}),
    },
  });
}

function stepStatus(result: KtxPublicIngestTargetResult, operation: KtxPublicIngestStepName): string {
  return result.steps.find((step) => step.operation === operation)?.status ?? 'not-run';
}

function renderPlainResults(results: KtxPublicIngestTargetResult[], io: KtxCliIo): void {
  const failures = results.filter(resultFailed);
  const skippedQueryHistory = results.map(resultSkippedQueryHistory).filter((entry) => entry !== null) as Array<{
    connectionId: string;
    detail: string;
  }>;
  const headerSuffix =
    failures.length > 0
      ? ' with partial failures'
      : skippedQueryHistory.length > 0
        ? ' with skipped query history'
        : '';
  io.stdout.write(`Ingest finished${headerSuffix}\n`);
  io.stdout.write('\n');
  io.stdout.write('Source         Database schema  Query history  Source ingest  Memory update\n');
  for (const result of results) {
    io.stdout.write(
      `${result.connectionId.padEnd(14)} ${stepStatus(result, 'database-schema').padEnd(16)} ${stepStatus(
        result,
        'query-history',
      ).padEnd(14)} ${stepStatus(
        result,
        'source-ingest',
      ).padEnd(14)} ${stepStatus(result, 'memory-update')}\n`,
    );
  }

  if (failures.length > 0) {
    io.stdout.write('\nFailed sources:\n');
    for (const result of failures) {
      const failedStep = result.steps.find((step) => step.status === 'failed');
      if (!failedStep) {
        continue;
      }
      io.stdout.write(`  ${failedStep.detail ?? `${result.connectionId} failed.`}\n`);
    }
  }

  if (skippedQueryHistory.length > 0) {
    io.stdout.write('\nSkipped query history:\n');
    for (const { detail } of skippedQueryHistory) {
      io.stdout.write(`  ${detail}\n`);
    }
  }
}

function hasInteractiveInput(io: KtxCliIo): boolean {
  const stdin = (io as { stdin?: { isTTY?: boolean; setRawMode?: (value: boolean) => void } }).stdin;
  return stdin?.isTTY === true && typeof stdin.setRawMode === 'function';
}

function sourceIngestOutputMode(args: Extract<KtxPublicIngestArgs, { command: 'run' }>, io: KtxCliIo): 'plain' | 'viz' {
  return args.inputMode === 'auto' && io.stdout.isTTY === true && hasInteractiveInput(io) ? 'viz' : 'plain';
}

function shouldUseForegroundContextBuildView(
  args: Extract<KtxPublicIngestArgs, { command: 'run' }>,
  io: KtxCliIo,
): boolean {
  return args.inputMode === 'auto' && args.json !== true && io.stdout.isTTY === true && hasInteractiveInput(io);
}

interface CapturedPublicIngestIo extends KtxCliIo {
  capturedOutput(): string;
}

function createCapturedPublicIngestIo(): CapturedPublicIngestIo {
  let output = '';
  return {
    stdout: {
      isTTY: false,
      write(chunk: string) {
        output += chunk;
      },
    },
    stderr: {
      write(chunk: string) {
        output += chunk;
      },
    },
    capturedOutput() {
      return output;
    },
  };
}

function isCapturedPublicIngestIo(io: KtxCliIo): io is CapturedPublicIngestIo {
  return typeof (io as Partial<CapturedPublicIngestIo>).capturedOutput === 'function';
}

const PLAIN_PUBLIC_INGEST_PHASE_LABELS: Record<KtxPublicIngestPhaseKey, string> = {
  'database-schema': 'database schema',
  'query-history': 'query history',
  'source-ingest': 'source ingest',
};

interface PlainPublicIngestProgressOptions {
  target: KtxPublicIngestPlanTarget;
  index: number;
  total: number;
}

function firstSummaryLine(summary: string | undefined): string | undefined {
  if (!summary) return undefined;
  return summary.split(/\r?\n/).find((line) => line.trim().length > 0)?.trim();
}

function plainPhaseHeader(options: PlainPublicIngestProgressOptions, phaseKey: KtxPublicIngestPhaseKey): string {
  const prefix = options.total > 1 ? `[${options.index + 1}/${options.total}] ` : '';
  return `${prefix}${options.target.connectionId} · ${PLAIN_PUBLIC_INGEST_PHASE_LABELS[phaseKey]}`;
}

function plainPhaseEndLine(status: 'done' | 'failed' | 'skipped', summary?: string): string {
  const firstLine = firstSummaryLine(summary);
  return firstLine ? `  ${status} · ${firstLine}` : `  ${status}`;
}

function createPlainPublicIngestProgress(io: KtxCliIo, options: PlainPublicIngestProgressOptions): Required<
  Pick<KtxPublicIngestDeps, 'scanProgress' | 'ingestProgress' | 'onPhaseStart' | 'onPhaseEnd'>
> {
  let currentPhase: KtxPublicIngestPhaseKey | null = null;
  const startedPhases = new Set<KtxPublicIngestPhaseKey>();
  const lastPercentByPhase = new Map<KtxPublicIngestPhaseKey, number>();

  const startPhase = (phaseKey: KtxPublicIngestPhaseKey): void => {
    currentPhase = phaseKey;
    startedPhases.add(phaseKey);
    lastPercentByPhase.set(phaseKey, -1);
    io.stderr.write(`${plainPhaseHeader(options, phaseKey)}\n`);
  };

  const ensurePhaseStarted = (phaseKey: KtxPublicIngestPhaseKey): void => {
    if (!startedPhases.has(phaseKey)) {
      startPhase(phaseKey);
      return;
    }
    currentPhase = phaseKey;
  };

  const emitProgress = (update: KtxIngestProgressUpdate): void => {
    if (currentPhase === null) return;
    const rounded = Math.max(0, Math.min(100, Math.round(update.percent)));
    const lastPercent = lastPercentByPhase.get(currentPhase) ?? -1;
    if (rounded <= lastPercent) return;
    lastPercentByPhase.set(currentPhase, rounded);
    io.stderr.write(`  [${rounded}%] ${publicProgressMessage(update.message, options.target)}\n`);
  };

  return {
    onPhaseStart: startPhase,
    onPhaseEnd(phaseKey, status, summary) {
      ensurePhaseStarted(phaseKey);
      io.stderr.write(`${plainPhaseEndLine(status, summary)}\n`);
      currentPhase = null;
    },
    scanProgress: createAggregateProgressPort(emitProgress),
    ingestProgress: emitProgress,
  };
}

const INTERNAL_STATUS_LINE_RE =
  /^(Report|Run|Job|Status|Adapter|Connection|Sync|Diff|Tasks|Work units|Failed tasks|Saved memory|Provenance rows):\s*/;
const ACTIONABLE_FAILURE_LINE_RE =
  /^(Missing bundled Python runtime manifest|ktx Python runtime is required|ktx daemon HTTP|Error:|Failed\b|Could not\b|Cannot\b)/;
const RUNTIME_BACKED_RETRY_LINE_RE = /^Then retry the runtime-backed ktx command\.?$/;

function trimErrorPrefix(line: string): string {
  return line.replace(/^Error:\s*/, '');
}

function capturedFailureMessage(output: string): string | undefined {
  const lines = output
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter((line) => line.length > 0)
    .filter((line) => !line.startsWith('ktx scan completed'))
    .filter((line) => !INTERNAL_STATUS_LINE_RE.test(line))
    .map(publicIngestOutputLine);

  const actionableIndex = lines.findIndex((line) => ACTIONABLE_FAILURE_LINE_RE.test(line));
  if (actionableIndex < 0) {
    const line = lines.find((candidate) => candidate.length > 0);
    return line ? trimErrorPrefix(line) : undefined;
  }

  const firstLine = lines[actionableIndex];
  if (!firstLine?.startsWith('Missing bundled Python runtime manifest')) {
    return trimErrorPrefix(firstLine);
  }

  const followupLines = lines
    .slice(actionableIndex + 1)
    .filter((line) => !RUNTIME_BACKED_RETRY_LINE_RE.test(line))
    .filter((line) => !/\bRetry:\s/.test(line))
    .filter((line) => line.startsWith('In a source checkout, build the local runtime assets with:'));
  return [firstLine, ...followupLines].join('\n');
}

/**
 * Run one ingest target through its scan/ingest steps. The single per-target
 * chokepoint reached by every entrypoint — standalone `ktx ingest` (plain/json
 * and foreground) and `ktx setup` (via `runContextBuild`). The exported
 * `executePublicIngestTarget` wraps this and emits the `ingest_completed`
 * telemetry event exactly once, so every path is counted.
 */
export async function executePublicIngestTarget(
  target: KtxPublicIngestPlanTarget,
  args: Extract<KtxPublicIngestArgs, { command: 'run' }>,
  io: KtxCliIo,
  deps: KtxPublicIngestDeps,
  project: KtxPublicIngestProject,
): Promise<KtxPublicIngestTargetResult> {
  const startedAt = performance.now();
  const result = await runIngestTargetSteps(target, args, io, deps, project);
  // `io` may be a capture buffer for the scan/ingest step output; the telemetry
  // debug echo belongs on the real user-facing stream, which callers expose as
  // `deps.runtimeIo` (falling back to `io` when the step io is already real).
  await emitIngestCompleted({ args, project, target, result, startedAt, io: deps.runtimeIo ?? io });
  return result;
}

async function runIngestTargetSteps(
  target: KtxPublicIngestPlanTarget,
  args: Extract<KtxPublicIngestArgs, { command: 'run' }>,
  io: KtxCliIo,
  deps: KtxPublicIngestDeps,
  project: KtxPublicIngestProject,
): Promise<KtxPublicIngestTargetResult> {
  if (target.preflightFailure) {
    if (target.operation === 'database-ingest') {
      deps.onPhaseEnd?.('database-schema', 'failed', target.preflightFailure);
      if (target.queryHistory?.enabled === true) {
        deps.onPhaseEnd?.('query-history', 'skipped');
      }
    } else {
      deps.onPhaseEnd?.('source-ingest', 'failed', target.preflightFailure);
    }
    return {
      connectionId: target.connectionId,
      driver: target.driver,
      steps: defaultSteps(target).map((step) =>
        step.operation === 'database-schema'
          ? {
              ...step,
              status: 'failed',
              detail: `${target.connectionId} failed: ${target.preflightFailure}`,
            }
          : step,
      ),
    };
  }

  if (target.operation === 'database-ingest') {
    const { runKtxScan } = await import('./scan.js');
    const scanArgs: KtxScanArgs = {
      command: 'run',
      projectDir: args.projectDir,
      connectionId: target.connectionId,
      mode: 'enriched',
      detectRelationships: target.detectRelationships === true,
      dryRun: false,
      ...(args.stages ? { stages: args.stages } : {}),
      ...(args.cliVersion ? { cliVersion: args.cliVersion } : {}),
      ...(args.runtimeInstallPolicy ? { runtimeInstallPolicy: args.runtimeInstallPolicy } : {}),
    };
    const runScan = deps.runScan ?? runKtxScan;
    const capturedScanIo = deps.scanProgress
      ? isCapturedPublicIngestIo(io)
        ? io
        : null
      : createCapturedPublicIngestIo();
    const scanIo = capturedScanIo ?? io;
    const scanDeps = {
      ...(deps.scanProgress ? { progress: deps.scanProgress } : {}),
      ...(deps.runtimeIo ? { runtimeIo: deps.runtimeIo } : {}),
    };
    deps.onPhaseStart?.('database-schema');
    const scanExitCode =
      Object.keys(scanDeps).length > 0 ? await runScan(scanArgs, scanIo, scanDeps) : await runScan(scanArgs, scanIo);
    if (scanExitCode !== 0) {
      deps.onPhaseEnd?.('database-schema', 'failed');
      if (target.queryHistory?.enabled === true) {
        deps.onPhaseEnd?.('query-history', 'skipped');
      }
      return markTargetResult(
        target,
        args,
        'failed',
        'database-schema',
        capturedScanIo ? capturedFailureMessage(capturedScanIo.capturedOutput()) : undefined,
      );
    }
    deps.onPhaseEnd?.('database-schema', 'done');

    if (target.queryHistory?.enabled === true) {
      const { runKtxIngest } = await import('./ingest.js');
      const runIngest = deps.runIngest ?? runKtxIngest;
      const historicSqlPullConfigOverride =
        (await resolvedQueryHistoryPullConfigForTarget(target, project)) ?? {
          dialect: target.queryHistory.dialect,
          ...(target.queryHistory.windowDays !== undefined ? { windowDays: target.queryHistory.windowDays } : {}),
        };
      const ingestArgs: KtxIngestArgs = {
        command: 'run',
        projectDir: args.projectDir,
        connectionId: target.connectionId,
        adapter: 'historic-sql',
        outputMode: sourceIngestOutputMode(args, io),
        inputMode: args.inputMode,
        ...(args.cliVersion ? { cliVersion: args.cliVersion } : {}),
        ...(args.runtimeInstallPolicy ? { runtimeInstallPolicy: args.runtimeInstallPolicy } : {}),
        allowImplicitAdapter: true,
        historicSqlPullConfigOverride,
      };
      // Query history runs after the schema scan has already written its report
      // into the shared target io, so it needs a phase-local capture. Reusing
      // `io` here would let leftover scan text (e.g. "Mode: enriched") surface as
      // the query-history failure detail. Only skip capture when progress is
      // active and the caller manages its own buffer (io is not a capture).
      const capturedIngestIo =
        deps.ingestProgress && !isCapturedPublicIngestIo(io) ? null : createCapturedPublicIngestIo();
      const ingestIo = capturedIngestIo ?? io;
      const ingestDeps = {
        ...(deps.ingestProgress ? { progress: deps.ingestProgress } : {}),
        ...(deps.runtimeIo ? { runtimeIo: deps.runtimeIo } : {}),
      };
      deps.onPhaseStart?.('query-history');
      const qhExitCode =
        Object.keys(ingestDeps).length > 0
          ? await runIngest(ingestArgs, ingestIo, ingestDeps)
          : await runIngest(ingestArgs, ingestIo);
      if (qhExitCode !== 0) {
        const detail = queryHistoryFailureDetail({
          target,
          args,
          capturedOutput: capturedIngestIo ? capturedIngestIo.capturedOutput() : undefined,
        });
        deps.onPhaseEnd?.('query-history', 'failed', detail);
        return markTargetWithSkippedQueryHistory(target, args, detail);
      }
      deps.onPhaseEnd?.('query-history', 'done');
    }

    return markTargetResult(target, args, 'done');
  }

  const { runKtxIngest } = await import('./ingest.js');
  const ingestArgs: KtxIngestArgs = {
    command: 'run',
    projectDir: args.projectDir,
    connectionId: target.connectionId,
    adapter: target.adapter ?? target.driver,
    ...(target.sourceDir ? { sourceDir: target.sourceDir } : {}),
    outputMode: sourceIngestOutputMode(args, io),
    inputMode: args.inputMode,
    ...(args.cliVersion ? { cliVersion: args.cliVersion } : {}),
    ...(args.runtimeInstallPolicy ? { runtimeInstallPolicy: args.runtimeInstallPolicy } : {}),
    allowImplicitAdapter: true,
  };
  const runIngest = deps.runIngest ?? runKtxIngest;
  const capturedIngestIo = deps.ingestProgress
    ? isCapturedPublicIngestIo(io)
      ? io
      : null
    : createCapturedPublicIngestIo();
  const ingestIo = capturedIngestIo ?? io;
  const ingestDeps = {
    ...(deps.ingestProgress ? { progress: deps.ingestProgress } : {}),
    ...(deps.runtimeIo ? { runtimeIo: deps.runtimeIo } : {}),
  };
  deps.onPhaseStart?.('source-ingest');
  const exitCode =
    Object.keys(ingestDeps).length > 0
      ? await runIngest(ingestArgs, ingestIo, ingestDeps)
      : await runIngest(ingestArgs, ingestIo);
  deps.onPhaseEnd?.('source-ingest', exitCode === 0 ? 'done' : 'failed');
  return markTargetResult(
    target,
    args,
    exitCode === 0 ? 'done' : 'failed',
    'source-ingest',
    capturedIngestIo ? capturedFailureMessage(capturedIngestIo.capturedOutput()) : undefined,
  );
}

export async function runKtxPublicIngest(
  args: KtxPublicIngestArgs,
  io: KtxCliIo,
  deps: KtxPublicIngestDeps = {},
): Promise<number> {
  const loadProject =
    deps.loadProject ?? ((options: { projectDir: string }) => loadKtxProject({ projectDir: options.projectDir }));
  const project = await loadProject({ projectDir: args.projectDir });
  if (shouldUseForegroundContextBuildView(args, io)) {
    const plan = buildPublicIngestPlan(project, args);
    const requirements = resolvePublicIngestRuntimeRequirements(plan, {
      config: project.config,
      env: deps.env ?? process.env,
    });
    const ensureRuntime = deps.ensureRuntime ?? ensureManagedPythonCommandRuntime;
    for (const feature of requirements.features) {
      try {
        await ensureRuntime({
          cliVersion: args.cliVersion ?? getKtxCliPackageInfo().version,
          installPolicy: args.runtimeInstallPolicy ?? 'prompt',
          io,
          feature,
        });
      } catch (error) {
        await reportException({
          error,
          context: { source: 'ingest runtime', handled: true, fatal: false },
          projectDir: args.projectDir,
          io,
          redactionSecrets: await collectTelemetryRedactionSecrets({
            project,
            projectDir: args.projectDir,
            connectionId: args.targetConnectionId,
            includeLlm: true,
            includeEmbeddings: true,
            env: deps.env ?? process.env,
          }),
        });
        io.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`);
        return 1;
      }
    }
    const { runContextBuild } = await import('./context-build-view.js');
    const contextBuild = deps.runContextBuild ?? runContextBuild;
    try {
      const result = await contextBuild(
        project,
        {
          projectDir: args.projectDir,
          ...(args.targetConnectionId ? { targetConnectionId: args.targetConnectionId } : {}),
          all: args.all,
          entrypoint: 'ingest',
          inputMode: args.inputMode,
          ...(args.queryHistory ? { queryHistory: args.queryHistory } : {}),
          ...(args.queryHistoryWindowDays !== undefined ? { queryHistoryWindowDays: args.queryHistoryWindowDays } : {}),
          ...(args.scanMode ? { scanMode: args.scanMode } : {}),
          ...(args.stages ? { stages: args.stages } : {}),
          ...(args.detectRelationships !== undefined ? { detectRelationships: args.detectRelationships } : {}),
          ...(args.cliVersion ? { cliVersion: args.cliVersion } : {}),
          ...(args.runtimeInstallPolicy ? { runtimeInstallPolicy: args.runtimeInstallPolicy } : {}),
        },
        io,
      );
      return result.exitCode;
    } catch (error) {
      await reportException({
        error,
        context: { source: 'ingest context-build', handled: true, fatal: false },
        projectDir: args.projectDir,
        io,
        redactionSecrets: await collectTelemetryRedactionSecrets({
          project,
          projectDir: args.projectDir,
          connectionId: args.targetConnectionId,
          includeLlm: true,
          includeEmbeddings: true,
          env: deps.env ?? process.env,
        }),
      });
      io.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`);
      return 1;
    }
  }

  const plan = buildPublicIngestPlan(project, args);
  const results: KtxPublicIngestTargetResult[] = [];

  if (!args.json) {
    for (const notice of plan.notices ?? []) {
      io.stdout.write(`${notice}\n`);
    }
    for (const warning of plan.warnings) {
      io.stderr.write(`Warning: ${warning}\n`);
    }
  }

  for (const [index, target] of plan.targets.entries()) {
    if (args.json) {
      results.push(await executePublicIngestTarget(target, args, io, deps, project));
      continue;
    }

    const capture = createCapturedPublicIngestIo();
    const progress = createPlainPublicIngestProgress(io, {
      target,
      index,
      total: plan.targets.length,
    });
    const targetDeps: KtxPublicIngestDeps = {
      ...deps,
      scanProgress: progress.scanProgress,
      ingestProgress: progress.ingestProgress,
      onPhaseStart: progress.onPhaseStart,
      onPhaseEnd: progress.onPhaseEnd,
      runtimeIo: deps.runtimeIo ?? io,
    };
    results.push(await executePublicIngestTarget(target, args, capture, targetDeps, project));
  }

  if (args.json) {
    io.stdout.write(`${JSON.stringify({ plan, results }, null, 2)}\n`);
  } else {
    renderPlainResults(results, io);
  }

  await emitProjectStackSnapshot({ projectDir: args.projectDir, io });

  return results.some(resultFailed) ? 1 : 0;
}
