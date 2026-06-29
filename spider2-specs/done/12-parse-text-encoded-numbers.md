# Parse text-encoded numeric columns before doing math on them

## Problem

Numeric measures are often stored as **text** with human formatting: unit suffixes
(`"1.2K"`, `"3M"`, `"4B"`), currency symbols and thousands separators (`"$1,200"`),
percent signs (`"12%"`), or non-numeric sentinels for missing/zero (`"-"`, `"N/A"`,
`""`). Aggregating or comparing such a column directly is silently wrong: string
comparison orders `"100" < "9"`, and a naive `CAST(x AS REAL)` yields `0`/NULL on
the formatted values rather than the intended number.

The agent already samples schemas (spec 07 schema-discovery), but when it sees a
"numeric" column it tends to assume it is a real number type and skips the parse —
so the arithmetic runs on garbage. Runnable, plausible, wrong.

## Generic use case (independent of any benchmark)

A `trade_volume` column stored as `"1.2K" / "3M" / "-"` must become `1200 / 3000000
/ 0` before you can sum it or compute a daily change. A `price` stored as
`"$1,299.00"` must become `1299.00` before averaging. This is routine data hygiene
on real, messy production tables.

## Requirements

Extend the `ktx-analytics` skill's `<sql_craft>` "Schema discovery before writing
SQL" group (inline, dialect-agnostic, heuristic + why).

1. **Detect text-encoded numerics during sampling.** When a column that the
   question treats as a number is stored as text, sample distinct values to learn
   the encodings actually present (suffixes, symbols, separators, sentinels) before
   composing — never assume the format from the column name.

2. **Parse and scale before arithmetic.** Strip currency/separator/percent
   characters; multiply by the suffix scale (K=10^3, M=10^6, B=10^9); map sentinels
   (`-`, `N/A`, empty) to `0` or `NULL` per the question's intent; then cast to a
   numeric type. Do this in an early CTE so all downstream math sees clean numbers.
   *Why:* string columns compared/aggregated as-is sort lexically and cast to 0,
   producing silently wrong results instead of errors.

3. **Confirm coverage.** After parsing, sanity-check that no intended-numeric value
   failed to parse (would surface as NULL), to catch an encoding the sample missed.

## Leak-safety (hard constraint)

Worked examples must use a **synthetic generic schema** and made-up values (e.g. a
`metrics(label, value_text)` table with `"1.2K"`, `"-"`). No benchmark table names,
SQL, or result values; the parsing pattern is universal and tied to no instance.

## Acceptance criteria

- `<sql_craft>` schema-discovery gains the detect → parse/scale → verify guidance —
  inline, dialect-agnostic, with at most one short generic example.
- No benchmark-derived content. Skill-content only; content tests updated.

## Benchmark context (motivation only)

At least one SQLite-subset question stores trading volume as suffix-encoded text
("K"/"M", "-" for zero) and fails because the agent aggregates the raw strings. The
fix — parse messy encodings before math — is universal data hygiene that helps any
analyst, so it belongs in the product's craft rather than a benchmark-specific
prompt.
