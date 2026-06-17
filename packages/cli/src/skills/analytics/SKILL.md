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
   - Before writing raw `sql_execution` SQL against a connection, call `sql_dialect_notes` with its connection id to get that engine's FQTN, identifier-quoting, date, top-N, series/calendar, rolling-window, safe-cast, and JSON conventions.
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
- **Parse text-encoded numerics before doing math on them.** When a column the question treats as a number is stored as text, sample its **distinct** values (the *Sample before you compose* habit) to learn the encodings actually present — unit suffixes (`K`/`M`/`B`), currency symbols, thousands separators, percent signs, and non-numeric sentinels (`-`, `N/A`, empty) — and never infer the format from the column name. *Why:* aggregated or compared as-is the text sorts lexically (`'100' < '9'`) and a naive cast collapses formatted values to `0`/NULL, so the query runs but the number is silently wrong instead of erroring.
- **Strip, scale, and cast in one early CTE.** Strip currency/separator/percent characters, multiply by the suffix scale (`K`=10^3, `M`=10^6, `B`=10^9), map sentinels to `0` **or** `NULL` (by the *Default by additivity* rule below), then cast to a numeric type — all in a single early CTE so every layer above sees clean numbers. This is the *meaning-is-numeric* complement to *Cast to the real type before comparing*. *Why:* one clean conversion at the base keeps the lexical-sort-and-cast-to-0 failure out of every downstream layer.
- **Confirm the parse covered every value.** After parsing, count the non-sentinel rows that failed to parse — a failed parse should surface as `NULL`, visible only with a **failure-detecting cast** from `sql_dialect_notes` (a plain `CAST` errors on some engines and on sqlite silently returns `0`/partial, so an `IS NULL` check is meaningless there). *Why:* an encoding the sample missed would otherwise vanish into `0`/NULL instead of being caught.

```sql
-- "Total trade volume" where value_text holds '1.2K', '3M', '$1,200', '-'.
-- WRONG: a naive cast collapses the formatted values ('1.2K'->1.2, '$1,200'->0,
-- '-'->0) instead of erroring, so the SUM comes back silently far too low.
SELECT SUM(CAST(value_text AS REAL)) AS total_volume FROM metrics;

-- RIGHT: strip symbols/suffixes, scale by the K/M/B suffix, map sentinels to 0, and
-- cast once in an early CTE; the SUM then runs over clean numbers.
WITH parsed AS (
  SELECT CASE WHEN value_text IN ('-', 'N/A', '') THEN 0
    ELSE CAST(REPLACE(REPLACE(REPLACE(REPLACE(REPLACE(value_text,
                '$', ''), ',', ''), 'K', ''), 'M', ''), 'B', '') AS DECIMAL(18, 4))
         * CASE WHEN value_text LIKE '%K' THEN 1000
                WHEN value_text LIKE '%M' THEN 1000000
                WHEN value_text LIKE '%B' THEN 1000000000 ELSE 1 END
    END AS volume
  FROM metrics
)
SELECT SUM(volume) AS total_volume FROM parsed;
```

**Composition**
- **Build incrementally.** Assemble complex queries one CTE at a time, checking each layer's output on a small sample before stacking the next; a wrong intermediate layer is far cheaper to catch early than to debug in the final number.
- **Avoid fan-out joins — the danger is cumulative.** Any one-to-many hop on the path between a measure's owning table and the aggregate inflates that measure, even when the offending join sits several hops below the `SUM`/`COUNT` and is easy to miss. The fix is the single-hop one applied per measure-owning table along the whole chain: pre-aggregate each coarse-grained measure to its own grain in a CTE, then join the already-aggregated result.
- **Verify the grain holds across each join.** As you compose, confirm a join you intend to be one-to-one / many-to-one did not change the grain you aggregate at — e.g. the row count (or the count of the aggregate's key) is unchanged across it. When a join is genuinely one-to-many, reach for the default fix (pre-aggregate to grain); for a pure count, `COUNT(DISTINCT key)` is an acceptable escape hatch. A `SUM`/`AVG` of a fanned-out measure must pre-aggregate — `DISTINCT` cannot de-duplicate a sum.

```sql
-- "How many orders per region contain a returned item?" — count each order once.
-- WRONG: order_lines is joined to apply the line-level filter, which multiplies
-- orders; an order with two returned lines is counted twice, three joins below
-- the COUNT, where the inflation is easy to miss.
SELECT r.region_id, COUNT(*) AS n_orders
FROM regions r
JOIN stores s      ON s.region_id = r.region_id
JOIN orders o      ON o.store_id  = s.store_id
JOIN order_lines l ON l.order_id  = o.order_id
WHERE l.status = 'returned'
GROUP BY r.region_id;

-- RIGHT: collapse order_lines to one row per qualifying order first, then join up
-- so each order contributes exactly once.
WITH returned_orders AS (
  SELECT order_id FROM order_lines WHERE status = 'returned' GROUP BY order_id
)
SELECT r.region_id, COUNT(*) AS n_orders
FROM regions r
JOIN stores s           ON s.region_id = r.region_id
JOIN orders o           ON o.store_id  = s.store_id
JOIN returned_orders ro ON ro.order_id = o.order_id
GROUP BY r.region_id;
-- A pure count could also use COUNT(DISTINCT o.order_id); a SUM/AVG of an
-- order-level measure fanned out this way must pre-aggregate — DISTINCT can't
-- de-duplicate a sum.
```

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

- **Cumulative / running total.** Use an explicit frame — `SUM(x) OVER (PARTITION BY k ORDER BY t ROWS BETWEEN UNBOUNDED PRECEDING AND CURRENT ROW)` — with a complete tie-breaker on the `ORDER BY` (per the deterministic-ordering rule above). *Why:* a bare `ORDER BY` defaults to a `RANGE`-based frame bounded at the current row, which on ties in the order key folds every tied peer into one cumulative value — it runs and looks plausible, but the running total jumps at each tie boundary.
- **Rolling window over calendar time, plus minimum periods.** "Rolling N days/months" spans a *calendar range*, not a fixed row count: a `ROWS BETWEEN n-1 PRECEDING` frame silently measures the wrong span when days are missing. Two sanctioned paths — (a) build a gap-free date spine first (the **Series** idiom from `sql_dialect_notes`) so one row exists per calendar unit, then a `ROWS BETWEEN n-1 PRECEDING AND CURRENT ROW` frame equals the intended span (fully portable); or (b) where the engine supports it, a native calendar range frame — or a date-keyed self-join — expresses the window directly: get the rolling-window idiom from `sql_dialect_notes`, do not inline it. For **minimum periods** ("only after N periods of data"), emit `NULL` until the window is full — guard on `COUNT(*) OVER (<same frame>) = N`, counting non-null observations instead when "N periods" means N data points rather than N calendar slots. *Why:* a row-count frame over missing dates measures the wrong span, and a partial early window is not the requested metric.
- **Period-over-period.** Compare against the prior period with `LAG(metric) OVER (PARTITION BY k ORDER BY period)`; compute growth as `(cur - prev) / prev` at full precision, rounding only in the final projection (per the round-at-the-end rule below), and guard the divide against a zero or absent prior — e.g. `… / NULLIF(prev, 0)`. *Why:* without `LAG`, or ordered against the wrong neighbor, the comparison lands on the wrong period, and an unguarded ratio errors or returns garbage when the prior period is zero or missing.

```sql
-- "Each account's running balance over time" — a cumulative sum of net per
-- account, in date order.
-- WRONG: a bare ORDER BY defaults to a RANGE-based frame, so two txns dated the
-- same day share one inflated balance (every tied peer folds into that value).
SELECT account_id, txn_date, net,
       SUM(net) OVER (PARTITION BY account_id ORDER BY txn_date) AS running_balance
FROM account_txns;

-- RIGHT: an explicit ROWS frame accumulates row by row, and a complete tie-breaker
-- (txn_id) makes the order — and the running total — deterministic across ties.
SELECT account_id, txn_date, net,
       SUM(net) OVER (PARTITION BY account_id ORDER BY txn_date, txn_id
                      ROWS BETWEEN UNBOUNDED PRECEDING AND CURRENT ROW) AS running_balance
FROM account_txns;
```

**Numeric precision**
- **Round only at the end.** Compute at full precision and round in the final projection, never inside intermediate CTEs. Be explicit about truncation: an integer cast (`CAST(x AS INT)`) truncates toward zero, so use explicit rounding when rounding is what you mean.
- **Macro vs micro average.** Match the average to the wording. "Average of per-group averages" is `AVG(group_metric)`; an "overall" or "weighted" average is `SUM(numerator) / SUM(denominator)`. The two diverge whenever group sizes differ.

**Answer completeness / interpretation**
- **"Top / highest / most / lowest"** returns only the winning row(s) — keep the top-ranked row from the window result — not the full ranked list, unless the question asks for a list.
- **"For each X / per X / by X"** returns exactly one row per X. Do not collapse to a single value unless the question says "overall" or "total across X".
- **Complete the panel for "each / every / all / per <period or category>".** These cues mean the answer's rows should be the *full expected domain* — every month in the asked range, every region in the dimension — not only the groups that happen to have fact rows; a plain inner `GROUP BY` emits only non-empty groups, so empty periods/categories silently drop and a "12 months" answer comes back short. Build the full set of groups (the **spine**), `LEFT JOIN` the aggregated facts onto it, then default the gaps:
  - **Spine source.** For a category, take the distinct domain from the **dimension/entity table** (e.g. every region from `regions`) — not `SELECT DISTINCT` over the facts, which can only list categories that already occur; with no dimension table, distinct values from the *unfiltered* facts are the best available domain. For a period or number range, generate the series across the question's stated range (when the range is "all periods present", derive its bounds from `MIN`/`MAX` over the *unfiltered* facts). Series syntax is engine-specific — get the series/calendar idiom from `sql_dialect_notes` rather than inlining one dialect's generator.
  - **Default by additivity.** `COALESCE(metric, 0)` only for **additive** measures (a `COUNT`/`SUM` of events or amounts, where "no activity" genuinely reads as 0); leave **non-additive** measures (`AVG`, a rate, a ratio, a price, a running balance) as `NULL` — absence is "no data", and 0 would be a wrong reading.
  - **Don't over-apply.** *each / every / all* wants the complete domain; *which / that have* ("which months had orders") wants only the groups that exist — there the spine is wrong, so emit observed groups only.
- **Keep the inputs to a derived value.** When the question asks for inputs and something derived from them ("X, Y, and their ratio"), project the inputs as columns alongside the derived value.
- **Expose identity, not just the label.** When grouping by a human-readable name, also project the entity's identifier; identity is part of the result and disambiguates duplicate names.
- **Diagnose empty results.** When a result is unexpectedly empty, relax filters one at a time to find which predicate removed the rows instead of guessing.

```sql
-- "How many orders per region, including regions with no orders?" — every region
-- must appear, even one with zero orders.
-- WRONG: grouping the facts can only emit regions that have at least one order,
-- so a zero-order region silently drops and the panel comes back short a row.
SELECT region_id, COUNT(*) AS n_orders
FROM orders
GROUP BY region_id;

-- RIGHT: start from the full region domain (the dimension table), LEFT JOIN the
-- per-region counts onto it, and COALESCE the additive count to 0 so empty
-- regions read 0 instead of vanishing.
WITH region_domain AS (
  SELECT DISTINCT region_id FROM regions
),
region_orders AS (
  SELECT region_id, COUNT(*) AS n_orders
  FROM orders
  GROUP BY region_id
)
SELECT d.region_id, COALESCE(ro.n_orders, 0) AS n_orders
FROM region_domain d
LEFT JOIN region_orders ro ON ro.region_id = d.region_id;
```
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
