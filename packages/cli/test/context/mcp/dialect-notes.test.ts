import { readdirSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { KtxExpectedError } from '../../../src/errors.js';
import { KTX_DATABASE_DRIVER_IDS } from '../../../src/connection-drivers.js';
import type { KtxProjectConnectionConfig } from '../../../src/context/project/config.js';
import { sqlAnalysisDialectForDriver } from '../../../src/context/sql-analysis/dialect.js';
import { DIALECTS_WITH_NOTES, sqlDialectNotes } from '../../../src/context/sql-analysis/dialect-notes.js';
import { resolveDialectNotesForConnection } from '../../../src/context/mcp/local-project-ports.js';

function conn(driver: string): KtxProjectConnectionConfig {
  return { driver } as KtxProjectConnectionConfig;
}

describe('per-dialect SQL notes', () => {
  it('covers every dialect reachable from a configured warehouse driver', () => {
    // Derived from the connector registry, not a hand-maintained list: a new
    // warehouse driver whose resolved dialect lacks authored notes fails here.
    for (const driver of KTX_DATABASE_DRIVER_IDS) {
      const dialect = sqlAnalysisDialectForDriver(driver);
      expect(DIALECTS_WITH_NOTES, `driver "${driver}" resolves to dialect "${dialect}"`).toContain(dialect);
      expect(sqlDialectNotes(dialect).length).toBeGreaterThan(0);
    }
  });

  it('keeps the authored-dialect list and the ./dialects markdown files in sync', () => {
    const dir = fileURLToPath(new URL('../../../src/context/sql-analysis/dialects/', import.meta.url));
    const files = readdirSync(dir)
      .filter((name) => name.endsWith('.md'))
      .map((name) => name.replace(/\.md$/, ''))
      .sort();
    expect(files).toEqual([...DIALECTS_WITH_NOTES].sort());
  });

  it('authors notes for every first-class warehouse dialect', () => {
    expect(DIALECTS_WITH_NOTES).toContain('duckdb');
    expect(DIALECTS_WITH_NOTES).toContain('databricks');
    expect(DIALECTS_WITH_NOTES).toContain('athena');
  });

  it('answers the full rubric for every dialect', () => {
    for (const dialect of DIALECTS_WITH_NOTES) {
      const notes = sqlDialectNotes(dialect);
      expect(notes, `${dialect}: FQTN`).toContain('**FQTN:**');
      expect(notes, `${dialect}: identifiers`).toContain('**Identifiers:**');
      expect(notes, `${dialect}: date/time`).toContain('**Date/time:**');
      expect(notes, `${dialect}: top-N`).toMatch(/\*\*Top-N/);
      expect(notes, `${dialect}: series`).toMatch(/\*\*Series/);
      expect(notes, `${dialect}: rolling window`).toMatch(/\*\*Rolling/);
      expect(notes, `${dialect}: safe cast`).toMatch(/\*\*Safe cast/);
      expect(notes, `${dialect}: semi-structured`).toMatch(/\*\*(JSON|Semi-structured)/);
    }
  });

  it('gives each engine its own idioms and never leaks another engine-only construct', () => {
    // A sqlite analyst gets sqlite date idioms and never Snowflake/BigQuery-only syntax.
    expect(sqlDialectNotes('sqlite')).toMatch(/strftime|julianday/);
    expect(sqlDialectNotes('sqlite')).not.toContain('VARIANT');
    expect(sqlDialectNotes('sqlite')).not.toContain('_TABLE_SUFFIX');

    // QUALIFY appears only for the engines that actually support it.
    expect(sqlDialectNotes('snowflake')).toContain('QUALIFY');
    expect(sqlDialectNotes('bigquery')).toContain('QUALIFY');
    for (const dialect of ['postgres', 'mysql', 'sqlite', 'clickhouse', 'tsql'] as const) {
      expect(sqlDialectNotes(dialect), `${dialect} must not mention QUALIFY`).not.toContain('QUALIFY');
    }

    // Engine-exclusive markers stay in their own dialect.
    expect(sqlDialectNotes('snowflake')).toContain('VARIANT');
    expect(sqlDialectNotes('snowflake')).toContain('DATABASE.SCHEMA.TABLE');
    expect(sqlDialectNotes('bigquery')).toContain('_TABLE_SUFFIX');
    expect(sqlDialectNotes('clickhouse')).toContain('LIMIT n BY');
    expect(sqlDialectNotes('tsql')).toContain('TOP (n)');
  });

  it('contains no benchmark/grader or version-dated content', () => {
    for (const dialect of DIALECTS_WITH_NOTES) {
      const notes = sqlDialectNotes(dialect);
      expect(notes).not.toMatch(/\bspider\b|\bbenchmark\b|\bgold\b|\bgrader\b/i);
      expect(notes).not.toMatch(/\bas of v(ersion)?\b/i);
    }
  });

  it('falls back to postgres notes for a dialect without its own file', () => {
    expect(sqlAnalysisDialectForDriver('some-future-engine')).toBe('postgres');
    // redshift is a valid SqlAnalysisDialect but intentionally unauthored.
    expect(sqlDialectNotes('redshift')).toBe(sqlDialectNotes('postgres'));
  });
});

describe('resolveDialectNotesForConnection', () => {
  it('resolves a warehouse connection to its dialect notes', () => {
    expect(resolveDialectNotesForConnection('wh', conn('sqlite'))).toMatchObject({
      connectionId: 'wh',
      dialect: 'sqlite',
    });
    expect(resolveDialectNotesForConnection('wh', conn('snowflake')).dialect).toBe('snowflake');
    // The sqlserver driver resolves to the tsql dialect (resolver codomain).
    expect(resolveDialectNotesForConnection('wh', conn('sqlserver')).dialect).toBe('tsql');
  });

  it('rejects a non-SQL context source with a clear expected error, not postgres notes', () => {
    expect(() => resolveDialectNotesForConnection('mb', conn('metabase'))).toThrow(KtxExpectedError);
    expect(() => resolveDialectNotesForConnection('mb', conn('metabase'))).toThrow(/not a SQL warehouse/);
  });

  it('rejects an unconfigured connection', () => {
    expect(() => resolveDialectNotesForConnection('missing', undefined)).toThrow(KtxExpectedError);
    expect(() => resolveDialectNotesForConnection('missing', undefined)).toThrow(/not configured/);
  });
});
