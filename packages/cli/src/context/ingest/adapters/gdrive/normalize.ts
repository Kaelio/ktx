import type {
  GoogleDocsDocument,
  GoogleDocsDocumentStyle,
  GoogleDocsHeaderFooter,
  GoogleDocsLinkTarget,
  GoogleDocsList,
  GoogleDocsParagraph,
  GoogleDocsParagraphElement,
  GoogleDocsStructuralElement,
  GoogleDocsTab,
  GoogleDocsTable,
  GoogleDocsTableCell,
} from './types.js';

function escapeMarkdownText(value: string): string {
  return value.replace(/([*_~`])/g, '\\$1');
}

function normalizeInternalLinkTarget(prefix: 'heading' | 'bookmark', target: GoogleDocsLinkTarget | string | undefined): string | null {
  const id = typeof target === 'string' ? target : target?.id;
  if (!id?.trim()) {
    return null;
  }
  return `#${prefix}-${id.trim()}`;
}

function resolveLinkHref(element: GoogleDocsParagraphElement): string | null {
  const link = element.textRun?.textStyle?.link;
  const href = link?.url?.trim();
  if (href) {
    return href;
  }
  return (
    normalizeInternalLinkTarget('heading', link?.heading) ??
    normalizeInternalLinkTarget('heading', link?.headingId) ??
    normalizeInternalLinkTarget('bookmark', link?.bookmark) ??
    normalizeInternalLinkTarget('bookmark', link?.bookmarkId) ??
    null
  );
}

function normalizeTextRun(element: GoogleDocsParagraphElement): string {
  const content = element.textRun?.content ?? '';
  const style = element.textRun?.textStyle;
  let text = escapeMarkdownText(content.replace(/\r/g, ''));
  if (!text && element.inlineObjectElement) {
    return '[Embedded object]';
  }
  if (!text && element.pageBreak) {
    return '\n---\n';
  }
  if (!text) {
    return '';
  }
  const href = resolveLinkHref(element);
  const isCode = style?.weightedFontFamily?.fontFamily === 'Courier New';
  if (isCode) {
    text = `\`${text.replace(/`/g, '\\`')}\``;
  }
  if (style?.bold) {
    text = `**${text}**`;
  }
  if (style?.italic) {
    text = `*${text}*`;
  }
  if (style?.underline) {
    text = `<u>${text}</u>`;
  }
  if (style?.strikethrough) {
    text = `~~${text}~~`;
  }
  if (href) {
    text = `[${text}](${href.replace(/\)/g, '\\)')})`;
  }
  if (style?.baselineOffset === 'SUPERSCRIPT') {
    text = `<sup>${text}</sup>`;
  } else if (style?.baselineOffset === 'SUBSCRIPT') {
    text = `<sub>${text}</sub>`;
  }
  return text;
}

function paragraphText(paragraph: GoogleDocsParagraph | undefined): string {
  return (paragraph?.elements ?? [])
    .map((element) => normalizeTextRun(element))
    .join('')
    .replace(/\n/g, '')
    .trim();
}

function headingPrefix(namedStyleType: string | undefined): string | null {
  if (namedStyleType === 'TITLE') {
    return '#';
  }
  if (namedStyleType === 'SUBTITLE') {
    return '##';
  }
  if (!namedStyleType?.startsWith('HEADING_')) {
    return null;
  }
  const level = Number.parseInt(namedStyleType.slice('HEADING_'.length), 10);
  if (Number.isNaN(level) || level < 1) {
    return null;
  }
  return '#'.repeat(Math.min(level, 6));
}

function isOrderedListLevel(level: { glyphType?: string; glyphSymbol?: string } | undefined): boolean {
  const glyphType = level?.glyphType?.toUpperCase();
  if (glyphType) {
    return (
      glyphType.includes('NUMBER') ||
      glyphType.includes('DECIMAL') ||
      glyphType.includes('ALPHA') ||
      glyphType.includes('ROMAN') ||
      glyphType.includes('LATIN')
    );
  }
  const glyphSymbol = level?.glyphSymbol?.trim();
  return glyphSymbol === '%0.' || glyphSymbol === '%0)' || glyphSymbol === '1.' || glyphSymbol === '1)';
}

function listPrefix(paragraph: GoogleDocsParagraph, lists: Record<string, GoogleDocsList> | undefined): string | null {
  if (!paragraph.bullet) {
    return null;
  }
  const level = Math.max(paragraph.bullet.nestingLevel ?? 0, 0);
  const indent = '  '.repeat(level);
  const listDefinition = paragraph.bullet.listId ? lists?.[paragraph.bullet.listId] : undefined;
  const listLevel = listDefinition?.listProperties?.nestingLevels?.[level];
  return `${indent}${isOrderedListLevel(listLevel) ? '1. ' : '- '}`;
}

function paragraphToMarkdown(
  paragraph: GoogleDocsParagraph | undefined,
  lists: Record<string, GoogleDocsList> | undefined,
): string | null {
  const text = paragraphText(paragraph);
  if (!text) {
    return null;
  }
  const prefix = paragraph ? listPrefix(paragraph, lists) : null;
  if (prefix) {
    return `${prefix}${text}`;
  }
  const heading = headingPrefix(paragraph?.paragraphStyle?.namedStyleType);
  if (heading) {
    const headingLine = `${heading} ${text}`;
    const headingId = paragraph?.paragraphStyle?.headingId?.trim();
    return headingId ? `<a id="heading-${headingId}"></a>\n${headingLine}` : headingLine;
  }
  return text;
}

function normalizeTableCell(
  cell: GoogleDocsTableCell | undefined,
  lists: Record<string, GoogleDocsList> | undefined,
): string {
  const blocks = normalizeStructuralElements(cell?.content ?? [], lists);
  return blocks
    .map((block) => block.replace(/\n/g, ' <br> '))
    .join(' / ')
    .replace(/\|/g, '\\|')
    .trim();
}

function markdownTableDivider(columnCount: number): string {
  return `| ${Array.from({ length: columnCount }, () => '---').join(' | ')} |`;
}

function normalizeTable(table: GoogleDocsTable | undefined, lists: Record<string, GoogleDocsList> | undefined): string[] {
  const rows = table?.tableRows ?? [];
  const normalizedRows = rows
    .map((row) => (row.tableCells ?? []).map((cell) => normalizeTableCell(cell, lists)))
    .filter((cells) => cells.length > 0);
  if (normalizedRows.length === 0) {
    return [];
  }
  const columnCount = Math.max(...normalizedRows.map((cells) => cells.length));
  const paddedRows = normalizedRows.map((cells) =>
    Array.from({ length: columnCount }, (_, index) => cells[index] ?? ''),
  );
  const [header, ...body] = paddedRows;
  const blocks = [`| ${header.join(' | ')} |`, markdownTableDivider(columnCount)];
  for (const row of body) {
    blocks.push(`| ${row.join(' | ')} |`);
  }
  return [blocks.join('\n')];
}

function normalizeStructuralElements(
  elements: GoogleDocsStructuralElement[],
  lists: Record<string, GoogleDocsList> | undefined,
): string[] {
  const blocks: string[] = [];
  for (const element of elements) {
    const line = paragraphToMarkdown(element.paragraph, lists);
    if (line) {
      blocks.push(line);
      continue;
    }
    if (element.table) {
      blocks.push(...normalizeTable(element.table, lists));
    }
  }
  return blocks;
}

function headerFooterRoleMap(
  label: 'Headers' | 'Footers',
  documentStyle: GoogleDocsDocumentStyle | undefined,
): Map<string, string> {
  const roleMap = new Map<string, string>();
  const roleEntries =
    label === 'Headers'
      ? [
          [documentStyle?.defaultHeaderId, 'Default Header'],
          [documentStyle?.firstPageHeaderId, 'First Page Header'],
          [documentStyle?.evenPageHeaderId, 'Even Page Header'],
        ]
      : [
          [documentStyle?.defaultFooterId, 'Default Footer'],
          [documentStyle?.firstPageFooterId, 'First Page Footer'],
          [documentStyle?.evenPageFooterId, 'Even Page Footer'],
        ];
  for (const [id, role] of roleEntries) {
    const normalizedId = id?.trim();
    if (!normalizedId || roleMap.has(normalizedId)) {
      continue;
    }
    roleMap.set(normalizedId, role ?? normalizedId);
  }
  return roleMap;
}

function normalizeHeaderFooterMap(
  label: 'Headers' | 'Footers',
  entries: Record<string, GoogleDocsHeaderFooter> | undefined,
  lists: Record<string, GoogleDocsList> | undefined,
  documentStyle: GoogleDocsDocumentStyle | undefined,
): string | null {
  if (!entries) {
    return null;
  }
  const ids = Object.keys(entries).sort();
  const roles = headerFooterRoleMap(label, documentStyle);
  const sections: string[] = [];
  for (const id of ids) {
    const blocks = normalizeStructuralElements(entries[id]?.content ?? [], lists);
    if (blocks.length === 0) {
      continue;
    }
    const title = roles.get(id) ?? `${label.slice(0, -1)} ${escapeMarkdownText(id)}`;
    sections.push(`### ${title}\n\n${blocks.join('\n\n').trim()}`);
  }
  if (sections.length === 0) {
    return null;
  }
  return `## ${label}\n\n${sections.join('\n\n').trim()}`;
}

function joinNonEmptySections(sections: Array<string | null>): string | null {
  const nonEmpty = sections.filter((section): section is string => Boolean(section?.trim()));
  if (nonEmpty.length === 0) {
    return null;
  }
  return nonEmpty.join('\n\n').trim();
}

function flattenGoogleDocsTabs(tabs: GoogleDocsTab[] | undefined): GoogleDocsTab[] {
  if (!tabs?.length) {
    return [];
  }
  const flattened: GoogleDocsTab[] = [];
  for (const tab of tabs) {
    flattened.push(tab);
    flattened.push(...flattenGoogleDocsTabs(tab.childTabs));
  }
  return flattened;
}

function normalizeTab(tab: GoogleDocsTab, fallbackLists: Record<string, GoogleDocsList> | undefined): string | null {
  const lists = tab.documentTab?.lists ?? fallbackLists;
  const headerSection = normalizeHeaderFooterMap(
    'Headers',
    tab.documentTab?.headers,
    lists,
    tab.documentTab?.documentStyle,
  );
  const bodySection = normalizeStructuralElements(tab.documentTab?.body?.content ?? [], lists).join('\n\n').trim();
  const footerSection = normalizeHeaderFooterMap(
    'Footers',
    tab.documentTab?.footers,
    lists,
    tab.documentTab?.documentStyle,
  );
  const content = joinNonEmptySections([headerSection, bodySection, footerSection]);
  if (!content) {
    return null;
  }
  const title = tab.tabProperties?.title?.trim();
  if (!title) {
    return content;
  }
  return [`# ${escapeMarkdownText(title)}`, content].join('\n\n').trim();
}

export function normalizeGoogleDocToMarkdown(document: GoogleDocsDocument): string {
  const normalizedTabs = flattenGoogleDocsTabs(document.tabs)
    .map((tab) => normalizeTab(tab, document.lists))
    .filter((tab): tab is string => Boolean(tab));
  if (normalizedTabs.length > 0) {
    return normalizedTabs.join('\n\n').trim();
  }
  const bodySection = normalizeStructuralElements(document.body?.content ?? [], document.lists).join('\n\n').trim();
  return (
    joinNonEmptySections([
      normalizeHeaderFooterMap('Headers', document.headers, document.lists, document.documentStyle),
      bodySection,
      normalizeHeaderFooterMap('Footers', document.footers, document.lists, document.documentStyle),
    ]) ?? ''
  );
}
