import { describe, expect, it, vi } from 'vitest';
import { formatInvalidWuSources, validateWuTouchedSources } from '../../../../src/context/ingest/stages/validate-wu-sources.js';

function makeSemanticLayerService(sourcesByConnection: Record<string, Array<{ name: string; joins?: Array<{ to: string }> }>>) {
  return {
    loadAllSources: vi.fn(async (connectionId: string) => ({
      sources: sourcesByConnection[connectionId] ?? [],
      loadErrors: [],
    })),
  };
}

describe('validateWuTouchedSources', () => {
  it('validates each touched source against its own connection and carries validator errors', async () => {
    const validateSingleSource = vi
      .fn()
      .mockImplementation((_deps: unknown, conn: string, name: string) =>
        Promise.resolve(
          conn === 'warehouse-a' && name === 'good'
            ? { errors: [], warnings: [] }
            : { errors: ['invalid measure'], warnings: [] },
        ),
      );
    const deps = {
      semanticLayerService: makeSemanticLayerService({
        'warehouse-a': [{ name: 'good' }],
        'warehouse-b': [{ name: 'bad' }],
      }),
      slValidator: { validateSingleSource },
    } as any;

    const result = await validateWuTouchedSources(deps, [
      { connectionId: 'warehouse-a', sourceName: 'good' },
      { connectionId: 'warehouse-b', sourceName: 'bad' },
    ]);

    expect(result.validSources).toEqual(['warehouse-a:good']);
    expect(result.invalidSources).toMatchObject([{ source: 'warehouse-b:bad', errors: ['invalid measure'] }]);
  });

  it('returns empty arrays when no sources are touched', async () => {
    const validateSingleSource = vi.fn();
    const semanticLayerService = makeSemanticLayerService({});
    const deps = { semanticLayerService, slValidator: { validateSingleSource } } as any;
    const result = await validateWuTouchedSources(deps, []);
    expect(result).toEqual({ validSources: [], invalidSources: [] });
    expect(validateSingleSource).not.toHaveBeenCalled();
    expect(semanticLayerService.loadAllSources).not.toHaveBeenCalled();
  });

  it('expands the validated set with existing join neighbors in both directions', async () => {
    const validateSingleSource = vi.fn().mockResolvedValue({ errors: [], warnings: [] });
    const deps = {
      semanticLayerService: makeSemanticLayerService({
        warehouse: [
          { name: 'accounts', joins: [] },
          { name: 'orders', joins: [{ to: 'accounts' }] },
          { name: 'segments', joins: [{ to: 'accounts' }] },
          { name: 'unrelated', joins: [] },
        ],
      }),
      slValidator: { validateSingleSource },
    } as any;

    const result = await validateWuTouchedSources(deps, [{ connectionId: 'warehouse', sourceName: 'accounts' }]);

    expect(result.validSources).toEqual(['warehouse:accounts', 'warehouse:orders', 'warehouse:segments']);
    expect(validateSingleSource.mock.calls.map((call) => call[2])).toEqual(['accounts', 'orders', 'segments']);
  });

  it('reports a dangling join target as an error on the source that declares it', async () => {
    // Regression: a Metabase work unit wrote mart_account_segments with
    // `joins: [{to: accounts}]` while no `accounts` source exists anywhere.
    // The error must name the declaring source, not the phantom neighbor.
    const validateSingleSource = vi.fn().mockResolvedValue({ errors: [], warnings: [] });
    const deps = {
      semanticLayerService: makeSemanticLayerService({
        warehouse: [{ name: 'mart_account_segments', joins: [{ to: 'accounts' }] }],
      }),
      slValidator: { validateSingleSource },
    } as any;

    const result = await validateWuTouchedSources(deps, [
      { connectionId: 'warehouse', sourceName: 'mart_account_segments' },
    ]);

    expect(result.validSources).toEqual([]);
    expect(result.invalidSources).toMatchObject([
      {
        source: 'warehouse:mart_account_segments',
        errors: ['join target "accounts" does not exist'],
      },
    ]);
    // The phantom target is not validated as a source of its own.
    expect(validateSingleSource.mock.calls.map((call) => call[2])).toEqual(['mart_account_segments']);
  });

  it('reports a join left dangling by a deletion on the surviving source', async () => {
    const validateSingleSource = vi.fn().mockResolvedValue({ errors: [], warnings: [] });
    const deps = {
      semanticLayerService: makeSemanticLayerService({
        // `accounts` was deleted by this work unit: touched but absent from
        // the loaded sources. `orders` still joins to it.
        warehouse: [{ name: 'orders', joins: [{ to: 'accounts' }] }],
      }),
      slValidator: { validateSingleSource },
    } as any;

    const result = await validateWuTouchedSources(deps, [{ connectionId: 'warehouse', sourceName: 'accounts' }]);

    expect(result.invalidSources).toContainEqual(
      expect.objectContaining({
        source: 'warehouse:orders',
        errors: ['join target "accounts" does not exist'],
      }),
    );
  });

  it('rejects join targets that match a source name only case-insensitively', async () => {
    // The Python engine resolves joins[].to by exact name; a case mismatch
    // would pass a lenient gate and then fail every query as an orphan.
    const validateSingleSource = vi.fn().mockResolvedValue({ errors: [], warnings: [] });
    const deps = {
      semanticLayerService: makeSemanticLayerService({
        warehouse: [{ name: 'SIGNED_UP' }, { name: 'orders', joins: [{ to: 'signed_up' }] }],
      }),
      slValidator: { validateSingleSource },
    } as any;

    const result = await validateWuTouchedSources(deps, [{ connectionId: 'warehouse', sourceName: 'orders' }]);

    expect(result.invalidSources).toMatchObject([
      {
        source: 'warehouse:orders',
        errors: [
          'join target "signed_up" does not exist; join targets are case-sensitive — the source is named "SIGNED_UP"',
        ],
      },
    ]);
  });

  it('ignores pre-existing dangling joins on sources unrelated to this change set', async () => {
    const validateSingleSource = vi.fn().mockResolvedValue({ errors: [], warnings: [] });
    const deps = {
      semanticLayerService: makeSemanticLayerService({
        warehouse: [
          { name: 'touched_source', joins: [] },
          { name: 'legacy', joins: [{ to: 'phantom' }] },
        ],
      }),
      slValidator: { validateSingleSource },
    } as any;

    const result = await validateWuTouchedSources(deps, [{ connectionId: 'warehouse', sourceName: 'touched_source' }]);

    expect(result.invalidSources).toEqual([]);
    expect(result.validSources).toEqual(['warehouse:touched_source']);
  });

  it('preserves structured source-validation and missing-join issues', async () => {
    const result = await validateWuTouchedSources(
      {
        semanticLayerService: {
          loadAllSources: vi.fn().mockResolvedValue({
            sources: [
              {
                name: 'orders',
                columns: [],
                joins: [{ to: 'customers_missing', on: 'orders.customer_id = customers_missing.id' }],
                measures: [],
                segments: [],
              },
            ],
            loadErrors: [],
          }),
        } as never,
        connections: {} as never,
        configService: {} as never,
        gitService: {} as never,
        slSourcesRepository: {} as never,
        probeRowCount: 0,
        slValidator: { validateSingleSource: vi.fn().mockResolvedValue({ errors: ['dry run failed'], warnings: [] }) },
      },
      [{ connectionId: 'warehouse', sourceName: 'orders' }],
    );

    expect(result.invalidSources).toEqual([
      {
        source: 'warehouse:orders',
        errors: ['dry run failed', 'join target "customers_missing" does not exist'],
        issues: [
          { kind: 'source_validation', message: 'dry run failed' },
          {
            kind: 'missing_join_target',
            targetSourceName: 'customers_missing',
            caseMismatch: null,
            message: 'join target "customers_missing" does not exist',
          },
        ],
      },
    ]);
  });
});

describe('formatInvalidWuSources', () => {
  it('joins each source with its reasons', () => {
    expect(
      formatInvalidWuSources([
        { source: 'warehouse:mart_account_segments', errors: ['join target "accounts" does not exist'] },
        { source: 'warehouse:bad', errors: ['invalid YAML', 'duplicate measure'] },
      ]),
    ).toBe(
      'warehouse:mart_account_segments (join target "accounts" does not exist), ' +
        'warehouse:bad (invalid YAML; duplicate measure)',
    );
  });
});
