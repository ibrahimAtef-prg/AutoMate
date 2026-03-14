"""
validation.py — Validation Layer
=================================

Sits at stage 3b of the pipeline, between the generation engine and
the CheckPoint:

    generator engine  →  ValidationLayer  →  CheckPoint  →  agent

Three independent filters are run in order on every batch of generated
rows.  The unified interface is ValidationLayer.run().

Filters
-------
ConstraintFilter
    Hard constraint enforcement — numeric ranges, categorical allowed
    values, schema completeness.  Out-of-range numeric values are
    resampled from the column's marginal distribution (not clipped).

RowQualityFilter
    Statistical plausibility gate — three independent checks:
        A. IQR outer-fence (per column)
        B. Mahalanobis coherence (correlated pairs)
        C. Conditional label plausibility (labelled datasets only)
    Rows that fail more than max_failures checks are dropped entirely.

DuplicatePreFilter
    Exact-match deduplication against the original dataset using
    SHA-256 row hashes.  Prevents memorisation of training rows.

ValidationLayer
    Wraps all three filters into a single .run(df) call and returns a
    ValidationResult dataclass describing what was accepted and why
    individual rows were rejected.

Exports
-------
    ValidationResult      dataclass
    ConstraintFilter      class
    RowQualityFilter      class
    DuplicatePreFilter    class
    ValidationLayer       class

Dependencies
------------
    Required : numpy, pandas
    Optional : none
"""

from __future__ import annotations

import hashlib
import json
import math
from dataclasses import dataclass, field
from typing import Any, Dict, List, Optional, Tuple

import numpy as np
import pandas as pd


# ==================================================================
# Constants
# ==================================================================

_IQR_MULTIPLIER       = 3.0    # Tukey outer-fence multiplier
_MAHAL_THRESHOLD      = 9.21   # chi² (2 dof, p = 0.99) — 2-D joint outlier
_SIGMA_THRESHOLD      = 4.0    # max σ from class mean (Check C)
_DEDUP_WARN_RATIO     = 0.20   # warn when > 20 % of rows are exact duplicates


# ==================================================================
# Internal math helper (local copy avoids circular import with
# generator.py, which itself imports from this module)
# ==================================================================

def _nearest_pd(A: np.ndarray) -> np.ndarray:
    """Return the nearest positive-definite matrix to A (Higham 1988)."""
    B = (A + A.T) / 2
    eigvals, eigvecs = np.linalg.eigh(B)
    eigvals = np.maximum(eigvals, 1e-8)
    return eigvecs @ np.diag(eigvals) @ eigvecs.T


# ==================================================================
# ValidationResult — returned by ValidationLayer.run()
# ==================================================================

@dataclass
class ValidationResult:
    """
    Outcome of a single ValidationLayer.run() call.

    Attributes
    ----------
    clean_df : pd.DataFrame
        Rows that passed every enabled filter.  Ready for CheckPoint.

    n_evaluated : int
        Number of rows submitted to the layer.

    n_accepted : int
        Rows in clean_df.

    n_rejected_constraints : int
        Rows that violated a hard constraint (range / allowed values).
        These are *repaired* by ConstraintFilter, not dropped, so this
        counter reflects how many rows needed repair rather than how
        many were discarded.

    n_rejected_quality : int
        Rows dropped by RowQualityFilter (statistical plausibility).

    n_rejected_duplicates : int
        Rows dropped by DuplicatePreFilter (exact match with original).

    warnings : List[str]
        Human-readable messages for the generate() warnings output.
    """

    clean_df               : pd.DataFrame
    n_evaluated            : int            = 0
    n_accepted             : int            = 0
    n_rejected_constraints : int            = 0
    n_rejected_quality     : int            = 0
    n_rejected_duplicates  : int            = 0
    warnings               : List[str]      = field(default_factory=list)


# ==================================================================
# ConstraintFilter
# ==================================================================

class ConstraintFilter:
    """
    Hard-constraint enforcement layer.

    Numeric range violations are resolved by resampling from the
    column's quantile CDF — not by np.clip — so no boundary spikes
    are introduced.  Categorical allowed-value violations are replaced
    by sampling from the valid frequency distribution.

    Parameters
    ----------
    bl  : BaselineReader-compatible object (duck-typed)
    rng : np.random.Generator
    """

    def __init__(self, bl: Any, rng: np.random.Generator) -> None:
        self.bl  = bl
        self.rng = rng

    def apply(self, df: pd.DataFrame) -> Tuple[pd.DataFrame, int]:
        """
        Apply constraints to df.

        Returns
        -------
        (clean_df, n_repaired)
            clean_df    — DataFrame with all constraints satisfied.
            n_repaired  — number of cells that were out of range /
                          had invalid categorical values.
        """
        bl       = self.bl
        rng      = self.rng
        df       = df.copy()
        n_repair = 0

        # ---- 1. Numeric range enforcement (resample-retry, no clip) ----
        for col, (lo, hi) in bl.num_ranges.items():
            if col not in df.columns:
                continue
            if lo is None and hi is None:
                continue
            lo_f = float(lo) if lo is not None else -np.inf
            hi_f = float(hi) if hi is not None else  np.inf
            spec = bl.numeric.get(col, {})
            s    = pd.to_numeric(df[col], errors="coerce").values.copy()
            oob  = (s < lo_f) | (s > hi_f)
            if oob.any():
                n_repair += int(oob.sum())
                s = _resample_out_of_range(s, lo_f, hi_f, spec, rng)
            df[col] = s

        # ---- 2. Categorical allowed-values enforcement ----
        for col, allowed in bl.allowed.items():
            if col not in df.columns or not allowed:
                continue
            allowed_set  = set(str(v) for v in allowed)
            spec         = bl.categorical.get(col, {})
            ratios       = spec.get("top_value_ratios") or {}
            valid_ratios = {k: v for k, v in ratios.items()
                            if str(k) in allowed_set}
            if valid_ratios:
                choices = list(valid_ratios.keys())
                weights = np.array(list(valid_ratios.values()), dtype=float)
                weights = weights / weights.sum()
            else:
                choices = list(allowed)
                weights = np.ones(len(choices), dtype=float) / len(choices)

            mask  = df[col].apply(
                lambda x: x is not None and str(x) not in allowed_set
            )
            n_fix = int(mask.sum())
            if n_fix > 0:
                n_repair += n_fix
                replacements = np.array(choices, dtype=object)[
                    rng.choice(len(choices), size=n_fix, p=weights)
                ]
                df.loc[mask, col] = replacements

        # ---- 3. Schema completeness ----
        for col in bl.col_order:
            if col not in df.columns:
                df[col] = None
        df = df[[c for c in bl.col_order if c in df.columns]]

        return df, n_repair


# ==================================================================
# RowQualityFilter
# ==================================================================

class RowQualityFilter:
    """
    Statistical plausibility gate — three independent checks per row.

    Check A — IQR outer fence
        Each numeric column value is checked against
        [Q1 − k·IQR, Q3 + k·IQR] where k = 3.0 (Tukey outer fence).
        Falls back to mean ± 3σ when IQR statistics are absent.

    Check B — Mahalanobis coherence
        For every strongly correlated numeric pair (|r| ≥ 0.4), the
        pair of values is mapped to standard-score space and its
        Mahalanobis distance is compared against the chi-squared 99th
        percentile (d² > 9.21 ⇒ joint outlier).  Catches incoherent
        combinations such as (age=18, income=145 000) in a dataset
        where age ↔ income correlation is 0.70.

    Check C — Conditional label plausibility  (labelled datasets only)
        Each numeric feature is checked against the mean ± σ_threshold·σ
        of the class it was assigned to.  Requires build_class_stats()
        to have been called on the BaselineReader.

    A row is REJECTED when it fails more than max_failures checks.
    Rejected rows are never repaired — they are dropped so the engine
    can regenerate them from scratch.

    Parameters
    ----------
    bl           : BaselineReader-compatible object (duck-typed)
    max_failures : int   default 1 — any single failure rejects the row
    """

    def __init__(self, bl: Any, max_failures: int = 1) -> None:
        self.bl           = bl
        self.max_failures = max_failures

        # Pre-compute IQR fences once at construction time
        self._iqr_fences: Dict[str, Tuple[float, float]] = {}
        for col, spec in bl.numeric.items():
            q25 = spec.get("q25")
            q75 = spec.get("q75")
            if q25 is None or q75 is None:
                mean = spec.get("mean")
                std  = spec.get("std")
                if mean is not None and std is not None and float(std) > 0:
                    s = float(std)
                    self._iqr_fences[col] = (
                        float(mean) - 3.0 * s,
                        float(mean) + 3.0 * s,
                    )
                continue
            iqr = float(q75) - float(q25)
            if iqr <= 0:
                continue
            self._iqr_fences[col] = (
                float(q25) - _IQR_MULTIPLIER * iqr,
                float(q75) + _IQR_MULTIPLIER * iqr,
            )

        # Pre-compute inverse covariance for each correlated pair (Check B)
        self._pair_params: Dict[Tuple[str, str], Tuple] = {}
        for col_a, col_b, r in bl.strong_pearson_pairs(threshold=0.4):
            spec_a = bl.numeric.get(col_a, {})
            spec_b = bl.numeric.get(col_b, {})
            mean_a, std_a = spec_a.get("mean"), spec_a.get("std")
            mean_b, std_b = spec_b.get("mean"), spec_b.get("std")
            if any(x is None for x in [mean_a, std_a, mean_b, std_b]):
                continue
            sa, sb = float(std_a), float(std_b)
            if sa <= 0 or sb <= 0:
                continue
            cov2 = _nearest_pd(np.array([[1.0, r], [r, 1.0]], dtype=float))
            try:
                inv_cov2 = np.linalg.inv(cov2)
            except np.linalg.LinAlgError:
                continue
            self._pair_params[(col_a, col_b)] = (
                float(mean_a), sa, float(mean_b), sb, inv_cov2,
            )

    # ------------------------------------------------------------------

    def evaluate(self, df: pd.DataFrame) -> np.ndarray:
        """
        Return a boolean mask: True = accepted, False = rejected.

        Parameters
        ----------
        df : pd.DataFrame   — rows to evaluate

        Returns
        -------
        np.ndarray of bool, shape (len(df),)
        """
        n          = len(df)
        fail_count = np.zeros(n, dtype=int)

        # ---- Check A: IQR outer fence ----
        for col, (lo_f, hi_f) in self._iqr_fences.items():
            if col not in df.columns:
                continue
            vals     = pd.to_numeric(df[col], errors="coerce").values
            not_null = ~np.isnan(vals)
            outside  = not_null & ((vals < lo_f) | (vals > hi_f))
            fail_count += outside.astype(int)

        # ---- Check B: Mahalanobis coherence ----
        for (col_a, col_b), params in self._pair_params.items():
            if col_a not in df.columns or col_b not in df.columns:
                continue
            mean_a, std_a, mean_b, std_b, inv_cov2 = params
            a     = pd.to_numeric(df[col_a], errors="coerce").values
            b     = pd.to_numeric(df[col_b], errors="coerce").values
            valid = ~(np.isnan(a) | np.isnan(b))
            if not valid.any():
                continue
            za = np.where(valid, (a - mean_a) / std_a, 0.0)
            zb = np.where(valid, (b - mean_b) / std_b, 0.0)
            d2 = (za * (inv_cov2[0, 0] * za + inv_cov2[0, 1] * zb) +
                  zb * (inv_cov2[1, 0] * za + inv_cov2[1, 1] * zb))
            fail_count += (valid & (d2 > _MAHAL_THRESHOLD)).astype(int)

        # ---- Check C: Conditional label plausibility ----
        bl = self.bl
        if (bl.label_col
                and bl.label_col in df.columns
                and bl.class_numeric_stats):
            labels = df[bl.label_col].astype(str).values
            for col, class_stats in bl.class_numeric_stats.items():
                if col not in df.columns:
                    continue
                vals = pd.to_numeric(df[col], errors="coerce").values
                for lv, stats in class_stats.items():
                    cmean = stats.get("mean")
                    cstd  = stats.get("std")
                    if cmean is None or cstd is None or float(cstd) <= 0:
                        continue
                    lv_mask  = labels == lv
                    not_null = ~np.isnan(vals)
                    z        = np.abs((vals - float(cmean)) / float(cstd))
                    outside  = lv_mask & not_null & (z > _SIGMA_THRESHOLD)
                    fail_count += outside.astype(int)

        return fail_count <= self.max_failures

    def summary(self, mask: np.ndarray) -> Dict[str, Any]:
        """Brief summary dict for logging."""
        n_total    = len(mask)
        n_accepted = int(mask.sum())
        return {
            "total_evaluated": n_total,
            "accepted":        n_accepted,
            "rejected":        n_total - n_accepted,
            "acceptance_rate": round(n_accepted / max(n_total, 1), 4),
        }


# ==================================================================
# DuplicatePreFilter
# ==================================================================

class DuplicatePreFilter:
    """
    Exact-match deduplication against the original dataset.

    Hashes every generated row with SHA-256 and drops any that match
    a hash of an original row.  Prevents memorisation / leakage of
    training data into the synthetic output.

    Parameters
    ----------
    original_df : pd.DataFrame — the training dataset to guard against
    """

    def __init__(self, original_df: pd.DataFrame) -> None:
        self._original_hashes: set = self._hash_df(original_df)

    @staticmethod
    def _hash_row(row: Dict[str, Any]) -> str:
        canonical = json.dumps(
            {k: (None if (v is None
                          or (isinstance(v, float) and math.isnan(v)))
                 else v)
             for k, v in sorted(row.items())},
            ensure_ascii=False,
            sort_keys=True,
            default=str,
        )
        return hashlib.sha256(canonical.encode("utf-8")).hexdigest()

    def _hash_df(self, df: pd.DataFrame) -> set:
        return {self._hash_row(r) for r in df.to_dict(orient="records")}

    def filter(
        self,
        df:          pd.DataFrame,
        requested_n: int,
    ) -> Tuple[pd.DataFrame, List[str], int]:
        """
        Remove rows that exactly match the original dataset.

        Returns
        -------
        (clean_df, warnings, n_dropped)
        """
        warnings: List[str] = []
        hashes    = [self._hash_row(r) for r in df.to_dict(orient="records")]
        mask      = [h not in self._original_hashes for h in hashes]
        clean     = df[mask].reset_index(drop=True)
        dropped   = len(df) - len(clean)

        if dropped > 0:
            ratio = dropped / max(requested_n, 1)
            warnings.append(
                f"DuplicatePreFilter: dropped {dropped} row(s) that were exact "
                f"matches with the original dataset ({ratio:.1%} of requested "
                f"{requested_n})."
            )
            if ratio > _DEDUP_WARN_RATIO:
                warnings.append(
                    "WARNING: More than 20% of generated rows were duplicates "
                    "of the original dataset.  The dataset may have low "
                    "diversity.  Consider reviewing with the Leakage Agent."
                )
        return clean, warnings, dropped


# ==================================================================
# ValidationLayer — unified interface
# ==================================================================

class ValidationLayer:
    """
    Single entry point for all validation logic.

    Runs ConstraintFilter → RowQualityFilter → DuplicatePreFilter
    (DuplicatePreFilter is skipped when original_df is not supplied).

    Parameters
    ----------
    bl            : BaselineReader-compatible object
    rng           : np.random.Generator   (required for ConstraintFilter)
    original_df   : pd.DataFrame | None  — original dataset for dedup;
                    pass None to skip DuplicatePreFilter
    max_failures  : int   default 1 — RowQualityFilter strictness

    Usage
    -----
    >>> vl = ValidationLayer(bl, rng=rng, original_df=df_orig)
    >>> result = vl.run(batch_df, n_requested=100)
    >>> good_rows = result.clean_df
    """

    def __init__(
        self,
        bl:           Any,
        rng:          Optional[np.random.Generator] = None,
        original_df:  Optional[pd.DataFrame]        = None,
        max_failures: int                            = 1,
    ) -> None:
        self._cf  = ConstraintFilter(bl,  rng or np.random.default_rng())
        self._rqf = RowQualityFilter(bl,  max_failures=max_failures)
        self._dpf = (DuplicatePreFilter(original_df)
                     if original_df is not None else None)

    # ------------------------------------------------------------------

    def run(
        self,
        df:          pd.DataFrame,
        n_requested: int,
    ) -> ValidationResult:
        """
        Run all filters on df and return a ValidationResult.

        Parameters
        ----------
        df          : raw batch from the generation engine
        n_requested : the original row target (used for dedup ratio)

        Returns
        -------
        ValidationResult
        """
        warnings:    List[str] = []
        n_evaluated: int       = len(df)

        # ---- Step 1: ConstraintFilter (repair, not drop) ----
        df, n_repaired = self._cf.apply(df)
        if n_repaired > 0:
            warnings.append(
                f"ConstraintFilter: repaired {n_repaired} out-of-range / "
                "invalid-category cells via resample-retry."
            )

        # ---- Step 2: RowQualityFilter (drop) ----
        quality_mask = self._rqf.evaluate(df)
        n_dropped_q  = int((~quality_mask).sum())
        if n_dropped_q > 0:
            rate = n_dropped_q / max(n_evaluated, 1)
            warnings.append(
                f"RowQualityFilter: rejected {n_dropped_q}/{n_evaluated} rows "
                f"({rate:.1%}) — statistical plausibility checks failed."
            )
        df = df[quality_mask].reset_index(drop=True)

        # ---- Step 3: DuplicatePreFilter (drop, optional) ----
        n_dropped_d = 0
        if self._dpf is not None and len(df) > 0:
            df, dedup_warns, n_dropped_d = self._dpf.filter(df, n_requested)
            warnings.extend(dedup_warns)

        n_accepted = len(df)

        return ValidationResult(
            clean_df               = df,
            n_evaluated            = n_evaluated,
            n_accepted             = n_accepted,
            n_rejected_constraints = n_repaired,
            n_rejected_quality     = n_dropped_q,
            n_rejected_duplicates  = n_dropped_d,
            warnings               = warnings,
        )


# ==================================================================
# Internal sampling helper (mirrors generator.py's implementation;
# kept local to avoid importing from generator.py)
# ==================================================================

def _build_quantile_cdf(
    spec: Dict[str, Any],
) -> Tuple[Optional[np.ndarray], Optional[np.ndarray]]:
    lo = spec.get("min")
    hi = spec.get("max")
    if lo is None or hi is None:
        return None, None
    lo, hi = float(lo), float(hi)
    anchors: List[Tuple[float, float]] = [(0.0, lo), (1.0, hi)]
    for key, level in (
        ("q01", 0.01), ("q05", 0.05), ("q25", 0.25),
        ("q50", 0.50),
        ("q75", 0.75), ("q95", 0.95), ("q99", 0.99),
    ):
        val = spec.get(key)
        if val is not None:
            anchors.append((level, float(val)))
    has_q50 = any(abs(lv - 0.50) < 1e-9 for lv, _ in anchors)
    if not has_q50:
        mean_val = spec.get("mean")
        if mean_val is not None:
            anchors.append((0.50, float(mean_val)))
    anchors.sort(key=lambda x: x[0])
    deduped: Dict[float, float] = {}
    for lv, val in anchors:
        deduped[lv] = val
    levels = np.array(sorted(deduped.keys()), dtype=float)
    values = np.array([deduped[l] for l in levels], dtype=float)
    for i in range(1, len(values)):
        if values[i] < values[i - 1]:
            values[i] = values[i - 1]
    return levels, values


def _resample_out_of_range(
    arr:          np.ndarray,
    lo:           float,
    hi:           float,
    spec:         Dict[str, Any],
    rng:          np.random.Generator,
    max_attempts: int = 10,
) -> np.ndarray:
    out_mask = (arr < lo) | (arr > hi)
    if not out_mask.any():
        return arr
    arr = arr.copy()
    levels, values = _build_quantile_cdf(spec)
    for _ in range(max_attempts):
        still_out = np.where(out_mask)[0]
        if len(still_out) == 0:
            break
        if levels is not None:
            u     = rng.uniform(0.0, 1.0, size=len(still_out))
            fresh = np.interp(u, levels, values)
        else:
            mean_v = float(spec.get("mean", (lo + hi) / 2))
            std_v  = float(spec.get("std",  (hi - lo) / 4)) or 1e-6
            fresh  = rng.normal(mean_v, std_v, size=len(still_out))
        arr[still_out]      = fresh
        out_mask[still_out] = (fresh < lo) | (fresh > hi)
    remaining = np.where(out_mask)[0]
    if len(remaining) > 0:
        arr[remaining] = np.where(arr[remaining] < lo, lo, hi)
    return arr