from __future__ import annotations

import heapq
import logging
from dataclasses import dataclass, field

from semantic_layer.models import SourceDefinition

# DIALECT CONVENTION:
#   YAML-authored join `on:` clauses may contain dialect-specific casts
#   (e.g. BigQuery `SAFE_CAST(x AS INT64)`). `_parse_on` parses them with
#   `read=self.dialect` so the AST reflects the author's intent.

logger = logging.getLogger(__name__)


RELATIONSHIP_INVERSE = {
    "many_to_one": "one_to_many",
    "one_to_many": "many_to_one",
    "one_to_one": "one_to_one",
}


@dataclass
class JoinEdge:
    from_source: str
    to_source: str
    from_column: str
    to_column: str
    relationship: str
    alias: str | None = None


@dataclass
class JoinPath:
    edges: list[JoinEdge]
    has_one_to_many: bool = False
    is_ambiguous: bool = False

    @property
    def source_names(self) -> list[str]:
        if not self.edges:
            return []
        names = [self.edges[0].from_source]
        for e in self.edges:
            names.append(e.to_source)
        return names


@dataclass
class JoinTree:
    edges: list[JoinEdge] = field(default_factory=list)
    sources: set[str] = field(default_factory=set)
    has_one_to_many: bool = False


class JoinGraph:
    def __init__(
        self,
        sources: dict[str, SourceDefinition],
        *,
        dialect: str = "postgres",
    ):
        self.sources = sources
        self.dialect = dialect
        self.adjacency: dict[str, list[JoinEdge]] = {}

    def build(self) -> None:
        # alias_name → actual source name
        self.alias_map: dict[str, str] = {}

        for name in self.sources:
            self.adjacency.setdefault(name, [])

        for source in self.sources.values():
            for join in source.joins:
                from_col, to_col = self._parse_on(join.on, join.to)
                target_name = join.alias if join.alias else join.to

                if join.alias:
                    self.alias_map[join.alias] = join.to

                # Forward edge: source → alias (or target)
                fwd = JoinEdge(
                    from_source=source.name,
                    to_source=target_name,
                    from_column=from_col,
                    to_column=to_col,
                    relationship=join.relationship,
                    alias=join.alias,
                )
                self.adjacency.setdefault(target_name, [])
                self.adjacency[source.name].append(fwd)

                # Reverse edge: alias (or target) → source
                rev = JoinEdge(
                    from_source=target_name,
                    to_source=source.name,
                    from_column=to_col,
                    to_column=from_col,
                    relationship=RELATIONSHIP_INVERSE[join.relationship],
                    alias=join.alias,
                )
                self.adjacency[target_name].append(rev)

    def find_path(self, from_source: str, to_source: str) -> JoinPath | None:
        """Dijkstra shortest path between two sources.

        Also detects ambiguity: if multiple equal-cost paths exist to the
        destination, the returned ``JoinPath`` has ``is_ambiguous=True``.
        """
        if from_source == to_source:
            return JoinPath(edges=[], has_one_to_many=False)
        if from_source not in self.adjacency or to_source not in self.adjacency:
            return None

        # (cost, counter, current_node, path_edges)
        counter = 0
        heap: list[tuple[int, int, str, list[JoinEdge]]] = [
            (0, counter, from_source, [])
        ]
        visited: set[str] = set()
        first_path: JoinPath | None = None
        first_cost: int | None = None

        while heap:
            cost, _, current, path = heapq.heappop(heap)

            # All equal-cost alternatives exhausted — stop.
            if first_cost is not None and cost > first_cost:
                break

            if current == to_source:
                has_o2m = any(e.relationship == "one_to_many" for e in path)
                if first_path is None:
                    first_path = JoinPath(edges=path, has_one_to_many=has_o2m)
                    first_cost = cost
                    continue  # don't visit dest — keep looking for alternatives
                else:
                    first_path.is_ambiguous = True
                    return first_path

            if current in visited:
                continue
            visited.add(current)

            for edge in self.adjacency.get(current, []):
                if edge.to_source not in visited:
                    counter += 1
                    # Prefer safe (many_to_one / one_to_one) paths over one_to_many
                    edge_cost = (
                        1 if edge.relationship in ("many_to_one", "one_to_one") else 10
                    )
                    heapq.heappush(
                        heap, (cost + edge_cost, counter, edge.to_source, path + [edge])
                    )

        return first_path

    def resolve_join_tree(
        self, source_names: set[str], root: str | None = None
    ) -> JoinTree:
        """
        Steiner tree approximation: pick root source,
        find shortest path to each other source, merge paths.
        """
        if len(source_names) <= 1:
            return JoinTree(sources=source_names)

        if root is not None and root in source_names:
            names = [root] + sorted(source_names - {root})
        else:
            names = sorted(source_names)
        root = names[0]
        tree = JoinTree(sources={root})

        for target in names[1:]:
            if target in tree.sources:
                continue
            path = self.find_path(root, target)
            if path is not None and path.is_ambiguous:
                logger.warning(
                    "Ambiguous join path from '%s' to '%s': multiple equal-cost "
                    "paths exist. The engine picked one arbitrarily. Use join "
                    "aliases to disambiguate.",
                    root,
                    target,
                )
            if path is None:
                raise ValueError(
                    f"No join path from '{root}' to '{target}'. "
                    f"These sources are not connected in the join graph."
                )
            for edge in path.edges:
                if not any(
                    e.from_source == edge.from_source and e.to_source == edge.to_source
                    for e in tree.edges
                ):
                    tree.edges.append(edge)
                    if edge.relationship == "one_to_many":
                        tree.has_one_to_many = True
                tree.sources.add(edge.from_source)
                tree.sources.add(edge.to_source)

        return tree

    def find_components(self) -> list[set[str]]:
        """Partition the graph into connected components.

        Returns one set per component. For an empty graph, returns []. For a
        fully connected graph, returns a single-element list. Used both for
        validation (multi-component → warning) and for suggest().

        Aliases and their base source are treated as belonging to the same
        component, since alias-scoped queries resolve back to the base table.
        """
        # Bidirectional alias↔base adjacency so BFS treats them as one node
        alias_neighbors: dict[str, list[str]] = {}
        for alias, base in self.alias_map.items():
            alias_neighbors.setdefault(alias, []).append(base)
            alias_neighbors.setdefault(base, []).append(alias)

        components: list[set[str]] = []
        unvisited = set(self.adjacency)
        while unvisited:
            start = next(iter(unvisited))
            component: set[str] = set()
            queue = [start]
            while queue:
                node = queue.pop()
                if node in component:
                    continue
                component.add(node)
                for edge in self.adjacency.get(node, []):
                    if edge.to_source not in component:
                        queue.append(edge.to_source)
                for neighbor in alias_neighbors.get(node, []):
                    if neighbor not in component:
                        queue.append(neighbor)
            components.append(component)
            unvisited -= component
        return components

    def _parse_on(self, on_clause: str, target_source: str) -> tuple[str, str]:
        """
        Parse join conditions into (from_columns, to_columns) using sqlglot AST.

        Single key:  "customer_id = customers.id" → ("customer_id", "id")
        Composite:   "a = t.x AND b = t.y"        → ("a,b", "x,y")

        Composite keys are stored as comma-separated strings.
        """
        import sqlglot
        from sqlglot import exp as _exp
        from semantic_layer.parser import quote_reserved_identifiers

        quoted = quote_reserved_identifiers(on_clause, self.dialect)
        tree = sqlglot.parse_one(
            f"SELECT 1 FROM _a JOIN _b ON {quoted}", read=self.dialect
        )

        from_cols: list[str] = []
        to_cols: list[str] = []

        for eq_node in tree.find_all(_exp.EQ):
            left = eq_node.left
            right = eq_node.right

            # Reject nested equality (e.g., "a = b = c")
            if isinstance(left, _exp.EQ) or isinstance(right, _exp.EQ):
                raise ValueError(f"Invalid join condition: '{on_clause}'")

            # Extract column name, stripping any source qualifier
            def _col_name(node: _exp.Expression) -> str:
                if isinstance(node, _exp.Column):
                    return node.name
                return node.sql(dialect="postgres")

            from_cols.append(_col_name(left))
            to_cols.append(_col_name(right))

        if not from_cols:
            raise ValueError(f"Invalid join condition: '{on_clause}'")

        return ",".join(from_cols), ",".join(to_cols)
