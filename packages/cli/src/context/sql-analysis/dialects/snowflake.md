**snowflake** SQL conventions:
- **FQTN:** three-part `DATABASE.SCHEMA.TABLE` (e.g. `analytics.public.orders`).
- **Identifiers:** unquoted names fold to UPPER-case; double-quote for a case-sensitive or reserved name — `orders` resolves to `"ORDERS"`, which is a different object from `"orders"`.
- **Date/time:** `DATE_TRUNC('month', ts)`, `TO_DATE(s[, fmt])`, `DATEADD(day, -7, CURRENT_DATE)`, `CURRENT_DATE`.
- **Top-N / windows:** `QUALIFY` filters on a window result without a subquery, e.g. `QUALIFY ROW_NUMBER() OVER (PARTITION BY ... ORDER BY ...) = 1`.
- **Semi-structured (VARIANT):** traverse with a colon path and cast with `::`, e.g. `src:vehicle[0].make::string`, `payload:events.date::date`; expand arrays with `LATERAL FLATTEN`.
