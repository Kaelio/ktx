import pytest

from semantic_layer.graph import JoinGraph
from semantic_layer.models import (
    ColumnVisibility,
    MeasureDefinition,
    Provenance,
    SemanticQuery,
    SourceColumn,
    SourceDefinition,
    JoinDeclaration,
)
from semantic_layer.planner import QueryPlanner
from semantic_layer.engine import SemanticEngine


@pytest.fixture
def planner(ecommerce_sources):
    graph = JoinGraph(ecommerce_sources)
    graph.build()
    return QueryPlanner(ecommerce_sources, graph)


class TestSingleSource:
    def test_simple_aggregation(self, planner):
        query = SemanticQuery(
            measures=["sum(orders.amount)"],
            dimensions=["orders.status"],
        )
        plan = planner.plan(query)
        assert "orders" in plan.sources_used
        assert len(plan.measures) == 1
        assert plan.measures[0].expr == "sum(orders.amount)"
        assert len(plan.dimensions) == 1
        assert plan.dimensions[0].field == "orders.status"
        assert not plan.has_fan_out

    def test_pre_defined_measure(self, planner):
        query = SemanticQuery(
            measures=["orders.revenue"],
            dimensions=["orders.status"],
        )
        plan = planner.plan(query)
        revenue = plan.measures[0]
        assert revenue.name == "revenue"
        assert revenue.provenance == Provenance.VERIFIED
        assert revenue.expr == "SUM(orders.amount)"
        assert revenue.filter == "orders.status <> 'refunded'"

    def test_multiple_pre_defined_measures(self, planner):
        """Both orders.revenue and orders.order_count are pre-defined."""
        query = SemanticQuery(
            measures=["orders.revenue", "orders.order_count"],
            dimensions=["orders.status"],
        )
        plan = planner.plan(query)
        assert len(plan.measures) == 2
        names = {m.name for m in plan.measures}
        assert names == {"revenue", "order_count"}
        assert all(m.provenance == Provenance.VERIFIED for m in plan.measures)

    def test_pre_defined_and_runtime_coexist(self, planner):
        """Pre-defined orders.revenue alongside runtime sum(orders.amount)."""
        query = SemanticQuery(
            measures=["orders.revenue", "sum(orders.amount)"],
            dimensions=["orders.status"],
        )
        plan = planner.plan(query)
        assert len(plan.measures) == 2
        revenue = next(m for m in plan.measures if m.name == "revenue")
        runtime = next(m for m in plan.measures if m.name != "revenue")
        assert revenue.provenance == Provenance.VERIFIED
        assert runtime.provenance == Provenance.COMPOSED

    def test_global_aggregates_no_dimensions(self, planner):
        """Measures without any dimensions — global aggregate."""
        query = SemanticQuery(
            measures=["sum(orders.amount)", "orders.order_count"],
        )
        plan = planner.plan(query)
        assert len(plan.measures) == 2
        assert len(plan.dimensions) == 0
        assert "orders" in plan.sources_used


class TestCrossSource:
    def test_m2o_joins(self, planner):
        query = SemanticQuery(
            measures=["churn_risk.avg_risk"],
            dimensions=["churn_risk.customer_type", "regions.name"],
            filters=["regions.name = 'LATAM'"],
        )
        plan = planner.plan(query)
        assert "churn_risk" in plan.sources_used
        assert "regions" in plan.sources_used
        assert "customers" in plan.sources_used  # intermediate join
        assert plan.where_filters == ["regions.name = 'LATAM'"]

    def test_orders_to_regions(self, planner):
        query = SemanticQuery(
            measures=["sum(orders.amount)"],
            dimensions=["regions.name"],
        )
        plan = planner.plan(query)
        assert "orders" in plan.sources_used
        assert "customers" in plan.sources_used  # intermediate
        assert "regions" in plan.sources_used

    def test_runtime_aggregation_cross_source(self, planner):
        """Runtime median(orders.amount) grouped by regions.name — not pre-defined."""
        query = SemanticQuery(
            measures=[{"expr": "median(orders.amount)", "name": "median_order"}],
            dimensions=["regions.name"],
        )
        plan = planner.plan(query)
        assert "orders" in plan.sources_used
        assert "regions" in plan.sources_used
        median_m = next(m for m in plan.measures if m.name == "median_order")
        assert median_m.provenance == Provenance.COMPOSED

    def test_dimensions_from_multiple_sources(self, planner):
        """Dimensions from churn_risk and regions in same query."""
        query = SemanticQuery(
            measures=["churn_risk.avg_risk"],
            dimensions=["churn_risk.customer_type", "regions.name"],
        )
        plan = planner.plan(query)
        assert len(plan.dimensions) == 2
        dim_fields = {d.field for d in plan.dimensions}
        assert dim_fields == {"churn_risk.customer_type", "regions.name"}

    def test_filter_adds_source_to_graph(self, planner):
        """Filter on regions.name when measures/dimensions don't reference regions."""
        query = SemanticQuery(
            measures=["sum(orders.amount)"],
            dimensions=["orders.status"],
            filters=["regions.name = 'LATAM'"],
        )
        plan = planner.plan(query)
        assert "regions" in plan.sources_used
        assert "customers" in plan.sources_used  # intermediate to reach regions


class TestFanOutDetection:
    def test_chasm_trap(self):
        """Two independent sources joining m2o to same dimension source."""
        customers = SourceDefinition(
            name="customers",
            table="t",
            grain=["id"],
            columns=[SourceColumn(name="id", type="number")],
        )
        orders = SourceDefinition(
            name="orders",
            table="t",
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
        )
        tickets = SourceDefinition(
            name="tickets",
            table="t",
            grain=["id"],
            columns=[
                SourceColumn(name="id", type="number"),
                SourceColumn(name="customer_id", type="number"),
            ],
            joins=[
                JoinDeclaration(
                    to="customers",
                    on="customer_id = customers.id",
                    relationship="many_to_one",
                )
            ],
        )
        sources = {"customers": customers, "orders": orders, "tickets": tickets}
        graph = JoinGraph(sources)
        graph.build()
        planner = QueryPlanner(sources, graph)

        query = SemanticQuery(
            measures=["sum(orders.amount)", "count(tickets.id)"],
            dimensions=["customers.id"],
        )
        plan = planner.plan(query)
        assert plan.has_fan_out
        assert len(plan.measure_groups) == 2
        group_sources = {g.source_name for g in plan.measure_groups}
        assert group_sources == {"orders", "tickets"}


class TestFanOutSingleSource:
    """Fanout when a single measure source has o2m path to dimension source."""

    def test_reverse_path_fan_out(self):
        """Querying from customers (dimension) with measures from orders triggers fanout
        when the path from the measure source (orders) to the dimension source (customers)
        is m2o — so no fanout. But reversed: measure on customers, dim on orders."""
        customers = SourceDefinition(
            name="customers",
            table="t",
            grain=["id"],
            columns=[
                SourceColumn(name="id", type="number"),
                SourceColumn(name="score", type="number"),
            ],
        )
        orders = SourceDefinition(
            name="orders",
            table="t",
            grain=["id"],
            columns=[
                SourceColumn(name="id", type="number"),
                SourceColumn(name="customer_id", type="number"),
                SourceColumn(name="status", type="string"),
            ],
            joins=[
                JoinDeclaration(
                    to="customers",
                    on="customer_id = customers.id",
                    relationship="many_to_one",
                )
            ],
        )
        sources = {"customers": customers, "orders": orders}
        from semantic_layer.graph import JoinGraph

        graph = JoinGraph(sources)
        graph.build()
        planner = QueryPlanner(sources, graph)

        # measure on customers, dimension on orders — path from customers to orders is o2m
        query = SemanticQuery(
            measures=["avg(customers.score)"],
            dimensions=["orders.status"],
        )
        plan = planner.plan(query)
        assert plan.has_fan_out

    def test_m2o_multi_hop_no_fan_out(self, planner):
        """orders → customers → regions is all m2o. No fanout."""
        query = SemanticQuery(
            measures=["sum(orders.amount)"],
            dimensions=["regions.name"],
        )
        plan = planner.plan(query)
        assert not plan.has_fan_out


class TestTripleChasmTrap:
    """Three independent measure sources joining to same dimension source."""

    def test_three_measure_sources(self):
        customers = SourceDefinition(
            name="customers",
            table="t",
            grain=["id"],
            columns=[
                SourceColumn(name="id", type="number"),
                SourceColumn(name="segment", type="string"),
            ],
        )
        orders = SourceDefinition(
            name="orders",
            table="t",
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
        )
        tickets = SourceDefinition(
            name="tickets",
            table="t",
            grain=["id"],
            columns=[
                SourceColumn(name="id", type="number"),
                SourceColumn(name="customer_id", type="number"),
            ],
            joins=[
                JoinDeclaration(
                    to="customers",
                    on="customer_id = customers.id",
                    relationship="many_to_one",
                )
            ],
        )
        payments = SourceDefinition(
            name="payments",
            table="t",
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
        )
        sources = {
            "customers": customers,
            "orders": orders,
            "tickets": tickets,
            "payments": payments,
        }
        from semantic_layer.graph import JoinGraph

        graph = JoinGraph(sources)
        graph.build()
        planner = QueryPlanner(sources, graph)

        query = SemanticQuery(
            measures=[
                "sum(orders.amount)",
                "count(tickets.id)",
                "sum(payments.amount)",
            ],
            dimensions=["customers.segment"],
        )
        plan = planner.plan(query)
        assert plan.has_fan_out
        assert len(plan.measure_groups) == 3
        group_sources = {g.source_name for g in plan.measure_groups}
        assert group_sources == {"orders", "tickets", "payments"}


class TestFilterClassification:
    def test_where_filter(self, planner):
        query = SemanticQuery(
            measures=["sum(orders.amount)"],
            dimensions=["orders.status"],
            filters=["orders.status = 'completed'"],
        )
        plan = planner.plan(query)
        assert "orders.status = 'completed'" in plan.where_filters
        assert plan.having_filters == []

    def test_having_filter(self, planner):
        query = SemanticQuery(
            measures=["sum(orders.amount)"],
            dimensions=["orders.status"],
            filters=["sum(orders.amount) > 10000"],
        )
        plan = planner.plan(query)
        assert plan.where_filters == []
        assert "sum(orders.amount) > 10000" in plan.having_filters

    def test_mixed_filters(self, planner):
        query = SemanticQuery(
            measures=["sum(orders.amount)"],
            dimensions=["orders.status"],
            filters=["orders.status = 'completed'", "sum(orders.amount) > 10000"],
        )
        plan = planner.plan(query)
        assert len(plan.where_filters) == 1
        assert len(plan.having_filters) == 1


class TestDerivedMeasures:
    def test_topological_order(self, planner):
        query = SemanticQuery(
            measures=[
                {"expr": "sum(orders.amount)", "name": "total_rev"},
                {"expr": "sum(orders.cost)", "name": "total_cost"},
                {"expr": "total_rev - total_cost", "name": "profit"},
            ],
            dimensions=["orders.status"],
        )
        plan = planner.plan(query)
        names = [m.name for m in plan.measures]
        assert names.index("profit") > names.index("total_rev")
        assert names.index("profit") > names.index("total_cost")

        profit = next(m for m in plan.measures if m.name == "profit")
        assert profit.is_derived
        assert set(profit.depends_on) == {"total_rev", "total_cost"}

    def test_chained_derivation(self, planner):
        """profit = rev - cost, margin = profit / rev — 3-level chain."""
        query = SemanticQuery(
            measures=[
                {"expr": "sum(orders.amount)", "name": "total_rev"},
                {"expr": "sum(orders.cost)", "name": "total_cost"},
                {"expr": "total_rev - total_cost", "name": "profit"},
                {"expr": "profit / total_rev", "name": "margin"},
            ],
            dimensions=["orders.status"],
        )
        plan = planner.plan(query)
        names = [m.name for m in plan.measures]
        # margin depends on profit which depends on total_rev and total_cost
        assert names.index("margin") > names.index("profit")
        assert names.index("profit") > names.index("total_rev")
        assert names.index("profit") > names.index("total_cost")

        margin = next(m for m in plan.measures if m.name == "margin")
        assert margin.is_derived
        assert "profit" in margin.depends_on
        assert "total_rev" in margin.depends_on

    def test_cross_source_derived(self, planner):
        """Derived measure referencing measures from different sources."""
        query = SemanticQuery(
            measures=[
                {"expr": "sum(orders.amount)", "name": "total_rev"},
                {"expr": "count(customers.id)", "name": "cust_count"},
                {"expr": "total_rev / cust_count", "name": "rev_per_customer"},
            ],
            dimensions=["customers.segment"],
        )
        plan = planner.plan(query)
        rev_per = next(m for m in plan.measures if m.name == "rev_per_customer")
        assert rev_per.is_derived
        assert set(rev_per.depends_on) == {"total_rev", "cust_count"}


class TestDimensions:
    def test_time_granularity(self, planner):
        query = SemanticQuery(
            measures=["sum(orders.amount)"],
            dimensions=[{"field": "orders.created_at", "granularity": "month"}],
        )
        plan = planner.plan(query)
        assert len(plan.dimensions) == 1
        assert plan.dimensions[0].granularity == "month"

    def test_string_dimension(self, planner):
        query = SemanticQuery(
            measures=["sum(orders.amount)"],
            dimensions=["orders.status"],
        )
        plan = planner.plan(query)
        assert plan.dimensions[0].field == "orders.status"
        assert plan.dimensions[0].granularity is None


class TestAnchorSelection:
    def test_anchor_prefers_dimension_source_for_include_empty_queries(self, planner):
        """Dimension-side anchor preserves empty dimension rows by default."""
        query = SemanticQuery(
            measures=["sum(orders.amount)"],
            dimensions=["customers.segment"],
        )
        plan = planner.plan(query)
        assert plan.anchor_source == "customers"

    def test_anchor_fallback_to_dimension(self, planner):
        """When all measures are derived, anchor falls back to dimension source."""
        query = SemanticQuery(
            measures=[
                {"expr": "sum(orders.amount)", "name": "rev"},
                {"expr": "sum(orders.cost)", "name": "cost"},
                {"expr": "rev - cost", "name": "profit"},
            ],
            dimensions=["orders.status"],
        )
        plan = planner.plan(query)
        # rev and cost are non-derived, so anchor should be orders
        assert plan.anchor_source == "orders"


class TestFilterEdgeCases:
    def test_filter_referencing_named_measure(self, planner):
        """Filter on a named measure → HAVING."""
        query = SemanticQuery(
            measures=[
                {"expr": "sum(orders.amount)", "name": "total_rev"},
            ],
            dimensions=["orders.status"],
            filters=["total_rev > 10000"],
        )
        plan = planner.plan(query)
        assert "total_rev > 10000" in plan.having_filters

    def test_filter_on_joined_dimension(self, planner):
        """Filter on a dimension from a joined source → WHERE."""
        query = SemanticQuery(
            measures=["sum(orders.amount)"],
            dimensions=["orders.status"],
            filters=["customers.segment = 'Enterprise'"],
        )
        plan = planner.plan(query)
        assert "customers.segment = 'Enterprise'" in plan.where_filters
        assert "customers" in plan.sources_used


class TestErrors:
    def test_no_source_refs(self, planner):
        query = SemanticQuery(measures=["count(*)"])
        with pytest.raises(ValueError, match="does not reference any source"):
            planner.plan(query)

    def test_missing_source(self, planner):
        query = SemanticQuery(
            measures=["sum(nonexistent.amount)"],
            dimensions=["orders.status"],
        )
        # This should fail because nonexistent is not in the graph
        with pytest.raises(ValueError):
            planner.plan(query)


# ── From test_edge_cases.py: planner edge cases ─────────────────────


class TestPlannerEdgeCases:
    @pytest.fixture
    def _planner(self, ecommerce_sources):
        graph = JoinGraph(ecommerce_sources)
        graph.build()
        return QueryPlanner(ecommerce_sources, graph)

    def test_nonexistent_predefined_measure(self, _planner):
        query = SemanticQuery(
            measures=["orders.nonexistent"],
            dimensions=["orders.status"],
        )
        with pytest.raises(ValueError, match="not a pre-defined measure"):
            _planner.plan(query)

    def test_duplicate_dimension_names(self, _planner):
        query = SemanticQuery(
            measures=["sum(orders.amount)"],
            dimensions=["orders.status", "orders.status"],
        )
        plan = _planner.plan(query)
        # Duplicate dimensions are deduplicated
        assert len(plan.dimensions) == 1
        assert plan.dimensions[0].field == "orders.status"

    def test_dimension_only_query(self, _planner):
        query = SemanticQuery(
            measures=[],
            dimensions=["orders.status"],
        )
        plan = _planner.plan(query)
        assert "orders" in plan.sources_used

    def test_many_dimensions_one_measure(self, _planner):
        query = SemanticQuery(
            measures=["sum(orders.amount)"],
            dimensions=[
                "orders.status",
                "orders.created_at",
                "customers.segment",
                "regions.name",
            ],
        )
        plan = _planner.plan(query)
        assert len(plan.dimensions) == 4
        assert "orders" in plan.sources_used
        assert "customers" in plan.sources_used
        assert "regions" in plan.sources_used

    def test_filter_with_aggregate_and_named_measure(self, _planner):
        query = SemanticQuery(
            measures=[
                {"expr": "sum(orders.amount)", "name": "total"},
                {"expr": "count(orders.id)", "name": "cnt"},
            ],
            dimensions=["orders.status"],
            filters=["total > 100", "cnt > 5"],
        )
        plan = _planner.plan(query)
        assert len(plan.having_filters) == 2
        assert len(plan.where_filters) == 0


# ── From test_edge_cases.py: qualify predefined expressions ──────────


class TestQualifyPredefinedExpr:
    @pytest.fixture
    def _planner(self, ecommerce_sources):
        graph = JoinGraph(ecommerce_sources)
        graph.build()
        return QueryPlanner(ecommerce_sources, graph)

    def test_revenue_qualified(self, _planner):
        result = _planner._qualify_predefined_expr("sum(amount)", "orders")
        assert "orders" in result.lower()
        assert "amount" in result.lower()

    def test_already_qualified_stays(self, _planner):
        result = _planner._qualify_predefined_expr("sum(orders.amount)", "orders")
        assert "amount" in result.lower()

    def test_nonexistent_source_passthrough(self, _planner):
        result = _planner._qualify_predefined_expr("sum(amount)", "nonexistent")
        assert result == "sum(amount)"

    def test_filter_expression_qualified(self, _planner):
        result = _planner._qualify_predefined_expr("status != 'refunded'", "orders")
        assert "orders" in result.lower()


# ── From test_bug_fixes.py ───────────────────────────────────────────


ECOMMERCE_SOURCES_DICT = {
    "orders": {
        "name": "orders",
        "table": "public.orders",
        "grain": ["id"],
        "columns": [
            {"name": "id", "type": "number"},
            {"name": "amount", "type": "number"},
            {"name": "cost", "type": "number"},
            {"name": "status", "type": "string"},
            {"name": "customer_id", "type": "number"},
            {"name": "created_at", "type": "time", "role": "time"},
        ],
        "joins": [
            {
                "to": "customers",
                "on": "customer_id = customers.id",
                "relationship": "many_to_one",
            },
        ],
        "measures": [
            {
                "name": "revenue",
                "expr": "sum(amount)",
                "filter": "status != 'refunded'",
            },
            {"name": "order_count", "expr": "count(id)"},
        ],
    },
    "customers": {
        "name": "customers",
        "table": "public.customers",
        "grain": ["id"],
        "columns": [
            {"name": "id", "type": "number"},
            {"name": "name", "type": "string"},
            {"name": "segment", "type": "string"},
        ],
    },
}


class TestPreDefinedMeasureFilterClassification:
    """Filters referencing pre-defined measure names should be HAVING, not WHERE."""

    def test_predefined_measure_in_filter_goes_to_having(self):
        from conftest import make_engine, assert_valid_sql

        engine = make_engine(ECOMMERCE_SOURCES_DICT)
        result = engine.query(
            {
                "measures": ["orders.revenue"],
                "dimensions": ["orders.status"],
                "filters": ["orders.revenue > 1000"],
            }
        )
        assert_valid_sql(result.sql)
        assert "HAVING" in result.sql.upper()
        assert "orders.revenue > 1000" in result.resolved_plan.having_filters
        assert result.resolved_plan.where_filters == []

    def test_regular_column_filter_stays_in_where(self):
        from conftest import make_engine, assert_valid_sql

        engine = make_engine(ECOMMERCE_SOURCES_DICT)
        result = engine.query(
            {
                "measures": ["orders.revenue"],
                "dimensions": ["orders.status"],
                "filters": ["orders.status = 'completed'"],
            }
        )
        assert_valid_sql(result.sql)
        assert "WHERE" in result.sql.upper()
        assert "orders.status = 'completed'" in result.resolved_plan.where_filters

    def test_mixed_where_and_having(self):
        from conftest import make_engine, assert_valid_sql

        engine = make_engine(ECOMMERCE_SOURCES_DICT)
        result = engine.query(
            {
                "measures": ["orders.revenue"],
                "dimensions": ["orders.status"],
                "filters": ["orders.status != 'cancelled'", "orders.revenue > 500"],
            }
        )
        assert_valid_sql(result.sql)
        assert "orders.status != 'cancelled'" in result.resolved_plan.where_filters
        assert "orders.revenue > 500" in result.resolved_plan.having_filters

    def test_explicit_aggregate_filter_still_having(self):
        from conftest import make_engine, assert_valid_sql

        engine = make_engine(ECOMMERCE_SOURCES_DICT)
        result = engine.query(
            {
                "measures": ["sum(orders.amount)"],
                "dimensions": ["orders.status"],
                "filters": ["sum(orders.amount) > 1000"],
            }
        )
        assert_valid_sql(result.sql)
        assert "HAVING" in result.sql.upper()


class TestBareColumnInMeasures:
    """Bare column references in measures (no aggregate) should error."""

    def test_bare_column_rejected(self):
        from conftest import make_engine

        engine = make_engine(ECOMMERCE_SOURCES_DICT)
        with pytest.raises(ValueError, match="not a pre-defined measure.*no aggregate"):
            engine.query(
                {
                    "measures": ["orders.amount"],
                    "dimensions": ["orders.status"],
                }
            )

    def test_aggregate_column_accepted(self):
        from conftest import make_engine, assert_valid_sql

        engine = make_engine(ECOMMERCE_SOURCES_DICT)
        result = engine.query(
            {
                "measures": ["sum(orders.amount)"],
                "dimensions": ["orders.status"],
            }
        )
        assert_valid_sql(result.sql)

    def test_predefined_measure_accepted(self):
        from conftest import make_engine, assert_valid_sql

        engine = make_engine(ECOMMERCE_SOURCES_DICT)
        result = engine.query(
            {
                "measures": ["orders.revenue"],
                "dimensions": ["orders.status"],
            }
        )
        assert_valid_sql(result.sql)
        assert result.resolved_plan.measures[0].provenance == Provenance.VERIFIED


class TestOrderByValidation:
    """ORDER BY on non-existent fields should error."""

    def test_order_by_unknown_field_rejected(self):
        from conftest import make_engine

        engine = make_engine(ECOMMERCE_SOURCES_DICT)
        with pytest.raises(ValueError, match="not a recognized measure or dimension"):
            engine.query(
                {
                    "measures": ["sum(orders.amount)"],
                    "dimensions": ["orders.status"],
                    "order_by": [{"field": "orders.created_at", "direction": "desc"}],
                }
            )

    def test_order_by_measure_name_accepted(self):
        from conftest import make_engine, assert_valid_sql

        engine = make_engine(ECOMMERCE_SOURCES_DICT)
        result = engine.query(
            {
                "measures": [{"expr": "sum(orders.amount)", "name": "total"}],
                "dimensions": ["orders.status"],
                "order_by": [{"field": "total", "direction": "desc"}],
            }
        )
        assert_valid_sql(result.sql)
        assert "total DESC" in result.sql or "total desc" in result.sql.lower()

    def test_order_by_dimension_field_accepted(self):
        from conftest import make_engine, assert_valid_sql

        engine = make_engine(ECOMMERCE_SOURCES_DICT)
        result = engine.query(
            {
                "measures": ["sum(orders.amount)"],
                "dimensions": ["orders.status"],
                "order_by": [{"field": "orders.status", "direction": "asc"}],
            }
        )
        assert_valid_sql(result.sql)


class TestEmptyFilter:
    """Empty filter strings should be silently skipped."""

    def test_empty_string_filter_ignored(self):
        from conftest import make_engine, assert_valid_sql

        engine = make_engine(ECOMMERCE_SOURCES_DICT)
        result = engine.query(
            {
                "measures": ["sum(orders.amount)"],
                "dimensions": ["orders.status"],
                "filters": [""],
            }
        )
        assert_valid_sql(result.sql)
        assert "WHERE \n" not in result.sql
        assert "WHERE  " not in result.sql

    def test_whitespace_only_filter_ignored(self):
        from conftest import make_engine, assert_valid_sql

        engine = make_engine(ECOMMERCE_SOURCES_DICT)
        result = engine.query(
            {
                "measures": ["sum(orders.amount)"],
                "dimensions": ["orders.status"],
                "filters": ["   "],
            }
        )
        assert_valid_sql(result.sql)

    def test_empty_mixed_with_real_filter(self):
        from conftest import make_engine, assert_valid_sql

        engine = make_engine(ECOMMERCE_SOURCES_DICT)
        result = engine.query(
            {
                "measures": ["sum(orders.amount)"],
                "dimensions": ["orders.status"],
                "filters": ["", "orders.status = 'completed'", "  "],
            }
        )
        assert_valid_sql(result.sql)
        assert "WHERE" in result.sql.upper()
        assert "completed" in result.sql
        assert len(result.resolved_plan.where_filters) == 1


class TestNonexistentMeasure:
    """Referencing a nonexistent pre-defined measure should error."""

    def test_nonexistent_measure_errors(self):
        from conftest import make_engine

        engine = make_engine(ECOMMERCE_SOURCES_DICT)
        with pytest.raises(ValueError, match="not a pre-defined measure"):
            engine.query(
                {
                    "measures": ["orders.nonexistent_measure"],
                    "dimensions": ["orders.status"],
                }
            )

    def test_existing_measure_works(self):
        from conftest import make_engine, assert_valid_sql

        engine = make_engine(ECOMMERCE_SOURCES_DICT)
        result = engine.query(
            {
                "measures": ["orders.revenue"],
                "dimensions": ["orders.status"],
            }
        )
        assert_valid_sql(result.sql)
        assert result.resolved_plan.measures[0].name == "revenue"


# ── From test_spec_gaps.py: column visibility ────────────────────────


class TestColumnVisibility:
    """Querying hidden columns should raise errors."""

    def test_hidden_column_rejected_in_dimension(self):
        from conftest import make_engine

        sources = {
            "users": {
                "name": "users",
                "table": "public.users",
                "grain": ["id"],
                "columns": [
                    {"name": "id", "type": "number"},
                    {"name": "name", "type": "string"},
                    {"name": "ssn", "type": "string", "visibility": "hidden"},
                ],
            },
        }
        engine = make_engine(sources)
        with pytest.raises(ValueError, match="[Hh]idden"):
            engine.query(
                {
                    "measures": ["count(users.id)"],
                    "dimensions": ["users.ssn"],
                }
            )

    def test_hidden_column_rejected_in_measure(self):
        from conftest import make_engine

        sources = {
            "users": {
                "name": "users",
                "table": "public.users",
                "grain": ["id"],
                "columns": [
                    {"name": "id", "type": "number"},
                    {"name": "secret_score", "type": "number", "visibility": "hidden"},
                ],
            },
        }
        engine = make_engine(sources)
        with pytest.raises(ValueError, match="[Hh]idden"):
            engine.query(
                {
                    "measures": ["sum(users.secret_score)"],
                    "dimensions": ["users.id"],
                }
            )

    def test_hidden_column_rejected_in_filter(self):
        from conftest import make_engine

        sources = {
            "users": {
                "name": "users",
                "table": "public.users",
                "grain": ["id"],
                "columns": [
                    {"name": "id", "type": "number"},
                    {"name": "name", "type": "string"},
                    {
                        "name": "internal_flag",
                        "type": "boolean",
                        "visibility": "hidden",
                    },
                ],
            },
        }
        engine = make_engine(sources)
        with pytest.raises(ValueError, match="[Hh]idden"):
            engine.query(
                {
                    "measures": ["count(users.id)"],
                    "dimensions": ["users.name"],
                    "filters": ["users.internal_flag = true"],
                }
            )

    def test_internal_column_allowed(self):
        from conftest import make_engine, assert_valid_sql

        sources = {
            "users": {
                "name": "users",
                "table": "public.users",
                "grain": ["id"],
                "columns": [
                    {"name": "id", "type": "number"},
                    {"name": "debug_col", "type": "string", "visibility": "internal"},
                ],
            },
        }
        engine = make_engine(sources)
        result = engine.query(
            {
                "measures": ["count(users.id)"],
                "dimensions": ["users.debug_col"],
            }
        )
        assert result.sql
        assert_valid_sql(result.sql)


# ── From test_edge_cases.py: derived measure cycles ─────────────────


class TestCyclicDerivedMeasures:
    def test_direct_cycle_a_b(self):
        from pathlib import Path

        engine = SemanticEngine(
            str(Path(__file__).parent.parent / "sources" / "ecommerce"),
            dialect="postgres",
        )
        with pytest.raises(ValueError, match="Circular dependency"):
            engine.query(
                {
                    "measures": [
                        {"expr": "b * 2", "name": "a"},
                        {"expr": "a + 1", "name": "b"},
                    ],
                    "dimensions": ["orders.status"],
                }
            )

    def test_three_way_cycle(self):
        from pathlib import Path

        engine = SemanticEngine(
            str(Path(__file__).parent.parent / "sources" / "ecommerce"),
            dialect="postgres",
        )
        with pytest.raises(ValueError, match="Circular dependency"):
            engine.query(
                {
                    "measures": [
                        {"expr": "c + sum(orders.amount)", "name": "a"},
                        {"expr": "a + 1", "name": "b"},
                        {"expr": "b + 1", "name": "c"},
                    ],
                    "dimensions": ["orders.status"],
                }
            )

    def test_self_referencing_measure(self):
        from pathlib import Path

        engine = SemanticEngine(
            str(Path(__file__).parent.parent / "sources" / "ecommerce"),
            dialect="postgres",
        )
        with pytest.raises(ValueError, match="Circular dependency"):
            engine.query(
                {
                    "measures": [
                        {"expr": "x + sum(orders.amount)", "name": "x"},
                    ],
                    "dimensions": ["orders.status"],
                }
            )

    def test_non_circular_derived_still_works(self):
        from conftest import assert_valid_sql
        from pathlib import Path

        engine = SemanticEngine(
            str(Path(__file__).parent.parent / "sources" / "ecommerce"),
            dialect="postgres",
        )
        result = engine.query(
            {
                "measures": [
                    {"expr": "sum(orders.amount)", "name": "total"},
                    {"expr": "sum(orders.cost)", "name": "cost"},
                    {"expr": "total - cost", "name": "profit"},
                ],
                "dimensions": ["orders.status"],
            }
        )
        assert "profit" in result.sql.lower()
        assert_valid_sql(result.sql)


# ── From test_edge_cases.py: derived measure edge cases ──────────────


class TestDerivedMeasureEdgeCases:
    def test_derived_measure_with_no_dependencies(self):
        from pathlib import Path

        engine = SemanticEngine(
            str(Path(__file__).parent.parent / "sources" / "ecommerce"),
            dialect="postgres",
        )
        with pytest.raises(ValueError):
            engine.query(
                {
                    "measures": [{"expr": "42", "name": "constant"}],
                    "dimensions": ["orders.status"],
                }
            )

    def test_multi_level_derived_chain(self):
        from conftest import assert_valid_sql
        from pathlib import Path

        engine = SemanticEngine(
            str(Path(__file__).parent.parent / "sources" / "ecommerce"),
            dialect="postgres",
        )
        result = engine.query(
            {
                "measures": [
                    {"expr": "sum(orders.amount)", "name": "base"},
                    {"expr": "base * 2", "name": "doubled"},
                    {"expr": "doubled + base", "name": "combined"},
                ],
                "dimensions": ["orders.status"],
            }
        )
        assert "combined" in result.sql
        assert_valid_sql(result.sql)


# ── From test_edge_cases.py: filter fanout detection ────────────────


class TestFilterFanOutDetection:
    def test_filter_only_fan_out_raises(self):
        from pathlib import Path

        engine = SemanticEngine(
            str(Path(__file__).parent.parent / "sources" / "ecommerce"),
            dialect="postgres",
        )
        with pytest.raises(ValueError, match="one_to_many join"):
            engine.query(
                {
                    "measures": ["sum(orders.amount)"],
                    "dimensions": ["orders.status"],
                    "filters": ["products.category = 'Electronics'"],
                }
            )

    def test_filter_on_dimension_source_ok(self):
        from conftest import assert_valid_sql
        from pathlib import Path

        engine = SemanticEngine(
            str(Path(__file__).parent.parent / "sources" / "ecommerce"),
            dialect="postgres",
        )
        result = engine.query(
            {
                "measures": ["sum(orders.amount)"],
                "dimensions": ["orders.status"],
                "filters": ["customers.segment = 'enterprise'"],
            }
        )
        assert "customers" in result.sql.lower()
        assert_valid_sql(result.sql)

    def test_filter_on_same_source_ok(self):
        from conftest import assert_valid_sql
        from pathlib import Path

        engine = SemanticEngine(
            str(Path(__file__).parent.parent / "sources" / "ecommerce"),
            dialect="postgres",
        )
        result = engine.query(
            {
                "measures": ["sum(orders.amount)"],
                "dimensions": ["orders.status"],
                "filters": ["orders.status != 'cancelled'"],
            }
        )
        assert_valid_sql(result.sql)


# ── From test_edge_cases.py: filter on dimension not in query ────────


class TestFilterOnDimensionNotInQuery:
    def test_filter_brings_in_new_source(self):
        from conftest import assert_valid_sql
        from pathlib import Path

        engine = SemanticEngine(
            str(Path(__file__).parent.parent / "sources" / "ecommerce"),
            dialect="postgres",
        )
        result = engine.query(
            {
                "measures": ["sum(orders.amount)"],
                "dimensions": ["orders.status"],
                "filters": ["regions.name = 'LATAM'"],
            }
        )
        sql = result.sql
        assert "regions" in sql.lower()
        assert "LATAM" in sql
        assert "customers" in sql.lower()
        assert_valid_sql(sql)

    def test_filter_on_products_with_order_measures_raises(self):
        from pathlib import Path

        engine = SemanticEngine(
            str(Path(__file__).parent.parent / "sources" / "ecommerce"),
            dialect="postgres",
        )
        with pytest.raises(ValueError, match="one_to_many join"):
            engine.query(
                {
                    "measures": ["sum(orders.amount)"],
                    "dimensions": ["orders.status"],
                    "filters": ["products.category = 'Electronics'"],
                }
            )


class TestMeasureNameCollision:
    """BUG 1: Same measure name across different sources gets qualified."""

    def test_same_measure_name_qualified(self):
        """Two sources each with 'revenue' measure -- names become source-qualified."""
        from conftest import make_engine

        sources = {
            "hub": {
                "name": "hub",
                "table": "public.hub",
                "grain": ["id"],
                "columns": [
                    {"name": "id", "type": "number"},
                    {"name": "segment", "type": "string"},
                ],
            },
            "online_sales": {
                "name": "online_sales",
                "table": "public.online_sales",
                "grain": ["id"],
                "columns": [
                    {"name": "id", "type": "number"},
                    {"name": "hub_id", "type": "number"},
                    {"name": "amount", "type": "number"},
                ],
                "joins": [
                    {
                        "to": "hub",
                        "on": "hub_id = hub.id",
                        "relationship": "many_to_one",
                    }
                ],
                "measures": [{"name": "revenue", "expr": "sum(amount)"}],
            },
            "store_sales": {
                "name": "store_sales",
                "table": "public.store_sales",
                "grain": ["id"],
                "columns": [
                    {"name": "id", "type": "number"},
                    {"name": "hub_id", "type": "number"},
                    {"name": "amount", "type": "number"},
                ],
                "joins": [
                    {
                        "to": "hub",
                        "on": "hub_id = hub.id",
                        "relationship": "many_to_one",
                    }
                ],
                "measures": [{"name": "revenue", "expr": "sum(amount)"}],
            },
        }
        engine = make_engine(sources)
        plan = engine.plan_only(
            {
                "measures": ["online_sales.revenue", "store_sales.revenue"],
                "dimensions": ["hub.segment"],
            }
        )
        measure_names = {m.name for m in plan.measures}
        assert "online_sales_revenue" in measure_names
        assert "store_sales_revenue" in measure_names
        assert "revenue" not in measure_names

    def test_no_qualification_when_no_collision(self):
        """Single source with 'revenue' -- name stays 'revenue'."""
        from conftest import make_engine

        sources = {
            "orders": {
                "name": "orders",
                "table": "public.orders",
                "grain": ["id"],
                "columns": [
                    {"name": "id", "type": "number"},
                    {"name": "amount", "type": "number"},
                    {"name": "status", "type": "string"},
                ],
                "measures": [{"name": "revenue", "expr": "sum(amount)"}],
            },
        }
        engine = make_engine(sources)
        plan = engine.plan_only(
            {
                "measures": ["orders.revenue"],
                "dimensions": ["orders.status"],
            }
        )
        assert plan.measures[0].name == "revenue"


class TestMeasureNameAsDimension:
    """Fix 3: Measure names should not be accepted as dimensions."""

    def test_measure_name_rejected_as_dimension(self):
        sources = {
            "orders": SourceDefinition(
                name="orders",
                table="public.orders",
                grain=["id"],
                columns=[
                    SourceColumn(name="id", type="number"),
                    SourceColumn(name="amount", type="number"),
                    SourceColumn(name="status", type="string"),
                ],
                measures=[MeasureDefinition(name="revenue", expr="sum(amount)")],
            ),
        }
        engine = SemanticEngine.from_sources(sources)
        with pytest.raises(ValueError, match="does not exist"):
            engine.query(
                {
                    "measures": ["sum(orders.amount)"],
                    "dimensions": ["orders.revenue"],
                }
            )

    def test_measure_name_accepted_in_filter(self):
        """Measure names in filters should still work (HAVING path)."""
        from conftest import assert_valid_sql

        sources = {
            "orders": SourceDefinition(
                name="orders",
                table="public.orders",
                grain=["id"],
                columns=[
                    SourceColumn(name="id", type="number"),
                    SourceColumn(name="amount", type="number"),
                    SourceColumn(name="status", type="string"),
                ],
                measures=[MeasureDefinition(name="revenue", expr="sum(amount)")],
            ),
        }
        engine = SemanticEngine.from_sources(sources)
        result = engine.query(
            {
                "measures": ["orders.revenue"],
                "dimensions": ["orders.status"],
                "filters": ["orders.revenue > 1000"],
            }
        )
        assert_valid_sql(result.sql)


class TestAliasValidation:
    """Fix 4: Alias refs should be validated for column existence and visibility."""

    def _build_alias_sources(self):
        return {
            "orders": SourceDefinition(
                name="orders",
                table="public.orders",
                grain=["id"],
                columns=[
                    SourceColumn(name="id", type="number"),
                    SourceColumn(name="billing_customer_id", type="number"),
                    SourceColumn(name="amount", type="number"),
                ],
                joins=[
                    JoinDeclaration(
                        to="customers",
                        on="billing_customer_id = customers.id",
                        relationship="many_to_one",
                        alias="billing_customer",
                    )
                ],
            ),
            "customers": SourceDefinition(
                name="customers",
                table="public.customers",
                grain=["id"],
                columns=[
                    SourceColumn(name="id", type="number"),
                    SourceColumn(name="name", type="string"),
                    SourceColumn(
                        name="secret_code",
                        type="string",
                        visibility=ColumnVisibility.HIDDEN,
                    ),
                ],
            ),
        }

    def test_alias_nonexistent_column_rejected(self):
        engine = SemanticEngine.from_sources(self._build_alias_sources())
        with pytest.raises(ValueError, match="does not exist"):
            engine.query(
                {
                    "measures": ["sum(orders.amount)"],
                    "dimensions": ["billing_customer.nonexistent_col"],
                }
            )

    def test_alias_hidden_column_rejected(self):
        engine = SemanticEngine.from_sources(self._build_alias_sources())
        with pytest.raises(ValueError, match="hidden"):
            engine.query(
                {
                    "measures": ["sum(orders.amount)"],
                    "dimensions": ["billing_customer.secret_code"],
                }
            )

    def test_alias_valid_column_accepted(self):
        from conftest import assert_valid_sql

        engine = SemanticEngine.from_sources(self._build_alias_sources())
        result = engine.query(
            {
                "measures": ["sum(orders.amount)"],
                "dimensions": ["billing_customer.name"],
            }
        )
        assert_valid_sql(result.sql)


class TestMultiSourceMeasure:
    """Fix 5: Multi-source measure expressions should include all source refs."""

    def test_multi_source_expr_includes_all_source_refs(self):
        sources = {
            "customers": SourceDefinition(
                name="customers",
                table="public.customers",
                grain=["id"],
                columns=[
                    SourceColumn(name="id", type="number"),
                    SourceColumn(name="segment", type="string"),
                ],
            ),
            "orders": SourceDefinition(
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
            ),
        }
        engine = SemanticEngine.from_sources(sources)
        result = engine.query(
            {
                "measures": [
                    {
                        "expr": "sum(orders.amount) / count(customers.id)",
                        "name": "amt_per_cust",
                    }
                ],
                "dimensions": ["customers.segment"],
            }
        )
        assert "orders" in result.resolved_plan.sources_used
        assert "customers" in result.resolved_plan.sources_used
        assert "JOIN" in result.sql.upper()


def test_derived_measure_with_bigquery_native_dependency(make_engine_factory):
    """Derived measure referencing a BigQuery-native base measure must not degrade."""
    source = {
        "name": "events",
        "table": "events",
        "grain": ["id"],
        "columns": [
            {"name": "id", "type": "number"},
            {"name": "user_id", "type": "number"},
        ],
        "measures": [
            {"name": "distinct_users", "expr": "APPROX_COUNT_DISTINCT(user_id)"},
            {
                "name": "thousand_users",
                "expr": "distinct_users / 1000.0",
            },
        ],
    }
    engine = make_engine_factory({"events": source}, dialect="bigquery")
    result = engine.query(
        {"measures": ["events.thousand_users"], "dimensions": [], "filters": []}
    )
    assert "APPROX_COUNT_DISTINCT" in result.sql.upper(), (
        f"APPROX_COUNT_DISTINCT was rewritten away:\n{result.sql}"
    )


class TestSourcelessAggregates:
    def test_count_star_unambiguous(self, planner):
        query = SemanticQuery(
            measures=["count(*)"],
            dimensions=["orders.status"],
        )
        plan = planner.plan(query)
        assert "orders" in plan.sources_used
        assert len(plan.measures) == 1
        assert plan.measures[0].source_name == "orders"
        assert "count" in plan.measures[0].expr.lower()

    def test_count_one_unambiguous(self, planner):
        query = SemanticQuery(
            measures=["count(1)"],
            dimensions=["orders.status"],
        )
        plan = planner.plan(query)
        assert "orders" in plan.sources_used
        assert len(plan.measures) == 1
        assert plan.measures[0].source_name == "orders"
        assert "count" in plan.measures[0].expr.lower()

    def test_sum_amount_unambiguous(self, planner):
        query = SemanticQuery(
            measures=["sum(amount)"],
            dimensions=["orders.status"],
        )
        plan = planner.plan(query)
        assert "orders" in plan.sources_used
        assert len(plan.measures) == 1
        assert plan.measures[0].source_name == "orders"
        assert "sum" in plan.measures[0].expr.lower()
        assert "orders.amount" in plan.measures[0].expr.lower()

    def test_mixed_measures_unambiguous(self, planner):
        query = SemanticQuery(
            measures=["sum(amount)", "count(*)"],
            dimensions=["orders.status"],
        )
        plan = planner.plan(query)
        assert "orders" in plan.sources_used
        assert len(plan.measures) == 2
        assert all(m.source_name == "orders" for m in plan.measures)
        exprs_lower = {m.expr.lower() for m in plan.measures}
        assert any("orders.amount" in e for e in exprs_lower)
        assert any("count" in e for e in exprs_lower)

    def test_unambiguous_via_other_measures(self, planner):
        query = SemanticQuery(
            measures=["count(*)", "sum(orders.amount)"],
        )
        plan = planner.plan(query)
        assert "orders" in plan.sources_used
        assert len(plan.measures) == 2
        assert all(m.source_name == "orders" for m in plan.measures)

    def test_measure_only_infer_via_other_qualified_measure(self, planner):
        query = SemanticQuery(
            measures=["sum(amount)", "count(orders.id)"],
        )
        plan = planner.plan(query)
        assert "orders" in plan.sources_used
        assert len(plan.measures) == 2
        assert all(m.source_name == "orders" for m in plan.measures)
        exprs_lower = {m.expr.lower() for m in plan.measures}
        assert any("orders.amount" in e for e in exprs_lower)
        assert any("orders.id" in e for e in exprs_lower)

    def test_unambiguous_dict_format(self, planner):
        query = SemanticQuery(
            measures=[{"expr": "sum(amount)", "name": "total_amount"}],
            dimensions=["orders.status"],
        )
        plan = planner.plan(query)
        assert "orders" in plan.sources_used
        assert len(plan.measures) == 1
        assert plan.measures[0].source_name == "orders"
        assert "sum" in plan.measures[0].expr.lower()
        assert "orders.amount" in plan.measures[0].expr.lower()

    def test_unambiguous_dict_format_count_star(self, planner):
        query = SemanticQuery(
            measures=[{"expr": "count(*)", "name": "total_count"}],
            dimensions=["orders.status"],
        )
        plan = planner.plan(query)
        assert "orders" in plan.sources_used
        assert len(plan.measures) == 1
        assert plan.measures[0].source_name == "orders"
        assert "count" in plan.measures[0].expr.lower()

    def test_ambiguous_raises(self, planner):
        query = SemanticQuery(
            measures=["count(*)"],
            dimensions=["orders.status", "customers.segment"],
        )
        with pytest.raises(ValueError) as exc:
            planner.plan(query)
        err_msg = str(exc.value).lower()
        assert "ambiguous" in err_msg
        assert "customers" in err_msg
        assert "orders" in err_msg
        assert "count(customers.id)" in err_msg
        assert "count(orders.id)" in err_msg

    def test_zero_sources_raises(self, planner):
        query = SemanticQuery(
            measures=["count(*)"],
        )
        with pytest.raises(ValueError) as exc:
            planner.plan(query)
        err_msg = str(exc.value).lower()
        assert "does not reference any source" in err_msg
        assert "customers" in err_msg
        assert "orders" in err_msg
        assert "count(customers.id)" in err_msg
        assert "count(orders.id)" in err_msg
