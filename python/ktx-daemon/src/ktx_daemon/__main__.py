"""Command entry point for one-shot ktx daemon compute operations."""

from __future__ import annotations

import argparse
import json
import sys
import time
from collections.abc import Callable
from types import TracebackType
from typing import Any

from pydantic import ValidationError

from ktx_daemon.code_execution import ExecuteCodeRequest, execute_code_response
from ktx_daemon.database_introspection import (
    DatabaseIntrospectionRequest,
    introspect_database_response,
)
from ktx_daemon.embeddings import (
    ComputeEmbeddingBulkRequest,
    ComputeEmbeddingRequest,
    compute_embedding_bulk_response,
    compute_embedding_response,
)
from ktx_daemon.lookml import ParseLookMLRequest, parse_lookml_project
from ktx_daemon.semantic_layer import (
    SemanticLayerQueryRequest,
    ValidateSourcesRequest,
    query_semantic_layer,
    validate_semantic_layer,
)
from ktx_daemon.source_generation import (
    GenerateSourcesRequest,
    generate_sources_response,
)

# The caller (the Node client) sent a well-formed request the compute layer
# refused as invalid — e.g. the planner rejecting an agent's query. A distinct
# exit code lets the client classify it as an expected outcome rather than a
# ktx fault. Kept in sync with DAEMON_INPUT_REJECTED_EXIT_CODE on the Node side.
INPUT_REJECTED_EXIT_CODE = 3


def build_parser() -> argparse.ArgumentParser:
    parser = argparse.ArgumentParser(prog="ktx-daemon")
    subcommands = parser.add_subparsers(dest="command", required=True)
    subcommands.add_parser("semantic-query", help="Compile a semantic-layer query")
    subcommands.add_parser("semantic-validate", help="Validate semantic-layer sources")
    subcommands.add_parser(
        "semantic-generate-sources",
        help="Generate semantic-layer sources from schema scan data",
    )
    subcommands.add_parser(
        "database-introspect",
        help="Introspect a Postgres database schema",
    )
    subcommands.add_parser(
        "lookml-parse",
        help="Parse LookML files into KSL-ready structures",
    )
    subcommands.add_parser(
        "embedding-compute",
        help="Compute one local text embedding",
    )
    subcommands.add_parser(
        "embedding-compute-bulk",
        help="Compute local text embeddings in bulk",
    )
    subcommands.add_parser(
        "code-execute",
        help="Execute Python code with the current in-process boundary",
    )
    serve_http = subcommands.add_parser(
        "serve-http",
        help="Run the ktx daemon portable compute HTTP server",
    )
    serve_http.add_argument("--host", default="127.0.0.1")
    serve_http.add_argument("--port", type=int, default=8765)
    serve_http.add_argument(
        "--log-level",
        default="info",
        choices=["critical", "error", "warning", "info", "debug", "trace"],
    )
    serve_http.add_argument(
        "--enable-code-execution",
        action="store_true",
        help="Expose POST /code/execute on the HTTP server",
    )
    return parser


def _read_stdin_json() -> dict[str, Any]:
    raw = sys.stdin.read()
    parsed = json.loads(raw)
    if not isinstance(parsed, dict):
        raise ValueError("stdin JSON must be an object")
    return parsed


def install_serve_http_exception_hooks(started_at: float) -> Callable[[], None]:
    original_hook = sys.excepthook

    def hook(
        exc_type: type[BaseException],
        exc: BaseException,
        tb: TracebackType | None,
    ) -> None:
        report_serve_http_crash(exc, started_at=started_at)
        original_hook(exc_type, exc, tb)

    sys.excepthook = hook

    def dispose() -> None:
        sys.excepthook = original_hook

    return dispose


def report_serve_http_crash(error: BaseException, *, started_at: float) -> None:
    from ktx_daemon.telemetry import report_exception
    from ktx_daemon.telemetry.daemon_lifecycle import emit_daemon_stopped_once

    report_exception(
        error,
        source="serve-http",
        handled=False,
        fatal=True,
    )
    emit_daemon_stopped_once(
        reason="crash",
        uptime_ms=max(0, (time.perf_counter() - started_at) * 1000),
    )


def run_http_server(
    *,
    host: str,
    port: int,
    log_level: str,
    enable_code_execution: bool,
) -> None:
    import uvicorn

    from ktx_daemon.app import create_app

    started_at = time.perf_counter()
    dispose_hooks = install_serve_http_exception_hooks(started_at)
    try:
        try:
            uvicorn.run(
                create_app(
                    enable_code_execution=enable_code_execution,
                    telemetry_started_at=started_at,
                ),
                host=host,
                port=port,
                log_level=log_level,
            )
        except Exception as error:
            report_serve_http_crash(error, started_at=started_at)
            raise
    finally:
        dispose_hooks()


def main(argv: list[str] | None = None) -> int:
    parser = build_parser()
    args = parser.parse_args(argv)

    if args.command == "serve-http":
        run_http_server(
            host=args.host,
            port=args.port,
            log_level=args.log_level,
            enable_code_execution=args.enable_code_execution,
        )
        return 0

    try:
        payload = _read_stdin_json()
        if args.command == "semantic-query":
            response = query_semantic_layer(
                SemanticLayerQueryRequest.model_validate(payload)
            )
        elif args.command == "semantic-validate":
            response = validate_semantic_layer(
                ValidateSourcesRequest.model_validate(payload)
            )
        elif args.command == "semantic-generate-sources":
            response = generate_sources_response(
                GenerateSourcesRequest.model_validate(payload)
            )
        elif args.command == "database-introspect":
            response = introspect_database_response(
                DatabaseIntrospectionRequest.model_validate(payload)
            )
        elif args.command == "lookml-parse":
            response = parse_lookml_project(ParseLookMLRequest.model_validate(payload))
        elif args.command == "embedding-compute":
            response = compute_embedding_response(
                ComputeEmbeddingRequest.model_validate(payload)
            )
        elif args.command == "embedding-compute-bulk":
            response = compute_embedding_bulk_response(
                ComputeEmbeddingBulkRequest.model_validate(payload)
            )
        elif args.command == "code-execute":
            response = execute_code_response(
                ExecuteCodeRequest.model_validate(payload),
                nest_api_url=None,
                auth_header=None,
            )
        else:
            parser.error(f"Unknown command: {args.command}")
            return 2
        sys.stdout.write(response.model_dump_json() + "\n")
        return 0
    except (json.JSONDecodeError, ValidationError) as error:
        # Malformed request envelope — ktx sent bad JSON or a mis-shaped payload.
        # That is a ktx fault, so keep the generic non-zero code (JSONDecodeError
        # subclasses ValueError, so this clause must precede the ValueError one).
        sys.stderr.write(f"{error}\n")
        return 1
    except ValueError as error:
        # The compute layer refused a well-formed request as invalid (e.g. the
        # planner rejecting the agent's measures). Expected, not a fault.
        sys.stderr.write(f"{error}\n")
        return INPUT_REJECTED_EXIT_CODE
    except Exception as error:
        from ktx_daemon.telemetry import report_exception

        report_exception(
            error,
            source=str(args.command),
            handled=True,
            fatal=False,
        )
        sys.stderr.write(f"{type(error).__name__}: {error}\n")
        return 1


if __name__ == "__main__":
    raise SystemExit(main())
