# ⚗️ Synthetic Data Generation

## The Problem

Most ML issues start with the dataset, not the model. Two failure modes show up constantly:

- **Underfitting** — not enough training data, the model can't learn enough signal from the available samples
- **Overfitting** — the model memorises training rows instead of learning patterns that generalise

Collecting more real data is expensive, slow, and sometimes impossible due to privacy constraints. Synthetic data solves this by generating new rows that are statistically consistent with the original — same distributions, same feature correlations, same class balance — but not copies of any real row.

Auto Mate generates this data entirely inside VS Code, locally, with no data leaving your machine.

---

## How It Works

The generation pipeline has five stages that run sequentially every time you click Generate.

### Stage 1 — Parse (`parse.py`)

The file is read and converted into a `DatasetAST` — a structured representation of the dataset that every downstream stage depends on.

What gets extracted:
- Column names and inferred data types (`int`, `float`, `bool`, `datetime`, `string`, `object`)
- Null ratios and sample values per column
- Row count estimate and column count
- A **SHA-256 fingerprint** of the file — used to key model caches and checkpoint files so repeated runs on the same dataset skip retraining

Supported formats: CSV, Excel (.xlsx), JSON / JSONL, Parquet.

### Stage 2 — Baseline (`baseline.py`)

The dataset is loaded and a full behavioral contract is built — the `BaselineArtifact`. This is the statistical model that tells the generator what "valid" data looks like for this specific dataset.

Per **numeric** column:
- Full quantile profile: `q01`, `q05`, `q25`, `q50`, `q75`, `q95`, `q99`
- IQR and Tukey outer-fence outlier bounds
- Mean, standard deviation, unique count, null ratio

Per **categorical** column:
- Unique value count
- Top-K values with frequency ratios
- Null ratio

Cross-column relationships:
- **Pearson correlation** for numeric pairs — stored with a strength label (`weak`, `medium`, `strong`, `very_strong`)
- **Cramér's V** (bias-corrected) for categorical–categorical associations
- **Point-biserial** for categorical–numeric associations (binary and multi-class eta)

Constraints derived automatically:
- Numeric column ranges `[min, max]`
- Allowed categorical values for low-cardinality columns (≤ 50 unique values)

Label column detection:
- The baseline heuristically identifies the target/label column as the categorical column with the highest total absolute point-biserial association across all numeric features
- This drives **label-first generation** in all three engines

### Stage 3 — Generate (`generator.py`)

The engine is selected automatically based on the dataset's row count recorded in the baseline:

| Dataset Rows | Engine | Strategy |
|---|---|---|
| < 1,000 | `StatisticalEngine` | Quantile-CDF sampling + Cholesky copula |
| 1,000 – 50,000 | `ProbabilisticEngine` | Gaussian copula (empirical CDF + probit + MVN) |
| ≥ 50,000 | `CTGANEngine` | CTGAN, falls back to Probabilistic if not installed |

---

## Engine Details

### StatisticalEngine

No training step. Works entirely from the `BaselineArtifact` — no need to load the original dataset.

**Numeric sampling** uses a piecewise-linear inverse CDF built from the baseline's quantile statistics:

```
Uniform U ~ [0, 1]
     │
     ▼
np.interp(U, [0.0, 0.01, 0.05, 0.25, 0.50, 0.75, 0.95, 0.99, 1.0],
              [min, q01, q05, q25, q50, q75, q95, q99, max])
     │
     ▼
Value in [min, max] preserving full distribution shape
```

This approach:
- Preserves skew, tails, and IQR — not just mean and std
- Is naturally bounded to `[min, max]` — no rejection loop, no clipping
- Degrades gracefully with fewer quantile points available

**Correlation injection** uses a Gaussian copula Cholesky decomposition for strongly correlated numeric pairs (`|Pearson r| ≥ 0.4`):

```
Per-column values
     │
     ▼
Rank-based transform → Z ~ N(0,1)  (no scipy needed)
     │
     ▼
Multiply by Cholesky factor L of target correlation matrix
     │
     ▼
Apply Φ (standard normal CDF) → U_corr ∈ (0, 1)
     │
     ▼
Apply per-column inverse quantile CDF → original data space
```

**Label-first path** (when target column detected):
1. Sample label values from the baseline marginal distribution
2. For each label class, sample numeric features from per-class quantile CDFs
3. Apply Cholesky correlation injection within each class slice separately
4. Sample categorical features from per-class frequency tables

### ProbabilisticEngine

Fits a **Gaussian copula** on the original dataframe. Trained once and cached.

**Fitting:**
1. Map each numeric column to `U[0,1]` via empirical CDF (rank-based)
2. Apply probit transform `Φ⁻¹` → `Z ~ N(0,1)` in copula space
3. Fit a multivariate normal: `μ = Z.mean(axis=0)`, `Σ = cov(Z)`
4. Store per-column empirical CDFs for inverse transform at sample time

**Per-class copulas** are fitted separately for each label value when a target column is detected — this preserves within-class feature structure independently from between-class structure.

**Sampling:**
1. Sample `Z ~ MVN(μ, Σ)` from the fitted (or per-class) copula
2. Apply `Φ` (standard normal CDF) → `U_corr ∈ (0,1)`
3. Apply per-column inverse empirical CDF → original data space
4. Resample any out-of-range values via quantile CDF retry (no clipping)

**Model cache:** `<fingerprint>_probabilistic.pkl` — reloaded on subsequent runs, skipping retraining entirely.

### CTGANEngine

Wraps `CTGANSynthesizer(epochs=300)` from the `ctgan` library. Best suited for large, complex datasets with intricate feature interactions that statistical methods don't fully capture.

- Trained on the full dataframe with all categorical columns declared as discrete
- Model cached to `<fingerprint>_ctgan.pkl`
- If `ctgan` is not installed, falls back to `ProbabilisticEngine` automatically with a warning in the output
- Install with: `pip install ctgan`

---

## Stage 4 — Validation (`validation.py`)

Every batch of generated rows passes three filters before being accepted. See [`data-leakage.md`](data-leakage.md) for full details on the validation logic.

| Stage | What it does | On failure |
|---|---|---|
| `ConstraintFilter` | Numeric ranges + categorical allowed values | Repair via resample-retry |
| `RowQualityFilter` | IQR fence, Mahalanobis, label plausibility | Drop row |
| `DuplicatePreFilter` | SHA-256 hash vs every original row | Drop row |

Dropped rows trigger a retry — the engine samples a fresh batch. The loop runs up to **8 rounds** with mild oversampling on each subsequent round.

### Stage 5 — Checkpoint (`checkp.py`)

Accepted rows are committed atomically to a JSON file after each round. Writes use `os.replace()` — a crash mid-write leaves the previous checkpoint intact.

The VS Code monitor panel polls this file every 2 seconds. See [`checkpoint-monitor.md`](checkpoint-monitor.md) for the full monitor documentation.

---

## Privacy Guarantees

- All processing is local Python — no data is sent anywhere
- No API keys required
- `DuplicatePreFilter` SHA-256 hashes every generated row and rejects exact matches with the original dataset — generated output cannot contain memorised training rows
- Model cache files (`.pkl`) contain only statistical parameters, not raw training data

---

## Supported Formats

| Format | Extensions |
|---|---|
| CSV / TSV | `.csv` `.tsv` |
| Excel | `.xlsx` `.xlsm` |
| JSON / JSONL | `.json` `.jsonl` |
| Parquet | `.parquet` |
