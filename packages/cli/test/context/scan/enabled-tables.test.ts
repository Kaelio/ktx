import { describe, expect, it } from 'vitest';
import { resolveEnabledTables } from '../../../src/context/scan/enabled-tables.js';
import { tableRefKey } from '../../../src/context/scan/table-ref.js';

describe('resolveEnabledTables', () => {
  it('returns null when enabled_tables is absent or empty', () => {
    expect(resolveEnabledTables(undefined)).toBeNull();
    expect(resolveEnabledTables({ driver: 'sqlite' })).toBeNull();
    expect(resolveEnabledTables({ driver: 'sqlite', enabled_tables: [] })).toBeNull();
  });

  it('treats sqlite "main.<name>" as equivalent to the bare "<name>"', () => {
    const qualified = resolveEnabledTables({ driver: 'sqlite', enabled_tables: ['main.customers'] });
    const bare = resolveEnabledTables({ driver: 'sqlite', enabled_tables: ['customers'] });
    const expected = tableRefKey({ catalog: null, db: null, name: 'customers' });
    expect([...(qualified ?? [])]).toEqual([expected]);
    expect([...(bare ?? [])]).toEqual([expected]);
  });

  it('keeps the schema qualifier for non-sqlite drivers', () => {
    const scope = resolveEnabledTables({ driver: 'postgres', enabled_tables: ['public.customers'] });
    expect([...(scope ?? [])]).toEqual([tableRefKey({ catalog: null, db: 'public', name: 'customers' })]);
  });
});
