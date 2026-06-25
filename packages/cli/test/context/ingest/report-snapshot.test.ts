import { describe, expect, it } from 'vitest';
import { parseIngestReportSnapshot } from '../../../src/context/ingest/report-snapshot.js';

function validReportSnapshot() {
  return {
    id: 'report-1',
    runId: 'run-1',
    jobId: 'job-1',
    connectionId: 'warehouse',
    sourceKey: 'metabase',
    createdAt: '2026-04-30T12:00:00.000Z',
    body: {
      syncId: 'sync-1',
      diffSummary: { added: 2, modified: 1, deleted: 0, unchanged: 4 },
      commitSha: 'abc12345',
      workUnits: [
        {
          unitKey: 'cards',
          rawFiles: ['cards/1.json', 'cards/2.json'],
          status: 'success',
          actions: [
            { target: 'wiki', type: 'created', key: 'wiki/global/revenue.md', detail: 'Revenue overview' },
            { target: 'sl', type: 'updated', key: 'warehouse.orders', detail: 'Added order amount measure' },
          ],
          touchedSlSources: [{ connectionId: 'warehouse', sourceName: 'orders' }],
        },
      ],
      failedWorkUnits: [],
      reconciliationSkipped: false,
      conflictsResolved: [],
      evictionsApplied: [],
      unmappedFallbacks: [],
      evictionInputs: [],
      unresolvedCards: [],
      supersededBy: null,
      overrideOf: null,
      provenanceRows: [
        {
          rawPath: 'cards/1.json',
          artifactKind: 'wiki',
          artifactKey: 'wiki/global/revenue.md',
          actionType: 'wiki_written',
        },
      ],
      toolTranscripts: [
        {
          unitKey: 'cards',
          path: 'tool-transcripts/cards.jsonl',
          toolCallCount: 3,
          errorCount: 0,
          toolNames: ['wiki_capture'],
        },
      ],
      reconciliationActions: [],
      evictionDecisions: [],
      context: {
        documentsIndexed: 2,
        chunksIndexed: 2,
        documentsDeleted: 0,
        embeddingFailures: 0,
        candidatesCreated: 1,
        candidatesPromoted: 1,
        candidatesRejected: 0,
        knowledgeCreates: 1,
        knowledgeUpdates: 0,
        capped: false,
        warnings: [],
      },
    },
  };
}

describe('parseIngestReportSnapshot', () => {
  it('parses a bundle ingest report snapshot and preserves report detail arrays', () => {
    const snapshot = parseIngestReportSnapshot(validReportSnapshot());

    expect(snapshot).toMatchObject({
      id: 'report-1',
      runId: 'run-1',
      jobId: 'job-1',
      connectionId: 'warehouse',
      sourceKey: 'metabase',
      body: {
        syncId: 'sync-1',
        commitSha: 'abc12345',
        failedWorkUnits: [],
      },
    });
    expect(snapshot.body.workUnits[0]?.actions).toEqual([
      {
        target: 'wiki',
        type: 'created',
        key: 'wiki/global/revenue.md',
        detail: 'Revenue overview',
        targetConnectionId: null,
      },
      {
        target: 'sl',
        type: 'updated',
        key: 'warehouse.orders',
        detail: 'Added order amount measure',
        targetConnectionId: null,
      },
    ]);
    expect(snapshot.body.provenanceRows).toHaveLength(1);
    expect(snapshot.body.toolTranscripts).toHaveLength(1);
  });

  it('parses final gate prune and drop arrays', () => {
    const report: any = validReportSnapshot();
    report.body.finalGatePrunedReferences = [
      {
        kind: 'join',
        artifact: 'semantic-layer/warehouse/orders',
        removedRef: 'customers',
        absentTarget: 'customers',
      },
    ] as never;
    report.body.finalGateDroppedSources = [
      { connectionId: 'warehouse', sourceName: 'bad', reason: 'dry run failed' },
    ] as never;

    const snapshot = parseIngestReportSnapshot(report);

    expect(snapshot.body.finalGatePrunedReferences).toEqual(report.body.finalGatePrunedReferences);
    expect(snapshot.body.finalGateDroppedSources).toEqual(report.body.finalGateDroppedSources);
  });

  it('parses target-aware actions and touched source objects', () => {
    const report = validReportSnapshot();
    report.body.workUnits[0] = {
      ...report.body.workUnits[0],
      actions: [
        {
          target: 'sl',
          type: 'created',
          key: 'looker__b2b__sales_pipeline',
          detail: 'Created source',
          targetConnectionId: 'warehouse-1',
        },
      ],
      touchedSlSources: [{ connectionId: 'warehouse-1', sourceName: 'looker__b2b__sales_pipeline' }],
    } as never;

    const snapshot = parseIngestReportSnapshot(report);

    expect(snapshot.body.workUnits[0]?.actions).toEqual([
      {
        target: 'sl',
        type: 'created',
        key: 'looker__b2b__sales_pipeline',
        detail: 'Created source',
        targetConnectionId: 'warehouse-1',
      },
    ]);
    expect(snapshot.body.workUnits[0]?.touchedSlSources).toEqual([
      { connectionId: 'warehouse-1', sourceName: 'looker__b2b__sales_pipeline' },
    ]);
  });

  it('parses captured memory-flow snapshots in report bodies', () => {
    const report = validReportSnapshot();
    report.body = {
      ...report.body,
      memoryFlow: {
        metadata: {
          schemaVersion: 1,
          mode: 'full',
          origin: 'captured',
          timing: 'captured',
          capturedAt: '2026-05-01T10:00:03.000Z',
          sourceReportId: null,
          sourceReportPath: null,
          fallbackReason: null,
        },
        runId: 'run-1',
        connectionId: 'warehouse',
        adapter: 'lookml',
        status: 'running',
        sourceDir: null,
        syncId: 'sync-2',
        errors: [],
        plannedWorkUnits: [],
        details: { actions: [], provenance: [], transcripts: [] },
        events: [
          {
            type: 'source_acquired',
            adapter: 'lookml',
            trigger: 'manual_resync',
            fileCount: 2,
            emittedAt: '2026-05-01T10:00:00.000Z',
          },
        ],
      },
    } as typeof report.body;

    expect(parseIngestReportSnapshot(report).body.memoryFlow?.events).toEqual([
      {
        type: 'source_acquired',
        adapter: 'lookml',
        trigger: 'manual_resync',
        fileCount: 2,
        emittedAt: '2026-05-01T10:00:00.000Z',
      },
    ]);
  });

  it('applies defaults for optional report fields emitted by older reports', () => {
    const report = validReportSnapshot();
    delete (report.body as Record<string, unknown>).conflictsResolved;
    delete (report.body as Record<string, unknown>).evictionsApplied;
    delete (report.body as Record<string, unknown>).unmappedFallbacks;
    delete (report.body as Record<string, unknown>).supersededBy;
    delete (report.body as Record<string, unknown>).overrideOf;
    delete (report.body as Record<string, unknown>).provenanceRows;
    delete (report.body as Record<string, unknown>).toolTranscripts;

    const snapshot = parseIngestReportSnapshot(report);

    expect(snapshot.body.conflictsResolved).toEqual([]);
    expect(snapshot.body.evictionsApplied).toEqual([]);
    expect(snapshot.body.unmappedFallbacks).toEqual([]);
    expect(snapshot.body.supersededBy).toBeNull();
    expect(snapshot.body.overrideOf).toBeNull();
    expect(snapshot.body.provenanceRows).toEqual([]);
    expect(snapshot.body.toolTranscripts).toEqual([]);
  });

  it('parses failed ingest reports with trace and failure details', () => {
    const snapshot = parseIngestReportSnapshot({
      id: 'report-failed',
      runId: 'run-failed',
      jobId: 'job-failed',
      connectionId: 'warehouse',
      sourceKey: 'metabase',
      createdAt: '2026-05-17T12:00:00.000Z',
      body: {
        status: 'failed',
        syncId: 'sync-failed',
        diffSummary: { added: 1, modified: 0, deleted: 0, unchanged: 0 },
        commitSha: null,
        tracePath: '/project/.ktx/ingest-traces/job-failed/trace.jsonl',
        failure: {
          phase: 'final_gates',
          message: 'final artifact gates failed',
        },
        workUnits: [],
        failedWorkUnits: [],
        reconciliationSkipped: true,
        conflictsResolved: [],
        evictionsApplied: [],
        unmappedFallbacks: [],
        evictionInputs: [],
        unresolvedCards: [],
        supersededBy: null,
        overrideOf: null,
        provenanceRows: [],
        toolTranscripts: [],
      },
    });

    expect(snapshot.body.status).toBe('failed');
    expect(snapshot.body.failure).toEqual({
      phase: 'final_gates',
      message: 'final artifact gates failed',
    });
    expect(snapshot.body.tracePath).toContain('trace.jsonl');
  });

  it('rejects malformed report snapshots with a concise message', () => {
    const report = validReportSnapshot();
    report.body.workUnits[0] = {
      ...report.body.workUnits[0],
      actions: [{ target: 'database', type: 'created', key: 'bad', detail: 'bad target' }],
    } as never;

    expect(() => parseIngestReportSnapshot(report)).toThrow('Invalid ingest report snapshot');
  });

  it('parses isolated-diff textual resolver counters', () => {
    const snapshot = parseIngestReportSnapshot({
      id: 'report-1',
      runId: 'run-1',
      jobId: 'job-1',
      connectionId: 'warehouse',
      sourceKey: 'metabase',
      createdAt: '2026-05-18T00:00:00.000Z',
      body: {
        status: 'completed',
        syncId: 'sync-1',
        diffSummary: { added: 0, modified: 1, deleted: 0, unchanged: 0 },
        commitSha: 'abc123',
        isolatedDiff: {
          enabled: true,
          acceptedPatches: 2,
          textualConflicts: 1,
          semanticConflicts: 0,
          resolverAttempts: 1,
          resolverRepairs: 1,
          resolverFailures: 0,
        },
        workUnits: [],
        failedWorkUnits: [],
        reconciliationSkipped: true,
        conflictsResolved: [],
        evictionsApplied: [],
        unmappedFallbacks: [],
        artifactResolutions: [],
        evictionInputs: [],
        unresolvedCards: [],
        supersededBy: null,
        overrideOf: null,
        provenanceRows: [],
        toolTranscripts: [],
      },
    });

    expect(snapshot.body.isolatedDiff).toMatchObject({
      resolverAttempts: 1,
      resolverRepairs: 1,
      resolverFailures: 0,
    });
  });

});
