"""
lineage.py — Data Lineage Tracker
==================================

Tracks the flow of data through the pipeline:
    
    source.csv
      ↓ parse.py (parsed)
      ↓ baseline.py (profiled)
      ↓ generator.py (generated synthetic)
      ↓ leakage_bridge.py (analyzed)
      ↓ data_scanner.py (scanned)
      ↓ anonymizer.py (anonymized)

Each step records:
    - Input hash
    - Output hash
    - Timestamp
    - Parameters used
    - Status

Provides full traceability for audit compliance.
"""

from __future__ import annotations
import json, os, sys, hashlib, time
from typing import Any, Dict, List, Optional
from dataclasses import dataclass, field, asdict
from datetime import datetime


@dataclass
class LineageStep:
    step_name: str
    action: str             # "parse", "profile", "generate", "analyze", "scan", "anonymize"
    timestamp: str
    input_hash: str
    output_hash: str
    parameters: Dict[str, Any] = field(default_factory=dict)
    status: str = "success"     # "success", "failed", "skipped"
    duration_ms: float = 0
    notes: str = ""


@dataclass
class LineageRecord:
    dataset_id: str
    source_path: str
    created_at: str
    steps: List[Dict[str, Any]] = field(default_factory=list)
    current_hash: str = ""
    total_transformations: int = 0

    def to_dict(self) -> Dict[str, Any]:
        return asdict(self)

    def to_json(self, indent: int = 2) -> str:
        return json.dumps(self.to_dict(), ensure_ascii=False, indent=indent, default=str)


class LineageTracker:
    """
    Track data lineage through the pipeline.
    
    Usage:
        tracker = LineageTracker("dataset.csv")
        tracker.record_step("parse", input_hash, output_hash, params, duration)
        tracker.record_step("baseline", ...)
        tracker.save("lineage.json")
    """

    def __init__(self, source_path: str, dataset_id: Optional[str] = None):
        self.source_path = source_path
        self.dataset_id = dataset_id or self._compute_id(source_path)
        self.record = LineageRecord(
            dataset_id=self.dataset_id,
            source_path=source_path,
            created_at=datetime.utcnow().isoformat() + "Z"
        )

    def record_step(
        self,
        step_name: str,
        action: str,
        input_hash: str,
        output_hash: str,
        parameters: Optional[Dict[str, Any]] = None,
        duration_ms: float = 0,
        status: str = "success",
        notes: str = ""
    ):
        """Record a pipeline step."""
        step = LineageStep(
            step_name=step_name,
            action=action,
            timestamp=datetime.utcnow().isoformat() + "Z",
            input_hash=input_hash,
            output_hash=output_hash,
            parameters=parameters or {},
            status=status,
            duration_ms=round(duration_ms, 2),
            notes=notes
        )
        self.record.steps.append(asdict(step))
        self.record.current_hash = output_hash
        self.record.total_transformations = len(self.record.steps)

    def get_lineage(self) -> LineageRecord:
        """Get the current lineage record."""
        return self.record

    def save(self, path: str):
        """Save lineage record to JSON file."""
        with open(path, "w", encoding="utf-8") as f:
            f.write(self.record.to_json())

    def load(self, path: str):
        """Load existing lineage record from JSON file."""
        if os.path.exists(path):
            with open(path, "r", encoding="utf-8") as f:
                data = json.load(f)
            self.record = LineageRecord(
                dataset_id=data.get("dataset_id", self.dataset_id),
                source_path=data.get("source_path", self.source_path),
                created_at=data.get("created_at", ""),
                steps=data.get("steps", []),
                current_hash=data.get("current_hash", ""),
                total_transformations=data.get("total_transformations", 0)
            )

    @staticmethod
    def _compute_id(source_path: str) -> str:
        """Compute a dataset ID from the source path."""
        return hashlib.sha256(source_path.encode()).hexdigest()[:16]

    @staticmethod
    def hash_data(data: Any) -> str:
        """Compute a hash of arbitrary data."""
        if isinstance(data, str):
            return hashlib.sha256(data.encode()).hexdigest()[:16]
        return hashlib.sha256(json.dumps(data, sort_keys=True, default=str).encode()).hexdigest()[:16]


# Pipeline convenience wrapper
def build_lineage_from_artifacts(
    source_path: str,
    ast: Optional[Dict] = None,
    baseline: Optional[Dict] = None,
    result: Optional[Dict] = None,
    leakage: Optional[Dict] = None,
    scan_report: Optional[Dict] = None,
) -> LineageRecord:
    """
    Build lineage record from existing pipeline artifacts.
    """
    tracker = LineageTracker(source_path)
    hash_fn = LineageTracker.hash_data

    if ast:
        tracker.record_step(
            "Parse", "parse",
            input_hash=hash_fn(source_path),
            output_hash=hash_fn(ast),
            parameters={"kind": ast.get("kind"), "sample_rows": ast.get("sample_rows")},
            notes=f"Parsed {ast.get('dataset', {}).get('schema', {}).get('fields', [{}]).__len__()} columns"
        )

    if baseline:
        tracker.record_step(
            "Baseline", "profile",
            input_hash=hash_fn(ast) if ast else "",
            output_hash=hash_fn(baseline),
            parameters={"row_count": baseline.get("meta", {}).get("row_count")},
            notes=f"Profiled {baseline.get('meta', {}).get('column_count', '?')} columns"
        )

    if result:
        tracker.record_step(
            "Generate", "generate",
            input_hash=hash_fn(baseline) if baseline else "",
            output_hash=hash_fn(result),
            parameters={"generator": result.get("generator_used"), "row_count": result.get("row_count")},
            notes=f"Generated {result.get('row_count', '?')} synthetic rows"
        )

    if leakage:
        tracker.record_step(
            "Leakage Analysis", "analyze",
            input_hash=hash_fn(result) if result else "",
            output_hash=hash_fn(leakage),
            parameters={"mode": leakage.get("_mode")},
            notes=f"Risk: {leakage.get('risk_level', 'unknown')}, Privacy: {leakage.get('privacy_score', '?')}"
        )

    if scan_report:
        tracker.record_step(
            "PII Scan", "scan",
            input_hash=hash_fn(leakage) if leakage else "",
            output_hash=hash_fn(scan_report),
            notes=scan_report.get("summary", "")
        )

    return tracker.get_lineage()


# ============================================================
# CLI
# ============================================================

def main(argv=None):
    import argparse
    p = argparse.ArgumentParser(description="Data Lineage Tracker")
    p.add_argument("--source", required=True, help="Source dataset path")
    p.add_argument("--ast", default=None)
    p.add_argument("--baseline", default=None)
    p.add_argument("--result", default=None)
    p.add_argument("--leakage", default=None)
    p.add_argument("--output", default=None)
    args = p.parse_args(argv)

    def load_json(path):
        if not path or not os.path.exists(path):
            return None
        with open(path, "r", encoding="utf-8") as f:
            return json.load(f)

    record = build_lineage_from_artifacts(
        source_path=args.source,
        ast=load_json(args.ast),
        baseline=load_json(args.baseline),
        result=load_json(args.result),
        leakage=load_json(args.leakage),
    )

    if args.output:
        with open(args.output, "w", encoding="utf-8") as f:
            f.write(record.to_json())
    else:
        print(record.to_json())

    return 0


if __name__ == "__main__":
    sys.exit(main())
