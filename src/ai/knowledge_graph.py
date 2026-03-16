"""
knowledge_graph.py — Dataset Knowledge Graph Builder
=====================================================

Builds a graph structure from dataset schema and relationships:
    Customer
     ├ Orders
     ├ Payments
     └ Address

Implementation:
    - Entity extraction from column names and data patterns
    - Relationship inference from naming conventions and correlations
    - Graph visualization data structure

Output: dataset_graph.json
"""

from __future__ import annotations
import json, os, re, sys, hashlib
from typing import Any, Dict, List, Optional, Set, Tuple
from dataclasses import dataclass, field, asdict

try:
    import pandas as pd
except ImportError:
    pd = None


@dataclass
class GraphNode:
    id: str
    label: str
    type: str           # "entity", "attribute", "metric"
    properties: Dict[str, Any] = field(default_factory=dict)


@dataclass
class GraphEdge:
    source: str
    target: str
    relationship: str   # "has_attribute", "references", "correlates_with", "derived_from"
    weight: float = 1.0
    properties: Dict[str, Any] = field(default_factory=dict)


@dataclass
class DatasetGraph:
    nodes: List[Dict[str, Any]] = field(default_factory=list)
    edges: List[Dict[str, Any]] = field(default_factory=list)
    entities: List[str] = field(default_factory=list)
    summary: str = ""

    def to_dict(self) -> Dict[str, Any]:
        return asdict(self)

    def to_json(self, indent: int = 2) -> str:
        return json.dumps(self.to_dict(), ensure_ascii=False, indent=indent, default=str)


class KnowledgeGraphBuilder:
    """
    Build a knowledge graph from dataset schema, baseline, and correlations.
    
    The graph captures:
    - Entities (inferred from column naming patterns)
    - Attributes (columns belonging to entities)
    - Relationships (foreign key patterns, correlations, associations)
    """

    # Common entity suffixes for detection
    ENTITY_PATTERNS = {
        "customer": ["customer", "client", "buyer", "user"],
        "order": ["order", "purchase", "transaction"],
        "product": ["product", "item", "sku", "goods"],
        "payment": ["payment", "billing", "invoice", "charge"],
        "address": ["address", "location", "geo", "city", "state", "zip"],
        "employee": ["employee", "staff", "worker"],
        "account": ["account", "acct"],
        "date": ["date", "time", "timestamp", "created", "updated"],
        "price": ["price", "cost", "amount", "total", "fee", "salary", "income"],
        "category": ["category", "type", "class", "group", "segment"],
        "status": ["status", "state", "flag", "active"],
        "identifier": ["id", "key", "code", "number", "no", "num"],
    }

    # FK pattern: column ending in _id or _key
    FK_REGEX = re.compile(r'^(.+?)[-_](?:id|key|code|ref|fk)$', re.IGNORECASE)

    def __init__(self):
        pass

    def build_from_baseline(self, baseline: Dict[str, Any], ast: Optional[Dict[str, Any]] = None) -> DatasetGraph:
        """
        Build knowledge graph from baseline artifact and optional parse AST.
        """
        graph = DatasetGraph()
        columns = baseline.get("columns", {})
        correlations = baseline.get("correlations", {})
        meta = baseline.get("meta", {})

        num_cols = list(columns.get("numeric", {}).keys())
        cat_cols = list(columns.get("categorical", {}).keys())
        all_cols = num_cols + cat_cols

        if not all_cols:
            graph.summary = "No columns found in baseline."
            return graph

        # Step 1: Extract entities from column names
        entities = self._extract_entities(all_cols)
        
        # Add dataset root node
        ds_node = GraphNode(
            id="dataset", label=meta.get("dataset_source", "Dataset"),
            type="entity",
            properties={
                "row_count": meta.get("row_count"),
                "column_count": meta.get("column_count")
            }
        )
        graph.nodes.append(asdict(ds_node))

        # Step 2: Create entity nodes
        for entity_name, entity_cols in entities.items():
            entity_node = GraphNode(
                id=f"entity_{entity_name}", label=entity_name.title(),
                type="entity",
                properties={"column_count": len(entity_cols)}
            )
            graph.nodes.append(asdict(entity_node))
            graph.entities.append(entity_name)

            # Edge: dataset -> entity
            graph.edges.append(asdict(GraphEdge(
                source="dataset", target=f"entity_{entity_name}",
                relationship="contains"
            )))

            # Step 3: Create attribute nodes for each entity
            for col in entity_cols:
                is_num = col in num_cols
                col_data = columns.get("numeric", {}).get(col) or columns.get("categorical", {}).get(col) or {}
                
                attr_node = GraphNode(
                    id=f"attr_{col}", label=col,
                    type="attribute",
                    properties={
                        "data_type": "numeric" if is_num else "categorical",
                        "null_ratio": col_data.get("null_ratio", 0),
                        "unique_count": col_data.get("unique_count"),
                    }
                )
                graph.nodes.append(asdict(attr_node))

                # Edge: entity -> attribute
                graph.edges.append(asdict(GraphEdge(
                    source=f"entity_{entity_name}", target=f"attr_{col}",
                    relationship="has_attribute"
                )))

        # Step 4: Add columns not assigned to any entity
        assigned = set()
        for cols in entities.values():
            assigned.update(cols)
        unassigned = [c for c in all_cols if c not in assigned]
        
        if unassigned:
            for col in unassigned:
                is_num = col in num_cols
                col_data = columns.get("numeric", {}).get(col) or columns.get("categorical", {}).get(col) or {}
                
                attr_node = GraphNode(
                    id=f"attr_{col}", label=col,
                    type="attribute",
                    properties={
                        "data_type": "numeric" if is_num else "categorical",
                        "null_ratio": col_data.get("null_ratio", 0),
                        "unique_count": col_data.get("unique_count"),
                    }
                )
                graph.nodes.append(asdict(attr_node))
                graph.edges.append(asdict(GraphEdge(
                    source="dataset", target=f"attr_{col}",
                    relationship="has_attribute"
                )))

        # Step 5: Add correlation edges
        pearson = correlations.get("numeric_pearson", {})
        for key, value in pearson.items():
            if abs(value) < 0.3:
                continue
            parts = key.split("__", 1)
            if len(parts) == 2:
                a, b = parts
                strength = "strong" if abs(value) > 0.7 else "moderate"
                graph.edges.append(asdict(GraphEdge(
                    source=f"attr_{a}", target=f"attr_{b}",
                    relationship="correlates_with",
                    weight=round(abs(value), 3),
                    properties={"pearson": round(value, 3), "strength": strength}
                )))

        # Add Cramér's V edges
        cramers = correlations.get("categorical_cramers_v", {})
        for key, value in cramers.items():
            if abs(value) < 0.2:
                continue
            parts = key.split("__", 1)
            if len(parts) == 2:
                a, b = parts
                graph.edges.append(asdict(GraphEdge(
                    source=f"attr_{a}", target=f"attr_{b}",
                    relationship="associated_with",
                    weight=round(abs(value), 3),
                    properties={"cramers_v": round(value, 3)}
                )))

        # Step 6: Detect FK-like references between entities
        for col in all_cols:
            fk_match = self.FK_REGEX.match(col)
            if fk_match:
                ref_entity = fk_match.group(1).lower()
                for entity_name in entities:
                    if ref_entity in entity_name or entity_name in ref_entity:
                        graph.edges.append(asdict(GraphEdge(
                            source=f"attr_{col}", target=f"entity_{entity_name}",
                            relationship="references",
                            properties={"type": "foreign_key"}
                        )))

        graph.summary = (
            f"Knowledge graph: {len(graph.nodes)} nodes, {len(graph.edges)} edges, "
            f"{len(graph.entities)} entities detected from {len(all_cols)} columns."
        )

        return graph

    def _extract_entities(self, columns: List[str]) -> Dict[str, List[str]]:
        """
        Group columns into entities based on naming patterns.
        e.g., customer_name, customer_id → customer entity
        """
        entities: Dict[str, List[str]] = {}
        assigned: Set[str] = set()

        # First pass: look for column prefixes
        prefix_groups: Dict[str, List[str]] = {}
        for col in columns:
            parts = re.split(r'[-_\s.]', col.lower())
            if len(parts) >= 2:
                prefix = parts[0]
                if prefix not in prefix_groups:
                    prefix_groups[prefix] = []
                prefix_groups[prefix].append(col)

        # Only keep prefixes with 2+ columns
        for prefix, cols in prefix_groups.items():
            if len(cols) >= 2 and prefix not in ("is", "has", "num", "n", "total", "avg", "min", "max"):
                entities[prefix] = cols
                assigned.update(cols)

        # Second pass: match against known entity patterns
        for col in columns:
            if col in assigned:
                continue
            col_lower = col.lower().replace(" ", "_")
            for entity, patterns in self.ENTITY_PATTERNS.items():
                if any(p in col_lower for p in patterns):
                    if entity not in entities:
                        entities[entity] = []
                    entities[entity].append(col)
                    assigned.add(col)
                    break

        return entities


# ============================================================
# CLI
# ============================================================

def main(argv=None):
    import argparse
    p = argparse.ArgumentParser(description="Knowledge Graph Builder")
    p.add_argument("--baseline", required=True, help="Path to baseline JSON")
    p.add_argument("--output", default=None, help="Output graph JSON path")
    args = p.parse_args(argv)

    with open(args.baseline, "r", encoding="utf-8") as f:
        baseline = json.load(f)

    builder = KnowledgeGraphBuilder()
    graph = builder.build_from_baseline(baseline)

    if args.output:
        with open(args.output, "w", encoding="utf-8") as f:
            f.write(graph.to_json())
    else:
        print(graph.to_json())

    return 0


if __name__ == "__main__":
    sys.exit(main())
