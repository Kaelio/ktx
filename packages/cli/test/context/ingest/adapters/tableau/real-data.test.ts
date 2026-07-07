import { readFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';
import { chunkTableauStagedDir } from '../../../../../src/context/ingest/adapters/tableau/chunk.js';
import { detectTableauStagedDir } from '../../../../../src/context/ingest/adapters/tableau/detect.js';
import { stagedDatasourceFileSchema } from '../../../../../src/context/ingest/adapters/tableau/types.js';

// Bundle captured from a live Tableau Cloud (Developer) site by running the adapter's fetch()
// against the built-in "Superstore" sample data source. Grounds the adapter in real Metadata API
// output rather than hand-authored shapes.
const LIVE = resolve(import.meta.dirname, '../../../../fixtures/tableau/superstore-live');

describe('Tableau adapter — live-captured Superstore bundle', () => {
  it('detects the real staged bundle', async () => {
    expect(await detectTableauStagedDir(LIVE)).toBe(true);
  });

  it('chunks into a data-sources unit and a workbooks unit', async () => {
    const result = await chunkTableauStagedDir(LIVE);
    const keys = result.workUnits.map((u) => u.unitKey).sort();
    expect(keys).toEqual(['tableau-datasources', 'tableau-workbooks']);
  });

  it('parses the Superstore data source and surfaces the "Profit Ratio" calculated field', async () => {
    const body = await readFile(resolve(LIVE, 'datasources/18ad5ef7-9b61-4c3a-9ecd-01fcd2fd079f.json'), 'utf-8');
    const ds = stagedDatasourceFileSchema.parse(JSON.parse(body));

    expect(ds.name).toBe('Superstore Datasource');
    const calc = ds.fields.find((f) => f.isCalculated);
    expect(calc?.name).toBe('Profit Ratio');
    expect(calc?.formula).toBe('SUM([Profit])/SUM([Sales])');
    // Plain column fields carry no formula.
    expect(ds.fields.some((f) => f.name === 'Sales' && !f.isCalculated)).toBe(true);
    // Upstream lineage is captured (Excel-backed sample → sheet-style table names).
    expect(ds.upstreamTables.map((t) => t.name).sort()).toEqual(['Orders', 'People', 'Returns']);
  });
});
