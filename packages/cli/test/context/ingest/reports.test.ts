import { describe, expect, it } from 'vitest';
import { ingestReportOutcome } from '../../../src/context/ingest/reports.js';
import type { IngestReportSnapshot } from '../../../src/context/ingest/reports.js';

function report(body: Partial<IngestReportSnapshot['body']>): IngestReportSnapshot {
  return {
    id: 'r',
    runId: 'run',
    jobId: 'job',
    connectionId: 'warehouse',
    sourceKey: 'metabase',
    createdAt: '2026-05-29T00:00:00.000Z',
    body: {
      syncId: 'sync',
      diffSummary: { added: 0, modified: 0, deleted: 0, unchanged: 0 },
      commitSha: null,
      workUnits: [],
      failedWorkUnits: [],
      reconciliationSkipped: false,
      conflictsResolved: [],
      evictionsApplied: [],
      unmappedFallbacks: [],
      evictionInputs: [],
      unresolvedCards: [],
      supersededBy: null,
      overrideOf: null,
      provenanceRows: [],
      toolTranscripts: [],
      ...body,
    },
  };
}

const savingWorkUnit = {
  unitKey: 'ok',
  rawFiles: ['cards/1.json'],
  status: 'success' as const,
  actions: [{ target: 'sl' as const, type: 'updated' as const, key: 'warehouse.orders', detail: 'measure' }],
  touchedSlSources: [],
};

const failedWorkUnit = {
  unitKey: 'bad',
  rawFiles: ['cards/2.json'],
  status: 'failed' as const,
  reason: 'tool write failed',
  actions: [],
  touchedSlSources: [],
};

describe('ingestReportOutcome', () => {
  it('returns done when there are no failed work units', () => {
    expect(ingestReportOutcome(report({ workUnits: [savingWorkUnit] }))).toBe('done');
  });

  it('returns partial when failed work units coexist with saved memory', () => {
    expect(
      ingestReportOutcome(report({ workUnits: [savingWorkUnit, failedWorkUnit], failedWorkUnits: ['bad'] })),
    ).toBe('partial');
  });

  it('returns partial when final gates pruned or dropped artifacts from a saved run', () => {
    expect(
      ingestReportOutcome(
        report({
          workUnits: [savingWorkUnit],
          finalGatePrunedReferences: [
            {
              kind: 'join',
              artifact: 'semantic-layer/warehouse/orders',
              removedRef: 'customers',
              absentTarget: 'customers',
            },
          ],
        }),
      ),
    ).toBe('partial');
  });

  it('returns error when failed work units produced no saved memory', () => {
    expect(ingestReportOutcome(report({ workUnits: [failedWorkUnit], failedWorkUnits: ['bad'] }))).toBe('error');
  });

  it('returns error for a stage-level failure even if artifacts were recorded', () => {
    expect(ingestReportOutcome(report({ status: 'failed', workUnits: [savingWorkUnit], failedWorkUnits: [] }))).toBe(
      'error',
    );
  });
});
