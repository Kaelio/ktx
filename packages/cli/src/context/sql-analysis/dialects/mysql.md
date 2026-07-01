**mysql** SQL conventions:
- **FQTN:** `database.table` (MySQL has no separate schema layer — a schema is a database).
- **Identifiers:** quote with backticks (`` `order` ``); table-name case-sensitivity follows the server filesystem, while column names are case-insensitive.
- **Date/time:** `DATE_FORMAT(ts, '%Y-%m')`, `STR_TO_DATE(s, fmt)`, `YEAR(ts)`/`MONTH(ts)`, `CURDATE()`, `NOW()`.
- **Series:** no series function — build a spine with a recursive CTE, e.g. `WITH RECURSIVE months(d) AS (SELECT '2023-01-01' UNION ALL SELECT DATE_ADD(d, INTERVAL 1 MONTH) FROM months WHERE d < '2023-12-01')`, then `LEFT JOIN` the aggregated facts onto it so empty periods still appear.
- **Rolling window over time:** a native interval range frame over a temporal order key tolerates gaps — `AVG(amount) OVER (ORDER BY day RANGE BETWEEN INTERVAL 29 DAY PRECEDING AND CURRENT ROW)` is a trailing 30-day average without a spine; guard minimum periods with `COUNT(*) OVER (<same frame>)`.
- **Safe cast:** MySQL has no `TRY_CAST`, and `CAST('abc' AS DECIMAL)` returns `0` with a warning rather than erroring — guard with a pattern test first: `CASE WHEN x REGEXP '^-?[0-9.]+$' THEN CAST(x AS DECIMAL(18,4)) END` makes a value that does not parse `NULL`, so a residual-`NULL` count catches an encoding the sample missed (`REGEXP_REPLACE` can strip symbols).
- **Top-N / windows:** rank in a CTE with `ROW_NUMBER() OVER (...)` and filter outside it; use `ORDER BY ... LIMIT n` for a global top-N.
- **JSON:** `JSON_EXTRACT(col, '$.k')`, or the `col->'$.k'` / `col->>'$.k'` shortcuts (`->>` unquotes to text).
