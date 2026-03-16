"""
risk_intelligence.py — Dataset Risk Intelligence Engine
Phase 3: AutoMate Aurora

Provides five independent analysis functions:
  compute_reidentification_risk()  — per-column re-id probability
  rank_sensitive_columns()         — composite sensitivity ranking
  detect_outlier_risk()            — extreme-value exposure threats
  compute_dataset_intelligence_risk() — 0-100 composite risk score
  generate_privacy_recommendations()  — rule-based mitigation advice

All metrics are derived from real data — nothing is simulated or hardcoded.
"""
from __future__ import annotations

import math
from typing import Any, Dict, List, Optional

# ─── Public API ───────────────────────────────────────────────────────────────

def compute_reidentification_risk(df) -> Dict[str, float]:
    """
    Estimate per-column re-identification risk.

    For each column:
        uniqueness_ratio  = nunique / len
        normalised_entropy = H(col) / log2(nunique + 1)
        risk = 0.6 * uniqueness_ratio + 0.4 * normalised_entropy

    Returns dict {column_name: risk_score (0.0-1.0)}.
    """
    import numpy as np
    import pandas as pd

    scores: Dict[str, float] = {}
    n = max(len(df), 1)

    for col in df.columns:
        series = df[col].dropna()
        if len(series) == 0:
            scores[col] = 0.0
            continue

        # Uniqueness ratio
        nuniq = series.nunique()
        uniqueness_ratio = nuniq / n

        # Normalised Shannon entropy
        vc = series.astype(str).value_counts(normalize=True)
        probs = vc.values
        raw_entropy = float(-np.sum(probs * np.log2(probs + 1e-10)))
        max_entropy = math.log2(nuniq + 1)
        normalised_entropy = raw_entropy / max_entropy if max_entropy > 0 else 0.0

        risk = min(1.0, 0.6 * uniqueness_ratio + 0.4 * normalised_entropy)
        scores[col] = round(risk, 4)

    return scores


def rank_sensitive_columns(
    df,
    pii_findings: Optional[List[Dict]] = None,
    column_drift: Optional[Dict[str, float]] = None,
) -> List[Dict[str, Any]]:
    """
    Rank columns by composite sensitivity score.

    sensitivity_score =
        0.4 * pii_score
      + 0.3 * reidentification_risk
      + 0.2 * drift_score
      + 0.1 * correlation_score

    Returns list of {column, score, signals} sorted descending.
    """
    import numpy as np
    import pandas as pd

    reid = compute_reidentification_risk(df)

    # ── PII scores: 1.0 for direct PII, 0.5 for quasi, 0 otherwise ────────
    pii_map: Dict[str, float] = {}
    if pii_findings:
        severity_weight = {"critical": 1.0, "high": 0.8, "medium": 0.5, "low": 0.2}
        for finding in pii_findings:
            col = finding.get("column", "")
            sev = finding.get("severity", "low")
            existing = pii_map.get(col, 0.0)
            pii_map[col] = max(existing, severity_weight.get(sev, 0.2))

    # ── Drift scores (normalise 0-1, JS div is 0-1 already) ───────────────
    drift_map: Dict[str, float] = column_drift or {}
    max_drift = max(drift_map.values()) if drift_map else 1.0
    norm_drift = {c: v / max(max_drift, 0.001) for c, v in drift_map.items()}

    # ── Correlation score: max Pearson |r| with any other numeric column ──
    num_df = df.select_dtypes(include="number")
    corr_map: Dict[str, float] = {}
    if len(num_df.columns) > 1:
        corr_matrix = num_df.corr().abs()
        for col in num_df.columns:
            others = corr_matrix[col].drop(col, errors="ignore")
            corr_map[col] = float(others.max()) if len(others) else 0.0

    # ── Build composite score ──────────────────────────────────────────────
    results = []
    for col in df.columns:
        pii   = pii_map.get(col, 0.0)
        ri    = reid.get(col, 0.0)
        drift = norm_drift.get(col, 0.0)
        corr  = corr_map.get(col, 0.0)

        score = round(
            0.4 * pii + 0.3 * ri + 0.2 * drift + 0.1 * corr,
            4,
        )
        results.append({
            "column": col,
            "score":  score,
            "signals": {
                "pii_score":            round(pii,   4),
                "reidentification_risk": round(ri,   4),
                "drift_score":          round(drift, 4),
                "correlation_score":    round(corr,  4),
            },
        })

    results.sort(key=lambda x: x["score"], reverse=True)
    return results


def detect_outlier_risk(df) -> List[Dict[str, Any]]:
    """
    Detect extreme outlier exposure in numeric columns.

    Outlier rule: value > Q3 + 3*IQR  or  value < Q1 - 3*IQR

    Returns list of threat dicts.  Empty list = no outliers found.
    """
    import numpy as np
    import pandas as pd

    threats: List[Dict[str, Any]] = []

    for col in df.select_dtypes(include="number").columns:
        series = df[col].dropna()
        if len(series) < 4:
            continue

        q1  = float(series.quantile(0.25))
        q3  = float(series.quantile(0.75))
        iqr = q3 - q1
        if iqr == 0:
            continue

        lo_fence = q1 - 3 * iqr
        hi_fence = q3 + 3 * iqr

        extreme_hi = series[series > hi_fence]
        extreme_lo = series[series < lo_fence]

        for val in extreme_hi.values:
            extreme_ratio = float(abs(val - q3) / max(iqr, 1e-9))
            severity = "critical" if extreme_ratio > 20 else ("high" if extreme_ratio > 5 else "medium")
            threats.append({
                "name":          "Extreme Outlier Exposure",
                "severity":      severity,
                "column":        col,
                "value":         float(round(val, 4)),
                "direction":     "high",
                "extreme_ratio": round(extreme_ratio, 2),
                "fence":         round(hi_fence, 4),
                "description":   (
                    f"Column '{col}' contains value {val:.4g} which is "
                    f"{extreme_ratio:.1f}× the IQR above Q3. "
                    f"Extreme outliers expose individuals in sparse high-value ranges."
                ),
            })

        for val in extreme_lo.values:
            extreme_ratio = float(abs(val - q1) / max(iqr, 1e-9))
            severity = "critical" if extreme_ratio > 20 else ("high" if extreme_ratio > 5 else "medium")
            threats.append({
                "name":          "Extreme Outlier Exposure",
                "severity":      severity,
                "column":        col,
                "value":         float(round(val, 4)),
                "direction":     "low",
                "extreme_ratio": round(extreme_ratio, 2),
                "fence":         round(lo_fence, 4),
                "description":   (
                    f"Column '{col}' contains value {val:.4g} which is "
                    f"{extreme_ratio:.1f}× the IQR below Q1."
                ),
            })

    # Deduplicate: keep worst-severity per column
    seen: Dict[str, Dict] = {}
    sev_rank = {"critical": 3, "high": 2, "medium": 1, "low": 0}
    for t in threats:
        key = f"{t['column']}_{t['direction']}"
        if key not in seen or sev_rank.get(t["severity"], 0) > sev_rank.get(seen[key]["severity"], 0):
            seen[key] = t

    return list(seen.values())


def compute_dataset_intelligence_risk(
    dataset_risk_score: float,
    reidentification_risk: Dict[str, float],
    pii_density: float,
    outlier_risk: List[Dict],
    privacy_score: float,
) -> Dict[str, Any]:
    """
    Compute the 0-100 Dataset Intelligence Risk score.

    Formula:
        raw =  0.30 * dataset_risk_score           (already 0-100, normalise to 0-1)
             + 0.25 * max_reidentification_risk     (0-1)
             + 0.20 * pii_density                  (0-1)
             + 0.15 * outlier_risk_score            (0-1, based on severity/count)
             + 0.10 * (1 - privacy_score)           (0-1)

    Returns {score, label, breakdown}.
    """
    drs_norm  = max(0.0, min(1.0, (dataset_risk_score or 0.0) / 100.0))
    max_reid  = max(reidentification_risk.values()) if reidentification_risk else 0.0
    pii_d     = max(0.0, min(1.0, pii_density or 0.0))
    ps        = max(0.0, min(1.0, privacy_score or 0.5))

    # Outlier risk score: scale by severity and count (cap at 1.0)
    sev_weights = {"critical": 0.30, "high": 0.20, "medium": 0.10, "low": 0.05}
    outlier_score = min(1.0, sum(sev_weights.get(t.get("severity", "low"), 0.05) for t in outlier_risk))

    raw = (
        0.30 * drs_norm
      + 0.25 * max_reid
      + 0.20 * pii_d
      + 0.15 * outlier_score
      + 0.10 * (1.0 - ps)
    )
    final_score = round(min(100.0, raw * 100.0), 2)

    if final_score >= 80:
        label = "CRITICAL"
    elif final_score >= 60:
        label = "HIGH"
    elif final_score >= 30:
        label = "MODERATE"
    else:
        label = "LOW"

    return {
        "score": final_score,
        "label": label,
        "breakdown": {
            "dataset_risk_contribution":           round(0.30 * drs_norm * 100, 2),
            "reidentification_contribution":       round(0.25 * max_reid * 100, 2),
            "pii_density_contribution":            round(0.20 * pii_d * 100, 2),
            "outlier_contribution":                round(0.15 * outlier_score * 100, 2),
            "privacy_score_contribution":          round(0.10 * (1 - ps) * 100, 2),
        },
    }


def generate_privacy_recommendations(
    reidentification_risk: Dict[str, float],
    pii_density: float,
    outlier_risk: List[Dict],
    pii_findings: Optional[List[Dict]] = None,
) -> Dict[str, List[str]]:
    """
    Rule-based privacy mitigation recommendations.

    Returns {"recommendations": [...strings...]}.
    """
    recs: List[str] = []
    seen: set = set()

    def add(msg: str) -> None:
        if msg not in seen:
            seen.add(msg)
            recs.append(msg)

    # ── Re-identification risk rules ───────────────────────────────────────
    for col, risk in sorted(reidentification_risk.items(), key=lambda x: -x[1]):
        if risk > 0.8:
            add(f"Hash or tokenize '{col}' — re-identification risk {risk:.0%}")
        elif risk > 0.6:
            add(f"Consider pseudonymization for '{col}' (risk {risk:.0%})")

    # ── PII density rules ──────────────────────────────────────────────────
    if pii_density > 0.5:
        add("Apply dataset-level anonymization — PII density exceeds 50% of columns")
        add("Remove or mask direct identifiers before sharing or training")
    elif pii_density > 0.2:
        add("Review and restrict access to columns flagged as PII")

    # ── PII finding–specific rules ─────────────────────────────────────────
    if pii_findings:
        cat_seen: set = set()
        cat_actions = {
            "email":             "Mask email addresses (retain domain only)",
            "phone":             "Truncate or hash phone numbers",
            "credit_card":       "Remove credit card data — store only last 4 digits",
            "ssn":               "Remove SSN data — replace with anonymised ID",
            "quasi_identifier":  "Apply k-anonymity to quasi-identifier columns",
            "high_entropy_token": "Rotate or remove high-entropy tokens (possible API keys)",
        }
        for f in pii_findings:
            cat = f.get("category", "")
            action = cat_actions.get(cat)
            if action and cat not in cat_seen:
                cat_seen.add(cat)
                add(action)

    # ── Outlier rules ──────────────────────────────────────────────────────
    outlier_cols_seen: set = set()
    for threat in outlier_risk:
        col = threat.get("column", "")
        if col and col not in outlier_cols_seen:
            outlier_cols_seen.add(col)
            sev = threat.get("severity", "medium")
            if sev in ("critical", "high"):
                add(f"Clip or cap extreme values in '{col}' — {sev} outlier exposure")
                add(f"Consider noise injection (Laplace/Gaussian) for '{col}' before release")
            else:
                add(f"Review outlier values in '{col}' before dataset sharing")

    # ── Default if nothing flagged ─────────────────────────────────────────
    if not recs:
        add("Dataset appears low-risk. Maintain access controls and audit logging.")

    return {"recommendations": recs}
