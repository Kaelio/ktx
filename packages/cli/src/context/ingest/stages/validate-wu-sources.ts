import { findMissingJoinTargets, formatMissingJoinTarget } from '../../../context/sl/semantic-layer.service.js';
import type { SlValidationDeps } from '../../../context/sl/tools/sl-warehouse-validation.js';
import type { SlValidatorPort } from '../../../context/sl/sl-validator.port.js';
import type { TouchedSlSource } from '../../../context/tools/touched-sl-sources.js';

export interface InvalidWuSource {
  /** `${connectionId}:${sourceName}` */
  source: string;
  errors: string[];
  issues?: WuValidationIssue[];
}

export interface WuValidationResult {
  validSources: string[];
  invalidSources: InvalidWuSource[];
}

type WuValidationIssue =
  | { kind: 'source_validation'; message: string }
  | { kind: 'missing_join_target'; targetSourceName: string; caseMismatch: string | null; message: string };

export function formatInvalidWuSources(invalid: InvalidWuSource[]): string {
  return invalid.map((entry) => `${entry.source} (${entry.errors.join('; ')})`).join(', ');
}

export function hasBlockingWuSourceIssue(source: InvalidWuSource): boolean {
  const issues =
    source.issues ??
    source.errors.map((message) => ({
      kind: 'source_validation' as const,
      message,
    }));
  return issues.some((issue) => issue.kind === 'source_validation');
}

type LoadedSource = Awaited<ReturnType<SlValidationDeps['semanticLayerService']['loadAllSources']>>['sources'][number];

function uniqueTouchedSources(sources: TouchedSlSource[]): TouchedSlSource[] {
  const seen = new Set<string>();
  const unique: TouchedSlSource[] = [];
  for (const source of sources) {
    const key = `${source.connectionId}:${source.sourceName}`;
    if (seen.has(key)) {
      continue;
    }
    seen.add(key);
    unique.push(source);
  }
  return unique.sort((left, right) => {
    const byConnection = left.connectionId.localeCompare(right.connectionId);
    return byConnection === 0 ? left.sourceName.localeCompare(right.sourceName) : byConnection;
  });
}

/**
 * Expand the touched set with direct join neighbors that exist: targets the
 * touched sources join to, and existing sources that join to a touched one.
 * Missing targets are not added here — they are reported as join-target
 * errors on the source that declares them, so the failure names the file
 * that must change instead of the phantom neighbor.
 */
function expandWithExistingJoinNeighbors(
  touched: TouchedSlSource[],
  sourcesByConnection: Map<string, LoadedSource[]>,
): TouchedSlSource[] {
  const expanded = [...touched];
  const touchedByConnection = new Map<string, Set<string>>();
  for (const source of touched) {
    const bucket = touchedByConnection.get(source.connectionId) ?? new Set<string>();
    bucket.add(source.sourceName);
    touchedByConnection.set(source.connectionId, bucket);
  }

  for (const [connectionId, sources] of sourcesByConnection) {
    const touchedNames = touchedByConnection.get(connectionId);
    if (!touchedNames || touchedNames.size === 0) {
      continue;
    }
    const existingNames = new Set(sources.map((source) => source.name));
    for (const source of sources) {
      if (touchedNames.has(source.name)) {
        for (const join of source.joins ?? []) {
          if (existingNames.has(join.to)) {
            expanded.push({ connectionId, sourceName: join.to });
          }
        }
      }
      if ((source.joins ?? []).some((join) => touchedNames.has(join.to))) {
        expanded.push({ connectionId, sourceName: source.name });
      }
    }
  }

  return uniqueTouchedSources(expanded);
}

/**
 * Join-target errors attributable to this change set: every join declared by
 * a touched source must resolve, and no source may be left joining to a name
 * this change set removed. Pre-existing dangling joins on untouched sources
 * are out of scope — they must not block unrelated work. Resolution is the
 * Python engine's: exact source-name match within the connection.
 */
function findJoinTargetIssues(
  touched: TouchedSlSource[],
  sourcesByConnection: Map<string, LoadedSource[]>,
): Map<string, WuValidationIssue[]> {
  const issuesBySource = new Map<string, WuValidationIssue[]>();
  const touchedByConnection = new Map<string, Set<string>>();
  for (const source of touched) {
    const bucket = touchedByConnection.get(source.connectionId) ?? new Set<string>();
    bucket.add(source.sourceName);
    touchedByConnection.set(source.connectionId, bucket);
  }

  for (const [connectionId, sources] of sourcesByConnection) {
    const touchedNames = touchedByConnection.get(connectionId);
    if (!touchedNames || touchedNames.size === 0) {
      continue;
    }
    const existingNames = sources.map((source) => source.name);
    for (const source of sources) {
      const sourceIsTouched = touchedNames.has(source.name);
      const candidateJoins = sourceIsTouched
        ? source.joins
        : (source.joins ?? []).filter((join) => touchedNames.has(join.to));
      const missing = findMissingJoinTargets(candidateJoins, existingNames);
      if (missing.length === 0) {
        continue;
      }
      const key = `${connectionId}:${source.name}`;
      const issues = missing.map((entry) => ({
        kind: 'missing_join_target' as const,
        targetSourceName: entry.to,
        caseMismatch: entry.caseMismatch,
        message: formatMissingJoinTarget(entry),
      }));
      issuesBySource.set(key, [...(issuesBySource.get(key) ?? []), ...issues]);
    }
  }
  return issuesBySource;
}

export async function validateWuTouchedSources(
  deps: SlValidationDeps & { slValidator: SlValidatorPort<SlValidationDeps> },
  touched: TouchedSlSource[],
): Promise<WuValidationResult> {
  if (touched.length === 0) {
    return { validSources: [], invalidSources: [] };
  }

  const sourcesByConnection = new Map<string, LoadedSource[]>();
  for (const connectionId of new Set(touched.map((source) => source.connectionId))) {
    const { sources } = await deps.semanticLayerService.loadAllSources(connectionId);
    sourcesByConnection.set(connectionId, sources);
  }

  const expanded = expandWithExistingJoinNeighbors(touched, sourcesByConnection);
  const joinTargetIssues = findJoinTargetIssues(touched, sourcesByConnection);

  const valid: string[] = [];
  const invalid: InvalidWuSource[] = [];
  for (const source of expanded) {
    const key = `${source.connectionId}:${source.sourceName}`;
    const result = await deps.slValidator.validateSingleSource(deps, source.connectionId, source.sourceName);
    const sourceIssues: WuValidationIssue[] = result.errors.map((message) => ({ kind: 'source_validation', message }));
    const issues = [...sourceIssues, ...(joinTargetIssues.get(key) ?? [])];
    const errors = issues.map((issue) => issue.message);
    if (errors.length === 0) {
      valid.push(key);
    } else {
      invalid.push({ source: key, errors, issues });
    }
  }
  return { validSources: valid, invalidSources: invalid };
}
