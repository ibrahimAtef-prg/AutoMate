"""
pii_detector.py — Dedicated PII Detection Engine
=================================================

Designed as a lightweight, standalone pre-pass before leakage_bridge.py.
Scans dataset columns for PII using:
  1. Regex patterns  (emails, phones, SSNs, credit cards, etc.)
  2. Column-name heuristics (name, address, email, dob, ssn, etc.)
  3. Entropy detection (high-entropy tokens = potential secrets)

Output contract (JSON stdout or return dict):
{
  "pii_columns":   ["email", "phone", "name"],   # columns containing PII
  "pii_findings":  [{...}],                       # per-column findings
  "pii_density":   0.04,                          # fraction of cells with PII
  "pii_risk":      "high" | "medium" | "low"
}

Integrated into the extension pipeline in extension.ts:
  parse → baseline → pii_detector → leakage_bridge

The leakage_bridge merges pii_columns into its output so the dashboard
Security tab and LLM context both have column-level PII coordinates.
"""

from __future__ import annotations

import json
import math
import os
import re
import sys
from collections import Counter
from dataclasses import dataclass, field, asdict
from typing import Any, Dict, List, Optional, Set

try:
    import pandas as pd   # type: ignore
except ImportError:
    pd = None  # type: ignore


# ─────────────────────────────────────────────────────────────────────────────
# Regex pattern library
# ─────────────────────────────────────────────────────────────────────────────

_PII_PATTERNS: Dict[str, Dict[str, str]] = {
    "email": {
        "pattern":     r'\b[A-Za-z0-9._%+\-]+@[A-Za-z0-9.\-]+\.[A-Za-z]{2,}\b',
        "severity":    "high",
        "description": "Email address",
    },
    "phone_us": {
        "pattern":     r'\b(?:\+?1[\-.\s]?)?\(?[2-9]\d{2}\)?[\-.\s]?\d{3}[\-.\s]?\d{4}\b',
        "severity":    "high",
        "description": "US phone number",
    },
    "phone_intl": {
        "pattern":     r'\+\d{1,3}[\s\-]?\(?\d{1,4}\)?[\s\-]?\d{2,4}[\s\-]?\d{2,4}[\s\-]?\d{0,4}',
        "severity":    "medium",
        "description": "International phone number",
    },
    "ssn": {
        "pattern":     r'\b\d{3}[-\s]\d{2}[-\s]\d{4}\b',
        "severity":    "critical",
        "description": "US Social Security Number",
    },
    "credit_card": {
        "pattern":     r'\b(?:4\d{3}|5[1-5]\d{2}|3[47]\d{2}|6(?:011|5\d{2}))[- ]?\d{4}[- ]?\d{4}[- ]?\d{4}\b',
        "severity":    "critical",
        "description": "Credit / debit card number",
    },
    "ip_address": {
        "pattern":     r'\b(?:(?:25[0-5]|2[0-4]\d|[01]?\d\d?)\.){3}(?:25[0-5]|2[0-4]\d|[01]?\d\d?)\b',
        "severity":    "medium",
        "description": "IPv4 address",
    },
    "date_of_birth": {
        "pattern":     r'\b(?:19|20)\d{2}[-/](?:0[1-9]|1[0-2])[-/](?:0[1-9]|[12]\d|3[01])\b',
        "severity":    "high",
        "description": "Date of birth (ISO format)",
    },
    "passport": {
        "pattern":     r'\b[A-Z]{1,2}\d{7,9}\b',
        "severity":    "critical",
        "description": "Passport number pattern",
    },
    "iban": {
        "pattern":     r'\b[A-Z]{2}\d{2}[A-Z0-9]{4}\d{7,15}\b',
        "severity":    "critical",
        "description": "IBAN bank account number",
    },
    "national_id": {
        "pattern":     r'\b\d{2}[-.\s]?\d{2}[-.\s]?\d{2}[-.\s]?\d{3}[-.\s]?\d{3}[-.\s]?\d{2}\b',
        "severity":    "critical",
        "description": "National ID number pattern",
    },
    "mac_address": {
        "pattern":     r'\b(?:[0-9A-Fa-f]{2}[:\-]){5}[0-9A-Fa-f]{2}\b',
        "severity":    "low",
        "description": "MAC address (device identifier)",
    },
    "aws_access_key": {
        "pattern":     r'\bAKIA[0-9A-Z]{16}\b',
        "severity":    "critical",
        "description": "AWS Access Key ID",
    },
    "openai_key": {
        "pattern":     r'\bsk-[A-Za-z0-9]{20,}\b',
        "severity":    "critical",
        "description": "OpenAI secret key",
    },
}

# High-entropy threshold: Shannon bits/char above which a token looks like a secret
_ENTROPY_THRESHOLD = 4.5

# Column-name keyword → PII category mapping
_COL_NAME_HINTS: Dict[str, str] = {
    "email":        "email",
    "mail":         "email",
    "phone":        "phone",
    "mobile":       "phone",
    "tel":          "phone",
    "ssn":          "ssn",
    "social":       "ssn",
    "credit":       "credit_card",
    "card":         "credit_card",
    "passport":     "passport",
    "dob":          "date_of_birth",
    "birth":        "date_of_birth",
    "birthdate":    "date_of_birth",
    "name":         "person_name",
    "firstname":    "person_name",
    "lastname":     "person_name",
    "fullname":     "person_name",
    "address":      "address",
    "street":       "address",
    "addr":         "address",
    "zip":          "address",
    "postal":       "address",
    "ip":           "ip_address",
    "gender":       "demographic",
    "age":          "demographic",
    "race":         "demographic",
    "ethnicity":    "demographic",
    "salary":       "financial",
    "income":       "financial",
    "account":      "financial",
    "iban":         "financial",
    "password":     "credential",
    "passwd":       "credential",
    "token":        "credential",
    "secret":       "credential",
    "api_key":      "credential",
    "apikey":       "credential",
}

_SEVERITY_ORDER = {"critical": 3, "high": 2, "medium": 1, "low": 0}


# ─────────────────────────────────────────────────────────────────────────────
# Finding dataclass
# ─────────────────────────────────────────────────────────────────────────────

@dataclass
class PIIFinding:
    column:        str
    category:      str
    severity:      str
    confidence:    float
    detection_method: str          # "regex", "column_name", "entropy"
    sample_count:  int             # how many cells matched
    description:   str
    value_preview: str = ""

    def to_dict(self) -> Dict[str, Any]:
        return asdict(self)


# ─────────────────────────────────────────────────────────────────────────────
# PII Detector
# ─────────────────────────────────────────────────────────────────────────────

class PIIDetector:
    """
    Standalone PII detection engine.

    Usage
    -----
    detector = PIIDetector()
    result   = detector.scan_dataframe(df)
    result   = detector.scan_file("data.csv")

    Returns a plain dict matching the output contract:
    {
      "pii_columns":  ["email", "phone"],
      "pii_findings": [{...}],
      "pii_density":  0.03,
      "pii_risk":     "high"
    }
    """

    def __init__(self, max_rows: int = 5000, sample_cells: int = 200):
        self._max_rows = max_rows
        self._sample_cells = sample_cells
        # Pre-compile all patterns
        self._compiled: Dict[str, re.Pattern] = {
            name: re.compile(meta["pattern"], re.IGNORECASE)
            for name, meta in _PII_PATTERNS.items()
        }

    # ------------------------------------------------------------------
    # Public API
    # ------------------------------------------------------------------

    def scan_dataframe(self, df: Any) -> Dict[str, Any]:  # df: pd.DataFrame
        if pd is None:
            return self._empty_result("pandas unavailable")

        sample = df.head(self._max_rows)
        findings: List[PIIFinding] = []
        pii_columns: Set[str] = set()
        total_cells = 0

        for col in sample.columns:
            col_findings = self._scan_column(col, sample[col])
            if col_findings:
                findings.extend(col_findings)
                pii_columns.add(col)
            total_cells += int(sample[col].count())

        return self._build_result(findings, list(pii_columns), total_cells)

    def scan_file(self, path: str) -> Dict[str, Any]:
        if pd is None:
            return self._empty_result("pandas unavailable")

        ext = os.path.splitext(path)[1].lower()
        try:
            if ext in (".csv", ".tsv"):
                df = pd.read_csv(path, nrows=self._max_rows)
            elif ext in (".xlsx", ".xls"):
                df = pd.read_excel(path, nrows=self._max_rows)
            elif ext in (".json", ".jsonl"):
                try:
                    df = pd.read_json(path)
                except Exception:
                    df = pd.read_json(path, lines=True)
                df = df.head(self._max_rows)
            elif ext == ".parquet":
                df = pd.read_parquet(path)
                df = df.head(self._max_rows)
            else:
                df = pd.read_csv(path, nrows=self._max_rows)
        except Exception as e:
            return self._empty_result(f"File read error: {e}")

        return self.scan_dataframe(df)

    # ------------------------------------------------------------------
    # Column scan
    # ------------------------------------------------------------------

    def _scan_column(self, col: str, series: Any) -> List[PIIFinding]:
        findings: List[PIIFinding] = []

        # 1. Column-name heuristic (fast, zero-cost)
        col_lower = col.lower().replace(" ", "_").replace("-", "_")
        for kw, category in _COL_NAME_HINTS.items():
            if kw in col_lower:
                severity = self._category_severity(category)
                findings.append(PIIFinding(
                    column=col, category=category, severity=severity,
                    confidence=0.75, detection_method="column_name",
                    sample_count=-1,
                    description=f"Column name '{col}' matches PII keyword '{kw}' → likely {category}.",
                ))
                break  # Only one column-name finding per column

        # 2. Value regex scan (sample up to _sample_cells cells)
        str_vals = series.dropna().astype(str)
        if len(str_vals) == 0:
            return findings

        sample_vals = str_vals.head(self._sample_cells).tolist()
        regex_hits: Dict[str, int] = {}

        for val in sample_vals:
            if len(val) < 3:
                continue
            for pat_name, rx in self._compiled.items():
                if rx.search(val):
                    regex_hits[pat_name] = regex_hits.get(pat_name, 0) + 1

        for pat_name, hit_count in regex_hits.items():
            meta = _PII_PATTERNS[pat_name]
            density = hit_count / max(len(sample_vals), 1)
            confidence = min(1.0, 0.5 + density * 3)
            preview_val = next(
                (v for v in sample_vals if self._compiled[pat_name].search(v)),
                ""
            )
            findings.append(PIIFinding(
                column=col, category=pat_name, severity=meta["severity"],
                confidence=round(confidence, 2), detection_method="regex",
                sample_count=hit_count,
                description=f"{meta['description']} detected in {hit_count}/{len(sample_vals)} sampled cells.",
                value_preview=self._mask(preview_val),
            ))

        # 3. Entropy scan (detect high-entropy tokens like secrets/keys)
        entropy_hits = 0
        for val in sample_vals:
            if len(val) >= 16 and self._entropy(val) >= _ENTROPY_THRESHOLD:
                entropy_hits += 1

        if entropy_hits >= max(1, len(sample_vals) // 20):
            findings.append(PIIFinding(
                column=col, category="high_entropy_token", severity="high",
                confidence=min(1.0, 0.4 + entropy_hits / len(sample_vals)),
                detection_method="entropy",
                sample_count=entropy_hits,
                description=f"High-entropy strings detected in {entropy_hits} cells — may be API keys, tokens, or hashed IDs.",
            ))

        # 4. Uniqueness ratio — quasi-identifier detection
        uniqueness_ratio = series.nunique() / max(len(series), 1)
        if uniqueness_ratio > 0.95 and len(series) > 5:
            findings.append(PIIFinding(
                column=col,
                category="quasi_identifier",
                severity="high",
                confidence=0.85,
                detection_method="uniqueness_ratio",
                sample_count=-1,
                description=f"{col} is {uniqueness_ratio:.0%} unique and may enable re-identification",
            ))

        return findings

    # ------------------------------------------------------------------
    # Result construction
    # ------------------------------------------------------------------

    def _build_result(
        self,
        findings: List[PIIFinding],
        pii_columns: List[str],
        total_cells: int,
    ) -> Dict[str, Any]:
        pii_density = len(findings) / max(total_cells, 1)
        max_sev = max(
            (_SEVERITY_ORDER.get(f.severity, 0) for f in findings),
            default=0
        )
        risk = ["low", "medium", "high", "critical"][max_sev]

        return {
            "pii_columns":  pii_columns,
            "pii_findings": [f.to_dict() for f in findings],
            "pii_density":  round(pii_density, 6),
            "pii_risk":     risk,
        }

    @staticmethod
    def _empty_result(reason: str) -> Dict[str, Any]:
        return {
            "pii_columns":  [],
            "pii_findings": [],
            "pii_density":  0.0,
            "pii_risk":     "low",
            "error":        reason,
        }

    @staticmethod
    def _mask(val: str, show: int = 6) -> str:
        if not val:
            return ""
        if len(val) <= show * 2:
            return val[:show] + "***"
        return val[:show] + "***" + val[-3:]

    @staticmethod
    def _entropy(s: str) -> float:
        if not s:
            return 0.0
        freq = Counter(s)
        n = len(s)
        return -sum((c / n) * math.log2(c / n) for c in freq.values())

    @staticmethod
    def _category_severity(category: str) -> str:
        high_cats = {"ssn", "credit_card", "passport", "iban", "national_id", "credential"}
        med_cats  = {"email", "phone", "date_of_birth", "financial", "ip_address"}
        if category in high_cats:
            return "critical"
        if category in med_cats:
            return "high"
        return "medium"


# ─────────────────────────────────────────────────────────────────────────────
# CLI
# ─────────────────────────────────────────────────────────────────────────────

def main(argv=None):
    import argparse
    p = argparse.ArgumentParser(description="PII Detector — scan dataset for personal information")
    p.add_argument("path", help="Dataset file (csv/xlsx/json/parquet)")
    p.add_argument("--max-rows",     type=int, default=5000)
    p.add_argument("--sample-cells", type=int, default=200)
    p.add_argument("--output",       default=None, help="Output JSON file path")
    args = p.parse_args(argv)

    detector = PIIDetector(max_rows=args.max_rows, sample_cells=args.sample_cells)
    result   = detector.scan_file(args.path)
    out_json = json.dumps(result, ensure_ascii=False, indent=2)

    if args.output:
        with open(args.output, "w", encoding="utf-8") as f:
            f.write(out_json)
        print(f"[pii_detector] Report saved to {args.output}", file=sys.stderr)
    else:
        print(out_json)

    return 0


if __name__ == "__main__":
    sys.exit(main())
