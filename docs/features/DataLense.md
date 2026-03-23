# 📊 Dataset Explorer

## What It Does

The Dataset Explorer gives you a full structural and statistical view of any dataset file directly inside VS Code — without running your code, without loading the entire file into memory, and without leaving your editor.

It combines two things into a single panel: the raw structural parse from `parse.py` and the deep behavioral profile from `baseline.py`. Together they tell you everything the generator and validation layer need to know about your data — and everything you'd want to know before training a model on it.

---

## Trigger — CodeLens Detection

Auto Mate scans every Python file you open and looks for dataset loading calls. When it finds one, it places a **"Parse Dataset (IDE Lense)"** button inline, directly above the line where the data is loaded.

The detection regex:

```
(read_csv|read_excel|read_json|read_parquet|spark\.read)
```

Lines that trigger the CodeLens:

```python
df = pd.read_csv("data/train.csv")
df = pd.read_excel("data/survey.xlsx")
df = pd.read_json("data/records.json")
df = pd.read_parquet("data/features.parquet")
df = spark.read.csv("data/big.csv")
```

The extension activates on `onLanguage:python` — it only loads when a Python file is open, keeping VS Code startup fast.

---

## The Panel — What You See

Clicking the CodeLens button runs `parse.py` and `baseline.py` in sequence and opens a Webview panel with two sections.

### Section 1 — Parse Output

The structural AST from `parse.py`. Everything here is extracted from the file itself — no statistical computation, just schema and shape.

**Schema** — one entry per column:

| Field | Description |
|---|---|
| `name` | Column name as it appears in the file |
| `dtype` | Inferred type: `int`, `float`, `bool`, `datetime`, `string`, `object`, `null` |
| `nullable` | Whether any null or empty values were found in the sample |
| `sample_values` | Up to 25 non-null values from the column |

**Profile** — dataset-level stats from the sample rows:

| Field | Description |
|---|---|
| `row_count_estimate` | Number of rows in the sample (not the full file) |
| `column_count` | Total number of columns |
| `missingness` | Null ratio per column (0.0 → 1.0) |
| `numeric_summary` | `min`, `max`, `mean`, `std` per numeric column |
| `cardinality_estimate` | Unique value count per column |

**Fingerprint** — a SHA-256 hash of the entire file computed at read time. This fingerprint is used downstream to key model caches and checkpoint files, so if the file changes between runs the cache is automatically invalidated.

---

### Section 2 — Baseline Output

The behavioral model from `baseline.py`. This is the full statistical contract — what the generator uses to produce valid synthetic rows and what the validation layer uses to reject implausible ones.

**Numeric columns** — per column:
- Full quantile profile: `q01`, `q05`, `q25`, `q50`, `q75`, `q95`, `q99`
- `min`, `max`, `mean`, `std`
- IQR and Tukey outer-fence outlier bounds `[Q1 − 3×IQR, Q3 + 3×IQR]`
- Null ratio and unique count

**Categorical columns** — per column:
- Unique value count
- Top-K values with raw counts and frequency ratios
- Null ratio

**Correlations** — cross-column relationships:
- **Pearson r** for every numeric pair, with strength label (`weak`, `medium`, `strong`, `very_strong`)
- **Cramér's V** (bias-corrected) for categorical–categorical associations — values in `[0, 1]`
- **Point-biserial** for categorical–numeric associations — signed for binary, eta for multi-class

**Constraints** — automatically derived:
- Numeric range `[min, max]` per column
- Allowed categorical values for columns with ≤ 50 unique values

**Rule set** — human-readable validation rules auto-generated from the constraints:
```
age must be between 0.0 and 95.0.
income must be between 15000.0 and 420000.0.
gender must be one of the observed allowed categorical values.
No column exceeds the maximum null ratio (0.0).
All numeric fields must contain numeric values only (coercible).
```

---

## Under the Hood

### `parse.py` — How Parsing Works

The parser tries pandas first for speed and falls back to stdlib (`csv`, `json`) if pandas fails. For Excel it uses `openpyxl` directly. For Parquet it requires `pyarrow`.

Only the first `sample_rows` rows (default: 50) are loaded for parsing. This means the parser runs instantly even on files with millions of rows. The fingerprint, however, is computed over the **entire file** by streaming it in chunks — so it is always accurate regardless of the sample size.

For JSON files, nested objects are **flattened to dot-keys**:
```json
{"user": {"age": 25, "name": "Alice"}}
→ {"user.age": 25, "user.name": "Alice"}
```

For SQL files or SQL text, a best-effort AST is extracted: statement type, table names, column names in the SELECT clause, WHERE clause, GROUP BY, ORDER BY, and LIMIT. This uses `sqlparse` if installed, with a regex fallback.

### `baseline.py` — How Baselining Works

The baseline loads the **full dataset** — not just the sample — using pandas. This is necessary for accurate quantile profiles and correlation computation. For very large files, you can limit this with `max_rows`:

```bash
python src/utils/baseline.py data/train.csv --max-rows 10000
```

Correlation computation scales with the number of columns:
- Pearson: computed for all numeric pairs via `df.corr(method='pearson')`
- Cramér's V: computed only for low-cardinality categoricals (≤ 50 unique values) to avoid noise from high-cardinality free-text columns
- Point-biserial: computed for all qualifying categorical–numeric pairs

---

## Configuration

### Python path

```json
// .vscode/settings.json
{
  "idelense.pythonPath": "python3"
}
```

If `python3` is not in your `PATH`, set this to the full path of your Python executable — e.g. `/usr/bin/python3` or `C:\\Python310\\python.exe`.

---

## Supported Formats

| Format | Extensions | Parser | Notes |
|---|---|---|---|
| CSV / TSV | `.csv` `.tsv` | pandas + stdlib fallback | Auto-detects delimiter |
| Excel | `.xlsx` `.xlsm` | openpyxl | First sheet by default |
| JSON | `.json` | json + pandas | Nested objects flattened |
| JSONL | `.jsonl` | Streaming line reader | Memory-efficient for large files |
| Parquet | `.parquet` | pandas + pyarrow | Requires `pyarrow` installed |
| SQL | `.sql` or text | sqlparse + regex fallback | Best-effort AST extraction |

---

## Generating Data from the Panel

At the bottom of the Parse + Baseline panel there is a row count input and a **Generate** button. Clicking it passes the baseline result to `generator.py` and opens the Checkpoint Monitor panel. See [`synthetic-data.md`](SynthDataGen.md) for the full generation pipeline and [`checkpoint-monitor.md`](CheckPoint.md) for the monitor panel.
