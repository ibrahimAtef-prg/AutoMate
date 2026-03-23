"""
config.py — Centralized Configuration Constants for AutoMate Aurora

PURPOSE
-------
Single source of truth for every threshold, limit, magic number, and tunable
constant used across the pipeline. No magic literals may appear in production
code — all must be imported from here.

SECTIONS
--------
  INFERENCE        — Membership-inference attack parameters
  DRIFT            — Statistical drift thresholds and histogram bins
  RISK             — Risk scoring weights and classification boundaries
  RELIABILITY      — Metric reliability / confidence parameters
  QUALITY          — Output quality score weights
  GENERATOR        — Synthetic-data engine size thresholds
  CACHE            — Cache schema version, TTL, and integrity constants
  CONSTRAINT       — Constraint validation acceptance-rate floor
  CHECKPOINT       — Checkpoint store file-naming and WAL constants
  SCAN             — PII / data scanner sampling limits
"""

from __future__ import annotations

# ─── Membership-Inference Attack ─────────────────────────────────────────────

# Maximum number of train/test samples fed to the MI classifier.
MI_MAX_SAMPLE_SIZE: int = 200

# LogisticRegression regularisation strength (C) for the MI probe classifier.
MI_LR_C: float = 1.0

# Maximum iterations for the MI LogisticRegression solver.
MI_LR_MAX_ITER: int = 200

# Fixed random state for the MI classifier (reproducibility).
MI_RANDOM_STATE: int = 42

# Number of train/test splits for MI cross-validation.
MI_CV_FOLDS: int = 3

# ─── Statistical Drift ───────────────────────────────────────────────────────

# Number of histogram bins used in JS-divergence computation.
JS_DIV_BINS: int = 20

# Drift classification thresholds (avg_drift → label).
DRIFT_LOW_MAX:      float = 0.05    # avg_drift < this → "low"
DRIFT_MODERATE_MAX: float = 0.15    # avg_drift < this → "moderate" (else "high")

# Tanh scaling factor for categorical KL divergence symmetrisation.
CATEGORICAL_KL_SCALE: float = 0.5

# ─── Risk Scoring ────────────────────────────────────────────────────────────

# Risk classification boundaries (dataset_risk_score 0–100).
RISK_CRITICAL_MIN: float = 75.0
RISK_HIGH_MIN:     float = 50.0
RISK_MEDIUM_MIN:   float = 25.0
# Scores below RISK_MEDIUM_MIN → "low"

# Component weights for the composite risk score.
RISK_WEIGHT_AUC:        float = 0.35
RISK_WEIGHT_DRIFT:      float = 0.30
RISK_WEIGHT_DUPLICATES: float = 0.20
RISK_WEIGHT_PROXIMITY:  float = 0.15

# Scaling factor: duplicates_rate → risk contribution.
RISK_DUP_SCALE:   float = 20.0

# Scaling factor: drift → risk contribution.
RISK_DRIFT_SCALE: float = 4.0

# ─── Metric Reliability / Confidence ─────────────────────────────────────────

# Minimum statistical reliability score for metrics to be deemed "reliable".
RELIABILITY_THRESHOLD: float = 0.65

# Sample size at which AUC confidence saturates (asymptotic plateau).
AUC_CONFIDENCE_SATURATION: int = 400

# Drift variance multiplier used to compute drift confidence.
DRIFT_CONFIDENCE_VARIANCE_SCALE: float = 20.0

# ─── Quality Score ───────────────────────────────────────────────────────────

# Weights for the three components of the output quality composite score.
QUALITY_WEIGHT_AUC:   float = 0.40
QUALITY_WEIGHT_DRIFT: float = 0.40
QUALITY_WEIGHT_LABEL: float = 0.20

# Scaling factors for quality component normalisation.
QUALITY_DRIFT_SCALE: float = 4.0
QUALITY_LABEL_SCALE: float = 5.0

# ─── Synthetic-Data Generator Engine Thresholds ──────────────────────────────

# Row count boundaries for engine selection.
GENERATOR_SMALL_THRESHOLD: int = 1_000      # rows < this → StatisticalEngine
GENERATOR_LARGE_THRESHOLD: int = 50_000     # rows ≥ this → CTGANEngine

# Hard cap on batch size (DoS guard).
GENERATOR_BATCH_SIZE_MAX: int = 5_000_000

# Maximum constraint re-sample attempts before clamping.
GENERATOR_MAX_RESAMPLE: int = 3

# Hard cap on ValidationLayer retry rounds.
GENERATOR_MAX_QUALITY_ROUNDS: int = 8

# Minimum acceptance rate floor (constraint validation).
GENERATOR_MIN_ACCEPTANCE_RATE: float = 0.02

# ─── Cache Integrity ─────────────────────────────────────────────────────────

# Bump when the cached payload structure changes.
CACHE_SCHEMA_VERSION: str = "1.0"

# Bump when engine math changes (forces retrain).
GENERATOR_VERSION: str = "1.0"

# Cache time-to-live (seconds); invalidates caches older than 24 h.
CACHE_TTL_SEC: int = 86_400

# ─── PII / Data Scanner ──────────────────────────────────────────────────────

# Maximum rows scanned per file in the data scanner.
SCANNER_MAX_ROWS: int = 5_000

# ─── Duplicate Rate ───────────────────────────────────────────────────────────

# Scaling factor: duplicates_rate → confidence contribution.
DUPLICATES_CONFIDENCE_SCALE: float = 10.0

# ─── Proximity / NN Leakage ──────────────────────────────────────────────────

# Scaling factor: avg_drift → nn_leakage contribution.
NN_LEAKAGE_DRIFT_SCALE: float = 5.0

# ─── Statistical Reliability Baseline ────────────────────────────────────────

# Minimum reliability score for datasets with insufficient rows.
RELIABILITY_BASE_SCORE: float = 0.15
