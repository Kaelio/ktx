import YAML from 'yaml';
import type { KtxFileStorePort } from '../../context/core/file-store.js';
import type { KtxLogger } from '../../context/core/config.js';
import { noopLogger } from '../../context/core/config.js';
import { dialectForConnectionType } from '../connections/connection-type-dialect.js';
import type { TableUsageOutput } from '../ingest/adapters/historic-sql/skill-schemas.js';
import type { SlConnectionCatalogPort, SlPythonPort } from './ports.js';
import { normalizeSemanticLayerDescriptions } from './description-normalization.js';
import { isOverlaySource, resolvedSourceSchema, sourceDefinitionSchema, sourceOverlaySchema } from './schemas.js';
import { isSlYamlPath, resolveSlSourceFile, slDeclaredSourceName, slSourceFilePath } from './source-files.js';
import type {
  ResolvedSemanticLayerSource,
  SemanticLayerColumnOverride,
  SemanticLayerQueryExecutionResult,
  SemanticLayerQueryInput,
  SemanticLayerSource,
} from './types.js';

interface WriteSourceOptions {
  skipValidation?: boolean;
}

const SL_DIR_PREFIX = 'semantic-layer';
const CONNECTION_ID_PATTERN = /^[a-zA-Z0-9_][a-zA-Z0-9_-]*$/;

export interface LoadAllSourcesResult {
  sources: SemanticLayerSource[];
  loadErrors: string[];
}

/** @internal */
export class UnknownColumnOverrideError extends Error {}
/** @internal */
export class ColumnNameCollisionError extends Error {}
/** @internal */
export class ConflictingExcludeAndOverrideError extends Error {}
class ComposeContractError extends Error {}

function isComposeError(error: unknown): boolean {
  return (
    error instanceof UnknownColumnOverrideError ||
    error instanceof ColumnNameCollisionError ||
    error instanceof ConflictingExcludeAndOverrideError ||
    error instanceof ComposeContractError
  );
}

function formatComposeError(filePath: string, error: unknown): string {
  const message = error instanceof Error ? error.message : String(error);
  return `${filePath}: ${message}`;
}

function formatPortError(error: unknown, fallback: string): string {
  if (typeof error === 'string') {
    return error;
  }
  if (error && typeof error === 'object') {
    const detail = 'detail' in error ? error.detail : undefined;
    if (typeof detail === 'string') {
      return detail;
    }
    if (Array.isArray(detail)) {
      return detail
        .map((entry) => {
          const loc = entry && typeof entry === 'object' && 'loc' in entry && Array.isArray(entry.loc) ? entry.loc : [];
          const msg = entry && typeof entry === 'object' && 'msg' in entry ? String(entry.msg) : String(entry);
          return `${loc.join('.')}: ${msg}`;
        })
        .join('; ');
    }
    return JSON.stringify(error);
  }
  return fallback;
}

export function toResolvedWire(source: SemanticLayerSource): ResolvedSemanticLayerSource {
  const stripped = {
    ...source,
    columns: source.columns.map((column) => ({ ...column })),
    joins: source.joins.map(({ source: _source, ...join }) => join),
  } as Record<string, unknown>;
  delete stripped.inherits_columns_from;
  delete stripped.usage;
  delete stripped.source_type;

  const parsed = resolvedSourceSchema.safeParse(stripped);
  if (!parsed.success) {
    const issues = parsed.error.issues.map((issue) => `${issue.path.join('.')}: ${issue.message}`).join('; ');
    throw new ComposeContractError(`resolved source '${source.name}' violates the TS/Python contract: ${issues}`);
  }
  return parsed.data as ResolvedSemanticLayerSource;
}

export class SemanticLayerService {
  constructor(
    private readonly configService: KtxFileStorePort,
    private readonly connections: SlConnectionCatalogPort,
    private readonly python: SlPythonPort,
    private readonly logger: KtxLogger = noopLogger,
  ) {}

  /**
   * Return a clone of this service whose disk reads/writes go through a worktree-scoped
   * ConfigService. Used by the memory agent so SL tool reads inside the LLM loop see
   * session-branch state (otherwise `sl_edit`/`sl_validate` would race against main).
   */
  forWorktree(workdir: string): SemanticLayerService {
    return new SemanticLayerService(
      this.configService.forWorktree(workdir) as KtxFileStorePort,
      this.connections,
      this.python,
      this.logger,
    );
  }

  async listConnectionIds(): Promise<string[]> {
    try {
      const result = await this.configService.listFiles(SL_DIR_PREFIX);
      // Directories under semantic-layer/ are connectionIds. Local ktx projects use
      // readable ids like "warehouse" and "dbt-main", not only UUIDs.
      return result.files
        .map((f) => f.replace(`${SL_DIR_PREFIX}/`, '').split('/')[0])
        .filter((name, i, arr) => CONNECTION_ID_PATTERN.test(name) && arr.indexOf(name) === i)
        .sort();
    } catch {
      return [];
    }
  }

  async listConnectionIdsWithNames(): Promise<Array<{ id: string; name: string; connectionType: string }>> {
    const ids = await this.listConnectionIds();
    if (ids.length === 0) {
      return [];
    }
    return this.connections.listEnabledConnections(ids);
  }

  // ── YAML File Operations ────────────────────────────────

  // The in-file `name:` is the source's identity; the filename is only a derived
  // label. Rewrites land on the file that already declares the name (humans may
  // rename files freely); new sources get a derived filename. A file already
  // sitting at the derived path that declares a name declares a *different* one
  // (the resolver would have matched it otherwise) — fail instead of clobbering
  // it. A nameless/unparseable file there is the broken remains of this very
  // source (the derived path is a function of the name), so overwriting it is
  // the repair path, not data loss.
  private async resolveWritePath(connectionId: string, sourceName: string): Promise<string> {
    const existing = await resolveSlSourceFile(this.configService, connectionId, sourceName);
    if (existing) {
      return existing.path;
    }
    const path = slSourceFilePath(connectionId, sourceName);
    let occupant: string | null = null;
    try {
      occupant = slDeclaredSourceName((await this.configService.readFile(path)).content);
    } catch {
      return path;
    }
    if (occupant !== null) {
      throw new Error(`Cannot write source '${sourceName}': ${path} already defines source '${occupant}'`);
    }
    return path;
  }

  async writeSource(
    connectionId: string,
    source: SemanticLayerSource,
    author: string,
    authorEmail: string,
    commitMessage?: string,
    options?: WriteSourceOptions & { skipLock?: boolean },
  ) {
    // Writes are intentionally permissive — the agent must be able to save broken files so
    // it can iterate on them with punctual edits (Claude-Code-style). Validation happens on
    // demand via `sl_validate` and at query time (where invalid sources should be skipped
    // rather than poisoning the whole connection's catalog). Issues found here are logged
    // as warnings so the caller can surface them without blocking the save. The same
    // warnings are returned to the caller so tool-facing wrappers can surface them to the
    // LLM and enable same-turn self-correction.
    const warnings: string[] = [];

    if (!options?.skipValidation) {
      source = normalizeSemanticLayerDescriptions(source);
      const sourceData: Record<string, unknown> = { ...source };

      if ((sourceData.table || sourceData.sql) && (await this.isManifestBacked(connectionId, source.name))) {
        const msg =
          `standalone source '${source.name}' shadows an existing manifest entry and ` +
          `will drop the manifest's columns and joins. Rewrite as an overlay: remove ` +
          `"sql:", "table:", "grain:", "columns:", "joins:"; keep only "name:" plus ` +
          `"measures:"/"segments:"/"descriptions:"`;
        warnings.push(msg);
        this.logger.warn(`[writeSource] ${msg}. Saving anyway.`);
      }

      const schema = isOverlaySource(sourceData) ? sourceOverlaySchema : sourceDefinitionSchema;
      const parsed = schema.safeParse(source);
      if (!parsed.success) {
        const issues = parsed.error.issues.map((i) => `${i.path.join('.')}: ${i.message}`).join('; ');
        warnings.push(`schema: ${issues}`);
        this.logger.warn(`[writeSource] schema validation warnings for '${source.name}': ${issues}. Saving anyway.`);
      }

      const danglingRefs = findDanglingSegmentRefs(sourceData);
      if (danglingRefs.length > 0) {
        warnings.push(...danglingRefs);
        this.logger.warn(`[writeSource] '${source.name}': ${danglingRefs.join('; ')}. Saving anyway.`);
      }
    }

    const path = await this.resolveWritePath(connectionId, source.name);
    const normalizedSource = normalizeSemanticLayerDescriptions(source);
    const content = YAML.stringify(normalizedSource, { indent: 2, lineWidth: 0, version: '1.1' });
    const message = commitMessage ?? `Update semantic layer source: ${source.name}`;
    const result = await this.configService.writeFile(path, content, author, authorEmail, message, {
      skipLock: options?.skipLock,
    });
    // The filename is derived from (or resolved by) the source name — surface
    // the actual path so callers don't have to re-resolve it.
    return { ...result, path, warnings };
  }

  /**
   * Raw standalone/overlay file for a source, resolved by its in-file `name:`.
   * Returns null when no file declares the name (the source may still exist as
   * a manifest entry under `_schema/`).
   */
  async readSourceFile(connectionId: string, sourceName: string): Promise<{ content: string; path: string } | null> {
    const file = await resolveSlSourceFile(this.configService, connectionId, sourceName);
    return file ? { content: file.content, path: file.path } : null;
  }

  async loadSource(connectionId: string, sourceName: string): Promise<SemanticLayerSource | null> {
    const file = await this.readSourceFile(connectionId, sourceName);
    if (!file) {
      return null;
    }
    try {
      return YAML.parse(file.content) as SemanticLayerSource;
    } catch (error) {
      // Distinguish a YAML parse failure from a missing file. The file exists but
      // its contents are unparseable — callers that treat null as "does not exist"
      // could otherwise overwrite the broken file. Surface the parse failure via
      // the service logger so the broken source is at least visible.
      this.logger.warn(
        `[loadSource] ${file.path}: YAML parse failed: ${error instanceof Error ? error.message : String(error)}`,
      );
      return null;
    }
  }

  async loadAllSources(connectionId: string): Promise<LoadAllSourcesResult> {
    const dir = `${SL_DIR_PREFIX}/${connectionId}`;
    const schemaDir = `${dir}/_schema`;
    const loadErrors: string[] = [];

    let allFiles: string[];
    try {
      const result = await this.configService.listFiles(dir);
      allFiles = result.files.filter((f) => isSlYamlPath(f));
    } catch (e) {
      const message = `Failed to list semantic-layer files under ${dir}: ${e instanceof Error ? e.message : String(e)}`;
      loadErrors.push(message);
      this.logger.warn(message);
      return { sources: [], loadErrors };
    }

    // 1. Load manifest shards from _schema/*.yaml → project to sources
    const sources = new Map<string, SemanticLayerSource>();
    const schemaFiles = allFiles.filter((f) => f.startsWith(`${schemaDir}/`));

    for (const filePath of schemaFiles) {
      try {
        const { content } = await this.configService.readFile(filePath);
        const shard = YAML.parse(content) as { tables?: Record<string, ManifestTableEntry> };
        if (shard?.tables) {
          for (const [name, entry] of Object.entries(shard.tables)) {
            sources.set(name, projectManifestEntry(name, entry));
          }
        }
      } catch (e) {
        const message = `Failed to parse manifest shard ${filePath}: ${e instanceof Error ? e.message : String(e)}`;
        loadErrors.push(message);
        this.logger.warn(message);
      }
    }

    // 2. Load files outside _schema/
    const nonSchemaFiles = allFiles.filter((f) => !f.startsWith(`${schemaDir}/`));
    for (const filePath of nonSchemaFiles) {
      try {
        const { content } = await this.configService.readFile(filePath);
        const data = YAML.parse(content) as Record<string, unknown>;
        if (!data?.name) {
          continue;
        }

        const name = data.name as string;

        if (data.sql || data.table) {
          // Standalone source — warn if it conflicts with a manifest entry
          if (sources.has(name)) {
            this.logger.warn(`Standalone source '${name}' in ${filePath} overrides manifest entry of the same name`);
          }
          let standalone: SemanticLayerSource = normalizeSemanticLayerDescriptions({
            ...(data as Partial<SemanticLayerSource>),
            name,
            grain: Array.isArray(data.grain) ? (data.grain as string[]) : [],
            columns: Array.isArray(data.columns) ? (data.columns as SemanticLayerSource['columns']) : [],
            joins: Array.isArray(data.joins) ? (data.joins as SemanticLayerSource['joins']) : [],
            measures: Array.isArray(data.measures) ? (data.measures as SemanticLayerSource['measures']) : [],
          });
          // If the source declares `inherits_columns_from`, fill any blank
          // type/descriptions/role from the matching manifest entry. Lets the
          // agent write `columns: [{name: FOO}]` without redeclaring known fields.
          const inheritFrom = typeof data.inherits_columns_from === 'string' ? data.inherits_columns_from : null;
          if (inheritFrom) {
            const base = await this.findManifestEntryByTableRef(connectionId, inheritFrom);
            if (base) {
              standalone = enrichColumnsFromManifest(standalone, base);
            } else {
              this.logger.warn(
                `Standalone source '${name}': inherits_columns_from "${inheritFrom}" did not match any manifest entry; columns left as-authored`,
              );
            }
          }
          toResolvedWire(standalone);
          sources.set(name, standalone);
        } else {
          // Overlay — compose with manifest entry if present
          const base = sources.get(name);
          if (base) {
            sources.set(name, composeOverlay(base, data));
          } else {
            this.logger.warn(`Orphan overlay '${name}' in ${filePath}: no matching manifest entry`);
          }
        }
      } catch (e) {
        const message = isComposeError(e)
          ? formatComposeError(filePath, e)
          : `Failed to parse YAML file ${filePath}: ${e instanceof Error ? e.message : String(e)}`;
        loadErrors.push(message);
        this.logger.warn(message);
      }
    }

    return { sources: Array.from(sources.values()), loadErrors };
  }

  /**
   * Return the union of all source names visible to this connection, each tagged with
   * whether it appears in the manifest and whether an overlay YAML exists for it.
   * Includes "orphan overlays" (overlay file present, no manifest entry) — these are
   * absent from `loadAllSources` because they can't be composed, but the UI still
   * needs to surface them as warnings when referenced elsewhere.
   */
  async getSourceStatuses(
    connectionId: string,
  ): Promise<Map<string, { inManifest: boolean; overlayExists: boolean; standalone: boolean }>> {
    const dir = `${SL_DIR_PREFIX}/${connectionId}`;
    const schemaDir = `${dir}/_schema`;
    const result = new Map<string, { inManifest: boolean; overlayExists: boolean; standalone: boolean }>();

    let allFiles: string[];
    try {
      const listing = await this.configService.listFiles(dir);
      allFiles = listing.files.filter((f) => isSlYamlPath(f));
    } catch {
      return result;
    }

    const getOrCreate = (name: string) => {
      let entry = result.get(name);
      if (!entry) {
        entry = { inManifest: false, overlayExists: false, standalone: false };
        result.set(name, entry);
      }
      return entry;
    };

    const schemaFiles = allFiles.filter((f) => f.startsWith(`${schemaDir}/`));
    for (const filePath of schemaFiles) {
      try {
        const { content } = await this.configService.readFile(filePath);
        const shard = YAML.parse(content) as { tables?: Record<string, unknown> };
        if (shard?.tables) {
          for (const name of Object.keys(shard.tables)) {
            getOrCreate(name).inManifest = true;
          }
        }
      } catch {
        // Skip unparseable shards
      }
    }

    const nonSchemaFiles = allFiles.filter((f) => !f.startsWith(`${schemaDir}/`));
    for (const filePath of nonSchemaFiles) {
      try {
        const { content } = await this.configService.readFile(filePath);
        const data = YAML.parse(content) as Record<string, unknown>;
        if (!data?.name || typeof data.name !== 'string') {
          continue;
        }
        const entry = getOrCreate(data.name);
        if (data.sql || data.table) {
          entry.standalone = true;
        } else {
          entry.overlayExists = true;
        }
      } catch {
        // Skip unparseable files
      }
    }

    return result;
  }

  /**
   * Return all manifest-backed source names for a connection — the set the agent may
   * legitimately target with an overlay. Drives the `sl_write` orphan-overlay guardrail
   * so the agent is steered toward a standalone-with-`sql:` rewrite when the name it
   * picked has no base table.
   */
  async listManifestSourceNames(connectionId: string): Promise<string[]> {
    const statuses = await this.getSourceStatuses(connectionId);
    return [...statuses.entries()].filter(([, s]) => s.inManifest).map(([name]) => name);
  }

  async isManifestBacked(connectionId: string, sourceName: string): Promise<boolean> {
    return (await this.getManifestEntry(connectionId, sourceName)) !== null;
  }

  async getManifestEntry(connectionId: string, sourceName: string): Promise<SemanticLayerSource | null> {
    const schemaDir = `${SL_DIR_PREFIX}/${connectionId}/_schema`;
    try {
      const result = await this.configService.listFiles(schemaDir);
      const yamlFiles = result.files.filter((f) => isSlYamlPath(f));
      for (const filePath of yamlFiles) {
        try {
          const { content } = await this.configService.readFile(filePath);
          const shard = YAML.parse(content) as { tables?: Record<string, ManifestTableEntry> };
          const entry = shard?.tables?.[sourceName];
          if (entry) {
            return projectManifestEntry(sourceName, entry);
          }
        } catch {
          // skip unparseable shards
        }
      }
    } catch {
      // no schema dir
    }
    return null;
  }

  /**
   * Resolve a table reference to its manifest entry. Accepts:
   * - the bare manifest key (`CONSIGNMENTS`)
   * - the fully-qualified `table:` value (`ANALYTICS.MARTS.CONSIGNMENTS`)
   * - any dot-suffix of the table value (`MARTS.CONSIGNMENTS`)
   *
   * Case-insensitive on the path comparison. Returns the projected source or null.
   */
  async findManifestEntryByTableRef(connectionId: string, ref: string): Promise<SemanticLayerSource | null> {
    // Try exact key match first (cheap, hits the by-name index).
    const exact = await this.getManifestEntry(connectionId, ref);
    if (exact) {
      return exact;
    }

    const lowered = ref.toLowerCase();
    const dotSuffix = `.${lowered}`;
    const schemaDir = `${SL_DIR_PREFIX}/${connectionId}/_schema`;

    let yamlFiles: string[];
    try {
      const result = await this.configService.listFiles(schemaDir);
      yamlFiles = result.files.filter((f) => isSlYamlPath(f));
    } catch {
      return null;
    }

    for (const filePath of yamlFiles) {
      try {
        const { content } = await this.configService.readFile(filePath);
        const shard = YAML.parse(content) as { tables?: Record<string, ManifestTableEntry> };
        if (!shard?.tables) {
          continue;
        }
        for (const [name, entry] of Object.entries(shard.tables)) {
          const tablePath = entry.table?.toLowerCase() ?? '';
          if (tablePath === lowered || tablePath.endsWith(dotSuffix)) {
            return projectManifestEntry(name, entry);
          }
        }
      } catch {
        // skip unparseable shards
      }
    }
    return null;
  }

  async findManifestEntryByTableRefAcrossConnections(
    preferredConnectionId: string,
    ref: string,
  ): Promise<{ connectionId: string; source: SemanticLayerSource } | null> {
    const preferred = await this.findManifestEntryByTableRef(preferredConnectionId, ref);
    if (preferred) {
      return { connectionId: preferredConnectionId, source: preferred };
    }

    for (const entry of await this.listAllManifestEntries()) {
      if (entry.connectionId === preferredConnectionId) {
        continue;
      }
      if (manifestEntryMatchesRef(entry.source, ref)) {
        return entry;
      }
    }

    return null;
  }


  async validatePhysicalTableReferences(
    connectionId: string,
    sources: SemanticLayerSource[],
  ): Promise<string[]> {
    const errors: string[] = [];
    const sourceNames = new Set(sources.map((s) => s.name.toLowerCase()));
    const sourcesByName = new Map(sources.map((s) => [s.name.toLowerCase(), s]));

    for (const source of sources) {
      if (!source.table) {
        continue;
      }

      const manifestMatch = await this.findManifestEntryByTableRefAcrossConnections(connectionId, source.table);
      if (!manifestMatch) {
        continue;
      }

      const manifestSource = manifestMatch.source;
      const manifestColumns = new Map(manifestSource.columns.map((c) => [c.name.toLowerCase(), c.name]));
      const declaredColumns = source.columns ?? [];
      const declaredByLower = new Map(declaredColumns.map((c) => [c.name.toLowerCase(), c]));
      const validOutputColumns = new Set(
        declaredColumns
          .filter((c) => c.expr || manifestColumns.has(c.name.toLowerCase()))
          .map((c) => c.name.toLowerCase()),
      );
      const measureNames = new Set((source.measures ?? []).map((m) => m.name.toLowerCase()));
      const manifestLabel =
        manifestMatch.connectionId === connectionId
          ? manifestSource.name
          : `${manifestMatch.connectionId}/${manifestSource.name}`;

      const absentDeclaredColumns = declaredColumns
        .filter((c) => !c.expr && !manifestColumns.has(c.name.toLowerCase()))
        .map((c) => c.name);
      if (absentDeclaredColumns.length > 0) {
        errors.push(
          `${source.name}: table "${source.table}" matched manifest ${manifestLabel}, ` +
            `but declared column(s) absent from physical table: ${absentDeclaredColumns.join(', ')}. ` +
            `Available columns: ${[...manifestColumns.values()].join(', ')}`,
        );
      }

      const missingGrainColumns = (source.grain ?? []).filter((grain) => {
        const declared = declaredByLower.get(grain.toLowerCase());
        return !declared || (!declared.expr && !manifestColumns.has(grain.toLowerCase()));
      });
      if (missingGrainColumns.length > 0) {
        errors.push(
          `${source.name}: grain column(s) absent from physical table "${source.table}": ${missingGrainColumns.join(', ')}`,
        );
      }

      for (const column of declaredColumns) {
        if (!column.expr) {
          continue;
        }
        const missing = missingLocalExpressionRefs({
          expr: column.expr,
          sourceName: source.name,
          sourceNames,
          validColumns: new Set([...manifestColumns.keys(), ...validOutputColumns]),
          validMeasures: new Set(),
        });
        if (missing.length > 0) {
          errors.push(
            `${source.name}: computed column "${column.name}" references unknown column(s): ${missing.join(', ')}`,
          );
        }
      }

      for (const segment of source.segments ?? []) {
        const missing = missingLocalExpressionRefs({
          expr: segment.expr,
          sourceName: source.name,
          sourceNames,
          validColumns: validOutputColumns,
          validMeasures: new Set(),
        });
        if (missing.length > 0) {
          errors.push(
            `${source.name}: segment "${segment.name}" references unknown column(s): ${missing.join(', ')}`,
          );
        }
      }

      for (const measure of source.measures ?? []) {
        const exprMissing = missingLocalExpressionRefs({
          expr: measure.expr,
          sourceName: source.name,
          sourceNames,
          validColumns: validOutputColumns,
          validMeasures: measureNames,
        });
        if (exprMissing.length > 0) {
          errors.push(
            `${source.name}: measure "${measure.name}" references unknown column(s): ${exprMissing.join(', ')}`,
          );
        }

        if (measure.filter) {
          const filterMissing = missingLocalExpressionRefs({
            expr: measure.filter,
            sourceName: source.name,
            sourceNames,
            validColumns: validOutputColumns,
            validMeasures: new Set(),
          });
          if (filterMissing.length > 0) {
            errors.push(
              `${source.name}: measure "${measure.name}" filter references unknown column(s): ${filterMissing.join(', ')}`,
            );
          }
        }
      }

      for (const join of source.joins ?? []) {
        const parsed = parseJoinColumns(join.on, source.name, join.to);
        if (!parsed) {
          continue;
        }
        if (!validOutputColumns.has(parsed.localColumn.toLowerCase())) {
          errors.push(
            `${source.name}: join to "${join.to}" references local column ` +
              `"${parsed.localColumn}" that is not a valid output column`,
          );
        }

        const targetSource =
          sourcesByName.get(join.to.toLowerCase()) ??
          (await this.findManifestEntryByTableRefAcrossConnections(connectionId, join.to))?.source;
        if (targetSource) {
          const targetColumns = new Set(targetSource.columns.map((c) => c.name.toLowerCase()));
          if (!targetColumns.has(parsed.targetColumn.toLowerCase())) {
            errors.push(
              `${source.name}: join to "${join.to}" references target column ` +
                `"${parsed.targetColumn}" that does not exist on the target source`,
            );
          }
        }
      }
    }

    return errors;
  }

  async getDialectForConnection(connectionId: string): Promise<string> {
    const connection = await this.connections.getConnectionById(connectionId);
    if (!connection) {
      throw new Error(`Data source not found: ${connectionId}`);
    }
    return dialectForConnectionType(connection.connectionType);
  }

  async listFilesForConnection(connectionId: string): Promise<string[]> {
    const dir = `${SL_DIR_PREFIX}/${connectionId}`;
    try {
      const result = await this.configService.listFiles(dir, true);
      return result.files.filter((f) => isSlYamlPath(f));
    } catch {
      return [];
    }
  }

  async deleteSource(connectionId: string, sourceName: string, author: string, authorEmail: string) {
    const file = await resolveSlSourceFile(this.configService, connectionId, sourceName);
    if (!file) {
      // `deleteFile` returns null for a missing path, which would let a no-op
      // delete read as success. Distinguish the two real cases instead.
      if (await this.isManifestBacked(connectionId, sourceName)) {
        throw new Error(
          `Source '${sourceName}' is defined by the scan manifest (_schema/) and has no overlay file to delete. ` +
            `Rescan the connection to remove it from the manifest.`,
        );
      }
      throw new Error(`Semantic-layer source not found: ${connectionId}/${sourceName}`);
    }
    return this.configService.deleteFile(file.path, author, authorEmail, `Delete semantic layer source: ${sourceName}`);
  }

  /**
   * Validate the semantic layer state that *would* exist if `proposedSource`
   * were written, without persisting anything. Used by write/edit tools to
   * block invalid commits before they hit git.
   */
  async validateWithProposedSource(
    connectionId: string,
    proposedSource: SemanticLayerSource,
  ): Promise<{ errors: string[]; warnings: string[]; perSourceWarnings: Record<string, string[]> }> {
    const loaded = await this.loadAllSources(connectionId);
    const existing = loaded.sources;
    const merged = existing.filter((s) => s.name !== proposedSource.name);
    const loadErrors = [...loaded.loadErrors];

    // Overlays (no table/sql) must be composed with their manifest base before
    // validation, otherwise the filter below drops them and the edited source
    // escapes validation entirely.
    let toPush: SemanticLayerSource = proposedSource;
    if (proposedSource.table == null && proposedSource.sql == null) {
      const base = await this.getManifestEntry(connectionId, proposedSource.name);
      if (!base) {
        return {
          errors: [
            `Overlay '${proposedSource.name}' has no matching manifest entry — cannot validate. ` +
              `Rewrite as a standalone source with 'table:' or 'sql:', or add a manifest shard under _schema/.`,
          ],
          warnings: [],
          perSourceWarnings: {},
        };
      }
      try {
        toPush = composeOverlay(base, { ...proposedSource });
      } catch (error) {
        return {
          errors: [...loadErrors, formatComposeError(`${proposedSource.name}.yaml`, error)],
          warnings: [],
          perSourceWarnings: {},
        };
      }
    } else if (proposedSource.inherits_columns_from) {
      const base = await this.findManifestEntryByTableRef(connectionId, proposedSource.inherits_columns_from);
      if (base) {
        try {
          toPush = enrichColumnsFromManifest(proposedSource, base);
        } catch (error) {
          return {
            errors: [...loadErrors, formatComposeError(`${proposedSource.name}.yaml`, error)],
            warnings: [],
            perSourceWarnings: {},
          };
        }
      }
      // Miss is non-fatal — the source ships unenriched, validator will surface
      // any column-without-type errors via the warehouse probe.
    }
    merged.push(toPush);

    // A join target the engine cannot resolve fails every downstream gate and
    // query with the error attributed to the phantom target. Reject it here,
    // on the source that declares it, while the writing agent can still fix it.
    const missingJoinTargets = findMissingJoinTargets(
      toPush.joins,
      merged.map((s) => s.name),
    );
    const joinTargetErrors = missingJoinTargets.map(
      (missing) =>
        `${toPush.name}: ${formatMissingJoinTarget(missing)}. Declare joins only to existing ` +
        `semantic-layer sources in this connection, or drop the join and keep the relationship ` +
        `in a column description.`,
    );
    if (joinTargetErrors.length > 0) {
      return { errors: [...loadErrors, ...joinTargetErrors], warnings: [], perSourceWarnings: {} };
    }

    const validatable = merged.filter((s) => s.table != null || s.sql != null);
    if (validatable.length === 0) {
      return { errors: loadErrors, warnings: [], perSourceWarnings: {} };
    }

    const dialect = await this.getDialectForConnection(connectionId);

    try {
      const { data, error } = await this.python.validateSources({
        sources: validatable.map(toResolvedWire),
        dialect,
        recently_touched: [proposedSource.name],
      });
      if (error) {
        const errorMsg = formatPortError(error, 'Unknown validation error');
        return { errors: [...loadErrors, errorMsg], warnings: [], perSourceWarnings: {} };
      }
      if (!data) {
        return {
          errors: [...loadErrors, ...(await this.validatePhysicalTableReferences(connectionId, validatable))],
          warnings: [],
          perSourceWarnings: {},
        };
      }
      const physicalErrors = await this.validatePhysicalTableReferences(connectionId, validatable);
      return {
        errors: [...loadErrors, ...(data.errors ?? []), ...physicalErrors],
        warnings: data.warnings ?? [],
        perSourceWarnings: data.per_source_warnings ?? {},
      };
    } catch (e) {
      return {
        errors: [...loadErrors, `Validation call failed: ${e instanceof Error ? e.message : String(e)}`],
        warnings: [],
        perSourceWarnings: {},
      };
    }
  }

  async validateSourcesForConnection(connectionId: string): Promise<{ errors: string[]; warnings: string[] }> {
    const { sources: allSources, loadErrors } = await this.loadAllSources(connectionId);
    const sources = allSources.filter((source) => source.table != null || source.sql != null);
    if (sources.length === 0) {
      return { errors: loadErrors, warnings: [] };
    }

    const dialect = await this.getDialectForConnection(connectionId);
    const { data, error } = await this.python.validateSources({ sources: sources.map(toResolvedWire), dialect });
    if (error) {
      return { errors: [...loadErrors, formatPortError(error, 'Unknown validation error')], warnings: [] };
    }
    if (!data) {
      return { errors: [...loadErrors, ...(await this.validatePhysicalTableReferences(connectionId, sources))], warnings: [] };
    }
    const physicalErrors = await this.validatePhysicalTableReferences(connectionId, sources);
    return {
      errors: [...loadErrors, ...(data.errors ?? []), ...physicalErrors],
      warnings: data.warnings ?? [],
    };
  }

  private async listAllManifestEntries(): Promise<Array<{ connectionId: string; source: SemanticLayerSource }>> {
    let files: string[];
    try {
      files = (await this.configService.listFiles(SL_DIR_PREFIX)).files;
    } catch {
      return [];
    }

    const schemaFiles = files.filter((file) => /^semantic-layer\/[^/]+\/_schema\//.test(file) && isSlYamlPath(file));
    const entries: Array<{ connectionId: string; source: SemanticLayerSource }> = [];
    for (const filePath of schemaFiles) {
      const connectionId = filePath.split('/')[1];
      try {
        const { content } = await this.configService.readFile(filePath);
        const shard = YAML.parse(content) as { tables?: Record<string, ManifestTableEntry> };
        for (const [name, entry] of Object.entries(shard?.tables ?? {})) {
          entries.push({ connectionId, source: projectManifestEntry(name, entry) });
        }
      } catch {
        // skip unparseable shards
      }
    }
    return entries;
  }

  /**
   * Validate overlays and standalone sources against the current manifest.
   * Returns warnings for stale references (non-blocking).
   */
  async validateOverlaysAfterScan(connectionId: string): Promise<string[]> {
    const dir = `${SL_DIR_PREFIX}/${connectionId}`;
    const schemaDir = `${dir}/_schema`;
    const warnings: string[] = [];

    let allFiles: string[];
    try {
      const result = await this.configService.listFiles(dir);
      allFiles = result.files.filter((f) => isSlYamlPath(f));
    } catch {
      return warnings;
    }

    // Load manifest entries to know what columns/joins/tables exist
    const manifestColumns = new Map<string, Set<string>>(); // sourceName → column names
    const manifestJoins = new Map<string, Set<string>>(); // sourceName → normalized join on clauses
    const allSourceNames = new Set<string>();

    const schemaFiles = allFiles.filter((f) => f.startsWith(`${schemaDir}/`));
    for (const filePath of schemaFiles) {
      try {
        const { content } = await this.configService.readFile(filePath);
        const shard = YAML.parse(content) as {
          tables?: Record<string, { columns?: Array<{ name: string }>; joins?: Array<{ on: string }> }>;
        };
        if (shard?.tables) {
          for (const [name, entry] of Object.entries(shard.tables)) {
            allSourceNames.add(name);
            manifestColumns.set(name, new Set((entry.columns ?? []).map((c) => c.name)));
            manifestJoins.set(name, new Set((entry.joins ?? []).map((j) => j.on.replace(/\s+/g, ' ').trim())));
          }
        }
      } catch {
        // Skip unparseable shards
      }
    }

    // Check overlays and standalone sources
    const nonSchemaFiles = allFiles.filter((f) => !f.startsWith(`${schemaDir}/`));
    for (const filePath of nonSchemaFiles) {
      try {
        const { content } = await this.configService.readFile(filePath);
        const data = YAML.parse(content) as Record<string, unknown>;
        if (!data?.name) {
          continue;
        }
        const name = data.name as string;

        if (data.sql || data.table) {
          // Standalone source — check join targets exist
          const joins = (data.joins as Array<{ to: string }>) ?? [];
          for (const join of joins) {
            if (!allSourceNames.has(join.to)) {
              warnings.push(`${name}: join target '${join.to}' does not exist`);
            }
          }
          allSourceNames.add(name);
        } else {
          // Overlay — check references against manifest
          const excludeColumns = (data.exclude_columns as string[]) ?? [];
          const columnOverrides = (data.column_overrides as Array<{ name: string }> | undefined) ?? [];
          const disableJoins = (data.disable_joins as string[]) ?? [];
          const cols = manifestColumns.get(name);
          const joins = manifestJoins.get(name);

          if (!cols) {
            warnings.push(`${name}: overlay has no matching manifest entry`);
            continue;
          }

          for (const col of excludeColumns) {
            if (!cols.has(col)) {
              warnings.push(`${name}: exclude_columns references non-existent column '${col}'`);
            }
          }

          const excluded = new Set(excludeColumns);
          for (const override of columnOverrides) {
            if (!cols.has(override.name)) {
              warnings.push(`${name}: column_overrides references non-existent column '${override.name}'`);
            }
            if (excluded.has(override.name)) {
              warnings.push(`${name}: column '${override.name}' appears in both exclude_columns and column_overrides`);
            }
          }

          for (const joinOn of disableJoins) {
            const normalized = joinOn.replace(/\s+/g, ' ').trim();
            if (!joins?.has(normalized)) {
              warnings.push(`${name}: disable_joins references non-existent join '${joinOn}'`);
            }
          }

          // Check computed column expressions for stale column references
          const overlayColumns = (data.columns as Array<{ name: string; expr?: string }>) ?? [];
          for (const col of overlayColumns) {
            if (col.expr) {
              for (const ref of extractColumnReferences(col.expr)) {
                if (!cols.has(ref)) {
                  warnings.push(`${name}: computed column '${col.name}' references non-existent column '${ref}'`);
                }
              }
            }
          }

          // Check measure expressions for stale column references
          const overlayMeasures = (data.measures as Array<{ name: string; expr: string }>) ?? [];
          for (const measure of overlayMeasures) {
            if (measure.expr) {
              for (const ref of extractColumnReferences(measure.expr)) {
                if (!cols.has(ref)) {
                  warnings.push(`${name}: measure '${measure.name}' references non-existent column '${ref}'`);
                }
              }
            }
          }
        }
      } catch {
        // Skip unparseable files
      }
    }

    return warnings;
  }

  /**
   * Build FK context from composed entities for a connection.
   * Returns a map keyed by `tableName.columnName` with outgoing and incoming FK relationships.
   * This replaces direct column_links DB queries for FK context.
   */
  buildForeignKeyContext(sources: SemanticLayerSource[]): Map<
    string,
    {
      outgoing: Array<{ toTable: string; toColumn: string }>;
      incoming: Array<{ fromTable: string; fromColumn: string }>;
    }
  > {
    const fkMap = new Map<
      string,
      {
        outgoing: Array<{ toTable: string; toColumn: string }>;
        incoming: Array<{ fromTable: string; fromColumn: string }>;
      }
    >();

    const getOrCreate = (key: string) => {
      let ctx = fkMap.get(key);
      if (!ctx) {
        ctx = { outgoing: [], incoming: [] };
        fkMap.set(key, ctx);
      }
      return ctx;
    };

    for (const source of sources) {
      for (const join of source.joins) {
        // Parse the `on` clause: "orders.customer_id = customers.id"
        const parsed = parseJoinOn(join.on, source.name, join.to);
        if (!parsed) {
          continue;
        }

        // Outgoing: source column → target table.column
        const fromKey = `${source.name}.${parsed.fromColumn}`;
        getOrCreate(fromKey).outgoing.push({ toTable: join.to, toColumn: parsed.toColumn });

        // Incoming: target column ← source table.column
        const toKey = `${join.to}.${parsed.toColumn}`;
        getOrCreate(toKey).incoming.push({ fromTable: source.name, fromColumn: parsed.fromColumn });
      }
    }

    return fkMap;
  }

  /**
   * Build a column metadata lookup from manifest YAML for a connection.
   * Returns a map keyed by `tableName.columnName` with type and descriptions map.
   * Used by embedding refresh and other consumers that need column metadata after it was
   * removed from source_columns DB table.
   */
  async buildColumnMetadataMap(connectionId: string): Promise<{
    columns: Map<string, { type: string; descriptions: Record<string, string>; nullable?: boolean; pk?: boolean }>;
    tables: Map<string, { descriptions: Record<string, string> }>;
  }> {
    const dir = `${SL_DIR_PREFIX}/${connectionId}/_schema`;
    const columns = new Map<
      string,
      { type: string; descriptions: Record<string, string>; nullable?: boolean; pk?: boolean }
    >();
    const tables = new Map<string, { descriptions: Record<string, string> }>();

    try {
      const result = await this.configService.listFiles(dir);
      const yamlFiles = result.files.filter((f) => isSlYamlPath(f));

      for (const filePath of yamlFiles) {
        try {
          const { content } = await this.configService.readFile(filePath);
          const shard = YAML.parse(content) as {
            tables?: Record<
              string,
              {
                descriptions?: Record<string, string>;
                columns?: Array<{
                  name: string;
                  type: string;
                  pk?: boolean;
                  nullable?: boolean;
                  descriptions?: Record<string, string>;
                }>;
              }
            >;
          };
          if (shard?.tables) {
            for (const [tableName, entry] of Object.entries(shard.tables)) {
              tables.set(tableName, {
                descriptions: entry.descriptions ?? {},
              });
              for (const col of entry.columns ?? []) {
                columns.set(`${tableName}.${col.name}`, {
                  type: col.type,
                  descriptions: col.descriptions ?? {},
                  nullable: col.nullable,
                  pk: col.pk,
                });
              }
            }
          }
        } catch {
          // Skip unparseable shards
        }
      }
    } catch {
      // Schema dir may not exist
    }

    return { columns, tables };
  }

  /**
   * Execute a semantic layer query: load composed sources, generate SQL via
   * the python SL engine, and execute the generated SQL against the data source.
   */
  async executeQuery(connectionId: string, query: SemanticLayerQueryInput): Promise<SemanticLayerQueryExecutionResult> {
    // 1. Load sources, filtering out sources with no table or sql
    const { sources: allSources, loadErrors } = await this.loadAllSources(connectionId);
    if (loadErrors.length > 0) {
      throw new Error(`Semantic layer source load failed: ${loadErrors.join('; ')}`);
    }
    const sources = allSources.filter((s) => {
      if (!s.table && !s.sql) {
        this.logger.warn(`Skipping source "${s.name}" with no table or sql defined`);
        return false;
      }
      return true;
    });

    if (sources.length === 0) {
      throw new Error('No semantic layer sources found for this connection');
    }

    // 2. Resolve dialect
    const connection = await this.connections.getConnectionById(connectionId);
    if (!connection) {
      throw new Error(`Data source not found: ${connectionId}`);
    }
    const dialect = dialectForConnectionType(connection.connectionType);

    // 3. Generate SQL via python SL engine
    const { data: slResult, error: slError } = await this.python.query({
      sources: sources.map(toResolvedWire),
      query,
      dialect,
    });

    if (slError || !slResult?.sql) {
      const errorMsg = formatPortError(slError, 'Unknown error generating SQL from semantic layer');
      throw new Error(`Semantic layer query failed: ${errorMsg}`);
    }

    // 4. Execute the generated SQL
    const result = await this.connections.executeQuery(connectionId, slResult.sql);

    return {
      sql: slResult.sql,
      headers: result.headers ?? [],
      rows: result.rows ?? [],
      totalRows: result.totalRows ?? (result.rows ?? []).length,
      plan: (slResult.plan as Record<string, unknown>) ?? {},
    };
  }
}

// ── Manifest types and helpers ────────────────────────────────────

interface ManifestColumnEntry {
  name: string;
  type: string;
  pk?: boolean;
  nullable?: boolean;
  descriptions?: Record<string, string>;
  constraints?: { dbt?: { not_null?: boolean; unique?: boolean } };
  enum_values?: { dbt?: string[] };
  tests?: {
    dbt?: Array<{ name: string; package: string }>;
    dbt_by_package?: Record<string, string[]>;
  };
}

interface ManifestJoinEntry {
  to: string;
  on: string;
  relationship: string;
  source?: string;
}

export interface ManifestTableEntry {
  table: string;
  descriptions?: Record<string, string>;
  columns: ManifestColumnEntry[];
  joins?: ManifestJoinEntry[];
  tags?: { dbt?: string[] };
  freshness?: { dbt?: { raw?: unknown; loaded_at_field?: string | null } };
  usage?: TableUsageOutput;
}

export function projectManifestEntry(name: string, entry: ManifestTableEntry): SemanticLayerSource {
  const columns = entry.columns.map((c) => ({
    name: c.name,
    type: c.type,
    role: c.type === 'time' ? 'time' : undefined,
    descriptions: c.descriptions,
    constraints: c.constraints,
    enum_values: c.enum_values,
    tests: c.tests,
  }));

  const pkColumns = entry.columns.filter((c) => c.pk).map((c) => c.name);
  const grain = pkColumns.length > 0 ? pkColumns : entry.columns.map((c) => c.name);

  // Table-level dbt config from manifest shards is surfaced on the source for search / tools.
  const source: SemanticLayerSource = {
    name,
    table: entry.table,
    descriptions: entry.descriptions,
    grain,
    columns,
    joins: (entry.joins ?? []).map((j) => ({ to: j.to, on: j.on, relationship: j.relationship })),
    measures: [],
    ...(entry.tags?.dbt?.length ? { tags: entry.tags } : {}),
    ...(entry.freshness?.dbt ? { freshness: entry.freshness } : {}),
    ...(entry.usage ? { usage: entry.usage } : {}),
  };
  toResolvedWire(source);
  return source;
}

function normalizeWs(s: string): string {
  return s.replace(/\s+/g, ' ').trim();
}

const SQL_KEYWORDS = new Set([
  'sum',
  'count',
  'avg',
  'min',
  'max',
  'distinct',
  'case',
  'when',
  'then',
  'else',
  'end',
  'and',
  'or',
  'not',
  'is',
  'null',
  'as',
  'in',
  'between',
  'like',
  'where',
  'filter',
  'cast',
  'coalesce',
  'nullif',
  'if',
  'true',
  'false',
  'asc',
  'desc',
  'date',
  'day',
  'month',
  'quarter',
  'week',
  'year',
  'interval',
  'extract',
  'from',
  'over',
  'partition',
  'by',
  'rows',
  'range',
  'current',
  'current_date',
  'current_time',
  'current_timestamp',
  'localtime',
  'localtimestamp',
  'row',
  'numeric',
  'decimal',
  'int',
  'integer',
  'bigint',
  'smallint',
  'float',
  'double',
  'real',
  'string',
  'text',
  'char',
  'character',
  'varchar',
  'timestamp',
  'time',
  'uuid',
  'json',
  'jsonb',
  'bool',
  'boolean',
]);

function extractColumnReferences(expr: string): string[] {
  const cleaned = expr.replace(/'[^']*'/g, '').replace(/\b\d+(\.\d+)?\b/g, '');
  const tokens = cleaned.match(/\b[a-zA-Z_]\w*\b/g) ?? [];
  return [...new Set(tokens.filter((t) => !SQL_KEYWORDS.has(t.toLowerCase())))];
}

function manifestEntryMatchesRef(source: SemanticLayerSource, ref: string): boolean {
  if (source.name.toLowerCase() === ref.toLowerCase()) {
    return true;
  }
  const table = source.table?.toLowerCase();
  const lowered = ref.toLowerCase();
  return !!table && (table === lowered || table.endsWith(`.${lowered}`));
}

function normalizeSqlExpressionForIdentifierScan(expr: string): string {
  return expr
    .replace(/--.*$/gm, ' ')
    .replace(/\/\*[\s\S]*?\*\//g, ' ')
    .replace(/'([^']|'')*'/g, ' ')
    .replace(/"([^"]+)"/g, '$1')
    .replace(/`([^`]+)`/g, '$1')
    .replace(/\[([^\]]+)\]/g, '$1')
    .replace(/::\s*[A-Za-z_][\w$]*(?:\s*\([^)]*\))?/g, ' ');
}

function extractSqlIdentifierRefs(expr: string): Array<{ qualifier?: string; name: string }> {
  const normalized = normalizeSqlExpressionForIdentifierScan(expr);
  const refs = new Map<string, { qualifier?: string; name: string }>();
  const re = /(?:\b([A-Za-z_][\w$]*)\s*\.\s*)?(\b[A-Za-z_][\w$]*)\b/g;
  for (const match of normalized.matchAll(re)) {
    const qualifier = match[1];
    const name = match[2];
    if (!name) {
      continue;
    }
    const nameLower = name.toLowerCase();
    const qualifierLower = qualifier?.toLowerCase();
    const after = normalized.slice((match.index ?? 0) + match[0].length).trimStart();
    if (!qualifier && after.startsWith('(')) {
      continue;
    }
    if (SQL_KEYWORDS.has(nameLower) || (qualifierLower && SQL_KEYWORDS.has(qualifierLower))) {
      continue;
    }
    refs.set(`${qualifierLower ?? ''}.${nameLower}`, qualifier ? { qualifier, name } : { name });
  }
  return [...refs.values()];
}

function refBelongsToSource(
  ref: { qualifier?: string; name: string },
  sourceName: string,
  sourceNames: Set<string>,
): boolean {
  if (!ref.qualifier) {
    return true;
  }
  const qualifier = ref.qualifier.toLowerCase();
  if (qualifier === sourceName.toLowerCase()) {
    return true;
  }
  return !sourceNames.has(qualifier);
}

function missingLocalExpressionRefs(input: {
  expr: string;
  sourceName: string;
  sourceNames: Set<string>;
  validColumns: Set<string>;
  validMeasures: Set<string>;
}): string[] {
  const missing = new Set<string>();
  for (const ref of extractSqlIdentifierRefs(input.expr)) {
    if (!refBelongsToSource(ref, input.sourceName, input.sourceNames)) {
      continue;
    }
    const name = ref.name.toLowerCase();
    if (!input.validColumns.has(name) && !input.validMeasures.has(name)) {
      missing.add(ref.name);
    }
  }
  return [...missing].sort();
}

function parseJoinSide(side: string): { qualifier?: string; column: string } | null {
  const match = side.trim().match(/^(?:(\w+)\.)?(\w+)$/);
  if (!match) {
    return null;
  }
  return match[1] ? { qualifier: match[1], column: match[2] } : { column: match[2] };
}

function parseJoinColumns(
  on: string,
  sourceName: string,
  targetName: string,
): { localColumn: string; targetColumn: string } | null {
  const sides = on.split('=');
  if (sides.length !== 2) {
    return null;
  }
  const left = parseJoinSide(sides[0]);
  const right = parseJoinSide(sides[1]);
  if (!left || !right) {
    return null;
  }

  const sourceLower = sourceName.toLowerCase();
  const targetLower = targetName.toLowerCase();
  const leftQualifier = left.qualifier?.toLowerCase();
  const rightQualifier = right.qualifier?.toLowerCase();

  if (leftQualifier === targetLower || rightQualifier === sourceLower) {
    return { localColumn: right.column, targetColumn: left.column };
  }
  if (rightQualifier === targetLower || leftQualifier === sourceLower || !leftQualifier) {
    return { localColumn: left.column, targetColumn: right.column };
  }
  return { localColumn: left.column, targetColumn: right.column };
}

export interface MissingJoinTarget {
  to: string;
  /** Source whose name matches only case-insensitively, if any — the usual authoring mistake. */
  caseMismatch: string | null;
}

/**
 * Join targets that do not exactly match a known source name. The Python
 * engine resolves `joins[].to` by exact name within one connection's source
 * set (`engine._collect_orphan_join_target_errors`) and `query()` raises on a
 * miss, so anything looser here — case-insensitive matches, table refs,
 * sources in other connections — would pass this gate and then fail
 * query/validation as an orphan join target.
 */
export function findMissingJoinTargets(
  joins: Array<{ to: string }> | undefined,
  knownSourceNames: Iterable<string>,
): MissingJoinTarget[] {
  const known = new Set<string>();
  const canonicalByLower = new Map<string, string>();
  for (const name of knownSourceNames) {
    known.add(name);
    canonicalByLower.set(name.toLowerCase(), name);
  }
  const missing: MissingJoinTarget[] = [];
  for (const join of joins ?? []) {
    if (known.has(join.to)) {
      continue;
    }
    missing.push({ to: join.to, caseMismatch: canonicalByLower.get(join.to.toLowerCase()) ?? null });
  }
  return missing;
}

export function formatMissingJoinTarget(missing: MissingJoinTarget): string {
  const hint = missing.caseMismatch
    ? `; join targets are case-sensitive — the source is named "${missing.caseMismatch}"`
    : '';
  return `join target "${missing.to}" does not exist${hint}`;
}

/**
 * Returns one message per measure-level segment reference that doesn't resolve to
 * a segment defined on the source. Array is empty when every reference checks out.
 */
/** @internal */
export function findDanglingSegmentRefs(source: Record<string, unknown>): string[] {
  const segmentDefs = (source.segments as Array<{ name: string }> | undefined) ?? [];
  const segmentNames = new Set(segmentDefs.map((s) => s.name));
  const measures = (source.measures as Array<{ name: string; segments?: string[] }> | undefined) ?? [];
  const problems: string[] = [];
  for (const m of measures) {
    for (const ref of m.segments ?? []) {
      if (!segmentNames.has(ref)) {
        problems.push(`measure '${m.name}' references unknown segment '${ref}' (not in source.segments)`);
      }
    }
  }
  return problems;
}

const COMPOSE_KNOWN_KEYS = new Set([
  'name',
  'descriptions',
  'grain',
  'columns',
  'column_overrides',
  'joins',
  'measures',
  'segments',
  'exclude_columns',
  'disable_joins',
  'default_time_dimension',
  'usage',
]);

export function composeOverlay(base: SemanticLayerSource, overlay: Record<string, unknown>): SemanticLayerSource {
  const normalizedOverlay = normalizeSemanticLayerDescriptions(overlay);
  const unknownKeys = Object.keys(normalizedOverlay).filter((k) => !COMPOSE_KNOWN_KEYS.has(k));
  if (unknownKeys.length > 0) {
    throw new Error(
      `composeOverlay: overlay for '${base.name}' has unhandled keys [${unknownKeys.join(', ')}]. ` +
        `Add a compose branch or remove from the schema.`,
    );
  }

  const result = { ...base };

  // Descriptions (plural) merge keyed by source (e.g. `dbt`, `ai`, `db`). Overlay keys
  // win over matching base keys but unrelated base keys are preserved.
  if (normalizedOverlay.descriptions) {
    result.descriptions = {
      ...(result.descriptions ?? {}),
      ...(normalizedOverlay.descriptions as Record<string, string>),
    };
  }

  if (normalizedOverlay.usage !== undefined) {
    result.usage = normalizedOverlay.usage as SemanticLayerSource['usage'];
  }

  const excluded = new Set((normalizedOverlay.exclude_columns as string[] | undefined) ?? []);
  const columnOverrides = (normalizedOverlay.column_overrides as SemanticLayerColumnOverride[] | undefined) ?? [];
  const overrideNames = columnOverrides.map((column) => column.name);
  const conflictingOverrides = overrideNames.filter((name) => excluded.has(name));
  if (conflictingOverrides.length > 0) {
    throw new ConflictingExcludeAndOverrideError(
      `column_overrides conflict with exclude_columns for '${base.name}': ${conflictingOverrides.join(', ')}`,
    );
  }

  const baseByLowerName = new Map(base.columns.map((column) => [column.name.toLowerCase(), column]));
  const columnsByLowerName = new Map(
    result.columns.filter((column) => !excluded.has(column.name)).map((column) => [column.name.toLowerCase(), column]),
  );

  for (const override of columnOverrides) {
    const key = override.name.toLowerCase();
    const baseColumn = baseByLowerName.get(key);
    if (!baseColumn) {
      throw new UnknownColumnOverrideError(
        `column '${override.name}' in column_overrides does not exist on manifest source '${base.name}'`,
      );
    }
    const baseDescriptions = baseColumn.descriptions ?? {};
    const overrideDescriptions = override.descriptions ?? {};
    const merged = { ...baseColumn, ...override };
    if (Object.keys(baseDescriptions).length > 0 || Object.keys(overrideDescriptions).length > 0) {
      merged.descriptions = { ...baseDescriptions, ...overrideDescriptions };
    }
    columnsByLowerName.set(key, merged);
  }

  const computedColumns = (normalizedOverlay.columns as SemanticLayerSource['columns'] | undefined) ?? [];
  for (const column of computedColumns) {
    if (baseByLowerName.has(column.name.toLowerCase())) {
      throw new ColumnNameCollisionError(
        `column '${column.name}' in columns already exists on manifest source '${base.name}'`,
      );
    }
    columnsByLowerName.set(column.name.toLowerCase(), column);
  }
  result.columns = [...columnsByLowerName.values()];

  // Measures from overlay only
  result.measures = (normalizedOverlay.measures as SemanticLayerSource['measures'] | undefined) ?? [];

  // Segments: overlay-replaces semantics. Manifest tables don't carry segments today;
  // if that changes, add a union branch here.
  if (normalizedOverlay.segments !== undefined) {
    result.segments = normalizedOverlay.segments as SemanticLayerSource['segments'];
  }

  // Override grain
  if (normalizedOverlay.grain) {
    result.grain = normalizedOverlay.grain as string[];
  }

  if (normalizedOverlay.default_time_dimension !== undefined) {
    result.default_time_dimension =
      normalizedOverlay.default_time_dimension as SemanticLayerSource['default_time_dimension'];
  }

  // Union + dedupe joins, apply suppressions
  const disabled = new Set(((normalizedOverlay.disable_joins as string[] | undefined) ?? []).map(normalizeWs));
  const manifestJoins = result.joins.filter((j) => !disabled.has(normalizeWs(j.on)));
  const overlayJoins = (normalizedOverlay.joins as SemanticLayerSource['joins'] | undefined) ?? [];
  const existingKeys = new Set(manifestJoins.map((j) => `${j.to}::${normalizeWs(j.on)}`));
  const newJoins = overlayJoins.filter((j) => !existingKeys.has(`${j.to}::${normalizeWs(j.on)}`));
  result.joins = [...manifestJoins, ...newJoins];

  const overlayParse = sourceOverlaySchema.safeParse(normalizedOverlay);
  if (!overlayParse.success) {
    const issues = overlayParse.error.issues.map((issue) => `${issue.path.join('.')}: ${issue.message}`).join('; ');
    throw new ComposeContractError(`overlay for '${base.name}' violates the authoring schema: ${issues}`);
  }
  toResolvedWire(result);
  return result;
}

/**
 * Parse a join `on` clause like "orders.customer_id = customers.id"
 * into { fromColumn, toColumn } relative to the source and target tables.
 */
function parseJoinOn(
  on: string,
  sourceName: string,
  targetName: string,
): { fromColumn: string; toColumn: string } | null {
  // Match: table.column = table.column (with optional whitespace)
  const match = on.match(/^(\w+)\.(\w+)\s*=\s*(\w+)\.(\w+)$/);
  if (!match) {
    return null;
  }

  const [, leftTable, leftCol, rightTable, rightCol] = match;

  if (leftTable === sourceName && rightTable === targetName) {
    return { fromColumn: leftCol, toColumn: rightCol };
  }
  if (leftTable === targetName && rightTable === sourceName) {
    return { fromColumn: rightCol, toColumn: leftCol };
  }

  // Fallback: left side is "from", right side is "to"
  return { fromColumn: leftCol, toColumn: rightCol };
}

/**
 * Fill any blank `type`, `descriptions`, or `role` on the source's columns from the
 * matching manifest column (by name). Local values always win. Columns absent from
 * the manifest pass through unchanged. Returns a new source; does not mutate input.
 */
/** @internal */
export function enrichColumnsFromManifest(
  source: SemanticLayerSource,
  manifestEntry: SemanticLayerSource | null | undefined,
): SemanticLayerSource {
  if (!manifestEntry?.columns?.length) {
    return source;
  }
  const manifestByName = new Map(manifestEntry.columns.map((c) => [c.name, c]));
  const enrichedColumns = source.columns.map((col) => {
    const base = manifestByName.get(col.name);
    if (!base) {
      return col;
    }
    const merged: typeof col = { ...col };
    if (!merged.type) {
      merged.type = base.type;
    }
    if (!merged.descriptions || Object.keys(merged.descriptions).length === 0) {
      if (base.descriptions && Object.keys(base.descriptions).length > 0) {
        merged.descriptions = { ...base.descriptions };
      }
    }
    if (!merged.role && base.role) {
      merged.role = base.role;
    }
    return merged;
  });
  const enriched = { ...source, columns: enrichedColumns };
  toResolvedWire(enriched);
  return enriched;
}
