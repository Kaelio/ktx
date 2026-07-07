import { extname } from 'node:path';
import { convertDocxToMarkdown } from './docx-markdown.js';

function normalizeMarkdownText(value: string): string {
  const normalized = value.replace(/\r\n/g, '\n').replace(/\r/g, '\n').trimEnd();
  return normalized.length > 0 ? `${normalized}\n` : '';
}

export function normalizeSharepointFileToMarkdown(fileName: string, content: Buffer | string, title: string): string {
  const extension = extname(fileName).toLowerCase();
  if (extension === '.md') {
    return normalizeMarkdownText(typeof content === 'string' ? content : content.toString('utf-8'));
  }
  const converted = convertDocxToMarkdown(Buffer.isBuffer(content) ? content : Buffer.from(content, 'utf-8')).trim();
  if (!converted) {
    return `# ${title}\n`;
  }
  return /^#\s+/m.test(converted) ? `${converted}\n` : `# ${title}\n\n${converted}\n`;
}
