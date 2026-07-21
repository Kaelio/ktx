import { describe, expect, it } from 'vitest';
import { connectionTypeSchema } from '../../../src/context/connections/connection-type.js';
import {
  dialectForConnectionType,
  warehouseTargetDialect,
} from '../../../src/context/connections/connection-type-dialect.js';

describe('connection type dialect resolution', () => {
  it('maps warehouse connection types to sqlglot dialects', () => {
    const cases: Array<[string, string]> = [
      ['POSTGRESQL', 'postgres'],
      ['SQLITE', 'sqlite'],
      ['DUCKDB', 'duckdb'],
      ['SQLSERVER', 'tsql'],
      ['BIGQUERY', 'bigquery'],
      ['SNOWFLAKE', 'snowflake'],
      ['DATABRICKS', 'databricks'],
      ['MYSQL', 'mysql'],
      ['CLICKHOUSE', 'clickhouse'],
      ['ATHENA', 'athena'],
    ];

    for (const [connectionType, dialect] of cases) {
      expect(dialectForConnectionType(connectionType)).toBe(dialect);
      expect(warehouseTargetDialect(connectionType)).toBe(dialect);
    }
  });

  it('normalizes case and preserves the semantic-layer postgres fallback for unknown inputs', () => {
    expect(dialectForConnectionType('athena')).toBe('athena');
    expect(dialectForConnectionType('postgresql')).toBe('postgres');
    expect(dialectForConnectionType('not-a-real-connection-type')).toBe('postgres');
  });

  it('rejects non-SQL targets for BI table parsing', () => {
    expect(warehouseTargetDialect('METABASE')).toBeNull();
    expect(warehouseTargetDialect('LOOKER')).toBeNull();
    expect(warehouseTargetDialect('NOTION')).toBeNull();
    expect(warehouseTargetDialect('not-a-real-connection-type')).toBeNull();
  });

  it('removes inherited non-ktx connection type values while keeping ktx warehouse types', () => {
    expect(connectionTypeSchema.safeParse('ATHENA').success).toBe(true);
    expect(connectionTypeSchema.safeParse('DATABRICKS').success).toBe(true);

    for (const removed of [
      'CENTRALREACH',
      'EPIC',
      'CERNER',
      'QUICKBOOKS',
      'WORKDAY',
      'REST',
      'S3',
      'SLACK',
      'PLAIN',
      'BETTERSTACK',
    ]) {
      expect(connectionTypeSchema.safeParse(removed).success).toBe(false);
    }
  });
});
