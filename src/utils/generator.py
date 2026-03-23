"""
generator.py — Synthetic Data Generation Engine
================================================

Sits at stage 3 of the pipeline:

    parse.py → baseline.py → generator.py → leakage_agent.py

Reads the BaselineArtifact produced by baseline.py and generates
synthetic structured data that preserves the statistical properties
of the original dataset.

Invocation (from extension.ts via cp.spawn)
-------------------------------------------
    python generator.py <dataset_path> <baseline_json_path>
                        --n <count>
                        --cache-dir <dir>

Output (stdout, JSON)
---------------------
    {
        "samples":            [...],        # list of row dicts
        "generator_used":     "statistical|probabilistic|ctgan",
        "row_count":          500,
        "dataset_fingerprint": "abc123...",
        "warnings":           []
    }

Engine selection by dataset size
---------------------------------
    rows <  1 000                → StatisticalEngine
    1 000 <= rows < 50 000       → ProbabilisticEngine  (Gaussian copula)
    rows >= 50 000               → CTGANEngine           (falls back to
                                                          Probabilistic if
                                                          ctgan not installed)

Model caching
-------------
    Trained models are serialised to:
        <cache_dir>/<fingerprint>_<engine>.pkl
    On cache hit the model is loaded and .sample(n) is called directly,
    skipping retraining entirely.

Dependencies
------------
    Required : pandas, numpy          (already present via baseline.py)
    Optional : ctgan                  (only needed for CTGANEngine;
                                       graceful fallback if missing)
"""

from __future__ import annotations

import argparse
import logging as _logging
import hashlib
import json
import math
import os
import pickle
import re
import sys
import time
import uuid
import warnings as _warnings_mod
from typing import Any, Dict, List, Optional, Tuple

import numpy as np
import pandas as pd

# ctgan is optional — we detect it at import time and degrade gracefully
try:
    from ctgan import CTGANSynthesizer  # type: ignore
    _CTGAN_AVAILABLE = True
except ImportError:
    _CTGAN_AVAILABLE = False

# Validation layer — ConstraintFilter, RowQualityFilter, DuplicatePreFilter
# are all owned by validation.py. generator.py uses the unified interface.
try:  # noqa: E402
    from src.utils.validation import ValidationLayer, ValidationResult  # type: ignore
except ImportError:  # noqa: E402
    from validation import ValidationLayer, ValidationResult  # type: ignore

# CheckPoint — atomic per-run row store and agent polling interface.
try:  # noqa: E402
    from src.utils.checkp import CheckPoint  # type: ignore
except ImportError:  # noqa: E402
    from checkp import CheckPoint  # type: ignore

_log = _logging.getLogger(__name__)


def _write_run_log(result: dict, path: str = "runs_log.jsonl") -> None:
    _pipeline_status = result.get("pipeline_status") or {}
    entry = {
        "timestamp": time.time(),
        "row_count": result.get("row_count"),
        "engine": result.get("generator_used"),
        "status": _pipeline_status.get("status_code") or _pipeline_status.get("code"),
        "warnings": result.get("quality_warnings", []),
    }
    try:
        with open(path, "a", encoding="utf-8") as f:
            f.write(json.dumps(entry) + "\n")
    except OSError as exc:
        _log.warning("run log write skipped: %s", exc)

# ── Error model import (CORE: fail-fast) ─────────────────────────────────────
import importlib.util as _ilu_gen, os as _os_gen
_errs_path_gen = _os_gen.path.normpath(
    _os_gen.path.join(_os_gen.path.dirname(_os_gen.path.abspath(__file__)), "errors.py")
)
_errs_spec_gen = _ilu_gen.spec_from_file_location("utils.errors", _errs_path_gen)
if "utils.errors" in __import__("sys").modules:
    _errs_mod_gen = __import__("sys").modules["utils.errors"]
    __import__("sys").modules.setdefault("errors", _errs_mod_gen)
elif "errors" in __import__("sys").modules:
    _errs_mod_gen = __import__("sys").modules["errors"]
    __import__("sys").modules["utils.errors"] = _errs_mod_gen
else:
    _errs_mod_gen = _errs_mod_gen  = _ilu_gen.module_from_spec(_errs_spec_gen)
    __import__("sys").modules["utils.errors"] = _errs_mod_gen
    __import__("sys").modules["errors"] = _errs_mod_gen
    _errs_spec_gen.loader.exec_module(_errs_mod_gen)
_InputValidationError = _errs_mod_gen.InputValidationError
_PipelineError        = _errs_mod_gen.PipelineError
_SchemaError          = _errs_mod_gen.SchemaError
_ErrorCode            = _errs_mod_gen.ErrorCode

# ------------------------------------------------------------------
# Domain exceptions
# ------------------------------------------------------------------

class PipelineError(Exception):
    """
    Base class for all domain-specific errors raised by the generator
    pipeline.  Catch PipelineError to handle any pipeline-layer failure
    without accidentally suppressing unrelated built-in exceptions.

    Subclasses must provide a clear, human-readable message that
    identifies the failing component and the corrective action.
    """


class SchemaValidationError(PipelineError):
    """
    Raised when a baseline spec is structurally invalid or missing a
    required field that the generator layer depends on.

    Using a named exception rather than KeyError makes the failure mode
    unambiguous — callers can catch SchemaValidationError explicitly
    without risking suppression of unrelated KeyErrors from dict access.
    """

# ------------------------------------------------------------------
# Constants
# ------------------------------------------------------------------

_SMALL_THRESHOLD    = 1_000    # rows below this → StatisticalEngine
_LARGE_THRESHOLD    = 50_000   # rows at/above   → CTGANEngine
_MAX_RESAMPLE       = 3        # constraint re-sample attempts before clamp
_MAX_QUALITY_ROUNDS = 8        # hard cap on ValidationLayer retry rounds
_BATCH_SIZE_MAX     = 5_000_000  # Phase 5: absolute batch size ceiling (DoS guard)

# ------------------------------------------------------------------
# Cache integrity constants (F-4 / F-5 / F-6)
# ------------------------------------------------------------------
_CACHE_SCHEMA_VERSION    = "1.0"   # bump when cached payload structure changes
_GENERATOR_VERSION       = "1.0"   # bump when engine math changes (forces retrain)
_CACHE_TTL_SEC           = 86_400  # F-6: invalidate cache older than 24 h

# ------------------------------------------------------------------
# Constraint failure threshold (F-8 / Phase 7)
# ------------------------------------------------------------------
_MIN_ACCEPTANCE_RATE     = 0.02    # if accepted/evaluated < 2 % for 2 rounds → fail

# ------------------------------------------------------------------
# Status codes (F-7 / Phase 6)
# ------------------------------------------------------------------

class StatusCode:
    """Deterministic status code enum for PipelineStatus.code."""
    COMPLETE             = "COMPLETE"
    PARTIAL              = "PARTIAL"
    FAILED_CONSTRAINTS   = "FAILED_CONSTRAINTS"
    FAILED_ACCEPTANCE    = "FAILED_ACCEPTANCE"
    EMPTY_BASELINE       = "EMPTY_BASELINE"
    INVALID_INPUT        = "INVALID_INPUT"
    FAILED_UNKNOWN       = "FAILED_UNKNOWN"


class PipelineStatus:
    """
    F-7: Structured status object replacing bare string status.

    Attributes
    ----------
    state  : str  — "complete" | "partial" | "failed"
    reason : str  — human-readable explanation
    code   : str  — StatusCode constant for programmatic branching
    """
    __slots__ = ("state", "reason", "code")

    def __init__(self, state: str, reason: str, code: str) -> None:
        self.state  = state
        self.reason = reason
        self.code   = code

    def to_dict(self) -> Dict[str, str]:
        return {"state": self.state, "reason": self.reason, "code": self.code}

    def __repr__(self) -> str:
        return f"PipelineStatus(state={self.state!r}, code={self.code!r})"

# ------------------------------------------------------------------
# STRICT_MODE — determinism enforcement (Group M)
# ------------------------------------------------------------------
# When True:
#   • A fixed seed (42) is used if no seed is supplied by the caller.
#   • Any call that would introduce unreproducible randomness without a
#     seed raises a RuntimeError immediately — no silent fallback.
# Set STRICT_MODE = False only in explicit exploratory/research contexts.
STRICT_MODE: bool = True
_STRICT_SEED:  int = 42   # canonical fallback seed in STRICT_MODE

# ------------------------------------------------------------------
# Precision policy — single source of truth
# ------------------------------------------------------------------
# All rounding in the generator must use this dict.
# No hardcoded decimal counts are permitted elsewhere.
#
#   "continuous"  — general real-valued columns       → 4 decimal places
#   "probability" — values bounded in [0, 1]          → 4 decimal places
#   "percentage"  — values bounded in [0, 100]        → 2 decimal places
#                   (reserved; not auto-assigned by baseline.py)
#
PRECISION_RULES: Dict[str, int] = {
    "continuous":  4,
    "probability": 4,
    "percentage":  2,
    # "categorical" is a special mode for binary/integer indicator columns
    # that have numeric dtype but are not distributions.  normalize_numeric()
    # returns the value as-is (int cast, 0 decimal places) — no distribution
    # rounding is applied because the column is not a statistical signal.
    "categorical": 0,
}


# ------------------------------------------------------------------
# Class-distribution utilities
# ------------------------------------------------------------------

def _validate_label_distribution(
    dist: Dict[str, float],
    bl:   "BaselineReader",
) -> None:
    """
    Validate a user-supplied label distribution dict.

    Rules
    -----
    1. Must be a non-empty dict.
    2. No negative weights.
    3. All keys must appear in the baseline label distribution
       (i.e. they must be known classes).
    4. Weights must sum to 1.0 within ±1e-6 tolerance.
       (The only place in this codebase where tolerance is intentional:
       floating-point arithmetic on user-supplied fractions — e.g.
       0.3 + 0.3 + 0.4 — can differ from 1.0 by ε ≈ 1e-16 to 1e-7.)

    Raises
    ------
    ValueError — for any violation, with a precise diagnostic message.
    """
    if not isinstance(dist, dict) or not dist:
        raise _InputValidationError(
            _ErrorCode.INVALID_DISTRIBUTION,
            "_validate_label_distribution: distribution must be a non-empty dict.",
        )

    # Rule 2 — no negative weights
    negatives = {k: v for k, v in dist.items() if v < 0.0}
    if negatives:
        raise _InputValidationError(
            _ErrorCode.INVALID_DISTRIBUTION,
            f"_validate_label_distribution: negative weights are not allowed. "
            f"Offending entries: {negatives}",
        )

    # Rule 3 — all labels must exist in the baseline
    if bl.label_col is None:
        raise _InputValidationError(
            _ErrorCode.INVALID_DISTRIBUTION,
            "_validate_label_distribution: no label column was detected in the "
            "baseline.  Cannot apply a class distribution without a target column.",
        )
    known = set(bl.label_dist.keys())
    unknown = set(dist.keys()) - known
    if unknown:
        raise _InputValidationError(
            _ErrorCode.INVALID_DISTRIBUTION,
            f"_validate_label_distribution: the following labels do not exist "
            f"in the baseline: {sorted(unknown)}.  "
            f"Known labels: {sorted(known)}",
        )

    # Rule 4 — weights sum to 1.0 ±1e-6
    total = sum(dist.values())
    if abs(total - 1.0) > 1e-6:
        raise _InputValidationError(
            _ErrorCode.INVALID_DISTRIBUTION,
            f"_validate_label_distribution: weights must sum to 1.0 "
            f"(±1e-6), got {total!r}.  "
            f"Received distribution: {dist}",
        )


def _sample_labels_exact(
    dist: Dict[str, float],
    n:    int,
    rng:  np.random.Generator,
) -> np.ndarray:
    """
    Produce an array of exactly *n* label values whose class counts
    match *dist* as closely as possible under integer rounding.

    Algorithm
    ---------
    1. Compute raw count for each class: ``floor(n * weight)``.
    2. The residual (``n - sum(floor_counts)``) is distributed to the
       classes with the largest fractional remainders (standard
       largest-remainder method), ensuring total == n exactly.
    3. Build the array by repeating each label its allocated count.
    4. Shuffle in-place with *rng* to eliminate ordering bias.

    Returns
    -------
    np.ndarray of dtype object, length n.
    """
    labels  = list(dist.keys())
    weights = [dist[l] for l in labels]

    # Step 1 — floor counts
    raw_counts  = [n * w for w in weights]
    floor_counts = [int(c) for c in raw_counts]
    residual     = n - sum(floor_counts)

    # Step 2 — distribute residual by largest remainder
    if residual > 0:
        fractions = [(rc - fc, i)
                     for i, (rc, fc) in enumerate(zip(raw_counts, floor_counts))]
        fractions.sort(key=lambda x: x[0], reverse=True)
        for _, i in fractions[:residual]:
            floor_counts[i] += 1

    # Step 3 — build array
    arr = np.array(
        [label for label, cnt in zip(labels, floor_counts) for _ in range(cnt)],
        dtype=object,
    )

    # Step 4 — shuffle
    rng.shuffle(arr)
    return arr


# ------------------------------------------------------------------
# Precision-control utilities
# ------------------------------------------------------------------

def normalize_numeric(value: float, mode: str) -> float:
    """
    Enforce the precision policy on a single numeric value.

    Parameters
    ----------
    value : float — the value to normalise.  Must be finite.
    mode  : str   — must be a key in PRECISION_RULES.

    Returns
    -------
    float rounded to the number of decimal places defined by PRECISION_RULES[mode].

    Raises
    ------
    ValueError — if value is NaN or ±Infinity (non-finite values are invalid
                 at this stage; callers must handle nulls before calling).
    ValueError — if mode is "probability" and value is outside [0.0, 1.0].
                 Out-of-range probabilities indicate upstream data errors and
                 must NOT be silently clamped — they must be rejected.
    ValueError — if mode is not a key in PRECISION_RULES.

    Notes
    -----
    This function performs ONLY rounding.
    It does NOT clamp, zero small values, substitute Inf with large constants,
    or apply any other silent transformation.  Any such transformation
    would constitute statistical distortion and is forbidden.
    """
    if mode not in PRECISION_RULES:
        raise _InputValidationError(_ErrorCode.INVALID_SCHEMA, 
            f"normalize_numeric: unknown mode '{mode}'. "
            f"Valid modes: {list(PRECISION_RULES)}"
        )
    if not math.isfinite(value):
        raise _InputValidationError(_ErrorCode.INVALID_SCHEMA, 
            f"normalize_numeric: received non-finite value {value!r} "
            f"(mode='{mode}'). Non-finite values must be handled as nulls "
            "before normalization."
        )

    if mode == "probability" and not (0.0 <= value <= 1.0):
        raise _InputValidationError(_ErrorCode.INVALID_SCHEMA, 
            f"normalize_numeric: probability value {value!r} is outside [0.0, 1.0]. "
            "Out-of-range probability values must be corrected at the data source, "
            "not silently clamped here."
        )

    return round(value, PRECISION_RULES[mode])


def _normalize_df_numerics(df: pd.DataFrame, bl: "BaselineReader") -> pd.DataFrame:
    """
    Apply normalize_numeric() to every numeric column in *df* that appears
    in the baseline's numeric spec.

    Precision mode is read from ``bl.numeric[col]["precision_mode"]`` — the
    field that baseline.py writes once from observed data ranges.  If the
    field is absent the function raises SchemaValidationError immediately
    (fail-fast): a missing mode means either a pre-hardening baseline or a
    schema mismatch, both of which must be fixed at the source.

    Contract
    --------
    • Mode is NEVER inferred at generation time.  It comes exclusively from
      the stored baseline.
    • Non-finite values (Inf) in a numeric column raise ValueError.
    • Out-of-range probability values raise ValueError (no clamping).
    • NaN cells (intentional nulls) are excluded from normalisation via
      ``notna()`` and are explicitly converted to ``None`` (Python object)
      before the DataFrame is returned.  This guarantees that no float NaN
      reaches ``_df_to_json_records``, making any NaN at that boundary an
      unambiguous contract violation.
    • Returns a copy of df; the input is not modified.

    Raises
    ------
    SchemaValidationError — if ``precision_mode`` is absent from a column's
                            baseline spec.
    ValueError — if a non-finite (Inf) value is encountered in a numeric column.
    ValueError — if a probability column contains a value outside [0.0, 1.0].
    """
    if df.empty:
        return df

    df = df.copy()
    for col in df.columns:
        if col not in bl.numeric:
            continue  # not a numeric column — leave untouched

        spec = bl.numeric[col]

        # Fail fast: mode must be explicitly declared in the baseline spec.
        if "precision_mode" not in spec:
            raise SchemaValidationError(
                f"_normalize_df_numerics: column '{col}' has no 'precision_mode' "
                "in its baseline spec.  Re-run baseline analysis to populate it."
            )
        mode = spec["precision_mode"]

        series = df[col]
        mask   = series.notna()  # identify non-null cells for normalisation

        # Convert column to object dtype so None is preserved as None
        # (not coerced to float NaN by pandas on assignment).
        # Then explicitly replace any float NaN (which represents null cells
        # in the original float64 column) with Python None.
        # This guarantees that null cells leave this function as Python None,
        # never as float NaN, making NaN at serialisation time an explicit error.
        df[col] = df[col].astype(object).where(df[col].notna(), None)
        series  = df[col]

        if not mask.any():
            # All cells are null — nothing to normalise; null status already preserved.
            continue

        non_null = series[mask]

        # Reject any non-finite values — Inf is not a valid generated value.
        inf_mask = non_null.apply(lambda v: not math.isfinite(float(v)) if v is not None else False)
        if inf_mask.any():
            bad_idx = non_null.index[inf_mask].tolist()
            raise _InputValidationError(_ErrorCode.INVALID_SCHEMA, 
                f"_normalize_df_numerics: non-finite value(s) in column '{col}' "
                f"at index positions {bad_idx[:5]}{'...' if len(bad_idx) > 5 else ''}. "
                "Non-finite values are invalid at the normalisation boundary."
            )

        df.loc[mask, col] = non_null.apply(
            lambda v: normalize_numeric(float(v), mode)
        )

    return df


# ==================================================================
# Section 1 — BaselineReader
# Read and normalise the BaselineArtifact JSON into plain dicts
# so every engine works with simple Python types, not nested
# dataclass shapes.
# ==================================================================

class BaselineReader:
    """
    Adapts the BaselineArtifact JSON (produced by baseline.py) into
    flat, engine-friendly structures.

    Attributes
    ----------
    fingerprint : str
    row_count   : int
    col_order   : list[str]   ordered column names from the baseline
    numeric     : dict        col → NumericColumnBaseline fields as dict
    categorical : dict        col → CategoricalColumnBaseline fields as dict
    other       : dict        col → {"dtype": ..., "null_ratio": ...}
    pearson     : dict        "a__b" → float
    cramers_v   : dict        "a__b" → float   (cat↔cat)
    pb          : dict        "cat__num" → float (cat↔num)
    num_ranges  : dict        col → (min, max)
    allowed     : dict        col → [str, ...]
    """

    def __init__(self, artifact: Dict[str, Any]) -> None:
        meta        = artifact.get("meta",         {})
        columns     = artifact.get("columns",      {})
        correlations = artifact.get("correlations", {})
        constraints = artifact.get("constraints",  {})

        self.fingerprint : str       = meta.get("dataset_fingerprint", "")
        self.row_count   : int       = int(meta.get("row_count") or 0)
        self.source      : str       = meta.get("dataset_source", "")

        self.numeric     : Dict[str, Dict[str, Any]] = columns.get("numeric",     {})
        self.categorical : Dict[str, Dict[str, Any]] = columns.get("categorical", {})
        self.other       : Dict[str, Dict[str, Any]] = columns.get("other",       {})

        # Column order: numeric first, then categorical, then other
        # This is stable and deterministic across runs.
        self.col_order: List[str] = (
            list(self.numeric.keys()) +
            list(self.categorical.keys()) +
            list(self.other.keys())
        )

        # Correlations
        self.pearson   : Dict[str, float] = correlations.get("numeric_pearson",       {})
        self.cramers_v : Dict[str, float] = correlations.get("categorical_cramers_v", {})
        self.pb        : Dict[str, float] = correlations.get("categorical_numeric_pb", {})

        # Constraints
        raw_ranges = constraints.get("numeric_ranges", {})
        self.num_ranges: Dict[str, Tuple[Optional[float], Optional[float]]] = {}
        for col, rng in raw_ranges.items():
            # stored as list [min, max] after JSON round-trip
            if isinstance(rng, (list, tuple)) and len(rng) == 2:
                lo = float(rng[0]) if rng[0] is not None else None
                hi = float(rng[1]) if rng[1] is not None else None
                self.num_ranges[col] = (lo, hi)

        self.allowed: Dict[str, List[str]] = constraints.get("allowed_values", {})

        # ------------------------------------------------------------------
        # Label column detection (dataset-agnostic heuristic)
        # A categorical column is treated as the label/target when it is
        # low-cardinality (2–50 classes) AND has the highest total absolute
        # point-biserial association with numeric columns.  This matches the
        # typical "target column correlates with many features" pattern without
        # relying on any domain-specific column name.
        # ------------------------------------------------------------------
        self.label_col: Optional[str] = self._detect_label_col()

        # Per-class statistics populated lazily by build_class_stats().
        # Structure: col → label_value → {"mean": float, "std": float,
        #                                  "min": float, "max": float,
        #                                  "q25": float, "q75": float}
        self.class_numeric_stats: Dict[str, Dict[str, Dict[str, float]]] = {}
        # Structure: cat_col → label_value → {value: prob}
        self.class_cat_stats: Dict[str, Dict[str, Dict[str, float]]] = {}
        # Marginal label distribution {label_value: probability}
        self.label_dist: Dict[str, float] = {}
        if self.label_col and self.label_col in self.categorical:
            ratios = self.categorical[self.label_col].get("top_value_ratios") or {}
            total  = sum(ratios.values()) or 1.0
            self.label_dist = {k: v / total for k, v in ratios.items()}
        # Per-class covariance matrices populated by build_class_stats()
        # col_group → label_value → (mean_vec, cov_matrix, col_names)
        self.class_covariance: Dict[str, Tuple[np.ndarray, np.ndarray, List[str]]] = {}

        # User-supplied class distribution override.
        # When set (by generate()), engines use _sample_labels_exact() to
        # allocate exact per-class counts instead of probabilistic sampling
        # from label_dist.  None means "use baseline distribution".
        self.label_dist_override: Optional[Dict[str, float]] = None

    # ------------------------------------------------------------------
    # Convenience helpers
    # ------------------------------------------------------------------

    def is_numeric(self, col: str) -> bool:
        return col in self.numeric

    def is_categorical(self, col: str) -> bool:
        return col in self.categorical

    def null_ratio(self, col: str) -> float:
        if col in self.numeric:
            raw = float(self.numeric[col].get("null_ratio", 0.0))
        elif col in self.categorical:
            raw = float(self.categorical[col].get("null_ratio", 0.0))
        elif col in self.other:
            raw = float(self.other[col].get("null_ratio", 0.0))
        else:
            return 0.0
        # Phase 5: null_ratio outside [0, 1] is physically impossible
        if raw < 0.0 or raw > 1.0:
            raise _InputValidationError(_ErrorCode.INVALID_SCHEMA, 
                f"BaselineReader: null_ratio={raw!r} for column '{col}' is "
                "outside [0.0, 1.0]. The baseline spec is corrupted or invalid."
            )
        return raw

    def strong_pearson_pairs(self, threshold: float = 0.4) -> List[Tuple[str, str, float]]:
        """Return (col_a, col_b, corr) for pairs above threshold."""
        pairs = []
        for key, v in self.pearson.items():
            if abs(v) >= threshold:
                a, b = key.rsplit("__", 1)   # Ph-9: rsplit so column names with __ parse correctly
                pairs.append((a, b, v))
        return pairs

    def strong_pb_pairs(self, threshold: float = 0.3) -> List[Tuple[str, str, float]]:
        """Return (cat_col, num_col, r) for point-biserial pairs above threshold."""
        pairs = []
        for key, v in self.pb.items():
            if abs(v) >= threshold:
                cat, num = key.rsplit("__", 1)   # Ph-9
                pairs.append((cat, num, v))
        return pairs

    # ------------------------------------------------------------------
    # Label-column detection
    # ------------------------------------------------------------------

    def _detect_label_col(self) -> Optional[str]:
        """
        Heuristically identify a label/target column from the baseline.

        Criteria (all must pass):
        1. Column is categorical with 2–50 unique values.
        2. Column appears in at least one point-biserial entry as the
           cat side (i.e. it correlates with at least one numeric feature).
        3. Among all qualifying columns, the one with the highest *sum* of
           absolute point-biserial correlations across all numeric partners
           is selected.  This mirrors the intuition that a target variable
           tends to correlate broadly with features.

        Returns None if no suitable column is found (unlabelled dataset).
        """
        _MIN_CLASSES = 2
        _MAX_CLASSES = 50

        # Collect qualifying categorical columns
        qualifying: List[str] = []
        for col, spec in self.categorical.items():
            uc = spec.get("unique_count")
            if uc is None:
                continue
            if _MIN_CLASSES <= int(uc) <= _MAX_CLASSES:
                qualifying.append(col)

        if not qualifying:
            return None

        # Score each qualifying column by total abs point-biserial
        scores: Dict[str, float] = {col: 0.0 for col in qualifying}
        for key, v in self.pb.items():
            cat_col = key.rsplit("__", 1)[0]   # Ph-9
            if cat_col in scores:
                scores[cat_col] += abs(v)

        # Must have at least one numeric correlation to qualify
        candidates = {col: s for col, s in scores.items() if s > 0.0}
        if not candidates:
            return None

        return max(candidates, key=lambda c: candidates[c])

    # ------------------------------------------------------------------
    # Per-class statistics builder (called by engines that have the df)
    # ------------------------------------------------------------------

    def build_class_stats(self, df: "pd.DataFrame") -> None:  # type: ignore[name-defined]
        """
        Compute per-class (per-label) statistics for all numeric and
        categorical columns.  Populates:
            self.class_numeric_stats
            self.class_cat_stats
            self.class_covariance

        Safe to call multiple times; results are overwritten.
        Requires pandas to be imported (guaranteed by the engine that calls it).
        """
        import pandas as _pd  # local import to avoid top-level hard dep

        if not self.label_col or self.label_col not in df.columns:
            return

        label_series = df[self.label_col].astype(str)
        label_values = label_series.unique().tolist()

        num_cols = [c for c in self.numeric if c in df.columns]
        cat_cols = [c for c in self.categorical
                    if c in df.columns and c != self.label_col]

        for lv in label_values:
            mask   = label_series == lv
            sub    = df[mask]
            n_sub  = int(mask.sum())
            if n_sub == 0:
                continue

            # Numeric per-class stats — full quantile profile so quantile-CDF
            # sampling can be used for each class slice (same keys as the global
            # NumericColumnBaseline spec so _sample_numeric_col works directly).
            for col in num_cols:
                s = _pd.to_numeric(sub[col], errors="coerce").dropna()
                if len(s) < 2:
                    continue
                std_val = float(s.std())
                entry = self.class_numeric_stats.setdefault(col, {})
                entry[lv] = {
                    "mean": float(s.mean()),
                    "std":  std_val if std_val > 0 else 1e-6,
                    "min":  float(s.min()),
                    "max":  float(s.max()),
                    "q01":  float(s.quantile(0.01)),
                    "q05":  float(s.quantile(0.05)),
                    "q25":  float(s.quantile(0.25)),
                    "q50":  float(s.quantile(0.50)),
                    "q75":  float(s.quantile(0.75)),
                    "q95":  float(s.quantile(0.95)),
                    "q99":  float(s.quantile(0.99)),
                }

            # Categorical per-class stats
            for col in cat_cols:
                s  = sub[col].dropna().astype(str)
                vc = s.value_counts(normalize=True)
                if len(vc) == 0:
                    continue
                entry = self.class_cat_stats.setdefault(col, {})
                entry[lv] = vc.to_dict()

        # Per-class covariance matrices for all numeric columns together
        if len(num_cols) >= 2:
            for lv in label_values:
                mask  = label_series == lv
                sub   = df[mask][num_cols].apply(_pd.to_numeric, errors="coerce").dropna()
                if len(sub) < len(num_cols) + 1:
                    continue
                mu  = sub.mean().values
                cov = sub.cov().values
                cov = _nearest_pd(cov)
                self.class_covariance[lv] = (mu, cov, num_cols)


# ==================================================================
# Section 2 — StatisticalEngine
# For small datasets (< 1 000 rows).
# Samples each column from its observed marginal distribution, then
# applies Cholesky-based covariance injection for strongly correlated
# numeric pairs.  No training step, no cache needed.
# ==================================================================

class StatisticalEngine:
    """
    Pure statistics-based generator.  Works entirely from the
    BaselineArtifact — does not load the original dataframe.

    Generation order (label-first when a label column is detected):
      1. Sample label values from the baseline marginal distribution.
      2. For each row, draw numeric features from per-class conditional
         distributions using quantile-preserving inverse-CDF sampling
         conditioned on the sampled label.
         Falls back to the global marginal spec when per-class stats are
         unavailable.
      3. Apply Cholesky copula injection to correlated numeric pairs
         within each class slice (rank → Z → Cholesky → Φ(Z) → Q⁻¹(U))
         to preserve intra-class feature correlations without distorting
         the marginal distributions.
      4. Sample categorical features conditioned on the label value using
         per-class frequency tables from class_cat_stats.

    Numeric sampling uses quantile-based inverse CDF — no rejection loop,
    no np.clip, preserves skew/tails from baseline quantile statistics.
    Categorical sampling uses multinomial draws from frequency tables.
    """

    ENGINE_NAME = "statistical"

    def __init__(self, bl: BaselineReader, rng: np.random.Generator) -> None:
        self.bl  = bl
        self.rng = rng

    def sample(self, n: int) -> pd.DataFrame:
        bl  = self.bl
        rng = self.rng

        data: Dict[str, np.ndarray] = {}

        if bl.label_col and bl.label_dist:
            # ---- Label-first path ----
            # 1. Sample labels
            label_choices = list(bl.label_dist.keys())
            if bl.label_dist_override is not None:
                # User-specified distribution → exact count allocation
                labels = _sample_labels_exact(bl.label_dist_override, n, rng)
            else:
                # Baseline distribution → probabilistic sampling
                label_probs = np.array(list(bl.label_dist.values()), dtype=float)
                label_probs = label_probs / label_probs.sum()
                labels = np.array(label_choices, dtype=object)[
                    rng.choice(len(label_choices), size=n, p=label_probs)
                ]
            data[bl.label_col] = labels

            # ── Phase 2 guard: determine whether class-conditional generation
            # is viable for every class.  We require at least 2 samples per
            # class and at least one numeric column with stored per-class stats.
            # If the guard fails we fall back to purely marginal generation for
            # ALL feature columns — no hybrid per-column mixing is allowed
            # because mixing conditional and marginal draws breaks the
            # feature-label correlation structure.
            _has_stats = bool(bl.class_numeric_stats)
            _min_class_n = min(
                (int((labels == lv).sum()) for lv in label_choices),
                default=0,
            )
            # Threshold of 5 samples per class is the minimum for reliable
            # class-conditional generation.  Below this, per-class statistics
            # are too sparse for quantile estimates, covariance matrices may
            # become rank-deficient, and conditionals may be worse than pure
            # marginal sampling.  Falling back fully (no hybrid mixing) ensures
            # coherent feature-label structure.
            _use_conditional = _has_stats and _min_class_n >= 5

            if not _use_conditional:
                # Pure marginal path: ignore label when sampling features.
                for col, spec in bl.numeric.items():
                    data[col] = self._sample_numeric_col(col, spec, n)
                data = self._inject_numeric_correlations(data, n)
                for col, spec in bl.categorical.items():
                    if col == bl.label_col:
                        continue
                    data[col] = self._sample_categorical_col(col, spec, n)

            else:
                # 2. Sample numeric features conditioned on label
                for col, spec in bl.numeric.items():
                    arr = np.empty(n, dtype=float)
                    for lv in label_choices:
                        mask   = labels == lv
                        n_lv   = int(mask.sum())
                        if n_lv == 0:
                            continue
                        cls_stats = bl.class_numeric_stats.get(col, {}).get(lv)
                        # All quantile keys (q01…q99) present when built from real data.
                        # If a specific class's stats are absent, fall back to global
                        # spec for that label only — this is acceptable within a
                        # conditional path because it preserves other classes.
                        cond_spec = cls_stats if cls_stats else spec
                        arr[mask] = self._sample_numeric_col(col, cond_spec, n_lv)
                    data[col] = arr

                # 3. Cholesky covariance injection per label class
                data = self._inject_numeric_correlations_labeled(data, labels, label_choices)

                # 4. Sample categorical features (non-label) conditioned on label
                for col, spec in bl.categorical.items():
                    if col == bl.label_col:
                        continue
                    arr = np.empty(n, dtype=object)
                    for lv in label_choices:
                        mask = labels == lv
                        n_lv = int(mask.sum())
                        if n_lv == 0:
                            continue
                        cls_freq = bl.class_cat_stats.get(col, {}).get(lv)
                        if cls_freq:
                            choices = list(cls_freq.keys())
                            wts     = np.array(list(cls_freq.values()), dtype=float)
                            wts     = wts / wts.sum()
                            arr[mask] = np.array(choices, dtype=object)[
                                rng.choice(len(choices), size=n_lv, p=wts)
                            ]
                        else:
                            arr[mask] = self._sample_categorical_col(col, spec, n_lv)
                    data[col] = arr

        else:
            # ---- Unlabelled path (original behaviour) ----
            for col, spec in bl.numeric.items():
                data[col] = self._sample_numeric_col(col, spec, n)

            data = self._inject_numeric_correlations(data, n)

            for col, spec in bl.categorical.items():
                data[col] = self._sample_categorical_col(col, spec, n)

        # Other columns (datetime/object — emit None, constraint pass handles)
        for col in bl.other:
            data[col] = np.array([None] * n, dtype=object)

        # Apply null masks
        for col in bl.col_order:
            nr = bl.null_ratio(col)
            if nr > 0.0 and col in data:
                null_mask = rng.random(n) < nr
                arr = data[col].astype(object)
                arr[null_mask] = None
                data[col] = arr

        return pd.DataFrame({col: data[col] for col in bl.col_order if col in data})

    # ------------------------------------------------------------------

    def _sample_numeric_col(
        self, col: str, spec: Dict[str, Any], n: int
    ) -> np.ndarray:
        """
        Sample n values using a piecewise-linear inverse CDF constructed
        from all available quantile statistics in the spec.

        This approach:
        • Preserves the full distribution shape — median, IQR, skew, tails
        • Is naturally bounded within [min, max] — no rejection, no clipping
        • Degrades gracefully: uses whatever quantile points are available
          (q01…q99 from baseline; mean as q50 fallback; min/max as 0/1)
        • Works for symmetric, skewed, and heavy-tailed distributions

        Falls back to uniform sampling only when min == max (degenerate column).
        """
        levels, values = _build_quantile_cdf(spec)

        if levels is None:
            # Not enough info — return zeros (schema preserved, values neutral)
            return np.zeros(n, dtype=float)

        lo, hi = values[0], values[-1]
        if lo == hi:
            return np.full(n, lo, dtype=float)

        return _quantile_cdf_sample(n, levels, values, self.rng)

    def _sample_categorical_col(
        self, col: str, spec: Dict[str, Any], n: int
    ) -> np.ndarray:
        """
        Sample n values from the observed frequency distribution.
        Uses top_value_ratios from the baseline.
        """
        rng    = self.rng
        ratios = spec.get("top_value_ratios") or {}

        if not ratios:
            return np.array([None] * n, dtype=object)

        choices = list(ratios.keys())
        weights = np.array(list(ratios.values()), dtype=float)
        if weights.sum() <= 0:
            weights = np.ones(len(choices), dtype=float)

        probs = weights / weights.sum()
        idx   = rng.choice(len(choices), size=n, p=probs)
        return np.array(choices, dtype=object)[idx]

    def _inject_numeric_correlations(
        self, data: Dict[str, np.ndarray], n: int
    ) -> Dict[str, np.ndarray]:
        """
        For strongly correlated numeric pairs (|Pearson r| >= 0.4),
        use Cholesky decomposition to introduce the observed covariance.
        Out-of-range values are resolved by resample-retry (not clipping)
        to avoid artificial boundary spikes.
        """
        return _apply_cholesky_correlations(data, self.bl, self.rng, n)

    def _inject_numeric_correlations_labeled(
        self,
        data:          Dict[str, np.ndarray],
        labels:        np.ndarray,
        label_values:  List[str],
    ) -> Dict[str, np.ndarray]:
        """
        Apply Cholesky covariance injection separately within each label
        class, using per-class covariance matrices when available.
        This preserves within-class feature correlations independently
        from between-class structure.
        """
        bl  = self.bl
        rng = self.rng
        n   = len(labels)

        num_cols_present = [c for c in bl.numeric if c in data]
        if len(num_cols_present) < 2:
            return data

        for lv in label_values:
            mask = np.where(labels == lv)[0]
            n_lv = len(mask)
            if n_lv < 2:
                continue

            # Use per-class covariance if available, else global Pearson-based
            if lv in bl.class_covariance:
                mu, cov, col_names = bl.class_covariance[lv]
                cols_here = [c for c in col_names if c in data]
                if len(cols_here) < 2:
                    continue
                idx_in_cov = [col_names.index(c) for c in cols_here]
                mu_sub  = mu[idx_in_cov]
                cov_sub = cov[np.ix_(idx_in_cov, idx_in_cov)]
                cov_sub = _nearest_pd(cov_sub)
                try:
                    samples = rng.multivariate_normal(mu_sub, cov_sub, size=n_lv)
                except np.linalg.LinAlgError as e:
                    _log.warning(
                        "fallback path activated: class covariance sampling failed for label=%r; keeping existing slice values: %s",
                        lv,
                        e,
                    )
                    continue
                for j, col in enumerate(cols_here):
                    spec = bl.numeric[col]
                    lo   = float(spec.get("min", -np.inf))
                    hi   = float(spec.get("max",  np.inf))
                    # Resample out-of-range values rather than clipping
                    col_samples = samples[:, j]
                    col_samples = _resample_out_of_range(col_samples, lo, hi, spec, rng)
                    data[col][mask] = col_samples
            else:
                # Fall back to global Cholesky on this class slice
                slice_data = {c: data[c][mask] for c in num_cols_present}
                slice_data = _apply_cholesky_correlations(slice_data, bl, rng, n_lv)
                for c in num_cols_present:
                    data[c][mask] = slice_data[c]

        return data


# ==================================================================
# Section 3 — ProbabilisticEngine
# For medium datasets (1 000 – 50 000 rows).
# Fits a Gaussian copula on the full dataframe: transforms numeric
# marginals to uniform via empirical CDF, fits a multivariate normal
# to the copula space, samples from it, then inverse-transforms back
# to original marginals.  Categorical columns are handled via
# conditional frequency tables keyed on their dominant numeric
# correlation partner (from point-biserial).
# ==================================================================

class ProbabilisticEngine:
    """
    Gaussian copula-based generator.

    Training  : fits a global copula on the original dataframe, plus
                per-class copulas when a label column is detected.
    Caching   : serialises all fitted parameters to pickle.
    Sampling  : label-first when label_col is set — sample label, then draw
                numeric features from the per-class copula, then draw
                categoricals from per-class frequency tables.
                Inverse-CDF transform brings values back to data space.
                No np.clip on generated values — out-of-range values are
                resolved by resample-retry.
    """

    ENGINE_NAME = "probabilistic"

    def __init__(
        self,
        bl:        BaselineReader,
        rng:       np.random.Generator,
        cache_dir: Optional[str] = None,
    ) -> None:
        self.bl        = bl
        self.rng       = rng
        self.cache_dir = cache_dir

        # Global copula parameters
        self._mu          : Optional[np.ndarray]        = None
        self._cov         : Optional[np.ndarray]        = None
        self._cdfs        : Dict[str, Tuple]            = {}   # col → (sorted_vals, uniform_quantiles)
        self._cat_tables  : Dict[str, Dict]             = {}   # col → {bin_label → {value: prob}}
        self._num_cols    : List[str]                   = []

        # Per-class copula parameters (populated when label_col is detected)
        # label_value → {"mu": ndarray, "cov": ndarray, "cdfs": dict, "num_cols": list}
        self._class_copulas: Dict[str, Dict[str, Any]] = {}

        self._fitted      : bool                        = False

    # ------------------------------------------------------------------
    # Public interface
    # ------------------------------------------------------------------

    def fit(self, df: pd.DataFrame) -> None:
        """Fit the Gaussian copula (global + per-class) on df."""
        bl = self.bl

        # Build per-class stats so StatisticalEngine label-path can use them too
        bl.build_class_stats(df)

        # Only numeric columns enter the copula
        self._num_cols = [c for c in bl.numeric if c in df.columns]

        # ---- Global copula ----
        if self._num_cols:
            self._build_copula_from_df(df, self._num_cols)

        # ---- Per-class copulas (when label column detected) ----
        if bl.label_col and bl.label_col in df.columns and self._num_cols:
            label_series = df[bl.label_col].astype(str)
            for lv in label_series.unique():
                sub = df[label_series == lv]
                if len(sub) < len(self._num_cols) + 2:
                    continue  # too few rows for reliable copula
                mu, cov, cdfs = self._fit_copula_params(sub, self._num_cols)
                if mu is not None:
                    self._class_copulas[lv] = {
                        "mu":       mu,
                        "cov":      cov,
                        "cdfs":     cdfs,
                        "num_cols": self._num_cols,
                    }

        # Fit conditional categorical tables
        self._cat_tables = self._build_cat_tables(df)

        self._fitted = True

    def _build_copula_from_df(self, df: pd.DataFrame, num_cols: List[str]) -> None:
        """Fit global copula parameters; store in self._mu, _cov, _cdfs."""
        mu, cov, cdfs = self._fit_copula_params(df, num_cols)
        if mu is not None:
            self._mu   = mu
            self._cov  = cov
            self._cdfs = cdfs

    def _fit_copula_params(
        self,
        df:       pd.DataFrame,
        num_cols: List[str],
    ) -> Tuple[Optional[np.ndarray], Optional[np.ndarray], Dict[str, Tuple]]:
        """
        Fit copula parameters from df for the given numeric columns.
        Returns (mu, cov, cdfs) or (None, None, {}) on failure.
        """
        from scipy.special import ndtri  # type: ignore

        cdfs: Dict[str, Tuple] = {}
        for col in num_cols:
            s = pd.to_numeric(df[col], errors="coerce").dropna().sort_values()
            if len(s) < 2:
                return None, None, {}
            vals  = s.values
            quant = np.linspace(0.0, 1.0, len(vals))
            cdfs[col] = (vals, quant)

        U = np.column_stack([
            self._empirical_cdf_transform(df[c]) for c in num_cols
        ])
        # Clamp strictly inside (0,1) for the probit transform — this is a
        # mathematical requirement of ndtri, not a data boundary clamp
        U = np.clip(U, 1e-6, 1.0 - 1e-6)
        Z = ndtri(U)

        mu  = Z.mean(axis=0)
        cov = np.cov(Z, rowvar=False) if Z.shape[1] > 1 else np.array([[1.0]])
        cov = _nearest_pd(cov)
        return mu, cov, cdfs

    def sample(self, n: int) -> pd.DataFrame:
        if not self._fitted:
            raise _PipelineError(_ErrorCode.ENGINE_NOT_FITTED, "ProbabilisticEngine.fit() must be called before sample().")

        bl  = self.bl
        rng = self.rng

        data: Dict[str, np.ndarray] = {}

        if bl.label_col and bl.label_dist and self._class_copulas:
            # ---- Label-first path ----
            label_choices = list(bl.label_dist.keys())
            if bl.label_dist_override is not None:
                # User-specified distribution → exact count allocation
                labels = _sample_labels_exact(bl.label_dist_override, n, rng)
            else:
                # Baseline distribution → probabilistic sampling
                label_probs = np.array(list(bl.label_dist.values()), dtype=float)
                label_probs = label_probs / label_probs.sum()
                labels = np.array(label_choices, dtype=object)[
                    rng.choice(len(label_choices), size=n, p=label_probs)
                ]
            data[bl.label_col] = labels

            # Initialise numeric arrays
            for col in self._num_cols:
                data[col] = np.empty(n, dtype=float)

            for lv in label_choices:
                mask = np.where(labels == lv)[0]
                n_lv = len(mask)
                if n_lv == 0:
                    continue

                copula = self._class_copulas.get(lv)
                if copula is None:
                    # Fall back to global copula for unseen / rare labels
                    copula = {
                        "mu": self._mu, "cov": self._cov,
                        "cdfs": self._cdfs, "num_cols": self._num_cols,
                    }

                mu_lv  = copula["mu"]
                cov_lv = copula["cov"]
                cdfs_lv = copula["cdfs"]
                cols_lv = copula["num_cols"]

                if mu_lv is None:
                    continue

                # Sample from per-class copula
                from scipy.special import ndtr  # type: ignore
                Z_lv = rng.multivariate_normal(mu_lv, cov_lv, size=n_lv)
                # Clamp Z to prevent ndtr from returning exact 0/1 (mathematical guard)
                Z_lv = np.clip(Z_lv, -8.0, 8.0)
                U_lv = ndtr(Z_lv)

                for i, col in enumerate(cols_lv):
                    if col not in cdfs_lv:
                        continue
                    vals, quant = cdfs_lv[col]
                    spec        = bl.numeric[col]
                    lo          = float(spec.get("min", -np.inf))
                    hi          = float(spec.get("max",  np.inf))
                    generated   = np.interp(U_lv[:, i], quant, vals)
                    # Resample out-of-range values — no hard clip
                    generated   = _resample_out_of_range(generated, lo, hi, spec, rng)
                    data[col][mask] = generated

            # Sample categorical features conditioned on label
            for col, spec in bl.categorical.items():
                if col == bl.label_col:
                    continue
                arr = np.empty(n, dtype=object)
                for lv in label_choices:
                    mask = np.where(labels == lv)[0]
                    n_lv = len(mask)
                    if n_lv == 0:
                        continue
                    cls_freq = bl.class_cat_stats.get(col, {}).get(lv)
                    if cls_freq:
                        ch  = list(cls_freq.keys())
                        wts = np.array(list(cls_freq.values()), dtype=float)
                        wts = wts / wts.sum()
                        arr[mask] = np.array(ch, dtype=object)[
                            rng.choice(len(ch), size=n_lv, p=wts)
                        ]
                    else:
                        arr[mask] = self._sample_categorical_conditioned(
                            col, spec, data, n_lv
                        )
                data[col] = arr

        else:
            # ---- Unlabelled path ----
            if self._num_cols and self._mu is not None:
                from scipy.special import ndtr  # type: ignore
                Z_samples = rng.multivariate_normal(self._mu, self._cov, size=n)
                # Mathematical clamp to keep ndtr away from exact 0/1 only
                Z_samples = np.clip(Z_samples, -8.0, 8.0)
                U_samples = ndtr(Z_samples)

                for i, col in enumerate(self._num_cols):
                    vals, quant = self._cdfs[col]
                    spec        = bl.numeric[col]
                    lo          = float(spec.get("min", -np.inf))
                    hi          = float(spec.get("max",  np.inf))
                    generated   = np.interp(U_samples[:, i], quant, vals)
                    # Resample out-of-range values — no hard clip
                    data[col]   = _resample_out_of_range(generated, lo, hi, spec, rng)

            for col, spec in bl.categorical.items():
                data[col] = self._sample_categorical_conditioned(col, spec, data, n)

        # Other columns
        for col in bl.other:
            data[col] = np.array([None] * n, dtype=object)

        # Null masks
        for col in bl.col_order:
            nr = bl.null_ratio(col)
            if nr > 0.0 and col in data:
                null_mask = rng.random(n) < nr
                arr = data[col].astype(object)
                arr[null_mask] = None
                data[col] = arr

        return pd.DataFrame({col: data[col] for col in bl.col_order if col in data})

    # ------------------------------------------------------------------
    # Cache helpers
    # ------------------------------------------------------------------

    def cache_path(self) -> Optional[str]:
        if not self.cache_dir:
            return None
        if not self.bl.fingerprint:
            raise RuntimeError("[HARD FAIL] Missing dataset fingerprint — cannot build probabilistic cache key")
        return os.path.join(self.cache_dir, f"{self.bl.fingerprint}_probabilistic.pkl")

    def save_cache(self) -> None:
        p = self.cache_path()
        if not p:
            return
        os.makedirs(self.cache_dir, exist_ok=True)  # type: ignore[arg-type]
        # F-4: store baseline_hash + schema_version + generator_version so
        # load_cache() can detect stale or incompatible cache files.
        payload = {
            "baseline_hash":    _baseline_hash(self.bl),
            "schema_version":   _CACHE_SCHEMA_VERSION,
            "generator_version": _GENERATOR_VERSION,
            "mu":               self._mu,
            "cov":              self._cov,
            "cdfs":             self._cdfs,
            "cat_tables":       self._cat_tables,
            "num_cols":         self._num_cols,
            "class_copulas":    self._class_copulas,
            # persist class-level stats so label-first path works after cache hit
            "label_col":        self.bl.label_col,
            "label_dist":       self.bl.label_dist,
            "class_cat_stats":  self.bl.class_cat_stats,
        }
        with open(p, "wb") as f:
            pickle.dump(payload, f)

    def load_cache(self) -> bool:
        p = self.cache_path()
        if not p or not os.path.exists(p):
            return False
        try:
            # F-6: TTL — invalidate cache files older than _CACHE_TTL_SEC
            import time as _time
            if _time.time() - os.path.getmtime(p) > _CACHE_TTL_SEC:
                return False
            with open(p, "rb") as f:
                payload = pickle.load(f)
            # F-4: reject stale/incompatible cache on ANY field mismatch
            cached_hash    = payload.get("baseline_hash", "")
            cached_schema  = payload.get("schema_version", "")
            cached_gen_ver = payload.get("generator_version", "")
            current_hash   = _baseline_hash(self.bl)
            if (cached_hash    != current_hash or
                cached_schema  != _CACHE_SCHEMA_VERSION or
                cached_gen_ver != _GENERATOR_VERSION):
                return False
            self._mu            = payload["mu"]
            self._cov           = payload["cov"]
            self._cdfs          = payload["cdfs"]
            self._cat_tables    = payload["cat_tables"]
            self._num_cols      = payload["num_cols"]
            self._class_copulas = payload.get("class_copulas", {})
            # Restore bl-level class stats that were built during fit()
            if payload.get("label_col"):
                self.bl.label_col      = payload["label_col"]
                self.bl.label_dist     = payload.get("label_dist", {})
                self.bl.class_cat_stats = payload.get("class_cat_stats", {})
            self._fitted        = True
            return True
        except Exception as e:
            _log.warning("fallback path activated: cache load failed: %s", e)
            return False

    # ------------------------------------------------------------------
    # Internal helpers
    # ------------------------------------------------------------------

    def _empirical_cdf_transform(self, s: pd.Series) -> np.ndarray:
        """Map each value to its empirical quantile in [0, 1]."""
        numeric = pd.to_numeric(s, errors="coerce")
        n       = len(numeric)
        ranks   = numeric.rank(method="average", na_option="keep")
        return (ranks.fillna(0.5 * n) / n).values

    def _build_cat_tables(self, df: pd.DataFrame) -> Dict[str, Dict]:
        """
        Build conditional frequency tables for each categorical column.
        For each categorical col with a strong point-biserial partner,
        bin the numeric partner into quartiles and store per-bin value
        frequency.  Falls back to unconditional frequency if no strong
        partner exists.
        """
        bl     = self.bl
        tables = {}

        strong_pb = {cat: (num, r) for cat, num, r in bl.strong_pb_pairs(threshold=0.3)}

        for col, spec in bl.categorical.items():
            if col not in df.columns:
                continue

            if col in strong_pb:
                num_col, _ = strong_pb[col]
                if num_col in df.columns:
                    num_series = pd.to_numeric(df[num_col], errors="coerce")
                    cat_series = df[col].astype(str)
                    bins       = pd.qcut(num_series, q=4, labels=False, duplicates="drop")
                    table: Dict[str, Dict[str, float]] = {}
                    for bin_label in bins.dropna().unique():
                        mask    = bins == bin_label
                        sub     = cat_series[mask]
                        vc      = sub.value_counts(normalize=True)
                        table[str(int(bin_label))] = vc.to_dict()
                    tables[col] = {"type": "conditional", "partner": num_col, "bins": table}
                    continue

            # Unconditional frequency table
            ratios = spec.get("top_value_ratios") or {}
            tables[col] = {"type": "unconditional", "ratios": ratios}

        return tables

    def _sample_categorical_conditioned(
        self,
        col:  str,
        spec: Dict[str, Any],
        data: Dict[str, np.ndarray],
        n:    int,
    ) -> np.ndarray:
        """
        Sample a categorical column, conditioning on its numeric partner
        (if one exists in the fitted cat_tables).
        """
        rng   = self.rng
        table = self._cat_tables.get(col)

        if table is None or table["type"] == "unconditional":
            ratios  = spec.get("top_value_ratios") or {}
            if not ratios:
                return np.array([None] * n, dtype=object)
            choices = list(ratios.keys())
            weights = np.array(list(ratios.values()), dtype=float)
            weights = weights / weights.sum()
            return np.array(choices, dtype=object)[rng.choice(len(choices), size=n, p=weights)]

        # Conditional: bin the already-generated numeric partner values
        partner     = table["partner"]
        bins_table  = table["bins"]
        partner_arr = data.get(partner)

        if partner_arr is None or len(bins_table) == 0:
            # Fall back to unconditional
            ratios  = spec.get("top_value_ratios") or {}
            choices = list(ratios.keys()) if ratios else [None]
            weights = np.array(list(ratios.values()), dtype=float) if ratios else np.array([1.0])
            weights = weights / weights.sum()
            return np.array(choices, dtype=object)[rng.choice(len(choices), size=n, p=weights)]

        # Determine which quartile each generated numeric value falls into
        partner_spec = self.bl.numeric.get(partner, {})
        lo  = float(partner_spec.get("min", partner_arr.min()))
        hi  = float(partner_spec.get("max", partner_arr.max()))
        rng_span = hi - lo if hi > lo else 1.0
        result   = np.empty(n, dtype=object)

        bin_keys  = sorted(bins_table.keys(), key=lambda x: int(x))
        n_bins    = len(bin_keys)

        for idx in range(n):
            v       = float(partner_arr[idx]) if partner_arr[idx] is not None else lo
            bin_i   = min(int((v - lo) / rng_span * n_bins), n_bins - 1)
            bin_key = bin_keys[bin_i]
            freq    = bins_table[bin_key]
            if freq:
                ch  = list(freq.keys())
                wt  = np.array(list(freq.values()), dtype=float)
                wt  = wt / wt.sum()
                result[idx] = ch[rng.choice(len(ch), p=wt)]
            else:
                result[idx] = None

        return result


# ==================================================================
# Section 4 — CTGANEngine
# For large datasets (>= 50 000 rows).
# Trains a CTGANSynthesizer on the full dataframe.
# Falls back to ProbabilisticEngine if ctgan is not installed.
# Caches the trained model to disk keyed by dataset fingerprint.
# ==================================================================

class CTGANEngine:
    """
    CTGAN-based generator for large datasets.

    If ctgan is not installed, automatically falls back to
    ProbabilisticEngine with a warning in the output.
    """

    ENGINE_NAME = "ctgan"

    def __init__(
        self,
        bl:        BaselineReader,
        rng:       np.random.Generator,
        cache_dir: Optional[str] = None,
    ) -> None:
        self.bl         = bl
        self.rng        = rng
        self.cache_dir  = cache_dir
        self._model     = None
        self._fitted    = False
        self._fallback  : Optional[ProbabilisticEngine] = None

        if not _CTGAN_AVAILABLE:
            self._fallback = ProbabilisticEngine(bl, rng, cache_dir)

    def fit(self, df: pd.DataFrame) -> None:
        if self._fallback is not None:
            if not self._fallback.load_cache():
                self._fallback.fit(df)
                self._fallback.save_cache()
            self._fitted = True
            return

        # Build discrete (categorical) column list for CTGAN
        discrete_cols = list(self.bl.categorical.keys())

        self._model = CTGANSynthesizer(epochs=300, verbose=False)
        self._model.fit(df, discrete_columns=discrete_cols)
        self._fitted = True

    def sample(self, n: int) -> pd.DataFrame:
        if not self._fitted:
            raise _PipelineError(_ErrorCode.ENGINE_NOT_FITTED, "CTGANEngine.fit() must be called before sample().")

        if self._fallback is not None:
            # Fallback to ProbabilisticEngine — override is handled there.
            return self._fallback.sample(n)

        # True CTGAN path: conditional column-by-column generation is not
        # supported by CTGANSynthesizer without full retraining per class.
        # Silently ignoring the override would produce statistically
        # inconsistent data, so we reject it explicitly.
        if self.bl.label_dist_override is not None:
            raise _InputValidationError(_ErrorCode.INVALID_SCHEMA, 
                "CTGANEngine does not support label_distribution override. "
                "CTGAN generates samples from a learned joint distribution that "
                "cannot be re-conditioned per-class post-hoc. "
                "To use class distribution control, run on a dataset with "
                f"fewer than {_LARGE_THRESHOLD:,} rows so the ProbabilisticEngine "
                "is selected, which supports conditional label-first generation."
            )

        raw = self._model.sample(n)
        # Reorder columns to match baseline col_order
        present = [c for c in self.bl.col_order if c in raw.columns]
        return raw[present]

    # ------------------------------------------------------------------
    # Cache helpers
    # ------------------------------------------------------------------

    def cache_path(self) -> Optional[str]:
        if not self.cache_dir:
            return None
        if not self.bl.fingerprint:
            raise RuntimeError("[HARD FAIL] Missing dataset fingerprint — cannot build ctgan cache key")
        return os.path.join(self.cache_dir, f"{self.bl.fingerprint}_ctgan.pkl")

    def save_cache(self) -> None:
        if self._fallback is not None:
            self._fallback.save_cache()
            return
        p = self.cache_path()
        if not p or self._model is None:
            return
        os.makedirs(self.cache_dir, exist_ok=True)  # type: ignore[arg-type]
        # F-5: wrap model in a payload dict with full integrity metadata
        payload = {
            "baseline_hash":     _baseline_hash(self.bl),
            "schema_version":    _CACHE_SCHEMA_VERSION,
            "generator_version": _GENERATOR_VERSION,
            "model":             self._model,
        }
        with open(p, "wb") as f:
            pickle.dump(payload, f)

    def load_cache(self) -> bool:
        if self._fallback is not None:
            return self._fallback.load_cache()
        p = self.cache_path()
        if not p or not os.path.exists(p):
            return False
        try:
            # F-6: TTL check
            import time as _time
            if _time.time() - os.path.getmtime(p) > _CACHE_TTL_SEC:
                return False
            with open(p, "rb") as f:
                payload = pickle.load(f)
            # F-5: reject on any integrity mismatch
            if not isinstance(payload, dict):
                return False  # old-format cache (bare model) — invalidate
            cached_hash    = payload.get("baseline_hash", "")
            cached_schema  = payload.get("schema_version", "")
            cached_gen_ver = payload.get("generator_version", "")
            current_hash   = _baseline_hash(self.bl)
            if (cached_hash    != current_hash or
                cached_schema  != _CACHE_SCHEMA_VERSION or
                cached_gen_ver != _GENERATOR_VERSION):
                return False
            self._model  = payload["model"]
            self._fitted = True
            return True
        except Exception as e:
            _log.warning("fallback path activated: cache load failed: %s", e)
            return False

    @property
    def engine_used(self) -> str:
        """Actual engine name (accounts for fallback)."""
        if self._fallback is not None:
            return ProbabilisticEngine.ENGINE_NAME
        return self.ENGINE_NAME


# ==================================================================
# Sections 5, 6, 7 — ConstraintFilter, RowQualityFilter,
#                     DuplicatePreFilter
#
# These classes have been moved to validation.py and are accessed
# via the ValidationLayer unified interface imported at the top of
# this file.
# ==================================================================


# ==================================================================
# Section 8 — Engine router + generate()
# Public entry point.  Selects the right engine, trains if needed,
# then runs the ValidationLayer retry loop with CheckPoint commits.
#
# Retry loop
# ----------
# Each round: engine.sample() → ValidationLayer.run() →
#             CheckPoint.commit() until n accepted rows or max rounds.
# CheckPoint.seal() is called once at the very end.
# ==================================================================


def generate(
    dataset_path:       str,
    baseline_path:      str,
    n:                  int,
    cache_dir:          Optional[str] = None,
    seed:               Optional[int] = None,
    label_distribution: Optional[Dict[str, float]] = None,
) -> Dict[str, Any]:
    """
    Full generation pipeline — GROUP 1 HARDENED.

    Phase 5  : n validated as a positive integer before any other work.
    F-1/Ph-1 : Checkpoint uses dual-file NDJSON+meta design via new_run().
    F-2/Ph-2 : reset() gone; new_run() creates isolated per-run files.
    F-3/Ph-9 : rows_hash integrity verified on every commit and export.
    F-7/Ph-6 : PipelineStatus structured object in output dict.
    F-8/Ph-7 : Acceptance-rate threshold guard (< 2% for 2 rounds → fail).
    Phase 11 : Empty baseline (no columns) raises immediately with StatusCode.
    Phase 12 : Consecutive zero-yield guard.
    Phase 13 : seal() status is "complete" | "partial" | "failed".
    """
    # ── Phase 5: strict n validation ────────────────────────────────────────
    if not isinstance(n, int) or isinstance(n, bool):
        raise _InputValidationError(_ErrorCode.INVALID_SCHEMA, 
            f"generate(): n must be a positive integer, got {type(n).__name__} {n!r}. "
            f"[code={StatusCode.INVALID_INPUT}]"
        )
    if n <= 0:
        raise _InputValidationError(_ErrorCode.INVALID_SCHEMA, 
            f"generate(): n must be a positive integer, got n={n}. "
            f"[code={StatusCode.INVALID_INPUT}]"
        )
    if n > 1_000_000:
        raise ValueError(
            f"generate(): n={n} exceeds the safe generation limit of 1,000,000 rows. "
            "Reduce n to prevent unbounded resource usage."
        )

    output_warnings: List[str] = []
    degraded = False
    degradation_errors: List[str] = []

    # ── Group M: STRICT_MODE — determinism enforcement ───────────────────────
    if STRICT_MODE and seed is None:
        seed = _STRICT_SEED
        output_warnings.append(
            f"STRICT_MODE: no seed supplied — using fixed seed {_STRICT_SEED} "
            "for reproducibility. Pass seed= explicitly to override."
        )

    with open(baseline_path, "r", encoding="utf-8") as f:
        artifact = json.load(f)

    bl  = BaselineReader(artifact)
    rng = np.random.default_rng(seed)

    # ── Phase 11: empty baseline guard ──────────────────────────────────────
    if not bl.col_order:
        raise _InputValidationError(_ErrorCode.INVALID_SCHEMA, 
            "generate(): baseline has no columns (col_order is empty). "
            "Re-run baseline analysis on a non-empty dataset before generating. "
            f"[code={StatusCode.EMPTY_BASELINE}]"
        )

    # ── Small dataset guard (ALWAYS, before any sampling) ───────────────────
    try:
        _df_size_check = _load_original(dataset_path, bl)
        if len(_df_size_check) < 10:
            raise _InputValidationError(_ErrorCode.INVALID_SCHEMA,
                "Generation blocked: dataset too small (<10 rows). "
                f"[code={StatusCode.INVALID_INPUT}]"
            )
    except _InputValidationError:
        raise
    except Exception as _size_check_err:
        _log.error(
            "[HARD FAIL] generator invariant violated during dataset size pre-check: %s",
            _size_check_err,
        )
        raise RuntimeError(
            f"[HARD FAIL] generator invariant violated: dataset size pre-check failed: {_size_check_err}"
        ) from _size_check_err

    # ── Label column validation (ALWAYS, before any sampling) ───────────────
    if bl.label_col:
        try:
            _df_orig_all = _load_original(dataset_path, bl)
            if len(_df_orig_all) < 10:
                raise _InputValidationError(_ErrorCode.INVALID_SCHEMA,
                    "Generation blocked: dataset too small (<10 rows). "
                    f"[code={StatusCode.INVALID_INPUT}]"
                )
            if bl.label_col not in _df_orig_all.columns:
                raise _InputValidationError(_ErrorCode.INVALID_SCHEMA,
                    f"generate(): Invalid label column '{bl.label_col}' — not found in dataset columns. "
                    f"[code={StatusCode.INVALID_INPUT}]"
                )
            if _df_orig_all[bl.label_col].nunique() < 2:
                raise _InputValidationError(_ErrorCode.INVALID_SCHEMA,
                    f"generate(): Label column '{bl.label_col}' must have >= 2 distinct classes, "
                    f"found {_df_orig_all[bl.label_col].nunique()}. "
                    f"[code={StatusCode.INVALID_INPUT}]"
                )
        except _InputValidationError:
            raise
        except Exception as _label_load_err:
            _log.error(
                "generator label-column validation failed (fatal for this run): %s",
                _label_load_err,
            )
            raise _InputValidationError(_ErrorCode.INVALID_SCHEMA,
                f"generate(): Could not validate label column '{bl.label_col}': {_label_load_err}. "
                f"[code={StatusCode.INVALID_INPUT}]"
            )

    # ---- Validate and apply label_distribution override ----
    label_dist_applied: Optional[Dict[str, float]] = None
    if label_distribution is not None:
        _validate_label_distribution(label_distribution, bl)
        total = sum(label_distribution.values())
        bl.label_dist_override = {k: v / total for k, v in label_distribution.items()}
        label_dist_applied = dict(bl.label_dist_override)
        output_warnings.append(
            f"Class distribution override applied: {label_dist_applied}."
        )
    else:
        label_dist_applied = dict(bl.label_dist) if bl.label_dist else None

    # ---- Route to engine ----
    row_count = bl.row_count
    if row_count < _SMALL_THRESHOLD:
        engine_name = StatisticalEngine.ENGINE_NAME
    elif row_count < _LARGE_THRESHOLD:
        engine_name = ProbabilisticEngine.ENGINE_NAME
    else:
        engine_name = CTGANEngine.ENGINE_NAME

    output_warnings.append(
        f"Engine selected: {engine_name} "
        f"(dataset rows: {row_count}, requested samples: {n})."
    )

    # ── Phase 1+18: Per-run isolated checkpoint path ─────────────────────────
    # Each generate() call gets a UUID-keyed file.  No two concurrent or
    # sequential runs share a checkpoint regardless of fingerprint.
    _cache_dir = cache_dir or os.path.join(os.path.dirname(baseline_path), "cache")
    os.makedirs(_cache_dir, exist_ok=True)

    # F-1/F-2: use new_run() — dual-file NDJSON+meta, fresh UUID path, no reset()
    cp = CheckPoint.new_run(
        cache_dir           = _cache_dir,
        fingerprint         = bl.fingerprint,
        n_requested         = n,
        dataset_fingerprint = bl.fingerprint,
        generator_used      = engine_name,
    )
    run_id  = cp.run_id
    cp_path = cp.path   # meta file path (for output dict / logging)

    # ---- Build and train engine (once) ----
    if engine_name == StatisticalEngine.ENGINE_NAME:
        engine = StatisticalEngine(bl, rng)
        if bl.label_col:
            try:
                df_for_stats = _load_original(dataset_path, bl)
                bl.build_class_stats(df_for_stats)
                output_warnings.append(
                    f"Label column detected (\'{bl.label_col}\'): "
                    "class-conditional statistics built for label-first generation."
                )
            except Exception as e:
                _log.warning(
                    "fallback path activated: class-conditional stats unavailable; using marginal distributions: %s",
                    e,
                )
                degraded = True
                degradation_errors.append("class-conditional statistics unavailable; marginal distributions used")
                output_warnings.append(
                    f"Could not load original dataset for class stats "
                    f"(falling back to marginal distributions): {e}"
                )
                if label_distribution is not None:
                    output_warnings.append(
                        "Label override applied without conditional feature alignment: "
                        "class-conditional statistics could not be built, so numeric "
                        "and categorical features will be sampled from marginal "
                        "distributions rather than per-class conditionals. "
                        "Label counts match the requested distribution but "
                        "feature-label statistical dependencies may not be preserved."
                    )
        actual_engine = StatisticalEngine.ENGINE_NAME

    elif engine_name == ProbabilisticEngine.ENGINE_NAME:
        engine = ProbabilisticEngine(bl, rng, cache_dir)
        if not engine.load_cache():
            df_orig = _load_original(dataset_path, bl)
            engine.fit(df_orig)
            engine.save_cache()
            output_warnings.append("Probabilistic model fitted and cached.")
            if bl.label_col:
                output_warnings.append(
                    f"Label column detected (\'{bl.label_col}\'): "
                    "per-class copulas fitted for label-first generation."
                )
        else:
            output_warnings.append("Probabilistic model loaded from cache — cache validated against baseline hash, schema version, and generator version.")
            if label_distribution is not None and bl.label_col:
                output_warnings.append(
                    "Label override applied with cached probabilistic model."
                )
        actual_engine = ProbabilisticEngine.ENGINE_NAME

    else:  # ctgan
        engine = CTGANEngine(bl, rng, cache_dir)
        if not engine.load_cache():
            df_orig = _load_original(dataset_path, bl)
            engine.fit(df_orig)
            engine.save_cache()
            output_warnings.append("CTGAN model fitted and cached.")
        else:
            output_warnings.append("CTGAN model loaded from cache — cache validated against baseline hash, schema version, and generator version.")
        actual_engine = engine.engine_used
        if actual_engine != CTGANEngine.ENGINE_NAME:
            output_warnings.append(
                "ctgan package not installed — fell back to ProbabilisticEngine. "
                "Install with: pip install ctgan"
            )

    # ---- ValidationLayer ----
    try:
        df_orig_for_dedup = _load_original(dataset_path, bl)
    except Exception as e:
        _log.warning(
            "fallback path activated: DuplicatePreFilter disabled because original dataset load failed: %s",
            e,
        )
        degraded = True
        degradation_errors.append("duplicate pre-filter disabled; original dataset load failed")
        df_orig_for_dedup = None
        output_warnings.append(
            f"DuplicatePreFilter disabled (could not load original dataset): {e}"
        )

    vl = ValidationLayer(
        bl           = bl,
        rng          = rng,
        original_df  = df_orig_for_dedup,
        max_failures = 1,
    )

    # ---- Retry loop ----
    _t_pipeline_start      = time.perf_counter()
    _generation_time_sec   = 0.0
    _consecutive_zero      = 0   # Phase 12: consecutive zero-yield round counter
    _consecutive_low_rate  = 0   # F-8: consecutive low-acceptance-rate counter

    for round_idx in range(_MAX_QUALITY_ROUNDS):
        still_need = n - cp.n_collected
        if still_need <= 0:
            break

        # Phase 5: batch_size cap prevents memory DoS on huge n requests
        raw_batch_size = max(still_need, int(still_need * (1.0 + 0.25 * round_idx)))
        batch_size     = min(raw_batch_size, _BATCH_SIZE_MAX)

        _t_gen_start = time.perf_counter()
        raw_batch    = engine.sample(batch_size)
        _generation_time_sec += time.perf_counter() - _t_gen_start

        result = vl.run(raw_batch, n_requested=n)
        output_warnings.extend(result.warnings)

        accept_df = result.clean_df.iloc[: max(still_need, 0)]

        # F-8 / Phase 7: acceptance-rate threshold guard
        n_evaluated = getattr(result, "n_evaluated", len(raw_batch))
        n_accepted  = len(accept_df)
        if n_evaluated > 0:
            acceptance_rate = n_accepted / n_evaluated
            if acceptance_rate < _MIN_ACCEPTANCE_RATE:
                _consecutive_low_rate += 1
                if _consecutive_low_rate >= 2:
                    cp.seal(status="failed", warnings=output_warnings)
                    raise _PipelineError(_ErrorCode.PIPELINE_FAILED, 
                        f"generate(): acceptance rate too low — {acceptance_rate:.2%} "
                        f"(< {_MIN_ACCEPTANCE_RATE:.0%} threshold) for "
                        f"{_consecutive_low_rate} consecutive rounds. "
                        f"Review baseline constraints. "
                        f"[code={StatusCode.FAILED_ACCEPTANCE}]"
                    )
            else:
                _consecutive_low_rate = 0

        # Phase 12: consecutive zero-yield guard
        if len(accept_df) == 0:
            _consecutive_zero += 1
            if _consecutive_zero >= 2 and round_idx >= 1:
                cp.seal(status="failed", warnings=output_warnings)
                raise _PipelineError(_ErrorCode.PIPELINE_FAILED, 
                    f"generate(): impossible constraints — {_consecutive_zero} consecutive "
                    f"rounds produced 0 accepted rows. "
                    f"Review baseline constraints (num_ranges / allowed_values). "
                    f"Collected {cp.n_collected}/{n} rows before failure. "
                    f"[code={StatusCode.FAILED_CONSTRAINTS}]"
                )
        else:
            _consecutive_zero = 0
            accept_df = _normalize_df_numerics(accept_df, bl)
            cp.commit(accept_df, round=round_idx, validation_result=result)

    # ── F-7 / Phase 12+13: structured PipelineStatus + failure propagation ────
    final_n = cp.n_collected
    if final_n >= n:
        pipeline_status = PipelineStatus(
            state  = "complete",
            reason = f"All {n} requested rows generated successfully.",
            code   = StatusCode.COMPLETE,
        )
        cp_seal_status = "complete"
    elif final_n == 0:
        # Ph-12: zero rows is a hard failure — seal then raise, never return silently
        pipeline_status = PipelineStatus(
            state  = "failed",
            reason = f"0/{n} rows accepted after {_MAX_QUALITY_ROUNDS} rounds. Review baseline constraints.",
            code   = StatusCode.FAILED_CONSTRAINTS,
        )
        cp.seal(status="failed", warnings=output_warnings + [pipeline_status.reason])
        raise _PipelineError(_ErrorCode.PIPELINE_FAILED, 
            f"generate(): {pipeline_status.reason} "
            f"[code={StatusCode.FAILED_CONSTRAINTS}]"
        )
    else:
        pipeline_status = PipelineStatus(
            state  = "partial",
            reason = (
                f"{final_n}/{n} accepted rows after {_MAX_QUALITY_ROUNDS} rounds. "
                "Consider lowering quality thresholds or reviewing the baseline."
            ),
            code   = StatusCode.PARTIAL,
        )
        cp_seal_status = "partial"
        output_warnings.append(pipeline_status.reason)

    cp.seal(status=cp_seal_status, warnings=output_warnings)

    _t_pipeline_end       = time.perf_counter()
    _total_pipeline_sec   = _t_pipeline_end - _t_pipeline_start

    # ---- Read final rows from CheckPoint ----
    records       = cp.export()
    rows_accepted = len(records)

    # ── Ph-10: Final consistency assert ──────────────────────────────────────
    _cp_meta_n = cp.n_collected
    if rows_accepted != _cp_meta_n:
        raise _PipelineError(_ErrorCode.PIPELINE_FAILED, 
            f"Ph-10 final consistency failure: export() returned {rows_accepted} rows "
            f"but checkpoint meta.n_collected={_cp_meta_n}. [HARD FAIL]"
        )
    for _row_idx, _row in enumerate(records):
        for _col, _val in _row.items():
            if isinstance(_val, float) and not math.isfinite(_val):
                raise _InputValidationError(_ErrorCode.INVALID_SCHEMA, 
                    f"Ph-10: non-finite value {_val!r} in output row {_row_idx} "
                    f"column '{_col}'. [HARD FAIL]"
                )
    if pipeline_status is None:
        raise _PipelineError(_ErrorCode.PIPELINE_FAILED, 
            "Ph-10: pipeline_status not set before return. [HARD FAIL]"
        )

    # ── Ph-7/8/9: Post-generation statistical quality checks ─────────────────
    # These emit warnings only — they never raise. Generation is already complete.
    # Ph-7: mean/variance proximity; Ph-8: label KL divergence; Ph-9: correlations.
    _quality_warnings: List[str] = []
    _label_kl_divergence: Optional[float] = None

    if rows_accepted > 0:
        try:
            _synth_df = pd.DataFrame(records)

            # Ph-7: Distribution validation — mean and variance per numeric column
            _MEAN_TOL = 0.20   # warn if relative mean shift > 20 %
            _VAR_TOL  = 0.50   # warn if relative variance shift > 50 %
            for _col, _spec in bl.numeric.items():
                if _col not in _synth_df.columns:
                    continue
                _orig_mean = _spec.get("mean")
                _orig_std  = _spec.get("std")
                if _orig_mean is None or _orig_std is None:
                    continue
                _synth_vals = pd.to_numeric(_synth_df[_col], errors="coerce").dropna()
                if len(_synth_vals) < 2:
                    continue
                _synth_mean = float(_synth_vals.mean())
                _synth_var  = float(_synth_vals.var())
                _orig_var   = float(_orig_std) ** 2
                # Mean check: relative to std so it's scale-independent
                _std_scale = max(abs(float(_orig_std)), 1e-9)
                if abs(_synth_mean - float(_orig_mean)) / _std_scale > _MEAN_TOL:
                    _quality_warnings.append(
                        f"Ph-7 distribution drift: column '{_col}' mean shifted by "
                        f"{abs(_synth_mean - float(_orig_mean)) / _std_scale:.2%} "
                        f"(threshold {_MEAN_TOL:.0%})."
                    )
                # Variance check: relative to original variance
                if _orig_var > 1e-12:
                    _var_ratio = abs(_synth_var - _orig_var) / _orig_var
                    if _var_ratio > _VAR_TOL:
                        _quality_warnings.append(
                            f"Ph-7 distribution drift: column '{_col}' variance shifted by "
                            f"{_var_ratio:.2%} (threshold {_VAR_TOL:.0%})."
                        )
        except Exception as _e:
            _log.warning("fallback path activated: Ph-7 distribution check skipped: %s", _e)
            degraded = True
            degradation_errors.append("Ph-7 distribution check skipped")
            _quality_warnings.append(f"Ph-7 distribution check skipped: {_e}")

        try:
            # Ph-8: Label distribution KL divergence
            if bl.label_col and bl.label_dist and bl.label_col in pd.DataFrame(records).columns:
                _synth_df_lbl = pd.DataFrame(records)
                _synth_vc = _synth_df_lbl[bl.label_col].astype(str).value_counts(normalize=True)
                _all_labels = set(bl.label_dist.keys()) | set(_synth_vc.index)
                _p_orig  = np.array([bl.label_dist.get(lbl, 0.0) for lbl in _all_labels]) + 1e-10
                _p_synth = np.array([_synth_vc.get(lbl, 0.0) for lbl in _all_labels]) + 1e-10
                _p_orig  /= _p_orig.sum()
                _p_synth /= _p_synth.sum()
                _label_kl_divergence = round(float(np.sum(_p_orig * np.log(_p_orig / _p_synth))), 4)
                if _label_kl_divergence > 0.1:
                    _quality_warnings.append(
                        f"Ph-8 label drift: KL divergence={_label_kl_divergence:.4f} "
                        f"exceeds 0.1 — generated class proportions differ from baseline."
                    )
        except Exception as _e:
            _log.warning("fallback path activated: Ph-8 label KL check skipped: %s", _e)
            degraded = True
            degradation_errors.append("Ph-8 label KL check skipped")
            _quality_warnings.append(f"Ph-8 label KL check skipped: {_e}")

        try:
            # Ph-9: Correlation consistency — check strong Pearson pairs
            _synth_df_corr = pd.DataFrame(records)
            _CORR_TOL = 0.20   # warn if abs(corr_real - corr_synth) > 0.20
            for _col_a, _col_b, _r_real in bl.strong_pearson_pairs(threshold=0.4):
                if _col_a not in _synth_df_corr.columns or _col_b not in _synth_df_corr.columns:
                    continue
                _sa = pd.to_numeric(_synth_df_corr[_col_a], errors="coerce")
                _sb = pd.to_numeric(_synth_df_corr[_col_b], errors="coerce")
                _valid = _sa.notna() & _sb.notna()
                if _valid.sum() < 10:
                    continue
                _r_synth = float(_sa[_valid].corr(_sb[_valid]))
                if abs(_r_synth - _r_real) > _CORR_TOL:
                    _quality_warnings.append(
                        f"Ph-9 correlation drift: ({_col_a}, {_col_b}) "
                        f"real_r={_r_real:.3f} synth_r={_r_synth:.3f} "
                        f"delta={abs(_r_synth - _r_real):.3f} > {_CORR_TOL}."
                    )
        except Exception as _e:
            _log.warning("fallback path activated: Ph-9 correlation check skipped: %s", _e)
            degraded = True
            degradation_errors.append("Ph-9 correlation check skipped")
            _quality_warnings.append(f"Ph-9 correlation check skipped: {_e}")

    output_warnings.extend(_quality_warnings)

    # ── Metrics ──────────────────────────────────────────────────────────────
    _gen_ms   = max(0.0, round(_generation_time_sec * 1000.0, 4))
    _total_ms = max(0.0, round(_total_pipeline_sec  * 1000.0, 4))

    _EPS = 1e-9
    if _gen_ms <= _EPS or rows_accepted <= 0:
        _rps = 0.0
    else:
        _rps = round(rows_accepted / (_gen_ms / 1000.0), 4)

    if not (math.isfinite(_gen_ms) and math.isfinite(_total_ms) and math.isfinite(_rps)):
        raise _PipelineError(_ErrorCode.PIPELINE_FAILED, 
            f"Non-finite metric: gen_ms={_gen_ms}, total_ms={_total_ms}, rps={_rps}"
        )
    if _total_ms < _gen_ms:
        raise _PipelineError(_ErrorCode.PIPELINE_FAILED, 
            f"Metrics invariant violated: total_ms ({_total_ms}) < gen_ms ({_gen_ms})."
        )
    if rows_accepted > 0 and _gen_ms > _EPS:
        _expected_rps = rows_accepted / (_gen_ms / 1000.0)
        if abs(_rps - _expected_rps) > max(1.0, _expected_rps * 0.01):
            raise _PipelineError(_ErrorCode.PIPELINE_FAILED, 
                f"Throughput invariant violated: rps={_rps} != expected={_expected_rps:.4f}."
            )

    _gen_ms_s   = _emit_scalar(_gen_ms)
    _total_ms_s = _emit_scalar(_total_ms)
    _rps_s      = _emit_scalar(_rps)

    # ── Ph-20: Output contract lock ───────────────────────────────────────────
    # The exact set of top-level keys is fixed. Any missing key means a code
    # path failed to set a value; any extra key means untested output leaked.
    # Both conditions are hard failures — callers depend on this contract.
    _OUTPUT_CONTRACT = frozenset({
        "samples", "generator_used", "row_count", "dataset_fingerprint",
        "run_id", "warnings", "checkpoint_path", "label_distribution_applied",
        "pipeline_status", "metrics",
        # Ph-7/8/9 additions (non-breaking new keys)
        "label_kl_divergence", "quality_warnings",
        # Decision layer: human-readable summary
        "summary",
    })
    _METRICS_CONTRACT = frozenset({
        "generation_time_ms", "total_pipeline_time_ms",
        "throughput_rows_per_sec", "rows_accepted",
    })

    def _build_summary(gen_result: dict) -> str:
        row_count = gen_result.get("row_count", 0)
        engine = gen_result.get("generator_used", "unavailable")
        warnings = gen_result.get("quality_warnings") or []
        status = gen_result.get("pipeline_status", {}).get("code", "")
        if status in (
            "FAILED_CONSTRAINTS",
            "FAILED_ACCEPTANCE",
            "FAILED_UNKNOWN",
            "EMPTY_BASELINE",
            "INVALID_INPUT",
        ):
            return "Generation failed — no reliable data produced."
        if warnings:
            return f"Synthetic dataset generated with quality issues ({len(warnings)} warnings)."
        if row_count == 0:
            return "No data generated."
        if row_count < 50:
            return f"Small synthetic dataset generated using {engine} engine."
        return f"Synthetic dataset generated successfully using {engine} engine."

    _result = {
        "samples":                    records,
        "generator_used":             actual_engine,
        "row_count":                  rows_accepted,
        "dataset_fingerprint":        bl.fingerprint,
        "run_id":                     run_id,
        "warnings":                   output_warnings,
        "checkpoint_path":            cp_path,
        "label_distribution_applied": label_dist_applied,
        "pipeline_status":            pipeline_status.to_dict(),
        "label_kl_divergence":        _label_kl_divergence,
        "quality_warnings":           _quality_warnings,
        "summary":                    "",   # patched below after _result is fully assigned
        "metrics": {
            "generation_time_ms":      _gen_ms_s,
            "total_pipeline_time_ms":  _total_ms_s,
            "throughput_rows_per_sec": _rps_s,
            "rows_accepted":           rows_accepted,
        },
    }
    if degraded:
        _result["degraded"] = True
        _result["errors"] = sorted(set(degradation_errors))

    _output_contract = set(_OUTPUT_CONTRACT)
    if degraded:
        _output_contract.update({"degraded", "errors"})

    # Patch summary after assignment so _result is fully available
    _result["summary"] = _build_summary(_result)

    _actual_keys   = frozenset(_result.keys())
    _metrics_keys  = frozenset(_result["metrics"].keys())
    _missing       = frozenset(_output_contract) - _actual_keys
    _extra         = _actual_keys - frozenset(_output_contract)
    _missing_m     = _METRICS_CONTRACT - _metrics_keys
    _extra_m       = _metrics_keys - _METRICS_CONTRACT

    if _missing:
        raise _PipelineError(_ErrorCode.PIPELINE_FAILED, 
            f"Ph-20 output contract violation: missing keys {sorted(_missing)}. [HARD FAIL]"
        )
    if _extra:
        raise _PipelineError(_ErrorCode.PIPELINE_FAILED, 
            f"Ph-20 output contract violation: unexpected extra keys {sorted(_extra)}. [HARD FAIL]"
        )
    if _missing_m:
        raise _PipelineError(_ErrorCode.PIPELINE_FAILED, 
            f"Ph-20 metrics contract violation: missing keys {sorted(_missing_m)}. [HARD FAIL]"
        )
    if _extra_m:
        raise _PipelineError(_ErrorCode.PIPELINE_FAILED, 
            f"Ph-20 metrics contract violation: unexpected extra keys {sorted(_extra_m)}. [HARD FAIL]"
        )

    _write_run_log(_result)

    return _result


# Section 9 — Math / sampling helpers
#
# _build_quantile_cdf       : build piecewise-linear inverse CDF from spec
# _quantile_cdf_sample      : inverse-CDF sampling (no rejection, bounded)
# _nearest_pd               : nearest positive-definite matrix (Higham 1988)
# _to_standard_normal       : rank-based transform array → N(0,1)
# _resample_out_of_range    : replace OOB values using quantile CDF resample
# _apply_cholesky_correlations : Gaussian copula Cholesky correlation injection
# _load_original            : load original dataframe from disk
# _df_to_json_records       : DataFrame → JSON-safe list of dicts
# _emit_scalar              : Ph-13/14/18 — normalize any scalar before output
# ==================================================================


def _emit_scalar(v: Any, decimals: int = 4) -> Any:
    """
    Ph-13 / Ph-14 / Ph-18: Normalize a scalar value before it leaves this module.

    Applies in order:
      Ph-14: Convert numpy scalar → native Python float/int.
      Ph-18: Clamp abs(v) < 1e-9 to 0.0 (eliminates floating-point dust).
      Ph-13: round(v, decimals) for uniform 4-decimal precision on floats.

    Non-numeric values (str, None, bool) pass through unchanged.
    NaN/Inf are rejected — caller should have screened with _assert_numeric_safe.
    """
    # Ph-14: strip numpy scalar wrapper
    if hasattr(v, "item"):
        v = v.item()
    if v is None or isinstance(v, bool) or isinstance(v, str):
        return v
    if isinstance(v, float):
        if not math.isfinite(v):
            raise _InputValidationError(_ErrorCode.INVALID_SCHEMA, 
                f"_emit_scalar: non-finite value {v!r} must not reach output. [HARD FAIL]"
            )
        # Ph-18: clamp floating-point dust to exact zero
        if abs(v) < 1e-9:
            v = 0.0
        # Ph-13: uniform 4-decimal precision
        return round(v, decimals)
    if isinstance(v, int):
        return v
    return v


def _baseline_hash(bl: "BaselineReader") -> str:
    """
    Phase 10: produce a stable SHA-256 fingerprint of the baseline content.

    Used by ProbabilisticEngine to detect when the cached model was
    trained on a different baseline than the one now in use.  If the
    hashes differ, load_cache() returns False and the model is retrained.
    """
    # Serialize only the columns and constraints sections — these are the
    # parts that determine how the copula is fitted and how samples are
    # constrained.  Meta fields (timestamps, row_count) are excluded to
    # avoid spurious cache misses.
    sig = {
        "numeric":     bl.numeric,
        "categorical": bl.categorical,
        "num_ranges":  {k: list(v) for k, v in bl.num_ranges.items()},
        "allowed":     bl.allowed,
    }
    canonical = json.dumps(sig, sort_keys=True, ensure_ascii=False, default=str)
    return hashlib.sha256(canonical.encode("utf-8")).hexdigest()


def _build_quantile_cdf(
    spec: Dict[str, Any],
) -> Tuple[Optional[np.ndarray], Optional[np.ndarray]]:
    """
    Build a piecewise-linear inverse CDF from a numeric column spec.

    Uses all quantile statistics present in the spec:
        (0.00 → min)
        (0.01 → q01)   if available
        (0.05 → q05)   if available
        (0.25 → q25)   if available
        (0.50 → q50)   if available, else mean used as anchor
        (0.75 → q75)   if available
        (0.95 → q95)   if available
        (0.99 → q99)   if available
        (1.00 → max)

    The resulting (levels, values) arrays can be passed directly to
    np.interp(u, levels, values) for inverse-CDF sampling.

    Returns (None, None) when min or max are unavailable.

    Properties:
    • Naturally bounded: output ∈ [min, max] for any u ∈ [0, 1]
    • Distribution-shape-preserving: median, IQR, tails all matched
    • Works for symmetric, skewed, and heavy-tailed distributions
    • Monotone by construction (duplicate levels removed; non-monotone
      values floored to the previous value)
    """
    lo = spec.get("min")
    hi = spec.get("max")
    if lo is None or hi is None:
        return None, None

    lo, hi = float(lo), float(hi)

    # Ordered (probability_level, quantile_value) anchor pairs
    anchors: List[Tuple[float, float]] = [(0.0, lo), (1.0, hi)]

    for key, level in (
        ("q01", 0.01), ("q05", 0.05), ("q25", 0.25),
        ("q50", 0.50),
        ("q75", 0.75), ("q95", 0.95), ("q99", 0.99),
    ):
        val = spec.get(key)
        if val is not None:
            anchors.append((level, float(val)))

    # If q50 is absent, use mean as a central anchor
    has_q50 = any(abs(lv - 0.50) < 1e-9 for lv, _ in anchors)
    if not has_q50:
        mean_val = spec.get("mean")
        if mean_val is not None:
            anchors.append((0.50, float(mean_val)))

    # Sort by level; resolve duplicate levels (keep last — finer stats win)
    anchors.sort(key=lambda x: x[0])
    deduped: Dict[float, float] = {}
    for lv, val in anchors:
        deduped[lv] = val

    levels = np.array(sorted(deduped.keys()), dtype=float)
    values = np.array([deduped[l] for l in levels], dtype=float)

    # Enforce monotonicity: CDF values must be non-decreasing
    for i in range(1, len(values)):
        if values[i] < values[i - 1]:
            values[i] = values[i - 1]

    return levels, values


def _quantile_cdf_sample(
    n:      int,
    levels: np.ndarray,
    values: np.ndarray,
    rng:    np.random.Generator,
) -> np.ndarray:
    """
    Draw n samples from the distribution defined by the piecewise-linear
    inverse CDF (levels, values) by sampling U ~ Uniform(0, 1) and
    applying np.interp.

    Properties:
    • 100% acceptance rate — no rejection loop
    • Output is naturally bounded within [values[0], values[-1]]
    • Preserves the full distribution shape encoded in the quantile points
    """
    u = rng.uniform(0.0, 1.0, size=n)
    return np.interp(u, levels, values)

def _resample_out_of_range(
    arr:  np.ndarray,
    lo:   float,
    hi:   float,
    spec: Dict[str, Any],
    rng:  np.random.Generator,
    max_attempts: int = 10,
) -> np.ndarray:
    """
    Replace values outside [lo, hi] by resampling from the quantile CDF of
    the column's marginal distribution (defined by spec).

    Uses quantile-CDF sampling rather than Gaussian resampling so that the
    distribution shape — including skew and tail weight — is respected.
    This is the replacement for np.clip: boundary values appear only at
    their natural frequency rather than being artificially concentrated.

    Last-resort clamp (applied to any value still out-of-range after
    max_attempts) is deliberately kept so the method always terminates;
    for well-specified columns this path should never fire.
    """
    out_mask = (arr < lo) | (arr > hi)
    if not out_mask.any():
        return arr

    arr    = arr.copy()
    levels, values = _build_quantile_cdf(spec)

    for _ in range(max_attempts):
        still_out = np.where(out_mask)[0]
        if len(still_out) == 0:
            break
        if levels is not None:
            fresh = _quantile_cdf_sample(len(still_out), levels, values, rng)
        else:
            mean  = float(spec.get("mean", (lo + hi) / 2))
            std_v = float(spec.get("std",  (hi - lo) / 4)) or 1e-6
            fresh = rng.normal(mean, std_v, size=len(still_out))
        arr[still_out]      = fresh
        out_mask[still_out] = (fresh < lo) | (fresh > hi)

    # Last resort: clamp any remaining stragglers
    remaining = np.where(out_mask)[0]
    if len(remaining) > 0:
        arr[remaining] = np.where(arr[remaining] < lo, lo, hi)
    return arr


def _apply_cholesky_correlations(
    data: Dict[str, np.ndarray],
    bl:   "BaselineReader",
    rng:  np.random.Generator,
    n:    int,
) -> Dict[str, np.ndarray]:
    """
    Inject Pearson-based covariance into numeric columns via a Gaussian copula
    Cholesky decomposition.  Preserves each column's marginal distribution
    exactly while introducing the target inter-column correlations.

    Algorithm (correct copula round-trip):
      1. Map each column to U[0,1] via rank-based empirical CDF transform.
      2. Apply probit (Φ⁻¹) to map U → Z ~ N(0,1).
      3. Multiply by Cholesky factor L of the target correlation matrix
         so that Cov(Z_corr) ≈ target_corr.
      4. Apply standard normal CDF Φ to map Z_corr back to U_corr ∈ (0,1).
      5. Apply inverse quantile CDF (Q⁻¹) of each column's marginal to
         map U_corr → values in the original data space.

    Step 5 uses the piecewise-linear quantile CDF built from the baseline
    spec, which preserves skew, tails, and IQR rather than assuming Gaussian
    marginals.  Out-of-range values are resolved by resample-retry.
    """
    try:
        from scipy.special import ndtr as _ndtr   # standard normal CDF Φ
    except ImportError:
        _log.warning(
            "fallback path activated: scipy not installed; using numpy erfc fallback for normal CDF"
        )
        import warnings as _w
        _w.warn(
            "scipy not installed; using numpy erfc fallback for Φ(z) in correlation enforcement. "
            "Results are mathematically equivalent but may differ in numerical precision at extreme tails. "
            "Install scipy for optimal accuracy: pip install scipy",
            RuntimeWarning, stacklevel=2,
        )
        _ndtr = None  # pure-numpy fallback used below

    pairs = bl.strong_pearson_pairs(threshold=0.4)
    if not pairs:
        return data

    involved: List[str] = []
    for a, b, _ in pairs:
        if a not in involved and a in data:
            involved.append(a)
        if b not in involved and b in data:
            involved.append(b)

    if len(involved) < 2:
        return data

    k       = len(involved)
    corr    = np.eye(k)
    col_idx = {c: i for i, c in enumerate(involved)}

    for a, b, v in pairs:
        if a in col_idx and b in col_idx:
            i, j       = col_idx[a], col_idx[b]
            corr[i, j] = v
            corr[j, i] = v

    corr = _nearest_pd(corr)

    try:
        L = np.linalg.cholesky(corr)
    except np.linalg.LinAlgError:
        _log.warning(
            "fallback path activated: Cholesky decomposition failed; skipping correlation injection"
        )
        return data  # bail gracefully

    # Step 1–3: rank → Z → Cholesky-correlated Z_corr
    Z      = np.column_stack([_to_standard_normal(data[c], rng) for c in involved])
    Z_corr = Z @ L.T

    # Step 4: Z_corr → U_corr via Φ
    if _ndtr is not None:
        U_corr = _ndtr(Z_corr)
    else:
        # Pure numpy fallback: Φ(z) = 0.5 * erfc(-z / sqrt(2))
        U_corr = 0.5 * np.vectorize(math.erfc, otypes=[float])(-Z_corr / np.sqrt(2.0))

    # Clip strictly inside (0,1) so Q⁻¹ interpolation never extrapolates
    U_corr = np.clip(U_corr, 1e-7, 1.0 - 1e-7)

    # Step 5: U_corr → original data space via per-column inverse quantile CDF
    for i, col in enumerate(involved):
        spec          = bl.numeric[col]
        lo            = float(spec.get("min", -np.inf))
        hi            = float(spec.get("max",  np.inf))
        levels, values = _build_quantile_cdf(spec)

        if levels is not None:
            raw = np.interp(U_corr[:, i], levels, values)
        else:
            # Degenerate spec — Gaussian fallback
            mean = float(spec.get("mean", 0.0))
            std  = float(spec.get("std",  1.0)) or 1.0
            raw  = Z_corr[:, i] * std + mean

        data[col] = _resample_out_of_range(raw, lo, hi, spec, rng)

    return data

def _nearest_pd(A: np.ndarray) -> np.ndarray:
    """
    Find the nearest positive-definite matrix to A.
    Uses the Higham (1988) algorithm via eigenvalue flooring.
    Ensures Cholesky decomposition never fails due to numerical noise.
    """
    B    = (A + A.T) / 2
    eigvals, eigvecs = np.linalg.eigh(B)
    eigvals = np.maximum(eigvals, 1e-8)
    return eigvecs @ np.diag(eigvals) @ eigvecs.T


def _to_standard_normal(arr: np.ndarray, rng: np.random.Generator) -> np.ndarray:
    """
    Rank-based transform: map arr to approximately N(0,1).
    Used by StatisticalEngine's Cholesky step.
    Ties are broken with a small random perturbation to avoid flat regions.
    """
    n      = len(arr)
    noise  = rng.random(n) * 1e-10
    ranks  = np.argsort(np.argsort(arr.astype(float) + noise))
    # Map ranks to (0,1) then apply probit
    u      = (ranks + 0.5) / n
    u      = np.clip(u, 1e-6, 1.0 - 1e-6)
    # Probit via erfcinv: z = sqrt(2) * erfcinv(2 * (1 - u))
    return np.sqrt(2.0) * _erfcinv(2.0 * (1.0 - u))


def _erfcinv(y: np.ndarray) -> np.ndarray:
    """
    Inverse complementary error function — pure numpy implementation.
    erfcinv(y) = erfinv(1 - y).

    Uses the Abramowitz & Stegun rational approximation split into
    two polynomial branches.  Accurate to ~6 significant figures.
    No scipy dependency — used by _to_standard_normal in the
    StatisticalEngine path.
    """
    x = np.clip(1.0 - y, -1.0 + 1e-9, 1.0 - 1e-9)
    w = -np.log((1.0 - x) * (1.0 + x))

    # Branch 1 coefficients (w < 5, central region)
    w1   = w - 2.5
    c1_0 = 2.81022636e-08
    c1_1 = 3.43273939e-07
    c1_2 = -3.52338770e-06
    c1_3 = -4.39150654e-06
    c1_4 = 2.18580870e-04
    c1_5 = -1.25372503e-03
    c1_6 = -4.17768164e-03
    c1_7 = 2.46640727e-01
    c1_8 = 1.50140941e+00
    p1 = c1_8 + w1 * (c1_7 + w1 * (c1_6 + w1 * (c1_5 + w1 * (
         c1_4 + w1 * (c1_3 + w1 * (c1_2 + w1 * (c1_1 + w1 * c1_0)))))))

    # Branch 2 coefficients (w >= 5, tail region)
    w2   = np.sqrt(np.maximum(w, 0.0)) - 3.0
    c2_0 = -2.00214257e-04
    c2_1 = 1.00950558e-04
    c2_2 = 1.34934322e-03
    c2_3 = -3.67342844e-03
    c2_4 = 5.73950773e-03
    c2_5 = -7.62246130e-03
    c2_6 = 9.43887047e-03
    c2_7 = 1.00167406e+00
    c2_8 = 2.83297682e+00
    p2 = c2_8 + w2 * (c2_7 + w2 * (c2_6 + w2 * (c2_5 + w2 * (
         c2_4 + w2 * (c2_3 + w2 * (c2_2 + w2 * (c2_1 + w2 * c2_0)))))))

    p = np.where(w < 5.0, p1, p2)
    return p * x


def _load_original(dataset_path: str, bl: BaselineReader) -> pd.DataFrame:
    """Load the original dataset from disk using the kind stored in the baseline."""
    kind = bl.source  # source = file path; we infer kind from extension
    ext  = os.path.splitext(dataset_path)[1].lower()

    if ext in (".csv", ".tsv"):
        return pd.read_csv(dataset_path)
    if ext in (".xlsx", ".xlsm"):
        return pd.read_excel(dataset_path)
    if ext == ".json":
        try:
            return pd.read_json(dataset_path)
        except ValueError:
            return pd.read_json(dataset_path, lines=True)
    if ext == ".parquet":
        return pd.read_parquet(dataset_path)

    # Last resort
    _log.warning(
        "fallback path activated: unsupported extension '%s' in _load_original; attempting CSV reader",
        ext,
    )
    return pd.read_csv(dataset_path)


def _df_to_json_records(df: pd.DataFrame) -> List[Dict[str, Any]]:
    """Convert DataFrame to a list of JSON-safe dicts.

    Serialization contract
    ----------------------
    • This function ONLY converts values to JSON-compatible types.
    • It does NOT round, modify, clamp, or transform any numeric value.
    • All numeric normalisation must have occurred in _normalize_df_numerics
      before this function is called.

    NaN policy
    ----------
    float NaN is a CONTRACT VIOLATION at this boundary.
    ``_normalize_df_numerics`` guarantees that null cells in numeric columns
    are stored as Python ``None`` (object dtype), not as float NaN.
    Any float NaN that reaches this function therefore represents an upstream
    error — a column that bypassed normalisation or was mutated after it.
    Such values raise ValueError immediately rather than being silently
    converted to ``null``, which would hide the violation.

    Type mappings (valid inputs only)
    ----------------------------------
    None / pd.NA / pd.NaT  → null  (JSON null — explicit missing value)
    numpy scalars           → Python scalars via .item()
    All other values        → passed through unchanged

    Raises
    ------
    ValueError — if a float NaN is encountered (contract violation).
    """
    records = []
    for row in df.to_dict(orient="records"):
        clean = {}
        for k, v in row.items():
            if v is pd.NA or v is pd.NaT:
                clean[k] = None
            elif hasattr(v, "item"):                        # numpy scalar
                item = v.item()
                if isinstance(item, float) and math.isnan(item):
                    raise _InputValidationError(_ErrorCode.INVALID_SCHEMA, 
                        f"_df_to_json_records: float NaN encountered in column "
                        f"'{k}'. NaN must be eliminated (as None) by "
                        "_normalize_df_numerics before serialisation. "
                        "A NaN here indicates a column that bypassed "
                        "normalisation or was mutated afterwards."
                    )
                clean[k] = item
            elif isinstance(v, float) and math.isnan(v):
                raise _InputValidationError(_ErrorCode.INVALID_SCHEMA, 
                    f"_df_to_json_records: float NaN encountered in column '{k}'. "
                    "NaN must be eliminated (as None) by _normalize_df_numerics "
                    "before serialisation. A NaN here indicates a column that "
                    "bypassed normalisation or was mutated afterwards."
                )
            else:
                clean[k] = v
        records.append(clean)
    return records


# ==================================================================
# Section 10 — CLI entry point
# Matches the invocation pattern used by extension.ts (cp.spawn).
# Writes one JSON object to stdout on success.
# Writes error JSON to stderr and exits with code 1 on failure.
# ==================================================================

def _main(argv: Optional[List[str]] = None) -> int:
    p = argparse.ArgumentParser(
        description="generator.py — Synthetic Data Generation Engine"
    )
    p.add_argument("dataset_path",  help="Path to the original dataset file.")
    p.add_argument("baseline_path", help="Path to the BaselineArtifact JSON file.")
    p.add_argument("--n",           type=int, required=True,
                   help="Number of synthetic rows to generate.")
    p.add_argument("--cache-dir",   default=None,
                   help="Directory for model cache files.")
    p.add_argument("--seed",        type=int, default=None,
                   help="Random seed for reproducibility.")
    args = p.parse_args(argv)

    # Suppress noisy third-party warnings (pandas FutureWarning etc.)
    # so they don't pollute stdout and break JSON parsing in the extension.
    _warnings_mod.filterwarnings("ignore")

    try:
        result = generate(
            dataset_path  = args.dataset_path,
            baseline_path = args.baseline_path,
            n             = args.n,
            cache_dir     = args.cache_dir,
            seed          = args.seed,
        )
        # Phase 7: Validate GeneratorOutput fields before emitting
        _required_gen_fields = {"samples", "generator_used", "row_count"}
        _missing = _required_gen_fields - set(result.keys() if isinstance(result, dict) else [])
        if _missing:
            raise _PipelineError(_ErrorCode.OUTPUT_INVALID, f"GeneratorOutput missing required fields: {_missing}")
        if not isinstance(result.get("samples"), list):
            raise _PipelineError(_ErrorCode.OUTPUT_INVALID, "GeneratorOutput.samples must be a list")
        if not isinstance(result.get("row_count"), int):
            raise _PipelineError(_ErrorCode.OUTPUT_INVALID, "GeneratorOutput.row_count must be an int")
        sys.stdout.write(json.dumps(result, ensure_ascii=False) + "\n")
        return 0

    except Exception as exc:
        err = {"error": str(exc), "type": type(exc).__name__}
        _log.error("generator._main failed: %s", exc, exc_info=True)
        sys.stdout.write(json.dumps(err, ensure_ascii=False) + "\n")
        return 1


if __name__ == "__main__":
    raise SystemExit(_main())
