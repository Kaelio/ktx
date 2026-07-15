import { describe, expect, it } from 'vitest';
import { KtxHologresHistoricSqlQueryClient } from '../../../../../src/connectors/hologres/historic-sql-query-client.js';
import { HologresQueryLogReader } from '../../../../../src/context/ingest/adapters/historic-sql/hologres-query-log-reader.js';
import {
  historicSqlUnifiedPullConfigSchema,
  type AggregatedTemplate,
} from '../../../../../src/context/ingest/adapters/historic-sql/types.js';

// Live Hologres query-log integration. Gated on KTX_TEST_HOLOGRES_URL (a
// PostgreSQL-style DSN; URL-encode reserved characters, e.g. `$`->%24, `#`->%23).
const url = process.env.KTX_TEST_HOLOGRES_URL;

describe.skipIf(!url)('HologresQueryLogReader (live Hologres)', () => {
  it('probes hg_query_log and aggregates recent templates by digest', async () => {
    const client = new KtxHologresHistoricSqlQueryClient({
      connectionId: 'wh',
      connection: { driver: 'hologres', url },
    });
    try {
      const reader = new HologresQueryLogReader();
      const probe = await reader.probe(client);
      expect(Array.isArray(probe.warnings)).toBe(true);

      const end = new Date();
      const start = new Date(end.getTime() - 30 * 24 * 60 * 60 * 1000);
      const config = historicSqlUnifiedPullConfigSchema.parse({ dialect: 'hologres', minExecutions: 1 });
      const templates: AggregatedTemplate[] = [];
      for await (const template of reader.fetchAggregated(client, { start, end }, config)) {
        templates.push(template);
      }
      expect(templates.length).toBeGreaterThan(0);
      for (const template of templates) {
        expect(template.dialect).toBe('hologres');
        expect(template.templateId.length).toBeGreaterThan(0);
        expect(template.canonicalSql.length).toBeGreaterThan(0);
        expect(template.stats.executions).toBeGreaterThanOrEqual(1);
        expect(template.stats.errorRate).toBeGreaterThanOrEqual(0);
        expect(template.stats.errorRate).toBeLessThanOrEqual(1);
      }
    } finally {
      await client.cleanup();
    }
  });
});
