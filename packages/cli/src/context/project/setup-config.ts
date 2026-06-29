import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import type { KtxProjectConfig } from './config.js';

const KTX_SETUP_STEPS = [
  'project',
  'llm',
  'embeddings',
  'databases',
  'sources',
  'runtime',
  'context',
  'agents',
] as const;

export type KtxSetupStep = (typeof KTX_SETUP_STEPS)[number];

export interface KtxSetupState {
  completed_steps: KtxSetupStep[];
}

const SETUP_GITIGNORE_ENTRIES = [
  'cache/',
  'db.sqlite',
  'db.sqlite-*',
  'ingest-transcripts/',
  'logs/',
  'secrets/',
  'setup/',
  'agents/',
] as const;

function isKtxSetupStep(value: unknown): value is KtxSetupStep {
  return typeof value === 'string' && (KTX_SETUP_STEPS as readonly string[]).includes(value);
}

function uniqueSetupSteps(steps: unknown): KtxSetupStep[] {
  if (!Array.isArray(steps)) {
    return [];
  }
  return [...new Set(steps.filter(isKtxSetupStep))];
}

function ktxSetupStatePath(projectDir: string): string {
  return join(projectDir, '.ktx', 'setup', 'state.json');
}

export async function readKtxSetupState(projectDir: string): Promise<KtxSetupState> {
  try {
    const parsed = JSON.parse(await readFile(ktxSetupStatePath(projectDir), 'utf-8')) as Record<string, unknown>;
    return { completed_steps: uniqueSetupSteps(parsed.completed_steps) };
  } catch (error) {
    if (error && typeof error === 'object' && 'code' in error && error.code === 'ENOENT') {
      return { completed_steps: [] };
    }
    throw error;
  }
}

/** @internal */
export async function writeKtxSetupState(projectDir: string, state: KtxSetupState): Promise<void> {
  await mkdir(join(projectDir, '.ktx', 'setup'), { recursive: true });
  await writeFile(
    ktxSetupStatePath(projectDir),
    `${JSON.stringify({ completed_steps: uniqueSetupSteps(state.completed_steps) }, null, 2)}\n`,
    'utf-8',
  );
}

export async function markKtxSetupStateStepComplete(projectDir: string, step: KtxSetupStep): Promise<KtxSetupState> {
  const state = await readKtxSetupState(projectDir);
  const completedSteps = state.completed_steps.includes(step) ? state.completed_steps : [...state.completed_steps, step];
  const nextState = { completed_steps: completedSteps };
  await writeKtxSetupState(projectDir, nextState);
  return nextState;
}

export function setKtxSetupDatabaseConnectionIds(
  config: KtxProjectConfig,
  connectionIds: string[],
): KtxProjectConfig {
  const uniqueConnectionIds = [...new Set(connectionIds.filter((connectionId) => connectionId.trim().length > 0))];

  return {
    ...config,
    setup: {
      database_connection_ids: uniqueConnectionIds,
    },
  };
}

export function mergeKtxSetupGitignoreEntries(content: string): string {
  const lines = content
    .split(/\r?\n/)
    .map((line) => line.trimEnd())
    .filter((line, index, all) => line.length > 0 || index < all.length - 1);
  const existing = new Set(lines);
  for (const entry of SETUP_GITIGNORE_ENTRIES) {
    if (!existing.has(entry)) {
      lines.push(entry);
      existing.add(entry);
    }
  }
  return `${lines.join('\n')}\n`;
}
