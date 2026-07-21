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
import { DocsPageActions } from "@/components/docs-page-actions";

const docsIndexPath = "/docs/getting-started/introduction";
const docsIndexSlug = ["getting-started", "introduction"] as const;

function isDocsIndex(slug: string[] | undefined) {
  return slug === undefined || slug.length === 0 || slug.join("/") === "";
}

function isHeroPage(slug: string[] | undefined) {
  return slug?.join("/") === "getting-started/introduction";
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

  const hero = isHeroPage(params.slug);

  return (
    <DocsPage
      toc={page.data.toc}
      className="!mx-0 min-w-0 justify-self-start md:!mx-auto"
      style={{
        width: "calc(100vw - 2rem)",
        maxWidth: "900px",
      }}
    >
      {!hero && (
        <>
          <div className="flex flex-col gap-3 sm:flex-row sm:items-start sm:justify-between sm:gap-4">
            <DocsTitle>{page.data.title}</DocsTitle>
            <DocsPageActions
              title={page.data.title}
              markdownHref={`${page.url}.md`}
            />
          </div>
          <DocsDescription className="wrap-anywhere">
            {page.data.description}
          </DocsDescription>
        </>
      )}
      {hero && (
        <div className="flex justify-end">
          <DocsPageActions
            title={page.data.title}
            markdownHref={`${page.url}.md`}
          />
        </div>
      )}
      <DocsBody className="min-w-0 max-w-full wrap-anywhere">
        <MDX components={{ ...defaultMdxComponents, pre: CodeBlock }} />
      </DocsBody>
    </DocsPage>
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
