from __future__ import annotations

import json
from pathlib import Path

from fastapi.testclient import TestClient

from ktx_daemon.app import create_app
from ktx_daemon.database_introspection import (
    DatabaseIntrospectionResponse,
    LiveDatabaseColumn,
    LiveDatabaseTable,
)


ORDERS_SOURCE = {
    "name": "orders",
    "table": "public.orders",
    "grain": ["id"],
    "columns": [
        {"name": "id", "type": "number"},
        {"name": "status", "type": "string"},
        {"name": "amount", "type": "number"},
    ],
    "joins": [],
    "measures": [{"name": "order_count", "expr": "count(*)"}],
}

LOOKML_ORDER_VIEW = """
view: orders {
  sql_table_name: public.orders ;;

  dimension: id {
    primary_key: yes
    type: number
    sql: ${TABLE}.id ;;
  }

  dimension: status {
    type: string
    sql: ${TABLE}.status ;;
  }

  measure: order_count {
    type: count
  }
}
"""


class FakeEmbeddingProvider:
    name = "fake"
    dimensions = 3
    max_batch_size = 2

    def __init__(self) -> None:
        self.calls: list[list[str]] = []

    def encode(self, texts: list[str]) -> list[list[float]]:
        self.calls.append(list(texts))
        return [
            [float(len(text)), float(index), 1.0] for index, text in enumerate(texts)
        ]


def test_health_endpoint_returns_healthy() -> None:
    client = TestClient(create_app())

    response = client.get("/health")

    assert response.status_code == 200
    assert response.json() == {"status": "healthy"}


def test_health_endpoint_returns_managed_runtime_version(monkeypatch) -> None:
    monkeypatch.setenv("KTX_DAEMON_VERSION", "0.2.0")
    client = TestClient(create_app())

    response = client.get("/health")

    assert response.status_code == 200
    assert response.json() == {"status": "healthy", "version": "0.2.0"}


def test_app_lifespan_emits_daemon_lifecycle_debug_events(
    tmp_path: Path,
    monkeypatch,
    capsys,
) -> None:
    from ktx_daemon.telemetry.daemon_lifecycle import reset_daemon_lifecycle_for_tests
    from ktx_daemon.telemetry.identity import reset_identity_cache

    reset_daemon_lifecycle_for_tests()
    reset_identity_cache()
    identity_path = tmp_path / ".ktx" / "telemetry.json"
    identity_path.parent.mkdir(parents=True)
    identity_path.write_text(
        json.dumps(
            {
                "installId": "00000000-0000-4000-8000-000000000000",
                "enabled": True,
                "createdAt": "2026-05-22T14:33:02.000Z",
            }
        )
        + "\n",
        encoding="utf-8",
    )
    monkeypatch.setenv("HOME", str(tmp_path))
    monkeypatch.setenv("KTX_TELEMETRY_DEBUG", "1")
    monkeypatch.setenv("KTX_DAEMON_VERSION", "0.4.1")
    monkeypatch.delenv("CI", raising=False)
    monkeypatch.delenv("KTX_TELEMETRY_DISABLED", raising=False)
    monkeypatch.delenv("DO_NOT_TRACK", raising=False)

    with TestClient(
        create_app(telemetry_started_at=100.0, clock=lambda: 100.125)
    ) as client:
        assert client.get("/health").status_code == 200

    captured = capsys.readouterr()
    assert '"event": "daemon_started"' in captured.err
    assert '"event": "daemon_stopped"' in captured.err


def test_database_introspect_endpoint_returns_snapshot() -> None:
    calls = []

    def fake_introspector(request):
        calls.append(request)
        return DatabaseIntrospectionResponse(
            connection_id=request.connection_id,
            extracted_at="2026-04-28T10:00:00+00:00",
            metadata={"driver": request.driver, "schemas": request.schemas},
            tables=[
                LiveDatabaseTable(
                    catalog="warehouse",
                    db="public",
                    name="orders",
                    columns=[
                        LiveDatabaseColumn(
                            name="id",
                            type="integer",
                            nullable=False,
                            primary_key=True,
                        )
                    ],
                )
            ],
        )

    client = TestClient(create_app(database_introspector=fake_introspector))

    response = client.post(
        "/database/introspect",
        json={
            "connection_id": "warehouse",
            "driver": "postgres",
            "url": "postgresql://readonly@example.test/warehouse",
            "schemas": ["public"],
            "table_scope": [{"db": "public", "name": "orders"}],
        },
    )

    assert response.status_code == 200
    assert response.json()["connection_id"] == "warehouse"
    assert response.json()["tables"][0]["name"] == "orders"
    assert calls[0].connection_id == "warehouse"
    assert calls[0].table_scope[0].db == "public"
    assert calls[0].table_scope[0].name == "orders"


def test_database_introspect_endpoint_maps_value_error_to_400() -> None:
    def fake_introspector(request):
        raise ValueError('database introspection supports only driver "postgres"')

    client = TestClient(create_app(database_introspector=fake_introspector))

    response = client.post(
        "/database/introspect",
        json={
            "connection_id": "warehouse",
            "driver": "snowflake",
            "url": "snowflake://example",
        },
    )

    assert response.status_code == 400
    assert response.json() == {
        "detail": 'database introspection supports only driver "postgres"'
    }


def test_embedding_compute_endpoint_returns_embedding() -> None:
    provider = FakeEmbeddingProvider()
    client = TestClient(create_app(embedding_provider=provider))

    response = client.post("/embeddings/compute", json={"text": "hello"})

    assert response.status_code == 200
    assert response.json() == {"embedding": [5.0, 0.0, 1.0]}
    assert provider.calls == [["hello"]]


def test_embedding_compute_bulk_endpoint_returns_embeddings() -> None:
    provider = FakeEmbeddingProvider()
    client = TestClient(create_app(embedding_provider=provider))

    response = client.post(
        "/embeddings/compute-bulk",
        json={"texts": ["one", "three"]},
    )

    assert response.status_code == 200
    assert response.json() == {"embeddings": [[3.0, 0.0, 1.0], [5.0, 1.0, 1.0]]}
    assert provider.calls == [["one", "three"]]


def test_embedding_compute_bulk_endpoint_maps_value_error_to_400() -> None:
    provider = FakeEmbeddingProvider()
    client = TestClient(create_app(embedding_provider=provider))

    response = client.post(
        "/embeddings/compute-bulk",
        json={"texts": ["one", "two", "three"]},
    )

    assert response.status_code == 400
    assert response.json() == {"detail": "Maximum 2 texts allowed per batch"}
    assert provider.calls == []


def test_code_execute_endpoint_is_not_registered_by_default() -> None:
    client = TestClient(create_app())

    response = client.post("/code/execute", json={"code": "result = 7"})

    assert response.status_code == 404


def test_code_execute_endpoint_returns_result_when_enabled() -> None:
    client = TestClient(create_app(enable_code_execution=True))

    response = client.post(
        "/code/execute",
        json={"code": 'print("ran")\nresult = {"value": 7}'},
    )

    assert response.status_code == 200
    body = response.json()
    assert body["result"] == {"value": 7}
    assert body["console_output"] == "ran\n"
    assert body["error"] is None
    assert body["message"] is None
    assert body["visualizations"] is None
    assert "=== Console Output ===" in body["formatted_result"]
    assert "=== Result ===" in body["formatted_result"]


def test_code_execute_endpoint_serializes_numpy_result_when_enabled() -> None:
    client = TestClient(create_app(enable_code_execution=True))

    response = client.post(
        "/code/execute",
        json={"code": "import numpy as np\nresult = {'value': np.float64(1.25)}"},
    )

    assert response.status_code == 200
    body = response.json()
    assert body["result"] == {"value": 1.25}
    assert body["error"] is None


def test_code_execute_endpoint_uses_host_free_boundary_when_enabled() -> None:
    client = TestClient(create_app(enable_code_execution=True))

    response = client.post(
        "/code/execute",
        json={
            "source_id": "chat_123",
            "message_id": "message_456",
            "code": (
                "import pandas as pd\n"
                "result = save_df_to_scratchpad(pd.DataFrame({'value': [1]}), 'out.json')"
            ),
        },
        headers={"Authorization": "Bearer should-not-forward"},
    )

    assert response.status_code == 200
    body = response.json()
    assert body["result"] is None
    assert (
        body["error"]
        == "nest_api_url, Authorization header, and source_id are required for scratchpad operations"
    )
    assert "=== Error ===" in body["formatted_result"]


def test_sql_parse_table_identifier_endpoint() -> None:
    client = TestClient(create_app())

    response = client.post(
        "/sql/parse-table-identifier",
        json={
            "items": [
                {
                    "key": "orders",
                    "sql_table_name": "public.orders",
                    "dialect": "postgres",
                },
                {
                    "key": "template",
                    "sql_table_name": "${orders.SQL_TABLE_NAME}",
                    "dialect": "postgres",
                },
            ]
        },
    )

    assert response.status_code == 200
    body = response.json()
    assert body["results"]["orders"]["ok"] is True
    assert body["results"]["orders"]["schema"] == "public"
    assert body["results"]["orders"]["name"] == "orders"
    assert body["results"]["template"]["ok"] is False
    assert body["results"]["template"]["reason"] == "looker_template_unresolved"


def test_sql_validate_read_only_endpoint() -> None:
    client = TestClient(create_app())

    ok_response = client.post(
        "/sql/validate-read-only",
        json={"dialect": "postgres", "sql": "select * from public.orders"},
    )
    bad_response = client.post(
        "/sql/validate-read-only",
        json={
            "dialect": "postgres",
            "sql": "with x as (insert into audit.events values (1) returning *) select * from x",
        },
    )

    assert ok_response.status_code == 200
    assert ok_response.json() == {"ok": True, "error": None}
    assert bad_response.status_code == 200
    assert bad_response.json() == {
        "ok": False,
        "error": "SQL contains read/write operation: Insert",
    }


def test_sql_analyze_batch_endpoint_returns_per_item_results() -> None:
    client = TestClient(create_app())

    response = client.post(
        "/sql/analyze-batch",
        json={
            "dialect": "postgres",
            "max_workers": 1,
            "items": [
                {
                    "id": "orders",
                    "sql": "select status from public.orders where created_at is not null",
                },
                {"id": "broken", "sql": "select * from where"},
            ],
        },
    )

    assert response.status_code == 200
    body = response.json()
    assert body["results"]["orders"]["tables_touched"] == [
        {"catalog": None, "db": "public", "name": "orders"}
    ]
    assert body["results"]["orders"]["columns_by_clause"] == {
        "select": ["status"],
        "where": ["created_at"],
    }
    assert body["results"]["orders"]["error"] is None
    assert body["results"]["broken"]["tables_touched"] == []
    assert body["results"]["broken"]["columns_by_clause"] == {}
    assert body["results"]["broken"]["error"] is not None


def test_semantic_query_endpoint_returns_sql() -> None:
    client = TestClient(create_app())

    response = client.post(
        "/semantic-layer/query",
        json={
            "sources": [ORDERS_SOURCE],
            "dialect": "postgres",
            "query": {
                "measures": ["orders.order_count"],
                "dimensions": ["orders.status"],
            },
        },
    )

    assert response.status_code == 200
    body = response.json()
    assert body["dialect"] == "postgres"
    assert "public.orders" in body["sql"]
    assert body["columns"][0]["name"] == "orders.status"


def test_semantic_query_endpoint_maps_value_error_to_400() -> None:
    client = TestClient(create_app())

    response = client.post(
        "/semantic-layer/query",
        json={
            "sources": [ORDERS_SOURCE],
            "dialect": "postgres",
            "query": {
                "measures": ["missing.order_count"],
                "dimensions": [],
            },
        },
    )

    assert response.status_code == 400
    assert "missing.order_count" in response.json()["detail"]


def test_semantic_query_endpoint_maps_malformed_source_to_fault() -> None:
    client = TestClient(create_app(), raise_server_exceptions=False)
    invalid_source = {
        key: value for key, value in ORDERS_SOURCE.items() if key != "table"
    }

    response = client.post(
        "/semantic-layer/query",
        json={
            "sources": [invalid_source],
            "dialect": "postgres",
            "query": {"measures": ["orders.order_count"], "dimensions": []},
        },
    )

    assert response.status_code == 500


def test_semantic_validate_endpoint_returns_structured_validation() -> None:
    client = TestClient(create_app())
    invalid_source = {
        **ORDERS_SOURCE,
        "measures": [
            {"name": "revenue", "expr": "sum(amount)"},
            {"name": "revenue", "expr": "sum(amount)"},
        ],
    }

    response = client.post(
        "/semantic-layer/validate",
        json={"sources": [invalid_source], "dialect": "postgres"},
    )

    assert response.status_code == 200
    body = response.json()
    assert body["valid"] is False
    assert any("Duplicate measure" in error for error in body["errors"])
    assert body["warnings"] == []
    assert body["per_source_warnings"] == {}


def test_semantic_generate_sources_endpoint_returns_sources() -> None:
    client = TestClient(create_app())

    response = client.post(
        "/semantic-layer/generate-sources",
        json={
            "tables": [
                {
                    "name": "orders",
                    "db": "public",
                    "comment": "Orders table",
                    "columns": [
                        {
                            "name": "id",
                            "type": "integer",
                            "primary_key": True,
                            "nullable": False,
                            "comment": "Order ID",
                        },
                        {"name": "customer_id", "type": "integer"},
                        {
                            "name": "amount",
                            "type": "decimal",
                            "comment": "Order amount",
                        },
                    ],
                },
                {
                    "name": "customers",
                    "db": "public",
                    "columns": [
                        {"name": "id", "type": "integer", "primary_key": True},
                        {"name": "email", "type": "varchar"},
                    ],
                },
            ],
            "links": [
                {
                    "from_table": "orders",
                    "from_column": "customer_id",
                    "to_table": "customers",
                    "to_column": "id",
                    "relationship_type": "MANY_TO_ONE",
                }
            ],
            "dialect": "postgres",
        },
    )

    assert response.status_code == 200
    body = response.json()
    assert body["source_count"] == 2
    sources = {source["name"]: source for source in body["sources"]}
    assert sources["orders"]["table"] == "public.orders"
    assert sources["orders"]["description"] == "Orders table"
    assert sources["orders"]["grain"] == ["id"]
    assert sources["orders"]["joins"] == [
        {
            "to": "customers",
            "on": "customer_id = customers.id",
            "relationship": "many_to_one",
        }
    ]
    assert [measure["name"] for measure in sources["orders"]["measures"]] == [
        "record_count",
        "total_amount",
        "avg_amount",
    ]


def test_lookml_parse_endpoint_returns_resolved_views() -> None:
    client = TestClient(create_app())

    response = client.post(
        "/lookml/parse",
        json={
            "files": [
                {
                    "path": "views/orders.view.lkml",
                    "content": LOOKML_ORDER_VIEW,
                }
            ],
            "dialect": "postgres",
        },
    )

    assert response.status_code == 200
    body = response.json()
    assert body["joins"] == []
    assert body["skipped_views"] == []
    assert body["warnings"] == []
    assert len(body["views"]) == 1
    view = body["views"][0]
    assert view["name"] == "orders"
    assert view["source_type"] == "table"
    assert view["table_ref"] == "public.orders"
    assert view["grain"] == ["id"]
    assert [column["name"] for column in view["columns"]] == ["id", "status"]
    assert view["measures"] == [
        {
            "name": "order_count",
            "expr": "count(*)",
            "filter": None,
            "description": None,
        }
    ]
