import YAML from 'yaml';
import type { GitService } from '../../../context/core/git.service.js';
import type { KtxFileListResult, KtxFileReadResult, KtxFileStorePort } from '../../../context/core/file-store.js';
import { SYSTEM_GIT_AUTHOR } from '../../../context/tools/authors.js';
import { dialectForConnectionType } from '../../connections/connection-type-dialect.js';
import type { SlConnectionCatalogPort, SlSourcesIndexPort } from '../ports.js';
import { sourceOverlaySchema } from '../schemas.js';
import type { SemanticLayerService } from '../semantic-layer.service.js';
import { resolveSlSourceFile, slSourceFilePath } from '../source-files.js';
import type { SemanticLayerSource } from '../types.js';
import { sourceDefinitionSchema } from './base-semantic-layer.tool.js';

export interface SlValidationDeps {
  semanticLayerService: SemanticLayerService;
  connections: SlConnectionCatalogPort;
  configService: KtxFileStorePort;
  gitService: GitService;
  slSourcesRepository: SlSourcesIndexPort;
  probeRowCount: number;
}

/** @internal */
export interface SourceValidationResult {
  errors: string[];
  warnings: string[];
}

function resolveDialect(warehouse: string | null): string | null {
  if (!warehouse) {
    return null;
  }
  return dialectForConnectionType(warehouse);
}

function wrapWithZeroRowQuery(sql: string, dialect: string): string {
  if (dialect === 'tsql') {
    return `SELECT TOP 0 * FROM (${sql}) AS _discovery`;
  }
  return `SELECT * FROM (${sql}) AS _discovery LIMIT 0`;
}

function wrapWithSingleRowQuery(sql: string, dialect: string): string {
  if (dialect === 'tsql') {
    return `SELECT TOP 1 * FROM (${sql}) AS _base`;
  }
  return `SELECT * FROM (${sql}) AS _base LIMIT 1`;
}

/**
 * Validate one SL source end-to-end: YAML parse, Zod schema, duplicate-measure detection,
 * warehouse dry-run (`SELECT * FROM (sql) LIMIT 1` — forces runtime policy enforcement).
 *
 * Returns errors and hint-style warnings. An empty errors array means the YAML is
 * structurally valid AND the warehouse can execute a probe against its embedded sql.
 */
/** @internal */
export async function validateSingleSource(
  deps: SlValidationDeps,
  connectionId: string,
  sourceName: string,
): Promise<SourceValidationResult> {
  const errors: string[] = [];
  const warnings: string[] = [];

  const file = await deps.semanticLayerService.readSourceFile(connectionId, sourceName);
  if (!file) {
    errors.push(`${sourceName}: no standalone or overlay file found`);
    return { errors, warnings };
  }

  let parsed: Record<string, unknown>;
  try {
    parsed = YAML.parse(file.content);
  } catch (e) {
    errors.push(`${sourceName}: invalid YAML — ${e instanceof Error ? e.message : String(e)}`);
    return { errors, warnings };
  }
  if (!parsed || typeof parsed !== 'object') {
    errors.push(`${sourceName}: top-level content is not an object`);
    return { errors, warnings };
  }

  const isOverlay = !parsed.table && !parsed.sql;
  if (!isOverlay) {
    const isManifestBacked = await deps.semanticLayerService.isManifestBacked(connectionId, sourceName);
    if (isManifestBacked) {
      errors.push(
        `${sourceName}: standalone source shadows an existing manifest entry — ` +
          `writing it as-is drops the manifest's columns and joins. ` +
          `Remove "sql:", "table:", "grain:", and base-table "columns:" and keep only ` +
          `"name:" plus overlay fields such as "measures:", "segments:", "descriptions:", ` +
          `"joins:", "column_overrides:", or computed-only "columns:" to write an overlay ` +
          `that inherits the manifest schema. Call sl_read_source to inspect the existing source first.`,
      );
      return { errors, warnings };
    }
  }
  const schema = isOverlay ? sourceOverlaySchema : sourceDefinitionSchema;
  const result = schema.safeParse(parsed);
  if (!result.success) {
    const issues = result.error.issues.map((i) => `${i.path.join('.')}: ${i.message}`).join('; ');
    errors.push(`${sourceName}: schema — ${issues}`);
    const errorPaths = new Set(result.error.issues.map((i) => String(i.path[0])));
    if (errorPaths.has('joins')) {
      warnings.push(
        `${sourceName}: hint — join format: {to, on: 'local_col = TARGET.col', relationship: 'many_to_one|one_to_many|one_to_one'}`,
      );
    }
    if (errorPaths.has('columns')) {
      warnings.push(
        `${sourceName}: hint — overlay columns must be computed: {name, expr, type}. Use column_overrides for manifest column descriptions or metadata.`,
      );
    }
    if (errorPaths.has('measures')) {
      warnings.push(
        `${sourceName}: hint — measure format: {name, expr, description (optional), filter (optional)}`,
      );
    }
    return { errors, warnings };
  }

  if (!isOverlay && 'table' in result.data && result.data.table) {
    errors.push(
      ...(await deps.semanticLayerService.validatePhysicalTableReferences(connectionId, [
        result.data as SemanticLayerSource,
      ])),
    );
  }

  const measures = (parsed.measures as Array<{ name: string }> | undefined) ?? [];
  const seenMeasures = new Set<string>();
  for (const m of measures) {
    if (seenMeasures.has(m.name)) {
      errors.push(`${sourceName}: duplicate measure name "${m.name}"`);
    }
    seenMeasures.add(m.name);
  }

  let warehouse: string | null = null;
  try {
    const connection = await deps.connections.getConnectionById(connectionId);
    warehouse = connection?.connectionType ?? null;
  } catch {
    warehouse = null;
  }

  if (typeof parsed.sql === 'string' && parsed.sql.trim().length > 0) {
    const innerSql = parsed.sql.trim().replace(/;+\s*$/, '');
    const probeRowCount = deps.probeRowCount;
    const dialect = resolveDialect(warehouse);
    let probeSql: string;
    if (dialect) {
      probeSql =
        probeRowCount === 0 ? wrapWithZeroRowQuery(innerSql, dialect) : wrapWithSingleRowQuery(innerSql, dialect);
    } else {
      probeSql = `SELECT * FROM (${innerSql}) AS _probe LIMIT ${probeRowCount}`;
    }
    const sourceColumns = ((parsed.columns as Array<{ name?: string; type?: string }> | undefined) ?? [])
      .map((c) => ({ name: c.name ?? '', type: c.type ?? '' }))
      .filter((c) => c.name);
    try {
      const probe = await deps.connections.executeQuery(connectionId, probeSql);
      const actual = new Set((probe.headers ?? []).map((h) => h.toLowerCase()));
      const missing = sourceColumns.map((c) => c.name).filter((n) => !actual.has(n.toLowerCase()));
      if (missing.length > 0) {
        errors.push(
          `${sourceName}: declared columns absent from sql result — ${missing.join(', ')} (warehouse returned: ${[...actual].slice(0, 10).join(', ')}${actual.size > 10 ? ', …' : ''})`,
        );
      }
    } catch (e) {
      errors.push(
        formatProbeError({
          sourceName,
          measureName: null,
          probeSql,
          warehouse,
          sourceColumns,
          error: e,
          headline: 'embedded sql dry-run failed',
        }),
      );
    }
  } else if (isOverlay) {
    const measureErrors = await probeOverlayMeasures(deps, connectionId, sourceName, warehouse);
    errors.push(...measureErrors);
  }

  return { errors, warnings };
}

function formatProbeError(args: {
  sourceName: string;
  measureName: string | null;
  probeSql: string;
  warehouse: string | null;
  sourceColumns: Array<{ name: string; type: string }>;
  error: unknown;
  headline: string;
}): string {
  const { sourceName, measureName, probeSql, warehouse, sourceColumns, error, headline } = args;
  const errMsg = error instanceof Error ? error.message : String(error);
  const refColumns = sourceColumns.filter((c) => referencesColumn(probeSql, c.name));
  const lines: string[] = [
    measureName ? `${sourceName}: measure "${measureName}" ${headline}.` : `${sourceName}: ${headline}.`,
  ];
  if (warehouse) {
    lines.push(`  Warehouse: ${warehouse}`);
  }
  lines.push(`  Probe SQL: ${probeSql}`);
  if (refColumns.length > 0) {
    lines.push(`  Referenced columns: ${refColumns.map((c) => `${c.name} (${c.type || '?'})`).join(', ')}`);
  }
  lines.push(`  Error: ${errMsg}`);
  return lines.join('\n');
}

function referencesColumn(sql: string, columnName: string): boolean {
  if (!columnName) {
    return false;
  }
  const escaped = columnName.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  return new RegExp(`\\b${escaped}\\b`).test(sql);
}

async function probeOverlayMeasures(
  deps: SlValidationDeps,
  connectionId: string,
  sourceName: string,
  warehouse: string | null,
): Promise<string[]> {
  const errors: string[] = [];
  let composed:
    | {
        name: string;
        table?: string;
        sql?: string;
        columns?: Array<{ name?: string; type?: string }>;
        measures: Array<{ name: string; expr: string; filter?: string; segments?: string[] }>;
        segments?: Array<{ name: string; expr: string }>;
      }
    | undefined;
  try {
    const { sources: all, loadErrors } = await deps.semanticLayerService.loadAllSources(connectionId);
    errors.push(...loadErrors);
    composed = all.find((s) => s.name === sourceName);
  } catch (e) {
    errors.push(
      `${sourceName}: failed to load composed source for probe — ${e instanceof Error ? e.message : String(e)}`,
    );
    return errors;
  }
  if (!composed?.table || composed.measures.length === 0) {
    return errors;
  }

  const sourceColumns = (composed.columns ?? [])
    .map((c) => ({ name: c.name ?? '', type: c.type ?? '' }))
    .filter((c) => c.name);

  for (const measure of composed.measures) {
    const measureRef = `${sourceName}.${measure.name}`;
    let probeSql = `<composed via semantic-layer engine for ${measureRef}>`;
    try {
      const result = await deps.semanticLayerService.executeQuery(connectionId, {
        measures: [measureRef],
        dimensions: [],
        filters: [],
        limit: 1,
      });
      probeSql = result.sql ?? probeSql;
    } catch (e) {
      errors.push(
        formatProbeError({
          sourceName,
          measureName: measure.name,
          probeSql,
          warehouse,
          sourceColumns,
          error: e,
          headline: 'dry-run failed',
        }),
      );
    }
  }
  return errors;
}

/**
 * A read-only view of the config repo at one commit, shaped for
 * `resolveSlSourceFile` so name→file resolution runs against history exactly as
 * it does against the working tree — one resolver, two backing stores. Used to
 * recover the path a source occupied at `preHead` after the live file is gone.
 */
function gitCommitFileStore(
  git: GitService,
  commitHash: string,
): Pick<KtxFileStorePort, 'listFiles' | 'readFile'> {
  return {
    async listFiles(path: string): Promise<KtxFileListResult> {
      return { files: await git.listFilesAtCommit(path, commitHash) };
    },
    async readFile(path: string): Promise<KtxFileReadResult> {
      return { content: await git.getFileAtCommit(path, commitHash) };
    },
  };
}

/**
 * Restore `sourceName` to the content it had at `preHead`, or delete it if it didn't
 * exist then. Used by sl_rollback (agent-driven) and the pre-squash revert gate
 * (automatic). Returns a short human-readable description of what happened.
 */
export async function revertSourceToPreHead(
  deps: SlValidationDeps,
  connectionId: string,
  preHead: string | null,
  sourceName: string,
): Promise<string> {
  // Find the file that defines this source. While it is still on disk
  // (invalid-but-present) the live resolver finds it by its in-file `name:`.
  // Once the session deleted it, the path is gone too — and humans rename files
  // freely, so it is NOT the writer-derived filename. Recover it from history by
  // resolving the name against the preHead commit instead of guessing.
  const live = await resolveSlSourceFile(deps.configService, connectionId, sourceName);
  let relPath: string;
  let preContent: string | null = null;
  if (live) {
    relPath = live.path;
    if (preHead) {
      try {
        preContent = await deps.gitService.getFileAtCommit(relPath, preHead);
      } catch {
        preContent = null;
      }
    }
  } else {
    const atPreHead = preHead
      ? await resolveSlSourceFile(gitCommitFileStore(deps.gitService, preHead), connectionId, sourceName)
      : null;
    relPath = atPreHead?.path ?? slSourceFilePath(connectionId, sourceName);
    preContent = atPreHead?.content ?? null;
  }

  if (preContent !== null) {
    await deps.configService.writeFile(
      relPath,
      preContent,
      SYSTEM_GIT_AUTHOR.name,
      SYSTEM_GIT_AUTHOR.email,
      `Revert SL source to pre-session state: ${sourceName}`,
      { skipLock: true },
    );
    return 'restored to pre-session content';
  }

  try {
    await deps.configService.deleteFile(
      relPath,
      SYSTEM_GIT_AUTHOR.name,
      SYSTEM_GIT_AUTHOR.email,
      `Drop SL source (not present at session start): ${sourceName}`,
      { skipLock: true },
    );
    await deps.slSourcesRepository.deleteByConnectionAndName(connectionId, sourceName);
    return 'deleted (did not exist at session start)';
  } catch {
    await deps.slSourcesRepository.deleteByConnectionAndName(connectionId, sourceName);
    return 'no-op (already absent)';
  }
}
