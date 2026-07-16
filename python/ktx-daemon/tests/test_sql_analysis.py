from __future__ import annotations

from ktx_daemon.sql_analysis import (
    AnalyzeSqlBatchItem,
    AnalyzeSqlBatchRequest,
    ValidateReadOnlySqlRequest,
    _columns_from_nodes,
    analyze_sql_batch_response,
    validate_read_only_sql_response,
)


def test_analyze_sql_batch_extracts_tables_and_clause_columns() -> None:
    response = analyze_sql_batch_response(
        AnalyzeSqlBatchRequest(
            dialect="postgres",
            items=[
                AnalyzeSqlBatchItem(
                    id="orders_by_customer",
                    sql=(
                        "select o.status, count(*) "
                        "from public.orders o "
                        "join public.customers c on o.customer_id = c.id "
                        "where o.created_at >= current_date - interval '30 day' "
                        "group by o.status"
                    ),
                )
            ],
            max_workers=1,
        )
    )

    result = response.results["orders_by_customer"]
    assert result.error is None
    assert [item.model_dump() for item in result.tables_touched] == [
        {"catalog": None, "db": "public", "name": "orders"},
        {"catalog": None, "db": "public", "name": "customers"},
    ]
    assert result.columns_by_clause == {
        "select": ["status"],
        "where": ["created_at"],
        "join": ["customer_id", "id"],
        "groupBy": ["status"],
    }


def test_analyze_sql_batch_returns_per_item_parse_errors() -> None:
    response = analyze_sql_batch_response(
        AnalyzeSqlBatchRequest(
            dialect="postgres",
            items=[AnalyzeSqlBatchItem(id="broken", sql="select * from where")],
            max_workers=1,
        )
    )

    result = response.results["broken"]
    assert result.tables_touched == []
    assert result.columns_by_clause == {}
    assert result.error is not None


def test_analyze_sql_batch_qualifies_bare_table_from_catalog() -> None:
    response = analyze_sql_batch_response(
        AnalyzeSqlBatchRequest(
            dialect="postgres",
            catalog={
                "tables": [
                    {
                        "catalog": None,
                        "db": "orbit_raw",
                        "name": "accounts",
                        "columns": ["id"],
                    },
                    {
                        "catalog": None,
                        "db": "orbit_analytics",
                        "name": "orders",
                        "columns": ["id"],
                    },
                ]
            },
            items=[AnalyzeSqlBatchItem(id="bare", sql="select id from accounts")],
            max_workers=1,
        )
    )

    assert [item.model_dump() for item in response.results["bare"].tables_touched] == [
        {"catalog": None, "db": "orbit_raw", "name": "accounts"}
    ]


def test_analyze_sql_batch_returns_all_ambiguous_modeled_matches() -> None:
    response = analyze_sql_batch_response(
        AnalyzeSqlBatchRequest(
            dialect="postgres",
            catalog={
                "tables": [
                    {
                        "catalog": None,
                        "db": "orbit_raw",
                        "name": "events",
                        "columns": ["id"],
                    },
                    {
                        "catalog": None,
                        "db": "orbit_analytics",
                        "name": "events",
                        "columns": ["id"],
                    },
                ]
            },
            items=[AnalyzeSqlBatchItem(id="ambiguous", sql="select id from events")],
            max_workers=1,
        )
    )

    assert [
        item.model_dump() for item in response.results["ambiguous"].tables_touched
    ] == [
        {"catalog": None, "db": "orbit_raw", "name": "events"},
        {"catalog": None, "db": "orbit_analytics", "name": "events"},
    ]


def test_analyze_sql_batch_leaves_unresolved_bare_refs_unqualified() -> None:
    response = analyze_sql_batch_response(
        AnalyzeSqlBatchRequest(
            dialect="postgres",
            catalog={
                "tables": [{"catalog": None, "db": "orbit_raw", "name": "accounts"}]
            },
            items=[AnalyzeSqlBatchItem(id="missing", sql="select * from invoices")],
            max_workers=1,
        )
    )

    assert [
        item.model_dump() for item in response.results["missing"].tables_touched
    ] == [{"catalog": None, "db": None, "name": "invoices"}]


def test_analyze_sql_batch_returns_bigquery_project_dataset_table_refs() -> None:
    response = analyze_sql_batch_response(
        AnalyzeSqlBatchRequest(
            dialect="bigquery",
            catalog={
                "tables": [
                    {
                        "catalog": "demo-project",
                        "db": "orbit_analytics",
                        "name": "orders",
                    }
                ]
            },
            items=[
                AnalyzeSqlBatchItem(
                    id="bq",
                    sql="select * from `demo-project.orbit_analytics.orders`",
                )
            ],
            max_workers=1,
        )
    )

    assert [item.model_dump() for item in response.results["bq"].tables_touched] == [
        {"catalog": "demo-project", "db": "orbit_analytics", "name": "orders"}
    ]


def test_analyze_sql_batch_accepts_hologres_dialect_as_postgres() -> None:
    # Hologres has no sqlglot dialect; it must analyze as postgres, not error.
    response = analyze_sql_batch_response(
        AnalyzeSqlBatchRequest(
            dialect="hologres",
            items=[
                AnalyzeSqlBatchItem(
                    id="holo",
                    sql="select l_orderkey from public.lineitem where l_quantity > 10",
                )
            ],
            max_workers=1,
        )
    )

    result = response.results["holo"]
    assert result.error is None
    assert [item.model_dump() for item in result.tables_touched] == [
        {"catalog": None, "db": "public", "name": "lineitem"}
    ]
    assert result.columns_by_clause == {
        "select": ["l_orderkey"],
        "where": ["l_quantity"],
    }


def test_columns_from_nodes_ignores_non_expression_clause_values() -> None:
    assert _columns_from_nodes([True, False, None]) == []


def test_validate_read_only_sql_accepts_select_and_with_queries() -> None:
    select_response = validate_read_only_sql_response(
        ValidateReadOnlySqlRequest(
            dialect="postgres",
            sql="select id, status from public.orders where status = 'paid'",
        )
    )
    with_response = validate_read_only_sql_response(
        ValidateReadOnlySqlRequest(
            dialect="postgres",
            sql=(
                "with paid as (select * from public.orders where status = 'paid') "
                "select count(*) from paid"
            ),
        )
    )

    assert select_response.ok is True
    assert select_response.error is None
    assert with_response.ok is True
    assert with_response.error is None


def test_validate_read_only_sql_rejects_cte_dml() -> None:
    response = validate_read_only_sql_response(
        ValidateReadOnlySqlRequest(
            dialect="postgres",
            sql="with x as (insert into audit.events values (1) returning *) select * from x",
        )
    )

    assert response.ok is False
    assert response.error == "SQL contains read/write operation: Insert"


def test_validate_read_only_sql_rejects_multi_statement_payloads() -> None:
    response = validate_read_only_sql_response(
        ValidateReadOnlySqlRequest(
            dialect="postgres",
            sql="select * from public.orders; delete from public.orders",
        )
    )

    assert response.ok is False
    assert response.error == "Only one SQL statement can be executed."


def test_validate_read_only_sql_rejects_commands_and_pragmas() -> None:
    command_response = validate_read_only_sql_response(
        ValidateReadOnlySqlRequest(dialect="postgres", sql="call refresh_stats()")
    )
    pragma_response = validate_read_only_sql_response(
        ValidateReadOnlySqlRequest(dialect="sqlite", sql="pragma table_info(users)")
    )

    assert command_response.ok is False
    assert command_response.error == "SQL contains read/write operation: Command"
    assert pragma_response.ok is False
    assert pragma_response.error == "SQL contains read/write operation: Pragma"


def test_validate_read_only_sql_reports_parse_errors() -> None:
    response = validate_read_only_sql_response(
        ValidateReadOnlySqlRequest(dialect="postgres", sql="select * from where")
    )

    assert response.ok is False
    assert response.error is not None
    assert "Invalid expression" in response.error


def test_validate_read_only_sql_accepts_hologres_dialect() -> None:
    response = validate_read_only_sql_response(
        ValidateReadOnlySqlRequest(
            dialect="hologres",
            sql="select l_orderkey from public.lineitem",
        )
    )

    assert response.ok is True
    assert response.error is None
