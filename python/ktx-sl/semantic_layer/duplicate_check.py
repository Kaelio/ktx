"""Detect semantically-redundant measure definitions on the same source."""

from __future__ import annotations

import sqlglot
from sqlglot import exp

from semantic_layer.models import SourceDefinition
from semantic_layer.parser import quote_reserved_identifiers

# DIALECT CONVENTION:
#   Measure `expr` values are compared structurally. They must be parsed with
#   the connection's native dialect (per sl_capture); parsing as postgres
#   would drop dialect-specific tokens and miss duplicates across BigQuery
#   `SAFE_DIVIDE` / Snowflake `DIV0` etc.


def validate_measure_duplicates(
    sources: dict[str, SourceDefinition],
    *,
    dialect: str = "postgres",
) -> list[str]:
    """
    Flag pairs of measures on the same source whose `expr` is structurally
    equivalent. Intended to prevent capture-time churn like:

        - name: active_subscription_count
          expr: count(*)
          filter: is_active = true
        - name: new_subscription_count
          expr: count(*)             # same base aggregation — should be query-time filter

    Returns a list of human-readable error strings (empty list = no duplicates).
    Compares every pair of measures within a single source; does not compare
    across sources (measures on different sources are never redundant).
    """
    errors: list[str] = []
    for source_name, source in sources.items():
        if len(source.measures) < 2:
            continue

        parsed: list[tuple[str, exp.Expression | None, str | None, frozenset[str]]] = []
        for m in source.measures:
            try:
                quoted = quote_reserved_identifiers(m.expr, dialect)
                tree = sqlglot.parse_one(f"SELECT {quoted}", read=dialect)
                expr_node = tree.expressions[0] if tree.expressions else None
            except Exception:
                # Unparseable expressions are left for the caller's normal
                # validation to surface; don't block on parse failure here.
                expr_node = None
            parsed.append((m.name, expr_node, m.filter, frozenset(m.segments)))

        for i, (name_a, expr_a, filter_a, segments_a) in enumerate(parsed):
            if expr_a is None:
                continue
            for name_b, expr_b, filter_b, segments_b in parsed[i + 1 :]:
                if expr_b is None:
                    continue
                if not _expressions_equivalent(expr_a, expr_b):
                    continue

                # Segments are named, reusable filter predicates; two measures
                # sharing an expr but applying different segments are by design
                # distinct and must not be flagged.
                if segments_a != segments_b:
                    continue

                fa = (filter_a or "").strip()
                fb = (filter_b or "").strip()
                if fa == fb:
                    errors.append(
                        f"{source_name}: measures '{name_a}' and '{name_b}' have the same "
                        f"expression and filter — remove one or differentiate them."
                    )
                else:
                    errors.append(
                        f"{source_name}: measure '{name_b}' has the same expression as "
                        f"'{name_a}' — differs only by `filter`. Use query-time filtering "
                        f"on '{name_a}' (via semantic_query filters), or, if the filter "
                        f"encodes a named business segment, add a segments[] entry on this "
                        f"source and reference it instead."
                    )
    return errors


def _expressions_equivalent(a: exp.Expression, b: exp.Expression) -> bool:
    """
    Structural equality on sqlglot ASTs.

    Normalizes via sqlglot's .sql() canonical form (handles whitespace, case,
    aliasing). Does NOT reorder operands — `safe_divide(a, b)` is NOT equal to
    `safe_divide(b, a)`, nor is `a - b` equal to `b - a`. This is deliberate:
    the check's purpose is catching accidental redundancy, not proving
    mathematical equivalence.
    """
    if type(a) is not type(b):
        return False
    return a.sql(dialect="postgres") == b.sql(dialect="postgres")
