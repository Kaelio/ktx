from __future__ import annotations

import logging
from dataclasses import dataclass
from typing import Literal

import sqlglot
from sqlglot import exp

logger = logging.getLogger(__name__)

SUPPORTED_TABLE_IDENTIFIER_DIALECTS = {
    "bigquery",
    "snowflake",
    "postgres",
    "redshift",
    "mysql",
    "sqlite",
    "tsql",
    "clickhouse",
    "athena",
    "duckdb",
}

ParseTableIdentifierReason = Literal[
    "looker_template_unresolved",
    "derived_table_not_supported",
    "no_physical_table",
    "multiple_table_references",
    "unsupported_dialect",
    "parse_error",
]


@dataclass(frozen=True)
class ParseTableIdentifierItem:
    key: str
    sql_table_name: str
    dialect: str


@dataclass(frozen=True)
class ParsedIdentifier:
    ok: bool
    catalog: str | None = None
    schema_: str | None = None
    name: str | None = None
    canonical_table: str | None = None
    reason: ParseTableIdentifierReason | None = None
    detail: str | None = None


def parse_table_identifier_batch(
    items: list[ParseTableIdentifierItem],
) -> dict[str, ParsedIdentifier]:
    return {
        item.key: parse_table_identifier_one(item.sql_table_name, item.dialect)
        for item in items
    }


def parse_table_identifier_one(sql_table_name: str, dialect: str) -> ParsedIdentifier:
    normalized_dialect = dialect.lower()
    if normalized_dialect not in SUPPORTED_TABLE_IDENTIFIER_DIALECTS:
        return ParsedIdentifier(
            ok=False,
            reason="unsupported_dialect",
            detail=f"Unsupported sqlglot dialect for table identifier parsing: {dialect}",
        )

    if "${" in sql_table_name or "@{" in sql_table_name:
        return ParsedIdentifier(ok=False, reason="looker_template_unresolved")

    try:
        parsed = sqlglot.parse_one(
            f"SELECT * FROM {sql_table_name}",
            read=normalized_dialect,
        )
        from_clause = parsed.args.get("from_")
        if from_clause is None or from_clause.this is None:
            return ParsedIdentifier(ok=False, reason="no_physical_table")

        from_expr = from_clause.this
        if isinstance(from_expr, (exp.Subquery, exp.Values, exp.Lateral)):
            return ParsedIdentifier(ok=False, reason="derived_table_not_supported")
        if not isinstance(from_expr, exp.Table):
            return ParsedIdentifier(ok=False, reason="derived_table_not_supported")

        tables = list(parsed.find_all(exp.Table))
        if not tables:
            return ParsedIdentifier(ok=False, reason="no_physical_table")
        if len(tables) > 1:
            return ParsedIdentifier(ok=False, reason="multiple_table_references")

        table = tables[0]
        canonical_table = exp.Table(
            this=exp.to_identifier(table.name),
            db=exp.to_identifier(table.db) if table.db else None,
            catalog=exp.to_identifier(table.catalog) if table.catalog else None,
        ).sql(dialect=normalized_dialect)

        return ParsedIdentifier(
            ok=True,
            catalog=table.catalog or None,
            schema_=table.db or None,
            name=table.name,
            canonical_table=canonical_table,
        )
    except sqlglot.errors.ParseError as exc:
        return ParsedIdentifier(ok=False, reason="parse_error", detail=str(exc))
    except Exception as exc:
        logger.exception("Unexpected failure while parsing Looker sql_table_name")
        return ParsedIdentifier(ok=False, reason="parse_error", detail=str(exc))
