import YAML from 'yaml';
import type { KtxFileStorePort } from '../core/file-store.js';
import { resolveSlSourceFile } from '../sl/source-files.js';
import type { KnowledgeWikiService } from '../wiki/knowledge-wiki.service.js';
import type { FinalArtifactGateFinding } from './artifact-gates.js';
import type { IngestTraceWriter } from './ingest-trace.js';

type FinalGatePrunedReferenceKind = 'join' | 'wiki_ref' | 'wiki_sl_ref' | 'wiki_body_ref';
type SemanticLayerFileStore = Pick<KtxFileStorePort, 'readFile' | 'writeFile' | 'deleteFile' | 'listFiles'>;

interface ResolvedYamlSource {
  path: string;
  source: Record<string, unknown>;
}

export interface FinalGatePrunedReference {
  kind: FinalGatePrunedReferenceKind;
  artifact: string;
  removedRef: string;
  absentTarget: string;
}

export interface FinalGateDroppedSource {
  connectionId: string;
  sourceName: string;
  reason: string;
}

export interface FinalGatePruneResult {
  prunedReferences: FinalGatePrunedReference[];
  droppedSources: FinalGateDroppedSource[];
}

interface PruneInput {
  workdir: string;
  semanticLayerFiles: SemanticLayerFileStore;
  findings: FinalArtifactGateFinding[];
  droppedSources: FinalGateDroppedSource[];
  trace: IngestTraceWriter;
  author: { name: string; email: string };
  wikiService?: KnowledgeWikiService;
}

async function resolveYamlSource(
  fileStore: SemanticLayerFileStore,
  connectionId: string,
  sourceName: string,
): Promise<ResolvedYamlSource | null> {
  const file = await resolveSlSourceFile(fileStore, connectionId, sourceName);
  if (!file) {
    return null;
  }
  const parsed = YAML.parse(file.content);
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
    throw new Error(`${file.path}: expected semantic-layer source YAML object`);
  }
  return { path: file.path, source: parsed as Record<string, unknown> };
}

async function writeYamlSource(input: {
  fileStore: SemanticLayerFileStore;
  path: string;
  source: Record<string, unknown>;
  author: { name: string; email: string };
}): Promise<void> {
  await input.fileStore.writeFile(
    input.path,
    YAML.stringify(input.source, { indent: 2, lineWidth: 0, version: '1.1' }),
    input.author.name,
    input.author.email,
    `Prune dangling joins from ${input.path}`,
    { skipLock: true },
  );
}

function removeInlineToken(content: string, rawToken: string): string {
  return content.replaceAll(`\`${rawToken}\``, '').replace(/[ \t]+([.,;:!?])/g, '$1');
}

function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

function removeWikiRefToken(content: string, targetPageKey: string): string {
  const pattern = new RegExp(`\\[\\[\\s*${escapeRegExp(targetPageKey)}(?:\\|[^\\]\\n]+)?\\s*\\]\\]`, 'g');
  return content.replace(pattern, '').replace(/[ \t]+([.,;:!?])/g, '$1');
}

function wikiBodyAbsentTarget(finding: FinalArtifactGateFinding): string {
  if (finding.kind === 'missing_wiki_body_table') {
    return finding.tableRef;
  }
  if (finding.kind === 'missing_wiki_body_sl_source') {
    return finding.sourceName;
  }
  if (finding.kind === 'missing_wiki_body_sl_entity') {
    return `${finding.sourceName}.${finding.entityName}`;
  }
  return '';
}

export async function pruneFinalGateFindings(input: PruneInput): Promise<FinalGatePruneResult> {
  const droppedSources = [...input.droppedSources];
  const prunedReferences: FinalGatePrunedReference[] = [];
  const droppedKey = new Set(droppedSources.map((source) => `${source.connectionId}:${source.sourceName}`));

  for (const finding of input.findings) {
    if (finding.kind !== 'invalid_source') {
      continue;
    }
    const key = `${finding.connectionId}:${finding.sourceName}`;
    if (droppedKey.has(key)) {
      continue;
    }
    const file = await resolveSlSourceFile(input.semanticLayerFiles, finding.connectionId, finding.sourceName);
    if (!file) {
      continue;
    }
    const deleted = await input.semanticLayerFiles.deleteFile(
      file.path,
      input.author.name,
      input.author.email,
      `Drop invalid source ${finding.connectionId}:${finding.sourceName}`,
      { skipLock: true },
    );
    if (!deleted) {
      continue;
    }
    const dropped = {
      connectionId: finding.connectionId,
      sourceName: finding.sourceName,
      reason: finding.errors.join('; '),
    };
    droppedSources.push(dropped);
    droppedKey.add(key);
    await input.trace.event('info', 'final_gates', 'final_gate_source_dropped', dropped);
  }

  for (const finding of input.findings) {
    if (finding.kind !== 'missing_join_target') {
      continue;
    }
    const resolved = await resolveYamlSource(
      input.semanticLayerFiles,
      finding.ownerConnectionId,
      finding.ownerSourceName,
    );
    if (!resolved || !Array.isArray(resolved.source.joins)) {
      continue;
    }
    const nextJoins = resolved.source.joins.filter(
      (entry) => !(entry && typeof entry === 'object' && 'to' in entry && entry.to === finding.targetSourceName),
    );
    if (nextJoins.length === resolved.source.joins.length) {
      continue;
    }
    resolved.source.joins = nextJoins;
    await writeYamlSource({
      fileStore: input.semanticLayerFiles,
      path: resolved.path,
      source: resolved.source,
      author: input.author,
    });
    const record = {
      kind: 'join' as const,
      artifact: `semantic-layer/${finding.ownerConnectionId}/${finding.ownerSourceName}`,
      removedRef: finding.targetSourceName,
      absentTarget: finding.targetSourceName,
    };
    prunedReferences.push(record);
    await input.trace.event('info', 'final_gates', 'final_gate_reference_pruned', record);
  }

  const wikiFindings = input.findings.filter(
    (finding) =>
      finding.kind === 'missing_wiki_ref' ||
      finding.kind === 'missing_wiki_sl_ref' ||
      finding.kind === 'missing_wiki_body_sl_source' ||
      finding.kind === 'missing_wiki_body_sl_entity' ||
      finding.kind === 'missing_wiki_body_table',
  );
  const pageKeys = [...new Set(wikiFindings.map((finding) => finding.pageKey))].sort();
  for (const pageKey of pageKeys) {
    const page = input.wikiService ? await input.wikiService.readPage('GLOBAL', null, pageKey) : null;
    if (!page) {
      continue;
    }
    const frontmatter = { ...page.frontmatter };
    let content = page.content;
    let changed = false;
    for (const finding of wikiFindings.filter((candidate) => candidate.pageKey === pageKey)) {
      if (finding.kind === 'missing_wiki_ref') {
        const refs = Array.isArray(frontmatter.refs) ? frontmatter.refs.filter((ref) => ref !== finding.targetPageKey) : [];
        const nextContent = removeWikiRefToken(content, finding.targetPageKey);
        if ((Array.isArray(frontmatter.refs) && refs.length !== frontmatter.refs.length) || nextContent !== content) {
          if (Array.isArray(frontmatter.refs)) {
            frontmatter.refs = refs;
          }
          content = nextContent;
          changed = true;
          const record = {
            kind: 'wiki_ref' as const,
            artifact: `wiki/global/${pageKey}`,
            removedRef: finding.targetPageKey,
            absentTarget: finding.targetPageKey,
          };
          prunedReferences.push(record);
          await input.trace.event('info', 'final_gates', 'final_gate_reference_pruned', record);
        }
      } else if (finding.kind === 'missing_wiki_sl_ref') {
        const slRefs = Array.isArray(frontmatter.sl_refs)
          ? frontmatter.sl_refs.filter((ref) => ref !== finding.ref)
          : [];
        if (Array.isArray(frontmatter.sl_refs) && slRefs.length !== frontmatter.sl_refs.length) {
          frontmatter.sl_refs = slRefs;
          changed = true;
          const record = {
            kind: 'wiki_sl_ref' as const,
            artifact: `wiki/global/${pageKey}`,
            removedRef: finding.ref,
            absentTarget: finding.sourceName,
          };
          prunedReferences.push(record);
          await input.trace.event('info', 'final_gates', 'final_gate_reference_pruned', record);
        }
      } else {
        const nextContent = removeInlineToken(content, finding.rawToken);
        if (nextContent !== content) {
          content = nextContent;
          changed = true;
          const record = {
            kind: 'wiki_body_ref' as const,
            artifact: `wiki/global/${pageKey}`,
            removedRef: finding.rawToken,
            absentTarget: wikiBodyAbsentTarget(finding),
          };
          prunedReferences.push(record);
          await input.trace.event('info', 'final_gates', 'final_gate_reference_pruned', record);
        }
      }
    }
    if (changed && input.wikiService) {
      await input.wikiService.writePage(
        'GLOBAL',
        null,
        pageKey,
        frontmatter,
        content,
        input.author.name,
        input.author.email,
        `Prune dangling refs from ${pageKey}`,
        { skipLock: true },
      );
    }
  }

  return { prunedReferences, droppedSources };
}
