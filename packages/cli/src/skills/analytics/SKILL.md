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
4. **Plan the analysis** - identify the grain, metrics, dimensions, filters, time window, and expected row limits before querying. Confirm each filter/join column's real type before comparing it (see the `<sql_craft>` Schema-discovery rules). **Write down the exact output-column list first** — enumerate, from the question, every column the answer must have (each requested metric/attribute; for every grouped or named entity BOTH its id and its name; every input to each derived value) and treat that list as the contract your final `SELECT` must match column-for-column. Decide this list *before* writing SQL, not after — building the projection to a pre-stated list is far more reliable than reviewing for omissions at the end.
5. **Query** -
   - Prefer `sl_query` when the semantic layer covers the question.
   - Use `sql_execution` only for questions the semantic layer does not cover.
   - Before writing raw `sql_execution` SQL against a connection, call `sql_dialect_notes` with its connection id to get that engine's FQTN, identifier-quoting, date, top-N, series/calendar, rolling-window, safe-cast, and JSON conventions.
   - When authoring raw SQL, apply the `<sql_craft>` rules: build incrementally, keep window ordering deterministic, compute at full precision, and match the answer's grain to the question.
6. **Validate and explain** - sanity-check totals, filters, null handling, and time zones. **Always run the final completeness check before emitting:** re-read the question and confirm every requested output, each named entity's identity, each derived value's inputs, and the question's grain are all in the projection — see the `<sql_craft>` Final completeness check. If a result is unexpectedly empty or its grain looks wrong, work through the `<sql_craft>` Answer-completeness rules to diagnose. State the source tables or semantic-layer objects used.
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
- **Parse code/dependency text by its real grammar, not one broad regex.** When a question extracts imported/required/loaded packages or modules from stored source text or dependency manifests, parse by the *language or format*, not a single pattern: Java `import`/`import static` — drop the terminal class/member, keep the package path, and allow valid identifier segments with underscores and mixed case (e.g. com.planet_ink.coffee_mud); Python — handle both `import a, b as c` and `from a.b import c`, stripping aliases; R — handle `library(...)` and `require(...)`; notebooks (`.ipynb`) — parse the JSON and read each cell's `source` lines *before* applying the language rules (never regex the raw notebook file, whose prose contains the words "import"/"from"); JSON/manifest files — `PARSE_JSON` and flatten the dependency object's keys (e.g. `require`). Strip comments/prose lines first and split multi-import lines so each declared dependency is counted once. *Why:* a single lowercase-segment regex silently drops real identifiers and matches prose, so the ranking is wrong though the query runs.
- **Decide the counting population explicitly when a table is deduplicated.** If the source table is de-duplicated and carries a documented copy/occurrence count (e.g. a `copies` column = "repositories sharing this exact content"), the count grain is a real modeling choice: weight by that column only when the question's population is clearly the represented files/repositories; otherwise count the distinct stored rows. State which population the question names and match it — do not default to one silently. *Why:* on a deduplicated table `COUNT(*)` and `SUM(copies)` give different rankings, so the right metric depends on the population the question asks about, not on which is larger.

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

- **Canonicalize observed URL-path variants before page-level analysis.** When a question groups, filters, or sequences web pages by a `path`/`url` column, sample its distinct values first. If the data itself shows route-label variants — `/route` and `/route/` for the same page context — define a canonical page-path expression in an early CTE and use it everywhere above that CTE: preserve `/` as root, strip trailing slashes only from non-root paths, and map an observed empty path to `/` *only* when the column is a URL path and the sampled rows show blank root-page events. Do **not** merge different route names (`/input` ≠ `/regist/input`), strip query strings/fragments/host/scheme, lowercase paths, or canonicalize at all when the question asks for the raw stored URL/path or for slash-vs-no-slash differences. *Why:* raw request logs routinely store the same user-visible page both with and without a trailing slash, so grouping or sequencing the raw labels silently splits one page into several — but inventing aliases the data doesn't show would just as silently merge distinct pages.

**Composition**
- **Build incrementally.** Assemble complex queries one CTE at a time, checking each layer's output on a small sample before stacking the next; a wrong intermediate layer is far cheaper to catch early than to debug in the final number.
- **Avoid fan-out joins — the danger is cumulative.** Any one-to-many hop on the path between a measure's owning table and the aggregate inflates that measure, even when the offending join sits several hops below the `SUM`/`COUNT` and is easy to miss. The fix is the single-hop one applied per measure-owning table along the whole chain: pre-aggregate each coarse-grained measure to its own grain in a CTE, then join the already-aggregated result.
- **Verify the grain holds across each join.** As you compose, confirm a join you intend to be one-to-one / many-to-one did not change the grain you aggregate at — e.g. the row count (or the count of the aggregate's key) is unchanged across it. When a join is genuinely one-to-many, reach for the default fix (pre-aggregate to grain); for a pure count, `COUNT(DISTINCT key)` is an acceptable escape hatch. A `SUM`/`AVG` of a fanned-out measure must pre-aggregate — `DISTINCT` cannot de-duplicate a sum.
- **A join that only attaches a label must not drop rows — `LEFT JOIN` it, and key the aggregate on the fact column.** Fan-out's mirror image is just as silent: when you join a dimension table *only to fetch a display attribute* (a name for an id, a category for a product), an **incomplete** dimension — and dimensions are routinely incomplete: trimmed catalogs, late-arriving rows, slowly-changing-dimension gaps — makes a plain inner `JOIN` quietly **discard every fact row whose key has no parent**, shrinking the counts, sums, and the universe over which any share / average / median is computed (a measure halves with no error and no empty result). Two guards: (1) inner-join a dimension only when you *intend it as a filter* — you want exactly the rows that have a parent — never merely to read a column off it; for pure enrichment use `LEFT JOIN`. (2) Key the aggregation and `GROUP BY` on the **fact** column (`sales.prod_id`), not the dimension column (`products.prod_id`), so an unmatched key yields a `NULL` label on its own row rather than dropping or collapsing it. Use the same row-count check as above, but for an enrichment join confirm the fact row count is *unchanged* (not merely un-inflated); if a dimension you only wanted a name from removed rows, that is the bug.
- **Source each filter, date, and measure from the table that OWNS it at the question's grain.** When two joined fact tables carry similarly-named columns at *different* grains — a parent (one row per order: its `status`, placement `created_at`, `num_of_item`) and its child (one row per line item: line `created_at`, `sale_price`, `cost`) — read each predicate/measure from the table whose grain the question names, not from whichever is in scope after the join. "Orders that are Complete", "for each month of the orders", "the order's creation date" are *order*-grain, so the status filter and the month bucket come from the parent order row, even though the child also has `status`/`created_at` columns; line price and cost come from the child. *Why:* the parent's and child's copies of a column diverge (an item's placement month or status can differ from its order's), so anchoring an order-grain filter or calendar on the line table silently buckets/filters the wrong rows. The mirror at metric grain: never combine a parent-grain count with child rows after the join (e.g. `num_of_item * SUM(line_price)` once per line) — compute each measure at its own grain (sum line prices to the order, take `num_of_item` once per order) before combining.

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

**Ordering & aggregation determinism**
- **Make the ordering deterministic.** Give every ranking/ordering window a complete tie-breaker by appending unique key column(s) to `ORDER BY`, so `RANK`/`ROW_NUMBER`/`LAG` results are stable instead of flickering between runs.
- **Order inside string/array aggregation.** When concatenating rows into a delimited string or building an ordered array (`GROUP_CONCAT` / `string_agg` / `array_agg`), the element order is **undefined unless you specify it** — put an explicit `ORDER BY` on the aggregate. Be deliberate about collation: the default text sort is **binary/case-sensitive** (so `'BBQ'` sorts before `'Bacon'` because uppercase code points precede lowercase), which differs from a case-insensitive sort; pick the one the question implies and apply it consistently (`ORDER BY ... COLLATE NOCASE` for case-insensitive). *Why:* an unordered or differently-collated concatenation produces a string with the right elements in the wrong order — runnable but not matching the expected text.
- **Emit a list-valued answer cell as a delimited STRING, not a raw ARRAY/repeated column.** When the answer needs several values in one cell (a set of names/codes/tags for an entity), build a delimited scalar with `STRING_AGG(x, ',' ORDER BY x)` (or `ARRAY_TO_STRING(ARRAY_AGG(x ORDER BY x), ',')`) — do not return a SQL `ARRAY`/repeated column. *Why:* an array column serializes to an engine-specific representation (e.g. `['a' 'b']` or `["a","b"]`) that won't compare equal to a plain delimited list (`a,b`), so a values-correct answer still mismatches when materialized to rows.
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
- **Integer division truncates on postgres/sqlite/tsql.** The `/` operator between two integers does integer division on **postgres, sqlite, and SQL Server** — `5 / 2` is `2`, `wins / games` is `0` — so a rate, share, or `SUM(a) / COUNT(*)` silently floors to an integer. Cast one operand to a fractional type before dividing: `wins * 1.0 / games`, `CAST(wins AS REAL) / games`, or `SUM(a)::numeric / COUNT(*)`, then round at the end. mysql and bigquery already return a fractional result from `/` (on bigquery prefer `SAFE_DIVIDE` to also guard a zero denominator).
- **Round only at the end.** Compute at full precision and round in the final projection, never inside intermediate CTEs. Be explicit about truncation: an integer cast (`CAST(x AS INT)`) truncates toward zero, so use explicit rounding when rounding is what you mean.
- **Macro vs micro average.** Match the average to the wording. "Average of per-group averages" is `AVG(group_metric)`; an "overall" or "weighted" average is `SUM(numerator) / SUM(denominator)`. The two diverge whenever group sizes differ.

**Answer completeness / interpretation**
- **"Top / highest / most / lowest"** returns only the winning row(s) — keep the top-ranked row from the window result — not the full ranked list, unless the question asks for a list.
- **"For each X / per X / by X"** returns exactly one row per X. Do not collapse to a single value unless the question says "overall" or "total across X".
- **A named business measure means its amount, not a row count.** When a question asks for "sales", "revenue", "spend", "value", or "volume" of money/goods without an explicit "number / count of", aggregate the monetary/quantity **amount** (`SUM(price)` / `SUM(amount)`), not `COUNT(*)` of rows. *Why:* "toy sales" reads as sales revenue; counting order rows silently answers a different question.
- **Answer literally — do not add unrequested transformations.** Apply exactly the filters, joins, grouping, and computation the question (and any `external_knowledge` doc) states; do not add "helpful" extras the task never asked for — extra status/category predicates, area/residential *weighting* of an average the question states plainly, entity-name *normalization* that forces joins the source leaves unmatched, or a re-derived value where the question names a specific stored measure/column. When the wording bounds an **aggregate** ("committees whose *total* is between $0 and $200", "entities with 5+ orders"), filter the aggregate with `HAVING`, not each row with `WHERE`. When an `external_knowledge` doc gives an explicit formula or function/UDF definition, implement it **verbatim** — same operators, constants, and ordering — rather than substituting your own "more correct" math. *Why:* each unrequested predicate silently drops valid rows, each unrequested weighting/normalization or re-derivation changes the value, and a row-level filter for an aggregate bound answers a different question — so a more-sophisticated-looking query is wrong against the literal ask. Prefer the simplest reading that satisfies the question.
- **Don't project free-text columns the question didn't ask for.** A description/body/comment/notes column whose values contain commas or newlines corrupts the row-delimited output and is almost never the requested value — leave it out of the final projection unless the question explicitly asks for it.
- **"Inter-event duration / gap / interval" is the time between consecutive events, not a magnitude.** When the question asks the typical gap/interval/time *between* occurrences (releases, visits, orders), order rows by the event timestamp and take `LEAD`/`LAG` date differences, then aggregate — never a duration/length/runtime *column*.
- **Anchor a period bucket to the lifecycle event the wording names.** When a record carries several lifecycle timestamps (created/placed, approved, shipped, delivered, completed, settled) and the question counts/measures records in a *named completed state* by period ("delivered orders by month", "shipped items per week", "completed payments by day"), bucket the period by that named event's own timestamp (`order_delivered_customer_date`, `shipped_at`, `settled_at`) — the state value is the qualifying filter, the matching timestamp is the time anchor. Use the creation/placed/purchased/submitted timestamp only when the question names that *start* event (purchased, placed, created, ordered, submitted) or no matching event timestamp exists. If several timestamps fit, pick the one for the event as experienced by the question's subject (customer delivery = the customer-receipt date, not the carrier-handoff or estimated date). If the named state is used only as a non-temporal filter (counts by customer/city/seller with no period bucket), it is just a filter — introduce no date anchor. Confirm each timestamp's meaning from column names, semantic-layer descriptions, and sample rows first. *Why:* bucketing a completed-state count by the record's creation date silently answers a different question — "records that later reached that state, grouped by when they started" — than the one asked.
- **"Highest / most across several achievements" aggregates per metric over the whole history.** When a question asks for top values across multiple metrics or a career/lifetime total ("most runs, most wickets, longest span"), emit one row per metric with that metric summed/maxed over all the entity's records — not a single top-season or top-row snapshot.
- **An aggregate scoped to a per-entity selected set is computed across that set.** "The average revenue per actor **in those top-3 films**", "the mean order value over each customer's **last 5 orders**" means, per entity, the aggregate over the items it selected — one value per entity spanning its chosen items — NOT the per-item value. The per-item formula the question gives ("divide film revenue among its actors") computes each item's contribution; the average/total then spans the selected items. When the question states both a per-item computation AND an aggregate over the items, compute and project BOTH (the per-item value and the across-set aggregate, e.g. `AVG(item_value) OVER (PARTITION BY entity)`). The set is chosen by the ranking measure the question names — "top-N **revenue-generating** films" ranks each entity's items by the item's **own total revenue** — and that ranking is independent of the per-item value (the share), which feeds only the aggregate, never the top-N selection.
- **Coverage over a selected group is a set-membership aggregate (one value for the whole group), not a per-entity metric.** When a question first selects a group of entities ("the top 5 actors", "these products", "the eligible stores") and then asks what count/share/percentage of a **different** subject domain has any relationship to *these* selected entities ("what % of **customers** rented films featuring these actors"), the subject set is the **UNION across the whole group**: select the entity ids in a CTE, join to the subject facts, `COUNT(DISTINCT subject_id)` **once** across the group, and return one aggregate at the subject-domain grain (with the numerator/denominator projected if the question states a ratio). Counting the subject per selected entity and reporting N rows answers a different question and double-counts subjects that relate to more than one entity. This is the **collective-coverage** cousin of the per-entity rule above: emit one row per selected entity **only** when the wording says "for each / per / by / list" or asks for each entity's *own* metric ("top 5 players **and their** batting averages"); a bare "what share … of these" is one collective value.
- **Complete the panel for "each / every / all / per <period or category>".** These cues mean the answer's rows should be the *full expected domain* — every month in the asked range, every region in the dimension — not only the groups that happen to have fact rows; a plain inner `GROUP BY` emits only non-empty groups, so empty periods/categories silently drop and a "12 months" answer comes back short. Build the full set of groups (the **spine**), `LEFT JOIN` the aggregated facts onto it, then default the gaps:
  - **Spine source.** For a category, take the distinct domain from the **dimension/entity table** (e.g. every region from `regions`) — not `SELECT DISTINCT` over the facts, which can only list categories that already occur; with no dimension table, distinct values from the *unfiltered* facts are the best available domain. For a period or number range, generate the series across the question's stated range (when the range is "all periods present", derive its bounds from `MIN`/`MAX` over the *unfiltered* facts). Series syntax is engine-specific — get the series/calendar idiom from `sql_dialect_notes` rather than inlining one dialect's generator.
  - **Default by additivity.** `COALESCE(metric, 0)` only for **additive** measures (a `COUNT`/`SUM` of events or amounts, where "no activity" genuinely reads as 0); leave **non-additive** measures (`AVG`, a rate, a ratio, a price, a running balance) as `NULL` — absence is "no data", and 0 would be a wrong reading.
  - **Don't over-apply.** *each / every / all* wants the complete domain; *which / that have* ("which months had orders") wants only the groups that exist — there the spine is wrong, so emit observed groups only.
  - **Selecting the extreme group needs the spine too.** When you pick the group with the highest/lowest count or total over a period/category domain ("the month with the **lowest** number of active customers", "the region with the **fewest** orders"), rank over the COMPLETE spine, not only groups that have fact rows — an empty period/category is a genuine 0 and is frequently the true minimum, yet ranking over observed groups alone silently makes it unselectable and returns the wrong extreme. A period with NO rows at all never appears in a `GROUP BY` of the facts: generate the full calendar of the stated range first ("each month of 2020" → all 12 months, even if only 4 have transactions), `LEFT JOIN` the per-group aggregates, `COALESCE` the count to 0, and only THEN rank — otherwise a zero-activity month that is the true lowest is invisible to the ranking.
- **Answer every requested output.** When a question asks for several things — a list ("A, B, and C"), paired extremes ("the highest *and* the lowest"), or a value plus its components ("X, Y, and their ratio") — the projection needs one column per requested output, not just the first clause. *Why:* answering only the first clause is the most common way a runnable query is still wrong — the grain and methodology can be perfect yet the answer is short by columns. This is the umbrella over the next two rules: *keep the inputs* is its "value + components" case and *expose identity* is its "entity identity" case, so a **complete projection** is exactly every requested metric/attribute, plus the identifier of each named entity, plus the inputs to each derived value, at the question's grain. It governs *which columns* appear — distinct from *Top …* and *For each X* above, which govern *which rows* — and composes with them ("highest and lowest per region" needs one row per region and a column per clause).
- **Keep the inputs to a derived value.** When the question asks for inputs and something derived from them ("X, Y, and their ratio"), project the inputs as columns alongside the derived value.
- **A comparison BETWEEN two specific extremes is one wide row.** When the question asks for a single value derived by comparing two named extremes — "the **difference between** the highest and the lowest month", "the ratio of the best to the worst" — present BOTH extremes side by side in ONE row: each extreme's attributes as their own columns (e.g. `highest_month`, `highest_value`, `lowest_month`, `lowest_value`) plus the comparison as a column (`difference`). The comparison is a single fact about the pair, so the answer is one wide row — NOT one row per extreme with the comparison repeated. (Contrast: "report a metric **for each** group/category" — e.g. "a percentage for each helmet group", "the top player for each outcome" — has no cross-item comparison and stays long, one row per group.)
- **Project BOTH identity and label.** When the result is per-entity, project the entity's **identifier and its human-readable name together** — whichever you grouped by, add the other. The id disambiguates duplicate names, and a consumer may legitimately expect either; supplying both is the safe, complete choice (a per-entity answer that gives only one is a frequent cause of an otherwise-correct result not matching).
- **Diagnose empty results.** When a result is unexpectedly empty, relax filters one at a time to find which predicate removed the rows instead of guessing.
- **Spatial predicates ("within area / within N meters / inside this polygon / nearest").** When a question filters or relates rows by geography, use the engine's geospatial functions — get the exact ones from `sql_dialect_notes` — rather than hand-rolling latitude/longitude `BETWEEN` boxes (which are wrong off the equator and ignore polygon shape). Recipe: (1) turn each location into a geography point with the point constructor — **mind argument order, most take longitude before latitude**; (2) for an area of interest build a polygon from its boundary/corner coordinates, closing the ring (first point repeated last); (3) test the relation with the engine's containment (`contains`/`within`), proximity (`dwithin(g1,g2,meters)`), or overlap (`intersects`) predicate. For "the features within the same area as entity X", first resolve X's own geometry in a CTE, then join candidates on the spatial predicate against it. *Why:* spatial relationships are not axis-aligned ranges; the geodesic predicates are both correct and index-assisted, while a raw coordinate box silently includes/excludes the wrong rows.
- **Collapse a multi-valued attribute to one representative per entity before counting classes or a concentration metric.** When an entity carries a multi-valued classification array (IPC/CPC codes, tags, categories) and the methodology counts *entities per class* or computes a concentration/diversity measure (HHI, originality, a share), pick exactly **one representative value per entity** in a CTE first — use the array's `main`/`primary`/`first` flag when present, else a defined fallback (e.g. the most-frequent value) — then aggregate. Equally, when a metric's denominator is defined as a count of **entities** ("the number of patents cited"), use `COUNT(DISTINCT entity)`, not the count of exploded array rows. *Why:* `LATERAL FLATTEN`/unnest of the array multiplies an entity's weight by how many codes it has, inflating per-class frequencies and skewing any concentration metric — the query runs but the ranking/score is wrong. (Take the representative rule from the methodology/`external_knowledge` doc when it specifies one; do not invent a selection the source does not state.)
- **Final completeness check.** Before emitting the final SQL, re-read the question and confirm the projection covers: (1) every named **metric / attribute** asked for (→ *answer every requested output*); (2) the **identifier** of each grouped or named entity (→ *expose identity*); (3) every **input** to each derived value (→ *keep the inputs*); (4) all at the **grain** the question specifies (→ *for each X* / *complete the panel*). Run this on every query, not only when a result looks off. **Don't over-project:** anything outside that set — a column the question never asked for, added "to be safe" — adds noise, misleads the reader into thinking it matters, and makes the result harder to consume. Match the request exactly: neither short nor padded.

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

```sql
-- "For each region, report the highest and the lowest monthly order count and the
-- difference between them." A complete answer is five columns: the region's id and
-- name, the highest, the lowest, and their difference.
-- WRONG: answers only the first clause and drops the region id, the lowest, and the
-- difference — four of the five requested columns are missing.
SELECT region_name, MAX(monthly_orders) AS highest
FROM region_monthly
GROUP BY region_name;

-- RIGHT: one column per requested output plus the entity's identity, at the region
-- grain — id and name, the highest, the lowest, and their difference.
SELECT r.region_id, r.region_name,
       MAX(rm.monthly_orders) AS highest,
       MIN(rm.monthly_orders) AS lowest,
       MAX(rm.monthly_orders) - MIN(rm.monthly_orders) AS order_count_range
FROM regions r
JOIN region_monthly rm ON rm.region_id = r.region_id
GROUP BY r.region_id, r.region_name;
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
