import { describe, expect, it } from 'vitest';
import { buildAttachStatements } from '../../../src/connectors/duckdb/federated-executor.js';
import { attachTypeForDriver, type FederatedMember } from '../../../src/context/connections/federation.js';

const member = (
  connectionId: string,
  driver: string,
  connection: FederatedMember['connection'],
): FederatedMember => ({ connectionId, driver, projectDir: '/proj', connection });

describe('attachTypeForDriver', () => {
  it('maps drivers to DuckDB attach extension types', () => {
    expect(attachTypeForDriver('postgres')).toBe('postgres');
    expect(attachTypeForDriver('mysql')).toBe('mysql');
    expect(attachTypeForDriver('sqlite')).toBe('sqlite');
  });

  it('throws for an unsupported driver', () => {
    expect(() => attachTypeForDriver('snowflake')).toThrow(/cannot be attached/i);
  });
});

describe('buildAttachStatements', () => {
  it('loads each driver type once, then emits READ_ONLY ATTACH aliased by connectionId, resolving env refs', () => {
    const stmts = buildAttachStatements(
      [
        member('pg_books', 'postgres', { driver: 'postgres', url: 'env:PG_URL' }),
        member('sqlite_reviews', 'sqlite', { driver: 'sqlite', path: '/data/reviews.db' }),
      ],
      { PG_URL: 'postgresql://localhost/books' },
    );
    expect(stmts).toEqual([
      'INSTALL postgres; LOAD postgres;',
      'INSTALL sqlite; LOAD sqlite;',
      'ATTACH \'postgresql://localhost/books\' AS "pg_books" (TYPE postgres, READ_ONLY);',
      'ATTACH \'/data/reviews.db\' AS "sqlite_reviews" (TYPE sqlite, READ_ONLY);',
    ]);
  });

  it('loads a shared driver type only once across members', () => {
    const stmts = buildAttachStatements(
      [
        member('pg_a', 'postgres', { driver: 'postgres', url: 'postgresql://h/a' }),
        member('pg_b', 'postgres', { driver: 'postgres', url: 'postgresql://h/b' }),
      ],
      {},
    );
    expect(stmts).toEqual([
      'INSTALL postgres; LOAD postgres;',
      'ATTACH \'postgresql://h/a\' AS "pg_a" (TYPE postgres, READ_ONLY);',
      'ATTACH \'postgresql://h/b\' AS "pg_b" (TYPE postgres, READ_ONLY);',
    ]);
  });

  it('quotes a hyphenated connection id as a DuckDB identifier', () => {
    const stmts = buildAttachStatements(
      [member('postgres-warehouse', 'postgres', { driver: 'postgres', url: 'postgresql://h/db' })],
      {},
    );
    expect(stmts.at(-1)).toBe(`ATTACH 'postgresql://h/db' AS "postgres-warehouse" (TYPE postgres, READ_ONLY);`);
  });

  it('escapes single quotes in a resolved attach target', () => {
    const stmts = buildAttachStatements(
      [member('pg', 'postgres', { driver: 'postgres', url: "postgresql://u:it's@h/db" })],
      {},
    );
    expect(stmts.at(-1)).toBe('ATTACH \'postgresql://u:it\'\'s@h/db\' AS "pg" (TYPE postgres, READ_ONLY);');
  });
});
