import assert from "node:assert/strict";
import { access, readFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { test } from "node:test";
import { fileURLToPath } from "node:url";

const docsSiteDir = join(dirname(fileURLToPath(import.meta.url)), "..");

async function readDocsFile(path) {
  return readFile(join(docsSiteDir, path), "utf8");
}

test("root provider uses the base-path-aware search API", async () => {
  const layout = await readDocsFile("app/layout.tsx");

  assert.match(layout, /search=\{\{/);
  assert.match(layout, /api:\s*"\/ktx\/api\/search"/);
});

test("metadata icons include the docs base path", async () => {
  const layout = await readDocsFile("app/layout.tsx");

  assert.match(layout, /icon:\s*"\/ktx\/brand\/ktx-mascot\.svg"/);
  assert.match(layout, /shortcut:\s*"\/ktx\/brand\/ktx-mascot\.svg"/);
  assert.doesNotMatch(layout, /:\s*"\/brand\/ktx-mascot\.svg"/);
});

test("markdown negotiation uses the Next proxy convention", async () => {
  await assert.doesNotReject(access(join(docsSiteDir, "proxy.ts")));
  await assert.rejects(access(join(docsSiteDir, "middleware.ts")));

  const proxy = await readDocsFile("proxy.ts");
  assert.match(proxy, /export function proxy/);
  assert.doesNotMatch(proxy, /export function middleware/);
});

test("docs pages expose a canonical Markdown copy disclosure", async () => {
  const page = await readDocsFile("app/docs/[[...slug]]/page.tsx");
  const action = await readDocsFile("components/docs-page-actions.tsx");

  assert.match(page, /<DocsPageActions/);
  assert.match(page, /markdownHref=\{`\$\{page\.url\}\.md`\}/);
  assert.doesNotMatch(page, /contentId/);
  assert.doesNotMatch(page, /<DocsBody id=/);
  assert.match(action, /await fetch\(markdownHref/);
  assert.match(action, /await navigator\.clipboard\.writeText\(await response\.text\(\)\)/);
  assert.match(action, /Copy page as Markdown for LLMs/);
  assert.match(action, /View as Markdown/);
  assert.match(action, /Open in ChatGPT/);
  assert.match(action, /Open in Claude/);
  assert.doesNotMatch(action, /role="menu"/);
  assert.doesNotMatch(action, /role="menuitem"/);
  assert.doesNotMatch(action, /document\.getElementById/);
  assert.doesNotMatch(action, /mdxSource/);
  assert.doesNotMatch(action, /stripFrontmatter/);
  assert.doesNotMatch(action, /buildPageMarkdown/);
});

test("site background stacking does not target every body child", async () => {
  const css = await readDocsFile("app/global.css");

  assert.doesNotMatch(css, /body\s*>\s*\*\s*\{[^}]*z-index/s);
  assert.match(css, /\.ktx-site-shell\s*\{[^}]*z-index:\s*2/s);
});

test("search lock relies on body overflow propagation, not html or sidebar overrides", async () => {
  const css = await readDocsFile("app/global.css");

  // Body still clips horizontal overflow defensively.
  assert.match(css, /(^|\s)body\s*\{[^}]*overflow-x:\s*clip/s);

  // html must keep its default `visible` overflow so body's lock
  // (`overflow: hidden` from react-remove-scroll-bar) propagates to the
  // viewport. Locking html directly breaks `position: sticky` on the
  // sidebar placeholder.
  assert.doesNotMatch(css, /(^|\s)html\s*,?\s*\{[^}]*overflow(-y|\s*:)\s*(hidden|clip)/s);
  assert.doesNotMatch(
    css,
    /html:has\(body\[data-scroll-locked\]\)[^{]*\{[^}]*overflow:\s*(hidden|clip)/s,
  );

  // No site-specific overrides to body's data-scroll-locked overflow or
  // to the sidebar placeholder when locked.
  assert.doesNotMatch(
    css,
    /html\s+body\[data-scroll-locked\][^{]*\{[^}]*overflow:/s,
  );
  assert.doesNotMatch(
    css,
    /body\[data-scroll-locked\]\s+\[data-sidebar-placeholder\][^{]*\{[^}]*position:\s*fixed/s,
  );
});
