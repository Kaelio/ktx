**clickhouse** SQL conventions:
- **FQTN:** `database.table` (e.g. `analytics.orders`).
- **Identifiers:** quote with backticks (`` `Order` ``) or double quotes; identifiers are case-sensitive.
- **Date/time:** native `Date`/`DateTime` types. Bucket with `toStartOfMonth(ts)`, `toStartOfDay(ts)`, `toYYYYMM(ts)`; parse with `toDate(s)` / `parseDateTimeBestEffort(s)`; format with `formatDateTime(ts, '%Y-%m')`.
- **Top-N / windows:** use the `LIMIT n BY key` clause for n rows per key, or rank in a CTE with `ROW_NUMBER() OVER (...)` and filter outside it.
- **JSON:** extract from a String column with `JSONExtractString(col, 'k')`, `JSONExtractInt(col, 'k')`, etc.; a native `JSON`-typed column is traversed by dot path `col.k`.
