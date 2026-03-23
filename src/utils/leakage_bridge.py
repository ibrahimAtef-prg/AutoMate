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
import logging as _logging
_log = _logging.getLogger(__name__)
import argparse, json, math, os, sys, time, traceback, warnings
import importlib.util as _importlib_util
from typing import Any, Dict, List, Optional
from .config import (
    AUC_CONFIDENCE_SATURATION,
    DRIFT_CONFIDENCE_VARIANCE_SCALE,
    QUALITY_DRIFT_SCALE,
    QUALITY_LABEL_SCALE,
    QUALITY_WEIGHT_AUC,
    QUALITY_WEIGHT_DRIFT,
    QUALITY_WEIGHT_LABEL,
)

# ── CORE/EDGE error model ─────────────────────────────────────────────────────
# CORE functions (_compute_local_metrics, _build_pipeline_metrics,
#   _assert_output_envelope, _safe_merge) → raise typed AutoMateError on violation
# EDGE functions (drift loops, confidence scoring, quality scoring,
#   risk intelligence) → warnings.warn and return safe defaults
# ─────────────────────────────────────────────────────────────────────────────
_ERRORS_PATH_LB = os.path.normpath(
    os.path.join(os.path.dirname(os.path.abspath(__file__)), "errors.py")
)
_lb_errs_spec = _importlib_util.spec_from_file_location("utils.errors", _ERRORS_PATH_LB)
if "utils.errors" in __import__("sys").modules:
    _lb_errs_mod = __import__("sys").modules["utils.errors"]
    __import__("sys").modules.setdefault("errors", _lb_errs_mod)
elif "errors" in __import__("sys").modules:
    _lb_errs_mod = __import__("sys").modules["errors"]
    __import__("sys").modules["utils.errors"] = _lb_errs_mod
else:
    _lb_errs_mod = _lb_errs_mod  = _importlib_util.module_from_spec(_lb_errs_spec)
    __import__("sys").modules["utils.errors"] = _lb_errs_mod
    __import__("sys").modules["errors"] = _lb_errs_mod
    _lb_errs_spec.loader.exec_module(_lb_errs_mod)
InputValidationError = _lb_errs_mod.InputValidationError
PipelineError        = _lb_errs_mod.PipelineError
ErrorCode            = _lb_errs_mod.ErrorCode

# ── Schema enforcement ────────────────────────────────────────────────────────
# Locate governance_schema via importlib — no sys.path mutation required.
_SCHEMA_DIR = os.path.normpath(
    os.path.join(os.path.dirname(os.path.abspath(__file__)), "..", "schema")
)
_SCHEMA_MODULE_PATH = os.path.join(_SCHEMA_DIR, "governance_schema.py")

def _load_governance_schema():
    """Load governance_schema without mutating sys.path."""
    spec = _importlib_util.spec_from_file_location("governance_schema", _SCHEMA_MODULE_PATH)
    if spec is None or spec.loader is None:
        raise ImportError(
            f"Cannot locate governance_schema at {_SCHEMA_MODULE_PATH}. "
            "Ensure src/schema/governance_schema.py exists."
        )
    mod = _importlib_util.module_from_spec(spec)
    sys.modules[spec.name] = mod
    spec.loader.exec_module(mod)  # type: ignore[union-attr]
    return mod

try:
    _gs = _load_governance_schema()
    LeakageOutput        = _gs.LeakageOutput
    SchemaValidationError = _gs.SchemaValidationError
    _schema_validate     = _gs.validate_dict
    _SCHEMA_AVAILABLE    = True
except ImportError as _schema_import_err:
    raise ImportError(
        f"governance_schema is required by leakage_bridge: {_schema_import_err}"
    ) from _schema_import_err
except Exception as _schema_bootstrap_err:
    _log.error("[HARD FAIL] schema bootstrap failed unexpectedly: %s", _schema_bootstrap_err)
    raise RuntimeError(
        f"[HARD FAIL] schema bootstrap failed unexpectedly: {_schema_bootstrap_err}"
    ) from _schema_bootstrap_err

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
    "_mode":                    "error",
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
    # Degradation contract: only emitted when degraded=True
    "degraded":                 None,
    "errors":                   None,
}


def _safe_merge(partial: Dict[str, Any]) -> Dict[str, Any]:
    """
    Merge partial dict on top of the skeleton and validate against LeakageOutput schema.

    PHASE 1 ENFORCEMENT: Every output from this module passes through schema
    validation before being returned. An invalid payload raises SchemaValidationError
    immediately — it is never silently returned or swallowed.

    If governance_schema cannot be imported the module fails at load time, so
    this function is only reachable when the schema is fully available.
    """
    result = dict(_SAFE_OUTPUT)
    for k, v in partial.items():
        if k in result:
            result[k] = v

    # Validate and re-serialise through the schema model.
    # from_dict() normalises sub-models; validate() enforces all constraints.
    try:
        validated: LeakageOutput = _schema_validate(result)
    except SchemaValidationError as exc:
        raise SchemaValidationError(
            f"leakage_bridge output failed schema validation: {exc}"
        ) from exc

    return validated.to_dict()


def _validated_output(partial: Dict[str, Any]) -> Dict[str, Any]:
    """Alias for _safe_merge — use this name for clarity in new code."""
    return _safe_merge(partial)


def _assert_output_envelope(envelope: Dict[str, Any]) -> None:
    """
    Ph-5: Hard validation gate applied to EVERY envelope before it is
    serialized to stdout. No envelope may exit this module without passing.

    Checks:
      1. 'data' key is present and is a dict (LeakageOutput-shaped).
      2. All numeric values in 'metrics' are finite (no NaN / ±Inf).
      3. The envelope itself is a dict (not None, not a list).

    Raises RuntimeError or ValueError immediately on any violation.
    [HARD FAIL — no silent output of invalid data]
    """
    if not isinstance(envelope, dict):
        raise PipelineError(
            ErrorCode.ENVELOPE_INVALID,
            f"Ph-5: output envelope is {type(envelope).__name__}, expected dict.",
        )
    if "data" not in envelope:
        raise PipelineError(
            ErrorCode.ENVELOPE_INVALID,
            "Ph-5: output envelope missing required 'data' key.",
        )
    data = envelope["data"]
    if not isinstance(data, dict):
        raise PipelineError(
            ErrorCode.ENVELOPE_INVALID,
            f"Ph-5: envelope['data'] is {type(data).__name__}, expected dict.",
        )
    # Numeric safety on metrics block
    metrics = envelope.get("metrics", {})
    if isinstance(metrics, dict):
        for k, v in metrics.items():
            if isinstance(v, float) and not __import__("math").isfinite(v):
                raise InputValidationError(
                    ErrorCode.NON_FINITE_VALUE,
                    f"Ph-5: non-finite metric value {v!r} for key '{k}' in output envelope.",
                )



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
        except ValueError as exc:
            _log.warning("fallback path activated: JSON parse failed, retrying as JSONL: %s", exc)
            return pd.read_json(path, lines=True)
        except Exception as exc:
            _log.error("[HARD FAIL] unexpected JSON load failure for '%s': %s", path, exc)
            raise RuntimeError(f"[HARD FAIL] unexpected JSON load failure: {exc}") from exc
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
    except OSError as _scan_err:
        # Sibling-dir scan is best-effort; an OSError here means the full
        # pipeline is simply unavailable — local mode will be used instead.
        _log.warning(
            "leakage_bridge: sibling-dir pipeline scan failed (%s); using local mode.",
            _scan_err,
        )
    return None


# ─── JS divergence helper ────────────────────────────────────────────────────

def _js_div(a_vals, b_vals, bins: int = 20) -> float:
    import numpy as np
    # Phase 17: empty arrays produce undefined divergence — return 0.0 (no information)
    if len(a_vals) == 0 or len(b_vals) == 0:
        return 0.0
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
    CORE function — fail-fast on any invalid input.

    Compute privacy metrics locally without any external pipeline.
    Returns a dict that is ALWAYS merged through _safe_merge so all keys exist.

    Boundary assertion: validates all inputs before any computation begins.
    No warnings are emitted here — any violation raises immediately.
    """
    import numpy as np
    import pandas as pd

    # ── CORE boundary assertion ───────────────────────────────────────
    # This is the CORE→computation entry point. All inputs must be valid
    # before any EDGE reporting logic is invoked.
    if original_df is None:
        raise InputValidationError(
            ErrorCode.EMPTY_DATASET,
            "_compute_local_metrics: original_df must not be None.",
        )
    if not hasattr(original_df, "columns") or not hasattr(original_df, "shape"):
        raise InputValidationError(
            ErrorCode.TYPE_MISMATCH,
            f"_compute_local_metrics: original_df must be a DataFrame, "
            f"got {type(original_df).__name__}.",
        )
    if original_df.shape[0] == 0 or original_df.shape[1] == 0:
        raise InputValidationError(
            ErrorCode.EMPTY_DATASET,
            f"_compute_local_metrics: original_df is empty "
            f"(shape={original_df.shape}).",
        )
    if not isinstance(n_samples, int) or n_samples <= 0:
        raise InputValidationError(
            ErrorCode.OUT_OF_RANGE,
            f"_compute_local_metrics: n_samples must be a positive int, "
            f"got {n_samples!r}.",
        )
    # ── End boundary assertion ────────────────────────────────────────

    rng = np.random.default_rng(seed)
    degraded = False
    errors: List[str] = []

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
        nonlocal degraded, errors
        out = []
        for v in row:
            try:
                out.append(str(round(float(v), 4)))
            except Exception as e:
                _log.warning("fallback path activated: serialization failed: %s", v)
                degraded = True
                errors.append(f"serialization failed in duplicates_rate normalization: {e}")
                continue
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
    except Exception as e:
        _log.warning("fallback path activated: duplicates_rate failed: %s", e)
        degraded = True
        errors.append("duplicates_rate failed")
        duplicates_rate = None

    # ── Step 3: Statistical drift — Ph-2 multi-dimensional ────────────
    # Continuous columns: Wasserstein distance (scipy preferred) or JS fallback.
    # ── CORE→EDGE BOUNDARY ────────────────────────────────────────────
    # Synthetic data generation (Steps 0–1) above this line is CORE:
    # any failure there aborts the function.
    # Everything below — drift computation, MI AUC, confidence scores,
    # risk intelligence — is EDGE-tolerant: per-column failures are
    # warned and skipped; the overall computation continues with reduced
    # signal, reflected in has_uncertainty and uncertainty_notes.
    # ─────────────────────────────────────────────────────────────────

    # Discrete/categorical columns: KL divergence (symmetrised).
    # Aggregate: weighted mean (continuous cols weighted by std, cats equal weight).
    column_drift: Dict[str, float] = {}
    drift_scores: List[float] = []
    drift_weights: List[float] = []
    statistical_drift: str = "unknown"
    avg_drift: Optional[float] = None
    try:
        # Ph-6: seed derived from dataset signature (fingerprint hash) → deterministic + dataset-dependent
        _fp_str = str(original_df.shape) + str(list(original_df.columns))
        _fp_seed = int(abs(hash(_fp_str)) % (2**31))
        _drng = np.random.default_rng(_fp_seed)

        try:
            from scipy.stats import wasserstein_distance as _wdist
            _has_scipy = True
        except ImportError:
            _has_scipy = False

        for col in num_cols:
            try:
                a_v = pd.to_numeric(original_df[col], errors="coerce").dropna().values
                b_v = synthetic_df[col].astype(float).values if col in synthetic_df else np.zeros(n_samples)
                if len(a_v) < 2 or len(b_v) < 2:
                    continue
                if _has_scipy:
                    # Ph-2: Wasserstein distance — normalized by std so columns are comparable
                    _col_std = float(np.std(a_v)) or 1.0
                    raw_w = float(_wdist(a_v / _col_std, b_v / _col_std))
                    # Map to [0,1] via tanh so extreme drifts don't dominate
                    d = round(float(np.tanh(raw_w)), 4)
                else:
                    d = round(_js_div(a_v, b_v), 4)
                col_weight = float(np.std(a_v)) + 1e-9  # weight by variability
                column_drift[col] = d
                drift_scores.append(d)
                drift_weights.append(col_weight)
            except Exception as _drift_exc:
                _log.warning("fallback path activated: numeric_drift failed for column %r: %s", col, _drift_exc)
                degraded = True
                errors.append(f"numeric_drift failed for column '{col}'")

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
                # Ph-2: symmetrised KL divergence
                kl_fwd = float(np.sum(pa * np.log(pa / pb)))
                kl_rev = float(np.sum(pb * np.log(pb / pa)))
                d = round(float(np.tanh(0.5 * (kl_fwd + kl_rev))), 4)
                column_drift[col] = d
                drift_scores.append(d)
                drift_weights.append(1.0)  # categorical cols equal weight
            except Exception as _cat_drift_exc:
                _log.warning("fallback path activated: categorical_drift failed for column %r: %s", col, _cat_drift_exc)
                degraded = True
                errors.append(f"categorical_drift failed for column '{col}'")

        if drift_scores:
            total_w = sum(drift_weights) or 1.0
            avg_drift = float(sum(s * w for s, w in zip(drift_scores, drift_weights)) / total_w)
            avg_drift = round(avg_drift, 4)
            if avg_drift < 0.05:
                statistical_drift = "low"
            elif avg_drift < 0.15:
                statistical_drift = "moderate"
            else:
                statistical_drift = "high"
    except Exception as e:
        _log.warning("fallback path activated: statistical_drift failed: %s", e)
        degraded = True
        errors.append("statistical_drift failed")
        statistical_drift = "unknown"
        column_drift = {}
        avg_drift = None

    if statistical_drift == "unknown":
        degraded = True
        errors.append("statistical_drift unresolved (insufficient drift evidence)")

    # ── Step 4: Membership Inference AUC ──────────────────────────────
    # Ph-1: Use sklearn LogisticRegression classifier AUC when available
    # (multi-dimensional, captures non-linear boundaries). Falls back to
    # the rank-based Wilcoxon–Mann–Whitney AUC (proven correct, 1-D distances).
    membership_inference_auc: Optional[float] = None
    auc_method: str = "unavailable"       # for Ph-5 confidence metadata
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

            # Ph-1: attempt classifier AUC (sklearn preferred, rank-based fallback)
            _sklearn_auc_done = False
            try:
                from sklearn.linear_model import LogisticRegression
                from sklearn.metrics import roc_auc_score as _roc_auc
                X = np.concatenate([orig_sample, synth_sample])
                y = np.array([1] * len(orig_sample) + [0] * len(synth_sample))
                # C=1.0, max_iter=200, deterministic solver
                _lr = LogisticRegression(C=1.0, max_iter=200, random_state=42,
                                         solver="lbfgs").fit(X, y)
                _probs = _lr.predict_proba(X)[:, 1]
                membership_inference_auc = round(float(np.clip(_roc_auc(y, _probs), 0.0, 1.0)), 4)
                auc_method = "logistic_regression"
                _sklearn_auc_done = True
            except Exception as _lr_exc:
                _log.warning(
                    "fallback path activated: sklearn MI classifier failed, using rank-based AUC: %s",
                    _lr_exc,
                )
                degraded = True
                errors.append("membership_inference_auc logistic_regression failed; used rank_based")

            if not _sklearn_auc_done:
                # Rank-based Wilcoxon–Mann–Whitney fallback (1-D nearest-neighbour distances)
                def _min_dist(row, pool):
                    diffs = pool - row
                    return float(np.sqrt((diffs ** 2).sum(axis=1)).min())

                orig_dists  = [_min_dist(r, orig_sample)  for r in orig_sample]
                synth_dists = [_min_dist(r, orig_sample)  for r in synth_sample]
                combined = [(d, 1) for d in orig_dists] + [(d, 0) for d in synth_dists]
                combined.sort(key=lambda x: x[0])
                n1 = len(orig_dists); n2 = len(synth_dists)
                rank_sum = sum(i for i, (_, lbl) in enumerate(combined, start=1) if lbl == 1)
                if n1 > 0 and n2 > 0:
                    membership_inference_auc = round(
                        float(np.clip((rank_sum - n1 * (n1 + 1) / 2) / (n1 * n2), 0.0, 1.0)), 4
                    )
                    auc_method = "rank_based"
    except Exception as e:
        _log.warning("fallback path activated: membership_inference_auc failed: %s", e)
        degraded = True
        errors.append("membership_inference_auc failed")
        membership_inference_auc = None
        auc_method = "failed"

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
    except Exception as e:
        _log.warning("fallback path activated: privacy_score failed: %s", e)
        degraded = True
        errors.append("privacy_score failed")
        privacy_score = None

    # ── Step 6: Risk level — Phase 4 ─────────────────────────────────────────
    # ONLY use values accepted by LeakageOutput.validate():
    #   "low" | "medium" | "high" | "critical" | None
    # "warning" has been removed — it was not a valid schema value.
    if privacy_score is not None:
        if privacy_score >= 0.75:
            risk_level: Optional[str] = "low"
        elif privacy_score >= 0.50:
            risk_level = "medium"
        elif privacy_score >= 0.25:
            risk_level = "high"
        else:
            risk_level = "critical"
    else:
        risk_level = None

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
    def _clamp4(v: float) -> float:
        """Ph-18: clamp floating-point dust + uniform 4-decimal rounding."""
        v = float(v)
        if abs(v) < 1e-9:
            v = 0.0
        return round(v, 4)

    privacy_components = {
        "duplicates_risk":          _clamp4(dup_risk_score),
        "mi_attack_risk":           _clamp4(max(0.0, (membership_inference_auc or 0.5) - 0.5) * 2),
        "distance_similarity_risk": _clamp4(max(0.0, 0.5 - (membership_inference_auc or 0.5)) * 2),
        "distribution_drift_risk":  _clamp4(avg_drift or 0.0),
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
    except Exception as e:
        _log.warning("fallback path activated: dataset_risk_score failed: %s", e)
        degraded = True
        errors.append("dataset_risk_score failed")
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
    except Exception as e:
        _log.warning("fallback path activated: attack_results failed: %s", e)
        degraded = True
        errors.append("attack_results failed")
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

    # ── CORE→EDGE BOUNDARY ────────────────────────────────────────────
    # All CORE metric computation (drift, MI AUC, duplicates, risk score,
    # reliability) is complete above this line.  Everything below is EDGE
    # reporting logic — it warns on failure and returns safe defaults.
    # INVARIANT: if any value below raises, it is a bug in EDGE code.
    # ─────────────────────────────────────────────────────────────────

    # ── Phase 3: Dataset Risk Intelligence Engine ─────────────────────
    try:
        _ri_path = os.path.join(os.path.dirname(os.path.abspath(__file__)), "risk_intelligence.py")
        _ri_spec = _importlib_util.spec_from_file_location("risk_intelligence", _ri_path)
        if _ri_spec is None or _ri_spec.loader is None:
            raise ImportError(f"Cannot locate risk_intelligence at {_ri_path}")
        _ri_mod = _importlib_util.module_from_spec(_ri_spec)
        _ri_spec.loader.exec_module(_ri_mod)  # type: ignore[union-attr]
        compute_reidentification_risk      = _ri_mod.compute_reidentification_risk
        rank_sensitive_columns             = _ri_mod.rank_sensitive_columns
        detect_outlier_risk                = _ri_mod.detect_outlier_risk
        compute_dataset_intelligence_risk  = _ri_mod.compute_dataset_intelligence_risk
        generate_privacy_recommendations   = _ri_mod.generate_privacy_recommendations

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
    except Exception as e:
        _log.warning("fallback path activated: risk_intelligence failed: %s", e)
        degraded = True
        errors.append("risk_intelligence failed")
        reid_risk       = {}
        col_ranking     = []
        outlier_threats = []
        dir_score       = {"score": None, "label": None, "breakdown": {}}
        recs            = {"recommendations": []}


    # ── Ph-5: Metric confidence scores ────────────────────────────────
    # AUC confidence: larger sample → more reliable estimate
    # Drift confidence: lower variance across columns → more reliable estimate
    _auc_confidence: Optional[float] = None
    _drift_confidence: Optional[float] = None
    try:
        if sample_size > 0 and membership_inference_auc is not None:
            # Asymptotic: confidence saturates at AUC_CONFIDENCE_SATURATION; linear below
            _auc_confidence = round(float(min(1.0, sample_size / AUC_CONFIDENCE_SATURATION)), 4)
        if drift_scores:
            _drift_var = float(np.var(drift_scores)) if len(drift_scores) > 1 else 0.0
            # Low variance → consistent drift signal → higher confidence
            _drift_confidence = round(
                float(max(0.0, 1.0 - min(1.0, _drift_var * DRIFT_CONFIDENCE_VARIANCE_SCALE))), 4
            )
    except Exception as _conf_exc:
        _log.warning("fallback path activated: metric_confidence failed: %s", _conf_exc)
        degraded = True
        errors.append("metric_confidence failed")

    # ── Ph-8: Label distribution KL divergence ────────────────────────
    _label_kl: Optional[float] = None
    # Label KL is populated by generator.py Ph-8 hook post-generation.
    # In local mode (no generator pipeline), it remains None — this is
    # the explicit, documented contract; not a fallback or dead code.

    # ── Ph-10: Output quality score ────────────────────────────────────
    # Weighted composite: AUC proximity to 0.5 (no MI signal), low drift,
    # low label divergence. All components → [0,1]; higher = better quality.
    _quality_score: Optional[float] = None
    try:
        _q_auc    = 1.0 - abs((membership_inference_auc or 0.5) - 0.5) * 2.0   # 1.0 at AUC=0.5
        _q_drift  = max(0.0, 1.0 - (avg_drift or 0.0) * QUALITY_DRIFT_SCALE)
        _q_label  = max(0.0, 1.0 - (_label_kl or 0.0) * QUALITY_LABEL_SCALE)
        _quality_score = round(
            float(
                QUALITY_WEIGHT_AUC   * _q_auc   +
                QUALITY_WEIGHT_DRIFT  * _q_drift +
                QUALITY_WEIGHT_LABEL  * _q_label
            ), 4
        )
    except Exception as _quality_exc:
        _log.warning("fallback path activated: output_quality_score failed: %s", _quality_exc)
        degraded = True
        errors.append("output_quality_score failed")

    output_payload = {
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
        # Ph-5: metric confidence
        "metric_confidence": {
            "auc":   _auc_confidence,
            "drift": _drift_confidence,
            "auc_method": auc_method,
        },
        # Ph-8: label distribution fidelity
        "label_kl_divergence": _label_kl,
        # Ph-10: overall output quality score
        "output_quality_score": _quality_score,
    }
    if degraded:
        output_payload["degraded"] = True
        output_payload["errors"] = sorted(set(errors))

    return _safe_merge(output_payload)



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
        _log.error("[HARD FAIL] full-mode column_drift extraction failed: %s", exc)
        raise RuntimeError(f"[HARD FAIL] full-mode column_drift extraction failed: {exc}") from exc


def _extract_result(result, column_drift) -> Dict[str, Any]:
    gov = result.get("governance_result", {})
    raw = gov.get("raw_metrics", {})
    degraded = False
    errors: List[str] = []

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

    if any(t.get("severity") == "unknown" for t in top_threats):
        degraded = True
        errors.append("top_threats contains unknown severity values")
    if any(td.get("severity") == "unknown" or td.get("impacted_property") == "unknown" for td in threat_details):
        degraded = True
        errors.append("threat_details contains unknown fields")

    ps_raw    = raw.get("privacy_score")
    ps_result = result.get("privacy_score")
    privacy_score = ps_raw if ps_raw is not None else ps_result

    risk_raw = str(raw.get("leakage_risk_level") or result.get("risk_level") or "unknown")
    if risk_raw.lower() == "none":
        risk_raw = "low"
    elif risk_raw.lower() == "unknown":
        degraded = True
        errors.append("risk_level unresolved (unknown)")

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

    statistical_drift_value = str(raw.get("statistical_drift") or result.get("statistical_drift") or "unknown")
    if statistical_drift_value.lower() == "unknown":
        degraded = True
        errors.append("statistical_drift unresolved (unknown)")

    payload = {
        "risk_level":               risk_raw,
        "privacy_score":            privacy_score,
        "privacy_score_reliable":   bool(raw.get("privacy_score_reliable", False) or result.get("privacy_score_reliable", False)),
        "statistical_drift":        statistical_drift_value,
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
    }
    if degraded:
        _log.warning("fallback path activated: full-mode output degraded: %s", "; ".join(sorted(set(errors))))
        payload["degraded"] = True
        payload["errors"] = sorted(set(errors))

    return _safe_merge(payload)


# ─── Entry point ─────────────────────────────────────────────────────────────

def _build_pipeline_metrics(
    synthesis_time_sec: float,
    total_time_sec:     float,
    n_samples:          int,
) -> Dict[str, Any]:
    """
    CORE function — fail-fast on any invalid input.

    Build a validated metrics dict emitted as a top-level sibling of the
    LeakageOutput data payload.  Metrics are NEVER merged into LeakageOutput
    itself — doing so would pollute the schema contract.

    Canonical key names:
    generation_time_ms      : wall time for synthetic data generation only.
    total_pipeline_time_ms  : wall time for the full analysis call.
    throughput_rows_per_sec : n_samples / generation_time_sec.

    All values are validated to be finite and non-negative before return.
    This function is a CORE→EDGE boundary guard: it must complete without
    error before any EDGE reporting function receives the metrics dict.
    """
    # Validate raw time inputs explicitly — negative times indicate a clock
    # error and must not be silently clamped to 0.
    for arg_name, arg_val in (
        ("synthesis_time_sec", synthesis_time_sec),
        ("total_time_sec",     total_time_sec),
    ):
        if not math.isfinite(arg_val) or arg_val < 0:
            raise InputValidationError(
                ErrorCode.NEGATIVE_TIME,
                f"_build_pipeline_metrics: argument '{arg_name}' is invalid: {arg_val!r}. "
                "Time values must be finite and non-negative.",
            )

    gen_ms   = round(synthesis_time_sec * 1000.0, 4)
    total_ms = round(total_time_sec     * 1000.0, 4)

    # EPS guard: sub-millisecond synthesis on warm runs may round to exactly
    # zero; use ms value so the guard is consistent with the ms display unit.
    _EPS = 1e-9
    if gen_ms <= _EPS or n_samples <= 0:
        rps = 0.0
    else:
        rps = round(n_samples / (gen_ms / 1000.0), 4)

    for name, val in (
        ("generation_time_ms",      gen_ms),
        ("total_pipeline_time_ms",  total_ms),
        ("throughput_rows_per_sec", rps),
    ):
        if not math.isfinite(val) or val < 0:
            raise InputValidationError(
                ErrorCode.NON_FINITE_VALUE,
                f"_build_pipeline_metrics: metric '{name}' is invalid: {val!r}. "
                "All metrics must be finite and non-negative.",
            )

    # ── Group D: Metrics invariant checks ────────────────────────────────────
    if total_ms < gen_ms:
        raise InputValidationError(
            ErrorCode.METRIC_INVARIANT,
            f"_build_pipeline_metrics: invariant violated — "
            f"total_pipeline_time_ms ({total_ms:.4f}) < generation_time_ms ({gen_ms:.4f}). "
            "total must include generation plus all overhead.",
        )
    if n_samples > 0 and gen_ms > _EPS:
        _expected_rps = n_samples / (gen_ms / 1000.0)
        if abs(rps - _expected_rps) > max(1.0, _expected_rps * 0.01):
            raise InputValidationError(
                ErrorCode.METRIC_INVARIANT,
                f"_build_pipeline_metrics: invariant violated — "
                f"throughput_rows_per_sec ({rps:.4f}) != rows/gen_sec ({_expected_rps:.4f}).",
            )

    # ── Group E: Canonical float serialization — Ph-13/18 uniform rounding + clamp ──
    def _emit(v: float) -> float:
        """Ph-18: clamp floating-point dust; Ph-13: uniform 4-decimal precision."""
        if abs(v) < 1e-9:
            v = 0.0
        return round(v, 4)

    return {
        "generation_time_ms":      _emit(gen_ms),
        "total_pipeline_time_ms":  _emit(total_ms),
        "throughput_rows_per_sec": _emit(rps),
        "rows_analysed":           n_samples,
    }


def _interpret_results(metrics: dict) -> dict:
    interpretation = {}
    auc = metrics.get("membership_inference_auc")
    drift = metrics.get("statistical_drift")
    privacy = metrics.get("privacy_score")
    if auc is not None:
        if auc > 0.7:
            interpretation["auc"] = "HIGH RISK: model can distinguish real vs synthetic"
        elif auc >= 0.6:
            interpretation["auc"] = "MEDIUM RISK"
        else:
            interpretation["auc"] = "LOW RISK"
    if drift == "high":
        interpretation["drift"] = "Data distribution changed significantly"
    elif drift == "moderate":
        interpretation["drift"] = "Moderate shift detected"
    elif drift == "low":
        interpretation["drift"] = "Stable distribution"
    else:
        interpretation["drift"] = "Drift unknown"
    if privacy is not None:
        if privacy < 0.5:
            interpretation["privacy"] = "WEAK privacy protection"
        elif privacy < 0.75:
            interpretation["privacy"] = "Moderate privacy"
        else:
            interpretation["privacy"] = "Strong privacy"
    return interpretation


def _build_reasoning_context(metrics):
    metrics = metrics or {}
    return {
        "auc": metrics.get("membership_inference_auc"),
        "drift": metrics.get("statistical_drift"),
        "privacy": metrics.get("privacy_score"),
        "rows": metrics.get("n_rows") or metrics.get("row_count"),
        "duplicates": metrics.get("duplicates_rate"),
        "reliable": metrics.get("privacy_score_reliable", True),
    }


def _dynamic_weights(ctx):
    rows = ctx.get("rows") or 0
    privacy = ctx.get("privacy")
    auc = ctx.get("auc")

    privacy = 1.0 if privacy is None else privacy
    auc = 0.5 if auc is None else auc

    # small datasets → drift matters more
    if rows and rows < 300:
        return {"auc": 0.4, "privacy_risk": 0.3, "drift": 0.3}

    # high privacy risk → prioritize privacy
    if privacy < 0.6:
        return {"auc": 0.3, "privacy_risk": 0.5, "drift": 0.2}

    # strong leakage signal → prioritize auc
    if auc > 0.75:
        return {"auc": 0.6, "privacy_risk": 0.25, "drift": 0.15}

    return {"auc": 0.5, "privacy_risk": 0.3, "drift": 0.2}


def _normalize_signals(ctx):
    auc = ctx.get("auc") or 0.5
    privacy = ctx.get("privacy") or 1.0
    drift = ctx.get("drift")

    drift_map = {
        "low": 0.2,
        "minimal": 0.1,
        "moderate": 0.6,
        "high": 1.0,
    }

    drift_score = drift_map.get(drift, 0.5)

    return {
        "auc": min(max(auc, 0.0), 1.0),
        "privacy_risk": 1.0 - min(max(privacy, 0.0), 1.0),
        "drift": drift_score,
    }


def _compute_risk_score(signals, ctx):
    weights = _dynamic_weights(ctx)

    score = (
        signals["auc"] * weights["auc"] +
        signals["privacy_risk"] * weights["privacy_risk"] +
        signals["drift"] * weights["drift"]
    )

    return round(score, 4)


def _adjust_for_context(score, ctx):
    rows = ctx.get("rows") or 0
    reliable = ctx.get("reliable", True)

    # small data penalty
    if rows and rows < 300:
        score *= 0.85

    # reliability penalty
    if not reliable:
        score *= 0.7

    # extreme uncertainty (very small datasets)
    if rows and rows < 100:
        score *= 0.75

    return round(min(max(score, 0.0), 1.0), 4)


def _score_to_decision(score):
    if score >= 0.8:
        return "critical"
    elif score >= 0.55:
        return "warning"
    else:
        return "safe"


def _explain_score(level, score, signals):
    return (
        f"Risk classified as {level} "
        f"(score={score}) based on AUC={signals['auc']:.2f}, "
        f"privacy risk={signals['privacy_risk']:.2f}, "
        f"drift={signals['drift']:.2f}"
    )


def _reason_about_risk(ctx, signals, score):
    rows = ctx.get("rows") or 0
    reliable = bool(ctx.get("reliable", True))

    contributors = {
        "auc": signals["auc"],
        "privacy_risk": signals["privacy_risk"],
        "drift": signals["drift"],
    }
    dominant = max(contributors.items(), key=lambda kv: kv[1])[0]

    if not reliable:
        reason = "Confidence is reduced because metric reliability is low; score is context-penalized."
    elif rows and rows < 500 and signals["auc"] > 0.7 and signals["drift"] <= 0.2:
        reason = "High separability with low drift on limited rows suggests potential overfitting pressure."
    elif dominant == "privacy_risk":
        reason = "Privacy-risk component is the dominant contributor to the final score."
    elif dominant == "auc":
        reason = "Membership-inference separability is the dominant contributor to the final score."
    else:
        reason = "Distribution drift is the dominant contributor to the final score."

    return {
        "reason": reason,
        "details": {
            "auc": signals["auc"],
            "privacy_risk": signals["privacy_risk"],
            "drift": signals["drift"],
        }
    }


def _attach_action_plan(decision, ctx):
    level = decision["level"]

    auc = ctx.get("auc")
    privacy = ctx.get("privacy")
    rows = ctx.get("rows") or 0

    auc = 0 if auc is None else auc
    privacy = 1.0 if privacy is None else privacy

    if level == "critical":
        if auc > 0.7:
            action = "Run attack simulator and reduce memorization risk"
        elif privacy < 0.5:
            action = "Apply anonymization and remove sensitive features"
        else:
            action = "Re-evaluate generator configuration and retrain"

    elif level == "warning":
        if rows < 300:
            action = "Increase dataset size or validate statistical stability"
        else:
            action = "Review feature distributions and correlations"

    else:
        action = "No action required — system is within safe bounds"

    decision["action"] = action
    return decision


def _build_decision_layer(metrics: dict) -> dict:
    ctx = _build_reasoning_context(metrics)

    signals = _normalize_signals(ctx)
    base_score = _compute_risk_score(signals, ctx)
    final_score = _adjust_for_context(base_score, ctx)
    level = _score_to_decision(final_score)

    decision = {
        "level": level,
        "score": final_score,
        "signals": signals,
        "weights": _dynamic_weights(ctx),
        "message": _explain_score(level, final_score, signals),
        "reasoning": _reason_about_risk(ctx, signals, final_score),
    }

    decision = _attach_action_plan(decision, ctx)
    return {"decisions": [decision]}


def _compute_trust_level(metrics: dict) -> dict:
    confidence = metrics.get("metric_confidence", {})
    auc_conf = confidence.get("auc") if isinstance(confidence, dict) else None
    drift_conf = confidence.get("drift") if isinstance(confidence, dict) else None
    if auc_conf is None or drift_conf is None:
        return {
            "trust_score": 0.0,
            "trust_level": "low"
        }
    privacy_reliable = metrics.get("privacy_score_reliable", True)
    trust_score = min(
        auc_conf,
        drift_conf,
        1.0 if privacy_reliable else 0.0
    )
    if trust_score >= 0.75:
        level = "high"
    elif trust_score >= 0.5:
        level = "medium"
    else:
        level = "low"
    return {
        "trust_score": round(trust_score, 3),
        "trust_level": level
    }


def run_leakage_analysis(
    original_path: str,
    *,
    n: int = 500,
    pipeline_dir: Optional[str] = None,
    seed: Optional[int] = None,
) -> Dict[str, Any]:
    """
    Service-layer entry point.
    Executes leakage analysis in-process and returns parsed JSON output.
    """
    if not isinstance(n, int) or n <= 0:
        raise ValueError("n must be a positive integer")

    argv = ["--original", original_path, "--n", str(n)]
    if pipeline_dir:
        argv.extend(["--pipeline-dir", pipeline_dir])
    if seed is not None:
        argv.extend(["--seed", str(seed)])

    import io
    from contextlib import redirect_stdout

    buf = io.StringIO()
    with redirect_stdout(buf):
        exit_code = main(argv)

    raw = buf.getvalue().strip()
    if not raw:
        if exit_code != 0:
            raise RuntimeError("Leakage analysis failed with empty output")
        raise RuntimeError("Leakage analysis produced no output")

    lines = [line for line in raw.splitlines() if line.strip()]
    payload_raw = lines[-1]
    try:
        payload = json.loads(payload_raw)
    except Exception as exc:
        raise RuntimeError("Leakage analysis returned non-JSON output") from exc

    if exit_code != 0:
        if isinstance(payload, dict) and payload.get("error"):
            raise RuntimeError(str(payload.get("error")))
        raise RuntimeError("Leakage analysis failed")

    if not isinstance(payload, dict):
        raise RuntimeError("Leakage analysis returned invalid response shape")

    return payload


def main(argv=None):
    p = argparse.ArgumentParser(description="leakage_bridge.py — Privacy Leakage Analysis")
    p.add_argument("--original",      required=True, help="Path to the original dataset file.")
    p.add_argument("--n",             type=int, default=500, help="Number of synthetic rows.")
    p.add_argument("--pipeline-dir",  default=None, help="Optional: path to the governance pipeline root.")
    p.add_argument("--seed",          type=int, default=None, help="Random seed.")
    args = p.parse_args(argv)

    def _emit_error(msg: str) -> int:
        out = _safe_merge({"error": msg, "uncertainty_notes": [msg], "has_uncertainty": True, "_mode": "error"})
        sys.stdout.write(json.dumps(out, ensure_ascii=False) + "\n")
        return 1

    if not os.path.isfile(args.original):
        return _emit_error(f"Dataset file not found: {args.original}")

    fallback_errors: List[str] = []

    # Load original dataset
    try:
        original_df = _load_df(args.original)
    except Exception as exc:
        _log.error("leakage_bridge fatal load failure: %s", exc)
        return _emit_error(f"Failed to load dataset: {exc}")

    if original_df.empty or original_df.shape[1] == 0:
        return _emit_error("Dataset is empty or has no columns.")

    # Try full pipeline mode first
    pipeline_root = _find_pipeline(args.pipeline_dir)
    if pipeline_root is not None:
        try:
            _pl_path = os.path.join(pipeline_root, "pipeline", "leakage_pipeline.py")
            _pl_spec = _importlib_util.spec_from_file_location(
                "pipeline.leakage_pipeline", _pl_path
            )
            if _pl_spec is None or _pl_spec.loader is None:
                raise ImportError(f"Cannot locate leakage_pipeline at {_pl_path}")
            _pl_mod = _importlib_util.module_from_spec(_pl_spec)
            _pl_spec.loader.exec_module(_pl_mod)  # type: ignore[union-attr]
            run_leakage_pipeline = _pl_mod.run_leakage_pipeline
            try:
                _t_total_start = time.perf_counter()
                # synthesis_time covers only the synthetic data generation step
                _t_syn_start = time.perf_counter()
                result = run_leakage_pipeline(original_df=original_df, n_samples=args.n, seed=args.seed)
                _t_syn_end = time.perf_counter()
                synthetic_df = result.get("synthetic_df")
                column_drift = _extract_column_drift(synthetic_df, original_df) if synthetic_df is not None else {}
                output = _extract_result(result, column_drift)
                _t_total_end = time.perf_counter()
                # Metrics emitted as top-level sibling — NOT inside LeakageOutput
                metrics = _build_pipeline_metrics(
                    synthesis_time_sec = _t_syn_end - _t_syn_start,
                    total_time_sec     = _t_total_end - _t_total_start,
                    n_samples          = args.n,
                )
                envelope = {"data": output, "metrics": metrics}
                # BUG-09 fix: merge metric_confidence from pipeline result into output
                # so trust/decision functions can read it even in pipeline mode
                _pipeline_metric_conf = result.get("metric_confidence") if isinstance(result, dict) else None
                _output_for_trust = dict(output)
                if _pipeline_metric_conf and "metric_confidence" not in _output_for_trust:
                    _output_for_trust["metric_confidence"] = _pipeline_metric_conf
                # Fix 1: trust-first — compute trust BEFORE decision layer
                _trust = _compute_trust_level(_output_for_trust)
                _decision_layer = _build_decision_layer(_output_for_trust)
                envelope["interpretation"] = _interpret_results(output)
                envelope["decision"] = _decision_layer
                envelope["trust"] = _trust
                _assert_output_envelope(envelope)   # Ph-5: hard validation gate
                sys.stdout.write(json.dumps(envelope, ensure_ascii=False, default=str) + "\n")
                return 0
            except Exception as exc:
                traceback.print_exc(file=sys.stderr)
                _log.warning("fallback path activated: full pipeline failed; using local mode: %s", exc)
                fallback_errors.append("full pipeline execution failed; local mode used")
        except ImportError as exc:
            _log.warning("fallback path activated: pipeline import failed; using local mode: %s", exc)
            fallback_errors.append("pipeline import failed; local mode used")

    # Local mode — compute real metrics without external pipeline
    try:
        _t_total_start = time.perf_counter()
        # _compute_local_metrics handles synthesis internally; we time the
        # full call for total_pipeline_ms and approximate synthesis_time_ms
        # as the same value (local mode has no separate analysis overhead).
        _t_syn_start = time.perf_counter()
        output = _compute_local_metrics(original_df, args.n, args.seed)
        if fallback_errors:
            _merged_errors = list(output.get("errors") or [])
            _merged_errors.extend(fallback_errors)
            output["degraded"] = True
            output["errors"] = sorted(set(_merged_errors))
        _t_syn_end = time.perf_counter()
        _t_total_end = time.perf_counter()
        # Metrics emitted as top-level sibling — NOT inside LeakageOutput
        metrics = _build_pipeline_metrics(
            synthesis_time_sec = _t_syn_end - _t_syn_start,
            total_time_sec     = _t_total_end - _t_total_start,
            n_samples          = args.n,
        )
        envelope = {"data": output, "metrics": metrics}
        # Fix 1+B2: trust-first — compute trust BEFORE decision layer; gate interpretation too
        _trust = _compute_trust_level(output)
        _decision_layer = _build_decision_layer(output)
        envelope["interpretation"] = _interpret_results(output)
        envelope["decision"] = _decision_layer
        envelope["trust"] = _trust
        _assert_output_envelope(envelope)   # Ph-5: hard validation gate
        sys.stdout.write(json.dumps(envelope, ensure_ascii=False, default=str) + "\n")
        return 0
    except Exception as exc:
        traceback.print_exc(file=sys.stderr)
        _log.error("leakage_bridge fatal local-mode failure: %s", exc)
        return _emit_error(f"Local metrics computation failed: {exc}")


if __name__ == "__main__":
    sys.exit(main())
