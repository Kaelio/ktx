import { KtxExpectedError } from '../../errors.js';
import {
  connectorTestFailure,
  type KtxConnectorTestResult,
  type KtxScanContext,
  type KtxScanInput,
  type KtxSchemaSnapshot,
} from '../../context/scan/types.js';
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

// ktx supports Hologres from major version 4.0 onward.
const HOLOGRES_MIN_MAJOR_VERSION = 4;
const HOLOGRES_VERSION_SQL = 'select hg_version()';

export type KtxHologresConnectionConfig = KtxPostgresConnectionConfig;

export function isKtxHologresConnectionConfig(
  connection: KtxHologresConnectionConfig | undefined,
): connection is KtxHologresConnectionConfig {
  return String(connection?.driver ?? '').toLowerCase() === 'hologres';
}

// hg_version() returns e.g. "Hologres 4.2.10 (tag: ...), compatible with
// PostgreSQL 11.3 ...". The three-part version follows the "Hologres " prefix, so
// anchor there to avoid matching the compatible-PostgreSQL version.
function parseHologresMajorVersion(raw: string): { version: string; major: number } | null {
  const match = /Hologres\s+v?(\d+)(?:\.(\d+))?(?:\.(\d+))?/i.exec(raw);
  if (!match) {
    return null;
  }
  const major = Number.parseInt(match[1] ?? '', 10);
  if (!Number.isFinite(major)) {
    return null;
  }
  const version = [match[1], match[2], match[3]].filter((part) => part !== undefined).join('.');
  return { version, major };
}

/**
 * Hologres scan connector. Hologres is PostgreSQL-wire-compatible, so it reuses
 * the PostgreSQL connector's connection, introspection, sampling, and read-only
 * single-statement execution (which never opens a transaction — Hologres forbids
 * multi-statement DML/DDL transactions). It drops Hologres system schemas from
 * discovery and requires Hologres 4.0+, the first version that supports ktx.
 */
export class KtxHologresScanConnector extends KtxPostgresScanConnector {
  override async testConnection(): Promise<KtxConnectorTestResult> {
    const base = await super.testConnection();
    if (!base.success) {
      return base;
    }
    try {
      await this.assertSupportedHologresVersion(this.connectionId);
      return { success: true };
    } catch (error) {
      return connectorTestFailure(error);
    }
  }

  override async introspect(input: KtxScanInput, ctx: KtxScanContext): Promise<KtxSchemaSnapshot> {
    await this.assertSupportedHologresVersion(input.connectionId);
    return super.introspect(input, ctx);
  }

  override async listSchemas(): Promise<string[]> {
    const schemas = await super.listSchemas();
    return schemas.filter((schema) => !HOLOGRES_SYSTEM_SCHEMAS.has(schema));
  }

  private async assertSupportedHologresVersion(connectionId: string): Promise<void> {
    let raw: string;
    try {
      const result = await this.executeReadOnly({ connectionId, sql: HOLOGRES_VERSION_SQL }, {} as never);
      const cell = result.rows[0]?.[0];
      raw = typeof cell === 'string' ? cell : String(cell ?? '');
    } catch (error) {
      throw new KtxExpectedError(
        'ktx requires Hologres 4.0 or newer. Could not read the Hologres version via hg_version(); ' +
          'confirm this is a Hologres instance running 4.0 or later.',
        { cause: error },
      );
    }
    const parsed = parseHologresMajorVersion(raw);
    if (!parsed) {
      throw new KtxExpectedError(
        `ktx requires Hologres 4.0 or newer, but hg_version() returned an unrecognized version string: ${raw}`,
      );
    }
    if (parsed.major < HOLOGRES_MIN_MAJOR_VERSION) {
      throw new KtxExpectedError(
        `ktx requires Hologres 4.0 or newer; this connection reports Hologres ${parsed.version}.`,
      );
    }
  }
}
