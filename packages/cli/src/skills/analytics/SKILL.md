---
name: ktx-analytics
description: Use when answering a question that needs data from a ktx-connected database - investigating, analyzing, "how many", "show me", "what's the breakdown of", finding records by value, exploring tables, comparing periods, explaining metrics, or any data-analysis request. Triggers even when the user does not say "analytics"; if the answer requires querying a configured ktx connection, this skill applies.
---

# ktx Analytics Workflow

You have access to ktx MCP tools for data discovery, semantic-layer analysis, raw read-only SQL, wiki context, and memory ingest. Follow this workflow.

<workflow>
1. **Discover** - call `discover_data` first to see what exists across wiki pages, semantic-layer sources, metrics, dimensions, raw tables, and columns. Returns refs only.
2. **Inspect top hits in parallel** - for each promising ref:
   - `kind: 'wiki'` -> `wiki_read`
   - `kind: 'sl_source'`, `kind: 'sl_measure'`, or `kind: 'sl_dimension'` -> `sl_read_source`
   - `kind: 'table'` or `kind: 'column'` -> `entity_details`
   - For tables you intend to query, sample a few rows (`entity_details` plus a small `sql_execution` sample) to confirm date encoding, null prevalence in join/filter keys, and the real enum values — see the `<sql_craft>` Schema-discovery rules.
3. **Resolve business values** - if the user named a value such as "Acme Corp", "enterprise", or "status=shipped", call `dictionary_search` to find which column holds it.
4. **Plan the analysis** - identify the grain, metrics, dimensions, filters, time window, and expected row limits before querying. Confirm each filter/join column's real type before comparing it (see the `<sql_craft>` Schema-discovery rules).
5. **Query** -
   - Prefer `sl_query` when the semantic layer covers the question.
   - Use `sql_execution` only for questions the semantic layer does not cover.
   - Before writing raw `sql_execution` SQL against a connection, call `sql_dialect_notes` with its connection id to get that engine's FQTN, identifier-quoting, date, top-N, and JSON conventions.
   - When authoring raw SQL, apply the `<sql_craft>` rules: build incrementally, keep window ordering deterministic, compute at full precision, and match the answer's grain to the question.
6. **Validate and explain** - sanity-check totals, filters, null handling, and time zones. If a result is unexpectedly empty or its grain looks wrong, work through the `<sql_craft>` Answer-completeness rules before presenting. State the source tables or semantic-layer objects used.
7. **Capture durable learnings** - call `memory_ingest` whenever a turn produces something worth remembering (business rules, metric definitions, schema gotchas, recurring findings) **or** whenever the user asks you to remember something. Pass markdown in `content` including any source context the memory agent should weigh. Each call is a feedback loop; better notes today mean smarter `discover_data` and `wiki_search` results tomorrow.
</workflow>

<rules>
- Always run `discover_data` before writing SQL. Do not guess table names.
- Prefer the semantic layer over raw SQL when both can answer the question; measures are the source of truth.
- Read entity details before writing SQL against an unfamiliar table. Do not assume column names.
- Treat `sql_execution` as read-only. Writes are rejected by the server.
- Validate value mentions with `dictionary_search` instead of guessing case or spelling. Treat a `dictionary_search` miss as non-authoritative. The index is built from profile-sampled values, so a missing value may simply have been outside the sample. Follow up with `sql_execution` against the most plausible columns before concluding the value is absent.
- `connectionId` scoping when `connection_list` shows multiple connections:
  - Always pass it: `entity_details`, `sl_read_source`, `sql_execution`.
  - Pass it when intent pins a warehouse, otherwise omit for unscoped discovery: `sl_query`, `discover_data`, `dictionary_search`.
  - `memory_ingest`: pass it for warehouse-specific knowledge (e.g. "in our warehouse"); without it the memory lands as wiki-only and cannot update the semantic layer.
  - Never pass it: `connection_list`, `wiki_search`, `wiki_read`, `memory_ingest_status`.
  - If scoping is required but intent is ambiguous, ask which warehouse before calling.
- Show compact result tables for small outputs. For broad results, summarize the top findings and mention the applied limit.
- Ask a concise clarification only when the metric, date range, entity, or grain is genuinely ambiguous and cannot be inferred from context.
</rules>

<sql_craft>
Heuristics for writing *correct* (not merely runnable) SQL. Each is a default plus the reason it holds on any database; apply judgment to the question and the data.

**Schema discovery before writing SQL**
- **Sample before you compose.** Inspect representative rows of every table you will touch (`entity_details` plus a small `sql_execution` sample) to confirm date/time encoding (`YYYYMMDD` integer vs ISO text vs epoch), null prevalence in join/filter keys, and the real set of categorical/enum values. Assumptions about encoding and nullability are the most common source of silently-wrong filters.
- **Cast to the real type before comparing.** Compare a column against a literal of its actual type in `WHERE`/`JOIN`. A string column compared to a numeric literal (or the reverse) can silently match nothing instead of raising an error.

**Composition**
- **Build incrementally.** Assemble complex queries one CTE at a time, checking each layer's output on a small sample before stacking the next; a wrong intermediate layer is far cheaper to catch early than to debug in the final number.
- **Avoid fan-out joins.** Add columns only from tables already at the target grain, or pre-aggregate to that grain before joining. A join that multiplies rows quietly inflates every downstream `SUM`/`COUNT`.

**Window functions**
- **Make the ordering deterministic.** Give every ranking/ordering window a complete tie-breaker by appending unique key column(s) to `ORDER BY`, so `RANK`/`ROW_NUMBER`/`LAG` results are stable instead of flickering between runs.
- **Filter after the window, not before**, for sequence / "first" / "most recent" / "since" questions: compute the window over the full partition, then keep the rows you want. A pre-filter shrinks the partition the window ranks over, so "first"/"most recent" is measured against the wrong set.

```sql
-- "Each customer's first order, restricted to orders since 2024-01-01."
-- Wrong: the filter runs before the window, so it ranks only 2024 rows and
-- misses customers whose true first order was earlier.
SELECT customer_id, order_id,
       ROW_NUMBER() OVER (PARTITION BY customer_id ORDER BY order_date, order_id) AS seq
FROM orders
WHERE order_date >= '2024-01-01';   -- then keep seq = 1

-- Right: rank the full partition in a CTE, then filter in the outer query.
WITH ranked AS (
  SELECT customer_id, order_id, order_date,
         ROW_NUMBER() OVER (PARTITION BY customer_id ORDER BY order_date, order_id) AS seq
  FROM orders
)
SELECT customer_id, order_id, order_date
FROM ranked
WHERE seq = 1 AND order_date >= '2024-01-01';
```

**Numeric precision**
- **Round only at the end.** Compute at full precision and round in the final projection, never inside intermediate CTEs. Be explicit about truncation: an integer cast (`CAST(x AS INT)`) truncates toward zero, so use explicit rounding when rounding is what you mean.
- **Macro vs micro average.** Match the average to the wording. "Average of per-group averages" is `AVG(group_metric)`; an "overall" or "weighted" average is `SUM(numerator) / SUM(denominator)`. The two diverge whenever group sizes differ.

**Answer completeness / interpretation**
- **"Top / highest / most / lowest"** returns only the winning row(s) — keep the top-ranked row from the window result — not the full ranked list, unless the question asks for a list.
- **"For each X / per X / by X"** returns exactly one row per X. Do not collapse to a single value unless the question says "overall" or "total across X".
- **Keep the inputs to a derived value.** When the question asks for inputs and something derived from them ("X, Y, and their ratio"), project the inputs as columns alongside the derived value.
- **Expose identity, not just the label.** When grouping by a human-readable name, also project the entity's identifier; identity is part of the result and disambiguates duplicate names.
- **Diagnose empty results.** When a result is unexpectedly empty, relax filters one at a time to find which predicate removed the rows instead of guessing.
</sql_craft>

<examples>
**Input:** "How many orders did Acme Corp place last month?"

**Workflow:**
1. `dictionary_search({ values: ["Acme Corp"] })` finds `customers.name`.
2. `discover_data({ query: "orders customer monthly" })` finds an orders semantic-layer source.
3. `sl_read_source({ connectionId: "warehouse", sourceName: "orders_facts" })` confirms the source grain, measures, and dimensions.
4. `sl_query({ connectionId: "warehouse", measures: ["order_count"], filters: ["customer_name = 'Acme Corp'"] })` answers through the semantic layer.
5. `memory_ingest({ connectionId: "warehouse", content: "Acme Corp order analysis used orders_facts.order_count filtered by customers.name = 'Acme Corp'. Source: current analysis turn." })` captures the durable finding.

---

**Input:** "What columns does the events table have?"

**Workflow:**
1. `discover_data({ query: "events table" })` returns a `table` ref.
2. `entity_details({ connectionId: "warehouse", entities: [{ table: "analytics.events" }] })` returns columns, types, and foreign keys.
3. Answer directly. No query is needed.

---

**Input:** "Heads up: ARR is always reported in cents in our warehouse."

**Workflow:**
1. If multiple connections exist, call `connection_list` and identify the warehouse the user means. Ask if ambiguous.
2. `memory_ingest({ connectionId: "warehouse", content: "ARR is reported in cents (not dollars) in this warehouse. Multiply by 0.01 for dollar amounts. Source: user clarification." })` remembers the warehouse-specific rule without running an analysis turn.
</examples>
