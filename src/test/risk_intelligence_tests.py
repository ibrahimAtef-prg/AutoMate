"""
risk_intelligence_tests.py — Phase 3 Validation Suite
AutoMate Aurora · Dataset Risk Intelligence Engine

Four adversarial test cases:
  T1 — Unique Identifier Dataset    → high re-id risk, quasi_identifier ranking
  T2 — PII-Heavy Dataset            → high pii score, anonymization recommendations
  T3 — Outlier Dataset              → extreme outlier threats, clip recommendations
  T4 — Normal / Low-Risk Dataset    → low scores, no false alarms

Each test verifies: risk scores respond correctly, recommendations generated,
ranking sorted properly.
"""
import sys, os
sys.path.insert(0, os.path.join(os.path.dirname(__file__), '..', 'utils'))
sys.path.insert(0, os.path.join(os.path.dirname(__file__), '..', 'security'))

import pandas as pd
import numpy as np

from risk_intelligence import (
    compute_reidentification_risk,
    rank_sensitive_columns,
    detect_outlier_risk,
    compute_dataset_intelligence_risk,
    generate_privacy_recommendations,
)

# ─── Assertion helpers ────────────────────────────────────────────────────────

PASS_COUNT = 0
FAIL_COUNT = 0

def check(label: str, condition: bool, detail: str = "") -> None:
    global PASS_COUNT, FAIL_COUNT
    if condition:
        PASS_COUNT += 1
        print(f"  ✅ PASS  {label}")
    else:
        FAIL_COUNT += 1
        print(f"  ❌ FAIL  {label}" + (f" — {detail}" if detail else ""))


def section(title: str) -> None:
    print(f"\n{'='*60}")
    print(f"  {title}")
    print(f"{'='*60}")


# ═══════════════════════════════════════════════════════════════════════
# T1 — UNIQUE IDENTIFIER DATASET
# Expectation: user_id → near-1.0 reid risk, ranked #1, hash recommendation
# ═══════════════════════════════════════════════════════════════════════
section("T1 — Unique Identifier Dataset")

df_uid = pd.DataFrame({
    "user_id":    [f"U{i:04d}" for i in range(50)],   # 100% unique
    "age":        np.random.default_rng(1).integers(22, 65, 50),
    "income":     np.random.default_rng(2).integers(30000, 120000, 50),
    "city":       np.random.default_rng(3).choice(["Paris", "London", "Berlin"], 50),
})

reid_t1 = compute_reidentification_risk(df_uid)
print(f"\n  Reid risk scores: { {k: round(v,3) for k,v in reid_t1.items()} }")

check("T1.1 — user_id has highest reid risk",
      reid_t1["user_id"] == max(reid_t1.values()),
      f"user_id={reid_t1['user_id']:.3f}")
check("T1.2 — user_id reid risk > 0.8",
      reid_t1["user_id"] > 0.8,
      f"got {reid_t1['user_id']:.3f}")
check("T1.3 — city risk < user_id risk (low cardinality)",
      reid_t1["city"] < reid_t1["user_id"],
      f"city={reid_t1['city']:.3f}")

# Ranking — user_id should be at or near top without PII findings
ranking_t1 = rank_sensitive_columns(df_uid, pii_findings=[], column_drift={})
print(f"\n  Column ranking: {[ (r['column'], round(r['score'],3)) for r in ranking_t1 ]}")
check("T1.4 — user_id ranked #1 or #2 in sensitivity",
      ranking_t1[0]["column"] == "user_id" or ranking_t1[1]["column"] == "user_id",
      f"top={ranking_t1[0]['column']}")
check("T1.5 — ranking sorted descending",
      all(ranking_t1[i]["score"] >= ranking_t1[i+1]["score"] for i in range(len(ranking_t1)-1)),
      "scores out of order")

# Recommendations — should suggest hash/tokenize for user_id
recs_t1 = generate_privacy_recommendations(
    reidentification_risk=reid_t1, pii_density=0.1, outlier_risk=[])
rec_text = " ".join(recs_t1["recommendations"]).lower()
print(f"\n  Recommendations: {recs_t1['recommendations']}")
check("T1.6 — recommends hashing or tokenizing user_id",
      "hash" in rec_text or "tokenize" in rec_text,
      f"got: {recs_t1['recommendations'][:2]}")
check("T1.7 — recommendations non-empty",
      len(recs_t1["recommendations"]) > 0)


# ═══════════════════════════════════════════════════════════════════════
# T2 — PII-HEAVY DATASET
# Expectation: all columns flagged, high pii_density, anonymization recs
# ═══════════════════════════════════════════════════════════════════════
section("T2 — PII-Heavy Dataset")

df_pii = pd.DataFrame({
    "email":   [f"user{i}@corp.com" for i in range(40)],
    "phone":   [f"+1555{i:07d}" for i in range(40)],
    "ssn":     [f"{i:03d}-{i:02d}-{i:04d}" for i in range(40)],
    "salary":  np.random.default_rng(4).integers(40000, 200000, 40),
})

pii_findings_t2 = [
    {"column": "email",  "category": "email",  "severity": "high"},
    {"column": "phone",  "category": "phone",  "severity": "high"},
    {"column": "ssn",    "category": "ssn",    "severity": "critical"},
]
pii_density_t2 = 0.75   # 3 of 4 columns are PII

reid_t2 = compute_reidentification_risk(df_pii)
print(f"\n  Reid risk scores: { {k: round(v,3) for k,v in reid_t2.items()} }")

ranking_t2 = rank_sensitive_columns(
    df_pii, pii_findings=pii_findings_t2, column_drift={})
print(f"  Column ranking: {[ (r['column'], round(r['score'],3)) for r in ranking_t2 ]}")
check("T2.1 — ssn ranked #1 (critical severity)",
      ranking_t2[0]["column"] == "ssn",
      f"top={ranking_t2[0]['column']}, score={ranking_t2[0]['score']:.3f}")
check("T2.2 — email and phone in top 3",
      {"email","phone"}.issubset({r["column"] for r in ranking_t2[:3]}),
      f"top3={[r['column'] for r in ranking_t2[:3]]}")
check("T2.3 — ranking sorted descending",
      all(ranking_t2[i]["score"] >= ranking_t2[i+1]["score"] for i in range(len(ranking_t2)-1)))

recs_t2 = generate_privacy_recommendations(
    reidentification_risk=reid_t2,
    pii_density=pii_density_t2,
    outlier_risk=[],
    pii_findings=pii_findings_t2,
)
rec_text_t2 = " ".join(recs_t2["recommendations"]).lower()
print(f"\n  Recommendations: {recs_t2['recommendations']}")
check("T2.4 — recommends anonymization for high pii_density",
      "anonymiz" in rec_text_t2 or "anonym" in rec_text_t2,
      f"got: {recs_t2['recommendations'][:2]}")
check("T2.5 — recommends removing SSN",
      "ssn" in rec_text_t2 or "remove" in rec_text_t2,
      f"got: {recs_t2['recommendations'][:3]}")
check("T2.6 — recommendations non-empty",
      len(recs_t2["recommendations"]) >= 3)

dir_t2 = compute_dataset_intelligence_risk(
    dataset_risk_score=70.0,
    reidentification_risk=reid_t2,
    pii_density=pii_density_t2,
    outlier_risk=[],
    privacy_score=0.3,
)
print(f"\n  Intelligence Risk: {dir_t2['score']:.1f} [{dir_t2['label']}]")
check("T2.7 — intelligence risk score >= 40 (MODERATE or higher)",
      dir_t2["score"] >= 40,
      f"got {dir_t2['score']:.1f}")
check("T2.8 — label is HIGH or CRITICAL for this PII-heavy dataset",
      dir_t2["label"] in ("HIGH", "CRITICAL"),
      f"got {dir_t2['label']}")


# ═══════════════════════════════════════════════════════════════════════
# T3 — OUTLIER DATASET
# Expectation: extreme income outlier detected, clip/noise recommendations
# ═══════════════════════════════════════════════════════════════════════
section("T3 — Outlier Dataset")

ages   = list(range(25, 55))
incomes= [50000 + i * 500 for i in range(30)]
incomes[15] = 10_000_000   # extreme outlier — ~190× above median

df_out = pd.DataFrame({
    "age":    ages,
    "income": incomes,
    "score":  [75.0] * 30,
})

outliers_t3 = detect_outlier_risk(df_out)
print(f"\n  Outlier threats detected: {len(outliers_t3)}")
for t in outliers_t3:
    print(f"    {t['column']} [{t['severity']}] value={t['value']} ratio={t['extreme_ratio']}×")

check("T3.1 — at least one outlier threat detected",
      len(outliers_t3) > 0)
check("T3.2 — income column flagged",
      any(t["column"] == "income" for t in outliers_t3),
      f"flagged columns: {[t['column'] for t in outliers_t3]}")
check("T3.3 — outlier severity is high or critical",
      any(t["severity"] in ("high", "critical") for t in outliers_t3),
      f"severities: {[t['severity'] for t in outliers_t3]}")
check("T3.4 — extreme_ratio > 5 for income",
      any(t["column"] == "income" and t["extreme_ratio"] > 5 for t in outliers_t3),
      f"ratios: {[(t['column'],t['extreme_ratio']) for t in outliers_t3]}")

# No outlier in score column (all same value)
score_outliers = [t for t in outliers_t3 if t["column"] == "score"]
check("T3.5 — zero-variance column not falsely flagged",
      len(score_outliers) == 0,
      f"score threats: {score_outliers}")

reid_t3 = compute_reidentification_risk(df_out)
recs_t3 = generate_privacy_recommendations(
    reidentification_risk=reid_t3, pii_density=0.0, outlier_risk=outliers_t3)
rec_text_t3 = " ".join(recs_t3["recommendations"]).lower()
print(f"\n  Recommendations: {recs_t3['recommendations']}")
check("T3.6 — recommends clipping or noise for outlier column",
      "clip" in rec_text_t3 or "noise" in rec_text_t3,
      f"got: {recs_t3['recommendations'][:2]}")
check("T3.7 — income mentioned in recommendations",
      "income" in rec_text_t3,
      f"got: {recs_t3['recommendations'][:3]}")

dir_t3 = compute_dataset_intelligence_risk(
    dataset_risk_score=40.0,
    reidentification_risk=reid_t3,
    pii_density=0.0,
    outlier_risk=outliers_t3,
    privacy_score=0.65,
)
print(f"\n  Intelligence Risk: {dir_t3['score']:.1f} [{dir_t3['label']}]")
check("T3.8 — outlier contribution > 0 in breakdown",
      dir_t3["breakdown"]["outlier_contribution"] > 0,
      f"outlier_contribution={dir_t3['breakdown']['outlier_contribution']}")


# ═══════════════════════════════════════════════════════════════════════
# T4 — NORMAL / LOW-RISK DATASET
# Expectation: no false alarms, LOW risk label, minimal recommendations
# ═══════════════════════════════════════════════════════════════════════
section("T4 — Normal / Low-Risk Dataset")

rng = np.random.default_rng(99)
df_norm = pd.DataFrame({
    "age":        rng.integers(22, 60, 200),
    "score":      rng.uniform(50, 100, 200).round(1),
    "tenure":     rng.uniform(1, 10, 200).round(1),
    "department": rng.choice(["Engineering", "Sales", "HR", "Finance"], 200),
    "region":     rng.choice(["US", "EU", "APAC"], 200),
})

reid_t4 = compute_reidentification_risk(df_norm)
print(f"\n  Reid risk scores: { {k: round(v,3) for k,v in reid_t4.items()} }")
check("T4.1 — categorical columns have low reid risk (< 0.7)",
      all(reid_t4[c] < 0.7 for c in ["department", "region"]),
      f"dept={reid_t4['department']:.3f} region={reid_t4['region']:.3f}")

outliers_t4 = detect_outlier_risk(df_norm)
print(f"  Outlier threats: {len(outliers_t4)}")
check("T4.2 — zero or minimal outlier threats on clean dataset",
      len(outliers_t4) <= 2,
      f"threats={len(outliers_t4)}")

ranking_t4 = rank_sensitive_columns(df_norm, pii_findings=[], column_drift={})
check("T4.3 — ranking sorted descending (no crash on normal data)",
      all(ranking_t4[i]["score"] >= ranking_t4[i+1]["score"] for i in range(len(ranking_t4)-1)))
check("T4.4 — all ranking scores in 0-1 range",
      all(0.0 <= r["score"] <= 1.0 for r in ranking_t4),
      f"out-of-range: {[r for r in ranking_t4 if not 0<=r['score']<=1]}")

dir_t4 = compute_dataset_intelligence_risk(
    dataset_risk_score=15.0,
    reidentification_risk=reid_t4,
    pii_density=0.0,
    outlier_risk=outliers_t4,
    privacy_score=0.85,
)
print(f"\n  Intelligence Risk: {dir_t4['score']:.1f} [{dir_t4['label']}]")
check("T4.5 — intelligence risk score < 40 for clean dataset",
      dir_t4["score"] < 40,
      f"got {dir_t4['score']:.1f}")
check("T4.6 — label is LOW or MODERATE for clean dataset",
      dir_t4["label"] in ("LOW", "MODERATE"),
      f"got {dir_t4['label']}")

recs_t4 = generate_privacy_recommendations(
    reidentification_risk=reid_t4, pii_density=0.0, outlier_risk=outliers_t4)
print(f"  Recommendations: {recs_t4['recommendations']}")
check("T4.7 — recommendations non-empty (at least default advice)",
      len(recs_t4["recommendations"]) >= 1)


# ═══════════════════════════════════════════════════════════════════════
# SUMMARY
# ═══════════════════════════════════════════════════════════════════════
total = PASS_COUNT + FAIL_COUNT
print(f"\n{'='*60}")
print(f"  RESULTS: {PASS_COUNT}/{total} PASSED  |  {FAIL_COUNT} FAILED")
print(f"{'='*60}")
if FAIL_COUNT > 0:
    sys.exit(1)
