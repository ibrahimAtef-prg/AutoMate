# 🔍 Data Leakage Detection & Validation

## The Problem

Data leakage is when information from outside the legitimate training boundary contaminates the model — making it appear to perform well during evaluation but fail silently in production. It's one of the most common and hardest-to-spot causes of inflated metrics in ML projects.

Auto Mate targets leakage at the **data generation stage** — before a single contaminated row can enter training. Every batch of generated rows is screened through three independent filters before being accepted.

---

## Types of Leakage Auto Mate Addresses

| Type | Description | What happens to the model |
|---|---|---|
| **Exact duplication** | Generated rows are identical to original training rows | Memorisation, overfitting, inflated eval metrics |
| **Out-of-range values** | Generated numeric values fall outside the observed distribution | Distribution shift, model brittleness in production |
| **Invalid categories** | Generated categorical values don't exist in the original dataset | Encoding errors, unseen-label crashes at inference |
| **Incoherent feature combinations** | Feature values are individually valid but jointly impossible | Model learns impossible patterns, degrades on real data |
| **Label-feature mismatch** | Feature values are inconsistent with the assigned class | Corrupted gradients, biased decision boundaries |
| **Null contamination** | Unexpected null values appear in generated output | Training crashes, silent NaN propagation |

---

## The Validation Layer

`validation.py` implements a `ValidationLayer` that wraps three filters into a single `.run(df, n_requested)` call. The filters run in order — each one operates on the output of the previous.

```
Generated batch (raw)
        │
        ▼
┌──────────────────────────────────┐
│  Stage 1 — ConstraintFilter      │  ← repair
└──────────────────┬───────────────┘
                   │
                   ▼
┌──────────────────────────────────┐
│  Stage 2 — RowQualityFilter      │  ← drop
└──────────────────┬───────────────┘
                   │
                   ▼
┌──────────────────────────────────┐
│  Stage 3 — DuplicatePreFilter    │  ← drop
└──────────────────┬───────────────┘
                   │
                   ▼
         Accepted rows → CheckPoint
```

---

## Stage 1 — ConstraintFilter

Enforces hard constraints derived from the baseline. Violations are **repaired**, not discarded — the row is kept but the invalid value is replaced.

### Numeric range enforcement

For every numeric column, the baseline stores `[min, max]` observed in the original dataset. Any generated value outside this range is replaced by resampling from the column's quantile CDF:

```
out-of-range value detected
        │
        ▼
resample from quantile CDF (up to 10 attempts)
        │
        ├── in range → accept
        └── still out of range after 10 attempts → clamp to boundary (last resort)
```

This is deliberately **not clipping**. Clipping would create artificial spikes at the boundary values — many rows landing exactly on `min` or `max`. Resampling from the full distribution means boundary values appear only at their natural frequency.

### Categorical allowed-value enforcement

For low-cardinality categorical columns (≤ 50 unique values), the baseline stores the full set of allowed values. Any generated value not in this set is replaced by sampling from the valid frequency distribution — weighted by the original value ratios.

### Schema completeness

If any column from the baseline is missing from the generated batch, it is added with `None` values. Column order is restored to match the baseline's `col_order`.

---

## Stage 2 — RowQualityFilter

Three independent statistical plausibility checks per row. A row is **dropped** when it fails more than `max_failures` checks (default: 1 — any single failure rejects the row).

### Check A — IQR Outer Fence

For every numeric column, values are checked against the Tukey outer fence:

```
lower bound = Q1 − 3.0 × IQR
upper bound = Q3 + 3.0 × IQR
```

Falls back to `mean ± 3σ` when IQR statistics are absent from the baseline.

A value outside the fence increments the row's failure counter by 1.

### Check B — Mahalanobis Coherence

For every strongly correlated numeric pair (`|Pearson r| ≥ 0.4`), the two values are z-scored and their joint Mahalanobis distance is computed:

```
d² = [za, zb] · Σ⁻¹ · [za, zb]ᵀ
```

If `d² > 9.21` (chi-squared 99th percentile at 2 degrees of freedom) the combination is flagged as a joint outlier and increments the failure counter.

**Why this matters:** Check A catches individually extreme values. Check B catches combinations that are individually plausible but jointly impossible. For example — if `age` and `income` are correlated at r=0.70, a row with `age=19` and `income=180,000` passes Check A on both columns but fails Check B because that combination is far outside the joint distribution.

### Check C — Conditional Label Plausibility

When a label column is detected, each numeric feature is checked against the per-class distribution it was assigned to:

```
z = |value − class_mean| / class_std

if z > 4.0 → increment failure counter
```

This catches rows where the feature values are plausible globally but inconsistent with the class they were labelled as. A row labelled `class=A` with feature values that sit 5σ outside class A's distribution would have been generated incorrectly — Check C rejects it.

---

## Stage 3 — DuplicatePreFilter

Prevents memorisation — ensures no generated row is an exact match of any original training row.

**Mechanism:**
1. At construction time, every row in the original dataset is serialised to a canonical JSON string (keys sorted, `NaN` → `None`) and hashed with SHA-256
2. These hashes are stored in a Python `set` — O(1) lookup
3. For every generated row, the same hash is computed and checked against the set
4. Exact match → row is dropped

```python
canonical = json.dumps(row, sort_keys=True, default=str)
row_hash  = hashlib.sha256(canonical.encode()).hexdigest()
```

**Warning threshold:** If more than 20% of the generated batch are exact duplicates of the original dataset, a warning is added to the output. This usually means the dataset has very low diversity — the generator is struggling to produce novel combinations.

---

## Retry Loop

Rows dropped by RowQualityFilter or DuplicatePreFilter are not patched — they are discarded and the engine regenerates them from scratch. The generator runs up to **8 rounds**:

```
Round 0: sample batch_size rows → validate → commit accepted rows
Round 1: sample more rows (mild oversampling) → validate → commit
...
Round 7: final attempt

if n_collected < n_requested after 8 rounds:
    seal checkpoint as "complete" with partial output + warning
```

Each round's results are committed atomically to the checkpoint file so partial progress is never lost.

---

## Transparency

Every `ValidationResult` exposes full counts:

| Field | What it counts |
|---|---|
| `n_evaluated` | Total rows submitted to the layer |
| `n_accepted` | Rows that passed all three filters |
| `n_rejected_constraints` | Cells repaired by ConstraintFilter |
| `n_rejected_quality` | Rows dropped by RowQualityFilter |
| `n_rejected_duplicates` | Rows dropped by DuplicatePreFilter |
| `warnings` | Human-readable messages for each event |

These are surfaced in the VS Code Checkpoint Monitor panel with a per-round breakdown. See [`checkpoint-monitor.md`](CheckPoint.md).

---

## Thresholds Reference

| Constant | Value | Used in |
|---|---|---|
| `_IQR_MULTIPLIER` | `3.0` | Check A outer fence |
| `_MAHAL_THRESHOLD` | `9.21` | Check B joint outlier |
| `_SIGMA_THRESHOLD` | `4.0` | Check C label plausibility |
| `_DEDUP_WARN_RATIO` | `0.20` | DuplicatePreFilter warning |
| `max_failures` | `1` | RowQualityFilter drop threshold |
| `_MAX_QUALITY_ROUNDS` | `8` | Generator retry loop cap |

---

## Current Scope

The validation layer operates on **generated data** — it does not scan the original dataset for pre-existing leakage. The following are planned for future milestones:

- Cross-file train/test split overlap detection
- Temporal leakage analysis (date-based splits)
- Label contamination detection in model training scripts
- User-configurable thresholds per column
