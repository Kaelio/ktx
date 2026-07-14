import { execFile } from 'node:child_process';
import { writeFile } from 'node:fs/promises';
import { promisify } from 'node:util';
import { resolveLocalKtxLlmConfig } from './context/llm/local-config.js';
import { runClaudeCodeAuthProbe } from './context/llm/claude-code-runtime.js';
import { formatCodexIsolationWarning } from './context/llm/codex-isolation.js';
import { runCodexAuthProbe } from './context/llm/codex-runtime.js';
import { DEFAULT_CODEX_MODEL } from './context/llm/codex-models.js';
import { resolveKtxConfigReference } from './context/core/config-reference.js';
import { type KtxProjectConfig, type KtxProjectLlmConfig, serializeKtxProjectConfig } from './context/project/config.js';
import { loadKtxProject } from './context/project/project.js';
import { markKtxSetupStateStepComplete } from './context/project/setup-config.js';
import { type KtxModelRole, KTX_MODEL_ROLES, type KtxLlmConfig } from './llm/types.js';
import { type KtxLlmHealthCheckResult, runKtxLlmHealthCheck } from './llm/model-health.js';
import {
  formatClaudeCodePromptCachingWarning,
  ignoredClaudeCodePromptCachingFields,
} from './claude-code-prompt-caching.js';
import { createClackSpinner, type KtxCliSpinner } from './clack.js';
import type { KtxCliIo } from './cli-runtime.js';
import { withTextInputNavigation } from './prompt-navigation.js';
import { envCredentialReference, writeProjectLocalSecretReference } from './setup-secrets.js';
import {
  createKtxSetupPromptAdapter,
  type KtxSetupPromptOption,
} from './setup-prompts.js';

const ESC = String.fromCharCode(0x1b);

function yellow(text: string): string {
  return `${ESC}[33m${text}${ESC}[39m`;
}

export interface KtxSetupModelArgs {
  projectDir: string;
  inputMode: 'auto' | 'disabled';
  llmBackend?: KtxSetupLlmBackend;
  anthropicApiKeyEnv?: string;
  anthropicApiKeyFile?: string;
  vertexProject?: string;
  vertexLocation?: string;
  llmBaseUrl?: string;
  llmModel?: string;
  llmApiKeyEnv?: string;
  llmApiKeyFile?: string;
  forcePrompt?: boolean;
  showPromptInstructions?: boolean;
  skipLlm: boolean;
}

export type KtxSetupModelResult =
  | { status: 'ready'; projectDir: string }
  | { status: 'skipped'; projectDir: string }
  | { status: 'back'; projectDir: string }
  | { status: 'missing-input'; projectDir: string }
  | { status: 'failed'; projectDir: string };

// Single source of truth for the LLM backends a user can pick during setup.
// The CLI arg parser, the interactive prompt, and the missing-backend error all
// derive from this list, so adding a backend is one edit. Order is the prompt's
// preference order (subscription backends first).
const KTX_SETUP_LLM_BACKENDS = ['claude-code', 'codex', 'openai-compatible', 'anthropic', 'vertex'] as const;
export type KtxSetupLlmBackend = (typeof KTX_SETUP_LLM_BACKENDS)[number];

/** Validates a raw CLI or prompt value against the setup-selectable LLM backends. */
export function isKtxSetupLlmBackend(value: string): value is KtxSetupLlmBackend {
  return KTX_SETUP_LLM_BACKENDS.some((backend) => backend === value);
}

// Display labels for the interactive provider prompt. The Record key type forces
// every backend to carry a label, so adding one to KTX_SETUP_LLM_BACKENDS fails
// to compile until its prompt option exists here.
const KTX_SETUP_LLM_BACKEND_LABELS: Record<KtxSetupLlmBackend, string> = {
  'claude-code': 'Claude subscription (Pro/Max)',
  codex: 'Codex subscription',
  'openai-compatible': 'OpenAI-compatible endpoint (base URL + API key)',
  anthropic: 'Anthropic API key',
  vertex: 'Google Vertex AI for Anthropic Claude',
};

/** @internal */
export interface KtxSetupModelPromptAdapter {
  select(options: { message: string; options: KtxSetupPromptOption[] }): Promise<string>;
  autocomplete(options: {
    message: string;
    placeholder?: string;
    options: KtxSetupPromptOption[];
  }): Promise<string>;
  text(options: { message: string; placeholder?: string }): Promise<string | undefined>;
  password(options: { message: string }): Promise<string | undefined>;
  cancel(message: string): void;
}

export interface KtxSetupModelDeps {
  env?: NodeJS.ProcessEnv;
  prompts?: KtxSetupModelPromptAdapter;
  healthCheck?: (config: KtxLlmConfig) => Promise<KtxLlmHealthCheckResult>;
  claudeCodeAuthProbe?: (input: {
    projectDir: string;
    model: string;
    env?: NodeJS.ProcessEnv;
  }) => Promise<{ ok: true } | { ok: false; message: string }>;
  codexAuthProbe?: (input: { projectDir: string; model: string }) => Promise<{ ok: true } | { ok: false; message: string }>;
  readGcloudProject?: () => Promise<string | undefined>;
  listGcloudProjects?: () => Promise<GcloudProjectChoice[]>;
  spinner?: () => KtxCliSpinner;
}

const ANTHROPIC_CREDENTIAL_PROMPT_CONTEXT =
  'ktx uses the key to verify Anthropic model access now and to run ingest agents that turn schemas, SQL, ' +
  'BI metadata, and docs into semantic-layer sources and wiki context. ktx.yaml stores an env: or file: ' +
  'reference, not the raw key.';

const VERTEX_PROJECT_PROMPT_CONTEXT =
  'ktx stores the selected Google Cloud project ID in ktx.yaml and uses Application Default Credentials for ' +
  'access. Project visibility depends on the signed-in Google account and organization permissions.';
const DEFAULT_VERTEX_LOCATION = 'us-east5';

type KtxSetupModelPreset = Record<KtxModelRole, string>;

const ANTHROPIC_PRESET = {
  default: 'claude-sonnet-4-6',
  triage: 'claude-haiku-4-5',
  candidateExtraction: 'claude-sonnet-4-6',
  curator: 'claude-opus-4-7',
  reconcile: 'claude-opus-4-7',
  repair: 'claude-haiku-4-5',
} satisfies KtxSetupModelPreset;

const CLAUDE_CODE_PRESET = {
  default: 'sonnet',
  triage: 'haiku',
  candidateExtraction: 'sonnet',
  curator: 'opus',
  reconcile: 'opus',
  repair: 'haiku',
} satisfies KtxSetupModelPreset;

const CODEX_PRESET = {
  default: DEFAULT_CODEX_MODEL,
  triage: DEFAULT_CODEX_MODEL,
  candidateExtraction: DEFAULT_CODEX_MODEL,
  curator: DEFAULT_CODEX_MODEL,
  reconcile: DEFAULT_CODEX_MODEL,
  repair: DEFAULT_CODEX_MODEL,
} satisfies KtxSetupModelPreset;

const MODEL_PRESETS = {
  anthropic: ANTHROPIC_PRESET,
  vertex: ANTHROPIC_PRESET,
  'claude-code': CLAUDE_CODE_PRESET,
  codex: CODEX_PRESET,
} satisfies Record<Exclude<KtxSetupLlmBackend, 'openai-compatible'>, KtxSetupModelPreset>;

function presetForBackend(backend: Exclude<KtxSetupLlmBackend, 'openai-compatible'>): KtxSetupModelPreset {
  return MODEL_PRESETS[backend];
}

// OpenAI-compatible endpoints expose arbitrary model ids, so the user names one
// model and every role points at it. Per-role overrides remain hand-editable in
// ktx.yaml.
function singleModelPreset(model: string): KtxSetupModelPreset {
  return KTX_MODEL_ROLES.reduce((preset, role) => {
    preset[role] = model;
    return preset;
  }, {} as KtxSetupModelPreset);
}

const execFileAsync = promisify(execFile);

type ChooseBackendResult =
  | { status: 'ready'; backend: KtxSetupLlmBackend; prompted: boolean }
  | { status: 'back' }
  | { status: 'missing-input' };

// Non-interactive setup cannot pick a provider safely: every backend needs
// something the user must supply (an API key, gcloud ADC, or a logged-in local
// CLI), so there is no credential-free default to fall back to. Name the hidden
// --llm-backend flag and its choices here instead, mirroring how the other
// automation errors guide users to the flag they need.
const MISSING_LLM_BACKEND_MESSAGE =
  `Missing LLM backend: pass --llm-backend with one of ${KTX_SETUP_LLM_BACKENDS.join(', ')}. ` +
  'claude-code and codex use local CLI authentication; anthropic also needs --anthropic-api-key-env or ' +
  '--anthropic-api-key-file, vertex also needs --vertex-project, and openai-compatible also needs --llm-base-url ' +
  'and --llm-model (add --llm-api-key-env or --llm-api-key-file when the endpoint requires a key).';

type VertexConfigChoice =
  | {
      status: 'ready';
      refs: { project?: string; location: string };
      values: { project?: string; location: string };
    }
  | { status: 'back' | 'missing-input' };

interface GcloudProjectChoice {
  projectId: string;
  name?: string;
}

function createPromptAdapter(): KtxSetupModelPromptAdapter {
  return createKtxSetupPromptAdapter({ selectCancelValue: 'back' });
}

async function defaultReadGcloudProject(): Promise<string | undefined> {
  try {
    const { stdout } = await execFileAsync('gcloud', ['config', 'get-value', 'project'], { encoding: 'utf8' });
    const value = stdout.trim();
    return value && value !== '(unset)' ? value : undefined;
  } catch {
    return undefined;
  }
}

async function defaultListGcloudProjects(): Promise<GcloudProjectChoice[]> {
  const { stdout } = await execFileAsync('gcloud', ['projects', 'list', '--format=json(projectId,name)'], {
    encoding: 'utf8',
  });
  const parsed = JSON.parse(stdout.trim() || '[]') as unknown;
  if (!Array.isArray(parsed)) {
    return [];
  }

  return parsed
    .map((item): GcloudProjectChoice | undefined => {
      if (!item || typeof item !== 'object') {
        return undefined;
      }
      const record = item as { projectId?: unknown; name?: unknown };
      if (typeof record.projectId !== 'string' || !record.projectId.trim()) {
        return undefined;
      }
      const name = typeof record.name === 'string' && record.name.trim() ? record.name.trim() : undefined;
      return {
        projectId: record.projectId.trim(),
        ...(name ? { name } : {}),
      };
    })
    .filter((project): project is GcloudProjectChoice => Boolean(project));
}

export function isKtxSetupLlmConfigReady(config: KtxProjectLlmConfig): boolean {
  let resolved: KtxLlmConfig | null;
  try {
    resolved = resolveLocalKtxLlmConfig(config, process.env);
  } catch {
    return false;
  }
  if (!resolved) {
    return false;
  }

  if (resolved.backend === 'vertex') {
    return typeof resolved.vertex?.location === 'string' && resolved.vertex.location.trim().length > 0;
  }

  if (resolved.backend === 'openai-compatible') {
    return typeof resolved.openaiCompatible?.baseURL === 'string' && resolved.openaiCompatible.baseURL.trim().length > 0;
  }

  return (
    resolved.backend === 'anthropic' ||
    resolved.backend === 'gateway' ||
    resolved.backend === 'claude-code' ||
    resolved.backend === 'codex'
  );
}

function hasUsableConfiguredLlm(config: KtxProjectConfig): boolean {
  return isKtxSetupLlmConfigReady(config.llm);
}

function buildProjectLlmConfig(
  existing: KtxProjectLlmConfig,
  provider:
    | { backend: 'anthropic'; credentialRef: string }
    | { backend: 'vertex'; vertex: { project?: string; location: string } }
    | { backend: 'openai-compatible'; credentialRef?: string; baseUrl: string }
    | { backend: 'claude-code' }
    | { backend: 'codex' },
  models: KtxSetupModelPreset,
): KtxProjectLlmConfig {
  if (provider.backend === 'claude-code') {
    return {
      provider: { backend: 'claude-code' },
      models,
      promptCaching: existing.promptCaching,
    };
  }

  if (provider.backend === 'codex') {
    return {
      provider: { backend: 'codex' },
      models,
      promptCaching: existing.promptCaching,
    };
  }

  if (provider.backend === 'vertex') {
    return {
      provider: {
        backend: 'vertex',
        vertex: provider.vertex,
      },
      models,
      promptCaching: { ...(existing.promptCaching ?? {}), enabled: true, vertexFallbackTo5m: true },
    };
  }

  if (provider.backend === 'openai-compatible') {
    return {
      provider: {
        backend: 'openai-compatible',
        openaiCompatible: {
          ...(provider.credentialRef ? { api_key: provider.credentialRef } : {}),
          base_url: provider.baseUrl,
        },
      },
      models,
      promptCaching: existing.promptCaching,
    };
  }

  return {
    provider: {
      backend: 'anthropic',
      anthropic: { api_key: provider.credentialRef },
    },
    models,
    promptCaching: { ...(existing.promptCaching ?? {}), enabled: true },
  };
}

function buildAnthropicHealthConfig(credentialValue: string, model: string): KtxLlmConfig {
  return {
    backend: 'anthropic',
    anthropic: { apiKey: credentialValue },
    modelSlots: { default: model },
    promptCaching: { enabled: true },
  };
}

function buildVertexHealthConfig(vertex: { project?: string; location: string }, model: string): KtxLlmConfig {
  return {
    backend: 'vertex',
    vertex,
    modelSlots: { default: model },
    promptCaching: { enabled: true, vertexFallbackTo5m: true },
  };
}

function buildOpenAiCompatibleHealthConfig(baseUrl: string, apiKeyValue: string | undefined, model: string): KtxLlmConfig {
  return {
    backend: 'openai-compatible',
    openaiCompatible: { baseURL: baseUrl, ...(apiKeyValue ? { apiKey: apiKeyValue } : {}) },
    modelSlots: { default: model },
    promptCaching: { enabled: false },
  };
}

type LlmCheckProvider = 'Anthropic API' | 'Vertex AI' | 'Claude subscription' | 'Codex' | 'OpenAI-compatible';

function llmCheckStartText(provider: LlmCheckProvider, model: string): string {
  return `Checking ${provider} LLM (${model}).`;
}

function startLlmCheckProgress(
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

async function validateModelWithProgress(
  provider: LlmCheckProvider,
  model: string,
  deps: KtxSetupModelDeps,
  run: () => Promise<PresetModelValidationResult>,
): Promise<PresetModelValidationResult> {
  const progress = startLlmCheckProgress((deps.spinner ?? createClackSpinner)(), llmCheckStartText(provider, model));
  let result: PresetModelValidationResult;
  try {
    result = await run();
  } catch (error) {
    progress.fail('LLM test failed');
    throw error;
  }
  if (result.ok) {
    progress.succeed(`LLM test passed (${provider}, ${model})`);
  } else {
    progress.fail('LLM test failed');
  }
  return result;
}

function formatVertexHealthFailure(message: string, vertex: { project?: string; location: string }): string {
  const trimmed = message.trim() || 'unknown error';
  if (!/(forbidden|permission|permission_denied|403)/i.test(trimmed)) {
    return trimmed;
  }

  return (
    `${trimmed}. Check that Vertex AI API is enabled for project ${vertex.project ?? '(unknown)'}, ` +
    `Anthropic Claude model access is enabled for location ${vertex.location}, and that your Application Default ` +
    'Credentials principal has Vertex AI User (roles/aiplatform.user) or equivalent permissions.'
  );
}

async function chooseCredentialRef(
  args: KtxSetupModelArgs,
  io: KtxCliIo,
  deps: KtxSetupModelDeps,
): Promise<{ status: 'ready'; ref: string; value: string } | { status: 'back' | 'missing-input' }> {
  const env = deps.env ?? process.env;
  if (args.anthropicApiKeyEnv) {
    const ref = envCredentialReference(args.anthropicApiKeyEnv);
    const value = resolveKtxConfigReference(ref, env);
    if (!value) {
      io.stderr.write(`Missing Anthropic API key: ${args.anthropicApiKeyEnv} is not set.\n`);
      return { status: 'missing-input' };
    }
    return { status: 'ready', ref, value };
  }
  if (args.anthropicApiKeyFile) {
    const ref = `file:${args.anthropicApiKeyFile}`;
    let value: string | undefined;
    try {
      value = resolveKtxConfigReference(ref, env);
    } catch {
      value = undefined;
    }
    if (!value) {
      io.stderr.write(`Missing Anthropic API key file: ${args.anthropicApiKeyFile}\n`);
      return { status: 'missing-input' };
    }
    return { status: 'ready', ref, value };
  }
  if (args.inputMode === 'disabled') {
    io.stderr.write('Missing Anthropic API key: pass --anthropic-api-key-env or --anthropic-api-key-file.\n');
    return { status: 'missing-input' };
  }

  const prompts = deps.prompts ?? createPromptAdapter();
  if (args.showPromptInstructions !== false) {
    io.stdout.write(
      '│  Use Up/Down to move, Enter to confirm the current selection, choose Back to return to the previous step, Ctrl+C to exit.\n',
    );
  }
  while (true) {
    const choice = await prompts.select({
      message: `How should ktx find your Anthropic API key?\n\n${ANTHROPIC_CREDENTIAL_PROMPT_CONTEXT}`,
      options: [
        { value: 'paste', label: 'Paste a key and save it as a local secret file' },
        { value: 'env', label: 'Use ANTHROPIC_API_KEY from the environment' },
        { value: 'back', label: 'Back' },
      ],
    });
    if (choice === 'back') {
      return { status: 'back' };
    }
    if (choice === 'paste') {
      io.stdout.write(
        '│  ktx will save the key in .ktx/secrets/anthropic-api-key with local file permissions, then write a file: reference in ktx.yaml.\n',
      );
      const value = await prompts.password({ message: withTextInputNavigation('Anthropic API key') });
      if (value === undefined) {
        continue;
      }
      if (!value.trim()) {
        return { status: 'missing-input' };
      }
      const ref = await writeProjectLocalSecretReference({
        projectDir: args.projectDir,
        fileName: 'anthropic-api-key',
        value,
      });
      return { status: 'ready', ref, value: value.trim() };
    }

    const ref = envCredentialReference('ANTHROPIC_API_KEY');
    const value = resolveKtxConfigReference(ref, env);
    if (!value) {
      io.stderr.write('Missing Anthropic API key: ANTHROPIC_API_KEY is not set.\n');
      return { status: 'missing-input' };
    }
    return { status: 'ready', ref, value };
  }
}

const OPENAI_COMPATIBLE_PROMPT_CONTEXT =
  'ktx sends chat/completions requests to this OpenAI-compatible endpoint to verify model access now and to run ' +
  'ingest agents that turn schemas, SQL, BI metadata, and docs into semantic-layer sources and wiki context. ' +
  'ktx.yaml stores the base URL and an env: or file: reference for the key, not the raw key.';

async function chooseOpenAiCompatibleBaseUrl(
  args: KtxSetupModelArgs,
  io: KtxCliIo,
  deps: KtxSetupModelDeps,
): Promise<{ status: 'ready'; ref: string; value: string } | { status: 'back' | 'missing-input' }> {
  const env = deps.env ?? process.env;
  if (args.llmBaseUrl) {
    let value: string | undefined;
    try {
      value = resolveKtxConfigReference(args.llmBaseUrl, env);
    } catch {
      value = undefined;
    }
    if (!value) {
      io.stderr.write(`Missing OpenAI-compatible base URL: ${args.llmBaseUrl} could not be resolved.\n`);
      return { status: 'missing-input' };
    }
    return { status: 'ready', ref: args.llmBaseUrl, value };
  }
  if (args.inputMode === 'disabled') {
    io.stderr.write('Missing OpenAI-compatible base URL: pass --llm-base-url.\n');
    return { status: 'missing-input' };
  }

  const prompts = deps.prompts ?? createPromptAdapter();
  const url = await prompts.text({
    message: withTextInputNavigation('OpenAI-compatible base URL (for example https://host/v1)'),
  });
  if (url === undefined) {
    return { status: 'back' };
  }
  const trimmed = url.trim();
  if (!trimmed) {
    return { status: 'missing-input' };
  }
  return { status: 'ready', ref: trimmed, value: trimmed };
}

async function chooseOpenAiCompatibleCredentialRef(
  args: KtxSetupModelArgs,
  io: KtxCliIo,
  deps: KtxSetupModelDeps,
): Promise<{ status: 'ready'; ref?: string; value?: string } | { status: 'back' | 'missing-input' }> {
  const env = deps.env ?? process.env;
  if (args.llmApiKeyEnv) {
    const ref = envCredentialReference(args.llmApiKeyEnv);
    const value = resolveKtxConfigReference(ref, env);
    if (!value) {
      io.stderr.write(`Missing OpenAI-compatible API key: ${args.llmApiKeyEnv} is not set.\n`);
      return { status: 'missing-input' };
    }
    return { status: 'ready', ref, value };
  }
  if (args.llmApiKeyFile) {
    const ref = `file:${args.llmApiKeyFile}`;
    let value: string | undefined;
    try {
      value = resolveKtxConfigReference(ref, env);
    } catch {
      value = undefined;
    }
    if (!value) {
      io.stderr.write(`Missing OpenAI-compatible API key file: ${args.llmApiKeyFile}\n`);
      return { status: 'missing-input' };
    }
    return { status: 'ready', ref, value };
  }
  if (args.inputMode === 'disabled') {
    // Endpoints that need no key are valid; a scripted run without a key flag proceeds keyless.
    return { status: 'ready' };
  }

  const prompts = deps.prompts ?? createPromptAdapter();
  while (true) {
    const choice = await prompts.select({
      message: `How should ktx authenticate to the OpenAI-compatible endpoint?\n\n${OPENAI_COMPATIBLE_PROMPT_CONTEXT}`,
      options: [
        { value: 'paste', label: 'Paste an API key and save it as a local secret file' },
        { value: 'env', label: 'Use an API key from an environment variable' },
        { value: 'none', label: 'No API key required' },
        { value: 'back', label: 'Back' },
      ],
    });
    if (choice === 'back') {
      return { status: 'back' };
    }
    if (choice === 'none') {
      return { status: 'ready' };
    }
    if (choice === 'paste') {
      io.stdout.write(
        '│  ktx will save the key in .ktx/secrets/openai-compatible-api-key with local file permissions, then write a file: reference in ktx.yaml.\n',
      );
      const value = await prompts.password({ message: withTextInputNavigation('OpenAI-compatible API key') });
      if (value === undefined) {
        continue;
      }
      if (!value.trim()) {
        return { status: 'missing-input' };
      }
      const ref = await writeProjectLocalSecretReference({
        projectDir: args.projectDir,
        fileName: 'openai-compatible-api-key',
        value,
      });
      return { status: 'ready', ref, value: value.trim() };
    }

    const envName = await prompts.text({
      message: withTextInputNavigation('Environment variable holding the API key (for example DASHSCOPE_API_KEY)'),
    });
    if (envName === undefined) {
      continue;
    }
    const trimmedName = envName.trim();
    if (!trimmedName) {
      return { status: 'missing-input' };
    }
    const ref = envCredentialReference(trimmedName);
    const value = resolveKtxConfigReference(ref, env);
    if (!value) {
      io.stderr.write(`Missing OpenAI-compatible API key: ${trimmedName} is not set.\n`);
      return { status: 'missing-input' };
    }
    return { status: 'ready', ref, value };
  }
}

async function chooseOpenAiCompatibleModel(
  args: KtxSetupModelArgs,
  io: KtxCliIo,
  deps: KtxSetupModelDeps,
): Promise<{ status: 'ready'; model: string } | { status: 'back' | 'missing-input' }> {
  if (args.llmModel) {
    const trimmed = args.llmModel.trim();
    if (!trimmed) {
      io.stderr.write('Missing OpenAI-compatible model: --llm-model was empty.\n');
      return { status: 'missing-input' };
    }
    return { status: 'ready', model: trimmed };
  }
  if (args.inputMode === 'disabled') {
    io.stderr.write('Missing OpenAI-compatible model: pass --llm-model.\n');
    return { status: 'missing-input' };
  }

  const prompts = deps.prompts ?? createPromptAdapter();
  const model = await prompts.text({
    message: withTextInputNavigation('Model id used for every ktx role (for example qwen3.7-max)'),
  });
  if (model === undefined) {
    return { status: 'back' };
  }
  const trimmed = model.trim();
  if (!trimmed) {
    return { status: 'missing-input' };
  }
  return { status: 'ready', model: trimmed };
}

function requestedBackend(args: KtxSetupModelArgs): KtxSetupLlmBackend | undefined {
  if (args.llmBackend) {
    return args.llmBackend;
  }
  if (args.vertexProject || args.vertexLocation) {
    return 'vertex';
  }
  if (args.anthropicApiKeyEnv || args.anthropicApiKeyFile) {
    return 'anthropic';
  }
  if (args.llmBaseUrl || args.llmModel || args.llmApiKeyEnv || args.llmApiKeyFile) {
    return 'openai-compatible';
  }
  return undefined;
}

async function chooseBackend(
  args: KtxSetupModelArgs,
  io: KtxCliIo,
  deps: KtxSetupModelDeps,
): Promise<ChooseBackendResult> {
  const explicit = requestedBackend(args);
  if (explicit) {
    return { status: 'ready', backend: explicit, prompted: false };
  }
  if (args.inputMode === 'disabled') {
    io.stderr.write(`${MISSING_LLM_BACKEND_MESSAGE}\n`);
    return { status: 'missing-input' };
  }

  const prompts = deps.prompts ?? createPromptAdapter();
  if (args.showPromptInstructions !== false) {
    io.stdout.write(
      '│  Use Up/Down to move, Enter to confirm the current selection, choose Back to return to the previous step, Ctrl+C to exit.\n',
    );
  }
  const choice = await prompts.select({
    message: 'Which LLM provider should ktx use?',
    options: [
      ...KTX_SETUP_LLM_BACKENDS.map((backend) => ({ value: backend, label: KTX_SETUP_LLM_BACKEND_LABELS[backend] })),
      { value: 'back', label: 'Back' },
    ],
  });
  if (choice === 'back') {
    return { status: 'back' };
  }
  if (isKtxSetupLlmBackend(choice)) {
    return { status: 'ready', backend: choice, prompted: true };
  }
  // Options are derived from KTX_SETUP_LLM_BACKENDS, so the only other value is
  // 'back' (handled above). Treat any unexpected value as a cancel rather than
  // silently assuming a provider.
  return { status: 'back' };
}

function resolveProvidedVertexRef(
  label: 'project' | 'location',
  ref: string,
  env: NodeJS.ProcessEnv,
  io: KtxCliIo,
): { status: 'ready'; ref: string; value: string } | { status: 'missing-input' } {
  let value: string | undefined;
  try {
    value = resolveKtxConfigReference(ref, env);
  } catch {
    value = undefined;
  }
  if (!value) {
    io.stderr.write(`Missing Vertex AI ${label}: ${ref} could not be resolved.\n`);
    return { status: 'missing-input' };
  }
  return { status: 'ready', ref, value };
}

function normalizeGcloudProjectId(projectId: string | undefined): string | undefined {
  const trimmed = projectId?.trim();
  return trimmed ? trimmed : undefined;
}

function orderGcloudProjects(projects: GcloudProjectChoice[], currentProject: string | undefined): GcloudProjectChoice[] {
  const ordered: GcloudProjectChoice[] = [];
  const seen = new Set<string>();
  const addProject = (project: GcloudProjectChoice) => {
    const projectId = normalizeGcloudProjectId(project.projectId);
    if (!projectId || seen.has(projectId)) {
      return;
    }
    seen.add(projectId);
    const name = normalizeGcloudProjectId(project.name);
    ordered.push({
      projectId,
      ...(name ? { name } : {}),
    });
  };

  if (currentProject) {
    addProject(projects.find((project) => project.projectId.trim() === currentProject) ?? { projectId: currentProject });
  }
  for (const project of projects) {
    addProject(project);
  }
  return ordered;
}

function formatGcloudProjectLabel(project: GcloudProjectChoice, currentProject: string | undefined): string {
  const name = project.name && project.name !== project.projectId ? ` - ${project.name}` : '';
  const current = project.projectId === currentProject ? ' (current gcloud project)' : '';
  return `${project.projectId}${name}${current}`;
}

function formatGcloudProjectListFailure(error: unknown): string {
  const stderr = typeof (error as { stderr?: unknown })?.stderr === 'string' ? (error as { stderr: string }).stderr : '';
  const message = error instanceof Error ? error.message : '';
  const details = `${stderr}\n${message}`;
  const reason = /reauthentication failed|cannot prompt/i.test(details)
    ? 'gcloud needs reauthentication before it can list projects.'
    : 'gcloud returned an error while listing projects.';
  return [
    `Could not list Google Cloud projects with gcloud: ${reason}`,
    'Run `gcloud auth login --update-adc` in another terminal, then choose Retry loading Google Cloud projects.',
  ]
    .map((line) => yellow(line))
    .join('\n');
}

async function chooseInteractiveVertexProject(
  currentProject: string | undefined,
  io: KtxCliIo,
  deps: KtxSetupModelDeps,
): Promise<{ status: 'ready'; ref: string; value: string } | { status: 'back' | 'missing-input' }> {
  const prompts = deps.prompts ?? createPromptAdapter();
  while (true) {
    let projects: GcloudProjectChoice[] = [];
    let listFailed = false;
    let listFailureMessage: string | undefined;
    try {
      projects = await (deps.listGcloudProjects ?? defaultListGcloudProjects)();
    } catch (error) {
      listFailed = true;
      listFailureMessage = formatGcloudProjectListFailure(error);
    }

    const orderedProjects = orderGcloudProjects(projects, currentProject);
    if (orderedProjects.length === 0 && !listFailed) {
      io.stdout.write('│  gcloud did not return any visible Google Cloud projects. Enter a project ID manually or choose Back.\n');
    }

    const choice = await prompts.autocomplete({
      message: `Which Google Cloud project should ktx use for Vertex AI?\n\n${[
        VERTEX_PROJECT_PROMPT_CONTEXT,
        listFailureMessage,
      ]
        .filter((value): value is string => Boolean(value))
        .join('\n\n')}`,
      placeholder: 'Type to search projects',
      options: [
        ...orderedProjects.map((project) => ({
          value: project.projectId,
          label: formatGcloudProjectLabel(project, currentProject),
        })),
        ...(listFailed ? [{ value: 'retry', label: 'Retry loading Google Cloud projects' }] : []),
        { value: 'manual', label: 'Enter a project ID manually' },
        { value: 'back', label: 'Back' },
      ],
    });
    if (choice === 'back') {
      return { status: 'back' };
    }
    if (choice === 'retry') {
      continue;
    }
    if (choice === 'manual') {
      const manual = await prompts.text({
        message: withTextInputNavigation('Google Cloud project ID'),
        placeholder: currentProject ?? orderedProjects[0]?.projectId,
      });
      if (manual === undefined) {
        return { status: 'back' };
      }
      const project = normalizeGcloudProjectId(manual);
      return project ? { status: 'ready', ref: project, value: project } : { status: 'missing-input' };
    }

    return { status: 'ready', ref: choice, value: choice };
  }
}

async function chooseVertexConfig(
  args: KtxSetupModelArgs,
  io: KtxCliIo,
  deps: KtxSetupModelDeps,
): Promise<VertexConfigChoice> {
  const env = deps.env ?? process.env;
  let projectRef: string | undefined;
  let projectValue: string | undefined;
  let gcloudProject: string | undefined;

  if (args.vertexProject) {
    const project = resolveProvidedVertexRef('project', args.vertexProject, env, io);
    if (project.status !== 'ready') {
      return { status: project.status };
    }
    projectRef = project.ref;
    projectValue = project.value;
  } else if (env.GOOGLE_VERTEX_PROJECT?.trim()) {
    projectRef = envCredentialReference('GOOGLE_VERTEX_PROJECT');
    projectValue = env.GOOGLE_VERTEX_PROJECT.trim();
  } else {
    gcloudProject = normalizeGcloudProjectId(await (deps.readGcloudProject ?? defaultReadGcloudProject)());
    if (args.inputMode === 'disabled') {
      if (gcloudProject) {
        projectRef = gcloudProject;
        projectValue = gcloudProject;
      }
    } else {
      const project = await chooseInteractiveVertexProject(gcloudProject, io, deps);
      if (project.status !== 'ready') {
        return { status: project.status };
      }
      projectRef = project.ref;
      projectValue = project.value;
    }
  }

  let locationRef: string | undefined;
  let locationValue: string | undefined;
  if (args.vertexLocation) {
    const location = resolveProvidedVertexRef('location', args.vertexLocation, env, io);
    if (location.status !== 'ready') {
      return { status: location.status };
    }
    locationRef = location.ref;
    locationValue = location.value;
  } else if (env.GOOGLE_VERTEX_LOCATION?.trim()) {
    locationRef = envCredentialReference('GOOGLE_VERTEX_LOCATION');
    locationValue = env.GOOGLE_VERTEX_LOCATION.trim();
  } else {
    locationRef = DEFAULT_VERTEX_LOCATION;
    locationValue = DEFAULT_VERTEX_LOCATION;
  }

  if (!projectRef || !projectValue) {
    io.stderr.write(
      'Missing Vertex AI project: run `gcloud config set project PROJECT_ID`, pass --vertex-project, or set GOOGLE_VERTEX_PROJECT.\n',
    );
    return { status: 'missing-input' };
  }

  if (!locationRef || !locationValue) {
    io.stderr.write('Missing Vertex AI location: pass --vertex-location.\n');
    return { status: 'missing-input' };
  }

  return {
    status: 'ready',
    refs: {
      ...(projectRef ? { project: projectRef } : {}),
      location: locationRef,
    },
    values: {
      ...(projectValue ? { project: projectValue } : {}),
      location: locationValue,
    },
  };
}

async function persistLlmConfig(
  projectDir: string,
  provider:
    | { backend: 'anthropic'; credentialRef: string }
    | { backend: 'vertex'; vertex: { project?: string; location: string } }
    | { backend: 'openai-compatible'; credentialRef?: string; baseUrl: string }
    | { backend: 'claude-code' }
    | { backend: 'codex' },
  models: KtxSetupModelPreset,
): Promise<void> {
  const project = await loadKtxProject({ projectDir });
  const config = {
    ...project.config,
    llm: buildProjectLlmConfig(project.config.llm, provider, models),
    scan: {
      ...project.config.scan,
      enrichment: {
        ...project.config.scan.enrichment,
        mode: 'llm' as const,
      },
    },
  };
  await writeFile(project.configPath, serializeKtxProjectConfig(config), 'utf-8');
  await markKtxSetupStateStepComplete(projectDir, 'llm');
}

function buildInteractiveRetryArgs(args: KtxSetupModelArgs, backend?: KtxSetupLlmBackend): KtxSetupModelArgs {
  return {
    projectDir: args.projectDir,
    inputMode: args.inputMode,
    ...(backend ?? args.llmBackend ? { llmBackend: backend ?? args.llmBackend } : {}),
    showPromptInstructions: false,
    skipLlm: args.skipLlm,
  };
}

type PresetModelValidationResult = { ok: true } | { ok: false; message: string };

function distinctPresetModels(preset: KtxSetupModelPreset): string[] {
  const models: string[] = [];
  const seen = new Set<string>();
  for (const role of KTX_MODEL_ROLES) {
    const model = preset[role];
    if (!seen.has(model)) {
      seen.add(model);
      models.push(model);
    }
  }
  return models;
}

function rolesUsingModel(preset: KtxSetupModelPreset, model: string): KtxModelRole[] {
  return KTX_MODEL_ROLES.filter((role) => preset[role] === model);
}

function formatPresetFallbackWarning(roles: KtxModelRole[], unavailableModel: string, anchorModel: string): string {
  return `LLM model ${unavailableModel} is unavailable for ${roles.join(', ')}; using ${anchorModel} for those roles.`;
}

async function validatePresetModels(
  preset: KtxSetupModelPreset,
  validateModel: (model: string) => Promise<PresetModelValidationResult>,
  io: KtxCliIo,
): Promise<{ status: 'ready'; models: KtxSetupModelPreset } | { status: 'failed'; message: string }> {
  const anchorModel = preset.default;
  const degraded = { ...preset };
  const models = distinctPresetModels(preset);

  const anchorResult = await validateModel(anchorModel);
  if (!anchorResult.ok) {
    return { status: 'failed', message: anchorResult.message };
  }

  for (const model of models) {
    if (model === anchorModel) {
      continue;
    }
    const result = await validateModel(model);
    if (result.ok) {
      continue;
    }
    const affectedRoles = rolesUsingModel(degraded, model);
    for (const role of affectedRoles) {
      degraded[role] = anchorModel;
    }
    io.stderr.write(`${formatPresetFallbackWarning(affectedRoles, model, anchorModel)}\n`);
  }

  return { status: 'ready', models: degraded };
}

export async function runKtxSetupAnthropicModelStep(
  args: KtxSetupModelArgs,
  io: KtxCliIo,
  deps: KtxSetupModelDeps = {},
): Promise<KtxSetupModelResult> {
  if (args.skipLlm) {
    io.stdout.write('│  LLM setup skipped.\n');
    return { status: 'skipped', projectDir: args.projectDir };
  }

  const project = await loadKtxProject({ projectDir: args.projectDir });
  if (
    args.forcePrompt !== true &&
    hasUsableConfiguredLlm(project.config) &&
    !args.llmBackend &&
    !args.anthropicApiKeyEnv &&
    !args.anthropicApiKeyFile &&
    !args.vertexProject &&
    !args.vertexLocation
  ) {
    io.stdout.write(`│  LLM ready: yes (${project.config.llm.models.default})\n`);
    return { status: 'ready', projectDir: args.projectDir };
  }

  const healthCheck = deps.healthCheck ?? ((config: KtxLlmConfig) => runKtxLlmHealthCheck(config));
  let attemptArgs = args;

  while (true) {
    const backendChoice = await chooseBackend(attemptArgs, io, deps);
    if (backendChoice.status !== 'ready') {
      return { status: backendChoice.status, projectDir: args.projectDir };
    }

    const backendArgs = backendChoice.prompted
      ? ({ ...attemptArgs, llmBackend: backendChoice.backend, showPromptInstructions: false } satisfies KtxSetupModelArgs)
      : attemptArgs;

    if (backendChoice.backend === 'vertex') {
      const vertex = await chooseVertexConfig(backendArgs, io, deps);
      if (vertex.status === 'back' && backendChoice.prompted) {
        attemptArgs = buildInteractiveRetryArgs(args);
        continue;
      }
      if (vertex.status !== 'ready') {
        return { status: vertex.status, projectDir: args.projectDir };
      }

      const preset = presetForBackend('vertex');
      const validation = await validatePresetModels(
        preset,
        (model) =>
          validateModelWithProgress('Vertex AI', model, deps, () => healthCheck(buildVertexHealthConfig(vertex.values, model))),
        io,
      );
      if (validation.status !== 'ready') {
        io.stderr.write(
          `Vertex AI Anthropic model health check failed: ${formatVertexHealthFailure(validation.message, vertex.values)}\n`,
        );
        if (args.inputMode === 'disabled') {
          return { status: 'failed', projectDir: args.projectDir };
        }
        io.stderr.write('Choose a different Vertex AI project or location, or Back.\n');
        attemptArgs = buildInteractiveRetryArgs(args, backendChoice.backend);
        continue;
      }

      await persistLlmConfig(args.projectDir, { backend: 'vertex', vertex: vertex.refs }, validation.models);
      io.stdout.write(`│  LLM ready: yes (${validation.models.default})\n`);
      return { status: 'ready', projectDir: args.projectDir };
    }

    if (backendChoice.backend === 'claude-code') {
      const preset = presetForBackend('claude-code');
      const probe = deps.claudeCodeAuthProbe ?? runClaudeCodeAuthProbe;
      const validation = await validatePresetModels(
        preset,
        (model) =>
          validateModelWithProgress('Claude subscription', model, deps, () =>
            probe({ projectDir: args.projectDir, model, env: deps.env ?? process.env }),
          ),
        io,
      );
      if (validation.status !== 'ready') {
        io.stderr.write(`${validation.message}\n`);
        return { status: 'failed', projectDir: args.projectDir };
      }
      const warning = formatClaudeCodePromptCachingWarning(
        ignoredClaudeCodePromptCachingFields(
          buildProjectLlmConfig(project.config.llm, { backend: 'claude-code' }, validation.models),
        ),
      );
      if (warning) {
        io.stderr.write(`${warning}\n`);
      }
      await persistLlmConfig(args.projectDir, { backend: 'claude-code' }, validation.models);
      io.stdout.write(`│  LLM ready: yes (${validation.models.default})\n`);
      return { status: 'ready', projectDir: args.projectDir };
    }

    if (backendChoice.backend === 'codex') {
      const preset = presetForBackend('codex');
      const probe = deps.codexAuthProbe ?? runCodexAuthProbe;
      const validation = await validatePresetModels(
        preset,
        (model) => validateModelWithProgress('Codex', model, deps, () => probe({ projectDir: args.projectDir, model })),
        io,
      );
      if (validation.status !== 'ready') {
        io.stderr.write(`${validation.message}\n`);
        return { status: 'failed', projectDir: args.projectDir };
      }
      // Prefix the clack gutter so the warning sits inside the setup frame
      // instead of breaking out of it; kept on stderr for scripted runs.
      io.stderr.write(`│  ${formatCodexIsolationWarning()}\n`);
      await persistLlmConfig(args.projectDir, { backend: 'codex' }, validation.models);
      io.stdout.write(`│  LLM ready: yes (codex, ${validation.models.default})\n`);
      return { status: 'ready', projectDir: args.projectDir };
    }

    if (backendChoice.backend === 'openai-compatible') {
      const baseUrl = await chooseOpenAiCompatibleBaseUrl(backendArgs, io, deps);
      if (baseUrl.status === 'back' && backendChoice.prompted) {
        attemptArgs = buildInteractiveRetryArgs(args);
        continue;
      }
      if (baseUrl.status !== 'ready') {
        return { status: baseUrl.status, projectDir: args.projectDir };
      }

      const credential = await chooseOpenAiCompatibleCredentialRef(backendArgs, io, deps);
      if (credential.status === 'back' && backendChoice.prompted) {
        attemptArgs = buildInteractiveRetryArgs(args, backendChoice.backend);
        continue;
      }
      if (credential.status !== 'ready') {
        return { status: credential.status, projectDir: args.projectDir };
      }

      const modelChoice = await chooseOpenAiCompatibleModel(backendArgs, io, deps);
      if (modelChoice.status === 'back' && backendChoice.prompted) {
        attemptArgs = buildInteractiveRetryArgs(args, backendChoice.backend);
        continue;
      }
      if (modelChoice.status !== 'ready') {
        return { status: modelChoice.status, projectDir: args.projectDir };
      }

      const preset = singleModelPreset(modelChoice.model);
      const validation = await validatePresetModels(
        preset,
        (model) =>
          validateModelWithProgress('OpenAI-compatible', model, deps, () =>
            healthCheck(buildOpenAiCompatibleHealthConfig(baseUrl.value, credential.value, model)),
          ),
        io,
      );
      if (validation.status !== 'ready') {
        io.stderr.write(`OpenAI-compatible model health check failed: ${validation.message}\n`);
        if (args.inputMode === 'disabled') {
          return { status: 'failed', projectDir: args.projectDir };
        }
        io.stderr.write('Choose a different base URL, credential, or model, or Back.\n');
        attemptArgs = buildInteractiveRetryArgs(args, backendChoice.backend);
        continue;
      }

      await persistLlmConfig(
        args.projectDir,
        {
          backend: 'openai-compatible',
          baseUrl: baseUrl.ref,
          ...(credential.ref ? { credentialRef: credential.ref } : {}),
        },
        validation.models,
      );
      io.stdout.write(`│  LLM ready: yes (openai-compatible, ${validation.models.default})\n`);
      return { status: 'ready', projectDir: args.projectDir };
    }

    const credential = await chooseCredentialRef(backendArgs, io, deps);
    if (credential.status === 'back' && backendChoice.prompted) {
      attemptArgs = buildInteractiveRetryArgs(args);
      continue;
    }
    if (credential.status !== 'ready') {
      return { status: credential.status, projectDir: args.projectDir };
    }

    const preset = presetForBackend('anthropic');
    const validation = await validatePresetModels(
      preset,
      (model) =>
        validateModelWithProgress('Anthropic API', model, deps, () =>
          healthCheck(buildAnthropicHealthConfig(credential.value, model)),
        ),
      io,
    );
    if (validation.status !== 'ready') {
      io.stderr.write(`Anthropic model health check failed: ${validation.message}\n`);
      if (args.inputMode === 'disabled') {
        return { status: 'failed', projectDir: args.projectDir };
      }
      io.stderr.write('Choose a different credential source or Back.\n');
      attemptArgs = buildInteractiveRetryArgs(args, backendChoice.backend);
      continue;
    }

    await persistLlmConfig(args.projectDir, { backend: 'anthropic', credentialRef: credential.ref }, validation.models);
    io.stdout.write(`│  LLM ready: yes (${validation.models.default})\n`);
    return { status: 'ready', projectDir: args.projectDir };
  }
}
