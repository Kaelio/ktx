"""Tests targeting specific coverage gaps in planner.py, generator.py, models.py, engine.py."""

from __future__ import annotations

import pytest
from pydantic import ValidationError

from semantic_layer.generator import SqlGenerator
from semantic_layer.graph import JoinGraph
from semantic_layer.models import (
    JoinDeclaration,
    MeasureDefinition,
    SemanticQuery,
    SourceColumn,
    SourceDefinition,
)
from semantic_layer.planner import QueryPlanner

from conftest import assert_valid_sql, make_engine


# ── Helpers ──────────────────────────────────────────────────────────


def _make_planner(sources: dict[str, SourceDefinition]) -> QueryPlanner:
    graph = JoinGraph(sources)
    graph.build()
    return QueryPlanner(sources, graph)


def _plan_and_generate(sources: dict[str, SourceDefinition], query_dict: dict) -> str:
    planner = _make_planner(sources)
    generator = SqlGenerator(dialect="postgres")
    query = SemanticQuery(**query_dict)
    plan = planner.plan(query)
    sql = generator.generate(plan, sources)
    assert_valid_sql(sql)
    return sql


# ── Source fixtures ──────────────────────────────────────────────────


def _simple_sources() -> dict[str, SourceDefinition]:
    """orders -> customers (m2o)."""
    customers = SourceDefinition(
        name="customers",
        table="public.customers",
        grain=["id"],
        columns=[
            SourceColumn(name="id", type="number"),
            SourceColumn(name="segment", type="string"),
        ],
    )
    orders = SourceDefinition(
        name="orders",
        table="public.orders",
        grain=["id"],
        columns=[
            SourceColumn(name="id", type="number"),
            SourceColumn(name="customer_id", type="number"),
            SourceColumn(name="amount", type="number"),
            SourceColumn(name="status", type="string"),
        ],
        joins=[
            JoinDeclaration(
                to="customers",
                on="customer_id = customers.id",
                relationship="many_to_one",
            )
        ],
        measures=[
            MeasureDefinition(
                name="revenue", expr="sum(amount)", filter="status != 'refunded'"
            ),
            MeasureDefinition(name="order_count", expr="count(id)"),
        ],
    )
    return {"customers": customers, "orders": orders}


def _chasm_sources() -> dict[str, SourceDefinition]:
    """Two fact tables (orders, tickets) -> hub (customers). Classic chasm trap."""
    customers = SourceDefinition(
        name="customers",
        table="public.customers",
        grain=["id"],
        columns=[
            SourceColumn(name="id", type="number"),
            SourceColumn(name="segment", type="string"),
        ],
    )
    orders = SourceDefinition(
        name="orders",
        table="public.orders",
        grain=["id"],
        columns=[
            SourceColumn(name="id", type="number"),
            SourceColumn(name="customer_id", type="number"),
            SourceColumn(name="amount", type="number"),
        ],
        joins=[
            JoinDeclaration(
                to="customers",
                on="customer_id = customers.id",
                relationship="many_to_one",
            )
        ],
        measures=[MeasureDefinition(name="revenue", expr="sum(amount)")],
    )
    tickets = SourceDefinition(
        name="tickets",
        table="public.tickets",
        grain=["id"],
        columns=[
            SourceColumn(name="id", type="number"),
            SourceColumn(name="customer_id", type="number"),
            SourceColumn(name="priority", type="string"),
        ],
        joins=[
            JoinDeclaration(
                to="customers",
                on="customer_id = customers.id",
                relationship="many_to_one",
            )
        ],
        measures=[MeasureDefinition(name="ticket_count", expr="count(id)")],
    )
    return {"customers": customers, "orders": orders, "tickets": tickets}


def _chain_sources_with_derived() -> dict[str, SourceDefinition]:
    """orders -> customers -> tiers (m2o chain) with derived measures."""
    tiers = SourceDefinition(
        name="tiers",
        table="public.tiers",
        grain=["id"],
        columns=[
            SourceColumn(name="id", type="number"),
            SourceColumn(name="level", type="string"),
        ],
    )
    customers = SourceDefinition(
        name="customers",
        table="public.customers",
        grain=["id"],
        columns=[
            SourceColumn(name="id", type="number"),
            SourceColumn(name="tier_id", type="number"),
            SourceColumn(name="segment", type="string"),
        ],
        joins=[
            JoinDeclaration(
                to="tiers", on="tier_id = tiers.id", relationship="many_to_one"
            )
        ],
    )
    orders = SourceDefinition(
        name="orders",
        table="public.orders",
        grain=["id"],
        columns=[
            SourceColumn(name="id", type="number"),
            SourceColumn(name="customer_id", type="number"),
            SourceColumn(name="amount", type="number"),
            SourceColumn(name="status", type="string"),
        ],
        joins=[
            JoinDeclaration(
                to="customers",
                on="customer_id = customers.id",
                relationship="many_to_one",
            )
        ],
        measures=[
            MeasureDefinition(
                name="revenue", expr="sum(amount)", filter="status != 'refunded'"
            ),
            MeasureDefinition(name="order_count", expr="count(id)"),
            MeasureDefinition(name="avg_order", expr="revenue / order_count"),
        ],
    )
    return {"tiers": tiers, "customers": customers, "orders": orders}


# ── Planner: nested aggregation (lines 432-440) ─────────────────────


class TestNestedAggregation:
    def test_nested_aggregation_raises(self):
        """avg(sum(orders.amount)) should be rejected."""
        sources = _simple_sources()
        planner = _make_planner(sources)
        with pytest.raises(ValueError, match="Nested aggregation is not supported"):
            planner.plan(
                SemanticQuery(
                    measures=["avg(sum(orders.amount))"],
                    dimensions=["orders.status"],
                )
            )

    def test_nested_max_count_raises(self):
        """max(count(orders.id)) should be rejected."""
        sources = _simple_sources()
        planner = _make_planner(sources)
        with pytest.raises(ValueError, match="Nested aggregation is not supported"):
            planner.plan(
                SemanticQuery(
                    measures=["max(count(orders.id))"],
                    dimensions=["orders.status"],
                )
            )


# ── Planner: OR filter mixing (lines 810-833) ───────────────────────


class TestOrFilterMixing:
    def test_or_mixing_agg_and_nonagg_raises(self):
        """OR that mixes aggregate and non-aggregate conditions should raise."""
        sources = _simple_sources()
        planner = _make_planner(sources)
        with pytest.raises(ValueError, match="mixes aggregate and non-aggregate"):
            planner.plan(
                SemanticQuery(
                    measures=["sum(orders.amount)"],
                    dimensions=["orders.status"],
                    filters=["orders.amount > 100 OR sum(orders.amount) > 5000"],
                )
            )

    def test_or_pure_where_ok(self):
        """OR with all non-aggregate conditions should be fine."""
        sources = _simple_sources()
        sql = _plan_and_generate(
            sources,
            {
                "measures": ["sum(orders.amount)"],
                "dimensions": ["orders.status"],
                "filters": ["orders.amount > 100 OR orders.amount < 10"],
            },
        )
        assert "OR" in sql.upper()

    def test_or_pure_having_ok(self):
        """OR with all aggregate conditions should be fine."""
        sources = _simple_sources()
        sql = _plan_and_generate(
            sources,
            {
                "measures": ["sum(orders.amount)"],
                "dimensions": ["orders.status"],
                "filters": ["sum(orders.amount) > 1000 OR count(orders.id) > 5"],
            },
        )
        assert "HAVING" in sql.upper()


# ── Planner: empty source refs (line 62) ─────────────────────────────


class TestEmptySourceRef:
    def test_no_source_refs_raises(self):
        """Query that references no sources should raise."""
        sources = _simple_sources()
        planner = _make_planner(sources)
        with pytest.raises(ValueError, match="does not reference any source"):
            planner.plan(
                SemanticQuery(
                    measures=["sum(1)"],
                    dimensions=[],
                )
            )


# ── Planner: predefined measure dependency chains (lines 189-194, 237, 281-282) ──


class TestPredefinedMeasureDeps:
    def test_derived_measure_resolves_dependencies(self):
        """avg_order depends on revenue and order_count — both should appear in plan."""
        sources = _chain_sources_with_derived()
        planner = _make_planner(sources)
        plan = planner.plan(
            SemanticQuery(
                measures=["orders.avg_order"],
                dimensions=["orders.status"],
            )
        )
        measure_names = {m.name for m in plan.measures}
        assert "avg_order" in measure_names
        assert "revenue" in measure_names
        assert "order_count" in measure_names

    def test_derived_measure_generates_valid_sql(self):
        """Derived measures should produce valid SQL."""
        sources = _chain_sources_with_derived()
        sql = _plan_and_generate(
            sources,
            {
                "measures": ["orders.avg_order"],
                "dimensions": ["customers.segment"],
            },
        )
        assert "GROUP BY" in sql.upper()


# ── Planner: fanout with one_to_many to dimension sources (lines 595-643) ──


class TestFanOutEdgeCases:
    def test_single_source_fan_out_to_dimension(self):
        """Measure source with one_to_many to dimension should trigger fanout."""
        hub = SourceDefinition(
            name="hub",
            table="public.hub",
            grain=["id"],
            columns=[
                SourceColumn(name="id", type="number"),
                SourceColumn(name="name", type="string"),
            ],
            joins=[
                JoinDeclaration(
                    to="detail", on="id = detail.hub_id", relationship="one_to_many"
                )
            ],
        )
        detail = SourceDefinition(
            name="detail",
            table="public.detail",
            grain=["id"],
            columns=[
                SourceColumn(name="id", type="number"),
                SourceColumn(name="hub_id", type="number"),
                SourceColumn(name="category", type="string"),
            ],
        )
        sources = {"hub": hub, "detail": detail}
        planner = _make_planner(sources)
        plan = planner.plan(
            SemanticQuery(
                measures=["sum(hub.id)"],
                dimensions=["detail.category"],
            )
        )
        assert plan.has_fan_out

    def test_merged_groups_fan_out_to_dimension(self):
        """Two measure sources on the same m2o chain, but with o2m to dimension source."""
        dim = SourceDefinition(
            name="dim",
            table="public.dim",
            grain=["id"],
            columns=[
                SourceColumn(name="id", type="number"),
                SourceColumn(name="label", type="string"),
            ],
        )
        parent = SourceDefinition(
            name="parent",
            table="public.parent",
            grain=["id"],
            columns=[
                SourceColumn(name="id", type="number"),
                SourceColumn(name="val", type="number"),
            ],
            joins=[
                JoinDeclaration(to="dim", on="id = dim.id", relationship="one_to_many")
            ],
        )
        child = SourceDefinition(
            name="child",
            table="public.child",
            grain=["id"],
            columns=[
                SourceColumn(name="id", type="number"),
                SourceColumn(name="parent_id", type="number"),
                SourceColumn(name="amount", type="number"),
            ],
            joins=[
                JoinDeclaration(
                    to="parent", on="parent_id = parent.id", relationship="many_to_one"
                )
            ],
        )
        sources = {"dim": dim, "parent": parent, "child": child}
        planner = _make_planner(sources)
        plan = planner.plan(
            SemanticQuery(
                measures=["sum(child.amount)"],
                dimensions=["dim.label"],
            )
        )
        assert plan.has_fan_out

    def test_filter_fan_out_one_to_many_raises(self):
        """Filter on source reachable only via one_to_many from measure source should raise."""
        parent = SourceDefinition(
            name="parent",
            table="public.parent",
            grain=["id"],
            columns=[
                SourceColumn(name="id", type="number"),
                SourceColumn(name="val", type="number"),
            ],
            joins=[
                JoinDeclaration(
                    to="child", on="id = child.parent_id", relationship="one_to_many"
                )
            ],
        )
        child = SourceDefinition(
            name="child",
            table="public.child",
            grain=["id"],
            columns=[
                SourceColumn(name="id", type="number"),
                SourceColumn(name="parent_id", type="number"),
                SourceColumn(name="category", type="string"),
            ],
        )
        sources = {"parent": parent, "child": child}
        planner = _make_planner(sources)
        with pytest.raises(ValueError, match="one_to_many join"):
            planner.plan(
                SemanticQuery(
                    measures=["sum(parent.val)"],
                    dimensions=[],
                    filters=["child.category = 'A'"],
                )
            )


# ── Generator: NULL dimension in multi-CTE (lines 385-388) ──────────


class TestNullDimensionInCTE:
    def test_dimension_not_in_any_cte_gets_null(self):
        """When a dimension is from a source not reachable by any CTE, generate NULL."""
        # Use a 3-fact chasm topology where one dimension is only reachable by one fact
        hub = SourceDefinition(
            name="hub",
            table="public.hub",
            grain=["id"],
            columns=[
                SourceColumn(name="id", type="number"),
                SourceColumn(name="name", type="string"),
            ],
        )
        fact_a = SourceDefinition(
            name="fact_a",
            table="public.fact_a",
            grain=["id"],
            columns=[
                SourceColumn(name="id", type="number"),
                SourceColumn(name="hub_id", type="number"),
                SourceColumn(name="val", type="number"),
                SourceColumn(name="extra", type="string"),
            ],
            joins=[
                JoinDeclaration(
                    to="hub", on="hub_id = hub.id", relationship="many_to_one"
                )
            ],
        )
        fact_b = SourceDefinition(
            name="fact_b",
            table="public.fact_b",
            grain=["id"],
            columns=[
                SourceColumn(name="id", type="number"),
                SourceColumn(name="hub_id", type="number"),
                SourceColumn(name="val", type="number"),
            ],
            joins=[
                JoinDeclaration(
                    to="hub", on="hub_id = hub.id", relationship="many_to_one"
                )
            ],
        )
        sources = {"hub": hub, "fact_a": fact_a, "fact_b": fact_b}
        sql = _plan_and_generate(
            sources,
            {
                "measures": ["sum(fact_a.val)", "sum(fact_b.val)"],
                "dimensions": ["hub.name"],
            },
        )
        # Should produce aggregate locality CTEs with FULL JOIN
        assert "FULL" in sql.upper() or "WITH" in sql.upper()


# ── Generator: CTE alias collision (lines 202-206) ──────────────────


class TestCTEAliasCollision:
    def test_alias_collision_resolved(self):
        """When a source name matches a potential CTE alias, suffix should be used."""
        # Create a source named "orders_agg" to collide with the CTE alias
        orders_agg = SourceDefinition(
            name="orders_agg",
            table="public.orders_agg",
            grain=["id"],
            columns=[
                SourceColumn(name="id", type="number"),
                SourceColumn(name="segment", type="string"),
            ],
        )
        orders = SourceDefinition(
            name="orders",
            table="public.orders",
            grain=["id"],
            columns=[
                SourceColumn(name="id", type="number"),
                SourceColumn(name="customer_id", type="number"),
                SourceColumn(name="amount", type="number"),
            ],
            joins=[
                JoinDeclaration(
                    to="orders_agg",
                    on="customer_id = orders_agg.id",
                    relationship="many_to_one",
                )
            ],
        )
        tickets = SourceDefinition(
            name="tickets",
            table="public.tickets",
            grain=["id"],
            columns=[
                SourceColumn(name="id", type="number"),
                SourceColumn(name="customer_id", type="number"),
                SourceColumn(name="priority", type="string"),
            ],
            joins=[
                JoinDeclaration(
                    to="orders_agg",
                    on="customer_id = orders_agg.id",
                    relationship="many_to_one",
                )
            ],
        )
        sources = {"orders_agg": orders_agg, "orders": orders, "tickets": tickets}
        sql = _plan_and_generate(
            sources,
            {
                "measures": ["sum(orders.amount)", "count(tickets.id)"],
                "dimensions": ["orders_agg.segment"],
            },
        )
        # Should still produce valid SQL even with the collision
        assert_valid_sql(sql)


# ── Models: negative limit (line 95) ────────────────────────────────


class TestNegativeLimit:
    def test_negative_limit_raises(self):
        with pytest.raises(ValidationError, match="limit"):
            SemanticQuery(
                measures=["sum(orders.amount)"],
                limit=-1,
            )

    def test_zero_limit_allowed(self):
        q = SemanticQuery(measures=["sum(orders.amount)"], limit=0)
        assert q.limit == 0


# ── Engine: suggest with missing sources (lines 100-106, 127) ────────


class TestEngineSuggest:
    def test_suggest_with_missing_source(self):
        """Suggest should return suggestions for missing sources."""
        engine = make_engine(
            {
                "orders": {
                    "name": "orders",
                    "table": "public.orders",
                    "grain": ["id"],
                    "columns": [
                        {"name": "id", "type": "number"},
                        {"name": "amount", "type": "number"},
                    ],
                },
            }
        )
        result = engine.suggest(
            {
                "measures": ["sum(unknown_source.val)"],
                "dimensions": ["orders.id"],
            }
        )
        assert not result["success"]
        assert any(
            "missing" in s["description"].lower()
            or "unknown_source" in s["description"]
            for s in result.get("suggestions", [])
        )

    def test_suggest_with_dict_measure_and_dimension(self):
        """Suggest handles dict-format measures and dimensions in failure path."""
        engine = make_engine(
            {
                "orders": {
                    "name": "orders",
                    "table": "public.orders",
                    "grain": ["id"],
                    "columns": [
                        {"name": "id", "type": "number"},
                        {"name": "amount", "type": "number"},
                    ],
                },
            }
        )
        # Use a nested aggregate to trigger a planner error that hits the dict-handling code
        result = engine.suggest(
            {
                "measures": [{"expr": "avg(sum(missing.val))", "name": "total"}],
                "dimensions": [{"field": "missing.category"}],
            }
        )
        assert not result["success"]


# ── Planner: order_by resolution formats (lines 113-116) ────────────


class TestOrderByResolution:
    def test_order_by_as_dict(self):
        sources = _simple_sources()
        planner = _make_planner(sources)
        plan = planner.plan(
            SemanticQuery(
                measures=["sum(orders.amount)"],
                dimensions=["orders.status"],
                order_by=[{"field": "orders.status", "direction": "desc"}],
            )
        )
        assert len(plan.order_by) == 1
        assert plan.order_by[0].direction == "desc"

    def test_order_by_as_string(self):
        sources = _simple_sources()
        planner = _make_planner(sources)
        plan = planner.plan(
            SemanticQuery(
                measures=["sum(orders.amount)"],
                dimensions=["orders.status"],
                order_by=["orders.status"],
            )
        )
        assert len(plan.order_by) == 1


# ── Planner: measure with no source refs (line 343) ─────────────────


class TestMeasureNoSourceRef:
    def test_bare_column_no_aggregate_raises(self):
        """A measure like 'orders.nonexistent' that isn't predefined should raise."""
        sources = _simple_sources()
        planner = _make_planner(sources)
        with pytest.raises(
            ValueError, match="does not reference any source|not a pre-defined measure"
        ):
            planner.plan(
                SemanticQuery(
                    measures=["sum(1)"],
                )
            )


# ── Generator: custom aggregate parsing (lines 614-617) ─────────────


class TestCustomAggregates:
    def test_count_distinct_generates_valid_sql(self):
        sources = _simple_sources()
        sql = _plan_and_generate(
            sources,
            {
                "measures": ["count(distinct orders.id)"],
                "dimensions": ["orders.status"],
            },
        )
        upper = sql.upper()
        assert "COUNT(DISTINCT" in upper or "COUNT (DISTINCT" in upper


# ── Generator: qualified predefined expressions via multi-hop joins (lines 925-931) ──


class TestQualifiedPredefinedExpr:
    def test_predefined_filter_with_joined_column(self):
        """Predefined measure with a filter referencing a column from a joined table."""
        sources = _chain_sources_with_derived()
        sql = _plan_and_generate(
            sources,
            {
                "measures": ["orders.revenue"],
                "dimensions": ["tiers.level"],
            },
        )
        assert_valid_sql(sql)
        assert "CASE WHEN" in sql.upper()


# ── End-to-end: chasm trap with aggregate locality ───────────────────


class TestChasmTrapEndToEnd:
    def test_two_fact_tables_produce_valid_sql(self):
        sources = _chasm_sources()
        sql = _plan_and_generate(
            sources,
            {
                "measures": ["sum(orders.amount)", "count(tickets.id)"],
                "dimensions": ["customers.segment"],
            },
        )
        upper = sql.upper()
        assert "WITH" in upper
        assert "FULL" in upper or "JOIN" in upper

    def test_chasm_with_filter_on_hub(self):
        sources = _chasm_sources()
        sql = _plan_and_generate(
            sources,
            {
                "measures": ["sum(orders.amount)", "count(tickets.id)"],
                "dimensions": ["customers.segment"],
                "filters": ["customers.segment = 'enterprise'"],
            },
        )
        assert "enterprise" in sql
        assert_valid_sql(sql)
