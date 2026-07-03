import { describe, expect, it } from 'vitest';
import { jsonSafeBigint, toJsonSafeRows } from '../../../src/connectors/shared/duckdb-json-safe.js';

describe('duckdb json-safe bigint', () => {
  it('keeps safe-range bigints as numbers', () => {
    expect(jsonSafeBigint(42n)).toBe(42);
  });

  it('stringifies bigints beyond Number.MAX_SAFE_INTEGER', () => {
    const big = BigInt(Number.MAX_SAFE_INTEGER) + 10n;
    expect(jsonSafeBigint(big)).toBe(big.toString());
  });

  it('converts only bigint cells in a row matrix', () => {
    expect(toJsonSafeRows([[1n, 'a', null]])).toEqual([[1, 'a', null]]);
  });
});
