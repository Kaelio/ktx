---
name: jira_ingest
description: Extract durable ktx wiki knowledge from staged Jira issues filtered by project and label. Load for WorkUnits with unitKey matching jira-<project>.
callers: [memory_agent]
---

# Jira Ingest

Jira ingest turns staged Jira issues into durable ktx wiki knowledge. Issues have been pre-filtered by project key and label allowlist configured in `ktx.yaml` — every staged issue matches at least one configured label.

## Work unit structure

Each WorkUnit represents one Jira project. The `unitKey` is `jira-<projectkey>` (lowercase), e.g. `jira-docs`.

- `rawFiles`: the `issues/<KEY>.json` files that changed in this run for that project.
- `dependencyPaths`: `manifest.json` — contains the project list, label filter, and fetch metadata.

## Staged file shapes

**`issues/<KEY>.json`** — one per issue:
```json
{
  "id": "12345",
  "key": "DOCS-42",
  "summary": "Define ARR calculation for enterprise segment",
  "description": "## Background\n\nARR is calculated as...",
  "status": "Done",
  "issuetype": "Task",
  "labels": ["kb", "decision"],
  "project": { "key": "DOCS", "name": "Sigma Documentation" },
  "created": "2025-01-15T00:00:00.000Z",
  "updated": "2026-06-01T00:00:00.000Z",
  "assignee": "Jane Smith",
  "priority": "Medium",
  "url": "https://yourorg.atlassian.net/browse/DOCS-42"
}
```

The `description` field is pre-converted from ADF (Atlassian Document Format) to Markdown. It may be `null` if the issue has no description.

**`manifest.json`** — fetch summary:
```json
{
  "source": "jira",
  "fetchedAt": "2026-06-27T00:00:00.000Z",
  "baseUrl": "https://sigmacomputing.atlassian.net",
  "projects": ["DOCS"],
  "labels": ["kb", "decision", "policy"],
  "since": "2026-06-01T00:00:00.000Z",
  "issueCount": 47,
  "warnings": []
}
```

## Required workflow

1. Read `manifest.json` to understand the project scope and label filter.
2. Read every issue file in `rawFiles` with `read_raw_file`.
3. For each issue: extract durable business knowledge from the summary and description.
4. Use `discover_data` to find existing wiki pages on the same topic before writing.
5. Write wiki candidates with `context_candidate_write`. Do not call `wiki_write` directly from a Jira WorkUnit.
6. Do not write SL sources from Jira issues — Jira does not define warehouse tables.

## What to capture

Write wiki candidates for issues whose content reveals **reusable, durable** company knowledge:

- **`kb` label**: knowledge base articles — definitions, how-tos, canonical answers.
- **`decision` label**: architectural or product decisions with rationale.
- **`policy` label**: rules, standards, or compliance requirements.

Write one wiki candidate per distinct concept, not one per issue. Synthesize related issues into a single page when they cover the same topic.

**Example patterns worth capturing:**
- A `kb` issue titled "How ARR is calculated" → wiki page on ARR definition and formula
- A `decision` issue about "Switching to Snowflake for prod" → wiki page on data stack decisions
- A `policy` issue about "PII handling in exports" → wiki page on PII policy

## What to skip

- Issues in status `Open` or `In Progress` that describe planned work rather than settled decisions
- Issues whose description adds no durable fact beyond what the summary states
- Task-management boilerplate: sprint assignments, story points, status transitions
- Issues with a generic summary and null/empty description

## Citation style

```md
## ARR Calculation Policy
ARR is calculated as annualized monthly recurring revenue, excluding one-time fees.

Source: Jira DOCS-42 (Define ARR calculation for enterprise segment), updated 2026-06-01.
```

Include the Jira issue key and the `updated` date. When multiple issues support the same fact, cite all of them on one page.

## Usage signals

`latestVersion` is not available in Jira issues. Use the `updated` date as a freshness signal. Prefer the most recently updated issue when multiple issues conflict on the same topic.
