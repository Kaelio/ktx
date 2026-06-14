**sqlite** SQL conventions:
- **FQTN:** usually the bare `table`; `main.table` to be explicit, `attached.table` for an attached database.
- **Identifiers:** case-insensitive; double-quote (`"Name"`) to preserve a name with spaces or a keyword.
- **Date/time:** there is no native date type — values are TEXT, INTEGER, or REAL. Format and bucket with `strftime('%Y-%m', col)`, `date(col)`, `datetime(col)`, and take day differences with `julianday(a) - julianday(b)`. Confirm the stored encoding (ISO text vs Unix epoch) before comparing.
- **Top-N / windows:** rank in a CTE with `ROW_NUMBER() OVER (...)` and filter in the outer query; use `ORDER BY ... LIMIT n` for a global top-N.
- **JSON:** `json_extract(col, '$.k')`, or the `col->'$.k'` / `col->>'$.k'` operators (`->>` returns text).
