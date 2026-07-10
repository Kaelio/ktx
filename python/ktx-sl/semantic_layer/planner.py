from __future__ import annotations

import logging
import re
from collections import Counter

import sqlglot
from sqlglot import exp

from semantic_layer.graph import JoinGraph
from semantic_layer.models import (
    ColumnVisibility,
    MeasureDefinition,
    MeasureGroup,
    OrderByClause,
    Provenance,
    QueryDimension,
    ResolvedColumn,
    ResolvedJoin,
    ResolvedMeasure,
    ResolvedPlan,
    SemanticQuery,
    SourceDefinition,
)
from semantic_layer.parser import (
    ExpressionParser,
    parse_predicate,
    quote_reserved_identifiers,
)

# DIALECT CONVENTION:
#   User-authored measure `expr`, `filter`, and computed-column fragments must
#   be parsed with `read=self.dialect`. Authors write in the connection's
#   native dialect (per sl_capture); parsing as postgres silently drops
#   dialect-specific tokens. When re-emitting ASTs as strings for later
#   composition, use `sql(dialect=self.dialect)` so dialect-specific
#   functions (e.g. BigQuery `TIMESTAMP_SUB`, Snowflake `DATEADD`) survive.

logger = logging.getLogger(__name__)


class QueryPlanner:
    def __init__(
        self,
        sources: dict[str, SourceDefinition],
        graph: JoinGraph,
        *,
        dialect: str = "postgres",
    ):
        self.sources = sources
        self.graph = graph
        self.dialect = dialect
        self.parser = ExpressionParser(dialect=dialect)

    def plan(self, query: SemanticQuery) -> ResolvedPlan:
        # 0. Validate column visibility
        self._validate_visibility(query)

        # 1. Resolve dimensions
        dimensions = self._resolve_dimensions(query.dimensions)

        # 2. Resolve measures (parse, look up pre-defined, classify)
        raw_measures = self._resolve_measures(query.measures)

        if query.predefined_measures_only:
            self._reject_composed_measures(raw_measures)
            self._reject_composed_filter_aggregates(query.filters)

        # 3. Topological sort for derived measures
        measures = self._topological_sort_measures(raw_measures)

        # 3a. Apply query-time segments (AND each into matching measures' filter)
        measures = self._apply_query_segments(measures, query.segments)

        # 3b. Validate column references exist
        self._validate_column_refs(measures, dimensions, query.filters)

        # 4. Collect all referenced sources
        source_refs: set[str] = set()
        for m in measures:
            if not m.is_derived:
                source_refs.add(m.source_name)
                source_refs.update(self.parser.extract_source_refs(m.expr))
                if m.filter:
                    source_refs.update(self.parser.extract_source_refs(m.filter))
        for d in dimensions:
            refs = self.parser.extract_source_refs(d.field)
            source_refs.update(refs)
        for f in query.filters:
            source_refs.update(self.parser.extract_source_refs(f))

        if not source_refs:
            raise ValueError("Query does not reference any sources")

        # 5. Determine anchor source (must happen BEFORE resolve_join_tree)
        anchor_source = self._pick_anchor(
            measures,
            dimensions,
            source_refs,
            include_empty=query.include_empty,
        )

        # 6. Resolve join tree, rooted at the anchor
        tree = self.graph.resolve_join_tree(source_refs, root=anchor_source)

        # 7. Build structured joins from tree edges
        joins = [
            ResolvedJoin(
                from_source=e.from_source,
                to_source=e.to_source,
                from_column=e.from_column,
                to_column=e.to_column,
                relationship=e.relationship,
            )
            for e in tree.edges
        ]

        # 8. Detect fanout / chasm trap
        has_fan_out, measure_groups, fan_out_desc, locality_descs = (
            self._detect_fan_out(measures, dimensions, tree, filters=query.filters)
        )

        # 9. Classify filters
        where_filters, having_filters = self._classify_filters(query.filters, measures)

        # 10. Compute anchor grain
        dim_sources = set()
        for d in dimensions:
            refs = self.parser.extract_source_refs(d.field)
            dim_sources.update(refs)
        anchor_grain = []
        for d in dimensions:
            anchor_grain.append(d.field)

        # 11. Build resolved columns
        columns = self._build_columns(measures, dimensions)

        # 12. Build join path descriptions
        join_paths = []
        for j in joins:
            from_cols = [c.strip() for c in j.from_column.split(",")]
            to_cols = [c.strip() for c in j.to_column.split(",")]
            conditions = " AND ".join(
                f"{j.from_source}.{fc} = {j.to_source}.{tc}"
                for fc, tc in zip(from_cols, to_cols)
            )
            join_paths.append(f"{conditions} ({j.relationship})")

        # 13. Resolve order_by
        order_by_clauses = []
        for ob in query.order_by:
            if isinstance(ob, dict):
                order_by_clauses.append(OrderByClause(**ob))
            elif isinstance(ob, str):
                order_by_clauses.append(OrderByClause(field=ob))
            else:
                order_by_clauses.append(ob)

        return ResolvedPlan(
            sources_used=sorted(tree.sources),
            join_paths=join_paths,
            joins=joins,
            anchor_source=anchor_source,
            anchor_grain=anchor_grain,
            fan_out_description=fan_out_desc,
            has_fan_out=has_fan_out,
            measure_groups=measure_groups,
            aggregate_locality=locality_descs,
            where_filters=where_filters,
            having_filters=having_filters,
            columns=columns,
            measures=measures,
            dimensions=dimensions,
            order_by=order_by_clauses,
            limit=query.limit,
            include_empty=query.include_empty,
        )

    def _resolve_dimensions(self, dims: list[str | dict]) -> list[QueryDimension]:
        result = []
        seen: set[tuple[str, str | None]] = set()
        for d in dims:
            if isinstance(d, str):
                dim = QueryDimension(field=self._qualify_bare_column(d))
            elif isinstance(d, dict):
                field = d.get("field", "")
                dim = QueryDimension(**{**d, "field": self._qualify_bare_column(field)})
            else:
                continue
            key = (dim.field, dim.granularity)
            if key not in seen:
                seen.add(key)
                result.append(dim)
        return result

    def _qualify_bare_column(self, field: str) -> str:
        """Qualify a bare column name to source.column if unambiguous."""
        if "." in field or not field.strip().isidentifier():
            return field
        bare = field.strip()
        matches: list[str] = []
        for source_name, source in self.sources.items():
            if any(c.name == bare for c in source.columns):
                matches.append(source_name)
        if len(matches) == 1:
            return f"{matches[0]}.{bare}"
        if len(matches) > 1:
            raise ValueError(
                f"Column '{bare}' is ambiguous: it exists in multiple sources "
                f"({', '.join(sorted(matches))}). Use a qualified name like "
                f"'{matches[0]}.{bare}' to disambiguate."
            )
        return field  # not found — leave as-is, downstream will error

    def _resolve_measures(self, raw: list[str | dict]) -> list[ResolvedMeasure]:
        measures: list[ResolvedMeasure] = []
        # Collect all named measures for dependency detection
        named: set[str] = set()
        for m in raw:
            if isinstance(m, dict) and m.get("name"):
                named.add(m["name"])
        colliding_predefined_names = self._collect_colliding_predefined_names(raw)

        for m in raw:
            if isinstance(m, str):
                measures.append(
                    self._resolve_measure_str(m, colliding_predefined_names)
                )
            elif isinstance(m, dict):
                measures.append(
                    self._resolve_measure_dict(
                        m,
                        named,
                        colliding_predefined_names,
                    )
                )

        # Expand pre-defined measure chains (e.g., profit = revenue - total_cost)
        measures = self._expand_predefined_chains(measures)
        # Auto-add predefined measures referenced by derived measures
        measures = self._auto_add_predefined_deps(measures)
        # Qualify duplicate measure names across sources
        measures = self._qualify_duplicate_names(measures)
        return measures

    def _reject_composed_measures(self, measures: list[ResolvedMeasure]) -> None:
        composed = [m for m in measures if m.provenance is Provenance.COMPOSED]
        if not composed:
            return
        rejected = ", ".join(f"'{m.expr}'" for m in composed)
        raise ValueError(
            f"Only predefined semantic-layer measures can be queried on this "
            f"connection (query_policy: semantic-layer-only); composed measure "
            f"expressions are not allowed: {rejected}. Use measures declared "
            f"on the semantic-layer sources, referenced as 'source.measure'."
        )

    def _reject_composed_filter_aggregates(self, filters: list[str]) -> None:
        # Predefined measures are compared in HAVING by name (e.g.
        # `orders.revenue > 100`), which parses as a plain column ref. Any
        # aggregate function written into a filter is therefore a runtime-composed
        # aggregate the policy forbids — without this guard it would slip through
        # `_classify_filters` into HAVING and evaluate an arbitrary aggregate.
        composed: list[str] = []
        for f in filters:
            if not f or not f.strip():
                continue
            for clause in self._split_top_level_and(f):
                if self.parser.parse(clause).is_aggregate:
                    composed.append(clause)
        if not composed:
            return
        rejected = ", ".join(f"'{c}'" for c in composed)
        raise ValueError(
            f"Only predefined semantic-layer measures can be queried on this "
            f"connection (query_policy: semantic-layer-only); filters may not "
            f"compose aggregate expressions: {rejected}. Filter on declared "
            f"dimensions or columns, or compare a predefined measure by name "
            f"(e.g. 'orders.revenue > 100')."
        )

    def _collect_colliding_predefined_names(self, raw: list[str | dict]) -> set[str]:
        counts: Counter[str] = Counter()
        for item in raw:
            if isinstance(item, str):
                ref = self._match_predefined_ref(item)
                if ref:
                    _, measure_name = ref
                    counts[measure_name] += 1
                else:
                    bare = item.strip()
                    if bare.isidentifier():
                        try:
                            unq = self._resolve_unqualified_measure(bare)
                            if unq:
                                counts[unq[1]] += 1
                        except ValueError:
                            pass  # ambiguous — caught later during resolution
            elif isinstance(item, dict):
                expr = item.get("expr", "")
                for _, measure_name in self._extract_predefined_refs(expr):
                    counts[measure_name] += 1
        return {name for name, count in counts.items() if count > 1}

    def _extract_predefined_refs(self, expr: str) -> list[tuple[str, str]]:
        refs: list[tuple[str, str]] = []
        parsed = self.parser.parse(expr)
        for ref in parsed.column_refs:
            parts = ref.split(".", 1)
            if len(parts) != 2:
                continue
            src_name, measure_name = parts
            actual_src_name = self.graph.alias_map.get(src_name, src_name)
            src = self.sources.get(actual_src_name)
            if not src:
                continue
            if any(md.name == measure_name for md in src.measures) and not any(
                c.name == measure_name for c in src.columns
            ):
                refs.append((src_name, measure_name))
        return refs

    def _match_predefined_ref(self, expr: str) -> tuple[str, str] | None:
        parsed = self.parser.parse(expr)
        if parsed.is_aggregate or len(parsed.column_refs) != 1:
            return None
        ref = next(iter(parsed.column_refs))
        parts = ref.split(".", 1)
        if len(parts) != 2:
            return None
        source_name, measure_name = parts
        actual_source_name = self.graph.alias_map.get(source_name, source_name)
        source = self.sources.get(actual_source_name)
        if not source:
            return None
        if any(md.name == measure_name for md in source.measures):
            return source_name, measure_name
        return None

    def _resolve_unqualified_measure(self, bare_name: str) -> tuple[str, str] | None:
        """Find a unique predefined measure matching a bare (unqualified) name.

        Returns (source_name, measure_name) if exactly one source defines it.
        Raises ValueError if ambiguous (multiple sources).
        """
        matches: list[str] = []
        for source_name, source in self.sources.items():
            if any(md.name == bare_name for md in source.measures):
                matches.append(source_name)
        if len(matches) == 0:
            return None
        if len(matches) == 1:
            return matches[0], bare_name
        raise ValueError(
            f"Measure '{bare_name}' is ambiguous: it exists in multiple sources "
            f"({', '.join(sorted(matches))}). Use a qualified name like "
            f"'{matches[0]}.{bare_name}' to disambiguate."
        )

    @staticmethod
    def _qualified_measure_name(source_name: str, measure_name: str) -> str:
        return f"{source_name}_{measure_name}"

    @staticmethod
    def _auto_measure_name(expr: str) -> str:
        normalized = expr.replace(".", "_").strip().lower()
        normalized = re.sub(r"[^a-z0-9_]+", "_", normalized)
        normalized = re.sub(r"_+", "_", normalized).strip("_")
        if not normalized:
            return "measure"
        if normalized[0].isdigit():
            return f"m_{normalized}"
        return normalized

    def _measure_definition_for_resolved(
        self,
        source: SourceDefinition,
        source_name: str,
        resolved_name: str,
        original_name: str | None = None,
    ):
        for candidate in (original_name, resolved_name):
            if not candidate:
                continue
            mdef = next((md for md in source.measures if md.name == candidate), None)
            if mdef:
                return mdef
        for mdef in source.measures:
            if resolved_name == self._qualified_measure_name(source_name, mdef.name):
                return mdef
        return None

    def _split_qualified_dep_token(self, token: str) -> tuple[str, str] | None:
        for source_name, source in self.sources.items():
            prefix = f"{source_name}_"
            if not token.startswith(prefix):
                continue
            measure_name = token[len(prefix) :]
            if any(md.name == measure_name for md in source.measures):
                return source_name, measure_name
        return None

    def _auto_add_predefined_deps(
        self, measures: list[ResolvedMeasure]
    ) -> list[ResolvedMeasure]:
        """Auto-add predefined measures that derived measures depend on but aren't in the list."""
        existing_names = {m.name for m in measures}
        extra: list[ResolvedMeasure] = []
        for m in measures:
            if not m.is_derived:
                continue
            for dep in m.depends_on:
                if dep in existing_names:
                    continue
                exact = self._split_qualified_dep_token(dep)
                if exact:
                    src_name, measure_name = exact
                    resolved = self._resolve_measure_str(
                        f"{src_name}.{measure_name}",
                        set(),
                    )
                    if resolved.name != dep:
                        resolved = resolved.model_copy(update={"name": dep})
                    extra.append(resolved)
                    existing_names.add(dep)
                    continue
                # Try to resolve as a predefined measure from any source
                for src in self.sources.values():
                    mdef = next((md for md in src.measures if md.name == dep), None)
                    if mdef:
                        extra.append(
                            self._resolve_measure_str(f"{src.name}.{dep}", set())
                        )
                        existing_names.add(dep)
                        break
        if extra:
            # Prepend extras so dependencies come before derived measures
            measures = extra + measures
        return measures

    def _qualify_duplicate_names(
        self, measures: list[ResolvedMeasure]
    ) -> list[ResolvedMeasure]:
        """Qualify measure names that collide across different sources."""
        name_counts = Counter(m.name for m in measures)
        colliding = {name for name, count in name_counts.items() if count > 1}
        if not colliding:
            return measures
        result = []
        for m in measures:
            if m.name in colliding and m.source_name != "__derived__":
                result.append(
                    m.model_copy(update={"name": f"{m.source_name}_{m.name}"})
                )
            else:
                result.append(m)
        return result

    def _expand_predefined_chains(
        self, measures: list[ResolvedMeasure]
    ) -> list[ResolvedMeasure]:
        """Expand pre-defined measures that reference other pre-defined measures.

        Fully recursive: handles chains of arbitrary depth (e.g.,
        margin = net_profit / revenue, where net_profit = gross_profit - tax,
        where gross_profit = revenue - cost).
        """
        existing_names = {m.name for m in measures}
        extra_measures: list[ResolvedMeasure] = []
        updated: list[ResolvedMeasure] = []
        # Track already-expanded deps to avoid duplicates
        expanded: set[str] = set()

        def _ensure_dep(
            dep_name: str, source: SourceDefinition, source_name: str
        ) -> None:
            """Recursively ensure a dependency measure is added."""
            if dep_name in existing_names or dep_name in expanded:
                return
            dep_mdef = next((md for md in source.measures if md.name == dep_name), None)
            if not dep_mdef:
                return

            dep_other = {md.name for md in source.measures if md.name != dep_name}
            dep_parsed = self.parser.parse(dep_mdef.expr, known_measure_names=dep_other)

            if dep_parsed.depends_on_measures:
                # Recursively add sub-dependencies first
                for sub_dep in sorted(dep_parsed.depends_on_measures):
                    _ensure_dep(sub_dep, source, source_name)
                # This dependency is itself derived
                extra_measures.append(
                    ResolvedMeasure(
                        name=dep_name,
                        original_name=dep_name,
                        expr=dep_mdef.expr,
                        source_name="__derived__",
                        provenance=Provenance.VERIFIED,
                        is_derived=True,
                        depends_on=sorted(dep_parsed.depends_on_measures),
                        description=dep_mdef.description,
                    )
                )
            else:
                # Leaf dependency: qualify and add as concrete measure
                extra_measures.append(
                    ResolvedMeasure(
                        name=dep_name,
                        original_name=dep_name,
                        qualified_ref=f"{source_name}.{dep_name}",
                        expr=self._qualify_predefined_expr(dep_mdef.expr, source_name),
                        source_name=source_name,
                        filter=self._compose_measure_filter(dep_mdef, source_name),
                        provenance=Provenance.VERIFIED,
                        description=dep_mdef.description,
                    )
                )
            existing_names.add(dep_name)
            expanded.add(dep_name)

        for m in measures:
            if m.provenance != Provenance.VERIFIED or m.is_derived:
                updated.append(m)
                continue

            actual_source_name = self.graph.alias_map.get(m.source_name, m.source_name)
            source = self.sources.get(actual_source_name)
            if not source:
                updated.append(m)
                continue

            mdef = self._measure_definition_for_resolved(
                source, m.source_name, m.name, m.original_name
            )
            if not mdef:
                updated.append(m)
                continue

            other_measure_names = {
                md.name for md in source.measures if md.name != mdef.name
            }
            parsed = self.parser.parse(
                mdef.expr, known_measure_names=other_measure_names
            )

            if not parsed.depends_on_measures:
                updated.append(m)
                continue

            # Recursively add all dependencies
            for dep_name in sorted(parsed.depends_on_measures):
                _ensure_dep(dep_name, source, m.source_name)

            # Convert this measure to derived
            updated.append(
                m.model_copy(
                    update={
                        "expr": mdef.expr,
                        "source_name": "__derived__",
                        "is_derived": True,
                        "depends_on": sorted(parsed.depends_on_measures),
                        "filter": None,
                    }
                )
            )

        return extra_measures + updated

    def _resolve_measure_str(
        self,
        s: str,
        colliding_predefined_names: set[str],
    ) -> ResolvedMeasure:
        """
        "orders.revenue" → pre-defined lookup
        "sum(orders.amount)" → runtime expression
        """
        parsed = self.parser.parse(s)

        # Reject window functions in measures
        if parsed.has_window_function:
            raise ValueError(
                f"Window functions (OVER clause) are not supported in measures: '{s}'. "
                f"Window functions require row-level context and cannot be combined with "
                f"GROUP BY aggregation."
            )

        predefined_ref = self._match_predefined_ref(s)

        # Try unqualified resolution for bare identifiers (e.g. "revenue" → "orders.revenue")
        if predefined_ref is None and not parsed.is_aggregate:
            bare = s.strip()
            if bare.isidentifier():
                unqualified = self._resolve_unqualified_measure(bare)
                if unqualified:
                    source_name, measure_name = unqualified
                    qualified = f"{source_name}.{measure_name}"
                    logger.info(
                        "Resolved unqualified measure '%s' to '%s'",
                        bare,
                        qualified,
                    )
                    return self._resolve_measure_str(
                        qualified, colliding_predefined_names
                    )

        if predefined_ref:
            source_name, measure_name = predefined_ref
            actual_source_name = self.graph.alias_map.get(source_name, source_name)
            source = self.sources[actual_source_name]
            for mdef in source.measures:
                if mdef.name == measure_name:
                    resolved_name = measure_name
                    if measure_name in colliding_predefined_names:
                        resolved_name = self._qualified_measure_name(
                            source_name, measure_name
                        )
                    return ResolvedMeasure(
                        name=resolved_name,
                        original_name=measure_name,
                        qualified_ref=f"{source_name}.{measure_name}",
                        expr=self._qualify_predefined_expr(mdef.expr, source_name),
                        source_name=source_name,
                        filter=self._compose_measure_filter(mdef, source_name),
                        provenance=Provenance.VERIFIED,
                        description=mdef.description,
                    )

        # Bare column reference without aggregation — invalid as a measure
        if not parsed.is_aggregate:
            if parsed.column_refs:
                ref = next(iter(parsed.column_refs))
                src, col = ref.split(".", 1)
                raise ValueError(
                    f"Measure '{s}' is not a pre-defined measure on source '{src}' "
                    f"and has no aggregate function. Use an aggregate like "
                    f"sum({s}), count({s}), avg({s}), etc."
                )
            raise ValueError(f"Measure '{s}' does not reference any source")

        # Runtime expression
        if not parsed.source_refs:
            raise ValueError(f"Measure '{s}' does not reference any source")

        # Reject nested aggregation (e.g., avg(sum(orders.amount)))
        self._check_nested_aggregation(s)

        source_name = sorted(parsed.source_refs)[0]
        name = self._auto_measure_name(s)
        return ResolvedMeasure(
            name=name,
            original_name=name,
            expr=s,
            source_name=source_name,
            provenance=Provenance.COMPOSED,
        )

    def _resolve_measure_dict(
        self,
        d: dict,
        named: set[str],
        colliding_predefined_names: set[str],
    ) -> ResolvedMeasure:
        expr = d.get("expr", "")
        name = d.get("name", expr)
        parsed = self.parser.parse(expr, known_measure_names=named)

        # Reject window functions
        if parsed.has_window_function:
            raise ValueError(
                f"Window functions (OVER clause) are not supported in measures: '{expr}'. "
                f"Window functions require row-level context and cannot be combined with "
                f"GROUP BY aggregation."
            )

        # Check if any column_refs match predefined measures (e.g., "orders.revenue")
        predefined_deps: list[tuple[str, str, str]] = []
        for src_name, measure_name in self._extract_predefined_refs(expr):
            predefined_deps.append(
                (f"{src_name}.{measure_name}", src_name, measure_name)
            )

        # Merge bare measure deps + qualified predefined deps
        all_dep_names: set[str] = set(parsed.depends_on_measures)
        rewritten_expr = expr

        if predefined_deps:
            replacement_map: dict[str, str] = {}
            for ref, src_name, measure_name in predefined_deps:
                dep_name = measure_name
                if measure_name in colliding_predefined_names:
                    dep_name = self._qualified_measure_name(src_name, measure_name)
                replacement_map[ref] = dep_name
                all_dep_names.add(dep_name)
                named.add(dep_name)
            tree = sqlglot.parse_one(
                f"SELECT {quote_reserved_identifiers(expr, self.dialect)}",
                dialect=self.dialect,
            )

            def _replace(node):
                if isinstance(node, exp.Column) and node.table:
                    ref = f"{node.table}.{node.name}"
                    if ref in replacement_map:
                        return exp.Column(this=exp.to_identifier(replacement_map[ref]))
                return node

            rewritten_expr = (
                tree.transform(_replace).expressions[0].sql(dialect=self.dialect)
            )

        if all_dep_names:
            return ResolvedMeasure(
                name=name,
                original_name=name,
                expr=rewritten_expr,
                source_name="__derived__",
                provenance=Provenance.COMPOSED,
                is_derived=True,
                depends_on=sorted(all_dep_names),
            )

        if not parsed.source_refs:
            raise ValueError(f"Measure expr '{expr}' does not reference any source")

        # Reject nested aggregation (e.g., avg(sum(orders.amount)))
        self._check_nested_aggregation(expr)

        source_name = sorted(parsed.source_refs)[0]
        return ResolvedMeasure(
            name=name,
            original_name=name,
            expr=expr,
            source_name=source_name,
            provenance=Provenance.COMPOSED,
        )

    def _check_nested_aggregation(self, expr: str) -> None:
        """Reject expressions with nested aggregate functions (e.g., avg(sum(x)))."""
        try:
            tree = sqlglot.parse_one(
                f"SELECT {quote_reserved_identifiers(expr, self.dialect)}",
                dialect=self.dialect,
            )
            for agg_node in tree.find_all(exp.AggFunc):
                # Check if this aggregate contains another aggregate inside
                for inner in agg_node.find_all(exp.AggFunc):
                    if inner is not agg_node:
                        raise ValueError(
                            f"Nested aggregation is not supported: '{expr}'. "
                            f"Use a derived measure to combine aggregates "
                            f"(e.g., define sum_amount first, then avg it as a derived measure)."
                        )
        except ValueError:
            raise
        except Exception:
            logger.debug("Failed to check nested aggregation for: %s", expr)

    def _topological_sort_measures(
        self, measures: list[ResolvedMeasure]
    ) -> list[ResolvedMeasure]:
        by_name = {m.name: m for m in measures}
        visited: set[str] = set()
        in_stack: set[str] = set()
        result: list[ResolvedMeasure] = []

        def visit(m: ResolvedMeasure) -> None:
            if m.name in in_stack:
                raise ValueError(f"Circular dependency detected: {m.name}")
            if m.name in visited:
                return
            in_stack.add(m.name)
            for dep_name in m.depends_on:
                if dep_name in by_name:
                    visit(by_name[dep_name])
            in_stack.discard(m.name)
            visited.add(m.name)
            result.append(m)

        for m in measures:
            visit(m)
        return result

    def _pick_anchor(
        self,
        measures: list[ResolvedMeasure],
        dimensions: list[QueryDimension],
        source_refs: set[str],
        include_empty: bool,
    ) -> str:
        if include_empty:
            for d in dimensions:
                refs = self.parser.extract_source_refs(d.field)
                if refs:
                    return sorted(refs)[0]
        # Prefer the first non-derived measure's source
        for m in measures:
            if not m.is_derived and m.source_name in self.sources:
                return m.source_name
        # Fallback to first dimension's source
        for d in dimensions:
            refs = self.parser.extract_source_refs(d.field)
            if refs:
                return sorted(refs)[0]
        return sorted(source_refs)[0]

    def _compose_measure_filter(
        self, mdef: MeasureDefinition, source_name: str
    ) -> str | None:
        """Compose mdef.filter with mdef.segments[*].expr into a single AND-ed,
        qualified predicate. Returns None if neither contributes.

        Segments are bare names resolved against the measure's own source.
        Unknown names raise at plan time.
        """
        parts: list[str] = []
        if mdef.filter:
            parts.append(self._qualify_predefined_expr(mdef.filter, source_name))
        if mdef.segments:
            actual_source_name = self.graph.alias_map.get(source_name, source_name)
            source = self.sources.get(actual_source_name)
            seg_by_name = {s.name: s for s in (source.segments if source else [])}
            for seg_name in mdef.segments:
                seg = seg_by_name.get(seg_name)
                if not seg:
                    available = ", ".join(sorted(seg_by_name)) or "(none)"
                    raise ValueError(
                        f"Measure '{mdef.name}' on source '{actual_source_name}' "
                        f"references unknown segment '{seg_name}'. "
                        f"Available segments: {available}."
                    )
                parts.append(self._qualify_predefined_expr(seg.expr, source_name))
        if not parts:
            return None
        if len(parts) == 1:
            return parts[0]
        return " AND ".join(f"({p})" for p in parts)

    def _apply_query_segments(
        self,
        measures: list[ResolvedMeasure],
        query_segments: list[str],
    ) -> list[ResolvedMeasure]:
        """AND each query-time segment into the filter of every measure whose
        base source matches the segment's source.

        Errors:
        - Segment string isn't dotted source.name
        - Source or segment doesn't exist
        - No measure in the query has the segment's source as its base source
        """
        if not query_segments:
            return measures

        segs_by_source: dict[str, list[str]] = {}
        for raw in query_segments:
            if "." not in raw:
                raise ValueError(
                    f"Query-time segment '{raw}' must be a dotted "
                    f"'source.segment_name' reference."
                )
            src_name, seg_name = raw.split(".", 1)
            actual = self.graph.alias_map.get(src_name, src_name)
            source = self.sources.get(actual)
            if not source:
                raise ValueError(
                    f"Query-time segment '{raw}' references unknown source "
                    f"'{src_name}'."
                )
            seg = next((s for s in source.segments if s.name == seg_name), None)
            if not seg:
                avail = ", ".join(sorted(s.name for s in source.segments)) or "(none)"
                raise ValueError(
                    f"Query-time segment '{raw}' references unknown segment "
                    f"'{seg_name}' on source '{src_name}'. Available: {avail}."
                )
            qualified = self._qualify_predefined_expr(seg.expr, src_name)
            segs_by_source.setdefault(src_name, []).append(qualified)

        updated: list[ResolvedMeasure] = []
        matched_sources: set[str] = set()
        for m in measures:
            if m.is_derived or m.source_name not in segs_by_source:
                updated.append(m)
                continue
            matched_sources.add(m.source_name)
            new_parts: list[str] = []
            if m.filter:
                new_parts.append(m.filter)
            new_parts.extend(segs_by_source[m.source_name])
            composed = (
                new_parts[0]
                if len(new_parts) == 1
                else " AND ".join(f"({p})" for p in new_parts)
            )
            updated.append(m.model_copy(update={"filter": composed}))

        for src in segs_by_source:
            if src not in matched_sources:
                raise ValueError(
                    f"Query-time segment(s) on source '{src}' have no matching "
                    f"measure in the query. A query-time segment only applies to "
                    f"measures whose base source matches the segment's source."
                )

        return updated

    def _qualify_predefined_expr(self, expr: str, source_name: str) -> str:
        """Qualify bare column references in predefined measure expressions using sqlglot AST.

        BFS-traverses many_to_one/one_to_one joins from the measure's source to find
        columns on transitively reachable sources. This handles measure filters that
        reference joined-source columns (e.g., filter: "level = 'premium'" where
        'level' is on a 'tiers' table reachable via orders → customers → tiers).
        """
        actual_source_name = self.graph.alias_map.get(source_name, source_name)
        source = self.sources.get(actual_source_name)
        if not source:
            return expr

        # BFS through m2o/o2o joins to build column->source mapping
        col_to_source: dict[str, str] = {}
        visited: set[str] = set()
        queue = [actual_source_name]
        while queue:
            current_name = queue.pop(0)
            if current_name in visited:
                continue
            visited.add(current_name)
            current_src = self.sources.get(current_name)
            if not current_src:
                continue
            # Add columns from this source (first-discovered wins for ambiguity)
            for c in current_src.columns:
                if c.name not in col_to_source:
                    current_ref = (
                        source_name
                        if current_name == actual_source_name
                        else current_name
                    )
                    col_to_source[c.name] = current_ref
            # Traverse m2o/o2o joins
            for join_decl in current_src.joins:
                if join_decl.relationship in ("many_to_one", "one_to_one"):
                    target = join_decl.alias or join_decl.to
                    actual = join_decl.to
                    if actual not in visited:
                        queue.append(actual)
                        # Map columns using alias if present
                        joined_src = self.sources.get(actual)
                        if joined_src:
                            for c in joined_src.columns:
                                if c.name not in col_to_source:
                                    col_to_source[c.name] = target
        # Own columns always take highest priority
        for c in source.columns:
            col_to_source[c.name] = source_name

        condition = parse_predicate(expr, self.dialect)

        def _qualify_column(node):
            if (
                isinstance(node, exp.Column)
                and not node.table
                and node.name in col_to_source
            ):
                target_source = col_to_source[node.name]
                return exp.Column(
                    this=node.this.copy(), table=exp.to_identifier(target_source)
                )
            return node

        transformed = condition.transform(_qualify_column)
        return transformed.sql(dialect=self.dialect)

    def _detect_fan_out(
        self,
        measures: list[ResolvedMeasure],
        dimensions: list[QueryDimension],
        tree,
        filters: list[str] | None = None,
    ) -> tuple[bool, list[MeasureGroup], str, list[str]]:
        """
        Detect fanout and chasm traps. Group measures by source.
        If multiple measure sources exist, each needs its own pre-aggregation CTE.
        Also checks filter sources — a filter forcing a one_to_many join from the
        measure source is an error (cannot be safely pre-aggregated).
        """
        # Group non-derived measures by source
        groups: dict[str, list[ResolvedMeasure]] = {}
        for m in measures:
            if m.is_derived:
                continue
            groups.setdefault(m.source_name, []).append(m)

        # Validate multi-source aggregate expressions: if a non-derived measure
        # references sources from multiple groups, it can't be safely placed in
        # a single CTE (the other source won't be available in the CTE scope).
        if len(groups) > 1:
            for m in measures:
                if m.is_derived:
                    continue
                measure_source_refs = self.parser.extract_source_refs(m.expr)
                other_group_refs = measure_source_refs - {m.source_name}
                for ref in other_group_refs:
                    ref_actual = self.graph.alias_map.get(ref, ref)
                    source_actual = self.graph.alias_map.get(
                        m.source_name, m.source_name
                    )
                    if ref_actual == source_actual:
                        continue
                    if ref in groups and ref != m.source_name:
                        raise ValueError(
                            f"Measure '{m.name}' references multiple independent "
                            f"sources ({m.source_name}, {ref}) that are in separate "
                            f"measure groups. In aggregate locality mode, each CTE "
                            f"can only access its own source's tables. Decompose "
                            f"the expression into separate named measures and combine "
                            f"as a derived measure: e.g., "
                            f'{{"expr": "part1", "name": "a"}}, '
                            f'{{"expr": "part2", "name": "b"}}, '
                            f'{{"expr": "a / b", "name": "{m.name}"}}'
                        )

        # Collect dimension sources
        dim_sources: set[str] = set()
        for d in dimensions:
            refs = self.parser.extract_source_refs(d.field)
            dim_sources.update(refs)

        # Collect filter sources
        filter_sources: set[str] = set()
        for f in filters or []:
            filter_sources.update(self.parser.extract_source_refs(f))

        if len(groups) <= 1:
            # Single measure group: check the path FROM measure source TO dimension sources.
            # Only flag fanout if those specific paths have one_to_many edges.
            if groups:
                source_name = next(iter(groups))
                source_actual = self.graph.alias_map.get(source_name, source_name)
                has_o2m = False
                for dim_src in dim_sources:
                    if dim_src == source_name:
                        continue
                    # Skip alias siblings (same underlying source — no fanout)
                    dim_actual = self.graph.alias_map.get(dim_src, dim_src)
                    if dim_actual == source_actual:
                        continue
                    path = self.graph.find_path(source_name, dim_src)
                    if path and path.has_one_to_many:
                        has_o2m = True
                        break

                # Also check filter sources for one_to_many fanout
                if not has_o2m:
                    for filter_src in filter_sources - dim_sources - {source_name}:
                        filter_actual = self.graph.alias_map.get(filter_src, filter_src)
                        if filter_actual == source_actual:
                            continue
                        path = self.graph.find_path(source_name, filter_src)
                        if path and path.has_one_to_many:
                            raise ValueError(
                                f"Filter on '{filter_src}' requires a one_to_many join "
                                f"from measure source '{source_name}', which would cause "
                                f"incorrect aggregation (fanout). Consider rewriting the "
                                f"filter as a subquery or adding the filter source as a "
                                f"dimension source."
                            )

                if has_o2m:
                    measure_groups = [
                        MeasureGroup(
                            source_name=source_name, measures=groups[source_name]
                        )
                    ]
                    return (
                        True,
                        measure_groups,
                        f"Fanout detected: one_to_many edges from {source_name} to dimensions",
                        [f"Pre-aggregate {source_name} measures before joining"],
                    )
            return False, [], "No fanout", []

        # Multiple measure sources. Only merge groups that are provably row-safe
        # (alias siblings or pure one_to_one chains). many_to_one chains are not
        # safe to flatten because the "one" side measure is duplicated by the
        # "many" side rows.
        merged_groups = self._merge_safe_measure_groups(groups, dim_sources)

        if len(merged_groups) <= 1:
            # All measure sources are on the same safe join chain
            if merged_groups:
                mg_name, mg_measures = next(iter(merged_groups.items()))
                # Still check if there's fanout to dimension sources
                has_o2m = False
                for dim_src in dim_sources:
                    if dim_src == mg_name:
                        continue
                    path = self.graph.find_path(mg_name, dim_src)
                    if path and path.has_one_to_many:
                        has_o2m = True
                        break
                if has_o2m:
                    return (
                        True,
                        [MeasureGroup(source_name=mg_name, measures=mg_measures)],
                        f"Fanout detected: one_to_many edges from {mg_name} to dimensions",
                        [f"Pre-aggregate {mg_name} measures before joining"],
                    )
            return False, [], "No fanout", []

        # True chasm trap — independent measure sources that can't be safely merged.
        # Before building groups, validate that all filter sources are reachable
        # from at least one measure source without traversing one_to_many edges.
        # If not, the filter would be silently dropped during CTE generation.
        for filter_src in filter_sources - dim_sources:
            reachable_from_any = False
            for source_name in merged_groups:
                if filter_src == source_name:
                    reachable_from_any = True
                    break
                filter_actual = self.graph.alias_map.get(filter_src, filter_src)
                source_actual = self.graph.alias_map.get(source_name, source_name)
                if filter_actual == source_actual:
                    reachable_from_any = True
                    break
                path = self.graph.find_path(source_name, filter_src)
                if path and not path.has_one_to_many:
                    reachable_from_any = True
                    break
            if not reachable_from_any:
                raise ValueError(
                    f"Filter on '{filter_src}' is not reachable via many_to_one/one_to_one "
                    f"edges from any measure source ({', '.join(merged_groups.keys())}). "
                    f"The filter would be silently dropped in aggregate locality mode. "
                    f"Consider moving the filter condition into a SQL source or removing it."
                )

        measure_groups = []
        locality_descs = []
        for source_name, group_measures in merged_groups.items():
            mg = MeasureGroup(source_name=source_name, measures=group_measures)
            measure_groups.append(mg)
            measure_names = ", ".join(m.name for m in group_measures)
            locality_descs.append(
                f"Pre-aggregate {source_name} ({measure_names}) by dimension keys"
            )

        return (
            True,
            measure_groups,
            f"Chasm trap: {len(merged_groups)} independent measure sources ({', '.join(merged_groups.keys())})",
            locality_descs,
        )

    def _merge_safe_measure_groups(
        self,
        groups: dict[str, list[ResolvedMeasure]],
        dim_sources: set[str],
    ) -> dict[str, list[ResolvedMeasure]]:
        """Merge only row-safe measure groups.

        Alias siblings are kept together to avoid false chasm detection for role-
        based aliases, and pure one_to_one chains can be flattened safely.
        many_to_one chains are intentionally not merged because measures from the
        "one" side are duplicated by the "many" side rows.
        """
        names = list(groups.keys())

        # First pass: merge aliases of the same underlying source.
        # Pick one representative per underlying source.
        alias_groups: dict[str, list[str]] = {}
        for name in names:
            actual = self.graph.alias_map.get(name, name)
            alias_groups.setdefault(actual, []).append(name)

        merged: dict[str, list[ResolvedMeasure]] = {}
        assigned: dict[str, str] = {}  # source_name → merged anchor

        # Merge alias siblings into the first alias name
        for actual, siblings in alias_groups.items():
            anchor = siblings[0]
            merged[anchor] = []
            for sib in siblings:
                merged[anchor].extend(groups[sib])
                assigned[sib] = anchor

        def _edge_is_grain_safe(edge) -> bool:
            if edge.relationship == "one_to_one":
                return True
            if edge.relationship != "many_to_one":
                return False
            actual_source = self.graph.alias_map.get(edge.from_source, edge.from_source)
            source = self.sources.get(actual_source)
            if not source:
                return False
            from_cols = {c.strip() for c in edge.from_column.split(",")}
            grain_cols = {c.strip() for c in source.grain}
            return from_cols == grain_cols

        def _path_is_grain_safe(path) -> bool:
            return bool(path) and all(_edge_is_grain_safe(edge) for edge in path.edges)

        # Second pass: check pairwise one_to_one reachability between merged groups
        merged_names = list(merged.keys())
        final: dict[str, list[ResolvedMeasure]] = {}
        final_assigned: dict[str, str] = {}

        for name in merged_names:
            if name in final_assigned:
                continue
            final[name] = list(merged[name])
            final_assigned[name] = name

            for other in merged_names:
                if other == name or other in final_assigned:
                    continue
                path_fwd = self.graph.find_path(name, other)
                path_rev = self.graph.find_path(other, name)
                if _path_is_grain_safe(path_fwd):
                    final[name].extend(merged[other])
                    final_assigned[other] = name
                elif _path_is_grain_safe(path_rev):
                    final.setdefault(other, []).extend(final.pop(name, []))
                    final[other].extend(merged[other])
                    for k, v in final_assigned.items():
                        if v == name:
                            final_assigned[k] = other
                    final_assigned[name] = other
                    final_assigned[other] = other
                    break

        return final

    def _classify_filter_clause(
        self,
        clause: str,
        measure_names: set[str],
        predefined_refs: set[str],
    ) -> str:
        """Classify a single filter clause as 'where' or 'having'."""
        parsed = self.parser.parse(clause, known_measure_names=measure_names)
        if parsed.is_aggregate or parsed.depends_on_measures:
            return "having"
        if parsed.column_refs & predefined_refs:
            matching_refs = parsed.column_refs & predefined_refs
            all_are_columns = True
            for ref in matching_refs:
                src_name, col_name = ref.split(".", 1)
                src = self.sources.get(src_name)
                if not src or not any(c.name == col_name for c in src.columns):
                    all_are_columns = False
                    break
            return "where" if all_are_columns else "having"
        return "where"

    def _classify_filters(
        self, filters: list[str], measures: list[ResolvedMeasure]
    ) -> tuple[list[str], list[str]]:
        measure_names = {m.name for m in measures}
        where_filters = []
        having_filters = []

        # Build set of qualified pre-defined measure refs (e.g. "orders.revenue")
        predefined_refs: set[str] = set()
        for src in self.sources.values():
            for mdef in src.measures:
                predefined_refs.add(f"{src.name}.{mdef.name}")

        for f in filters:
            if not f or not f.strip():
                continue
            # Split compound AND expressions so each clause is classified independently.
            # e.g. "sum(x) > 100 AND status = 'active'" → HAVING + WHERE
            clauses = self._split_top_level_and(f)
            for clause in clauses:
                kind = self._classify_filter_clause(
                    clause, measure_names, predefined_refs
                )
                if kind == "having":
                    # Validate: if an OR expression mixes aggregate and non-aggregate
                    # sub-expressions, it cannot be split and would produce invalid SQL.
                    self._validate_or_filter_consistency(
                        clause, measure_names, predefined_refs
                    )
                    having_filters.append(clause)
                else:
                    where_filters.append(clause)

        return where_filters, having_filters

    def _validate_or_filter_consistency(
        self,
        clause: str,
        measure_names: set[str],
        predefined_refs: set[str],
    ) -> None:
        """Raise an error if an OR expression mixes WHERE and HAVING conditions."""
        try:
            inner = parse_predicate(clause, self.dialect)
            # Only check if the top level contains OR
            or_parts: list[str] = []

            def _collect_or(node):
                if isinstance(node, exp.Or):
                    _collect_or(node.left)
                    _collect_or(node.right)
                else:
                    or_parts.append(node.sql(dialect=self.dialect))

            _collect_or(inner)
            if len(or_parts) <= 1:
                return
            # Classify each OR branch independently
            kinds = set()
            for part in or_parts:
                kinds.add(
                    self._classify_filter_clause(part, measure_names, predefined_refs)
                )
            if kinds == {"where", "having"}:
                raise ValueError(
                    f"Filter '{clause}' mixes aggregate and non-aggregate conditions "
                    f"with OR, which cannot be split into WHERE and HAVING. "
                    f"Rewrite as separate filters or use a subquery."
                )
        except ValueError:
            raise
        except Exception:
            logger.debug("Failed to validate OR filter consistency for: %s", clause)

    def _split_top_level_and(self, expr: str) -> list[str]:
        """Split a filter expression on top-level AND (not inside parentheses or strings)."""
        try:
            inner = parse_predicate(expr, self.dialect)
            parts: list[str] = []

            def _collect_and(node):
                if isinstance(node, exp.And):
                    _collect_and(node.left)
                    _collect_and(node.right)
                else:
                    parts.append(node.sql(dialect=self.dialect))

            _collect_and(inner)
            if len(parts) > 1:
                return parts
        except Exception:
            logger.debug("Failed to split top-level AND in filter: %s", expr)
        return [expr]

    def _validate_column_refs(
        self,
        measures: list[ResolvedMeasure],
        dimensions: list[QueryDimension],
        filters: list[str],
    ) -> None:
        """Validate that referenced columns exist in their source definitions."""
        # Build separate column and measure name sets per source
        valid_cols: dict[str, set[str]] = {}
        valid_measure_names: dict[str, set[str]] = {}
        for src in self.sources.values():
            valid_cols[src.name] = {c.name for c in src.columns}
            valid_measure_names[src.name] = {m.name for m in src.measures}

        def _check_refs(expr: str, allow_measures: bool) -> None:
            parsed = self.parser.parse(expr)
            for col_ref in parsed.column_refs:
                parts = col_ref.split(".", 1)
                if len(parts) != 2:
                    continue
                source_name, col_name = parts
                resolved = self.graph.alias_map.get(source_name, source_name)
                if resolved not in valid_cols:
                    continue  # unknown source — handled elsewhere
                if allow_measures:
                    all_valid = valid_cols[resolved] | valid_measure_names.get(
                        resolved, set()
                    )
                else:
                    all_valid = valid_cols[resolved]
                if col_name not in all_valid:
                    available = sorted(
                        valid_cols[resolved] | valid_measure_names.get(resolved, set())
                    )
                    raise ValueError(
                        f"Column '{col_name}' does not exist in source '{source_name}'. "
                        f"Available: {', '.join(available)}"
                    )

        # Dimension refs: only columns allowed (not measure names)
        for d in dimensions:
            _check_refs(d.field, allow_measures=False)

        # Measure/filter refs: columns + measure names allowed
        for m in measures:
            if not m.is_derived:
                _check_refs(m.expr, allow_measures=True)
        for f in filters:
            if f and f.strip():
                _check_refs(f, allow_measures=True)

    def _validate_visibility(self, query: SemanticQuery) -> None:
        """Reject queries that reference hidden columns."""
        # Build a set of hidden columns: {source_name: {col_name, ...}}
        hidden: dict[str, set[str]] = {}
        for source in self.sources.values():
            for col in source.columns:
                if col.visibility == ColumnVisibility.HIDDEN:
                    hidden.setdefault(source.name, set()).add(col.name)

        if not hidden:
            return

        # Collect all source.column references from dimensions, measures, filters
        all_exprs: list[str] = []
        for d in query.dimensions:
            if isinstance(d, str):
                all_exprs.append(d)
            elif isinstance(d, dict):
                all_exprs.append(d.get("field", ""))
        for m in query.measures:
            if isinstance(m, str):
                all_exprs.append(m)
            elif isinstance(m, dict):
                all_exprs.append(m.get("expr", ""))
        all_exprs.extend(query.filters)

        for expr in all_exprs:
            parsed = self.parser.parse(expr)
            for col_ref in parsed.column_refs:
                source_name, col_name = col_ref.split(".", 1)
                resolved = self.graph.alias_map.get(source_name, source_name)
                if resolved in hidden and col_name in hidden[resolved]:
                    raise ValueError(
                        f"Column '{source_name}.{col_name}' is hidden and cannot be queried"
                    )

    def _build_columns(
        self,
        measures: list[ResolvedMeasure],
        dimensions: list[QueryDimension],
    ) -> list[ResolvedColumn]:
        from collections import Counter

        columns: list[ResolvedColumn] = []

        leaves = [
            d.field.split(".")[-1] if "." in d.field else d.field for d in dimensions
        ]
        colliding = {leaf for leaf, count in Counter(leaves).items() if count > 1}

        for d in dimensions:
            leaf = d.field.split(".")[-1] if "." in d.field else d.field
            col_name = d.field.replace(".", "_") if leaf in colliding else leaf
            columns.append(
                ResolvedColumn(
                    name=col_name,
                    provenance=Provenance.DIMENSION,
                    expr=d.field,
                    granularity=d.granularity,
                )
            )

        for m in measures:
            columns.append(
                ResolvedColumn(
                    name=m.name,
                    provenance=m.provenance,
                    expr=m.expr,
                    description=getattr(m, "description", None),
                )
            )

        return columns
