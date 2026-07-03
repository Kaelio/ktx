"""Reserved-word identifiers and week-of-day granularity must produce valid SQL
in the connection's native dialect.

Regression: on backtick dialects (BigQuery, MySQL) a reserved-word column such
as `default` or `like` was quoted with postgres-style double quotes, which those
dialects read as a *string literal* — `WHERE loans.'like' = 'x'` — yielding the
production error `Syntax error: Unexpected string literal "like"`.
"""

from __future__ import annotations

import sqlglot

from conftest import make_engine


def _loans_engine(dialect: str):
    source = {
        "name": "loans",
        "table": "mydataset.loans",
        "grain": ["id"],
        "columns": [
            {"name": "id", "type": "number"},
            {"name": "amount", "type": "number"},
            {"name": "default", "type": "boolean"},
            {"name": "like", "type": "string"},
            {"name": "created_at", "type": "time"},
        ],
        "measures": [{"name": "total", "expr": "sum(amount)"}],
    }
    return make_engine({"loans": source}, dialect=dialect)


def test_reserved_word_column_filter_valid_on_bigquery():
    sql = (
        _loans_engine("bigquery")
        .query({"measures": ["loans.total"], "filters": ["loans.default = true"]})
        .sql
    )
    sqlglot.parse_one(sql, read="bigquery")  # must not raise
    assert "`default`" in sql
    assert "'default'" not in sql


def test_reserved_word_column_filter_valid_on_mysql():
    sql = (
        _loans_engine("mysql")
        .query({"measures": ["loans.total"], "filters": ["loans.default = true"]})
        .sql
    )
    sqlglot.parse_one(sql, read="mysql")
    assert "`default`" in sql
    assert "'default'" not in sql


def test_like_column_filter_valid_on_bigquery():
    # Mirrors the production message: Unexpected string literal "like".
    sql = (
        _loans_engine("bigquery")
        .query({"measures": ["loans.total"], "filters": ["loans.like = 'x'"]})
        .sql
    )
    sqlglot.parse_one(sql, read="bigquery")
    assert "`like`" in sql
    assert "'like'" not in sql


def test_reserved_word_column_still_double_quoted_on_snowflake():
    sql = (
        _loans_engine("snowflake")
        .query({"measures": ["loans.total"], "filters": ["loans.default = true"]})
        .sql
    )
    sqlglot.parse_one(sql, read="snowflake")
    assert '"default"' in sql


def test_week_weekday_granularity_translated_on_bigquery():
    sql = (
        _loans_engine("bigquery")
        .query(
            {
                "measures": ["loans.total"],
                "dimensions": [
                    {"field": "loans.created_at", "granularity": "week_monday"}
                ],
            }
        )
        .sql
    )
    sqlglot.parse_one(sql, read="bigquery")  # must not raise
    assert "WEEK_MONDAY" not in sql
    assert "WEEK(MONDAY)" in sql
