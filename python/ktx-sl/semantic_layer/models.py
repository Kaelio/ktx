from __future__ import annotations

from enum import Enum
from typing import Any, Literal

from pydantic import BaseModel, ConfigDict, Field, model_validator


# ── Source Definition Models ──────────────────────────────────────────


class ColumnVisibility(str, Enum):
    PUBLIC = "public"
    INTERNAL = "internal"
    HIDDEN = "hidden"


class ColumnRole(str, Enum):
    TIME = "time"
    DEFAULT = "default"


class ColumnDbtConstraints(BaseModel):
    not_null: bool | None = None
    unique: bool | None = None


class DbtDataTestRef(BaseModel):
    name: str
    package: str
    kwargs: dict[str, Any] | None = None


class SourceColumnTests(BaseModel):
    dbt: list[DbtDataTestRef] | None = None
    dbt_by_package: dict[str, list[str]] | None = None


_DEFAULT_DESCRIPTION_PRIORITY = ["user", "ai", "dbt", "db"]


def _resolve_description_map(descriptions: dict[str, str] | None) -> str | None:
    if not descriptions:
        return None
    for source in _DEFAULT_DESCRIPTION_PRIORITY:
        text = descriptions.get(source)
        if text:
            return text
    for text in descriptions.values():
        if text:
            return text
    return None


class FreshnessDbt(BaseModel):
    raw: Any | None = None
    loaded_at_field: str | None = None


class SourceColumn(BaseModel):
    name: str
    type: Literal["string", "number", "time", "boolean"]
    visibility: ColumnVisibility = ColumnVisibility.PUBLIC
    role: ColumnRole = ColumnRole.DEFAULT
    description: str | None = None
    descriptions: dict[str, str] | None = None
    expr: str | None = None
    natural_granularity: str | None = None
    constraints: dict[str, ColumnDbtConstraints] | None = None
    enum_values: dict[str, list[str]] | None = None
    tests: SourceColumnTests | None = None

    @model_validator(mode="after")
    def resolve_description(self) -> SourceColumn:
        if self.description is None:
            self.description = _resolve_description_map(self.descriptions)
        return self


class JoinDeclaration(BaseModel):
    to: str
    on: str  # e.g. "customer_id = customers.id"
    relationship: Literal["many_to_one", "one_to_many", "one_to_one"]
    alias: str | None = None


class MeasureDefinition(BaseModel):
    name: str
    expr: str  # e.g. "sum(amount)"
    filter: str | None = None  # e.g. "status != 'refunded'"
    segments: list[str] = []  # bare segment names defined on the measure's own source
    description: str | None = None


class Segment(BaseModel):
    """A named, reusable boolean predicate scoped to a single source."""

    name: str
    expr: str  # e.g. "is_paid = true and is_refunded = '0'"
    description: str | None = None


class DefaultTimeDimensionDbt(BaseModel):
    dbt: str | None = None


class SourceDefinition(BaseModel):
    model_config = ConfigDict(extra="forbid")

    name: str
    description: str | None = None
    descriptions: dict[str, str] | None = None
    table: str | None = None
    sql: str | None = None
    grain: list[str]
    columns: list[SourceColumn]
    joins: list[JoinDeclaration] = []
    measures: list[MeasureDefinition] = []
    segments: list[Segment] = []
    default_time_dimension: DefaultTimeDimensionDbt | None = None
    tags: dict[str, list[str]] | None = None
    freshness: dict[str, FreshnessDbt] | None = None

    @model_validator(mode="after")
    def validate_source(self) -> SourceDefinition:
        if self.description is None:
            self.description = _resolve_description_map(self.descriptions)
        if not self.table and not self.sql:
            raise ValueError("resolved source must have 'table' or 'sql'")
        if self.table and self.sql:
            raise ValueError("'table' and 'sql' are mutually exclusive")
        if not self.grain:
            raise ValueError("grain must be non-empty")
        return self

    @property
    def is_sql_source(self) -> bool:
        return self.sql is not None

    @property
    def is_table_source(self) -> bool:
        return self.table is not None


# ── Query Models ──────────────────────────────────────────────────────


class QueryMeasure(BaseModel):
    """Either a pre-defined name ('orders.revenue') or runtime expr."""

    ref: str | None = None
    expr: str | None = None
    name: str | None = None


class QueryDimension(BaseModel):
    """Either a column ref or a time granularity."""

    field: str
    granularity: str | None = None


class SemanticQuery(BaseModel):
    measures: list[str | dict[str, Any]]
    dimensions: list[str | dict[str, Any]] = []
    filters: list[str] = []
    # dotted "source.segment" names; AND-ed into matching measures
    segments: list[str] = []
    order_by: list[str | dict[str, Any]] = []
    limit: int = 1000
    include_empty: bool = True
    # Set by ktx from the connection's query_policy, never by agent input:
    # reject runtime-composed measures so only predefined measures execute.
    predefined_measures_only: bool = False

    @model_validator(mode="after")
    def _validate_limit(self) -> SemanticQuery:
        if self.limit is not None and self.limit < 0:
            raise ValueError(f"limit must be non-negative, got {self.limit}")
        return self


# ── Plan & Result Models ──────────────────────────────────────────────


class Provenance(str, Enum):
    VERIFIED = "verified"
    COMPOSED = "composed"
    DIMENSION = "dimension"


class ResolvedColumn(BaseModel):
    name: str
    provenance: Provenance
    expr: str | None = None
    description: str | None = None
    granularity: str | None = None


class ResolvedMeasure(BaseModel):
    name: str
    expr: str  # the aggregate expression, e.g. "sum(amount)"
    source_name: str
    original_name: str | None = None
    qualified_ref: str | None = None
    filter: str | None = None
    provenance: Provenance = Provenance.COMPOSED
    is_derived: bool = False
    depends_on: list[str] = []  # names of other measures this depends on
    description: str | None = None


class MeasureGroup(BaseModel):
    """A group of measures from the same source, for aggregate locality."""

    source_name: str
    measures: list[ResolvedMeasure]
    join_path_to_dims: list[str] = []


class ResolvedJoin(BaseModel):
    from_source: str
    to_source: str
    from_column: str
    to_column: str
    relationship: str


class OrderByClause(BaseModel):
    field: str
    direction: str = "asc"


class ResolvedPlan(BaseModel):
    sources_used: list[str]
    join_paths: list[str]  # human-readable descriptions
    joins: list[ResolvedJoin] = []  # structured join info for generator
    anchor_source: str | None = None  # the primary FROM source
    anchor_grain: list[str]
    fan_out_description: str
    has_fan_out: bool = False
    measure_groups: list[MeasureGroup] = []
    aggregate_locality: list[str]  # human-readable CTE descriptions
    where_filters: list[str]
    having_filters: list[str]
    columns: list[ResolvedColumn]
    measures: list[ResolvedMeasure] = []
    dimensions: list[QueryDimension] = []
    order_by: list[OrderByClause] = []
    limit: int | None = None
    include_empty: bool = True


class QueryResult(BaseModel):
    resolved_plan: ResolvedPlan
    sql: str
    dialect: str
    columns: list[ResolvedColumn]


class ValidationReport(BaseModel):
    errors: list[str] = Field(default_factory=list)
    warnings: list[str] = Field(default_factory=list)
    per_source_warnings: dict[str, list[str]] = Field(default_factory=dict)

    @property
    def valid(self) -> bool:
        return len(self.errors) == 0
