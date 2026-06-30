import type { SemanticLayerSource } from '../../context/sl/types.js';

/** @internal */
export type WikiBodyRef =
  | { kind: 'sl_entity'; connectionId: string | null; sourceName: string; entityName: string; rawToken: string }
  | { kind: 'sl_source'; connectionId: string | null; sourceName: string; rawToken: string }
  | { kind: 'table'; connectionId: string | null; tableRef: string; rawToken: string };

export interface WikiBodyRefValidationInput {
  pageKey: string;
  body: string;
  visibleConnectionIds: string[];
  loadSources(connectionId: string): Promise<SemanticLayerSource[]>;
  tableExists(connectionId: string, tableRef: string): Promise<boolean>;
}

export type WikiBodyRefIssue =
  | {
      kind: 'missing_wiki_body_sl_entity';
      pageKey: string;
      rawToken: string;
      connectionId?: string;
      sourceName: string;
      entityName: string;
      message: string;
    }
  | {
      kind: 'missing_wiki_body_sl_source';
      pageKey: string;
      rawToken: string;
      connectionId?: string;
      sourceName: string;
      message: string;
    }
  | {
      kind: 'missing_wiki_body_table';
      pageKey: string;
      rawToken: string;
      connectionId?: string;
      tableRef: string;
      message: string;
    };

const inlineCodePattern = /`([^`\n]+)`/g;

function visibleLinesOutsideFences(body: string): string[] {
  const lines: string[] = [];
  let fenced = false;
  for (const line of body.split('\n')) {
    if (/^\s*```/.test(line)) {
      fenced = !fenced;
      continue;
    }
    if (!fenced) {
      lines.push(line);
    }
  }
  return lines;
}

function parseConnectionScoped(value: string): { connectionId: string | null; body: string } {
  const slash = value.indexOf('/');
  if (slash <= 0) {
    return { connectionId: null, body: value };
  }
  return { connectionId: value.slice(0, slash), body: value.slice(slash + 1) };
}

function isIdentifierToken(value: string): boolean {
  return /^[A-Za-z_][A-Za-z0-9_]*$/.test(value);
}

/** @internal */
export function parseWikiBodyRefs(body: string): WikiBodyRef[] {
  const refs: WikiBodyRef[] = [];
  for (const line of visibleLinesOutsideFences(body)) {
    for (const match of line.matchAll(inlineCodePattern)) {
      const token = (match[1] ?? '').trim();
      if (!token) {
        continue;
      }
      const scoped = parseConnectionScoped(token);
      if (scoped.body.startsWith('source:')) {
        const sourceName = scoped.body.slice('source:'.length).trim();
        if (sourceName) {
          refs.push({ kind: 'sl_source', connectionId: scoped.connectionId, sourceName, rawToken: token });
        }
        continue;
      }
      if (scoped.body.startsWith('table:')) {
        const tableRef = scoped.body.slice('table:'.length).trim();
        if (tableRef) {
          refs.push({ kind: 'table', connectionId: scoped.connectionId, tableRef, rawToken: token });
        }
        continue;
      }
      const parts = scoped.body.split('.');
      if (parts.length === 2 && isIdentifierToken(parts[0] ?? '') && isIdentifierToken(parts[1] ?? '')) {
        refs.push({
          kind: 'sl_entity',
          connectionId: scoped.connectionId,
          sourceName: parts[0],
          entityName: parts[1],
          rawToken: token,
        });
      }
    }
  }
  return refs;
}

function entityNames(source: SemanticLayerSource): Set<string> {
  return new Set([
    ...(source.measures ?? []).map((measure) => measure.name),
    ...(source.columns ?? []).map((column) => column.name),
    ...(source.segments ?? []).map((segment) => segment.name),
  ]);
}

export async function findInvalidWikiBodyRefIssues(input: WikiBodyRefValidationInput): Promise<WikiBodyRefIssue[]> {
  const issues: WikiBodyRefIssue[] = [];
  const sourceCache = new Map<string, SemanticLayerSource[]>();
  const loadSources = async (connectionId: string): Promise<SemanticLayerSource[]> => {
    const cached = sourceCache.get(connectionId);
    if (cached) {
      return cached;
    }
    const sources = await input.loadSources(connectionId);
    sourceCache.set(connectionId, sources);
    return sources;
  };

  const findSource = async (
    connectionIds: string[],
    sourceName: string,
  ): Promise<{ connectionId: string; source: SemanticLayerSource } | null> => {
    for (const connectionId of connectionIds) {
      const source = (await loadSources(connectionId)).find((candidate) => candidate.name === sourceName);
      if (source) {
        return { connectionId, source };
      }
    }
    return null;
  };

  for (const ref of parseWikiBodyRefs(input.body)) {
    const connectionIds = ref.connectionId ? [ref.connectionId] : input.visibleConnectionIds;
    if (ref.kind === 'table') {
      const found = await Promise.all(connectionIds.map((connectionId) => input.tableExists(connectionId, ref.tableRef)));
      if (!found.some(Boolean)) {
        const target = `${ref.connectionId ? `${ref.connectionId}/` : ''}${ref.tableRef}`;
        issues.push({
          kind: 'missing_wiki_body_table',
          pageKey: input.pageKey,
          rawToken: ref.rawToken,
          ...(ref.connectionId ? { connectionId: ref.connectionId } : {}),
          tableRef: ref.tableRef,
          message: `${input.pageKey}: unknown raw table ${target}`,
        });
      }
      continue;
    }

    const found = await findSource(connectionIds, ref.sourceName);
    if (!found) {
      if (ref.kind === 'sl_source') {
        const target = `${ref.connectionId ? `${ref.connectionId}/` : ''}${ref.sourceName}`;
        issues.push({
          kind: 'missing_wiki_body_sl_source',
          pageKey: input.pageKey,
          rawToken: ref.rawToken,
          ...(ref.connectionId ? { connectionId: ref.connectionId } : {}),
          sourceName: ref.sourceName,
          message: `${input.pageKey}: unknown semantic-layer source ${target}`,
        });
      }
      continue;
    }
    if (ref.kind === 'sl_entity' && !entityNames(found.source).has(ref.entityName)) {
      issues.push({
        kind: 'missing_wiki_body_sl_entity',
        pageKey: input.pageKey,
        rawToken: ref.rawToken,
        ...(ref.connectionId ? { connectionId: ref.connectionId } : {}),
        sourceName: ref.sourceName,
        entityName: ref.entityName,
        message: `${input.pageKey}: unknown semantic-layer entity ${ref.sourceName}.${ref.entityName}`,
      });
    }
  }

  return issues;
}

/** @internal */
export async function findInvalidWikiBodyRefs(input: WikiBodyRefValidationInput): Promise<string[]> {
  return (await findInvalidWikiBodyRefIssues(input)).map((issue) => issue.message);
}
