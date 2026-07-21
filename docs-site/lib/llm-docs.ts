import { source } from "@/lib/source";
import { readDocsPageMarkdown } from "@/lib/docs-markdown";

const siteOrigin = "https://docs.kaelio.com/ktx";

export type LlmDocsPage = {
  title: string;
  description?: string;
  url: string;
  markdownUrl: string;
  slug: string[];
  getMarkdown: () => Promise<string>;
};

export function getLlmDocsPages(): LlmDocsPage[] {
  return source.getPages().map(toLlmDocsPage);
}

export function getLlmDocsPage(slug: string[] | undefined) {
  const page = source.getPage(slug);
  return page ? toLlmDocsPage(page) : null;
}

export async function getPageMarkdown(page: LlmDocsPage) {
  const description = page.description ? `\n\n> ${page.description}` : "";
  const body = await page.getMarkdown();

  return normalizeMarkdown(`# ${page.title}${description}

Canonical URL: ${absoluteUrl(page.url)}
Markdown URL: ${absoluteUrl(page.markdownUrl)}

${body}
`);
}

export function buildLlmsTxt() {
  const pages = getLlmDocsPages();
  const byUrl = new Map(pages.map((page) => [page.url, page]));
  const link = (url: string, label: string, fallbackDescription: string) => {
    const page = byUrl.get(url);
    const description = page?.description ?? fallbackDescription;
    const markdownUrl = page?.markdownUrl ?? `${url}.md`;
    return `- [${label}](${absoluteUrl(markdownUrl)}): ${description}`;
  };

  return `# ktx

> Agent-native context layer for analytics engineering and data agents.

ktx provides semantic-layer files, warehouse scans, wiki pages, provenance, and agent-facing tools that help coding agents answer analytics questions without inventing metrics or joins.

## Agent Entry Points

- Installable setup skill: run \`npx skills add Kaelio/ktx --skill ktx\` from
  the project you want to configure.
${link("/docs/community/ai-resources", "AI Resources", "How coding agents read, cite, and act on the ktx docs")}

## Start Here

${link("/docs/getting-started/introduction", "Introduction", "What ktx is and who it is for")}
${link("/docs/getting-started/quickstart", "Quickstart", "Set up ktx and build your first context")}
${link("/docs/guides/writing-context", "Writing Context", "Write semantic sources and wiki pages")}

## Machine-Readable Documentation

- [Full documentation](${absoluteUrl("/llms-full.txt")}): All docs pages in one plain-text markdown response
- [AI Resources guide](${absoluteUrl("/docs/community/ai-resources.md")}): How agents fetch llms.txt, llms-full.txt, and per-page Markdown
- [Quickstart markdown](${absoluteUrl("/docs/getting-started/quickstart.md")}): Human setup walkthrough
- [Semantic-layer CLI markdown](${absoluteUrl("/docs/cli-reference/ktx-sl.md")}): Semantic-layer commands and JSON output
- [Wiki CLI markdown](${absoluteUrl("/docs/cli-reference/ktx-wiki.md")}): Wiki page commands and JSON output

## CLI Reference

${link("/docs/cli-reference/ktx", "ktx", "Root command map and global options")}
${link("/docs/cli-reference/ktx-setup", "ktx setup", "Interactive project setup")}
${link("/docs/cli-reference/ktx-sl", "ktx sl", "Semantic-layer commands")}
${link("/docs/cli-reference/ktx-wiki", "ktx wiki", "Wiki page commands")}
${link("/docs/cli-reference/ktx-connection", "ktx connection", "Connection management commands")}

## Integrations

${link("/docs/integrations/primary-sources", "Primary Sources", "Connect ktx to databases and warehouses")}
${link("/docs/integrations/context-sources", "Context Sources", "Ingest dbt, LookML, Metabase, Looker, MetricFlow, and Notion")}

## All Documentation

${buildPageIndex(pages)}
`;
}

export async function buildLlmsFullTxt() {
  const rendered = await Promise.all(getLlmDocsPages().map(getPageMarkdown));
  return [`# ktx Full Documentation`, `Source: ${siteOrigin}`, ...rendered].join(
    "\n\n---\n\n",
  );
}

function toLlmDocsPage(page: ReturnType<typeof source.getPages>[number]) {
  return {
    title: page.data.title,
    description: page.data.description,
    url: page.url,
    markdownUrl: `${page.url}.md`,
    slug: page.slugs,
    getMarkdown: async () => normalizeMarkdown(await readDocsPageMarkdown(page.slugs)),
  } satisfies LlmDocsPage;
}

function normalizeMarkdown(markdown: string) {
  return markdown
    .trim()
    .replace(/^---\n[\s\S]*?\n---\n?/, "")
    .trim()
    .replace(/\n{3,}/g, "\n\n");
}

function buildPageIndex(pages: LlmDocsPage[]) {
  const grouped = new Map<string, LlmDocsPage[]>();

  for (const page of pages) {
    const category = page.slug[0] ?? "general";
    grouped.set(category, [...(grouped.get(category) ?? []), page]);
  }

  return [...grouped.entries()]
    .map(([category, categoryPages]) => {
      const links = categoryPages
        .map((page) => {
          const description = page.description ? `: ${page.description}` : "";
          return `- [${page.title}](${absoluteUrl(page.markdownUrl)})${description}`;
        })
        .join("\n");

      return `### ${formatCategoryName(category)}

${links}`;
    })
    .join("\n\n");
}

export function absoluteUrl(path: string) {
  return `${siteOrigin}${path}`;
}

function formatCategoryName(category: string) {
  const labels: Record<string, string> = {
    "cli-reference": "CLI Reference",
    community: "Community & Resources",
  };

  if (labels[category]) {
    return labels[category];
  }

  return category
    .split("-")
    .map((word) => word.charAt(0).toUpperCase() + word.slice(1))
    .join(" ");
}
