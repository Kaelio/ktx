import type { KtxFileStorePort } from '../../context/core/file-store.js';
import type { SemanticLayerService } from '../../context/sl/semantic-layer.service.js';
import type { SemanticLayerSource } from '../../context/sl/types.js';
import { isFlatWikiKey } from '../wiki/keys.js';
import type { KnowledgeWikiService } from '../../context/wiki/knowledge-wiki.service.js';
import type { WikiFrontmatter } from '../../context/wiki/types.js';

const SYSTEM_AUTHOR = 'System User';
const SYSTEM_EMAIL = 'system@example.com';

export interface WikiSlRefRepair {
  pageKey: string;
  scope: 'GLOBAL' | 'USER';
  scopeId: string | null;
  removedRefs: string[];
}

export interface WikiSlRefRepairResult {
  repairs: WikiSlRefRepair[];
  warnings: string[];
}

interface WikiPath {
  scope: 'GLOBAL' | 'USER';
  scopeId: string | null;
  pageKey: string;
}

function parseKnowledgeFilePath(path: string): WikiPath | null {
  if (!path.endsWith('.md')) {
    return null;
  }
  const segments = path.split('/');
  if (segments.length === 2 && segments[0] === 'global') {
    const pageKey = segments[1].replace(/\.md$/, '');
    return isFlatWikiKey(pageKey) ? { scope: 'GLOBAL', scopeId: null, pageKey } : null;
  }
  if (segments.length === 3 && segments[0] === 'user') {
    const pageKey = segments[2].replace(/\.md$/, '');
    return isFlatWikiKey(pageKey) ? { scope: 'USER', scopeId: segments[1], pageKey } : null;
  }
  return null;
}

function entityRefsForSource(source: SemanticLayerSource): string[] {
  return [
    source.name,
    ...(source.measures ?? []).map((measure) => `${source.name}.${measure.name}`),
    ...(source.segments ?? []).map((segment) => `${source.name}.${segment.name}`),
  ];
}

async function loadVisibleSlRefs(
  semanticLayerService: SemanticLayerService,
  connectionIds: string[],
): Promise<{ refs: Set<string>; warnings: string[] }> {
  const refs = new Set<string>();
  const warnings: string[] = [];
  for (const connectionId of connectionIds) {
    try {
      const { sources } = await semanticLayerService.loadAllSources(connectionId);
      for (const source of sources) {
        for (const ref of entityRefsForSource(source)) {
          refs.add(ref);
        }
      }
    } catch (error) {
      warnings.push(
        `Skipped wiki sl_refs repair for connection ${connectionId}: ${error instanceof Error ? error.message : String(error)}`,
      );
    }
  }
  return { refs, warnings };
}

function uniqueStringArray(value: string[] | undefined): string[] {
  return [...new Set((value ?? []).filter((entry) => typeof entry === 'string' && entry.trim().length > 0))];
}

export async function repairWikiSlRefs(input: {
  wikiService: KnowledgeWikiService;
  semanticLayerService: SemanticLayerService;
  configService: KtxFileStorePort;
  connectionIds: string[];
  deferGlobalPageKeys?: string[];
}): Promise<WikiSlRefRepairResult> {
  const { refs: validRefs, warnings } = await loadVisibleSlRefs(input.semanticLayerService, input.connectionIds);
  const listFiles =
    typeof input.configService.listFiles === 'function'
      ? input.configService.listFiles.bind(input.configService)
      : null;
  if (!listFiles) {
    return {
      repairs: [],
      warnings: [...warnings, 'Skipped wiki sl_refs repair: config service cannot list wiki files.'],
    };
  }
  const listed = await listFiles('wiki', true);
  const repairs: WikiSlRefRepair[] = [];
  const deferredGlobalPageKeys = new Set(input.deferGlobalPageKeys ?? []);

  for (const file of listed.files.sort()) {
    const parsedPath = parseKnowledgeFilePath(file);
    if (!parsedPath) {
      continue;
    }
    if (parsedPath.scope === 'GLOBAL' && deferredGlobalPageKeys.has(parsedPath.pageKey)) {
      continue;
    }
    const page = await input.wikiService.readPage(parsedPath.scope, parsedPath.scopeId, parsedPath.pageKey);
    const refs = uniqueStringArray(page?.frontmatter.sl_refs);
    if (!page || refs.length === 0) {
      continue;
    }
    const keptRefs = refs.filter((ref) => validRefs.has(ref));
    const removedRefs = refs.filter((ref) => !validRefs.has(ref));
    if (removedRefs.length === 0) {
      continue;
    }

    const frontmatter: WikiFrontmatter = {
      ...page.frontmatter,
      sl_refs: keptRefs,
    };
    await input.wikiService.writePage(
      parsedPath.scope,
      parsedPath.scopeId,
      parsedPath.pageKey,
      frontmatter,
      page.content,
      SYSTEM_AUTHOR,
      SYSTEM_EMAIL,
      `Repair semantic-layer refs: ${parsedPath.pageKey}`,
    );
    repairs.push({ ...parsedPath, removedRefs });
  }

  return {
    repairs,
    warnings: [
      ...warnings,
      ...repairs.map(
        (repair) =>
          `Removed invalid sl_refs from ${repair.pageKey}: ${repair.removedRefs.join(', ')}`,
      ),
    ],
  };
}
