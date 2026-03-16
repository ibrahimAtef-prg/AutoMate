"""
baseline.py — Dataset Behavioral Baseline Builder

Purpose
-------
Build a *behavioral* baseline contract from a dataset described by the parser AST.

Design rules
------------
- parse.py = structural extraction (schema/preview/light sample stats)
- baseline.py = behavioral model (full stats, distributions, correlations, constraints, rule_set)

Input
-----
- A DatasetAST produced by parse.py (or a dict with the same structure).

Output
------
- BaselineArtifact (dataclass) + .to_dict() for JSON serialization

Notes
-----
- Uses pandas if available for reliable profiling/correlations.
- For huge datasets, it can run in "bounded" mode via `max_rows` (deterministic head() load).
"""

from __future__ import annotations

from dataclasses import dataclass, field, asdict
from typing import Any, Dict, List, Optional, Tuple, Union
import hashlib
import json
import math
import os
import re
from datetime import datetime, UTC

try:
    import pandas as pd  # type: ignore
except Exception:
    pd = None  # type: ignore


# ---------------------------
# Baseline Types
# ---------------------------

@dataclass
class BaselineMeta:
    version: str = "baseline.v1"
    created_at_utc: str = field(default_factory=lambda:datetime.now(UTC).isoformat().replace("+00:00", "Z"))
    dataset_kind: str = ""
    dataset_source: str = ""
    dataset_fingerprint: str = ""
    schema_hash: str = ""
    row_count: Optional[int] = None
    column_count: Optional[int] = None
    warnings: List[str] = field(default_factory=list)

@dataclass
class NumericColumnBaseline:
    type: str = "numeric"
    null_ratio: float = 0.0
    min: Optional[float] = None
    max: Optional[float] = None
    mean: Optional[float] = None
    std: Optional[float] = None
    q01: Optional[float] = None
    q05: Optional[float] = None
    q25: Optional[float] = None
    q50: Optional[float] = None
    q75: Optional[float] = None
    q95: Optional[float] = None
    q99: Optional[float] = None
    iqr: Optional[float] = None
    outlier_bounds_iqr: Optional[Tuple[float, float]] = None  # (low, high)
    unique_count: Optional[int] = None

@dataclass
class CategoricalColumnBaseline:
    type: str = "categorical"
    null_ratio: float = 0.0
    unique_count: Optional[int] = None
    top_values: Dict[str, int] = field(default_factory=dict)
    top_value_ratios: Dict[str, float] = field(default_factory=dict)

@dataclass
class BaselineColumns:
    numeric: Dict[str, NumericColumnBaseline] = field(default_factory=dict)
    categorical: Dict[str, CategoricalColumnBaseline] = field(default_factory=dict)
    other: Dict[str, Dict[str, Any]] = field(default_factory=dict)  # datetime/object/etc (kept minimal)

@dataclass
class Correlations:
    # Pairwise numeric correlations: "a__b" -> corr value
    numeric_pearson: Dict[str, float] = field(default_factory=dict)
    # Strength label for every stored pair: "a__b" -> "weak/medium/strong/very_strong"
    strength: Dict[str, str] = field(default_factory=dict)
    # Cramér's V: categorical-to-categorical association: "a__b" -> V (0..1)
    categorical_cramers_v: Dict[str, float] = field(default_factory=dict)
    # Point-biserial: categorical-to-numeric association: "cat__num" -> r (-1..1)
    categorical_numeric_pb: Dict[str, float] = field(default_factory=dict)

@dataclass
class Constraints:
    # Column constraints (hard-ish)
    numeric_ranges: Dict[str, Tuple[Optional[float], Optional[float]]] = field(default_factory=dict)  # min,max
    allowed_values: Dict[str, List[str]] = field(default_factory=dict)  # for low-card categoricals
    max_null_ratio: float = 0.0

@dataclass
class RuleSet:
    rules: List[str] = field(default_factory=list)

@dataclass
class BaselineArtifact:
    meta: BaselineMeta
    columns: BaselineColumns
    correlations: Correlations
    constraints: Constraints
    rule_set: RuleSet

    def to_dict(self) -> Dict[str, Any]:
        return asdict(self)

    def to_json(self, indent: int = 2) -> str:
        return json.dumps(self.to_dict(), ensure_ascii=False, indent=indent)


# ---------------------------
# Public API
# ---------------------------

def build_baseline(
    dataset_ast: Union[Dict[str, Any], Any],
    *,
    max_rows: Optional[int] = None,
    top_k: int = 10,
    correlation_min_abs: float = 0.0,
    low_cardinality_threshold: int = 50,
    max_allowed_values_store: int = 200,
    max_null_ratio: float = 0.0,
) -> BaselineArtifact:
    """
    Build a behavioral baseline from a DatasetAST.

    Parameters
    ----------
    dataset_ast:
        The DatasetAST from parse.py (dataclass or dict with keys: kind, source, fingerprint, schema).
    max_rows:
        If set, baseline will load deterministically the first N rows only.
        (Useful for huge files. For full baseline, leave None.)
    top_k:
        Number of most frequent categorical values to store.
    correlation_min_abs:
        Store correlations only if abs(corr) >= this threshold.
    low_cardinality_threshold:
        If categorical unique_count <= threshold, we may store allowed_values for constraints.
    max_allowed_values_store:
        Upper bound on how many allowed values to store for a column.
    max_null_ratio:
        Global constraint: reject if any column null_ratio exceeds this (baseline records it).
    """
    if pd is None:
        raise RuntimeError("pandas is required for baseline profiling. Install: pip install pandas")

    kind, source, fp, schema_fields = _extract_dataset_ast(dataset_ast)
    meta = BaselineMeta(
        dataset_kind=kind,
        dataset_source=source,
        dataset_fingerprint=fp,
    )
    meta.schema_hash = _schema_hash(schema_fields)
    meta.warnings = []

    df, warnings = _load_dataframe(kind, source, max_rows=max_rows)
    meta.warnings.extend(warnings)

    meta.row_count = int(df.shape[0])
    meta.column_count = int(df.shape[1])

    # Build baselines
    columns = BaselineColumns()
    constraints = Constraints(max_null_ratio=float(max_null_ratio))
    correlations = Correlations()
    rule_set = RuleSet()

    # Ensure we only baseline columns that exist in df (parser schema may include extras in some cases)
    df_cols = list(df.columns)

    # Null ratios
    null_ratios = df.isna().mean(numeric_only=False).to_dict()

    # Identify numeric/categorical using pandas dtypes (baseline stage is authoritative)
    numeric_cols = [c for c in df_cols if _is_numeric_dtype(df[c])]
    categorical_cols = [c for c in df_cols if c not in numeric_cols]

    # Numeric columns baseline
    for col in numeric_cols:
        s = pd.to_numeric(df[col], errors="coerce")
        nr = float(s.isna().mean())
        non_null = s.dropna()
        nb = NumericColumnBaseline(
            null_ratio=nr,
            unique_count=int(non_null.nunique(dropna=True)) if len(non_null) else 0,
        )
        if len(non_null):
            desc = non_null.describe(percentiles=[0.01, 0.05, 0.25, 0.50, 0.75, 0.95, 0.99])

            def _fget(key, fallback=None):
                try:
                    v = desc[key]
                    if v is None or (isinstance(v, float) and math.isnan(v)):
                        return fallback
                    return float(v)
                except Exception:
                    return fallback

            nb.min  = _fget("min")
            nb.max  = _fget("max")
            nb.mean = _fget("mean")
            nb.std  = _fget("std", 0.0)
            nb.q01  = _fget("1%")
            nb.q05  = _fget("5%")
            nb.q25  = _fget("25%")
            nb.q50  = _fget("50%")
            nb.q75  = _fget("75%")
            nb.q95  = _fget("95%")
            nb.q99  = _fget("99%")

            if nb.q25 is not None and nb.q75 is not None:
                nb.iqr = float(nb.q75 - nb.q25)
                low = float(nb.q25 - 1.5 * nb.iqr)
                high = float(nb.q75 + 1.5 * nb.iqr)
                nb.outlier_bounds_iqr = (low, high)

            # Constraints: range
            constraints.numeric_ranges[col] = (nb.min, nb.max)

        columns.numeric[col] = nb

    # Categorical columns baseline
    for col in categorical_cols:
        s = df[col]
        nr = float(s.isna().mean())
        # Convert to string for stable counting (keeps NaN separate)
        s_non_null = s.dropna().astype(str)
        vc = s_non_null.value_counts(dropna=True)
        unique_count = int(vc.shape[0])

        top_values: Dict[str, int] = {}
        top_ratios: Dict[str, float] = {}

        if unique_count > 0:
            top = vc.head(top_k)
            top_values = {str(k): int(v) for k, v in top.items()}
            denom = int(s_non_null.shape[0]) if int(s_non_null.shape[0]) else 1
            top_ratios = {k: (v / denom) for k, v in top_values.items()}

        cb = CategoricalColumnBaseline(
            null_ratio=nr,
            unique_count=unique_count,
            top_values=top_values,
            top_value_ratios=top_ratios,
        )
        columns.categorical[col] = cb

        # Constraints: allowed values for low-card columns
        if unique_count <= low_cardinality_threshold and unique_count <= max_allowed_values_store:
            constraints.allowed_values[col] = [str(x) for x in vc.index.tolist()]

    # Other dtypes minimal tracking (datetime/object mixed etc.)
    for col in df_cols:
        if col in columns.numeric or col in columns.categorical:
            continue
        columns.other[col] = {
            "dtype": str(df[col].dtype),
            "null_ratio": float(null_ratios.get(col, 0.0)),
        }

    # Correlations (numeric only) — Pearson
    if len(numeric_cols) >= 2:
        num_df = df[numeric_cols].apply(pd.to_numeric, errors="coerce")
        corr = num_df.corr(method="pearson")
        for i, a in enumerate(numeric_cols):
            for b in numeric_cols[i + 1 :]:
                v = corr.loc[a, b]
                if pd.isna(v):
                    continue
                v = float(v)
                if abs(v) < float(correlation_min_abs):
                    continue
                key = f"{a}__{b}"
                correlations.numeric_pearson[key] = v
                correlations.strength[key] = _corr_strength(v)

    # Categorical-to-categorical — Cramér's V
    # Only run on low-cardinality columns to keep it tractable and meaningful.
    # High-cardinality free-text columns produce noise, not signal.
    cat_cols_for_assoc = [
        c for c in categorical_cols
        if columns.categorical[c].unique_count is not None
        and 1 < columns.categorical[c].unique_count <= low_cardinality_threshold
    ]
    for i, a in enumerate(cat_cols_for_assoc):
        for b in cat_cols_for_assoc[i + 1 :]:
            v = _cramers_v(df[a], df[b])
            if v is None:
                continue
            if abs(v) < float(correlation_min_abs):
                continue
            correlations.categorical_cramers_v[f"{a}__{b}"] = round(v, 6)

    # Categorical-to-numeric — point-biserial (generalised: one numeric, one categorical)
    # Works for binary AND multi-class categoricals (we iterate per-class vs rest).
    # For the generator we only need the strongest signal per pair, so we store max abs r.
    for cat_col in cat_cols_for_assoc:
        for num_col in numeric_cols:
            v = _point_biserial_corr(df[cat_col], df[num_col])
            if v is None:
                continue
            if abs(v) < float(correlation_min_abs):
                continue
            correlations.categorical_numeric_pb[f"{cat_col}__{num_col}"] = round(v, 6)

    # Build rules (human-readable, deterministic)
    rule_set.rules.append("All numeric fields must contain numeric values only (coercible).")
    if constraints.numeric_ranges:
        for c, (mn, mx) in constraints.numeric_ranges.items():
            if mn is not None and mx is not None:
                rule_set.rules.append(f"{c} must be between {mn} and {mx}.")
            elif mn is not None:
                rule_set.rules.append(f"{c} must be >= {mn}.")
            elif mx is not None:
                rule_set.rules.append(f"{c} must be <= {mx}.")

    # Null ratio global constraint
    if max_null_ratio is not None:
        rule_set.rules.append(f"No column exceeds the maximum null ratio ({float(max_null_ratio)}).")

    # If we store allowed values, describe them as constraints
    for c in constraints.allowed_values.keys():
        rule_set.rules.append(f"{c} must be one of the observed allowed categorical values.")

    # Extra: rule ideas for your specific dataset types (optional)
    # NOTE: Keep baseline generic; do not hardcode domain rules unless you add a separate "domain_rules" layer.

    # Attach meta warnings about bounded mode
    if max_rows is not None:
        meta.warnings.append(f"Baseline built in bounded mode using first {max_rows} rows (deterministic head).")

    return BaselineArtifact(
        meta=meta,
        columns=columns,
        correlations=correlations,
        constraints=constraints,
        rule_set=rule_set,
    )


# ---------------------------
# Loading helpers
# ---------------------------

def _load_dataframe(kind: str, source: str, *, max_rows: Optional[int]) -> Tuple[any, List[str]]:
    warnings: List[str] = []
    if kind == "csv":
        df = pd.read_csv(source)
        if max_rows is not None:
            df = df.head(max_rows)
        return df, warnings

    if kind == "excel":
        df = pd.read_excel(source)
        if max_rows is not None:
            df = df.head(max_rows)
        return df, warnings

    if kind == "json":
        # Try records JSON; if it fails, fall back to json_normalize
        try:
            df = pd.read_json(source)
        except Exception:
            # Newlines / nested JSON
            try:
                df = pd.read_json(source, lines=True)
            except Exception:
                obj = json.loads(_read_text(source))
                df = pd.json_normalize(obj)
        if max_rows is not None:
            df = df.head(max_rows)
        return df, warnings

    if kind == "parquet":
        df = pd.read_parquet(source)
        if max_rows is not None:
            df = df.head(max_rows)
        return df, warnings

    if kind == "sql":
        raise ValueError("baseline.py expects a tabular dataset source, not raw SQL. Execute SQL to materialize data first.")

    raise ValueError(f"Unsupported kind for baseline loading: {kind}")


def _read_text(path: str, encoding: str = "utf-8") -> str:
    with open(path, "r", encoding=encoding, errors="replace") as f:
        return f.read()


# ---------------------------
# AST extraction + hashing
# ---------------------------

def _extract_dataset_ast(dataset_ast: Union[Dict[str, Any], Any]) -> Tuple[str, str, str, List[Dict[str, Any]]]:
    """
    Returns: (kind, source, fingerprint, schema_fields)
    schema_fields is list of dicts: {"name": ..., "dtype": ..., "nullable": ...}
    """
    if isinstance(dataset_ast, dict):
        kind = dataset_ast.get("kind") or ""
        source = dataset_ast.get("source") or ""
        fp = dataset_ast.get("fingerprint") or ""
        schema = dataset_ast.get("schema") or {}
        fields = schema.get("fields") or []
        # Normalize field dict
        norm_fields = []
        for f in fields:
            if isinstance(f, dict) and "name" in f:
                norm_fields.append({"name": f["name"], "dtype": f.get("dtype", "unknown"), "nullable": bool(f.get("nullable", True))})
        return kind, source, fp, norm_fields

    # dataclass-like object from parse.py
    kind = getattr(dataset_ast, "kind", "")
    source = getattr(dataset_ast, "source", "")
    fp = getattr(dataset_ast, "fingerprint", "")
    schema = getattr(dataset_ast, "schema", None)
    fields_obj = getattr(schema, "fields", []) if schema is not None else []
    norm_fields = []
    for f in fields_obj:
        norm_fields.append({"name": getattr(f, "name", ""), "dtype": getattr(f, "dtype", "unknown"), "nullable": bool(getattr(f, "nullable", True))})
    return kind, source, fp, norm_fields


def _schema_hash(schema_fields: List[Dict[str, Any]]) -> str:
    # Hash stable schema signature: names + dtypes + nullable (sorted by name)
    sig = [{"name": f["name"], "dtype": f.get("dtype", "unknown"), "nullable": bool(f.get("nullable", True))}
           for f in schema_fields if f.get("name")]
    sig = sorted(sig, key=lambda x: x["name"])
    b = json.dumps(sig, ensure_ascii=False, separators=(",", ":"), sort_keys=True).encode("utf-8")
    return hashlib.sha256(b).hexdigest()


# ---------------------------
# Dtype helpers
# ---------------------------

def _is_numeric_dtype(s: any) -> bool:
    # pandas numeric detection but robust for object columns with numeric strings
    dt = s.dtype
    if str(dt).startswith(("int", "float")):
        return True
    # Try numeric coercion on a small sample
    sample = s.dropna().head(200)
    if sample.empty:
        return False
    coerced = pd.to_numeric(sample, errors="coerce")
    # If most values coerce, treat numeric
    ratio = float(coerced.notna().mean())
    return ratio >= 0.95


def _corr_strength(v: float) -> str:
    a = abs(v)
    if a >= 0.9:
        return "very_strong"
    if a >= 0.7:
        return "strong"
    if a >= 0.4:
        return "medium"
    if a >= 0.2:
        return "weak"
    return "very_weak"


def _cramers_v(s_a: any, s_b: any) -> Optional[float]:
    """
    Cramér's V — symmetric association measure for two categorical columns.
    Returns a value in [0, 1]: 0 = no association, 1 = perfect association.
    Uses the bias-corrected formula (Bergsma & Wicher, 2013) to avoid
    inflated values on small samples.

    Returns None if the contingency table is degenerate (one unique value in
    either column, or fewer than 2 non-null rows).
    """
    # Drop rows where either column is null
    mask = s_a.notna() & s_b.notna()
    a = s_a[mask].astype(str)
    b = s_b[mask].astype(str)

    n = len(a)
    if n < 2:
        return None

    k = int(a.nunique())
    r = int(b.nunique())
    if k < 2 or r < 2:
        return None  # one column is constant — no association possible

    # Build contingency table via pandas crosstab (avoids scipy dependency)
    ct = pd.crosstab(a, b)
    chi2 = _chi2_from_crosstab(ct)
    if chi2 is None:
        return None

    # Bias-corrected Cramér's V
    phi2 = chi2 / n
    k_corr = k - (k - 1) ** 2 / (n - 1)
    r_corr = r - (r - 1) ** 2 / (n - 1)
    denom = min(k_corr - 1, r_corr - 1)
    if denom <= 0:
        return None

    v = math.sqrt(max(0.0, phi2 / denom))
    return float(v)


def _chi2_from_crosstab(ct: any) -> Optional[float]:
    """
    Compute chi-squared statistic from a pandas crosstab (contingency table).
    Pure pandas/numpy — no scipy required.
    """
    observed = ct.values.astype(float)
    row_sums = observed.sum(axis=1, keepdims=True)
    col_sums = observed.sum(axis=0, keepdims=True)
    total = observed.sum()
    if total == 0:
        return None
    expected = (row_sums @ col_sums) / total
    # Cells with expected == 0 contribute 0 (standard convention)
    with_denom = expected > 0
    chi2 = float((((observed - expected) ** 2) / expected)[with_denom].sum())
    return chi2


def _point_biserial_corr(s_cat: any, s_num: any) -> Optional[float]:
    """
    Generalised point-biserial correlation between one categorical column and
    one numeric column.

    For a true binary categorical (2 classes), this is the exact point-biserial r.
    For multi-class categoricals, we compute the correlation ratio (eta), which
    generalises point-biserial to k > 2 groups. Both land in [-1, 1] for binary
    and [0, 1] for multi-class (eta is unsigned). We return the signed value for
    binary and the unsigned eta for multi-class so the generator can use the
    magnitude uniformly.

    Returns None if the numeric column has zero variance or fewer than 2 non-null rows.
    """
    mask = s_cat.notna() & s_num.notna()
    cats = s_cat[mask].astype(str)
    nums = pd.to_numeric(s_num[mask], errors="coerce")
    valid = nums.notna()
    cats = cats[valid]
    nums = nums[valid]

    n = len(nums)
    if n < 2:
        return None

    total_var = float(nums.var())
    if total_var == 0.0:
        return None

    classes = cats.unique()
    k = len(classes)

    if k < 2:
        return None

    if k == 2:
        # Exact point-biserial: signed correlation
        g0 = nums[cats == classes[0]]
        g1 = nums[cats == classes[1]]
        if len(g0) == 0 or len(g1) == 0:
            return None
        m0, m1 = float(g0.mean()), float(g1.mean())
        n0, n1 = len(g0), len(g1)
        std_total = math.sqrt(total_var * n / (n - 1)) if n > 1 else None
        if not std_total:
            return None
        r = ((m1 - m0) / std_total) * math.sqrt((n0 * n1) / (n * n))
        return float(r)

    # Multi-class: correlation ratio eta (unsigned, [0,1])
    grand_mean = float(nums.mean())
    ss_between = sum(
        len(nums[cats == c]) * (float(nums[cats == c].mean()) - grand_mean) ** 2
        for c in classes
        if len(nums[cats == c]) > 0
    )
    ss_total = float(((nums - grand_mean) ** 2).sum())
    if ss_total == 0:
        return None
    eta = math.sqrt(ss_between / ss_total)
    return float(eta)


# ---------------------------
# Optional CLI for quick tests
# ---------------------------

def build_baseline_from_parsed_ast_json(
    parsed_ast_json: str,
    *,
    max_rows: Optional[int] = None,
    **kwargs: Any,
) -> BaselineArtifact:
    """
    Convenience for IDE integration: feed the JSON output of parse_to_json(), build baseline.
    Expects parsed ast shape: {"dataset": {...}, "sql": null}
    """
    obj = json.loads(parsed_ast_json)
    ds = obj.get("dataset")
    if not ds:
        raise ValueError("Parsed AST JSON does not contain 'dataset'.")
    return build_baseline(ds, max_rows=max_rows, **kwargs)


def _main(argv: Optional[List[str]] = None) -> int:
    import argparse

    p = argparse.ArgumentParser(description="baseline.py — build dataset behavioral baseline from a dataset file.")
    p.add_argument("path", help="Dataset file path (csv/xlsx/json/parquet).")
    p.add_argument("--kind", choices=["csv", "excel", "json", "parquet"], default=None)
    p.add_argument("--max-rows", type=int, default=None, help="Deterministically baseline only first N rows.")
    p.add_argument("--top-k", type=int, default=10)
    p.add_argument("--corr-min-abs", type=float, default=0.0)
    p.add_argument("--max-null-ratio", type=float, default=0.0)
    args = p.parse_args(argv)

    kind = args.kind or _infer_kind_from_path(args.path)
    fake_dataset_ast = {
        "kind": kind,
        "source": args.path,
        "fingerprint": "",  # optional
        "schema": {"fields": []},  # optional
    }

    baseline = build_baseline(
        fake_dataset_ast,
        max_rows=args.max_rows,
        top_k=args.top_k,
        correlation_min_abs=args.corr_min_abs,
        max_null_ratio=args.max_null_ratio,
    )
    print(baseline.to_json(indent=2))
    return 0


def _infer_kind_from_path(path: str) -> str:
    ext = os.path.splitext(path)[1].lower()
    if ext in [".csv", ".tsv"]:
        return "csv"
    if ext in [".xlsx", ".xlsm", ".xltx", ".xltm"]:
        return "excel"
    if ext in [".json", ".jsonl"]:
        return "json"
    if ext == ".parquet":
        return "parquet"
    raise ValueError(f"Cannot infer kind from extension: {ext}")


if __name__ == "__main__":
    raise SystemExit(_main())