from __future__ import annotations

import json
from pathlib import Path


def test_python_schema_copy_matches_node_schema() -> None:
    repo_root = Path(__file__).resolve().parents[3]
    node_schema = json.loads(
        (repo_root / "packages/cli/src/telemetry/events.schema.json").read_text(
            encoding="utf-8"
        )
    )
    python_schema = json.loads(
        (
            repo_root / "python/ktx-daemon/src/ktx_daemon/telemetry/events.schema.json"
        ).read_text(encoding="utf-8")
    )

    assert python_schema == node_schema
    assert [event["name"] for event in python_schema["x-ktx-catalog"]] == [
        "install_first_run",
        "command",
        "setup_step",
        "connection_added",
        "connection_test",
        "project_stack_snapshot",
        "ingest_completed",
        "scan_completed",
        "sl_validate_completed",
        "sl_query_completed",
        "sql_completed",
        "mongo_query_completed",
        "wiki_query_completed",
        "mcp_request_completed",
        "daemon_started",
        "daemon_stopped",
        "sl_plan_completed",
        "sql_gen_completed",
        "query_history_filter_completed",
    ]
