"""FastAPI app factory for the ktx daemon semantic compute server."""

from __future__ import annotations

import logging
import os
import sys
import time
from contextlib import asynccontextmanager
from collections.abc import Callable
from typing import Any

from fastapi import FastAPI, HTTPException, Request
from fastapi.responses import JSONResponse, Response
from pydantic import ValidationError

from ktx_daemon import VERSION
from ktx_daemon.code_execution import (
    ExecuteCodeRequest,
    ExecuteCodeResponse,
    dumps_numpy_json,
    execute_code_response,
)
from ktx_daemon.database_introspection import (
    DatabaseIntrospectionRequest,
    DatabaseIntrospectionResponse,
    introspect_database_response,
)
from ktx_daemon.embeddings import (
    ComputeEmbeddingBulkRequest,
    ComputeEmbeddingBulkResponse,
    ComputeEmbeddingRequest,
    ComputeEmbeddingResponse,
    EmbeddingProvider,
    compute_embedding_bulk_response,
    compute_embedding_response,
)
from ktx_daemon.lookml import (
    ParseLookMLRequest,
    ParseLookMLResponse,
    parse_lookml_project,
)
from ktx_daemon.semantic_layer import (
    SemanticLayerQueryRequest,
    SemanticLayerQueryResponse,
    ValidateSourcesRequest,
    ValidateSourcesResponse,
    query_semantic_layer,
    validate_semantic_layer,
)
from ktx_daemon.source_generation import (
    GenerateSourcesRequest,
    GenerateSourcesResponse,
    generate_sources_response,
)
from ktx_daemon.sql_analysis import (
    AnalyzeSqlBatchRequest,
    AnalyzeSqlBatchResponse,
    ValidateReadOnlySqlRequest,
    ValidateReadOnlySqlResponse,
    analyze_sql_batch_response,
    validate_read_only_sql_response,
)
from ktx_daemon.table_identifier import (
    ParseTableIdentifierBatchRequest,
    ParseTableIdentifierBatchResponse,
    parse_table_identifier_response,
)
from ktx_daemon.telemetry import report_exception, track_telemetry_event
from ktx_daemon.telemetry.daemon_lifecycle import emit_daemon_stopped_once

logger = logging.getLogger(__name__)
CREDENTIAL_KEYS = {"url", "password", "token", "api_key", "apikey", "auth_header"}


class NumpyORJSONResponse(Response):
    media_type = "application/json"

    def render(self, content: Any) -> bytes:
        return dumps_numpy_json(content)


def _route_source(request: Request) -> str:
    route = request.scope.get("route")
    path = getattr(route, "path", None)
    if isinstance(path, str) and path:
        return f"app:{path}"
    return f"app:{request.url.path}"


def _secret_snapshot_from_payload(value: Any) -> list[str]:
    secrets: list[str] = []
    if isinstance(value, dict):
        for key, child in value.items():
            normalized_key = str(key).lower()
            if normalized_key in CREDENTIAL_KEYS and isinstance(child, str) and child:
                secrets.append(child)
            secrets.extend(_secret_snapshot_from_payload(child))
    elif isinstance(value, list):
        for child in value:
            secrets.extend(_secret_snapshot_from_payload(child))
    return secrets


async def _request_secret_snapshot(request: Request) -> list[str]:
    try:
        payload = await request.json()
    except Exception:
        return []
    return _secret_snapshot_from_payload(payload)


def create_app(
    *,
    embedding_provider: EmbeddingProvider | None = None,
    database_introspector: Callable[
        [DatabaseIntrospectionRequest], DatabaseIntrospectionResponse
    ]
    | None = None,
    enable_code_execution: bool = False,
    telemetry_started_at: float | None = None,
    clock: Callable[[], float] = time.perf_counter,
) -> FastAPI:
    started_at = telemetry_started_at or clock()

    @asynccontextmanager
    async def lifespan(_: FastAPI):
        track_telemetry_event(
            "daemon_started",
            {
                "daemonVersion": os.environ.get("KTX_DAEMON_VERSION", VERSION),
                "pythonVersion": f"{sys.version_info.major}.{sys.version_info.minor}.{sys.version_info.micro}",
                "runtimeVersion": VERSION,
                "startupDurationMs": max(0, (clock() - started_at) * 1000),
            },
        )
        try:
            yield
        finally:
            emit_daemon_stopped_once(
                reason="request",
                uptime_ms=max(0, (clock() - started_at) * 1000),
            )

    app = FastAPI(
        title="ktx Daemon",
        description="Stateless portable compute server for ktx.",
        version=VERSION,
        lifespan=lifespan,
    )

    @app.middleware("http")
    async def report_unhandled_exceptions(request: Request, call_next):
        redaction_secrets = await _request_secret_snapshot(request)
        try:
            return await call_next(request)
        except Exception as error:
            logger.exception("Unhandled daemon request failed: %s", error)
            report_exception(
                error,
                source=_route_source(request),
                handled=True,
                fatal=False,
                redaction_secrets=redaction_secrets,
            )
            return JSONResponse(
                status_code=500,
                content={"detail": f"Daemon request failed: {error}"},
            )

    @app.get("/health")
    async def health() -> dict[str, str]:
        response = {"status": "healthy"}
        version = os.environ.get("KTX_DAEMON_VERSION")
        if version:
            response["version"] = version
        return response

    @app.post("/database/introspect", response_model=DatabaseIntrospectionResponse)
    async def database_introspect(
        request: DatabaseIntrospectionRequest,
    ) -> DatabaseIntrospectionResponse:
        try:
            introspector = database_introspector or introspect_database_response
            return introspector(request)
        except ValueError as error:
            logger.warning("Database introspection rejected: %s", error)
            raise HTTPException(status_code=400, detail=str(error)) from error

    @app.post("/embeddings/compute", response_model=ComputeEmbeddingResponse)
    async def embedding_compute(
        request: ComputeEmbeddingRequest,
    ) -> ComputeEmbeddingResponse:
        try:
            return compute_embedding_response(
                request,
                provider=embedding_provider,
            )
        except ValueError as error:
            logger.warning("Embedding compute rejected: %s", error)
            raise HTTPException(status_code=400, detail=str(error)) from error

    @app.post(
        "/embeddings/compute-bulk",
        response_model=ComputeEmbeddingBulkResponse,
    )
    async def embedding_compute_bulk(
        request: ComputeEmbeddingBulkRequest,
    ) -> ComputeEmbeddingBulkResponse:
        try:
            return compute_embedding_bulk_response(
                request,
                provider=embedding_provider,
            )
        except ValueError as error:
            logger.warning("Bulk embedding compute rejected: %s", error)
            raise HTTPException(status_code=400, detail=str(error)) from error

    if enable_code_execution:

        @app.post(
            "/code/execute",
            response_model=ExecuteCodeResponse,
            response_class=NumpyORJSONResponse,
        )
        async def code_execute(request: ExecuteCodeRequest) -> ExecuteCodeResponse:
            return execute_code_response(
                request,
                nest_api_url=None,
                auth_header=None,
            )

    @app.post("/lookml/parse", response_model=ParseLookMLResponse)
    async def lookml_parse(request: ParseLookMLRequest) -> ParseLookMLResponse:
        return parse_lookml_project(request)

    @app.post(
        "/sql/parse-table-identifier",
        response_model=ParseTableIdentifierBatchResponse,
    )
    async def sql_parse_table_identifier(
        request: ParseTableIdentifierBatchRequest,
    ) -> ParseTableIdentifierBatchResponse:
        return parse_table_identifier_response(request)

    @app.post("/sql/validate-read-only", response_model=ValidateReadOnlySqlResponse)
    async def sql_validate_read_only(
        request: ValidateReadOnlySqlRequest,
    ) -> ValidateReadOnlySqlResponse:
        return validate_read_only_sql_response(request)

    @app.post("/sql/analyze-batch", response_model=AnalyzeSqlBatchResponse)
    async def sql_analyze_batch(
        request: AnalyzeSqlBatchRequest,
    ) -> AnalyzeSqlBatchResponse:
        return analyze_sql_batch_response(request)

    @app.post(
        "/semantic-layer/generate-sources", response_model=GenerateSourcesResponse
    )
    async def semantic_generate_sources(
        request: GenerateSourcesRequest,
    ) -> GenerateSourcesResponse:
        return generate_sources_response(request)

    @app.post("/semantic-layer/query", response_model=SemanticLayerQueryResponse)
    async def semantic_query(
        request: SemanticLayerQueryRequest,
    ) -> SemanticLayerQueryResponse:
        try:
            return query_semantic_layer(request)
        except ValidationError as error:
            # A malformed source or response is a ktx contract fault, not a
            # caller rejection; surface it as a server fault (500) so the Node
            # client does not classify it as an expected query rejection, matching
            # the subprocess transport (exit 1) and query_semantic_layer's own
            # report. ValidationError subclasses ValueError, so catch it first.
            logger.exception("Semantic query failed on a malformed source")
            raise HTTPException(status_code=500, detail=str(error)) from error
        except ValueError as error:
            logger.warning("Semantic query rejected: %s", error)
            raise HTTPException(status_code=400, detail=str(error)) from error

    @app.post("/semantic-layer/validate", response_model=ValidateSourcesResponse)
    async def semantic_validate(
        request: ValidateSourcesRequest,
    ) -> ValidateSourcesResponse:
        return validate_semantic_layer(request)

    return app
