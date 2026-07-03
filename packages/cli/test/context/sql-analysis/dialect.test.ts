import { describe, expect, it } from 'vitest';
import { sqlAnalysisDialectForDriver } from '../../../src/context/sql-analysis/dialect.js';

describe('sqlAnalysisDialectForDriver', () => {
  it('maps ktx.yaml driver names to sqlglot dialects', () => {
    expect(sqlAnalysisDialectForDriver('postgres')).toBe('postgres');
    expect(sqlAnalysisDialectForDriver('bigquery')).toBe('bigquery');
    expect(sqlAnalysisDialectForDriver('snowflake')).toBe('snowflake');
    expect(sqlAnalysisDialectForDriver('mysql')).toBe('mysql');
    expect(sqlAnalysisDialectForDriver('sqlserver')).toBe('tsql');
    expect(sqlAnalysisDialectForDriver('sqlite')).toBe('sqlite');
    expect(sqlAnalysisDialectForDriver('duckdb')).toBe('duckdb');
    expect(sqlAnalysisDialectForDriver('clickhouse')).toBe('clickhouse');
    expect(sqlAnalysisDialectForDriver('databricks')).toBe('databricks');
    expect(sqlAnalysisDialectForDriver('athena')).toBe('athena');
  });

  it('maps local connection-type spellings to sqlglot dialects', () => {
    expect(sqlAnalysisDialectForDriver('POSTGRESQL')).toBe('postgres');
    expect(sqlAnalysisDialectForDriver('SQLSERVER')).toBe('tsql');
    expect(sqlAnalysisDialectForDriver('BIGQUERY')).toBe('bigquery');
    expect(sqlAnalysisDialectForDriver('SQLITE')).toBe('sqlite');
  });

  it('defaults to postgres for unknown or missing drivers', () => {
    expect(sqlAnalysisDialectForDriver(undefined)).toBe('postgres');
    expect(sqlAnalysisDialectForDriver('')).toBe('postgres');
    expect(sqlAnalysisDialectForDriver('unknown')).toBe('postgres');
  });
});
