import { resolveStringReference } from './string-reference.js';
import { resolveQueryDeadlineMs } from '../../context/connections/query-deadline.js';
import { Pool } from 'pg';

/**
 * Shared wire layer for connectors that speak the PostgreSQL wire protocol
 * (PostgreSQL and Amazon Redshift). Holds the `pg` pool plumbing, connection
 * config resolution, URL parsing, and query helpers so protocol-level behaviour
 * stays in one place. Driver-specific metadata introspection lives in each
 * connector.
 */

export const PG_OID_TYPE_MAP: Record<number, string> = {
  16: 'boolean',
  20: 'bigint',
  21: 'smallint',
  23: 'integer',
  25: 'text',
  700: 'real',
  701: 'double precision',
  1043: 'varchar',
  1082: 'date',
  1114: 'timestamp',
  1184: 'timestamptz',
  1700: 'numeric',
  2950: 'uuid',
  3802: 'jsonb',
  114: 'json',
  1009: 'text[]',
  1007: 'integer[]',
  1016: 'bigint[]',
};

export interface KtxPgConnectionConfig {
  driver?: string;
  host?: string;
  port?: number;
  database?: string;
  username?: string;
  user?: string;
  password?: string;
  url?: string;
  schema?: string;
  schemas?: string[];
  ssl?: boolean;
  sslmode?: string;
  sslMode?: string;
  rejectUnauthorized?: boolean;
  maxConnections?: number;
  [key: string]: unknown;
}

export interface KtxPgPoolConfig {
  host?: string;
  port?: number;
  database?: string;
  user?: string;
  password?: string;
  connectionString?: string;
  max: number;
  idleTimeoutMillis: number;
  connectionTimeoutMillis: number;
  options?: string;
  ssl?: { rejectUnauthorized: boolean };
}

export interface KtxPgQueryResult {
  fields?: Array<{ name: string; dataTypeID: number }>;
  rows: Record<string, unknown>[];
}

interface KtxPgClient {
  query(sql: string, params?: unknown[]): Promise<KtxPgQueryResult>;
  release(): void;
}

export interface KtxPgPool {
  connect(): Promise<KtxPgClient>;
  end(): Promise<void>;
  on?(event: 'error', listener: (error: Error) => void): void;
}

export interface KtxPgPoolFactory {
  createPool(config: KtxPgPoolConfig): KtxPgPool;
}

export interface KtxPgResolvedEndpoint {
  host: string;
  port: number;
  close?: () => Promise<void>;
}

export interface KtxPgEndpointResolver {
  resolve(input: { host: string; port: number; connection: KtxPgConnectionConfig }): Promise<KtxPgResolvedEndpoint>;
}

export class DefaultPgPoolFactory implements KtxPgPoolFactory {
  createPool(config: KtxPgPoolConfig): KtxPgPool {
    return new Pool(config);
  }
}

export function groupByTable<T extends { table_name: string }>(rows: T[]): Map<string, T[]> {
  const grouped = new Map<string, T[]>();
  for (const row of rows) {
    const tableRows = grouped.get(row.table_name) ?? [];
    tableRows.push(row);
    grouped.set(row.table_name, tableRows);
  }
  return grouped;
}

/** @internal */
export function preparePgReadOnlyQuery(
  sql: string,
  params?: Record<string, unknown>,
): { sql: string; params?: unknown[] } {
  if (!params) {
    return { sql, params: undefined };
  }
  const paramNames = Object.keys(params);
  const values: unknown[] = new Array(paramNames.length);
  const paramIndexMap = new Map<string, number>();
  paramNames.forEach((name, index) => {
    paramIndexMap.set(name, index + 1);
    values[index] = params[name];
  });
  const sortedKeys = [...paramNames].sort((a, b) => b.length - a.length);
  let parameterizedQuery = sql;
  for (const name of sortedKeys) {
    parameterizedQuery = parameterizedQuery.replace(new RegExp(`:${name}\\b`, 'g'), `$${paramIndexMap.get(name)}`);
  }
  return { sql: parameterizedQuery, params: values };
}

export function primaryKeyMap<T extends { table_name: string; column_name: string }>(
  rows: T[],
): Map<string, Set<string>> {
  const grouped = new Map<string, Set<string>>();
  for (const row of rows) {
    const columns = grouped.get(row.table_name) ?? new Set<string>();
    columns.add(row.column_name);
    grouped.set(row.table_name, columns);
  }
  return grouped;
}

export function isDeniedError(error: unknown): boolean {
  if (!error || typeof error !== 'object') {
    return false;
  }
  const code = (error as { code?: unknown }).code;
  return code === '42501' || code === '42P01';
}

// 57014 = query_canceled, which is how statement_timeout surfaces.
export function isPgTimeoutError(error: unknown): boolean {
  return Boolean(error) && typeof error === 'object' && (error as { code?: unknown }).code === '57014';
}

export function queryRows(result: KtxPgQueryResult): unknown[][] {
  const headers = (result.fields ?? []).map((field) => field.name);
  return result.rows.map((row) => headers.map((header) => row[header]));
}

export function finiteNumber(value: unknown): number | null {
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : null;
}

function stringConfigValue(
  connection: KtxPgConnectionConfig | undefined,
  key: keyof KtxPgConnectionConfig,
  env: NodeJS.ProcessEnv,
): string | undefined {
  const value = connection?.[key];
  return typeof value === 'string' && value.trim().length > 0 ? resolveStringReference(value.trim(), env) : undefined;
}

export function numberValue(value: unknown): number | undefined {
  return typeof value === 'number' && Number.isFinite(value) ? value : undefined;
}

function positiveIntegerConfigValue(input: {
  connection: KtxPgConnectionConfig;
  key: keyof KtxPgConnectionConfig;
  connectionId: string;
  defaultValue: number;
}): number {
  const value = input.connection[input.key];
  if (value === undefined) {
    return input.defaultValue;
  }
  const numberValue = Number(value);
  if (!Number.isInteger(numberValue) || numberValue < 1) {
    throw new Error(`connections.${input.connectionId}.${String(input.key)} must be a positive integer`);
  }
  return numberValue;
}

function parsePgUrl(url: string): Partial<KtxPgConnectionConfig> {
  const parsed = new URL(url);
  const sslmode = parsed.searchParams.get('sslmode') ?? undefined;
  return {
    host: parsed.hostname,
    port: parsed.port ? Number(parsed.port) : undefined,
    database: parsed.pathname.replace(/^\/+/, '') || undefined,
    username: parsed.username ? decodeURIComponent(parsed.username) : undefined,
    password: parsed.password ? decodeURIComponent(parsed.password) : undefined,
    ...(sslmode ? { sslmode } : {}),
  };
}

function normalizedSslMode(connection: KtxPgConnectionConfig): string | undefined {
  const value = connection.sslmode ?? connection.sslMode;
  return typeof value === 'string' && value.trim().length > 0 ? value.trim().toLowerCase() : undefined;
}

export function schemasFromConnection(connection: KtxPgConnectionConfig): string[] {
  if (Array.isArray(connection.schemas) && connection.schemas.length > 0) {
    return connection.schemas.filter((schema): schema is string => typeof schema === 'string' && schema.length > 0);
  }
  return typeof connection.schema === 'string' && connection.schema.length > 0 ? [connection.schema] : ['public'];
}

function searchPathSchemasFromConnection(connection: KtxPgConnectionConfig): string[] {
  const schemas = schemasFromConnection(connection);
  return schemas.includes('public') ? schemas : [...schemas, 'public'];
}

/**
 * Build a `pg` pool config from a ktx connection config. `defaultPort` and
 * `connectorLabel` are the only driver-specific inputs: PostgreSQL defaults to
 * 5432, Redshift to 5439, and the label prefixes validation errors.
 *
 * @internal
 */
export function pgPoolConfigFromConfig(input: {
  connectionId: string;
  connection: KtxPgConnectionConfig;
  defaultPort: number;
  connectorLabel: string;
  env?: NodeJS.ProcessEnv;
}): KtxPgPoolConfig {
  const env = input.env ?? process.env;
  const { connectorLabel, connectionId } = input;
  const referencedUrl = stringConfigValue(input.connection, 'url', env);
  const urlConfig = referencedUrl ? parsePgUrl(referencedUrl) : {};
  const merged: KtxPgConnectionConfig = { ...urlConfig, ...input.connection };
  const host = stringConfigValue(merged, 'host', env);
  const database = stringConfigValue(merged, 'database', env);
  const user = stringConfigValue(merged, 'username', env) ?? stringConfigValue(merged, 'user', env);
  const password = stringConfigValue(merged, 'password', env);
  const sslmode = normalizedSslMode(merged);
  const maxConnections = positiveIntegerConfigValue({
    connection: merged,
    key: 'maxConnections',
    connectionId,
    defaultValue: 10,
  });

  if (!referencedUrl && !host) {
    throw new Error(`${connectorLabel} requires connections.${connectionId}.host or url`);
  }
  if (!database && !referencedUrl) {
    throw new Error(`${connectorLabel} requires connections.${connectionId}.database or url`);
  }
  if (!user && !referencedUrl) {
    throw new Error(`${connectorLabel} requires connections.${connectionId}.username, user, or url`);
  }

  const config: KtxPgPoolConfig = {
    max: maxConnections,
    idleTimeoutMillis: 30_000,
    connectionTimeoutMillis: 10_000,
    ...(referencedUrl && sslmode !== 'prefer' && sslmode !== 'disable'
      ? { connectionString: referencedUrl }
      : { host, port: numberValue(merged.port) ?? input.defaultPort, database, user, password }),
  };
  const searchPathSchemas = searchPathSchemasFromConnection(merged);
  // statement_timeout (ms) bounds every query on connections from this pool, so
  // the server itself aborts a runaway query and frees the connection cleanly.
  const serverOptions = [`-c statement_timeout=${resolveQueryDeadlineMs(merged)}`];
  if (searchPathSchemas.length > 0) {
    serverOptions.unshift(`-c search_path=${searchPathSchemas.join(',')}`);
  }
  config.options = serverOptions.join(' ');
  if (merged.ssl && sslmode !== 'prefer' && sslmode !== 'disable') {
    config.ssl = { rejectUnauthorized: merged.rejectUnauthorized ?? true };
  }
  return config;
}
