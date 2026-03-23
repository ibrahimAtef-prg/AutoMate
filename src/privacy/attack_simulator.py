"""
attack_simulator.py — Privacy Attack Simulation Engine
======================================================

Simulates privacy attacks against synthetic datasets:
    1. Membership Inference Attack (MIA)
    2. Model Inversion Attack
    3. Data Reconstruction Attack

If an attack succeeds:
    ⚠ Synthetic dataset vulnerable to [attack_type]

Output: attack_report.json
"""

from __future__ import annotations
import logging as _logging
_log = _logging.getLogger(__name__)
import json, math, os, sys, hashlib
from typing import Any, Dict, List, Optional, Tuple
from dataclasses import dataclass, field, asdict

try:
    import numpy as np
    import pandas as pd
except ImportError as _e:
    raise ImportError(
        "numpy and pandas are required by attack_simulator. "
        "Install: pip install numpy pandas"
    ) from _e


@dataclass
class AttackResult:
    attack_name: str
    success: bool
    success_rate: float     # 0.0 - 1.0
    severity: str           # "critical", "high", "medium", "low"
    description: str
    vulnerable_columns: List[str] = field(default_factory=list)
    details: Dict[str, Any] = field(default_factory=dict)


@dataclass
class AttackReport:
    attacks_run: int = 0
    attacks_succeeded: int = 0
    results: List[Dict[str, Any]] = field(default_factory=list)
    overall_vulnerability: str = "safe"  # "safe", "moderate", "vulnerable", "critical"
    risk_score: float = 0.0
    summary: str = ""
    recommendations: List[str] = field(default_factory=list)
    degraded: bool = False
    errors: List[str] = field(default_factory=list)

    def to_dict(self) -> Dict[str, Any]:
        out = asdict(self)
        if not out.get("degraded"):
            out.pop("degraded", None)
            out.pop("errors", None)
        return out

    def to_json(self, indent: int = 2) -> str:
        return json.dumps(self.to_dict(), ensure_ascii=False, indent=indent, default=str)


class AttackSimulator:
    """
    Simulates privacy attacks against synthetic data to assess vulnerability.

    Usage:
        sim = AttackSimulator(original_df, synthetic_df)
        report = sim.run_all()
    """

    def __init__(self, original_df, synthetic_df, seed: int = 42):
        self.original = original_df
        self.synthetic = synthetic_df
        self.rng = np.random.default_rng(seed) if np is not None else None

    def run_all(self) -> AttackReport:
        """Run all attack simulations and return combined report."""
        report = AttackReport()
        attacks = [
            self._membership_inference_attack,
            self._model_inversion_attack,
            self._data_reconstruction_attack,
            self._attribute_inference_attack,
            self._k_anonymity_check,
        ]

        for attack_fn in attacks:
            try:
                result = attack_fn()
                report.results.append(asdict(result))
                report.attacks_run += 1
                if result.success:
                    report.attacks_succeeded += 1
            except Exception as e:
                _log.warning("fallback path activated: attack simulation failed for %s: %s", attack_fn.__name__, e)
                report.degraded = True
                report.errors.append(f"{attack_fn.__name__} failed")
                report.results.append(asdict(AttackResult(
                    attack_name=attack_fn.__name__.replace("_", " ").strip(),
                    success=False, success_rate=0.0, severity="low",
                    description=f"Attack simulation failed: {e}"
                )))
                report.attacks_run += 1

        # Compute overall vulnerability
        if report.attacks_succeeded == 0:
            report.overall_vulnerability = "safe"
            report.risk_score = 10.0
        elif report.attacks_succeeded <= 1:
            report.overall_vulnerability = "moderate"
            report.risk_score = 40.0
        elif report.attacks_succeeded <= 3:
            report.overall_vulnerability = "vulnerable"
            report.risk_score = 70.0
        else:
            report.overall_vulnerability = "critical"
            report.risk_score = 90.0

        report.summary = (
            f"Ran {report.attacks_run} attack simulations. "
            f"{report.attacks_succeeded} succeeded. "
            f"Vulnerability: {report.overall_vulnerability.upper()}."
        )

        # Recommendations
        for r in report.results:
            if r.get("success"):
                name = r.get("attack_name", "")
                if "membership" in name.lower():
                    report.recommendations.append(
                        "Add differential privacy noise to reduce membership inference risk."
                    )
                if "reconstruction" in name.lower():
                    report.recommendations.append(
                        "Increase synthetic data diversity; reduce exact-row similarity."
                    )
                if "inversion" in name.lower():
                    report.recommendations.append(
                        "Add feature perturbation to prevent attribute reconstruction."
                    )
                if "k-anonymity" in name.lower():
                    report.recommendations.append(
                        "Ensure quasi-identifiers have k≥5 equivalence classes."
                    )

        return report

    # ─── Attack 1: Membership Inference ───────────────────────────────────

    def _membership_inference_attack(self) -> AttackResult:
        """
        Distance-based membership inference attack.
        Tests if an attacker can determine whether a record was in the training set.
        """
        num_cols = [c for c in self.original.columns
                    if pd.api.types.is_numeric_dtype(self.original[c])
                    and c in self.synthetic.columns][:12]

        if len(num_cols) < 1:
            return AttackResult(
                attack_name="Membership Inference",
                success=False, success_rate=0.0, severity="low",
                description="Not enough numeric columns for MIA."
            )

        orig = self.original[num_cols].apply(pd.to_numeric, errors="coerce").fillna(0).values
        synth = self.synthetic[num_cols].apply(pd.to_numeric, errors="coerce").fillna(0).values

        # Normalize
        col_std = np.std(orig, axis=0)
        col_std[col_std == 0] = 1.0
        orig_norm = orig / col_std
        synth_norm = synth / col_std

        sample_n = min(200, len(orig_norm), len(synth_norm))
        orig_sample = orig_norm[self.rng.choice(len(orig_norm), size=sample_n, replace=False)]
        synth_sample = synth_norm[self.rng.choice(len(synth_norm), size=sample_n, replace=False)]

        # Compute minimum distances
        def min_dist(row, pool):
            diffs = pool - row
            return float(np.sqrt((diffs ** 2).sum(axis=1)).min())

        member_dists = [min_dist(r, orig_sample) for r in orig_sample]
        non_member_dists = [min_dist(r, orig_sample) for r in synth_sample]

        threshold = float(np.median(member_dists))
        tp = sum(1 for d in member_dists if d <= threshold)
        fp = sum(1 for d in non_member_dists if d <= threshold)
        accuracy = (tp + (sample_n - fp)) / (2 * sample_n)

        success = accuracy > 0.65
        return AttackResult(
            attack_name="Membership Inference",
            success=success,
            success_rate=round(accuracy, 4),
            severity="critical" if accuracy > 0.8 else "high" if accuracy > 0.65 else "low",
            description=(
                f"MIA accuracy: {accuracy:.1%}. "
                + ("Attacker can reliably determine training set membership." if success
                   else "Synthetic data resists membership inference.")
            ),
            vulnerable_columns=num_cols[:5],
            details={"accuracy": round(accuracy, 4), "threshold": round(threshold, 4),
                     "sample_size": sample_n}
        )

    # ─── Attack 2: Model Inversion ────────────────────────────────────────

    def _model_inversion_attack(self) -> AttackResult:
        """
        Attribute inference: given partial features, reconstruct sensitive attributes.
        """
        num_cols = [c for c in self.original.columns
                    if pd.api.types.is_numeric_dtype(self.original[c])
                    and c in self.synthetic.columns][:10]

        if len(num_cols) < 3:
            return AttackResult(
                attack_name="Model Inversion",
                success=False, success_rate=0.0, severity="low",
                description="Not enough columns for model inversion simulation."
            )

        target_col = num_cols[-1]  # Last numeric column as "sensitive"
        feature_cols = num_cols[:-1]

        # Use synthetic data to build a simple linear model
        X_synth = self.synthetic[feature_cols].apply(pd.to_numeric, errors="coerce").fillna(0).values
        y_synth = self.synthetic[target_col].apply(pd.to_numeric, errors="coerce").fillna(0).values

        # Simple least squares
        try:
            X_aug = np.column_stack([X_synth, np.ones(len(X_synth))])
            coeffs, _, _, _ = np.linalg.lstsq(X_aug, y_synth, rcond=None)
        except np.linalg.LinAlgError as e:
            raise RuntimeError(f"Model Inversion linear model fitting failed: {e}") from e

        # Test on original data
        X_orig = self.original[feature_cols].apply(pd.to_numeric, errors="coerce").fillna(0).values
        y_orig = self.original[target_col].apply(pd.to_numeric, errors="coerce").fillna(0).values
        X_orig_aug = np.column_stack([X_orig, np.ones(len(X_orig))])
        y_pred = X_orig_aug @ coeffs

        # Compute R² on original data
        ss_res = np.sum((y_orig - y_pred) ** 2)
        ss_tot = np.sum((y_orig - np.mean(y_orig)) ** 2)
        r2 = 1 - (ss_res / max(ss_tot, 1e-10))
        r2 = max(0.0, min(1.0, r2))

        success = r2 > 0.5
        return AttackResult(
            attack_name="Model Inversion",
            success=success,
            success_rate=round(r2, 4),
            severity="high" if r2 > 0.7 else "medium" if r2 > 0.5 else "low",
            description=(
                f"Model R² = {r2:.3f} for reconstructing '{target_col}'. "
                + ("Attacker can reconstruct sensitive attributes from synthetic data." if success
                   else "Reconstruction accuracy insufficient for successful attack.")
            ),
            vulnerable_columns=[target_col],
            details={"target_column": target_col, "r_squared": round(r2, 4),
                     "feature_cols": feature_cols}
        )

    # ─── Attack 3: Data Reconstruction ────────────────────────────────────

    def _data_reconstruction_attack(self) -> AttackResult:
        """
        Tests if synthetic rows are close enough to original rows to allow
        individual-level reconstruction.
        """
        num_cols = [c for c in self.original.columns
                    if pd.api.types.is_numeric_dtype(self.original[c])
                    and c in self.synthetic.columns][:10]

        if len(num_cols) < 2:
            return AttackResult(
                attack_name="Data Reconstruction",
                success=False, success_rate=0.0, severity="low",
                description="Not enough numeric columns."
            )

        orig = self.original[num_cols].apply(pd.to_numeric, errors="coerce").fillna(0).values
        synth = self.synthetic[num_cols].apply(pd.to_numeric, errors="coerce").fillna(0).values

        col_std = np.std(orig, axis=0)
        col_std[col_std == 0] = 1.0
        orig_norm = orig / col_std
        synth_norm = synth / col_std

        sample_n = min(200, len(synth_norm))
        synth_sample = synth_norm[self.rng.choice(len(synth_norm), size=sample_n, replace=False)]

        # For each synthetic row, find nearest original row
        close_count = 0
        threshold = 0.5  # Normalized distance threshold
        for row in synth_sample:
            dists = np.sqrt(((orig_norm - row) ** 2).sum(axis=1))
            min_dist = float(dists.min())
            if min_dist < threshold:
                close_count += 1

        close_rate = close_count / sample_n
        success = close_rate > 0.1  # >10% of synthetic rows dangerously close

        return AttackResult(
            attack_name="Data Reconstruction",
            success=success,
            success_rate=round(close_rate, 4),
            severity="critical" if close_rate > 0.3 else "high" if close_rate > 0.1 else "low",
            description=(
                f"{close_rate:.1%} of synthetic rows are within reconstruction distance. "
                + ("⚠ Synthetic dataset vulnerable to reconstruction." if success
                   else "Synthetic data has sufficient distance from originals.")
            ),
            vulnerable_columns=num_cols[:5],
            details={"close_rate": round(close_rate, 4), "threshold": threshold,
                     "sample_size": sample_n}
        )

    # ─── Attack 4: Attribute Inference ────────────────────────────────────

    def _attribute_inference_attack(self) -> AttackResult:
        """
        Tests if knowing some columns allows inferring a sensitive column value.
        Uses a nearest-neighbor approach on the synthetic data.
        """
        cat_cols = [c for c in self.original.columns
                    if not pd.api.types.is_numeric_dtype(self.original[c])
                    and c in self.synthetic.columns]
        num_cols = [c for c in self.original.columns
                    if pd.api.types.is_numeric_dtype(self.original[c])
                    and c in self.synthetic.columns][:8]

        if not cat_cols or len(num_cols) < 2:
            return AttackResult(
                attack_name="Attribute Inference",
                success=False, success_rate=0.0, severity="low",
                description="Not enough categorical + numeric columns."
            )

        target = cat_cols[0]
        features = num_cols[:6]

        # Build synthetic lookup
        synth_feat = self.synthetic[features].apply(pd.to_numeric, errors="coerce").fillna(0).values
        synth_labels = self.synthetic[target].fillna("__NA__").astype(str).values
        col_std = np.std(synth_feat, axis=0)
        col_std[col_std == 0] = 1.0
        synth_norm = synth_feat / col_std

        # Test on original data
        orig_feat = self.original[features].apply(pd.to_numeric, errors="coerce").fillna(0).values
        orig_labels = self.original[target].fillna("__NA__").astype(str).values
        orig_norm = orig_feat / col_std

        sample_n = min(100, len(orig_norm))
        indices = self.rng.choice(len(orig_norm), size=sample_n, replace=False)

        correct = 0
        for i in indices:
            dists = np.sqrt(((synth_norm - orig_norm[i]) ** 2).sum(axis=1))
            nn_idx = int(np.argmin(dists))
            if synth_labels[nn_idx] == orig_labels[i]:
                correct += 1

        accuracy = correct / sample_n
        # Random baseline
        unique_labels = len(set(orig_labels))
        baseline = 1.0 / max(unique_labels, 1)
        success = accuracy > baseline * 2  # Significantly better than random

        return AttackResult(
            attack_name="Attribute Inference",
            success=success,
            success_rate=round(accuracy, 4),
            severity="high" if accuracy > 0.7 else "medium" if success else "low",
            description=(
                f"Attribute inference accuracy: {accuracy:.1%} (baseline: {baseline:.1%}). "
                + (f"⚠ '{target}' values can be inferred from synthetic data features." if success
                   else "Inference accuracy is near baseline — low risk.")
            ),
            vulnerable_columns=[target],
            details={"target": target, "accuracy": round(accuracy, 4),
                     "baseline": round(baseline, 4), "sample_size": sample_n}
        )

    # ─── Attack 5: k-Anonymity Check ─────────────────────────────────────

    def _k_anonymity_check(self) -> AttackResult:
        """
        Check k-anonymity of the synthetic dataset.
        Low k values mean individual records can be uniquely identified.
        """
        # Use quasi-identifiers (categorical columns + binned numeric)
        cat_cols = [c for c in self.synthetic.columns
                    if not pd.api.types.is_numeric_dtype(self.synthetic[c])][:5]
        num_cols = [c for c in self.synthetic.columns
                    if pd.api.types.is_numeric_dtype(self.synthetic[c])][:3]

        if not cat_cols and not num_cols:
            return AttackResult(
                attack_name="k-Anonymity Check",
                success=False, success_rate=0.0, severity="low",
                description="No suitable quasi-identifiers found."
            )

        # Build quasi-identifier DataFrame
        qi = pd.DataFrame()
        for c in cat_cols:
            qi[c] = self.synthetic[c].fillna("__NA__").astype(str)
        for c in num_cols:
            vals = pd.to_numeric(self.synthetic[c], errors="coerce").fillna(0)
            # Bin into 10 buckets for quasi-identifier
            qi[c] = pd.cut(vals, bins=10, labels=False).fillna(0).astype(int)

        # Count group sizes
        group_sizes = qi.groupby(list(qi.columns)).size()
        min_k = int(group_sizes.min()) if len(group_sizes) > 0 else 0
        mean_k = float(group_sizes.mean()) if len(group_sizes) > 0 else 0
        unique_groups = int((group_sizes == 1).sum())
        total_groups = len(group_sizes)

        success = min_k < 3  # k < 3 is considered vulnerable
        return AttackResult(
            attack_name="k-Anonymity Check",
            success=success,
            success_rate=round(unique_groups / max(total_groups, 1), 4),
            severity="critical" if min_k == 1 else "high" if min_k < 3 else "medium" if min_k < 5 else "low",
            description=(
                f"k-anonymity: k={min_k} (mean={mean_k:.1f}). "
                f"{unique_groups}/{total_groups} groups are unique. "
                + ("⚠ Low k-anonymity — individual identification possible." if success
                   else "k-anonymity level is acceptable.")
            ),
            vulnerable_columns=cat_cols + num_cols,
            details={"min_k": min_k, "mean_k": round(mean_k, 2),
                     "unique_groups": unique_groups, "total_groups": total_groups}
        )


# ============================================================
# CLI
# ============================================================

def main(argv=None):
    import argparse
    p = argparse.ArgumentParser(description="Attack Simulator — Privacy attack simulation")
    p.add_argument("--original", required=True, help="Original dataset path")
    p.add_argument("--synthetic", required=True, help="Synthetic dataset path")
    p.add_argument("--output", default=None, help="Output report path")
    p.add_argument("--seed", type=int, default=42)
    args = p.parse_args(argv)

    def load(path):
        ext = os.path.splitext(path)[1].lower()
        if ext == ".csv":
            return pd.read_csv(path)
        if ext in (".json", ".jsonl"):
            return pd.read_json(path)
        if ext in (".xlsx", ".xls"):
            return pd.read_excel(path)
        if ext == ".parquet":
            return pd.read_parquet(path)
        return pd.read_csv(path)

    orig = load(args.original)
    synth = load(args.synthetic)

    sim = AttackSimulator(orig, synth, seed=args.seed)
    report = sim.run_all()

    if args.output:
        with open(args.output, "w", encoding="utf-8") as f:
            f.write(report.to_json())
        _log.info("Report saved to %s", args.output)
    else:
        sys.stdout.write(report.to_json() + "\n")

    return 0


if __name__ == "__main__":
    sys.exit(main())
