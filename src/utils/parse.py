
"""
IDE — Unified AST Parser Utilities
Parsers supported:
- CSV
- Excel (.xlsx)
- JSON (records / nested)
- SQL (best-effort: uses `sqlparse` if installed, otherwise minimal fallback)
- Parquet

Goal:
Convert a data source (file path or SQL text) into a normalized "AST" that your extension can
use for schema display, profiling, validation, and pipeline generation.

Design notes:
- The AST is intentionally *tabular-oriented* (dataset/schema/preview), plus optional SQL statement AST.
- For huge files, we avoid loading everything by default: we sample rows and infer schema.

Dependencies:
- csv/json/sqlite3 are stdlib
- openpyxl for .xlsx
- pandas + pyarrow (or fastparquet) recommended for parquet/csv fast reading
- sqlparse optional for nicer SQL parsing
"""

from __future__ import annotations

from dataclasses import dataclass, field, asdict
from typing import Any, Dict, List, Optional, Tuple, Union, Iterable
import os
import re
import json
import csv
import math
import hashlib
from datetime import datetime

# Optional deps
try:
    import pandas as pd  # type: ignore
except Exception:
    pd = None  # type: ignore

try:
    import openpyxl  # type: ignore
except Exception:
    openpyxl = None  # type: ignore

try:
    import sqlparse  # type: ignore
except Exception:
    sqlparse = None  # type: ignore


# ---------------------------
# AST Types
# ---------------------------

@dataclass
class FieldAST:
    name: str
    dtype: str = "unknown"
    nullable: bool = True
    sample_values: List[Any] = field(default_factory=list)

@dataclass
class SchemaAST:
    fields: List[FieldAST] = field(default_factory=list)
    primary_keys: List[str] = field(default_factory=list)
    indexes: List[str] = field(default_factory=list)

@dataclass
class ProfileAST:
    row_count_estimate: Optional[int] = None
    column_count: Optional[int] = None
    missingness: Dict[str, float] = field(default_factory=dict)
    numeric_summary: Dict[str, Dict[str, float]] = field(default_factory=dict)  # min/max/mean/std
    cardinality_estimate: Dict[str, int] = field(default_factory=dict)

@dataclass
class DatasetAST:
    kind: str  # csv/excel/json/parquet/sql
    source: str  # filepath or inline text descriptor
    fingerprint: str
    schema: SchemaAST
    preview_rows: List[Dict[str, Any]] = field(default_factory=list)
    profile: ProfileAST = field(default_factory=ProfileAST)
    meta: Dict[str, Any] = field(default_factory=dict)
    warnings: List[str] = field(default_factory=list)

@dataclass
class SQLStatementAST:
    statement_type: str  # SELECT/INSERT/UPDATE/DELETE/CREATE/ALTER/etc
    raw: str
    tables: List[str] = field(default_factory=list)
    columns: List[str] = field(default_factory=list)
    where: Optional[str] = None
    joins: List[str] = field(default_factory=list)
    group_by: List[str] = field(default_factory=list)
    order_by: List[str] = field(default_factory=list)
    limit: Optional[int] = None
    warnings: List[str] = field(default_factory=list)

@dataclass
class ParsedAST:
    dataset: Optional[DatasetAST] = None
    sql: Optional[SQLStatementAST] = None

    def to_dict(self) -> Dict[str, Any]:
        return asdict(self)


# ---------------------------
# Public API
# ---------------------------

def parse(
    source: str,
    kind: Optional[str] = None,
    *,
    sample_rows: int = 50,
    excel_sheet: Optional[Union[str, int]] = None,
    encoding: str = "utf-8",
    dialect: str = "excel",
    json_records_path: Optional[List[Union[str, int]]] = None,
    sql_dialect_hint: Optional[str] = None,
) -> ParsedAST:
    """
    Parse a file path or SQL text into a normalized AST.

    Parameters
    ----------
    source:
        - File path for csv/xlsx/json/parquet
        - SQL text if kind == "sql" and file doesn't exist
    kind:
        One of: csv, excel, json, parquet, sql
        If None, inferred from file extension (or sql if not a file).
    sample_rows:
        Number of rows to preview + infer schema from (best-effort).
    excel_sheet:
        Sheet name or index for Excel parsing.
    json_records_path:
        For nested JSON, provide a path list to reach the records array.
        Example: ["data", "items"].
    """
    inferred_kind = kind or _infer_kind(source)
    if inferred_kind == "csv":
        return ParsedAST(dataset=_parse_csv(source, sample_rows=sample_rows, encoding=encoding, dialect=dialect))
    if inferred_kind == "excel":
        return ParsedAST(dataset=_parse_excel(source, sample_rows=sample_rows, sheet=excel_sheet))
    if inferred_kind == "json":
        return ParsedAST(dataset=_parse_json(source, sample_rows=sample_rows, encoding=encoding, records_path=json_records_path))
    if inferred_kind == "parquet":
        return ParsedAST(dataset=_parse_parquet(source, sample_rows=sample_rows))
    if inferred_kind == "sql":
        return ParsedAST(sql=_parse_sql(source, dialect_hint=sql_dialect_hint))
    raise ValueError(f"Unsupported kind: {inferred_kind}")


def parse_to_json(
    source: str,
    kind: Optional[str] = None,
    **kwargs: Any
) -> str:
    """Convenience: parse() then JSON-serialize the AST."""
    ast = parse(source, kind=kind, **kwargs).to_dict()
    return json.dumps(ast, ensure_ascii=False, indent=2)


# ---------------------------
# Kind inference + helpers
# ---------------------------

def _infer_kind(source: str) -> str:
    if os.path.exists(source) and os.path.isfile(source):
        ext = os.path.splitext(source)[1].lower()
        if ext in [".csv", ".tsv"]:
            return "csv"
        if ext in [".xlsx", ".xlsm", ".xltx", ".xltm"]:
            return "excel"
        if ext in [".json", ".jsonl"]:
            return "json"
        if ext in [".parquet"]:
            return "parquet"
        if ext in [".sql"]:
            return "sql"
        # fallback: treat unknown file as text -> sql-ish? no: default to json attempt?
        return "csv"  # safest: treat as delimited text
    # Not a file path => assume SQL text
    return "sql"


def _fingerprint_bytes(data: bytes) -> str:
    return hashlib.sha256(data).hexdigest()


def _fingerprint_file(path: str) -> str:
    h = hashlib.sha256()
    with open(path, "rb") as f:
        for chunk in iter(lambda: f.read(1024 * 1024), b""):
            h.update(chunk)
    return h.hexdigest()


def _safe_open_text(path: str, encoding: str) -> str:
    with open(path, "r", encoding=encoding, errors="replace") as f:
        return f.read()


def _coerce_json_records(obj: Any, records_path: Optional[List[Union[str, int]]]) -> Tuple[List[Dict[str, Any]], List[str]]:
    """
    Return (records, warnings).
    Accepts:
    - list[dict]
    - dict with a list under a key (optionally via records_path)
    - JSONL is handled outside this function
    """
    warnings: List[str] = []

    def follow_path(x: Any, path: List[Union[str, int]]) -> Any:
        cur = x
        for p in path:
            if isinstance(p, int) and isinstance(cur, list) and 0 <= p < len(cur):
                cur = cur[p]
            elif isinstance(p, str) and isinstance(cur, dict) and p in cur:
                cur = cur[p]
            else:
                raise KeyError(f"records_path step not found: {p}")
        return cur

    if records_path:
        try:
            obj = follow_path(obj, records_path)
        except Exception as e:
            warnings.append(f"Could not follow records_path; falling back to heuristic. Details: {e}")

    if isinstance(obj, list):
        recs = []
        for i, item in enumerate(obj):
            if isinstance(item, dict):
                recs.append(item)
            else:
                recs.append({"value": item})
                warnings.append(f"Non-object item at index {i}; wrapped into {{'value': ...}}")
        return recs, warnings

    if isinstance(obj, dict):
        # heuristic: find first list value
        for k, v in obj.items():
            if isinstance(v, list):
                recs, w = _coerce_json_records(v, None)
                warnings.append(f"Heuristic selected key '{k}' as records array.")
                warnings.extend(w)
                return recs, warnings
        # dict-only => single record
        return [obj], warnings

    # primitive => single record
    return [{"value": obj}], warnings


def _infer_dtype(values: List[Any]) -> str:
    """
    Best-effort dtype inference.
    Returns: "int", "float", "bool", "datetime", "string", "object", "null", "unknown"
    """
    non_null = [v for v in values if v is not None and v != ""]
    if not non_null:
        return "null"

    # bool
    if all(isinstance(v, bool) for v in non_null):
        return "bool"

    # int / float
    def is_int_like(x: Any) -> bool:
        if isinstance(x, int) and not isinstance(x, bool):
            return True
        if isinstance(x, str) and re.fullmatch(r"[+-]?\d+", x.strip() or " "):
            return True
        return False

    def is_float_like(x: Any) -> bool:
        if isinstance(x, float):
            return True
        if isinstance(x, str):
            s = x.strip()
            if not s:
                return False
            # Accept 1.23, -1.2e3
            return bool(re.fullmatch(r"[+-]?(\d+(\.\d*)?|\.\d+)([eE][+-]?\d+)?", s))
        return False

    if all(is_int_like(v) for v in non_null):
        return "int"
    if all(is_float_like(v) or is_int_like(v) for v in non_null):
        return "float"

    # datetime-ish (very light heuristic)
    dt_hits = 0
    for v in non_null[:50]:
        if isinstance(v, (datetime, )):
            dt_hits += 1
            continue
        if isinstance(v, str):
            s = v.strip()
            if re.search(r"\d{4}-\d{2}-\d{2}", s) or re.search(r"\d{2}/\d{2}/\d{4}", s):
                dt_hits += 1
    if dt_hits >= max(1, len(non_null[:50]) // 2):
        return "datetime"

    # string
    if all(isinstance(v, str) for v in non_null):
        return "string"

    return "object"


def _compute_profile(rows: List[Dict[str, Any]], schema: SchemaAST) -> ProfileAST:
    prof = ProfileAST()
    prof.row_count_estimate = len(rows)
    prof.column_count = len(schema.fields)

    if not rows:
        return prof

    # missingness
    for f in schema.fields:
        name = f.name
        miss = 0
        for r in rows:
            v = r.get(name, None)
            if v is None or v == "":
                miss += 1
        prof.missingness[name] = miss / max(1, len(rows))

    # numeric stats + cardinality (sample-based)
    for f in schema.fields:
        name = f.name
        vals = [r.get(name, None) for r in rows]
        non_null = [v for v in vals if v is not None and v != ""]
        unique = set()
        for v in non_null:
            try:
                unique.add(v)
            except Exception:
                unique.add(str(v))
        prof.cardinality_estimate[name] = len(unique)

        if f.dtype in ("int", "float"):
            nums = []
            for v in non_null:
                try:
                    nums.append(float(v))
                except Exception:
                    continue
            if nums:
                mn = min(nums)
                mx = max(nums)
                mean = sum(nums) / len(nums)
                var = sum((x - mean) ** 2 for x in nums) / len(nums)
                std = math.sqrt(var)
                prof.numeric_summary[name] = {"min": mn, "max": mx, "mean": mean, "std": std}

    return prof


def _schema_from_rows(rows: List[Dict[str, Any]], max_samples_per_field: int = 25) -> SchemaAST:
    # union of keys
    all_keys: List[str] = []
    seen = set()
    for r in rows:
        for k in r.keys():
            if k not in seen:
                seen.add(k)
                all_keys.append(k)

    fields: List[FieldAST] = []
    for k in all_keys:
        vals = [r.get(k, None) for r in rows]
        dtype = _infer_dtype(vals)
        sample_vals = []
        for v in vals:
            if v is None or v == "":
                continue
            sample_vals.append(v)
            if len(sample_vals) >= max_samples_per_field:
                break
        nullable = any((r.get(k, None) is None or r.get(k, "") == "") for r in rows)
        fields.append(FieldAST(name=k, dtype=dtype, nullable=nullable, sample_values=sample_vals))
    return SchemaAST(fields=fields)


# ---------------------------
# CSV Parser
# ---------------------------

def _parse_csv(path: str, *, sample_rows: int, encoding: str, dialect: str) -> DatasetAST:
    if not os.path.exists(path):
        raise FileNotFoundError(path)

    warnings: List[str] = []
    meta: Dict[str, Any] = {
        "path": path,
        "ext": os.path.splitext(path)[1].lower(),
    }

    rows: List[Dict[str, Any]] = []
    schema: SchemaAST

    # Prefer pandas if available for better delimiter inference, but keep stdlib fallback.
    if pd is not None:
        try:
            # low_memory=False avoids mixed-type warnings in the sample
            df = pd.read_csv(path, nrows=sample_rows, encoding=encoding, sep=None, engine="python", low_memory=False)
            rows = df.where(pd.notnull(df), None).to_dict(orient="records")
            schema = _schema_from_rows(rows)
            fp = _fingerprint_file(path)
            ds = DatasetAST(
                kind="csv",
                source=path,
                fingerprint=fp,
                schema=schema,
                preview_rows=rows,
                profile=_compute_profile(rows, schema),
                meta={**meta, "reader": "pandas"},
                warnings=warnings,
            )
            return ds
        except Exception as e:
            warnings.append(f"pandas CSV read failed; using stdlib csv. Details: {e}")

    # stdlib fallback
    with open(path, "r", encoding=encoding, errors="replace", newline="") as f:
        try:
            csv_dialect = csv.get_dialect(dialect)
        except Exception:
            csv_dialect = csv.excel

        reader = csv.DictReader(f, dialect=csv_dialect)
        for i, row in enumerate(reader):
            if i >= sample_rows:
                break
            # keep raw strings; higher layers can coerce if needed
            rows.append(dict(row))

    schema = _schema_from_rows(rows)
    fp = _fingerprint_file(path)
    return DatasetAST(
        kind="csv",
        source=path,
        fingerprint=fp,
        schema=schema,
        preview_rows=rows,
        profile=_compute_profile(rows, schema),
        meta={**meta, "reader": "stdlib_csv"},
        warnings=warnings,
    )


# ---------------------------
# Excel Parser
# ---------------------------

def _parse_excel(path: str, *, sample_rows: int, sheet: Optional[Union[str, int]]) -> DatasetAST:
    if not os.path.exists(path):
        raise FileNotFoundError(path)
    if openpyxl is None:
        raise RuntimeError("openpyxl is required to parse Excel files (.xlsx). Install: pip install openpyxl")

    warnings: List[str] = []
    meta: Dict[str, Any] = {"path": path, "ext": os.path.splitext(path)[1].lower(), "reader": "openpyxl"}

    wb = openpyxl.load_workbook(path, read_only=True, data_only=True)
    if sheet is None:
        ws = wb.worksheets[0]
        meta["sheet_selected"] = ws.title
    else:
        if isinstance(sheet, int):
            ws = wb.worksheets[sheet]
            meta["sheet_selected"] = ws.title
        else:
            ws = wb[sheet]
            meta["sheet_selected"] = sheet

    # Read header from first row with any value
    rows_iter = ws.iter_rows(values_only=True)
    header = None
    for r in rows_iter:
        if r and any(v is not None and str(v).strip() != "" for v in r):
            header = [str(v).strip() if v is not None else "" for v in r]
            break

    if not header:
        warnings.append("Excel sheet appears empty; no header found.")
        header = ["col1"]

    header = _dedupe_header(header)

    preview: List[Dict[str, Any]] = []
    for i, r in enumerate(rows_iter):
        if i >= sample_rows:
            break
        if r is None:
            continue
        rec: Dict[str, Any] = {}
        for j, col in enumerate(header):
            if j < len(r):
                rec[col] = r[j]
            else:
                rec[col] = None
        preview.append(rec)

    schema = _schema_from_rows(preview)
    fp = _fingerprint_file(path)
    return DatasetAST(
        kind="excel",
        source=path,
        fingerprint=fp,
        schema=schema,
        preview_rows=preview,
        profile=_compute_profile(preview, schema),
        meta=meta,
        warnings=warnings,
    )


def _dedupe_header(cols: List[str]) -> List[str]:
    out: List[str] = []
    seen: Dict[str, int] = {}
    for c in cols:
        name = c if c else "unnamed"
        if name not in seen:
            seen[name] = 1
            out.append(name)
        else:
            seen[name] += 1
            out.append(f"{name}_{seen[name]}")
    return out


# ---------------------------
# JSON Parser
# ---------------------------

def _parse_json(path: str, *, sample_rows: int, encoding: str, records_path: Optional[List[Union[str, int]]]) -> DatasetAST:
    if not os.path.exists(path):
        raise FileNotFoundError(path)

    warnings: List[str] = []
    meta: Dict[str, Any] = {"path": path, "ext": os.path.splitext(path)[1].lower()}

    ext = meta["ext"]
    preview: List[Dict[str, Any]] = []

    if ext == ".jsonl":
        # JSON lines: stream and sample
        with open(path, "r", encoding=encoding, errors="replace") as f:
            for i, line in enumerate(f):
                if i >= sample_rows:
                    break
                line = line.strip()
                if not line:
                    continue
                try:
                    obj = json.loads(line)
                except Exception as e:
                    warnings.append(f"Invalid JSONL line {i+1}: {e}")
                    continue
                if isinstance(obj, dict):
                    preview.append(obj)
                else:
                    preview.append({"value": obj})
        meta["reader"] = "jsonl_stream"
    else:
        raw = _safe_open_text(path, encoding)
        try:
            obj = json.loads(raw)
        except Exception as e:
            raise ValueError(f"Invalid JSON: {e}") from e

        records, w = _coerce_json_records(obj, records_path)
        warnings.extend(w)
        preview = records[:sample_rows]
        meta["reader"] = "json_load"

    # Flatten nested dict keys for tabular schema (optional but useful for IDE views)
    flat_preview = [_flatten_record(r) for r in preview]
    schema = _schema_from_rows(flat_preview)
    fp = _fingerprint_file(path)
    return DatasetAST(
        kind="json",
        source=path,
        fingerprint=fp,
        schema=schema,
        preview_rows=flat_preview,
        profile=_compute_profile(flat_preview, schema),
        meta=meta,
        warnings=warnings,
    )


def _flatten_record(obj: Any, *, prefix: str = "", sep: str = ".") -> Dict[str, Any]:
    """
    Flatten nested dictionaries into dot-keys: {"a": {"b": 1}} -> {"a.b": 1}
    Lists become JSON strings to keep schema stable.
    """
    out: Dict[str, Any] = {}

    def rec(x: Any, p: str) -> None:
        if isinstance(x, dict):
            for k, v in x.items():
                key = f"{p}{sep}{k}" if p else str(k)
                rec(v, key)
        elif isinstance(x, list):
            # Keep as string to avoid schema explosion
            try:
                out[p or "value"] = json.dumps(x, ensure_ascii=False)
            except Exception:
                out[p or "value"] = str(x)
        else:
            out[p or "value"] = x

    rec(obj, prefix)
    return out


# ---------------------------
# Parquet Parser
# ---------------------------

def _parse_parquet(path: str, *, sample_rows: int) -> DatasetAST:
    if not os.path.exists(path):
        raise FileNotFoundError(path)

    warnings: List[str] = []
    meta: Dict[str, Any] = {"path": path, "ext": os.path.splitext(path)[1].lower()}

    if pd is None:
        raise RuntimeError("pandas is required to parse Parquet. Install: pip install pandas pyarrow")

    try:
        df = pd.read_parquet(path)
        if len(df) > sample_rows:
            df = df.head(sample_rows)
        preview = df.where(pd.notnull(df), None).to_dict(orient="records")
        schema = _schema_from_rows(preview)
        fp = _fingerprint_file(path)
        return DatasetAST(
            kind="parquet",
            source=path,
            fingerprint=fp,
            schema=schema,
            preview_rows=preview,
            profile=_compute_profile(preview, schema),
            meta={**meta, "reader": "pandas"},
            warnings=warnings,
        )
    except Exception as e:
        raise RuntimeError(f"Failed to read Parquet: {e}") from e


# ---------------------------
# SQL Parser
# ---------------------------

_SQL_KEYWORDS = {"select", "from", "where", "join", "inner", "left", "right", "full",
                 "group", "by", "order", "limit", "insert", "update", "delete", "create",
                 "alter", "drop", "into", "values", "set"}

def _parse_sql(sql_or_path: str, *, dialect_hint: Optional[str]) -> SQLStatementAST:
    # Accept either .sql file path or raw SQL
    raw = _safe_open_text(sql_or_path, "utf-8") if (os.path.exists(sql_or_path) and os.path.isfile(sql_or_path)) else sql_or_path
    raw = raw.strip()

    stmt = SQLStatementAST(statement_type="UNKNOWN", raw=raw)
    if not raw:
        stmt.warnings.append("Empty SQL input.")
        return stmt

    if sqlparse is not None:
        try:
            parsed = sqlparse.parse(raw)
            if not parsed:
                stmt.warnings.append("sqlparse returned no statements; falling back.")
                return _parse_sql_fallback(raw, stmt)
            # Use first statement for AST (you can extend to multiple)
            s = parsed[0]
            stmt.statement_type = (s.get_type() or "UNKNOWN").upper()
            _extract_sql_struct_with_sqlparse(s, stmt)
            if dialect_hint:
                stmt.warnings.append(f"Dialect hint provided: {dialect_hint} (sqlparse is dialect-agnostic).")
            return stmt
        except Exception as e:
            stmt.warnings.append(f"sqlparse failed; using fallback. Details: {e}")
            return _parse_sql_fallback(raw, stmt)

    stmt.warnings.append("Optional dependency `sqlparse` not installed; using minimal fallback parser.")
    return _parse_sql_fallback(raw, stmt)


def _extract_sql_struct_with_sqlparse(statement: Any, out: SQLStatementAST) -> None:
    # Best-effort extraction (not a full SQL AST)
    # We'll scan tokens to collect table names after FROM/JOIN and selected columns in SELECT.
    tokens = [t for t in statement.flatten() if str(t).strip()]
    text_tokens = [str(t) for t in tokens]
    lower = [t.lower() for t in text_tokens]

    # statement type already set by sqlparse
    # Tables
    tables: List[str] = []
    joins: List[str] = []
    cols: List[str] = []

    def collect_ident_after(idx: int) -> Optional[str]:
        # Take next non-keyword token as identifier; strip punctuation
        for j in range(idx + 1, min(idx + 10, len(text_tokens))):
            tok = text_tokens[j].strip()
            if not tok:
                continue
            if tok.lower() in _SQL_KEYWORDS:
                continue
            # stop on commas/parentheses-only tokens
            cleaned = tok.strip(",;()")
            if cleaned:
                return cleaned
        return None

    # columns in SELECT ... FROM
    if "select" in lower:
        try:
            i_sel = lower.index("select")
            # naive: collect tokens until FROM
            for j in range(i_sel + 1, len(text_tokens)):
                if lower[j] == "from":
                    break
                tok = text_tokens[j].strip()
                if not tok or tok.lower() in _SQL_KEYWORDS:
                    continue
                if tok in (",",):
                    continue
                cleaned = tok.strip(",;()")
                if cleaned and cleaned.lower() not in _SQL_KEYWORDS:
                    cols.append(cleaned)
        except Exception:
            out.warnings.append("Could not reliably extract SELECT columns.")

    # tables after FROM and JOIN
    for i, tok in enumerate(lower):
        if tok == "from":
            name = collect_ident_after(i)
            if name:
                tables.append(name)
        if tok == "join":
            name = collect_ident_after(i)
            if name:
                joins.append(name)

    out.tables = _uniq_keep_order(tables)
    out.joins = _uniq_keep_order(joins)
    out.columns = _uniq_keep_order(cols)

    # WHERE clause text (best-effort)
    out.where = _extract_clause(raw=out.raw, clause="where", stop_clauses=("group by", "order by", "limit"))
    out.group_by = _split_clause_list(_extract_clause(raw=out.raw, clause="group by", stop_clauses=("order by", "limit")))
    out.order_by = _split_clause_list(_extract_clause(raw=out.raw, clause="order by", stop_clauses=("limit",)))
    out.limit = _extract_limit(out.raw)


def _parse_sql_fallback(raw: str, stmt: SQLStatementAST) -> SQLStatementAST:
    s = re.sub(r"\s+", " ", raw.strip())
    m = re.match(r"^\s*(\w+)", s, flags=re.I)
    if m:
        stmt.statement_type = m.group(1).upper()

    # Tables: FROM / JOIN
    tables = re.findall(r"\bfrom\s+([a-zA-Z0-9_.\"`]+)", s, flags=re.I)
    joins = re.findall(r"\bjoin\s+([a-zA-Z0-9_.\"`]+)", s, flags=re.I)
    stmt.tables = _uniq_keep_order([t.strip("\"`") for t in tables])
    stmt.joins = _uniq_keep_order([t.strip("\"`") for t in joins])

    # Columns (very naive): SELECT ... FROM
    if re.search(r"^\s*select\b", s, flags=re.I):
        try:
            select_part = re.split(r"\bfrom\b", s, flags=re.I, maxsplit=1)[0]
            select_part = re.sub(r"^\s*select\s+", "", select_part, flags=re.I).strip()
            # split on commas not inside parentheses (simple)
            cols = _split_csv_like(select_part)
            stmt.columns = [c.strip() for c in cols if c.strip() and c.strip() != "*"]
        except Exception:
            stmt.warnings.append("Fallback could not extract SELECT columns reliably.")

    stmt.where = _extract_clause(raw=s, clause="where", stop_clauses=("group by", "order by", "limit"))
    stmt.group_by = _split_clause_list(_extract_clause(raw=s, clause="group by", stop_clauses=("order by", "limit")))
    stmt.order_by = _split_clause_list(_extract_clause(raw=s, clause="order by", stop_clauses=("limit",)))
    stmt.limit = _extract_limit(s)

    stmt.warnings.append("SQL fallback parser is heuristic; for a real AST install `sqlparse` or a full SQL parser library.")
    return stmt


def _extract_clause(*, raw: str, clause: str, stop_clauses: Tuple[str, ...]) -> Optional[str]:
    # returns string after `clause` until next stop clause
    rl = raw.lower()
    c = clause.lower()
    idx = rl.find(c)
    if idx == -1:
        return None
    start = idx + len(c)
    tail = raw[start:].strip()

    # find earliest stop clause occurrence
    stop_pos = None
    for sc in stop_clauses:
        p = tail.lower().find(sc)
        if p != -1:
            stop_pos = p if stop_pos is None else min(stop_pos, p)
    if stop_pos is not None:
        tail = tail[:stop_pos].strip()
    return tail or None


def _extract_limit(raw: str) -> Optional[int]:
    m = re.search(r"\blimit\s+(\d+)\b", raw, flags=re.I)
    if not m:
        return None
    try:
        return int(m.group(1))
    except Exception:
        return None


def _split_clause_list(clause: Optional[str]) -> List[str]:
    if not clause:
        return []
    parts = _split_csv_like(clause)
    return [p.strip() for p in parts if p.strip()]


def _split_csv_like(s: str) -> List[str]:
    """
    Split a comma-separated SQL fragment while ignoring commas inside parentheses.
    Example: "a, b, func(x, y), c" -> ["a", "b", "func(x, y)", "c"]
    """
    out: List[str] = []
    cur = []
    depth = 0
    for ch in s:
        if ch == "(":
            depth += 1
        elif ch == ")":
            depth = max(0, depth - 1)
        if ch == "," and depth == 0:
            out.append("".join(cur))
            cur = []
        else:
            cur.append(ch)
    if cur:
        out.append("".join(cur))
    return out


def _uniq_keep_order(items: List[str]) -> List[str]:
    seen = set()
    out: List[str] = []
    for x in items:
        if not x:
            continue
        if x in seen:
            continue
        seen.add(x)
        out.append(x)
    return out


# ---------------------------
# CLI (optional quick test)
# ---------------------------

def _main(argv: Optional[List[str]] = None) -> int:
    import argparse

    p = argparse.ArgumentParser(description="IDE Lense parse.py — parse CSV/Excel/JSON/SQL/Parquet into a normalized AST.")
    p.add_argument("source", help="File path OR SQL text (if kind=sql and not a file).")
    p.add_argument("--kind", choices=["csv", "excel", "json", "sql", "parquet"], default=None)
    p.add_argument("--sample-rows", type=int, default=50)
    p.add_argument("--sheet", default=None, help="Excel sheet name or index.")
    p.add_argument("--encoding", default="utf-8")
    p.add_argument("--json-records-path", default=None, help='JSON path to records array, e.g. data.items or 0.items')
    args = p.parse_args(argv)

    sheet: Optional[Union[str, int]] = None
    if args.sheet is not None:
        try:
            sheet = int(args.sheet)
        except Exception:
            sheet = args.sheet

    records_path = None
    if args.json_records_path:
        records_path = []
        for part in args.json_records_path.split("."):
            part = part.strip()
            if part == "":
                continue
            try:
                records_path.append(int(part))
            except Exception:
                records_path.append(part)

    out = parse_to_json(
        args.source,
        kind=args.kind,
        sample_rows=args.sample_rows,
        excel_sheet=sheet,
        encoding=args.encoding,
        json_records_path=records_path,
    )
    print(out)
    return 0


if __name__ == "__main__":
    raise SystemExit(_main())
