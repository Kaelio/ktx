import type { SemanticLayerService } from '../../context/sl/semantic-layer.service.js';
import type { TouchedSlSource } from '../../context/tools/touched-sl-sources.js';
import type { KnowledgeWikiService } from '../../context/wiki/knowledge-wiki.service.js';
import { findMissingWikiRefs } from '../wiki/wiki-ref-validation.js';
import type { WuValidationResult } from './stages/validate-wu-sources.js';
import { findInvalidWikiBodyRefIssues, type WikiBodyRefIssue } from './wiki-body-refs.js';

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

export type FinalArtifactGateFinding =
  | { kind: 'invalid_source'; connectionId: string; sourceName: string; errors: string[] }
  | {
      kind: 'missing_join_target';
      ownerConnectionId: string;
      ownerSourceName: string;
      targetSourceName: string;
      message: string;
    }
  | { kind: 'missing_wiki_ref'; pageKey: string; targetPageKey: string; message: string }
  | {
      kind: 'missing_wiki_sl_ref';
      pageKey: string;
      ref: string;
      sourceName: string;
      entityName: string | null;
      message: string;
    }
  | WikiBodyRefIssue;

export interface FinalArtifactGateResult {
  ok: boolean;
  findings: FinalArtifactGateFinding[];
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

async function validateWikiSlRefs(input: FinalArtifactGateInput): Promise<FinalArtifactGateFinding[]> {
  const findings: FinalArtifactGateFinding[] = [];
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
        findings.push({
          kind: 'missing_wiki_sl_ref',
          pageKey,
          ref,
          sourceName: parsed.sourceName,
          entityName: parsed.entityName,
          message: `${pageKey}: unknown sl_refs entry ${ref}`,
        });
        continue;
      }
      if (parsed.entityName && !slEntityNames(source).has(parsed.entityName)) {
        findings.push({
          kind: 'missing_wiki_sl_ref',
          pageKey,
          ref,
          sourceName: parsed.sourceName,
          entityName: parsed.entityName,
          message: `${pageKey}: unknown sl_refs entity ${ref}`,
        });
      }
    }
  }
  return findings;
}

async function validateWikiRefs(input: FinalArtifactGateInput): Promise<FinalArtifactGateFinding[]> {
  const findings: FinalArtifactGateFinding[] = [];
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
      findings.push({
        kind: 'missing_wiki_ref',
        pageKey,
        targetPageKey: missingRef,
        message: `${pageKey} -> ${missingRef}`,
      });
    }
  }
  return findings;
}

export function formatFinalArtifactGateFindings(findings: FinalArtifactGateFinding[]): string {
  const errors = findings.map((finding) => {
    if (finding.kind === 'invalid_source') {
      return `semantic-layer validation failed for ${finding.connectionId}:${finding.sourceName}: ${finding.errors.join('; ')}`;
    }
    if (finding.kind === 'missing_wiki_ref') {
      return `wiki reference targets missing page: ${finding.message}`;
    }
    return finding.message;
  });
  return `final artifact gates failed:\n${errors.join('\n')}`;
}

export function isFinalArtifactGateFindingPruneable(finding: FinalArtifactGateFinding): boolean {
  switch (finding.kind) {
    case 'invalid_source':
    case 'missing_join_target':
    case 'missing_wiki_ref':
    case 'missing_wiki_sl_ref':
    case 'missing_wiki_body_sl_entity':
    case 'missing_wiki_body_sl_source':
    case 'missing_wiki_body_table':
      return true;
    default: {
      const exhaustive: never = finding;
      return exhaustive;
    }
  }
}

export async function validateFinalIngestArtifacts(input: FinalArtifactGateInput): Promise<FinalArtifactGateResult> {
  // Join-neighbor expansion happens inside validateTouchedSources so work-unit
  // validation and this gate check the same set — a source that passes one
  // passes the other.
  const validation = await input.validateTouchedSources(input.touchedSlSources);
  const findings: FinalArtifactGateFinding[] = [];
  for (const invalid of validation.invalidSources) {
    const [connectionId = '', sourceName = ''] = invalid.source.split(':', 2);
    const issues = invalid.issues ?? invalid.errors.map((message) => ({ kind: 'source_validation' as const, message }));
    const sourceErrors = issues.filter((issue) => issue.kind === 'source_validation').map((issue) => issue.message);
    if (sourceErrors.length > 0) {
      findings.push({ kind: 'invalid_source', connectionId, sourceName, errors: sourceErrors });
    }
    for (const issue of issues) {
      if (issue.kind === 'missing_join_target') {
        findings.push({
          kind: 'missing_join_target',
          ownerConnectionId: connectionId,
          ownerSourceName: sourceName,
          targetSourceName: issue.targetSourceName,
          message: issue.message,
        });
      }
    }
  }
  findings.push(...(await validateWikiSlRefs(input)));
  findings.push(...(await validateWikiRefs(input)));

  for (const pageKey of input.changedWikiPageKeys) {
    const page = await input.wikiService.readPage('GLOBAL', null, pageKey);
    if (!page) {
      continue;
    }
    findings.push(
      ...(await findInvalidWikiBodyRefIssues({
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

  return { ok: findings.length === 0, findings };
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
