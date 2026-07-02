**clickhouse** SQL conventions:
- **FQTN:** `database.table` (e.g. `analytics.orders`).
- **Identifiers:** quote with backticks (`` `Order` ``) or double quotes; identifiers are case-sensitive.
- **Date/time:** native `Date`/`DateTime` types. Bucket with `toStartOfMonth(ts)`, `toStartOfDay(ts)`, `toYYYYMM(ts)`; parse with `toDate(s)` / `parseDateTimeBestEffort(s)`; format with `formatDateTime(ts, '%Y-%m')`.
- **Series:** `numbers(n)` / `range(n)` generate an integer sequence; offset a start date with `addMonths(toDate('2023-01-01'), number)` (or `arrayJoin`) to form a spine, then `LEFT JOIN` the aggregated facts onto it so empty periods still appear.
- **Rolling window over time:** a numeric range frame over a `Date` column counts in days and tolerates gaps — `AVG(amount) OVER (ORDER BY day RANGE BETWEEN 29 PRECEDING AND CURRENT ROW)` is a trailing 30-day average (use seconds for a `DateTime` key; the `INTERVAL` form is unsupported); or build a spine (see **Series**) and use a `ROWS` frame.
- **Safe cast:** `toFloat64OrNull(x)` / `toDecimal64OrNull(x, s)` returns `NULL` on a value that does not parse (the `...OrZero` variants return `0` instead), so counting residual `NULL`s among non-sentinel rows catches an encoding the sample missed.
- **Top-N / windows:** use the `LIMIT n BY key` clause for n rows per key, or rank in a CTE with `ROW_NUMBER() OVER (...)` and filter outside it.
- **JSON:** extract from a String column with `JSONExtractString(col, 'k')`, `JSONExtractInt(col, 'k')`, etc.; a native `JSON`-typed column is traversed by dot path `col.k`.
