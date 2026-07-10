---
name: ktx
description: Installs and configures ktx, the open-source context layer for data agents — runs ktx setup non-interactively with hidden CLI flags, configures database connections and embeddings, installs agent integration, and verifies readiness. Use when the user asks an agent to add ktx to a project, connect data sources, install agent rules, ingest schema, or troubleshoot a local ktx install.
---

# ktx

Install and configure **ktx**, the open-source context layer for data agents.
Use this skill when a user wants an agent to add **ktx** to a project, connect
data sources, build initial context, install agent integration, or troubleshoot
a local **ktx** setup.

## Operating rules

- Act autonomously when the user asks you to install or configure **ktx**.
  The non-interactive scripted flow below is the canonical path — bare
  `ktx setup` is interactive (clack prompts) and an agent cannot drive it.
- Setup's non-interactive flags are intentionally hidden from `--help`. Use the
  flags listed below; verify uncommon flags against the docs at
  `https://docs.kaelio.com/ktx/` or this skill — not against `--help` output.
- Ask only for values you cannot infer: project directory, connection targets,
  credentials, account identifiers, and source selections.
- Prefer `file:/abs/path` secret refs over `env:VAR_NAME`. `env:` refs are
  re-resolved against the process environment on **every** `ktx` run, so a var
  exported only in the setup shell is gone when `ktx ingest` or `ktx mcp start`
  runs later — the secret silently resolves to empty and the connection fails.
  `file:` refs read from disk and survive across shells. The same caveat
  applies to `--*-api-key-env` flags: the named var must be present in every
  shell that runs `ktx`, including the `ktx mcp` daemon's environment.
- A literal database URL is safe to pass — `ktx setup` auto-externalizes it
  into `.ktx/secrets/<id>-url` and rewrites `ktx.yaml` to a `file:` ref (see
  workflow step 2). Source credential refs are **not** auto-externalized: write
  the secret to a file under `.ktx/secrets/` (`chmod 600`) and pass a `file:`
  ref. Never ask the user to paste a secret when a `file:` or `env:` ref works.
- Do not commit `.ktx/secrets/*`.
- Print each command you run and its result.
- Setup and ingest can run for many minutes (LLM-heavy source ingests take the
  longest), and from the outside a slow step looks identical to a stuck one.
  Don't go silent: say what's about to run and that it may take a while, then
  post brief progress/liveness updates while it runs (see step 4) so the user
  never has to wonder whether it stalled — otherwise they may kill it mid-run.
- If a command fails, identify the cause and change something before retrying.

## Gather inputs once

Before invoking `ktx setup`, collect in one round:

1. Project directory (default: current working directory).
2. LLM backend and key strategy. In `--no-input` mode the CLI defaults to
   `anthropic` and **requires an API key**. When the user is inside Claude
   Code, pass `--llm-backend claude-code` explicitly; otherwise pass
   `--llm-backend anthropic --anthropic-api-key-env ANTHROPIC_API_KEY`.
3. Embedding backend (`sentence-transformers` is the local default and needs
   no key; use `openai` only if the user already has a key, then pass
   `--embedding-api-key-env OPENAI_API_KEY`).
4. Database: driver, connection id, URL (or `env:` / `file:` ref), and one or
   more schemas. For BigQuery, collect the billing project id and use ADC by
   default; collect a credential reference only when ADC is unavailable.
5. Optional context sources (dbt, Metabase, Looker, LookML, MetricFlow,
   Notion). Add each one with a follow-up `ktx setup --source …` run (see
   [Add context sources](#add-context-sources)); use `--skip-sources` only
   when the user has none.

Do not discover these inputs across multiple setup runs.

## Install workflow

1. **Detect the install path.** If the working directory contains
   `packages/cli/dist/bin.js` or `pnpm-workspace.yaml` referencing
   `@kaelio/ktx` you are inside the **ktx** monorepo — build and link the
   local CLI with `pnpm` and do **not** run `npm install -g`. Otherwise:

   ```bash
   node --version    # require >= 22; stop and ask the user if older
   ktx --version || npm install -g @kaelio/ktx
   ```

2. **Run scripted setup** (canonical path):

   ```bash
   ktx setup --no-input --yes \
     --project-dir <path> \
     --llm-backend claude-code \
     --embedding-backend sentence-transformers \
     --database <driver> --database-connection-id <id> \
     --database-url '<raw-url | file:/abs/path>' \
     --database-schema <schema> \
     --skip-sources \
     --skip-agents
   ```

   For BigQuery, replace `--database-url` with the billing project flag. Omit
   `--database-credentials` to use Application Default Credentials:

   ```bash
   ktx setup --no-input --yes \
     --project-dir <path> \
     --llm-backend claude-code \
     --embedding-backend sentence-transformers \
     --database bigquery --database-connection-id <id> \
     --database-project-id <project-id> \
     --database-schema <dataset> \
     --skip-sources \
     --skip-agents
   ```

   - `--database-schema` is required for scope-bearing drivers (Postgres,
     MySQL, ClickHouse, SQL Server, BigQuery, Snowflake) in `--no-input`:
     setup fails fast without it unless the connection already has scope in
     `ktx.yaml`. SQLite needs no scope.
   - Configure one new database connection per setup invocation. For multiple
     connections, rerun setup once per connection.
   - Pasting a literal `--database-url` is safe: the CLI relocates the URL
     into `.ktx/secrets/<connection-id>-url` and rewrites `ktx.yaml` to a
     `file:` ref automatically.
   - `ktx setup` runs agent integration as its **last** step. In `--no-input`
     mode with neither `--target` nor `--skip-agents`, that step has no input,
     prints `Run in a TTY, or pass --target <target>.`, and the command exits
     non-zero **even though every database/LLM/embedding step succeeded**. Pass
     `--skip-agents` to defer agents to step 5 (as above), or `--target <agent>`
     to install them inline and exit 0. Judge data-layer success from
     `ktx status`, not from this exit code.

3. **Resumability and `--skip-*`.** Re-running `ktx setup` against an existing
   project resumes its config. Use `--skip-llm`, `--skip-databases`,
   `--skip-sources`, or `--skip-embeddings` to leave a slice unconfigured but
   let the rest complete instead of aborting on the first failure. **When
   resuming an existing project to change one slice (e.g. only LLM), still
   pass the database flags from the previous run** — setup validates current
   flags, not persisted `ktx.yaml` state.

4. **Build context** if setup did not already complete one:

   ```bash
   ktx ingest <connection-id> --no-input
   ```

   `ktx ingest` always builds enriched context and requires a configured model
   and embeddings (set during setup); a database connection without them fails
   with an enrichment-readiness error. Note: `ktx ingest` rejects `--yes`
   together with `--no-input` (*Choose only one runtime install mode*);
   `ktx setup` accepts both. Use `--no-input` only for ingest.

   Ingest one connection at a time. It can run for many minutes with **no
   stdout** until it exits (LLM-heavy sources like Metabase are the slowest), so
   don't assume it hung, and don't pipe it through `tail`/`head` — that buffers
   all output to the end, so run it raw. Tell the user up front that the step is
   slow, then keep them posted instead of blocking silently: run the ingest in
   the background and poll for liveness every minute or so, reporting a one-line
   update each time (which connection, roughly how long it's been running, and
   that `.ktx` files are still changing) so a long run never looks stuck:

   ```bash
   find <path>/.ktx/worktrees <path>/.ktx/ingest-transcripts -type f -mmin -3
   ```

   On success, the `Ingest finished` summary table shows `done` in the
   `Source ingest` and `Memory update` columns with no `Failed sources:`
   section.

5. **Install agent integration:**

   ```bash
   ktx setup --agents --target <claude-code|claude-desktop|codex|cursor|opencode|universal>
   ktx mcp start --project-dir <path>
   ```

   Agent integration is **not usable until `ktx mcp start` is running**. The
   `--agents` step prints this requirement as `Required before using agents`.

6. **Fall back to bare `ktx setup` only when a human is at the keyboard** —
   it uses interactive prompts an agent cannot answer.

## Add context sources

Context sources (dbt, Metabase, Looker, LookML, MetricFlow, Notion) are added
**one at a time** — `--source` is not repeatable, so run `ktx setup` once per
source. Source setup is resumable against an existing project: pass
`--skip-databases --skip-llm --skip-embeddings --skip-agents` so only the source
is configured (the trailing agent step otherwise fails the run — see install
step 2). Map Metabase, Looker, and LookML to an existing database connection
with `--source-warehouse-connection-id <db-connection-id>` (required for those).
**dbt ignores `--source-warehouse-connection-id`** — it maps to the warehouse by
table name — so omit it for dbt. Use `file:/abs/path` refs for keys and tokens
(see the secrets rule above); `env:` refs must be exported in every later `ktx`
shell.

```bash
# dbt — pick exactly one of --source-path (local) or --source-git-url (remote).
# No --source-warehouse-connection-id: dbt maps to the warehouse by table name.
ktx setup --no-input --yes --skip-databases --skip-llm --skip-embeddings --skip-agents \
  --source dbt --source-connection-id <id> \
  --source-git-url <url> --source-branch <branch>

# Metabase
ktx setup --no-input --yes --skip-databases --skip-llm --skip-embeddings --skip-agents \
  --source metabase --source-connection-id <id> \
  --source-url <url> --source-api-key-ref file:/abs/path/metabase-api-key \
  --source-warehouse-connection-id <db-connection-id> \
  --metabase-database-id <metabase-db-id>

# Notion
ktx setup --no-input --yes --skip-databases --skip-llm --skip-embeddings --skip-agents \
  --source notion --source-connection-id <id> \
  --source-auth-token-ref file:/abs/path/notion-token \
  --notion-crawl-mode selected_roots --notion-root-page-id <page-id>
```

Notes:

- `--metabase-database-id` is the **numeric id of the warehouse inside
  Metabase** (not the ktx connection id). Discover it from the Metabase API
  (`GET /api/database`) or UI if the user doesn't know it.
- `--notion-crawl-mode selected_roots` requires at least one
  `--notion-root-page-id` (repeatable); use `all_accessible` to crawl
  everything the token can see.
- After adding sources, ingest each new connection so its context is queryable:
  `ktx ingest <source-connection-id> --no-input`.

## Files to inspect

- `ktx.yaml`: project configuration.
- `.ktx/secrets/*`: local secret files. Never commit them.
- `semantic-layer/<connection-id>/*.yaml`: semantic sources for SQL
  compilation.
- `wiki/**/*.md`: project context pages for agents.
- `.claude/skills/ktx/`, `.agents/skills/ktx/`, `.cursor/rules/ktx.mdc`, and
  `.opencode/commands/ktx.md`: generated agent integration files.

## Verification

After setup, run:

```bash
ktx connection test <connection-id>
ktx status --json --no-input
ktx sl --output plain          # lists compiled semantic sources; `ktx sl` has no --no-input
```

**Judge readiness from `ktx status --json` fields, not the exit code.**
`ktx status` exits 1 whenever the LLM is `none` (`verdict: "blocked"`), even
when embeddings and every database connection are healthy. Treat success as:

- `verdict: "ready"` at the top of the JSON, and
- every `connections[].status === "ok"` (other levels: `warn`, `fail`,
  `skipped`), and
- every `ktx connection test <id>` exited 0, and
- for each ingested source, `localStats.semanticLayer[].sourceCount > 0` and
  `localStats.wikiPages[].count > 0` — these confirm the source actually
  produced context. Do **not** rely on `localStats.ingest.perConnection` to
  confirm source ingests: it reflects only completed warehouse ingest reports
  and under-reports (often lists just the warehouse connection).

If the LLM is intentionally left unconfigured, `verdict` is `blocked` and the
exit is non-zero by design — that is still a usable context layer, so report it
as "ready, LLM optional" and judge the data layer by the connection and
`localStats` fields above rather than retrying setup.

## Troubleshooting

For known failure signatures (`invalid ELF header`,
`Native CLI binary for <plat> not found`, `Missing Anthropic API key`,
`claude-code` probe failure, `ktx cannot work without a database` on resume,
`Run in a TTY, or pass --target <target>.` with a misleading exit 1, and a
secret that resolves empty only during `ktx ingest`/`ktx mcp`), see
[troubleshooting.md](troubleshooting.md).

## Final report

End setup work with a concise report:

```text
ktx SETUP COMPLETE

Project:     <path>
LLM:         <backend> / <model>
Embeddings:  <backend> / <model>
Connections: <name> (<driver>) status=<ok|warn|fail>
Sources:     <list or none>
Verdict:     <ready|needs action>

Next:
1. <copy-pasteable command or action>
2. <copy-pasteable command or action>

RESULT: PASS
```
