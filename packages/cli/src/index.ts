import { profileMark } from './startup-profile.js';

export {
  getKtxCliPackageInfo,
  packageInfoFromJson,
  runInitForCommander,
  runKtxCli,
  type KtxCliDeps,
  type KtxCliIo,
  type KtxCliPackageInfo,
} from './cli-runtime.js';
export { runKtxSetup, type KtxSetupArgs, type KtxSetupStatus } from './setup.js';
export type {
  KtxSetupDatabaseDriver,
  KtxSetupDatabasesArgs,
  KtxSetupDatabasesDeps,
  KtxSetupDatabasesResult,
} from './setup-databases.js';
export { runKtxSetupDatabasesStep } from './setup-databases.js';
export type {
  KtxSetupEmbeddingBackend,
  KtxSetupEmbeddingsArgs,
  KtxSetupEmbeddingsDeps,
  KtxSetupEmbeddingsResult,
} from './setup-embeddings.js';
export { runKtxSetupEmbeddingsStep } from './setup-embeddings.js';
export type {
  KtxSetupSourcesArgs,
  KtxSetupSourcesDeps,
  KtxSetupSourcesPromptAdapter,
  KtxSetupSourcesResult,
  KtxSetupSourceType,
} from './setup-sources.js';
export { runKtxSetupSourcesStep } from './setup-sources.js';
export { runKtxRuntime, type KtxRuntimeArgs, type KtxRuntimeDeps } from './runtime.js';
export { runKtxSql, type KtxSqlArgs, type KtxSqlDeps } from './sql.js';
export { runKtxMongoQuery, type KtxMongoQueryArgs, type KtxMongoQueryCliDeps } from './mongo-query.js';
export {
  allocateDaemonPort,
  readManagedPythonDaemonStatus,
  stopAllManagedPythonDaemons,
  startManagedPythonDaemon,
  stopManagedPythonDaemon,
} from './managed-python-daemon.js';
export type {
  ManagedPythonDaemonProcessInfo,
  ManagedPythonDaemonStartResult,
  ManagedPythonDaemonState,
  ManagedPythonDaemonStatus,
  ManagedPythonDaemonStopAllEntry,
  ManagedPythonDaemonStopAllFailure,
  ManagedPythonDaemonStopAllResult,
  ManagedPythonDaemonStopResult,
} from './managed-python-daemon.js';
export {
  ensureManagedLocalEmbeddingsDaemon,
  managedLocalEmbeddingHealthConfig,
  type ManagedLocalEmbeddingsDaemon,
  type ManagedLocalEmbeddingsOptions,
} from './managed-local-embeddings.js';
export type { KtxMemoryFlowTuiIo, MemoryFlowTuiLiveSession } from './memory-flow-tui.js';
export {
  renderMemoryFlowTui,
  sanitizeMemoryFlowTuiError,
  startLiveMemoryFlowTui,
} from './memory-flow-tui.js';
export { rendererUnavailableVizFallback, resolveVizFallback, warnVizFallbackOnce } from './viz-fallback.js';

profileMark('module:index');
