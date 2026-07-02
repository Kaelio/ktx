import { describe, expect, it } from 'vitest';
import {
  parseSigmaPullConfig,
  sigmaManifestSchema,
  stagedDataModelFileSchema,
} from '../../../../../src/context/ingest/adapters/sigma/types.js';

describe('parseSigmaPullConfig', () => {
  it('accepts a simple alphanumeric connection ID', () => {
    const result = parseSigmaPullConfig({ sigmaConnectionId: 'sigma-prod' });
    expect(result.sigmaConnectionId).toBe('sigma-prod');
  });

  it('accepts IDs with underscores', () => {
    const result = parseSigmaPullConfig({ sigmaConnectionId: 'sigma_prod_2' });
    expect(result.sigmaConnectionId).toBe('sigma_prod_2');
  });

  it('rejects IDs starting with a special char', () => {
    expect(() => parseSigmaPullConfig({ sigmaConnectionId: '../prod' })).toThrow();
  });

  it('rejects IDs with spaces', () => {
    expect(() => parseSigmaPullConfig({ sigmaConnectionId: 'sigma prod' })).toThrow();
  });

  it('rejects missing sigmaConnectionId', () => {
    expect(() => parseSigmaPullConfig({})).toThrow();
  });

  it('rejects null', () => {
    expect(() => parseSigmaPullConfig(null)).toThrow();
  });
});

describe('stagedDataModelFileSchema', () => {
  const minimal = {
    sigmaId: 'dm-aaa111',
    name: 'Revenue Model',
    path: 'My Documents/Finance/Revenue Model',
    latestVersion: 3,
    updatedAt: '2026-01-15T10:00:00Z',
    isArchived: false,
    spec: { schemaVersion: 1, pages: [] },
  };

  it('parses a fully-populated file', () => {
    const result = stagedDataModelFileSchema.parse(minimal);
    expect(result.sigmaId).toBe('dm-aaa111');
    expect(result.name).toBe('Revenue Model');
    expect(result.isArchived).toBe(false);
  });

  it('coerces absent isArchived to false', () => {
    const { isArchived: _, ...rest } = minimal;
    void _;
    const result = stagedDataModelFileSchema.parse(rest);
    expect(result.isArchived).toBe(false);
  });

  it('accepts null spec', () => {
    const result = stagedDataModelFileSchema.parse({ ...minimal, spec: null });
    expect(result.spec).toBeNull();
  });

  it('rejects missing sigmaId', () => {
    const { sigmaId: _, ...rest } = minimal;
    void _;
    expect(() => stagedDataModelFileSchema.parse(rest)).toThrow();
  });

  it('rejects missing name', () => {
    const { name: _, ...rest } = minimal;
    void _;
    expect(() => stagedDataModelFileSchema.parse(rest)).toThrow();
  });

  it('rejects missing path', () => {
    const { path: _, ...rest } = minimal;
    void _;
    expect(() => stagedDataModelFileSchema.parse(rest)).toThrow();
  });
});

describe('sigmaManifestSchema', () => {
  const valid = {
    sigmaConnectionId: 'sigma-prod',
    fetchedAt: '2026-01-15T10:00:00Z',
    dataModelCount: 2,
  };

  it('parses a valid manifest', () => {
    const result = sigmaManifestSchema.parse(valid);
    expect(result.sigmaConnectionId).toBe('sigma-prod');
    expect(result.dataModelCount).toBe(2);
  });

  it('rejects missing fetchedAt', () => {
    const { fetchedAt: _, ...rest } = valid;
    void _;
    expect(() => sigmaManifestSchema.parse(rest)).toThrow();
  });

  it('rejects missing dataModelCount', () => {
    const { dataModelCount: _, ...rest } = valid;
    void _;
    expect(() => sigmaManifestSchema.parse(rest)).toThrow();
  });

  it('rejects a non-integer dataModelCount', () => {
    expect(() => sigmaManifestSchema.parse({ ...valid, dataModelCount: 2.5 })).toThrow();
  });
});
