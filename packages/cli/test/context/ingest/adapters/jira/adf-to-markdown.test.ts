import { describe, expect, it } from 'vitest';
import { adfToMarkdown } from '../../../../../src/context/ingest/adapters/jira/adf-to-markdown.js';

describe('adfToMarkdown', () => {
  it('returns empty string for null/undefined input', () => {
    expect(adfToMarkdown(null)).toBe('');
    expect(adfToMarkdown(undefined)).toBe('');
  });

  it('converts a simple paragraph', () => {
    const adf = {
      type: 'doc',
      content: [{ type: 'paragraph', content: [{ type: 'text', text: 'Hello world' }] }],
    };
    expect(adfToMarkdown(adf)).toBe('Hello world');
  });

  it('converts bold and italic marks', () => {
    const adf = {
      type: 'doc',
      content: [
        {
          type: 'paragraph',
          content: [
            { type: 'text', text: 'bold', marks: [{ type: 'strong' }] },
            { type: 'text', text: ' and ' },
            { type: 'text', text: 'italic', marks: [{ type: 'em' }] },
          ],
        },
      ],
    };
    expect(adfToMarkdown(adf)).toBe('**bold** and _italic_');
  });

  it('converts inline code mark', () => {
    const adf = {
      type: 'doc',
      content: [
        {
          type: 'paragraph',
          content: [{ type: 'text', text: 'SELECT 1', marks: [{ type: 'code' }] }],
        },
      ],
    };
    expect(adfToMarkdown(adf)).toBe('`SELECT 1`');
  });

  it('converts a link mark', () => {
    const adf = {
      type: 'doc',
      content: [
        {
          type: 'paragraph',
          content: [{ type: 'text', text: 'click here', marks: [{ type: 'link', attrs: { href: 'https://example.com' } }] }],
        },
      ],
    };
    expect(adfToMarkdown(adf)).toBe('[click here](https://example.com)');
  });

  it('converts headings', () => {
    const adf = {
      type: 'doc',
      content: [
        { type: 'heading', attrs: { level: 1 }, content: [{ type: 'text', text: 'Title' }] },
        { type: 'heading', attrs: { level: 2 }, content: [{ type: 'text', text: 'Subtitle' }] },
      ],
    };
    expect(adfToMarkdown(adf)).toBe('# Title\n\n## Subtitle');
  });

  it('converts a bullet list', () => {
    const adf = {
      type: 'doc',
      content: [
        {
          type: 'bulletList',
          content: [
            { type: 'listItem', content: [{ type: 'paragraph', content: [{ type: 'text', text: 'Alpha' }] }] },
            { type: 'listItem', content: [{ type: 'paragraph', content: [{ type: 'text', text: 'Beta' }] }] },
          ],
        },
      ],
    };
    const result = adfToMarkdown(adf);
    expect(result).toContain('- Alpha');
    expect(result).toContain('- Beta');
  });

  it('converts a code block', () => {
    const adf = {
      type: 'doc',
      content: [
        { type: 'codeBlock', attrs: { language: 'sql' }, content: [{ type: 'text', text: 'SELECT 1' }] },
      ],
    };
    expect(adfToMarkdown(adf)).toContain('```sql\nSELECT 1\n```');
  });

  it('converts a horizontal rule', () => {
    const adf = {
      type: 'doc',
      content: [
        { type: 'paragraph', content: [{ type: 'text', text: 'before' }] },
        { type: 'rule' },
        { type: 'paragraph', content: [{ type: 'text', text: 'after' }] },
      ],
    };
    expect(adfToMarkdown(adf)).toContain('---');
  });

  it('handles a real ADF description with mixed content', () => {
    const adf = {
      type: 'doc',
      version: 1,
      content: [
        {
          type: 'heading',
          attrs: { level: 2 },
          content: [{ type: 'text', text: 'Definition' }],
        },
        {
          type: 'paragraph',
          content: [
            { type: 'text', text: 'ARR is ' },
            { type: 'text', text: 'Annual Recurring Revenue', marks: [{ type: 'strong' }] },
            { type: 'text', text: ', calculated monthly.' },
          ],
        },
      ],
    };
    const result = adfToMarkdown(adf);
    expect(result).toContain('## Definition');
    expect(result).toContain('**Annual Recurring Revenue**');
  });
});
