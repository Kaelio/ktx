"""predefined_measures_only rejects runtime-composed measures while leaving
predefined measures, predefined derived chains, dimensions, and filters usable."""

from __future__ import annotations

import pytest

from semantic_layer.engine import SemanticEngine
from semantic_layer.models import SourceDefinition


def _engine() -> SemanticEngine:
    orders = SourceDefinition(
        name="orders",
        table="public.orders",
        grain=["id"],
        columns=[
            {"name": "id", "type": "number"},
            {"name": "amount", "type": "number"},
            {"name": "status", "type": "string"},
        ],
        measures=[
            {"name": "revenue", "expr": "sum(amount)"},
            {"name": "order_count", "expr": "count(*)"},
            {"name": "aov", "expr": "revenue / order_count"},
        ],
    )
    return SemanticEngine.from_sources({"orders": orders})


def test_rejects_composed_string_measure() -> None:
    with pytest.raises(ValueError, match="composed measure") as excinfo:
        _engine().query(
            {
                "measures": ["sum(orders.amount)"],
                "predefined_measures_only": True,
            }
        )
    assert "sum(orders.amount)" in str(excinfo.value)
    assert "query_policy: semantic-layer-only" in str(excinfo.value)


def test_rejects_composed_dict_measure() -> None:
    with pytest.raises(ValueError, match="composed measure"):
        _engine().query(
            {
                "measures": [{"expr": "avg(orders.amount)", "name": "avg_amount"}],
                "predefined_measures_only": True,
            }
        )


def test_rejects_query_time_derivation_over_predefined_measures() -> None:
    with pytest.raises(ValueError, match="composed measure"):
        _engine().query(
            {
                "measures": [
                    {"expr": "orders.revenue / orders.order_count", "name": "ratio"}
                ],
                "predefined_measures_only": True,
            }
        )


def test_rejects_composed_aggregate_in_filter() -> None:
    # A HAVING-classified filter must not smuggle a runtime aggregate the
    # measures guard would reject (threshold-probing bypass).
    with pytest.raises(ValueError, match="compose aggregate expressions") as excinfo:
        _engine().query(
            {
                "measures": ["orders.revenue"],
                "dimensions": ["orders.status"],
                "filters": ["avg(orders.amount) > 100"],
                "predefined_measures_only": True,
            }
        )
    assert "avg(orders.amount) > 100" in str(excinfo.value)
    assert "query_policy: semantic-layer-only" in str(excinfo.value)


def test_rejects_composed_aggregate_in_compound_filter() -> None:
    with pytest.raises(ValueError, match="compose aggregate expressions"):
        _engine().query(
            {
                "measures": ["orders.revenue"],
                "filters": ["orders.status = 'active' AND sum(orders.amount) > 5000"],
                "predefined_measures_only": True,
            }
        )


def test_allows_predefined_measure_having_filter() -> None:
    result = _engine().query(
        {
            "measures": ["orders.revenue"],
            "dimensions": ["orders.status"],
            "filters": ["orders.revenue > 100"],
            "predefined_measures_only": True,
        }
    )
    assert "having" in result.sql.lower()


def test_composed_aggregate_filter_allowed_when_flag_absent() -> None:
    result = _engine().query(
        {
            "measures": ["orders.revenue"],
            "filters": ["avg(orders.amount) > 100"],
        }
    )
    assert "having" in result.sql.lower()


def test_allows_predefined_measure_with_dimensions_and_filters() -> None:
    result = _engine().query(
        {
            "measures": ["orders.revenue"],
            "dimensions": ["orders.status"],
            "filters": ["orders.status != 'cancelled'"],
            "predefined_measures_only": True,
        }
    )
    assert "sum" in result.sql.lower()


def test_allows_unqualified_predefined_measure() -> None:
    result = _engine().query(
        {
            "measures": ["revenue"],
            "predefined_measures_only": True,
        }
    )
    assert "sum" in result.sql.lower()


def test_allows_predefined_derived_measure_chain() -> None:
    result = _engine().query(
        {
            "measures": ["orders.aov"],
            "predefined_measures_only": True,
        }
    )
    assert "sum" in result.sql.lower()


def test_composed_measures_allowed_when_flag_absent() -> None:
    result = _engine().query({"measures": ["sum(orders.amount)"]})
    assert "sum" in result.sql.lower()
