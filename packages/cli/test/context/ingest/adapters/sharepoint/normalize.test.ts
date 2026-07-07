import { describe, expect, it } from 'vitest';
import { normalizeSharepointFileToMarkdown } from '../../../../../src/context/ingest/adapters/sharepoint/normalize.js';
import { createDocxBuffer } from './test-docx.js';

describe('normalizeSharepointFileToMarkdown', () => {
  it('passes markdown through with normalized newlines and one trailing newline', () => {
    expect(normalizeSharepointFileToMarkdown('ops.md', 'Line 1\r\nLine 2\r\n\r\n', 'Ops')).toBe('Line 1\nLine 2\n');
  });

  it('converts docx content into markdown with headings, lists, and tables', () => {
    const buffer = createDocxBuffer(`
      <w:p><w:pPr><w:pStyle w:val="Heading1"/></w:pPr><w:r><w:t>Ops Handbook</w:t></w:r></w:p>
      <w:p><w:pPr><w:numPr><w:ilvl w:val="0"/><w:numId w:val="1"/></w:numPr></w:pPr><w:r><w:t>First bullet</w:t></w:r></w:p>
      <w:p><w:pPr><w:numPr><w:ilvl w:val="0"/><w:numId w:val="2"/></w:numPr></w:pPr><w:r><w:t>First step</w:t></w:r></w:p>
      <w:tbl>
        <w:tr>
          <w:tc><w:p><w:r><w:t>Name</w:t></w:r></w:p></w:tc>
          <w:tc><w:p><w:r><w:t>Owner</w:t></w:r></w:p></w:tc>
        </w:tr>
        <w:tr>
          <w:tc><w:p><w:r><w:t>Ops</w:t></w:r></w:p></w:tc>
          <w:tc><w:p><w:r><w:t>Platform</w:t></w:r></w:p></w:tc>
        </w:tr>
      </w:tbl>
    `);

    const markdown = normalizeSharepointFileToMarkdown('ops.docx', buffer, 'Ops Handbook');
    expect(markdown).toContain('# Ops Handbook');
    expect(markdown).toContain('- First bullet');
    expect(markdown).toContain('1. First step');
    expect(markdown).toContain('| Name | Owner |');
    expect(markdown).toContain('| Ops | Platform |');
  });

  it('prepends an H1 when converted docx content has no heading', () => {
    const buffer = createDocxBuffer(`<w:p><w:r><w:t>Durable operating rules.</w:t></w:r></w:p>`);

    expect(normalizeSharepointFileToMarkdown('ops.docx', buffer, 'Ops Handbook')).toBe(
      '# Ops Handbook\n\nDurable operating rules.\n',
    );
  });
});
