"""
dataset_graph.py — Column Relationship Graph Builder
=====================================================

Infers structural and statistical relationships between dataset columns and
exports a graph that the LLM context and lineage UI can consume.

Output contract:
{
  "entities": ["customer", "payment"],      # top-level entity groups
  "nodes": [{id, label, type, properties}],
  "edges": [{source, target, relationship, weight, properties}],
  "summary": "...",
  "top_correlations": [{"cols": "a__b", "pearson": 0.82, "strength": "strong"}],
  "foreign_keys": [{"column": "customer_id", "references_entity": "customer"}]
}

Heuristics used:
  1. Column-prefix grouping  (customer_id, customer_name → "customer" entity)
  2. Known entity patterns   (income, salary, price → "financial" entity)
  3. Pearson / Cramér's V    (correlations become "correlates_with" edges)
  4. FK pattern detection    (col ending in _id, _key, _ref → FK edge)
  5. PII column flagging      (integrates pii_detector output)
"""

from __future__ import annotations

import json
import os
import re
import sys
from dataclasses import dataclass, field, asdict
from typing import Any, Dict, List, Optional, Set

try:
    import pandas as pd  # type: ignore
except ImportError:
    pd = None  # type: ignore


# ─────────────────────────────────────────────────────────────────────────────
# Data structures
# ─────────────────────────────────────────────────────────────────────────────

@dataclass
class GraphNode:
    id:         str
    label:      str
    type:       str          # "dataset" | "entity" | "attribute"
    properties: Dict[str, Any] = field(default_factory=dict)


@dataclass
class GraphEdge:
    source:       str
    target:       str
    relationship: str        # "has_attribute" | "correlates_with" | "references" | "associated_with"
    weight:       float = 1.0
    properties:   Dict[str, Any] = field(default_factory=dict)


@dataclass
class DatasetGraph:
    nodes:            List[Dict[str, Any]] = field(default_factory=list)
    edges:            List[Dict[str, Any]] = field(default_factory=list)
    entities:         List[str]            = field(default_factory=list)
    top_correlations: List[Dict[str, Any]] = field(default_factory=list)
    foreign_keys:     List[Dict[str, Any]] = field(default_factory=list)
    summary:          str                  = ""

    def to_dict(self) -> Dict[str, Any]:
        return asdict(self)

    def to_json(self, indent: int = 2) -> str:
        return json.dumps(self.to_dict(), ensure_ascii=False, indent=indent, default=str)


# ─────────────────────────────────────────────────────────────────────────────
# Builder
# ─────────────────────────────────────────────────────────────────────────────

class DatasetGraphBuilder:
    """
    Build a column-relationship graph from a baseline artifact and optional
    PII detector result.

    The resulting graph is consumed by:
      - The LLM context builder (summary + top correlations)
      - The Security tab Knowledge Graph section
      - The Lineage tab
    """

    # Known semantic entity groupings inferred from column keywords
    ENTITY_KEYWORDS: Dict[str, List[str]] = {
        "customer":  ["customer", "client", "buyer", "user", "consumer"],
        "employee":  ["employee", "staff", "worker", "personnel"],
        "product":   ["product", "item", "sku", "goods", "catalog"],
        "order":     ["order", "purchase", "transaction", "cart"],
        "payment":   ["payment", "billing", "invoice", "charge", "amount", "fee"],
        "address":   ["address", "street", "city", "state", "zip", "postal", "country"],
        "datetime":  ["date", "time", "timestamp", "created", "updated", "modified"],
        "financial": ["salary", "income", "revenue", "price", "cost", "total", "balance"],
        "identity":  ["id", "uuid", "key", "code", "ref", "number"],
        "status":    ["status", "state", "flag", "active", "enabled"],
    }

    # FK pattern: column ends in _id, _key, _ref, _fk, _code
    FK_RE = re.compile(r'^(.+?)[-_](?:id|key|ref|fk|code)$', re.IGNORECASE)

    def build(
        self,
        baseline: Dict[str, Any],
        pii_result: Optional[Dict[str, Any]] = None,
        source_path: str = "",
    ) -> DatasetGraph:
        graph = DatasetGraph()
        cols_meta = baseline.get("columns", {})
        correlations = baseline.get("correlations", {})
        meta = baseline.get("meta", {})

        num_cols = list(cols_meta.get("numeric", {}).keys())
        cat_cols = list(cols_meta.get("categorical", {}).keys())
        all_cols = num_cols + cat_cols
        pii_cols: Set[str] = set((pii_result or {}).get("pii_columns", []))

        if not all_cols:
            graph.summary = "No columns found in baseline."
            return graph

        # ── Dataset root node ─────────────────────────────────────────────
        ds_label = os.path.basename(source_path) if source_path else "Dataset"
        graph.nodes.append(asdict(GraphNode(
            id="dataset", label=ds_label, type="dataset",
            properties={
                "row_count":    meta.get("row_count"),
                "column_count": meta.get("column_count"),
                "fingerprint":  meta.get("dataset_fingerprint", "")[:12],
            }
        )))

        # ── Entity extraction ─────────────────────────────────────────────
        entities = self._extract_entities(all_cols)

        for entity_name, e_cols in entities.items():
            graph.nodes.append(asdict(GraphNode(
                id=f"entity_{entity_name}", label=entity_name.replace("_", " ").title(),
                type="entity",
                properties={"column_count": len(e_cols)},
            )))
            graph.entities.append(entity_name)
            graph.edges.append(asdict(GraphEdge(
                source="dataset", target=f"entity_{entity_name}",
                relationship="contains",
            )))

            for col in e_cols:
                graph.nodes.append(self._attr_node(col, num_cols, cat_cols, cols_meta, pii_cols))
                graph.edges.append(asdict(GraphEdge(
                    source=f"entity_{entity_name}", target=f"attr_{col}",
                    relationship="has_attribute",
                )))

        # ── Unassigned columns → direct dataset attrs ─────────────────────
        assigned: Set[str] = {c for cols in entities.values() for c in cols}
        for col in all_cols:
            if col not in assigned:
                graph.nodes.append(self._attr_node(col, num_cols, cat_cols, cols_meta, pii_cols))
                graph.edges.append(asdict(GraphEdge(
                    source="dataset", target=f"attr_{col}",
                    relationship="has_attribute",
                )))

        # ── Pearson correlation edges ─────────────────────────────────────
        pearson = correlations.get("numeric_pearson", {})
        top_corr: List[Dict[str, Any]] = []
        for key, value in pearson.items():
            if abs(value) < 0.25:   # Skip very weak correlations
                continue
            parts = key.split("__", 1)
            if len(parts) != 2:
                continue
            a, b = parts
            strength = (
                "very_strong" if abs(value) >= 0.9 else
                "strong"      if abs(value) >= 0.7 else
                "moderate"    if abs(value) >= 0.4 else "weak"
            )
            graph.edges.append(asdict(GraphEdge(
                source=f"attr_{a}", target=f"attr_{b}",
                relationship="correlates_with",
                weight=round(abs(value), 3),
                properties={"pearson": round(value, 3), "strength": strength},
            )))
            top_corr.append({"cols": key, "pearson": round(value, 3), "strength": strength})

        top_corr.sort(key=lambda x: -abs(x["pearson"]))
        graph.top_correlations = top_corr[:10]

        # ── Cramér's V edges (categorical association) ────────────────────
        cramers = correlations.get("categorical_cramers_v", {})
        for key, value in cramers.items():
            if abs(value) < 0.2:
                continue
            parts = key.split("__", 1)
            if len(parts) != 2:
                continue
            a, b = parts
            graph.edges.append(asdict(GraphEdge(
                source=f"attr_{a}", target=f"attr_{b}",
                relationship="associated_with",
                weight=round(abs(value), 3),
                properties={"cramers_v": round(value, 3)},
            )))

        # ── FK pattern edges ──────────────────────────────────────────────
        fks: List[Dict[str, Any]] = []
        for col in all_cols:
            m = self.FK_RE.match(col)
            if m:
                ref_entity_stem = m.group(1).lower()
                for entity_name in entities:
                    if ref_entity_stem in entity_name or entity_name in ref_entity_stem:
                        graph.edges.append(asdict(GraphEdge(
                            source=f"attr_{col}", target=f"entity_{entity_name}",
                            relationship="references",
                            properties={"type": "foreign_key"},
                        )))
                        fks.append({"column": col, "references_entity": entity_name})
                        break
        graph.foreign_keys = fks

        # ── PII overlay edges ─────────────────────────────────────────────
        pii_node_added = False
        for col in pii_cols:
            if not pii_node_added:
                graph.nodes.append(asdict(GraphNode(
                    id="pii_concern", label="PII Concern", type="entity",
                    properties={"description": "Columns containing personally identifiable information"},
                )))
                graph.edges.append(asdict(GraphEdge(
                    source="dataset", target="pii_concern",
                    relationship="contains",
                    properties={"type": "governance"},
                )))
                pii_node_added = True
            graph.edges.append(asdict(GraphEdge(
                source=f"attr_{col}", target="pii_concern",
                relationship="flagged_as",
                properties={"type": "pii"},
            )))

        # ── Summary ───────────────────────────────────────────────────────
        n_n, n_e = len(graph.nodes), len(graph.edges)
        n_ent = len(graph.entities)
        graph.summary = (
            f"{n_n} nodes, {n_e} edges, {n_ent} entity group(s) from {len(all_cols)} columns. "
            f"{len(pearson)} Pearson pairs, {len(fks)} FK reference(s). "
            f"{len(pii_cols)} PII column(s) flagged."
        )

        return graph

    # ------------------------------------------------------------------
    # Helpers
    # ------------------------------------------------------------------

    def _attr_node(
        self,
        col: str,
        num_cols: List[str],
        cat_cols: List[str],
        cols_meta: Dict[str, Any],
        pii_cols: Set[str],
    ) -> Dict[str, Any]:
        is_num = col in num_cols
        section = "numeric" if is_num else "categorical"
        col_data = cols_meta.get(section, {}).get(col) or {}
        return asdict(GraphNode(
            id=f"attr_{col}", label=col, type="attribute",
            properties={
                "data_type":   "numeric" if is_num else "categorical",
                "null_ratio":  col_data.get("null_ratio", 0),
                "unique_count": col_data.get("unique_count"),
                "is_pii":      col in pii_cols,
            },
        ))

    def _extract_entities(self, columns: List[str]) -> Dict[str, List[str]]:
        entities: Dict[str, List[str]] = {}
        assigned: Set[str] = set()

        # Pass 1: shared column prefix (2+ columns with same prefix → entity)
        prefix_groups: Dict[str, List[str]] = {}
        skip_prefixes = {"is", "has", "num", "n", "total", "avg", "min", "max", "the"}
        for col in columns:
            parts = re.split(r'[-_.\s]', col.lower())
            if len(parts) >= 2 and parts[0] not in skip_prefixes:
                prefix_groups.setdefault(parts[0], []).append(col)

        for prefix, cols in prefix_groups.items():
            if len(cols) >= 2:
                entities[prefix] = cols
                assigned.update(cols)

        # Pass 2: keyword-to-entity matching for unassigned columns
        for col in columns:
            if col in assigned:
                continue
            col_lower = col.lower().replace(" ", "_").replace("-", "_")
            for entity, kws in self.ENTITY_KEYWORDS.items():
                if any(kw in col_lower for kw in kws):
                    entities.setdefault(entity, []).append(col)
                    assigned.add(col)
                    break

        return entities


# ─────────────────────────────────────────────────────────────────────────────
# CLI
# ─────────────────────────────────────────────────────────────────────────────

def main(argv=None):
    import argparse
    p = argparse.ArgumentParser(description="Dataset Graph Builder")
    p.add_argument("--baseline",   required=True, help="Path to baseline JSON")
    p.add_argument("--pii",        default=None,  help="Path to pii_detector output JSON")
    p.add_argument("--source",     default="",    help="Original dataset path (for display)")
    p.add_argument("--output",     default=None,  help="Output graph JSON path")
    args = p.parse_args(argv)

    with open(args.baseline, encoding="utf-8") as f:
        baseline = json.load(f)

    pii_result = None
    if args.pii and os.path.exists(args.pii):
        with open(args.pii, encoding="utf-8") as f:
            pii_result = json.load(f)

    builder = DatasetGraphBuilder()
    graph   = builder.build(baseline, pii_result=pii_result, source_path=args.source)

    out_json = graph.to_json()
    if args.output:
        with open(args.output, "w", encoding="utf-8") as f:
            f.write(out_json)
        print(f"[dataset_graph] Graph saved to {args.output}", file=sys.stderr)
    else:
        print(out_json)

    return 0


if __name__ == "__main__":
    sys.exit(main())
