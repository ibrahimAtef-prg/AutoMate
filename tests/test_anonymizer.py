"""
test_anonymizer.py — Unit tests for src/security/anonymizer.py

Covers:
  AN-01  Names → consistent pseudonymization (same name → same PERSON_NNN)
  AN-02  Emails → deterministic hash replacement
  AN-03  Phones → masked to ***-***-XXXX (last 4 digits preserved)
  AN-04  SSN → fully redacted to ***-**-****
  AN-05  Free text PII removal
  AN-06  Auto-detection of sensitive columns by name
  AN-07  NaN / null values pass through unchanged
  AN-08  CLI writes correct output file
"""
import sys, os, json
import pytest
import numpy as np
import pandas as pd

sys.path.insert(0, os.path.join(os.path.dirname(__file__), '..', 'src'))

from security.anonymizer import Anonymizer, anonymize_dataframe


class TestAnonymizer:

    def setup_method(self):
        self.anon = Anonymizer()

    # AN-01: Name pseudonymization consistency
    def test_name_pseudonymization_consistent(self):
        df = pd.DataFrame({'name': ['Alice', 'Bob', 'Alice', 'Carol', 'Bob']})
        df_anon, result = self.anon.anonymize_dataframe(df, columns=['name'])
        names = df_anon['name'].tolist()
        # Same input → same PERSON_NNN
        assert names[0] == names[2], "Same name should map to same PERSON_NNN"
        assert names[1] == names[4], "Same name should map to same PERSON_NNN"
        # Different names → different tokens
        assert names[0] != names[1]
        # All start with PERSON_
        assert all(n.startswith('PERSON_') for n in names)

    def test_name_counter_increments(self):
        df = pd.DataFrame({'name': ['X', 'Y', 'Z']})
        df_anon, _ = self.anon.anonymize_dataframe(df, columns=['name'])
        assert '001' in df_anon['name'].iloc[0]
        assert '002' in df_anon['name'].iloc[1]
        assert '003' in df_anon['name'].iloc[2]

    # AN-02: Email hash replacement
    def test_email_hash_replacement(self):
        df = pd.DataFrame({'email': ['alice@test.com', 'bob@test.com', 'alice@test.com']})
        anon = Anonymizer()
        df_anon, _ = anon.anonymize_dataframe(df, columns=['email'])
        emails = df_anon['email'].tolist()
        # Deterministic: same input → same output
        assert emails[0] == emails[2]
        # Different inputs → different outputs
        assert emails[0] != emails[1]
        # Correct format
        assert '@anon.local' in emails[0]
        assert emails[0].startswith('EMAIL_')

    # AN-03: Phone masking
    def test_phone_masking_preserves_last_4(self):
        df = pd.DataFrame({'phone': ['555-867-5309', '(212) 555-0100']})
        anon = Anonymizer()
        df_anon, _ = anon.anonymize_dataframe(df, columns=['phone'])
        assert '5309' in df_anon['phone'].iloc[0]
        assert '0100' in df_anon['phone'].iloc[1]
        assert df_anon['phone'].iloc[0].startswith('***-***-')

    def test_short_phone_gets_redacted(self):
        df = pd.DataFrame({'phone': ['123']})
        anon = Anonymizer()
        df_anon, _ = anon.anonymize_dataframe(df, columns=['phone'])
        assert df_anon['phone'].iloc[0] == '***-REDACTED'

    # AN-04: SSN full redaction
    def test_ssn_fully_redacted(self):
        df = pd.DataFrame({'ssn': ['123-45-6789', '987-65-4321']})
        anon = Anonymizer()
        df_anon, _ = anon.anonymize_dataframe(df, columns=['ssn'])
        assert all(v == '***-**-****' for v in df_anon['ssn'])

    # AN-05: Free text PII removal
    def test_freetext_removes_email(self):
        text = 'Contact alice@example.com for support'
        result = self.anon.anonymize_text(text)
        assert 'alice@example.com' not in result
        assert '[EMAIL_REDACTED]' in result

    def test_freetext_removes_phone(self):
        text = 'Call me at 555-867-5309 tomorrow'
        result = self.anon.anonymize_text(text)
        assert '555-867-5309' not in result
        assert '[PHONE_REDACTED]' in result

    def test_freetext_removes_ssn(self):
        text = 'My SSN is 123-45-6789'
        result = self.anon.anonymize_text(text)
        assert '123-45-6789' not in result
        assert '[SSN_REDACTED]' in result

    def test_freetext_removes_credit_card(self):
        text = 'Card: 4111-1111-1111-1111'
        result = self.anon.anonymize_text(text)
        assert '4111-1111-1111-1111' not in result
        assert '[CC_REDACTED]' in result

    # AN-06: Auto-detection of sensitive columns
    def test_auto_detect_sensitive_cols(self, pii_df):
        anon = Anonymizer()
        detected = anon._detect_sensitive_columns(pii_df)
        # 'name', 'email', 'phone', 'ssn' should all be detected
        for col in ['name', 'email', 'phone', 'ssn']:
            assert col in detected, f"Column '{col}' should be auto-detected"

    def test_auto_detect_skips_non_pii_cols(self, clean_df):
        anon = Anonymizer()
        detected = anon._detect_sensitive_columns(clean_df)
        # 'product_id', 'category', 'price', 'in_stock' — none should be detected
        assert detected == []

    # AN-07: NaN values pass through unchanged
    def test_nan_in_name_column(self):
        df = pd.DataFrame({'name': ['Alice', None, 'Bob']})
        anon = Anonymizer()
        df_anon, _ = anon.anonymize_dataframe(df, columns=['name'])
        # The NaN row should remain NaN (not crash)
        assert pd.isna(df_anon['name'].iloc[1])

    def test_nan_in_email_column(self):
        df = pd.DataFrame({'email': ['alice@test.com', None]})
        anon = Anonymizer()
        df_anon, _ = anon.anonymize_dataframe(df, columns=['email'])
        assert pd.isna(df_anon['email'].iloc[1])

    def test_nan_in_ssn_column(self):
        df = pd.DataFrame({'ssn': ['123-45-6789', None]})
        anon = Anonymizer()
        df_anon, _ = anon.anonymize_dataframe(df, columns=['ssn'])
        assert pd.isna(df_anon['ssn'].iloc[1])

    # AN-08: CLI writes correct output file
    def test_cli_csv_output(self, tmp_path, pii_df):
        input_path = str(tmp_path / 'input.csv')
        output_path = str(tmp_path / 'output.csv')
        pii_df.to_csv(input_path, index=False)

        from security.anonymizer import main
        ret = main([input_path, '--output', output_path])
        assert ret == 0
        assert os.path.exists(output_path)
        df_out = pd.read_csv(output_path)
        # Original emails should not appear in anonymized output
        assert not any(email in str(df_out.to_dict()) for email in pii_df['email'].tolist())

    def test_cli_missing_input_returns_error(self, tmp_path):
        from security.anonymizer import main
        output_path = str(tmp_path / 'output.csv')
        ret = main(['/nonexistent/file.csv', '--output', output_path])
        assert ret == 1

    # Result object
    def test_anonymization_result_shape(self, pii_df):
        anon = Anonymizer()
        _, result = anon.anonymize_dataframe(pii_df)
        assert result.rows_processed == len(pii_df)
        assert result.cells_anonymized > 0
        assert len(result.transformations_applied) > 0

    def test_strategy_detection(self):
        anon = Anonymizer()
        assert anon._detect_strategy('ssn', None) == 'ssn'
        assert anon._detect_strategy('email', None) == 'email'
        assert anon._detect_strategy('phone', None) == 'phone'
        assert anon._detect_strategy('name', None) == 'name'
        assert anon._detect_strategy('home_address', None) == 'address'
        assert anon._detect_strategy('notes', None) == 'freetext'
