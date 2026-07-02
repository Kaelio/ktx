from __future__ import annotations

import pytest

from ktx_daemon.database_introspection import (
    OBJECT_INTROSPECTION_FAILED_CODE,
    DatabaseIntrospectionRequest,
    DatabaseIntrospectionRows,
    LiveDatabaseTableScopeRef,
    _statement_timeout_config,
    _table_scope_json,
    introspect_database_response,
)


def test_introspect_database_response_maps_postgres_catalog_rows() -> None:
    def fake_load_rows(
        request: DatabaseIntrospectionRequest,
    ) -> DatabaseIntrospectionRows:
        assert request.connection_id == "warehouse"
        assert request.driver == "postgres"
        assert request.schemas == ["public"]
        return DatabaseIntrospectionRows(
            table_rows=[
                {
                    "table_catalog": "warehouse",
                    "table_schema": "public",
                    "table_name": "customers",
                    "table_comment": None,
                },
                {
                    "table_catalog": "warehouse",
                    "table_schema": "public",
                    "table_name": "orders",
                    "table_comment": "Orders table",
                },
            ],
            column_rows=[
                {
                    "table_catalog": "warehouse",
                    "table_schema": "public",
                    "table_name": "orders",
                    "column_name": "id",
                    "formatted_type": "integer",
                    "is_nullable": False,
                    "is_primary_key": True,
                    "column_comment": "Order ID",
                },
                {
                    "table_catalog": "warehouse",
                    "table_schema": "public",
                    "table_name": "orders",
                    "column_name": "customer_id",
                    "formatted_type": "integer",
                    "is_nullable": False,
                    "is_primary_key": False,
                    "column_comment": None,
                },
                {
                    "table_catalog": "warehouse",
                    "table_schema": "public",
                    "table_name": "customers",
                    "column_name": "id",
                    "formatted_type": "integer",
                    "is_nullable": False,
                    "is_primary_key": True,
                    "column_comment": None,
                },
            ],
            foreign_key_rows=[
                {
                    "table_catalog": "warehouse",
                    "table_schema": "public",
                    "table_name": "orders",
                    "from_column": "customer_id",
                    "to_table": "customers",
                    "to_column": "id",
                    "constraint_name": "orders_customer_id_fkey",
                }
            ],
        )

    response = introspect_database_response(
        DatabaseIntrospectionRequest(
            connection_id="warehouse",
            driver="postgres",
            url="postgresql://readonly@example.test/warehouse",
            schemas=["public"],
        ),
        load_rows=fake_load_rows,
        now=lambda: "2026-04-28T10:00:00+00:00",
    )

    assert response.connection_id == "warehouse"
    assert response.extracted_at == "2026-04-28T10:00:00+00:00"
    assert response.metadata == {"driver": "postgres", "schemas": ["public"]}
    assert [table.name for table in response.tables] == ["customers", "orders"]
    orders = response.tables[1]
    assert orders.model_dump(exclude_none=True) == {
        "catalog": "warehouse",
        "db": "public",
        "name": "orders",
        "comment": "Orders table",
        "columns": [
            {
                "name": "id",
                "type": "integer",
                "nullable": False,
                "primary_key": True,
                "comment": "Order ID",
            },
            {
                "name": "customer_id",
                "type": "integer",
                "nullable": False,
                "primary_key": False,
            },
        ],
        "foreign_keys": [
            {
                "from_column": "customer_id",
                "to_table": "customers",
                "to_column": "id",
                "constraint_name": "orders_customer_id_fkey",
            }
        ],
    }


def test_introspect_database_response_isolates_a_broken_object() -> None:
    def fake_load_rows(
        request: DatabaseIntrospectionRequest,
    ) -> DatabaseIntrospectionRows:
        return DatabaseIntrospectionRows(
            table_rows=[
                {
                    "table_catalog": "warehouse",
                    "table_schema": "public",
                    "table_name": "customers",
                    "table_comment": None,
                },
                # Malformed/inaccessible object: missing table_name.
                {
                    "table_catalog": "warehouse",
                    "table_schema": "public",
                    "table_name": None,
                    "table_comment": None,
                },
            ],
            column_rows=[],
            foreign_key_rows=[],
        )

    response = introspect_database_response(
        DatabaseIntrospectionRequest(
            connection_id="warehouse",
            driver="postgres",
            url="postgresql://readonly@example.test/warehouse",
            schemas=["public"],
        ),
        load_rows=fake_load_rows,
        now=lambda: "2026-04-28T10:00:00+00:00",
    )

    assert [table.name for table in response.tables] == ["customers"]
    assert len(response.warnings) == 1
    # Parity with the Node KtxScanWarningCode the adapter renders.
    assert (
        response.warnings[0].code
        == OBJECT_INTROSPECTION_FAILED_CODE
        == "object_introspection_failed"
    )
    assert response.warnings[0].recoverable is True


def test_introspect_database_response_warns_on_broken_column_and_fk_rows() -> None:
    # A malformed column or foreign-key row must surface a warning, not vanish
    # silently — the table-row path already does, and a dropped column is data loss.
    def fake_load_rows(
        request: DatabaseIntrospectionRequest,
    ) -> DatabaseIntrospectionRows:
        return DatabaseIntrospectionRows(
            table_rows=[
                {
                    "table_catalog": "warehouse",
                    "table_schema": "public",
                    "table_name": "orders",
                    "table_comment": None,
                }
            ],
            column_rows=[
                {
                    "table_catalog": "warehouse",
                    "table_schema": "public",
                    "table_name": "orders",
                    "column_name": "id",
                    "formatted_type": "integer",
                    "is_nullable": False,
                    "is_primary_key": True,
                    "column_comment": None,
                },
                # Malformed column: missing formatted_type.
                {
                    "table_catalog": "warehouse",
                    "table_schema": "public",
                    "table_name": "orders",
                    "column_name": "broken_col",
                    "formatted_type": None,
                    "is_nullable": True,
                    "is_primary_key": False,
                    "column_comment": None,
                },
            ],
            foreign_key_rows=[
                # Malformed FK: missing to_table.
                {
                    "table_catalog": "warehouse",
                    "table_schema": "public",
                    "table_name": "orders",
                    "from_column": "customer_id",
                    "to_table": None,
                    "to_column": "id",
                    "constraint_name": "orders_customer_id_fkey",
                }
            ],
        )

    response = introspect_database_response(
        DatabaseIntrospectionRequest(
            connection_id="warehouse",
            driver="postgres",
            url="postgresql://readonly@example.test/warehouse",
            schemas=["public"],
        ),
        load_rows=fake_load_rows,
        now=lambda: "2026-04-28T10:00:00+00:00",
    )

    assert [column.name for column in response.tables[0].columns] == ["id"]
    assert {(w.code, w.table, w.column) for w in response.warnings} == {
        (OBJECT_INTROSPECTION_FAILED_CODE, "orders", "broken_col"),
        (OBJECT_INTROSPECTION_FAILED_CODE, "orders", "customer_id"),
    }
    assert all(warning.recoverable for warning in response.warnings)


def test_introspect_database_response_rejects_non_postgres_driver() -> None:
    with pytest.raises(ValueError, match='supports only driver "postgres"'):
        introspect_database_response(
            DatabaseIntrospectionRequest(
                connection_id="warehouse",
                driver="snowflake",
                url="snowflake://example",
            ),
            load_rows=lambda request: DatabaseIntrospectionRows([], [], []),
        )


def test_introspect_database_response_rejects_legacy_postgresql_driver() -> None:
    with pytest.raises(ValueError, match='supports only driver "postgres"'):
        introspect_database_response(
            DatabaseIntrospectionRequest(
                connection_id="warehouse",
                driver="postgresql",
                url="postgresql://readonly@example.test/warehouse",
            ),
            load_rows=lambda request: DatabaseIntrospectionRows([], [], []),
        )


def test_database_introspection_request_rejects_empty_schema_list() -> None:
    with pytest.raises(ValueError, match="at least one schema"):
        DatabaseIntrospectionRequest(
            connection_id="warehouse",
            driver="postgres",
            url="postgresql://readonly@example.test/warehouse",
            schemas=[],
        )


def test_table_scope_json_serializes_null_wildcards() -> None:
    assert _table_scope_json(
        [
            LiveDatabaseTableScopeRef(catalog=None, db="public", name="orders"),
            LiveDatabaseTableScopeRef(
                catalog="warehouse",
                db="marts",
                name="customers",
            ),
        ]
    ) == (
        '[{"catalog": null, "db": "public", "name": "orders"}, '
        '{"catalog": "warehouse", "db": "marts", "name": "customers"}]'
    )


def test_statement_timeout_config_uses_parameterized_set_config() -> None:
    assert _statement_timeout_config(30_000) == (
        "SELECT set_config('statement_timeout', %s, true)",
        ("30000ms",),
    )
