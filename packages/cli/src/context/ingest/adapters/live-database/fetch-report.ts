import { readFile } from 'node:fs/promises';
import { join } from 'node:path';
import type { SourceFetchReport } from '../../types.js';
import { LIVE_DATABASE_WARNINGS_FILE } from './stage.js';

const OBJECT_SKIP_CODE = 'object_introspection_failed';

interface RawWarning {
  code?: unknown;
  message?: unknown;
  table?: unknown;
}

/**
 * Derives the fetch report from the staged `warnings.json`: objects that failed
 * introspection become `skipped` entries so the run report, ingest summary, and
 * `ktx status` can surface them. Returns null when nothing was skipped, keeping
 * clean ingests free of an empty report.
 */
export async function readLiveDatabaseFetchReport(stagedDir: string): Promise<SourceFetchReport | null> {
  let parsed: unknown;
  try {
    parsed = JSON.parse(await readFile(join(stagedDir, LIVE_DATABASE_WARNINGS_FILE), 'utf8'));
  } catch {
    return null;
  }
  const warnings =
    parsed && typeof parsed === 'object' && Array.isArray((parsed as { warnings?: unknown }).warnings)
      ? ((parsed as { warnings: RawWarning[] }).warnings)
      : [];

  const skipped = warnings
    .filter((warning) => warning.code === OBJECT_SKIP_CODE)
    .map((warning) => ({
      rawPath: '',
      entityType: 'database_object',
      entityId: typeof warning.table === 'string' ? warning.table : null,
      severity: 'warning' as const,
      statusCode: null,
      message: typeof warning.message === 'string' ? warning.message : 'introspection failed',
      retryRecommended: false,
    }));

  if (skipped.length === 0) {
    return null;
  }
  return { status: 'partial', retryRecommended: false, skipped, warnings: [] };
}
