import { isNativeProgrammingFault } from '../../errors.js';
import type { KtxScanWarning } from './types.js';

export interface IntrospectObjectContext {
  /** Bare object name (table or view). */
  object: string;
  catalog?: string | null;
  db?: string | null;
}

export type IntrospectObjectOutcome<T> = { ok: true; table: T } | { ok: false; warning: KtxScanWarning };

function objectLabel(ctx: IntrospectObjectContext): string {
  return [ctx.catalog, ctx.db, ctx.object].filter((part): part is string => Boolean(part)).join('.');
}

function objectIntrospectionWarning(ctx: IntrospectObjectContext, error: unknown): KtxScanWarning {
  const reason = error instanceof Error ? error.message : String(error);
  return {
    code: 'object_introspection_failed',
    message: reason,
    table: ctx.object,
    recoverable: true,
    metadata: {
      object: objectLabel(ctx),
      ...(ctx.db ? { db: ctx.db } : {}),
      ...(ctx.catalog ? { catalog: ctx.catalog } : {}),
    },
  };
}

/**
 * Runs a single-object metadata/profiling read and isolates its failure: a
 * broken or inaccessible object becomes a recoverable warning instead of
 * aborting the whole scan. Native programming faults (a ktx bug, not a broken
 * object) still propagate so they are not masked as object skips.
 */
export async function tryIntrospectObject<T>(
  ctx: IntrospectObjectContext,
  fn: () => T | Promise<T>,
): Promise<IntrospectObjectOutcome<T>> {
  try {
    return { ok: true, table: await fn() };
  } catch (error) {
    if (isNativeProgrammingFault(error)) {
      throw error;
    }
    return { ok: false, warning: objectIntrospectionWarning(ctx, error) };
  }
}
