import { source } from "@/lib/source";
import {
  DocsPage,
  DocsBody,
  DocsTitle,
  DocsDescription,
} from "fumadocs-ui/page";
import { notFound, redirect } from "next/navigation";
import defaultMdxComponents from "fumadocs-ui/mdx";
import { CodeBlock } from "@/components/code-block";
import {
  DocsPageFooter,
  DocsPageFooterProvider,
} from "@/components/docs-page-footer";
import { readDocsPageMarkdownFile } from "@/lib/docs-markdown";
import { absoluteUrl } from "@/lib/llm-docs";
import { relative } from "node:path";

const docsIndexPath = "/docs/getting-started/introduction";
const docsIndexSlug = ["getting-started", "introduction"] as const;

function isDocsIndex(slug: string[] | undefined) {
  return slug === undefined || slug.length === 0 || slug.join("/") === "";
}

function isHeroPage(slug: string[] | undefined) {
  return slug?.join("/") === "getting-started/introduction";
}

function toRepositoryPath(sourcePath: string) {
  return `docs-site/${relative(process.cwd(), sourcePath).replaceAll("\\", "/")}`;
}

function buildSourceEditUrl(sourcePath: string) {
  return `https://github.com/Kaelio/ktx/edit/main/${toRepositoryPath(sourcePath)}`;
}

function buildIssueUrl(pageTitle: string, sourcePath: string, pageUrl: string) {
  const title = `[docs] ${pageTitle}`;
  const repositoryPath = toRepositoryPath(sourcePath);

  const params = new URLSearchParams({
    template: "docs_feedback.yml",
    title,
    page: pageUrl,
    source: repositoryPath,
  });

  return `https://github.com/Kaelio/ktx/issues/new?${params.toString()}`;
}

export default async function Page(props: {
  params: Promise<{ slug?: string[] }>;
}) {
  const params = await props.params;
  if (isDocsIndex(params.slug)) {
    redirect(docsIndexPath);
  }

  const page = source.getPage(params.slug);
  if (!page) notFound();

  const MDX = page.data.body;
  const { content: mdxSource, path: sourcePath } =
    await readDocsPageMarkdownFile(page.slugs);
  const pageUrl = absoluteUrl(page.url);
  const hero = isHeroPage(params.slug);

  return (
    <DocsPageFooterProvider
      actions={{
        mdxSource,
        sourceEditUrl: buildSourceEditUrl(sourcePath),
        issueUrl: buildIssueUrl(page.data.title, sourcePath, pageUrl),
      }}
    >
      <DocsPage
        toc={page.data.toc}
        className="!mx-0 min-w-0 justify-self-start md:!mx-auto"
        slots={{ footer: DocsPageFooter }}
        style={{
          width: "calc(100vw - 2rem)",
          maxWidth: "900px",
        }}
      >
        {!hero && (
          <>
            <DocsTitle>{page.data.title}</DocsTitle>
            <DocsDescription className="wrap-anywhere">
              {page.data.description}
            </DocsDescription>
          </>
        )}
        <DocsBody className="min-w-0 max-w-full wrap-anywhere">
          <MDX components={{ ...defaultMdxComponents, pre: CodeBlock }} />
        </DocsBody>
      </DocsPage>
    </DocsPageFooterProvider>
  );
}

export function generateStaticParams() {
  return [{ slug: [""] }, ...source.generateParams()];
}

export async function generateMetadata(props: {
  params: Promise<{ slug?: string[] }>;
}) {
  const params = await props.params;
  const page = source.getPage(
    isDocsIndex(params.slug) ? [...docsIndexSlug] : params.slug,
  );
  if (!page) notFound();

  return {
    title: page.data.title,
    description: page.data.description,
  };
}
