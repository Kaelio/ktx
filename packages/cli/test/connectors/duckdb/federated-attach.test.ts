import { mkdtempSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { federatedAttachTarget } from '../../../src/connectors/duckdb/federated-attach.js';
import type { FederatedMember } from '../../../src/context/connections/federation.js';

const member = (over: Partial<FederatedMember>): FederatedMember => ({
  connectionId: 'm',
  driver: 'sqlite',
  projectDir: '/proj',
  connection: { driver: 'sqlite' },
  ...over,
});

describe('federatedAttachTarget', () => {
  it('resolves a sqlite path: config to an absolute filesystem path against projectDir', () => {
    const dir = mkdtempSync(join(tmpdir(), 'ktx-attach-'));
    writeFileSync(join(dir, 'reviews.db'), '');
    try {
      const target = federatedAttachTarget(
        member({ driver: 'sqlite', projectDir: dir, connection: { driver: 'sqlite', path: './reviews.db' } }),
        {},
      );
      expect(target).toBe(join(dir, 'reviews.db'));
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('resolves a sqlite file:// url to a filesystem path', () => {
    const target = federatedAttachTarget(
      member({ driver: 'sqlite', connection: { driver: 'sqlite', url: 'file:///data/reviews.db' } }),
      {},
    );
    expect(target).toBe('/data/reviews.db');
  });

  it('builds a libpq connection string for postgres from host/database/user', () => {
    const target = federatedAttachTarget(
      member({
        driver: 'postgres',
        connection: { driver: 'postgres', host: 'h', port: 5433, database: 'books', username: 'u', password: 'p' },
      }),
      {},
    );
    expect(target).toContain('host=h');
    expect(target).toContain('port=5433');
    expect(target).toContain('dbname=books');
    expect(target).toContain('user=u');
    expect(target).toContain('password=p');
  });

  it('passes a postgres url through as the connection string', () => {
    const target = federatedAttachTarget(
      member({ driver: 'postgres', connection: { driver: 'postgres', url: 'env:PG_URL' } }),
      { PG_URL: 'postgresql://localhost/books' },
    );
    expect(target).toBe('postgresql://localhost/books');
  });

  it('adds sslmode=require to a postgres url when the member sets ssl', () => {
    const target = federatedAttachTarget(
      member({ driver: 'postgres', connection: { driver: 'postgres', url: 'env:PG_URL', ssl: true } }),
      { PG_URL: 'postgresql://localhost/books' },
    );
    expect(target).toContain('sslmode=require');
  });

  it('keeps a stronger sslmode already pinned in a postgres url', () => {
    const target = federatedAttachTarget(
      member({ driver: 'postgres', connection: { driver: 'postgres', url: 'env:PG_URL', ssl: true } }),
      { PG_URL: 'postgresql://localhost/books?sslmode=verify-full' },
    );
    expect(target).toContain('sslmode=verify-full');
    expect(target).not.toContain('sslmode=require');
  });

  it('builds a mysql connection string from host/database/user', () => {
    const target = federatedAttachTarget(
      member({
        driver: 'mysql',
        connection: { driver: 'mysql', host: 'h', port: 3307, database: 'app', username: 'u', password: 'p' },
      }),
      {},
    );
    expect(target).toContain('host=h');
    expect(target).toContain('port=3307');
    expect(target).toContain('database=app');
    expect(target).toContain('user=u');
    expect(target).toContain('password=p');
  });

  it('quotes mysql values containing spaces', () => {
    const target = federatedAttachTarget(
      member({
        driver: 'mysql',
        connection: { driver: 'mysql', host: 'h', database: 'app', username: 'u', password: 'pass word' }, // pragma: allowlist secret
      }),
      {},
    );
    expect(target).toContain("password='pass word'"); // pragma: allowlist secret
  });

  it('emits sslmode=require for a postgres member configured with discrete fields and ssl', () => {
    const target = federatedAttachTarget(
      member({
        driver: 'postgres',
        connection: { driver: 'postgres', host: 'h', database: 'db', username: 'u', ssl: true },
      }),
      {},
    );
    expect(target).toContain('sslmode=require');
  });

  it('passes through the postgres search_path as options', () => {
    const target = federatedAttachTarget(
      member({
        driver: 'postgres',
        connection: { driver: 'postgres', host: 'h', database: 'db', username: 'u', schema: 'analytics' },
      }),
      {},
    );
    expect(target).toContain('search_path=analytics');
  });

  it('emits ssl_mode=REQUIRED for a mysql member with ssl', () => {
    const target = federatedAttachTarget(
      member({
        driver: 'mysql',
        connection: { driver: 'mysql', host: 'h', database: 'db', username: 'u', ssl: true },
      }),
      {},
    );
    expect(target).toContain('ssl_mode=REQUIRED');
  });

  it('resolves a duckdb member to its database file path', () => {
    const target = federatedAttachTarget(
      { connectionId: 'dux', driver: 'duckdb', projectDir: '/p', connection: { driver: 'duckdb', path: 'a.duckdb' } },
      {},
    );
    expect(target).toBe('/p/a.duckdb');
  });

  it('throws for an unsupported driver', () => {
    expect(() => federatedAttachTarget(member({ driver: 'snowflake', connection: { driver: 'snowflake' } }), {})).toThrow(
      /cannot be attached/i,
    );
  });
});
