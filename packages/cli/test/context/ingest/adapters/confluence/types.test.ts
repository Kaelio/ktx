import { describe, expect, it } from 'vitest';
import {
  confluencePullConfigSchema,
  parseConfluencePullConfig,
} from '../../../../../src/context/ingest/adapters/confluence/types.js';

describe('parseConfluencePullConfig', () => {
  it('accepts a minimal config with just a connection ID', () => {
    const result = parseConfluencePullConfig({ confluenceConnectionId: 'confluence-prod' });
    expect(result.confluenceConnectionId).toBe('confluence-prod');
  });

  it('accepts IDs with underscores and hyphens', () => {
    const result = parseConfluencePullConfig({ confluenceConnectionId: 'my_confluence-1' });
    expect(result.confluenceConnectionId).toBe('my_confluence-1');
  });

  it('rejects IDs starting with a special char', () => {
    expect(() => parseConfluencePullConfig({ confluenceConnectionId: '-bad' })).toThrow();
  });

  it('accepts spaceKeys when provided', () => {
    const result = parseConfluencePullConfig({
      confluenceConnectionId: 'c',
      spaceKeys: ['ENG', 'PROD'],
    });
    expect(result.spaceKeys).toEqual(['ENG', 'PROD']);
  });
});

describe('confluencePullConfigSchema', () => {
  it('parses a minimal config', () => {
    const result = confluencePullConfigSchema.parse({ confluenceConnectionId: 'c' });
    expect(result.confluenceConnectionId).toBe('c');
  });
});
