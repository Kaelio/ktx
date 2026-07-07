import { unzipSync, strFromU8 } from 'fflate';

interface NumberingLevel {
  format: 'bullet' | 'decimal';
}

function decodeXmlText(value: string): string {
  return value
    .replace(/&amp;/g, '&')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&apos;/g, "'");
}

function normalizeWhitespace(value: string): string {
  return value.replace(/\r/g, '').replace(/[ \t]+\n/g, '\n').replace(/\n{3,}/g, '\n\n').trim();
}

function escapeMarkdownCell(value: string): string {
  return value.replace(/\|/g, '\\|').replace(/\r?\n/g, ' ').trim();
}

function textFromRun(runXml: string): string {
  if (/<w:tab(?:\s|\/>)/.test(runXml)) {
    return '\t';
  }
  if (/<w:br(?:\s|\/>)/.test(runXml) || /<w:cr(?:\s|\/>)/.test(runXml)) {
    return '\n';
  }
  const text = [...runXml.matchAll(/<w:t\b[^>]*>([\s\S]*?)<\/w:t>/g)].map((match) => decodeXmlText(match[1])).join('');
  if (!text) {
    return '';
  }
  const bold = /<w:b(?:\s|\/>)/.test(runXml);
  const italic = /<w:i(?:\s|\/>)/.test(runXml);
  let value = text;
  if (bold) value = `**${value}**`;
  if (italic) value = `_${value}_`;
  return value;
}

function paragraphText(paragraphXml: string): string {
  return normalizeWhitespace(
    [...paragraphXml.matchAll(/<w:r\b[\s\S]*?<\/w:r>/g)]
      .map((match) => textFromRun(match[0]))
      .join('')
      .replace(/\t/g, ' ')
      .replace(/[ ]{2,}/g, ' '),
  );
}

function parseNumbering(documentXml: string): Map<string, NumberingLevel> {
  const abstractFormats = new Map<string, Map<number, NumberingLevel['format']>>();
  for (const abstractMatch of documentXml.matchAll(/<w:abstractNum\b[\s\S]*?w:abstractNumId="(\d+)"[\s\S]*?<\/w:abstractNum>/g)) {
    const levels = new Map<number, NumberingLevel['format']>();
    for (const lvlMatch of abstractMatch[0].matchAll(/<w:lvl\b[\s\S]*?w:ilvl="(\d+)"[\s\S]*?<w:numFmt\b[^>]*w:val="([^"]+)"[^>]*\/?>[\s\S]*?<\/w:lvl>/g)) {
      levels.set(Number.parseInt(lvlMatch[1], 10), lvlMatch[2] === 'bullet' ? 'bullet' : 'decimal');
    }
    abstractFormats.set(abstractMatch[1], levels);
  }

  const resolved = new Map<string, NumberingLevel>();
  for (const numMatch of documentXml.matchAll(/<w:num\b[\s\S]*?w:numId="(\d+)"[\s\S]*?<w:abstractNumId\b[^>]*w:val="(\d+)"[^>]*\/?>[\s\S]*?<\/w:num>/g)) {
    const formats = abstractFormats.get(numMatch[2]) ?? new Map<number, NumberingLevel['format']>();
    for (const [level, format] of formats) {
      resolved.set(`${numMatch[1]}:${level}`, { format });
    }
  }
  return resolved;
}

function paragraphStyle(paragraphXml: string): string | null {
  return paragraphXml.match(/<w:pStyle\b[^>]*w:val="([^"]+)"/)?.[1] ?? null;
}

function paragraphListInfo(paragraphXml: string): { numId: string; level: number } | null {
  const numId = paragraphXml.match(/<w:numId\b[^>]*w:val="(\d+)"/)?.[1];
  if (!numId) {
    return null;
  }
  return { numId, level: Number.parseInt(paragraphXml.match(/<w:ilvl\b[^>]*w:val="(\d+)"/)?.[1] ?? '0', 10) };
}

function renderTable(tableXml: string): string {
  const rows = [...tableXml.matchAll(/<w:tr\b[\s\S]*?<\/w:tr>/g)].map((rowMatch) =>
    [...rowMatch[0].matchAll(/<w:tc\b[\s\S]*?<\/w:tc>/g)].map((cellMatch) => {
      const cellParagraphs = [...cellMatch[0].matchAll(/<w:p\b[\s\S]*?<\/w:p>/g)]
        .map((match) => paragraphText(match[0]))
        .filter(Boolean);
      return escapeMarkdownCell(cellParagraphs.join(' '));
    }),
  );
  if (rows.length === 0) {
    return '';
  }
  const columnCount = Math.max(...rows.map((row) => row.length), 1);
  const normalized = rows.map((row) => [...row, ...Array.from({ length: columnCount - row.length }, () => '')]);
  return [
    `| ${normalized[0].join(' | ')} |`,
    `| ${Array.from({ length: columnCount }, () => '---').join(' | ')} |`,
    ...normalized.slice(1).map((row) => `| ${row.join(' | ')} |`),
  ].join('\n');
}

export function convertDocxToMarkdown(buffer: Buffer): string {
  const archive = unzipSync(new Uint8Array(buffer));
  const documentXml = archive['word/document.xml'] ? strFromU8(archive['word/document.xml']) : '';
  const numberingXml = archive['word/numbering.xml'] ? strFromU8(archive['word/numbering.xml']) : '';
  if (!documentXml) {
    return '';
  }
  const numbering = parseNumbering(numberingXml);
  const bodyXml = documentXml.match(/<w:body\b[^>]*>([\s\S]*?)<\/w:body>/)?.[1] ?? documentXml;
  const blocks = [...bodyXml.matchAll(/<(w:p|w:tbl)\b[\s\S]*?<\/\1>/g)];
  const out: string[] = [];

  for (const block of blocks) {
    if (block[1] === 'w:tbl') {
      const table = renderTable(block[0]);
      if (table) out.push(table);
      continue;
    }

    const text = paragraphText(block[0]);
    if (!text) {
      continue;
    }
    const style = paragraphStyle(block[0]);
    const listInfo = paragraphListInfo(block[0]);
    if (style && /^Heading[1-6]$/i.test(style)) {
      out.push(`${'#'.repeat(Number.parseInt(style.replace(/^\D+/g, ''), 10))} ${text}`);
      continue;
    }
    if (style === 'Title') {
      out.push(`# ${text}`);
      continue;
    }
    if (listInfo) {
      const marker = numbering.get(`${listInfo.numId}:${listInfo.level}`)?.format === 'decimal' ? '1.' : '-';
      out.push(`${'  '.repeat(listInfo.level)}${marker} ${text}`);
      continue;
    }
    out.push(text);
  }

  return normalizeWhitespace(out.join('\n\n'));
}
