# Composite-key (multi-column) join detection

> Priority: MEDIUM. Found empirically during the first Spider2-lite sqlite
> smoke test (2026-06-13): relationship detection emitted **zero joins** for a
> database whose fact tables are linked only by composite keys. Agents still
> answered correctly by inferring the join from shared `grain`, so this didn't
> cost benchmark points — but it forces inference that explicit joins would
> remove, and the gap is generic.

## Problem

Relationship detection appears to emit only single-column joins. For the IPL
sqlite database, every table came back with `joins=0`, even though its fact
tables are connected by a 4-column composite key
(`match_id, over_id, ball_id, innings_no`) shared across `ball_by_ball`,
`batsman_scored`, `extra_runs`, and `wicket_taken`. The semantic layer did
correctly record that shared key as each table's `grain`, which is why agents
could recover the relationship — but no `joins:` entries were produced for the
fact-to-fact links.

## Generic use case

Event/fact tables keyed by composite business keys are common: ledger lines
(`account_id, period, line_no`), telemetry (`device_id, ts, metric`), sports
ball-by-ball, EAV/log schemas. Whenever there are no single-column FKs but a
multi-column key recurs across tables, ktx should detect and document the join
so agents (and `sl_query`) don't have to infer it.

## Requirements

1. Relationship detection considers **multi-column** join candidates, not just
   single-column ones. A strong signal already exists in ktx: when two tables
   share an identical (or subset/superset) declared `grain`, that grain is a
   prime composite-join candidate.
2. Emitted joins carry the full composite condition, e.g.
   `on: a.match_id = b.match_id AND a.over_id = b.over_id AND a.ball_id = b.ball_id AND a.innings_no = b.innings_no`,
   with a sensible `relationship` cardinality.
3. The existing validation/threshold machinery
   (`scan.relationships.acceptThreshold` etc.) applies to composite candidates
   too; profile-based validation should check join selectivity on the full key.
4. No regression for single-column joins; don't explode combinatorially —
   bound candidate generation (e.g. only consider shared-grain keys and
   declared/!inferred PK overlaps, cap column count).
5. `sl_query` can compile a join across a composite-key relationship.

## Acceptance criteria

- For a fixture with two tables sharing a 3- or 4-column grain and no
  single-column FK, ingest emits a composite join between them with the full
  multi-column `on` condition.
- `sl read <source>` shows the composite join; `sl_query` can traverse it.
- Single-column join detection is unchanged on existing fixtures.

## Benchmark context (motivation only)

IPL (and similar ball-by-ball/event schemas in the Spider2-lite local set)
have no single-column FKs; their joins are entirely composite. Explicit
composite joins would let the agent rely on documented relationships instead
of inferring them from grain.
