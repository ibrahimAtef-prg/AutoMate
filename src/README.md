# src/

This directory contains all source code for the Auto Mate extension — the TypeScript VS Code layer and the Python data processing backend.

---

## Structure

```
src/
├── extension.ts       VS Code extension entry point
└── utils/
    ├── parse.py       Dataset AST parser
    ├── baseline.py    Behavioral baseline builder
    ├── generator.py   Synthetic data generation engine
    ├── validation.py  Three-stage validation layer
    └── checkp.py      Atomic checkpoint store
```

---

## How the Two Layers Communicate

The TypeScript extension spawns Python scripts as child processes and reads their JSON output from stdout. There is no server, no socket, and no network — just clean process I/O.

```
extension.ts
    │
    ├── cp.spawn(python, [parse.py, filePath])       → DatasetAST JSON
    ├── cp.spawn(python, [baseline.py, filePath])    → BaselineArtifact JSON
    └── cp.spawn(python, [generator.py, ...args])    → generation result JSON
                                                            │
                                                     validation.py
                                                            │
                                                       checkp.py (on disk)
                                                            │
                                               extension polls every 2s
```

---

## `extension.ts`

The VS Code entry point. Registers all commands, the CodeLens provider, and the Webview panels.

**Key responsibilities:**
- `DataImportCodeLensProvider` — scans every Python file for `read_csv`, `read_excel`, `read_json`, `read_parquet`, `spark.read` and injects an inline CodeLens button
- `idelense.parseDataset` — main command; runs `parse.py` + `baseline.py`, opens the Parse + Baseline panel
- `idelense.generateSynthetic` — prompts user to use the CodeLens
- `idelense.openCheckpoint` — opens the live monitor panel
- `showCheckpointMonitor()` — polls `.idelense/cache/*.json` every 2 seconds and renders the generation monitor

**Configuration:**
```json
{
  "idelense.pythonPath": "python3"
}
```

---

## `utils/parse.py`

Converts any supported dataset file into a normalised `DatasetAST` — a structured representation of the schema, preview rows, profile statistics, and a SHA-256 fingerprint.

**Supported formats:** CSV, Excel (.xlsx), JSON / JSONL, Parquet, SQL

**Output shape:**
```json
{
  "dataset": {
    "kind": "csv",
    "source": "data/train.csv",
    "fingerprint": "abc123...",
    "schema": { "fields": [...] },
    "preview_rows": [...],
    "profile": { "row_count_estimate": 1000, ... }
  }
}
```

**CLI:**
```bash
python src/utils/parse.py data/train.csv --sample-rows 100
```

---

## `utils/baseline.py`

Reads a `DatasetAST` and builds a full `BaselineArtifact` — a behavioral statistical contract for the dataset used to guide generation and validate outputs.

**Produces:**
- Per-column quantile profiles (`q01` → `q99`), IQR, outlier bounds
- Pearson correlations for numeric pairs
- Cramér's V for categorical–categorical associations
- Point-biserial for categorical–numeric associations
- Numeric range constraints and categorical allowed-value constraints
- Auto-generated human-readable rule set
- Label/target column detection (heuristic: highest total point-biserial association)

**CLI:**
```bash
python src/utils/baseline.py data/train.csv --kind csv --max-rows 5000
```

---

## `utils/generator.py`

The synthetic data engine. Reads the `BaselineArtifact` and produces new rows that statistically match the original dataset.

**Engine selection (automatic):**

| Rows | Engine | Method |
|---|---|---|
| < 1,000 | `StatisticalEngine` | Quantile-CDF sampling + Cholesky copula |
| 1,000 – 50,000 | `ProbabilisticEngine` | Gaussian copula (empirical CDF + probit + MVN) |
| ≥ 50,000 | `CTGANEngine` | CTGAN (falls back to Probabilistic if not installed) |

All engines use **label-first generation** when a target column is detected, and cache trained models to disk keyed by dataset fingerprint.

**CLI:**
```bash
python src/utils/generator.py data/train.csv cache/baseline.json \
  --n 500 --cache-dir .idelense/cache --seed 42
```

---

## `utils/validation.py`

Three-stage validation gate — every batch of generated rows passes through all three before being accepted.

| Stage | Class | Method | On Failure |
|---|---|---|---|
| 1 | `ConstraintFilter` | Numeric ranges + categorical allowed values | Repair via resample-retry |
| 2 | `RowQualityFilter` | IQR outer fence, Mahalanobis, label plausibility | Drop row |
| 3 | `DuplicatePreFilter` | SHA-256 hash vs original dataset | Drop row |

Returns a `ValidationResult` with counts for evaluated, accepted, repaired, and dropped rows.

---

## `utils/checkp.py`

Atomic per-run row store. Accepts validated rows round-by-round via `commit()`, persists them to a structured JSON file using `os.replace()` for crash-safe atomic writes, and exposes a lightweight `status()` interface for the VS Code monitor panel to poll without loading the full row store.

**Checkpoint file:** `.idelense/cache/<fingerprint>_checkpoint.json`

---

## Running Locally

```bash
# Install Python dependencies
pip install -r requirements.txt

# Install Node dependencies and compile
npm install
npm run compile

# Launch the extension in VS Code
# Press F5 — opens Extension Development Host
```
