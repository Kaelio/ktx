import type { SemanticLayerService } from '../../context/sl/semantic-layer.service.js';
import type { TouchedSlSource } from '../../context/tools/touched-sl-sources.js';
import type { KnowledgeWikiService } from '../../context/wiki/knowledge-wiki.service.js';
import { findMissingWikiRefs } from '../wiki/wiki-ref-validation.js';
import type { WuValidationResult } from './stages/validate-wu-sources.js';
import { findInvalidWikiBodyRefs } from './wiki-body-refs.js';

export interface FinalArtifactGateInput {
  connectionIds: string[];
  changedWikiPageKeys: string[];
  touchedSlSources: TouchedSlSource[];
  wikiService: KnowledgeWikiService;
  semanticLayerService: SemanticLayerService;
  validateTouchedSources(touched: TouchedSlSource[]): Promise<WuValidationResult>;
  tableExists(connectionId: string, tableRef: string): Promise<boolean>;
}

export interface ProvenanceRawPathValidationInput {
  rows: Array<{ rawPath: string }>;
  currentRawPaths: Set<string>;
  deletedRawPaths: Set<string>;
}

function normalizeRawPath(path: string): string {
  return path.replace(/\\/g, '/').replace(/^\/+/, '');
}

function parseSlRef(ref: string): { connectionId: string | null; sourceName: string; entityName: string | null } {
  const withoutConnection = ref.includes('/') ? ref.slice(ref.indexOf('/') + 1) : ref;
  const connectionId = ref.includes('/') ? ref.slice(0, ref.indexOf('/')) : null;
  const [sourceName = '', entityName = null] = withoutConnection.split('.', 2);
  return { connectionId, sourceName, entityName };
}

function slEntityNames(source: Awaited<ReturnType<SemanticLayerService['loadAllSources']>>['sources'][number]): Set<string> {
  return new Set([
    ...(source.measures ?? []).map((measure) => measure.name),
    ...(source.columns ?? []).map((column) => column.name),
    ...(source.segments ?? []).map((segment) => segment.name),
  ]);
}

async function validateWikiSlRefs(input: FinalArtifactGateInput): Promise<string[]> {
  const errors: string[] = [];
  const sourcesByConnection = new Map<string, Awaited<ReturnType<SemanticLayerService['loadAllSources']>>['sources']>();
  for (const connectionId of input.connectionIds) {
    const { sources } = await input.semanticLayerService.loadAllSources(connectionId);
    sourcesByConnection.set(connectionId, sources);
  }

  for (const pageKey of input.changedWikiPageKeys) {
    const page = await input.wikiService.readPage('GLOBAL', null, pageKey);
    if (!page) {
      continue;
    }
    for (const ref of page.frontmatter.sl_refs ?? []) {
      const parsed = parseSlRef(ref);
      const candidateConnections = parsed.connectionId ? [parsed.connectionId] : input.connectionIds;
      let source: Awaited<ReturnType<SemanticLayerService['loadAllSources']>>['sources'][number] | undefined;
      for (const connectionId of candidateConnections) {
        source = sourcesByConnection.get(connectionId)?.find((candidate) => candidate.name === parsed.sourceName);
        if (source) {
          break;
        }
      }
      if (!source) {
        errors.push(`${pageKey}: unknown sl_refs entry ${ref}`);
        continue;
      }
      if (parsed.entityName && !slEntityNames(source).has(parsed.entityName)) {
        errors.push(`${pageKey}: unknown sl_refs entity ${ref}`);
      }
    }
  }
  return errors;
}

async function validateWikiRefs(input: FinalArtifactGateInput): Promise<string[]> {
  const dangling: string[] = [];
  for (const pageKey of input.changedWikiPageKeys) {
    const page = await input.wikiService.readPage('GLOBAL', null, pageKey);
    if (!page) {
      continue;
    }
    const missingRefs = await findMissingWikiRefs({
      wikiService: input.wikiService,
      scope: 'GLOBAL',
      scopeId: null,
      pageKey,
      refs: page.frontmatter.refs,
      content: page.content,
    });
    for (const missingRef of missingRefs) {
      dangling.push(`${pageKey} -> ${missingRef}`);
    }
  }
  return dangling;
}

export async function validateFinalIngestArtifacts(input: FinalArtifactGateInput): Promise<void> {
  // Join-neighbor expansion happens inside validateTouchedSources so work-unit
  // validation and this gate check the same set — a source that passes one
  // passes the other.
  const validation = await input.validateTouchedSources(input.touchedSlSources);
  const errors: string[] = validation.invalidSources.map(
    (invalid) => `semantic-layer validation failed for ${invalid.source}: ${invalid.errors.join('; ')}`,
  );
  errors.push(...(await validateWikiSlRefs(input)));
  const danglingWikiRefs = await validateWikiRefs(input);
  if (danglingWikiRefs.length > 0) {
    errors.push(`wiki references target missing page(s): ${danglingWikiRefs.join(', ')}`);
  }

  for (const pageKey of input.changedWikiPageKeys) {
    const page = await input.wikiService.readPage('GLOBAL', null, pageKey);
    if (!page) {
      continue;
    }
    errors.push(
      ...(await findInvalidWikiBodyRefs({
        pageKey,
        body: page.content,
        visibleConnectionIds: input.connectionIds,
        loadSources: async (connectionId) => {
          const { sources } = await input.semanticLayerService.loadAllSources(connectionId);
          return sources;
        },
        tableExists: input.tableExists,
      })),
    );
  }

  if (errors.length > 0) {
    throw new Error(`final artifact gates failed:\n${errors.join('\n')}`);
  }
}

export function validateProvenanceRawPaths(input: ProvenanceRawPathValidationInput): void {
  const currentRawPaths = new Set([...input.currentRawPaths].map(normalizeRawPath));
  const deletedRawPaths = new Set([...input.deletedRawPaths].map(normalizeRawPath));
  for (const row of input.rows) {
    const rawPath = normalizeRawPath(row.rawPath);
    if (!currentRawPaths.has(rawPath) && !deletedRawPaths.has(rawPath)) {
      throw new Error(`provenance row references raw path outside this snapshot: ${row.rawPath}`);
    }
  }
}
