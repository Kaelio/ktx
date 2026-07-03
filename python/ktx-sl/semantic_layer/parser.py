from __future__ import annotations

import functools
import re
from dataclasses import dataclass, field

import sqlglot
from sqlglot import exp
from sqlglot.dialects.dialect import Dialect

# DIALECT CONVENTION:
#   `ExpressionParser` wraps read-only AST walks over user-authored
#   expressions. Callers must construct it with the connection's native
#   dialect (per sl_capture). The parse cache is keyed on (sql, dialect)
#   so engines with different dialects do not share AST collisions.

AGGREGATE_FUNCTIONS = frozenset(
    {
        "sum",
        "avg",
        "count",
        "count_distinct",
        "min",
        "max",
        "median",
        "percentile",
    }
)

# Maps sqlglot AggFunc subclasses to our canonical names
_AGG_NODE_MAP: dict[type, str] = {
    exp.Sum: "sum",
    exp.Avg: "avg",
    exp.Count: "count",
    exp.Min: "min",
    exp.Max: "max",
}

# Custom aggregates that sqlglot parses as Anonymous (not standard SQL)
_CUSTOM_AGG_NAMES = frozenset({"count_distinct", "percentile", "median"})

# SQL reserved words that cause parse failures when used as identifiers
_SQL_RESERVED = frozenset(
    {
        "select",
        "from",
        "where",
        "group",
        "order",
        "by",
        "having",
        "limit",
        "join",
        "on",
        "as",
        "and",
        "or",
        "not",
        "in",
        "is",
        "null",
        "true",
        "false",
        "between",
        "like",
        "case",
        "when",
        "then",
        "else",
        "end",
        "insert",
        "update",
        "delete",
        "create",
        "drop",
        "alter",
        "table",
        "index",
        "view",
        "union",
        "all",
        "distinct",
        "into",
        "values",
        "set",
        "with",
        "exists",
        "any",
        "some",
        "offset",
        "fetch",
        "for",
        "grant",
        "revoke",
        "primary",
        "key",
        "foreign",
        "references",
        "check",
        "constraint",
        "default",
        "column",
        "cross",
        "full",
        "inner",
        "left",
        "right",
        "outer",
        "natural",
        "using",
        "except",
        "intersect",
        # Snowflake / cross-dialect reserved words
        "glob",
        "ilike",
        "lateral",
        "match_recognize",
        "notnull",
        "out",
        "qualify",
        "regexp",
        "returning",
        "rlike",
        "rollback",
        "sample",
        "tablesample",
        "top",
        "uncache",
        "xor",
    }
)

# Regex pattern for source.column references (word.word)
_DOTTED_IDENT_RE = re.compile(r"\b(\w+)\.(\w+)\b")

# Matches single-quoted SQL string literals (including escaped quotes '')
_STRING_LITERAL_RE = re.compile(r"'(?:[^']|'')*'")


@dataclass
class ParsedExpression:
    original: str
    source_refs: set[str] = field(default_factory=set)
    column_refs: set[str] = field(default_factory=set)  # "source.column" format
    is_aggregate: bool = False
    aggregate_function: str | None = None
    has_window_function: bool = False
    depends_on_measures: set[str] = field(default_factory=set)


def _strip_quotes(name: str) -> str:
    """Strip surrounding double quotes from an identifier."""
    if name.startswith('"') and name.endswith('"'):
        return name[1:-1]
    return name


@functools.lru_cache(maxsize=32)
def _identifier_quote(dialect: str) -> str:
    """The character `dialect` quotes identifiers with (backtick for BigQuery/MySQL,
    double-quote for ANSI dialects). A reserved-word column must be quoted with this so a
    backtick dialect does not read a double-quoted identifier as a string literal."""
    try:
        start = Dialect.get_or_raise(dialect).IDENTIFIER_START
    except Exception:
        start = '"'
    return start or '"'


def quote_reserved_identifiers(expr: str, dialect: str = "postgres") -> str:
    """Quote source.column references where either part is a SQL reserved word.

    Quoted with `dialect`'s identifier character, because the caller parses the
    result in that dialect: a double-quoted identifier on BigQuery/MySQL is a
    string literal, not an identifier. String literals are masked before
    processing to prevent matching dotted identifiers inside quoted strings like
    'group.value'.
    """
    quote = _identifier_quote(dialect)

    # Mask string literals to avoid matching inside them
    literals: list[str] = []

    def _mask_literal(m: re.Match) -> str:
        literals.append(m.group(0))
        return f"__SL_LIT_{len(literals) - 1}__"

    masked = _STRING_LITERAL_RE.sub(_mask_literal, expr)

    def _quote_match(m: re.Match) -> str:
        source, col = m.group(1), m.group(2)
        start = m.start()
        if start > 0 and masked[start - 1] == quote:
            return m.group(0)
        needs_quote = False
        source_q = source
        col_q = col
        if source.lower() in _SQL_RESERVED:
            source_q = f"{quote}{source}{quote}"
            needs_quote = True
        if col.lower() in _SQL_RESERVED:
            col_q = f"{quote}{col}{quote}"
            needs_quote = True
        if needs_quote:
            return f"{source_q}.{col_q}"
        return m.group(0)

    result = _DOTTED_IDENT_RE.sub(_quote_match, masked)

    # Restore string literals
    for i, lit in enumerate(literals):
        result = result.replace(f"__SL_LIT_{i}__", lit)

    return result


def _predicate_select(expr: str, dialect: str = "postgres") -> str:
    """Wrap a user expression as `SELECT * WHERE …`, quoting reserved identifiers.

    Predicate, not projection: T-SQL reads a top-level `col = 'value'` projection
    as the `alias = expression` form and would compile the filter to `'value' AS col`.
    """
    return f"SELECT * WHERE {quote_reserved_identifiers(expr, dialect)}"


@functools.lru_cache(maxsize=256)
def _cached_parse_select(sql: str, dialect: str) -> exp.Expression:
    """Cache parsed SELECT wrapper trees keyed by (sql, dialect).

    Each (sql, dialect) pair gets its own entry, so engines using different
    dialects don't share AST cache collisions.
    """
    return sqlglot.parse_one(sql, read=dialect)


def parse_predicate(expr: str, dialect: str) -> exp.Expression:
    """Parse a user filter into a fresh, mutable WHERE-condition node.

    Uncached, so the result is safe to `.transform()`; raises on unparseable input.
    """
    return (
        sqlglot.parse_one(_predicate_select(expr, dialect), read=dialect)
        .find(exp.Where)
        .this
    )


class ExpressionParser:
    """Parses user-authored SQL expressions for AST walks.

    Must be constructed with the connection's native dialect. User-authored
    `expr:`, `filter:`, and segment predicates from YAML are written in that
    dialect (per the sl_capture skill contract) and parsing them as postgres
    silently drops dialect-specific tokens (e.g. BigQuery `INTERVAL 30 DAY`).
    """

    def __init__(self, dialect: str = "postgres") -> None:
        self.dialect = dialect

    def _parse_as_select(self, expr: str) -> exp.Expression:
        """Parse a user fragment for read-only AST walks, via the parse cache."""
        return _cached_parse_select(_predicate_select(expr, self.dialect), self.dialect)

    def parse(
        self,
        expr: str,
        known_measure_names: set[str] | None = None,
    ) -> ParsedExpression:
        known_measure_names = known_measure_names or set()
        result = ParsedExpression(original=expr)

        if not expr or not expr.strip():
            return result

        tree = self._parse_as_select(expr)

        # Extract source.column references
        for col in tree.find_all(exp.Column):
            if col.table:
                source_name = _strip_quotes(col.table)
                col_name = _strip_quotes(col.name)
                result.source_refs.add(source_name)
                result.column_refs.add(f"{source_name}.{col_name}")

        # Detect aggregate functions (built-in AggFunc subclasses).
        # Aggregates nested inside scalar/correlated subqueries do NOT make the
        # outer expression aggregate — e.g. `col = (SELECT MAX(col) FROM t)` is a
        # plain column predicate, not a HAVING candidate.
        def _inside_subquery(node: exp.Expression) -> bool:
            parent = node.parent
            while parent is not None:
                if isinstance(parent, exp.Subquery):
                    return True
                parent = parent.parent
            return False

        agg_names: list[str] = []
        for node in tree.find_all(exp.AggFunc):
            if _inside_subquery(node):
                continue
            name = _AGG_NODE_MAP.get(type(node))
            if name:
                agg_names.append(name)
            else:
                agg_names.append(node.key.lower())

        # Detect custom aggregates parsed as Anonymous (count_distinct, percentile, median)
        for node in tree.find_all(exp.Anonymous):
            if _inside_subquery(node):
                continue
            if node.name.lower() in _CUSTOM_AGG_NAMES:
                agg_names.append(node.name.lower())

        if agg_names:
            result.is_aggregate = True
            result.aggregate_function = agg_names[0]

        # Detect window functions (OVER clause)
        if tree.find(exp.Window):
            result.has_window_function = True

        # Detect dependencies on named measures (bare identifiers without table qualifier)
        if known_measure_names:
            for col in tree.find_all(exp.Column):
                if not col.table and col.name in known_measure_names:
                    result.depends_on_measures.add(col.name)

        return result

    def extract_source_refs(self, expr: str) -> set[str]:
        """Quick extraction of source names from an expression."""
        if not expr or not expr.strip():
            return set()
        tree = self._parse_as_select(expr)
        return {
            _strip_quotes(col.table) for col in tree.find_all(exp.Column) if col.table
        }
