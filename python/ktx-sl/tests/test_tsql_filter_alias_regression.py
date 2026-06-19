"""Regression tests for T-SQL `=` filters mis-parsed as column aliases.

A top-level `col = 'value'` is T-SQL's `alias = expression` projection form, so
filters and segments must compile as predicates, not projections, on any dialect.
"""

from __future__ import annotations

import pytest
import sqlglot

from .conftest import make_engine


def _jobs_source(**overrides):
    base = {
        "name": "jobs",
        "table": "dbo.jobs",
        "grain": ["id"],
        "columns": [
            {"name": "id", "type": "number"},
            {"name": "amount", "type": "number"},
            {"name": "trade_name", "type": "string"},
            {"name": "base", "type": "number"},
            {"name": "doubled", "type": "number", "expr": "base * 2"},
        ],
        "segments": [
            {"name": "is_roofing", "expr": "trade_name = 'Roofing'"},
        ],
        "measures": [
            {
                "name": "roofing_rev",
                "expr": "sum(amount)",
                "filter": "trade_name = 'Roofing'",
            },
        ],
    }
    base.update(overrides)
    return base


def _assert_valid(sql: str, dialect: str) -> None:
    parsed = sqlglot.parse(sql, read=dialect)
    assert parsed and all(stmt is not None for stmt in parsed), sql


# Dialects whose grammar contains the `alias = expression` projection form
# alongside ones that do not, to guard the cross-dialect contract.
DIALECTS = ["tsql", "postgres", "snowflake", "bigquery"]


@pytest.mark.parametrize("dialect", DIALECTS)
def test_measure_equality_filter_compiles_as_comparison(dialect):
    engine = make_engine({"jobs": _jobs_source()}, dialect=dialect)
    sql = engine.query({"measures": ["jobs.roofing_rev"]}).sql

    _assert_valid(sql, dialect)
    assert "CASE WHEN" in sql.upper()
    assert "'Roofing'" in sql
    # The filter must remain an equality comparison, never an aliased literal.
    assert "AS trade_name" not in sql
    assert "'Roofing' AS" not in sql


@pytest.mark.parametrize("dialect", DIALECTS)
def test_segment_equality_filter_compiles_as_comparison(dialect):
    engine = make_engine({"jobs": _jobs_source()}, dialect=dialect)
    sql = engine.query(
        {"measures": ["sum(jobs.amount)"], "segments": ["jobs.is_roofing"]}
    ).sql

    _assert_valid(sql, dialect)
    assert "CASE WHEN" in sql.upper()
    assert "'Roofing' AS" not in sql


@pytest.mark.parametrize("dialect", DIALECTS)
def test_where_equality_filter_compiles_as_comparison(dialect):
    engine = make_engine({"jobs": _jobs_source()}, dialect=dialect)
    sql = engine.query(
        {"measures": ["sum(jobs.amount)"], "filters": ["jobs.trade_name = 'Roofing'"]}
    ).sql

    _assert_valid(sql, dialect)
    assert "WHERE" in sql.upper()
    assert "'Roofing' AS" not in sql


@pytest.mark.parametrize("dialect", DIALECTS)
def test_computed_column_expands_in_equality_where_filter(dialect):
    engine = make_engine({"jobs": _jobs_source()}, dialect=dialect)
    sql = engine.query(
        {"measures": ["sum(jobs.amount)"], "filters": ["jobs.doubled = 10"]}
    ).sql

    _assert_valid(sql, dialect)
    # `doubled` is computed (base * 2); the filter must reference the underlying
    # expression, not the (non-existent) computed column name.
    assert "base" in sql
    assert "doubled" not in sql


def test_tsql_equality_and_in_filters_are_equivalent_shape():
    """On T-SQL, `= 'x'` and `IN ('x')` filters both compile to predicates."""
    eq_engine = make_engine({"jobs": _jobs_source()}, dialect="tsql")
    in_engine = make_engine(
        {
            "jobs": _jobs_source(
                measures=[
                    {
                        "name": "roofing_rev",
                        "expr": "sum(amount)",
                        "filter": "trade_name IN ('Roofing')",
                    }
                ]
            )
        },
        dialect="tsql",
    )
    eq_sql = eq_engine.query({"measures": ["jobs.roofing_rev"]}).sql
    in_sql = in_engine.query({"measures": ["jobs.roofing_rev"]}).sql

    _assert_valid(eq_sql, "tsql")
    _assert_valid(in_sql, "tsql")
    assert "jobs.trade_name = 'Roofing'" in eq_sql
    assert "jobs.trade_name IN ('Roofing')" in in_sql
