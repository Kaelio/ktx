import { describe, expect, it } from 'vitest';
import { KtxExpectedError, KtxQueryError } from '../../../src/errors.js';
import {
  assertReadOnlySql,
  limitSqlForExecution,
  stripTrailingSqlNoise,
} from '../../../src/context/connections/read-only-sql.js';

describe('assertReadOnlySql', () => {
  it('allows select and with queries', () => {
    expect(assertReadOnlySql('select * from orders')).toBe('select * from orders');
    expect(assertReadOnlySql('with paid as (select * from orders) select * from paid')).toContain('with paid');
  });

  it('rejects mutating statements before opening a database connection', () => {
    expect(() => assertReadOnlySql('delete from orders')).toThrow(
      'Only read-only SELECT/WITH queries can be executed locally',
    );
    expect(() => assertReadOnlySql('create table x(id int)')).toThrow(
      'Only read-only SELECT/WITH queries can be executed locally',
    );
  });

  // A guard refusing the agent's SQL is an expected outcome; classifying it as
  // KtxQueryError keeps reportException from filing it as a ktx fault.
  it('rejects with an expected KtxQueryError, not a bare Error', () => {
    expect(() => assertReadOnlySql('delete from orders')).toThrow(KtxQueryError);
    expect(() => assertReadOnlySql('describe orders')).toThrow(KtxQueryError);
    expect(() => assertReadOnlySql('select 1; drop table orders')).toThrow(KtxQueryError);
    try {
      assertReadOnlySql('describe orders');
      expect.unreachable('expected a throw');
    } catch (error) {
      expect(error).toBeInstanceOf(KtxExpectedError);
    }
  });

  it('accepts read-only queries that begin with leading comments', () => {
    expect(assertReadOnlySql('-- daily widget sales\nselect count(*) from public.widget_sales')).toBe(
      'select count(*) from public.widget_sales',
    );
    expect(assertReadOnlySql('/* block */\n  with paid as (select 1) select * from paid')).toContain('with paid');
  });

  it('still rejects mutating statements hidden behind leading comments', () => {
    expect(() => assertReadOnlySql('-- harmless\n  delete from orders')).toThrow(
      'Only read-only SELECT/WITH queries can be executed locally',
    );
  });

  it('rejects a second statement smuggled after a semicolon', () => {
    expect(() => assertReadOnlySql('select 1; drop table orders')).toThrow(
      'Only one SQL statement can be executed.',
    );
    expect(() => assertReadOnlySql('select 1;\n-- pad\ndelete from orders')).toThrow(
      'Only one SQL statement can be executed.',
    );
    expect(() => assertReadOnlySql('select 1; /* pad */ truncate orders;')).toThrow(
      'Only one SQL statement can be executed.',
    );
  });

  it('accepts trailing semicolons, including repeated ones followed by comments', () => {
    expect(assertReadOnlySql('select 1;')).toBe('select 1;');
    expect(assertReadOnlySql('select 1 ;; \n')).toBe('select 1 ;;');
    expect(assertReadOnlySql('select 1; -- done')).toBe('select 1; -- done');
  });

  it('ignores semicolons inside string literals, quoted identifiers, and comments', () => {
    expect(assertReadOnlySql("select string_agg(name, '; ') from t")).toBe("select string_agg(name, '; ') from t");
    expect(assertReadOnlySql("select 'it''s; quoted' from t")).toBe("select 'it''s; quoted' from t");
    expect(assertReadOnlySql('select ";" from "t;u"')).toBe('select ";" from "t;u"');
    expect(assertReadOnlySql('select 1 -- tail; comment')).toBe('select 1 -- tail; comment');
    expect(assertReadOnlySql('select 1 /* a;b */ + 2')).toBe('select 1 /* a;b */ + 2');
  });

  it('rejects statements smuggled after a string literal that closes a semicolon early', () => {
    expect(() => assertReadOnlySql("select 'a'; delete from orders")).toThrow(
      'Only one SQL statement can be executed.',
    );
  });
});

describe('limitSqlForExecution', () => {
  it('wraps compiled SQL and strips trailing semicolons', () => {
    expect(limitSqlForExecution('select * from public.orders; ', 25)).toBe(
      'select * from (select * from public.orders) as ktx_query_result limit 25',
    );
  });

  it('returns the trimmed SQL when no maxRows value is provided', () => {
    expect(limitSqlForExecution('select * from orders; ', undefined)).toBe('select * from orders');
  });

  it('strips leading comments before wrapping with a row limit', () => {
    expect(limitSqlForExecution('-- top customers\nselect * from public.orders', 25)).toBe(
      'select * from (select * from public.orders) as ktx_query_result limit 25',
    );
  });

  it('drops a trailing semicolon followed by a comment so the subquery stays valid', () => {
    // The single-statement gate accepts `select 1; -- done`; without stripping
    // the terminator the wrapper would embed `select 1; -- done` and comment out
    // the closing paren and limit clause.
    expect(limitSqlForExecution('select 1; -- done', 5)).toBe(
      'select * from (select 1) as ktx_query_result limit 5',
    );
    expect(limitSqlForExecution('select 1; /* note */', 5)).toBe(
      'select * from (select 1) as ktx_query_result limit 5',
    );
  });

  it('drops a trailing line comment with no semicolon before wrapping', () => {
    expect(limitSqlForExecution('select 1 -- done', 5)).toBe('select * from (select 1) as ktx_query_result limit 5');
  });
});

describe('stripTrailingSqlNoise', () => {
  it('removes trailing semicolons, comments, and whitespace', () => {
    expect(stripTrailingSqlNoise('select 1;')).toBe('select 1');
    expect(stripTrailingSqlNoise('select 1 ;; ')).toBe('select 1');
    expect(stripTrailingSqlNoise('select 1; -- done')).toBe('select 1');
    expect(stripTrailingSqlNoise('select 1 -- done')).toBe('select 1');
    expect(stripTrailingSqlNoise('select 1; /* trailing */')).toBe('select 1');
  });

  it('preserves semicolons and comment markers inside literals and mid-statement', () => {
    expect(stripTrailingSqlNoise("select 'a; -- b'")).toBe("select 'a; -- b'");
    expect(stripTrailingSqlNoise('select 1 /* a;b */ + 2')).toBe('select 1 /* a;b */ + 2');
    expect(stripTrailingSqlNoise('select ";" from "t;u"')).toBe('select ";" from "t;u"');
  });
});
