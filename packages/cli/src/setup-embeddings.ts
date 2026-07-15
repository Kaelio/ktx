import { readFile, writeFile } from 'node:fs/promises';
import { resolveKtxConfigReference } from './context/core/config-reference.js';
import { type KtxProjectConfig, type KtxProjectEmbeddingConfig, serializeKtxProjectConfig } from './context/project/config.js';
import { loadKtxProject } from './context/project/project.js';
import { markKtxSetupStateStepComplete, readKtxSetupState } from './context/project/setup-config.js';
import type { KtxEmbeddingConfig } from './llm/types.js';
import { type KtxEmbeddingHealthCheckResult, runKtxEmbeddingHealthCheck } from './llm/embedding-health.js';
import type { KtxCliIo } from './cli-runtime.js';
import { createCliSpinner, errorMessage, writePrefixedLines, type KtxCliSpinner } from './clack.js';
import {
  ensureManagedLocalEmbeddingsDaemon,
  managedLocalEmbeddingHealthConfig,
  type ManagedLocalEmbeddingsDaemon,
} from './managed-local-embeddings.js';
import { ManagedPythonDaemonStartError } from './managed-python-daemon.js';
import type { KtxManagedPythonInstallPolicy } from './managed-python-command.js';
import { withTextInputNavigation } from './prompt-navigation.js';
import { envCredentialReference, writeProjectLocalSecretReference } from './setup-secrets.js';
import {
  createKtxSetupPromptAdapter,
  type KtxSetupPromptOption,
} from './setup-prompts.js';

export type KtxSetupEmbeddingBackend = 'openai' | 'sentence-transformers';

export interface KtxSetupEmbeddingsArgs {
  projectDir: string;
  inputMode: 'auto' | 'disabled';
  cliVersion: string;
  runtimeInstallPolicy: KtxManagedPythonInstallPolicy;
  embeddingBackend?: KtxSetupEmbeddingBackend;
  embeddingApiKeyEnv?: string;
  embeddingApiKeyFile?: string;
  embeddingBaseUrl?: string;
  embeddingModel?: string;
  embeddingDimensions?: number;
  embeddingBatchSize?: number;
  forcePrompt?: boolean;
  showPromptInstructions?: boolean;
  skipEmbeddings: boolean;
}

export type KtxSetupEmbeddingsResult =
  | { status: 'ready'; projectDir: string }
  | { status: 'skipped'; projectDir: string }
  | { status: 'back'; projectDir: string }
  | { status: 'missing-input'; projectDir: string }
  | { status: 'failed'; projectDir: string };

/** @internal */
export interface KtxSetupEmbeddingsPromptAdapter {
  select(options: { message: string; options: KtxSetupPromptOption[] }): Promise<string>;
  text(options: { message: string; placeholder?: string }): Promise<string | undefined>;
  password(options: { message: string }): Promise<string | undefined>;
  cancel(message: string): void;
}

export interface KtxSetupEmbeddingsDeps {
  env?: NodeJS.ProcessEnv;
  prompts?: KtxSetupEmbeddingsPromptAdapter;
  healthCheck?: (config: KtxEmbeddingConfig) => Promise<KtxEmbeddingHealthCheckResult>;
  ensureLocalEmbeddings?: (options: {
    cliVersion: string;
    projectDir: string;
    installPolicy: KtxManagedPythonInstallPolicy;
    io: KtxCliIo;
  }) => Promise<ManagedLocalEmbeddingsDaemon>;
  spinner?: () => KtxCliSpinner;
}

type BackendChoice = KtxSetupEmbeddingBackend | 'back';

const DEFAULTS: Record<
  KtxSetupEmbeddingBackend,
  { model: string; dimensions: number; envName?: string; baseUrl?: string; pathPrefix?: string }
> = {
  openai: { model: 'text-embedding-3-small', dimensions: 1536, envName: 'OPENAI_API_KEY' },
  'sentence-transformers': {
    model: 'all-MiniLM-L6-v2',
    dimensions: 384,
    baseUrl: 'http://127.0.0.1:8765',
    pathPrefix: '',
  },
};

const LOCAL_EMBEDDING_BACKEND: KtxSetupEmbeddingBackend = 'sentence-transformers';
const EMBEDDING_OPTION_PROMPT_CONTEXT =
  'ktx uses embeddings for semantic search over semantic-layer sources, wiki context, schema metadata, ' +
  'and relationship evidence.';
const LOCAL_EMBEDDING_HEALTH_TIMEOUT_MS = 120_000;
const LOCAL_EMBEDDING_STDERR_TAIL_LINES = 40;

function createPromptAdapter(): KtxSetupEmbeddingsPromptAdapter {
  return createKtxSetupPromptAdapter({ selectCancelValue: 'back' });
}

async function hasCompletedEmbeddings(projectDir: string, config: KtxProjectConfig): Promise<boolean> {
  return (
    (await readKtxSetupState(projectDir)).completed_steps.includes('embeddings') &&
    config.ingest.embeddings.backend !== 'none' &&
    typeof config.ingest.embeddings.model === 'string' &&
    config.ingest.embeddings.model.length > 0 &&
    config.ingest.embeddings.dimensions > 0
  );
}

function buildProjectEmbeddingConfig(input: {
  backend: KtxSetupEmbeddingBackend;
  model: string;
  dimensions: number;
  credentialRef?: string;
  baseUrlRef?: string;
  batchSize?: number;
}): KtxProjectEmbeddingConfig {
  if (input.backend === 'openai') {
    return {
      backend: 'openai',
      model: input.model,
      dimensions: input.dimensions,
      openai: {
        ...(input.credentialRef ? { api_key: input.credentialRef } : {}),
        ...(input.baseUrlRef ? { base_url: input.baseUrlRef } : {}),
      },
      ...(input.batchSize !== undefined ? { batchSize: input.batchSize } : {}),
    };
  }
  const defaults = DEFAULTS[input.backend];
  return {
    backend: input.backend,
    model: input.model,
    dimensions: input.dimensions,
    sentenceTransformers: {
      base_url: defaults.baseUrl ?? '',
      pathPrefix: defaults.pathPrefix ?? '',
    },
  };
}

function buildHealthConfig(input: {
  backend: KtxSetupEmbeddingBackend;
  model: string;
  dimensions: number;
  credentialValue?: string;
  baseUrl?: string;
}): KtxEmbeddingConfig {
  if (input.backend === 'openai') {
    return {
      backend: 'openai',
      model: input.model,
      dimensions: input.dimensions,
      openai: {
        ...(input.credentialValue ? { apiKey: input.credentialValue } : {}),
        ...(input.baseUrl ? { baseURL: input.baseUrl } : {}),
      },
    };
  }
  const defaults = DEFAULTS[input.backend];
  return {
    backend: input.backend,
    model: input.model,
    dimensions: input.dimensions,
    sentenceTransformers: {
      baseURL: defaults.baseUrl ?? '',
      pathPrefix: defaults.pathPrefix ?? '',
    },
  };
}

function embeddingBackendDisplayName(backend: KtxSetupEmbeddingBackend): string {
  if (backend === 'openai') {
    return 'OpenAI';
  }
  return 'sentence-transformers';
}

async function persistEmbeddingConfig(projectDir: string, embeddings: KtxProjectEmbeddingConfig): Promise<void> {
  const project = await loadKtxProject({ projectDir });
  const config = {
    ...project.config,
    ingest: {
      ...project.config.ingest,
      embeddings,
    },
    scan: {
      ...project.config.scan,
      enrichment: {
        ...project.config.scan.enrichment,
        embeddings,
      },
    },
  };
  await writeFile(project.configPath, serializeKtxProjectConfig(config), 'utf-8');
  await markKtxSetupStateStepComplete(projectDir, 'embeddings');
}

async function chooseCredentialRef(
  backend: Extract<KtxSetupEmbeddingBackend, 'openai'>,
  args: KtxSetupEmbeddingsArgs,
  io: KtxCliIo,
  deps: KtxSetupEmbeddingsDeps,
): Promise<{ status: 'ready'; ref: string; value: string } | { status: 'back' | 'missing-input' }> {
  const env = deps.env ?? process.env;
  if (args.embeddingApiKeyEnv) {
    const ref = envCredentialReference(args.embeddingApiKeyEnv);
    const value = resolveKtxConfigReference(ref, env);
    if (!value) {
      io.stderr.write(`Missing embedding API key: ${args.embeddingApiKeyEnv} is not set.\n`);
      return { status: 'missing-input' };
    }
    return { status: 'ready', ref, value };
  }
  if (args.embeddingApiKeyFile) {
    const ref = `file:${args.embeddingApiKeyFile}`;
    let value: string | undefined;
    try {
      value = resolveKtxConfigReference(ref, env);
    } catch {
      value = undefined;
    }
    if (!value) {
      io.stderr.write(`Missing embedding API key file: ${args.embeddingApiKeyFile}\n`);
      return { status: 'missing-input' };
    }
    return { status: 'ready', ref, value };
  }
  if (args.inputMode === 'disabled') {
    io.stderr.write('Missing embedding API key: pass --embedding-api-key-env or --embedding-api-key-file.\n');
    return { status: 'missing-input' };
  }

  const defaultEnv = DEFAULTS[backend].envName ?? 'EMBEDDING_API_KEY';
  const prompts = deps.prompts ?? createPromptAdapter();
  const choice = await prompts.select({
    message: `How should ktx find your ${embeddingBackendDisplayName(backend)} embedding API key?`,
    options: [
      { value: 'paste', label: 'Paste a key and save it as a local secret file' },
      { value: 'env', label: `Use ${defaultEnv} from the environment` },
      { value: 'back', label: 'Back' },
    ],
  });
  if (choice === 'back') {
    return { status: 'back' };
  }
  if (choice === 'paste') {
    io.stdout.write(
      `│  ${[
        `ktx will save the key in .ktx/secrets/${backend}-api-key with local file permissions,`,
        'then write a file: reference in ktx.yaml.',
      ].join(' ')}\n`,
    );
    const value = await prompts.password({ message: withTextInputNavigation(`${backend} embedding API key`) });
    if (value === undefined) {
      return { status: 'back' };
    }
    if (!value.trim()) {
      return { status: 'missing-input' };
    }
    const ref = await writeProjectLocalSecretReference({
      projectDir: args.projectDir,
      fileName: `${backend}-api-key`,
      value,
    });
    return { status: 'ready', ref, value: value.trim() };
  }

  const ref = envCredentialReference(defaultEnv);
  const value = resolveKtxConfigReference(ref, env);
  if (!value) {
    io.stderr.write(`Missing embedding API key: ${defaultEnv} is not set.\n`);
    return { status: 'missing-input' };
  }
  return { status: 'ready', ref, value };
}

async function chooseEmbeddingBackend(
  args: KtxSetupEmbeddingsArgs,
  deps: KtxSetupEmbeddingsDeps,
): Promise<BackendChoice> {
  if (args.embeddingBackend) {
    return args.embeddingBackend;
  }
  if (args.inputMode === 'disabled') {
    return LOCAL_EMBEDDING_BACKEND;
  }
  const choice = await (deps.prompts ?? createPromptAdapter()).select({
    message: `Which embedding option should ktx use?\n\n${EMBEDDING_OPTION_PROMPT_CONTEXT}`,
    options: [
      { value: 'sentence-transformers', label: 'Local sentence-transformers embeddings' },
      { value: 'openai', label: 'OpenAI embeddings', hint: 'recommended' },
      { value: 'back', label: 'Back' },
    ],
  });
  if (choice === 'openai' || choice === 'sentence-transformers' || choice === 'back') {
    return choice;
  }
  return 'back';
}

async function readLocalEmbeddingDaemonStderrTail(stderrLog: string | undefined): Promise<string[]> {
  if (!stderrLog) {
    return [];
  }
  try {
    const lines = (await readFile(stderrLog, 'utf8'))
      .split(/\r?\n/)
      .map((line) => line.trimEnd())
      .filter((line) => line.trim().length > 0);
    return lines.slice(-LOCAL_EMBEDDING_STDERR_TAIL_LINES);
  } catch {
    return [];
  }
}

function localEmbeddingSetupMessage(message: string, stderrTail: string[] = []): string {
  const lines = [
    `Local embedding health check failed: ${message}`,
    'Local embeddings use the ktx-managed Python runtime.',
    'Prepare the runtime with: ktx admin runtime start --feature local-embeddings',
    'Use --yes with setup to install and start the runtime without prompting.',
    'The first run may download Python packages and the all-MiniLM-L6-v2 model.',
  ];
  if (stderrTail.length > 0) {
    lines.push('Recent ktx daemon stderr:', ...stderrTail);
  }
  return lines.join('\n');
}

async function promptAfterLocalEmbeddingFailure(
  deps: KtxSetupEmbeddingsDeps,
): Promise<'retry' | Extract<KtxSetupEmbeddingBackend, 'openai'> | 'back'> {
  const choice = await (deps.prompts ?? createPromptAdapter()).select({
    message: 'Local embeddings are not reachable. Start the local ktx daemon, then retry.',
    options: [
      { value: 'retry', label: 'Retry' },
      { value: 'openai', label: 'Use OpenAI embeddings' },
      { value: 'back', label: 'Back' },
    ],
  });
  if (choice === 'openai' || choice === 'back') {
    return choice;
  }
  return 'retry';
}

function healthCheckStartText(backend: KtxSetupEmbeddingBackend, model: string, dimensions: number): string {
  if (backend === LOCAL_EMBEDDING_BACKEND) {
    return `Testing local embeddings (${model})`;
  }
  return `Checking ${backend} embeddings (${model}, ${dimensions} dimensions).`;
}

function startHealthCheckProgress(
  spinner: KtxCliSpinner,
  message: string,
): { succeed(msg: string): void; fail(msg: string): void } {
  spinner.start(message);
  return {
    succeed(msg: string) {
      spinner.stop(msg);
    },
    fail(msg: string) {
      spinner.error(msg);
    },
  };
}

async function resolveOpenAiEmbeddingParams(
  args: KtxSetupEmbeddingsArgs,
  io: KtxCliIo,
  deps: KtxSetupEmbeddingsDeps,
): Promise<
  | { status: 'ready'; model: string; dimensions: number; baseUrlRef?: string; baseUrlValue?: string; batchSize?: number }
  | { status: 'back' | 'missing-input' }
> {
  const env = deps.env ?? process.env;
  const defaults = DEFAULTS.openai;

  let baseUrlRef: string | undefined;
  let baseUrlValue: string | undefined;
  if (args.embeddingBaseUrl) {
    let value: string | undefined;
    try {
      value = resolveKtxConfigReference(args.embeddingBaseUrl, env);
    } catch {
      value = undefined;
    }
    if (!value) {
      io.stderr.write(`Missing embedding base URL: ${args.embeddingBaseUrl} could not be resolved.\n`);
      return { status: 'missing-input' };
    }
    baseUrlRef = args.embeddingBaseUrl;
    baseUrlValue = value;
  }

  let model = args.embeddingModel?.trim() || undefined;
  let dimensions = args.embeddingDimensions;
  let batchSize = args.embeddingBatchSize;

  if (args.inputMode !== 'disabled') {
    const prompts = deps.prompts ?? createPromptAdapter();
    if (!args.embeddingBaseUrl) {
      const url = await prompts.text({
        message: withTextInputNavigation(
          'OpenAI-compatible embeddings base URL (leave empty for the default OpenAI endpoint)',
        ),
      });
      if (url === undefined) {
        return { status: 'back' };
      }
      const trimmed = url.trim();
      if (trimmed) {
        baseUrlRef = trimmed;
        baseUrlValue = trimmed;
      }
    }
    if (model === undefined) {
      const value = await prompts.text({
        message: withTextInputNavigation(`Embedding model (default ${defaults.model})`),
      });
      if (value === undefined) {
        return { status: 'back' };
      }
      model = value.trim() || defaults.model;
    }
    if (dimensions === undefined) {
      const value = await prompts.text({
        message: withTextInputNavigation(`Embedding dimensions (default ${defaults.dimensions})`),
      });
      if (value === undefined) {
        return { status: 'back' };
      }
      const trimmed = value.trim();
      if (!trimmed) {
        dimensions = defaults.dimensions;
      } else {
        const parsed = Number.parseInt(trimmed, 10);
        if (!Number.isInteger(parsed) || parsed <= 0) {
          io.stderr.write(`Invalid embedding dimensions: ${trimmed} must be a positive integer.\n`);
          return { status: 'missing-input' };
        }
        dimensions = parsed;
      }
    }
    if (batchSize === undefined) {
      const value = await prompts.text({
        message: withTextInputNavigation(
          'Embedding batch size (max texts per request; leave empty for the provider default; some endpoints cap this, e.g. 10)',
        ),
      });
      if (value === undefined) {
        return { status: 'back' };
      }
      const trimmed = value.trim();
      if (trimmed) {
        const parsed = Number.parseInt(trimmed, 10);
        if (!Number.isInteger(parsed) || parsed <= 0) {
          io.stderr.write(`Invalid embedding batch size: ${trimmed} must be a positive integer.\n`);
          return { status: 'missing-input' };
        }
        batchSize = parsed;
      }
    }
  }

  return {
    status: 'ready',
    model: model ?? defaults.model,
    dimensions: dimensions ?? defaults.dimensions,
    ...(baseUrlRef ? { baseUrlRef } : {}),
    ...(baseUrlValue ? { baseUrlValue } : {}),
    ...(batchSize !== undefined ? { batchSize } : {}),
  };
}

export async function runKtxSetupEmbeddingsStep(
  args: KtxSetupEmbeddingsArgs,
  io: KtxCliIo,
  deps: KtxSetupEmbeddingsDeps = {},
): Promise<KtxSetupEmbeddingsResult> {
  if (args.skipEmbeddings) {
    io.stdout.write('│  Embeddings setup skipped.\n');
    return { status: 'skipped', projectDir: args.projectDir };
  }

  const project = await loadKtxProject({ projectDir: args.projectDir });
  if (
    args.forcePrompt !== true &&
    (await hasCompletedEmbeddings(args.projectDir, project.config)) &&
    !args.embeddingBackend &&
    !args.embeddingApiKeyEnv &&
    !args.embeddingApiKeyFile
  ) {
    io.stdout.write(`│  Embeddings ready: yes (${project.config.ingest.embeddings.model})\n`);
    return { status: 'ready', projectDir: args.projectDir };
  }

  const healthCheck =
    deps.healthCheck ??
    ((config: KtxEmbeddingConfig) =>
      runKtxEmbeddingHealthCheck(config, { timeoutMs: LOCAL_EMBEDDING_HEALTH_TIMEOUT_MS }));
  let selectedBackend: KtxSetupEmbeddingBackend | undefined;

  while (true) {
    if (!selectedBackend) {
      const backend = await chooseEmbeddingBackend(args, deps);
      if (backend === 'back') {
        return { status: 'back', projectDir: args.projectDir };
      }
      selectedBackend = backend;
    }

    const defaults = DEFAULTS[selectedBackend];
    let model = defaults.model;
    let dimensions = defaults.dimensions;
    let credentialRef: string | undefined;
    let credentialValue: string | undefined;
    let baseUrlRef: string | undefined;
    let baseUrlValue: string | undefined;
    let embeddingBatchSize: number | undefined;

    if (selectedBackend === 'openai') {
      const credential = await chooseCredentialRef(selectedBackend, args, io, deps);
      if (credential.status === 'back' && !args.embeddingBackend && args.inputMode !== 'disabled') {
        selectedBackend = undefined;
        continue;
      }
      if (credential.status !== 'ready') {
        return { status: credential.status, projectDir: args.projectDir };
      }
      credentialRef = credential.ref;
      credentialValue = credential.value;

      const params = await resolveOpenAiEmbeddingParams(args, io, deps);
      if (params.status === 'back' && !args.embeddingBackend && args.inputMode !== 'disabled') {
        selectedBackend = undefined;
        continue;
      }
      if (params.status !== 'ready') {
        return { status: params.status, projectDir: args.projectDir };
      }
      model = params.model;
      dimensions = params.dimensions;
      baseUrlRef = params.baseUrlRef;
      baseUrlValue = params.baseUrlValue;
      embeddingBatchSize = params.batchSize;
    }

    let managedLocalEmbeddings: ManagedLocalEmbeddingsDaemon | undefined;
    if (selectedBackend === LOCAL_EMBEDDING_BACKEND) {
      const ensureLocalEmbeddings = deps.ensureLocalEmbeddings ?? ensureManagedLocalEmbeddingsDaemon;
      try {
        managedLocalEmbeddings = await ensureLocalEmbeddings({
          cliVersion: args.cliVersion,
          projectDir: args.projectDir,
          installPolicy: args.runtimeInstallPolicy,
          io,
        });
      } catch (error) {
        const write = (chunk: string) => io.stderr.write(chunk);
        if (error instanceof ManagedPythonDaemonStartError) {
          const tail = await readLocalEmbeddingDaemonStderrTail(error.stderrLog);
          writePrefixedLines(write, localEmbeddingSetupMessage(error.detail, tail));
        } else {
          writePrefixedLines(write, errorMessage(error));
        }
        return { status: 'failed', projectDir: args.projectDir };
      }
    }

    const healthConfig =
      selectedBackend === LOCAL_EMBEDDING_BACKEND && managedLocalEmbeddings
        ? managedLocalEmbeddingHealthConfig({
            baseUrl: managedLocalEmbeddings.baseUrl,
            model,
            dimensions,
          })
        : buildHealthConfig({
            backend: selectedBackend,
            model,
            dimensions,
            credentialValue,
            baseUrl: baseUrlValue,
          });
    const healthSpinner = (deps.spinner ?? (() => createCliSpinner(io)))();
    const progress = startHealthCheckProgress(healthSpinner, healthCheckStartText(selectedBackend, model, dimensions));
    let health: KtxEmbeddingHealthCheckResult;
    try {
      health = await healthCheck(healthConfig);
    } catch (error) {
      progress.fail('Embedding test failed');
      throw error;
    }
    if (health.ok) {
      progress.succeed(`Embedding test passed (${model}, ${dimensions} dimensions)`);
      await persistEmbeddingConfig(
        args.projectDir,
        selectedBackend === LOCAL_EMBEDDING_BACKEND
          ? {
              backend: 'sentence-transformers' as const,
              model,
              dimensions,
            }
          : buildProjectEmbeddingConfig({
              backend: selectedBackend,
              model,
              dimensions,
              credentialRef,
              baseUrlRef,
              batchSize: embeddingBatchSize,
            }),
      );
      io.stdout.write(`│  Embeddings ready: yes (${model}, ${dimensions} dimensions)\n`);
      return { status: 'ready', projectDir: args.projectDir };
    }

    progress.fail('Embedding test failed');
    const stderrTail =
      selectedBackend === 'sentence-transformers'
        ? await readLocalEmbeddingDaemonStderrTail(managedLocalEmbeddings?.stderrLog)
        : [];
    io.stderr.write(
      selectedBackend === 'sentence-transformers'
        ? `${localEmbeddingSetupMessage(health.message, stderrTail)}\n`
        : `Embedding health check failed: ${health.message}\n`,
    );
    if (args.inputMode === 'disabled') {
      return { status: 'failed', projectDir: args.projectDir };
    }
    if (selectedBackend !== 'sentence-transformers' && (args.embeddingApiKeyEnv || args.embeddingApiKeyFile)) {
      return { status: 'failed', projectDir: args.projectDir };
    }
    const nextAction =
      selectedBackend === 'sentence-transformers' ? await promptAfterLocalEmbeddingFailure(deps) : 'retry';
    if (nextAction === 'back') {
      return { status: 'back', projectDir: args.projectDir };
    }
    if (nextAction === 'openai') {
      selectedBackend = nextAction;
    }
  }
}
