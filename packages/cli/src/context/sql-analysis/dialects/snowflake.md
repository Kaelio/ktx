**snowflake** SQL conventions:
- **FQTN:** three-part `DATABASE.SCHEMA.TABLE` (e.g. `analytics.public.orders`).
- **Identifiers:** unquoted names fold to UPPER-case; double-quote for a case-sensitive or reserved name — `orders` resolves to `"ORDERS"`, which is a different object from `"orders"`.
- **Date/time:** `DATE_TRUNC('month', ts)`, `TO_DATE(s[, fmt])`, `DATEADD(day, -7, CURRENT_DATE)`, `CURRENT_DATE`.
- **Series:** generate rows with `TABLE(GENERATOR(ROWCOUNT => n))` and offset a start date via `DATEADD('month', SEQ4(), '2023-01-01')` (or a recursive CTE) to form a spine, then `LEFT JOIN` the aggregated facts onto it so empty periods still appear.
- **Rolling window over time:** a native interval range frame over a date/timestamp order key tolerates gaps — `AVG(amount) OVER (ORDER BY day RANGE BETWEEN INTERVAL '29 days' PRECEDING AND CURRENT ROW)` is a trailing 30-day average without a spine; guard minimum periods with `COUNT(*) OVER (<same frame>)`.
- **Safe cast:** `TRY_TO_NUMBER(x)` / `TRY_TO_DECIMAL(x, p, s)` (or `TRY_CAST(x AS NUMBER)`) returns `NULL` instead of erroring on a value that does not parse, so a residual-`NULL` count among non-sentinel rows catches an encoding the sample missed.
- **Top-N / windows:** `QUALIFY` filters on a window result without a subquery, e.g. `QUALIFY ROW_NUMBER() OVER (PARTITION BY ... ORDER BY ...) = 1`.
- **Semi-structured (VARIANT):** traverse with a colon path and cast with `::`, e.g. `src:vehicle[0].make::string`, `payload:events.date::date`; expand arrays with `LATERAL FLATTEN`.
