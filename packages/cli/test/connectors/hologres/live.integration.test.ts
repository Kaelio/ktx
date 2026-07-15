import { describe, expect, it } from 'vitest';
import { createHologresLiveDatabaseIntrospection } from '../../../src/connectors/hologres/live-database-introspection.js';
import { KtxHologresScanConnector } from '../../../src/connectors/hologres/connector.js';

// Live Hologres integration. Gated on KTX_TEST_HOLOGRES_URL (a PostgreSQL-style
// DSN; URL-encode reserved characters, e.g. `$`->%24 and `#`->%23). The
// extractSchema case additionally needs KTX_TEST_HOLOGRES_SCHEMA pointed at a
// populated schema so table discovery is asserted against real data.
const url = process.env.KTX_TEST_HOLOGRES_URL;
const schema = process.env.KTX_TEST_HOLOGRES_SCHEMA;

const HOLOGRES_SYSTEM_SCHEMAS = [
  'hologres',
  'hologres_streaming_mv',
  'hologres_statistic',
  'hologres_sample',
  'hologres_object_table',
  'hg_recyclebin',
  'hg_internal',
];

describe.skipIf(!url)('createHologresLiveDatabaseIntrospection (live Hologres)', () => {
  it('lists schemas with Hologres system schemas excluded', async () => {
    const connector = new KtxHologresScanConnector({
      connectionId: 'wh',
      connection: { driver: 'hologres', url },
    });
    try {
      const schemas = await connector.listSchemas();
      expect(schemas.length).toBeGreaterThan(0);
      for (const systemSchema of HOLOGRES_SYSTEM_SCHEMAS) {
        expect(schemas).not.toContain(systemSchema);
      }
    } finally {
      await connector.cleanup();
    }
  });

  it.skipIf(!schema)('extracts tables for a populated schema and stamps driver hologres', async () => {
    const introspection = createHologresLiveDatabaseIntrospection({
      connections: { wh: { driver: 'hologres', url, schemas: schema ? [schema] : [] } },
    });
    const snapshot = await introspection.extractSchema('wh');
    expect(snapshot.driver).toBe('hologres');
    expect(snapshot.tables.length).toBeGreaterThan(0);
    for (const table of snapshot.tables) {
      expect(table.db).toBe(schema);
      expect(table.name.length).toBeGreaterThan(0);
      expect(table.columns.length).toBeGreaterThan(0);
    }
  });
});
