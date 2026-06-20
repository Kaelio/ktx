import { DuckDBInstance } from '@duckdb/node-api';
import { federatedAttachTarget } from './federated-attach.js';
import type {
  KtxSqlQueryExecutionInput,
  KtxSqlQueryExecutionResult,
} from '../../context/connections/query-executor.js';
import { normalizeQueryRows } from '../../context/connections/query-executor.js';
import { assertReadOnlySql, limitSqlForExecution } from '../../context/connections/read-only-sql.js';
import { attachTypeForDriver, type FederatedMember } from '../../context/connections/federation.js';
import { toJsonSafeRows } from '../shared/duckdb-json-safe.js';

function quoteDuckdbIdentifier(id: string): string {
  return `"${id.replaceAll('"', '""')}"`;
}

/** @internal */
export function buildAttachStatements(members: FederatedMember[], env: NodeJS.ProcessEnv): string[] {
  const attachments = members.map((member) => ({
    type: attachTypeForDriver(member.driver),
    url: federatedAttachTarget(member, env),
    alias: member.connectionId,
  }));

  const loadTypes = [...new Set(attachments.map((a) => a.type).filter((type): type is string => type !== null))];
  const loadStatements = loadTypes.map((type) => `INSTALL ${type}; LOAD ${type};`);
  const attachStatements = attachments.map(({ type, url, alias }) => {
    const options = type === null ? 'READ_ONLY' : `TYPE ${type}, READ_ONLY`;
    return `ATTACH '${url.replaceAll("'", "''")}' AS ${quoteDuckdbIdentifier(alias)} (${options});`;
  });
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
