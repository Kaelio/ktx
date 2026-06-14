**mysql** SQL conventions:
- **FQTN:** `database.table` (MySQL has no separate schema layer — a schema is a database).
- **Identifiers:** quote with backticks (`` `order` ``); table-name case-sensitivity follows the server filesystem, while column names are case-insensitive.
- **Date/time:** `DATE_FORMAT(ts, '%Y-%m')`, `STR_TO_DATE(s, fmt)`, `YEAR(ts)`/`MONTH(ts)`, `CURDATE()`, `NOW()`.
- **Top-N / windows:** rank in a CTE with `ROW_NUMBER() OVER (...)` and filter outside it; use `ORDER BY ... LIMIT n` for a global top-N.
- **JSON:** `JSON_EXTRACT(col, '$.k')`, or the `col->'$.k'` / `col->>'$.k'` shortcuts (`->>` unquotes to text).
