**bigquery** SQL conventions:
- **FQTN:** backtick-quoted `` `project.dataset.table` `` (e.g. `` `my-proj.analytics.orders` ``); backticks are required when a name contains a dash.
- **Identifiers:** backtick to quote; column and field names are case-insensitive, dataset and table names are case-sensitive.
- **Date/time:** `DATE_TRUNC(d, MONTH)`, `EXTRACT(YEAR FROM ts)`, `PARSE_DATE('%Y-%m-%d', s)`, `FORMAT_DATE('%Y-%m', d)`, `CURRENT_DATE()`.
- **Series:** build a spine with `UNNEST(GENERATE_DATE_ARRAY('2023-01-01', '2023-12-01', INTERVAL 1 MONTH))` for dates (or `GENERATE_ARRAY(1, n)` for integers), then `LEFT JOIN` the aggregated facts onto it so empty periods still appear.
- **Rolling window over time:** `RANGE` frames are numeric, so range over an integer day key — `AVG(amount) OVER (ORDER BY UNIX_DATE(day) RANGE BETWEEN 29 PRECEDING AND CURRENT ROW)` is a trailing 30-day average that tolerates gaps; or build a spine (see **Series**) and use a `ROWS` frame.
- **Safe cast:** `SAFE_CAST(x AS FLOAT64)` (or `SAFE_CAST(x AS NUMERIC)`) returns `NULL` instead of erroring on a value that does not parse, so counting residual `NULL`s among non-sentinel rows catches an encoding the sample missed.
- **Top-N / windows:** `QUALIFY` filters on a window result, e.g. `QUALIFY ROW_NUMBER() OVER (PARTITION BY ... ORDER BY ...) = 1`.
- **JSON:** `JSON_VALUE(col, '$.k')` returns a scalar STRING, `JSON_QUERY(col, '$.k')` returns a subtree.
- **Sharded tables:** query a wildcard table `` `dataset.events_*` `` and filter the shard with the `_TABLE_SUFFIX` pseudo-column, e.g. `WHERE _TABLE_SUFFIX BETWEEN '20240101' AND '20240131'`.
