import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';
import { chunkTableauStagedDir } from '../../../../../src/context/ingest/adapters/tableau/chunk.js';

const FIXTURES = resolve(import.meta.dirname, '../../../../fixtures/tableau');

describe('chunkTableauStagedDir', () => {
  it('emits one data-sources unit and one workbooks unit', async () => {
    const result = await chunkTableauStagedDir(resolve(FIXTURES, 'single'));
    const keys = result.workUnits.map((u) => u.unitKey).sort();
    expect(keys).toEqual(['tableau-datasources', 'tableau-workbooks']);

    const dsUnit = result.workUnits.find((u) => u.unitKey === 'tableau-datasources')!;
    expect(dsUnit.rawFiles).toEqual(['datasources/ds-1.json']);
    // The workbook file is available as a peer, not a raw file, for the data-sources unit.
    expect(dsUnit.peerFileIndex).toContain('workbooks/wb-1.json');
  });

  it('returns no work units when the manifest is absent', async () => {
    const result = await chunkTableauStagedDir(resolve(FIXTURES, 'single', 'datasources'));
    expect(result.workUnits).toEqual([]);
  });

  it('is deterministic across runs', async () => {
    const a = await chunkTableauStagedDir(resolve(FIXTURES, 'single'));
    const b = await chunkTableauStagedDir(resolve(FIXTURES, 'single'));
    expect(JSON.stringify(a)).toBe(JSON.stringify(b));
  });

  it('keeps only touched units when a diffSet is supplied', async () => {
    const result = await chunkTableauStagedDir(resolve(FIXTURES, 'single'), {
      diffSet: { added: [], modified: ['datasources/ds-1.json'], deleted: [], unchanged: ['workbooks/wb-1.json'] },
    });
    expect(result.workUnits.map((u) => u.unitKey)).toEqual(['tableau-datasources']);
  });
});
