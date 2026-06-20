const MIN_SAFE_BIGINT = BigInt(Number.MIN_SAFE_INTEGER);
const MAX_SAFE_BIGINT = BigInt(Number.MAX_SAFE_INTEGER);

// DuckDB returns integer columns as JS bigint (unserializable by JSON). Values
// in Number's safe range become Number; larger magnitudes become strings so a
// BIGINT beyond 2^53 keeps its exact value instead of silently rounding.
/** @internal */
export function jsonSafeBigint(value: bigint): number | string {
  return value >= MIN_SAFE_BIGINT && value <= MAX_SAFE_BIGINT ? Number(value) : value.toString();
}

export function toJsonSafeRows(rows: unknown[][]): unknown[][] {
  return rows.map((row) => row.map((cell) => (typeof cell === 'bigint' ? jsonSafeBigint(cell) : cell)));
}
