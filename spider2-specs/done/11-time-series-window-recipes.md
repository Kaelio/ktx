# Time-series window craft — running totals, rolling-N (min-periods), period-over-period

## Problem

A large share of analytics questions are time-series shaped: a **running/cumulative
balance**, a **rolling N-day average**, or **period-over-period growth**. The agent
knows window functions exist (spec 07 covers determinism and window-then-filter) but
gets the *time-series specifics* wrong:

- cumulative balance computed without an unbounded preceding frame (or with the
  frame defaulting incorrectly when there are ties on the order key);
- "rolling 30-day" implemented as `ROWS BETWEEN 29 PRECEDING` over **gappy** daily
  data, so the window spans the wrong calendar span when days are missing;
- no **minimum-periods** handling — a rolling average is reported before the window
  is actually full;
- "growth vs previous period" without `LAG`, or comparing to the wrong neighbor.

These are runnable-but-wrong; the structure is close, the edge case diverges.

## Generic use case (independent of any benchmark)

- "Each account's month-end running balance over 2023" — cumulative sum of monthly
  net over an ordered window.
- "30-day rolling average of daily revenue, only once 30 days of history exist."
- "Month-over-month revenue growth rate."

All three are bread-and-butter for any analyst on any time-series table.

## Requirements

Additive to the `ktx-analytics` skill's `<sql_craft>` "Window functions" group
(inline, dialect-agnostic, heuristic + why).

1. **Cumulative / running total.** `SUM(x) OVER (PARTITION BY k ORDER BY t ROWS
   BETWEEN UNBOUNDED PRECEDING AND CURRENT ROW)`, with a complete tie-breaker in
   `ORDER BY` (spec 07 rule). *Why:* the default frame with a non-unique `ORDER BY`
   can include/exclude peers unexpectedly.

2. **Rolling window over time, not over rows.** When "rolling N days/months" is
   asked, the window must span a calendar range. Over gappy data, either build a
   complete date spine first (see spec 10) so `ROWS BETWEEN n-1 PRECEDING` equals
   the intended span, or use a range/self-join keyed on the date. *Why:* row-count
   frames over missing dates silently measure the wrong span.

3. **Minimum periods.** When the question says "only after N periods of data" (or
   it is implied by a rolling metric), emit NULL/skip until the window is full
   (e.g. guard on `COUNT(*) OVER (...) = N`). *Why:* a partial early window is not
   the requested metric.

4. **Period-over-period.** Use `LAG(metric) OVER (PARTITION BY k ORDER BY period)`
   for prior-period comparisons; growth rate = `(cur - prev) / prev` computed at
   full precision (round only at the end). Guard divide-by-zero/NULL prev.

## Leak-safety (hard constraint)

Worked examples must use a **synthetic generic schema** (e.g. `daily_revenue(day,
amount)` or `account_txns(account_id, txn_date, net)`) and show only the *pattern*.
No benchmark table names, SQL, or result values.

## Acceptance criteria

- `<sql_craft>` "Window functions" gains the cumulative, rolling-over-time +
  min-periods, and period-over-period recipes — inline, dialect-agnostic.
- At most one or two compact generic examples; no benchmark-derived content.
- Skill-content only; analytics-skill content tests updated.

## Benchmark context (motivation only)

Running-balance / rolling / period-over-period questions are the single largest
result-mismatch cluster in the SQLite subset (financial-transactions style DBs).
The methodology is universal analyst craft, so it belongs in the product's skill
(transfers to real users), not in a benchmark-specific prompt. Depends on spec 10
(date spine) for the gappy-rolling case.
