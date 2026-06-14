**bigquery** SQL conventions:
- **FQTN:** backtick-quoted `` `project.dataset.table` `` (e.g. `` `my-proj.analytics.orders` ``); backticks are required when a name contains a dash.
- **Identifiers:** backtick to quote; column and field names are case-insensitive, dataset and table names are case-sensitive.
- **Date/time:** `DATE_TRUNC(d, MONTH)`, `EXTRACT(YEAR FROM ts)`, `PARSE_DATE('%Y-%m-%d', s)`, `FORMAT_DATE('%Y-%m', d)`, `CURRENT_DATE()`.
- **Top-N / windows:** `QUALIFY` filters on a window result, e.g. `QUALIFY ROW_NUMBER() OVER (PARTITION BY ... ORDER BY ...) = 1`.
- **JSON:** `JSON_VALUE(col, '$.k')` returns a scalar STRING, `JSON_QUERY(col, '$.k')` returns a subtree.
- **Sharded tables:** query a wildcard table `` `dataset.events_*` `` and filter the shard with the `_TABLE_SUFFIX` pseudo-column, e.g. `WHERE _TABLE_SUFFIX BETWEEN '20240101' AND '20240131'`.
