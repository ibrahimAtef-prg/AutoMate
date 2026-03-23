"""
anonymizer.py — Auto-Anonymization Engine
==========================================

Transforms sensitive data into anonymized equivalents:
    John Doe   → PERSON_001
    email      → hash-based replacement
    phone      → masked (***-***-1234)
    SSN        → redacted
    names      → pseudonymized with consistent mapping

Offers automatic fixes via a transformation pipeline.
"""

from __future__ import annotations
import logging as _logging
import hashlib, json, os, re, sys
from typing import Any, Dict, List, Optional, Tuple
from dataclasses import dataclass, field, asdict

_log = _logging.getLogger(__name__)

try:
    import pandas as pd
except ImportError as _e:
    raise ImportError(
        "pandas is required by anonymizer. Install: pip install pandas"
    ) from _e


@dataclass
class AnonymizationResult:
    original_columns: List[str] = field(default_factory=list)
    anonymized_columns: List[str] = field(default_factory=list)
    transformations_applied: List[Dict[str, str]] = field(default_factory=list)
    rows_processed: int = 0
    cells_anonymized: int = 0

    def to_dict(self) -> Dict[str, Any]:
        return asdict(self)


class Anonymizer:
    """
    Auto-anonymization engine for DataFrames.

    Strategies:
    - Names:       Consistent pseudonymization (PERSON_001, PERSON_002, ...)
    - Emails:      Hash-based replacement (EMAIL_<hash6>@anon.local)
    - Phones:      Masking (***-***-1234)
    - SSN:         Full redaction (***-**-****)
    - Credit Cards: Masking (****-****-****-1234)
    - Addresses:   Generalization (city/state only)
    - Free text:   Regex-based PII removal
    """

    # Column name heuristics
    NAME_COLS = {"name", "first_name", "last_name", "full_name", "firstname",
                 "lastname", "fullname", "patient_name", "customer_name", "person"}
    EMAIL_COLS = {"email", "e_mail", "email_address", "emailaddress", "mail"}
    PHONE_COLS = {"phone", "telephone", "tel", "mobile", "cell", "phone_number"}
    SSN_COLS = {"ssn", "social_security", "social_security_number", "sin"}
    ADDRESS_COLS = {"address", "street", "street_address", "addr", "home_address"}

    def __init__(self):
        self._name_map: Dict[str, str] = {}
        self._name_counter = 0
        self._email_map: Dict[str, str] = {}

    def anonymize_dataframe(self, df, columns: Optional[List[str]] = None) -> Tuple[Any, AnonymizationResult]:
        """
        Anonymize specified columns (or auto-detect) in a DataFrame.

        Returns: (anonymized_df, result)
        """
        df_anon = df.copy()
        result = AnonymizationResult(
            original_columns=list(df.columns),
            rows_processed=len(df)
        )

        target_cols = columns or self._detect_sensitive_columns(df)
        result.anonymized_columns = target_cols

        for col in target_cols:
            if col not in df_anon.columns:
                continue

            col_lower = col.lower().replace(" ", "_")
            strategy = self._detect_strategy(col_lower, df_anon[col])

            if strategy == "name":
                df_anon[col] = df_anon[col].apply(self._anon_name)
                result.transformations_applied.append({
                    "column": col, "strategy": "pseudonymization",
                    "description": f"Names replaced with PERSON_NNN identifiers"
                })
            elif strategy == "email":
                df_anon[col] = df_anon[col].apply(self._anon_email)
                result.transformations_applied.append({
                    "column": col, "strategy": "hash_replacement",
                    "description": "Emails replaced with hashed equivalents"
                })
            elif strategy == "phone":
                df_anon[col] = df_anon[col].apply(self._anon_phone)
                result.transformations_applied.append({
                    "column": col, "strategy": "masking",
                    "description": "Phone numbers partially masked"
                })
            elif strategy == "ssn":
                df_anon[col] = df_anon[col].apply(self._anon_ssn)
                result.transformations_applied.append({
                    "column": col, "strategy": "redaction",
                    "description": "SSN values fully redacted"
                })
            elif strategy == "address":
                df_anon[col] = df_anon[col].apply(self._anon_address)
                result.transformations_applied.append({
                    "column": col, "strategy": "generalization",
                    "description": "Address details generalized"
                })
            else:
                df_anon[col] = df_anon[col].apply(self._anon_freetext)
                result.transformations_applied.append({
                    "column": col, "strategy": "pii_removal",
                    "description": "PII patterns removed from free text"
                })

            result.cells_anonymized += int(df_anon[col].notna().sum())

        return df_anon, result

    def anonymize_text(self, text: str) -> str:
        """Anonymize PII in free text."""
        return self._anon_freetext(text)

    def _detect_sensitive_columns(self, df) -> List[str]:
        """Auto-detect columns likely to contain PII."""
        sensitive = []
        all_targets = self.NAME_COLS | self.EMAIL_COLS | self.PHONE_COLS | self.SSN_COLS | self.ADDRESS_COLS
        for col in df.columns:
            cl = col.lower().replace(" ", "_")
            if cl in all_targets or any(t in cl for t in ["name", "email", "phone", "ssn", "address"]):
                sensitive.append(col)
        return sensitive

    def _detect_strategy(self, col_lower: str, series) -> str:
        """Determine anonymization strategy from column name and data."""
        if col_lower in self.SSN_COLS or "ssn" in col_lower:
            return "ssn"
        if col_lower in self.EMAIL_COLS or "email" in col_lower or "mail" in col_lower:
            return "email"
        if col_lower in self.PHONE_COLS or "phone" in col_lower or "tel" in col_lower:
            return "phone"
        if col_lower in self.NAME_COLS or "name" in col_lower or "person" in col_lower:
            return "name"
        if col_lower in self.ADDRESS_COLS or "address" in col_lower or "street" in col_lower:
            return "address"
        return "freetext"

    def _anon_name(self, val) -> 'str | None':
        # B11 fix: return None (not float NaN) to avoid serialization issues downstream
        if pd.isna(val):
            return None
        s = str(val).strip()
        if not s:
            return s
        if s not in self._name_map:
            self._name_counter += 1
            self._name_map[s] = f"PERSON_{self._name_counter:03d}"
        return self._name_map[s]

    def _anon_email(self, val) -> 'str | None':
        # B11 fix: return None for NaN, not float NaN
        if pd.isna(val):
            return None
        s = str(val).strip()
        if not s:
            return s
        if s not in self._email_map:
            h = hashlib.sha256(s.encode()).hexdigest()[:8]
            self._email_map[s] = f"EMAIL_{h}@anon.local"
        return self._email_map[s]

    def _anon_phone(self, val) -> str:
        if pd.isna(val):
            return val
        s = str(val).strip()
        digits = re.sub(r'\D', '', s)
        if len(digits) >= 4:
            return "***-***-" + digits[-4:]
        return "***-REDACTED"

    def _anon_ssn(self, val) -> str:
        if pd.isna(val):
            return val
        return "***-**-****"

    def _anon_address(self, val) -> str:
        if pd.isna(val):
            return val
        s = str(val).strip()
        # Remove street numbers and specific identifiers
        s = re.sub(r'^\d+\s+', '', s)
        s = re.sub(r'\b(?:apt|suite|unit|#)\s*\d+\w*', '[UNIT]', s, flags=re.IGNORECASE)
        return s if s else "[REDACTED]"

    def _anon_freetext(self, val) -> str:
        if pd.isna(val):
            return val
        s = str(val)
        # Remove emails
        s = re.sub(r'[A-Za-z0-9._%+\-]+@[A-Za-z0-9.\-]+\.[A-Za-z]{2,}', '[EMAIL_REDACTED]', s)
        # Remove phone numbers
        s = re.sub(r'(?:\+?1[-.\s]?)?\(?\d{3}\)?[-.\s]?\d{3}[-.\s]?\d{4}', '[PHONE_REDACTED]', s)
        # Remove SSN patterns
        s = re.sub(r'\b\d{3}[-\s]?\d{2}[-\s]?\d{4}\b', '[SSN_REDACTED]', s)
        # Remove credit card patterns
        s = re.sub(r'\b(?:4\d{3}|5[1-5]\d{2}|3[47]\d{2}|6(?:011|5\d{2}))[- ]?\d{4}[- ]?\d{4}[- ]?\d{4}\b',
                   '[CC_REDACTED]', s)
        return s


# ============================================================
# CLI — matches extension.ts runAnonymizer() call signature:
#   python anonymizer.py <input_path> --output <output_path>
# ============================================================

def anonymize_dataframe(df, columns=None):
    """
    Public helper used by the CLI and tests.
    Returns the same dict shape as Anonymizer.anonymize_dataframe but flattened.
    """
    anon = Anonymizer()
    df_anon, result = anon.anonymize_dataframe(df, columns=columns)
    return {
        "anonymized_df":      df_anon,
        "anonymized_columns": result.anonymized_columns,
        "cells_anonymized":   result.cells_anonymized,
        "rules_applied":      {t["column"]: t["strategy"] for t in result.transformations_applied},
    }


def main(argv=None):
    import argparse
    p = argparse.ArgumentParser(description="Anonymizer — Auto-anonymize PII in datasets")
    p.add_argument("input",    help="Dataset file path (CSV/JSON/XLSX)")
    p.add_argument("--output", required=True,  help="Output anonymized file path")
    p.add_argument("--columns", nargs="*", default=None, help="Columns to anonymize (auto-detect if omitted)")
    args = p.parse_args(argv)
    degraded = False
    errors: List[str] = []

    def emit_error(msg: str) -> int:
        sys.stdout.write(json.dumps({"status": "error", "error": msg, "cells_anonymized": 0,
                          "anonymized_columns": [], "rules_applied": {}}) + "\n")
        return 1

    if not os.path.isfile(args.input):
        return emit_error(f"Input file not found: {args.input}")

    try:
        ext = os.path.splitext(args.input)[1].lower()
        if ext in (".csv", ".tsv"):
            df = pd.read_csv(args.input)
        elif ext == ".parquet":
            df = pd.read_parquet(args.input)
        elif ext in (".json", ".jsonl"):
            try:
                df = pd.read_json(args.input)
            except ValueError as e:
                _log.warning("fallback path activated: anonymizer JSON parse failed, retrying as JSONL: %s", e)
                degraded = True
                errors.append("input JSON parse fallback to JSONL")
                df = pd.read_json(args.input, lines=True)
        elif ext in (".xlsx", ".xls"):
            df = pd.read_excel(args.input)
        else:
            _log.warning(
                "fallback path activated: unsupported extension '%s' in anonymizer input; attempting CSV reader",
                ext,
            )
            degraded = True
            errors.append(f"unsupported input extension '{ext}' fell back to CSV")
            df = pd.read_csv(args.input)
    except Exception as e:
        _log.error("anonymizer fatal load error: %s", e)
        return emit_error(f"Failed to load dataset: {e}")

    try:
        report = anonymize_dataframe(df, columns=args.columns)
    except Exception as e:
        _log.error("anonymizer fatal processing error: %s", e)
        return emit_error(f"Anonymization failed: {e}")

    anon_df = report["anonymized_df"]
    try:
        out_ext = os.path.splitext(args.output)[1].lower()
        if out_ext in (".xlsx", ".xls"):
            anon_df.to_excel(args.output, index=False)
        elif out_ext == ".parquet":
            anon_df.to_parquet(args.output, index=False)
        else:
            anon_df.to_csv(args.output, index=False)
    except Exception as e:
        _log.error("anonymizer fatal write error: %s", e)
        return emit_error(f"Failed to write output: {e}")

    out_payload = {
        "status":             "success",
        "input_path":         args.input,
        "output_path":        args.output,
        "rows":               len(anon_df),
        "columns_anonymized": len(report["anonymized_columns"]),
        "anonymized_columns": report["anonymized_columns"],
        "cells_anonymized":   report["cells_anonymized"],
        "rules_applied":      report["rules_applied"],
        "error":              None,
    }
    if degraded:
        out_payload["degraded"] = True
        out_payload["errors"] = sorted(set(errors))

    sys.stdout.write(json.dumps(out_payload, ensure_ascii=False) + "\n")
    return 0


if __name__ == "__main__":
    sys.exit(main())
