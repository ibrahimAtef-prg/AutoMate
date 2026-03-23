"""
policy_engine.py — Security Policy Engine
==========================================

Supports YAML policy files for data governance rules.

Example policy.yaml:
    rules:
      - block_credit_cards
      - block_medical_records
      - warn_on_api_keys
      - block_ssn
      - warn_on_emails
    
    thresholds:
      max_pii_density: 0.05
      max_risk_score: 50
    
    actions:
      on_violation: "block"  # block | warn | log

The scanner enforces these policies and returns violations.
"""

from __future__ import annotations
import json, os, sys
from typing import Any, Dict, List, Optional
from dataclasses import dataclass, field, asdict

try:
    import yaml
except ImportError as _e:
    raise ImportError(
        "PyYAML is required by policy_engine. Install: pip install pyyaml"
    ) from _e


# ============================================================
# Policy types
# ============================================================

@dataclass
class PolicyViolation:
    rule: str
    severity: str       # "critical", "high", "medium", "low"
    message: str
    action: str         # "block", "warn", "log"
    column: Optional[str] = None
    details: Optional[str] = None


@dataclass
class PolicyResult:
    policy_file: str = ""
    rules_checked: int = 0
    violations: List[Dict[str, Any]] = field(default_factory=list)
    action: str = "pass"  # "block", "warn", "pass"
    summary: str = ""

    def to_dict(self) -> Dict[str, Any]:
        return asdict(self)


# ============================================================
# Built-in rules registry
# ============================================================

BUILTIN_RULES: Dict[str, Dict[str, Any]] = {
    "block_credit_cards": {
        "check_type": "pii",
        "category": "credit_card",
        "severity": "critical",
        "action": "block",
        "description": "Block datasets containing credit card numbers"
    },
    "block_ssn": {
        "check_type": "pii",
        "category": "ssn",
        "severity": "critical",
        "action": "block",
        "description": "Block datasets containing SSN patterns"
    },
    "block_medical_records": {
        "check_type": "sensitive",
        "category": "medical_record",
        "severity": "critical",
        "action": "block",
        "description": "Block datasets containing medical records"
    },
    "warn_on_api_keys": {
        "check_type": "secret",
        "category": "api_key_generic",
        "severity": "high",
        "action": "warn",
        "description": "Warn when API keys are detected"
    },
    "warn_on_emails": {
        "check_type": "pii",
        "category": "email",
        "severity": "medium",
        "action": "warn",
        "description": "Warn when email addresses are detected"
    },
    "warn_on_phones": {
        "check_type": "pii",
        "category": "phone_us",
        "severity": "medium",
        "action": "warn",
        "description": "Warn when phone numbers are detected"
    },
    "block_private_keys": {
        "check_type": "secret",
        "category": "private_key",
        "severity": "critical",
        "action": "block",
        "description": "Block content containing private keys"
    },
    "warn_on_passwords": {
        "check_type": "secret",
        "category": "password_field",
        "severity": "high",
        "action": "warn",
        "description": "Warn when password values are detected"
    },
    "block_aws_keys": {
        "check_type": "secret",
        "category": "aws_access_key",
        "severity": "critical",
        "action": "block",
        "description": "Block content containing AWS access keys"
    },
    "block_openai_keys": {
        "check_type": "secret",
        "category": "openai_key",
        "severity": "critical",
        "action": "block",
        "description": "Block content containing OpenAI API keys"
    },
    "warn_on_names": {
        "check_type": "pii",
        "category": "person_name",
        "severity": "medium",
        "action": "warn",
        "description": "Warn when personal names are detected"
    },
    "block_jwt_tokens": {
        "check_type": "secret",
        "category": "jwt_token",
        "severity": "critical",
        "action": "block",
        "description": "Block content containing JWT tokens"
    },
}


# ============================================================
# PolicyEngine
# ============================================================

class PolicyEngine:
    """
    Load and enforce security policies from YAML files.

    Usage:
        engine = PolicyEngine("policy.yaml")
        result = engine.evaluate(scan_report)
    """

    def __init__(self, policy_path: Optional[str] = None):
        self.policy_path = policy_path or ""
        self.rules: List[str] = []
        self.thresholds: Dict[str, Any] = {}
        self.default_action: str = "warn"

        if policy_path and os.path.exists(policy_path):
            self._load_policy(policy_path)
        else:
            # Default policy: all warnings
            self.rules = list(BUILTIN_RULES.keys())

    def _load_policy(self, path: str):
        """Load policy from YAML file."""
        with open(path, "r", encoding="utf-8") as f:
            data = yaml.safe_load(f) or {}

        self.rules = data.get("rules", list(BUILTIN_RULES.keys()))
        self.thresholds = data.get("thresholds", {})
        self.default_action = data.get("actions", {}).get("on_violation", "warn")

    def evaluate(self, scan_report) -> PolicyResult:
        """
        Evaluate a ScanReport against the loaded policy.

        Parameters:
            scan_report: ScanReport from DataScanner

        Returns:
            PolicyResult with violations and recommended action
        """
        result = PolicyResult(
            policy_file=self.policy_path,
            rules_checked=len(self.rules)
        )

        # Build a lookup of findings by (type, category)
        all_findings = []
        for f in scan_report.pii_findings:
            all_findings.append(("pii", f.get("category", ""), f))
        for f in scan_report.secrets:
            all_findings.append(("secret", f.get("category", ""), f))
        for f in scan_report.sensitive_content:
            all_findings.append(("sensitive", f.get("category", ""), f))

        highest_action = "pass"

        for rule_name in self.rules:
            rule_def = BUILTIN_RULES.get(rule_name)
            if not rule_def:
                continue

            check_type = rule_def["check_type"]
            check_cat = rule_def["category"]
            action = rule_def.get("action", self.default_action)

            # Find matching findings
            matches = [f for t, c, f in all_findings if t == check_type and c == check_cat]

            if matches:
                violation = PolicyViolation(
                    rule=rule_name,
                    severity=rule_def["severity"],
                    message=f"{rule_def['description']}: {len(matches)} instance(s) found",
                    action=action,
                    column=matches[0].get("column"),
                    details=f"First found in column '{matches[0].get('column')}'"
                )
                result.violations.append(asdict(violation))

                # Escalate action
                if action == "block":
                    highest_action = "block"
                elif action == "warn" and highest_action != "block":
                    highest_action = "warn"

        # Check threshold violations
        max_risk = self.thresholds.get("max_risk_score", 100)
        if scan_report.risk_score > max_risk:
            result.violations.append(asdict(PolicyViolation(
                rule="risk_score_threshold",
                severity="high",
                message=f"Risk score {scan_report.risk_score:.0f} exceeds threshold {max_risk}",
                action="block"
            )))
            highest_action = "block"

        result.action = highest_action
        n_v = len(result.violations)
        result.summary = (
            f"Checked {result.rules_checked} rules. "
            f"Found {n_v} violation(s). Action: {highest_action.upper()}."
        )

        return result


# ============================================================
# CLI
# ============================================================

@dataclass
class ScanReportProxy:
    """
    Typed proxy for a scan report loaded from JSON in CLI mode.

    Mirrors the fields consumed by PolicyEngine.evaluate() so the CLI
    path uses the same contract as the programmatic path.
    """
    pii_findings:      List[Any] = field(default_factory=list)
    secrets:           List[Any] = field(default_factory=list)
    sensitive_content: List[Any] = field(default_factory=list)
    risk_score:        float      = 0.0


def main(argv=None):
    import argparse
    p = argparse.ArgumentParser(description="Policy Engine — Evaluate scan reports against policy")
    p.add_argument("--policy", default=None, help="Path to policy.yaml")
    p.add_argument("--report", required=True, help="Path to scan report JSON")
    args = p.parse_args(argv)

    with open(args.report, "r", encoding="utf-8") as f:
        report_data = json.load(f)

    report = ScanReportProxy(
        pii_findings      = report_data.get("pii_findings", []),
        secrets           = report_data.get("secrets", []),
        sensitive_content = report_data.get("sensitive_content", []),
        risk_score        = float(report_data.get("risk_score", 0)),
    )

    engine = PolicyEngine(args.policy)
    result = engine.evaluate(report)
    sys.stdout.write(json.dumps(result.to_dict(), indent=2) + "\n")
    return 0


if __name__ == "__main__":
    sys.exit(main())
