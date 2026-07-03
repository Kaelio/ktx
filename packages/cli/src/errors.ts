/**
 * Marks an error as an expected operational outcome that ktx surfaces to its
 * caller (a connected agent or the CLI user) rather than an unexpected ktx
 * fault. Examples: invalid agent input, a warehouse rejecting a query, or a
 * validation guard rejecting a request.
 *
 * `reportException` skips PostHog Error Tracking for these so the bug stream
 * stays free of routine, caller-driven failures. The failure is still surfaced
 * to the caller (as a tool-error result or CLI error) and still recorded by the
 * outcome-tagged telemetry events, so no diagnostic signal is lost.
 */
export class KtxExpectedError extends Error {
  constructor(message: string, options?: ErrorOptions) {
    super(message, options);
    this.name = 'KtxExpectedError';
  }
}

/**
 * A query was rejected at the warehouse/driver boundary — the warehouse refused
 * to compile or run it, or a read-only guard rejected it. Reuses the underlying
 * error's message so the caller still sees the original warehouse diagnostics,
 * and keeps the driver error as `cause`.
 */
export class KtxQueryError extends KtxExpectedError {
  constructor(message: string, options?: ErrorOptions) {
    super(message, options);
    this.name = 'KtxQueryError';
  }
}

/**
 * True for the native JavaScript error types that signal a programming fault — a
 * bug in ktx code rather than an operational outcome. These are universal
 * language invariants (a `TypeError` never means "the warehouse rejected the
 * query"), so callers can use this to keep genuine faults out of the
 * expected-error classification and let them reach Error Tracking unchanged.
 */
export function isNativeProgrammingFault(error: unknown): boolean {
  return (
    error instanceof TypeError ||
    error instanceof RangeError ||
    error instanceof ReferenceError ||
    error instanceof SyntaxError ||
    error instanceof EvalError ||
    error instanceof URIError
  );
}

/**
 * Reclassifies a caught boundary rejection as an expected error and rethrows. A native
 * JS fault (TypeError, etc.) or an already-expected error is rethrown unchanged so Error
 * Tracking still sees genuine ktx bugs; anything else — the warehouse or daemon refusing
 * the query — is wrapped in `ErrorClass` (default KtxQueryError), preserving the original
 * message and keeping the cause, so `reportException` keeps it out of Error Tracking.
 */
export function markExpected(
  error: unknown,
  ErrorClass: new (message: string, options?: ErrorOptions) => KtxExpectedError = KtxQueryError,
): never {
  if (isNativeProgrammingFault(error) || error instanceof KtxExpectedError) {
    throw error;
  }
  throw new ErrorClass(error instanceof Error ? error.message : String(error), { cause: error });
}
