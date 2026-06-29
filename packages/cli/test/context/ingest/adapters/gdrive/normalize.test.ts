import { describe, expect, it } from 'vitest';
import { normalizeGoogleDocToMarkdown } from '../../../../../src/context/ingest/adapters/gdrive/normalize.js';

describe('normalizeGoogleDocToMarkdown', () => {
  it('maps title, subtitle, and heading named styles to markdown headings', () => {
    const markdown = normalizeGoogleDocToMarkdown({
      title: 'Executive Brief',
      body: {
        content: [
          {
            paragraph: {
              paragraphStyle: { namedStyleType: 'TITLE', headingId: 'title-anchor' },
              elements: [{ textRun: { content: 'Executive Brief' } }],
            },
          },
          {
            paragraph: {
              paragraphStyle: { namedStyleType: 'SUBTITLE' },
              elements: [{ textRun: { content: 'Q3 Planning' } }],
            },
          },
          {
            paragraph: {
              paragraphStyle: { namedStyleType: 'HEADING_1' },
              elements: [{ textRun: { content: 'Overview' } }],
            },
          },
          {
            paragraph: {
              paragraphStyle: { namedStyleType: 'HEADING_3' },
              elements: [{ textRun: { content: 'Risks' } }],
            },
          },
          {
            paragraph: {
              elements: [{ textRun: { content: 'Plain paragraph text.' } }],
            },
          },
        ],
      },
    });

    expect(markdown).toContain('<a id="heading-title-anchor"></a>\n# Executive Brief');
    expect(markdown).toContain('## Q3 Planning');
    expect(markdown).toContain('# Overview');
    expect(markdown).toContain('### Risks');
    expect(markdown).toContain('Plain paragraph text.');
  });

  it('converts headings, lists, links, and inline formatting', () => {
    const markdown = normalizeGoogleDocToMarkdown({
      title: 'Ops Handbook',
      body: {
        content: [
          {
            paragraph: {
              paragraphStyle: { namedStyleType: 'HEADING_1' },
              elements: [{ textRun: { content: 'Policy' } }],
            },
          },
          {
            paragraph: {
              elements: [
                { textRun: { content: 'Use ' } },
                { textRun: { content: 'documented', textStyle: { bold: true } } },
                { textRun: { content: ' rules.' } },
              ],
            },
          },
          {
            paragraph: {
              bullet: { nestingLevel: 0 },
              elements: [{ textRun: { content: 'First item' } }],
            },
          },
          {
            paragraph: {
              bullet: { nestingLevel: 1 },
              elements: [{ textRun: { content: 'Nested item' } }],
            },
          },
          {
            paragraph: {
              elements: [
                {
                  textRun: {
                    content: 'Reference',
                    textStyle: { link: { url: 'https://example.com/docs)' }, italic: true },
                  },
                },
              ],
            },
          },
        ],
      },
    });

    expect(markdown).toContain('# Policy');
    expect(markdown).toContain('Use **documented** rules.');
    expect(markdown).toContain('- First item');
    expect(markdown).toContain('  - Nested item');
    expect(markdown).toContain('[*Reference*](https://example.com/docs\\))');
  });

  it('resolves ordered and unordered lists from document list metadata', () => {
    const markdown = normalizeGoogleDocToMarkdown({
      title: 'Decision Log',
      lists: {
        unordered: {
          listProperties: {
            nestingLevels: [{ glyphType: 'BULLET' }, { glyphType: 'BULLET' }],
          },
        },
        ordered: {
          listProperties: {
            nestingLevels: [{ glyphType: 'DECIMAL' }, { glyphType: 'UPPER_ALPHA' }],
          },
        },
      },
      body: {
        content: [
          {
            paragraph: {
              bullet: { listId: 'unordered', nestingLevel: 0 },
              elements: [{ textRun: { content: 'Top-level bullet' } }],
            },
          },
          {
            paragraph: {
              bullet: { listId: 'ordered', nestingLevel: 0 },
              elements: [{ textRun: { content: 'Top-level ordered item' } }],
            },
          },
          {
            paragraph: {
              bullet: { listId: 'ordered', nestingLevel: 1 },
              elements: [{ textRun: { content: 'Nested ordered item' } }],
            },
          },
        ],
      },
    });

    expect(markdown).toContain('- Top-level bullet');
    expect(markdown).toContain('1. Top-level ordered item');
    expect(markdown).toContain('  1. Nested ordered item');
  });

  it('falls back to unordered markers when list metadata is missing', () => {
    const markdown = normalizeGoogleDocToMarkdown({
      title: 'Fallback Lists',
      body: {
        content: [
          {
            paragraph: {
              bullet: { listId: 'missing-list', nestingLevel: 0 },
              elements: [{ textRun: { content: 'Still preserved' } }],
            },
          },
        ],
      },
    });

    expect(markdown).toContain('- Still preserved');
  });

  it('preserves table content instead of dropping it silently', () => {
    const markdown = normalizeGoogleDocToMarkdown({
      title: 'Ownership Matrix',
      body: {
        content: [
          {
            paragraph: {
              paragraphStyle: { namedStyleType: 'HEADING_2' },
              elements: [{ textRun: { content: 'Decisions' } }],
            },
          },
          {
            table: {
              tableRows: [
                {
                  tableCells: [
                    {
                      content: [{ paragraph: { elements: [{ textRun: { content: 'Decision' } }] } }],
                    },
                    {
                      content: [{ paragraph: { elements: [{ textRun: { content: 'Owner' } }] } }],
                    },
                  ],
                },
                {
                  tableCells: [
                    {
                      content: [{ paragraph: { elements: [{ textRun: { content: 'Escalation path' } }] } }],
                    },
                    {
                      content: [{ paragraph: { elements: [{ textRun: { content: 'Platform Ops' } }] } }],
                    },
                  ],
                },
              ],
            },
          },
        ],
      },
    });

    expect(markdown).toContain('## Decisions');
    expect(markdown).toContain('| Decision | Owner |');
    expect(markdown).toContain('| --- | --- |');
    expect(markdown).toContain('| Escalation path | Platform Ops |');
  });

  it('flattens multi-block table cells into stable markdown text', () => {
    const markdown = normalizeGoogleDocToMarkdown({
      title: 'Checklist',
      body: {
        content: [
          {
            table: {
              tableRows: [
                {
                  tableCells: [
                    {
                      content: [
                        { paragraph: { elements: [{ textRun: { content: 'Action items' } }] } },
                        { paragraph: { bullet: { nestingLevel: 0 }, elements: [{ textRun: { content: 'Review runbook' } }] } },
                      ],
                    },
                    {
                      content: [
                        {
                          paragraph: {
                            elements: [
                              {
                                textRun: {
                                  content: 'https://example.com/ops',
                                  textStyle: { link: { url: 'https://example.com/ops' } },
                                },
                              },
                            ],
                          },
                        },
                      ],
                    },
                  ],
                },
              ],
            },
          },
        ],
      },
    });

    expect(markdown).toContain(
      '| Action items / - Review runbook | [https://example.com/ops](https://example.com/ops) |',
    );
  });

  it('preserves empty table cells and mixed inline elements', () => {
    const markdown = normalizeGoogleDocToMarkdown({
      title: 'Runbook Matrix',
      body: {
        content: [
          {
            table: {
              tableRows: [
                {
                  tableCells: [
                    {
                      content: [{ paragraph: { elements: [{ textRun: { content: 'Step' } }] } }],
                    },
                    {
                      content: [{ paragraph: { elements: [{ textRun: { content: 'Notes' } }] } }],
                    },
                  ],
                },
                {
                  tableCells: [
                    {
                      content: [
                        {
                          paragraph: {
                            elements: [
                              { textRun: { content: 'Deploy', textStyle: { underline: true } } },
                              { textRun: { content: ' artifact' } },
                              { inlineObjectElement: {} },
                            ],
                          },
                        },
                      ],
                    },
                    {
                      content: [{ paragraph: { elements: [] } }],
                    },
                  ],
                },
              ],
            },
          },
          {
            paragraph: {
              elements: [{ pageBreak: {} }],
            },
          },
          {
            paragraph: {
              elements: [{ textRun: { content: 'Appendix' } }],
            },
          },
        ],
      },
    });

    expect(markdown).toContain('| Step | Notes |');
    expect(markdown).toContain('| <u>Deploy</u> artifact[Embedded object] |  |');
    expect(markdown).toContain('---');
    expect(markdown).toContain('Appendix');
  });

  it('emits working heading anchors for legacy and tab-aware internal heading links', () => {
    const markdown = normalizeGoogleDocToMarkdown({
      title: 'Internal Links',
      body: {
        content: [
          {
            paragraph: {
              elements: [
                {
                  textRun: {
                    content: 'Jump to Overview',
                    textStyle: { link: { headingId: 'overview-heading' } },
                  },
                },
              ],
            },
          },
          {
            paragraph: {
              bullet: { nestingLevel: 0 },
              elements: [
                {
                  textRun: {
                    content: 'Linked list item',
                    textStyle: { link: { heading: { id: 'overview-heading', tabId: 'tab-1' } } },
                  },
                },
              ],
            },
          },
          {
            paragraph: {
              paragraphStyle: { namedStyleType: 'HEADING_2', headingId: 'overview-heading' },
              elements: [{ textRun: { content: 'Overview' } }],
            },
          },
        ],
      },
    });

    expect(markdown).toContain('[Jump to Overview](#heading-overview-heading)');
    expect(markdown).toContain('- [Linked list item](#heading-overview-heading)');
    expect(markdown).toContain('<a id="heading-overview-heading"></a>\n## Overview');
  });

  it('preserves bookmark links even when bookmark targets are unresolved', () => {
    const markdown = normalizeGoogleDocToMarkdown({
      title: 'Bookmarks',
      body: {
        content: [
          {
            paragraph: {
              elements: [
                {
                  textRun: {
                    content: 'Jump to bookmark',
                    textStyle: { link: { bookmarkId: 'bookmark-1' } },
                  },
                },
              ],
            },
          },
          {
            table: {
              tableRows: [
                {
                  tableCells: [
                    {
                      content: [
                        {
                          paragraph: {
                            elements: [
                              {
                                textRun: {
                                  content: 'Bookmark in table',
                                  textStyle: { link: { bookmark: { id: 'bookmark-2', tabId: 'tab-1' } } },
                                },
                              },
                            ],
                          },
                        },
                      ],
                    },
                  ],
                },
              ],
            },
          },
        ],
      },
    });

    expect(markdown).toContain('[Jump to bookmark](#bookmark-bookmark-1)');
    expect(markdown).toContain('| [Bookmark in table](#bookmark-bookmark-2) |');
  });

  it('falls back to legacy document.body content when tabs are absent', () => {
    const markdown = normalizeGoogleDocToMarkdown({
      title: 'Legacy Doc',
      body: {
        content: [
          {
            paragraph: {
              elements: [{ textRun: { content: 'Legacy body text.' } }],
            },
          },
        ],
      },
    });

    expect(markdown).toBe('Legacy body text.');
  });

  it('normalizes multi-tab documents in display order with tab headings', () => {
    const markdown = normalizeGoogleDocToMarkdown({
      title: 'Tabbed Doc',
      tabs: [
        {
          tabProperties: { tabId: 'tab-1', title: 'Overview' },
          documentTab: {
            body: {
              content: [
                {
                  paragraph: {
                    elements: [{ textRun: { content: 'Overview text.' } }],
                  },
                },
              ],
            },
          },
        },
        {
          tabProperties: { tabId: 'tab-2', title: 'Appendix' },
          documentTab: {
            body: {
              content: [
                {
                  paragraph: {
                    elements: [{ textRun: { content: 'Appendix text.' } }],
                  },
                },
              ],
            },
          },
        },
      ],
      body: {
        content: [
          {
            paragraph: {
              elements: [{ textRun: { content: 'Legacy content should not win.' } }],
            },
          },
        ],
      },
    });

    expect(markdown).toBe('# Overview\n\nOverview text.\n\n# Appendix\n\nAppendix text.');
  });

  it('walks nested child tabs and uses tab-local list metadata', () => {
    const markdown = normalizeGoogleDocToMarkdown({
      title: 'Nested Tabs',
      tabs: [
        {
          tabProperties: { tabId: 'parent', title: 'Parent Tab' },
          documentTab: {
            body: {
              content: [
                {
                  paragraph: {
                    elements: [{ textRun: { content: 'Parent content.' } }],
                  },
                },
              ],
            },
          },
          childTabs: [
            {
              tabProperties: { tabId: 'child', title: 'Child Tab' },
              documentTab: {
                lists: {
                  childList: {
                    listProperties: {
                      nestingLevels: [{ glyphType: 'DECIMAL' }],
                    },
                  },
                },
                body: {
                  content: [
                    {
                      paragraph: {
                        bullet: { listId: 'childList', nestingLevel: 0 },
                        elements: [{ textRun: { content: 'Nested ordered item' } }],
                      },
                    },
                  ],
                },
              },
            },
          ],
        },
      ],
    });

    expect(markdown).toBe('# Parent Tab\n\nParent content.\n\n# Child Tab\n\n1. Nested ordered item');
  });

  it('includes legacy document headers and footers as labeled sections', () => {
    const markdown = normalizeGoogleDocToMarkdown({
      title: 'Header Footer Doc',
      documentStyle: {
        defaultHeaderId: 'headerA',
        firstPageFooterId: 'footerA',
      },
      headers: {
        headerA: {
          headerId: 'headerA',
          content: [
            {
              paragraph: {
                elements: [{ textRun: { content: 'Company Confidential' } }],
              },
            },
          ],
        },
      },
      footers: {
        footerA: {
          footerId: 'footerA',
          content: [
            {
              paragraph: {
                elements: [{ textRun: { content: 'Page 1' } }],
              },
            },
          ],
        },
      },
      body: {
        content: [
          {
            paragraph: {
              elements: [{ textRun: { content: 'Body content.' } }],
            },
          },
        ],
      },
    });

    expect(markdown).toBe(
      '## Headers\n\n### Default Header\n\nCompany Confidential\n\nBody content.\n\n## Footers\n\n### First Page Footer\n\nPage 1',
    );
  });

  it('includes tab-specific headers and footers around tab body content with role-aware labels and id fallback', () => {
    const markdown = normalizeGoogleDocToMarkdown({
      title: 'Tabbed Header Footer Doc',
      tabs: [
        {
          tabProperties: { tabId: 'tab-1', title: 'Overview' },
          documentTab: {
            documentStyle: {
              evenPageHeaderId: 'overviewHeader',
            },
            headers: {
              overviewHeader: {
                headerId: 'overviewHeader',
                content: [
                  {
                    paragraph: {
                      elements: [{ textRun: { content: 'Overview Header' } }],
                    },
                  },
                ],
              },
            },
            body: {
              content: [
                {
                  paragraph: {
                    elements: [{ textRun: { content: 'Overview body.' } }],
                  },
                },
              ],
            },
            footers: {
              overviewFooter: {
                footerId: 'overviewFooter',
                content: [
                  {
                    paragraph: {
                      elements: [{ textRun: { content: 'Overview Footer' } }],
                    },
                  },
                ],
              },
            },
          },
        },
      ],
    });

    expect(markdown).toBe(
      '# Overview\n\n## Headers\n\n### Even Page Header\n\nOverview Header\n\nOverview body.\n\n## Footers\n\n### Footer overviewFooter\n\nOverview Footer',
    );
  });
});
