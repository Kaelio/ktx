import { describe, expect, it } from 'vitest';
import { KtxQueryError } from '../../../src/errors.js';
import {
  DEFAULT_QUERY_TIMEOUT_MS,
  queryDeadlineExceededError,
  resolveQueryDeadlineMs,
} from '../../../src/context/connections/query-deadline.js';

describe('resolveQueryDeadlineMs', () => {
  it('returns the 30s default when no override is set', () => {
    expect(DEFAULT_QUERY_TIMEOUT_MS).toBe(30_000);
    expect(resolveQueryDeadlineMs(undefined)).toBe(30_000);
    expect(resolveQueryDeadlineMs({ driver: 'sqlite' })).toBe(30_000);
  });

  it('honors a positive-integer query_timeout_ms override', () => {
    expect(resolveQueryDeadlineMs({ query_timeout_ms: 5_000 })).toBe(5_000);
    expect(resolveQueryDeadlineMs({ query_timeout_ms: 1 })).toBe(1);
  });

  it('rejects a zero, negative, or non-integer override', () => {
    expect(() => resolveQueryDeadlineMs({ query_timeout_ms: 0 })).toThrow(/positive integer/);
    expect(() => resolveQueryDeadlineMs({ query_timeout_ms: -5 })).toThrow(/positive integer/);
    expect(() => resolveQueryDeadlineMs({ query_timeout_ms: 1.5 })).toThrow(/positive integer/);
    expect(() => resolveQueryDeadlineMs({ query_timeout_ms: '5000' as unknown as number })).toThrow(/positive integer/);
  });
});

describe('queryDeadlineExceededError', () => {
  it('is a KtxQueryError with the canonical seconds-rounded message', () => {
    const error = queryDeadlineExceededError(30_000);
    expect(error).toBeInstanceOf(KtxQueryError);
    expect(error.message).toBe('query exceeded 30s');
    expect(queryDeadlineExceededError(45_000).message).toBe('query exceeded 45s');
  });
});
