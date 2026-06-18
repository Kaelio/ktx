import { describe, expect, it } from 'vitest';
import {
  deriveFederatedConnection,
  federatedConnectionListing,
  FEDERATED_CONNECTION_ID,
} from '../../../src/context/connections/federation.js';

const conns = (entries: Record<string, { driver: string; [k: string]: unknown }>) => entries as never;

describe('deriveFederatedConnection', () => {
  it('returns null with zero compatible members', () => {
    expect(deriveFederatedConnection(conns({ snow: { driver: 'snowflake' } }), '/proj')).toBeNull();
  });

  it('returns null with exactly one compatible member', () => {
    expect(deriveFederatedConnection(conns({ pg: { driver: 'postgres' } }), '/proj')).toBeNull();
  });

  it('derives a descriptor with two compatible members', () => {
    const result = deriveFederatedConnection(
      conns({ pg: { driver: 'postgres' }, lite: { driver: 'sqlite' } }),
      '/proj',
    );
    expect(result).not.toBeNull();
    expect(result?.id).toBe(FEDERATED_CONNECTION_ID);
    expect(result?.driver).toBe('duckdb');
    expect(result?.members.map((m) => m.connectionId).sort()).toEqual(['lite', 'pg']);
  });

  it('carries each member connection config and projectDir', () => {
    const result = deriveFederatedConnection(
      conns({ pg: { driver: 'postgres', host: 'h' }, lite: { driver: 'sqlite', path: './a.db' } }),
      '/proj',
    );
    const pg = result?.members.find((m) => m.connectionId === 'pg');
    expect(pg?.connection).toEqual({ driver: 'postgres', host: 'h' });
    expect(pg?.projectDir).toBe('/proj');
  });

  it('excludes incompatible members from the group', () => {
    const result = deriveFederatedConnection(
      conns({ pg: { driver: 'postgres' }, my: { driver: 'mysql' }, snow: { driver: 'snowflake' } }),
      '/proj',
    );
    expect(result?.members.map((m) => m.connectionId).sort()).toEqual(['my', 'pg']);
  });

  it('is case-insensitive on driver names', () => {
    const result = deriveFederatedConnection(
      conns({ pg: { driver: 'POSTGRES' }, lite: { driver: 'SQLite' } }),
      '/proj',
    );
    expect(result?.members).toHaveLength(2);
  });
});

describe('federatedConnectionListing', () => {
  it('returns null with fewer than 2 attach-compatible connections', () => {
    expect(
      federatedConnectionListing({ books_db: { driver: 'sqlite', path: './b.db' } }, '/tmp/p'),
    ).toBeNull();
  });

  it('returns id, driver, member ids and a usage hint with 2+ members', () => {
    const listing = federatedConnectionListing(
      {
        books_db: { driver: 'sqlite', path: './b.db' },
        reviews_db: { driver: 'sqlite', path: './r.db' },
        snow: { driver: 'snowflake', account: 'x' },
      },
      '/tmp/p',
    );
    expect(listing).not.toBeNull();
    expect(listing!.id).toBe(FEDERATED_CONNECTION_ID);
    expect(listing!.driver).toBe('duckdb');
    expect(listing!.members).toEqual(['books_db', 'reviews_db']);
    expect(listing!.hint).toContain('Cross-database');
    expect(listing!.hint).toContain('connectionId.table');
  });
});
