import { DuckDBInstance } from '@duckdb/node-api';
import { federatedAttachTarget } from './federated-attach.js';
import type {
  KtxSqlQueryExecutionInput,
  KtxSqlQueryExecutionResult,
} from '../../context/connections/query-executor.js';
import { normalizeQueryRows } from '../../context/connections/query-executor.js';
import { assertReadOnlySql, limitSqlForExecution } from '../../context/connections/read-only-sql.js';
import { attachTypeForDriver, type FederatedMember } from '../../context/connections/federation.js';

function quoteDuckdbIdentifier(id: string): string {
  return `"${id.replaceAll('"', '""')}"`;
}

const MIN_SAFE_BIGINT = BigInt(Number.MIN_SAFE_INTEGER);
const MAX_SAFE_BIGINT = BigInt(Number.MAX_SAFE_INTEGER);

// DuckDB returns integer columns as JS bigint (unserializable by JSON). Values
// in Number's safe range become Number; larger magnitudes become strings so a
// BIGINT beyond 2^53 keeps its exact value instead of silently rounding.
function jsonSafeBigint(value: bigint): number | string {
  return value >= MIN_SAFE_BIGINT && value <= MAX_SAFE_BIGINT ? Number(value) : value.toString();
}

function toJsonSafeRows(rows: unknown[][]): unknown[][] {
  return rows.map((row) => row.map((cell) => (typeof cell === 'bigint' ? jsonSafeBigint(cell) : cell)));
}

/** @internal */
export function buildAttachStatements(members: FederatedMember[], env: NodeJS.ProcessEnv): string[] {
  const attachments = members.map((member) => ({
    type: attachTypeForDriver(member.driver),
    url: federatedAttachTarget(member, env),
    alias: member.connectionId,
  }));

  const loadStatements = [...new Set(attachments.map((a) => a.type))].map(
    (type) => `INSTALL ${type}; LOAD ${type};`,
  );
  const attachStatements = attachments.map(
    ({ type, url, alias }) =>
      `ATTACH '${url.replaceAll("'", "''")}' AS ${quoteDuckdbIdentifier(alias)} (TYPE ${type}, READ_ONLY);`,
  );
  return [...loadStatements, ...attachStatements];
}

export async function executeFederatedQuery(
  members: FederatedMember[],
  input: KtxSqlQueryExecutionInput,
  env: NodeJS.ProcessEnv = process.env,
): Promise<KtxSqlQueryExecutionResult> {
  const sql = limitSqlForExecution(assertReadOnlySql(input.sql), input.maxRows);
  const attachStatements = buildAttachStatements(members, env);

  const instance = await DuckDBInstance.create(':memory:');
  try {
    const connection = await instance.connect();
    try {
      for (const statement of attachStatements) {
        await connection.run(statement);
      }
      const reader = await connection.runAndReadAll(sql);
      const rows = toJsonSafeRows(normalizeQueryRows(reader.getRows()));
      const headers = reader.columnNames();
      return {
        headers,
        rows,
        totalRows: rows.length,
        command: 'SELECT',
        rowCount: rows.length,
      };
    } finally {
      connection.closeSync();
    }
  } finally {
    instance.closeSync();
  }
}
