import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { once } from "node:events";
import { readdir, readFile, writeFile } from "node:fs/promises";
import http from "node:http";
import https from "node:https";
import { dirname, join } from "node:path";
import { createServer } from "node:net";
import { after, before, test } from "node:test";
import { setTimeout as delay } from "node:timers/promises";
import { fileURLToPath } from "node:url";

const configuredDocsSiteUrl = process.env.DOCS_SITE_URL;
const docsBasePath = "/ktx";
let docsSiteUrl = configuredDocsSiteUrl;
let docsServer;
let docsServerOutput = "";
let nextEnvPath;
let nextEnvContents;
const docsSiteDir = join(dirname(fileURLToPath(import.meta.url)), "..");
const pnpmExecPath = process.env.npm_execpath;

async function getAvailablePort() {
  const server = createServer();
  server.listen(0, "127.0.0.1");
  await once(server, "listening");

  const address = server.address();
  await new Promise((resolve, reject) => {
    server.close((error) => {
      if (error) reject(error);
      else resolve();
    });
  });

  assert.equal(typeof address, "object");
  assert.notEqual(address, null);
  return address.port;
}

function appendDocsServerOutput(chunk) {
  docsServerOutput = `${docsServerOutput}${chunk.toString()}`.slice(-4000);
}

async function waitForDocsServer() {
  for (let attempt = 0; attempt < 150; attempt += 1) {
    if (docsServer?.exitCode !== null) {
      throw new Error(
        `Docs server exited before it was ready.\n${docsServerOutput}`,
      );
    }

    try {
      await fetch(`${docsSiteUrl}${docsBasePath}/docs`, { redirect: "manual" });
      return;
    } catch {
      await delay(200);
    }
  }

  throw new Error(`Timed out waiting for docs server.\n${docsServerOutput}`);
}

before(async () => {
  if (configuredDocsSiteUrl) {
    return;
  }

  nextEnvPath = join(docsSiteDir, "next-env.d.ts");
  nextEnvContents = await readFile(nextEnvPath, "utf8");

  const port = await getAvailablePort();
  docsSiteUrl = `http://127.0.0.1:${port}`;
  const pnpmArgs = [
    "exec",
    "next",
    "dev",
    "--hostname",
    "127.0.0.1",
    "--port",
    `${port}`,
  ];
  const command =
    pnpmExecPath === undefined
      ? process.platform === "win32"
        ? (process.env.ComSpec ?? "cmd.exe")
        : "pnpm"
      : process.execPath;
  const args =
    pnpmExecPath === undefined
      ? process.platform === "win32"
        ? ["/d", "/s", "/c", "pnpm", ...pnpmArgs]
        : pnpmArgs
      : [pnpmExecPath, ...pnpmArgs];

  docsServer = spawn(command, args, {
    cwd: docsSiteDir,
    env: { ...process.env, NEXT_TELEMETRY_DISABLED: "1" },
    stdio: ["ignore", "pipe", "pipe"],
  });
  docsServer.stdout.on("data", appendDocsServerOutput);
  docsServer.stderr.on("data", appendDocsServerOutput);

  await waitForDocsServer();
});

async function listDocsPages(dir = join(docsSiteDir, "content", "docs")) {
  const entries = await readdir(dir, { withFileTypes: true });
  const pages = await Promise.all(
    entries.map(async (entry) => {
      const entryPath = join(dir, entry.name);

      if (entry.isDirectory()) {
        return listDocsPages(entryPath);
      }

      if (!entry.isFile() || !entry.name.endsWith(".mdx")) {
        return [];
      }

      const sourcePath = entryPath
        .slice(docsSiteDir.length + 1)
        .replaceAll("\\", "/");
      const routePath = sourcePath
        .replace(/^content\/docs\//, "")
        .replace(/(?:\/index)?\.mdx$/, "");

      return [{ routePath, sourcePath: `docs-site/${sourcePath}` }];
    }),
  );

  return pages.flat();
}

after(async () => {
  if (docsServer && docsServer.exitCode === null) {
    docsServer.kill("SIGTERM");
    await Promise.race([
      once(docsServer, "exit"),
      delay(5000).then(() => docsServer?.kill("SIGKILL")),
    ]);
  }

  if (nextEnvPath && nextEnvContents !== undefined) {
    await writeFile(nextEnvPath, nextEnvContents);
  }
});

// Node's fetch (undici) overwrites the Host header with the connection host,
// so the alias-host redirect rules never match. The low-level http(s) client
// sends Host verbatim, which is what the alias canonicalization keys off of.
function requestWithHost(hostHeader, path) {
  const target = new URL(docsSiteUrl);
  const client = target.protocol === "https:" ? https : http;
  const port =
    target.port || (target.protocol === "https:" ? "443" : "80");

  return new Promise((resolve, reject) => {
    const request = client.request(
      {
        hostname: target.hostname,
        port,
        path,
        method: "GET",
        headers: { Host: hostHeader },
      },
      (response) => {
        response.resume();
        resolve({
          status: response.statusCode,
          location: response.headers.location,
        });
      },
    );
    request.on("error", reject);
    request.end();
  });
}

test("/ktx/docs redirects to the docs introduction", async () => {
  const response = await fetch(`${docsSiteUrl}${docsBasePath}/docs`, {
    redirect: "manual",
  });

  assert.equal(response.status, 307);
  assert.equal(
    response.headers.get("location"),
    `${docsBasePath}/docs/getting-started/introduction`,
  );
});

test("retired AI Resources URLs redirect to the page under Community", async () => {
  // The former top-level URL.
  const bare = await fetch(
    `${docsSiteUrl}${docsBasePath}/docs/ai-resources`,
    { redirect: "manual" },
  );

  assert.equal(bare.status, 308);
  assert.equal(
    bare.headers.get("location"),
    `${docsBasePath}/docs/community/ai-resources`,
  );

  // A retired per-page slug.
  const slug = await fetch(
    `${docsSiteUrl}${docsBasePath}/docs/ai-resources/agent-quickstart`,
    { redirect: "manual" },
  );

  assert.equal(slug.status, 308);
  assert.equal(
    slug.headers.get("location"),
    `${docsBasePath}/docs/community/ai-resources`,
  );

  // A retired per-page Markdown URL must stay Markdown: it has to redirect to
  // the new .md route, not fall through to the HTML page.
  const markdown = await fetch(
    `${docsSiteUrl}${docsBasePath}/docs/ai-resources/agent-quickstart.md`,
    { redirect: "manual" },
  );

  assert.equal(markdown.status, 308);
  assert.equal(
    markdown.headers.get("location"),
    `${docsBasePath}/docs/community/ai-resources.md`,
  );

  // Following that redirect end to end must land on Markdown, not HTML.
  const followed = await fetch(
    `${docsSiteUrl}${docsBasePath}/docs/ai-resources/agent-quickstart.md`,
  );

  assert.equal(followed.status, 200);
  assert.match(followed.headers.get("content-type") ?? "", /text\/markdown/);
});

test("/ redirects into the /ktx docs site", async () => {
  const response = await fetch(`${docsSiteUrl}/`, {
    redirect: "manual",
  });

  assert.equal(response.status, 307);
  assert.equal(
    response.headers.get("location"),
    `${docsBasePath}/docs/getting-started/introduction`,
  );
});

test("/ktx/api/search returns docs search results", async () => {
  const response = await fetch(
    `${docsSiteUrl}${docsBasePath}/api/search?query=setup`,
  );

  assert.equal(response.status, 200);

  const results = await response.json();
  assert.ok(Array.isArray(results), "search response should be an array");
  assert.ok(
    results.some(
      (result) =>
        typeof result.url === "string" && result.url.startsWith("/docs/"),
    ),
    "search should return at least one docs result",
  );
});

test("docs pages render source edit and issue actions", async () => {
  const pages = await listDocsPages();
  assert.ok(pages.length > 0, "docs pages should be discovered from content");

  const sampledPages = [
    pages.find((page) => page.routePath === "getting-started/introduction"),
    pages.find((page) => page.routePath === "cli-reference/ktx"),
  ];

  for (const page of sampledPages) {
    assert.ok(page, "sample docs page should exist");

    const response = await fetch(
      `${docsSiteUrl}${docsBasePath}/docs/${page.routePath}`,
    );
    assert.equal(response.status, 200, page.routePath);

    const html = await response.text();
    assert.match(html, />Copy as Markdown</, page.routePath);
    assert.match(html, />Suggest edits</, page.routePath);
    assert.match(html, />Raise issue</, page.routePath);
    assert.match(
      html,
      new RegExp(
        `https://github\\.com/Kaelio/ktx/edit/main/${page.sourcePath}`,
      ),
      page.routePath,
    );
    assert.match(
      html,
      /https:\/\/github\.com\/Kaelio\/ktx\/issues\/new\?[^"]*template=docs_feedback\.yml/,
      page.routePath,
    );
    assert.match(
      html,
      new RegExp(
        `(?:\\?|&amp;)page=${encodeURIComponent(`https://docs.kaelio.com/ktx/docs/${page.routePath}`)}`,
      ),
      page.routePath,
    );
    assert.match(
      html,
      new RegExp(`(?:\\?|&amp;)source=${encodeURIComponent(page.sourcePath)}`),
      page.routePath,
    );
  }
});

test("ktx.sh canonicalizes to a single /ktx basePath on the docs host", async () => {
  const root = await requestWithHost("ktx.sh", "/");
  assert.equal(root.status, 308);
  assert.equal(root.location, "https://docs.kaelio.com/ktx/");
  assert.ok(
    !root.location.includes("/ktx/ktx"),
    "the basePath must not be doubled",
  );

  const page = await requestWithHost(
    "ktx.sh",
    "/docs/getting-started/quickstart",
  );
  assert.equal(page.status, 308);
  assert.equal(
    page.location,
    "https://docs.kaelio.com/ktx/docs/getting-started/quickstart",
  );
});

test("docs.ktx.sh canonicalizes to a single /ktx basePath on the docs host", async () => {
  const root = await requestWithHost("docs.ktx.sh", "/");
  assert.equal(root.status, 308);
  assert.equal(root.location, "https://docs.kaelio.com/ktx");
  assert.ok(
    !root.location.includes("/ktx/ktx"),
    "the basePath must not be doubled",
  );

  const page = await requestWithHost("docs.ktx.sh", "/llms.txt");
  assert.equal(page.status, 308);
  assert.equal(page.location, "https://docs.kaelio.com/ktx/llms.txt");
});

test("ktx.sh keeps the /slack and /stars exceptions", async () => {
  const slack = await requestWithHost("ktx.sh", "/slack");
  assert.equal(slack.status, 307);
  assert.match(slack.location, /^https:\/\/join\.slack\.com\//);

  // /stars is proxied by a beforeFiles rewrite, so the apex catch-all must not
  // canonicalize it to the docs host.
  const stars = await requestWithHost("ktx.sh", "/stars");
  assert.ok(
    !(stars.location ?? "").startsWith("https://docs.kaelio.com"),
    "the stars dashboard must not be redirected to the docs host",
  );
});
