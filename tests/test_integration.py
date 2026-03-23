"""
test_data_scanner_integration.py — Integration tests between
data_scanner.py, anonymizer.py, and policy_engine.py

Covers:
  IT-02  PII scan → Anonymize → re-scan shows reduced PII
  IT-04  Policy engine evaluates a real scan report from DataScanner
  SEC-01 Scan text with prototype-polluting keys does not crash
  PERF-01 PII detector on 5000-row dataset completes in <10 seconds
"""
import sys, os, time
import pytest
import pandas as pd
import numpy as np

sys.path.insert(0, os.path.join(os.path.dirname(__file__), '..', 'src'))

from security.data_scanner import DataScanner
from security.anonymizer import anonymize_dataframe
from security.policy_engine import PolicyEngine, ScanReportProxy


class TestScanThenAnonymize:
    """IT-02: Anonymization reduces detected PII."""

    def test_anonymized_csv_has_fewer_pii_findings(self, tmp_path, pii_df):
        scanner = DataScanner()

        # Step 1: Scan original
        report_before = scanner.scan_dataframe(pii_df)
        pii_count_before = len(report_before.pii_findings)
        assert pii_count_before > 0, "Expected PII findings in pii_df"

        # Step 2: Anonymize
        result = anonymize_dataframe(pii_df)
        df_anon = result['anonymized_df']

        # Step 3: Re-scan anonymized data
        report_after = scanner.scan_dataframe(df_anon)
        pii_count_after = len(report_after.pii_findings)

        # Should find fewer PII items in the anonymized version
        assert pii_count_after < pii_count_before, (
            f"Expected fewer PII findings after anonymization "
            f"(before={pii_count_before}, after={pii_count_after})"
        )

    def test_anonymized_risk_score_lower_or_equal(self, pii_df):
        scanner = DataScanner()
        report_before = scanner.scan_dataframe(pii_df)
        result = anonymize_dataframe(pii_df)
        report_after = scanner.scan_dataframe(result['anonymized_df'])
        assert report_after.risk_score <= report_before.risk_score


class TestScanToPolicyEvaluation:
    """IT-04: Policy engine evaluates a real scan report."""

    def test_policy_blocks_on_credit_card_scan(self):
        df = pd.DataFrame({
            'card':  ['4111-1111-1111-1111', '5500 0000 0000 0004'],
            'name':  ['Alice', 'Bob'],
        })
        scanner = DataScanner()
        scan = scanner.scan_dataframe(df)

        proxy = ScanReportProxy(
            pii_findings=scan.pii_findings,
            secrets=scan.secrets,
            sensitive_content=scan.sensitive_content,
            risk_score=scan.risk_score,
        )

        engine = PolicyEngine()
        result = engine.evaluate(proxy)
        # Credit card findings should trigger a block
        assert result.action == 'block', f"Expected block, got {result.action}"

    def test_policy_passes_on_clean_scan(self, clean_df):
        scanner = DataScanner()
        scan = scanner.scan_dataframe(clean_df)

        proxy = ScanReportProxy(
            pii_findings=scan.pii_findings,
            secrets=scan.secrets,
            sensitive_content=scan.sensitive_content,
            risk_score=scan.risk_score,
        )

        engine = PolicyEngine()
        result = engine.evaluate(proxy)
        # Clean data should not trigger any violations
        assert result.action in ('pass', 'warn'), (
            f"Expected pass/warn on clean data, got {result.action}"
        )


class TestSecurityEdgeCases:
    """Edge cases and security-related scanner tests."""

    def test_very_large_string_doesnt_crash_scanner(self):
        scanner = DataScanner()
        large = 'a' * 100_000
        findings = scanner.scan_text(large)
        assert isinstance(findings, list)

    def test_scanner_handles_unicode_values(self):
        df = pd.DataFrame({'notes': ['こんにちは', 'مرحبا', 'Привет', 'alice@example.com']})
        scanner = DataScanner()
        report = scanner.scan_dataframe(df)
        # Should not raise
        assert report.columns_scanned == 1

    def test_scanner_handles_special_chars(self):
        scanner = DataScanner()
        findings = scanner.scan_text('<script>alert("xss")</script>')
        assert isinstance(findings, list)

    def test_scanner_handles_json_like_string(self):
        scanner = DataScanner()
        text = '{"__proto__": {"polluted": true}}'
        findings = scanner.scan_text(text)
        assert isinstance(findings, list)


class TestPerformance:
    """PERF-01: PII detector on 5000-row dataset completes in < 10 seconds."""

    def test_scan_5000_row_dataframe_within_time(self):
        n = 5000
        df = pd.DataFrame({
            'email':  ['user{}@example.com'.format(i) for i in range(n)],
            'salary': np.random.randint(30000, 150000, n),
            'notes':  ['Some text note {}'.format(i) for i in range(n)],
        })
        scanner = DataScanner()
        start = time.time()
        report = scanner.scan_dataframe(df)
        elapsed = time.time() - start
        assert elapsed < 10.0, f"Scan took {elapsed:.2f}s, expected < 10s"
        assert report.columns_scanned == 3
