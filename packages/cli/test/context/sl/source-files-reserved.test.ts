import { describe, expect, it } from 'vitest';
import { assertSafeConnectionId, isReservedConnectionId } from '../../../src/context/sl/source-files.js';

describe('reserved connection ids', () => {
  it('flags _ktx_ prefixed ids as reserved', () => {
    expect(isReservedConnectionId('_ktx_federated')).toBe(true);
    expect(isReservedConnectionId('_ktx_anything')).toBe(true);
  });

  it('does not flag normal ids', () => {
    expect(isReservedConnectionId('pg_books')).toBe(false);
    expect(isReservedConnectionId('sqlite_reviews')).toBe(false);
  });

  it('rejects a user-supplied reserved id', () => {
    expect(() => assertSafeConnectionId('_ktx_federated')).toThrow(/reserved/i);
  });

  it('still accepts normal ids', () => {
    expect(assertSafeConnectionId('pg_books')).toBe('pg_books');
  });
});
