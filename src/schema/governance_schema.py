"""
governance_schema.py — Single Authoritative Data Contract
==========================================================

THIS IS THE SINGLE SOURCE OF TRUTH for all data structures flowing between:
    Python pipeline → TypeScript frontend → LLM context builder

Rules:
    1. Every field used ANYWHERE in the system must be declared here.
    2. Never define fields in ad-hoc dicts or untyped TypeScript interfaces.
    3. The JSON Schema exported by this module is the specification that
       TypeScript types are derived from.
    4. All Python pipeline output must be validated against these models
       before being sent to the frontend or LLM.

Adding a field:
    Add it here → update JSON schema → regenerate TS types → done.

Removing a field:
    Remove it here → both Python validation AND TypeScript compilation fail
    at every site that used it → guaranteed no silent drift.
"""

from __future__ import annotations

import json
import math
import os
import sys as _sys
import importlib.util as _importlib_util
from dataclasses import dataclass, field, asdict, fields as dc_fields
from typing import Any, Dict, List, Optional, Union

# ── Load errors module without sys.path mutation ─────────────────────────────
# governance_schema lives in src/schema/; errors.py lives in src/utils/.
# sys.modules cache is checked first so that all modules share ONE AutoMateError
# class object — required for issubclass() checks to work across module boundaries.
_ERRORS_PATH = os.path.normpath(
    os.path.join(os.path.dirname(os.path.abspath(__file__)), "..", "utils", "errors.py")
)
# Check both canonical names — sys.path-based imports register as "errors";
# importlib-based imports register as "utils.errors".  Whichever was loaded
# first wins: both names are unified to the same module object so that
# issubclass(SchemaValidationError, AutoMateError) always resolves correctly
# regardless of import order.
if "utils.errors" in _sys.modules:
    _errors_mod = _sys.modules["utils.errors"]
    _sys.modules.setdefault("errors", _errors_mod)      # unify bare-name alias
elif "errors" in _sys.modules:
    _errors_mod = _sys.modules["errors"]
    _sys.modules["utils.errors"] = _errors_mod           # unify canonical alias
else:
    _errors_spec = _importlib_util.spec_from_file_location("utils.errors", _ERRORS_PATH)
    if _errors_spec is None or _errors_spec.loader is None:
        raise ImportError(f"Cannot locate utils/errors.py at {_ERRORS_PATH}")
    _errors_mod = _importlib_util.module_from_spec(_errors_spec)
    _sys.modules["utils.errors"] = _errors_mod           # register BEFORE exec (re-entry guard)
    _sys.modules["errors"]       = _errors_mod           # bare-name alias
    _errors_spec.loader.exec_module(_errors_mod)         # type: ignore[union-attr]
_AutoMateError = _errors_mod.AutoMateError
_ErrorCode     = _errors_mod.ErrorCode


# ─────────────────────────────────────────────────────────────────────────────
# Validation helpers
# ─────────────────────────────────────────────────────────────────────────────

class SchemaValidationError(_AutoMateError):
    """
    Raised when a data payload fails to conform to the governance contract.

    CORE exception — always propagates; never caught and suppressed in
    pipeline code.  Callers that need to surface this as a JSON error
    must catch it explicitly and call .to_dict().
    """

    def __init__(self, message: str, cause: Optional[Exception] = None) -> None:
        super().__init__(
            code    = _ErrorCode.SCHEMA_VALIDATION,
            message = message,
            cause   = cause,
        )


def _check_float_range(name: str, value: Optional[float], lo: float, hi: float) -> None:
    if value is None:
        return
    if not (lo <= value <= hi):
        raise SchemaValidationError(f"Field '{name}' value {value} is outside [{lo}, {hi}]")


def _check_literal(name: str, value: Optional[str], allowed: tuple) -> None:
    if value is None:
        return
    if value not in allowed:
        raise SchemaValidationError(f"Field '{name}' value '{value}' not in {allowed}")


# ─────────────────────────────────────────────────────────────────────────────
# Sub-models
# ─────────────────────────────────────────────────────────────────────────────

@dataclass
class PrivacyComponents:
    """Decomposed privacy risk scores (0 = safe, 1 = critical)."""
    duplicates_risk: float = 0.0
    mi_attack_risk: float = 0.0
    distance_similarity_risk: float = 0.0
    distribution_drift_risk: float = 0.0

    def validate(self) -> None:
        for f in dc_fields(self):
            _check_float_range(f.name, getattr(self, f.name), 0.0, 1.0)


@dataclass
class AttackResults:
    """Attack simulation summary."""
    membership_attack_success: Optional[float] = None   # 0-1
    reconstruction_risk: Optional[float] = None          # 0-1
    nearest_neighbor_leakage: Optional[float] = None     # 0-1

    def validate(self) -> None:
        for f in dc_fields(self):
            _check_float_range(f.name, getattr(self, f.name), 0.0, 1.0)


@dataclass
class DatasetIntelligenceRisk:
    """Composite dataset-level risk from the intelligence engine."""
    score: Optional[float] = None   # 0-100
    label: Optional[str] = None     # "low" | "medium" | "high" | "critical"
    breakdown: Dict[str, float] = field(default_factory=dict)

    def validate(self) -> None:
        _check_float_range("score", self.score, 0.0, 100.0)
        _check_literal("label", self.label, ("low", "medium", "high", "critical", None))


@dataclass
class ThreatDetail:
    """A single threat identified by the leakage / attack analysis."""
    name: str = ""
    severity: str = "medium"        # "low" | "medium" | "high" | "critical"
    confidence: float = 0.0         # 0-1
    impacted_property: str = ""
    triggered_by: List[str] = field(default_factory=list)
    description: str = ""

    def validate(self) -> None:
        _check_literal("severity", self.severity, ("low", "medium", "high", "critical"))
        _check_float_range("confidence", self.confidence, 0.0, 1.0)


@dataclass
class SensitiveColumnEntry:
    """Risk ranking entry for one column."""
    column: str = ""
    score: float = 0.0              # composite 0-1
    pii_score: float = 0.0          # 0-1
    reidentification_risk: float = 0.0  # 0-1
    drift_score: float = 0.0        # 0-1
    # FIX 4: signals is a Dict[str, float] — not List[str].
    # risk_intelligence.rank_sensitive_columns() always returns a dict of
    # {pii_score, reidentification_risk, drift_score, correlation_score} per column.
    signals: Dict[str, float] = field(default_factory=dict)

    def validate(self) -> None:
        for fname in ("score", "pii_score", "reidentification_risk", "drift_score"):
            _check_float_range(fname, getattr(self, fname), 0.0, 1.0)
        if not isinstance(self.signals, dict):
            raise SchemaValidationError("signals must be dict")
        for k, v in self.signals.items():
            if not isinstance(k, str):
                raise SchemaValidationError("signals keys must be str")
            if not isinstance(v, (int, float)):
                raise SchemaValidationError("signals values must be numeric")
        # FIX 4: validate signals is a dict with float values
        if not isinstance(self.signals, dict):
            raise SchemaValidationError(
                f"SensitiveColumnEntry.signals must be a dict, got {type(self.signals).__name__}"
            )


@dataclass
class OutlierRiskEntry:
    """A single outlier risk signal."""
    name: str = ""
    severity: str = "low"
    column: str = ""
    value: Optional[float] = None
    description: str = ""

    def validate(self) -> None:
        _check_literal("severity", self.severity, ("low", "medium", "high", "critical"))


@dataclass
class PrivacyRecommendation:
    """A single privacy recommendation from the engine."""
    column: str = ""
    action: str = ""
    reason: str = ""
    urgency: str = "medium"     # "low" | "medium" | "high" | "critical"

    def validate(self) -> None:
        _check_literal("urgency", self.urgency, ("low", "medium", "high", "critical"))


# ─────────────────────────────────────────────────────────────────────────────
# Primary schema — LeakageOutput
# This is the SINGLE CONTRACT for all leakage_bridge outputs.
# ─────────────────────────────────────────────────────────────────────────────

@dataclass
class LeakageOutput:
    """
    Authoritative schema for leakage_bridge.py output.

    All fields declared here are the ONLY fields that may flow between:
        leakage_bridge.py → extension.ts → monitorPanel.ts → LLM context builder

    Any field not declared here MUST NOT be used by any consumer.
    Any consumer that needs a new field MUST add it here first.
    """

    # ── Core privacy metrics ────────────────────────────────────────────────
    risk_level: Optional[str] = None                    # "low"|"medium"|"high"|"critical"
    privacy_score: Optional[float] = None               # 0-1 (higher = more private)
    privacy_score_reliable: bool = False
    statistical_drift: Optional[str] = None             # "low"|"moderate"|"high"|"unknown"
    duplicates_rate: Optional[float] = None             # 0-1
    membership_inference_auc: Optional[float] = None    # 0-1 (>0.5 = attacker advantage)
    avg_drift_score: Optional[float] = None             # 0-inf (JS-divergence avg)

    # ── Threat analysis ─────────────────────────────────────────────────────
    top_threats: List[Dict[str, Any]] = field(default_factory=list)
    threat_details: List[ThreatDetail] = field(default_factory=list)

    # ── Column-level data ───────────────────────────────────────────────────
    column_drift: Dict[str, float] = field(default_factory=dict)
    reidentification_risk: Dict[str, float] = field(default_factory=dict)
    sensitive_column_ranking: List[SensitiveColumnEntry] = field(default_factory=list)

    # ── Uncertainty / meta ──────────────────────────────────────────────────
    has_uncertainty: bool = True
    uncertainty_notes: List[str] = field(default_factory=list)
    error: Optional[str] = None
    _mode: str = "error"
    degraded: Optional[bool] = None
    errors: Optional[List[str]] = None

    # ── Component scores ────────────────────────────────────────────────────
    privacy_components: Optional[PrivacyComponents] = None
    attack_results: AttackResults = field(default_factory=AttackResults)

    # ── Aggregate metrics ───────────────────────────────────────────────────
    num_cols_analysed: Optional[int] = None
    cat_cols_analysed: Optional[int] = None
    n_samples: Optional[int] = None

    # ── Composite risk ──────────────────────────────────────────────────────
    dataset_risk_score: Optional[float] = None          # 0-100 (higher = riskier)
    statistical_reliability_score: Optional[float] = None  # 0-1

    # ── PII ─────────────────────────────────────────────────────────────────
    pii_columns: List[str] = field(default_factory=list)

    # ── Intelligence engine ─────────────────────────────────────────────────
    outlier_risk: List[OutlierRiskEntry] = field(default_factory=list)
    dataset_intelligence_risk: DatasetIntelligenceRisk = field(
        default_factory=DatasetIntelligenceRisk
    )
    privacy_recommendations: List[PrivacyRecommendation] = field(default_factory=list)

    def validate(self) -> None:
        """
        Raise SchemaValidationError if any field violates its constraint.

        Ph-16: Verify all declared dataclass fields exist and carry the
               expected Python type (not missing, not wrong type).
        Ph-17: Reject non-finite numeric values (NaN / ±Inf) in any
               float field — these are not valid schema values.
        """
        # ── Ph-16: field-existence and type contract ───────────────────────
        _FIELD_TYPES: Dict[str, type] = {
            "risk_level":                    (str, type(None)),
            "privacy_score":                 (float, int, type(None)),
            "privacy_score_reliable":        bool,
            "statistical_drift":             (str, type(None)),
            "duplicates_rate":               (float, int, type(None)),
            "membership_inference_auc":      (float, int, type(None)),
            "avg_drift_score":               (float, int, type(None)),
            "top_threats":                   list,
            "threat_details":                list,
            "column_drift":                  dict,
            "reidentification_risk":         dict,
            "sensitive_column_ranking":      list,
            "has_uncertainty":               bool,
            "uncertainty_notes":             list,
            "error":                         (str, type(None)),
            "_mode":                         str,
            "degraded":                      (bool, type(None)),
            "errors":                        (list, type(None)),
            "privacy_components":            object,   # PrivacyComponents | None — checked by .validate() below
            "attack_results":                object,
            "num_cols_analysed":             (int, type(None)),
            "cat_cols_analysed":             (int, type(None)),
            "n_samples":                     (int, type(None)),
            "dataset_risk_score":            (float, int, type(None)),
            "statistical_reliability_score": (float, int, type(None)),
            "pii_columns":                   list,
            "outlier_risk":                  list,
            "dataset_intelligence_risk":     object,
            "privacy_recommendations":       list,
        }
        for fname, expected_types in _FIELD_TYPES.items():
            if not hasattr(self, fname):
                raise SchemaValidationError(
                    f"Ph-16: required field '{fname}' is missing from LeakageOutput."
                )
            val = getattr(self, fname)
            if not isinstance(val, expected_types):
                raise SchemaValidationError(
                    f"Ph-16: field '{fname}' has type {type(val).__name__!r}, "
                    f"expected {expected_types}."
                )

        # ── Ph-17: reject NaN / ±Inf in float fields ──────────────────────
        _FLOAT_FIELDS = (
            "privacy_score", "duplicates_rate", "membership_inference_auc",
            "avg_drift_score", "dataset_risk_score", "statistical_reliability_score",
        )
        for fname in _FLOAT_FIELDS:
            v = getattr(self, fname)
            if v is not None and isinstance(v, (float, int)) and not math.isfinite(float(v)):
                raise SchemaValidationError(
                    f"Ph-17: field '{fname}' contains non-finite value {v!r}. "
                    "NaN and Inf are not valid schema values."
                )

        # ── Value-range constraints ────────────────────────────────────────
        _check_literal("risk_level", self.risk_level, ("low", "medium", "high", "critical", None))
        _check_float_range("privacy_score", self.privacy_score, 0.0, 1.0)
        _check_literal("statistical_drift", self.statistical_drift,
                       ("low", "moderate", "high", "unknown", None))
        _check_float_range("duplicates_rate", self.duplicates_rate, 0.0, 1.0)
        _check_float_range("membership_inference_auc", self.membership_inference_auc, 0.0, 1.0)
        _check_float_range("dataset_risk_score", self.dataset_risk_score, 0.0, 100.0)
        _check_float_range("statistical_reliability_score",
                           self.statistical_reliability_score, 0.0, 1.0)

        if self.degraded is False:
            raise SchemaValidationError(
                "degraded must be omitted (null) or true; false is not a valid emitted state."
            )
        if self.degraded is True:
            if self.errors is None or len(self.errors) == 0:
                raise SchemaValidationError(
                    "degraded=true requires non-empty errors list."
                )
        elif self.errors is not None:
            raise SchemaValidationError(
                "errors must be omitted unless degraded=true."
            )

        for td in self.threat_details:
            if isinstance(td, ThreatDetail):
                td.validate()
        for sc in self.sensitive_column_ranking:
            if isinstance(sc, SensitiveColumnEntry):
                sc.validate()
        if self.privacy_components:
            self.privacy_components.validate()
        self.attack_results.validate()
        self.dataset_intelligence_risk.validate()
        for rec in self.privacy_recommendations:
            rec.validate()

    def to_dict(self) -> Dict[str, Any]:
        """Serialize to a plain dict suitable for JSON output."""
        def _convert(obj: Any) -> Any:
            if isinstance(obj, (list, tuple)):
                return [_convert(i) for i in obj]
            if hasattr(obj, '__dataclass_fields__'):
                return {k: _convert(v) for k, v in asdict(obj).items()}
            if isinstance(obj, dict):
                return {k: _convert(v) for k, v in obj.items()}
            if isinstance(obj, float) and (math.isnan(obj) or math.isinf(obj)):
                return None
            return obj

        out = _convert(asdict(self))
        if out.get("degraded") is None:
            out.pop("degraded", None)
            out.pop("errors", None)
        return out

    def to_json(self, indent: int = 2) -> str:
        return json.dumps(self.to_dict(), ensure_ascii=False, indent=indent, default=str)

    @classmethod
    def from_dict(cls, data: Dict[str, Any]) -> "LeakageOutput":
        """
        Deserialize from a plain dict (e.g. from JSON).
        Sub-models are constructed from their nested dicts.
        Unknown keys are rejected to enforce strict integrity.
        """
        known = {f.name for f in dc_fields(cls)}
        unknown_keys = sorted(k for k in data.keys() if k not in known)
        if unknown_keys:
            raise SchemaValidationError(
                f"[HARD FAIL] leakage output contains unknown fields: {unknown_keys}"
            )
        filtered = dict(data)
        if "_mode" not in filtered:
            raise SchemaValidationError("[HARD FAIL] leakage output missing required field '_mode'.")

        # FIX 8: Explicit type coercion for critical nullable float metrics
        for field_name in ("privacy_score", "membership_inference_auc", "duplicates_rate"):
            v = filtered.get(field_name)
            filtered[field_name] = float(v) if v is not None else None

        # Reconstruct sub-models from dicts
        if isinstance(filtered.get("privacy_components"), dict):
            pc = filtered["privacy_components"]
            filtered["privacy_components"] = PrivacyComponents(
                duplicates_risk=float(pc.get("duplicates_risk", 0.0) or 0.0),
                mi_attack_risk=float(pc.get("mi_attack_risk", 0.0) or 0.0),
                distance_similarity_risk=float(pc.get("distance_similarity_risk", 0.0) or 0.0),
                distribution_drift_risk=float(pc.get("distribution_drift_risk", 0.0) or 0.0),
            )

        if isinstance(filtered.get("attack_results"), dict):
            ar = filtered["attack_results"]
            filtered["attack_results"] = AttackResults(
                membership_attack_success=ar.get("membership_attack_success"),
                reconstruction_risk=ar.get("reconstruction_risk"),
                nearest_neighbor_leakage=ar.get("nearest_neighbor_leakage"),
            )

        if isinstance(filtered.get("dataset_intelligence_risk"), dict):
            d = filtered["dataset_intelligence_risk"]
            filtered["dataset_intelligence_risk"] = DatasetIntelligenceRisk(
                score=d.get("score"),
                label=d.get("label"),
                breakdown=d.get("breakdown", {}),
            )

        if isinstance(filtered.get("threat_details"), list):
            result = []
            for idx, item in enumerate(filtered["threat_details"]):
                if isinstance(item, dict):
                    result.append(ThreatDetail(
                        name=item.get("name", ""),
                        severity=item.get("severity", "medium"),
                        confidence=float(item.get("confidence", 0.0) or 0.0),
                        impacted_property=item.get("impacted_property", ""),
                        triggered_by=item.get("triggered_by", []),
                        description=item.get("description", ""),
                    ))
                elif isinstance(item, ThreatDetail):
                    result.append(item)
                else:
                    raise SchemaValidationError(
                        f"[HARD FAIL] threat_details[{idx}] has unsupported type: {type(item).__name__}"
                    )
            filtered["threat_details"] = result

        if isinstance(filtered.get("sensitive_column_ranking"), list):
            result = []
            for idx, item in enumerate(filtered["sensitive_column_ranking"]):
                if isinstance(item, dict):
                    result.append(SensitiveColumnEntry(
                        column=item.get("column", ""),
                        score=float(item.get("score", 0.0) or 0.0),
                        pii_score=float(item.get("pii_score", 0.0) or 0.0),
                        reidentification_risk=float(item.get("reidentification_risk", 0.0) or 0.0),
                        drift_score=float(item.get("drift_score", 0.0) or 0.0),
                        signals=item.get("signals", []),
                    ))
                elif isinstance(item, SensitiveColumnEntry):
                    result.append(item)
                else:
                    raise SchemaValidationError(
                        f"[HARD FAIL] sensitive_column_ranking[{idx}] has unsupported type: {type(item).__name__}"
                    )
            filtered["sensitive_column_ranking"] = result

        if isinstance(filtered.get("outlier_risk"), list):
            result = []
            for idx, item in enumerate(filtered["outlier_risk"]):
                if isinstance(item, dict):
                    result.append(OutlierRiskEntry(
                        name=item.get("name", ""),
                        severity=item.get("severity", "low"),
                        column=item.get("column", ""),
                        value=item.get("value"),
                        description=item.get("description", ""),
                    ))
                elif isinstance(item, OutlierRiskEntry):
                    result.append(item)
                else:
                    raise SchemaValidationError(
                        f"[HARD FAIL] outlier_risk[{idx}] has unsupported type: {type(item).__name__}"
                    )
            filtered["outlier_risk"] = result

        if isinstance(filtered.get("privacy_recommendations"), dict):
            # Legacy format: {"recommendations": [...]}
            recs = filtered["privacy_recommendations"].get("recommendations", [])
            filtered["privacy_recommendations"] = [
                PrivacyRecommendation(
                    column=r.get("column", ""),
                    action=r.get("action", ""),
                    reason=r.get("reason", ""),
                    urgency=r.get("urgency", "medium"),
                )
                for r in recs if isinstance(r, dict)
            ]
        elif isinstance(filtered.get("privacy_recommendations"), list):
            # Phase 16: Direct list format — coerce dicts into dataclass instances.
            # Previously from_dict() only handled the legacy dict-wrapper format,
            # which caused AttributeError when validate() called rec.validate() on
            # a plain dict.  Both formats are now normalised to List[PrivacyRecommendation].
            result_recs = []
            for idx, r in enumerate(filtered["privacy_recommendations"]):
                if isinstance(r, dict):
                    result_recs.append(PrivacyRecommendation(
                        column=r.get("column", ""),
                        action=r.get("action", ""),
                        reason=r.get("reason", ""),
                        urgency=r.get("urgency", "medium"),
                    ))
                elif isinstance(r, PrivacyRecommendation):
                    result_recs.append(r)
                else:
                    raise SchemaValidationError(
                        f"[HARD FAIL] privacy_recommendations[{idx}] has unsupported type: {type(r).__name__}"
                    )
            filtered["privacy_recommendations"] = result_recs

        return cls(**filtered)


# ─────────────────────────────────────────────────────────────────────────────
# JSON Schema export (auto-generated from the dataclass definitions)
# Used to generate TypeScript types via schema codegen.
# ─────────────────────────────────────────────────────────────────────────────

def _float_or_null() -> Dict[str, Any]:
    return {"type": ["number", "null"]}

def _str_or_null(enum: Optional[list] = None) -> Dict[str, Any]:
    base: Dict[str, Any] = {"type": ["string", "null"]}
    if enum:
        base["enum"] = enum + [None]
    return base

def _int_or_null() -> Dict[str, Any]:
    return {"type": ["integer", "null"]}


JSON_SCHEMA: Dict[str, Any] = {
    "$schema": "http://json-schema.org/draft-07/schema#",
    "$id": "urn:automate:governance:leakage-output:v1",
    "title": "LeakageOutput",
    "description": "Authoritative schema for all data flowing from leakage_bridge.py to the frontend and LLM context builder.",
    "type": "object",
    "additionalProperties": False,
    "required": ["risk_level", "privacy_score", "privacy_score_reliable", "statistical_drift",
                 "duplicates_rate", "membership_inference_auc", "avg_drift_score",
                 "top_threats", "threat_details", "column_drift", "reidentification_risk",
                 "sensitive_column_ranking", "has_uncertainty", "uncertainty_notes",
                 "error", "_mode", "privacy_components", "attack_results",
                 "num_cols_analysed", "cat_cols_analysed", "n_samples",
                 "dataset_risk_score", "statistical_reliability_score",
                 "pii_columns", "outlier_risk", "dataset_intelligence_risk",
                 "privacy_recommendations"],
    "properties": {
        "risk_level":                    _str_or_null(["low", "medium", "high", "critical"]),
        "privacy_score":                 _float_or_null(),
        "privacy_score_reliable":        {"type": "boolean"},
        "statistical_drift":             _str_or_null(["low", "moderate", "high", "unknown"]),
        "duplicates_rate":               _float_or_null(),
        "membership_inference_auc":      _float_or_null(),
        "avg_drift_score":               _float_or_null(),
        "top_threats":                   {"type": "array", "items": {"type": "object"}},
        "threat_details": {
            "type": "array",
            "items": {
                "type": "object",
                "required": ["name", "severity", "confidence", "triggered_by", "description"],
                "properties": {
                    "name":              {"type": "string"},
                    "severity":          {"type": "string", "enum": ["low","medium","high","critical"]},
                    "confidence":        {"type": "number", "minimum": 0, "maximum": 1},
                    "impacted_property": {"type": "string"},
                    "triggered_by":      {"type": "array", "items": {"type": "string"}},
                    "description":       {"type": "string"},
                },
            },
        },
        "column_drift":              {"type": "object", "additionalProperties": {"type": "number"}},
        "reidentification_risk":     {"type": "object", "additionalProperties": {"type": "number"}},
        "sensitive_column_ranking": {
            "type": "array",
            "items": {
                "type": "object",
                "required": ["column", "score", "pii_score", "reidentification_risk", "drift_score"],
                "properties": {
                    "column":                {"type": "string"},
                    "score":                 {"type": "number", "minimum": 0, "maximum": 1},
                    "pii_score":             {"type": "number", "minimum": 0, "maximum": 1},
                    "reidentification_risk": {"type": "number", "minimum": 0, "maximum": 1},
                    "drift_score":           {"type": "number", "minimum": 0, "maximum": 1},
                    "signals":               {"type": "array", "items": {"type": "string"}},
                },
            },
        },
        "has_uncertainty":           {"type": "boolean"},
        "uncertainty_notes":         {"type": "array", "items": {"type": "string"}},
        "error":                     {"type": ["string", "null"]},
        "_mode":                     {"type": "string"},
        "degraded":                  {"type": ["boolean", "null"]},
        "errors":                    {"type": ["array", "null"], "items": {"type": "string"}},
        "privacy_components": {
            "type": ["object", "null"],
            "required": ["duplicates_risk","mi_attack_risk","distance_similarity_risk","distribution_drift_risk"],
            "properties": {
                "duplicates_risk":           {"type": "number", "minimum": 0, "maximum": 1},
                "mi_attack_risk":            {"type": "number", "minimum": 0, "maximum": 1},
                "distance_similarity_risk":  {"type": "number", "minimum": 0, "maximum": 1},
                "distribution_drift_risk":   {"type": "number", "minimum": 0, "maximum": 1},
            },
        },
        "attack_results": {
            "type": "object",
            "properties": {
                "membership_attack_success": _float_or_null(),
                "reconstruction_risk":       _float_or_null(),
                "nearest_neighbor_leakage":  _float_or_null(),
            },
        },
        "num_cols_analysed":         _int_or_null(),
        "cat_cols_analysed":         _int_or_null(),
        "n_samples":                 _int_or_null(),
        "dataset_risk_score":        _float_or_null(),
        "statistical_reliability_score": _float_or_null(),
        "pii_columns":               {"type": "array", "items": {"type": "string"}},
        "outlier_risk": {
            "type": "array",
            "items": {
                "type": "object",
                "properties": {
                    "name":        {"type": "string"},
                    "severity":    {"type": "string", "enum": ["low","medium","high","critical"]},
                    "column":      {"type": "string"},
                    "value":       _float_or_null(),
                    "description": {"type": "string"},
                },
            },
        },
        "dataset_intelligence_risk": {
            "type": "object",
            "properties": {
                "score":     _float_or_null(),
                "label":     _str_or_null(["low","medium","high","critical"]),
                "breakdown": {"type": "object", "additionalProperties": {"type": "number"}},
            },
        },
        "privacy_recommendations": {
            "type": "array",
            "items": {
                "type": "object",
                "properties": {
                    "column":  {"type": "string"},
                    "action":  {"type": "string"},
                    "reason":  {"type": "string"},
                    "urgency": {"type": "string", "enum": ["low","medium","high","critical"]},
                },
            },
        },
    },
}


def export_json_schema(path: str) -> None:
    """Write the canonical JSON Schema to disk."""
    with open(path, "w", encoding="utf-8") as f:
        json.dump(JSON_SCHEMA, f, indent=2, ensure_ascii=False)
    sys.stdout.write(f"[schema] JSON Schema written → {path}" + "\n")
def validate_dict(data: Dict[str, Any]) -> LeakageOutput:
    """
    Parse and validate a raw dict (from JSON) into a LeakageOutput.
    Raises SchemaValidationError on constraint violations.
    """
    obj = LeakageOutput.from_dict(data)
    obj.validate()
    return obj


if __name__ == "__main__":
    import sys, os
    out = os.path.join(os.path.dirname(__file__), "leakage_output.schema.json")
    export_json_schema(out)
    sys.stdout.write(f"Schema has {len(JSON_SCHEMA['properties'])} top-level fields.\n")
    sys.exit(0)
