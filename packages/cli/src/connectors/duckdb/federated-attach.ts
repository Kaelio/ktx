import { sqliteDatabasePathFromConfig, type KtxSqliteConnectionConfig } from '../sqlite/connector.js';
import { postgresPoolConfigFromConfig, type KtxPostgresConnectionConfig } from '../postgres/connector.js';
import {
  mysqlConnectionPoolConfigFromConfig,
  type KtxMysqlConnectionConfig,
} from '../mysql/connector.js';
import { duckDbDatabasePathFromConfig, type KtxDuckDbConnectionConfig } from '../../connectors/duckdb/connector.js';
import type { FederatedMember } from '../../context/connections/federation.js';

function kvKeyword(value: string): string {
  // libpq/DuckDB key-value values quote with single quotes and backslash-escape.
  return /[\s'\\]/.test(value) ? `'${value.replaceAll('\\', '\\\\').replaceAll("'", "\\'")}'` : value;
}

function withRequiredSslMode(connectionString: string): string {
  // DuckDB passes this libpq URL straight to the server, so an ssl:true member
  // must carry sslmode in the URL itself; keep a stronger mode the URL already pins.
  const url = new URL(connectionString);
  if (url.searchParams.has('sslmode')) {
    return connectionString;
  }
  url.searchParams.set('sslmode', 'require');
  return url.toString();
}

function postgresAttachString(member: FederatedMember, env: NodeJS.ProcessEnv): string {
  const cfg = postgresPoolConfigFromConfig({
    connectionId: member.connectionId,
    connection: member.connection as KtxPostgresConnectionConfig,
    env,
  });
  if (cfg.connectionString) {
    return cfg.ssl ? withRequiredSslMode(cfg.connectionString) : cfg.connectionString;
  }
  const parts: string[] = [];
  if (cfg.host) parts.push(`host=${kvKeyword(cfg.host)}`);
  if (cfg.port) parts.push(`port=${cfg.port}`);
  if (cfg.database) parts.push(`dbname=${kvKeyword(cfg.database)}`);
  if (cfg.user) parts.push(`user=${kvKeyword(cfg.user)}`);
  if (cfg.password) parts.push(`password=${kvKeyword(cfg.password)}`);
  if (cfg.ssl) {
    parts.push('sslmode=require');
  }
  if (cfg.options) {
    parts.push(`options=${kvKeyword(cfg.options)}`);
  }
  return parts.join(' ');
}

function mysqlAttachString(member: FederatedMember, env: NodeJS.ProcessEnv): string {
  const cfg = mysqlConnectionPoolConfigFromConfig({
    connectionId: member.connectionId,
    connection: member.connection as KtxMysqlConnectionConfig,
    env,
  });
  const parts: string[] = [
    `host=${kvKeyword(cfg.host)}`,
    `port=${cfg.port}`,
    `database=${kvKeyword(cfg.database)}`,
    `user=${kvKeyword(cfg.user)}`,
  ];
  if (cfg.password) {
    parts.push(`password=${kvKeyword(cfg.password)}`);
  }
  if (cfg.ssl) {
    parts.push('ssl_mode=REQUIRED');
  }
  return parts.join(' ');
}

/**
 * Resolves a federated member's ktx.yaml config into the connection target
 * DuckDB's ATTACH wants for that driver, reusing each connector's canonical
 * resolver so federation and standalone scans agree on config interpretation.
 */
export function federatedAttachTarget(member: FederatedMember, env: NodeJS.ProcessEnv): string {
  switch (member.driver.toLowerCase()) {
    case 'duckdb':
      return duckDbDatabasePathFromConfig({
        connectionId: member.connectionId,
        projectDir: member.projectDir,
        connection: member.connection as KtxDuckDbConnectionConfig,
      });
    case 'sqlite':
      return sqliteDatabasePathFromConfig({
        connectionId: member.connectionId,
        projectDir: member.projectDir,
        connection: member.connection as KtxSqliteConnectionConfig,
      });
    case 'postgres':
      return postgresAttachString(member, env);
    case 'mysql':
      return mysqlAttachString(member, env);
    default:
      throw new Error(`Driver "${member.driver}" cannot be attached by DuckDB federation.`);
  }
}
