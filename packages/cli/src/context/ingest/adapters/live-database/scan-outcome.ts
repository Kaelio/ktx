import { KtxExpectedError } from '../../../../errors.js';
import { tableRefFromKey, type KtxTableRefKey } from '../../../scan/table-ref.js';
import type { KtxSchemaSnapshot } from '../../../scan/types.js';

const OBJECT_SKIP_CODE = 'object_introspection_failed';

function formatScopeEntry(key: KtxTableRefKey): string {
  const ref = tableRefFromKey(key);
  return [ref.catalog, ref.db, ref.name].filter((part): part is string => Boolean(part)).join('.');
}

function discoveredObjectNames(snapshot: KtxSchemaSnapshot): string[] {
  const raw = (snapshot.metadata as Record<string, unknown>).discovered_object_names;
  return Array.isArray(raw) ? raw.filter((value): value is string => typeof value === 'string') : [];
}

/**
 * Enforces the partial-vs-total outcome rules for a live-database snapshot,
 * uniformly for every connector. Outcomes follow from object counts, not a
 * mode: a connection with at least one ingested object succeeds (any broken
 * objects ride along as warnings); a connection where every introspected object
 * failed, or a non-empty enabled_tables scope that matched nothing, raises a
 * clear connection error instead of staging an empty layer that would later
 * surface as the generic "did not recognize" message. A legitimately empty
 * database (no scope, no objects) succeeds with an empty layer.
 */
export function assertLiveDatabaseScanOutcome(input: {
  connectionId: string;
  scope: ReadonlySet<KtxTableRefKey> | undefined;
  snapshot: KtxSchemaSnapshot;
}): void {
  const { connectionId, scope, snapshot } = input;
  if (snapshot.tables.length > 0) {
    return;
  }

  const skipped = (snapshot.warnings ?? []).filter((warning) => warning.code === OBJECT_SKIP_CODE);
  if (skipped.length > 0) {
    const detail = skipped.map((warning) => `${warning.table ?? 'object'}: ${warning.message}`).join('; ');
    throw new KtxExpectedError(
      `Connection "${connectionId}" produced no semantic layer: all ${skipped.length} introspected ` +
        `${skipped.length === 1 ? 'object' : 'objects'} failed (${detail}).`,
    );
  }

  if (scope && scope.size > 0) {
    const requested = [...scope].map(formatScopeEntry).sort();
    const available = discoveredObjectNames(snapshot);
    const availableClause = available.length > 0 ? ` Available objects: ${available.join(', ')}.` : '';
    throw new KtxExpectedError(
      `enabled_tables for connection "${connectionId}" matched no objects ` +
        `(looked for: ${requested.join(', ')}).${availableClause}`,
    );
  }
}
