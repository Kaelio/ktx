import { spawn } from 'node:child_process';
import { request as httpRequest } from 'node:http';
import { request as httpsRequest } from 'node:https';
import { URL } from 'node:url';
import type { KtxProjectConnectionConfig } from '../../../project/config.js';
import { isKtxScanWarningCode } from '../../../scan/local-structural-artifacts.js';
import { tableRefFromKey } from '../../../scan/table-ref.js';
import type { KtxScanWarning, KtxSchemaColumn, KtxSchemaForeignKey, KtxSchemaSnapshot, KtxSchemaTable } from '../../../scan/types.js';
import { inferKtxDimensionType, normalizeKtxNativeType } from '../../../scan/type-normalization.js';
import type { LiveDatabaseIntrospectionOptions, LiveDatabaseIntrospectionPort } from './types.js';

type KtxDaemonDatabaseIntrospectionCommand = 'database-introspect';

type KtxDaemonDatabaseJsonRunner = (
  subcommand: KtxDaemonDatabaseIntrospectionCommand,
  payload: Record<string, unknown>,
) => Promise<Record<string, unknown>>;

export type KtxDaemonDatabaseHttpJsonRunner = (
  path: string,
  payload: Record<string, unknown>,
) => Promise<Record<string, unknown>>;

export interface DaemonLiveDatabaseIntrospectionOptions {
  connections: Record<string, KtxProjectConnectionConfig>;
  schemas?: string[];
  statementTimeoutMs?: number;
  connectionTimeoutSeconds?: number;
  command?: string;
  args?: string[];
  cwd?: string;
  env?: NodeJS.ProcessEnv;
  baseUrl?: string;
  runJson?: KtxDaemonDatabaseJsonRunner;
  requestJson?: KtxDaemonDatabaseHttpJsonRunner;
  now?: () => Date;
}

const DEFAULT_SCHEMAS = ['public'];

function parseJsonObject(raw: string, subcommand: string): Record<string, unknown> {
  const parsed = JSON.parse(raw) as unknown;
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
    throw new Error(`ktx-daemon ${subcommand} returned non-object JSON`);
  }
  return parsed as Record<string, unknown>;
}

function runProcessJson(
  options: Required<Pick<DaemonLiveDatabaseIntrospectionOptions, 'command' | 'args'>> &
    Pick<DaemonLiveDatabaseIntrospectionOptions, 'cwd' | 'env'>,
): KtxDaemonDatabaseJsonRunner {
  return async (subcommand, payload) =>
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
          reject(new Error(`ktx-daemon ${subcommand} failed: ${stderrText || `exit code ${code}`}`));
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

function postJson(baseUrl: string): KtxDaemonDatabaseHttpJsonRunner {
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
              reject(new Error(`ktx-daemon HTTP ${path} failed with ${statusCode}: ${text}`));
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

function requiredString(value: unknown, field: string): string {
  if (typeof value !== 'string' || value.length === 0) {
    throw new Error(`ktx-daemon database introspection response is missing string field ${field}`);
  }
  return value;
}

function nullableString(value: unknown): string | null {
  return typeof value === 'string' ? value : null;
}

function optionalString(value: unknown): string | undefined {
  return typeof value === 'string' ? value : undefined;
}

function normalizeDriver(driver: unknown): string {
  const normalized = String(driver ?? '').trim().toLowerCase();
  return normalized;
}

function requirePostgresConnection(
  connections: Record<string, KtxProjectConnectionConfig>,
  connectionId: string,
): KtxProjectConnectionConfig & { url: string } {
  const connection = connections[connectionId];
  const driver = normalizeDriver(connection?.driver);
  if (driver !== 'postgres') {
    throw new Error(`Local live-database ingest cannot run driver "${connection?.driver ?? 'unknown'}".`);
  }
  if (typeof connection.url !== 'string' || connection.url.trim().length === 0) {
    throw new Error(`Local live-database ingest requires connections.${connectionId}.url.`);
  }
  return connection as KtxProjectConnectionConfig & { url: string };
}

function mapColumn(raw: Record<string, unknown>): KtxSchemaColumn {
  const nativeType = requiredString(raw.type, 'tables[].columns[].type');
  return {
    name: requiredString(raw.name, 'tables[].columns[].name'),
    nativeType,
    normalizedType: normalizeKtxNativeType(nativeType),
    dimensionType: inferKtxDimensionType(nativeType),
    nullable: raw.nullable !== false ? true : false,
    primaryKey: raw.primary_key === true,
    comment: nullableString(raw.comment),
  };
}

function mapForeignKey(raw: Record<string, unknown>): KtxSchemaForeignKey {
  return {
    fromColumn: requiredString(raw.from_column, 'tables[].foreign_keys[].from_column'),
    toCatalog: null,
    toDb: null,
    toTable: requiredString(raw.to_table, 'tables[].foreign_keys[].to_table'),
    toColumn: requiredString(raw.to_column, 'tables[].foreign_keys[].to_column'),
    constraintName: nullableString(raw.constraint_name),
  };
}

function mapTable(raw: Record<string, unknown>): KtxSchemaTable {
  return {
    catalog: nullableString(raw.catalog),
    db: nullableString(raw.db),
    name: requiredString(raw.name, 'tables[].name'),
    kind: 'table',
    comment: nullableString(raw.comment),
    estimatedRows: null,
    columns: recordArray(raw.columns).map(mapColumn),
    foreignKeys: recordArray(raw.foreign_keys).map(mapForeignKey),
  };
}

function mapWarning(raw: Record<string, unknown>): KtxScanWarning | null {
  const code = optionalString(raw.code);
  // Drop codes Node cannot render, keeping the daemon and Node warning catalogs
  // in parity rather than surfacing an unknown code downstream.
  if (!code || !isKtxScanWarningCode(code)) return null;
  const table = optionalString(raw.table);
  const column = optionalString(raw.column);
  return {
    code,
    message: requiredString(raw.message, 'warnings[].message'),
    recoverable: raw.recoverable !== false,
    ...(table ? { table } : {}),
    ...(column ? { column } : {}),
    ...(raw.metadata && typeof raw.metadata === 'object' && !Array.isArray(raw.metadata)
      ? { metadata: recordValue(raw.metadata) }
      : {}),
  };
}

function mapDaemonSnapshot(
  raw: Record<string, unknown>,
  input: { connectionId: string; extractedAt: string; schemas: string[] },
): KtxSchemaSnapshot {
  const warnings = recordArray(raw.warnings)
    .map(mapWarning)
    .filter((warning): warning is KtxScanWarning => warning !== null);
  return {
    connectionId: requiredString(raw.connection_id, 'connection_id') || input.connectionId,
    driver: 'postgres',
    extractedAt: optionalString(raw.extracted_at) ?? input.extractedAt,
    scope: { schemas: input.schemas },
    metadata: recordValue(raw.metadata),
    tables: recordArray(raw.tables).map(mapTable),
    ...(warnings.length > 0 ? { warnings } : {}),
  };
}

function serializeTableScope(options: LiveDatabaseIntrospectionOptions | undefined): Array<{
  catalog: string | null;
  db: string | null;
  name: string;
}> | undefined {
  if (!options?.tableScope) return undefined;
  return [...options.tableScope].map((key) => {
    const ref = tableRefFromKey(key);
    return { catalog: ref.catalog, db: ref.db, name: ref.name };
  });
}

export function createDaemonLiveDatabaseIntrospection(
  options: DaemonLiveDatabaseIntrospectionOptions,
): LiveDatabaseIntrospectionPort {
  const schemas = options.schemas ?? DEFAULT_SCHEMAS;
  const command = options.command ?? 'python';
  const args = options.args ?? ['-m', 'ktx_daemon'];
  const runJson = options.runJson ?? runProcessJson({ command, args, cwd: options.cwd, env: options.env });
  const requestJson = options.requestJson ?? (options.baseUrl ? postJson(options.baseUrl) : undefined);
  const now = options.now ?? (() => new Date());

  return {
    async extractSchema(connectionId: string, introspectionOptions?: LiveDatabaseIntrospectionOptions): Promise<KtxSchemaSnapshot> {
      const connection = requirePostgresConnection(options.connections, connectionId);
      const tableScope = serializeTableScope(introspectionOptions);
      const payload = {
        connection_id: connectionId,
        driver: normalizeDriver(connection.driver),
        url: connection.url,
        schemas,
        statement_timeout_ms: options.statementTimeoutMs ?? 30_000,
        connection_timeout_seconds: options.connectionTimeoutSeconds ?? 5,
        ...(tableScope !== undefined ? { table_scope: tableScope } : {}),
      };
      const raw = requestJson
        ? await requestJson('/database/introspect', payload)
        : await runJson('database-introspect', payload);
      return mapDaemonSnapshot(raw, {
        connectionId,
        extractedAt: now().toISOString(),
        schemas,
      });
    },
  };
}
