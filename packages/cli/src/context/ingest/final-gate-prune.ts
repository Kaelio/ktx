import { readFile, rm, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import YAML from 'yaml';
import type { KnowledgeWikiService } from '../wiki/knowledge-wiki.service.js';
import type { FinalArtifactGateFinding } from './artifact-gates.js';
import type { IngestTraceWriter } from './ingest-trace.js';

type FinalGatePrunedReferenceKind = 'join' | 'wiki_ref' | 'wiki_sl_ref' | 'wiki_body_ref';

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
  findings: FinalArtifactGateFinding[];
  droppedSources: FinalGateDroppedSource[];
  trace: IngestTraceWriter;
  author: { name: string; email: string };
  wikiService?: KnowledgeWikiService;
}

function sourcePath(connectionId: string, sourceName: string): string {
  return `semantic-layer/${connectionId}/${sourceName}.yaml`;
}

async function readYamlSource(
  workdir: string,
  connectionId: string,
  sourceName: string,
): Promise<Record<string, unknown> | null> {
  try {
    return YAML.parse(await readFile(join(workdir, sourcePath(connectionId, sourceName)), 'utf-8')) as Record<
      string,
      unknown
    >;
  } catch (error) {
    if (error && typeof error === 'object' && 'code' in error && error.code === 'ENOENT') {
      return null;
    }
    throw error;
  }
}

async function writeYamlSource(
  workdir: string,
  connectionId: string,
  sourceName: string,
  source: Record<string, unknown>,
): Promise<void> {
  await writeFile(
    join(workdir, sourcePath(connectionId, sourceName)),
    YAML.stringify(source, { indent: 2, lineWidth: 0, version: '1.1' }),
    'utf-8',
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
    await rm(join(input.workdir, sourcePath(finding.connectionId, finding.sourceName)), { force: true });
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
    const source = await readYamlSource(input.workdir, finding.ownerConnectionId, finding.ownerSourceName);
    if (!source || !Array.isArray(source.joins)) {
      continue;
    }
    const nextJoins = source.joins.filter(
      (entry) => !(entry && typeof entry === 'object' && 'to' in entry && entry.to === finding.targetSourceName),
    );
    if (nextJoins.length === source.joins.length) {
      continue;
    }
    source.joins = nextJoins;
    await writeYamlSource(input.workdir, finding.ownerConnectionId, finding.ownerSourceName, source);
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
