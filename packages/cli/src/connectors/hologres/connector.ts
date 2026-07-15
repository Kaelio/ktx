import { KtxPostgresScanConnector, type KtxPostgresConnectionConfig } from '../postgres/connector.js';

// Hologres engine-internal schemas that never hold user data. Dropped from schema
// discovery the same way pg_catalog/information_schema are, since a user cannot
// place a table here. Matched exactly rather than by a `hologres_%` prefix because
// user schemas such as `hologres_dataset_*` share that prefix.
const HOLOGRES_SYSTEM_SCHEMAS: ReadonlySet<string> = new Set([
  'hologres',
  'hologres_streaming_mv',
  'hologres_statistic',
  'hologres_sample',
  'hologres_object_table',
  'hg_recyclebin',
  'hg_internal',
]);

export type KtxHologresConnectionConfig = KtxPostgresConnectionConfig;

export function isKtxHologresConnectionConfig(
  connection: KtxHologresConnectionConfig | undefined,
): connection is KtxHologresConnectionConfig {
  return String(connection?.driver ?? '').toLowerCase() === 'hologres';
}

/**
 * Hologres scan connector. Hologres is PostgreSQL-wire-compatible, so it reuses
 * the PostgreSQL connector's connection, introspection, sampling, and read-only
 * single-statement execution (which never opens a transaction — Hologres forbids
 * multi-statement DML/DDL transactions). The only override drops Hologres
 * system schemas from discovery.
 */
export class KtxHologresScanConnector extends KtxPostgresScanConnector {
  override async listSchemas(): Promise<string[]> {
    const schemas = await super.listSchemas();
    return schemas.filter((schema) => !HOLOGRES_SYSTEM_SCHEMAS.has(schema));
  }
}
