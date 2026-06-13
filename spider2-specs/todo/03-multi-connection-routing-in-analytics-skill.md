# Multi-connection routing guidance in the ktx-analytics skill

## Problem

The agent-facing `ktx-analytics` skill (installed into agent environments via
the ktx skills/install mechanism, see `.ktx/agents/install-manifest.json` in
projects) describes the query workflow — wiki_search → sl_read_source →
sl_query / sql_execution — but assumes the connection is obvious. In a
multi-connection project nothing tells the agent to *first decide which
connection the question is about*, and several tools silently require it:

- `sql_execution`, `sl_read_source`, `entity_details`: `connectionId`
  **required**;
- `sl_query`, `discover_data`, `dictionary_search`: optional, but
  auto-inference only works with exactly one connection
  (`local-query.ts` `resolveLocalConnectionId` ~29-38 — throws with zero or
  multiple connections).

An agent that skips routing either errors out or, worse, queries the wrong
database when names overlap.

## Generic use case

Any ktx project with more than one connection — the common shape for a data
org (warehouse + product DB + events DB). Routing is the first step of every
question, and the skill should encode it so individual agents don't have to
rediscover it.

## Requirements

1. **Add an explicit routing step (step 0) to the skill's workflow:**
   - Call `connection_list` to see what exists.
   - Match the question's domain to a connection using connection ids/names,
     `discover_data` hits, and wiki context — not guesswork.
   - If genuinely ambiguous after discovery, ask the user rather than pick.
2. **Thread the resolved `connectionId` everywhere:** all subsequent
   `sl_query`, `sql_execution`, `sl_read_source`, `entity_details`,
   `dictionary_search`, `discover_data` calls, and `wiki_search` once spec 01
   lands (search scoped to the resolved connection plus unscoped pages).
3. **Single-connection projects stay frictionless:** the skill should say
   routing is trivial when `connection_list` returns one entry — don't add a
   mandatory ceremony step for the common simple case.
4. **Capture routing knowledge:** when the agent learns a non-obvious
   question-domain → connection mapping, the skill should encourage
   `memory_ingest` so the mapping becomes wiki knowledge for next time.

This is a docs/prompt change in the skill content (plus any skill-install
plumbing if the skill is versioned); no engine changes required.

## Acceptance criteria

- In a fixture project with ≥2 connections, an agent following the skill
  resolves the correct connection before its first data query, and no tool
  call fails with "connectionId is required".
- In a single-connection project the skill-driven flow is unchanged (no
  extra mandatory steps).
- Skill text nowhere assumes a default/implicit connection.

## Benchmark context (motivation only)

Spider 2.0-Lite local subset = 30 SQLite connections in one project; every
one of the 135 questions targets exactly one of them. Connection ids are set
to the benchmark's database names, so with this skill guidance routing is
mechanical (`connection_list` + name match) and needs no benchmark-specific
instructions — which is the point: the harness gives the agent only the
question text.
