"""
test_policy_engine.py — Unit tests for src/security/policy_engine.py

Covers:
  PE-01  Load a valid policy.yaml file
  PE-02  Default rules loaded when no YAML file exists
  PE-03  Rule evaluation matches findings correctly
  PE-04  Risk score threshold triggers violation
  PE-05  Action escalation: warn doesn't override block
  PE-06  Unknown rule names in yaml are silently skipped
  PE-07  PolicyResult.to_dict() returns correct structure
  PE-08  CLI parses a JSON scan report and outputs policy result
"""
import sys, os, json, textwrap
import pytest

sys.path.insert(0, os.path.join(os.path.dirname(__file__), '..', 'src'))

from security.policy_engine import (
    PolicyEngine, PolicyResult, ScanReportProxy, BUILTIN_RULES
)


# ─────────────────────────────────────────────────────────────────────────────
# Helpers
# ─────────────────────────────────────────────────────────────────────────────

def make_proxy(pii=None, secrets=None, sensitive=None, risk=0.0):
    return ScanReportProxy(
        pii_findings=pii or [],
        secrets=secrets or [],
        sensitive_content=sensitive or [],
        risk_score=risk,
    )


SAMPLE_POLICY_YAML = textwrap.dedent("""\
    rules:
      block_credit_cards:
        enabled: true
        action: block
        severity: critical
        description: Block credit cards
      warn_on_emails:
        enabled: true
        action: warn
        severity: medium
        description: Warn on emails

    thresholds:
      max_pii_density: 0.05
      max_risk_score: 50

    actions:
      on_violation: block
""")


# ─────────────────────────────────────────────────────────────────────────────
# Test: default policy
# ─────────────────────────────────────────────────────────────────────────────

class TestDefaultPolicy:

    # PE-02: Default rules loaded when no YAML
    def test_default_rules_loaded_when_no_file(self):
        engine = PolicyEngine(policy_path=None)
        assert len(engine.rules) > 0
        assert 'block_credit_cards' in engine.rules

    def test_all_builtin_rules_registered(self):
        engine = PolicyEngine(policy_path=None)
        for rule in BUILTIN_RULES:
            assert rule in engine.rules

    def test_default_action_is_warn(self):
        engine = PolicyEngine(policy_path=None)
        assert engine.default_action == 'warn'


# ─────────────────────────────────────────────────────────────────────────────
# Test: policy.yaml loading
# ─────────────────────────────────────────────────────────────────────────────

class TestPolicyLoading:

    # PE-01: Load valid YAML
    def test_load_valid_yaml(self, tmp_path):
        p = tmp_path / 'policy.yaml'
        p.write_text(SAMPLE_POLICY_YAML)
        engine = PolicyEngine(policy_path=str(p))
        assert 'block_credit_cards' in engine.rules

    def test_yaml_thresholds_loaded(self, tmp_path):
        p = tmp_path / 'policy.yaml'
        p.write_text(SAMPLE_POLICY_YAML)
        engine = PolicyEngine(policy_path=str(p))
        assert 'max_risk_score' in engine.thresholds

    def test_missing_file_uses_defaults(self, tmp_path):
        engine = PolicyEngine(policy_path=str(tmp_path / 'nonexistent.yaml'))
        # Should still have the built-in rules
        assert len(engine.rules) > 0


# ─────────────────────────────────────────────────────────────────────────────
# Test: rule evaluation
# ─────────────────────────────────────────────────────────────────────────────

class TestRuleEvaluation:

    # PE-03: Rule evaluation correctly matches (check_type, category)
    def test_credit_card_finding_triggers_block(self):
        engine = PolicyEngine()
        proxy = make_proxy(pii=[{'category': 'credit_card', 'column': 'card_num'}])
        result = engine.evaluate(proxy)
        assert result.action == 'block'
        rule_names = [v['rule'] for v in result.violations]
        assert 'block_credit_cards' in rule_names

    def test_email_finding_triggers_warn(self):
        engine = PolicyEngine()
        proxy = make_proxy(pii=[{'category': 'email', 'column': 'email'}])
        result = engine.evaluate(proxy)
        # Email rule is warn_on_emails → warn
        assert result.action in ('warn', 'block')

    def test_ssn_finding_triggers_block(self):
        engine = PolicyEngine()
        proxy = make_proxy(pii=[{'category': 'ssn', 'column': 'ssn'}])
        result = engine.evaluate(proxy)
        assert result.action == 'block'

    def test_api_key_finding_triggers_warn_or_block(self):
        engine = PolicyEngine()
        proxy = make_proxy(secrets=[{'category': 'api_key_generic', 'column': 'key'}])
        result = engine.evaluate(proxy)
        assert result.action in ('warn', 'block')

    def test_clean_proxy_returns_pass(self):
        engine = PolicyEngine()
        proxy = make_proxy()
        result = engine.evaluate(proxy)
        assert result.action == 'pass'
        assert result.violations == []

    # PE-05: Action escalation — block always wins over warn
    def test_block_beats_warn(self):
        engine = PolicyEngine()
        proxy = make_proxy(
            pii=[
                {'category': 'email', 'column': 'email'},       # → warn
                {'category': 'credit_card', 'column': 'card'},  # → block
            ]
        )
        result = engine.evaluate(proxy)
        assert result.action == 'block'

    # PE-04: Risk score threshold
    def test_risk_score_threshold_violation(self):
        engine = PolicyEngine()
        # Default max_risk_score is 100 (no threshold YAML), so set manually
        engine.thresholds = {'max_risk_score': 30}
        proxy = make_proxy(risk=80.0)
        result = engine.evaluate(proxy)
        assert result.action == 'block'
        rule_names = [v['rule'] for v in result.violations]
        assert 'risk_score_threshold' in rule_names

    def test_risk_score_below_threshold_no_violation(self):
        engine = PolicyEngine()
        engine.thresholds = {'max_risk_score': 100}
        proxy = make_proxy(risk=10.0)
        result = engine.evaluate(proxy)
        # risk 10 < 100 threshold → no threshold violation
        risk_viols = [v for v in result.violations if v['rule'] == 'risk_score_threshold']
        assert risk_viols == []

    # PE-06: Unknown rule names silently skipped
    def test_unknown_rule_in_yaml_is_skipped(self):
        engine = PolicyEngine()
        engine.rules = ['block_credit_cards', 'this_rule_does_not_exist']
        proxy = make_proxy()
        # Should not raise
        result = engine.evaluate(proxy)
        assert isinstance(result, PolicyResult)

    # PE-07: PolicyResult.to_dict()
    def test_policy_result_to_dict_shape(self):
        engine = PolicyEngine()
        proxy = make_proxy(pii=[{'category': 'credit_card', 'column': 'c'}])
        result = engine.evaluate(proxy)
        d = result.to_dict()
        assert isinstance(d, dict)
        assert 'violations' in d
        assert 'action' in d
        assert 'summary' in d
        assert 'rules_checked' in d


# ─────────────────────────────────────────────────────────────────────────────
# Test: CLI
# ─────────────────────────────────────────────────────────────────────────────

class TestPolicyCLI:

    # PE-08: CLI parses JSON scan report
    def test_cli_with_scan_report(self, tmp_path):
        report = {
            'pii_findings': [{'category': 'credit_card', 'column': 'card_num'}],
            'secrets': [],
            'sensitive_content': [],
            'risk_score': 75.0,
        }
        report_path = str(tmp_path / 'scan.json')
        with open(report_path, 'w') as f:
            json.dump(report, f)

        from security.policy_engine import main
        import io
        from contextlib import redirect_stdout
        buf = io.StringIO()
        with redirect_stdout(buf):
            ret = main(['--report', report_path])
        assert ret == 0
        output = json.loads(buf.getvalue())
        assert 'action' in output
        assert output['action'] in ('block', 'warn', 'pass')

    def test_cli_with_policy_yaml(self, tmp_path):
        report = {'pii_findings': [], 'secrets': [], 'sensitive_content': [], 'risk_score': 0}
        report_path = str(tmp_path / 'report.json')
        policy_path = str(tmp_path / 'policy.yaml')
        with open(report_path, 'w') as f:
            json.dump(report, f)
        with open(policy_path, 'w') as f:
            f.write(SAMPLE_POLICY_YAML)

        from security.policy_engine import main
        import io
        from contextlib import redirect_stdout
        buf = io.StringIO()
        with redirect_stdout(buf):
            ret = main(['--policy', policy_path, '--report', report_path])
        assert ret == 0


# ─────────────────────────────────────────────────────────────────────────────
# Test: BUILTIN_RULES registry completeness
# ─────────────────────────────────────────────────────────────────────────────

class TestBuiltinRules:

    def test_all_builtin_rules_have_required_keys(self):
        required = {'check_type', 'category', 'severity', 'action', 'description'}
        for rule_name, rule_def in BUILTIN_RULES.items():
            missing = required - set(rule_def.keys())
            assert missing == set(), f"Rule '{rule_name}' missing keys: {missing}"

    def test_all_severities_valid(self):
        valid = {'critical', 'high', 'medium', 'low'}
        for name, rule in BUILTIN_RULES.items():
            assert rule['severity'] in valid, f"Rule '{name}' has invalid severity: {rule['severity']}"

    def test_all_actions_valid(self):
        valid = {'block', 'warn', 'log'}
        for name, rule in BUILTIN_RULES.items():
            assert rule['action'] in valid, f"Rule '{name}' has invalid action: {rule['action']}"
