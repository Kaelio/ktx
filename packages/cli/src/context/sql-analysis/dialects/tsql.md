**tsql** (SQL Server) SQL conventions:
- **FQTN:** `schema.table` (e.g. `dbo.orders`), or `database.schema.table` across databases.
- **Identifiers:** quote with square brackets (`[Order]`), or double quotes when `QUOTED_IDENTIFIER` is on; case-sensitivity is set by the database collation (commonly case-insensitive).
- **Date/time:** `DATEPART(year, ts)`, `DATEADD(day, -7, ts)`, `DATEDIFF(day, a, b)`, `CONVERT(date, ts)`, `FORMAT(ts, 'yyyy-MM')`, `GETDATE()`.
- **Top-N / windows:** `SELECT TOP (n) ... ORDER BY ...` for a global top-N; for per-group, rank in a CTE with `ROW_NUMBER() OVER (...)` and filter in the outer query.
- **JSON:** `JSON_VALUE(col, '$.k')` returns a scalar, `JSON_QUERY(col, '$.k')` returns an object/array, and `OPENJSON(col)` shreds JSON into rows.
