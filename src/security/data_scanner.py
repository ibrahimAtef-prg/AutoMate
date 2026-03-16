"""
data_scanner.py — Data Leakage Detection Engine
================================================

Architecture:
    DataScanner
       │
       ├── RegexDetector     — PII, secrets, patterns
       ├── EntropyDetector   — high-entropy strings (keys, tokens)
       ├── NERDetector       — named entity recognition (lightweight)
       └── LLMClassifier     — optional LLM-based classification

Capabilities:
    - PII: emails, phones, SSN, credit cards, passport, national IDs, names, addresses
    - Secrets: API keys, JWT tokens, private keys, passwords, GitHub/OpenAI/AWS keys
    - Sensitive: financial records, medical data, confidential text

Output: leakage_report.json
    {
        pii_findings: [...],
        secrets: [...],
        sensitive_content: [...],
        risk_score: 0-100
    }
"""

from __future__ import annotations
import json, math, os, re, sys, hashlib
from typing import Any, Dict, List, Optional, Tuple
from dataclasses import dataclass, field, asdict
from collections import Counter

try:
    import pandas as pd
except ImportError:
    pd = None


# ============================================================
# Finding data classes
# ============================================================

@dataclass
class Finding:
    type: str           # "pii", "secret", "sensitive"
    category: str       # "email", "phone", "api_key", etc.
    column: str         # column name
    row_index: int      # row index (-1 if column-level)
    value_preview: str  # masked/truncated preview
    confidence: float   # 0.0 - 1.0
    severity: str       # "critical", "high", "medium", "low"
    description: str


@dataclass
class ScanReport:
    pii_findings: List[Dict[str, Any]] = field(default_factory=list)
    secrets: List[Dict[str, Any]] = field(default_factory=list)
    sensitive_content: List[Dict[str, Any]] = field(default_factory=list)
    risk_score: float = 0.0
    total_cells_scanned: int = 0
    columns_scanned: int = 0
    high_risk_columns: List[str] = field(default_factory=list)
    summary: str = ""

    def to_dict(self) -> Dict[str, Any]:
        return asdict(self)

    def to_json(self, indent: int = 2) -> str:
        return json.dumps(self.to_dict(), ensure_ascii=False, indent=indent, default=str)


# ============================================================
# Regex Detector
# ============================================================

class RegexDetector:
    """Detect PII, secrets, and sensitive data using regex patterns."""

    PII_PATTERNS = {
        "email": {
            "pattern": r'\b[A-Za-z0-9._%+\-]+@[A-Za-z0-9.\-]+\.[A-Za-z]{2,}\b',
            "severity": "high",
            "description": "Email address detected"
        },
        "phone_us": {
            "pattern": r'\b(?:\+?1[-.\s]?)?\(?\d{3}\)?[-.\s]?\d{3}[-.\s]?\d{4}\b',
            "severity": "high",
            "description": "US phone number detected"
        },
        "phone_intl": {
            "pattern": r'\b\+?\d{1,4}[-.\s]?\(?\d{1,4}\)?[-.\s]?\d{2,4}[-.\s]?\d{2,4}[-.\s]?\d{0,4}\b',
            "severity": "medium",
            "description": "International phone number detected"
        },
        "ssn": {
            "pattern": r'\b\d{3}[-\s]?\d{2}[-\s]?\d{4}\b',
            "severity": "critical",
            "description": "SSN-like pattern detected"
        },
        "credit_card": {
            "pattern": r'\b(?:4\d{3}|5[1-5]\d{2}|3[47]\d{2}|6(?:011|5\d{2}))[- ]?\d{4}[- ]?\d{4}[- ]?\d{4}\b',
            "severity": "critical",
            "description": "Credit card number detected"
        },
        "passport": {
            "pattern": r'\b[A-Z]{1,2}\d{6,9}\b',
            "severity": "critical",
            "description": "Passport number pattern detected"
        },
        "ip_address": {
            "pattern": r'\b(?:\d{1,3}\.){3}\d{1,3}\b',
            "severity": "medium",
            "description": "IP address detected"
        },
        "date_of_birth": {
            "pattern": r'\b(?:19|20)\d{2}[-/](?:0[1-9]|1[0-2])[-/](?:0[1-9]|[12]\d|3[01])\b',
            "severity": "high",
            "description": "Date of birth pattern detected"
        },
        "national_id": {
            "pattern": r'\b\d{2}[-.\s]?\d{2}[-.\s]?\d{2}[-.\s]?\d{3}[-.\s]?\d{3}[-.\s]?\d{2}\b',
            "severity": "critical",
            "description": "National ID number pattern detected"
        },
    }

    SECRET_PATTERNS = {
        "api_key_generic": {
            "pattern": r'(?:api[_-]?key|apikey|api_secret)["\s:=]+["\']?([A-Za-z0-9_\-]{20,})["\']?',
            "severity": "critical",
            "description": "Generic API key detected"
        },
        "openai_key": {
            "pattern": r'\bsk-[A-Za-z0-9]{20,}\b',
            "severity": "critical",
            "description": "OpenAI API key detected"
        },
        "github_token": {
            "pattern": r'\b(?:ghp|gho|ghu|ghs|ghr)_[A-Za-z0-9]{36,}\b',
            "severity": "critical",
            "description": "GitHub token detected"
        },
        "aws_access_key": {
            "pattern": r'\bAKIA[0-9A-Z]{16}\b',
            "severity": "critical",
            "description": "AWS Access Key ID detected"
        },
        "aws_secret_key": {
            "pattern": r'(?:aws_secret|secret_access_key)["\s:=]+["\']?([A-Za-z0-9/+=]{40})["\']?',
            "severity": "critical",
            "description": "AWS Secret Key detected"
        },
        "jwt_token": {
            "pattern": r'\beyJ[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}\b',
            "severity": "critical",
            "description": "JWT token detected"
        },
        "private_key": {
            "pattern": r'-----BEGIN (?:RSA |EC |DSA )?PRIVATE KEY-----',
            "severity": "critical",
            "description": "Private key header detected"
        },
        "password_field": {
            "pattern": r'(?:password|passwd|pwd)["\s:=]+["\']?([^\s"\']{8,})["\']?',
            "severity": "high",
            "description": "Password value detected"
        },
        "bearer_token": {
            "pattern": r'\bBearer\s+[A-Za-z0-9_\-.]{20,}\b',
            "severity": "high",
            "description": "Bearer token detected"
        },
        "connection_string": {
            "pattern": r'(?:mongodb|mysql|postgres|redis|amqp):\/\/[^\s]+',
            "severity": "critical",
            "description": "Database connection string detected"
        },
    }

    SENSITIVE_PATTERNS = {
        "medical_record": {
            "pattern": r'\b(?:diagnosis|prescription|patient\s*id|icd[-\s]?\d{1,2}|medical\s*record)\b',
            "severity": "high",
            "description": "Medical record indicator detected"
        },
        "financial_data": {
            "pattern": r'\b(?:account\s*(?:number|no)|routing\s*(?:number|no)|iban|swift|bic)\b',
            "severity": "high",
            "description": "Financial data indicator detected"
        },
        "confidential": {
            "pattern": r'\b(?:confidential|classified|top\s*secret|internal\s*only|restricted)\b',
            "severity": "medium",
            "description": "Confidentiality marker detected"
        },
    }

    def __init__(self):
        self._compiled_pii = {
            k: re.compile(v["pattern"], re.IGNORECASE)
            for k, v in self.PII_PATTERNS.items()
        }
        self._compiled_secrets = {
            k: re.compile(v["pattern"], re.IGNORECASE)
            for k, v in self.SECRET_PATTERNS.items()
        }
        self._compiled_sensitive = {
            k: re.compile(v["pattern"], re.IGNORECASE)
            for k, v in self.SENSITIVE_PATTERNS.items()
        }

    def scan_value(self, value: str, column: str, row_idx: int) -> List[Finding]:
        findings = []
        if not value or len(value) < 3:
            return findings

        # PII scan
        for cat, rx in self._compiled_pii.items():
            if rx.search(value):
                meta = self.PII_PATTERNS[cat]
                findings.append(Finding(
                    type="pii", category=cat, column=column,
                    row_index=row_idx,
                    value_preview=self._mask(value),
                    confidence=0.85, severity=meta["severity"],
                    description=meta["description"]
                ))

        # Secret scan
        for cat, rx in self._compiled_secrets.items():
            if rx.search(value):
                meta = self.SECRET_PATTERNS[cat]
                findings.append(Finding(
                    type="secret", category=cat, column=column,
                    row_index=row_idx,
                    value_preview=self._mask(value),
                    confidence=0.90, severity=meta["severity"],
                    description=meta["description"]
                ))

        # Sensitive scan
        for cat, rx in self._compiled_sensitive.items():
            if rx.search(value):
                meta = self.SENSITIVE_PATTERNS[cat]
                findings.append(Finding(
                    type="sensitive", category=cat, column=column,
                    row_index=row_idx,
                    value_preview=self._mask(value),
                    confidence=0.70, severity=meta["severity"],
                    description=meta["description"]
                ))

        return findings

    @staticmethod
    def _mask(value: str, show: int = 6) -> str:
        if len(value) <= show * 2:
            return value[:show] + "***"
        return value[:show] + "***" + value[-3:]


# ============================================================
# Entropy Detector
# ============================================================

class EntropyDetector:
    """Detect high-entropy strings that may be secrets or tokens."""

    ENTROPY_THRESHOLD = 4.5  # bits per character

    def scan_value(self, value: str, column: str, row_idx: int) -> List[Finding]:
        if not value or len(value) < 16:
            return []

        entropy = self._shannon_entropy(value)
        if entropy >= self.ENTROPY_THRESHOLD:
            return [Finding(
                type="secret", category="high_entropy",
                column=column, row_index=row_idx,
                value_preview=value[:8] + "***" + value[-3:],
                confidence=min(1.0, (entropy - self.ENTROPY_THRESHOLD) / 2.0),
                severity="high" if entropy > 5.5 else "medium",
                description=f"High entropy string detected (H={entropy:.2f} bits/char). May be a secret or token."
            )]
        return []

    @staticmethod
    def _shannon_entropy(s: str) -> float:
        if not s:
            return 0.0
        freq = Counter(s)
        n = len(s)
        return -sum((c / n) * math.log2(c / n) for c in freq.values())


# ============================================================
# NER Detector (lightweight heuristic-based)
# ============================================================

class NERDetector:
    """Lightweight named entity recognition for names and addresses."""

    # Common name indicators (column name heuristics)
    NAME_COLUMNS = {
        "name", "first_name", "last_name", "full_name", "firstname",
        "lastname", "fullname", "patient_name", "customer_name",
        "user_name", "username", "author", "person"
    }

    ADDRESS_COLUMNS = {
        "address", "street", "city", "state", "zip", "zipcode",
        "postal", "postal_code", "country", "county", "addr"
    }

    def scan_column(self, column: str, values: List[str]) -> List[Finding]:
        findings = []
        col_lower = column.lower().replace(" ", "_")

        if col_lower in self.NAME_COLUMNS or any(n in col_lower for n in ["name", "person"]):
            unique_vals = set(v for v in values if v and len(v) > 2)
            if len(unique_vals) > 5:  # Likely real names, not categories
                findings.append(Finding(
                    type="pii", category="person_name",
                    column=column, row_index=-1,
                    value_preview=f"Column '{column}' contains {len(unique_vals)} unique name-like values",
                    confidence=0.80, severity="high",
                    description=f"Column '{column}' appears to contain personal names based on column name and data patterns."
                ))

        if col_lower in self.ADDRESS_COLUMNS or any(a in col_lower for a in ["address", "street", "addr"]):
            findings.append(Finding(
                type="pii", category="address",
                column=column, row_index=-1,
                value_preview=f"Column '{column}' contains address-like data",
                confidence=0.75, severity="high",
                description=f"Column '{column}' appears to contain physical addresses."
            ))

        return findings


# ============================================================
# DataScanner — Main orchestrator
# ============================================================

class DataScanner:
    """
    Orchestrates all detectors to produce a comprehensive scan report.

    Usage:
        scanner = DataScanner()
        report = scanner.scan_dataframe(df)
        report = scanner.scan_file("data.csv")
        report = scanner.scan_text("some text with secrets")
    """

    def __init__(self, policy: Optional[Dict[str, Any]] = None):
        self.regex_detector = RegexDetector()
        self.entropy_detector = EntropyDetector()
        self.ner_detector = NERDetector()
        self.policy = policy or {}
        self._max_rows_scan = 5000  # Scan first N rows for large datasets

    def scan_dataframe(self, df, max_rows: Optional[int] = None) -> ScanReport:
        """Scan a pandas DataFrame for PII, secrets, and sensitive data."""
        if pd is None:
            return ScanReport(summary="pandas not available")

        max_r = max_rows or self._max_rows_scan
        sample = df.head(max_r)
        report = ScanReport()
        report.columns_scanned = len(df.columns)
        report.total_cells_scanned = int(sample.shape[0] * sample.shape[1])

        all_findings: List[Finding] = []

        # Column-level NER scan
        for col in df.columns:
            str_vals = sample[col].dropna().astype(str).tolist()
            all_findings.extend(self.ner_detector.scan_column(col, str_vals))

        # Cell-level regex + entropy scan
        for col in df.columns:
            for row_idx, val in enumerate(sample[col].dropna().astype(str)):
                if len(str(val)) < 3:
                    continue
                all_findings.extend(self.regex_detector.scan_value(str(val), col, row_idx))
                all_findings.extend(self.entropy_detector.scan_value(str(val), col, row_idx))

        # Categorize findings
        for f in all_findings:
            d = asdict(f)
            if f.type == "pii":
                report.pii_findings.append(d)
            elif f.type == "secret":
                report.secrets.append(d)
            elif f.type == "sensitive":
                report.sensitive_content.append(d)

        # Compute risk score
        report.risk_score = self._compute_risk_score(all_findings, report.total_cells_scanned)

        # Identify high-risk columns
        col_counts: Dict[str, int] = {}
        for f in all_findings:
            col_counts[f.column] = col_counts.get(f.column, 0) + 1
        report.high_risk_columns = [c for c, cnt in sorted(col_counts.items(), key=lambda x: -x[1])
                                    if cnt >= 2][:10]

        # Summary
        n_pii = len(report.pii_findings)
        n_sec = len(report.secrets)
        n_sen = len(report.sensitive_content)
        report.summary = (
            f"Scanned {report.total_cells_scanned} cells across {report.columns_scanned} columns. "
            f"Found {n_pii} PII, {n_sec} secrets, {n_sen} sensitive items. "
            f"Risk score: {report.risk_score:.0f}/100."
        )

        return report

    def scan_file(self, path: str) -> ScanReport:
        """Scan a dataset file for PII, secrets, and sensitive data."""
        if pd is None:
            return ScanReport(summary="pandas not available")

        ext = os.path.splitext(path)[1].lower()
        if ext in (".csv", ".tsv"):
            df = pd.read_csv(path)
        elif ext in (".json", ".jsonl"):
            try:
                df = pd.read_json(path)
            except Exception:
                df = pd.read_json(path, lines=True)
        elif ext in (".xlsx", ".xls"):
            df = pd.read_excel(path)
        elif ext == ".parquet":
            df = pd.read_parquet(path)
        else:
            df = pd.read_csv(path)  # best effort

        return self.scan_dataframe(df)

    def scan_text(self, text: str) -> List[Finding]:
        """Scan a text string for PII, secrets, and sensitive data."""
        findings = []
        findings.extend(self.regex_detector.scan_value(text, "__text__", 0))
        findings.extend(self.entropy_detector.scan_value(text, "__text__", 0))
        return findings

    def _compute_risk_score(self, findings: List[Finding], total_cells: int) -> float:
        """Compute a 0-100 risk score based on findings."""
        if not findings:
            return 0.0

        severity_weights = {"critical": 10, "high": 5, "medium": 2, "low": 1}
        total_weight = sum(severity_weights.get(f.severity, 1) * f.confidence for f in findings)

        # Density-based scaling
        density = len(findings) / max(total_cells, 1)
        density_factor = min(1.0, density * 100)

        # Category diversity penalty
        categories = set(f.category for f in findings)
        diversity_factor = min(1.0, len(categories) / 5)

        raw_score = total_weight * 2 + density_factor * 30 + diversity_factor * 20
        return min(100.0, max(0.0, raw_score))


# ============================================================
# CLI
# ============================================================

def main(argv=None):
    import argparse
    p = argparse.ArgumentParser(description="Data Scanner — PII/Secret/Sensitive detection")
    p.add_argument("path", help="Dataset file path")
    p.add_argument("--max-rows", type=int, default=5000)
    p.add_argument("--output", default=None, help="Output JSON path")
    args = p.parse_args(argv)

    scanner = DataScanner()
    report = scanner.scan_file(args.path)

    if args.output:
        with open(args.output, "w", encoding="utf-8") as f:
            f.write(report.to_json())
        print(f"Report saved to {args.output}", file=sys.stderr)
    else:
        print(report.to_json())

    return 0


if __name__ == "__main__":
    sys.exit(main())
