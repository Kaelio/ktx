import { describe, expect, it } from 'vitest';
import { tryIntrospectObject } from '../../../src/context/scan/object-introspection.js';

describe('tryIntrospectObject', () => {
  it('returns the read value when introspection succeeds', async () => {
    await expect(tryIntrospectObject({ object: 'customers' }, () => ({ name: 'customers' }))).resolves.toEqual({
      ok: true,
      table: { name: 'customers' },
    });
  });

  it('skips with a recoverable warning when the object read throws', async () => {
    const outcome = await tryIntrospectObject({ object: 'broken_view', db: 'main' }, () => {
      throw new Error('no such column: ehp.start_date');
    });

    expect(outcome).toEqual({
      ok: false,
      warning: {
        code: 'object_introspection_failed',
        message: 'no such column: ehp.start_date',
        table: 'broken_view',
        recoverable: true,
        metadata: { object: 'main.broken_view', db: 'main' },
      },
    });
  });

  it('rethrows native programming faults instead of masking them as object skips', async () => {
    await expect(
      tryIntrospectObject({ object: 'customers' }, () => {
        throw new TypeError('cannot read properties of undefined');
      }),
    ).rejects.toBeInstanceOf(TypeError);
  });

  it('builds a fully-qualified object label for warehouse objects', async () => {
    const outcome = await tryIntrospectObject({ object: 'orders', db: 'sales', catalog: 'warehouse' }, () => {
      throw new Error('permission denied');
    });
    expect(outcome.ok).toBe(false);
    if (!outcome.ok) {
      expect(outcome.warning.table).toBe('orders');
      expect(outcome.warning.metadata).toEqual({ object: 'warehouse.sales.orders', db: 'sales', catalog: 'warehouse' });
    }
  });
});
