"""Semantic-layer compute helpers for the ktx daemon package."""

from __future__ import annotations

import time
from typing import Any

from ktx_daemon.telemetry import error_class, report_exception, track_telemetry_event
from pydantic import BaseModel, ConfigDict, Field, ValidationError
from semantic_layer.duplicate_check import validate_measure_duplicates
from semantic_layer.engine import SemanticEngine
from semantic_layer.models import QueryResult, SourceDefinition


class SemanticLayerQueryRequest(BaseModel):
    model_config = ConfigDict(extra="forbid")

    sources: list[dict[str, Any]]
    query: dict[str, Any]
    dialect: str = "postgres"
    project_id: str | None = Field(default=None, alias="projectId")


class SemanticLayerQueryResponse(BaseModel):
    sql: str
    dialect: str
    columns: list[dict[str, Any]]
    plan: dict[str, Any]


class ValidateSourcesRequest(BaseModel):
    sources: list[dict[str, Any]]
    dialect: str = "postgres"
    recently_touched: list[str] | None = None


class ValidateSourcesResponse(BaseModel):
    valid: bool
    errors: list[str] = Field(default_factory=list)
    warnings: list[str] = Field(default_factory=list)
    per_source_warnings: dict[str, list[str]] = Field(default_factory=dict)


def _load_sources(raw_sources: list[dict[str, Any]]) -> dict[str, SourceDefinition]:
    sources: dict[str, SourceDefinition] = {}
    for raw_source in raw_sources:
        source = SourceDefinition(**raw_source)
        if source.name in sources:
            raise ValueError(f"Duplicate source name '{source.name}'")
        sources[source.name] = source
    return sources


def _validate_duplicate_measure_names(source: SourceDefinition) -> list[str]:
    errors: list[str] = []
    seen: set[str] = set()
    for measure in source.measures:
        if measure.name in seen:
            errors.append(
                f"Duplicate measure '{measure.name}' on source '{source.name}'"
            )
            continue
        seen.add(measure.name)
    return errors


def _response_columns(result: QueryResult) -> list[dict[str, Any]]:
    measure_names = {
        measure.name: measure.qualified_ref
        for measure in result.resolved_plan.measures
        if measure.qualified_ref
    }
    columns: list[dict[str, Any]] = []
    for column in result.columns:
        dumped = column.model_dump(mode="json")
        if column.provenance.value == "dimension" and column.expr:
            dumped["name"] = column.expr
        elif column.name in measure_names:
            dumped["name"] = measure_names[column.name]
        columns.append(dumped)
    return columns


def query_semantic_layer(
    request: SemanticLayerQueryRequest,
) -> SemanticLayerQueryResponse:
    started = time.perf_counter()
    stage = "parse"
    source_count = 0
    join_count = 0
    sql_started = started
    try:
        sources = _load_sources(request.sources)
        source_count = len(sources)
        join_count = sum(len(source.joins) for source in sources.values())
        stage = "resolve"
        engine = SemanticEngine.from_sources(sources, dialect=request.dialect)
        stage = "compile"
        sql_started = time.perf_counter()
        result = engine.query(request.query)
        stage = "transpile"
        track_telemetry_event(
            "sl_plan_completed",
            {
                "outcome": "ok",
                "stage": stage,
                "durationMs": max(0, (time.perf_counter() - started) * 1000),
                "sourceCount": source_count,
                "joinCount": join_count,
            },
            project_id=request.project_id,
        )
        track_telemetry_event(
            "sql_gen_completed",
            {
                "outcome": "ok",
                "dialect": result.dialect,
                "durationMs": max(0, (time.perf_counter() - sql_started) * 1000),
            },
            project_id=request.project_id,
        )
        return SemanticLayerQueryResponse(
            sql=result.sql,
            dialect=result.dialect,
            columns=_response_columns(result),
            plan=result.resolved_plan.model_dump(mode="json"),
        )
    except Exception as error:
        klass = error_class(error)
        fields: dict[str, Any] = {
            "outcome": "error",
            "stage": stage,
            "durationMs": max(0, (time.perf_counter() - started) * 1000),
            "sourceCount": source_count,
            "joinCount": join_count,
        }
        if klass:
            fields["errorClass"] = klass
        track_telemetry_event(
            "sl_plan_completed", fields, project_id=request.project_id
        )
        if stage in {"compile", "transpile"}:
            sql_fields: dict[str, Any] = {
                "outcome": "error",
                "dialect": request.dialect,
                "durationMs": max(0, (time.perf_counter() - sql_started) * 1000),
            }
            if klass:
                sql_fields["errorClass"] = klass
            track_telemetry_event(
                "sql_gen_completed", sql_fields, project_id=request.project_id
            )
        # A ValueError is the engine refusing the caller's query — an expected
        # rejection surfaced to the agent, not a ktx fault. Keep it out of Error
        # Tracking (a pydantic ValidationError subclasses ValueError but means a
        # malformed request envelope, so it stays a reported fault).
        if not isinstance(error, ValueError) or isinstance(error, ValidationError):
            report_exception(
                error,
                source="semantic-query",
                handled=True,
                fatal=False,
                project_id=request.project_id,
            )
        raise


def validate_semantic_layer(request: ValidateSourcesRequest) -> ValidateSourcesResponse:
    errors: list[str] = []
    warnings: list[str] = []
    per_source_warnings: dict[str, list[str]] = {}
    sources: dict[str, SourceDefinition] = {}
    seen_names: set[str] = set()

    for raw_source in request.sources:
        raw_name = raw_source.get("name") if isinstance(raw_source, dict) else None
        try:
            source = SourceDefinition(**raw_source)
        except Exception as error:
            label = raw_name or "<unknown>"
            errors.append(f"Source '{label}' failed to parse: {error}")
            continue

        if source.name in seen_names:
            errors.append(f"Duplicate source name '{source.name}'")
            continue
        seen_names.add(source.name)
        sources[source.name] = source
        errors.extend(_validate_duplicate_measure_names(source))

    if sources:
        try:
            engine = SemanticEngine.from_sources(sources, dialect=request.dialect)
            report = engine.validate(
                recently_touched=set(request.recently_touched)
                if request.recently_touched
                else None
            )
            errors.extend(report.errors)
            warnings.extend(report.warnings)
            per_source_warnings.update(report.per_source_warnings)
            errors.extend(validate_measure_duplicates(sources, dialect=request.dialect))
        except Exception as error:
            errors.append(f"Validation failed: {error}")

    return ValidateSourcesResponse(
        valid=len(errors) == 0,
        errors=errors,
        warnings=warnings,
        per_source_warnings=per_source_warnings,
    )
