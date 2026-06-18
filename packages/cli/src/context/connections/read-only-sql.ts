import { KtxQueryError } from '../../errors.js';

const MUTATING_SQL =
  /^\s*(insert|update|delete|merge|alter|drop|create|truncate|grant|revoke|copy|call|do|vacuum|analyze|refresh)\b/i;
const READ_SQL = /^\s*(select|with)\b/i;

// Agents (and the daemon's sqlglot validator, which ignores comments) routinely
// emit read-only queries prefixed with `-- ...` or `/* ... */`. Strip leading
// comments so the prefix check sees the real statement; otherwise valid SELECT/WITH
// SQL is rejected here while the parser-backed validator accepts it.
function stripLeadingSqlComments(sql: string): string {
  let index = 0;
  while (index < sql.length) {
    while (/\s/.test(sql[index] ?? '')) {
      index += 1;
    }
    if (sql.startsWith('--', index)) {
      const end = sql.indexOf('\n', index + 2);
      index = end === -1 ? sql.length : end + 1;
      continue;
    }
    if (sql.startsWith('/*', index)) {
      const end = sql.indexOf('*/', index + 2);
      if (end === -1) {
        return sql.slice(index);
      }
      index = end + 2;
      continue;
    }
    break;
  }
  return sql.slice(index);
}

// Lexes past one string literal, quoted identifier, or comment starting at
// `index`, using standard-SQL rules ('' and "" escapes; no dialect extensions
// such as backslash escapes or dollar quoting). Returns the index after the
// token, or `index` unchanged when no quoted/comment token starts there.
function skipQuotedOrComment(sql: string, index: number): number {
  const quote = sql[index];
  if (quote === "'" || quote === '"') {
    let i = index + 1;
    while (i < sql.length) {
      if (sql[i] === quote) {
        if (sql[i + 1] === quote) {
          i += 2;
          continue;
        }
        return i + 1;
      }
      i += 1;
    }
    return sql.length;
  }
  if (sql.startsWith('--', index)) {
    const end = sql.indexOf('\n', index + 2);
    return end === -1 ? sql.length : end + 1;
  }
  if (sql.startsWith('/*', index)) {
    const end = sql.indexOf('*/', index + 2);
    return end === -1 ? sql.length : end + 2;
  }
  return index;
}

// Backstop against statement smuggling (`select 1; drop table x`): reject any
// semicolon that is followed by real content. Semicolons inside string
// literals, quoted identifiers, and comments are fine, as are trailing
// semicolons (optionally followed by whitespace and comments). This deliberately
// lexes standard SQL only, so dialect-specific escapes can cause a false
// reject — never a false accept; the canonical gate is the daemon's
// sqlglot-backed validateReadOnly.
function assertSingleSqlStatement(sql: string): void {
  let index = 0;
  let sawSemicolon = false;
  while (index < sql.length) {
    const skipped = skipQuotedOrComment(sql, index);
    if (skipped > index) {
      index = skipped;
      continue;
    }
    if (sql[index] === ';') {
      sawSemicolon = true;
    } else if (sawSemicolon && !/\s/.test(sql[index])) {
      throw new KtxQueryError('Only one SQL statement can be executed.');
    }
    index += 1;
  }
}

export function assertReadOnlySql(sql: string): string {
  const trimmed = stripLeadingSqlComments(sql).trim();
  if (!READ_SQL.test(trimmed) || MUTATING_SQL.test(trimmed)) {
    throw new KtxQueryError('Only read-only SELECT/WITH queries can be executed locally.');
  }
  assertSingleSqlStatement(trimmed);
  return trimmed;
}

// `assertReadOnlySql` deliberately keeps trailing semicolons, comments, and
// whitespace (e.g. `select 1; -- done`) — harmless for direct single-statement
// execution. A row-limit subquery wrapper needs a bare expression instead: a
// trailing `;` would sit illegally inside the subquery, and a trailing line
// comment would comment out the closing paren and limit clause. Lex forward with
// the same standard-SQL rules as the single-statement gate and truncate at the
// end of the last meaningful token, dropping trailing semicolons, comments, and
// whitespace. Characters inside string literals and quoted identifiers stay
// meaningful, so a `;` or `--` within a literal is never mistaken for a
// terminator (a plain regex cannot make that distinction).
export function stripTrailingSqlNoise(sql: string): string {
  let index = 0;
  let meaningfulEnd = 0;
  while (index < sql.length) {
    if (sql.startsWith('--', index) || sql.startsWith('/*', index)) {
      index = skipQuotedOrComment(sql, index);
      continue;
    }
    const afterQuoted = skipQuotedOrComment(sql, index);
    if (afterQuoted > index) {
      meaningfulEnd = afterQuoted;
      index = afterQuoted;
      continue;
    }
    if (sql[index] !== ';' && !/\s/.test(sql[index] ?? '')) {
      meaningfulEnd = index + 1;
    }
    index += 1;
  }
  return sql.slice(0, meaningfulEnd);
}

export function limitSqlForExecution(sql: string, maxRows: number | undefined): string {
  const trimmed = stripTrailingSqlNoise(assertReadOnlySql(sql));
  if (!maxRows) {
    return trimmed;
  }
  if (!Number.isInteger(maxRows) || maxRows <= 0) {
    throw new KtxQueryError('maxRows must be a positive integer.');
  }
  return `select * from (${trimmed}) as ktx_query_result limit ${maxRows}`;
}
