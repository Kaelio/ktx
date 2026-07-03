from __future__ import annotations

import io
import json
import os
import subprocess
import sys
from pathlib import Path
from typing import Any


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


def run_daemon_command(
    command: str, payload: dict[str, object]
) -> subprocess.CompletedProcess[str]:
    env = os.environ.copy()
    src_path = str(Path(__file__).resolve().parents[1] / "src")
    env["PYTHONPATH"] = src_path + os.pathsep + env.get("PYTHONPATH", "")
    return subprocess.run(
        [sys.executable, "-m", "ktx_daemon", command],
        input=json.dumps(payload),
        text=True,
        capture_output=True,
        check=False,
        env=env,
    )


def test_semantic_query_command_reads_stdin_and_writes_json() -> None:
    result = run_daemon_command(
        "semantic-query",
        {
            "sources": [ORDERS_SOURCE],
            "dialect": "postgres",
            "query": {
                "measures": ["orders.order_count"],
                "dimensions": ["orders.status"],
            },
        },
    )

    assert result.returncode == 0, result.stderr
    parsed = json.loads(result.stdout)
    assert "public.orders" in parsed["sql"]
    assert parsed["columns"][0]["name"] == "orders.status"


def test_semantic_validate_command_reads_stdin_and_writes_json() -> None:
    result = run_daemon_command(
        "semantic-validate",
        {"sources": [ORDERS_SOURCE], "dialect": "postgres"},
    )

    assert result.returncode == 0, result.stderr
    parsed = json.loads(result.stdout)
    assert parsed == {
        "valid": True,
        "errors": [],
        "warnings": [],
        "per_source_warnings": {},
    }


def test_command_returns_nonzero_for_invalid_json() -> None:
    env = os.environ.copy()
    src_path = str(Path(__file__).resolve().parents[1] / "src")
    env["PYTHONPATH"] = src_path + os.pathsep + env.get("PYTHONPATH", "")
    result = subprocess.run(
        [sys.executable, "-m", "ktx_daemon", "semantic-query"],
        input="{",
        text=True,
        capture_output=True,
        check=False,
        env=env,
    )

    assert result.returncode == 1
    assert "Expecting property name enclosed in double quotes" in result.stderr


def test_semantic_query_rejects_invalid_query_with_input_rejected_code() -> None:
    # A planner ValueError (agent's measure references no source) is an expected
    # input rejection, distinguished from a fault by INPUT_REJECTED_EXIT_CODE (3).
    result = run_daemon_command(
        "semantic-query",
        {
            "sources": [ORDERS_SOURCE],
            "dialect": "postgres",
            "query": {"measures": ["count(*)"], "dimensions": []},
        },
    )

    assert result.returncode == 3, result.stderr
    assert "does not reference any source" in result.stderr


def test_serve_http_command_starts_uvicorn_without_reading_stdin(
    monkeypatch,
) -> None:
    from ktx_daemon import __main__ as daemon_main

    calls: list[dict[str, object]] = []

    class FailingStdin:
        def read(self) -> str:
            raise AssertionError("serve-http must not read stdin JSON")

    def fake_run_http_server(
        *,
        host: str,
        port: int,
        log_level: str,
        enable_code_execution: bool,
    ) -> None:
        calls.append(
            {
                "host": host,
                "port": port,
                "log_level": log_level,
                "enable_code_execution": enable_code_execution,
            }
        )

    monkeypatch.setattr(sys, "stdin", FailingStdin())
    monkeypatch.setattr(daemon_main, "run_http_server", fake_run_http_server)

    assert (
        daemon_main.main(
            [
                "serve-http",
                "--host",
                "127.0.0.1",
                "--port",
                "9191",
                "--log-level",
                "warning",
            ]
        )
        == 0
    )
    assert calls == [
        {
            "host": "127.0.0.1",
            "port": 9191,
            "log_level": "warning",
            "enable_code_execution": False,
        }
    ]


def test_serve_http_command_defaults_to_loopback(monkeypatch) -> None:
    from ktx_daemon import __main__ as daemon_main

    calls: list[dict[str, object]] = []

    def fake_run_http_server(
        *,
        host: str,
        port: int,
        log_level: str,
        enable_code_execution: bool,
    ) -> None:
        calls.append(
            {
                "host": host,
                "port": port,
                "log_level": log_level,
                "enable_code_execution": enable_code_execution,
            }
        )

    monkeypatch.setattr(daemon_main, "run_http_server", fake_run_http_server)

    assert daemon_main.main(["serve-http"]) == 0
    assert calls == [
        {
            "host": "127.0.0.1",
            "port": 8765,
            "log_level": "info",
            "enable_code_execution": False,
        }
    ]


def test_serve_http_command_can_enable_code_execution(monkeypatch) -> None:
    from ktx_daemon import __main__ as daemon_main

    calls: list[dict[str, object]] = []

    def fake_run_http_server(
        *,
        host: str,
        port: int,
        log_level: str,
        enable_code_execution: bool,
    ) -> None:
        calls.append(
            {
                "host": host,
                "port": port,
                "log_level": log_level,
                "enable_code_execution": enable_code_execution,
            }
        )

    monkeypatch.setattr(daemon_main, "run_http_server", fake_run_http_server)

    assert daemon_main.main(["serve-http", "--enable-code-execution"]) == 0
    assert calls == [
        {
            "host": "127.0.0.1",
            "port": 8765,
            "log_level": "info",
            "enable_code_execution": True,
        }
    ]


def test_lookml_parse_command_reads_stdin_and_writes_json() -> None:
    result = run_daemon_command(
        "lookml-parse",
        {
            "files": [
                {
                    "path": "views/orders.view.lkml",
                    "content": """
view: orders {
  sql_table_name: public.orders ;;

  dimension: id {
    primary_key: yes
    type: number
    sql: ${TABLE}.id ;;
  }

  measure: order_count {
    type: count
  }
}
""",
                }
            ],
            "dialect": "postgres",
        },
    )

    assert result.returncode == 0, result.stderr
    parsed = json.loads(result.stdout)
    assert parsed["views"][0]["name"] == "orders"
    assert parsed["views"][0]["table_ref"] == "public.orders"
    assert parsed["views"][0]["measures"][0]["expr"] == "count(*)"
    assert parsed["joins"] == []
    assert parsed["skipped_views"] == []
    assert parsed["warnings"] == []


def test_semantic_generate_sources_command_reads_stdin_and_writes_json() -> None:
    result = run_daemon_command(
        "semantic-generate-sources",
        {
            "tables": [
                {
                    "name": "orders",
                    "db": "public",
                    "columns": [
                        {"name": "id", "type": "integer", "primary_key": True},
                        {"name": "amount", "type": "decimal"},
                    ],
                }
            ],
            "links": [],
            "dialect": "postgres",
        },
    )

    assert result.returncode == 0, result.stderr
    parsed = json.loads(result.stdout)
    assert parsed["source_count"] == 1
    assert parsed["sources"][0]["name"] == "orders"
    assert parsed["sources"][0]["table"] == "public.orders"
    assert parsed["sources"][0]["measures"] == [
        {
            "name": "record_count",
            "expr": "count(id)",
            "segments": [],
            "description": "Count of orders records",
        },
        {
            "name": "total_amount",
            "expr": "sum(amount)",
            "segments": [],
            "description": "Sum of amount",
        },
        {
            "name": "avg_amount",
            "expr": "avg(amount)",
            "segments": [],
            "description": "Average of amount",
        },
    ]


def test_database_introspect_command_reads_stdin_and_writes_json(
    monkeypatch, capsys
) -> None:
    from ktx_daemon import __main__ as daemon_main
    from ktx_daemon.database_introspection import (
        DatabaseIntrospectionResponse,
        LiveDatabaseColumn,
        LiveDatabaseTable,
    )

    def fake_introspect(request):
        assert request.connection_id == "warehouse"
        assert request.driver == "postgres"
        assert request.schemas == ["public"]
        assert request.table_scope is not None
        assert request.table_scope[0].db == "public"
        assert request.table_scope[0].name == "orders"
        return DatabaseIntrospectionResponse(
            connection_id="warehouse",
            extracted_at="2026-04-28T10:00:00+00:00",
            metadata={"driver": "postgres", "schemas": ["public"]},
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

    monkeypatch.setattr(daemon_main, "introspect_database_response", fake_introspect)
    monkeypatch.setattr(
        sys,
        "stdin",
        io.StringIO(
            '{"connection_id":"warehouse","driver":"postgres","url":"postgresql://readonly@example.test/warehouse","schemas":["public"],"table_scope":[{"db":"public","name":"orders"}]}'
        ),
    )

    assert daemon_main.main(["database-introspect"]) == 0
    captured = capsys.readouterr()
    parsed = json.loads(captured.out)
    assert parsed["connection_id"] == "warehouse"
    assert parsed["metadata"] == {"driver": "postgres", "schemas": ["public"]}
    assert parsed["tables"][0]["name"] == "orders"
    assert captured.err == ""


def test_embedding_compute_command_reads_stdin_and_writes_json(
    monkeypatch, capsys
) -> None:
    from ktx_daemon import __main__ as daemon_main
    from ktx_daemon.embeddings import ComputeEmbeddingResponse

    def fake_compute(request):
        assert request.text == "hello"
        return ComputeEmbeddingResponse(embedding=[1.0, 2.0, 3.0])

    monkeypatch.setattr(daemon_main, "compute_embedding_response", fake_compute)
    monkeypatch.setattr(sys, "stdin", io.StringIO('{"text": "hello"}'))

    assert daemon_main.main(["embedding-compute"]) == 0
    captured = capsys.readouterr()
    assert json.loads(captured.out) == {"embedding": [1.0, 2.0, 3.0]}
    assert captured.err == ""


def test_embedding_compute_bulk_command_reads_stdin_and_writes_json(
    monkeypatch, capsys
) -> None:
    from ktx_daemon import __main__ as daemon_main
    from ktx_daemon.embeddings import ComputeEmbeddingBulkResponse

    def fake_compute(request):
        assert request.texts == ["hello", "world"]
        return ComputeEmbeddingBulkResponse(embeddings=[[1.0, 2.0], [3.0, 4.0]])

    monkeypatch.setattr(daemon_main, "compute_embedding_bulk_response", fake_compute)
    monkeypatch.setattr(sys, "stdin", io.StringIO('{"texts": ["hello", "world"]}'))

    assert daemon_main.main(["embedding-compute-bulk"]) == 0
    captured = capsys.readouterr()
    assert json.loads(captured.out) == {"embeddings": [[1.0, 2.0], [3.0, 4.0]]}
    assert captured.err == ""


def test_code_execute_command_reads_stdin_and_writes_json(monkeypatch, capsys) -> None:
    from ktx_daemon import __main__ as daemon_main
    from ktx_daemon.code_execution import ExecuteCodeResponse

    calls: list[dict[str, Any]] = []

    def fake_execute(request, *, nest_api_url, auth_header):
        calls.append(
            {
                "request": request,
                "nest_api_url": nest_api_url,
                "auth_header": auth_header,
            }
        )
        return ExecuteCodeResponse(
            formatted_result="\n\n=== Result ===\n\n7",
            result=7,
        )

    monkeypatch.setattr(daemon_main, "execute_code_response", fake_execute)
    monkeypatch.setattr(sys, "stdin", io.StringIO('{"code": "result = 7"}'))

    assert daemon_main.main(["code-execute"]) == 0
    captured = capsys.readouterr()
    assert json.loads(captured.out) == {
        "formatted_result": "\n\n=== Result ===\n\n7",
        "result": 7,
        "console_output": None,
        "error": None,
        "message": None,
        "visualizations": None,
    }
    assert captured.err == ""
    assert calls[0]["request"].code == "result = 7"
    assert calls[0]["nest_api_url"] is None
    assert calls[0]["auth_header"] is None
