import { request as httpRequest } from 'node:http';
import { request as httpsRequest } from 'node:https';
import { URL } from 'node:url';
import { spawn } from 'node:child_process';
import { KtxExpectedError } from '../../errors.js';
import type { ResolvedSemanticLayerSource, SemanticLayerQueryInput } from '../sl/types.js';

// Exit code the daemon returns when the engine rejects an invalid semantic-query
// request; the HTTP transport signals the same rejection with status 400. Both
// map to KtxExpectedError so routine, caller-driven rejections stay out of Error
// Tracking. Mirror of EXPECTED_REQUEST_REJECTION_EXIT_CODE in
// python/ktx-daemon/src/ktx_daemon/__main__.py.
const DAEMON_REQUEST_REJECTION_EXIT_CODE = 3;
const DAEMON_REQUEST_REJECTION_HTTP_STATUS = 400;

interface KtxSemanticLayerComputeQueryResult {
  sql: string;
  dialect: string;
  columns: Array<Record<string, unknown>>;
  plan: Record<string, unknown>;
}

interface KtxSemanticLayerComputeValidationResult {
  valid: boolean;
  errors: string[];
  warnings: string[];
  perSourceWarnings: Record<string, string[]>;
}

interface KtxSemanticLayerSourceGenerationColumnInput {
  name: string;
  type: string;
  primaryKey?: boolean;
  nullable?: boolean;
  comment?: string | null;
}

interface KtxSemanticLayerSourceGenerationTableInput {
  name: string;
  catalog?: string | null;
  db?: string | null;
  comment?: string | null;
  columns: KtxSemanticLayerSourceGenerationColumnInput[];
}

interface KtxSemanticLayerSourceGenerationLinkInput {
  fromTable: string;
  fromColumn: string;
  toTable: string;
  toColumn: string;
  relationshipType: string;
}

interface KtxSemanticLayerSourceGenerationInput {
  tables: KtxSemanticLayerSourceGenerationTableInput[];
  links: KtxSemanticLayerSourceGenerationLinkInput[];
  dialect?: string;
}

interface KtxSemanticLayerSourceGenerationResult {
  sources: Array<Record<string, unknown>>;
  sourceCount: number;
}

export interface KtxSemanticLayerComputePort {
  /**
   * Callers must pass sources sanitized through toResolvedWire. The Python
   * daemon rejects authoring-only fields such as usage and inherits_columns_from.
   */
  query(input: {
    sources: ResolvedSemanticLayerSource[];
    query: SemanticLayerQueryInput;
    dialect: string;
  }): Promise<KtxSemanticLayerComputeQueryResult>;
  /**
   * Callers must pass sources sanitized through toResolvedWire. The Python
   * daemon rejects authoring-only fields such as usage and inherits_columns_from.
   */
  validateSources(input: {
    sources: ResolvedSemanticLayerSource[];
    dialect: string;
    recentlyTouched?: string[];
  }): Promise<KtxSemanticLayerComputeValidationResult>;
  generateSources(input: KtxSemanticLayerSourceGenerationInput): Promise<KtxSemanticLayerSourceGenerationResult>;
}

type KtxDaemonCommand = 'semantic-query' | 'semantic-validate' | 'semantic-generate-sources';

type KtxDaemonJsonRunner = (
  subcommand: KtxDaemonCommand,
  payload: Record<string, unknown>,
) => Promise<Record<string, unknown>>;

type KtxDaemonHttpJsonRunner = (path: string, payload: Record<string, unknown>) => Promise<Record<string, unknown>>;

export interface PythonSemanticLayerComputeOptions {
  command?: string;
  args?: string[];
  cwd?: string;
  env?: NodeJS.ProcessEnv;
  runJson?: KtxDaemonJsonRunner;
  projectId?: string;
}

/** @internal */
export interface HttpSemanticLayerComputeOptions {
  baseUrl: string;
  requestJson?: KtxDaemonHttpJsonRunner;
}

function parseJsonObject(raw: string, subcommand: string): Record<string, unknown> {
  const parsed = JSON.parse(raw) as unknown;
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
    throw new Error(`ktx-daemon ${subcommand} returned non-object JSON`);
  }
  return parsed as Record<string, unknown>;
}

function runProcessJson(
  options: Required<Pick<PythonSemanticLayerComputeOptions, 'command' | 'args'>> &
    Pick<PythonSemanticLayerComputeOptions, 'cwd' | 'env'>,
): KtxDaemonJsonRunner {
  return async (subcommand: KtxDaemonCommand, payload: Record<string, unknown>): Promise<Record<string, unknown>> =>
    new Promise((resolve, reject) => {
      const child = spawn(options.command, [...options.args, subcommand], {
        cwd: options.cwd,
        env: { ...process.env, ...options.env },
        stdio: ['pipe', 'pipe', 'pipe'],
      });
      const stdout: Buffer[] = [];
      const stderr: Buffer[] = [];

      child.stdout.on('data', (chunk: Buffer) => stdout.push(chunk));
      child.stderr.on('data', (chunk: Buffer) => stderr.push(chunk));
      child.on('error', reject);
      child.on('close', (code) => {
        const stdoutText = Buffer.concat(stdout).toString('utf8').trim();
        const stderrText = Buffer.concat(stderr).toString('utf8').trim();
        if (code !== 0) {
          const message = `ktx-daemon ${subcommand} failed: ${stderrText || `exit code ${code}`}`;
          reject(code === DAEMON_REQUEST_REJECTION_EXIT_CODE ? new KtxExpectedError(message) : new Error(message));
          return;
        }
        try {
          resolve(parseJsonObject(stdoutText, subcommand));
        } catch (error) {
          reject(error);
        }
      });
      child.stdin.end(`${JSON.stringify(payload)}\n`);
    });
}

function normalizedBaseUrl(baseUrl: string): string {
  return baseUrl.endsWith('/') ? baseUrl : `${baseUrl}/`;
}

function postJson(baseUrl: string): KtxDaemonHttpJsonRunner {
  return async (path, payload) =>
    new Promise((resolve, reject) => {
      const target = new URL(path.replace(/^\//, ''), normalizedBaseUrl(baseUrl));
      const body = JSON.stringify(payload);
      const client = target.protocol === 'https:' ? httpsRequest : httpRequest;
      const request = client(
        target,
        {
          method: 'POST',
          headers: {
            accept: 'application/json',
            'content-type': 'application/json',
            'content-length': Buffer.byteLength(body),
          },
        },
        (response) => {
          const chunks: Buffer[] = [];
          response.on('data', (chunk: Buffer) => chunks.push(chunk));
          response.on('end', () => {
            const text = Buffer.concat(chunks).toString('utf8');
            const statusCode = response.statusCode ?? 0;
            if (statusCode < 200 || statusCode >= 300) {
              const message = `ktx-daemon HTTP ${path} failed with ${statusCode}: ${text}`;
              reject(
                statusCode === DAEMON_REQUEST_REJECTION_HTTP_STATUS ? new KtxExpectedError(message) : new Error(message),
              );
              return;
            }
            try {
              resolve(parseJsonObject(text, path));
            } catch (error) {
              reject(error);
            }
          });
        },
      );
      request.on('error', reject);
      request.end(body);
    });
}

function stringArray(value: unknown): string[] {
  return Array.isArray(value) ? value.filter((item): item is string => typeof item === 'string') : [];
}

function recordValue(value: unknown): Record<string, unknown> {
  return value && typeof value === 'object' && !Array.isArray(value) ? (value as Record<string, unknown>) : {};
}

function recordArray(value: unknown): Array<Record<string, unknown>> {
  return Array.isArray(value)
    ? value.filter(
        (item): item is Record<string, unknown> => item !== null && typeof item === 'object' && !Array.isArray(item),
      )
    : [];
}

function sourceGenerationPayload(input: KtxSemanticLayerSourceGenerationInput): Record<string, unknown> {
  return {
    tables: input.tables.map((table) => ({
      name: table.name,
      ...(table.catalog !== undefined ? { catalog: table.catalog } : {}),
      ...(table.db !== undefined ? { db: table.db } : {}),
      ...(table.comment !== undefined ? { comment: table.comment } : {}),
      columns: table.columns.map((column) => ({
        name: column.name,
        type: column.type,
        ...(column.primaryKey !== undefined ? { primary_key: column.primaryKey } : {}),
        ...(column.nullable !== undefined ? { nullable: column.nullable } : {}),
        ...(column.comment !== undefined ? { comment: column.comment } : {}),
      })),
    })),
    links: input.links.map((link) => ({
      from_table: link.fromTable,
      from_column: link.fromColumn,
      to_table: link.toTable,
      to_column: link.toColumn,
      relationship_type: link.relationshipType,
    })),
    dialect: input.dialect ?? 'postgres',
  };
}

function sourceGenerationResult(raw: Record<string, unknown>): KtxSemanticLayerSourceGenerationResult {
  return {
    sources: recordArray(raw.sources),
    sourceCount: typeof raw.source_count === 'number' ? raw.source_count : recordArray(raw.sources).length,
  };
}

export function createPythonSemanticLayerComputePort(
  options: PythonSemanticLayerComputeOptions = {},
): KtxSemanticLayerComputePort {
  const command = options.command ?? 'python';
  const args = options.args ?? ['-m', 'ktx_daemon'];
  const runJson = options.runJson ?? runProcessJson({ command, args, cwd: options.cwd, env: options.env });
  const projectId = options.projectId;

  return {
    async query(input) {
      const raw = await runJson('semantic-query', {
        sources: input.sources,
        dialect: input.dialect,
        query: input.query,
        ...(projectId ? { projectId } : {}),
      });
      return {
        sql: typeof raw.sql === 'string' ? raw.sql : '',
        dialect: typeof raw.dialect === 'string' ? raw.dialect : input.dialect,
        columns: recordArray(raw.columns),
        plan: recordValue(raw.plan),
      };
    },
    async validateSources(input) {
      const raw = await runJson('semantic-validate', {
        sources: input.sources,
        dialect: input.dialect,
        recently_touched: input.recentlyTouched,
      });
      return {
        valid: raw.valid === true,
        errors: stringArray(raw.errors),
        warnings: stringArray(raw.warnings),
        perSourceWarnings: recordValue(raw.per_source_warnings) as Record<string, string[]>,
      };
    },
    async generateSources(input) {
      const raw = await runJson('semantic-generate-sources', sourceGenerationPayload(input));
      return sourceGenerationResult(raw);
    },
  };
}

/** @internal */
export function createHttpSemanticLayerComputePort(
  options: HttpSemanticLayerComputeOptions,
): KtxSemanticLayerComputePort {
  const requestJson = options.requestJson ?? postJson(options.baseUrl);

  return {
    async query(input) {
      const raw = await requestJson('/semantic-layer/query', {
        sources: input.sources,
        dialect: input.dialect,
        query: input.query,
      });
      return {
        sql: typeof raw.sql === 'string' ? raw.sql : '',
        dialect: typeof raw.dialect === 'string' ? raw.dialect : input.dialect,
        columns: recordArray(raw.columns),
        plan: recordValue(raw.plan),
      };
    },
    async validateSources(input) {
      const raw = await requestJson('/semantic-layer/validate', {
        sources: input.sources,
        dialect: input.dialect,
        recently_touched: input.recentlyTouched,
      });
      return {
        valid: raw.valid === true,
        errors: stringArray(raw.errors),
        warnings: stringArray(raw.warnings),
        perSourceWarnings: recordValue(raw.per_source_warnings) as Record<string, string[]>,
      };
    },
    async generateSources(input) {
      const raw = await requestJson('/semantic-layer/generate-sources', sourceGenerationPayload(input));
      return sourceGenerationResult(raw);
    },
  };
}
