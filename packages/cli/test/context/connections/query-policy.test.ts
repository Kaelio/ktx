import { describe, expect, it } from 'vitest';
import {
  assertRawSqlAllowed,
  connectionQueryPolicy,
  projectAllowsRawSql,
  restrictedFederatedMemberIds,
} from '../../../src/context/connections/query-policy.js';
import { parseKtxProjectConfig } from '../../../src/context/project/config.js';
import { KtxQueryError } from '../../../src/errors.js';

const PROJECT_DIR = '/tmp/proj';

function config(yaml: string) {
  return parseKtxProjectConfig(yaml);
}

describe('connectionQueryPolicy', () => {
  it('defaults to read-only-sql when the field is absent or the connection is unknown', () => {
    const parsed = config(`
connections:
  warehouse:
    driver: sqlite
    url: file:warehouse.db
`);
    expect(connectionQueryPolicy(parsed.connections.warehouse)).toBe('read-only-sql');
    expect(connectionQueryPolicy(undefined)).toBe('read-only-sql');
  });

  it('reads semantic-layer-only from ktx.yaml', () => {
    const parsed = config(`
connections:
  warehouse:
    driver: snowflake
    url: env:SNOWFLAKE_URL
    query_policy: semantic-layer-only
`);
    expect(connectionQueryPolicy(parsed.connections.warehouse)).toBe('semantic-layer-only');
  });

  it('rejects unknown query_policy values at config parse time', () => {
    expect(() =>
      config(`
connections:
  warehouse:
    driver: sqlite
    url: file:warehouse.db
    query_policy: everything-goes
`),
    ).toThrow();
  });
});

describe('assertRawSqlAllowed', () => {
  it('allows raw SQL on an unrestricted connection', () => {
    const parsed = config(`
connections:
  warehouse:
    driver: sqlite
    url: file:warehouse.db
`);
    expect(() => assertRawSqlAllowed(parsed, PROJECT_DIR, 'warehouse')).not.toThrow();
  });

  it('rejects raw SQL on a restricted connection with an expected error naming the policy', () => {
    const parsed = config(`
connections:
  warehouse:
    driver: sqlite
    url: file:warehouse.db
    query_policy: semantic-layer-only
`);
    expect(() => assertRawSqlAllowed(parsed, PROJECT_DIR, 'warehouse')).toThrow(KtxQueryError);
    expect(() => assertRawSqlAllowed(parsed, PROJECT_DIR, 'warehouse')).toThrow(
      /query_policy: semantic-layer-only/,
    );
  });

  it('rejects federated raw SQL when any member connection is restricted', () => {
    const parsed = config(`
connections:
  sales:
    driver: sqlite
    url: file:sales.db
    query_policy: semantic-layer-only
  events:
    driver: sqlite
    url: file:events.db
`);
    expect(restrictedFederatedMemberIds(parsed, PROJECT_DIR)).toEqual(['sales']);
    expect(() => assertRawSqlAllowed(parsed, PROJECT_DIR, '_ktx_federated')).toThrow(/"sales"/);
  });

  it('allows federated raw SQL when no member is restricted', () => {
    const parsed = config(`
connections:
  sales:
    driver: sqlite
    url: file:sales.db
  events:
    driver: sqlite
    url: file:events.db
`);
    expect(restrictedFederatedMemberIds(parsed, PROJECT_DIR)).toEqual([]);
    expect(() => assertRawSqlAllowed(parsed, PROJECT_DIR, '_ktx_federated')).not.toThrow();
  });
});

describe('projectAllowsRawSql', () => {
  it('is true when at least one SQL connection is unrestricted', () => {
    const parsed = config(`
connections:
  finance:
    driver: postgres
    url: env:FINANCE_URL
    query_policy: semantic-layer-only
  warehouse:
    driver: sqlite
    url: file:warehouse.db
`);
    expect(projectAllowsRawSql(parsed)).toBe(true);
  });

  it('is false when every SQL connection is restricted', () => {
    const parsed = config(`
connections:
  finance:
    driver: postgres
    url: env:FINANCE_URL
    query_policy: semantic-layer-only
`);
    expect(projectAllowsRawSql(parsed)).toBe(false);
  });

  it('is true for projects with no SQL-queryable connections', () => {
    const parsed = config(`
connections:
  docs:
    driver: mongodb
    url: mongodb://localhost:27017/app
`);
    expect(projectAllowsRawSql(parsed)).toBe(true);
    expect(projectAllowsRawSql(config('connections: {}'))).toBe(true);
  });
});
