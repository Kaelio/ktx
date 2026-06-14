**postgres** SQL conventions:
- **FQTN:** `schema.table` (e.g. `public.orders`); one query targets a single database, so qualify by schema, not by database.
- **Identifiers:** unquoted names fold to lower-case; double-quote (`"Name"`) only to keep case or use a reserved word.
- **Date/time:** `date_trunc('month', ts)`, `EXTRACT(YEAR FROM ts)`, `to_char(ts, 'YYYY-MM')`, `CURRENT_DATE`; cast text to a date with `col::date`.
- **Top-N / windows:** rank in a CTE with `ROW_NUMBER() OVER (PARTITION BY ... ORDER BY ...)` and filter in the outer query, or use `DISTINCT ON (key) ... ORDER BY key, ...` for one row per key.
- **JSON:** `col->'k'` returns json, `col->>'k'` returns text, deep path `col#>>'{a,b}'`; prefer `jsonb` operators on `jsonb` columns.
