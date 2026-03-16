#!/usr/bin/env python3
"""
leakage_bridge.py — Privacy Leakage Analysis Bridge

Two operating modes:
  1. FULL  — Uses run_leakage_pipeline() from the governance pipeline (if available).
  2. LOCAL — Standalone mode: generates synthetic data internally and computes
             real privacy metrics without an external pipeline dependency.

Outputs one JSON object to stdout; errors surface inside the JSON (never on stdout).

CONTRACT — always returns ALL of these top-level keys:
  risk_level                 str | null
  privacy_score              float | null   (0-1)
  privacy_score_reliable     bool
  statistical_drift          str | null     ("low"|"moderate"|"high"|"unknown")
  duplicates_rate            float | null   (0-1)
  membership_inference_auc   float | null   (0-1)
  top_threats                list[dict]
  threat_details             list[dict]
  column_drift               dict[str, float]  (column → 0-1 JS-divergence)
  has_uncertainty            bool
  uncertainty_notes          list[str]
  error                      str | null
  _mode                      str
"""
from __future__ import annotations
import argparse, json, math, os, sys, traceback, warnings
from typing import Any, Dict, List, Optional
warnings.filterwarnings("ignore")

# ─── Safe fallback skeleton ───────────────────────────────────────────────────

_SAFE_OUTPUT: Dict[str, Any] = {
    "risk_level":               None,
    "privacy_score":            None,
    "privacy_score_reliable":   False,
    "statistical_drift":        None,
    "duplicates_rate":          None,
    "membership_inference_auc": None,
    "top_threats":              [],
    "threat_details":           [],
    "column_drift":             {},
    "has_uncertainty":          True,
    "uncertainty_notes":        [],
    "error":                    None,
    "_mode":                    "unknown",
    # Extended fields consumed by the dashboard UI and LLM context builder
    "privacy_components":       None,
    "avg_drift_score":          None,
    "num_cols_analysed":        None,
    "cat_cols_analysed":        None,
    "n_samples":                None,
    # Governance fields
    "dataset_risk_score":       None,   # 0-100 composite risk (higher = riskier)
    "pii_columns":              [],     # columns flagged by pii_detector
    # UPGRADE 1: Statistical reliability score (0.0–1.0)
    "statistical_reliability_score": None,
    # UPGRADE 2: Privacy attack simulation results
    "attack_results": {
        "membership_attack_success": None,
        "reconstruction_risk":       None,
        "nearest_neighbor_leakage":  None,
    },
    # PHASE 3: Dataset Risk Intelligence Engine
    "reidentification_risk":     {},   # {column: 0.0-1.0}
    "sensitive_column_ranking":  [],   # [{column, score, signals}, …] sorted desc
    "outlier_risk":              [],   # [{name, severity, column, value, …}, …]
    "dataset_intelligence_risk": {     # 0-100 composite + label
        "score": None,
        "label": None,
        "breakdown": {},
    },
    "privacy_recommendations":   {"recommendations": []},
}


def _safe_merge(partial: Dict[str, Any]) -> Dict[str, Any]:
    """Merge partial dict on top of the skeleton, guaranteeing all keys exist."""
    result = dict(_SAFE_OUTPUT)
    for k, v in partial.items():
        if k in result:
            result[k] = v
    return result



# ─── Helpers ─────────────────────────────────────────────────────────────────

def _load_df(path: str):
    import pandas as pd
    ext = os.path.splitext(path)[1].lower()
    if ext in (".csv", ".tsv"):
        return pd.read_csv(path)
    if ext == ".parquet":
        return pd.read_parquet(path)
    if ext in (".json", ".jsonl"):
        try:
            return pd.read_json(path)
        except Exception:
            return pd.read_json(path, lines=True)
    if ext in (".xlsx", ".xls", ".xlsm"):
        return pd.read_excel(path)
    return pd.read_csv(path)


def _find_pipeline(hint: Optional[str]) -> Optional[str]:
    def _is_root(d: str) -> bool:
        return (os.path.isdir(os.path.join(d, "pipeline")) and
                os.path.isdir(os.path.join(d, "governance_core")))

    for candidate in filter(None, [hint, os.environ.get("AUTOMATE_PIPELINE_DIR")]):
        if _is_root(candidate):
            return candidate

    here = os.path.dirname(os.path.abspath(__file__))
    d = here
    for _ in range(6):
        if _is_root(d):
            return d
        parent = os.path.dirname(d)
        if parent == d:
            break
        d = parent

    ext_root = os.path.dirname(os.path.dirname(here))
    try:
        for name in os.listdir(os.path.dirname(ext_root)):
            candidate = os.path.join(os.path.dirname(ext_root), name)
            if os.path.isdir(candidate) and _is_root(candidate):
                return candidate
    except OSError:
        pass
    return None


# ─── JS divergence helper ────────────────────────────────────────────────────

def _js_div(a_vals, b_vals, bins: int = 20) -> float:
    import numpy as np
    lo = min(float(np.nanmin(a_vals)), float(np.nanmin(b_vals)))
    hi = max(float(np.nanmax(a_vals)), float(np.nanmax(b_vals)))
    if lo == hi:
        return 0.0
    edges = np.linspace(lo, hi, bins + 1)
    pa, _ = np.histogram(a_vals, bins=edges, density=True)
    pb, _ = np.histogram(b_vals, bins=edges, density=True)
    pa = pa + 1e-10; pb = pb + 1e-10
    pa /= pa.sum();  pb /= pb.sum()
    m = 0.5 * (pa + pb)
    return float(0.5 * np.sum(pa * np.log(pa / m + 1e-10)) +
                 0.5 * np.sum(pb * np.log(pb / m + 1e-10)))


# ─── LOCAL MODE: real statistical metrics ────────────────────────────────────

def _compute_local_metrics(original_df, n_samples: int, seed: Optional[int]) -> Dict[str, Any]:
    """
    Compute privacy metrics locally without any external pipeline.
    Returns a dict that is ALWAYS merged through _safe_merge so all keys exist.
    """
    import numpy as np
    import pandas as pd

    rng = np.random.default_rng(seed)

    # ── Step 0: classify columns ──────────────────────────────────────
    num_cols: List[str] = []
    cat_cols: List[str] = []
    for col in original_df.columns:
        if pd.api.types.is_numeric_dtype(original_df[col]):
            num_cols.append(col)
        else:
            cat_cols.append(col)

    # ── Step 1: Generate synthetic data via marginal sampling ──────────
    synthetic: Dict[str, Any] = {}
    for col in num_cols:
        s = pd.to_numeric(original_df[col], errors="coerce").dropna()
        if len(s) < 2:
            synthetic[col] = np.zeros(n_samples)
        else:
            vals = s.values
            quantiles = np.linspace(0, 1, len(vals))
            u = rng.uniform(0, 1, n_samples)
            synthetic[col] = np.interp(u, quantiles, np.sort(vals))

    for col in cat_cols:
        s = original_df[col].dropna().astype(str)
        if len(s) == 0:
            synthetic[col] = np.array([""] * n_samples)
        else:
            vc = s.value_counts(normalize=True)
            choices = vc.index.tolist()
            probs = vc.values
            idx = rng.choice(len(choices), size=n_samples, p=probs)
            synthetic[col] = np.array(choices, dtype=object)[idx]

    synthetic_df = pd.DataFrame(synthetic)

    # ── Step 2: Duplicates rate ───────────────────────────────────────
    def normalize_row(row):
        out = []
        for v in row:
            try:
                out.append(str(round(float(v), 4)))
            except Exception:
                out.append(str(v))
        return tuple(out)

    duplicates_rate: Optional[float] = None
    try:
        # Use only columns present in both frames, in original's order
        shared_cols = [c for c in original_df.columns if c in synthetic_df.columns]
        orig_tuples = set(
            normalize_row(r) for r in original_df[shared_cols].fillna("__NA__").values
        )
        dup_count = sum(
            1 for r in synthetic_df[shared_cols].fillna("__NA__").values
            if normalize_row(r) in orig_tuples
        )
        duplicates_rate = round(dup_count / max(len(synthetic_df), 1), 6)
    except Exception:
        duplicates_rate = None

    # ── Step 3: Statistical drift (JS divergence per column) ──────────
    column_drift: Dict[str, float] = {}
    drift_scores: List[float] = []
    statistical_drift: str = "unknown"
    avg_drift: Optional[float] = None
    try:
        for col in num_cols:
            try:
                a_v = pd.to_numeric(original_df[col], errors="coerce").dropna().values
                b_v = synthetic_df[col].astype(float).values if col in synthetic_df else np.zeros(n_samples)
                if len(a_v) >= 2 and len(b_v) >= 2:
                    d = round(_js_div(a_v, b_v), 4)
                    column_drift[col] = d
                    drift_scores.append(d)
            except Exception:
                pass

        for col in cat_cols:
            try:
                orig_vc = original_df[col].dropna().astype(str).value_counts(normalize=True)
                synth_vc = (
                    synthetic_df[col].astype(str).value_counts(normalize=True)
                    if col in synthetic_df else pd.Series(dtype=float)
                )
                all_cats = set(orig_vc.index) | set(synth_vc.index)
                pa = np.array([orig_vc.get(c, 0.0) for c in all_cats]) + 1e-10
                pb = np.array([synth_vc.get(c, 0.0) for c in all_cats]) + 1e-10
                pa /= pa.sum(); pb /= pb.sum()
                m = 0.5 * (pa + pb)
                d = round(float(
                    0.5 * np.sum(pa * np.log(pa / m + 1e-10)) +
                    0.5 * np.sum(pb * np.log(pb / m + 1e-10))
                ), 4)
                column_drift[col] = d
                drift_scores.append(d)
            except Exception:
                pass

        if drift_scores:
            avg_drift = float(np.mean(drift_scores))
            if avg_drift < 0.05:
                statistical_drift = "low"
            elif avg_drift < 0.15:
                statistical_drift = "moderate"
            else:
                statistical_drift = "high"
    except Exception:
        statistical_drift = "unknown"
        column_drift = {}
        avg_drift = None

    # ── Step 4: Membership Inference AUC (distance-based proxy) ───────
    membership_inference_auc: Optional[float] = None
    feat_cols: List[str] = []
    try:
        feat_cols = [c for c in num_cols if c in synthetic_df.columns][:10]
        if len(feat_cols) >= 1 and len(original_df) >= 10:
            orig_feat = (
                original_df[feat_cols]
                .apply(lambda c: pd.to_numeric(c, errors="coerce"))
                .fillna(0).values.astype(float)
            )
            synth_feat = synthetic_df[feat_cols].astype(float).fillna(0).values

            col_std = np.std(orig_feat, axis=0)
            col_std[col_std == 0] = 1.0
            orig_norm  = orig_feat  / col_std
            synth_norm = synth_feat / col_std

            sample_size = min(200, len(synth_norm), len(orig_norm))
            orig_sample  = orig_norm[rng.choice(len(orig_norm),  size=sample_size, replace=False)]
            synth_sample = synth_norm[rng.choice(len(synth_norm), size=sample_size, replace=False)]

            def _min_dist(row, pool):
                diffs = pool - row
                return float(np.sqrt((diffs ** 2).sum(axis=1)).min())

            orig_dists  = [_min_dist(r, orig_sample)  for r in orig_sample]
            synth_dists = [_min_dist(r, orig_sample)  for r in synth_sample]

            threshold = float(np.median(orig_dists)) if orig_dists else 1.0
            above = sum(1 for d in synth_dists if d > threshold)
            auc_proxy = 0.5 + 0.5 * (above / max(len(synth_dists), 1) - 0.5)
            membership_inference_auc = round(float(np.clip(auc_proxy, 0.0, 1.0)), 4)
    except Exception:
        membership_inference_auc = None

    # ── Step 5: Privacy score (composite) ─────────────────────────────
    privacy_score: Optional[float] = None
    try:
        dup_component   = max(0.0, 1.0 - (duplicates_rate * 20 if duplicates_rate is not None else 0.1))
        if membership_inference_auc is not None:
            auc_component = max(0.0, 1.0 - 2.0 * abs(membership_inference_auc - 0.5))
        else:
            auc_component = 0.5
        drift_component = max(0.0, 1.0 - (avg_drift * 4 if avg_drift is not None else 0.2))
        privacy_score = round(float(
            0.40 * auc_component +
            0.35 * dup_component +
            0.25 * drift_component
        ), 4)
    except Exception:
        privacy_score = None

    # ── Step 6: Risk level ────────────────────────────────────────────
    if privacy_score is not None:
        if privacy_score >= 0.75:
            risk_level: Optional[str] = "low"
        elif privacy_score >= 0.50:
            risk_level = "warning"
        else:
            risk_level = "critical"
    else:
        risk_level = "unknown"

    # ── Step 7: Privacy score component breakdown ─────────────────────
    # These populate threat_details for the UI's "Privacy Risk Breakdown"
    top_threats: List[Dict[str, Any]] = []
    threat_details: List[Dict[str, Any]] = []

    # Component: Exact-row duplication
    dup_risk_score = duplicates_rate if duplicates_rate is not None else 0.0
    if duplicates_rate is not None and duplicates_rate > 0.01:
        t = {
            "name":              "Exact Row Duplication",
            "severity":          "high" if duplicates_rate > 0.05 else "medium",
            "confidence":        round(min(1.0, duplicates_rate * 10), 2),
            "impacted_property": "uniqueness",
            "triggered_by":      [],
            "description":       f"{duplicates_rate*100:.2f}% of synthetic rows are exact copies of training records. "
                                  "An adversary with access to the synthetic dataset can directly identify real individuals.",
        }
        top_threats.append({"name": t["name"], "severity": t["severity"], "confidence": t["confidence"]})
        threat_details.append(t)

    # Component: Membership inference
    if membership_inference_auc is not None and membership_inference_auc > 0.6:
        t = {
            "name":              "Membership Inference Risk",
            "severity":          "high" if membership_inference_auc > 0.75 else "medium",
            "confidence":        round(min(1.0, (membership_inference_auc - 0.5) * 2), 2),
            "impacted_property": "privacy",
            "triggered_by":      feat_cols[:3],
            "description":       f"Membership inference AUC of {membership_inference_auc:.3f} indicates the synthetic "
                                  "data retains proximity signatures that allow an attacker to determine whether a "
                                  "specific individual was in the training set.",
        }
        top_threats.append({"name": t["name"], "severity": t["severity"], "confidence": t["confidence"]})
        threat_details.append(t)

    # Component: High statistical drift
    if statistical_drift == "high":
        top_drift_cols = [k for k, v in sorted(column_drift.items(), key=lambda x: -x[1])[:3]]
        t = {
            "name":              "High Statistical Drift",
            "severity":          "medium",
            "confidence":        0.7,
            "impacted_property": "fidelity",
            "triggered_by":      top_drift_cols,
            "description":       "Synthetic data distributions diverge significantly from original data distributions. "
                                  "Downstream ML models trained on this data may not generalise to real data.",
        }
        top_threats.append({"name": t["name"], "severity": t["severity"], "confidence": t["confidence"]})
        threat_details.append(t)

    # Component: Distance similarity (low MI-AUC check — too similar = reconstruction risk)
    if membership_inference_auc is not None and membership_inference_auc < 0.45:
        t = {
            "name":              "High Distance Similarity (Reconstruction Risk)",
            "severity":          "high",
            "confidence":        round(min(1.0, (0.5 - membership_inference_auc) * 4), 2),
            "impacted_property": "confidentiality",
            "triggered_by":      feat_cols[:3],
            "description":       f"MI-AUC of {membership_inference_auc:.3f} is below 0.45. Synthetic rows are "
                                  "statistically indistinguishable from real rows, indicating a potential "
                                  "reconstruction or attribute-inference attack vector.",
        }
        top_threats.append({"name": t["name"], "severity": t["severity"], "confidence": t["confidence"]})
        threat_details.append(t)

    # ── Step 8: Privacy score component breakdown for UI ──────────────
    privacy_components = {
        "duplicates_risk":          round(float(dup_risk_score), 4),
        "mi_attack_risk":           round(float(max(0.0, (membership_inference_auc or 0.5) - 0.5) * 2), 4),
        "distance_similarity_risk": round(float(max(0.0, 0.5 - (membership_inference_auc or 0.5)) * 2), 4),
        "distribution_drift_risk":  round(float(avg_drift or 0.0), 4),
    }

    # ── Step 9: Dataset Risk Score (0–100, higher = riskier) ──────────
    # Formula: risk = (1-privacy_score)*40 + MI-AUC*30 + dup_rate*20 + avg_drift*10
    # Weights reflect impact severity: privacy posture > MI attack > exact duplication > drift
    dataset_risk_score: Optional[float] = None
    try:
        ps_v   = float(privacy_score)            if privacy_score            is not None else 0.5
        auc_v  = float(membership_inference_auc) if membership_inference_auc is not None else 0.5
        dup_v  = float(duplicates_rate)          if duplicates_rate          is not None else 0.0
        drft_v = float(avg_drift)               if avg_drift                is not None else 0.0
        raw_risk = (1.0 - ps_v) * 40.0 + auc_v * 30.0 + dup_v * 20.0 + drft_v * 10.0
        dataset_risk_score = round(float(max(0.0, min(100.0, raw_risk))), 2)
    except Exception:
        dataset_risk_score = None

    # ── Step 10: Statistical Reliability Score ────────────────────────
    # Reflects how statistically stable the computed metrics are given dataset size.
    # Small datasets produce noisy MI-AUC, drift, and privacy scores.
    n_rows = len(original_df)
    if n_rows >= 500:
        statistical_reliability_score = 1.00
    elif n_rows >= 100:
        statistical_reliability_score = 0.85
    elif n_rows >= 30:
        statistical_reliability_score = 0.65
    elif n_rows >= 10:
        statistical_reliability_score = 0.40
    else:
        statistical_reliability_score = 0.15

    # ── Step 11: Attack simulation results (derived from existing metrics) ────
    # membership_attack_success: AUC-based — how well an attacker can identify members
    #   AUC=0.5 → 0% success (random), AUC=1.0 → 100% success
    # reconstruction_risk: distance_similarity_risk from privacy_components
    #   Low MI-AUC (< 0.45) means synthetic rows are TOO close → reconstruction risk
    # nearest_neighbor_leakage: avg_drift_score inversely indicates closeness
    #   Low drift = synthetic rows are very close to originals
    try:
        if membership_inference_auc is not None:
            mem_success = round(float(max(0.0, min(1.0, 2.0 * (membership_inference_auc - 0.5)))), 4)
        else:
            mem_success = None

        recon_risk = privacy_components.get("distance_similarity_risk")

        if avg_drift is not None:
            # Near-zero drift means synthetic ≈ original = high leakage
            nn_leakage = round(float(max(0.0, min(1.0, 1.0 - min(avg_drift * 5.0, 1.0)))), 4)
        else:
            nn_leakage = None

        attack_results = {
            "membership_attack_success": mem_success,
            "reconstruction_risk":       round(float(recon_risk), 4) if recon_risk is not None else None,
            "nearest_neighbor_leakage":  nn_leakage,
        }
    except Exception:
        attack_results = {
            "membership_attack_success": None,
            "reconstruction_risk":       None,
            "nearest_neighbor_leakage":  None,
        }

    reliable = statistical_reliability_score >= 0.65
    notes: List[str] = []
    if not reliable:
        notes.append(
            f"Metrics unreliable: dataset has only {n_rows} rows "
            f"(reliability={statistical_reliability_score:.2f})."
        )

    # ── Phase 3: Dataset Risk Intelligence Engine ─────────────────────
    try:
        import sys as _sys, os as _os
        _sys.path.insert(0, _os.path.dirname(_os.path.abspath(__file__)))
        from risk_intelligence import (
            compute_reidentification_risk,
            rank_sensitive_columns,
            detect_outlier_risk,
            compute_dataset_intelligence_risk,
            generate_privacy_recommendations,
        )

        reid_risk  = compute_reidentification_risk(original_df)
        col_ranking = rank_sensitive_columns(
            original_df,
            pii_findings=[],           # populated downstream by pii_detector pass
            column_drift=column_drift,
        )
        outlier_threats = detect_outlier_risk(original_df)

        pii_dens = 0.0   # will be updated by pii_detector pass in extension.ts
        dir_score = compute_dataset_intelligence_risk(
            dataset_risk_score=dataset_risk_score or 0.0,
            reidentification_risk=reid_risk,
            pii_density=pii_dens,
            outlier_risk=outlier_threats,
            privacy_score=privacy_score or 0.5,
        )
        recs = generate_privacy_recommendations(
            reidentification_risk=reid_risk,
            pii_density=pii_dens,
            outlier_risk=outlier_threats,
        )
    except Exception:
        reid_risk       = {}
        col_ranking     = []
        outlier_threats = []
        dir_score       = {"score": None, "label": None, "breakdown": {}}
        recs            = {"recommendations": []}

    return _safe_merge({
        "risk_level":               risk_level,
        "privacy_score":            privacy_score,
        "privacy_score_reliable":   reliable,
        "statistical_drift":        statistical_drift,
        "duplicates_rate":          duplicates_rate,
        "membership_inference_auc": membership_inference_auc,
        "top_threats":              top_threats,
        "threat_details":           threat_details,
        "column_drift":             column_drift,
        "has_uncertainty":          not reliable,
        "uncertainty_notes":        notes,
        "error":                    None,
        "_mode":                    "local",
        "privacy_components":       privacy_components,
        "avg_drift_score":          round(float(avg_drift), 4) if avg_drift is not None else None,
        "num_cols_analysed":        len(num_cols),
        "cat_cols_analysed":        len(cat_cols),
        "n_samples":                n_samples,
        "dataset_risk_score":       dataset_risk_score,
        "pii_columns":              [],   # populated by pii_detector pass in extension.ts
        "statistical_reliability_score": statistical_reliability_score,
        "attack_results":           attack_results,
        # Phase 3
        "reidentification_risk":     reid_risk,
        "sensitive_column_ranking":  col_ranking,
        "outlier_risk":              outlier_threats,
        "dataset_intelligence_risk": dir_score,
        "privacy_recommendations":   recs,
    })



# ─── FULL MODE: uses the leakage pipeline ────────────────────────────────────

def _extract_column_drift(synthetic_df, original_df) -> Dict[str, float]:
    try:
        from governance_core.metrics.statistical_fidelity import StatisticalFidelityMetrics
        metrics = StatisticalFidelityMetrics()
        shift_result = metrics.compute_distribution_shift(synthetic_df, original_df)
        per_column = shift_result.get("per_column", {})
        return {col: round(float(v.get("shift_score", 0.0)), 4)
                for col, v in per_column.items()}
    except Exception as exc:
        print(f"[leakage_bridge] column_drift extraction failed: {exc}", file=sys.stderr)
        return {}


def _extract_result(result, column_drift) -> Dict[str, Any]:
    gov = result.get("governance_result", {})
    raw = gov.get("raw_metrics", {})

    threats_raw = (gov.get("dataset_risk_summary", {}).get("top_threats")
                   or gov.get("threats")
                   or result.get("top_threats") or [])
    top_threats = [{
        "name":       str(t.get("threat_name") or t.get("name") or "Unknown"),
        "severity":   str(t.get("severity") or "unknown").lower(),
        "confidence": float(t.get("confidence") or 0.0),
    } for t in threats_raw]

    full_threats = gov.get("threats") or threats_raw
    _sev = {"high": 0, "medium": 1, "low": 2, "unknown": 3}
    threat_details = sorted([{
        "name":              str(t.get("threat_name") or t.get("name") or "Unknown"),
        "severity":          str(t.get("severity") or "unknown").lower(),
        "confidence":        float(t.get("confidence") or 0.0),
        "impacted_property": str(t.get("impacted_property") or t.get("affected_property") or "unknown"),
        "triggered_by":      list(t.get("triggered_by") or []),
        "description":       str(t.get("description") or ""),
    } for t in full_threats],
        key=lambda x: (_sev.get(x["severity"], 3), -x["confidence"]))

    ps_raw    = raw.get("privacy_score")
    ps_result = result.get("privacy_score")
    privacy_score = ps_raw if ps_raw is not None else ps_result

    risk_raw = str(raw.get("leakage_risk_level") or result.get("risk_level") or "unknown")
    if risk_raw.lower() == "none":
        risk_raw = "low"

    mi_auc = (raw.get("membership_inference_auc")
               if raw.get("membership_inference_auc") is not None
               else result.get("membership_inference_auc"))
    dup_rate = (raw.get("duplicates_rate")
                if raw.get("duplicates_rate") is not None
                else result.get("duplicates_rate"))

    privacy_components = {
        "duplicates_risk":          round(float(dup_rate or 0.0), 4),
        "mi_attack_risk":           round(float(max(0.0, (mi_auc or 0.5) - 0.5) * 2), 4),
        "distance_similarity_risk": round(float(max(0.0, 0.5 - (mi_auc or 0.5)) * 2), 4),
        "distribution_drift_risk":  round(float(
            sum(column_drift.values()) / len(column_drift) if column_drift else 0.0
        ), 4),
    }

    return _safe_merge({
        "risk_level":               risk_raw,
        "privacy_score":            privacy_score,
        "privacy_score_reliable":   bool(raw.get("privacy_score_reliable", False) or result.get("privacy_score_reliable", False)),
        "statistical_drift":        str(raw.get("statistical_drift") or result.get("statistical_drift") or "unknown"),
        "duplicates_rate":          dup_rate,
        "membership_inference_auc": mi_auc,
        "top_threats":              top_threats,
        "threat_details":           threat_details,
        "column_drift":             column_drift,
        "has_uncertainty":          bool(gov.get("has_uncertainty", False) or result.get("has_uncertainty", False)),
        "uncertainty_notes":        list(gov.get("uncertainty_notes") or result.get("uncertainty_notes") or []),
        "error":                    None,
        "_mode":                    "full",
        "privacy_components":       privacy_components,
    })


# ─── Entry point ─────────────────────────────────────────────────────────────

def main(argv=None):
    p = argparse.ArgumentParser(description="leakage_bridge.py — Privacy Leakage Analysis")
    p.add_argument("--original",      required=True, help="Path to the original dataset file.")
    p.add_argument("--n",             type=int, default=500, help="Number of synthetic rows.")
    p.add_argument("--pipeline-dir",  default=None, help="Optional: path to the governance pipeline root.")
    p.add_argument("--seed",          type=int, default=None, help="Random seed.")
    args = p.parse_args(argv)

    def _emit_error(msg: str) -> int:
        out = _safe_merge({"error": msg, "uncertainty_notes": [msg], "has_uncertainty": True, "_mode": "error"})
        print(json.dumps(out, ensure_ascii=False))
        return 1

    if not os.path.isfile(args.original):
        return _emit_error(f"Dataset file not found: {args.original}")

    # Load original dataset
    try:
        original_df = _load_df(args.original)
    except Exception as exc:
        return _emit_error(f"Failed to load dataset: {exc}")

    if original_df.empty or original_df.shape[1] == 0:
        return _emit_error("Dataset is empty or has no columns.")

    # Try full pipeline mode first
    pipeline_root = _find_pipeline(args.pipeline_dir)
    if pipeline_root is not None:
        if pipeline_root not in sys.path:
            sys.path.insert(0, pipeline_root)
        try:
            from pipeline.leakage_pipeline import run_leakage_pipeline
            try:
                result = run_leakage_pipeline(original_df=original_df, n_samples=args.n, seed=args.seed)
                synthetic_df = result.get("synthetic_df")
                column_drift = _extract_column_drift(synthetic_df, original_df) if synthetic_df is not None else {}
                output = _extract_result(result, column_drift)
                print(json.dumps(output, ensure_ascii=False, default=str))
                return 0
            except Exception as exc:
                traceback.print_exc(file=sys.stderr)
                print(f"[leakage_bridge] Full pipeline failed ({exc}); falling back to local mode.", file=sys.stderr)
        except ImportError as exc:
            print(f"[leakage_bridge] Pipeline import failed ({exc}); using local mode.", file=sys.stderr)

    # Local mode — compute real metrics without external pipeline
    try:
        output = _compute_local_metrics(original_df, args.n, args.seed)
        print(json.dumps(output, ensure_ascii=False, default=str))
        return 0
    except Exception as exc:
        traceback.print_exc(file=sys.stderr)
        return _emit_error(f"Local metrics computation failed: {exc}")


if __name__ == "__main__":
    sys.exit(main())
