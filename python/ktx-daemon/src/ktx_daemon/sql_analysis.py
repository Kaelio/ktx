from __future__ import annotations

import os
from concurrent.futures import ProcessPoolExecutor
from dataclasses import dataclass
from typing import Literal

import sqlglot
from pydantic import BaseModel, Field
from sqlglot import exp
from sqlglot.optimizer.normalize_identifiers import normalize_identifiers
from sqlglot.optimizer.qualify_tables import qualify_tables

SqlAnalysisClause = Literal["select", "where", "join", "groupBy", "having", "orderBy"]


class SqlAnalysisTableRef(BaseModel):
    catalog: str | None = None
    db: str | None = None
    name: str


class SqlAnalysisCatalogTable(SqlAnalysisTableRef):
    columns: list[str] = Field(default_factory=list)


class AnalyzeSqlCatalog(BaseModel):
    tables: list[SqlAnalysisCatalogTable] = Field(default_factory=list)


class AnalyzeSqlBatchItem(BaseModel):
    id: str
    sql: str


class AnalyzeSqlBatchRequest(BaseModel):
    dialect: str
    items: list[AnalyzeSqlBatchItem]
    catalog: AnalyzeSqlCatalog | None = None
    max_workers: int | None = Field(default=None, ge=1, le=32)


class AnalyzeSqlBatchResult(BaseModel):
    tables_touched: list[SqlAnalysisTableRef] = Field(default_factory=list)
    columns_by_clause: dict[SqlAnalysisClause, list[str]] = Field(default_factory=dict)
    error: str | None = None


class AnalyzeSqlBatchResponse(BaseModel):
    results: dict[str, AnalyzeSqlBatchResult]


class ValidateReadOnlySqlRequest(BaseModel):
    dialect: str
    sql: str


class ValidateReadOnlySqlResponse(BaseModel):
    ok: bool
    error: str | None = None


_READ_ONLY_ROOT_TYPES = (exp.Select, exp.Union)
_READ_WRITE_NODE_TYPES = (
    exp.Alter,
    exp.Analyze,
    exp.Cache,
    exp.Command,
    exp.Commit,
    exp.Copy,
    exp.Create,
    exp.Delete,
    exp.Describe,
    exp.Drop,
    exp.Execute,
    exp.Grant,
    exp.Insert,
    exp.Merge,
    exp.Pragma,
    exp.Refresh,
    exp.Revoke,
    exp.Rollback,
    exp.Set,
    exp.Show,
    exp.Transaction,
    exp.TruncateTable,
    exp.Uncache,
    exp.Update,
    exp.Use,
)


# sqlglot has no "hologres" dialect; Hologres is Postgres wire/SQL compatible,
# so parse and normalize it as postgres.
_SQLGLOT_DIALECT_ALIASES = {"hologres": "postgres"}


def _sqlglot_dialect(dialect: str) -> str:
    return _SQLGLOT_DIALECT_ALIASES.get(dialect.strip().lower(), dialect)


def _ordered_unique(values: list[str]) -> list[str]:
    seen: set[str] = set()
    result: list[str] = []
    for value in values:
        if value and value not in seen:
            seen.add(value)
            result.append(value)
    return result


def _normalize_identifier(value: str | None, dialect: str) -> str | None:
    if value is None:
        return None
    identifier = exp.to_identifier(value)
    identifier.meta["is_table"] = True
    normalized = normalize_identifiers(identifier, dialect=dialect)
    return str(normalized.name)


def _normalized_ref(ref: SqlAnalysisTableRef, dialect: str) -> SqlAnalysisTableRef:
    return SqlAnalysisTableRef(
        catalog=_normalize_identifier(ref.catalog, dialect),
        db=_normalize_identifier(ref.db, dialect),
        name=_normalize_identifier(ref.name, dialect) or ref.name,
    )


@dataclass(frozen=True)
class _CatalogIndex:
    by_full: dict[tuple[str | None, str | None, str], SqlAnalysisTableRef]
    by_name: dict[str, list[SqlAnalysisTableRef]]


def _catalog_index(
    catalog: AnalyzeSqlCatalog | None, dialect: str
) -> _CatalogIndex | None:
    if catalog is None or not catalog.tables:
        return None
    by_full: dict[tuple[str | None, str | None, str], SqlAnalysisTableRef] = {}
    by_name: dict[str, list[SqlAnalysisTableRef]] = {}
    for table in catalog.tables:
        ref = _normalized_ref(table, dialect)
        key = (ref.catalog, ref.db, ref.name)
        by_full[key] = ref
        by_name.setdefault(ref.name, []).append(ref)
    return _CatalogIndex(by_full=by_full, by_name=by_name)


def _raw_table_ref(table: exp.Table, dialect: str) -> SqlAnalysisTableRef | None:
    if not table.name:
        return None
    catalog = table.args.get("catalog")
    db = table.args.get("db")
    return _normalized_ref(
        SqlAnalysisTableRef(
            catalog=str(catalog.name)
            if catalog is not None and getattr(catalog, "name", None)
            else None,
            db=str(db.name) if db is not None and getattr(db, "name", None) else None,
            name=str(table.name),
        ),
        dialect,
    )


def _resolve_table_refs(
    raw: SqlAnalysisTableRef,
    catalog: _CatalogIndex | None,
) -> list[SqlAnalysisTableRef]:
    if catalog is None:
        return [raw]
    exact = catalog.by_full.get((raw.catalog, raw.db, raw.name))
    if exact is not None:
        return [exact]
    if raw.db is not None:
        return [raw]
    matches = catalog.by_name.get(raw.name, [])
    if matches:
        return matches
    return [SqlAnalysisTableRef(catalog=None, db=None, name=raw.name)]


def _column_name(column: exp.Column) -> str:
    return str(column.name)


def _columns_from_nodes(nodes: list[object]) -> list[str]:
    names: list[str] = []
    for node in nodes:
        if not isinstance(node, exp.Expression):
            continue
        names.extend(_column_name(column) for column in node.find_all(exp.Column))
    return _ordered_unique(names)


def _columns_by_clause(tree: exp.Expression) -> dict[SqlAnalysisClause, list[str]]:
    result: dict[SqlAnalysisClause, list[str]] = {}

    select_columns = _columns_from_nodes(list(tree.expressions))
    if select_columns:
        result["select"] = select_columns

    where_columns = _columns_from_nodes([tree.args.get("where")])
    if where_columns:
        result["where"] = where_columns

    join_columns = _columns_from_nodes(
        [join.args.get("on") for join in tree.args.get("joins") or []]
    )
    if join_columns:
        result["join"] = join_columns

    group = tree.args.get("group")
    group_columns = _columns_from_nodes(
        list(group.expressions) if group is not None else []
    )
    if group_columns:
        result["groupBy"] = group_columns

    having_columns = _columns_from_nodes([tree.args.get("having")])
    if having_columns:
        result["having"] = having_columns

    order = tree.args.get("order")
    order_columns = _columns_from_nodes(
        list(order.expressions) if order is not None else []
    )
    if order_columns:
        result["orderBy"] = order_columns

    return result


def _table_refs(
    tree: exp.Expression, dialect: str, catalog: _CatalogIndex | None
) -> list[SqlAnalysisTableRef]:
    normalized_tree = normalize_identifiers(tree, dialect=dialect)
    qualified_tree = qualify_tables(normalized_tree, dialect=dialect)
    cte_names = {cte.alias_or_name.lower() for cte in qualified_tree.find_all(exp.CTE)}
    refs: list[SqlAnalysisTableRef] = []
    seen: set[tuple[str | None, str | None, str]] = set()
    for table in qualified_tree.find_all(exp.Table):
        if table.name.lower() in cte_names:
            continue
        raw = _raw_table_ref(table, dialect)
        if raw is None:
            continue
        for ref in _resolve_table_refs(raw, catalog):
            key = (ref.catalog, ref.db, ref.name)
            if key not in seen:
                seen.add(key)
                refs.append(ref)
    return refs


def _analyze_one(
    item_id: str, sql: str, dialect: str, catalog: _CatalogIndex | None
) -> tuple[str, AnalyzeSqlBatchResult]:
    try:
        tree = sqlglot.parse_one(sql, read=dialect)
    except sqlglot.errors.SqlglotError as exc:
        return item_id, AnalyzeSqlBatchResult(error=str(exc))

    return item_id, AnalyzeSqlBatchResult(
        tables_touched=_table_refs(tree, dialect, catalog),
        columns_by_clause=_columns_by_clause(tree),
        error=None,
    )


def _analyze_payload(
    payload: tuple[str, str, str, _CatalogIndex | None],
) -> tuple[str, AnalyzeSqlBatchResult]:
    item_id, sql, dialect, catalog = payload
    return _analyze_one(item_id, sql, dialect, catalog)


def validate_read_only_sql_response(
    request: ValidateReadOnlySqlRequest,
) -> ValidateReadOnlySqlResponse:
    try:
        statements = sqlglot.parse(request.sql, read=_sqlglot_dialect(request.dialect))
    except sqlglot.errors.SqlglotError as exc:
        return ValidateReadOnlySqlResponse(ok=False, error=f"Invalid expression: {exc}")

    if len(statements) != 1:
        return ValidateReadOnlySqlResponse(
            ok=False,
            error="Only one SQL statement can be executed.",
        )

    tree = statements[0]
    if tree is None:
        return ValidateReadOnlySqlResponse(
            ok=False,
            error="SQL did not parse to a statement.",
        )
    if not isinstance(tree, _READ_ONLY_ROOT_TYPES):
        return ValidateReadOnlySqlResponse(
            ok=False,
            error=f"SQL contains read/write operation: {type(tree).__name__}",
        )

    for node in tree.walk():
        if isinstance(node, _READ_WRITE_NODE_TYPES):
            return ValidateReadOnlySqlResponse(
                ok=False,
                error=f"SQL contains read/write operation: {type(node).__name__}",
            )

    return ValidateReadOnlySqlResponse(ok=True, error=None)


def _worker_count(request: AnalyzeSqlBatchRequest) -> int:
    if len(request.items) <= 1:
        return 1
    if request.max_workers is not None:
        return min(request.max_workers, len(request.items))
    return min(os.cpu_count() or 1, len(request.items), 8)


def analyze_sql_batch_response(
    request: AnalyzeSqlBatchRequest,
) -> AnalyzeSqlBatchResponse:
    dialect = _sqlglot_dialect(request.dialect)
    catalog = _catalog_index(request.catalog, dialect)
    payloads = [(item.id, item.sql, dialect, catalog) for item in request.items]
    if _worker_count(request) == 1:
        analyzed = [_analyze_payload(payload) for payload in payloads]
    else:
        with ProcessPoolExecutor(max_workers=_worker_count(request)) as executor:
            analyzed = list(executor.map(_analyze_payload, payloads))

    return AnalyzeSqlBatchResponse(
        results={item_id: result for item_id, result in analyzed}
    )
