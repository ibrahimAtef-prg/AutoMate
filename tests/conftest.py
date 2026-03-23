"""
conftest.py — pytest fixtures shared across all AutoMate test modules.
"""
import sys
import os
import io
import pytest
import pandas as pd

# ── Make src importable without installing the package ────────────────────────
sys.path.insert(0, os.path.join(os.path.dirname(__file__), '..', 'src'))


# ── Reusable DataFrames ───────────────────────────────────────────────────────

@pytest.fixture
def pii_df():
    """A small DataFrame that contains multiple PII types."""
    return pd.DataFrame({
        'name':    ['Alice Smith', 'Bob Jones', 'Carol White', 'Dave Brown'],
        'email':   ['alice@example.com', 'bob@test.org', 'carol@corp.net', 'dave@mail.io'],
        'phone':   ['555-867-5309', '(212) 555-0100', '+1-800-555-1234', '617-555-9999'],
        'ssn':     ['123-45-6789', '987-65-4321', '000-00-0001', '999-99-9999'],
        'salary':  [50000, 75000, 90000, 120000],
    })


@pytest.fixture
def clean_df():
    """A DataFrame with no PII."""
    return pd.DataFrame({
        'product_id': ['P001', 'P002', 'P003'],
        'category':   ['Electronics', 'Books', 'Clothing'],
        'price':      [299.99, 12.50, 45.00],
        'in_stock':   [True, True, False],
    })


@pytest.fixture
def numeric_df():
    """Numeric-only DataFrame for attack simulation tests."""
    import numpy as np
    rng = np.random.default_rng(42)
    n = 300
    x1 = rng.normal(0, 1, n)
    x2 = rng.normal(5, 2, n)
    y  = 2 * x1 + 0.5 * x2 + rng.normal(0, 0.1, n)
    return pd.DataFrame({'feature_a': x1, 'feature_b': x2, 'target': y})


@pytest.fixture
def synthetic_df(numeric_df):
    """Slightly perturbed version of numeric_df to use as 'synthetic' data."""
    import numpy as np
    rng = np.random.default_rng(99)
    df = numeric_df.copy()
    df['feature_a'] = df['feature_a'] + rng.normal(0, 0.5, len(df))
    df['feature_b'] = df['feature_b'] + rng.normal(0, 0.5, len(df))
    df['target']    = df['target'] + rng.normal(0, 0.5, len(df))
    return df


@pytest.fixture
def tmp_csv(tmp_path, pii_df):
    """Write pii_df to a temp CSV and return the path."""
    p = tmp_path / 'sample_pii.csv'
    pii_df.to_csv(p, index=False)
    return str(p)


@pytest.fixture
def tmp_clean_csv(tmp_path, clean_df):
    """Write clean_df to a temp CSV and return the path."""
    p = tmp_path / 'sample_clean.csv'
    clean_df.to_csv(p, index=False)
    return str(p)
