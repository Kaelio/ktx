"""Portable database introspection helpers for ktx daemon."""

from __future__ import annotations

import json
from collections.abc import Callable, Mapping, Sequence
from dataclasses import dataclass
from datetime import datetime, timezone
from typing import Any

from pydantic import BaseModel, Field, field_validator


TABLES_SQL = """
select
  t.table_catalog,
  t.table_schema,
  t.table_name,
  obj_description(c.oid) as table_comment
from information_schema.tables t
join pg_catalog.pg_namespace n
  on n.nspname = t.table_schema
join pg_catalog.pg_class c
  on c.relnamespace = n.oid
  and c.relname = t.table_name
where t.table_schema = any(%s)
  and t.table_type = 'BASE TABLE'
  and (
    %s::jsonb is null
    or exists (
      select 1
      from jsonb_to_recordset(%s::jsonb) as scope(catalog text, db text, name text)
      where (scope.catalog is null or scope.catalog = current_database())
        and (scope.db is null or scope.db = t.table_schema)
        and scope.name = t.table_name
    )
  )
order by t.table_schema, t.table_name
"""

COLUMNS_SQL = """
select
  current_database() as table_catalog,
  n.nspname as table_schema,
  c.relname as table_name,
  a.attname as column_name,
  pg_catalog.format_type(a.atttypid, a.atttypmod) as formatted_type,
  not a.attnotnull as is_nullable,
  exists (
    select 1
    from pg_catalog.pg_index i
    where i.indrelid = c.oid
      and i.indisprimary
      and a.attnum = any(i.indkey)
  ) as is_primary_key,
  pg_catalog.col_description(c.oid, a.attnum) as column_comment
from pg_catalog.pg_attribute a
join pg_catalog.pg_class c
  on c.oid = a.attrelid
join pg_catalog.pg_namespace n
  on n.oid = c.relnamespace
where n.nspname = any(%s)
  and c.relkind in ('r', 'p')
  and a.attnum > 0
  and not a.attisdropped
  and (
    %s::jsonb is null
    or exists (
      select 1
      from jsonb_to_recordset(%s::jsonb) as scope(catalog text, db text, name text)
      where (scope.catalog is null or scope.catalog = current_database())
        and (scope.db is null or scope.db = n.nspname)
        and scope.name = c.relname
    )
  )
order by n.nspname, c.relname, a.attnum
"""

FOREIGN_KEYS_SQL = """
select
  current_database() as table_catalog,
  source_constraint.table_schema,
  source_constraint.table_name,
  source_key.column_name as from_column,
  target_key.table_name as to_table,
  target_key.column_name as to_column,
  source_constraint.constraint_name
from information_schema.table_constraints source_constraint
join information_schema.key_column_usage source_key
  on source_key.constraint_catalog = source_constraint.constraint_catalog
  and source_key.constraint_schema = source_constraint.constraint_schema
  and source_key.constraint_name = source_constraint.constraint_name
join information_schema.referential_constraints ref_constraint
  on ref_constraint.constraint_catalog = source_constraint.constraint_catalog
  and ref_constraint.constraint_schema = source_constraint.constraint_schema
  and ref_constraint.constraint_name = source_constraint.constraint_name
join information_schema.key_column_usage target_key
  on target_key.constraint_catalog = ref_constraint.unique_constraint_catalog
  and target_key.constraint_schema = ref_constraint.unique_constraint_schema
  and target_key.constraint_name = ref_constraint.unique_constraint_name
  and target_key.ordinal_position = source_key.position_in_unique_constraint
where source_constraint.constraint_type = 'FOREIGN KEY'
  and source_constraint.table_schema = any(%s)
  and (
    %s::jsonb is null
    or exists (
      select 1
      from jsonb_to_recordset(%s::jsonb) as scope(catalog text, db text, name text)
      where (scope.catalog is null or scope.catalog = current_database())
        and (scope.db is null or scope.db = source_constraint.table_schema)
        and scope.name = source_constraint.table_name
    )
  )
order by source_constraint.table_schema, source_constraint.table_name, source_constraint.constraint_name, source_key.ordinal_position
"""


class LiveDatabaseColumn(BaseModel):
    name: str
    type: str
    nullable: bool = True
    primary_key: bool = False
    comment: str | None = None


class LiveDatabaseForeignKey(BaseModel):
    from_column: str
    to_table: str
    to_column: str
    constraint_name: str | None = None


class LiveDatabaseTable(BaseModel):
    catalog: str | None = None
    db: str | None = None
    name: str
    comment: str | None = None
    columns: list[LiveDatabaseColumn] = Field(default_factory=list)
    foreign_keys: list[LiveDatabaseForeignKey] = Field(default_factory=list)


class LiveDatabaseTableScopeRef(BaseModel):
    catalog: str | None = None
    db: str | None = None
    name: str


class DatabaseIntrospectionRequest(BaseModel):
    connection_id: str
    driver: str = "postgres"
    url: str
    schemas: list[str] = Field(default_factory=lambda: ["public"])
    statement_timeout_ms: int = Field(default=30_000, ge=1)
    connection_timeout_seconds: int = Field(default=5, ge=1)
    table_scope: list[LiveDatabaseTableScopeRef] | None = None

    @field_validator("schemas")
    @classmethod
    def _schemas_must_not_be_empty(cls, value: list[str]) -> list[str]:
        if not value:
            raise ValueError("database introspection requires at least one schema")
        return value


# Mirrors the Node KtxScanWarning shape so the daemon cannot emit a code the
# Node adapter (mapDaemonSnapshot) cannot render.
OBJECT_INTROSPECTION_FAILED_CODE = "object_introspection_failed"


class DatabaseIntrospectionWarning(BaseModel):
    code: str
    message: str
    table: str | None = None
    column: str | None = None
    recoverable: bool = True
    metadata: dict[str, Any] | None = None


class DatabaseIntrospectionResponse(BaseModel):
    connection_id: str
    extracted_at: str
    metadata: dict[str, Any]
    tables: list[LiveDatabaseTable]
    warnings: list[DatabaseIntrospectionWarning] = Field(default_factory=list)


@dataclass(frozen=True)
class DatabaseIntrospectionRows:
    table_rows: Sequence[Mapping[str, Any]]
    column_rows: Sequence[Mapping[str, Any]]
    foreign_key_rows: Sequence[Mapping[str, Any]]


DatabaseRowsLoader = Callable[[DatabaseIntrospectionRequest], DatabaseIntrospectionRows]
NowProvider = Callable[[], str]


def _driver_name(driver: str) -> str:
    return driver.strip().lower()


def _table_key(catalog: str | None, db: str | None, name: str) -> str:
    return f"{catalog or ''}\u0000{db or ''}\u0000{name}"


def _optional_string(row: Mapping[str, Any], key: str) -> str | None:
    value = row.get(key)
    return value if isinstance(value, str) else None


def _required_string(row: Mapping[str, Any], key: str) -> str:
    value = row.get(key)
    if not isinstance(value, str) or not value:
        raise ValueError(f"database introspection row is missing string field {key}")
    return value


def _statement_timeout_config(statement_timeout_ms: int) -> tuple[str, tuple[str]]:
    return (
        "SELECT set_config('statement_timeout', %s, true)",
        (f"{int(statement_timeout_ms)}ms",),
    )


def _table_scope_json(
    table_scope: Sequence[LiveDatabaseTableScopeRef] | None,
) -> str | None:
    if table_scope is None:
        return None
    return json.dumps(
        [
            {
                "catalog": ref.catalog,
                "db": ref.db,
                "name": ref.name,
            }
            for ref in table_scope
        ]
    )


def _load_postgres_rows(
    request: DatabaseIntrospectionRequest,
) -> DatabaseIntrospectionRows:
    try:
        import psycopg
        from psycopg.rows import dict_row
    except ImportError as error:
        raise RuntimeError(
            "psycopg is required for Postgres database introspection"
        ) from error

    connection = psycopg.connect(
        request.url,
        connect_timeout=request.connection_timeout_seconds,
        application_name="ktx-daemon-database-introspection",
        row_factory=dict_row,
    )
    try:
        connection.execute("BEGIN READ ONLY")
        try:
            connection.execute(*_statement_timeout_config(request.statement_timeout_ms))
            scope_json = _table_scope_json(request.table_scope)
            params = (request.schemas, scope_json, scope_json)
            table_rows = list(connection.execute(TABLES_SQL, params))
            column_rows = list(connection.execute(COLUMNS_SQL, params))
            foreign_key_rows = list(connection.execute(FOREIGN_KEYS_SQL, params))
            connection.execute("COMMIT")
        except Exception:
            connection.execute("ROLLBACK")
            raise
    finally:
        connection.close()

    return DatabaseIntrospectionRows(
        table_rows=table_rows,
        column_rows=column_rows,
        foreign_key_rows=foreign_key_rows,
    )


def _object_introspection_warning(
    row: Mapping[str, Any], error: ValueError
) -> DatabaseIntrospectionWarning:
    name = _optional_string(row, "table_name")
    label = ".".join(
        part
        for part in (
            _optional_string(row, "table_catalog"),
            _optional_string(row, "table_schema"),
            name,
        )
        if part
    )
    column = _optional_string(row, "column_name") or _optional_string(
        row, "from_column"
    )
    return DatabaseIntrospectionWarning(
        code=OBJECT_INTROSPECTION_FAILED_CODE,
        message=str(error),
        table=name,
        column=column,
        recoverable=True,
        metadata={"object": label or "object"},
    )


def _map_rows_to_tables(
    rows: DatabaseIntrospectionRows,
) -> tuple[list[LiveDatabaseTable], list[DatabaseIntrospectionWarning]]:
    tables: dict[str, LiveDatabaseTable] = {}
    warnings: list[DatabaseIntrospectionWarning] = []

    for row in rows.table_rows:
        # One malformed/inaccessible object is skipped with a warning rather than
        # aborting introspection of every healthy object.
        try:
            catalog = _optional_string(row, "table_catalog")
            db = _required_string(row, "table_schema")
            name = _required_string(row, "table_name")
        except ValueError as error:
            warnings.append(_object_introspection_warning(row, error))
            continue
        key = _table_key(catalog, db, name)
        tables[key] = LiveDatabaseTable(
            catalog=catalog,
            db=db,
            name=name,
            comment=_optional_string(row, "table_comment"),
        )

    for row in rows.column_rows:
        try:
            catalog = _optional_string(row, "table_catalog")
            db = _required_string(row, "table_schema")
            table_name = _required_string(row, "table_name")
            table = tables.get(_table_key(catalog, db, table_name))
            if table is None:
                continue
            table.columns.append(
                LiveDatabaseColumn(
                    name=_required_string(row, "column_name"),
                    type=_required_string(row, "formatted_type"),
                    nullable=bool(row.get("is_nullable")),
                    primary_key=bool(row.get("is_primary_key")),
                    comment=_optional_string(row, "column_comment"),
                )
            )
        except ValueError as error:
            warnings.append(_object_introspection_warning(row, error))
            continue

    for row in rows.foreign_key_rows:
        try:
            catalog = _optional_string(row, "table_catalog")
            db = _required_string(row, "table_schema")
            table_name = _required_string(row, "table_name")
            table = tables.get(_table_key(catalog, db, table_name))
            if table is None:
                continue
            table.foreign_keys.append(
                LiveDatabaseForeignKey(
                    from_column=_required_string(row, "from_column"),
                    to_table=_required_string(row, "to_table"),
                    to_column=_required_string(row, "to_column"),
                    constraint_name=_optional_string(row, "constraint_name"),
                )
            )
        except ValueError as error:
            warnings.append(_object_introspection_warning(row, error))
            continue

    sorted_tables = sorted(
        tables.values(),
        key=lambda table: _table_key(table.catalog, table.db, table.name),
    )
    return sorted_tables, warnings


def introspect_database_response(
    request: DatabaseIntrospectionRequest,
    *,
    load_rows: DatabaseRowsLoader | None = None,
    now: NowProvider | None = None,
) -> DatabaseIntrospectionResponse:
    driver = _driver_name(request.driver)
    if driver != "postgres":
        raise ValueError('database introspection supports only driver "postgres"')

    rows = (load_rows or _load_postgres_rows)(request)
    timestamp = now() if now else datetime.now(timezone.utc).isoformat()
    tables, warnings = _map_rows_to_tables(rows)
    return DatabaseIntrospectionResponse(
        connection_id=request.connection_id,
        extracted_at=timestamp,
        metadata={"driver": driver, "schemas": list(request.schemas)},
        tables=tables,
        warnings=warnings,
    )
