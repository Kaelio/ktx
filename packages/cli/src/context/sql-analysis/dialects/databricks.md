**databricks** SQL conventions:
- **FQTN:** Unity Catalog uses three-part `catalog.schema.table` names, e.g. `main.sales.orders`.
- **Identifiers:** quote reserved, mixed-case, or special-character names with backticks; escape a literal backtick by doubling it.
- **Date/time:** use `date_trunc('month', ts)`, `to_date(s[, fmt])`, `dateadd(day, -7, current_date())`, and `current_timestamp()`.
- **Series:** generate date spines with `sequence(start_date, end_date, interval 1 day)` plus `explode(...)`, then left join facts onto the spine.
- **Rolling window over time:** use an interval range frame over a timestamp order key, e.g. `avg(amount) over (order by event_ts range between interval 29 days preceding and current row)`.
- **Safe cast:** `try_cast(x AS DECIMAL(12,2))` returns `NULL` instead of failing when a value does not parse.
- **Top-N / windows:** Databricks supports `QUALIFY`, so `QUALIFY row_number() OVER (PARTITION BY ... ORDER BY ...) = 1` avoids a subquery.
- **Semi-structured:** use `from_json` for typed JSON, `get_json_object` for string paths, and `explode` / `posexplode` for arrays.
- **Sampling:** `TABLESAMPLE` is available, but exact row limits are clearer with `ORDER BY rand() LIMIT n` when a small randomized sample is required.
