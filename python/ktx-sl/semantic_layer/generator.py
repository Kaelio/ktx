from __future__ import annotations

import logging
from collections import Counter

import sqlglot
from sqlglot import exp

from semantic_layer.graph import RELATIONSHIP_INVERSE
from semantic_layer.models import (
    MeasureGroup,
    QueryDimension,
    ResolvedJoin,
    ResolvedMeasure,
    ResolvedPlan,
    SourceDefinition,
)
from semantic_layer.parser import (
    ExpressionParser,
    parse_predicate,
    quote_reserved_identifiers,
)

# DIALECT CONVENTION:
#   User-authored SQL fragments (measure `expr`, segment `expr`, filter,
#   computed-column `expr`, `sql:` source bodies, join `on:` clauses) must
#   be parsed with `read=self.dialect`. The `sl_capture` skill instructs
#   authors to write in the connection's native dialect; parsing as postgres
#   silently drops dialect-specific tokens (e.g. BigQuery `INTERVAL 30 DAY`).
#   Source CTE bodies stay verbatim; the outer scaffold is written in
#   postgres-compatible form with dialect-specific helpers where needed
#   (see `_time_trunc`), and `_transpile()` round-trips it through
#   `self.dialect` so embedded user exprs survive intact.

logger = logging.getLogger(__name__)


def _qi(name: str) -> str:
    """Quote an identifier if it is a SQL reserved word."""
    from semantic_layer.parser import _SQL_RESERVED

    if name.lower() in _SQL_RESERVED:
        return f'"{name}"'
    return name


def _build_on_clause(
    from_source: str, from_column: str, to_source: str, to_column: str
) -> str:
    """Build ON clause supporting composite keys (comma-separated columns)."""
    from_cols = [c.strip() for c in from_column.split(",")]
    to_cols = [c.strip() for c in to_column.split(",")]
    conditions = [
        f"{_qi(from_source)}.{_qi(fc)} = {_qi(to_source)}.{_qi(tc)}"
        for fc, tc in zip(from_cols, to_cols)
    ]
    return " AND ".join(conditions)


class SqlGenerator:
    def __init__(
        self, dialect: str = "postgres", alias_map: dict[str, str] | None = None
    ):
        if dialect != "postgres":
            from sqlglot import Dialect

            try:
                Dialect.get_or_raise(dialect)
            except ValueError:
                raise ValueError(
                    f"Unknown SQL dialect '{dialect}'. Use a dialect supported by sqlglot "
                    f"(e.g., postgres, bigquery, snowflake, mysql, duckdb)."
                )
        self.dialect = dialect
        self._parser = ExpressionParser(dialect=dialect)
        self._alias_map: dict[str, str] = alias_map or {}

    def generate(self, plan: ResolvedPlan, sources: dict[str, SourceDefinition]) -> str:
        native_source_ctes = self._build_source_ctes(plan, sources)
        if plan.has_fan_out and plan.measure_groups:
            outer_sql = self._generate_with_locality(plan, sources)
        else:
            outer_sql = self._generate_simple(plan, sources)

        outer_transpiled = self._transpile(outer_sql)

        if not native_source_ctes:
            return outer_transpiled

        source_header = ",\n".join(native_source_ctes)
        stripped = outer_transpiled.lstrip()
        if stripped[:5].upper() == "WITH ":
            # Outer scaffold already has a WITH clause (e.g. locality CTEs).
            # Merge the native source CTEs into the same WITH clause.
            rest = stripped[5:].lstrip()
            return "WITH " + source_header + ",\n" + rest
        return "WITH " + source_header + "\n" + outer_transpiled

    # ── Path A: Simple (no fanout) ────────────────────────────────────

    def _generate_simple(
        self, plan: ResolvedPlan, sources: dict[str, SourceDefinition]
    ) -> str:
        parts: list[str] = []

        # SELECT — use DISTINCT when no measures (dimension-only query)
        has_measures = any(not m.is_derived for m in plan.measures)
        select_cols = self._build_select_columns(plan, sources)
        if not has_measures and plan.dimensions:
            parts.append("SELECT DISTINCT\n  " + ",\n  ".join(select_cols))
        else:
            parts.append("SELECT\n  " + ",\n  ".join(select_cols))

        # FROM
        anchor = plan.anchor_source
        if anchor:
            from_ref = self._source_ref(anchor, sources)
            parts.append(f"FROM {from_ref}")

        # JOINs
        for join in plan.joins:
            join_sql = self._build_join(join, sources, plan)
            parts.append(join_sql)

        # WHERE
        if plan.where_filters:
            where_clauses = [
                self._qualify_filter(f, sources, plan) for f in plan.where_filters
            ]
            parts.append("WHERE " + " AND ".join(where_clauses))

        # GROUP BY (skip for dimension-only queries — DISTINCT handles dedup)
        dim_exprs = self._build_group_by_exprs(plan, sources)
        if dim_exprs and has_measures:
            parts.append("GROUP BY " + ", ".join(dim_exprs))

        # HAVING — expand predefined measure references to aggregate expressions
        if plan.having_filters:
            having_clauses = [
                self._expand_having_filter(f, plan, sources)
                for f in plan.having_filters
            ]
            parts.append("HAVING " + " AND ".join(having_clauses))

        # ORDER BY
        if plan.order_by:
            order_parts = []
            for ob in plan.order_by:
                field = self._resolve_order_field(ob.field, plan)
                direction = (
                    ob.direction.upper() if ob.direction.lower() != "asc" else ""
                )
                order_parts.append(f"{field} {direction}".strip())
            parts.append("ORDER BY " + ", ".join(order_parts))
        elif dim_exprs:
            parts.append(
                "ORDER BY " + ", ".join(str(i) for i in range(1, len(dim_exprs) + 1))
            )

        # LIMIT
        if plan.limit is not None:
            parts.append(f"LIMIT {plan.limit}")

        return "\n".join(parts)

    # ── Path B: Aggregate locality ─────────────────────────────────────

    def _generate_with_locality(
        self, plan: ResolvedPlan, sources: dict[str, SourceDefinition]
    ) -> str:
        parts: list[str] = []
        # Only locality CTEs — source CTEs are concatenated by generate() so
        # the native-dialect source body never reaches the postgres transpile.
        cte_parts: list[str] = []

        # All dimension key expressions
        all_dim_keys = self._build_dim_key_exprs(plan, sources)

        # Compute per-CTE reachable dimensions
        safe_adj = self._build_safe_adjacency(plan)
        per_cte_dims: dict[str, list[dict]] = {}
        for group in plan.measure_groups:
            reachable = []
            for dk in all_dim_keys:
                dim_sources = self._parser.extract_source_refs(dk["expr"])
                can_reach = True
                for ds in dim_sources:
                    if ds == group.source_name:
                        continue
                    path = self._find_join_path_steps(group.source_name, ds, safe_adj)
                    if not path and ds != group.source_name:
                        can_reach = False
                        break
                if can_reach:
                    reachable.append(dk)
            per_cte_dims[group.source_name] = reachable

        # Validate: every dimension must be reachable from at least one CTE
        for dk in all_dim_keys:
            reachable_from_any = any(
                any(d["alias"] == dk["alias"] for d in per_cte_dims[g.source_name])
                for g in plan.measure_groups
            )
            if not reachable_from_any:
                dim_sources = self._parser.extract_source_refs(dk["expr"])
                source_names = [g.source_name for g in plan.measure_groups]
                raise ValueError(
                    f"Aggregate locality cannot safely reach '{', '.join(dim_sources)}' from "
                    f"any measure source ({', '.join(source_names)}) without traversing one_to_many edges"
                )

        # Shared dimensions: reachable from ALL CTEs (used for JOIN condition)
        shared_dim_aliases = None
        for group in plan.measure_groups:
            aliases = {dk["alias"] for dk in per_cte_dims[group.source_name]}
            if shared_dim_aliases is None:
                shared_dim_aliases = aliases
            else:
                shared_dim_aliases &= aliases
        shared_dim_aliases = shared_dim_aliases or set()
        shared_dims = [dk for dk in all_dim_keys if dk["alias"] in shared_dim_aliases]

        # Validate grain consistency: asymmetric dims cause FULL JOIN fanout
        if len(plan.measure_groups) > 1:
            for group in plan.measure_groups:
                cte_dim_aliases = {
                    dk["alias"] for dk in per_cte_dims[group.source_name]
                }
                non_shared = cte_dim_aliases - shared_dim_aliases
                if non_shared:
                    for other_group in plan.measure_groups:
                        if other_group.source_name == group.source_name:
                            continue
                        other_aliases = {
                            dk["alias"] for dk in per_cte_dims[other_group.source_name]
                        }
                        missing_from_other = non_shared - other_aliases
                        if missing_from_other:
                            raise ValueError(
                                f"Asymmetric dimension grain in chasm trap: "
                                f"'{group.source_name}' groups by {sorted(cte_dim_aliases)} "
                                f"but '{other_group.source_name}' cannot reach "
                                f"{sorted(missing_from_other)}. "
                                f"FULL JOIN on shared dimensions ({sorted(shared_dim_aliases)}) "
                                f"would fan out '{other_group.source_name}' measures across "
                                f"the extra dimensions, producing incorrect results. "
                                f"Remove the asymmetric dimensions or query each measure "
                                f"source separately."
                            )

        # Collect all names that could collide with CTE aliases
        reserved_names: set[str] = set(sources.keys())
        for name in plan.sources_used:
            src = sources.get(name)
            if src and src.is_sql_source:
                reserved_names.add(name)
        assigned_aliases: set[str] = set()

        # Pre-aggregation CTEs for each measure group
        cte_aliases: list[str] = []
        for group in plan.measure_groups:
            alias = f"{group.source_name}_agg"
            # Resolve collisions with existing source/CTE names
            if alias in reserved_names or alias in assigned_aliases:
                suffix = 1
                while (
                    f"{group.source_name}_agg_{suffix}" in reserved_names
                    or f"{group.source_name}_agg_{suffix}" in assigned_aliases
                ):
                    suffix += 1
                alias = f"{group.source_name}_agg_{suffix}"
            cte_aliases.append(alias)
            assigned_aliases.add(alias)
            cte_dim_keys = per_cte_dims[group.source_name]
            cte_sql = self._build_agg_cte(group, plan, sources, cte_dim_keys)
            cte_parts.append(f"{alias} AS (\n{cte_sql}\n)")

        if cte_parts:
            parts.append("WITH " + ",\n".join(cte_parts))

        # Final SELECT combining CTEs
        select_cols, derived_inline_map = self._build_locality_select(
            plan, cte_aliases, all_dim_keys, per_cte_dims
        )
        parts.append("SELECT\n  " + ",\n  ".join(select_cols))

        # FROM + JOINs between CTEs
        cte_join_type = "FULL JOIN" if plan.include_empty else "JOIN"
        if cte_aliases:
            parts.append(f"FROM {cte_aliases[0]}")
            for i, alias in enumerate(cte_aliases[1:], 1):
                join_conditions = []
                for dk in shared_dims:
                    if i == 1:
                        lhs = f"{cte_aliases[0]}.{dk['alias']}"
                    else:
                        coalesce_args = ", ".join(
                            f"{cte_aliases[j]}.{dk['alias']}" for j in range(i)
                        )
                        lhs = f"COALESCE({coalesce_args})"
                    join_conditions.append(f"{lhs} = {alias}.{dk['alias']}")
                if join_conditions:
                    parts.append(
                        f"{cte_join_type} {alias} ON " + " AND ".join(join_conditions)
                    )
                else:
                    parts.append(f"CROSS JOIN {alias}")

        # HAVING filters applied as WHERE on outer query (no GROUP BY at this level)
        if plan.having_filters:
            measure_cte_map: dict[str, str] = {}
            for i, plan_group in enumerate(plan.measure_groups):
                for m in plan_group.measures:
                    measure_cte_map[m.name] = cte_aliases[i]

            having_clauses = []
            for f in plan.having_filters:
                resolved_f = self._resolve_having_for_locality(
                    f, plan, measure_cte_map, derived_inline_map
                )
                having_clauses.append(resolved_f)
            parts.append("WHERE " + " AND ".join(having_clauses))

        # ORDER BY
        if plan.order_by:
            order_parts = []
            for ob in plan.order_by:
                field = self._resolve_order_field(ob.field, plan)
                direction = (
                    ob.direction.upper() if ob.direction.lower() != "asc" else ""
                )
                order_parts.append(f"{field} {direction}".strip())
            parts.append("ORDER BY " + ", ".join(order_parts))
        elif all_dim_keys:
            parts.append(
                "ORDER BY " + ", ".join(str(i) for i in range(1, len(all_dim_keys) + 1))
            )

        # LIMIT
        if plan.limit is not None:
            parts.append(f"LIMIT {plan.limit}")

        return "\n".join(parts)

    def _build_agg_cte(
        self,
        group: MeasureGroup,
        plan: ResolvedPlan,
        sources: dict[str, SourceDefinition],
        dim_keys: list[dict],
    ) -> str:
        """Build a pre-aggregation CTE for one measure group."""
        parts: list[str] = []

        # SELECT: dimension keys + aggregated measures
        select_cols: list[str] = []
        for dk in dim_keys:
            select_cols.append(f"{dk['expr']} AS {dk['alias']}")

        for m in group.measures:
            measure_expr = self._build_measure_expr(m, sources)
            select_cols.append(f"{measure_expr} AS {m.name}")

        parts.append("  SELECT\n    " + ",\n    ".join(select_cols))

        # FROM the measure's source
        from_ref = self._source_ref(group.source_name, sources)
        parts.append(f"  FROM {from_ref}")

        joined_sources = {group.source_name}
        target_sources = self._collect_cte_target_sources(group, plan, dim_keys)
        join_steps = self._build_group_join_steps(
            group.source_name, target_sources, plan
        )
        for join, next_source in join_steps:
            if next_source in joined_sources:
                continue
            join_ref = self._source_ref(next_source, sources)
            on_clause = _build_on_clause(
                join.from_source, join.from_column, join.to_source, join.to_column
            )
            parts.append(f"  JOIN {join_ref} ON {on_clause}")
            joined_sources.add(next_source)

        # WHERE filters — only push down filters whose sources are within this CTE
        if plan.where_filters:
            relevant_where = []
            for f in plan.where_filters:
                filter_sources = self._parser.extract_source_refs(f)
                if not filter_sources or filter_sources <= joined_sources:
                    relevant_where.append(f)
            if relevant_where:
                where_clauses = [
                    self._qualify_filter(f, sources, plan) for f in relevant_where
                ]
                parts.append("  WHERE " + " AND ".join(where_clauses))

        # GROUP BY dimension keys
        if dim_keys:
            group_by = ", ".join(dk["expr"] for dk in dim_keys)
            parts.append(f"  GROUP BY {group_by}")

        # HAVING filters are NOT placed here — they go on the outer query
        # after the FULL JOIN to ensure correct semantics across CTEs

        return "\n".join(parts)

    def _build_dim_key_exprs(
        self, plan: ResolvedPlan, sources: dict[str, SourceDefinition]
    ) -> list[dict]:
        """Build dimension key expressions for aggregate locality CTEs."""
        colliding = self._colliding_dim_leaves(plan.dimensions)
        result = []
        for dim in plan.dimensions:
            expr = self._dim_expr(dim, sources)
            result.append(
                {"expr": expr, "alias": self._dimension_alias(dim, colliding)}
            )
        return result

    def _build_locality_select(
        self,
        plan: ResolvedPlan,
        cte_aliases: list[str],
        dim_keys: list[dict],
        per_cte_dims: dict[str, list[dict]] | None = None,
    ) -> list[str]:
        """Build SELECT columns for the final query combining pre-aggregated CTEs."""
        cols: list[str] = []

        # Build mapping from CTE alias to source name
        cte_source_names = [g.source_name for g in plan.measure_groups]

        # Dimensions: COALESCE across CTEs that have the dim
        for dk in dim_keys:
            if per_cte_dims:
                available_ctes = [
                    alias
                    for alias, src_name in zip(cte_aliases, cte_source_names)
                    if any(
                        d["alias"] == dk["alias"]
                        for d in per_cte_dims.get(src_name, [])
                    )
                ]
            else:
                available_ctes = cte_aliases

            if len(available_ctes) > 1:
                coalesce_args = ", ".join(f"{a}.{dk['alias']}" for a in available_ctes)
                cols.append(f"COALESCE({coalesce_args}) AS {dk['alias']}")
            elif len(available_ctes) == 1:
                cols.append(f"{available_ctes[0]}.{dk['alias']} AS {dk['alias']}")
            else:
                cols.append(f"NULL AS {dk['alias']}")

        # Non-derived measures from CTEs
        measure_cte_map: dict[str, str] = {}
        for i, plan_group in enumerate(plan.measure_groups):
            alias = cte_aliases[i]
            for m in plan_group.measures:
                cols.append(f"{alias}.{m.name}")
                measure_cte_map[m.name] = alias

        # Derived measures — wrap cross-CTE refs in COALESCE for FULL JOIN NULL safety.
        # Process in order (topological) so that derived-of-derived gets inlined.
        derived_inline_map: dict[str, str] = {}  # measure_name → fully inlined expr
        for m in plan.measures:
            if m.is_derived:
                # Collect all transitive CTE aliases used by this derived measure
                dep_ctes: set[str | None] = set()
                for d in m.depends_on:
                    if d in measure_cte_map:
                        dep_ctes.add(measure_cte_map.get(d))
                    elif d in derived_inline_map:
                        # Derived dep — inherit its CTE references
                        # (cross-CTE if the inlined dep already has multiple CTEs)
                        dep_ctes.add("__derived__")
                use_coalesce = len(dep_ctes - {None}) > 1
                # Detect which deps are used as divisors
                divisor_deps = self._find_divisor_deps(m.expr, m.depends_on)
                replacements = {}
                for dep_name in m.depends_on:
                    if dep_name in measure_cte_map:
                        ref = f"{measure_cte_map[dep_name]}.{dep_name}"
                        if use_coalesce:
                            if dep_name in divisor_deps:
                                ref = f"NULLIF(COALESCE({measure_cte_map[dep_name]}.{dep_name}, 0), 0)"
                            else:
                                ref = f"COALESCE({ref}, 0)"
                        replacements[dep_name] = ref
                    elif dep_name in derived_inline_map:
                        # Derived dependency — inline its already-resolved expression
                        ref = derived_inline_map[dep_name]
                        if dep_name in divisor_deps:
                            ref = f"NULLIF({ref}, 0)"
                        replacements[dep_name] = ref
                expr = self._substitute_measure_refs(m.expr, replacements)
                derived_inline_map[m.name] = expr
                cols.append(f"{expr} AS {m.name}")

        return cols, derived_inline_map

    def _find_divisor_deps(self, expr: str, depends_on: list[str]) -> set[str]:
        """Find which dependency names appear as divisors in the expression."""
        divisors: set[str] = set()
        try:
            tree = sqlglot.parse_one(f"SELECT {expr}", read=self.dialect)
            for div_node in tree.find_all(exp.Div):
                rhs = div_node.right
                if isinstance(rhs, exp.Column) and not rhs.table:
                    if rhs.name in depends_on:
                        divisors.add(rhs.name)
        except Exception:
            logger.debug("Failed to parse expression for divisor detection: %s", expr)
        return divisors

    # ── Shared helpers ─────────────────────────────────────────────────

    def _build_source_ctes(
        self, plan: ResolvedPlan, sources: dict[str, SourceDefinition]
    ) -> list[str]:
        """Build CTEs for SQL-based sources, flattening inner WITH clauses."""
        ctes = []
        for name in plan.sources_used:
            src = sources.get(name)
            if src and src.is_sql_source and src.sql:
                sql_text = src.sql.strip()
                inner_ctes, final_select = self._extract_inner_ctes(sql_text)
                if inner_ctes:
                    # Promote inner CTEs with prefixed names
                    renames: list[tuple[str, str]] = []
                    for inner_name, inner_body in inner_ctes:
                        prefixed = f"{name}__{inner_name}"
                        renames.append((inner_name, prefixed))

                    # Apply all renames to inner CTE bodies and final SELECT
                    promoted: list[tuple[str, str]] = []
                    for inner_name, inner_body in inner_ctes:
                        renamed_body = inner_body
                        for old, new in renames:
                            renamed_body = self._rename_table_ref(
                                renamed_body, old, new
                            )
                        prefixed = f"{name}__{inner_name}"
                        promoted.append((prefixed, renamed_body))

                    renamed_final = final_select
                    for old, new in renames:
                        renamed_final = self._rename_table_ref(renamed_final, old, new)

                    for prefixed, body in promoted:
                        ctes.append(f"{prefixed} AS (\n{body}\n)")
                    ctes.append(f"{name} AS (\n{renamed_final}\n)")
                else:
                    ctes.append(f"{name} AS (\n{sql_text}\n)")
        return ctes

    def _extract_inner_ctes(self, sql_text: str) -> tuple[list[tuple[str, str]], str]:
        """Parse SQL and extract CTEs if present.

        Source SQL is user-provided in the target dialect, so we parse and
        serialize using ``self.dialect`` to avoid lossy cross-dialect
        conversion (e.g. Snowflake DATEDIFF → postgres AGE).
        """
        try:
            tree = sqlglot.parse_one(sql_text, read=self.dialect)
            with_clause = tree.find(exp.With)
            if not with_clause:
                return [], sql_text
            cte_list = []
            for cte in with_clause.expressions:
                cte_name = cte.alias
                cte_body = cte.this.sql(dialect=self.dialect)
                cte_list.append((cte_name, cte_body))
            # Get the main query without the WITH clause
            tree_copy = tree.copy()
            w = tree_copy.find(exp.With)
            if w:
                w.pop()
            final_select = tree_copy.sql(dialect=self.dialect)
            return cte_list, final_select
        except Exception:
            logger.debug(
                "Failed to extract inner CTEs from SQL source, treating as raw SQL"
            )
            return [], sql_text

    def _rename_table_ref(self, sql_text: str, old_name: str, new_name: str) -> str:
        """Rename table references in SQL text.

        Uses ``self.dialect`` for parsing/serialization to preserve
        dialect-specific constructs in user-provided source SQL.
        """
        try:
            tree = sqlglot.parse_one(sql_text, read=self.dialect)

            def _rename(node):
                if (
                    isinstance(node, exp.Table)
                    and node.name == old_name
                    and not node.db
                ):
                    alias = node.args.get("alias") or exp.TableAlias(
                        this=exp.to_identifier(old_name)
                    )
                    return exp.Table(this=exp.to_identifier(new_name), alias=alias)
                return node

            transformed = tree.transform(_rename)
            return transformed.sql(dialect=self.dialect)
        except Exception:
            logger.debug(
                "AST-based table rename failed for '%s' -> '%s', falling back to regex",
                old_name,
                new_name,
            )
            import re

            return re.sub(rf"\b{re.escape(old_name)}\b", new_name, sql_text)

    def _build_select_columns(
        self, plan: ResolvedPlan, sources: dict[str, SourceDefinition]
    ) -> list[str]:
        """Build SELECT columns for simple (non-locality) path."""
        colliding = self._colliding_dim_leaves(plan.dimensions)
        cols: list[str] = []

        # Dimensions
        for dim in plan.dimensions:
            expr = self._dim_expr(dim, sources)
            cols.append(f"{expr} AS {self._dimension_alias(dim, colliding)}")

        # Build map of measure names to their expressions (for derived measures)
        measure_expr_map: dict[str, str] = {}
        for m in plan.measures:
            if not m.is_derived:
                measure_expr = self._build_measure_expr(m, sources)
                cols.append(f"{measure_expr} AS {m.name}")
                measure_expr_map[m.name] = measure_expr
            else:
                # Derived: substitute dependencies with their expressions
                expr = self._substitute_measure_refs(
                    m.expr,
                    {
                        dep: measure_expr_map[dep]
                        for dep in m.depends_on
                        if dep in measure_expr_map
                    },
                )
                cols.append(f"{expr} AS {m.name}")
                measure_expr_map[m.name] = expr

        return cols

    def _build_measure_expr(
        self, m: ResolvedMeasure, sources: dict[str, SourceDefinition]
    ) -> str:
        """Build the SQL expression for a single measure."""
        expr = self._qualify_expr(m.expr, sources)

        # Translate custom functions (median, percentile, count_distinct)
        expr = self._translate_custom_funcs(expr)

        if m.filter:
            filter_sql = self._qualify_expr(m.filter, sources)
            return self._apply_measure_filter(expr, filter_sql)

        return expr

    def _apply_measure_filter(self, expr: str, filter_sql: str) -> str:
        """Apply a measure-level filter by injecting CASE WHEN into each aggregate."""
        try:
            tree = sqlglot.parse_one(
                f"SELECT {quote_reserved_identifiers(expr, self.dialect)}",
                read=self.dialect,
            )
            select_expr = tree.expressions[0]
            if isinstance(select_expr, exp.Alias):
                select_expr = select_expr.this

            filter_cond = parse_predicate(filter_sql, self.dialect)

            def _make_case(inner_node):
                return exp.Case(
                    ifs=[exp.If(this=filter_cond.copy(), true=inner_node.copy())]
                )

            def _inject_filter(node):
                """Walk the AST and inject CASE WHEN filter into each aggregate's argument."""
                if isinstance(node, exp.AggFunc):
                    if isinstance(node, exp.Count):
                        count_arg = node.this
                        if isinstance(count_arg, exp.Star):
                            node.set(
                                "this",
                                _make_case(exp.Literal.number(1)),
                            )
                            return node
                        if (
                            isinstance(count_arg, exp.Distinct)
                            and count_arg.expressions
                        ):
                            inner = count_arg.expressions[0]
                            node.set(
                                "this", exp.Distinct(expressions=[_make_case(inner)])
                            )
                            return node
                    if node.this is not None:
                        node.set("this", _make_case(node.this))
                    return node
                return node

            transformed = select_expr.transform(_inject_filter)
            result = transformed.sql(dialect=self.dialect)
            if result != expr:
                return result
        except Exception:
            logger.debug(
                "Failed to inject filter into aggregates for measure: %s", expr
            )

        return f"CASE WHEN {filter_sql} THEN {expr} END"

    def _translate_custom_funcs(self, expr: str) -> str:
        """Translate custom functions: median(), percentile(), count_distinct()."""
        tree = sqlglot.parse_one(
            f"SELECT {quote_reserved_identifiers(expr, self.dialect)}",
            read=self.dialect,
        )

        has_custom = False
        has_custom = has_custom or any(True for _ in tree.find_all(exp.Median))
        for node in tree.find_all(exp.Anonymous):
            if node.name.lower() in ("percentile", "count_distinct"):
                has_custom = True
                break
        if not has_custom:
            return expr

        def _replace(node):
            if isinstance(node, exp.Median):
                col_sql = node.this.sql(dialect=self.dialect)
                return sqlglot.parse_one(
                    f"SELECT PERCENTILE_CONT(0.5) WITHIN GROUP (ORDER BY {col_sql})",
                    read=self.dialect,
                ).expressions[0]
            if isinstance(node, exp.Anonymous) and node.name.lower() == "percentile":
                if len(node.expressions) >= 2:
                    col_sql = node.expressions[0].sql(dialect=self.dialect)
                    p_sql = node.expressions[1].sql(dialect=self.dialect)
                    return sqlglot.parse_one(
                        f"SELECT PERCENTILE_CONT({p_sql}) WITHIN GROUP (ORDER BY {col_sql})",
                        read=self.dialect,
                    ).expressions[0]
            if (
                isinstance(node, exp.Anonymous)
                and node.name.lower() == "count_distinct"
            ):
                if node.expressions:
                    col_sql = node.expressions[0].sql(dialect=self.dialect)
                    return sqlglot.parse_one(
                        f"SELECT COUNT(DISTINCT {col_sql})", read=self.dialect
                    ).expressions[0]
            return node

        transformed = tree.transform(_replace)
        return transformed.expressions[0].sql(dialect=self.dialect)

    def _extract_outer_aggregate(self, expr: str) -> tuple[str | None, str | None]:
        """Use AST to extract the outer aggregate function name and inner expression."""
        tree = sqlglot.parse_one(
            f"SELECT {quote_reserved_identifiers(expr, self.dialect)}",
            read=self.dialect,
        )
        select_expr = tree.expressions[0]
        if isinstance(select_expr, exp.Alias):
            select_expr = select_expr.this
        if isinstance(select_expr, exp.AggFunc):
            func_name = select_expr.sql_name()
            inner = select_expr.this.sql(dialect=self.dialect)
            return func_name, inner
        if isinstance(select_expr, exp.Anonymous):
            func_name = select_expr.name
            if select_expr.expressions:
                inner = select_expr.expressions[0].sql(dialect=self.dialect)
                return func_name, inner
        return None, None

    def _substitute_measure_refs(self, expr: str, replacements: dict[str, str]) -> str:
        """Replace bare measure name references in an expression using AST transform."""
        if not replacements:
            return expr
        tree = sqlglot.parse_one(
            f"SELECT {quote_reserved_identifiers(expr, self.dialect)}",
            read=self.dialect,
        )

        def _replace(node):
            if (
                isinstance(node, exp.Column)
                and not node.table
                and node.name in replacements
            ):
                replacement_sql = replacements[node.name]
                return sqlglot.parse_one(
                    f"SELECT {replacement_sql}", read=self.dialect
                ).expressions[0]
            return node

        transformed = tree.transform(_replace)
        return transformed.expressions[0].sql(dialect=self.dialect)

    def _build_join(
        self,
        join: ResolvedJoin,
        sources: dict[str, SourceDefinition],
        plan: ResolvedPlan,
    ) -> str:
        join_type = "LEFT JOIN" if plan.include_empty else "JOIN"
        # If to_source is an alias, resolve the actual source for the table ref
        actual_source = self._alias_map.get(join.to_source, join.to_source)
        if actual_source != join.to_source:
            # This is an aliased join: JOIN actual_table AS alias
            src = sources.get(actual_source)
            if src and src.is_table_source and src.table:
                join_ref = f"{src.table} AS {join.to_source}"
            else:
                join_ref = f"{actual_source} AS {join.to_source}"
        else:
            join_ref = self._source_ref(join.to_source, sources)
        on_clause = _build_on_clause(
            join.from_source, join.from_column, join.to_source, join.to_column
        )
        return f"{join_type} {join_ref} ON {on_clause}"

    def _build_group_by_exprs(
        self, plan: ResolvedPlan, sources: dict[str, SourceDefinition]
    ) -> list[str]:
        exprs = []
        for dim in plan.dimensions:
            exprs.append(self._dim_expr(dim, sources))
        return exprs

    # SQLite strftime format strings for time truncation.
    # None entries require special date arithmetic (handled in _sqlite_time_trunc).
    _SQLITE_STRFTIME: dict[str, str | None] = {
        "year": "%Y-01-01",
        "month": "%Y-%m-01",
        "day": "%Y-%m-%d",
        "hour": "%Y-%m-%d %H:00:00",
        "quarter": None,
        "week": None,
    }

    def _dim_expr(
        self, dim: QueryDimension, sources: dict[str, SourceDefinition]
    ) -> str:
        """Build dimension expression, including time truncation and computed column expansion."""
        field = self._expand_computed_columns(dim.field, sources)
        if dim.granularity:
            return self._time_trunc(dim.granularity, field)
        return field

    _WEEKDAYS = frozenset(
        {"sunday", "monday", "tuesday", "wednesday", "thursday", "friday", "saturday"}
    )

    def _bigquery_date_part(self, granularity: str) -> str:
        # BigQuery spells a week starting on a given weekday as WEEK(MONDAY),
        # not the bare WEEK_MONDAY that other systems accept.
        if granularity.startswith("week_"):
            weekday = granularity[len("week_") :]
            if weekday in self._WEEKDAYS:
                return f"WEEK({weekday.upper()})"
        return granularity.upper()

    def _time_trunc(self, granularity: str, field: str) -> str:
        """Generate dialect-appropriate time truncation expression."""
        g = granularity.lower()
        if self.dialect == "sqlite":
            return self._sqlite_time_trunc(g, field)
        if self.dialect == "bigquery":
            return f"DATE_TRUNC({field}, {self._bigquery_date_part(g)})"
        if self.dialect == "mysql":
            return self._mysql_time_trunc(g, field)
        return f"DATE_TRUNC('{g}', {field})"

    def _sqlite_time_trunc(self, granularity: str, field: str) -> str:
        """SQLite time truncation using strftime / date arithmetic."""
        fmt = self._SQLITE_STRFTIME.get(granularity)
        if fmt is not None:
            return f"DATE(STRFTIME('{fmt}', {field}))"
        if granularity == "quarter":
            return (
                f"DATE(STRFTIME('%Y', {field}) || '-' || "
                f"PRINTF('%02d', ((CAST(STRFTIME('%m', {field}) AS INTEGER) - 1) / 3) * 3 + 1) || '-01')"
            )
        if granularity == "week":
            return f"DATE({field}, 'weekday 1', '-7 days')"
        logger.warning(
            "Unsupported SQLite granularity '%s', returning raw field", granularity
        )
        return field

    _MYSQL_DATE_FORMAT: dict[str, str] = {
        "year": "%Y-01-01",
        "quarter": "%Y-01-01",
        "month": "%Y-%m-01",
        "week": "%Y-%m-%d",
        "day": "%Y-%m-%d",
        "hour": "%Y-%m-%d %H:00:00",
    }

    def _mysql_time_trunc(self, granularity: str, field: str) -> str:
        """MySQL time truncation using DATE_FORMAT / quarter arithmetic."""
        if granularity == "quarter":
            return (
                f"DATE(CONCAT(YEAR({field}), '-', "
                f"LPAD((QUARTER({field}) - 1) * 3 + 1, 2, '0'), '-01'))"
            )
        if granularity == "week":
            return f"DATE(DATE_SUB({field}, INTERVAL WEEKDAY({field}) DAY))"
        fmt = self._MYSQL_DATE_FORMAT.get(granularity)
        if fmt is not None:
            return f"DATE(DATE_FORMAT({field}, '{fmt}'))"
        logger.warning(
            "Unsupported MySQL granularity '%s', returning raw field", granularity
        )
        return field

    def _colliding_dim_leaves(self, dims: list[QueryDimension]) -> set[str]:
        leaves = [d.field.split(".")[-1] if "." in d.field else d.field for d in dims]
        return {leaf for leaf, count in Counter(leaves).items() if count > 1}

    def _dimension_alias(
        self, dim: QueryDimension, colliding_leaves: set[str] | None = None
    ) -> str:
        leaf = dim.field.split(".")[-1] if "." in dim.field else dim.field
        if colliding_leaves and leaf in colliding_leaves:
            alias = dim.field.replace(".", "_")
        else:
            alias = leaf
        if dim.granularity:
            alias = f"{alias}_{dim.granularity}"
        return alias

    def _resolve_order_field(self, field: str, plan: ResolvedPlan) -> str:
        colliding = self._colliding_dim_leaves(plan.dimensions)
        field_lower = field.lower()
        for measure in plan.measures:
            if field_lower == measure.name.lower():
                return measure.name
            if field_lower == measure.expr.lower():
                return measure.name
            if measure.qualified_ref and field_lower == measure.qualified_ref.lower():
                return measure.name
            if (
                measure.source_name not in {"__derived__", ""}
                and field_lower == f"{measure.source_name}.{measure.name}".lower()
            ):
                return measure.name

        for dim in plan.dimensions:
            alias = self._dimension_alias(dim, colliding)
            if field_lower == dim.field.lower() or field_lower == alias.lower():
                return alias

        raise ValueError(
            f"ORDER BY field '{field}' is not a recognized measure or dimension in this query"
        )

    def _collect_cte_target_sources(
        self,
        group: MeasureGroup,
        plan: ResolvedPlan,
        dim_keys: list[dict] | None = None,
    ) -> set[str]:
        """Collect sources needed for this CTE — only safely reachable ones."""
        safe_adj = self._build_safe_adjacency(plan)
        target_sources: set[str] = set()

        # Only include dimension sources reachable via safe edges
        dims_to_check = (
            dim_keys
            if dim_keys is not None
            else [{"expr": dim.field} for dim in plan.dimensions]
        )
        for dk in dims_to_check:
            dim_sources = self._parser.extract_source_refs(dk["expr"])
            for ds in dim_sources:
                if ds == group.source_name:
                    target_sources.add(ds)
                    continue
                path = self._find_join_path_steps(group.source_name, ds, safe_adj)
                if path is not None:
                    target_sources.add(ds)

        known_sources = set(target_sources)
        known_sources.add(group.source_name)
        for filter_expr in plan.where_filters:
            filter_sources = self._parser.extract_source_refs(filter_expr)
            if not filter_sources or filter_sources & known_sources:
                for fs in filter_sources:
                    if fs == group.source_name:
                        target_sources.add(fs)
                        continue
                    path = self._find_join_path_steps(group.source_name, fs, safe_adj)
                    if path is not None:
                        target_sources.add(fs)
                        known_sources.add(fs)

        # Include sources from measure-level filters
        for m in group.measures:
            if m.filter:
                filter_sources = self._parser.extract_source_refs(m.filter)
                for fs in filter_sources:
                    if fs == group.source_name:
                        target_sources.add(fs)
                        continue
                    path = self._find_join_path_steps(group.source_name, fs, safe_adj)
                    if path is not None:
                        target_sources.add(fs)
                        known_sources.add(fs)

        # Include sources from measure expressions themselves
        for m in group.measures:
            measure_sources = self._parser.extract_source_refs(m.expr)
            for ms in measure_sources:
                if ms == group.source_name or ms in known_sources:
                    target_sources.add(ms)
                    continue
                path = self._find_join_path_steps(group.source_name, ms, safe_adj)
                if path is not None:
                    target_sources.add(ms)
                    known_sources.add(ms)

        return target_sources

    def _build_safe_adjacency(
        self, plan: ResolvedPlan
    ) -> dict[str, list[tuple[str, ResolvedJoin]]]:
        """Build adjacency graph using only many_to_one and one_to_one edges."""
        adjacency: dict[str, list[tuple[str, ResolvedJoin]]] = {}
        for join in plan.joins:
            if join.relationship in ("many_to_one", "one_to_one"):
                adjacency.setdefault(join.from_source, []).append(
                    (join.to_source, join)
                )
            if RELATIONSHIP_INVERSE[join.relationship] in ("many_to_one", "one_to_one"):
                adjacency.setdefault(join.to_source, []).append(
                    (join.from_source, join)
                )
        return adjacency

    def _resolve_having_for_locality(
        self,
        filter_expr: str,
        plan: ResolvedPlan,
        measure_cte_map: dict[str, str],
        derived_expr_map: dict[str, str] | None = None,
    ) -> str:
        """Rewrite HAVING filter to reference CTE output columns.

        Handles: raw aggregates (sum(orders.amount)), predefined measure refs
        (orders.revenue), bare measure names, derived measure names (inlined),
        and case-insensitive matching.
        """
        # Build comprehensive replacement map
        replacement_map: dict[str, str] = {}
        for m in plan.measures:
            if m.is_derived:
                # For derived measures, inline the full expression so the outer
                # WHERE clause doesn't reference a SELECT alias (which is illegal).
                if derived_expr_map and m.name in derived_expr_map:
                    replacement_map[m.name.lower()] = f"({derived_expr_map[m.name]})"
                continue
            cte_alias = measure_cte_map.get(m.name)
            if not cte_alias:
                continue
            # In multi-CTE (FULL JOIN) mode, NULL from unmatched rows should
            # be treated as 0 so that filters like "count(x) = 0" work.
            if len(plan.measure_groups) > 1:
                cte_ref = f"COALESCE({cte_alias}.{m.name}, 0)"
            else:
                cte_ref = f"{cte_alias}.{m.name}"
            replacement_map[m.expr.lower()] = cte_ref
            if m.qualified_ref:
                replacement_map[m.qualified_ref.lower()] = cte_ref
            elif m.source_name and m.source_name not in ("__derived__", ""):
                replacement_map[f"{m.source_name}.{m.name}".lower()] = cte_ref
            replacement_map[m.name.lower()] = cte_ref

        # AST-based rewriting for robustness
        try:
            condition = parse_predicate(filter_expr, self.dialect)

            def _rewrite(node):
                if isinstance(node, (exp.AggFunc, exp.Anonymous)):
                    node_sql = node.sql(dialect=self.dialect).lower()
                    if node_sql in replacement_map:
                        return sqlglot.parse_one(
                            f"SELECT {replacement_map[node_sql]}", read=self.dialect
                        ).expressions[0]
                if isinstance(node, exp.Column):
                    if node.table:
                        ref = f"{node.table}.{node.name}".lower()
                        if ref in replacement_map:
                            return sqlglot.parse_one(
                                f"SELECT {replacement_map[ref]}", read=self.dialect
                            ).expressions[0]
                    if not node.table and node.name.lower() in replacement_map:
                        return sqlglot.parse_one(
                            f"SELECT {replacement_map[node.name.lower()]}",
                            read=self.dialect,
                        ).expressions[0]
                return node

            transformed = condition.transform(_rewrite)
            return transformed.sql(dialect=self.dialect)
        except Exception:
            logger.debug(
                "AST-based HAVING rewrite failed for locality filter, falling back to regex: %s",
                filter_expr,
            )
            import re as _re

            result = filter_expr
            for pattern, replacement in sorted(
                replacement_map.items(), key=lambda x: -len(x[0])
            ):
                result = _re.sub(
                    _re.escape(pattern), replacement, result, flags=_re.IGNORECASE
                )
            return result

    def _build_group_join_steps(
        self,
        source_name: str,
        target_sources: set[str],
        plan: ResolvedPlan,
    ) -> list[tuple[ResolvedJoin, str]]:
        if not target_sources:
            return []

        adjacency: dict[str, list[tuple[str, ResolvedJoin]]] = {}
        for join in plan.joins:
            if join.relationship in ("many_to_one", "one_to_one"):
                adjacency.setdefault(join.from_source, []).append(
                    (join.to_source, join)
                )
            if RELATIONSHIP_INVERSE[join.relationship] in ("many_to_one", "one_to_one"):
                adjacency.setdefault(join.to_source, []).append(
                    (join.from_source, join)
                )

        steps: list[tuple[ResolvedJoin, str]] = []
        seen_edges: set[tuple[str, str, str, str]] = set()

        for target in sorted(target_sources - {source_name}):
            path_steps = self._find_join_path_steps(source_name, target, adjacency)
            if not path_steps:
                raise ValueError(
                    f"Aggregate locality cannot safely reach '{target}' from "
                    f"'{source_name}' without traversing one_to_many edges"
                )
            for join, next_source in path_steps:
                edge_key = (
                    join.from_source,
                    join.to_source,
                    join.from_column,
                    join.to_column,
                )
                if edge_key in seen_edges:
                    continue
                seen_edges.add(edge_key)
                steps.append((join, next_source))

        return steps

    def _find_join_path_steps(
        self,
        start: str,
        target: str,
        adjacency: dict[str, list[tuple[str, ResolvedJoin]]],
    ) -> list[tuple[ResolvedJoin, str]]:
        if start == target:
            return []

        queue = [start]
        parents: dict[str, tuple[str | None, ResolvedJoin | None]] = {
            start: (None, None)
        }

        while queue:
            current = queue.pop(0)
            if current == target:
                break

            for next_source, join in adjacency.get(current, []):
                if next_source in parents:
                    continue
                parents[next_source] = (current, join)
                queue.append(next_source)

        if target not in parents:
            return []

        steps: list[tuple[ResolvedJoin, str]] = []
        current = target
        while current != start:
            parent, join = parents[current]
            if parent is None or join is None:
                break
            steps.append((join, current))
            current = parent

        steps.reverse()
        return steps

    def _source_ref(self, name: str, sources: dict[str, SourceDefinition]) -> str:
        """Get the FROM reference for a source (table or CTE name)."""
        qname = _qi(name)
        src = sources.get(name)
        if not src and name in self._alias_map:
            actual_name = self._alias_map[name]
            actual_src = sources.get(actual_name)
            if actual_src is None:
                raise ValueError(
                    f"Cannot generate SQL: alias '{name}' refers to source "
                    f"'{actual_name}', which is not defined"
                )
            if actual_src.is_table_source and actual_src.table:
                return f"{actual_src.table} AS {qname}"
            if actual_src.is_sql_source:
                return f"{_qi(actual_name)} AS {qname}"
            return f"{_qi(actual_name)} AS {qname}"
        if not src:
            raise ValueError(f"Cannot generate SQL: source '{name}' is not defined")
        if src.is_sql_source:
            return qname  # references the CTE
        return f"{src.table} AS {qname}" if src.table else qname

    # ── Computed column expansion ─────────────────────────────────────

    def _get_computed_col_map(
        self, sources: dict[str, SourceDefinition]
    ) -> dict[str, str]:
        """Get or build the computed column map: {"source.col": "(qualified_expr)"}."""
        cache_key = id(sources)
        if getattr(self, "_computed_cache_key", None) != cache_key:
            self._computed_col_map = self._build_computed_col_map(sources)
            self._computed_cache_key = cache_key
        return self._computed_col_map

    def _build_computed_col_map(
        self, sources: dict[str, SourceDefinition]
    ) -> dict[str, str]:
        """Build a lookup from 'source.column' to qualified expression for computed columns."""
        result: dict[str, str] = {}
        for src_name, src in sources.items():
            col_names = {c.name for c in src.columns}
            for col in src.columns:
                if col.expr is None:
                    continue
                qualified = self._qualify_bare_refs_in_expr(
                    col.expr, src_name, col_names
                )
                result[f"{src_name}.{col.name}"] = f"({qualified})"
        return result

    def _qualify_bare_refs_in_expr(
        self, expr: str, source_name: str, col_names: set[str]
    ) -> str:
        """Qualify bare column references in a computed column expression with the source name."""
        try:
            tree = sqlglot.parse_one(
                f"SELECT {quote_reserved_identifiers(expr, self.dialect)}",
                read=self.dialect,
            )

            def _qualify(node: exp.Expression) -> exp.Expression:
                if (
                    isinstance(node, exp.Column)
                    and not node.table
                    and node.name in col_names
                ):
                    return exp.Column(
                        this=node.this.copy(),
                        table=exp.to_identifier(source_name),
                    )
                return node

            transformed = tree.transform(_qualify)
            return transformed.expressions[0].sql(dialect=self.dialect)
        except Exception:
            logger.debug(
                "AST-based bare ref qualification failed for expr '%s' on source '%s'",
                expr,
                source_name,
            )
            return expr

    def _expand_computed_columns(
        self, expr: str, sources: dict[str, SourceDefinition]
    ) -> str:
        """Expand computed column references to their underlying expressions."""
        computed_map = self._get_computed_col_map(sources)
        if not computed_map:
            return expr

        try:
            condition = parse_predicate(expr, self.dialect)

            changed = False

            def _replace(node: exp.Expression) -> exp.Expression:
                nonlocal changed
                if isinstance(node, exp.Column) and node.table:
                    qualified = f"{node.table}.{node.name}"
                    if qualified in computed_map:
                        changed = True
                        return sqlglot.parse_one(
                            f"SELECT {computed_map[qualified]}", read=self.dialect
                        ).expressions[0]
                return node

            transformed = condition.transform(_replace)
            if changed:
                return transformed.sql(dialect=self.dialect)
        except Exception:
            logger.debug("AST-based computed column expansion failed for: %s", expr)

        return expr

    def _qualify_expr(self, expr: str, sources: dict[str, SourceDefinition]) -> str:
        """Expand computed column references in expressions."""
        return self._expand_computed_columns(expr, sources)

    def _qualify_filter(
        self, f: str, sources: dict[str, SourceDefinition], plan: ResolvedPlan
    ) -> str:
        """Expand computed column references in WHERE filters."""
        return self._expand_computed_columns(f, sources)

    def _expand_having_filter(
        self, f: str, plan: ResolvedPlan, sources: dict[str, SourceDefinition]
    ) -> str:
        """Expand predefined measure references in HAVING filters to aggregate expressions.

        e.g., 'orders.revenue > 1000' → 'SUM(orders.amount) > 1000'
        when revenue is a predefined measure with expr='sum(amount)'.
        """
        # Build a map of qualified measure ref → SQL aggregate expression
        measure_expr_map: dict[str, str] = {}
        for m in plan.measures:
            if m.source_name and m.source_name != "__derived__":
                if not m.is_derived:
                    if m.qualified_ref:
                        measure_expr_map[m.qualified_ref] = self._build_measure_expr(
                            m, sources
                        )
                    qualified_ref = f"{m.source_name}.{m.name}"
                    measure_expr_map[qualified_ref] = self._build_measure_expr(
                        m, sources
                    )
            # Also map bare measure name for unqualified references
            if not m.is_derived:
                measure_expr_map[m.name] = self._build_measure_expr(m, sources)

        if not measure_expr_map:
            return f

        # Use AST to find and replace column references matching measure names
        try:
            condition = parse_predicate(f, self.dialect)

            changed = False

            def _replace(node):
                nonlocal changed
                if isinstance(node, exp.Column):
                    table = node.table
                    col_name = node.name
                    if table:
                        qualified = f"{table}.{col_name}"
                        if qualified in measure_expr_map:
                            changed = True
                            return sqlglot.parse_one(
                                f"SELECT {measure_expr_map[qualified]}",
                                read=self.dialect,
                            ).expressions[0]
                    elif col_name in measure_expr_map:
                        changed = True
                        return sqlglot.parse_one(
                            f"SELECT {measure_expr_map[col_name]}",
                            read=self.dialect,
                        ).expressions[0]
                return node

            new_where = condition.transform(_replace)
            if changed:
                return new_where.sql(dialect=self.dialect)
        except Exception:
            logger.debug(
                "AST-based HAVING expansion failed, returning filter unchanged: %s", f
            )
        return f

    def _transpile(self, outer_sql: str) -> str:
        """Normalize the outer scaffold for the target dialect.

        Source CTEs are concatenated by generate() verbatim, so only the
        engine-generated outer scaffold (which embeds user-authored expr:
        fragments already in self.dialect) reaches this function. Reading and
        writing in self.dialect preserves dialect-specific constructs
        (TIMESTAMP_SUB, DATEADD, APPROX_COUNT_DISTINCT, etc.) that a
        postgres-round-trip would mangle.
        """
        if self.dialect == "postgres":
            return outer_sql
        try:
            # Quote reserved-word identifiers so target dialect parsers do not
            # confuse them with keywords (e.g. Snowflake's SAMPLE, QUALIFY).
            quoted_outer = quote_reserved_identifiers(outer_sql, self.dialect)
            results = sqlglot.transpile(
                quoted_outer, read=self.dialect, write=self.dialect
            )
            return results[0] if results else outer_sql
        except Exception:
            logger.debug(
                "Outer transpile in '%s' failed; returning un-normalized outer",
                self.dialect,
            )
            return outer_sql
