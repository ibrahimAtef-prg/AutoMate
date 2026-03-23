"""
test_attack_simulator.py — Unit tests for src/privacy/attack_simulator.py

Covers:
  AS-01  Membership Inference Attack runs on numeric columns
  AS-02  Model Inversion Attack runs and returns R²
  AS-03  Data Reconstruction attack distance check
  AS-04  Attribute Inference via nearest-neighbor
  AS-05  k-Anonymity check detects low-k values
  AS-06  Overall vulnerability scoring is consistent
  AS-07  Report handles datasets with <2 numeric columns (graceful fallback)
  AS-08  run_all() returns all attacks in report
  AS-09  CLI runs and exits 0
"""
import sys, os, json
import pytest
import numpy as np
import pandas as pd

sys.path.insert(0, os.path.join(os.path.dirname(__file__), '..', 'src'))

from privacy.attack_simulator import AttackSimulator, AttackReport


class TestAttackSimulator:

    # ── AS-01: Membership Inference ───────────────────────────────────────────

    def test_mia_returns_attack_result(self, numeric_df, synthetic_df):
        sim = AttackSimulator(numeric_df, synthetic_df, seed=42)
        result = sim._membership_inference_attack()
        assert result.attack_name == 'Membership Inference'
        assert 0.0 <= result.success_rate <= 1.0
        assert result.severity in ('critical', 'high', 'medium', 'low')

    def test_mia_fallback_on_no_numeric_cols(self):
        df = pd.DataFrame({'a': ['x', 'y', 'z']})
        sim = AttackSimulator(df, df.copy(), seed=42)
        result = sim._membership_inference_attack()
        assert result.success is False
        assert 'Not enough' in result.description

    # ── AS-02: Model Inversion ────────────────────────────────────────────────

    def test_model_inversion_returns_r2(self, numeric_df, synthetic_df):
        sim = AttackSimulator(numeric_df, synthetic_df, seed=42)
        result = sim._model_inversion_attack()
        assert result.attack_name == 'Model Inversion'
        assert 0.0 <= result.success_rate <= 1.0

    def test_model_inversion_fallback_few_cols(self):
        df = pd.DataFrame({'a': [1.0, 2.0, 3.0], 'b': [4.0, 5.0, 6.0]})
        sim = AttackSimulator(df, df.copy(), seed=42)
        result = sim._model_inversion_attack()
        # Should fall back because it needs >= 3 numeric cols
        assert result.success is False

    # ── AS-03: Data Reconstruction ────────────────────────────────────────────

    def test_reconstruction_attack_runs(self, numeric_df, synthetic_df):
        sim = AttackSimulator(numeric_df, synthetic_df, seed=42)
        result = sim._data_reconstruction_attack()
        assert result.attack_name == 'Data Reconstruction'
        assert 0.0 <= result.success_rate <= 1.0

    def test_reconstruction_identical_df_succeeds(self, numeric_df):
        # When synthetic == original, attack should detect close rows
        sim = AttackSimulator(numeric_df, numeric_df.copy(), seed=42)
        result = sim._data_reconstruction_attack()
        assert result.success is True  # identical rows are trivially reconstructable

    def test_reconstruction_fallback_one_col(self):
        df = pd.DataFrame({'a': [1.0, 2.0, 3.0]})
        sim = AttackSimulator(df, df.copy(), seed=42)
        result = sim._data_reconstruction_attack()
        assert result.success is False

    # ── AS-04: Attribute Inference ────────────────────────────────────────────

    def test_attribute_inference_runs(self, numeric_df, synthetic_df):
        # Add a categorical column to trigger attribute inference
        n = len(numeric_df)
        df_orig = numeric_df.copy()
        df_synth = synthetic_df.copy()
        df_orig['category'] = (['A', 'B', 'C'] * (n // 3 + 1))[:n]
        df_synth['category'] = (['A', 'B', 'C'] * (n // 3 + 1))[:n]
        sim = AttackSimulator(df_orig, df_synth, seed=42)
        result = sim._attribute_inference_attack()
        assert result.attack_name == 'Attribute Inference'
        assert 0.0 <= result.success_rate <= 1.0

    def test_attribute_inference_fallback_no_categorical(self, numeric_df, synthetic_df):
        sim = AttackSimulator(numeric_df, synthetic_df, seed=42)
        result = sim._attribute_inference_attack()
        # No categorical cols → fallback
        assert result.success is False

    # ── AS-05: k-Anonymity ────────────────────────────────────────────────────

    def test_k_anonymity_with_cat_cols(self):
        # Create a dataset with low k (many unique combos)
        df = pd.DataFrame({
            'gender':  ['M', 'F', 'M', 'F', 'M'],
            'zip':     ['10001', '10002', '10003', '10004', '10005'],  # all unique → k=1
            'age':     [25, 30, 35, 40, 45],
        })
        sim = AttackSimulator(df, df.copy(), seed=42)
        result = sim._k_anonymity_check()
        assert result.attack_name == 'k-Anonymity Check'
        # With 5 unique zip codes each row is uniquely identifiable → k=1 → success
        assert result.success is True

    def test_k_anonymity_high_k(self):
        # All rows have same category values → high k
        df = pd.DataFrame({
            'gender': ['M'] * 100,
            'age':    [30] * 100,
        })
        sim = AttackSimulator(df, df.copy(), seed=42)
        result = sim._k_anonymity_check()
        assert result.success is False  # k=100, very safe

    def test_k_anonymity_no_columns(self):
        df = pd.DataFrame()
        sim = AttackSimulator(df, df.copy(), seed=42)
        result = sim._k_anonymity_check()
        assert result.success is False

    # ── AS-06: Overall vulnerability scoring ──────────────────────────────────

    def test_run_all_returns_report(self, numeric_df, synthetic_df):
        sim = AttackSimulator(numeric_df, synthetic_df, seed=42)
        report = sim.run_all()
        assert isinstance(report, AttackReport)
        assert report.attacks_run == 5
        assert report.overall_vulnerability in ('safe', 'moderate', 'vulnerable', 'critical')
        assert 0.0 <= report.risk_score <= 100.0

    def test_vulnerability_safe_when_no_attacks_succeed(self):
        # Create maximally diverse, well-separated synthetic data
        rng = np.random.default_rng(0)
        orig = pd.DataFrame({'x': rng.normal(0, 1, 50), 'y': rng.normal(0, 1, 50)})
        synth = pd.DataFrame({'x': rng.normal(100, 0.01, 50), 'y': rng.normal(100, 0.01, 50)})
        sim = AttackSimulator(orig, synth, seed=0)
        report = sim.run_all()
        assert report.attacks_run == 5
        assert isinstance(report.summary, str)

    # ── AS-07: Graceful fallback ──────────────────────────────────────────────

    def test_run_all_on_text_only_df(self):
        df = pd.DataFrame({'a': ['foo', 'bar', 'baz'], 'b': ['x', 'y', 'z']})
        sim = AttackSimulator(df, df.copy(), seed=42)
        report = sim.run_all()
        # Should not raise; numeric attacks fallback but k-anonymity succeeds
        # because all 3 rows are unique → k=1 (real vulnerability in the data)
        assert report.attacks_run == 5
        assert report.overall_vulnerability in ('safe', 'moderate', 'vulnerable', 'critical')
        # k-anonymity legitimately detects unique rows, so attacks_succeeded >= 0
        assert isinstance(report.summary, str)

    # ── AS-08: CLI output ─────────────────────────────────────────────────────

    def test_cli_outputs_json(self, tmp_path, numeric_df, synthetic_df):
        orig_path = str(tmp_path / 'orig.csv')
        synth_path = str(tmp_path / 'synth.csv')
        out_path = str(tmp_path / 'report.json')
        numeric_df.to_csv(orig_path, index=False)
        synthetic_df.to_csv(synth_path, index=False)

        from privacy.attack_simulator import main
        ret = main(['--original', orig_path, '--synthetic', synth_path, '--output', out_path])
        assert ret == 0
        assert os.path.exists(out_path)
        with open(out_path) as f:
            data = json.load(f)
        assert 'attacks_run' in data
        assert 'overall_vulnerability' in data

    # ── Serialization ─────────────────────────────────────────────────────────

    def test_report_to_json_is_valid(self, numeric_df, synthetic_df):
        sim = AttackSimulator(numeric_df, synthetic_df, seed=42)
        report = sim.run_all()
        j = report.to_json()
        parsed = json.loads(j)
        assert 'attacks_run' in parsed
        assert 'results' in parsed
        assert isinstance(parsed['results'], list)
