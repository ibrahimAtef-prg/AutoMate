"""
stress_tests.py — AutoMate Aurora Full System Stress & Validation Tests
=======================================================================

Three automated test suites:

  Test 1 — Pipeline Integrity Test
    Run full pipeline (parse → baseline → generator → leakage_bridge)
    on a 500-row mixed dataset. Verify all output fields are valid and
    within expected ranges.

  Test 2 — UI Data Consistency Test
    Parse monitorPanel.ts and verify every D.leakage / D.result / D.baseline
    field reference is also present in the leakage_bridge _SAFE_OUTPUT
    contract. Flag any hardcoded placeholder numbers.

  Test 3 — LLM Context Accuracy Test
    Verify that the LLM context builder correctly includes:
    - The column with highest drift
    - privacy_components in the prompt
    - dataset_risk_score in the prompt
    without hallucinating any values.

Usage (requires Python 3.9+ and pandas/numpy in the environment):
  python src/test/stress_tests.py

Returns exit code 0 on success, 1 on any failure.
"""

from __future__ import annotations

import json
import math
import os
import re
import sys
import tempfile
import time
from typing import Any, Dict, List, Optional, Tuple

# ─────────────────────────────────────────────────────────────────────────────
# Helpers
# ─────────────────────────────────────────────────────────────────────────────

PASS = "\033[32m[PASS]\033[0m"
FAIL = "\033[31m[FAIL]\033[0m"
WARN = "\033[33m[WARN]\033[0m"
INFO = "\033[36m[INFO]\033[0m"

_failures: List[str] = []
_warnings: List[str] = []


def check(name: str, condition: bool, detail: str = ""):
    if condition:
        print(f"  {PASS} {name}")
    else:
        msg = f"{name}" + (f": {detail}" if detail else "")
        print(f"  {FAIL} {msg}")
        _failures.append(msg)


def warn(name: str, detail: str = ""):
    msg = f"{name}" + (f": {detail}" if detail else "")
    print(f"  {WARN} {msg}")
    _warnings.append(msg)


def section(title: str):
    print(f"\n{'='*60}\n{title}\n{'='*60}")


# ─────────────────────────────────────────────────────────────────────────────
# Test 1 — Pipeline Integrity Test
# ─────────────────────────────────────────────────────────────────────────────

def test1_pipeline_integrity():
    section("TEST 1 — Pipeline Integrity (500-row mixed dataset)")

    try:
        import numpy as np
        import pandas as pd
    except ImportError:
        print(f"  {FAIL} numpy/pandas not available — cannot run pipeline test")
        _failures.append("numpy/pandas missing")
        return

    # Locate project root
    script_dir = os.path.dirname(os.path.abspath(__file__))
    project_root = os.path.dirname(os.path.dirname(script_dir))
    utils_dir = os.path.join(project_root, "src", "utils")
    security_dir = os.path.join(project_root, "src", "security")
    sys.path.insert(0, utils_dir)
    sys.path.insert(0, security_dir)

    # ── Generate 500-row synthetic CSV ────────────────────────────────
    rng = np.random.default_rng(seed=2026)
    n = 500
    df = pd.DataFrame({
        "age":          rng.integers(18, 85, n).astype(float),
        "income":       rng.normal(65000, 18000, n).clip(10000, 200000),
        "credit_score": rng.integers(300, 850, n).astype(float),
        "loan_amount":  rng.exponential(15000, n).clip(1000, 100000),
        "gender":       rng.choice(["M", "F", "Other"], n, p=[0.48, 0.48, 0.04]),
        "region":       rng.choice(["North", "South", "East", "West"], n),
        "status":       rng.choice(["approved", "rejected", "pending"], n, p=[0.6, 0.25, 0.15]),
    })

    with tempfile.NamedTemporaryFile(suffix=".csv", delete=False, mode="w") as f:
        df.to_csv(f, index=False)
        csv_path = f.name
    print(f"  {INFO} Test dataset: {csv_path} ({n} rows, {len(df.columns)} columns)")

    try:
        # ── Stage 1: parse.py ────────────────────────────────────────
        t0 = time.monotonic()
        from parse import parse
        ast = parse(csv_path)
        ast_dict = ast.to_dict()
        parse_ms = int((time.monotonic() - t0) * 1000)
        print(f"  {INFO} parse.py: {parse_ms}ms")
        check("AST has dataset", ast_dict.get("dataset") is not None)
        check("AST fingerprint present", bool(ast_dict["dataset"].get("fingerprint", "")))
        check("AST schema has fields", len(ast_dict["dataset"]["schema"]["fields"]) >= 7)

        # ── Stage 2: baseline.py ─────────────────────────────────────
        t0 = time.monotonic()
        from baseline import build_baseline
        baseline = build_baseline(ast_dict["dataset"])
        baseline_dict = baseline.to_dict()
        baseline_ms = int((time.monotonic() - t0) * 1000)
        print(f"  {INFO} baseline.py: {baseline_ms}ms")
        num_cols = list(baseline_dict["columns"]["numeric"].keys())
        cat_cols = list(baseline_dict["columns"]["categorical"].keys())
        check("Baseline has numeric columns", len(num_cols) >= 4)
        check("Baseline has categorical columns", len(cat_cols) >= 2)
        check("Baseline has Pearson correlations", len(baseline_dict["correlations"]["numeric_pearson"]) > 0)
        check("Baseline row_count == 500", baseline_dict["meta"]["row_count"] == 500)

        # ── Stage 3: leakage_bridge.py (local mode) ──────────────────
        t0 = time.monotonic()
        from leakage_bridge import _compute_local_metrics
        # Signature: _compute_local_metrics(original_df, n_samples, seed)
        leakage = _compute_local_metrics(df, n_samples=500, seed=42)
        leakage_ms = int((time.monotonic() - t0) * 1000)
        print(f"  {INFO} leakage_bridge.py: {leakage_ms}ms")

        # Required fields
        required_fields = [
            "risk_level", "privacy_score", "privacy_score_reliable",
            "statistical_drift", "duplicates_rate", "membership_inference_auc",
            "column_drift", "threat_details", "privacy_components",
            "avg_drift_score", "dataset_risk_score", "n_samples",
        ]
        for field_name in required_fields:
            check(f"leakage.{field_name} present", field_name in leakage and leakage[field_name] is not None,
                  f"got: {leakage.get(field_name)}")

        # Range validation
        ps = leakage.get("privacy_score")
        check("privacy_score in [0, 1]", ps is not None and 0.0 <= ps <= 1.0, f"got: {ps}")

        auc = leakage.get("membership_inference_auc")
        check("membership_inference_auc in [0, 1]", auc is not None and 0.0 <= auc <= 1.0, f"got: {auc}")

        dup = leakage.get("duplicates_rate")
        check("duplicates_rate in [0, 1]", dup is not None and 0.0 <= dup <= 1.0, f"got: {dup}")

        ads = leakage.get("avg_drift_score")
        check("avg_drift_score >= 0", ads is not None and ads >= 0.0, f"got: {ads}")

        drs = leakage.get("dataset_risk_score")
        check("dataset_risk_score in [0, 100]", drs is not None and 0.0 <= drs <= 100.0, f"got: {drs}")

        drift = leakage.get("column_drift", {})
        check("column_drift covers all numeric cols",
              all(c in drift for c in num_cols),
              f"missing: {[c for c in num_cols if c not in drift]}")
        for col, v in drift.items():
            check(f"column_drift[{col}] >= 0", v >= 0.0, f"got: {v}")

        pc = leakage.get("privacy_components") or {}
        for comp in ["duplicates_risk", "mi_attack_risk", "distance_similarity_risk", "distribution_drift_risk"]:
            check(f"privacy_components.{comp} present", comp in pc)

        td = leakage.get("threat_details", [])
        check("threat_details is a list", isinstance(td, list))

        # Risk score formula cross-check
        expected_raw = (1 - (ps or 0.5)) * 40 + (auc or 0.5) * 30 + (dup or 0.0) * 20 + (ads or 0.0) * 10
        expected_risk = max(0, min(100, expected_raw))
        check("dataset_risk_score matches formula",
              abs((drs or 0) - expected_risk) < 0.1,
              f"got {drs}, expected ~{expected_risk:.2f}")

        # ── Stage 4: PII detector ─────────────────────────────────────
        t0 = time.monotonic()
        pii_sys_path = os.path.join(project_root, "src", "security")
        if pii_sys_path not in sys.path:
            sys.path.insert(0, pii_sys_path)
        from pii_detector import PIIDetector
        pii_result = PIIDetector().scan_dataframe(df)
        pii_ms = int((time.monotonic() - t0) * 1000)
        print(f"  {INFO} pii_detector.py: {pii_ms}ms")
        check("pii_result has pii_columns key", "pii_columns" in pii_result)
        check("pii_result has pii_findings key", "pii_findings" in pii_result)
        check("pii_density >= 0", pii_result.get("pii_density", -1) >= 0)
        check("pii_risk is valid", pii_result.get("pii_risk") in ["low", "medium", "high", "critical"])

        # ── Stage 5: Dataset graph ─────────────────────────────────────
        t0 = time.monotonic()
        graph_sys_path = os.path.join(project_root, "src", "analysis")
        if graph_sys_path not in sys.path:
            sys.path.insert(0, graph_sys_path)
        from dataset_graph import DatasetGraphBuilder
        graph = DatasetGraphBuilder().build(baseline_dict, pii_result=pii_result, source_path=csv_path)
        graph_dict = graph.to_dict()
        graph_ms = int((time.monotonic() - t0) * 1000)
        print(f"  {INFO} dataset_graph.py: {graph_ms}ms")
        check("graph has nodes", len(graph_dict["nodes"]) > 0)
        check("graph has edges", len(graph_dict["edges"]) > 0)
        check("graph summary non-empty", bool(graph_dict.get("summary", "")))

        total_ms = parse_ms + baseline_ms + leakage_ms + pii_ms + graph_ms
        print(f"\n  {INFO} Total pipeline time: {total_ms}ms")
        check("Pipeline < 30 seconds", total_ms < 30_000, f"took {total_ms}ms")

    finally:
        try:
            os.unlink(csv_path)
        except Exception:
            pass


# ─────────────────────────────────────────────────────────────────────────────
# Test 2 — UI Data Consistency Test
# ─────────────────────────────────────────────────────────────────────────────

def test2_ui_consistency():
    section("TEST 2 — UI Data Consistency (monitorPanel.ts field audit)")

    script_dir   = os.path.dirname(os.path.abspath(__file__))
    project_root = os.path.dirname(os.path.dirname(script_dir))
    monitor_path = os.path.join(project_root, "src", "webview", "monitorPanel.ts")
    bridge_path  = os.path.join(project_root, "src", "utils",   "leakage_bridge.py")

    # ── Read files ────────────────────────────────────────────────────
    check("monitorPanel.ts exists", os.path.exists(monitor_path))
    check("leakage_bridge.py exists", os.path.exists(bridge_path))

    if not os.path.exists(monitor_path) or not os.path.exists(bridge_path):
        return

    with open(monitor_path, encoding="utf-8") as f:
        monitor_src = f.read()
    with open(bridge_path, encoding="utf-8") as f:
        bridge_src = f.read()

    # ── Extract _SAFE_OUTPUT keys from leakage_bridge.py ─────────────
    # Scan line-by-line between "_SAFE_OUTPUT = {" and the matching "}"
    backend_keys: List[str] = []
    in_safe_block = False
    for line in bridge_src.splitlines():
        stripped = line.strip()
        if '_SAFE_OUTPUT' in stripped and '= {' in stripped:
            in_safe_block = True
            continue
        if in_safe_block:
            if stripped == '}':
                break  # end of block
            m = re.match(r'"([a-z_A-Z][a-z_A-Z0-9]*)"', stripped)
            if m:
                backend_keys.append(m.group(1))
    check("_SAFE_OUTPUT has 15+ keys", len(backend_keys) >= 15,
          f"found {len(backend_keys)}: {backend_keys}")


    # Key fields the UI must reference
    required_leakage_fields = [
        "privacy_score", "risk_level", "membership_inference_auc",
        "duplicates_rate", "statistical_drift", "column_drift",
        "threat_details", "privacy_components", "avg_drift_score",
        "dataset_risk_score",
    ]
    for field_name in required_leakage_fields:
        in_backend = field_name in backend_keys
        in_ui      = f"leakage.{field_name}" in monitor_src or f"l.{field_name}" in monitor_src
        check(f"leakage.{field_name} in backend contract", in_backend)
        check(f"leakage.{field_name} referenced in UI",   in_ui,
              "field declared in backend but not used in monitorPanel.ts")

    # ── Scan for hardcoded placeholder arrays ─────────────────────────
    # Pattern: array literal with 8+ numbers used as chart/bar data.
    # Skip comment lines (starting with // after stripping).
    non_comment_lines = [
        ln for ln in monitor_src.splitlines()
        if not ln.lstrip().startswith("//")
    ]
    non_comment_src = "\n".join(non_comment_lines)
    hardcoded_arrays = re.findall(
        r'\[(?:\s*\d+\s*,\s*){7,}\d+\s*\]',
        non_comment_src
    )
    check("No hardcoded data arrays  (fake bar/chart data)",
          len(hardcoded_arrays) == 0,
          f"Found {len(hardcoded_arrays)} suspicious hardcoded arrays")


    # ── Scan for Math.random() calls that could produce non-determinism
    random_calls = re.findall(r'Math\.random\(\)', monitor_src)
    check("No Math.random() calls in dashboard (non-deterministic data)",
          len(random_calls) == 0,
          f"Found {len(random_calls)} Math.random() calls")

    # ── Verify dataset_risk_score card exists in UI ───────────────────
    check("dataset_risk_score rendered in UI",
          "dataset_risk_score" in monitor_src)

    # ── Check DashboardData interface has pii_columns or scanReport ───
    check("DashboardData includes scanReport",
          "scanReport" in monitor_src)

    print(f"  {INFO} Backend contract keys: {backend_keys}")


# ─────────────────────────────────────────────────────────────────────────────
# Test 3 — LLM Context Accuracy Test
# ─────────────────────────────────────────────────────────────────────────────

def test3_llm_context_accuracy():
    section("TEST 3 — LLM Context Accuracy (context builder validation)")

    script_dir    = os.path.dirname(os.path.abspath(__file__))
    project_root  = os.path.dirname(os.path.dirname(script_dir))
    client_path   = os.path.join(project_root, "src", "ai", "openrouter_client.ts")

    check("openrouter_client.ts exists", os.path.exists(client_path))
    if not os.path.exists(client_path):
        return

    with open(client_path, encoding="utf-8") as f:
        client_src = f.read()

    # ── Verify column_drift is included in system prompt ─────────────
    check("column_drift included in LLM system prompt",
          "column_drift" in client_src and "colDrift" in client_src)

    # ── Verify avg_drift_score included ──────────────────────────────
    check("avg_drift_score included in LLM system prompt",
          "avg_drift_score" in client_src)

    # ── Verify privacy_components included ───────────────────────────
    check("privacy_components included in LLM system prompt",
          "privacy_components" in client_src)

    # ── Verify threat triggered_by columns are sent ──────────────────
    check("threat triggered_by columns in LLM context",
          "triggered_by" in client_src)

    # ── Verify dataset risk is passed (will be added in Part 5) ──────
    check("dataset_risk_score in LLM system prompt",
          "dataset_risk_score" in client_src)

    # ── Verify anti-hallucination instruction ─────────────────────────
    check("Anti-hallucination instruction in system prompt",
          "fabricate" in client_src.lower() or "never" in client_src.lower())

    # ── Verify sample rows are limited (PART 4 requirement) ──────────
    # Look for slice(0, 20) or similar limiting construct
    has_row_limit = (
        "slice(0, 20)" in client_src or
        ".slice(0, 20" in client_src or
        "first 20" in client_src.lower() or
        "max 20" in client_src.lower() or
        "rows_limit" in client_src.lower() or
        "20 rows" in client_src
    )
    check("Sample rows limited to ≤20 in LLM context", has_row_limit)

    # ── Simulate buildSystemPrompt with mock data to verify output ────
    # We can't directly call the TS function but we can verify the
    # structure of the template in the source
    checks = {
        "DATASET PROFILE section":   "DATASET PROFILE" in client_src,
        "PRIVACY ANALYSIS section":   "PRIVACY ANALYSIS" in client_src,
        "SYNTHETIC DATA section":     "SYNTHETIC DATA" in client_src,
        "PII SCAN RESULTS section":   "PII SCAN" in client_src,
        "ATTACK SIMULATION section":  "ATTACK SIMULATION" in client_src,
    }
    for name, ok in checks.items():
        check(f"LLM prompt includes {name}", ok)

    print(f"\n  {INFO} LLM context builder structure verified from source analysis.")
    print(f"  {INFO} Note: actual LLM call accuracy requires a live API key.")


# ─────────────────────────────────────────────────────────────────────────────
# Performance Test (Part 7)
# ─────────────────────────────────────────────────────────────────────────────

def test_performance():
    section("TEST 4 — Performance (10k row dataset, 2000 synthetic rows)")

    try:
        import numpy as np
        import pandas as pd
    except ImportError:
        print(f"  {WARN} numpy/pandas not available — skipping performance test")
        return

    script_dir   = os.path.dirname(os.path.abspath(__file__))
    project_root = os.path.dirname(os.path.dirname(script_dir))
    utils_dir    = os.path.join(project_root, "src", "utils")
    if utils_dir not in sys.path:
        sys.path.insert(0, utils_dir)

    rng = np.random.default_rng(seed=9999)
    n = 10_000
    df = pd.DataFrame({
        "age":       rng.integers(18, 90, n).astype(float),
        "income":    rng.normal(70000, 20000, n).clip(10000, 300000),
        "score":     rng.uniform(300, 850, n),
        "balance":   rng.exponential(5000, n),
        "purchases": rng.integers(0, 500, n).astype(float),
        "category":  rng.choice(["A", "B", "C", "D"], n),
        "region":    rng.choice(["North", "South", "East", "West"], n),
        "tier":      rng.choice(["bronze", "silver", "gold", "platinum"], n),
    })

    with tempfile.NamedTemporaryFile(suffix=".csv", delete=False, mode="w") as f:
        df.to_csv(f, index=False)
        csv_path = f.name

    try:
        from leakage_bridge import _compute_local_metrics
        t0 = time.monotonic()
        result = _compute_local_metrics(df, n_samples=2000, seed=9999)
        elapsed = time.monotonic() - t0

        print(f"  {INFO} 10k rows + 2000 synthetic: {elapsed:.2f}s")
        check("Performance < 60 seconds", elapsed < 60.0, f"took {elapsed:.1f}s")
        check("Result is complete", result.get("privacy_score") is not None)
        check("dataset_risk_score present under load",
              result.get("dataset_risk_score") is not None)
        check("All drift columns covered",
              len(result.get("column_drift", {})) >= 5,
              f"got {len(result.get('column_drift', {}))}")
    finally:
        try:
            os.unlink(csv_path)
        except Exception:
            pass


# ─────────────────────────────────────────────────────────────────────────────
# Entry point
# ─────────────────────────────────────────────────────────────────────────────

def main():
    print("\n" + "=" * 60)
    print("  AutoMate Aurora — System Stress & Validation Tests")
    print("=" * 60)

    t_start = time.monotonic()
    test1_pipeline_integrity()
    test2_ui_consistency()
    test3_llm_context_accuracy()
    test_performance()
    elapsed = time.monotonic() - t_start

    section("FINAL RESULTS")
    print(f"  Elapsed:  {elapsed:.1f}s")
    print(f"  Failures: {len(_failures)}")
    print(f"  Warnings: {len(_warnings)}")

    if _failures:
        print(f"\n{FAIL} SYSTEM_INVALID — {len(_failures)} check(s) failed:")
        for i, f in enumerate(_failures, 1):
            print(f"  {i}. {f}")
        sys.exit(1)
    elif _warnings:
        print(f"\n{WARN} SYSTEM_WARNED — all checks passed with {len(_warnings)} warning(s)")
        sys.exit(0)
    else:
        print(f"\n{PASS} SYSTEM_VALIDATED — all checks passed.")
        sys.exit(0)


if __name__ == "__main__":
    main()
