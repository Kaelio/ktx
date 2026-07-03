from __future__ import annotations

import json
from pathlib import Path

import pytest

from ktx_daemon.semantic_layer import (
    SemanticLayerQueryRequest,
    ValidateSourcesRequest,
    query_semantic_layer,
    validate_semantic_layer,
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
    "measures": [
        {"name": "order_count", "expr": "count(*)"},
        {"name": "revenue", "expr": "sum(amount)"},
    ],
}


def test_query_semantic_layer_generates_sql_and_plan() -> None:
    response = query_semantic_layer(
        SemanticLayerQueryRequest(
            sources=[ORDERS_SOURCE],
            dialect="postgres",
            query={
                "measures": ["orders.order_count"],
                "dimensions": ["orders.status"],
                "limit": 25,
            },
        )
    )

    assert response.dialect == "postgres"
    assert "public.orders" in response.sql
    assert "orders.status" in response.sql
    assert response.columns[0]["name"] == "orders.status"
    assert response.columns[1]["name"] == "orders.order_count"
    assert response.plan["sources_used"] == ["orders"]


def test_query_semantic_layer_enforces_predefined_measures_only() -> None:
    with pytest.raises(ValueError, match="composed measure"):
        query_semantic_layer(
            SemanticLayerQueryRequest(
                sources=[ORDERS_SOURCE],
                dialect="postgres",
                query={
                    "measures": ["sum(orders.amount)"],
                    "predefined_measures_only": True,
                },
            )
        )


def test_query_semantic_layer_allows_predefined_measures_under_policy() -> None:
    response = query_semantic_layer(
        SemanticLayerQueryRequest(
            sources=[ORDERS_SOURCE],
            dialect="postgres",
            query={
                "measures": ["orders.revenue"],
                "predefined_measures_only": True,
            },
        )
    )
    assert "public.orders" in response.sql


def test_query_semantic_layer_emits_plan_and_sql_debug_events(
    tmp_path: Path,
    monkeypatch,
    capsys,
) -> None:
    from ktx_daemon.telemetry.identity import reset_identity_cache

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
    monkeypatch.delenv("CI", raising=False)
    monkeypatch.delenv("KTX_TELEMETRY_DISABLED", raising=False)
    monkeypatch.delenv("DO_NOT_TRACK", raising=False)

    query_semantic_layer(
        SemanticLayerQueryRequest(
            sources=[ORDERS_SOURCE],
            dialect="postgres",
            projectId="a" * 64,
            query={
                "measures": ["orders.order_count"],
                "dimensions": ["orders.status"],
                "limit": 25,
            },
        )
    )

    captured = capsys.readouterr()
    assert '"event": "sl_plan_completed"' in captured.err
    assert '"event": "sql_gen_completed"' in captured.err
    assert "public.orders" not in captured.err


def test_query_semantic_layer_reports_unexpected_fault(monkeypatch) -> None:
    from ktx_daemon import semantic_layer as semantic_layer_module

    reports: list[dict[str, object]] = []

    def fake_report(exception: BaseException, **kwargs: object) -> None:
        reports.append({"exception": exception, **kwargs})

    def boom(*_args: object, **_kwargs: object) -> None:
        raise RuntimeError("engine construction failed")

    monkeypatch.setattr(semantic_layer_module, "report_exception", fake_report)
    monkeypatch.setattr(semantic_layer_module.SemanticEngine, "from_sources", boom)

    with pytest.raises(RuntimeError):
        query_semantic_layer(
            SemanticLayerQueryRequest(
                sources=[ORDERS_SOURCE],
                dialect="postgres",
                projectId="a" * 64,
                query={"measures": ["orders.order_count"]},
            )
        )

    assert reports
    assert reports[0]["source"] == "semantic-query"
    assert reports[0]["handled"] is True
    assert reports[0]["fatal"] is False
    assert reports[0]["project_id"] == "a" * 64


def test_query_semantic_layer_does_not_report_expected_query_rejection(
    monkeypatch,
) -> None:
    from ktx_daemon import semantic_layer as semantic_layer_module

    reports: list[dict[str, object]] = []
    monkeypatch.setattr(
        semantic_layer_module,
        "report_exception",
        lambda *_args, **kwargs: reports.append(kwargs),
    )

    # A planner ValueError is the engine refusing the agent's query — surfaced to
    # the caller and re-raised, but never filed as a ktx fault.
    with pytest.raises(ValueError, match="does not reference any source"):
        query_semantic_layer(
            SemanticLayerQueryRequest(
                sources=[ORDERS_SOURCE],
                dialect="postgres",
                query={"measures": ["count(*)"]},
            )
        )

    assert reports == []


def test_semantic_layer_request_rejects_project_id_field_name() -> None:
    with pytest.raises(ValueError):
        SemanticLayerQueryRequest(
            sources=[],
            dialect="postgres",
            project_id="a" * 64,
            query={"measures": ["orders.order_count"]},
        )


def test_validate_semantic_layer_reports_duplicate_measure_names() -> None:
    invalid_source = {
        **ORDERS_SOURCE,
        "measures": [
            {"name": "revenue", "expr": "sum(amount)"},
            {"name": "revenue", "expr": "sum(amount)"},
        ],
    }

    response = validate_semantic_layer(
        ValidateSourcesRequest(sources=[invalid_source], dialect="postgres")
    )

    assert response.valid is False
    assert any("Duplicate measure" in error for error in response.errors)
    assert response.warnings == []
