**postgres** SQL conventions:
- **FQTN:** `schema.table` (e.g. `public.orders`); one query targets a single database, so qualify by schema, not by database.
- **Identifiers:** unquoted names fold to lower-case; double-quote (`"Name"`) only to keep case or use a reserved word.
- **Date/time:** `date_trunc('month', ts)`, `EXTRACT(YEAR FROM ts)`, `to_char(ts, 'YYYY-MM')`, `CURRENT_DATE`; cast text to a date with `col::date`.
- **Series:** build a date/number spine with `generate_series('2023-01-01'::date, '2023-12-01'::date, interval '1 month')` (or `generate_series(1, n)` for integers), then `LEFT JOIN` the aggregated facts onto it so empty periods still appear.
- **Rolling window over time:** a native calendar-range frame spans real dates and tolerates gaps — `AVG(amount) OVER (ORDER BY day RANGE BETWEEN INTERVAL '29 days' PRECEDING AND CURRENT ROW)` is a trailing 30-day average without a spine; guard minimum periods with `COUNT(*) OVER (<same frame>)`.
- **Integer division:** `/` between two integers truncates (`5 / 2` → `2`), so a rate or `SUM(a) / COUNT(*)` silently floors to an integer; cast one operand first — `a::numeric / b` or `a * 1.0 / b` — and round only in the final projection.
- **Safe cast:** postgres has no `TRY_CAST`; guard a text-encoded number with a pattern test before casting — `CASE WHEN x ~ '^-?[0-9.]+$' THEN x::numeric END` yields `NULL` for a value that does not parse, so counting residual `NULL`s among non-sentinel rows catches an encoding the sample missed (`regexp_replace` can strip symbols, but chained `REPLACE` is the portable default).
- **Top-N / windows:** rank in a CTE with `ROW_NUMBER() OVER (PARTITION BY ... ORDER BY ...)` and filter in the outer query, or use `DISTINCT ON (key) ... ORDER BY key, ...` for one row per key.
- **JSON:** `col->'k'` returns json, `col->>'k'` returns text, deep path `col#>>'{a,b}'`; prefer `jsonb` operators on `jsonb` columns.
